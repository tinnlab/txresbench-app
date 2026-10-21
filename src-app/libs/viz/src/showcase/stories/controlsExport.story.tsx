// controlsExport.story.tsx — ONE page to SEE + EXPORT all three new WYSIWYG controls:
//   • VisualMap  (continuous colorBy → the interactive in-cell gradient bar; drag → filter)
//   • Legend     (categorical colorBy → the clickable in-cell swatch list; click → hide)
//   • DataZoom   (a scatter with x+y range sliders; drag/pan → window)
// Each has an Export button whose ExportDialog carries the LIVE control state, so the exported
// figure IS a picture of what's on screen (what-you-see-is-what-you-export).
//
// Section A reuses the exact GridWorkspace + `onRequestExportCell` wiring the app uses (legend +
// visualMap are per-cell deck overlays). Section B is the dataZoom host wiring that closes the
// export gap: the host owns the chart's live window (`onWindowsChange`) and passes a `dataZoom`
// getter (window → rail fraction, matching the on-screen rail exactly) into ExportDialog.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { GridWorkspace } from '../../viz-core/grid/GridWorkspace'
import { ExportDialog } from '../../viz-core/export/ExportDialog'
import { ScatterDataZoom } from '../../viz-core/ScatterDataZoom'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY, type ColorBy } from '../../viz-core/data/engine'
import { boundsForPositions } from '../../viz-core/density/densityBin'
import { windowToFraction, type AxisWindow } from '../../viz-core/charts/axisWindow'
import type { DatasetCatalog } from '../../viz-core/data/wire'
import type { Rect } from '../../viz-core/export/cropCanvas'
import type { LegendExportSpec } from '../../viz-core/export/legendMarks'
import type { DataZoomExportSpec } from '../../viz-core/controls/dataZoomRender'
import { gridDividerMarks } from '../../viz-core/export/gridDividerMarks'
import { INITIAL_CELL_ID } from '../../adapter/GridWorkspace.store'
import { createVizStores, VizStoresProvider, type VizStores } from '../../adapter/vizStores'
import { registerStory } from '../registry'

// ── Section A — Legend + VisualMap (per-cell deck overlays, WYSIWYG export) ──────────────────────
const CONT_COLOR_BY: ColorBy = { mode: 'continuous', key: 'qcA', colormap: 'viridis', scale: 'linear', hidden: new Set<number>() }
const CAT_COLOR_BY: ColorBy = { mode: 'categorical', key: 'group', colormap: 'viridis', scale: 'linear', hidden: new Set<number>() }
function seedTwoCellLayout(stores: VizStores) {
  const s = stores.gridWorkspace.getState()
  s.reset() // → cell-1 (scatter)
  s.splitCell(INITIAL_CELL_ID, 'col') // → [cell-1 | cell-2], both scatter
  Object.keys(stores.gridWorkspace.getState().cells).forEach((id, i) => {
    stores.gridWorkspace.getState().setCellColorBy(id, i === 0 ? CONT_COLOR_BY : CAT_COLOR_BY)
  })
}

function LegendVisualMapSection() {
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
  const [exportCellId, setExportCellId] = useState<string | null>(null)
  const [exportColorBy, setExportColorBy] = useState<ColorBy | null>(null)
  const [exportVisualMap, setExportVisualMap] = useState<{ range?: [number, number]; hidden?: number[] } | undefined>(undefined)
  const [legendSpec, setLegendSpec] = useState<LegendExportSpec | null>(null)

  const getDeckCanvas = (): HTMLCanvasElement | null =>
    workspaceRef.current?.querySelector('canvas') ?? null

  const getPaneRect = (): Rect | null => {
    const root = workspaceRef.current
    const canvas = getDeckCanvas()
    if (!root || !canvas) return null
    const id = exportCellId
    const pane =
      (id && root.querySelector(`[data-viz-cell="${typeof CSS !== 'undefined' ? CSS.escape(id) : id}"]`)) ||
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
    return () => { alive = false }
  }, [source])

  // Resolve the exported cell's legend from ITS colorBy, folding the LIVE in-cell visual-map state
  // into the spec so the export == the on-screen cell (WYSIWYG).
  useEffect(() => {
    let alive = true
    const cb = exportColorBy ?? DEFAULT_COLOR_BY
    void computeColoring(source, cb).then(col => {
      if (!alive) return
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
    return () => { alive = false }
  }, [source, exportColorBy, exportVisualMap])

  useEffect(() => { seedTwoCellLayout(stores) }, [])
  useEffect(() => () => stores.coordination.getState().clearSelection(), [])

  return (
    <div data-testid="viz-controls-export-legend" style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <div style={{ padding: '0 8px 6px', fontSize: 12, opacity: 0.7 }}>
        <strong>Legend &amp; VisualMap</strong> — left cell (continuous) shows the <em>VisualMap</em> bar:
        drag a handle to filter. Right cell (categorical) shows the <em>Legend</em>: click a swatch to
        hide. Each cell&apos;s ⤓ Export bakes the control in exactly as shown.
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
          data-testid="viz-controls-export-legend-popover"
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, background: 'rgba(20,20,20,0.9)', borderRadius: 6, border: '1px solid rgba(128,128,128,0.35)' }}
        >
          <ExportDialog
            key={exportCellId ?? 'none'}
            canvas={getDeckCanvas}
            paneRect={getPaneRect}
            legend={() => legendSpec}
            gridDividers={() => gridDividerMarks(workspaceRef.current, getDeckCanvas(), typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)}
            dpr={typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1}
            filename="controls-legend-export"
          />
        </div>
      )}
    </div>
  )
}

