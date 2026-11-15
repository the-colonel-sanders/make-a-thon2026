import { useId, useMemo, useState } from 'react'
import { useFoodGuidelines } from '../hooks/useFoodGuidelines.js'
import { guidelineSummary, searchFoods } from '../lib/foodSearch.js'

const GROUPS = [
  { chart: 'storage', title: 'Cold storage', hint: 'Refrigerator at 40 °F' },
  { chart: 'cooking', title: 'Cooking temperatures', hint: 'Safe minimum internal temperature' },
]

/** The part of a guideline row copied onto the item, so it survives chart edits. */
const snapshot = ({ row, label }) => ({
  code: row.code,
  chart: row.chart,
  state: row.state,
  label,
  fridge: row.fridge,
  freezer: row.freezer,
  min_temp_f: row.min_temp_f,
  rest_minutes: row.rest_minutes,
  cook_note: row.cook_note,
  note: row.note ?? null,
})

/**
 * Log a new food item under the active profile. It's timestamped to the exact
 * second it's added. Typing searches the USDA cold-storage and cooking charts
 * (e.g. "beef" lists raw ground beef, raw steaks, cooked leftovers and the
 * cooking temperatures); picking a suggestion attaches that guideline to the
 * item. Anything else can still be added as typed.
 */
export function AddItemForm({ onAdd, profile }) {
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null) // chosen suggestion, or null for free text
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1) // highlighted option (keyboard), -1 = none
  const { index, loaded } = useFoodGuidelines()
  const listId = useId()
  const inputId = useId()

  // Results grouped by chart; `options` is the same list flat, in display order.
  const { groups, options } = useMemo(() => {
    const results = searchFoods(index, name)
    const grouped = GROUPS.map((g) => ({ ...g, results: results.filter((r) => r.row.chart === g.chart) }))
      .filter((g) => g.results.length)
    return { groups: grouped, options: grouped.flatMap((g) => g.results) }
  }, [index, name])

  const query = name.trim()
  const showList = open && query.length > 0 && !(selected && selected.label === name)

  const choose = (opt) => {
    setName(opt.label)
    setSelected(opt)
    setOpen(false)
    setActive(-1)
    setError(null)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return
      e.preventDefault()
      setOpen(true)
      const step = e.key === 'ArrowDown' ? 1 : -1
      // Cycle through -1 (nothing highlighted, Enter adds as typed) and every option.
      const n = options.length + 1
      setActive((i) => ((i + 1 + step + n) % n) - 1)
    } else if (e.key === 'Enter' && showList && options[active]) {
      e.preventDefault()
      choose(options[active])
    } else if (e.key === 'Escape' && showList) {
      e.preventDefault()
      setOpen(false)
      setActive(-1)
    }
  }

  const submit = (e) => {
    e.preventDefault()
    if (!profile) return setError('Choose or add your profile at the top of the page first.')
    const trimmed = name.trim()
    if (!trimmed) return setError('Enter an item name.')
    const guideline = selected && selected.label === name ? snapshot(selected) : null
    onAdd({ name: trimmed, placedAt: Date.now(), guideline })
    setName('')
    setSelected(null)
    setOpen(false)
    setActive(-1)
    setError(null)
  }

  const activeId = showList && options[active] ? `${listId}-${active}` : undefined
  let optionIndex = -1

  return (
    <form className="add-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={inputId}>
          Item {profile ? <em className="muted">· adding as <strong>{profile.name}</strong></em> : null}
        </label>
        <div className="combo">
          <input
            id={inputId}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setSelected(null)
              setOpen(true)
              setActive(-1)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onKeyDown={onKeyDown}
            placeholder="Search, e.g. beef, raw chicken, ground turkey"
            maxLength={80}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showList}
            aria-controls={listId}
            aria-activedescendant={activeId}
            autoComplete="off"
          />
          {showList && (
            <div className="combo__list" id={listId} role="listbox" aria-label="USDA food-safety matches">
              {groups.map((g) => (
                <div key={g.chart} role="group" aria-label={g.title}>
                  <div className="combo__group" aria-hidden="true">
                    <span>{g.title}</span>
                    <span className="combo__group-hint">{g.hint}</span>
                  </div>
                  {g.results.map((opt) => {
                    optionIndex += 1
                    const i = optionIndex
                    return (
                      <div
                        key={opt.row.code + opt.label}
                        id={`${listId}-${i}`}
                        role="option"
                        aria-selected={i === active}
                        className={`combo__option ${i === active ? 'is-active' : ''}`}
                        onMouseDown={(e) => e.preventDefault()} // keep focus in the input
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(opt)}
                        title={opt.row.note ?? undefined}
                      >
                        <span className="combo__label">{opt.label}</span>
                        <span className={`combo__meta combo__meta--${opt.row.chart}`}>
                          {guidelineSummary(opt.row, { freezer: false })}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))}
              {!options.length && (
                <p className="combo__empty">
                  {loaded
                    ? <>No match in the USDA charts. “{query}” will be added as typed.</>
                    : <>Food-safety charts aren’t loaded (API offline). “{query}” will be added as typed.</>}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      <button type="submit" className="btn btn--primary">Add item</button>
      {selected && selected.label === name && (
        <p className="combo__chosen">
          {selected.row.chart === 'storage' ? 'Cold storage' : 'USDA cooking'}: {guidelineSummary(selected.row)}
          {selected.row.note && <> · {selected.row.note}</>}
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  )
}
