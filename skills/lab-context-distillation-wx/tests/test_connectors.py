import sqlite3
import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.authorization import AuthorizationStore
from personal_context_distillation.connectors import (
    ConnectorError,
    discover_wechat4_candidates,
    load_csv_rows,
    load_sqlite_rows,
    run_external_decryptor,
    run_local_key_provider,
    snapshot_sqlite,
)


class ConnectorTests(unittest.TestCase):
    def test_sqlite_snapshot_is_consistent_and_source_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source.db"
            connection = sqlite3.connect(source)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE messages(id INTEGER PRIMARY KEY, text TEXT)")
            connection.execute("INSERT INTO messages(text) VALUES ('synthetic')")
            connection.commit()
            before = source.read_bytes()
            destination = root / "snapshot.db"
            receipt = snapshot_sqlite(source, destination)
            self.assertEqual(sqlite3.connect(destination).execute("SELECT text FROM messages").fetchone()[0], "synthetic")
            self.assertEqual(source.read_bytes(), before)
            self.assertNotIn(str(source), str(receipt))
            connection.close()

    def test_external_decryptor_requires_key_authorization_and_keeps_key_out_of_command(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            auth = AuthorizationStore(root)
            source = root / "encrypted.db"
            source.write_bytes(b"synthetic")
            destination = root / "plain.db"
            calls = []

            def fake_runner(command, **kwargs):
                calls.append((command, kwargs))
                destination.write_bytes(b"decrypted-synthetic")
                return type("Result", (), {"returncode": 0, "stderr": ""})()

            with self.assertRaises(ConnectorError):
                run_external_decryptor(["fake", "{input}", "{output}"], source, destination, "highly-secret", auth, runner=fake_runner)
            auth.grant("local_key_access")
            receipt = run_external_decryptor(["fake", "{input}", "{output}"], source, destination, "highly-secret", auth, runner=fake_runner)
            command, kwargs = calls[0]
            self.assertNotIn("highly-secret", " ".join(command))
            self.assertEqual(kwargs["input"], "highly-secret\n")
            self.assertNotIn("highly-secret", str(receipt))
            self.assertTrue(destination.exists())

    def test_decryptor_fails_closed_when_output_is_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            auth = AuthorizationStore(root)
            auth.grant("local_key_access")
            source = root / "encrypted.db"
            source.write_bytes(b"synthetic")

            def fake_runner(command, **kwargs):
                return type("Result", (), {"returncode": 0, "stderr": ""})()

            with self.assertRaises(ConnectorError):
                run_external_decryptor(["fake", "{input}", "{output}"], source, root / "missing.db", "secret", auth, runner=fake_runner)

    def test_local_key_provider_is_authorized_and_secret_is_not_in_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            auth = AuthorizationStore(Path(temp))

            def fake_runner(command, **kwargs):
                return type("Result", (), {"returncode": 0, "stdout": "local-secret-key\n", "stderr": ""})()

            with self.assertRaises(ConnectorError):
                run_local_key_provider(["provider"], auth, runner=fake_runner)
            auth.grant("local_key_access")
            key, receipt = run_local_key_provider(["provider"], auth, runner=fake_runner)
            self.assertEqual(key, "local-secret-key")
            self.assertNotIn(key, str(receipt))

    def test_csv_and_readonly_sqlite_loaders_emit_standard_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            csv_path = root / "rows.csv"
            csv_path.write_text("row_id,sender_id,self_id,timestamp,text\n1,me,me,1,synthetic\n")
            self.assertEqual(load_csv_rows(csv_path)[0]["text"], "synthetic")

            db_path = root / "rows.db"
            connection = sqlite3.connect(db_path)
            connection.execute("CREATE TABLE export(row_id, sender_id, self_id, timestamp, text)")
            connection.execute("INSERT INTO export VALUES (1, 'me', 'me', 1, 'sqlite synthetic')")
            connection.commit()
            connection.close()
            rows = load_sqlite_rows(db_path, "SELECT row_id, sender_id, self_id, timestamp, text FROM export")
            self.assertEqual(rows[0]["text"], "sqlite synthetic")
            with self.assertRaises(ConnectorError):
                load_sqlite_rows(db_path, "DELETE FROM export")

    def test_platform_discovery_is_bounded_to_configured_roots(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            mac_root = home / "Library" / "Containers" / "com.tencent.xinWeChat" / "Data" / "Documents" / "xwechat_files"
            mac_root.mkdir(parents=True)
            (mac_root / "synthetic.db").write_bytes(b"not-a-real-db")
            found = discover_wechat4_candidates("macos", home=home)
            self.assertEqual(found["platform"], "macos")
            self.assertEqual(len(found["database_candidates"]), 1)
            self.assertEqual(found["validation_status"], "pending-field-validation")
            with self.assertRaises(ConnectorError):
                discover_wechat4_candidates("linux", home=home)


if __name__ == "__main__":
    unittest.main()
