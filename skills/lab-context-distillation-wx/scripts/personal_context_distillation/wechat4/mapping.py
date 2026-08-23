import hashlib
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from ..hashing import digest_file, digest_object
from ..records import normalize_rows, validate_coverage
from .checkpoint import CheckpointError
from .schema import MESSAGE_TABLE, inspect_snapshot, open_readonly, profile_for, quote_identifier


class MappingError(RuntimeError):
    pass


GROUP_SENDER = re.compile(r"^([^:\r\n]+):(?:\r?\n|\\n)(.*)$", re.DOTALL)


def _select(connection, table: str, fields: dict[str, str]) -> list[dict]:
    selection = ", ".join(
        f"{quote_identifier(column)} AS {quote_identifier(concept)}" for concept, column in fields.items()
    )
    return [dict(row) for row in connection.execute(f"SELECT {selection} FROM {quote_identifier(table)}")]


def _role_databases(snapshot: Path, inventory: dict, role: str):
    for database in inventory["roles"].get(role, []):
        yield database, Path(snapshot) / database["relative_path"]


def _contacts_and_groups(snapshot: Path, inventory: dict, profile: dict) -> tuple[list[dict], list[dict], dict]:
    database, path = next(_role_databases(snapshot, inventory, "contact"))
    with open_readonly(path) as connection:
        contacts = _select(connection, profile["tables"]["contact"], profile["fields"]["contact"])
        rooms = _select(connection, profile["tables"]["room"], profile["fields"]["room"])
        members = _select(connection, profile["tables"]["member"], profile["fields"]["member"])
    by_id = {item["id"]: item for item in contacts}
    groups = []
    for room in rooms:
        group_members = []
        for member in members:
            if member["room_id"] != room["id"] or member["member_id"] not in by_id:
                continue
            contact = by_id[member["member_id"]]
            group_members.append({
                "username": contact["username"],
                "nickname": contact.get("nickname"),
                "room_nickname": member.get("room_nickname"),
            })
        groups.append({"username": room["username"], "members": group_members})
    return contacts, groups, {item["username"]: item for item in contacts}


def _conversations(snapshot: Path, inventory: dict, profile: dict) -> dict[str, str]:
    result = {}
    for _, path in _role_databases(snapshot, inventory, "session"):
        with open_readonly(path) as connection:
            sessions = _select(connection, profile["tables"]["session"], profile["fields"]["session"])
        for session in sessions:
            username = str(session["username"])
            result["Msg_" + hashlib.md5(username.encode("utf-8")).hexdigest()] = username
    return result


def _media_index(media_roots: list[Path]) -> tuple[list[dict], dict[str, dict]]:
    media = []
    by_name = {}
    for root_number, root_value in enumerate(media_roots):
        root = Path(root_value)
        if not root.is_dir() or root.is_symlink():
            continue
        for path in sorted(root.rglob("*"), key=lambda item: str(item).lower()):
            if not path.is_file() or path.is_symlink():
                continue
            suffix = path.suffix.lower()
            if suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".dat"}:
                kind = "image"
            elif suffix in {".silk", ".aud", ".wav", ".m4a", ".mp3"}:
                kind = "voice"
            elif suffix in {".mp4", ".mov", ".avi", ".mkv"}:
                kind = "video"
            else:
                kind = "attachment"
            entry = {
                "media_ref": "media_" + digest_object({"root": root_number, "relative": path.relative_to(root).as_posix()})[:20],
                "basename": path.name,
                "kind": kind,
                "content_hash": digest_file(path),
                "size": path.stat().st_size,
            }
            media.append(entry)
            by_name[path.name.lower()] = entry
    return media, by_name


def _xml_root(content: str):
    if not content.lstrip().startswith("<"):
        return None
    try:
        return ET.fromstring(content)
    except ET.ParseError:
        return None


def _message_content(local_type: int, raw: str, media_by_name: dict[str, dict]) -> dict:
    parsed = {
        "text": raw,
        "quoted_text": "",
        "quoted_author": None,
        "forwarded_context": "",
        "message_kind": "text",
        "media_refs": [],
        "media_expected": False,
        "evidence_precision": "verbatim",
    }
    root = _xml_root(raw)
    candidates = []
    if local_type == 3:
        parsed["message_kind"] = "image"
        parsed["media_expected"] = True
        parsed["text"] = ""
        parsed["evidence_precision"] = "metadata_only"
        if root is not None:
            image = root.find(".//img")
            if image is not None:
                candidates.extend([image.get("filename", ""), image.get("md5", "")])
    elif local_type == 34:
        parsed["message_kind"] = "voice"
        parsed["media_expected"] = True
        parsed["text"] = ""
        parsed["evidence_precision"] = "metadata_only"
        if root is not None:
            voice = root.find(".//voicemsg")
            if voice is not None:
                candidates.append(voice.get("filename", ""))
    elif local_type == 49 and root is not None:
        parsed["evidence_precision"] = "parsed_structure"
        app_type = root.findtext(".//appmsg/type", "")
        title = root.findtext(".//appmsg/title", "") or ""
        description = root.findtext(".//appmsg/des", "") or ""
        if app_type == "57":
            parsed["message_kind"] = "quote"
            parsed["text"] = title
            parsed["quoted_text"] = root.findtext(".//refermsg/content", "") or ""
            parsed["quoted_author"] = root.findtext(".//refermsg/displayname")
        elif app_type == "6":
            parsed["message_kind"] = "attachment"
            parsed["media_expected"] = True
            parsed["text"] = description
            candidates.append(title)
        elif app_type == "19":
            parsed["message_kind"] = "forward"
            parsed["text"] = title
            parsed["forwarded_context"] = description
        else:
            parsed["message_kind"] = "app"
            parsed["text"] = title or description
    for candidate in candidates:
        if not candidate:
            continue
        match = media_by_name.get(Path(candidate).name.lower())
        if match and match["media_ref"] not in parsed["media_refs"]:
            parsed["media_refs"].append(match["media_ref"])
    return parsed


