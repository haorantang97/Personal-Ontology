import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { KnowledgeCatalog } from "./knowledge-catalog.mjs";
import { deriveSchemaRuntime } from "./schema-pack.mjs";
const schemaRuntime = deriveSchemaRuntime(JSON.parse(readFileSync(new URL("../agent-knowledge-schema/pack.json", import.meta.url))));

test("router uses canonical result scope rather than source type or path spelling", () => {
  const pack = JSON.parse(readFileSync(new URL("../agent-knowledge-schema/pack.json", import.meta.url)));
  pack.page_types.find((entry) => entry.name === "source").retrieval_scope = "result";
  pack.page_types.find((entry) => entry.name === "methodology").retrieval_scope = "evidence";
  const runtime = deriveSchemaRuntime(pack);
  const source = { slug: "sources/example", type: "source", title: "Unique Canonical Title", aliases: [], tags: [] };
  const method = { ...source, slug: "methods/example", type: "methodology" };
  assert.equal(routeKnowledgeCandidates({ query: source.title, candidates: [source], schemaRuntime: runtime }).action, "read");
  assert.equal(routeKnowledgeCandidates({ query: method.title, candidates: [method], schemaRuntime: runtime }).action, "none");
});
import {
  buildLexicalMetadataEvidence,
  buildTrustInputBinding,
  normalizeRouteText,
  observeKnowledgeTrustShadow,
  routeKnowledgeCandidates,
} from "./knowledge-router.mjs";

function retrieveWithLocalFallback({ nativeIndex, catalog, query, limit, queryOptions = {} }) {
  try {
    return { hits: nativeIndex.query({ query, limit, ...queryOptions }) || [],
      retrievalMode: "native_hybrid", retrievalStatus: "ok" };
  } catch {
    return { hits: catalog.search(query, { limit }),
      retrievalMode: "local_markdown_keyword", retrievalStatus: "degraded" };
  }
}

const garden = {
  slug: "methods/greenhouse-watering-checklist",
  title: "温室浇水检查清单",
  type: "methodology",
  aliases: ["温室灌溉方法", "浇水检查模型", "植物补水验证流程"],
  tags: ["gardening", "greenhouse", "care-planning", "verification"],
  modules: [],
  base_score: 0.97,
  excerpt: "先确定植物阶段，再按土壤和天气信号安排浇水并复查。",
};

const gardenSynthesis = {
  slug: "syntheses/greenhouse-care-decision-system",
  title: "温室养护应采用阶段、信号与对象三层索引",
  type: "synthesis",
  aliases: ["温室养护决策系统", "植物照料三层索引", "温室知识组织模型"],
  tags: ["gardening", "greenhouse", "decision-system", "care-planning"],
  modules: [],
  base_score: 0.94,
};

const nimbus = {
  slug: "projects/nimbus-agent-workbench",
  title: "Nimbus 多 Agent 工作台",
  type: "project",
  aliases: ["Nimbus Agent Workbench", "Nimbus Agent 调度中枢"],
  tags: ["nimbus", "multi-agent", "cli", "workbench"],
  modules: ["example-context"],
  base_score: 0.93,
  excerpt: "Console 负责状态展示和启动入口，运行时由 Nimbus 管理。",
};

const unrelated = {
  slug: "methods/general-problem-solving-loop",
  title: "核心约束资源反馈循环",
  type: "methodology",
  aliases: ["问题解决反馈循环"],
  tags: ["problem-solving", "feedback-loop"],
  modules: [],
  base_score: 0.99,
};

function route(query, candidates, overrides = {}) {
  return routeKnowledgeCandidates({
    schemaRuntime,
    query,
    context: "",
    module: null,
    candidates,
    retrievalStatus: "ok",
    retrievalMode: "hybrid",
    limit: 5,
    ...overrides,
  });
}

const ACCEPTANCE_RESULT_TYPES = new Set([
  "project",
  "decision",
  "methodology",
  "synthesis",
  "concept",
]);

function writeAcceptancePage(root, relative, markdown) {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, markdown);
}

function replacementAcceptanceFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "knowledge-replacement-acceptance-"));
  mkdirSync(path.join(root, "ops/agent-knowledge-schema"), { recursive: true });
  mkdirSync(path.join(root, "ops/gateway"), { recursive: true });
  writeFileSync(path.join(root, "ops/agent-knowledge-schema/pack.json"), readFileSync(new URL("../agent-knowledge-schema/pack.json", import.meta.url)));
  writeFileSync(path.join(root, "ops/gateway/package.json"), '{"version":"1.8.0"}');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of [
    "projects",
    "decisions",
    "methods",
    "syntheses",
    "concepts",
    "sources",
    ".raw",
  ]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }

  writeAcceptancePage(root, "methods/greenhouse-watering-checklist.md", `---
type: methodology
title: 温室浇水检查清单
aliases: [温室灌溉方法, 浇水检查模型, 植物补水验证流程]
tags: [gardening, greenhouse, care-planning, verification]
modules: []
agent_priority: normal
---
# 温室浇水检查清单

先确定植物阶段，再按土壤和天气信号安排浇水并复查。
`);
  writeAcceptancePage(root, "syntheses/greenhouse-care-decision-system.md", `---
type: synthesis
title: 温室养护应采用阶段、信号与对象三层索引
aliases: [温室养护决策系统, 植物照料三层索引, 温室知识组织模型]
tags: [gardening, greenhouse, care-planning]
modules: []
agent_priority: normal
---
# 温室养护应采用阶段、信号与对象三层索引

温室浇水建议需要先判断生长阶段，再落到植物、土壤与当前天气。
`);
  writeAcceptancePage(root, "sources/greenhouse-observation.md", `---
type: source
title: 温室外部观察证据
aliases: [温室观察来源]
tags: [gardening, greenhouse]
modules: []
---
# 温室外部观察证据

这是只允许在 evidence scope 使用的温室养护候选来源。
`);
  writeAcceptancePage(root, "methods/aaa-global-research-review.md", `---
type: methodology
title: 研究资料审阅流程
aliases: [资料审阅]
tags: [research, review]
modules: []
agent_priority: normal
---
# 研究资料审阅流程
`);
  writeAcceptancePage(root, "methods/zzz-module-research-review.md", `---
type: methodology
title: 研究资料审阅流程
aliases: [资料审阅]
tags: [research, review]
modules: [example-research]
agent_priority: normal
---
# 研究资料审阅流程
`);
  writeAcceptancePage(root, "methods/general-problem-solving-loop.md", `---
type: methodology
title: 核心约束资源反馈循环
aliases: [问题解决反馈循环]
tags: [problem-solving, feedback-loop]
modules: []
agent_priority: normal
---
# 核心约束资源反馈循环
`);
  writeAcceptancePage(root, ".raw/greenhouse-notes.md", "# 温室原始记录不可召回\n");

  return new KnowledgeCatalog({ root });
}

