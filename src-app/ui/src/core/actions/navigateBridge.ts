import { useEffect } from 'react'
import { useNavigate, type NavigateFunction } from 'react-router-dom'

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

  useEffect(() => {
    navigateRef = navigate
    return () => {
      if (navigateRef === navigate) navigateRef = null
    }
  }, [navigate])

  return null
}
