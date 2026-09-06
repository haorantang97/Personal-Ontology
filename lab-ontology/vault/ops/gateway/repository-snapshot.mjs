import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Provider-neutral immutable Git snapshot. Never reads uncommitted metadata.
export function createRepositorySnapshot(root, commit, { temporaryDirectoryFactory = mkdtempSync } = {}) {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit || "")
    || git(["rev-parse", "--verify", `${commit}^{commit}`]) !== commit) throw new Error("A full immutable Git commit is required");
  if (realpathSync(root) !== realpathSync(git(["rev-parse", "--show-toplevel"]))) throw new Error("root must be the exact Git repository root");
  const temporary = temporaryDirectoryFactory(path.join(os.tmpdir(), "knowledge-repository-snapshot-"));
  const snapshotRoot = path.join(temporary, "snapshot");
  try { git(["worktree", "add", "--detach", snapshotRoot, commit]); }
  catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
  let closed = false;
  return { root: snapshotRoot, commit, close() {
    if (closed) return;
    // On failed removal retain the registered snapshot for inspection; do not
    // hide cleanup failure and publish a falsely successful generation.
    git(["worktree", "remove", "--force", snapshotRoot]);
    rmSync(temporary, { recursive: true, force: true }); closed = true;
  } };
}

export function withRepositorySnapshot(root, commit, callback, options) {
  const snapshot = createRepositorySnapshot(root, commit, options);
  let result;
  try { result = callback(snapshot.root); }
  catch (error) { snapshot.close(); throw error; }
  if (result && typeof result.then === "function") return Promise.resolve(result).finally(() => snapshot.close());
  snapshot.close(); return result;
}
