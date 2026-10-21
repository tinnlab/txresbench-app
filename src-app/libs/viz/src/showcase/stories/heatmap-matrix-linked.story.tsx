// heatmap-matrix-linked.story.tsx — the matrix heatmap as a FIRST-CLASS coordination
// participant. It proves the three coordination links the new per-cell matrix heatmap now
// joins (a view isn't "done" until it coordinates):
//
//   SECTION A — SELECTION SYNC (shared Coordination store, same index space):
//     • a `DeckScatterCanvas` (LEFT) and a `MatrixHeatmapView` (RIGHT) back onto the SAME
//       `FixtureSource` — point index i ⟺ base column i (the heatmap contract: each COLUMN is
//       a point/cell). Both read/write the ONE `useCoordinationStore`.
//     • PRODUCE→CONSUME (scatter→heatmap): "Select cluster 0" writes those points into the
//       shared selection → the heatmap DIMS every column not in cluster 0.
//     • PRODUCE→CONSUME (heatmap→scatter): "Brush cols 0–500" (the headless stand-in for the
//       heatmap's drag-brush, which calls the SAME `onSelectColumns` store path) writes columns
//       0..499 → the scatter EMPHASISES those points.
//
//   SECTION B — ZOOM SYNC (controlled navigation window): TWO `MatrixHeatmapView`s of the SAME
//     matrix share one `window` (a `MatrixWindow`) + `onWindowChange`, so navigating one (via its
//     dataZoom BAR or drag-pan) moves the other in lockstep. Dragging a column-slider handle
//     narrows the shared window; both track. (Heatmap↔scatter is a DIFFERENT coordinate space,
//     so that link is intentionally absent.)
//
// A headless render harness can't drag a lasso/brush, so the selection gestures have a
// deterministic button seeding the SAME store path; the zoom-sync gesture drives the real
// dataZoom bar. State is mirrored to `window.__VIZ_TEST__` (`pointSelectionLength`,
// `heatmapSelectedCols`, `heatmapSharedWindow` = the shared window's visible column span) for
// the cross-view e2e.

import { useEffect, useMemo, useState } from 'react'
import { useStore } from 'zustand'
import { DeckScatterCanvas } from '../../viz-core/DeckScatterCanvas'
import { MatrixHeatmapView } from '../../viz-core/heatmap-matrix/MatrixHeatmapView'
import { fullWindow, zoomRange, type MatrixWindow } from '../../viz-core/charts/matrixWindow'
import { makeMatrixFixture } from '../../viz-core/heatmap-matrix/matrixFixture'
import {
  columnRangeToPointIndices,
  columnSelectionMaskForLevel,
} from '../../viz-core/heatmap-matrix/matrixSelection'
import { FixtureSource } from '../../viz-core/data/fixtures'
import { computeColoring } from '../../viz-core/data/engine'
import {
  hasAnySelection,
  highlightMaskForPoints,
} from '../../viz-core/coordination/selectionSync'
import { createVizStores, VizStoresProvider } from '../../adapter/vizStores'
import { registerStory } from '../registry'

// Small, aligned index space so the scatter's dense point i IS the heatmap's base column i.
const ROWS = 40
const COLS = 4000
const GROUP_KEY = 'group'
/** Coordination cell ids the two views originate selections from. */
const SCATTER_SOURCE = 'heatmap-linked-scatter'
const HEATMAP_SOURCE = 'heatmap-linked-heatmap'
/** The deterministic column brush span the headless button seeds. */
const BRUSH_C0 = 0
const BRUSH_C1 = 500

