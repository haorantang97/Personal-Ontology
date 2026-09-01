# Contributing / 协作规则

这个仓库同时被人和多个 Agent 会话修改过。下面的规则是为了让它们不再互相覆盖。

## 分支与合并

- `main` 只接受快进合并。**不要从任何会话直接向 `main` 推送**，包括 Agent 会话。
- 每项工作开一个分支：`feat/<模块>-<主题>`、`docs/<主题>`、`fix/<主题>`。
- 通过 Pull Request 合并；CI（布局与公开边界、Skill 契约、wx 模块、Trust Core、lab-ontology 网关测试）必须全绿。
- 同一时间只让一个会话处理同一个模块。开始前先 `git fetch` 并从最新的 `main` 切分支。
- 在 GitHub 仓库设置中为 `main` 打开 branch protection（要求 PR、要求 CI 通过、禁止 force push）。这一步只能在网页上做。

## 提交信息

- 英文祈使句，带类型前缀：`feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- 涉及某个模块时在正文写清模块名和验证方式。
- 改动 `lab-ontology/vault/ops/` 下的治理文件时，在正文说明它与作者本地 Vault 的差异，并更新 `lab-ontology/README.md` 的 Provenance 一节。

## 版本与变更记录

- 每次合并到 `main` 的用户可见改动都在 `CHANGELOG.md` 的 *Unreleased* 下记一行。
- 发布时把 *Unreleased* 改为版本号和日期，并打 tag：`git tag -a vX.Y.Z -m "vX.Y.Z"`，`git push origin main --tags`。
- 仓库 tag 采用 `vX.Y.Z`；各模块内部版本（网关 `package.json`、schema pack、wx 模块的 `versions/`）保持各自节奏，在 CHANGELOG 里注明。

## 公开边界

- 任何提交都不得包含私人绝对路径、Raw 访谈、聊天原文、身份、密钥、个人证据页或资产文件。自动测试会扫描私人绝对路径等机械边界，但不能替代对 Raw 内容、身份和密钥的人工审查。
- `lab-ontology/vault/` 的六个内容目录永远只含 `.gitkeep`。
- 新增模块必须自带 `README.md`（含 Installation、Verify、Privacy、Uninstall）、`LICENSE.md`（指向根目录）、`THIRD_PARTY_NOTICES.md`，并在根 README 目录和 `THIRD_PARTY_NOTICES.md` 登记。

## 语言

- 中文为主。每个模块 README 以中文撰写，末尾附一段英文摘要；根目录另维护完整英文版 `README.en.md`，改动根 README 时同步更新两个语言版本。
- 代码、提交信息、测试名称和 CI 用英文。
- `lab-context-distillation-wx` 的历史文档以英文为主，保留原样；其 README 顶部提供中文摘要。
