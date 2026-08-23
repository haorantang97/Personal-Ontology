# Setup / 安装与配置

This guide turns the `lab-ontology/vault/` skeleton into a working, agent-accessible knowledge base on one machine. Everything below is derived from what the scripts in `lab-ontology/vault/ops/` actually call.

本指南把 `lab-ontology/vault/` 骨架变成一台机器上可被 Agent 访问的知识库。以下内容均来自 `lab-ontology/vault/ops/` 脚本的实际调用。

## 1. Prerequisites / 依赖

| Requirement | Why | Notes |
|---|---|---|
| Node.js ≥ 20 | Gateway, validators, `node --test` | `npm ci` inside `vault/ops/gateway/` installs `@modelcontextprotocol/sdk` and `zod`. |
| Git | Source of truth; every approved write becomes a commit | The gateway commits only the exact approved targets; pre-existing *staged* changes block approval. |
| Obsidian | Editing and graph view | Open your copy of `vault/` as a vault. `.obsidian/` ships only app/graph settings; `workspace.json` is git-ignored. |
| [GBrain](https://github.com/garrytan/gbrain) ≥ 0.42.0 | Derived search index, vectors, typed graph | The schema pack declares `gbrain_min_version: 0.42.0`. The gateway shells out to the CLI (`status`, `sync`, `call`, `schema validate/lint`). |
| [Ollama](https://ollama.com) | Local embeddings for GBrain | `~/.gbrain/config.json` must set `embedding_model` to `ollama:<model>`; `knowledge_repair_index` will try to start Ollama on macOS if it is down. |

Without GBrain the server still starts, `knowledge_intake` returns the contract, and proposals can be created and listed — but `knowledge_search`, `knowledge_route`, `knowledge_schema`, `knowledge_apply_proposal` and `knowledge_repair_index` return an error until the `gbrain` binary is reachable.

没有 GBrain 时网关仍能启动，`knowledge_intake` 能返回契约，提案也能创建和列出；但 `knowledge_search`、`knowledge_route`、`knowledge_schema`、`knowledge_apply_proposal` 与 `knowledge_repair_index` 会报错，直到 `gbrain` 可用。

## 2. Environment variables / 环境变量

| Variable | Default | Used by |
|---|---|---|
| `GBRAIN_BIN` | `~/.bun/bin/gbrain` | Path to the GBrain CLI. Set it whenever GBrain is installed elsewhere. |
| `GBRAIN_SOURCE_ID` | `knowledge` | GBrain source id that the vault is registered as. |
| `OLLAMA_API_URL` | `http://127.0.0.1:11434` | Embedding service health check. |
| `GBRAIN_IMPORT_SOURCE` | `~/node_modules/gbrain/src/commands/import.ts` | `ensure-gbrain-sync-filter.mjs` inspects the installed import walker here. |

Paths that are **not** configurable: the shared approval inbox at `~/.gbrain/change-proposals/{pending,applied,rejected}`, the gateway lock at `~/.gbrain/gateway-db.lock`, and GBrain's own `~/.gbrain/config.json`.

## 3. Create the vault / 初始化 Vault

```bash
git clone https://github.com/haorantang97/Personal-Ontology.git
cp -R Personal-Ontology/lab-ontology/vault ~/knowledge-base   # any path without surprises
cd ~/knowledge-base
git init && git add -A && git commit -m "Initialize knowledge base"
cd ops/gateway && npm ci && npm run test:router
```

The vault must be its **own Git repository** — the gateway resolves the repository root as `ops/gateway/../..` and runs `git` there. Keep the directory names (`projects/`, `decisions/`, `methods/`, `syntheses/`, `concepts/`, `sources/`, `.raw/`) exactly as shipped; they are hard-coded in the validator, the gateway and the schema pack.

Vault 必须是**独立的 Git 仓库**：网关以 `ops/gateway/../..` 作为仓库根目录运行 `git`。目录名（`projects/`、`decisions/`、`methods/`、`syntheses/`、`concepts/`、`sources/`、`.raw/`）在校验器、网关和 schema pack 中写死，请保持原样。

## 4. Register GBrain + schema pack / 注册 GBrain 与 schema pack

1. Install GBrain and initialise a local brain (`gbrain init --pglite` for a single-machine setup; see GBrain's README for other engines).
2. Make `~/.gbrain/config.json` use an Ollama embedding model, e.g. `"embedding_model": "ollama:nomic-embed-text"`, and `ollama pull` that model.
3. Register the vault as a source with id `knowledge` (or set `GBRAIN_SOURCE_ID`).
4. Install the schema pack so that `gbrain schema validate agent-decision-memory` and `gbrain schema lint agent-decision-memory` succeed. The pack source of truth is `ops/gbrain-schema/pack.json`; GBrain keeps installed packs under `~/.gbrain/schema-packs/`.
5. Run the upgrade checks once:

```bash
node ops/ensure-gbrain-sync-filter.mjs   # fails closed if the installed import walker could index governance/raw Markdown
node ops/check-index-scope.mjs           # verifies only the six content directories are in the index
node ops/validate-vault.mjs              # frontmatter, links, evidence consistency
```

`ensure-gbrain-sync-filter.mjs --apply` patches the installed GBrain import walker; review the installed version before applying.

## 5. Connect an agent / 接入 Agent

Any MCP client can register the gateway as a stdio server (use absolute paths — MCP hosts do not expand `~`):

```json
{
  "mcpServers": {
    "agent-knowledge": {
      "command": "node",
      "args": ["/absolute/path/to/your-vault/ops/gateway/server.mjs"],
      "env": {
        "GBRAIN_BIN": "/absolute/path/to/.bun/bin/gbrain",
        "GBRAIN_SOURCE_ID": "knowledge"
      }
    }
  }
}
```

- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Claude Code: `claude mcp add agent-knowledge -e GBRAIN_BIN=... -- node /absolute/path/to/your-vault/ops/gateway/server.mjs`
- Codex / Hermes: their respective MCP server configuration, same `command` / `args` / `env`.

Then install `lab-knowledge-intake` and `lab-knowledge-retrospective` from `skills/` (see their READMEs). The skills only *trigger* `knowledge_intake`; the MCP response is the contract.

## 6. Daily operations / 日常操作

| Task | Command / tool |
|---|---|
| Review the approval inbox locally | `node ops/gateway/proposal-digest.mjs` |
| Validate the vault | `node ops/validate-vault.mjs` |
| Rebuild graph edges from frontmatter links | `node ops/sync-graph.mjs` |
| Index out of date after an approved write | call `knowledge_repair_index` (do not run `gbrain` by hand from an agent) |
| Full end-to-end check | `cd ops/gateway && npm run test:smoke` — requires GBrain + Ollama and a populated vault; the shipped cases reference the original vault's page slugs, so adapt `cases` in `smoke-test.mjs` to your own pages. |

Never run unattended `gbrain dream` or `gbrain autopilot` against this source; the rules in `ops/AGENTS.md` forbid unattended mutation.

## 7. Where private data lives / 私人数据放在哪里

Your vault (Markdown, `.raw/`, `assets/`) lives **outside** this repository — in `~/knowledge-base` or wherever you copied it. This repository only tracks the system; keep it that way when you contribute changes back.

你的 Vault（Markdown、`.raw/`、`assets/`）在本仓库**之外**。本仓库只跟踪系统；回传修改时请保持这一边界。
