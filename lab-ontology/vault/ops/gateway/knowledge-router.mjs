import { createHash } from "node:crypto";
import { deriveSchemaRuntime, readSchemaPack } from "./schema-pack.mjs";

const LATIN_STOP_TERMS = new Set([
  "agent",
  "content",
  "current",
  "how",
  "knowledge",
  "method",
  "methods",
  "project",
  "projects",
  "should",
  "system",
  "the",
  "use",
  "what",
  "where",
  "why",
]);

const CJK_STOP_TERMS = new Set([
  "一下",
  "一个",
  "什么",
  "为什么",
  "使用",
  "内容",
  "可以",
  "哪个",
  "哪里",
  "如何",
  "应该",
  "当前",
  "判断",
  "推荐",
  "方法",
  "是否",
  "有关",
  "模型",
  "知识",
  "系统",
  "这个",
  "进行",
  "适合",
  "问题",
  "项目",
]);

export const ROUTER_THRESHOLDS = Object.freeze({
  latinAnchorLength: 5,
  cjkAnchorLength: 4,
  minimumIndependentCjkTerms: 2,
  moduleBoost: 6,
  activeDecisionBoost: 2,
});

export function normalizeRouteText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function asList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

function latinTerms(text) {
  const matches = normalizeRouteText(text).match(/[\p{Script=Latin}\p{Number}]+/gu) || [];
  return new Set(matches.filter((term) => term.length >= 2 && !LATIN_STOP_TERMS.has(term)));
}

function cjkNgrams(text, size) {
  const grams = new Set();
  const segments = normalizeRouteText(text).match(/\p{Script=Han}+/gu) || [];
  for (const segment of segments) {
    const characters = [...segment];
    for (let index = 0; index <= characters.length - size; index += 1) {
      const gram = characters.slice(index, index + size).join("");
      if (CJK_STOP_TERMS.has(gram)) continue;
      grams.add(gram);
    }
  }
  return grams;
}

function intersection(left, right) {
  return [...left].filter((item) => right.has(item));
}

function fieldIsDistinctive(value) {
  const normalized = normalizeRouteText(value);
  if (!normalized) return false;
  const compact = normalized.replaceAll(" ", "");
  return compact.length >= 4 && !CJK_STOP_TERMS.has(compact) && !LATIN_STOP_TERMS.has(compact);
}

function profile(text) {
  return {
    normalized: normalizeRouteText(text),
    latin: latinTerms(text),
    cjk2: cjkNgrams(text, 2),
    cjk4: cjkNgrams(text, ROUTER_THRESHOLDS.cjkAnchorLength),
  };
}

// Shared with the local Markdown catalog so candidate recall and the
// precision-first route gate use the same normalization and stop-term rules.
// Returning fresh Sets keeps callers from mutating router-global state.
export function routeTextProfile(text) {
  return profile(text);
}

function candidateProfile(candidate) {
  const aliases = asList(candidate.aliases);
  const tags = asList(candidate.tags);
  const slugName = String(candidate.slug || "").split("/").at(-1)?.replaceAll("-", " ") || "";
  const fields = [candidate.title, ...aliases, ...tags, slugName].filter(Boolean);
  return {
    aliases,
    title: normalizeRouteText(candidate.title),
    normalizedAliases: aliases.map(normalizeRouteText),
    tokens: profile(fields.join(" ")),
  };
}

function signalForText(textProfile, candidate, metadata) {
  const exactTitle = fieldIsDistinctive(candidate.title)
    && textProfile.normalized.includes(metadata.title);
  const exactAlias = metadata.normalizedAliases.some((alias, index) => (
    fieldIsDistinctive(metadata.aliases[index])
    && textProfile.normalized.includes(alias)
  ));
  const latinMatches = intersection(textProfile.latin, metadata.tokens.latin);
  const cjk2Matches = intersection(textProfile.cjk2, metadata.tokens.cjk2);
  const cjk4Matches = intersection(textProfile.cjk4, metadata.tokens.cjk4);
  const uniqueLatinAnchors = latinMatches.filter(
    (term) => term.length >= ROUTER_THRESHOLDS.latinAnchorLength,
  );
  const uniqueAnchor = uniqueLatinAnchors.length > 0 || cjk4Matches.length > 0;
  const multiTerm = cjk2Matches.length >= ROUTER_THRESHOLDS.minimumIndependentCjkTerms
    || latinMatches.length >= 2;
  const weak = latinMatches.length > 0 || cjk2Matches.length > 0;
  const strong = exactTitle || exactAlias || uniqueAnchor || multiTerm;

  return {
    exactTitle,
    exactAlias,
    latinMatches,
    cjk2Matches,
    cjk4Matches,
    uniqueAnchor,
    multiTerm,
    weak,
    strong,
    matchTerms: [...new Set([
      ...uniqueLatinAnchors,
      ...cjk4Matches,
      ...cjk2Matches,
      ...latinMatches,
    ])].slice(0, 12),
  };
}

