/**
 * The bundled course packs must all validate, have globally-unique ids, and
 * cover the advertised courses. This is the guard rail for community PRs that
 * add decks: a broken JSON file fails the suite before it fails a user.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCourseRoot } from '../courses.js'

const bundled = join(dirname(fileURLToPath(import.meta.url)), '..', 'courses')

const loaded = await loadCourseRoot(bundled)

test('every bundled deck loads without errors', () => {
  assert.deepEqual(loaded.errors, [])
})

test('bundled decks cover the three launch courses', () => {
  const courses = new Set(loaded.decks.map(deck => deck.course))
  assert.deepEqual([...courses].sort(), ['en', 'faka', 'ja'])
})

test('bundled decks have globally-unique deck and card ids', () => {
  const deckIds = new Set()
  const cardIds = new Set()
  for (const deck of loaded.decks) {
    assert.ok(!deckIds.has(deck.id), `duplicate deck id ${deck.id}`)
    deckIds.add(deck.id)
    for (const card of deck.cards) {
      assert.ok(!cardIds.has(card.id), `duplicate card id ${card.id}`)
      cardIds.add(card.id)
    }
  }
})

test('the eight judicial-exam decks are all present', () => {
  const expected = [
    'faka-xingfa', 'faka-minfa', 'faka-xingsusong', 'faka-minsusong',
    'faka-xingzhengfa', 'faka-shangjingzhi', 'faka-sanguofa', 'faka-lilunfa',
  ]
  const ids = new Set(loaded.decks.map(deck => deck.id))
  for (const id of expected) assert.ok(ids.has(id), `missing deck ${id}`)
})

test('every deck ships a meaningful seed (at least 10 cards)', () => {
  for (const deck of loaded.decks) {
    assert.ok(deck.cards.length >= 10, `deck ${deck.id} has only ${deck.cards.length} cards`)
  }
})
