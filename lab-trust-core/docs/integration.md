# Integration guide

## Recommended position

Place Lab Trust Core after retrieval and before answer or action generation:

```text
query → retrieve candidates → map to KnowledgeRecord → evaluateUse
      → allow / allow_with_limits / deny → Agent answer or action
```

The retrieval engine can be a filesystem, Obsidian, SQL database, vector database, search service, or GBrain. It stays responsible for recall; this package is responsible only for declared use boundaries.

## SDK

Use `validateRecord` at the adapter boundary, `evaluateUse` for a particular purpose, and `evaluatePromotion` only when new evidence arrives.

```ts
import {
  evaluatePromotion,
  evaluateUse,
  validateRecord
} from "lab-trust-core";

const parsed = validateRecord(retrievedCandidate);
if (!parsed.ok) return { decision: "deny", issues: parsed.issues };

return evaluateUse(parsed.record, {
  intended_use: "default_answer",
  risk_level: "ordinary"
});
```

Do not discard `required_caveats`, `evidence_gaps`, or `required_attribution` when rendering an `allow_with_limits` result.

## Markdown and Obsidian

`parseKnowledgeMarkdown(markdown, { path })` reads YAML frontmatter plus `## Claims` / `### C-…` sections. Supported page types are `source`, `project`, `decision`, `methodology`, `method`, `synthesis`, and `concept`.

Chinese Claim labels map exactly:

| Markdown label | Canonical value |
| --- | --- |
| 事实 | `fact` |
| 来源观点 | `source_opinion` |
| Agent 推断 | `agent_inference` |
| 宣传主张 | `promotional_claim` |
| 话术策略 | `rhetoric_strategy` |
| 待验证假设 | `unverified_hypothesis` |

The adapter never edits input and never guesses missing trust fields. A missing `maturity` returns `MISSING_MATURITY`. Obsidian aliases and heading fragments are stripped from IDs; their display text is not treated as evidence.

## CLI

```bash
knowledge-trust validate page.md --json
knowledge-trust evaluate page.md --use default_answer --json
knowledge-trust promotion-check page.md --evidence observations.json --json
knowledge-trust audit ./knowledge --json
```

Exit codes are `0` for success or permitted use, `1` for invocation/runtime errors, and `2` when execution succeeds but finds validation or policy failures.

## MCP

The stdio server exposes three read-only tools:

- `trust_validate`
- `trust_evaluate`
- `trust_promotion_check`

Each accepts a canonical `record` payload. A `file` may be used instead only when its canonical path is inside `LAB_TRUST_ALLOWED_ROOTS`, whose entries are separated by the platform path delimiter.

Generic client configuration after a local build:

```json
{
  "mcpServers": {
    "knowledge-trust": {
      "command": "node",
      "args": ["/absolute/path/to/lab-trust-core/dist/src/mcp/server.js"],
      "env": {
        "LAB_TRUST_ALLOWED_ROOTS": "/absolute/path/to/knowledge"
      }
    }
  }
}
```

Omit the environment variable when only payload calls are needed.

## Custom policy

Pass a custom policy to `evaluateUse` through the SDK. A stricter policy may reuse its own identity. A policy that weakens the default requirements must use a distinct ID; silent weakening under `knowledge-trust-default` is rejected.
