import assert from "node:assert/strict";
import test from "node:test";

import { validateRecord } from "../src/validate.js";

const valid = {
  id: "source-demo-001",
  record_type: "source",
  title: "Synthetic sales-language observation",
  maturity: "seed",
  evidence_status: "One external source family; facts remain unverified.",
  provenance_class: "external",
  source_family: "synthetic-creator-a",
  allowed_uses: ["copywriting_inspiration"],
  disallowed_uses: ["default_answer", "operational_decision"],
  scope: ["low-risk sales-language experiments"],
  failure_conditions: ["the wording produces misleading factual implications"],
  claims: [
    {
      claim_id: "C-01",
      statement: "A low-friction promise may increase initial attention.",
      claim_type: "rhetoric_strategy",
      direct_evidence: ["synthetic transcript line 12"],
      sample_size: 1,
      interest_disclosure: "The speaker sells a related service.",
      allowed_uses: ["copywriting_inspiration", "experiment_hypothesis"],
      disallowed_uses: ["public_factual_claim", "high_risk_decision"],
      counterevidence: [],
      evidence_gaps: ["No controlled conversion evidence"],
      scope: ["attention-stage copy"],
      failure_conditions: ["the promise cannot be operationally supported"],
      next_verification: ["Run an attributed A/B test without factual guarantees"]
    }
  ],
  evidence_refs: []
};

function issueCodes(input: unknown): string[] {
  const result = validateRecord(input);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

test("accepts a complete seed Source", () => {
  const result = validateRecord(valid);
  assert.equal(result.ok, true);
});

test("rejects unknown maturity", () => {
  assert.ok(issueCodes({ ...valid, maturity: "certain" }).includes("SCHEMA_INVALID"));
});

test("rejects duplicate claim IDs", () => {
  assert.ok(
    issueCodes({ ...valid, claims: [valid.claims[0], valid.claims[0]] }).includes(
      "DUPLICATE_CLAIM_ID"
    )
  );
});

test("rejects overlapping record use lists", () => {
  assert.ok(
    issueCodes({ ...valid, disallowed_uses: ["copywriting_inspiration"] }).includes(
      "USE_CONFLICT"
    )
  );
});

test("rejects overlapping claim use lists", () => {
  const claim = {
    ...valid.claims[0],
    disallowed_uses: ["copywriting_inspiration"]
  };
  assert.ok(issueCodes({ ...valid, claims: [claim] }).includes("CLAIM_USE_CONFLICT"));
});

test("requires source_family for Source records", () => {
  const { source_family: removed, ...withoutFamily } = valid;
  assert.equal(typeof removed, "string");
  assert.ok(issueCodes(withoutFamily).includes("SOURCE_FAMILY_REQUIRED"));
});

test("requires provenance_class for Source records", () => {
  const { provenance_class: removed, ...withoutProvenance } = valid;
  assert.equal(typeof removed, "string");
  assert.ok(issueCodes(withoutProvenance).includes("PROVENANCE_REQUIRED"));
});

test("requires evidence references for Result records", () => {
  const resultRecord = {
    ...valid,
    id: "result-demo-001",
    record_type: "result",
    provenance_class: undefined,
    source_family: undefined,
    evidence_refs: []
  };
  assert.ok(issueCodes(resultRecord).includes("RESULT_EVIDENCE_REQUIRED"));
});
