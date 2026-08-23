# 运行时、个人资产与可信度

## 四种模式

- `biography`：检索事件、证据和高置信索引；
- `voice`：只加载场景化表达资产，只能起草；
- `advisor`：加载自我模型、目标和 open loops，建议必须带取舍；
- `mixed`：组合前三者的最小集合。

关系/冲突和时间演化是可选模块，只在问题需要或显式指定时加载。任何模式都
不能自动发送、冒充本人、替用户作不可逆承诺，或宣称无法分辨真假。

## 检索

`runtime-query` 先应用领域、终态、主体、地点层级和年份过滤，再做中文友好的
字/双字词与英文词检索。调用方可提供语义分数做混合排序，但 Skill 不绑定向量
库、模型或厂商。无命中时返回 `unknown` 和 coverage gap；绝不返回前 N 条凑数。

事件、完整证据和知识卡分别返回。知识卡只是高置信索引；低置信证据即使没有
卡，也仍可从证据层命中。每次结果声明相关领域是 `complete`、`partial`、
`not_extracted` 或 `ambiguous`。

## 自我模型

每项必须明确属于：

- `observation`：可直接观察的行为或表述；
- `pattern`：跨事件的有限规律；
- `hypothesis`：待检验解释，必须写不确定性；
- `advice`：行动建议，必须写收益、成本、触发条件、可逆性和不确定性。

所有层保留领域范围、反例、时间变化和未决张力。矛盾先视为领域差异、时间变化
或证据冲突，不自动抹平。

## Voice 与 fidelity

Voice 按关系距离、情绪温度、目的、长度、玩笑条件、粗口边界、纠错方式和连发
节奏建模。私密原句只能留在本地 vault；portable package 只保存脱敏特征和不透明
引用。真实 blind review 未运行时必须显示 `required=true, status=not_run`。

Fidelity 独立于内容 QA，分别记录跨领域复现、holdout 预测和非泛化区分。三项和
blind review 没有全部通过时，禁止 `field_claim=true`。

Portable package 必须同时保存脱敏的 `evaluation_cases`，而不只是汇总分数。每个用例记录评估类型、development/holdout/blind 分组、真实状态、不透明输入引用、预期行为和已观察结果。development 与 holdout 的证据 ID 必须互斥；未运行用例不得伪造 observed result。私密 prompt/原文不得进包。

## 校准与知识卡

只有同时满足“会改变 Agent 行为”和“ready”的少数项目进入用户校准队列。
其余低风险、低置信或不影响核心产出的结论留在安全层。知识卡只晋升高置信项，
未晋升项仍保留在完整资产和证据层。
