#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
import { routeKnowledgeCandidates } from "./knowledge-router.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GBRAIN = process.env.GBRAIN_BIN || path.join(os.homedir(), ".bun/bin/gbrain");
const SOURCE_ID = process.env.GBRAIN_SOURCE_ID || "knowledge";
const SCHEMA_PATH = path.join(ROOT, "ops", "SCHEMA.md");
const AGENT_RULES_PATH = path.join(ROOT, "ops", "AGENTS.md");
const PROPOSAL_ROOT = path.join(os.homedir(), ".gbrain", "change-proposals");
const PENDING_DIR = path.join(PROPOSAL_ROOT, "pending");
const APPLIED_DIR = path.join(PROPOSAL_ROOT, "applied");
const REJECTED_DIR = path.join(PROPOSAL_ROOT, "rejected");
const LOCK_PATH = path.join(PROPOSAL_ROOT, "apply.lock");
const GBRAIN_LOCK_PATH = path.join(os.homedir(), ".gbrain", "gateway-db.lock");
const GBRAIN_CONFIG_PATH = path.join(os.homedir(), ".gbrain", "config.json");
const OLLAMA_API_URL = (process.env.OLLAMA_API_URL || "http://127.0.0.1:11434")
  .replace(/\/+$/, "");
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const RESULT_TYPES = new Set([
  "project",
  "decision",
  "methodology",
  "synthesis",
  "concept",
]);
const ALL_TYPES = [...RESULT_TYPES, "source"];
const CONTENT_PREFIXES = [
  "projects/",
  "decisions/",
  "methods/",
  "syntheses/",
  "concepts/",
  "sources/",
  ".raw/",
];
const KNOWLEDGE_DIRECTORIES = [
  "projects",
  "decisions",
  "methods",
  "syntheses",
  "concepts",
  "sources",
  ".raw",
];
const GOVERNANCE_CREATABLE_TARGETS = new Set([
  "ops/gateway/knowledge-router.mjs",
  "ops/gateway/knowledge-router.test.mjs",
]);
const GOVERNANCE_TARGETS = new Set([
  "README.md",
  "ops/AGENTS.md",
  "ops/SCHEMA.md",
  "ops/gbrain-schema/pack.json",
  "ops/gateway/README.md",
  "ops/gateway/package-lock.json",
  "ops/gateway/package.json",
  "ops/gateway/server.mjs",
  "ops/gateway/smoke-test.mjs",
  "ops/sync-graph.mjs",
  "ops/validate-vault.mjs",
  ...GOVERNANCE_CREATABLE_TARGETS,
]);
const ROOT_UI_ARTIFACT_EXTENSIONS = new Set([".base", ".canvas"]);

mkdirSync(PENDING_DIR, { recursive: true, mode: 0o700 });
mkdirSync(APPLIED_DIR, { recursive: true, mode: 0o700 });
mkdirSync(REJECTED_DIR, { recursive: true, mode: 0o700 });

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

function sleepSync(milliseconds) {
  Atomics.wait(WAIT_BUFFER, 0, 0, milliseconds);
}

