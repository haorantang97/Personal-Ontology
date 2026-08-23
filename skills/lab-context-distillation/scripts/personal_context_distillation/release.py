import json
import os
import shutil
from copy import deepcopy
from pathlib import Path

from .atomic import write_json
from .hashing import canonical_json, digest_file, digest_object


class ReleaseError(RuntimeError):
    pass


PRIVATE_RELEASE_KEYS = {
    "sender_id", "self_id", "real_sender_id", "account_path", "db_storage_path",
    "source_path", "identity_map", "decrypt_key", "key", "contacts", "groups", "source_rows",
}

RELEASE_RECORD_FIELDS = {
    "record_id", "source_fingerprint", "timestamp", "platform", "conversation_id", "direction",
    "author_scope", "authored_text", "quoted_text", "quoted_author", "forwarded_context",
    "message_kind", "media_type", "media_refs", "media_available", "media_expected",
    "transcript_available", "ordering_basis", "ordering_certainty", "evidence_precision",
    "redaction_status", "redaction_findings",
}


def _private_field(value) -> str | None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in PRIVATE_RELEASE_KEYS or key.endswith("_private_path"):
                return key
            nested = _private_field(item)
            if nested:
                return nested
    elif isinstance(value, list):
        for item in value:
            nested = _private_field(item)
            if nested:
                return nested
    return None


def build_release(case_root: Path, generation: str, records: list[dict], gaps: list[str] | None = None) -> Path:
    if not generation or generation in {".", ".."} or any(character in generation for character in ("/", "\\", "\x00")):
        raise ReleaseError("release generation must be one safe path component")
    releases = Path(case_root) / "releases"
    releases.mkdir(parents=True, exist_ok=True)
    target = releases / generation
    staging = releases / f".{generation}.staging"
    if target.exists():
        raise ReleaseError(f"release already exists and is immutable: {generation}")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir()
    try:
        records_path = staging / "records.jsonl"
        release_records = []
        with records_path.open("w", encoding="utf-8") as handle:
            for record in records:
                if record.get("redaction_status") != "redacted":
                    raise ReleaseError("unredacted record cannot enter a release")
                public_record = deepcopy(record)
                public_record.pop("source_locator", None)
                unknown = sorted(set(public_record) - RELEASE_RECORD_FIELDS)
                if unknown:
                    raise ReleaseError(f"unknown field cannot enter a release: {unknown[0]}")
                private = _private_field(public_record)
                if private:
                    raise ReleaseError(f"private field cannot enter a release: {private}")
                if public_record.get("conversation_id"):
                    public_record["conversation_id"] = "conv_" + digest_object(
                        {"conversation_id": public_record["conversation_id"]}
                    )[:16]
                release_records.append(public_record)
                handle.write(canonical_json(public_record) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        manifest = {
            "schema_version": "pcd-release/v1",
            "generation": generation,
            "record_count": len(release_records),
            "source_fingerprints": sorted(record["source_fingerprint"] for record in records),
            "gaps": list(gaps or []),
            "files": {"records.jsonl": digest_file(records_path)},
        }
        manifest["seal"] = digest_object(manifest)
        write_json(staging / "manifest.json", manifest)
        os.replace(staging, target)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise
    return target


def verify_release(release_path: Path) -> dict:
    release_path = Path(release_path)
    manifest_path = release_path / "manifest.json"
    if not manifest_path.exists():
        raise ReleaseError("release manifest is missing")
    manifest_text = manifest_path.read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    claimed_seal = manifest.get("seal")
    body = {k: v for k, v in manifest.items() if k != "seal"}
    if digest_object(body) != claimed_seal:
        raise ReleaseError("release manifest seal mismatch")
    for relative, expected in manifest.get("files", {}).items():
        path = release_path / relative
        if not path.exists() or digest_file(path) != expected:
            raise ReleaseError(f"release file hash mismatch: {relative}")
    lines = [line for line in (release_path / "records.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(lines) != manifest.get("record_count"):
        raise ReleaseError("release record count mismatch")
    return manifest
