/**
 * Progress state for @dsh-plugin/idle-scholar: what was drawn, when, and the
 * daily streak. Pure module — every function takes and returns plain data so
 * the tests can drive it without the filesystem.
 *
 * State shape:
 *
 *     {
 *       "version": 1,
 *       "course": "en",                  // default course override, or null
 *       "cards": { "<cardId>": { "count": 2, "lastSeen": "ISO" } },
 *       "daily": { "2026-09-24": 4 },    // local-day draw counts
 *       "streak": { "count": 3, "lastDay": "2026-09-24" },
 *       "totalDraws": 42
 *     }
 *
 * Keys are read through `Object.hasOwn` — a JSON-parsed state file can carry a
 * literal `__proto__` own property, and a plain `map[key]` lookup would return
 * `Object.prototype` and slip past `!== undefined` guards.
 *
 * @module idle-scholar/progress
 */

/** Version of the on-disk state shape. */
export const STATE_VERSION = 1

/**
 * A fresh, empty state.
 * @returns the state object.
 */
export function createState() {
  return {
    version: STATE_VERSION,
    course: null,
    cards: {},
    daily: {},
    streak: { count: 0, lastDay: '' },
    totalDraws: 0,
  }
}

/**
 * Normalize an unknown parsed value into a valid state. Missing fields get
 * defaults; wrong-typed fields are discarded; unknown versions still load —
 * the fields this code reads are the contract.
 * @param value - parsed JSON, possibly garbage.
 * @returns a normalized state; always a new object.
 */
export function normalizeState(value) {
  const state = createState()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return state
  if (typeof value.course === 'string' && value.course !== '') state.course = value.course
  if (typeof value.cards === 'object' && value.cards !== null && !Array.isArray(value.cards)) {
    for (const [key, entry] of Object.entries(value.cards)) {
      if (typeof entry !== 'object' || entry === null) continue
      const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? Math.max(0, Math.floor(entry.count)) : 0
      const lastSeen = typeof entry.lastSeen === 'string' ? entry.lastSeen : ''
      state.cards[key] = { count, lastSeen }
    }
  }
  if (typeof value.daily === 'object' && value.daily !== null && !Array.isArray(value.daily)) {
    for (const [key, count] of Object.entries(value.daily)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(key) && typeof count === 'number' && Number.isFinite(count) && count > 0) {
        state.daily[key] = Math.floor(count)
      }
    }
  }
  if (typeof value.streak === 'object' && value.streak !== null && !Array.isArray(value.streak)) {
    if (typeof value.streak.count === 'number' && Number.isFinite(value.streak.count) && value.streak.count > 0) {
      state.streak.count = Math.floor(value.streak.count)
    }
    if (typeof value.streak.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.streak.lastDay)) {
      state.streak.lastDay = value.streak.lastDay
    }
  }
  if (typeof value.totalDraws === 'number' && Number.isFinite(value.totalDraws) && value.totalDraws > 0) {
    state.totalDraws = Math.floor(value.totalDraws)
  }
  return state
}

/**
 * Local calendar day (YYYY-MM-DD) for a timestamp.
 * @param date - the moment.
 * @returns the local-day key.
 */
export function dayKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * The day before a given local-day key.
 * @param key - `YYYY-MM-DD` local day.
 * @returns the previous day's key.
 */
export function previousDayKey(key) {
  const date = new Date(`${key}T12:00:00`)
  date.setDate(date.getDate() - 1)
  return dayKey(date)
}

/**
 * Record one card draw: bumps the day counter, the per-card counters, the
 * lifetime total, and rolls the streak when this is the first draw of a
 * consecutive day. Mutates `state` in place and also returns it, so callers
 * that treat state immutably can chain.
 * @param state - the state to update.
 * @param cardId - the drawn card.
 * @param now - the draw moment; defaults to now.
 * @returns the same state object.
 */
export function recordDraw(state, cardId, now = new Date()) {
  const today = dayKey(now)
  state.daily[today] = (Object.hasOwn(state.daily, today) ? state.daily[today] : 0) + 1
  const prior = Object.hasOwn(state.cards, cardId) ? state.cards[cardId] : { count: 0, lastSeen: '' }
  state.cards[cardId] = { count: prior.count + 1, lastSeen: now.toISOString() }
  state.totalDraws += 1
  if (state.streak.lastDay !== today) {
    state.streak.count = state.streak.lastDay === previousDayKey(today) ? state.streak.count + 1 : 1
    state.streak.lastDay = today
  }
  return state
}

/**
 * How many times a card was drawn (0 when never).
 * @param state - the state.
 * @param cardId - the card.
 * @param now - "today" reference; defaults to now.
 * @returns `{ count, seenToday }`.
 */
export function cardRecord(state, cardId, now = new Date()) {
  const entry = Object.hasOwn(state.cards, cardId) ? state.cards[cardId] : undefined
  const today = dayKey(now)
  return {
    count: entry?.count ?? 0,
    seenToday: entry !== undefined && typeof entry.lastSeen === 'string' && dayKey(new Date(entry.lastSeen)) === today,
  }
}

/**
 * Snapshot of progress for status reporting.
 * @param state - the state.
 * @param options
 * @param options.dailyGoal - the configured daily goal.
 * @param options.totalCards - cards available across the loaded decks.
 * @param options.now - reference moment; defaults to now.
 * @returns the summary fields.
 */
export function summarize(state, { dailyGoal = 10, totalCards = 0, now = new Date() } = {}) {
  const today = dayKey(now)
  const todayCount = Object.hasOwn(state.daily, today) ? state.daily[today] : 0
  const uniqueSeen = Object.keys(state.cards).length
  return {
    todayCount,
    dailyGoal,
    streakDays: state.streak.count,
    totalDraws: state.totalDraws,
    uniqueSeen,
    totalCards,
    percentSeen: totalCards > 0 ? Math.min(100, Math.round((uniqueSeen / totalCards) * 100)) : 0,
    goalReached: todayCount >= dailyGoal,
  }
}

/**
 * Weight function factory for {@link ./courses.js.pickCard}: never-seen cards
 * weigh most, cards drawn today weigh little, and the card drawn immediately
 * before this one is excluded entirely.
 * @param state - the state.
 * @param options
 * @param options.now - reference moment; defaults to now.
 * @param options.baseWeights - `{ never, seen, today }` weights.
 * @returns `(row) => weight` for pickCard.
 */
export function makeWeightOf(state, { now = new Date(), baseWeights = { never: 3, seen: 1, today: 0.2 } } = {}) {
  return (row) => {
    const { count, seenToday } = cardRecord(state, row.card.id, now)
    if (count === 0) return baseWeights.never
    if (seenToday) return baseWeights.today
    return baseWeights.seen
  }
}
