import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const APPLY_TRANSACTION_PROTOCOL = "agent-knowledge-apply-transaction/v1";
const COMMIT_HOOK_NAMES = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-index-change",
  "reference-transaction",
];

function git(root, args, { buffer = false, input = undefined } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: buffer ? null : "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

export function assertNoActiveCommitHooks({ root }) {
  const active = [];
  for (const name of COMMIT_HOOK_NAMES) {
    const configured = git(root, ["rev-parse", "--git-path", `hooks/${name}`]).trim();
    const hookPath = path.resolve(root, configured);
    if (!existsSync(hookPath)) continue;
    const stat = lstatSync(hookPath);
    if (stat.isSymbolicLink() || (stat.isFile() && (stat.mode & 0o111) !== 0)) {
      active.push(name);
    }
  }
  if (active.length > 0) {
    throw new Error(
      `Active Git commit hooks are not allowed during proposal apply: ${active.join(", ")}.`,
    );
  }
  return true;
}

function readIndexEntry(root, relative) {
  const output = git(root, ["ls-files", "--stage", "-z", "--", relative], { buffer: true });
  const records = output.toString("utf8").split("\0").filter(Boolean);
  if (records.length === 0) return null;
  if (records.length !== 1) {
    throw new Error(`Git index has multiple stages for apply target '${relative}'.`);
  }
  const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) (\d)\t(.+)$/.exec(records[0]);
  if (!match || match[3] !== "0" || match[4] !== relative) {
    throw new Error(`Git index entry is invalid for apply target '${relative}'.`);
  }
  return { mode: match[1], oid: match[2] };
}

function gitBlobOid(root, content) {
  return git(root, ["hash-object", "--stdin"], { input: content }).trim();
}

function optionalGitConfig(root, key) {
  try {
    return git(root, ["config", "--get", key]).trim();
  } catch (error) {
    if (error?.status === 1) return "";
    throw error;
  }
}

function assertNoGitContentTransforms(root, targets) {
  const autocrlf = optionalGitConfig(root, "core.autocrlf").toLowerCase();
  if (autocrlf && !new Set(["false", "no", "off", "0"]).has(autocrlf)) {
    throw new Error("Git core.autocrlf must be disabled before recording durable approval.");
  }
  const attributes = ["filter", "working-tree-encoding", "ident", "text", "eol"];
  for (const target of targets) {
    const fields = git(root, [
      "check-attr",
      "-z",
      ...attributes,
      "--",
      target,
    ], { buffer: true }).toString("utf8").split("\0").filter(Boolean);
    if (fields.length !== attributes.length * 3) {
      throw new Error(`Cannot verify Git content attributes for '${target}'.`);
    }
    for (let index = 0; index < fields.length; index += 3) {
      const [reportedTarget, attribute, value] = fields.slice(index, index + 3);
      if (reportedTarget !== target || !attributes.includes(attribute)) {
        throw new Error(`Git returned an invalid content attribute record for '${target}'.`);
      }
      if (!new Set(["unspecified", "unset"]).has(value)) {
        throw new Error(
          `Git attribute '${attribute}' transforms approved bytes for '${target}'; approval stopped.`,
        );
      }
    }
  }
}

function sameIndexEntry(left, right) {
  if (!left || !right) return left === right;
  return left.mode === right.mode && left.oid === right.oid;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function mismatch(reason) {
  return { matched: false, reason };
}

function uniqueTargets(changes) {
  return [...new Set(changes.flatMap((change) => (
    [change.target, change.new_target].filter(Boolean)
  )))];
}

/** Keep only the immutable baseline facts needed for post-receipt Git proof. */
export function compactApplyBaseline(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new Error("Apply baseline must contain at least one target.");
  }
  const seen = new Set();
  return snapshots.map((snapshot) => {
    if (
      !snapshot
      || !safeRelativePath(snapshot.target)
      || typeof snapshot.exists !== "boolean"
      || seen.has(snapshot.target)
    ) {
      throw new Error("Apply baseline contains an invalid or duplicate target.");
    }
    seen.add(snapshot.target);
    if (!snapshot.exists) return { target: snapshot.target, exists: false };
    if (
      !Number.isInteger(snapshot.mode)
      || snapshot.mode < 0
      || snapshot.mode > 0o777
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.sha256 || "")
    ) {
      throw new Error("Apply baseline contains an invalid file preimage.");
    }
    return {
      target: snapshot.target,
      exists: true,
      sha256: snapshot.sha256,
      mode: snapshot.mode,
    };
  });
}

/** Governance/schema changes and knowledge content require separate approvals. */
export function assertProposalChangeIsolation(changes, { governanceDeleteTargets = new Set() } = {}) {
  if (!Array.isArray(changes) || changes.length === 0) return;
  const isGovernance = (change) => (
    change?.action === "schema"
    || (change?.action === "delete" && governanceDeleteTargets.has(change?.target))
  );
  const hasGovernance = changes.some(isGovernance);
  const hasContent = changes.some((change) => !isGovernance(change));
  if (hasGovernance && hasContent) {
    throw new Error(
      "Schema/governance changes and knowledge-content changes require separate proposals and separate approval.",
    );
  }
}

function readTreeEntry(root, commit, relative) {
  const output = git(root, ["ls-tree", "-z", "--full-tree", commit, "--", relative], {
    buffer: true,
  });
  const records = output.toString("utf8").split("\0").filter(Boolean);
  const matching = records.filter((record) => record.slice(record.indexOf("\t") + 1) === relative);
  if (matching.length === 0) return null;
  if (matching.length !== 1) {
    throw new Error(`Git tree lookup was ambiguous for '${relative}'.`);
  }
  const [metadata] = matching[0].split("\t", 1);
  const [mode, type, oid] = metadata.split(" ");
  const content = type === "blob"
    ? git(root, ["cat-file", "blob", oid], { buffer: true })
    : null;
  return { mode, type, oid, content };
}

function readCommitIndexEntry(root, commit, relative) {
  const entry = readTreeEntry(root, commit, relative);
  if (!entry) return null;
  if (!isRegularBlob(entry)) {
    throw new Error(`Git tree target is not a regular file: '${relative}'.`);
  }
  return { mode: entry.mode, oid: entry.oid };
}

function isRegularBlob(entry) {
  return Boolean(entry && entry.type === "blob" && ["100644", "100755"].includes(entry.mode));
}

function sameEntry(left, right) {
  if (!left || !right) return left === right;
  return left.mode === right.mode
    && left.type === right.type
    && left.oid === right.oid;
}

function verifyWorktreeMatchesCommit({ root, commit, targets }) {
  for (const target of targets) {
    let expected;
    let stat = null;
    let absolute;
    try {
      expected = readTreeEntry(root, commit, target);
      absolute = safeAbsolutePath(root, target);
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } catch {
      return mismatch("WORKTREE_TARGET_UNREADABLE");
    }
    if (!expected) {
      if (stat) return mismatch("WORKTREE_EXISTENCE_MISMATCH");
      continue;
    }
    if (
      !isRegularBlob(expected)
      || !stat?.isFile()
      || stat.isSymbolicLink()
    ) {
      return mismatch("WORKTREE_TYPE_MISMATCH");
    }
    const worktreeMode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
    if (worktreeMode !== expected.mode) return mismatch("WORKTREE_MODE_MISMATCH");
    if (!readFileSync(absolute).equals(expected.content)) {
      return mismatch("WORKTREE_CONTENT_MISMATCH");
    }
  }
  return { matched: true };
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every((item) => right.has(item));
}

function proposalHash(proposal) {
  const serialized = JSON.stringify(proposal);
  return typeof serialized === "string" ? sha256(serialized) : null;
}

function safeRelativePath(relative) {
  return typeof relative === "string"
    && relative.length > 0
    && !path.posix.isAbsolute(relative)
    && !/[\u0000-\u001f\u007f]/u.test(relative)
    && !relative.includes("\\")
    && path.posix.normalize(relative) === relative
    && relative !== ".."
    && !relative.startsWith("../");
}

