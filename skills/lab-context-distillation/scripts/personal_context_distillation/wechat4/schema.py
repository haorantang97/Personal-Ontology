import re
import sqlite3
from pathlib import Path

from ..hashing import digest_object


class SchemaError(RuntimeError):
    pass


MESSAGE_TABLE = re.compile(r"^Msg_[0-9a-f]{32}$")

PROFILES = {
    "macos": {
        "profile_id": "wechat4-macos-observed-v1",
        "tables": {
            "contact": "contact",
            "room": "chat_room",
            "member": "chatroom_member",
            "session": "SessionTable",
            "favorite": "FavoriteItem",
            "sns": "SnsFeed",
        },
        "fields": {
            "contact": {"id": "id", "username": "username", "nickname": "nick_name", "remark": "remark", "alias": "alias"},
            "room": {"id": "id", "username": "username"},
            "member": {"room_id": "room_id", "member_id": "member_id", "room_nickname": "room_nickname"},
            "session": {"username": "username"},
            "message": {
                "local_id": "local_id", "server_id": "server_id", "create_time": "create_time",
                "sort_seq": "sort_seq", "local_type": "local_type", "sender_id": "real_sender_id",
                "message_content": "message_content", "source": "source", "is_sender": "is_sender",
            },
            "favorite": {"local_id": "local_id", "create_time": "create_time", "title": "title", "content": "content", "source_username": "source_username"},
            "sns": {"local_id": "local_id", "create_time": "create_time", "author_username": "author_username", "content": "content", "media_json": "media_json"},
        },
    },
    "windows": {
        "profile_id": "wechat4-windows-observed-v1",
        "tables": {
            "contact": "Contact",
            "room": "ChatRoom",
            "member": "ChatRoomMember",
            "session": "SessionTable",
            "favorite": "FavoriteItem",
            "sns": "SnsFeed",
        },
        "fields": {
            "contact": {"id": "contactId", "username": "userName", "nickname": "nickName", "remark": "remarkName", "alias": "aliasName"},
            "room": {"id": "roomId", "username": "userName"},
            "member": {"room_id": "roomId", "member_id": "memberId", "room_nickname": "roomNickName"},
            "session": {"username": "userName"},
            "message": {
                "local_id": "localId", "server_id": "serverId", "create_time": "createTime",
                "sort_seq": "sortSeq", "local_type": "localType", "sender_id": "senderId",
                "message_content": "content", "source": "source", "is_sender": "isSend",
            },
            "favorite": {"local_id": "localId", "create_time": "createTime", "title": "title", "content": "content", "source_username": "sourceUserName"},
            "sns": {"local_id": "localId", "create_time": "createTime", "author_username": "authorUserName", "content": "content", "media_json": "mediaJson"},
        },
    },
}


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def _snapshot_path(snapshot: Path, relative: str) -> Path:
    root = Path(snapshot).resolve()
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise SchemaError("snapshot receipt contains a path outside the snapshot")
    if not candidate.is_file():
        raise SchemaError(f"snapshot database is missing: {relative}")
    return candidate


def open_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def _database_schema(path: Path) -> dict[str, list[str]]:
    try:
        with open_readonly(path) as connection:
            rows = connection.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            ).fetchall()
            result = {}
            for row in rows:
                table = row["name"]
                columns = connection.execute(f"PRAGMA table_info({quote_identifier(table)})").fetchall()
                result[table] = [column["name"] for column in columns]
            return result
    except sqlite3.DatabaseError as exc:
        raise SchemaError(f"cannot inspect plaintext snapshot: {path.name}: {exc}") from exc


def _require_fields(columns: list[str], fields: dict[str, str], location: str) -> None:
    missing = [concept for concept, concrete in fields.items() if concrete not in columns]
    if missing:
        raise SchemaError(f"schema drift at {location}; missing required field(s): {', '.join(missing)}")


def inspect_snapshot(snapshot: Path, receipt: dict, platform: str) -> dict:
    if platform not in PROFILES:
        raise SchemaError("only macOS and Windows WeChat 4.x profiles are supported")
    profile = PROFILES[platform]
    roles: dict[str, list[dict]] = {}
    structural = []
    for item in receipt.get("databases", []):
        if item.get("classification") != "plaintext_sqlite":
            raise SchemaError(f"database {item.get('db_ref', 'unknown')} must be decrypted before schema inspection")
        path = _snapshot_path(Path(snapshot), str(item.get("relative_path", "")))
        tables = _database_schema(path)
        entry = {
            "db_ref": str(item.get("db_ref", "")),
            "relative_path": str(item.get("relative_path", "")),
            "tables": sorted(tables),
            "columns": {name: tables[name] for name in sorted(tables)},
        }
        role = str(item.get("role", "unknown"))
        roles.setdefault(role, []).append(entry)
        structural.append({"role": role, "tables": entry["columns"]})

    required_roles = ("contact", "session", "message")
    missing_roles = [role for role in required_roles if not roles.get(role)]
    if missing_roles:
        raise SchemaError(f"snapshot is missing required database role(s): {', '.join(missing_roles)}")

    contact_tables = roles["contact"][0]["columns"]
    for concept in ("contact", "room", "member"):
        table = profile["tables"][concept]
        if table not in contact_tables:
            raise SchemaError(f"contact schema is missing required table: {concept}")
        _require_fields(contact_tables[table], profile["fields"][concept], f"contact/{table}")

    session_tables = roles["session"][0]["columns"]
    session_table = profile["tables"]["session"]
    if session_table not in session_tables:
        raise SchemaError("session schema is missing required table: session")
    _require_fields(session_tables[session_table], profile["fields"]["session"], f"session/{session_table}")

    message_count = 0
    for database in roles["message"]:
        for table, columns in database["columns"].items():
            if MESSAGE_TABLE.fullmatch(table):
                _require_fields(columns, profile["fields"]["message"], f"message/{table}")
                message_count += 1
    if not message_count:
        raise SchemaError("message schema has no recognized Msg_<md5> table")

    capabilities = {}
    for capability in ("favorite", "sns"):
        databases = roles.get(capability, [])
        if not databases:
            capabilities[capability] = "not-present"
        elif any(profile["tables"][capability] in item["tables"] for item in databases):
            capabilities[capability] = "mapped-profile"
        else:
            capabilities[capability] = "present-unmapped"

    return {
        "schema_version": "pcd-wechat4-schema/v1",
        "profile_id": profile["profile_id"],
        "schema_fingerprint": digest_object(sorted(structural, key=lambda item: (item["role"], str(item["tables"])))),
        "roles": roles,
        "capabilities": capabilities,
    }


def profile_for(platform: str) -> dict:
    try:
        return PROFILES[platform]
    except KeyError as exc:
        raise SchemaError("unsupported WeChat 4.x platform profile") from exc
