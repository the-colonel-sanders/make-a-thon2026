// Status shown as color + icon + text, so meaning never relies on color alone.
const LABELS = {
  safe: { icon: '✓', text: 'Safe' },
  warning: { icon: '!', text: 'Danger' },   // yellow
  critical: { icon: '✕', text: 'Spoiled' }, // red
  unknown: { icon: '?', text: 'No data' },
  offline: { icon: '⏻', text: 'Device off' },
}

export function StatusBadge({ status, label }) {
  const { icon, text } = LABELS[status] ?? LABELS.unknown
  return (
    <span className={`badge badge--${status}`}>
      <span className="badge__icon" aria-hidden="true">{icon}</span>
      {label ?? text}
    </span>
  )
}
