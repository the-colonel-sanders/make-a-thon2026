import { useEffect, useRef, useState } from 'react'

/**
 * Inline rename for a food item. Enter saves, Escape cancels. The new name
 * also goes to the fridge's OLED (see useDeviceDisplaySync).
 */
export function RenameItemForm({ name, onSave, onCancel, className = '' }) {
  const [value, setValue] = useState(name)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = (e) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return setError('Enter an item name.')
    if (trimmed !== name) onSave(trimmed)
    onCancel()
  }

  return (
    <form className={`rename-form ${className}`} onSubmit={submit} noValidate>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        maxLength={80}
        aria-label="Item name"
      />
      <button type="submit" className="btn btn--primary btn--sm">Save</button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  )
}
