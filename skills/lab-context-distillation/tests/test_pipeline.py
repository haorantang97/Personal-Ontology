import json
import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.authorization import AuthorizationError
from personal_context_distillation.pipeline import PCDCase, PipelineError


FIXTURE = Path(__file__).parent / "fixtures" / "synthetic_rows.jsonl"
QUALITY = {key: [] for key in ("negative_patterns", "counterexamples", "costs", "time_evolution", "gaps", "conflicts")}


def evidence_ids(packet):
    return [record.get("component_id") or record.get("record_id") or record.get("candidate_id") for record in packet["records"]]


def qa_report():
    checks = {name: {"status": "pass", "detail": "synthetic regression"} for name in (
        "structure", "evidence_recall", "attribution", "negative_patterns",
        "counterexamples", "coverage", "overreach",
    )}
    return {"verdict": "pass", "checks": checks,
            "precision": {"numerator": 1, "denominator": 1},
            "recall": {"numerator": 1, "denominator": 1}, "unresolved": []}


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "case"
        self.case = PCDCase.initialize(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_end_to_end_prepares_only_redacted_model_packets(self):
        with self.assertRaises(AuthorizationError):
            self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        self.case.authorizations.grant("new_source")
        ingestion = self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        self.assertEqual(ingestion["record_count"], 3)
        release = self.case.freeze_release("g0001")
        units = self.case.plan_stage("map", release / "records.jsonl", max_bytes=1600)
        self.assertGreaterEqual(len(units), 1)
        packet_text = "\n".join(unit["packet_path"].read_text() for unit in units)
        self.assertNotIn("demo@example.test", packet_text)
        self.assertIn("[REDACTED_EMAIL]", packet_text)
        self.assertNotIn("self-a", packet_text)
        self.assertNotIn("c-local", packet_text)
        self.assertNotIn(str(FIXTURE), packet_text)

    def test_result_validation_commit_and_status_are_separate(self):
        self.case.authorizations.grant("new_source")
        self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        release = self.case.freeze_release("g0001")
        units = self.case.plan_stage("map", release / "records.jsonl", max_bytes=5000)
        unit = units[0]
        self.assertTrue(self.case.claim(unit["unit_id"], "current-agent"))
        packet = json.loads(unit["packet_path"].read_text())
        result = [{"statement": "The speaker compares options.", "evidence_ids": evidence_ids(packet),
                   "source_strength": "observed", "quality": QUALITY}]
        receipt = self.case.submit_result(unit["unit_id"], result)
        self.assertEqual(receipt["status"], "accepted")
        status = self.case.status()
        self.assertEqual(status["accepted"], 1)
        self.assertEqual(status["target_concurrency"], None)
        self.assertEqual(status["validator_backlog"], 0)
        self.assertFalse(self.case.claim(unit["unit_id"], "other-agent"))

    def test_output_validation_and_commit_can_run_as_three_independent_steps(self):
        self.case.authorizations.grant("new_source")
        self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        release = self.case.freeze_release("g0001")
        unit = self.case.plan_stage("map", release / "records.jsonl", max_bytes=5000)[0]
        self.case.claim(unit["unit_id"], "current-agent")
        packet = json.loads(unit["packet_path"].read_text())
        result = [{"statement": "Separated stages", "evidence_ids": evidence_ids(packet),
                   "source_strength": "observed", "quality": QUALITY}]
        self.case.record_result(unit["unit_id"], result)
        self.assertEqual(self.case.ledger.state(unit["unit_id"])["status"], "produced")
        self.assertEqual(self.case.status()["validator_backlog"], 1)
        self.case.validate_result(unit["unit_id"])
        self.assertEqual(self.case.ledger.state(unit["unit_id"])["status"], "validated")
        self.case.commit_result(unit["unit_id"])
        self.assertEqual(self.case.ledger.state(unit["unit_id"])["status"], "accepted")

    def test_knowledge_base_proposal_needs_separate_approval(self):
        proposal = self.case.create_kb_proposal([{"title": "Synthetic", "body": "A synthetic conclusion"}])
        with self.assertRaises(AuthorizationError):
            self.case.approve_kb_proposal(proposal["proposal_id"])
        self.case.authorizations.grant("kb_write")
        approval = self.case.approve_kb_proposal(proposal["proposal_id"])
        self.assertEqual(approval["status"], "approved_for_external_write")
        self.assertFalse(approval["write_performed"])

    def test_tampered_knowledge_base_proposal_cannot_be_approved(self):
        proposal = self.case.create_kb_proposal([{"title": "Synthetic", "body": "Original"}])
        path = self.root / "kb-proposals" / f"{proposal['proposal_id']}.json"
        body = json.loads(path.read_text())
        body["entries"][0]["body"] = "Tampered"
        path.write_text(json.dumps(body))
        self.case.authorizations.grant("kb_write")
        with self.assertRaises(PipelineError):
            self.case.approve_kb_proposal(proposal["proposal_id"])

    def test_empty_prompt_and_duplicate_payload_binding_fail_preflight(self):
        self.case.authorizations.grant("new_source")
        self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        release = self.case.freeze_release("g0001")
        with self.assertRaises(PipelineError):
            self.case.plan_stage("map", release / "records.jsonl", max_bytes=5000, instruction="")

    def test_release_refuses_an_unreceipted_partial_ingestion(self):
        self.case.authorizations.grant("new_source")
        self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        with (self.root / "local" / "redacted.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"record_id": "partial", "source_fingerprint": "unreceipted", "redaction_status": "redacted"}) + "\n")
        with self.assertRaises(PipelineError):
            self.case.freeze_release("g0001")

    def test_semantic_failure_goes_to_human_and_can_be_adjudicated(self):
        self.case.authorizations.grant("new_source")
        self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        release = self.case.freeze_release("g0001")
        unit = self.case.plan_stage("map", release / "records.jsonl", max_bytes=5000)[0]
        self.case.claim(unit["unit_id"], "current-agent")
        with self.assertRaises(PipelineError):
            self.case.submit_result(unit["unit_id"], [{"statement": "Unsupported", "evidence_ids": ["missing"], "source_strength": "observed"}])
        self.assertEqual(self.case.ledger.state(unit["unit_id"])["status"], "needs_human")
        packet = json.loads(unit["packet_path"].read_text())
        replacement = [{"statement": "Human-reviewed synthetic observation", "evidence_ids": evidence_ids(packet),
                        "source_strength": "observed", "quality": QUALITY}]
        receipt = self.case.adjudicate(unit["unit_id"], "accept", "synthetic human decision", replacement)
        self.assertEqual(receipt["decision"], "accept")
        self.assertEqual(self.case.ledger.state(unit["unit_id"])["status"], "accepted")

    def test_accepted_stage_materializes_for_cross_event_merge(self):
        self.case.authorizations.grant("new_source")
        self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        release = self.case.freeze_release("g0001")
        unit = self.case.plan_stage("map", release / "records.jsonl", max_bytes=5000)[0]
        self.case.claim(unit["unit_id"], "current-agent")
        packet = json.loads(unit["packet_path"].read_text())
        self.case.submit_result(unit["unit_id"], [{
            "statement": "Synthetic cross-event candidate",
            "evidence_ids": evidence_ids(packet),
            "source_strength": "observed",
            "quality": {**QUALITY, "gaps": ["media not available"]},
        }])
        output = self.root / "derived" / "map-candidates.jsonl"
        receipt = self.case.materialize_accepted("map", output)
        self.assertEqual(receipt["candidate_count"], 1)
        candidate = json.loads(output.read_text().strip())
        self.assertRegex(candidate["candidate_id"], r"^cand_[0-9a-f]{20}$")
        merge = self.case.plan_stage("merge", output, max_bytes=5000, dependencies=[unit["unit_id"]])
        self.assertEqual(len(merge), 1)

    def test_final_requires_a_matching_frozen_candidate_set(self):
        candidate_path = self.root / "derived" / "merge.jsonl"
        candidate_path.parent.mkdir(parents=True)
        candidate_path.write_text(json.dumps({"candidate_id": "cand_a", "statement": "Synthetic", "evidence_ids": ["rec_a"], "source_strength": "observed"}) + "\n")
        with self.assertRaises(PipelineError):
            self.case.plan_stage("final", candidate_path, max_bytes=5000, dependencies=["merge:synthetic"])
        manifest = self.case.freeze_candidates("final-input", candidate_path)
        self.assertRegex(manifest["seal"], r"^[0-9a-f]{64}$")
        units = self.case.plan_stage("final", candidate_path, max_bytes=5000, dependencies=["merge:synthetic"], candidate_set="final-input")
        self.assertEqual(len(units), 1)

    def test_full_synthetic_map_merge_final_qa_and_kb_path(self):
        self.case.authorizations.grant("new_source")
        self.case.ingest_jsonl(FIXTURE, source_name="synthetic-fixture")
        release = self.case.freeze_release("g0001", gaps=["media unavailable"])

        map_unit = self.case.plan_stage("map", release / "records.jsonl", max_bytes=5000)[0]
        self.case.claim(map_unit["unit_id"], "current-agent")
        map_packet = json.loads(map_unit["packet_path"].read_text())
        self.case.submit_result(map_unit["unit_id"], [{
            "statement": "The speaker compares options before deciding.",
            "evidence_ids": evidence_ids(map_packet),
            "source_strength": "observed",
            "quality": {**QUALITY, "costs": ["decision latency may increase"]},
        }])
        map_jsonl = self.root / "derived" / "map.jsonl"
        self.case.materialize_accepted("map", map_jsonl)

        merge_unit = self.case.plan_stage("merge", map_jsonl, max_bytes=5000, dependencies=[map_unit["unit_id"]])[0]
        self.case.claim(merge_unit["unit_id"], "current-agent")
        merge_packet = json.loads(merge_unit["packet_path"].read_text())
        self.case.submit_result(merge_unit["unit_id"], [{
            "statement": "Comparison is a bounded reasoning pattern.",
            "evidence_ids": evidence_ids(merge_packet),
            "source_strength": "observed",
            "component_candidate_ids": evidence_ids(merge_packet),
            "quality": {**QUALITY, "gaps": [{"status": "accepted_limitation", "detail": "only synthetic text evidence is available"}]},
        }])
        merge_jsonl = self.root / "derived" / "merge.jsonl"
        self.case.materialize_accepted("merge", merge_jsonl)
        self.case.freeze_candidates("final-input", merge_jsonl)

        final_unit = self.case.plan_stage("final", merge_jsonl, max_bytes=5000,
                                          dependencies=[merge_unit["unit_id"]], candidate_set="final-input")[0]
        self.case.claim(final_unit["unit_id"], "current-agent")
        final_packet = json.loads(final_unit["packet_path"].read_text())
        self.case.submit_result(final_unit["unit_id"], [{
            "statement": "The operating model includes deliberate option comparison with an explicit evidence gap.",
            "evidence_ids": evidence_ids(final_packet),
            "source_strength": "observed",
            "confidence": "low",
            "limitations": ["synthetic evidence only"],
            "quality": QUALITY,
        }])
        final_jsonl = self.root / "derived" / "final.jsonl"
        self.case.materialize_accepted("final", final_jsonl)

        qa_unit = self.case.plan_stage("qa", final_jsonl, max_bytes=5000, dependencies=[final_unit["unit_id"]])[0]
        self.case.claim(qa_unit["unit_id"], "current-agent")
        qa_packet = json.loads(qa_unit["packet_path"].read_text())
        self.case.submit_result(qa_unit["unit_id"], {"candidates": [{
            "statement": "QA passes structure but retains the media and generalization gap.",
            "evidence_ids": evidence_ids(qa_packet),
            "source_strength": "observed",
        }], "qa": qa_report()})

        final_entry = json.loads(final_jsonl.read_text().strip())
        proposal = self.case.create_kb_proposal([{"title": "Synthetic operating-model entry", "body": final_entry["statement"]}])
        self.case.authorizations.grant("kb_write")
        approval = self.case.approve_kb_proposal(proposal["proposal_id"])
        self.assertFalse(approval["write_performed"])
        self.assertEqual(self.case.status()["accepted"], 4)


if __name__ == "__main__":
    unittest.main()
