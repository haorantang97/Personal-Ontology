import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "lab-ontology"
VAULT = MODULE / "vault"
SKILLS = ROOT / "skills"
KNOWLEDGE_SKILLS = ("lab-knowledge-intake", "lab-knowledge-retrospective")
CONTENT_DIRECTORIES = ("projects", "decisions", "methods", "syntheses", "concepts", "sources", ".raw", "assets")


def tracked(path):
    return subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", path],
        cwd=ROOT,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.splitlines()


class LabOntologyLayoutTests(unittest.TestCase):
    def test_root_catalog_points_to_module_and_skills(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("lab-ontology/README.md", readme)
        for name in KNOWLEDGE_SKILLS:
            self.assertIn(f"skills/{name}/README.md", readme)

    def test_module_has_human_installation_manual(self):
        readme = (MODULE / "README.md").read_text(encoding="utf-8")
        for heading in ("Codex", "Claude Code", "Verify", "Privacy", "Uninstall", "Provenance"):
            self.assertIn(heading, readme)
        for filename in ("LICENSE.md", "THIRD_PARTY_NOTICES.md", "docs/architecture.md", "docs/setup.md"):
            self.assertTrue((MODULE / filename).is_file(), filename)

    def test_knowledge_skills_use_public_names_and_are_catalogued(self):
        for name in KNOWLEDGE_SKILLS:
            skill = (SKILLS / name / "SKILL.md").read_text(encoding="utf-8")
            agent = (SKILLS / name / "agents" / "openai.yaml").read_text(encoding="utf-8")
            readme = (SKILLS / name / "README.md").read_text(encoding="utf-8")
            self.assertRegex(skill, rf"(?m)^name: {name}$")
            self.assertIn(f"${name}", agent)
            for heading in ("Codex", "Claude Code", "Verify", "Privacy", "Uninstall"):
                self.assertIn(heading, readme)
            for filename in ("LICENSE.md", "THIRD_PARTY_NOTICES.md"):
                self.assertTrue((SKILLS / name / filename).is_file(), f"{name}/{filename}")

    def test_vault_skeleton_ships_governance_only(self):
        governance = (
            "README.md",
            "AGENTS.md",
            ".gitignore",
            "ops/SCHEMA.md",
            "ops/AGENTS.md",
            "ops/gbrain-schema/pack.json",
            "ops/validate-vault.mjs",
            "ops/sync-graph.mjs",
            "ops/check-index-scope.mjs",
            "ops/ensure-gbrain-sync-filter.mjs",
            "ops/gateway/server.mjs",
            "ops/gateway/knowledge-router.mjs",
            "ops/gateway/knowledge-router.test.mjs",
            "ops/gateway/package.json",
            "ops/gateway/package-lock.json",
        )
        for filename in governance:
            self.assertTrue((VAULT / filename).exists(), filename)
        self.assertTrue((VAULT / "AGENTS.md").is_symlink())
        for directory in CONTENT_DIRECTORIES:
            listed = tracked(str((VAULT / directory).relative_to(ROOT)))
            self.assertEqual(
                listed,
                [f"lab-ontology/vault/{directory}/.gitkeep"],
                f"{directory} must ship empty: {listed}",
            )

    def test_vault_has_no_node_modules_or_workspace_state(self):
        listed = tracked(str(VAULT.relative_to(ROOT)))
        forbidden = [
            path
            for path in listed
            if "node_modules" in Path(path).parts or Path(path).name in ("workspace.json", "workspace-mobile.json", ".DS_Store")
        ]
        self.assertEqual(forbidden, [])

    def test_schema_pack_matches_gateway_contract(self):
        pack = json.loads((VAULT / "ops/gbrain-schema/pack.json").read_text(encoding="utf-8"))
        self.assertEqual(pack["name"], "agent-decision-memory")
        kinds = {rule["kind"] for rule in pack["filing_rules"]}
        self.assertEqual(kinds, {"project", "decision", "methodology", "synthesis", "concept", "source"})


if __name__ == "__main__":
    unittest.main()
