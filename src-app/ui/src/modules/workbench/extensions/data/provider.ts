// The `data` capability PROVIDER (ITEM-6/10) — the `{id, version, create}` half
// `extensions/index.ts` registers. Kept out of `./index.ts` so the registration path
// pulls only the plane + the pure bind, never the extension's whole barrel.

import { capabilitiesFor, type WorkbenchHost } from '@/modules/workbench/core'
import { createCatalogCache } from './catalogCache.ts'
import { makeColumnarFrameReader } from './columnarRead.ts'
import { DATA_CAPABILITY_ID, type DataApi, type DataHost } from './contract.ts'
import { createDataApi } from './dataCapability.ts'
import { createDataHost } from './dataHost.ts'
import { buildProjectSources } from './projectSources.ts'

/** Bind the capability to a host bundle: the shell-injected plane
 *  (`planes['data']`, used by the gallery/e2e fake) when present, else the real
 *  ApiClient plane. */
export function createDataCapability(host: WorkbenchHost): DataApi {
  const injected = host.planes?.[DATA_CAPABILITY_ID] as DataHost | undefined
  const plane = injected ?? createDataHost()
  const bound = createDataApi(plane, host.projectId, {
    // ITEM-42 — the columnar read goes through the SAME memoized source the canvas holds. The
    // accessor is LAZY on purpose: this factory runs while `capabilitiesFor(host)` is stocking
    // the broker, so resolving it now would re-enter that installation. `capabilitiesFor` is
    // memoized per host, so by read time this is the very broker the canvas keys its memo on —
    // which is what makes the two consumers share ONE source rather than two (DEC-20).
    readColumnarFrame: makeColumnarFrameReader(() =>
      buildProjectSources({ capabilities: capabilitiesFor(host) }, host.projectId),
    ),
  })
  // An INJECTED plane (the gallery/e2e/unit fake host, via `host.planes`) is already an
  // in-memory answer with no round trip to spare, so it is returned UNWRAPPED — and it must
  // be: the cache dedupes the two identical control-plane reads a resolve makes, which is
  // exactly what fixtures like `dataStatusGate.test.tsx` freeze the window BETWEEN to prove a
  // view says nothing mid-fetch. Only the REAL ApiClient plane (production; `createWorkbenchHost`
  // injects no plane) is the one that pays for redundant `/artifacts` + `/catalog` requests.
  if (injected) return bound

  // Wrap the TWO control-plane reads with an epoch-keyed, in-flight-deduped cache
  // (`catalogCache.ts`): the declarative slice resolvers each call `catalog()` /
  // `artifacts.query({})` independently, so one pane section fired three artifact reads per
  // resolve and re-paid the whole set on every colour-by selection. The shell advances the
  // epoch via `setCatalogEpoch` (see `WorkbenchContext.refreshCatalog`), so a real catalog
  // change is a miss and everything else is a hit. Per-artifact byte reads pass through
  // untouched.
  const cache = createCatalogCache({
    catalog: () => bound.catalog(),
    query: sel => bound.artifacts.query(sel),
    projectId: host.projectId,
  })
  return {
    ...bound,
    catalog: cache.catalog,
    artifacts: { query: cache.query },
    setCatalogEpoch: cache.setCatalogEpoch,
  }
}