def _watermark_after(row: dict, watermark: dict | None) -> bool:
    if not watermark:
        return True
    current = (int(row["sort_seq"]), int(row["local_id"]))
    prior = (int(watermark.get("last_sort_seq", -1)), int(watermark.get("last_local_id", -1)))
    return current > prior


def _messages(snapshot: Path, inventory: dict, profile: dict, self_username: str, contact_by_username: dict,
              media_by_name: dict, checkpoint: dict | None) -> tuple[list[dict], dict]:
    conversations = _conversations(snapshot, inventory, profile)
    source_rows = []
    new_watermarks = dict((checkpoint or {}).get("watermarks", {}))
    for database, path in _role_databases(snapshot, inventory, "message"):
        with open_readonly(path) as connection:
            for table in database["tables"]:
                if not MESSAGE_TABLE.fullmatch(table):
                    continue
                conversation = conversations.get(table)
                if conversation is None:
                    raise MappingError(f"message table has no matching session: {table}")
                key = f"{database['db_ref']}/{table}"
                rows = _select(connection, table, profile["fields"]["message"])
                rows.sort(key=lambda item: (int(item["sort_seq"]), int(item["local_id"])))
                for row in rows:
                    if not _watermark_after(row, (checkpoint or {}).get("watermarks", {}).get(key)):
                        continue
                    raw = str(row.get("message_content") or "")
                    sender = str(row.get("sender_id") or "")
                    if conversation.endswith("@chatroom") and not int(row.get("is_sender") or 0):
                        group = GROUP_SENDER.match(raw)
                        if group:
                            sender, raw = group.group(1), group.group(2)
                    elif int(row.get("is_sender") or 0):
                        sender = self_username
                    parsed = _message_content(int(row.get("local_type") or 0), raw, media_by_name)
                    source_rows.append({
                        "source": database["db_ref"], "shard": table, "row_id": str(row["local_id"]),
                        "timestamp": int(row["create_time"]), "platform": "wechat",
                        "conversation_id": conversation, "sender_id": sender, "self_id": self_username,
                        "kind": parsed["message_kind"], "text": parsed["text"],
                        "quoted_text": parsed["quoted_text"], "quoted_author": parsed["quoted_author"],
                        "forwarded_context": parsed["forwarded_context"],
                        "media_type": parsed["message_kind"] if parsed["media_expected"] else None,
                        "media_refs": parsed["media_refs"], "media_available": bool(parsed["media_refs"]),
                        "media_expected": parsed["media_expected"],
                        "transcript_available": False if parsed["message_kind"] == "voice" else None,
                        "ordering_basis": {"sort_seq": int(row["sort_seq"]), "local_id": int(row["local_id"])},
                        "ordering_certainty": "within_shard_stable_cross_shard_uncertain",
                        "evidence_precision": parsed["evidence_precision"],
                        "sender_display": (contact_by_username.get(sender) or {}).get("nickname"),
                    })
                if rows:
                    final = rows[-1]
                    previous = new_watermarks.get(key, {})
                    if (int(final["sort_seq"]), int(final["local_id"])) > (
                        int(previous.get("last_sort_seq", -1)), int(previous.get("last_local_id", -1))
                    ):
                        new_watermarks[key] = {"last_sort_seq": int(final["sort_seq"]), "last_local_id": int(final["local_id"])}
    source_rows.sort(key=lambda item: (item["timestamp"], item["source"], item["shard"], int(item["row_id"])))
    return source_rows, new_watermarks


