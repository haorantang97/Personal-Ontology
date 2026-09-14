import os
from copy import deepcopy
from pathlib import Path

from .atomic import read_json, write_json
from .hashing import digest_object
from .personal_assets import AssetContractError, validate_asset_package


class PortablePackageError(RuntimeError):
    pass


FORBIDDEN_KEYS = {
    "private_identity_map",
    "identity_map",
    "raw_database",
    "raw_chat",
    "decrypt_key",
    "key",
    "source_path",
    "exact_examples",
    "verbatim_examples",
}


def _find_forbidden(value: object, path: str = "package") -> list[str]:
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            child = f"{path}.{key}"
            if key in FORBIDDEN_KEYS or key.endswith("_private_path"):
                found.append(child)
            found.extend(_find_forbidden(item, child))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(_find_forbidden(item, f"{path}[{index}]") )
    return found


def _verify_seal(value: dict, key: str = "seal") -> None:
    claimed = value.get(key)
    body = {field: item for field, item in value.items() if field != key}
    if not isinstance(claimed, str) or digest_object(body) != claimed:
        raise PortablePackageError(f"{key} mismatch")


def build_portable_package(
    ledger: dict,
    places: list[dict],
    evidence: list[dict],
    asset_package: dict,
    cards: list[dict],
) -> dict:
    _verify_seal(ledger)
    evidence_ids = {row.get("evidence_id") for row in evidence if isinstance(row, dict)}
    if None in evidence_ids or len(evidence_ids) != len(evidence):
        raise PortablePackageError("evidence ids must be non-empty and unique")
    try:
        validate_asset_package(asset_package, evidence_ids)
    except AssetContractError as exc:
        raise PortablePackageError(str(exc)) from exc
    place_index = {row.get("place_id"): row for row in places if isinstance(row, dict)}
    if None in place_index or len(place_index) != len(places):
        raise PortablePackageError("place ids must be non-empty and unique")

    events = []
    for original in ledger.get("events", []):
        event = deepcopy(original)
        unknown_evidence = set(event.get("evidence_ids", [])) - evidence_ids
        if unknown_evidence:
            raise PortablePackageError(f"event references unknown evidence: {sorted(unknown_evidence)}")
        missing_places = set(event.get("place_ids", [])) - set(place_index)
        if missing_places:
            raise PortablePackageError(f"event references unknown places: {sorted(missing_places)}")
        event["places"] = [deepcopy(place_index[place_id]) for place_id in event.get("place_ids", [])]
        event.setdefault("active", True)
        events.append(event)

    for card in cards:
        if card.get("confidence") != "high" or card.get("index_only") is not True:
            raise PortablePackageError("knowledge cards must be high-confidence indexes")
        if set(card.get("evidence_ids", [])) - evidence_ids:
            raise PortablePackageError("knowledge card references unknown evidence")

    modules = {
        "biography": {
            "event_ids": [event["event_id"] for event in events],
            "coverage": deepcopy(ledger["coverage"]),
        },
        "voice": deepcopy(asset_package["voice"]),
        "self_model": {"claims": deepcopy(asset_package["self_model"])},
        "goals": deepcopy(asset_package.get("goals", {"items": []})),
        "open_loops": deepcopy(asset_package.get("open_loops", {"items": []})),
        "relationships": deepcopy(asset_package.get("relationships", {"items": []})),
        "time_evolution": deepcopy(asset_package.get("time_evolution", {"items": []})),
    }
    body = {
        "schema_version": "pcd-portable-context/v2",
        "source_ledger_seal": ledger["seal"],
        "events": events,
        "evidence": deepcopy(evidence),
        "cards": deepcopy(cards),
        "coverage": deepcopy(ledger["coverage"]),
        "place_normalization": deepcopy(places),
        "modules": modules,
        "permissions": deepcopy(asset_package["permissions"]),
        "fidelity": deepcopy(asset_package["fidelity"]),
        "evaluation_cases": deepcopy(asset_package["evaluation_cases"]),
        "boundaries": deepcopy(asset_package.get("boundaries", [])),
    }
    body["seal"] = digest_object(body)
    validate_portable_package(body)
    return body


