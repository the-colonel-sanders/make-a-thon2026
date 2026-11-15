// Keyword search over the USDA food-safety charts (GET /food-guidelines,
// db/migrations/004_food_guidelines.sql). The whole table is ~70 rows, so it
// is indexed once in the browser and every keystroke is searched in memory.
//
// How a query is matched:
// - Words are lowercased, accents and punctuation dropped, and plurals reduced
//   ("Chickens" -> "chicken", "patties" -> "patty"), on both sides.
// - "raw" / "fresh" / "uncooked" and "cooked" / "precooked" filter by state;
//   every other word must match the row (as a prefix, so "chick" works while
//   typing) in its foods, keywords, label, product or description.
// - Rows covering several foods (e.g. "Fresh beef, lamb, veal and pork") show
//   only the food that was searched for: "beef" -> "Raw beef — chops, roasts, steak".

const STATE_WORDS = {
  raw: 'raw', fresh: 'raw', uncooked: 'raw',
  cooked: 'cooked', precooked: 'cooked',
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'or', 'of', 'the', 'in', 'with', 'to', 'for', 'after', 'labeled'])

// Points per kind of match; the best match for each query word counts.
const WEIGHT = { food: 6, keyword: 4, label: 4, text: 2 }
const PREFIX_FACTOR = 0.5

function singular(word) {
  if (word.length <= 3 || word.endsWith('ss')) return word
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(ches|shes|xes|sses|oes)$/.test(word)) return word.slice(0, -2)
  if (word.endsWith('s')) return word.slice(0, -1)
  return word
}

/** "Hard-cooked Eggs!" -> ['hard', 'cooked', 'egg'] */
export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map(singular)
}

const unique = (arr) => [...new Set(arr)]

/** "beef", "beef, lamb or pork" */
export function joinFoods(foods) {
  if (foods.length <= 1) return foods[0] ?? ''
  return `${foods.slice(0, -1).join(', ')} or ${foods[foods.length - 1]}`
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** Fill a row's '{food}' placeholder with the given foods. */
export function labelFor(row, foods = row.foods) {
  return capitalize(row.label.replace('{food}', joinFoods(foods.length ? foods : row.foods)))
}

/** Build the search index once per data load. */
export function buildIndex(rows) {
  return rows.map((row) => {
    const foods = row.foods.map((f) => ({ name: f, token: singular(f.toLowerCase()) }))
    return {
      row,
      foods,
      keyword: unique(row.keywords.flatMap(tokenize)),
      label: unique(tokenize(row.label.replace('{food}', ''))),
      text: unique(tokenize(`${row.product} ${row.description}`)),
    }
  })
}

const matchScore = (tokens, q, weight) => {
  let best = 0
  for (const t of tokens) {
    if (t === q) return weight
    if (t.startsWith(q)) best = weight * PREFIX_FACTOR
  }
  return best
}

/**
 * Search the index. Returns [{ row, label, score }] best first. Results are
 * capped at `limit`; an empty query returns nothing.
 */
export function searchFoods(index, query, limit = 40) {
  const words = tokenize(query)
  const states = new Set(words.filter((w) => STATE_WORDS[w]).map((w) => STATE_WORDS[w]))
  const terms = words.filter((w) => !STATE_WORDS[w])
  if (!terms.length && !states.size) return []

  const results = []
  for (const entry of index) {
    const { row } = entry
    if (states.size && !states.has(row.state)) continue

    let score = states.size ? 1 : 0
    let matchedAll = true
    const matchedFoods = new Set()
    for (const q of terms) {
      let best = 0
      for (const f of entry.foods) {
        const s = f.token === q ? WEIGHT.food : f.token.startsWith(q) ? WEIGHT.food * PREFIX_FACTOR : 0
        if (s > 0) matchedFoods.add(f.name)
        best = Math.max(best, s)
      }
      best = Math.max(
        best,
        matchScore(entry.keyword, q, WEIGHT.keyword),
        matchScore(entry.label, q, WEIGHT.label),
        matchScore(entry.text, q, WEIGHT.text),
      )
      if (best === 0) {
        matchedAll = false
        break
      }
      score += best
    }
    if (!matchedAll) continue

    const foods = row.foods.filter((f) => matchedFoods.has(f))
    results.push({ row, label: labelFor(row, foods), score })
  }

  // Best match first; ties keep the USDA chart order.
  results.sort((a, b) => b.score - a.score || a.row.sort_order - b.row.sort_order)
  return results.slice(0, limit)
}

/** Short guideline summary for an item, e.g. "Fridge: 1–2 days · Freezer: 3–4 months". */
export function guidelineSummary(g) {
  if (!g) return null
  if (g.chart === 'storage') return `Fridge: ${g.fridge} · Freezer: ${g.freezer}`
  const parts = []
  if (g.min_temp_f != null) parts.push(`${g.state === 'cooked' ? 'Reheat' : 'Cook'} to ${g.min_temp_f} °F`)
  if (g.rest_minutes) parts.push(`rest ${g.rest_minutes} min`)
  if (g.cook_note) parts.push(g.min_temp_f != null ? g.cook_note.toLowerCase() : g.cook_note)
  return parts.join(' · ')
}
