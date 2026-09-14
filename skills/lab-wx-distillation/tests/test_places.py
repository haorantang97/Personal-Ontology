import unittest

from personal_context_distillation.places import (
    PlaceContractError,
    normalize_places,
    visited_countries,
)


class PlaceTests(unittest.TestCase):
    def test_only_one_exact_safe_candidate_is_applied(self):
        mentions = [{"place_id": "p1", "raw": "东京"}]
        candidates = [{
            "candidate_id": "c1",
            "raw": "东京",
            "canonical": "Tokyo",
            "kind": "city",
            "mapping_type": "alias",
            "safe": True,
            "contained_in": {"canonical": "Japan", "kind": "country"},
        }]
        result = normalize_places(mentions, candidates)
        self.assertEqual(result[0]["status"], "applied")
        self.assertEqual(result[0]["kind"], "city")
        self.assertEqual(result[0]["contained_in"]["kind"], "country")

    def test_ambiguous_or_unsafe_candidate_is_never_guessed(self):
        mentions = [{"place_id": "p1", "raw": "城里"}, {"place_id": "p2", "raw": "巴里"}]
        candidates = [
            {"candidate_id": "c1", "raw": "城里", "canonical": "City A", "kind": "city", "mapping_type": "slang", "safe": True},
            {"candidate_id": "c2", "raw": "城里", "canonical": "City B", "kind": "city", "mapping_type": "slang", "safe": True},
            {"candidate_id": "c3", "raw": "巴里", "canonical": "Paris", "kind": "city", "mapping_type": "typo", "safe": False},
        ]
        result = normalize_places(mentions, candidates)
        self.assertEqual([item["status"] for item in result], ["ambiguous", "ambiguous"])
        self.assertTrue(all(item["kind"] == "ambiguous" for item in result))

    def test_kind_and_mapping_type_are_closed_enums(self):
        with self.assertRaises(PlaceContractError):
            normalize_places(
                [{"place_id": "p1", "raw": "Synthetic"}],
                [{"candidate_id": "c1", "raw": "Synthetic", "canonical": "Synthetic", "kind": "planet", "mapping_type": "alias", "safe": True}],
            )
        with self.assertRaises(PlaceContractError):
            normalize_places(
                [{"place_id": "p1", "raw": "Synthetic"}],
                [{"candidate_id": "c1", "raw": "Synthetic", "canonical": "Synthetic", "kind": "other", "mapping_type": "model_guess", "safe": True}],
            )

    def test_visited_countries_contains_countries_only(self):
        places = [
            {"place_id": "country", "raw": "日本", "canonical": "Japan", "kind": "country", "status": "applied"},
            {"place_id": "city", "raw": "东京", "canonical": "Tokyo", "kind": "city", "status": "applied", "contained_in": {"canonical": "Japan", "kind": "country"}},
            {"place_id": "ambiguous", "raw": "某地", "canonical": None, "kind": "ambiguous", "status": "ambiguous"},
        ]
        events = [
            {"route_id": "r1", "subject": "self", "disposition": "completed", "place_ids": ["country", "city"]},
            {"route_id": "r2", "subject": "third_party", "disposition": "third_party", "place_ids": ["country"]},
            {"route_id": "r3", "subject": "self", "disposition": "planned", "place_ids": ["country"]},
        ]
        result = visited_countries(events, places)
        self.assertEqual(result, [{"canonical": "Japan", "kind": "country", "evidence_route_ids": ["r1"]}])


if __name__ == "__main__":
    unittest.main()
