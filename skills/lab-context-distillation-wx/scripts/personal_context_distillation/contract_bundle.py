import hashlib
from pathlib import Path

from .atomic import read_json
from .hashing import digest_object


class ContractBundleError(RuntimeError):
    pass


CONTRACT_FILES = {
    "field-enums.json",
    "life-event.schema.json",
    "route-result.schema.json",
    "domain-routing-contract.json",
    "place-normalization.schema.json",
    "acceptance-gates.json",
    "delta-routing-rules.json",
}


def _file_hash(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
    return hasher.hexdigest()


def validate_contract_bundle(root: Path) -> dict:
    root = Path(root)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise ContractBundleError("contract manifest is missing")
    manifest = read_json(manifest_path)
    if manifest.get("schema_version") != "pcd-contract-manifest/v1":
        raise ContractBundleError("contract manifest schema is invalid")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != CONTRACT_FILES:
        raise ContractBundleError("contract manifest file denominator is invalid")
    for name, claimed_hash in files.items():
        path = root / name
        if not path.is_file() or not isinstance(claimed_hash, str) or _file_hash(path) != claimed_hash:
            raise ContractBundleError(f"contract file hash mismatch: {name}")
    expected_bundle_hash = digest_object({
        "contract_version": manifest.get("contract_version"),
        "files": files,
        "status": manifest.get("status"),
    })
    if manifest.get("bundle_hash") != expected_bundle_hash:
        raise ContractBundleError("contract bundle hash mismatch")

    enums = read_json(root / "field-enums.json")
    delta = read_json(root / "delta-routing-rules.json")
    gates = read_json(root / "acceptance-gates.json")
    routing = read_json(root / "domain-routing-contract.json")
    life_schema = read_json(root / "life-event.schema.json")
    route_schema = read_json(root / "route-result.schema.json")
    place_schema = read_json(root / "place-normalization.schema.json")
    list_fields = {
        "domains", "processing_dispositions", "event_dispositions", "subjects", "time_precisions", "place_kinds",
        "place_mapping_types", "coverage_statuses", "failure_categories", "runtime_modes",
    }
    if not list_fields.issubset(enums) or any(
        not isinstance(enums[field], list) or not enums[field] or len(enums[field]) != len(set(enums[field]))
        for field in list_fields
    ):
        raise ContractBundleError("field enums are incomplete or duplicated")
    if set(life_schema.get("properties", {}).get("disposition", {}).get("enum", [])) != set(enums["event_dispositions"]):
        raise ContractBundleError("life-event disposition enum drift")
    if set(life_schema.get("properties", {}).get("subject", {}).get("enum", [])) != set(enums["subjects"]):
        raise ContractBundleError("life-event subject enum drift")
    route_properties = route_schema.get("properties", {})
    if set(route_properties.get("domain", {}).get("enum", [])) != set(enums["domains"]):
        raise ContractBundleError("route-result domain enum drift")
    if set(route_properties.get("processing_disposition", {}).get("enum", [])) != set(enums["processing_dispositions"]):
        raise ContractBundleError("route-result processing disposition drift")
    if route_properties.get("events", {}).get("items", {}).get("$ref") != "life-event.schema.json":
        raise ContractBundleError("route-result event item schema drift")
    if set(place_schema.get("properties", {}).get("kind", {}).get("enum", [])) != set(enums["place_kinds"]):
        raise ContractBundleError("place kind enum drift")
    if set(routing.get("domain_execution_order", {}).get("field_evidenced_first", []) + routing.get("domain_execution_order", {}).get("remaining_independent", [])) != set(enums["domains"]):
        raise ContractBundleError("domain routing coverage drift")
    gate_rows = gates.get("gates")
    if not isinstance(gate_rows, list) or any(not isinstance(row, dict) for row in gate_rows):
        raise ContractBundleError("acceptance gates are invalid")
    gate_ids = [row.get("gate_id") for row in gate_rows]
    if any(not isinstance(gate_id, str) or not gate_id for gate_id in gate_ids) or len(gate_ids) != len(set(gate_ids)):
        raise ContractBundleError("acceptance gate ids are invalid")
    if delta.get("start_stage") != "post_map_domain_routing" or delta.get("accepted_map_policy") != "reuse_never_rerun":
        raise ContractBundleError("delta routing start or accepted policy drift")
    route_policy = routing.get("output")
    expected_route_policy = {
        "cardinality": "exactly_one_route_result_per_route_id",
        "event_cardinality": "zero_to_many_independent_events",
        "route_evidence_allowlist_required": True,
        "route_place_allowlist_required": True,
        "event_disposition_is_authoritative": True,
    }
    if not isinstance(route_policy, dict) or any(route_policy.get(key) != value for key, value in expected_route_policy.items()):
        raise ContractBundleError("route-result output policy drift")
    return {
        "schema_version": "pcd-contract-validation/v1",
        "valid": True,
        "contract_version": manifest["contract_version"],
        "bundle_hash": manifest["bundle_hash"],
        "files": files,
        "enums": enums,
        "delta_rules": delta,
        "acceptance_gate_ids": sorted(gate_ids),
        "route_result_policy": {key: route_policy[key] for key in expected_route_policy},
    }
