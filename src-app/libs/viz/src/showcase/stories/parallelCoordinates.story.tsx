// parallelCoordinates.story.tsx — the showcase story for the PARALLEL-COORDINATES
// EXTENSION (a self-registering chart type added with ZERO core edits). It proves the
// registry capability end-to-end AND the cross-plot coordination both directions:
//
//   • `use(ParallelCoordinatesChart)` registers the type through the PUBLIC installer.
//   • The chart renders over `FixtureSource` (6 value columns → 6 parallel axes, colored
//     by the `group` categorical) — thousands of GPU polylines.
//   • It is LINKED to a `HeatmapView` on the same `FixtureSource` + shared Coordination
//     store: an axis brush on the parallel-coordinates plot (PRODUCE) fans out to light up
//     the heatmap's matching group rows, and a selection seeded elsewhere (CONSUME) dims
//     the plot's non-selected polylines.
//
// A headless render harness can't drag a brush, so two deterministic seed buttons stand in:
// "Brush dim 0 (upper half)" runs the SAME pure `idsInAxisBrush` the View's real brush calls
// and publishes the result (proving PRODUCE → fan-out with no pointer), and "Select cluster
// 0" seeds a group-0 point selection (proving CONSUME dims the plot). The
// `window.__VIZ_TEST__.pointSelectionLength` hook exposes that the fan-out fired.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { HeatmapView } from '../../viz-core/charts/HeatmapView'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { densify } from '../../viz-core/data/wire'
import {
  ParallelCoordinatesView,
  ParallelCoordinatesChart,
  PARALLEL_COORDINATES_ORIGIN,
} from '../../extensions/parallel-coordinates/parallelCoordinates'
import {
  columnExtent,
  idsInAxisBrush,
} from '../../extensions/parallel-coordinates/parallelCoordinatesModel'
import { use } from '../../viz-core/extension'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { createCoordinationHandle } from '../../adapter/coordinationHandle'
import { registerStory } from '../registry'

// Register the extension through the PUBLIC installer — this is the capability proof: the
// chart type becomes available with no edit to installBuiltins / the registry / the core.
use(ParallelCoordinatesChart)

const GROUP_KEY = 'group'
/** Six of the fixture's value columns → six parallel value axes. */
const DIMENSIONS = ['Feature A', 'Feature B', 'Feature C', 'Feature D', 'Feature E', 'Feature F']
/** A modest cap so the story is snappy while still drawing thousands of polylines. */
const POINT_LIMIT = 4000

function ParallelCoordinatesStory() {
  // ISOLATED store set + coordination handle, NOT the module singletons (see
  // `00-capabilities.story.tsx`). A story that writes the singleton coordination store leaves that
  // write visible to every story mounted after it in the SAME page load. The standalone chart Views
  // below default to `defaultCoordinationHandle`, so isolating the set is only half of it — each
  // View is also handed THIS set's handle. `tests/viz-e2e/story-isolation.spec.ts` walks every
  // story and fails if any of them moves the process-global stores.
  const stores = useMemo(() => createVizStores(), [])
  const coordination = useMemo(() => createCoordinationHandle(stores), [stores])
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: POINT_LIMIT }), [])
  const [groupCodes, setGroupCodes] = useState<Uint16Array | null>(null)
  const [dim0, setDim0] = useState<Float32Array | null>(null)

  const pointSelection = useStore(stores.coordination, s => s.pointSelection)
  const selectionLength = pointSelection?.length ?? 0

  useEffect(() => {
    let alive = true
    void (async () => {
      const grp = await source.categorical(GROUP_KEY)
      const col = await source.valueColumn(DIMENSIONS[0])
      if (!alive) return
      setGroupCodes(grp.codes)
      setDim0(densify(col))
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Clear on unmount. With the isolated set above this is no longer CROSS-STORY hygiene (the set
  // dies with the story); it just resets this story's own state between its StrictMode mounts.
  useEffect(() => () => stores.coordination.getState().clearSelection(), [])

  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), pointSelectionLength: selectionLength }
  }, [selectionLength])

  // PRODUCE (deterministic): run the SAME pure axis-brush the View uses — select points whose
  // dimension-0 value is in the upper half [0.5,1] of that axis — and publish it. The linked
  // heatmap's covered group rows light up with no pointer interaction.
  const brushDim0 = () => {
    if (!dim0) return
    const count = Math.min(POINT_LIMIT, dim0.length)
    const ids = idsInAxisBrush(dim0, columnExtent(dim0, count), 0.5, 1, count)
    stores.coordination.getState().setSelection(PARALLEL_COORDINATES_ORIGIN, ids)
  }

  // CONSUME (deterministic): seed a group-0 point selection — the plot's group-0 polylines
  // stay full-strength while every other line dims.
  const selectCluster0 = () => {
    if (!groupCodes) return
    const idx: number[] = []
    for (let i = 0; i < groupCodes.length; i++) if (groupCodes[i] === 0) idx.push(i)
    stores.coordination.getState().setSelection('parallel-coordinates-seed', Uint32Array.from(idx))
  }

  const clear = () => stores.coordination.getState().clearSelection()

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-parallel-coordinates"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <div
          style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}
        >
          <button
            type="button"
            data-testid="viz-parallel-coordinates-brush-seed"
            onClick={brushDim0}
            disabled={!dim0}
          >
            Brush dim 0 (upper half)
          </button>
          <button
            type="button"
            data-testid="viz-parallel-coordinates-consume-seed"
            onClick={selectCluster0}
            disabled={!groupCodes}
          >
            Select cluster 0
          </button>
          <button type="button" data-testid="viz-parallel-coordinates-clear" onClick={clear}>
            Clear
          </button>
          <span data-testid="viz-parallel-coordinates-readout" style={{ opacity: 0.75 }}>
            Shared selection: {selectionLength.toLocaleString()} points
          </span>
          <span style={{ opacity: 0.55 }}>
            Drag a range on any axis (left) — or hit <b>Brush dim 0</b> — and watch the linked
            heatmap group rows (right) light up.
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div
            data-testid="viz-parallel-coordinates-source"
            style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(128,128,128,0.3)' }}
          >
            <ParallelCoordinatesView
              source={source}
              dimensions={DIMENSIONS}
              groupKey={GROUP_KEY}
              pointLimit={POINT_LIMIT}
            />
          </div>
          <div data-testid="viz-parallel-coordinates-reader" style={{ flex: 1, minWidth: 0 }}>
            <HeatmapView coordination={coordination} source={source} valueKeys={DIMENSIONS} groupKey={GROUP_KEY} />
          </div>
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'viz-parallel-coordinates',
  category: 'Selection',
  title: 'Parallel coordinates (extension) — axis-brush selection → linked heatmap fan-out',
  covers: 'parallel-coordinates',
  Component: ParallelCoordinatesStory,
})
