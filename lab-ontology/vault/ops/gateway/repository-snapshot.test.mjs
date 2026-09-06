import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withRepositorySnapshot } from "./repository-snapshot.mjs";
import {
  validateRetrievalPolicy,
  validateRetrievalPolicyProposal,
} from "./retrieval-coordinator.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "repository-snapshot-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(root, "page.md"), "committed");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return { root, git, commit: git("rev-parse", "HEAD") };
}

test("neutral snapshot excludes dirty and untracked content", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "page.md"), "dirty");
  writeFileSync(path.join(f.root, "untracked"), "private");
  let directory;
  assert.equal(withRepositorySnapshot(f.root, f.commit, (root) => {
    directory = root;
    assert.equal(readFileSync(path.join(root, "page.md"), "utf8"), "committed");
    assert(!existsSync(path.join(root, "untracked")));
    return 42;
  }), 42);
  assert(!existsSync(directory));
  assert.equal(readFileSync(path.join(f.root, "page.md"), "utf8"), "dirty");
});

test("neutral snapshot survives await and cleans rejected callbacks", async (t) => {
  const f = fixture(t);
  let directory;
  await assert.rejects(withRepositorySnapshot(f.root, f.commit, async (root) => {
    directory = root;
    await Promise.resolve();
    assert(existsSync(root));
    throw new Error("injected");
  }), /injected/);
  assert(!existsSync(directory));
  assert.equal(
    f.git("worktree", "list", "--porcelain").split("worktree ").length - 1,
    1,
  );
  assert.throws(() => withRepositorySnapshot(f.root, "HEAD", () => {}), /immutable/);
});

test("all production snapshot consumers use the neutral module", () => {
  for (const file of ["server.mjs", "retrieval-index.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert(source.includes('"./repository-snapshot.mjs"'));
    assert(!source.includes("withCleanWorktree"));
  }
});

test("clean installations accept only the Native v2 retrieval policy", () => {
  const policy = {
    version: 2,
    active_backend: "native",
    fallback_backend: "local_markdown_keyword",
  };
  assert.deepEqual(validateRetrievalPolicy(policy), policy);
  assert.deepEqual(validateRetrievalPolicyProposal(policy), {
    mode: "native_v2",
    policy,
  });
  assert.throws(() => validateRetrievalPolicyProposal({
    version: 1,
    active_backend: "external",
    mirror_native: true,
  }), /Invalid retrieval policy proposal/);
});