function scopeAllowsForAcceptance(type, scope) {
  if (scope === "all") return ACCEPTANCE_RESULT_TYPES.has(type) || type === "source";
  if (scope === "evidence") return type === "source";
  return ACCEPTANCE_RESULT_TYPES.has(type);
}

function runReplacementAcceptanceRoute(catalog, {
  query,
  module = null,
  nativeAvailable,
  scope = "result",
} = {}) {
  const expectedHits = catalog.search(query, { limit: 40 });
  const nativeIndex = {
    query() {
      if (!nativeAvailable) throw new Error("fixture native index unavailable");
      return structuredClone(expectedHits);
    },
  };
  const retrieval = retrieveWithLocalFallback({
    nativeIndex,
    catalog,
    query,
    limit: 40,
    queryOptions: { expand: false },
  });
  const scopedHits = retrieval.hits.filter((hit) => scopeAllowsForAcceptance(hit.type, scope));
  const candidates = scopedHits.map((hit, index) => {
    const page = catalog.getPage(hit.slug, { fuzzy: false });
    return {
      slug: hit.slug,
      title: page?.title || hit.title,
      type: hit.type,
      aliases: page?.frontmatter?.aliases || [],
      tags: page?.tags || [],
      modules: page?.frontmatter?.modules || [],
      agent_priority: page?.frontmatter?.agent_priority || null,
      retrieval_evidence: hit.evidence || null,
      retrieval_rank: index + 1,
      base_score: hit.score,
    };
  });
  const routed = routeKnowledgeCandidates({
    schemaRuntime,
    query,
    module,
    candidates,
    retrievalStatus: retrieval.retrievalStatus,
    retrievalMode: retrieval.retrievalMode,
    limit: 5,
  });

  // Models the gateway protocol: page bodies are fetched only after action=read.
  let bodyReadCount = 0;
  if (routed.action === "read") {
    for (const selected of routed.selected) {
      assert.ok(catalog.getPage(selected.slug, { fuzzy: false }));
      bodyReadCount += 1;
    }
  }
  return { routed, rawHits: retrieval.hits, scopedHits, bodyReadCount };
}

function stableRouteDecision(value) {
  return {
    action: value.routed.action,
    reason_codes: value.routed.reason_codes,
    selected: value.routed.selected.map((item) => item.slug),
    candidates: value.routed.candidates.map((item) => item.slug),
    bodyReadCount: value.bodyReadCount,
  };
}

test("replacement acceptance keeps golden route decisions across Native and local recall", (t) => {
  const catalog = replacementAcceptanceFixture(t);
  const cases = [
    {
      query: "请使用温室浇水检查清单",
      expected: "methods/greenhouse-watering-checklist",
      reason: "exact_title_match",
    },
    {
      query: "按植物补水验证流程安排",
      expected: "methods/greenhouse-watering-checklist",
      reason: "exact_alias_match",
    },
    {
      query: "温室里的植物该如何安排浇水",
      expected: "methods/greenhouse-watering-checklist",
      reason: "multi_term_metadata_match",
    },
  ];

  for (const acceptanceCase of cases) {
    const native = runReplacementAcceptanceRoute(catalog, {
      query: acceptanceCase.query,
      nativeAvailable: true,
    });
    const local = runReplacementAcceptanceRoute(catalog, {
      query: acceptanceCase.query,
      nativeAvailable: false,
    });

    assert.equal(native.routed.retrieval.status, "ok");
    assert.equal(native.routed.retrieval.mode, "native_hybrid");
    assert.equal(local.routed.retrieval.status, "degraded");
    assert.equal(local.routed.retrieval.mode, "local_markdown_keyword");
    assert.deepEqual(stableRouteDecision(local), stableRouteDecision(native));
    assert.equal(local.routed.action, "read");
    assert.ok(local.routed.selected.some((item) => item.slug === acceptanceCase.expected));
    assert.ok(
      local.routed.reason_codes.includes(acceptanceCase.reason),
      `${acceptanceCase.query}: ${JSON.stringify(local.routed.reason_codes)}`,
    );
    assert.ok(local.bodyReadCount > 0);
  }
});

test("replacement acceptance hard negatives never schedule a page-body read", (t) => {
  const catalog = replacementAcceptanceFixture(t);
  const queries = [
    "2+2 等于多少？",
    "把这句话翻译成英文。",
    "写一个邮箱正则表达式。",
    "北京明天天气怎么样？",
    "解释 QCD 渐近自由。",
    "今天美元兑人民币汇率是多少",
  ];

  for (const query of queries) {
    for (const nativeAvailable of [true, false]) {
      const result = runReplacementAcceptanceRoute(catalog, { query, nativeAvailable });
      assert.notEqual(result.routed.action, "read", query);
      assert.deepEqual(result.routed.selected, [], query);
      assert.equal(result.bodyReadCount, 0, query);
    }
  }
});

