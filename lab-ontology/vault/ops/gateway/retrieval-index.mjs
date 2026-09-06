import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { KnowledgeCatalog } from "./knowledge-catalog.mjs";
import { buildLexicalMetadataEvidence } from "./knowledge-router.mjs";
import { createRepositorySnapshot } from "./repository-snapshot.mjs";
import { acquireProcessLock, releaseProcessLock } from "./process-lock.mjs";
import { deriveSchemaRuntime, readSchemaPack, assertSchemaRuntimeCurrent, assertSchemaRuntimeAtCommit } from "./schema-pack.mjs";

const CHUNKER_VERSION = "knowledge-cjk-window-v1";
const FORMAT_VERSION = 3;
const GENERATION_PATTERN = /^[a-f0-9]{12}-[a-f0-9]{16}$/;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function nativeIndexRootFor(root, stateRoot) {
  const repository = realpathSync(path.resolve(root));
  return path.join(path.resolve(stateRoot), "indexes", "native", hash(repository).slice(0, 16));
}

function command(root, args) {
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

function committedKnowledgeFiles(root, commit, schemaRuntime) {
  return command(root, ["ls-tree", "-r", "-z", "--full-tree", commit])
    .split("\0").filter(Boolean).map((entry) => {
      const tab = entry.indexOf("\t");
      if (tab < 0) throw indexedError("INDEX_SCOPE_UNAVAILABLE", "Cannot parse committed Git tree");
      const [mode, kind, objectId] = entry.slice(0, tab).split(" ");
      return { mode, kind, object_id: objectId, relative: entry.slice(tab + 1) };
    })
    .filter(({ relative }) => relative.endsWith(".md") && schemaRuntime.typeForPath(relative))
    .sort((left, right) => left.relative.localeCompare(right.relative));
}

function committedCorpusDescriptor(root, commit, schemaRuntime) {
  const files = committedKnowledgeFiles(root, commit, schemaRuntime);
  for (const { mode, kind, relative } of files) {
    if (kind !== "blob" || !["100644", "100755"].includes(mode)) {
      throw indexedError("UNSAFE_SOURCE", `Knowledge source is not a regular tracked file: ${relative}`);
    }
  }
  return {
    files,
    sha256: hash(JSON.stringify(files.map(({ mode, kind, object_id, relative }) => [mode, kind, object_id, relative]))),
  };
}

function indexedPageRecord(page, relative, objectId) {
  const list = (value) => Array.isArray(value) ? value.map(String) : [];
  return {
    slug: page.slug,
    path: relative,
    title: page.title,
    type: page.type,
    aliases: list(page.frontmatter.aliases),
    tags: list(page.frontmatter.tags),
    modules: list(page.frontmatter.modules),
    domain: String(page.frontmatter.domain || ""),
    markdown_hash: hash(page.markdown),
    git_blob: objectId,
  };
}

function indexedChunks(page, configuration) {
  const chunks = [];
  const safeTitle = page.title.replace(/<\/?context>/gi, "").slice(0, 1000);
  const prefix = configuration.document_title_prefix
    ? `<context>${safeTitle}\n</context>\n`
    : "";
  for (const [section, content] of [
    ["compiled_truth", page.compiled_truth],
    ["timeline", page.timeline],
  ]) {
    for (const part of chunkKnowledgeText(content, {
      size: configuration.chunk_size,
      overlap: configuration.chunk_overlap,
    })) {
      const id = `${page.slug}:${section}:${part.start}`;
      const input = prefix + part.text;
      chunks.push({
        id,
        slug: page.slug,
        section,
        start: part.start,
        end: part.end,
        text: part.text,
        text_hash: hash(part.text),
        embedding_input_hash: hash(input),
        input,
      });
    }
  }
  return chunks;
}

function committedIndexRecords(root, commit, schemaRuntime, configuration) {
  const corpus = committedCorpusDescriptor(root, commit, schemaRuntime);
  const catalog = new KnowledgeCatalog({ root, commit });
  const pages = [];
  const chunks = [];
  for (const { object_id: objectId, relative } of corpus.files) {
    const expectedSlug = relative.slice(0, -".md".length);
    const expectedType = schemaRuntime.typeForPath(relative);
    const page = catalog.getPage(relative, { fuzzy: false });
    if (!page || page.slug !== expectedSlug || page.type !== expectedType
      || page.frontmatter.retrieval_scope !== schemaRuntime.scopeForType(expectedType)) {
      throw indexedError("INDEX_SCOPE_MISMATCH", `Committed page cannot be reproduced canonically: ${relative}`);
    }
    pages.push(indexedPageRecord(page, relative, objectId));
    chunks.push(...indexedChunks(page, configuration));
  }
  return { corpus, pages, chunks };
}

function durableWrite(file, content) {
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function canonicalDestination(destination) {
  let existing = destination;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("Cannot resolve index destination");
    existing = parent;
  }
  return path.resolve(realpathSync(existing), path.relative(existing, destination));
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "EMBEDDING_FAILED";
}

function indexedError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function nativeQueryTerms(text) {
  const normalized = String(text).normalize("NFKC").toLowerCase();
  const weights = new Map();
  for (const word of normalized.match(/[a-z0-9]+(?:[._:-][a-z0-9]+)*/g) || []) {
    weights.set(word, word.length >= 5 ? 3 : 2);
  }
  for (const run of normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) || []) {
    const characters = Array.from(run);
    if (characters.length === 1) weights.set(run, 0.5);
    for (const size of [2, 4]) {
      for (let index = 0; index <= characters.length - size; index += 1) {
        weights.set(characters.slice(index, index + size).join(""), size === 4 ? 3 : 1);
      }
    }
  }
  return [...weights].map(([term, weight]) => ({ term, weight }));
}

