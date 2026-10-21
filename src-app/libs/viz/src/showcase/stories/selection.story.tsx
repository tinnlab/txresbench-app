// selection.story.tsx — the multi-area selection showcase (DEC-24/25/36). Renders a
// `SelectableScatter` over the fixture so a human can draw MULTIPLE rectangle/polygon
// areas (add / subtract / intersect), watch the live selected-count, and see the GPU
// highlight (selected bright, rest dimmed via the DataFilterExtension overlay).

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { SelectableScatter } from '../../viz-core/selection/SelectableScatter'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import type { IndexMask } from '../../viz-core/data/selection'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { registerStory } from '../registry'

/** The coordination cell id this demo's selection ORIGINATES from (DEC-25). */
const SELECTION_CELL = 'selection-demo'

function SelectionStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). A story that
  // writes the singleton coordination store leaves that write visible to every story mounted after
  // it in the SAME page load. This story wires every view EXPLICITLY (`selection` /
  // `onSelectColumns` / `highlightMask` props), so no view falls back to `defaultCoordinationHandle`
  // and the set alone is sufficient. `tests/viz-e2e/story-isolation.spec.ts` walks every story and
  // fails if any of them moves the process-global stores.
  const stores = useMemo(() => createVizStores(), [])
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 120_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [lastCount, setLastCount] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.catalog()
      const pos = await source.positions('primary')
      const c = await computeColoring(source, {
        mode: 'categorical',
        key: 'group',
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setCatalog(cat)
      setPositions(pos.positions)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
    })()
    return () => {
      alive = false
    }
  }, [source])

  const handleSelection = (mask: IndexMask) => {
    const count = mask.count()
    setLastCount(count)
    // Fan the selection out through the Coordination store (DEC-25 / ITEM-25): this is
    // the WRITE producer — a real selection now lands in `pointSelection`, so every
    // read-site (grid cells, heatmap group-row band) lights up. Clear on an empty mask.
    const store = stores.coordination.getState()
    if (count > 0) store.setSelection(SELECTION_CELL, mask.toIndices())
    else store.clearSelection()
    // expose to the test-hook inspector (DEC-36)
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), selectionCount: count }
  }

  // Clear the shared selection when this story unmounts so it doesn't bleed into
  // another story that reads `pointSelection`.
  useEffect(() => () => stores.coordination.getState().clearSelection(), [])

  return (
    <VizStoresProvider value={stores}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: 8, opacity: 0.7, fontSize: 13 }}>
          Pick <b>Rectangle</b> or <b>Polygon</b> + a combine <b>mode</b> (add / subtract / intersect), then draw
          areas over the plot. Polygon: click to drop vertices, then <b>Finish polygon</b>.{' '}
          {catalog ? `${catalog.pointCount.toLocaleString()} points · ${lastCount.toLocaleString()} selected` : 'loading…'}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {positions && colors ? (
            <SelectableScatter
              positions={positions}
              colors={colors}
              totalPoints={catalog?.pointCount ?? positions.length / 2}
              colorEpoch={colorEpoch}
              onSelectionChange={handleSelection}
            />
          ) : (
            <div style={{ padding: 16 }}>Loading fixture…</div>
          )}
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'selection-multi-area',
  category: 'Selection',
  title: 'Multi-area selection — rect + polygon, add/subtract/intersect, GPU highlight',
  covers: 'selection',
  Component: SelectionStory,
})
