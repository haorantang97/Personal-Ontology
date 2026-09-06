import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalHybridIndex, chunkKnowledgeText, nativeQueryTerms } from "./retrieval-index.mjs";
import { deriveSchemaRuntime } from "./schema-pack.mjs";

// Native-index regression tests. No test data is written to the formal vault.
function fixture(t, overrides = {}) {
  const { schemaPack = JSON.parse(readFileSync(new URL("../agent-knowledge-schema/pack.json", import.meta.url))), ...indexOverrides } = overrides;
  const directory = mkdtempSync(path.join(os.tmpdir(), "native-index-test-"));
  const root = path.join(directory, "repository");
  const indexRoot = path.join(directory, "shadow-index");
  mkdirSync(root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Index Fixture"); git("config", "user.email", "index-fixture@example.invalid");
  const write = (file, contents) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), contents); };
  write("ops/agent-knowledge-schema/pack.json", JSON.stringify(schemaPack));
  write("ops/gateway/package.json", '{"version":"1.8.0"}');
  const page = (type, title, body) => `---\ntype: ${type}\ntitle: ${title}\naliases: []\ntags: []\nmodules: []\nretrieval_scope: ${schemaPack.page_types.find((entry) => entry.name === type).retrieval_scope}\n---\n# ${title}\n\n${body}\n`;
  write("methods/garden.md", page("methodology", "温室浇水检查", "按土壤湿度、天气与植物阶段安排浇水。幼苗补水需要复查土壤。"));
  write("projects/runtime.md", page("project", "Nimbus 工作台", "Nimbus runtime uses local services and source isolation."));
  write("sources/garden.md", page("source", "温室观察证据", "温室浇水线索只供溯源，不应作为默认事实。"));
  write(".raw/private.md", "RAW_MUST_NOT_BE_EMBEDDED");
  write("ops/internal.md", "OPS_MUST_NOT_BE_EMBEDDED");
  write("index.md", "INDEX_MUST_NOT_BE_EMBEDDED");
  git("add", "."); git("commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  const calls = [];
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({
      models: [{ name: "qwen3-embedding:0.6b", digest: "a".repeat(64) }],
    }) };
    const request = JSON.parse(options.body); calls.push(request);
    return { ok: true, json: async () => ({ embeddings: request.input.map((text) => {
      if (/温室|浇水|植物|土壤|幼苗补水/.test(text)) return [1, 0, 0];
      if (/Nimbus|runtime/i.test(text)) return [0, 1, 0];
      return [0, 0, 1];
    }) }) };
  };
  const index = new LocalHybridIndex({ root, indexRoot, dimensions: 3, fetchImpl, ...indexOverrides });
  return { root, indexRoot, write, page, git, commit, calls, index, fetchImpl, schemaPack };
}

function rewriteGeneration(fixtureState, built, mutate) {
  const generationFile = path.join(
    fixtureState.indexRoot,
    "generations",
    built.generation,
    "index.json",
  );
  const pointerFile = path.join(fixtureState.indexRoot, "current.json");
  const data = JSON.parse(readFileSync(generationFile, "utf8"));
  mutate(data);
  data.manifest.pages = data.pages.map(({
    slug, path: pagePath, type, markdown_hash, git_blob,
  }) => ({ slug, path: pagePath, type, markdown_hash, git_blob }));
  data.manifest.chunks = data.chunks.map(({
    id, text_hash, embedding_input_hash,
  }) => ({ id, text_hash, embedding_input_hash }));
  const serialized = JSON.stringify(data);
  writeFileSync(generationFile, serialized);
  const pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
  pointer.sha256 = createHash("sha256").update(serialized).digest("hex");
  writeFileSync(pointerFile, JSON.stringify(pointer));
  return data;
}

test("native terms expose Chinese ngrams and Latin words", () => {
  const terms = nativeQueryTerms("温室浇水 NIMBUS runtime");
  for (const expected of ["温室", "浇水", "nimbus", "runtime"]) assert(terms.some(({ term }) => term === expected));
});

