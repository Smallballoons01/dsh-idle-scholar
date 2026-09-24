---
name: idle-scholar
description: Idle-time micro-learning: turn the agent's waiting gaps into one study card. Ships seed decks for English, Japanese, and the eight subjects of the Chinese National Judicial Examination (法考: 刑法/民法/刑诉/民诉/行政法/商经知/三国法/理论法); extensible with JSON course packs.
whenToUse: Use when the user mentions 学习、背单词、学英语、学日语、法考、司法考试、碎片时间学习, study, flashcard, vocabulary, judicial exam, or when a waiting gap is about to occur (tool call, MCP connect, large file read) and a passing study card would fit.
---

# Idle scholar — 等待间隙碎片学习

你负责把用户使用 agent 时的「等待间隙」变成碎片学习时间：调工具、连 MCP、读大文件、跑子 agent 的
几十秒到几分钟里，顺手展示**一张**学习卡。核心原则：**一回合一张、不打断主任务、随时可关。**

## 卡片从哪来（来源优先级）

1. **有 `study_card` 工具**（装了 idle-scholar 插件）：直接调用它抽卡。参数 `course` 可选
   （`en` 英语 / `ja` 日语 / `faka` 法考），`deck` 可选（如 `faka-xingfa` 刑法、`ja-grammar` 日语语法）。
   工具返回的进度字段（今日张数、连续天数）顺手带一句即可，不要展开成表格。
2. **没有工具**（纯 skill 部署）：按本文件第四节的课程主题表**实时生成**一张同类卡片，
   结构与内置卡一致（题目 → 提示 → 答案 → 解析）。生成内容拿不准的考点宁可不写细节，
   优先出词汇、常识类卡片，避免编造法条数字。

## 触发规则（什么时候出卡）

- **即将执行会产生等待的动作时**（调用工具、连接/登录 MCP、读大文件、调用子 agent、等待外部返回），
  在你本回合输出的**最开头**先给出一张学习卡，然后继续主任务。卡片是「等待时的状态提示」，
  必须让用户在等待开始前就看到它。
- 用户主动说「教我点英语 / 出张法考题 / 背个单词 / 学日语」时，立即出卡（手动入口）。
- **一个回合最多一张**。连续多回合等待时可以连出，但每回合仍只一张。
- 没有等待间隙时不要为了出卡而制造等待；用户在赶工或明确不耐烦时暂停出卡。

## 出卡格式（Markdown 文本卡）

```
📚 [英语 · 词汇] serendipity 是什么意思？
（提示：名词，与「偶然」有关）

答案：意外发现美好事物的运气；机缘巧合
—— 例：Meeting her at the conference was pure serendipity.
```

- 测验卡先列选项（A/B/C/D），答案与解析放末尾，给用户几秒自测空间（答案前空一行）。
- 概念卡/贴士卡同构：题目或标题 → 答案要点 → 一两句解析。
- 一张卡控制在 5 行以内；解析只保留最关键的一句。

## 课程与轮换

| 课程 | deck（可选过滤） | 内容 |
| --- | --- | --- |
| `en` 英语 | `en-vocab` 词汇 / `en-grammar` 语法 / `en-phrases` 短语 | CET4-6、雅思核心 |
| `ja` 日语 | `ja-vocab` 词汇 / `ja-grammar` 语法 / `ja-culture` 文化 | JLPT N5-N4 |
| `faka` 法考 | `faka-xingfa` 刑法 / `faka-minfa` 民法 / `faka-xingsusong` 刑诉 / `faka-minsusong` 民诉 / `faka-xingzhengfa` 行政法 / `faka-shangjingzhi` 商经知 / `faka-sanguofa` 三国法 / `faka-lilunfa` 理论法 | 客观题核心考点 |

- 默认用用户当前选择的课程（`study_status` 可查）；未选择时按会话语言避开载体语言（载体中文 → 优先英语或日语，载体英语 → 优先日语或法考）。
- 卡片类型四选一轮换：词汇卡 / 测验卡 / 概念卡 / 贴士卡，不要连着三张同一类型。
- 法考考点表述**以现行法条为准**；工具返回的解析已核对，实时生成时对具体数字（期限、金额）要谨慎，不确定就选概念题。

## 进度与控制

- 用户问「今天学了多少」→ `study_status`（返回今日张数、连续天数、总进度）。
- 用户想换学科 → `study_switch`（传课程 id），然后立刻出一张新学科的卡验证。
- 用户说「别学了 / stop / 关掉学习」→ **立刻停**，且本次会话不再主动出卡；不要追问原因。
- 进度只在用户问起或达成小里程碑（如连续 7 天）时提一句，平时不刷存在感。

## 语气

- 轻松、克制、像朋友顺手递过来一张卡片，而不是老师布置作业。
- 答错的追问（用户主动讨论某张卡）可以展开讲，那是用户要的深度；没问就点到为止。

## 快速示例

即将调用一个耗时的构建命令：
→ 回复开头出一张卡：「📚 [法考 · 刑法] 正当防卫的五个成立条件？」，然后写「顺便看张卡，构建大概要 2 分钟」，再继续执行任务。

用户：出张日语题
→ 调 `study_card` `{ course: "ja" }`，按返回内容展示卡片。
