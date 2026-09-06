#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalHybridIndex, nativeIndexRootFor } from "./gateway/retrieval-index.mjs";
import { resolveRuntimePaths } from "./gateway/runtime-paths.mjs";
import { deriveSchemaRuntime, readSchemaPack } from "./gateway/schema-pack.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const runtimePaths = resolveRuntimePaths();
const schemaRuntime = deriveSchemaRuntime(readSchemaPack(root));
const index = new LocalHybridIndex({
  root,
  indexRoot: nativeIndexRootFor(root, runtimePaths.stateRoot),
  schemaRuntime,
});
const verification = index.verifyCommit(head);
if (!verification.ok) {
  console.error(JSON.stringify(verification, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  git_commit: head,
  pages: verification.pages,
  chunks: verification.chunks,
  embedding_coverage_pct: verification.embedding_coverage_pct,
  source_tree_sha256: verification.source_tree_sha256,
}, null, 2));
