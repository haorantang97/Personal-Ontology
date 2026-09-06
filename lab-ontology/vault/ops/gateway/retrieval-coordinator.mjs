import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { KnowledgeCatalog } from "./knowledge-catalog.mjs";
import { deriveSchemaRuntime, readSchemaPack, assertSchemaRuntimeAtCommit } from "./schema-pack.mjs";

export const POLICY_PATH = "ops/gateway/retrieval-policy.json";
const safePolicy = { version: 2, active_backend: "native", fallback_backend: "local_markdown_keyword" };
const failure = (error) => error?.code || "BACKEND_UNAVAILABLE";
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function validateRetrievalPolicy(policy) {
  if (!policy || Object.keys(policy).sort().join(",") !== "active_backend,fallback_backend,version"
    || policy.version !== 2 || policy.active_backend !== "native"
    || policy.fallback_backend !== "local_markdown_keyword") {
    throw Object.assign(new Error("Invalid retrieval policy v2"), { code: "POLICY_INVALID" });
  }
  return { ...policy };
}

export function validateRetrievalPolicyProposal(policy) {
  try {
    return { mode: "native_v2", policy: validateRetrievalPolicy(policy) };
  } catch {
    throw Object.assign(new Error("Invalid retrieval policy proposal"), { code: "POLICY_INVALID" });
  }
}

export function readCommittedPolicy(root, commit) {
  try {
    return { policy: validateRetrievalPolicy(JSON.parse(git(root, ["show", `${commit}:${POLICY_PATH}`]))), status: "committed" };
  } catch (error) {
    return { policy: { ...safePolicy }, status: "fallback_native", reason: error.code === "POLICY_INVALID" ? error.code : "POLICY_MISSING_OR_INVALID" };
  }
}

export class RetrievalCoordinator {
  constructor({ root, native, catalogFactory = null, getHead = () => git(root, ["rev-parse", "HEAD"]),
    policyReader = (head) => readCommittedPolicy(root, head), pageVerifier = null, schemaRuntime = null }) {
    if (!native) throw new Error("A native index is required");
    this.root = root ? path.resolve(root) : null; this.native = native;
    this.getHead = getHead; this.policyReader = policyReader; this.pageVerifier = pageVerifier;
    this.schemaRuntime = schemaRuntime || deriveSchemaRuntime(readSchemaPack(root));
    this.catalogFactory = catalogFactory || (this.root
      ? ((commit) => new KnowledgeCatalog({ root: this.root, commit }))
      : null);
    if (!this.catalogFactory) throw new Error("A commit-bound catalog factory is required");
  }

  catalogAtCommit(commit, provided = null) {
    const catalog = provided || this.catalogFactory(commit);
    if (!catalog || typeof catalog.getPage !== "function" || typeof catalog.search !== "function") {
      throw Object.assign(new Error("A commit-bound knowledge catalog is required"), {
        code: "CATALOG_COMMIT_MISMATCH",
      });
    }
    if (catalog.commit !== commit || (this.root && path.resolve(catalog.root || "") !== this.root)) {
      throw Object.assign(new Error("Knowledge catalog is not bound to the requested commit"), {
        code: "CATALOG_COMMIT_MISMATCH",
      });
    }
    return catalog;
  }

  verifyCatalogPage(page, head) {
    if (this.pageVerifier) return this.pageVerifier(page, head);
    if (!page || typeof page.slug !== "string" || !page.slug.includes("/") || page.slug.startsWith("/")
      || /[\\\0]/.test(page.slug) || page.slug.split("/").some((part) => !part || part === "." || part === "..")) {
      throw Object.assign(new Error("Unsafe catalog page"), { code: "CATALOG_COMMIT_MISMATCH" });
    }
    const committed = execFileSync("git", ["show", `${head}:${page.slug}.md`], { cwd: this.root,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const digest = (text) => createHash("sha256").update(text).digest("hex");
    if (typeof page.markdown !== "string" || digest(committed) !== digest(page.markdown)) {
      throw Object.assign(new Error("Catalog metadata differs from committed retrieval snapshot"), { code: "CATALOG_COMMIT_MISMATCH" });
    }
    return page;
  }

  context(expectedCommit) {
    const head = this.getHead();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) || (expectedCommit && head !== expectedCommit)) {
      throw Object.assign(new Error("Requested retrieval commit is not current HEAD"), { code: "HEAD_MISMATCH" });
    }
    if (this.root) assertSchemaRuntimeAtCommit(this.root, head, this.schemaRuntime);
    const loaded = this.policyReader(head);
    const policy = validateRetrievalPolicy(loaded.policy);
    return { policy, policy_status: loaded.status, policy_reason: loaded.reason || null,
      configured: "native", effective: "native", expected_git_commit: head };
  }

  async backendStatus(head) {
    try {
      const status = await this.native.verifyCommit(head);
      if (!status.ok) return status;
      const identity = await this.native.observeModelIdentity();
      this.native.checkRuntimeIdentity(status.model_identity, identity);
      if (status.unembedded_chunks !== 0 || status.embedding_coverage_pct !== 100) {
        return { ...status, ok: false, status: "unavailable", reason: "VECTOR_COVERAGE_INCOMPLETE" };
      }
      return { ...status, ok: true, runtime_identity_current: "verified", runtime_model_identity: identity,
        query_vector_health: "not_probed" };
    } catch (error) {
      return { ok: false, reason: failure(error), status: "unavailable" };
    }
  }

  async status() {
    const context = this.context();
    const native = await this.backendStatus(context.expected_git_commit);
    return { ...context, served_by: null, index_git_commit: native.ok ? native.index_commit : null,
      fallback_chain: [], fallback_reason: null, deployment: { native_only: true }, backends: { native } };
  }

