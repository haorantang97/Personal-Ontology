import json
import tempfile
import unittest
from pathlib import Path

from personal_context_distillation.records import normalize_rows
from personal_context_distillation.redaction import redact_record
from personal_context_distillation.release import ReleaseError, build_release, verify_release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        row = {"source": "fixture", "shard": "0", "row_id": 1, "sender_id": "me", "self_id": "me", "timestamp": 1, "text": "synthetic text"}
        self.record = redact_record(normalize_rows([row])[0])[0]

    def tearDown(self):
        self.temp.cleanup()

    def test_release_is_atomic_sealed_and_verifiable(self):
        release = build_release(self.root, "g0001", [self.record], gaps=["media unavailable"])
        self.assertTrue((release / "manifest.json").exists())
        manifest = verify_release(release)
        self.assertEqual(manifest["record_count"], 1)
        self.assertRegex(manifest["seal"], r"^[0-9a-f]{64}$")
        self.assertFalse((self.root / "releases" / ".g0001.staging").exists())

    def test_existing_generation_is_never_overwritten(self):
        release = build_release(self.root, "g0001", [self.record])
        original = (release / "manifest.json").read_bytes()
        with self.assertRaises(ReleaseError):
            build_release(self.root, "g0001", [self.record, self.record])
        self.assertEqual((release / "manifest.json").read_bytes(), original)

    def test_tampering_breaks_digital_seal(self):
        release = build_release(self.root, "g0001", [self.record])
        with (release / "records.jsonl").open("a") as handle:
            handle.write(json.dumps({"tampered": True}) + "\n")
        with self.assertRaises(ReleaseError):
            verify_release(release)

    def test_half_initialized_staging_is_not_treated_as_complete(self):
        staging = self.root / "releases" / ".g0001.staging"
        staging.mkdir(parents=True)
        (staging / "records.jsonl").write_text("partial")
        release = build_release(self.root, "g0001", [self.record])
        self.assertEqual(verify_release(release)["generation"], "g0001")

    def test_redaction_label_cannot_smuggle_a_private_field_into_release(self):
        unsafe = {**self.record, "sender_id": "private-sender"}
        with self.assertRaises(ReleaseError):
            build_release(self.root, "g0001", [unsafe])

    def test_release_generation_must_be_one_safe_path_component(self):
        with self.assertRaises(ReleaseError):
            build_release(self.root, "../escape", [self.record])


if __name__ == "__main__":
    unittest.main()
