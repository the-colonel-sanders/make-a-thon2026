import { useCallback, useEffect, useState } from 'react'
import { STORAGE_KEYS } from '../lib/storageKeys.js'

// The API has no food-item endpoints yet, so the item list is kept in this
// browser's localStorage. Records follow the shape of the `food_items` table
// in db/schema.sql, so moving them to the backend later is a drop-in change.
const STORAGE_KEY = STORAGE_KEYS.items

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function useFoodItems() {
  const [items, setItems] = useState(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    } catch {
      // Private mode or storage full: keep working in memory.
    }
  }, [items])

  // Keep several open tabs in sync.
  useEffect(() => {
    const onStorage = (e) => e.key === STORAGE_KEY && setItems(load())
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // `profile` is { id, name } of whoever is using the dashboard. The name is
  // copied onto the item so it still shows if the profile is later removed.
  // `guideline` is the USDA chart row picked in the search (see AddItemForm),
  // or null for an item typed freely.
  const addItem = useCallback(({ name, applianceId, placedAt, profile, guideline = null }) => {
    setItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
        name,
        appliance_id: applianceId,
        placed_at: new Date(placedAt).toISOString(),
        removed_at: null,
        added_by_id: profile?.id ?? null,
        added_by_name: profile?.name ?? null,
        removed_by_name: null,
        guideline,
        spoiled_at: null, // set once it spoils from danger-zone time; never cleared
      },
    ])
  }, [])

  const removeItem = useCallback((id, profile) => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id
          ? { ...it, removed_at: new Date().toISOString(), removed_by_name: profile?.name ?? null }
          : it,
      ),
    )
  }, [])

  const restoreItem = useCallback((id) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, removed_at: null, removed_by_name: null } : it)),
    )
  }, [])

  const deleteItem = useCallback((id) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }, [])

  /** Change an item's name (also updates the fridge's OLED via useDeviceDisplaySync). */
  const renameItem = useCallback((id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, name: trimmed } : it)))
  }, [])

  /** Keep item records in step when an employee is renamed. */
  const renameAddedBy = useCallback((profileId, name) => {
    setItems((prev) => prev.map((it) => (it.added_by_id === profileId ? { ...it, added_by_name: name } : it)))
  }, [])

  /**
   * Mark items as spoiled (they reached the spoil time in the danger zone).
   * Permanent: spoiled_at is never cleared, not even by restoring the item.
   */
  const markSpoiled = useCallback((ids) => {
    const at = new Date().toISOString()
    setItems((prev) => prev.map((it) => (ids.includes(it.id) && !it.spoiled_at ? { ...it, spoiled_at: at } : it)))
  }, [])

  /**
   * Force an item's safety status for testing/demos ('safe' | 'warning' |
   * 'critical'), or null to go back to the status worked out from the sensor.
   * Display only: it never touches spoiled_at or the danger-zone time.
   */
  const simulateStatus = useCallback((id, status) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, simulated_status: status ?? null } : it)))
  }, [])

  /** Put every simulated item (optionally only in one appliance) back on the sensor. */
  const clearSimulations = useCallback((applianceId = null) => {
    setItems((prev) =>
      prev.map((it) =>
        it.simulated_status && (applianceId == null || it.appliance_id === applianceId)
          ? { ...it, simulated_status: null }
          : it,
      ),
    )
  }, [])

  /** Permanently delete every item already marked as removed. */
  const clearRemoved = useCallback(() => {
    setItems((prev) => prev.filter((it) => !it.removed_at))
  }, [])

  return {
    items, addItem, removeItem, restoreItem, deleteItem, renameItem, renameAddedBy, markSpoiled,
    simulateStatus, clearSimulations, clearRemoved,
  }
}
