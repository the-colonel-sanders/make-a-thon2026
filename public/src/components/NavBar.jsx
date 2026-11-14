import { formatTime } from '../lib/format.js'
import logoUrl from '../assets/logo.png'

// Outline-only icons (no fill); they take the link's text color.
const ICONS = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9v11h14V9" />
      <path d="M10 20v-6h4v6" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  locate: (
    <>
      <path d="M12 21s6.5-5.8 6.5-11.2a6.5 6.5 0 1 0-13 0C5.5 15.2 12 21 12 21Z" />
      <circle cx="12" cy="9.8" r="2.4" />
    </>
  ),
  admin: (
    <>
      <path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
}

const LINKS = [
  { href: '#/', route: '/', label: 'Home', icon: 'home' },
  { href: '#/history', route: '/history', label: 'History', icon: 'history' },
  { href: '#/locate', route: '/locate', label: 'Locate', icon: 'locate' },
  { href: '#/admin', route: '/admin', label: 'Admin', icon: 'admin' },
  { href: '#/settings', route: '/settings', label: 'Settings', icon: 'settings' },
]

/** Top bar shared by every page: brand, page links, profile, appliance and API status. */
const DEVICE_LABEL = { on: 'Sensor on', off: 'Device off', unknown: 'No sensor data' }

export function NavBar({ route, online, error, lastFetched, device, applianceId, applianceIds, onApplianceChange, profileSlot }) {
  const ids = applianceIds.includes(applianceId)
    ? applianceIds
    : [...applianceIds, applianceId].sort((a, b) => a - b)
  const state = online == null ? 'checking' : online ? 'online' : 'offline'

  return (
    <nav className="nav" aria-label="Main">
      <div className="nav__inner">
        <a className="nav__brand" href="#/">
          <img className="nav__logo" src={logoUrl} alt="" />
          Food Saver
        </a>
        <ul className="nav__links">
          {LINKS.map((l) => (
            <li key={l.route}>
              <a href={l.href} className="nav__link" aria-current={route === l.route ? 'page' : undefined}>
                <svg className="nav__icon" viewBox="0 0 24 24" aria-hidden="true">
                  {ICONS[l.icon]}
                </svg>
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="nav__controls">
          {profileSlot}
          <label className="field field--inline">
            <span>Appliance</span>
            <select value={applianceId} onChange={(e) => onApplianceChange(Number(e.target.value))}>
              {ids.map((id) => (
                <option key={id} value={id}>#{id}</option>
              ))}
            </select>
          </label>
          <span className={`conn conn--device-${device}`} title="ESP32 temperature sensor">
            <span className="conn__dot" aria-hidden="true" />
            {DEVICE_LABEL[device]}
          </span>
          <span className={`conn conn--${state}`} title={error ?? undefined}>
            <span className="conn__dot" aria-hidden="true" />
            {state === 'checking' && 'Connecting…'}
            {state === 'online' && `API online${lastFetched ? ` · ${formatTime(lastFetched)}` : ''}`}
            {state === 'offline' && 'API unreachable'}
          </span>
        </div>
      </div>
    </nav>
  )
}