function safeAbsolutePath(root, relative) {
  if (!safeRelativePath(relative)) {
    throw new Error(`Unsafe apply transaction target: '${relative}'.`);
  }
  const resolvedRoot = path.resolve(root);
  const absolute = path.resolve(resolvedRoot, relative);
  if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Apply transaction target escapes the repository: '${relative}'.`);
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
      throw new Error(`Symlink apply transaction targets are not allowed: '${relative}'.`);
    }
    cursor = path.dirname(cursor);
  }
  return absolute;
}

function snapshotIdentity(snapshot) {
  if (!snapshot?.exists) return "missing";
  return `${snapshot.mode}:${sha256(snapshot.content)}`;
}

function transactionEntry(root, snapshot) {
  const absolute = safeAbsolutePath(root, snapshot.target);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Apply transaction target is not a regular file: '${snapshot.target}'.`);
  }
  return {
    exists: true,
    content: readFileSync(absolute),
    mode: stat.mode & 0o777,
  };
}

function deserializeSnapshot(snapshot) {
  if (!snapshot.exists) return { target: snapshot.target, exists: false };
  const content = Buffer.from(snapshot.content_base64, "base64");
  return {
    target: snapshot.target,
    exists: true,
    content,
    mode: snapshot.mode,
  };
}

function validIndexEntry(entry) {
  return entry === null || (
    entry
    && ["100644", "100755"].includes(entry.mode)
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid || "")
    && Object.keys(entry).length === 2
  );
}

function validateTransactionRecord(record) {
  if (
    !record
    || record.protocol !== APPLY_TRANSACTION_PROTOCOL
    || typeof record.proposal_id !== "string"
    || !record.proposal_id
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.proposal_sha256 || "")
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.changes_sha256 || "")
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.execution_parent || "")
    || typeof record.approved_at !== "string"
    || !record.approved_at
    || record.approval?.channel !== "conversation"
    || typeof record.approval?.message !== "string"
    || !record.approval.message.trim()
    || !/^[a-f0-9]{32}$/.test(record.token || "")
    || !Array.isArray(record.changes)
    || record.changes.length === 0
    || record.changes.length > 100
    || sha256(JSON.stringify(record.changes)) !== record.changes_sha256
    || !Array.isArray(record.snapshots)
    || record.snapshots.length === 0
  ) {
    throw new Error("Invalid durable apply transaction record.");
  }

  const targetList = [];
  for (const change of record.changes) {
    if (
      !change
      || !["create", "update", "schema", "delete", "move"].includes(change.action)
      || !safeRelativePath(change.target)
      || (["create", "update", "schema"].includes(change.action) && typeof change.content !== "string")
      || (change.action === "move" && !safeRelativePath(change.new_target))
    ) {
      throw new Error("Invalid change in durable apply transaction record.");
    }
    targetList.push(change.target);
    if (change.new_target) targetList.push(change.new_target);
  }
  if (new Set(targetList).size !== targetList.length) {
    throw new Error("Durable apply transaction targets are not unique.");
  }

  const snapshotTargets = new Set();
  for (const snapshot of record.snapshots) {
    if (
      !snapshot
      || !safeRelativePath(snapshot.target)
      || typeof snapshot.exists !== "boolean"
      || snapshotTargets.has(snapshot.target)
    ) {
      throw new Error("Invalid snapshot in durable apply transaction record.");
    }
    if (!validIndexEntry(snapshot.index_before) || !validIndexEntry(snapshot.index_after)) {
      throw new Error("Invalid Git index boundary in durable apply transaction record.");
    }
    snapshotTargets.add(snapshot.target);
    if (snapshot.exists) {
      if (
        !Number.isInteger(snapshot.mode)
        || snapshot.mode < 0
        || snapshot.mode > 0o777
        || typeof snapshot.content_base64 !== "string"
        || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.sha256 || "")
      ) {
        throw new Error("Invalid preimage in durable apply transaction record.");
      }
      const content = Buffer.from(snapshot.content_base64, "base64");
      if (
        content.toString("base64") !== snapshot.content_base64
        || sha256(content) !== snapshot.sha256
      ) {
        throw new Error("Durable apply transaction preimage integrity check failed.");
      }
    } else if (
      snapshot.content_base64 !== undefined
      || snapshot.sha256 !== undefined
      || snapshot.mode !== undefined
    ) {
      throw new Error("Missing preimage cannot contain file bytes or mode.");
    }
  }
  if (!sameSet(snapshotTargets, new Set(targetList))) {
    throw new Error("Durable apply transaction snapshots do not match its targets.");
  }
  return record;
}

