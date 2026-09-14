import unittest

from personal_context_distillation.runtime import RuntimeContractError, query_runtime


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.package = {
            "events": [
                {
                    "event_id": "travel-visa",
                    "domain": "travel",
                    "disposition": "visa",
                    "subject": "self",
                    "title": "签证准备",
                    "summary": "正在准备日本签证材料",
                    "asserted_event_time": {"value": "2026-06", "precision": "month"},
                    "places": [{"canonical": "Japan", "kind": "country"}],
                    "evidence_ids": ["ev1"],
                    "active": True,
                },
                {
                    "event_id": "work-plan",
                    "domain": "work",
                    "disposition": "planned",
                    "subject": "self",
                    "title": "工作计划",
                    "summary": "计划调整工作节奏",
                    "asserted_event_time": None,
                    "places": [],
                    "evidence_ids": ["ev2"],
                    "active": True,
                },
            ],
            "evidence": [
                {"evidence_id": "ev1"},
                {"evidence_id": "ev2"},
                {"evidence_id": "ev-hidden", "domain": "work", "summary": "只在完整证据层出现的低置信线索", "active": True},
            ],
            "cards": [{"card_id": "card1", "title": "Synthetic index", "confidence": "high", "evidence_ids": ["ev1"]}],
            "coverage": {
                "travel": {"status": "complete", "expected": 2, "processed": 2},
                "work": {"status": "partial", "expected": 3, "processed": 1},
                "education": {"status": "not_extracted", "expected": None, "processed": 0},
            },
            "modules": {
                "biography": {"summary": "Synthetic biography"},
                "voice": {"profiles": []},
                "self_model": {"claims": []},
                "goals": {"items": []},
                "open_loops": {"items": []},
                "relationships": {"items": []},
                "time_evolution": {"items": []},
            },
        }

    def test_chinese_friendly_search_and_structured_filters(self):
        result = query_runtime(
            self.package,
            "日本签证",
            mode="biography",
            filters={"domain": "travel", "disposition": "visa", "place_kind": "country", "year": "2026"},
        )
        self.assertEqual(result["answer_status"], "grounded")
        self.assertEqual([row["event_id"] for row in result["matches"]], ["travel-visa"])
        self.assertEqual(result["domain_coverage"], {"travel": "complete"})
        self.assertEqual(result["loaded_modules"], ["biography"])

    def test_no_match_returns_unknown_and_never_arbitrary_top_rows(self):
        result = query_runtime(self.package, "火星潜水", mode="biography", filters={"domain": "travel"})
        self.assertEqual(result["answer_status"], "unknown")
        self.assertEqual(result["matches"], [])
        self.assertEqual(result["domain_coverage"], {"travel": "complete"})
        self.assertEqual(result["coverage_gap"]["reason"], "no_matching_evidence")

    def test_unscoped_no_match_still_declares_available_domain_coverage(self):
        result = query_runtime(self.package, "火星潜水", mode="biography", filters={})
        self.assertEqual(result["answer_status"], "unknown")
        self.assertEqual(result["matches"], [])
        self.assertEqual(result["domain_coverage"], {
            "education": "not_extracted", "travel": "complete", "work": "partial",
        })
        self.assertEqual(result["coverage_gap"]["reason"], "domain_scope_undetermined")

    def test_missing_domain_is_not_misstated_as_no_life_event(self):
        result = query_runtime(self.package, "学校", mode="biography", filters={"domain": "education"})
        self.assertEqual(result["answer_status"], "unknown")
        self.assertEqual(result["domain_coverage"], {"education": "not_extracted"})
        self.assertEqual(result["coverage_gap"]["reason"], "domain_not_extracted")

    def test_optional_hybrid_scores_are_explicit_not_a_fallback(self):
        result = query_runtime(
            self.package,
            "职业安排",
            mode="advisor",
            filters={"domain": "work"},
            semantic_scores={"work-plan": 0.9},
        )
        self.assertEqual(result["matches"][0]["event_id"], "work-plan")
        self.assertEqual(result["retrieval_method"], "structured_lexical_plus_caller_scores")
        self.assertEqual(result["domain_coverage"], {"work": "partial"})

    def test_full_evidence_layer_remains_searchable_even_without_a_card(self):
        result = query_runtime(self.package, "低置信线索", mode="biography", filters={"domain": "work"})
        self.assertEqual(result["answer_status"], "grounded")
        self.assertEqual(result["matches"], [])
        self.assertEqual([row["evidence_id"] for row in result["evidence_matches"]], ["ev-hidden"])
        self.assertEqual(result["card_matches"], [])

    def test_modes_load_only_allowed_minimal_modules(self):
        voice = query_runtime(self.package, "帮我写一句", mode="voice", filters={})
        self.assertEqual(voice["loaded_modules"], ["voice"])
        advisor = query_runtime(self.package, "下一步怎么办", mode="advisor", filters={})
        self.assertEqual(advisor["loaded_modules"], ["goals", "open_loops", "self_model"])
        mixed = query_runtime(
            self.package,
            "关系冲突怎么说",
            mode="mixed",
            filters={},
            include_modules=["relationships"],
        )
        self.assertIn("relationships", mixed["loaded_modules"])
        self.assertNotIn("time_evolution", mixed["loaded_modules"])
        with self.assertRaises(RuntimeContractError):
            query_runtime(self.package, "x", mode="impersonate", filters={})


if __name__ == "__main__":
    unittest.main()
