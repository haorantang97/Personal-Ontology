import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeRuntimePaths, resolveRuntimePaths } from "./runtime-paths.mjs";

function temporaryHome(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-knowledge-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("new installations use only product-owned state paths", (t) => {
  const homeDirectory = temporaryHome(t);
  const paths = initializeRuntimePaths({ homeDirectory, stateRoot: null });
  assert.deepEqual(paths, {
    stateRoot: path.join(homeDirectory, ".agent-knowledge"),
    proposalRoot: path.join(homeDirectory, ".agent-knowledge", "proposals"),
    pendingDir: path.join(homeDirectory, ".agent-knowledge", "proposals", "pending"),
    appliedDir: path.join(homeDirectory, ".agent-knowledge", "proposals", "applied"),
    rejectedDir: path.join(homeDirectory, ".agent-knowledge", "proposals", "rejected"),
    approvalLockPath: path.join(homeDirectory, ".agent-knowledge", "locks", "proposal-apply.lock"),
  });
  for (const directory of [paths.pendingDir, paths.appliedDir, paths.rejectedDir,
    path.dirname(paths.approvalLockPath)]) assert.equal(existsSync(directory), true);
});

test("an explicit state root isolates every runtime artifact", (t) => {
  const homeDirectory = temporaryHome(t);
  const stateRoot = path.join(homeDirectory, "isolated", "state");
  const paths = initializeRuntimePaths({ homeDirectory, stateRoot });
  assert.equal(paths.stateRoot, stateRoot);
  assert.equal(paths.proposalRoot.startsWith(`${stateRoot}${path.sep}`), true);
  assert.equal(paths.approvalLockPath.startsWith(`${stateRoot}${path.sep}`), true);
});

test("resolution is side-effect free", (t) => {
  const homeDirectory = temporaryHome(t);
  const paths = resolveRuntimePaths({ homeDirectory, stateRoot: null });
  assert.equal(existsSync(paths.stateRoot), false);
});
