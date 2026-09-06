#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  buildTrustInputBinding,
  observeKnowledgeTrustShadow,
  routeKnowledgeCandidates,
} from "./knowledge-router.mjs";
import { KnowledgeCatalog, NAVIGATION_INDEX_FILE } from "./knowledge-catalog.mjs";
import { LocalHybridIndex, nativeIndexRootFor } from "./retrieval-index.mjs";
import { RetrievalCoordinator, validateRetrievalPolicyProposal } from "./retrieval-coordinator.mjs";
import { routeCandidateFromHit, summarizeSearchHit } from "./retrieval-views.mjs";
import { initializeRuntimePaths } from "./runtime-paths.mjs";
import { GATEWAY_RUNTIME_VERSION, deriveSchemaRuntime, readSchemaPack, validateGatewayPackageIdentity, validateSchemaChanges } from "./schema-pack.mjs";
import { withRepositorySnapshot } from "./repository-snapshot.mjs";
import {
  assertApplyTransactionReadyToCommit,
  assertNoActiveCommitHooks,
  assertProposalChangeIsolation,
  assertProposalCanBeRejected,
  beginApplyTransaction,
  clearApplyTransaction,
  compactApplyBaseline,
  detectExactCommittedProposal,
  ensureAppliedReceiptDurable,
  finalizeAppliedArchive,
  finalizeRejectedProposalArchive,
  inflightTransactionPath,
  inspectInterruptedApply,
  proposalCommitSubject,
  readAppliedCommitReceipt,
  readRejectedProposalArchive,
  recoverInterruptedApply,
  verifyNoCommitAppliedReceipt,
  writeAppliedCommitReceipt,
  writeRejectedProposalReceipt,
} from "./proposal-store.mjs";
import { acquireProcessLock, releaseProcessLock } from "./process-lock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
validateGatewayPackageIdentity(ROOT);
const schemaRuntime = deriveSchemaRuntime(readSchemaPack(ROOT));
const SCHEMA_PATH = path.join(ROOT, "ops", "SCHEMA.md");
const AGENT_RULES_PATH = path.join(ROOT, "ops", "AGENTS.md");
const RUNTIME_PATHS = initializeRuntimePaths();
const {
  proposalRoot: PROPOSAL_ROOT,
  pendingDir: PENDING_DIR,
  appliedDir: APPLIED_DIR,
  rejectedDir: REJECTED_DIR,
  approvalLockPath: LOCK_PATH,
} = RUNTIME_PATHS;
const INFLIGHT_DIR = path.join(PROPOSAL_ROOT, "inflight");
const TEST_HOOKS_ENABLED = process.env.NODE_ENV === "test"
  && process.env.AGENT_KNOWLEDGE_TEST_HOOKS === "1";

function runTestFailpoint(name) {
  if (
    !TEST_HOOKS_ENABLED
    || process.env.AGENT_KNOWLEDGE_TEST_FAILPOINT !== name
  ) {
    return;
  }
  const markerValue = process.env.AGENT_KNOWLEDGE_TEST_FAILPOINT_MARKER;
  if (!markerValue) {
    throw new Error(`Test failpoint '${name}' requires an explicit marker path.`);
  }
  const stateRoot = path.resolve(RUNTIME_PATHS.stateRoot);
  const marker = path.resolve(markerValue);
  if (!marker.startsWith(`${stateRoot}${path.sep}`)) {
    throw new Error(`Test failpoint marker escapes the isolated state root: '${marker}'.`);
  }
  mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
  writeFileSync(marker, `${JSON.stringify({ name, pid: process.pid })}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  // Stop at an exact state boundary. The harness observes the marker and sends
  // SIGKILL, so ordinary exceptions and catch/finally cleanup cannot mask the
  // crash-recovery contract being exercised.
  process.kill(process.pid, "SIGSTOP");
}

function testApprovalLockDeadAgeMs() {
  if (!TEST_HOOKS_ENABLED) return 30_000;
  const configured = process.env.AGENT_KNOWLEDGE_TEST_LOCK_DEAD_AGE_MS;
  if (configured === undefined) return 30_000;
  const value = Number(configured);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid test-only approval lock dead-age override.");
  }
  return value;
}

const nativeIndex = new LocalHybridIndex({
  root: ROOT,
  indexRoot: nativeIndexRootFor(ROOT, RUNTIME_PATHS.stateRoot),
  schemaRuntime,
});
const retrievalCoordinator = new RetrievalCoordinator({ root: ROOT,
  native: nativeIndex, schemaRuntime });
let navigationIndexState = {
  status: "not_generated",
  file: NAVIGATION_INDEX_FILE,
  source_commit: null,
  page_count: null,
  counts: null,
  changed: false,
  error: null,
};
const RESULT_TYPES = new Set(schemaRuntime.resultTypes);
const ALL_TYPES = schemaRuntime.allTypes;
const CONTENT_PREFIXES = schemaRuntime.contentPrefixes;
const RETRIEVAL_GOVERNANCE_TARGETS = Object.freeze([
  "ops/gateway/knowledge-catalog.mjs",
  "ops/gateway/knowledge-catalog.test.mjs",
  "ops/gateway/native-index.test.mjs",
  "ops/gateway/retrieval-coordinator.mjs",
  "ops/gateway/retrieval-coordinator.test.mjs",
  "ops/gateway/retrieval-index.mjs",
  "ops/gateway/retrieval-index.test.mjs",
  "ops/gateway/retrieval-policy.json",
  "ops/gateway/retrieval-views.mjs",
  "ops/gateway/schema-pack.mjs",
  "ops/gateway/schema-pack.test.mjs",
]);
const GOVERNANCE_CREATABLE_TARGETS = new Set([
  "ops/agent-knowledge-schema/pack.json",
  "ops/validate-schema-pack.mjs",
  "ops/gateway/schema-pack.mjs",
  "ops/gateway/schema-pack.test.mjs",
  "ops/gateway/retrieval-policy.json",
  "ops/gateway/retrieval-coordinator.mjs",
  "ops/gateway/retrieval-coordinator.test.mjs",
  "ops/gateway/retrieval-views.mjs",
  "ops/gateway/repository-snapshot.mjs",
  "ops/gateway/repository-snapshot.test.mjs",
  ".gitignore",
  "ops/check-index-scope.mjs",
  "ops/gateway/knowledge-catalog.mjs",
  "ops/gateway/knowledge-catalog.test.mjs",
  "ops/gateway/knowledge-router.mjs",
  "ops/gateway/knowledge-router.test.mjs",
  "ops/gateway/proposal-store.mjs",
  "ops/gateway/proposal-store.test.mjs",
  "ops/gateway/proposal-digest.mjs",
  "ops/gateway/retrieval-index.mjs",
  "ops/gateway/retrieval-index.test.mjs",
  "ops/gateway/native-index.test.mjs",
  "ops/gateway/process-lock.mjs",
  "ops/gateway/process-lock.test.mjs",
  "ops/gateway/runtime-paths.mjs",
  "ops/gateway/runtime-paths.test.mjs",
]);
const GOVERNANCE_DELETABLE_TARGETS = new Set();
const GOVERNANCE_TARGETS = new Set([
  ".gitignore",
  "README.md",
  "ops/AGENTS.md",
  "ops/SCHEMA.md",
  "ops/check-index-scope.mjs",
  "ops/gateway/README.md",
  "ops/gateway/package-lock.json",
  "ops/gateway/package.json",
  "ops/gateway/proposal-digest.mjs",
  "ops/gateway/server.mjs",
  "ops/gateway/smoke-test.mjs",
  "ops/validate-vault.mjs",
  ...GOVERNANCE_CREATABLE_TARGETS,
]);
const ROOT_UI_ARTIFACT_EXTENSIONS = new Set([".base", ".canvas"]);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    timeout: options.timeout || 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function result(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return result({ ok: false, error: message, ...(error?.retrieval ? { retrieval: error.retrieval } : {}) }, true);
}

function committedCatalogAtHead(expectedCommit = null) {
  const commit = run("git", ["rev-parse", "HEAD"]);
  if (expectedCommit && commit !== expectedCommit) {
    throw Object.assign(new Error("Knowledge repository HEAD changed before the committed read."), {
      code: "HEAD_MISMATCH",
    });
  }
  const catalog = new KnowledgeCatalog({ root: ROOT, commit });
  return { commit, catalog, runtime: deriveSchemaRuntime(catalog.canonicalPack()) };
}

function assertCommittedReadStable(commit) {
  if (run("git", ["rev-parse", "HEAD"]) !== commit) {
    throw Object.assign(new Error("Knowledge repository HEAD changed during the committed read."), {
      code: "HEAD_CHANGED",
    });
  }
}

function committedContractText(catalog, slug) {
  const source = catalog.source(slug);
  if (!source) {
    throw Object.assign(new Error(`Committed contract is missing: ${slug}.md`), {
      code: "COMMITTED_CONTRACT_MISSING",
    });
  }
  return source.markdown;
}

function safeRelativeTarget(target, action) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("Every change needs a non-empty target.");
  }
  if (path.isAbsolute(target) || /[\u0000-\u001f\u007f]/u.test(target)) {
    throw new Error(`Absolute or invalid target is not allowed: ${target}`);
  }

  const normalized = path.posix.normalize(target.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Target escapes the knowledge repository: ${target}`);
  }

  const isRootUiArtifact =
    !normalized.includes("/")
    && ROOT_UI_ARTIFACT_EXTENSIONS.has(path.posix.extname(normalized));
  const isGovernanceDelete =
    action === "delete" && GOVERNANCE_DELETABLE_TARGETS.has(normalized);

  if (action === "schema") {
    if (!GOVERNANCE_TARGETS.has(normalized)) {
      throw new Error(`Schema/policy change cannot target '${normalized}'.`);
    }
  } else if (action === "delete" && (isRootUiArtifact || isGovernanceDelete)) {
    // Empty or accidental Obsidian Base/Canvas files may be removed through an
    // exact, hash-pinned proposal. Runtime/governance files are not deletable
    // through an ordinary knowledge proposal.
  } else if (!CONTENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`Knowledge change cannot target '${normalized}'.`);
  }

  if (
    !normalized.startsWith(".raw/")
    && action !== "schema"
    && !(action === "delete" && (isRootUiArtifact || isGovernanceDelete))
    && !normalized.endsWith(".md")
  ) {
    throw new Error(`Active knowledge pages must be Markdown: ${normalized}`);
  }
  return normalized;
}

