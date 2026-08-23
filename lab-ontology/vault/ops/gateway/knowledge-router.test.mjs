import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRouteText,
  routeKnowledgeCandidates,
} from "./knowledge-router.mjs";

const restaurant = {
  slug: "methods/shanghai-restaurant-scenario-index-model",
  title: "上海餐厅场景索引与验证法",
  type: "methodology",
  aliases: ["上海餐厅选择方法", "餐厅场景索引模型", "城市餐厅候选验证流程"],
  tags: ["restaurant", "shanghai", "local-discovery", "decision-making", "verification"],
  modules: [],
  base_score: 0.97,
  excerpt: "先确定用餐任务，再按推荐信号生成候选并核验当前状态。",
};

const restaurantSynthesis = {
  slug: "syntheses/urban-restaurant-decision-system",
  title: "城市餐厅知识应采用场景、信号与对象三层索引",
  type: "synthesis",
  aliases: ["城市餐厅决策系统", "餐厅推荐三层索引", "上海餐厅知识组织模型"],
  tags: ["restaurant", "local-discovery", "decision-system", "shanghai", "recommendation"],
  modules: [],
  base_score: 0.94,
};

const hermes = {
  slug: "projects/hermes-agent-workbench",
  title: "Hermes 多 Agent 能力继承制工作台",
  type: "project",
  aliases: ["Hermes Agent Workbench", "Hermes 多 Agent 调度中枢"],
  tags: ["hermes", "multi-agent", "cli", "workbench"],
  modules: ["personal-context"],
  base_score: 0.93,
  excerpt: "Dashboard 主要负责状态展示和启动入口，运行时仍由 Hermes 管理。",
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

test("normalization folds Unicode width, case, and punctuation", () => {
  assert.equal(normalizeRouteText("Ｈｅｒｍｅｓ，Dashboard！"), "hermes dashboard");
});

test("full title match routes to read", () => {
  const result = route("请使用上海餐厅场景索引与验证法", [restaurant]);
  assert.equal(result.action, "read");
  assert.equal(result.selected[0].slug, restaurant.slug);
  assert.ok(result.reason_codes.includes("exact_title_match"));
});

test("full alias match routes to read", () => {
  const result = route("按城市餐厅候选验证流程帮我选", [restaurant]);
  assert.equal(result.action, "read");
  assert.ok(result.reason_codes.includes("exact_alias_match"));
});

test("two independent Chinese subject terms route restaurant query to read", () => {
  const result = route("推荐上海适合生日聚餐的餐厅", [unrelated, restaurant, restaurantSynthesis]);
  assert.equal(result.action, "read");
  assert.ok(result.selected.some((item) => item.slug === restaurant.slug));
});

test("unique Latin metadata anchor routes Hermes query to read", () => {
  const result = route("Hermes 的 Dashboard 应该负责什么，运行时应该放在哪里", [unrelated, hermes]);
  assert.equal(result.action, "read");
  assert.equal(result.selected[0].slug, hermes.slug);
  assert.ok(result.reason_codes.includes("unique_anchor_match"));
});

test("context can resolve a short follow-up without being persisted", () => {
  const result = route("那应该放在哪里？", [hermes], {
    context: "当前任务讨论 Hermes Dashboard 与 Agent 运行时的职责边界",
  });
  assert.equal(result.action, "read");
  assert.equal(result.selected[0].slug, hermes.slug);
  assert.ok(result.reason_codes.includes("context_metadata_match"));
});

test("vector score alone cannot trigger read", () => {
  const result = route("2+2 等于多少？", [unrelated]);
  assert.equal(result.action, "none");
  assert.equal(result.selected.length, 0);
});

test("module match alone cannot trigger read", () => {
  const result = route("帮我翻译这句话", [{ ...unrelated, modules: ["fde"] }], { module: "fde" });
  assert.equal(result.action, "none");
});

test("one location term is insufficient for automatic restaurant read", () => {
  const result = route("上海明天天气怎么样？", [restaurant]);
  assert.notEqual(result.action, "read");
});

test("arithmetic negative has zero automatic reads", () => {
  assert.notEqual(route("2+2 等于多少？", [unrelated, restaurant]).action, "read");
});

test("translation negative has zero automatic reads", () => {
  assert.notEqual(route("把这句话翻译成英文。", [hermes, unrelated]).action, "read");
});

test("email regex negative has zero automatic reads", () => {
  assert.notEqual(route("写一个邮箱正则表达式。", [hermes, unrelated]).action, "read");
});

test("Shanghai weather negative has zero automatic reads", () => {
  assert.notEqual(route("上海明天天气怎么样？", [restaurant, restaurantSynthesis]).action, "read");
});

test("QCD negative has zero automatic reads", () => {
  assert.notEqual(route("解释 QCD 渐近自由。", [unrelated, hermes]).action, "read");
});

test("source candidates are excluded from default routing", () => {
  const source = { ...restaurant, slug: "sources/restaurant-source", type: "source" };
  assert.equal(route("上海餐厅怎么选", [source]).action, "none");
});

test("raw candidates are excluded from default routing", () => {
  const raw = { ...restaurant, slug: ".raw/restaurant.md", type: "methodology" };
  assert.equal(route("上海餐厅怎么选", [raw]).action, "none");
});

test("module boost changes ordering only after relevance is established", () => {
  const global = {
    ...hermes,
    slug: "projects/hermes-global",
    modules: [],
    base_score: 0.96,
  };
  const moduleSpecific = {
    ...hermes,
    slug: "projects/hermes-personal",
    modules: ["personal-context"],
    base_score: 0.90,
  };
  const result = route("Hermes workbench", [global, moduleSpecific], { module: "personal-context" });
  assert.equal(result.action, "read");
  assert.equal(result.selected[0].slug, moduleSpecific.slug);
});

test("active decision wins a tie after relevance is established", () => {
  const method = {
    ...hermes,
    slug: "methods/hermes-runtime-boundary",
    type: "methodology",
    base_score: 0.9,
  };
  const decision = {
    ...hermes,
    slug: "decisions/hermes-runtime-boundary",
    type: "decision",
    decision_status: "active",
    base_score: 0.9,
  };
  const result = route("Hermes runtime boundary", [method, decision]);
  assert.equal(result.selected[0].slug, decision.slug);
});

test("limit bounds the selected result count", () => {
  const result = route("Hermes workbench", [
    hermes,
    { ...hermes, slug: "projects/hermes-two" },
    { ...hermes, slug: "projects/hermes-three" },
  ], { limit: 2 });
  assert.equal(result.selected.length, 2);
});

test("duplicate slugs are removed", () => {
  const result = route("Hermes workbench", [hermes, { ...hermes, base_score: 0.1 }]);
  assert.equal(result.selected.filter((item) => item.slug === hermes.slug).length, 1);
});

test("equal evidence uses base score as a stable secondary order", () => {
  const low = { ...hermes, slug: "projects/hermes-low", base_score: 0.5 };
  const high = { ...hermes, slug: "projects/hermes-high", base_score: 0.8 };
  const result = route("Hermes workbench", [low, high]);
  assert.equal(result.selected[0].slug, high.slug);
});

test("lexical weak match produces review rather than automatic read", () => {
  const result = route("上海有什么安排", [restaurant]);
  assert.equal(result.action, "review");
  assert.equal(result.selected.length, 0);
  assert.equal(result.candidates[0].slug, restaurant.slug);
});

test("high-priority keyword evidence can promote an existing weak metadata match", () => {
  const career = {
    slug: "projects/career-experience-evidence-ledger",
    title: "职业经历与项目证据账本",
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
    slug: "projects/career-experience-evidence-ledger",
    title: "职业经历与项目证据账本",
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

test("generic judgment wording cannot promote an unrelated high-priority page", () => {
  const fdeQualification = {
    slug: "methods/pronto-fde-client-and-scenario-qualification",
    title: "Pronto FDE 客户与服装业务场景资格判断法",
    type: "methodology",
    aliases: ["Pronto客户筛选", "服装AI场景筛选"],
    tags: ["Pronto", "FDE", "客户筛选", "服装业务"],
    modules: ["pronto-technology", "fde-delivery"],
    agent_priority: "high",
    retrieval_evidence: "keyword_exact",
    retrieval_rank: 3,
    base_score: 0.9308,
  };
  assert.notEqual(route("如何判断销售候选人的能力", [fdeQualification]).action, "read");
});

test("generic stop terms cannot create relevance", () => {
  const result = route("这个系统应该使用什么方法？", [restaurantSynthesis, unrelated]);
  assert.equal(result.action, "none");
});

test("keyword fallback preserves an exact explainable read", () => {
  const result = route("Hermes Agent Workbench", [hermes], {
    retrievalStatus: "degraded",
    retrievalMode: "keyword_fallback",
  });
  assert.equal(result.action, "read");
  assert.equal(result.retrieval.status, "degraded");
});

test("unavailable retrieval is explicit and never claims a match", () => {
  const result = route("Hermes Agent Workbench", [hermes], {
    retrievalStatus: "unavailable",
    retrievalMode: "none",
  });
  assert.equal(result.action, "none");
  assert.equal(result.retrieval.status, "unavailable");
  assert.ok(result.reason_codes.includes("retrieval_unavailable"));
});

test("scalar aliases and tags are normalized defensively", () => {
  const scalar = { ...hermes, aliases: "Hermes Control Plane", tags: "hermes" };
  const result = route("Use Hermes Control Plane", [scalar]);
  assert.equal(result.action, "read");
});

test("inputs are not mutated", () => {
  const candidates = [structuredClone(hermes), structuredClone(restaurant)];
  const before = structuredClone(candidates);
  route("Hermes workbench", candidates, { module: "personal-context" });
  assert.deepEqual(candidates, before);
});
