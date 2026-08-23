---
name: lab-knowledge-retrospective
description: |
  把一段已经结束的工作蒸馏成可复用的结论，并按审批流程送进用户的 Obsidian/GBrain 知识库。
  触发方式：/lab-knowledge-retrospective、/复盘、「复盘一下」「总结这轮」「这次为什么失败」
  「蒸馏一下」「提炼结论」「把这次的经验沉淀下来」「这次有什么值得记下来的吗」「刚才那个坑记一下」。
  只要用户在一次任务、事故、访谈或长对话结束后，问「学到了什么 / 有什么值得留下的」，就必须使用本
  skill——即使他没说「复盘」「知识库」这些词。
  Use whenever a finished task, incident, interview, or long conversation should be turned into
  durable, reusable conclusions for the knowledge base — post-mortem, debrief, retrospective,
  "what did we learn", "anything worth keeping from this".
  本 skill 只产出经过审查的结论，自己绝不写知识库文件；写入一律交给 lab-knowledge-intake。
  不要用于还没结束的故障排查（用 gstack-investigate）、商业模式诊断（用 dbs-diagnosis）、
  或只是为了下次接着干活而保存状态（用 gstack-context-save）。
---

# Knowledge Retrospective

把「刚才发生了什么」变成「下次遇到同类情况该怎么做」。

**本文件是路由器，不是方法论。** 方法在知识库里，会更新；本文件不会。永远先去取方法，不要凭记忆复述。

## 1. 先取方法，再开始蒸馏

调用 `agent-knowledge` MCP 的 `knowledge_search`，按本次事件的类型检索并**完整读取**匹配的
method 页面，把检索到的内容当作当前方法。常见入口：

| 本次是什么 | 检索 |
|---|---|
| 写入 / apply / 校验失败 | `knowledge-gateway-write-failure-diagnosis` |
| 任务卡住、目标没达成 | `core-constraint-resource-feedback-loop` |
| 访谈或长对话 | `personal-context-interview-distillation`、`high-information-interview-method` |
| 判断某个人 | `behavior-deviation-log` |
| 结论给谁看、用什么形态 | `structured-expression-context-selection` |

上表只是入口，不是全集；先用 `knowledge_search` 搜，搜到更贴切的就用搜到的。检索不到匹配方法时，
明确说出「本次没有现成方法可依」，然后照常蒸馏——不要假装某个方法适用。

## 2. 把叙事和结论分开

过程叙述只作为草稿，不进知识库。一条候选结论必须能改变**别的时间、别的场合**的做法。

- 「这次 X 失败了，后来发现是 Y」——叙事。
- 「看到 X 这种报错时，先按 Y 处理，因为 Z」——结论。

分不清时问一句：把时间、地点、人物换掉，这句话还成立吗？不成立就是叙事。

## 3. 每条结论都要带证据和样本量

写清楚它建立在什么之上——哪一次运行、哪个文件、哪一行、哪一句原话——以及见过几次。
**n=1 就写 n=1。** 不要把一次观察四舍五入成规律。这对应 schema 里的 `evidence_status`
字段，是硬要求，不是修辞。

## 4. 默认产出为零

知识库 `AGENTS.md` 的收录门槛是**合取**的，全中才收。大多数复盘正确的结果是不新增任何页面。
「本次无可沉淀结论」是正常结论，不是失败，直接这么报告即可。

宁可少收：一条勉强及格的页面会污染检索，比没有更贵。

## 5. 先给人看，批准后再交接

把活下来的结论列给用户，等他明确批准。批准之后，按 `lab-knowledge-intake` skill 走提案流程。

- 绝不直接写 vault 文件，绝不绕过提案队列。
- 绝不把用户没批准的「顺手改进」塞进为别的目的发起的提案。
- 提案发出前，先在 vault 的临时副本里跑一遍 `node ops/validate-vault.mjs`。网关的回滚路径会
  掩盖真实的校验错误，报出来的会是一个跟真实原因无关的 git 错误，事后再查成本高得多。

## 6. 不要和邻居打架

这台机器上还有几个也会「记东西」的 skill，它们写进**不同的仓库**，不能互相替代：

- `gstack-learn` —— gstack 自己的 project learnings，跟着代码仓库走。
- `dbs-save` / `dbs-report` —— 商业诊断存档，在 `~/.dbs/sessions/`。
- `gstack-context-save` —— 为了下次接着干活的工作状态，不是长期知识。
- `gstack-investigate` —— 排查**还没结束**的故障；它负责把问题查清楚，本 skill 负责在它结束之后
  决定什么值得留下。两者是接力，不是二选一。

只有**跨项目、跨时间仍然成立**的结论才进 Obsidian/GBrain 知识库。属于上面某一类的，明确说出来
并路由过去。

## 7. 网关不可用时

如果 `agent-knowledge` 不可用，就说明知识网关不可用，把结论直接在对话里交付并停下。
不要退回到写一个无人管理的 Markdown 文件，也不要自己发明存放位置。
