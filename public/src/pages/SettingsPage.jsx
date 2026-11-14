import { useEffect, useRef, useState } from 'react'
import { resetSettings, updateSettings, useSettings } from '../lib/settings.js'
import { eraseAllData, exportBackup, importBackup } from '../lib/backup.js'
import { dangerRangeLabel, formatThreshold } from '../lib/format.js'

const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'safety', label: 'Units & sensor' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'employees', label: 'Employees' },
  { id: 'data', label: 'Data & storage' },
]

const ROLES = ['Staff', 'Manager', 'Kitchen lead', 'Cleaner']

/** Segmented single-choice control. */
function Choice({ label, value, options, onChange }) {
  return (
    <div className="setting">
      <span className="setting__label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={`segmented__btn ${value === o.value ? 'is-active' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Toggle({ label, hint, checked, onChange }) {
  return (
    <label className="setting setting--toggle">
      <span>
        <span className="setting__label">{label}</span>
        {hint && <span className="setting__hint">{hint}</span>}
      </span>
      <input type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

/** Brief "Saved" confirmation shown next to a section title. */
function useSavedFlash() {
  const [shown, setShown] = useState(false)
  const timer = useRef()
  useEffect(() => () => clearTimeout(timer.current), [])
  const flash = () => {
    setShown(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setShown(false), 1500)
  }
  return [shown, flash]
}

function SectionCard({ id, title, description, saved, children }) {
  return (
    <section className="card settings-card" id={`settings-${id}`} aria-labelledby={`settings-${id}-title`}>
      <div className="card__head">
        <div>
          <h2 id={`settings-${id}-title`} className="card__title">{title}</h2>
          {description && <p className="muted small">{description}</p>}
        </div>
        {saved && <span className="saved-flash" role="status">✓ Saved</span>}
      </div>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------

function AppearanceSection() {
  const s = useSettings()
  const [saved, flash] = useSavedFlash()
  const set = (patch) => {
    updateSettings(patch)
    flash()
  }
  return (
    <SectionCard id="appearance" title="Appearance" description="How the app looks on this device." saved={saved}>
      <Choice
        label="Theme"
        value={s.theme}
        onChange={(theme) => set({ theme })}
        options={[
          { value: 'system', label: 'Match device' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />
      <Choice
        label="Density"
        value={s.density}
        onChange={(density) => set({ density })}
        options={[
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'compact', label: 'Compact' },
        ]}
      />
    </SectionCard>
  )
}

function SafetySection() {
  const s = useSettings()
  const [saved, flash] = useSavedFlash()
  const [stale, setStale] = useState(String(s.staleAfterMs / 1000))
  const [error, setError] = useState(null)
  useEffect(() => setStale(String(s.staleAfterMs / 1000)), [s.staleAfterMs])

  const saveStale = (e) => {
    e.preventDefault()
    const sec = Number(stale)
    if (!Number.isFinite(sec) || sec < 45 || sec > 3600) {
      return setError('Enter 45–3600 seconds (the sensor reports every 30 s, so less than 45 would flicker).')
    }
    setError(null)
    updateSettings({ staleAfterMs: Math.round(sec * 1000) })
    flash()
  }

  return (
    <SectionCard
      id="safety"
      title="Units & sensor"
      description="How temperatures are shown and when the sensor counts as offline."
      saved={saved}
    >
      <Choice
        label="Temperature unit"
        value={s.unit}
        onChange={(unit) => {
          updateSettings({ unit })
          flash()
        }}
        options={[
          { value: 'F', label: 'Fahrenheit (°F)' },
          { value: 'C', label: 'Celsius (°C)' },
        ]}
      />

      <form className="field setting" onSubmit={saveStale} noValidate>
        <label className="setting__label" htmlFor="stale-seconds">Show “Device off” after</label>
        <span className="input-suffix">
          <input id="stale-seconds" type="number" min="45" step="15" inputMode="numeric" value={stale} onChange={(e) => setStale(e.target.value)} />
          <span>seconds without a reading</span>
          <button type="submit" className="btn btn--ghost btn--sm" disabled={stale === String(s.staleAfterMs / 1000)}>Save</button>
        </span>
        {error && <span className="form-error" role="alert">{error}</span>}
      </form>

      <div className="setting setting--row">
        <span>
          <span className="setting__label">Food-safety limits</span>
          <span className="setting__hint">
            Danger zone {dangerRangeLabel()}, red after {formatThreshold(s.redExposureMs)} in the zone.
          </span>
        </span>
        <a className="btn btn--ghost btn--sm" href="#/admin">Change on Admin page →</a>
      </div>
    </SectionCard>
  )
}

function NotificationsSection({ onClearNotifications, notificationCount }) {
  const s = useSettings()
  const [saved, flash] = useSavedFlash()
  const set = (patch) => {
    updateSettings(patch)
    flash()
  }
  return (
    <SectionCard id="notifications" title="Notifications" saved={saved}>
      <Toggle
        label="Show popups"
        hint="Popups slide in on the side when the fridge becomes unsafe. They’re always saved to the notification list."
        checked={s.popups}
        onChange={(popups) => set({ popups })}
      />
      <Toggle
        label="Alert when the sensor goes offline"
        hint="A gray popup when the ESP32 stops sending readings."
        checked={s.notifyDeviceOffline}
        onChange={(notifyDeviceOffline) => set({ notifyDeviceOffline })}
      />
      <div className="setting setting--row">
        <span className="setting__label">Notification history ({notificationCount})</span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClearNotifications} disabled={!notificationCount}>
          Clear history
        </button>
      </div>
    </SectionCard>
  )
}

function EmployeeRow({ profile, isActive, itemCount, onSetActive, onUpdate, onRemove }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(profile.name)
  const [error, setError] = useState(null)

  const saveName = (e) => {
    e.preventDefault()
    if (onUpdate(profile.id, { name })) {
      setEditing(false)
      setError(null)
    } else {
      setError('Name can’t be empty or the same as another employee.')
    }
  }

  return (
    <tr className={isActive ? 'is-active-row' : undefined}>
      <td data-label="Name">
        {editing ? (
          <form className="inline-edit" onSubmit={saveName}>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus aria-label="Employee name" />
            <button type="submit" className="btn btn--primary btn--sm">Save</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditing(false); setName(profile.name); setError(null) }}>
              Cancel
            </button>
            {error && <span className="form-error">{error}</span>}
          </form>
        ) : (
          <>
            <strong>{profile.name}</strong>
            {isActive && <span className="pill">Using this device</span>}
          </>
        )}
      </td>
      <td data-label="Role">
        <select value={profile.role ?? ''} onChange={(e) => onUpdate(profile.id, { role: e.target.value })} aria-label={`Role for ${profile.name}`}>
          <option value="">—</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </td>
      <td data-label="Employees" className="num">{itemCount}</td>
      <td className="items__actions">
        {!isActive && <button type="button" className="btn btn--ghost btn--sm" onClick={() => onSetActive(profile.id)}>Use</button>}
        {!editing && <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(true)}>Rename</button>}
        <button
          type="button"
          className="btn btn--ghost btn--sm btn--danger"
          onClick={() => {
            if (window.confirm(`Remove ${profile.name} from the employee list? Items they added keep their name.`)) onRemove(profile.id)
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  )
}

function EmployeesSection({ profiles, items, onRenameItems }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState('Staff')
  const [error, setError] = useState(null)

  const counts = new Map()
  for (const it of items) if (it.added_by_id) counts.set(it.added_by_id, (counts.get(it.added_by_id) ?? 0) + 1)

  const add = (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return setError('Enter a name.')
    if (profiles.profiles.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      return setError(`${trimmed} is already on the list.`)
    }
    profiles.addProfile(trimmed, role)
    setName('')
    setError(null)
  }

  const update = (id, patch) => {
    const ok = profiles.updateProfile(id, patch)
    if (ok && patch.name != null) onRenameItems(id, patch.name.trim())
    return ok
  }

  return (
    <SectionCard
      id="employees"
      title="Employees"
      description="People who log items. The one marked “Using this device” is recorded on new items; switch with the Employee menu at the top."
    >
      <form className="add-employee" onSubmit={add} noValidate>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jordan" maxLength={40} />
        </label>
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <button type="submit" className="btn btn--primary">Add employee</button>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>

      {profiles.profiles.length ? (
        <div className="table-wrap">
          <table className="table items employees">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th className="num">Employees</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {profiles.profiles.map((p) => (
                <EmployeeRow
                  key={p.id}
                  profile={p}
                  isActive={profiles.active?.id === p.id}
                  itemCount={counts.get(p.id) ?? 0}
                  onSetActive={profiles.setActiveId}
                  onUpdate={update}
                  onRemove={profiles.removeProfile}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">No employees yet. Add the first one above.</p>
      )}
    </SectionCard>
  )
}

function DataSection({ items, applianceIds, onClearRemoved }) {
  const s = useSettings()
  const [message, setMessage] = useState(null)
  const fileRef = useRef(null)
  const removedCount = items.filter((it) => it.removed_at).length
  const ids = [...new Set([...applianceIds, s.defaultApplianceId])].sort((a, b) => a - b)

  const onImport = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!window.confirm('Restoring replaces all items, employees, notifications and settings in this browser. Continue?')) return
    try {
      const r = await importBackup(file)
      setMessage({ ok: true, text: `Restored ${r.items} items and ${r.profiles} employees. Reloading…` })
      setTimeout(() => window.location.reload(), 900)
    } catch (err) {
      setMessage({ ok: false, text: err.message })
    }
  }

  return (
    <SectionCard
      id="data"
      title="Data & storage"
      description="Items, employees, notifications and settings are saved in this browser only. Temperature readings live in the database."
    >
      <label className="setting">
        <span className="setting__label">Fridge shown when the dashboard opens</span>
        <select value={s.defaultApplianceId} onChange={(e) => updateSettings({ defaultApplianceId: Number(e.target.value) })}>
          {ids.map((id) => <option key={id} value={id}>#{id}</option>)}
        </select>
      </label>

      <div className="setting setting--row">
        <span>
          <span className="setting__label">Backup</span>
          <span className="setting__hint">Save everything to a file, or restore it on this or another computer.</span>
        </span>
        <span className="btn-row">
          <button type="button" className="btn btn--ghost btn--sm" onClick={exportBackup}>⭳ Download backup</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => fileRef.current?.click()}>Restore from file…</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={onImport} />
        </span>
      </div>
      {message && <p className={message.ok ? 'form-ok' : 'form-error'} role="status">{message.text}</p>}

      <div className="setting setting--row">
        <span>
          <span className="setting__label">Removed items ({removedCount})</span>
          <span className="setting__hint">Permanently delete items that have been taken out of the fridge.</span>
        </span>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={!removedCount}
          onClick={() => window.confirm(`Permanently delete ${removedCount} removed item(s)?`) && onClearRemoved()}
        >
          Delete removed items
        </button>
      </div>

      <div className="danger-area">
        <div className="setting setting--row">
          <span>
            <span className="setting__label">Reset settings</span>
            <span className="setting__hint">Restore appearance, units, safety limits and notifications to their defaults. Data is kept.</span>
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => window.confirm('Reset all settings to their defaults?') && resetSettings()}>
            Reset settings
          </button>
        </div>
        <div className="setting setting--row">
          <span>
            <span className="setting__label">Erase all local data</span>
            <span className="setting__hint">Deletes every item, employee, notification and setting in this browser. Download a backup first.</span>
          </span>
          <button
            type="button"
            className="btn btn--sm btn--danger-solid"
            onClick={() => {
              if (window.confirm('Erase ALL items, employees, notifications and settings from this browser? This can’t be undone.')) {
                eraseAllData()
                window.location.reload()
              }
            }}
          >
            Erase everything
          </button>
        </div>
      </div>
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------

/** Settings: appearance, units & sensor, notifications, employees, data. (Safety limits live on the Admin page.) */
export function SettingsPage({ profiles, foodItems, applianceIds, notificationCount, onClearNotifications }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-head__title">Settings</h1>
          <p className="page-head__sub">Changes save automatically and apply right away.</p>
        </div>
      </div>

      <div className="settings-layout">
        <nav className="settings-toc" aria-label="Settings sections">
          {SECTIONS.map((sec) => (
            <a
              key={sec.id}
              href={`#/settings`}
              onClick={(e) => {
                e.preventDefault()
                document.getElementById(`settings-${sec.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
            >
              {sec.label}
            </a>
          ))}
        </nav>
        <div className="settings-sections">
          <AppearanceSection />
          <SafetySection />
          <NotificationsSection notificationCount={notificationCount} onClearNotifications={onClearNotifications} />
          <EmployeesSection profiles={profiles} items={foodItems.items} onRenameItems={foodItems.renameAddedBy} />
          <DataSection items={foodItems.items} applianceIds={applianceIds} onClearRemoved={foodItems.clearRemoved} />
        </div>
      </div>
    </>
  )
}