// ── Section B — DataZoom (chart rails, WYSIWYG export) — closes the export-getter wiring gap ──────
function DataZoomSection() {
  const source = useMemo(() => new FixtureSource({ seed: 7, pointCount: 40_000 }), [])
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  // The chart's LIVE visible windows (moved by a rail drag OR a camera pan/zoom).
  const [xWin, setXWin] = useState<AxisWindow | null>(null)
  const [yWin, setYWin] = useState<AxisWindow | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const pos = await source.positions('primary')
      const c = await computeColoring(source, { mode: 'categorical', key: 'group', colormap: 'viridis', scale: 'linear', hidden: new Set() })
      if (!alive) return
      setPositions(pos.positions)
      setColors(c.colors)
    })()
    return () => { alive = false }
  }, [source])

  // Data extent = the SAME domain ScatterDataZoom fits to, so window→fraction matches its rails.
  const domain = useMemo(() => (positions ? boundsForPositions(positions) : null), [positions])
  const getScatterCanvas = (): HTMLCanvasElement | null => hostRef.current?.querySelector('canvas') ?? null

  // The dataZoom export getter (WYSIWYG): convert each live window → the SAME rail fraction the
  // on-screen AxisDataZoom draws (ScatterDataZoom uses invert=false for both axes). ExportDialog's
  // composeDataZoomIntoScene renders those fractions with the identical geometry as the live rail.
  const dataZoomSpec = (): DataZoomExportSpec | null => {
    if (!domain || !xWin || !yWin) return null
    return {
      x: { window: windowToFraction(xWin, domain.minX, domain.maxX, false) },
      y: { window: windowToFraction(yWin, domain.minY, domain.maxY, false) },
    }
  }

  return (
    <div data-testid="viz-controls-export-datazoom" style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      <div style={{ padding: '0 8px 6px', fontSize: 12, opacity: 0.7, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span>
          <strong>DataZoom</strong> — drag the x (below) / y (right) rails, or pan/zoom the plot.
          {xWin && ` x [${xWin.lo.toFixed(1)}, ${xWin.hi.toFixed(1)}]`}
        </span>
        <button
          type="button"
          data-testid="viz-controls-export-datazoom-btn"
          onClick={() => setExportOpen(o => !o)}
          style={{ padding: '2px 8px', borderRadius: 4 }}
        >
          ⤓ Export
        </button>
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }}>
        {positions && colors ? (
          <ScatterDataZoom
            positions={positions}
            colors={colors}
            dataZoom={{ x: 'slider', y: 'slider' }}
            onWindowsChange={(x, y) => { setXWin(x); setYWin(y) }}
            testId="viz-controls-datazoom"
          />
        ) : (
          <div style={{ padding: 16 }}>Loading fixture…</div>
        )}
      </div>
      {exportOpen && (
        <div
          data-testid="viz-controls-export-datazoom-popover"
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, background: 'rgba(20,20,20,0.9)', borderRadius: 6, border: '1px solid rgba(128,128,128,0.35)' }}
        >
          <ExportDialog
            canvas={getScatterCanvas}
            dataZoom={dataZoomSpec}
            dpr={typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1}
            filename="controls-datazoom-export"
          />
        </div>
      )}
    </div>
  )
}

function ControlsExportStory() {
  return (
    <div
      data-testid="viz-controls-export"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}
    >
      <div style={{ flex: 1, minHeight: 0, borderBottom: '1px solid rgba(128,128,128,0.3)' }}>
        <LegendVisualMapSection />
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DataZoomSection />
      </div>
    </div>
  )
}

registerStory({
  id: 'controls-export',
  category: 'Export',
  title: 'Controls — Legend · VisualMap · DataZoom (WYSIWYG export)',
  covers: 'export',
  Component: ControlsExportStory,
})
