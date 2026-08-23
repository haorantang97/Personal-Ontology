# Personal-Ontology

面向个人上下文、证据化记忆和长期 Agent 协作的原创 Skill 仓库。

这个根目录只负责介绍与索引。每个 Skill 都是 `skills/` 下的独立模块，安装、权限、运行方式、测试和限制以对应模块自己的 README 为准。

## Skills

| Skill | 用途 | 当前状态 | 安装与文档 |
| --- | --- | --- | --- |
| `lab-context-distillation` | 将用户授权的微信或其他对话资料，经本地采集、解密适配、脱敏、证据化蒸馏和验收，整理为可追溯的个人上下文包 | 合成/公开 fixture 已验证；真实微信版本按能力分别待实机验证 | [打开 Skill 文档](skills/lab-context-distillation/README.md) |

## Quick install

使用社区 Agent Skills 安装器：

```bash
npx skills add haorantang97/Personal-Ontology --skill lab-context-distillation
```

也可以只复制完整的 `skills/lab-context-distillation/` 目录。Codex、Claude Code、直接运行和卸载说明都在该 Skill 的[安装文档](skills/lab-context-distillation/README.md#installation)中。

## Repository rules

- 根 README 不重复具体 Skill 的操作手册。
- Skill 默认保持厂商与模型无关；不同 Agent 只使用不同安装位置。
- 每个模块单独声明验证状态、隐私边界和第三方依赖。
- 公开 fixture 通过不等于真实设备或具体微信小版本兼容。

## License

除模块另有明确声明外，本仓库采用“公开可查看、个人非商业使用”的许可草案。商业使用、企业部署、客户交付、再包装或再分发需要权利人的书面授权。发布前仍需律师复核，详见 [LICENSE.md](LICENSE.md)。

---

Original personal-ontology Skills. The repository root is a catalog; each module under `skills/` contains its authoritative installation, privacy, validation, and usage documentation.
