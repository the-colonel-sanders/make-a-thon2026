import { useSyncExternalStore } from 'react'
import {
  DANGER_MAX_C,
  DANGER_MIN_C,
  DEFAULT_APPLIANCE_ID,
  NEAR_ZONE_MARGIN_C,
  RED_EXPOSURE_MS,
  STALE_AFTER_MS,
} from '../config.js'
import { STORAGE_KEYS } from './storageKeys.js'

// User-adjustable settings, saved in this browser. The values in config.js are
// the defaults. Non-React code (safety rules, formatting) reads them with
// getSettings(); components subscribe with useSettings() so they re-render.

export const DEFAULT_SETTINGS = {
  // Appearance
  theme: 'system', // 'system' | 'light' | 'dark'
  density: 'comfortable', // 'comfortable' | 'compact'
  // Units & food safety (temperatures stored in °C, like the sensor)
  unit: 'F', // 'F' | 'C'
  dangerMinC: DANGER_MIN_C,
  dangerMaxC: DANGER_MAX_C,
  nearZoneMarginC: NEAR_ZONE_MARGIN_C,
  redExposureMs: RED_EXPOSURE_MS,
  staleAfterMs: STALE_AFTER_MS,
  // Notifications
  popups: true,
  notifyDeviceOffline: true,
  // Data
  defaultApplianceId: DEFAULT_APPLIANCE_ID,
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) ?? '{}')
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

let current = { ...DEFAULT_SETTINGS, ...load() }
const listeners = new Set()

export const getSettings = () => current

export function updateSettings(patch) {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(current))
  } catch {
    // Storage unavailable: settings last until the page is closed.
  }
  applyAppearance(current)
  listeners.forEach((fn) => fn())
}

export const resetSettings = () => updateSettings(DEFAULT_SETTINGS)

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Current settings; re-renders the component whenever they change. */
export function useSettings() {
  return useSyncExternalStore(subscribe, getSettings)
}

/** Theme and density are applied to <html> so the CSS can use them. */
function applyAppearance(s) {
  const root = document.documentElement
  if (s.theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', s.theme)
  root.setAttribute('data-density', s.density)
}

// Apply before the first render so the page doesn't flash the wrong theme.
applyAppearance(current)

// Keep several open tabs in sync.
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEYS.settings) return
  current = { ...DEFAULT_SETTINGS, ...load() }
  applyAppearance(current)
  listeners.forEach((fn) => fn())
})
