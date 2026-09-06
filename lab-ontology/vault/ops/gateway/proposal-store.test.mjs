import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertApplyTransactionReadyToCommit,
  assertNoActiveCommitHooks,
  assertProposalChangeIsolation,
  assertProposalCanBeRejected,
  beginApplyTransaction,
  clearApplyTransaction,
  compactApplyBaseline,
  detectExactCommittedProposal,
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

const HERE = path.dirname(fileURLToPath(import.meta.url));

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function proposalHash(proposal) {
  return sha256(JSON.stringify(proposal));
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function withArchiveFailure(name, operation) {
  const overrides = {
    NODE_ENV: "test",
    AGENT_KNOWLEDGE_TEST_HOOKS: "1",
    AGENT_KNOWLEDGE_TEST_FAILPOINT: name,
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function createMinimalRepo(t, prefix, tracked = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Proposal Recovery Test"]);
  git(root, ["config", "user.email", "proposal-recovery@example.invalid"]);
  write(root, "README.md", "base\n");
  for (const [target, content] of Object.entries(tracked)) write(root, target, content);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", "base"]);
  return { root, baseCommit: git(root, ["rev-parse", "HEAD"]) };
}

test("schema/governance and knowledge-content changes require separate proposals", () => {
  const governanceDeleteTargets = new Set([
    "ops/retired-index-helper.mjs",
    "ops/retired-schema-helper.mjs",
  ]);
  const options = { governanceDeleteTargets };
  assert.doesNotThrow(() => assertProposalChangeIsolation([
    { action: "schema", target: "ops/gateway/server.mjs", content: "code" },
    { action: "delete", target: "ops/retired-index-helper.mjs" },
  ], options));
  assert.doesNotThrow(() => assertProposalChangeIsolation([
    { action: "update", target: "methods/one.md", content: "one" },
    { action: "delete", target: "unused.canvas" },
  ], options));
  assert.throws(
    () => assertProposalChangeIsolation([
      { action: "delete", target: "ops/retired-index-helper.mjs" },
      { action: "update", target: "methods/one.md", content: "one" },
    ], options),
    /separate proposals and separate approval/,
  );
});

function targetSnapshots(root, targets) {
  return new Map(targets.map((target) => {
    const absolute = path.join(root, target);
    try {
      const stat = statSync(absolute);
      return [target, { exists: true, content: readFileSync(absolute), mode: stat.mode }];
    } catch (error) {
      if (error?.code === "ENOENT") return [target, { exists: false }];
      throw error;
    }
  }));
}

function createFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "proposal-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Proposal Recovery Test"]);
  git(root, ["config", "user.email", "proposal-recovery@example.invalid"]);
  write(root, "methods/update.md", "before\n");
  write(root, "methods/move.md", "move me\n");
  write(root, "methods/noop.md", "same\n");
  write(root, "sources/delete.md", "delete me\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", "base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  const changes = [
    { action: "update", target: "methods/update.md", content: "after\n" },
    { action: "create", target: "concepts/new.md", content: "new\n" },
    { action: "delete", target: "sources/delete.md" },
    { action: "move", target: "methods/move.md", new_target: "methods/moved.md" },
    { action: "update", target: "methods/noop.md", content: "same\n" },
  ];
  const proposal = {
    schema_version: 2,
    id: "KB-20300101-120000-1234abcd",
    base_commit: baseCommit,
    summary: "Recover a committed proposal after synchronization timeout",
    changes,
    preconditions: {
      "methods/update.md": { exists: true, sha256: sha256("before\n") },
      "concepts/new.md": { exists: false },
      "sources/delete.md": { exists: true, sha256: sha256("delete me\n") },
      "methods/move.md": { exists: true, sha256: sha256("move me\n") },
      "methods/moved.md": { exists: false },
      "methods/noop.md": { exists: true, sha256: sha256("same\n") },
    },
  };
  return { root, baseCommit, changes, proposal };
}

function commitProposal(fixture, mutate = () => {}) {
  const { root, proposal } = fixture;
  write(root, "methods/update.md", "after\n");
  write(root, "concepts/new.md", "new\n");
  unlinkSync(path.join(root, "sources/delete.md"));
  mkdirSync(path.join(root, "methods"), { recursive: true });
  writeFileSync(path.join(root, "methods/moved.md"), readFileSync(path.join(root, "methods/move.md")));
  unlinkSync(path.join(root, "methods/move.md"));
  mutate(root);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", proposalCommitSubject(proposal)]);
  return git(root, ["rev-parse", "HEAD"]);
}

test("detects only the exact direct proposal commit, including create/update/delete/move/no-op", (t) => {
  const fixture = createFixture(t);
  const head = commitProposal(fixture);
  const recovery = detectExactCommittedProposal({
    root: fixture.root,
    proposal: fixture.proposal,
    changes: fixture.changes,
  });

  assert.deepEqual(recovery, {
    matched: true,
    commit: head,
    current_head: head,
    base_commit: fixture.baseCommit,
    execution_parent: fixture.baseCommit,
    reason: "EXACT_PROPOSAL_COMMIT",
  });
});

test("rejects a commit that includes any path outside the proposal", (t) => {
  const fixture = createFixture(t);
  commitProposal(fixture, (root) => write(root, "concepts/unapproved.md", "extra\n"));

  const recovery = detectExactCommittedProposal({
    root: fixture.root,
    proposal: fixture.proposal,
    changes: fixture.changes,
  });
  assert.equal(recovery.matched, false);
  assert.equal(recovery.reason, "CHANGED_PATH_SET_MISMATCH");
});

test("rejects wrong final bytes and wrong subject, but accepts a later linear descendant", async (t) => {
  await t.test("wrong final bytes", (t2) => {
    const fixture = createFixture(t2);
    commitProposal(fixture, (root) => write(root, "methods/update.md", "not approved\n"));
    assert.equal(
      detectExactCommittedProposal({ root: fixture.root, proposal: fixture.proposal, changes: fixture.changes }).reason,
      "FINAL_CONTENT_MISMATCH",
    );
  });

  await t.test("wrong subject", (t2) => {
    const fixture = createFixture(t2);
    commitProposal(fixture);
    git(fixture.root, ["commit", "--amend", "-m", "not the gateway subject"]);
    assert.equal(
      detectExactCommittedProposal({ root: fixture.root, proposal: fixture.proposal, changes: fixture.changes }).reason,
      "COMMIT_SUBJECT_MISMATCH",
    );
  });

  await t.test("later descendant", (t2) => {
    const fixture = createFixture(t2);
    const proposalCommit = commitProposal(fixture);
    const laterProposal = {
      schema_version: 2,
      id: "KB-20300101-120001-5678abcd",
      base_commit: proposalCommit,
      summary: "Install exact proposal recovery",
      changes: [
        { action: "create", target: "concepts/later.md", content: "later\n" },
      ],
      preconditions: {
        "concepts/later.md": { exists: false },
      },
    };
    write(fixture.root, "concepts/later.md", "later\n");
    git(fixture.root, ["add", "concepts/later.md"]);
    git(fixture.root, ["commit", "-m", proposalCommitSubject(laterProposal)]);
    const currentHead = git(fixture.root, ["rev-parse", "HEAD"]);
    const appliedDir = path.join(fixture.root, ".proposal-state", "applied");
    mkdirSync(appliedDir, { recursive: true });
    const laterRecord = {
      proposal: laterProposal,
      sha256: proposalHash(laterProposal),
      approval: {
        channel: "conversation",
        message: "批准 KB-20300101-120001-5678abcd",
      },
      approved_at: "2030-01-01T12:00:01.000Z",
      git_commit: currentHead,
      execution_parent: proposalCommit,
      commit_created: true,
      index_status: "synchronized",
    };
    writeFileSync(
      path.join(appliedDir, `${laterProposal.id}.json`),
      `${JSON.stringify(laterRecord, null, 2)}\n`,
    );
    const recovery = detectExactCommittedProposal({
      root: fixture.root,
      proposal: fixture.proposal,
      changes: fixture.changes,
      appliedDir,
    });
    assert.equal(recovery.matched, true);
    assert.equal(recovery.commit, proposalCommit);
    assert.equal(recovery.current_head, currentHead);
  });

  await t.test("unarchived later descendant", (t2) => {
    const fixture = createFixture(t2);
    commitProposal(fixture);
    write(fixture.root, "concepts/later.md", "later\n");
    git(fixture.root, ["add", "concepts/later.md"]);
    git(fixture.root, ["commit", "-m", "Knowledge: unarchived later change"]);
    assert.equal(
      detectExactCommittedProposal({
        root: fixture.root,
        proposal: fixture.proposal,
        changes: fixture.changes,
        appliedDir: path.join(fixture.root, ".proposal-state", "applied"),
      }).reason,
      "UNVERIFIED_DESCENDANT_COMMIT",
    );
  });

  await t.test("descendant archive cannot bless unrelated commit bytes", (t2) => {
    const fixture = createFixture(t2);
    const proposalCommit = commitProposal(fixture);
    const claimedProposal = {
      schema_version: 2,
      id: "KB-20300101-120002-90abcdef",
      base_commit: proposalCommit,
      summary: "Archived but byte-mismatched descendant",
      changes: [
        { action: "create", target: "concepts/later.md", content: "claimed bytes\n" },
      ],
      preconditions: {
        "concepts/later.md": { exists: false },
      },
    };
    write(fixture.root, "concepts/later.md", "actual bytes\n");
    git(fixture.root, ["add", "concepts/later.md"]);
    git(fixture.root, ["commit", "-m", proposalCommitSubject(claimedProposal)]);
    const currentHead = git(fixture.root, ["rev-parse", "HEAD"]);
    const appliedDir = path.join(fixture.root, ".proposal-state", "applied");
    mkdirSync(appliedDir, { recursive: true });
    const claimedRecord = {
      proposal: claimedProposal,
      sha256: proposalHash(claimedProposal),
      approval: {
        channel: "conversation",
        message: "批准 KB-20300101-120002-90abcdef",
      },
      approved_at: "2030-01-01T12:00:02.000Z",
      git_commit: currentHead,
      execution_parent: proposalCommit,
      commit_created: true,
      index_status: "synchronized",
    };
    writeFileSync(
      path.join(appliedDir, `${claimedProposal.id}.json`),
      `${JSON.stringify(claimedRecord, null, 2)}\n`,
    );
    assert.equal(
      detectExactCommittedProposal({
        root: fixture.root,
        proposal: fixture.proposal,
        changes: fixture.changes,
        appliedDir,
      }).reason,
      "UNVERIFIED_DESCENDANT_COMMIT",
    );
  });
});

test("rejects a dirty approved target but ignores unrelated working-tree files", (t) => {
  const fixture = createFixture(t);
  commitProposal(fixture);
  write(fixture.root, "notes/unrelated.txt", "untracked but unrelated\n");
  assert.equal(
    detectExactCommittedProposal({ root: fixture.root, proposal: fixture.proposal, changes: fixture.changes }).matched,
    true,
  );

  write(fixture.root, "methods/update.md", "dirty\n");
  assert.equal(
    detectExactCommittedProposal({ root: fixture.root, proposal: fixture.proposal, changes: fixture.changes }).reason,
    "TOUCHED_PATHS_DIRTY",
  );
});

test("a same-base sibling receipt records its actual execution parent", (t) => {
  const fixture = createFixture(t);
  const firstCommit = commitProposal(fixture);
  const sibling = {
    schema_version: 2,
    id: "KB-20300101-120004-aabbccdd",
    base_commit: fixture.baseCommit,
    summary: "Apply an independently approved sibling",
    changes: [{ action: "create", target: "concepts/sibling.md", content: "sibling\n" }],
    preconditions: { "concepts/sibling.md": { exists: false } },
  };
  write(fixture.root, "concepts/sibling.md", "sibling\n");
  git(fixture.root, ["add", "--", "concepts/sibling.md"]);
  git(fixture.root, ["commit", "-m", proposalCommitSubject(sibling)]);
  const siblingCommit = git(fixture.root, ["rev-parse", "HEAD"]);
  const appliedDir = path.join(fixture.root, ".proposal-state", "applied");
  mkdirSync(appliedDir, { recursive: true });
  const siblingRecord = {
    proposal: sibling,
    sha256: proposalHash(sibling),
    approved_at: "2030-01-01T12:00:04.000Z",
    approval: { channel: "conversation", message: `批准 ${sibling.id}` },
    git_commit: siblingCommit,
    execution_parent: firstCommit,
    commit_created: true,
    index_status: "synchronized",
  };
  writeFileSync(
    path.join(appliedDir, `${sibling.id}.json`),
    `${JSON.stringify(siblingRecord, null, 2)}\n`,
  );

  const recovery = detectExactCommittedProposal({
    root: fixture.root,
    proposal: fixture.proposal,
    changes: fixture.changes,
    appliedDir,
  });
  assert.equal(recovery.matched, true, recovery.reason);
  assert.equal(recovery.commit, firstCommit);
  assert.equal(recovery.current_head, siblingCommit);
});

