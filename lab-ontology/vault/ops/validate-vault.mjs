#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPE_BY_DIR = new Map([
  ["projects", "project"],
  ["decisions", "decision"],
  ["methods", "methodology"],
  ["syntheses", "synthesis"],
  ["concepts", "concept"],
  ["sources", "source"],
]);
const RESULT_TYPES = new Set([
  "project",
  "decision",
  "methodology",
  "synthesis",
  "concept",
]);
const COMMON_FIELDS = [
  "type",
  "title",
  "aliases",
  "tags",
  "created",
  "updated",
  "status",
  "retrieval_scope",
  "agent_priority",
  "domain",
  "evidence_status",
];
const LEGACY_PATHS = [".llm-wiki", "wiki", "raw", "purpose.md", "schema.md"];
const allowLegacy = process.argv.includes("--allow-legacy");
const errors = [];
const warnings = [];
let plainRelationReferences = 0;
let obsidianRelationReferences = 0;

function parseFrontmatter(text, relativePath) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") {
    errors.push(`${relativePath}: missing YAML frontmatter`);
    return { fields: new Map(), body: text };
  }

  const closing = lines.indexOf("---", 1);
  if (closing === -1) {
    errors.push(`${relativePath}: unclosed YAML frontmatter`);
    return { fields: new Map(), body: text };
  }

  const fields = new Map();
  for (const line of lines.slice(1, closing)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (match) fields.set(match[1], (match[2] ?? "").trim());
  }
  return { fields, body: lines.slice(closing + 1).join("\n") };
}

function scalar(raw = "") {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function inlineList(raw = "", label = "") {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) {
    errors.push(`${label}: expected an inline list`);
    return [];
  }

  const inner = value.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let buffer = "";
  let quote = "";
  let escaped = false;
  for (const character of inner) {
    if (escaped) {
      buffer += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      buffer += character;
      escaped = true;
      continue;
    }
    if ((character === "\"" || character === "'") && (!quote || quote === character)) {
      quote = quote ? "" : character;
      buffer += character;
      continue;
    }
    if (character === "," && !quote) {
      items.push(scalar(buffer));
      buffer = "";
      continue;
    }
    buffer += character;
  }
  if (quote) errors.push(`${label}: unclosed quote in inline list`);
  items.push(scalar(buffer));
  return items.map((item) => item.trim()).filter(Boolean);
}

function isObsidianRelationReference(reference = "") {
  const value = String(reference).trim();
  return value.length > 4 && value.startsWith("[[") && value.endsWith("]]");
}

function normalizeRelationReference(reference = "") {
  let value = String(reference).trim();
  if (isObsidianRelationReference(value)) value = value.slice(2, -2).trim();
  return value.split("|")[0].split("#")[0].replace(/\.md$/, "").trim();
}

function relationList(raw = "", label = "") {
  const references = inlineList(raw, label);
  for (const reference of references) {
    if (isObsidianRelationReference(reference)) obsidianRelationReferences += 1;
    else plainRelationReferences += 1;
  }
  return references.map(normalizeRelationReference);
}

async function markdownFiles(directory) {
  const absoluteDirectory = path.join(ROOT, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(relative)));
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(relative);
  }
  return files;
}

