import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RetrievalCoordinator,
  readCommittedPolicy,
  validateRetrievalPolicy,
  validateRetrievalPolicyProposal,
} from "./retrieval-coordinator.mjs";
import { routeKnowledgeCandidates } from "./knowledge-router.mjs";
import { deriveSchemaRuntime } from "./schema-pack.mjs";

const canonical = () => JSON.parse(readFileSync(
  new URL("../agent-knowledge-schema/pack.json", import.meta.url),
  "utf8",
));
const schemaRuntime = deriveSchemaRuntime(canonical());
const HEAD = "a".repeat(40);
const hit = {
  slug: "methods/example",
  type: "methodology",
  title: "Example",
  score: 0.8,
};
const healthy = {
  hits: [hit],
  retrievalStatus: "ok",
  retrievalMode: "native_hybrid",
  arms: { lexical: { status: "ok" }, vector: { status: "ok" } },
  index: { git_commit: HEAD },
};

function setup({ runtime = schemaRuntime, policyStatus = "committed" } = {}) {
  const events = [];
  const native = {
    query: async (args) => {
      assert.equal(args.expectedCommit, HEAD);
      events.push("native.query");
      return healthy;
    },
    synchronize: async (head, options) => {
      events.push("native.sync");
      return { index_commit: head, sync_mode: options?.forceFull ? "full_repair" : "verify" };
    },
    verifyCommit: async (head) => ({
      ok: true,
      status: "ok",
      git_commit: head,
      index_commit: head,
      model_identity: { digest: "digest" },
      unembedded_chunks: 0,
      embedding_coverage_pct: 100,
    }),
    observeModelIdentity: async () => ({ digest: "digest" }),
    checkRuntimeIdentity: () => {},
  };
  const catalog = {
    commit: HEAD,
    getPage: (slug) => [hit, { slug: "sources/example", type: "source" }]
      .find((page) => page.slug === slug),
    search: () => {
      events.push("catalog.search");
      return [hit];
    },
  };
  const coordinator = new RetrievalCoordinator({
    native,
    catalogFactory: () => catalog,
    getHead: () => HEAD,
    schemaRuntime: runtime,
    pageVerifier: (page) => page,
    policyReader: () => ({
      policy: {
        version: 2,
        active_backend: "native",
        fallback_backend: "local_markdown_keyword",
      },
      status: policyStatus,
    }),
  });
  return { coordinator, native, catalog, events };
}

test("native is the only indexed backend", async () => {
  const fixture = setup();
  const result = await fixture.coordinator.query({ query: "Example" });
  assert.equal(result.served_by, "native");
  assert.equal(result.configured, "native");
  assert.equal(result.effective, "native");
  assert.deepEqual(Object.keys(result.backends), ["native"]);
  assert.deepEqual(fixture.events, ["native.query"]);
});

for (const reason of [
  "EMBEDDING_HTTP_ERROR",
  "INDEX_CORRUPT",
  "MODEL_IDENTITY_CHANGED",
  "INDEX_CONFIG_MISMATCH",
  "INDEX_STALE",
]) {
  test(`native ${reason} falls back only to committed Markdown keyword recall`, async () => {
    const fixture = setup();
    fixture.native.query = async () => ({
      ...healthy,
      retrievalStatus: "degraded",
      arms: {
        lexical: { status: "ok" },
        vector: { status: "unavailable", reason },
      },
    });
    const result = await fixture.coordinator.query({ query: "Example" });
    assert.equal(result.served_by, "local_markdown_keyword");
    assert.equal(result.retrievalStatus, "degraded");
    assert.equal(result.fallback_reason, reason);
    assert.deepEqual(fixture.events, ["catalog.search"]);
  });
}

test("malformed native hits never bypass the catalog fallback", async () => {
  const fixture = setup();
  fixture.native.query = async () => ({ ...healthy, hits: [null] });
  const result = await fixture.coordinator.query({ query: "Example" });
  assert.equal(result.served_by, "local_markdown_keyword");
  assert.equal(result.fallback_reason, "BACKEND_RESPONSE_INVALID");
  assert.deepEqual(result.hits, [hit]);
});

