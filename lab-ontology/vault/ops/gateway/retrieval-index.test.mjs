import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { deriveSchemaRuntime, readSchemaPack } from "./schema-pack.mjs";
const EVAL_DIRECT = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
const EVAL_CLI = EVAL_DIRECT && process.argv[2] === "--eval";
// Read-only offline CLI:
//   node retrieval-index.test.mjs --eval CAPTURE.json [BASELINE-REPORT.json]
// CAPTURE = { provenance: {identity:{gitCommit, corpusDigest, embeddingModel,
// embeddingDigest}, implementation:{backend,chunkerVersion}}, outputs: {
// "golden-1": {results:[{slug,type}]},
// "route-positive-1": {action:"read",selected:[{slug,type}],candidates:[]} } }
// Semantic cases additionally require retrievalStatus:"ok" and
// arms:{vector:{status:"ok"}}; missing or degraded diagnostics fail closed.
// Missing cases fail closed. stdout is the report; exit 0 means all selected
// assertions passed. CLI does not capture data, start a gateway, or sync indexes.
// Import evaluateRetrieval({provider,cases,provenance,baseline}) for in-memory
// injection. Caller is responsible for keeping its provider read-only and for
// creating fixture pages only in an isolated corpus. Use --eval-selftest to
// validate the evaluator alone, without importing a retrieval backend.
// Versioned evaluation inputs. Every case uses the synthetic corpus below,
// which MUST be created only in an isolated evaluation repository.
export const EVAL_VERSION = "retrieval-equivalence-v3";

const golden = [
  ["温室幼苗浇水为什么不能只看固定时间", "methods/eval-greenhouse-watering"],
  ["社区展览中资助者和参观者需求不同应该怎么设计", "syntheses/eval-exhibit-stakeholder-design"],
  ["研究会议收集的联系人应该先跟进谁", "methods/eval-conference-contact-triage"],
  ["不可靠叙述如何设计线索和揭示", "methods/eval-unreliable-narration"],
  ["客服候选人应该看健谈还是倾听适应能力", "concepts/eval-support-listening-adaptability"],
  ["社区档案工具当前的产品原则", "projects/eval-community-archive"],
];
const paraphrases = [
  "给幼苗补水时，按钟点执行就够了吗？",
  "有人出资办社区展览，但实际来观看的是另一群人，方案要兼顾谁？",
  "学术会议拿到一批联系人信息，如何排出跟进顺序？",
  "故事里说话的人并不诚实，怎样让读者回头发现早有伏笔？",
  "招客服时，爱说话的人和能听懂需求再调整说法的人，选谁？",
  "保存社区历史资料的工具，现阶段哪些产品取舍不能偏？",
];

export const FIXTURE_PAGES = [
  ...golden.map(([, slug], index) => ({
    slug,
    type: ({ methods: "methodology", syntheses: "synthesis", concepts: "concept", projects: "project" })[slug.split("/")[0]],
    title: `Synthetic retrieval page ${index + 1}`,
    modules: [],
    content: `EVAL_GOLDEN_${index + 1}`,
  })),
  { slug: "projects/eval-nimbus-workbench", type: "project", title: "Nimbus Agent Workbench", modules: ["example-context"], content: "Nimbus Console runtime boundary" },
  { slug: "projects/eval-profile-ledger", type: "project", title: "示例经历证据账本", modules: ["example-context"], content: "只包含合成的示例经历" },
  { slug: "methods/eval-global-research-review", type: "methodology", title: "研究资料审阅", modules: [], content: "EVAL_SCOPE_SENTINEL 研究资料审阅" },
  { slug: "methods/eval-module-research-review", type: "methodology", title: "研究资料审阅", modules: ["example-research"], content: "EVAL_SCOPE_SENTINEL 研究资料审阅" },
  { slug: "sources/eval-unverified", type: "source", title: "待验证来源", modules: [], content: "EVAL_SCOPE_SENTINEL" },
  { slug: ".raw/eval-private", type: "raw", title: "禁止索引", modules: [], content: "EVAL_SCOPE_SENTINEL EVAL_RAW_ONLY_SENTINEL" },
];
const scopePages = FIXTURE_PAGES.slice(-4);

