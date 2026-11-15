// Status shown as color + icon + text, so meaning never relies on color alone.
const LABELS = {
  safe: { icon: '✓', text: 'Safe' },
  warning: { icon: '!', text: 'Danger' },   // yellow
  critical: { icon: '✕', text: 'Spoiled' }, // red
  unknown: { icon: '?', text: 'No data' },
  offline: { icon: '⏻', text: 'Device off' },
}

/** `simulated` marks a status forced on the Admin page, so it's never mistaken for a real reading. */
export function StatusBadge({ status, label, simulated = false }) {
  const { icon, text } = LABELS[status] ?? LABELS.unknown
  return (
    <span
      className={`badge badge--${status}${simulated ? ' badge--simulated' : ''}`}
      title={simulated ? 'Simulated on the Admin page, not from the sensor' : undefined}
    >
      <span className="badge__icon" aria-hidden="true">{icon}</span>
      {label ?? text}
      {simulated && <span className="badge__sim">sim</span>}
    </span>
  )
}
