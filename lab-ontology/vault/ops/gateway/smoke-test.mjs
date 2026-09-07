#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_VAULT = path.resolve(HERE, "../..");
const SMOKE_ROOT = mkdtempSync(path.join(os.tmpdir(), "agent-knowledge-smoke-"));
const FIXTURE_ROOT = path.join(SMOKE_ROOT, "vault");
const FIXTURE_GATEWAY = path.join(FIXTURE_ROOT, "ops/gateway");
const STATE_ROOT = path.join(SMOKE_ROOT, "state");
const PROPOSAL_ROOT = path.join(STATE_ROOT, "proposals");
const METHOD_SLUG = "methods/greenhouse-watering-checklist";
const METHOD_PATH = `${METHOD_SLUG}.md`;
const SOURCE_SLUG = "sources/greenhouse-observation";

const page = ({ type, title, status, scope, extra = "", body }) => `---
type: ${type}
title: ${title}
aliases: []
tags: [synthetic-fixture]
created: 2026-01-01
updated: 2026-01-01
status: ${status}
retrieval_scope: ${scope}
agent_priority: normal
domain: synthetic-example
evidence_status: synthetic
owner: fixture
modules: []
${extra}---
# ${title}

${body}
`;

function copyFixtureVault() {
  cpSync(SOURCE_VAULT, FIXTURE_ROOT, {
    recursive: true,
    filter(source) {
      const relative = path.relative(SOURCE_VAULT, source);
      return !relative.split(path.sep).includes("node_modules")
        && relative !== "index.md";
    },
  });
  symlinkSync(path.join(HERE, "node_modules"), path.join(FIXTURE_GATEWAY, "node_modules"), "dir");
  const write = (relative, content) => {
    const absolute = path.join(FIXTURE_ROOT, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  write(METHOD_PATH, page({
    type: "methodology",
    title: "温室浇水检查清单",
    status: "active",
    scope: "result",
    extra: "related: [\"[[concepts/example-feedback-loop]]\"]\nevidence: []\nmaturity: seed\n",
    body: "按土壤湿度、天气与植物阶段安排浇水。",
  }));
  write("concepts/example-feedback-loop.md", page({
    type: "concept",
    title: "示例反馈循环",
    status: "active",
    scope: "result",
    extra: `related: [\"[[${METHOD_SLUG}]]\"]\nevidence: []\nmaturity: seed\n`,
    body: "执行、观察、调整，再进入下一轮。",
  }));
  write(`${SOURCE_SLUG}.md`, page({
    type: "source",
    title: "温室观察记录",
    status: "evidence",
    scope: "evidence",
    extra: "derived_pages: []\nsource_format: synthetic\nsource_family: synthetic-fixture\nprovenance_class: external\nmaturity: seed\nraw_refs: []\nallowed_uses: [experiment_hypothesis]\ndisallowed_uses: [default_answer, operational_decision, public_factual_claim]\nscope: [greenhouse observation]\nfailure_conditions: [no direct observation]\n",
    body: `这是一条仅用于公开测试的合成观察。

## Claims

### C-01

- 陈述：土壤湿度可以作为浇水实验的一个观察变量。
- 类型：待验证假设
- 直接依据：
  - synthetic-observation-1
- 样本量：1
- 利益关系：无商业利益关系。
- 允许用途：
  - experiment_hypothesis
- 禁止用途：
  - default_answer
  - operational_decision
  - public_factual_claim
- 反证： []
- 证据缺口：
  - 尚无重复观察
- 适用范围：
  - greenhouse observation
- 失效条件：
  - no direct observation
- 下一步验证：
  - 在独立温室中重复观察`,
  }));
  const git = (...args) => execFileSync("git", args, {
    cwd: FIXTURE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q");
  git("config", "user.name", "Smoke Fixture");
  git("config", "user.email", "smoke@example.invalid");
  git("add", ".");
  git("commit", "-qm", "synthetic fixture");
  return git("rev-parse", "HEAD");
}

function payload(toolResult) {
  const text = toolResult.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Tool returned no text payload.");
  return JSON.parse(text);
}

function proposalStatePath(state, proposalId) {
  return path.join(PROPOSAL_ROOT, state, `${proposalId}.json`);
}

const requiredTools = [
  "knowledge_intake",
  "knowledge_route",
  "knowledge_search",
  "knowledge_get",
  "knowledge_list",
  "knowledge_related",
  "knowledge_schema",
  "knowledge_repair_index",
  "knowledge_propose_changes",
  "knowledge_list_proposals",
  "knowledge_get_proposal",
  "knowledge_reject_proposal",
  "knowledge_apply_proposal",
].sort();

let client;
try {
  const currentCommit = copyFixtureVault();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(FIXTURE_GATEWAY, "server.mjs")],
    env: { ...process.env, AGENT_KNOWLEDGE_STATE_DIR: STATE_ROOT },
  });
  client = new Client({ name: "agent-knowledge-gateway-smoke-test", version: "1.8.0" });
  await client.connect(transport);

  const listed = await client.listTools();
  const actualTools = listed.tools.map(({ name }) => name).sort();
  assertEqual(actualTools, requiredTools, "Gateway tool surface changed");

  const intake = payload(await client.callTool({
    name: "knowledge_intake",
    arguments: { user_request: "保存一条合成知识" },
  }));
  if (intake.destination?.vault_path !== realpathSync(FIXTURE_ROOT)
    || !intake.next_step?.includes("knowledge_propose_changes")) {
    throw new Error(`Knowledge intake did not return the active proposal contract: ${JSON.stringify(intake)}`);
  }

  const schema = payload(await client.callTool({ name: "knowledge_schema", arguments: {} }));
  if (schema.source_commit !== currentCommit
    || schema.gateway_runtime?.version !== "1.8.0"
    || schema.retrieval_status?.policy?.active_backend !== "native"
    || schema.retrieval_status?.policy?.fallback_backend !== "local_markdown_keyword"
    || schema.gateway_runtime?.trust_core?.mode !== "shadow"
    || schema.gateway_runtime?.trust_core?.enforced !== false
    || schema.gateway_runtime?.proposal_state_root !== PROPOSAL_ROOT
    || schema.gateway_runtime?.lock_root !== path.join(STATE_ROOT, "locks")
    || schema.navigation_index?.status !== "ready"
    || schema.navigation_index?.page_count !== 3) {
    throw new Error(`Unexpected runtime contract: ${JSON.stringify(schema)}`);
  }

  const search = payload(await client.callTool({
    name: "knowledge_search",
    arguments: { query: "温室浇水", scope: "result", limit: 5 },
  }));
  if (search.retrieval?.served_by !== "local_markdown_keyword"
    || search.retrieval?.expected_git_commit !== currentCommit
    || search.retrieval?.fallback_chain?.[0]?.backend !== "native"
    || search.results?.[0]?.slug !== METHOD_SLUG
    || search.results.some(({ type }) => type === "source")) {
    throw new Error(`Same-commit Markdown fallback failed: ${JSON.stringify(search)}`);
  }

  const routed = payload(await client.callTool({
    name: "knowledge_route",
    arguments: { query: "请使用温室浇水检查清单", limit: 5 },
  }));
  if (routed.action !== "read" || routed.selected?.[0]?.slug !== METHOD_SLUG) {
    throw new Error(`Exact-title route failed: ${JSON.stringify(routed)}`);
  }

  const blockedSource = await client.callTool({
    name: "knowledge_get",
    arguments: { slug: SOURCE_SLUG, scope: "result" },
  });
  if (!blockedSource.isError) throw new Error("Result scope did not block an evidence page.");

  const read = payload(await client.callTool({
    name: "knowledge_get",
    arguments: { slug: METHOD_SLUG, scope: "result" },
  }));
  if (read.page?.slug !== METHOD_SLUG) {
    throw new Error(`Committed result read failed: ${JSON.stringify(read)}`);
  }

  const trustRead = payload(await client.callTool({
    name: "knowledge_get",
    arguments: {
      slug: SOURCE_SLUG,
      scope: "evidence",
      trust_context: {
        intended_use: "default_answer",
        risk_level: "ordinary",
        claim_id: "C-01",
        scope: ["greenhouse observation"],
      },
    },
  }));
  if (trustRead.page?.slug !== SOURCE_SLUG
    || trustRead.trust_shadow?.mode !== "shadow"
    || trustRead.trust_shadow?.enforced !== false
    || trustRead.trust_shadow?.blocking !== false
    || trustRead.trust_shadow?.status !== "evaluated"
    || trustRead.trust_shadow?.engine?.policy_id !== "knowledge-trust-default"
    || trustRead.trust_shadow?.verdict?.decision !== "deny") {
    throw new Error(`TrustCore shadow contract failed: ${JSON.stringify(trustRead)}`);
  }

  const list = payload(await client.callTool({
    name: "knowledge_list",
    arguments: { scope: "result", limit: 100 },
  }));
  if (list.pages?.length !== 2 || list.pages.some(({ type }) => type === "source")) {
    throw new Error("Result listing did not preserve scope isolation.");
  }

  const methodBytes = readFileSync(path.join(FIXTURE_ROOT, METHOD_PATH), "utf8");
  const pendingBeforeInvalid = payload(await client.callTool({
    name: "knowledge_list_proposals",
    arguments: {},
  })).proposals.length;
  const invalidProposalResponse = await client.callTool({
    name: "knowledge_propose_changes",
    arguments: {
      summary: "Synthetic invalid proposal preflight",
      rationale: "Verify invalid candidate bytes never reach the approval queue.",
      origin: "background",
      proposed_by: "gateway-smoke-test",
      changes: [{
        action: "update",
        target: METHOD_PATH,
        content: "---\ntype: methodology\ntitle: Broken\ntags: [broken\n---\n# Broken\n",
      }],
    },
  });
  const invalidProposal = payload(invalidProposalResponse);
  const pendingAfterInvalid = payload(await client.callTool({
    name: "knowledge_list_proposals",
    arguments: {},
  })).proposals.length;
  if (!invalidProposalResponse.isError
    || invalidProposal.error_code !== "PROPOSAL_PREFLIGHT_FAILED"
    || invalidProposal.stage !== "proposal_preflight"
    || pendingAfterInvalid !== pendingBeforeInvalid) {
    throw new Error(`Invalid proposal reached the queue or lost its diagnostic: ${JSON.stringify(invalidProposal)}`);
  }
  const proposed = payload(await client.callTool({
    name: "knowledge_propose_changes",
    arguments: {
      summary: "Synthetic smoke proposal",
      rationale: "Verify exact proposals without changing the fixture repository.",
      origin: "background",
      proposed_by: "gateway-smoke-test",
      changes: [{ action: "update", target: METHOD_PATH, content: methodBytes }],
    },
  }));
  const pendingPath = proposalStatePath("pending", proposed.proposal_id);
  if (proposed.knowledge_modified !== false || !existsSync(pendingPath)) {
    throw new Error("Proposal creation changed knowledge or did not persist the proposal.");
  }
  if (proposed.preflight?.status !== "passed"
    || proposed.preflight?.scope !== "exact_candidate_tree"
    || proposed.preflight?.gateway_version !== "1.8.0"
    || proposed.preflight?.base_commit !== currentCommit) {
    throw new Error(`Proposal did not return its exact candidate preflight receipt: ${JSON.stringify(proposed.preflight)}`);
  }
  const exact = payload(await client.callTool({
    name: "knowledge_get_proposal",
    arguments: { proposal_id: proposed.proposal_id },
  }));
  if (exact.proposal?.changes?.[0]?.content !== methodBytes
    || exact.proposal?.preconditions?.[METHOD_PATH]?.exists !== true) {
    throw new Error("Exact proposal review lost content or its committed baseline.");
  }
  const blockedApply = await client.callTool({
    name: "knowledge_apply_proposal",
    arguments: { proposal_id: proposed.proposal_id },
  });
  if (!blockedApply.isError || !existsSync(pendingPath)) {
    throw new Error("Apply gate accepted a proposal without explicit approval.");
  }
  const rejected = payload(await client.callTool({
    name: "knowledge_reject_proposal",
    arguments: {
      proposal_id: proposed.proposal_id,
      user_rejected: true,
      rejection_message: "Synthetic smoke cleanup.",
    },
  }));
  if (!rejected.rejected || rejected.knowledge_modified !== false || existsSync(pendingPath)) {
    throw new Error("Proposal rejection did not archive safely.");
  }

  const digest = JSON.parse(execFileSync(
    process.execPath,
    [path.join(FIXTURE_GATEWAY, "proposal-digest.mjs"), "--json"],
    { encoding: "utf8", env: { ...process.env, AGENT_KNOWLEDGE_STATE_DIR: STATE_ROOT } },
  ));
  if (digest.pending_count !== 0) throw new Error("Proposal digest retained rejected work.");

  console.log(JSON.stringify({
    ok: true,
    tools: actualTools.length,
    source_commit: currentCommit,
    navigation_pages: schema.navigation_index.page_count,
    retrieval: {
      configured: search.retrieval.configured,
      served_by: search.retrieval.served_by,
      status: search.retrieval.status,
      fallback_chain: search.retrieval.fallback_chain,
    },
    trust_shadow: {
      mode: trustRead.trust_shadow.mode,
      blocking: trustRead.trust_shadow.blocking,
      enforced: trustRead.trust_shadow.enforced,
      status: trustRead.trust_shadow.status,
    },
    proposal_preflight_before_queue: "passed",
    proposal_gate: "passed",
  }, null, 2));
} finally {
  if (client) await client.close().catch(() => {});
  rmSync(SMOKE_ROOT, { recursive: true, force: true });
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