function validateChanges(changes, { enforceIsolation = true } = {}) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100) {
    throw new Error("A proposal must contain 1 to 100 changes.");
  }

  const normalized = changes.map((change) => {
    const target = safeRelativeTarget(change.target, change.action);
    const next = { action: change.action, target };

    if (["create", "update", "schema"].includes(change.action)) {
      if (typeof change.content !== "string" || !change.content.trim()) {
        throw new Error(`${change.action} '${target}' requires full content.`);
      }
      if (change.content.includes("\0")) throw new Error(`NUL byte in '${target}'.`);
      if (target === "ops/gateway/retrieval-policy.json") validateRetrievalPolicyProposal(JSON.parse(change.content));
      next.content = change.content;
    }
    if (change.action === "move") {
      if (!change.new_target) throw new Error(`move '${target}' requires new_target.`);
      next.new_target = safeRelativeTarget(change.new_target, "move");
    }
    return next;
  });

  const touched = new Set();
  for (const change of normalized) {
    for (const target of [change.target, change.new_target].filter(Boolean)) {
      if (touched.has(target)) throw new Error(`Target appears more than once: ${target}`);
      touched.add(target);
    }
  }
  if (enforceIsolation) {
    assertProposalChangeIsolation(normalized, {
      governanceDeleteTargets: GOVERNANCE_DELETABLE_TARGETS,
    });
  }
  return normalized;
}

function proposalHash(proposal) {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

function receiptRecoveryRecord(receipt, changes) {
  if (!receipt.execution_baseline) return null;
  return {
    proposal_id: receipt.proposal.id,
    proposal_sha256: receipt.sha256,
    changes_sha256: createHash("sha256").update(JSON.stringify(changes)).digest("hex"),
    execution_parent: receipt.execution_parent,
    snapshots: receipt.execution_baseline,
  };
}

function proposalPath(id, directory = PENDING_DIR) {
  if (!/^KB-\d{8}-\d{6}-[a-f0-9]{8}$/.test(id)) {
    throw new Error("Invalid proposal id.");
  }
  return path.join(directory, `${id}.json`);
}

function readProposal(id) {
  const file = proposalPath(id);
  if (!existsSync(file)) throw new Error(`Pending proposal not found: ${id}`);
  const record = JSON.parse(readFileSync(file, "utf8"));
  if (!record.proposal || record.sha256 !== proposalHash(record.proposal)) {
    throw new Error(`Proposal integrity check failed: ${id}`);
  }
  return { file, record };
}

function readProposalState(id) {
  const pendingPath = proposalPath(id);
  const appliedPath = proposalPath(id, APPLIED_DIR);
  const rejectedPath = proposalPath(id, REJECTED_DIR);
  const pending = existsSync(pendingPath) ? readProposal(id) : null;
  const applied = readAppliedCommitReceipt({
    appliedPath,
    expectedRecord: pending?.record || null,
    proposalId: id,
  });
  const rejected = readRejectedProposalArchive({
    rejectedPath,
    expectedRecord: pending?.record || null,
    proposalId: id,
  });
  if (applied && rejected) {
    throw new Error(`Proposal has conflicting applied and rejected terminal archives: ${id}`);
  }
  return {
    pendingPath,
    appliedPath,
    rejectedPath,
    pendingRecord: pending?.record || null,
    applied,
    rejected,
  };
}

function replayAppliedTerminal({ proposalId, pendingPath, appliedPath, record, currentHead }) {
  const finalized = finalizeAppliedArchive({
    pendingPath,
    appliedPath,
    appliedRecord: record,
  });
  const persisted = finalized.record;
  runTestFailpoint("after_applied_pending_unlink_before_response");
  return result({
    ok: persisted.index_status === "synchronized",
    proposal_id: proposalId,
    approved: true,
    knowledge_modified: false,
    proposal_already_applied: true,
    replayed_terminal: true,
    git_commit: persisted.git_commit,
    current_git_commit: currentHead,
    commit_created: false,
    proposal_commit_created: persisted.commit_created ?? null,
    index_status: persisted.index_status,
    index_commit: persisted.index_commit ?? null,
    index_error: persisted.index_error ?? null,
    index_details: persisted.index_details ?? null,
    navigation_index: persisted.navigation_index ?? null,
  }, persisted.index_status !== "synchronized");
}

function acquireLock() {
  try {
    return acquireProcessLock(LOCK_PATH, {
      kind: "proposal-approval",
      timeoutMs: 0,
      pollMs: 1,
      recoverDeadOwner: true,
      minDeadAgeMs: testApprovalLockDeadAgeMs(),
    });
  } catch (error) {
    if (error?.code === "PROCESS_LOCK_TIMEOUT") {
      throw new Error("Another knowledge-base approval is already running.", { cause: error });
    }
    throw error;
  }
}

function releaseLock(lock) {
  releaseProcessLock(lock);
}

function assertNoStagedChanges() {
  try {
    run("git", ["diff", "--cached", "--quiet"]);
  } catch {
    throw new Error(
      "Knowledge repository has staged changes; approval stopped because Git cannot isolate who staged them. Commit or unstage that work before applying a proposal.",
    );
  }
}

function safeTargetAbsolute(root, target) {
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, target);
  if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Target escapes the knowledge repository: ${target}`);
  }
  let cursor = absolute;
  while (cursor !== resolvedRoot) {
    let stat = null;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(`Symlink targets are not allowed: ${target}`);
    }
    cursor = path.dirname(cursor);
  }
  return absolute;
}

function snapshotTargets(changes, root = ROOT) {
  const targets = new Set();
  for (const change of changes) {
    targets.add(change.target);
    if (change.new_target) targets.add(change.new_target);
  }

  const snapshots = new Map();
  for (const target of targets) {
    const absolute = safeTargetAbsolute(root, target);
    if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Target is not a regular file: ${target}`);
      }
      snapshots.set(target, {
        exists: true,
        content: readFileSync(absolute),
        mode: stat.mode,
      });
    } else {
      snapshots.set(target, { exists: false });
    }
  }
  return snapshots;
}