function appliedRecordsByCommit(appliedDir) {
  const records = new Map();
  if (!appliedDir || !existsSync(appliedDir)) return records;
  for (const entry of readdirSync(appliedDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let record;
    try {
      record = JSON.parse(readFileSync(path.join(appliedDir, entry.name), "utf8"));
      validateAppliedArchiveRecord(record, record, {
        allowLegacyExecutionParent: true,
        allowLegacyCommitCreated: true,
      });
    } catch {
      continue;
    }
    const expectedName = `${record?.proposal?.id || ""}.json`;
    if (
      entry.name !== expectedName
      || record.commit_created === false
    ) {
      continue;
    }
    if (records.has(record.git_commit)) records.set(record.git_commit, null);
    else records.set(record.git_commit, record);
  }
  return records;
}

export function proposalCommitSubject(proposal) {
  const normalized = String(proposal?.summary || "").replace(/\s+/g, " ").trim();
  const subject = [...normalized].slice(0, 60).join("");
  return `Knowledge: ${subject}`;
}

function legacyProposalCommitSubject(proposal) {
  const normalized = String(proposal?.summary || "").replace(/\s+/g, " ").trim();
  const utf16Truncated = `Knowledge: ${normalized.slice(0, 60)}`;
  return Buffer.from(utf16Truncated, "utf8").toString("utf8");
}

function proposalCommitSubjectMatches(subject, proposal) {
  return new Set([
    proposalCommitSubject(proposal),
    legacyProposalCommitSubject(proposal),
  ]).has(subject);
}

function verifyProposalCommit({
  root,
  proposal,
  changes,
  commit,
  parentCommit,
  historyBaseCommit = proposal?.base_commit,
  baselineSnapshots = null,
}) {
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proposal?.base_commit || "")
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit || "")
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parentCommit || "")
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(historyBaseCommit || "")
    || !Array.isArray(changes)
    || changes.length === 0
    || changes.length > 100
  ) {
    return mismatch("INVALID_CHANGE_SET");
  }
  const targetList = [];
  let validChanges = true;
  for (const change of changes) {
    if (
      !change
      || !["create", "update", "schema", "delete", "move"].includes(change.action)
      || typeof change.target !== "string"
      || !change.target
      || (["create", "update", "schema"].includes(change.action) && typeof change.content !== "string")
      || (change.action === "move" && (typeof change.new_target !== "string" || !change.new_target))
    ) {
      validChanges = false;
      continue;
    }
    const paths = [change.target, change.new_target].filter(Boolean);
    if (paths.some((target) => !safeRelativePath(target))) {
      validChanges = false;
      continue;
    }
    targetList.push(...paths);
  }
  if (
    !validChanges
    || new Set(targetList).size !== targetList.length
  ) {
    return mismatch("INVALID_CHANGE_SET");
  }
  const targets = uniqueTargets(changes);
  const targetSet = new Set(targets);

  const subject = git(root, ["show", "-s", "--format=%s", commit]).trimEnd();
  if (!proposalCommitSubjectMatches(subject, proposal)) {
    return mismatch("COMMIT_SUBJECT_MISMATCH");
  }

  const preconditions = proposal.preconditions;
  if (!preconditions || Array.isArray(preconditions) || typeof preconditions !== "object") {
    return mismatch("INVALID_BASELINE");
  }
  if (!sameSet(new Set(Object.keys(preconditions)), targetSet)) {
    return mismatch("BASELINE_TARGET_SET_MISMATCH");
  }

  // The proposal baseline may have been captured from dirty or untracked
  // worktree bytes. A durable WAL is authoritative for that preimage. Without
  // one, intervening commits are acceptable only when approved targets did not
  // change between proposal.base_commit and the candidate's actual parent.
  const targetHistory = git(root, [
    "diff",
    "--name-only",
    "-z",
    historyBaseCommit,
    parentCommit,
    "--",
    ...targets,
  ], { buffer: true });
  if (targetHistory.length > 0) return mismatch("TARGET_CHANGED_BEFORE_PROPOSAL_COMMIT");

  const parentEntries = new Map();
  const baselineModes = new Map();
  for (const target of targets) {
    const parentEntry = readTreeEntry(root, parentCommit, target);
    parentEntries.set(target, parentEntry);
    const expected = preconditions[target];
    if (!expected || typeof expected.exists !== "boolean") {
      return mismatch("INVALID_BASELINE");
    }
    if (parentEntry && !isRegularBlob(parentEntry)) {
      return mismatch("BASELINE_CONTENT_MISMATCH");
    }
    if (!expected.exists && parentEntry) return mismatch("BASELINE_EXISTENCE_MISMATCH");
    if (
      expected.exists
      && (typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256))
    ) {
      return mismatch("INVALID_BASELINE");
    }

    if (baselineSnapshots) {
      const snapshot = baselineSnapshots.get(target);
      if (!snapshot || snapshot.exists !== expected.exists) {
        return mismatch("BASELINE_EXISTENCE_MISMATCH");
      }
      if (snapshot.exists) {
        if (snapshot.sha256 !== expected.sha256) {
          return mismatch("BASELINE_CONTENT_MISMATCH");
        }
        baselineModes.set(target, (snapshot.mode & 0o111) === 0 ? "100644" : "100755");
      }
    } else {
      const proposalBaseEntry = readTreeEntry(root, proposal.base_commit, target);
      if (proposalBaseEntry) {
        if (!isRegularBlob(proposalBaseEntry) || !expected.exists) {
          return mismatch("BASELINE_EXISTENCE_MISMATCH");
        }
        if (expected.sha256 !== sha256(proposalBaseEntry.content)) {
          return mismatch("BASELINE_CONTENT_MISMATCH");
        }
        baselineModes.set(target, proposalBaseEntry.mode);
      } else if (!expected.exists) {
        baselineModes.set(target, null);
      } else {
        // An update/move can intentionally adopt a file that was untracked at
        // proposal creation. Its declared preimage hash is not reconstructible
        // from Git without a WAL, so final bytes and exact path/subject evidence
        // remain the recoverable boundary.
        baselineModes.set(target, null);
      }
    }
  }

  if (baselineSnapshots && !sameSet(new Set(baselineSnapshots.keys()), targetSet)) {
    return mismatch("BASELINE_TARGET_SET_MISMATCH");
  }

  const expectedChangedPaths = new Set();
  for (const change of changes) {
    const parentSource = parentEntries.get(change.target);
    const finalSource = readTreeEntry(root, commit, change.target);
    const declaredSource = preconditions[change.target];
    if (change.action === "create" && declaredSource.exists) {
      return mismatch("INVALID_ACTION_BASELINE");
    }
    if (["update", "delete", "move"].includes(change.action) && !declaredSource.exists) {
      return mismatch("INVALID_ACTION_BASELINE");
    }
    if (["create", "update", "schema"].includes(change.action)) {
      const desired = Buffer.from(change.content, "utf8");
      if (!isRegularBlob(finalSource) || finalSource.mode !== "100644" || !finalSource.content.equals(desired)) {
        return mismatch("FINAL_CONTENT_MISMATCH");
      }
      if (!parentSource || parentSource.mode !== "100644" || !parentSource.content.equals(desired)) {
        expectedChangedPaths.add(change.target);
      }
    } else if (change.action === "delete") {
      if (finalSource) return mismatch("FINAL_EXISTENCE_MISMATCH");
      if (parentSource) expectedChangedPaths.add(change.target);
    } else if (change.action === "move") {
      const finalDestination = readTreeEntry(root, commit, change.new_target);
      const parentDestination = parentEntries.get(change.new_target);
      const expectedMode = baselineModes.get(change.target);
      if (
        preconditions[change.new_target]?.exists !== false
        || parentDestination
        || finalSource
        || !isRegularBlob(finalDestination)
        || sha256(finalDestination.content) !== declaredSource.sha256
        || !expectedMode
        || finalDestination.mode !== expectedMode
      ) {
        return mismatch("FINAL_MOVE_MISMATCH");
      }
      if (parentSource) expectedChangedPaths.add(change.target);
      expectedChangedPaths.add(change.new_target);
    }
  }

  const changedOutput = git(root, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "--no-renames",
    "-r",
    "-z",
    parentCommit,
    commit,
  ], { buffer: true });
  const changedPaths = new Set(changedOutput.toString("utf8").split("\0").filter(Boolean));
  if (!sameSet(changedPaths, expectedChangedPaths)) {
    return mismatch("CHANGED_PATH_SET_MISMATCH");
  }
  return { matched: true, targets };
}

function verifyAppliedDescendantChain({ root, ancestorCommit, head, appliedDir }) {
  if (ancestorCommit === head) return { matched: true };
  try {
    git(root, ["merge-base", "--is-ancestor", ancestorCommit, head]);
  } catch {
    return mismatch("DESCENDANT_NOT_LINEAR_ANCESTOR");
  }
  const ancestryLines = git(root, [
    "rev-list",
    "--first-parent",
    "--reverse",
    "--parents",
    `${ancestorCommit}..${head}`,
  ]).trim().split("\n").filter(Boolean);
  if (ancestryLines.length > 256) return mismatch("DESCENDANT_HISTORY_TOO_DEEP");

  const applied = appliedRecordsByCommit(appliedDir);
  let expectedParent = ancestorCommit;
  for (const line of ancestryLines) {
    const [commit, ...parents] = line.split(/\s+/);
    if (parents.length !== 1 || parents[0] !== expectedParent) {
      return mismatch("UNVERIFIED_DESCENDANT_COMMIT");
    }
    const parent = parents[0];
    const record = applied.get(commit);
    if (!record) return mismatch("UNVERIFIED_DESCENDANT_COMMIT");
    if (record.execution_parent && record.execution_parent !== parent) {
      return mismatch("UNVERIFIED_DESCENDANT_COMMIT");
    }
    let baselineSnapshots = null;
    if (record.execution_baseline) {
      try {
        baselineSnapshots = new Map(
          compactApplyBaseline(record.execution_baseline).map((snapshot) => [snapshot.target, snapshot]),
        );
      } catch {
        return mismatch("UNVERIFIED_DESCENDANT_COMMIT");
      }
    }
    const descendant = verifyProposalCommit({
      root,
      proposal: record.proposal,
      changes: record.proposal.changes,
      commit,
      parentCommit: parent,
      historyBaseCommit: record.execution_parent || record.proposal.base_commit,
      baselineSnapshots,
    });
    if (!descendant.matched) return mismatch("UNVERIFIED_DESCENDANT_COMMIT");
    expectedParent = commit;
  }
  if (expectedParent !== head) return mismatch("UNVERIFIED_DESCENDANT_COMMIT");
  return { matched: true };
}