  async query({ query, limit = 20, scope = "result", expectedCommit, catalog: providedCatalog = null }) {
    if (typeof query !== "string" || !query.trim() || query.length > 6000
      || !Number.isInteger(limit) || limit < 1 || limit > 100 || !["result", "evidence", "all"].includes(scope)) {
      throw new Error("Invalid retrieval request");
    }
    const context = this.context(expectedCommit);
    const head = context.expected_git_commit;
    const catalog = this.catalogAtCommit(head, providedCatalog);
    const chain = [];
    const backends = { native: { status: "not_checked" } };
    const allowed = (hits) => {
      if (!Array.isArray(hits) || hits.some((hit) => !hit || typeof hit !== "object"
        || typeof hit.slug !== "string" || typeof hit.type !== "string")) {
        throw Object.assign(new Error("Backend returned malformed retrieval hits"), { code: "BACKEND_RESPONSE_INVALID" });
      }
      return hits.filter((hit) => {
        const page = catalog.getPage(hit.slug, { fuzzy: false });
        if (page) this.verifyCatalogPage(page, head);
        return page && this.schemaRuntime.typeForPath(page.slug) === page.type && page.type === hit.type
          && this.schemaRuntime.scopeAllows(page.type, scope);
      }).map((hit) => {
        const page = catalog.getPage(hit.slug, { fuzzy: false });
        return { ...hit, slug: page.slug, type: page.type,
          ...(page.title === undefined ? {} : { title: page.title }) };
      }).slice(0, limit);
    };
    const unavailable = (name, indexCommit, reason) => ({ ...context, hits: [], retrievalMode: "none",
      retrievalStatus: "unavailable", served_by: "none", index_git_commit: indexCommit,
      fallback_chain: [...chain, { backend: name, reason }], fallback_reason: reason, backends });
    const complete = (response, name, indexCommit) => {
      if (this.getHead() !== head) return unavailable(name, indexCommit, "HEAD_CHANGED");
      try {
        if (this.root) assertSchemaRuntimeAtCommit(this.root, head, this.schemaRuntime);
        const hits = allowed(response.hits);
        // Page verification can cross an async/process boundary in callers.
        // Recheck both HEAD and the committed schema after every hit has been
        // materialized, immediately before making the response observable.
        if (this.getHead() !== head) return unavailable(name, indexCommit, "HEAD_CHANGED");
        if (this.root) assertSchemaRuntimeAtCommit(this.root, head, this.schemaRuntime);
        if (this.getHead() !== head) return unavailable(name, indexCommit, "HEAD_CHANGED");
        return { ...response, ...context, hits, served_by: name,
          index_git_commit: indexCommit, fallback_chain: chain, fallback_reason: chain.at(-1)?.reason || null, backends };
      } catch (error) {
        if (error.code === "BACKEND_RESPONSE_INVALID") throw error;
        return unavailable(name, null, failure(error));
      }
    };
    try {
      const response = await this.native.query({ query, limit, scope, expectedCommit: head });
      backends.native = { status: response.retrievalStatus, arms: response.arms, index: response.index };
      if (response.retrievalStatus !== "ok" || response.arms?.vector?.status !== "ok"
        || response.arms?.lexical?.status !== "ok" || response.index?.git_commit !== head) {
        throw Object.assign(new Error("Native backend is not fully healthy"), {
          code: response.arms?.vector?.reason || response.arms?.lexical?.reason || "NATIVE_NOT_HEALTHY",
        });
      }
      return complete(response, "native", head);
    } catch (error) {
      const reason = failure(error); backends.native = { ...backends.native, ok: false, reason };
      chain.push({ backend: "native", reason });
    }
    try {
      const allowedTypes = this.schemaRuntime.allTypes
        .filter((type) => this.schemaRuntime.scopeAllows(type, scope));
      return complete({ hits: catalog.search(query, { limit: 100, types: allowedTypes }),
        retrievalMode: "local_markdown_keyword", retrievalStatus: "degraded",
        arms: { lexical: { status: "ok" }, vector: { status: "unavailable" } } }, "local_markdown_keyword", null);
    } catch (error) {
      chain.push({ backend: "local_markdown_keyword", reason: failure(error) });
      return complete({ hits: [], retrievalMode: "none", retrievalStatus: "unavailable" }, "none", null);
    }
  }

  async synchronize(expectedCommit, options = {}) {
    const context = this.context(expectedCommit);
    const head = context.expected_git_commit;
    const backends = { native: { status: "not_run" } };
    try {
      if (this.getHead() !== head) throw Object.assign(new Error("HEAD changed during synchronization"), { code: "HEAD_CHANGED" });
      const details = await this.native.synchronize(head, options);
      const verification = await this.backendStatus(head);
      if (!verification.ok || this.getHead() !== head) {
        throw Object.assign(new Error("Native synchronization failed verification"), { code: verification.reason || "HEAD_CHANGED" });
      }
      backends.native = { status: "synchronized", ...details, verification };
      return { ...details, ...context, served_by: "native", index_git_commit: head,
        fallback_chain: [], fallback_reason: null, backends,
        fallback_available: "local_markdown_keyword", fallback_git_commit: head,
        arms: { primary: { status: "ok", backend: "native" }, fallback: { status: "available", backend: "local_markdown_keyword" } } };
    } catch (error) {
      const reason = failure(error); backends.native = { status: "failed", reason };
      error.retrieval = { ...context, served_by: null, index_git_commit: null, backends,
        fallback_available: "local_markdown_keyword", fallback_git_commit: head,
        fallback_chain: [{ backend: "native", reason }], fallback_reason: reason };
      throw error;
    }
  }
}
