from pathlib import Path

from ..atomic import read_json, write_private_json
from ..hashing import digest_object


class DiscoveryError(RuntimeError):
    pass


ROLE_ALIASES = {
    "msg": "message",
    "message": "message",
    "contact": "contact",
    "session": "session",
    "hardlink": "hardlink",
    "favorite": "favorite",
    "favorites": "favorite",
    "sns": "sns",
    "media": "media",
    "general": "general",
    "head_image": "head_image",
    "emoticon": "emoticon",
    "bizchat": "bizchat",
    "mmkv": "mmkv",
}


def _default_roots(platform: str, home: Path) -> list[Path]:
    if platform == "macos":
        return [
            home / "Library" / "Containers" / "com.tencent.xinWeChat" / "Data" / "Documents" / "xwechat_files",
            home / "Library" / "Group Containers" / "5A4RE8SF68.com.tencent.xinWeChat" / "xwechat_files",
            home / "Documents" / "WeChat Files" / "xwechat_files",
        ]
    if platform == "windows":
        return [
            home / "Documents" / "WeChat Files" / "xwechat_files",
            home / "Documents" / "Weixin Files" / "xwechat_files",
            home / "AppData" / "Roaming" / "Tencent" / "WeChat" / "xwechat_files",
        ]
    raise DiscoveryError("only macOS and Windows WeChat 4.x are supported")


def _account_candidates(root: Path) -> list[Path]:
    if root.is_symlink() or not root.is_dir():
        return []
    if (root / "db_storage").is_dir():
        return [root]
    candidates = []
    for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
        if child.is_dir() and not child.is_symlink() and (child / "db_storage").is_dir():
            candidates.append(child)
    return candidates


def _database_inventory(account_path: Path, account_ref: str, limit: int) -> list[dict]:
    storage = account_path / "db_storage"
    inventory = []
    for database in sorted(storage.rglob("*.db"), key=lambda item: str(item).lower()):
        if database.is_symlink() or not database.is_file():
            continue
        relative = database.relative_to(storage)
        role = ROLE_ALIASES.get(relative.parts[0].lower(), "unknown") if relative.parts else "unknown"
        inventory.append({
            "db_ref": "db_" + digest_object({"account_ref": account_ref, "relative": relative.as_posix()})[:20],
            "role": role,
            "relative_path": relative.as_posix(),
            "path": str(database.resolve()),
        })
        if len(inventory) >= limit:
            break
    return inventory


def discover_accounts(
    platform: str,
    home: Path | None = None,
    roots: list[Path] | None = None,
    database_limit_per_account: int = 5000,
) -> dict:
    home = Path.home() if home is None else Path(home)
    search_roots = _default_roots(platform, home) + [Path(item) for item in (roots or [])]
    seen = set()
    accounts = []
    for root in search_roots:
        for account_path in _account_candidates(root):
            resolved = account_path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            account_ref = "acct_" + digest_object({"platform": platform, "account_path": str(resolved)})[:20]
            databases = _database_inventory(resolved, account_ref, database_limit_per_account)
            if not databases:
                continue
            media_roots = []
            for name in ("msg", "FileStorage", "file_storage", "media"):
                candidate = resolved / name
                if candidate.is_dir() and not candidate.is_symlink():
                    media_roots.append(str(candidate.resolve()))
            accounts.append({
                "account_ref": account_ref,
                "platform": platform,
                "account_path": str(resolved),
                "db_storage_path": str((resolved / "db_storage").resolve()),
                "databases": databases,
                "media_roots": media_roots,
            })
    return {
        "schema_version": "pcd-wechat4-discovery/v1",
        "platform": platform,
        "accounts": sorted(accounts, key=lambda item: item["account_ref"]),
        "searched_root_count": len(search_roots),
        "field_validation": "pending-real-device",
    }


def persist_source_registry(case_root: Path, report: dict) -> dict:
    registry_path = Path(case_root) / "local" / "wechat4-source-registry.json"
    registry = {
        "schema_version": "pcd-wechat4-source-registry/v1",
        "platform": report["platform"],
        "accounts": report["accounts"],
    }
    write_private_json(registry_path, registry)
    return {
        "platform": report["platform"],
        "account_refs": [item["account_ref"] for item in report["accounts"]],
        "account_count": len(report["accounts"]),
        "database_count": sum(len(item["databases"]) for item in report["accounts"]),
        "registry_hash": digest_object(registry),
    }


def load_registered_account(case_root: Path, account_ref: str) -> dict:
    registry_path = Path(case_root) / "local" / "wechat4-source-registry.json"
    if not registry_path.is_file():
        raise DiscoveryError("WeChat 4.x source registry does not exist")
    registry = read_json(registry_path)
    for account in registry.get("accounts", []):
        if account.get("account_ref") == account_ref:
            return account
    raise DiscoveryError(f"unknown account reference: {account_ref}")
