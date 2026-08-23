# Lab Knowledge Intake / 知识库录入

`lab-knowledge-intake` 是一个刻意保持轻薄的录入 Skill。它自己不定义 Schema、不决定文件放在哪里、也永远不直接写文件——它只负责把任意材料送进知识网关的提案流程，并在用户明确批准之前停下。

契约由 MCP 网关的 `knowledge_intake` 返回值提供，因此 Claude Code、Codex 或任何 MCP 客户端写出的格式完全一致，Schema 演进也不需要重新发布 Skill。

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
2. 检索并读取既有知识，查重。
3. 生成一份精确提案（create / update / delete / move）。
4. 把提案展示给用户，等待明确批准。
5. 批准后由网关完成校验、Git 提交与索引同步。

Skill 本身不承担第 5 步，也不发明第二个存放位置。

## Verify

安装后向 Agent 提一句“录入知识库”，正确行为是先调用 `knowledge_intake`、再给出提案并等待批准。若它直接写文件或直接回答，说明 Skill 未被加载或网关未连接。

## Privacy

- Skill 包内不含任何个人知识、Raw 材料或凭据。
- 录入的内容去向完全由网关契约决定，本 Skill 不选择目的地。
- 未获批准的改动不会进入知识库；批准范围之外的“顺手改进”不得夹带。

## Uninstall

删除对应安装目录即可。移除 Skill 不会改动已经写入的知识库内容。

## Limitations

- 与网关强耦合：网关契约变化时以网关为准，本文件不是事实源。
- 不负责判断“什么值得留下”。那是复盘环节的工作，本 Skill 只负责已经决定要留下的内容怎么进库。
