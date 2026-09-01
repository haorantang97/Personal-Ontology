# Lab Knowledge Retrospective / 复盘蒸馏

`lab-knowledge-retrospective` 把一段已经结束、暂停或失败的工作——任务、事故、访谈或长对话——先审计、再蒸馏成可复用的结论，并按审批流程交给 [`lab-knowledge-intake`](../lab-knowledge-intake/README.md) 写入知识库。短任务使用结论模式；失败项目、长对话、跨任务复盘或“复盘每一次问答”使用法证模式，必须读取原始轮次、核验“已完成/已跑通”等声明，并明确报告 `COMPLETE` 或 `PARTIAL` 覆盖状态。

本 Skill 内置稳定的执行协议：模式选择、逐轮账本、声明核验、覆盖门和审批门。具体领域的方法仍住在知识库的 `methods/` 页面里并持续更新；方法页可以补充判断框架，不能削弱内置协议。

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

## Optional integrations

- 核心审计协议没有运行时依赖；只要宿主能提供当前任务或用户指定的关联任务历史，就可以执行。历史不完整时仍可交付有边界的报告，但覆盖状态只能是 `PARTIAL`。
- `agent-knowledge` MCP 网关是可选的方法增强，用于读取当前领域方法，见 [lab-ontology](../../lab-ontology/README.md)。它不可用时仍可执行内置协议，但不得声称已检查方法库。
- `lab-knowledge-intake` 只在用户明确要求把批准后的结论写入知识库时需要；普通复盘不依赖它，也不得绕过审批直接写 Vault 或 GBrain。

## Workflow

1. 检查阶段是否已经结束、暂停或失败，并区分复盘与仍需继续执行的调查。
2. 在选择模式前预检历史完整性、关联任务、纠正与完成声明；历史未知、压缩或截断时先进入法证模式，并保持 `PARTIAL`，直到原始历史和覆盖门证明可以升级。
3. 选择结论模式或法证模式；失败项目、长对话、多次纠正、跨任务范围和完成声明核验强制进入法证模式。
4. 通过 `knowledge_route` 和 `knowledge_get` 读取匹配本次事件的当前 method 页。
5. 法证模式按 [`references/forensic-conversation-audit.md`](references/forensic-conversation-audit.md) 做两遍扫描，建立逐轮、声明、纠正和未闭环四类账本。
6. 先通过覆盖门；任何历史缺口、漏审轮次或漏核验声明都会强制状态为 `PARTIAL`。
7. 把过程叙述与可迁移结论分开，为每条候选标注证据、样本量、适用范围和失效条件。
8. 先把复盘审计交给用户；默认可以没有任何长期知识候选。
9. 用户要求入库时先取得 `knowledge_intake` 当前契约，再交给 `lab-knowledge-intake` 走精确提案与审批流程。

## Verify

```bash
python3 /path/to/skill-creator/scripts/quick_validate.py .
```

并做两类行为验收：

- 短任务说“复盘一下”，确认 Skill 使用结论模式、先取当前方法、输出有证据边界的候选，且不直接写任何文件。
- 对一个含多次纠正和“已跑通”声明的失败项目说“深度复盘每一次问答”，确认 Skill 进入法证模式、读取关联任务原始轮次、核验声明并报告 `COMPLETE/PARTIAL`，而不是直接跳到总结。

## Privacy

- 原始轮次、逐轮账本和过程叙事只在本次复盘中瞬时使用，不自动进入知识库。账本默认只保留在模型工作记忆中；宿主确需临时 scratch 文件时，应最少复制原文并在最终回答前清理。
- 未经用户批准的结论不写入；未批准的“顺手改进”不得混入为其他目的发起的提案。
- 本 Skill 不会主动持久化或自动摄取对话内容；实际模型和任务历史的保留方式由所选宿主及其隐私设置决定。

## Upgrade

用经过审阅的新版本替换完整目录，包括 `SKILL.md`、`agents/` 和 `references/`。领域方法的演进发生在知识库页面里；只有稳定的执行协议变化才需要升级本 Skill。

## Uninstall

只删除 Agent Skills 位置中的 `lab-knowledge-retrospective` 目录。

## License

本模块采用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)（全文见仓库根目录）：个人与非商业用途可自由使用、修改和分发；商业用途需另行取得著作权人的书面授权。

---

`lab-knowledge-retrospective` audits finished, paused or failed work before distilling it. Short work uses conclusion mode; long conversations, failed projects and cross-task reviews use forensic mode with raw-turn coverage, completion-claim verification and an explicit `COMPLETE` or `PARTIAL` status. Evidence-bounded conclusions still default to zero and reach the knowledge base only through `lab-knowledge-intake` and user approval.
