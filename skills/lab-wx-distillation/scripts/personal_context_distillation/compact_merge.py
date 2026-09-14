from copy import deepcopy

from .hashing import digest_object


class CompactMergeError(RuntimeError):
    pass


STRENGTH_RANK = {"unknown": 0, "quoted": 1, "third_party": 2, "self_report": 3, "observed": 4}
QUALITY_FIELDS = ("negative_patterns", "counterexamples", "costs", "time_evolution", "gaps", "conflicts")


def _stable_unique(values: list[object]) -> list[object]:
    result = []
    seen = set()
    for value in values:
        fingerprint = digest_object(value)
        if fingerprint not in seen:
            seen.add(fingerprint)
            result.append(deepcopy(value))
    return result


def reconstruct_grouped_candidates(groups: list[dict], candidates: list[dict]) -> list[dict]:
    if not isinstance(groups, list) or not groups or not isinstance(candidates, list) or not candidates:
        raise CompactMergeError("groups and frozen candidates must be non-empty lists")
    index = {}
    for candidate in candidates:
        candidate_id = candidate.get("candidate_id") if isinstance(candidate, dict) else None
        if not isinstance(candidate_id, str) or not candidate_id or candidate_id in index:
            raise CompactMergeError("frozen candidate ids must be non-empty and unique")
        if not isinstance(candidate.get("statement"), str):
            raise CompactMergeError("frozen candidate statement is required")
        if candidate.get("source_strength") not in STRENGTH_RANK:
            raise CompactMergeError("frozen candidate source strength is invalid")
        index[candidate_id] = candidate

    group_ids = set()
    assigned = []
    for group in groups:
        if not isinstance(group, dict) or set(group) != {"group_id", "component_candidate_ids"}:
            raise CompactMergeError("group output may contain only group_id and component_candidate_ids")
        group_id = group["group_id"]
        components = group["component_candidate_ids"]
        if not isinstance(group_id, str) or not group_id or group_id in group_ids:
            raise CompactMergeError("group ids must be non-empty and unique")
        if not isinstance(components, list) or not components or any(not isinstance(item, str) for item in components):
            raise CompactMergeError("group components must be a non-empty string list")
        group_ids.add(group_id)
        assigned.extend(components)
    if len(assigned) != len(set(assigned)):
        raise CompactMergeError("a frozen candidate appears in more than one group")
    unknown = set(assigned) - set(index)
    missing = set(index) - set(assigned)
    if unknown or missing:
        raise CompactMergeError(f"groups do not partition the frozen candidate set; unknown={sorted(unknown)}, missing={sorted(missing)}")

    reconstructed = []
    for group in groups:
        component_ids = group["component_candidate_ids"]
        components = [index[candidate_id] for candidate_id in component_ids]
        statements = [candidate["statement"] for candidate in components]
        source_evidence = _stable_unique([
            evidence_id
            for candidate in components
            for evidence_id in candidate.get("evidence_ids", [])
        ])
        quality = {
            field: _stable_unique([
                value
                for candidate in components
                for value in candidate.get("quality", {}).get(field, [])
            ])
            for field in QUALITY_FIELDS
        }
        weakest = min((candidate["source_strength"] for candidate in components), key=STRENGTH_RANK.get)
        body = {
            "candidate_id": "cand_" + digest_object({"group_id": group["group_id"], "components": component_ids})[:20],
            "group_id": group["group_id"],
            "statement": "\n\n".join(statements),
            "component_statements": deepcopy(statements),
            "component_candidate_ids": deepcopy(component_ids),
            "evidence_ids": deepcopy(component_ids),
            "source_evidence_ids": source_evidence,
            "source_strength": weakest,
            "quality": quality,
            "narrative_reconstruction": "exact_component_statements",
        }
        reconstructed.append(body)
    return reconstructed
