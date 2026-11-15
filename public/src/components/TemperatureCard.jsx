import { StatusBadge } from './StatusBadge.jsx'
import { dangerRangeLabel, formatDateTime, formatDuration, formatTemp, formatThreshold } from '../lib/format.js'
import { continuousZoneMs, deviceState, isInDangerZone, isNearZone, temperatureStatus } from '../lib/safety.js'
import { getSettings } from '../lib/settings.js'

function message(status, zoneMs, tempC) {
  const ZONE = dangerRangeLabel()
  if (status === 'unknown') return 'Waiting for the first reading from the sensor'
  if (status === 'critical') return `In the danger zone (${ZONE}) for ${formatDuration(zoneMs)}`
  if (status === 'warning') {
    return `Entered the danger zone (${ZONE}) ${formatDuration(zoneMs)} ago. Turns red at ${formatThreshold(getSettings().redExposureMs)}.`
  }
  return isNearZone(tempC) ? 'Outside the danger zone, but close to it' : 'Outside the danger zone'
}

/**
 * Current temperature. When the ESP32 stops reporting, the card switches to a
 * gray "Device off" state and shows the last temperature it sent.
 */
export function TemperatureCard({ readings, now, lastCheckinAt }) {
  const latest = readings.at(-1)
  const device = deviceState(latest, now, lastCheckinAt)
  const off = device === 'off'
  const zoneMs = continuousZoneMs(readings, now)
  const status = off ? 'offline' : temperatureStatus(latest?.temperature_c, zoneMs)
  const temps = readings.map((r) => r.temperature_c)
  const min = temps.length ? Math.min(...temps) : null
  const max = temps.length ? Math.max(...temps) : null

  return (
    <section className={`card temp-card temp-card--${status}`} aria-labelledby="temp-heading">
      <div className="card__head">
        <h2 id="temp-heading" className="card__title">{off ? 'Last known temperature' : 'Current temperature'}</h2>
        {/* "Spoiled" is for food; the fridge itself is "Unsafe" when red. */}
        <StatusBadge status={status} label={status === 'critical' ? 'Unsafe' : undefined} />
      </div>
      <p className="temp-card__value">{formatTemp(latest?.temperature_c)}</p>
      {off ? (
        <div className="temp-card__offline" role="status">
          <strong>Device off</strong>
          <p>
            The sensor hasn’t sent a reading for {formatDuration(now - latest.time)}. This is the last
            temperature it reported, at {formatDateTime(latest.time)}.
          </p>
          {isInDangerZone(latest.temperature_c) && (
            <p className="temp-card__offline-warn">
              ⚠ That last reading was in the danger zone ({dangerRangeLabel()}). Check the fridge directly.
            </p>
          )}
        </div>
      ) : (
        <p className="temp-card__msg">{message(status, zoneMs, latest?.temperature_c)}</p>
      )}
      <dl className="stats">
        <div><dt>{off ? 'Last seen' : 'Last reading'}</dt><dd>{latest ? formatDateTime(latest.time) : '–'}</dd></div>
        <div><dt>Low</dt><dd>{formatTemp(min)}</dd></div>
        <div><dt>High</dt><dd>{formatTemp(max)}</dd></div>
        <div><dt>Readings</dt><dd>{readings.length}</dd></div>
      </dl>
    </section>
  )
}
