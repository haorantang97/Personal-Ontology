# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are repository
tags (`vX.Y.Z`). Module-internal versions are noted in the entries.

## [Unreleased]

### Added

- `lab-trust-core` — a standalone, MIT-licensed trust-policy core with SDK,
  CLI, read-only MCP, JSON Schemas, Markdown adapter, synthetic examples and
  51 deterministic tests. It can be installed without `lab-ontology` and is
  catalogued between the complete system and the four Skills.
- Agent Knowledge 1.8.0 Native hybrid retrieval: a commit-bound Markdown
  catalog, versioned CJK-aware chunking, lexical/vector ranking, immutable
  index generations and deterministic same-commit keyword fallback.
- A generated human `index.md` that is rebuilt from committed pages, ignored by
  Git and excluded from the retrieval corpus.
- A pinned `lab-trust-core` release used only for bounded, non-enforcing
  `trust_shadow` observations after an allowed page read.
- An updated Trust Core catalog-integration design record under
  `docs/superpowers/specs/`; it contains architecture context, not a runtime
  dependency or second installation path.

### Changed

- `lab-knowledge-retrospective` now separates concise conclusion reviews from
  forensic reviews of failed, long or cross-task work. Forensic mode audits raw
  turns and completion claims, tracks corrections and open loops, and reports
  `COMPLETE` or `PARTIAL` coverage before distilling reusable conclusions.
- Its UI metadata now uses a concise description and one-sentence default prompt
  that preserve the required history-preflight order.
- `lab-ontology` now ships gateway 1.8.0 with the canonical schema pack at
  `ops/agent-knowledge-schema/pack.json` and runtime state under
  `~/.agent-knowledge/`.
- Direct reads, relationships and schema responses now come from one immutable
  Git commit; full Native retrieval requires an Ollama-compatible embedding
  service, while failures visibly degrade to keyword recall on that same commit.
- CI now verifies the complete unit suite, Schema/Vault validation and the exact
  13-tool MCP surface on Node 20 and 24 inside a temporary, independently
  initialized Git Vault.
- `knowledge_list` now applies result/evidence scope before its limit, so a
  large population in one layer cannot silently hide pages from the other.
- `knowledge_schema` now reports the effective proposal and lock directories
  after `AGENT_KNOWLEDGE_STATE_DIR` resolution instead of always displaying
  the default paths.
- `lab-trust-core` 0.1.2 replaces the optional host example with the generic
  `examples/retrieval-host/` integration and correctly rejects both references
  to and files under the canonical `~/.agent-knowledge/proposals/` state tree.
  It supersedes 0.1.1's incorrect legacy-path matcher; policy semantics remain
  unchanged.

### Removed

- The legacy third-party CLI retrieval adapter, its compatibility schema pack,
  graph-sync scripts, import-walker patching and runtime configuration surface.
- The previous shared state directory name and external-backend terminology
  from current installation and operations documentation.

## [0.1.0] - 2026-08-23

First catalogued release.

### Added

- `lab-ontology` — the agent knowledge system: Obsidian vault skeleton, `agent-knowledge` MCP gateway (package 1.6.0, 13 `knowledge_*` tools), schema pack `agent-decision-memory` 1.1.1, Vault validator and legacy derived-index guards, with module README, architecture and setup docs.
- `lab-context-distillation-wx` — deterministic local pipeline for evidence-bounded personal context from WeChat 4.x data (module v2.0.1; renamed from `lab-context-distillation`).
- `lab-life-reviewer` — interview-led life review with Raw/handoff artifacts (renamed from `life-review`).
- `lab-knowledge-retrospective` — distils finished work into evidence-bounded conclusions.
- `lab-knowledge-intake` — proposal-gated entry point into the knowledge base.
- Root catalog README with overview diagram, per-module status, `CONTRIBUTING.md`, `tests/` layout and public-boundary tests, single CI workflow.

### Changed

- Repository-wide license is now PolyForm Noncommercial License 1.0.0; module `LICENSE.md` files point to the root.
- `lab-ontology` reads smoke-test cases from `smoke-cases.json`; its first public version used a separately installed CLI retrieval backend that has since been replaced by the Native 1.8.0 implementation.

### Removed

- `docs/superpowers/` planning records at the root and inside the wx module.
