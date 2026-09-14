# Feature-to-Implementation Matrix

Status date: 2026-08-22
Release status: **v2 verified implementation release for synthetic/public fixtures; field truth separated by capability**

This is the authoritative scope audit. A reference page or interface does not count as implementation.

- **I** — executable implementation exists;
- **T** — automated synthetic/public-fixture test exists and passes;
- **F** — field evidence for this exact capability. `aggregate` means authorized
  aggregate evidence from the source task, not execution of private data by this
  public tree;
- **B** — exact external, authorization, legal, or field-evidence blocker.

`F=no` never means `I=yes` is field-compatible. Unknown source schemas fail closed.

## A. Product, privacy, and clean-room boundary

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Standalone Skill, deterministic scripts, references, tests; no GUI | yes | yes | n/a | — |
| Provider/model-neutral packets; user’s current model | yes | yes | no | Content quality across model families needs later shadow runs |
| Exact approval gates for source, key, unredacted send, and KB write | yes | yes | n/a | — |
| Raw DB, keys, paths, contacts, and identity alias map remain local | yes | yes | no | Real-device privacy observation pending |
| Deterministic identity pseudonyms before release | yes | yes | no | Exact-name matching cannot replace contextual human review |
| Public package contains only synthetic data | yes | yes | n/a | Publication scan must be rerun on the final archive |
| Noncommercial license (PolyForm Noncommercial 1.0.0, repository-wide) | yes | n/a | n/a | Standard license text; connector legal boundary still needs qualified review |
| Clean-room design, fixtures, source-overlap checks, notices | yes | yes | n/a | Independent behavioral-agent audit unavailable in this run |

## B. macOS / Windows WeChat 4.x local connection

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| macOS standard-root and explicit-root account discovery | yes | yes | no | Directory variants need real installations |
| Windows standard-root and explicit-root account discovery | yes | yes | no | Registry/redirected Documents variants need real installations |
| Private source registry with opaque public account/database refs | yes | yes | no | — |
| Multi-database role inventory | yes | yes | no | Unknown roles are retained as unknown, never guessed |
| Plain SQLite backup including committed WAL state | yes | yes | no | — |
| Stable encrypted DB/WAL/SHM bundle with race retry | yes | yes | no | — |
| Plain/encrypted-candidate/corrupt recognition | yes | yes | no | Encryption recognition is conservative, not a proprietary-format guarantee |
| User-authorized private key-file provider | yes | yes | no | User must lawfully obtain and stage the key |
| Process-memory key extraction, injection, re-signing, native key derivation | intentionally no | n/a | no | Legal/terms blocker; excluded pending counsel/platform authorization |
| Standard SQLCipher 4 export via stdin; no key in args/receipt | yes | yes | no | Actual WeChat parameters may differ by build |
| Mixed snapshot decryption, integrity check, atomic receipt | yes | yes | no | Requires separately installed SQLCipher and a user-supplied key |
| Schema fingerprint, drift diagnostics, unknown-schema failure | yes | yes | no | — |
| Versioned macOS observed-shape profile | yes | yes | no | Fixture/public-evidence profile; exact build coverage unverified |
| Versioned Windows camel-case observed-shape profile | yes | yes | no | Fixture/public-evidence profile; exact build coverage unverified |
| Per-table incremental watermark bound to schema fingerprint | yes | yes | no | — |
| Checkpoint advances only after matching sealed release | yes | yes | no | — |

## C. Native source mapping

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Direct and group message tables to unified records | yes | yes | no | Exact schema aliases need real builds |
| Group sender-prefix and group-member attribution | yes | yes | no | — |
| Per-row self/other resolution | yes | yes | no | Self identity is supplied through a mode-0600 local file |
| Text, quote/reply, forwarded bundle, image, voice, attachment parsing | yes | yes | no | Unsupported message types stay evidence-visible, not fabricated |
| Contact, group, and group-member directories | yes | yes | no | Remain in private mapping only |
| Media/voice/attachment index and availability | yes | yes | no | No media decoding or transcription is claimed |
| Media expected/available/missing denominator | yes | yes | no | — |
| Favorites and Moments observed-shape mapping into unified records | yes | yes | no | Build availability and schema need field evidence |
| Optional DB present/unmapped/not-present report with table evidence | yes | yes | no | — |
| Exact source-row fingerprint coverage; identical content preserved | yes | yes | no | — |
| Stable within-shard order plus explicit cross-shard uncertainty | yes | yes | no | — |

