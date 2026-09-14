import json
from pathlib import Path
from typing import Iterable, Iterator

from .atomic import write_json
from .hashing import canonical_json, digest_object


class PlanningError(RuntimeError):
    pass


def split_records(records: list[dict], max_bytes: int) -> list[list[dict]]:
    return list(iter_record_packets(records, max_bytes))


def _fits(record: dict, max_bytes: int) -> bool:
    return len(canonical_json(record).encode("utf-8")) + 2 <= max_bytes


def _largest_prefix(text: str, base: dict, max_bytes: int) -> int:
    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        candidate = {**base, "component_text": text[:middle]}
        if _fits(candidate, max_bytes):
            low = middle
        else:
            high = middle - 1
    return low


def compact_record(record: dict, max_bytes: int) -> list[dict]:
    parent_id = record.get("record_id") or record.get("candidate_id")
    if not parent_id:
        raise PlanningError("oversize record has no lineage identifier")
    text_fields = [field for field in ("authored_text", "quoted_text", "forwarded_context", "statement")
                   if isinstance(record.get(field), str) and record[field]]
    if not text_fields:
        raise PlanningError(f"oversize record has no compactable text: {parent_id}")
    parent_fingerprint = digest_object(record)
    metadata = {key: value for key, value in record.items() if key not in text_fields}
    provisional = []
    for field in text_fields:
        remaining = record[field]
        while remaining:
            base = {
                "schema_version": "pcd-compact-component/v1",
                "component_id": "cmp_" + ("0" * 20),
                "parent_record_id": parent_id,
                "parent_fingerprint": parent_fingerprint,
                "field": field,
                "chunk_index": 999999,
                "chunk_count": 999999,
                "parent_metadata": metadata,
            }
            length = _largest_prefix(remaining, base, max_bytes)
            if length <= 0:
                raise PlanningError(f"packet budget cannot hold compaction lineage: {parent_id}")
            provisional.append((field, remaining[:length]))
            remaining = remaining[length:]
    components = []
    count = len(provisional)
    for index, (field, content) in enumerate(provisional, start=1):
        component = {
            "schema_version": "pcd-compact-component/v1",
            "component_id": "cmp_" + digest_object({"parent": parent_fingerprint, "field": field, "index": index, "content": content})[:20],
            "parent_record_id": parent_id,
            "parent_fingerprint": parent_fingerprint,
            "field": field,
            "chunk_index": index,
            "chunk_count": count,
            "component_text": content,
            "parent_metadata": metadata,
        }
        if not _fits(component, max_bytes):
            raise PlanningError(f"compacted component exceeds packet budget: {parent_id}")
        components.append(component)
    return components


def iter_record_packets(records: Iterable[dict], max_bytes: int) -> Iterator[list[dict]]:
    if max_bytes <= 2:
        raise PlanningError("max_bytes is too small")
    current: list[dict] = []
    current_size = 2
    for original in records:
        expanded = [original] if _fits(original, max_bytes) else compact_record(original, max_bytes)
        for record in expanded:
            encoded_size = len(canonical_json(record).encode("utf-8"))
            added_size = encoded_size + (1 if current else 0)
            if current and current_size + added_size > max_bytes:
                yield current
                current = [record]
                current_size = encoded_size + 2
            else:
                current.append(record)
                current_size += added_size
    if current:
        yield current


def freeze_candidate_set(case_root: Path, name: str, candidate_ids: list[str]) -> dict:
    if not name or name in {".", ".."} or any(character in name for character in ("/", "\\", "\x00")):
        raise PlanningError("candidate set name must be one safe path component")
    if not candidate_ids or len(candidate_ids) != len(set(candidate_ids)):
        raise PlanningError("candidate ids must be non-empty and unique")
    directory = Path(case_root) / "candidate-sets"
    path = directory / f"{name}.json"
    body = {"schema_version": "pcd-candidates/v1", "name": name, "candidate_ids": sorted(set(candidate_ids))}
    body["seal"] = digest_object(body)
    if path.exists():
        existing = json.loads(path.read_text(encoding="utf-8"))
        if existing != body:
            raise PlanningError(f"candidate set is immutable: {name}")
        return existing
    write_json(path, body)
    return body
