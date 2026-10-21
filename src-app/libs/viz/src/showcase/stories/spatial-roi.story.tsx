// spatial-roi.story.tsx — the SPATIAL → ANALYSIS linked demo (the feature that turns a viewer
// into an analysis tool). LEFT: a `RasterUnderlayScatterView` — points at PHYSICAL coords over a tissue
// image; lasso a region and it WRITES the points inside into the shared Coordination store + shows
// the region's cell-type COMPOSITION. RIGHT: a `DeckScatterCanvas` of the SAME points at UMAP
// EMBEDDING coords, reading the SAME `pointSelection` → the lassoed tissue cells light up in the
// embedding. One `RegionSelectFixtureSource` backs both layouts, so the two share ONE index space.
//
// A headless render harness can't drag a lasso, so a "Select Domain 1" button seeds a deterministic
// region (every point in group 0) straight through the same store path — the linked highlight +
// composition fire with no pointer interaction, and `window.__VIZ_TEST__` exposes both.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { RasterUnderlayScatterView, REGION_SELECT_SOURCE } from '../../viz-core/spatial/RasterUnderlayScatterView'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { regionComposition, type RegionComposition } from '../../viz-core/spatial/regionSelect'
import {
  hasAnySelection,
  highlightMaskForPoints,
} from '../../viz-core/coordination/selectionSync'
import { computeColoring } from '../../viz-core/data/engine'
import { RegionSelectFixtureSource } from './regionSelectFixture'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { createCoordinationHandle } from '../../adapter/coordinationHandle'
import { registerStory } from '../registry'

const GROUP_KEY = 'group'

