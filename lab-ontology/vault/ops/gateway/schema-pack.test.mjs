import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CANONICAL_PACK_PATH, GATEWAY_RUNTIME_VERSION, SCHEMA_API_VERSION, deriveSchemaRuntime, readSchemaPack, validateSchemaChanges, validateSchemaPack, validateGatewayPackageIdentity } from "./schema-pack.mjs";
import { KnowledgeCatalog } from "./knowledge-catalog.mjs";

const canonical = () => JSON.parse(readFileSync(new URL("../agent-knowledge-schema/pack.json", import.meta.url), "utf8"));
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-schema-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const filename of [CANONICAL_PACK_PATH, "ops/gateway/package.json"]) {
    mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
  }
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), JSON.stringify(canonical()));
  for (const file of ["package.json", "package-lock.json"]) {
    writeFileSync(path.join(root, "ops/gateway", file), readFileSync(new URL(`./${file}`, import.meta.url)));
  }
  return root;
}

test("canonical schema preserves six page types and seven relationships", () => {
  const pack = validateSchemaPack(canonical(), { gatewayVersion: "1.8.0" });
  assert.equal(pack.api_version, SCHEMA_API_VERSION);
  assert.equal(pack.page_types.length, 6);
  assert.equal(pack.link_types.length, 7);
  assert.deepEqual(pack.inverse_only_link_types, ["uses", "superseded_by", "required_by"]);
  assert.equal(pack.page_types.some((entry) => Object.hasOwn(entry, "primitive")), false);
});

const invalidCases = [
  ["root array", () => []],
  ["missing field", (p) => { delete p.author; }],
  ["unknown field", (p) => { p.vendor = "unknown"; }],
  ["API version", (p) => { p.api_version = "unknown-v2"; }],
  ["semver", (p) => { p.version = "latest"; }],
  ["minimum version", (p) => { p.gateway_min_version = "01.8.0"; }],
  ["newer gateway required", (p) => { p.gateway_min_version = "2.0.0"; }],
  ["provider inheritance field", (p) => { p.extends = null; }],
  ["provider borrowed rules field", (p) => { p.borrow_from = []; }],
  ["duplicate page type", (p) => { p.page_types.push(p.page_types[0]); }],
  ["provider primitive field", (p) => { p.page_types[0].primitive = "concept"; }],
  ["provider extraction flag", (p) => { p.page_types[0].extractable = false; }],
  ["directory traversal", (p) => { p.page_types[0].path_prefixes = ["../projects/"]; }],
  ["directory overlap", (p) => { p.page_types[1].path_prefixes = ["projects/nested/"]; }],
  ["duplicate directory", (p) => { p.page_types[1].path_prefixes = ["projects/"]; }],
  ["alias collision", (p) => { p.page_types[0].aliases = ["decision"]; }],
  ["duplicate link type", (p) => { p.link_types.push(p.link_types[0]); }],
  ["missing inverse", (p) => { p.link_types[0].inverse = "missing"; }],
  ["non-reciprocal inverse", (p) => { p.link_types[1].inverse = "related_to"; }],
  ["unowned inverse-only name", (p) => { p.inverse_only_link_types.push("orphan"); }],
  ["multiply-owned inverse-only name", (p) => { p.link_types[5].inverse = "uses"; }],
  ["inverse collision", (p) => { p.inverse_only_link_types.push("supports"); }],
  ["invalid frontmatter type", (p) => { p.frontmatter_links[0].page_type = "unknown"; }],
  ["invalid frontmatter link", (p) => { p.frontmatter_links[0].link_type = "unknown"; }],
  ["empty frontmatter fields", (p) => { p.frontmatter_links[0].fields = []; }],
  ["duplicate frontmatter mapping", (p) => { p.frontmatter_links.push(p.frontmatter_links[0]); }],
  ["provider enrichment field", (p) => { p.enrichable_types = []; }],
  ["invalid retrieval scope", (p) => { p.page_types[0].retrieval_scope = "raw"; }],
  ["missing required status", (p) => { delete p.page_types[0].required_status; }],
  ["duplicate required field", (p) => { p.page_types[0].required_fields.push("related"); }],
  ["missing common fields", (p) => { delete p.common_fields; }],
  ["missing enum", (p) => { delete p.enums.maturity; }],
  ["duplicate enum", (p) => { p.enums.maturity.push("seed"); }],
  ["missing filing rule", (p) => { p.filing_rules.pop(); }],
  ["mismatched filing directory", (p) => { p.filing_rules[0].directory = "other/"; }],
  ["escaping example", (p) => { p.filing_rules[0].examples = ["projects/../secret"]; }],
];
for (const [label, mutate] of invalidCases) {
  test(`validator rejects ${label}`, () => {
    const pack = canonical();
    const replacement = mutate(pack);
    assert.throws(() => validateSchemaPack(replacement ?? pack, { gatewayVersion: "1.8.0" }), /Invalid schema pack/);
  });
}