test("replacement acceptance preserves result/evidence isolation and excludes Raw", (t) => {
  const catalog = replacementAcceptanceFixture(t);
  const result = runReplacementAcceptanceRoute(catalog, {
    query: "温室浇水",
    nativeAvailable: false,
    scope: "result",
  });
  const evidence = runReplacementAcceptanceRoute(catalog, {
    query: "温室浇水",
    nativeAvailable: false,
    scope: "evidence",
  });

  assert.ok(result.rawHits.some((hit) => hit.type === "source"));
  assert.ok(result.scopedHits.length > 0);
  assert.ok(result.scopedHits.every((hit) => ACCEPTANCE_RESULT_TYPES.has(hit.type)));
  assert.ok(evidence.scopedHits.length > 0);
  assert.ok(evidence.scopedHits.every((hit) => hit.type === "source"));
  assert.ok(result.rawHits.every((hit) => !hit.slug.startsWith(".raw/")));
});

test("replacement acceptance applies module boost without turning it into a filter", (t) => {
  const catalog = replacementAcceptanceFixture(t);
  const withoutModule = runReplacementAcceptanceRoute(catalog, {
    query: "研究资料审阅流程",
    nativeAvailable: false,
  });
  const withModule = runReplacementAcceptanceRoute(catalog, {
    query: "研究资料审阅流程",
    module: "example-research",
    nativeAvailable: false,
  });
  const unrelated = runReplacementAcceptanceRoute(catalog, {
    query: "帮我翻译这句话",
    module: "example-research",
    nativeAvailable: false,
  });

  assert.equal(withoutModule.routed.selected[0].slug, "methods/aaa-global-research-review");
  assert.equal(
    withModule.routed.selected[0].slug,
    "methods/zzz-module-research-review",
    JSON.stringify(withModule.routed.selected),
  );
  assert.ok(withModule.routed.selected.some(
    (item) => item.slug === "methods/aaa-global-research-review",
  ));
  assert.ok(withModule.routed.reason_codes.includes("module_boost"));
  assert.notEqual(unrelated.routed.action, "read");
  assert.equal(unrelated.bodyReadCount, 0);
});

test("normalization folds Unicode width, case, and punctuation", () => {
  assert.equal(normalizeRouteText("Ｎｉｍｂｕｓ，Console！"), "nimbus console");
});

test("full title match routes to read", () => {
  const result = route("请使用温室浇水检查清单", [garden]);
  assert.equal(result.action, "read");
  assert.equal(result.selected[0].slug, garden.slug);
  assert.ok(result.reason_codes.includes("exact_title_match"));
});

test("full alias match routes to read", () => {
  const result = route("按植物补水验证流程安排", [garden]);
  assert.equal(result.action, "read");
  assert.ok(result.reason_codes.includes("exact_alias_match"));
});

test("two independent Chinese subject terms route garden query to read", () => {
  const result = route("温室里的植物该如何安排浇水", [unrelated, garden, gardenSynthesis]);
  assert.equal(result.action, "read");
  assert.ok(result.selected.some((item) => item.slug === garden.slug));
});

test("unique Latin metadata anchor routes Nimbus query to read", () => {
  const result = route("Nimbus 的 Console 应该负责什么，运行时应该放在哪里", [unrelated, nimbus]);
  assert.equal(result.action, "read");
  assert.equal(result.selected[0].slug, nimbus.slug);
  assert.ok(result.reason_codes.includes("unique_anchor_match"));
});

test("context can resolve a short follow-up without being persisted", () => {
  const result = route("那应该放在哪里？", [nimbus], {
    context: "当前任务讨论 Nimbus Console 与 Agent 运行时的职责边界",
  });
  assert.equal(result.action, "read");
  assert.equal(result.selected[0].slug, nimbus.slug);
  assert.ok(result.reason_codes.includes("context_metadata_match"));
});

test("vector score alone cannot trigger read", () => {
  const result = route("2+2 等于多少？", [unrelated]);
  assert.equal(result.action, "none");
  assert.equal(result.selected.length, 0);
});

test("module match alone cannot trigger read", () => {
  const result = route("帮我翻译这句话", [{ ...unrelated, modules: ["example-module"] }], { module: "example-module" });
  assert.equal(result.action, "none");
});

test("one environment term is insufficient for automatic garden read", () => {
  const result = route("温室明天温度怎么样？", [garden]);
  assert.notEqual(result.action, "read");
});

test("arithmetic negative has zero automatic reads", () => {
  assert.notEqual(route("2+2 等于多少？", [unrelated, garden]).action, "read");
});

test("translation negative has zero automatic reads", () => {
  assert.notEqual(route("把这句话翻译成英文。", [nimbus, unrelated]).action, "read");
});

test("email regex negative has zero automatic reads", () => {
  assert.notEqual(route("写一个邮箱正则表达式。", [nimbus, unrelated]).action, "read");
});

test("weather negative has zero automatic reads", () => {
  assert.notEqual(route("北京明天天气怎么样？", [garden, gardenSynthesis]).action, "read");
});

test("QCD negative has zero automatic reads", () => {
  assert.notEqual(route("解释 QCD 渐近自由。", [unrelated, nimbus]).action, "read");
});

test("source candidates are excluded from default routing", () => {
  const source = { ...garden, slug: "sources/greenhouse-source", type: "source" };
  assert.equal(route("温室植物怎么浇水", [source]).action, "none");
});

test("raw candidates are excluded from default routing", () => {
  const raw = { ...garden, slug: ".raw/greenhouse.md", type: "methodology" };
  assert.equal(route("温室植物怎么浇水", [raw]).action, "none");
});

