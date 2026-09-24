/**
 * Course-pack loading, validation, and card selection for @dsh-plugin/idle-scholar.
 *
 * A **deck** is one JSON file; a **course** groups decks by their `course`
 * field. Everything here is pure (plus an optional filesystem read) so the
 * test suite can drive it without a host context.
 *
 * Deck shape:
 *
 *     {
 *       "id": "en-vocab",          // unique across every loaded deck
 *       "course": "en",            // course grouping key
 *       "name": "英语核心词汇",      // deck display name
 *       "description": "...",       // optional
 *       "cards": [
 *         {
 *           "id": "en-vocab-001",  // unique across every loaded deck
 *           "type": "vocab",       // vocab | quiz | concept | tip
 *           "prompt": "...",       // the question / front of the card
 *           "hint": "...",         // optional
 *           "choices": ["a","b"],  // quiz only, 2-6 options
 *           "answer": 1,           // quiz: index into choices; others: string
 *           "explanation": "...",
 *           "tags": ["CET6"]       // optional
 *         }
 *       ]
 *     }
 *
 * Community packs use the exact same shape: point `coursesDir` at a folder of
 * JSON files and they load alongside the bundled decks.
 *
 * @module idle-scholar/courses
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The four card types a deck may use. */
export const CARD_TYPES = ['vocab', 'quiz', 'concept', 'tip']

/** Human labels for the card types, keyed by type id. */
export const CARD_TYPE_LABELS = {
  vocab: '词汇卡',
  quiz: '测验卡',
  concept: '概念卡',
  tip: '贴士卡',
}

/**
 * Validate one parsed deck JSON. Throws with a source-tagged message on the
 * first problem found, so a broken community pack reports exactly where.
 * @param data - the parsed JSON value.
 * @param source - file path or tag used in error messages.
 * @returns the same deck, unchanged (validation only).
 */
