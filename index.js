/**
 * @dsh-plugin/idle-scholar — host half.
 *
 * Idle-time micro-learning for DeepSeek Harness. The model is taught (via a
 * system-prompt section and an embedded skill) to show **one** study card at
 * the start of turns that will keep the user waiting — a long tool call, an
 * MCP connect, a large file read — and the plugin supplies the cards:
 *
 * - `study_card` draws a card from the course packs with seen-weighting
 *   (never-seen cards first, immediate repeats excluded) and records progress.
 * - `study_status` reports today's count, the streak, and per-course coverage.
 * - `study_switch` changes the default course, persisted across sessions.
 *
 * Course packs are plain JSON (`courses/<course>/<deck>.json`), so a community
 * pack is a PR that adds files — no core changes. An extra directory can be
 * mounted via the `coursesDir` config without touching the bundled decks.
 *
 * @module @dsh-plugin/idle-scholar
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  CARD_TYPE_LABELS,
  deckIds,
  filterPool,
  flattenCards,
  groupCourses,
  loadCourseRoot,
  pickCard,
} from './courses.js'
import {
  cardRecord,
  createState,
  makeWeightOf,
  normalizeState,
  recordDraw,
  summarize,
} from './progress.js'
import { SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE, skillBody } from './skill.js'

export const name = 'idle-scholar'
export const inject = ['tools']

/** Settings namespace; the join key between the host half and the settings page. */
export const SETTINGS_NS = 'idle-scholar'

/** Bundled course packs, relative to this module. */
const BUNDLED_COURSES = join(dirname(fileURLToPath(import.meta.url)), 'courses')

/** Default state file, beside the rest of the harness's per-user data. */
function defaultStatePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'idle-scholar.json')
}

/** Schemastery configuration for the plugin. */
export const Config = z.object({
  /** Master switch: gates the system-prompt section, the only nagging surface. */
  enabled: z.boolean().default(true).volatile(),
  /** Course drawn by `study_card` when the caller passes no course. */
  defaultCourse: z.string().default('en').volatile(),
  /** Cards the user should see per day; used for progress reporting. */
  dailyGoal: z.number().default(10).volatile(),
  /** Expose the system-prompt section that teaches the gap-trigger rule. */
  promptSection: z.boolean().default(true).volatile(),
  /** Register the embedded `idle-scholar` skill. */
  skill: z.boolean().default(true).volatile(),
  /** Extra directory of course packs, loaded in addition to the bundled decks. */
  coursesDir: z.string(),
  /** Absolute path of the persisted state file. Defaults to `$DSH_HOME/idle-scholar.json`. */
  stateFile: z.string(),
})

/**
 * Resolve the boot-time config's volatile references once: volatile Config
 * fields arrive as stable refs whose `.get()` follows hot reloads, and every
 * read below wants one plain snapshot.
 * @param config Validated plugin config.
 */
function unwrapVolatileConfig(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]))
}

/** Normalized, runtime-ready configuration. */
function normalizeConfig(raw = {}) {
  const dailyGoal = Number.isFinite(raw.dailyGoal) && raw.dailyGoal > 0 ? Math.floor(raw.dailyGoal) : 10
  return {
    enabled: raw.enabled !== false,
    defaultCourse: typeof raw.defaultCourse === 'string' && raw.defaultCourse !== '' ? raw.defaultCourse : 'en',
    dailyGoal,
    promptSection: raw.promptSection !== false,
    skill: raw.skill !== false,
    coursesDir: typeof raw.coursesDir === 'string' && raw.coursesDir !== '' ? raw.coursesDir : undefined,
    stateFile: typeof raw.stateFile === 'string' && raw.stateFile !== '' ? raw.stateFile : undefined,
  }
}

const PROMPT_SECTION = `Idle-study cards (idle-scholar plugin):
- The user opted into micro-learning. When a turn of yours will keep them waiting (long tool call, MCP connect/login, large file read, subagent dispatch), you may prepend ONE study card at the very start of that turn, then continue the main task immediately.
- To draw a card, call \`study_card\` (optional \`course\`: en=English, ja=Japanese, faka=judicial exam; optional \`deck\` such as \`faka-xingfa\`). Show the card verbatim in 5 lines or fewer; never fabricate deck content when the tool is available.
- At most one card per turn, and only when a real waiting gap exists. If the user says 别学了 / stop studying, stop offering cards for the rest of the session.
- For progress call \`study_status\`; to change the subject call \`study_switch\`. Load the \`idle-scholar\` skill for the full workflow before doing anything beyond those calls.`

