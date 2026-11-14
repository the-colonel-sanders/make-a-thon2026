import { useCallback, useEffect, useState } from 'react'
import { STORAGE_KEYS } from '../lib/storageKeys.js'

// Employee profiles ({ id, name, role }) and which one is active on this browser.
// Stored in localStorage alongside the food items.
const PROFILES_KEY = STORAGE_KEYS.profiles
const ACTIVE_KEY = STORAGE_KEYS.activeProfile

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage unavailable: keep working in memory.
  }
}

const newId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`

export function useProfiles() {
  const [profiles, setProfiles] = useState(() => {
    const p = read(PROFILES_KEY, [])
    return Array.isArray(p) ? p : []
  })
  const [activeId, setActiveId] = useState(() => read(ACTIVE_KEY, null))

  useEffect(() => write(PROFILES_KEY, profiles), [profiles])
  useEffect(() => write(ACTIVE_KEY, activeId), [activeId])

  // Keep several open tabs in sync.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === PROFILES_KEY) setProfiles(read(PROFILES_KEY, []))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const active = profiles.find((p) => p.id === activeId) ?? null

  /** Adds a profile (or reuses one with the same name) and makes it active. */
  const addProfile = useCallback(
    (name, role = '') => {
      const trimmed = name.trim()
      if (!trimmed) return null
      const existing = profiles.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
      if (existing) {
        setActiveId(existing.id)
        return existing
      }
      const profile = { id: newId(), name: trimmed, role: role.trim() }
      setProfiles((list) => [...list, profile])
      setActiveId(profile.id)
      return profile
    },
    [profiles],
  )

  /** Change an employee's name or role. Returns false if the name is empty or taken. */
  const updateProfile = useCallback(
    (id, patch) => {
      if (patch.name != null) {
        const trimmed = patch.name.trim()
        const taken = profiles.some((p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase())
        if (!trimmed || taken) return false
        patch = { ...patch, name: trimmed }
      }
      setProfiles((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)))
      return true
    },
    [profiles],
  )

  const removeProfile = useCallback((id) => {
    setProfiles((list) => list.filter((p) => p.id !== id))
    setActiveId((cur) => (cur === id ? null : cur))
  }, [])

  return { profiles, active, setActiveId, addProfile, updateProfile, removeProfile }
}
