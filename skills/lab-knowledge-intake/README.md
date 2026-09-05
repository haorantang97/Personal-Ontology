# Lab Knowledge Intake / 知识库录入

`lab-knowledge-intake` 是一个刻意保持轻薄的录入 Skill。它自己不定义 Schema、不决定文件放在哪里、也永远不直接写文件——它只负责把任意材料送进知识网关的提案流程，并在用户明确批准之前停下。

契约由 MCP 网关的 `knowledge_intake` 和当前机器 Schema 提供。Skill 不复制一份固定 Schema，但会在生成提案前读取当前契约、目标页面和同类型有效页面，避免把通用 YAML 写法或业务生命周期误当成当前 Vault 接受的字段格式。

## Prerequisite

**本模块不能独立运行。** 它要求宿主已连接一个提供 `knowledge_intake`、`knowledge_search`、`knowledge_propose_changes`、`knowledge_apply_proposal` 等工具的 `agent-knowledge` MCP 服务器，以及该服务器背后的 Obsidian/Git Vault 与派生索引。

该网关由本仓库的系统模块 [`lab-ontology`](../../lab-ontology/README.md) 提供，需要按其 README 单独安装并注册到宿主。没有它时，本 Skill 的正确行为是声明网关不可用并停下，而不是退回到写一个无人管理的 Markdown 文件。

## Installation

安装或复制完整目录。

### Community Agent Skills installer

```bash
npx skills add haorantang97/Personal-Ontology --skill lab-knowledge-intake
```

### Codex

项目级：`<project>/.agents/skills/lab-knowledge-intake/`
用户级：`~/.agents/skills/lab-knowledge-intake/`

重新加载 Codex 后调用 `$lab-knowledge-intake`，或直接说“录入知识库”“把这个存下来”。

### Claude Code

项目级：`<project>/.claude/skills/lab-knowledge-intake/`
用户级：`~/.claude/skills/lab-knowledge-intake/`

两端共用同一份 `SKILL.md`，不维护分叉实现。

## Workflow

1. 先调 `knowledge_intake` 取契约——Vault 位置、Schema、页面路由、排除项、审批规则与同步流程一律以它的返回值为准。
2. 读取当前机器 Schema、精确目标页面和同类型有效页面，再检索查重。
3. 对完整目标文件做提案预检：必需字段与枚举、当前列表序列化、Project 生命周期与 Schema `status` 的分离、Source/Result 双向关系。
4. `knowledge_propose_changes` 成功后才把精确提案展示给用户，等待明确批准。
5. 批准后由网关再次校验、Git 提交与索引同步；若校验拒绝，明确报告“未写入”，按新 Proposal ID 重新审批。

Skill 本身不承担第 5 步，也不发明第二个存放位置。

## Verify

安装后向 Agent 提一句“把这个暂停项目的复盘录入知识库”，正确行为是先调用 `knowledge_intake`，读取当前 Schema 与目标页，把业务暂停状态和受限的 Schema `status` 分开，检查列表格式及双向关系，再给出提案并等待批准。若它直接写文件、跳过预检或在提案失败后沿用旧批准，说明 Skill 未被正确执行。

## Privacy

- Skill 包内不含任何个人知识、Raw 材料或凭据。
- 录入的内容去向完全由网关契约决定，本 Skill 不选择目的地。
- 未获批准的改动不会进入知识库；批准范围之外的“顺手改进”不得夹带。

## Uninstall

删除对应安装目录即可。移除 Skill 不会改动已经写入的知识库内容。

## Limitations

- 与网关强耦合：网关契约变化时以网关为准，本文件不是事实源。
- 不负责判断“什么值得留下”。那是复盘环节的工作，本 Skill 只负责已经决定要留下的内容怎么进库。
