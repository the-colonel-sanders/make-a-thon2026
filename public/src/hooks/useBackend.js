import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDevices, fetchHealth, fetchReadings } from '../lib/api.js'
import { POLL_INTERVAL_MS, READINGS_LIMIT } from '../config.js'

/**
 * Polls GET /health, GET /readings and GET /devices for one appliance.
 * `lastCheckinAt` is when the ESP32 last checked in (in this browser's clock),
 * so the device counts as online even when it has no readings (e.g. right
 * after the history was reset).
 * Keeps the last good readings when a poll fails, so the page doesn't blank out.
 */
export function useBackend(applianceId) {
  const [readings, setReadings] = useState([])
  const [applianceIds, setApplianceIds] = useState([])
  const [online, setOnline] = useState(null) // null = not checked yet
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastFetched, setLastFetched] = useState(null)
  const [lastCheckinAt, setLastCheckinAt] = useState(null)
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
      // Check-ins are optional (older API): failures don't affect the rest.
      fetchDevices(controller.signal)
        .then((devices) => {
          const d = devices.find((x) => x.id === applianceId)
          if (!d?.last_checkin_at) return setLastCheckinAt(null)
          // Measure the age on the server's clock, then place it on ours.
          const age = Date.parse(d.server_time) - Date.parse(d.last_checkin_at)
          setLastCheckinAt(Date.now() - Math.max(0, age))
        })
        .catch(() => {})
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
    setLastCheckinAt(null)
    poll()
    const id = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      clearInterval(id)
      controllerRef.current?.abort()
    }
  }, [poll])

  return { readings, applianceIds, online, error, loading, lastFetched, lastCheckinAt, refresh: poll }
}