function sameModule(requested, modules) {
  if (!requested) return false;
  const normalized = normalizeRouteText(requested);
  return asList(modules).some((item) => normalizeRouteText(item) === normalized);
}

function metadataSnapshot(candidate) {
  const values = (items) => [...new Set(asList(items).map(normalizeRouteText))].sort();
  return {
    slug: String(candidate.slug || ""), title: normalizeRouteText(candidate.title),
    aliases: values(candidate.aliases), tags: values(candidate.tags),
  };
}

function metadataFingerprint(candidate) {
  return createHash("sha256").update(JSON.stringify(metadataSnapshot(candidate))).digest("hex");
}

function textFingerprint(text) {
  return createHash("sha256").update(normalizeRouteText(text)).digest("hex");
}

function lexicalMetadataMatches(query, candidate) {
  const queryProfile = profile(query);
  const snapshot = metadataSnapshot(candidate);
  const fields = {
    title: snapshot.title, aliases: snapshot.aliases.join(" "), tags: snapshot.tags.join(" "),
    slug: snapshot.slug.split("/").at(-1)?.replaceAll("-", " ") || "",
  };
  const fieldWeights = { title: 8, aliases: 7, tags: 4, slug: 3 };
  const matches = [];
  let score = 0;
  for (const [field, value] of Object.entries(fields)) {
    const fieldProfile = profile(value);
    const terms = [...new Set([
      ...intersection(queryProfile.cjk4, fieldProfile.cjk4),
      ...intersection(queryProfile.cjk2, fieldProfile.cjk2),
      ...intersection(queryProfile.latin, fieldProfile.latin),
    ])].sort();
    for (const term of terms) {
      matches.push({ field, term });
      score += fieldWeights[field] * (term.length >= 4 ? 3 : 1);
    }
  }
  return { matches, score };
}

