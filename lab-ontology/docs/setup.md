# Setup / 安装与配置

This guide turns `lab-ontology/vault/` into an independent Git-backed Vault and exposes Agent Knowledge 1.8.0 to any MCP client.

本指南把 `lab-ontology/vault/` 骨架变成独立的 Git Vault，并把 Agent Knowledge 1.8.0 接入任意 MCP 客户端。

## 1. Requirements / 依赖

| Requirement | Required for | Notes |
|---|---|---|
| Node.js ≥ 20 | Gateway, validators and tests | `npm ci` installs the pinned MCP SDK, Trust Core release and Zod. |
| Git | Canonical reads and approved writes | The Vault itself must be a Git repository with at least one commit. |
| Obsidian | Human editing and graph view | Optional; Markdown and the gateway work without it. |
| Ollama-compatible embedding service | Full Native hybrid search and index rebuilds | Must expose compatible `/api/tags` and `/api/embed` endpoints. The reference local runtime is Ollama. |

The vector service is **not** needed to boot the server, inspect contracts, read an exact page, list pages, follow relations, or manage proposals. If Native retrieval is unavailable, search can fall back to deterministic keyword recall over the same committed Markdown and reports a degraded status. Full vector quality and a successful index rebuild do require a compatible embedding service.

中文要点：Node.js 与 Git 是必需依赖；Obsidian 可选。没有向量服务时仍可启动、读取和审批，但搜索会明确降级为同提交关键词回退。

## 2. Create an independent Vault / 创建独立 Vault

```bash
git clone https://github.com/haorantang97/Personal-Ontology.git
cp -R Personal-Ontology/lab-ontology/vault knowledge-vault
cd knowledge-vault
git init
git add -A
git commit -m "Initialize knowledge vault"
cd ops/gateway
npm ci
```

Do not run the gateway directly inside the catalog repository. The copied Vault must have its own `.git/` directory because every canonical read and approved write is bound to its Git history.

请保持这些目录名不变：`projects/`、`decisions/`、`methods/`、`syntheses/`、`concepts/`、`sources/`、`.raw/`。它们由 `ops/agent-knowledge-schema/pack.json` 定义并由校验器执行。

不要直接把公开目录当工作库运行。复制后的 Vault 必须单独 `git init` 并至少产生一次提交，之后的精确读取与审批写入才有可核验的 Git 基线。

## 3. Runtime state / 运行状态

The gateway keeps rebuildable and operational state outside the Vault:

```text
~/.agent-knowledge/
├── indexes/native/       # commit-bound index generations
├── locks/                # process and proposal-apply locks
└── proposals/
    ├── pending/
    ├── applied/
    └── rejected/
```

Set `AGENT_KNOWLEDGE_STATE_DIR` to an absolute path if the default is unsuitable. This directory is not a second source of truth: proposals and receipts are audit state; indexes can be rebuilt from Git.

Assign **every independent Vault** a dedicated absolute `AGENT_KNOWLEDGE_STATE_DIR`. Do not let two Vaults share the default `~/.agent-knowledge/`, because their pending/applied/rejected proposal queues and process locks would otherwise share one state tree.

每个独立 Vault 都必须分配独立的绝对状态目录。不要让多个 Vault 共用默认目录，否则它们会共用提案队列和进程锁；状态目录不是事实源，Markdown 与 Git 才是。

## 4. Connect an MCP client / 接入 MCP 客户端

Use an absolute path because many MCP hosts do not expand `~`. Registration syntax is host-specific.

所有路径都使用绝对路径。Codex、Claude Code 与 JSON 配置客户端的注册方式不同，不要混用。

### Codex

Use the official Codex CLI. The registration is written to `~/.codex/config.toml`:

```bash
codex mcp add agent-knowledge -- node /absolute/path/to/knowledge-vault/ops/gateway/server.mjs
```

Use the isolated form for an actual Vault:

```bash
codex mcp add \
  --env AGENT_KNOWLEDGE_STATE_DIR=/absolute/path/to/state/my-knowledge-vault \
  agent-knowledge \
  -- node /absolute/path/to/knowledge-vault/ops/gateway/server.mjs
```

Codex 不读取下面的 `mcpServers` JSON。注册完成后，重启或重新加载 MCP 服务，再检查 13 个 `knowledge_*` 工具是否可见。

### Claude Code

```bash
claude mcp add agent-knowledge \
  -e AGENT_KNOWLEDGE_STATE_DIR=/absolute/path/to/state/my-knowledge-vault \
  -- node /absolute/path/to/knowledge-vault/ops/gateway/server.mjs
```

Claude Code 使用自己的 CLI；可选的 host-side Skills 只提供触发提示，网关仍是 Schema 与审批流程的权威入口。

### Claude Desktop and other JSON-configured clients

The following is a generic stdio example for Claude Desktop and clients that explicitly support `mcpServers`. It is **not Codex configuration**:

```json
{
  "mcpServers": {
    "agent-knowledge": {
      "command": "node",
      "args": ["/absolute/path/to/knowledge-vault/ops/gateway/server.mjs"],
      "env": {
        "AGENT_KNOWLEDGE_STATE_DIR": "/absolute/path/to/state/my-knowledge-vault"
      }
    }
  }
}
```

