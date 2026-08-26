import { realpath, readFile } from "node:fs/promises";
import path from "node:path";

import { TrustInputError } from "../errors.js";
import { evaluatePromotion } from "../evaluate-promotion.js";
import { evaluateUse } from "../evaluate-use.js";
import { parseKnowledgeMarkdown } from "../markdown/parse.js";
import type { KnowledgeRecord } from "../model.js";
import { serializeVerdict } from "../serialize.js";
import { validateRecord, type ValidationIssue } from "../validate.js";

export const TRUST_TOOL_DEFINITIONS = [
  {
    name: "trust_validate",
    description: "Validate a canonical record or read-only Markdown/JSON file against the trust contract.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "trust_evaluate",
    description: "Evaluate whether knowledge may be used for a declared purpose and risk level.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "trust_promotion_check",
    description: "Check maturity promotion using independent source families and conflicts.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
] as const;

type RecordLocator = {
  record?: unknown;
  file?: string | undefined;
};

export type TrustValidateInput = RecordLocator;
export type TrustEvaluateInput = RecordLocator & { context: unknown };
export type TrustPromotionInput = RecordLocator & { evidence: unknown };

export type TrustToolResult<T extends object> = {
  content: [{ type: "text"; text: string }];
  structuredContent: T;
};

export type TrustToolHandlerOptions = {
  allowedRoots?: string[];
};

type LoadedRecord =
  | { ok: true; record: KnowledgeRecord }
  | { ok: false; issues: ValidationIssue[] };

function result<T extends object>(payload: T): TrustToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload
  };
}

function configuredRoots(options: TrustToolHandlerOptions): string[] {
  if (options.allowedRoots !== undefined) return options.allowedRoots;
  return (process.env.LAB_TRUST_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
}

async function assertAllowedFile(
  file: string,
  options: TrustToolHandlerOptions
): Promise<string> {
  const roots = configuredRoots(options);
  if (roots.length === 0) {
    throw new TrustInputError(
      "FILE_ACCESS_DENIED",
      "File input is disabled; set LAB_TRUST_ALLOWED_ROOTS or use a payload"
    );
  }

  const canonicalFile = await realpath(file);
  const canonicalRoots = await Promise.all(roots.map(async (root) => await realpath(root)));
  const allowed = canonicalRoots.some((root) => {
    const relative = path.relative(root, canonicalFile);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
  if (!allowed) {
    throw new TrustInputError(
      "FILE_ACCESS_DENIED",
      "File is outside LAB_TRUST_ALLOWED_ROOTS"
    );
  }
  return canonicalFile;
}

function validateLocator(input: RecordLocator): void {
  const hasRecord = Object.hasOwn(input, "record") && input.record !== undefined;
  const hasFile = typeof input.file === "string" && input.file.length > 0;
  if (hasRecord === hasFile) {
    throw new TrustInputError(
      "INPUT_SOURCE_INVALID",
      "Provide exactly one of 'record' or 'file'"
    );
  }
}

async function loadRecord(
  input: RecordLocator,
  options: TrustToolHandlerOptions
): Promise<LoadedRecord> {
  validateLocator(input);
  if (input.record !== undefined) return validateRecord(input.record);

  const canonicalFile = await assertAllowedFile(input.file ?? "", options);
  const content = await readFile(canonicalFile, "utf8");
  if (path.extname(canonicalFile).toLowerCase() === ".json") {
    let payload: unknown;
    try {
      payload = JSON.parse(content);
    } catch (error) {
      return {
        ok: false,
        issues: [
          {
            code: "MALFORMED_JSON",
            path: "$",
            message: error instanceof Error ? error.message : "JSON could not be parsed"
          }
        ]
      };
    }
    return validateRecord(payload);
  }
  return parseKnowledgeMarkdown(content, { path: canonicalFile });
}

function requireValidRecord(loaded: LoadedRecord): KnowledgeRecord {
  if (!loaded.ok) {
    throw new TrustInputError("RECORD_INVALID", JSON.stringify(loaded.issues));
  }
  return loaded.record;
}

export function createTrustToolHandlers(options: TrustToolHandlerOptions = {}) {
  return {
    trust_validate: async (input: TrustValidateInput) =>
      result(await loadRecord(input, options)),

    trust_evaluate: async (input: TrustEvaluateInput) => {
      const record = requireValidRecord(await loadRecord(input, options));
      return result(serializeVerdict(evaluateUse(record, input.context)));
    },

    trust_promotion_check: async (input: TrustPromotionInput) => {
      const record = requireValidRecord(await loadRecord(input, options));
      return result(evaluatePromotion(record, input.evidence));
    }
  };
}

export type TrustToolHandlers = ReturnType<typeof createTrustToolHandlers>;
