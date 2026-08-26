import { parse as parseYaml } from "yaml";

import type { ClaimType, IntendedUse, KnowledgeRecord } from "../model.js";
import { validateRecord, type ValidationIssue } from "../validate.js";

export type ParseKnowledgeMarkdownOptions = {
  path?: string;
};

export type MarkdownParseResult =
  | { ok: true; record: KnowledgeRecord }
  | { ok: false; issues: ValidationIssue[] };

type Frontmatter = Record<string, unknown>;
type ParsedField = { kind: "scalar"; value: string } | { kind: "list"; value: string[] };

const RECORD_TYPE_MAP: Record<string, KnowledgeRecord["record_type"]> = {
  source: "source",
  project: "result",
  decision: "result",
  methodology: "result",
  method: "result",
  synthesis: "result",
  concept: "result"
};

const CLAIM_TYPE_MAP: Record<string, ClaimType> = {
  "事实": "fact",
  "来源观点": "source_opinion",
  "Agent 推断": "agent_inference",
  "宣传主张": "promotional_claim",
  "话术策略": "rhetoric_strategy",
  "待验证假设": "unverified_hypothesis"
};

const CLAIM_FIELDS = {
  statement: "陈述",
  claimType: "类型",
  directEvidence: "直接依据",
  sampleSize: "样本量",
  interestDisclosure: "利益关系",
  allowedUses: "允许用途",
  disallowedUses: "禁止用途",
  counterevidence: "反证",
  evidenceGaps: "证据缺口",
  scope: "适用范围",
  failureConditions: "失效条件",
  nextVerification: "下一步验证"
} as const;

function isObject(value: unknown): value is Frontmatter {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(
  issues: ValidationIssue[],
  code: string,
  path: string,
  message: string
): void {
  issues.push({ code, path, message });
}

function cleanInlineValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizedDocumentId(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\.md$/i, "");
}

function stringValue(
  frontmatter: Frontmatter,
  key: string,
  issues: ValidationIssue[],
  options: { code?: string; required?: boolean } = {}
): string | undefined {
  const value = frontmatter[key];
  if (value === undefined || value === null || value === "") {
    if (options.required !== false) {
      addIssue(
        issues,
        options.code ?? "MISSING_FIELD",
        `$.${key}`,
        `Frontmatter field '${key}' is required`
      );
    }
    return undefined;
  }
  if (typeof value !== "string") {
    addIssue(issues, "MALFORMED_FIELD", `$.${key}`, `'${key}' must be a string`);
    return undefined;
  }
  return value;
}

