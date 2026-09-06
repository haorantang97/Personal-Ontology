import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { normalizeRouteText, routeTextProfile } from "./knowledge-router.mjs";
import {
  CANONICAL_PACK_PATH,
  readSchemaPack,
  validateSchemaPack,
} from "./schema-pack.mjs";

const NAVIGATION_TYPE_LABELS = new Map([
  ["project", "Projects"],
  ["decision", "Decisions"],
  ["methodology", "Methods"],
  ["synthesis", "Syntheses"],
  ["concept", "Concepts"],
  ["source", "Evidence Sources"],
]);
export const NAVIGATION_INDEX_FILE = "index.md";

function git(root, args, { buffer = false } = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: buffer ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function requireImmutableCommit(root, commit) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit || "")) {
    throw new Error("A full immutable Git commit is required for committed catalog reads.");
  }
  const resolved = git(root, ["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  if (resolved !== commit) {
    throw new Error("The committed catalog revision did not resolve exactly.");
  }
  return commit;
}

function treeEntryMap(root, commit) {
  const records = git(root, ["ls-tree", "-r", "-z", "--full-tree", commit], {
    buffer: true,
  }).toString("utf8").split("\0").filter(Boolean);
  const entries = new Map();
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    const relative = record.slice(separator + 1);
    if (type === "blob" && ["100644", "100755"].includes(mode)) {
      entries.set(relative, { mode, type, oid });
    }
  }
  return entries;
}

