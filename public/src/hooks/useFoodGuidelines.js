import { useEffect, useMemo, useState } from 'react'
import { fetchFoodGuidelines } from '../lib/api.js'
import { buildIndex } from '../lib/foodSearch.js'

// A cached copy of public reference data, not user data, so it is deliberately
// left out of STORAGE_KEYS (backups and "erase all data" skip it).
const CACHE_KEY = 'fridge-dashboard.food-guidelines-cache.v1'
const RETRY_MS = 30_000

function loadCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * The USDA food-safety charts from the database, fetched once and indexed for
 * search. The last copy fetched is kept in localStorage, so search still works
 * while the API is unreachable; until the first successful fetch it retries
 * every 30 s.
 */
export function useFoodGuidelines() {
  const [rows, setRows] = useState(loadCache)

  useEffect(() => {
    const controller = new AbortController()
    let timer
    const run = () =>
      fetchFoodGuidelines(controller.signal)
        .then((data) => {
          setRows(data)
          try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(data))
          } catch {
            // Storage unavailable: the in-memory copy is enough.
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) timer = setTimeout(run, RETRY_MS)
        })
    run()
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [])

  const index = useMemo(() => buildIndex(rows), [rows])
  return { index, loaded: rows.length > 0 }
}