test("an old mixed proposal can recover an exact commit before new isolation policy", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-mixed-exact-", {
    "methods/existing.md": "before\n",
  });
  const changes = [
    { action: "schema", target: "ops/gateway/new-rule.mjs", content: "export const rule = true;\n" },
    { action: "update", target: "methods/existing.md", content: "after\n" },
  ];
  const proposal = {
    schema_version: 2,
    id: "KB-20300101-120005-aabbccdd",
    base_commit: baseCommit,
    summary: "Historical mixed proposal",
    changes,
    preconditions: {
      "ops/gateway/new-rule.mjs": { exists: false },
      "methods/existing.md": { exists: true, sha256: sha256("before\n") },
    },
  };
  write(root, "ops/gateway/new-rule.mjs", changes[0].content);
  write(root, "methods/existing.md", changes[1].content);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", proposalCommitSubject(proposal)]);
  assert.throws(
    () => assertProposalChangeIsolation(changes),
    /separate proposals/,
  );
  const recovery = detectExactCommittedProposal({ root, proposal, changes });
  assert.equal(recovery.matched, true, recovery.reason);
});

test("rejects a proposal whose baseline does not match its declared base commit", (t) => {
  const fixture = createFixture(t);
  commitProposal(fixture);
  fixture.proposal.preconditions["methods/update.md"].sha256 = "0".repeat(64);
  assert.equal(
    detectExactCommittedProposal({ root: fixture.root, proposal: fixture.proposal, changes: fixture.changes }).reason,
    "BASELINE_CONTENT_MISMATCH",
  );
});

test("WAL recovery identifies an exact proposal after an unrelated earlier commit", (t) => {
  const fixture = createFixture(t);
  write(fixture.root, "concepts/unrelated-before.md", "unrelated\n");
  git(fixture.root, ["add", "concepts/unrelated-before.md"]);
  git(fixture.root, ["commit", "-m", "Knowledge: independent earlier proposal"]);
  const executionParent = git(fixture.root, ["rev-parse", "HEAD"]);
  const transactionDir = mkdtempSync(path.join(os.tmpdir(), "proposal-wal-state-"));
  t.after(() => rmSync(transactionDir, { recursive: true, force: true }));
  const transaction = beginApplyTransaction({
    root: fixture.root,
    transactionDir,
    proposal: fixture.proposal,
    approval: { channel: "conversation", message: `批准 ${fixture.proposal.id}` },
    approvedAt: new Date().toISOString(),
    executionParent,
    changes: fixture.changes,
    snapshots: targetSnapshots(fixture.root, Object.keys(fixture.proposal.preconditions)),
  });
  const proposalCommit = commitProposal(fixture);
  const recovery = detectExactCommittedProposal({
    root: fixture.root,
    proposal: fixture.proposal,
    changes: fixture.changes,
    recoveryRecord: transaction.record,
  });
  assert.equal(recovery.matched, true, recovery.reason);
  assert.equal(recovery.commit, proposalCommit);
  assert.equal(recovery.execution_parent, executionParent);
});

test("WAL baseline recovers dirty tracked and untracked adoption commits", async (t) => {
  async function runCase(t2, { target, baseContent = null, baselineContent, finalContent }) {
    const root = mkdtempSync(path.join(os.tmpdir(), "proposal-wal-baseline-"));
    t2.after(() => rmSync(root, { recursive: true, force: true }));
    git(root, ["init", "--initial-branch=main"]);
    git(root, ["config", "user.name", "Proposal Recovery Test"]);
    git(root, ["config", "user.email", "proposal-recovery@example.invalid"]);
    write(root, "README.md", "base\n");
    if (baseContent !== null) write(root, target, baseContent);
    git(root, ["add", "--all"]);
    git(root, ["commit", "-m", "base"]);
    const baseCommit = git(root, ["rev-parse", "HEAD"]);
    write(root, target, baselineContent);
    const changes = [{ action: "update", target, content: finalContent }];
    const proposal = {
      schema_version: 2,
      id: `KB-20300101-${baseContent === null ? "130001" : "130002"}-aabbccdd`,
      base_commit: baseCommit,
      summary: `Adopt ${target}`,
      changes,
      preconditions: { [target]: { exists: true, sha256: sha256(baselineContent) } },
    };
    const transaction = beginApplyTransaction({
      root,
      transactionDir: path.join(root, ".proposal-state", "inflight"),
      proposal,
      approval: { channel: "conversation", message: `批准 ${proposal.id}` },
      approvedAt: new Date().toISOString(),
      executionParent: baseCommit,
      changes,
      snapshots: targetSnapshots(root, [target]),
    });
    write(root, target, finalContent);
    git(root, ["add", "--", target]);
    git(root, ["commit", "-m", proposalCommitSubject(proposal)]);
    const recovery = detectExactCommittedProposal({
      root,
      proposal,
      changes,
      recoveryRecord: transaction.record,
    });
    assert.equal(recovery.matched, true);
    assert.equal(recovery.execution_parent, baseCommit);
    return { root, proposal, changes };
  }

  await t.test("dirty tracked preimage", async (t2) => {
    const context = await runCase(t2, {
      target: "methods/dirty.md",
      baseContent: "committed old\n",
      baselineContent: "dirty approved baseline\n",
      finalContent: "approved final\n",
    });
    assert.equal(
      detectExactCommittedProposal(context).reason,
      "BASELINE_CONTENT_MISMATCH",
      "without its WAL, dirty tracked baseline recovery must remain unproven",
    );
  });

  await t.test("untracked adoption", async (t2) => {
    await runCase(t2, {
      target: "methods/adopt.md",
      baselineContent: "untracked draft\n",
      finalContent: "approved final\n",
    });
  });
});

test("schema action can create an absent governance target", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proposal-schema-create-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Proposal Recovery Test"]);
  git(root, ["config", "user.email", "proposal-recovery@example.invalid"]);
  write(root, "README.md", "base\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  const target = "ops/gateway/new-governance.mjs";
  const changes = [{ action: "schema", target, content: "export const enabled = true;\n" }];
  const proposal = {
    id: "KB-20300101-130003-aabbccdd",
    base_commit: baseCommit,
    summary: "Create governance helper",
    changes,
    preconditions: { [target]: { exists: false } },
  };
  write(root, target, changes[0].content);
  git(root, ["add", "--", target]);
  git(root, ["commit", "-m", proposalCommitSubject(proposal)]);
  const schemaRecovery = detectExactCommittedProposal({ root, proposal, changes });
  assert.equal(schemaRecovery.matched, true, schemaRecovery.reason);
});

test("move recovery compares executable mode as well as content", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proposal-move-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Proposal Recovery Test"]);
  git(root, ["config", "user.email", "proposal-recovery@example.invalid"]);
  write(root, "methods/source.md", "move executable\n");
  chmodSync(path.join(root, "methods/source.md"), 0o755);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", "base"]);
  const baseCommit = git(root, ["rev-parse", "HEAD"]);
  const changes = [{ action: "move", target: "methods/source.md", new_target: "methods/dest.md" }];
  const proposal = {
    id: "KB-20300101-130004-aabbccdd",
    base_commit: baseCommit,
    summary: "Move executable page",
    changes,
    preconditions: {
      "methods/source.md": { exists: true, sha256: sha256("move executable\n") },
      "methods/dest.md": { exists: false },
    },
  };
  renameSync(path.join(root, "methods/source.md"), path.join(root, "methods/dest.md"));
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", proposalCommitSubject(proposal)]);
  const moved = detectExactCommittedProposal({ root, proposal, changes });
  assert.equal(moved.matched, true, moved.reason);
  chmodSync(path.join(root, "methods/dest.md"), 0o644);
  git(root, ["add", "--", "methods/dest.md"]);
  git(root, ["commit", "--amend", "--no-edit"]);
  assert.equal(detectExactCommittedProposal({ root, proposal, changes }).reason, "FINAL_MOVE_MISMATCH");
});

test("an untracked move requires the WAL to prove its source mode", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-untracked-move-");
  write(root, "methods/untracked-source.md", "move untracked\n");
  chmodSync(path.join(root, "methods/untracked-source.md"), 0o755);
  const changes = [{
    action: "move",
    target: "methods/untracked-source.md",
    new_target: "methods/untracked-destination.md",
  }];
  const proposal = {
    schema_version: 2,
    id: "KB-20300101-130005-aabbccdd",
    base_commit: baseCommit,
    summary: "Move an approved untracked executable",
    changes,
    preconditions: {
      "methods/untracked-source.md": { exists: true, sha256: sha256("move untracked\n") },
      "methods/untracked-destination.md": { exists: false },
    },
  };
  const transactionDir = mkdtempSync(path.join(os.tmpdir(), "proposal-untracked-move-wal-"));
  t.after(() => rmSync(transactionDir, { recursive: true, force: true }));
  const transaction = beginApplyTransaction({
    root,
    transactionDir,
    proposal,
    approval: { channel: "conversation", message: `批准 ${proposal.id}` },
    approvedAt: "2030-01-01T13:00:05.000Z",
    executionParent: baseCommit,
    changes,
    snapshots: targetSnapshots(root, Object.keys(proposal.preconditions)),
  });
  renameSync(
    path.join(root, "methods/untracked-source.md"),
    path.join(root, "methods/untracked-destination.md"),
  );
  git(root, ["add", "--", "methods/untracked-destination.md"]);
  git(root, ["commit", "-m", proposalCommitSubject(proposal)]);

  const withoutWal = detectExactCommittedProposal({ root, proposal, changes });
  assert.equal(withoutWal.matched, false);
  assert.equal(withoutWal.reason, "FINAL_MOVE_MISMATCH");
  assert.equal(withoutWal.possible_proposal_commit, true);
  const withWal = detectExactCommittedProposal({
    root,
    proposal,
    changes,
    recoveryRecord: transaction.record,
  });
  assert.equal(withWal.matched, true, withWal.reason);
});

