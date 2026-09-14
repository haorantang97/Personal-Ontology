import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from personal_context_distillation.domain_routing import (
    DomainRoutingError,
    freeze_domain_packet,
    validate_domain_result,
)
from personal_context_distillation.hashing import digest_object
from personal_context_distillation.life_events import EventContractError, merge_domain_ledgers


class RouteResultMultiplicityTests(unittest.TestCase):
    def setUp(self):
        self.records = [
            {
                "episode_id": "episode-a",
                "authored_text": "同一片段包含两个独立合成事件",
                "observed_message_time": {"value": "2026-03", "precision": "month"},
                "evidence_ids": ["evidence-a1", "evidence-a2"],
                "place_ids": ["place-a", "place-a2"],
            },
            {
                "episode_id": "episode-b",
                "authored_text": "该领域没有事件信号",
                "observed_message_time": {"value": "2026-04-01", "precision": "day"},
                "evidence_ids": ["evidence-b1"],
                "place_ids": ["place-b"],
            },
        ]

    def results(self):
        return [
            {
                "route_id": "travel:episode-a",
                "episode_id": "episode-a",
                "domain": "travel",
                "observed_message_time": {"value": "2026-03", "precision": "month"},
                "processing_disposition": "events_emitted",
                "events": [
                    {
                        "subject": "self",
                        "disposition": "completed",
                        "title": "Synthetic event one",
                        "summary": "第一个独立合成事件",
                        "importance": 0.8,
                        "asserted_event_time": {"value": "2025", "precision": "year"},
                        "evidence_ids": ["evidence-a1"],
                        "place_ids": ["place-a"],
                    },
                    {
                        "subject": "self",
                        "disposition": "planned",
                        "title": "Synthetic event two",
                        "summary": "第二个独立合成事件",
                        "importance": 0.5,
                        "asserted_event_time": {"value": "2026-02", "precision": "month"},
                        "evidence_ids": ["evidence-a2"],
                        "place_ids": ["place-a2"],
                    },
                ],
            },
            {
                "route_id": "travel:episode-b",
                "episode_id": "episode-b",
                "domain": "travel",
                "observed_message_time": {"value": "2026-04-01", "precision": "day"},
                "processing_disposition": "no_signal",
                "events": [],
            },
        ]

    def test_one_terminal_route_result_preserves_zero_to_many_independent_events(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-multi", "travel", self.records)
            self.assertEqual(packet["route_evidence_allowlists"]["travel:episode-a"], ["evidence-a1", "evidence-a2"])
            self.assertEqual(packet["route_place_allowlists"]["travel:episode-a"], ["place-a", "place-a2"])
            ledger = validate_domain_result(packet, self.results())
            self.assertEqual(ledger["route_count"], 2)
            self.assertEqual(ledger["event_count"], 2)
            self.assertEqual(len(ledger["route_results"]), 2)
            self.assertEqual(len(ledger["events"]), 2)
            self.assertEqual({event["title"] for event in ledger["events"]}, {"Synthetic event one", "Synthetic event two"})
            self.assertEqual({event["disposition"] for event in ledger["events"]}, {"completed", "planned"})
            self.assertEqual(ledger["no_signal_count"], 1)

    def test_processing_disposition_controls_only_whether_events_exist(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-multi", "travel", self.records)
            invalid = self.results()
            invalid[0]["events"] = []
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, invalid)
            invalid = self.results()
            invalid[1]["events"] = deepcopy(invalid[0]["events"])
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, invalid)

    def test_every_event_evidence_is_limited_to_its_own_route_allowlist(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-multi", "travel", self.records)
            invalid = self.results()
            invalid[0]["events"][0]["evidence_ids"] = ["evidence-b1"]
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, invalid)

    def test_event_places_are_limited_to_their_own_route_allowlist(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-multi", "travel", self.records)
            invalid = self.results()
            invalid[0]["events"][0]["place_ids"] = ["place-b"]
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, invalid)

    def test_empty_place_allowlist_requires_empty_event_place_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            records = deepcopy(self.records)
            records[0]["place_ids"] = []
            packet = freeze_domain_packet(Path(temp), "travel-no-places", "travel", records)
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, self.results())

    def test_ledger_merge_revalidates_route_place_allowlists(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-multi", "travel", self.records)
            ledger = validate_domain_result(packet, self.results())
            tampered = deepcopy(ledger)
            tampered["route_place_allowlists"]["travel:episode-a"] = []
            unsigned = {key: value for key, value in tampered.items() if key != "seal"}
            tampered["seal"] = digest_object(unsigned)
            with self.assertRaises(EventContractError):
                merge_domain_ledgers([tampered])

    def test_route_result_still_partitions_routes_and_preserves_observed_time(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-multi", "travel", self.records)
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, self.results()[:-1])
            duplicate = self.results() + [deepcopy(self.results()[0])]
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, duplicate)
            changed_time = self.results()
            changed_time[0]["observed_message_time"] = {"value": "2024", "precision": "year"}
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, changed_time)

    def test_third_party_event_disposition_and_subject_must_agree(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-multi", "travel", self.records)
            invalid = self.results()
            invalid[0]["events"][0]["disposition"] = "third_party"
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, invalid)
            invalid = self.results()
            invalid[0]["events"][0]["subject"] = "third_party"
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, invalid)


if __name__ == "__main__":
    unittest.main()
