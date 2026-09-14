# Aggregated Incident-to-Rule Coverage

This public audit contains no conversation text, identity, key, private path, receipt, or prior implementation. The original forty-five mechanically reconciled classes and twenty-nine later classes are reduced to product rules and public regression evidence.

| # | Aggregated failure class | Enforced rule/state | Public regression evidence |
|---:|---|---|---|
| 01 | Local key work leaked or destabilized the app | Exact key authorization; private file; stdin only; source unchanged; native extraction excluded | `test_wechat4_local.WeChat4CryptoTests` |
| 02 | Product collapsed into résumé facts or premature KB entries | Six-dimension quality fields; KB is a separately approved output | `test_stage_gates`; `test_pipeline` KB path |
| 03 | Sparse evidence produced broad personality claims | Every input disposed; counterexamples/costs/time/gaps mandatory; Final limitations | `test_stage_gates` |
| 04 | Fixed sender assumptions crossed rows/shards | Resolve sender/self per row and group prefix | `test_records`; `test_wechat4_mapping` |
| 05 | Quote, forward, file title, and sent content became authored speech | Separate authored/quoted/forwarded/media fields | `test_records`; `test_wechat4_mapping` |
| 06 | Redaction missed identities/secrets or called rewrites verbatim | Local alias pseudonyms; secret scan; evidence precision states | `test_records`; `test_wechat4_workflow`; `test_public_package` |
| 07 | Matching counts hid missing/duplicate rows | Locator/fingerprint multiset coverage; identical text retained; WAL snapshot | `test_records`; `test_wechat4_local` |
| 08 | Derived/staging files were duplicated or partial | Immutable authority; atomic staging and cleanup | `test_release`; crypto/snapshot failure tests |
| 09 | Missing media was silently treated as full evidence | Expected/available/missing media denominator | `test_wechat4_mapping.test_missing_media...` |
| 10 | Provider transport schema differed from local truth | Minimal per-stage contract; local probe; authoritative local validator | `test_stage_gates.TransportTests` |
| 11 | Map and QA optimized different notions of quality | Separate precision/recall; seven QA checks; canary | `test_stage_gates`; `test_controller_recovery` |
| 12 | Structural errors repeatedly consumed semantic model work | Deterministic whitelist repair before human routing | `test_planner_and_validation` |
| 13 | Repair upgraded weak source strength | Explicit downgrade-only repair primitive | `test_source_strength_repair_can_only_downgrade` |
| 14 | Infrastructure, structure, content, privacy, and dependency failures mixed | Five distinct categories and resumable states | `test_ledger`; taxonomy test |
| 15 | Resume/migration reran accepted work | Accepted terminal; immutable IDs; release-bound checkpoints | `test_ledger`; `test_wechat4_workflow` |
| 16 | Chat lifetime was mistaken for job persistence | Ledger/release/output artifacts are authoritative | `test_controller_recovery` orphan recovery |
| 17 | Slow tail blocked an entire wave | Completion-driven refill | `test_completion_driven_refill...` |
| 18 | Cross-event all-pairs work overflowed one request | Byte budgets, whole records, lineage compaction, explicit components | planner and Merge gate tests |
| 19 | Internal units were reported as remote calls | Status separates denominator, reservation, live, accepted, backlog | pipeline status and controller tests |
| 20 | Every small batch replayed global state | Ledger replay once; streaming materialization | `test_one_process_replays...`; pipeline materialization |
| 21 | Configured concurrency was called actual in-flight | Target, live lease, expired lease, backlog are separate | status and controller tests |
| 22 | Fixes mutated frozen trust artifacts | Release/candidate set/scope/policy are immutable | release, planner, controller tests |
| 23 | Directory existence was mistaken for completion | Manifest/seal required; partial staging rejected | `test_half_initialized_staging...` |
| 24 | Reservation/output/receipt became orphaned | Lease reclaim plus bound-output recovery | ledger and recovery tests |
| 25 | “Drain current work” had an ambiguous denominator | Immutable exact run scope and drain receipt | `test_run_scope...` |
| 26 | Lower-cost model passed shape but lost recall | Model-neutral policy plus distinct recall/canary gate | QA/canary/policy tests; field calibration remains pending |
| 27 | Context compaction was confused with semantic result compression | Original release/Map retained; compact record is derived with parent hash | oversize compaction test |
| 28 | Component folding deleted events | Component text reassembles exactly and keeps parent fingerprint | oversize compaction test |
| 29 | One model tier was used for all risks | Frozen ordinary/advanced/mixed capability tier; no vendor binding | runtime policy test |
| 30 | Repeated ledger/materialization exhausted CPU/memory | One replay per controller; streamed JSONL; byte budget | ledger replay, planner, materialization tests |
| 31 | Failure happened before inference due to empty/oversize/double binding | Non-empty instruction, bytes, one binding, no-data probe | transport tests |
| 32 | Half migration and duplicate coordinators competed | Migration watermark, one-writer controller contract, exact scope | controller scope tests |
| 33 | One CPU snapshot or only the parent hid real load | Explicit task-owned PID set sampled over a time window | `test_process_monitor` |
| 34 | Remote results returned faster than validation | Produced/validated/commit are separate; backlog gate | pipeline three-step and controller tests |
| 35 | Orchestrator and semantic model roles were confused | Packet stage is explicit; runtime binds only current user model; policy sealed | transport and runtime policy tests |
| 36 | Systemic rejection continued across the full corpus | Canary sample threshold halts refill | `test_canary_halts_refill...` |
| 37 | Empty prompt, duplicate payload, or half-ready source reached transport | Four local preflight gates and verified release | transport/release tests |
| 38 | Validated results were never committed | Validated state is recoverable and committed without re-inference | `test_orphan_raw_output...`; pipeline three-step test |
| 39 | Null/date/evidence shape errors were treated as content | Deterministic list/evidence compiler and receipt | repair tests |
| 40 | Unknown transport event discarded a valid output | Inspect bound artifact/hash before retry | recovery test |
| 41 | Final ran before lane merge/conflict freeze | Dependency gate and immutable Final candidate set | ledger and pipeline Final tests |
| 42 | Schema version was treated as decoration | Versioned macOS/Windows profiles, fingerprint, drift rejection | `test_wechat4_mapping.WeChat4SchemaTests` |
| 43 | Model/vendor switch changed data/privacy boundaries | Provider-neutral packets and local authorization/validator remain fixed | transport, authorization, runtime policy tests |
| 44 | Platform/no-GUI/current-model/no-Fast constraints arrived late | Product metadata and runtime policy encode all four | CLI/help and public-package policy scan |
| 45 | Experimental scripts/private history were mistaken for product code | Clean-room tree, synthetic fixtures, no symlinks/private markers, overlap checks | `test_public_package`; release verification scan |
| 46 | A tested baseline was described as the complete requested product | Four-column implementation/test/field/blocker matrix; versioned baseline designation | `test_public_package`; `versions/v1-verified-baseline.json` |
| 47 | Model work used a moving or implicit episode denominator | Immutable per-domain packet with exact route IDs and seal | `test_domain_routing` |
| 48 | An optional time/post-processing sidecar failure invalidated accepted model work | Accepted model outcome remains terminal; retry sidecar only | `test_v2_incident_guards.test_accepted_model_result...` |
| 49 | “Structural repair” silently rewrote narrative content | Before/after hashes plus narrative-field invariance gate | `test_v2_incident_guards.test_structural_repair...` |
| 50 | Cloud compaction/grouping discarded exact candidate narratives | Cloud returns grouping relation; local reconstruction copies frozen candidates | `test_compact_merge` |
| 51 | Error-like words inside valid content were parsed as infrastructure failure | Only explicit structured failure events enter taxonomy | `test_v2_incident_guards.test_failure_classifier...` |
| 52 | Dispatch failed because the output destination was not ready | Writable output-directory preflight before inference | `test_v2_incident_guards.test_output_directory...` |
| 53 | Parallel writers silently overwrote a contract artifact | Identical replay is idempotent; divergent single-writer write fails | `test_v2_incident_guards.test_single_writer...` |
| 54 | No relevant signal was reported only as “reviewed” | `no_signal` is an explicit processing disposition; `reviewed` rejected | `test_life_events`; `test_domain_routing` |
| 55 | Development examples leaked into fidelity evaluation | Frozen disjoint development/holdout split | `test_v2_incident_guards.test_holdout...` |
| 56 | A conservative cross-event summary replaced the complete life ledger | Full ledger is authority; importance only builds a derived biography view | `test_life_events.test_biography_view...` |
| 57 | A routed episode had zero or duplicate processing outcomes | Exactly one closed-set processing result per frozen route | `test_domain_routing`; `test_life_events` |
| 58 | Message send date was promoted to event date | Observed and asserted time are separate; time precision retained | `test_life_events.test_observed_time...`; `test_domain_routing` |
| 59 | Travel completion was reported as whole-life completion | Nine independent coverage receipts; unrun domains remain `not_extracted` | `test_life_events`; `test_domain_routing` |
| 60 | Self, third-party, plans, bookings, and completed acts were mixed | Closed subject and disposition enums plus cross-field validation | `test_life_events` |
| 61 | City, country, subregion, landmark, and ambiguous place were flattened | Closed place-kind taxonomy; candidate mappings remain explicit | `test_places` |
| 62 | City/landmark names leaked into visited-country counts | Country-only view from occurred/completed self events | `test_places.test_visited_countries...` |
| 63 | Chinese runtime queries failed because search split only on spaces | Character/bigram Chinese tokens plus English tokens | `test_runtime.test_chinese...` |
| 64 | No-match retrieval returned arbitrary first records and implied absence | Explicit unknown/coverage gap; no fallback; domain coverage always declared | `test_runtime` |
| 65 | Runtime loaded a monolithic persona regardless of task | biography/voice/advisor/mixed permissions and minimal relevant modules | `test_runtime`; `test_personal_assets` |
| 66 | Voice assets encouraged generic mimicry, auto-send, or impersonation | Scenario dimensions, draft-only permission, private-example rejection, blind-review truth | `test_personal_assets` |
| 67 | Observation, pattern, hypothesis, and advice collapsed into assertions | Four layers; counterexamples/time/domain/tension; advice tradeoff fields | `test_personal_assets` |
| 68 | Users were asked to judge a large queue of low-impact abstractions | Calibration queue requires both behavior-changing and ready | `test_personal_assets.test_calibration...` |
| 69 | Knowledge cards became the only retained memory | Cards are high-confidence indexes; full event/evidence/assets remain searchable | `test_personal_assets`; `test_runtime` |
| 70 | Corrections, withdrawals, and rollback were informal overwrite advice | Append-only update/correct/withdraw/reextract/rollback state machine | `test_profile_history` |
| 71 | Aggregate private-corpus evidence was presented as execution by public code | Field receipt labels aggregate separately and denies public-tree execution | `test_v2_incident_guards.test_authorized_aggregate...` |
| 72 | Repeated infrastructure failures kept refilling at full rate | Repeated-signal cooldown, reduced target, and fallback recommendation | `test_controller_recovery.test_repeated_infrastructure...` |
| 73 | A “portable persona” omitted evidence, boundaries, or evaluation truth | Sealed package requires events/evidence/cards/assets/coverage/boundaries/evals | `test_portable_package`; external-CWD v2 forward test |
| 74 | External persona projects became a code/template dependency | Idea-level provenance only; no clone/vendor/import; license-specific rejection record | `test_public_package`; `references/external-method-review.md` |
| 75 | A single-event route shape merged or deleted multiple same-domain facts | Each route has `events[]` with 0..N independent items; ledger materialization proves multiplicity | `test_route_results.test_one_terminal...`; `test_life_events` |
| 76 | One route-level semantic status was inherited by heterogeneous events | Route processing status and per-event semantic disposition are separate; event status is authoritative | `test_route_results.test_processing...`; `test_life_events.test_route_result...` |
| 77 | A model could invent a valid-looking place ID or inject one from another route | Packet freezes per-route place allowlists; validate and merge enforce event subset; empty means empty | `test_route_results.test_event_places...`; `test_route_results.test_empty...`; `test_route_results.test_ledger_merge...` |

## Audit limitation

The source conversation was mechanically reconciled from its earliest saved page, but the current task did not permit another agent. Therefore this is a self-audit, not an independent behavioral audit. The isolated external-CWD CLI forward test provides process isolation only; it does not remove that reviewer-independence limitation.
