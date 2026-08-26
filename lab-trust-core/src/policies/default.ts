import {
  ClaimTypeSchema,
  IntendedUseSchema,
  type ClaimType,
  type IntendedUse,
  type Policy,
  type UseRequirement
} from "../model.js";

const allClaimTypes = [...ClaimTypeSchema.options] as ClaimType[];
const factOnly: ClaimType[] = ["fact"];

function requirement(
  minimum_maturity: UseRequirement["minimum_maturity"],
  source_allowed: boolean,
  attribution_required: boolean,
  allowed_claim_types: ClaimType[]
): UseRequirement {
  return {
    minimum_maturity,
    source_allowed,
    attribution_required,
    allowed_claim_types
  };
}

const useRequirements = Object.fromEntries(
  IntendedUseSchema.options.map((use) => [use, requirement("validated", false, true, factOnly)])
) as Record<IntendedUse, UseRequirement>;

useRequirements.idea_generation = requirement("seed", true, false, allClaimTypes);
useRequirements.copywriting_inspiration = requirement("seed", true, true, allClaimTypes);
useRequirements.interview_question = requirement("seed", true, false, allClaimTypes);
useRequirements.experiment_hypothesis = requirement("seed", true, true, allClaimTypes);
useRequirements.low_risk_action = requirement("corroborated", false, false, factOnly);
useRequirements.default_answer = requirement("corroborated", false, false, factOnly);
useRequirements.operational_decision = requirement("corroborated", false, false, factOnly);
useRequirements.high_risk_decision = requirement("validated", false, true, factOnly);
useRequirements.public_factual_claim = requirement("validated", false, true, factOnly);

export const DEFAULT_POLICY: Policy = {
  id: "knowledge-trust-default",
  version: "1.0.0",
  use_requirements: useRequirements
};
