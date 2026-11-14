import { useEffect } from 'react'
import { fetchThresholds } from '../lib/api.js'
import { updateSettings } from '../lib/settings.js'

const REFRESH_MS = 60_000

/** Re-read the thresholds from the database now (e.g. when the Admin page opens). */
export async function syncThresholds(signal) {
  const t = await fetchThresholds(signal)
  updateSettings(t)
  return t
}

/**
 * The database holds the danger zone and spoil time (set on the Admin page).
 * Load them on start and refresh every minute, so every browser uses the same
 * values. While the API is unreachable, the last values seen stay in use.
 */
export function useServerThresholds() {
  useEffect(() => {
    const controller = new AbortController()
    const run = () => syncThresholds(controller.signal).catch(() => {})
    run()
    const id = setInterval(run, REFRESH_MS)
    return () => {
      controller.abort()
      clearInterval(id)
    }
  }, [])
}
