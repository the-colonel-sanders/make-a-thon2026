import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchDevices, locateDevice, stopLocateDevice, updateDevice } from '../lib/api.js'
import { formatDateTime, formatDuration, formatTemp } from '../lib/format.js'

const POLL_MS = 3000
// The firmware checks in every 250 ms; no check-in for this long means it's not connected.
const CONNECTED_WITHIN_MS = 15_000
const DURATIONS = [
  { seconds: 15, label: '15 s' },
  { seconds: 30, label: '30 s' },
  { seconds: 60, label: '1 min' },
  { seconds: 120, label: '2 min' },
]

/** Map-pin logo shown beside each device panel; rings pulse while locating. */
function LocationLogo({ active }) {
  return (
    <span className={`loc-logo ${active ? 'is-active' : ''}`} aria-hidden="true">
      {active && (
        <>
          <span className="loc-logo__ring" />
          <span className="loc-logo__ring loc-logo__ring--2" />
        </>
      )}
      <svg viewBox="0 0 24 24">
        <path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z" />
        <circle cx="12" cy="10" r="2.6" />
      </svg>
    </span>
  )
}

/** Three dots mirroring the device's LEDs: all flash together while locating. */
function LedPreview({ active }) {
  return (
    <span className={`led-preview ${active ? 'is-flashing' : ''}`} title={active ? 'All three LEDs are flashing' : 'LEDs'}>
      <span className="led led--red" />
      <span className="led led--yellow" />
      <span className="led led--green" />
    </span>
  )
}

function signal(rssi) {
  if (rssi == null) return { label: '–', bars: 0 }
  if (rssi >= -60) return { label: 'Excellent', bars: 4 }
  if (rssi >= -70) return { label: 'Good', bars: 3 }
  if (rssi >= -80) return { label: 'Fair', bars: 2 }
  return { label: 'Weak', bars: 1 }
}

function SignalBars({ rssi }) {
  const s = signal(rssi)
  return (
    <span className="signal" title={rssi != null ? `${rssi} dBm` : 'No data'}>
      <span className="signal__bars" aria-hidden="true">
        {[1, 2, 3, 4].map((b) => <span key={b} className={b <= s.bars ? 'is-on' : ''} style={{ height: `${b * 25}%` }} />)}
      </span>
      {s.label}{rssi != null && <span className="muted"> ({rssi} dBm)</span>}
    </span>
  )
}

const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function DevicePanel({ device, clockOffset, now, duration, onLocate, onStop, onSaveLocation }) {
  const [editing, setEditing] = useState(false)
  const [location, setLocation] = useState(device.location ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Server timestamps compared on the server's clock, so a skewed PC clock doesn't matter.
  const serverNow = now + clockOffset
  const lastCheckin = device.last_checkin_at ? Date.parse(device.last_checkin_at) : null
  const connected = lastCheckin != null && serverNow - lastCheckin < CONNECTED_WITHIN_MS
  const remaining = device.locate_until ? Date.parse(device.locate_until) - serverNow : 0
  const locating = device.locating && remaining > 0

  const run = async (fn) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const saveLocation = (e) => {
    e.preventDefault()
    run(async () => {
      await onSaveLocation(device.id, location.trim() || null)
      setEditing(false)
    })
  }

  return (
    <article className={`device-panel ${locating ? 'is-locating' : ''}`} aria-labelledby={`dev-${device.id}`}>
      <LocationLogo active={locating} />
      <div className="device-panel__body">
        <div className="device-panel__head">
          <div>
            <h2 id={`dev-${device.id}`} className="device-panel__name">
              {device.name} <span className="muted small">#{device.id} · {device.kind}</span>
            </h2>
            {editing ? (
              <form className="inline-edit" onSubmit={saveLocation}>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Kitchen, back wall"
                  maxLength={120}
                  autoFocus
                  aria-label={`Location of ${device.name}`}
                />
                <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>Save</button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditing(false); setLocation(device.location ?? '') }}>
                  Cancel
                </button>
              </form>
            ) : (
              <p className="device-panel__location">
                {device.location ? <span>📍 {device.location}</span> : <span className="muted">No location set</span>}
                <button type="button" className="link-btn" onClick={() => setEditing(true)}>
                  {device.location ? 'Edit' : 'Add location'}
                </button>
              </p>
            )}
          </div>
          <span className={`conn ${connected ? 'conn--device-on' : 'conn--device-off'}`}>
            <span className="conn__dot" aria-hidden="true" />
            {connected ? 'Connected' : 'Not connected'}
          </span>
        </div>

        <dl className="device-panel__facts">
          <div>
            <dt>Last check-in</dt>
            <dd>
              {lastCheckin == null
                ? <span className="muted">Never (needs the latest firmware)</span>
                : `${formatDuration(serverNow - lastCheckin).split(' ').slice(0, 2).join(' ')} ago`}
            </dd>
          </div>
          <div>
            <dt>Last reading</dt>
            <dd>
              {device.last_temperature_c != null
                ? <>{formatTemp(device.last_temperature_c)} <span className="muted small">{formatDateTime(device.last_reading_at)}</span></>
                : <span className="muted">None yet</span>}
            </dd>
          </div>
          <div><dt>Wi-Fi signal</dt><dd><SignalBars rssi={device.rssi} /></dd></div>
          <div><dt>IP address</dt><dd>{device.ip ?? <span className="muted">–</span>}</dd></div>
        </dl>

        <div className="device-panel__actions">
          <LedPreview active={locating} />
          {locating ? (
            <>
              <span className="locate-status" role="status">
                Flashing all LEDs · <strong>{mmss(remaining)}</strong> left
              </span>
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => run(() => onStop(device.id))}>
                Stop
              </button>
            </>
          ) : (
            <button type="button" className="btn btn--primary btn--find" disabled={busy} onClick={() => run(() => onLocate(device.id, duration))}>
              <svg viewBox="0 0 24 24" aria-hidden="true" className="btn__icon">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m20 20-4.4-4.4" />
              </svg>
              Find my device
            </button>
          )}
        </div>
        {locating && !connected && (
          <p className="device-panel__note">
            This device isn’t checking in right now. It will start flashing if it reconnects before the timer runs out.
          </p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
    </article>
  )
}

