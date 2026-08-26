import { TrustInputError } from "./errors.js";
import {
  EvidenceObservationSchema,
  type EvidenceObservation,
  type PromotionAssessment
} from "./model.js";
import { validateRecord } from "./validate.js";

function distinctFamilies(
  observations: EvidenceObservation[],
  relation: EvidenceObservation["relation"]
): Set<string> {
  return new Set(
    observations
      .filter((observation) => observation.relation === relation)
      .map((observation) => observation.source_family.trim())
      .filter(Boolean)
  );
}

export function evaluatePromotion(
  inputRecord: unknown,
  inputEvidence: unknown
): PromotionAssessment {
  const validation = validateRecord(inputRecord);
  if (!validation.ok) {
    throw new TrustInputError("RECORD_INVALID", JSON.stringify(validation.issues));
  }

  const parsedEvidence = EvidenceObservationSchema.array().safeParse(inputEvidence);
  if (!parsedEvidence.success) {
    throw new TrustInputError("EVIDENCE_INVALID", parsedEvidence.error.message);
  }

  const record = validation.record;
  const evidence = parsedEvidence.data;
  const supportFamilies = distinctFamilies(evidence, "supports");
  const contradictingFamilies = distinctFamilies(evidence, "contradicts");
  const blockers: string[] = [];
  const verificationRequirements: string[] = [];
  const hasMissingFamily = evidence.some(
    (observation) => observation.source_family.trim().length === 0
  );

  if (record.maturity === "validated") {
    blockers.push("ALREADY_VALIDATED");
    return {
      eligible: false,
      current_maturity: record.maturity,
      recommended_maturity: "validated",
      distinct_supporting_families: supportFamilies.size,
      distinct_contradicting_families: contradictingFamilies.size,
      blockers,
      verification_requirements: []
    };
  }

  if (hasMissingFamily) {
    blockers.push("MISSING_SOURCE_FAMILY");
    verificationRequirements.push("Identify the upstream source family before counting this evidence");
  }

  if (contradictingFamilies.size > 0) {
    blockers.push("CONFLICTING_EVIDENCE");
    verificationRequirements.push("Resolve or explicitly bound the contradictory evidence");
  }

  const recommendedMaturity =
    record.maturity === "seed" ? "corroborated" : "validated";

  if (record.maturity === "seed" && supportFamilies.size < 2) {
    blockers.push("INSUFFICIENT_INDEPENDENT_FAMILIES");
    verificationRequirements.push("Add support from at least two genuinely independent source families");
  }

  if (record.maturity === "corroborated") {
    const hasValidationEvidence = evidence.some(
      (observation) =>
        observation.relation === "supports" &&
        (observation.evidence_kind === "repeated_test" ||
          observation.evidence_kind === "high_quality_evidence")
    );
    if (!hasValidationEvidence) {
      blockers.push("VALIDATION_EVIDENCE_REQUIRED");
      verificationRequirements.push("Add repeated testing or high-quality evidence within the declared scope");
    }
  }

  return {
    eligible: blockers.length === 0,
    current_maturity: record.maturity,
    recommended_maturity: recommendedMaturity,
    distinct_supporting_families: supportFamilies.size,
    distinct_contradicting_families: contradictingFamilies.size,
    blockers: [...new Set(blockers)],
    verification_requirements: [...new Set(verificationRequirements)]
  };
}
