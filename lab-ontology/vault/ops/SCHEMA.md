# Knowledge Schema

## 设计目标

本库按“知识未来如何被 Agent 使用”纵向分层，按 `modules`、`domain`、`tags` 等元数据横向组织。Markdown 与 Git 是事实源；GBrain 数据库、向量和关系图是可重建的派生层。

Schema Pack 的事实源是 `ops/gbrain-schema/pack.json`，名称为 `agent-decision-memory`。

## 三层架构

| 层 | 位置 | 作用 | 默认检索 |
|---|---|---|---|
| Raw | `.raw/` | 原始转录、录音索引、截图文字、导出和未清洗材料 | 否，不进入 GBrain |
| Evidence | `sources/` | 出处、可信边界、候选观点与验证状态 | 否，按需检索 |
| Result | `projects/`、`decisions/`、`methods/`、`syntheses/`、`concepts/` | 可直接影响未来判断和行动的结果 | 是 |

Raw、Source 和结果页不是一一对应关系。一份 Raw 可以形成零到多张 Source；一张 Source 可以包含多个 claim 并支持零到多张结果页；一张结果页也可以由多个独立 Source 支持。

## 页面类型

| 类型 | 进入条件 |
|---|---|
| `project` | 当前仍有效的项目目标、事实、约束、产品原则和状态 |
| `decision` | 已承诺、会持续约束未来动作的重要选择 |
| `methodology` | 可执行的复用流程，包含输入、步骤、产出、边界和失败条件 |
| `synthesis` | 多个独立来源共同支持、能收窄选择的结论 |
| `concept` | 多次参与判断且不属于前四类的稳定机制 |
| `source` | 经过策展的证据分析或候选观点；可以尚未派生结果页 |

不新增 `candidates` 类型。候选观点属于 Source 证据层。

## 通用字段

所有正式页面继续包含：

```yaml
type:
title:
aliases: []
tags: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
status:
retrieval_scope:
agent_priority:
domain:
evidence_status:
```

新建或实质更新页面时增加：

```yaml
modules: []
maturity:
```

- `modules`：稳定模块 slug，可多选；空列表表示不加模块权重，不代表“已验证为全局规律”。
- `maturity`：`seed`、`corroborated` 或 `validated`。
- 缺少 `maturity` 的历史页不得自动视为 validated，继续依据 `evidence_status` 判断。

结果页还包含 `related` 和 `evidence`；Project 继续包含 `last_confirmed`。

Source 包含：

```yaml
source_format:
provenance_class:
source_family:
raw_refs: []
derived_pages: []
allowed_uses: []
disallowed_uses: []
```

- `provenance_class`：`first_party`、`external`、`system_observation` 或 `mixed`。
- `source_family`：用于识别同一作者、机构、转载链或共同上游，不能用文件数量冒充独立证据。
- `raw_refs`：可复原的本地 Raw 或外部定位；缺失时必须说明原因。
- `derived_pages: []` 合法。非空时必须与结果页 `evidence` 双向一致。
- `allowed_uses`、`disallowed_uses`：控制观点可以怎样参与回答和决策。

新字段对历史页采用渐进迁移：未触碰的旧页不批量改写；被更新、新建或进入专项迁移时补齐。

## 标题与出处

标题服务于语义检索，必须使用中性的知识主题。作者、平台、账号、抖音号、原始视频标题、营销措辞和采集日期放在 frontmatter 或“出处”部分，不放入结果页标题；Source 标题也不把来源身份当作主要语义。别名不得重新引入无检索价值的平台噪音。

## Source Claim 契约

一份连贯来源通常对应一张 Source 页。正文中的不同候选观点使用稳定编号：

```markdown
## Claims

### C-01

- 陈述：
- 类型：事实 / 来源观点 / Agent 推断 / 宣传主张 / 话术策略 / 待验证假设
- 直接依据：
- 样本与来源家族：
- 利益关系：
- 允许用途：
- 禁止用途：
- 反证与缺口：
- 下一步验证：
```

claim 可以独立晋升、被反证或长期停留在证据层。晋升时结果页引用 Source，并在正文注明 claim_id；图谱仍使用页面级 `evidence` / `derived_pages` 保持兼容。

## 成熟度与独立性

