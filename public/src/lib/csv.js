import { isInDangerZone } from './safety.js'
import { cToF } from './format.js'

const pad = (n) => String(n).padStart(2, '0')

/** "2026-11-14 15:07:42" in the viewer's local time (Excel-friendly). */
function localStamp(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** "2026-11-14" in local time, for file names. */
export const localDate = (t) => localStamp(t).slice(0, 10)

/** Build a CSV of readings. Values are numbers/timestamps, so no quoting is needed. */
export function readingsToCsv(readings) {
  const header = ['reading_id', 'appliance_id', 'recorded_at_utc', 'recorded_at_local', 'temperature_f', 'temperature_c', 'in_danger_zone']
  const lines = readings.map((r) =>
    [
      r.id,
      r.appliance_id,
      new Date(r.time).toISOString(),
      localStamp(r.time),
      cToF(r.temperature_c).toFixed(2),
      r.temperature_c.toFixed(2),
      isInDangerZone(r.temperature_c) ? 'yes' : 'no',
    ].join(','),
  )
  return [header.join(','), ...lines].join('\r\n') + '\r\n'
}

/** Trigger a browser download of `text` as `filename`. */
export function downloadCsv(text, filename) {
  // The byte-order mark makes Excel open the file as UTF-8.
  const blob = new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
