import { z } from "zod";

export const MaturitySchema = z.enum(["seed", "corroborated", "validated"]);
export const ProvenanceClassSchema = z.enum([
  "first_party",
  "external",
  "system_observation",
  "mixed"
]);
export const ClaimTypeSchema = z.enum([
  "fact",
  "source_opinion",
  "agent_inference",
  "promotional_claim",
  "rhetoric_strategy",
  "unverified_hypothesis"
]);
export const IntendedUseSchema = z.enum([
  "idea_generation",
  "copywriting_inspiration",
  "interview_question",
  "experiment_hypothesis",
  "low_risk_action",
  "default_answer",
  "operational_decision",
  "high_risk_decision",
  "public_factual_claim"
]);
export const RiskLevelSchema = z.enum(["ordinary", "high"]);
export const VerdictDecisionSchema = z.enum(["allow", "allow_with_limits", "deny"]);

export const ClaimSchema = z.object({
  claim_id: z.string().min(1),
  statement: z.string().min(1),
  claim_type: ClaimTypeSchema,
  direct_evidence: z.array(z.string().min(1)),
  sample_size: z.number().int().nonnegative(),
  interest_disclosure: z.string().min(1),
  allowed_uses: z.array(IntendedUseSchema),
  disallowed_uses: z.array(IntendedUseSchema),
  counterevidence: z.array(z.string().min(1)),
  evidence_gaps: z.array(z.string().min(1)),
  scope: z.array(z.string().min(1)),
  failure_conditions: z.array(z.string().min(1)),
  next_verification: z.array(z.string().min(1))
});

export const KnowledgeRecordSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).optional(),
  record_type: z.enum(["source", "result"]),
  title: z.string().min(1),
  maturity: MaturitySchema,
  evidence_status: z.string().min(1),
  provenance_class: ProvenanceClassSchema.optional(),
  source_family: z.string().min(1).optional(),
  allowed_uses: z.array(IntendedUseSchema),
  disallowed_uses: z.array(IntendedUseSchema),
  scope: z.array(z.string().min(1)),
  failure_conditions: z.array(z.string().min(1)),
  claims: z.array(ClaimSchema),
  evidence_refs: z.array(z.string().min(1)),
  policy_id: z.string().min(1).optional(),
  policy_version: z.string().min(1).optional()
});

export const EvaluationContextSchema = z.object({
  intended_use: IntendedUseSchema,
  risk_level: RiskLevelSchema,
  claim_id: z.string().min(1).optional(),
  scope: z.array(z.string().min(1)).optional()
});

export const UseRequirementSchema = z.object({
  minimum_maturity: MaturitySchema,
  source_allowed: z.boolean(),
  attribution_required: z.boolean(),
  allowed_claim_types: z.array(ClaimTypeSchema)
});

export const PolicySchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  use_requirements: z.record(IntendedUseSchema, UseRequirementSchema)
});

export const VerdictSchema = z.object({
  record_id: z.string().min(1),
  claim_id: z.string().min(1).optional(),
  intended_use: IntendedUseSchema,
  decision: VerdictDecisionSchema,
  effective_maturity: MaturitySchema,
  reason_codes: z.array(z.string().min(1)),
  explanation: z.string(),
  required_attribution: z.boolean(),
  required_caveats: z.array(z.string()),
  evidence_gaps: z.array(z.string()),
  promotion_blockers: z.array(z.string()),
  policy_id: z.string().min(1),
  policy_version: z.string().min(1)
});

export const EvidenceObservationSchema = z.object({
  id: z.string().min(1),
  source_family: z.string(),
  relation: z.enum(["supports", "contradicts"]),
  evidence_kind: z.enum([
    "external_claim",
    "first_party_event",
    "system_observation",
    "repeated_test",
    "high_quality_evidence"
  ]),
  scope: z.array(z.string().min(1))
});

export const PromotionAssessmentSchema = z.object({
  eligible: z.boolean(),
  current_maturity: MaturitySchema,
  recommended_maturity: MaturitySchema,
  distinct_supporting_families: z.number().int().nonnegative(),
  distinct_contradicting_families: z.number().int().nonnegative(),
  blockers: z.array(z.string().min(1)),
  verification_requirements: z.array(z.string().min(1))
});

export type Maturity = z.infer<typeof MaturitySchema>;
export type ProvenanceClass = z.infer<typeof ProvenanceClassSchema>;
export type ClaimType = z.infer<typeof ClaimTypeSchema>;
export type IntendedUse = z.infer<typeof IntendedUseSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type KnowledgeRecord = z.infer<typeof KnowledgeRecordSchema>;
export type EvaluationContext = z.infer<typeof EvaluationContextSchema>;
export type UseRequirement = z.infer<typeof UseRequirementSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type EvidenceObservation = z.infer<typeof EvidenceObservationSchema>;
export type PromotionAssessment = z.infer<typeof PromotionAssessmentSchema>;
