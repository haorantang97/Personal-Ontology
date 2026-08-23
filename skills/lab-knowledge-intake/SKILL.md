---
name: lab-knowledge-intake
description: Use whenever the user says 录入知识库、导入知识库、保存到知识库、沉淀到知识库, asks to add/update/merge/move/delete knowledge, or provides a link, attachment, text, or conversation to put into the user's Obsidian/GBrain knowledge base.
---

# Lab Knowledge Intake

1. Call the `agent-knowledge` MCP tool `knowledge_intake` first.
2. Treat its response as the sole current source of the vault location, schema, page routing, exclusions, approval rules, and synchronization workflow.
3. Follow that contract: search and inspect existing knowledge, deduplicate, then create an exact proposal.
4. Show the proposal to the user and wait for explicit approval before applying it.
5. Never write knowledge files directly or invent another destination.

If `agent-knowledge` or `knowledge_intake` is unavailable, state that the shared
knowledge gateway is unavailable. Do not guess the format or fall back to an
unmanaged Markdown file.
