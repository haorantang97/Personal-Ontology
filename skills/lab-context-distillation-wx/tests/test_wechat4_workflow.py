import json
import os
import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.pipeline import PCDCase, PipelineError
from personal_context_distillation.release import verify_release
from personal_context_distillation.wechat4.checkpoint import CheckpointStore
from personal_context_distillation.wechat4.mapping import map_snapshot

from tests.test_wechat4_mapping import SELF, build_snapshot


class WeChat4WorkflowTests(unittest.TestCase):
    def test_mapping_enters_private_case_then_checkpoint_advances_only_after_sealed_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = PCDCase.initialize(root / "case")
            case.authorizations.grant("new_source", "synthetic WeChat fixture")
            snapshot, receipt, media = build_snapshot(root, "macos")
            mapping = map_snapshot(snapshot, receipt, "macos", SELF, media)
            summary = case.ingest_wechat4_mapping(mapping)
            self.assertEqual(summary["record_count"], 9)
            self.assertNotIn(SELF, json.dumps(summary))
            private_path = case.root / "local" / "wechat4-mappings" / f"{summary['mapping_id']}.json"
            self.assertTrue(private_path.is_file())
            self.assertEqual(private_path.stat().st_mode & 0o777, 0o600)
            self.assertIn(SELF, private_path.read_text())

            release = case.freeze_release("g0001")
            manifest = verify_release(release)
            release_text = (release / "records.jsonl").read_text()
            self.assertNotIn("wxid_friend_fixture", release_text)
            self.assertNotIn("Friend Fixture", release_text)
            checkpoint = case.commit_wechat4_checkpoint(summary["mapping_id"], "g0001")
            self.assertEqual(checkpoint["release_seal"], manifest["seal"])
            self.assertEqual(CheckpointStore(case.root, "acct_fixture").load()["seal"], checkpoint["seal"])

            with self.assertRaises(PipelineError):
                case.ingest_wechat4_mapping(mapping)

    def test_private_self_identity_file_requires_private_permissions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            identity = root / "self.txt"
            identity.write_text(SELF)
            os.chmod(identity, 0o644)
            with self.assertRaises(PipelineError):
                PCDCase.read_private_identity(identity)
            os.chmod(identity, 0o600)
            self.assertEqual(PCDCase.read_private_identity(identity), SELF)

    def test_private_mapping_recovers_a_partially_appended_ingestion_before_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            case = PCDCase.initialize(root / "case")
            case.authorizations.grant("new_source", "synthetic WeChat fixture")
            snapshot, receipt, media = build_snapshot(root, "macos")
            summary = case.ingest_wechat4_mapping(map_snapshot(snapshot, receipt, "macos", SELF, media))
            normalized = (case.root / "local" / "normalized.jsonl").read_text().splitlines()
            redacted = (case.root / "local" / "redacted.jsonl").read_text().splitlines()
            (case.root / "local" / "normalized.jsonl").write_text(normalized[0] + "\n")
            (case.root / "local" / "redacted.jsonl").write_text(redacted[0] + "\n")
            (case.root / "local" / "sources.jsonl").write_text("")
            recovery = case.recover_ingestions()
            self.assertEqual(recovery["completed"], [summary["mapping_id"]])
            self.assertEqual(len((case.root / "local" / "redacted.jsonl").read_text().splitlines()), 9)
            self.assertEqual(verify_release(case.freeze_release("g0001"))["record_count"], 9)


if __name__ == "__main__":
    unittest.main()
