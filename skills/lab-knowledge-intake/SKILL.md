---
name: lab-knowledge-intake
description: Use whenever the user says 录入知识库、导入知识库、保存到知识库、沉淀到知识库, asks to add/update/merge/move/delete knowledge, or provides a link, attachment, text, or conversation to put into the user's schema-governed Markdown/Obsidian knowledge base through Agent Knowledge.
---

# Lab Knowledge Intake

1. Call the `agent-knowledge` MCP tool `knowledge_intake` first.
2. Treat its response as the sole current source of the vault location, schema, page routing, exclusions, approval rules, and synchronization workflow. When available, also read `knowledge_schema` immediately before drafting and use its active machine contract for required fields and enums.
3. Search and inspect existing knowledge before drafting. For every updated target, read the exact current page; for a new page, inspect a current valid page of the same type. Deduplicate before deciding whether to create or update.
4. Draft complete target-file contents, then call `knowledge_propose_changes`; the gateway runs the exact candidate tree through its full preflight before it creates a pending proposal:
   - Preserve the page type's required `status`, `retrieval_scope`, required fields and allowed enum values. Do not put business lifecycle words such as `paused`, `failed` or `completed` into generic `status`. Use optional `project_status` for Project lifecycle (`active`, `paused`, `completed`, `cancelled`, `archived`) when the active contract supports it; otherwise record that state in the Project body and evidence metadata.
   - Frontmatter lists may use YAML flow form (inline lists such as `[]`) or ordinary block form (`- item`). Generic YAML validity is not enough: stay within the strict subset reported by the gateway and do not emit unsupported mappings, anchors, or tags. Do not change content semantics merely to satisfy formatting.
   - Treat `agent_priority` as retrieval priority and `maturity` as evidence strength. They are independent; a high-priority seed remains limited to seed-safe uses.
   - Keep every Source `derived_pages` link and Result `evidence` link reciprocal in the same proposal, including relationships to existing pages.
   - Preserve current facts and unrelated content; a proposal must contain the complete intended files, not fragments or patches.
5. Only present a proposal after `knowledge_propose_changes` returns success. Show the exact files and substantive changes, then wait for explicit approval before applying it.
6. If proposal preflight fails, state that no pending proposal was created and state that no knowledge write occurred; use the returned `error_code`, `stage` and validator output, then correct the candidate. If approved apply later fails, state that no successful apply occurred and inspect the returned receipt. Approval of the rejected proposal never transfers to the replacement.
7. Never write knowledge files directly or invent another destination.

If `agent-knowledge` or `knowledge_intake` is unavailable, state that the shared
knowledge gateway is unavailable. Do not guess the format or fall back to an
unmanaged Markdown file.
