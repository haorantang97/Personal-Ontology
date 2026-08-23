# Universal Agent Access

Any MCP-compatible Agent can use the same knowledge interface:

```json
{
  "command": "/usr/local/bin/node",
  "args": ["<vault>/ops/gateway/server.mjs"]
}
```

## Intent routing

When the user says `录入知识库`, `导入知识库`, `保存到知识库`, or asks for
any knowledge change, the Agent must call `knowledge_intake` first. That tool
returns the canonical Obsidian vault path, the current schema and Agent rules,
the page-routing table, and the complete proposal/approval/sync workflow.

The MCP is the source of truth for this contract. Host-specific skills or
instructions may trigger `knowledge_intake`, but must not duplicate the schema.
This keeps Claude, Codex, Hermes, and other MCP clients on the same format.

## Read behavior

- Use `knowledge_route` as the shared precision-first preflight when a caller
  needs to decide whether the current request should load personal knowledge.
  It returns `read`, `review`, or `none` with explainable metadata signals.
- `read` means the caller should fetch the selected full pages with
  `knowledge_get` before answering. `review` exposes weak candidates but does
  not authorize treating them as facts. `none` means no candidate crossed the
  current threshold; if retrieval status is `unavailable`, it does not prove
  that the vault has no relevant page.
- Vector similarity and module match affect candidate ordering but never trigger
  an automatic read by themselves. Result pages remain the default surface;
  Source and Raw pages are excluded from routing.
- Use `knowledge_search`, `knowledge_get`, `knowledge_list`, and `knowledge_related`.
- Result pages are the default retrieval scope.
- Evidence pages require an explicit evidence scope.
- `knowledge_search` accepts an optional module hint. Retrieval stays global;
  matching module pages receive a ranking boost instead of becoming a hard filter.
- Raw materials are never exposed through the normal knowledge interface.

`knowledge_route` centralizes the decision logic but cannot force a host Agent
to call it. A mandatory preflight belongs in the Agent runtime (for example,
Hermes). A dashboard may configure and display redacted routing status, but it
must not duplicate the routing algorithm or become the formal conversation
runtime. Codex, Claude, and other MCP clients can soft-adopt the same tool through
their host instructions while sharing one gateway implementation.

The route tool does not persist the query, optional context, candidates, or its
ephemeral trace identifier. It is read-only and never creates proposals, edits
Markdown, commits Git, or changes GBrain content.

## Write behavior

- Agents submit proposed changes with `knowledge_propose_changes`.
- Proposed changes do not alter the vault.
- Conversation-origin proposals are presented once, near the end of the current task.
- Background-origin proposals use `origin: background` and remain in the shared approval inbox.
- A dedicated knowledge-review task reads `knowledge_list_proposals`, then uses `knowledge_get_proposal` to present the exact scope.
- `knowledge_apply_proposal` requires explicit approval fields and stores the user's approval message.
- `knowledge_reject_proposal` requires explicit rejection fields, archives the proposal, and never changes knowledge.
- Each proposal records the touched files' content baseline. Approval stops if another Agent changed any target after the proposal was created.
- Unrelated unstaged or untracked work no longer blocks approval. Validation and
  indexing run from a clean temporary worktree, while Git stages and commits only
  the exact approved targets.
- An existing untracked Markdown page can be adopted with an exact `update`
  proposal. Accidental root `.base` and `.canvas` files can be deleted only by an
  exact hash-pinned `delete` proposal.
- Any pre-existing staged changes still block approval because Git cannot safely
  infer who staged them.
- Only a conversation-approved proposal can be validated, committed, indexed, and linked.

## Index repair

GBrain is the derived search/index layer; Obsidian Markdown and Git remain the
source of truth. If an approved write commits successfully but indexing fails,
the Agent must call `knowledge_repair_index`. The tool starts the configured
local Ollama service when needed, retries failed imports, verifies that GBrain
reached the current Git commit, checks page coverage, and only then rebuilds
graph links.

Index repair never changes Markdown or Git, so it does not require a knowledge
content proposal. Agents must use this tool instead of asking the user to run
terminal commands.

## Approval inbox

The shared queue is stored outside the vault at `~/.gbrain/change-proposals/`.
It is the cross-Agent source of truth; a Codex review task is only one display
surface. Any MCP-compatible Agent can list, inspect, approve, or reject the same
pending records through the gateway.

For a local digest:

```sh
node "<vault>/ops/gateway/proposal-digest.mjs"
```

Normal work tasks must not expand background proposals inline. They may report a
pending count at the end. The dedicated review task batches full proposal
reviews and stays silent when the queue is empty.

The schema contract is in `../SCHEMA.md`; shared Agent rules are in `../AGENTS.md`.

## Upgrade checks

After upgrading GBrain, run:

```sh
node ops/ensure-gbrain-sync-filter.mjs
node ops/check-index-scope.mjs
cd ops/gateway && npm test
```

The first check fails closed if the installed GBrain full-import walker could index governance or raw Markdown. Review the installed version before using `--apply`.

`npm run test:smoke` reads its search cases from `ops/gateway/smoke-cases.json`
(`[query, expectedSlug]` pairs) or from the file named by `SMOKE_CASES`.
