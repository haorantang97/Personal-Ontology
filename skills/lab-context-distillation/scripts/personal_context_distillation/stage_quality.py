from copy import deepcopy
from collections import Counter

from .validation import ValidationError, validate_candidate


class QualityError(RuntimeError):
    pass


QUALITY_FIELDS = ("negative_patterns", "counterexamples", "costs", "time_evolution", "gaps", "conflicts")
QA_CHECKS = ("structure", "evidence_recall", "attribution", "negative_patterns", "counterexamples", "coverage", "overreach")


def _evidence_ids(packet: dict) -> list[str]:
    identifiers = []
    for record in packet.get("records", []):
        identifier = record.get("component_id") or record.get("record_id") or record.get("candidate_id")
        if not identifier:
            raise QualityError("packet record has no evidence identifier")
        identifiers.append(identifier)
    if len(identifiers) != len(set(identifiers)):
        raise QualityError("packet evidence identifiers are not unique")
    return identifiers


def _coverage(body: dict, denominator: list[str], candidates: list[dict]) -> tuple[set[str], set[str]]:
    valid = set(denominator)
    referenced = {item for candidate in candidates for item in candidate.get("evidence_ids", [])}
    excluded_entries = (body.get("coverage") or {}).get("excluded", [])
    if not isinstance(excluded_entries, list):
        raise QualityError("coverage.excluded must be a list")
    excluded = set()
    for entry in excluded_entries:
        if not isinstance(entry, dict) or entry.get("evidence_id") not in valid:
            raise QualityError("coverage exclusion references unknown evidence")
        if not isinstance(entry.get("reason"), str) or not entry["reason"].strip():
            raise QualityError("coverage exclusion requires a non-empty reason")
        if entry["evidence_id"] in excluded:
            raise QualityError("coverage exclusion is duplicated")
        excluded.add(entry["evidence_id"])
    overlap = referenced & excluded
    if overlap:
        raise QualityError("evidence cannot be both used and excluded")
    missing = valid - referenced - excluded
    if missing:
        raise QualityError(f"stage output has unaccounted evidence: {sorted(missing)}")
    return referenced, excluded


def _validate_quality(candidate: dict) -> None:
    quality = candidate.get("quality")
    if not isinstance(quality, dict):
        raise QualityError("candidate quality assessment is required")
    missing = [field for field in QUALITY_FIELDS if field not in quality]
    if missing:
        raise QualityError(f"candidate quality assessment is incomplete: {missing}")
    if any(not isinstance(quality[field], list) for field in QUALITY_FIELDS):
        raise QualityError("candidate quality assessment fields must be lists")


def _ratio(metric: dict, name: str) -> float:
    if not isinstance(metric, dict):
        raise QualityError(f"QA {name} metric is required")
    numerator, denominator = metric.get("numerator"), metric.get("denominator")
    if not isinstance(numerator, int) or not isinstance(denominator, int) or denominator <= 0:
        raise QualityError(f"QA {name} metric must use integer counts and a positive denominator")
    if numerator < 0 or numerator > denominator:
        raise QualityError(f"QA {name} numerator is outside its denominator")
    return numerator / denominator


def _validate_qa(body: dict) -> tuple[float, float]:
    qa = body.get("qa")
    if not isinstance(qa, dict):
        raise QualityError("QA stage requires a distinct qa report")
    if qa.get("verdict") != "pass":
        raise QualityError("QA verdict must pass before acceptance")
    if not isinstance(qa.get("unresolved"), list) or qa["unresolved"]:
        raise QualityError("QA has unresolved findings")
    checks = qa.get("checks")
    if not isinstance(checks, dict) or set(checks) != set(QA_CHECKS):
        raise QualityError("QA check set is incomplete or contains unknown checks")
    for name, check in checks.items():
        if not isinstance(check, dict) or check.get("status") != "pass":
            raise QualityError(f"QA check did not pass: {name}")
        if not isinstance(check.get("detail"), str):
            raise QualityError(f"QA check detail is missing: {name}")
    return _ratio(qa.get("precision"), "precision"), _ratio(qa.get("recall"), "recall")


def validate_stage_output(stage: str, packet: dict, output: dict | list) -> tuple[dict, dict]:
    body = {"candidates": deepcopy(output)} if isinstance(output, list) else deepcopy(output)
    if not isinstance(body, dict):
        raise QualityError("stage output must be an object or candidate list")
    candidates = body.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise QualityError("stage output candidates must be a non-empty list")
    denominator = _evidence_ids(packet)
    try:
        for candidate in candidates:
            validate_candidate(candidate, denominator)
            if stage != "qa":
                _validate_quality(candidate)
            if stage == "merge":
                components = candidate.get("component_candidate_ids")
                if not isinstance(components, list) or not components:
                    raise QualityError("merge candidate requires component_candidate_ids")
                if set(components) != set(candidate["evidence_ids"]):
                    raise QualityError("merge component ids must exactly match its evidence ids")
                unresolved = [item for item in candidate["quality"]["conflicts"] if not isinstance(item, dict) or item.get("status") != "resolved"]
                if unresolved:
                    raise QualityError("merge has unresolved conflicts")
                unresolved_gaps = [
                    item for item in candidate["quality"]["gaps"]
                    if not isinstance(item, dict) or item.get("status") not in {"resolved", "accepted_limitation"}
                ]
                if unresolved_gaps:
                    raise QualityError("merge has missing evidence that is neither resolved nor accepted as a limitation")
            if stage == "final":
                if candidate.get("confidence") not in {"low", "medium", "high"}:
                    raise QualityError("final candidate requires bounded confidence")
                if not isinstance(candidate.get("limitations"), list):
                    raise QualityError("final candidate requires limitations list")
    except ValidationError as exc:
        raise QualityError(str(exc)) from exc
    if stage == "merge":
        component_counts = Counter(
            component for candidate in candidates for component in candidate["component_candidate_ids"]
        )
        overlaps = sorted(component for component, count in component_counts.items() if count != 1)
        if overlaps:
            raise QualityError(f"merge components overlap: {overlaps}")
    referenced, excluded = _coverage(body, denominator, candidates)
    precision = recall = None
    if stage == "qa":
        precision, recall = _validate_qa(body)
    receipt = {
        "stage": stage,
        "denominator": len(denominator),
        "referenced": len(referenced),
        "excluded": len(excluded),
        "evidence_recall": len(referenced) / len(denominator),
        "disposition_coverage": (len(referenced) + len(excluded)) / len(denominator),
        "candidate_count": len(candidates),
    }
    if stage == "merge":
        receipt["component_count"] = len(candidates)
    if stage == "qa":
        receipt.update(precision=precision, recall=recall)
    return body, receipt
