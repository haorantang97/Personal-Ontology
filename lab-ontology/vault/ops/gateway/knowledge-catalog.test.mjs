import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveSchemaRuntime, readSchemaPack } from "./schema-pack.mjs";
import {
  KnowledgeCatalog,
  parseKnowledgeMarkdown,
  splitKnowledgeBody,
} from "./knowledge-catalog.mjs";
import { buildTrustInputBinding, routeKnowledgeCandidates } from "./knowledge-router.mjs";
import { routeCandidateFromHit, summarizeSearchHit } from "./retrieval-views.mjs";
import { CANONICAL_PACK_PATH, SCHEMA_API_VERSION } from "./schema-pack.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "knowledge-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["projects", "decisions", "methods", "syntheses", "concepts", "sources", ".raw", "ops/agent-knowledge-schema", "ops/gateway"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), readFileSync(new URL("../agent-knowledge-schema/pack.json", import.meta.url)));
  writeFileSync(path.join(root, "ops/gateway/package.json"), '{"version":"1.8.0"}\n');
  writeFileSync(path.join(root, "methods/alpha.md"), `---
type: methodology
title: "Alpha 方法"
aliases: ["Alpha", "第一方法"]
tags: [test, method]
updated: 2030-01-05
reviewed: "2030-01-06"
domain: testing
modules: [catalog]
maturity: corroborated
agent_priority: normal
evidence: ["[[sources/source-one]]"]
---
# Alpha 方法

> 复用 [[methods/other|既有方法]]，并参考 [外部链接](https://example.com)。

正文。\n`);
  writeFileSync(path.join(root, "sources/source-one.md"), `---
type: source
title: Source One
tags: [source]
updated: 2030-01-04
derived_pages: ["[[methods/alpha]]"]
---
# Source One\n`);
  writeFileSync(path.join(root, ".raw/secret.md"), "# 不应进入目录\n");
  writeFileSync(path.join(root, "README.md"), "# 也不应进入目录\n");
  writeFileSync(path.join(root, "index.md"), "# 旧目录内容也不应成为输入\n");
  return { root, catalog: new KnowledgeCatalog({ root }) };
}

function commitFixture(root) {
  const run = (args) => execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  run(["init"]);
  run(["config", "user.email", "catalog-test@example.invalid"]);
  run(["config", "user.name", "Catalog Test"]);
  run(["add", "."]);
  run(["commit", "-m", "fixture"]);
  return run(["rev-parse", "HEAD"]);
}