test("exact or bounded-possible Git commit evidence blocks rejection", (t) => {
  const fixture = createFixture(t);
  const proposalCommit = commitProposal(fixture);
  const exact = detectExactCommittedProposal({
    root: fixture.root,
    proposal: fixture.proposal,
    changes: fixture.changes,
  });
  assert.equal(exact.commit, proposalCommit);
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(fixture.root, ".proposal-state", "missing.json"),
      proposalId: fixture.proposal.id,
      committedEvidence: exact,
    }),
    /committed or potentially committed Git evidence/,
  );

  const deep = createFixture(t);
  const tree = git(deep.root, ["rev-parse", "HEAD^{tree}"]);
  let parent = deep.baseCommit;
  for (let index = 0; index < 257; index += 1) {
    const subject = index === 128
      ? proposalCommitSubject(deep.proposal)
      : `Knowledge: unrelated empty ${index}`;
    parent = git(deep.root, ["commit-tree", tree, "-p", parent, "-m", subject]);
  }
  git(deep.root, ["update-ref", "refs/heads/main", parent]);
  const possible = detectExactCommittedProposal({
    root: deep.root,
    proposal: deep.proposal,
    changes: deep.changes,
  });
  assert.equal(possible.reason, "PROPOSAL_COMMIT_TOO_OLD");
  assert.equal(possible.possible_proposal_commit, true);
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(deep.root, ".proposal-state", "missing.json"),
      proposalId: deep.proposal.id,
      committedEvidence: possible,
    }),
    /committed or potentially committed Git evidence/,
  );

  const merged = createFixture(t);
  const mergedProposalCommit = commitProposal(merged);
  const baseTree = git(merged.root, ["rev-parse", `${merged.baseCommit}^{tree}`]);
  const sideCommit = git(merged.root, [
    "commit-tree",
    baseTree,
    "-p",
    merged.baseCommit,
    "-m",
    "Knowledge: unrelated side branch",
  ]);
  const proposalTree = git(merged.root, ["rev-parse", `${mergedProposalCommit}^{tree}`]);
  const mergeCommit = git(merged.root, [
    "commit-tree",
    proposalTree,
    "-p",
    mergedProposalCommit,
    "-p",
    sideCommit,
    "-m",
    "Knowledge: unrelated merge",
  ]);
  git(merged.root, ["update-ref", "refs/heads/main", mergeCommit]);
  const nonLinear = detectExactCommittedProposal({
    root: merged.root,
    proposal: merged.proposal,
    changes: merged.changes,
  });
  assert.equal(nonLinear.reason, "BASE_NOT_LINEAR_ANCESTOR");
  assert.equal(nonLinear.possible_proposal_commit, true);
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(merged.root, ".proposal-state", "missing.json"),
      proposalId: merged.proposal.id,
      committedEvidence: nonLinear,
    }),
    /committed or potentially committed Git evidence/,
  );

  const deepMerged = createFixture(t);
  const sideProposalCommit = commitProposal(deepMerged);
  const deepBaseTree = git(deepMerged.root, ["rev-parse", `${deepMerged.baseCommit}^{tree}`]);
  let deepFirstParent = deepMerged.baseCommit;
  for (let index = 0; index < 257; index += 1) {
    deepFirstParent = git(deepMerged.root, [
      "commit-tree",
      deepBaseTree,
      "-p",
      deepFirstParent,
      "-m",
      `Knowledge: unrelated deep first-parent ${index}`,
    ]);
  }
  const sideProposalTree = git(deepMerged.root, ["rev-parse", `${sideProposalCommit}^{tree}`]);
  const deepMergeCommit = git(deepMerged.root, [
    "commit-tree",
    sideProposalTree,
    "-p",
    deepFirstParent,
    "-p",
    sideProposalCommit,
    "-m",
    "Knowledge: unrelated deep merge",
  ]);
  git(deepMerged.root, ["update-ref", "refs/heads/main", deepMergeCommit]);
  const deepNonLinear = detectExactCommittedProposal({
    root: deepMerged.root,
    proposal: deepMerged.proposal,
    changes: deepMerged.changes,
  });
  assert.equal(deepNonLinear.reason, "BASE_NOT_LINEAR_ANCESTOR");
  assert.equal(deepNonLinear.possible_proposal_commit, true);
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(deepMerged.root, ".proposal-state", "missing.json"),
      proposalId: deepMerged.proposal.id,
      committedEvidence: deepNonLinear,
    }),
    /committed or potentially committed Git evidence/,
  );

  const deepWithoutSubject = createFixture(t);
  const unrelatedTree = git(deepWithoutSubject.root, ["rev-parse", "HEAD^{tree}"]);
  let unrelatedParent = deepWithoutSubject.baseCommit;
  for (let index = 0; index < 257; index += 1) {
    unrelatedParent = git(deepWithoutSubject.root, [
      "commit-tree",
      unrelatedTree,
      "-p",
      unrelatedParent,
      "-m",
      `Knowledge: unrelated old history ${index}`,
    ]);
  }
  git(deepWithoutSubject.root, ["update-ref", "refs/heads/main", unrelatedParent]);
  const absent = detectExactCommittedProposal({
    root: deepWithoutSubject.root,
    proposal: deepWithoutSubject.proposal,
    changes: deepWithoutSubject.changes,
  });
  assert.equal(absent.reason, "PROPOSAL_COMMIT_TOO_OLD");
  assert.equal(absent.possible_proposal_commit, undefined);
  assert.doesNotThrow(() => assertProposalCanBeRejected({
    appliedPath: path.join(deepWithoutSubject.root, ".proposal-state", "missing.json"),
    proposalId: deepWithoutSubject.proposal.id,
    committedEvidence: absent,
  }));
});

test("commit receipt survives slow sync, finalizes atomically, and refuses conflicts", (t) => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-archive-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const pendingPath = path.join(stateRoot, "pending.json");
  const appliedPath = path.join(stateRoot, "applied.json");
  const proposal = { id: "KB-20300101-120000-1234abcd" };
  const receiptRecord = {
    proposal,
    sha256: proposalHash(proposal),
    approved_at: "2030-01-01T12:00:00.000Z",
    approval: { channel: "conversation", message: "批准 KB-20300101-120000-1234abcd" },
    git_commit: "b".repeat(40),
    execution_parent: "a".repeat(40),
    commit_created: true,
    index_status: "pending",
  };

  writeFileSync(pendingPath, "pending\n");
  const receipt = writeAppliedCommitReceipt({ appliedPath, appliedRecord: receiptRecord });
  assert.equal(receipt.created, true);
  assert.equal(existsSync(pendingPath), true, "pending remains until synchronization finishes");
  assert.deepEqual(JSON.parse(readFileSync(appliedPath, "utf8")), receiptRecord);
  const retriedApproval = writeAppliedCommitReceipt({
    appliedPath,
    appliedRecord: {
      ...receiptRecord,
      approved_at: "2030-01-01T12:30:00.000Z",
      approval: { channel: "conversation", message: "重新执行" },
    },
  });
  assert.equal(retriedApproval.created, false);
  assert.deepEqual(retriedApproval.record, receiptRecord);
  assert.deepEqual(JSON.parse(readFileSync(appliedPath, "utf8")), receiptRecord);
  assert.throws(
    () => assertProposalCanBeRejected({ appliedPath, proposalId: proposal.id }),
    /already has an applied commit receipt/,
  );

  const appliedRecord = { ...receiptRecord, index_status: "synchronized" };
  const finalized = finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord });
  assert.equal(finalized.created, false);
  assert.equal(finalized.updated, true);
  assert.deepEqual(finalized.record, appliedRecord);
  assert.equal(existsSync(pendingPath), false);
  assert.deepEqual(JSON.parse(readFileSync(appliedPath, "utf8")), appliedRecord);

  writeFileSync(pendingPath, "pending again\n");
  const resumed = finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord });
  assert.equal(resumed.created, false);
  assert.equal(resumed.updated, false);
  assert.equal(existsSync(pendingPath), false);

  // Model a crash after the final archive rename but before pending unlink.
  // A retry whose synchronization result changes must make the durable archive
  // and the tool response converge on that one latest result.
  writeFileSync(pendingPath, "pending after final rename\n");
  const retryRecord = {
    ...resumed.record,
    index_status: "failed",
    index_error: "retrieval offline on retry",
  };
  const retried = finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord: retryRecord });
  assert.equal(retried.updated, true);
  assert.deepEqual(retried.record, retryRecord);
  assert.deepEqual(JSON.parse(readFileSync(appliedPath, "utf8")), retryRecord);
  assert.equal(existsSync(pendingPath), false);

  writeFileSync(pendingPath, "pending conflict\n");
  const conflicting = { ...retryRecord, git_commit: "c".repeat(40) };
  assert.throws(
    () => finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord: conflicting }),
    /Applied proposal archive conflicts/,
  );
  assert.equal(existsSync(pendingPath), true);
});

test("terminal archive durability barriers retain pending after rename-visible failures", async (t) => {
  await t.test("applied archive requires a successful retry barrier", (t2) => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-applied-barrier-"));
    t2.after(() => rmSync(stateRoot, { recursive: true, force: true }));
    const proposal = { id: "KB-20300101-120020-aabbccdd" };
    const appliedRecord = {
      proposal,
      sha256: proposalHash(proposal),
      approved_at: "2030-01-01T12:00:20.000Z",
      approval: { channel: "conversation", message: `批准 ${proposal.id}` },
      git_commit: "b".repeat(40),
      execution_parent: "a".repeat(40),
      commit_created: true,
      index_status: "synchronized",
    };
    const pendingPath = path.join(stateRoot, "pending.json");
    const appliedPath = path.join(stateRoot, "applied.json");
    writeFileSync(pendingPath, "pending\n");
    writeAppliedCommitReceipt({
      appliedPath,
      appliedRecord: { ...appliedRecord, index_status: "pending" },
    });

    assert.throws(
      () => withArchiveFailure(
        "after_applied_archive_rename_before_directory_fsync_error",
        () => finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord }),
      ),
      /Injected test-only archive publication failure/,
    );
    assert.equal(existsSync(appliedPath), true, "rename made the receipt visible");
    assert.equal(existsSync(pendingPath), true, "the first failed publish keeps pending evidence");

    for (const failure of [
      "during_applied_archive_durable_barrier",
      "during_applied_archive_durable_barrier_EINVAL",
      "during_applied_archive_durable_barrier_ENOTSUP",
      "during_applied_archive_durable_barrier_EISDIR",
      "during_applied_archive_durable_barrier_EBADF",
    ]) {
      assert.throws(
        () => withArchiveFailure(
          failure,
          () => finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord }),
        ),
        (error) => {
          assert.match(error.message, /Injected test-only archive publication failure/);
          assert.equal(
            error.code,
            ["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].find((code) => failure.endsWith(`_${code}`))
              || "TEST_ARCHIVE_DIRECTORY_FSYNC_FAILURE",
          );
          return true;
        },
      );
      assert.equal(existsSync(pendingPath), true, `${failure} must keep pending evidence`);
    }
    assert.deepEqual(JSON.parse(readFileSync(appliedPath, "utf8")), appliedRecord);

    const finalized = finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord });
    assert.equal(finalized.created, false);
    assert.equal(finalized.updated, false);
    assert.equal(existsSync(pendingPath), false);
  });

  await t.test("rejected archive requires a successful retry barrier", (t2) => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-rejected-barrier-"));
    t2.after(() => rmSync(stateRoot, { recursive: true, force: true }));
    const proposal = { id: "KB-20300101-120021-aabbccdd", changes: [] };
    const pendingRecord = { proposal, sha256: proposalHash(proposal) };
    const rejectedRecord = {
      ...pendingRecord,
      rejected_at: "2030-01-01T12:00:21.000Z",
      rejection: { channel: "conversation", message: "拒绝，保留原理由" },
    };
    const pendingPath = path.join(stateRoot, "pending.json");
    const rejectedPath = path.join(stateRoot, "rejected.json");
    writeFileSync(pendingPath, `${JSON.stringify(pendingRecord)}\n`);

    assert.throws(
      () => withArchiveFailure(
        "after_rejected_receipt_rename_before_directory_fsync_error",
        () => finalizeRejectedProposalArchive({ pendingPath, rejectedPath, rejectedRecord }),
      ),
      /Injected test-only archive publication failure/,
    );
    assert.equal(existsSync(rejectedPath), true, "rename made the rejection visible");
    assert.equal(existsSync(pendingPath), true, "the first failed publish keeps pending evidence");

    for (const failure of [
      "during_rejected_archive_durable_barrier",
      "during_rejected_archive_durable_barrier_EINVAL",
      "during_rejected_archive_durable_barrier_ENOTSUP",
      "during_rejected_archive_durable_barrier_EISDIR",
      "during_rejected_archive_durable_barrier_EBADF",
    ]) {
      assert.throws(
        () => withArchiveFailure(
          failure,
          () => finalizeRejectedProposalArchive({ pendingPath, rejectedPath, rejectedRecord }),
        ),
        (error) => {
          assert.match(error.message, /Injected test-only archive publication failure/);
          assert.equal(
            error.code,
            ["EINVAL", "ENOTSUP", "EISDIR", "EBADF"].find((code) => failure.endsWith(`_${code}`))
              || "TEST_ARCHIVE_DIRECTORY_FSYNC_FAILURE",
          );
          return true;
        },
      );
      assert.equal(existsSync(pendingPath), true, `${failure} must keep pending evidence`);
    }
    assert.deepEqual(JSON.parse(readFileSync(rejectedPath, "utf8")), rejectedRecord);

    const finalized = finalizeRejectedProposalArchive({ pendingPath, rejectedPath, rejectedRecord });
    assert.equal(finalized.created, false);
    assert.equal(existsSync(pendingPath), false);
    assert.deepEqual(finalized.record, rejectedRecord);
  });
});

