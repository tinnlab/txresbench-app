// VizController.dispose.test.ts — G2: a torn-down controller must RELEASE the dataset refs it holds.
// The only release site used to be `applyOption`'s previous-ids sweep, which runs on the NEXT
// `setOption` — and for an abandoned controller that next `setOption` never comes, so its last
// option's entries stayed pinned in the (shared, long-lived) DatasetStore for the life of the page.
import { describe, it, expect, vi } from 'vitest'
import { VizController } from './VizController'
import { createVizStores } from './vizStores'
import { FixtureSource } from '../viz-core/data/fixtures'
import { installBuiltins } from '../viz-core/charts/installBuiltins'
import type { VizOption } from '../viz-core/option/types'

installBuiltins()

const OPTION: VizOption = {
  datasets: [{ id: 'A' }, { id: 'B' }],
  grid: [
    { id: 'p1', region: { col: 0 } },
    { id: 'p2', region: { col: 1 } },
  ],
  series: [
    { id: 's1', type: 'scatter', coordId: 'p1', datasetId: 'A', encode: { layout: 'primary' } },
    { id: 's2', type: 'scatter', coordId: 'p2', datasetId: 'B', encode: { layout: 'primary' } },
  ],
}

const oneDataset = (id: string): VizOption => ({
  datasets: [{ id }],
  grid: [{ id: 'p1', region: { col: 0 } }],
  series: [{ id: 's1', type: 'scatter', coordId: 'p1', datasetId: id, encode: { layout: 'primary' } }],
})

describe('VizController.dispose — dataset refs are released on teardown (G2)', () => {
  it('a disposed controller leaves ZERO retained entries in the store it shared', async () => {
    // The store set OUTLIVES the controller — the module-singleton situation, modelled.
    const stores = createVizStores()
    const controller = new VizController({
      resolveDataset: (id: string) => new FixtureSource({ seed: id.charCodeAt(0), pointCount: 200 }),
      stores,
    })
    await controller.setOption(OPTION, { replace: true })
    expect(Object.keys(stores.datasetStore.getState().datasets).sort()).toEqual(['A', 'B'])

    controller.dispose()

    expect(stores.datasetStore.getState().datasets).toEqual({})
  })

  it('dispose DECREMENTS, it does not EVICT — a second live controller keeps its dataset', async () => {
    const stores = createVizStores()
    const src = new FixtureSource({ seed: 5, pointCount: 300 })
    const mk = () => new VizController({ resolveDataset: () => src, stores })
    const first = mk()
    const second = mk()
    await first.setOption(oneDataset('shared'), { replace: true })
    await second.setOption(oneDataset('shared'), { replace: true })
    expect(stores.datasetStore.getState().getEntry('shared')?.refCount).toBe(2)

    first.dispose()

    // The pane the SECOND controller is still rendering must keep its resolved source + catalog.
    const entry = stores.datasetStore.getState().getEntry('shared')
    expect(entry?.refCount).toBe(1)
    expect(entry?.status).toBe('ready')
    expect(entry?.source).toBe(src)
    expect(second.getSource()).toBe(src)

    // …and the LAST holder's teardown does return the store to zero.
    second.dispose()
    expect(stores.datasetStore.getState().datasets).toEqual({})
  })

  it('dispose is IDEMPOTENT — a double teardown cannot steal another holder’s ref', async () => {
    const stores = createVizStores()
    const src = new FixtureSource({ seed: 6, pointCount: 150 })
    const a = new VizController({ resolveDataset: () => src, stores })
    const b = new VizController({ resolveDataset: () => src, stores })
    await a.setOption(oneDataset('shared'), { replace: true })
    await b.setOption(oneDataset('shared'), { replace: true })

    a.dispose()
    a.dispose()
    a.dispose()

    expect(stores.datasetStore.getState().getEntry('shared')?.refCount).toBe(1)
    expect(stores.datasetStore.getState().getEntry('shared')?.status).toBe('ready')
  })

  it('a setOption still in flight at dispose does not re-pin the store afterwards', async () => {
    const stores = createVizStores()
    let release: () => void = () => {}
    const src = new FixtureSource({ seed: 8, pointCount: 100 })
    const controller = new VizController({
      stores,
      resolveDataset: () =>
        new Promise<FixtureSource>(res => {
          release = () => res(src)
        }),
    })

    const pending = controller.setOption(oneDataset('late'), { replace: true })
    controller.dispose()
    release()
    await pending

    expect(stores.datasetStore.getState().datasets).toEqual({})
  })

  it('dispose also drops the controller’s store subscriptions (no post-teardown fan-out)', async () => {
    const stores = createVizStores()
    const controller = new VizController({
      resolveDataset: () => new FixtureSource({ seed: 9, pointCount: 100 }),
      stores,
    })
    await controller.setOption(oneDataset('A'), { replace: true })
    const onSelect = vi.fn()
    const onChange = vi.fn()
    controller.on('select', onSelect)
    controller.subscribe(onChange)

    controller.dispose()
    stores.coordination.getState().setSelection('p1', Uint32Array.from([1, 2, 3]))

    expect(onSelect).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})
