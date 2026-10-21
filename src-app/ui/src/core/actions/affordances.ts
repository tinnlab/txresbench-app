import { useCallback, useRef } from 'react'

// The AFFORDANCE registry (richer-actions ITEM-5). A module-level singleton — the
// SAME shape as `./instanceRegistry.ts` + `./activeContext.ts` — that maps a NAME
// ("datasets:picker", "datasets:attach-button") to the live DOM element a UI surface
// exposes for choreography to (a) SPOTLIGHT and (b) gate step-READINESS on. A
// surface registers its affordances from a callback ref via `useAffordance`; the
// choreography runner (`./choreography.ts`) `awaitAffordance`s a name before a
// handler step (so "open the pane, THEN act on the just-mounted pane" needs no
// timeout — the registration IS the readiness signal), and the overlay
// (`ChoreographyOverlay`) reads `getAffordance` to position its spotlight.
//
// NAMES are feature-NAMESPACED ("<feature>:<part>") so two features reusing this
// registry can't collide on a bare "picker". Purely LOCAL (per-realm, in-memory) —
// a popped-out window is a separate JS realm with its own singleton, so choreography
// never targets another window's affordances. `unregisterAffordance` is
// element-guarded (a stale unmount after a remount is a no-op — the exact case the
// guard exists for), and `useAffordance` passes the element it registered so the
// guard actually runs on the real hook path.

export interface AffordanceEntry {
  /** The live element to spotlight / measure. */
  el: HTMLElement
}

/** Default max wait for an affordance to register (the choreography runner passes
 *  its own `CHOREOGRAPHY_LIMITS.readinessTimeoutMs`; this is the bare-call default). */
const DEFAULT_READINESS_TIMEOUT_MS = 4000

const affordances = new Map<string, AffordanceEntry>()
const waiters = new Map<string, Set<(e: AffordanceEntry) => void>>()

/** Register (or replace) the affordance `name` → `el`. Resolves any pending
 *  `awaitAffordance(name)`. */
export function registerAffordance(name: string, el: HTMLElement): void {
  const entry: AffordanceEntry = { el }
  affordances.set(name, entry)
  const w = waiters.get(name)
  if (w) {
    waiters.delete(name)
    for (const resolve of w) resolve(entry)
  }
}

/** Unregister `name`. Element-guarded: when `el` is given, only removes the entry
 *  if it is still the CURRENT one (a stale unmount after a remount is a no-op). */
export function unregisterAffordance(name: string, el?: HTMLElement): void {
  if (el && affordances.get(name)?.el !== el) return
  affordances.delete(name)
}

/** The live affordance for `name`, or `undefined` if not currently registered. */
export function getAffordance(name: string): AffordanceEntry | undefined {
  return affordances.get(name)
}

export interface AwaitAffordanceOptions {
  /** Abort the wait (the choreography was interrupted). */
  signal?: AbortSignal
  /** Reject after this many ms if the affordance never registers. */
  timeoutMs?: number
}

/** Resolve once `name` is registered — immediately if it already is, else when a
 *  surface registers it. Rejects on `signal` abort or after `timeoutMs`. This is
 *  the step-readiness gate: a handler step awaits its target affordance so it can
 *  fire the instant the (possibly just-opened) surface has mounted. */
export function awaitAffordance(
  name: string,
  { signal, timeoutMs = DEFAULT_READINESS_TIMEOUT_MS }: AwaitAffordanceOptions = {},
): Promise<AffordanceEntry> {
  return new Promise((resolve, reject) => {
    const existing = affordances.get(name)
    if (existing) {
      resolve(existing)
      return
    }
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    let settled = false
    const onResolve = (e: AffordanceEntry) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(e)
    }
    const set = waiters.get(name) ?? new Set()
    set.add(onResolve)
    waiters.set(name, set)
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`affordance '${name}' not ready within ${timeoutMs}ms`))
    }, timeoutMs)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort)
    function cleanup() {
      clearTimeout(timer)
      const s = waiters.get(name)
      if (s) {
        s.delete(onResolve)
        if (s.size === 0) waiters.delete(name) // don't strand an empty Set
      }
      signal?.removeEventListener('abort', onAbort)
    }
  })
}

/**
 * The hook a live surface calls to expose an affordance for as long as the element
 * is mounted. Returns a callback ref: on mount it registers `name` → the node, on
 * unmount it unregisters PASSING THE ELEMENT it registered, so the element-guard
 * runs (a stale late unmount can't clobber a live remount).
 *
 * Usage: `<div ref={useAffordance('datasets:picker')}>`.
 */
export function useAffordance(name: string): (el: HTMLElement | null) => void {
  const registeredEl = useRef<HTMLElement | null>(null)
  return useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        registeredEl.current = el
        registerAffordance(name, el)
      } else {
        unregisterAffordance(name, registeredEl.current ?? undefined)
        registeredEl.current = null
      }
    },
    [name],
  )
}

/** Test-only reset (mirrors `instanceRegistry.__resetInstanceRegistryForTests`).
 *  Never called from production code. */
export function __resetAffordancesForTests(): void {
  affordances.clear()
  waiters.clear()
}
