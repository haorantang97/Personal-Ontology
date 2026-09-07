# Agent Knowledge Gateway

The gateway is the only supported read/write interface for this Markdown/Git
knowledge repository. Markdown committed to Git is the source of truth. Search
indexes, navigation pages, and relationship views are derived and rebuildable.

## Runtime architecture

1. `KnowledgeCatalog` reads canonical pages from one immutable Git `HEAD`.
2. `LocalHybridIndex` builds a Native keyword/vector generation outside the
   repository under `~/.agent-knowledge/indexes/native/<repository-id>/`.
3. `RetrievalCoordinator` serves only the Native backend selected by committed
   `retrieval-policy.json` v2.
4. If Native query health is incomplete, reads visibly degrade to committed
   Markdown keyword search. They never claim vector retrieval succeeded.
5. Writes remain proposal-gated. After a successful Git commit, Native sync is
   mandatory; failure is returned as a repairable index failure.

No provider-specific CLI, schema projection, database, config file, or runtime
directory is required. Relationship queries are parsed from committed Markdown
links and validated by the repository validator.

## Native generation contract

Each atomic generation contains:

- the exact immutable Git commit;
- canonical Schema and retrieval fingerprints;
- page path, page type, Git blob identity, and Markdown digest;
- chunk text/input digests and normalized vectors;
- the SHA-256 digest of the complete committed knowledge-page tree;
- an observed embedding-model digest before and after the build;
- 100% embedding coverage and zero unembedded chunks.

`verifyCommit(commit)` recomputes the canonical page set from `git ls-tree` and
compares its ordered paths, types, blobs, count, and tree digest with the active
generation. A manifest that is internally consistent but omits or adds a page is
therefore rejected as `INDEX_SCOPE_MISMATCH`. A different commit is rejected as
`INDEX_STALE`.

Publication uses a staged generation directory plus one atomic `current.json`
pointer. A failed build cannot replace the last complete generation. Explicit
`force_full` repair ignores every previous vector and can recover corrupt state.

## Schema

`ops/agent-knowledge-schema/pack.json` is the only machine Schema source.
`schema-pack.mjs` validates its shape, version, paths, types, scopes, relations,
frontmatter mapping, and package/runtime identity. Catalog, index, validator, and
MCP schema output all derive from that canonical pack and fail closed when it is
missing or invalid.

Run:

```sh
node ../validate-schema-pack.mjs
node ../validate-vault.mjs
```

## Read tools

- `knowledge_route`: precision-first decision about whether durable context is
  relevant.
- `knowledge_search`: Native hybrid recall with result/evidence scope controls.
- `knowledge_get`, `knowledge_list`, `knowledge_related`: committed Markdown
  reads; they do not depend on the derived index.
- `knowledge_schema`: current schema, runtime, index, and navigation identity.
- `knowledge_intake`: current routing, dedupe, proposal, and approval contract.

Raw content is never indexed. Source pages appear only in evidence scope unless
the caller explicitly asks for all canonical pages.

## Write and repair flow

1. `knowledge_intake`
2. result/evidence dedupe searches
3. `knowledge_propose_changes` with complete target bytes; the gateway builds an
   isolated exact candidate tree and runs Vault/schema/gateway preflight before
   writing a pending proposal
4. exact user approval
5. `knowledge_apply_proposal`
6. repeated stale-content and candidate validation, Git commit, Native sync,
   exact corpus verification, and deterministic navigation-index refresh

If proposal preflight fails, no pending proposal is created. The tool returns
`error_code: PROPOSAL_PREFLIGHT_FAILED` and `stage: proposal_preflight` together
with the validator output. This prevents a user from approving bytes that can
only fail later during apply.

The frontmatter validator accepts both YAML flow lists and ordinary block lists.
`project_status` carries project lifecycle independently of the record-level
`status`; `agent_priority` is independent of evidence `maturity`.

Lab Trust Core remains non-enforcing. Legacy pages missing only the newer trust
contract are surfaced as `legacy_migration_warning` / `legacy_unmigrated` with
`blocking: false`, not as a write-validator failure.

If step 6 commits Markdown but index publication fails, call
`knowledge_repair_index`. Repair never edits Markdown or Git and needs no new
content approval.

## Runtime state

All mutable product state is under `~/.agent-knowledge/` (or the explicit
`AGENT_KNOWLEDGE_STATE_DIR` assigned to this Vault):

```text
~/.agent-knowledge/
├── indexes/native/<repository-id>/
├── locks/proposal-apply.lock
└── proposals/{pending,applied,rejected}/
```

The repository contains no runtime database or index generation.

Commands launched from a terminal do not inherit an MCP client's stored
environment. Pass the same `AGENT_KNOWLEDGE_STATE_DIR` explicitly to
`proposal-digest.mjs` and other state-aware maintenance commands.

## Tests

From this directory:

```sh
npm run test:unit
npm run validate:schema
npm run test:smoke
```

`native-index.test.mjs` covers snapshot isolation, Chinese query terms, scope
separation, atomic publication, model identity, configuration drift, exact
corpus binding, corruption recovery, and full repair. Coordinator tests cover
Native-only policy, committed-catalog binding, degraded Markdown fallback, HEAD
changes, and synchronization failure. Smoke tests exercise the live MCP surface.

`node ../check-index-scope.mjs` verifies the production Native generation against
the current committed corpus without changing the repository.

## Upgrade safety

Install this directory as one versioned unit. Do not mix a server, retrieval
policy, canonical pack, or tests from different releases. Before replacing an
existing installation, preserve its Git commit and local runtime-state backup;
then install dependencies, run the unit/schema/Vault checks, restart the MCP
process, and perform a full index repair.

Rollback means restoring the complete previous release and restarting its MCP
process. Native generations are derived data: after either an upgrade or a
rollback, rebuild them against the restored Git `HEAD` instead of copying a
generation between releases.
