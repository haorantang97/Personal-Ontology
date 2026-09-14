# macOS / Windows 微信 4.x 本地连接层

## 已实现的可执行链路

### 发现与私有注册

`wechat4-discover` 检查 macOS 和 Windows 的已知 `xwechat_files` 候选根目录，也接受用户指定的 `--root`。账户必须含 `db_storage`；数据库按 message、contact、session、favorite、sns、media 等角色登记。绝对路径只写入 case 下 mode-0600 的私有 registry，对外只返回 `acct_...`、`db_...` 和数量。

### 一致快照

`wechat4-snapshot` 处理一个账户的完整数据库集合：

- 明文 SQLite 使用只读 backup API，包含 WAL 中已提交的事务；
- 加密候选把 DB、WAL、SHM 作为一个集合稳定复制；复制期间 sidecar 新增、消失或改变会重试；
- 未知或损坏文件 fail closed；
- 输出使用 staging、逐库哈希和总 seal，不修改源目录。

### 密钥与解密

公开实现只接受用户依法取得并放入私有文件的 32-byte 十六进制 key。读取前要求 `local_key_access` receipt；POSIX 上文件必须是 mode 0600。key 不进入参数、日志、receipt 或命令输出。

`wechat4-decrypt` 调用用户另行安装的 SQLCipher，使用标准 SQLCipher 4 profile，通过 stdin 设置 key 和参数，使用 `sqlcipher_export` 生成明文副本，再运行 SQLite integrity check。明文库和加密库可组成一个原子解密快照。

这不是“微信原生密钥获取”。进程内存扫描、注入、重签名、私有 key derivation 和打包第三方绕过工具被明确排除，原因见 `legal-and-connector-boundary.md`。

### Schema 与映射

`wechat4-map` 先对每个明文库列出表和列，生成结构 fingerprint，再选择明确版本的 observed-shape profile。当前可执行 profile 覆盖：

- macOS snake_case 合成/公开证据形状；
- Windows camelCase 合成/公开证据形状；
- `SessionTable` 与 `Msg_<md5>` 会话分片；
- contact、chat room、member；
- text、quote/reply、forward、image、voice、attachment；
- media/voice/file 可用性索引；
- 可识别的 Favorites 与 Moments；
- 可选库的 mapped、present_unmapped、not_present 三态。

缺必要表或字段时输出精确 drift 诊断并停止。未知 optional 表只报告存在和表名，不静默假装已映射。

联系人、群成员、原始 sender、自身 identifier 和媒体路径留在私有 mapping。进入 release 前，已知名字、备注、alias 和 username 被替换为稳定假名；会话 ID 另行哈希。模型 packet 的 transport preflight 会阻断私有字段名。

### 增量

每个库/表使用 `(sort_seq, local_id)` 或 `(create_time, local_id)` 水位。checkpoint 绑定 account、schema fingerprint、前一 seal 和 release seal。只有 mapped fingerprint 已出现在验证通过的不可变 release 中，checkpoint 才能推进。schema 改变时旧 checkpoint 失效，必须重新审计，不能跳过记录。

## 真实版本边界

上述代码在完全合成的 macOS/Windows profile、WAL race、错误路径和仓库外 CLI 前向测试中通过。它没有在任何真实微信 4.x 安装上运行，因此不能推断：

- 某个小版本的目录一定相同；
- 某个库一定是标准 SQLCipher 4 参数；
- profile 已覆盖该版本所有字段或消息类型；
- Favorites/Moments 一定在本地存在；
- 性能阈值适合真实多年语料。

真实环境首次运行应只做到发现和快照，先审查私有 inventory。任何不匹配都 fail closed，并按 `field-validation-status.md` 记录为新 profile 候选。

## 安全回退

连接、授权、解密或 schema 任一失败时，不扩大扫描、不猜 key、不上传源库、不写回微信。请用户提供依法取得的已解密 JSONL/CSV 或明文 SQLite 副本，再从统一记录层继续。
