import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveRuntimePaths({
  homeDirectory = os.homedir(),
  stateRoot = process.env.AGENT_KNOWLEDGE_STATE_DIR,
} = {}) {
  const root = path.resolve(stateRoot || path.join(homeDirectory, ".agent-knowledge"));
  const proposalRoot = path.join(root, "proposals");
  const lockRoot = path.join(root, "locks");
  return {
    stateRoot: root,
    proposalRoot,
    pendingDir: path.join(proposalRoot, "pending"),
    appliedDir: path.join(proposalRoot, "applied"),
    rejectedDir: path.join(proposalRoot, "rejected"),
    approvalLockPath: path.join(lockRoot, "proposal-apply.lock"),
  };
}

export function initializeRuntimePaths(options = {}) {
  const paths = resolveRuntimePaths(options);
  for (const directory of [paths.stateRoot, path.dirname(paths.approvalLockPath),
    paths.pendingDir, paths.appliedDir, paths.rejectedDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return { ...paths };
}
