// autosaveCore.ts — PURE, framework-agnostic autosave primitives (ITEM-61).
//
// Durability seam for the grid workspace: the live per-tab workspace state lives in
// `sessionStorage` (DEC-14/19/21 — per-tab isolation), which is WIPED when the tab
// closes. This module writes a redundant copy of the JSON-able workspace spec into a
// DISTINCT `localStorage` key (`AUTOSAVE_KEY`) so an accidental tab-close/crash can be
// recovered, WITHOUT fighting the per-tab sessionStorage isolation (different storage,
// different key namespace).
//
// viz-core rule (ITEM-65 / DEC-28): no `@ziee/*`, no React, no deck.gl — plain data +
// a minimal Storage seam, so it is node-unit-testable with a fake storage object.

/** The minimal Web Storage surface this module needs (localStorage / sessionStorage,
 *  or an in-memory fake in tests). A deliberate subset of the DOM `Storage` type. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * The localStorage key the workspace autosave lives under. Deliberately namespaced
 * (`viz:` prefix) and versioned (`:v1`) so it does NOT collide with the per-tab
 * sessionStorage layout keys (which are a separate storage AND a separate key space).
 */
export const AUTOSAVE_KEY = 'viz:autosave:v1'

/** Resolve the ambient `localStorage`, tolerating environments where it is absent or
 *  throws on access (SSR, sandboxed iframes). Returns null rather than throwing. */
function ambientLocalStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage as StorageLike
  } catch {
    /* access itself can throw (e.g. disabled cookies / sandboxed iframe) */
  }
  return null
}

/**
 * Serialize `value` to JSON and write it under `key`. Never throws — a quota error or
 * an unserializable value returns `false` (autosave must never break the app). Returns
 * `true` on success.
 */
export function writeAutosave<T>(
  key: string,
  value: T,
  storage: StorageLike | null = ambientLocalStorage(),
): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/**
 * Read + parse the value stored under `key`. Returns `null` for a MISSING key and for
 * CORRUPT / non-JSON content (never throws) — the caller treats null as "nothing to
 * restore".
 */
export function readAutosave<T>(
  key: string,
  storage: StorageLike | null = ambientLocalStorage(),
): T | null {
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (raw == null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Remove the autosaved value under `key`. Never throws. */
export function clearAutosave(
  key: string,
  storage: StorageLike | null = ambientLocalStorage(),
): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** A debounced function with imperative `cancel()` / `flush()` controls. */
export interface Debounced<A extends unknown[]> {
  (...args: A): void
  /** Drop any pending trailing call. */
  cancel(): void
  /** Invoke any pending trailing call immediately. */
  flush(): void
}

/**
 * Trailing-edge debounce: `fn` runs once, `ms` after the LAST call, with that call's
 * arguments. Repeated calls within the window reset the timer. Used to coalesce a burst
 * of store mutations (drag-resize, rapid edits) into a single autosave write.
 */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: A | null = null

  const run = () => {
    timer = null
    const args = pending
    pending = null
    if (args) fn(...args)
  }

  const debounced = ((...args: A) => {
    pending = args
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(run, ms)
  }) as Debounced<A>

  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
  }

  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      run()
    }
  }

  return debounced
}
