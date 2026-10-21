// windowRestore.ts — the two PER-WINDOW behaviors (ITEM-22 / DEC-16), as PURE, node-testable
// helpers. No React, no DOM state, no jsdom — every function takes its ambient input (a nav-timing
// entry, a `StorageLike`, a URL string) as an ARGUMENT, mirroring how `adapter/autosave.ts` +
// `viz-core/persist/autosaveCore.ts` inject a `StorageLike`. `react/Viz.tsx` reads
// `performance.getEntriesByType('navigation')[0]`, `window.sessionStorage`, and `location.href`,
// then delegates the decision to these predicates.
//
// ── (1) restore-only-on-reload ──────────────────────────────────────────────
// A per-window `VizOption` snapshot lives in `sessionStorage` (per-tab isolation). BUT a
// `window.open(...)` / target=_blank link-opened tab inherits a COPY of the opener's sessionStorage
// (per the HTML spec's session-history "copy" for same-origin auxiliary browsing contexts). If we
// restored on any load-with-a-snapshot, that fresh child window would wrongly resurrect the opener's
// layout. So restore is gated on the Performance Navigation Timing type being exactly `'reload'` —
// which a genuine F5 / `location.reload()` reports, but a `navigate` (the child tab) does not.
//
// ── (2) URL-as-view-into-focus ──────────────────────────────────────────────
// The focused pane is reflected in a `?pane=<id>` query param, reconciled BIDIRECTIONALLY: a focus
// change WRITES the URL (`focusToUrl`), and an inbound URL DRIVES the initial focus (`urlToFocus`).
// `isFocusUrlReconciled` is the invariant a focus change must satisfy in ALL directions (the URL
// reflects the focus, write→read round-trips, and the write is a fixpoint).

import {
  readAutosave,
  writeAutosave,
  type StorageLike,
} from '../viz-core/persist/autosaveCore'
import type { VizOption } from '../viz-core/option/types'

// ── (1) restore-only-on-reload ──────────────────────────────────────────────

/** The minimal Performance-Navigation-Timing surface `shouldRestoreOnReload` reads — just the
 *  `type` discriminant (`'reload' | 'navigate' | 'back_forward' | 'prerender'`). A superset of
 *  `PerformanceNavigationTiming`; `null`/`undefined` models a browser that has no navigation entry
 *  (treated as "not a reload"). */
export type NavigationTypeEntry = { readonly type: string } | null | undefined

/** The default `sessionStorage` key the per-window `VizOption` snapshot lives under. Namespaced +
 *  versioned so it never collides with the `viz:autosave:v1` localStorage key. */
export const VIZ_WINDOW_OPTION_KEY = 'viz:window-option:v1'

/**
 * PURE predicate: should the persisted per-window `VizOption` be re-applied on THIS load?
 *
 * `true` iff there IS a persisted snapshot AND the navigation is a genuine RELOAD. A `window.open`
 * / link-opened child tab reports `type === 'navigate'` even though it inherited a COPY of the
 * opener's sessionStorage — so it correctly returns `false` and starts from the passed-in option,
 * not the opener's stale layout.
 */
export function shouldRestoreOnReload(
  navEntry: NavigationTypeEntry,
  hasPersisted: boolean,
): boolean {
  return hasPersisted && navEntry?.type === 'reload'
}

/**
 * Persist a per-window `VizOption` snapshot under `key` (default `VIZ_WINDOW_OPTION_KEY`) in the
 * given `sessionStorage`-like store. Fail-soft (quota / unserializable / null storage ⇒ `false`,
 * never throws — a window-restore snapshot must never break the app). Returns `true` on success.
 */
export function persistWindowOption(
  storage: StorageLike | null | undefined,
  key: string,
  option: VizOption,
): boolean {
  // Pass `null` (never `undefined`) so `writeAutosave` does NOT fall back to ambient localStorage —
  // a per-window snapshot is sessionStorage-only; a missing store means "cannot persist", not
  // "persist somewhere else".
  return writeAutosave(key, option, storage ?? null)
}

/**
 * Read the per-window `VizOption` snapshot under `key`. Returns `null` for a MISSING key, a CORRUPT
 * entry, or a null storage (never throws) — the caller treats `null` as "nothing persisted".
 */
export function readWindowOption(
  storage: StorageLike | null | undefined,
  key: string,
): VizOption | null {
  return readAutosave<VizOption>(key, storage ?? null)
}

// ── (2) URL-as-view-into-focus ──────────────────────────────────────────────

/** The query param that carries the focused pane id. */
export const FOCUS_PARAM = 'pane'

/** Parse a full OR relative URL into a `URL` object, remembering whether the input was relative so
 *  `serializeUrl` can reconstruct in the SAME shape (a relative input stays relative). */
function parseUrl(url: string): { readonly u: URL; readonly relative: boolean } {
  try {
    return { u: new URL(url), relative: false }
  } catch {
    // A relative URL (`/viz?pane=x`, `?pane=x`) needs a base for the `URL` parser; the base's host
    // is stripped back off in `serializeUrl`, so its value is irrelevant.
    return { u: new URL(url, 'http://viz.local/'), relative: true }
  }
}

/** Reconstruct a URL string from a parsed `URL`, preserving the original relative/absolute shape. */
function serializeUrl(u: URL, relative: boolean): string {
  return relative ? `${u.pathname}${u.search}${u.hash}` : u.href
}

/**
 * WRITE direction: return `url` with `?pane=<focusedPaneId>` reconciled to the focused pane. A
 * `null`/empty focus REMOVES the param (no pane focused). All other path / query / hash parts are
 * preserved. Idempotent — `focusToUrl(focusToUrl(url, id), id) === focusToUrl(url, id)`.
 */
export function focusToUrl(url: string, focusedPaneId: string | null): string {
  const { u, relative } = parseUrl(url)
  if (focusedPaneId == null || focusedPaneId === '') {
    u.searchParams.delete(FOCUS_PARAM)
  } else {
    u.searchParams.set(FOCUS_PARAM, focusedPaneId)
  }
  return serializeUrl(u, relative)
}

/**
 * READ direction: extract the focused pane id from `url`'s `?pane=<id>`. Returns `null` when the
 * param is absent or empty (no pane focused). Drives the INITIAL focus on mount.
 */
export function urlToFocus(url: string): string | null {
  const { u } = parseUrl(url)
  const v = u.searchParams.get(FOCUS_PARAM)
  return v == null || v === '' ? null : v
}

/**
 * The ALL-DIRECTIONS reconcile invariant a focus change must satisfy. `true` iff:
 *  1. the URL already REFLECTS the focus (`urlToFocus(url)` equals the focus), AND
 *  2. WRITING the focus and READING it back round-trips (`urlToFocus(focusToUrl(url, f)) === f`), AND
 *  3. the WRITE is a fixpoint (re-applying the focus to the written URL is a no-op).
 *
 * `''` and `null` are the same "no focus" state (normalized). A focus change is only fully
 * reconciled once this holds — every focus mutation must leave the URL in this state.
 */
export function isFocusUrlReconciled(url: string, focusedPaneId: string | null): boolean {
  const norm = focusedPaneId === '' ? null : focusedPaneId
  // (1) the URL reflects the focus
  if (urlToFocus(url) !== norm) return false
  // (2) write → read round-trips
  const written = focusToUrl(url, norm)
  if (urlToFocus(written) !== norm) return false
  // (3) the write is a fixpoint (idempotent)
  if (focusToUrl(written, norm) !== written) return false
  return true
}
