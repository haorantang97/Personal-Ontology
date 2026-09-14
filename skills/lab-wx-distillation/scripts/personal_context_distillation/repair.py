from copy import deepcopy
from datetime import datetime, timezone

from .hashing import digest_object


class SemanticRepairRequired(RuntimeError):
    pass


STRENGTH_RANK = {"unknown": 0, "quoted": 1, "third_party": 2, "self_report": 3, "observed": 4}


def _normalize_datetime(value) -> str:
    try:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            parsed = datetime.fromtimestamp(value, tz=timezone.utc)
        elif isinstance(value, str):
            text = value.strip()
            if len(text) == 10:
                datetime.strptime(text, "%Y-%m-%d")
                return text
            parsed = datetime.fromisoformat(text.removesuffix("Z") + ("+00:00" if text.endswith("Z") else ""))
            if parsed.tzinfo is None:
                raise ValueError("timezone is required")
            parsed = parsed.astimezone(timezone.utc)
        else:
            raise ValueError("unsupported date type")
    except (ValueError, OverflowError, OSError) as exc:
        raise SemanticRepairRequired("date cannot be normalized without interpretation") from exc
    return parsed.isoformat().replace("+00:00", "Z")


def downgrade_source_strength(candidate: dict, target: str) -> tuple[dict, dict]:
    current = candidate.get("source_strength")
    if current not in STRENGTH_RANK or target not in STRENGTH_RANK:
        raise SemanticRepairRequired("source strength is unknown")
    if STRENGTH_RANK[target] > STRENGTH_RANK[current]:
        raise SemanticRepairRequired("source strength repair cannot upgrade evidence")
    repaired = deepcopy(candidate)
    repaired["source_strength"] = target
    return repaired, {
        "repair_type": "source_strength_downgrade/v1",
        "before_hash": digest_object(candidate),
        "after_hash": digest_object(repaired),
        "downgrade_only": True,
    }


def repair_structure(candidate: dict, valid_evidence_ids: set[str]) -> tuple[dict, dict]:
    before = deepcopy(candidate)
    narrative_fields = {
        key: deepcopy(candidate[key])
        for key in ("statement", "summary", "title", "authored_text", "quoted_text", "forwarded_context")
        if key in candidate
    }
    repaired = deepcopy(candidate)
    evidence = repaired.get("evidence_ids")
    if not isinstance(evidence, list):
        raise SemanticRepairRequired("evidence shape requires semantic review")
    cleaned = []
    for item in evidence:
        if item is None or item == "":
            continue
        if not isinstance(item, str) or item not in valid_evidence_ids:
            raise SemanticRepairRequired("repair would invent or substitute evidence")
        if item not in cleaned:
            cleaned.append(item)
    if not cleaned:
        raise SemanticRepairRequired("candidate has no valid evidence")
    repaired["evidence_ids"] = cleaned
    time_range = repaired.get("time_range")
    if time_range is not None:
        if not isinstance(time_range, dict) or any(key not in {"start", "end"} for key in time_range):
            raise SemanticRepairRequired("time range shape requires review")
        for key in ("start", "end"):
            if time_range.get(key) is not None:
                time_range[key] = _normalize_datetime(time_range[key])
    quality = repaired.get("quality")
    if isinstance(quality, dict):
        for field, values in quality.items():
            if not isinstance(values, list):
                continue
            clean_values = []
            seen = set()
            for value in values:
                if value is None:
                    continue
                fingerprint = digest_object(value)
                if fingerprint not in seen:
                    clean_values.append(value)
                    seen.add(fingerprint)
            quality[field] = clean_values
    if repaired.get("source_strength") not in {"observed", "self_report", "third_party", "quoted", "unknown"}:
        raise SemanticRepairRequired("source strength cannot be inferred safely")
    receipt = {
        "repair_type": "structure_whitelist/v1",
        "before_hash": digest_object(before),
        "after_hash": digest_object(repaired),
        "semantic_change_allowed": False,
        "narrative_unchanged": narrative_fields == {
            key: repaired.get(key) for key in narrative_fields
        },
        "narrative_before_hash": digest_object(narrative_fields),
        "narrative_after_hash": digest_object({key: repaired.get(key) for key in narrative_fields}),
    }
    if not receipt["narrative_unchanged"]:
        raise SemanticRepairRequired("structural repair changed narrative content")
    return repaired, receipt