/** Prove a durable no-commit receipt without treating HEAD equality as execution state. */
export function verifyNoCommitAppliedReceipt({ root, receipt, appliedDir }) {
  if (
    receipt?.commit_created !== false
    || receipt?.git_commit !== receipt?.execution_parent
    || !receipt?.execution_baseline
  ) {
    return mismatch("INVALID_NO_COMMIT_RECEIPT");
  }
  const proposal = receipt.proposal;
  const changes = proposal?.changes;
  const preconditions = proposal?.preconditions;
  if (!Array.isArray(changes) || !preconditions || typeof preconditions !== "object") {
    return mismatch("INVALID_NO_COMMIT_RECEIPT");
  }
  let baseline;
  try {
    baseline = new Map(
      compactApplyBaseline(receipt.execution_baseline).map((snapshot) => [snapshot.target, snapshot]),
    );
  } catch {
    return mismatch("INVALID_NO_COMMIT_RECEIPT");
  }
  if (!sameSet(new Set(baseline.keys()), new Set(uniqueTargets(changes)))) {
    return mismatch("INVALID_NO_COMMIT_RECEIPT");
  }

  for (const change of changes) {
    const snapshot = baseline.get(change.target);
    const declared = preconditions[change.target];
    if (
      !snapshot
      || snapshot.exists !== declared?.exists
      || (snapshot.exists && snapshot.sha256 !== declared.sha256)
    ) {
      return mismatch("INVALID_NO_COMMIT_RECEIPT");
    }
    const treeSource = readTreeEntry(root, receipt.git_commit, change.target);
    if (["create", "update", "schema"].includes(change.action)) {
      const desired = Buffer.from(change.content, "utf8");
      if (!isRegularBlob(treeSource) || treeSource.mode !== "100644" || !treeSource.content.equals(desired)) {
        return mismatch("NO_COMMIT_TREE_MISMATCH");
      }
    } else if (change.action === "delete") {
      if (treeSource) return mismatch("NO_COMMIT_TREE_MISMATCH");
    } else {
      // A move has two observable path effects and cannot be accepted as a
      // no-commit operation without a Git object proving the destination.
      return mismatch("NO_COMMIT_MOVE_UNPROVEN");
    }
  }

  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const descendants = verifyAppliedDescendantChain({
    root,
    ancestorCommit: receipt.git_commit,
    head,
    appliedDir,
  });
  if (!descendants.matched) return descendants;

  const targets = uniqueTargets(changes);
  const exactWorktree = verifyWorktreeMatchesCommit({ root, commit: head, targets });
  if (!exactWorktree.matched) return exactWorktree;
  const worktreeStatus = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ...targets,
  ], { buffer: true });
  if (worktreeStatus.length > 0) return mismatch("TOUCHED_PATHS_DIRTY");
  return {
    matched: true,
    current_head: head,
    execution_parent: receipt.execution_parent,
    reason: "EXACT_NO_COMMIT_RECEIPT",
  };
}

/**
 * Find exactly one first-parent commit that is byte-, path-, subject- and
 * baseline-identical to the pending proposal. A durable WAL supplies the true
 * execution parent and worktree preimages when proposal.base_commit is older
 * or the proposal intentionally adopted untracked/dirty content.
 */
export function detectExactCommittedProposal({
  root,
  proposal,
  changes,
  appliedDir,
  recoveryRecord = null,
}) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proposal?.base_commit || "")) {
    return mismatch("INVALID_BASE_COMMIT");
  }

  let historyBaseCommit = proposal.base_commit;
  let baselineSnapshots = null;
  if (recoveryRecord) {
    if (
      recoveryRecord.proposal_id !== proposal.id
      || recoveryRecord.proposal_sha256 !== proposalHash(proposal)
      || recoveryRecord.changes_sha256 !== sha256(JSON.stringify(changes))
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(recoveryRecord.execution_parent || "")
    ) {
      return mismatch("INVALID_RECOVERY_RECORD");
    }
    historyBaseCommit = recoveryRecord.execution_parent;
    try {
      baselineSnapshots = new Map(
        compactApplyBaseline(recoveryRecord.snapshots).map((snapshot) => [snapshot.target, snapshot]),
      );
    } catch {
      return mismatch("INVALID_RECOVERY_RECORD");
    }
  }

  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  try {
    git(root, ["merge-base", "--is-ancestor", historyBaseCommit, head]);
  } catch {
    return {
      ...mismatch("BASE_NOT_LINEAR_ANCESTOR"),
      possible_proposal_commit: true,
    };
  }
  const ancestryLines = git(root, [
    "rev-list",
    "--first-parent",
    "--reverse",
    "--parents",
    `${historyBaseCommit}..${head}`,
  ]).trim().split("\n").filter(Boolean);
  if (ancestryLines.length === 0) return mismatch("PROPOSAL_COMMIT_MISSING");
  let expectedParent = historyBaseCommit;
  for (const line of ancestryLines) {
    const [commit, ...parents] = line.split(/\s+/);
    if (parents.length !== 1 || parents[0] !== expectedParent) {
      return {
        ...mismatch("BASE_NOT_LINEAR_ANCESTOR"),
        possible_proposal_commit: true,
      };
    }
    expectedParent = commit;
  }
  if (expectedParent !== head) {
    return {
      ...mismatch("BASE_NOT_LINEAR_ANCESTOR"),
      possible_proposal_commit: true,
    };
  }
  if (ancestryLines.length > 256) {
    const subjects = git(root, [
      "log",
      "--first-parent",
      "-z",
      "--format=%s",
      `${historyBaseCommit}..${head}`,
    ], { buffer: true }).toString("utf8").split("\0").filter(Boolean);
    if (subjects.some((subject) => proposalCommitSubjectMatches(subject, proposal))) {
      return {
        ...mismatch("PROPOSAL_COMMIT_TOO_OLD"),
        possible_proposal_commit: true,
      };
    }
    return mismatch("PROPOSAL_COMMIT_TOO_OLD");
  }

  const candidates = [];
  const candidateMismatches = [];
  for (const line of ancestryLines) {
    const [commit, parent] = line.split(/\s+/);
    const subject = git(root, ["show", "-s", "--format=%s", commit]).trimEnd();
    if (!proposalCommitSubjectMatches(subject, proposal)) continue;
    const exact = verifyProposalCommit({
      root,
      proposal,
      changes,
      commit,
      parentCommit: parent,
      historyBaseCommit,
      baselineSnapshots,
    });
    if (exact.matched) candidates.push({ commit, parent, exact });
    else candidateMismatches.push(exact);
  }
  if (candidates.length === 0) {
    if (candidateMismatches.length > 0) {
      return {
        ...(candidateMismatches.length === 1
          ? candidateMismatches[0]
          : mismatch("AMBIGUOUS_PROPOSAL_COMMIT")),
        possible_proposal_commit: true,
      };
    }
    if (ancestryLines.length === 1) return mismatch("COMMIT_SUBJECT_MISMATCH");
    return mismatch("PROPOSAL_COMMIT_MISSING");
  }
  if (candidates.length > 1) {
    return { ...mismatch("AMBIGUOUS_PROPOSAL_COMMIT"), proposal_commit_found: true };
  }
  const [{ commit: proposalCommit, parent: proposalParent, exact }] = candidates;
  const proposalIndex = ancestryLines.findIndex((line) => line.startsWith(`${proposalCommit} `));

  if (proposalIndex < ancestryLines.length - 1) {
    const descendants = verifyAppliedDescendantChain({
      root,
      ancestorCommit: proposalCommit,
      head,
      appliedDir,
    });
    if (!descendants.matched) {
      return {
        ...descendants,
        proposal_commit_found: true,
        commit: proposalCommit,
      };
    }
  }

  const worktreeStatus = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ...exact.targets,
  ], { buffer: true });
  if (worktreeStatus.length > 0) {
    return {
      ...mismatch("TOUCHED_PATHS_DIRTY"),
      proposal_commit_found: true,
      commit: proposalCommit,
    };
  }

  return {
    matched: true,
    commit: proposalCommit,
    current_head: head,
    base_commit: proposal.base_commit,
    execution_parent: proposalParent,
    reason: "EXACT_PROPOSAL_COMMIT",
  };
}

function sameArchiveIdentity(existing, expected) {
  return existing?.sha256 === proposalHash(existing?.proposal)
    && existing?.sha256 === expected?.sha256
    && existing?.proposal?.id === expected?.proposal?.id
    && existing?.git_commit === expected?.git_commit
    && existing?.approval?.channel === expected?.approval?.channel
    && existing?.approval?.message === expected?.approval?.message;
}

function archiveConflict(appliedRecord) {
  return new Error(
    `Applied proposal archive conflicts with pending state: ${appliedRecord?.proposal?.id || "unknown"}`,
  );
}

function validReceiptBaseline(record) {
  if (record?.execution_baseline === undefined) return true;
  let compact;
  try {
    compact = compactApplyBaseline(record.execution_baseline);
  } catch {
    return false;
  }
  const changes = record?.proposal?.changes;
  const preconditions = record?.proposal?.preconditions;
  if (
    !Array.isArray(changes)
    || !preconditions
    || Array.isArray(preconditions)
    || typeof preconditions !== "object"
    || !sameSet(new Set(compact.map(({ target }) => target)), new Set(uniqueTargets(changes)))
  ) {
    return false;
  }
  return compact.every((snapshot, index) => {
    const original = record.execution_baseline[index];
    const allowedKeys = snapshot.exists
      ? new Set(["target", "exists", "sha256", "mode"])
      : new Set(["target", "exists"]);
    const expected = preconditions[snapshot.target];
    return sameSet(new Set(Object.keys(original)), allowedKeys)
      && expected?.exists === snapshot.exists
      && (!snapshot.exists || expected.sha256 === snapshot.sha256);
  });
}

