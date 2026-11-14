import { useEffect, useState } from 'react'

// Minimal hash router ("#/history"). Works with any static host or `vite preview`
// without server-side rewrite rules.
const current = () => window.location.hash.replace(/^#/, '') || '/'

export function useHashRoute() {
  const [route, setRoute] = useState(current)
  useEffect(() => {
    const onChange = () => {
      setRoute(current())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
