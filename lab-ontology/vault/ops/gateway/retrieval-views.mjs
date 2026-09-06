// Shared presentation gates for gateway requests and read-only A/B capture.
export function summarizeSearchHit(hit, { page = null, module = null } = {}) {
  const modules = Array.isArray(page?.frontmatter?.modules)
    ? page.frontmatter.modules.map((item) => String(item).trim()).filter(Boolean) : [];
  const moduleMatch = module ? modules.some((item) => item.toLocaleLowerCase("zh-CN") === module.toLocaleLowerCase("zh-CN")) : false;
  const baseScore = Number(hit.score || 0);
  return { slug: hit.slug, title: hit.title, type: hit.type,
    score: Number((moduleMatch ? baseScore * 1.15 : baseScore).toFixed(4)), base_score: Number(baseScore.toFixed(4)),
    modules, module_match: moduleMatch,
    excerpt: String(hit.chunk_text || "").replace(/\s+/g, " ").trim().slice(0, 1200),
    retrieval_evidence: hit.evidence || null, lexical_metadata: hit.lexical_metadata || null,
    effective_date: hit.effective_date || null };
}

export function routeCandidateFromHit(hit, page = null, retrievalRank = null) {
  const frontmatter = page?.frontmatter || {};
  return { slug: hit.slug, title: page?.title || hit.title || hit.slug, type: page?.type || hit.type,
    aliases: frontmatter.aliases || [], tags: page?.tags || frontmatter.tags || [], modules: frontmatter.modules || [],
    decision_status: frontmatter.decision_status || null, agent_priority: frontmatter.agent_priority || null,
    retrieval_evidence: hit.evidence || null, lexical_metadata: hit.lexical_metadata || null,
    retrieval_rank: retrievalRank, base_score: Number(Number(hit.score || 0).toFixed(4)),
    excerpt: String(hit.chunk_text || "").replace(/\s+/g, " ").trim().slice(0, 1200) };
}