test("scope gates filter evidence and Raw for native and local fallback", async () => {
  const fixture = setup();
  const rows = [
    hit,
    { slug: "sources/example", type: "source" },
    { slug: ".raw/private", type: "raw" },
  ];
  fixture.native.query = async () => ({ ...healthy, hits: rows });
  assert.deepEqual((await fixture.coordinator.query({ query: "Example" })).hits, [hit]);
  assert.deepEqual(
    (await fixture.coordinator.query({ query: "Example", scope: "evidence" })).hits,
    [rows[1]],
  );
  assert.equal(
    (await fixture.coordinator.query({ query: "Example", scope: "all" })).hits.length,
    2,
  );

  fixture.native.query = async () => ({
    ...healthy,
    retrievalStatus: "degraded",
    arms: { lexical: { status: "ok" }, vector: { status: "unavailable", reason: "OFFLINE" } },
  });
  fixture.catalog.search = () => rows;
  assert.deepEqual((await fixture.coordinator.query({ query: "Example" })).hits, [hit]);
});

test("Markdown fallback applies scope before the catalog truncates candidates", async () => {
  const fixture = setup();
  fixture.native.query = async () => {
    throw Object.assign(new Error("offline"), { code: "EMBEDDING_HTTP_ERROR" });
  };
  const evidence = Array.from({ length: 100 }, (_, index) => ({
    slug: `sources/crowding-${index}`,
    type: "source",
    score: 1000 - index,
  }));
  let receivedTypes = null;
  fixture.catalog.search = (_query, { limit, types }) => {
    assert.equal(limit, 100);
    receivedTypes = types;
    const allowed = new Set(types || []);
    return [...evidence, hit].filter((row) => allowed.has(row.type)).slice(0, limit);
  };
  const result = await fixture.coordinator.query({ query: "Example", scope: "result" });
  assert.equal(result.served_by, "local_markdown_keyword");
  assert.deepEqual(result.hits, [hit]);
  assert(receivedTypes.includes("methodology"));
  assert(!receivedTypes.includes("source"));
});

test("scope reaches native; module and vector similarity cannot open the route gate", async () => {
  const fixture = setup();
  fixture.native.query = async ({ scope }) => {
    assert.equal(scope, "evidence");
    return healthy;
  };
  await fixture.coordinator.query({ query: "Example", scope: "evidence" });
  const routed = routeKnowledgeCandidates({
    query: "把这句话翻译成英文。",
    module: "example-module",
    schemaRuntime,
    candidates: [{
      ...hit,
      modules: ["example-module"],
      base_score: 1,
      retrieval_evidence: "native_vector",
    }],
    retrievalStatus: "ok",
    retrievalMode: "native_hybrid",
  });
  assert.notEqual(routed.action, "read");
});

test("synchronization and explicit repair touch only native", async () => {
  const fixture = setup();
  const result = await fixture.coordinator.synchronize(HEAD, { forceFull: true });
  assert.deepEqual(fixture.events, ["native.sync"]);
  assert.equal(result.served_by, "native");
  assert.equal(result.index_git_commit, HEAD);
  assert.equal(result.fallback_available, "local_markdown_keyword");
  assert.equal(result.sync_mode, "full_repair");
});

test("native synchronization failure remains explicit while Markdown reads stay available", async () => {
  const fixture = setup();
  fixture.native.synchronize = async () => {
    throw Object.assign(new Error("native down"), { code: "EMBEDDING_HTTP_ERROR" });
  };
  await assert.rejects(fixture.coordinator.synchronize(HEAD), (error) => {
    assert.equal(error.retrieval.backends.native.status, "failed");
    assert.equal(error.retrieval.fallback_available, "local_markdown_keyword");
    assert.equal(error.retrieval.fallback_reason, "EMBEDDING_HTTP_ERROR");
    return true;
  });
});

test("HEAD mismatch fails before native action and movement discards hits", async () => {
  const fixture = setup();
  await assert.rejects(
    fixture.coordinator.query({ query: "Example", expectedCommit: "b".repeat(40) }),
    /current HEAD/,
  );
  await assert.rejects(fixture.coordinator.synchronize("b".repeat(40)), /current HEAD/);
  assert.deepEqual(fixture.events, []);
  fixture.native.query = async () => {
    fixture.coordinator.getHead = () => "b".repeat(40);
    return healthy;
  };
  const result = await fixture.coordinator.query({ query: "Example" });
  assert.equal(result.served_by, "none");
  assert.equal(result.fallback_reason, "HEAD_CHANGED");
  assert.deepEqual(result.hits, []);
});

