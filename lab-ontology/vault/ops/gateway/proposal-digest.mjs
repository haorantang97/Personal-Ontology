#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const PENDING_DIR = path.join(
  os.homedir(),
  ".gbrain",
  "change-proposals",
  "pending",
);
const ID_PATTERN = /^KB-\d{8}-\d{6}-[a-f0-9]{8}$/;

function proposalHash(proposal) {
  return createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
}

function readRecord(file) {
  const record = JSON.parse(readFileSync(file, "utf8"));
  const id = record.proposal?.id;
  if (!id || !ID_PATTERN.test(id)) {
    throw new Error(`Invalid proposal id in ${file}`);
  }
  if (record.sha256 !== proposalHash(record.proposal)) {
    throw new Error(`Proposal integrity check failed: ${id}`);
  }
  return record;
}

function listPending() {
  if (!existsSync(PENDING_DIR)) return [];
  return readdirSync(PENDING_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readRecord(path.join(PENDING_DIR, name)));
}

function summarize(record) {
  const proposal = record.proposal;
  return {
    id: proposal.id,
    created_at: proposal.created_at,
    origin: proposal.origin ?? "conversation",
    proposed_by: proposal.proposed_by ?? null,
    context: proposal.context ?? null,
    summary: proposal.summary,
    rationale: proposal.rationale,
    change_count: proposal.changes.length,
    changes: proposal.changes.map((change) => ({
      action: change.action,
      target: change.target,
      new_target: change.new_target ?? null,
    })),
    sha256: record.sha256,
  };
}

function renderDigest(proposals) {
  if (proposals.length === 0) return "No pending knowledge proposals.";
  const lines = [`Pending knowledge proposals: ${proposals.length}`];
  for (const proposal of proposals) {
    lines.push(
      "",
      `[${proposal.id}] ${proposal.summary}`,
      `origin=${proposal.origin} proposed_by=${proposal.proposed_by ?? "unknown"} created_at=${proposal.created_at}`,
      proposal.rationale,
    );
    for (const change of proposal.changes) {
      lines.push(
        `- ${change.action} ${change.target}${change.new_target ? ` -> ${change.new_target}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const fullIndex = args.indexOf("--full");
const records = listPending();

if (fullIndex >= 0) {
  const id = args[fullIndex + 1];
  if (!id || !ID_PATTERN.test(id)) {
    throw new Error("Usage: proposal-digest.mjs --full <proposal-id> [--json]");
  }
  const record = records.find((candidate) => candidate.proposal.id === id);
  if (!record) throw new Error(`Pending proposal not found: ${id}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    pending_count: records.length,
    proposal: record.proposal,
    sha256: record.sha256,
  }, null, 2)}\n`);
} else {
  const proposals = records.map(summarize);
  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      pending_count: proposals.length,
      proposals,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderDigest(proposals)}\n`);
  }
}
