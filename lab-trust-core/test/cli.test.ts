import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const root = process.cwd();
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const complete = "test/fixtures/complete-source.md";

async function runCli(args: string[]): Promise<CliResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(tsx, ["src/cli.ts", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("validate returns a canonical success object", async () => {
  const result = await runCli(["validate", complete, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout) as { ok: boolean; record: { maturity: string } };
  assert.equal(payload.ok, true);
  assert.equal(payload.record.maturity, "seed");
});

test("evaluate returns the same bounded seed decision without changing the file", async () => {
  const before = await readFile(complete);
  const result = await runCli([
    "evaluate",
    complete,
    "--use",
    "copywriting_inspiration",
    "--json"
  ]);
  const after = await readFile(complete);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "allow_with_limits");
  assert.deepEqual(after, before);
});

test("evaluate exits 2 for a denied policy use", async () => {
  const result = await runCli([
    "evaluate",
    complete,
    "--use",
    "operational_decision",
    "--json"
  ]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, "deny");
});

test("audit exits 2 and reports invalid legacy pages", async () => {
  const result = await runCli(["audit", "test/fixtures", "--json"]);
  assert.equal(result.status, 2, result.stderr);
  const payload = JSON.parse(result.stdout) as {
    scanned: number;
    invalid: number;
    files: Array<{ issues?: Array<{ code: string }> }>;
  };
  assert.equal(payload.scanned, 2);
  assert.equal(payload.invalid, 1);
  assert.ok(
    payload.files.some((file) => file.issues?.some((issue) => issue.code === "MISSING_MATURITY"))
  );
});

test("invalid invocation exits 1 with a stable error code", async () => {
  const result = await runCli(["evaluate", complete, "--json"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, "MISSING_USE");
});
