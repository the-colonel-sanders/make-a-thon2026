import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TemperatureChart } from '../components/TemperatureChart.jsx'
import { NotificationHistory } from '../components/NotificationHistory.jsx'
import { fetchReadingsRange } from '../lib/api.js'
import { downloadCsv, localDate, readingsToCsv } from '../lib/csv.js'
import { downsample } from '../lib/downsample.js'
import { dangerRangeLabel, formatDateTime, formatDuration, formatTemp } from '../lib/format.js'
import { buildIntervals, isInDangerZone } from '../lib/safety.js'

const DAY = 24 * 60 * 60 * 1000
const MAX_ROWS = 200_000 // matches MAX_RANGE_ROWS in api/main.py
const CHART_POINTS = 1200

const PRESETS = [
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Last 7 days' },
  { id: 'month', label: 'Last 30 days' },
  { id: 'custom', label: 'Custom range' },
]

function presetRange(id) {
  const now = Date.now()
  if (id === 'yesterday') {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return { start: today.getTime() - DAY, end: today.getTime() }
  }
  if (id === 'week') return { start: now - 7 * DAY, end: now }
  return { start: now - 30 * DAY, end: now }
}

/** Value for <input type="datetime-local"> in the viewer's local time. */
function toLocalInput(t) {
  const d = new Date(t)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}


