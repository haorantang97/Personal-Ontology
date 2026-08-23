# Migration Provenance

The Skill now published as `lab-context-distillation-wx` entered `Personal-Ontology` as a clean archive of standalone commit:

```text
b29b3d2cb5d71079fb217257396f47f8f9ba83ae
```

The archive included only files tracked by that commit. It excluded the standalone `.git` directory, ignored bytecode caches, local case work, private data, and uncommitted state.

The public Skill directory and Agent entrypoint were first renamed from `personal-context-distillation` to `lab-context-distillation`, then narrowed to the WeChat-focused public name `lab-context-distillation-wx`. The Python package `personal_context_distillation` and the `pcd.py` command remain stable internal compatibility identifiers. Frozen contracts, version manifests, design records, and verification records remain immutable historical evidence and may retain either earlier name.

This migration changes packaging and discovery. It does not expand field-validation claims, alter immutable contract hashes, or prove compatibility with any real WeChat build.
