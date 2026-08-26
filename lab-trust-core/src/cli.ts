#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { TrustInputError } from "./errors.js";
import { evaluatePromotion } from "./evaluate-promotion.js";
import { evaluateUse } from "./evaluate-use.js";
import { parseKnowledgeMarkdown } from "./markdown/parse.js";
import type { KnowledgeRecord } from "./model.js";
import { serializeVerdict } from "./serialize.js";
import { validateRecord, type ValidationIssue } from "./validate.js";

type CliIO = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

type ParsedRecord =
  | { ok: true; record: KnowledgeRecord }
  | { ok: false; issues: ValidationIssue[] };

const defaultIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function emit(io: CliIO, value: unknown, json: boolean): void {
  io.stdout(`${JSON.stringify(value, null, json ? 0 : 2)}\n`);
}

function emitError(io: CliIO, error: unknown, json: boolean): void {
  const payload =
    error instanceof TrustInputError
      ? { code: error.code, message: error.message }
      : {
          code: "RUNTIME_ERROR",
          message: error instanceof Error ? error.message : String(error)
        };
  io.stderr(`${json ? JSON.stringify(payload) : `${payload.code}: ${payload.message}`}\n`);
}

async function readRecord(file: string): Promise<ParsedRecord> {
  const content = await readFile(file, "utf8");
  if (path.extname(file).toLowerCase() === ".json") {
    let input: unknown;
    try {
      input = JSON.parse(content);
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
    return validateRecord(input);
  }
  return parseKnowledgeMarkdown(content, { path: file });
}

async function walkKnowledgeFiles(root: string): Promise<string[]> {
  const metadata = await stat(root);
  if (metadata.isFile()) return [root];
  if (!metadata.isDirectory()) return [];

  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkKnowledgeFiles(candidate)));
    if (entry.isFile() && [".md", ".json"].includes(path.extname(entry.name).toLowerCase())) {
      files.push(candidate);
    }
  }
  return files;
}

function requireTarget(args: string[]): string {
  const target = args[1];
  if (!target || target.startsWith("--")) {
    throw new TrustInputError("MISSING_TARGET", "A Markdown or JSON path is required");
  }
  return target;
}

async function validateCommand(args: string[], io: CliIO, json: boolean): Promise<number> {
  const result = await readRecord(requireTarget(args));
  emit(io, result, json);
  return result.ok ? 0 : 2;
}

async function evaluateCommand(args: string[], io: CliIO, json: boolean): Promise<number> {
  const target = requireTarget(args);
  const intendedUse = option(args, "--use");
  if (!intendedUse) {
    throw new TrustInputError("MISSING_USE", "evaluate requires --use <intended_use>");
  }
  const parsed = await readRecord(target);
  if (!parsed.ok) {
    emit(io, parsed, json);
    return 2;
  }

  const riskLevel = option(args, "--risk") ?? "ordinary";
  const claimId = option(args, "--claim");
  const requestedScope = option(args, "--scope");
  const context: Record<string, unknown> = {
    intended_use: intendedUse,
    risk_level: riskLevel
  };
  if (claimId) context.claim_id = claimId;
  if (requestedScope) {
    context.scope = requestedScope.split(",").map((item) => item.trim()).filter(Boolean);
  }
  const verdict = serializeVerdict(evaluateUse(parsed.record, context));
  emit(io, verdict, json);
  return verdict.decision === "deny" ? 2 : 0;
}

async function promotionCommand(args: string[], io: CliIO, json: boolean): Promise<number> {
  const target = requireTarget(args);
  const evidencePath = option(args, "--evidence");
  if (!evidencePath) {
    throw new TrustInputError(
      "MISSING_EVIDENCE",
      "promotion-check requires --evidence <observations.json>"
    );
  }
  const parsed = await readRecord(target);
  if (!parsed.ok) {
    emit(io, parsed, json);
    return 2;
  }
  const evidence: unknown = JSON.parse(await readFile(evidencePath, "utf8"));
  const assessment = evaluatePromotion(parsed.record, evidence);
  emit(io, assessment, json);
  return assessment.eligible ? 0 : 2;
}

async function auditCommand(args: string[], io: CliIO, json: boolean): Promise<number> {
  const target = requireTarget(args);
  const files = await walkKnowledgeFiles(target);
  const results: Array<{
    path: string;
    ok: boolean;
    issues?: ValidationIssue[];
  }> = [];

  for (const file of files) {
    const parsed = await readRecord(file);
    results.push(
      parsed.ok
        ? { path: file, ok: true }
        : { path: file, ok: false, issues: parsed.issues }
    );
  }
  const invalid = results.filter((result) => !result.ok).length;
  const payload = {
    ok: invalid === 0,
    scanned: results.length,
    valid: results.length - invalid,
    invalid,
    files: results
  };
  emit(io, payload, json);
  return invalid === 0 ? 0 : 2;
}

export async function runCli(args: string[], io: CliIO = defaultIO): Promise<number> {
  const json = args.includes("--json");
  try {
    switch (args[0]) {
      case "validate":
        return await validateCommand(args, io, json);
      case "evaluate":
        return await evaluateCommand(args, io, json);
      case "promotion-check":
        return await promotionCommand(args, io, json);
      case "audit":
        return await auditCommand(args, io, json);
      default:
        throw new TrustInputError(
          "UNKNOWN_COMMAND",
          "Use validate, evaluate, promotion-check, or audit"
        );
    }
  } catch (error) {
    emitError(io, error, json);
    return 1;
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
