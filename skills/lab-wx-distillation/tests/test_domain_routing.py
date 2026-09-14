import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from personal_context_distillation.domain_routing import (
    DomainRoutingError,
    freeze_domain_packet,
    validate_domain_result,
)


class DomainRoutingTests(unittest.TestCase):
    def setUp(self):
        self.records = [
            {"episode_id": "ep-1", "authored_text": "计划去一个合成地点", "observed_message_time": {"value": "2026-01", "precision": "month"}},
            {"episode_id": "ep-2", "authored_text": "今天讨论别的话题", "observed_message_time": {"value": "2026-02-01", "precision": "day"}},
        ]

    def output(self):
        return [
            {
                "route_id": "travel:ep-1", "episode_id": "ep-1", "domain": "travel",
                "observed_message_time": {"value": "2026-01", "precision": "month"},
                "processing_disposition": "events_emitted",
                "events": [{
                    "subject": "self", "disposition": "planned", "title": "Synthetic plan",
                    "summary": "计划去一个合成地点", "importance": 0.4,
                    "asserted_event_time": {"value": "之后", "precision": "relative"},
                    "evidence_ids": ["ep-1"], "place_ids": [],
                }],
            },
            {
                "route_id": "travel:ep-2", "episode_id": "ep-2", "domain": "travel",
                "observed_message_time": {"value": "2026-02-01", "precision": "day"},
                "processing_disposition": "no_signal", "events": [],
            },
        ]

    def test_packet_freezes_exact_domain_denominator_and_processing_contract(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-one", "travel", self.records)
            self.assertEqual(packet["route_ids"], ["travel:ep-1", "travel:ep-2"])
            self.assertIn("no_signal", packet["output_contract"]["processing_dispositions"])
            self.assertIn("planned", packet["output_contract"]["event_dispositions"])
            self.assertNotIn("reviewed", packet["output_contract"]["event_dispositions"])
            self.assertEqual(packet["route_place_allowlists"], {"travel:ep-1": [], "travel:ep-2": []})
            self.assertEqual(packet, freeze_domain_packet(Path(temp), "travel-one", "travel", self.records))
            with self.assertRaises(DomainRoutingError):
                freeze_domain_packet(Path(temp), "travel-one", "travel", self.records[:-1])

    def test_every_packet_episode_requires_exactly_one_processing_result(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-one", "travel", self.records)
            result = validate_domain_result(packet, self.output())
            self.assertEqual(result["coverage"]["travel"]["status"], "complete")
            self.assertEqual(result["event_count"], 1)
            self.assertEqual(result["no_signal_count"], 1)
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, self.output()[:-1])
            duplicate = self.output() + [deepcopy(self.output()[0])]
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, duplicate)

    def test_observed_time_must_match_packet_and_cannot_be_rewritten(self):
        with tempfile.TemporaryDirectory() as temp:
            packet = freeze_domain_packet(Path(temp), "travel-one", "travel", self.records)
            invalid = self.output()
            invalid[0]["observed_message_time"] = {"value": "2025", "precision": "year"}
            with self.assertRaises(DomainRoutingError):
                validate_domain_result(packet, invalid)


if __name__ == "__main__":
    unittest.main()