## D. Local transformation and immutable release

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Stable record IDs, locators, fingerprints | yes | yes | no | — |
| Authored/quoted/forwarded boundaries | yes | yes | no | — |
| Verbatim/parsed-structure/metadata evidence precision | yes | yes | no | Summary precision is produced only by later model stages |
| Local identifier/secret redaction and contact-alias pseudonyms | yes | yes | no | Semantic identity mentions still require QA/human review |
| Atomic immutable release, file hashes, seal, tamper detection | yes | yes | no | — |
| Frozen source fingerprint set and explicit gap list | yes | yes | no | — |
| Failed staging cleanup | yes | yes | no | — |

## E. Map → Merge → Final → QA

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Whole-record packet splitting | yes | yes | no | — |
| Oversize deterministic compaction with parent fingerprint/lineage | yes | yes | no | — |
| Machine-generated per-stage output contract and local no-data probe | yes | yes | no | Provider-specific remote transport must be exercised by the current agent |
| Single data binding, privacy-key, non-empty, and byte preflight | yes | yes | no | — |
| Map packet/result chain with every input used or reasoned-excluded | yes | yes | no | — |
| Evidence recall and disposition coverage receipts | yes | yes | no | — |
| Merge component IDs and exact input accounting | yes | yes | no | Semantic grouping is model work; local binding is deterministic |
| Unresolved conflict and missing-evidence freeze | yes | yes | no | Human may resolve or accept a bounded limitation |
| Frozen Final candidate set | yes | yes | no | — |
| Final confidence and limitations gate | yes | yes | no | — |
| Distinct QA report and seven mandatory checks | yes | yes | no | Threshold suitability needs real corpus calibration |
| Precision and recall counted separately | yes | yes | no | — |
| Negative-pattern, counterexample, cost, time-evolution, gap, conflict fields | yes | yes | no | Empty lists mean explicitly assessed, not silently omitted |
| Canary halt after systemic structure/content rejection | yes | yes | no | Threshold is configurable and needs field tuning |
| Complete Map retained when compact derivatives are created | yes | yes | no | — |

## F. Validation, repair, recovery, and concurrency

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Local authoritative evidence/schema/quality validator | yes | yes | no | — |
| Deterministic evidence/quality-list cleanup with before/after hashes | yes | yes | no | Semantic changes always route to human |
| Infrastructure/structure/content/privacy/dependency taxonomy | yes | yes | no | — |
| Produced → validated → committed separation | yes | yes | no | — |
| `accepted` terminal and never reclaimed | yes | yes | no | — |
| Append-only hash-chained ledger and lease reclaim | yes | yes | no | One controller is the supported writer contract |
| Orphan/unknown-transport output recovery after binding and hash checks | yes | yes | no | — |
| Partial private WeChat ingestion recovery and source-receipt release gate | yes | yes | no | — |
| Dependency gate and failure isolation | yes | yes | no | — |
| Completion-driven slot refill | yes | yes | no | Current agent performs actual model dispatch |
| Infrastructure-signal backoff and validator-backlog gate | yes | yes | no | Field thresholds pending |
| Persistent controller observations and precise live/expired counts | yes | yes | no | — |
| Explicit task-owned PID sampling and time-window resource trend | yes | yes | no | Threshold interpretation needs real workloads |
| Immutable run scope, migration watermark, and drain observations | yes | yes | no | — |
| Streaming packet/materialization paths | yes | yes | no | Large real-corpus performance pending |

