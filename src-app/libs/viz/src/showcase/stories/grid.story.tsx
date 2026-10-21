// grid.story.tsx — the free-form resizable HETEROGENEOUS GRID story (DEC-19/20/21 /
// ITEM-12 / Phase C1). Seeds the goal layout — row 1 = [scatter | violin | heatmap],
// row 2 = [box | bar] — so DENSE cells (scatter) render into the ONE shared Deck
// (single WebGL context, N OrthographicViews) while CHART cells (violin/box/bar/heatmap)
// each render their OWN ChartCanvas in the content overlay at the pane's rect. A human
// drags the dividers; every cell now carries its OWN chrome pill (Phase C2) in its
// top-right — a view-kind switcher (dense ↔ chart), split, and remove — so the
// former top-toolbar per-cell <select> is gone. Exercises the heterogeneous
// GridWorkspace + per-cell chrome end-to-end.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import { DEFAULT_COLOR_BY } from '../../viz-core/data/engine'
import type { DatasetCatalog, GraphData } from '../../viz-core/data/wire'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { gridScopeId } from '../../adapter/Coordination.store'
import { cellSpaceKey } from '../../viz-core/grid/gridModel'
import { createVizStores, VizStoresProvider, type VizStores } from '../../adapter/vizStores'
import { registerStory } from '../registry'

/** Seed the goal heterogeneous layout: top row [scatter | scatter | violin | heatmap],
 *  bottom row [box | bar]. The TWO scatter cells (C3b) both color by the SAME
 *  continuous column and opt into the linked color scale, so their per-cell color
 *  buffers share ONE domain (identical values → identical colors). Returns after
 *  mutating the store. */
function seedHeterogeneousLayout(stores: VizStores) {
  const s = stores.gridWorkspace.getState()
  s.reset() // → cell-1 (scatter, the dense anchor)
  const c2 = s.splitCell(INITIAL_CELL_ID, 'row') // full-width cell below → 2 rows
  const c3 = s.splitCell(INITIAL_CELL_ID, 'col') // top row → [cell-1 | c3]
  const c4 = s.splitCell(c3, 'col') // top row → [cell-1 | c3 | c4]
  const c5 = s.splitCell(c2, 'col') // bottom row → [c2 | c5]
  // C3b: split the scatter anchor into a SECOND scatter cell so the link-scale toggle
  // is observable (two dense cells coloring by the same column).
  const c6 = s.splitCell(INITIAL_CELL_ID, 'col') // top row → [cell-1 | c6 | c3 | c4]
  s.setCellKind(c3, 'violin')
  s.setCellKind(c4, 'heatmap')
  s.setCellKind(c2, 'box')
  s.setCellKind(c5, 'bar')
  // Both scatter cells color by the same continuous column, linked → shared domain.
  const scatterColorBy = {
    mode: 'continuous' as const,
    key: 'qcA',
    colormap: 'viridis' as const,
    scale: 'linear' as const,
    hidden: new Set<number>(),
  }
  s.setCellColorBy(INITIAL_CELL_ID, scatterColorBy)
  s.setCellColorBy(c6, scatterColorBy)
  s.toggleCellLinkColorScale(INITIAL_CELL_ID)
  s.toggleCellLinkColorScale(c6)
}

function GridStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). This story
  // seeds grid cells (and, where present, drives the shared selection); on the singletons those
  // writes are process-global and every story mounted later in the SAME page load inherits them.
  // `tests/viz-e2e/story-isolation.spec.ts` is the walk that measures it.
  const stores = useMemo(() => createVizStores(), [])
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 150_000 }), [])
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  // Phase C3c: group codes + node-link graph + category labels for the per-cell
  // graph-overlay toggle (only a dense/scatter cell can turn it on).
  const [codes, setCodes] = useState<Uint16Array | null>(null)
  const [graph, setGraph] = useState<GraphData | null>(null)
  const [categories, setCategories] = useState<readonly string[] | null>(null)

  const cells = useStore(stores.gridWorkspace, s => s.cells)
  const cellCount = Object.keys(cells).length
  const linked = useStore(stores.coordination, s => s.gridLinked)

  // ── Minimal e2e observation hook (additive, no product effect) ──────────────
  // The heterogeneous grid's REAL selection tool writes into the shared Coordination
  // store, and link-zoom writes a per-coordinate-space shared view state. Neither is
  // otherwise observable from outside viz-core, so mirror both onto `window.__VIZ_TEST__`
  // for the grid-driven specs (selection-sync real-lasso path → `pointSelectionLength`;
  // linked-panels coordination → `gridSharedZoom`/`gridSharedTarget*`). Every dense cell
  // here is a scatter over the `primary` layout, so they all share ONE coordinate space;
  // `gridSharedZoom` reads THAT space's sharded scope (the state the linked cells sync on).
  const pointSelection = useStore(stores.coordination, s => s.pointSelection)
  const scatterSpace = cellSpaceKey({ kind: 'scatter', layoutId: 'primary' })
  const gridSharedView = useStore(stores.coordination, s => s.viewStates[gridScopeId(scatterSpace)])
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      pointSelectionLength: pointSelection?.length ?? 0,
      gridSharedZoom: gridSharedView?.zoom ?? null,
      gridSharedTargetX: gridSharedView?.target?.[0] ?? null,
      gridSharedTargetY: gridSharedView?.target?.[1] ?? null,
      gridLinked: linked,
    }
  }, [pointSelection, gridSharedView, linked])

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
      const grp = await source.categorical('group')
      const g = await source.graph('primary')
      if (!alive) return
      setCatalog(cat)
      setPositions(pos.positions)
      setColors(c.colors)
      setColorEpoch(e => e + 1)
      setCodes(grp.codes)
      setCategories(grp.categories)
      setGraph(g)
    })()
    return () => {
      alive = false
    }
  }, [source])

  // Seed the goal heterogeneous layout on mount.
  useEffect(() => {
    seedHeterogeneousLayout(stores)
  }, [])

  const addCol = () => stores.gridWorkspace.getState().addCell('col')
  const addRow = () => stores.gridWorkspace.getState().addCell('row')
  const reset = () => seedHeterogeneousLayout(stores)

  return (
    <div
      data-testid="viz-grid-heterogeneous"
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      <div style={{ padding: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" data-testid="grid-add-col" onClick={addCol}>
          Add cell →
        </button>
        <button type="button" data-testid="grid-add-row" onClick={addRow}>
          Add cell ↓
        </button>
        <button type="button" data-testid="grid-reset" onClick={reset}>
          Reset
        </button>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            data-testid="grid-link-zoom-toggle"
            checked={linked}
            onChange={e => stores.coordination.getState().setGridLinked(e.target.checked)}
          />
          Link zoom
        </label>
        <span style={{ opacity: 0.6 }}>
          {cellCount} cells — drag the dividers · {linked ? 'cells zoom together' : 'cells zoom independently'}
        </span>
      </div>
      {/* Phase C2/C3a: the per-cell kind flipper moved INTO each cell's own chrome pill
          (top-right of every cell) — switch kind, split, remove, and ⧉ pop the cell out
          into its own synced window right on the cell. */}
      <div style={{ padding: '0 8px 8px', fontSize: 12, opacity: 0.6 }}>
        Each cell has its own chrome (top-right): switch view-kind · ⊞ split · ✕ remove ·
        ⧉ pop out (opens the cell in its own window; the pane is reserved and restores on
        return / close). A scatter (dense) cell also gets a per-cell color-by picker, a ⚖
        link-scale toggle, and a ⧟ graph-overlay toggle. The two scatter cells here color
        by the SAME continuous column (qcA) with ⚖ ON, so they share ONE color domain —
        identical values map to identical colors across both. Toggle ⚖ off on a cell and
        it auto-scales to its own domain independently. The ⧟ toggle draws the node-link
        graph over that cell's embedding (it rides the cell's own pan/zoom on the shared
        deck; no other cell is affected). Drag a cell by its ⠿ grip (left of the
        chrome pill) and drop it onto another cell to SWAP their contents — the two
        cells trade what they display while keeping their positions and the divider
        sizes (the split-tree is never restructured).
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
              codes={codes ?? undefined}
              graph={graph ?? undefined}
              categories={categories ?? undefined}
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
  id: 'grid-nonuniform',
  category: 'Grid + resize',
  title: 'Grid — heterogeneous cells (dense scatter + charts) with resizable dividers',
  covers: 'grid',
  Component: GridStory,
})