// Backend-neutral, metadata-only evidence. Provider vector/BM25/fusion scores
// never enter this contract. Consumers re-check both query and current page
// metadata, so a stale body hit cannot masquerade as a canonical title hit.
export function buildLexicalMetadataEvidence({ query, candidates }) {
  const universe = candidates.map(metadataSnapshot).sort((left, right) => left.slug.localeCompare(right.slug));
  const universeHash = createHash("sha256").update(JSON.stringify(universe)).digest("hex");
  const rows = candidates.map((candidate) => ({ candidate, ...lexicalMetadataMatches(query, candidate) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || String(left.candidate.slug).localeCompare(String(right.candidate.slug)));
  return new Map(rows.map((row) => [row.candidate.slug, {
    version: 2, source: "canonical_metadata", query_hash: textFingerprint(query),
    metadata_universe_hash: universeHash, metadata_universe_count: universe.length,
    metadata_hash: metadataFingerprint(row.candidate),
    metadata_rank: rows.filter((item) => item.score > row.score).length + 1,
    rank_tie_count: rows.filter((item) => item.score === row.score).length,
    matches: row.matches,
  }]));
}

function hasExplicitPersonalContextRequest(queryProfile, contextProfile) {
  const text = `${queryProfile.normalized} ${contextProfile.normalized}`.trim();
  return /(?:根据|结合|参考|对照|回顾|梳理|利用|基于)\s*(?:一下\s*)?(?:我|我们)(?:的|已有|之前|过去|当前)/u.test(text)
    || /\b(?:based on|using|given|consider|review)\s+(?:my|our)\b/u.test(text);
}

function excludesPersonalContext(text) {
  const normalized = normalizeRouteText(text);
  return /(?:不要|不需要|无需|不用|勿|别|不必|不想|不能)\s*.{0,12}?(?:根据|基于|参考|结合|利用|对照|回顾|梳理|使用|用)\s*.{0,8}?(?:我|我们)/u.test(normalized)
    || /\b(?:without|do not|don t|dont|never|no need to)\b(?:\s+[a-z]+){0,8}\s+(?:my|our)\b/u.test(normalized);
}

function verifiedLexicalMetadata(candidate, recomputedEvidence) {
  const evidence = candidate.lexical_metadata;
  if (!recomputedEvidence || !evidence || evidence.version !== 2 || evidence.source !== "canonical_metadata"
    || evidence.metadata_rank !== 1 || evidence.rank_tie_count !== 1
    || evidence.metadata_hash !== metadataFingerprint(candidate)) return false;
  // Rank and ties are recomputed from the host-supplied COMPLETE canonical
  // Result metadata universe, never from the truncated retrieval candidates.
  // Its hash/count prevent a provider's subset from asserting global uniqueness.
  for (const field of ["version", "source", "query_hash", "metadata_hash", "metadata_universe_hash",
    "metadata_universe_count", "metadata_rank", "rank_tie_count"]) {
    if (evidence[field] !== recomputedEvidence[field]) return false;
  }
  return Array.isArray(evidence.matches) && evidence.matches.length > 0
    && JSON.stringify(evidence.matches) === JSON.stringify(recomputedEvidence.matches)
    && recomputedEvidence.matches.some(({ field }) => field === "title" || field === "aliases");
}

function scoreCandidate(candidate, queryProfile, contextProfile, requestedModule, recomputedEvidence = null, personalContextExcluded = false) {
  const metadata = candidateProfile(candidate);
  const query = signalForText(queryProfile, candidate, metadata);
  const context = signalForText(contextProfile, candidate, metadata);
  const baseScore = Number.isFinite(Number(candidate.base_score))
    ? Number(candidate.base_score)
    : Number.isFinite(Number(candidate.score))
      ? Number(candidate.score)
      : 0;
  const retrievalRank = Number.isInteger(Number(candidate.retrieval_rank))
    ? Number(candidate.retrieval_rank)
    : null;
  // Explicit canonical classification, not a guess from a title or body. A
  // negated personal request must not suppress unrelated general methods in
  // the same query. Classified personal pages stay review-only even when their
  // title occurs inside the negation or an older provider reports keyword_exact.
  const excludedPersonalCandidate = personalContextExcluded
    && [...asList(candidate.modules), ...asList(candidate.tags)]
      .some((value) => normalizeRouteText(value) === "personal context");
  const priorityKeywordMatch = !excludedPersonalCandidate && (query.weak || context.weak)
    && String(candidate.agent_priority || "") === "high"
    && String(candidate.retrieval_evidence || "") === "keyword_exact"
    && baseScore >= 0.9
    && retrievalRank !== null
    && retrievalRank <= 3;
  const personalMetadataMatch = !personalContextExcluded && (query.weak || context.weak)
    && String(candidate.agent_priority || "") === "high"
    && retrievalRank !== null && retrievalRank >= 1 && retrievalRank <= 3
    && hasExplicitPersonalContextRequest(queryProfile, contextProfile)
    && verifiedLexicalMetadata(candidate, recomputedEvidence);
  const strong = !excludedPersonalCandidate
    && (query.strong || context.strong || priorityKeywordMatch || personalMetadataMatch);
  const weak = strong || query.weak || context.weak;
  const reasons = [];
  let routeScore = 0;

  if (excludedPersonalCandidate) reasons.push("personal_context_explicitly_excluded");

  if (query.exactTitle || context.exactTitle) {
    reasons.push("exact_title_match");
    routeScore += 100;
  }
  if (query.exactAlias || context.exactAlias) {
    reasons.push("exact_alias_match");
    routeScore += 95;
  }
  if (query.uniqueAnchor || context.uniqueAnchor) {
    reasons.push("unique_anchor_match");
    routeScore += 70;
  }
  if (query.multiTerm || context.multiTerm) {
    reasons.push("multi_term_metadata_match");
    routeScore += 55;
  }
  if (priorityKeywordMatch) {
    reasons.push("high_priority_keyword_match");
    routeScore += 45;
  }
  if (personalMetadataMatch) {
    reasons.push("high_priority_personal_metadata_match");
    routeScore += 45;
  }
  if (!strong && weak) {
    reasons.push("weak_metadata_match");
    routeScore += 20;
  }
  if (context.strong || (!query.weak && context.weak)) {
    reasons.push("context_metadata_match");
    routeScore += context.strong ? 4 : 1;
  }

  const moduleMatch = sameModule(requestedModule, candidate.modules);
  if (weak && moduleMatch) {
    reasons.push("module_boost");
    routeScore += ROUTER_THRESHOLDS.moduleBoost;
  }
  if (
    weak
    && candidate.type === "decision"
    && String(candidate.decision_status || "") === "active"
  ) {
    reasons.push("active_decision_boost");
    routeScore += ROUTER_THRESHOLDS.activeDecisionBoost;
  }

  routeScore += Math.max(0, Math.min(1, baseScore));

  return {
    slug: String(candidate.slug),
    title: String(candidate.title || candidate.slug),
    type: candidate.type,
    base_score: Number(baseScore.toFixed(4)),
    route_score: Number(routeScore.toFixed(4)),
    agent_priority: candidate.agent_priority || null,
    retrieval_evidence: candidate.retrieval_evidence || null,
    lexical_metadata_verified: personalMetadataMatch,
    retrieval_rank: retrievalRank,
    modules: asList(candidate.modules),
    module_match: moduleMatch,
    match_reasons: reasons,
    match_terms: [...new Set([...query.matchTerms, ...context.matchTerms])].slice(0, 12),
    strong,
    weak,
  };
}

function isResultCandidate(candidate, schemaRuntime) {
  const slug = String(candidate?.slug || "");
  return Boolean(slug)
    && schemaRuntime.typeForPath(slug) === candidate?.type
    && schemaRuntime.scopeAllows(candidate?.type, "result");
}

function byRoutePriority(left, right) {
  return right.route_score - left.route_score
    || right.base_score - left.base_score
    || left.slug.localeCompare(right.slug, "en");
}

function publicCandidate(candidate) {
  const { strong: _strong, weak: _weak, ...publicFields } = candidate;
  return publicFields;
}

export function routeKnowledgeCandidates({
  query,
  context = "",
  module = null,
  candidates = [],
  metadataUniverse = null,
  retrievalStatus = "ok",
  retrievalMode = "hybrid",
  limit = 5,
  root = null,
  schemaRuntime = null,
} = {}) {
  const boundedLimit = Math.max(1, Math.min(10, Number(limit) || 5));
  const retrieval = {
    status: retrievalStatus,
    mode: retrievalMode,
    candidate_count: Array.isArray(candidates) ? candidates.length : 0,
  };

  if (retrievalStatus === "unavailable") {
    return {
      action: "none",
      reason_codes: ["retrieval_unavailable"],
      retrieval,
      selected: [],
      candidates: [],
    };
  }
  const runtime = schemaRuntime || deriveSchemaRuntime(readSchemaPack(root));

  const combinedText = [query, context].filter((value) => typeof value === "string" && value.trim()).join("\n");
  const personalContextExcluded = excludesPersonalContext(combinedText);

  // metadataUniverse is a trusted host input, not part of the public MCP tool
  // schema. The server constructs it from all current canonical Result pages.
  // Missing, malformed or duplicate universes fail closed for the new gate;
  // ordinary exact/anchor routing and the legacy compatibility path stay intact.
  let lexicalUniverse = null;
  if (Array.isArray(metadataUniverse) && metadataUniverse.length > 0
    && metadataUniverse.every((candidate) => isResultCandidate(candidate, runtime))
    && new Set(metadataUniverse.map((candidate) => candidate.slug)).size === metadataUniverse.length) {
    lexicalUniverse = buildLexicalMetadataEvidence({ query: combinedText, candidates: metadataUniverse });
  }

  const queryProfile = profile(query);
  const contextProfile = profile(context);
  const seen = new Set();
  const scored = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!isResultCandidate(candidate, runtime) || seen.has(candidate.slug)) continue;
    seen.add(candidate.slug);
    scored.push(scoreCandidate(candidate, queryProfile, contextProfile, module,
      lexicalUniverse?.get(candidate.slug), personalContextExcluded));
  }
  scored.sort(byRoutePriority);

  const strong = scored.filter((candidate) => candidate.strong).slice(0, boundedLimit);
  const weak = scored.filter((candidate) => !candidate.strong && candidate.weak).slice(0, boundedLimit);

  if (strong.length > 0) {
    return {
      action: "read",
      reason_codes: [...new Set(strong.flatMap((candidate) => candidate.match_reasons))],
      retrieval,
      selected: strong.map(publicCandidate),
      candidates: weak.map(publicCandidate),
    };
  }
  if (weak.length > 0) {
    return {
      action: "review",
      reason_codes: [...new Set(weak.flatMap((candidate) => candidate.match_reasons))],
      retrieval,
      selected: [],
      candidates: weak.map(publicCandidate),
    };
  }
  return {
    action: "none",
    reason_codes: ["no_explainable_match"],
    retrieval,
    selected: [],
    candidates: [],
  };
}