test("module boost changes ordering only after relevance is established", () => {
  const global = {
    ...nimbus,
    slug: "projects/nimbus-global",
    modules: [],
    base_score: 0.96,
  };
  const moduleSpecific = {
    ...nimbus,
    slug: "projects/nimbus-module",
    modules: ["example-context"],
    base_score: 0.90,
  };
  const result = route("Nimbus workbench", [global, moduleSpecific], { module: "example-context" });
  assert.equal(result.action, "read");
  assert.equal(result.selected[0].slug, moduleSpecific.slug);
});

test("active decision wins a tie after relevance is established", () => {
  const method = {
    ...nimbus,
    slug: "methods/nimbus-runtime-boundary",
    type: "methodology",
    base_score: 0.9,
  };
  const decision = {
    ...nimbus,
    slug: "decisions/nimbus-runtime-boundary",
    type: "decision",
    decision_status: "active",
    base_score: 0.9,
  };
  const result = route("Nimbus runtime boundary", [method, decision]);
  assert.equal(result.selected[0].slug, decision.slug);
});

test("limit bounds the selected result count", () => {
  const result = route("Nimbus workbench", [
    nimbus,
    { ...nimbus, slug: "projects/nimbus-two" },
    { ...nimbus, slug: "projects/nimbus-three" },
  ], { limit: 2 });
  assert.equal(result.selected.length, 2);
});

test("duplicate slugs are removed", () => {
  const result = route("Nimbus workbench", [nimbus, { ...nimbus, base_score: 0.1 }]);
  assert.equal(result.selected.filter((item) => item.slug === nimbus.slug).length, 1);
});

test("equal evidence uses base score as a stable secondary order", () => {
  const low = { ...nimbus, slug: "projects/nimbus-low", base_score: 0.5 };
  const high = { ...nimbus, slug: "projects/nimbus-high", base_score: 0.8 };
  const result = route("Nimbus workbench", [low, high]);
  assert.equal(result.selected[0].slug, high.slug);
});

test("lexical weak match produces review rather than automatic read", () => {
  const result = route("温室有什么安排", [garden]);
  assert.equal(result.action, "review");
  assert.equal(result.selected.length, 0);
  assert.equal(result.candidates[0].slug, garden.slug);
});

test("high-priority keyword evidence can promote an existing weak metadata match", () => {
  const career = {
    slug: "projects/example-profile-evidence-ledger",
    title: "示例经历与项目证据账本",
    type: "project",
    aliases: ["职业证据账本", "项目经历证据账本"],
    tags: ["career", "evidence-ledger", "personal-context"],
    modules: ["personal-context"],
    agent_priority: "high",
    retrieval_evidence: "keyword_exact",
    retrieval_rank: 1,
    base_score: 0.9586,
  };
  const result = route("根据我的经历帮我写一份简历", [career]);
  assert.equal(result.action, "read");
  assert.ok(result.reason_codes.includes("high_priority_keyword_match"));
});

test("high priority plus vector evidence does not promote a weak match", () => {
  const career = {
    slug: "projects/example-profile-evidence-ledger",
    title: "示例经历与项目证据账本",
    type: "project",
    aliases: ["职业证据账本"],
    tags: ["career"],
    modules: ["personal-context"],
    agent_priority: "high",
    retrieval_evidence: "high_vector_match",
    retrieval_rank: 1,
    base_score: 0.99,
  };
  assert.equal(route("根据我的经历帮我写一份简历", [career]).action, "review");
});

const nativeCareer = {
  slug: "projects/example-profile-evidence-ledger", title: "示例经历与项目证据账本",
  type: "project", aliases: ["职业证据账本", "项目经历证据账本"],
  tags: ["career", "evidence-ledger", "personal-context"], modules: ["personal-context"],
  agent_priority: "high", retrieval_evidence: "native_lexical_vector", retrieval_rank: 1,
  base_score: 0.844827,
};

test("backend-neutral metadata evidence routes explicit personal career request without provider score thresholds", () => {
  const query = "根据我的经历帮我写一份简历";
  const evidence = buildLexicalMetadataEvidence({ query, candidates: [nativeCareer] }).get(nativeCareer.slug);
  assert.deepEqual(evidence.matches, [{ field: "title", term: "经历" }, { field: "aliases", term: "经历" }]);
  for (const base_score of [0.1, 0.844827, 0.99]) {
    const result = route(query, [{ ...nativeCareer, base_score, lexical_metadata: evidence }], { metadataUniverse: [nativeCareer] });
    assert.equal(result.action, "read");
    assert(result.reason_codes.includes("high_priority_personal_metadata_match"));
    assert.equal(result.selected[0].lexical_metadata_verified, true);
  }
});

test("neutral metadata cannot promote generic sales or weather questions", () => {
  const workflow = { ...nativeCareer, slug: "methods/example-customer-workflow-qualification",
    type: "methodology", title: "客户与工作流资格判断法",
    aliases: ["客户筛选", "工作流筛选"], tags: ["客户筛选", "工作流"] };
  const salesQuery = "如何判断销售候选人的能力";
  const salesEvidence = buildLexicalMetadataEvidence({ query: salesQuery, candidates: [workflow] }).get(workflow.slug);
  assert.equal(salesEvidence, undefined); // Generic 判断 is not a subject anchor.
  assert.notEqual(route(salesQuery, [{ ...workflow, lexical_metadata: salesEvidence }], { metadataUniverse: [workflow] }).action, "read");
  const weather = "北京明天天气怎么样？";
  const highGarden = { ...garden, agent_priority: "high", retrieval_rank: 1,
    retrieval_evidence: "native_lexical_vector", base_score: 0.99 };
  const weatherEvidence = buildLexicalMetadataEvidence({ query: weather, candidates: [highGarden] }).get(highGarden.slug);
  assert.notEqual(route(weather, [{ ...highGarden, lexical_metadata: weatherEvidence }], { metadataUniverse: [highGarden] }).action, "read");
});

