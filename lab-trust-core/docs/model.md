# Trust model

## Canonical record

A `KnowledgeRecord` is either a `source` or a `result`.

- `source` preserves provenance and claim boundaries. It requires `provenance_class` and `source_family` and is limited to evidence or exploratory uses by the default policy.
- `result` is a synthesized concept, method, project state, decision, or synthesis. It requires at least one `evidence_ref` and can reach default-answer or decision surfaces when mature enough.

Every record declares maturity, evidence status, allowed and disallowed uses, scope, failure conditions, Claims, and evidence references. A non-empty `allowed_uses` list is a whitelist; an empty list defers to the active policy. Every Claim separately declares its type, direct evidence, sample size, interests, use boundaries, counterevidence, gaps, scope, failure conditions, and next verification.

## Maturity

- `seed`: a bounded candidate or first observation. It may support ideas, questions, copy inspiration, or experiments, but not default facts or operations.
- `corroborated`: supported by at least two independent source families with unresolved conflicts handled. It may support ordinary low-risk actions and operational decisions within scope.
- `validated`: supported by repeated testing or high-quality evidence within scope. It is required for high-risk decisions and public factual claims.

Maturity is not probability. The engine intentionally emits no percentage or truth score.

## Provenance

`provenance_class` is one of `first_party`, `external`, `system_observation`, or `mixed`. `source_family` names the upstream origin used for independence counting. Multiple documents, clips, posts, or quotations derived from the same upstream origin remain one family.

## Claim types

- `fact`
- `source_opinion`
- `agent_inference`
- `promotional_claim`
- `rhetoric_strategy`
- `unverified_hypothesis`

The default policy allows only `fact` Claims on default-answer, operational, high-risk, and public-fact surfaces. Other types remain useful for exploratory work when their attribution and gaps stay visible.

## Deterministic precedence

Use evaluation applies these gates in order:

1. Explicit disallow
2. Invalid or conflicting state
3. Source/default-surface restriction
4. High-risk requirement
5. Minimum maturity
6. Claim-type restriction
7. Explicit allow or policy default

A mature record cannot override an explicit prohibition or scope mismatch.

## Promotion

Promotion counts distinct supporting and contradicting source families, not document count. `seed` requires two independent supporting families and no unresolved conflict to become `corroborated`. `corroborated` additionally requires `repeated_test` or `high_quality_evidence` to become `validated`.

See the checked-in contracts under [`schemas/`](../schemas/) for exact machine-readable fields.
