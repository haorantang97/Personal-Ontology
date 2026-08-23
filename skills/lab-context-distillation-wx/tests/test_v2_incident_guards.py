import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.atomic import AtomicWriteError, read_json, write_once_json
from personal_context_distillation.evaluation import EvaluationError, freeze_evaluation_split
from personal_context_distillation.field_evidence import validate_field_evidence
from personal_context_distillation.planner import split_records
from personal_context_distillation.repair import repair_structure
from personal_context_distillation.transport import (
    classify_failure_event,
    combine_model_and_sidecar_outcome,
    prepare_output_directory,
)


FIXTURE = Path(__file__).parent / "fixtures" / "field_evidence" / "travel-v105-v106.json"


class V2IncidentGuardTests(unittest.TestCase):
    def test_failure_classifier_reads_explicit_events_not_normal_output_words(self):
        self.assertIsNone(classify_failure_event({"event": "model_output", "text": "The error taught a useful lesson"}))
        self.assertEqual(
            classify_failure_event({"event": "failure", "category": "infrastructure", "code": "rate_limited"}),
            "infrastructure",
        )
        with self.assertRaises(ValueError):
            classify_failure_event({"event": "failure", "category": "mystery", "code": "unknown"})

    def test_output_directory_is_writable_before_dispatch(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "nested" / "outputs"
            receipt = prepare_output_directory(destination)
            self.assertTrue(destination.is_dir())
            self.assertTrue(receipt["ready"])
            self.assertFalse(any(destination.iterdir()))

    def test_accepted_model_result_is_not_reclassified_by_optional_sidecar_failure(self):
        result = combine_model_and_sidecar_outcome("accepted", "failed")
        self.assertEqual(result["model_status"], "accepted")
        self.assertEqual(result["overall_status"], "accepted_with_sidecar_pending")
        self.assertTrue(result["retry_sidecar_only"])

    def test_single_writer_is_idempotent_for_identical_content(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "contract.json"
            first = write_once_json(path, {"schema": "synthetic"})
            second = write_once_json(path, {"schema": "synthetic"})
            self.assertEqual(first, second)
            self.assertEqual(read_json(path), {"schema": "synthetic"})
            with self.assertRaises(AtomicWriteError):
                write_once_json(path, {"schema": "different"})

    def test_holdout_is_frozen_and_disjoint_from_development(self):
        with tempfile.TemporaryDirectory() as temp:
            split = freeze_evaluation_split(Path(temp), "voice", ["dev-1", "dev-2"], ["holdout-1"])
            self.assertEqual(split["holdout_ids"], ["holdout-1"])
            self.assertEqual(split, freeze_evaluation_split(Path(temp), "voice", ["dev-2", "dev-1"], ["holdout-1"]))
            with self.assertRaises(EvaluationError):
                freeze_evaluation_split(Path(temp), "bad", ["same"], ["same"])
            with self.assertRaises(EvaluationError):
                freeze_evaluation_split(Path(temp), "voice", ["dev-1"], ["holdout-1", "promoted"])

    def test_unicode_oversize_split_reassembles_with_zero_character_loss(self):
        text = "签证🙂行程，不能丢字。" * 120
        packets = split_records([{"record_id": "unicode", "authored_text": text}], max_bytes=500)
        parts = [row for packet in packets for row in packet]
        self.assertEqual("".join(part["component_text"] for part in parts), text)

    def test_structural_repair_proves_narrative_fields_unchanged(self):
        original = {
            "statement": "Synthetic narrative must not change",
            "summary": "叙述保持不变",
            "evidence_ids": ["e1", "e1"],
            "source_strength": "observed",
        }
        repaired, receipt = repair_structure(original, {"e1"})
        self.assertEqual(repaired["statement"], original["statement"])
        self.assertEqual(repaired["summary"], original["summary"])
        self.assertTrue(receipt["narrative_unchanged"])

    def test_authorized_aggregate_field_evidence_is_internally_consistent(self):
        receipt = validate_field_evidence(read_json(FIXTURE))
        self.assertTrue(receipt["valid"])
        self.assertEqual(receipt["travel_coverage"], 1.0)
        self.assertEqual(receipt["place_coverage"], 1.0)
        self.assertFalse(receipt["public_skill_ran_private_data"])


if __name__ == "__main__":
    unittest.main()