def _optional(snapshot: Path, inventory: dict, profile: dict, capability: str, self_username: str,
              checkpoint: dict | None, watermarks: dict) -> tuple[dict, list[dict], list[dict], dict]:
    status = inventory["capabilities"][capability]
    databases = inventory["roles"].get(capability, [])
    tables = sorted({table for database in databases for table in database["tables"]})
    if status == "not-present":
        return {"status": "not_present", "tables": []}, [], [], watermarks
    if status == "present-unmapped":
        return {"status": "present_unmapped", "tables": tables}, [], [], watermarks
    mapped = []
    source_rows = []
    table = profile["tables"][capability]
    for database, path in _role_databases(snapshot, inventory, capability):
        with open_readonly(path) as connection:
            rows = _select(connection, table, profile["fields"][capability])
            rows.sort(key=lambda item: (int(item["create_time"]), int(item["local_id"])))
            key = f"{database['db_ref']}/{table}"
            for row in rows:
                cursor_row = {"sort_seq": int(row["create_time"]), "local_id": int(row["local_id"])}
                if not _watermark_after(cursor_row, (checkpoint or {}).get("watermarks", {}).get(key)):
                    continue
                item = dict(row)
                if capability == "sns":
                    try:
                        item["media"] = json.loads(item.pop("media_json") or "[]")
                    except (TypeError, json.JSONDecodeError):
                        item["media"] = []
                    item["author_scope"] = "self" if item.get("author_username") == self_username else "other"
                    sender = str(item.get("author_username") or "")
                    text = str(item.get("content") or "")
                    kind = "moment"
                    conversation = "wechat:sns"
                else:
                    sender = str(item.get("source_username") or "")
                    text = "\n".join(part for part in (str(item.get("title") or ""), str(item.get("content") or "")) if part)
                    kind = "favorite"
                    conversation = "wechat:favorite"
                mapped.append(item)
                source_rows.append({
                    "source": database["db_ref"], "shard": table, "row_id": str(row["local_id"]),
                    "timestamp": int(row["create_time"]), "platform": "wechat",
                    "conversation_id": conversation, "sender_id": sender, "self_id": self_username,
                    "kind": kind, "text": text, "quoted_text": "", "quoted_author": None,
                    "forwarded_context": "", "media_type": None, "media_refs": [],
                    "media_available": False, "media_expected": False, "transcript_available": None,
                    "ordering_basis": {"sort_seq": int(row["create_time"]), "local_id": int(row["local_id"])},
                    "ordering_certainty": "within_source_stable_cross_source_uncertain",
                    "evidence_precision": "parsed_structure",
                })
            if rows:
                final = rows[-1]
                previous = watermarks.get(key, {})
                if (int(final["create_time"]), int(final["local_id"])) > (
                    int(previous.get("last_sort_seq", -1)), int(previous.get("last_local_id", -1))
                ):
                    watermarks[key] = {"last_sort_seq": int(final["create_time"]), "last_local_id": int(final["local_id"])}
    return {"status": "mapped", "tables": [table], "count": len(mapped)}, mapped, source_rows, watermarks


def map_snapshot(snapshot: Path, receipt: dict, platform: str, self_username: str,
                 media_roots: list[Path] | None = None, checkpoint: dict | None = None) -> dict:
    if not self_username:
        raise MappingError("self username is required for authorship classification")
    inventory = inspect_snapshot(snapshot, receipt, platform)
    if checkpoint and checkpoint.get("schema_fingerprint") != inventory["schema_fingerprint"]:
        raise CheckpointError("schema fingerprint changed; incremental checkpoint cannot be reused")
    profile = profile_for(platform)
    contacts, groups, contact_by_username = _contacts_and_groups(Path(snapshot), inventory, profile)
    media_index, media_by_name = _media_index(media_roots or [])
    message_rows, watermarks = _messages(
        Path(snapshot), inventory, profile, self_username, contact_by_username, media_by_name, checkpoint
    )
    favorite_capability, favorites, favorite_rows, watermarks = _optional(
        Path(snapshot), inventory, profile, "favorite", self_username, checkpoint, watermarks
    )
    sns_capability, moments, moment_rows, watermarks = _optional(
        Path(snapshot), inventory, profile, "sns", self_username, checkpoint, watermarks
    )
    source_rows = sorted(message_rows + favorite_rows + moment_rows,
                         key=lambda item: (item["timestamp"], item["source"], item["shard"], int(item["row_id"])))
    records = normalize_rows(source_rows)
    validate_coverage(source_rows, records)
    expected_media = [row for row in message_rows if row.get("media_expected")]
    available_media = [row for row in expected_media if row.get("media_available")]
    return {
        "schema_version": "pcd-wechat4-mapping/v1",
        "account_ref": receipt.get("account_ref"),
        "schema_profile": inventory["profile_id"],
        "schema_fingerprint": inventory["schema_fingerprint"],
        "contacts": contacts,
        "groups": groups,
        "source_rows": source_rows,
        "records": records,
        "media_index": media_index,
        "media_coverage": {
            "expected_messages": len(expected_media),
            "available_messages": len(available_media),
            "missing_messages": len(expected_media) - len(available_media),
        },
        "favorites": favorites,
        "moments": moments,
        "optional_capabilities": {"favorite": favorite_capability, "sns": sns_capability},
        "checkpoint_proposal": {
            "schema_version": "pcd-wechat4-checkpoint-proposal/v1",
            "account_ref": receipt.get("account_ref"),
            "schema_fingerprint": inventory["schema_fingerprint"],
            "watermarks": watermarks,
            "based_on": checkpoint.get("seal") if checkpoint else None,
        },
    }
