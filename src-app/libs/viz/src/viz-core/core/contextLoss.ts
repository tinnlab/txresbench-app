// contextLoss.ts — WebGL context-loss / -restore recovery (ITEM-57 / DEC-16).
//
// The grid renders with ONE Deck + N views (DEC-20), so a SINGLE `webglcontextlost`
// blanks the WHOLE workspace, and pop-out windows each spend one of the browser's
// ~16 concurrent-WebGL-context budget. This module gives the canvas graceful
// recovery: it listens for `webglcontextlost` (calling `preventDefault()` so the
// browser attempts to restore the context) + `webglcontextrestored` on the deck
// canvas, and exposes `{ lost, restoreKey }` — `restoreKey` bumps on every restore
// so the caller can force Deck to re-create its layers/buffers (the point positions
// and colors are still in JS memory, so restore is a cheap GPU RE-UPLOAD, never a
// data reload).
//
// viz-core rule: framework-agnostic — React + DOM only, no @txresbench/*.

import { useEffect, useReducer } from 'react'

// ── Pure recovery state machine (unit-testable, no DOM) ─────────────────────

export interface RecoveryState {
  /** true between `webglcontextlost` and the following `webglcontextrestored`. */
  lost: boolean
  /** monotonically bumps on every restore — feed it to Deck (`key`/updateTrigger)
   *  so layers + GPU buffers re-upload from the still-in-memory props. */
  restoreKey: number
}

export type RecoveryAction = { type: 'lost' } | { type: 'restored' }

export const initialRecoveryState: RecoveryState = { lost: false, restoreKey: 0 }

/** The recovery reducer: `lost` marks the context down; `restored` clears it AND
 *  bumps `restoreKey` so the caller rebuilds. Idempotent on a repeated `lost`. */
export function recoveryReducer(
  state: RecoveryState,
  action: RecoveryAction,
): RecoveryState {
  switch (action.type) {
    case 'lost':
      return state.lost ? state : { ...state, lost: true }
    case 'restored':
      return { lost: false, restoreKey: state.restoreKey + 1 }
    default:
      return state
  }
}

// ── Context-count budget guard (pop-out limit) ──────────────────────────────

/** The browser's practical ceiling on simultaneous live WebGL contexts. Beyond
 *  this the oldest context is silently dropped, so pop-outs must stay under it. */
export const MAX_WEBGL_CONTEXTS = 16

/** Warn once the live count comes within this many of the cap. */
export const CONTEXT_LIMIT_HEADROOM = 2

/** Pure predicate: is `count` within `headroom` of the `max` context cap? */
export function isNearContextLimit(
  count: number,
  max: number = MAX_WEBGL_CONTEXTS,
  headroom: number = CONTEXT_LIMIT_HEADROOM,
): boolean {
  return count >= max - headroom
}

export interface ContextBudget {
  /** Register a newly-created context; returns the new live count. */
  acquire(): number
  /** Release a destroyed context; returns the new live count (floored at 0). */
  release(): number
  /** Current live count. */
  readonly count: number
  /** true when the live count is within the warning headroom of the cap. */
  isNearLimit(): boolean
}

type BudgetWarn = (count: number, max: number) => void

const defaultWarn: BudgetWarn = (count, max) => {
  // eslint-disable-next-line no-console
  console.warn(
    `[viz] WebGL context budget near limit: ${count}/${max} live contexts. ` +
      `Close some pop-out plots — beyond ~${max} the browser drops the oldest context.`,
  )
}

/** A live-context counter with a near-limit warning. Factory form so tests get a
 *  fresh, isolated instance; the module also exposes a shared singleton below. */
export function createContextBudget(
  max: number = MAX_WEBGL_CONTEXTS,
  onWarn: BudgetWarn = defaultWarn,
): ContextBudget {
  let count = 0
  return {
    acquire() {
      count += 1
      if (isNearContextLimit(count, max)) onWarn(count, max)
      return count
    },
    release() {
      count = Math.max(0, count - 1)
      return count
    },
    get count() {
      return count
    },
    isNearLimit() {
      return isNearContextLimit(count, max)
    },
  }
}

/** Process-wide budget shared across every mounted canvas + pop-out window. */
const globalBudget = createContextBudget()

export function acquireContext(): number {
  return globalBudget.acquire()
}
export function releaseContext(): number {
  return globalBudget.release()
}
export function contextCount(): number {
  return globalBudget.count
}

