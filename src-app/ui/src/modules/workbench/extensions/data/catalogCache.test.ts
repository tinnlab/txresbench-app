// The epoch-keyed, in-flight-deduped catalog cache (`catalogCache.ts`) — the fix for the
// colour-by refetch: one pane section declares THREE control-plane slices, so ONE resolve
// fired three `artifacts.query({})` + one `catalog()`, and every column re-selection re-ran
// the whole set against an uncached plane.
//
// These drive the cache through the REAL `resolveViewData` path over a spec whose three data
// slices are the ones a shipped colour-by section declares (`pane_frame` + `column_values` +
// `row_space_columns`), against a COUNTING `DataHost`, so the assertions are on the actual
// network-call count the resolvers would make.

import { describe, it, expect } from 'vitest'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import type { DataSourceSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { readSliceFromApi, resolveViewData } from '@/modules/workbench/core/runtime/viewData'
import { createCatalogCache } from './catalogCache.ts'
import { createDataApi } from './dataCapability.ts'
import { createDataCapability } from './provider.ts'
import { DATA_CAPABILITY_ID, type DataHost } from './contract.ts'
import type { WorkbenchHost } from '@/modules/workbench/core'

/** A `DataHost` that COUNTS the two control-plane reads and answers empty. Empty artifacts
 *  is deliberate — the resolvers still CALL `catalog()`/`listArtifacts()` (which is what we
 *  count) and then degrade to no-anchor / no-columns without any byte read. */
function countingHost(projectId: string): { host: DataHost; counts: { catalog: number; query: number } } {
  const counts = { catalog: 0, query: 0 }
  const host: DataHost = {
    catalog: async pid => {
      counts.catalog++
      return { project_id: pid, axes: [], artifacts: [] }
    },
    listArtifacts: async () => {
      counts.query++
      return []
    },
    readColumn: async () => ({ values: new Float32Array() }),
    readArtifact: async () => new Uint8Array(),
    readOpaque: async () => new Uint8Array(),
    previewValues: async () => undefined,
  }
  void projectId
  return { host, counts }
}

/** The production wiring from `provider.ts`, minus the byte-route dep the counting host
 *  never reaches: a `createDataApi` bind wrapped by `createCatalogCache`, published into a
 *  broker as the `data` capability. */
function cachedApi(projectId: string) {
  const { host, counts } = countingHost(projectId)
  const bound = createDataApi(host, projectId)
  const cache = createCatalogCache({
    catalog: () => bound.catalog(),
    query: sel => bound.artifacts.query(sel),
    projectId,
  })
  const dataApi = { ...bound, catalog: cache.catalog, artifacts: { query: cache.query }, setCatalogEpoch: cache.setCatalogEpoch }
  const capabilities = createCapabilityBroker()
  capabilities.publish('data', '1.0.0', dataApi)
  const api = { capabilities } as unknown as WorkbenchAPI
  return { api, counts, setCatalogEpoch: cache.setCatalogEpoch }
}

/** The colour-by section's three data slices (mirrors `colour-by.yaml`). */
const COLOUR_BY_SPEC = {
  id: 'sc.viz.colour-by',
  data: {
    frame: { source: 'pane_frame', args: { axis: '$scope.axis', coordinate: '$scope.coordinate' } },
    plotted: { source: 'column_values', args: { of: '$state.plots' } },
    columns: {
      source: 'row_space_columns',
      args: {
        aligned_to: '$scope.axis',
        coordinate: '$scope.coordinate',
        datatype: 'demo-column',
        kinds: [
          { kind: 'categorical', heading: 'Groups' },
          { kind: 'continuous', heading: 'Values' },
        ],
      },
    } as DataSourceSpec,
  },
} as unknown as ViewSpec

/** A pane with one plotted column (a column selected to colour by) — so `column_values` has
 *  a request and fires its `artifacts.query({})`, as it does after a real selection. */
const scopeWithOnePlot: Scope = {
  state: { plots: [{ artifact: 'a1', name: 'col', mode: 'continuous' }] },
  scope: { axis: 'h1', coordinate: 'c1' },
} as unknown as Scope

const resolveOnce = (api: WorkbenchAPI, scope: Scope) =>
  resolveViewData(COLOUR_BY_SPEC, (key, decl, declaredIn) => readSliceFromApi(api, key, decl, scope, declaredIn))

describe('catalogCache — the colour-by refetch fix', () => {
  it('T1: two colour-by resolves at the SAME epoch collapse to ≤1 catalog + ≤1 artifacts call', async () => {
    const { api, counts } = cachedApi('p1')

    // First resolve — the three slices (pane_frame + column_values + row_space_columns).
    await resolveOnce(api, scopeWithOnePlot)
    // Second resolve — the SAME epoch (a re-selection that changed no artifact).
    await resolveOnce(api, scopeWithOnePlot)

    // Without the cache this is 2 catalog (one per pane_frame) + 6 artifacts (three slices ×
    // two passes). The cache serves both passes from one epoch entry each.
    expect(counts.catalog).toBeLessThanOrEqual(1)
    expect(counts.query).toBeLessThanOrEqual(1)
    expect(counts.catalog).toBe(1)
    expect(counts.query).toBe(1)
  })

  it('T2 (freshness): bumping the catalog epoch between resolves forces a refetch', async () => {
    const { api, counts, setCatalogEpoch } = cachedApi('p1')

    await resolveOnce(api, scopeWithOnePlot)
    expect(counts.catalog).toBe(1)
    expect(counts.query).toBe(1)

    // A run completed / a dataset attached → the workbench advances the epoch. The next
    // resolve MUST re-read the plane (a bumped epoch is a cache miss), or it would serve
    // pre-run artifacts.
    setCatalogEpoch(1)
    await resolveOnce(api, scopeWithOnePlot)

    expect(counts.catalog).toBe(2)
    expect(counts.query).toBe(2)
  })

  it('T3 (isolation): two projects do not share cache entries', async () => {
    const p1 = cachedApi('p1')
    const p2 = cachedApi('p2')

    await resolveOnce(p1.api, scopeWithOnePlot)
    await resolveOnce(p2.api, scopeWithOnePlot)

    // Each project's plane is read exactly once — p2 is never served p1's rows.
    expect(p1.counts.catalog).toBe(1)
    expect(p1.counts.query).toBe(1)
    expect(p2.counts.catalog).toBe(1)
    expect(p2.counts.query).toBe(1)
  })
})

describe('createCatalogCache — de-dup + invalidation units', () => {
  it('shares ONE in-flight promise across concurrent callers of the same key', async () => {
    let calls = 0
    let release: (v: unknown[]) => void = () => {}
    const gate = new Promise<unknown[]>(res => {
      release = res
    })
    const cache = createCatalogCache({
      catalog: async () => ({ project_id: 'p', axes: [], artifacts: [] }),
      query: async () => {
        calls++
        return (await gate) as never
      },
      projectId: 'p',
    })

    // Three concurrent callers while the fetch is still pending.
    const a = cache.query({})
    const b = cache.query({})
    const c = cache.query({})
    release([])
    await Promise.all([a, b, c])

    expect(calls).toBe(1)
  })

  it('does NOT cache a rejected read — a retry re-fetches', async () => {
    let attempt = 0
    const cache = createCatalogCache({
      catalog: async () => {
        attempt++
        if (attempt === 1) throw new Error('boom')
        return { project_id: 'p', axes: [], artifacts: [] }
      },
      query: async () => [],
      projectId: 'p',
    })

    await expect(cache.catalog()).rejects.toThrow('boom')
    // The retry is a fresh fetch (the rejection was not cached) and succeeds.
    const ok = await cache.catalog()
    expect(ok.project_id).toBe('p')
    expect(attempt).toBe(2)
  })

  it('createDataCapability caches the REAL plane but leaves an INJECTED fake plane unwrapped', () => {
    const bareHost = { projectId: 'p', planes: undefined } as unknown as WorkbenchHost
    // Real plane (no injected `data` plane) → cache active, so `setCatalogEpoch` is present.
    expect(typeof createDataCapability(bareHost).setCatalogEpoch).toBe('function')

    const fake: DataHost = {
      catalog: async pid => ({ project_id: pid, axes: [], artifacts: [] }),
      listArtifacts: async () => [],
      readColumn: async () => ({ values: new Float32Array() }),
      readArtifact: async () => new Uint8Array(),
      readOpaque: async () => new Uint8Array(),
      previewValues: async () => undefined,
    }
    const injectedHost = { projectId: 'p', planes: { [DATA_CAPABILITY_ID]: fake } } as unknown as WorkbenchHost
    // Injected in-memory fake → returned unwrapped (no cache), so gallery/e2e/gate fixtures
    // see every read reach their plane.
    expect(createDataCapability(injectedHost).setCatalogEpoch).toBeUndefined()
  })

  it('setCatalogEpoch is idempotent when the epoch is unchanged (no spurious invalidation)', async () => {
    let calls = 0
    const cache = createCatalogCache({
      catalog: async () => {
        calls++
        return { project_id: 'p', axes: [], artifacts: [] }
      },
      query: async () => [],
      projectId: 'p',
    })

    await cache.catalog()
    cache.setCatalogEpoch(0) // same epoch → no-op
    cache.setCatalogEpoch(0)
    await cache.catalog()
    expect(calls).toBe(1)
  })
})
