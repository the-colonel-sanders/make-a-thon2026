import { useEffect, useState } from 'react'
import { syncThresholds } from '../hooks/useServerThresholds.js'
import { deleteReadings, saveThresholds } from '../lib/api.js'
import { cToF, fToC, formatThreshold } from '../lib/format.js'
import { DEFAULT_SETTINGS, updateSettings, useSettings } from '../lib/settings.js'
import { itemStatus } from '../lib/safety.js'
import { StatusBadge } from '../components/StatusBadge.jsx'

// The admin page always works in °F. Settings store °C (like the sensor and
// database), so values are converted on the way in and out.
const UNITS = [
  { id: 'sec', label: 'seconds', ms: 1000 },
  { id: 'min', label: 'minutes', ms: 60_000 },
  { id: 'hr', label: 'hours', ms: 3_600_000 },
]

const round1 = (n) => String(+n.toFixed(1))

/** Largest unit that divides the time evenly, so 7200000 shows as "2 hours". */
function splitDuration(ms) {
  const unit = [...UNITS].reverse().find((u) => ms >= u.ms && ms % u.ms === 0) ?? UNITS[0]
  return { amount: String(ms / unit.ms), unit: unit.id }
}

function toForm(s) {
  const { amount, unit } = splitDuration(s.redExposureMs)
  return { minF: round1(cToF(s.dangerMinC)), maxF: round1(cToF(s.dangerMaxC)), amount, unit }
}

function validate(form) {
  const minF = Number(form.minF)
  const maxF = Number(form.maxF)
  const amount = Number(form.amount)
  if (form.minF.trim() === '' || !Number.isFinite(minF)) return 'Enter a lower bound in °F.'
  if (form.maxF.trim() === '' || !Number.isFinite(maxF)) return 'Enter an upper bound in °F.'
  if (minF >= maxF) return 'The lower bound must be below the upper bound.'
  if (minF < -100 || maxF > 300) return 'Bounds must be between -100 °F and 300 °F.'
  if (form.amount.trim() === '' || !Number.isFinite(amount) || amount <= 0) {
    return 'Time until spoiled must be greater than zero.'
  }
  const ms = Math.round(amount * UNITS.find((u) => u.id === form.unit).ms)
  if (ms < 1000) return 'Time until spoiled must be at least 1 second.'
  return null
}

