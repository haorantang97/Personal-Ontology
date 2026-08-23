# Import Lab Context Distillation Implementation Plan

> Historical implementation record: the paths and public name below describe the original import. The current installable name is `lab-context-distillation-wx`; use the root catalog and module README for current commands.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Personal-Ontology catalog and import the committed public distillation product as the self-contained `lab-context-distillation` Skill.

**Architecture:** Keep discovery at the repository root and all executable behavior inside `skills/lab-context-distillation/`. Import the exact tracked source tree from commit `b29b3d2`, then change only public packaging entrypoints while retaining the stable internal Python namespace and immutable historical artifacts.

**Tech Stack:** Markdown, Agent Skills `SKILL.md`, Python 3 standard library, `unittest`, Git.

---

### Task 1: Lock repository layout in a failing test

**Files:**
- Create: `tests/test_repository_layout.py`

- [ ] **Step 1: Write the repository contract test**

```python
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills" / "lab-context-distillation"


class RepositoryLayoutTests(unittest.TestCase):
    def test_root_catalog_points_to_canonical_skill(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("skills/lab-context-distillation/README.md", readme)

    def test_skill_entrypoints_use_public_name(self):
        skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        agent = (SKILL / "agents" / "openai.yaml").read_text(encoding="utf-8")
        self.assertRegex(skill, r"(?m)^name: lab-context-distillation$")
        self.assertIn("$lab-context-distillation", agent)

    def test_module_has_human_installation_manual(self):
        readme = (SKILL / "README.md").read_text(encoding="utf-8")
        for heading in ("Codex", "Claude Code", "Verify", "Privacy", "Uninstall"):
            self.assertIn(heading, readme)

    def test_import_contains_no_nested_git_or_cache(self):
        forbidden = [path for path in SKILL.rglob("*") if path.name == ".git" or "__pycache__" in path.parts]
        self.assertEqual(forbidden, [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it and verify RED**

Run: `python3 -m unittest tests/test_repository_layout.py -v`

Expected: failure because `skills/lab-context-distillation/` and its public entrypoints do not exist.

### Task 2: Import the exact committed public snapshot

**Files:**
- Create: `skills/lab-context-distillation/**`

- [ ] **Step 1: Export only tracked files from source commit `b29b3d2`**

Run a Git archive of that commit and extract it into `skills/lab-context-distillation/`. Do not copy `.git`, ignored caches, local case directories, or uncommitted files.

- [ ] **Step 2: Confirm import provenance**

Run:

```bash
git -C "$SOURCE_REPO" status --short --branch
git -C "$SOURCE_REPO" rev-parse HEAD
```

`SOURCE_REPO` is the operator-supplied path to the standalone public clone selected for this migration; it is never persisted in the public repository.

Expected: clean `main` at `b29b3d2...`.

### Task 3: Add catalog and public packaging entrypoints

**Files:**
- Modify: `README.md`
- Create: `LICENSE.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `skills/lab-context-distillation/README.md`
- Create: `skills/lab-context-distillation/MIGRATION.md`
- Modify: `skills/lab-context-distillation/SKILL.md`
- Modify: `skills/lab-context-distillation/agents/openai.yaml`
- Modify: `skills/lab-context-distillation/LICENSE.md`
- Create: `.gitignore`

- [ ] **Step 1: Write the root catalog**

Keep the root short: repository purpose, one-row Skill catalog, shortest installation example, status legend, and repository-level licensing boundary.

- [ ] **Step 2: Write the module installation manual**

Document community installer, manual Codex/Claude Code locations, direct execution, Python/SQLCipher requirements, verification commands, upgrade/removal, privacy guarantees, field-validation limits, and troubleshooting.

- [ ] **Step 3: Rename only public product entrypoints**

Set the Skill frontmatter name and Agent default prompt to `lab-context-distillation`. Keep `personal_context_distillation` and `pcd.py` as stable internal compatibility identifiers. Do not rewrite immutable version or contract records.

- [ ] **Step 4: Re-run the repository test and verify GREEN**

Run: `python3 -m unittest tests/test_repository_layout.py -v`

Expected: four passing tests.

### Task 4: Verify the imported product and repository boundary

**Files:**
- Modify only if a verification failure exposes a packaging defect.

- [ ] **Step 1: Run all imported tests**

Run from `skills/lab-context-distillation/`:

```bash
PYTHONPATH=scripts python3 -m unittest discover -s tests -p 'test_*.py'
```

Expected: 150 tests, zero failures.

- [ ] **Step 2: Validate code, Skill, contract, and CLI**

Run:

```bash
python3 -m compileall -q scripts
python3 "$SKILL_CREATOR_ROOT/scripts/quick_validate.py" .
python3 scripts/pcd.py contract-validate contracts/real-distillation-v2
python3 scripts/pcd.py --help
```

Expected: compilation success, valid Skill, contract bundle `e2f27026522d8c5a78c20f4d8744bc997611d84f49a91e85c23c0ce376588500`, and CLI help exit zero.

`SKILL_CREATOR_ROOT` is the operator-supplied directory of the locally installed `skill-creator` package and is not stored in the repository.

- [ ] **Step 3: Check repository diff and public content**

Run from the repository root:

```bash
python3 -m unittest tests/test_repository_layout.py -v
git diff --check
git status --short
```

Expected: repository tests pass, no whitespace errors, and only intended migration files are changed.

### Task 5: Freeze the clean import commit

**Files:**
- Commit all reviewed files in the target repository only.

- [ ] **Step 1: Review the staged file list and diff summary**

Run: `git diff --stat` and `git status --short`.

- [ ] **Step 2: Create one clean import commit**

Commit message: `feat: add lab context distillation skill`.

- [ ] **Step 3: Verify the committed tree**

Run: `git status --short --branch` and `git log -2 --oneline --decorate`.

Expected: clean feature branch with one new import commit above the repository initialization commit.
