/**
 * Unit tests for the progress module: state normalization, draw recording,
 * streaks, summaries, and the weighting hook.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cardRecord,
  createState,
  dayKey,
  makeWeightOf,
  normalizeState,
  previousDayKey,
  recordDraw,
  summarize,
} from '../progress.js'

test('createState returns a fresh, null-free state', () => {
  const state = createState()
  assert.equal(state.version, 1)
  assert.equal(state.course, null)
  assert.deepEqual(state.cards, {})
  assert.deepEqual(state.daily, {})
  assert.deepEqual(state.streak, { count: 0, lastDay: '' })
  assert.equal(state.totalDraws, 0)
})

test('normalizeState discards garbage and keeps valid fields', () => {
  assert.deepEqual(normalizeState(null), createState())
  assert.deepEqual(normalizeState('nonsense'), createState())
  assert.deepEqual(normalizeState({ __proto__: { injected: true } }), createState())
  const state = normalizeState({
    course: 'ja',
    cards: { 'c-1': { count: 2, lastSeen: '2026-09-24T00:00:00.000Z' }, bad: 'nope', 'c-2': null },
    daily: { '2026-09-24': 3, 'not-a-day': 5, '2026-09-25': -2 },
    streak: { count: 7, lastDay: '2026-09-24' },
    totalDraws: 42.7,
  })
  assert.equal(state.course, 'ja')
  assert.deepEqual(state.cards['c-1'], { count: 2, lastSeen: '2026-09-24T00:00:00.000Z' })
  assert.equal(state.cards['c-2'], undefined)
  assert.deepEqual(state.daily, { '2026-09-24': 3 })
  assert.deepEqual(state.streak, { count: 7, lastDay: '2026-09-24' })
  assert.equal(state.totalDraws, 42)
})

test('recordDraw bumps counters and rolls consecutive-day streaks', () => {
  const state = createState()
  const monday = new Date('2026-09-21T10:00:00')
  recordDraw(state, 'c-1', monday)
  recordDraw(state, 'c-2', monday)
  assert.equal(state.daily['2026-09-21'], 2)
  assert.equal(state.totalDraws, 2)
  assert.deepEqual(state.streak, { count: 1, lastDay: '2026-09-21' })

  // Tuesday: streak increments.
  recordDraw(state, 'c-1', new Date('2026-09-22T09:00:00'))
  assert.equal(state.streak.count, 2)

  // Thursday (gap): streak resets to 1.
  recordDraw(state, 'c-3', new Date('2026-09-24T09:00:00'))
  assert.equal(state.streak.count, 1)
  assert.equal(state.streak.lastDay, '2026-09-24')

  // Same-day second draw: streak untouched.
  recordDraw(state, 'c-1', new Date('2026-09-24T15:00:00'))
  assert.equal(state.streak.count, 1)
  assert.equal(cardRecord(state, 'c-1', new Date('2026-09-24T16:00:00')).count, 3)
  assert.equal(cardRecord(state, 'c-1', new Date('2026-09-24T16:00:00')).seenToday, true)
})

test('dayKey and previousDayKey handle month and year boundaries', () => {
  assert.equal(dayKey(new Date(2026, 8, 1)), '2026-09-01')
  assert.equal(previousDayKey('2026-09-01'), '2026-08-31')
  assert.equal(previousDayKey('2026-01-01'), '2025-12-31')
})

test('cardRecord reads through prototype pollution attempts', () => {
  const state = createState()
  state.cards['__proto__'] = undefined // JSON.parse could produce an own key
  assert.equal(cardRecord(state, 'constructor').count, 0)
})

test('summarize reports today, streak, coverage, and goal state', () => {
  const state = createState()
  const now = new Date('2026-09-24T12:00:00')
  recordDraw(state, 'c-1', new Date('2026-09-23T10:00:00'))
  recordDraw(state, 'c-1', now)
  recordDraw(state, 'c-2', now)
  const summary = summarize(state, { dailyGoal: 2, totalCards: 4, now })
  assert.equal(summary.todayCount, 2)
  assert.equal(summary.goalReached, true)
  assert.equal(summary.streakDays, 2)
  assert.equal(summary.uniqueSeen, 2)
  assert.equal(summary.percentSeen, 50)
  assert.equal(summary.totalDraws, 3)
})

test('makeWeightOf prefers never-seen over seen-today', () => {
  const state = createState()
  const now = new Date('2026-09-24T12:00:00')
  recordDraw(state, 'seen-today', now)
  recordDraw(state, 'seen-before', new Date('2026-09-23T12:00:00'))
  const weightOf = makeWeightOf(state, { now })
  const row = id => ({ card: { id }, deck: {} })
  assert.equal(weightOf(row('fresh')), 3)
  assert.equal(weightOf(row('seen-before')), 1)
  assert.equal(weightOf(row('seen-today')), 0.2)
})
