import { formatTime } from '../lib/format.js'

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
          <svg className="nav__logo" viewBox="0 0 24 32" aria-hidden="true">
            <defs>
              <linearGradient id="logo-meat" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#f58a7a" />
                <stop offset="1" stopColor="#c8161d" />
              </linearGradient>
              {/* Soft faded edge instead of a hard outline */}
              <filter id="logo-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feDropShadow dx="0" dy="0" stdDeviation="0.9" floodColor="#000" floodOpacity="0.28" />
              </filter>
            </defs>
            <g filter="url(#logo-glow)">
              {/* Bone (thermometer stem) with knuckle at the top */}
              <g fill="#f8f3ea">
                <circle cx="9.6" cy="4" r="2.6" />
                <circle cx="14.4" cy="4" r="2.6" />
                <rect x="9.5" y="4" width="5" height="14" rx="2.5" />
              </g>
              {/* Drumstick meat (thermometer bulb) */}
              <path
                d="M12 14.5C8 15.5 4 19.5 4 24c0 4.4 3.6 7 8 7s8-2.6 8-7c0-4.5-4-8.5-8-9.5Z"
                fill="url(#logo-meat)"
              />
            </g>
            <path d="M7.2 21.5c.8-1.8 2.2-3.2 3.8-4" fill="none" stroke="#fff" strokeOpacity="0.45" strokeWidth="1.2" strokeLinecap="round" />
            {/* Mercury column rising out of the meat */}
            <rect x="11.1" y="8" width="1.8" height="9" rx="0.9" fill="#e0453a" />
            {/* Scale ticks */}
            <g stroke="#9a9a9a" strokeOpacity="0.7" strokeWidth="0.9" strokeLinecap="round">
              <line x1="13.6" y1="9" x2="14.5" y2="9" />
              <line x1="13.6" y1="11.5" x2="14.5" y2="11.5" />
              <line x1="13.6" y1="14" x2="14.5" y2="14" />
            </g>
          </svg>
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
