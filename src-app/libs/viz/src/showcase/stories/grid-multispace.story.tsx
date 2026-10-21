// grid-multispace.story.tsx — link-zoom SCOPED BY COORDINATE SPACE (the
// embedding-blind-zoom fix). Seeds a top row of THREE dense cells:
// [scatter | scatter | image]. The two scatters share ONE coordinate space (same
// `embedding:primary` layout) so they zoom-sync when link is ON; the image cell lives
// in its OWN space (`image:primary`, pixel/physical coords) so it NEVER zoom-syncs with
// the scatters. Selection stays GLOBAL — a lasso in any cell fans to all three
// regardless of space.
//
// Exposes per-space shared zoom on `window.__VIZ_TEST__` (`scatterSpaceZoom` /
// `imageSpaceZoom`) so an e2e can assert that wheeling a scatter moves the OTHER scatter
// (same space) but leaves the image's space untouched, and that selection still fans to
// all three. Read-only mirror; no product effect.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { gridScopeId } from '../../adapter/Coordination.store'
import { cellSpaceKey } from '../../viz-core/grid/gridModel'
import { createVizStores, VizStoresProvider, type VizStores } from '../../adapter/vizStores'
import { registerStory } from '../registry'

/** The two coordinate spaces in this grid (both over the `primary` layout). The two
 *  scatters share the embedding space; the image cell has its own image space. */
const SCATTER_SPACE = cellSpaceKey({ kind: 'scatter', layoutId: 'primary' })
const IMAGE_SPACE = cellSpaceKey({ kind: 'image', layoutId: 'primary' })

/** Seed the multi-space layout: top row [scatter | scatter | image]. Returns after
 *  mutating the store. The two scatters color by the same continuous column (linked
 *  scale) so they read as coordinated small multiples in ONE embedding space. */
function seedMultiSpaceLayout(stores: VizStores) {
  const s = stores.gridWorkspace.getState()
  s.reset() // → cell-1 (scatter, the embedding anchor)
  const c2 = s.splitCell(INITIAL_CELL_ID, 'col') // [cell-1 | c2]
  const c3 = s.splitCell(c2, 'col') // [cell-1 | c2 | c3]
  // c3 is the IMAGE cell — a different coordinate space (tissue/pixel coords).
  s.setCellKind(c3, 'image')
  // Both scatters color by the same continuous column, linked → shared color domain
  // (this is a COLOR-scale link; independent of zoom-space linking under test).
  const scatterColorBy = {
    mode: 'continuous' as const,
    key: 'qcA',
    colormap: 'viridis' as const,
    scale: 'linear' as const,
    hidden: new Set<number>(),
  }
  s.setCellColorBy(INITIAL_CELL_ID, scatterColorBy)
  s.setCellColorBy(c2, scatterColorBy)
  s.toggleCellLinkColorScale(INITIAL_CELL_ID)
  s.toggleCellLinkColorScale(c2)
}

function GridMultiSpaceStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). This story
  // seeds grid cells (and, where present, drives the shared selection); on the singletons those
  // writes are process-global and every story mounted later in the SAME page load inherits them.
  // `tests/viz-e2e/story-isolation.spec.ts` is the walk that measures it.
  const stores = useMemo(() => createVizStores(), [])
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 120_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  const cells = useStore(stores.gridWorkspace, s => s.cells)
  const cellCount = Object.keys(cells).length
  const linked = useStore(stores.coordination, s => s.gridLinked)

  // Per-space shared zoom/target, read from the store's SHARDED scopes. The whole
  // point of the fix: these two are INDEPENDENT — wheeling a scatter moves
  // `scatterSpaceZoom` only; the image space stays put.
  const pointSelection = useStore(stores.coordination, s => s.pointSelection)
  const scatterView = useStore(stores.coordination, s => s.viewStates[gridScopeId(SCATTER_SPACE)])
  const imageView = useStore(stores.coordination, s => s.viewStates[gridScopeId(IMAGE_SPACE)])
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      pointSelectionLength: pointSelection?.length ?? 0,
      gridLinked: linked,
      scatterSpaceZoom: scatterView?.zoom ?? null,
      scatterSpaceTargetX: scatterView?.target?.[0] ?? null,
      scatterSpaceTargetY: scatterView?.target?.[1] ?? null,
      imageSpaceZoom: imageView?.zoom ?? null,
      imageSpaceTargetX: imageView?.target?.[0] ?? null,
      imageSpaceTargetY: imageView?.target?.[1] ?? null,
    }
  }, [pointSelection, linked, scatterView, imageView])

  // Clear the shared selection on unmount so a real grid selection doesn't bleed into
  // another story that reads `pointSelection`.
  useEffect(() => () => stores.coordination.getState().clearSelection(), [])

  // Load the fixture once (catalog drives chart bindings; positions/colors feed the deck).
  useEffect(() => {
    let alive = true
    void (async () => {
      const cat = await source.catalog()
      const pos = await source.positions('primary')
      const c = await computeColoring(source, DEFAULT_COLOR_BY)
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

  // Seed the multi-space layout on mount.
  useEffect(() => {
    seedMultiSpaceLayout(stores)
  }, [])

  const reset = () => seedMultiSpaceLayout(stores)

  return (
    <div
      data-testid="viz-grid-multispace"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" data-testid="grid-ms-reset" onClick={reset}>
          Reset
        </button>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            data-testid="grid-ms-link-zoom-toggle"
            checked={linked}
            onChange={e => stores.coordination.getState().setGridLinked(e.target.checked)}
          />
          Link zoom
        </label>
        <span style={{ opacity: 0.6 }}>
          {cellCount} cells — two scatters share ONE embedding space (they zoom-sync when
          linked); the image cell is a DIFFERENT space (never zoom-syncs). Selection fans
          to all three.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {positions && colors && catalog ? (
          <VizStoresProvider value={stores}>
            <GridWorkspace
              positions={positions}
              colors={colors}
              colorEpoch={colorEpoch}
              source={source}
              catalog={catalog}
            />
          </VizStoresProvider>
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
    </div>
  )
}

registerStory({
  id: 'grid-multispace',
  category: 'Grid + resize',
  title: 'Grid — link-zoom scoped by coordinate space (scatter embedding vs image)',
  covers: 'grid',
  Component: GridMultiSpaceStory,
})
