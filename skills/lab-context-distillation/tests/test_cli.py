import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "pcd.py"
FIXTURE = ROOT / "tests" / "fixtures" / "synthetic_rows.jsonl"


class CLITests(unittest.TestCase):
    def run_cli(self, *arguments):
        return subprocess.run([sys.executable, str(CLI), *map(str, arguments)], cwd=ROOT, text=True, capture_output=True)

    def test_help_and_synthetic_lifecycle(self):
        help_result = self.run_cli("--help")
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("personal context distillation", help_result.stdout.lower())
        for command in ("wechat4-discover", "wechat4-snapshot", "wechat4-decrypt", "wechat4-map", "wechat4-checkpoint"):
            self.assertIn(command, help_result.stdout)

        with tempfile.TemporaryDirectory() as temp:
            case = Path(temp) / "case"
            for args in (
                ("init", case),
                ("authorize", case, "new_source", "--note", "synthetic fixture"),
                ("ingest-jsonl", case, FIXTURE, "--source-name", "synthetic-fixture"),
                ("release", case, "g0001"),
            ):
                result = self.run_cli(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
                json.loads(result.stdout)
            plan = self.run_cli("plan", case, "map", case / "releases" / "g0001" / "records.jsonl", "--max-bytes", "5000")
            self.assertEqual(plan.returncode, 0, plan.stderr)
            units = json.loads(plan.stdout)
            self.assertEqual(len(units), 1)
            status = self.run_cli("status", case)
            self.assertEqual(status.returncode, 0, status.stderr)
            self.assertEqual(json.loads(status.stdout)["stage_denominator"], 1)


if __name__ == "__main__":
    unittest.main()
