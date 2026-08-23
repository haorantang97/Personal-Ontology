import unittest
from copy import deepcopy

from personal_context_distillation.personal_assets import (
    AssetContractError,
    build_knowledge_cards,
    calibration_queue,
    validate_asset_package,
)


class PersonalAssetTests(unittest.TestCase):
    def setUp(self):
        self.package = {
            "self_model": [
                {
                    "asset_id": "obs1",
                    "layer": "observation",
                    "statement": "A synthetic observed behavior",
                    "domain_scope": ["work"],
                    "evidence_ids": ["e1"],
                    "confidence": "high",
                    "counterexamples": [],
                    "time_evolution": [],
                    "unresolved_tensions": [],
                    "calibration": {"behavior_change": False, "status": "safe_layer"},
                },
                {
                    "asset_id": "pattern1",
                    "layer": "pattern",
                    "statement": "A bounded synthetic pattern",
                    "domain_scope": ["work", "creation"],
                    "evidence_ids": ["e1", "e2"],
                    "confidence": "medium",
                    "counterexamples": ["Synthetic counterexample"],
                    "time_evolution": ["May differ by period"],
                    "unresolved_tensions": ["Speed versus depth"],
                    "calibration": {"behavior_change": True, "status": "ready"},
                },
                {
                    "asset_id": "hyp1",
                    "layer": "hypothesis",
                    "statement": "A synthetic hypothesis",
                    "domain_scope": ["relationship"],
                    "evidence_ids": ["e3"],
                    "confidence": "low",
                    "counterexamples": [],
                    "time_evolution": [],
                    "unresolved_tensions": ["Unresolved"],
                    "uncertainty": "Only one synthetic context",
                    "calibration": {"behavior_change": False, "status": "safe_layer"},
                },
                {
                    "asset_id": "advice1",
                    "layer": "advice",
                    "statement": "Try a reversible synthetic experiment",
                    "domain_scope": ["work"],
                    "evidence_ids": ["e1", "e2"],
                    "confidence": "medium",
                    "counterexamples": [],
                    "time_evolution": [],
                    "unresolved_tensions": [],
                    "benefit": "Tests fit quickly",
                    "cost": "Consumes one short work block",
                    "trigger": "When two options remain plausible",
                    "reversibility": "Stop after the trial",
                    "uncertainty": "Outcome is not guaranteed",
                    "calibration": {"behavior_change": True, "status": "draft"},
                },
            ],
            "voice": {
                "scenarios": [{
                    "scenario_id": "voice-close-correction",
                    "relationship_distance": "close",
                    "emotional_temperature": "warm",
                    "purpose": "correct",
                    "length": "short",
                    "humor_conditions": "only when it does not minimize harm",
                    "profanity_boundary": "do not introduce profanity",
                    "correction_style": "state the mismatch directly and offer a repair",
                    "burst_rhythm": "one or two short messages",
                    "redacted_features": ["direct opening", "brief repair"],
                    "private_vault_refs": ["vault-ref-opaque"],
                    "evidence_ids": ["e4"],
                }],
                "blind_review": {"required": True, "status": "not_run", "reviewer_count": 0},
            },
            "permissions": {
                "biography": "describe_with_coverage",
                "voice": "draft_only",
                "advisor": "recommend_with_tradeoffs",
                "auto_send": False,
                "impersonate": False,
                "irreversible_commitment": False,
                "claim_indistinguishable": False,
            },
            "fidelity": {
                "independent_from_content_qa": True,
                "evaluations": {
                    "cross_domain_reproduction": {"status": "passed", "cases": 2},
                    "holdout_prediction": {"status": "not_run", "cases": 0},
                    "non_generic_distinctiveness": {"status": "passed", "cases": 2},
                },
                "field_claim": False,
            },
            "evaluation_cases": [
                {
                    "case_id": "dev-case",
                    "evaluation": "cross_domain_reproduction",
                    "split": "development",
                    "status": "passed",
                    "evidence_ids": ["e1"],
                    "input_ref": "redacted-dev-ref",
                    "expected_behavior": "Preserve evidence boundaries",
                    "observed_behavior": "Passed on synthetic evidence",
                },
                {
                    "case_id": "holdout-case",
                    "evaluation": "holdout_prediction",
                    "split": "holdout",
                    "status": "not_run",
                    "evidence_ids": ["e2"],
                    "input_ref": "redacted-holdout-ref",
                    "expected_behavior": "Make a bounded holdout prediction",
                    "observed_behavior": None,
                },
            ],
        }

    def test_layered_model_and_scenario_voice_validate(self):
        receipt = validate_asset_package(self.package, valid_evidence_ids={"e1", "e2", "e3", "e4"})
        self.assertTrue(receipt["valid"])
        self.assertEqual(receipt["blind_review_status"], "not_run")
        self.assertFalse(receipt["field_fidelity_claim"])
        self.assertEqual(receipt["evaluation_case_count"], 2)

    def test_advice_needs_benefit_cost_trigger_reversibility_and_uncertainty(self):
        invalid = deepcopy(self.package)
        del invalid["self_model"][3]["cost"]
        with self.assertRaises(AssetContractError):
            validate_asset_package(invalid, {"e1", "e2", "e3", "e4"})

    def test_voice_rejects_exact_examples_and_impersonation_permissions(self):
        invalid = deepcopy(self.package)
        invalid["voice"]["scenarios"][0]["exact_examples"] = ["private original sentence"]
        with self.assertRaises(AssetContractError):
            validate_asset_package(invalid, {"e1", "e2", "e3", "e4"})
        invalid = deepcopy(self.package)
        invalid["permissions"]["impersonate"] = True
        with self.assertRaises(AssetContractError):
            validate_asset_package(invalid, {"e1", "e2", "e3", "e4"})

    def test_holdout_not_run_prevents_field_fidelity_claim(self):
        invalid = deepcopy(self.package)
        invalid["fidelity"]["field_claim"] = True
        with self.assertRaises(AssetContractError):
            validate_asset_package(invalid, {"e1", "e2", "e3", "e4"})

    def test_evaluation_cases_are_portable_redacted_and_holdout_disjoint(self):
        invalid = deepcopy(self.package)
        invalid["evaluation_cases"][1]["evidence_ids"] = ["e1"]
        with self.assertRaises(AssetContractError):
            validate_asset_package(invalid, {"e1", "e2", "e3", "e4"})
        invalid = deepcopy(self.package)
        invalid["evaluation_cases"][0]["private_prompt"] = "not portable"
        with self.assertRaises(AssetContractError):
            validate_asset_package(invalid, {"e1", "e2", "e3", "e4"})

    def test_calibration_queue_contains_only_behavior_changing_ready_items(self):
        queue = calibration_queue(self.package["self_model"])
        self.assertEqual([item["asset_id"] for item in queue], ["pattern1"])

    def test_high_confidence_cards_are_indexes_and_do_not_drop_other_claims(self):
        result = build_knowledge_cards(self.package["self_model"], {"e1", "e2", "e3", "e4"})
        self.assertEqual([card["source_asset_id"] for card in result["cards"]], ["obs1"])
        self.assertEqual(len(result["retained_assets"]), 4)
        self.assertEqual(set(result["not_promoted"]), {"pattern1", "hyp1", "advice1"})


if __name__ == "__main__":
    unittest.main()
