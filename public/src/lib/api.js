// Thin client for the FastAPI backend. All paths go through the Vite /api proxy.
const BASE = '/api'

async function getJson(path, signal) {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

/** GET /health -> true when the API and its database are reachable. */
export async function fetchHealth(signal) {
  const body = await getJson('/health', signal)
  return body.status === 'ok'
}

const withTime = (rows) =>
  rows.map((r) => ({ ...r, time: Date.parse(r.recorded_at) })).filter((r) => Number.isFinite(r.time))

/**
 * GET /readings/range -> every reading in [start, end), oldest first.
 * `applianceId` null means all appliances.
 */
export async function fetchReadingsRange({ applianceId, start, end }, signal) {
  const params = new URLSearchParams({
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  })
  if (applianceId != null) params.set('appliance_id', String(applianceId))
  return withTime(await getJson(`/readings/range?${params}`, signal))
}

/**
 * GET /readings -> [{ id, appliance_id, recorded_at, temperature_c }], newest first.
 * Returned oldest-first with parsed timestamps (`time`, in ms) for easier math.
 */
export async function fetchReadings({ applianceId, limit }, signal) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (applianceId != null) params.set('appliance_id', String(applianceId))
  const rows = await getJson(`/readings?${params}`, signal)
  return rows
    .map((r) => ({ ...r, time: Date.parse(r.recorded_at) }))
    .filter((r) => Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time)
}

/** FastAPI's error detail as a readable sentence (validation errors are a list). */
async function errorMessage(res) {
  try {
    const { detail } = await res.json()
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) return detail.map((d) => d.msg.replace(/^Value error, /, '')).join('; ')
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `${res.status} ${res.statusText}`
}

/** Server thresholds -> the dashboard's settings fields (°C and ms). */
const thresholdsToSettings = (t) => ({
  dangerMinC: t.danger_min_c,
  dangerMaxC: t.danger_max_c,
  redExposureMs: t.spoil_after_seconds * 1000,
})

/** GET /settings/thresholds -> { dangerMinC, dangerMaxC, redExposureMs }. */
export async function fetchThresholds(signal) {
  return thresholdsToSettings(await getJson('/settings/thresholds', signal))
}

/** PUT /settings/thresholds. Returns what the database saved, in settings form. */
export async function saveThresholds({ dangerMinC, dangerMaxC, redExposureMs }) {
  const res = await fetch(`${BASE}/settings/thresholds`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      danger_min_c: dangerMinC,
      danger_max_c: dangerMaxC,
      spoil_after_seconds: Math.round(redExposureMs / 1000),
    }),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return thresholdsToSettings(await res.json())
}

/** DELETE /readings -> number of readings erased. `applianceId` null erases every appliance's. */
export async function deleteReadings(applianceId) {
  const query = applianceId != null ? `?appliance_id=${encodeURIComponent(applianceId)}` : ''
  const res = await fetch(`${BASE}/readings${query}`, { method: 'DELETE', headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(await errorMessage(res))
  return (await res.json()).deleted
}

// ---------------------------------------------------------------------------
// Devices & "find my device" (api/main.py /devices)
// ---------------------------------------------------------------------------

async function send(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessage(res))
  return res.json()
}

/** GET /devices -> every appliance with location, latest reading and check-in info. */
export async function fetchDevices(signal) {
  return getJson('/devices', signal)
}

/** Ask a device to flash all its LEDs for `seconds`. */
export const locateDevice = (id, seconds) => send('POST', `/devices/${id}/locate`, { seconds })

/** Stop flashing early. */
export const stopLocateDevice = (id) => send('DELETE', `/devices/${id}/locate`)

/** Rename a device or set its location text. */
export const updateDevice = (id, patch) => send('PATCH', `/devices/${id}`, patch)