/** Admin controls for the food-safety danger zone and the spoil time. */
export function AdminPage({ applianceId, applianceIds = [], onHistoryReset, foodItems, exposures, inZoneNow = false }) {
  const settings = useSettings()
  const [form, setForm] = useState(() => toForm(settings))
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState(false)
  // null while loading, true once the database answered, false if it couldn't be reached.
  const [loaded, setLoaded] = useState(null)

  // Fetch the latest values from the database when the page opens.
  useEffect(() => {
    const controller = new AbortController()
    syncThresholds(controller.signal)
      .then(() => setLoaded(true))
      .catch((err) => err.name !== 'AbortError' && setLoaded(false))
    return () => controller.abort()
  }, [])

  // Show values that arrive from the database, unless the admin is mid-edit.
  const { dangerMinC, dangerMaxC, redExposureMs } = settings
  useEffect(() => {
    if (!touched) setForm(toForm({ dangerMinC, dangerMaxC, redExposureMs }))
  }, [dangerMinC, dangerMaxC, redExposureMs, touched])

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }))
    setTouched(true)
    setSaved(false)
    setError(null)
  }

  /** Save to the database first; only apply the values once it accepted them. */
  const save = async (thresholds) => {
    setSaving(true)
    setError(null)
    try {
      const stored = await saveThresholds(thresholds)
      updateSettings(stored)
      setForm(toForm(stored))
      setTouched(false)
      setLoaded(true)
      setSaved(true)
    } catch (err) {
      setError(`Couldn’t save to the database: ${err.message}. Nothing was changed.`)
    } finally {
      setSaving(false)
    }
  }

  const onSubmit = (e) => {
    e.preventDefault()
    const problem = validate(form)
    if (problem) {
      setError(problem)
      return
    }
    save({
      dangerMinC: fToC(Number(form.minF)),
      dangerMaxC: fToC(Number(form.maxF)),
      redExposureMs: Math.round(Number(form.amount) * UNITS.find((u) => u.id === form.unit).ms),
    })
  }

  const onReset = () =>
    save({
      dangerMinC: DEFAULT_SETTINGS.dangerMinC,
      dangerMaxC: DEFAULT_SETTINGS.dangerMaxC,
      redExposureMs: DEFAULT_SETTINGS.redExposureMs,
    })

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(settings))

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-head__title">Admin</h1>
          <p className="page-head__sub">Food-safety thresholds used for every warning, status and alert</p>
        </div>
      </div>

      <form className="card admin" onSubmit={onSubmit} noValidate>
        <div className="card__head">
          <h2 className="card__title">Danger zone</h2>
        </div>
        <p className="muted small">
          Food between these temperatures (inclusive) is in the danger zone, where bacteria grow quickly.
        </p>
        <div className="admin__row">
          <label className="field">
            <span>Lower bound (°F)</span>
            <input type="number" step="0.1" inputMode="decimal" value={form.minF} onChange={set('minF')} required />
          </label>
          <label className="field">
            <span>Upper bound (°F)</span>
            <input type="number" step="0.1" inputMode="decimal" value={form.maxF} onChange={set('maxF')} required />
          </label>
        </div>

        <div className="card__head">
          <h2 className="card__title">Time until spoiled</h2>
        </div>
        <p className="muted small">
          After this much total time in the danger zone, an item turns red and is flagged as spoiled. The
          fridge status also turns red after this long in the zone without a break.
        </p>
        <div className="admin__row">
          <label className="field">
            <span>Amount</span>
            <input type="number" step="any" min="0" inputMode="decimal" value={form.amount} onChange={set('amount')} required />
          </label>
          <label className="field">
            <span>Unit</span>
            <select value={form.unit} onChange={set('unit')}>
              {UNITS.map((u) => (
                <option key={u.id} value={u.id}>{u.label}</option>
              ))}
            </select>
          </label>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        {saved && !dirty && !error && (
          <p className="admin__saved" role="status">✓ Saved to the database. Every dashboard picks it up within a minute.</p>
        )}

        <div className="admin__actions">
          <button type="submit" className="btn btn--primary" disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onReset} disabled={saving}>Reset to defaults</button>
        </div>
      </form>

      <section className="card" aria-labelledby="admin-current">
        <h2 id="admin-current" className="card__title">Currently in use</h2>
        <dl className="stats stats--row">
          <div><dt>Lower bound</dt><dd>{round1(cToF(settings.dangerMinC))} °F</dd></div>
          <div><dt>Upper bound</dt><dd>{round1(cToF(settings.dangerMaxC))} °F</dd></div>
          <div><dt>Time until spoiled</dt><dd>{formatThreshold(settings.redExposureMs)}</dd></div>
        </dl>
        <p className="muted small">
          Defaults: {round1(cToF(DEFAULT_SETTINGS.dangerMinC))}–{round1(cToF(DEFAULT_SETTINGS.dangerMaxC))} °F,{' '}
          {formatThreshold(DEFAULT_SETTINGS.redExposureMs)}.{' '}
          {loaded === null && 'Loading from the database…'}
          {loaded === true && 'Stored in the database and shared by every dashboard.'}
          {loaded === false && 'Couldn’t reach the database, so these are the last values this browser saw.'}
        </p>
      </section>

      {foodItems && (
        <SimulateStatuses
          applianceId={applianceId}
          foodItems={foodItems}
          exposures={exposures}
          inZoneNow={inZoneNow}
        />
      )}

      <ResetHistory applianceId={applianceId} applianceIds={applianceIds} onReset={onHistoryReset} />
    </>
  )
}

const SIM_OPTIONS = [
  { id: null, label: 'Sensor' },
  { id: 'safe', label: 'Safe' },
  { id: 'warning', label: 'Danger' },
  { id: 'critical', label: 'Spoiled' },
]

/**
 * Force the safety status of individual items (for testing and demos), and put
 * them back on the sensor. A simulated status shows everywhere the real one
 * would (dashboard, item page, warnings, the fridge's OLED), marked "sim".
 * It never marks the item spoiled for real, so "Sensor" restores the real status.
 */
