import re
import unicodedata
from copy import deepcopy


class RuntimeContractError(RuntimeError):
    pass


MODES = {"biography", "voice", "advisor", "mixed"}
BASE_MODULES = {
    "biography": {"biography"},
    "voice": {"voice"},
    "advisor": {"self_model", "goals", "open_loops"},
    "mixed": {"biography", "voice", "self_model", "goals", "open_loops"},
}
OPTIONAL_MODULES = {"relationships", "time_evolution"}


def _normalized_text(value: object) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).casefold()


def lexical_tokens(value: object) -> set[str]:
    text = _normalized_text(value)
    tokens = set(re.findall(r"[a-z0-9]+", text))
    for sequence in re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]+", text):
        tokens.update(sequence)
        tokens.update(sequence[index:index + 2] for index in range(len(sequence) - 1))
    return {token for token in tokens if token}


def _domain_filter(filters: dict) -> set[str] | None:
    value = filters.get("domain")
    if value is None:
        return None
    domains = {value} if isinstance(value, str) else set(value) if isinstance(value, list) else set()
    if not domains or any(not isinstance(item, str) or not item for item in domains):
        raise RuntimeContractError("domain filter must be a string or non-empty string list")
    return domains


def _matches_filters(event: dict, filters: dict, domains: set[str] | None) -> bool:
    if not event.get("active", True):
        return False
    if domains is not None and event.get("domain") not in domains:
        return False
    if "disposition" in filters and event.get("disposition") != filters["disposition"]:
        return False
    if "subject" in filters and event.get("subject") != filters["subject"]:
        return False
    if "place_kind" in filters:
        places = event.get("places", [])
        if not any(place.get("kind") == filters["place_kind"] for place in places if isinstance(place, dict)):
            return False
    if "year" in filters:
        asserted = event.get("asserted_event_time")
        value = asserted.get("value") if isinstance(asserted, dict) else None
        if not isinstance(value, str) or not value.startswith(str(filters["year"])):
            return False
    return True


def _event_text(event: dict) -> str:
    places = " ".join(
        str(place.get("canonical", "")) + " " + str(place.get("raw", ""))
        for place in event.get("places", [])
        if isinstance(place, dict)
    )
    return " ".join(str(event.get(field, "")) for field in ("title", "summary", "domain", "disposition")) + " " + places


def _auxiliary_matches_filters(row: dict, filters: dict, domains: set[str] | None) -> bool:
    if not row.get("active", True):
        return False
    if domains is not None:
        row_domains = set(row.get("domain_scope", []))
        if isinstance(row.get("domain"), str):
            row_domains.add(row["domain"])
        if not row_domains.intersection(domains):
            return False
    for field in ("disposition", "subject"):
        if field in filters and row.get(field) != filters[field]:
            return False
    if "place_kind" in filters:
        places = row.get("places", [])
        if not any(place.get("kind") == filters["place_kind"] for place in places if isinstance(place, dict)):
            return False
    if "year" in filters:
        asserted = row.get("asserted_event_time")
        value = asserted.get("value") if isinstance(asserted, dict) else None
        if not isinstance(value, str) or not value.startswith(str(filters["year"])):
            return False
    return True


def _search_auxiliary(
    rows: object,
    id_field: str,
    query_tokens: set[str],
    filters: dict,
    domains: set[str] | None,
    semantic_scores: dict[str, float],
    limit: int,
) -> list[dict]:
    if not isinstance(rows, list):
        raise RuntimeContractError(f"{id_field} collection must be a list")
    matches = []
    for row in rows:
        if not isinstance(row, dict) or not _auxiliary_matches_filters(row, filters, domains):
            continue
        item_id = row.get(id_field)
        if not isinstance(item_id, str) or not item_id:
            raise RuntimeContractError(f"runtime auxiliary record requires {id_field}")
        text = " ".join(str(row.get(field, "")) for field in ("title", "summary", "text", "redacted_text", "statement"))
        document_tokens = lexical_tokens(text)
        overlap = len(query_tokens.intersection(document_tokens))
        lexical_score = overlap / len(query_tokens) if query_tokens else 1.0
        semantic_score = float(semantic_scores.get(item_id, 0.0))
        if lexical_score <= 0 and semantic_score <= 0:
            continue
        result = deepcopy(row)
        result["retrieval_score"] = round(lexical_score + semantic_score, 6)
        matches.append(result)
    return sorted(matches, key=lambda row: (-row["retrieval_score"], row[id_field]))[:limit]


