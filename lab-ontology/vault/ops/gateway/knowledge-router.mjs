const RESULT_TYPES = new Set([
  "project",
  "decision",
  "methodology",
  "synthesis",
  "concept",
]);

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

function scoreCandidate(candidate, queryProfile, contextProfile, requestedModule) {
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
  const priorityKeywordMatch = (query.weak || context.weak)
    && String(candidate.agent_priority || "") === "high"
    && String(candidate.retrieval_evidence || "") === "keyword_exact"
    && baseScore >= 0.9
    && retrievalRank !== null
    && retrievalRank <= 3;
  const strong = query.strong || context.strong || priorityKeywordMatch;
  const weak = strong || query.weak || context.weak;
  const reasons = [];
  let routeScore = 0;

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
    retrieval_rank: retrievalRank,
    modules: asList(candidate.modules),
    module_match: moduleMatch,
    match_reasons: reasons,
    match_terms: [...new Set([...query.matchTerms, ...context.matchTerms])].slice(0, 12),
    strong,
    weak,
  };
}

function isResultCandidate(candidate) {
  const slug = String(candidate?.slug || "");
  return Boolean(slug)
    && !slug.startsWith(".raw/")
    && !slug.startsWith("sources/")
    && RESULT_TYPES.has(candidate?.type);
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
  retrievalStatus = "ok",
  retrievalMode = "hybrid",
  limit = 5,
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

  const queryProfile = profile(query);
  const contextProfile = profile(context);
  const seen = new Set();
  const scored = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!isResultCandidate(candidate) || seen.has(candidate.slug)) continue;
    seen.add(candidate.slug);
    scored.push(scoreCandidate(candidate, queryProfile, contextProfile, module));
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
