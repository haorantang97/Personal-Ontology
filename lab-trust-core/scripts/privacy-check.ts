#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PrivacyFinding = {
  code: string;
  path: string;
  message: string;
};

export type ScanOptions = {
  root?: string;
};

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  "node_modules",
  "dist",
  "coverage"
]);
const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3", ".duckdb", ".pglite"]);
const PRIVATE_VAULT_SEGMENTS = new Set([".obsidian", ".raw", "private-vault", "vault-private"]);

function relativeDisplay(root: string, file: string): string {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") ? relative : path.basename(file);
}

function pathFindings(relativePath: string): PrivacyFinding[] {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.toLowerCase().split("/");
  const findings: PrivacyFinding[] = [];
  if (DATABASE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    findings.push({
      code: "DATABASE_FILE",
      path: normalized,
      message: "Database files must not be included in the public package"
    });
  }
  if (segments.some((segment) => PRIVATE_VAULT_SEGMENTS.has(segment))) {
    findings.push({
      code: "PRIVATE_VAULT_PATH",
      path: normalized,
      message: "Private Vault directories must not be included in the public package"
    });
  }
  if (
    segments.some(
      (segment) =>
        segment === ".env" ||
        segment === "id_rsa" ||
        segment === "id_ed25519" ||
        segment === "credentials.json"
    )
  ) {
    findings.push({
      code: "SECRET_FILE",
      path: normalized,
      message: "Secret-bearing files must not be included in the public package"
    });
  }
  return findings;
}

function contentFindings(relativePath: string, content: string): PrivacyFinding[] {
  const rules: Array<{ code: string; message: string; pattern: RegExp }> = [
    {
      code: "PERSONAL_HOME_PATH",
      message: "Personal absolute home paths must not be published",
      pattern: /(?:\/Users\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\)/
    },
    {
      code: "PRIVATE_PROPOSAL_PATH",
      message: "Private proposal-queue paths must not be published",
      pattern: /\.gbrain[\\/]change-proposals(?:[\\/]|\b)/
    },
    {
      code: "PRIVATE_KEY_MATERIAL",
      message: "Private-key material must not be published",
      pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/
    },
    {
      code: "CREDENTIAL_VALUE",
      message: "Credential assignments with values must not be published",
      pattern:
        /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|secret)\b\s*[:=]\s*["']?[^\s"'`]{8,}/i
    }
  ];
  return rules
    .filter((rule) => rule.pattern.test(content))
    .map((rule) => ({
      code: rule.code,
      path: relativePath,
      message: rule.message
    }));
}

export async function scanFiles(
  files: string[],
  options: ScanOptions = {}
): Promise<PrivacyFinding[]> {
  const root = path.resolve(options.root ?? process.cwd());
  const findings: PrivacyFinding[] = [];
  for (const input of files) {
    const file = path.resolve(input);
    const relativePath = relativeDisplay(root, file);
    findings.push(...pathFindings(relativePath));
    if (file.endsWith(".map")) continue;
    const bytes = await readFile(file);
    if (bytes.includes(0) || bytes.byteLength > 2_000_000) continue;
    findings.push(...contentFindings(relativePath, bytes.toString("utf8")));
  }
  return findings;
}

export async function collectRepositoryFiles(root = process.cwd()): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      if (entry.isFile() && entry.name !== ".git" && !entry.name.endsWith(".map")) {
        files.push(candidate);
      }
    }
  }
  await visit(path.resolve(root));
  return files;
}

export async function runPrivacyCheck(root = process.cwd()): Promise<PrivacyFinding[]> {
  return await scanFiles(await collectRepositoryFiles(root), { root });
}

const entry = process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  const findings = await runPrivacyCheck();
  if (findings.length > 0) {
    process.stderr.write(`${JSON.stringify({ ok: false, findings }, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: true, scanned: "repository" })}\n`);
  }
}