test("strict terminal barrier also covers fresh and updated archive branches", async (t) => {
  function appliedRecord(id, indexStatus) {
    const proposal = { id };
    return {
      proposal,
      sha256: proposalHash(proposal),
      approved_at: "2030-01-01T12:00:30.000Z",
      approval: { channel: "conversation", message: `批准 ${id}` },
      git_commit: "b".repeat(40),
      execution_parent: "a".repeat(40),
      commit_created: true,
      index_status: indexStatus,
    };
  }

  await t.test("fresh applied archive", (t2) => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-applied-fresh-barrier-"));
    t2.after(() => rmSync(stateRoot, { recursive: true, force: true }));
    const pendingPath = path.join(stateRoot, "pending.json");
    const appliedPath = path.join(stateRoot, "applied.json");
    const record = appliedRecord("KB-20300101-120030-aabbccdd", "synchronized");
    writeFileSync(pendingPath, "pending\n");
    assert.throws(
      () => withArchiveFailure(
        "during_applied_archive_durable_barrier_EINVAL",
        () => finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord: record }),
      ),
      (error) => error.code === "EINVAL",
    );
    assert.equal(existsSync(appliedPath), true);
    assert.equal(existsSync(pendingPath), true);
  });

  await t.test("updated applied archive", (t2) => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-applied-updated-barrier-"));
    t2.after(() => rmSync(stateRoot, { recursive: true, force: true }));
    const pendingPath = path.join(stateRoot, "pending.json");
    const appliedPath = path.join(stateRoot, "applied.json");
    const pendingReceipt = appliedRecord("KB-20300101-120031-aabbccdd", "pending");
    const finalRecord = { ...pendingReceipt, index_status: "synchronized" };
    writeFileSync(pendingPath, "pending\n");
    writeAppliedCommitReceipt({ appliedPath, appliedRecord: pendingReceipt });
    assert.throws(
      () => withArchiveFailure(
        "during_applied_archive_durable_barrier_ENOTSUP",
        () => finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord: finalRecord }),
      ),
      (error) => error.code === "ENOTSUP",
    );
    assert.deepEqual(JSON.parse(readFileSync(appliedPath, "utf8")), finalRecord);
    assert.equal(existsSync(pendingPath), true);
  });

  await t.test("fresh rejected archive", (t2) => {
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-rejected-fresh-barrier-"));
    t2.after(() => rmSync(stateRoot, { recursive: true, force: true }));
    const proposal = { id: "KB-20300101-120032-aabbccdd", changes: [] };
    const rejectedRecord = {
      proposal,
      sha256: proposalHash(proposal),
      rejected_at: "2030-01-01T12:00:32.000Z",
      rejection: { channel: "conversation", message: "拒绝：保留" },
    };
    const pendingPath = path.join(stateRoot, "pending.json");
    const rejectedPath = path.join(stateRoot, "rejected.json");
    writeFileSync(pendingPath, "pending\n");
    assert.throws(
      () => withArchiveFailure(
        "during_rejected_archive_durable_barrier_EISDIR",
        () => finalizeRejectedProposalArchive({ pendingPath, rejectedPath, rejectedRecord }),
      ),
      (error) => error.code === "EISDIR",
    );
    assert.equal(existsSync(rejectedPath), true);
    assert.equal(existsSync(pendingPath), true);
  });
});

test("legacy applied archives remain readable while new receipts require execution fields", (t) => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-legacy-archive-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const appliedPath = path.join(stateRoot, "legacy.json");
  const proposal = { id: "KB-20300101-120006-aabbccdd" };
  const legacy = {
    proposal,
    sha256: proposalHash(proposal),
    approved_at: "2030-01-01T12:00:06.000Z",
    approval: { channel: "conversation", message: `批准 ${proposal.id}` },
    git_commit: "e".repeat(40),
    index_status: "synchronized",
  };
  writeFileSync(appliedPath, `${JSON.stringify(legacy, null, 2)}\n`);
  assert.deepEqual(readAppliedCommitReceipt({ appliedPath, expectedRecord: legacy }), legacy);
  assert.throws(
    () => writeAppliedCommitReceipt({
      appliedPath: path.join(stateRoot, "new-invalid.json"),
      appliedRecord: { ...legacy, index_status: "pending" },
    }),
    /Applied proposal archive conflicts/,
  );
});

test("SIGTERM during the slow-sync window leaves a durable receipt and pending proposal", async (t) => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-cancel-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const pendingPath = path.join(stateRoot, "pending.json");
  const appliedPath = path.join(stateRoot, "applied.json");
  const proposal = { id: "KB-20300101-120003-fedcba09" };
  const receiptRecord = {
    proposal,
    sha256: proposalHash(proposal),
    approved_at: "2030-01-01T12:00:03.000Z",
    approval: { channel: "conversation", message: "批准 KB-20300101-120003-fedcba09" },
    git_commit: "d".repeat(40),
    execution_parent: "c".repeat(40),
    commit_created: true,
    index_status: "pending",
  };
  writeFileSync(pendingPath, "pending\n");

  const childScript = [
    "const [moduleUrl, appliedPath, recordJson] = process.argv.slice(1);",
    "const { writeAppliedCommitReceipt } = await import(moduleUrl);",
    "writeAppliedCommitReceipt({ appliedPath, appliedRecord: JSON.parse(recordJson) });",
    "process.stdout.write('RECEIPT_DURABLE\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    childScript,
    new URL("./proposal-store.mjs", import.meta.url).href,
    appliedPath,
    JSON.stringify(receiptRecord),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "";
  while (!output.includes("RECEIPT_DURABLE")) {
    const [chunk] = await once(child.stdout, "data");
    output += chunk.toString("utf8");
  }
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, null);
  assert.equal(signal, "SIGTERM");
  assert.equal(existsSync(pendingPath), true);
  assert.deepEqual(JSON.parse(readFileSync(appliedPath, "utf8")), receiptRecord);
  assert.throws(
    () => assertProposalCanBeRejected({ appliedPath, proposalId: proposal.id }),
    /already has an applied commit receipt/,
    "a cancellation after commit cannot turn the same proposal into a rejection",
  );

  const appliedRecord = { ...receiptRecord, index_status: "synchronized" };
  const finalized = finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord });
  assert.equal(finalized.updated, true);
  assert.equal(existsSync(pendingPath), false);
  assert.deepEqual(JSON.parse(readFileSync(appliedPath, "utf8")), appliedRecord);
});

test("server checks exact committed recovery before stale preconditions or file mutation", () => {
  const server = readFileSync(path.join(HERE, "server.mjs"), "utf8");
  const rejectHandler = server.indexOf('"knowledge_reject_proposal"');
  const rejectStructure = server.indexOf(
    "validateChanges(record.proposal.changes, { enforceIsolation: false })",
    rejectHandler,
  );
  const rejectInflightInspection = server.indexOf("inspectInterruptedApply({", rejectHandler);
  const rejectDetector = server.indexOf("detectExactCommittedProposal({", rejectInflightInspection);
  const rejectGuard = server.indexOf("assertProposalCanBeRejected({", rejectHandler);
  const rejectedArchive = server.indexOf("const rejectedRecord = {", rejectHandler);
  const rejectGuardCall = server.slice(rejectGuard, rejectedArchive);
  const applyHandler = server.indexOf('"knowledge_apply_proposal"');
  const stateRead = server.indexOf("const state = readProposalState(proposal_id);", applyHandler);
  const receiptProof = server.indexOf("const candidate = detectExactCommittedProposal({", stateRead);
  const preRecoveryHookGate = server.indexOf("assertNoActiveCommitHooks({ root: ROOT });", stateRead);
  const applyInflightRecovery = server.indexOf("recoverInterruptedApply({", applyHandler);
  const stagedGuard = server.indexOf("assertNoStagedChanges();", applyHandler);
  const recovery = server.indexOf("const recovery = detectExactCommittedProposal({", applyInflightRecovery);
  const recoveryReceipt = server.indexOf("const receipt = writeAppliedCommitReceipt({", recovery);
  const recoveryReceiptBarrier = server.indexOf("ensureAppliedReceiptDurable({", recoveryReceipt);
  const recoveryWalClear = server.indexOf("clearApplyTransaction({", recoveryReceiptBarrier);
  const recoverySync = server.indexOf("await synchronizeCommittedState(recovery.current_head)", recoveryReceipt);
  const recoveryFinalize = server.indexOf("finalizeAppliedArchive({", recoverySync);
  const isolation = server.indexOf("assertProposalChangeIsolation(changes,", recovery);
  const preconditions = server.indexOf("assertProposalPreconditions(record.proposal.preconditions, snapshots)", recovery);
  const durableIntent = server.indexOf("transaction = beginApplyTransaction({", preconditions);
  const postIntentCheck = server.indexOf("assertSnapshotsUnchanged(snapshots, snapshotTargets(changes));", durableIntent);
  const mutation = server.indexOf("applyFileChanges(ROOT, changes,", durableIntent);
  const normalCommit = server.indexOf("const committed = commitProposalChanges", mutation);
  const normalReceipt = server.indexOf("writeAppliedCommitReceipt({", normalCommit);
  const normalReceiptBarrier = server.indexOf("ensureAppliedReceiptDurable({", normalReceipt);
  const normalWalClear = server.indexOf("clearApplyTransaction({", normalReceiptBarrier);
  const normalSync = server.indexOf("await synchronizeCommittedState(committed.commit)", normalReceipt);
  const normalFinalize = server.indexOf("finalizeAppliedArchive({", normalSync);
  const commitFunction = server.indexOf("function commitProposalChanges(");
  const preStageHookGate = server.indexOf("assertNoActiveCommitHooks({ root: ROOT });", commitFunction);
  const gitAdd = server.indexOf('run("git", ["add", "--all"', commitFunction);
  const stagedProof = server.indexOf("assertApplyTransactionReadyToCommit({", gitAdd);
  const postStageHookGate = server.indexOf("assertNoActiveCommitHooks({ root: ROOT });", stagedProof);
  const gitCommit = server.indexOf('run("git", ["commit", "-m"', postStageHookGate);
  const postCommitProof = server.indexOf("const proof = detectExactCommittedProposal({", gitCommit);
  assert.ok(recovery > 0, "server must call the exact-commit detector");
  assert.ok(
    rejectInflightInspection > rejectHandler
      && rejectStructure > rejectInflightInspection
      && rejectDetector > rejectStructure
      && rejectGuard > rejectDetector
      && rejectedArchive > rejectGuard,
    "rejection must inspect and block durable inflight approval without recovering it",
  );
  assert.equal(
    server.slice(rejectHandler, applyHandler).includes("recoverInterruptedApply({"),
    false,
    "rejection must never mutate the worktree by running interrupted-apply recovery",
  );
  assert.ok(
    server.slice(rejectDetector, rejectGuard).includes("recoveryRecord,"),
    "reject evidence must use the inspected same-proposal WAL baseline",
  );
  assert.ok(
    rejectGuardCall.includes("preconditions: record.proposal.preconditions,")
      && rejectGuardCall.includes("baseCommit: record.proposal.base_commit,"),
    "rejection must bind dirty-target exceptions to the immutable proposal baseline",
  );
  assert.ok(
    applyInflightRecovery > applyHandler && stagedGuard > applyInflightRecovery,
    "pre-commit recovery must run before staged-change checks can trap a crashed apply",
  );
  assert.ok(
    stateRead > applyHandler
      && preRecoveryHookGate > stateRead
      && receiptProof > preRecoveryHookGate
      && receiptProof < applyInflightRecovery,
    "a durable receipt must be proven before a pre-commit-looking WAL can restore live files",
  );
  assert.ok(
    recoveryReceipt > recovery
      && recoveryReceiptBarrier > recoveryReceipt
      && recoveryWalClear > recoveryReceiptBarrier
      && recoverySync > recoveryWalClear,
    "post-commit recovery must durably revalidate the receipt before clearing WAL or synchronizing",
  );
  assert.ok(
    server.slice(recovery, recoveryReceipt).includes("recoveryRecord:"),
    "apply evidence must use the same-proposal post-commit WAL baseline",
  );
  assert.ok(recoveryFinalize > recoverySync, "recovery archives only after synchronization returns");
  assert.ok(
    isolation > recovery && preconditions > isolation,
    "exact historical commits must be recovered before new isolation policy gates fresh mutation",
  );
  assert.ok(durableIntent > preconditions, "durable intent must follow the final precondition read");
  assert.ok(postIntentCheck > durableIntent, "approved bytes must be checked again after publishing durable intent");
  assert.ok(mutation > postIntentCheck, "durable intent and its post-write check must precede live mutation");
  assert.ok(mutation > recovery, "recovery must run before any proposal file mutation");
  assert.ok(
    normalReceipt > normalCommit
      && normalReceiptBarrier > normalReceipt
      && normalWalClear > normalReceiptBarrier
      && normalSync > normalWalClear,
    "normal apply must durably revalidate the receipt before clearing WAL or synchronizing",
  );
  assert.ok(
    preStageHookGate > commitFunction
      && gitAdd > preStageHookGate
      && stagedProof > gitAdd
      && postStageHookGate > stagedProof
      && gitCommit > postStageHookGate
      && postCommitProof > gitCommit
      && postCommitProof < normalReceipt,
    "commit hooks and staged state must be gated before commit, then the exact commit must be proven before receipt",
  );
  assert.ok(normalFinalize > normalSync, "normal apply finalizes only after synchronization returns");
});

