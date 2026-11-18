import { useEffect } from 'react'
import { useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'

// DEC-9 (`.lifecycle/ai-mcp/DECISIONS.md`): how a GLOBAL action's `run`
// (invoked from the out-of-React agent engine, `./engine.ts`) reaches
// react-router's `navigate` — a hook, only callable inside a component.
//
// Resolution: a module-level navigate-bridge. `RouterBridge` is mounted
// INSIDE the router context (via the SDK router's `routerEffects` slot —
// see `src/modules/actions/module.tsx`) and captures `useNavigate()` into a
// module-level ref on mount; `navigateViaBridge` (used by `ctx.navigate`,
// see `./ctx.ts`) reads that ref. Standard "imperative navigation outside
// React" pattern.

let navigateRef: NavigateFunction | null = null

/** The router's current path + search, captured by `RouterBridge` (null before it mounts). */
let pathRef: string | null = null

/**
 * The page the user is on (path + search), for an action that needs to know
 * where it was started from (a new path's origin, the step Back trail).
 * Falls back to `window.location` before `RouterBridge` mounts.
 */
export function currentPathViaBridge(): string {
  if (pathRef !== null) return pathRef
  if (typeof window === 'undefined') return '/'
  return `${window.location.pathname}${window.location.search}`
}

/**
 * Navigate the app to `path`. Used by `ctx.navigate` (and directly by the
 * `app.navigate` / `project.openProject` built-in actions). Falls back to a full
 * navigation via `location.assign` if `RouterBridge` hasn't mounted yet (SPA
 * boot race) rather than silently no-op-ing.
 */
export function navigateViaBridge(path: string): void {
  if (!navigateRef) {
    console.warn(
      '[actions] navigateViaBridge called before RouterBridge mounted; falling back to a full navigation',
      path,
    )
    window.location.assign(path)
    return
  }
  navigateRef(path)
}

/**
 * Headless router-context component. Renders nothing; on mount it captures
 * `useNavigate()` into the module-level ref so `navigateViaBridge` works
 * from outside React. Register it via the SDK router's `routerEffects` slot
 * (NOT a `components` entry — those render as AppShell siblings, outside the
 * `<BrowserRouter>`, where `useNavigate` would throw).
 */
export function RouterBridge(): null {
  const navigate = useNavigate()
  const { pathname, search } = useLocation()

  useEffect(() => {
    navigateRef = navigate
    return () => {
      if (navigateRef === navigate) navigateRef = null
    }
  }, [navigate])

  useEffect(() => {
    const here = `${pathname}${search}`
    pathRef = here
    return () => {
      if (pathRef === here) pathRef = null
    }
  }, [pathname, search])

  return null
}
