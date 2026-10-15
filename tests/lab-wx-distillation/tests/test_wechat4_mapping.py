import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.wechat4.checkpoint import CheckpointError, CheckpointStore
from personal_context_distillation.wechat4.mapping import MappingError, map_snapshot
from personal_context_distillation.wechat4.schema import SchemaError, inspect_snapshot


FIXTURES = Path(__file__).parent / "fixtures" / "wechat4"
SELF = "wxid_self_fixture"
FRIEND = "wxid_friend_fixture"
ROOM = "room_fixture@chatroom"


def msg_table(talker: str) -> str:
    return "Msg_" + hashlib.md5(talker.encode("utf-8")).hexdigest()


def execute_fixture(path: Path, sql_path: Path, **values) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    script = sql_path.read_text().format(**values)
    connection = sqlite3.connect(path)
    connection.executescript(script)
    connection.commit()
    connection.close()


def build_snapshot(root: Path, platform: str, include_optional: bool = True) -> tuple[Path, dict, list[Path]]:
    fixture = FIXTURES / platform
    snapshot = root / "snapshot"
    databases = []
    specifications = [
        ("contact", "contact.db", "contact.sql"),
        ("session", "session.db", "session.sql"),
        ("message", "message_0.db", "message.sql"),
    ]
    if include_optional and platform == "macos":
        specifications.extend([
            ("favorite", "favorite.db", "favorite.sql"),
            ("sns", "sns.db", "sns.sql"),
        ])
    for role, filename, sql_name in specifications:
        path = snapshot / role / filename
        execute_fixture(path, fixture / sql_name, DIRECT_TABLE=msg_table(FRIEND), GROUP_TABLE=msg_table(ROOM))
        databases.append({
            "db_ref": f"db_{role}",
            "role": role,
            "classification": "plaintext_sqlite",
            "relative_path": f"{role}/{filename}",
            "snapshot_hash": "synthetic",
            "sidecars": [],
        })
    media_root = root / "account" / "msg" / "attach"
    media_root.mkdir(parents=True)
    media_files = [
        media_root / "synthetic-image.jpg",
        media_root / "synthetic-voice.silk",
        media_root / "fixture-document.pdf",
    ]
    for media in media_files:
        media.write_bytes(("fixture:" + media.name).encode())
    receipt = {"schema_version": "pcd-wechat4-snapshot/v1", "account_ref": "acct_fixture", "databases": databases, "seal": "fixture"}
    return snapshot, receipt, [media_root]