test("canonical reads fail closed without a provider-specific fallback", (t) => {
  const root = fixture(t);
  const catalog = new KnowledgeCatalog({ root });
  assert.equal(catalog.activePack().canonical_path, CANONICAL_PACK_PATH);
  assert.equal(catalog.activePack().api_version, SCHEMA_API_VERSION);
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), "not json");
  assert.throws(() => catalog.activePack(), /Cannot read canonical schema pack/);
  rmSync(path.join(root, CANONICAL_PACK_PATH));
  assert.throws(() => catalog.activePack(), /Cannot read canonical schema pack/);
});

test("schema gate validates the canonical pack and exposes stable fingerprints", (t) => {
  const root = fixture(t);
  const initial = validateSchemaChanges(root, [{ action: "schema", target: CANONICAL_PACK_PATH }]);
  assert.equal(initial.consistent, true);
  assert.match(initial.schema_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(initial.retrieval_fingerprint, /^[a-f0-9]{64}$/);
  const pack = canonical();
  pack.description += " approved edit";
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), JSON.stringify(pack));
  assert.notEqual(validateSchemaChanges(root, [{ action: "schema", target: CANONICAL_PACK_PATH }]).schema_fingerprint, initial.schema_fingerprint);
  pack.link_types[0].inverse = "unknown";
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), JSON.stringify(pack));
  assert.throws(() => validateSchemaChanges(root, [{ action: "schema", target: CANONICAL_PACK_PATH }]), /inverse/);
  assert.equal(validateSchemaChanges(root, [{ action: "update", target: "projects/example.md" }]), null);
});

test("installed gateway must meet pack minimum", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "ops/gateway/package.json"), '{"version":"1.7.9"}');
  assert.throws(() => validateGatewayPackageIdentity(root), /trusted gateway runtime version/);
  assert.equal(readSchemaPack(root).gateway_min_version, GATEWAY_RUNTIME_VERSION);
});

test("candidate metadata cannot raise trusted runtime capability", (t) => {
  const root = fixture(t);
  const pack = canonical(); pack.gateway_min_version = "99.0.0";
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), JSON.stringify(pack));
  for (const filename of ["package.json", "package-lock.json"]) {
    const full = path.join(root, "ops/gateway", filename);
    const metadata = JSON.parse(readFileSync(full)); metadata.version = "99.0.0";
    if (metadata.packages) metadata.packages[""].version = "99.0.0";
    writeFileSync(full, JSON.stringify(metadata));
  }
  assert.throws(() => readSchemaPack(root), /below gateway_min_version/);
  assert.throws(() => validateGatewayPackageIdentity(root), /trusted gateway runtime version/);
});

