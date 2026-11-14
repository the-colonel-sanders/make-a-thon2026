// Danger-zone math. Mirrors the `food_item_status` view in db/schema.sql:
// each reading counts from its timestamp until the next reading (or now).
// Thresholds come from the Settings page (defaults in config.js).
import { getSettings } from './settings.js'

const cfg = getSettings

export const isInDangerZone = (tempC) => tempC >= cfg().dangerMinC && tempC <= cfg().dangerMaxC

/**
 * 'on' | 'off' | 'unknown' for the ESP32: off once no reading has arrived for
 * the device-offline timeout, unknown when there has never been a reading.
 */
export function deviceState(latest, now) {
  if (!latest) return 'unknown'
  return now - latest.time > cfg().staleAfterMs ? 'off' : 'on'
}

/**
 * Turn oldest-first readings into [start, end) intervals with a temperature.
 * A reading lasts until the next one, but never longer than the device-offline timeout:
 * time when the device was off isn't counted, since the temperature is unknown.
 */
export function buildIntervals(readings, now) {
  return readings.map((r, i) => ({
    start: r.time,
    end: Math.min(i + 1 < readings.length ? readings[i + 1].time : now, r.time + cfg().staleAfterMs),
    tempC: r.temperature_c,
  }))
}

/** Milliseconds an item has spent in the danger zone while in the fridge. */
export function dangerExposureMs(item, intervals, now) {
  const from = Date.parse(item.placed_at)
  const to = item.removed_at ? Date.parse(item.removed_at) : now
  let total = 0
  for (const iv of intervals) {
    if (!isInDangerZone(iv.tempC)) continue
    const overlap = Math.min(iv.end, to) - Math.max(iv.start, from)
    if (overlap > 0) total += overlap
  }
  return total
}

/**
 * 'safe' | 'warning' | 'critical' for an item.
 * Red once total exposure reaches the red-alert time. Yellowish orange for any
 * shorter exposure, or while the fridge is in the zone right now.
 */
export function itemStatus(exposureMs, inZoneNow) {
  if (exposureMs >= cfg().redExposureMs) return 'critical'
  if (exposureMs > 0 || inZoneNow) return 'warning'
  return 'safe'
}

/**
 * How long the fridge has been in the danger zone without a break, in ms
 * (0 when the latest reading is outside it). Readings are oldest first.
 */
export function continuousZoneMs(readings, now) {
  let i = readings.length - 1
  if (i < 0 || !isInDangerZone(readings[i].temperature_c)) return 0
  while (i > 0 && isInDangerZone(readings[i - 1].temperature_c)) i--
  return Math.max(0, now - readings[i].time)
}

/**
 * Status of the fridge temperature: red after the red-alert time continuously in
 * the zone, yellowish orange before that, green outside it.
 */
export function temperatureStatus(tempC, zoneMs = 0) {
  if (tempC == null) return 'unknown'
  if (!isInDangerZone(tempC)) return 'safe'
  return zoneMs >= cfg().redExposureMs ? 'critical' : 'warning'
}

/** True when a safe temperature is within the near-zone margin of the zone. */
export function isNearZone(tempC) {
  if (tempC == null || isInDangerZone(tempC)) return false
  const { dangerMinC, dangerMaxC, nearZoneMarginC } = cfg()
  const distance = Math.min(Math.abs(tempC - dangerMinC), Math.abs(tempC - dangerMaxC))
  return distance <= nearZoneMarginC
}
