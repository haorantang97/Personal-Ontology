# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are repository
tags (`vX.Y.Z`). Module-internal versions are noted in the entries.

## [Unreleased]

### Added

- `lab-trust-core` — a standalone, MIT-licensed trust-policy core with SDK,
  CLI, read-only MCP, JSON Schemas, Markdown adapter, synthetic examples and
  50 deterministic tests. It can be installed without `lab-ontology` and is
  catalogued between the complete system and the four Skills.

### Changed

- `lab-knowledge-retrospective` now separates concise conclusion reviews from
  forensic reviews of failed, long or cross-task work. Forensic mode audits raw
  turns and completion claims, tracks corrections and open loops, and reports
  `COMPLETE` or `PARTIAL` coverage before distilling reusable conclusions.

## [0.1.0] - 2026-08-23

First catalogued release.

### Added

- `lab-ontology` — the agent knowledge system: Obsidian vault skeleton, `agent-knowledge` MCP gateway (package 1.6.0, 13 `knowledge_*` tools), schema pack `agent-decision-memory` 1.1.1, vault validator, graph sync and index-scope guards, with module README, architecture and setup docs.
- `lab-context-distillation-wx` — deterministic local pipeline for evidence-bounded personal context from WeChat 4.x data (module v2.0.1; renamed from `lab-context-distillation`).
- `lab-life-reviewer` — interview-led life review with Raw/handoff artifacts (renamed from `life-review`).
- `lab-knowledge-retrospective` — distils finished work into evidence-bounded conclusions.
- `lab-knowledge-intake` — proposal-gated entry point into the knowledge base.
- Root catalog README with overview diagram, per-module status, `CONTRIBUTING.md`, `tests/` layout and public-boundary tests, single CI workflow.

### Changed

- Repository-wide license is now PolyForm Noncommercial License 1.0.0; module `LICENSE.md` files point to the root.
- `lab-ontology` gateway defaults `GBRAIN_BIN` to `~/.bun/bin/gbrain` and reads smoke-test cases from `smoke-cases.json` (differences from the author's local vault are listed in the module README, Provenance).

### Removed

- `docs/superpowers/` planning records at the root and inside the wx module.
