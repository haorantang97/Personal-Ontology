# Personal-Ontology / 个人本体

Original, evidence-aware skills for building and maintaining personal context with AI agents.

用于通过 AI Agent 建立和维护个人上下文的原创、证据边界明确的 Skills。

## Published skills / 已发布 Skills

### Life Review / 人生回顾

`skills/life-review/`

A two-stage workflow inside one skill:

1. interview and related-material collection;
2. light cleaning, evidence-aware distillation, and approved knowledge archival.

一个 Skill 内的双环节工作流：

1. 采访与当前主题相关材料采集；
2. 轻度清洗、有证据边界的蒸馏，以及经用户批准后的知识归档。

The two stages are designed to run in separate Codex tasks/windows and communicate through detailed Raw and handoff artifacts. Live voice and text are two modes within the interview stage, not separate skills.

两个环节分别运行在独立的 Codex 任务/窗口中，通过详细 Raw 与 handoff 交接。Live 语音和纯文字是采访环节内部的两种模式，不是独立 Skills。

## Install / 安装

Copy the skill directory into the local Codex skills folder:

把 Skill 目录复制到本地 Codex Skills 目录：

```bash
cp -R skills/life-review ~/.codex/skills/life-review
```

Invoke it as `$life-review`, or let Codex select it automatically when the request matches its description.

可以使用 `$life-review` 显式调用；当请求符合描述时，也允许 Codex 自动选择。

## Repository policy / 仓库原则

- Publish reusable workflow instructions, schemas, and boundaries—not private interview content.
- Keep Raw interviews and personal evidence outside skill packages.
- Preserve user approval gates for any knowledge-base mutation.
- Add skills explicitly and incrementally.

- 只发布可复用的流程说明、格式和边界，不发布私人采访内容。
- Raw 访谈和个人证据必须保存在 Skill 包之外。
- 任何知识库写入都必须保留用户审批门。
- Skill 采用明确、渐进的方式逐个加入。
