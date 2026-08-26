# Optional GBrain host adapter

GBrain can host retrieval, while Lab Trust Core remains the deterministic use-policy layer. Keep storage-specific fields outside the canonical record, map the retrieved page into `KnowledgeRecord`, then call `evaluateUse` before exposing it to an Agent.

```ts
import { evaluateUse, validateRecord } from "lab-trust-core";

const canonical = mapSyntheticSearchResultToKnowledgeRecord(searchResult);
const parsed = validateRecord(canonical);
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));

const verdict = evaluateUse(parsed.record, {
  intended_use: "default_answer",
  risk_level: "ordinary"
});
```

This example intentionally defines no storage endpoint, private page name, credential, write operation, or approval flow. GBrain is optional; any retrieval or storage engine can supply the canonical JSON record.
