# Agent contribution rules

This repository is a read-only trust-policy core. Preserve that boundary.

- Add a failing test before every behavior change and run `npm run verify` before completion.
- Keep verdicts deterministic, versioned, and explainable with stable reason codes.
- Do not add numeric truth scores. Maturity is a bounded evidence state, not probability.
- Do not add storage, retrieval, vector search, approval, Git mutation, database, shell, or network tools to the core or MCP server.
- Do not silently weaken `knowledge-trust-default`; weaker variants require a distinct policy ID.
- Never commit real notes, Raw material, personal paths, credentials, databases, or private source excerpts. Examples must remain synthetic.
- Adapters may normalize explicit syntax but must not infer missing trust values.
