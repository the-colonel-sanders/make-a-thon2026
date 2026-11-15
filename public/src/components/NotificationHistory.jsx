import { useEffect, useRef, useState } from 'react'
import { NotificationItem } from './NotificationList.jsx'

const PREVIEW = 3

/**
 * History page section: a preview of the 3 newest notifications, and a
 * scrollable dialog with all of them. Clicking a preview row opens the dialog
 * with that notification expanded.
 */
export function NotificationHistory({ notifications, now, onDismiss, onClear }) {
  const dialogRef = useRef(null)
  const listRef = useRef(null)
  const [isOpen, setIsOpen] = useState(false)
  const [expanded, setExpanded] = useState(null)

  const openAll = (focusId = null) => {
    setExpanded(focusId)
    setIsOpen(true)
  }
  const close = () => dialogRef.current?.close()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (isOpen && !dialog.open) {
      dialog.showModal()
      if (listRef.current) listRef.current.scrollTop = 0
      if (expanded) {
        listRef.current
          ?.querySelector(`[data-notif-id="${CSS.escape(expanded)}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Close the dialog once the last notification is gone.
  useEffect(() => {
    if (!notifications.length) close()
  }, [notifications.length])

  const preview = notifications.slice(0, PREVIEW)

  return (
    <section className="card" aria-labelledby="notif-history-heading">
      <div className="card__head">
        <div>
          <h2 id="notif-history-heading" className="card__title">Notifications</h2>
          <p className="muted small">
            {notifications.length
              ? `${notifications.length} saved · newest first`
              : 'Danger-zone and device alerts will show up here.'}
          </p>
        </div>
        {notifications.length > 0 && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => openAll()}>
            View all ({notifications.length})
          </button>
        )}
      </div>

      {notifications.length === 0 ? (
        <p className="empty">No notifications yet.</p>
      ) : (
        <ol className="notifs__list">
          {preview.map((n) => (
            <NotificationItem
              key={n.id}
              n={n}
              now={now}
              onActivate={() => openAll(n.id)}
              activateTitle="Open in the full list"
            />
          ))}
        </ol>
      )}

      <dialog
        ref={dialogRef}
        className="notif-dialog"
        aria-labelledby="notif-dialog-heading"
        onClose={() => setIsOpen(false)}
        onClick={(e) => e.target === dialogRef.current && close()} // click on the backdrop
      >
        <div className="notif-dialog__head">
          <h2 id="notif-dialog-heading" className="card__title">
            All notifications <span className="muted small">({notifications.length})</span>
          </h2>
          <div className="notif-dialog__actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClear} disabled={!notifications.length}>
              Clear all
            </button>
            <button type="button" className="notif__close" onClick={close} aria-label="Close">×</button>
          </div>
        </div>
        <ol ref={listRef} className="notifs__list notif-dialog__list">
          {isOpen &&
            notifications.map((n) => {
              const open = expanded === n.id
              return (
                <NotificationItem
                  key={n.id}
                  n={n}
                  now={now}
                  open={open}
                  onActivate={() => setExpanded(open ? null : n.id)}
                  onDismiss={onDismiss}
                />
              )
            })}
        </ol>
      </dialog>
    </section>
  )
}
