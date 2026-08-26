# Lab Trust Core 顶层独立模块设计

日期：2026-08-26
状态：已获用户口头批准，等待书面规格复核

## 1. 背景与目标

Personal-Ontology 是一组围绕个人知识工作的独立组件目录，不是要求所有组件必须一起安装的单体产品。当前公开结构包含一个系统与四个 Skill：

- 系统：`lab-ontology`
- Skill：`lab-context-distillation-wx`
- Skill：`lab-life-reviewer`
- Skill：`lab-knowledge-retrospective`
- Skill：`lab-knowledge-intake`

现有可信度体系已经以 Schema、Agent 规则和部分校验逻辑存在于 `lab-ontology`，同时已被整理为一份可执行的 TypeScript 实现。此次工作的目标是把这份实现作为第二个顶层、可独立取得的组件加入 Personal-Ontology，统一命名为 `lab-trust-core`。

最终首页必须明确表达：Personal-Ontology 展示两个系统/核心与四个 Skill；这些组件可以组合，也可以单独使用。

## 2. 产品边界

`lab-trust-core` 是可信度判断内核，不是 Skill，也不是完整知识库系统。它接收结构化知识记录、证据及预期用途，输出可解释的校验、使用和成熟度晋升判断。

它负责：

- 校验可信度记录是否符合规范；
- 根据 `seed → corroborated → validated` 判断成熟度；
- 按独立 `source_family` 计数，阻止同一作者或转载链通过重复次数伪造交叉验证；
- 区分事实、来源观点、Agent 推断、宣传主张、话术策略和待验证假设；
- 根据允许用途、禁止用途、适用范围、失效条件和风险等级给出 `allow`、`review` 或 `deny`；
- 通过 SDK、CLI 和只读 MCP 暴露同一份确定性判断。

它不负责：

- 保存知识、管理 Obsidian Vault 或 Git 历史；
- 搜索、向量召回或关系图谱；
- 创建、批准或应用知识提案；
- 替代 `agent-knowledge` Gateway；
- 替代 `validate-vault.mjs` 对整个 Vault 的目录、链接和页面格式检查；
- 自动修改用户知识。

## 3. 仓库位置与命名

目标结构：

```text
Personal-Ontology/
├── lab-ontology/                  # 完整个人知识库系统
├── lab-trust-core/                # 独立可信度判断核心
└── skills/
    ├── lab-context-distillation-wx/
    ├── lab-life-reviewer/
    ├── lab-knowledge-retrospective/
    └── lab-knowledge-intake/
```

`lab-trust-core` 必须位于仓库顶层，与 `lab-ontology` 平级。不得放入 `lab-ontology/`，也不得放入 `skills/`。

公开产品名、目录名和 npm 包名统一为 `lab-trust-core`。名称中的 `core` 表示它是可嵌入判断内核；不使用 `system`，避免让用户误以为它包含存储、检索和完整知识治理系统。

## 4. 独立安装与可移植性

`lab-trust-core/` 必须是自包含模块，保留自己的：

- `package.json` 与锁文件；
- 中英文入口说明；
- SDK、CLI、MCP、JSON Schema 与 Markdown 适配器；
- 示例、测试、隐私扫描和打包命令；
- 安装、集成、迁移、数据模型和 reason code 文档；
- 独立许可证说明。

模块不得从 `lab-ontology/` 或 `skills/` 读取代码、Schema、私有路径或运行时配置。只复制或稀疏检出 `lab-trust-core/` 后，仍应能够完成 `npm ci`、`npm run verify` 和 `npm pack`。

README 提供两种独立获取方式：

1. Git sparse checkout，只获取 `lab-trust-core/`；
2. 从版本发布中下载该模块的 `.tgz` 打包产物。

现有已公开的独立仓库在本阶段不删除、不归档、不改名。顶层模块验收后，再单独决定它是归档跳转页还是自动同步镜像，避免在迁移过程中破坏既有链接。

## 5. 与 Lab Ontology 的关系

三个组件边界如下：

