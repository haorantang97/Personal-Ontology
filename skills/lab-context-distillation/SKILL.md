---
name: lab-context-distillation
description: Use when a user wants to collect, decrypt, normalize, redact, map, merge, audit, adjudicate, or turn macOS/Windows WeChat 4.x conversations into an evidence-bounded personal operating model or a knowledge-base proposal. Also trigger for 微信聊天蒸馏、个人上下文、个人运作模型、聊天知识库、全量 Map、跨事件归并、冲突补漏、蒸馏验收 or resumed distillation runs.
---

# Lab Context Distillation

> **Current release status: v2 is verified with synthetic/public fixtures; real-device validation remains capability-specific.** Do not claim compatibility with a particular WeChat 4.x build until that build passes the field checklist. Read [STATUS.md](STATUS.md), the [feature implementation matrix](docs/feature-implementation-matrix.md), and the immutable [machine contract manifest](contracts/real-distillation-v2/manifest.json) before use.

Build an evidence-bounded personal operating model from user-approved conversation data. Keep collection and identity work local; let the current model see only sealed, redacted packets.

## Non-negotiable boundaries

- Never read or send raw databases, local keys, identity maps, or `local/normalized.jsonl` to a model.
- Treat a request to analyze or distill as authorization to process already-redacted data for this task.
- Ask again only before adding a new source, sending unredacted content, acquiring a local key, or approving a knowledge-base write.
- Do not rerun an `accepted` unit. Create a new generation when rules or inputs change.
- Do not mutate a sealed release, ledger history, receipt, packet, or candidate set.
- Separate infrastructure, structure, content, privacy, and dependency failures.
- Use deterministic structural repair only when meaning and evidence stay unchanged.
- Do not write to a knowledge base after approval automatically. Approval produces a receipt; use the relevant external connector only in a separate, explicitly authorized step.
- Do not hard-code a model vendor, model name, agent count, or Fast mode.
- Keep the complete event ledger as authority. Importance may rank a biography view but must never delete an episode.
- Give every route exactly one processing result. A processing result emits zero-to-many independent events; each event owns its semantic disposition. Never merge events to fit a single-object shape.
- Bind every event evidence ID and place ID to that route's frozen allowlists. An empty place allowlist requires empty event `place_ids`; unverifiable place IDs never enter the ledger.
- Keep `observed_message_time` separate from `asserted_event_time`; never substitute message time for an unknown event time.
- A runtime answer must declare relevant-domain coverage as `complete`, `partial`, `not_extracted`, or `ambiguous`. No retrieval hit means `unknown`, not an arbitrary top-N fallback.
- Voice mode may draft only. It may not impersonate, auto-send, make commitments, or claim indistinguishability.
- Do not perform process-memory key extraction, injection, app re-signing, native key derivation, or package a circumvention tool. These are explicit legal/terms blockers in this public implementation.

Read [privacy-and-authorization.md](references/privacy-and-authorization.md) before handling a new case. Read [platform-connectors.md](references/platform-connectors.md) before touching WeChat data.

## Run the workflow

Before parallel or resumed real distillation, validate the frozen machine contract:

```bash
python3 scripts/pcd.py contract-validate contracts/real-distillation-v2
```

The manifest pins the field enums, route-result/event-item/place schemas, acceptance gates, and delta-routing rules by SHA-256. A main project with an accepted Map starts at `post_map_domain_routing`; it does not rerun accepted Map work.

1. Create an isolated case directory outside this Skill package:

   ```bash
   python3 scripts/pcd.py init /path/to/case
   ```

2. For a new source, explain the source and obtain exact approval, then record it:

   ```bash
   python3 scripts/pcd.py authorize /path/to/case new_source --note "user approved this source"
   ```

3. For WeChat 4.x, privately discover and register a user-approved source, then snapshot the entire account database set:

   ```bash
   python3 scripts/pcd.py wechat4-discover /path/to/case macos
   python3 scripts/pcd.py wechat4-snapshot /path/to/case acct_... snapshot-g0001
   ```

   Use `windows` on Windows. An explicit `--root` is allowed. The command output contains opaque refs, not local paths.

   If the snapshot contains encrypted candidates, obtain separate `local_key_access` approval. Accept only a lawfully obtained 32-byte hex key in a private mode-0600 file and a separately installed SQLCipher binary:

   ```bash
   python3 scripts/pcd.py authorize /path/to/case local_key_access --note "user supplied a lawful local key"
   python3 scripts/pcd.py wechat4-decrypt /path/to/case /path/to/snapshot decrypted-g0001 --key-file /private/key.txt
   ```

   Never display the key or put it in a command argument. The implementation passes it to SQLCipher over stdin. If the actual build does not match the tested standard profile, stop and use a user-provided lawful decrypted export; do not guess parameters or extract a key from process memory.

