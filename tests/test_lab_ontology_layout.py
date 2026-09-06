import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "lab-ontology"
VAULT = MODULE / "vault"
GATEWAY = VAULT / "ops" / "gateway"
SKILLS = ROOT / "skills"
KNOWLEDGE_SKILLS = ("lab-knowledge-intake", "lab-knowledge-retrospective")
CONTENT_DIRECTORIES = ("projects", "decisions", "methods", "syntheses", "concepts", "sources", ".raw", "assets")
CURRENT_DOCS = (
    ROOT / "README.md",
    ROOT / "README.en.md",
    ROOT / "CHANGELOG.md",
    ROOT / "THIRD_PARTY_NOTICES.md",
    ROOT / ".github" / "workflows" / "ci.yml",
    MODULE / "README.md",
    MODULE / "docs" / "architecture.md",
    MODULE / "docs" / "setup.md",
    MODULE / "vault" / "README.md",
    MODULE / "vault" / ".gitignore",
    MODULE / "vault" / "ops" / "AGENTS.md",
    MODULE / "vault" / "ops" / "SCHEMA.md",
    MODULE / "THIRD_PARTY_NOTICES.md",
)
EXPECTED_TOOLS = {
    "knowledge_route",
    "knowledge_search",
    "knowledge_get",
    "knowledge_list",
    "knowledge_related",
    "knowledge_intake",
    "knowledge_schema",
    "knowledge_propose_changes",
    "knowledge_list_proposals",
    "knowledge_get_proposal",
    "knowledge_apply_proposal",
    "knowledge_reject_proposal",
    "knowledge_repair_index",
}
RETIRED_BACKEND_NAME = "g" + "brain"
RETIRED_SKILL_FAMILY = "g" + "stack"


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
        for heading in ("Codex", "Claude Code", "Verify", "Privacy", "Uninstall"):
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

    def test_vault_skeleton_ships_native_governance_only(self):
        governance = (
            "README.md",
            "AGENTS.md",
            ".gitignore",
            "ops/SCHEMA.md",
            "ops/AGENTS.md",
            "ops/agent-knowledge-schema/pack.json",
            "ops/validate-schema-pack.mjs",
            "ops/validate-vault.mjs",
            "ops/check-index-scope.mjs",
            "ops/gateway/server.mjs",
            "ops/gateway/knowledge-catalog.mjs",
            "ops/gateway/knowledge-router.mjs",
            "ops/gateway/retrieval-index.mjs",
            "ops/gateway/retrieval-coordinator.mjs",
            "ops/gateway/retrieval-policy.json",
            "ops/gateway/runtime-paths.mjs",
            "ops/gateway/proposal-store.mjs",
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

    def test_retired_external_backend_files_are_not_shipped(self):
        retired = (
            f"ops/{RETIRED_BACKEND_NAME}-schema/pack.json",
            f"ops/ensure-{RETIRED_BACKEND_NAME}-sync-filter.mjs",
            "ops/sync-graph.mjs",
            "ops/gateway/external-cli-index.mjs",
            "ops/gateway/external-cli-index.test.mjs",
            "ops/gateway/legacy-schema-compat.mjs",
            "ops/gateway/legacy-schema-compat.test.mjs",
            "ops/gateway/retrieval-ab.mjs",
            "ops/gateway/retrieval-ab.test.mjs",
        )
        self.assertEqual([name for name in retired if (VAULT / name).exists()], [])

    def test_gateway_declares_native_1_8_contract(self):
        package = json.loads((GATEWAY / "package.json").read_text(encoding="utf-8"))
        policy = json.loads((GATEWAY / "retrieval-policy.json").read_text(encoding="utf-8"))
        pack = json.loads((VAULT / "ops/agent-knowledge-schema/pack.json").read_text(encoding="utf-8"))
        self.assertEqual(package["name"], "agent-knowledge-gateway")
        self.assertEqual(package["version"], "1.8.0")
        self.assertIn("test:unit", package["scripts"])
        self.assertRegex(
            package["dependencies"]["lab-trust-core"],
            r"/releases/download/lab-trust-core-v0\.1\.2/lab-trust-core-0\.1\.2\.tgz$",
        )
        self.assertEqual(policy, {
            "version": 2,
            "active_backend": "native",
            "fallback_backend": "local_markdown_keyword",
        })
        self.assertEqual(pack["api_version"], "agent-knowledge-schema-pack-v1")
        self.assertEqual(pack["name"], "agent-decision-memory")
        self.assertEqual(pack["gateway_min_version"], "1.8.0")
        kinds = {rule["kind"] for rule in pack["filing_rules"]}
        self.assertEqual(kinds, {"project", "decision", "methodology", "synthesis", "concept", "source"})

    def test_server_registers_the_documented_tool_surface(self):
        server = (GATEWAY / "server.mjs").read_text(encoding="utf-8")
        registered = set(re.findall(r'server\.registerTool\(\s*"([^"]+)"', server))
        self.assertEqual(registered, EXPECTED_TOOLS)

    def test_runtime_state_uses_agent_knowledge_namespace(self):
        runtime_paths = (GATEWAY / "runtime-paths.mjs").read_text(encoding="utf-8")
        self.assertIn("AGENT_KNOWLEDGE_STATE_DIR", runtime_paths)
        self.assertIn('".agent-knowledge"', runtime_paths)
        retired = re.compile(
            rf"(?i:\b{RETIRED_BACKEND_NAME}\b|\.{RETIRED_BACKEND_NAME}(?:/|\b)|"
            rf"\b{RETIRED_SKILL_FAMILY}\b)"
        )
        self.assertIsNone(retired.search(runtime_paths))

    def test_ci_uses_an_independent_git_vault_and_exact_probe(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        for marker in (
            "node-version: [20, 24]",
            'cp -a lab-ontology/vault/. "$VAULT_DIR/"',
            'git -C "$VAULT_DIR" init',
            'npm --prefix "$VAULT_DIR/ops/gateway" ci',
            'npm --prefix "$VAULT_DIR/ops/gateway" run test:unit',
            'npm --prefix "$VAULT_DIR/ops/gateway" run validate:schema',
            'node "$VAULT_DIR/ops/validate-vault.mjs"',
            "AGENT_KNOWLEDGE_STATE_DIR",
        ):
            self.assertIn(marker, workflow)
        for tool in EXPECTED_TOOLS:
            self.assertIn(f'"{tool}"', workflow)
        self.assertNotIn("test:router", workflow)

    def test_generated_navigation_index_is_local_derived_state(self):
        ignores = (VAULT / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("/index.md", ignores)
        self.assertFalse((VAULT / "index.md").exists())

    def test_current_lab_ontology_docs_are_native_only_and_portable(self):
        forbidden = re.compile(
            "/" + r"Users/|"
            + rf"(?i:\b{RETIRED_BACKEND_NAME}\b|\.{RETIRED_BACKEND_NAME}(?:/|\b)|"
            + rf"\b{RETIRED_SKILL_FAMILY}\b|\.{RETIRED_SKILL_FAMILY}(?:/|\b))"
        )
        for path in CURRENT_DOCS:
            content = path.read_text(encoding="utf-8")
            self.assertIsNone(forbidden.search(content), str(path.relative_to(ROOT)))
            self.assertNotRegex(content, r"KB-\d{8}-\d{6}-[a-f0-9]{8}")
        joined = "\n".join(path.read_text(encoding="utf-8") for path in CURRENT_DOCS)
        self.assertIn("Agent Knowledge 1.8.0", joined)
        self.assertIn("~/.agent-knowledge", joined)
        self.assertIn("local_markdown_keyword", joined)
        self.assertIn("non-enforcing", joined)

    def test_vault_has_no_node_modules_or_workspace_state(self):
        listed = tracked(str(VAULT.relative_to(ROOT)))
        forbidden = [
            path
            for path in listed
            if "node_modules" in Path(path).parts
            or Path(path).name in ("workspace.json", "workspace-mobile.json", ".DS_Store")
        ]
        self.assertEqual(forbidden, [])


if __name__ == "__main__":
    unittest.main()
