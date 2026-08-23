#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GBRAIN = process.env.GBRAIN_BIN || path.join(os.homedir(), ".bun/bin/gbrain");
const CONTENT_DIRS = [
  "projects",
  "decisions",
  "methods",
  "syntheses",
  "concepts",
  "sources",
];
const MANAGED_SOURCES = new Set(["kb-schema", "frontmatter"]);

function call(tool, parameters) {
  const output = execFileSync(
    GBRAIN,
    ["call", tool, JSON.stringify(parameters)],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(output);
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

function inlineList(raw = "") {
  const value = raw.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return [];
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let buffer = "";
  let quote = "";
  for (const character of inner) {
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
  items.push(scalar(buffer));
  return items.map((item) => item.trim()).filter(Boolean);
}

function frontmatter(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return new Map();
  const closing = lines.indexOf("---", 1);
  if (closing === -1) return new Map();

  const fields = new Map();
  for (const line of lines.slice(1, closing)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
    if (match) fields.set(match[1], (match[2] ?? "").trim());
  }
  return fields;
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

const pages = [];
const pageByBasename = new Map();
for (const directory of CONTENT_DIRS) {
  for (const name of readdirSync(path.join(ROOT, directory)).sort()) {
    if (!name.endsWith(".md")) continue;
    const slug = `${directory}/${name.slice(0, -3)}`;
    const fields = frontmatter(readFileSync(path.join(ROOT, directory, name), "utf8"));
    const page = { slug, basename: name.slice(0, -3), fields };
    pages.push(page);
    pageByBasename.set(page.basename, page.slug);
  }
}

function resolve(reference) {
  const clean = normalizeRelationReference(reference);
  if (clean.includes("/")) return clean;
  return pageByBasename.get(clean);
}

const desired = new Map();
function desire(from, toReference, linkType, field) {
  const to = resolve(toReference);
  if (!to) throw new Error(`Cannot resolve ${field} reference '${toReference}' from '${from}'`);
  const key = `${from}\u0000${to}\u0000${linkType}`;
  desired.set(key, {
    from,
    to,
    link_type: linkType,
    link_source: "kb-schema",
    context: `frontmatter.${field}: ${toReference}`,
  });
}

for (const page of pages) {
  for (const target of inlineList(page.fields.get("related"))) {
    desire(page.slug, target, "related_to", "related");
  }
  for (const target of inlineList(page.fields.get("evidence"))) {
    desire(page.slug, target, "derived_from", "evidence");
  }
  for (const target of inlineList(page.fields.get("derived_pages"))) {
    desire(page.slug, target, "supports", "derived_pages");
  }
}
const expectedManagedCount = desired.size;

const current = [];
for (const page of pages) {
  const links = call("get_links", { slug: page.slug });
  for (const link of links) current.push(link);
}

let removed = 0;
for (const link of current) {
  if (!MANAGED_SOURCES.has(link.link_source)) continue;
  const key = `${link.from_slug}\u0000${link.to_slug}\u0000${link.link_type}`;
  if (link.link_source === "kb-schema" && desired.has(key)) {
    desired.delete(key);
    continue;
  }
  call("remove_link", {
    from: link.from_slug,
    to: link.to_slug,
    link_type: link.link_type,
    link_source: link.link_source,
  });
  removed += 1;
}

let added = 0;
for (const edge of desired.values()) {
  call("add_link", edge);
  added += 1;
}

const finalLinks = pages.flatMap((page) => call("get_links", { slug: page.slug }));
const managedCount = finalLinks.filter((link) => link.link_source === "kb-schema").length;

if (managedCount !== expectedManagedCount) {
  throw new Error(
    `Graph reconciliation mismatch: expected ${expectedManagedCount}, found ${managedCount}`,
  );
}

console.log(
  `Graph synchronized: ${managedCount} managed edges (${added} added, ${removed} removed)`,
);
