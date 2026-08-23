from copy import deepcopy
from pathlib import Path

from .atomic import read_json, write_once_json
from .hashing import digest_object
from .life_events import (
    DOMAIN_NAMES,
    EVENT_DISPOSITIONS,
    PROCESSING_DISPOSITIONS,
    EventContractError,
    build_life_ledger,
)


class DomainRoutingError(RuntimeError):
    pass


FORBIDDEN_KEYS = {
    "sender_id", "self_id", "source_path", "database_path", "key", "decrypt_key",
    "identity_map", "real_sender_id", "raw_database",
}


def _forbidden(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            key in FORBIDDEN_KEYS or key.endswith("_private_path") or _forbidden(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(_forbidden(item) for item in value)
    return False


def freeze_domain_packet(root: Path, name: str, domain: str, records: list[dict]) -> dict:
    if domain not in DOMAIN_NAMES:
        raise DomainRoutingError("domain is invalid")
    if not isinstance(name, str) or not name or name in {".", ".."} or any(character in name for character in ("/", "\\", "\x00")):
        raise DomainRoutingError("domain packet name is invalid")
    if not isinstance(records, list) or not records:
        raise DomainRoutingError("domain packet records cannot be empty")
    if _forbidden(records):
        raise DomainRoutingError("private field cannot enter a domain packet")
    packet_records = []
    route_evidence_allowlists = {}
    route_place_allowlists = {}
    episode_ids = set()
    for record in records:
        if not isinstance(record, dict):
            raise DomainRoutingError("domain packet record must be an object")
        episode_id = record.get("episode_id")
        observed = record.get("observed_message_time")
        if not isinstance(episode_id, str) or not episode_id or episode_id in episode_ids:
            raise DomainRoutingError("episode ids must be non-empty and unique")
        if not isinstance(observed, dict):
            raise DomainRoutingError("observed_message_time is required before domain routing")
        evidence_allowlist = record.get("evidence_ids", [episode_id])
        if (
            not isinstance(evidence_allowlist, list) or not evidence_allowlist
            or any(not isinstance(item, str) or not item for item in evidence_allowlist)
            or len(evidence_allowlist) != len(set(evidence_allowlist))
        ):
            raise DomainRoutingError("each route requires a non-empty unique evidence allowlist")
        place_allowlist = record.get("place_ids", [])
        if (
            not isinstance(place_allowlist, list)
            or any(not isinstance(item, str) or not item for item in place_allowlist)
            or len(place_allowlist) != len(set(place_allowlist))
        ):
            raise DomainRoutingError("each route requires a unique place allowlist, which may be empty")
        episode_ids.add(episode_id)
        route_id = f"{domain}:{episode_id}"
        packet_record = {**deepcopy(record), "route_id": route_id}
        packet_record["evidence_allowlist"] = deepcopy(evidence_allowlist)
        packet_record["place_allowlist"] = deepcopy(place_allowlist)
        packet_records.append(packet_record)
        route_evidence_allowlists[route_id] = deepcopy(evidence_allowlist)
        route_place_allowlists[route_id] = deepcopy(place_allowlist)
    body = {
        "schema_version": "pcd-domain-packet/v3",
        "domain": domain,
        "instruction": "Return exactly one processing result per route while preserving zero to many independent events.",
        "route_ids": [record["route_id"] for record in packet_records],
        "route_evidence_allowlists": route_evidence_allowlists,
        "route_place_allowlists": route_place_allowlists,
        "records": packet_records,
        "output_contract": {
            "schema_version": "pcd-domain-output-contract/v3",
            "one_processing_disposition_per_route": True,
            "processing_dispositions": sorted(PROCESSING_DISPOSITIONS),
            "event_dispositions": sorted(EVENT_DISPOSITIONS),
            "events_per_route": "zero_to_many",
            "independent_events_must_not_be_merged_or_deleted": True,
            "events_emitted_requires_one_or_more_events": True,
            "non_emitting_processing_dispositions_require_empty_events": True,
            "event_disposition_is_authoritative": True,
            "event_evidence_must_be_in_route_allowlist": True,
            "event_places_must_be_in_route_allowlist": True,
            "empty_place_allowlist_requires_empty_event_places": True,
            "separate_observed_and_asserted_time": True,
            "message_time_fallback_forbidden": True,
            "no_signal_is_explicit": True,
        },
    }
    body["seal"] = digest_object(body)
    path = Path(root) / "domain-packets" / f"{name}.json"
    if path.exists():
        existing = read_json(path)
        if existing != body:
            raise DomainRoutingError("frozen domain packet differs")
        return existing
    write_once_json(path, body)
    return body


def validate_domain_result(packet: dict, episodes: list[dict]) -> dict:
    if not isinstance(packet, dict) or packet.get("schema_version") != "pcd-domain-packet/v3":
        raise DomainRoutingError("domain packet schema is invalid")
    claimed = packet.get("seal")
    unsigned = {key: value for key, value in packet.items() if key != "seal"}
    if not isinstance(claimed, str) or digest_object(unsigned) != claimed:
        raise DomainRoutingError("domain packet seal mismatch")
    domain = packet["domain"]
    route_ids = packet.get("route_ids")
    source_by_route = {record.get("route_id"): record for record in packet.get("records", [])}
    if not isinstance(route_ids, list) or set(route_ids) != set(source_by_route):
        raise DomainRoutingError("domain packet denominator is inconsistent")
    allowlists = packet.get("route_evidence_allowlists")
    if not isinstance(allowlists, dict) or set(allowlists) != set(route_ids):
        raise DomainRoutingError("domain packet evidence allowlists are inconsistent")
    place_allowlists = packet.get("route_place_allowlists")
    if not isinstance(place_allowlists, dict) or set(place_allowlists) != set(route_ids):
        raise DomainRoutingError("domain packet place allowlists are inconsistent")
    if not isinstance(episodes, list):
        raise DomainRoutingError("domain result must be a list")
    result_route_ids = [result.get("route_id") if isinstance(result, dict) else None for result in episodes]
    if len(result_route_ids) != len(set(result_route_ids)) or set(result_route_ids) != set(route_ids):
        raise DomainRoutingError("route results must exactly partition the frozen route denominator")
    for result in episodes:
        route_id = result.get("route_id") if isinstance(result, dict) else None
        source = source_by_route.get(route_id)
        if source is None:
            raise DomainRoutingError("domain result contains an unknown route")
        if result.get("domain") != domain:
            raise DomainRoutingError("domain result crossed its frozen domain")
        if result.get("episode_id") != source.get("episode_id"):
            raise DomainRoutingError("domain result changed episode identity")
        if result.get("observed_message_time") != source.get("observed_message_time"):
            raise DomainRoutingError("domain result changed observed message time")
    denominators = {name: None for name in DOMAIN_NAMES}
    denominators[domain] = route_ids
    try:
        ledger = build_life_ledger(
            episodes,
            denominators,
            allowlists,
            place_allowlists,
        )
    except EventContractError as exc:
        raise DomainRoutingError(str(exc)) from exc
    if ledger["coverage"][domain]["status"] not in {"complete", "ambiguous"}:
        raise DomainRoutingError("every routed episode requires one processing result")
    ledger["domain_packet_seal"] = packet["seal"]
    ledger["seal"] = digest_object({key: value for key, value in ledger.items() if key != "seal"})
    return ledger