test("native chunker preserves Unicode code points and overlap", () => {
  const text = "标题🧠。" + "测试中英 Mixed\n".repeat(40);
  const chunks = chunkKnowledgeText(text, { size: 48, overlap: 8 });
  const original = Array.from(text); const covered = new Set();
  for (const chunk of chunks) {
    assert.equal(chunk.text, original.slice(chunk.start, chunk.end).join(""));
    assert(Array.from(chunk.text).length <= 48);
    for (let index = chunk.start; index < chunk.end; index += 1) covered.add(index);
  }
  assert.equal(covered.size, original.length);
  assert.throws(() => chunkKnowledgeText(text, { size: 32, overlap: 32 }));
  assert.deepEqual(chunkKnowledgeText("\n\n"), []);
});

test("native build uses exact committed snapshot and excludes raw/ops/index/untracked", async (t) => {
  const f = fixture(t);
  f.write("methods/garden.md", f.page("methodology", "UNCOMMITTED", "DIRTY_MUST_NOT_BE_EMBEDDED"));
  f.write("concepts/untracked.md", f.page("concept", "UNTRACKED", "UNTRACKED_MUST_NOT_BE_EMBEDDED"));
  const result = await f.index.synchronize(f.commit);
  assert.equal(result.pages, 3); assert.equal(result.git_commit, f.commit);
  assert.equal(result.knowledge_modified, false); assert.equal(result.embedding_coverage_pct, 100);
  const data = f.index.loadGeneration();
  assert.deepEqual(data.pages.map(({ slug }) => slug).sort(), ["methods/garden", "projects/runtime", "sources/garden"]);
  assert(!JSON.stringify(f.calls).includes("MUST_NOT_BE_EMBEDDED"));
  assert.equal(data.manifest.configuration.chunker_version, "knowledge-cjk-window-v1");
  assert(data.manifest.pages.every(({ markdown_hash }) => /^[a-f0-9]{64}$/.test(markdown_hash)));
  assert(data.manifest.chunks.every(({ text_hash, embedding_input_hash }) => /^[a-f0-9]{64}$/.test(text_hash) && /^[a-f0-9]{64}$/.test(embedding_input_hash)));
  assert(f.git("status", "--short").includes("methods/garden.md"));
  assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
  assert(!existsSync(path.join(f.indexRoot, "build.lock")));
  const verified = f.index.verifyCommit(f.commit);
  assert.equal(verified.ok, true);
  assert.equal(verified.pages, 3);
  assert.match(verified.source_tree_sha256, /^[a-f0-9]{64}$/);
});

test("native verifier rejects a self-consistent generation without the committed corpus binding", async (t) => {
  const f = fixture(t);
  const built = await f.index.synchronize(f.commit);
  const generationFile = path.join(f.indexRoot, "generations", built.generation, "index.json");
  const pointerFile = path.join(f.indexRoot, "current.json");
  const data = JSON.parse(readFileSync(generationFile, "utf8"));
  data.manifest.source_tree_sha256 = "0".repeat(64);
  const serialized = JSON.stringify(data);
  writeFileSync(generationFile, serialized);
  const pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
  pointer.sha256 = createHash("sha256").update(serialized).digest("hex");
  writeFileSync(pointerFile, JSON.stringify(pointer));
  assert.equal(f.index.loadGeneration().manifest.source_tree_sha256, "0".repeat(64));
  assert.deepEqual(f.index.verifyCommit(f.commit), {
    ok: false, status: "unavailable", reason: "INDEX_SCOPE_MISMATCH",
  });
});

