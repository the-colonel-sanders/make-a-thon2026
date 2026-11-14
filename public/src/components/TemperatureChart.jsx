import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { dangerRangeLabel, formatDateTime, formatDay, formatTemp, formatTempValue, formatTime, tempUnit, toDisplayTemp } from '../lib/format.js'
import { isInDangerZone } from '../lib/safety.js'
import { getSettings } from '../lib/settings.js'

const HEIGHT = 240
const PAD = { top: 12, right: 16, bottom: 28, left: 44 }

function useWidth(ref) {
  const [width, setWidth] = useState(600)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Measure right away (before paint) so a chart that mounts late, e.g. after
    // data loads, doesn't wait on the observer; then track later resizes.
    setWidth(Math.max(260, el.getBoundingClientRect().width))
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

function niceTicks(lo, hi, count = 5) {
  const rough = (hi - lo) / count
  const mag = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough)
  const ticks = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6))
  return ticks
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function niceTimeTicks(t0, t1, count) {
  const subDay = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720].map((m) => m * MINUTE)
  const step = subDay.find((s) => (t1 - t0) / s <= count)
  const ticks = []
  if (step) {
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t)
    return ticks
  }
  // Day-or-longer steps land on local midnight, not UTC midnight.
  const days = [1, 2, 3, 7, 14].find((d) => (t1 - t0) / (d * DAY) <= count) ?? 30
  const d = new Date(t0)
  d.setHours(0, 0, 0, 0)
  if (d.getTime() < t0) d.setDate(d.getDate() + 1)
  for (; d.getTime() <= t1; d.setDate(d.getDate() + days)) ticks.push(d.getTime())
  return ticks
}