function SpatialRoiStory() {
  // ISOLATED store set + coordination handle, NOT the module singletons (see
  // `00-capabilities.story.tsx`). A story that writes the singleton coordination store leaves that
  // write visible to every story mounted after it in the SAME page load. The standalone chart Views
  // below default to `defaultCoordinationHandle`, so isolating the set is only half of it — each
  // View is also handed THIS set's handle. `tests/viz-e2e/story-isolation.spec.ts` walks every
  // story and fails if any of them moves the process-global stores.
  const stores = useMemo(() => createVizStores(), [])
  const coordination = useMemo(() => createCoordinationHandle(stores), [stores])
  const source = useMemo(
    () => new RegionSelectFixtureSource({ seed: 7, pointCount: 8000, groupCount: 6 }),
    [],
  )
  const [spatialPos, setSpatialPos] = useState<Float32Array | null>(null)
  const [embeddingPos, setEmbeddingPos] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [groupCodes, setGroupCodes] = useState<Uint16Array | null>(null)
  const [categories, setCategories] = useState<readonly string[]>([])
  const [underlay, setUnderlay] = useState<{ data: Uint8Array; width: number; height: number } | null>(
    null,
  )
  const [affine, setAffine] = useState<readonly [number, number, number, number, number, number]>()
  const [colorEpoch, setColorEpoch] = useState(0)
  const [composition, setComposition] = useState<RegionComposition | null>(null)

  // Reactive read of the SHARED selection — proves the fan-out reached the store and drives the
  // embedding highlight + the readout + the test hook.
  const pointSelection = useStore(stores.coordination, s => s.pointSelection)
  const selectionLength = pointSelection?.length ?? 0

  useEffect(() => {
    let alive = true
    void (async () => {
      const sp = await source.positions('spatial')
      const emb = await source.positions('primary')
      const grp = await source.categorical(GROUP_KEY)
      const img = await source.imageUnderlay()
      const c = await computeColoring(source, {
        mode: 'categorical',
        key: GROUP_KEY,
        colormap: 'viridis',
        scale: 'linear',
        hidden: new Set(),
      })
      if (!alive) return
      setSpatialPos(sp.positions)
      setEmbeddingPos(emb.positions)
      setGroupCodes(grp.codes)
      setCategories(grp.categories)
      setUnderlay({ data: img.data, width: img.width, height: img.height })
      setAffine(img.affine)
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

  // Embedding-reader highlight: the shared pointSelection → a per-point 0/1 mask fed to the
  // scatter's in-shader emphasis. Rebuilt only when the selection changes.
  const n = embeddingPos ? embeddingPos.length / 2 : 0
  const highlightMask = useMemo(
    () => (pointSelection && n ? highlightMaskForPoints(pointSelection, n) : null),
    [pointSelection, n],
  )
  const [selEpoch, setSelEpoch] = useState(0)
  useEffect(() => setSelEpoch(e => e + 1), [pointSelection])

  // Expose the shared-selection length + composition so a render/e2e check can assert the bridge
  // fired (lasso WROTE, store HOLDS, embedding READS, composition computed).
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      roiSelectionLength: selectionLength,
      composition: composition
        ? { total: composition.total, entries: composition.entries.map(e => ({ category: e.category, count: e.count })) }
        : null,
    }
  }, [selectionLength, composition])

  // Deterministic seed for a headless harness (no lasso): select EVERY point in group code 0 via
  // the SAME store path the lasso uses, and compute its composition.
  const selectDomain0 = () => {
    if (!groupCodes) return
    const idx: number[] = []
    for (let i = 0; i < groupCodes.length; i++) if (groupCodes[i] === 0) idx.push(i)
    const indices = Uint32Array.from(idx)
    setComposition(regionComposition(indices, groupCodes, categories))
    stores.coordination.getState().setSelection(REGION_SELECT_SOURCE, indices)
  }

  const clear = () => {
    setComposition(null)
    stores.coordination.getState().clearSelection()
  }

  const ready = spatialPos && embeddingPos && colors && groupCodes && underlay

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-spatial-roi"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        <div
          style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}
        >
          <button
            type="button"
            data-testid="viz-spatial-roi-seed"
            onClick={selectDomain0}
            disabled={!groupCodes}
          >
            Select Domain 1
          </button>
          <button type="button" data-testid="viz-spatial-roi-clear" onClick={clear}>
            Clear
          </button>
          <span data-testid="viz-spatial-roi-readout" style={{ opacity: 0.75 }}>
            Shared selection: {selectionLength.toLocaleString()} points
          </span>
          <span style={{ opacity: 0.55 }}>
            Lasso a tissue region (left) — or hit <b>Select Domain 1</b> — and watch the same cells
            light up in the UMAP embedding (right) + the region composition update.
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div
            data-testid="viz-spatial-roi-tissue"
            style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(128,128,128,0.3)' }}
          >
            {ready ? (
              <RasterUnderlayScatterView
                coordination={coordination}
                positions={spatialPos}
                colors={colors}
                totalPoints={n}
                underlay={underlay}
                affine={affine}
                groupCodes={groupCodes}
                categories={categories}
                colorEpoch={colorEpoch}
                sourceId={REGION_SELECT_SOURCE}
                onRegionSelected={(_indices, comp) => setComposition(comp)}
              />
            ) : (
              <div style={{ padding: 16 }}>Loading fixture…</div>
            )}
          </div>
          <div data-testid="viz-spatial-roi-embedding" style={{ flex: 1, minWidth: 0, position: 'relative' }}>
            {ready ? (
              <DeckScatterCanvas
                positions={embeddingPos}
                colors={colors}
                radius={3}
                colorEpoch={colorEpoch}
                highlightMask={highlightMask}
                selectionActive={hasAnySelection(pointSelection)}
                selectionEpoch={selEpoch}
              />
            ) : (
              <div style={{ padding: 16 }}>Loading fixture…</div>
            )}
          </div>
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'spatial-roi-linked',
  category: 'Selection',
  title: 'Spatial ROI → analysis — lasso a tissue region → linked embedding highlight + composition',
  covers: 'spatial-roi',
  Component: SpatialRoiStory,
})
