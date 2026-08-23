import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from personal_context_distillation.atomic import append_jsonl, read_jsonl
from personal_context_distillation.controller import (
    AdaptiveController,
    freeze_run_scope,
    freeze_runtime_policy,
    observe_run_scope,
)
from personal_context_distillation.hashing import digest_object
from personal_context_distillation.pipeline import PCDCase


QUALITY = {key: [] for key in ("negative_patterns", "counterexamples", "costs", "time_evolution", "gaps", "conflicts")}


class ControllerAndRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "case"
        self.case = PCDCase.initialize(self.root)
        self.input = self.root / "synthetic.jsonl"
        self.input.write_text("".join(json.dumps({"record_id": f"r{i}", "authored_text": "x" * 40}) + "\n" for i in range(5)))

    def tearDown(self):
        self.temp.cleanup()

    def test_completion_driven_refill_and_infrastructure_backoff(self):
        units = self.case.plan_stage("map", self.input, max_bytes=850)
        self.assertGreaterEqual(len(units), 2)
        controller = AdaptiveController(self.case, max_concurrency=2, validator_backlog_limit=4)
        first = controller.refill("worker")
        self.assertEqual(len(first["claimed"]), 2)
        unit = first["claimed"][0]
        self.case.ledger.fail(unit, "infrastructure", "synthetic timeout")
        reduced = controller.refill("worker")
        self.assertEqual(reduced["target_concurrency"], 1)
        self.assertLessEqual(len(reduced["claimed"]), 1)

    def test_orphan_raw_output_is_recovered_validated_and_committed(self):
        unit = self.case.plan_stage("map", self.input, max_bytes=5000)[0]
        self.case.claim(unit["unit_id"], "worker")
        packet = json.loads(unit["packet_path"].read_text())
        ids = [record["record_id"] for record in packet["records"]]
        body = {
            "candidates": [{"statement": "Recovered synthetic output", "evidence_ids": ids, "source_strength": "observed", "quality": QUALITY}],
        }
        raw = self.root / "results" / "raw" / f"{unit['unit_id'].replace(':', '_')}.json"
        raw.parent.mkdir(parents=True)
        raw.write_text(json.dumps({"unit_id": unit["unit_id"], **body}))
        recovery = self.case.recover_results()
        self.assertEqual(recovery["accepted"], [unit["unit_id"]])
        self.assertEqual(self.case.ledger.state(unit["unit_id"])["status"], "accepted")

    def test_orphan_commit_receipt_is_reused_without_duplicate_append(self):
        unit = self.case.plan_stage("map", self.input, max_bytes=5000)[0]
        self.case.claim(unit["unit_id"], "worker")
        packet = json.loads(unit["packet_path"].read_text())
        ids = [record["record_id"] for record in packet["records"]]
        self.case.record_result(unit["unit_id"], [{
            "statement": "Synthetic", "evidence_ids": ids, "source_strength": "observed", "quality": QUALITY,
        }])
        self.case.validate_result(unit["unit_id"])
        state = self.case.ledger.state(unit["unit_id"])
        receipt = {"unit_id": unit["unit_id"], "validation_hash": state["validation_hash"],
                   "result_hash": state["validated_output_hash"], "committed_at": "synthetic-interruption"}
        receipt["receipt_hash"] = digest_object(receipt)
        append_jsonl(self.root / "receipts" / "commit.jsonl", receipt)
        self.case.recover_results()
        commits = [item for item in read_jsonl(self.root / "receipts" / "commit.jsonl")
                   if item["unit_id"] == unit["unit_id"]]
        self.assertEqual(len(commits), 1)

    def test_orphan_validation_receipt_is_reused_without_duplicate_append(self):
        unit = self.case.plan_stage("map", self.input, max_bytes=5000)[0]
        self.case.claim(unit["unit_id"], "worker")
        packet = json.loads(unit["packet_path"].read_text())
        ids = [record["record_id"] for record in packet["records"]]
        self.case.record_result(unit["unit_id"], [{
            "statement": "Synthetic", "evidence_ids": ids, "source_strength": "observed", "quality": QUALITY,
        }])
        with patch.object(self.case.ledger, "validated", side_effect=RuntimeError("synthetic interruption")):
            with self.assertRaises(RuntimeError):
                self.case.validate_result(unit["unit_id"])
        self.case.recover_results()
        receipts = [item for item in read_jsonl(self.root / "receipts" / "validation.jsonl")
                    if item["unit_id"] == unit["unit_id"]]
        self.assertEqual(len(receipts), 1)

    def test_run_scope_and_migration_watermark_are_immutable(self):
        units = self.case.plan_stage("map", self.input, max_bytes=850)
        ids = [unit["unit_id"] for unit in units]
        scope = freeze_run_scope(self.root, "run-one", ids, generation="g0001")
        self.assertEqual(scope["unit_count"], len(ids))
        repeated = freeze_run_scope(self.root, "run-one", list(reversed(ids)), generation="g0001")
        self.assertEqual(scope["seal"], repeated["seal"])
        drain = observe_run_scope(self.root, "run-one", self.case.ledger.states())
        self.assertEqual(drain["pending"], len(ids))
        self.assertFalse(drain["drained"])
        with self.assertRaises(RuntimeError):
            freeze_run_scope(self.root, "run-one", ids[:-1], generation="g0001")

    def test_canary_halts_refill_after_systemic_content_or_structure_rejection(self):
        units = self.case.plan_stage("map", self.input, max_bytes=700)
        self.assertGreaterEqual(len(units), 3)
        for unit, category in zip(units[:3], ("content", "content", "structure")):
            self.case.ledger.fail(unit["unit_id"], category, "synthetic systemic rejection")
        controller = AdaptiveController(self.case, max_concurrency=4, canary_sample_size=3,
                                        systemic_failure_threshold=0.5)
        result = controller.refill("worker")
        self.assertTrue(result["halted_systemic"])
        self.assertEqual(result["target_concurrency"], 0)
        self.assertEqual(result["claimed"], [])

    def test_runtime_policy_is_model_neutral_immutable_and_has_no_fast_switch(self):
        policy = freeze_runtime_policy(self.root, "run-policy", {
            "semantic_model": "current_user_model", "capability_tier": "mixed",
            "dynamic_concurrency": True, "fast_mode": False,
        })
        self.assertRegex(policy["seal"], r"^[0-9a-f]{64}$")
        self.assertEqual(policy, freeze_runtime_policy(self.root, "run-policy", {
            "semantic_model": "current_user_model", "capability_tier": "mixed",
            "dynamic_concurrency": True, "fast_mode": False,
        }))
        with self.assertRaises(RuntimeError):
            freeze_runtime_policy(self.root, "bad-policy", {
                "semantic_model": "vendor-model-name", "capability_tier": "mixed",
                "dynamic_concurrency": True, "fast_mode": False,
            })

    def test_repeated_infrastructure_failures_trigger_bounded_cooldown_and_fallback(self):
        units = self.case.plan_stage("map", self.input, max_bytes=700)
        self.assertGreaterEqual(len(units), 3)
        for unit in units[:3]:
            self.case.ledger.fail(unit["unit_id"], "infrastructure", "synthetic infrastructure failure", now=100.0)
        controller = AdaptiveController(
            self.case,
            max_concurrency=4,
            infrastructure_cooldown_threshold=3,
            infrastructure_cooldown_seconds=60,
        )
        cooled = controller.refill("worker", now=120.0)
        self.assertEqual(cooled["target_concurrency"], 0)
        self.assertEqual(cooled["halt_reason"], "infrastructure_cooldown")
        self.assertTrue(cooled["fallback_recommended"])
        resumed = controller.refill("worker", now=161.0)
        self.assertGreaterEqual(resumed["target_concurrency"], 1)
        self.assertIsNone(resumed["halt_reason"])
        self.assertTrue(resumed["fallback_recommended"])


if __name__ == "__main__":
    unittest.main()
