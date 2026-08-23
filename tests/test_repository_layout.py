import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "lab-context-distillation-wx"
LIFE_REVIEWER = ROOT / "skills" / "lab-life-reviewer"


class RepositoryLayoutTests(unittest.TestCase):
    def test_root_catalog_points_to_canonical_skill(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("skills/lab-context-distillation-wx/README.md", readme)

    def test_skill_entrypoints_use_public_name(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        agent = (SKILL / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertRegex(skill, r"(?m)^name: lab-context-distillation-wx$")
        self.assertIn("$lab-context-distillation-wx", agent)
        self.assertRegex(skill, r"(?i)wechat|微信")

    def test_legacy_context_distillation_directory_is_not_tracked(self):
        tracked = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "skills/lab-context-distillation"],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        ).stdout.splitlines()
        self.assertEqual(tracked, [])

    def test_life_reviewer_entrypoints_use_public_name(self):
        skill = (LIFE_REVIEWER / "SKILL.md").read_text(encoding="utf-8")
        agent = (LIFE_REVIEWER / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertRegex(skill, r"(?m)^name: lab-life-reviewer$")
        self.assertIn("$lab-life-reviewer", agent)

    def test_life_reviewer_is_self_contained_and_catalogued(self):
        root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
        module_readme = (LIFE_REVIEWER / "README.md").read_text(encoding="utf-8")
        self.assertIn("skills/lab-life-reviewer/README.md", root_readme)
        self.assertIn("Codex", module_readme)
        self.assertIn("Claude Code", module_readme)
        for filename in (
            "interview-stage.md",
            "interview-stage.zh-CN.md",
            "archive-stage.md",
            "archive-stage.zh-CN.md",
            "handoff-schema.md",
            "handoff-schema.zh-CN.md",
        ):
            self.assertTrue((LIFE_REVIEWER / "references" / filename).is_file())

    def test_legacy_life_review_directory_is_not_tracked(self):
        tracked = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "skills/life-review"],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        ).stdout.splitlines()
        self.assertEqual(tracked, [])

    def test_module_has_human_installation_manual(self):
        readme = (SKILL / "README.md").read_text(encoding="utf-8")
        for heading in ("Codex", "Claude Code", "Verify", "Privacy", "Uninstall"):
            self.assertIn(heading, readme)

    def test_import_contains_no_nested_git_or_cache(self):
        listed = subprocess.run(
            [
                "git",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "--",
                str(SKILL.relative_to(ROOT)),
            ],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        ).stdout.splitlines()
        forbidden = [path for path in listed if ".git" in Path(path).parts or "__pycache__" in Path(path).parts]
        self.assertEqual(forbidden, [])

    def test_public_repository_has_no_private_absolute_path_or_source_thread(self):
        forbidden = [
            re.compile("/" + r"Users/[^/\s]+/"),
            re.compile("019fa20f" + r"-3c7f-7f73-9a0a-82184b30f8bf"),
        ]
        for path in ROOT.rglob("*"):
            if ".git" in path.parts or "__pycache__" in path.parts or not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for pattern in forbidden:
                self.assertIsNone(
                    pattern.search(text),
                    f"forbidden public marker in {path.relative_to(ROOT)}: {pattern.pattern}",
                )


if __name__ == "__main__":
    unittest.main()