test("native verifier rejects self-consistently rehashed committed-content tampering", async (t) => {
  const cases = [
    ["title", (data) => { data.pages[0].title = "FORGED TITLE"; }],
    ["markdown hash", (data) => { data.pages[0].markdown_hash = "0".repeat(64); }],
    ["schema fingerprint", (data) => {
      data.manifest.canonical_schema_fingerprint = "0".repeat(64);
    }],
    ["path-derived slug", (data) => {
      const original = data.pages[0].slug;
      const forged = "methods/forged-slug";
      data.pages[0].slug = forged;
      for (const chunk of data.chunks.filter((entry) => entry.slug === original)) {
        chunk.slug = forged;
        chunk.id = chunk.id.replace(`${original}:`, `${forged}:`);
      }
    }],
    ["chunk text", (data) => {
      const chunk = data.chunks[0];
      const page = data.pages.find((entry) => entry.slug === chunk.slug);
      chunk.text = `FORGED CHUNK ${chunk.text}`;
      chunk.text_hash = createHash("sha256").update(chunk.text).digest("hex");
      const safeTitle = page.title.replace(/<\/?context>/gi, "").slice(0, 1000);
      const input = data.manifest.configuration.document_title_prefix
        ? `<context>${safeTitle}\n</context>\n${chunk.text}`
        : chunk.text;
      chunk.embedding_input_hash = createHash("sha256").update(input).digest("hex");
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const f = fixture(subtest);
      const built = await f.index.synchronize(f.commit);
      rewriteGeneration(f, built, mutate);
      assert.doesNotThrow(() => f.index.loadGeneration());
      assert.deepEqual(f.index.verifyCommit(f.commit), {
        ok: false,
        status: "unavailable",
        reason: "INDEX_SCOPE_MISMATCH",
      });
      const query = await f.index.query({ query: "温室浇水", expectedCommit: f.commit });
      assert.equal(query.retrievalStatus, "unavailable");
      assert.equal(query.arms.lexical.reason, "INDEX_SCOPE_MISMATCH");
      assert.deepEqual(query.hits, []);
    });
  }
});

test("native semantic paraphrase is recalled and result/evidence scopes stay separate", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit);
  const result = await f.index.query({ query: "幼苗补水", expectedCommit: f.commit });
  assert.equal(result.retrievalMode, "native_hybrid"); assert.equal(result.arms.vector.status, "ok");
  assert.equal(result.hits[0].slug, "methods/garden");
  assert(result.hits.every(({ type }) => type !== "source"));
  const evidence = await f.index.query({ query: "浇水", scope: "evidence" });
  assert.equal(evidence.hits.length, 1); assert.equal(evidence.hits[0].type, "source");
  const all = await f.index.query({ query: "浇水", scope: "all" }); assert.equal(all.hits.length, 3);
});

test("native vector failure returns explicit lexical degradation", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit);
  f.index.fetchImpl = async (url, options) => {
    if (url.endsWith("/api/tags")) return f.fetchImpl(url, options);
    throw Object.assign(new Error("offline"), { code: "SERVICE_OFFLINE" });
  };
  const result = await f.index.query({ query: "温室植物浇水" });
  assert.equal(result.retrievalStatus, "degraded"); assert.equal(result.retrievalMode, "native_lexical");
  assert.equal(result.arms.lexical.status, "ok"); assert.equal(result.arms.vector.reason, "SERVICE_OFFLINE");
  assert.equal(result.hits[0].slug, "methods/garden"); assert.equal(result.hits[0].vector_score, null);
});

test("native timeout is bounded even if fetch ignores abort", async (t) => {
  const f = fixture(t, { requestTimeoutMs: 20 }); await f.index.synchronize(f.commit);
  f.index.fetchImpl = (url, options) => url.endsWith("/api/tags") ? f.fetchImpl(url, options) : new Promise(() => {});
  const result = await f.index.query({ query: "温室浇水" });
  assert.equal(result.arms.vector.reason, "EMBEDDING_TIMEOUT"); assert.equal(result.retrievalStatus, "degraded");
});

test("native failed rebuild leaves previous active generation byte-identical", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit);
  const pointer = path.join(f.indexRoot, "current.json"); const before = readFileSync(pointer, "utf8");
  f.index.chunkSize = 1100;
  f.index.fetchImpl = async (url, options) => url.endsWith("/api/tags") ? f.fetchImpl(url, options) : ({ ok: true, json: async () => ({ embeddings: [[0, 0, 0]] }) });
  await assert.rejects(f.index.synchronize(f.commit), /Embedding response count|zero or invalid/);
  assert.equal(readFileSync(pointer, "utf8"), before);
  assert.equal(readdirSync(path.join(f.indexRoot, "generations")).length, 1);
  assert(!existsSync(path.join(f.indexRoot, "build.lock")));
  assert.equal(f.git("worktree", "list", "--porcelain").split("worktree ").length - 1, 1);
});

test("native rejects dimensions, zero and NaN vectors before publication", async (t) => {
  for (const vector of [[1, 0], [0, 0, 0], [NaN, 0, 1]]) {
    const f = fixture(t, { batchSize: 1 });
    f.index.fetchImpl = async (url, options) => url.endsWith("/api/tags") ? f.fetchImpl(url, options) : ({ ok: true, json: async () => ({ embeddings: [vector] }) });
    await assert.rejects(f.index.synchronize(f.commit), /embedding|Embedding/);
    assert(!existsSync(path.join(f.indexRoot, "current.json")));
  }
});

