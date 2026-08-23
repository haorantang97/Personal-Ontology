# Lab Knowledge Retrospective / 复盘蒸馏

`lab-knowledge-retrospective` 把一段已经结束的工作——任务、事故、访谈或长对话——蒸馏成可复用的结论，并按审批流程交给 [`lab-knowledge-intake`](../lab-knowledge-intake/README.md) 写入知识库。它的核心纪律：先取知识库里的当前方法再开始；把叙事和结论分开；每条结论带证据与样本量（`n=1` 就写 `n=1`）；默认产出为零，“本次无可沉淀结论”是正常结果。

本 Skill 是路由器，不是方法论。方法住在知识库的 `methods/` 页面里并持续更新，Skill 本身不更新。

## Installation

安装或复制完整目录。

### Community Agent Skills installer

```bash
npx skills add haorantang97/Personal-Ontology --skill lab-knowledge-retrospective
```

### Codex

项目级安装位置：

```text
<project>/.agents/skills/lab-knowledge-retrospective/
```

用户级安装位置：

```text
~/.agents/skills/lab-knowledge-retrospective/
```

重新加载 Codex 后调用 `$lab-knowledge-retrospective`，或在一件事做完后说“复盘一下”“这次有什么值得记下来的”。

### Claude Code

项目级安装位置：

```text
<project>/.claude/skills/lab-knowledge-retrospective/
```

用户级安装位置：

```text
~/.claude/skills/lab-knowledge-retrospective/
```

Codex 与 Claude Code 使用同一份 `SKILL.md`。

## Requirements

- `agent-knowledge` MCP 网关可用，见 [lab-ontology](../../lab-ontology/README.md)。
- 已安装 `lab-knowledge-intake`，用于把批准后的结论写入。
- `SKILL.md` 第 1 节列出的方法页入口只是示例；检索不到时 Skill 会明确说明“本次没有现成方法可依”并照常蒸馏。第 6 节提到的邻居 Skill（`gstack-*`、`dbs-*` 等）是可选的外部工具，不存在时只需忽略对应路由。

## Workflow

1. `knowledge_search` 检索并完整读取匹配本次事件类型的 method 页。
2. 把过程叙述与可迁移结论分开；换掉时间、地点、人物仍成立的才是结论。
3. 为每条结论标注依据、样本量与 `evidence_status`。
4. 按知识库 `AGENTS.md` 的合取门槛筛选；大多数复盘正确的结果是零新增。
5. 把活下来的结论列给用户，批准后交给 `lab-knowledge-intake` 走提案流程；提案前在 Vault 临时副本里跑一遍 `node ops/validate-vault.mjs`。

## Verify

```bash
python3 /path/to/skill-creator/scripts/quick_validate.py .
```

并在一次任务结束后说“复盘一下”，确认 Skill 先检索方法页，再输出候选结论，且不直接写任何文件。

## Privacy

- 过程叙事只作为草稿，不进入知识库。
- 未经用户批准的结论不写入；未批准的“顺手改进”不得混入为其他目的发起的提案。
- 本 Skill 不保存任何对话内容。

## Upgrade

用经过审阅的新版本替换完整目录。方法论的演进发生在知识库页面里，不需要同步改 Skill。

## Uninstall

只删除 Agent Skills 位置中的 `lab-knowledge-retrospective` 目录。

## License

本模块采用“公开可查看、个人非商业使用”的[许可草案](LICENSE.md)。商业使用、企业部署、客户交付、再包装或再分发需要权利人的书面授权；正式公开发布前仍需律师复核。

---

`lab-knowledge-retrospective` turns "what just happened" into "what to do next time in the same situation": fetch the current method pages first, separate narrative from conclusions, attach evidence and sample size, default to zero new pages, and hand approved conclusions to `lab-knowledge-intake`.
