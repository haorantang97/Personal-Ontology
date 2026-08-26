import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePromotion } from "../src/evaluate-promotion.js";
import type { EvidenceObservation } from "../src/model.js";
import { corroboratedResult, seedRhetoricRecord } from "./helpers/records.js";

function support(
  sourceFamily: string,
  evidenceKind: EvidenceObservation["evidence_kind"] = "external_claim"
): EvidenceObservation {
  return {
    id: `support-${sourceFamily}-${evidenceKind}`,
    source_family: sourceFamily,
    relation: "supports",
    evidence_kind: evidenceKind,
    scope: ["sales rhetoric"]
  };
}

function contradict(sourceFamily: string): EvidenceObservation {
  return {
    id: `contradict-${sourceFamily}`,
    source_family: sourceFamily,
    relation: "contradicts",
    evidence_kind: "external_claim",
    scope: ["sales rhetoric"]
  };
}

test("twenty observations from one family do not corroborate", () => {
  const evidence = Array.from({ length: 20 }, (_, index) => ({
    id: `video-${index + 1}`,
    source_family: "creator-a",
    relation: "supports" as const,
    evidence_kind: "external_claim" as const,
    scope: ["sales rhetoric"]
  }));
  const result = evaluatePromotion(seedRhetoricRecord, evidence);
  assert.equal(result.eligible, false);
  assert.equal(result.distinct_supporting_families, 1);
  assert.ok(result.blockers.includes("INSUFFICIENT_INDEPENDENT_FAMILIES"));
});

test("two independent families can corroborate an ordinary bounded claim", () => {
  const result = evaluatePromotion(seedRhetoricRecord, [
    support("family-a"),
    support("family-b")
  ]);
  assert.equal(result.eligible, true);
  assert.equal(result.recommended_maturity, "corroborated");
  assert.equal(result.distinct_supporting_families, 2);
});

test("conflicting independent evidence blocks automatic promotion", () => {
  const result = evaluatePromotion(seedRhetoricRecord, [
    support("family-a"),
    contradict("family-b")
  ]);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes("CONFLICTING_EVIDENCE"));
  assert.equal(result.distinct_contradicting_families, 1);
});

test("unknown source family cannot count toward promotion", () => {
  const result = evaluatePromotion(seedRhetoricRecord, [support("")]);
  assert.equal(result.eligible, false);
  assert.ok(result.blockers.includes("MISSING_SOURCE_FAMILY"));
});

test("corroborated knowledge needs repeated or high-quality evidence to validate", () => {
  const result = evaluatePromotion(corroboratedResult, [
    support("family-a"),
    support("family-b")
  ]);
  assert.equal(result.eligible, false);
  assert.equal(result.recommended_maturity, "validated");
  assert.ok(result.blockers.includes("VALIDATION_EVIDENCE_REQUIRED"));
});

test("repeated testing can promote corroborated knowledge to validated", () => {
  const result = evaluatePromotion(corroboratedResult, [
    support("family-a"),
    support("family-b"),
    support("system-run-1", "repeated_test")
  ]);
  assert.equal(result.eligible, true);
  assert.equal(result.recommended_maturity, "validated");
});

test("validated knowledge remains validated without requesting another promotion", () => {
  const alreadyValidated = { ...corroboratedResult, maturity: "validated" as const };
  const result = evaluatePromotion(alreadyValidated, [
    support("family-a"),
    support("system-run-1", "repeated_test")
  ]);
  assert.equal(result.eligible, false);
  assert.equal(result.recommended_maturity, "validated");
  assert.ok(result.blockers.includes("ALREADY_VALIDATED"));
});