export const EVAL_CASES = [
  ...golden.map(([query, slug], i) => ({ id: `golden-${i + 1}`, group: "golden", corpus: "fixture", kind: "search", query, scope: "result", relevant: [slug], maxRank: 3 })),
  ...paraphrases.slice(0, 5).map((query, i) => ({ id: `semantic-${i + 1}`, group: "chinese-paraphrase", corpus: "fixture", kind: "search", query, scope: "result", relevant: [golden[i][1]], maxRank: 5, requiredRetrievalStatus: "ok", requiredArms: ["vector"], labelStatus: "provisional-agent-authored" })),
  { id: "semantic-6", group: "chinese-paraphrase", corpus: "fixture", kind: "search", query: paraphrases[5], scope: "result", relevant: ["syntheses/eval-exhibit-stakeholder-design", "projects/eval-community-archive"], requireAll: false, maxRank: 5, requiredRetrievalStatus: "ok", requiredArms: ["vector"], labelStatus: "independent-reviewed" },
  ...[
    ["温室植物该如何安排浇水", ["methods/eval-greenhouse-watering"]],
    ["Nimbus 的 Console 应该负责什么，运行时应该放在哪里", ["projects/eval-nimbus-workbench"]],
    ["根据示例经历生成一份资料摘要", ["projects/eval-profile-ledger"]],
  ].map(([query, relevant], i) => ({ id: `route-positive-${i + 1}`, group: "route-positive", corpus: "fixture", kind: "route", query, scope: "result", relevant, action: "read", requireAny: true })),
  ...["2+2 等于多少？", "把这句话翻译成英文。", "写一个邮箱正则表达式。", "北京明天天气怎么样？", "解释 QCD 渐近自由。", "今天美元兑人民币汇率是多少", "如何判断销售候选人的能力"]
    .map((query, i) => ({ id: `route-negative-${i + 1}`, group: "route-negative", corpus: "fixture", kind: "route", query, scope: "result", forbidRead: true })),
  { id: "scope-result", group: "scope", corpus: "fixture", kind: "search", query: "EVAL_SCOPE_SENTINEL", scope: "result", relevant: [scopePages[0].slug, scopePages[1].slug], requireAll: true, maxRank: 5 },
  { id: "scope-evidence", group: "scope", corpus: "fixture", kind: "search", query: "EVAL_SCOPE_SENTINEL", scope: "evidence", relevant: [scopePages[2].slug], maxRank: 5 },
  { id: "scope-raw", group: "scope", corpus: "fixture", kind: "search", query: "EVAL_RAW_ONLY_SENTINEL", scope: "all", forbid: [scopePages[3].slug] },
  { id: "module-global", group: "module", corpus: "fixture", kind: "search", query: "研究资料审阅", scope: "result", relevant: [scopePages[0].slug, scopePages[1].slug], requireAll: true, expectedFirst: scopePages[0].slug },
  { id: "module-boost", group: "module", corpus: "fixture", kind: "search", query: "研究资料审阅", scope: "result", module: "example-research", relevant: [scopePages[0].slug, scopePages[1].slug], requireAll: true, expectedFirst: scopePages[1].slug },
  { id: "module-unrelated", group: "module", corpus: "fixture", kind: "route", query: "把这句话翻译成英文。", scope: "result", module: "example-research", forbidRead: true },
];
// Pure evaluation: no gateway startup, repair, sync, DB or filesystem writes.
// Inject a read-only `provider(case)` function, or supply captured JSON via CLI.

