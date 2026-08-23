#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GBRAIN = process.env.GBRAIN_BIN || path.join(os.homedir(), ".bun/bin/gbrain");
const SOURCE_ID = process.env.GBRAIN_SOURCE_ID || "knowledge";
const TYPE_DIRECTORIES = new Map([
  ["project", "projects"],
  ["decision", "decisions"],
  ["methodology", "methods"],
  ["synthesis", "syntheses"],
  ["concept", "concepts"],
  ["source", "sources"],
]);

function runGBrain(args) {
  return execFileSync(GBRAIN, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GBRAIN_SOURCE: SOURCE_ID },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function collectMarkdown(directory, prefix = "") {
  const absolute = path.join(ROOT, directory, prefix);
  if (!existsSync(absolute)) return [];

  const slugs = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      slugs.push(...collectMarkdown(directory, relative));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      slugs.push(path.posix.join(directory, relative.slice(0, -3)));
    }
  }
  return slugs;
}

const expected = new Map();
for (const [type, directory] of TYPE_DIRECTORIES) {
  for (const slug of collectMarkdown(directory)) expected.set(slug, type);
}

const indexed = new Map();
for (const type of TYPE_DIRECTORIES.keys()) {
  const pages = JSON.parse(
    runGBrain(["call", "list_pages", JSON.stringify({ type, limit: 100, sort: "slug" })]),
  );
  if (pages.length >= 100) {
    throw new Error(`Index scope check reached GBrain's 100-page limit for type '${type}'.`);
  }
  for (const page of pages) indexed.set(page.slug, page.type);
}

const status = JSON.parse(runGBrain(["status", "--json"]));
const source = status.sync?.sources?.find((item) => item.source_id === SOURCE_ID);
if (!source) throw new Error(`GBrain source not found: ${SOURCE_ID}`);

const missing = [...expected.keys()].filter((slug) => !indexed.has(slug));
const unexpected = [...indexed.keys()].filter((slug) => !expected.has(slug));
const wrongType = [...expected].filter(
  ([slug, type]) => indexed.has(slug) && indexed.get(slug) !== type,
);

const issues = [];
if (source.pages !== expected.size) {
  issues.push(`source count ${source.pages}, expected ${expected.size}`);
}
if (missing.length) issues.push(`missing: ${missing.join(", ")}`);
if (unexpected.length) issues.push(`unexpected: ${unexpected.join(", ")}`);
if (wrongType.length) {
  issues.push(
    `wrong type: ${wrongType
      .map(([slug, type]) => `${slug}=${indexed.get(slug)} (expected ${type})`)
      .join(", ")}`,
  );
}

if (issues.length) {
  console.error(`Index scope mismatch for '${SOURCE_ID}':\n- ${issues.join("\n- ")}`);
  process.exit(1);
}

console.log(`Index scope valid: ${expected.size} pages in source '${SOURCE_ID}'`);