/**
 * PROACTIVELY free a canvas's WebGL context. luma's `device.destroy()` (deck.gl's finalize path)
 * does NOT call `loseContext()`, so the underlying GL context lingers until GC — and because React
 * 18 StrictMode double-mounts every `<DeckGL>` (and grids remount cells), those orphaned contexts
 * ACCUMULATE and blow past the browser's ~16-context cap ("Too many active WebGL contexts. Oldest
 * context will be lost."), making a plot vanish. Calling `WEBGL_lose_context.loseContext()` on
 * unmount reclaims the context immediately. Safe AFTER deck.gl finalize (child effect cleanup runs
 * before the parent's), and a no-op on an already-lost context. deck.gl v9 is WebGL2-only, so
 * `getContext('webgl2')` returns the EXISTING context (never creates a fresh one here).
 */
export function freeCanvasContext(canvas: HTMLCanvasElement): void {
  try {
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null)
    const ext = gl?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null
    ext?.loseContext()
  } catch {
    /* defensive: a detached/torn-down canvas may throw — nothing left to free */
  }
}

/**
 * Free a canvas's GL context on a REAL unmount, StrictMode-safely. React 18 StrictMode double-invokes
 * effects (cleanup → immediate re-run) on the SAME mounted DOM, so freeing synchronously in an effect
 * cleanup would kill a still-LIVE context (blank plot + "context lost"). Deferring by a macrotask and
 * gating on `isConnected` frees only when the canvas is truly gone (real unmount removed it from the
 * DOM) and skips the simulated unmount (canvas still mounted). A deps-change re-subscribe is likewise
 * safe (the canvas stays connected).
 */
export function scheduleContextRelease(canvas: HTMLCanvasElement): void {
  setTimeout(() => {
    if (!canvas.isConnected) freeCanvasContext(canvas)
  }, 0)
}

// ── Dev/test force-loss hook ────────────────────────────────────────────────

interface ForceLossWindow extends Window {
  /** Dev-only: force a WebGL context loss (then a delayed restore) on the deck
   *  canvas so an e2e can observe the recovery cycle. Returns true if wired. */
  __VIZ_FORCE_CONTEXT_LOSS__?: (delayMs?: number) => boolean
}

function isDevEnv(): boolean {
  try {
    // Vite sets import.meta.env.DEV in dev + test; production strips this branch.
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env
    return !!env?.DEV
  } catch {
    return false
  }
}

/**
 * Install `window.__VIZ_FORCE_CONTEXT_LOSS__` (dev-only). Calling it drives a full
 * observable lost→restored cycle on the current canvas via `WEBGL_lose_context`:
 * `loseContext()` (fires `webglcontextlost`), then after `delayMs` `restoreContext()`
 * (fires `webglcontextrestored`). No-op + returns a no-op uninstaller outside dev.
 */
export function installForceContextLoss(
  getCanvas: () => HTMLCanvasElement | null,
): () => void {
  if (typeof window === 'undefined' || !isDevEnv()) return () => {}
  const w = window as ForceLossWindow
  const fn = (delayMs = 60): boolean => {
    const canvas = getCanvas()
    if (!canvas) return false
    const gl =
      (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null)
    const ext = gl?.getExtension('WEBGL_lose_context') as {
      loseContext(): void
      restoreContext(): void
    } | null
    if (!ext) return false
    ext.loseContext()
    // Simulated loss does NOT auto-restore — schedule the restore so the recovery
    // is observable from the single force call.
    setTimeout(() => {
      try {
        ext.restoreContext()
      } catch {
        /* context already gone */
      }
    }, Math.max(0, delayMs))
    return true
  }
  w.__VIZ_FORCE_CONTEXT_LOSS__ = fn
  return () => {
    if (w.__VIZ_FORCE_CONTEXT_LOSS__ === fn) delete w.__VIZ_FORCE_CONTEXT_LOSS__
  }
}

// ── React hook ──────────────────────────────────────────────────────────────

/** What `useCanvasRecovery` returns to the canvas component. */
export type CanvasRecovery = RecoveryState

