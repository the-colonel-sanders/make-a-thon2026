import { useState } from 'react'
import { formatDuration, formatTime } from '../lib/format.js'

const ICONS = { critical: '✕', warning: '!', safe: '✓', offline: '⏻' }
const SHOWN = 3

function ago(ms) {
  if (ms < 60_000) return 'just now'
  return `${formatDuration(ms).split(' ').slice(0, 2).join(' ')} ago`
}

/**
 * One notification row. `onActivate` runs when the body is clicked (expand
 * in place, or open the full list from a preview); `open` shows the detail.
 */
export function NotificationItem({ n, now, open = false, onActivate, onDismiss, activateTitle }) {
  return (
    <li className={`notif notif--${n.level}`} data-notif-id={n.id}>
      <span className="notif__icon" aria-hidden="true">{ICONS[n.level] ?? '•'}</span>
      <button
        type="button"
        className="notif__body"
        aria-expanded={open}
        onClick={onActivate}
        title={activateTitle ?? (open ? 'Show less' : 'Show details')}
      >
        <span className="notif__title">{n.title}</span>
        <span className={`notif__msg ${open ? 'is-open' : ''}`}>
          {n.message}
          {open && n.detail && <strong> {n.detail}</strong>}
        </span>
      </button>
      <time className="notif__time" dateTime={new Date(n.time).toISOString()} title={formatTime(n.time)}>
        {ago(now - n.time)}
      </time>
      {onDismiss && (
        <button type="button" className="notif__close" onClick={() => onDismiss(n.id)} aria-label="Dismiss notification">
          ×
        </button>
      )}
    </li>
  )
}

/**
 * The most recent notifications (same ones as the popups), stacked at the top
 * of every page so they're still visible after the popups fade.
 */
export function NotificationList({ notifications, now, onDismiss, onClear }) {
  const [expanded, setExpanded] = useState(null)
  if (!notifications.length) return null
  const shown = notifications.slice(0, SHOWN)

  return (
    <section className="notifs" aria-labelledby="notifs-heading">
      <div className="notifs__head">
        <h2 id="notifs-heading" className="notifs__title">
          Recent notifications
          {notifications.length > SHOWN && <span className="muted small"> · latest {SHOWN} of {notifications.length}</span>}
        </h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClear}>Clear all</button>
      </div>
      <ol className="notifs__list">
        {shown.map((n) => {
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
    </section>
  )
}