def validate_portable_package(package: dict) -> dict:
    if not isinstance(package, dict) or package.get("schema_version") != "pcd-portable-context/v2":
        raise PortablePackageError("portable package schema is invalid")
    _verify_seal(package)
    forbidden = _find_forbidden(package)
    if forbidden:
        raise PortablePackageError(f"portable package contains a forbidden private field: {forbidden[0]}")
    required = {
        "source_ledger_seal", "events", "evidence", "cards", "coverage",
        "place_normalization", "modules", "permissions", "fidelity", "evaluation_cases", "boundaries",
    }
    if not required.issubset(package):
        raise PortablePackageError(f"portable package fields missing: {sorted(required - set(package))}")
    evidence = package["evidence"]
    if not isinstance(evidence, list):
        raise PortablePackageError("portable evidence must be a list")
    evidence_ids = {row.get("evidence_id") for row in evidence if isinstance(row, dict)}
    if None in evidence_ids or len(evidence_ids) != len(evidence):
        raise PortablePackageError("portable evidence ids are invalid")
    events = package["events"]
    if not isinstance(events, list):
        raise PortablePackageError("portable events must be a list")
    event_ids = []
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get("event_id"), str):
            raise PortablePackageError("portable event id is missing")
        event_ids.append(event["event_id"])
        if set(event.get("evidence_ids", [])) - evidence_ids:
            raise PortablePackageError("portable event references unknown evidence")
    if len(event_ids) != len(set(event_ids)):
        raise PortablePackageError("portable event ids are duplicated")
    modules = package["modules"]
    expected_modules = {"biography", "voice", "self_model", "goals", "open_loops", "relationships", "time_evolution"}
    if not isinstance(modules, dict) or set(modules) != expected_modules:
        raise PortablePackageError("portable runtime modules are incomplete")
    assets = {
        "self_model": modules["self_model"].get("claims") if isinstance(modules["self_model"], dict) else None,
        "voice": modules["voice"],
        "permissions": package["permissions"],
        "fidelity": package["fidelity"],
        "evaluation_cases": package["evaluation_cases"],
    }
    try:
        validate_asset_package(assets, evidence_ids)
    except AssetContractError as exc:
        raise PortablePackageError(str(exc)) from exc
    for card in package["cards"]:
        if card.get("confidence") != "high" or card.get("index_only") is not True:
            raise PortablePackageError("portable knowledge card is not a trusted index")
        if set(card.get("evidence_ids", [])) - evidence_ids:
            raise PortablePackageError("portable knowledge card references unknown evidence")
    return {
        "schema_version": "pcd-portable-validation/v2",
        "valid": True,
        "event_count": len(events),
        "evidence_count": len(evidence),
        "card_count": len(package["cards"]),
        "evaluation_case_count": len(package["evaluation_cases"]),
        "package_seal": package["seal"],
    }


def freeze_portable_package(root: Path, name: str, package: dict) -> dict:
    if not isinstance(name, str) or not name or name in {".", ".."} or any(character in name for character in ("/", "\\", "\x00")):
        raise PortablePackageError("portable package name is invalid")
    validation = validate_portable_package(package)
    directory = Path(root) / name
    package_path = directory / "package.json"
    manifest_path = directory / "manifest.json"
    manifest = {
        "schema_version": "pcd-portable-manifest/v2",
        "name": name,
        "package_seal": package["seal"],
        "package_hash": digest_object(package),
        "event_count": validation["event_count"],
        "evidence_count": validation["evidence_count"],
        "card_count": validation["card_count"],
        "evaluation_case_count": validation["evaluation_case_count"],
    }
    manifest["manifest_seal"] = digest_object(manifest)
    receipt = {
        "name": name,
        "package_seal": package["seal"],
        "manifest_seal": manifest["manifest_seal"],
        "status": "sealed",
    }
    if directory.exists():
        if not package_path.exists() or not manifest_path.exists():
            raise PortablePackageError("portable package directory is incomplete")
        existing_package = read_json(package_path)
        existing_manifest = read_json(manifest_path)
        validate_portable_package(existing_package)
        if existing_package != package or existing_manifest != manifest:
            raise PortablePackageError("portable package is immutable or has been tampered with")
        return receipt
    directory.mkdir(parents=True)
    try:
        write_json(package_path, package)
        write_json(manifest_path, manifest)
        os.chmod(package_path, 0o444)
        os.chmod(manifest_path, 0o444)
        os.chmod(directory, 0o555)
    except Exception:
        for path in (package_path, manifest_path):
            if path.exists():
                os.chmod(path, 0o644)
                path.unlink()
        if directory.exists():
            os.chmod(directory, 0o755)
            directory.rmdir()
        raise
    return receipt