4. Map a plaintext snapshot through a versioned schema profile. Put the current account's private self identifier in a mode-0600 file:

   ```bash
   python3 scripts/pcd.py wechat4-map /path/to/case /path/to/plain-snapshot macos --self-file /private/self-id.txt
   python3 scripts/pcd.py release /path/to/case g0001
   python3 scripts/pcd.py wechat4-checkpoint /path/to/case wmap_... g0001
   ```

   The checkpoint moves only after the exact mapped fingerprints appear in a verified sealed release. Contacts and identity aliases stay in `local/`; the release contains deterministic pseudonyms.

5. For a lawful standard export instead, import unified records directly. The input rows must follow [record-contract.md](references/record-contract.md):

   ```bash
   python3 scripts/pcd.py ingest-jsonl /path/to/case /path/to/export.jsonl --source-name source-1
   python3 scripts/pcd.py release /path/to/case g0001 --gap "media unavailable"
   ```

6. Plan Map packets from the sealed release:

   ```bash
   python3 scripts/pcd.py plan /path/to/case map /path/to/case/releases/g0001/records.jsonl
   ```

7. Process runnable packets with the user's current model. Claim one unit and read only its file in `packets/`. Follow that packet's `output_contract`; do not reuse one stage's shape for another. Map/Merge/Final candidates include the six-field `quality` audit. Merge includes exact component IDs; Final includes confidence and limitations; QA includes a distinct seven-check report plus separate precision and recall counts. Every packet input must be used as evidence or listed in `coverage.excluded` with a reason.

   Keep model execution, local validation, and commit separate:

   ```bash
   python3 scripts/pcd.py record-output /path/to/case map:... /path/to/result.json
   python3 scripts/pcd.py validate /path/to/case map:...
   python3 scripts/pcd.py commit /path/to/case map:...
   ```

   `submit` is a small-case convenience that runs these three deterministic transitions in order. For long runs, prefer the separate commands so the feeder and validator can progress independently. If independent packets and dynamic subagents are available, choose concurrency from current workload and error signals; never treat configured concurrency as actual in-flight work.

8. After every Map unit is accepted, materialize the immutable derived view. For a general semantic model, plan Merge with all Map unit IDs as dependencies:

   ```bash
   python3 scripts/pcd.py materialize /path/to/case map /path/to/case/derived/map.jsonl
   python3 scripts/pcd.py plan /path/to/case merge /path/to/case/derived/map.jsonl --depends map:...
   ```

   Before Final, freeze the exact Merge candidate IDs and pass that set to planning:

   ```bash
   python3 scripts/pcd.py freeze-candidates /path/to/case final-input /path/to/case/derived/merge.jsonl
   python3 scripts/pcd.py plan /path/to/case final /path/to/case/derived/merge.jsonl --candidate-set final-input --depends merge:...
   ```

   Repeat acceptance and materialization for Final and QA. Preserve the complete Map; compaction is derived and keeps lineage. Read [workflow.md](references/workflow.md) and [quality-and-adjudication.md](references/quality-and-adjudication.md).

9. For the v2 life-context path, route the accepted, redacted episode authority independently through all nine domains. Start with travel only when field evidence is being established; travel completion never implies another domain is complete:

   ```bash
   python3 scripts/pcd.py domain-plan /path/to/domain-work travel-g0001 travel /path/to/episodes.json
   # The current model returns one processing result per route; each result contains events[].
   python3 scripts/pcd.py domain-validate /path/to/domain-work/domain-packets/travel-g0001.json /path/to/travel-result.json /path/to/travel-ledger.json
   python3 scripts/pcd.py life-ledger-merge /path/to/life-ledger.json /path/to/travel-ledger.json /path/to/education-ledger.json
   ```

   The packet freezes separate evidence and place allowlists for every route. `events_emitted` requires one or more independent event items; `no_signal`, `out_of_domain`, and `insufficient_evidence` require an empty `events` array. Every event carries its own status, evidence subset, and place subset. Repeat `domain-plan` and `domain-validate` for `education`, `work`, `relationship`, `residence`, `family`, `health`, `finance`, and `creation`. Unrun domains remain `not_extracted`; an ambiguous route remains visible. Normalize locations only from explicit candidates:

   ```bash
   python3 scripts/pcd.py places-normalize /path/to/place-mentions.json /path/to/place-candidates.json /path/to/places.json
   ```

