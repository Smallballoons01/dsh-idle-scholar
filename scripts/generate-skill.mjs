#!/usr/bin/env node
/**
 * Generate `skills/idle-scholar/SKILL.md` from `skill.js` — the single source
 * of truth. Run `node scripts/generate-skill.mjs` after editing the skill
 * body; run it with `--check` (also wired as `npm run skill:check`) to assert
 * the checked-in file is current, e.g. from CI.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillMarkdown } from '../skill.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'skills', 'idle-scholar', 'SKILL.md')
const expected = skillMarkdown()

if (process.argv.includes('--check')) {
  const actual = await readFile(target, 'utf8')
  if (actual !== expected) {
    console.error('skills/idle-scholar/SKILL.md is stale; run `npm run skill` to regenerate.')
    process.exit(1)
  }
  console.log('skills/idle-scholar/SKILL.md is up to date.')
} else {
  await writeFile(target, expected, 'utf8')
  console.log(`wrote ${target} (${expected.length} bytes)`)
}
