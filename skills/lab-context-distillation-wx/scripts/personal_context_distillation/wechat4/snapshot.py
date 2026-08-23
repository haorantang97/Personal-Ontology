import math
import os
import shutil
from collections import Counter
from pathlib import Path

from ..atomic import write_json
from ..connectors import snapshot_sqlite
from ..hashing import digest_file, digest_object


class SnapshotError(RuntimeError):
    pass


SQLITE_HEADER = b"SQLite format 3\x00"


def _entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = Counter(data)
    length = len(data)
    return -sum((count / length) * math.log2(count / length) for count in counts.values())


def classify_database(path: Path) -> dict:
    path = Path(path)
    if not path.is_file():
        raise SnapshotError("database path does not exist")
    size = path.stat().st_size
    with path.open("rb") as handle:
        header = handle.read(4096)
    if header.startswith(SQLITE_HEADER):
        kind = "plaintext_sqlite"
    elif size >= 4096 and size % 4096 == 0 and _entropy(header) >= 7.0:
        kind = "sqlcipher_candidate"
    else:
        kind = "unknown_or_corrupt"
    return {
        "kind": kind,
        "size": size,
        "header_hash": digest_object({"header": header.hex()}),
        "page_aligned_4096": size > 0 and size % 4096 == 0,
    }


def _file_signature(path: Path) -> tuple[int, int, str]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns, digest_file(path)


def _stable_bundle_copy(source: Path, destination: Path, attempts: int = 3) -> list[dict]:
    for _ in range(attempts):
        members = [source] + [candidate for candidate in (Path(str(source) + "-wal"), Path(str(source) + "-shm")) if candidate.is_file()]
        before = {path: _file_signature(path) for path in members}
        destination.parent.mkdir(parents=True, exist_ok=True)
        copied = []
        try:
            for member in members:
                target = destination if member == source else Path(str(destination) + member.name[len(source.name):])
                shutil.copy2(member, target)
                copied.append((member, target))
            after_members = [source] + [candidate for candidate in (Path(str(source) + "-wal"), Path(str(source) + "-shm")) if candidate.is_file()]
            after = {path: _file_signature(path) for path in after_members}
        except OSError:
            after = {}
        if before == after and len(copied) == len(members):
            return [
                {
                    "suffix": "" if member == source else member.name[len(source.name):],
                    "relative_path": target.name,
                    "hash": digest_file(target),
                }
                for member, target in copied
            ]
        for _, target in copied:
            if target.exists():
                target.unlink()
    raise SnapshotError("source database bundle changed during snapshot")


def snapshot_account(account: dict, destination: Path) -> dict:
    destination = Path(destination)
    if destination.exists():
        raise SnapshotError("snapshot destination already exists")
    staging = destination.with_name(f".{destination.name}.staging")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    receipts = []
    targets = set()
    try:
        for item in account.get("databases", []):
            source = Path(item["path"])
            classification = classify_database(source)
            if classification["kind"] == "unknown_or_corrupt":
                raise SnapshotError(f"refusing unknown or corrupt database: {item['db_ref']}")
            relative = Path(item.get("relative_path") or (Path(item["role"]) / source.name))
            if relative.is_absolute() or ".." in relative.parts or not relative.parts:
                raise SnapshotError(f"invalid database relative path: {item['db_ref']}")
            target = staging / relative
            if target in targets:
                raise SnapshotError(f"duplicate database snapshot target: {relative.as_posix()}")
            targets.add(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            if classification["kind"] == "plaintext_sqlite":
                backup_receipt = snapshot_sqlite(source, target)
                sidecars = []
                mode = "sqlite_backup"
                output_hash = backup_receipt["snapshot_hash"]
            else:
                bundle = _stable_bundle_copy(source, target)
                sidecars = [entry for entry in bundle if entry["suffix"]]
                mode = "stable_bundle_copy"
                output_hash = next(entry["hash"] for entry in bundle if not entry["suffix"])
            receipts.append({
                "db_ref": item["db_ref"],
                "role": item["role"],
                "classification": classification["kind"],
                "snapshot_mode": mode,
                "relative_path": str(target.relative_to(staging)),
                "snapshot_hash": output_hash,
                "sidecars": sidecars,
            })
        receipt = {
            "schema_version": "pcd-wechat4-snapshot/v1",
            "account_ref": account["account_ref"],
            "databases": receipts,
        }
        receipt["seal"] = digest_object(receipt)
        write_json(staging / "snapshot.json", receipt)
        os.replace(staging, destination)
        return receipt
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise
