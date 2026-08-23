# Personal Context Distillation v2 Implementation Plan

Date: 2026-08-22
Method: test-driven implementation with completion claims gated by fresh evidence

## 1. Freeze and audit

- Preserve the v1 commit/tree in an append-only version manifest.
- Reconcile source turns 816–881 with the earlier 45 incident classes.
- Record only aggregated public lessons and field counts.
- Verify external repository license and reject code/template compatibility.

## 2. Event and domain core (tests first)

- Add `tests/test_life_events.py` for route processing dispositions, independent
  per-event dispositions, dual time, route allowlists, per-domain coverage,
  full ledger retention, display ranking, and no-signal.
- Implement `life_events.py` with closed enums, validators, ledger builder, and
  domain coverage receipts.
- Add a synthetic multi-domain fixture with travel, work, relationship, relative
  time, third-party, and insufficient-evidence cases.

## 3. Place normalization (tests first)

- Add `tests/test_places.py` for kind validation, unique safe mapping,
  ambiguity, contained-in candidates, and country-only visited views.
- Implement `places.py` without model calls or guessing.

## 4. Runtime and assets (tests first)

- Add `tests/test_runtime.py` for structured filters, Chinese text, optional
  hybrid scoring, no fallback, coverage declarations, and minimal module load.
- Implement `runtime.py` as a small portable evidence-pack builder.
- Add `tests/test_personal_assets.py` for observation/pattern/hypothesis/advice,
  scenario voice, permissions, fidelity, blind review, calibration, and cards.
- Implement `personal_assets.py` and keep exact private examples out of portable
  assets.

## 5. Evolution state machine (tests first)

- Add `tests/test_profile_history.py` covering initial snapshot, incremental
  update, correction, withdrawal, domain re-extraction, rollback, seals, and
  immutable prior versions.
- Implement `profile_history.py` with append-only receipts and sealed snapshots.

## 6. Incident hardening (tests first)

- Add regression tests for explicit failure-event parsing, output-directory
  readiness, post-processing isolation, idempotent single-writer artifacts,
  holdout freeze, and exact reversible splitting.
- Extend the smallest relevant existing modules; do not mix semantic repair with
  structural recovery.

## 7. CLI and Skill integration

- Add CLI commands for domain-ledger build, place normalization, runtime query,
  asset validation, and profile-history transitions.
- Update `SKILL.md` with progressive loading and the v2 path.
- Update contracts, workflow, state machine, incident coverage, external-method
  decisions, field evidence, migration boundary, feature matrix, audience path,
  status, verification, and notices.

## 8. Verification and immutable release

- Run focused red/green tests throughout, then full unittest discovery.
- Run compile, CLI help, JSON/Markdown/package privacy scans, Git diff checks,
  Skill quick validation, and an external-CWD forward test.
- Verify no source/private overlap and no mutation of the read-only source tree.
- Measure changed files and Python logic relative to `e4c0f99` with named
  denominators.
- Create a v2 manifest containing the release commit/tree via a finalization
  commit; never rewrite the v1 manifest.