// Callback integration, not live MCP E2E: execute the actual server helpers and
// registered callbacks without starting the gateway or touching shared state.
// Only external retrieval/TrustCore observation and response transport are fakes.
function committedReadHandlers(t, {
  observeTrust = async () => ({ mode: "test" }),
  prepareFixture = () => {},
} = {}) {
  const { root } = fixture(t);
  for (const relative of ["sources/disguised.md", ".raw/disguised.md"]) {
    writeFileSync(path.join(root, relative), "---\ntype: methodology\ntitle: Disguised\n---\nPRIVATE EVIDENCE\n");
  }
  writeFileSync(path.join(root, "ops/SCHEMA.md"), "APPROVED SCHEMA CONTRACT\n");
  writeFileSync(path.join(root, "ops/AGENTS.md"), "APPROVED AGENT RULES\n");
  prepareFixture(root);
  const commit = commitFixture(root);
  const git = (args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  // Deliberately poison the startup/worktree scope. A callback using its old
  // global scopeAllows instead of the committed runtime must fail these tests.
  const dirtyPack = readSchemaPack(root);
  dirtyPack.page_types.find((entry) => entry.name === "source").retrieval_scope = "result";
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), JSON.stringify(dirtyPack));
  const startupRuntime = deriveSchemaRuntime(dirtyPack);
  writeFileSync(path.join(root, "methods/alpha.md"), "---\ntype: methodology\ntitle: DIRTY\n---\nUNAPPROVED BODY\n");
  writeFileSync(path.join(root, "ops/SCHEMA.md"), "UNAPPROVED SCHEMA CONTRACT\n");
  writeFileSync(path.join(root, "ops/AGENTS.md"), "UNAPPROVED AGENT RULES\n");

  const serverSource = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const helpersStart = serverSource.indexOf("function committedCatalogAtHead(");
  const helpersEnd = serverSource.indexOf("function safeRelativeTarget(", helpersStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, "committed helper extraction boundary changed");
  const helpers = new Function("ROOT", "run", "KnowledgeCatalog", "deriveSchemaRuntime",
    `${serverSource.slice(helpersStart, helpersEnd)}\nreturn { committedCatalogAtHead, assertCommittedReadStable, committedContractText };`,
  )(root, (command, args) => {
    assert.equal(command, "git");
    return git(args).trim();
  }, KnowledgeCatalog, deriveSchemaRuntime);
  const proposalRoot = path.join(root, "isolated-state", "proposals");
  const lockPath = path.join(root, "isolated-state", "locks", "proposal-apply.lock");
  const bindings = {
    ...helpers,
    ROOT: root,
    SOURCE_ID: "isolated-callback-test",
    GATEWAY_RUNTIME_VERSION: "1.8.0",
    navigationIndexState: {},
    SCHEMA_PATH: path.join(root, "ops/SCHEMA.md"),
    AGENT_RULES_PATH: path.join(root, "ops/AGENTS.md"),
    PROPOSAL_ROOT: proposalRoot,
    LOCK_PATH: lockPath,
    path,
    readFileSync,
    schemaRuntime: startupRuntime,
    RESULT_TYPES: new Set(startupRuntime.resultTypes),
    knowledgeCatalog: new KnowledgeCatalog({ root }),
    scopeAllows: (type, scope) => startupRuntime.scopeAllows(type, scope),
    buildTrustInputBinding,
    observeKnowledgeTrustShadow: (input) => observeTrust(input, { root, git, commit }),
    randomBytes,
    routeCandidateFromHit,
    summarizeSearchHit,
    routeKnowledgeCandidates,
    result: (data, isError = false) => ({ data, isError }),
    errorResult: (error) => ({ data: { ok: false, error: error.message }, isError: true }),
    retrievalCoordinator: {
      context: (expectedCommit) => {
        assert.equal(expectedCommit, commit);
        return { effective: "native", configured: "native", policy: { mirror_native: false } };
      },
      query: async ({ query, expectedCommit, catalog, limit }) => {
        assert.equal(expectedCommit, commit);
        assert.equal(catalog.commit, commit);
        return {
          hits: catalog.search(query, { limit }),
          retrievalMode: "local_markdown_keyword",
          retrievalStatus: "degraded",
          expected_git_commit: commit,
          configured: "native",
          effective: "native",
          served_by: "local_markdown_keyword",
          fallback_chain: [{ backend: "native", reason: "OFFLINE" }],
          fallback_reason: "OFFLINE",
          arms: {
            lexical: { status: "ok" },
            vector: { status: "unavailable", reason: "OFFLINE" },
          },
        };
      },
      verifyCatalogPage: (page, expectedCommit) => {
        assert.equal(expectedCommit, commit);
        assert.equal(page?.source_commit, commit);
        return page;
      },
      status: async () => ({ expected_git_commit: commit }),
    },
  };
  const handler = (name) => {
    const registration = serverSource.indexOf(`server.registerTool(\n  "${name}",`);
    assert.ok(registration >= 0, `missing registration: ${name}`);
    const start = serverSource.indexOf("  async ", registration) + 2;
    const end = serverSource.indexOf("\n  },\n);", start) + 4;
    assert.ok(start > registration && end > start, `callback extraction boundary changed: ${name}`);
    if (["knowledge_get", "knowledge_list"].includes(name)) {
      assert.match(serverSource.slice(registration, start), /scope: z\.enum\(\["result", "evidence", "all"\]\)\.default\("result"\)/);
    }
    return new Function(...Object.keys(bindings), `return (${serverSource.slice(start, end)});`)(...Object.values(bindings));
  };
  return { root, commit, git, handler, proposalRoot, lockRoot: path.dirname(lockPath) };
}

