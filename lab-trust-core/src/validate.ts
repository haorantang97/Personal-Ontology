import { KnowledgeRecordSchema, type IntendedUse, type KnowledgeRecord } from "./model.js";

export type ValidationIssue = {
  code: string;
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; record: KnowledgeRecord }
  | { ok: false; issues: ValidationIssue[] };

function formatPath(path: PropertyKey[]): string {
  return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}

function overlappingUses(
  allowed: IntendedUse[],
  disallowed: IntendedUse[]
): IntendedUse[] {
  const denied = new Set(disallowed);
  return [...new Set(allowed.filter((use) => denied.has(use)))];
}

export function validateRecord(input: unknown): ValidationResult {
  const parsed = KnowledgeRecordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "SCHEMA_INVALID",
        path: formatPath(issue.path),
        message: issue.message
      }))
    };
  }

  const record = parsed.data;
  const issues: ValidationIssue[] = [];

  const recordOverlap = overlappingUses(record.allowed_uses, record.disallowed_uses);
  if (recordOverlap.length > 0) {
    issues.push({
      code: "USE_CONFLICT",
      path: "$.allowed_uses",
      message: `Uses cannot be both allowed and disallowed: ${recordOverlap.join(", ")}`
    });
  }

  const seenClaimIds = new Set<string>();
  for (const [index, claim] of record.claims.entries()) {
    if (seenClaimIds.has(claim.claim_id)) {
      issues.push({
        code: "DUPLICATE_CLAIM_ID",
        path: `$.claims.${index}.claim_id`,
        message: `Duplicate claim_id '${claim.claim_id}'`
      });
    }
    seenClaimIds.add(claim.claim_id);

    const claimOverlap = overlappingUses(claim.allowed_uses, claim.disallowed_uses);
    if (claimOverlap.length > 0) {
      issues.push({
        code: "CLAIM_USE_CONFLICT",
        path: `$.claims.${index}.allowed_uses`,
        message: `Claim uses cannot be both allowed and disallowed: ${claimOverlap.join(", ")}`
      });
    }
  }

  if (record.record_type === "source") {
    if (!record.source_family) {
      issues.push({
        code: "SOURCE_FAMILY_REQUIRED",
        path: "$.source_family",
        message: "Source records require source_family"
      });
    }
    if (!record.provenance_class) {
      issues.push({
        code: "PROVENANCE_REQUIRED",
        path: "$.provenance_class",
        message: "Source records require provenance_class"
      });
    }
  }

  if (record.record_type === "result" && record.evidence_refs.length === 0) {
    issues.push({
      code: "RESULT_EVIDENCE_REQUIRED",
      path: "$.evidence_refs",
      message: "Result records require at least one evidence reference"
    });
  }

  return issues.length === 0 ? { ok: true, record } : { ok: false, issues };
}
