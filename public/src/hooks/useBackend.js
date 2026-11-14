import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchHealth, fetchReadings } from '../lib/api.js'
import { POLL_INTERVAL_MS, READINGS_LIMIT } from '../config.js'

/**
 * Polls GET /health and GET /readings for one appliance.
 * Keeps the last good readings when a poll fails, so the page doesn't blank out.
 */
export function useBackend(applianceId) {
  const [readings, setReadings] = useState([])
  const [applianceIds, setApplianceIds] = useState([])
  const [online, setOnline] = useState(null) // null = not checked yet
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastFetched, setLastFetched] = useState(null)
  const controllerRef = useRef(null)

  const poll = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const [ok, rows, all] = await Promise.all([
        fetchHealth(controller.signal),
        fetchReadings({ applianceId, limit: READINGS_LIMIT }, controller.signal),
        // There's no /appliances endpoint, so list the IDs seen in recent readings.
        fetchReadings({ limit: READINGS_LIMIT }, controller.signal),
      ])
      setOnline(ok)
      setReadings(rows)
      setApplianceIds([...new Set(all.map((r) => r.appliance_id))].sort((a, b) => a - b))
      setError(null)
      setLastFetched(Date.now())
    } catch (err) {
      if (err.name === 'AbortError') return
      setOnline(false)
      setError(err.message || 'Could not reach the API')
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [applianceId])

  useEffect(() => {
    setLoading(true)
    setReadings([])
    poll()
    const id = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      clearInterval(id)
      controllerRef.current?.abort()
    }
  }, [poll])

  return { readings, applianceIds, online, error, loading, lastFetched, refresh: poll }
}
