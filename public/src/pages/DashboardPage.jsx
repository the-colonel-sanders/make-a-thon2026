import { useMemo, useState } from 'react'
import { TemperatureCard } from '../components/TemperatureCard.jsx'
import { TemperatureChart } from '../components/TemperatureChart.jsx'
import { WarningsBanner } from '../components/WarningsBanner.jsx'
import { AddItemForm } from '../components/AddItemForm.jsx'
import { ItemTable } from '../components/ItemTable.jsx'
import { buildIntervals, dangerExposureMs, itemStatus } from '../lib/safety.js'

const SEVERITY = { critical: 0, warning: 1, safe: 2 }

/** Live view: current temperature, recent history, and the items in the fridge. */
export function DashboardPage({ applianceId, backend, inZoneNow, now, foodItems, profile }) {
  const { items, addItem, removeItem, restoreItem, deleteItem } = foodItems
  const [ownerFilter, setOwnerFilter] = useState('all') // 'all' or a profile name

  const intervals = useMemo(() => buildIntervals(backend.readings, now), [backend.readings, now])
  const oldestReading = backend.readings[0]?.time

  const rows = useMemo(() => {
    return items
      .filter((it) => it.appliance_id === applianceId)
      .map((item) => {
        const exposureMs = dangerExposureMs(item, intervals, now)
        return {
          item,
          exposureMs,
          status: itemStatus(exposureMs, !item.removed_at && inZoneNow),
          // True if the item predates the oldest reading we fetched.
          partial: oldestReading != null && Date.parse(item.placed_at) < oldestReading,
        }
      })
      .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || b.exposureMs - a.exposureMs)
  }, [items, applianceId, intervals, now, inZoneNow, oldestReading])

  // Warnings always cover every item; the filter only narrows the tables.
  const current = rows.filter((r) => !r.item.removed_at)
  const owners = [...new Set(rows.map((r) => r.item.added_by_name).filter(Boolean))].sort()
  const filter = owners.includes(ownerFilter) ? ownerFilter : 'all'
  const visible = filter === 'all' ? rows : rows.filter((r) => r.item.added_by_name === filter)
  const shownCurrent = visible.filter((r) => !r.item.removed_at)
  const shownRemoved = visible.filter((r) => r.item.removed_at)

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-head__title">Home</h1>
          <p className="page-head__sub">Everything in your fridge, all on one dashboard.</p>
        </div>
        <button type="button" className="btn btn--ghost" onClick={backend.refresh}>Refresh</button>
      </div>

      <WarningsBanner rows={current} inZoneNow={inZoneNow && current.length > 0} />

      <div className={`grid ${backend.loading ? 'is-loading' : ''}`}>
        <TemperatureCard readings={backend.readings} now={now} />
        <TemperatureChart readings={backend.readings} />

        <section className="card card--wide" aria-labelledby="items-heading">
          <div className="card__head">
            <h2 id="items-heading" className="card__title">
              In the fridge <span className="count">{shownCurrent.length}</span>
            </h2>
            {owners.length > 0 && (
              <label className="field field--inline">
                <span>Show</span>
                <select value={filter} onChange={(e) => setOwnerFilter(e.target.value)}>
                  <option value="all">Everyone’s items</option>
                  {owners.map((n) => (
                    <option key={n} value={n}>{n}’s items</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <AddItemForm profile={profile} onAdd={(v) => addItem({ ...v, applianceId, profile })} />
          <ItemTable rows={shownCurrent} now={now} onRemove={(id) => removeItem(id, profile)} />
        </section>

        {shownRemoved.length > 0 && (
          <details className="card card--wide">
            <summary className="card__title">Removed items <span className="count">{shownRemoved.length}</span></summary>
            <ItemTable rows={shownRemoved} now={now} removed onRestore={restoreItem} onDelete={deleteItem} />
          </details>
        )}
      </div>
    </>
  )
}
