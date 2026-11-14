import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { TemperatureChart } from '../components/TemperatureChart.jsx'
import { fetchReadingsRange } from '../lib/api.js'
import { downloadCsv, localDate, readingsToCsv } from '../lib/csv.js'
import { downsample } from '../lib/downsample.js'
import { dangerRangeLabel, formatDateTime, formatDuration, formatTemp, formatThreshold } from '../lib/format.js'
import { buildIntervals, dangerExposureMs, isInDangerZone, itemStatus } from '../lib/safety.js'
import { getSettings } from '../lib/settings.js'

const CHART_POINTS = 1200

/**
 * One food item: its details, danger-zone exposure and the fridge temperature
 * for the whole time it has been (or was) in the fridge.
 */
export function ItemPage({ itemId, items, now, liveReadings, liveApplianceId, inZoneNow, onRemove, onRestore }) {
  const item = items.find((it) => it.id === itemId)
  const [readings, setReadings] = useState([])
  const [status, setStatus] = useState('loading') // loading | done | error
  const [error, setError] = useState(null)
  const controllerRef = useRef(null)

  const placed = item ? Date.parse(item.placed_at) : null
  const removedAt = item?.removed_at ? Date.parse(item.removed_at) : null

  // Fetch every reading from when the item went in until it came out (or now).
  const load = useCallback(async () => {
    if (!item) return
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    try {
      const rows = await fetchReadingsRange(
        { applianceId: item.appliance_id, start: placed, end: (removedAt ?? Date.now()) + 1000 },
        controller.signal,
      )
      setReadings(rows)
      setError(null)
      setStatus('done')
    } catch (err) {
      if (err.name === 'AbortError') return
      // Older API without /readings/range: fall back to the recent readings already loaded.
      if (err.message.startsWith('404') && liveApplianceId === item.appliance_id) {
        setReadings(liveReadings.filter((r) => r.time >= placed && (removedAt == null || r.time <= removedAt)))
        setError('Showing recent readings only. Restart the API to load this item’s full history.')
        setStatus('done')
      } else {
        setError(`Couldn’t load readings (${err.message}).`)
        setStatus('error')
      }
    }
    // Only refetch when the item itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, item?.appliance_id, placed, removedAt])

  useEffect(() => {
    setStatus('loading')
    load()
    return () => controllerRef.current?.abort()
  }, [load])

  // While the item is still in the fridge, append new live readings as they arrive.
  useEffect(() => {
    if (!item || removedAt != null || liveApplianceId !== item.appliance_id) return
    setReadings((prev) => {
      const last = prev.at(-1)?.time ?? placed - 1
      const fresh = liveReadings.filter((r) => r.time > last && r.time >= placed)
      return fresh.length ? [...prev, ...fresh] : prev
    })
  }, [liveReadings, liveApplianceId, item, removedAt, placed])

  const stats = useMemo(() => {
    if (!item) return null
    const end = removedAt ?? now
    const exposureMs = dangerExposureMs(item, buildIntervals(readings, end), end)
    const sameFridge = liveApplianceId === item.appliance_id
    let min = Infinity
    let max = -Infinity
    let sum = 0
    for (const r of readings) {
      if (r.temperature_c < min) min = r.temperature_c
      if (r.temperature_c > max) max = r.temperature_c
      sum += r.temperature_c
    }
    return {
      storedMs: end - placed,
      exposureMs,
      status: itemStatus(exposureMs, removedAt == null && sameFridge && inZoneNow),
      min: readings.length ? min : null,
      max: readings.length ? max : null,
      avg: readings.length ? sum / readings.length : null,
      inZone: readings.filter((r) => isInDangerZone(r.temperature_c)).length,
    }
  }, [item, readings, now, removedAt, placed, liveApplianceId, inZoneNow])

  const chartReadings = useMemo(() => downsample(readings, CHART_POINTS), [readings])

  if (!item) {
    return (
      <div className="card">
        <h1 className="page-head__title">Item not found</h1>
        <p className="muted">It may have been deleted, or it was added in a different browser.</p>
        <p><a className="btn btn--ghost" href="#/">← Back to the dashboard</a></p>
      </div>
    )
  }

  const exportCsv = () => {
    const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item'
    downloadCsv(readingsToCsv(readings), `${slug}_${localDate(placed)}_to_${localDate(removedAt ?? now)}.csv`)
  }

  const pct = Math.min(100, (stats.exposureMs / getSettings().redExposureMs) * 100)

  return (
    <>
      <a className="back-link" href="#/">← Home</a>
      <div className="page-head">
        <div>
          <h1 className="page-head__title">{item.name}</h1>
          <p className="page-head__sub">
            Fridge #{item.appliance_id}
            {item.added_by_name && <> · added by {item.added_by_name}</>}
            {removedAt != null && <> · removed{item.removed_by_name ? ` by ${item.removed_by_name}` : ''}</>}
          </p>
        </div>
        <div className="page-head__actions">
          {removedAt == null ? (
            <button type="button" className="btn btn--ghost" onClick={() => onRemove(item.id)}>Mark as removed</button>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={() => onRestore(item.id)}>Put back in fridge</button>
          )}
          <button type="button" className="btn btn--primary" onClick={exportCsv} disabled={!readings.length}>
            ⭳ Download CSV
          </button>
        </div>
      </div>

      {error && (
        <div className={`banner ${status === 'error' ? 'banner--critical' : 'banner--warning'}`} role="status">
          <span className="banner__icon" aria-hidden="true">!</span>
          <div><strong>{error}</strong></div>
        </div>
      )}

      <section className={`card item-summary item-summary--${stats.status}`} aria-label="Item summary">
        <div className="card__head">
          <h2 className="card__title">Food safety</h2>
          <StatusBadge status={stats.status} />
        </div>
        <dl className="stats stats--row">
          <div><dt>Placed</dt><dd>{formatDateTime(placed)}</dd></div>
          <div><dt>{removedAt != null ? 'Removed' : 'Still in fridge'}</dt><dd>{removedAt != null ? formatDateTime(removedAt) : 'Yes'}</dd></div>
          <div><dt>{removedAt != null ? 'Time stored' : 'Time in fridge'}</dt><dd>{formatDuration(stats.storedMs)}</dd></div>
          <div>
            <dt>Danger-zone time ({dangerRangeLabel()})</dt>
            <dd>{formatDuration(stats.exposureMs)}</dd>
            <span className={`meter meter--${stats.status} meter--left`} aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
          </div>
        </dl>
        <p className="muted small">
          {stats.status === 'critical' && `This item has spent ${formatThreshold(getSettings().redExposureMs)} or more at unsafe temperatures. Consider discarding it.`}
          {stats.status === 'warning' && `Turns red after ${formatThreshold(getSettings().redExposureMs)} in the danger zone.`}
          {stats.status === 'safe' && 'No time in the danger zone so far.'}
        </p>
      </section>

      <section className={`card ${status === 'loading' ? 'is-loading' : ''}`} aria-label="Temperature while stored">
        <div className="card__head">
          <h2 className="card__title">Fridge temperature while stored</h2>
          {status === 'loading' && <span className="muted small">Loading…</span>}
        </div>
        {readings.length ? (
          <dl className="stats stats--row">
            <div><dt>Readings</dt><dd>{readings.length.toLocaleString()}</dd></div>
            <div><dt>Low</dt><dd>{formatTemp(stats.min)}</dd></div>
            <div><dt>High</dt><dd>{formatTemp(stats.max)}</dd></div>
            <div><dt>Average</dt><dd>{formatTemp(stats.avg)}</dd></div>
            <div><dt>Readings in danger zone</dt><dd>{stats.inZone.toLocaleString()}</dd></div>
          </dl>
        ) : (
          status !== 'loading' && <p className="empty">No temperature readings since this item was added.</p>
        )}
      </section>

      {chartReadings.length > 0 && (
        <TemperatureChart
          title={`Temperature history for ${item.name}`}
          readings={chartReadings}
          note={chartReadings.length < readings.length ? `Chart averages every ${Math.ceil(readings.length / CHART_POINTS)} readings; the CSV has them all.` : null}
        />
      )}
    </>
  )
}