/**
 * Wire context-loss recovery onto the deck canvas found inside `containerRef`.
 *
 * Deck creates its `<canvas>` asynchronously (and a keyed remount swaps it), so we
 * locate it via query + a `MutationObserver` and (re)attach listeners as it appears.
 * On loss we `preventDefault()` (asking the browser to restore) and flag `lost`; on
 * restore we clear `lost` and bump `restoreKey`. The canvas is also counted against
 * the shared context budget, and the dev force-loss hook is installed for its lifetime.
 */
export function useCanvasRecovery(
  containerRef: React.RefObject<HTMLElement | null>,
): CanvasRecovery {
  const [state, dispatch] = useReducer(recoveryReducer, initialRecoveryState)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let wired: HTMLCanvasElement | null = null

    const onLost = (e: Event) => {
      // preventDefault lets the browser attempt to restore the GPU context.
      e.preventDefault()
      dispatch({ type: 'lost' })
    }
    const onRestored = () => {
      dispatch({ type: 'restored' })
    }

    const unwire = () => {
      if (!wired) return
      wired.removeEventListener('webglcontextlost', onLost, false)
      wired.removeEventListener('webglcontextrestored', onRestored, false)
      wired = null
      releaseContext()
    }
    const wire = (canvas: HTMLCanvasElement) => {
      if (wired === canvas) return
      unwire()
      wired = canvas
      canvas.addEventListener('webglcontextlost', onLost, false)
      canvas.addEventListener('webglcontextrestored', onRestored, false)
      acquireContext()
    }
    const locate = () => {
      const c = container.querySelector('canvas')
      if (c) wire(c as HTMLCanvasElement)
    }

    locate()
    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => locate())
        : null
    mo?.observe(container, { childList: true, subtree: true })

    const uninstallForce = installForceContextLoss(() => wired)

    return () => {
      mo?.disconnect()
      const canvas = wired // capture before unwire nulls it
      unwire()
      uninstallForce()
      // Reclaim the GL context on a REAL unmount (luma's destroy() doesn't) — deferred + isConnected
      // so a StrictMode simulated unmount, which keeps the SAME canvas mounted, doesn't kill it.
      if (canvas) scheduleContextRelease(canvas)
    }
  }, [containerRef])

  return state
}

/**
 * Minimal WebGL-context lifecycle for a deck canvas that does NOT need loss RECOVERY (a chart cell
 * — `ChartCanvas` deliberately never keyed-remounts its `<DeckGL>`, so it can't swap in a fresh
 * canvas on restore). Locates the canvas, counts it against the shared budget, and — critically —
 * FREES its GL context on unmount so N chart decks don't leak past the browser's ~16-context cap.
 * Pairs with `useCanvasRecovery` (which additionally recovers a lost context).
 */
export function useReleaseGLOnUnmount(containerRef: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let tracked: HTMLCanvasElement | null = null
    const wire = (c: HTMLCanvasElement) => {
      if (tracked === c) return
      if (tracked) releaseContext()
      tracked = c
      acquireContext()
    }
    const locate = () => {
      const c = container.querySelector('canvas') as HTMLCanvasElement | null
      if (c) wire(c)
    }
    locate()
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(locate) : null
    mo?.observe(container, { childList: true, subtree: true })
    return () => {
      mo?.disconnect()
      const c = tracked
      tracked = null
      if (c) {
        releaseContext()
        // Deferred + isConnected so StrictMode's simulated unmount (same canvas stays mounted) can't
        // free a live context; a real unmount (canvas detached) frees it.
        scheduleContextRelease(c)
      }
    }
  }, [containerRef])
}

/** True when a WebGL2 context can be created (guards headless envs — DEC-16).
 *
 *  SPLIT T (ITEM-36): moved here from `GridWorkspace.tsx`, where it was a module-level helper with a
 *  single reader. This is its right home rather than a neutral one: `freeCanvasContext` is its only
 *  dependency, and both are WebGL-context-LIFECYCLE concerns. The probe's whole subtlety is that it
 *  must free the context it creates — a one-shot capability check that leaks permanently consumes a
 *  slot against the browser's ~16-context cap — and keeping the probe beside the release is what makes
 *  that invariant reviewable in one screen. */
export function webglAvailable(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const c = document.createElement('canvas')
    const ok = !!(c.getContext('webgl2') || c.getContext('webgl'))
    // Free the probe's context immediately — otherwise this one-shot check permanently consumes a
    // slot against the browser's ~16-context cap.
    if (ok) freeCanvasContext(c)
    return ok
  } catch {
    return false
  }
}