/** Temperature log for a chosen time range, with a CSV export. */
export function HistoryPage({ applianceId, applianceIds, notifications, now, onDismissNotification, onClearNotifications }) {
  const [preset, setPreset] = useState('yesterday')
  const [scope, setScope] = useState('current') // 'current' appliance or 'all'
  const [customStart, setCustomStart] = useState(() => toLocalInput(Date.now() - DAY))
  const [customEnd, setCustomEnd] = useState(() => toLocalInput(Date.now()))
  const [range, setRange] = useState(() => presetRange('yesterday'))
  const [readings, setReadings] = useState([])
  const [status, setStatus] = useState('idle') // idle | loading | done | error
  const [error, setError] = useState(null)
  const controllerRef = useRef(null)

  const targetAppliance = scope === 'all' ? null : applianceId

  const load = useCallback(
    async (r) => {
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      setStatus('loading')
      setError(null)
      try {
        const rows = await fetchReadingsRange({ applianceId: targetAppliance, ...r }, controller.signal)
        setReadings(rows)
        setStatus('done')
      } catch (err) {
        if (err.name === 'AbortError') return
        setError(
          err.message.startsWith('404')
            ? 'The API doesn’t have the /readings/range endpoint yet. Restart the API server so it picks up the latest api/main.py.'
            : `Couldn’t load readings (${err.message}).`,
        )
        setStatus('error')
      }
    },
    [targetAppliance],
  )

  // Presets load immediately; a custom range loads when the user presses Apply.
  useEffect(() => {
    if (preset === 'custom') return
    const r = presetRange(preset)
    setRange(r)
    load(r)
  }, [preset, load])

  useEffect(() => () => controllerRef.current?.abort(), [])

  const customError = useMemo(() => {
    const s = Date.parse(customStart)
    const e = Date.parse(customEnd)
    if (!Number.isFinite(s) || !Number.isFinite(e)) return 'Pick both a start and an end.'
    if (e <= s) return 'The end must be after the start.'
    return null
  }, [customStart, customEnd])

  const applyCustom = (e) => {
    e.preventDefault()
    if (customError) return
    const r = { start: Date.parse(customStart), end: Math.min(Date.parse(customEnd), Date.now()) }
    setRange(r)
    load(r)
  }

  // Custom range: reload with the new appliance scope.
  useEffect(() => {
    if (preset === 'custom' && status !== 'idle') load(range)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetAppliance])

  const stats = useMemo(() => {
    if (!readings.length) return null
    // A plain loop: spreading 100k+ values into Math.min would overflow the stack.
    let min = Infinity
    let max = -Infinity
    let sum = 0
    let inZone = 0
    const byAppliance = new Map()
    for (const r of readings) {
      const t = r.temperature_c
      if (t < min) min = t
      if (t > max) max = t
      sum += t
      if (isInDangerZone(t)) inZone++
      if (!byAppliance.has(r.appliance_id)) byAppliance.set(r.appliance_id, [])
      byAppliance.get(r.appliance_id).push(r)
    }
    // Danger-zone time per appliance, each reading lasting until the next one.
    let dangerMs = 0
    for (const list of byAppliance.values()) {
      for (const iv of buildIntervals(list, Math.min(range.end, Date.now()))) {
        if (isInDangerZone(iv.tempC)) dangerMs += iv.end - iv.start
      }
    }
    return { count: readings.length, min, max, avg: sum / readings.length, inZone, dangerMs }
  }, [readings, range.end])

  const chartReadings = useMemo(
    () => (scope === 'all' && applianceIds.length > 1 ? [] : downsample(readings, CHART_POINTS)),
    [readings, scope, applianceIds.length],
  )

  const exportCsv = () => {
    const who = targetAppliance == null ? 'all-appliances' : `fridge-${targetAppliance}`
    downloadCsv(readingsToCsv(readings), `${who}_${localDate(range.start)}_to_${localDate(range.end)}.csv`)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-head__title">History</h1>
          <p className="page-head__sub">Browse past notifications and temperature logs, and export them as CSV</p>
        </div>
      </div>

      <NotificationHistory
        notifications={notifications}
        now={now}
        onDismiss={onDismissNotification}
        onClear={onClearNotifications}
      />

      <section className="card filters" aria-label="Time range">
        <div className="segmented" role="radiogroup" aria-label="Time range">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={preset === p.id}
              className={`segmented__btn ${preset === p.id ? 'is-active' : ''}`}
              onClick={() => setPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <label className="field field--inline">
          <span>Appliance</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="current">#{applianceId}</option>
            <option value="all">All appliances</option>
          </select>
        </label>

        {preset === 'custom' && (
          <form className="custom-range" onSubmit={applyCustom} noValidate>
            <label className="field">
              <span>From</span>
              <input type="datetime-local" value={customStart} max={customEnd} onChange={(e) => setCustomStart(e.target.value)} />
            </label>
            <label className="field">
              <span>To</span>
              <input type="datetime-local" value={customEnd} min={customStart} onChange={(e) => setCustomEnd(e.target.value)} />
            </label>
            <button type="submit" className="btn btn--primary" disabled={!!customError}>Apply</button>
            {customError && <p className="form-error">{customError}</p>}
          </form>
        )}
      </section>

      {error && (
        <div className="banner banner--critical" role="alert">
          <span className="banner__icon" aria-hidden="true">✕</span>
          <div><strong>{error}</strong></div>
        </div>
      )}

      {status !== 'idle' && (
        <section className={`card ${status === 'loading' ? 'is-loading' : ''}`} aria-labelledby="summary-heading">
          <div className="card__head">
            <div>
              <h2 id="summary-heading" className="card__title">
                {formatDateTime(range.start)} – {formatDateTime(range.end)}
              </h2>
              <p className="muted small">
                {targetAppliance == null ? 'All appliances' : `Fridge #${targetAppliance}`}
                {status === 'loading' && ' · Loading…'}
              </p>
            </div>
            <button type="button" className="btn btn--primary" onClick={exportCsv} disabled={!readings.length || status === 'loading'}>
              ⭳ Download CSV
            </button>
          </div>

          {stats ? (
            <dl className="stats stats--row">
              <div><dt>Readings</dt><dd>{stats.count.toLocaleString()}</dd></div>
              <div><dt>Low</dt><dd>{formatTemp(stats.min)}</dd></div>
              <div><dt>High</dt><dd>{formatTemp(stats.max)}</dd></div>
              <div><dt>Average</dt><dd>{formatTemp(stats.avg)}</dd></div>
              <div>
                <dt>In danger zone ({dangerRangeLabel()})</dt>
                <dd>{formatDuration(stats.dangerMs)} · {stats.inZone.toLocaleString()} readings</dd>
              </div>
            </dl>
          ) : (
            status === 'done' && <p className="empty">No readings in this time range.</p>
          )}

          {readings.length >= MAX_ROWS && (
            <p className="temp-card__stale">
              ⚠ This range has more than {MAX_ROWS.toLocaleString()} readings; only the first {MAX_ROWS.toLocaleString()} are
              included. Pick a shorter range to export the rest.
            </p>
          )}
        </section>
      )}

      {stats && chartReadings.length > 0 && (
        <TemperatureChart
          title="Temperature over this range"
          readings={chartReadings}
          note={chartReadings.length < readings.length ? `Chart averages every ${Math.ceil(readings.length / CHART_POINTS)} readings; the CSV has them all.` : null}
        />
      )}
    </>
  )
}