test("server committed callbacks block Source and disguised paths under default result scope", async (t) => {
  let observations = 0;
  const { handler, commit } = committedReadHandlers(t, {
    observeTrust: async () => { observations++; return {}; },
  });
  for (const slug of ["sources/source-one", "sources/disguised", ".raw/disguised"]) {
    const response = await handler("knowledge_get")({ slug, scope: "result", fuzzy: false });
    assert.equal(response.isError, true, slug);
    assert.equal(response.data.ok, false, slug);
    assert.equal(response.data.source_commit, commit);
    assert.equal(response.data.page, undefined);
  }
  assert.equal(observations, 0, "scope/path rejection must precede TrustCore observation");
  const listed = await handler("knowledge_list")({ scope: "result", limit: 100 });
  assert.equal(listed.data.ok, true);
  assert.equal(listed.data.source_commit, commit);
  assert.deepEqual(listed.data.pages.map((page) => page.slug), ["methods/alpha"]);
  const typed = await handler("knowledge_list")({ scope: "result", type: "source", limit: 100 });
  assert.equal(typed.data.ok, false, "typed preflight must also use committed scope");
});

test("knowledge_list filters scope before applying its limit", async (t) => {
  const { handler } = committedReadHandlers(t, {
    prepareFixture: (root) => {
      for (let index = 0; index < 205; index++) {
        const suffix = String(index).padStart(3, "0");
        writeFileSync(path.join(root, `sources/newer-${suffix}.md`), `---
type: source
title: Newer Source ${suffix}
updated: 2030-02-01
---
# Newer Source ${suffix}
`);
      }
    },
  });
  const response = await handler("knowledge_list")({ scope: "result", limit: 1 });
  assert.equal(response.data.ok, true);
  assert.deepEqual(response.data.pages.map((page) => page.slug), ["methods/alpha"]);
});

test("knowledge_list also protects evidence pages from newer result pages", async (t) => {
  const { handler } = committedReadHandlers(t, {
    prepareFixture: (root) => {
      for (let index = 0; index < 205; index++) {
        const suffix = String(index).padStart(3, "0");
        writeFileSync(path.join(root, `methods/newer-${suffix}.md`), `---
type: methodology
title: Newer Method ${suffix}
updated: 2030-02-01
---
# Newer Method ${suffix}
`);
      }
    },
  });
  const response = await handler("knowledge_list")({ scope: "evidence", limit: 1 });
  assert.equal(response.data.ok, true);
  assert.deepEqual(response.data.pages.map((page) => page.slug), ["sources/source-one"]);
});

test("catalog treats an explicit empty type scope as empty", (t) => {
  const { catalog } = fixture(t);
  assert.deepEqual(catalog.listPages({ types: [], limit: 100 }), []);
});

test("server TrustCore observes the same committed Markdown used for the returned page", async (t) => {
  let observed;
  const { handler, git, commit } = committedReadHandlers(t, {
    observeTrust: async (input) => { observed = input; return { mode: "test" }; },
  });
  const response = await handler("knowledge_get")({ slug: "methods/alpha", scope: "result", fuzzy: false });
  assert.equal(response.data.ok, true);
  const markdown = git(["show", `${commit}:methods/alpha.md`]);
  assert.equal(observed.markdown, markdown);
  assert.equal(observed.path, "methods/alpha.md");
  assert.equal(response.data.page.content, parseKnowledgeMarkdown(markdown).content);
  assert.equal(response.data.page.title, "Alpha 方法");
  assert.deepEqual(response.data.trust_shadow.input_binding, buildTrustInputBinding({
    source: { path: observed.path, markdown },
    returnedContent: response.data.page.content,
    updatedAt: response.data.page.updated_at,
  }));
});

