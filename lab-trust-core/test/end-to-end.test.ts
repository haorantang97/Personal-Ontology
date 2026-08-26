import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { evaluateUse } from "../src/evaluate-use.js";
import { parseKnowledgeMarkdown } from "../src/markdown/parse.js";
import { createTrustToolHandlers } from "../src/mcp/tools.js";
import { serializeVerdict } from "../src/serialize.js";

function contract(value: Record<string, unknown>) {
  return {
    decision: value.decision,
    reason_codes: value.reason_codes,
    policy_id: value.policy_id,
    policy_version: value.policy_version
  };
}

test("SDK, CLI, and MCP return the same public verdict contract", async () => {
  const file = "examples/obsidian/seed-rhetoric.md";
  const markdown = await readFile(file, "utf8");
  const parsed = parseKnowledgeMarkdown(markdown, { path: file });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const context = {
    intended_use: "copywriting_inspiration",
    risk_level: "ordinary"
  } as const;
  const sdk = serializeVerdict(evaluateUse(parsed.record, context));

  let stdout = "";
  let stderr = "";
  const status = await runCli(
    ["evaluate", file, "--use", context.intended_use, "--json"],
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      }
    }
  );
  assert.equal(status, 0, stderr);
  const cli = JSON.parse(stdout) as Record<string, unknown>;

  const handlers = createTrustToolHandlers({ allowedRoots: [] });
  const mcp = await handlers.trust_evaluate({ record: parsed.record, context });

  assert.deepEqual(contract(cli), contract(sdk));
  assert.deepEqual(contract(mcp.structuredContent), contract(sdk));
});
