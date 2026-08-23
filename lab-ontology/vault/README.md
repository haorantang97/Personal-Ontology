# GBrain Agent Knowledge Base

这是一个面向 Agent 决策与执行的个人知识库。Markdown 与 Git 是事实源，GBrain 数据库、向量索引和关系图都是可重建的派生层。

## 三层结构

| 层 | 位置 | 用途 |
|---|---|---|
| Raw | `.raw/` | 原始材料，只保留可复原性，不进入 GBrain |
| Evidence | `sources/` | 出处、候选观点、可信边界与验证路径，按需检索 |
| Result | `projects/`、`decisions/`、`methods/`、`syntheses/`、`concepts/` | 默认参与 Agent 判断与行动 |

Raw、Source 与结果页是多对多关系，不要求数量相等。Source 可以暂时只保存候选观点；只有成熟内容才晋升为结果页。

## 组织原则

- 页面类型由知识未来如何被 Agent 使用决定，不由主题、平台、作者或媒介决定。
- `modules` 是横向权重：先检索全局，再增强当前模块，不建立硬隔离墙。
- 标题使用中性的语义主题；作者、平台、账号和原始标题只作为出处元数据。
- 可信度按 `seed`、`corroborated`、`validated` 管理，并按独立来源家族判断，不按同一作者重复次数投票。
- `decision` 只保存会持续约束未来行动的重要承诺，不保存审批日志和琐碎选择。
- Project 等状态页是可持续更新的活页面；任何 Agent 都可提出增量修改，但必须经过网关提案与用户批准。
- 周期性全库审计检查格式、重复、矛盾、过期和断链，默认只报告并形成分项提案，不自动清洗。
- Lab 305 Content OS 保持独立事实源，只有正式导出才经知识网关进入本库。
- 所有写入先提案、再批准；不运行无人值守的 dream/autopilot。

完整契约见 `ops/SCHEMA.md`，Agent 行为规则见 `ops/AGENTS.md`。