function batchBlobs(root, entries) {
  if (!entries.length) return [];
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${entries.map((entry) => entry.oid).join("\n")}\n`,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
  });
  const blobs = [];
  let cursor = 0;
  for (const entry of entries) {
    const headerEnd = output.indexOf(0x0a, cursor);
    if (headerEnd < 0) throw new Error("Committed blob batch ended before its header.");
    const header = output.subarray(cursor, headerEnd).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (header[0] !== entry.oid || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("Committed blob batch returned an unexpected object.");
    }
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new Error("Committed blob batch returned truncated content.");
    }
    blobs.push(output.subarray(start, end).toString("utf8"));
    cursor = end + 1;
  }
  if (cursor !== output.length) throw new Error("Committed blob batch returned trailing data.");
  return blobs;
}

function unquote(value) {
  const text = String(value ?? "").trim();
  if (text.length < 2) return text;
  const quote = text[0];
  if ((quote !== "\"" && quote !== "'") || text.at(-1) !== quote) return text;
  const inner = text.slice(1, -1);
  if (quote === "'") return inner.replaceAll("''", "'");
  try {
    return JSON.parse(text);
  } catch {
    return inner;
  }
}

function splitInlineList(value) {
  const text = String(value ?? "").trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  const values = [];
  let buffer = "";
  let quote = "";
  let escaped = false;
  let bracketDepth = 0;
  for (const character of inner) {
    if (escaped) {
      buffer += character;
      escaped = false;
    } else if (character === "\\" && quote) {
      buffer += character;
      escaped = true;
    } else if ((character === "\"" || character === "'") && (!quote || quote === character)) {
      quote = quote ? "" : character;
      buffer += character;
    } else if (character === "[" && !quote) {
      bracketDepth += 1;
      buffer += character;
    } else if (character === "]" && !quote) {
      bracketDepth -= 1;
      buffer += character;
    } else if (character === "," && !quote && bracketDepth === 0) {
      values.push(buffer.trim());
      buffer = "";
    } else {
      buffer += character;
    }
  }
  if (quote || bracketDepth !== 0) return null;
  values.push(buffer.trim());
  return values.filter(Boolean).map(parseScalar);
}

function parseScalar(value) {
  const text = String(value ?? "").trim();
  const inlineList = splitInlineList(text);
  if (inlineList) return inlineList;
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return Number(text);
  // Keep the former YAML provider's public frontmatter shape: an unquoted
  // YAML date was decoded as a Date and then JSON-serialized to ISO, while a
  // deliberately quoted date remained a string.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const timestamp = Date.parse(`${text}T00:00:00.000Z`);
    const iso = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    if (iso?.startsWith(text)) return iso;
  }
  return unquote(text);
}

export function parseKnowledgeMarkdown(markdown) {
  const normalized = String(markdown).replaceAll("\r\n", "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    const body = splitKnowledgeBody(normalized.trim());
    return { frontmatter: {}, content: body.compiled_truth, timeline: body.timeline };
  }
  const closing = lines.indexOf("---", 1);
  if (closing < 0) {
    const body = splitKnowledgeBody(normalized.trim());
    return { frontmatter: {}, content: body.compiled_truth, timeline: body.timeline };
  }

  const frontmatter = {};
  let activeList = null;
  for (const line of lines.slice(1, closing)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (field) {
      const [, key, raw = ""] = field;
      if (raw.trim()) {
        frontmatter[key] = parseScalar(raw);
        activeList = null;
      } else {
        frontmatter[key] = [];
        activeList = key;
      }
      continue;
    }
    const item = activeList ? line.match(/^\s+-\s+(.+)$/) : null;
    if (item) frontmatter[activeList].push(parseScalar(item[1]));
  }
  const body = splitKnowledgeBody(lines.slice(closing + 1).join("\n").trim());
  return { frontmatter, content: body.compiled_truth, timeline: body.timeline };
}

// Preserve the public get_page contract that the previous derived-index
// provider exposed: compiled truth and timeline are separate strings. A plain
// Markdown horizontal rule is not a timeline split unless the next non-empty
// line is the legacy Timeline/History heading.
export function splitKnowledgeBody(body) {
  const text = String(body ?? "");
  const lines = text.split("\n");
  let splitIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (
      trimmed === "<!-- timeline -->"
      || trimmed === "<!--timeline-->"
      || /^---\s+timeline\s+---$/i.test(trimmed)
    ) {
      splitIndex = index;
      break;
    }
    if (trimmed !== "---" || !lines.slice(0, index).join("\n").trim()) continue;
    const next = lines.slice(index + 1).find((line) => line.trim());
    if (/^##\s+(timeline|history)\b/i.test(next?.trim() || "")) {
      splitIndex = index;
      break;
    }
  }
  if (splitIndex < 0) return { compiled_truth: text, timeline: "" };
  return {
    compiled_truth: lines.slice(0, splitIndex).join("\n"),
    timeline: lines.slice(splitIndex + 1).join("\n"),
  };
}

function collectMarkdown(root, directory, prefix = "") {
  const absolute = path.join(root, directory, prefix);
  if (!existsSync(absolute)) return [];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...collectMarkdown(root, directory, relative));
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path.posix.join(directory, relative));
    }
  }
  return files;
}

function normalizeSlug(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("\\") || raw.includes("\0") || path.posix.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw.replace(/\.md$/, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function normalizeLookup(value) {
  return String(value ?? "").trim().toLocaleLowerCase("zh-CN");
}

function compactNormalized(value) {
  return normalizeRouteText(value).replaceAll(" ", "");
}

function localQueryTerms(query) {
  const queryProfile = routeTextProfile(query);
  return [
    ...[...queryProfile.cjk4].map((value) => ({ value, weight: 4 })),
    ...[...queryProfile.latin].map((value) => ({
      value,
      weight: value.length >= 5 ? 4 : 2,
    })),
    ...[...queryProfile.cjk2].map((value) => ({ value, weight: 1 })),
  ];
}

function excerptForTerms(content, terms, limit = 1200) {
  const text = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const folded = text.toLocaleLowerCase("zh-CN");
  const positions = terms
    .map(({ value }) => folded.indexOf(String(value).toLocaleLowerCase("zh-CN")))
    .filter((index) => index >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, first - 160);
  return text.slice(start, start + limit);
}

function localKeywordHit(page, query, terms) {
  const frontmatter = page.frontmatter || {};
  const aliases = asList(frontmatter.aliases).map(String);
  const tags = asList(frontmatter.tags).map(String);
  const modules = asList(frontmatter.modules).map(String);
  const namedValues = [
    page.title,
    ...aliases,
    path.posix.basename(page.slug).replaceAll("-", " "),
  ].filter(Boolean);
  const normalizedQuery = normalizeRouteText(query);
  const compactQuery = compactNormalized(query);
  const normalizedNamed = namedValues.map(normalizeRouteText);
  const compactNamed = namedValues.map(compactNormalized);
  const searchableBody = [page.compiled_truth, page.timeline].filter(Boolean).join("\n");
  const fields = {
    title: normalizeRouteText(page.title),
    aliases: normalizeRouteText(aliases.join(" ")),
    tags: normalizeRouteText(tags.join(" ")),
    slug: normalizeRouteText(page.slug.replaceAll("-", " ")),
    modules: normalizeRouteText(modules.join(" ")),
    domain: normalizeRouteText(frontmatter.domain || ""),
    body: normalizeRouteText(searchableBody),
  };

  const exactNamed = Boolean(normalizedQuery)
    && normalizedNamed.some((value) => value === normalizedQuery);
  const namedPhrase = compactQuery.length >= 4
    && compactNamed.some((value) => value.includes(compactQuery));
  const bodyPhrase = compactQuery.length >= 4
    && compactNormalized(searchableBody).includes(compactQuery);
  let rawScore = exactNamed ? 100 : namedPhrase ? 55 : 0;
  if (bodyPhrase) rawScore += 12;
  let metadataMatches = 0;
  let bodyMatches = 0;
  const matchedTerms = [];

  for (const term of terms) {
    let metadataWeight = 0;
    if (fields.title.includes(term.value)) metadataWeight = Math.max(metadataWeight, 8);
    if (fields.aliases.includes(term.value)) metadataWeight = Math.max(metadataWeight, 7);
    if (fields.tags.includes(term.value)) metadataWeight = Math.max(metadataWeight, 6);
    if (fields.slug.includes(term.value)) metadataWeight = Math.max(metadataWeight, 5);
    if (fields.modules.includes(term.value)) metadataWeight = Math.max(metadataWeight, 3);
    if (fields.domain.includes(term.value)) metadataWeight = Math.max(metadataWeight, 2);
    const bodyMatch = fields.body.includes(term.value);
    if (!metadataWeight && !bodyMatch) continue;
    matchedTerms.push(term);
    if (metadataWeight) {
      metadataMatches += 1;
      rawScore += term.weight * metadataWeight;
    }
    if (bodyMatch) {
      bodyMatches += 1;
      rawScore += term.weight;
    }
  }

  if (!rawScore || (!exactNamed && !namedPhrase && !bodyPhrase && !matchedTerms.length)) return null;
  const score = exactNamed
    ? 1
    : Math.min(0.99, rawScore / (rawScore + 24));
  return {
    slug: page.slug,
    title: page.title,
    type: page.type,
    score: Number(score.toFixed(4)),
    chunk_text: excerptForTerms(searchableBody || page.title, matchedTerms),
    evidence: exactNamed ? "keyword_exact"
      : metadataMatches > 0 ? "local_metadata_keyword"
        : "local_body_keyword",
    effective_date: frontmatter.effective_date || null,
    match_terms: matchedTerms.map(({ value }) => value).slice(0, 12),
    metadata_match_count: metadataMatches,
    body_match_count: bodyMatches,
  };
}

function normalizeReference(reference) {
  let value = String(reference ?? "").trim();
  if (value.startsWith("[[") && value.endsWith("]]")) value = value.slice(2, -2).trim();
  return normalizeSlug(value.split("|")[0].split("#")[0]);
}

function asList(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === "" ? [] : [value];
}

function navigationPlainText(value) {
  return String(value ?? "")
    .replace(/!\[\[([^\]]+)\]\]/g, "")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target, label) => (
      label || path.posix.basename(String(target).trim())
    ))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateCharacters(value, limit = 160) {
  const characters = Array.from(String(value));
  return characters.length <= limit
    ? characters.join("")
    : `${characters.slice(0, Math.max(1, limit - 1)).join("")}…`;
}

function navigationSummary(content, fallback) {
  const lines = String(content ?? "").replaceAll("\r\n", "\n").split("\n");
  const quoteStart = lines.findIndex((line) => /^>\s*\S/.test(line));
  if (quoteStart >= 0) {
    const quote = [];
    for (const line of lines.slice(quoteStart)) {
      if (!line.startsWith(">")) break;
      quote.push(line.replace(/^>\s?/, ""));
    }
    const summary = navigationPlainText(quote.join(" "));
    if (summary) return truncateCharacters(summary);
  }

  let paragraph = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^#{1,6}\s/.test(trimmed) || /^[-*+]\s/.test(trimmed)
      || /^\d+[.)]\s/.test(trimmed) || /^\|/.test(trimmed) || /^---+$/.test(trimmed)) {
      if (paragraph.length) break;
      continue;
    }
    if (!trimmed) {
      if (paragraph.length) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  const summary = navigationPlainText(paragraph.join(" ")) || navigationPlainText(fallback);
  return truncateCharacters(summary);
}

function markdownLabel(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function navigationMetadata(page) {
  const fields = page.frontmatter || {};
  const values = [];
  if (fields.maturity) values.push(`maturity:${fields.maturity}`);
  const modules = asList(fields.modules).map(String).filter(Boolean);
  if (modules.length) values.push(`modules:${modules.join(",")}`);
  if (fields.domain) values.push(`domain:${fields.domain}`);
  if (fields.agent_priority) values.push(`priority:${fields.agent_priority}`);
  if (fields.updated) values.push(`updated:${fields.updated}`);
  return values.map((value) => `\`${value}\``).join(" · ");
}