test("native checksum, configuration and commit mismatch fail closed", async (t) => {
  const f = fixture(t);
  assert.equal((await f.index.query({ query: "温室" })).arms.vector.reason, "INDEX_MISSING");
  const built = await f.index.synchronize(f.commit);
  const stale = await f.index.query({ query: "温室", expectedCommit: "0".repeat(40) });
  assert.equal(stale.arms.lexical.reason, "INDEX_STALE"); assert.deepEqual(stale.hits, []);
  f.index.model = "different-model"; assert.equal(f.index.status().reason, "INDEX_CONFIG_MISMATCH");
  f.index.model = "qwen3-embedding:0.6b";
  const file = path.join(f.indexRoot, "generations", built.generation, "index.json");
  writeFileSync(file, readFileSync(file, "utf8") + " "); assert.equal(f.index.status().reason, "INDEX_CORRUPT");
});

test("native lock rejects concurrent builds without clearing live owner", async (t) => {
  const f = fixture(t); const lock = f.index.acquireBuildLock();
  await assert.rejects(f.index.synchronize(f.commit), /Another index build/); assert(existsSync(lock.file));
  f.index.releaseBuildLock(lock); assert.equal((await f.index.synchronize(f.commit)).ok, true);
});

test("native refuses mutable refs and in-repository or symlinked index roots", async (t) => {
  const f = fixture(t); await assert.rejects(f.index.synchronize("HEAD"), /full immutable Git commit/);
  assert.throws(() => new LocalHybridIndex({ root: f.root, indexRoot: path.join(f.root, ".index") }), /outside/);
  const link = path.join(path.dirname(f.root), "vault-link"); symlinkSync(f.root, link);
  assert.throws(() => new LocalHybridIndex({ root: f.root, indexRoot: path.join(link, "index") }), /outside/);
});

test("native rejects tracked source symlinks and canonical type/scope mismatch", async (t) => {
  const f = fixture(t); symlinkSync("../sources/garden.md", path.join(f.root, "methods", "symlink.md"));
  f.git("add", "."); f.git("commit", "-qm", "unsafe symlink");
  await assert.rejects(f.index.synchronize(f.git("rev-parse", "HEAD")), /regular tracked file/);
  assert(!existsSync(path.join(f.indexRoot, "current.json")));
  const invalid = fixture(t); invalid.write("methods/wrong.md", invalid.page("source", "Wrong", "bad scope"));
  invalid.git("add", "."); invalid.git("commit", "-qm", "bad scope");
  await assert.rejects(invalid.index.synchronize(invalid.git("rev-parse", "HEAD")), /type\/scope mismatch/);
});

test("native deleted pages disappear only after complete new generation", async (t) => {
  const f = fixture(t); const before = await f.index.synchronize(f.commit);
  f.git("rm", "projects/runtime.md"); f.git("commit", "-qm", "delete project"); const commit = f.git("rev-parse", "HEAD");
  assert.equal(f.index.status().page_count, 3);
  const after = await f.index.synchronize(commit); assert.notEqual(before.generation, after.generation);
  assert.equal(f.index.status().page_count, 2); assert.equal(readdirSync(path.join(f.indexRoot, "generations")).length, 2);
  assert((await f.index.query({ query: "Nimbus", expectedCommit: commit })).hits.every(({ slug }) => slug !== "projects/runtime"));
});

test("native page-grain fusion keeps both relevant pages with 121 chunks and limit 5", async (t) => {
  const f = fixture(t, { chunkSize: 32, chunkOverlap: 0 });
  f.git("rm", "methods/garden.md", "projects/runtime.md", "sources/garden.md");
  f.write("methods/a-long.md", f.page("methodology", "A", "猫".repeat(3835)));
  f.write("methods/b-short.md", f.page("methodology", "B", "猫"));
  f.git("add", "."); f.git("commit", "-qm", "page diversity fixture");
  const built = await f.index.synchronize(f.git("rev-parse", "HEAD"));
  assert.equal(built.pages, 2); assert.equal(built.chunks, 121);
  const result = await f.index.query({ query: "猫", limit: 5 });
  assert.equal(result.arms.lexical.candidate_count, 2);
  assert.equal(result.arms.vector.candidate_count, 2);
  assert.deepEqual(result.hits.map(({ slug }) => slug), ["methods/a-long", "methods/b-short"]);
});

