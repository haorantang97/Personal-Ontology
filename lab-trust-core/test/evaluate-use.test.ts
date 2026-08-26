import assert from "node:assert/strict";
import test from "node:test";

import { TrustInputError } from "../src/errors.js";
import { evaluateUse } from "../src/evaluate-use.js";
import { DEFAULT_POLICY } from "../src/policies/default.js";
import { loadPolicy } from "../src/policies/load.js";
import {
  corroboratedResult,
  seedRhetoricRecord,
  validatedButDisallowed,
  validatedResult,
  validatedSourceFact
} from "./helpers/records.js";

test("allows seed rhetoric for copy inspiration with limits", () => {
  const verdict = evaluateUse(seedRhetoricRecord, {
    intended_use: "copywriting_inspiration",
    risk_level: "ordinary",
    claim_id: "C-01",
    scope: ["attention-stage sales copy"]
  });
  assert.equal(verdict.decision, "allow_with_limits");
  assert.ok(verdict.reason_codes.includes("SEED_LIMITED_USE"));
  assert.equal(verdict.required_attribution, true);
});

test("denies the same seed for an operational decision", () => {
  const verdict = evaluateUse(seedRhetoricRecord, {
    intended_use: "operational_decision",
    risk_level: "ordinary"
  });
  assert.equal(verdict.decision, "deny");
  assert.ok(verdict.reason_codes.includes("EXPLICITLY_DISALLOWED"));
});

test("denies Source evidence as a default factual answer", () => {
  const verdict = evaluateUse(validatedSourceFact, {
    intended_use: "default_answer",
    risk_level: "ordinary"
  });
  assert.equal(verdict.decision, "deny");
  assert.ok(verdict.reason_codes.includes("SOURCE_NOT_DEFAULT_SURFACE"));
});

test("high-risk use requires validated maturity", () => {
  const verdict = evaluateUse(corroboratedResult, {
    intended_use: "high_risk_decision",
    risk_level: "high"
  });
  assert.equal(verdict.decision, "deny");
  assert.ok(verdict.reason_codes.includes("HIGH_RISK_REQUIRES_VALIDATED"));
});

test("explicit disallowed use wins over validated maturity", () => {
  const verdict = evaluateUse(validatedButDisallowed, {
    intended_use: "public_factual_claim",
    risk_level: "ordinary"
  });
  assert.equal(verdict.decision, "deny");
  assert.ok(verdict.reason_codes.includes("EXPLICITLY_DISALLOWED"));
});

test("a non-empty allowed-use list acts as an explicit whitelist", () => {
  const verdict = evaluateUse(seedRhetoricRecord, {
    intended_use: "interview_question",
    risk_level: "ordinary"
  });
  assert.equal(verdict.decision, "deny");
  assert.ok(verdict.reason_codes.includes("USE_NOT_DECLARED_ALLOWED"));
});

test("validated knowledge outside its declared scope is denied", () => {
  const verdict = evaluateUse(validatedResult, {
    intended_use: "default_answer",
    risk_level: "ordinary",
    scope: ["consumer medical advice"]
  });
  assert.equal(verdict.decision, "deny");
  assert.ok(verdict.reason_codes.includes("SCOPE_MISMATCH"));
});

test("rejects an unknown intended use", () => {
  assert.throws(
    () =>
      evaluateUse(validatedResult, {
        intended_use: "invented_use",
        risk_level: "ordinary"
      } as never),
    (error: unknown) =>
      error instanceof TrustInputError && error.code === "CONTEXT_INVALID"
  );
});

test("loads a stricter custom policy", () => {
  const stricter = structuredClone(DEFAULT_POLICY);
  stricter.id = "strict-enterprise-policy";
  stricter.version = "1.0.0";
  stricter.use_requirements.low_risk_action.minimum_maturity = "validated";
  assert.equal(loadPolicy(stricter).id, "strict-enterprise-policy");
});

test("rejects silent weakening under the default policy identity", () => {
  const weaker = structuredClone(DEFAULT_POLICY);
  weaker.use_requirements.high_risk_decision.minimum_maturity = "seed";
  assert.throws(
    () => loadPolicy(weaker),
    (error: unknown) =>
      error instanceof TrustInputError &&
      error.code === "POLICY_WEAKENING_REQUIRES_DISTINCT_ID"
  );
});

test("allows explicit weakening only under a distinct policy identity", () => {
  const weaker = structuredClone(DEFAULT_POLICY);
  weaker.id = "experimental-weaker-policy";
  weaker.version = "1.0.0";
  weaker.use_requirements.high_risk_decision.minimum_maturity = "seed";
  assert.equal(loadPolicy(weaker).id, "experimental-weaker-policy");
});