test("runtime sets, path prefixes and scopes are derived from canonical fields", () => {
  const pack = canonical();
  pack.page_types[0].retrieval_scope = "evidence";
  pack.page_types[0].path_prefixes = ["work/"];
  pack.filing_rules[0].directory = "work/";
  pack.filing_rules[0].examples = ["work/example"];
  const runtime = deriveSchemaRuntime(pack);
  assert.equal(runtime.scopeAllows("project", "result"), false);
  assert.equal(runtime.scopeAllows("project", "evidence"), true);
  assert.equal(runtime.scopeAllows("project", "all"), true);
  assert.equal(runtime.scopeAllows("unknown", "all"), false);
  assert.equal(runtime.scopeAllows("project", "invalid"), false);
  assert.deepEqual(runtime.evidenceTypes, ["project", "source"]);
  assert(runtime.contentPrefixes.includes("work/"));
  assert(!runtime.contentPrefixes.includes("projects/"));
  assert(runtime.contentPrefixes.includes(".raw/"));
});
test("runtime matches complete nested prefixes and serializes canonical type-scope identity", () => {
  const pack = canonical();
  const project = pack.page_types.find((entry) => entry.name === "project");
  project.path_prefixes = ["work/projects/"]; project.retrieval_scope = "evidence";
  const filing = pack.filing_rules.find((entry) => entry.kind === "project");
  filing.directory = "work/projects/"; filing.examples = ["work/projects/example"];
  const runtime = deriveSchemaRuntime(pack);
  assert.equal(runtime.typeForPath("work/projects/example.md"), "project");
  assert.equal(runtime.typeForPath("work/projects/deeper/example"), "project");
  for (const slug of ["work/elsewhere/example", "work/projects-other/example", "projects/example", "work/projects/../outside", "/work/projects/example", ".raw/example"]) assert.equal(runtime.typeForPath(slug), null);
  assert.equal(runtime.scopeForType("project"), "evidence"); assert.equal(runtime.scopeForType("missing"), null);
  assert(runtime.pageTypes.some(([prefix, type]) => prefix === "work/projects/" && type === "project"));
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.retrievalConfiguration)), runtime.retrievalConfiguration);
  const changed = structuredClone(pack); changed.page_types.find((entry) => entry.name === "project").retrieval_scope = "result";
  assert.notEqual(deriveSchemaRuntime(changed).schemaFingerprint, runtime.schemaFingerprint);
  assert.notEqual(deriveSchemaRuntime(changed).retrievalFingerprint, runtime.retrievalFingerprint);
  const enumOnly = structuredClone(pack); enumOnly.enums.agent_priority.push("new_unused_value");
  const enumRuntime = deriveSchemaRuntime(enumOnly);
  assert.notEqual(enumRuntime.schemaFingerprint, runtime.schemaFingerprint);
  assert.equal(enumRuntime.retrievalFingerprint, runtime.retrievalFingerprint);
  assert.deepEqual(enumRuntime.retrievalConfiguration, runtime.retrievalConfiguration);
});

test("vault validator derives canonical contracts and tolerates absent empty Git directories", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "ops/validate-vault.mjs"), readFileSync(new URL("../validate-vault.mjs", import.meta.url)));
  writeFileSync(path.join(root, "ops/gateway/schema-pack.mjs"), readFileSync(new URL("./schema-pack.mjs", import.meta.url)));
  const pack = canonical();
  const project = pack.page_types.find((entry) => entry.name === "project");
  project.path_prefixes = ["work/"];
  project.retrieval_scope = "evidence";
  project.required_status = "reviewed";
  project.required_fields.push("approved_marker");
  pack.filing_rules[0].directory = "work/";
  pack.filing_rules[0].examples = ["work/example"];
  pack.common_fields.push("owner");
  pack.enums.agent_priority = ["custom_priority"];
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), JSON.stringify(pack));
  for (const entry of pack.page_types) for (const prefix of entry.path_prefixes) mkdirSync(path.join(root, prefix), { recursive: true });
  mkdirSync(path.join(root, ".raw"));
  rmSync(path.join(root, "decisions"), { recursive: true });
  rmSync(path.join(root, ".raw"), { recursive: true });
  const page = `---\ntype: project\ntitle: Example\naliases: []\ntags: []\ncreated: 2030-01-01\nupdated: 2030-01-01\nstatus: reviewed\nretrieval_scope: evidence\nagent_priority: custom_priority\ndomain: testing\nevidence_status: confirmed\nowner: user\nrelated: []\nevidence: []\nlast_confirmed: 2030-01-01\napproved_marker: yes\n---\n# Example\n`;
  const run = (body) => {
    writeFileSync(path.join(root, "work/example.md"), body);
    return execFileSync(process.execPath, ["ops/validate-vault.mjs"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  };
  assert.match(run(page), /Vault valid: 1 active pages/);
  for (const [from, to, expected] of [
    ["approved_marker: yes\n", "", /approved_marker/],
    ["owner: user\n", "", /owner/],
    ["status: reviewed", "status: active", /status must be 'reviewed'/],
    ["retrieval_scope: evidence", "retrieval_scope: result", /retrieval_scope must be 'evidence'/],
    ["agent_priority: custom_priority", "agent_priority: normal", /invalid agent_priority/],
  ]) {
    assert.throws(() => run(page.replace(from, to)), (error) => expected.test(error.stderr));
  }
});