Claude Desktop 可把该对象放入 `claude_desktop_config.json`；其他客户端请按各自文档放置同等的 command、args 与 env。网关实现不分叉，只有客户端注册格式不同。

## 5. Enable full Native embeddings / 启用完整 Native 向量检索

The bundled Native index client uses an Ollama-compatible HTTP contract. With the reference Ollama runtime:

```bash
ollama pull qwen3-embedding:0.6b
ollama serve
```

The 1.8.0 defaults are `http://127.0.0.1:11434`, model `qwen3-embedding:0.6b`, and 1024 dimensions. A replacement service must preserve the expected endpoint behavior, vector dimensions and stable model identity; changing the model requires a full index rebuild.

After the MCP server is connected, call:

```text
knowledge_repair_index({"force_full": true})
```

A successful response binds the published index generation to the current Git commit and verifies 100% corpus coverage. This operation changes only derived state; it does not edit or commit Markdown.

## 6. Verify the installation / 验证安装

Run deterministic checks first; they use synthetic fixtures and do not require a live embedding service:

```bash
cd /absolute/path/to/knowledge-vault/ops/gateway
npm ci
npm run test:unit
npm run validate:schema
cd ../..
node ops/validate-vault.mjs
```

Then connect an MCP client and verify that `listTools` returns exactly these 13 tools:

```text
knowledge_route
knowledge_search
knowledge_get
knowledge_list
knowledge_related
knowledge_intake
knowledge_schema
knowledge_propose_changes
knowledge_list_proposals
knowledge_get_proposal
knowledge_apply_proposal
knowledge_reject_proposal
knowledge_repair_index
```

`npm run test:smoke` creates and removes its own temporary Git Vault with synthetic pages. It deliberately leaves the Native generation unavailable and verifies the visible same-commit `local_markdown_keyword` fallback, scope isolation, Trust Core shadow and proposal gate without a live embedding service. Native vector/build/repair contracts are covered by unit tests with a synthetic embedding server. A real Ollama-compatible service is only an optional manual integration check and is not a CI prerequisite.

中文验收顺序：先跑单元测试、Schema 校验和 Vault 校验；再在实际 MCP 客户端确认工具数恰好为 13。测试通过不等于真实向量服务、客户端配置或个人语料已经完成端到端验证。

## 7. Daily operation / 日常使用

| Task | Command or tool |
|---|---|
| Read the current intake and schema contract | `knowledge_intake`, `knowledge_schema` |
| Search reusable knowledge | `knowledge_route`, then `knowledge_get` for every selected exact slug |
| Inspect provenance | `knowledge_search` with `scope: evidence` |
| Review pending proposals locally | `AGENT_KNOWLEDGE_STATE_DIR=/absolute/path/to/state/my-knowledge-vault node ops/gateway/proposal-digest.mjs` |
| Validate Markdown and links | `node ops/validate-vault.mjs` |
| Verify index coverage | `node ops/check-index-scope.mjs` |
| Rebuild a stale or failed derived index | `knowledge_repair_index({"force_full": true})` |

Every knowledge change follows one sequence: obtain the current intake contract, deduplicate, create an exact proposal, show it to the user, wait for explicit approval of that proposal, then apply it through `knowledge_apply_proposal`. Direct file edits by an Agent are outside the contract.

Shell maintenance commands do not inherit environment variables stored inside an MCP client's configuration. Pass the same `AGENT_KNOWLEDGE_STATE_DIR` explicitly when running `proposal-digest.mjs`; `knowledge_schema` reports the effective proposal and lock roots for verification.

审批规则：先读取当前契约和查重，再生成内容完整、目标明确的提案；只有用户明确批准该具体提案后才能应用。修正后的新提案必须重新批准，Agent 不得直接编辑正式知识文件。

终端维护命令不会自动继承 MCP 客户端配置里的环境变量。运行 `proposal-digest.mjs` 时要显式传入同一个 `AGENT_KNOWLEDGE_STATE_DIR`，并可用 `knowledge_schema` 返回的实际提案与锁目录核对是否一致。

## 8. Trust Core shadow / Trust Core 影子观测

`npm ci` installs the immutable `lab-trust-core` release pinned by the gateway lockfile. `knowledge_get` may return a `trust_shadow` object after the scope gate. In 1.8.0 this observation is deliberately non-enforcing: it does not block reads, change routing, promote claims, or approve writes. No separate Trust Core setup is required for the default shadow integration.

## 9. Privacy boundary / 隐私边界

The public repository contains only an empty Vault skeleton, system code, synthetic fixtures and documentation. Keep personal Markdown, Raw material, assets, proposal history and generated indexes in your copied Vault and runtime-state directory, not in the catalog repository.

公开仓库只包含空 Vault 骨架、系统代码、合成 fixture 与文档。个人 Markdown、Raw、资产、提案历史和索引都应留在你的独立 Vault 与运行状态目录中。

每个 Vault 的状态目录也应彼此隔离并排除在版本控制之外；分享仓库前，同时检查工作 Vault 与状态目录中是否包含个人路径、提案正文或索引产物。
