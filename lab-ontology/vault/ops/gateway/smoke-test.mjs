#!/usr/bin/env node

import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const resultDirectories = new Set([
  "projects",
  "decisions",
  "methods",
  "syntheses",
  "concepts",
]);
const expectedResultCount = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", "HEAD"],
  { cwd: ROOT, encoding: "utf8" },
)
  .split("\n")
  .filter((name) => {
    const [directory] = name.split("/");
    return resultDirectories.has(directory) && name.endsWith(".md");
  }).length;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(HERE, "server.mjs")],
});
const client = new Client({
  name: "agent-knowledge-gateway-smoke-test",
  version: "1.6.0",
});
let smokeProposalFile;
let smokeRejectedFile;
let staleProposalFile;
let staleRejectedFile;
let uiProposalFile;
let uiRejectedFile;

function payload(toolResult) {
  const text = toolResult.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("Tool returned no text payload.");
  return JSON.parse(text);
}

// Search cases are vault-specific: each entry is [query, expected result slug].
// They live in smoke-cases.json next to this file (override with SMOKE_CASES=<path>)
// so the test can be pointed at any populated vault without editing code.
const casesPath = process.env.SMOKE_CASES
  ? path.resolve(process.env.SMOKE_CASES)
  : path.join(HERE, "smoke-cases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
if (!Array.isArray(cases) || cases.some((entry) => !Array.isArray(entry) || entry.length !== 2)) {
  throw new Error(`${casesPath} must be a JSON array of [query, expectedSlug] pairs.`);
}

try {
  await client.connect(transport);
  const listedTools = await client.listTools();
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
  ];
  for (const name of requiredTools) {
    if (!listedTools.tools.some((tool) => tool.name === name)) {
      throw new Error(`Missing MCP tool: ${name}`);
    }
  }

  const intake = payload(
    await client.callTool({
      name: "knowledge_intake",
      arguments: { user_request: "把这个附件录入知识库" },
    }),
  );
  if (
    intake.destination?.application !== "Obsidian"
    || intake.destination?.vault_path !== path.resolve(HERE, "../..")
    || !intake.schema_contract?.includes("## 页面类型")
    || !intake.agent_rules?.includes("## 2. 写入审批")
    || !intake.next_step?.includes("knowledge_propose_changes")
  ) {
    throw new Error("Knowledge intake did not return the complete active contract.");
  }

  const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const indexRepair = payload(
    await client.callTool({
      name: "knowledge_repair_index",
      arguments: { force_full: false },
    }, undefined, { timeout: 900_000 }),
  );
  if (
    indexRepair.knowledge_modified !== false
    || indexRepair.git_modified !== false
    || indexRepair.index_commit !== currentCommit
    || indexRepair.unembedded_chunks !== 0
  ) {
    throw new Error("Index repair did not verify the current Git-backed index.");
  }

  const evaluations = [];
  for (const [query, expected] of cases) {
    const response = await client.callTool({
      name: "knowledge_search",
      arguments: { query, scope: "result", limit: 5 },
    });
    if (response.isError) throw new Error(`Search failed: ${query}`);
    const data = payload(response);
    if (data.results.some((item) => item.type === "source")) {
      throw new Error(`Default result scope leaked a source page: ${query}`);
    }
    const rank = data.results.findIndex((item) => item.slug === expected) + 1;
    if (rank < 1 || rank > 3) {
      throw new Error(`Expected '${expected}' in top 3 for '${query}', got rank ${rank || "none"}.`);
    }
    evaluations.push({ query, expected, rank, top: data.results[0]?.slug });
  }

  const routeGitBefore = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const routeEvaluations = [];
  const routeCases = [
    {
      query: "推荐上海适合生日聚餐的餐厅",
      expected: [
        "methods/shanghai-restaurant-scenario-index-model",
        "syntheses/urban-restaurant-decision-system",
      ],
    },
    {
      query: "Hermes 的 Dashboard 应该负责什么，运行时应该放在哪里",
      expected: ["projects/hermes-agent-workbench"],
    },
    {
      query: "根据我的经历帮我写一份简历",
      expected: ["projects/career-experience-evidence-ledger"],
    },
  ];
  for (const routeCase of routeCases) {
    const routed = payload(await client.callTool({
      name: "knowledge_route",
      arguments: { query: routeCase.query, limit: 5 },
    }, undefined, { timeout: 300_000 }));
    const selectedSlugs = routed.selected?.map((item) => item.slug) || [];
    if (
      routed.action !== "read"
      || !routeCase.expected.some((slug) => selectedSlugs.includes(slug))
      || !/^kr-[a-f0-9]{16}$/.test(routed.trace_id || "")
    ) {
      throw new Error(
        `Knowledge route missed '${routeCase.query}': ${JSON.stringify(routed)}`,
      );
    }
    if ([...(routed.selected || []), ...(routed.candidates || [])]
      .some((item) => item.type === "source" || item.slug?.startsWith("sources/"))) {
      throw new Error(`Knowledge route leaked evidence scope: ${routeCase.query}`);
    }
    routeEvaluations.push({
      query: routeCase.query,
      action: routed.action,
      selected: selectedSlugs,
      retrieval: routed.retrieval,
    });
  }

  const negativeRouteQueries = [
    "2+2 等于多少？",
    "把这句话翻译成英文。",
    "写一个邮箱正则表达式。",
    "上海明天天气怎么样？",
    "解释 QCD 渐近自由。",
    "今天美元兑人民币汇率是多少",
    "如何判断销售候选人的能力",
  ];
  for (const query of negativeRouteQueries) {
    const routed = payload(await client.callTool({
      name: "knowledge_route",
      arguments: { query, limit: 5 },
    }, undefined, { timeout: 300_000 }));
    if (routed.action === "read") {
      throw new Error(`Negative route produced an automatic read for '${query}': ${JSON.stringify(routed)}`);
    }
    routeEvaluations.push({
      query,
      action: routed.action,
      selected: routed.selected?.map((item) => item.slug) || [],
      retrieval: routed.retrieval,
    });
  }
  const routeGitAfter = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (routeGitAfter !== routeGitBefore) {
    throw new Error("knowledge_route changed the Git worktree.");
  }

  const resultList = payload(
    await client.callTool({
      name: "knowledge_list",
      arguments: { scope: "result", limit: 100 },
    }),
  );
  if (
    resultList.pages.length !== expectedResultCount
    || resultList.pages.some((page) => page.type === "source")
  ) {
    throw new Error(
      `Result list must contain all ${expectedResultCount} current non-source pages.`,
    );
  }

  const blockedSource = await client.callTool({
    name: "knowledge_get",
    arguments: {
      slug: "sources/2024-06-30-douyin-he-laoshi-short-video-ip",
      scope: "result",
    },
  });
  if (!blockedSource.isError) throw new Error("Result scope did not block a source page.");

  const schema = payload(
    await client.callTool({ name: "knowledge_schema", arguments: {} }),
  );
  if (schema.active_pack.pack_name !== "agent-decision-memory") {
    throw new Error("Unexpected active schema pack.");
  }
  if (
    schema.gateway_runtime?.version !== "1.6.0"
    || schema.gateway_runtime?.target_scoped_apply !== true
    || schema.gateway_runtime?.clean_worktree_validation_and_indexing !== true
  ) {
    throw new Error("Gateway did not report the target-scoped apply runtime.");
  }

  const moduleSearch = payload(
    await client.callTool({
      name: "knowledge_search",
      arguments: { query: "企业 AI 交付", scope: "result", module: "fde", limit: 5 },
    }, undefined, { timeout: 300_000 }),
  );
  if (moduleSearch.module !== "fde" || !Array.isArray(moduleSearch.results)) {
    throw new Error("Module-aware global search did not accept the module hint.");
  }

  const proposalResponse = await client.callTool({
    name: "knowledge_propose_changes",
    arguments: {
      summary: "Gateway smoke-test proposal",
      rationale: "Verify that proposals are queued without changing the knowledge repository.",
      origin: "background",
      proposed_by: "gateway-smoke-test",
      context: "Automated approval-inbox verification.",
      changes: [
        {
          action: "update",
          target: "methods/short-video-user-judgment-model.md",
          content: readFileSync(
            path.resolve(HERE, "../../methods/short-video-user-judgment-model.md"),
            "utf8",
          ),
        },
      ],
    },
  });
  if (proposalResponse.isError) throw new Error("Proposal creation failed.");
  const proposal = payload(proposalResponse);
  if (proposal.knowledge_modified !== false) {
    throw new Error("Proposal creation unexpectedly modified knowledge.");
  }
  smokeProposalFile = path.join(
    os.homedir(),
    ".gbrain",
    "change-proposals",
    "pending",
    `${proposal.proposal_id}.json`,
  );
  if (!existsSync(smokeProposalFile)) throw new Error("Pending proposal file was not created.");

  const uiArtifact = "未命名.canvas";
  if (existsSync(path.join(ROOT, uiArtifact))) {
    const uiResponse = payload(
      await client.callTool({
        name: "knowledge_propose_changes",
        arguments: {
          summary: "Gateway UI-artifact deletion smoke test",
          rationale: "Verify that an exact proposal may target a root Obsidian Canvas for deletion.",
          origin: "background",
          proposed_by: "gateway-smoke-test",
          changes: [{ action: "delete", target: uiArtifact }],
        },
      }),
    );
    uiProposalFile = path.join(
      os.homedir(),
      ".gbrain",
      "change-proposals",
      "pending",
      `${uiResponse.proposal_id}.json`,
    );
    if (!existsSync(uiProposalFile)) {
      throw new Error("Root Obsidian UI-artifact proposal was not created.");
    }
    const uiRejected = payload(
      await client.callTool({
        name: "knowledge_reject_proposal",
        arguments: {
          proposal_id: uiResponse.proposal_id,
          user_rejected: true,
          rejection_message: "Smoke-test cleanup; the real deletion remains separately approval-gated.",
        },
      }),
    );
    if (!uiRejected.rejected || existsSync(uiProposalFile)) {
      throw new Error("Root Obsidian UI-artifact proposal cleanup failed.");
    }
    uiProposalFile = undefined;
    uiRejectedFile = path.join(
      os.homedir(),
      ".gbrain",
      "change-proposals",
      "rejected",
      `${uiResponse.proposal_id}.json`,
    );
    unlinkSync(uiRejectedFile);
    uiRejectedFile = undefined;
  }
  const pending = payload(
    await client.callTool({ name: "knowledge_list_proposals", arguments: {} }),
  );
  const listedProposal = pending.proposals.find((item) => item.id === proposal.proposal_id);
  if (!listedProposal || listedProposal.origin !== "background") {
    throw new Error("Pending proposal was not listed.");
  }
  const exact = payload(
    await client.callTool({
      name: "knowledge_get_proposal",
      arguments: { proposal_id: proposal.proposal_id },
    }),
  );
  if (
    exact.proposal.proposed_by !== "gateway-smoke-test"
    || !exact.proposal.changes[0]?.content
  ) {
    throw new Error("Exact proposal review did not return the full proposal.");
  }
  const expectedBaseline =
    exact.proposal.preconditions?.["methods/short-video-user-judgment-model.md"];
  if (
    !exact.proposal.base_commit
    || expectedBaseline?.exists !== true
    || !/^[a-f0-9]{64}$/.test(expectedBaseline.sha256 || "")
  ) {
    throw new Error("Proposal did not capture a valid content baseline.");
  }
  const digest = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(HERE, "proposal-digest.mjs"), "--json"],
      { encoding: "utf8" },
    ),
  );
  if (!digest.proposals.some((item) => item.id === proposal.proposal_id)) {
    throw new Error("Proposal digest did not include the pending proposal.");
  }

  const blockedApply = await client.callTool({
    name: "knowledge_apply_proposal",
    arguments: { proposal_id: proposal.proposal_id },
  });
  if (!blockedApply.isError) {
    throw new Error("Apply accepted a proposal without conversation approval.");
  }
  if (!existsSync(smokeProposalFile)) {
    throw new Error("Rejected apply removed the pending proposal.");
  }

  const blockedReject = await client.callTool({
    name: "knowledge_reject_proposal",
    arguments: { proposal_id: proposal.proposal_id },
  });
  if (!blockedReject.isError || !existsSync(smokeProposalFile)) {
    throw new Error("Reject accepted a proposal without explicit user rejection.");
  }
  const rejected = payload(
    await client.callTool({
      name: "knowledge_reject_proposal",
      arguments: {
        proposal_id: proposal.proposal_id,
        user_rejected: true,
        rejection_message: "Smoke-test cleanup; no knowledge change was requested.",
      },
    }),
  );
  if (rejected.knowledge_modified !== false || existsSync(smokeProposalFile)) {
    throw new Error("Proposal rejection did not archive the proposal safely.");
  }
  smokeRejectedFile = path.join(
    os.homedir(),
    ".gbrain",
    "change-proposals",
    "rejected",
    `${proposal.proposal_id}.json`,
  );
  if (!existsSync(smokeRejectedFile)) throw new Error("Rejected proposal was not archived.");
  unlinkSync(smokeRejectedFile);
  smokeRejectedFile = undefined;

  const staleResponse = await client.callTool({
    name: "knowledge_propose_changes",
    arguments: {
      summary: "Gateway stale-proposal smoke test",
      rationale: "Verify that a changed content baseline blocks an approved proposal.",
      origin: "background",
      proposed_by: "gateway-smoke-test",
      changes: [
        {
          action: "update",
          target: "methods/short-video-user-judgment-model.md",
          content: readFileSync(
            path.resolve(HERE, "../../methods/short-video-user-judgment-model.md"),
            "utf8",
          ),
        },
      ],
    },
  });
  if (staleResponse.isError) throw new Error("Stale-proposal setup failed.");
  const staleProposal = payload(staleResponse);
  staleProposalFile = path.join(
    os.homedir(),
    ".gbrain",
    "change-proposals",
    "pending",
    `${staleProposal.proposal_id}.json`,
  );
  const staleRecord = JSON.parse(readFileSync(staleProposalFile, "utf8"));
  staleRecord.proposal.preconditions[
    "methods/short-video-user-judgment-model.md"
  ].sha256 = "0".repeat(64);
  staleRecord.sha256 = createHash("sha256")
    .update(JSON.stringify(staleRecord.proposal))
    .digest("hex");
  writeFileSync(staleProposalFile, `${JSON.stringify(staleRecord, null, 2)}\n`, {
    mode: 0o600,
  });

  const staleApply = await client.callTool({
    name: "knowledge_apply_proposal",
    arguments: {
      proposal_id: staleProposal.proposal_id,
      user_approved: true,
      approval_message: "Smoke-test approval used only to verify stale-content blocking.",
    },
  });
  const staleError = payload(staleApply).error || "";
  if (!staleApply.isError || !staleError.includes("Proposal is stale")) {
    throw new Error(`Stale proposal was not blocked by its content baseline: ${staleError}`);
  }
  const staleRejected = payload(
    await client.callTool({
      name: "knowledge_reject_proposal",
      arguments: {
        proposal_id: staleProposal.proposal_id,
        user_rejected: true,
        rejection_message: "Smoke-test cleanup after stale-content verification.",
      },
    }),
  );
  if (!staleRejected.rejected || existsSync(staleProposalFile)) {
    throw new Error("Stale proposal cleanup failed.");
  }
  staleProposalFile = undefined;
  staleRejectedFile = path.join(
    os.homedir(),
    ".gbrain",
    "change-proposals",
    "rejected",
    `${staleProposal.proposal_id}.json`,
  );
  unlinkSync(staleRejectedFile);
  staleRejectedFile = undefined;

  console.log(
    JSON.stringify(
      {
        ok: true,
        tools: listedTools.tools.length,
        intake_contract: "passed",
        index_repair: "passed",
        result_pages: resultList.pages.length,
        source_guard: "passed",
        proposal_queue: "passed",
        exact_proposal_review: "passed",
        proposal_digest: "passed",
        proposal_content_baseline: "passed",
        root_ui_artifact_proposal: "passed",
        stale_proposal_guard: "passed",
        conversation_approval_gate: "passed",
        conversation_rejection_gate: "passed",
        evaluations,
        route_evaluations: routeEvaluations,
      },
      null,
      2,
    ),
  );
} finally {
  for (const file of [
    smokeProposalFile,
    smokeRejectedFile,
    staleProposalFile,
    staleRejectedFile,
    uiProposalFile,
    uiRejectedFile,
  ]) {
    if (file && existsSync(file)) unlinkSync(file);
  }
  await client.close();
}
