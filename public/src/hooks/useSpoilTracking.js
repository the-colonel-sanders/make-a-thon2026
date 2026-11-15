import { useEffect, useMemo } from 'react'
import { buildIntervals, dangerExposureMs, hasSpoiled } from '../lib/safety.js'

/**
 * Danger-zone exposure of every item in the live fridge (`applianceId`), and
 * the moment one reaches the spoil time it is marked spoiled for good
 * (`markSpoiled` stores `spoiled_at` on the item). That way an item stays
 * spoiled after the fridge cools down, after its readings scroll out of the
 * fetched window, and after the temperature history is erased.
 *
 * Returns a Map of item id -> exposure in ms (for the OLED sync).
 */
export function useSpoilTracking(items, readings, applianceId, now, markSpoiled) {
  const exposures = useMemo(() => {
    const intervals = buildIntervals(readings, now)
    const map = new Map()
    for (const item of items) {
      if (item.appliance_id !== applianceId || item.removed_at) continue
      map.set(item.id, dangerExposureMs(item, intervals, now))
    }
    return map
  }, [items, readings, applianceId, now])

  useEffect(() => {
    const newlySpoiled = items
      .filter((it) => !it.spoiled_at && exposures.has(it.id) && hasSpoiled(exposures.get(it.id)))
      .map((it) => it.id)
    if (newlySpoiled.length) markSpoiled(newlySpoiled)
  }, [items, exposures, markSpoiled])

  return exposures
}