- `seed`：单一来源或单次事件，只能作为候选动作、表达启发、访谈问题或实验假设。
- `corroborated`：多个真正独立的来源家族、独立事件或自己的真实运行形成收敛。
- `validated`：在明确范围内经重复运行、对照或高质量证据验证。

升级必须看独立性、证据类型、利益关系、反证和适用范围，不按视频数量或同一作者重复次数投票。证据冲突时保留冲突，不自动升级。

`synthesis` 仍要求跨独立来源；`concept` 仍要求稳定机制；高风险事实、人物稳定模式和强因果声明不能仅凭 seed 进入默认决策。

## 模块与检索

模块是覆盖在六类页面上的元数据，不新增主题文件夹，也不硬隔离：

1. 先执行全局语义检索。
2. 再对与当前任务 `modules` 相同的结果加权。
3. 跨模块命中仍可返回，但要说明迁移条件。
4. Source 只在核验、探索或结果层不足时召回，并显示 maturity 与允许用途。
5. 同一模块经验经过多个独立场景验证后，可以更新为无模块加权的全局结果；不能仅靠同一来源重复出现完成晋升。

## Decision 契约

Decision 是稀少、高权重的持久承诺，不是 Agent 建议、知识提案批准记录或微小选择。

独立建页必须满足：用户明确承诺、影响多次后续行动、遗忘成本明显、存在真实被拒方案，并能写出范围和 `revisit_when`。临时选择留在对话，项目级小决定写入 Project 当前约束。

Decision 正文必须包含：

- 最终选择
- 理由
- 被拒绝方案
- 影响范围
- 实施位置
- `decision_status`：active / superseded / reversed / expired
- `revisit_when`

Agent 在相关任务开始时优先读取活跃 Decision。发生冲突时必须先判断是否命中重审条件。

## 活页面与周期审计

Project 以及其他明确维护当前状态的页面属于活页面，可以在任务推进中被不同 Agent 持续更新。知识库不采用“入库后冻结”或“只有创建者能修改”的权限模型；权限边界由知识网关、提案范围和用户批准控制。

活页面更新必须：

- 更新 `updated`；Project 同时更新 `last_confirmed`。
- 区分已确认状态、待定事项、过期内容和 Agent 推断。
- 优先更新同一页面，不因阶段变化创建“最终版 2”。
- 不追加任务流水、完整聊天或未清洗素材。
- 外部系统为事实源时，记录同步方向和冲突优先级。

周期审计是独立维护流程，默认只读。它检查格式、重复、矛盾、过期、标题、断链和证据边界，并把不同问题拆成可审批提案；不得以“全盘清理”为由自动重写正式库。

## 关系

### 关系字段的存储格式

`related`、`evidence`、`derived_pages` 的非空值必须保存为带引号的 Obsidian
内部链接，优先使用从 Vault 根目录开始的完整路径。空关系继续写成 `[]`：

```yaml
related: ["[[projects/pronto-apparel-ai]]"]
evidence: ["[[sources/2026-08-09-pronto-fde-final-semantic-audit]]"]
derived_pages: ["[[methods/pronto-fde-golden-path-delivery]]"]
```

Markdown/Git 中的内部链接是关系事实源。校验器和 GBrain 图谱同步器会把
`[[路径]]`、别名和标题锚点规范化为页面 slug，再生成带类型的派生关系。
不得在同一 Vault 中混用普通 slug 和内部链接。为允许一次性迁移，校验器只在
全库仍为旧式普通 slug 时进入兼容模式；一旦完成全库迁移，任何重新出现的普通
slug 都会形成混合格式并阻止写入。

| 关系 | 用途 |
|---|---|
| `derived_from` / `supports` | 结果与 Source 之间的双向证据关系 |
| `applies_to` / `uses` | 方法、概念或决定适用的对象 |
| `depends_on` / `required_by` | 前置条件 |
| `contradicts` | 冲突结论 |
| `supersedes` / `superseded_by` | 新决定或结论取代旧内容 |
| `related_to` | 结果页间无方向语义邻接 |

## 兼容与迁移

本次保留六类目录，不做全库大清洗。先升级 Intake、校验和检索契约，再分批处理：

1. Source 标题与出处分离。
2. 历史 Source 补 `source_family`、用途边界和 claim。
3. 核对没有 evidence 的结果页。
4. 给活跃项目和新页面补 modules。
5. 从已明确承诺中建立少量 Decision。

任何迁移都必须单独提案、样本 dry run、验证后再扩大范围。
