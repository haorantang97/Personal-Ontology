import unittest

from personal_context_distillation.compact_merge import CompactMergeError, reconstruct_grouped_candidates


QUALITY = {key: [] for key in ("negative_patterns", "counterexamples", "costs", "time_evolution", "gaps", "conflicts")}


class CompactMergeTests(unittest.TestCase):
    def setUp(self):
        self.candidates = [
            {"candidate_id": "c1", "statement": "第一段叙述。", "evidence_ids": ["r1"], "source_strength": "observed", "quality": QUALITY},
            {"candidate_id": "c2", "statement": "Second synthetic statement.", "evidence_ids": ["r2"], "source_strength": "self_report", "quality": {**QUALITY, "costs": ["Synthetic cost"]}},
            {"candidate_id": "c3", "statement": "Third synthetic statement.", "evidence_ids": ["r3"], "source_strength": "quoted", "quality": QUALITY},
        ]

    def test_cloud_group_relations_reconstruct_locally_without_narrative_loss(self):
        groups = [
            {"group_id": "g1", "component_candidate_ids": ["c1", "c2"]},
            {"group_id": "g2", "component_candidate_ids": ["c3"]},
        ]
        result = reconstruct_grouped_candidates(groups, self.candidates)
        self.assertEqual(result[0]["component_candidate_ids"], ["c1", "c2"])
        self.assertEqual(result[0]["component_statements"], ["第一段叙述。", "Second synthetic statement."])
        self.assertEqual(result[0]["statement"], "第一段叙述。\n\nSecond synthetic statement.")
        self.assertEqual(result[0]["evidence_ids"], ["c1", "c2"])
        self.assertEqual(result[0]["source_evidence_ids"], ["r1", "r2"])
        self.assertEqual(result[0]["source_strength"], "self_report")
        self.assertEqual(result[0]["narrative_reconstruction"], "exact_component_statements")

    def test_groups_must_partition_the_frozen_candidate_set(self):
        with self.assertRaises(CompactMergeError):
            reconstruct_grouped_candidates([{"group_id": "g1", "component_candidate_ids": ["c1"]}], self.candidates)
        with self.assertRaises(CompactMergeError):
            reconstruct_grouped_candidates([
                {"group_id": "g1", "component_candidate_ids": ["c1", "c2"]},
                {"group_id": "g2", "component_candidate_ids": ["c2", "c3"]},
            ], self.candidates)
        with self.assertRaises(CompactMergeError):
            reconstruct_grouped_candidates([
                {"group_id": "g1", "component_candidate_ids": ["c1", "unknown"]},
                {"group_id": "g2", "component_candidate_ids": ["c2", "c3"]},
            ], self.candidates)


if __name__ == "__main__":
    unittest.main()