function processIsActive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireGbrainLock(timeout = 120_000) {
  const startedAt = Date.now();
  mkdirSync(path.dirname(GBRAIN_LOCK_PATH), { recursive: true, mode: 0o700 });

  while (Date.now() - startedAt < timeout) {
    const token = randomBytes(16).toString("hex");
    try {
      const fd = openSync(GBRAIN_LOCK_PATH, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n${token}\n${new Date().toISOString()}\n`);
      return { fd, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    try {
      const owner = readFileSync(GBRAIN_LOCK_PATH, "utf8");
      const [pidText] = owner.split("\n");
      if (!processIsActive(Number(pidText))) {
        if (readFileSync(GBRAIN_LOCK_PATH, "utf8") === owner) {
          unlinkSync(GBRAIN_LOCK_PATH);
        }
        continue;
      }
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    sleepSync(100);
  }

  throw new Error("Timed out waiting for another Agent to finish using the shared GBrain index.");
}

function releaseGbrainLock(lock) {
  try {
    closeSync(lock.fd);
  } finally {
    try {
      const [, token] = readFileSync(GBRAIN_LOCK_PATH, "utf8").split("\n");
      if (token === lock.token) unlinkSync(GBRAIN_LOCK_PATH);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function withGbrainLock(callback, timeout) {
  const lock = acquireGbrainLock(timeout);
  try {
    return callback();
  } finally {
    releaseGbrainLock(lock);
  }
}

function gbrainSourceStatus() {
  const status = JSON.parse(run(GBRAIN, ["status", "--json"]));
  return status.sync?.sources?.find((item) => item.source_id === SOURCE_ID) || null;
}

function ollamaModels() {
  try {
    const response = run(
      "/usr/bin/curl",
      ["-fsS", "--max-time", "3", `${OLLAMA_API_URL}/api/tags`],
      { timeout: 5_000 },
    );
    const payload = JSON.parse(response);
    return (payload.models || []).map((model) => model.name).filter(Boolean);
  } catch {
    return null;
  }
}

function ensureEmbeddingService() {
  if (!existsSync(GBRAIN_CONFIG_PATH)) return { provider: "unknown", started: false };
  const config = JSON.parse(readFileSync(GBRAIN_CONFIG_PATH, "utf8"));
  const embeddingModel = String(config.embedding_model || "");
  if (config.embedding_disabled || !embeddingModel.startsWith("ollama:")) {
    return {
      provider: embeddingModel.split(":")[0] || "unknown",
      started: false,
    };
  }

  const model = embeddingModel.slice("ollama:".length);
  let models = ollamaModels();
  let started = false;
  if (!models) {
    try {
      run("/bin/launchctl", [
        "kickstart",
        "-k",
        `gui/${process.getuid()}/com.ollama.ollama`,
      ], { timeout: 15_000 });
    } catch {
      run("/usr/bin/open", ["-gja", "Ollama"], { timeout: 15_000 });
    }
    started = true;
    for (let attempt = 0; attempt < 60 && !models; attempt += 1) {
      sleepSync(250);
      models = ollamaModels();
    }
  }

  if (!models) {
    throw new Error(
      "The Ollama embedding service is unavailable and could not be started automatically.",
    );
  }
  if (!models.includes(model)) {
    throw new Error(`The configured Ollama embedding model is not installed: ${model}`);
  }
  return { provider: "ollama", model, started };
}

function withCleanWorktree(commit, callback) {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "knowledge-gateway-"));
  const worktreeRoot = path.join(temporaryRoot, "worktree");
  try {
    run("git", ["worktree", "add", "--detach", worktreeRoot, commit]);
    for (const directory of KNOWLEDGE_DIRECTORIES) {
      mkdirSync(path.join(worktreeRoot, directory), { recursive: true });
    }
    return callback(worktreeRoot);
  } finally {
    try {
      run("git", ["worktree", "remove", "--force", worktreeRoot]);
    } catch {
      // The temporary directory is removed below. Preserve the caller's error.
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function synchronizeIndex(expectedCommit, { forceFull = false } = {}) {
  return withCleanWorktree(expectedCommit, (repositoryRoot) => {
    run(process.execPath, ["ops/ensure-gbrain-sync-filter.mjs"], { cwd: repositoryRoot });
    const embeddingService = ensureEmbeddingService();

    return withGbrainLock(() => {
      const before = gbrainSourceStatus();
      let syncMode = "verify";
      let needsSync = forceFull || !before || before.last_commit !== expectedCommit;

      if (!needsSync) {
        try {
          run(process.execPath, ["ops/check-index-scope.mjs"], { cwd: repositoryRoot });
        } catch {
          needsSync = true;
          forceFull = true;
        }
      }

      if (needsSync) {
        const args = [
          "sync",
          "--source",
          SOURCE_ID,
          "--repo",
          repositoryRoot,
          "--no-pull",
          "--retry-failed",
          "--yes",
        ];
        if (forceFull) args.push("--full");
        run(GBRAIN, args, { cwd: repositoryRoot, timeout: 900_000 });
        syncMode = forceFull ? "full_repair" : "incremental";
      }

      const afterSync = gbrainSourceStatus();
      if (!afterSync || afterSync.last_commit !== expectedCommit) {
        throw new Error(
          `GBrain reported success but did not reach Git commit ${expectedCommit}; `
          + `current index commit is ${afterSync?.last_commit || "missing"}.`,
        );
      }

      // Page presence must be complete before graph edges can reference new pages.
      run(process.execPath, ["ops/check-index-scope.mjs"], { cwd: repositoryRoot });
      run(process.execPath, ["ops/sync-graph.mjs"], {
        cwd: repositoryRoot,
        timeout: 900_000,
      });
      const finalStatus = gbrainSourceStatus();

      return {
        git_commit: expectedCommit,
        index_commit: finalStatus?.last_commit || null,
        pages: finalStatus?.pages ?? null,
        chunks: finalStatus?.chunks_total ?? null,
        unembedded_chunks: finalStatus?.chunks_unembedded ?? null,
        embedding_coverage_pct: finalStatus?.embedding_coverage_pct ?? null,
        sync_mode: syncMode,
        embedding_service: embeddingService,
      };
    }, 900_000);
  });
}

function gbrainCall(tool, parameters) {
  return withGbrainLock(() => {
    const output = run(GBRAIN, ["call", tool, JSON.stringify(parameters)], {
      env: { ...process.env, GBRAIN_SOURCE: SOURCE_ID },
    });
    return output ? JSON.parse(output) : null;
  });
}

function result(data, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return result({ ok: false, error: message }, true);
}

function scopeAllows(type, scope) {
  if (scope === "all") return ALL_TYPES.includes(type);
  if (scope === "evidence") return type === "source";
  return RESULT_TYPES.has(type);
}

function summarizeSearchHit(hit, { page = null, module = null } = {}) {
  const excerpt = String(hit.chunk_text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  const modules = Array.isArray(page?.frontmatter?.modules)
    ? page.frontmatter.modules.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const moduleMatch = module
    ? modules.some((item) => item.toLocaleLowerCase("zh-CN") === module.toLocaleLowerCase("zh-CN"))
    : false;
  const baseScore = Number(hit.score || 0);
  const adjustedScore = moduleMatch ? baseScore * 1.15 : baseScore;
  return {
    slug: hit.slug,
    title: hit.title,
    type: hit.type,
    score: Number(adjustedScore.toFixed(4)),
    base_score: Number(baseScore.toFixed(4)),
    modules,
    module_match: moduleMatch,
    excerpt,
    retrieval_evidence: hit.evidence || null,
    effective_date: hit.effective_date || null,
  };
}

function routeScalar(raw = "") {
  const value = String(raw).trim();
  if (
    value.length >= 2
    && ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function routeInlineList(raw = "") {
  const value = String(raw).trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return [];
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let buffer = "";
  let quote = "";
  let escaped = false;
  for (const character of inner) {
    if (escaped) {
      buffer += character;
      escaped = false;
    } else if (character === "\\" && quote) {
      buffer += character;
      escaped = true;
    } else if ((character === "\"" || character === "'") && (!quote || quote === character)) {
      quote = quote ? "" : character;
      buffer += character;
    } else if (character === "," && !quote) {
      items.push(routeScalar(buffer));
      buffer = "";
    } else {
      buffer += character;
    }
  }
  if (quote) return [];
  items.push(routeScalar(buffer));
  return items.map((item) => item.trim()).filter(Boolean);
}

function routePageMetadataFromVault(hit) {
  const slug = String(hit.slug || "");
  if (!slug || slug.includes("\\") || slug.includes("\0") || path.posix.isAbsolute(slug)) {
    return null;
  }
  const normalized = path.posix.normalize(slug.replace(/\.md$/, ""));
  if (normalized === ".." || normalized.startsWith("../")) return null;
  const absolute = path.resolve(ROOT, `${normalized}.md`);
  if (!absolute.startsWith(`${ROOT}${path.sep}`) || !existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;

  const lines = readFileSync(absolute, "utf8").replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return null;
  const closing = lines.indexOf("---", 1);
  if (closing === -1) return null;
  const fields = new Map();
  for (const line of lines.slice(1, closing)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (match) fields.set(match[1], (match[2] ?? "").trim());
  }
  return {
    title: routeScalar(fields.get("title")) || hit.title,
    type: routeScalar(fields.get("type")) || hit.type,
    tags: routeInlineList(fields.get("tags")),
    frontmatter: {
      aliases: routeInlineList(fields.get("aliases")),
      modules: routeInlineList(fields.get("modules")),
      decision_status: routeScalar(fields.get("decision_status")) || null,
      agent_priority: routeScalar(fields.get("agent_priority")) || null,
    },
  };
}

function routeCandidateFromHit(hit, page = null, retrievalRank = null) {
  const frontmatter = page?.frontmatter || {};
  return {
    slug: hit.slug,
    title: page?.title || hit.title || hit.slug,
    type: page?.type || hit.type,
    aliases: frontmatter.aliases || [],
    tags: page?.tags || frontmatter.tags || [],
    modules: frontmatter.modules || [],
    decision_status: frontmatter.decision_status || null,
    agent_priority: frontmatter.agent_priority || null,
    retrieval_evidence: hit.evidence || null,
    retrieval_rank: retrievalRank,
    base_score: Number(hit.score || 0),
    excerpt: String(hit.chunk_text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200),
  };
}

function safeRelativeTarget(target, action) {
  if (typeof target !== "string" || !target.trim()) {
    throw new Error("Every change needs a non-empty target.");
  }
  if (path.isAbsolute(target) || target.includes("\0")) {
    throw new Error(`Absolute or invalid target is not allowed: ${target}`);
  }

  const normalized = path.posix.normalize(target.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Target escapes the knowledge repository: ${target}`);
  }

  const isRootUiArtifact =
    !normalized.includes("/")
    && ROOT_UI_ARTIFACT_EXTENSIONS.has(path.posix.extname(normalized));

  if (action === "schema") {
    if (!GOVERNANCE_TARGETS.has(normalized)) {
      throw new Error(`Schema/policy change cannot target '${normalized}'.`);
    }
  } else if (action === "delete" && isRootUiArtifact) {
    // Empty or accidental Obsidian Base/Canvas files may be removed through an
    // exact, hash-pinned proposal. Other operations remain blocked at the root.
  } else if (!CONTENT_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`Knowledge change cannot target '${normalized}'.`);
  }

  if (
    !normalized.startsWith(".raw/")
    && action !== "schema"
    && !(action === "delete" && isRootUiArtifact)
    && !normalized.endsWith(".md")
  ) {
    throw new Error(`Active knowledge pages must be Markdown: ${normalized}`);
  }
  return normalized;
}