test("neutral personal metadata gate rejects stale, forged, tied, low-priority and body-only signals", () => {
  const query = "根据我的经历帮我写一份简历";
  const evidence = buildLexicalMetadataEvidence({ query, candidates: [nativeCareer] }).get(nativeCareer.slug);
  const invalid = [
    { ...nativeCareer, lexical_metadata: { ...evidence, query_hash: "wrong" } },
    { ...nativeCareer, lexical_metadata: { ...evidence, metadata_hash: "wrong" } },
    { ...nativeCareer, lexical_metadata: { ...evidence, metadata_rank: 2 } },
    { ...nativeCareer, lexical_metadata: { ...evidence, rank_tie_count: 2 } },
    { ...nativeCareer, lexical_metadata: { ...evidence, matches: [{ field: "body", term: "经历" }] } },
    { ...nativeCareer, lexical_metadata: { ...evidence, matches: [{ field: "title", term: "简历" }] } },
    { ...nativeCareer, agent_priority: "normal", lexical_metadata: evidence },
    { ...nativeCareer, retrieval_rank: 4, lexical_metadata: evidence },
    { ...nativeCareer, retrieval_rank: 0, lexical_metadata: evidence },
  ];
  for (const candidate of invalid) assert.equal(route(query, [candidate], { metadataUniverse: [nativeCareer] }).action, "review");
  const generic = "一个人的经历怎么整理？";
  const genericEvidence = buildLexicalMetadataEvidence({ query: generic, candidates: [nativeCareer] }).get(nativeCareer.slug);
  assert.equal(route(generic, [{ ...nativeCareer, lexical_metadata: genericEvidence }], { metadataUniverse: [nativeCareer] }).action, "review");
});

test("neutral metadata recomputes global ties and rejects forged provider uniqueness", () => {
  const query = "根据我的经历帮我写一份简历";
  const competitor = { ...nativeCareer, slug: "projects/another-career" };
  const metadataUniverse = [nativeCareer, competitor];
  const evidence = buildLexicalMetadataEvidence({ query, candidates: metadataUniverse });
  const forged = metadataUniverse.map((candidate) => ({ ...candidate,
    lexical_metadata: { ...evidence.get(candidate.slug), metadata_rank: 1, rank_tie_count: 1 } }));
  const both = route(query, forged, { metadataUniverse });
  assert.equal(both.action, "review"); assert.equal(both.selected.length, 0);
  const onlyRetrievedOne = route(query, [forged[0]], { metadataUniverse });
  assert.equal(onlyRetrievedOne.action, "review"); assert.equal(onlyRetrievedOne.selected.length, 0);
});

test("neutral metadata uniqueness requires complete canonical universe binding", () => {
  const query = "根据我的经历帮我写一份简历";
  const competitor = { ...nativeCareer, slug: "projects/another-career" };
  const subsetEvidence = buildLexicalMetadataEvidence({ query, candidates: [nativeCareer] }).get(nativeCareer.slug);
  const candidate = { ...nativeCareer, lexical_metadata: subsetEvidence };
  assert.equal(route(query, [candidate]).action, "review");
  assert.equal(route(query, [candidate], { metadataUniverse: [nativeCareer, competitor] }).action, "review");
  const fullEvidence = buildLexicalMetadataEvidence({ query, candidates: [nativeCareer, competitor] }).get(nativeCareer.slug);
  assert.equal(route(query, [{ ...candidate, lexical_metadata: { ...fullEvidence, rank_tie_count: 1 } }],
    { metadataUniverse: [nativeCareer] }).action, "review");
});

test("neutral metadata hashes query and context consistently and rejects context drift", () => {
  const query = "帮我写一份简历"; const context = "根据我的经历";
  const evidence = buildLexicalMetadataEvidence({ query: `${query}\n${context}`, candidates: [nativeCareer] }).get(nativeCareer.slug);
  const candidate = { ...nativeCareer, lexical_metadata: evidence };
  assert.equal(route(query, [candidate], { context, metadataUniverse: [nativeCareer] }).action, "read");
  assert.equal(route(query, [candidate], { context: "根据我的经历和感受", metadataUniverse: [nativeCareer] }).action, "review");
});

test("explicit Chinese and English personal-context negation overrides automatic reads", () => {
  const negatives = [
    "不要根据我的经历，直接给我一个通用简历模板",
    "不需要参考我的经历，只解释简历是什么",
    "无需结合我的经历，给一个通用模板",
    "勿基于我的经历做个性化推荐",
    "不用参考我的职业经历与项目证据账本",
    "Without using my experience, give me a generic resume template",
    "Do not base this on my experience; explain resumes generally",
    "Don't consider my career history, use a generic example",
    "No need to refer to my experience, just provide a template",
  ];
  for (const query of negatives) {
    const evidence = buildLexicalMetadataEvidence({ query, candidates: [nativeCareer] }).get(nativeCareer.slug);
    const result = route(query, [{ ...nativeCareer, lexical_metadata: evidence,
      retrieval_evidence: "keyword_exact", base_score: 0.99 }], { metadataUniverse: [nativeCareer] });
    assert.notEqual(result.action, "read", query);
    assert.equal(result.selected.length, 0, query);
    if (result.action === "review") assert(result.reason_codes.includes("personal_context_explicitly_excluded"), query);
  }
});

