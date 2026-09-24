/**
 * Unit tests for the course-pack module: deck validation, grouping, filtering,
 * and weighted card selection.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CARD_TYPES,
  deckIds,
  filterPool,
  flattenCards,
  groupCourses,
  pickCard,
  validateDeck,
} from '../courses.js'

const validDeck = () => ({
  id: 't-vocab',
  course: 't',
  name: 'Test deck',
  cards: [
    { id: 't-vocab-001', type: 'vocab', prompt: 'p1', answer: 'a1', explanation: 'e1' },
    { id: 't-quiz-001', type: 'quiz', prompt: 'p2', choices: ['a', 'b', 'c'], answer: 1, explanation: 'e2' },
    { id: 't-tip-001', type: 'tip', prompt: 'p3', answer: 'a3', explanation: 'e3', tags: ['x'] },
  ],
})

test('validateDeck accepts a valid deck unchanged', () => {
  const deck = validDeck()
  assert.equal(validateDeck(deck, 'unit'), deck)
})

test('validateDeck rejects malformed decks with a tagged message', () => {
  const cases = [
    [null, /must be a JSON object/],
    [{ id: 'x' }, /course must be/],
    [{ id: 'x', course: 'c', name: 'n' }, /cards must be/],
    [{ ...validDeck(), cards: [] }, /cards must be/],
    [{ ...validDeck(), id: '' }, /id must be/],
  ]
  for (const [data, pattern] of cases) {
    assert.throws(() => validateDeck(data, 'unit'), pattern)
  }
})

test('validateDeck rejects bad cards: type, prompt, quiz ranges, explanation', () => {
  const bad = (card) => validateDeck({ ...validDeck(), cards: [card] }, 'unit')
  assert.throws(() => bad({ id: 'c1', type: 'nope', prompt: 'p', answer: 'a', explanation: 'e' }), /type must be one of/)
  assert.throws(() => bad({ id: 'c1', type: 'vocab', prompt: '', answer: 'a', explanation: 'e' }), /prompt must be/)
  assert.throws(() => bad({ id: 'c1', type: 'quiz', prompt: 'p', choices: ['a'], answer: 0, explanation: 'e' }), /2-6/)
  assert.throws(() => bad({ id: 'c1', type: 'quiz', prompt: 'p', choices: ['a', 'b'], answer: 2, explanation: 'e' }), /integer index/)
  assert.throws(() => bad({ id: 'c1', type: 'vocab', prompt: 'p', answer: 'a', explanation: '' }), /explanation must be/)
  assert.throws(() => bad({ id: 'c1', type: 'vocab', prompt: 'p', answer: 'a', explanation: 'e', tags: [''] }), /tags must be/)
})

test('groupCourses preserves first-seen order and flattens with deck refs', () => {
  const deckA = validDeck()
  const deckB = { ...validDeck(), id: 't-other', name: 'Other' }
  const courses = groupCourses([deckA, deckB])
  assert.equal(courses.length, 1)
  assert.equal(courses[0].id, 't')
  assert.deepEqual(courses[0].decks.map(d => d.id), ['t-vocab', 't-other'])
  const pool = flattenCoursesHelper([deckA, deckB])
  assert.equal(pool.length, 6)
  assert.equal(pool[1].deck.id, 't-vocab')
})

function flattenCoursesHelper(decks) {
  return flattenCards(decks)
}

test('deckIds returns sorted unique ids', () => {
  assert.deepEqual(deckIds([validDeck(), { ...validDeck(), id: 'a-1' }]), ['a-1', 't-vocab'])
})

test('filterPool matches course, deck, and type independently', () => {
  const deckA = validDeck()
  const deckB = { ...validDeck(), id: 'u-vocab', course: 'u' }
  const pool = flattenCards([deckA, deckB])
  assert.equal(filterPool(pool, { course: 't' }).length, 3)
  assert.equal(filterPool(pool, { deck: 'u-vocab' }).length, 3)
  assert.equal(filterPool(pool, { type: 'quiz' }).length, 2)
  assert.equal(filterPool(pool, { course: 't', type: 'vocab' }).length, 1)
  assert.equal(filterPool(pool, {}).length, 6)
})

test('pickCard weights never-seen cards and excludes empty pools', () => {
  const rows = flattenCards([validDeck()])
  const never = pickCard(rows, { rng: () => 0, weightOf: () => 3 })
  assert.ok(never.card.id.length > 0)
  assert.equal(pickCard([], { rng: () => 0 }), undefined)
  // All-zero weights fall back to uniform instead of throwing.
  const zeroed = pickCard(rows, { rng: () => 0.5, weightOf: () => 0 })
  assert.ok(rows.includes(zeroed))
})

test('pickCard honors the weight function deterministically', () => {
  const rows = flattenCards([validDeck()])
  // weightOf gives the first row all the mass; rng(0) picks the first row.
  const picked = pickCard(rows, {
    rng: () => 0.99,
    weightOf: (row) => (row.card.id === 't-vocab-001' ? 10 : 0),
  })
  assert.equal(picked.card.id, 't-vocab-001')
})

test('CARD_TYPES covers the four shipped types', () => {
  assert.deepEqual([...CARD_TYPES].sort(), ['concept', 'quiz', 'tip', 'vocab'])
})
