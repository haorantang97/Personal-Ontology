import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from personal_context_distillation.life_events import build_life_ledger
from personal_context_distillation.personal_assets import build_knowledge_cards
from personal_context_distillation.places import normalize_places
from personal_context_distillation.portable import (
    PortablePackageError,
    build_portable_package,
    freeze_portable_package,
    validate_portable_package,
)
from personal_context_distillation.runtime import query_runtime


FIXTURES = Path(__file__).parent / "fixtures" / "life_context"


class PortablePackageTests(unittest.TestCase):
    def build(self):
        route_results = json.loads((FIXTURES / "routed_episodes.json").read_text(encoding="utf-8"))
        denominators = {
            "travel": ["route-travel-1", "route-travel-2"], "work": ["route-work-1"],
            "relationship": ["route-relationship-1"], "health": ["route-health-1"],
            "education": None, "residence": [], "family": [], "finance": [], "creation": [],
        }
        evidence_allowlists = {
            "route-travel-1": ["evidence-1"], "route-travel-2": ["evidence-2"],
            "route-work-1": ["evidence-3"], "route-relationship-1": ["evidence-4"],
            "route-health-1": ["evidence-5"],
        }
        place_allowlists = {
            "route-travel-1": ["place-country-jp", "place-city-tokyo"],
            "route-travel-2": ["place-country-jp"], "route-work-1": [],
            "route-relationship-1": [], "route-health-1": [],
        }
        ledger = build_life_ledger(route_results, denominators, evidence_allowlists, place_allowlists)
        places = normalize_places(
            [{"place_id": "place-country-jp", "raw": "日本"}, {"place_id": "place-city-tokyo", "raw": "东京"}],
            [
                {"candidate_id": "c-country", "raw": "日本", "canonical": "Japan", "kind": "country", "mapping_type": "alias", "safe": True},
                {"candidate_id": "c-city", "raw": "东京", "canonical": "Tokyo", "kind": "city", "mapping_type": "alias", "safe": True},
            ],
        )
        assets = json.loads((FIXTURES / "assets.json").read_text(encoding="utf-8"))
        evidence = [{"evidence_id": f"evidence-{index}", "active": True} for index in range(1, 6)]
        cards = build_knowledge_cards(assets["self_model"], {row["evidence_id"] for row in evidence})["cards"]
        return build_portable_package(ledger, places, evidence, assets, cards)

    def test_builds_a_valid_runtime_package_with_full_evidence_layers(self):
        package = self.build()
        receipt = validate_portable_package(package)
        self.assertTrue(receipt["valid"])
        self.assertEqual(len(package["events"]), 4)
        self.assertEqual(len(package["evidence"]), 5)
        self.assertEqual(len(package["evaluation_cases"]), 3)
        self.assertEqual(receipt["evaluation_case_count"], 3)
        self.assertTrue(package["cards"][0]["index_only"])
        self.assertEqual(set(package["modules"]), {
            "biography", "voice", "self_model", "goals", "open_loops", "relationships", "time_evolution",
        })
        result = query_runtime(package, "日本签证", mode="biography", filters={"domain": "travel"})
        self.assertEqual(result["answer_status"], "grounded")

    def test_package_rejects_private_or_impersonation_content(self):
        package = self.build()
        invalid = deepcopy(package)
        invalid["private_identity_map"] = {"x": "y"}
        with self.assertRaises(PortablePackageError):
            validate_portable_package(invalid)
        invalid = deepcopy(package)
        invalid["permissions"]["auto_send"] = True
        with self.assertRaises(PortablePackageError):
            validate_portable_package(invalid)
        invalid = deepcopy(package)
        invalid.pop("evaluation_cases")
        invalid["seal"] = "invalid"
        with self.assertRaises(PortablePackageError):
            validate_portable_package(invalid)

    def test_freeze_is_immutable_and_tamper_evident(self):
        package = self.build()
        with tempfile.TemporaryDirectory() as temp:
            first = freeze_portable_package(Path(temp), "synthetic-v2", package)
            second = freeze_portable_package(Path(temp), "synthetic-v2", package)
            self.assertEqual(first, second)
            package_path = Path(temp) / "synthetic-v2" / "package.json"
            self.assertEqual(package_path.stat().st_mode & 0o222, 0)
            package_path.chmod(0o644)
            tampered = json.loads(package_path.read_text())
            tampered["events"][0]["summary"] = "tampered"
            package_path.write_text(json.dumps(tampered))
            with self.assertRaises(PortablePackageError):
                freeze_portable_package(Path(temp), "synthetic-v2", package)


if __name__ == "__main__":
    unittest.main()