test("a post-commit inflight intent remains durable and blocks rejection until receipt", (t) => {
  const fixture = createFixture(t);
  const transactionDir = path.join(fixture.root, ".proposal-state", "inflight");
  const transaction = beginApplyTransaction({
    root: fixture.root,
    transactionDir,
    proposal: fixture.proposal,
    approval: { channel: "conversation", message: `批准 ${fixture.proposal.id}` },
    approvedAt: new Date().toISOString(),
    executionParent: fixture.baseCommit,
    changes: fixture.changes,
    snapshots: targetSnapshots(fixture.root, Object.keys(fixture.proposal.preconditions)),
  });
  const commit = commitProposal(fixture);
  const inspection = inspectInterruptedApply({ root: fixture.root, transactionDir });
  assert.equal(inspection.status, "post_commit");
  assert.equal(inspection.proposal_id, fixture.proposal.id);
  assert.equal(inspection.record.execution_parent, fixture.baseCommit);
  assert.equal(inspection.record.proposal_sha256, proposalHash(fixture.proposal));
  assert.deepEqual(inspection.record.approval, {
    channel: "conversation",
    message: `批准 ${fixture.proposal.id}`,
  });
  assert.ok(inspection.record.snapshots.every((snapshot) => (
    Object.hasOwn(snapshot, "index_before") && Object.hasOwn(snapshot, "index_after")
  )));
  const recovery = recoverInterruptedApply({ root: fixture.root, transactionDir });
  assert.equal(recovery.status, "post_commit");
  assert.equal(recovery.proposal_id, fixture.proposal.id);
  assert.equal(recovery.current_head, commit);
  assert.equal(existsSync(transaction.path), true);
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(fixture.root, ".proposal-state", "applied", `${fixture.proposal.id}.json`),
      inflightPath: transaction.path,
      proposalId: fixture.proposal.id,
    }),
    /durable in-flight approval/,
  );
  assert.equal(clearApplyTransaction({ transactionPath: transaction.path, token: transaction.record.token }), true);
});

test("SIGKILL after the first target mutation and before commit is recovered from a durable inflight intent", async (t) => {
  const fixture = createFixture(t);
  const transactionDir = path.join(fixture.root, ".proposal-state", "inflight");
  const approval = {
    channel: "conversation",
    message: `批准 ${fixture.proposal.id}`,
  };
  const childScript = [
    "const [moduleUrl, root, transactionDir, proposalJson, changesJson, approvalJson] = process.argv.slice(1);",
    "const { beginApplyTransaction } = await import(moduleUrl);",
    "const { execFileSync } = await import('node:child_process');",
    "const { readFileSync, statSync, writeFileSync } = await import('node:fs');",
    "const path = (await import('node:path')).default;",
    "const proposal = JSON.parse(proposalJson);",
    "const changes = JSON.parse(changesJson);",
    "const approval = JSON.parse(approvalJson);",
    "const snapshots = new Map(Object.keys(proposal.preconditions).map((target) => {",
    "  const absolute = path.join(root, target);",
    "  try { const stat = statSync(absolute); return [target, { exists: true, content: readFileSync(absolute), mode: stat.mode }]; }",
    "  catch (error) { if (error.code === 'ENOENT') return [target, { exists: false }]; throw error; }",
    "}));",
    "const executionParent = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();",
    "beginApplyTransaction({ root, transactionDir, proposal, approval, approvedAt: new Date().toISOString(), executionParent, changes, snapshots });",
    "writeFileSync(path.join(root, 'methods/update.md'), 'after\\n');",
    "execFileSync('git', ['add', '--', 'methods/update.md'], { cwd: root });",
    "process.stdout.write('FIRST_TARGET_MUTATED_AND_STAGED\\n');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    childScript,
    new URL("./proposal-store.mjs", import.meta.url).href,
    fixture.root,
    transactionDir,
    JSON.stringify(fixture.proposal),
    JSON.stringify(fixture.changes),
    JSON.stringify(approval),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "";
  while (!output.includes("FIRST_TARGET_MUTATED_AND_STAGED")) {
    const [chunk] = await once(child.stdout, "data");
    output += chunk.toString("utf8");
  }
  child.kill("SIGKILL");
  const [code, signal] = await once(child, "exit");
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
  assert.equal(readFileSync(path.join(fixture.root, "methods/update.md"), "utf8"), "after\n");
  assert.notEqual(git(fixture.root, ["status", "--short", "--", "methods/update.md"]), "");
  assert.equal(existsSync(inflightTransactionPath(transactionDir, fixture.proposal.id)), true);

  const recovered = recoverInterruptedApply({ root: fixture.root, transactionDir });
  assert.equal(recovered.status, "restored_precommit");
  assert.equal(recovered.proposal_id, fixture.proposal.id);
  assert.equal(readFileSync(path.join(fixture.root, "methods/update.md"), "utf8"), "before\n");
  assert.equal(git(fixture.root, ["status", "--short", "--", ...Object.keys(fixture.proposal.preconditions)]), "");
  assert.equal(
    existsSync(inflightTransactionPath(transactionDir, fixture.proposal.id)),
    true,
    "restored preimages must retain durable approval until receipt publication",
  );
});

test("pre-commit recovery preserves an unrecognized index-only staged edit and its WAL", (t) => {
  const fixture = createFixture(t);
  const transactionDir = path.join(fixture.root, ".proposal-state", "inflight");
  const transaction = beginApplyTransaction({
    root: fixture.root,
    transactionDir,
    proposal: fixture.proposal,
    approval: { channel: "conversation", message: `批准 ${fixture.proposal.id}` },
    approvedAt: new Date().toISOString(),
    executionParent: fixture.baseCommit,
    changes: fixture.changes,
    snapshots: targetSnapshots(fixture.root, Object.keys(fixture.proposal.preconditions)),
  });

  write(fixture.root, "methods/update.md", "external staged bytes\n");
  git(fixture.root, ["add", "--", "methods/update.md"]);
  write(fixture.root, "methods/update.md", "before\n");
  const stagedOid = git(fixture.root, ["rev-parse", ":methods/update.md"]);
  const inspected = inspectInterruptedApply({ root: fixture.root, transactionDir });
  assert.equal(inspected.status, "pre_commit");
  assert.equal(readFileSync(path.join(fixture.root, "methods/update.md"), "utf8"), "before\n");

  assert.throws(
    () => recoverInterruptedApply({ root: fixture.root, transactionDir }),
    /changed outside the recorded transaction; recovery stopped without unstaging it/,
  );
  assert.equal(git(fixture.root, ["rev-parse", ":methods/update.md"]), stagedOid);
  assert.equal(readFileSync(path.join(fixture.root, "methods/update.md"), "utf8"), "before\n");
  assert.equal(existsSync(transaction.path), true);
});

test("pre-commit recovery covers no-op, untracked delete, and untracked move boundaries", async (t) => {
  await t.test("no-op retry carries the first durable approval", (t2) => {
    const { root, baseCommit } = createMinimalRepo(t2, "proposal-precommit-noop-", {
      "methods/noop.md": "same\n",
    });
    const changes = [{ action: "update", target: "methods/noop.md", content: "same\n" }];
    const proposal = {
      id: "KB-20300101-140001-aabbccdd",
      base_commit: baseCommit,
      summary: "No-op proposal",
      changes,
      preconditions: { "methods/noop.md": { exists: true, sha256: sha256("same\n") } },
    };
    const transactionDir = mkdtempSync(path.join(os.tmpdir(), "proposal-precommit-noop-wal-"));
    t2.after(() => rmSync(transactionDir, { recursive: true, force: true }));
    const firstApproval = { channel: "conversation", message: `批准 ${proposal.id}` };
    const firstApprovedAt = "2030-01-01T14:00:01.000Z";
    beginApplyTransaction({
      root,
      transactionDir,
      proposal,
      approval: firstApproval,
      approvedAt: firstApprovedAt,
      executionParent: baseCommit,
      changes,
      snapshots: targetSnapshots(root, ["methods/noop.md"]),
    });
    write(root, "methods/noop.md", "same\n");
    git(root, ["add", "--", "methods/noop.md"]);
    const recovered = recoverInterruptedApply({ root, transactionDir });
    assert.equal(recovered.status, "restored_precommit");
    assert.deepEqual(recovered.approval, firstApproval);
    assert.equal(recovered.approved_at, firstApprovedAt);
    const retried = beginApplyTransaction({
      root,
      transactionDir,
      proposal,
      approval: recovered.approval,
      approvedAt: recovered.approved_at,
      executionParent: baseCommit,
      changes,
      snapshots: targetSnapshots(root, ["methods/noop.md"]),
    });
    assert.deepEqual(retried.record.approval, firstApproval);
    assert.equal(retried.record.approved_at, firstApprovedAt);
    clearApplyTransaction({ transactionPath: retried.path, token: retried.record.token });
    assert.equal(git(root, ["status", "--short", "--", "methods/noop.md"]), "");
  });

  await t.test("untracked-only delete restores its original untracked preimage", (t2) => {
    const { root, baseCommit } = createMinimalRepo(t2, "proposal-precommit-untracked-delete-");
    write(root, "methods/untracked.md", "untracked before\n");
    const changes = [{ action: "delete", target: "methods/untracked.md" }];
    const proposal = {
      id: "KB-20300101-140002-aabbccdd",
      base_commit: baseCommit,
      summary: "Delete an untracked file",
      changes,
      preconditions: {
        "methods/untracked.md": { exists: true, sha256: sha256("untracked before\n") },
      },
    };
    const transactionDir = mkdtempSync(path.join(os.tmpdir(), "proposal-precommit-delete-wal-"));
    t2.after(() => rmSync(transactionDir, { recursive: true, force: true }));
    beginApplyTransaction({
      root,
      transactionDir,
      proposal,
      approval: { channel: "conversation", message: `批准 ${proposal.id}` },
      approvedAt: "2030-01-01T14:00:02.000Z",
      executionParent: baseCommit,
      changes,
      snapshots: targetSnapshots(root, ["methods/untracked.md"]),
    });
    unlinkSync(path.join(root, "methods/untracked.md"));
    const recovered = recoverInterruptedApply({ root, transactionDir });
    assert.equal(recovered.status, "restored_precommit");
    assert.equal(readFileSync(path.join(root, "methods/untracked.md"), "utf8"), "untracked before\n");
    assert.equal(git(root, ["status", "--short", "--", "methods/untracked.md"]), "?? methods/untracked.md");
  });

  await t.test("untracked move restores source, destination, and index", (t2) => {
    const { root, baseCommit } = createMinimalRepo(t2, "proposal-precommit-untracked-move-");
    write(root, "methods/untracked-source.md", "move before\n");
    const changes = [{
      action: "move",
      target: "methods/untracked-source.md",
      new_target: "methods/untracked-destination.md",
    }];
    const proposal = {
      id: "KB-20300101-140003-aabbccdd",
      base_commit: baseCommit,
      summary: "Move an untracked file",
      changes,
      preconditions: {
        "methods/untracked-source.md": { exists: true, sha256: sha256("move before\n") },
        "methods/untracked-destination.md": { exists: false },
      },
    };
    const transactionDir = mkdtempSync(path.join(os.tmpdir(), "proposal-precommit-move-wal-"));
    t2.after(() => rmSync(transactionDir, { recursive: true, force: true }));
    beginApplyTransaction({
      root,
      transactionDir,
      proposal,
      approval: { channel: "conversation", message: `批准 ${proposal.id}` },
      approvedAt: "2030-01-01T14:00:03.000Z",
      executionParent: baseCommit,
      changes,
      snapshots: targetSnapshots(root, Object.keys(proposal.preconditions)),
    });
    renameSync(
      path.join(root, "methods/untracked-source.md"),
      path.join(root, "methods/untracked-destination.md"),
    );
    git(root, ["add", "--", "methods/untracked-destination.md"]);
    const recovered = recoverInterruptedApply({ root, transactionDir });
    assert.equal(recovered.status, "restored_precommit");
    assert.equal(readFileSync(path.join(root, "methods/untracked-source.md"), "utf8"), "move before\n");
    assert.equal(existsSync(path.join(root, "methods/untracked-destination.md")), false);
    assert.equal(git(root, ["ls-files", "--", "methods/untracked-destination.md"]), "");
    assert.equal(
      git(root, ["status", "--short", "--", "methods/untracked-source.md"]),
      "?? methods/untracked-source.md",
    );
  });
});

test("receipt-first no-commit recovery never restores an already deleted untracked file", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-receipt-untracked-delete-");
  write(root, "methods/untracked.md", "delete after approval\n");
  const changes = [{ action: "delete", target: "methods/untracked.md" }];
  const proposal = {
    id: "KB-20300101-150001-aabbccdd",
    base_commit: baseCommit,
    summary: "Durably delete an untracked file",
    changes,
    preconditions: {
      "methods/untracked.md": { exists: true, sha256: sha256("delete after approval\n") },
    },
  };
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-receipt-delete-state-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const transactionDir = path.join(stateRoot, "inflight");
  const appliedDir = path.join(stateRoot, "applied");
  const approvedAt = "2030-01-01T15:00:01.000Z";
  const approval = { channel: "conversation", message: `批准 ${proposal.id}` };
  const transaction = beginApplyTransaction({
    root,
    transactionDir,
    proposal,
    approval,
    approvedAt,
    executionParent: baseCommit,
    changes,
    snapshots: targetSnapshots(root, ["methods/untracked.md"]),
  });
  unlinkSync(path.join(root, "methods/untracked.md"));
  const receiptRecord = {
    proposal,
    sha256: proposalHash(proposal),
    approved_at: approvedAt,
    approval,
    git_commit: baseCommit,
    execution_parent: baseCommit,
    execution_baseline: compactApplyBaseline(transaction.record.snapshots),
    commit_created: false,
    index_status: "pending",
  };
  const appliedPath = path.join(appliedDir, `${proposal.id}.json`);
  const written = writeAppliedCommitReceipt({ appliedPath, appliedRecord: receiptRecord });
  assert.equal(inspectInterruptedApply({ root, transactionDir }).status, "pre_commit");
  const durable = readAppliedCommitReceipt({ appliedPath, expectedRecord: receiptRecord });
  assert.equal(verifyNoCommitAppliedReceipt({ root, receipt: durable, appliedDir }).matched, true);
  clearApplyTransaction({ transactionPath: transaction.path, token: transaction.record.token });
  assert.equal(existsSync(path.join(root, "methods/untracked.md")), false);
  assert.deepEqual(written.record.approval, approval);
  assert.equal(written.record.approved_at, approvedAt);
});

