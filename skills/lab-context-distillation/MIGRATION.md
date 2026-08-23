# Migration Provenance

`lab-context-distillation` entered `Personal-Ontology` as a clean archive of standalone commit:

```text
b29b3d2cb5d71079fb217257396f47f8f9ba83ae
```

The archive included only files tracked by that commit. It excluded the standalone `.git` directory, ignored bytecode caches, local case work, private data, and uncommitted state.

The public Skill directory and Agent entrypoint were renamed from `personal-context-distillation` to `lab-context-distillation`. The Python package `personal_context_distillation` and the `pcd.py` command remain stable internal compatibility identifiers. Frozen contracts, version manifests, design records, and verification records remain immutable historical evidence and may retain the earlier name.

This migration changes packaging and discovery. It does not expand field-validation claims, alter immutable contract hashes, or prove compatibility with any real WeChat build.
