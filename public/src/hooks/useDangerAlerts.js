import { useCallback, useEffect, useRef, useState } from 'react'
import { isInDangerZone } from '../lib/safety.js'
import { dangerRangeLabel, formatDuration, formatTemp, formatThreshold, formatTime } from '../lib/format.js'
import { getSettings } from '../lib/settings.js'
import { STORAGE_KEYS } from '../lib/storageKeys.js'

// Unique across page reloads, since notification history is saved.
let counter = 0
const newId = () => `${Date.now()}-${counter++}`

// Recent notifications are kept in localStorage so they survive a reload.
const HISTORY_KEY = STORAGE_KEYS.notifications
const HISTORY_LIMIT = 200 // the History page scrolls through all of these

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** "Chicken, Milk and 2 more" */
function listItems(names) {
  if (names.length === 0) return null
  if (names.length <= 3) return names.join(', ')
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

/**
 * Food-safety popups for one fridge:
 *  - temperature becomes unsafe         -> yellow popup
 *  - unsafe for the red-alert time or more -> red "unsafe exposure time" popup
 *  - back to a safe temperature         -> green popup
 * `zoneMs` is how long the fridge has been at an unsafe temperature without a
 * break; `itemNames` are the items currently in that fridge. If the page opens
 * while the fridge is already unsafe, it alerts right away.
 */
export function useDangerAlerts(latest, applianceId, zoneMs, itemNames = [], device = 'on') {
  const [toasts, setToasts] = useState([])
  const [history, setHistory] = useState(loadHistory) // newest first
  const state = useRef({ applianceId, inZone: null, escalated: false, device: null })

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history))
    } catch {
      // Storage unavailable: keep the history in memory only.
    }
  }, [history])

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const dismissHistory = useCallback((id) => {
    setHistory((list) => list.filter((n) => n.id !== id))
  }, [])

  const clearHistory = useCallback(() => setHistory([]), [])

  const show = useCallback((toast) => {
    const entry = { id: newId(), time: Date.now(), ...toast }
    // One popup per fridge at a time: a newer state replaces the older one.
    setToasts((list) => [...list.filter((t) => t.applianceId !== toast.applianceId), entry])
    // Every popup is also recorded in the notification list.
    setHistory((list) => [entry, ...list].slice(0, HISTORY_LIMIT))
  }, [])

  useEffect(() => {
    const s = state.current
    if (s.applianceId !== applianceId) {
      state.current = { applianceId, inZone: null, escalated: false, device: null }
      return
    }
    if (!latest) return

    // Device off: the last reading is stale, so no temperature alerts. Announce
    // the device going off once; temperature alerts resume when it's back.
    const wasDevice = s.device
    s.device = device
    if (device === 'off') {
      if (wasDevice === 'on' && getSettings().notifyDeviceOffline) {
        show({
          applianceId,
          level: 'offline',
          title: 'Temperature sensor went offline',
          message: `Fridge #${applianceId}’s ESP32 stopped sending readings. The last one was ${formatTemp(latest.temperature_c)} at ${formatTime(latest.time)}.`,
          detail: 'Food safety can’t be tracked until it reconnects.',
        })
      }
      return
    }
    if (wasDevice === 'off') {
      show({
        applianceId,
        level: 'safe',
        title: 'Temperature sensor is back online',
        message: `Fridge #${applianceId} is reporting again: ${formatTemp(latest.temperature_c)} at ${formatTime(latest.time)}.`,
      })
      // Re-check the temperature from scratch on the next update.
      s.inZone = null
      s.escalated = false
      return
    }

    const inZone = isInDangerZone(latest.temperature_c)
    const { redExposureMs } = getSettings()
    const red = inZone && zoneMs >= redExposureMs
    const limit = formatThreshold(redExposureMs)
    const range = dangerRangeLabel()
    const temp = formatTemp(latest.temperature_c)
    const items = listItems(itemNames)

    if (inZone && (s.inZone !== true || (red && !s.escalated))) {
      if (red) {
        show({
          applianceId,
          level: 'critical',
          title: 'Food has reached an unsafe exposure time',
          message:
            `Fridge #${applianceId} has been at ${temp} (unsafe range ${range}) for ${formatDuration(zoneMs)}, ` +
            `longer than the safe limit of ${limit}. Bacteria can multiply quickly at these temperatures.`,
          detail: items ? `Check or discard: ${items}.` : 'Check any perishable food inside before eating it.',
        })
      } else {
        show({
          applianceId,
          level: 'warning',
          title: 'Fridge temperature is rising into an unsafe range',
          message:
            `Fridge #${applianceId} reached ${temp} at ${formatTime(latest.time)}, inside the ${range} range where bacteria grow. ` +
            `Food reaches an unsafe exposure time if it stays this warm for ${limit}.`,
          detail: items ? `Affected: ${items}.` : 'Close the door and check the fridge is cooling.',
        })
      }
      s.escalated = red
    } else if (!inZone && s.inZone === true) {
      show({
        applianceId,
        level: 'safe',
        title: 'Fridge is back to a safe temperature',
        message: `Fridge #${applianceId} is at ${temp} as of ${formatTime(latest.time)}.`,
      })
      s.escalated = false
    }
    s.inZone = inZone
  }, [latest, applianceId, zoneMs, itemNames, device, show])

  return { toasts, dismiss, history, dismissHistory, clearHistory }
}
