import { useEffect, useRef } from 'react'
import { setDeviceDisplay } from '../lib/api.js'

const DAY_MS = 24 * 60 * 60 * 1000
const UNIT_DAYS = { day: 1, week: 7, month: 30, year: 365 }

// Re-send even when nothing changed, so the OLEDs recover after an API restart.
const RESEND_MS = 60_000

/**
 * Days an item keeps in the fridge, from its USDA cold-storage guideline
 * ("3–4 days", "1 week", "2–3 weeks", ...). Ranges use the shorter end, to stay
 * on the safe side. null when there's no usable fridge time ("Unsafe to thaw",
 * a cooking-chart item, an item typed freely).
 */
export function shelfLifeDays(guideline) {
  if (guideline?.chart !== 'storage' || !guideline.fridge) return null
  const m = /(\d+)(?:\s*[–-]\s*\d+)?\s*(day|week|month|year)/i.exec(guideline.fridge)
  return m ? Number(m[1]) * UNIT_DAYS[m[2].toLowerCase()] : null
}

/**
 * What one fridge's OLED should show: its most recently added item that's
 * still in it, plus its food-safety status. `spoiled` sticks once set;
 * `exposure_ms` (danger-zone time so far) seeds the device's own counter,
 * which keeps running while the fridge is in the zone, so the OLED switches
 * to "SPOILED" on time even between updates from this page.
 */
function displayFor(items, applianceId, exposures) {
  const current = items
    .filter((it) => it.appliance_id === applianceId && !it.removed_at)
    .sort((a, b) => Date.parse(b.placed_at) - Date.parse(a.placed_at))[0]
  if (!current) return { item_name: null, employee_name: null, spoil_at: null, item_id: null, spoiled: false, exposure_ms: 0 }
  const days = shelfLifeDays(current.guideline)
  return {
    item_name: current.name,
    employee_name: current.added_by_name ?? null,
    // From the time it was placed, so removing and re-adding restarts the countdown.
    spoil_at: days == null ? null : new Date(Date.parse(current.placed_at) + days * DAY_MS).toISOString(),
    item_id: String(current.id).slice(0, 64),
    spoiled: Boolean(current.spoiled_at),
    exposure_ms: Math.round(exposures.get(current.id) ?? 0),
  }
}

/**
 * Keeps each ESP32's OLED (item, employee, days until spoiled) in step with the
 * items in this browser: sent whenever an item is added, removed, restored or
 * renamed, or an employee is renamed.
 */
export function useDeviceDisplaySync(items, applianceIds, exposures = new Map()) {
  // Exposure changes every second; read it from a ref so it rides along with
  // each send without restarting the effect (and its resend timer).
  const exposuresRef = useRef(exposures)
  exposuresRef.current = exposures
  // As a string, so the 2 s backend poll (a new applianceIds array each time)
  // doesn't restart the effect and its resend timer.
  const idsKey = [...new Set([...applianceIds, ...items.map((it) => it.appliance_id)])]
    .filter((id) => id != null)
    .sort((a, b) => a - b)
    .join(',')
  const sent = useRef(new Map()) // appliance id -> JSON last sent successfully

  useEffect(() => {
    const ids = idsKey ? idsKey.split(',').map(Number) : []
    const push = (force) => {
      for (const id of ids) {
        const body = displayFor(items, id, exposuresRef.current)
        // Compare without exposure_ms, so its steady growth doesn't cause a send every second.
        const json = JSON.stringify({ ...body, exposure_ms: undefined })
        if (!force && sent.current.get(id) === json) continue
        setDeviceDisplay(id, body)
          .then(() => sent.current.set(id, json))
          .catch(() => sent.current.delete(id)) // API offline or unknown id: retry later
      }
    }
    push(false)
    const timer = setInterval(() => push(true), RESEND_MS)
    return () => clearInterval(timer)
  }, [items, idsKey])
}
