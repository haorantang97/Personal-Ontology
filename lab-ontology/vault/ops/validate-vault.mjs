#!/usr/bin/env node

import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseKnowledgeMarkdown } from "./gateway/knowledge-catalog.mjs";
import { readSchemaPack } from "./gateway/schema-pack.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = readSchemaPack(ROOT);
const TYPE_BY_DIR = new Map(PACK.page_types.flatMap((entry) =>
  entry.path_prefixes.map((prefix) => [prefix.replace(/\/$/, ""), entry.name])));
const TYPE_RULES = new Map(PACK.page_types.map((entry) => [entry.name, entry]));
const RESULT_TYPES = new Set(PACK.page_types.filter((entry) => entry.retrieval_scope === "result").map((entry) => entry.name));
const COMMON_FIELDS = PACK.common_fields;
const PROJECT_STATUSES = new Set(["active", "paused", "completed", "cancelled", "archived"]);
const LEGACY_PATHS = [".llm-wiki", "wiki", "raw", "purpose.md", "schema.md"];
const allowLegacy = process.argv.includes("--allow-legacy");
const errors = [];
const warnings = [];
let plainRelationReferences = 0;
let obsidianRelationReferences = 0;

function parseFrontmatter(text, relativePath) {
  try {
    const parsed = parseKnowledgeMarkdown(text, {
      strict: true,
      preservePlainDates: true,
      sourceLabel: relativePath,
    });
    return { fields: new Map(Object.entries(parsed.frontmatter)), body: parsed.body };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : `${relativePath}: invalid YAML frontmatter`);
    return { fields: new Map(), body: text };
  }
}

function scalar(raw = "") {
  if (raw === null || raw === undefined || Array.isArray(raw)) return "";
  return String(raw).trim();
}

function listValue(raw = "", label = "") {
  if (!Array.isArray(raw)) {
    errors.push(`${label}: expected a YAML list`);
    return [];
  }
  const values = [];
  for (const item of raw) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      errors.push(`${label}: list entries must be scalar values`);
      continue;
    }
    const value = String(item).trim();
    if (value) values.push(value);
  }
  return values;
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
  const references = listValue(raw, label);
  for (const reference of references) {
    if (isObsidianRelationReference(reference)) obsidianRelationReferences += 1;
    else plainRelationReferences += 1;
  }
  return references.map(normalizeRelationReference);
}

function hasValue(value) {
  if (Array.isArray(value)) return true;
  return scalar(value).length > 0;
}

function markdownOutsideFences(body = "") {
  let fenced = false;
  let marker = "";
  return String(body).split("\n").map((line) => {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!fenced) {
        fenced = true;
        marker = fence[1][0];
      } else if (fence[1][0] === marker) {
        fenced = false;
        marker = "";
      }
      return "";
    }
    return fenced ? "" : line;
  }).join("\n");
}

async function markdownFiles(directory) {
  const absoluteDirectory = path.join(ROOT, directory);
  let entries;
  try { entries = await readdir(absoluteDirectory, { withFileTypes: true }); }
  catch (error) {
    // Git snapshots omit empty directories. An absent canonical prefix has
    // zero pages; permission failures and other I/O errors still fail closed.
    if (error.code === "ENOENT") return [];
    throw error;
  }
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
  const directory = [...TYPE_BY_DIR.keys()].find((prefix) => relativePath.split(path.sep).join("/").startsWith(`${prefix}/`));
  const expectedType = TYPE_BY_DIR.get(directory);
  const actualType = scalar(fields.get("type"));
  const slug = path.basename(relativePath, ".md");

  for (const field of COMMON_FIELDS) {
    if (!fields.has(field) || !hasValue(fields.get(field))) {
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
  if (!PACK.enums.agent_priority.includes(scalar(fields.get("agent_priority")))) {
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
  const aliases = listValue(fields.get("aliases"), `${relativePath}: aliases`);
  listValue(fields.get("tags"), `${relativePath}: tags`);
  if (fields.has("modules")) {
    listValue(fields.get("modules"), `${relativePath}: modules`);
  }
  const maturity = scalar(fields.get("maturity"));
  if (maturity && !PACK.enums.maturity.includes(maturity)) {
    errors.push(`${relativePath}: invalid maturity '${maturity}'`);
  }
  const typeRule = TYPE_RULES.get(actualType);
  if (typeRule) {
    for (const field of typeRule.required_fields) {
      if (!fields.has(field)) errors.push(`${relativePath}: ${actualType} needs '${field}'`);
    }
    if (scalar(fields.get("status")) !== typeRule.required_status) {
      errors.push(`${relativePath}: ${actualType} status must be '${typeRule.required_status}'`);
    }
    if (scalar(fields.get("retrieval_scope")) !== typeRule.retrieval_scope) {
      errors.push(`${relativePath}: ${actualType} retrieval_scope must be '${typeRule.retrieval_scope}'`);
    }
  }
  if (actualType === "source") {
    const provenanceClass = scalar(fields.get("provenance_class"));
    if (
      provenanceClass
      && !PACK.enums.provenance_class.includes(provenanceClass)
    ) {
      errors.push(`${relativePath}: invalid provenance_class '${provenanceClass}'`);
    }
    for (const field of ["raw_refs", "allowed_uses", "disallowed_uses"]) {
      if (fields.has(field)) listValue(fields.get(field), `${relativePath}: ${field}`);
    }
  }
  if (actualType === "project" && fields.has("project_status")) {
    const projectStatus = scalar(fields.get("project_status"));
    if (!PROJECT_STATUSES.has(projectStatus)) {
      errors.push(`${relativePath}: invalid project_status '${projectStatus}'`);
    }
  }
  if (actualType === "decision" && fields.has("decision_status")) {
    const decisionStatus = scalar(fields.get("decision_status"));
    if (!PACK.enums.decision_status.includes(decisionStatus)) {
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

  for (const match of markdownOutsideFences(page.body).matchAll(/\[\[([^\]]+)\]\]/g)) {
    const reference = match[1];
    if (!resolveReference(reference) && !resolvesRawReference(reference)) {
      errors.push(`${page.relativePath}: unresolved wikilink '[[${reference}]]'`);
    }
  }

  if (page.type === "source" && page.fields.has("sources")) {
    for (const source of listValue(page.fields.get("sources"), `${page.relativePath}: sources`)) {
      if (source.startsWith(".raw/") && !(await exists(source))) {
        errors.push(`${page.relativePath}: missing raw source '${source}'`);
      }
    }
  }
  if (page.type === "source" && page.fields.has("raw_refs")) {
    for (const source of listValue(page.fields.get("raw_refs"), `${page.relativePath}: raw_refs`)) {
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
