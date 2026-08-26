# Reason codes

## Use verdicts

| Code | Meaning |
| --- | --- |
| `EXPLICITLY_DISALLOWED` | The record or Claim explicitly prohibits the requested use. |
| `USE_NOT_DECLARED_ALLOWED` | A non-empty record or Claim whitelist omits the requested use. |
| `SCOPE_MISMATCH` | Requested scope does not intersect declared scope. |
| `SOURCE_NOT_DEFAULT_SURFACE` | A Source cannot directly serve this answer or decision surface. |
| `HIGH_RISK_REQUIRES_VALIDATED` | High-risk use requires `validated`. |
| `MATURITY_TOO_LOW` | Maturity is below the policy minimum. |
| `CLAIM_TYPE_NOT_ALLOWED` | Claim type is not permitted for this intended use. |
| `SEED_LIMITED_USE` | A seed is allowed only within its declared low-confidence boundary. |
| `ATTRIBUTION_REQUIRED` | Source attribution must remain visible. |
| `EVIDENCE_GAPS_PRESENT` | Known gaps must remain visible. |
| `POLICY_ALLOWED` | The active policy permits use within scope. |

## Promotion checks

| Code | Meaning |
| --- | --- |
| `INSUFFICIENT_INDEPENDENT_FAMILIES` | Fewer than two independent supporting families. |
| `MISSING_SOURCE_FAMILY` | Evidence cannot be counted without an upstream family. |
| `CONFLICTING_EVIDENCE` | At least one independent family contradicts the claim. |
| `VALIDATION_EVIDENCE_REQUIRED` | Repeated testing or high-quality evidence is missing. |
| `ALREADY_VALIDATED` | No higher maturity exists. |

## Input and policy errors

Stable codes include `SCHEMA_INVALID`, `DUPLICATE_CLAIM_ID`, `USE_CONFLICT`, `CLAIM_USE_CONFLICT`, `SOURCE_FAMILY_REQUIRED`, `PROVENANCE_REQUIRED`, `RESULT_EVIDENCE_REQUIRED`, `CONTEXT_INVALID`, `CLAIM_NOT_FOUND`, `POLICY_INVALID`, and `POLICY_WEAKENING_REQUIRES_DISTINCT_ID`.

The Markdown adapter additionally reports precise parsing codes such as `MISSING_MATURITY`, `MALFORMED_LIST`, `MISSING_CLAIM_FIELD`, `UNKNOWN_CLAIM_TYPE`, and `INVALID_EVIDENCE_REFERENCE`.
