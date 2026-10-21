// canvasTeardown.test.ts — tearing a canvas down must RELEASE the datasets it pinned (G2).
//
// `teardownCanvas` is the app's ONE "this controller is abandoned" helper. Every call site nulls
// the reference straight after it, so nothing will ever drive that controller again. It used to
// dispatch only `removePane`, which clears the shared grid and touches no dataset ref-count — and
// the controller's ONLY other release site is `applyOption`'s previous-ids sweep, which runs on the
// NEXT `setOption`. For a torn-down controller that next `setOption` never comes, so its last
// option's entries (resolved source, catalog, per-layout positions, colour buffer) stayed pinned in
// a `DatasetStore` that outlives every controller a page constructs.
//
// The two properties are asserted separately because an implementation that gets one right can get
// the other exactly backwards: EVICTING on teardown returns the store to zero just as well as
// releasing does, and yanks the resolved source out from under a canvas still rendering it.
//
// The store set is passed EXPLICITLY so each assertion is about what THESE controllers hold, not
// about whatever else a module singleton accumulated across the suite.

import { describe, expect, it } from 'vitest'
import { createVizStores, FixtureSource, installBuiltins, VizController, type VizOption } from '@ziee/viz'
import { teardownCanvas } from './canvasBinding'

installBuiltins()

/** One pane per dataset — the minimum shape that makes the controller acquire a ref per id. */
const optionOver = (ids: readonly string[]): VizOption => ({
  datasets: ids.map(id => ({ id })),
  grid: ids.map((_, i) => ({ id: `p${i}`, region: { row: 0, col: i } })),
  series: ids.map((id, i) => ({
    id: `s${i}`,
    type: 'scatter',
    coordId: `p${i}`,
    datasetId: id,
    encode: { layout: 'primary' },
  })),
})

describe('teardownCanvas releases what the canvas held (G2)', () => {
  it('a torn-down canvas leaves ZERO retained dataset entries', async () => {
    const stores = createVizStores()
    const controller = new VizController({
      resolveDataset: (id: string) => new FixtureSource({ seed: id.length, pointCount: 128 }),
      stores,
    })
    await controller.setOption(optionOver(['left', 'right']), { replace: true })
    expect(
      Object.keys(stores.datasetStore.getState().datasets).sort(),
      'the canvas has to be holding something for the teardown assertion to mean anything',
    ).toEqual(['left', 'right'])

    teardownCanvas(controller)

    expect(
      stores.datasetStore.getState().datasets,
      'the torn-down canvas still pins its last option\'s datasets. Removing its panes says nothing ' +
        'about the ref-counts, and no later `setOption` will ever come to sweep them — so the store ' +
        'never returns to zero across a session that opens and closes analyses.',
    ).toEqual({})
  })

  it('teardown RELEASES, it does not EVICT — a dataset another live canvas holds survives', async () => {
    const stores = createVizStores()
    const src = new FixtureSource({ seed: 3, pointCount: 256 })
    const mk = () => new VizController({ resolveDataset: () => src, stores })
    const closing = mk()
    const surviving = mk()
    await closing.setOption(optionOver(['shared']), { replace: true })
    await surviving.setOption(optionOver(['shared']), { replace: true })
    expect(stores.datasetStore.getState().getEntry('shared')?.refCount).toBe(2)

    teardownCanvas(closing)

    const entry = stores.datasetStore.getState().getEntry('shared')
    expect(entry?.refCount, 'the torn-down canvas did not give its reference back').toBe(1)
    expect(
      entry?.status,
      'the teardown EVICTED a dataset a second canvas is still rendering. Each holder\'s teardown ' +
        'decrements; only the last one may drop the entry.',
    ).toBe('ready')
    expect(entry?.source, 'the surviving canvas lost the source it resolved').toBe(src)

    // …and the LAST holder's teardown does return the store to zero.
    teardownCanvas(surviving)
    expect(stores.datasetStore.getState().datasets).toEqual({})
  })
})