export class KnowledgeCatalog {
  constructor({
    root,
    schemaPackPath = CANONICAL_PACK_PATH,
    commit = null,
    enforceCanonicalTypes = Boolean(commit),
  }) {
    this.root = path.resolve(root);
    this.schemaPackPath = path.resolve(this.root, schemaPackPath);
    this.commit = commit ? requireImmutableCommit(this.root, commit) : null;
    this.enforceCanonicalTypes = enforceCanonicalTypes;
    this.committedEntries = null;
    this.committedSources = new Map();
    this.cachedCanonicalPack = null;
    this.commitTimestamp = this.commit
      ? new Date(git(this.root, ["show", "-s", "--format=%cI", this.commit]).trim())
      : null;
  }

  source(slug) {
    const normalized = normalizeSlug(slug);
    if (!normalized) return null;
    if (this.commit) {
      const relative = `${normalized}.md`;
      if (this.committedSources.has(relative)) return this.committedSources.get(relative);
      this.committedEntries ||= treeEntryMap(this.root, this.commit);
      const entry = this.committedEntries.get(relative);
      if (!entry) return null;
      const source = {
        slug: normalized,
        path: relative,
        absolute: null,
        markdown: git(this.root, ["cat-file", "blob", entry.oid], { buffer: true }).toString("utf8"),
        stat: { mtime: this.commitTimestamp },
        commit: this.commit,
      };
      this.committedSources.set(relative, source);
      return source;
    }
    const absolute = path.resolve(this.root, `${normalized}.md`);
    if (!absolute.startsWith(`${this.root}${path.sep}`) || !existsSync(absolute)) return null;
    let cursor = absolute;
    while (cursor !== this.root && cursor.startsWith(`${this.root}${path.sep}`)) {
      if (lstatSync(cursor).isSymbolicLink()) return null;
      cursor = path.dirname(cursor);
    }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return {
      slug: normalized,
      path: `${normalized}.md`,
      absolute,
      markdown: readFileSync(absolute, "utf8"),
      stat: statSync(absolute),
    };
  }

