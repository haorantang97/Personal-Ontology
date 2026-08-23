# Personal-Ontology Skill Catalog Design

## Goal

Turn `Personal-Ontology` into the public catalog for the author's original personal-ontology Skills, with the existing WeChat/personal-context distillation product imported as the first self-contained module named `lab-context-distillation`.

## Decisions already approved

- The repository root is a concise introduction and index, not a second copy of a Skill manual.
- Every substantial Skill is self-contained under `skills/<skill-name>/`.
- `lab-context-distillation` has one provider-neutral `SKILL.md`; Codex, Claude Code, and generic Agent installation instructions do not fork the implementation.
- The module is a complete repository product—deterministic Python pipeline, contracts, references, fixtures, tests, and legal notices—not a prompt-only artifact.
- The old standalone repository remains untouched. The import is a clean snapshot of its committed public tree, without its `.git` history, caches, private work, or runtime state.
- The public Skill is renamed to `lab-context-distillation`. Its internal Python package and `pcd.py` CLI remain stable to avoid an unrelated compatibility migration.
- Frozen historical manifests and verification records remain immutable and may retain their earlier product identifier. New entrypoints explain that provenance explicitly.
- Nothing is pushed, globally installed, published, or written to a knowledge base in this migration.

## Repository architecture

```text
Personal-Ontology/
├── README.md
├── LICENSE.md
├── THIRD_PARTY_NOTICES.md
├── docs/superpowers/
├── tests/test_repository_layout.py
└── skills/
    └── lab-context-distillation/
        ├── README.md
        ├── SKILL.md
        ├── agents/openai.yaml
        ├── scripts/
        ├── contracts/
        ├── references/
        ├── docs/
        ├── evaluations/
        ├── tests/
        ├── fixtures (under tests/)
        ├── versions/
        ├── LICENSE.md
        └── THIRD_PARTY_NOTICES.md
```

The root catalog owns discovery. The module README owns human installation, prerequisites, verification, privacy, upgrade, removal, limitations, and troubleshooting. `SKILL.md` owns Agent routing, authorization gates, deterministic commands, and selective reference loading.

## Import and provenance

The source snapshot is the committed tree at `b29b3d2` from the standalone public repository. Importing by Git archive makes the boundary mechanical: only tracked files from that commit enter the module. The old repository is not used as a submodule and no source remote is required at runtime.

The migration adds a repository-level provenance note naming the source commit and stating which identifiers intentionally remain stable. It does not claim that synthetic fixtures establish real-device WeChat compatibility.

## Installation model

The root README provides catalog links and a short community-installer example. The module README is authoritative and supports:

1. a community Agent Skills installer;
2. a manual Codex installation into a project or user skills directory;
3. a manual Claude Code installation into a project or user skills directory;
4. direct repository execution without installing the Skill.

The pipeline uses Python's standard library. SQLCipher is optional, separately installed, and only used after explicit local-key authorization. The installation docs never ask users to transmit a database, key, identity map, or unredacted source to a model.

## Error and safety behavior

- Missing Python or an invalid contract fails during verification before any case is initialized.
- Missing SQLCipher disables only the optional encrypted-database path; lawful plaintext exports remain usable.
- Installation never performs key acquisition, model calls, knowledge-base writes, or source discovery.
- The imported public-boundary tests continue scanning for private paths, private keys, source-task identifiers, non-synthetic WeChat IDs, vendor bindings, and enabled Fast mode.

## Testing and acceptance

The migration is accepted only when all of the following pass from the imported Skill directory:

- repository-layout tests for catalog links, canonical naming, and forbidden nested repository/cache content;
- the imported Python unit-test suite;
- Python bytecode compilation;
- Skill Creator `quick_validate.py`;
- frozen contract validation and expected bundle hash;
- CLI help loading;
- `git diff --check` and a final clean public-boundary scan.

Real-device compatibility remains field-validation work and is not upgraded by this repository migration.
