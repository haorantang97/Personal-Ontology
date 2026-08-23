import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "pcd.py"
EPISODES = ROOT / "tests" / "fixtures" / "life_context" / "routed_episodes.json"
FIELD_EVIDENCE = ROOT / "tests" / "fixtures" / "field_evidence" / "travel-v105-v106.json"


class V2CLITests(unittest.TestCase):
    def run_cli(self, *arguments):
        return subprocess.run([sys.executable, str(CLI), *map(str, arguments)], cwd=ROOT, text=True, capture_output=True)

    def test_help_exposes_v2_full_path(self):
        result = self.run_cli("--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for command in (
            "domain-plan", "domain-validate", "life-ledger-build", "life-ledger-merge", "places-normalize", "merge-reconstruct",
            "package-build", "runtime-query", "asset-validate", "contract-validate",
            "profile-init", "profile-update", "profile-correct", "profile-withdraw",
            "profile-reextract", "profile-rollback", "field-evidence-validate",
        ):
            self.assertIn(command, result.stdout)

    def test_life_ledger_and_runtime_query_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            denominators = root / "denominators.json"
            evidence_allowlists = root / "evidence-allowlists.json"
            place_allowlists = root / "place-allowlists.json"
            ledger = root / "ledger.json"
            package = root / "package.json"
            filters = root / "filters.json"
            denominators.write_text(json.dumps({
                "travel": ["route-travel-1", "route-travel-2"],
                "work": ["route-work-1"],
                "relationship": ["route-relationship-1"],
                "health": ["route-health-1"],
                "education": None,
                "residence": [],
                "family": [],
                "finance": [],
                "creation": [],
            }))
            evidence_allowlists.write_text(json.dumps({
                "route-travel-1": ["evidence-1"], "route-travel-2": ["evidence-2"],
                "route-work-1": ["evidence-3"], "route-relationship-1": ["evidence-4"],
                "route-health-1": ["evidence-5"],
            }))
            place_allowlists.write_text(json.dumps({
                "route-travel-1": ["place-country-jp", "place-city-tokyo"],
                "route-travel-2": ["place-country-jp"], "route-work-1": [],
                "route-relationship-1": [], "route-health-1": [],
            }))
            built = self.run_cli(
                "life-ledger-build", EPISODES, denominators,
                evidence_allowlists, place_allowlists, ledger,
            )
            self.assertEqual(built.returncode, 0, built.stderr)
            self.assertEqual(json.loads(built.stdout)["route_count"], 5)
            self.assertEqual(json.loads(built.stdout)["event_count"], 4)
            body = json.loads(ledger.read_text())
            body.update(
                evidence=[{"evidence_id": f"evidence-{index}"} for index in range(1, 6)],
                cards=[],
                modules={
                    "biography": {}, "voice": {}, "self_model": {}, "goals": {},
                    "open_loops": {}, "relationships": {}, "time_evolution": {},
                },
            )
            package.write_text(json.dumps(body, ensure_ascii=False))
            filters.write_text(json.dumps({"domain": "travel", "disposition": "visa"}))
            queried = self.run_cli("runtime-query", package, "日本签证", "--mode", "biography", "--filters", filters)
            self.assertEqual(queried.returncode, 0, queried.stderr)
            self.assertEqual(json.loads(queried.stdout)["answer_status"], "grounded")

    def test_place_asset_field_and_history_commands(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            mentions = root / "mentions.json"
            candidates = root / "candidates.json"
            places = root / "places.json"
            mentions.write_text(json.dumps([{"place_id": "p1", "raw": "东京"}], ensure_ascii=False))
            candidates.write_text(json.dumps([{
                "candidate_id": "c1", "raw": "东京", "canonical": "Tokyo", "kind": "city",
                "mapping_type": "alias", "safe": True,
            }], ensure_ascii=False))
            result = self.run_cli("places-normalize", mentions, candidates, places)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(places.read_text())[0]["status"], "applied")

            field = self.run_cli("field-evidence-validate", FIELD_EVIDENCE)
            self.assertEqual(field.returncode, 0, field.stderr)
            self.assertTrue(json.loads(field.stdout)["valid"])

            profile = root / "profile.json"
            additions = root / "additions.json"
            history = root / "history"
            profile.write_text(json.dumps({
                "sources": [{"source_id": "s1", "status": "active"}],
                "events": [], "evidence": [], "assets": [], "coverage": {},
            }))
            additions.write_text(json.dumps({"sources": [], "events": [], "evidence": [], "assets": []}))
            initialized = self.run_cli("profile-init", history, profile)
            self.assertEqual(initialized.returncode, 0, initialized.stderr)
            updated = self.run_cli("profile-update", history, "v0001", additions)
            self.assertEqual(updated.returncode, 0, updated.stderr)
            self.assertEqual(json.loads(updated.stdout)["version"], "v0002")


if __name__ == "__main__":
    unittest.main()
