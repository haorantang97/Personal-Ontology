import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from personal_context_distillation.atomic import read_jsonl
from personal_context_distillation.ledger import LedgerError, WorkLedger


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.ledger = WorkLedger(Path(self.temp.name) / "ledger.jsonl")
        self.ledger.add("map:001", stage="map", payload_hash="a" * 64)

    def tearDown(self):
        self.temp.cleanup()

    def test_accepted_is_terminal_and_never_claimed_again(self):
        self.assertTrue(self.ledger.claim("map:001", "worker-a", now=100, lease_seconds=10))
        self.ledger.produced("map:001", "b" * 64)
        self.ledger.validated("map:001", "c" * 64)
        self.ledger.accept("map:001")
        self.assertFalse(self.ledger.claim("map:001", "worker-b", now=200, lease_seconds=10))
        with self.assertRaises(LedgerError):
            self.ledger.quarantine("map:001", "late reversal")
        self.assertEqual(self.ledger.state("map:001")["status"], "accepted")

    def test_expired_lease_can_be_reclaimed_but_live_lease_cannot(self):
        self.assertTrue(self.ledger.claim("map:001", "worker-a", now=100, lease_seconds=10))
        self.assertFalse(self.ledger.claim("map:001", "worker-b", now=109, lease_seconds=10))
        self.assertTrue(self.ledger.claim("map:001", "worker-b", now=111, lease_seconds=10))
        self.assertEqual(self.ledger.state("map:001")["worker_id"], "worker-b")

    def test_dependency_gate_blocks_until_all_dependencies_are_accepted(self):
        self.ledger.add("map:002", stage="map", payload_hash="d" * 64)
        self.ledger.add("merge:001", stage="merge", payload_hash="e" * 64, dependencies=["map:001", "map:002"])
        self.assertFalse(self.ledger.claim("merge:001", "worker", now=1, lease_seconds=10))
        for unit in ("map:001", "map:002"):
            self.ledger.claim(unit, "worker", now=1, lease_seconds=10)
            self.ledger.produced(unit, "f" * 64)
            self.ledger.validated(unit, "1" * 64)
            self.ledger.accept(unit)
        self.assertTrue(self.ledger.claim("merge:001", "worker", now=2, lease_seconds=10))

    def test_hash_chain_detects_rewritten_history(self):
        self.ledger.verify()
        path = self.ledger.path
        text = path.read_text().replace('"stage":"map"', '"stage":"final"', 1)
        path.write_text(text)
        with self.assertRaises(LedgerError):
            self.ledger.verify()

    def test_failure_categories_have_distinct_resumable_states(self):
        self.ledger.fail("map:001", "infrastructure", "synthetic timeout")
        self.assertEqual(self.ledger.state("map:001")["status"], "retry_infra")
        self.assertTrue(self.ledger.claim("map:001", "worker", now=1, lease_seconds=10))

        self.ledger.add("map:002", stage="map", payload_hash="2" * 64)
        self.ledger.fail("map:002", "privacy", "synthetic privacy gate")
        self.assertEqual(self.ledger.state("map:002")["status"], "blocked_privacy")
        self.assertFalse(self.ledger.claim("map:002", "worker", now=1, lease_seconds=10))

    def test_one_process_replays_the_ledger_only_once(self):
        with tempfile.TemporaryDirectory() as temp, patch(
            "personal_context_distillation.ledger.read_jsonl", wraps=read_jsonl
        ) as reader:
            ledger = WorkLedger(Path(temp) / "ledger.jsonl")
            for index in range(20):
                ledger.add(f"map:{index}", stage="map", payload_hash=f"{index:064x}")
            ledger.claim("map:0", "worker", now=1, lease_seconds=10)
            ledger.produced("map:0", "a" * 64)
            ledger.validated("map:0", "b" * 64, "c" * 64)
            ledger.accept("map:0")
            self.assertEqual(reader.call_count, 1)


if __name__ == "__main__":
    unittest.main()