/** Temperature line over time, with the danger zone shaded and a hover crosshair. */
export function TemperatureChart({ readings, title = 'Temperature history', note = null }) {
  const wrapRef = useRef(null)
  const width = useWidth(wrapRef)
  const [hover, setHover] = useState(null)
  const [showTable, setShowTable] = useState(false)

  const geom = useMemo(() => {
    if (readings.length < 2) return null
    const t0 = readings[0].time
    const t1 = readings.at(-1).time
    // The vertical scale is in the display unit (°F or °C); readings arrive in °C.
    const { dangerMinC, dangerMaxC, unit } = getSettings()
    const temps = readings.map((r) => toDisplayTemp(r.temperature_c))
    const zoneLo = toDisplayTemp(dangerMinC)
    const zoneHi = toDisplayTemp(dangerMaxC)
    const pad = unit === 'C' ? 2 : 3
    // Always include the lower zone boundary so the threshold line is visible.
    const lo = Math.min(...temps, zoneLo) - pad
    let hi = Math.max(...temps) + pad
    if (hi - lo < pad * 3) hi = lo + pad * 3
    const innerW = width - PAD.left - PAD.right
    const innerH = HEIGHT - PAD.top - PAD.bottom
    const x = (t) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * innerW
    const y = (f) => PAD.top + (1 - (f - lo) / (hi - lo)) * innerH
    const yC = (c) => y(toDisplayTemp(c))
    const path = readings
      .map((r, i) => `${i ? 'L' : 'M'}${x(r.time).toFixed(1)},${yC(r.temperature_c).toFixed(1)}`)
      .join('')
    return {
      x, y, yC, lo, hi, path, innerW,
      thresholds: [dangerMinC, dangerMaxC].filter((c) => toDisplayTemp(c) > lo && toDisplayTemp(c) < hi),
      // Long ranges label the axis with dates instead of clock times.
      tickLabel: t1 - t0 > 36 * HOUR ? formatDay : formatTime,
      bandTop: y(Math.min(zoneHi, hi)),
      bandBottom: y(Math.max(zoneLo, lo)),
      yTicks: niceTicks(lo, hi),
      xTicks: niceTimeTicks(t0, t1, Math.max(2, Math.floor(innerW / 110))),
    }
  }, [readings, width])

  const onMove = (e) => {
    if (!geom) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * width
    let best = 0
    let bestDist = Infinity
    readings.forEach((r, i) => {
      const d = Math.abs(geom.x(r.time) - px)
      if (d < bestDist) { bestDist = d; best = i }
    })
    setHover(best)
  }

  const h = hover != null && geom ? readings[hover] : null

  return (
    <section className="card" aria-labelledby="chart-heading">
      <div className="card__head">
        <h2 id="chart-heading" className="card__title">{title}</h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {showTable ? (
        <ReadingsTable readings={readings} />
      ) : (
        <div className="chart" ref={wrapRef}>
          {!geom ? (
            <p className="empty">The chart appears once there are at least two readings.</p>
          ) : (
            <>
              <svg
                width={width}
                height={HEIGHT}
                viewBox={`0 0 ${width} ${HEIGHT}`}
                role="img"
                aria-label={`Temperature from ${formatDateTime(readings[0].time)} to ${formatDateTime(readings.at(-1).time)}`}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
              >
                {geom.bandBottom > geom.bandTop && (
                  <rect
                    className="chart__band"
                    x={PAD.left}
                    width={geom.innerW}
                    y={geom.bandTop}
                    height={geom.bandBottom - geom.bandTop}
                  />
                )}
                {geom.yTicks.map((v) => (
                  <g key={v}>
                    <line className="chart__grid" x1={PAD.left} x2={width - PAD.right} y1={geom.y(v)} y2={geom.y(v)} />
                    <text className="chart__tick" x={PAD.left - 8} y={geom.y(v)} dy="0.32em" textAnchor="end">{v}°</text>
                  </g>
                ))}
                {geom.xTicks.map((t) => (
                  <text key={t} className="chart__tick" x={geom.x(t)} y={HEIGHT - 8} textAnchor="middle">
                    {geom.tickLabel(t)}
                  </text>
                ))}
                {geom.thresholds.map((c) => (
                  <g key={c}>
                    <line className="chart__threshold" x1={PAD.left} x2={width - PAD.right} y1={geom.yC(c)} y2={geom.yC(c)} />
                    <text className="chart__threshold-label" x={width - PAD.right - 4} y={geom.yC(c) - 5} textAnchor="end">
                      {formatTempValue(c)} {tempUnit()}
                    </text>
                  </g>
                ))}
                <path className="chart__line" d={geom.path} />
                {h && (
                  <g>
                    <line
                      className="chart__crosshair"
                      x1={geom.x(h.time)} x2={geom.x(h.time)}
                      y1={PAD.top} y2={HEIGHT - PAD.bottom}
                    />
                    <circle className="chart__dot" cx={geom.x(h.time)} cy={geom.yC(h.temperature_c)} r={5} />
                  </g>
                )}
              </svg>
              {h && (
                <div
                  className="tooltip"
                  style={{
                    left: Math.max(0, Math.min(geom.x(h.time) + 12, width - 170)),
                    top: Math.max(0, geom.yC(h.temperature_c) - 64),
                  }}
                >
                  <strong>{formatTemp(h.temperature_c)}</strong>
                  <span>{formatDateTime(h.time)}</span>
                  {isInDangerZone(h.temperature_c) && <span className="tooltip__warn">✕ In danger zone</span>}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <p className="chart__legend">
        <span className="legend-swatch" aria-hidden="true" /> Shaded area: danger zone ({dangerRangeLabel()})
        {note && <span className="muted"> · {note}</span>}
      </p>
    </section>
  )
}

function ReadingsTable({ readings }) {
  const rows = readings.slice(-50).reverse()
  if (!rows.length) return <p className="empty">No readings yet.</p>
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th>Time</th><th className="num">Temperature</th><th>Zone</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{formatDateTime(r.time)}</td>
              <td className="num">{formatTemp(r.temperature_c)}</td>
              <td>{isInDangerZone(r.temperature_c) ? 'Danger zone' : 'Outside'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {readings.length > 50 && <p className="muted small">Latest 50 of {readings.length} readings.</p>}
    </div>
  )
}
