import { getSettings } from './settings.js'

/** 93784000 -> "1d 2h 3m 4s", always to the second. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d) return `${d}d ${h}h ${m}m ${sec}s`
  if (h) return `${h}h ${m}m ${sec}s`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

/** 120000 -> "2 minutes", 7200000 -> "2 hours" (for whole thresholds in text). */
export function formatThreshold(ms) {
  const units = [['hour', 3600e3], ['minute', 60e3], ['second', 1e3]]
  for (const [name, size] of units) {
    if (ms >= size && ms % size === 0) {
      const n = ms / size
      return `${n} ${name}${n === 1 ? '' : 's'}`
    }
  }
  return formatDuration(ms)
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
})
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export const formatDateTime = (t) => dateTime.format(new Date(t))
export const formatTime = (t) => timeOnly.format(new Date(t))
const dayOnly = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
export const formatDay = (t) => dayOnly.format(new Date(t))
// The sensor, API and database all use °C. What people see is °F or °C,
// whichever is chosen on the Settings page.
export const cToF = (c) => (c * 9) / 5 + 32
export const fToC = (f) => ((f - 32) * 5) / 9
/** "°F" or "°C". */
export const tempUnit = () => (getSettings().unit === 'C' ? '°C' : '°F')
/** °C value -> number in the display unit. */
export const toDisplayTemp = (c) => (getSettings().unit === 'C' ? c : cToF(c))
/** Number in the display unit -> °C (for settings inputs). */
export const fromDisplayTemp = (v) => (getSettings().unit === 'C' ? v : fToC(v))
/** 39.2 -> "39.2", 122 -> "122" (no trailing ".0"). */
const trim1 = (n) => String(+n.toFixed(1))
/** °C value -> "39.2 °F" (or "4.0 °C"). */
export const formatTemp = (c) => (c == null ? '–' : `${toDisplayTemp(c).toFixed(1)} ${tempUnit()}`)
/** °C threshold -> "39.2" in the display unit, no unit sign (axis labels, ranges). */
export const formatTempValue = (c) => trim1(toDisplayTemp(c))
/** The danger zone as people see it, e.g. "39.2–122 °F". */
export const dangerRangeLabel = () => {
  const { dangerMinC, dangerMaxC } = getSettings()
  return `${formatTempValue(dangerMinC)}–${formatTempValue(dangerMaxC)} ${tempUnit()}`
}