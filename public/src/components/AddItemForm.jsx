import { useState } from 'react'

/**
 * Log a new food item under the active profile. It's timestamped to the exact
 * second it's added.
 */
export function AddItemForm({ onAdd, profile }) {
  const [name, setName] = useState('')
  const [error, setError] = useState(null)

  const submit = (e) => {
    e.preventDefault()
    if (!profile) return setError('Choose or add your profile at the top of the page first.')
    const trimmed = name.trim()
    if (!trimmed) return setError('Enter an item name.')
    onAdd({ name: trimmed, placedAt: Date.now() })
    setName('')
    setError(null)
  }

  return (
    <form className="add-form" onSubmit={submit} noValidate>
      <label className="field">
        <span>
          Item {profile ? <em className="muted">· adding as <strong>{profile.name}</strong></em> : null}
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Chicken breast"
          maxLength={80}
        />
      </label>
      <button type="submit" className="btn btn--primary">Add item</button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  )
}
