import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PublicPackageBoundaryTests(unittest.TestCase):
    def test_public_tree_has_no_symlink_private_path_key_or_source_thread_identifier(self):
        forbidden = [
            re.compile("/" + r"Users/[^/\s]+/"),
            re.compile("-----" + r"BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", re.IGNORECASE),
            re.compile("019fa20f" + r"-3c7f-7f73-9a0a-82184b30f8bf"),
        ]
        for path in ROOT.rglob("*"):
            if ".git" in path.parts or "__pycache__" in path.parts:
                continue
            self.assertFalse(path.is_symlink(), f"public tree contains a symlink: {path}")
            if not path.is_file() or path.suffix in {".pyc", ".db"}:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for pattern in forbidden:
                self.assertIsNone(pattern.search(text), f"forbidden public marker in {path.name}: {pattern.pattern}")
            for identifier in re.findall(r"wxid_[A-Za-z0-9_-]+", text):
                self.assertTrue("fixture" in identifier or "synthetic" in identifier,
                                f"non-synthetic WeChat identifier in {path.name}")

    def test_runtime_has_no_vendor_model_binding_or_fast_mode_enablement(self):
        runtime = "\n".join(path.read_text(encoding="utf-8") for path in (ROOT / "scripts").rglob("*.py"))
        self.assertNotRegex(runtime, r"fast_mode\s*[:=]\s*True")
        self.assertNotRegex(runtime, r"model_name\s*[:=]")
        self.assertIn('"current_user_model"', runtime)


if __name__ == "__main__":
    unittest.main()
