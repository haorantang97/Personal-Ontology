import unittest

from personal_context_distillation.records import normalize_rows, validate_coverage
from personal_context_distillation.redaction import RedactionError, redact_record


class RecordContractTests(unittest.TestCase):
    def test_sender_identity_is_resolved_per_row_and_shard(self):
        rows = [
            {"source": "a.db", "shard": "s1", "row_id": 1, "sender_id": "u1", "self_id": "u1", "timestamp": 1, "text": "first"},
            {"source": "b.db", "shard": "s2", "row_id": 1, "sender_id": "u9", "self_id": "u9", "timestamp": 2, "text": "second"},
            {"source": "b.db", "shard": "s2", "row_id": 2, "sender_id": "unknown", "self_id": None, "timestamp": 3, "text": "ambiguous"},
        ]
        records = normalize_rows(rows)
        self.assertEqual([r["direction"] for r in records], ["self", "self", "ambiguous"])
        self.assertEqual(records[2]["author_scope"], "unknown")

    def test_reply_quote_and_forward_context_are_not_authored_text(self):
        rows = [{
            "source": "synthetic.db", "shard": "0", "row_id": 1,
            "sender_id": "me", "self_id": "me", "timestamp": 10,
            "text": "My reply", "quoted_text": "Someone else said this",
            "quoted_author": "contact-x", "forwarded_context": "A forwarded title",
        }]
        record = normalize_rows(rows)[0]
        self.assertEqual(record["authored_text"], "My reply")
        self.assertEqual(record["quoted_text"], "Someone else said this")
        self.assertEqual(record["forwarded_context"], "A forwarded title")
        self.assertNotIn("Someone else", record["authored_text"])

    def test_identical_content_rows_remain_distinct_and_coverage_is_one_to_one(self):
        rows = [
            {"source": "a.db", "shard": "0", "row_id": 1, "sender_id": "me", "self_id": "me", "timestamp": 1, "text": "same"},
            {"source": "a.db", "shard": "0", "row_id": 2, "sender_id": "me", "self_id": "me", "timestamp": 1, "text": "same"},
        ]
        records = normalize_rows(rows)
        self.assertEqual(len(records), 2)
        self.assertNotEqual(records[0]["source_fingerprint"], records[1]["source_fingerprint"])
        validate_coverage(rows, records)
        with self.assertRaises(ValueError):
            validate_coverage(rows, records[:1])

    def test_redaction_removes_direct_identifiers_without_word_false_positive(self):
        synthetic_secret = "api_" + "key=SYNTHETIC_SECRET_FOR_TESTS"
        row = {"source": "x", "shard": "0", "row_id": 1, "sender_id": "me", "self_id": "me", "timestamp": 1,
               "text": f"Email me@example.test, tokenization is safe, {synthetic_secret}, @Alice hi"}
        record = normalize_rows([row])[0]
        redacted, findings = redact_record(record)
        text = redacted["authored_text"]
        self.assertNotIn("me@example.test", text)
        self.assertNotIn("SYNTHETIC_SECRET_FOR_TESTS", text)
        self.assertNotIn("@Alice", text)
        self.assertIn("tokenization", text)
        self.assertGreaterEqual(len(findings), 3)
        self.assertEqual(redacted["redaction_status"], "redacted")

    def test_redaction_fails_if_secret_pattern_survives(self):
        synthetic_private_key_marker = "-----BEGIN " + "PRIVATE KEY-----"
        record = normalize_rows([{"source": "x", "shard": "0", "row_id": 1, "sender_id": "me", "self_id": "me", "timestamp": 1,
                                  "text": synthetic_private_key_marker}])[0]
        with self.assertRaises(RedactionError):
            redact_record(record)


if __name__ == "__main__":
    unittest.main()
