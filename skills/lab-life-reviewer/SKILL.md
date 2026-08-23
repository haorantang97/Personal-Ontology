---
name: lab-life-reviewer
description: "Use when a user wants a long-running personal life review, autobiographical interview, life-event reconstruction from related materials, detailed handoff, or approved transfer into long-term personal context. / 用于长期人生回顾、个人经历访谈、结合相关材料还原事件、生成详细交接包，以及经批准后写入长期个人上下文。"
---

# Lab Life Reviewer / 人生回顾

Build a detailed, traceable account of the user's life one event at a time, then transfer completed material into long-term personal context without flattening it into a short timeline or turning interpretation into fact.

逐个事件建立细致、可追溯、可纠正的人生记录，再把已完成材料转入长期个人上下文；不得把复杂经历压缩成简短时间线，也不得把解释写成事实。

## Language routing / 语言路由

- For a primarily Chinese conversation, read the relevant `*.zh-CN.md` references and respond in Chinese.
- For a primarily English conversation, read the unsuffixed English references and respond in English.
- For another language, use the English references and answer in the user's language when possible.
- Do not load both language editions unless translation or cross-language comparison is requested.

- 中文对话读取对应的 `*.zh-CN.md` 参考文件，并使用中文回答。
- 英文对话读取无语言后缀的英文参考文件，并使用英文回答。
- 其他语言默认读取英文参考文件，并尽可能使用用户的语言回答。
- 除非用户要求翻译或跨语言核对，否则不要同时加载两套语言文件。

## One skill, two task stages / 一个 Skill，两个任务环节

Use this single skill in two separate Codex tasks/windows, in sequence:

1. **Interview task / 采访任务：** collect narration, inspect relevant materials, preserve Raw detail, and produce a structured handoff.
2. **Archive task / 归档任务：** consume the Raw/handoff and related materials, lightly clean and distill them, then propose knowledge-base changes.

The tasks are two stages of one workflow, not separate skills and not parallel accounts. The handoff artifact is the boundary; the archive task must not depend on remembering the interview chat.

两个任务是同一工作流的前后环节，不是两个 Skill，也不是两条并行叙事。交接包是任务边界；归档任务不能依赖对采访聊天的记忆。

If the user explicitly asks to initialize or create this workflow, use available task/thread tools to create or identify:

- `人生回顾｜采访与材料采集` / `Life Review | Interview & Materials`
- `人生回顾｜蒸馏与知识库归档` / `Life Review | Distillation & Archive`

Do not create tasks merely because the skill was loaded. Without explicit task-creation authorization, work in the current task and state which stage it serves.

仅当用户明确要求初始化或创建工作流时，才创建或识别上述两个任务。不能因为 Skill 被加载就自动新建任务；没有明确授权时，在当前任务中工作并说明当前环节。

## Select the current stage / 选择当前环节

- **Interview stage / 采访环节：** the user is narrating, answering, correcting a memory, supplying materials, or asking where to continue. Read `references/interview-stage.md` + `references/handoff-schema.md`, or their `.zh-CN.md` editions.
- **Archive stage / 归档环节：** the user asks to clean, distill, transfer, reconcile, propose, or write completed material into the knowledge base. Read `references/archive-stage.md` + `references/handoff-schema.md`, or their `.zh-CN.md` editions.
- If both are requested in one task, finish the current event and create the handoff before explicitly changing stages. Preserve the separation even when only one task is available.

## Shared invariants / 共同约束

- Work on one bounded event, project, period, or transition at a time while retaining the next event in the queue. Rich detail is welcome, but each event must eventually close.
- Use the universal term **current-topic materials / 当前主题相关材料**, not a document-specific assumption such as “portfolio / 作品集”. Materials may include documents, images, audio/video, project files, data, certificates, messages, timelines, or earlier notes.
- Inspect available relevant materials before asking questions they can answer. Ask the user mainly about intention, experience, interpretation, relationships, turning points, corrections, or conflicts that materials cannot establish. Do not require materials when none exist.
- Preserve corrections, uncertainty, contradictions, failures, hesitation, and counterexamples. Never invent dates, numbers, causal links, motives, roles, or narrative closure.
- Keep separate: first-person factual claims, feelings and self-explanations, external evidence, assistant summaries, AI hypotheses, and unresolved items.
- A team result is not automatically the user's contribution; sequence is not automatically causation; one story is not a stable personality or ability conclusion.
- Do not diagnose psychology, health, relationships, or third-party motives. Do not convert descriptions of a culture or group into universal claims about protected groups.
- Respect the strictest privacy and use restriction. Light cleaning never broadens authorization.
- Store interview outputs in the active workspace or another user-approved data location, never inside the skill folder.

## State and handoff / 状态与交接

Track the current period and event, last answer, corrections, unresolved facts, materials inspected or missing, stage status, and the next waiting event.

记录当前人生阶段与事件、最后一个回答、改口与未决事实、已检查或缺失的材料、当前环节状态，以及下一件等待采访的事件。

At an event boundary, produce a detailed Raw record and a structured handoff. The archive task must identify the last successfully handed-off or archived checkpoint, then cover everything after it without gaps or duplicate ingestion.

每个事件收束时，生成详细 Raw 与结构化 handoff。归档任务必须先确认上一次成功交接或归档的节点，再连续覆盖其后的内容，既不能漏掉，也不能重复录入。

Suggested filenames / 建议文件名：

```text
YYYY-MM-DD-life-review-NNN-<topic>-raw.md
YYYY-MM-DD-life-review-NNN-<topic>-handoff.md
```

The final update must state the current stage, produced artifact or proposal, location, unresolved items, and exact resume point.

最终回执必须说明：当前环节、生成的材料或提案、文件位置、仍未解决的问题，以及下次从哪里继续。