## G. Human and knowledge-base boundary

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Needs-human state and sealed adjudication receipt | yes | yes | no | — |
| Human replacement is revalidated against the exact stage contract | yes | yes | no | — |
| Knowledge-base proposal and seal | yes | yes | no | — |
| Separate explicit KB approval receipt | yes | yes | no | — |
| External KB write | intentionally no | n/a | no | Requires a later explicit action and the user’s chosen connector |

## H. Domain routing and complete life ledger

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Immutable machine bundle pins enums, route-result/event-item/place schemas, acceptance gates, and delta routes by file hash | yes | yes | n/a | Any semantic change requires a new contract version |
| Frozen domain packet with exact route denominator and closed output contract | yes | yes | aggregate: travel | Other domains need source-task delta runs |
| Exactly one processing result per route; `reviewed` rejected | yes | yes | aggregate: legacy travel disposition coverage 1696/1696 | Private travel results require lossless migration to the corrected route-result contract |
| A route emits 0..N independent events; event status is authoritative and multiplicity is preserved | yes | yes | no | Real multi-event routes need source-task delta validation |
| Explicit no-signal, out-of-domain, and insufficient-evidence processing outcomes; third-party remains an event status | yes | yes | aggregate: travel | Distribution/threshold calibration remains corpus-specific |
| Per-route evidence and place allowlists block cross-route injection; empty place allowlist forces empty event places | yes | yes | no | Requires later private-run confirmation without exposing IDs |
| Observed message time and asserted event time remain separate with precision | yes | yes | aggregate: travel | Relative-date semantic accuracy still needs corpus review |
| Per-domain complete/partial/not_extracted/ambiguous receipt | yes | yes | aggregate: travel | Education/work/relationship/residence/family/health/finance/creation not field-run |
| Independent domain ledgers merge without erasing unextracted domains | yes | yes | no | Needs full multi-domain source-task delta run |
| Complete event ledger retained; importance produces only a biography view | yes | yes | aggregate: travel | Cross-domain biography display needs later field QA |

## I. Place taxonomy and travel views

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| country/city/subregion/landmark/other/ambiguous closed taxonomy | yes | yes | aggregate: 311/311 | Public code did not process the private corpus |
| alias/typo/slang/abbreviation/contained-in candidates remain evidence-visible | yes | yes | aggregate: 226 candidates | Candidate recall varies by corpus |
| Only one exact deterministic safe mapping auto-applies; ambiguity never guessed | yes | yes | aggregate: 269 classified, 42 ambiguous | Ambiguous items require later evidence/human input |
| Visited-country view contains countries only; cities/landmarks remain in ledger | yes | yes | aggregate: travel | Full audience timeline review pending |

## J. Runtime retrieval and portable package

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| biography/voice/advisor/mixed modes with fixed permission separation | yes | yes | no | Real user task evaluation pending |
| Minimal relevant modules plus optional relationship/time-evolution loading | yes | yes | no | Context-budget tuning pending |
| Structured domain/status/subject/place/year filters | yes | yes | no | Real query-set evaluation pending |
| Chinese character/bigram and English lexical retrieval | yes | yes | no | Segmentation/recall tuning on real corpus pending |
| Optional caller-provided hybrid scores without vendor/vector dependency | yes | yes | no | External scorer quality remains caller responsibility |
| No arbitrary top-N fallback; explicit unknown and coverage gap | yes | yes | no | — |
| Event, full evidence, and trusted-card layers separately searchable | yes | yes | no | — |
| Every response declares relevant domain extraction status | yes | yes | no | — |
| Portable sealed package with events/evidence/cards/modules/boundaries and redacted eval cases | yes | yes | no | Real private package stays local and needs user evaluation |
| External-CWD domain → package → runtime forward path | yes | yes | n/a | — |

