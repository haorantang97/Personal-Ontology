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
        self.assertIn('PACKAGE_ID = "lab-trust-core"', source)
        self.assertIn('name: "lab-trust-core"', mcp)

    def test_package_has_no_lab_ontology_runtime_dependency(self):
        package = json.loads((CORE / "package.json").read_text(encoding="utf-8"))
        dependencies = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
        self.assertFalse(any(value.startswith(("file:", "workspace:")) for value in dependencies.values()))
        for path in (CORE / "src").rglob("*.ts"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("lab-ontology", text, path)


if __name__ == "__main__":
    unittest.main()
