import { STORAGE_KEYS } from './storageKeys.js'
import { localDate } from './csv.js'

// Everything the dashboard keeps in this browser (items, employees,
// notifications, settings) can be saved to a JSON file and restored, e.g. to
// move to another computer.

const FORMAT = 'fridge-monitor-backup'
const VERSION = 1

/** Download a JSON backup of all local data. */
export function exportBackup() {
  const data = {}
  for (const [name, key] of Object.entries(STORAGE_KEYS)) {
    try {
      const raw = localStorage.getItem(key)
      data[name] = raw == null ? null : JSON.parse(raw)
    } catch {
      data[name] = null
    }
  }
  const body = JSON.stringify({ format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), data }, null, 2)
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `fridge-monitor-backup_${localDate(Date.now())}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Replace all local data with a backup file's contents.
 * Resolves with a short summary; rejects with a readable message if the file isn't a backup.
 */
export async function importBackup(file) {
  let parsed
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new Error('That file isn’t valid JSON.')
  }
  if (parsed?.format !== FORMAT || typeof parsed.data !== 'object' || parsed.data === null) {
    throw new Error('That file isn’t a Food Saver backup.')
  }
  const { data } = parsed
  const lists = ['items', 'profiles', 'notifications']
  for (const name of lists) {
    if (data[name] != null && !Array.isArray(data[name])) throw new Error(`The backup’s “${name}” section is damaged.`)
  }
  for (const [name, key] of Object.entries(STORAGE_KEYS)) {
    if (data[name] == null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(data[name]))
  }
  return {
    items: data.items?.length ?? 0,
    profiles: data.profiles?.length ?? 0,
    exportedAt: parsed.exportedAt,
  }
}

/** Delete every piece of local data. */
export function eraseAllData() {
  for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key)
}
