import { useState } from 'react'
import { StatusBadge } from './StatusBadge.jsx'
import { RenameItemForm } from './RenameItemForm.jsx'
import { formatDateTime, formatDuration } from '../lib/format.js'
import { getSettings } from '../lib/settings.js'
import { guidelineSummary } from '../lib/foodSearch.js'

const itemHref = (id) => `#/item/${encodeURIComponent(id)}`

/**
 * One row per food item: when it went in, how long it's been in the fridge,
 * how much of that time was spent in the danger zone, and its status.
 */
export function ItemTable({ rows, now, removed = false, onRemove, onRestore, onDelete, onRename }) {
  const [renamingId, setRenamingId] = useState(null)

  if (!rows.length) {
    return (
      <p className="empty">
        {removed ? 'No removed items.' : 'Nothing logged yet. Add an item above to start tracking it.'}
      </p>
    )
  }

  return (
    <div className="table-wrap">
      <table className="table items">
        <thead>
          <tr>
            <th>Item</th>
            <th>Added by</th>
            <th>Placed</th>
            <th className="num">{removed ? 'Time stored' : 'Time in fridge'}</th>
            <th className="num">Danger-zone time</th>
            <th>Status</th>
            <th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, exposureMs, status, partial }) => {
            const end = item.removed_at ? Date.parse(item.removed_at) : now
            const pct = Math.min(100, (exposureMs / getSettings().redExposureMs) * 100)
            return (
              <tr key={item.id} className={`row--${status}`}>
                <td data-label="Item" className="items__name">
                  {renamingId === item.id ? (
                    <RenameItemForm
                      name={item.name}
                      onSave={(name) => onRename(item.id, name)}
                      onCancel={() => setRenamingId(null)}
                    />
                  ) : (
                    <a href={itemHref(item.id)} title={`Inspect ${item.name}`}>{item.name}</a>
                  )}
                  {item.guideline && (
                    <span className="items__guideline" title="USDA FSIS guideline">
                      {guidelineSummary(item.guideline)}
                    </span>
                  )}
                </td>
                <td data-label="Added by">
                  {item.added_by_name ?? <span className="muted">–</span>}
                  {removed && item.removed_by_name && (
                    <span className="muted small"> · removed by {item.removed_by_name}</span>
                  )}
                </td>
                <td data-label="Placed">{formatDateTime(item.placed_at)}</td>
                <td data-label="Time in fridge" className="num">{formatDuration(end - Date.parse(item.placed_at))}</td>
                <td data-label="Danger-zone time" className="num">
                  <span title={partial ? 'Older readings are outside the fetched window, so this may be higher.' : undefined}>
                    {partial && '≥ '}{formatDuration(exposureMs)}
                  </span>
                  <span className={`meter meter--${status}`} aria-hidden="true">
                    <span style={{ width: `${pct}%` }} />
                  </span>
                </td>
                <td data-label="Status"><StatusBadge status={status} simulated={Boolean(item.simulated_status)} /></td>
                <td className="items__actions">
                  <a className="btn btn--ghost btn--sm" href={itemHref(item.id)}>Inspect</a>
                  {onRename && renamingId !== item.id && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setRenamingId(item.id)}>Rename</button>
                  )}
                  {removed ? (
                    <>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRestore(item.id)}>Restore</button>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDelete(item.id)}>Delete</button>
                    </>
                  ) : (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRemove(item.id)}>Remove</button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