function validateAppliedArchiveRecord(
  existing,
  expectedRecord,
  {
    allowLegacyExecutionParent = false,
    allowLegacyCommitCreated = false,
  } = {},
) {
  if (
    existing?.sha256 !== proposalHash(existing?.proposal)
    || existing?.proposal?.id !== expectedRecord?.proposal?.id
    || existing?.sha256 !== expectedRecord?.sha256
    || existing?.approval?.channel !== "conversation"
    || typeof existing?.approval?.message !== "string"
    || !existing.approval.message.trim()
    || typeof existing?.approved_at !== "string"
    || !existing.approved_at
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(existing?.git_commit || "")
    || (existing?.execution_parent === undefined
      ? !allowLegacyExecutionParent
      : !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(existing.execution_parent))
    || (existing?.commit_created === undefined
      ? !allowLegacyCommitCreated
      : typeof existing.commit_created !== "boolean")
    || (!existing.commit_created
      && existing.execution_parent !== undefined
      && existing.git_commit !== existing.execution_parent)
    || !["pending", "synchronized", "failed"].includes(existing?.index_status)
    || !validReceiptBaseline(existing)
    || (expectedRecord?.git_commit && existing.git_commit !== expectedRecord.git_commit)
    || (expectedRecord?.execution_parent
      && existing.execution_parent !== undefined
      && existing.execution_parent !== expectedRecord.execution_parent)
    || (expectedRecord?.execution_baseline
      && JSON.stringify(existing.execution_baseline) !== JSON.stringify(expectedRecord.execution_baseline))
  ) {
    throw archiveConflict(expectedRecord);
  }
  return existing;
}

function parseAppliedArchive(serialized, expectedRecord = null) {
  let existing;
  try {
    existing = JSON.parse(serialized);
  } catch {
    throw archiveConflict(expectedRecord);
  }
  return validateAppliedArchiveRecord(existing, expectedRecord || existing, {
    allowLegacyExecutionParent: true,
    allowLegacyCommitCreated: true,
  });
}

function readAppliedArchive(appliedPath, expectedRecord = null) {
  let serialized;
  try {
    const stat = lstatSync(appliedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe archive path");
    serialized = readFileSync(appliedPath, "utf8");
  } catch {
    throw archiveConflict(expectedRecord);
  }
  return parseAppliedArchive(serialized, expectedRecord);
}

function fsyncAppliedArchive({
  appliedPath,
  expectedRecord = null,
  proposalId = null,
  afterFileFsyncFailure = null,
}) {
  const existing = fsyncValidatedExistingArchive({
    archivePath: appliedPath,
    parseAndValidate: (serialized) => parseAppliedArchive(serialized, expectedRecord),
    afterFileFsyncFailure,
  });
  if (expectedRecord && JSON.stringify(existing) !== JSON.stringify(expectedRecord)) {
    throw archiveConflict(expectedRecord);
  }
  const expectedId = proposalId || expectedRecord?.proposal?.id;
  if (expectedId && existing.proposal.id !== expectedId) throw archiveConflict(expectedRecord || existing);
  return existing;
}

export function ensureAppliedReceiptDurable({
  appliedPath,
  expectedRecord = null,
  proposalId = null,
}) {
  return fsyncAppliedArchive({
    appliedPath,
    expectedRecord,
    proposalId,
    afterFileFsyncFailure: "during_applied_receipt_durable_barrier",
  });
}

export function readAppliedCommitReceipt({ appliedPath, expectedRecord = null, proposalId = null }) {
  if (!existsSync(appliedPath)) return null;
  const existing = readAppliedArchive(appliedPath, expectedRecord);
  const expectedId = proposalId || expectedRecord?.proposal?.id;
  if (expectedId && existing.proposal.id !== expectedId) throw archiveConflict(expectedRecord || existing);
  return existing;
}

function readCompatibleArchive(appliedPath, appliedRecord) {
  const existing = readAppliedArchive(appliedPath, appliedRecord);
  if (!sameArchiveIdentity(existing, appliedRecord)) throw archiveConflict(appliedRecord);
  return existing;
}

/** A durable approval intent or applied receipt makes unqualified rejection unsafe. */
export function assertProposalCanBeRejected({
  appliedPath,
  inflightPath = null,
  proposalId,
  committedEvidence = null,
  root = null,
  changes = null,
  preconditions = null,
  baseCommit = null,
}) {
  const existingState = [
    [appliedPath, "an applied commit receipt"],
    [inflightPath, "a durable in-flight approval"],
  ].filter(([statePath]) => statePath).find(([statePath]) => {
    try {
      lstatSync(statePath);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return false;
    }
  });
  if (existingState) {
    throw new Error(
      `Proposal already has ${existingState[1]} and cannot be rejected: ${proposalId}. `
      + "Run knowledge_apply_proposal to finish recovery.",
    );
  }
  if (
    committedEvidence?.matched
    || committedEvidence?.proposal_commit_found
    || committedEvidence?.possible_proposal_commit
  ) {
    throw new Error(
      `Proposal already has committed or potentially committed Git evidence and cannot be rejected: ${proposalId}. `
      + "Run knowledge_apply_proposal to finish recovery.",
    );
  }
  if (root && Array.isArray(changes) && changes.length > 0) {
    const targets = uniqueTargets(changes);
    const worktreeStatus = git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ...targets,
    ], { buffer: true });
    const baselineContainedUncommittedState = proposalBaselineDiffersFromCommit({
      root,
      commit: baseCommit,
      targets,
      preconditions,
    });
    const stagedTargetState = hasStagedTargetState(root, targets);
    if (
      stagedTargetState
      || (
        (worktreeStatus.length > 0 || baselineContainedUncommittedState)
        && !worktreeMatchesProposalPreconditions({ root, targets, preconditions })
      )
    ) {
      throw new Error(
        `Proposal targets have uncommitted state and cannot be safely rejected: ${proposalId}. `
        + "Their current contents do not exactly match the proposal baseline. "
        + "Run knowledge_apply_proposal to validate or recover the proposal first.",
      );
    }
  }
}

function hasStagedTargetState(root, targets) {
  // Proposal preconditions bind worktree existence and bytes, not the Git
  // index. A matching worktree therefore cannot prove that staged proposal
  // output predates this rejection attempt, so staged targets stay closed.
  try {
    git(root, ["diff", "--cached", "--quiet", "--no-ext-diff", "--", ...targets]);
    return false;
  } catch (error) {
    if (error?.status === 1) return true;
    throw error;
  }
}

function proposalBaselineDiffersFromCommit({ root, commit, targets, preconditions }) {
  if (
    typeof commit !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)
    || !preconditions
    || Array.isArray(preconditions)
    || typeof preconditions !== "object"
    || !sameSet(new Set(Object.keys(preconditions)), new Set(targets))
  ) {
    return true;
  }

  for (const target of targets) {
    const expected = preconditions[target];
    if (!expected || typeof expected.exists !== "boolean") return true;
    let committed;
    try {
      committed = readTreeEntry(root, commit, target);
    } catch {
      return true;
    }
    if (Boolean(committed) !== expected.exists) return true;
    if (!expected.exists) continue;
    if (
      !isRegularBlob(committed)
      || typeof expected.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(expected.sha256)
      || sha256(committed.content) !== expected.sha256
    ) {
      return true;
    }
  }
  return false;
}