test("native temporary-directory initialization failure releases the acquired build lock", async (t) => {
  const f = fixture(t, { temporaryDirectoryFactory: () => { throw new Error("temporary directory unavailable"); } });
  await assert.rejects(f.index.synchronize(f.commit), /temporary directory unavailable/);
  assert(!existsSync(path.join(f.indexRoot, "build.lock")));
  assert(!existsSync(path.join(f.indexRoot, "current.json")));
});

test("caller-declared revision is not runtime verification and cannot authorize promotion", async (t) => {
  const f = fixture(t, { modelRevision: "a".repeat(64) });
  f.index.fetchImpl = async (url, options) => {
    if (url.endsWith("/api/tags")) return { ok: false, status: 503 };
    return f.fetchImpl(url, options);
  };
  await assert.rejects(f.index.synchronize(f.commit), { code: "MODEL_IDENTITY_UNVERIFIED" });
  assert.equal(f.index.status().ok, false);
  assert.equal((await f.index.promotionReadiness()).eligible, false);
  assert.equal(f.calls.length, 0);
});

test("verified build identity requires a fresh runtime match and blocks same-tag model swaps", async (t) => {
  const f = fixture(t, { modelRevision: "a".repeat(64) }); await f.index.synchronize(f.commit);
  assert.equal(f.index.status().model_identity.status, "runtime_verified_at_build");
  assert.equal(f.index.status().promotion.eligible, false);
  assert.equal((await f.index.promotionReadiness()).eligible, true);
  let embeddingsRequested = 0;
  f.index.fetchImpl = async (url, options) => {
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: f.index.model, digest: "b".repeat(64) }] }) };
    embeddingsRequested += 1; return f.fetchImpl(url, options);
  };
  assert.equal((await f.index.promotionReadiness()).eligible, false);
  const result = await f.index.query({ query: "温室浇水" });
  assert.equal(result.arms.vector.reason, "MODEL_IDENTITY_CHANGED");
  assert.equal(embeddingsRequested, 0);
  assert.equal(result.retrievalMode, "native_lexical");
});

test("model identity change during rebuild preserves previous generation", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit);
  const pointer = path.join(f.indexRoot, "current.json"); const before = readFileSync(pointer, "utf8");
  let tagReads = 0;
  f.index.fetchImpl = async (url, options) => {
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: f.index.model, digest: (++tagReads === 1 ? "a" : "b").repeat(64) }] }) };
    return f.fetchImpl(url, options);
  };
  await assert.rejects(f.index.synchronize(f.commit), { code: "MODEL_IDENTITY_CHANGED" });
  assert.equal(readFileSync(pointer, "utf8"), before);
});

test("model swap during query embedding discards the vector arm", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit);
  let tagReads = 0;
  f.index.fetchImpl = async (url, options) => {
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: [{ name: f.index.model, digest: (++tagReads === 1 ? "a" : "b").repeat(64) }] }) };
    return f.fetchImpl(url, options);
  };
  const result = await f.index.query({ query: "温室浇水" });
  assert.equal(result.arms.vector.reason, "MODEL_IDENTITY_CHANGED");
  assert.equal(result.retrievalStatus, "degraded");
  assert(result.hits.every(({ vector_score }) => vector_score === null));
});