const TRUST_CORE_RELEASE = Object.freeze({
  package_id: "lab-trust-core",
  package_version: "0.1.2",
  package_version_source: "gateway_lockfile",
});

const TRUST_INTENDED_USES = new Set([
  "idea_generation",
  "copywriting_inspiration",
  "interview_question",
  "experiment_hypothesis",
  "low_risk_action",
  "default_answer",
  "operational_decision",
  "high_risk_decision",
  "public_factual_claim",
]);
const TRUST_RISK_LEVELS = new Set(["ordinary", "high"]);
const TRUST_CONTEXT_KEYS = new Set([
  "intended_use",
  "risk_level",
  "claim_id",
  "scope",
]);
const MAX_TRUST_ITEMS = 25;
const MAX_TRUST_TEXT_BYTES = 500;
const MAX_TRUST_CODE_BYTES = 120;
const MAX_TRUST_PATH_BYTES = 300;
const MAX_TRUST_EXPLANATION_BYTES = 2_000;

let trustCoreModulePromise;

async function loadTrustCoreModule() {
  if (!trustCoreModulePromise) {
    trustCoreModulePromise = import("lab-trust-core").catch((error) => {
      trustCoreModulePromise = undefined;
      throw error;
    });
  }
  return trustCoreModulePromise;
}