for (const backend of ["native", "local_markdown_keyword"]) {
  test(`HEAD movement during ${backend} page verification discards every hit`, async () => {
    const fixture = setup();
    let currentHead = HEAD;
    fixture.coordinator.getHead = () => currentHead;
    fixture.coordinator.pageVerifier = (page) => {
      currentHead = "b".repeat(40);
      return page;
    };
    if (backend === "local_markdown_keyword") {
      fixture.native.query = async () => ({
        ...healthy,
        retrievalStatus: "degraded",
        arms: {
          lexical: { status: "ok" },
          vector: { status: "unavailable", reason: "OFFLINE" },
        },
      });
    }
    const result = await fixture.coordinator.query({ query: "Example" });
    assert.equal(result.served_by, "none");
    assert.equal(result.fallback_reason, "HEAD_CHANGED");
    assert.deepEqual(result.hits, []);
    assert.equal(result.fallback_chain.at(-1).backend, backend);
  });
}

test("committed Markdown fallback ignores dirty updates, deletions, and untracked pages", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coordinator-committed-fallback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const write = (relative, content) => {
    const destination = path.join(root, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  const page = (title, body, modules = []) => `---\ntype: methodology\ntitle: ${title}\naliases: []\ntags: []\nmodules: [${modules.join(", ")}]\nretrieval_scope: result\n---\n# ${title}\n\n${body}\n`;
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  write("ops/agent-knowledge-schema/pack.json", JSON.stringify(canonical()));
  write("methods/updated.md", page("Approved Updated", "ALPHAUNIQUEZXCV", ["approved"]));
  write("methods/deleted.md", page("Approved Deleted", "BETASINGULARQWER"));
  git("add", ".");
  git("commit", "-qm", "committed catalog fixture");
  const head = git("rev-parse", "HEAD");

  write("methods/updated.md", page("DIRTY TITLE", "OMEGAPOISONZXCV", ["poison"]));
  unlinkSync(path.join(root, "methods/deleted.md"));
  write("methods/untracked.md", page("Untracked", "UNTRACKED_SENTINEL", ["poison"]));

  const native = {
    query: async () => ({
      hits: [],
      retrievalStatus: "degraded",
      retrievalMode: "native_lexical",
      arms: {
        lexical: { status: "ok" },
        vector: { status: "unavailable", reason: "OFFLINE" },
      },
      index: { git_commit: head },
    }),
  };
  const coordinator = new RetrievalCoordinator({
    root,
    native,
    schemaRuntime,
    getHead: () => head,
    policyReader: () => ({
      policy: { version: 2, active_backend: "native", fallback_backend: "local_markdown_keyword" },
      status: "committed",
    }),
  });
  const updated = await coordinator.query({ query: "ALPHAUNIQUEZXCV" });
  assert.equal(updated.served_by, "local_markdown_keyword");
  assert.deepEqual(updated.hits.map(({ slug, title }) => [slug, title]), [
    ["methods/updated", "Approved Updated"],
  ]);
  const deleted = await coordinator.query({ query: "BETASINGULARQWER" });
  assert.deepEqual(deleted.hits.map(({ slug }) => slug), ["methods/deleted"]);
  assert.deepEqual((await coordinator.query({ query: "OMEGAPOISONZXCV" })).hits, []);
  assert.deepEqual((await coordinator.query({ query: "UNTRACKED_SENTINEL" })).hits, []);
});

test("status exposes one backend and a native-only deployment", async () => {
  const result = await setup().coordinator.status();
  assert.equal(result.configured, "native");
  assert.equal(result.deployment.native_only, true);
  assert.deepEqual(Object.keys(result.backends), ["native"]);
  assert.equal(result.backends.native.ok, true);
});

test("committed policy accepts only native with local Markdown fallback", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "retrieval-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(path.join(root, "ops/gateway"), { recursive: true });
  const file = path.join(root, "ops/gateway/retrieval-policy.json");
  const policy = {
    version: 2,
    active_backend: "native",
    fallback_backend: "local_markdown_keyword",
  };
  writeFileSync(file, JSON.stringify(policy));
  git("add", ".");
  git("commit", "-qm", "native-only policy");
  const committed = readCommittedPolicy(root, git("rev-parse", "HEAD"));
  assert.equal(committed.status, "committed");
  assert.deepEqual(committed.policy, policy);
  assert.throws(() => validateRetrievalPolicy({ ...policy, active_backend: "external" }));
  assert.throws(() => validateRetrievalPolicy({ ...policy, fallback_backend: "external" }));
  assert.equal(readCommittedPolicy(root, "missing").status, "fallback_native");
  assert.equal(validateRetrievalPolicyProposal(policy).mode, "native_v2");
  assert.throws(() => validateRetrievalPolicyProposal({
    version: 1,
    active_backend: "external",
    mirror_native: true,
  }), { code: "POLICY_INVALID" });
  assert.throws(() => validateRetrievalPolicyProposal({
    version: 1,
    active_backend: "external",
    mirror_native: "yes",
  }), { code: "POLICY_INVALID" });
});

