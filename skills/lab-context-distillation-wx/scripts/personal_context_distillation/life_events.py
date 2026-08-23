from copy import deepcopy

from .hashing import digest_object


class EventContractError(RuntimeError):
    pass


DOMAIN_NAMES = (
    "travel",
    "education",
    "work",
    "relationship",
    "residence",
    "family",
    "health",
    "finance",
    "creation",
)

EVENT_DISPOSITIONS = {
    "occurred",
    "completed",
    "ongoing",
    "booked_unconfirmed",
    "visa",
    "planned",
    "discussed",
    "third_party",
}
PROCESSING_DISPOSITIONS = {
    "events_emitted",
    "out_of_domain",
    "insufficient_evidence",
    "no_signal",
}
TIME_PRECISIONS = {
    "day", "month", "year", "relative", "unknown",
}
SUBJECTS = {
    "self", "third_party", "mixed", "unknown",
}
EVENT_ITEM_FIELDS = {
    "subject", "disposition", "title", "summary", "importance", "asserted_event_time",
    "evidence_ids", "place_ids",
}
ROUTE_RESULT_FIELDS = {
    "route_id", "episode_id", "domain", "observed_message_time",
    "processing_disposition", "events",
}


def _validate_time(value: object, field: str, *, required: bool) -> dict | None:
    if value is None:
        if required:
            raise EventContractError(f"{field} is required")
        return None
    if not isinstance(value, dict) or set(value) != {"value", "precision"}:
        raise EventContractError(f"{field} must contain exactly value and precision")
    precision = value.get("precision")
    if precision not in TIME_PRECISIONS:
        raise EventContractError(f"{field} precision is invalid")
    raw = value.get("value")
    if precision == "unknown":
        if raw not in {None, ""}:
            raise EventContractError(f"{field} unknown precision cannot assert a value")
    elif not isinstance(raw, str) or not raw.strip():
        raise EventContractError(f"{field} value is required for known precision")
    return deepcopy(value)


def _unique_string_list(value: object, field: str, *, empty_allowed: bool) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise EventContractError(f"{field} must be a string list")
    if not empty_allowed and not value:
        raise EventContractError(f"{field} cannot be empty")
    if len(value) != len(set(value)):
        raise EventContractError(f"{field} must be unique")
    return deepcopy(value)


def validate_event_item(
    event: dict,
    *,
    evidence_allowlist: set[str],
    place_allowlist: set[str],
) -> dict:
    if not isinstance(event, dict) or set(event) != EVENT_ITEM_FIELDS:
        raise EventContractError("event item fields are invalid")
    if event["subject"] not in SUBJECTS:
        raise EventContractError("event subject is invalid")
    if event["disposition"] not in EVENT_DISPOSITIONS:
        raise EventContractError("event disposition is invalid")
    if (event["disposition"] == "third_party") != (event["subject"] == "third_party"):
        raise EventContractError("third_party event disposition and subject must agree")
    for field in ("title", "summary"):
        if not isinstance(event[field], str) or not event[field].strip():
            raise EventContractError(f"event {field} must be a non-empty string")
    importance = event["importance"]
    if isinstance(importance, bool) or not isinstance(importance, (int, float)) or not 0 <= importance <= 1:
        raise EventContractError("event importance must be between zero and one")
    asserted = _validate_time(event["asserted_event_time"], "asserted_event_time", required=False)
    evidence = _unique_string_list(event["evidence_ids"], "event evidence_ids", empty_allowed=False)
    outside = set(evidence) - evidence_allowlist
    if outside:
        raise EventContractError(f"event evidence is outside its route allowlist: {sorted(outside)}")
    places = _unique_string_list(event["place_ids"], "event place_ids", empty_allowed=True)
    outside_places = set(places) - place_allowlist
    if outside_places:
        raise EventContractError(f"event place is outside its route allowlist: {sorted(outside_places)}")
    normalized = deepcopy(event)
    normalized["asserted_event_time"] = asserted
    normalized["evidence_ids"] = evidence
    normalized["place_ids"] = places
    return normalized


def validate_route_result(
    result: dict,
    evidence_allowlist: set[str],
    place_allowlist: set[str],
) -> dict:
    if not isinstance(result, dict) or set(result) != ROUTE_RESULT_FIELDS:
        raise EventContractError("route result fields are invalid")
    for field in ("route_id", "episode_id"):
        if not isinstance(result[field], str) or not result[field].strip():
            raise EventContractError(f"{field} must be a non-empty string")
    if result["domain"] not in DOMAIN_NAMES:
        raise EventContractError("route result domain is invalid")
    processing = result["processing_disposition"]
    if processing not in PROCESSING_DISPOSITIONS:
        raise EventContractError("route result requires one processing disposition")
    observed = _validate_time(result["observed_message_time"], "observed_message_time", required=True)
    events = result["events"]
    if not isinstance(events, list):
        raise EventContractError("route result events must be a list")
    if processing == "events_emitted" and not events:
        raise EventContractError("events_emitted requires at least one event")
    if processing != "events_emitted" and events:
        raise EventContractError("non-emitting processing dispositions require an empty events list")
    normalized = deepcopy(result)
    normalized["observed_message_time"] = observed
    normalized["events"] = [
        validate_event_item(
            event,
            evidence_allowlist=evidence_allowlist,
            place_allowlist=place_allowlist,
        )
        for event in events
    ]
    return normalized


