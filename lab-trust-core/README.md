<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner.svg">
    <img width="700" alt="Lab Trust Core" src="assets/banner.svg">
  </picture>
</p>

# Lab Trust Core

[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)
[![Last Updated](https://img.shields.io/badge/updated-Aug%202026-blue.svg?style=flat-square)]()

Portable, deterministic trust policy for AI-facing knowledge systems.

Lab Trust Core answers a narrow but important question: **may this knowledge be used for this purpose, at this risk level, within this scope?** It turns evidence maturity, provenance, claim type, intended use, and source-family independence into executable SDK, CLI, and read-only MCP verdicts.

It is not a truth oracle and emits no numeric “truth score.” A polished claim can still be wrong; this package only enforces the evidence boundaries you declare.

## Why this exists

Most knowledge bases store sources and conclusions but leave the final safety rule in prompts: one Agent respects `seed`, another silently treats it as fact. Lab Trust Core makes that rule portable and testable.

- A single creator repeated twenty times still counts as one source family.
- External Source pages may inspire ideas, experiments, questions, or copy, but cannot become default factual answers.
- Operational use requires corroboration; high-risk and public factual use require validation.
- Explicit prohibitions and scope mismatches always win over maturity.
- Every verdict returns stable reason codes, caveats, evidence gaps, and the effective policy version.

## What is included

- TypeScript SDK for validation, intended-use verdicts, and promotion checks
- Versioned default policy plus auditable custom-policy loading
- Canonical JSON Schema contracts
- Read-only Markdown/Obsidian adapter with Chinese Claim labels
- Read-only CLI: `validate`, `evaluate`, `promotion-check`, and `audit`
- Read-only MCP tools: `trust_validate`, `trust_evaluate`, and `trust_promotion_check`
- Synthetic JSON, Obsidian, and optional GBrain-host examples

## What is deliberately excluded

This package does **not** store, retrieve, rank, approve, edit, commit, index, or synchronize knowledge. It has no Git, database, vector-index, GBrain-write, or proposal-queue capability. Pair it with any storage or retrieval system and call it after retrieval, before an Agent uses the result.

## Quick start

```bash
git clone --filter=blob:none --no-checkout https://github.com/haorantang97/Personal-Ontology.git
cd Personal-Ontology
git sparse-checkout init --cone
git sparse-checkout set lab-trust-core
git checkout main
cd lab-trust-core
npm ci
npm run verify
```

SDK:

```ts
import { evaluateUse, validateRecord } from "lab-trust-core";

const parsed = validateRecord(candidate);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));

const verdict = evaluateUse(parsed.record, {
  intended_use: "operational_decision",
  risk_level: "ordinary",
  scope: ["ordinary internal workflow"]
});

if (verdict.decision === "deny") {
  console.error(verdict.reason_codes);
}
```

CLI:

```bash
npm run build
node dist/src/cli.js validate examples/obsidian/seed-rhetoric.md --json
node dist/src/cli.js evaluate examples/obsidian/seed-rhetoric.md \
  --use copywriting_inspiration --json
node dist/src/cli.js audit examples --json
```

MCP:

```bash
LAB_TRUST_ALLOWED_ROOTS=/absolute/path/to/knowledge \
  node dist/src/mcp/server.js
```

Payload-based MCP calls need no filesystem access. File-based calls are disabled unless their canonical path is inside `LAB_TRUST_ALLOWED_ROOTS`; symlink escapes are rejected.

## Default maturity policy

| Intended use | Minimum maturity | Source page allowed? |
| --- | --- | --- |
| Idea generation, copy inspiration, interview questions, experiment hypotheses | `seed` | Yes, with declared limits |
| Low-risk action, default answer, operational decision | `corroborated` | No |
| High-risk decision, public factual claim | `validated` | No |

The full matrix also checks claim type, attribution, explicit allow/disallow lists, scope, and evidence gaps. See [docs/model.md](docs/model.md).

## Source-family independence

`n > 1` is not enough. Reposts, clips, and repeated claims from the same upstream creator remain one source family. Promotion from `seed` to `corroborated` requires support from at least two genuinely independent families and no unresolved conflicting family. Promotion to `validated` additionally requires repeated testing or high-quality evidence within the declared scope.

## Storage adapters

Canonical JSON is the boundary. The included Markdown adapter reads trust metadata without modifying a note, strips Obsidian aliases and anchors from reference IDs, and refuses to guess missing maturity. Existing prose-first knowledge bases may need a gradual migration to the explicit contract; see [docs/migration.md](docs/migration.md). GBrain is optional and treated only as a possible retrieval host; see [docs/integration.md](docs/integration.md) and [examples/gbrain-host](examples/gbrain-host/README.md).

## Development

```bash
npm test
npm run typecheck
npm run build
npm run privacy-check
npm run verify
```

The release gate type-checks, runs all tests, rebuilds JSON Schemas, scans for private paths or credentials, and inspects the npm package manifest.

## 中文简介

这是一个可嵌入的“知识使用边界”引擎，而不是事实判定器。它把 `seed / corroborated / validated`、来源家族独立性、Claim 类型、适用范围和预期用途变成确定性的代码规则；可接在 Obsidian、向量库、GBrain 或任意检索系统之后，阻止低成熟度材料被 Agent 当作默认事实或高风险决策依据。

## License

[MIT](LICENSE)
