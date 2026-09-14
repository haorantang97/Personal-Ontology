import csv
import os
import sqlite3
import subprocess
from pathlib import Path
from typing import Callable

from .authorization import AuthorizationError, AuthorizationStore
from .hashing import digest_file, digest_object


class ConnectorError(RuntimeError):
    pass


def load_csv_rows(path: Path) -> list[dict]:
    path = Path(path)
    if not path.is_file():
        raise ConnectorError("CSV source does not exist")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise ConnectorError("CSV source is empty")
    return rows


def load_sqlite_rows(path: Path, query: str, parameters: tuple = ()) -> list[dict]:
    path = Path(path)
    if not path.is_file():
        raise ConnectorError("SQLite source does not exist")
    normalized_query = query.strip().lower()
    if not normalized_query.startswith(("select ", "with ")):
        raise ConnectorError("SQLite loader accepts read-only SELECT queries only")
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        cursor = connection.execute(query, parameters)
        rows = [dict(row) for row in cursor.fetchall()]
    except sqlite3.Error as exc:
        raise ConnectorError(f"read-only SQLite query failed: {exc}") from exc
    finally:
        connection.close()
    if not rows:
        raise ConnectorError("SQLite query returned no rows")
    return rows


def discover_wechat4_candidates(platform: str, home: Path | None = None, limit: int = 1000) -> dict:
    home = Path.home() if home is None else Path(home)
    if platform == "macos":
        roots = [
            home / "Library" / "Containers" / "com.tencent.xinWeChat" / "Data" / "Documents" / "xwechat_files",
            home / "Library" / "Application Support" / "com.tencent.xinWeChat",
        ]
    elif platform == "windows":
        roots = [
            home / "Documents" / "xwechat_files",
            home / "AppData" / "Roaming" / "Tencent" / "xwechat_files",
        ]
    else:
        raise ConnectorError("only macOS and Windows WeChat 4.x are in scope")
    databases = []
    for root in roots:
        if not root.is_dir() or root.is_symlink():
            continue
        for candidate in root.rglob("*.db"):
            if candidate.is_file() and not candidate.is_symlink():
                databases.append(candidate)
                if len(databases) >= limit:
                    break
        if len(databases) >= limit:
            break
    return {
        "platform": platform,
        "database_candidates": databases,
        "candidate_count": len(databases),
        "scan_limit": limit,
        "validation_status": "pending-field-validation",
        "safe_fallback": "use a user-provided decrypted JSONL/CSV export",
    }


def run_local_key_provider(
    command: list[str],
    authorizations: AuthorizationStore,
    runner: Callable = subprocess.run,
) -> tuple[str, dict]:
    try:
        authorizations.require("local_key_access")
    except AuthorizationError as exc:
        raise ConnectorError(str(exc)) from exc
    if not command:
        raise ConnectorError("key provider command is empty")
    result = runner(command, text=True, capture_output=True, check=False, env=os.environ.copy())
    key = (result.stdout or "").strip()
    if result.returncode != 0 or not key:
        raise ConnectorError(f"local key provider failed with code {result.returncode}")
    if "\n" in key or "\r" in key:
        raise ConnectorError("local key provider returned multiple lines")
    receipt = {
        "operation": "local_key_provider/v1",
        "provider_hash": digest_object({"executable": Path(command[0]).name, "argument_count": len(command)}),
        "key_persisted": False,
        "key_length": len(key),
    }
    return key, receipt


def snapshot_sqlite(source: Path, destination: Path) -> dict:
    source = Path(source)
    destination = Path(destination)
    if not source.is_file():
        raise ConnectorError("SQLite source does not exist")
    if source.resolve() == destination.resolve():
        raise ConnectorError("snapshot destination must differ from source")
    if destination.exists():
        raise ConnectorError("snapshot destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        source_connection = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True)
        destination_connection = sqlite3.connect(destination)
        try:
            source_connection.backup(destination_connection)
            destination_connection.commit()
        finally:
            destination_connection.close()
            source_connection.close()
        check = sqlite3.connect(destination)
        try:
            result = check.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            check.close()
        if result != "ok":
            raise ConnectorError(f"snapshot integrity check failed: {result}")
        return {
            "operation": "sqlite_readonly_backup/v1",
            "source_locator_hash": digest_object({"resolved_path": str(source.resolve())}),
            "snapshot_hash": digest_file(destination),
            "integrity": "ok",
        }
    except Exception:
        if destination.exists():
            destination.unlink()
        raise


def run_external_decryptor(
    command_template: list[str],
    source: Path,
    destination: Path,
    local_key: str,
    authorizations: AuthorizationStore,
    runner: Callable = subprocess.run,
) -> dict:
    try:
        authorizations.require("local_key_access")
    except AuthorizationError as exc:
        raise ConnectorError(str(exc)) from exc
    source = Path(source)
    destination = Path(destination)
    if not source.is_file() or not local_key:
        raise ConnectorError("decryptor needs an existing source and a non-empty local key")
    if destination.exists():
        raise ConnectorError("decryptor destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    command = [part.replace("{input}", str(source)).replace("{output}", str(destination)) for part in command_template]
    if not command or not any("{input}" in part for part in command_template) or not any("{output}" in part for part in command_template):
        raise ConnectorError("decryptor command must bind {input} and {output} exactly once or more")
    if any(local_key in part for part in command):
        raise ConnectorError("local key must never appear in command arguments")
    environment = os.environ.copy()
    environment.pop("PCD_LOCAL_KEY", None)
    result = runner(command, input=local_key + "\n", text=True, capture_output=True, check=False, env=environment)
    if result.returncode != 0 or not destination.is_file():
        if destination.exists():
            destination.unlink()
        raise ConnectorError(f"external decryptor failed with code {result.returncode}")
    return {
        "operation": "external_decryptor/v1",
        "adapter_hash": digest_object({"executable": Path(command[0]).name, "argument_count": len(command)}),
        "source_hash": digest_file(source),
        "output_hash": digest_file(destination),
        "key_persisted": False,
    }