10. Build a sealed portable package from the complete ledger, evidence, layered assets, and trusted-card index; then query the smallest relevant private context:

   ```bash
   python3 scripts/pcd.py package-build /path/to/life-ledger.json /path/to/places.json /path/to/evidence.json /path/to/assets.json /path/to/cards.json /path/to/packages profile-g0001
   python3 scripts/pcd.py runtime-query /path/to/packages/profile-g0001/package.json "问题" --mode biography --filters /path/to/filters.json
   ```

   Modes are `biography`, `voice`, `advisor`, and `mixed`. Search applies structured filters and Chinese-friendly lexical matching; optional semantic scores are caller-provided. Knowledge cards are high-confidence indexes, never substitutes for the evidence or event layers.

11. Route ambiguous meaning, invalid attribution, unresolved conflict/missing evidence, or privacy exceptions to human adjudication. Deterministic fixes may normalize shape, nulls, order, and duplicate evidence IDs; they may not invent evidence, rewrite claims, upgrade source strength, erase weak-source markers, or change narrative fields.

12. Freeze a knowledge-base proposal. Show its exact entries and digital seal to the user. Record `kb_write` authorization only after explicit approval, then create an approval receipt. External writing remains a separate step.

13. Treat incremental update, correction, source withdrawal, single-domain re-extraction, and rollback as explicit append-only transitions. Use the `profile-*` commands in [profile-evolution.md](references/profile-evolution.md). Every transition creates a new snapshot; old results stay read-only. Rebuild only affected domains and downstream packages, never accepted Map generations.

## Resume safely

Run `python3 scripts/pcd.py status /path/to/case`. The append-only ledger is authoritative; summary counts are derived. Run `recover-ingestions` if a private WeChat mapping was interrupted; release creation verifies that every redacted fingerprint has a completed source receipt. Freeze `policy-freeze` before a large run so the receipt records the current user model, ordinary/advanced/mixed tier, dynamic concurrency, and the absence of Fast mode. Run `recover-results` before resubmitting an unknown transport outcome. Use `controller-refill` for completion-driven slots and `scope-freeze`/`scope-status` for a sealed migration/drain denominator. Use `process-sample` repeatedly for the exact task-owned PIDs when diagnosing resource pressure. Reclaim only expired reservations. Never infer that a directory alone means a step completed.

## Load references selectively

- Full stage sequence and commands: [workflow.md](references/workflow.md)
- Privacy and permission decisions: [privacy-and-authorization.md](references/privacy-and-authorization.md)
- Unified record and evidence fields: [record-contract.md](references/record-contract.md)
- Ledger transitions and resume rules: [state-machine.md](references/state-machine.md)
- Error-specific recovery: [error-taxonomy.md](references/error-taxonomy.md)
- Capability tiers and adaptive concurrency: [model-and-concurrency-guidance.md](references/model-and-concurrency-guidance.md)
- Real-platform boundary and safe fallback: [platform-connectors.md](references/platform-connectors.md)
- Acceptance, conflicts, gaps, and adjudication: [quality-and-adjudication.md](references/quality-and-adjudication.md)
- Complete episode ledgers, dual time, coverage, and place taxonomy: [life-event-ledger.md](references/life-event-ledger.md)
- Runtime retrieval, personal assets, voice boundary, fidelity, and cards: [runtime-and-assets.md](references/runtime-and-assets.md)
- Incremental update, correction, withdrawal, re-extraction, and rollback: [profile-evolution.md](references/profile-evolution.md)
- Frozen machine-readable enums, schemas, gates, and delta routes: [contract manifest](contracts/real-distillation-v2/manifest.json)
- What is verified versus pending field work: [field-validation-status.md](references/field-validation-status.md)
- License implications: [licensing.md](references/licensing.md)
- Legal and connector exclusion boundary: [legal-and-connector-boundary.md](references/legal-and-connector-boundary.md)
- Aggregated incident-to-rule/test audit: [incident-rule-coverage.md](docs/incident-rule-coverage.md)
