---
name: lab-knowledge-intake
description: Use whenever the user says 录入知识库、导入知识库、保存到知识库、沉淀到知识库, asks to add/update/merge/move/delete knowledge, or provides a link, attachment, text, or conversation to put into the user's Obsidian/GBrain knowledge base.
---

# Lab Knowledge Intake

1. Call the `agent-knowledge` MCP tool `knowledge_intake` first.
2. Treat its response as the sole current source of the vault location, schema, page routing, exclusions, approval rules, and synchronization workflow. When available, also read `knowledge_schema` immediately before drafting and use its active machine contract for required fields and enums.
3. Search and inspect existing knowledge before drafting. For every updated target, read the exact current page; for a new page, inspect a current valid page of the same type. Deduplicate before deciding whether to create or update.
4. Draft complete target-file contents and run this proposal preflight before calling `knowledge_propose_changes`:
   - Preserve the page type's required `status`, `retrieval_scope`, required fields and allowed enum values. Do not put business lifecycle words such as `paused`, `failed` or `completed` into a Schema field unless the active contract explicitly allows them; otherwise record that state in the Project body and evidence metadata.
   - Serialize every frontmatter list in the exact representation accepted by the current vault. Generic YAML validity is not enough; if the current validator or inspected pages use inline lists, do not emit block lists.
   - Keep every Source `derived_pages` link and Result `evidence` link reciprocal in the same proposal, including relationships to existing pages.
   - Preserve current facts and unrelated content; a proposal must contain the complete intended files, not fragments or patches.
5. Only present a proposal after `knowledge_propose_changes` returns success. Show the exact files and substantive changes, then wait for explicit approval before applying it.
6. If proposal creation or approved apply is rejected by validation, state that no knowledge write occurred, inspect the reported current contract, and create a new exact proposal. Approval of the rejected proposal never transfers to the replacement.
7. Never write knowledge files directly or invent another destination.

If `agent-knowledge` or `knowledge_intake` is unavailable, state that the shared
knowledge gateway is unavailable. Do not guess the format or fall back to an
unmanaged Markdown file.