test("Catalog verification hashes committed bytes, not only stable HEAD", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "catalog-commit-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(path.join(root, "methods"));
  writeFileSync(path.join(root, "methods/example.md"), "committed bytes\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const head = git("rev-parse", "HEAD");
  const coordinator = new RetrievalCoordinator({ root, native: {}, schemaRuntime });
  assert.equal(
    coordinator.verifyCatalogPage({ ...hit, markdown: "committed bytes\n" }, head).slug,
    hit.slug,
  );
  assert.throws(
    () => coordinator.verifyCatalogPage({ ...hit, markdown: "dirty metadata\n" }, head),
    { code: "CATALOG_COMMIT_MISMATCH" },
  );
});

test("coordinator scope uses canonical runtime and never a provider projection", async () => {
  const pack = canonical();
  pack.page_types.find((entry) => entry.name === "methodology").retrieval_scope = "evidence";
  const fixture = setup({ runtime: deriveSchemaRuntime(pack) });
  assert.deepEqual(
    (await fixture.coordinator.query({ query: "Example", scope: "result" })).hits,
    [],
  );
  assert.deepEqual(
    (await fixture.coordinator.query({ query: "Example", scope: "evidence" })).hits,
    [hit],
  );
});

test("coordinator requires the canonical schema", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coordinator-no-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => new RetrievalCoordinator({ root, native: {} }),
    /canonical schema/,
  );
});

test("live runtime accepts enum-only updates and rejects retrieval-semantic drift", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "coordinator-enum-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  mkdirSync(path.join(root, "ops/agent-knowledge-schema"), { recursive: true });
  const file = path.join(root, "ops/agent-knowledge-schema/pack.json");
  const pack = canonical();
  writeFileSync(file, JSON.stringify(pack));
  git("add", ".");
  git("commit", "-qm", "canonical fixture");
  const fixture = setup();
  fixture.coordinator.root = root;
  fixture.coordinator.getHead = () => git("rev-parse", "HEAD");
  fixture.coordinator.catalogFactory = (commit) => ({
    ...fixture.catalog,
    root,
    commit,
  });
  fixture.native.query = async ({ expectedCommit }) => ({
    ...healthy,
    index: { git_commit: expectedCommit },
  });
  pack.enums.agent_priority.push("unused_value");
  writeFileSync(file, JSON.stringify(pack));
  git("add", ".");
  git("commit", "-qm", "enum-only update");
  assert.equal((await fixture.coordinator.query({ query: "Example" })).served_by, "native");
  pack.page_types.find((entry) => entry.name === "methodology").retrieval_scope = "evidence";
  writeFileSync(file, JSON.stringify(pack));
  git("add", ".");
  git("commit", "-qm", "semantic drift fixture");
  await assert.rejects(
    fixture.coordinator.query({ query: "Example" }),
    { code: "SCHEMA_RUNTIME_MISMATCH" },
  );
});

test("server keeps the native-only coordinator in the proposal validation matrix", () => {
  const source = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  assert(source.includes("await retrievalCoordinator.query"));
  assert(source.includes("await retrievalCoordinator.synchronize"));
  assert(source.includes('["retrieval-coordinator.mjs", "retrieval-coordinator.test.mjs"]'));
  assert(!/import\s+\{[^}]*ExternalCliIndex/.test(source));
  assert(!source.includes("new ExternalCliIndex"));
  assert(source.includes('mode: "shadow"'));
  assert(source.includes("enforced: false"));
});