function trustIssue(code, path, message) {
  return { code, path, message };
}

function truncateUtf8(value, maxBytes) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { value: text, truncated: false };
  }
  const suffix = "…";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let bytes = 0;
  let output = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > budget) break;
    output += character;
    bytes += size;
  }
  return { value: `${output}${suffix}`, truncated: true };
}

function boundedStringList(value, maxBytes = MAX_TRUST_TEXT_BYTES) {
  const source = Array.isArray(value) ? value : [];
  let textTruncated = false;
  const items = source.slice(0, MAX_TRUST_ITEMS).map((item) => {
    const bounded = truncateUtf8(item, maxBytes);
    textTruncated ||= bounded.truncated;
    return bounded.value;
  });
  return {
    items,
    meta: {
      total_count: source.length,
      returned_count: items.length,
      truncated: source.length > MAX_TRUST_ITEMS || textTruncated,
    },
  };
}

function boundedIssues(value) {
  const source = Array.isArray(value) ? value : [];
  let textTruncated = false;
  const items = source.slice(0, MAX_TRUST_ITEMS).map((issue) => {
    const code = truncateUtf8(issue?.code, MAX_TRUST_CODE_BYTES);
    const issuePath = truncateUtf8(issue?.path, MAX_TRUST_PATH_BYTES);
    const message = truncateUtf8(issue?.message, MAX_TRUST_TEXT_BYTES);
    textTruncated ||= code.truncated || issuePath.truncated || message.truncated;
    return {
      code: code.value,
      path: issuePath.value,
      message: message.value,
    };
  });
  return {
    items,
    totalCount: source.length,
    truncated: source.length > MAX_TRUST_ITEMS || textTruncated,
  };
}

