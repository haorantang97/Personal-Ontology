import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.profile_history import HistoryError, ProfileHistory


class ProfileHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "history"
        self.store = ProfileHistory(self.root)
        self.initial = {
            "sources": [
                {"source_id": "source-a", "status": "active"},
                {"source_id": "source-b", "status": "active"},
            ],
            "events": [
                {"event_id": "travel-old", "domain": "travel", "source_ids": ["source-a"], "active": True},
                {"event_id": "work-one", "domain": "work", "source_ids": ["source-b"], "active": True, "title": "Old"},
            ],
            "evidence": [
                {"evidence_id": "e-a", "source_ids": ["source-a"], "active": True},
                {"evidence_id": "e-b", "source_ids": ["source-b"], "active": True},
            ],
            "assets": [],
            "coverage": {"travel": {"status": "complete"}, "work": {"status": "complete"}},
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_every_operation_creates_a_new_sealed_read_only_snapshot(self):
        first = self.store.initialize(self.initial)
        first_path = self.root / "snapshots" / "v0001.json"
        first_bytes = first_path.read_bytes()
        self.assertEqual(first["version"], "v0001")
        self.assertEqual(first_path.stat().st_mode & 0o222, 0)

        second = self.store.incremental_update("v0001", {
            "events": [{"event_id": "creation-one", "domain": "creation", "source_ids": ["source-b"], "active": True}],
            "evidence": [], "assets": [], "sources": [],
        })
        self.assertEqual(second["version"], "v0002")
        self.assertEqual(first_path.read_bytes(), first_bytes)
        self.assertEqual(len(self.store.load("v0002")["profile"]["events"]), 3)
        self.store.verify()

    def test_correction_replaces_one_item_without_mutating_history(self):
        self.store.initialize(self.initial)
        corrected = {"event_id": "work-one", "domain": "work", "source_ids": ["source-b"], "active": True, "title": "Corrected"}
        receipt = self.store.correct("v0001", "events", "work-one", corrected, reason="synthetic correction")
        self.assertEqual(self.store.load("v0001")["profile"]["events"][1]["title"], "Old")
        self.assertEqual(self.store.load(receipt["version"])["profile"]["events"][1]["title"], "Corrected")
        self.assertEqual(receipt["operation"], "correction")

    def test_source_withdrawal_deactivates_but_does_not_delete_evidence(self):
        self.store.initialize(self.initial)
        receipt = self.store.withdraw_source("v0001", "source-a", reason="user withdrew source")
        profile = self.store.load(receipt["version"])["profile"]
        self.assertEqual(next(row for row in profile["sources"] if row["source_id"] == "source-a")["status"], "withdrawn")
        self.assertFalse(next(row for row in profile["events"] if row["event_id"] == "travel-old")["active"])
        self.assertFalse(next(row for row in profile["evidence"] if row["evidence_id"] == "e-a")["active"])
        self.assertEqual(len(profile["evidence"]), 2)

    def test_domain_reextraction_replaces_only_that_domain_and_keeps_old_version(self):
        self.store.initialize(self.initial)
        receipt = self.store.reextract_domain(
            "v0001",
            "travel",
            [{"event_id": "travel-new", "domain": "travel", "source_ids": ["source-a"], "active": True}],
            coverage={"status": "complete", "expected": 1, "processed": 1},
        )
        profile = self.store.load(receipt["version"])["profile"]
        self.assertEqual({row["event_id"] for row in profile["events"]}, {"travel-new", "work-one"})
        self.assertEqual(profile["superseded_event_ids"], ["travel-old"])
        self.assertEqual({row["event_id"] for row in self.store.load("v0001")["profile"]["events"]}, {"travel-old", "work-one"})

    def test_rollback_is_a_new_version_not_a_pointer_rewrite(self):
        self.store.initialize(self.initial)
        second = self.store.incremental_update("v0001", {
            "events": [{"event_id": "extra", "domain": "family", "source_ids": ["source-b"], "active": True}],
            "evidence": [], "assets": [], "sources": [],
        })
        rolled = self.store.rollback(second["version"], "v0001", reason="synthetic rollback")
        self.assertEqual(rolled["operation"], "rollback")
        self.assertEqual(len(self.store.load(rolled["version"])["profile"]["events"]), 2)
        self.assertEqual(len(self.store.load("v0002")["profile"]["events"]), 3)

    def test_invalid_base_or_duplicate_id_fails_closed(self):
        self.store.initialize(self.initial)
        with self.assertRaises(HistoryError):
            self.store.incremental_update("missing", {"events": [], "evidence": [], "assets": [], "sources": []})
        with self.assertRaises(HistoryError):
            self.store.incremental_update("v0001", {
                "events": [{"event_id": "work-one", "domain": "work", "source_ids": ["source-b"], "active": True}],
                "evidence": [], "assets": [], "sources": [],
            })


if __name__ == "__main__":
    unittest.main()
