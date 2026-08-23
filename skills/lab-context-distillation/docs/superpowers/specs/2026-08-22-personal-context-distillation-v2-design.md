# Personal Context Distillation v2 Design

Date: 2026-08-22
Status: approved by the user's explicit upgrade direction
Predecessor: immutable v1 baseline at `e4c0f99`, registered by `c17336a`

## Outcome

v2 extends the working collection and Map → Merge → Final → QA baseline into a
portable, evidence-bounded life-context runtime. It does not replace the full
event and evidence stores with a persona summary. It makes the following
separate, executable products of one pipeline:

1. a complete per-domain event ledger and coverage receipt;
2. a display-ranked biography view that never deletes ledger events;
3. decision, expression, boundary, evidence, and evaluation assets;
4. minimal-context runtime retrieval for biography, voice, advisor, and mixed
   modes; and
5. append-only correction, withdrawal, re-extraction, and rollback history.

The product remains a Skill plus deterministic Python scripts, references,
synthetic fixtures, and tests. There is no GUI and no model-vendor dependency.

## Trust layers

```text
approved local sources
  -> immutable redacted release
  -> Map candidates (retained)
  -> routed domain results (one processing result, zero-to-many events each)
  -> complete domain ledgers + coverage
  -> cross-domain merge + conflicts/gaps
  -> layered self/voice/advice assets
  -> QA + holdout/blind-review status
  -> portable runtime package
  -> exact KB proposal (separate approval, no automatic write)
```

The event ledger and evidence layer remain searchable even when an item is too
weak to enter a knowledge card. Importance affects only biography display.

## Core contracts

### Route-result and event-item contract

Every route has exactly one processing disposition from a closed enum. It emits
zero-to-many independent event items, and every event has its own authoritative
semantic disposition. `reviewed` is not a disposition. The route and event
records separate subject, domain, evidence, observed message time, and asserted event time. Time values retain
their precision (`day`, `month`, `year`, `relative`, or `unknown`); the observed
message time is never substituted for a missing asserted event time.

Each route packet freezes evidence and place allowlists. Event IDs may reference
only their own route's subsets; an empty place allowlist requires empty event
place IDs. Validation and ledger merge both enforce this boundary.

Each supported domain receives its own `complete`, `partial`, `not_extracted`,
or `ambiguous` coverage state before cross-domain combination. Travel is the
first field-evidenced domain; education, work, relationship, residence, family,
health, finance, and creation remain independently auditable.

### Place contract

Places use `country`, `city`, `subregion`, `landmark`, `other`, or `ambiguous`.
Alias, typo, slang, abbreviation, and `contained_in` relationships are candidate
mappings. Only an exact, unique, deterministic mapping can be applied
automatically. Ambiguity stays visible. Visited-country views contain country
objects only and do not erase cities or landmarks from the ledger.

### Runtime contract

Runtime queries combine structured filters with Chinese-friendly lexical
retrieval and optional caller-provided semantic scores. No-match returns
`unknown` plus a coverage gap; it never returns arbitrary leading records.
Every result declares the relevant domain's extraction state.

The runtime loads only the modules needed by `biography`, `voice`, `advisor`, or
`mixed`. Relationship/conflict, goals/open loops, and time evolution load only
when requested or relevant. Voice can draft but cannot send, impersonate, make
commitments, or claim indistinguishability.

### Self-model contract

Claims are typed as observation, pattern, hypothesis, or advice. Patterns retain
counterexamples, time change, domain scope, and unresolved tension. Advice also
requires benefit, cost, trigger, reversibility, and uncertainty. Fidelity is a
separate evaluation across cross-domain reproduction, holdout prediction, and
non-generic distinctiveness. Voice blind review has an honest status and is
required before a field-valid fidelity claim.

### Evolution contract

Incremental update, correction, rollback, source withdrawal, and domain
re-extraction are append-only transitions. Each transition creates a new sealed
snapshot; previous snapshots are read-only history. Withdrawal deactivates
derived material without destroying the old evidence. Runtime defaults to the
latest active version but may inspect a prior version explicitly.

## Failure and recovery additions

- Parse only explicit failure events; ordinary output text containing error-like
  words is never itself a failure signal.
- Prepare output destinations before dispatch and record readiness.
- A successful model result can remain accepted even if an optional sidecar
  fails; the sidecar is retried independently.
- Shared schemas/configuration have one idempotent writer contract.
- Every eligible episode and lane has an explicit event or no-signal outcome.
- Development evidence cannot silently enter a frozen holdout set.
- Oversize splitting proves exact character reconstruction and retains the
  unmodified authority.
- Deterministic repair must prove narrative fields unchanged.

## External-method clean-room boundary

The design uses only independently restated ideas visible in public project
descriptions. Nuwa contributes validation questions and voice/advisor separation;
digital-life contributes portable, evidenced assets; me.skill contributes
increment/correction/rollback as product states; Persona-Skill contributes rich
dimensions and partial module loading; PersonalOS contributes local-first,
review-before-save context. No external directory layout, prompt, template,
schema, code, or distinctive wording is copied. Unlicensed and GPL sources are
idea-only and create no compatibility dependency.

## Field truth

The v2 public code will distinguish `implemented`, `tested`, `field-evidenced`,
and `blocked`. Aggregate travel receipts from the source task may demonstrate the
method on real private material without becoming a claim that this public tree
processed or contains that material. WeChat build compatibility remains pending
real-device authorization and samples.

## Safe migration from the source task

Do not rerun accepted Map. Reuse the frozen episode and evidence authorities,
then begin at high-recall domain routing and processing results. Legacy travel
results may be imported only after lossless migration proves independent-event
multiplicity, per-event dispositions, and route-bound evidence/place allowlists;
remaining domains run independently, then merge into the full life ledger and
v2 runtime assets. Knowledge-base writing remains outside this migration.