function sameTargetSnapshot(left, right) {
  if (!left || !right || left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return (left.mode & 0o777) === (right.mode & 0o777)
    && Buffer.from(left.content).equals(Buffer.from(right.content));
}

function assertSnapshotsUnchanged(expected, current) {
  if (expected.size !== current.size) {
    throw new Error("Approved targets changed while durable apply intent was being recorded.");
  }
  for (const [target, expectedSnapshot] of expected) {
    if (!sameTargetSnapshot(expectedSnapshot, current.get(target))) {
      throw new Error(
        `Approved target '${target}' changed while durable apply intent was being recorded; approval stopped without overwriting it.`,
      );
    }
  }
}

function captureProposalPreconditions(changes) {
  const snapshots = snapshotTargets(changes);

  for (const change of changes) {
    const source = snapshots.get(change.target);
    if (change.action === "create") {
      if (source.exists) {
        throw new Error(`Create target already exists: ${change.target}`);
      }
    } else if (
      !source.exists
      && !(
        change.action === "schema"
        && GOVERNANCE_CREATABLE_TARGETS.has(change.target)
      )
    ) {
      throw new Error(`${change.action} target does not exist: ${change.target}`);
    }

    if (change.action === "move" && snapshots.get(change.new_target).exists) {
      throw new Error(`Move destination exists: ${change.new_target}`);
    }
  }

  return Object.fromEntries(
    [...snapshots].map(([target, snapshot]) => [
      target,
      snapshot.exists
        ? {
            exists: true,
            sha256: createHash("sha256").update(snapshot.content).digest("hex"),
          }
        : { exists: false },
    ]),
  );
}

function assertProposalPreconditions(preconditions, snapshots) {
  if (!preconditions || typeof preconditions !== "object" || Array.isArray(preconditions)) {
    throw new Error("Proposal has no valid content baseline; recreate it before approval.");
  }

  const expectedTargets = Object.keys(preconditions).sort();
  const currentTargets = [...snapshots.keys()].sort();
  if (
    expectedTargets.length !== currentTargets.length
    || expectedTargets.some((target, index) => target !== currentTargets[index])
  ) {
    throw new Error("Proposal content baseline does not match its targets; recreate it before approval.");
  }

  for (const [target, snapshot] of snapshots) {
    const expected = preconditions[target];
    if (!expected || typeof expected.exists !== "boolean") {
      throw new Error(`Proposal has an invalid content baseline for '${target}'.`);
    }
    if (expected.exists !== snapshot.exists) {
      throw new Error(
        `Proposal is stale: '${target}' changed since proposal creation. Recreate and re-approve it.`,
      );
    }
    if (snapshot.exists) {
      const currentHash = createHash("sha256").update(snapshot.content).digest("hex");
      if (expected.sha256 !== currentHash) {
        throw new Error(
          `Proposal is stale: '${target}' changed since proposal creation. Recreate and re-approve it.`,
        );
      }
    }
  }
}

function atomicWrite(root, relative, content, { transactionToken = null } = {}) {
  let absolute = safeTargetAbsolute(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  absolute = safeTargetAbsolute(root, relative);
  const temporary = transactionToken
    ? `${absolute}.gateway-apply-${transactionToken}.tmp`
    : `${absolute}.gateway-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644 });
  chmodSync(temporary, 0o644);
  absolute = safeTargetAbsolute(root, relative);
  renameSync(temporary, absolute);
}

function refreshNavigationIndex(commit) {
  const generated = withRepositorySnapshot(ROOT, commit, (snapshotRoot) => (
    new KnowledgeCatalog({ root: snapshotRoot }).writeNavigationIndex({
      destinationRoot: ROOT,
      vaultName: path.basename(ROOT),
      sourceCommit: commit,
    })
  ));
  navigationIndexState = {
    status: "ready",
    file: generated.file,
    source_commit: generated.source_commit,
    page_count: generated.page_count,
    counts: generated.counts,
    changed: generated.changed,
    error: null,
  };
  return navigationIndexState;
}

function refreshNavigationIndexSafely(commit) {
  try {
    return refreshNavigationIndex(commit);
  } catch (error) {
    navigationIndexState = {
      status: "failed",
      file: NAVIGATION_INDEX_FILE,
      source_commit: commit || null,
      page_count: null,
      counts: null,
      changed: false,
      error: error instanceof Error ? error.message : String(error),
    };
    return navigationIndexState;
  }
}

function applyFileChanges(root, changes, {
  transactionToken = null,
  expectedSnapshots = null,
} = {}) {
  for (const [changeIndex, change] of changes.entries()) {
    if (expectedSnapshots) {
      const expectedForChange = new Map(
        [change.target, change.new_target]
          .filter(Boolean)
          .map((target) => [target, expectedSnapshots.get(target)]),
      );
      assertSnapshotsUnchanged(expectedForChange, snapshotTargets([change], root));
    }
    let absolute = safeTargetAbsolute(root, change.target);
    if (change.action === "create") {
      if (existsSync(absolute)) throw new Error(`Create target already exists: ${change.target}`);
      atomicWrite(root, change.target, change.content, { transactionToken });
    } else if (change.action === "update") {
      if (!existsSync(absolute)) throw new Error(`Update target does not exist: ${change.target}`);
      atomicWrite(root, change.target, change.content, { transactionToken });
    } else if (change.action === "schema") {
      if (!existsSync(absolute) && !GOVERNANCE_CREATABLE_TARGETS.has(change.target)) {
        throw new Error(`Update target does not exist: ${change.target}`);
      }
      atomicWrite(root, change.target, change.content, { transactionToken });
    } else if (change.action === "delete") {
      if (!existsSync(absolute)) throw new Error(`Delete target does not exist: ${change.target}`);
      rmSync(absolute);
    } else if (change.action === "move") {
      let destination = safeTargetAbsolute(root, change.new_target);
      if (!existsSync(absolute)) throw new Error(`Move source does not exist: ${change.target}`);
      if (existsSync(destination)) throw new Error(`Move destination exists: ${change.new_target}`);
      mkdirSync(path.dirname(destination), { recursive: true });
      absolute = safeTargetAbsolute(root, change.target);
      destination = safeTargetAbsolute(root, change.new_target);
      renameSync(absolute, destination);
    }
    if (transactionToken && changeIndex === 0) {
      runTestFailpoint("after_first_target_mutation");
    }
  }
}

function seedValidationWorktree(root, snapshots) {
  for (const [relative, snapshot] of snapshots) {
    const absolute = path.join(root, relative);
    if (snapshot.exists) {
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, snapshot.content, { mode: snapshot.mode });
    } else if (existsSync(absolute)) {
      rmSync(absolute);
    }
  }
}

function proposalTargets(changes) {
  return changes.flatMap((change) => [change.target, change.new_target]).filter(Boolean);
}

function validateNativeRetrievalTree(validationRoot) {
  const gatewayRoot = path.join(validationRoot, "ops/gateway");
  const required = [
    "knowledge-catalog.mjs",
    "native-index.test.mjs",
    "retrieval-coordinator.mjs",
    "retrieval-coordinator.test.mjs",
    "retrieval-index.mjs",
    "retrieval-index.test.mjs",
    "retrieval-policy.json",
    "retrieval-views.mjs",
  ];
  for (const file of required) {
    if (!existsSync(path.join(gatewayRoot, file))) {
      throw new Error(`Native retrieval installation is incomplete: ops/gateway/${file}`);
    }
  }
  const policy = JSON.parse(readFileSync(path.join(gatewayRoot, "retrieval-policy.json"), "utf8"));
  validateRetrievalPolicyProposal(policy);
  return "native_steady_state";
}

function relativeModuleImports(source) {
  const imports = [];
  const fromPattern = /^import\s+([^;]+?)\s+from\s+["'](\.[^"']+)["'];/gm;
  for (const match of source.matchAll(fromPattern)) imports.push({ clause: match[1], specifier: match[2] });
  const sideEffectPattern = /^import\s+["'](\.[^"']+)["'];/gm;
  for (const match of source.matchAll(sideEffectPattern)) imports.push({ clause: "", specifier: match[1] });
  return imports;
}

function exportedNameExists(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bexport\\s+(?:async\\s+)?(?:class|function|const|let|var)\\s+${escaped}\\b`).test(source)
    || new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}(?:\\s+as\\s+\\w+)?\\b[^}]*\\}`).test(source);
}

function validateRelativeModuleClosure(validationRoot, entry = "ops/gateway/server.mjs") {
  const pending = [entry];
  const visited = new Set();
  while (pending.length) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    visited.add(relative);
    const absolute = path.join(validationRoot, relative);
    if (!existsSync(absolute)) throw new Error(`Gateway module dependency is missing: ${relative}`);
    const source = readFileSync(absolute, "utf8");
    for (const { clause, specifier } of relativeModuleImports(source)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
      if (dependency === ".." || dependency.startsWith("../")) {
        throw new Error(`Gateway module dependency escapes the repository: ${relative} -> ${specifier}`);
      }
      const dependencyAbsolute = path.join(validationRoot, dependency);
      if (!existsSync(dependencyAbsolute)) {
        throw new Error(`Gateway module dependency is missing: ${relative} -> ${dependency}`);
      }
      const dependencySource = readFileSync(dependencyAbsolute, "utf8");
      const named = clause.match(/\{([\s\S]*?)\}/)?.[1]
        ?.split(",")
        .map((part) => part.trim().split(/\s+as\s+/)[0])
        .filter(Boolean) || [];
      for (const name of named) {
        if (!exportedNameExists(dependencySource, name)) {
          throw new Error(`Gateway module export is missing: ${dependency} -> ${name}`);
        }
      }
      if (dependency.endsWith(".mjs")) pending.push(dependency);
    }
  }
}

function validateTargetTreeServerHandshake(validationRoot) {
  const gitCommonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: validationRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  const dependencyDirectory = path.join(
    path.dirname(gitCommonDirectory),
    "ops/gateway/node_modules",
  );
  if (!existsSync(dependencyDirectory)) {
    throw new Error(`Gateway dependency directory is unavailable for target-tree startup: ${dependencyDirectory}`);
  }
  const targetDependencyLink = path.join(validationRoot, "ops/gateway/node_modules");
  if (existsSync(targetDependencyLink)) {
    throw new Error("Target-tree startup refuses an unexpected node_modules entry.");
  }
  const isolatedState = mkdtempSync(path.join(os.tmpdir(), "agent-knowledge-target-tree-"));
  try {
    symlinkSync(dependencyDirectory, targetDependencyLink, "dir");
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "proposal-validator", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n";
    const stateRoot = path.join(isolatedState, "state");
    const output = execFileSync(process.execPath, ["ops/gateway/server.mjs"], {
      cwd: validationRoot,
      input: messages,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        AGENT_KNOWLEDGE_STATE_DIR: stateRoot,
        AGENT_KNOWLEDGE_RETRIEVAL_LOCK: path.join(stateRoot, "locks/retrieval-index.lock"),
        AGENT_KNOWLEDGE_LEGACY_PROPOSAL_ROOT: path.join(isolatedState, "legacy-proposals"),
        AGENT_KNOWLEDGE_LEGACY_RETRIEVAL_LOCK: path.join(isolatedState, "legacy-retrieval.lock"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const initialized = responses.find((response) => response.id === 1)?.result;
    const tools = responses.find((response) => response.id === 2)?.result?.tools;
    const names = new Set(Array.isArray(tools) ? tools.map((tool) => tool.name) : []);
    const required = [
      "knowledge_intake",
      "knowledge_search",
      "knowledge_route",
      "knowledge_get",
      "knowledge_repair_index",
      "knowledge_propose_changes",
      "knowledge_apply_proposal",
    ];
    if (initialized?.serverInfo?.name !== "agent-knowledge-gateway"
      || required.some((name) => !names.has(name))) {
      throw new Error("Target-tree gateway did not complete initialize + tools/list.");
    }
  } finally {
    if (existsSync(targetDependencyLink)) unlinkSync(targetDependencyLink);
    rmSync(isolatedState, { recursive: true, force: true });
  }
}

function retrievalValidationTest(validationRoot) {
  const gatewayRoot = path.join(validationRoot, "ops/gateway");
  const policyPath = path.join(gatewayRoot, "retrieval-policy.json");
  const indexPath = path.join(gatewayRoot, "retrieval-index.mjs");
  const coordinatorPath = path.join(gatewayRoot, "retrieval-coordinator.mjs");
  const nativeTestPath = path.join(gatewayRoot, "native-index.test.mjs");
  if (!existsSync(policyPath) || !existsSync(indexPath) || !existsSync(coordinatorPath)
    || !existsSync(nativeTestPath)) {
    throw new Error("Native retrieval policy, implementation, coordinator, and tests must exist together.");
  }
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  validateRetrievalPolicyProposal(policy);
  return "native-index.test.mjs";
}

function validateGatewayChanges(validationRoot, changes) {
  const gatewayTargets = changes
    .flatMap((change) => [change.target, change.new_target])
    .filter((target) => target?.startsWith("ops/gateway/"));
  validateNativeRetrievalTree(validationRoot);
  if (gatewayTargets.length === 0) return;

  validateRelativeModuleClosure(validationRoot);
  const targets = new Set(proposalTargets(changes));
  if (targets.has("ops/gateway/server.mjs")
    || changes.some((change) => change.action === "delete" && change.target.startsWith("ops/gateway/"))
    || RETRIEVAL_GOVERNANCE_TARGETS.some((target) => targets.has(target))) {
    validateTargetTreeServerHandshake(validationRoot);
  }

  const testPairs = [
    ["process-lock.mjs", "process-lock.test.mjs"],
    ["runtime-paths.mjs", "runtime-paths.test.mjs"],
    ["retrieval-coordinator.mjs", "retrieval-coordinator.test.mjs"],
    ["retrieval-policy.json", "retrieval-coordinator.test.mjs"],
    ["repository-snapshot.mjs", "repository-snapshot.test.mjs"],
    ["retrieval-views.mjs", "retrieval-coordinator.test.mjs"],
    ["proposal-store.mjs", "proposal-store.test.mjs"],
  ];
  const tests = new Set();
  const retrievalTargets = new Set([
    "retrieval-index.mjs",
    "native-index.test.mjs",
    "retrieval-coordinator.mjs",
    "retrieval-coordinator.test.mjs",
    "retrieval-policy.json",
  ]);
  if (gatewayTargets.some((target) => retrievalTargets.has(target.slice("ops/gateway/".length)))) {
    const selectedTest = retrievalValidationTest(validationRoot);
    for (const required of ["retrieval-index.mjs", selectedTest]) {
      if (!existsSync(path.join(validationRoot, "ops/gateway", required))) {
        throw new Error(`Retrieval implementation and selected mode test must exist together: retrieval-index.mjs, ${selectedTest}`);
      }
    }
    tests.add(`ops/gateway/${selectedTest}`);
  }
  for (const [implementation, test] of testPairs) {
    if (!gatewayTargets.some((target) => [implementation, test].includes(target.slice("ops/gateway/".length)))) continue;
    for (const required of [implementation, test]) {
      if (!existsSync(path.join(validationRoot, "ops/gateway", required))) throw new Error(`Gateway implementation and tests must exist together: ${implementation}, ${test}`);
    }
    tests.add(`ops/gateway/${test}`);
  }
  if (tests.size) run(process.execPath, ["--test", ...tests], { cwd: validationRoot });

  for (const target of gatewayTargets) {
    const absolute = path.join(validationRoot, target);
    if (!existsSync(absolute)) continue;
    if (target.endsWith(".mjs")) {
      run(process.execPath, ["--check", target], { cwd: validationRoot });
    }
    if (target.endsWith(".json")) {
      JSON.parse(readFileSync(absolute, "utf8"));
    }
  }

  const routerModule = path.join(validationRoot, "ops/gateway/knowledge-router.mjs");
  const routerTest = path.join(validationRoot, "ops/gateway/knowledge-router.test.mjs");
  const routerTouched = gatewayTargets.some((target) => (
    target === "ops/gateway/knowledge-router.mjs"
    || target === "ops/gateway/knowledge-router.test.mjs"
  ));
  if (routerTouched && (!existsSync(routerModule) || !existsSync(routerTest))) {
    throw new Error("Knowledge router implementation and tests must exist together.");
  }
  if (existsSync(routerModule) && existsSync(routerTest)) {
    run(process.execPath, ["--test", "ops/gateway/knowledge-router.test.mjs"], {
      cwd: validationRoot,
    });
  }

  const catalogModule = path.join(validationRoot, "ops/gateway/knowledge-catalog.mjs");
  const catalogTest = path.join(validationRoot, "ops/gateway/knowledge-catalog.test.mjs");
  const catalogTouched = gatewayTargets.some((target) => (
    target === "ops/gateway/knowledge-catalog.mjs"
    || target === "ops/gateway/knowledge-catalog.test.mjs"
  ));
  if (catalogTouched && (!existsSync(catalogModule) || !existsSync(catalogTest))) {
    throw new Error("Knowledge catalog implementation and tests must exist together.");
  }
  if (catalogTouched) {
    run(process.execPath, ["--test", "ops/gateway/knowledge-catalog.test.mjs"], {
      cwd: validationRoot,
    });
  }

  if (gatewayTargets.some((target) => /\/(?:schema-pack(?:\.test)?|retrieval-index|native-index\.test)\.mjs$/.test(target))) {
    run(process.execPath, ["--test", "ops/gateway/schema-pack.test.mjs"], { cwd: validationRoot });
  }

  validateGatewayPackageIdentity(validationRoot);
}

function validateProposedChanges(changes, snapshots) {
  const head = run("git", ["rev-parse", "HEAD"]);
  withRepositorySnapshot(ROOT, head, (validationRoot) => {
    seedValidationWorktree(validationRoot, snapshots);
    applyFileChanges(validationRoot, changes);
    run(process.execPath, ["ops/validate-vault.mjs"], { cwd: validationRoot });
    validateGatewayChanges(validationRoot, changes);
    // Validate proposed bytes with the trusted, already-loaded validator.
    validateSchemaChanges(validationRoot, changes);
  });
}

function validateActiveSchema(changes, snapshots) {
  validateSchemaChanges(ROOT, changes);
}

function isTracked(target) {
  try {
    run("git", ["ls-files", "--error-unmatch", "--", target]);
    return true;
  } catch {
    return false;
  }
}

function commitProposalChanges(proposal, changes, transactionRecord) {
  assertNoActiveCommitHooks({ root: ROOT });
  const paths = new Set();
  for (const change of changes) {
    paths.add(change.target);
    if (change.new_target) paths.add(change.new_target);
  }
  const stageablePaths = [...paths].filter(
    (target) => existsSync(path.join(ROOT, target)) || isTracked(target),
  );
  if (stageablePaths.length) {
    run("git", ["add", "--all", "--", ...stageablePaths]);
  }

  const stagedPaths = run("git", ["diff", "--cached", "--no-renames", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean);
  const unexpected = stagedPaths.filter((target) => !paths.has(target));
  if (unexpected.length) {
    throw new Error(
      `Unrelated paths became staged during approval: ${unexpected.join(", ")}`,
    );
  }

  runTestFailpoint("after_git_add_before_commit");
  assertApplyTransactionReadyToCommit({ root: ROOT, transactionRecord });
  assertNoActiveCommitHooks({ root: ROOT });
  runTestFailpoint("after_precommit_proof_before_commit_decision");

  const commitCreated = stagedPaths.length > 0;
  if (commitCreated) run("git", ["commit", "-m", proposalCommitSubject(proposal)]);
  const commit = run("git", ["rev-parse", "HEAD"]);
  if (commitCreated) {
    const proof = detectExactCommittedProposal({
      root: ROOT,
      proposal,
      changes,
      appliedDir: APPLIED_DIR,
      recoveryRecord: transactionRecord,
    });
    if (
      !proof.matched
      || proof.commit !== commit
      || proof.execution_parent !== transactionRecord.execution_parent
    ) {
      throw new Error(
        `Committed proposal '${proposal.id}' failed exact post-commit proof (${proof.reason}).`,
      );
    }
    return { commit, commitCreated, proof };
  }
  if (commit !== transactionRecord.execution_parent) {
    throw new Error(`No-op proposal '${proposal.id}' changed Git HEAD before receipt publication.`);
  }
  assertApplyTransactionReadyToCommit({ root: ROOT, transactionRecord });
  return { commit, commitCreated, proof: null };
}

async function synchronizeCommittedState(commit) {
  if (
    TEST_HOOKS_ENABLED
    && process.env.AGENT_KNOWLEDGE_TEST_SYNC_MODE === "throw"
  ) {
    throw new Error("Injected test-only synchronization failure.");
  }
  if (
    TEST_HOOKS_ENABLED
    && process.env.AGENT_KNOWLEDGE_TEST_SYNC_MODE === "synchronized"
  ) {
    return {
      commit,
      indexStatus: "synchronized",
      indexError: null,
      indexDetails: { test_only: true, source_commit: commit },
      navigationIndex: {
        status: "test_only",
        file: NAVIGATION_INDEX_FILE,
        source_commit: commit,
        page_count: null,
        counts: null,
        changed: false,
        error: null,
      },
    };
  }
  const navigationIndex = refreshNavigationIndexSafely(commit);

  let indexStatus = "synchronized";
  let indexError = null;
  let indexDetails = null;
  try {
    indexDetails = await retrievalCoordinator.synchronize(commit);
  } catch (error) {
    indexStatus = "failed";
    indexError = error instanceof Error ? error.message : String(error);
    indexDetails = error.retrieval || null;
  }
  return {
    commit,
    indexStatus,
    indexError,
    indexDetails,
    navigationIndex,
  };
}

const server = new McpServer(
  {
    name: "agent-knowledge-gateway",
    version: GATEWAY_RUNTIME_VERSION,
  },
  {
    instructions:
      `This is the canonical interface for the user's Obsidian knowledge base at '${ROOT}'. When a request may depend on the user's projects, decisions, methods, preferences, local recommendations, or other durable personal context, call knowledge_route first and fetch any action='read' pages with knowledge_get before answering. When the user says "录入知识库", "导入知识库", "保存到知识库", or otherwise asks to add, update, merge, move, or delete knowledge, call knowledge_intake first. Do not ask the user for the vault path, Obsidian format, page type, or sync command: knowledge_intake supplies the active contract. Use result-scope search for reusable knowledge and evidence scope only for provenance. Never write files directly. Create an exact proposal, show it to the user, and call knowledge_apply_proposal only after explicit approval. If a proposal is stale, recreate and re-approve it. If an approved write reports a failed index or search is behind Git, call knowledge_repair_index; do not ask the user to run terminal commands.`,
  },
);

server.registerTool(
  "knowledge_intake",
  {
    description:
      "MANDATORY first step for requests such as 录入知识库, 导入知识库, 保存到知识库, add/import/save to my knowledge base, or any requested knowledge change. Returns the canonical Obsidian destination, active Markdown format, routing rules, dedupe sequence, approval gate, and derived-index behavior. Read-only; it never writes or creates a proposal.",
    inputSchema: {
      user_request: z.string().max(2000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ user_request }) => {
    try {
      const { commit, catalog } = committedCatalogAtHead();
      const retrievalContext = retrievalCoordinator.context(commit);
      const schemaContract = committedContractText(catalog, "ops/SCHEMA");
      const agentRules = committedContractText(catalog, "ops/AGENTS");
      const derivedRetrievalLayer =
        "Agent Knowledge Native hybrid index, bound to the exact committed Markdown corpus; local committed-Markdown keyword recall is the visible degraded fallback.";
      const payload = {
        ok: true,
        source_commit: commit,
        recognized_request: user_request?.trim() || null,
        destination: {
          application: "Obsidian",
          vault_path: ROOT,
          source_of_truth: "Markdown files and Git history in the Obsidian vault",
          derived_retrieval_layer: derivedRetrievalLayer,
          human_navigation_index:
            "A local, rebuildable root index.md is generated from the committed Git snapshot and is not a fact source.",
          raw_material_policy: ".raw/ is retained in Obsidian and Git but excluded from the retrieval index",
        },
        mandatory_workflow: [
          "Analyze the supplied link, attachment, text, or conversation and separate evidence from inference.",
          "Call knowledge_search against result pages and, when provenance matters, evidence pages to avoid duplicates.",
          "Choose the page type by future Agent use, not by topic, author, platform, or file format.",
          "Prefer updating an existing page. Create a new page only when the existing pages cannot express the reusable result.",
          "Draft complete target-file contents and call knowledge_propose_changes. Do not edit the vault directly.",
          "Show the exact proposal to the user and wait for explicit approval.",
          "After approval, call knowledge_apply_proposal. The gateway validates, commits to Git, synchronizes the Native derived index, and verifies exact Git corpus coverage.",
          "If indexing fails after the Git commit, call knowledge_repair_index. It repairs only the derived index and does not require another content proposal.",
        ],
        routing: {
          project: "projects/ - current facts, goals, constraints, and state that still affect future work",
          decision: "decisions/ - committed choices, rationale, rejected options, and revisit triggers",
          methodology: "methods/ - reusable procedures with inputs, steps, outputs, boundaries, and failure conditions",
          synthesis: "syntheses/ - cross-source conclusions that narrow choices or change decisions",
          concept: "concepts/ - stable mechanisms repeatedly used in judgment",
          source: "sources/ - provenance, reliability, evidence gaps, and links to derived result pages",
          raw: ".raw/ - transcripts and uncleaned evidence; never a default answer surface",
        },
        exclusions: [
          "Do not store task logs, chat summaries, research process, personality/company profiles, news clippings, or unfiltered material as result pages.",
          "Do not invent a second vault, write to the current task folder, or treat an uploaded attachment as already imported.",
          "Do not bypass the proposal and approval tools, even when the user broadly asked to maintain the knowledge base.",
        ],
        schema_contract: schemaContract,
        agent_rules: agentRules,
        next_step:
          "Search for semantic duplicates, inspect the closest existing pages, then prepare an exact proposal with knowledge_propose_changes.",
      };
      assertCommittedReadStable(commit);
      return result(payload);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_search",
  {
    description:
      "Search the personal knowledge base. Defaults to reusable result pages and hides source/evidence pages. When module is provided, search remains global and matching module pages receive a ranking boost; it is never a hard filter. Use scope='evidence' only to verify provenance or inspect candidate claims.",
    inputSchema: {
      query: z.string().min(1),
      scope: z.enum(["result", "evidence", "all"]).default("result"),
      limit: z.number().int().min(1).max(20).default(5),
      module: z.string().trim().min(1).max(80).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ query, scope, limit, module }) => {
    try {
      const { commit, catalog, runtime } = committedCatalogAtHead();
      const rawLimit = Math.min(100, Math.max(40, limit * 8));
      const retrieval = await retrievalCoordinator.query({
        query,
        scope,
        expectedCommit: commit,
        catalog,
        limit: rawLimit,
        expand: false,
        adaptive_return: false,
        autocut: false,
      });
      const { hits, retrievalMode, retrievalStatus } = retrieval;

      const seen = new Set();
      const candidates = [];
      const candidateLimit = module ? Math.min(40, Math.max(12, limit * 4)) : limit;
      for (const hit of hits || []) {
        if (!runtime.scopeAllows(hit.type, scope) || seen.has(hit.slug)) continue;
        seen.add(hit.slug);
        candidates.push(hit);
        if (candidates.length === candidateLimit) break;
      }

      const filtered = module
        ? candidates
          .map((hit) => {
            const page = catalog.getPage(hit.slug, { fuzzy: false });
            retrievalCoordinator.verifyCatalogPage(page, commit);
            return summarizeSearchHit(hit, { page, module });
          })
          .sort((left, right) => right.score - left.score)
          .slice(0, limit)
        : candidates.map((hit) => summarizeSearchHit(hit)).slice(0, limit);
      const response = result({
        ok: true,
        query,
        scope,
        module: module || null,
        module_boost_applied: Boolean(module && filtered.some((item) => item.module_match)),
        retrieval_mode: retrievalMode,
        retrieval_status: retrievalStatus,
        retrieval: { ...retrieval, hits: undefined },
        results: filtered,
        policy:
          scope === "result"
            ? module
              ? "Global reusable-result search with a 15% boost for matching modules; modules never hide cross-module knowledge."
              : "Reusable result pages only; sources are intentionally hidden."
            : "Evidence scope is for provenance or candidate-claim review, not default factual answers.",
      });
      assertCommittedReadStable(commit);
      return response;
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_route",
  {
    description:
      "Precision-first preflight for deciding whether a user request should read reusable knowledge. Returns action='read', 'review', or 'none' with explainable metadata evidence. Vector similarity and module match can rank candidates but never trigger an automatic read by themselves. This tool is read-only and does not persist queries or context.",
    inputSchema: {
      query: z.string().min(1).max(2000),
      context: z.string().max(4000).optional(),
      module: z.string().trim().min(1).max(80).optional(),
      limit: z.number().int().min(1).max(10).default(5),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ query, context, module, limit }) => {
    const traceId = `kr-${randomBytes(8).toString("hex")}`;
    const retrievalQuery = context?.trim()
      ? `${query.trim()}\n${context.trim()}`
      : query.trim();
    const rawLimit = Math.min(100, Math.max(40, limit * 10));
    let hits = [];
    let retrievalMode = "hybrid";
    let retrievalStatus = "ok";
    let retrievalDiagnostics = null;

    try {
      const { commit, catalog, runtime } = committedCatalogAtHead();
      try {
        const retrieval = await retrievalCoordinator.query({
          query: retrievalQuery,
          scope: "result",
          expectedCommit: commit,
          catalog,
          limit: rawLimit,
          expand: false,
          adaptive_return: false,
          autocut: false,
        });
        retrievalDiagnostics = { ...retrieval, hits: undefined };
        hits = retrieval.hits;
        retrievalMode = retrieval.retrievalMode;
        retrievalStatus = retrieval.retrievalStatus;
      } catch {
        retrievalMode = "none";
        retrievalStatus = "unavailable";
        hits = [];
      }

      const seen = new Set();
      const resultHits = [];
      for (const hit of hits) {
        if (!runtime.scopeAllows(hit.type, "result") || seen.has(hit.slug)) continue;
        seen.add(hit.slug);
        resultHits.push(hit);
        if (resultHits.length >= Math.min(40, Math.max(20, limit * 6))) break;
      }

      // Markdown/Git is the source of truth. Candidate metadata comes from the
      // local catalog; the Native index contributes recall scores only.
      const candidates = resultHits.map((hit, index) => (
        routeCandidateFromHit(
          hit,
          retrievalCoordinator.verifyCatalogPage(catalog.getPage(hit.slug, { fuzzy: false }), commit),
          index + 1,
        )
      ));
      const routed = routeKnowledgeCandidates({
        schemaRuntime: runtime,
        query,
        context: context || "",
        module: module || null,
        candidates,
        metadataUniverse: catalog.allPages()
          .map((page) => retrievalCoordinator.verifyCatalogPage(page, commit))
          .filter((page) => runtime.scopeAllows(page.type, "result"))
          .map((page) => ({ slug: page.slug, title: page.title, type: page.type,
            aliases: page.frontmatter.aliases || [], tags: page.tags || page.frontmatter.tags || [] })),
        retrievalStatus,
        retrievalMode,
        limit,
      });
      const response = result({
        ok: true,
        ...routed,
        retrieval: { ...routed.retrieval, ...retrievalDiagnostics },
        trace_id: traceId,
        policy:
          "When action='read', fetch selected pages with knowledge_get before answering. action='review' is a candidate review signal, not permission to treat a page as fact. action='none' with retrieval.status='unavailable' does not prove the knowledge base has no relevant page.",
      });
      assertCommittedReadStable(commit);
      return response;
    } catch {
      const routed = routeKnowledgeCandidates({
        schemaRuntime,
        query,
        context: context || "",
        module: module || null,
        candidates: [],
        retrievalStatus: "unavailable",
        retrievalMode: "none",
        limit,
      });
      return result({
        ok: true,
        ...routed,
        trace_id: traceId,
        policy:
          "Knowledge retrieval was unavailable. Continue without claiming that the knowledge base was checked successfully.",
      });
    }
  },
);

server.registerTool(
  "knowledge_get",
  {
    description:
      "Read one knowledge page. Default scope blocks source pages; pass scope='evidence' or 'all' only when provenance is explicitly needed. Successful reads include a non-enforcing Lab Trust Core shadow verdict or migration diagnostic; it never blocks the page in shadow mode.",
    inputSchema: {
      slug: z.string().min(1),
      scope: z.enum(["result", "evidence", "all"]).default("result"),
      fuzzy: z.boolean().default(true),
      trust_context: z.unknown().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ slug, scope, fuzzy, trust_context }) => {
    try {
      const { commit, catalog, runtime } = committedCatalogAtHead();
      const page = catalog.getPage(slug, { fuzzy });
      if (!page) {
        assertCommittedReadStable(commit);
        return result({ ok: false, source_commit: commit, error: `Page not found: ${slug}` }, true);
      }
      if (!runtime.scopeAllows(page.type, scope)) {
        assertCommittedReadStable(commit);
        return result(
          {
            ok: false,
            source_commit: commit,
            error: `Page '${page.slug}' is type '${page.type}' and is blocked by scope '${scope}'.`,
            hint: "Use scope='evidence' only when the task requires source verification.",
          },
          true,
        );
      }
      const publicPage = {
        slug: page.slug,
        title: page.title,
        type: page.type,
        frontmatter: page.frontmatter,
        tags: page.tags,
        content: page.compiled_truth,
        timeline: page.timeline,
        updated_at: page.updated_at,
      };
      const source = {
        path: page.path,
        markdown: page.markdown,
      };
      const trustObservation = await observeKnowledgeTrustShadow({
        markdown: source.markdown,
        path: source.path,
        trustContext: trust_context,
      });
      const trustShadow = {
        ...trustObservation,
        input_binding: buildTrustInputBinding({
          source,
          returnedContent: publicPage.content,
          updatedAt: publicPage.updated_at,
        }),
      };
      assertCommittedReadStable(commit);
      return result({
        ok: true,
        source_commit: commit,
        page: publicPage,
        trust_shadow: trustShadow,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_list",
  {
    description:
      "List knowledge pages. Defaults to result pages. A source type requires scope='evidence' or 'all'.",
    inputSchema: {
      scope: z.enum(["result", "evidence", "all"]).default("result"),
      type: z.enum(ALL_TYPES).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ scope, type, limit }) => {
    try {
      const { commit, catalog, runtime } = committedCatalogAtHead();
      if (type && !runtime.scopeAllows(type, scope)) {
        assertCommittedReadStable(commit);
        return result({ ok: false, source_commit: commit,
          error: `Type '${type}' is blocked by scope '${scope}'.` }, true);
      }
      const pages = catalog.listPages({ type, limit: 200, sort: "updated_desc" });
      const filtered = (pages || [])
        .filter((page) => runtime.scopeAllows(page.type, scope))
        .slice(0, limit);
      assertCommittedReadStable(commit);
      return result({ ok: true, scope, source_commit: commit, pages: filtered });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_related",
  {
    description:
      "Read typed outgoing and incoming relationships for a page, including evidence links. This does not change the graph.",
    inputSchema: { slug: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ slug }) => {
    try {
      const { commit, catalog } = committedCatalogAtHead();
      const page = catalog.getPage(slug, { fuzzy: false });
      if (!page) {
        assertCommittedReadStable(commit);
        return result({ ok: false, source_commit: commit, error: `Page not found: ${slug}` }, true);
      }
      const relationships = catalog.relationships(page.slug);
      assertCommittedReadStable(commit);
      return result({
        ok: true,
        source_commit: commit,
        slug: page.slug,
        outgoing: relationships.outgoing,
        incoming: relationships.incoming,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_schema",
  {
    description:
      "Read the active schema identity and exact repository contract. For an intake or write request, call knowledge_intake first because it also returns the canonical Obsidian destination and mandatory workflow.",
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => {
    try {
      const { commit, catalog, runtime } = committedCatalogAtHead();
      const activePack = catalog.activePack();
      const schemaContract = committedContractText(catalog, "ops/SCHEMA");
      const agentRules = committedContractText(catalog, "ops/AGENTS");
      const retrievalStatus = await retrievalCoordinator.status();
      if (retrievalStatus.expected_git_commit !== commit) {
        throw Object.assign(new Error("Retrieval status does not match the committed schema read."), {
          code: "HEAD_CHANGED",
        });
      }
      const payload = {
        ok: true,
        source_commit: commit,
        active_pack: activePack,
        canonical_vault_path: ROOT,
        source_of_truth: "Obsidian Markdown and Git",
        derived_index: "Agent Knowledge Native hybrid index",
        retrieval_status: retrievalStatus,
        navigation_index: navigationIndexState,
        result_types: [...runtime.resultTypes],
        evidence_type: runtime.evidenceTypes.length === 1 ? runtime.evidenceTypes[0] : null,
        evidence_types: runtime.evidenceTypes,
        raw_layer: ".raw (not indexed)",
        maintenance_mode:
          "Conversation maintenance is enabled: proactively identify reusable knowledge, draft exact changes, and ask the user before applying.",
        index_repair_policy:
          "If the derived index is behind Git or an approved write reports index_status='failed', call knowledge_repair_index. Do not ask the user to run terminal commands.",
        write_policy:
          "Propose first. No knowledge mutation is permitted until the user explicitly approves the exact proposal in the current conversation.",
        classification:
          "Choose page type by future Agent use; use domain/tags/source_format/status for horizontal metadata.",
        gateway_runtime: {
          version: GATEWAY_RUNTIME_VERSION,
          target_scoped_apply: true,
          adopt_untracked_markdown_by_update: true,
          delete_root_obsidian_ui_artifacts_by_proposal: true,
          clean_worktree_validation_and_indexing: true,
          module_weighted_global_search: true,
          catalog_source: "committed Git objects at one immutable HEAD",
          direct_read_binding:
            "knowledge_get/list/related/schema fail closed if HEAD changes during a response",
          proposal_state_root: "~/.agent-knowledge/proposals",
          lock_root: "~/.agent-knowledge/locks",
          retrieval_backend: {
            contract: "native-hybrid-index-v1",
            policy: "ops/gateway/retrieval-policy.json (committed Git HEAD only)",
            required_for: ["knowledge_search", "knowledge_route", "index_sync"],
            optional_for: [],
            unused_for: ["knowledge_get", "knowledge_list", "knowledge_related"],
            local_fallback: "formal Markdown keyword recall through KnowledgeCatalog",
          },
          trust_core: {
            package_id: "lab-trust-core",
            package_version: "0.1.2",
            mode: "shadow",
            enforced: false,
            evaluation_point: "knowledge_get_after_scope_gate",
            deployment_acceptance: "npm_ci_live_test_restart_fresh_schema",
          },
        },
        schema_contract: schemaContract,
        agent_rules: agentRules,
      };
      assertCommittedReadStable(commit);
      return result(payload);
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_repair_index",
  {
    description:
      "Repair or verify the Native derived index against the current Obsidian/Git commit. Use immediately when an approved write returns index_status='failed', search is missing recently committed pages, or the index is behind Git. It rebuilds or verifies the immutable generation and exact committed-page coverage. It never changes Obsidian Markdown or Git and does not require content approval.",
    inputSchema: {
      force_full: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ force_full }) => {
    try {
      const head = run("git", ["rev-parse", "HEAD"]);
      const synchronization = await retrievalCoordinator.synchronize(head, { forceFull: force_full });
      return result({
        ok: true,
        knowledge_modified: false,
        git_modified: false,
        index_repaired: synchronization.sync_mode !== "verify",
        ...synchronization,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

const changeSchema = z.object({
  action: z.enum(["create", "update", "delete", "move", "schema"]),
  target: z.string().min(1),
  new_target: z.string().optional(),
  content: z.string().optional(),
});

server.registerTool(
  "knowledge_propose_changes",
  {
    description:
      "Create a pending knowledge-base proposal only. This does NOT modify Obsidian, Git, the retrieval index, or the schema. Conversation proposals are shown in the current conversation; background proposals stay in the shared approval inbox until a review task presents them.",
    inputSchema: {
      summary: z.string().min(3).max(300),
      rationale: z.string().min(3).max(2000),
      changes: z.array(changeSchema).min(1).max(100),
      origin: z.enum(["conversation", "background"]).optional(),
      proposed_by: z.string().min(1).max(120).optional(),
      context: z.string().min(1).max(500).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ summary, rationale, changes, origin, proposed_by, context }) => {
    try {
      const normalizedChanges = validateChanges(changes);
      const preconditions = captureProposalPreconditions(normalizedChanges);
      const now = new Date();
      const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
      const id = `KB-${stamp.slice(0, 8)}-${stamp.slice(8)}-${randomBytes(4).toString("hex")}`;
      const proposal = {
        schema_version: 2,
        id,
        created_at: now.toISOString(),
        base_commit: run("git", ["rev-parse", "HEAD"]),
        summary,
        rationale,
        origin: origin ?? "conversation",
        proposed_by: proposed_by?.trim() || null,
        context: context?.trim() || null,
        changes: normalizedChanges,
        preconditions,
      };
      const record = { proposal, sha256: proposalHash(proposal) };
      const finalPath = proposalPath(id);
      const temporary = `${finalPath}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, finalPath);
      return result({
        ok: true,
        proposal_id: id,
        sha256: record.sha256,
        summary,
        change_count: normalizedChanges.length,
        knowledge_modified: false,
        next_step: proposal.origin === "background"
          ? "Leave this proposal in the shared approval inbox. A dedicated review task will present its exact scope; do not apply it automatically."
          : "Present this exact proposal to the user. Only after explicit approval in the current conversation, call knowledge_apply_proposal with this id and the user's approval message.",
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_list_proposals",
  {
    description: "List pending knowledge-base proposals without returning their full page contents.",
    inputSchema: {
      origin: z.enum(["conversation", "background"]).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ origin }) => {
    try {
      const proposals = readdirSync(PENDING_DIR)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => {
          const record = JSON.parse(readFileSync(path.join(PENDING_DIR, name), "utf8"));
          if (!record.proposal || record.sha256 !== proposalHash(record.proposal)) {
            throw new Error(`Proposal integrity check failed: ${name}`);
          }
          return {
            id: record.proposal?.id,
            created_at: record.proposal?.created_at,
            summary: record.proposal?.summary,
            rationale: record.proposal?.rationale,
            origin: record.proposal?.origin ?? "conversation",
            proposed_by: record.proposal?.proposed_by ?? null,
            context: record.proposal?.context ?? null,
            changes: (record.proposal?.changes || []).map((change) => ({
              action: change.action,
              target: change.target,
              new_target: change.new_target,
            })),
            sha256: record.sha256,
          };
        })
        .filter((proposal) => !origin || proposal.origin === origin);
      return result({ ok: true, pending_count: proposals.length, proposals });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_get_proposal",
  {
    description:
      "Read the exact content and metadata of one pending proposal for user review. This is read-only and never changes the knowledge base or proposal state.",
    inputSchema: {
      proposal_id: z.string().min(1),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ proposal_id }) => {
    try {
      const { record } = readProposal(proposal_id);
      return result({
        ok: true,
        proposal: record.proposal,
        sha256: record.sha256,
        knowledge_modified: false,
        review_instruction:
          "Present the exact files and substantive changes. Apply or reject only after the user explicitly names or unambiguously selects this proposal.",
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_reject_proposal",
  {
    description:
      "Archive one pending proposal as rejected after the user explicitly rejects it. This never changes Obsidian, Git, the retrieval index, or the schema, and records the user's reason for audit.",
    inputSchema: {
      proposal_id: z.string().min(1),
      user_rejected: z.literal(true),
      rejection_message: z.string().min(1).max(1000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ proposal_id, user_rejected, rejection_message }) => {
    let lockFd;
    try {
      if (user_rejected !== true || !rejection_message.trim()) {
        throw new Error("Explicit conversation rejection is required.");
      }
      lockFd = acquireLock();
      const interrupted = inspectInterruptedApply({ root: ROOT, transactionDir: INFLIGHT_DIR });
      if (interrupted.status !== "none" && interrupted.proposal_id !== proposal_id) {
        throw new Error(
          `Proposal '${interrupted.proposal_id}' has a durable in-flight approval that must be recovered before any rejection. Run knowledge_apply_proposal for that proposal.`,
        );
      }
      const state = readProposalState(proposal_id);
      if (state.applied) {
        throw new Error(`Proposal already has an applied terminal archive: ${proposal_id}`);
      }
      if (state.rejected) {
        if (interrupted.status !== "none") {
          throw new Error(`Rejected proposal conflicts with a durable in-flight approval: ${proposal_id}`);
        }
        finalizeRejectedProposalArchive({
          pendingPath: state.pendingPath,
          rejectedPath: state.rejectedPath,
          rejectedRecord: state.rejected,
        });
        runTestFailpoint("after_rejected_pending_unlink_before_response");
        return result({
          ok: true,
          proposal_id,
          rejected: true,
          proposal_already_rejected: true,
          rejection: state.rejected.rejection,
          rejected_at: state.rejected.rejected_at,
          knowledge_modified: false,
        });
      }
      if (!state.pendingRecord) throw new Error(`Pending proposal not found: ${proposal_id}`);
      const file = state.pendingPath;
      const record = state.pendingRecord;
      const changes = validateChanges(record.proposal.changes, { enforceIsolation: false });
      const recoveryRecord = interrupted.status !== "none"
        && interrupted.proposal_id === proposal_id
        ? interrupted.record
        : null;
      const committedEvidence = detectExactCommittedProposal({
        root: ROOT,
        proposal: record.proposal,
        changes,
        appliedDir: APPLIED_DIR,
        recoveryRecord,
      });
      assertProposalCanBeRejected({
        appliedPath: state.appliedPath,
        inflightPath: inflightTransactionPath(INFLIGHT_DIR, proposal_id),
        proposalId: proposal_id,
        committedEvidence,
        root: ROOT,
        changes,
        preconditions: record.proposal.preconditions,
        baseCommit: record.proposal.base_commit,
      });
      const rejectedRecord = {
        ...record,
        rejected_at: new Date().toISOString(),
        rejection: {
          channel: "conversation",
          message: rejection_message.trim(),
        },
      };
      const durableRejection = writeRejectedProposalReceipt({
        rejectedPath: state.rejectedPath,
        rejectedRecord,
      });
      runTestFailpoint("after_rejected_receipt_before_pending_unlink");
      finalizeRejectedProposalArchive({
        pendingPath: file,
        rejectedPath: state.rejectedPath,
        rejectedRecord: durableRejection.record,
      });
      runTestFailpoint("after_rejected_pending_unlink_before_response");
      return result({
        ok: true,
        proposal_id,
        rejected: true,
        rejection: durableRejection.record.rejection,
        rejected_at: durableRejection.record.rejected_at,
        knowledge_modified: false,
      });
    } catch (error) {
      return errorResult(error);
    } finally {
      if (lockFd !== undefined) releaseLock(lockFd);
    }
  },
);

server.registerTool(
  "knowledge_apply_proposal",
  {
    description:
      "Apply one pending proposal only after the user explicitly approves its exact scope in the current conversation. Pass the user's approval message for the audit record. Missing approval fields are rejected before any write.",
    inputSchema: {
      proposal_id: z.string().min(1),
      user_approved: z.literal(true),
      approval_message: z.string().min(1).max(1000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ proposal_id, user_approved, approval_message }) => {
    let lockFd;
    let snapshots;
    let changes;
    let transaction;
    let interrupted;
    let liveMutationStarted = false;
    let commitCreated = false;
    let appliedReceiptWritten = false;
    let appliedArchived = false;
    let appliedPath;
    let attemptedAppliedReceipt;
    try {
      if (user_approved !== true || !approval_message.trim()) {
        throw new Error("Explicit conversation approval is required.");
      }
      lockFd = acquireLock();
      const state = readProposalState(proposal_id);
      if (state.rejected) {
        throw new Error(`Proposal has a rejected terminal archive: ${proposal_id}`);
      }
      if (!state.pendingRecord && !state.applied) {
        throw new Error(`Pending proposal not found: ${proposal_id}`);
      }
      const file = state.pendingPath;
      const record = state.pendingRecord || state.applied;
      changes = validateChanges(record.proposal.changes, { enforceIsolation: false });

      interrupted = inspectInterruptedApply({ root: ROOT, transactionDir: INFLIGHT_DIR });
      if (interrupted.status !== "none" && interrupted.proposal_id !== proposal_id) {
        throw new Error(
          `Proposal '${interrupted.proposal_id}' has a durable in-flight approval whose Git outcome must be recovered first.`,
        );
      }
      if (!state.applied || interrupted.status === "pre_commit") {
        assertNoActiveCommitHooks({ root: ROOT });
      }

      appliedPath = state.appliedPath;
      let durableReceipt = state.applied;
      if (durableReceipt) {
        const recordedTerminalReceipt = durableReceipt;
        const currentHead = run("git", ["rev-parse", "HEAD"]);
        if (
          recordedTerminalReceipt.index_status !== "pending"
          && interrupted.status === "none"
        ) {
          if (recordedTerminalReceipt.commit_created === false) {
            const terminalEvidence = verifyNoCommitAppliedReceipt({
              root: ROOT,
              receipt: recordedTerminalReceipt,
              appliedDir: APPLIED_DIR,
            });
            if (!terminalEvidence.matched) {
              throw new Error(
                `No-commit applied receipt cannot be proven for '${proposal_id}' (${terminalEvidence.reason}).`,
              );
            }
          }
          appliedArchived = true;
          return replayAppliedTerminal({
            proposalId: proposal_id,
            pendingPath: file,
            appliedPath,
            record: recordedTerminalReceipt,
            currentHead,
          });
        }
        let receiptEvidence = null;
        if (durableReceipt.commit_created !== false) {
          const candidate = detectExactCommittedProposal({
            root: ROOT,
            proposal: record.proposal,
            changes,
            appliedDir: APPLIED_DIR,
            recoveryRecord: durableReceipt.execution_parent
              ? receiptRecoveryRecord(durableReceipt, changes)
              : null,
          });
          if (candidate.matched && candidate.commit === durableReceipt.git_commit) {
            receiptEvidence = candidate;
            durableReceipt = {
              ...durableReceipt,
              commit_created: true,
              execution_parent: candidate.execution_parent,
            };
          } else if (durableReceipt.commit_created === true) {
            throw new Error(
              `Applied receipt Git outcome cannot be proven for '${proposal_id}' (${candidate.reason}).`,
            );
          }
        }
        if (!receiptEvidence) {
          durableReceipt = {
            ...durableReceipt,
            commit_created: false,
            execution_parent: durableReceipt.execution_parent || durableReceipt.git_commit,
          };
          receiptEvidence = verifyNoCommitAppliedReceipt({
            root: ROOT,
            receipt: durableReceipt,
            appliedDir: APPLIED_DIR,
          });
          if (!receiptEvidence.matched) {
            throw new Error(
              `No-commit applied receipt cannot be proven for '${proposal_id}' (${receiptEvidence.reason}).`,
            );
          }
        }
        ensureAppliedReceiptDurable({
          appliedPath,
          expectedRecord: recordedTerminalReceipt,
          proposalId: proposal_id,
        });
        if (interrupted.status !== "none") {
          const interruptedBaseline = compactApplyBaseline(interrupted.record.snapshots);
          if (
            interrupted.record.proposal_sha256 !== record.sha256
            || interrupted.record.execution_parent !== durableReceipt.execution_parent
            || interrupted.record.approval.message !== durableReceipt.approval.message
            || interrupted.record.approved_at !== durableReceipt.approved_at
            || (durableReceipt.execution_baseline
              && JSON.stringify(interruptedBaseline) !== JSON.stringify(durableReceipt.execution_baseline))
          ) {
            throw new Error(`Durable receipt conflicts with in-flight approval '${proposal_id}'.`);
          }
          clearApplyTransaction({
            transactionPath: interrupted.transaction_path,
            token: interrupted.record.token,
          });
          interrupted = { status: "none" };
        }
        appliedReceiptWritten = true;
        if (recordedTerminalReceipt.index_status !== "pending") {
          appliedArchived = true;
          return replayAppliedTerminal({
            proposalId: proposal_id,
            pendingPath: file,
            appliedPath,
            record: recordedTerminalReceipt,
            currentHead,
          });
        }
        const synchronization = await synchronizeCommittedState(currentHead);
        const appliedRecord = {
          ...durableReceipt,
          recovered_from_receipt: true,
          recovery_head: currentHead,
          index_status: synchronization.indexStatus,
          index_commit: synchronization.commit,
          index_error: synchronization.indexError,
          index_details: synchronization.indexDetails,
          navigation_index: synchronization.navigationIndex,
        };
        const finalized = finalizeAppliedArchive({
          pendingPath: file,
          appliedPath,
          appliedRecord,
        });
        const persisted = finalized.record;
        appliedArchived = true;
        runTestFailpoint("after_applied_pending_unlink_before_response");
        return result({
          ok: persisted.index_status === "synchronized",
          proposal_id,
          approved: true,
          knowledge_modified: false,
          proposal_already_applied: true,
          recovered_from_receipt: true,
          git_commit: persisted.git_commit,
          current_git_commit: currentHead,
          commit_created: false,
          proposal_commit_created: persisted.commit_created,
          index_status: persisted.index_status,
          index_commit: persisted.index_commit,
          index_error: persisted.index_error,
          index_details: persisted.index_details,
          navigation_index: persisted.navigation_index,
        }, persisted.index_status !== "synchronized");
      }

      interrupted = recoverInterruptedApply({ root: ROOT, transactionDir: INFLIGHT_DIR });
      if (interrupted.status === "restored_precommit") {
        runTestFailpoint("after_precommit_restore_before_reintent");
      }
      if (
        interrupted.status === "post_commit"
        && interrupted.record.proposal_sha256 !== record.sha256
      ) {
        throw new Error(`Durable apply transaction conflicts with pending proposal '${proposal_id}'.`);
      }
      assertNoStagedChanges();
      const recovery = detectExactCommittedProposal({
        root: ROOT,
        proposal: record.proposal,
        changes,
        appliedDir: APPLIED_DIR,
        recoveryRecord: interrupted.status === "post_commit"
          && interrupted.proposal_id === proposal_id
          ? interrupted.record
          : null,
      });
      if (recovery.matched) {
        const durableApproval = interrupted.status === "post_commit"
          ? interrupted.record.approval
          : {
              channel: "conversation",
              message: approval_message.trim(),
            };
        const durableApprovedAt = interrupted.status === "post_commit"
          ? interrupted.record.approved_at
          : new Date().toISOString();
        const receipt = writeAppliedCommitReceipt({
          appliedPath,
          appliedRecord: {
            ...record,
            approved_at: durableApprovedAt,
            approval: durableApproval,
            git_commit: recovery.commit,
            commit_created: true,
            execution_parent: recovery.execution_parent,
            ...(interrupted.status === "post_commit"
              ? { execution_baseline: compactApplyBaseline(interrupted.record.snapshots) }
              : {}),
            recovered_after_commit: true,
            recovery_head: recovery.current_head,
            index_status: "pending",
            index_commit: null,
            index_error: null,
            index_details: null,
            navigation_index: null,
          },
        });
        appliedReceiptWritten = true;
        const durableRecoveryReceipt = ensureAppliedReceiptDurable({
          appliedPath,
          expectedRecord: receipt.record,
          proposalId: proposal_id,
        });
        if (interrupted.status === "post_commit") {
          clearApplyTransaction({
            transactionPath: interrupted.transaction_path,
            token: interrupted.record.token,
          });
          interrupted = { status: "none" };
        }
        const synchronization = await synchronizeCommittedState(recovery.current_head);
        const appliedRecord = {
          ...durableRecoveryReceipt,
          recovered_after_commit: true,
          recovery_head: recovery.current_head,
          index_status: synchronization.indexStatus,
          index_commit: synchronization.commit,
          index_error: synchronization.indexError,
          index_details: synchronization.indexDetails,
          navigation_index: synchronization.navigationIndex,
        };
        const finalized = finalizeAppliedArchive({
          pendingPath: file,
          appliedPath,
          appliedRecord,
        });
        const persisted = finalized.record;
        appliedArchived = true;
        runTestFailpoint("after_applied_pending_unlink_before_response");

        return result({
          ok: persisted.index_status === "synchronized",
          proposal_id,
          approved: true,
          knowledge_modified: false,
          proposal_already_committed: true,
          recovered_after_commit: true,
          git_commit: persisted.git_commit,
          current_git_commit: persisted.recovery_head,
          commit_created: false,
          proposal_commit_created: true,
          index_status: persisted.index_status,
          index_commit: persisted.index_commit,
          index_error: persisted.index_error,
          index_details: persisted.index_details,
          navigation_index: persisted.navigation_index,
        }, persisted.index_status !== "synchronized");
      }
      if (recovery.proposal_commit_found || recovery.possible_proposal_commit) {
        throw new Error(
          `Proposal '${proposal_id}' may already have a Git commit (${recovery.reason}); automatic apply stopped for receipt recovery or manual audit.`,
        );
      }
      if (interrupted.status === "post_commit") {
        throw new Error(
          `Durable apply transaction for '${proposal_id}' reached a different Git state (${recovery.reason}); automatic recovery stopped.`,
        );
      }

      // Isolation is a policy for starting new mutation. Historical mixed
      // proposals may still be finalized when their exact commit is already
      // proven above, while an interrupted pre-commit attempt is first safely
      // restored and then stopped here.
      assertProposalChangeIsolation(changes, {
        governanceDeleteTargets: GOVERNANCE_DELETABLE_TARGETS,
      });

      snapshots = snapshotTargets(changes);
      assertProposalPreconditions(record.proposal.preconditions, snapshots);
      validateProposedChanges(changes, snapshots);

      // Validation can take time. Re-read every approved target so a concurrent
      // writer cannot slip a changed file between the proposal baseline and apply.
      const currentSnapshots = snapshotTargets(changes);
      assertProposalPreconditions(record.proposal.preconditions, currentSnapshots);
      snapshots = currentSnapshots;
      assertNoActiveCommitHooks({ root: ROOT });
      transaction = beginApplyTransaction({
        root: ROOT,
        transactionDir: INFLIGHT_DIR,
        proposal: record.proposal,
        approval: interrupted.status === "restored_precommit"
          ? interrupted.approval
          : {
              channel: "conversation",
              message: approval_message.trim(),
            },
        approvedAt: interrupted.status === "restored_precommit"
          ? interrupted.approved_at
          : new Date().toISOString(),
        executionParent: run("git", ["rev-parse", "HEAD"]),
        changes,
        snapshots,
      });
      liveMutationStarted = true;
      if (run("git", ["rev-parse", "HEAD"]) !== transaction.record.execution_parent) {
        throw new Error("Git HEAD changed while durable apply intent was being recorded.");
      }
      assertSnapshotsUnchanged(snapshots, snapshotTargets(changes));
      assertNoStagedChanges();
      applyFileChanges(ROOT, changes, {
        transactionToken: transaction.record.token,
        expectedSnapshots: snapshots,
      });
      validateActiveSchema(changes, snapshots);

      const committed = commitProposalChanges(record.proposal, changes, transaction.record);
      commitCreated = committed.commitCreated;
      runTestFailpoint("after_commit_before_receipt");
      const baseAppliedRecord = {
        ...record,
        approved_at: transaction.record.approved_at,
        approval: transaction.record.approval,
        git_commit: committed.commit,
        commit_created: committed.commitCreated,
        execution_parent: transaction.record.execution_parent,
        execution_baseline: compactApplyBaseline(transaction.record.snapshots),
      };
      attemptedAppliedReceipt = {
        ...baseAppliedRecord,
        index_status: "pending",
        index_commit: null,
        index_error: null,
        index_details: null,
        navigation_index: null,
      };
      const writtenRecord = writeAppliedCommitReceipt({
        appliedPath,
        appliedRecord: attemptedAppliedReceipt,
      }).record;
      appliedReceiptWritten = true;
      const durableRecord = ensureAppliedReceiptDurable({
        appliedPath,
        expectedRecord: writtenRecord,
        proposalId: proposal_id,
      });
      runTestFailpoint("after_receipt_before_wal_clear");
      clearApplyTransaction({
        transactionPath: transaction.path,
        token: transaction.record.token,
      });
      transaction = undefined;
      runTestFailpoint("after_wal_clear_before_sync");
      const synchronization = await synchronizeCommittedState(committed.commit);
      runTestFailpoint("after_sync_before_finalize");
      const appliedRecord = {
        ...durableRecord,
        index_status: synchronization.indexStatus,
        index_commit: synchronization.commit,
        index_error: synchronization.indexError,
        index_details: synchronization.indexDetails,
        navigation_index: synchronization.navigationIndex,
      };
      const finalized = finalizeAppliedArchive({
        pendingPath: file,
        appliedPath,
        appliedRecord,
      });
      const persisted = finalized.record;
      appliedArchived = true;
      runTestFailpoint("after_applied_pending_unlink_before_response");

      return result({
        ok: persisted.index_status === "synchronized",
        proposal_id,
        approved: true,
        knowledge_modified: true,
        git_commit: persisted.git_commit,
        commit_created: committed.commitCreated,
        index_status: persisted.index_status,
        index_commit: persisted.index_commit,
        index_error: persisted.index_error,
        index_details: persisted.index_details,
        navigation_index: persisted.navigation_index,
      }, persisted.index_status !== "synchronized");
    } catch (error) {
      if (!appliedReceiptWritten && appliedPath && attemptedAppliedReceipt) {
        try {
          const publishedReceipt = readAppliedCommitReceipt({
            appliedPath,
            expectedRecord: attemptedAppliedReceipt,
            proposalId: proposal_id,
          });
          if (publishedReceipt) appliedReceiptWritten = true;
        } catch (receiptError) {
          if (existsSync(appliedPath)) {
            appliedReceiptWritten = true;
            error = new Error(
              `${error instanceof Error ? error.message : String(error)} `
              + `A terminal receipt exists but could not be verified; rollback was blocked: `
              + `${receiptError instanceof Error ? receiptError.message : String(receiptError)}`,
              { cause: error },
            );
          }
        }
      }
      if (
        liveMutationStarted
        && snapshots
        && changes
        && !commitCreated
        && !appliedReceiptWritten
        && !appliedArchived
      ) {
        try {
          assertNoActiveCommitHooks({ root: ROOT });
          const restored = recoverInterruptedApply({ root: ROOT, transactionDir: INFLIGHT_DIR });
          if (restored.status === "post_commit") {
            throw new Error(`Apply recovery observed unexpected post-commit HEAD '${restored.current_head}'.`);
          }
        } catch (recoveryError) {
          error = new Error(
            `${error instanceof Error ? error.message : String(error)} `
            + `Durable pre-commit recovery remains pending: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
            { cause: error },
          );
        }
      }
      return errorResult(error);
    } finally {
      if (lockFd !== undefined) releaseLock(lockFd);
    }
  },
);

async function main() {
  let navigation;
  try {
    const head = run("git", ["rev-parse", "HEAD"]);
    navigation = refreshNavigationIndexSafely(head);
  } catch (error) {
    navigationIndexState = {
      ...navigationIndexState,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
    navigation = navigationIndexState;
  }
  if (navigation.status === "failed") {
    console.error(`Navigation index refresh failed: ${navigation.error}`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
