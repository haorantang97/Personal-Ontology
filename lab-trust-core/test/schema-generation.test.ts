import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseKnowledgeMarkdown } from "../src/markdown/parse.js";
import { validateRecord } from "../src/validate.js";
import { generateSchemas } from "../scripts/generate-schemas.js";

test("checked-in JSON Schemas match generated Zod schemas", async () => {
  const generated = generateSchemas();
  for (const [name, schema] of Object.entries(generated)) {
    const checkedIn = JSON.parse(
      await readFile(`schemas/${name}.schema.json`, "utf8")
    ) as unknown;
    assert.deepEqual(checkedIn, schema);
  }
});

test("synthetic JSON examples satisfy the canonical record contract", async () => {
  for (const file of [
    "examples/json/seed-rhetoric.json",
    "examples/json/corroborated-result.json"
  ]) {
    const payload: unknown = JSON.parse(await readFile(file, "utf8"));
    const result = validateRecord(payload);
    assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues));
  }
});

test("synthetic Obsidian example maps through the public adapter", async () => {
  const markdown = await readFile("examples/obsidian/seed-rhetoric.md", "utf8");
  const result = parseKnowledgeMarkdown(markdown, {
    path: "sources/seed-rhetoric.md"
  });
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.issues));
});