function boundedVerdict(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      verdict: null,
      limits: {
        bounded: true,
        truncated: false,
        unknown_field_count: 0,
        truncated_fields: [],
        fields: {},
      },
    };
  }

  const scalarLimits = {
    record_id: MAX_TRUST_TEXT_BYTES,
    claim_id: MAX_TRUST_TEXT_BYTES,
    intended_use: MAX_TRUST_TEXT_BYTES,
    decision: MAX_TRUST_TEXT_BYTES,
    effective_maturity: MAX_TRUST_TEXT_BYTES,
    explanation: MAX_TRUST_EXPLANATION_BYTES,
    policy_id: MAX_TRUST_TEXT_BYTES,
    policy_version: MAX_TRUST_TEXT_BYTES,
  };
  const listFields = [
    "reason_codes",
    "required_caveats",
    "evidence_gaps",
    "promotion_blockers",
  ];
  const knownFields = new Set([
    ...Object.keys(scalarLimits),
    ...listFields,
    "required_attribution",
  ]);
  const verdict = {};
  const truncatedFields = [];
  for (const [field, limit] of Object.entries(scalarLimits)) {
    if (!Object.hasOwn(value, field)) continue;
    const bounded = truncateUtf8(value[field], limit);
    verdict[field] = bounded.value;
    if (bounded.truncated) truncatedFields.push(field);
  }
  verdict.required_attribution = value.required_attribution === true;

  const fields = {};
  for (const field of listFields) {
    const bounded = boundedStringList(value[field]);
    verdict[field] = bounded.items;
    fields[field] = bounded.meta;
    if (bounded.meta.truncated) truncatedFields.push(field);
  }
  const unknownFieldCount = Object.keys(value).filter((field) => !knownFields.has(field)).length;
  return {
    verdict,
    limits: {
      bounded: true,
      truncated: truncatedFields.length > 0 || unknownFieldCount > 0,
      unknown_field_count: unknownFieldCount,
      truncated_fields: truncatedFields,
      fields,
    },
  };
}

function normalizedTrustContext(value) {
  const context = {
    intended_use: null,
    risk_level: null,
    claim_id: null,
    scope: [],
  };
  if (value === undefined || value === null) {
    return {
      context,
      source: "missing",
      issues: [trustIssue(
        "TRUST_CONTEXT_REQUIRED",
        "$.context",
        "Explicit intended_use, risk_level, and semantic scope are required before a trust verdict can be evaluated.",
      )],
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      context,
      source: "invalid",
      issues: [trustIssue(
        "CONTEXT_INVALID",
        "$.context",
        "Trust context must be an object; the page remains available because enforcement is disabled.",
      )],
    };
  }

  const issues = [];
  for (const key of Object.keys(value)) {
    if (!TRUST_CONTEXT_KEYS.has(key)) {
      issues.push(trustIssue(
        "CONTEXT_INVALID",
        `$.context.${key}`,
        "Unknown trust context field.",
      ));
    }
  }

  if (!Object.hasOwn(value, "intended_use")) {
    issues.push(trustIssue(
      "CONTEXT_INCOMPLETE",
      "$.context.intended_use",
      "intended_use must be supplied explicitly.",
    ));
  } else if (!TRUST_INTENDED_USES.has(value.intended_use)) {
    issues.push(trustIssue(
      "CONTEXT_INVALID",
      "$.context.intended_use",
      "Unknown intended_use.",
    ));
  } else {
    context.intended_use = value.intended_use;
  }

  if (!Object.hasOwn(value, "risk_level")) {
    issues.push(trustIssue(
      "CONTEXT_INCOMPLETE",
      "$.context.risk_level",
      "risk_level must be supplied explicitly.",
    ));
  } else if (!TRUST_RISK_LEVELS.has(value.risk_level)) {
    issues.push(trustIssue(
      "CONTEXT_INVALID",
      "$.context.risk_level",
      "risk_level must be ordinary or high.",
    ));
  } else {
    context.risk_level = value.risk_level;
  }

  if (Object.hasOwn(value, "claim_id")) {
    if (
      typeof value.claim_id !== "string"
      || value.claim_id.trim().length === 0
      || value.claim_id.trim().length > 120
    ) {
      issues.push(trustIssue(
        "CONTEXT_INVALID",
        "$.context.claim_id",
        "claim_id must be a non-empty string of at most 120 characters.",
      ));
    } else {
      context.claim_id = value.claim_id.trim();
    }
  }

  if (!Object.hasOwn(value, "scope")) {
    issues.push(trustIssue(
      "CONTEXT_INCOMPLETE",
      "$.context.scope",
      "Semantic scope must be supplied explicitly, even when it is empty.",
    ));
  } else if (
    !Array.isArray(value.scope)
    || value.scope.length > 20
    || value.scope.some((item) => (
      typeof item !== "string"
      || item.trim().length === 0
      || item.trim().length > 200
    ))
  ) {
    issues.push(trustIssue(
      "CONTEXT_INVALID",
      "$.context.scope",
      "scope must contain at most 20 non-empty strings of at most 200 characters.",
    ));
  } else {
    context.scope = value.scope.map((item) => item.trim());
  }

  return {
    context,
    source: issues.length > 0 ? "invalid" : "caller",
    issues,
  };
}

