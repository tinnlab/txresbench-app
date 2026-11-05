/**
 * txrintake — the module-level STABLE-KEY fetch cache for the module's
 * static catalogue reads: the marker vocabulary (`useMarkers`, the
 * CONS-UI-INTAKE-1 fetch) and the runnable method count
 * (`useRunnableMethodCount`, the CONS-UI-INTAKE-3 fetch).
 *
 * Why it exists. The vocabulary and the count are ONE response per
 * catalogue, and screens A/B mount their hooks on every visit — without
 * a value cache, A → B → A re-fetches the same bytes three times, and a
 * dev double-mount (React's StrictMode) fires a duplicate in parallel.
 * The cache keeps ONE request per key per session: settled values are
 * reused across mounts, and concurrent mounts share one request.
 *
 * Semantics:
 *
 * - `readCached` — the settled value for the key, if any. A cache-hit
 *   mount renders its data on the FIRST frame (no loading flash, no
 *   request).
 * - `fetchCached` — a settled key resolves immediately (no network); an
 *   in-flight key JOINS the same promise, so two mounts that arrive
 *   together pay one round trip; a fresh key issues `request()` and
 *   stores the value on success.
 * - A rejection is never cached: the pending entry is dropped, so the
 *   next mount or `refetch()` genuinely retries — a cached failure
 *   would be a stale error nothing could clear.
 * - `dropCached` invalidates a key: `refetch()`'s deliberately-hits-the-
 *   wire path (the `useStudyPreview` refetch rule). A request already in
 *   flight when dropped cannot write its value back (the identity
 *   guard), so the value map only ever holds the newest attempt.
 *
 * The `workbench/extensions/data/catalogCache.ts` pair (value cache +
 * in-flight de-dup, identity-guarded writes, rejections never cached)
 * is the house precedent; this cache is deliberately simpler — the
 * reads are static per catalogue, so there is no epoch invalidator,
 * and the module's one stable string key per read is the whole key
 * space.
 *
 * This module owns the cache STATE only; the hooks own the wire calls
 * (`data/useMarkers.ts`, `data/useRunnableMethodCount.ts`).
 */

const values = new Map<string, unknown>()
const pending = new Map<string, Promise<unknown>>()

/** The settled value for `key`, if any. */
export function readCached<T>(key: string): T | undefined {
  return values.has(key) ? (values.get(key) as unknown as T) : undefined
}

/**
 * The value for `key`: settled → resolved immediately (no network);
 * in flight → the SAME promise (one round trip for concurrent mounts);
 * fresh → `request()` is issued and its success is stored.
 */
export function fetchCached<T>(key: string, request: () => Promise<T>): Promise<T> {
  if (values.has(key)) return Promise.resolve(values.get(key) as T)
  const inflight = pending.get(key)
  if (inflight) return inflight as Promise<T>
  const promise = request()
  pending.set(key, promise as Promise<unknown>)
  void promise.then(
    value => {
      // Identity guard: a dropped/refetched key must not let an older
      // attempt write its value over the newer one.
      if (pending.get(key) === promise) {
        values.set(key, value)
        pending.delete(key)
      }
    },
    () => {
      if (pending.get(key) === promise) pending.delete(key)
    },
  )
  return promise
}

/** Forget `key` (value + in-flight) — the next `fetchCached` hits the wire. */
export function dropCached(key: string): void {
  values.delete(key)
  pending.delete(key)
}

/**
 * Test seam: clear every entry (values + in-flight) so each test starts
 * from an empty key space. The cache is module-level by design (the two
 * hooks share one per-key state), so a suite that asserts request
 * counts resets it here — the framework's `__resetInflightForTests`
 * precedent (`api-client/inflight.ts`). Never called by the app; the
 * app's single lifecycle is the page session.
 */
export function __resetFetchCacheForTests(): void {
  values.clear()
  pending.clear()
}
