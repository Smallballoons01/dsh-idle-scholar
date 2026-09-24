/**
 * The checked-in skills/idle-scholar/SKILL.md must be byte-identical to what
 * skill.js generates — the registry skill and the filesystem skill are two
 * delivery paths for the same instructions, and drift between them would make
 * the two surfaces teach different behaviors.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_DESCRIPTION, SKILL_NAME, SKILL_WHEN_TO_USE, skillBody, skillMarkdown } from '../skill.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('skill name is kebab-case and registry-safe', () => {
  assert.equal(SKILL_NAME, 'idle-scholar')
  assert.match(SKILL_NAME, /^[a-z0-9-]+$/)
})

test('description and whenToUse are non-empty and within registry limits', () => {
  assert.ok(SKILL_DESCRIPTION.length > 0)
  assert.ok(SKILL_DESCRIPTION.length <= 1024, `description too long: ${SKILL_DESCRIPTION.length}`)
  assert.ok(SKILL_WHEN_TO_USE.includes('Use when'))
})

test('skill body teaches the core rules', () => {
  const body = skillBody()
  assert.ok(body.includes('study_card'), 'must reference the draw tool')
  assert.ok(body.includes('study_status'), 'must reference progress')
  assert.ok(body.includes('study_switch'), 'must reference switching')
  assert.ok(body.includes('别学了'), 'must honor the opt-out')
  assert.ok(body.includes('faka-xingfa'), 'must document judicial-exam decks')
  assert.ok(body.includes('en-vocab'), 'must document English decks')
})

test('skills/idle-scholar/SKILL.md is byte-identical to skillMarkdown()', async () => {
  const actual = await readFile(join(root, 'skills', 'idle-scholar', 'SKILL.md'), 'utf8')
  assert.equal(actual, skillMarkdown())
})

test('the frontmatter name matches the parent directory', async () => {
  const raw = await readFile(join(root, 'skills', 'idle-scholar', 'SKILL.md'), 'utf8')
  const match = raw.match(/^name: (.+)$/m)
  assert.equal(match?.[1], 'idle-scholar')
})
