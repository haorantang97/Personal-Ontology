import shutil
import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.contract_bundle import ContractBundleError, validate_contract_bundle
from personal_context_distillation.life_events import (
    DOMAIN_NAMES,
    EVENT_DISPOSITIONS,
    PROCESSING_DISPOSITIONS,
    TIME_PRECISIONS,
)
from personal_context_distillation.places import PLACE_KINDS


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "real-distillation-v2"


class ContractBundleTests(unittest.TestCase):
    def test_machine_contract_matches_executable_enums_and_required_gates(self):
        receipt = validate_contract_bundle(CONTRACT)
        enums = receipt["enums"]
        self.assertEqual(set(enums["domains"]), set(DOMAIN_NAMES))
        self.assertEqual(set(enums["processing_dispositions"]), set(PROCESSING_DISPOSITIONS))
        self.assertEqual(set(enums["event_dispositions"]), set(EVENT_DISPOSITIONS))
        self.assertEqual(set(enums["time_precisions"]), set(TIME_PRECISIONS))
        self.assertEqual(set(enums["place_kinds"]), set(PLACE_KINDS))
        self.assertEqual(set(enums["coverage_statuses"]), {"complete", "partial", "not_extracted", "ambiguous"})
        self.assertEqual(receipt["delta_rules"]["start_stage"], "post_map_domain_routing")
        self.assertEqual(receipt["delta_rules"]["accepted_map_policy"], "reuse_never_rerun")
        required_gates = {
            "frozen_denominator", "one_processing_result_per_route", "event_multiplicity_preserved",
            "event_disposition_authority", "dual_time", "place_binding",
            "evidence_binding", "privacy_redacted_only", "hash_seal",
            "accepted_terminal", "deterministic_repair_narrative_invariant",
        }
        self.assertTrue(required_gates.issubset(receipt["acceptance_gate_ids"]))
        self.assertRegex(receipt["bundle_hash"], r"^[0-9a-f]{64}$")
        self.assertIn("route-result.schema.json", receipt["files"])
        self.assertEqual(receipt["route_result_policy"]["cardinality"], "exactly_one_route_result_per_route_id")
        self.assertEqual(receipt["route_result_policy"]["event_cardinality"], "zero_to_many_independent_events")
        self.assertTrue(receipt["route_result_policy"]["route_evidence_allowlist_required"])
        self.assertTrue(receipt["route_result_policy"]["route_place_allowlist_required"])
        self.assertTrue(receipt["route_result_policy"]["event_disposition_is_authoritative"])

    def test_contract_manifest_detects_any_tamper(self):
        with tempfile.TemporaryDirectory() as temp:
            copied = Path(temp) / "contract"
            shutil.copytree(CONTRACT, copied)
            enum_path = copied / "field-enums.json"
            enum_path.write_text(enum_path.read_text().replace('"travel"', '"changed"', 1))
            with self.assertRaises(ContractBundleError):
                validate_contract_bundle(copied)

    def test_contract_contains_no_private_path_or_source_task_identifier(self):
        text = "\n".join(path.read_text(encoding="utf-8") for path in CONTRACT.glob("*.json"))
        self.assertNotIn("/Users/", text)
        self.assertNotIn("019fa20f", text)
        self.assertNotIn("wxid_", text)


if __name__ == "__main__":
    unittest.main()
