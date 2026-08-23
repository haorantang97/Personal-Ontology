import os
import re
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Callable

from ..authorization import AuthorizationError, AuthorizationStore
from ..atomic import write_json
from ..connectors import snapshot_sqlite
from ..hashing import digest_file, digest_object


class CryptoError(RuntimeError):
    pass


SQLCIPHER4_STANDARD = {
    "profile_id": "sqlcipher4-standard/v1",
    "cipher_page_size": 4096,
    "kdf_iter": 256000,
    "cipher_hmac_algorithm": "HMAC_SHA512",
    "cipher_kdf_algorithm": "PBKDF2_HMAC_SHA512",
}


def validate_user_key(key: str) -> dict:
    normalized = key.strip()
    if not re.fullmatch(r"[0-9a-fA-F]{64}", normalized):
        raise CryptoError("local key must be exactly 32 bytes represented as 64 hexadecimal characters")
    return {"key": normalized.lower(), "format": "hex-32-byte", "length_bytes": 32}


def read_key_file(path: Path, authorizations: AuthorizationStore) -> tuple[str, dict]:
    try:
        authorizations.require("local_key_access")
    except AuthorizationError as exc:
        raise CryptoError(str(exc)) from exc
    path = Path(path)
    if not path.is_file():
        raise CryptoError("key file does not exist")
    if os.name != "nt" and path.stat().st_mode & 0o077:
        raise CryptoError("key file permissions must not allow group or other access")
    parsed = validate_user_key(path.read_text(encoding="utf-8"))
    receipt = {
        "provider": "user-private-file/v1",
        "provider_ref": digest_object({"resolved_path": str(path.resolve())}),
        "key_format": parsed["format"],
        "key_persisted_by_skill": False,
    }
    return parsed["key"], receipt


def _quote_sqlite_literal(value: str) -> str:
    return value.replace("'", "''")


def decrypt_sqlcipher(
    source: Path,
    destination: Path,
    key: str,
    authorizations: AuthorizationStore,
    executable: str = "sqlcipher",
    runner: Callable = subprocess.run,
    profile: dict | None = None,
) -> dict:
    try:
        authorizations.require("local_key_access")
    except AuthorizationError as exc:
        raise CryptoError(str(exc)) from exc
    parsed = validate_user_key(key)
    source = Path(source)
    destination = Path(destination)
    if not source.is_file():
        raise CryptoError("encrypted source does not exist")
    if destination.exists():
        raise CryptoError("decryption destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    profile = dict(SQLCIPHER4_STANDARD if profile is None else profile)
    output_literal = _quote_sqlite_literal(str(destination.resolve()))
    script = "\n".join([
        f"PRAGMA key = \"x'{parsed['key']}'\";",
        f"PRAGMA cipher_page_size = {int(profile['cipher_page_size'])};",
        f"PRAGMA kdf_iter = {int(profile['kdf_iter'])};",
        f"PRAGMA cipher_hmac_algorithm = {profile['cipher_hmac_algorithm']};",
        f"PRAGMA cipher_kdf_algorithm = {profile['cipher_kdf_algorithm']};",
        f"ATTACH DATABASE '{output_literal}' AS plaintext KEY '';",
        "SELECT sqlcipher_export('plaintext');",
        "DETACH DATABASE plaintext;",
        ".quit",
        "",
    ])
    result = runner([executable, str(source.resolve())], input=script, text=True, capture_output=True, check=False)
    if result.returncode != 0 or not destination.is_file():
        if destination.exists():
            destination.unlink()
        raise CryptoError(f"SQLCipher decryption failed with code {result.returncode}")
    try:
        connection = sqlite3.connect(f"file:{destination.resolve()}?mode=ro", uri=True)
        try:
            integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            connection.close()
    except sqlite3.Error as exc:
        destination.unlink()
        raise CryptoError("decrypted output is not readable SQLite") from exc
    if integrity != "ok":
        destination.unlink()
        raise CryptoError(f"decrypted output integrity check failed: {integrity}")
    return {
        "operation": "sqlcipher_export/v1",
        "profile_id": profile["profile_id"],
        "source_hash": digest_file(source),
        "output_hash": digest_file(destination),
        "integrity": "ok",
        "key_format": parsed["format"],
        "key_persisted_by_skill": False,
    }


def decrypt_snapshot(
    snapshot: Path,
    receipt: dict,
    destination: Path,
    key: str,
    authorizations: AuthorizationStore,
    executable: str = "sqlcipher",
    runner: Callable = subprocess.run,
) -> dict:
    authorizations.require("local_key_access")
    snapshot = Path(snapshot).resolve()
    destination = Path(destination)
    if destination.exists():
        raise CryptoError("decrypted snapshot destination already exists")
    staging = destination.with_name(f".{destination.name}.staging")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    databases = []
    try:
        for item in receipt.get("databases", []):
            relative = Path(str(item.get("relative_path", "")))
            source = (snapshot / relative).resolve()
            if snapshot not in source.parents or not source.is_file():
                raise CryptoError("snapshot receipt contains an invalid database path")
            target = staging / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            classification = item.get("classification")
            if classification == "plaintext_sqlite":
                operation = snapshot_sqlite(source, target)
                mode = "sqlite_backup"
            elif classification == "sqlcipher_candidate":
                operation = decrypt_sqlcipher(source, target, key, authorizations, executable=executable, runner=runner)
                mode = "sqlcipher_export"
            else:
                raise CryptoError(f"unsupported database classification: {classification}")
            databases.append({
                "db_ref": item.get("db_ref"),
                "role": item.get("role"),
                "classification": "plaintext_sqlite",
                "relative_path": relative.as_posix(),
                "snapshot_hash": operation.get("output_hash") or operation.get("snapshot_hash"),
                "source_classification": classification,
                "decryption_mode": mode,
                "profile_id": operation.get("profile_id"),
                "sidecars": [],
            })
        output = {
            "schema_version": "pcd-wechat4-snapshot/v1",
            "account_ref": receipt.get("account_ref"),
            "source_snapshot_seal": receipt.get("seal"),
            "databases": databases,
        }
        output["seal"] = digest_object(output)
        write_json(staging / "snapshot.json", output)
        os.replace(staging, destination)
        return output
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise
