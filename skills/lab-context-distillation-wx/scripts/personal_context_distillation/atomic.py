import json
import os
from pathlib import Path
from typing import Any

from .hashing import canonical_json


class AtomicWriteError(RuntimeError):
    pass


def append_jsonl(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = canonical_json(value) + "\n"
    with path.open("a", encoding="utf-8") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def write_once_json(path: Path, value: Any) -> dict[str, Any]:
    """Create one shared artifact, allowing only an identical idempotent replay."""
    path = Path(path)
    if path.exists():
        existing = read_json(path)
        if existing != value:
            raise AtomicWriteError(f"immutable shared artifact differs: {path.name}")
        return {"idempotent": True, "content": existing}
    write_json(path, value)
    return {"idempotent": True, "content": value}


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        stream = os.fdopen(descriptor, "w", encoding="utf-8")
        with stream as handle:
            handle.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        if temporary.exists():
            temporary.unlink()
        raise
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def read_json(path: Path) -> Any:
    payload = Path(path).read_text(encoding="utf-8")
    return json.loads(payload)
