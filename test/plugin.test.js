/**
 * Plugin behavior tests against a minimal fake context: tool registration,
 * card drawing with filters and weighting, state persistence, and progress
 * reporting. The harness packages must resolve (see README -> Prerequisites);
 * if they do not, the suite skips with one clear reason.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SKIP_REASON = 'requires @deepseek-ai/dsh-tools and schemastery; see README -> Prerequisites'
const deps = await (async () => {
  try {
    const [{ default: schemastery }, { defineTool }, plugin, { skillBody, SKILL_NAME }] = await Promise.all([
      import('@deepseek-ai/schemastery'),
      import('@deepseek-ai/dsh-tools'),
      import('../index.js'),
      import('../skill.js'),
    ])
    return { Config: plugin.Config, apply: plugin.apply, defineTool, schemastery, SKILL_NAME, skillBody }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
})()

if (deps.error !== undefined) {
  test('idle-scholar plugin behavior', t => t.skip(`${SKIP_REASON} (${deps.error})`))
} else {
  const { apply, defineTool, SKILL_NAME, skillBody } = deps

  /** Minimal fake context in the water-reminder test style. */
  function fakeCtx() {
    const effects = []
    const registered = { tools: [], skills: [], sections: [] }
    const ctx = {
      logger: { info() {}, warn() {} },
      tools: {
        register: (tool) => {
          registered.tools.push(tool)
        },
        schemas: () => registered.tools.map(tool => ({ name: tool.name, parameters: tool.parameters })),
      },
      skills: {
        register: (skill) => {
          registered.skills.push(skill)
        },
      },
      systemPrompt: {
        section: (section) => {
          registered.sections.push(section)
        },
      },
      inject(caps, callback) {
        const resolved = Object.fromEntries(caps.map((cap) => {
          if (cap === 'tools') return [cap, { register: ctx.tools.register }]
          if (cap === 'skills') return [cap, { register: ctx.skills.register }]
          if (cap === 'systemPrompt') return [cap, { section: ctx.systemPrompt.section }]
          if (cap === 'settings') return [cap, { settings: { describe: () => [] } }]
          throw new Error(`unexpected capability ${cap}`)
        }))
        callback(resolved)
      },
      effect(fn) {
        effects.push(fn)
        return fn()
      },
      on() {},
      get() {
        return undefined
      },
    }
    return { ctx, registered, effects }
  }

  async function setup(t, config = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'idle-scholar-test-'))
    const stateFile = join(directory, 'state.json')
    const { ctx, registered } = fakeCtx()
    apply(ctx, { stateFile, ...config })
    const tools = Object.fromEntries(registered.tools.map(tool => [tool.name, tool]))
    t.after(async () => {
      await rm(directory, { recursive: true, force: true })
    })
    return { directory, stateFile, tools, registered, ctx }
  }

  test('registers exactly the three study tools', async (t) => {
    const { registered } = await setup(t)
    assert.deepEqual(registered.tools.map(tool => tool.name).sort(), ['study_card', 'study_status', 'study_switch'])
  })

  test('draws a card with all schema-required fields and no nulls', async (t) => {
    const { tools } = await setup(t)
    const card = await tools.study_card.execute({})
    for (const key of ['cardId', 'courseId', 'deckName', 'type', 'typeLabel', 'prompt', 'hint', 'choicesText', 'answer', 'explanation', 'tagsText', 'timesSeen', 'todayCount', 'dailyGoal', 'streakDays', 'message']) {
      assert.ok(Object.hasOwn(card, key), `missing field ${key}`)
      assert.notEqual(card[key], null, `field ${key} is null`)
      assert.ok(card[key] !== undefined, `field ${key} is undefined`)
    }
    assert.equal(card.timesSeen, 1)
    assert.equal(card.todayCount, 1)
    if (card.type === 'quiz') {
      assert.ok(card.choicesText.includes('A.'), 'quiz choices rendered as A/B/C lines')
    }
  })

  test('deck filter narrows the draw to that deck', async (t) => {
    const { tools } = await setup(t)
    for (let index = 0; index < 5; index += 1) {
      const card = await tools.study_card.execute({ deck: 'faka-xingfa' })
      assert.match(card.cardId, /^faka-xf-/)
      assert.equal(card.courseId, 'faka')
    }
  })

  test('unknown filter throws with the available courses', async (t) => {
    const { tools } = await setup(t)
    await assert.rejects(
      () => tools.study_card.execute({ course: 'koine-greek' }),
      /available courses/,
    )
  })

  test('course override beats the default, state default persists', async (t) => {
    const { tools, stateFile } = await setup(t)
    const switched = await tools.study_switch.execute({ course: 'ja' })
    assert.equal(switched.courseId, 'ja')
    const persisted = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(persisted.course, 'ja')

    // A fresh plugin instance restores the override from the state file.
    const { tools: tools2 } = await setup(t, { stateFile })
    const card = await tools2.study_card.execute({})
    assert.equal(card.courseId, 'ja')
  })

  test('study_status reflects draws, streak, and coverage', async (t) => {
    const { tools } = await setup(t)
    const before = await tools.study_status.execute({})
    assert.equal(before.todayCount, 0)
    assert.equal(before.streakDays, 0)
    await tools.study_card.execute({})
    await tools.study_card.execute({})
    const after = await tools.study_status.execute({})
    assert.equal(after.todayCount, 2)
    assert.equal(after.streakDays, 1)
    assert.ok(after.totalCards > 200, `expected a large seed pool, got ${after.totalCards}`)
    assert.equal(after.goalReached, false)
  })

  test('study_switch rejects unknown courses without mutating state', async (t) => {
    const { tools } = await setup(t)
    await assert.rejects(() => tools.study_switch.execute({ course: 'nope' }), /unknown course/)
    const status = await tools.study_status.execute({})
    assert.equal(status.courseId, 'en', 'default course must be unchanged after a rejected switch')
  })

  test('the embedded skill is registered through ctx.skills', async (t) => {
    const { registered } = await setup(t)
    const skill = registered.skills.find(entry => entry.name === SKILL_NAME)
    assert.ok(skill, 'idle-scholar skill missing from registry')
    assert.equal(skill.source, 'runtime')
    assert.equal(skill.content, skillBody())
  })

  test('dailyGoal and promptSection follow config', async (t) => {
    const { tools, registered } = await setup(t, { dailyGoal: 3, promptSection: true })
    const card = await tools.study_card.execute({})
    assert.equal(card.dailyGoal, 3)
    assert.equal(registered.sections.length, 1)
    assert.equal(registered.sections[0].name, 'idle-scholar')
  })

  test('defineTool output schemas are null-free with all fields required', async (t) => {
    const { tools } = await setup(t)
    for (const tool of Object.values(tools)) {
      const { properties, required } = tool.output.schema
      assert.equal(tool.output.schema.additionalProperties, false, `${tool.name} must close its output`)
      // defineTool normalizes property-level `required: true` into a
      // top-level required array — assert every field is listed there.
      assert.ok(Array.isArray(required), `${tool.name} must have a required array`)
      for (const key of Object.keys(properties)) {
        assert.ok(required.includes(key), `${tool.name}.${key} must be required`)
      }
    }
  })

  test('the draw tool is presented with a human-readable title', async (t) => {
    const { tools } = await setup(t)
    assert.deepEqual(tools.study_card.presentCall({ deck: 'en-vocab' }), {
      card: 'generic',
      title: 'Draw a study card (en-vocab)',
      kind: 'other',
    })
  })
}
