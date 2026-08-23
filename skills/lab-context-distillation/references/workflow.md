# 完整工作流

## 1. 本机准备

初始化独立 case，记录数据源授权。微信来源按账户发现多库集合，路径只进私有 registry。明文库用只读 backup，包含 WAL 已提交内容；加密候选把 DB/WAL/SHM 稳定复制。任何步骤都不修改源库。

平台发现和解密细节见 `platform-connectors.md`。任何尚未验证的小版本都要 fail closed，并回退到标准导出。

## 2. 统一记录与脱敏

先做 schema fingerprint/profile 选择，再逐行建立 locator/fingerprint，按分片和行判断发送方向。把本人创作、引用、转发和文件上下文拆开。联系人、群、媒体、收藏和朋友圈只在识别的 profile 中映射。按 fingerprint 集合做 1:1 覆盖；相同文本也不能按内容去重。

原始统一记录和身份 alias 放在 `local/`。已知 alias 先变成稳定假名，再清除路径、秘密和直接标识；只有脱敏副本能封存为 release。

## 3. 冻结 release

release 用 staging 构建，文件哈希、记录数、上游 fingerprint 集、缺口和 schema 版本写入 manifest，最后生成 seal。目标 generation 已存在时拒绝覆盖。

## 4. Map

按完整记录边界拆包；单记录超限时生成带 parent fingerprint 的派生组件，原完整 Map 不变。Map 候选至少覆盖：表达方式、推理路径、价值取舍、行为模式、局限、反例、实际代价和时间变化。每个输入必须成为证据或有理由排除。

## 5. 本地验收

模型输出先保存，再做权威本地校验，最后才写 accepted。四个 stage 使用不同输出契约。结构白名单修复保留 before/after hash。基础设施错误可重试；内容错误隔离单元；隐私错误阻断；依赖错误等待前置 receipt。

## 6. 跨事件归并与冲突补漏

只有整个 Map stage accepted 后才 materialize 派生 JSONL。Merge 用明确 component IDs 对同义、重复、因果、冲突、演变、反例和缺口做跨事件归并。未决冲突和仍需证据的缺口冻结；只有已解决或明确接受为局限的缺口能继续。完整 Map 永远保留。

大组件超预算时，先做保留 lineage 的紧凑派生视图，再拆分；不要截断 JSON 或只比较全组合对。

## 7. Final 与 QA

候选集和依赖全部冻结后再 Final。Final 必须写置信度和局限。QA 使用独立七项检查，分别报告 precision 和 recall。结构通过不代表内容召回合格。

## 8. 人工裁决与知识库

语义冲突、身份歧义、弱证据升级和无法确定的隐私例外进入人工裁决，替换结果仍过同一契约。最终结果先形成知识库提案；展示条目和 seal；用户批准后仅生成写入批准 receipt，外部写入另行执行。

## 9. 恢复、并发与增量提交

先运行 `recover-results` 回收已经落盘且绑定正确的未知 transport 输出。`controller-refill` 按完成补位，遇基础设施失败降并发，validator backlog 过高停止喂入，系统性结构/内容拒绝触发 canary halt。控制器观察写入 receipt。

长任务先 `scope-freeze` 固定单元分母和 migration watermark，再用 `scope-status` 记录 drain。微信 source checkpoint 只在对应 mapping 已进入验证通过的 sealed release 后推进；schema fingerprint 改变时旧 checkpoint 拒绝复用。

## 10. 冻结机器契约与差额入口

并行或续跑前先执行 `contract-validate contracts/real-distillation-v2`。清单固定九领域、route result/event item、双时间、双白名单、地点层级、覆盖状态、验收门和差额路由的文件哈希。任何一个文件变化都必须创建新契约版本，不能原地修改已提交历史。

若既有 Map 已经 accepted 且其 release、分母、证据绑定和隐私门仍通过，从 `post_map_domain_routing` 开始，不重跑 Map。新增数据只 Map 新 generation；规则变更只重提取受影响领域；用户纠正、来源撤回和回滚也按差额规则重建下游。

## 11. 九领域独立事件账本

按 `travel`、`education`、`work`、`relationship`、`residence`、`family`、`health`、`finance`、`creation` 独立冻结 route 分母。每个 route 必须恰有一个处理结果：`events_emitted`、`no_signal`、`out_of_domain` 或 `insufficient_evidence`。`events_emitted` 包含一到多个独立 event；其余处理结果不包含 event。每个 event 自己标记发生、完成、进行中、预订未确认、签证、计划、讨论或第三方，不能从 route 顶层继承状态，也不能把同领域多事件压成一个。单写“已审阅”无效。

packet 为每条 route 冻结证据与地点白名单。event 的 `evidence_ids` 和 `place_ids` 只能是自己 route 白名单的子集；地点白名单为空时 `place_ids` 必须为空。领域验收和账本合并都重复执行这项信任门。

`observed_message_time` 只表示消息被看见的时间；`asserted_event_time` 表示消息声称的事件时间。后者未知时保留未知，并保留日/月/年/相对/未知精度。每个领域单独产出 `complete`、`partial`、`not_extracted` 或 `ambiguous`，失败只隔离该领域。完整事件账本是事实权威，重要性只影响主时间线的展示层级。

地点先保存候选。只有唯一、明确标记安全的 alias、typo、slang、abbreviation 或 `contained_in` 映射能由本机程序应用；其余保留 `ambiguous`。国家、城市、次区域、地标和其他地点不互相冒充。“到访国家”只从已发生/完成的国家对象生成。

## 12. 运行时与个人资产

合并全部已封存领域账本后，构建 portable package。事件、完整证据、高可信知识卡和个人资产保持分层；卡片未收录的低置信证据仍可检索。运行时先做领域、时间、终态、主体和地点过滤，再做中文字符/双字词与英文词检索；没有命中就返回 `unknown` 和 coverage gap，禁止随便返回前 N 条。

运行模式为 biography、voice、advisor 和 mixed。只加载问题所需的最小模块；关系/冲突、目标/open loops 和时间演化按需加入。Voice 按关系距离、情绪温度、目的、长度、玩笑、粗口、纠错和连发节奏建模，但只能起草，不能冒充或自动发送。自我模型严格分 observation、pattern、hypothesis 和 advice；建议必须列收益、成本、触发条件、可逆性与不确定性。

独立 fidelity 验收包括跨领域复现、冻结 holdout 预测、与泛泛人格描述的区分，以及真实 blind review。未实际运行时必须写 `not_run/required`，不能用内容 QA 代替。

## 13. 正式演化状态机

新增来源、用户纠正、来源撤回、单领域重提取和回滚都创建新的只读 profile snapshot 与哈希链事件。旧版本保留且不改写。纠正只替换稳定 ID；撤回使依赖项失效而不删历史；回滚把旧版本复制为新的当前版本。操作结束后只重建受影响领域、合并、资产、运行时包和 QA。

## 14. 校准和知识卡

低置信、不会改变 Agent 行为的抽象结论留在安全层，不把大量抽象问题推给用户。只有“会实质改变行为”且准备就绪的少数项目进入校准。知识卡只晋升高可信索引；低可信内容不进入核心卡，但仍保留在事件/证据层。外部知识库仍必须先形成精确提案，再经过明确批准。