function stringList(
  frontmatter: Frontmatter,
  key: string,
  issues: ValidationIssue[],
  options: { required?: boolean } = {}
): string[] {
  const value = frontmatter[key];
  if (value === undefined || value === null) {
    if (options.required !== false) {
      addIssue(issues, "MISSING_FIELD", `$.${key}`, `Frontmatter list '${key}' is required`);
    }
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    addIssue(issues, "MALFORMED_LIST", `$.${key}`, `'${key}' must be a YAML list of strings`);
    return [];
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function wikiLinkTargets(value: string): string[] {
  const targets: string[] = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  for (const match of value.matchAll(pattern)) {
    const target = match[1]?.trim();
    if (target) targets.push(normalizedDocumentId(target));
  }
  return targets;
}

function normalizeEvidenceItems(values: string[]): string[] {
  return values.flatMap((value) => {
    const targets = wikiLinkTargets(value);
    return targets.length > 0 ? targets : [cleanInlineValue(value)];
  });
}

function normalizeReferenceList(
  values: string[],
  issues: ValidationIssue[],
  path: string
): string[] {
  const references: string[] = [];
  for (const value of values) {
    const targets = wikiLinkTargets(value);
    if (targets.length > 0) {
      references.push(...targets);
      continue;
    }
    const candidate = cleanInlineValue(value);
    if (candidate && !/\s/u.test(candidate) && !candidate.includes("[[")) {
      references.push(normalizedDocumentId(candidate));
    } else {
      addIssue(
        issues,
        "INVALID_EVIDENCE_REFERENCE",
        path,
        "Evidence references must be Obsidian links or reference IDs, not prose"
      );
    }
  }
  return [...new Set(references)];
}

function parseFrontmatter(
  markdown: string,
  issues: ValidationIssue[]
): { frontmatter: Frontmatter; body: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    addIssue(issues, "MISSING_FRONTMATTER", "$", "Markdown must start with YAML frontmatter");
    return { frontmatter: {}, body: markdown };
  }

  try {
    const parsed: unknown = parseYaml(match[1] ?? "");
    if (!isObject(parsed)) {
      addIssue(issues, "MALFORMED_FRONTMATTER", "$", "YAML frontmatter must be an object");
      return { frontmatter: {}, body: markdown.slice(match[0].length) };
    }
    return { frontmatter: parsed, body: markdown.slice(match[0].length) };
  } catch (error) {
    addIssue(
      issues,
      "MALFORMED_FRONTMATTER",
      "$",
      error instanceof Error ? error.message : "YAML frontmatter could not be parsed"
    );
    return { frontmatter: {}, body: markdown.slice(match[0].length) };
  }
}

function claimSections(body: string, issues: ValidationIssue[]): Array<{
  id: string;
  body: string;
}> {
  const claimsHeading = /^##\s+Claims\s*$/im.exec(body);
  if (!claimsHeading) {
    addIssue(issues, "MISSING_CLAIMS_SECTION", "$.claims", "A '## Claims' section is required");
    return [];
  }

  const claimsStart = claimsHeading.index + claimsHeading[0].length;
  const remaining = body.slice(claimsStart);
  const nextH2 = /^##\s+/m.exec(remaining);
  const claimsBody = nextH2 ? remaining.slice(0, nextH2.index) : remaining;
  const headingPattern = /^###\s+([^\n]+?)\s*$/gm;
  const matches = [...claimsBody.matchAll(headingPattern)];
  if (matches.length === 0) {
    addIssue(issues, "MISSING_CLAIM", "$.claims", "Claims section must contain a '### C-…' claim");
    return [];
  }

  return matches.map((match, index) => {
    const heading = match[1]?.trim() ?? "";
    const id = /^(C-[A-Za-z0-9._-]+)/.exec(heading)?.[1] ?? heading;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? claimsBody.length;
    return { id, body: claimsBody.slice(start, end) };
  });
}

function parseClaimFields(body: string): Map<string, ParsedField> {
  const fields = new Map<string, ParsedField>();
  let currentLabel: string | undefined;

  for (const line of body.split(/\r?\n/)) {
    const field = /^-\s+([^：:]+)[：:]\s*(.*)$/.exec(line);
    if (field) {
      currentLabel = field[1]?.trim();
      const inline = cleanInlineValue(field[2] ?? "");
      if (currentLabel) {
        fields.set(
          currentLabel,
          inline === "[]" || !inline
            ? { kind: "list", value: [] }
            : { kind: "scalar", value: inline }
        );
      }
      continue;
    }

    const item = /^\s{2,}-\s+(.+)$/.exec(line);
    if (item && currentLabel) {
      const existing = fields.get(currentLabel);
      const value = cleanInlineValue(item[1] ?? "");
      if (existing?.kind === "list" && value) existing.value.push(value);
    }
  }
  return fields;
}

function requiredClaimScalar(
  fields: Map<string, ParsedField>,
  label: string,
  claimIndex: number,
  issues: ValidationIssue[]
): string | undefined {
  const field = fields.get(label);
  const path = `$.claims.${claimIndex}.${label}`;
  if (!field) {
    addIssue(issues, "MISSING_CLAIM_FIELD", path, `Claim field '${label}' is required`);
    return undefined;
  }
  if (field.kind !== "scalar" || !field.value) {
    addIssue(issues, "MALFORMED_CLAIM_FIELD", path, `Claim field '${label}' must be a scalar`);
    return undefined;
  }
  return field.value;
}

function requiredClaimList(
  fields: Map<string, ParsedField>,
  label: string,
  claimIndex: number,
  issues: ValidationIssue[]
): string[] {
  const field = fields.get(label);
  const path = `$.claims.${claimIndex}.${label}`;
  if (!field) {
    addIssue(issues, "MISSING_CLAIM_FIELD", path, `Claim list '${label}' is required`);
    return [];
  }
  if (field.kind !== "list") {
    addIssue(issues, "MALFORMED_CLAIM_LIST", path, `Claim field '${label}' must be a list`);
    return [];
  }
  return field.value;
}

function parseClaims(body: string, issues: ValidationIssue[]): unknown[] {
  const sections = claimSections(body, issues);
  const seen = new Set<string>();

  return sections.map((section, index) => {
    if (seen.has(section.id)) {
      addIssue(
        issues,
        "DUPLICATE_CLAIM_ID",
        `$.claims.${index}.claim_id`,
        `Duplicate claim_id '${section.id}'`
      );
    }
    seen.add(section.id);

    const fields = parseClaimFields(section.body);
    const typeLabel = requiredClaimScalar(fields, CLAIM_FIELDS.claimType, index, issues);
    const claimType = typeLabel ? CLAIM_TYPE_MAP[typeLabel] : undefined;
    if (typeLabel && !claimType) {
      addIssue(
        issues,
        "UNKNOWN_CLAIM_TYPE",
        `$.claims.${index}.claim_type`,
        `Unknown Claim type '${typeLabel}'`
      );
    }

    const sampleLabel = requiredClaimScalar(fields, CLAIM_FIELDS.sampleSize, index, issues);
    const sampleSize = sampleLabel === undefined ? undefined : Number(sampleLabel);
    if (sampleLabel !== undefined && (!Number.isInteger(sampleSize) || Number(sampleSize) < 0)) {
      addIssue(
        issues,
        "INVALID_SAMPLE_SIZE",
        `$.claims.${index}.sample_size`,
        "Claim sample size must be a non-negative integer"
      );
    }

    return {
      claim_id: section.id,
      statement: requiredClaimScalar(fields, CLAIM_FIELDS.statement, index, issues),
      claim_type: claimType,
      direct_evidence: normalizeEvidenceItems(
        requiredClaimList(fields, CLAIM_FIELDS.directEvidence, index, issues)
      ),
      sample_size: sampleSize,
      interest_disclosure: requiredClaimScalar(
        fields,
        CLAIM_FIELDS.interestDisclosure,
        index,
        issues
      ),
      allowed_uses: requiredClaimList(fields, CLAIM_FIELDS.allowedUses, index, issues),
      disallowed_uses: requiredClaimList(fields, CLAIM_FIELDS.disallowedUses, index, issues),
      counterevidence: requiredClaimList(fields, CLAIM_FIELDS.counterevidence, index, issues),
      evidence_gaps: requiredClaimList(fields, CLAIM_FIELDS.evidenceGaps, index, issues),
      scope: requiredClaimList(fields, CLAIM_FIELDS.scope, index, issues),
      failure_conditions: requiredClaimList(
        fields,
        CLAIM_FIELDS.failureConditions,
        index,
        issues
      ),
      next_verification: requiredClaimList(
        fields,
        CLAIM_FIELDS.nextVerification,
        index,
        issues
      )
    };
  });
}

function uniqueIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const signature = `${issue.code}\0${issue.path}\0${issue.message}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function parseKnowledgeMarkdown(
  markdown: string,
  options: ParseKnowledgeMarkdownOptions = {}
): MarkdownParseResult {
  const issues: ValidationIssue[] = [];
  const { frontmatter, body } = parseFrontmatter(markdown, issues);
  const path = options.path;
  const explicitId = stringValue(frontmatter, "id", issues, { required: false });
  const id = explicitId ?? (path ? normalizedDocumentId(path) : undefined);
  if (!id) addIssue(issues, "MISSING_ID", "$.id", "Provide frontmatter id or parser path");

  const type = stringValue(frontmatter, "type", issues);
  const recordType = type ? RECORD_TYPE_MAP[type.toLowerCase()] : undefined;
  if (type && !recordType) {
    addIssue(issues, "UNKNOWN_RECORD_TYPE", "$.type", `Unsupported page type '${type}'`);
  }

  const maturity = stringValue(frontmatter, "maturity", issues, {
    code: "MISSING_MATURITY"
  });
  const title = stringValue(frontmatter, "title", issues);
  const evidenceStatus = stringValue(frontmatter, "evidence_status", issues);
  const allowedUses = stringList(frontmatter, "allowed_uses", issues);
  const disallowedUses = stringList(frontmatter, "disallowed_uses", issues);
  const scope = stringList(frontmatter, "scope", issues);
  const failureConditions = stringList(frontmatter, "failure_conditions", issues);
  const provenanceClass = stringValue(frontmatter, "provenance_class", issues, {
    code: "MISSING_PROVENANCE_CLASS",
    required: recordType === "source"
  });
  const sourceFamily = stringValue(frontmatter, "source_family", issues, {
    code: "MISSING_SOURCE_FAMILY",
    required: recordType === "source"
  });
  const evidenceRefs = normalizeReferenceList(
    stringList(frontmatter, "evidence", issues, { required: recordType === "result" }),
    issues,
    "$.evidence"
  );
  const claims = parseClaims(body, issues);

  const candidate: unknown = {
    id,
    ...(path ? { path } : {}),
    record_type: recordType,
    title,
    maturity,
    evidence_status: evidenceStatus,
    ...(provenanceClass ? { provenance_class: provenanceClass } : {}),
    ...(sourceFamily ? { source_family: sourceFamily } : {}),
    allowed_uses: allowedUses as IntendedUse[],
    disallowed_uses: disallowedUses as IntendedUse[],
    scope,
    failure_conditions: failureConditions,
    claims,
    evidence_refs: evidenceRefs
  };

  const validated = validateRecord(candidate);
  if (!validated.ok) issues.push(...validated.issues);
  const allIssues = uniqueIssues(issues);
  return allIssues.length === 0 && validated.ok
    ? { ok: true, record: validated.record }
    : { ok: false, issues: allIssues };
}
