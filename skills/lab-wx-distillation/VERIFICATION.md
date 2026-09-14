# Verification Record

Date: 2026-08-22
Implementation commit: `377c4836dc3063e3e86c7a3d90cfe73b8997a04f`
Implementation tree: `36e0344bc5ec20b9096b181e0aaacdbd95521668`
Scope: v2.0.1 route-result correction on synthetic/public fixtures; field truth separated by capability

## Fresh checks

- `PYTHONPATH=scripts python3 -m unittest discover -s tests -p 'test_*.py'`: **150 tests passed**.
- `python3 -m compileall -q scripts`: all Python modules compiled.
- Skill creator `quick_validate.py .`: **Skill is valid**.
- `python3 scripts/pcd.py contract-validate contracts/real-distillation-v2`: valid contract `2.0.1-contract-rc2`, bundle SHA-256 `e2f27026522d8c5a78c20f4d8744bc997611d84f49a91e85c23c0ce376588500`.
- `python3 scripts/pcd.py --help`: all collection, stage, domain, place, runtime, profile-history, recovery, field-evidence, and contract commands loaded.
- `git diff --check`: no whitespace errors.
- Public-tree tests and scan: no symlink, private absolute path, source-task identifier, non-synthetic WeChat identifier, private-key header, vendor-model binding, or enabled Fast mode.
- Exact public-line overlap with the private audit capture for lines of 60+ characters: **0**.
- Exact 60+ character Python-line overlap with the separate read-only source workspace: **0**.

## Audit coverage

The prior audit covered 82 pages / 815 turns and 45 aggregated incident classes. The v2 audit mechanically reconciled the 66 later turns 816–881 and merged them into 29 additional public incident classes. The three subsequent contract corrections add single-object event loss, route-status inheritance, and place-ID injection, bringing the rule/test map to 77 classes. No conversation text, identity, key, private path, or private receipt is in the public tree.

This remains a self-audit because no independent behavioral reviewer was available in this task. The external-CWD forward test provides execution isolation, not reviewer independence.

## Executable coverage added in v2

- immutable machine-readable field enums, route-result/event-item/place schemas, acceptance gates, and delta routes;
- nine independent domain packets, exactly one processing result per route, zero-to-many independent events, explicit no-signal, dual-time precision, and complete ledgers;
- per-event authoritative semantic states plus route-bound evidence/place allowlists at validation and merge;
- safe place normalization, ambiguity retention, and country-only visited views;
- biography/voice/advisor/mixed retrieval with structured filters, Chinese lexical search, explicit unknown, and domain coverage truth;
- observation/pattern/hypothesis/advice assets, scenario voice permissions, fidelity, frozen redacted evaluation cases, calibration, and knowledge-card indexing;
- sealed portable packages plus append-only update, correction, source withdrawal, domain re-extraction, and rollback;
- explicit failure events, optional-sidecar isolation, output preflight, cooldown/fallback, exact local reconstruction, narrative-invariant repair, and zero-loss Unicode splitting;
- repository-external synthetic forward paths for both WeChat platform profiles and for domain → ledger → package → runtime.

## Change size relative to v2.0.0

Compared with the preceding finalized v2 commit `2f95c0a52b514ee1f6a6c3d098fdab5909a09897`:

- 34 of the final 119 tracked paths changed (28.6% of the v2.0.1 tree); tracked paths increased from 117 to 119;
- the repository diff was +950 / -324 lines;
- production Python nonblank/noncomment lines increased from 5,054 to 5,261 (+4.1%);
- production-script diff was +350 / -133 lines across four files.

These are named engineering denominators, not a claim that a percentage directly measures product quality.

## Field truth and remaining validation

Synthetic/public fixtures establish implementation and regression behavior. They do not establish compatibility with a real WeChat build. No real database, account, identity, key, or app process was used by this public tree.

Authorized aggregate source-task evidence separately establishes 1696/1696 legacy travel dispositions and 311/311 place checks, including 42 retained ambiguous items. It does not establish that this public code processed that corpus, and it is not current-contract field validation until a lossless route-result migration proves event multiplicity, per-event status, and route-specific evidence/place bindings. The other eight domains, real runtime queries, voice blind review, fidelity evaluations, long-running profile evolution, and every concrete macOS/Windows WeChat build remain pending field validation.

Native process-memory key extraction, injection, re-signing, proprietary derivation, automatic external KB writes, and unreviewed commercial/enterprise use remain explicit blockers. The safe connector fallback is a user-provided lawful decrypted export. The custom license requires qualified lawyer review before publication.
