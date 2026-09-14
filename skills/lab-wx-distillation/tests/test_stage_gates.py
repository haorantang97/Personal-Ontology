import unittest

from personal_context_distillation.stage_quality import QualityError, validate_stage_output
from personal_context_distillation.transport import TransportError, build_packet, preflight_packet, probe_contract


QUALITY = {
    "negative_patterns": [],
    "counterexamples": [],
    "costs": [],
    "time_evolution": [],
    "gaps": [],
    "conflicts": [],
}


class StageQualityTests(unittest.TestCase):
    def packet(self, stage, records):
        return build_packet(stage, f"Synthetic {stage} instruction", records)

    def test_map_requires_every_input_to_be_evidence_or_reasoned_exclusion(self):
        packet = self.packet("map", [{"record_id": "r1"}, {"record_id": "r2"}])
        candidate = {"statement": "Synthetic", "evidence_ids": ["r1"], "source_strength": "observed", "quality": QUALITY}
        with self.assertRaises(QualityError):
            validate_stage_output("map", packet, {"candidates": [candidate]})
        body, receipt = validate_stage_output("map", packet, {
            "candidates": [candidate],
            "coverage": {"excluded": [{"evidence_id": "r2", "reason": "administrative-only fixture"}]},
        })
        self.assertEqual(body["candidates"][0]["evidence_ids"], ["r1"])
        self.assertEqual(receipt["denominator"], 2)
        self.assertEqual(receipt["evidence_recall"], 0.5)
        self.assertEqual(receipt["disposition_coverage"], 1.0)

    def test_merge_blocks_unresolved_conflicts_and_requires_component_accounting(self):
        packet = self.packet("merge", [{"candidate_id": "c1"}, {"candidate_id": "c2"}])
        output = {
            "candidates": [{
                "statement": "Merged synthetic pattern", "evidence_ids": ["c1", "c2"],
                "source_strength": "observed", "component_candidate_ids": ["c1", "c2"],
                "quality": {**QUALITY, "conflicts": [{"status": "unresolved", "detail": "fixtures disagree"}]},
            }]
        }
        with self.assertRaises(QualityError):
            validate_stage_output("merge", packet, output)
        output["candidates"][0]["quality"] = {**QUALITY, "conflicts": [{"status": "resolved", "detail": "bounded scopes"}]}
        _, receipt = validate_stage_output("merge", packet, output)
        self.assertEqual(receipt["component_count"], 1)
        output["candidates"][0]["quality"] = {**QUALITY, "gaps": [{"status": "needs_evidence", "detail": "missing fixture"}]}
        with self.assertRaises(QualityError):
            validate_stage_output("merge", packet, output)
        output["candidates"][0]["quality"] = {**QUALITY, "gaps": [{"status": "accepted_limitation", "detail": "bounded fixture"}]}
        validate_stage_output("merge", packet, output)
        duplicated = {"candidates": output["candidates"] + [{
            "statement": "Overlapping component", "evidence_ids": ["c1"], "source_strength": "observed",
            "component_candidate_ids": ["c1"], "quality": QUALITY,
        }]}
        with self.assertRaises(QualityError):
            validate_stage_output("merge", packet, duplicated)

    def test_final_requires_confidence_limitations_and_frozen_full_coverage(self):
        packet = self.packet("final", [{"candidate_id": "c1"}])
        base = {"statement": "Final synthetic model", "evidence_ids": ["c1"], "source_strength": "observed", "quality": QUALITY}
        with self.assertRaises(QualityError):
            validate_stage_output("final", packet, {"candidates": [base]})
        base.update(confidence="low", limitations=["synthetic evidence only"])
        _, receipt = validate_stage_output("final", packet, {"candidates": [base]})
        self.assertEqual(receipt["disposition_coverage"], 1.0)

    def test_qa_has_distinct_checks_and_separate_precision_recall(self):
        packet = self.packet("qa", [{"candidate_id": "f1"}])
        candidate = {"statement": "QA synthetic finding", "evidence_ids": ["f1"], "source_strength": "observed"}
        checks = {name: {"status": "pass", "detail": "synthetic"} for name in (
            "structure", "evidence_recall", "attribution", "negative_patterns",
            "counterexamples", "coverage", "overreach",
        )}
        output = {
            "candidates": [candidate],
            "qa": {
                "verdict": "pass", "checks": checks,
                "precision": {"numerator": 1, "denominator": 1},
                "recall": {"numerator": 1, "denominator": 1},
                "unresolved": [],
            },
        }
        _, receipt = validate_stage_output("qa", packet, output)
        self.assertEqual(receipt["precision"], 1.0)
        self.assertEqual(receipt["recall"], 1.0)
        output["qa"]["checks"]["overreach"]["status"] = "fail"
        with self.assertRaises(QualityError):
            validate_stage_output("qa", packet, output)


class TransportTests(unittest.TestCase):
    def test_packet_has_one_bound_payload_and_a_machine_checked_contract(self):
        packet = build_packet("map", "Synthetic instruction", [{"record_id": "r1", "authored_text": "safe"}])
        receipt = preflight_packet(packet, max_bytes=10_000)
        self.assertRegex(receipt["binding_hash"], r"^[0-9a-f]{64}$")
        self.assertEqual(receipt["record_count"], 1)
        self.assertTrue(probe_contract("map")["passed"])

    def test_transport_preflight_rejects_raw_identity_and_multiple_data_bindings(self):
        packet = build_packet("map", "Synthetic", [{"record_id": "r1", "sender_id": "private"}])
        with self.assertRaises(TransportError):
            preflight_packet(packet, max_bytes=10_000)
        packet = build_packet("map", "Synthetic", [{"record_id": "r1"}])
        packet["extra_records"] = [{"record_id": "r2"}]
        with self.assertRaises(TransportError):
            preflight_packet(packet, max_bytes=10_000)


if __name__ == "__main__":
    unittest.main()
