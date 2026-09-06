# Generic retrieval host adapter

Any retrieval engine can supply a candidate while Lab Trust Core remains the deterministic use-policy layer. Keep storage-specific fields outside the canonical record, map the retrieved item into `KnowledgeRecord`, then call `evaluateUse` before exposing it to an Agent.

```ts
import { evaluateUse, validateRecord } from "lab-trust-core";

const parsed = validateRecord(mapRetrievedItem(candidate));
if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));

const verdict = evaluateUse(parsed.record, {
  intended_use: "default_answer",
  risk_level: "ordinary"
});
```

This example intentionally defines no storage endpoint, private page name, credential, write operation, or approval flow. Filesystems, databases, and search services can all supply the same canonical JSON boundary.