function HeatmapMatrixLinkedStory() {
  // ISOLATED store set, NOT the module singletons (see `00-capabilities.story.tsx`). A story that
  // writes the singleton coordination store leaves that write visible to every story mounted after
  // it in the SAME page load. This story wires every view EXPLICITLY (`selection` /
  // `onSelectColumns` / `highlightMask` props), so no view falls back to `defaultCoordinationHandle`
  // and the set alone is sufficient. `tests/viz-e2e/story-isolation.spec.ts` walks every story and
  // fails if any of them moves the process-global stores.
  const stores = useMemo(() => createVizStores(), [])
  const source = useMemo(() => new FixtureSource({ seed: 11, pointCount: COLS }), [])
  const base = useMemo(() => makeMatrixFixture({ rows: ROWS, cols: COLS, seed: 11 }), [])

  const [positions, setPositions] = useState<Float32Array | null>(null)
  const [colors, setColors] = useState<Uint8Array | null>(null)
  const [groupCodes, setGroupCodes] = useState<Uint16Array | null>(null)
  const [colorEpoch, setColorEpoch] = useState(0)

  // Reactive read of the SHARED selection — drives BOTH the heatmap dim (via the prop) and the
  // scatter emphasis (via the mask), proving the fan-out reached the store.
  const pointSelection = useStore(stores.coordination, s => s.pointSelection)
  const selectionLength = pointSelection?.length ?? 0

  // SECTION B — the shared, controlled navigation WINDOW two same-matrix heatmaps track in
  // lockstep (a dataZoom bar / drag on either drives it). `sharedCols` = its visible column span.
  const [sharedWindow, setSharedWindow] = useState<MatrixWindow>(() => fullWindow(ROWS, COLS))
  const sharedCols = sharedWindow.col1 - sharedWindow.col0

  useEffect(() => {
    let alive = true
    void (async () => {
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

  // Scatter CONSUME: the shared selection → a per-point 0/1 emphasis mask (rebuilt on change).
  const n = positions ? positions.length / 2 : 0
  const highlightMask = useMemo(
    () => (pointSelection && n ? highlightMaskForPoints(pointSelection, n) : null),
    [pointSelection, n],
  )
  const [selEpoch, setSelEpoch] = useState(0)
  useEffect(() => setSelEpoch(e => e + 1), [pointSelection])

  // How many BASE columns the heatmap lights up (== dims the complement of). Computed with the
  // SAME rollup the heatmap shader consumes, at base level (level 0 → identity per column).
  const heatmapSelectedCols = useMemo(() => {
    if (!hasAnySelection(pointSelection)) return 0
    const mask = columnSelectionMaskForLevel(pointSelection, COLS, 0, COLS)
    let lit = 0
    for (let i = 0; i < mask.length; i++) lit += mask[i]
    return lit
  }, [pointSelection])

  // Test hooks for the cross-view e2e.
  useEffect(() => {
    const w = window as unknown as { __VIZ_TEST__?: Record<string, unknown> }
    w.__VIZ_TEST__ = {
      ...(w.__VIZ_TEST__ ?? {}),
      pointSelectionLength: selectionLength,
      heatmapSelectedCols,
      heatmapSharedWindow: sharedCols,
    }
  }, [selectionLength, heatmapSelectedCols, sharedCols])

  // PRODUCE (scatter→): select every point in cluster 0 (== the headless stand-in for a lasso).
  const selectCluster0 = () => {
    if (!groupCodes) return
    const idx: number[] = []
    for (let i = 0; i < groupCodes.length; i++) if (groupCodes[i] === 0) idx.push(i)
    stores.coordination.getState().setSelection(SCATTER_SOURCE, Uint32Array.from(idx))
  }

  // PRODUCE (heatmap→): brush columns [BRUSH_C0, BRUSH_C1) — the SAME store path the view's
  // drag-brush uses via `onSelectColumns`, seeded deterministically for the headless harness.
  const brushColumns = (indices: Uint32Array) =>
    stores.coordination.getState().setSelection(HEATMAP_SOURCE, indices.length > 0 ? indices : null)
  const brushCols0to500 = () => brushColumns(columnRangeToPointIndices(BRUSH_C0, BRUSH_C1))

  const clear = () => stores.coordination.getState().clearSelection()
  // Zoom the shared window toward its centre (narrow = zoom in) / outward (widen = zoom out) —
  // the same window math a dataZoom-bar drag drives, exposed as buttons for convenience.
  const zoomIn = () =>
    setSharedWindow(w => {
      const [col0, col1] = zoomRange(w.col0, w.col1, COLS, 0.5, 0.5)
      return { ...w, col0, col1 }
    })
  const zoomOut = () =>
    setSharedWindow(w => {
      const [col0, col1] = zoomRange(w.col0, w.col1, COLS, 2, 0.5)
      return { ...w, col0, col1 }
    })

  const ready = positions && colors && groupCodes

  return (
    <VizStoresProvider value={stores}>
      <div
        data-testid="viz-heatmap-linked"
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
      >
        {/* ── SECTION A — SELECTION SYNC ─────────────────────────────────────────── */}
        <div
          style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}
        >
          <b>Selection sync</b>
          <button
            type="button"
            data-testid="viz-heatmap-linked-seed-scatter"
            onClick={selectCluster0}
            disabled={!groupCodes}
          >
            Select cluster 0 (scatter → heatmap dims)
          </button>
          <button
            type="button"
            data-testid="viz-heatmap-linked-brush-cols"
            onClick={brushCols0to500}
          >
            Brush cols 0–500 (heatmap → scatter emphasises)
          </button>
          <button type="button" data-testid="viz-heatmap-linked-clear" onClick={clear}>
            Clear
          </button>
          <span data-testid="viz-heatmap-linked-readout" style={{ opacity: 0.75 }}>
            Shared selection: {selectionLength.toLocaleString()} points · {heatmapSelectedCols.toLocaleString()} heatmap
            cols lit
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', borderBottom: '1px solid rgba(128,128,128,0.3)' }}>
          <div
            data-testid="viz-heatmap-linked-scatter"
            style={{ flex: 1, minWidth: 0, position: 'relative', borderRight: '1px solid rgba(128,128,128,0.3)' }}
          >
            {ready ? (
              <DeckScatterCanvas
                positions={positions}
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
          <div data-testid="viz-heatmap-linked-heatmap" style={{ flex: 1, minWidth: 0 }}>
            <MatrixHeatmapView
              base={base}
              selection={pointSelection}
              onSelectColumns={indices =>
                stores.coordination
                  .getState()
                  .setSelection(HEATMAP_SOURCE, indices.length > 0 ? indices : null)
              }
            />
          </div>
        </div>

        {/* ── SECTION B — ZOOM SYNC (two same-matrix heatmaps share one view state) ── */}
        <div
          style={{ padding: 8, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}
        >
          <b>Zoom sync</b>
          <button type="button" data-testid="viz-heatmap-linked-zoom-in" onClick={zoomIn}>
            Zoom in
          </button>
          <button type="button" data-testid="viz-heatmap-linked-zoom-out" onClick={zoomOut}>
            Zoom out
          </button>
          <span data-testid="viz-heatmap-linked-zoom-readout" style={{ opacity: 0.75 }}>
            Shared window: {sharedCols.toLocaleString()} cols visible — drag either dataZoom bar,
            both heatmaps track
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <div
            data-testid="viz-heatmap-linked-sync-a"
            style={{ flex: 1, minWidth: 0, borderRight: '1px solid rgba(128,128,128,0.3)' }}
          >
            <MatrixHeatmapView
              base={base}
              window={sharedWindow}
              onWindowChange={setSharedWindow}
              testId="viz-heatmap-sync-a"
            />
          </div>
          <div data-testid="viz-heatmap-linked-sync-b" style={{ flex: 1, minWidth: 0 }}>
            <MatrixHeatmapView
              base={base}
              window={sharedWindow}
              onWindowChange={setSharedWindow}
              testId="viz-heatmap-sync-b"
            />
          </div>
        </div>
      </div>
    </VizStoresProvider>
  )
}

registerStory({
  id: 'heatmap-matrix-linked',
  category: 'Selection',
  title: 'Matrix heatmap — cross-plot coordination (selection dim + brush + heatmap↔heatmap zoom sync)',
  covers: 'heatmap-matrix-linked',
  Component: HeatmapMatrixLinkedStory,
})
