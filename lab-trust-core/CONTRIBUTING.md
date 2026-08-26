# Contributing

Contributions are welcome when they preserve the package's narrow trust boundary.

## Before opening a pull request

1. Add a failing test for every behavior change.
2. Keep verdicts deterministic and return stable reason codes.
3. Do not introduce numeric truth scores or silently weaken the default policy.
4. Do not add storage, retrieval, indexing, approval, Git, or write capabilities to the core or MCP server.
5. Use only synthetic examples; never commit personal notes, private paths, credentials, databases, or real source excerpts.
6. Run `npm run verify`.

Policy variants may be stricter. A variant that intentionally weakens a requirement must use a distinct policy ID so the change remains auditable.