  preloadCommittedSources(relatives) {
    if (!this.commit) return;
    this.committedEntries ||= treeEntryMap(this.root, this.commit);
    const missing = relatives
      .filter((relative) => !this.committedSources.has(relative))
      .map((relative) => ({ relative, ...this.committedEntries.get(relative) }))
      .filter((entry) => entry.oid);
    const blobs = batchBlobs(this.root, missing);
    for (let index = 0; index < missing.length; index += 1) {
      const entry = missing[index];
      this.committedSources.set(entry.relative, {
        slug: normalizeSlug(entry.relative),
        path: entry.relative,
        absolute: null,
        markdown: blobs[index],
        stat: { mtime: this.commitTimestamp },
        commit: this.commit,
      });
    }
  }

  typeDirectories() {
    return this.activePack().page_types.flatMap((entry) =>
      entry.path_prefixes.map((prefix) => [entry.name, prefix.replace(/\/$/, "")])
    );
  }

  pageFromSource(source, typeDirectories = this.typeDirectories()) {
    if (!source) return null;
    const { frontmatter, content, timeline } = parseKnowledgeMarkdown(source.markdown);
    const inferredType = typeDirectories
      .find(([, directory]) => source.slug === directory || source.slug.startsWith(`${directory}/`))?.[0];
    const declaredType = String(frontmatter.type || "");
    if (this.enforceCanonicalTypes && (!inferredType || declaredType !== inferredType)) return null;
    const type = declaredType || inferredType || "";
    const title = String(frontmatter.title || path.posix.basename(source.slug));
    const semanticUpdated = source.commit && frontmatter.updated
      ? new Date(frontmatter.updated)
      : null;
    const updatedAt = semanticUpdated && Number.isFinite(semanticUpdated.getTime())
      ? semanticUpdated
      : source.stat.mtime;
    return {
      slug: source.slug,
      title,
      type,
      frontmatter,
      // The old database provider returned tags in its deterministic index
      // order, not in Markdown declaration order.
      tags: asList(frontmatter.tags).map(String).sort(),
      compiled_truth: content,
      timeline,
      // The previous provider returned a JSON-serialized database timestamp.
      // File mtime is the closest local analogue to import/update time; the
      // semantic frontmatter `updated` date remains available in frontmatter.
      updated_at: updatedAt.toISOString(),
      path: source.path,
      markdown: source.markdown,
      source_commit: source.commit || null,
    };
  }