def _materialize_events(route_result: dict) -> list[dict]:
    materialized = []
    for index, event in enumerate(route_result["events"]):
        row = {
            "schema_version": "pcd-life-event/v3",
            "route_id": route_result["route_id"],
            "episode_id": route_result["episode_id"],
            "domain": route_result["domain"],
            "processing_disposition": route_result["processing_disposition"],
            "observed_message_time": deepcopy(route_result["observed_message_time"]),
            **deepcopy(event),
        }
        row["event_id"] = "event_" + digest_object({
            "route_id": row["route_id"],
            "event_index": index,
            "event": event,
        })[:20]
        materialized.append(row)
    return materialized


def _normalize_denominators(denominators: dict[str, list[str] | None]) -> tuple[dict[str, set[str] | None], set[str]]:
    if not isinstance(denominators, dict) or set(denominators) != set(DOMAIN_NAMES):
        raise EventContractError("denominators must name every supported domain exactly once")
    normalized: dict[str, set[str] | None] = {}
    all_expected: set[str] = set()
    for domain in DOMAIN_NAMES:
        value = denominators[domain]
        if value is None:
            normalized[domain] = None
            continue
        routes = set(_unique_string_list(value, f"{domain} denominator", empty_allowed=True))
        overlap = all_expected.intersection(routes)
        if overlap:
            raise EventContractError(f"route appears in multiple domain denominators: {sorted(overlap)}")
        all_expected.update(routes)
        normalized[domain] = routes
    return normalized, all_expected


def _normalize_route_allowlists(
    value: dict[str, list[str]],
    expected_routes: set[str],
    *,
    field: str,
    empty_allowed: bool,
) -> dict[str, list[str]]:
    if not isinstance(value, dict) or set(value) != expected_routes:
        raise EventContractError(f"route {field} allowlists must exactly match the frozen route denominator")
    normalized = {}
    for route_id in sorted(value):
        normalized[route_id] = _unique_string_list(
            value[route_id], f"route {field} allowlist {route_id}", empty_allowed=empty_allowed,
        )
    return normalized


def build_life_ledger(
    route_results: list[dict],
    denominators: dict[str, list[str] | None],
    route_evidence_allowlists: dict[str, list[str]],
    route_place_allowlists: dict[str, list[str]],
) -> dict:
    if not isinstance(route_results, list):
        raise EventContractError("route results must be a list")
    normalized_denominators, all_expected = _normalize_denominators(denominators)
    evidence_allowlists = _normalize_route_allowlists(
        route_evidence_allowlists, all_expected, field="evidence", empty_allowed=False,
    )
    place_allowlists = _normalize_route_allowlists(
        route_place_allowlists, all_expected, field="place", empty_allowed=True,
    )
    validated_results = []
    seen_routes = set()
    observed_by_domain = {domain: set() for domain in DOMAIN_NAMES}
    for original in route_results:
        route_id = original.get("route_id") if isinstance(original, dict) else None
        if route_id not in evidence_allowlists:
            raise EventContractError(f"route result is outside the frozen denominator: {route_id}")
        result = validate_route_result(
            original,
            set(evidence_allowlists[route_id]),
            set(place_allowlists[route_id]),
        )
        if result["route_id"] in seen_routes:
            raise EventContractError(f"route has more than one processing result: {result['route_id']}")
        expected = normalized_denominators[result["domain"]]
        if expected is None or result["route_id"] not in expected:
            raise EventContractError(f"route crossed its frozen domain denominator: {result['route_id']}")
        seen_routes.add(result["route_id"])
        observed_by_domain[result["domain"]].add(result["route_id"])
        validated_results.append(result)

    coverage = {}
    for domain in DOMAIN_NAMES:
        expected = normalized_denominators[domain]
        observed = observed_by_domain[domain]
        if expected is None:
            status = "not_extracted"
            expected_count = None
        elif observed != expected:
            status = "partial"
            expected_count = len(expected)
        elif any(
            result["domain"] == domain and result["processing_disposition"] == "insufficient_evidence"
            for result in validated_results
        ):
            status = "ambiguous"
            expected_count = len(expected)
        else:
            status = "complete"
            expected_count = len(expected)
        coverage[domain] = {
            "status": status,
            "expected": expected_count,
            "processed": len(observed),
            "missing_route_ids": sorted((expected or set()) - observed),
        }

    events = [event for result in validated_results for event in _materialize_events(result)]
    body = {
        "schema_version": "pcd-life-ledger/v3",
        "route_results": validated_results,
        "route_evidence_allowlists": evidence_allowlists,
        "route_place_allowlists": place_allowlists,
        "events": events,
        "coverage": coverage,
        "route_count": len(validated_results),
        "event_count": len(events),
        "subject_event_count": sum(event["subject"] == "self" for event in events),
        "no_signal_count": sum(
            result["processing_disposition"] == "no_signal" for result in validated_results
        ),
    }
    body["seal"] = digest_object(body)
    return body