async function exists(relativePath) {
  try {
    await access(path.join(ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

for (const legacyPath of LEGACY_PATHS) {
  if (await exists(legacyPath)) {
    const message = `legacy path still exists: ${legacyPath}`;
    if (allowLegacy) warnings.push(message);
    else errors.push(message);
  }
}

const relativeFiles = [];
for (const directory of TYPE_BY_DIR.keys()) {
  relativeFiles.push(...(await markdownFiles(directory)));
}
const rawFiles = await markdownFiles(".raw");
const rawPaths = new Set(
  rawFiles.map((relativePath) => relativePath.slice(0, -3).split(path.sep).join("/")),
);
const rawSlugs = new Set(rawFiles.map((relativePath) => path.basename(relativePath, ".md")));

const pages = [];
const pageBySlug = new Map();
const pageByPath = new Map();
const nameOwners = new Map();

for (const relativePath of relativeFiles.sort()) {
  const text = await readFile(path.join(ROOT, relativePath), "utf8");
  const { fields, body } = parseFrontmatter(text, relativePath);
  const directory = relativePath.split(path.sep)[0];
  const expectedType = TYPE_BY_DIR.get(directory);
  const actualType = scalar(fields.get("type"));
  const slug = path.basename(relativePath, ".md");

  for (const field of COMMON_FIELDS) {
    if (!fields.has(field) || !fields.get(field).trim()) {
      errors.push(`${relativePath}: missing required field '${field}'`);
    }
  }
  if (actualType !== expectedType) {
    errors.push(`${relativePath}: type '${actualType}' does not match directory '${expectedType}'`);
  }
  if (!/^#\s+\S/m.test(body)) errors.push(`${relativePath}: missing H1 heading`);

  for (const dateField of ["created", "updated"]) {
    if (fields.has(dateField) && !/^\d{4}-\d{2}-\d{2}$/.test(scalar(fields.get(dateField)))) {
      errors.push(`${relativePath}: '${dateField}' must use YYYY-MM-DD`);
    }
  }
  if (!["high", "normal", "low"].includes(scalar(fields.get("agent_priority")))) {
    errors.push(`${relativePath}: invalid agent_priority`);
  }

  const related = fields.has("related")
    ? relationList(fields.get("related"), `${relativePath}: related`)
    : [];
  const evidence = fields.has("evidence")
    ? relationList(fields.get("evidence"), `${relativePath}: evidence`)
    : [];
  const derivedPages = fields.has("derived_pages")
    ? relationList(fields.get("derived_pages"), `${relativePath}: derived_pages`)
    : [];
  const aliases = inlineList(fields.get("aliases"), `${relativePath}: aliases`);
  inlineList(fields.get("tags"), `${relativePath}: tags`);
  if (fields.has("modules")) {
    inlineList(fields.get("modules"), `${relativePath}: modules`);
  }
  const maturity = scalar(fields.get("maturity"));
  if (maturity && !["seed", "corroborated", "validated"].includes(maturity)) {
    errors.push(`${relativePath}: invalid maturity '${maturity}'`);
  }
  if (maturity === "seed" && scalar(fields.get("agent_priority")) === "high") {
    errors.push(`${relativePath}: maturity 'seed' cannot use agent_priority 'high'`);
  }

  if (RESULT_TYPES.has(actualType)) {
    if (!fields.has("related")) errors.push(`${relativePath}: result page needs 'related'`);
    if (!fields.has("evidence")) errors.push(`${relativePath}: result page needs 'evidence'`);
    if (scalar(fields.get("status")) !== "active") {
      errors.push(`${relativePath}: result page status must be 'active'`);
    }
    if (scalar(fields.get("retrieval_scope")) !== "result") {
      errors.push(`${relativePath}: result page retrieval_scope must be 'result'`);
    }
  }
  if (actualType === "project" && !fields.has("last_confirmed")) {
    errors.push(`${relativePath}: project needs 'last_confirmed'`);
  }
  if (actualType === "source") {
    if (!fields.has("derived_pages")) errors.push(`${relativePath}: source needs 'derived_pages'`);
    if (!fields.has("source_format")) errors.push(`${relativePath}: source needs 'source_format'`);
    if (scalar(fields.get("status")) !== "evidence") {
      errors.push(`${relativePath}: source status must be 'evidence'`);
    }
    if (scalar(fields.get("retrieval_scope")) !== "evidence") {
      errors.push(`${relativePath}: source retrieval_scope must be 'evidence'`);
    }
    const provenanceClass = scalar(fields.get("provenance_class"));
    if (
      provenanceClass
      && !["first_party", "external", "system_observation", "mixed"].includes(provenanceClass)
    ) {
      errors.push(`${relativePath}: invalid provenance_class '${provenanceClass}'`);
    }
    for (const field of ["raw_refs", "allowed_uses", "disallowed_uses"]) {
      if (fields.has(field)) inlineList(fields.get(field), `${relativePath}: ${field}`);
    }
  }
  if (actualType === "decision" && fields.has("decision_status")) {
    const decisionStatus = scalar(fields.get("decision_status"));
    if (!["active", "superseded", "reversed", "expired"].includes(decisionStatus)) {
      errors.push(`${relativePath}: invalid decision_status '${decisionStatus}'`);
    }
  }

  const normalizedPath = relativePath.slice(0, -3).split(path.sep).join("/");
  const page = {
    relativePath,
    normalizedPath,
    slug,
    type: actualType,
    title: scalar(fields.get("title")),
    aliases,
    related,
    evidence,
    derivedPages,
    fields,
    body,
  };
  pages.push(page);

  if (pageBySlug.has(slug)) errors.push(`duplicate slug '${slug}'`);
  pageBySlug.set(slug, page);
  pageByPath.set(normalizedPath, page);

  for (const name of [page.title, ...aliases].filter(Boolean)) {
    const normalizedName = name.trim().toLocaleLowerCase("zh-CN");
    const owner = nameOwners.get(normalizedName);
    if (owner && owner !== relativePath) {
      errors.push(`duplicate title/alias '${name}': ${owner}, ${relativePath}`);
    } else {
      nameOwners.set(normalizedName, relativePath);
    }
  }
}

if (plainRelationReferences > 0 && obsidianRelationReferences > 0) {
  errors.push(
    `mixed relation formats: ${plainRelationReferences} plain slug(s) and ${obsidianRelationReferences} Obsidian internal link(s); migrate the complete vault atomically`,
  );
}

function resolveReference(reference) {
  const clean = reference.split("|")[0].split("#")[0].replace(/\.md$/, "").trim();
  if (!clean) return undefined;
  return pageByPath.get(clean) ?? pageBySlug.get(path.basename(clean));
}

function resolvesRawReference(reference) {
  const clean = reference.split("|")[0].split("#")[0].replace(/\.md$/, "").trim();
  return rawPaths.has(clean) || rawSlugs.has(path.basename(clean));
}

function referencesPage(references, page) {
  return references.some((reference) => resolveReference(reference) === page);
}

for (const page of pages) {
  for (const reference of page.related) {
    const target = resolveReference(reference);
    if (!target) errors.push(`${page.relativePath}: unresolved related page '${reference}'`);
    else if (!RESULT_TYPES.has(target.type)) {
      errors.push(`${page.relativePath}: related must point to a result page, got '${reference}'`);
    }
  }

  for (const reference of page.evidence) {
    const target = resolveReference(reference);
    if (!target) errors.push(`${page.relativePath}: unresolved evidence '${reference}'`);
    else if (target.type !== "source") {
      errors.push(`${page.relativePath}: evidence must point to source, got '${reference}'`);
    } else if (!referencesPage(target.derivedPages, page)) {
      errors.push(`${page.relativePath}: evidence '${reference}' is missing reverse derived_pages`);
    }
  }

  for (const reference of page.derivedPages) {
    const target = resolveReference(reference);
    if (!target) errors.push(`${page.relativePath}: unresolved derived page '${reference}'`);
    else if (!RESULT_TYPES.has(target.type)) {
      errors.push(`${page.relativePath}: derived_pages must point to a result page`);
    } else if (!referencesPage(target.evidence, page)) {
      errors.push(`${page.relativePath}: derived page '${reference}' is missing reverse evidence`);
    }
  }

  for (const match of page.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const reference = match[1];
    if (!resolveReference(reference) && !resolvesRawReference(reference)) {
      errors.push(`${page.relativePath}: unresolved wikilink '[[${reference}]]'`);
    }
  }

  if (page.type === "source" && page.fields.has("sources")) {
    for (const source of inlineList(page.fields.get("sources"), `${page.relativePath}: sources`)) {
      if (source.startsWith(".raw/") && !(await exists(source))) {
        errors.push(`${page.relativePath}: missing raw source '${source}'`);
      }
    }
  }
  if (page.type === "source" && page.fields.has("raw_refs")) {
    for (const source of inlineList(page.fields.get("raw_refs"), `${page.relativePath}: raw_refs`)) {
      if (source.startsWith(".raw/") && !(await exists(source))) {
        errors.push(`${page.relativePath}: missing raw reference '${source}'`);
      }
    }
  }
}

const counts = Object.fromEntries(
  [...TYPE_BY_DIR.values()].map((type) => [
    type,
    pages.filter((page) => page.type === type).length,
  ]),
);

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (errors.length) {
  for (const error of [...new Set(errors)]) console.error(`ERROR: ${error}`);
  console.error(`\nValidation failed with ${new Set(errors).size} error(s).`);
  process.exit(1);
}

console.log(`Vault valid: ${pages.length} active pages`);
if (obsidianRelationReferences > 0) {
  console.log(`Relation format: Obsidian internal links (${obsidianRelationReferences})`);
} else if (plainRelationReferences > 0) {
  console.log(`Relation format: legacy plain slugs (${plainRelationReferences})`);
} else {
  console.log("Relation format: no populated relations");
}
console.log(JSON.stringify(counts, null, 2));
