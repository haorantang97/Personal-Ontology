from typing import Iterable


class ValidationError(RuntimeError):
    pass


ALLOWED_STRENGTHS = {"observed", "self_report", "third_party", "quoted", "unknown"}


def validate_candidate(candidate: dict, valid_evidence_ids: Iterable[str]) -> None:
    if not isinstance(candidate.get("statement"), str) or not candidate["statement"].strip():
        raise ValidationError("statement must be a non-empty string")
    evidence = candidate.get("evidence_ids")
    if not isinstance(evidence, list) or not evidence:
        raise ValidationError("evidence_ids must be a non-empty list")
    valid = set(valid_evidence_ids)
    missing = [item for item in evidence if item not in valid]
    if missing:
        raise ValidationError(f"evidence id missing: {missing}")
    if len(evidence) != len(set(evidence)):
        raise ValidationError("evidence ids must be unique")
    if candidate.get("source_strength") not in ALLOWED_STRENGTHS:
        raise ValidationError("invalid source strength")


def classify_error(status_code: int | None, message: str) -> str:
    lowered = message.lower()
    if status_code in {408, 425, 429, 500, 502, 503, 504} or any(x in lowered for x in ("timeout", "rate limit", "connection reset")):
        return "infrastructure"
    if any(x in lowered for x in ("private key", "unredacted", "secret detected", "identity leak")):
        return "privacy"
    if "dependency" in lowered:
        return "dependency"
    if any(x in lowered for x in ("must be string", "must be list", "schema", "null", "field shape")):
        return "structure"
    return "content"