function validateChanges(changes) {
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
  return normalized;
}

function proposalHash(proposal) {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
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

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK_PATH, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      return fd;
    } catch {
      if (attempt > 0 || !existsSync(LOCK_PATH)) break;
      const pid = Number(readFileSync(LOCK_PATH, "utf8").split("\n")[0]);
      let active = Number.isInteger(pid) && pid > 0;
      if (active) {
        try {
          process.kill(pid, 0);
        } catch {
          active = false;
        }
      }
      if (active) break;
      unlinkSync(LOCK_PATH);
    }
  }
  throw new Error("Another knowledge-base approval is already running.");
}

function releaseLock(fd) {
  try {
    closeSync(fd);
  } finally {
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
  }
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

function snapshotTargets(changes) {
  const targets = new Set();
  for (const change of changes) {
    targets.add(change.target);
    if (change.new_target) targets.add(change.new_target);
  }

  const snapshots = new Map();
  for (const target of targets) {
    const absolute = path.join(ROOT, target);
    let cursor = absolute;
    while (cursor.startsWith(ROOT) && cursor !== ROOT) {
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
        throw new Error(`Symlink targets are not allowed: ${target}`);
      }
      cursor = path.dirname(cursor);
    }
    if (existsSync(absolute)) {
      const stat = statSync(absolute);
      if (!stat.isFile()) throw new Error(`Target is not a regular file: ${target}`);
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

function atomicWrite(root, relative, content) {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.gateway-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o644 });
  renameSync(temporary, absolute);
}

function applyFileChanges(root, changes) {
  for (const change of changes) {
    const absolute = path.join(root, change.target);
    if (change.action === "create") {
      if (existsSync(absolute)) throw new Error(`Create target already exists: ${change.target}`);
      atomicWrite(root, change.target, change.content);
    } else if (change.action === "update") {
      if (!existsSync(absolute)) throw new Error(`Update target does not exist: ${change.target}`);
      atomicWrite(root, change.target, change.content);
    } else if (change.action === "schema") {
      if (!existsSync(absolute) && !GOVERNANCE_CREATABLE_TARGETS.has(change.target)) {
        throw new Error(`Update target does not exist: ${change.target}`);
      }
      atomicWrite(root, change.target, change.content);
    } else if (change.action === "delete") {
      if (!existsSync(absolute)) throw new Error(`Delete target does not exist: ${change.target}`);
      rmSync(absolute);
    } else if (change.action === "move") {
      const destination = path.join(root, change.new_target);
      if (!existsSync(absolute)) throw new Error(`Move source does not exist: ${change.target}`);
      if (existsSync(destination)) throw new Error(`Move destination exists: ${change.new_target}`);
      mkdirSync(path.dirname(destination), { recursive: true });
      renameSync(absolute, destination);
    }
  }
}

function restoreSnapshots(snapshots) {
  for (const [relative, snapshot] of snapshots) {
    const absolute = path.join(ROOT, relative);
    if (snapshot.exists) {
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, snapshot.content, { mode: snapshot.mode });
    } else if (existsSync(absolute)) {
      rmSync(absolute);
    }
  }
  try {
    run("git", ["reset", "--quiet", "HEAD", "--", ...snapshots.keys()]);
  } catch {
    // Best-effort index cleanup only. Preserve the original failure.
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

function validateGatewayChanges(validationRoot, changes) {
  const gatewayTargets = changes
    .flatMap((change) => [change.target, change.new_target])
    .filter((target) => target?.startsWith("ops/gateway/"));
  if (gatewayTargets.length === 0) return;

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

  const packageFile = path.join(validationRoot, "ops/gateway/package.json");
  const lockFile = path.join(validationRoot, "ops/gateway/package-lock.json");
  if (existsSync(packageFile) && existsSync(lockFile)) {
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
    const packageLock = JSON.parse(readFileSync(lockFile, "utf8"));
    if (
      packageJson.name !== packageLock.name
      || packageJson.version !== packageLock.version
      || packageJson.version !== packageLock.packages?.[""]?.version
    ) {
      throw new Error("Gateway package.json and package-lock.json metadata do not match.");
    }
  }
}

function validateProposedChanges(changes, snapshots) {
  const head = run("git", ["rev-parse", "HEAD"]);
  withCleanWorktree(head, (validationRoot) => {
    seedValidationWorktree(validationRoot, snapshots);
    applyFileChanges(validationRoot, changes);
    run(process.execPath, ["ops/validate-vault.mjs"], { cwd: validationRoot });
    validateGatewayChanges(validationRoot, changes);
    const packChange = changes.find(
      (change) => change.target === "ops/gbrain-schema/pack.json",
    );
    if (packChange) {
      JSON.parse(readFileSync(path.join(validationRoot, packChange.target), "utf8"));
    }
  });
}

function validateActiveSchema(changes) {
  if (changes.some((change) => change.action === "schema")) {
    withGbrainLock(() => {
      run(GBRAIN, ["schema", "validate", "agent-decision-memory"]);
      run(GBRAIN, ["schema", "lint", "agent-decision-memory"]);
    });
  }
}

function isTracked(target) {
  try {
    run("git", ["ls-files", "--error-unmatch", "--", target]);
    return true;
  } catch {
    return false;
  }
}

function commitAndSynchronize(proposal, changes) {
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

  const stagedPaths = run("git", ["-c", "core.quotepath=false", "diff", "--cached", "--name-only"])
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
  const unexpected = stagedPaths.filter((target) => !paths.has(target));
  if (unexpected.length) {
    throw new Error(
      `Unrelated paths became staged during approval: ${unexpected.join(", ")}`,
    );
  }

  const subject = proposal.summary.replace(/\s+/g, " ").trim().slice(0, 60);
  const commitCreated = stagedPaths.length > 0;
  if (commitCreated) run("git", ["commit", "-m", `Knowledge: ${subject}`]);
  const commit = run("git", ["rev-parse", "HEAD"]);

  let indexStatus = "synchronized";
  let indexError = null;
  let indexDetails = null;
  try {
    indexDetails = synchronizeIndex(commit);
  } catch (error) {
    indexStatus = "failed";
    indexError = error instanceof Error ? error.message : String(error);
  }
  return { commit, commitCreated, indexStatus, indexError, indexDetails };
}

const server = new McpServer(
  {
    name: "agent-knowledge-gateway",
    version: "1.6.0",
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
      "MANDATORY first step for requests such as 录入知识库, 导入知识库, 保存到知识库, add/import/save to my knowledge base, or any requested knowledge change. Returns the canonical Obsidian destination, active Markdown format, routing rules, dedupe sequence, approval gate, and GBrain sync behavior. Read-only; it never writes or creates a proposal.",
    inputSchema: {
      user_request: z.string().max(2000).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ user_request }) => {
    try {
      return result({
        ok: true,
        recognized_request: user_request?.trim() || null,
        destination: {
          application: "Obsidian",
          vault_path: ROOT,
          source_of_truth: "Markdown files and Git history in the Obsidian vault",
          derived_retrieval_layer: "GBrain source 'knowledge' with vector embeddings",
          raw_material_policy: ".raw/ is retained in Obsidian and Git but excluded from GBrain",
        },
        mandatory_workflow: [
          "Analyze the supplied link, attachment, text, or conversation and separate evidence from inference.",
          "Call knowledge_search against result pages and, when provenance matters, evidence pages to avoid duplicates.",
          "Choose the page type by future Agent use, not by topic, author, platform, or file format.",
          "Prefer updating an existing page. Create a new page only when the existing pages cannot express the reusable result.",
          "Draft complete target-file contents and call knowledge_propose_changes. Do not edit the vault directly.",
          "Show the exact proposal to the user and wait for explicit approval.",
          "After approval, call knowledge_apply_proposal. The gateway validates, commits to Git, synchronizes GBrain embeddings, rebuilds graph links, and checks index scope.",
          "If indexing fails after the Git commit, call knowledge_repair_index. It repairs only the derived GBrain index and does not require another content proposal.",
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
        schema_contract: readFileSync(SCHEMA_PATH, "utf8"),
        agent_rules: readFileSync(AGENT_RULES_PATH, "utf8"),
        next_step:
          "Search for semantic duplicates, inspect the closest existing pages, then prepare an exact proposal with knowledge_propose_changes.",
      });
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
      const rawLimit = Math.min(100, Math.max(40, limit * 8));
      let hits;
      let retrievalMode = "hybrid";
      try {
        hits = gbrainCall("query", {
          query,
          limit: rawLimit,
          expand: false,
          source_id: SOURCE_ID,
          adaptive_return: false,
          autocut: false,
        });
      } catch {
        retrievalMode = "keyword_fallback";
        hits = gbrainCall("search", { query, limit: rawLimit });
      }

      const seen = new Set();
      const candidates = [];
      const candidateLimit = module ? Math.min(40, Math.max(12, limit * 4)) : limit;
      for (const hit of hits || []) {
        if (!scopeAllows(hit.type, scope) || seen.has(hit.slug)) continue;
        seen.add(hit.slug);
        candidates.push(hit);
        if (candidates.length === candidateLimit) break;
      }

      const filtered = module
        ? candidates
          .map((hit) => {
            const page = gbrainCall("get_page", { slug: hit.slug, fuzzy: false });
            return summarizeSearchHit(hit, { page, module });
          })
          .sort((left, right) => right.score - left.score)
          .slice(0, limit)
        : candidates.map((hit) => summarizeSearchHit(hit)).slice(0, limit);
      return result({
        ok: true,
        query,
        scope,
        module: module || null,
        module_boost_applied: Boolean(module && filtered.some((item) => item.module_match)),
        retrieval_mode: retrievalMode,
        results: filtered,
        policy:
          scope === "result"
            ? module
              ? "Global reusable-result search with a 15% boost for matching modules; modules never hide cross-module knowledge."
              : "Reusable result pages only; sources are intentionally hidden."
            : "Evidence scope is for provenance or candidate-claim review, not default factual answers.",
      });
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

    try {
      try {
        hits = gbrainCall("query", {
          query: retrievalQuery,
          limit: rawLimit,
          expand: false,
          source_id: SOURCE_ID,
          adaptive_return: false,
          autocut: false,
        }) || [];
      } catch {
        retrievalMode = "keyword_fallback";
        retrievalStatus = "degraded";
        try {
          hits = gbrainCall("search", { query: retrievalQuery, limit: rawLimit }) || [];
        } catch {
          retrievalMode = "none";
          retrievalStatus = "unavailable";
          hits = [];
        }
      }

      const seen = new Set();
      const resultHits = [];
      for (const hit of hits) {
        if (!scopeAllows(hit.type, "result") || seen.has(hit.slug)) continue;
        seen.add(hit.slug);
        resultHits.push(hit);
        if (resultHits.length >= Math.min(40, Math.max(20, limit * 6))) break;
      }

      // Markdown/Git is the source of truth. Read only the bounded candidate
      // frontmatter locally instead of spawning one GBrain process per page.
      const candidates = resultHits.map((hit, index) => (
        routeCandidateFromHit(hit, routePageMetadataFromVault(hit), index + 1)
      ));
      const routed = routeKnowledgeCandidates({
        query,
        context: context || "",
        module: module || null,
        candidates,
        retrievalStatus,
        retrievalMode,
        limit,
      });
      return result({
        ok: true,
        ...routed,
        trace_id: traceId,
        policy:
          "When action='read', fetch selected pages with knowledge_get before answering. action='review' is a candidate review signal, not permission to treat a page as fact. action='none' with retrieval.status='unavailable' does not prove the knowledge base has no relevant page.",
      });
    } catch {
      const routed = routeKnowledgeCandidates({
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
      "Read one knowledge page. Default scope blocks source pages; pass scope='evidence' or 'all' only when provenance is explicitly needed.",
    inputSchema: {
      slug: z.string().min(1),
      scope: z.enum(["result", "evidence", "all"]).default("result"),
      fuzzy: z.boolean().default(true),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ slug, scope, fuzzy }) => {
    try {
      const page = gbrainCall("get_page", { slug, fuzzy });
      if (!page) return result({ ok: false, error: `Page not found: ${slug}` }, true);
      if (!scopeAllows(page.type, scope)) {
        return result(
          {
            ok: false,
            error: `Page '${page.slug}' is type '${page.type}' and is blocked by scope '${scope}'.`,
            hint: "Use scope='evidence' only when the task requires source verification.",
          },
          true,
        );
      }
      return result({
        ok: true,
        page: {
          slug: page.slug,
          title: page.title,
          type: page.type,
          frontmatter: page.frontmatter,
          tags: page.tags,
          content: page.compiled_truth,
          timeline: page.timeline,
          updated_at: page.updated_at,
        },
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
      if (type && !scopeAllows(type, scope)) {
        return result({ ok: false, error: `Type '${type}' is blocked by scope '${scope}'.` }, true);
      }
      const pages = gbrainCall("list_pages", {
        ...(type ? { type } : {}),
        limit: 200,
        sort: "updated_desc",
      });
      const filtered = (pages || [])
        .filter((page) => scopeAllows(page.type, scope))
        .slice(0, limit);
      return result({ ok: true, scope, pages: filtered });
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
      return result({
        ok: true,
        slug,
        outgoing: gbrainCall("get_links", { slug }),
        incoming: gbrainCall("get_backlinks", { slug }),
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
      return result({
        ok: true,
        active_pack: gbrainCall("get_active_schema_pack", {}),
        canonical_vault_path: ROOT,
        source_of_truth: "Obsidian Markdown and Git",
        derived_index: `GBrain source '${SOURCE_ID}'`,
        result_types: [...RESULT_TYPES],
        evidence_type: "source",
        raw_layer: ".raw (not indexed)",
        maintenance_mode:
          "Conversation maintenance is enabled: proactively identify reusable knowledge, draft exact changes, and ask the user before applying.",
        index_repair_policy:
          "If GBrain is behind Git or an approved write reports index_status='failed', call knowledge_repair_index. Do not ask the user to run terminal commands.",
        write_policy:
          "Propose first. No knowledge mutation is permitted until the user explicitly approves the exact proposal in the current conversation.",
        classification:
          "Choose page type by future Agent use; use domain/tags/source_format/status for horizontal metadata.",
        gateway_runtime: {
          version: "1.6.0",
          target_scoped_apply: true,
          adopt_untracked_markdown_by_update: true,
          delete_root_obsidian_ui_artifacts_by_proposal: true,
          clean_worktree_validation_and_indexing: true,
          module_weighted_global_search: true,
        },
        schema_contract: readFileSync(SCHEMA_PATH, "utf8"),
        agent_rules: readFileSync(AGENT_RULES_PATH, "utf8"),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "knowledge_repair_index",
  {
    description:
      "Repair or verify the derived GBrain index against the current Obsidian/Git commit. Use immediately when an approved write returns index_status='failed', search is missing recently committed pages, or GBrain is behind Git. This may start the configured local embedding service, retry failed imports, verify every indexed page, and rebuild graph edges. It never changes Obsidian Markdown or Git and does not require content approval.",
    inputSchema: {
      force_full: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ force_full }) => {
    try {
      const head = run("git", ["rev-parse", "HEAD"]);
      const synchronization = synchronizeIndex(head, { forceFull: force_full });
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
      "Create a pending knowledge-base proposal only. This does NOT modify Obsidian, Git, GBrain, or the schema. Conversation proposals are shown in the current conversation; background proposals stay in the shared approval inbox until a review task presents them.",
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
      "Archive one pending proposal as rejected after the user explicitly rejects it. This never changes Obsidian, Git, GBrain, or the schema, and records the user's reason for audit.",
    inputSchema: {
      proposal_id: z.string().min(1),
      user_rejected: z.literal(true),
      rejection_message: z.string().min(1).max(1000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ proposal_id, user_rejected, rejection_message }) => {
    let lockFd;
    try {
      if (user_rejected !== true || !rejection_message.trim()) {
        throw new Error("Explicit conversation rejection is required.");
      }
      lockFd = acquireLock();
      const { file, record } = readProposal(proposal_id);
      const rejectedRecord = {
        ...record,
        rejected_at: new Date().toISOString(),
        rejection: {
          channel: "conversation",
          message: rejection_message.trim(),
        },
      };
      const rejectedPath = proposalPath(proposal_id, REJECTED_DIR);
      if (existsSync(rejectedPath)) {
        throw new Error(`Rejected proposal archive already exists: ${proposal_id}`);
      }
      const temporary = `${rejectedPath}.tmp-${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(rejectedRecord, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, rejectedPath);
      unlinkSync(file);
      return result({
        ok: true,
        proposal_id,
        rejected: true,
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  },
  async ({ proposal_id, user_approved, approval_message }) => {
    let lockFd;
    let snapshots;
    let changes;
    let liveMutationStarted = false;
    let commitCreated = false;
    let appliedArchived = false;
    try {
      lockFd = acquireLock();
      const { file, record } = readProposal(proposal_id);
      changes = validateChanges(record.proposal.changes);
      if (user_approved !== true || !approval_message.trim()) {
        throw new Error("Explicit conversation approval is required.");
      }

      assertNoStagedChanges();
      snapshots = snapshotTargets(changes);
      assertProposalPreconditions(record.proposal.preconditions, snapshots);
      validateProposedChanges(changes, snapshots);

      // Validation can take time. Re-read every approved target so a concurrent
      // writer cannot slip a changed file between the proposal baseline and apply.
      const currentSnapshots = snapshotTargets(changes);
      assertProposalPreconditions(record.proposal.preconditions, currentSnapshots);
      snapshots = currentSnapshots;
      liveMutationStarted = true;
      applyFileChanges(ROOT, changes);
      try {
        validateActiveSchema(changes);
      } catch (error) {
        restoreSnapshots(snapshots);
        liveMutationStarted = false;
        throw error;
      }

      const synchronization = commitAndSynchronize(record.proposal, changes);
      commitCreated = synchronization.commitCreated;
      const appliedRecord = {
        ...record,
        approved_at: new Date().toISOString(),
        approval: {
          channel: "conversation",
          message: approval_message.trim(),
        },
        git_commit: synchronization.commit,
        commit_created: synchronization.commitCreated,
        index_status: synchronization.indexStatus,
        index_error: synchronization.indexError,
        index_details: synchronization.indexDetails,
      };
      const appliedPath = proposalPath(proposal_id, APPLIED_DIR);
      writeFileSync(appliedPath, `${JSON.stringify(appliedRecord, null, 2)}\n`, {
        mode: 0o600,
      });
      unlinkSync(file);
      appliedArchived = true;

      return result({
        ok: synchronization.indexStatus === "synchronized",
        proposal_id,
        approved: true,
        knowledge_modified: true,
        git_commit: synchronization.commit,
        commit_created: synchronization.commitCreated,
        index_status: synchronization.indexStatus,
        index_error: synchronization.indexError,
        index_details: synchronization.indexDetails,
      }, synchronization.indexStatus !== "synchronized");
    } catch (error) {
      if (liveMutationStarted && snapshots && changes && !commitCreated && !appliedArchived) {
        try {
          restoreSnapshots(snapshots);
        } catch {
          // Preserve the original error; Git remains the audit surface.
        }
      }
      return errorResult(error);
    } finally {
      if (lockFd !== undefined) releaseLock(lockFd);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
