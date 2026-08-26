import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "lab-trust-core"


class LabTrustCoreLayoutTests(unittest.TestCase):
    def test_core_is_top_level_and_self_contained(self):
        self.assertTrue(CORE.is_dir())
        for filename in (
            "README.md",
            "LICENSE",
            "SECURITY.md",
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "src/index.ts",
            "src/mcp/server.ts",
            "schemas/knowledge-record.schema.json",
            "test/end-to-end.test.ts",
        ):
            self.assertTrue((CORE / filename).is_file(), filename)

    def test_public_identity_is_lab_trust_core(self):
        package = json.loads((CORE / "package.json").read_text(encoding="utf-8"))
        source = (CORE / "src" / "index.ts").read_text(encoding="utf-8")
        mcp = (CORE / "src" / "mcp" / "server.ts").read_text(encoding="utf-8")
        self.assertEqual(package["name"], "lab-trust-core")
        self.assertEqual(set(package["bin"]), {"lab-trust", "lab-trust-mcp"})
        self.assertEqual(package["repository"]["directory"], "lab-trust-core")
        self.assertIn("Personal-Ontology", package["repository"]["url"])
        self.assertIn("THIRD_PARTY_NOTICES.md", package["files"])
        self.assertIn('PACKAGE_ID = "lab-trust-core"', source)
        self.assertIn('name: "lab-trust-core"', mcp)

    def test_package_has_no_lab_ontology_runtime_dependency(self):
        package = json.loads((CORE / "package.json").read_text(encoding="utf-8"))
        dependencies = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
        self.assertFalse(any(value.startswith(("file:", "workspace:")) for value in dependencies.values()))
        for path in (CORE / "src").rglob("*.ts"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("lab-ontology", text, path)

    def test_bilingual_catalogues_order_system_core_then_four_skills(self):
        self.assertFalse((ROOT / "modules").exists())
        skill_links = (
            "skills/lab-context-distillation-wx/README.md",
            "skills/lab-life-reviewer/README.md",
            "skills/lab-knowledge-retrospective/README.md",
            "skills/lab-knowledge-intake/README.md",
        )
        for filename in ("README.md", "README.en.md"):
            readme = (ROOT / filename).read_text(encoding="utf-8")
            system_position = readme.index("lab-ontology/README.md")
            core_position = readme.index("lab-trust-core/README.md")
            skill_positions = [readme.index(link) for link in skill_links]
            self.assertLess(system_position, core_position, filename)
            self.assertTrue(all(core_position < position for position in skill_positions), filename)

    def test_mit_license_exception_is_explicit(self):
        core_license = (CORE / "LICENSE").read_text(encoding="utf-8")
        root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
        english_readme = (ROOT / "README.en.md").read_text(encoding="utf-8")
        root_license = (ROOT / "LICENSE.md").read_text(encoding="utf-8")
        notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        self.assertIn("MIT License", core_license)
        self.assertIn("lab-trust-core", root_readme)
        self.assertIn("MIT", root_readme)
        self.assertIn("lab-trust-core", english_readme)
        self.assertIn("MIT", english_readme)
        self.assertIn("lab-trust-core/", root_license)
        self.assertIn("MIT License", root_license)
        self.assertIn("lab-trust-core/THIRD_PARTY_NOTICES.md", notices)


if __name__ == "__main__":
    unittest.main()