/**
 * Finder for every ESP32: where each one is, whether it's connected, and a
 * "Find my device" button that makes all three of its LEDs flash.
 */
export function LocatePage({ now }) {
  const [devices, setDevices] = useState([])
  const [status, setStatus] = useState('loading') // loading | done | error
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [duration, setDuration] = useState(30)
  const [clockOffset, setClockOffset] = useState(0) // server clock minus this PC's clock
  const controllerRef = useRef(null)

  const load = useCallback(async () => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const list = await fetchDevices(controller.signal)
      setDevices(list)
      if (list[0]?.server_time) setClockOffset(Date.parse(list[0].server_time) - Date.now())
      setError(null)
      setStatus('done')
    } catch (err) {
      if (err.name === 'AbortError') return
      setError(
        err.message.startsWith('404')
          ? 'The API doesn’t have the device endpoints yet. Restart it so it picks up the latest api/main.py.'
          : `Couldn’t load devices (${err.message}).`,
      )
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      clearInterval(id)
      controllerRef.current?.abort()
    }
  }, [load])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return devices
    return devices.filter((d) =>
      [d.name, d.location, d.kind, `#${d.id}`, String(d.id)].some((v) => v && String(v).toLowerCase().includes(q)),
    )
  }, [devices, query])

  const locatingCount = devices.filter((d) => d.locating).length

  // Every action refreshes the list right away so the panel updates without waiting for the next poll.
  const act = (fn) => async (...args) => {
    await fn(...args)
    await load()
  }

  return (
    <>
      <div className="page-head">
        <div className="page-head__with-icon">
          <LocationLogo active={locatingCount > 0} />
          <div>
            <h1 className="page-head__title">Locate devices</h1>
            <p className="page-head__sub">Find a sensor by making all three of its LEDs flash</p>
          </div>
        </div>
      </div>

      <section className="card finder" aria-label="Find a device">
        <label className="field finder__search">
          <span>Search</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, location or device number"
          />
        </label>
        <label className="field field--inline">
          <span>Flash for</span>
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
            {DURATIONS.map((d) => <option key={d.seconds} value={d.seconds}>{d.label}</option>)}
          </select>
        </label>
        <p className="muted small finder__count">
          {devices.length} device{devices.length === 1 ? '' : 's'}
          {locatingCount > 0 && ` · ${locatingCount} flashing now`}
        </p>
      </section>

      {error && (
        <div className="banner banner--critical" role="alert">
          <span className="banner__icon" aria-hidden="true">✕</span>
          <div><strong>{error}</strong></div>
        </div>
      )}

      {status === 'loading' && <p className="empty">Loading devices…</p>}
      {status === 'done' && devices.length === 0 && (
        <p className="empty">No devices yet. Add a row to the appliances table for each ESP32.</p>
      )}
      {status === 'done' && devices.length > 0 && visible.length === 0 && (
        <p className="empty">No device matches “{query}”.</p>
      )}

      <div className="device-list">
        {visible.map((d) => (
          <DevicePanel
            key={d.id}
            device={d}
            now={now}
            clockOffset={clockOffset}
            duration={duration}
            onLocate={act(locateDevice)}
            onStop={act(stopLocateDevice)}
            onSaveLocation={act((id, location) => updateDevice(id, { location }))}
          />
        ))}
      </div>
    </>
  )
}
