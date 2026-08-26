import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanFiles } from "../scripts/privacy-check.js";

async function fixture(relativePath: string, content: string): Promise<{
  root: string;
  file: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "trust-privacy-"));
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return { root, file };
}

test("rejects personal absolute home paths", async () => {
  const { root, file } = await fixture(
    "README.md",
    `Open ${"/" + "Users"}/example/private/page.md`
  );
  const findings = await scanFiles([file], { root });
  assert.ok(findings.some((finding) => finding.code === "PERSONAL_HOME_PATH"));
});

test("rejects private proposal-queue references", async () => {
  const { root, file } = await fixture(
    "notes.md",
    `Read ${".gbrain" + "/" + "change-proposals"}/pending.json`
  );
  const findings = await scanFiles([file], { root });
  assert.ok(findings.some((finding) => finding.code === "PRIVATE_PROPOSAL_PATH"));
});

test("rejects private-key material and credential values", async () => {
  const { root, file } = await fixture(
    "config.txt",
    `${"-----BEGIN " + "PRIVATE KEY-----"}\nabc\n${
      "-----END " + "PRIVATE KEY-----"
    }\n${"api_" + "key"}=${"super-" + "secret-value"}`
  );
  const findings = await scanFiles([file], { root });
  assert.ok(findings.some((finding) => finding.code === "PRIVATE_KEY_MATERIAL"));
  assert.ok(findings.some((finding) => finding.code === "CREDENTIAL_VALUE"));
});

test("rejects database files and private Vault directories", async () => {
  const database = await fixture("cache/index.sqlite", "binary-ish");
  const vault = await fixture("private-vault/page.md", "synthetic text");
  const databaseFindings = await scanFiles([database.file], { root: database.root });
  const vaultFindings = await scanFiles([vault.file], { root: vault.root });
  assert.ok(databaseFindings.some((finding) => finding.code === "DATABASE_FILE"));
  assert.ok(vaultFindings.some((finding) => finding.code === "PRIVATE_VAULT_PATH"));
});

test("allows documented environment-variable names without values", async () => {
  const { root, file } = await fixture(
    "integration.md",
    "Set LAB_TRUST_ALLOWED_ROOTS. GitHub users may rely on GITHUB_TOKEN from their keychain."
  );
  assert.deepEqual(await scanFiles([file], { root }), []);
});