test("personal-context negation preserves explicitly requested general methods", () => {
  const generalMethod = { slug: "methods/resume-writing", type: "methodology", title: "简历写作方法",
    aliases: ["General Resume Writing"], tags: ["writing"], modules: [], agent_priority: "normal",
    retrieval_evidence: "native_lexical_vector", retrieval_rank: 2, base_score: 0.7 };
  const metadataUniverse = [nativeCareer, generalMethod];
  for (const query of [
    "不要根据我的经历，按简历写作方法给通用模板",
    "不用参考我的职业经历与项目证据账本，按简历写作方法给通用模板",
    "Without using my career history, use General Resume Writing for a generic template",
  ]) {
    const evidence = buildLexicalMetadataEvidence({ query, candidates: metadataUniverse });
    const result = route(query, [
      { ...nativeCareer, lexical_metadata: evidence.get(nativeCareer.slug), retrieval_evidence: "keyword_exact", base_score: 0.99 },
      { ...generalMethod, lexical_metadata: evidence.get(generalMethod.slug) },
    ], { metadataUniverse });
    assert.equal(result.action, "read", query);
    assert.deepEqual(result.selected.map(({ slug }) => slug), [generalMethod.slug], query);
  }
});

test("generic judgment wording cannot promote an unrelated high-priority page", () => {
  const workflowQualification = {
    slug: "methods/example-customer-workflow-qualification",
    title: "客户与工作流资格判断法",
    type: "methodology",
    aliases: ["客户筛选", "工作流筛选"],
    tags: ["客户筛选", "工作流"],
    modules: ["example-operations"],
    agent_priority: "high",
    retrieval_evidence: "keyword_exact",
    retrieval_rank: 3,
    base_score: 0.9308,
  };
  assert.notEqual(route("如何判断销售候选人的能力", [workflowQualification]).action, "read");
});

test("generic stop terms cannot create relevance", () => {
  const result = route("这个系统应该使用什么方法？", [gardenSynthesis, unrelated]);
  assert.equal(result.action, "none");
});

test("local Markdown keyword fallback preserves an exact explainable read", () => {
  const result = route("Nimbus Agent Workbench", [nimbus], {
    retrievalStatus: "degraded",
    retrievalMode: "local_markdown_keyword",
  });
  assert.equal(result.action, "read");
  assert.equal(result.retrieval.status, "degraded");
});

test("unavailable retrieval is explicit and never claims a match", () => {
  const result = route("Nimbus Agent Workbench", [nimbus], {
    retrievalStatus: "unavailable",
    retrievalMode: "none",
  });
  assert.equal(result.action, "none");
  assert.equal(result.retrieval.status, "unavailable");
  assert.ok(result.reason_codes.includes("retrieval_unavailable"));
});

test("scalar aliases and tags are normalized defensively", () => {
  const scalar = { ...nimbus, aliases: "Nimbus Control Plane", tags: "nimbus" };
  const result = route("Use Nimbus Control Plane", [scalar]);
  assert.equal(result.action, "read");
});

test("inputs are not mutated", () => {
  const candidates = [structuredClone(nimbus), structuredClone(garden)];
  const before = structuredClone(candidates);
  route("Nimbus workbench", candidates, { module: "example-context" });
  assert.deepEqual(candidates, before);
});

function fakeTrustCore({
  claims = [{ claim_id: "C-FACT", claim_type: "fact", scope: [] }],
  invalidIssues = null,
  verdictOverride = null,
} = {}) {
  return {
    PACKAGE_ID: "lab-trust-core",
    DEFAULT_POLICY: { id: "knowledge-trust-default", version: "1.0.0" },
    parseKnowledgeMarkdown(markdown, { path }) {
      if (markdown === "invalid") {
        return {
          ok: false,
          issues: invalidIssues || [
            { code: "MISSING_MATURITY", path: "$.maturity", message: "maturity required" },
            { code: "MISSING_CLAIMS_SECTION", path: "$.claims", message: "Claims required" },
          ],
        };
      }
      return {
        ok: true,
        record: {
          id: path.replace(/\.md$/, ""),
          maturity: "validated",
          claims: structuredClone(claims),
        },
      };
    },
    evaluateUse(record, context) {
      if (verdictOverride) return structuredClone(verdictOverride);
      const claim = record.claims.find((item) => item.claim_id === context.claim_id);
      const denied = claim?.claim_type === "rhetoric_strategy";
      return {
        record_id: record.id,
        claim_id: context.claim_id,
        intended_use: context.intended_use,
        decision: denied ? "deny" : "allow",
        effective_maturity: record.maturity,
        reason_codes: denied ? ["CLAIM_TYPE_NOT_ALLOWED"] : ["POLICY_ALLOWED"],
        explanation: denied ? "blocked" : "allowed",
        required_attribution: false,
        required_caveats: [],
        evidence_gaps: [],
        promotion_blockers: denied ? ["CLAIM_TYPE_NOT_ALLOWED"] : [],
        policy_id: "knowledge-trust-default",
        policy_version: "1.0.0",
      };
    },
  };
}

test("trust shadow evaluates one claim without enforcing or mutating context", async () => {
  const trustContext = { intended_use: "default_answer", risk_level: "ordinary", scope: [] };
  const before = structuredClone(trustContext);
  const shadow = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    trustContext,
    coreLoader: async () => fakeTrustCore(),
  });

  assert.equal(shadow.mode, "shadow");
  assert.equal(shadow.enforced, false);
  assert.equal(shadow.status, "evaluated");
  assert.equal(shadow.context.claim_id, "C-FACT");
  assert.equal(shadow.verdict.claim_id, "C-FACT");
  assert.deepEqual(shadow.available_claim_ids, ["C-FACT"]);
  assert.deepEqual(trustContext, before);
});

test("trust shadow never evaluates a canonical record from implicit defaults", async () => {
  const shadow = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    coreLoader: async () => fakeTrustCore(),
  });

  assert.equal(shadow.status, "not_evaluable");
  assert.equal(shadow.context_source, "missing");
  assert.equal(shadow.verdict, null);
  assert.ok(shadow.issues.some((issue) => issue.code === "TRUST_CONTEXT_REQUIRED"));
});

