// cellExport.story.tsx — per-cell "export this pane" story (ITEM-47 follow-up). Mounts a
// heterogeneous GridWorkspace (two scatter cells so both are DENSE and share the one deck
// canvas) next to an ExportDialog, wired via `onRequestExportCell` EXACTLY like the app's
// VisualizationPage: clicking a cell's ⤓ export button (in its chrome) sets that cell as
// the export target and opens the dialog scoped to THAT cell's rect. Proves one click →
// dialog open, pane-scoped to the CLICKED cell (not just the active-by-default first one).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { ExportDialog } from '../../viz-core/export/ExportDialog'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY, type ColorBy } from '../../viz-core/data/engine'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import type { Rect } from '../../viz-core/export/cropCanvas'
import type { LegendExportSpec } from '../../viz-core/export/legendMarks'
import { gridDividerMarks } from '../../viz-core/export/gridDividerMarks'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { createVizStores, VizStoresProvider, type VizStores } from '../../adapter/vizStores'
import { registerStory } from '../registry'

/** Seed a two-cell row [cell-1 | cell-2], both scatter (dense) so each owns a deck view
 *  rect the per-cell export can crop to. Returns after mutating the singleton store. */
// Cell-1 CONTINUOUS (qcA → the interactive in-cell VisualMap; drag → filter → export window, WYSIWYG)
// and cell-2 CATEGORICAL (group → the clickable in-cell Legend; toggle a swatch → hide that category
// on screen AND grey it in the export). One story demos both WYSIWYG interactions.
const CONT_COLOR_BY: ColorBy = { mode: 'continuous', key: 'qcA', colormap: 'viridis', scale: 'linear', hidden: new Set<number>() }
const CAT_COLOR_BY: ColorBy = { mode: 'categorical', key: 'group', colormap: 'viridis', scale: 'linear', hidden: new Set<number>() }
function seedTwoCellLayout(stores: VizStores) {
  const s = stores.gridWorkspace.getState()
  s.reset() // → cell-1 (scatter)
  s.splitCell(INITIAL_CELL_ID, 'col') // → [cell-1 | cell-2], both scatter
  // cell-1 → continuous (VisualMap), cell-2 → categorical (clickable Legend).
  Object.keys(stores.gridWorkspace.getState().cells).forEach((id, i) => {
    stores.gridWorkspace.getState().setCellColorBy(id, i === 0 ? CONT_COLOR_BY : CAT_COLOR_BY)
  })
}

function CellExportStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). This story
  // seeds grid cells (and, where present, drives the shared selection); on the singletons those
  // writes are process-global and every story mounted later in the SAME page load inherits them.
  // `tests/viz-e2e/story-isolation.spec.ts` is the walk that measures it.
  const stores = useMemo(() => createVizStores(), [])
  const source = useMemo(() => new FixtureSource({ seed: 42, pointCount: 80_000 }), [])
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)
  const [exportOpen, setExportOpen] = useState(false)
  // The pane the export dialog is scoped to (the clicked ⤓ cell). `getPaneRect()` resolves
  // THIS cell's rect, so a per-cell export targets the clicked pane. Mirrors the app.
  const [exportCellId, setExportCellId] = useState<string | null>(null)
  // The exported cell's colorBy (from the widened onRequestExportCell) + its resolved legend spec,
  // so the exported figure carries the cell's legend (DEC-1 host-side resolution).
  const [exportColorBy, setExportColorBy] = useState<ColorBy | null>(null)
  // The cell's LIVE in-cell visual-map state at export time (WYSIWYG) — folded into the legend spec.
  const [exportVisualMap, setExportVisualMap] = useState<{ range?: [number, number]; hidden?: number[] } | undefined>(undefined)
  const [legendSpec, setLegendSpec] = useState<LegendExportSpec | null>(null)

  const cells = useStore(stores.gridWorkspace, s => s.cells)
  const cellCount = Object.keys(cells).length

  /** The shared deck.gl canvas (first canvas in the workspace), or null before mount. */
  const getDeckCanvas = (): HTMLCanvasElement | null =>
    workspaceRef.current?.querySelector('canvas') ?? null

  /** The export target pane's CSS rect relative to the deck canvas — resolved from the
   *  clicked `exportCellId` (else the first pane). A getter so a resize is reflected. */
  const getPaneRect = (): Rect | null => {
    const root = workspaceRef.current
    const canvas = getDeckCanvas()
    if (!root || !canvas) return null
    const id = exportCellId
    const pane =
      (id &&
        root.querySelector(
          `[data-viz-cell="${typeof CSS !== 'undefined' ? CSS.escape(id) : id}"]`,
        )) ||
      root.querySelector('[data-viz-cell]')
    if (!pane) return null
    const cb = canvas.getBoundingClientRect()
    const pb = (pane as HTMLElement).getBoundingClientRect()
    return { x: pb.left - cb.left, y: pb.top - cb.top, width: pb.width, height: pb.height }
  }

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

  // Resolve the exported cell's legend from ITS colorBy (DEC-1). `computeColoring` yields
  // `.legend` (categorical) / `.colorbar` (continuous) / `.blend.legend2d` (2D) — pick whichever
  // the cell's coloring produced. The two cells here share DEFAULT_COLOR_BY (categorical 'group').
  useEffect(() => {
    let alive = true
    const cb = exportColorBy ?? DEFAULT_COLOR_BY
    void computeColoring(source, cb).then(col => {
      if (!alive) return
      // Fold the LIVE in-cell visual-map state into the spec so the export == the on-screen cell.
      const live = { range: exportVisualMap?.range, hidden: exportVisualMap?.hidden }
      const spec: LegendExportSpec | null = col.blend?.legend2d
        ? { descriptor: col.blend.legend2d, title: 'blend' }
        : col.colorbar
          ? { descriptor: col.colorbar, title: cb.key, ...live }
          : col.legend
            ? { descriptor: col.legend, title: cb.key, ...live }
            : null
      setLegendSpec(spec)
    })
    return () => {
      alive = false
    }
  }, [source, exportColorBy, exportVisualMap])

  // Seed the two-cell layout on mount; clear any bled-in shared selection on unmount.
  useEffect(() => {
    seedTwoCellLayout(stores)
  }, [])
  useEffect(() => () => stores.coordination.getState().clearSelection(), [])

  // Single flex-COLUMN (grid at flex:1) — the proven-stable `grid` story layout. The export
  // dialog is an ABSOLUTE overlay (not a flex sibling) so opening it never resizes the grid
  // container, which avoids a ResizeObserver measurement oscillation that made the chrome
  // buttons jitter (never "stable" for a click) under a nested row/column flex.
  return (
    <div
      data-testid="viz-grid-cell-export"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}
    >
      <div style={{ padding: '0 8px 8px', fontSize: 12, opacity: 0.6 }}>
        {cellCount} cells — each cell's chrome has a ⤓ Export button. Click it to open the
        export dialog scoped to THAT pane (the second cell proves the button targets the
        clicked pane, not just the active-by-default first one).
      </div>
      <div ref={workspaceRef} style={{ flex: 1, minHeight: 0 }}>
        {positions && colors && catalog ? (
          <VizStoresProvider value={stores}>
            <GridWorkspace
              positions={positions}
              colors={colors}
              colorEpoch={colorEpoch}
              source={source}
              catalog={catalog}
              onRequestExportCell={(cellId, colorBy, visualMap) => {
                // One click on a cell's ⤓ button: scope the export to THAT pane + open it, capture the
                // cell's colorBy (DEC-1) AND its live in-cell visual-map state so the export == on screen.
                setExportCellId(cellId)
                setExportColorBy(colorBy ?? null)
                setExportVisualMap(visualMap)
                setExportOpen(true)
              }}
            />
          </VizStoresProvider>
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
      {exportOpen && (
        <div
          data-testid="viz-cell-export-popover"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 10,
            background: 'rgba(20,20,20,0.9)',
            borderRadius: 6,
            border: '1px solid rgba(128,128,128,0.35)',
          }}
        >
          {/* Remount (key) per target pane so the dialog opens fresh with scope='pane'. */}
          <ExportDialog
            key={exportCellId ?? 'none'}
            canvas={getDeckCanvas}
            paneRect={getPaneRect}
            legend={() => legendSpec}
            gridDividers={() => gridDividerMarks(workspaceRef.current, getDeckCanvas(), typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)}
            dpr={typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1}
            filename="cell-export"
          />
        </div>
      )}
    </div>
  )
}

registerStory({
  id: 'grid-cell-export',
  category: 'Export',
  title: 'Export — per-cell "export this pane" button',
  covers: 'export',
  Component: CellExportStory,
})