export function validateDeck(data, source = 'deck') {
  const fail = (message) => {
    throw new TypeError(`idle-scholar: ${source}: ${message}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) fail('deck must be a JSON object')
  if (typeof data.id !== 'string' || data.id === '') fail('deck.id must be a non-empty string')
  if (typeof data.course !== 'string' || data.course === '') fail('deck.course must be a non-empty string')
  if (typeof data.name !== 'string' || data.name === '') fail('deck.name must be a non-empty string')
  if (data.description !== undefined && typeof data.description !== 'string') fail('deck.description must be a string')
  if (!Array.isArray(data.cards) || data.cards.length === 0) fail('deck.cards must be a non-empty array')
  for (const card of data.cards) {
    if (typeof card !== 'object' || card === null || Array.isArray(card)) fail(`cards: each card must be an object`)
    const at = `card '${String(card?.id)}'`
    if (typeof card.id !== 'string' || card.id === '') fail(`${at}: id must be a non-empty string`)
    if (!CARD_TYPES.includes(card.type)) fail(`${at}: type must be one of ${CARD_TYPES.join(', ')}`)
    if (typeof card.prompt !== 'string' || card.prompt === '') fail(`${at}: prompt must be a non-empty string`)
    if (card.hint !== undefined && (typeof card.hint !== 'string' || card.hint === '')) fail(`${at}: hint must be a non-empty string when present`)
    if (card.type === 'quiz') {
      if (!Array.isArray(card.choices) || card.choices.length < 2 || card.choices.length > 6) {
        fail(`${at}: quiz choices must be an array of 2-6 strings`)
      }
      if (card.choices.some(choice => typeof choice !== 'string' || choice === '')) {
        fail(`${at}: quiz choices must be non-empty strings`)
      }
      if (!Number.isInteger(card.answer) || card.answer < 0 || card.answer >= card.choices.length) {
        fail(`${at}: quiz answer must be an integer index into choices`)
      }
    } else if (typeof card.answer !== 'string' || card.answer === '') {
      fail(`${at}: answer must be a non-empty string for ${card.type} cards`)
    }
    if (typeof card.explanation !== 'string' || card.explanation === '') fail(`${at}: explanation must be a non-empty string`)
    if (card.tags !== undefined) {
      if (!Array.isArray(card.tags) || card.tags.some(tag => typeof tag !== 'string' || tag === '')) {
        fail(`${at}: tags must be an array of non-empty strings`)
      }
    }
  }
  return data
}

/**
 * Load every deck JSON below a directory. The layout is
 * `<root>/<course>/<deck>.json`; nested directories are walked recursively and
 * the `course` field inside each file decides the grouping (the folder is only
 * a convention). Files that fail to parse or validate are reported through the
 * returned `errors` list instead of aborting the whole load, so one broken
 * community pack cannot take the plugin down.
 * @param root - absolute path of the course root.
 * @returns `{ decks, errors }`.
 */
export async function loadCourseRoot(root) {
  const decks = []
  const errors = []

  /**
   * Walk one directory depth-first.
   * @param dir - directory to walk.
   */
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') errors.push(`${dir}: ${String(error?.message ?? error)}`)
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const parsed = JSON.parse(await readFile(path, 'utf8'))
          decks.push(validateDeck(parsed, path))
        } catch (error) {
          errors.push(`${path}: ${String(error?.message ?? error)}`)
        }
      }
    }
  }

  await walk(root)
  return { decks, errors }
}

/**
 * Group decks into courses, preserving first-seen course order.
 * @param decks - validated decks.
 * @returns course summaries with their decks.
 */
export function groupCourses(decks) {
  const map = new Map()
  for (const deck of decks) {
    let course = map.get(deck.course)
    if (course === undefined) {
      course = { id: deck.course, name: deck.course, decks: [] }
      map.set(deck.course, course)
    }
    course.decks.push(deck)
  }
  return [...map.values()]
}

/**
 * Flatten decks into the selection pool. Every row carries its deck so the
 * picker can report where a card came from.
 * @param decks - validated decks.
 * @returns `{ deck, card }[]`.
 */
export function flattenCards(decks) {
  const rows = []
  for (const deck of decks) {
    for (const card of deck.cards) rows.push({ deck, card })
  }
  return rows
}

/**
 * Which courses a deck exposes as subject filters — the deck ids themselves.
 * @param decks - validated decks.
 * @returns sorted unique deck ids.
 */
export function deckIds(decks) {
  return [...new Set(decks.map(deck => deck.id))].sort()
}

/**
 * Filter the card pool.
 * @param pool - flattened rows from {@link flattenCards}.
 * @param filter - `{ course?, deck?, type? }`; empty fields match anything.
 * @returns the matching rows.
 */
export function filterPool(pool, filter = {}) {
  return pool.filter(({ deck, card }) => {
    if (filter.course !== undefined && deck.course !== filter.course) return false
    if (filter.deck !== undefined && deck.id !== filter.deck) return false
    if (filter.type !== undefined && card.type !== filter.type) return false
    return true
  })
}

/**
 * Draw one card with seen-weighting: never-seen cards are three times as
 * likely, cards already drawn today are rare, and the card drawn immediately
 * before is excluded so consecutive calls never repeat. Pure: `rng` and
 * `seenToday` are injected, which keeps the whole thing testable.
 * @param rows - candidate rows (already filtered).
 * @param options
 * @param options.rng - `() => float in [0,1)`; defaults to Math.random.
 * @param options.weightOf - `(row) => weight`; missing means "never seen" (3).
 * @returns one row, or undefined when the pool is empty.
 */
export function pickCard(rows, options = {}) {
  if (rows.length === 0) return undefined
  const rng = options.rng ?? Math.random
  const weightOf = options.weightOf ?? (() => 3)
  const weights = rows.map(row => Math.max(0, weightOf(row)))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  if (total <= 0) {
    // Every weight is zero (e.g. everything was drawn today and the weighting
    // says so): fall back to uniform instead of refusing to teach.
    return rows[Math.floor(rng() * rows.length)]
  }
  let roll = rng() * total
  for (let index = 0; index < rows.length; index += 1) {
    roll -= weights[index]
    if (roll <= 0) return rows[index]
  }
  return rows[rows.length - 1]
}
