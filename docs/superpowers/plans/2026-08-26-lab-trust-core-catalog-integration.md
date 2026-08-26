# Lab Trust Core Catalog Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `lab-trust-core` as a top-level, independently installable Trust Core in Personal-Ontology, display it after `lab-ontology` and before the four Skills, and introduce no premature `modules/` category.

**Architecture:** `lab-trust-core/` is a self-contained TypeScript package with SDK, CLI, read-only MCP, schemas, examples, tests and an MIT license. It remains independent from `lab-ontology`; the root catalogue presents one complete system, one Trust Core and four Skills without making either core a dependency. Root layout tests and CI enforce the package boundary, branding, licensing and Node 20/24 verification.

**Tech Stack:** TypeScript, Node.js 20/24, npm, Python `unittest`, GitHub Actions, Markdown, JSON Schema.

---

## File map

- Create `lab-trust-core/`: standalone package copied from the already verified public implementation and renamed consistently.
- Create `tests/test_lab_trust_core_layout.py`: repository-level contract for placement, package identity, independence, catalogue, license and CI.
- Modify `README.md`: Chinese catalogue, architecture, status, installation and license exception.
- Modify `README.en.md`: English parity for the same catalogue contract.
- Modify `LICENSE.md`: declare that `lab-trust-core/` is governed by its own MIT license.
- Modify `THIRD_PARTY_NOTICES.md`: add the new top-level Trust Core.
- Modify `CHANGELOG.md`: record the new public component.
- Modify `.github/workflows/ci.yml`: run `lab-trust-core` verification on Node 20 and 24.
- Create `.github/workflows/release-lab-trust-core.yml`: build a standalone `.tgz` for `lab-trust-core-v*` tags.

### Task 1: Establish the top-level standalone package contract

**Files:**
- Create: `tests/test_lab_trust_core_layout.py`
- Create: `lab-trust-core/**`

- [ ] **Step 1: Write the failing layout and identity tests**

Create `tests/test_lab_trust_core_layout.py` with:

```python
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "lab-trust-core"


class LabTrustCoreLayoutTests(unittest.TestCase):
    def test_core_is_top_level_and_self_contained(self):
        self.assertTrue(CORE.is_dir())
        for filename in (
            "README.md",
            "LICENSE",
            "SECURITY.md",
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "src/index.ts",
            "src/mcp/server.ts",
            "schemas/knowledge-record.schema.json",
            "test/end-to-end.test.ts",
        ):
            self.assertTrue((CORE / filename).is_file(), filename)

    def test_public_identity_is_lab_trust_core(self):
        package = json.loads((CORE / "package.json").read_text(encoding="utf-8"))
        source = (CORE / "src" / "index.ts").read_text(encoding="utf-8")
        mcp = (CORE / "src" / "mcp" / "server.ts").read_text(encoding="utf-8")
        self.assertEqual(package["name"], "lab-trust-core")
        self.assertIn('PACKAGE_ID = "lab-trust-core"', source)
        self.assertIn('name: "lab-trust-core"', mcp)

    def test_package_has_no_lab_ontology_runtime_dependency(self):
        package = json.loads((CORE / "package.json").read_text(encoding="utf-8"))
        dependencies = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
        self.assertFalse(any(value.startswith(("file:", "workspace:")) for value in dependencies.values()))
        for path in (CORE / "src").rglob("*.ts"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("lab-ontology", text, path)
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
python3 -m unittest tests.test_lab_trust_core_layout -v
```

Expected: failure because `lab-trust-core/` does not exist.

- [ ] **Step 3: Copy the verified public implementation without repository metadata**

Run:

```bash
trust_source_dir="$(mktemp -d)/knowledge-trust-core"
git clone --depth 1 https://github.com/haorantang97/knowledge-trust-core.git "$trust_source_dir"
rsync -a \
  --exclude '.git/' \
  --exclude '.github/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude '*.tgz' \
  "$trust_source_dir/" lab-trust-core/
```

- [ ] **Step 4: Rename public package identity consistently**

Apply these mechanical replacements inside `lab-trust-core/`:

```text
knowledge-trust-core                    → lab-trust-core
Knowledge Trust Core                    → Lab Trust Core
KNOWLEDGE_TRUST_ALLOWED_ROOTS           → LAB_TRUST_ALLOWED_ROOTS
https://knowledge-trust-core.dev        → https://raw.githubusercontent.com/haorantang97/Personal-Ontology/main/lab-trust-core
```

Set the package repository metadata to:

```json
"repository": {
  "type": "git",
  "url": "git+https://github.com/haorantang97/Personal-Ontology.git",
  "directory": "lab-trust-core"
},
"homepage": "https://github.com/haorantang97/Personal-Ontology/tree/main/lab-trust-core#readme",
"bugs": {
  "url": "https://github.com/haorantang97/Personal-Ontology/issues"
}
```

