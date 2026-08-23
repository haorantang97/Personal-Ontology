# Lab Context Distillation

`lab-context-distillation` is a provider-neutral Agent Skill and deterministic local pipeline for turning user-approved WeChat 4.x or standard conversation exports into evidence-bounded personal context.

It is not prompt-only. The directory contains the Skill entrypoint, Python controller, platform connectors, immutable contracts, synthetic fixtures, tests, privacy rules, validation gates, and portable runtime packaging.

Current truth: the executable paths are verified with synthetic/public fixtures. Compatibility with a particular real macOS or Windows WeChat build is not claimed until that build passes the field checklist. See [STATUS.md](STATUS.md) and the [feature matrix](docs/feature-implementation-matrix.md).

## Installation

Install or copy this whole directory. Installing only `SKILL.md` removes the deterministic pipeline and is unsupported.

### Community Agent Skills installer

From the repository URL:

```bash
npx skills add haorantang97/Personal-Ontology --skill lab-context-distillation
```

Review the files and the installer's behavior before granting it access to a private environment. This project does not require the community installer at runtime.

### Codex

For one project, copy the complete directory to:

```text
<project>/.agents/skills/lab-context-distillation/
```

For the current user, copy it to:

```text
~/.agents/skills/lab-context-distillation/
```

Restart or reload Codex after installation, then invoke `$lab-context-distillation` or make a matching request such as “蒸馏这批已经脱敏的微信聊天”。

### Claude Code

For one project, copy the complete directory to:

```text
<project>/.claude/skills/lab-context-distillation/
```

For the current user, copy it to:

```text
~/.claude/skills/lab-context-distillation/
```

Reload Claude Code and invoke the Skill by name. The same `SKILL.md`, scripts, contracts, and tests are used; there is no separate Claude implementation.

### Direct repository use

An Agent installation is optional. Clone the repository, enter this directory, and run:

```bash
python3 scripts/pcd.py --help
python3 scripts/pcd.py contract-validate contracts/real-distillation-v2
```

## Requirements

- Python 3.12 is the verified runtime for the current release. The core pipeline uses the Python standard library.
- Read access to a user-approved local source or lawful decrypted export.
- SQLCipher only for the optional authorized encrypted-database path. It is not bundled; review its own license before installing it.
- Enough local disk space for read-only, WAL-consistent snapshots and immutable releases.

No model vendor, model name, Fast mode, or fixed agent count is required by the Skill.

## Verify

Run from this directory:

```bash
PYTHONPATH=scripts python3 -m unittest discover -s tests -p 'test_*.py'
python3 -m compileall -q scripts
python3 scripts/pcd.py contract-validate contracts/real-distillation-v2
python3 scripts/pcd.py --help
```

The contract command must report bundle SHA-256:

```text
e2f27026522d8c5a78c20f4d8744bc997611d84f49a91e85c23c0ce376588500
```

For Agent Skill structure validation:

```bash
python3 /path/to/skill-creator/scripts/quick_validate.py .
```

## First safe run

Keep every case outside the installed Skill directory:

```bash
python3 scripts/pcd.py init /path/to/case
python3 scripts/pcd.py authorize /path/to/case new_source --note "user approved this source"
```

Continue with the commands in [SKILL.md](SKILL.md). The controller separates local collection and validation from model processing. An analysis request authorizes processing data already redacted for the current task; it does not authorize a new source, unredacted transfer, local-key access, or knowledge-base writing.

## Privacy

- Raw databases, keys, private identity mappings, and unredacted normalized records stay local and must never be sent to a model.
- Local-key access requires a separate explicit authorization. Keys are accepted only from a private mode-0600 file and are never placed in command arguments.
- The public Skill does not implement process-memory key extraction, injection, re-signing, or proprietary native key derivation.
- Knowledge-base approval creates a receipt only. An external write remains a separate, explicitly authorized action.
- Synthetic tests contain no real chats, identities, keys, or private receipts.

Read [privacy-and-authorization.md](references/privacy-and-authorization.md) before handling a source and [platform-connectors.md](references/platform-connectors.md) before touching WeChat data.

## Upgrade

Replace the installed module only with a reviewed newer release. Do not overwrite case directories or immutable releases. Before resuming a case, validate the new contract bundle and use the explicit profile update/re-extraction state machine; accepted Map generations are not rerun automatically.

Historical release manifests under `versions/` remain read-only. They preserve the standalone project's earlier identifiers and hashes for provenance.

## Uninstall

Remove only the installed `lab-context-distillation` directory from the Agent skills location. Case directories live elsewhere by design and are not deleted automatically. Review and remove those separately only when you intentionally want to destroy the local data.

## Troubleshooting

- **Skill is not discovered:** confirm the folder is named `lab-context-distillation`, contains `SKILL.md` at its top level, and reload the Agent.
- **Contract validation fails:** stop. Restore the exact release files instead of editing a sealed contract or its manifest.
- **SQLCipher is missing:** use a lawful plaintext export, or install and license SQLCipher separately. Do not bypass the key authorization gate.
- **A WeChat schema is unknown:** preserve the snapshot, report the schema fingerprint as unsupported, and use a lawful export. Do not guess a mapping.
- **A model result fails validation:** classify infrastructure, structure, content, privacy, and dependency failures separately. Deterministic repair may change structure only when narrative and evidence are invariant.

## License

The module is publicly viewable and available for personal noncommercial use under the draft [LICENSE.md](LICENSE.md). Commercial use, enterprise deployment, customer delivery, redistribution, and repackaging require written authorization. Lawyer review is required before public release.

## Provenance

This module was imported as a clean snapshot from the standalone public project. See [MIGRATION.md](MIGRATION.md) and [CLEAN_ROOM.md](CLEAN_ROOM.md). No standalone Git metadata or private source workspace is part of this module.
