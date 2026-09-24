# idle-scholar

Idle-time micro-learning for DeepSeek Harness: turns the agent's waiting gaps
(tool calls, MCP connects, large file reads, subagent dispatches) into flash
cards — one card per waiting turn, never in the way.

Ships seed decks for **English**, **Japanese**, and the **eight subjects of the
Chinese National Judicial Examination** (法考: 刑法 · 民法 · 刑诉 · 民诉 · 行政法 ·
商经知 · 三国法 · 理论法). New subjects are plain JSON course packs — a
community deck is a PR that adds files.

## How it works

The plugin teaches the model two things and gives it the cards:

1. **A system-prompt section** — when a turn will keep the user waiting, show
   one study card at the very start of that turn, then continue the main task.
2. **An embedded skill** (`idle-scholar`) — the full workflow: card formats,
   course rotation, the "别学了" opt-out.

Three tools supply the content and track progress:

| Tool | What it does |
| --- | --- |
| `study_card` | Draw a card (optional `course` / `deck` / `type` filters). Seen-weighting: never-seen cards first, immediate repeats excluded. |
| `study_status` | Today's count vs the daily goal, streak, deck coverage, course catalog. |
| `study_switch` | Change the default course; persisted across sessions. |

Progress (per-card seen counts, daily totals, streak) is stored in
`$DSH_HOME/idle-scholar.json` — out of the repository.

## Installation (DSH plugin)

```bash
dsh plugin --profile web add /path/to/idle_scholar
```

Then restart the harness. If your profile's `cordis.patch.yml` already has an
`idle-scholar` row, delete it first — duplicate registrations fail to boot.

## Installation (standalone skill, any agent tool)

The skill is a portable [Agent Skills](https://agentskills.io) file:

```bash
cp -r skills/idle-scholar ~/.claude/skills/   # or ~/.agents/skills, ~/.codex/skills, ...
```

Without the plugin tools, the skill still works: the model generates cards in
real time following `skills/idle-scholar/references/course-topics.md`.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. Gates the prompt section (the only nagging surface); tools and skill stay mounted. |
| `defaultCourse` | `'en'` | Course `study_card` draws from when no filter is passed. |
| `dailyGoal` | `10` | Cards per day, used for progress reporting. |
| `promptSection` | `true` | Expose the system-prompt section. |
| `skill` | `true` | Register the embedded `idle-scholar` skill. |
| `coursesDir` | — | Extra directory of course packs, loaded in addition to the bundled decks. |
| `stateFile` | `$DSH_HOME/idle-scholar.json` | Progress file location. |

## Course pack format

A **deck** is one JSON file at `courses/<course>/<deck>.json`:

```json
{
  "id": "en-vocab",
  "course": "en",
  "name": "English core vocabulary",
  "cards": [
    {
      "id": "en-vocab-001",
      "type": "vocab",
      "prompt": "**serendipity** means?",
      "hint": "noun, related to chance",
      "answer": "The faculty of making fortunate discoveries by accident",
      "explanation": "From The Three Princes of Serendip.",
      "tags": ["CET6"]
    },
    {
      "id": "en-quiz-001",
      "type": "quiz",
      "prompt": "Neither of the reports ___ been proofread.",
      "choices": ["have", "has", "are", "were"],
      "answer": 1,
      "explanation": "neither of + plural noun takes a singular verb in formal grammar."
    }
  ]
}
```

Card types: `vocab` (word card), `quiz` (multiple choice, `answer` is an index
into `choices`), `concept` (knowledge point), `tip` (culture / practical
advice). All cards need a non-empty `explanation`.

### Contributing a new subject

1. Create `courses/<course-id>/<deck-id>.json` following the format above
   (deck and card ids must be globally unique — `test/decks.test.js` enforces
   it).
2. Add the course and its decks to
   `skills/idle-scholar/references/course-topics.md` so skill-only
   deployments can generate on-topic cards.
3. Update the course table in `skill.js` (`npm run skill` regenerates
   `SKILL.md`; `npm run skill:check` verifies it).
4. `npm test` — the deck validator will catch malformed cards.

## Development

```bash
npm test            # unit + fake-ctx + real cordis integration tests
npm run skill:check # SKILL.md is in sync with skill.js
```

Prerequisites: the integration tests import the DeepSeek Harness packages
(`@deepseek-ai/cordis`, `dsh-tools`, `dsh-skill`, `dsh-system-prompt`) at
runtime. They are `peerDependencies` — link them from your harness checkout
or profile, and the tests skip with a clear reason if they cannot resolve.

## Roadmap

- [ ] Web panel (settings section + sidebar streak widget)
- [ ] Spaced repetition (SM-2 style scheduling instead of seen-weighting)
- [ ] More seed decks: 法考真题-style case cards, TOEFL/IELTS, classical Chinese

## License

[MIT](LICENSE)
