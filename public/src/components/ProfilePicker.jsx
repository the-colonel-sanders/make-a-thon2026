import { useState } from 'react'

const NEW = '__new__'

/** Choose who's using the dashboard, add a new name, or remove the current one. */
export function ProfilePicker({ profiles, active, onSelect, onAdd, onRemove }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')

  const startAdding = () => {
    setAdding(true)
    setName('')
  }

  const submit = (e) => {
    e.preventDefault()
    if (onAdd(name)) setAdding(false)
  }

  if (adding || profiles.length === 0) {
    return (
      <form className="profile-picker" onSubmit={submit}>
        <label className="field field--inline">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alex"
            maxLength={40}
            autoFocus={adding}
            aria-label="New profile name"
          />
        </label>
        <button type="submit" className="btn btn--primary btn--sm" disabled={!name.trim()}>Save</button>
        {profiles.length > 0 && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAdding(false)}>Cancel</button>
        )}
      </form>
    )
  }

  return (
    <div className="profile-picker">
      <label className="field field--inline">
        <span>Employee</span>
        <select
          value={active?.id ?? ''}
          onChange={(e) => (e.target.value === NEW ? startAdding() : onSelect(e.target.value))}
        >
          {!active && <option value="" disabled>Choose…</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
          <option value={NEW}>+ Add employee…</option>
        </select>
      </label>
      {active && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            if (window.confirm(`Remove "${active.name}"? Items they added keep their name.`)) onRemove(active.id)
          }}
        >
          Remove
        </button>
      )}
    </div>
  )
}