test("trust shadow requires semantic scope when the selected claim declares one", async () => {
  const shadow = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    trustContext: { intended_use: "default_answer", risk_level: "ordinary", scope: [] },
    coreLoader: async () => fakeTrustCore({
      claims: [{ claim_id: "C-SCOPED", claim_type: "fact", scope: ["example domain"] }],
    }),
  });

  assert.equal(shadow.status, "not_evaluable");
  assert.equal(shadow.verdict, null);
  assert.ok(shadow.issues.some((issue) => issue.code === "SEMANTIC_SCOPE_REQUIRED"));
});

test("malformed trust context becomes a non-blocking diagnostic", async () => {
  const shadow = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    trustContext: { intended_use: "default_answer", risk_level: "medium", scope: "example" },
    coreLoader: async () => fakeTrustCore(),
  });

  assert.equal(shadow.status, "not_evaluable");
  assert.equal(shadow.context_source, "invalid");
  assert.equal(shadow.verdict, null);
  assert.ok(shadow.issues.some((issue) => issue.code === "CONTEXT_INVALID"));
});

test("trust shadow requires an explicit claim for multi-claim pages", async () => {
  const core = fakeTrustCore({
    claims: [
      { claim_id: "C-FACT", claim_type: "fact" },
      { claim_id: "C-RHETORIC", claim_type: "rhetoric_strategy" },
    ],
  });
  const shadow = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    trustContext: { intended_use: "default_answer", risk_level: "ordinary", scope: [] },
    coreLoader: async () => core,
  });

  assert.equal(shadow.status, "not_evaluable");
  assert.equal(shadow.verdict, null);
  assert.deepEqual(shadow.available_claim_ids, ["C-FACT", "C-RHETORIC"]);
  assert.equal(shadow.issues[0].code, "CLAIM_SELECTION_REQUIRED");
});

test("trust shadow consumes claim_id and preserves claim-type policy decisions", async () => {
  const core = fakeTrustCore({
    claims: [
      { claim_id: "C-FACT", claim_type: "fact" },
      { claim_id: "C-RHETORIC", claim_type: "rhetoric_strategy" },
    ],
  });
  const fact = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    trustContext: {
      intended_use: "default_answer",
      risk_level: "ordinary",
      claim_id: "C-FACT",
      scope: [],
    },
    coreLoader: async () => core,
  });
  const rhetoric = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    trustContext: {
      intended_use: "default_answer",
      risk_level: "ordinary",
      claim_id: "C-RHETORIC",
      scope: [],
    },
    coreLoader: async () => core,
  });

  assert.equal(fact.verdict.decision, "allow");
  assert.equal(rhetoric.verdict.decision, "deny");
  assert.equal(rhetoric.enforced, false);
  assert.ok(rhetoric.verdict.reason_codes.includes("CLAIM_TYPE_NOT_ALLOWED"));
});

test("trust shadow reports unknown claims without inventing a verdict", async () => {
  const shadow = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    trustContext: {
      intended_use: "default_answer",
      risk_level: "ordinary",
      claim_id: "C-MISSING",
      scope: [],
    },
    coreLoader: async () => fakeTrustCore(),
  });

  assert.equal(shadow.status, "not_evaluable");
  assert.equal(shadow.verdict, null);
  assert.equal(shadow.issues[0].code, "CLAIM_NOT_FOUND");
});

test("trust shadow exposes invalid legacy contracts without guessing maturity", async () => {
  const shadow = await observeKnowledgeTrustShadow({
    markdown: "invalid",
    path: "methods/legacy.md",
    coreLoader: async () => fakeTrustCore(),
  });

  assert.equal(shadow.status, "invalid_record");
  assert.equal(shadow.blocking, false);
  assert.equal(shadow.classification, "legacy_migration_warning");
  assert.equal(shadow.migration_status, "legacy_unmigrated");
  assert.equal(shadow.verdict, null);
  assert.ok(shadow.issues.some((issue) => issue.code === "MISSING_MATURITY"));
  assert.ok(shadow.issues.some((issue) => issue.code === "MISSING_CLAIMS_SECTION"));
});

test("trust shadow degrades loader failures without throwing", async () => {
  const shadow = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    coreLoader: async () => {
      throw new Error("module unavailable");
    },
  });

  assert.equal(shadow.status, "unavailable");
  assert.equal(shadow.enforced, false);
  assert.equal(shadow.verdict, null);
  assert.equal(shadow.issues[0].code, "TRUST_CORE_UNAVAILABLE");
});

test("trust shadow reports missing Markdown without loading the core", async () => {
  let loaded = false;
  const shadow = await observeKnowledgeTrustShadow({
    markdown: null,
    path: "methods/missing.md",
    coreLoader: async () => {
      loaded = true;
      return fakeTrustCore();
    },
  });

  assert.equal(shadow.status, "not_evaluable");
  assert.equal(shadow.issues[0].code, "SOURCE_MARKDOWN_UNAVAILABLE");
  assert.equal(loaded, false);
});

test("trust shadow bounds issue and claim diagnostics", async () => {
  const issues = Array.from({ length: 75 }, (_, index) => ({
    code: `ISSUE_${index}`,
    path: `$.claims[${index}]`,
    message: "invalid",
  }));
  const invalid = await observeKnowledgeTrustShadow({
    markdown: "invalid",
    path: "methods/invalid.md",
    coreLoader: async () => fakeTrustCore({ invalidIssues: issues }),
  });
  assert.equal(invalid.issue_count, 75);
  assert.equal(invalid.issues.length, 25);
  assert.equal(invalid.issues_truncated, true);

  const claims = Array.from({ length: 75 }, (_, index) => ({
    claim_id: `C-${index}`,
    claim_type: "fact",
    scope: [],
  }));
  const multi = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/many-claims.md",
    trustContext: { intended_use: "default_answer", risk_level: "ordinary", scope: [] },
    coreLoader: async () => fakeTrustCore({ claims }),
  });
  assert.equal(multi.available_claim_count, 75);
  assert.equal(multi.available_claim_ids.length, 25);
  assert.equal(multi.available_claim_ids_truncated, true);
});

