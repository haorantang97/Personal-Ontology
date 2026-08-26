# Migration from prose-first trust rules

Lab Trust Core deliberately refuses to infer missing trust metadata from prose. A legacy note may be valid in its original system and still fail the canonical adapter. Treat that as a migration signal, not permission to guess.

## Recommended sequence

1. Run `knowledge-trust audit` against a copy or read-only mount.
2. Add `maturity` without converting missing values to `validated`.
3. For Source pages, identify the true upstream `source_family` and `provenance_class`.
4. Separate descriptive source-use prose from the portable intended-use taxonomy.
5. Split each candidate Claim into statement, exact Claim type, evidence, sample size, interests, counterevidence, gaps, scope, failure conditions, and next verification.
6. Convert display links into stable reference IDs while preserving the original source outside the trust engine.
7. Re-run validation and compare behavior before enabling answer or action gates.

## Do not bulk-promote

- Missing maturity is unknown, never validated.
- Several documents from one upstream origin remain one source family.
- Repetition by one creator is not corroboration.
- A strong title, persuasive example, or vector score does not establish evidence quality.
- Migration changes representation, not truth status.

## Compatibility strategy

Keep the legacy adapter and the canonical engine separate during migration. The legacy adapter should emit explicit issues and a candidate mapping; only canonical records that pass `validateRecord` should reach `evaluateUse`. This prevents an adapter convenience from silently weakening the policy.
