from collections import Counter
from typing import Iterable

from .hashing import digest_object


def source_locator(row: dict) -> dict:
    return {
        "source": str(row.get("source", "")),
        "shard": str(row.get("shard", "")),
        "row_id": str(row.get("row_id", "")),
    }


def source_fingerprint(row: dict) -> str:
    locator = source_locator(row)
    material = {
        "locator": locator,
        "timestamp": row.get("timestamp"),
        "sender_id": row.get("sender_id"),
        "kind": row.get("kind", "text"),
        "text": row.get("text", ""),
        "quoted_text": row.get("quoted_text", ""),
        "forwarded_context": row.get("forwarded_context", ""),
    }
    return digest_object(material)


def normalize_rows(rows: Iterable[dict]) -> list[dict]:
    records = []
    for row in rows:
        sender = row.get("sender_id")
        self_id = row.get("self_id")
        if not sender or not self_id:
            direction = "ambiguous"
            author_scope = "unknown"
        elif sender == self_id:
            direction = "self"
            author_scope = "self"
        else:
            direction = "other"
            author_scope = "other"
        fingerprint = source_fingerprint(row)
        record = {
            "record_id": "rec_" + digest_object({"source_fingerprint": fingerprint})[:20],
            "source_fingerprint": fingerprint,
            "source_locator": source_locator(row),
            "timestamp": row.get("timestamp"),
            "platform": row.get("platform", "wechat"),
            "conversation_id": row.get("conversation_id"),
            "direction": direction,
            "author_scope": author_scope,
            "authored_text": str(row.get("text") or ""),
            "quoted_text": str(row.get("quoted_text") or ""),
            "quoted_author": row.get("quoted_author"),
            "forwarded_context": str(row.get("forwarded_context") or ""),
            "message_kind": row.get("kind", "text"),
            "media_type": row.get("media_type"),
            "media_refs": list(row.get("media_refs") or []),
            "media_available": bool(row.get("media_available", False)),
            "media_expected": bool(row.get("media_expected", False)),
            "transcript_available": row.get("transcript_available"),
            "ordering_basis": row.get("ordering_basis"),
            "ordering_certainty": row.get("ordering_certainty", "source_order_unspecified"),
            "evidence_precision": row.get("evidence_precision") or ("verbatim" if row.get("text") else "metadata_only"),
            "redaction_status": "raw_local",
        }
        records.append(record)
    return records


def validate_coverage(source_rows: Iterable[dict], records: Iterable[dict]) -> None:
    expected = Counter(source_fingerprint(row) for row in source_rows)
    actual = Counter(record.get("source_fingerprint") for record in records)
    if expected != actual:
        missing = list((expected - actual).elements())
        unexpected = list((actual - expected).elements())
        raise ValueError(f"source coverage mismatch: missing={len(missing)} unexpected={len(unexpected)}")