test("no-commit receipts reject worktree drift hidden from Git status", async (t) => {
  function setup(t2, { id, prefix, tracked, action, target, initial, desired = null }) {
    const { root, baseCommit } = createMinimalRepo(
      t2,
      prefix,
      tracked ? { [target]: initial } : {},
    );
    if (!tracked) write(root, target, initial);
    const changes = action === "delete"
      ? [{ action, target }]
      : [{ action, target, content: desired }];
    const proposal = {
      id,
      base_commit: baseCommit,
      summary: `No-commit ${action} ${target}`,
      changes,
      preconditions: { [target]: { exists: true, sha256: sha256(initial) } },
    };
    const transactionDir = path.join(root, ".proposal-state", "inflight");
    const appliedDir = path.join(root, ".proposal-state", "applied");
    const transaction = beginApplyTransaction({
      root,
      transactionDir,
      proposal,
      approval: { channel: "conversation", message: `批准 ${proposal.id}` },
      approvedAt: "2030-01-01T15:00:10.000Z",
      executionParent: baseCommit,
      changes,
      snapshots: targetSnapshots(root, [target]),
    });
    if (action === "delete") unlinkSync(path.join(root, target));
    const receipt = {
      proposal,
      sha256: proposalHash(proposal),
      approved_at: transaction.record.approved_at,
      approval: transaction.record.approval,
      git_commit: baseCommit,
      execution_parent: baseCommit,
      execution_baseline: compactApplyBaseline(transaction.record.snapshots),
      commit_created: false,
      index_status: "pending",
    };
    writeAppliedCommitReceipt({
      appliedPath: path.join(appliedDir, `${proposal.id}.json`),
      appliedRecord: receipt,
    });
    return { root, appliedDir, receipt, target };
  }

  await t.test("assume-unchanged cannot hide changed bytes", (t2) => {
    const fixture = setup(t2, {
      id: "KB-20300101-150010-aabbccdd",
      prefix: "proposal-noop-assume-unchanged-",
      tracked: true,
      action: "update",
      target: "methods/noop.md",
      initial: "same\n",
      desired: "same\n",
    });
    git(fixture.root, ["update-index", "--assume-unchanged", fixture.target]);
    write(fixture.root, fixture.target, "hidden bytes\n");
    assert.equal(git(fixture.root, ["status", "--short", "--", fixture.target]), "");
    const verified = verifyNoCommitAppliedReceipt(fixture);
    assert.equal(verified.matched, false);
    assert.equal(verified.reason, "WORKTREE_CONTENT_MISMATCH");
  });

  await t.test("core.fileMode=false cannot hide changed executable mode", (t2) => {
    const fixture = setup(t2, {
      id: "KB-20300101-150011-aabbccdd",
      prefix: "proposal-noop-filemode-",
      tracked: true,
      action: "update",
      target: "methods/noop.md",
      initial: "same\n",
      desired: "same\n",
    });
    git(fixture.root, ["config", "core.fileMode", "false"]);
    chmodSync(path.join(fixture.root, fixture.target), 0o755);
    assert.equal(git(fixture.root, ["status", "--short", "--", fixture.target]), "");
    const verified = verifyNoCommitAppliedReceipt(fixture);
    assert.equal(verified.matched, false);
    assert.equal(verified.reason, "WORKTREE_MODE_MISMATCH");
  });

  await t.test("ignored reappearance cannot hide a deleted untracked target", (t2) => {
    const fixture = setup(t2, {
      id: "KB-20300101-150012-aabbccdd",
      prefix: "proposal-noop-ignored-reappearance-",
      tracked: false,
      action: "delete",
      target: "methods/untracked.md",
      initial: "delete me\n",
    });
    writeFileSync(path.join(fixture.root, ".git", "info", "exclude"), `${fixture.target}\n`);
    write(fixture.root, fixture.target, "ignored reappearance\n");
    assert.equal(git(fixture.root, ["status", "--short", "--", fixture.target]), "");
    const verified = verifyNoCommitAppliedReceipt(fixture);
    assert.equal(verified.matched, false);
    assert.equal(verified.reason, "WORKTREE_EXISTENCE_MISMATCH");
  });
});

test("no-commit receipts reject dangling target and ancestor symlinks without consuming evidence", async (t) => {
  async function exercise(t2, { id, prefix, target, replaceAncestor }) {
    const { root, baseCommit } = createMinimalRepo(t2, prefix);
    write(root, target, "untracked approved bytes\n");
    const changes = [{ action: "delete", target }];
    const proposal = {
      id,
      base_commit: baseCommit,
      summary: `Reject dangling symlink ${target}`,
      changes,
      preconditions: { [target]: { exists: true, sha256: sha256("untracked approved bytes\n") } },
    };
    const stateRoot = path.join(root, ".proposal-state");
    const transactionDir = path.join(stateRoot, "inflight");
    const appliedDir = path.join(stateRoot, "applied");
    const pendingPath = path.join(stateRoot, "pending", `${proposal.id}.json`);
    mkdirSync(path.dirname(pendingPath), { recursive: true });
    writeFileSync(pendingPath, `${JSON.stringify({ proposal, sha256: proposalHash(proposal) })}\n`);
    const transaction = beginApplyTransaction({
      root,
      transactionDir,
      proposal,
      approval: { channel: "conversation", message: `批准 ${proposal.id}` },
      approvedAt: "2030-01-01T15:00:20.000Z",
      executionParent: baseCommit,
      changes,
      snapshots: targetSnapshots(root, [target]),
    });
    unlinkSync(path.join(root, target));
    const receipt = {
      proposal,
      sha256: proposalHash(proposal),
      approved_at: transaction.record.approved_at,
      approval: transaction.record.approval,
      git_commit: baseCommit,
      execution_parent: baseCommit,
      execution_baseline: compactApplyBaseline(transaction.record.snapshots),
      commit_created: false,
      index_status: "pending",
    };
    const appliedPath = path.join(appliedDir, `${proposal.id}.json`);
    writeAppliedCommitReceipt({ appliedPath, appliedRecord: receipt });

    const targetPath = path.join(root, target);
    const symlinkPath = replaceAncestor ? path.dirname(targetPath) : targetPath;
    if (replaceAncestor) rmSync(symlinkPath, { recursive: true });
    symlinkSync("missing-approved-path", symlinkPath);
    assert.equal(existsSync(targetPath), false, "the symlink must remain dangling");
    assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);

    const verified = verifyNoCommitAppliedReceipt({ root, receipt, appliedDir });
    assert.equal(verified.matched, false);
    assert.equal(verified.reason, "WORKTREE_TARGET_UNREADABLE");
    assert.equal(existsSync(transaction.path), true, "WAL must remain available");
    assert.equal(existsSync(pendingPath), true, "pending proposal must remain available");
    assert.equal(existsSync(appliedPath), true, "receipt must remain available");
  }

  await t.test("dangling target symlink", (t2) => exercise(t2, {
    id: "KB-20300101-150020-aabbccdd",
    prefix: "proposal-noop-dangling-target-",
    target: "methods/dangling-target.md",
    replaceAncestor: false,
  }));
  await t.test("dangling ancestor symlink", (t2) => exercise(t2, {
    id: "KB-20300101-150021-aabbccdd",
    prefix: "proposal-noop-dangling-ancestor-",
    target: "methods/dangling-parent/item.md",
    replaceAncestor: true,
  }));
});

test("a no-op receipt remains recoverable across a verified applied sibling", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-receipt-noop-sibling-", {
    "methods/noop.md": "same\n",
  });
  const changes = [{ action: "update", target: "methods/noop.md", content: "same\n" }];
  const proposal = {
    id: "KB-20300101-150002-aabbccdd",
    base_commit: baseCommit,
    summary: "Durable no-op update",
    changes,
    preconditions: { "methods/noop.md": { exists: true, sha256: sha256("same\n") } },
  };
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-receipt-noop-state-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const transactionDir = path.join(stateRoot, "inflight");
  const appliedDir = path.join(stateRoot, "applied");
  const transaction = beginApplyTransaction({
    root,
    transactionDir,
    proposal,
    approval: { channel: "conversation", message: `批准 ${proposal.id}` },
    approvedAt: "2030-01-01T15:00:02.000Z",
    executionParent: baseCommit,
    changes,
    snapshots: targetSnapshots(root, ["methods/noop.md"]),
  });
  const receipt = {
    proposal,
    sha256: proposalHash(proposal),
    approved_at: transaction.record.approved_at,
    approval: transaction.record.approval,
    git_commit: baseCommit,
    execution_parent: baseCommit,
    execution_baseline: compactApplyBaseline(transaction.record.snapshots),
    commit_created: false,
    index_status: "pending",
  };
  writeAppliedCommitReceipt({
    appliedPath: path.join(appliedDir, `${proposal.id}.json`),
    appliedRecord: receipt,
  });

  const sibling = {
    id: "KB-20300101-150003-aabbccdd",
    base_commit: baseCommit,
    summary: "Verified later sibling on the same target",
    changes: [{ action: "update", target: "methods/noop.md", content: "later\n" }],
    preconditions: { "methods/noop.md": { exists: true, sha256: sha256("same\n") } },
  };
  write(root, "methods/noop.md", "later\n");
  git(root, ["add", "--", "methods/noop.md"]);
  git(root, ["commit", "-m", proposalCommitSubject(sibling)]);
  const siblingCommit = git(root, ["rev-parse", "HEAD"]);
  const siblingRecord = {
    proposal: sibling,
    sha256: proposalHash(sibling),
    approved_at: "2030-01-01T15:00:03.000Z",
    approval: { channel: "conversation", message: `批准 ${sibling.id}` },
    git_commit: siblingCommit,
    execution_parent: baseCommit,
    execution_baseline: [{
      target: "methods/noop.md",
      exists: true,
      sha256: sha256("same\n"),
      mode: 0o644,
    }],
    commit_created: true,
    index_status: "synchronized",
  };
  mkdirSync(appliedDir, { recursive: true });
  writeFileSync(
    path.join(appliedDir, `${sibling.id}.json`),
    `${JSON.stringify(siblingRecord, null, 2)}\n`,
  );
  const verified = verifyNoCommitAppliedReceipt({ root, receipt, appliedDir });
  assert.equal(verified.matched, true, verified.reason);
  assert.equal(verified.current_head, siblingCommit);
});

