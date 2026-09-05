import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INTAKE = ROOT / "skills" / "lab-knowledge-intake" / "SKILL.md"
RETROSPECTIVE = ROOT / "skills" / "lab-knowledge-retrospective" / "SKILL.md"


class KnowledgeIntakeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.intake = INTAKE.read_text(encoding="utf-8")
        cls.retrospective = RETROSPECTIVE.read_text(encoding="utf-8")

    def test_intake_preflights_current_machine_schema_and_target_shape(self):
        for marker in (
            "`knowledge_schema`",
            "read the exact current page",
            "current valid page of the same type",
            "required `status`",
            "Generic YAML validity is not enough",
            "inline lists",
            "Source `derived_pages` link and Result `evidence` link reciprocal",
        ):
            self.assertIn(marker, self.intake)

    def test_business_lifecycle_does_not_override_schema_status(self):
        self.assertIn("`paused`, `failed` or `completed`", self.intake)
        self.assertIn("record that state in the Project body and evidence metadata", self.intake)
        self.assertIn("不把项目“暂停/失败/完成”等业务生命周期直接写入", self.retrospective)

    def test_failed_validation_never_reuses_approval(self):
        for marker in (
            "Only present a proposal after `knowledge_propose_changes` returns success",
            "state that no knowledge write occurred",
            "Approval of the rejected proposal never transfers",
        ):
            self.assertIn(marker, self.intake)
        self.assertIn("旧批准不能转移", self.retrospective)


if __name__ == "__main__":
    unittest.main()