function worktreeMatchesProposalPreconditions({ root, targets, preconditions }) {
  if (
    !preconditions
    || Array.isArray(preconditions)
    || typeof preconditions !== "object"
    || !sameSet(new Set(Object.keys(preconditions)), new Set(targets))
  ) {
    return false;
  }

  for (const target of targets) {
    const expected = preconditions[target];
    if (!expected || typeof expected.exists !== "boolean") return false;

    let absolute;
    let stat = null;
    try {
      absolute = safeAbsolutePath(root, target);
      try {
        stat = lstatSync(absolute);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    } catch {
      return false;
    }

    if (!expected.exists) {
      if (stat) return false;
      continue;
    }
    if (
      !stat?.isFile()
      || stat.isSymbolicLink()
      || typeof expected.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(expected.sha256)
    ) {
      return false;
    }
    try {
      if (sha256(readFileSync(absolute)) !== expected.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    // File fsync plus atomic rename is the portability floor. Some platforms
    // reject fsync on directory descriptors.
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncDirectoryStrict(directory, testFailureName = null) {
  let descriptor;
  try {
    descriptor = openSync(directory, "r");
    throwArchiveTestFailure(testFailureName);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureDurableDirectory(directory) {
  const missing = [];
  let cursor = path.resolve(directory);
  while (!existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const created of missing.reverse()) {
    fsyncDirectory(created);
    fsyncDirectory(path.dirname(created));
  }
}

function throwArchiveTestFailure(name) {
  const selected = process.env.AGENT_KNOWLEDGE_TEST_FAILPOINT;
  const compatibilityCodes = ["EINVAL", "ENOTSUP", "EISDIR", "EBADF"];
  const injectedCode = compatibilityCodes.find((code) => selected === `${name}_${code}`)
    || "TEST_ARCHIVE_DIRECTORY_FSYNC_FAILURE";
  if (
    name
    && process.env.NODE_ENV === "test"
    && process.env.AGENT_KNOWLEDGE_TEST_HOOKS === "1"
    && [name, ...compatibilityCodes.map((code) => `${name}_${code}`)].includes(selected)
  ) {
    const error = new Error(`Injected test-only archive publication failure: ${selected}`);
    error.code = injectedCode;
    throw error;
  }
}

function writeArchiveAtomically(archivePath, archiveRecord, { afterRenameFailure = null } = {}) {
  mkdirSync(path.dirname(archivePath), { recursive: true });
  const temporary = `${archivePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(archiveRecord, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, archivePath);
    throwArchiveTestFailure(afterRenameFailure);
    fsyncDirectory(path.dirname(archivePath));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function fsyncValidatedExistingArchive({
  archivePath,
  parseAndValidate,
  afterFileFsyncFailure = null,
}) {
  let descriptor;
  try {
    const pathStat = lstatSync(archivePath);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
      throw new Error(`Unsafe terminal archive path: '${archivePath}'.`);
    }
    descriptor = openSync(archivePath, "r");
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile()
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
    ) {
      throw new Error(`Terminal archive changed while opening durability barrier: '${archivePath}'.`);
    }
    const record = parseAndValidate(readFileSync(descriptor, "utf8"));
    fsyncSync(descriptor);
    const currentStat = lstatSync(archivePath);
    if (
      !currentStat.isFile()
      || currentStat.isSymbolicLink()
      || currentStat.dev !== openedStat.dev
      || currentStat.ino !== openedStat.ino
    ) {
      throw new Error(`Terminal archive changed during durability barrier: '${archivePath}'.`);
    }
    closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectoryStrict(path.dirname(archivePath), afterFileFsyncFailure);
    const durableStat = lstatSync(archivePath);
    if (
      !durableStat.isFile()
      || durableStat.isSymbolicLink()
      || durableStat.dev !== openedStat.dev
      || durableStat.ino !== openedStat.ino
    ) {
      throw new Error(`Terminal archive changed before durability confirmation: '${archivePath}'.`);
    }
    return record;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function inflightTransactionPath(transactionDir, proposalId) {
  if (
    typeof proposalId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(proposalId)
    || proposalId === "."
    || proposalId === ".."
  ) {
    throw new Error("Invalid proposal id for durable apply transaction.");
  }
  return path.join(transactionDir, `${proposalId}.json`);
}

function readApplyTransaction(transactionPath) {
  let envelope;
  try {
    const stat = lstatSync(transactionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe transaction path");
    envelope = JSON.parse(readFileSync(transactionPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read durable apply transaction '${transactionPath}'.`, { cause: error });
  }
  const serialized = JSON.stringify(envelope?.transaction);
  if (
    typeof serialized !== "string"
    || envelope.sha256 !== sha256(serialized)
  ) {
    throw new Error(`Durable apply transaction integrity check failed: '${transactionPath}'.`);
  }
  const record = validateTransactionRecord(envelope.transaction);
  if (path.basename(transactionPath) !== `${record.proposal_id}.json`) {
    throw new Error(`Durable apply transaction filename does not match its proposal: '${transactionPath}'.`);
  }
  return record;
}

function listApplyTransactions(transactionDir) {
  if (!existsSync(transactionDir)) return [];
  const stat = lstatSync(transactionDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Durable apply transaction directory is unsafe: '${transactionDir}'.`);
  }
  return readdirSync(transactionDir, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(`Durable apply transaction entry is unsafe: '${entry.name}'.`);
      }
      return path.join(transactionDir, entry.name);
    });
}

export function beginApplyTransaction({
  root,
  transactionDir,
  proposal,
  approval,
  approvedAt,
  executionParent,
  changes,
  snapshots,
}) {
  const proposalSha256 = proposalHash(proposal);
  if (
    !proposalSha256
    || proposal?.id === undefined
    || typeof root !== "string"
    || !Array.isArray(changes)
    || !(snapshots instanceof Map)
  ) {
    throw new Error("Cannot create durable apply transaction from invalid proposal state.");
  }
  const writeTargets = changes.flatMap((change) => (
    change.action === "move"
      ? [change.new_target]
      : ["create", "update", "schema"].includes(change.action)
        ? [change.target]
        : []
  ));
  if (writeTargets.some((target) => !safeRelativePath(target))) {
    throw new Error("Cannot record durable approval for an unsafe target path.");
  }
  assertNoGitContentTransforms(root, writeTargets);
  ensureDurableDirectory(transactionDir);
  const existingTransactions = listApplyTransactions(transactionDir);
  const transactionPath = inflightTransactionPath(transactionDir, proposal.id);
  if (
    existingTransactions.length > 1
    || (existingTransactions.length === 1 && existingTransactions[0] !== transactionPath)
  ) {
    throw new Error("Another durable apply transaction must be recovered before starting a new approval.");
  }

  const serializedSnapshots = [...snapshots].map(([target, snapshot]) => {
    if (!safeRelativePath(target) || typeof snapshot?.exists !== "boolean") {
      throw new Error("Cannot persist an invalid apply transaction preimage.");
    }
    const indexBefore = readIndexEntry(root, target);
    const committedIndex = readCommitIndexEntry(root, executionParent, target);
    if (!sameIndexEntry(indexBefore, committedIndex)) {
      throw new Error(
        `Git index changed before durable apply transaction for '${target}'; approval stopped without mutation.`,
      );
    }
    if (!snapshot.exists) {
      return {
        target,
        exists: false,
        index_before: indexBefore,
        index_after: indexBefore,
      };
    }
    const content = Buffer.from(snapshot.content);
    return {
      target,
      exists: true,
      mode: snapshot.mode & 0o777,
      sha256: sha256(content),
      content_base64: content.toString("base64"),
      index_before: indexBefore,
      index_after: indexBefore,
    };
  });
  const serializedByTarget = new Map(serializedSnapshots.map((snapshot) => [snapshot.target, snapshot]));
  for (const change of changes) {
    const target = serializedByTarget.get(change.target);
    if (!target) throw new Error(`Missing durable preimage for '${change.target}'.`);
    if (["create", "update", "schema"].includes(change.action)) {
      target.index_after = {
        mode: "100644",
        oid: gitBlobOid(root, Buffer.from(change.content, "utf8")),
      };
    } else if (change.action === "delete") {
      target.index_after = null;
    } else if (change.action === "move") {
      const destination = serializedByTarget.get(change.new_target);
      if (!target.exists || !destination) {
        throw new Error(`Cannot persist invalid move boundaries for '${change.target}'.`);
      }
      const sourceContent = Buffer.from(target.content_base64, "base64");
      destination.index_after = {
        mode: (target.mode & 0o111) === 0 ? "100644" : "100755",
        oid: gitBlobOid(root, sourceContent),
      };
      target.index_after = null;
    }
  }
  const transaction = validateTransactionRecord({
    protocol: APPLY_TRANSACTION_PROTOCOL,
    proposal_id: proposal.id,
    proposal_sha256: proposalSha256,
    approval,
    approved_at: approvedAt,
    execution_parent: executionParent,
    changes,
    changes_sha256: sha256(JSON.stringify(changes)),
    snapshots: serializedSnapshots,
    token: randomBytes(16).toString("hex"),
    created_at: new Date().toISOString(),
  });

  if (existsSync(transactionPath)) {
    const existing = readApplyTransaction(transactionPath);
    const sameIdentity = existing.proposal_id === transaction.proposal_id
      && existing.proposal_sha256 === transaction.proposal_sha256
      && existing.execution_parent === transaction.execution_parent
      && existing.changes_sha256 === transaction.changes_sha256
      && existing.approval.channel === transaction.approval.channel
      && existing.approval.message === transaction.approval.message
      && existing.approved_at === transaction.approved_at
      && JSON.stringify(existing.snapshots) === JSON.stringify(transaction.snapshots);
    if (!sameIdentity) {
      throw new Error(`Durable apply transaction conflicts with proposal '${proposal.id}'.`);
    }
    return { created: false, path: transactionPath, record: existing };
  }

  writeArchiveAtomically(transactionPath, {
    transaction,
    sha256: sha256(JSON.stringify(transaction)),
  });
  return { created: true, path: transactionPath, record: transaction };
}

function expectedFinalTransactionSnapshots(record) {
  const final = new Map(record.snapshots.map((snapshot) => [
    snapshot.target,
    deserializeSnapshot(snapshot),
  ]));
  for (const change of record.changes) {
    if (["create", "update", "schema"].includes(change.action)) {
      final.set(change.target, {
        target: change.target,
        exists: true,
        content: Buffer.from(change.content, "utf8"),
        mode: 0o644,
      });
    } else if (change.action === "delete") {
      final.set(change.target, { target: change.target, exists: false });
    } else if (change.action === "move") {
      const source = final.get(change.target);
      if (!source?.exists) {
        throw new Error(`Durable apply transaction has no move source '${change.target}'.`);
      }
      final.set(change.new_target, {
        target: change.new_target,
        exists: true,
        content: Buffer.from(source.content),
        mode: source.mode,
      });
      final.set(change.target, { target: change.target, exists: false });
    }
  }
  return final;
}

function assertApplyTransactionFinalWorktree({ root, record }) {
  const expected = expectedFinalTransactionSnapshots(record);
  for (const snapshot of record.snapshots) {
    const target = snapshot.target;
    const current = transactionEntry(root, { target });
    if (snapshotIdentity(current) !== snapshotIdentity(expected.get(target))) {
      throw new Error(
        `Apply target '${target}' no longer matches the approved final worktree state; commit stopped.`,
      );
    }
  }
}

export function assertApplyTransactionReadyToCommit({ root, transactionRecord }) {
  const record = validateTransactionRecord(transactionRecord);
  const currentHead = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (currentHead !== record.execution_parent) {
    throw new Error(`Git HEAD changed before commit for proposal '${record.proposal_id}'.`);
  }
  const expectedStaged = new Set(record.snapshots
    .filter((snapshot) => !sameIndexEntry(snapshot.index_before, snapshot.index_after))
    .map((snapshot) => snapshot.target));
  const actualStaged = new Set(git(root, [
    "diff",
    "--cached",
    "--no-renames",
    "--name-only",
    "-z",
  ], { buffer: true }).toString("utf8").split("\0").filter(Boolean));
  if (!sameSet(actualStaged, expectedStaged)) {
    throw new Error(
      `Staged path set no longer matches durable approval for proposal '${record.proposal_id}' `
        + `(expected=${JSON.stringify([...expectedStaged].sort())}, actual=${JSON.stringify([...actualStaged].sort())}).`,
    );
  }
  for (const snapshot of record.snapshots) {
    if (!sameIndexEntry(readIndexEntry(root, snapshot.target), snapshot.index_after)) {
      throw new Error(
        `Git index no longer matches durable approval for '${snapshot.target}'; commit stopped.`,
      );
    }
  }
  assertApplyTransactionFinalWorktree({ root, record });
  return true;
}

function expectedTransactionStates(record) {
  const current = new Map(record.snapshots.map((snapshot) => [
    snapshot.target,
    deserializeSnapshot(snapshot),
  ]));
  const allowed = new Map([...current].map(([target, snapshot]) => [
    target,
    new Set([snapshotIdentity(snapshot)]),
  ]));
  const remember = () => {
    for (const [target, snapshot] of current) {
      allowed.get(target).add(snapshotIdentity(snapshot));
    }
  };
  for (const change of record.changes) {
    if (["create", "update", "schema"].includes(change.action)) {
      current.set(change.target, {
        target: change.target,
        exists: true,
        content: Buffer.from(change.content, "utf8"),
        mode: 0o644,
      });
    } else if (change.action === "delete") {
      current.set(change.target, { target: change.target, exists: false });
    } else if (change.action === "move") {
      const source = current.get(change.target);
      current.set(change.new_target, {
        ...source,
        target: change.new_target,
        content: source?.content ? Buffer.from(source.content) : undefined,
      });
      current.set(change.target, { target: change.target, exists: false });
    }
    remember();
  }
  return allowed;
}

function assertTransactionOwnedState(root, record) {
  const allowed = expectedTransactionStates(record);
  for (const snapshot of record.snapshots) {
    const current = transactionEntry(root, snapshot);
    if (!allowed.get(snapshot.target).has(snapshotIdentity(current))) {
      throw new Error(
        `Apply transaction target '${snapshot.target}' changed outside the recorded transaction; recovery stopped without overwriting it.`,
      );
    }
  }
}

function assertTransactionOwnedIndex(root, record) {
  for (const snapshot of record.snapshots) {
    const current = readIndexEntry(root, snapshot.target);
    if (
      !sameIndexEntry(current, snapshot.index_before)
      && !sameIndexEntry(current, snapshot.index_after)
    ) {
      throw new Error(
        `Git index entry '${snapshot.target}' changed outside the recorded transaction; recovery stopped without unstaging it.`,
      );
    }
  }
}

function durableRestoreFile(absolute, content, mode, token) {
  mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporary = `${absolute}.gateway-recovery-${token}.tmp`;
  if (existsSync(temporary)) {
    const stat = lstatSync(temporary);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe interrupted recovery temporary: '${temporary}'.`);
    }
    rmSync(temporary, { force: true });
  }
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", mode);
    writeFileSync(descriptor, content);
    chmodSync(temporary, mode);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, absolute);
    fsyncDirectory(path.dirname(absolute));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function restoreTransactionPreimages(root, record) {
  assertTransactionOwnedState(root, record);
  assertTransactionOwnedIndex(root, record);
  for (const serialized of record.snapshots) {
    const snapshot = deserializeSnapshot(serialized);
    const absolute = safeAbsolutePath(root, snapshot.target);
    if (snapshot.exists) {
      durableRestoreFile(absolute, snapshot.content, snapshot.mode, record.token);
    } else if (existsSync(absolute)) {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Cannot restore non-file apply target: '${snapshot.target}'.`);
      }
      rmSync(absolute);
      fsyncDirectory(path.dirname(absolute));
    }
    const applyTemporary = `${absolute}.gateway-apply-${record.token}.tmp`;
    if (existsSync(applyTemporary)) {
      const stat = lstatSync(applyTemporary);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Unsafe interrupted apply temporary: '${applyTemporary}'.`);
      }
      rmSync(applyTemporary);
      fsyncDirectory(path.dirname(applyTemporary));
    }
  }
  git(root, ["reset", "--quiet", "HEAD", "--", ...record.snapshots.map(({ target }) => target)]);
  for (const serialized of record.snapshots) {
    const expected = deserializeSnapshot(serialized);
    const current = transactionEntry(root, serialized);
    if (snapshotIdentity(current) !== snapshotIdentity(expected)) {
      throw new Error(`Apply transaction recovery did not restore '${serialized.target}'.`);
    }
    if (!sameIndexEntry(readIndexEntry(root, serialized.target), serialized.index_before)) {
      throw new Error(`Apply transaction recovery did not restore the Git index for '${serialized.target}'.`);
    }
  }
}

export function clearApplyTransaction({ transactionPath, token }) {
  if (!existsSync(transactionPath)) return false;
  const record = readApplyTransaction(transactionPath);
  if (record.token !== token) {
    throw new Error(`Durable apply transaction owner changed: '${transactionPath}'.`);
  }
  unlinkSync(transactionPath);
  fsyncDirectory(path.dirname(transactionPath));
  return true;
}

export function inspectInterruptedApply({ root, transactionDir }) {
  const transactions = listApplyTransactions(transactionDir);
  if (transactions.length === 0) return { status: "none" };
  if (transactions.length !== 1) {
    throw new Error("Multiple durable apply transactions exist; automatic recovery stopped.");
  }
  const transactionPath = transactions[0];
  const record = readApplyTransaction(transactionPath);
  const currentHead = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  return {
    status: currentHead === record.execution_parent ? "pre_commit" : "post_commit",
    proposal_id: record.proposal_id,
    transaction_path: transactionPath,
    record,
    current_head: currentHead,
    execution_parent: record.execution_parent,
  };
}

export function recoverInterruptedApply({ root, transactionDir }) {
  const interrupted = inspectInterruptedApply({ root, transactionDir });
  if (interrupted.status !== "pre_commit") return interrupted;
  restoreTransactionPreimages(root, interrupted.record);
  return {
    status: "restored_precommit",
    proposal_id: interrupted.proposal_id,
    execution_parent: interrupted.execution_parent,
    approval: interrupted.record.approval,
    approved_at: interrupted.record.approved_at,
    transaction_path: interrupted.transaction_path,
    record: interrupted.record,
  };
}

/** Persist approval and the durable Git commit before slow derived-index work. */
export function writeAppliedCommitReceipt({ appliedPath, appliedRecord }) {
  if (appliedRecord.index_status !== "pending") {
    throw new Error("Applied commit receipt must have index_status 'pending'.");
  }
  validateAppliedArchiveRecord(appliedRecord, appliedRecord);
  if (existsSync(appliedPath)) {
    return { created: false, record: readAppliedArchive(appliedPath, appliedRecord) };
  }
  writeArchiveAtomically(appliedPath, appliedRecord, {
    afterRenameFailure: "after_applied_receipt_rename_before_directory_fsync_error",
  });
  return { created: true, record: appliedRecord };
}

function rejectedArchiveConflict(expectedRecord) {
  return new Error(
    `Rejected proposal archive conflicts with proposal '${expectedRecord?.proposal?.id || "unknown"}'.`,
  );
}

function validateRejectedArchiveRecord(existing, expectedRecord = existing) {
  if (
    existing?.sha256 !== proposalHash(existing?.proposal)
    || existing?.proposal?.id !== expectedRecord?.proposal?.id
    || existing?.sha256 !== expectedRecord?.sha256
    || typeof existing?.rejected_at !== "string"
    || !existing.rejected_at
    || existing?.rejection?.channel !== "conversation"
    || typeof existing?.rejection?.message !== "string"
    || !existing.rejection.message.trim()
    || (expectedRecord?.rejected_at && existing.rejected_at !== expectedRecord.rejected_at)
    || (expectedRecord?.rejection?.channel
      && existing.rejection.channel !== expectedRecord.rejection.channel)
    || (expectedRecord?.rejection?.message
      && existing.rejection.message !== expectedRecord.rejection.message)
  ) {
    throw rejectedArchiveConflict(expectedRecord);
  }
  return existing;
}

export function readRejectedProposalArchive({
  rejectedPath,
  expectedRecord = null,
  proposalId = null,
}) {
  if (!existsSync(rejectedPath)) return null;
  let serialized;
  try {
    const stat = lstatSync(rejectedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe archive path");
    serialized = readFileSync(rejectedPath, "utf8");
  } catch {
    throw rejectedArchiveConflict(expectedRecord);
  }
  let existing;
  try {
    existing = JSON.parse(serialized);
  } catch {
    throw rejectedArchiveConflict(expectedRecord);
  }
  validateRejectedArchiveRecord(existing, expectedRecord || existing);
  const expectedId = proposalId || expectedRecord?.proposal?.id;
  if (expectedId && existing.proposal.id !== expectedId) {
    throw rejectedArchiveConflict(expectedRecord || existing);
  }
  return existing;
}

function ensureRejectedArchiveDurable({ rejectedPath, expectedRecord, proposalId = null }) {
  const existing = fsyncValidatedExistingArchive({
    archivePath: rejectedPath,
    parseAndValidate: (serialized) => {
      let parsed;
      try {
        parsed = JSON.parse(serialized);
      } catch {
        throw rejectedArchiveConflict(expectedRecord);
      }
      return validateRejectedArchiveRecord(parsed, expectedRecord || parsed);
    },
    afterFileFsyncFailure: "during_rejected_archive_durable_barrier",
  });
  if (expectedRecord && JSON.stringify(existing) !== JSON.stringify(expectedRecord)) {
    throw rejectedArchiveConflict(expectedRecord);
  }
  const expectedId = proposalId || expectedRecord?.proposal?.id;
  if (expectedId && existing.proposal.id !== expectedId) {
    throw rejectedArchiveConflict(expectedRecord || existing);
  }
  return existing;
}

export function writeRejectedProposalReceipt({ rejectedPath, rejectedRecord }) {
  validateRejectedArchiveRecord(rejectedRecord, rejectedRecord);
  if (existsSync(rejectedPath)) {
    return {
      created: false,
      record: readRejectedProposalArchive({ rejectedPath, expectedRecord: rejectedRecord }),
    };
  }
  writeArchiveAtomically(rejectedPath, rejectedRecord, {
    afterRenameFailure: "after_rejected_receipt_rename_before_directory_fsync_error",
  });
  return { created: true, record: rejectedRecord };
}

export function finalizeRejectedProposalArchive({ pendingPath, rejectedPath, rejectedRecord }) {
  const receipt = writeRejectedProposalReceipt({ rejectedPath, rejectedRecord });
  if (existsSync(pendingPath)) {
    receipt.record = ensureRejectedArchiveDurable({
      rejectedPath,
      expectedRecord: receipt.record,
      proposalId: receipt.record.proposal.id,
    });
    unlinkSync(pendingPath);
    fsyncDirectory(path.dirname(pendingPath));
  }
  return receipt;
}

/**
 * Atomically publish the applied record before removing pending state. If a
 * crash already left both files behind, only an archive with the same proposal
 * hash, commit, and verbatim approval is accepted.
 */
export function finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord }) {
  if (appliedRecord.index_status === "pending") {
    throw new Error("Cannot finalize an applied proposal while index synchronization is pending.");
  }
  let created = false;
  let updated = false;
  let record = appliedRecord;
  if (existsSync(appliedPath)) {
    const existing = readCompatibleArchive(appliedPath, appliedRecord);
    if (JSON.stringify(existing) !== JSON.stringify(appliedRecord)) {
      validateAppliedArchiveRecord(appliedRecord, appliedRecord);
      writeArchiveAtomically(appliedPath, appliedRecord, {
        afterRenameFailure: "after_applied_archive_rename_before_directory_fsync_error",
      });
      updated = true;
    } else {
      record = existing;
    }
  } else {
    validateAppliedArchiveRecord(appliedRecord, appliedRecord);
    writeArchiveAtomically(appliedPath, appliedRecord);
    created = true;
  }

  if (existsSync(pendingPath)) {
    record = fsyncAppliedArchive({
      appliedPath,
      expectedRecord: record,
      proposalId: record.proposal.id,
      afterFileFsyncFailure: "during_applied_archive_durable_barrier",
    });
    unlinkSync(pendingPath);
    fsyncDirectory(path.dirname(pendingPath));
  }
  return { created, updated, record };
}
