import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const CANONICAL_PACK_PATH = "ops/agent-knowledge-schema/pack.json";
export const SCHEMA_API_VERSION = "agent-knowledge-schema-pack-v1";
// Runtime capability is trusted code, never candidate package metadata.
export const GATEWAY_RUNTIME_VERSION = "1.8.0";
const IDENTIFIER = /^[a-z][a-z0-9_-]*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIRECTORY = /^(?:[a-z][a-z0-9_-]*\/)+$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Invalid schema pack: ${message}`);
}

function object(value, keys, label) {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  requireCondition(Object.keys(value).every((key) => keys.includes(key)), `${label} has unknown fields`);
  requireCondition(keys.every((key) => Object.hasOwn(value, key)), `${label} is missing required fields`);
}

function string(value, label, pattern) {
  requireCondition(typeof value === "string" && value.trim().length > 0 && (!pattern || pattern.test(value)), `${label} is invalid`);
}

function list(value, label, { nonempty = false, pattern } = {}) {
  requireCondition(Array.isArray(value) && (!nonempty || value.length > 0), `${label} must be an array${nonempty ? " with entries" : ""}`);
  for (const entry of value) string(entry, label, pattern);
  requireCondition(new Set(value).size === value.length, `${label} contains duplicates`);
}

function rows(value, label) {
  requireCondition(Array.isArray(value) && value.length > 0, `${label} must be a nonempty array`);
}

function uniqueNames(entries, label) {
  const names = entries.map((entry) => entry.name);
  requireCondition(new Set(names).size === names.length, `${label} names must be unique`);
  return new Set(names);
}

function versionAtLeast(actual, minimum) {
  const left = actual.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

export function validateSchemaPack(pack, { gatewayVersion = GATEWAY_RUNTIME_VERSION } = {}) {
  object(pack, ["api_version", "name", "version", "description", "author", "gateway_min_version", "page_types", "link_types", "inverse_only_link_types", "frontmatter_links", "filing_rules", "common_fields", "enums"], "pack");
  requireCondition(pack.api_version === SCHEMA_API_VERSION, "unsupported api_version");
  string(pack.name, "name", IDENTIFIER);
  string(pack.version, "version", VERSION);
  string(pack.gateway_min_version, "gateway_min_version", VERSION);
  string(pack.description, "description");
  string(pack.author, "author");
  list(pack.common_fields, "common_fields", { nonempty: true, pattern: IDENTIFIER });
  object(pack.enums, ["agent_priority", "maturity", "provenance_class", "decision_status"], "enums");
  for (const [field, values] of Object.entries(pack.enums)) {
    list(values, `enums.${field}`, { nonempty: true, pattern: IDENTIFIER });
  }
  if (gatewayVersion !== undefined) {
    string(gatewayVersion, "gatewayVersion", VERSION);
    requireCondition(versionAtLeast(gatewayVersion, pack.gateway_min_version), "gateway version is below gateway_min_version");
  }
  rows(pack.page_types, "page_types");
  const prefixes = [];
  const aliases = [];
  for (const entry of pack.page_types) {
    object(entry, ["name", "path_prefixes", "aliases", "retrieval_scope", "required_status", "required_fields"], "page_type");
    string(entry.name, "page_type.name", IDENTIFIER);
    list(entry.path_prefixes, "path_prefixes", { nonempty: true, pattern: DIRECTORY });
    list(entry.aliases, "aliases", { pattern: IDENTIFIER });
    requireCondition(["result", "evidence"].includes(entry.retrieval_scope), "page_type retrieval_scope must be result or evidence");
    string(entry.required_status, "required_status", IDENTIFIER);
    list(entry.required_fields, "required_fields", { nonempty: true, pattern: IDENTIFIER });
    requireCondition(entry.required_fields.every((field) => !pack.common_fields.includes(field)), "required_fields duplicates common_fields");
    prefixes.push(...entry.path_prefixes);
    aliases.push(...entry.aliases);
  }
  const pageNames = uniqueNames(pack.page_types, "page_type");
  requireCondition(new Set([...pageNames, ...aliases]).size === pageNames.size + aliases.length, "page_type aliases must be unique and not shadow names");
  requireCondition(prefixes.every((prefix, index) => prefixes.every((other, otherIndex) => index === otherIndex || (!prefix.startsWith(other) && !other.startsWith(prefix)))), "page_type directories overlap");
  rows(pack.link_types, "link_types");
  for (const entry of pack.link_types) {
    object(entry, ["name", "inverse"], "link_type");
    string(entry.name, "link_type.name", IDENTIFIER);
    string(entry.inverse, "link_type.inverse", IDENTIFIER);
  }
  const linkNames = uniqueNames(pack.link_types, "link_type");
  list(pack.inverse_only_link_types, "inverse_only_link_types", { pattern: IDENTIFIER });
  const inverseNames = new Set(pack.inverse_only_link_types);
  requireCondition([...inverseNames].every((name) => !linkNames.has(name)), "inverse-only names must not shadow link types");
  for (const entry of pack.link_types) {
    const inverse = pack.link_types.find((candidate) => candidate.name === entry.inverse);
    requireCondition(inverse ? inverse.inverse === entry.name : inverseNames.has(entry.inverse), `invalid reciprocal inverse for ${entry.name}`);
  }
  requireCondition([...inverseNames].every((name) => pack.link_types.filter((entry) => entry.inverse === name).length === 1), "inverse-only names must have exactly one owner");
  rows(pack.frontmatter_links, "frontmatter_links");
  const mappedFields = new Set();
  for (const entry of pack.frontmatter_links) {
    object(entry, ["page_type", "fields", "link_type"], "frontmatter_link");
    requireCondition(pageNames.has(entry.page_type) && linkNames.has(entry.link_type), "frontmatter_link references unknown type");
    list(entry.fields, "frontmatter_link.fields", { nonempty: true, pattern: IDENTIFIER });
    for (const field of entry.fields) {
      const key = `${entry.page_type}:${field}`;
      requireCondition(!mappedFields.has(key), "duplicate frontmatter field mapping");
      mappedFields.add(key);
    }
  }
  rows(pack.filing_rules, "filing_rules");
  const filedTypes = new Set();
  for (const entry of pack.filing_rules) {
    object(entry, ["kind", "directory", "examples", "description"], "filing_rule");
    requireCondition(pageNames.has(entry.kind) && !filedTypes.has(entry.kind), "filing_rule kind unknown or duplicated");
    filedTypes.add(entry.kind);
    const pageType = pack.page_types.find((candidate) => candidate.name === entry.kind);
    requireCondition(pageType.path_prefixes.includes(entry.directory), "filing_rule directory does not match page_type");
    list(entry.examples, "filing_rule.examples", { nonempty: true });
    requireCondition(entry.examples.every((example) => example.startsWith(entry.directory) && example.length > entry.directory.length && !example.split("/").some((part) => ["", ".", ".."].includes(part)) && !example.includes("\\")), "filing_rule examples escape directory");
    string(entry.description, "filing_rule.description");
  }
  requireCondition(filedTypes.size === pageNames.size, "every page_type needs a filing_rule");
  return pack;
}

export function readSchemaPack(root, schemaPackPath = CANONICAL_PACK_PATH) {
  const absolute = path.resolve(root, schemaPackPath);
  let pack;
  try {
    pack = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read canonical schema pack ${absolute}: ${error.message}`);
  }
  return validateSchemaPack(pack, { gatewayVersion: GATEWAY_RUNTIME_VERSION });
}