/**
 * Register the plugin.
 * @param ctx - the host context.
 * @param config - the resolved composition configuration.
 */
export function apply(ctx, config) {
  let current = normalizeConfig(unwrapVolatileConfig(config))

  const runtime = {
    /** Loaded decks; replaced wholesale by reload(). */
    decks: [],
    /** Deck ids that failed to load, for status reporting. */
    deckErrors: [],
    /** Persisted state; replaced wholesale by every mutation. */
    state: createState(),
    /** Serializes state writes so two mutations cannot interleave. */
    writes: Promise.resolve(),
    /** Set once the composition unloads; start-up work checks it before acting. */
    disposed: false,
  }

  const statePath = () => current.stateFile ?? defaultStatePath()

  /** Write the state file through a temp file so a crash cannot truncate it. */
  function save() {
    const payload = `${JSON.stringify(runtime.state, null, 2)}\n`
    const target = statePath()
    runtime.writes = runtime.writes
      .then(async () => {
        await mkdir(dirname(target), { recursive: true })
        const temporary = `${target}.tmp`
        await writeFile(temporary, payload, 'utf8')
        await rename(temporary, target)
      })
      .catch(error => ctx.logger.warn(`idle-scholar: state was not saved: ${String(error)}`))
    return runtime.writes
  }

  /**
   * Load course packs (bundled + optional extra dir) and the state file once
   * at start-up. A broken pack is logged and skipped; a missing state file
   * starts fresh. Drained by the disposal barrier.
   */
  const ready = (async () => {
    const roots = [BUNDLED_COURSES]
    if (current.coursesDir !== undefined) roots.push(current.coursesDir)
    const decks = []
    const errors = []
    for (const root of roots) {
      const loaded = await loadCourseRoot(root)
      decks.push(...loaded.decks)
      errors.push(...loaded.errors)
    }
    runtime.decks = decks
    runtime.deckErrors = errors
    for (const message of errors) {
      ctx.logger.warn(`idle-scholar: ${message}`)
    }
    try {
      runtime.state = normalizeState(JSON.parse(await readFile(statePath(), 'utf8')))
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        ctx.logger.warn(`idle-scholar: state was not restored: ${String(error)}`)
      }
      runtime.state = createState()
    }
  })()

  /** Course summaries for reporting and the `study_switch` enum. */
  function courses() {
    return groupCourses(runtime.decks)
  }

  /** The effective default course: state override, else config. */
  function effectiveCourse() {
    return runtime.state.course ?? current.defaultCourse
  }

  /**
   * One-line course catalog for status output: "en 英语 (3 decks · 57 cards) · ...".
   */
  function coursesText() {
    return courses()
      .map((course) => {
        const cards = course.decks.reduce((sum, deck) => sum + deck.cards.length, 0)
        return `${course.id} ${course.name} (${course.decks.length} decks · ${cards} cards)`
      })
      .join(' · ')
  }

  // --- Tools ---------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'study_card',
    description:
      'Draw one study card (idle-scholar). Prefer calling it at the start of a turn that will keep the user '
      + 'waiting, and show the card in 5 lines or fewer before continuing the main task. Supports course and '
      + 'deck filters; tracks daily progress and a streak automatically.',
    parameters: {
      course: {
        type: 'string',
        description: 'Course id, e.g. "en" (English), "ja" (Japanese), "faka" (judicial exam). Defaults to the user\'s current course.',
      },
      deck: {
        type: 'string',
        description: 'Deck id to narrow the draw, e.g. "en-vocab", "faka-xingfa". Takes precedence over `course`.',
      },
      type: {
        type: 'string',
        description: `Card type filter: ${Object.keys(CARD_TYPE_LABELS).join(', ')}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cardId: { type: 'string', required: true },
          courseId: { type: 'string', required: true },
          deckName: { type: 'string', required: true },
          type: { type: 'string', required: true },
          typeLabel: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          hint: { type: 'string', required: true },
          choicesText: { type: 'string', required: true },
          answer: { type: 'string', required: true },
          explanation: { type: 'string', required: true },
          tagsText: { type: 'string', required: true },
          timesSeen: { type: 'number', required: true },
          todayCount: { type: 'number', required: true },
          dailyGoal: { type: 'number', required: true },
          streakDays: { type: 'number', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Study card [${value.courseId} · ${value.deckName} · ${value.typeLabel}] ${value.cardId}`,
          value.prompt,
          value.hint === '' ? '' : `(hint: ${value.hint})`,
          value.choicesText === '' ? '' : value.choicesText,
          `Answer: ${value.answer}`,
          value.explanation,
          `Progress: ${value.todayCount}/${value.dailyGoal} today, ${value.streakDays}d streak, seen ${value.timesSeen}x`,
        ].filter(line => line !== '').join('\n'),
      }],
    },
    async execute(args) {
      await ready
      const pool = flattenCards(runtime.decks)
      const filter = {}
      if (args.deck !== undefined) filter.deck = args.deck
      else if (args.course !== undefined) filter.course = args.course
      else filter.course = effectiveCourse()
      if (args.type !== undefined) filter.type = args.type
      const rows = filterPool(pool, filter)
      if (rows.length === 0) {
        const available = coursesText()
        throw new Error(`no cards match ${JSON.stringify(filter)}; available courses: ${available === '' ? 'none loaded' : available}`)
      }
      const now = new Date()
      const drawn = pickCard(rows, { weightOf: makeWeightOf(runtime.state, { now }) })
      if (drawn === undefined) throw new Error('no card could be drawn')
      const { card, deck } = drawn
      recordDraw(runtime.state, card.id, now)
      await save()
      const progress = summarize(runtime.state, { dailyGoal: current.dailyGoal, totalCards: pool.length, now })
      const record = cardRecord(runtime.state, card.id, now)
      const letters = ['A', 'B', 'C', 'D', 'E', 'F']
      return {
        cardId: card.id,
        courseId: deck.course,
        deckName: deck.name,
        type: card.type,
        typeLabel: CARD_TYPE_LABELS[card.type] ?? card.type,
        prompt: card.prompt,
        hint: card.hint ?? '',
        choicesText: Array.isArray(card.choices)
          ? card.choices.map((choice, index) => `${letters[index] ?? index}. ${choice}`).join('\n')
          : '',
        answer: card.type === 'quiz' && Array.isArray(card.choices) ? card.choices[card.answer] : card.answer,
        explanation: card.explanation,
        tagsText: Array.isArray(card.tags) ? card.tags.join(', ') : '',
        timesSeen: record.count,
        todayCount: progress.todayCount,
        dailyGoal: progress.dailyGoal,
        streakDays: progress.streakDays,
        message: progress.goalReached
          ? `Daily goal reached (${progress.todayCount}/${progress.dailyGoal}), ${progress.streakDays}d streak.`
          : `${progress.todayCount}/${progress.dailyGoal} today, ${progress.streakDays}d streak.`,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Draw a study card${args?.deck !== undefined ? ` (${args.deck})` : args?.course !== undefined ? ` (${args.course})` : ''}`,
      kind: 'other',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'study_status',
    description:
      'Report idle-study progress: today\'s card count against the daily goal, the streak, lifetime draws, '
      + 'deck coverage, and the available courses. Use before answering any "how much have I studied" question.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          courseId: { type: 'string', required: true },
          todayCount: { type: 'number', required: true },
          dailyGoal: { type: 'number', required: true },
          goalReached: { type: 'boolean', required: true },
          streakDays: { type: 'number', required: true },
          totalDraws: { type: 'number', required: true },
          uniqueSeen: { type: 'number', required: true },
          totalCards: { type: 'number', required: true },
          percentSeen: { type: 'number', required: true },
          deckErrors: { type: 'number', required: true },
          coursesText: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Idle-study: ${value.todayCount}/${value.dailyGoal} today (${value.goalReached ? 'goal reached' : 'in progress'}), ${value.streakDays}d streak`,
          `Coverage: ${value.uniqueSeen}/${value.totalCards} cards (${value.percentSeen}%), ${value.totalDraws} lifetime draws`,
          `Course: ${value.courseId}`,
          value.deckErrors > 0 ? `Warning: ${value.deckErrors} deck file(s) failed to load` : '',
          `Available: ${value.coursesText}`,
        ].filter(line => line !== '').join('\n'),
      }],
    },
    async execute() {
      await ready
      const pool = flattenCards(runtime.decks)
      const progress = summarize(runtime.state, {
        dailyGoal: current.dailyGoal,
        totalCards: pool.length,
        now: new Date(),
      })
      const message = progress.goalReached
        ? `Goal reached — ${progress.streakDays} day streak.`
        : `${progress.dailyGoal - progress.todayCount} more cards today.`
      return {
        courseId: effectiveCourse(),
        todayCount: progress.todayCount,
        dailyGoal: progress.dailyGoal,
        goalReached: progress.goalReached,
        streakDays: progress.streakDays,
        totalDraws: progress.totalDraws,
        uniqueSeen: progress.uniqueSeen,
        totalCards: progress.totalCards,
        percentSeen: progress.percentSeen,
        deckErrors: runtime.deckErrors.length,
        coursesText: coursesText(),
        message,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check study progress', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'study_switch',
    description:
      'Switch the default study course (persisted across sessions). Call it when the user wants to study a '
      + 'different subject; the next `study_card` without arguments draws from the new course.',
    parameters: {
      course: {
        type: 'string',
        required: true,
        description: 'Course id, e.g. "en", "ja", "faka".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          courseId: { type: 'string', required: true },
          deckCount: { type: 'number', required: true },
          cardCount: { type: 'number', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Default course: ${value.courseId} — ${value.message}`,
      }],
    },
    async execute(args) {
      await ready
      const available = courses()
      const match = available.find(course => course.id === args.course)
      if (match === undefined) {
        throw new Error(`unknown course '${args.course}'; available: ${coursesText() || 'none loaded'}`)
      }
      runtime.state.course = match.id
      await save()
      const cards = match.decks.reduce((sum, deck) => sum + deck.cards.length, 0)
      return {
        courseId: match.id,
        deckCount: match.decks.length,
        cardCount: cards,
        message: `${match.decks.length} decks, ${cards} cards loaded.`,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Switch study course to ${args.course}`, kind: 'other' }),
  }))

  // The `study_switch` enum needs the loaded deck ids, but registration runs
  // before the async load. Patch the schema once the decks are known.
  void ready.then(() => {
    const ids = deckIds(runtime.decks)
    if (ids.length === 0) return
    const schema = ctx.tools.schemas().find(tool => tool.name === 'study_switch')
    const parameter = schema?.parameters?.course
    if (parameter !== undefined) parameter.enum = ids
  }).catch(() => {})

  // --- Optional surfaces ---------------------------------------------------

  // The prompt section mounts only where a system prompt is composed, and it
  // is the only surface that can nag — so `enabled` gates exactly this.
  if (current.enabled && current.promptSection !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      ctx.effect(() => promptCtx.systemPrompt.section({
        name: 'idle-scholar',
        order: 170,
        text: PROMPT_SECTION,
      }), 'idle-scholar: prompt section')
    })
  }

  // The embedded skill is the same instructions as skills/idle-scholar/SKILL.md;
  // registering it here means the model gets them with no filesystem skill root.
  if (current.skill !== false) {
    ctx.inject(['skills'], (skillCtx) => {
      ctx.effect(() => skillCtx.skills.register({
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION,
        whenToUse: SKILL_WHEN_TO_USE,
        source: 'runtime',
        content: skillBody(),
      }), 'idle-scholar: embedded idle-scholar skill')
    })
  }

  // Settings-driven configuration: the page's writes persist as volatile
  // Config fields; the document-updated event re-reads them for goal or
  // default-course changes.
  ctx.inject(['settings'], (settingsCtx) => {
    ctx.on('settings/document-updated', (ns) => {
      if (ns !== SETTINGS_NS) return
      const served = settingsCtx.settings.describe().find((row) => row.ns === SETTINGS_NS)?.value
      if (served === undefined) return
      current = normalizeConfig(served)
    })
  })

  // Disposal waits for start-up to settle and for any in-flight write, so a
  // composition that unloads mid-load cannot touch the disk afterwards.
  ctx.effect(() => () => {
    runtime.disposed = true
    return ready.catch(() => {}).then(() => runtime.writes)
  }, 'idle-scholar: state lifecycle')
}