function shadowBase(context, overrides = {}) {
  const {
    available_claim_ids: availableClaimIds = [],
    issues = [],
    verdict: rawVerdict = null,
    ...rest
  } = overrides;
  const boundedClaims = boundedStringList(availableClaimIds, MAX_TRUST_CODE_BYTES);
  const boundedIssueList = boundedIssues(issues);
  const boundedVerdictResult = boundedVerdict(rawVerdict);
  return {
    contract_version: "1",
    mode: "shadow",
    enforced: false,
    status: "unavailable",
    engine: {
      ...TRUST_CORE_RELEASE,
      policy_id: null,
      policy_version: null,
    },
    context,
    context_source: "missing",
    context_complete: false,
    output_limits: {
      max_items: MAX_TRUST_ITEMS,
      max_text_bytes: MAX_TRUST_TEXT_BYTES,
      max_explanation_bytes: MAX_TRUST_EXPLANATION_BYTES,
    },
    available_claim_count: boundedClaims.meta.total_count,
    available_claim_ids: boundedClaims.items,
    available_claim_ids_truncated: boundedClaims.meta.truncated,
    verdict: boundedVerdictResult.verdict,
    verdict_limits: boundedVerdictResult.limits,
    issue_count: boundedIssueList.totalCount,
    issues: boundedIssueList.items,
    issues_truncated: boundedIssueList.truncated,
    ...rest,
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildTrustInputBinding({ source, returnedContent, updatedAt = null } = {}) {
  const hasCanonical = typeof source?.markdown === "string";
  const hasReturned = typeof returnedContent === "string";
  let status = "unverified_dual_snapshot";
  if (!hasCanonical) status = "canonical_unavailable";
  else if (!hasReturned) status = "returned_content_unavailable";
  return {
    status,
    algorithm: "sha256",
    canonical_markdown: hasCanonical
      ? { path: source.path || null, digest: sha256(source.markdown) }
      : null,
    returned_content: hasReturned
      ? { digest: sha256(returnedContent), updated_at: updatedAt || null }
      : null,
  };
}

export async function observeKnowledgeTrustShadow({
  markdown,
  path,
  trustContext,
  coreLoader = loadTrustCoreModule,
} = {}) {
  const normalizedContext = normalizedTrustContext(trustContext);
  const context = normalizedContext.context;
  if (typeof markdown !== "string") {
    return shadowBase(context, {
      status: "not_evaluable",
      context_source: normalizedContext.source,
      issues: [trustIssue(
        "SOURCE_MARKDOWN_UNAVAILABLE",
        "$",
        "The canonical Markdown page is unavailable for trust evaluation.",
      )],
    });
  }

  let core;
  try {
    core = await coreLoader();
  } catch {
    return shadowBase(context, {
      status: "unavailable",
      context_source: normalizedContext.source,
      issues: [trustIssue(
        "TRUST_CORE_UNAVAILABLE",
        "$",
        "Lab Trust Core could not be loaded; the page remains available because enforcement is disabled.",
      )],
    });
  }

  const engine = {
    ...TRUST_CORE_RELEASE,
    policy_id: core.DEFAULT_POLICY?.id || null,
    policy_version: core.DEFAULT_POLICY?.version || null,
  };

  if (
    core.PACKAGE_ID !== TRUST_CORE_RELEASE.package_id
    || typeof core.parseKnowledgeMarkdown !== "function"
    || typeof core.evaluateUse !== "function"
  ) {
    return shadowBase(context, {
      status: "unavailable",
      engine,
      context_source: normalizedContext.source,
      issues: [trustIssue(
        "TRUST_CORE_API_INCOMPATIBLE",
        "$",
        "The loaded Trust Core package does not match the gateway's locked public API.",
      )],
    });
  }

  try {
    const parsed = core.parseKnowledgeMarkdown(markdown, { path });
    if (!parsed.ok) {
      return shadowBase(context, {
        status: "invalid_record",
        engine,
        context_source: normalizedContext.source,
        issues: parsed.issues,
      });
    }

    const availableClaimIds = parsed.record.claims.map((claim) => claim.claim_id);
    if (normalizedContext.issues.length > 0) {
      return shadowBase(context, {
        status: "not_evaluable",
        engine,
        context_source: normalizedContext.source,
        available_claim_ids: availableClaimIds,
        issues: normalizedContext.issues,
      });
    }

    let selectedClaimId = context.claim_id;
    if (selectedClaimId && !availableClaimIds.includes(selectedClaimId)) {
      return shadowBase(context, {
        status: "not_evaluable",
        engine,
        context_source: normalizedContext.source,
        available_claim_ids: availableClaimIds,
        issues: [trustIssue(
          "CLAIM_NOT_FOUND",
          "$.context.claim_id",
          `Claim '${selectedClaimId}' was not found in the record.`,
        )],
      });
    }
    if (!selectedClaimId && availableClaimIds.length > 1) {
      return shadowBase(context, {
        status: "not_evaluable",
        engine,
        context_source: normalizedContext.source,
        available_claim_ids: availableClaimIds,
        issues: [trustIssue(
          "CLAIM_SELECTION_REQUIRED",
          "$.context.claim_id",
          "Select one claim_id before using a multi-claim page for a trust verdict.",
        )],
      });
    }
    if (!selectedClaimId && availableClaimIds.length === 1) {
      [selectedClaimId] = availableClaimIds;
    }

    const effectiveContext = {
      ...context,
      claim_id: selectedClaimId || null,
    };
    const selectedClaim = selectedClaimId
      ? parsed.record.claims.find((claim) => claim.claim_id === selectedClaimId)
      : null;
    const declaredScope = selectedClaim?.scope ?? parsed.record.scope ?? [];
    if (declaredScope.length > 0 && effectiveContext.scope.length === 0) {
      return shadowBase(effectiveContext, {
        status: "not_evaluable",
        engine,
        context_source: normalizedContext.source,
        available_claim_ids: availableClaimIds,
        issues: [trustIssue(
          "SEMANTIC_SCOPE_REQUIRED",
          "$.context.scope",
          "This claim declares a scope; supply the current task's semantic scope before evaluating it.",
        )],
      });
    }
    const verdict = core.evaluateUse(parsed.record, {
      intended_use: effectiveContext.intended_use,
      risk_level: effectiveContext.risk_level,
      ...(effectiveContext.claim_id ? { claim_id: effectiveContext.claim_id } : {}),
      ...(effectiveContext.scope.length > 0 ? { scope: effectiveContext.scope } : {}),
    });
    return shadowBase(effectiveContext, {
      status: "evaluated",
      engine: {
        ...engine,
        policy_id: verdict.policy_id,
        policy_version: verdict.policy_version,
      },
      context_source: normalizedContext.source,
      context_complete: true,
      available_claim_ids: availableClaimIds,
      verdict,
    });
  } catch (error) {
    const stableCode = typeof error?.code === "string" ? error.code : null;
    if (stableCode === "CONTEXT_INVALID" || stableCode === "CLAIM_NOT_FOUND") {
      return shadowBase(context, {
        status: "not_evaluable",
        engine,
        context_source: normalizedContext.source,
        issues: [trustIssue(
          stableCode,
          "$.context",
          "Trust Core rejected the supplied evaluation context.",
        )],
      });
    }
    if (stableCode === "RECORD_INVALID") {
      return shadowBase(context, {
        status: "invalid_record",
        engine,
        context_source: normalizedContext.source,
        issues: [trustIssue(
          stableCode,
          "$",
          "Trust Core rejected the parsed knowledge record.",
        )],
      });
    }
    return shadowBase(context, {
      status: "unavailable",
      engine,
      context_source: normalizedContext.source,
      issues: [trustIssue(
        "TRUST_CORE_RUNTIME_ERROR",
        "$",
        "Lab Trust Core could not evaluate this page; the page remains available because enforcement is disabled.",
      )],
    });
  }
}
