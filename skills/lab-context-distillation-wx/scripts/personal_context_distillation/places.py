import unicodedata
from copy import deepcopy


class PlaceContractError(RuntimeError):
    pass


PLACE_KINDS = {"country", "city", "subregion", "landmark", "other", "ambiguous"}
MAPPING_TYPES = {"alias", "typo", "slang", "abbreviation", "contained_in"}
VISITED_DISPOSITIONS = {"occurred", "completed"}


def _key(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def _validate_candidate(candidate: dict) -> None:
    required = {"candidate_id", "raw", "canonical", "kind", "mapping_type", "safe"}
    missing = required - set(candidate)
    if missing:
        raise PlaceContractError(f"candidate fields missing: {sorted(missing)}")
    if candidate["kind"] not in PLACE_KINDS - {"ambiguous"}:
        raise PlaceContractError("candidate kind is invalid")
    if candidate["mapping_type"] not in MAPPING_TYPES:
        raise PlaceContractError("candidate mapping_type is invalid")
    if not isinstance(candidate["safe"], bool):
        raise PlaceContractError("candidate safe must be boolean")
    for field in ("candidate_id", "raw", "canonical"):
        if not isinstance(candidate[field], str) or not candidate[field].strip():
            raise PlaceContractError(f"candidate {field} must be non-empty")
    contained = candidate.get("contained_in")
    if contained is not None:
        if not isinstance(contained, dict) or contained.get("kind") not in PLACE_KINDS - {"ambiguous"}:
            raise PlaceContractError("contained_in must be a typed place object")
        if not isinstance(contained.get("canonical"), str) or not contained["canonical"].strip():
            raise PlaceContractError("contained_in canonical name is required")


def normalize_places(mentions: list[dict], candidates: list[dict]) -> list[dict]:
    if not isinstance(mentions, list) or not isinstance(candidates, list):
        raise PlaceContractError("mentions and candidates must be lists")
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise PlaceContractError("candidate must be an object")
        _validate_candidate(candidate)
    result = []
    seen_places = set()
    for mention in mentions:
        if not isinstance(mention, dict) or set(mention) != {"place_id", "raw"}:
            raise PlaceContractError("mention must contain exactly place_id and raw")
        place_id, raw = mention["place_id"], mention["raw"]
        if not isinstance(place_id, str) or not place_id or place_id in seen_places:
            raise PlaceContractError("place_id must be non-empty and unique")
        if not isinstance(raw, str) or not raw.strip():
            raise PlaceContractError("place raw text must be non-empty")
        seen_places.add(place_id)
        matched = [candidate for candidate in candidates if _key(candidate["raw"]) == _key(raw)]
        safe = [candidate for candidate in matched if candidate["safe"]]
        unique_targets = {(candidate["canonical"], candidate["kind"]) for candidate in safe}
        if len(safe) == 1 and len(unique_targets) == 1:
            candidate = safe[0]
            normalized = {
                "place_id": place_id,
                "raw": raw,
                "canonical": candidate["canonical"],
                "kind": candidate["kind"],
                "status": "applied",
                "mapping_type": candidate["mapping_type"],
                "candidate_ids": [candidate["candidate_id"]],
            }
            if "contained_in" in candidate:
                normalized["contained_in"] = deepcopy(candidate["contained_in"])
        else:
            normalized = {
                "place_id": place_id,
                "raw": raw,
                "canonical": None,
                "kind": "ambiguous",
                "status": "ambiguous",
                "candidate_ids": sorted(candidate["candidate_id"] for candidate in matched),
            }
        result.append(normalized)
    return result


def visited_countries(events: list[dict], places: list[dict]) -> list[dict]:
    place_index = {place.get("place_id"): place for place in places}
    if None in place_index or len(place_index) != len(places):
        raise PlaceContractError("places require unique place_id values")
    countries: dict[str, set[str]] = {}
    for event in events:
        if event.get("subject") != "self" or event.get("disposition") not in VISITED_DISPOSITIONS:
            continue
        route_id = event.get("route_id")
        if not isinstance(route_id, str) or not route_id:
            raise PlaceContractError("visited event requires route_id")
        for place_id in event.get("place_ids", []):
            place = place_index.get(place_id)
            if not place or place.get("status") != "applied" or place.get("kind") != "country":
                continue
            countries.setdefault(place["canonical"], set()).add(route_id)
    return [
        {"canonical": canonical, "kind": "country", "evidence_route_ids": sorted(route_ids)}
        for canonical, route_ids in sorted(countries.items())
    ]
