// The canvas HOST seam, end to end (DOMAIN_AUDIT §4 "Structural" + C8).
//
// `core/render/DeclarativeRegion` no longer imports canvas code; it looks the host up out of
// `core/render/canvasHost`. Two things can now silently break that a type-check cannot see:
//   1. nobody REGISTERS the host (the extensions barrel is not on the mount path) → every
//      declared canvas paints the empty hero forever;
//   2. the host is registered but its publish does not reach `declarativeCanvas` → same
//      symptom.
// So this drives the REAL registration path (importing the barrel, exactly as
// `core/render/declarativeMount` does) and the REAL provider, and asserts the feed lands in
// the REAL store. Only the data plane is a stub.

import { describe, expect, it, beforeEach } from 'vitest'
import { getDeclarativeCanvasHost } from '@/modules/workbench/core'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { InterpreterCtx } from '@/modules/workbench/core/runtime/interpreter'
import type { WorkbenchAPI } from '@/modules/workbench/core'
// The registration side effect under test — the SAME import `core/render/declarativeMount`
// makes, so if this stops registering the host, production stops too.
import '@/modules/workbench/extensions'
import { declarativeCanvas, useDeclarativeCanvasStore } from './declarativeCanvasFeed.store'
import { __resetCanvasHostForTests } from './canvasHostProvider'

const OBS = { total_counts: [10, 20, 30], pct_mito: [1, 2, 3] }

function specWith(canvas: unknown): ViewSpec {
  return {
    id: 'p.view',
    title: 'P',
    permission: 'studies::use',
    state: {},
    widgets: [],
    actions: [],
    layout: { regions: { right: [] } },
    canvas,
  } as unknown as ViewSpec
}

const CANVAS = {
  datasets: [{ id: 'obs' }, { id: 'obs.kept' }],
  grid: [],
  series: [
    { id: 's1', type: 'violin', coordId: 'c1', datasetId: 'obs', encode: { valueKey: 'total_counts' } },
    { id: 's2', type: 'violin', coordId: 'c2', datasetId: 'obs.kept', encode: { valueKey: 'total_counts' } },
  ],
}

/** A data plane that has no artifact service — the positions read fails fast, which is the
 *  path a backend-free mount takes. `publish` must still land the feed. */
const api = {
  capabilities: { resolve: () => ({ ok: false, reason: 'absent' }) },
  ui: { notify: () => {} },
} as unknown as WorkbenchAPI
const hostCtx = {} as InterpreterCtx

function publish(spec: ViewSpec, derived: Record<string, unknown>): void {
  const data = { obs: OBS }
  getDeclarativeCanvasHost()!.publish({
    spec,
    viewId: 'v1',
    data,
    scope: { params: {}, state: {}, derived, const: {}, data },
    api,
    projectId: 'proj-1',
    hostCtx,
    catalogEpoch: 1,
  })
}

describe('the canvas host seam', () => {
  beforeEach(() => {
    __resetCanvasHostForTests()
    declarativeCanvas.clear('v1')
  })

  it('is REGISTERED by importing the extensions barrel (the mount path core takes)', () => {
    expect(getDeclarativeCanvasHost()).toBeDefined()
  })

  it('publishes a declared canvas into the real feed store', () => {
    publish(specWith(CANVAS), {})
    const feed = useDeclarativeCanvasStore.getState()
    expect(feed.active).toBe(true)
    expect([...feed.contributions.keys()]).toEqual(['v1'])
    expect(feed.option?.series).toHaveLength(2)
  })

  it('C8: the DECLARED mask drives the .kept variant — under ANY derived name', async () => {
    // The point of the fix: core used to read `$derived.keptMask` by that literal name, so a
    // processor spelling its mask anything else got silently unmasked `.kept` panes.
    publish(specWith({ ...CANVAS, mask: '$derived.survivors' }), { survivors: [true, false, true] })
    const feed = useDeclarativeCanvasStore.getState()
    // Resolved through the COMPOSED resolver, by the composed id — so this also proves composition
    // dispatches back to the contributing view instead of quietly resolving nothing. The datasets
    // keep the declaration's order, so entry 1 is the masked variant it declared second.
    expect(feed.option!.datasets![1].id).toContain('obs.kept')
    const kept = await feed.resolver!(feed.option!.datasets![1].id)
    expect((await kept.catalog()).pointCount).toBe(2)
  })

  it('clears the feed for a view with no canvas block', () => {
    publish(specWith(CANVAS), {})
    expect(useDeclarativeCanvasStore.getState().active).toBe(true)
    publish(specWith(undefined), {})
    expect(useDeclarativeCanvasStore.getState().active).toBe(false)
  })

  it('clear() retires that view\'s contribution', () => {
    publish(specWith(CANVAS), {})
    getDeclarativeCanvasHost()!.clear('v1')
    expect(useDeclarativeCanvasStore.getState().active).toBe(false)
  })
})