test("same healthy commit verifies without embedding or changing current pointer", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit);
  const file = path.join(f.indexRoot, "current.json"); const before = readFileSync(file, "utf8"); f.calls.length = 0;
  const verified = await f.index.synchronize(f.commit);
  assert.equal(verified.sync_mode, "verify"); assert.equal(verified.embedded_chunks, 0);
  assert.equal(f.calls.length, 0); assert.equal(readFileSync(file, "utf8"), before);
});
test("cross-commit reuse embeds only changed inputs and retains exactly current plus previous", async (t) => {
  const f = fixture(t); const first = await f.index.synchronize(f.commit); f.calls.length = 0;
  f.write("projects/runtime.md", f.page("project", "Nimbus 工作台", "Changed runtime input"));
  f.git("add", "."); f.git("commit", "-qm", "changed one page");
  const second = await f.index.synchronize(f.git("rev-parse", "HEAD"));
  assert.equal(second.reused_chunks, 2); assert.equal(second.embedded_chunks, 1);
  assert.equal(f.calls.flatMap((request) => request.input).length, 1);
  f.git("commit", "--allow-empty", "-qm", "metadata-only commit"); f.calls.length = 0;
  const third = await f.index.synchronize(f.git("rev-parse", "HEAD"));
  assert.equal(third.reused_chunks, 3); assert.equal(third.embedded_chunks, 0); assert.equal(f.calls.length, 0);
  const pointer = JSON.parse(readFileSync(path.join(f.indexRoot, "current.json"), "utf8"));
  assert.equal(pointer.previous.generation, second.generation);
  assert.deepEqual(readdirSync(path.join(f.indexRoot, "generations")).sort(), [second.generation, third.generation].sort());
  assert(!existsSync(path.join(f.indexRoot, "generations", first.generation)));
});
test("model or configuration identity change disables all cross-commit reuse", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit); f.calls.length = 0;
  f.index.queryPrefix = "new-prefix";
  let result = await f.index.synchronize(f.commit); assert.equal(result.reused_chunks, 0); assert.equal(result.embedded_chunks, 3);
  f.index.fetchImpl = async (url, options) => url.endsWith("/api/tags")
    ? ({ ok: true, json: async () => ({ models: [{ name: f.index.model, digest: "b".repeat(64) }] }) }) : f.fetchImpl(url, options);
  result = await f.index.synchronize(f.commit); assert.equal(result.reused_chunks, 0); assert.equal(result.embedded_chunks, 3);
});
test("corrupt current is never silently reused or replaced", async (t) => {
  const f = fixture(t); const built = await f.index.synchronize(f.commit);
  const pointer = readFileSync(path.join(f.indexRoot, "current.json"), "utf8");
  const indexFile = path.join(f.indexRoot, "generations", built.generation, "index.json");
  writeFileSync(indexFile, readFileSync(indexFile, "utf8") + "corruption");
  await assert.rejects(f.index.synchronize(f.commit), { code: "INDEX_CORRUPT" });
  assert.equal(readFileSync(path.join(f.indexRoot, "current.json"), "utf8"), pointer);
});
test("explicit forceFull bypasses healthy same-HEAD no-op and embeds every chunk", async (t) => {
  const f = fixture(t); const initial = await f.index.synchronize(f.commit); f.calls.length = 0;
  const repaired = await f.index.synchronize(f.commit, { forceFull: true });
  assert.equal(repaired.sync_mode, "full_repair"); assert.equal(repaired.reused_chunks, 0);
  assert.equal(repaired.embedded_chunks, initial.chunks); assert.notEqual(repaired.generation, initial.generation);
  assert.equal(f.calls.flatMap((call) => call.input).length, initial.chunks);
  const pointer = JSON.parse(readFileSync(path.join(f.indexRoot, "current.json"), "utf8"));
  assert.equal(pointer.previous.generation, initial.generation);
});
for (const corruption of ["pointer", "generation", "missing-generation"]) test(`forceFull rebuilds ${corruption} corruption without retaining invalid previous`, async (t) => {
  const f = fixture(t); const initial = await f.index.synchronize(f.commit); f.calls.length = 0;
  const pointerFile = path.join(f.indexRoot, "current.json");
  const oldDirectory = path.join(f.indexRoot, "generations", initial.generation);
  if (corruption === "pointer") writeFileSync(pointerFile, "{invalid pointer");
  else if (corruption === "generation") writeFileSync(path.join(oldDirectory, "index.json"), "corrupt generation");
  else rmSync(oldDirectory, { recursive: true });
  await assert.rejects(f.index.synchronize(f.commit));
  const repaired = await f.index.synchronize(f.commit, { forceFull: true });
  assert.equal(repaired.reused_chunks, 0); assert.equal(repaired.embedded_chunks, initial.chunks);
  assert.equal(repaired.sync_mode, "full_repair"); assert(repaired.discarded_previous_reason);
  const pointer = JSON.parse(readFileSync(pointerFile, "utf8")); assert.equal(pointer.previous, null);
  assert.equal(f.index.loadGeneration().manifest.generation, repaired.generation);
  assert.deepEqual(readdirSync(path.join(f.indexRoot, "generations")), [repaired.generation]);
});
test("failed forceFull repair preserves damaged pointer and generation bytes for retry", async (t) => {
  const f = fixture(t); const initial = await f.index.synchronize(f.commit);
  const pointerFile = path.join(f.indexRoot, "current.json");
  const indexFile = path.join(f.indexRoot, "generations", initial.generation, "index.json");
  writeFileSync(pointerFile, "invalid-pointer-kept-for-retry"); writeFileSync(indexFile, "damaged-generation-kept-for-retry");
  f.index.fetchImpl = async (url, options) => url.endsWith("/api/tags") ? f.fetchImpl(url, options)
    : ({ ok: false, status: 503 });
  await assert.rejects(f.index.synchronize(f.commit, { forceFull: true }), { code: "EMBEDDING_HTTP_ERROR" });
  assert.equal(readFileSync(pointerFile, "utf8"), "invalid-pointer-kept-for-retry");
  assert.equal(readFileSync(indexFile, "utf8"), "damaged-generation-kept-for-retry");
  assert.deepEqual(readdirSync(path.join(f.indexRoot, "generations")), [initial.generation]);
  assert(!existsSync(path.join(f.indexRoot, "build.lock")));
  f.index.fetchImpl = f.fetchImpl;
  assert.equal((await f.index.synchronize(f.commit, { forceFull: true })).sync_mode, "full_repair");
});
test("late schema validation failure removes only the unpublished repair generation", async (t) => {
  const f = fixture(t); const initial = await f.index.synchronize(f.commit);
  const pointerFile = path.join(f.indexRoot, "current.json"); const before = readFileSync(pointerFile, "utf8");
  f.index.onProgress = () => { f.schemaPack.description += " dirty"; f.write("ops/agent-knowledge-schema/pack.json", JSON.stringify(f.schemaPack)); };
  await assert.rejects(f.index.synchronize(f.commit, { forceFull: true }), { code: "SCHEMA_COMMIT_MISMATCH" });
  assert.equal(readFileSync(pointerFile, "utf8"), before);
  assert.deepEqual(readdirSync(path.join(f.indexRoot, "generations")), [initial.generation]);
});
test("interrupted build locks fail closed and abandoned staging is cleaned only after successful publication", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit);
  const lockFile = path.join(f.indexRoot, "build.lock"); writeFileSync(lockFile, "invalid interrupted lock");
  await assert.rejects(f.index.synchronize(f.commit), { code: "INDEX_LOCKED" }); assert(existsSync(lockFile));
  rmSync(lockFile);
  const abandoned = path.join(f.indexRoot, "generations", `.000000000000-${"0".repeat(16)}.building`);
  mkdirSync(abandoned); writeFileSync(path.join(abandoned, "index.json"), "incomplete");
  f.git("commit", "--allow-empty", "-qm", "post repair commit");
  await f.index.synchronize(f.git("rev-parse", "HEAD")); assert(!existsSync(abandoned));
  assert.equal(readdirSync(path.join(f.indexRoot, "generations")).length, 2);
});
test("native derives nested path and non-source evidence scope from committed canonical pack", async (t) => {
  const schemaPack = JSON.parse(readFileSync(new URL("../agent-knowledge-schema/pack.json", import.meta.url)));
  const project = schemaPack.page_types.find((entry) => entry.name === "project");
  project.path_prefixes = ["work/projects/"]; project.retrieval_scope = "evidence";
  const rule = schemaPack.filing_rules.find((entry) => entry.kind === "project");
  rule.directory = "work/projects/"; rule.examples = ["work/projects/example"];
  const f = fixture(t, { schemaPack });
  f.write("work/projects/runtime.md", f.page("project", "Nimbus 工作台", "Nimbus runtime evidence"));
  f.write("work/other/unmatched.md", f.page("project", "Unmatched", "must not be indexed"));
  f.git("add", "."); f.git("commit", "-qm", "nested canonical fixture"); const commit = f.git("rev-parse", "HEAD");
  const built = await f.index.synchronize(commit); assert.equal(built.pages, 3);
  const evidence = await f.index.query({ query: "Nimbus runtime", scope: "evidence", expectedCommit: commit });
  assert(evidence.hits.some((hit) => hit.slug === "work/projects/runtime"));
  assert(evidence.hits.every((hit) => ["project", "source"].includes(hit.type)));
  const result = await f.index.query({ query: "Nimbus runtime", scope: "result", expectedCommit: commit });
  assert(result.hits.every((hit) => hit.type === "methodology"));
  assert(!f.index.loadGeneration().pages.some((page) => /unmatched|projects\/runtime/.test(page.slug) && !page.slug.startsWith("work/projects/")));
});
test("schema drift is checked before same-commit no-op and scope changes invalidate old generation", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit); f.calls.length = 0;
  const pointerFile = path.join(f.indexRoot, "current.json"); const previous = readFileSync(pointerFile, "utf8");
  f.schemaPack.page_types.find((entry) => entry.name === "project").retrieval_scope = "evidence";
  f.write("ops/agent-knowledge-schema/pack.json", JSON.stringify(f.schemaPack));
  await assert.rejects(f.index.synchronize(f.commit), { code: "SCHEMA_RUNTIME_MISMATCH" });
  const replacement = new LocalHybridIndex({ root: f.root, indexRoot: f.indexRoot, dimensions: 3, fetchImpl: f.fetchImpl });
  assert.equal(replacement.status().reason, "INDEX_CONFIG_MISMATCH");
  await assert.rejects(replacement.synchronize(f.commit), { code: "SCHEMA_COMMIT_MISMATCH" });
  assert.equal(f.calls.length, 0); assert.equal(readFileSync(pointerFile, "utf8"), previous);
  f.write("projects/runtime.md", f.page("project", "Nimbus 工作台", "Nimbus runtime evidence"));
  f.git("add", "."); f.git("commit", "-qm", "approved schema fixture");
  const commit = f.git("rev-parse", "HEAD"); const rebuilt = await replacement.synchronize(commit);
  assert.equal(rebuilt.reused_chunks, 0); assert.equal(rebuilt.embedded_chunks, 3);
  assert((await replacement.query({ query: "Nimbus runtime", scope: "result", expectedCommit: commit })).hits.every((hit) => hit.type !== "project"));
});
test("native missing canonical never falls back to legacy or a persisted generation", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit);
  rmSync(path.join(f.root, "ops/agent-knowledge-schema/pack.json"));
  assert.equal(f.index.status().ok, false);
  assert.equal((await f.index.query({ query: "Nimbus" })).retrievalStatus, "unavailable");
  assert.throws(() => new LocalHybridIndex({ root: f.root, indexRoot: f.indexRoot }), /canonical schema/);
  await assert.rejects(f.index.synchronize(f.commit), /canonical schema/);
  f.git("add", "."); f.git("commit", "-qm", "missing canonical fixture"); const commit = f.git("rev-parse", "HEAD");
  f.write("ops/agent-knowledge-schema/pack.json", JSON.stringify(f.schemaPack));
  await assert.rejects(f.index.synchronize(commit), { code: "SCHEMA_COMMIT_UNAVAILABLE" });
});
test("committed enum-only evolution preserves live retrieval runtime and reuses all vectors", async (t) => {
  const f = fixture(t); await f.index.synchronize(f.commit); f.calls.length = 0;
  const originalRuntime = f.index.schemaRuntime;
  f.schemaPack.enums.agent_priority.push("unused_value");
  f.write("ops/agent-knowledge-schema/pack.json", JSON.stringify(f.schemaPack));
  await assert.rejects(f.index.synchronize(f.commit), { code: "SCHEMA_COMMIT_MISMATCH" });
  f.git("add", "."); f.git("commit", "-qm", "enum-only canonical fixture"); const commit = f.git("rev-parse", "HEAD");
  const built = await f.index.synchronize(commit);
  assert.equal(built.embedded_chunks, 0); assert.equal(built.reused_chunks, 3); assert.equal(f.calls.length, 0);
  assert.equal(f.index.schemaRuntime, originalRuntime);
  assert.equal(f.index.loadGeneration().manifest.canonical_schema_fingerprint, deriveSchemaRuntime(f.schemaPack).schemaFingerprint);
  assert.equal((await f.index.query({ query: "Nimbus runtime", expectedCommit: commit })).retrievalStatus, "ok");
  assert.equal((await f.index.synchronize(commit)).sync_mode, "verify");
});
