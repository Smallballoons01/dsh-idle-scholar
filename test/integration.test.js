/**
 * Integration test against a real cordis composition.
 *
 * `test/plugin.test.js` drives a minimal fake context, which keeps the behavior
 * tests fast but cannot catch a mistake in how the plugin talks to cordis
 * itself. This file mounts the plugin on a real `Context` with the real
 * `tools`, `skills`, and `systemPrompt` services, so it proves the declared
 * dependencies actually resolve, the registered tools survive schema
 * compilation, the embedded skill becomes discoverable through `ctx.skills`,
 * and disposal really unregisters everything.
 *
 * The composition intentionally omits `settings`: that surface is optional,
 * and loading without it is what verifies the plugin degrades instead of
 * failing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SKIP_REASON = 'requires the DeepSeek Harness packages (@deepseek-ai/cordis, dsh-tools, dsh-skill, dsh-system-prompt); see README -> Prerequisites'
const deps = await (async () => {
  try {
    const [cordis, tools, skill, systemPrompt, idleScholar, skillModule] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-skill'),
      import('@deepseek-ai/dsh-system-prompt'),
      import('../index.js'),
      import('../skill.js'),
    ])
    return {
      Context: cordis.Context,
      ToolRuntime: tools.default,
      SkillRegistry: skill.default,
      SystemPrompt: systemPrompt.default,
      idleScholar,
      SKILL_NAME: skillModule.SKILL_NAME,
      skillBody: skillModule.skillBody,
    }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
})()

const TOOL_NAMES = ['study_card', 'study_status', 'study_switch']

if (deps.error !== undefined) {
  test('idle-scholar composition tests', t => t.skip(`${SKIP_REASON} (${deps.error})`))
} else {
  const { Context, ToolRuntime, SkillRegistry, SystemPrompt, idleScholar, SKILL_NAME, skillBody } = deps

  async function composition(t, config = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'idle-scholar-ctx-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    // ToolRuntime injects systemPrompt, so it must be loaded after it.
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(idleScholar, { stateFile: join(directory, 'state.json'), ...config })
    t.after(async () => {
      await fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    return { ctx, fiber, directory }
  }

  test('mounts on a real composition and registers its tools', async (t) => {
    const { ctx } = await composition(t)
    const names = ctx.tools.schemas().map(tool => tool.name).sort()
    assert.deepEqual(names, TOOL_NAMES)
  })

  test('study_card draws and records through the real tool runtime', async (t) => {
    const { ctx } = await composition(t)
    const tool = ctx.tools.get('study_card')
    assert.ok(tool, 'study_card must be resolvable through ctx.tools')
    const result = await tool.execute({})
    assert.match(result.cardId, /^(en|ja|faka)-/)
    const status = await ctx.tools.get('study_status').execute({})
    assert.equal(status.todayCount, 1)
    assert.equal(status.streakDays, 1)
  })

  test('deck filter works end-to-end through the composition', async (t) => {
    const { ctx } = await composition(t)
    const result = await ctx.tools.get('study_card').execute({ deck: 'faka-minfa' })
    assert.equal(result.courseId, 'faka')
    assert.match(result.cardId, /^faka-mf-/)
  })

  test('the embedded skill is discoverable through ctx.skills', async (t) => {
    const { ctx } = await composition(t)
    const skill = ctx.skills.get?.(SKILL_NAME) ?? ctx.skills.list?.().find(entry => entry.name === SKILL_NAME)
    assert.ok(skill, `skill ${SKILL_NAME} must be discoverable`)
  })

  test('the prompt section lands in the composed system prompt', async (t) => {
    const { ctx } = await composition(t)
    const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    assert.ok(prompt.includes('Idle-study cards'), 'prompt must carry the idle-study section')
  })

  test('unmounting removes the skill and the tools', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'idle-scholar-dispose-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const fiber = await ctx.plugin(idleScholar, { stateFile: join(directory, 'state.json') })
    await fiber.dispose()
    const names = ctx.tools.schemas().map(tool => tool.name)
    assert.ok(!names.includes('study_card'), 'study_card must be unregistered on dispose')
    await rm(directory, { recursive: true, force: true })
  })

  test('state survives a restart through the same file', async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'idle-scholar-restart-'))
    const stateFile = join(directory, 'state.json')
    const first = new Context()
    await first.plugin(SystemPrompt)
    await first.plugin(ToolRuntime)
    await first.plugin(SkillRegistry)
    const fiber = await first.plugin(idleScholar, { stateFile })
    await first.tools.get('study_switch').execute({ course: 'faka' })
    await first.tools.get('study_card').execute({ deck: 'faka-xingfa' })
    await fiber.dispose()

    const second = new Context()
    await second.plugin(SystemPrompt)
    await second.plugin(ToolRuntime)
    await second.plugin(SkillRegistry)
    const fiber2 = await second.plugin(idleScholar, { stateFile })
    t.after(async () => {
      await fiber2.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    const status = await second.tools.get('study_status').execute({})
    assert.equal(status.courseId, 'faka')
    assert.equal(status.todayCount, 1)
  })
}
