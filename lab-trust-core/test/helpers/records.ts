import type { KnowledgeRecord } from "../../src/model.js";

export const seedRhetoricRecord: KnowledgeRecord = {
  id: "source-rhetoric-001",
  record_type: "source",
  title: "Synthetic low-friction sales rhetoric",
  maturity: "seed",
  evidence_status: "One external source family; persuasive result is observed but causal claims are unverified.",
  provenance_class: "external",
  source_family: "synthetic-creator-a",
  allowed_uses: ["copywriting_inspiration", "experiment_hypothesis"],
  disallowed_uses: ["default_answer", "operational_decision", "public_factual_claim"],
  scope: ["attention-stage sales copy"],
  failure_conditions: ["the wording implies an unsupported guarantee"],
  evidence_refs: [],
  claims: [
    {
      claim_id: "C-01",
      statement: "A low-friction promise may increase initial attention.",
      claim_type: "rhetoric_strategy",
      direct_evidence: ["synthetic transcript line 12"],
      sample_size: 1,
      interest_disclosure: "The speaker sells a related service.",
      allowed_uses: ["copywriting_inspiration", "experiment_hypothesis"],
      disallowed_uses: ["default_answer", "operational_decision", "public_factual_claim"],
      counterevidence: [],
      evidence_gaps: ["No controlled conversion evidence"],
      scope: ["attention-stage sales copy"],
      failure_conditions: ["the promise cannot be operationally supported"],
      next_verification: ["Run an attributed A/B test without factual guarantees"]
    }
  ]
};

export const validatedSourceFact: KnowledgeRecord = {
  ...seedRhetoricRecord,
  id: "source-fact-001",
  maturity: "validated",
  allowed_uses: ["public_factual_claim"],
  disallowed_uses: [],
  claims: [
    {
      ...seedRhetoricRecord.claims[0]!,
      claim_id: "C-FACT",
      claim_type: "fact",
      allowed_uses: ["public_factual_claim"],
      disallowed_uses: [],
      evidence_gaps: []
    }
  ]
};

export const corroboratedResult: KnowledgeRecord = {
  id: "result-method-001",
  record_type: "result",
  title: "Synthetic bounded operating method",
  maturity: "corroborated",
  evidence_status: "Supported by two independent synthetic source families.",
  allowed_uses: ["low_risk_action", "default_answer", "operational_decision"],
  disallowed_uses: ["high_risk_decision", "public_factual_claim"],
  scope: ["ordinary internal workflow"],
  failure_conditions: ["legal, medical, financial, or safety-critical use"],
  evidence_refs: ["source-a", "source-b"],
  claims: [
    {
      claim_id: "C-METHOD",
      statement: "The bounded workflow is repeatable in ordinary internal operations.",
      claim_type: "fact",
      direct_evidence: ["source-a", "source-b"],
      sample_size: 2,
      interest_disclosure: "No direct commercial incentive is known.",
      allowed_uses: ["low_risk_action", "default_answer", "operational_decision"],
      disallowed_uses: ["high_risk_decision", "public_factual_claim"],
      counterevidence: [],
      evidence_gaps: ["No high-risk validation"],
      scope: ["ordinary internal workflow"],
      failure_conditions: ["high-risk use"],
      next_verification: ["Run controlled high-risk review before expanding scope"]
    }
  ]
};

export const validatedResult: KnowledgeRecord = {
  ...corroboratedResult,
  id: "result-validated-001",
  maturity: "validated",
  allowed_uses: ["low_risk_action", "default_answer", "operational_decision", "public_factual_claim"],
  disallowed_uses: []
};

export const validatedButDisallowed: KnowledgeRecord = {
  ...validatedResult,
  id: "result-disallowed-001",
  allowed_uses: ["low_risk_action", "default_answer", "operational_decision"],
  disallowed_uses: ["public_factual_claim"]
};
