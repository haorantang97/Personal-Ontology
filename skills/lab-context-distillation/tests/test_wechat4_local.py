import json
import os
import re
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import shutil

from personal_context_distillation.authorization import AuthorizationStore
from personal_context_distillation.wechat4.crypto import (
    CryptoError,
    decrypt_snapshot,
    decrypt_sqlcipher,
    read_key_file,
    validate_user_key,
)
from personal_context_distillation.wechat4.discovery import (
    DiscoveryError,
    discover_accounts,
    load_registered_account,
    persist_source_registry,
)
from personal_context_distillation.wechat4.snapshot import (
    SnapshotError,
    classify_database,
    snapshot_account,
)


def create_plain_database(path: Path, value: str = "synthetic") -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT)")
    connection.execute("INSERT INTO sample(value) VALUES (?)", (value,))
    connection.commit()
    return connection


class WeChat4DiscoveryTests(unittest.TestCase):
    def test_macos_discovers_accounts_and_classifies_source_roles(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            root = home / "Library" / "Containers" / "com.tencent.xinWeChat" / "Data" / "Documents" / "xwechat_files"
            account = root / "wxid_synthetic_1001"
            for relative in ("message/message_0.db", "contact/contact.db", "session/session.db", "favorite/favorite.db", "sns/sns.db"):
                path = account / "db_storage" / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture")
            (root / "not-an-account").mkdir(parents=True)

            report = discover_accounts("macos", home=home)
            self.assertEqual(report["platform"], "macos")
            self.assertEqual(len(report["accounts"]), 1)
            discovered = report["accounts"][0]
            self.assertRegex(discovered["account_ref"], r"^acct_[0-9a-f]{20}$")
            self.assertEqual({item["role"] for item in discovered["databases"]}, {"message", "contact", "session", "favorite", "sns"})
            self.assertTrue(all("path" in item for item in discovered["databases"]))

    def test_windows_supports_default_and_explicit_account_roots(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "home"
            default_account = home / "Documents" / "WeChat Files" / "xwechat_files" / "wxid_win_synthetic_1001"
            custom_account = Path(temp) / "custom" / "account-copy"
            for account in (default_account, custom_account):
                path = account / "db_storage" / "message" / "message_0.db"
                path.parent.mkdir(parents=True)
                path.write_bytes(b"fixture")
            report = discover_accounts("windows", home=home, roots=[custom_account])
            self.assertEqual(len(report["accounts"]), 2)
            with self.assertRaises(DiscoveryError):
                discover_accounts("linux", home=home)

    def test_registry_keeps_paths_local_and_returns_only_opaque_summary(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            account = root / "private-account"
            db = account / "db_storage" / "message" / "message_0.db"
            db.parent.mkdir(parents=True)
            db.write_bytes(b"fixture")
            report = discover_accounts("macos", home=root / "empty", roots=[account])
            case = root / "case"
            case.mkdir()
            summary = persist_source_registry(case, report)
            self.assertNotIn(str(root), json.dumps(summary))
            account_ref = summary["account_refs"][0]
            registered = load_registered_account(case, account_ref)
            self.assertEqual(Path(registered["account_path"]), account.resolve())
            mode = (case / "local" / "wechat4-source-registry.json").stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)


class WeChat4SnapshotTests(unittest.TestCase):
    def test_database_classification_distinguishes_plain_encrypted_candidate_and_corrupt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plain = root / "plain.db"
            connection = create_plain_database(plain)
            encrypted = root / "encrypted.db"
            encrypted.write_bytes(bytes((index * 73 + 41) % 256 for index in range(8192)))
            corrupt = root / "corrupt.db"
            corrupt.write_bytes(b"not a database")
            self.assertEqual(classify_database(plain)["kind"], "plaintext_sqlite")
            self.assertEqual(classify_database(encrypted)["kind"], "sqlcipher_candidate")
            self.assertEqual(classify_database(corrupt)["kind"], "unknown_or_corrupt")
            connection.close()

    def test_plain_wal_database_is_backed_up_with_committed_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "account" / "db_storage" / "message" / "message_0.db"
            connection = create_plain_database(source, "first")
            connection.execute("INSERT INTO sample(value) VALUES ('wal-row')")
            connection.commit()
            account = {
                "account_ref": "acct_synthetic",
                "account_path": str(source.parents[3]),
                "databases": [{"db_ref": "db_message", "role": "message", "path": str(source)}],
            }
            destination = root / "snapshot"
            receipt = snapshot_account(account, destination)
            snapshot_db = destination / receipt["databases"][0]["relative_path"]
            values = [row[0] for row in sqlite3.connect(snapshot_db).execute("SELECT value FROM sample ORDER BY id")]
            self.assertEqual(values, ["first", "wal-row"])
            self.assertEqual(receipt["databases"][0]["snapshot_mode"], "sqlite_backup")
            connection.close()

    def test_encrypted_candidate_preserves_stable_db_wal_shm_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "account" / "db_storage" / "message" / "message_0.db"
            source.parent.mkdir(parents=True)
            source.write_bytes(bytes((index * 73 + 41) % 256 for index in range(8192)))
            Path(str(source) + "-wal").write_bytes(b"synthetic-wal")
            Path(str(source) + "-shm").write_bytes(b"synthetic-shm")
            account = {
                "account_ref": "acct_synthetic",
                "account_path": str(source.parents[3]),
                "databases": [{"db_ref": "db_message", "role": "message", "path": str(source)}],
            }
            destination = root / "snapshot"
            receipt = snapshot_account(account, destination)
            item = receipt["databases"][0]
            self.assertEqual(item["snapshot_mode"], "stable_bundle_copy")
            self.assertEqual({sidecar["suffix"] for sidecar in item["sidecars"]}, {"-wal", "-shm"})
            self.assertNotIn(str(source), json.dumps(receipt))

    def test_encrypted_snapshot_retries_if_a_wal_appears_during_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "account" / "db_storage" / "message" / "message_0.db"
            source.parent.mkdir(parents=True)
            source.write_bytes(bytes((index * 73 + 41) % 256 for index in range(8192)))
            account = {"account_ref": "acct_synthetic", "account_path": str(source.parents[3]),
                       "databases": [{"db_ref": "db_message", "role": "message", "path": str(source)}]}
            original = shutil.copy2
            calls = 0

            def racing_copy(source_path, target_path):
                nonlocal calls
                result = original(source_path, target_path)
                calls += 1
                if calls == 1:
                    Path(str(source) + "-wal").write_bytes(b"appeared-during-copy")
                return result

            with patch("personal_context_distillation.wechat4.snapshot.shutil.copy2", side_effect=racing_copy):
                receipt = snapshot_account(account, root / "snapshot")
            self.assertIn("-wal", {entry["suffix"] for entry in receipt["databases"][0]["sidecars"]})

    def test_snapshot_rejects_unknown_or_corrupt_database(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "bad.db"
            source.write_bytes(b"bad")
            account = {"account_ref": "acct", "account_path": str(root),
                       "databases": [{"db_ref": "db", "role": "message", "path": str(source)}]}
            with self.assertRaises(SnapshotError):
                snapshot_account(account, root / "snapshot")

    def test_snapshot_preserves_relative_paths_when_database_basenames_collide(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            account_root = root / "account"
            first = account_root / "db_storage" / "message" / "a" / "shared.db"
            second = account_root / "db_storage" / "message" / "b" / "shared.db"
            for path, value in ((first, "first"), (second, "second")):
                connection = create_plain_database(path, value)
                connection.close()
            account = {"account_ref": "acct_synthetic", "account_path": str(account_root), "databases": [
                {"db_ref": "db_first", "role": "message", "path": str(first), "relative_path": "message/a/shared.db"},
                {"db_ref": "db_second", "role": "message", "path": str(second), "relative_path": "message/b/shared.db"},
            ]}
            receipt = snapshot_account(account, root / "snapshot")
            self.assertEqual({item["relative_path"] for item in receipt["databases"]},
                             {"message/a/shared.db", "message/b/shared.db"})


class WeChat4CryptoTests(unittest.TestCase):
    def test_key_file_requires_exact_authorization_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            auth = AuthorizationStore(root)
            key_path = root / "key.txt"
            key_path.write_text("ab" * 32)
            os.chmod(key_path, 0o644)
            with self.assertRaises(CryptoError):
                read_key_file(key_path, auth)
            auth.grant("local_key_access")
            with self.assertRaises(CryptoError):
                read_key_file(key_path, auth)
            os.chmod(key_path, 0o600)
            key, receipt = read_key_file(key_path, auth)
            self.assertEqual(key, "ab" * 32)
            self.assertNotIn(key, json.dumps(receipt))
            self.assertNotIn(str(key_path), json.dumps(receipt))

    def test_key_validation_accepts_32_byte_hex_and_rejects_noise(self):
        self.assertEqual(validate_user_key("AB" * 32)["format"], "hex-32-byte")
        with self.assertRaises(CryptoError):
            validate_user_key("not a usable key")

    def test_sqlcipher_decryptor_uses_stdin_and_validates_plain_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            auth = AuthorizationStore(root)
            auth.grant("local_key_access")
            source = root / "encrypted.db"
            source.write_bytes(bytes((index * 73 + 41) % 256 for index in range(8192)))
            destination = root / "plain.db"
            calls = []

            def fake_runner(command, **kwargs):
                calls.append((command, kwargs))
                connection = sqlite3.connect(destination)
                connection.execute("CREATE TABLE verified(id INTEGER)")
                connection.commit()
                connection.close()
                return type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()

            key = "cd" * 32
            receipt = decrypt_sqlcipher(source, destination, key, auth, executable="sqlcipher", runner=fake_runner)
            command, kwargs = calls[0]
            self.assertNotIn(key, " ".join(command))
            self.assertIn(key, kwargs["input"])
            self.assertNotIn(key, json.dumps(receipt))
            self.assertEqual(receipt["integrity"], "ok")

    def test_sqlcipher_failure_removes_partial_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            auth = AuthorizationStore(root)
            auth.grant("local_key_access")
            source = root / "encrypted.db"
            source.write_bytes(bytes((index * 73 + 41) % 256 for index in range(8192)))
            destination = root / "partial.db"

            def fake_runner(command, **kwargs):
                destination.write_bytes(b"partial")
                return type("Result", (), {"returncode": 1, "stdout": "", "stderr": "synthetic failure"})()

            with self.assertRaises(CryptoError):
                decrypt_sqlcipher(source, destination, "ef" * 32, auth, runner=fake_runner)
            self.assertFalse(destination.exists())

    def test_mixed_snapshot_decryption_is_atomic_and_emits_plaintext_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            auth = AuthorizationStore(root / "case")
            auth.grant("local_key_access")
            snapshot = root / "snapshot"
            plain = snapshot / "contact" / "contact.db"
            connection = create_plain_database(plain)
            connection.close()
            encrypted = snapshot / "message" / "message.db"
            encrypted.parent.mkdir(parents=True)
            encrypted.write_bytes(bytes((index * 73 + 41) % 256 for index in range(8192)))
            receipt = {
                "account_ref": "acct_fixture", "seal": "source-seal", "databases": [
                    {"db_ref": "db_contact", "role": "contact", "classification": "plaintext_sqlite", "relative_path": "contact/contact.db"},
                    {"db_ref": "db_message", "role": "message", "classification": "sqlcipher_candidate", "relative_path": "message/message.db"},
                ],
            }

            def fake_runner(command, **kwargs):
                match = re.search(r"ATTACH DATABASE '([^']+)'", kwargs["input"])
                destination = Path(match.group(1))
                output = sqlite3.connect(destination)
                output.execute("CREATE TABLE verified(id INTEGER)")
                output.commit()
                output.close()
                return type("Result", (), {"returncode": 0, "stdout": "", "stderr": ""})()

            destination = root / "decrypted"
            output = decrypt_snapshot(snapshot, receipt, destination, "ab" * 32, auth, runner=fake_runner)
            self.assertTrue((destination / "contact" / "contact.db").is_file())
            self.assertTrue((destination / "message" / "message.db").is_file())
            self.assertEqual({item["classification"] for item in output["databases"]}, {"plaintext_sqlite"})
            self.assertNotIn("ab" * 32, json.dumps(output))
            self.assertNotIn(str(snapshot), json.dumps(output))


if __name__ == "__main__":
    unittest.main()
