# Personal-Ontology / 个人本体

面向个人上下文、证据化记忆和长期 Agent 协作的原创 Skills 仓库。

这个根目录只负责介绍与索引。每个 Skill 都是 `skills/` 下的独立模块，安装、权限、运行方式、测试和限制以对应模块自己的 README 为准。

## Skills

| Skill | 输入方式 | 核心工作 | 文档 |
| --- | --- | --- | --- |
| `lab-context-distillation-wx` | 微信 4.x 聊天、数据库及其合法导出 | 本地采集、解密适配、脱敏、证据化蒸馏与验收 | [打开 Skill 文档](skills/lab-context-distillation-wx/README.md) |
| `lab-life-reviewer` | 用户主动讲述与当前主题相关材料 | 逐事件采访、人生经历还原、Raw/handoff 交接与批准后归档 | [打开 Skill 文档](skills/lab-life-reviewer/README.md) |
| `lab-knowledge-intake` | 任意待归档材料：链接、文件、文本或对话 | 取网关契约、查重、生成精确提案、等待用户批准后写入 | [打开 Skill 文档](skills/lab-knowledge-intake/README.md) |
| `lab-knowledge-retrospective` | 一段已经结束的任务、事故、访谈或长对话 | 先取当前方法页，把叙事与结论分开，带证据与样本量蒸馏，批准后交给 intake | [打开 Skill 文档](skills/lab-knowledge-retrospective/README.md) |

前两者汇入同一套个人上下文，但不互相替代：一个从已经留下的记录中提取，一个通过主动访谈把经历讲清楚。`lab-knowledge-intake` 是它们的下游——决定成果如何经提案与批准进入知识库，本身不产生内容。`lab-knowledge-retrospective` 决定一段工作里什么值得留下，再交给 intake。

## Systems

| 模块 | 内容 | 文档 |
| --- | --- | --- |
| `lab-ontology` | 面向 Agent 的个人知识系统：带严格 Schema 的 Markdown/Git Vault 骨架、`agent-knowledge` MCP 网关（13 个 `knowledge_*` 工具）、GBrain schema pack、校验器、图谱同步与索引守卫 | [打开模块文档](lab-ontology/README.md) |

两个 knowledge Skill 运行在这个网关之上；Schema、路由与审批规则由网关返回，Skill 本身不复制。

## Quick install

使用社区 Agent Skills 安装器安装指定模块：

```bash
npx skills add haorantang97/Personal-Ontology --skill lab-context-distillation-wx
npx skills add haorantang97/Personal-Ontology --skill lab-life-reviewer
npx skills add haorantang97/Personal-Ontology --skill lab-knowledge-intake
npx skills add haorantang97/Personal-Ontology --skill lab-knowledge-retrospective
```

`lab-ontology` 是系统而不是 Skill：复制 `lab-ontology/vault/` 作为自己的 Vault，并把其中的 MCP 网关注册到 Agent，步骤见模块 README。

也可以只复制对应的完整 Skill 目录。Codex、Claude Code、直接使用和卸载说明都在各模块 README 中。

## Repository rules

- 根 README 不重复具体 Skill 或系统模块的操作手册。
- Skill 默认保持厂商与模型无关；不同 Agent 只使用不同安装位置。
- 每个模块单独声明验证状态、隐私边界和第三方依赖。
- Raw 访谈、聊天原文、身份、密钥与个人证据必须保存在 Skill 包之外。
- 任何知识库写入都必须保留精确提案和用户批准门。
- 公开 fixture 通过不等于真实设备或具体微信小版本兼容。

## License

除模块另有明确声明外，本仓库采用“公开可查看、个人非商业使用”的许可草案。商业使用、企业部署、客户交付、再包装或再分发需要权利人的书面授权。发布前仍需律师复核，详见 [LICENSE.md](LICENSE.md)。

---

Original, evidence-aware Skills and systems for building and maintaining personal context with AI agents. The repository root is a catalog; each module under `skills/` or `lab-ontology/` contains its authoritative installation, privacy, validation, and usage documentation.
