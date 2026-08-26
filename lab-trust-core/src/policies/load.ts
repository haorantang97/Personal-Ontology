import { TrustInputError } from "../errors.js";
import { PolicySchema, type IntendedUse, type Maturity, type Policy } from "../model.js";
import { DEFAULT_POLICY } from "./default.js";

const maturityRank: Record<Maturity, number> = {
  seed: 0,
  corroborated: 1,
  validated: 2
};

function weakensRequirement(policy: Policy, use: IntendedUse): boolean {
  const base = DEFAULT_POLICY.use_requirements[use];
  const next = policy.use_requirements[use];
  return (
    maturityRank[next.minimum_maturity] < maturityRank[base.minimum_maturity] ||
    (!base.source_allowed && next.source_allowed) ||
    (base.attribution_required && !next.attribution_required) ||
    next.allowed_claim_types.some((claimType) => !base.allowed_claim_types.includes(claimType))
  );
}

export function loadPolicy(policyDocument: unknown): Policy {
  const parsed = PolicySchema.safeParse(policyDocument);
  if (!parsed.success) {
    throw new TrustInputError("POLICY_INVALID", parsed.error.message);
  }

  const policy = parsed.data;
  if (
    policy.id === DEFAULT_POLICY.id &&
    (Object.keys(policy.use_requirements) as IntendedUse[]).some((use) =>
      weakensRequirement(policy, use)
    )
  ) {
    throw new TrustInputError(
      "POLICY_WEAKENING_REQUIRES_DISTINCT_ID",
      "A policy that weakens the default requirements must use a distinct policy ID"
    );
  }
  return policy;
}
