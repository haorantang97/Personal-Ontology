# 状态机与恢复

```text
pending → reserved → produced → validated → accepted
               └────→ needs_human → accepted | quarantined_content
pending/reserved → retry_infra
pending → blocked_dependency
```

当前实现把运行事件追加到 `ledger.jsonl`，用哈希链检测改写。`accepted` 后任何新事件都视为账本损坏。派生 status 不是权威来源。

## 租约

活跃租约不能被其他 worker 抢占；过期后可重新 claim。`status` 区分 reserved、实际未过期 active、expired_reserved、pending、produced、validated、validator backlog、accepted 和 quarantine。目标并发属于 controller observation，不从 reserved 数反推。

## 恢复顺序

1. 验证 ledger 哈希链；
2. 验证 sealed release；
3. 对已有 output 先核对 artifact hash 和契约；
4. `recover-results` 对 reserved+raw、produced 和 validated 三类中断状态分别恢复；artifact 必须绑定 unit，哈希和 stage contract 通过才接受；未知文件只报告不删除；
5. 不完整 staging 可安全重建；只有 manifest 和 seal 齐全才算完成；
6. accepted 永不重跑。

模型输出、验证 receipt 和 commit 是三个显式阶段。对话结束不会改变它们；下一次运行从账本继续。

同一个 case 采用单一确定性控制器写账本。模型 packet 可以并行推理，但 claim、状态写入、验证和 commit 由控制器串行落账，避免多个进程同时竞争哈希链。一个控制器进程只重放账本一次，后续事件增量更新内存状态。

`controller-refill` 只补足空闲 slot：存在 `retry_infra` 时降低目标；validator backlog 达阈值时暂停 feeder；达到 canary 样本且结构/内容系统性拒绝时目标降为 0。单个内容失败仍只隔离该 unit。

`scope-freeze` 产生不可变 unit 集、generation、migration watermark 和 seal；`scope-status` 从账本派生 drain receipt。旧 generation 只有全部单元进入 accepted 或 quarantined 终态才算 drained。

若需要判断本机资源瓶颈，先把该 run 明确拥有的全部 PID 传给 `process-sample`，在一个时间窗内采样多次，再用 `process-trend` 看趋势。不要只看父进程或单次 CPU 快照，也不要扫描未放入任务作用域的其他进程。

## 领域提取状态

```text
not_extracted → partial → complete
                     └→ ambiguous
complete/ambiguous → superseded_by_reextract
```

领域 route packet 先固定准确分母和逐 route 的证据/地点白名单。每个 route 只能出现一个处理结果；该结果可产生零到多个独立 event，每个 event 自己保存语义状态并再次通过双白名单。`partial` 只表示仍缺 route，`ambiguous` 表示分母已完整处置但含证据不足项。一个领域完成不改变其他领域的 `not_extracted`。合并只接受通过 seal 验证、领域权威互不重叠且重新通过白名单门的账本。

## Profile 演化状态

```text
v1 ─incremental_update→ v2
v2 ─correction→ v3
v3 ─source_withdrawal→ v4
v4 ─domain_reextract→ v5
v5 ─rollback(target=v2)→ v6
```

每个箭头都创建新的连续版本、只读 snapshot、profile/snapshot hash 和哈希链事件。操作只允许基于当前 latest，避免并发分叉覆盖。rollback 不把指针倒退，而是把目标旧内容复制为新版本。撤回不删除历史：相关对象标记 inactive，随后重建受影响领域和下游包。

## 失败与修复

只有显式 `event=failure` 的结构化事件能进入失败分类；正常输出中出现“error”等词不算失败。基础设施失败与模型内容失败分别记账；重复基础设施失败触发限流、冷却和安全回退建议。可选 sidecar 失败不得把已 accepted 的模型结果改回未完成，只重试 sidecar。

确定性结构修复必须同时保存前后 hash，并证明 narrative 字段完全不变。任何会改变叙述、证据强度、时间断言、地点歧义或终态含义的修复都进入人工/重新提取，不能自动完成。
