from pathlib import Path

from .atomic import read_json, write_once_json
from .hashing import digest_object


class EvaluationError(RuntimeError):
    pass


def freeze_evaluation_split(root: Path, name: str, development_ids: list[str], holdout_ids: list[str]) -> dict:
    if not isinstance(name, str) or not name or name in {".", ".."} or any(character in name for character in ("/", "\\", "\x00")):
        raise EvaluationError("evaluation split name is invalid")
    for label, values in (("development", development_ids), ("holdout", holdout_ids)):
        if not isinstance(values, list) or not values or any(not isinstance(item, str) or not item for item in values):
            raise EvaluationError(f"{label} ids must be a non-empty string list")
        if len(values) != len(set(values)):
            raise EvaluationError(f"{label} ids must be unique")
    if set(development_ids).intersection(holdout_ids):
        raise EvaluationError("development and holdout evidence must be disjoint")
    body = {
        "schema_version": "pcd-evaluation-split/v1",
        "name": name,
        "development_ids": sorted(development_ids),
        "holdout_ids": sorted(holdout_ids),
        "promotion_allowed": False,
    }
    body["seal"] = digest_object(body)
    path = Path(root) / "evaluation-splits" / f"{name}.json"
    if path.exists():
        existing = read_json(path)
        if existing != body:
            raise EvaluationError("frozen evaluation split differs")
        return existing
    write_once_json(path, body)
    return body
