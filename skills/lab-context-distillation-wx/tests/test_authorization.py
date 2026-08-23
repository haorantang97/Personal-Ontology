import json
import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.authorization import AuthorizationError, AuthorizationStore


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.auth = AuthorizationStore(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_redacted_analysis_is_implicitly_allowed(self):
        self.auth.require("analyze_redacted")

    def test_sensitive_actions_fail_closed_until_exact_grant(self):
        for action in ("new_source", "local_key_access", "send_unredacted", "kb_write"):
            with self.subTest(action=action), self.assertRaises(AuthorizationError):
                self.auth.require(action)

        receipt = self.auth.grant("local_key_access", note="synthetic test")
        self.auth.require("local_key_access")
        with self.assertRaises(AuthorizationError):
            self.auth.require("send_unredacted")
        self.assertEqual(receipt["action"], "local_key_access")
        self.assertRegex(receipt["receipt_id"], r"^auth_[0-9a-f]{16}$")

    def test_receipts_are_append_only_and_hash_chained(self):
        first = self.auth.grant("new_source")
        second = self.auth.grant("kb_write")
        lines = [json.loads(line) for line in (self.root / "authorization.jsonl").read_text().splitlines()]
        self.assertEqual(len(lines), 2)
        self.assertIsNone(first["previous_hash"])
        self.assertEqual(second["previous_hash"], first["event_hash"])
        self.auth.verify()


if __name__ == "__main__":
    unittest.main()
