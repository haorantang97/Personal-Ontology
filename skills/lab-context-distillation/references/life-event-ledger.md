# 领域事件账本契约

## 为什么先做完整账本

Cross-event 总结和“重要事件”视图都不是事实权威。v2 先把每个冻结 episode
路由到一个领域。每条 route 恰有一个处理结果，但同一 `domain × episode` 可以
产生零到多个彼此独立的事件。重要性只控制展示，不能合并、删除或覆盖账本事件。

支持领域：`travel`、`education`、`work`、`relationship`、`residence`、
`family`、`health`、`finance`、`creation`。

## 处理状态与事件状态分离

route 的 `processing_disposition` 只说明这一条 route 如何结束：

- `events_emitted`：必须包含至少一个 `events[]` 项；
- `no_signal`、`out_of_domain`、`insufficient_evidence`：必须是空 `events[]`。

每个 event 自己保存权威语义状态：`occurred`、`completed`、`ongoing`、
`booked_unconfirmed`、`visa`、`planned`、`discussed`、`third_party`。
同一 route 内可同时出现不同状态；不得从 route 顶层继承一个状态到所有事件。
`third_party` 状态和 `subject=third_party` 必须双向一致。`reviewed` 不属于任何闭集。

## 两种时间

- route 的 `observed_message_time`：这条消息被观察到的时间；
- event 的 `asserted_event_time`：消息声称该事件发生的时间。

两者分别保存 `value` 和 `precision`。精度只允许 `day`、`month`、`year`、
`relative`、`unknown`。没有事件时间时保留 `null`；禁止用消息发送日补上。

## route 白名单

领域 packet 为每个 route 冻结两份独立白名单：

- `route_evidence_allowlists`：event 的 `evidence_ids` 只能取自己的 route 子集；
- `route_place_allowlists`：event 的 `place_ids` 只能取自己的 route 子集。

地点白名单可以为空；为空时 event 的 `place_ids` 必须为空。跨 route 引用即使 ID
真实存在也会被拒绝。`domain-validate` 和 `life-ledger-merge` 都重新验证这两条边界，
所以不可验证的 place ID 不能进入合并账本。

## 覆盖状态

每个领域单独声明：

- `complete`：冻结 route 分母全部得到处理结果；
- `partial`：仍有 route 没有处理结果；
- `not_extracted`：该领域尚未运行；
- `ambiguous`：分母已处置，但存在 `insufficient_evidence` route。

运行 `domain-plan` 冻结领域分母和双白名单，模型只返回契约要求的结构；运行
`domain-validate` 做本地验收。各领域通过后用 `life-ledger-merge` 合并。旅行先
实战不代表其他领域已完成。

## 地点

地点类型只允许 `country`、`city`、`subregion`、`landmark`、`other`、
`ambiguous`。alias、typo、slang、abbreviation 和 `contained_in` 都只是候选。
`places-normalize` 只应用唯一且标记为安全的确定性候选；其余保留 ambiguous。
“到访国家”视图只接收已发生/完成事件中的 country 对象，城市和地标仍留在
原事件。
