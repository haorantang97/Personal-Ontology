# Project Status

Status: **v2.0.1 verified route-result correction for synthetic/public-fixture scope; field truth remains capability-specific**
Supersedes the completion claim recorded for commit `debb09b`.

The exact v1 implementation is frozen by Git commit and tree identity in
`versions/v1-verified-baseline.json`. That manifest is append-only history: v2
is independently frozen in `versions/v2-verified-release.json`. The route-result
trust-boundary correction is separately frozen in
`versions/v2.0.1-route-result-correction.json`; none of these records may be rewritten.

Commit `debb09b` was a tested provider-neutral workflow baseline, not the complete Skill requested. That interpretation remains withdrawn.

In addition to the v1 connection and Map → Merge → Final → QA baseline, the
current v2 tree contains executable, tested paths for:

- macOS/Windows account and multi-database discovery with a private source registry;
- WAL/SHM-aware snapshots, encrypted candidate recognition, authorized private key files, and standard SQLCipher export;
- versioned schema fingerprints plus message/contact/group/media/favorite/Moments mapping;
- release-bound incremental checkpoints;
- strict Map → Merge → Final → QA contracts, coverage, conflicts/gaps, compaction, recovery, adaptive refill, and human/KB gates.
- frozen per-domain routing with exactly one processing result per route and zero-to-many independent events;
- authoritative per-event semantic status plus route-bound evidence/place allowlists enforced again at merge;
- complete life ledgers, dual time semantics, deterministic place taxonomy, and independent domain coverage;
- biography/voice/advisor/mixed retrieval with Chinese-friendly search and no arbitrary fallback;
- layered self/voice/advice assets, fidelity and blind-review truth, trusted cards, and portable sealed packages;
- append-only incremental update, correction, withdrawal, re-extraction, and rollback.

This is **not a WeChat field-compatibility claim**. No real WeChat database or key
was used by this public repository. Separately, the source task supplied
authorized aggregate field evidence for the legacy travel method: 1696/1696 episode
dispositions, plus 311/311 deterministic place checks. Those aggregates contain
no private content, do not prove that this exact public code ran that corpus, and
do not satisfy the corrected route-result contract until lossless migration is verified.
Exact app-build paths, schemas, encryption parameters, other life domains,
runtime fidelity, and real-device quality remain pending. Process-memory key
extraction, injection, re-signing, and proprietary native key derivation remain
excluded pending qualified legal review and platform authorization. The safe
fallback is a user-provided lawful decrypted export.

Implementation status is tracked in `docs/feature-implementation-matrix.md`. A capability may be called implemented only when executable code exists. “Tested” and “field validated” are separate columns and must never be inferred from implementation alone. The custom public-view/personal-noncommercial license remains a draft requiring qualified legal review before external publication.