test("reject fails closed on dirty proposal targets without WAL or receipt", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-legacy-dirty-reject-", {
    "methods/dirty.md": "before\n",
  });
  const changes = [{ action: "update", target: "methods/dirty.md", content: "after\n" }];
  const proposal = {
    id: "KB-20300101-150004-aabbccdd",
    base_commit: baseCommit,
    summary: "Legacy dirty pending proposal",
    changes,
    preconditions: { "methods/dirty.md": { exists: true, sha256: sha256("before\n") } },
  };
  write(root, "methods/dirty.md", "partial old crash bytes\n");
  const evidence = detectExactCommittedProposal({ root, proposal, changes });
  assert.equal(evidence.reason, "PROPOSAL_COMMIT_MISSING");
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(root, ".proposal-state", "missing.json"),
      proposalId: proposal.id,
      committedEvidence: evidence,
      root,
      changes,
      preconditions: proposal.preconditions,
      baseCommit: proposal.base_commit,
    }),
    /uncommitted state and cannot be safely rejected/,
  );
  assert.equal(readFileSync(path.join(root, "methods/dirty.md"), "utf8"), "partial old crash bytes\n");
  assert.equal(git(root, ["rev-parse", "HEAD"]), baseCommit);
});

test("reject permits pre-existing dirty or untracked targets only while their proposal baseline is exact", (t) => {
  const tracked = createMinimalRepo(t, "proposal-baseline-dirty-reject-", {
    "methods/dirty.md": "committed\n",
  });
  write(tracked.root, "methods/dirty.md", "pre-existing dirty bytes\n");
  const trackedChanges = [{
    action: "update",
    target: "methods/dirty.md",
    content: "proposed replacement\n",
  }];
  const trackedPreconditions = {
    "methods/dirty.md": {
      exists: true,
      sha256: sha256("pre-existing dirty bytes\n"),
    },
  };
  assert.doesNotThrow(() => assertProposalCanBeRejected({
    appliedPath: path.join(tracked.root, ".proposal-state", "missing.json"),
    proposalId: "KB-20300102-010001-aabbccdd",
    root: tracked.root,
    changes: trackedChanges,
    preconditions: trackedPreconditions,
    baseCommit: tracked.baseCommit,
  }));

  write(tracked.root, "methods/dirty.md", "changed after proposal\n");
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(tracked.root, ".proposal-state", "missing.json"),
      proposalId: "KB-20300102-010001-aabbccdd",
      root: tracked.root,
      changes: trackedChanges,
      preconditions: trackedPreconditions,
      baseCommit: tracked.baseCommit,
    }),
    /current contents do not exactly match the proposal baseline/,
  );

  const untracked = createMinimalRepo(t, "proposal-baseline-untracked-reject-");
  write(untracked.root, "未命名.canvas", "{\"nodes\":[],\"edges\":[]}\n");
  const untrackedChanges = [{ action: "delete", target: "未命名.canvas" }];
  const untrackedPreconditions = {
    "未命名.canvas": {
      exists: true,
      sha256: sha256("{\"nodes\":[],\"edges\":[]}\n"),
    },
  };
  assert.doesNotThrow(() => assertProposalCanBeRejected({
    appliedPath: path.join(untracked.root, ".proposal-state", "missing.json"),
    proposalId: "KB-20300102-010002-aabbccdd",
    root: untracked.root,
    changes: untrackedChanges,
    preconditions: untrackedPreconditions,
    baseCommit: untracked.baseCommit,
  }));
  assert.equal(readFileSync(path.join(untracked.root, "未命名.canvas"), "utf8"), "{\"nodes\":[],\"edges\":[]}\n");

  unlinkSync(path.join(untracked.root, "未命名.canvas"));
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(untracked.root, ".proposal-state", "missing.json"),
      proposalId: "KB-20300102-010002-aabbccdd",
      root: untracked.root,
      changes: untrackedChanges,
      preconditions: untrackedPreconditions,
      baseCommit: untracked.baseCommit,
    }),
    /current contents do not exactly match the proposal baseline/,
  );
});

test("reject never treats staged or symlink state as an exact dirty baseline", (t) => {
  const staged = createMinimalRepo(t, "proposal-staged-baseline-reject-");
  const stagedTarget = "staged.canvas";
  const contents = "{\"nodes\":[],\"edges\":[]}\n";
  write(staged.root, stagedTarget, contents);
  const changes = [{ action: "delete", target: stagedTarget }];
  const preconditions = {
    [stagedTarget]: { exists: true, sha256: sha256(contents) },
  };
  git(staged.root, ["add", "--", stagedTarget]);
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(staged.root, ".proposal-state", "missing.json"),
      proposalId: "KB-20300102-010004-aabbccdd",
      root: staged.root,
      changes,
      preconditions,
      baseCommit: staged.baseCommit,
    }),
    /uncommitted state and cannot be safely rejected/,
  );

  const symlink = createMinimalRepo(t, "proposal-symlink-baseline-reject-");
  write(symlink.root, "backing.txt", contents);
  symlinkSync("backing.txt", path.join(symlink.root, stagedTarget));
  assert.throws(
    () => assertProposalCanBeRejected({
      appliedPath: path.join(symlink.root, ".proposal-state", "missing.json"),
      proposalId: "KB-20300102-010005-aabbccdd",
      root: symlink.root,
      changes,
      preconditions,
      baseCommit: symlink.baseCommit,
    }),
    /uncommitted state and cannot be safely rejected/,
  );
});

test("reject keeps dirty targets closed when the proposal baseline is missing, invalid, or incomplete", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-invalid-baseline-dirty-reject-", {
    "methods/dirty.md": "before\n",
  });
  write(root, "methods/dirty.md", "dirty\n");
  const changes = [{ action: "update", target: "methods/dirty.md", content: "after\n" }];
  for (const preconditions of [
    null,
    {},
    { "methods/dirty.md": { exists: true, sha256: "not-a-sha256" } },
  ]) {
    assert.throws(
      () => assertProposalCanBeRejected({
        appliedPath: path.join(root, ".proposal-state", "missing.json"),
        proposalId: "KB-20300102-010003-aabbccdd",
        root,
        changes,
        preconditions,
        baseCommit,
      }),
      /uncommitted state and cannot be safely rejected/,
    );
  }
});

test("reused WAL binds approval time, restored bytes, mode, and index", async (t) => {
  function setup(t2, suffix) {
    const { root, baseCommit } = createMinimalRepo(t2, `proposal-wal-reuse-${suffix}-`, {
      "methods/reuse.md": "before\n",
    });
    const proposal = {
      id: `KB-20300101-16000${suffix}-aabbccdd`,
      base_commit: baseCommit,
      summary: `WAL reuse ${suffix}`,
      changes: [{ action: "update", target: "methods/reuse.md", content: "after\n" }],
      preconditions: { "methods/reuse.md": { exists: true, sha256: sha256("before\n") } },
    };
    const transactionDir = path.join(root, ".proposal-state", "inflight");
    const approval = { channel: "conversation", message: `批准 ${proposal.id}` };
    const approvedAt = `2030-01-01T16:00:0${suffix}.000Z`;
    beginApplyTransaction({
      root,
      transactionDir,
      proposal,
      approval,
      approvedAt,
      executionParent: baseCommit,
      changes: proposal.changes,
      snapshots: targetSnapshots(root, ["methods/reuse.md"]),
    });
    const recovered = recoverInterruptedApply({ root, transactionDir });
    assert.equal(recovered.status, "restored_precommit");
    return { root, baseCommit, proposal, transactionDir, approval, approvedAt };
  }

  await t.test("approved_at mismatch is rejected without clearing WAL", (t2) => {
    const fixture = setup(t2, "1");
    assert.throws(
      () => beginApplyTransaction({
        root: fixture.root,
        transactionDir: fixture.transactionDir,
        proposal: fixture.proposal,
        approval: fixture.approval,
        approvedAt: "2030-01-01T16:59:59.000Z",
        executionParent: fixture.baseCommit,
        changes: fixture.proposal.changes,
        snapshots: targetSnapshots(fixture.root, ["methods/reuse.md"]),
      }),
      /conflicts with proposal/,
    );
    assert.equal(existsSync(inflightTransactionPath(fixture.transactionDir, fixture.proposal.id)), true);
  });

  await t.test("mode drift after restore is rejected without clearing WAL", (t2) => {
    const fixture = setup(t2, "2");
    chmodSync(path.join(fixture.root, "methods/reuse.md"), 0o755);
    assert.throws(
      () => beginApplyTransaction({
        root: fixture.root,
        transactionDir: fixture.transactionDir,
        proposal: fixture.proposal,
        approval: fixture.approval,
        approvedAt: fixture.approvedAt,
        executionParent: fixture.baseCommit,
        changes: fixture.proposal.changes,
        snapshots: targetSnapshots(fixture.root, ["methods/reuse.md"]),
      }),
      /conflicts with proposal/,
    );
    assert.equal(existsSync(inflightTransactionPath(fixture.transactionDir, fixture.proposal.id)), true);
  });

  await t.test("index drift after restore is rejected without clearing WAL", (t2) => {
    const fixture = setup(t2, "3");
    git(fixture.root, ["update-index", "--chmod=+x", "methods/reuse.md"]);
    assert.throws(
      () => beginApplyTransaction({
        root: fixture.root,
        transactionDir: fixture.transactionDir,
        proposal: fixture.proposal,
        approval: fixture.approval,
        approvedAt: fixture.approvedAt,
        executionParent: fixture.baseCommit,
        changes: fixture.proposal.changes,
        snapshots: targetSnapshots(fixture.root, ["methods/reuse.md"]),
      }),
      /Git index changed before durable apply transaction/,
    );
    assert.equal(existsSync(inflightTransactionPath(fixture.transactionDir, fixture.proposal.id)), true);
  });
});

test("pre-commit WAL proof rejects unrelated and mismatched staged entries", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-staged-proof-", {
    "methods/approved.md": "before\n",
  });
  const proposal = {
    id: "KB-20300101-160004-aabbccdd",
    base_commit: baseCommit,
    summary: "Exact staged proof",
    changes: [{ action: "update", target: "methods/approved.md", content: "after\n" }],
    preconditions: { "methods/approved.md": { exists: true, sha256: sha256("before\n") } },
  };
  const transaction = beginApplyTransaction({
    root,
    transactionDir: path.join(root, ".proposal-state", "inflight"),
    proposal,
    approval: { channel: "conversation", message: `批准 ${proposal.id}` },
    approvedAt: "2030-01-01T16:00:04.000Z",
    executionParent: baseCommit,
    changes: proposal.changes,
    snapshots: targetSnapshots(root, ["methods/approved.md"]),
  });
  write(root, "methods/approved.md", "after\n");
  git(root, ["add", "--", "methods/approved.md"]);
  assert.equal(assertApplyTransactionReadyToCommit({ root, transactionRecord: transaction.record }), true);

  write(root, "methods/unapproved.md", "extra\n");
  git(root, ["add", "--", "methods/unapproved.md"]);
  assert.throws(
    () => assertApplyTransactionReadyToCommit({ root, transactionRecord: transaction.record }),
    /Staged path set no longer matches durable approval/,
  );
  git(root, ["reset", "--quiet", "HEAD", "--", "methods/unapproved.md"]);
  write(root, "methods/approved.md", "wrong\n");
  git(root, ["add", "--", "methods/approved.md"]);
  assert.throws(
    () => assertApplyTransactionReadyToCommit({ root, transactionRecord: transaction.record }),
    /Git index no longer matches durable approval/,
  );
});

test("pre-commit WAL proof requires exact approved final worktree bytes, mode, and existence", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-final-worktree-proof-", {
    "methods/noop.md": "same\n",
  });
  const proposal = {
    id: "KB-20300101-160004-aabbccde",
    base_commit: baseCommit,
    summary: "Exact final worktree proof for no-op",
    changes: [{ action: "update", target: "methods/noop.md", content: "same\n" }],
    preconditions: { "methods/noop.md": { exists: true, sha256: sha256("same\n") } },
  };
  const transaction = beginApplyTransaction({
    root,
    transactionDir: path.join(root, ".proposal-state", "inflight"),
    proposal,
    approval: { channel: "conversation", message: `批准 ${proposal.id}` },
    approvedAt: "2030-01-01T16:00:04.250Z",
    executionParent: baseCommit,
    changes: proposal.changes,
    snapshots: targetSnapshots(root, ["methods/noop.md"]),
  });
  assert.equal(assertApplyTransactionReadyToCommit({ root, transactionRecord: transaction.record }), true);

  write(root, "methods/noop.md", "external bytes\n");
  assert.throws(
    () => assertApplyTransactionReadyToCommit({ root, transactionRecord: transaction.record }),
    /approved final worktree state/,
  );

  write(root, "methods/noop.md", "same\n");
  chmodSync(path.join(root, "methods/noop.md"), 0o755);
  assert.throws(
    () => assertApplyTransactionReadyToCommit({ root, transactionRecord: transaction.record }),
    /approved final worktree state/,
  );

  chmodSync(path.join(root, "methods/noop.md"), 0o644);
  unlinkSync(path.join(root, "methods/noop.md"));
  assert.throws(
    () => assertApplyTransactionReadyToCommit({ root, transactionRecord: transaction.record }),
    /approved final worktree state/,
  );
});