test("trust shadow byte-bounds issue text and every verdict list", async () => {
  const huge = "边".repeat(40_000);
  const invalid = await observeKnowledgeTrustShadow({
    markdown: "invalid",
    path: "methods/invalid.md",
    coreLoader: async () => fakeTrustCore({
      invalidIssues: [{ code: huge, path: huge, message: huge }],
    }),
  });
  assert.ok(Buffer.byteLength(invalid.issues[0].code, "utf8") <= 120);
  assert.ok(Buffer.byteLength(invalid.issues[0].path, "utf8") <= 300);
  assert.ok(Buffer.byteLength(invalid.issues[0].message, "utf8") <= 500);
  assert.equal(invalid.issues_truncated, true);

  const values = Array.from({ length: 500 }, (_, index) => `${index}-${huge}`);
  const verdictOverride = {
    record_id: huge,
    claim_id: "C-FACT",
    intended_use: "default_answer",
    decision: "allow",
    effective_maturity: "validated",
    reason_codes: values,
    explanation: huge,
    required_attribution: false,
    required_caveats: values,
    evidence_gaps: values,
    promotion_blockers: values,
    policy_id: "knowledge-trust-default",
    policy_version: "1.0.0",
  };
  const evaluated = await observeKnowledgeTrustShadow({
    markdown: "canonical",
    path: "methods/example.md",
    trustContext: { intended_use: "default_answer", risk_level: "ordinary", scope: [] },
    coreLoader: async () => fakeTrustCore({ verdictOverride }),
  });
  for (const field of [
    "reason_codes",
    "required_caveats",
    "evidence_gaps",
    "promotion_blockers",
  ]) {
    assert.equal(evaluated.verdict[field].length, 25);
    assert.ok(evaluated.verdict[field].every((item) => Buffer.byteLength(item, "utf8") <= 500));
    assert.equal(evaluated.verdict_limits.fields[field].total_count, 500);
    assert.equal(evaluated.verdict_limits.fields[field].truncated, true);
  }
  assert.ok(Buffer.byteLength(evaluated.verdict.record_id, "utf8") <= 500);
  assert.ok(Buffer.byteLength(evaluated.verdict.explanation, "utf8") <= 2_000);
  assert.equal(evaluated.verdict_limits.truncated, true);
  assert.equal(evaluated.verdict.decision, "allow");
});

test("trust input binding hashes both evaluated Markdown and returned content", () => {
  const binding = buildTrustInputBinding({
    source: { markdown: "canonical markdown", path: "methods/example.md" },
    returnedContent: "compiled truth",
    updatedAt: "2030-01-03T00:00:00Z",
  });

  assert.equal(binding.status, "unverified_dual_snapshot");
  assert.equal(binding.algorithm, "sha256");
  assert.equal(binding.canonical_markdown.path, "methods/example.md");
  assert.match(binding.canonical_markdown.digest, /^[a-f0-9]{64}$/);
  assert.match(binding.returned_content.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(binding.canonical_markdown.digest, binding.returned_content.digest);
});

const liveExample = new URL(
  "./node_modules/lab-trust-core/examples/obsidian/seed-rhetoric.md",
  import.meta.url,
);
const liveCoreAvailable = existsSync(liveExample);
const liveCoreRequired = process.env.TRUST_CORE_LIVE_REQUIRED === "1";

test("installed public TrustCore release evaluates its packaged Obsidian example", {
  skip: liveCoreAvailable || liveCoreRequired ? false : "lab-trust-core is not installed in proposal validation",
}, async () => {
  assert.equal(liveCoreAvailable, true, "lab-trust-core release dependency must be installed");
  const markdown = readFileSync(liveExample, "utf8");
  const missingScope = await observeKnowledgeTrustShadow({
    markdown,
    path: "sources/seed-rhetoric.md",
    trustContext: {
      intended_use: "copywriting_inspiration",
      risk_level: "ordinary",
      claim_id: "C-01",
      scope: [],
    },
  });
  assert.equal(missingScope.status, "not_evaluable");
  assert.ok(missingScope.issues.some((issue) => issue.code === "SEMANTIC_SCOPE_REQUIRED"));

  const wrongScope = await observeKnowledgeTrustShadow({
    markdown,
    path: "sources/seed-rhetoric.md",
    trustContext: {
      intended_use: "copywriting_inspiration",
      risk_level: "ordinary",
      claim_id: "C-01",
      scope: ["medical advice"],
    },
  });
  assert.equal(wrongScope.status, "evaluated");
  assert.equal(wrongScope.verdict.decision, "deny");
  assert.ok(wrongScope.verdict.reason_codes.includes("SCOPE_MISMATCH"));

  const shadow = await observeKnowledgeTrustShadow({
    markdown,
    path: "sources/seed-rhetoric.md",
    trustContext: {
      intended_use: "default_answer",
      risk_level: "ordinary",
      claim_id: "C-01",
      scope: ["attention-stage sales copy"],
    },
  });

  assert.equal(shadow.status, "evaluated");
  assert.equal(shadow.engine.package_id, "lab-trust-core");
  assert.equal(shadow.engine.policy_id, "knowledge-trust-default");
  assert.equal(shadow.engine.policy_version, "1.0.0");
  assert.equal(shadow.verdict.decision, "deny");
  assert.ok(shadow.verdict.reason_codes.includes("SOURCE_NOT_DEFAULT_SURFACE"));
});