| 组件 | 职责 | 是否为 `lab-trust-core` 的前置依赖 |
| --- | --- | --- |
| `lab-trust-core` | 对一条知识及其用途做可信度判断 | 否 |
| `agent-knowledge` Gateway | 搜索、读取、提案、批准写入、Git 与 GBrain 同步 | 否 |
| `validate-vault.mjs` | 检查整个 Vault 的目录、frontmatter、日期和链接完整性 | 否 |

当前 `lab-ontology` 已经使用可信度字段和 Agent 规则，但它的 `knowledge_route` 尚未调用新封装的执行代码，`validate-vault.mjs` 也只执行部分可信度约束。这意味着“可信度制度正在使用”，但“新封装代码正在运行”并不成立。

此次顶层模块迁移不修改 Gateway 或 `validate-vault.mjs`。未来若让 `lab-ontology` 调用 `lab-trust-core`，那是一项单独的适配工作：目的是让现有规则共用同一实现，不是让 `lab-trust-core` 获得独立运行能力。

## 6. 许可与隐私

`lab-trust-core` 保留已经公开授予的 MIT 许可，确保它可以被独立嵌入其他知识库、RAG 或 Agent 系统。Personal-Ontology 根目录文档必须明确标注这一模块是根目录 PolyForm Noncommercial 许可的例外，避免许可冲突或误导。

公开模块不得包含：

- 作者真实 Vault 页面、Raw 或 Source 内容；
- `/Users/...` 等个人绝对路径；
- `~/.gbrain/change-proposals/` 中的真实提案；
- 数据库、索引、凭据、密钥或个人配置；
- 对私有知识库覆盖率审计的原始内容。

示例只使用合成数据。隐私扫描必须在模块测试和根仓库 CI 中同时执行。

## 7. Personal-Ontology 首页调整

根 README 与英文 README 应将产品构成改为：

- 两个系统/核心：`lab-ontology`、`lab-trust-core`；
- 四个 Skill：`lab-context-distillation-wx`、`lab-life-reviewer`、`lab-knowledge-retrospective`、`lab-knowledge-intake`。

首页图示将 `lab-trust-core` 画成可选、平级的可信度内核：它可以被 `lab-ontology` 或外部知识系统采用，但不位于 `lab-ontology` 内部，也不暗示安装母系统后才能使用。

模块目录表需要分别说明输入、输出、依赖和独立安装入口，不用上下级或父子措辞描述二者。

## 8. 错误处理与安全默认值

- 未知 maturity、claim 类型、用途或字段组合必须失败关闭，不能猜测为可信；
- 同一来源家族的重复材料不得计为独立验证；
- 冲突证据阻止自动晋升；
- 文件读取仅允许显式授权根目录，所有 MCP 工具保持只读；
- SDK、CLI 与 MCP 必须返回同一 verdict 契约和稳定 reason code；
- 不因缺失历史字段而把旧页面自动视为 `validated`。

## 9. 测试与验收标准

迁移完成必须同时满足：

1. `lab-trust-core` 原有 50 项测试全部通过；
2. Node.js 20 与 24 的 CI 均通过；
3. TypeScript 类型检查、构建、隐私扫描和 `npm pack --dry-run` 通过；
4. SDK、CLI、MCP 对同一输入给出一致 verdict；
5. 模块脱离 `lab-ontology` 后仍可独立安装、测试和打包；
6. 根目录布局测试确认存在 2 个系统/核心与 4 个 Skill；
7. 中英文首页名称、数量、链接和架构图一致；
8. 根许可证文档明确记录 `lab-trust-core` 的 MIT 例外；
9. Git 仓库不包含个人路径、私有知识、真实提案或凭据；
10. 本阶段 Gateway 与 `validate-vault.mjs` 的行为和测试结果保持不变。

## 10. 非目标

本次不包含：

- 将 `lab-trust-core` 接入 `knowledge_route`；
- 重写 `validate-vault.mjs`；
- 迁移作者真实 Vault 的 93 张历史页面；
- 发布到 npm 公共注册表；
- 删除、归档或自动同步现有独立 GitHub 仓库；
- 改变四个现有 Skill 的行为。

这些事项需要在顶层独立模块通过验收后分别设计和批准。
