# 验证状态与实机清单

## 字段级真值的三种标签

- `tested`：本公开仓库用合成或公开 fixture 自动验证；
- `aggregate field evidence`：源任务在真实私密材料上提供了获准公开的汇总计数，
  但本公开代码没有读取该材料；
- `field validated`：本公开版本在明确设备/build/数据上实际运行并通过。当前没有
  任何微信 build 达到这一标签。

## 已在合成数据和隔离进程中验证

- macOS/Windows 标准根目录、显式根目录、账户和数据库角色发现；
- 私有 registry 不向 CLI 输出路径，文件权限为 mode 0600；
- 明文 SQLite/WAL backup、加密 DB/WAL/SHM 稳定集合复制和 sidecar race 重试；
- 明文、SQLCipher 候选、损坏文件分类；
- 精确密钥授权、32-byte hex 校验、私有 key 文件、stdin SQLCipher 调用、失败清理；
- 混合明文/加密快照的原子解密与 integrity check；
- macOS snake_case 与 Windows camelCase schema fingerprint/profile；
- schema drift、未知 optional 表和错误路径 fail closed；
- 一对一、群聊 sender、联系人、群成员、引用、转发、图片、语音、附件；
- media 分母、Favorites、Moments 到统一记录；
- 全源 fingerprint 覆盖、增量 watermark、schema 变化拒绝复用 checkpoint；
- 本地身份假名、不可变 release、release 后 checkpoint；
- Map/Merge/Final/QA 独立契约、覆盖、冲突/缺口冻结、precision/recall；
- 超长记录谱系拆分、未知 transport 输出恢复、补位调度、canary、scope/drain；
- 从仓库外临时目录分别运行 macOS 和 Windows CLI 全链路前向测试；
- 人工裁决和知识库提案/批准分离。
- 冻结领域分母、恰一处理结果、零到多独立事件、双时间语义、逐 route 证据/地点白名单、九领域独立覆盖和领域账本合并；
- 地点闭集分类、确定性安全映射、ambiguous 保留和国家视图；
- biography/voice/advisor/mixed 最小加载、中文检索、结构过滤、unknown gap；
- 自我/声音/建议/fidelity 契约、高置信卡和完整证据检索；
- portable package、增量、纠正、来源撤回、领域重提取和回滚；
- 从仓库外临时目录运行 domain → ledger → package → runtime v2 前向测试。

## 获准公开的聚合实战证据

这些计数来自源蒸馏任务，只证明相应方法在那次私密运行中的聚合结果；它们不
证明本公开仓库处理过私密数据，也不包含标签、原文、身份、路径或回执。

- v105 旅行事件账本：1696 个合资格 episode，1696 个旧版终态处置，`ready=true`，
  `error_codes=[]`；
- v106 零模型地点层级：311/311 已处理，269 已分类、42 ambiguous、226 个候选
  映射；分类为 country 47、city 99、subregion 61、landmark 42、other 20；
- v106 回归测试 14/14；旧权威文件未修改；知识库写入和云写入均为 false。

这些旅行汇总产生于 route-result v3 修正之前。采用时必须做无损迁移检查：每条
route 恰有一个处理结果、同 route 的所有独立事件均保留、每个事件拥有自己的
语义状态，并重新绑定逐 route 的 evidence/place 白名单。未完成迁移不能称为
当前契约的 field validation。

合成 fixture `travel-v105-v106.json` 只保存上述汇总数字，
`field-evidence-validate` 会校验分母、类别和安全标志是否自洽。

## 明确未验证

没有使用真实微信资料、真实账户、真实微信 key 或真实 app 进程。以下每项都保持 `field_validated=no`：

- macOS 微信 4.x 每个目标 build 的容器/群组目录和账户布局；
- Windows 微信 4.x 每个目标 build、Documents 重定向和安装变体；
- 每个 build 的实际加密格式、page size、KDF、HMAC 和 key 合法来源；
- 真实 contact/session/message/media/favorite/sns 表及字段；
- 未知消息类型、撤回、编辑、多媒体变体和损坏记录；
- 数年语料下的吞吐、内存、packet 限额与并发阈值；
- 不同当前模型的 evidence precision/recall；
- 用户真实知识库系统的批准后写入。
- 教育、工作、关系、居住、家庭、健康、财务、创作八个领域的完整账本；
- biography/voice/advisor/mixed 的真实查询集、voice blind review 与三项 fidelity；
- profile 长期增量、纠正、撤回、重提取和回滚的实战行为。

## 日后需要用户提供的授权和环境

1. 单独批准新的真实微信数据源；
2. 允许只读发现，并为本 Skill 指定独立 case 目录；
3. 首轮只建立源 inventory 和一致快照，不发模型；
4. 若库加密，由用户依法提供 key，并单独批准 `local_key_access`；
5. 提供 macOS 或 Windows、微信完整版本号/build、账户布局和可回滚副本；
6. 允许用少量人工已知答案做 mapping/coverage 校验；
7. 任何未脱敏内容送模型或任何 KB 写入仍需另行批准。

实机发现新 schema 时，先保存只含表/列结构与匿名计数的诊断，新增独立 profile 和合成回归 fixture，再运行完整快照。不要在线修改旧 profile 去“凑过”真实库。

## 安全回退

任何实机步骤失败都停在当前不可变边界：保留源库不变，保留已封存 release/checkpoint 不变，输出结构化 blocker，改用用户提供的合法标准导出。待验证永不表述为已兼容。
