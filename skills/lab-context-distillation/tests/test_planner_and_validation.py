import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.planner import PlanningError, freeze_candidate_set, split_records
from personal_context_distillation.repair import SemanticRepairRequired, downgrade_source_strength, repair_structure
from personal_context_distillation.validation import classify_error, validate_candidate


class PlannerAndValidationTests(unittest.TestCase):
    def test_split_preserves_whole_records_and_exact_coverage(self):
        records = [{"record_id": f"r{i}", "authored_text": "x" * 80} for i in range(7)]
        packets = split_records(records, max_bytes=330)
        flattened = [r for packet in packets for r in packet]
        self.assertEqual([r["record_id"] for r in flattened], [r["record_id"] for r in records])
        self.assertGreater(len(packets), 1)
        for packet in packets:
            self.assertTrue(packet)

    def test_oversize_single_record_is_compacted_with_complete_lineage(self):
        packets = split_records([{"record_id": "huge", "authored_text": "x" * 1000}], max_bytes=400)
        components = [record for packet in packets for record in packet]
        self.assertGreater(len(components), 1)
        self.assertTrue(all(record["parent_record_id"] == "huge" for record in components))
        self.assertEqual("".join(record["component_text"] for record in components), "x" * 1000)
        self.assertEqual([record["chunk_index"] for record in components], list(range(1, len(components) + 1)))

    def test_candidate_set_is_immutable_and_order_independent(self):
        with tempfile.TemporaryDirectory() as temp:
            first = freeze_candidate_set(Path(temp), "final-1", ["c2", "c1"])
            second = freeze_candidate_set(Path(temp), "final-1", ["c1", "c2"])
            self.assertEqual(first["seal"], second["seal"])
            with self.assertRaises(PlanningError):
                freeze_candidate_set(Path(temp), "final-1", ["c3"])
            with self.assertRaises(PlanningError):
                freeze_candidate_set(Path(temp), "../escape", ["c1"])
            with self.assertRaises(PlanningError):
                freeze_candidate_set(Path(temp), "duplicates", ["c1", "c1"])

    def test_whitelist_repair_deduplicates_evidence_but_never_invents_it(self):
        candidate = {
            "statement": "Synthetic observation", "evidence_ids": ["r1", "r1", None],
            "source_strength": "self_report",
            "quality": {"gaps": [None, "synthetic gap", "synthetic gap"]},
            "time_range": {"start": 1704067200, "end": "2024-01-02T00:00:00+00:00"},
        }
        repaired, receipt = repair_structure(candidate, valid_evidence_ids={"r1"})
        self.assertEqual(repaired["evidence_ids"], ["r1"])
        self.assertEqual(repaired["quality"]["gaps"], ["synthetic gap"])
        self.assertEqual(repaired["time_range"], {"start": "2024-01-01T00:00:00Z", "end": "2024-01-02T00:00:00Z"})
        self.assertEqual(repaired["source_strength"], "self_report")
        self.assertNotEqual(receipt["before_hash"], receipt["after_hash"])
        validate_candidate(repaired, {"r1"})

        with self.assertRaises(SemanticRepairRequired):
            repair_structure({"statement": "x", "evidence_ids": ["missing"], "source_strength": "observed"}, {"r1"})

    def test_error_taxonomy_separates_infrastructure_and_content(self):
        self.assertEqual(classify_error(429, "rate limit"), "infrastructure")
        self.assertEqual(classify_error(None, "evidence id missing"), "content")
        self.assertEqual(classify_error(None, "private key detected"), "privacy")
        self.assertEqual(classify_error(None, "dependency not accepted"), "dependency")
        self.assertEqual(classify_error(None, "date must be string"), "structure")

    def test_source_strength_repair_can_only_downgrade(self):
        candidate = {"statement": "Synthetic", "evidence_ids": ["r1"], "source_strength": "observed"}
        downgraded, receipt = downgrade_source_strength(candidate, "self_report")
        self.assertEqual(downgraded["source_strength"], "self_report")
        self.assertTrue(receipt["downgrade_only"])
        with self.assertRaises(SemanticRepairRequired):
            downgrade_source_strength(downgraded, "observed")


if __name__ == "__main__":
    unittest.main()