export function validateGatewayPackageIdentity(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "ops/gateway/package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "ops/gateway/package-lock.json"), "utf8"));
  for (const metadata of [manifest, lock, lock.packages?.[""]]) {
    if (metadata?.name !== "agent-knowledge-gateway" || metadata?.version !== GATEWAY_RUNTIME_VERSION) {
      throw new Error("Gateway package/lock identity must match trusted gateway runtime version " + GATEWAY_RUNTIME_VERSION);
    }
  }
  return GATEWAY_RUNTIME_VERSION;
}

export function deriveSchemaRuntime(pack) {
  validateSchemaPack(pack);
  const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}` : JSON.stringify(value);
  const schemaFingerprint = createHash("sha256").update(canonicalJson(pack)).digest("hex");
  const pageTypes = pack.page_types.flatMap((entry) => entry.path_prefixes.map((prefix) => [prefix, entry.name]));
  const typeScopes = pack.page_types.map((entry) => [entry.name, entry.retrieval_scope]);
  const retrievalFingerprint = createHash("sha256").update(canonicalJson({ page_types: pageTypes, type_scopes: typeScopes })).digest("hex");
  const retrievalConfiguration = { retrieval_fingerprint: retrievalFingerprint, page_types: pageTypes, type_scopes: typeScopes };
  const allTypes = pack.page_types.map((entry) => entry.name);
  const resultTypes = pack.page_types.filter((entry) => entry.retrieval_scope === "result").map((entry) => entry.name);
  const evidenceTypes = pack.page_types.filter((entry) => entry.retrieval_scope === "evidence").map((entry) => entry.name);
  const runtime = {
    allTypes, resultTypes, evidenceTypes, schemaFingerprint, retrievalFingerprint, pageTypes, retrievalConfiguration,
    typeForPath(relative) {
      if (typeof relative !== "string" || relative.startsWith("/") || /[\\\0]/.test(relative)
        || relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
      return pageTypes.find(([prefix]) => relative.startsWith(prefix) && relative.length > prefix.length)?.[1] || null;
    },
    scopeForType(type) { return typeScopes.find(([name]) => name === type)?.[1] || null; },
    contentPrefixes: [...pack.page_types.flatMap((entry) => entry.path_prefixes), ".raw/"],
    scopeAllows(type, scope) {
      if (scope === "all") return allTypes.includes(type);
      if (scope === "evidence") return evidenceTypes.includes(type);
      if (scope === "result") return resultTypes.includes(type);
      return false;
    },
  };
  const freeze = (value) => {
    if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return freeze(runtime);
}

export function assertSchemaRuntimeCurrent(root, runtime) {
  const current = deriveSchemaRuntime(readSchemaPack(root));
  if (current.retrievalFingerprint !== runtime?.retrievalFingerprint) {
    throw Object.assign(new Error("Canonical retrieval semantics changed since runtime initialization"), { code: "SCHEMA_RUNTIME_MISMATCH" });
  }
  return current;
}

export function assertSchemaRuntimeAtCommit(root, commit, runtime) {
  const current = assertSchemaRuntimeCurrent(root, runtime);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit || "")) throw new Error("An immutable schema commit is required");
  let committed;
  try {
    committed = deriveSchemaRuntime(JSON.parse(execFileSync("git", ["show", `${commit}:${CANONICAL_PACK_PATH}`], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    })));
  } catch (error) {
    throw Object.assign(new Error(`Cannot read committed canonical schema: ${error.message}`), { code: "SCHEMA_COMMIT_UNAVAILABLE" });
  }
  if (committed.schemaFingerprint !== current.schemaFingerprint
    || committed.retrievalFingerprint !== runtime.retrievalFingerprint) {
    throw Object.assign(new Error("Runtime canonical schema does not match expected Git commit"), { code: "SCHEMA_COMMIT_MISMATCH" });
  }
  return committed;
}

export function validateSchemaChanges(root, changes) {
  if (!changes.some((change) => change.action === "schema")) return null;
  validateGatewayPackageIdentity(root);
  const runtime = deriveSchemaRuntime(readSchemaPack(root));
  return {
    canonical_path: CANONICAL_PACK_PATH,
    schema_fingerprint: runtime.schemaFingerprint,
    retrieval_fingerprint: runtime.retrievalFingerprint,
    consistent: true,
  };
}