test("pre-commit WAL proof treats a rename as the approved delete and create pair", (t) => {
  const { root, baseCommit } = createMinimalRepo(t, "proposal-staged-rename-proof-", {
    "methods/before.md": "move me\n",
  });
  const proposal = {
    id: "KB-20300101-160004-aabbccee",
    base_commit: baseCommit,
    summary: "Exact staged rename proof",
    changes: [{
      action: "move",
      target: "methods/before.md",
      new_target: "methods/after.md",
    }],
    preconditions: {
      "methods/before.md": { exists: true, sha256: sha256("move me\n") },
      "methods/after.md": { exists: false },
    },
  };
  const transaction = beginApplyTransaction({
    root,
    transactionDir: path.join(root, ".proposal-state", "inflight"),
    proposal,
    approval: { channel: "conversation", message: `批准 ${proposal.id}` },
    approvedAt: "2030-01-01T16:00:04.500Z",
    executionParent: baseCommit,
    changes: proposal.changes,
    snapshots: targetSnapshots(root, ["methods/before.md", "methods/after.md"]),
  });
  renameSync(path.join(root, "methods/before.md"), path.join(root, "methods/after.md"));
  git(root, ["add", "--all", "--", "methods/before.md", "methods/after.md"]);
  assert.equal(assertApplyTransactionReadyToCommit({ root, transactionRecord: transaction.record }), true);
});

test("active commit hooks are detected read-only, including configured hook paths", (t) => {
  const { root } = createMinimalRepo(t, "proposal-hook-gate-");
  const marker = path.join(root, "hook-ran");
  const defaultHook = path.join(root, ".git", "hooks", "pre-commit");
  writeFileSync(defaultHook, `#!/bin/sh\nprintf ran >> '${marker}'\n`, "utf8");
  chmodSync(defaultHook, 0o755);
  assert.throws(
    () => assertNoActiveCommitHooks({ root }),
    /Active Git commit hooks .* pre-commit/,
  );
  assert.equal(existsSync(marker), false);

  chmodSync(defaultHook, 0o644);
  assert.equal(assertNoActiveCommitHooks({ root }), true);
  git(root, ["config", "core.hooksPath", ".custom-hooks"]);
  const customHook = path.join(root, ".custom-hooks", "post-index-change");
  mkdirSync(path.dirname(customHook), { recursive: true });
  writeFileSync(customHook, `#!/bin/sh\nprintf ran >> '${marker}'\n`, "utf8");
  chmodSync(customHook, 0o755);
  assert.throws(
    () => assertNoActiveCommitHooks({ root }),
    /Active Git commit hooks .* post-index-change/,
  );
  assert.equal(existsSync(marker), false);
});

test("durable approval rejects control-character targets before WAL creation", async (t) => {
  for (const [label, target] of [["newline", "methods/a\nb.md"], ["tab", "methods/a\tb.md"]]) {
    await t.test(label, (t2) => {
      const { root, baseCommit } = createMinimalRepo(t2, `proposal-control-${label}-`);
      const transactionDir = path.join(root, ".proposal-state", "inflight");
      const proposal = {
        id: label === "newline"
          ? "KB-20300101-160005-aabbccdd"
          : "KB-20300101-160006-aabbccdd",
        base_commit: baseCommit,
        summary: `Reject ${label}`,
        changes: [{ action: "create", target, content: "unsafe\n" }],
        preconditions: { [target]: { exists: false } },
      };
      assert.throws(
        () => beginApplyTransaction({
          root,
          transactionDir,
          proposal,
          approval: { channel: "conversation", message: `批准 ${proposal.id}` },
          approvedAt: "2030-01-01T16:00:05.000Z",
          executionParent: baseCommit,
          changes: proposal.changes,
          snapshots: new Map([[target, { exists: false }]]),
        }),
        /unsafe target path/,
      );
      assert.equal(existsSync(transactionDir), false);
    });
  }
});

test("Git content transforms fail before WAL or target mutation", async (t) => {
  async function transformedFixture(t2, suffix, attributes) {
    const { root } = createMinimalRepo(t2, `proposal-transform-${suffix}-`, {
      "methods/value.md": "before\n",
    });
    write(root, ".gitattributes", attributes);
    git(root, ["add", ".gitattributes"]);
    git(root, ["commit", "-m", `attributes ${suffix}`]);
    const baseCommit = git(root, ["rev-parse", "HEAD"]);
    const proposal = {
      id: `KB-20300101-16000${suffix}-bbccddee`,
      base_commit: baseCommit,
      summary: `Reject transform ${suffix}`,
      changes: [{ action: "update", target: "methods/value.md", content: "after\n" }],
      preconditions: { "methods/value.md": { exists: true, sha256: sha256("before\n") } },
    };
    const transactionDir = path.join(root, ".proposal-state", "inflight");
    assert.throws(
      () => beginApplyTransaction({
        root,
        transactionDir,
        proposal,
        approval: { channel: "conversation", message: `批准 ${proposal.id}` },
        approvedAt: "2030-01-01T16:00:07.000Z",
        executionParent: baseCommit,
        changes: proposal.changes,
        snapshots: targetSnapshots(root, ["methods/value.md"]),
      }),
      /Git attribute .* transforms approved bytes/,
    );
    assert.equal(existsSync(transactionDir), false);
    assert.equal(readFileSync(path.join(root, "methods/value.md"), "utf8"), "before\n");
  }

  await t.test("EOL normalization", (t2) => transformedFixture(t2, "7", "methods/value.md text eol=crlf\n"));
  await t.test("clean filter declaration", (t2) => transformedFixture(t2, "8", "methods/value.md filter=external\n"));
  await t.test("core.autocrlf", (t2) => {
    const { root, baseCommit } = createMinimalRepo(t2, "proposal-transform-autocrlf-", {
      "methods/value.md": "before\n",
    });
    git(root, ["config", "core.autocrlf", "true"]);
    const proposal = {
      id: "KB-20300101-160009-bbccddee",
      base_commit: baseCommit,
      summary: "Reject autocrlf",
      changes: [{ action: "update", target: "methods/value.md", content: "after\n" }],
      preconditions: { "methods/value.md": { exists: true, sha256: sha256("before\n") } },
    };
    const transactionDir = path.join(root, ".proposal-state", "inflight");
    assert.throws(
      () => beginApplyTransaction({
        root,
        transactionDir,
        proposal,
        approval: { channel: "conversation", message: `批准 ${proposal.id}` },
        approvedAt: "2030-01-01T16:00:09.000Z",
        executionParent: baseCommit,
        changes: proposal.changes,
        snapshots: targetSnapshots(root, ["methods/value.md"]),
      }),
      /core.autocrlf must be disabled/,
    );
    assert.equal(existsSync(transactionDir), false);
  });
});

test("proposal commit subjects truncate by Unicode code point and recover legacy replacement subjects", async (t) => {
  const summary = `${"a".repeat(59)}😀尾`;
  const expected = `Knowledge: ${"a".repeat(59)}😀`;
  assert.equal(proposalCommitSubject({ summary }), expected);
  assert.equal([...proposalCommitSubject({ summary }).slice("Knowledge: ".length)].length, 60);

  await t.test("new subject commits and verifies exactly", (t2) => {
    const { root, baseCommit } = createMinimalRepo(t2, "proposal-unicode-subject-new-", {
      "methods/emoji.md": "before\n",
    });
    const proposal = {
      id: "KB-20300101-160010-aabbccdd",
      base_commit: baseCommit,
      summary,
      changes: [{ action: "update", target: "methods/emoji.md", content: "after\n" }],
      preconditions: { "methods/emoji.md": { exists: true, sha256: sha256("before\n") } },
    };
    write(root, "methods/emoji.md", "after\n");
    git(root, ["add", "methods/emoji.md"]);
    git(root, ["commit", "-m", proposalCommitSubject(proposal)]);
    assert.equal(git(root, ["show", "-s", "--format=%s", "HEAD"]), expected);
    assert.equal(detectExactCommittedProposal({ root, proposal, changes: proposal.changes }).matched, true);
  });

  await t.test("legacy replacement-character subject remains detectable", (t2) => {
    const { root, baseCommit } = createMinimalRepo(t2, "proposal-unicode-subject-legacy-", {
      "methods/emoji.md": "before\n",
    });
    const proposal = {
      id: "KB-20300101-160011-aabbccdd",
      base_commit: baseCommit,
      summary,
      changes: [{ action: "update", target: "methods/emoji.md", content: "after\n" }],
      preconditions: { "methods/emoji.md": { exists: true, sha256: sha256("before\n") } },
    };
    write(root, "methods/emoji.md", "after\n");
    git(root, ["add", "methods/emoji.md"]);
    git(root, ["commit", "-m", `Knowledge: ${"a".repeat(59)}�`]);
    assert.equal(detectExactCommittedProposal({ root, proposal, changes: proposal.changes }).matched, true);
  });
});

test("rejection receipt is durable, compatible, and idempotently finalizable", (t) => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-rejected-receipt-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const proposal = { id: "KB-20300101-160012-aabbccdd", changes: [] };
  const pendingRecord = { proposal, sha256: proposalHash(proposal) };
  const rejectedRecord = {
    ...pendingRecord,
    rejected_at: "2030-01-01T16:00:12.000Z",
    rejection: { channel: "conversation", message: "拒绝，保留第一条理由" },
  };
  const pendingPath = path.join(stateRoot, "pending.json");
  const rejectedPath = path.join(stateRoot, "rejected.json");
  writeFileSync(pendingPath, `${JSON.stringify(pendingRecord)}\n`);
  const created = writeRejectedProposalReceipt({ rejectedPath, rejectedRecord });
  assert.equal(created.created, true);
  assert.deepEqual(readRejectedProposalArchive({
    rejectedPath,
    expectedRecord: pendingRecord,
    proposalId: proposal.id,
  }), rejectedRecord);
  const retried = writeRejectedProposalReceipt({ rejectedPath, rejectedRecord });
  assert.equal(retried.created, false);
  const finalized = finalizeRejectedProposalArchive({ pendingPath, rejectedPath, rejectedRecord });
  assert.equal(finalized.created, false);
  assert.equal(existsSync(pendingPath), false);
  assert.deepEqual(readRejectedProposalArchive({ rejectedPath, proposalId: proposal.id }), rejectedRecord);
  assert.throws(
    () => writeRejectedProposalReceipt({
      rejectedPath,
      rejectedRecord: {
        ...rejectedRecord,
        rejection: { channel: "conversation", message: "替换理由" },
      },
    }),
    /Rejected proposal archive conflicts/,
  );
});

test("all 86 legacy applied archives replay without execution_parent and preserve bytes", (t) => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-legacy-86-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  for (let index = 0; index < 86; index += 1) {
    const proposal = { id: `KB-20300101-17${String(index).padStart(4, "0")}-${String(index).padStart(8, "0")}` };
    const legacy = {
      proposal,
      sha256: proposalHash(proposal),
      approved_at: `2030-01-01T17:${String(index % 60).padStart(2, "0")}:00.000Z`,
      approval: { channel: "conversation", message: `批准 ${proposal.id}` },
      git_commit: "e".repeat(40),
      index_status: "synchronized",
      ...(index >= 29 ? { commit_created: true } : {}),
    };
    const appliedPath = path.join(stateRoot, `applied-${index}.json`);
    const pendingPath = path.join(stateRoot, `pending-${index}.json`);
    const bytes = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(appliedPath, bytes);
    writeFileSync(pendingPath, "pending\n");
    const read = readAppliedCommitReceipt({ appliedPath, proposalId: proposal.id });
    assert.deepEqual(read, legacy);
    const finalized = finalizeAppliedArchive({ pendingPath, appliedPath, appliedRecord: read });
    assert.deepEqual(finalized.record, legacy);
    assert.equal(existsSync(pendingPath), false);
    assert.equal(readFileSync(appliedPath, "utf8"), bytes);
  }
});

test("terminal archive parse failures report conflict without null dereference", (t) => {
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), "proposal-terminal-invalid-"));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  const appliedPath = path.join(stateRoot, "invalid.json");
  writeFileSync(appliedPath, "not json\n");
  assert.throws(
    () => readAppliedCommitReceipt({
      appliedPath,
      proposalId: "KB-20300101-160013-aabbccdd",
    }),
    /Applied proposal archive conflicts with pending state: unknown/,
  );
});
