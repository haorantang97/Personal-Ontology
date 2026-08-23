import json
import unittest
from copy import deepcopy
from pathlib import Path

from personal_context_distillation.life_events import (
    DOMAIN_NAMES,
    EventContractError,
    biography_view,
    build_life_ledger,
    merge_domain_ledgers,
    validate_route_result,
)


FIXTURE = Path(__file__).parent / "fixtures" / "life_context" / "routed_episodes.json"


class LifeEventTests(unittest.TestCase):
    def setUp(self):
        self.route_results = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.denominators = {
            "travel": ["route-travel-1", "route-travel-2"],
            "work": ["route-work-1"],
            "relationship": ["route-relationship-1"],
            "health": ["route-health-1"],
            "education": None,
            "residence": [],
            "family": [],
            "finance": [],
            "creation": [],
        }
        self.evidence_allowlists = {
            "route-travel-1": ["evidence-1"],
            "route-travel-2": ["evidence-2"],
            "route-work-1": ["evidence-3"],
            "route-relationship-1": ["evidence-4"],
            "route-health-1": ["evidence-5"],
        }
        self.place_allowlists = {
            "route-travel-1": ["place-country-jp", "place-city-tokyo"],
            "route-travel-2": ["place-country-jp"],
            "route-work-1": [],
            "route-relationship-1": [],
            "route-health-1": [],
        }

    def build(self, results=None, denominators=None, evidence=None, places=None):
        return build_life_ledger(
            self.route_results if results is None else results,
            self.denominators if denominators is None else denominators,
            self.evidence_allowlists if evidence is None else evidence,
            self.place_allowlists if places is None else places,
        )

    def test_route_result_and_event_have_separate_closed_dispositions(self):
        result = validate_route_result(
            self.route_results[0], {"evidence-1"}, {"place-country-jp", "place-city-tokyo"},
        )
        self.assertEqual(result["processing_disposition"], "events_emitted")
        self.assertEqual(result["events"][0]["disposition"], "completed")
        invalid = deepcopy(self.route_results[0])
        invalid["processing_disposition"] = "completed"
        with self.assertRaises(EventContractError):
            validate_route_result(invalid, {"evidence-1"}, {"place-country-jp", "place-city-tokyo"})
        invalid = deepcopy(self.route_results[0])
        invalid["events"][0]["disposition"] = "reviewed"
        with self.assertRaises(EventContractError):
            validate_route_result(invalid, {"evidence-1"}, {"place-country-jp", "place-city-tokyo"})

    def test_observed_and_asserted_time_never_substitute_for_each_other(self):
        work = validate_route_result(self.route_results[2], {"evidence-3"}, set())
        self.assertEqual(work["observed_message_time"]["precision"], "month")
        self.assertIsNone(work["events"][0]["asserted_event_time"])
        invalid = deepcopy(self.route_results[2])
        invalid["events"][0]["asserted_event_time"] = {
            "value": invalid["observed_message_time"]["value"],
            "precision": "message_time_fallback",
        }
        with self.assertRaises(EventContractError):
            validate_route_result(invalid, {"evidence-3"}, set())

    def test_domain_ledger_reports_complete_partial_not_extracted_and_ambiguous(self):
        ledger = self.build()
        self.assertEqual(set(ledger["coverage"]), set(DOMAIN_NAMES))
        self.assertEqual(ledger["coverage"]["travel"]["status"], "complete")
        self.assertEqual(ledger["coverage"]["education"]["status"], "not_extracted")
        self.assertEqual(ledger["coverage"]["residence"]["status"], "complete")
        self.assertEqual(ledger["coverage"]["health"]["status"], "complete")

        partial = self.build(results=self.route_results[:-1])
        self.assertEqual(partial["coverage"]["health"]["status"], "partial")

        ambiguous_rows = deepcopy(self.route_results)
        ambiguous_rows[0]["processing_disposition"] = "insufficient_evidence"
        ambiguous_rows[0]["events"] = []
        ambiguous = self.build(results=ambiguous_rows)
        self.assertEqual(ambiguous["coverage"]["travel"]["status"], "ambiguous")

    def test_duplicate_route_or_out_of_denominator_is_rejected(self):
        with self.assertRaises(EventContractError):
            self.build(results=self.route_results + [deepcopy(self.route_results[0])])
        invalid = deepcopy(self.route_results)
        invalid[0]["route_id"] = "not-in-denominator"
        with self.assertRaises(EventContractError):
            self.build(results=invalid)

    def test_importance_changes_only_the_display_view(self):
        ledger = self.build()
        authority_before = deepcopy(ledger["events"])
        display = biography_view(ledger, minimum_importance=0.6)
        self.assertLess(len(display), len(ledger["events"]))
        self.assertEqual(ledger["events"], authority_before)
        self.assertIn("route-travel-1", {row["route_id"] for row in ledger["events"]})
        self.assertNotIn("route-travel-1", {row["route_id"] for row in display})

    def test_third_party_and_no_signal_are_retained_without_fake_events(self):
        ledger = self.build()
        self.assertEqual(ledger["route_count"], 5)
        self.assertEqual(ledger["event_count"], 4)
        self.assertEqual(ledger["subject_event_count"], 3)
        self.assertEqual(ledger["no_signal_count"], 1)

    def test_independent_domain_ledgers_merge_without_hiding_unextracted_domains(self):
        travel_denominators = {domain: None for domain in DOMAIN_NAMES}
        travel_denominators["travel"] = ["route-travel-1", "route-travel-2"]
        work_denominators = {domain: None for domain in DOMAIN_NAMES}
        work_denominators["work"] = ["route-work-1"]
        travel_routes = {key: self.evidence_allowlists[key] for key in travel_denominators["travel"]}
        travel_places = {key: self.place_allowlists[key] for key in travel_denominators["travel"]}
        work_routes = {"route-work-1": self.evidence_allowlists["route-work-1"]}
        work_places = {"route-work-1": self.place_allowlists["route-work-1"]}
        travel = build_life_ledger(
            self.route_results[:2], travel_denominators, travel_routes, travel_places,
        )
        work = build_life_ledger(
            [self.route_results[2]], work_denominators, work_routes, work_places,
        )
        merged = merge_domain_ledgers([travel, work])
        self.assertEqual(merged["coverage"]["travel"]["status"], "complete")
        self.assertEqual(merged["coverage"]["work"]["status"], "complete")
        self.assertEqual(merged["coverage"]["education"]["status"], "not_extracted")
        self.assertEqual(
            {event["route_id"] for event in merged["events"]},
            {"route-travel-1", "route-travel-2", "route-work-1"},
        )
        with self.assertRaises(EventContractError):
            merge_domain_ledgers([travel, travel])


if __name__ == "__main__":
    unittest.main()
