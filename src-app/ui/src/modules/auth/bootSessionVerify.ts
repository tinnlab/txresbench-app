// The store PROXY directly (not a registry lookup): module `initialize()` hooks run on a
// microtask scheduled by `initializeModules()`, i.e. deliberately decoupled from the
// name-registry population that happens later in that same function. `Auth` is the
// self-registering `registerLazyStore` binding, so it is valid the moment this module is
// evaluated and carries no ordering assumption. (Calling an ACTION off a proxy is legal
// anywhere; only a reactive FIELD read is render-only.)
import { Auth } from '@/modules/auth/Auth.store'
import { Auth as AuthStore } from '@/modules/auth/Auth.store'

/**
 * Kick the session verification (`GET /api/auth/me`) at module-INITIALIZE time
 * rather than waiting for `AuthGuard`'s mount effect.
 *
 * WHY: `AuthGuard` lives inside the router tree, so its effect cannot run until the
 * router + guard chunks have downloaded and committed. Worse, the guard renders a
 * FULL-SCREEN spinner while `isInitializing`, so nothing else in the app mounts — and
 * therefore nothing else fetches — until `/auth/me` resolves. It sat at the head of the
 * boot waterfall purely because of WHERE it was issued, not because anything it needs was
 * unavailable earlier: the token is read from `localStorage` before React exists.
 *
 * Issuing it from `initialize()` lets it overlap the app module's
 * `/api/app/setup/status` instead of following it.
 *
 * `AuthGuard` KEEPS its call — this is an earlier START, not a relocation. `initAuth()`
 * is self-guarded (`if (state.isLoading) return`, Auth.store.ts), so on a cold boot the
 * guard's call collapses into this one rather than issuing a second `/auth/me`, while
 * still covering the paths that reach the guard WITHOUT a boot (an in-session user
 * switch, a remount after logout).
 *
 * ── DESKTOP (differs from app #1) ─────────────────────────────────────────────────────
 * Ziee guards this with a `.desktop.ts` no-op twin, because there the desktop auto-login
 * loop owns the token and verifying a stale persisted one would fight it. That divergence
 * is NOT wired in this app: `AppMode.setMultiUserMode` has no caller anywhere in `src/`,
 * so `multiUserMode` is always its default `true`, `AuthGuard` always calls `initAuth()`,
 * and the Tauri bundle serves the SAME `ui/dist` build as the web app (no `.desktop`
 * resolution plugin in `vite.config.ts`). So this is behaviour-preserving today. If a
 * desktop auto-login path is added later, this file needs the `.desktop.ts` twin BEFORE
 * that lands — the twin is the mechanism, not a flag check, because a runtime
 * `setMultiUserMode(false)` applied in desktop `main.tsx` would race module `initialize()`.
 */
export function bootSessionVerify(): void {
  void Auth.initAuth()
}
