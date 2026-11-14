import { useEffect, useRef, useState } from 'react'
import { TOAST_DURATION_MS } from '../config.js'

// Popup alerts stacked on the side of the screen (bottom of the screen on phones).
const ICONS = { critical: '✕', warning: '!', safe: '✓', offline: '⏻' }
const FADE_MS = 400 // keep in sync with .toast transition in styles.css

export function Toasts({ toasts, onDismiss }) {
  return (
    <div className="toasts" aria-live="assertive" aria-relevant="additions">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

/**
 * One popup. It fades out after the popup duration from Settings; hovering or focusing it
 * pauses the countdown so there's time to read it.
 */
function Toast({ toast, onDismiss }) {
  const [leaving, setLeaving] = useState(false)
  const [paused, setPaused] = useState(false)
  // Read once per popup, so changing the setting doesn't disturb open popups.
  const duration = TOAST_DURATION_MS
  const remaining = useRef(duration)

  useEffect(() => {
    if (paused || leaving) return
    const started = Date.now()
    const id = setTimeout(() => setLeaving(true), remaining.current)
    return () => {
      clearTimeout(id)
      remaining.current = Math.max(1000, remaining.current - (Date.now() - started))
    }
  }, [paused, leaving])

  useEffect(() => {
    if (!leaving) return
    const id = setTimeout(() => onDismiss(toast.id), FADE_MS)
    return () => clearTimeout(id)
  }, [leaving, onDismiss, toast.id])

  return (
    <div
      className={`toast toast--${toast.level} ${leaving ? 'is-leaving' : ''}`}
      role={toast.level === 'critical' || toast.level === 'warning' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast__icon" aria-hidden="true">{ICONS[toast.level]}</span>
      <div className="toast__body">
        <strong>{toast.title}</strong>
        <p>{toast.message}</p>
        {toast.detail && <p className="toast__detail">{toast.detail}</p>}
      </div>
      <button type="button" className="toast__close" onClick={() => setLeaving(true)} aria-label="Dismiss alert">
        ×
      </button>
      {!paused && !leaving && (
        <span
          className="toast__timer"
          style={{
            animationDuration: `${remaining.current}ms`,
            '--from': remaining.current / duration,
          }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
