import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CLI = ROOT / "scripts" / "pcd.py"
FIXTURES = ROOT / "tests" / "fixtures" / "wechat4"
SELF = "wxid_self_fixture"


def message_table(talker):
    return "Msg_" + hashlib.md5(talker.encode()).hexdigest()


def build_account(root: Path, platform: str) -> Path:
    account = root / f"{platform}-synthetic-account"
    specs = [("contact", "contact.db"), ("session", "session.db"), ("message", "message_0.db")]
    if platform == "macos":
        specs.extend([("favorite", "favorite.db"), ("sns", "sns.db")])
    for role, filename in specs:
        path = account / "db_storage" / role / filename
        path.parent.mkdir(parents=True)
        script = (FIXTURES / platform / f"{role}.sql").read_text().format(
            DIRECT_TABLE=message_table("wxid_friend_fixture"), GROUP_TABLE=message_table("room_fixture@chatroom")
        )
        connection = sqlite3.connect(path)
        connection.executescript(script)
        connection.commit()
        connection.close()
    media = account / "msg" / "attach"
    media.mkdir(parents=True)
    for name in ("synthetic-image.jpg", "synthetic-voice.silk", "fixture-document.pdf"):
        (media / name).write_bytes(("forward-fixture:" + name).encode())
    return account


class ForwardInstallTests(unittest.TestCase):
    def run_cli(self, cwd, *arguments):
        result = subprocess.run([sys.executable, str(CLI), *map(str, arguments)], cwd=cwd, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_cli_forward_path_from_outside_repository_for_both_platform_profiles(self):
        with tempfile.TemporaryDirectory() as temp:
            outside = Path(temp)
            for platform in ("macos", "windows"):
                account = build_account(outside, platform)
                case = outside / f"case-{platform}"
                self.run_cli(outside, "init", case)
                self.run_cli(outside, "authorize", case, "new_source", "--note", "synthetic forward test")
                discovery = self.run_cli(outside, "wechat4-discover", case, platform, "--home", outside / "empty", "--root", account)
                account_ref = discovery["account_refs"][0]
                self.run_cli(outside, "wechat4-snapshot", case, account_ref, "snapshot-one")
                identity = outside / f"self-{platform}.txt"
                identity.write_text(SELF)
                os.chmod(identity, 0o600)
                mapped = self.run_cli(
                    outside, "wechat4-map", case, case / "local" / "wechat4-snapshots" / "snapshot-one",
                    platform, "--self-file", identity,
                )
                self.assertNotIn(SELF, json.dumps(mapped))
                self.run_cli(outside, "release", case, "g0001")
                checkpoint = self.run_cli(outside, "wechat4-checkpoint", case, mapped["mapping_id"], "g0001")
                self.assertEqual(checkpoint["release_seal"], json.loads((case / "releases" / "g0001" / "manifest.json").read_text())["seal"])
                release_text = (case / "releases" / "g0001" / "records.jsonl").read_text()
                self.assertNotIn("wxid_friend_fixture", release_text)
                self.assertNotIn("Friend Fixture", release_text)
            for stage in ("map", "merge", "final", "qa"):
                self.assertTrue(self.run_cli(outside, "transport-probe", stage)["passed"])

    def test_v2_domain_to_portable_runtime_forward_path_from_outside_repository(self):
        with tempfile.TemporaryDirectory() as temp:
            outside = Path(temp)
            records = outside / "episodes.json"
            records.write_text(json.dumps([
                {"episode_id": "evidence-1", "authored_text": "去年完成合成行程", "observed_message_time": {"value": "2026-01", "precision": "month"}},
                {"episode_id": "evidence-2", "authored_text": "正在准备日本签证材料", "observed_message_time": {"value": "2026-02-01", "precision": "day"}},
            ], ensure_ascii=False))
            planned = self.run_cli(outside, "domain-plan", outside, "travel-v2", "travel", records)
            self.assertEqual(planned["route_count"], 2)
            result = outside / "domain-result.json"
            result.write_text(json.dumps([
                {
                    "route_id": "travel:evidence-1", "episode_id": "evidence-1", "domain": "travel",
                    "observed_message_time": {"value": "2026-01", "precision": "month"},
                    "processing_disposition": "events_emitted",
                    "events": [{
                        "subject": "self", "disposition": "completed", "title": "Synthetic completed trip",
                        "summary": "去年完成合成行程", "importance": 0.4,
                        "asserted_event_time": {"value": "2025", "precision": "year"},
                        "evidence_ids": ["evidence-1"], "place_ids": [],
                    }],
                },
                {
                    "route_id": "travel:evidence-2", "episode_id": "evidence-2", "domain": "travel",
                    "observed_message_time": {"value": "2026-02-01", "precision": "day"},
                    "processing_disposition": "events_emitted",
                    "events": [{
                        "subject": "self", "disposition": "visa", "title": "Synthetic visa",
                        "summary": "正在准备日本签证材料", "importance": 0.8,
                        "asserted_event_time": {"value": "之后", "precision": "relative"},
                        "evidence_ids": ["evidence-2"], "place_ids": [],
                    }],
                },
            ], ensure_ascii=False))
            ledger = outside / "travel-ledger.json"
            validated = self.run_cli(outside, "domain-validate", outside / "domain-packets" / "travel-v2.json", result, ledger)
            self.assertEqual(validated["coverage"]["travel"]["status"], "complete")
            mentions, candidates, places = outside / "mentions.json", outside / "candidates.json", outside / "places.json"
            mentions.write_text("[]")
            candidates.write_text("[]")
            self.run_cli(outside, "places-normalize", mentions, candidates, places)
            evidence = outside / "evidence.json"
            evidence.write_text(json.dumps([{"evidence_id": "evidence-1", "active": True}, {"evidence_id": "evidence-2", "active": True}]))
            assets = outside / "assets.json"
            assets.write_text((ROOT / "tests" / "fixtures" / "life_context" / "assets.json").read_text())
            cards = outside / "cards.json"
            cards.write_text("[]")
            package = self.run_cli(outside, "package-build", ledger, places, evidence, assets, cards, outside / "packages", "synthetic-v2")
            self.assertEqual(package["status"], "sealed")
            filters = outside / "filters.json"
            filters.write_text(json.dumps({"domain": "travel", "disposition": "visa"}))
            query = self.run_cli(
                outside, "runtime-query", outside / "packages" / "synthetic-v2" / "package.json",
                "日本签证", "--mode", "biography", "--filters", filters,
            )
            self.assertEqual(query["answer_status"], "grounded")


if __name__ == "__main__":
    unittest.main()
