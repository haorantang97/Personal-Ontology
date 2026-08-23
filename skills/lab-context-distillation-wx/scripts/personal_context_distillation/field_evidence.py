from .hashing import digest_object


class FieldEvidenceError(RuntimeError):
    pass


def _nonnegative_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise FieldEvidenceError(f"{field} must be a non-negative integer")
    return value


def validate_field_evidence(body: dict) -> dict:
    if not isinstance(body, dict) or body.get("schema_version") != "pcd-aggregate-field-evidence/v1":
        raise FieldEvidenceError("aggregate field-evidence schema is invalid")
    if body.get("private_content_included") is not False:
        raise FieldEvidenceError("public field evidence cannot include private content")
    travel = body.get("travel_event_ledger")
    places = body.get("place_normalization")
    if not isinstance(travel, dict) or not isinstance(places, dict):
        raise FieldEvidenceError("travel and place evidence are required")
    eligible = _nonnegative_integer(travel.get("eligible_episodes"), "eligible_episodes")
    disposed = _nonnegative_integer(travel.get("terminal_dispositions"), "terminal_dispositions")
    if eligible <= 0 or disposed != eligible or travel.get("ready") is not True or travel.get("error_codes") != []:
        raise FieldEvidenceError("travel terminal-disposition evidence is incomplete")

    mentions = _nonnegative_integer(places.get("mentions"), "mentions")
    processed = _nonnegative_integer(places.get("processed"), "processed")
    classified = _nonnegative_integer(places.get("classified"), "classified")
    ambiguous = _nonnegative_integer(places.get("ambiguous"), "ambiguous")
    categories = places.get("category_counts")
    if not isinstance(categories, dict) or set(categories) != {"country", "city", "subregion", "landmark", "other"}:
        raise FieldEvidenceError("place category counts are incomplete")
    category_total = sum(_nonnegative_integer(value, f"category {key}") for key, value in categories.items())
    if mentions <= 0 or processed != mentions or classified + ambiguous != processed or category_total != classified:
        raise FieldEvidenceError("place-normalization denominators do not reconcile")
    tests = places.get("regression_tests")
    if not isinstance(tests, dict) or tests.get("passed") != tests.get("total") or not tests.get("total"):
        raise FieldEvidenceError("field regression tests are incomplete")
    for flag in ("authoritative_files_modified", "knowledge_base_write", "cloud_write"):
        if places.get(flag) is not False:
            raise FieldEvidenceError(f"unsafe field-evidence flag: {flag}")
    return {
        "schema_version": "pcd-field-evidence-validation/v1",
        "valid": True,
        "travel_coverage": disposed / eligible,
        "place_coverage": processed / mentions,
        "public_skill_ran_private_data": False,
        "aggregate_hash": digest_object(body),
    }
