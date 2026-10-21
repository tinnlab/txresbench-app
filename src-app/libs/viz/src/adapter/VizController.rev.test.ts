// VizController.rev.test.ts — G1 at the CONTROLLER seam: `applyOption` must carry each declared
// `VizDataset.rev` through to `DatasetStore.acquire`, so a host that republishes the SAME logical
// dataset id with changed CONTENT gets the new content (the declaration's contract), while the
// same-rev / no-rev republish keeps today's cheap identity reuse (the reason the store exists).
import { describe, it, expect, vi } from 'vitest'
import { VizController } from './VizController'
import { createVizStores } from './vizStores'
import { FixtureSource } from '../viz-core/data/fixtures'
import { installBuiltins } from '../viz-core/charts/installBuiltins'
import type { VizOption } from '../viz-core/option/types'

installBuiltins()

/** One pane bound to the logical dataset `obs`, published at `rev`. */
function optionAt(rev?: string): VizOption {
  return {
    datasets: [rev === undefined ? { id: 'obs' } : { id: 'obs', rev }],
    grid: [{ id: 'p1', region: { col: 0 } }],
    series: [{ id: 's1', type: 'scatter', coordId: 'p1', datasetId: 'obs', encode: { layout: 'primary' } }],
  }
}

describe('VizController — dataset `rev` reaches the store (G1)', () => {
  it('republishing the same id with a NEW rev re-resolves, and the pane reads the NEW content', async () => {
    const stores = createVizStores()
    const first = new FixtureSource({ seed: 1, pointCount: 100 })
    const second = new FixtureSource({ seed: 2, pointCount: 250 })
    const resolveDataset = vi.fn((_id: string) => (resolveDataset.mock.calls.length === 1 ? first : second))
    const controller = new VizController({ resolveDataset, stores })

    await controller.setOption(optionAt('r1'), { replace: true })
    expect(resolveDataset).toHaveBeenCalledTimes(1)
    expect(stores.datasetStore.getState().getEntry('obs')?.catalog?.pointCount).toBe(100)

    // Same logical id, changed content → declared by bumping the rev.
    await controller.setOption(optionAt('r2'), { replace: true })
    expect(resolveDataset).toHaveBeenCalledTimes(2)
    const entry = stores.datasetStore.getState().getEntry('obs')
    expect(entry?.status).toBe('ready')
    expect(entry?.source).toBe(second)
    expect(entry?.catalog?.pointCount).toBe(250) // what the pane renders, not the first build
    expect(controller.getSource()).toBe(second)
    // Still exactly ONE entry + ONE controller ref — a rev bump must not accumulate revisions.
    expect(Object.keys(stores.datasetStore.getState().datasets)).toEqual(['obs'])
    expect(entry?.refCount).toBe(1)
  })

  it('NEGATIVE CONTROL — the SAME rev (and a rev-less option) re-uses, never re-resolving', async () => {
    const stores = createVizStores()
    const source = new FixtureSource({ seed: 1, pointCount: 100 })
    const resolveDataset = vi.fn((_id: string) => source)
    const controller = new VizController({ resolveDataset, stores })

    await controller.setOption(optionAt('r1'), { replace: true })
    await controller.setOption(optionAt('r1'), { replace: true })
    await controller.setOption(optionAt('r1'), { replace: true })
    expect(resolveDataset).toHaveBeenCalledTimes(1)

    // …and an option that expresses NO opinion about content is likewise pure identity reuse.
    await controller.setOption(optionAt(undefined), { replace: true })
    expect(resolveDataset).toHaveBeenCalledTimes(1)
  })

  it('getOption() round-trips a declared rev (and stays rev-less when none was declared)', async () => {
    const stores = createVizStores()
    const controller = new VizController({
      resolveDataset: () => new FixtureSource({ seed: 3, pointCount: 120 }),
      stores,
    })

    await controller.setOption(optionAt(undefined), { replace: true })
    expect(controller.getOption().datasets).toEqual([{ id: 'obs' }])

    await controller.setOption(optionAt('r9'), { replace: true })
    expect(controller.getOption().datasets).toEqual([{ id: 'obs', rev: 'r9' }])
  })
})