// Independent, versioned chunker; not claimed bit-identical to the external
// implementation. Unicode code-point windows preserve every character, prefer
// nearby paragraph/sentence boundaries, and never depend on English whitespace.
export function chunkKnowledgeText(text, { size = 1200, overlap = 160 } = {}) {
  if (!Number.isInteger(size) || size < 32 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new Error("Invalid chunk size or overlap");
  }
  const characters = Array.from(String(text ?? ""));
  if (!characters.join("").trim()) return [];
  const chunks = [];
  let start = 0;
  while (start < characters.length) {
    let end = Math.min(start + size, characters.length);
    if (end < characters.length) {
      const minimum = start + Math.max(overlap + 1, Math.floor(size * 0.65));
      for (let candidate = end - 1; candidate >= minimum; candidate -= 1) {
        if (/[\n。！？.!?]/u.test(characters[candidate])) { end = candidate + 1; break; }
      }
    }
    const content = characters.slice(start, end).join("");
    if (content.trim()) chunks.push({ text: content, start, end });
    if (end === characters.length) break;
    start = end - overlap;
  }
  return chunks;
}

function normalizedVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw indexedError("INVALID_VECTOR", `Expected a finite ${dimensions}-dimension embedding`);
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) throw indexedError("INVALID_VECTOR", "Embedding has zero or invalid magnitude");
  return vector.map((value) => value / magnitude);
}

function countOccurrences(text, term) {
  let count = 0;
  let position = 0;
  while ((position = text.indexOf(term, position)) >= 0) {
    count += 1;
    position += term.length;
  }
  return count;
}

function lexicalScore(page, chunk, terms) {
  const normalize = (text) => String(text || "").normalize("NFKC").toLowerCase();
  const body = normalize(chunk.text);
  const named = normalize([page.title, ...page.aliases].join(" "));
  const metadata = normalize([page.slug, ...page.tags, ...page.modules, page.domain].join(" "));
  let score = 0;
  const matchedTerms = [];
  for (const { term, weight } of terms) {
    const bodyCount = countOccurrences(body, term);
    const value = (named.includes(term) ? 8 : 0)
      + (metadata.includes(term) ? 3 : 0)
      + (bodyCount ? 1 + Math.log1p(bodyCount) : 0);
    if (value) { score += weight * value; matchedTerms.push(term); }
  }
  return { score, matchedTerms };
}

function ordered(list) {
  return list.sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id));
}

function bestPerPage(list) {
  const seen = new Set();
  return ordered(list).filter((hit) => {
    if (seen.has(hit.chunk.slug)) return false;
    seen.add(hit.chunk.slug);
    return true;
  });
}