class WeChat4SchemaTests(unittest.TestCase):
    def test_macos_profile_is_selected_from_executable_schema_fingerprint(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot, receipt, _ = build_snapshot(Path(temp), "macos")
            inventory = inspect_snapshot(snapshot, receipt, "macos")
            self.assertEqual(inventory["profile_id"], "wechat4-macos-observed-v1")
            self.assertRegex(inventory["schema_fingerprint"], r"^[0-9a-f]{64}$")
            self.assertIn(msg_table(FRIEND), inventory["roles"]["message"][0]["tables"])
            self.assertEqual(inventory["capabilities"]["favorite"], "mapped-profile")
            self.assertEqual(inventory["capabilities"]["sns"], "mapped-profile")

    def test_windows_camel_case_profile_is_selected(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot, receipt, _ = build_snapshot(Path(temp), "windows", include_optional=False)
            inventory = inspect_snapshot(snapshot, receipt, "windows")
            self.assertEqual(inventory["profile_id"], "wechat4-windows-observed-v1")
            self.assertEqual(inventory["capabilities"]["favorite"], "not-present")

    def test_required_column_drift_fails_with_schema_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot, receipt, _ = build_snapshot(Path(temp), "macos")
            message_db = snapshot / "message" / "message_0.db"
            connection = sqlite3.connect(message_db)
            connection.execute(f'ALTER TABLE "{msg_table(FRIEND)}" RENAME COLUMN message_content TO changed_content')
            connection.commit()
            connection.close()
            with self.assertRaises(SchemaError) as context:
                inspect_snapshot(snapshot, receipt, "macos")
            self.assertIn("message_content", str(context.exception))


class WeChat4MappingTests(unittest.TestCase):
    def test_macos_maps_messages_contacts_groups_quotes_media_and_optional_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot, receipt, media_roots = build_snapshot(Path(temp), "macos")
            result = map_snapshot(snapshot, receipt, "macos", self_username=SELF, media_roots=media_roots)
            self.assertEqual(len(result["contacts"]), 4)
            self.assertEqual(len(result["groups"]), 1)
            self.assertEqual(result["groups"][0]["members"][0]["username"], "wxid_member_fixture")
            self.assertEqual(len(result["source_rows"]), 9)
            self.assertEqual(len(result["records"]), 9)

            group_row = next(row for row in result["source_rows"] if row["text"] == "Group-authored fixture")
            self.assertEqual(group_row["sender_id"], "wxid_member_fixture")
            self.assertEqual(group_row["conversation_id"], ROOM)

            quote = next(record for record in result["records"] if record["authored_text"] == "My reply")
            self.assertEqual(quote["quoted_text"], "Quoted fixture")
            self.assertEqual(quote["quoted_author"], "Friend Fixture")
            self.assertEqual(quote["evidence_precision"], "parsed_structure")
            self.assertEqual(quote["ordering_certainty"], "within_shard_stable_cross_shard_uncertain")

            image = next(record for record in result["records"] if record["message_kind"] == "image")
            voice = next(record for record in result["records"] if record["message_kind"] == "voice")
            attachment = next(record for record in result["records"] if record["message_kind"] == "attachment")
            self.assertTrue(image["media_available"])
            self.assertTrue(voice["media_available"])
            self.assertTrue(attachment["media_available"])
            self.assertFalse(voice["transcript_available"])
            self.assertEqual(len(result["media_index"]), 3)
            self.assertEqual(result["media_coverage"], {"expected_messages": 3, "available_messages": 3, "missing_messages": 0})
            self.assertEqual(result["optional_capabilities"]["favorite"]["status"], "mapped")
            self.assertEqual(result["optional_capabilities"]["sns"]["status"], "mapped")
            self.assertEqual(len(result["favorites"]), 1)
            self.assertEqual(len(result["moments"]), 1)
            self.assertEqual(len([record for record in result["records"] if record["message_kind"] == "favorite"]), 1)
            self.assertEqual(len([record for record in result["records"] if record["message_kind"] == "moment"]), 1)

    def test_missing_media_is_counted_in_denominator_without_exposing_a_private_path(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot, receipt, media_roots = build_snapshot(Path(temp), "macos")
            (media_roots[0] / "synthetic-voice.silk").unlink()
            result = map_snapshot(snapshot, receipt, "macos", self_username=SELF, media_roots=media_roots)
            self.assertEqual(result["media_coverage"], {"expected_messages": 3, "available_messages": 2, "missing_messages": 1})
            voice = next(record for record in result["records"] if record["message_kind"] == "voice")
            self.assertFalse(voice["media_available"])
            self.assertNotIn(str(Path(temp)), json.dumps(result["media_coverage"]))

    def test_windows_aliases_map_to_same_unified_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot, receipt, media_roots = build_snapshot(Path(temp), "windows", include_optional=False)
            result = map_snapshot(snapshot, receipt, "windows", self_username=SELF, media_roots=media_roots)
            self.assertEqual(len(result["records"]), 3)
            self.assertEqual([record["direction"] for record in result["records"]], ["self", "other", "other"])
            self.assertEqual(result["schema_profile"], "wechat4-windows-observed-v1")
            self.assertEqual(result["optional_capabilities"]["favorite"]["status"], "not_present")
            self.assertEqual(result["optional_capabilities"]["sns"]["status"], "not_present")

    def test_optional_database_with_unknown_tables_is_reported_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as temp:
            snapshot, receipt, media_roots = build_snapshot(Path(temp), "windows", include_optional=False)
            favorite = snapshot / "favorite" / "favorite.db"
            favorite.parent.mkdir()
            connection = sqlite3.connect(favorite)
            connection.execute("CREATE TABLE UnknownFavoriteShape(id INTEGER PRIMARY KEY, payload BLOB)")
            connection.commit()
            connection.close()
            receipt["databases"].append({"db_ref": "db_favorite", "role": "favorite", "classification": "plaintext_sqlite",
                                         "relative_path": "favorite/favorite.db", "snapshot_hash": "synthetic", "sidecars": []})
            result = map_snapshot(snapshot, receipt, "windows", self_username=SELF, media_roots=media_roots)
            capability = result["optional_capabilities"]["favorite"]
            self.assertEqual(capability["status"], "present_unmapped")
            self.assertEqual(capability["tables"], ["UnknownFavoriteShape"])

    def test_incremental_checkpoint_emits_only_new_rows_and_rejects_schema_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            snapshot, receipt, media_roots = build_snapshot(root, "windows", include_optional=False)
            store = CheckpointStore(root / "case", "acct_fixture")
            first = map_snapshot(snapshot, receipt, "windows", self_username=SELF, media_roots=media_roots, checkpoint=store.load())
            self.assertEqual(len(first["records"]), 3)
            committed = store.commit(first["checkpoint_proposal"], release_seal="release-one")
            self.assertRegex(committed["seal"], r"^[0-9a-f]{64}$")

            message_db = snapshot / "message" / "message_0.db"
            connection = sqlite3.connect(message_db)
            connection.execute(
                f'INSERT INTO "{msg_table(FRIEND)}" VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (3, "srv-w3", 1700000002, 102, 1, FRIEND, "Incremental fixture", "", 0),
            )
            connection.commit()
            connection.close()
            second = map_snapshot(snapshot, receipt, "windows", self_username=SELF, media_roots=media_roots, checkpoint=store.load())
            self.assertEqual([record["authored_text"] for record in second["records"]], ["Incremental fixture"])
            store.commit(second["checkpoint_proposal"], release_seal="release-two")
            third = map_snapshot(snapshot, receipt, "windows", self_username=SELF, media_roots=media_roots, checkpoint=store.load())
            self.assertEqual(third["records"], [])

            connection = sqlite3.connect(message_db)
            connection.execute(f'ALTER TABLE "{msg_table(FRIEND)}" ADD COLUMN drifted INTEGER')
            connection.commit()
            connection.close()
            with self.assertRaises(CheckpointError):
                map_snapshot(snapshot, receipt, "windows", self_username=SELF, media_roots=media_roots, checkpoint=store.load())


if __name__ == "__main__":
    unittest.main()