function SimulateStatuses({ applianceId, foodItems, exposures, inZoneNow }) {
  const { items, simulateStatus, clearSimulations } = foodItems
  const inFridge = items
    .filter((it) => it.appliance_id === applianceId && !it.removed_at)
    .sort((a, b) => Date.parse(b.placed_at) - Date.parse(a.placed_at))
  const simulatedCount = inFridge.filter((it) => it.simulated_status).length

  return (
    <section className="card admin" aria-labelledby="admin-simulate">
      <div className="card__head">
        <h2 id="admin-simulate" className="card__title">
          Simulate item safety {simulatedCount > 0 && <span className="count">{simulatedCount} simulated</span>}
        </h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => clearSimulations(applianceId)}
          disabled={simulatedCount === 0}
        >
          Reset all to sensor
        </button>
      </div>
      <p className="muted small">
        Override an item’s status in fridge #{applianceId} without changing the temperature. Simulated
        statuses are marked “sim” on the dashboard and are saved in this browser only. Choose “Sensor” to go
        back to the status worked out from the readings.
      </p>

      {inFridge.length === 0 ? (
        <p className="empty">No items in fridge #{applianceId}. Add some on the Home page.</p>
      ) : (
        <ul className="sim-list">
          {inFridge.map((item) => {
            const real = itemStatus(exposures?.get(item.id) ?? 0, inZoneNow, item.spoiled_at)
            const current = item.simulated_status ?? null
            return (
              <li key={item.id} className={`sim-list__row${current ? ' is-simulated' : ''}`}>
                <div className="sim-list__item">
                  <a href={`#/item/${encodeURIComponent(item.id)}`}>{item.name}</a>
                  <span className="muted small">
                    Sensor says <StatusBadge status={real} />
                  </span>
                </div>
                <div className="segmented segmented--sm" role="radiogroup" aria-label={`Status for ${item.name}`}>
                  {SIM_OPTIONS.map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      role="radio"
                      aria-checked={current === o.id}
                      className={`segmented__btn${current === o.id ? ' is-active' : ''}${o.id ? ` segmented__btn--${o.id}` : ''}`}
                      onClick={() => simulateStatus(item.id, o.id)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/**
 * Erase stored temperature readings, which empties the history table and chart.
 * Asks for confirmation first, since the readings can't be recovered.
 */
function ResetHistory({ applianceId, applianceIds, onReset }) {
  const [scope, setScope] = useState('current') // 'current' appliance or 'all'
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null) // { ok, text }

  const target = scope === 'all' ? null : applianceId
  const what = scope === 'all' ? 'every appliance' : `fridge #${applianceId}`

  const onConfirm = async () => {
    setBusy(true)
    try {
      const n = await deleteReadings(target)
      setResult({ ok: true, text: `Deleted ${n.toLocaleString()} reading${n === 1 ? '' : 's'} for ${what}.` })
      onReset?.()
    } catch (err) {
      setResult({ ok: false, text: `Couldn’t delete the readings: ${err.message}. Nothing was deleted.` })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <section className="card admin" aria-labelledby="admin-reset">
      <div className="card__head">
        <h2 id="admin-reset" className="card__title">Reset temperature history</h2>
      </div>
      <p className="muted small">
        Permanently deletes stored sensor readings from the database, which clears the temperature table and
        chart. Items’ danger-zone time is worked out from these readings, so it resets too. New readings
        keep arriving from the sensor.
      </p>

      <div className="segmented" role="radiogroup" aria-label="Readings to delete">
        {[
          { id: 'current', label: `Fridge #${applianceId}` },
          { id: 'all', label: `All appliances${applianceIds.length > 1 ? ` (${applianceIds.length})` : ''}` },
        ].map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={scope === o.id}
            className={`segmented__btn${scope === o.id ? ' is-active' : ''}`}
            onClick={() => {
              setScope(o.id)
              setConfirming(false)
              setResult(null)
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      {result && (
        <p className={result.ok ? 'admin__saved' : 'form-error'} role={result.ok ? 'status' : 'alert'}>
          {result.ok ? '✓ ' : ''}{result.text}
        </p>
      )}

      {confirming ? (
        <div className="danger-area" role="alertdialog" aria-labelledby="admin-reset-confirm">
          <p id="admin-reset-confirm">
            <strong>Delete all temperature readings for {what}?</strong> This can’t be undone.
          </p>
          <div className="admin__actions">
            <button type="button" className="btn btn--danger-solid" onClick={onConfirm} disabled={busy}>
              {busy ? 'Deleting…' : 'Yes, delete readings'}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="admin__actions">
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              setConfirming(true)
              setResult(null)
            }}
          >
            Reset history…
          </button>
        </div>
      )}
    </section>
  )
}
