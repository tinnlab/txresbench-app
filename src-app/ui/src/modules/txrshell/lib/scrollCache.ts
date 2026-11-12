/**
 * txrshell — per-route scroll-position cache (app-shell ITEM-1).
 *
 * A `ScrollRegion` restores its scroll position when the user comes back to
 * a route (the browser Back button included) and keeps it per route in
 * memory — the audit doc's "scroll position restored when the user comes
 * back". The cache is deliberately IN-MEMORY and unkeyed by anything but
 * the route + the region's label: a data-flow must never surprise the user
 * by jumping to a position from a previous app session (fresh run = top),
 * and a route with two regions (the audit's `/study` questionnaire +
 * preview) needs one entry per region — the label disambiguates them.
 */

const CACHE = new Map<string, number>()

/** The cache key: route pathname + the region's accessible label. */
export function scrollCacheKey(pathname: string, label: string): string {
  return `${pathname}#${label}`
}

/** Remember a region's scrollTop. Zero is remembered too — the user's
 *  explicit "back at the top" is state, not an absence of state. */
export function saveScrollPosition(key: string, top: number): void {
  CACHE.set(key, top)
}

/** The remembered scrollTop for a key, undefined when never scrolled. */
export function getScrollPosition(key: string): number | undefined {
  return CACHE.get(key)
}

/** Test seam — empties the cache (never called by the app). */
export function clearScrollCache(): void {
  CACHE.clear()
}

/** The number of entries (test seam for the per-route memory lifetime). */
export function scrollCacheSize(): number {
  return CACHE.size
}
