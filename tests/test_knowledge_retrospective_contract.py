import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "skills" / "lab-knowledge-retrospective"
SKILL = MODULE / "SKILL.md"
PROTOCOL = MODULE / "references" / "forensic-conversation-audit.md"
MANIFEST = MODULE / "agents" / "openai.yaml"


class KnowledgeRetrospectiveContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill = SKILL.read_text(encoding="utf-8")
        cls.protocol = PROTOCOL.read_text(encoding="utf-8")
        cls.manifest = MANIFEST.read_text(encoding="utf-8")

    def test_forensic_reference_exists_is_linked_and_is_tracked(self):
        self.assertTrue(PROTOCOL.is_file())
        self.assertIn("references/forensic-conversation-audit.md", self.skill)
        relative = str(PROTOCOL.relative_to(ROOT))
        listed = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", relative],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        ).stdout.splitlines()
        self.assertEqual(listed, [relative])

    def test_scope_preflight_precedes_mode_and_evidence_work(self):
        headings = (
            "## 2. 范围预检",
            "## 3. 选择复盘模式",
            "## 4. 取得当前方法",
            "## 5. 锁定范围与原始证据",
            "## 6. 建立审计账本",
            "## 7. 通过覆盖门",
        )
        positions = [self.skill.index(heading) for heading in headings]
        self.assertEqual(positions, sorted(positions))

    def test_unknown_or_compacted_history_defaults_to_forensic_partial(self):
        preflight = self.skill[
            self.skill.index("## 2. 范围预检") : self.skill.index("## 3. 选择复盘模式")
        ]
        for marker in (
            "经过压缩/截断",
            "完整性未知",
            "默认进入法证模式",
            "初始覆盖状态记为 `PARTIAL`",
            "不得因为当前可见片段看起来很短",
        ):
            self.assertIn(marker, preflight)

    def test_failed_long_cross_task_and_turn_by_turn_work_forces_forensic_mode(self):
        mode_section = self.skill[
            self.skill.index("### 法证模式") : self.skill.index("## 4. 取得当前方法")
        ]
        for marker in (
            "项目失败",
            "长对话，无论最终报告是否要求简洁",
            "两个或更多关联任务",
            "复盘每一次问答",
            "真的执行了某个 Skill",
            "不得因为最终报告需要简洁",
        ):
            self.assertIn(marker, mode_section)

    def test_protocol_requires_two_pass_discovery_and_all_four_ledgers(self):
        for marker in (
            "发现遍",
            "审计遍",
            "稳定 ID",
            "建立逐轮账本",
            "建立声明账本",
            "建立纠正账本",
            "建立未闭环账本",
        ):
            self.assertIn(marker, self.protocol)

    def test_response_quality_and_lifecycle_are_independent(self):
        quality = self.protocol[
            self.protocol.index("固定响应质量枚举") : self.protocol.index("生命周期单独记录")
        ]
        for verdict in (
            "supported",
            "partially_supported",
            "unsupported",
            "premature_completion",
            "unanswered",
        ):
            self.assertIn(f"`{verdict}`", quality)
        self.assertNotIn("superseded", quality)

        lifecycle = self.protocol[
            self.protocol.index("生命周期单独记录") : self.protocol.index("## 4. 建立声明账本")
        ]
        for state in ("已闭环", "部分闭环", "未闭环", "被明确取代"):
            self.assertIn(f"`{state}`", lifecycle)
        self.assertIn("不能抹掉早先回答的质量", lifecycle)

    def test_hard_gate_uses_frozen_discovery_denominators(self):
        gate = self.protocol[self.protocol.index("## 8. 硬性覆盖门") :]
        for equation in (
            "原始用户消息数 == 实质性来源消息数 + 排除消息数",
            "实质性要求单元发现数 == 实质性要求单元审阅数",
            "纠正发现数 == 纠正已关联数",
            "声明发现数 == 声明核验数",
            "未闭环发现数 == 未闭环已分类数",
        ):
            self.assertIn(equation, gate)
        for marker in (
            "任何只读到部分或无法访问",
            "自动强制结果为 `PARTIAL`",
            "不存在任何历史缺口",
            "不得用“大体完整”“基本覆盖”",
        ):
            self.assertIn(marker, gate)

    def test_method_lookup_and_write_approval_are_separate_gates(self):
        self.assertIn("`knowledge_route`", self.skill)
        self.assertIn("`knowledge_get`", self.skill)
        self.assertIn("`knowledge_intake`", self.skill)
        self.assertIn("对候选结论的认可不等于", self.skill)
        self.assertIn("不要直接编辑 Vault、Git、GBrain", self.skill)

    def test_public_module_has_no_private_or_host_local_paths(self):
        texts = []
        for path in MODULE.rglob("*"):
            if path.is_file():
                texts.append(path.read_text(encoding="utf-8"))
        combined = "\n".join(texts)
        private_home_pattern = "/" + "Users" + r"/[^/\s]+/"
        self.assertIsNone(re.search(private_home_pattern, combined))
        self.assertNotIn("mcp__", combined)

    def test_manifest_exposes_both_modes_and_forensic_coverage_contract(self):
        short_match = re.search(r'^  short_description: "([^"]+)"$', self.manifest, re.MULTILINE)
        prompt_match = re.search(r'^  default_prompt: "([^"]+)"$', self.manifest, re.MULTILINE)
        self.assertIsNotNone(short_match)
        self.assertIsNotNone(prompt_match)
        short_description = short_match.group(1)
        default_prompt = prompt_match.group(1)

        self.assertGreaterEqual(len(short_description), 25)
        self.assertLessEqual(len(short_description), 64)
        self.assertIn("短任务", short_description)
        self.assertIn("长对话与失败项目", short_description)
        self.assertIn("$lab-knowledge-retrospective", default_prompt)
        self.assertIn("COMPLETE/PARTIAL", default_prompt)
        self.assertLess(
            default_prompt.index("先预检历史完整性"),
            default_prompt.index("执行逐轮法证审计"),
        )
        self.assertEqual(default_prompt.count("。"), 1)


if __name__ == "__main__":
    unittest.main()
