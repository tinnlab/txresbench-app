// PlotInteraction.store.test.ts — the lifted dataZoom-window + filter store (SESSION_STATE_PLAN
// Phase 2). Proves set/clear for both maps, per-id isolation, and serialize→hydrate round-trip.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createPlotInteractionStore,
  usePlotInteractionStore,
} from './PlotInteraction.store'

const store = usePlotInteractionStore

describe('PlotInteraction.store — dataZoom windows + filters', () => {
  beforeEach(() => {
    store.getState().reset()
  })

  it('sets + clears a dataZoom window keyed by plot id', () => {
    store.getState().setDataZoomWindow('plot-a', { lo: 1, hi: 5 })
    expect(store.getState().dataZoomWindows['plot-a']).toEqual({ lo: 1, hi: 5 })
    store.getState().clearDataZoomWindow('plot-a')
    expect(store.getState().dataZoomWindows['plot-a']).toBeUndefined()
  })

  it('sets + clears a filter range keyed by plot id', () => {
    store.getState().setFilter('plot-b', [0.2, 0.8])
    expect(store.getState().filters['plot-b']).toEqual([0.2, 0.8])
    store.getState().clearFilter('plot-b')
    expect(store.getState().filters['plot-b']).toBeUndefined()
  })

  it('keeps windows/filters isolated per id (no cross-plot bleed)', () => {
    store.getState().setDataZoomWindow('plot-a', { lo: 1, hi: 2 })
    store.getState().setDataZoomWindow('plot-b', { row0: 0, row1: 3, col0: 0, col1: 4 })
    store.getState().setFilter('plot-a', [0, 1])
    expect(store.getState().dataZoomWindows['plot-a']).toEqual({ lo: 1, hi: 2 })
    expect(store.getState().dataZoomWindows['plot-b']).toEqual({ row0: 0, row1: 3, col0: 0, col1: 4 })
    expect(store.getState().filters['plot-b']).toBeUndefined()
  })

  it('serialize → hydrate round-trips both maps and detaches the snapshot', () => {
    store.getState().setDataZoomWindow('plot-a', { lo: 1, hi: 5 })
    store.getState().setFilter('plot-a', [0.1, 0.9])
    const snap = store.getState().serialize()

    // mutate live state — snapshot must not change
    store.getState().setDataZoomWindow('plot-a', { lo: 9, hi: 9 })
    expect(snap.dataZoomWindows['plot-a']).toEqual({ lo: 1, hi: 5 })

    store.getState().reset()
    expect(store.getState().dataZoomWindows['plot-a']).toBeUndefined()

    store.getState().hydrate(snap)
    expect(store.getState().dataZoomWindows['plot-a']).toEqual({ lo: 1, hi: 5 })
    expect(store.getState().filters['plot-a']).toEqual([0.1, 0.9])
  })

  it('hydrate tolerates a partial slice (missing map → empty)', () => {
    store.getState().hydrate({ filters: { p: [0, 1] } })
    expect(store.getState().filters['p']).toEqual([0, 1])
    expect(store.getState().dataZoomWindows).toEqual({})
  })

  // ITEM-21 / DEC-13 ("two homes" fix): this store is the SINGLE, authoritative serialize source for
  // dataZoom windows + filters (the VizController Map must defer to it). Prove both a value-axis band
  // AND a matrix window round-trip together through one isolated store instance (the factory path),
  // independent of any controller Map.
  it('is the single serialize source: both window shapes + filters round-trip in an isolated store', () => {
    const s = createPlotInteractionStore()
    s.getState().setDataZoomWindow('band-plot', { lo: 2, hi: 8 }) // value-axis band
    s.getState().setDataZoomWindow('matrix-plot', { row0: 1, row1: 4, col0: 2, col1: 6 }) // matrix range
    s.getState().setFilter('band-plot', [0.25, 0.75])
    const snap = s.getState().serialize()

    const fresh = createPlotInteractionStore()
    fresh.getState().hydrate(snap)
    expect(fresh.getState().dataZoomWindows['band-plot']).toEqual({ lo: 2, hi: 8 })
    expect(fresh.getState().dataZoomWindows['matrix-plot']).toEqual({
      row0: 1,
      row1: 4,
      col0: 2,
      col1: 6,
    })
    expect(fresh.getState().filters['band-plot']).toEqual([0.25, 0.75])
  })
})
