# Lab Life Reviewer / 人生回顾

`lab-life-reviewer` 是一个面向长期人生回顾的通用 Agent Skill。它通过主动访谈和当前主题相关材料，逐个还原人生事件，并把完成的 Raw 与 handoff 交给独立归档环节；它不会把复杂经历压缩成几行时间线，也不会把解释冒充事实。

它与 `lab-context-distillation-wx` 是同级模块：前者负责主动采访，后者主要从微信既有记录中批量提取。两者可以服务同一套个人上下文，但彼此不构成运行依赖。

## Installation

安装或复制完整目录。只复制 `SKILL.md` 会丢失采访、归档和 handoff 契约，不受支持。

### Community Agent Skills installer

```bash
npx skills add haorantang97/Personal-Ontology --skill lab-life-reviewer
```

### Codex

项目级安装位置：

```text
<project>/.agents/skills/lab-life-reviewer/
```

用户级安装位置：

```text
~/.agents/skills/lab-life-reviewer/
```

重新加载 Codex 后调用 `$lab-life-reviewer`，或直接提出“继续我的人生回顾”“采访这段职业经历”等匹配请求。

### Claude Code

项目级安装位置：

```text
<project>/.claude/skills/lab-life-reviewer/
```

用户级安装位置：

```text
~/.claude/skills/lab-life-reviewer/
```

Codex 与 Claude Code 使用同一份 `SKILL.md` 和 references，不维护两套分叉实现。

## Workflow

一个 Skill 包含两个前后衔接、但彼此独立的任务环节：

1. **采访与材料采集：**接收讲述、检查相关材料、保留 Raw 细节，并形成结构化 handoff。
2. **蒸馏与知识库归档：**读取 Raw、handoff 和相关材料，区分事实、解释、证据、假设与未决项，再形成精确知识库提案。

两个环节通过文件交接，归档任务不能依赖对采访聊天窗口的记忆。没有明确授权时，不自动创建新任务，也不执行知识库写入。

## Verify

从本目录运行 Skill 结构校验：

```bash
python3 /path/to/skill-creator/scripts/quick_validate.py .
```

同时确认以下中英文参考文件完整存在：

- `references/interview-stage.md` 与 `interview-stage.zh-CN.md`
- `references/archive-stage.md` 与 `archive-stage.zh-CN.md`
- `references/handoff-schema.md` 与 `handoff-schema.zh-CN.md`

## Privacy

- Raw 访谈、个人材料和人生证据永远保存在活动工作区或用户批准的位置，不写进 Skill 目录。
- 未明确授权的材料默认仅供当前任务内部使用。
- 轻度清洗不会扩大来源权限；多个来源合并时采用最严格限制。
- 用户一手自述、感受、自我解释、外部证据、AI 假设和未决矛盾必须分开。
- 知识库变更必须先生成精确提案，并在用户明确批准后执行。

## Upgrade

用经过审阅的新版本替换完整 Skill 目录。升级不得覆盖外部 Raw、handoff、归档检查点或知识库提案；恢复时从最后一个成功交接或归档节点继续。

## Uninstall

只删除 Agent Skills 位置中的 `lab-life-reviewer` 目录。采访 Raw、handoff 和其他外部材料不会自动删除，需要由用户另行审阅处理。

## License

本模块采用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)（全文见仓库根目录）：个人与非商业用途可自由使用、修改和分发；商业用途需另行取得著作权人的书面授权。

---

`lab-life-reviewer` is a provider-neutral Skill for interview-led, evidence-aware life review. It keeps interview collection and archival as two sequential stages connected by explicit Raw and handoff artifacts.
