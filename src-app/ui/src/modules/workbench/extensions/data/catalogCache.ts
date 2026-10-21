// The epoch-keyed, in-flight-deduped CACHE for the `data` capability's TWO control-plane
// reads — `catalog()` and `artifacts.query(sel)` — the reads behind `GET
// /api/projects/{id}/catalog` and `GET /api/projects/{id}/artifacts`.
//
// ## Why this exists
//
// The declarative slice resolvers (`core/runtime/viewData.ts`) each resolve the `data`
// capability independently and call `catalog()` / `artifacts.query({})` themselves. One
// pane section (e.g. `colour-by`) declares THREE control-plane slices — `pane_frame`,
// `row_space_columns`, `column_values` — so ONE resolve fired THREE `artifacts.query({})`
// and one `catalog()`, none of them shared. And because plotting a column changes
// `$state.plots`, the whole section re-resolves on every colour-by selection, so with the
// plane hitting `ApiClient.Workstore` directly (`dataHost.ts`, uncached) each selection
// re-paid the whole set. This cache collapses both: the concurrent/repeated reads of ONE
// epoch resolve to ONE network call, and a selection that does not change the catalog is a
// pure cache hit.
//
// ## Correctness over cleverness — the epoch is the invalidator
//
// Artifacts are immutable + content-addressed, so within a catalog EPOCH the answer is
// fixed; the workbench advances the epoch (`WorkbenchContext.catalogEpoch`) on any change
// to the project's artifact set — a run's ingest, an attach/detach, a delete, on this
// device or another (`useCatalogInvalidation`). A DIFFERENT epoch produces different keys
// AND clears the store, so a bumped epoch is always a cache MISS: serving stale artifacts
// after a run would be a worse bug than the refetch, so the epoch MUST invalidate. The
// project id is in every key too, so two projects can never collide.
//
// This owns only the CONTROL-plane reads. The per-artifact byte reads (`readColumn` /
// `read` / `readOpaque` / `readColumnarFrame` / `previewValues`) pass through untouched —
// they have their own byte-route caches and are not the refetch this fixes.

import type { TypeSelector } from '@/modules/workbench/core'
import type { ArtifactQuery, ArtifactRow, ProjectCatalog } from './contract.ts'

/** The two cached reads plus the epoch control the shell drives invalidation through. */
export interface CatalogCache {
  catalog(): Promise<ProjectCatalog>
  query(sel: ArtifactQuery | TypeSelector): Promise<ArtifactRow[]>
  /** Advance the cache to a new catalog epoch. A different epoch DROPS every cached read
   *  (both settled values and in-flight promises), so the next read refetches. Idempotent
   *  when `epoch` is unchanged — the common re-render carries no change and pays nothing. */
  setCatalogEpoch(epoch: number): void
}

export interface CatalogCacheDeps {
  catalog: () => Promise<ProjectCatalog>
  query: (sel: ArtifactQuery | TypeSelector) => Promise<ArtifactRow[]>
  projectId: string
}

/** A deterministic key for a selector, ORDER-INSENSITIVE: two equal queries whose keys were
 *  written in a different order are one result and must be one cache entry. A non-object
 *  selector (the hot `{}` normalises to one, but a primitive is possible) falls back to a
 *  plain stringify. */
function selectorKey(sel: unknown): string {
  if (sel === null || typeof sel !== 'object') return JSON.stringify(sel) ?? 'undefined'
  const obj = sel as Record<string, unknown>
  return JSON.stringify(Object.keys(obj).sort().map(k => [k, obj[k]]))
}

/**
 * Wrap the two control-plane reads with an epoch-keyed value cache + an in-flight
 * de-duplicator.
 *
 * The de-dup returns the SAME pending promise to concurrent callers of one key, so the
 * three slices of a resolve share one network call; on success the value is stored (so the
 * next epoch-stable read is synchronous) and on FAILURE the pending entry is dropped so a
 * retry re-fetches — a rejected promise is never cached. The compare-by-identity guard
 * (`pending.get(key) === p`) means a promise abandoned by an epoch bump can never write
 * back into the live store.
 */
export function createCatalogCache(deps: CatalogCacheDeps): CatalogCache {
  let epoch = 0
  const values = new Map<string, unknown>()
  const pending = new Map<string, Promise<unknown>>()

  function run<T>(key: string, fetch: () => Promise<T>): Promise<T> {
    if (values.has(key)) return Promise.resolve(values.get(key) as T)
    const inflight = pending.get(key)
    if (inflight) return inflight as Promise<T>
    const p = fetch()
    pending.set(key, p as Promise<unknown>)
    void p.then(
      v => {
        if (pending.get(key) === p) {
          values.set(key, v)
          pending.delete(key)
        }
      },
      () => {
        // Never cache a rejection — drop the pending entry so the next call re-fetches.
        if (pending.get(key) === p) pending.delete(key)
      },
    )
    return p
  }

  return {
    catalog: () => run(`catalog|${deps.projectId}|${epoch}`, deps.catalog),
    query: sel =>
      run(`artifacts|${deps.projectId}|${epoch}|${selectorKey(sel)}`, () => deps.query(sel)),
    setCatalogEpoch: next => {
      if (next === epoch) return
      epoch = next
      // Keys already carry the epoch, so the old entries are unreachable; clearing them
      // keeps the store bounded and lets any in-flight old-epoch promise settle into
      // nothing (its identity guard fails against the emptied map).
      values.clear()
      pending.clear()
    },
  }
}
