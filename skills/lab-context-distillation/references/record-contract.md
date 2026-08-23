# 统一记录与证据契约

## 输入行

JSONL/CSV/SQLite 查询至少提供：

- `row_id`：源内稳定行标识；
- `sender_id`、`self_id`：仅在本机用于逐行判断方向；
- `timestamp`；
- `text`；
- 可选 `shard`、`conversation_id`、`quoted_text`、`quoted_author`、`forwarded_context`、`media_type`、`media_expected`、`media_available`、`ordering_basis`、`ordering_certainty`、`evidence_precision`。

输入层的 `source` 会被命令中的本地 source name 覆盖。不要把真实路径用作 source name。

## release 记录

release 包含 `record_id`、`source_fingerprint`、伪名化 conversation id、时间、方向、作者范围、创作文本、引用、转发上下文、媒体缺口、排序确定性、证据精确度和脱敏状态。它不包含 source locator、sender/self id、联系人目录、媒体路径或原始身份。

## 模型候选

Map/Merge/Final 的通用字段：

```json
{
  "statement": "A bounded observation",
  "evidence_ids": ["rec_..."],
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

`source_strength` 只能是 `observed`、`self_report`、`third_party`、`quoted` 或 `unknown`。Merge 另需 `component_candidate_ids`；Final 另需 `confidence` 和 `limitations`；QA 使用独立结构。精确定义见 `quality-and-adjudication.md`。

“发送过”不等于“亲自创作”“亲口说过”或“认可”。缺媒体时必须把分母和影响写入 gap。逐字、近似和概述不能混称原文。

## v2 route result 与 event item

route 外层的机器权威是 `contracts/real-distillation-v2/route-result.schema.json`；
event 项以 `life-event.schema.json` 为准。每条 route 结果的形状为：

```json
{
  "route_id": "travel:episode_fixture_1",
  "episode_id": "episode_fixture_1",
  "domain": "travel",
  "observed_message_time": {"value": "2026-08", "precision": "month"},
  "processing_disposition": "events_emitted",
  "events": [
    {
      "subject": "self",
      "disposition": "completed",
      "title": "Synthetic completed event",
      "summary": "A redacted, evidence-bounded summary",
      "importance": 0.6,
      "asserted_event_time": {"value": "2025", "precision": "year"},
      "evidence_ids": ["episode_fixture_1"],
      "place_ids": []
    }
  ]
}
```

`route_id` 必须来自冻结的领域 packet；结果不能改写原 packet 的 `episode_id` 或
`observed_message_time`。每条 route 恰有一个 `processing_disposition`：
`events_emitted`、`no_signal`、`out_of_domain` 或 `insufficient_evidence`。
前者要求 `events` 至少一项，后三者要求 `events=[]`。同一 route 可有多个独立
event，并分别拥有 `occurred/completed/ongoing/booked_unconfirmed/visa/planned/
discussed/third_party` 语义状态。

packet 同时冻结 `route_evidence_allowlists` 和 `route_place_allowlists`。每个 event
的 evidence/place ID 都必须是自己 route 白名单的子集；地点白名单为空时
`place_ids` 必须为空。`asserted_event_time` 可为 `null`，也可使用 `day`、
`month`、`year`、`relative`、`unknown` 精度，但不能用发送日填空。

主体取值为 `self`、`third_party`、`mixed`、`unknown`。领域、处理状态、事件状态、
时间精度、覆盖状态和地点类型的完整闭集见 `contracts/real-distillation-v2/field-enums.json`。

## 地点记录

地点对象严格区分 `country`、`city`、`subregion`、`landmark`、`other`、`ambiguous`。候选映射必须保存候选类型和来源证据；只有唯一且 `safe=true` 的确定性候选可应用。歧义不是错误值，也不能靠最常见候选猜测。

## Runtime package 分层

- `events`：完整事件账本，不能因重要性低而删除；
- `evidence`：完整、可撤回的证据索引；
- `cards`：高可信快速索引，不是事实权威；
- `assets`：observation/pattern/hypothesis/advice、scenario voice、边界和 fidelity 状态；
- `evaluation_cases`：脱敏的 development/holdout/blind 用例和运行真值；
- `coverage`：九领域各自的 complete/partial/not_extracted/ambiguous 状态。

运行时结果必须返回查询状态、相关领域覆盖与命中的对象 ID。无匹配时返回 `unknown`/coverage gap，不得用无关记录补位。