function normalizedDigest(value) {
  const digest = String(value || "").toLowerCase().replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

/** Persistent native hybrid index used by the active retrieval coordinator. */
export class LocalHybridIndex {
  constructor({ root, indexRoot, model = "qwen3-embedding:0.6b", dimensions = 1024,
    apiUrl = "http://127.0.0.1:11434", modelRevision = null, queryPrefix = "",
    documentTitlePrefix = true, chunkSize = 1200, chunkOverlap = 160,
    batchSize = 16, requestTimeoutMs = 30_000, fetchImpl = globalThis.fetch, onProgress = null,
    temporaryDirectoryFactory = mkdtempSync, schemaRuntime = null,
  }) {
    if (!root || !indexRoot) throw new Error("root and explicit isolated indexRoot are required");
    this.root = realpathSync(path.resolve(root));
    this.indexRoot = canonicalDestination(path.resolve(indexRoot));
    if (this.indexRoot === this.root || this.indexRoot.startsWith(`${this.root}${path.sep}`)) {
      throw new Error("Derived indexRoot must be outside the knowledge repository");
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 16384) throw new Error("Invalid embedding dimensions");
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128) throw new Error("Invalid batch size");
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error("Invalid embedding timeout");
    chunkKnowledgeText("validation", { size: chunkSize, overlap: chunkOverlap });
    this.model = model; this.dimensions = dimensions; this.modelRevision = modelRevision;
    this.apiUrl = String(apiUrl).replace(/\/+$/, ""); this.fetchImpl = fetchImpl;
    this.queryPrefix = queryPrefix; this.documentTitlePrefix = documentTitlePrefix;
    this.chunkSize = chunkSize; this.chunkOverlap = chunkOverlap;
    this.batchSize = batchSize; this.requestTimeoutMs = requestTimeoutMs; this.onProgress = onProgress;
    this.temporaryDirectoryFactory = temporaryDirectoryFactory;
    this.schemaRuntime = schemaRuntime || deriveSchemaRuntime(readSchemaPack(this.root));
    assertSchemaRuntimeCurrent(this.root, this.schemaRuntime);
  }

  configuration() {
    return {
      provider: "ollama", model: this.model, declared_model_revision: this.modelRevision,
      embedding_endpoint_hash: hash(this.apiUrl),
      dimensions: this.dimensions, query_prefix: this.queryPrefix,
      document_title_prefix: this.documentTitlePrefix,
      chunker_version: CHUNKER_VERSION, chunk_size: this.chunkSize, chunk_overlap: this.chunkOverlap,
      retrieval_schema: this.schemaRuntime.retrievalConfiguration,
    };
  }

  async observeModelIdentity() {
    const controller = new AbortController();
    let timer;
    try {
      const operation = async () => {
        const response = await this.fetchImpl(`${this.apiUrl}/api/tags`, { signal: controller.signal });
        if (!response.ok) throw new Error("model identity endpoint unavailable");
        const payload = await response.json();
        const expectedName = this.model.includes(":") ? this.model : `${this.model}:latest`;
        const matches = (Array.isArray(payload.models) ? payload.models : []).filter((entry) =>
          [entry.name, entry.model].includes(this.model) || [entry.name, entry.model].includes(expectedName));
        const digests = [...new Set(matches.map((entry) => normalizedDigest(entry.digest)).filter(Boolean))];
        if (!matches.length || digests.length !== 1) throw new Error("model identity is missing or ambiguous");
        return { status: "runtime_observed", model: this.model, digest: digests[0],
          source: "ollama_api_tags", endpoint_hash: hash(this.apiUrl),
          declared_revision: this.modelRevision,
          declared_matches: this.modelRevision === null ? null : normalizedDigest(this.modelRevision) === digests[0] };
      };
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("model identity timeout")); }, this.requestTimeoutMs);
      })]);
    } catch {
      return { status: "runtime_unverified", model: this.model, digest: null,
        source: "ollama_api_tags", endpoint_hash: hash(this.apiUrl),
        declared_revision: this.modelRevision, declared_matches: null };
    } finally { clearTimeout(timer); }
  }

  checkRuntimeIdentity(recorded, observed) {
    if (recorded?.status !== "runtime_verified_at_build" || observed.status !== "runtime_observed") {
      throw indexedError("MODEL_IDENTITY_UNVERIFIED", "Runtime model identity is not verifiable");
    }
    if (observed.declared_matches === false || observed.digest !== recorded.digest) {
      throw indexedError("MODEL_IDENTITY_CHANGED", "Runtime embedding model changed; rebuild required");
    }
  }

  async promotionReadiness() {
    try {
      const { manifest } = this.loadGeneration();
      const current = await this.observeModelIdentity();
      this.checkRuntimeIdentity(manifest.model_identity, current);
      return { eligible: true, identity_check_only: true,
        reason: "RUNTIME_IDENTITY_MATCHES_BUILD", generation: manifest.generation,
        runtime_identity: current, remaining_gates: ["retrieval_quality", "failure_injection", "approval"] };
    } catch (error) {
      return { eligible: false, identity_check_only: true, reason: error.code || "INDEX_UNAVAILABLE" };
    }
  }

  async embed(inputs) {
    const controller = new AbortController();
    let timer;
    try {
      const operation = async () => {
        const response = await this.fetchImpl(`${this.apiUrl}/api/embed`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, input: inputs, truncate: false }),
          signal: controller.signal,
        });
        if (!response.ok) throw indexedError("EMBEDDING_HTTP_ERROR", `Embedding service returned HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== inputs.length) {
          throw indexedError("INVALID_VECTOR_COUNT", "Embedding response count does not match input count");
        }
        return payload.embeddings.map((vector) => normalizedVector(vector, this.dimensions));
      };
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(indexedError("EMBEDDING_TIMEOUT", "Embedding service exceeded its request deadline"));
          }, this.requestTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  acquireBuildLock() {
    const file = path.join(this.indexRoot, "build.lock");
    try {
      const lock = acquireProcessLock(file, {
        kind: "native-index-build",
        timeoutMs: 0,
        pollMs: 1,
        recoverDeadOwner: true,
        minDeadAgeMs: 30_000,
      });
      return { ...lock, file: lock.path };
    } catch (error) {
      if (error?.code === "PROCESS_LOCK_TIMEOUT") {
        throw indexedError(
          "INDEX_LOCKED",
          "Another index build is running or its lock requires inspection",
        );
      }
      throw error;
    }
  }

  releaseBuildLock(lock) {
    return releaseProcessLock(lock);
  }

  async synchronize(expectedCommit, { forceFull = false } = {}) {
    if (typeof forceFull !== "boolean") throw new Error("forceFull must be a boolean");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedCommit || "")) {
      throw indexedError("INVALID_COMMIT", "A full immutable Git commit is required");
    }
    const resolved = command(this.root, ["rev-parse", "--verify", `${expectedCommit}^{commit}`]).trim();
    if (resolved !== expectedCommit) throw indexedError("INVALID_COMMIT", "Git commit did not resolve exactly");
    const repository = realpathSync(command(this.root, ["rev-parse", "--show-toplevel"]).trim());
    if (repository !== this.root) throw new Error("root must be the exact Git repository root");
    const committedSchema = assertSchemaRuntimeAtCommit(this.root, expectedCommit, this.schemaRuntime);
    const lock = this.acquireBuildLock();
    let snapshot = null;
    let pointerTemporary = null;
    let generationStaging = null;
    let unpublishedGeneration = null;
    try {
      let previous = null;
      let discardedPreviousReason = null;
      if (existsSync(path.join(this.indexRoot, "current.json"))) {
        try { previous = this.loadGeneration({ checkConfiguration: false }); }
        catch (error) {
          if (!forceFull) throw error;
          // Explicit full repair may recover a corrupt/missing generation. It
          // never trusts its vectors or carries its pointer into `previous`.
          // Canonical/runtime, model and publication gates still run normally.
          discardedPreviousReason = error.code || "INDEX_CORRUPT";
        }
      }
      const previousPointer = previous ? JSON.parse(readFileSync(path.join(this.indexRoot, "current.json"), "utf8")) : null;
      const identityBefore = await this.observeModelIdentity();
      if (identityBefore.status !== "runtime_observed") throw indexedError("MODEL_IDENTITY_UNVERIFIED", "Runtime model identity is not verifiable");
      if (identityBefore.declared_matches === false) throw indexedError("MODEL_REVISION_MISMATCH", "Declared model revision does not match runtime");
      const reusable = !forceFull && previous && JSON.stringify(previous.manifest.configuration) === JSON.stringify(this.configuration())
        && previous.manifest.model_identity?.status === "runtime_verified_at_build"
        && previous.manifest.model_identity.digest === identityBefore.digest;
      if (reusable && previous.manifest.git_commit === expectedCommit) {
        const verified = this.verifyCommit(expectedCommit);
        if (!verified.ok) throw indexedError(verified.reason, "Current native index does not cover the committed corpus");
        this.checkRuntimeIdentity(previous.manifest.model_identity, await this.observeModelIdentity());
        assertSchemaRuntimeAtCommit(this.root, expectedCommit, this.schemaRuntime);
        return { ok: true, knowledge_modified: false, git_commit: expectedCommit, index_commit: expectedCommit,
          generation: previous.manifest.generation, pages: previous.pages.length, chunks: previous.chunks.length,
          unembedded_chunks: 0, embedding_coverage_pct: 100, reused_chunks: previous.chunks.length,
          embedded_chunks: 0, sync_mode: "verify" };
      }
      snapshot = createRepositorySnapshot(this.root, expectedCommit, { temporaryDirectoryFactory: this.temporaryDirectoryFactory });
      const catalog = new KnowledgeCatalog({ root: snapshot.root });
      const corpus = committedCorpusDescriptor(this.root, expectedCommit, committedSchema);
      const files = corpus.files;
      const pages = []; const chunks = [];
      for (const { object_id: objectId, relative } of files) {
        const page = catalog.getPage(relative, { fuzzy: false });
        const expectedType = committedSchema.typeForPath(relative);
        if (!page || page.type !== expectedType || page.frontmatter.retrieval_scope !== committedSchema.scopeForType(expectedType)) {
          throw indexedError("INVALID_PAGE_SCOPE", `Canonical page type/scope mismatch: ${relative}`);
        }
        pages.push(indexedPageRecord(page, relative, objectId));
        chunks.push(...indexedChunks(page, this.configuration()));
      }
      if (!pages.length || !chunks.length) throw indexedError("EMPTY_INDEX", "Refusing to replace a working index with an empty generation");
      const reusableVectors = new Map(reusable ? previous.chunks.map((chunk) => [chunk.embedding_input_hash, chunk.vector]) : []);
      let reusedChunks = 0;
      for (const chunk of chunks) {
        const vector = reusableVectors.get(chunk.embedding_input_hash);
        if (vector) { chunk.vector = vector; delete chunk.input; reusedChunks++; }
      }
      const pendingChunks = chunks.filter((chunk) => !chunk.vector);
      for (let start = 0; start < pendingChunks.length; start += this.batchSize) {
        const batch = pendingChunks.slice(start, start + this.batchSize);
        const vectors = await this.embed(batch.map((chunk) => chunk.input));
        batch.forEach((chunk, index) => { chunk.vector = vectors[index]; delete chunk.input; });
        this.onProgress?.({ embedded: start + batch.length, reused: reusedChunks, total: chunks.length });
      }
      const identityAfter = await this.observeModelIdentity();
      if (identityAfter.status !== "runtime_observed" || identityAfter.declared_matches === false
        || identityBefore.digest !== identityAfter.digest) {
        throw indexedError("MODEL_IDENTITY_CHANGED", "Model identity changed during index build");
      }
      const verifiedIdentity = identityBefore.status === "runtime_observed" && identityAfter.status === "runtime_observed";
      const modelIdentity = {
        status: verifiedIdentity ? "runtime_verified_at_build" : "runtime_unverified",
        verification: verifiedIdentity ? "ollama_tags_before_and_after_build" : "unavailable",
        digest: verifiedIdentity ? identityBefore.digest : null,
        declared_revision: this.modelRevision,
        before: identityBefore, after: identityAfter,
      };
      const generation = `${expectedCommit.slice(0, 12)}-${randomBytes(8).toString("hex")}`;
      const manifest = {
        format_version: FORMAT_VERSION, generation, git_commit: expectedCommit,
        configuration: this.configuration(), model_identity: modelIdentity,
        canonical_schema_fingerprint: committedSchema.schemaFingerprint,
        source_tree_sha256: corpus.sha256,
        page_count: pages.length, chunk_count: chunks.length,
        unembedded_chunks: 0, embedding_coverage_pct: 100,
        reused_chunks: reusedChunks, embedded_chunks: pendingChunks.length,
        force_full: forceFull, discarded_previous_reason: discardedPreviousReason,
        pages: pages.map(({ slug, path: pagePath, type, markdown_hash, git_blob }) => ({ slug, path: pagePath, type, markdown_hash, git_blob })),
        chunks: chunks.map(({ id, text_hash, embedding_input_hash }) => ({ id, text_hash, embedding_input_hash })),
      };
      const serialized = JSON.stringify({ manifest, pages, chunks });
      const generations = path.join(this.indexRoot, "generations");
      mkdirSync(generations, { recursive: true, mode: 0o700 });
      if (lstatSync(generations).isSymbolicLink()) throw new Error("Symlink generations directory rejected");
      // Generation staging and publication must share a filesystem.
      const finalDirectory = path.join(generations, generation);
      generationStaging = path.join(generations, `.${generation}.building`);
      mkdirSync(generationStaging, { mode: 0o700 });
      durableWrite(path.join(generationStaging, "index.json"), serialized);
      syncDirectory(generationStaging);
      renameSync(generationStaging, finalDirectory);
      generationStaging = null;
      unpublishedGeneration = finalDirectory;
      syncDirectory(generations);
      // Snapshot cleanup can fail; do it before publishing the active pointer.
      snapshot.close(); snapshot = null;
      assertSchemaRuntimeAtCommit(this.root, expectedCommit, this.schemaRuntime);
      pointerTemporary = path.join(this.indexRoot, `.current-${randomBytes(8).toString("hex")}.tmp`);
      durableWrite(pointerTemporary, JSON.stringify({ generation, sha256: hash(serialized), previous: previousPointer
        ? { generation: previousPointer.generation, sha256: previousPointer.sha256 } : null }));
      renameSync(pointerTemporary, path.join(this.indexRoot, "current.json"));
      unpublishedGeneration = null;
      pointerTemporary = null;
      syncDirectory(this.indexRoot);
      // One atomic pointer names both retained generations; a crash before GC
      // leaves harmless orphans, never removes a working current or previous.
      const retained = new Set([generation, previousPointer?.generation]);
      for (const entry of readdirSync(generations)) {
        const abandonedStaging = entry.startsWith(".") && entry.endsWith(".building")
          && GENERATION_PATTERN.test(entry.slice(1, -".building".length));
        if ((GENERATION_PATTERN.test(entry) && !retained.has(entry)) || abandonedStaging) {
          const target = path.join(generations, entry);
          if (!lstatSync(target).isSymbolicLink()) rmSync(target, { recursive: true, force: true });
        }
      }
      return { ok: true, knowledge_modified: false, git_commit: expectedCommit,
        index_commit: expectedCommit, generation, pages: pages.length, chunks: chunks.length,
        unembedded_chunks: 0, embedding_coverage_pct: 100, reused_chunks: reusedChunks,
        embedded_chunks: pendingChunks.length, discarded_previous_reason: discardedPreviousReason,
        sync_mode: forceFull ? "full_repair" : reusable ? "incremental_generation" : "full_generation" };
    } finally {
      try {
        if (pointerTemporary && existsSync(pointerTemporary)) unlinkSync(pointerTemporary);
        if (generationStaging && existsSync(generationStaging)) rmSync(generationStaging, { recursive: true, force: true });
        if (unpublishedGeneration && existsSync(unpublishedGeneration)) rmSync(unpublishedGeneration, { recursive: true, force: true });
        if (snapshot) snapshot.close();
      } finally {
        this.releaseBuildLock(lock);
      }
    }
  }

  loadGeneration({ checkConfiguration = true } = {}) {
    assertSchemaRuntimeCurrent(this.root, this.schemaRuntime);
    const pointerFile = path.join(this.indexRoot, "current.json");
    if (!existsSync(pointerFile)) throw indexedError("INDEX_MISSING", "No completed index generation is available");
    const pointer = JSON.parse(readFileSync(pointerFile, "utf8"));
    if (!GENERATION_PATTERN.test(pointer.generation || "") || !/^[a-f0-9]{64}$/.test(pointer.sha256 || "")) {
      throw indexedError("INDEX_CORRUPT", "Invalid current generation pointer");
    }
    const directory = path.join(this.indexRoot, "generations", pointer.generation);
    const file = path.join(directory, "index.json");
    if (lstatSync(directory).isSymbolicLink() || lstatSync(file).isSymbolicLink()) throw indexedError("INDEX_CORRUPT", "Symlink index generation rejected");
    const serialized = readFileSync(file, "utf8");
    if (hash(serialized) !== pointer.sha256) throw indexedError("INDEX_CORRUPT", "Index generation checksum mismatch");
    const data = JSON.parse(serialized);
    if (data.manifest?.format_version !== FORMAT_VERSION || data.manifest.generation !== pointer.generation
      || data.pages?.length !== data.manifest.page_count || data.chunks?.length !== data.manifest.chunk_count) {
      throw indexedError("INDEX_CORRUPT", "Invalid generation manifest");
    }
    if (checkConfiguration && JSON.stringify(data.manifest.configuration) !== JSON.stringify(this.configuration())) {
      throw indexedError("INDEX_CONFIG_MISMATCH", "Index model, dimensions, or chunking configuration changed; rebuild required");
    }
    if (!data.pages.length || !data.chunks.length || data.manifest.unembedded_chunks !== 0
      || data.manifest.embedding_coverage_pct !== 100) throw indexedError("INDEX_CORRUPT", "Index coverage is not complete");
    const pageSlugs = new Set(data.pages.map((page) => page.slug));
    if (pageSlugs.size !== data.pages.length || new Set(data.chunks.map((chunk) => chunk.id)).size !== data.chunks.length
      || !/^[a-f0-9]{64}$/.test(data.manifest.source_tree_sha256 || "")
      || JSON.stringify(data.manifest.pages) !== JSON.stringify(data.pages.map(({ slug, path: pagePath, type, markdown_hash, git_blob }) => ({ slug, path: pagePath, type, markdown_hash, git_blob })))
      || JSON.stringify(data.manifest.chunks) !== JSON.stringify(data.chunks.map(({ id, text_hash, embedding_input_hash }) => ({ id, text_hash, embedding_input_hash })))) {
      throw indexedError("INDEX_CORRUPT", "Index manifest contents mismatch");
    }
    for (const chunk of data.chunks) {
      if (!pageSlugs.has(chunk.slug) || chunk.text_hash !== hash(chunk.text)
        || !/^[a-f0-9]{64}$/.test(chunk.embedding_input_hash)) throw indexedError("INDEX_CORRUPT", "Invalid chunk identity");
      normalizedVector(chunk.vector, data.manifest.configuration.dimensions);
      if (Math.abs(chunk.vector.reduce((sum, value) => sum + value * value, 0) - 1) > 1e-6) throw indexedError("INDEX_CORRUPT", "Non-normalized chunk vector");
    }
    return data;
  }

  verifyLoadedCommit(data, expectedCommit) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedCommit || "")) {
      throw indexedError("INVALID_COMMIT", "A full immutable Git commit is required");
    }
    if (data.manifest.git_commit !== expectedCommit) {
      throw indexedError("INDEX_STALE", "Native index was built from a different Git commit");
    }
    const committedSchema = assertSchemaRuntimeAtCommit(this.root, expectedCommit, this.schemaRuntime);
    if (data.manifest.canonical_schema_fingerprint !== committedSchema.schemaFingerprint) {
      throw indexedError("INDEX_SCOPE_MISMATCH", "Native index schema fingerprint differs from the committed schema");
    }
    const expected = committedIndexRecords(
      this.root,
      expectedCommit,
      committedSchema,
      data.manifest.configuration,
    );
    if (expected.corpus.sha256 !== data.manifest.source_tree_sha256
      || expected.pages.length !== data.pages.length
      || expected.chunks.length !== data.chunks.length) {
      throw indexedError("INDEX_SCOPE_MISMATCH", "Native index does not cover the exact committed knowledge corpus");
    }
    if (JSON.stringify(data.pages) !== JSON.stringify(expected.pages)) {
      throw indexedError("INDEX_SCOPE_MISMATCH", "Native index page metadata differs from committed Markdown");
    }
    const chunkIdentity = ({ id, slug, section, start, end, text, text_hash, embedding_input_hash }) => ({
      id, slug, section, start, end, text, text_hash, embedding_input_hash,
    });
    if (JSON.stringify(data.chunks.map(chunkIdentity))
      !== JSON.stringify(expected.chunks.map(chunkIdentity))) {
      throw indexedError("INDEX_SCOPE_MISMATCH", "Native index chunk text differs from committed Markdown");
    }
    return { ok: true, status: "ok", git_commit: expectedCommit, index_commit: data.manifest.git_commit,
      generation: data.manifest.generation, pages: data.pages.length, chunks: data.chunks.length,
      unembedded_chunks: data.manifest.unembedded_chunks,
      embedding_coverage_pct: data.manifest.embedding_coverage_pct,
      source_tree_sha256: data.manifest.source_tree_sha256,
      model_identity: data.manifest.model_identity };
  }

  verifyCommit(expectedCommit) {
    try {
      return this.verifyLoadedCommit(this.loadGeneration(), expectedCommit);
    } catch (error) {
      return { ok: false, status: "unavailable", reason: error.code || "INDEX_CORRUPT" };
    }
  }

  status(expectedCommit = null) {
    if (expectedCommit) return this.verifyCommit(expectedCommit);
    try {
      const { manifest } = this.loadGeneration();
      return { ok: true, ...manifest, runtime_identity_current: "not_checked",
        promotion: { eligible: false, reason: manifest.model_identity?.status === "runtime_verified_at_build"
          ? "LIVE_IDENTITY_CHECK_REQUIRED" : "MODEL_IDENTITY_UNVERIFIED" } };
    } catch (error) { return { ok: false, status: "unavailable", reason: error.code || "INDEX_CORRUPT" }; }
  }

  async query({ query, limit = 20, scope = "result", expectedCommit = null }) {
    if (typeof query !== "string" || !query.trim() || query.length > 6000) throw new Error("query must contain 1–6000 characters");
    if (!["result", "evidence", "all"].includes(scope)) throw new Error("Invalid retrieval scope");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
    let data;
    try { data = this.loadGeneration(); } catch (error) {
      return { hits: [], retrievalMode: "none", retrievalStatus: "unavailable",
        arms: { lexical: { status: "unavailable", reason: error.code || "INDEX_CORRUPT" },
          vector: { status: "unavailable", reason: error.code || "INDEX_CORRUPT" } }, index: null };
    }
    const { manifest } = data;
    const indexInfo = { generation: manifest.generation, git_commit: manifest.git_commit,
      stale: Boolean(expectedCommit && manifest.git_commit !== expectedCommit) };
    let verification;
    try {
      verification = this.verifyLoadedCommit(data, expectedCommit || manifest.git_commit);
    } catch (error) {
      return { hits: [], retrievalMode: "none", retrievalStatus: "unavailable",
        arms: { lexical: { status: "unavailable", reason: error.code || "INDEX_CORRUPT" },
          vector: { status: "unavailable", reason: error.code || "INDEX_CORRUPT" } }, index: indexInfo };
    }
    try { assertSchemaRuntimeAtCommit(this.root, expectedCommit || manifest.git_commit, this.schemaRuntime); }
    catch (error) { return { hits: [], retrievalMode: "none", retrievalStatus: "unavailable", index: indexInfo,
      arms: { lexical: { status: "unavailable", reason: error.code || "SCHEMA_UNAVAILABLE" },
        vector: { status: "unavailable", reason: error.code || "SCHEMA_UNAVAILABLE" } } }; }
    const pages = new Map(data.pages.filter((page) => this.schemaRuntime.scopeAllows(page.type, scope)
      && this.schemaRuntime.typeForPath(page.path) === page.type).map((page) => [page.slug, page]));
    const chunks = data.chunks.filter((chunk) => pages.has(chunk.slug));
    const lexicalMetadata = buildLexicalMetadataEvidence({ query, candidates: [...pages.values()] });
    const terms = nativeQueryTerms(query);
    const lexical = bestPerPage(chunks.map((chunk) => ({ chunk,
      ...lexicalScore(pages.get(chunk.slug), chunk, terms) })).filter((hit) => hit.score > 0));
    const arms = { lexical: { status: "ok", candidate_count: lexical.length, reason: null },
      vector: { status: "ok", candidate_count: 0, reason: null } };
    let vector = [];
    try {
      const identityBefore = await this.observeModelIdentity();
      this.checkRuntimeIdentity(manifest.model_identity, identityBefore);
      const [queryVector] = await this.embed([this.queryPrefix + query]);
      const identityAfter = await this.observeModelIdentity();
      this.checkRuntimeIdentity(manifest.model_identity, identityAfter);
      vector = bestPerPage(chunks.map((chunk) => ({ chunk,
        score: chunk.vector.reduce((sum, value, index) => sum + value * queryVector[index], 0) })));
      arms.vector.candidate_count = vector.length;
      arms.vector.model_identity = identityAfter;
    } catch (error) { arms.vector = { status: "unavailable", candidate_count: 0, reason: errorCode(error) }; }
    // Rank each arm at PAGE grain before truncation or RRF. A page with a
    // hundred high-scoring chunks must not crowd a second relevant page out.
    const poolSize = Math.min(pages.size, Math.max(100, limit * 8));
    const fused = new Map();
    for (const [name, list] of [["lexical", lexical], ["vector", vector]]) {
      list.slice(0, poolSize).forEach((hit, rank) => {
        const result = fused.get(hit.chunk.slug) || { chunk: hit.chunk, rrf: 0, lexical_score: 0, vector_score: null, matched_terms: [] };
        result.rrf += 1 / (60 + rank + 1);
        result[`${name}_score`] = hit.score;
        if (name === "lexical") result.matched_terms = hit.matchedTerms;
        fused.set(hit.chunk.slug, result);
      });
    }
    const seen = new Set();
    const hits = [...fused.values()].map((hit) => {
      const page = pages.get(hit.chunk.slug);
      const score = arms.vector.status === "ok"
        ? 0.65 * hit.rrf * 30.5 + 0.35 * Math.max(0, hit.vector_score ?? 0)
        : hit.rrf * 61;
      return { slug: page.slug, title: page.title, type: page.type, score: Number(score.toFixed(6)),
        chunk_id: hit.chunk.id, chunk_text: hit.chunk.text, chunk_source: hit.chunk.section,
        lexical_score: hit.lexical_score, vector_score: hit.vector_score,
        matched_terms: hit.matched_terms.slice(0, 20),
        lexical_metadata: lexicalMetadata.get(page.slug) || null,
        evidence: hit.lexical_score > 0 ? (hit.vector_score === null ? "native_lexical" : "native_lexical_vector") : "native_vector" };
    }).sort((left, right) => right.score - left.score || left.chunk_id.localeCompare(right.chunk_id))
      .filter((hit) => { if (seen.has(hit.slug)) return false; seen.add(hit.slug); return true; }).slice(0, limit);
    return { hits, retrievalMode: arms.vector.status === "ok" ? "native_hybrid" : "native_lexical",
      retrievalStatus: arms.vector.status === "ok" ? "ok" : "degraded", arms, index: indexInfo };
  }
}