def biography_view(ledger: dict, minimum_importance: float = 0.0) -> list[dict]:
    if isinstance(minimum_importance, bool) or not isinstance(minimum_importance, (int, float)):
        raise EventContractError("minimum_importance must be numeric")
    if not 0 <= minimum_importance <= 1:
        raise EventContractError("minimum_importance must be between zero and one")
    events = ledger.get("events")
    if not isinstance(events, list):
        raise EventContractError("ledger events are missing")
    selected = [
        deepcopy(event)
        for event in events
        if event.get("subject") == "self"
        and event.get("importance", 0) >= minimum_importance
    ]
    return sorted(selected, key=lambda row: (-row["importance"], row["event_id"]))


def merge_domain_ledgers(ledgers: list[dict]) -> dict:
    if not isinstance(ledgers, list) or not ledgers:
        raise EventContractError("domain ledgers must be a non-empty list")
    coverage = {
        domain: {"status": "not_extracted", "expected": None, "processed": 0, "missing_route_ids": []}
        for domain in DOMAIN_NAMES
    }
    claimed_domains = set()
    route_results = []
    evidence_allowlists = {}
    place_allowlists = {}
    events = []
    seen_routes = set()
    seen_events = set()
    source_seals = []
    for ledger in ledgers:
        if not isinstance(ledger, dict) or ledger.get("schema_version") != "pcd-life-ledger/v3":
            raise EventContractError("domain ledger schema is invalid")
        claimed = ledger.get("seal")
        unsigned = {key: value for key, value in ledger.items() if key != "seal"}
        if not isinstance(claimed, str) or digest_object(unsigned) != claimed:
            raise EventContractError("domain ledger seal mismatch")
        source_seals.append(claimed)
        local_coverage = ledger.get("coverage")
        if not isinstance(local_coverage, dict) or set(local_coverage) != set(DOMAIN_NAMES):
            raise EventContractError("domain ledger coverage is incomplete")
        active_domains = {
            domain for domain in DOMAIN_NAMES
            if local_coverage[domain].get("status") != "not_extracted"
        }
        overlap = claimed_domains.intersection(active_domains)
        if overlap:
            raise EventContractError(f"domain has more than one authority: {sorted(overlap)}")
        claimed_domains.update(active_domains)
        for domain in active_domains:
            coverage[domain] = deepcopy(local_coverage[domain])

        local_evidence_allowlists = ledger.get("route_evidence_allowlists")
        local_place_allowlists = ledger.get("route_place_allowlists")
        if not isinstance(local_evidence_allowlists, dict) or not isinstance(local_place_allowlists, dict):
            raise EventContractError("domain ledger route allowlists are missing")
        regenerated_events = []
        for original in ledger.get("route_results", []):
            route_id = original.get("route_id") if isinstance(original, dict) else None
            if (
                route_id in seen_routes
                or route_id not in local_evidence_allowlists
                or route_id not in local_place_allowlists
            ):
                raise EventContractError("route appears in multiple ledgers or lacks an allowlist")
            result = validate_route_result(
                original,
                set(local_evidence_allowlists[route_id]),
                set(local_place_allowlists[route_id]),
            )
            if result["domain"] not in active_domains:
                raise EventContractError("route result lacks matching domain coverage")
            seen_routes.add(route_id)
            evidence_allowlists[route_id] = deepcopy(local_evidence_allowlists[route_id])
            place_allowlists[route_id] = deepcopy(local_place_allowlists[route_id])
            route_results.append(result)
            regenerated_events.extend(_materialize_events(result))
        if regenerated_events != ledger.get("events"):
            raise EventContractError("domain ledger events do not preserve route-result multiplicity")
        for event in regenerated_events:
            if event["event_id"] in seen_events:
                raise EventContractError("event appears in multiple domain ledgers")
            seen_events.add(event["event_id"])
            events.append(event)

    route_results.sort(key=lambda result: (DOMAIN_NAMES.index(result["domain"]), result["route_id"]))
    events = [event for result in route_results for event in _materialize_events(result)]
    body = {
        "schema_version": "pcd-life-ledger/v3",
        "route_results": route_results,
        "route_evidence_allowlists": {
            key: evidence_allowlists[key] for key in sorted(evidence_allowlists)
        },
        "route_place_allowlists": {
            key: place_allowlists[key] for key in sorted(place_allowlists)
        },
        "events": events,
        "coverage": coverage,
        "route_count": len(route_results),
        "event_count": len(events),
        "subject_event_count": sum(event["subject"] == "self" for event in events),
        "no_signal_count": sum(
            result["processing_disposition"] == "no_signal" for result in route_results
        ),
        "combined_domain_count": len(claimed_domains),
        "domain_ledger_seals": source_seals,
    }
    body["seal"] = digest_object(body)
    return body
