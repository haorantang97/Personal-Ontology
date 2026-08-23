import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
REQUIRED_FILES = ("SKILL.md", "README.md", "LICENSE.md", "THIRD_PARTY_NOTICES.md", "agents/openai.yaml")
README_HEADINGS = ("Installation", "Codex", "Claude Code", "Verify", "Privacy", "Uninstall")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def skill_directories():
    """Skill directories that Git tracks (ignores scratch directories on disk)."""
    tracked = subprocess.run(
        ["git", "ls-files", "--", "skills"],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.splitlines()
    names = sorted({Path(path).parts[1] for path in tracked if len(Path(path).parts) > 2})
    return [SKILLS / name for name in names]


class SkillPackageTests(unittest.TestCase):
    """Every published skill is a complete, self-describing package.

    This replaces running skill-creator's quick_validate.py in CI: the checks
    below are the structural ones that validator enforces, plus this
    repository's own packaging rules.
    """

    def test_at_least_the_four_catalogued_skills_exist(self):
        names = {path.name for path in skill_directories()}
        for expected in (
            "lab-context-distillation-wx",
            "lab-life-reviewer",
            "lab-knowledge-retrospective",
            "lab-knowledge-intake",
        ):
            self.assertIn(expected, names)

    def test_every_skill_has_required_files(self):
        for skill in skill_directories():
            for filename in REQUIRED_FILES:
                self.assertTrue((skill / filename).is_file(), f"{skill.name}/{filename}")

    def test_frontmatter_name_matches_directory_and_has_description(self):
        for skill in skill_directories():
            text = (skill / "SKILL.md").read_text(encoding="utf-8")
            match = FRONTMATTER.match(text)
            self.assertIsNotNone(match, f"{skill.name}: SKILL.md must start with YAML frontmatter")
            frontmatter = match.group(1)
            self.assertRegex(frontmatter, rf"(?m)^name: {re.escape(skill.name)}$", skill.name)
            self.assertRegex(frontmatter, r"(?m)^description:\s*\S", f"{skill.name}: description missing")
            self.assertRegex(skill.name, r"^[a-z0-9]+(-[a-z0-9]+)*$", f"{skill.name}: name must be kebab-case")
            self.assertLessEqual(len(skill.name), 64, skill.name)

    def test_agent_manifest_uses_public_name(self):
        for skill in skill_directories():
            manifest = (skill / "agents" / "openai.yaml").read_text(encoding="utf-8")
            self.assertIn(f"${skill.name}", manifest, skill.name)
            self.assertIn("display_name:", manifest, skill.name)

    def test_readme_has_human_manual_sections(self):
        for skill in skill_directories():
            readme = (skill / "README.md").read_text(encoding="utf-8")
            for heading in README_HEADINGS:
                self.assertIn(heading, readme, f"{skill.name}: README lacks {heading}")

    def test_module_license_points_to_root(self):
        root_license = (ROOT / "LICENSE.md").read_text(encoding="utf-8")
        self.assertIn("PolyForm Noncommercial License 1.0.0", root_license)
        self.assertIn("Required Notice:", root_license)
        for module in [*skill_directories(), ROOT / "lab-ontology"]:
            text = (module / "LICENSE.md").read_text(encoding="utf-8")
            self.assertIn("PolyForm Noncommercial License 1.0.0", text, module.name)
            self.assertIn("LICENSE.md", text, module.name)

    def test_catalog_and_notices_list_every_skill(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        for skill in skill_directories():
            self.assertIn(f"skills/{skill.name}/README.md", readme, skill.name)
            self.assertIn(f"skills/{skill.name}/THIRD_PARTY_NOTICES.md", notices, skill.name)


if __name__ == "__main__":
    unittest.main()