test("server schema and intake contracts match Git rather than dirty worktree bytes", async (t) => {
  const { handler, git, commit, proposalRoot, lockRoot } = committedReadHandlers(t);
  for (const name of ["knowledge_schema", "knowledge_intake"]) {
    const response = await handler(name)({ user_request: "test intake" });
    assert.equal(response.data.ok, true, response.data.error);
    assert.equal(response.data.source_commit, commit);
    assert.equal(response.data.schema_contract, git(["show", `${commit}:ops/SCHEMA.md`]));
    assert.equal(response.data.agent_rules, git(["show", `${commit}:ops/AGENTS.md`]));
    if (name === "knowledge_schema") {
      assert.equal(response.data.result_types.includes("source"), false);
      assert.deepEqual(response.data.evidence_types, ["source"]);
      assert.equal(
        response.data.gateway_runtime.catalog_source,
        "committed Git objects at one immutable HEAD",
      );
      assert.equal(
        response.data.gateway_runtime.direct_read_binding,
        "knowledge_get/list/related/schema fail closed if HEAD changes during a response",
      );
      assert.equal(response.data.gateway_runtime.proposal_state_root, proposalRoot);
      assert.equal(response.data.gateway_runtime.lock_root, lockRoot);
      assert.equal(response.data.gateway_runtime.catalog_reads_from_vault, undefined);
    }
  }
});

