# 质量验收、冲突与人工裁决

每个 packet 自带机器生成的 `output_contract`。先运行 `transport-probe <stage>` 检查本地解析器，再让当前模型按该 packet 的契约输出。传输层提示不是权威；`validate` 才决定能否接受。

## 通用候选

Map、Merge、Final 候选均需：

```json
{
  "statement": "...",
  "evidence_ids": ["..."],
  "source_strength": "observed",
  "quality": {
    "negative_patterns": [],
    "counterexamples": [],
    "costs": [],
    "time_evolution": [],
    "gaps": [],
    "conflicts": []
  }
}
```

六个 quality 字段必须出现；空列表表示已检查但未发现，不出现表示没有完成检查。所有 packet 输入必须在候选 `evidence_ids` 中出现，或在顶层 `coverage.excluded` 中用非空理由处置。验证 receipt 分开记录 evidence recall 与 disposition coverage。

## Map

Map 逐记录提取表达、推理、取舍、行为、局限、反例、代价和时间变化。不要把引用/转发当本人表述，不从少量情境推断稳定人格。

## Merge

每个 Merge 候选额外要求 `component_candidate_ids`，且必须与该候选的 `evidence_ids` 完全相同。输入候选只能被合并或理由排除。

`quality.conflicts` 的每项必须是带 `status: resolved` 的对象；否则冻结。`quality.gaps` 的每项必须是 `resolved` 或 `accepted_limitation`。`needs_evidence`、字符串或未知状态都会冻结并进入人工裁决，避免把“列出缺口”误当“补齐缺口”。

## Final

Final 只能读取精确冻结的候选集。每个候选额外要求：

- `confidence`: `low` / `medium` / `high`；
- `limitations`: 列表；
- 完整 quality 审计。

## QA

QA 不复用 Final 的通用 quality 形状。顶层必须有：

```json
{
  "qa": {
    "verdict": "pass",
    "checks": {
      "structure": {"status": "pass", "detail": "..."},
      "evidence_recall": {"status": "pass", "detail": "..."},
      "attribution": {"status": "pass", "detail": "..."},
      "negative_patterns": {"status": "pass", "detail": "..."},
      "counterexamples": {"status": "pass", "detail": "..."},
      "coverage": {"status": "pass", "detail": "..."},
      "overreach": {"status": "pass", "detail": "..."}
    },
    "precision": {"numerator": 1, "denominator": 1},
    "recall": {"numerator": 1, "denominator": 1},
    "unresolved": []
  }
}
```

任何检查失败、未决项非空或 verdict 非 pass 都不能 accepted。precision 和 recall 使用独立整数分子/分母，禁止用一个“质量分”替代。

## 自动修复与裁决

自动修复只删除 evidence/quality 列表的 null 和完全重复项，保留顺序并写 before/after hash。未知 evidence、来源强度、语义、冲突状态和缺口状态不自动改。

以下情况必须人工：身份歧义、证据归属冲突、缺失证据是否可接受、自动修复会改变含义、隐私例外、弱来源可能升级、KB 条目是否值得保存。人工 replacement 仍需通过同一 stage contract；裁决 receipt 不复制敏感原文。

## v2 领域账本验收

每个领域先冻结 route 分母，再执行以下本机门：

1. packet seal、route 分母和 release hash 一致；
2. 每个 route 恰有一个处理结果，不能多、不能少；
3. `events_emitted` 要求一到多个 event，其他处理状态要求空 `events`；
4. 每个 event 自己拥有闭集语义状态，同 route 多事件不得合并或继承一个状态；
5. observed 与 asserted 时间分别存在于 route/event 字段，消息时间不能填充事件时间；
6. 主体、领域和 event evidence 都绑定冻结 packet 的自己 route；
7. event `place_ids` 是自己 route 地点白名单子集，空白名单禁止非空地点；
8. 地点归一化只应用唯一安全映射，ambiguous 不猜；
9. 领域 coverage 精确声明 complete/partial/not_extracted/ambiguous；
10. receipt、账本和 portable package 的哈希/数字封条一致。

旅行领域的聚合实战结果只能证明旅行方法的覆盖事实，不能替其他八个领域或本公开树的实机兼容背书。

## Runtime 和资产验收

检索先通过结构化过滤，再进行中文/英文词法检索；可选语义分数只影响候选内排序。无匹配时必须输出 `unknown` 和 coverage gap。每次回答声明相关领域的提取状态，避免把“未提取”说成“没有经历”。

自我模型层级不得混写。Pattern/Hypothesis 保留反例、时间变化、领域差异与未决张力；Advice 附收益、成本、触发条件、可逆性和不确定性。Voice 按场景保存表达约束，权限只到草稿。真实 blind review 和 holdout 未运行时写 `not_run/required`。

知识卡只纳入达到门槛的高可信索引。未晋升的低可信证据继续留在完整证据层；不得静默提升到核心卡，也不得因未晋升而删除。

## 差额和版本验收

新增来源只 Map 新 generation；accepted 单元不重跑。用户纠正、来源撤回、领域规则变化、领域重提取和 rollback 都创建新版本，并只重建受影响领域与下游合并/资产/QA。旧 snapshot、release、hash 和 receipt 永远只读。