Replace the clone section in `lab-trust-core/README.md` with the exact sparse-checkout path:

```bash
git clone --filter=blob:none --no-checkout https://github.com/haorantang97/Personal-Ontology.git
cd Personal-Ontology
git sparse-checkout init --cone
git sparse-checkout set lab-trust-core
git checkout main
cd lab-trust-core
npm ci
npm run verify
```

Regenerate identity-bearing artifacts:

```bash
cd lab-trust-core
npm install --package-lock-only
npm run build
```

- [ ] **Step 5: Verify GREEN and standalone package behavior**

Run:

```bash
python3 -m unittest tests.test_lab_trust_core_layout -v
cd lab-trust-core && npm ci && npm run verify
```

Expected: three layout tests pass; the package reports 50 passing tests, successful typecheck/build/privacy scan and package dry run.

- [ ] **Step 6: Commit the standalone Trust Core**

```bash
git add tests/test_lab_trust_core_layout.py lab-trust-core
git commit -m "feat: add standalone lab trust core"
```

### Task 2: Close the catalogue, license and documentation loop

**Files:**
- Modify: `tests/test_lab_trust_core_layout.py`
- Modify: `README.md`
- Modify: `README.en.md`
- Modify: `LICENSE.md`
- Create: `lab-trust-core/THIRD_PARTY_NOTICES.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add failing catalogue and license tests**

Append these methods to `LabTrustCoreLayoutTests`:

```python
    def test_bilingual_catalogues_show_two_cores_and_four_skills(self):
        for filename in ("README.md", "README.en.md"):
            readme = (ROOT / filename).read_text(encoding="utf-8")
            self.assertIn("lab-trust-core/README.md", readme, filename)
            self.assertIn("lab-ontology/README.md", readme, filename)
            for skill in (
                "lab-context-distillation-wx",
                "lab-life-reviewer",
                "lab-knowledge-retrospective",
                "lab-knowledge-intake",
            ):
                self.assertIn(f"skills/{skill}/README.md", readme, filename)

    def test_mit_license_exception_is_explicit(self):
        core_license = (CORE / "LICENSE").read_text(encoding="utf-8")
        root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
        english_readme = (ROOT / "README.en.md").read_text(encoding="utf-8")
        root_license = (ROOT / "LICENSE.md").read_text(encoding="utf-8")
        notices = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
        self.assertIn("MIT License", core_license)
        self.assertIn("lab-trust-core", root_readme)
        self.assertIn("MIT", root_readme)
        self.assertIn("lab-trust-core", english_readme)
        self.assertIn("MIT", english_readme)
        self.assertIn("lab-trust-core/", root_license)
        self.assertIn("MIT License", root_license)
        self.assertIn("lab-trust-core/THIRD_PARTY_NOTICES.md", notices)
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
python3 -m unittest tests.test_lab_trust_core_layout -v
```

Expected: failures because the root catalogues and notices do not yet list `lab-trust-core` or its MIT exception.

- [ ] **Step 3: Update both root catalogues**

Make the Chinese and English introductions state “one complete system, one Trust Core and four Skills.” Add `lab-trust-core` after `lab-ontology` and before the Skills in each catalogue and Mermaid overview, but not inside the `lab-ontology` subgraph. Do not create a `modules/` category. Add a dedicated Trust Core section with this boundary:

```markdown
`lab-trust-core` receives a knowledge record plus an intended use and returns an explainable trust verdict. It does not store, retrieve or write knowledge, and it does not require `lab-ontology`; use its SDK, CLI or read-only MCP in any RAG, knowledge base or agent runtime.
```

Add it to the status table with “50 tests; Node 20/24; privacy and package verification.” Add sparse-checkout installation commands. Preserve all four existing Skill rows and links.

- [ ] **Step 4: Add license and third-party notices**

Create `lab-trust-core/THIRD_PARTY_NOTICES.md` listing direct runtime dependencies `@modelcontextprotocol/sdk` and `zod`, and direct development dependencies `typescript`, `tsx` and `@types/node`, with their upstream package links and licenses.

Add this explicit exception to both root license sections:

```markdown
Exception: `lab-trust-core/` is independently licensed under the MIT License in `lab-trust-core/LICENSE`; the repository-root PolyForm Noncommercial terms do not replace that Trust Core license.
```

Prepend this scope notice to `LICENSE.md`, before the PolyForm terms:

```markdown
## License scope