test("server committed get fails closed when real HEAD changes during TrustCore await", async (t) => {
  const { handler, git, commit } = committedReadHandlers(t, {
    observeTrust: async (_input, context) => {
      await new Promise((resolve) => setImmediate(resolve));
      context.git(["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "concurrent approved commit"]);
      return { mode: "test" };
    },
  });
  const response = await handler("knowledge_get")({ slug: "methods/alpha", scope: "result", fuzzy: false });
  assert.notEqual(git(["rev-parse", "HEAD"]).trim(), commit);
  assert.equal(response.isError, true);
  assert.equal(response.data.ok, false);
  assert.match(response.data.error, /HEAD changed during the committed read/);
  assert.equal(response.data.page, undefined);
});

test("server search, module rerank, route candidates and universe share one committed catalog", async (t) => {
  const { root, handler, commit } = committedReadHandlers(t);
  rmSync(path.join(root, "methods/alpha.md"));
  writeFileSync(path.join(root, "methods/untracked.md"), `---
type: methodology
title: UNTRACKED ROUTE SENTINEL
aliases: []
tags: [untracked]
modules: [catalog]
retrieval_scope: result
---
# UNTRACKED ROUTE SENTINEL
`);

  const search = await handler("knowledge_search")({
    query: "Alpha 方法",
    scope: "result",
    module: "catalog",
    limit: 5,
  });
  assert.equal(search.isError, false, search.data.error);
  assert.equal(search.data.retrieval.expected_git_commit, commit);
  assert.deepEqual(search.data.results.map(({ slug, title }) => [slug, title]), [
    ["methods/alpha", "Alpha 方法"],
  ]);
  assert.equal(search.data.results[0].module_match, true);
  assert.deepEqual((await handler("knowledge_search")({
    query: "UNTRACKED ROUTE SENTINEL",
    scope: "result",
    limit: 5,
  })).data.results, []);

  const routed = await handler("knowledge_route")({
    query: "请使用 Alpha 方法",
    context: "",
    module: "catalog",
    limit: 5,
  });
  assert.equal(routed.data.action, "read");
  assert(routed.data.selected.some((page) => page.slug === "methods/alpha"));
  const untracked = await handler("knowledge_route")({
    query: "UNTRACKED ROUTE SENTINEL",
    context: "",
    module: "catalog",
    limit: 5,
  });
  assert.equal(untracked.data.action, "none");
  assert.deepEqual(untracked.data.selected, []);
});

test("frontmatter parser preserves inline arrays and body", () => {
  const parsed = parseKnowledgeMarkdown("---\ntitle: Test\ntags: [one, \"two\"]\nactive: true\n---\n# Body\n");
  assert.equal(parsed.frontmatter.title, "Test");
  assert.deepEqual(parsed.frontmatter.tags, ["one", "two"]);
  assert.equal(parsed.frontmatter.active, true);
  assert.equal(parsed.content, "# Body");
  assert.equal(parsed.timeline, "");
});

test("body parser preserves the provider-compatible timeline string contract", () => {
  assert.deepEqual(splitKnowledgeBody("# Body\n\n---\n\nParagraph"), {
    compiled_truth: "# Body\n\n---\n\nParagraph",
    timeline: "",
  });
  assert.deepEqual(splitKnowledgeBody("# Body\n\n<!-- timeline -->\n## Timeline\n- Event"), {
    compiled_truth: "# Body\n",
    timeline: "## Timeline\n- Event",
  });
  assert.deepEqual(splitKnowledgeBody("# Body\n\n---\n\n## History\n- Event"), {
    compiled_truth: "# Body\n",
    timeline: "\n## History\n- Event",
  });
});

test("catalog reads exact and unique fuzzy pages directly from Markdown", (t) => {
  const { catalog } = fixture(t);
  const exact = catalog.getPage("methods/alpha", { fuzzy: false });
  assert.equal(exact.title, "Alpha 方法");
  assert.equal(
    exact.compiled_truth,
    "# Alpha 方法\n\n> 复用 [[methods/other|既有方法]]，并参考 [外部链接](https://example.com)。\n\n正文。",
  );
  assert.deepEqual(exact.tags, ["method", "test"]);
  assert.equal(exact.frontmatter.updated, "2030-01-05T00:00:00.000Z");
  assert.equal(exact.frontmatter.reviewed, "2030-01-06");
  assert.equal(exact.timeline, "");
  assert.match(exact.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(catalog.getPage("Alpha 方法").slug, "methods/alpha");
  assert.equal(catalog.getPage("Alpha 方").slug, "methods/alpha");
  assert.equal(catalog.getPage("alpha").slug, "methods/alpha");
  assert.equal(catalog.getPage("第一方法"), null);
});

test("fuzzy page resolution fails closed when more than one title or slug matches", (t) => {
  const { root, catalog } = fixture(t);
  writeFileSync(path.join(root, "methods/shared-one.md"), `---
type: methodology
title: Shared title
---
# One
`);
  writeFileSync(path.join(root, "concepts/shared-two.md"), `---
type: concept
title: Shared title
---
# Two
`);

  assert.equal(catalog.getPage("Shared title"), null);
  assert.equal(catalog.getPage("shared"), null);
  assert.equal(catalog.getPage("methods/shared-one", { fuzzy: false }).title, "Shared title");
});

test("committed catalog ignores worktree drift and enforces canonical path types", (t) => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, "sources/disguised.md"), `---
type: methodology
title: Disguised Source
---
# Disguised Source
`);
  writeFileSync(path.join(root, ".raw/disguised.md"), `---
type: methodology
title: Disguised Raw
---
# Disguised Raw
`);
  writeFileSync(path.join(root, "ops/SCHEMA.md"), "APPROVED SCHEMA CONTRACT\n");
  writeFileSync(path.join(root, "ops/AGENTS.md"), "APPROVED AGENT RULES\n");
  const commit = commitFixture(root);

  writeFileSync(path.join(root, "methods/alpha.md"), `---
type: methodology
title: UNAPPROVED WORKTREE TITLE
---
# Dirty
`);
  writeFileSync(path.join(root, "methods/untracked.md"), `---
type: methodology
title: Untracked
---
# Untracked
`);
  writeFileSync(path.join(root, CANONICAL_PACK_PATH), "not committed schema bytes\n");
  writeFileSync(path.join(root, "ops/SCHEMA.md"), "UNAPPROVED SCHEMA CONTRACT\n");
  writeFileSync(path.join(root, "ops/AGENTS.md"), "UNAPPROVED AGENT RULES\n");

  const catalog = new KnowledgeCatalog({ root, commit });
  assert.equal(catalog.getPage("methods/alpha", { fuzzy: false }).title, "Alpha 方法");
  assert.equal(catalog.getPage("UNAPPROVED WORKTREE TITLE"), null);
  assert.equal(catalog.getPage("methods/untracked", { fuzzy: false }), null);
  assert.equal(catalog.getPage("sources/disguised", { fuzzy: false }), null);
  assert.equal(catalog.getPage(".raw/disguised", { fuzzy: false }), null);
  assert.deepEqual(catalog.allPages().map((page) => page.slug).sort(), [
    "methods/alpha",
    "sources/source-one",
  ]);
  assert.equal(catalog.canonicalPack().api_version, SCHEMA_API_VERSION);
  assert.equal(catalog.source("ops/SCHEMA").markdown, "APPROVED SCHEMA CONTRACT\n");
  assert.equal(catalog.source("ops/AGENTS").markdown, "APPROVED AGENT RULES\n");
  assert.equal(deriveSchemaRuntime(catalog.canonicalPack()).scopeAllows("source", "result"), false);
  assert.equal(catalog.activePack().api_version, SCHEMA_API_VERSION);
  assert.equal(catalog.getPage("methods/alpha", { fuzzy: false }).source_commit, commit);
});