const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function metrics(slugs, relevant) {
  const wanted = new Set(relevant);
  if (!wanted.size) return null;
  const found = slugs.slice(0, 10).findIndex((slug) => wanted.has(slug));
  const dcg = slugs.slice(0, 10).reduce((sum, slug, i) => sum + (wanted.has(slug) ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = [...wanted].slice(0, 10).reduce((sum, _, i) => sum + 1 / Math.log2(i + 2), 0);
  return { recallAt5: slugs.slice(0, 5).filter((slug) => wanted.has(slug)).length / wanted.size, mrrAt10: found < 0 ? 0 : 1 / (found + 1), ndcgAt10: dcg / ideal };
}

function inspect(testCase, output, schemaRuntime) {
  const issues = [];
  const routing = testCase.kind === "route";
  if (!output || typeof output !== "object" || output.ok === false || output.isError) throw new Error("Provider returned an error or invalid envelope");
  const reportedStatuses = [output.retrievalStatus, output.retrieval?.status].filter((value) => value !== undefined);
  const retrievalStatus = reportedStatuses[0] ?? null;
  const arms = output.arms ?? output.retrieval?.arms ?? {};
  if (testCase.requiredRetrievalStatus && (reportedStatuses.length === 0 || reportedStatuses.some((value) => value !== testCase.requiredRetrievalStatus))) issues.push("required_retrieval_status_not_met");
  for (const arm of testCase.requiredArms || []) {
    const armStatuses = [output.arms?.[arm]?.status, output.retrieval?.arms?.[arm]?.status].filter((value) => value !== undefined);
    if (armStatuses.length === 0 || armStatuses.some((value) => value !== "ok")) issues.push(`required_arm_not_ok:${arm}`);
  }
  if (routing && !["read", "review", "none"].includes(output.action)) issues.push("invalid_action");
  const results = routing ? output.selected : output.results;
  if (!Array.isArray(results)) throw new Error(`Missing ${routing ? "selected" : "results"} array`);
  if (routing && !Array.isArray(output.candidates)) throw new Error("Missing candidates array");
  const inspected = routing ? [...results, ...output.candidates] : results;
  for (const hit of inspected) {
    if (!hit || typeof hit.slug !== "string" || typeof hit.type !== "string") { issues.push("malformed_hit"); continue; }
    if (hit.slug.startsWith(".raw/") || hit.type === "raw") issues.push("raw_leak");
    const canonical = schemaRuntime.typeForPath(hit.slug) === hit.type;
    if (testCase.scope === "result" && (!canonical || !schemaRuntime.scopeAllows(hit.type, "result"))) issues.push("evidence_leak");
    if (testCase.scope === "evidence" && (!canonical || !schemaRuntime.scopeAllows(hit.type, "evidence"))) issues.push("result_in_evidence");
  }
  const slugs = results.map((hit) => hit?.slug);
  if (new Set(slugs).size !== slugs.length) issues.push("duplicate_results");
  if (testCase.action && output.action !== testCase.action) issues.push("wrong_route_action");
  if (routing && output.action !== "read" && slugs.length) issues.push("non_read_has_selected");
  if (testCase.forbidRead && (output.action === "read" || slugs.length || (output.body_reads ?? 0) > 0)) issues.push("negative_auto_read");
  if (testCase.forbid?.some((slug) => slugs.includes(slug))) issues.push("forbidden_hit");
  if (testCase.expectedFirst && slugs[0] !== testCase.expectedFirst) issues.push("wrong_first_result");
  const relevant = testCase.relevant || [];
  const ranks = relevant.map((slug) => slugs.indexOf(slug) + 1);
  const cutoff = testCase.maxRank || 10;
  if (relevant.length) {
    const passed = ranks.map((rank) => rank > 0 && rank <= cutoff);
    if (!(testCase.requireAll ? passed.every(Boolean) : passed.some(Boolean))) issues.push("relevant_rank_miss");
  }
  return { id: testCase.id, group: testCase.group, corpus: testCase.corpus, passed: issues.length === 0, issues: [...new Set(issues)], metrics: metrics(slugs, relevant), ranks, slugs, retrievalStatus, arms };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function evalProvenance(provenance, cases) {
  // Flat captures remain readable, but new reports separate immutable evaluation
  // identity from the implementation variables intentionally compared in an A/B.
  const rawIdentity = provenance.identity || provenance;
  const identity = Object.fromEntries(["gitCommit", "corpusDigest", "embeddingModel", "embeddingDigest"].map((key) => [key, rawIdentity[key] ?? null]));
  identity.caseDigest = createHash("sha256").update(stableJson(cases)).digest("hex");
  if (rawIdentity.embeddingConfigDigest !== undefined) identity.embeddingConfigDigest = rawIdentity.embeddingConfigDigest;
  const implementation = provenance.implementation || { backend: provenance.backend ?? null, chunkerVersion: provenance.chunkerVersion ?? null };
  return { identity, implementation };
}

export async function evaluateRetrieval({ provider, cases = EVAL_CASES, baseline = null, provenance = {},
  schemaRuntime = deriveSchemaRuntime(readSchemaPack(path.resolve(fileURLToPath(new URL("../..", import.meta.url))))) }) {
  if (typeof provider !== "function") throw new Error("A read-only provider function is required");
  const normalizedProvenance = evalProvenance(provenance, cases);
  const rows = [];
  for (const testCase of cases) {
    const start = performance.now();
    try { rows.push({ ...inspect(testCase, await provider(testCase), schemaRuntime), durationMs: performance.now() - start }); }
    catch (error) { rows.push({ id: testCase.id, group: testCase.group, corpus: testCase.corpus, passed: false, issues: ["provider_error"], error: String(error.message), metrics: null, durationMs: performance.now() - start }); }
  }
  const groups = {};
  for (const group of new Set(rows.map((row) => row.group))) {
    const selected = rows.filter((row) => row.group === group);
    const scored = selected.filter((row) => row.metrics);
    groups[group] = { cases: selected.length, passed: selected.filter((row) => row.passed).length, recallAt5: mean(scored.map((row) => row.metrics.recallAt5)), mrrAt10: mean(scored.map((row) => row.metrics.mrrAt10)), ndcgAt10: mean(scored.map((row) => row.metrics.ndcgAt10)) };
  }
  const regressions = [];
  const implementationChanges = [];
  if (baseline) {
    if (baseline.version !== EVAL_VERSION) regressions.push("incomparable_eval_version");
    for (const before of baseline.cases || []) {
      if (!rows.some((row) => row.id === before.id)) regressions.push(`dropped_case:${before.id}`);
    }
    const beforeIdentity = baseline.provenance?.identity || {};
    for (const key of new Set([...Object.keys(normalizedProvenance.identity), ...Object.keys(beforeIdentity)])) {
      if (!normalizedProvenance.identity[key] || normalizedProvenance.identity[key] !== beforeIdentity[key]) regressions.push(`incomparable_identity:${key}`);
    }
    const beforeImplementation = baseline.provenance?.implementation || {};
    for (const key of new Set([...Object.keys(normalizedProvenance.implementation), ...Object.keys(beforeImplementation)])) {
      const before = beforeImplementation[key] ?? null;
      const after = normalizedProvenance.implementation[key] ?? null;
      if (stableJson(before) !== stableJson(after)) implementationChanges.push({ field: key, before, after });
    }
    for (const row of rows) {
      const before = baseline.cases?.find((item) => item.id === row.id);
      if (!before) { regressions.push(`missing_baseline:${row.id}`); continue; }
      if (before.passed && !row.passed) regressions.push(`case_regression:${row.id}`);
      for (const metric of ["recallAt5", "mrrAt10", "ndcgAt10"]) {
        if (before.metrics?.[metric] != null && (row.metrics?.[metric] ?? -1) < before.metrics[metric]) regressions.push(`metric_regression:${row.id}:${metric}`);
      }
    }
  }
  return { version: EVAL_VERSION, passed: rows.every((row) => row.passed) && regressions.length === 0, provenance: normalizedProvenance, implementationChanges, total: rows.length, groups, regressions, cases: rows, boundary: "Evaluator correctness and case results are not proof of real-provider equivalence. Offline replay latency excludes provider latency. Semantic labels are provisional and need independent review. Backend and chunker changes are reported A/B variables, not identity drift." };
}

export function offlineProvider(capture) {
  if (!capture || typeof capture.outputs !== "object" || Array.isArray(capture.outputs)) throw new Error("Capture must contain outputs keyed by case ID");
  return async ({ id }) => {
    if (!Object.hasOwn(capture.outputs, id)) throw new Error(`Missing offline case: ${id}`);
    return capture.outputs[id];
  };
}

if (EVAL_CLI) {
  try {
    const [capturePath, baselinePath] = process.argv.slice(3);
    if (!capturePath) throw new Error("Usage: node retrieval-index.test.mjs --eval CAPTURE.json [BASELINE-REPORT.json]");
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
    const report = await evaluateRetrieval({ provider: offlineProvider(capture), provenance: capture.provenance || {}, baseline });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

// Harness tests use synthetic, perfect outputs to validate the evaluator,
// NOT to claim that a real retrieval provider has passed this suite.
if (EVAL_DIRECT && !EVAL_CLI) {
  const provenance = { gitCommit: "fixture-commit", corpusDigest: "fixture-corpus", embeddingModel: "fixture-model", embeddingDigest: "fixture-digest", backend: "old", chunkerVersion: "fixture-v1" };
  function oracle(testCase) {
    const typeFor = (slug) => ({ methods: "methodology", concepts: "concept", projects: "project", syntheses: "synthesis", sources: "source" })[slug.split("/")[0]];
    const slugs = [...(testCase.relevant || [])];
    if (testCase.expectedFirst) slugs.sort((a, b) => Number(b === testCase.expectedFirst) - Number(a === testCase.expectedFirst));
    const results = slugs.map((slug) => ({ slug, type: typeFor(slug) }));
    const diagnostics = { retrievalStatus: "ok", arms: { lexical: { status: "ok" }, vector: { status: "ok" } } };
    return testCase.kind === "route" ? { action: testCase.forbidRead ? "none" : "read", selected: results, candidates: [], body_reads: 0, ...diagnostics } : { results, ...diagnostics };
  }

  test("readonly eval preserves all six synthetic golden cases and declared coverage", () => {
    assert.equal(EVAL_CASES.filter((item) => item.group === "golden").length, 6);
    assert.equal(EVAL_CASES.filter((item) => item.group === "chinese-paraphrase").length, 6);
    assert.equal(EVAL_CASES.length, 28);
    assert.equal(new Set(EVAL_CASES.map((item) => item.id)).size, EVAL_CASES.length);
    assert.ok(FIXTURE_PAGES.some((item) => item.type === "raw"));
  });

  test("readonly eval computes perfect metrics only for perfect synthetic outputs", async () => {
    const report = await evaluateRetrieval({ provider: async (item) => oracle(item), provenance });
    assert.equal(report.passed, true);
    assert.equal(report.groups.golden.recallAt5, 1);
    assert.equal(report.groups.golden.mrrAt10, 1);
    assert.equal(report.groups.golden.ndcgAt10, 1);
    assert.equal(report.groups["route-negative"].passed, 7);
  });

  test("reviewed semantic-6 accepts either relevant page without converting other provisional labels", async () => {
    const reviewed = EVAL_CASES.find((item) => item.id === "semantic-6");
    assert.equal(reviewed.labelStatus, "independent-reviewed");
    assert.equal(reviewed.requireAll, false);
    assert.deepEqual(reviewed.relevant, ["syntheses/eval-exhibit-stakeholder-design", "projects/eval-community-archive"]);
    for (const slug of reviewed.relevant) {
      const output = oracle(reviewed);
      output.results = output.results.filter((item) => item.slug === slug);
      const report = await evaluateRetrieval({ provider: () => output, cases: [reviewed], provenance });
      assert.equal(report.passed, true, slug);
    }
    const provisional = EVAL_CASES.filter((item) => item.group === "chinese-paraphrase" && item.id !== "semantic-6");
    assert.equal(provisional.length, 5);
    assert.ok(provisional.every((item) => item.labelStatus === "provisional-agent-authored" && item.relevant.length === 1));
  });

  test("readonly eval catches rank, route, scope and module regressions", async () => {
    const outputs = Object.fromEntries(EVAL_CASES.map((item) => [item.id, oracle(item)]));
    outputs["golden-1"].results = [];
    outputs["semantic-2"].results = [];
    outputs["route-positive-1"].action = "review";
    outputs["route-negative-1"].action = "read";
    outputs["scope-result"].results.push({ slug: "sources/eval-unverified", type: "source" });
    outputs["scope-evidence"].results.push({ slug: "methods/eval-global-research-review", type: "methodology" });
    outputs["scope-raw"].results.push({ slug: ".raw/eval-private", type: "raw" });
    outputs["module-boost"].results.reverse();
    outputs["module-unrelated"].body_reads = 1;
    const report = await evaluateRetrieval({ provider: offlineProvider({ outputs }), provenance });
    assert.equal(report.passed, false);
    for (const id of ["golden-1", "semantic-2", "route-positive-1", "route-negative-1", "scope-result", "scope-evidence", "scope-raw", "module-boost", "module-unrelated"]) {
      assert.equal(report.cases.find((item) => item.id === id).passed, false, id);
    }
  });

  test("readonly eval fails closed on missing captures, malformed data and duplicates", async () => {
    const report = await evaluateRetrieval({ provider: offlineProvider({ outputs: { "golden-1": { results: [{ slug: "x" }] }, "golden-2": { results: [...oracle(EVAL_CASES[1]).results, ...oracle(EVAL_CASES[1]).results] } } }) });
    assert.equal(report.passed, false);
    assert.ok(report.cases[0].issues.includes("malformed_hit"));
    assert.ok(report.cases[1].issues.includes("duplicate_results"));
    assert.ok(report.cases[2].issues.includes("provider_error"));
  });

  test("readonly eval rejects changed provenance, missing baseline and dropped cases", async () => {
    const baseline = await evaluateRetrieval({ provider: oracle, provenance });
    const same = await evaluateRetrieval({ provider: oracle, provenance, baseline });
    assert.equal(same.passed, true);
    const mismatch = await evaluateRetrieval({ provider: oracle, provenance: { ...provenance, embeddingModel: "changed" }, baseline });
    assert.ok(mismatch.regressions.includes("incomparable_identity:embeddingModel"));
    const dropped = await evaluateRetrieval({ provider: oracle, provenance, baseline, cases: EVAL_CASES.slice(1) });
    assert.ok(dropped.regressions.includes("dropped_case:golden-1"));
  });

  test("readonly eval notices quality degradation even while top-three golden gate passes", async () => {
    const baseline = await evaluateRetrieval({ provider: oracle, provenance });
    const report = await evaluateRetrieval({ provider: (item) => {
      const output = oracle(item);
      if (item.id === "golden-1") output.results.unshift({ slug: "methods/unrelated", type: "methodology" });
      return output;
    }, provenance, baseline });
    assert.equal(report.cases[0].passed, true);
    assert.equal(report.passed, false);
    assert.ok(report.regressions.includes("metric_regression:golden-1:mrrAt10"));
  });

  test("semantic eval cannot pass on keyword hits when vector health is missing or degraded", async () => {
    const semantic = EVAL_CASES.find((item) => item.id === "semantic-1");
    for (const mutate of [
      (output) => { output.arms.vector.status = "unavailable"; output.retrievalStatus = "degraded"; },
      (output) => { delete output.arms.vector; },
      (output) => { output.arms.vector.status = "degraded"; },
      (output) => { delete output.retrievalStatus; },
      (output) => { output.retrievalStatus = "unavailable"; },
      (output) => { output.retrieval = { status: "degraded", arms: { vector: { status: "unavailable" } } }; },
    ]) {
      const output = oracle(semantic);
      mutate(output);
      const report = await evaluateRetrieval({ provider: () => output, cases: [semantic], provenance });
      assert.equal(report.cases[0].metrics.recallAt5, 1, "oracle still returns the expected hit");
      assert.equal(report.passed, false, JSON.stringify(output));
      assert.ok(report.cases[0].issues.some((issue) => issue.startsWith("required_")));
    }
    const nested = oracle(semantic);
    nested.retrieval = { status: nested.retrievalStatus, arms: nested.arms };
    delete nested.retrievalStatus;
    delete nested.arms;
    assert.equal((await evaluateRetrieval({ provider: () => nested, cases: [semantic], provenance })).passed, true);
  });

  test("eval permits deliberate backend and chunker A/B while recording implementation changes", async () => {
    const baseline = await evaluateRetrieval({ provider: oracle, provenance });
    const report = await evaluateRetrieval({ provider: oracle, baseline, provenance: {
      identity: { gitCommit: provenance.gitCommit, corpusDigest: provenance.corpusDigest, embeddingModel: provenance.embeddingModel, embeddingDigest: provenance.embeddingDigest },
      implementation: { backend: "native", chunkerVersion: "heading-aware-v2" },
    } });
    assert.equal(report.passed, true);
    assert.deepEqual(report.implementationChanges.map((item) => item.field).sort(), ["backend", "chunkerVersion"]);
    assert.equal(report.provenance.identity.caseDigest, baseline.provenance.identity.caseDigest);
  });

  test("eval rejects corpus, query, relevance-label and model drift during implementation A/B", async () => {
    const baseline = await evaluateRetrieval({ provider: oracle, provenance });
    for (const key of ["gitCommit", "corpusDigest", "embeddingModel", "embeddingDigest"]) {
      const report = await evaluateRetrieval({ provider: oracle, baseline, provenance: { ...provenance, [key]: "changed", chunkerVersion: "new-chunker" } });
      assert.equal(report.passed, false);
      assert.ok(report.regressions.includes(`incomparable_identity:${key}`));
    }
    for (const update of [{ query: "changed question" }, { relevant: ["methods/changed-label"] }, { requiredArms: [] }]) {
      const cases = EVAL_CASES.map((item, i) => i === 0 ? { ...item, ...update } : item);
      const report = await evaluateRetrieval({ provider: oracle, baseline, provenance, cases });
      assert.equal(report.passed, false);
      assert.ok(report.regressions.includes("incomparable_identity:caseDigest"));
    }
    const missingCorpus = { ...provenance };
    delete missingCorpus.corpusDigest;
    assert.ok((await evaluateRetrieval({ provider: oracle, baseline, provenance: missingCorpus })).regressions.includes("incomparable_identity:corpusDigest"));
  });
}
