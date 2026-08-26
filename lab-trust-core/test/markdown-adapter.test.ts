import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseKnowledgeMarkdown } from "../src/markdown/parse.js";

const completePath = new URL("./fixtures/complete-source.md", import.meta.url);
const legacyPath = new URL("./fixtures/legacy-result.md", import.meta.url);

test("maps complete Source trust metadata and Chinese claim types", async () => {
  const markdown = await readFile(completePath, "utf8");
  const result = parseKnowledgeMarkdown(markdown, {
    path: "sources/complete-source.md"
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.record.id, "sources/complete-source");
  assert.equal(result.record.record_type, "source");
  assert.equal(result.record.maturity, "seed");
  assert.equal(result.record.source_family, "synthetic-creator-a");
  assert.deepEqual(result.record.allowed_uses, [
    "copywriting_inspiration",
    "experiment_hypothesis"
  ]);
  assert.deepEqual(result.record.disallowed_uses, [
    "default_answer",
    "operational_decision",
    "public_factual_claim"
  ]);
  assert.equal(result.record.claims[0]?.claim_type, "rhetoric_strategy");
  assert.deepEqual(result.record.claims[0]?.counterevidence, []);
});

test("rejects a legacy page without maturity instead of guessing validated", async () => {
  const markdown = await readFile(legacyPath, "utf8");
  const result = parseKnowledgeMarkdown(markdown, {
    path: "methods/legacy-result.md"
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_MATURITY"));
  assert.equal("record" in result, false);
});

test("normalizes Obsidian links to IDs and drops aliases and fragments", async () => {
  const legacy = await readFile(legacyPath, "utf8");
  const markdown = legacy.replace(
    "evidence_status:",
    "maturity: corroborated\nevidence_status:"
  );
  const result = parseKnowledgeMarkdown(markdown, {
    path: "methods/legacy-result.md"
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.record.evidence_refs, [
    "sources/synthetic-a",
    "sources/synthetic-b"
  ]);
  assert.deepEqual(result.record.claims[0]?.direct_evidence, [
    "sources/synthetic-a",
    "sources/synthetic-b"
  ]);
  assert.equal(JSON.stringify(result.record).includes("untrusted display text"), false);
  assert.equal(JSON.stringify(result.record).includes("verbose display label"), false);
});

test("reports malformed frontmatter lists precisely", async () => {
  const markdown = (await readFile(completePath, "utf8")).replace(
    "allowed_uses:\n  - copywriting_inspiration\n  - experiment_hypothesis",
    "allowed_uses: copywriting_inspiration"
  );
  const result = parseKnowledgeMarkdown(markdown, {
    path: "sources/malformed.md"
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "MALFORMED_LIST" && issue.path === "$.allowed_uses"
    )
  );
});

test("reports duplicate claim headings", async () => {
  const markdown = await readFile(completePath, "utf8");
  const claimBlock = markdown.slice(markdown.indexOf("### C-01"));
  const result = parseKnowledgeMarkdown(`${markdown}\n${claimBlock}`, {
    path: "sources/duplicate.md"
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.code === "DUPLICATE_CLAIM_ID"));
});