## K. Self, voice, advice, fidelity, and cards

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| observation/pattern/hypothesis/advice are separate contract layers | yes | yes | no | Semantic extraction quality needs real review |
| Counterexamples, time evolution, domain scope, and unresolved tensions retained | yes | yes | no | — |
| Advice requires benefit/cost/trigger/reversibility/uncertainty | yes | yes | no | — |
| Scenario voice includes distance, temperature, purpose, length, humor, profanity, correction, rhythm | yes | yes | no | Real voice corpus and blind reviewers required |
| Private exact examples rejected from portable assets; opaque local refs allowed | yes | yes | no | Real vault privacy observation pending |
| Voice drafts only; auto-send, impersonation, commitments, indistinguishability forbidden | yes | yes | no | — |
| Cross-domain/holdout/non-generic fidelity states independent from content QA | yes | yes | no | Holdout and real blind review are `not_run/required` |
| Only behavior-changing ready items enter calibration queue | yes | yes | no | Calibration UX needs source-task trial |
| High-confidence cards are indexes; all lower-confidence assets/evidence retained | yes | yes | no | KB promotion still requires exact proposal and approval |

## L. Profile evolution and new recovery rules

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Append-only incremental update snapshots | yes | yes | no | Real long-running profile trial pending |
| Correction replaces one stable ID in a new version | yes | yes | no | — |
| Source withdrawal deactivates dependencies without erasing old evidence | yes | yes | no | Legal erasure obligations need lawyer/product review |
| Domain re-extraction replaces only that domain and records superseded IDs | yes | yes | no | Source-task delta run pending |
| Rollback creates a new version; prior versions remain read-only | yes | yes | no | — |
| Snapshot/event hash chains, contiguous versions, one latest base | yes | yes | no | Filesystem permissions vary by platform |
| Explicit failure-event parser ignores error-like words in normal output | yes | yes | no | Provider adapters must emit the structured event |
| Output-directory writable preflight | yes | yes | no | Provider-specific dispatch integration pending |
| Accepted model output remains accepted when optional sidecar fails | yes | yes | no | Actual time-sidecar integration remains caller-specific |
| Identical single-writer artifact replay is idempotent; divergent write blocked | yes | yes | no | Cross-host locking is intentionally not implemented |
| Repeated infrastructure failures cause cooldown and fallback recommendation | yes | yes | no | Thresholds require field tuning |
| Compact cloud grouping can reconstruct exact component narratives locally | yes | yes | no | Real oversize grouping quality needs field QA |
| Unicode oversize splitting proves exact character reconstruction | yes | yes | no | Real transport byte ceilings vary |
| Structural repair receipt proves narrative fields unchanged | yes | yes | no | — |

## M. Field evidence and clean-room provenance

| Capability | I | T | F | B / remaining boundary |
|---|---:|---:|---:|---|
| Aggregate travel/place field receipt validates denominators and safety flags | yes | yes | aggregate | Does not contain or reprocess private content |
| v105 event ledger aggregate: 1696/1696, ready, no error codes | n/a | yes | aggregate | Exact private labels/receipts excluded |
| v106 place aggregate: 311/311; 269 classified; 42 ambiguous; 226 candidates; 14/14 tests | n/a | yes | aggregate | Exact private labels/receipts excluded |
| v106 authority unchanged; KB/cloud writes false | n/a | yes | aggregate | — |
| External method adoption/rejection and observed-license record | yes | yes | n/a | Persona-Skill unlicensed and PersonalOS GPL remain idea-only |
| New source-thread audit range 816–881 reconciled privately; public only aggregated | yes | yes | n/a | Self-audit; independent behavioral reviewer unavailable |

## Conclusion

Commit `debb09b` was only the generic baseline and v1 is now immutable history.
The v2 tree implements and tests each capability listed `I=yes/T=yes`; rows with
`F=no` remain synthetic/public-fixture evidence only. `F=aggregate` is a narrower
claim about source-task method evidence and never a claim that this public tree
ran private data. No WeChat 4.x build, non-travel domain, runtime fidelity result,
or blind voice result is field-validated. Native key extraction, external KB
write, and new legal authority remain explicit blockers rather than hidden gaps.
