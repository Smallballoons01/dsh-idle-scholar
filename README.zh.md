# idle-scholar

DeepSeek Harness 的等待间隙碎片学习插件：把 agent 的等待空档（调工具、连
MCP、读大文件、跑子 agent）变成学习卡片——每次等待一张卡，不打断主任务。

内置三个课程的种子题库：**英语**、**日语**、**法考八科**（刑法 · 民法 · 刑诉 ·
民诉 · 行政法 · 商经知 · 三国法 · 理论法）。新学科就是一份 JSON 课程包——
社区贡献一个 deck = 提交一个文件。

## 工作方式

插件教模型两件事，并给它供卡：

1. **系统提示词 section**——当本回合会让用户等待时，在输出最开头先给一张
   学习卡，然后立刻继续主任务。卡片是等待时的状态提示，不能让用户等它。
2. **内嵌技能**（`idle-scholar`）——完整工作流：卡片格式、课程轮换、
   「别学了」即停。

三个工具负责内容与进度：

| 工具 | 作用 |
| --- | --- |
| `study_card` | 抽一张卡（可选 `course` / `deck` / `type` 过滤）。带权重选卡：没见过的优先、刚抽过的不重复。 |
| `study_status` | 今日张数 vs 每日目标、连续天数、题库覆盖、课程列表。 |
| `study_switch` | 切换默认课程，跨会话持久化。 |

进度（每张卡的看过次数、每日张数、连续天数）存放在
`$DSH_HOME/idle-scholar.json`，不进仓库。

## 安装（DSH 插件）

```bash
dsh plugin --profile web add /path/to/idle_scholar
```

然后重载 harness。DeepSeek Harness ≥ 0.2.1-alpha.3 且开启热重载时，插件代码更新无需重启即可生效；首次安装仍需重启。如果 profile 的 `cordis.patch.yml` 里已有 `idle-scholar` 行，先删掉——重复注册会导致启动失败。

> 用 `dsh … --from-default-profile` 重建 profile 会**整体替换**该 profile（含插件列表），之后需要重新添加本插件。

## 安装（独立 skill，任意 agent 工具）

技能本体是可移植的 Agent Skills 文件：

```bash
cp -r skills/idle-scholar ~/.claude/skills/   # 或 ~/.agents/skills、~/.codex/skills 等
```

没有插件工具时技能照样可用：模型按
`skills/idle-scholar/references/course-topics.md` 的主题表实时生成卡片。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。只控制系统提示词 section（唯一主动打扰面）；工具与技能始终挂载。 |
| `defaultCourse` | `'en'` | `study_card` 不带过滤参数时的默认课程。 |
| `dailyGoal` | `10` | 每日目标卡数，用于进度展示。 |
| `promptSection` | `true` | 是否暴露系统提示词 section。 |
| `skill` | `true` | 是否注册内嵌 `idle-scholar` 技能。 |
| `coursesDir` | — | 额外的课程包目录，与内置 deck 一起加载。 |
| `stateFile` | `$DSH_HOME/idle-scholar.json` | 进度文件位置。 |

## 课程包格式

一个 **deck** 是 `courses/<course>/<deck>.json` 下的一个 JSON 文件：

```json
{
  "id": "en-vocab",
  "course": "en",
  "name": "英语核心词汇",
  "cards": [
    {
      "id": "en-vocab-001",
      "type": "vocab",
      "prompt": "**serendipity** 是什么意思？",
      "hint": "名词，与「偶然」有关",
      "answer": "意外发现美好事物的运气；机缘巧合",
      "explanation": "词源出自童话《The Three Princes of Serendip》。",
      "tags": ["CET6"]
    },
    {
      "id": "en-quiz-001",
      "type": "quiz",
      "prompt": "Neither of the reports ___ been proofread.",
      "choices": ["have", "has", "are", "were"],
      "answer": 1,
      "explanation": "neither of + 复数名词，正式语法中谓语用单数。"
    }
  ]
}
```

卡片类型：`vocab`（词汇卡）、`quiz`（选择题，`answer` 是 `choices` 的下标）、
`concept`（概念卡）、`tip`（贴士卡）。所有卡片必须带非空 `explanation`。

### 贡献新学科

1. 按上面的格式新建 `courses/<course-id>/<deck-id>.json`（deck id 与 card id
   必须全局唯一，`test/decks.test.js` 会强制检查）。
2. 把新课程和主题范围加进
   `skills/idle-scholar/references/course-topics.md`，让纯 skill 部署也能
   生成贴题的卡片。
3. 更新 `skill.js` 里的课程表（`npm run skill` 重新生成 `SKILL.md`；
   `npm run skill:check` 校验一致性）。
4. `npm test`——deck 校验器会抓出所有格式问题。

## 开发

```bash
npm test            # 单测 + 假 ctx 行为测试 + 真实 cordis 集成测试
npm run skill:check # SKILL.md 与 skill.js 保持同步
```

前置条件：集成测试在运行时 import DeepSeek Harness 的包
（`@deepseek-ai/cordis`、`dsh-tools`、`dsh-skill`、`dsh-system-prompt`）。
它们是 `peerDependencies`——从你的 harness 源码或 profile 软链过来即可；
解析不到时测试会以明确原因跳过。

## Roadmap

- [ ] Web 面板（设置卡片 + 侧边栏连续天数挂件）
- [ ] 间隔重复（SM-2 式排程替代当前的看过加权）
- [ ] 更多种子题库：法考案例题、TOEFL/IELTS、文言文

## License

[MIT](LICENSE)