test("committed catalog requires an exact immutable revision", (t) => {
  const { root } = fixture(t);
  const commit = commitFixture(root);
  assert.throws(() => new KnowledgeCatalog({ root, commit: commit.slice(0, 12) }), /full immutable Git commit/);
  assert.throws(() => new KnowledgeCatalog({ root, commit: "f".repeat(40) }));
});

test("list preserves the minimal public shape and sorts by timestamp rather than frontmatter date", (t) => {
  const { root, catalog } = fixture(t);
  const older = new Date("2030-01-01T00:00:00.000Z");
  const newer = new Date("2030-01-02T00:00:00.000Z");
  utimesSync(path.join(root, "methods/alpha.md"), older, older);
  utimesSync(path.join(root, "sources/source-one.md"), newer, newer);

  const pages = catalog.listPages({ sort: "updated_desc" });
  assert.equal(pages[0].slug, "sources/source-one");
  assert.equal(pages[0].updated_at, newer.toISOString());
  assert.deepEqual(Object.keys(pages[0]).sort(), ["slug", "title", "type", "updated_at"]);
  assert.equal("frontmatter" in pages[0], false);
  assert.equal("tags" in pages[0], false);
});

test("catalog lists pages and derives typed links from local schema rules", (t) => {
  const { catalog } = fixture(t);
  assert.deepEqual(catalog.listPages({ type: "source" }).map((page) => page.slug), ["sources/source-one"]);
  const methodLinks = catalog.relationships("methods/alpha");
  assert.deepEqual(methodLinks.outgoing.map((edge) => [edge.to_slug, edge.link_type]), [
    ["sources/source-one", "derived_from"],
  ]);
  assert.deepEqual(methodLinks.incoming.map((edge) => [edge.from_slug, edge.link_type]), [
    ["sources/source-one", "supports"],
  ]);
  assert.equal(catalog.activePack().name, "agent-decision-memory");
  assert.equal(catalog.activePack().pack_name, "agent-decision-memory");
  assert.equal(catalog.activePack().api_version, SCHEMA_API_VERSION);
  assert.equal(catalog.activePack().canonical_path, CANONICAL_PACK_PATH);
});

test("local keyword recall ranks exact metadata, searches bodies, and excludes non-formal files", (t) => {
  const { catalog } = fixture(t);
  const exact = catalog.search("第一方法", { limit: 5 });
  assert.equal(exact[0].slug, "methods/alpha");
  assert.equal(exact[0].evidence, "keyword_exact");
  assert.equal(exact[0].score, 1);

  const bodyOnly = catalog.search("既有方法", { limit: 5 });
  assert.equal(bodyOnly[0].slug, "methods/alpha");
  assert.equal(bodyOnly[0].evidence, "local_body_keyword");
  assert.deepEqual(catalog.search("不应进入目录", { limit: 5 }), []);
});

