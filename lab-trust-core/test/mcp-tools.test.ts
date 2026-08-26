import assert from "node:assert/strict";
import test from "node:test";

import { evaluateUse } from "../src/evaluate-use.js";
import {
  TRUST_TOOL_DEFINITIONS,
  createTrustToolHandlers
} from "../src/mcp/tools.js";
import { seedRhetoricRecord } from "./helpers/records.js";

test("trust_evaluate returns the core verdict as structured content", async () => {
  const context = {
    intended_use: "copywriting_inspiration",
    risk_level: "ordinary"
  } as const;
  const handlers = createTrustToolHandlers({ allowedRoots: [] });
  const result = await handlers.trust_evaluate({
    record: seedRhetoricRecord,
    context
  });

  assert.deepEqual(result.structuredContent, evaluateUse(seedRhetoricRecord, context));
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), result.structuredContent);
});

test("payload validation is available without filesystem permission", async () => {
  const handlers = createTrustToolHandlers({ allowedRoots: [] });
  const result = await handlers.trust_validate({ record: seedRhetoricRecord });
  assert.equal(result.structuredContent.ok, true);
});

test("file input is denied when no allowed root is configured", async () => {
  const handlers = createTrustToolHandlers({ allowedRoots: [] });
  await assert.rejects(
    handlers.trust_validate({ file: "/tmp/private.md" }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FILE_ACCESS_DENIED"
  );
});

test("all MCP tools declare read-only, closed-world annotations", () => {
  assert.equal(TRUST_TOOL_DEFINITIONS.length, 3);
  for (const definition of TRUST_TOOL_DEFINITIONS) {
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.annotations.destructiveHint, false);
    assert.equal(definition.annotations.openWorldHint, false);
  }
});
