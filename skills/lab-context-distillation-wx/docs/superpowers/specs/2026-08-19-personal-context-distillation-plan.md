# Personal Context Distillation 实施计划

> 本计划在一个全新仓库中执行，不接触旧任务运行状态。实现采用 Python 3 标准库；所有测试数据均为合成数据。

**目标：** 交付可运行、可公开查看、厂商中立的个人上下文蒸馏 Skill，并把历史事故转化为确定性状态机、回归测试和安全回退。

**架构：** 本机可信层完成发现、快照、导入、统一记录、脱敏、release 和权威校验；模型层只读取不可变的已脱敏数据包；追加账本连接 Map、Merge、Final、QA、人工裁决和知识库批准。

**技术：** Python 3.11+ 标准库、SQLite、JSONL、SHA-256、`unittest`；可选外部 SQLCipher CLI，不 vendoring 第三方实现。

## 任务 1：建立 RED 测试与合成契约

**文件：** `tests/test_authorization.py`、`tests/test_records.py`、`tests/test_release.py`、`tests/test_ledger.py`、`tests/test_pipeline.py`、`tests/fixtures/*`

1. 写授权门、身份/引用拆分、逐行覆盖、脱敏和秘密不出日志测试。
2. 写不可变 release、数字封条、半初始化失败和重复文本不去重测试。
3. 写 accepted 不重跑、租约回收、孤儿结果、错误分类和依赖门测试。
4. 写超预算拆包、白名单修复、来源只能降级、最终候选冻结和 KB 批准测试。
5. 运行测试，确认因生产模块不存在而失败。

## 任务 2：实现核心确定性库

**文件：** `scripts/personal_context_distillation/{hashing,atomic,authorization,records,redaction,release,ledger,validation,repair,planner}.py`

1. 实现 canonical JSON 和 SHA-256 数字封条。
2. 实现授权 receipt 和动作门。
3. 实现 source row→unified record、引用拆分、fingerprint 和 redaction。
4. 实现 staging→验证→原子 release 与不可变 manifest。
5. 实现追加账本、租约、幂等 claim/commit 和 accepted 终态。
6. 实现错误分类、权威 validator、结构白名单修复和 before/after receipt。
7. 实现按记录边界拆包、依赖 DAG、候选集封存。
8. 每个模块完成后运行最小相关测试。

## 任务 3：实现端到端控制器和 CLI

**文件：** `scripts/personal_context_distillation/{pipeline,connectors,cli}.py`、`scripts/pcd.py`

1. 实现 case 初始化、标准 JSONL/CSV 导入和只读 SQLite 快照。
2. 实现用户私有 key 文件和标准 SQLCipher stdin/export；禁止进程内存 key 提取、注入、重签名和秘密日志。
3. 实现 macOS/Windows 账户/多库发现、DB/WAL/SHM 快照、schema profile、消息/联系人/群聊/媒体/Favorites/Moments 映射和增量 checkpoint。
4. 实现 `authorize`、`ingest`、`release`、`plan`、`claim`、`submit`、`status`、`adjudicate`、`kb-propose`、`kb-approve`。
5. `submit` 只把已脱敏包放到 model-outbox；实际模型由 Skill 调用用户当前代理完成。
6. 运行端到端合成演示并验证可中断恢复。

## 任务 4：编写 Skill 与参考资料

**文件：** `SKILL.md`、`agents/openai.yaml`、`references/*.md`

1. 写简洁路由型 `SKILL.md`，只在需要时加载平台、契约、状态机、质量或许可参考。
2. 写授权隐私、工作流、记录契约、错误分类、模型/并发、平台连接器、质量/人工裁决、实战状态、公开经验。
3. 明确模型中立、无 GUI、无 Fast、accepted 不重跑、KB 写入需批准。
4. 写 Codex 元数据，并让默认 prompt 明确引用 `$personal-context-distillation`。

## 任务 5：许可与 clean-room 证据

**文件：** `LICENSE.md`、`THIRD_PARTY_NOTICES.md`、`CLEAN_ROOM.md`

1. 写源代码可查看/个人非商业使用许可草案；商业、企业、客户交付和再包装需书面授权。
2. 明确草案需律师复核，不把它误称为 OSI 开源许可。
3. 列明 Python、SQLite 和可选 SQLCipher 的许可与未 vendoring 状态。
4. 记录从事故规则→规范→失败测试→独立实现的证据链。

## 任务 6：公开说明与最终验证

**文件：** `docs/蒸馏全路径-观众版.md`、`evaluations/*`

1. 用普通中文解释全路径，把 hash 称为“数字封条”，减少术语。
2. 提供未来跨模型行为测试场景和评分量表，标记当前未做真实模型/真实微信测试。
3. 运行完整 `unittest`、CLI 帮助、临时目录端到端演示、Skill 快速校验。
4. 扫描隐私值、私密绝对路径、密钥、真实聊天和禁止的旧任务标识。
5. 输出已验证/待实战验证矩阵和文件清单；不推送 GitHub、不写知识库。

## 任务 7：基线否决后的完整实现审计（2026-08-20 增补）

1. 先把 `debb09b` 标成 baseline/incomplete 并单独提交状态修正。
2. 建立 feature-to-implementation matrix，分别标记实现、测试、实机和 blocker。
3. 按 TDD 补两平台真实可执行本地层和跨阶段质量/恢复/并发链路。
4. 把机械对话审计的 45 类聚合事故逐项映射到规则、状态与公开测试。
5. 运行仓库外两平台 CLI 前向测试、Skill 校验、隐私扫描和 clean-room 行重合扫描。
6. 只把无私密实机条件可完成的范围标成 implementation-complete；所有真实 build 仍单列 `field_validated=no`。
