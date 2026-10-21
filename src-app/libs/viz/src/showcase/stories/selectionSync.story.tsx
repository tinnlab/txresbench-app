// selectionSync.story.tsx — the CROSS-PLOT selection fan-out demo (DEC-25 / ITEM-25).
// This is the story that PROVES the coordination loop end-to-end: a `SelectableScatter`
// (the SOURCE) writes its selection into the shared Coordination store, and a
// `HeatmapView` (the READER, same store, same fixture) lights up the GROUP ROWS those
// selected points belong to. Draw on the left → the matching heatmap row band glows on
// the right. Both views share ONE `FixtureSource`, so the scatter's dense point indices
// and the heatmap's group codes are the same index space.
//
// A headless render harness can't drag a lasso, so a "Select cluster 0" button seeds a
// deterministic selection (every point whose group code == 0) straight into the store —
// the fan-out then fires with no pointer interaction, and a visible readout + the
// `window.__VIZ_TEST__.pointSelectionLength` hook expose that it fired.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { SelectableScatter } from '../../viz-core/selection/SelectableScatter'
import { HeatmapView } from '../../viz-core/charts/HeatmapView'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import type { IndexMask } from '../../viz-core/data/selection'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { createCoordinationHandle } from '../../adapter/coordinationHandle'
import { registerStory } from '../registry'

/** The coordination cell id the scatter's selection ORIGINATES from (DEC-25). */
const SOURCE_CELL = 'selection-sync-source'
/** The grouping categorical the heatmap rows + the scatter selection share. */
const GROUP_KEY = 'group'
/** A handful of the fixture's value columns → the heatmap's cols. */
const VALUE_KEYS = ['Feature A', 'Feature B', 'Feature C', 'Feature D', 'Feature E']

function SelectionSyncStory() {
  // ISOLATED store set + coordination handle, NOT the module singletons (see
  // `00-capabilities.story.tsx`). A story that writes the singleton coordination store leaves that
  // write visible to every story mounted after it in the SAME page load. The standalone chart Views
  // below default to `defaultCoordinationHandle`, so isolating the set is only half of it — each
  // View is also handed THIS set's handle. `tests/viz-e2e/story-isolation.spec.ts` walks every
  // story and fails if any of them moves the process-global stores.
  const stores = useMemo(() => createVizStores(), [])
  const coordination = useMemo(() => createCoordinationHandle(stores), [stores])
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 40_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [groupCodes, setGroupCodes] = useState<Uint16Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  // Reactive read of the SHARED selection — proves the fan-out reached the store and
  // drives the visible readout + the test hook below.
  const pointSelection = useStore(stores.coordination, s => s.pointSelection)
  const selectionLength = pointSelection?.length ?? 0

  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.catalog()
      const pos = await source.positions('primary')
      const grp = await source.categorical(GROUP_KEY)
      const c = await computeColoring(source, {
        mode: 'categorical',
        key: GROUP_KEY,
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setCatalog(cat)
      setPositions(pos.positions)
      setGroupCodes(grp.codes)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Clear on unmount. With the isolated set above this is no longer CROSS-STORY hygiene (the set
  // dies with the story); it just resets this story's own state between its StrictMode mounts.
  useEffect(() => () => stores.coordination.getState().clearSelection(), [])

  // Expose the current shared-selection length so a render/e2e check can assert the
  // fan-out fired (the scatter WROTE, the store HOLDS it, the heatmap READS it).
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), pointSelectionLength: selectionLength }
  }, [selectionLength])

  // SOURCE → store: every drawn selection lands in `pointSelection` (cleared on empty).
  const handleSelection = (mask: IndexMask) => {
    const store = stores.coordination.getState()
    if (mask.count() > 0) store.setSelection(SOURCE_CELL, mask.toIndices())
    else store.clearSelection()
  }

  // Deterministic seed for a headless harness (no lasso): select EVERY point in group
  // code 0. The heatmap's group-0 row band then lights up with no pointer interaction.
  const selectCluster0 = () => {
    if (!groupCodes) return
    const idx: number[] = []
    for (let i = 0; i < groupCodes.length; i++) if (groupCodes[i] === 0) idx.push(i)
    stores.coordination.getState().setSelection(SOURCE_CELL, Uint32Array.from(idx))
  }

  const clear = () => stores.coordination.getState().clearSelection()

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-selection-sync"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <div
          style={{
            padding: 8,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            fontSize: 13,
          }}
        >
          <button
            type="button"
            data-testid="viz-selection-sync-seed"
            onClick={selectCluster0}
            disabled={!groupCodes}
          >
            Select cluster 0
          </button>
          <button type="button" data-testid="viz-selection-sync-clear" onClick={clear}>
            Clear
          </button>
          <span data-testid="viz-selection-sync-readout" style={{ opacity: 0.75 }}>
            Shared selection: {selectionLength.toLocaleString()} points
          </span>
          <span style={{ opacity: 0.55 }}>
            Draw on the scatter (left) — or hit <b>Select cluster 0</b> — and watch the
            matching heatmap group rows (right) light up.
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div
            data-testid="viz-selection-sync-source"
            style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(128,128,128,0.3)' }}
          >
            {positions && colors && catalog ? (
              <SelectableScatter
                positions={positions}
                colors={colors}
                totalPoints={catalog.pointCount}
                colorEpoch={colorEpoch}
                onSelectionChange={handleSelection}
              />
            ) : (
              <div style={{ padding: 16 }}>Loading fixture…</div>
            )}
          </div>
          <div data-testid="viz-selection-sync-reader" style={{ flex: 1, minWidth: 0 }}>
            <HeatmapView coordination={coordination} source={source} valueKeys={VALUE_KEYS} groupKey={GROUP_KEY} />
          </div>
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'selection-sync-fanout',
  category: 'Selection',
  title: 'Cross-plot selection sync — scatter selection → heatmap group-row fan-out',
  covers: 'selection-sync',
  Component: SelectionSyncStory,
})