  allPages() {
    const pages = [];
    const typeDirectories = this.typeDirectories();
    if (this.commit) {
      this.committedEntries ||= treeEntryMap(this.root, this.commit);
      const prefixes = typeDirectories.map(([, directory]) => `${directory}/`);
      const relatives = [...this.committedEntries.keys()]
        .filter((relative) => relative.endsWith(".md")
          && prefixes.some((prefix) => relative.startsWith(prefix)))
        .sort();
      this.preloadCommittedSources(relatives);
      for (const relative of relatives) {
        const source = this.source(relative);
        const page = this.pageFromSource(source, typeDirectories);
        if (page) pages.push(page);
      }
      return pages;
    }
    for (const [, directory] of typeDirectories) {
      for (const relative of collectMarkdown(this.root, directory)) {
        const source = this.source(relative);
        const page = this.pageFromSource(source, typeDirectories);
        if (page) pages.push(page);
      }
    }
    return pages;
  }

  renderNavigationIndex({
    vaultName = path.basename(this.root),
    sourceCommit = null,
  } = {}) {
    const pages = this.allPages().sort((left, right) => (
      left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0
    ));
    const groups = new Map(this.activePack().page_types.map((entry) => [entry.name, []]));
    for (const page of pages) {
      if (groups.has(page.type)) groups.get(page.type).push(page);
    }
    const counts = Object.fromEntries(
      [...groups].map(([type, entries]) => [type, entries.length]),
    );
    const lines = [
      "<!-- GENERATED BY Agent Knowledge. DO NOT EDIT: local changes are overwritten. -->",
      "# Knowledge Index",
      "",
      "> 这是从已提交 Markdown 自动生成的人类导航页，不是知识事实源，也不参与默认检索或关系推断。",
      "",
      `- Vault: \`${String(vaultName)}\``,
      `- Pages: **${pages.length}**`,
    ];
    if (sourceCommit) lines.push(`- Source commit: \`${String(sourceCommit)}\``);
    lines.push("", "## Result");

    const renderGroup = (type) => {
      const entries = groups.get(type) || [];
      lines.push("", `### ${NAVIGATION_TYPE_LABELS.get(type) || type} (${entries.length})`, "");
      if (!entries.length) {
        lines.push("_当前没有页面。_");
        return;
      }
      for (const page of entries) {
        const uri = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(page.slug)}`;
        const summary = navigationSummary(page.compiled_truth, page.title);
        const metadata = navigationMetadata(page);
        lines.push(`- [${markdownLabel(page.title)}](${uri}) — ${summary}`);
        lines.push(`  - \`${page.slug}\`${metadata ? ` · ${metadata}` : ""}`);
      }
    };

    const pageTypes = this.activePack().page_types;
    for (const entry of pageTypes.filter((entry) => entry.retrieval_scope === "result")) {
      renderGroup(entry.name);
    }
    lines.push("", "## Evidence");
    for (const entry of pageTypes.filter((entry) => entry.retrieval_scope === "evidence")) {
      renderGroup(entry.name);
    }
    lines.push("");
    return {
      content: `${lines.join("\n")}\n`,
      page_count: pages.length,
      counts,
      source_commit: sourceCommit,
      file: NAVIGATION_INDEX_FILE,
    };
  }

  writeNavigationIndex({
    destinationRoot = this.root,
    vaultName = path.basename(destinationRoot),
    sourceCommit = null,
  } = {}) {
    const generated = this.renderNavigationIndex({ vaultName, sourceCommit });
    const resolvedDestinationRoot = path.resolve(destinationRoot);
    const destination = path.join(resolvedDestinationRoot, NAVIGATION_INDEX_FILE);
    const changed = !existsSync(destination)
      || readFileSync(destination, "utf8") !== generated.content;
    if (changed) {
      mkdirSync(resolvedDestinationRoot, { recursive: true });
      const temporary = `${destination}.catalog-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(temporary, generated.content, { encoding: "utf8", mode: 0o644 });
      renameSync(temporary, destination);
    }
    return { ...generated, changed };
  }

  getPage(slug, { fuzzy = true } = {}) {
    const normalized = normalizeSlug(slug);
    if (!normalized) return null;
    const exact = this.pageFromSource(this.source(normalized));
    if (exact || !fuzzy) return exact;

    const needle = normalizeLookup(normalized);
    // Preserve the strict public resolver contract. The former provider
    // searched title similarity and slug substrings, did not search aliases,
    // and rejected every multi-candidate fuzzy result as ambiguous. Local
    // Markdown fallback deliberately supports only deterministic title/slug
    // substring matching; callers can always use an exact slug.
    const candidates = this.allPages()
      .filter((page) => {
        const slugValue = normalizeLookup(page.slug);
        const title = normalizeLookup(page.title);
        return slugValue.includes(needle) || title.includes(needle);
      })
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .slice(0, 5);
    return candidates.length === 1 ? candidates[0] : null;
  }

  listPages({ type, limit = 50, sort = "updated_desc" } = {}) {
    const pages = this.allPages()
      .filter((page) => !type || page.type === type)
      .map((page) => ({
        slug: page.slug,
        type: page.type,
        title: page.title,
        updated_at: page.updated_at,
      }));
    pages.sort(sort === "slug"
      ? (left, right) => left.slug.localeCompare(right.slug)
      : (left, right) => String(right.updated_at).localeCompare(String(left.updated_at))
        || left.slug.localeCompare(right.slug));
    return pages.slice(0, limit);
  }

  search(query, { limit = 50, types = null } = {}) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const allowedTypes = Array.isArray(types) && types.length
      ? new Set(types.map(String))
      : null;
    const terms = localQueryTerms(query);
    const normalizedQuery = normalizeRouteText(query);
    if (!normalizedQuery || (!terms.length && compactNormalized(query).length < 4)) return [];
    return this.allPages()
      // Scope must be applied before ranking and truncation. Otherwise a large
      // evidence corpus can consume the top-N window and hide valid Result
      // pages from the fail-safe Markdown fallback.
      .filter((page) => !allowedTypes || allowedTypes.has(page.type))
      .map((page) => localKeywordHit(page, query, terms))
      .filter(Boolean)
      .sort((left, right) => right.score - left.score || left.slug.localeCompare(right.slug))
      .slice(0, boundedLimit);
  }

  canonicalPack() {
    if (this.commit && this.cachedCanonicalPack) return this.cachedCanonicalPack;
    const relative = path.relative(this.root, this.schemaPackPath).split(path.sep).join("/");
    const pack = this.commit
      ? validateSchemaPack(JSON.parse(git(this.root, ["show", `${this.commit}:${relative}`])))
      : readSchemaPack(this.root, this.schemaPackPath);
    if (this.commit) this.cachedCanonicalPack = pack;
    return pack;
  }

  activePack() {
    const relative = path.relative(this.root, this.schemaPackPath).split(path.sep).join("/");
    const pack = this.canonicalPack();
    return {
      ...pack,
      canonical_path: relative,
      pack_name: pack.pack_name || pack.name,
      pack_version: pack.pack_version || pack.version,
    };
  }

  relationships(slug) {
    const page = this.getPage(slug, { fuzzy: false });
    if (!page) return { outgoing: [], incoming: [] };
    const pages = this.allPages();
    const bySlug = new Map(pages.map((candidate) => [candidate.slug, candidate]));
    const byBasename = new Map();
    for (const candidate of pages) {
      const basename = path.posix.basename(candidate.slug);
      const existing = byBasename.get(basename) || [];
      existing.push(candidate.slug);
      byBasename.set(basename, existing);
    }
    const resolve = (reference) => {
      const normalized = normalizeReference(reference);
      if (!normalized) return null;
      if (normalized.includes("/")) return bySlug.has(normalized) ? normalized : null;
      const matches = byBasename.get(normalized) || [];
      return matches.length === 1 ? matches[0] : null;
    };
    const rules = this.activePack().frontmatter_links || [];
    const edges = [];
    for (const candidate of pages) {
      for (const rule of rules.filter((item) => item.page_type === candidate.type)) {
        for (const field of rule.fields || []) {
          for (const reference of asList(candidate.frontmatter[field])) {
            const target = resolve(reference);
            if (!target) continue;
            edges.push({
              from_slug: candidate.slug,
              to_slug: target,
              link_type: rule.link_type,
              link_source: "kb-schema",
              context: `frontmatter.${field}: ${reference}`,
            });
          }
        }
      }
    }
    return {
      outgoing: edges.filter((edge) => edge.from_slug === page.slug),
      incoming: edges.filter((edge) => edge.to_slug === page.slug),
    };
  }
}
