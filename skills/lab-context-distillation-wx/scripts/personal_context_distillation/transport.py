import os
from copy import deepcopy
from pathlib import Path

from .hashing import canonical_json, digest_object


class TransportError(RuntimeError):
    pass


STAGE_REQUIRED = {
    "map": ["statement", "evidence_ids", "source_strength", "quality"],
    "merge": ["statement", "evidence_ids", "source_strength", "component_candidate_ids", "quality"],
    "final": ["statement", "evidence_ids", "source_strength", "confidence", "limitations", "quality"],
    "qa": ["statement", "evidence_ids", "source_strength"],
}

FORBIDDEN_MODEL_KEYS = {
    "sender_id", "self_id", "account_path", "db_storage_path", "source_path",
    "key", "decrypt_key", "identity_map", "real_sender_id",
}


def output_contract(stage: str) -> dict:
    if stage not in STAGE_REQUIRED:
        raise TransportError(f"unsupported stage: {stage}")
    contract = {
        "schema_version": "pcd-stage-output-contract/v2",
        "type": "object",
        "required": ["candidates"],
        "candidate_required": STAGE_REQUIRED[stage],
        "coverage_policy": "every_input_evidence_or_reasoned_exclusion",
    }
    if stage != "qa":
        contract["quality_required"] = [
            "negative_patterns", "counterexamples", "costs", "time_evolution", "gaps", "conflicts",
        ]
    if stage == "merge":
        contract["merge_required"] = ["component_candidate_ids"]
        contract["merge_freeze_policy"] = {
            "conflict_status": "resolved",
            "gap_status": ["resolved", "accepted_limitation"],
            "components_must_partition_inputs": True,
        }
    if stage == "final":
        contract["final_required"] = ["confidence", "limitations"]
        contract["confidence_values"] = ["low", "medium", "high"]
    if stage == "qa":
        contract["required"].append("qa")
        contract["qa_required"] = ["verdict", "checks", "precision", "recall", "unresolved"]
        contract["qa_checks"] = [
            "structure", "evidence_recall", "attribution", "negative_patterns",
            "counterexamples", "coverage", "overreach",
        ]
    return contract


def build_packet(stage: str, instruction: str, records: list[dict]) -> dict:
    if not isinstance(instruction, str) or not instruction.strip():
        raise TransportError("packet instruction must be non-empty")
    if not isinstance(records, list):
        raise TransportError("records binding must be a list")
    return {
        "schema_version": "pcd-model-packet/v2",
        "stage": stage,
        "instruction": instruction.strip(),
        "records": deepcopy(records),
        "output_contract": output_contract(stage),
    }


def _find_forbidden(value, path: str = "records") -> list[str]:
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            child = f"{path}.{key}"
            if key in FORBIDDEN_MODEL_KEYS or key.endswith("_private_path"):
                found.append(child)
            found.extend(_find_forbidden(item, child))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(_find_forbidden(item, f"{path}[{index}]"))
    return found


def preflight_packet(packet: dict, max_bytes: int) -> dict:
    if packet.get("schema_version") != "pcd-model-packet/v2":
        raise TransportError("unsupported packet schema")
    if set(packet) != {"schema_version", "stage", "instruction", "records", "output_contract"}:
        raise TransportError("packet must contain exactly one records data binding")
    if not isinstance(packet.get("records"), list) or not packet["records"]:
        raise TransportError("packet records binding must be non-empty")
    if packet.get("output_contract") != output_contract(packet.get("stage")):
        raise TransportError("packet output contract does not match its stage")
    forbidden = _find_forbidden(packet["records"])
    if forbidden:
        raise TransportError(f"raw/private field cannot enter a model packet: {forbidden[0]}")
    encoded_size = len(canonical_json(packet).encode("utf-8"))
    if encoded_size > max_bytes:
        raise TransportError(f"packet exceeds transport byte limit: {encoded_size}>{max_bytes}")
    return {
        "schema_version": "pcd-transport-preflight/v1",
        "stage": packet["stage"],
        "record_count": len(packet["records"]),
        "encoded_bytes": encoded_size,
        "binding_hash": digest_object({"instruction": packet["instruction"], "records": packet["records"]}),
        "contract_hash": digest_object(packet["output_contract"]),
        "single_binding": True,
    }


def probe_contract(stage: str) -> dict:
    from .stage_quality import validate_stage_output

    evidence_key = "record_id" if stage == "map" else "candidate_id"
    evidence_id = "probe_evidence"
    packet = build_packet(stage, "Local no-data contract probe", [{evidence_key: evidence_id}])
    quality = {key: [] for key in ("negative_patterns", "counterexamples", "costs", "time_evolution", "gaps", "conflicts")}
    candidate = {"statement": "Synthetic contract probe", "evidence_ids": [evidence_id], "source_strength": "unknown"}
    if stage != "qa":
        candidate["quality"] = quality
    if stage == "merge":
        candidate["component_candidate_ids"] = [evidence_id]
    if stage == "final":
        candidate.update(confidence="low", limitations=["synthetic probe"])
    body = {"candidates": [candidate]}
    if stage == "qa":
        checks = {name: {"status": "pass", "detail": "local probe"} for name in (
            "structure", "evidence_recall", "attribution", "negative_patterns",
            "counterexamples", "coverage", "overreach",
        )}
        body["qa"] = {
            "verdict": "pass", "checks": checks,
            "precision": {"numerator": 1, "denominator": 1},
            "recall": {"numerator": 1, "denominator": 1}, "unresolved": [],
        }
    validate_stage_output(stage, packet, body)
    return {"stage": stage, "passed": True, "contract_hash": digest_object(output_contract(stage))}


def classify_failure_event(event: dict) -> str | None:
    """Classify only an explicit structured failure event, never ordinary text."""
    if not isinstance(event, dict):
        raise ValueError("transport event must be an object")
    if event.get("event") != "failure":
        return None
    category = event.get("category")
    allowed = {"infrastructure", "structure", "content", "privacy", "dependency"}
    if category not in allowed:
        raise ValueError("explicit failure event has an invalid category")
    if not isinstance(event.get("code"), str) or not event["code"]:
        raise ValueError("explicit failure event requires a code")
    return category


def prepare_output_directory(path: Path) -> dict:
    """Create and synchronously probe an output directory before model dispatch."""
    destination = Path(path)
    destination.mkdir(parents=True, exist_ok=True)
    probe = destination / ".pcd-write-probe"
    try:
        write_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(probe, write_flags, 0o600)
        stream = os.fdopen(descriptor, "w", encoding="utf-8")
        with stream as handle:
            handle.write("ready")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise TransportError("output directory is not ready") from exc
    finally:
        if probe.exists():
            probe.unlink()
    return {"schema_version": "pcd-output-readiness/v1", "ready": True}


def combine_model_and_sidecar_outcome(model_status: str, sidecar_status: str) -> dict:
    if model_status not in {"accepted", "failed", "pending"}:
        raise TransportError("model status is invalid")
    if sidecar_status not in {"accepted", "failed", "not_required", "pending"}:
        raise TransportError("sidecar status is invalid")
    if model_status == "accepted" and sidecar_status in {"failed", "pending"}:
        overall = "accepted_with_sidecar_pending"
        retry_sidecar_only = True
    else:
        overall = model_status
        retry_sidecar_only = False
    return {
        "model_status": model_status,
        "sidecar_status": sidecar_status,
        "overall_status": overall,
        "retry_sidecar_only": retry_sidecar_only,
        "rerun_model": model_status != "accepted",
    }