The `lab-trust-core/` directory is licensed separately under the MIT License in `lab-trust-core/LICENSE`. The PolyForm Noncommercial License below applies to the remainder of this repository and does not replace the license for that directory.
```

Add `lab-trust-core/THIRD_PARTY_NOTICES.md` to the root notices list and record the Trust Core addition in `CHANGELOG.md` under an unreleased section.

- [ ] **Step 5: Verify GREEN**

Run:

```bash
python3 -m unittest tests.test_lab_trust_core_layout -v
python3 -m unittest discover -s tests -p 'test_*.py'
```

Expected: all repository layout and package tests pass.

- [ ] **Step 6: Commit the catalogue closure**

```bash
git add README.md README.en.md LICENSE.md THIRD_PARTY_NOTICES.md CHANGELOG.md lab-trust-core/THIRD_PARTY_NOTICES.md tests/test_lab_trust_core_layout.py
git commit -m "docs: catalogue lab trust core"
```

### Task 3: Enforce Trust Core verification and release packaging in CI

**Files:**
- Modify: `tests/test_lab_trust_core_layout.py`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-lab-trust-core.yml`

- [ ] **Step 1: Add the failing workflow contract test**

Append:

```python
    def test_ci_verifies_and_packages_the_core(self):
        ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        release = (ROOT / ".github" / "workflows" / "release-lab-trust-core.yml").read_text(encoding="utf-8")
        self.assertIn("lab-trust-core:", ci)
        self.assertIn("node-version: [20, 24]", ci)
        self.assertIn("working-directory: lab-trust-core", ci)
        self.assertIn("npm run verify", ci)
        self.assertIn("lab-trust-core-v*", release)
        self.assertIn("npm pack --silent", release)
        self.assertIn("gh release create", release)
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
python3 -m unittest tests.test_lab_trust_core_layout.LabTrustCoreLayoutTests.test_ci_verifies_and_packages_the_core -v
```

Expected: error because the release workflow is missing.

- [ ] **Step 3: Add the Node 20/24 CI job**

Append this job to `.github/workflows/ci.yml`:

```yaml
  lab-trust-core:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20, 24]
    defaults:
      run:
        working-directory: lab-trust-core
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
          cache-dependency-path: lab-trust-core/package-lock.json
      - name: Install dependencies
        run: npm ci
      - name: Verify SDK, CLI, MCP, privacy and package
        run: npm run verify
```

- [ ] **Step 4: Add the tag-driven release workflow**

Create `.github/workflows/release-lab-trust-core.yml`:

```yaml
name: Release Lab Trust Core

on:
  push:
    tags:
      - "lab-trust-core-v*"

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: lab-trust-core
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: lab-trust-core/package-lock.json
      - run: npm ci
      - run: npm run verify
      - id: pack
        run: echo "artifact=$(npm pack --silent)" >> "$GITHUB_OUTPUT"
      - name: Publish standalone package asset
        env:
          GH_TOKEN: ${{ github.token }}
        run: >-
          gh release create "$GITHUB_REF_NAME"
          "${{ steps.pack.outputs.artifact }}"
          --title "Lab Trust Core ${GITHUB_REF_NAME#lab-trust-core-v}"
          --generate-notes
```

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
python3 -m unittest tests.test_lab_trust_core_layout -v
```

Expected: all tests in the Trust Core layout suite pass.

Commit:

```bash
git add .github/workflows/ci.yml .github/workflows/release-lab-trust-core.yml tests/test_lab_trust_core_layout.py
git commit -m "ci: verify and package lab trust core"
```

### Task 4: Full local verification and publication

**Files:**
- Verify all files changed above.

- [ ] **Step 1: Run complete root and Trust Core verification**

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
cd lab-trust-core && npm ci && npm run verify
```

Expected: all root tests pass; Lab Trust Core reports 50 passing tests and successful typecheck/build/privacy/package checks.

- [ ] **Step 2: Verify true isolated installation**

```bash
trust_isolation_dir="$(mktemp -d)"
cp -R lab-trust-core "$trust_isolation_dir/lab-trust-core"
cd "$trust_isolation_dir/lab-trust-core"
npm ci
npm run verify
```

Expected: exit code 0 without any `lab-ontology` or root-repository files.

- [ ] **Step 3: Audit public boundary and Git diff**

```bash
git diff --check
git status --short
git grep -nE '/Users/[^/[:space:]]+/|\.gbrain/change-proposals|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY' -- ':!docs/superpowers/specs' ':!docs/superpowers/plans'
```

Expected: no whitespace errors, no unexpected files, and no private marker in the shipped Trust Core or public documentation.

- [ ] **Step 4: Merge the implementation branch and push the main repository**

Fast-forward the verified implementation branch into local `main`, push `main`, and verify the remote SHA equals the local SHA. Do not delete, archive or modify the existing `knowledge-trust-core` repository in this task.

- [ ] **Step 5: Publish the standalone release artifact**

After the main CI succeeds, create and push tag `lab-trust-core-v0.1.0`. Verify that the tag workflow creates a GitHub Release containing `lab-trust-core-0.1.0.tgz` and that both Node matrix jobs remain green.