test("local body recall cannot bypass the precision-first route gate", (t) => {
  const { catalog } = fixture(t);
  const route = (query) => {
    const candidates = catalog.search(query, { limit: 10 }).map((hit, index) => {
      const page = catalog.getPage(hit.slug, { fuzzy: false });
      return {
        slug: hit.slug,
        title: page.title,
        type: page.type,
        aliases: page.frontmatter.aliases || [],
        tags: page.tags,
        modules: page.frontmatter.modules || [],
        retrieval_evidence: hit.evidence,
        retrieval_rank: index + 1,
        base_score: hit.score,
      };
    });
    return routeKnowledgeCandidates({
      schemaRuntime: deriveSchemaRuntime(readSchemaPack(catalog.root)),
      query,
      candidates,
      retrievalStatus: "degraded",
      retrievalMode: "local_markdown_keyword",
    });
  };

  assert.equal(route("第一方法").action, "read");
  assert.equal(route("既有方法").action, "none");
});

test("navigation index is deterministic, bounded to formal pages, and graph-safe", (t) => {
  const { catalog } = fixture(t);
  const first = catalog.renderNavigationIndex({
    vaultName: "Test Vault",
    sourceCommit: "abc123",
  });
  const second = catalog.renderNavigationIndex({
    vaultName: "Test Vault",
    sourceCommit: "abc123",
  });

  assert.deepEqual(first, second);
  assert.equal(first.file, "index.md");
  assert.equal(first.page_count, 2);
  assert.deepEqual(first.counts, {
    project: 0,
    decision: 0,
    methodology: 1,
    synthesis: 0,
    concept: 0,
    source: 1,
  });
  assert.match(first.content, /obsidian:\/\/open\?vault=Test%20Vault&file=methods%2Falpha/);
  assert.match(first.content, /复用 既有方法，并参考 外部链接。/);
  assert.match(first.content, /`maturity:corroborated`/);
  assert.match(first.content, /`modules:catalog`/);
  assert.doesNotMatch(first.content, /secret|也不应进入目录|旧目录内容/);
  assert.doesNotMatch(first.content, /\[\[/);
  assert.doesNotMatch(first.content, /\]\([^)]*\.md(?:[)#?]|$)/);
  assert.ok(first.content.endsWith("\n"));
});

test("navigation writer uses the supplied snapshot and atomically replaces local drift", (t) => {
  const { catalog } = fixture(t);
  const destinationRoot = mkdtempSync(path.join(os.tmpdir(), "knowledge-navigation-live-"));
  t.after(() => rmSync(destinationRoot, { recursive: true, force: true }));
  mkdirSync(path.join(destinationRoot, "methods"), { recursive: true });
  writeFileSync(
    path.join(destinationRoot, "methods/alpha.md"),
    "---\ntype: methodology\ntitle: UNAPPROVED DIRTY TITLE\n---\n# Dirty\n",
  );

  const first = catalog.writeNavigationIndex({
    destinationRoot,
    vaultName: "Live Vault",
    sourceCommit: "committed123",
  });
  assert.equal(first.changed, true);
  const generated = readFileSync(path.join(destinationRoot, "index.md"), "utf8");
  assert.match(generated, /Alpha 方法/);
  assert.doesNotMatch(generated, /UNAPPROVED DIRTY TITLE/);

  const second = catalog.writeNavigationIndex({
    destinationRoot,
    vaultName: "Live Vault",
    sourceCommit: "committed123",
  });
  assert.equal(second.changed, false);

  writeFileSync(path.join(destinationRoot, "index.md"), "manual drift\n");
  const repaired = catalog.writeNavigationIndex({
    destinationRoot,
    vaultName: "Live Vault",
    sourceCommit: "committed123",
  });
  assert.equal(repaired.changed, true);
  assert.equal(readFileSync(path.join(destinationRoot, "index.md"), "utf8"), generated);
});