def _loaded_modules(package: dict, mode: str, include_modules: list[str] | None) -> list[str]:
    available = package.get("modules")
    if not isinstance(available, dict):
        raise RuntimeContractError("runtime modules are missing")
    requested = set(BASE_MODULES[mode])
    for module in include_modules or []:
        if module not in OPTIONAL_MODULES:
            raise RuntimeContractError(f"unsupported optional runtime module: {module}")
        requested.add(module)
    missing = sorted(requested - set(available))
    if missing:
        raise RuntimeContractError(f"runtime modules unavailable: {missing}")
    return sorted(requested)


def query_runtime(
    package: dict,
    query: str,
    *,
    mode: str,
    filters: dict,
    semantic_scores: dict[str, float] | None = None,
    include_modules: list[str] | None = None,
    limit: int = 10,
) -> dict:
    if mode not in MODES:
        raise RuntimeContractError("mode must be biography, voice, advisor, or mixed")
    if not isinstance(query, str) or not isinstance(filters, dict):
        raise RuntimeContractError("query must be text and filters must be an object")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
        raise RuntimeContractError("limit must be a positive integer")
    semantic_scores = semantic_scores or {}
    if not isinstance(semantic_scores, dict) or any(
        not isinstance(key, str) or isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0
        for key, value in semantic_scores.items()
    ):
        raise RuntimeContractError("semantic scores must map event ids to non-negative numbers")

    domains = _domain_filter(filters)
    query_tokens = lexical_tokens(query)
    matches = []
    for event in package.get("events", []):
        if not isinstance(event, dict) or not _matches_filters(event, filters, domains):
            continue
        event_id = event.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise RuntimeContractError("runtime event requires event_id")
        document_tokens = lexical_tokens(_event_text(event))
        overlap = len(query_tokens.intersection(document_tokens))
        lexical_score = overlap / len(query_tokens) if query_tokens else 1.0
        semantic_score = float(semantic_scores.get(event_id, 0.0))
        if lexical_score <= 0 and semantic_score <= 0:
            continue
        score = lexical_score + semantic_score
        row = deepcopy(event)
        row["retrieval_score"] = round(score, 6)
        matches.append(row)
    matches.sort(key=lambda row: (-row["retrieval_score"], row["event_id"]))
    matches = matches[:limit]

    evidence_matches = _search_auxiliary(
        package.get("evidence", []), "evidence_id", query_tokens, filters, domains, semantic_scores, limit,
    )
    card_matches = _search_auxiliary(
        package.get("cards", []), "card_id", query_tokens, filters, domains, semantic_scores, limit,
    )

    coverage = package.get("coverage", {})
    inferred_domains = {row.get("domain") for row in matches + evidence_matches if row.get("domain")}
    for row in card_matches:
        inferred_domains.update(row.get("domain_scope", []))
    relevant_domains = domains or inferred_domains or set(coverage)
    domain_coverage = {
        domain: coverage.get(domain, {}).get("status", "not_extracted")
        for domain in sorted(relevant_domains)
    }
    answer_status = "grounded" if matches or evidence_matches or card_matches else "unknown"
    result = {
        "schema_version": "pcd-runtime-result/v2",
        "mode": mode,
        "answer_status": answer_status,
        "matches": matches,
        "evidence_matches": evidence_matches,
        "card_matches": card_matches,
        "domain_coverage": domain_coverage,
        "loaded_modules": _loaded_modules(package, mode, include_modules),
        "retrieval_method": "structured_lexical_plus_caller_scores" if semantic_scores else "structured_plus_chinese_lexical",
    }
    if answer_status == "unknown":
        if domains is None and not inferred_domains:
            reason = "domain_scope_undetermined"
        else:
            reason = "domain_not_extracted" if any(status == "not_extracted" for status in domain_coverage.values()) else "no_matching_evidence"
        result["coverage_gap"] = {"reason": reason, "query": query, "filters": deepcopy(filters)}
    return result
