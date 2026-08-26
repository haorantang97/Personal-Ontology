import { TrustInputError } from "./errors.js";
import { explainReasonCodes } from "./explain.js";
import {
  EvaluationContextSchema,
  type Claim,
  type EvaluationContext,
  type Maturity,
  type Policy,
  type Verdict
} from "./model.js";
import { DEFAULT_POLICY } from "./policies/default.js";
import { loadPolicy } from "./policies/load.js";
import { validateRecord } from "./validate.js";

const maturityRank: Record<Maturity, number> = {
  seed: 0,
  corroborated: 1,
  validated: 2
};

export type EvaluateUseOptions = {
  policy?: unknown;
};

function intersects(left: string[], right: string[]): boolean {
  const values = new Set(left.map((value) => value.trim().toLowerCase()));
  return right.some((value) => values.has(value.trim().toLowerCase()));
}

function selectedClaim(
  claims: Claim[],
  context: EvaluationContext
): Claim | undefined {
  if (!context.claim_id) return undefined;
  const claim = claims.find((candidate) => candidate.claim_id === context.claim_id);
  if (!claim) {
    throw new TrustInputError(
      "CLAIM_NOT_FOUND",
      `Claim '${context.claim_id}' was not found in the record`
    );
  }
  return claim;
}

function effectivePolicy(options: EvaluateUseOptions): Policy {
  return options.policy === undefined ? DEFAULT_POLICY : loadPolicy(options.policy);
}

export function evaluateUse(
  inputRecord: unknown,
  inputContext: unknown,
  options: EvaluateUseOptions = {}
): Verdict {
  const validation = validateRecord(inputRecord);
  if (!validation.ok) {
    throw new TrustInputError("RECORD_INVALID", JSON.stringify(validation.issues));
  }

  const parsedContext = EvaluationContextSchema.safeParse(inputContext);
  if (!parsedContext.success) {
    throw new TrustInputError("CONTEXT_INVALID", parsedContext.error.message);
  }

  const record = validation.record;
  const context = parsedContext.data;
  const policy = effectivePolicy(options);
  const requirement = policy.use_requirements[context.intended_use];
  const claim = selectedClaim(record.claims, context);
  const reasonCodes: string[] = [];

  if (
    record.disallowed_uses.includes(context.intended_use) ||
    claim?.disallowed_uses.includes(context.intended_use)
  ) {
    reasonCodes.push("EXPLICITLY_DISALLOWED");
  }

  const recordAllows =
    record.allowed_uses.length === 0 || record.allowed_uses.includes(context.intended_use);
  const claimAllows =
    !claim ||
    claim.allowed_uses.length === 0 ||
    claim.allowed_uses.includes(context.intended_use);
  if (!recordAllows || !claimAllows) {
    reasonCodes.push("USE_NOT_DECLARED_ALLOWED");
  }

  const declaredScope = claim?.scope ?? record.scope;
  if (
    context.scope &&
    context.scope.length > 0 &&
    (declaredScope.length === 0 || !intersects(declaredScope, context.scope))
  ) {
    reasonCodes.push("SCOPE_MISMATCH");
  }

  if (record.record_type === "source" && !requirement.source_allowed) {
    reasonCodes.push("SOURCE_NOT_DEFAULT_SURFACE");
  }

  if (
    (context.risk_level === "high" || context.intended_use === "high_risk_decision") &&
    record.maturity !== "validated"
  ) {
    reasonCodes.push("HIGH_RISK_REQUIRES_VALIDATED");
  } else if (
    maturityRank[record.maturity] < maturityRank[requirement.minimum_maturity]
  ) {
    reasonCodes.push("MATURITY_TOO_LOW");
  }

  if (claim && !requirement.allowed_claim_types.includes(claim.claim_type)) {
    reasonCodes.push("CLAIM_TYPE_NOT_ALLOWED");
  }

  const blockingCodes = new Set([
    "EXPLICITLY_DISALLOWED",
    "USE_NOT_DECLARED_ALLOWED",
    "SCOPE_MISMATCH",
    "SOURCE_NOT_DEFAULT_SURFACE",
    "HIGH_RISK_REQUIRES_VALIDATED",
    "MATURITY_TOO_LOW",
    "CLAIM_TYPE_NOT_ALLOWED"
  ]);
  const blocked = reasonCodes.some((code) => blockingCodes.has(code));
  const evidenceGaps = claim?.evidence_gaps ?? [];
  const requiredAttribution = requirement.attribution_required || record.record_type === "source";

  if (!blocked) {
    if (record.maturity === "seed") reasonCodes.push("SEED_LIMITED_USE");
    if (requiredAttribution) reasonCodes.push("ATTRIBUTION_REQUIRED");
    if (evidenceGaps.length > 0) reasonCodes.push("EVIDENCE_GAPS_PRESENT");
    if (reasonCodes.length === 0) reasonCodes.push("POLICY_ALLOWED");
  }

  const limited =
    !blocked &&
    (record.maturity === "seed" || requiredAttribution || evidenceGaps.length > 0);
  const decision: Verdict["decision"] = blocked
    ? "deny"
    : limited
      ? "allow_with_limits"
      : "allow";

  const base = {
    record_id: record.id,
    intended_use: context.intended_use,
    decision,
    effective_maturity: record.maturity,
    reason_codes: reasonCodes,
    explanation: explainReasonCodes(reasonCodes, "en"),
    required_attribution: requiredAttribution,
    required_caveats: [record.evidence_status, ...record.failure_conditions],
    evidence_gaps: evidenceGaps,
    promotion_blockers: blocked ? reasonCodes : evidenceGaps,
    policy_id: policy.id,
    policy_version: policy.version
  };

  return claim ? { ...base, claim_id: claim.claim_id } : base;
}
