// MatrixHeatmapView.tsx — the matrix-heatmap VIEW: a `<DeckGL>` (OrthographicView) that
// renders a big numeric matrix as a multiscale GPU image. It builds the CPU pyramid, picks
// the level whose texels map ≈ 1:1 to screen pixels for the visible column span, uploads that
// column window of that level as one RG8 texture, and colorizes it in-shader via the
// `MatrixHeatmapLayer`. Mirrors `spatial/LabelMaskView.tsx` + `spatial/RasterImageView.tsx`.
//
// NAVIGATION — dataZoom BARS, not a free camera (DEC-38). The view is navigated by a contiguous
// `MatrixWindow` (`{row0,row1,col0,col1}` in base-index units), driven by an ECharts-style
// `MatrixDataZoom`: a horizontal range slider (columns, under the matrix) + a vertical range
// slider (rows, beside it), each with draggable handles + a draggable band, PLUS drag-pan over
// the canvas. There is NO scroll-wheel zoom (`wheel={false}`). The window drives BOTH:
//   • FRAMING — the OrthographicView is framed (`controller={false}`) to the window via
//     `windowToViewFit`, so the visible `[row0,row1) × [col0,col1)` sub-rect fills the pane.
//   • LOD — the pyramid level comes from the visible COLUMN span:
//     `cellsPerPixel = (col1-col0)/paneWidthPx` → `pickLevel(...)`. Rows are few, so the row bar
//     just re-frames a row subset (the whole-row texture is always uploaded).
//
// COORDINATE SPACE: world x = BASE column index (1 world unit = 1 base column), world y = row.
// A level-L cell spans `2^L` base columns, so a window `[colStart, colEnd)` at level L maps to
// world bounds `[colStart*2^L, rows, colEnd*2^L, 0]` (flipY).
//
// CROSS-PLOT COORDINATION (this wave): the view is a first-class participant in the shared
// selection + zoom coordination —
//   • CONSUME — a `selection` prop (the shared dense point/column selection) DIMS every column
//     NOT in the selection (each BASE column IS a dense point; a level-column is lit iff any of
//     its covered base columns is selected — a downsample-OR mask uploaded as a 1×cols R8
//     texture, `matrixSelection.ts`). The view stays presentational: the wiring site reads the
//     Coordination store and passes the prop.
//   • PRODUCE — a "select columns" brush (a horizontal drag, gated behind a pan/select mode
//     toggle so it never fights the dataZoom drag-pan) turns the dragged column span `[c0, c1)`
//     into base point indices and calls `onSelectColumns`.
//   • SYNC-ZOOM — an optional controlled `window` + `onWindowChange`: two heatmaps of the SAME
//     matrix given the same `MatrixWindow` pan+zoom in lockstep. (Heatmap↔scatter live in a
//     DIFFERENT coordinate space, so that link is intentionally NOT offered here.)
//
// Framework-agnostic (viz-core): depends only on @deck.gl/* + react. Nothing here names a
// domain — a "matrix" is rows × columns of scalar values.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { buildPyramid } from './matrixPyramid'
import { MAX_TEXTURE_DIM, packLevelToRG, pickLevel } from './matrixLevelTexture'
import { columnRangeToPointIndices, columnSelectionMaskForLevel } from './matrixSelection'
import { buildColormapLUT } from '../gpu/colormapLut'
import { DIM_OPACITY, hasAnySelection } from '../coordination/selectionSync'
import { DEFAULT_CONTINUOUS_COLORMAP, type ContinuousColormap } from '../data/color'
import { VALUE_MAX, VALUE_MIN, type MatrixData, type MatrixValueRange } from './matrixTypes'
import { MatrixHeatmapLayer } from './MatrixHeatmapLayer'
import { MatrixDataZoom, type DataZoomConfig } from '../charts/MatrixDataZoom'
import { fullWindow, windowToViewFit, type MatrixWindow } from '../charts/matrixWindow'

/** A hovered cell, as reported to `onHoverCell`. */
export interface HoveredMatrixCell {
  /** pyramid level the cell was picked at (0 = base). */
  readonly level: number
  /** column in that level's coordinates (== base column at level 0). */
  readonly col: number
  /** row (constant across levels). */
  readonly row: number
  /** the cell's value (0..255). */
  readonly value: number
  /** the cell's coverage byte (`min(counts,255)`; > 0 since empty bins aren't pickable). */
  readonly coverage: number
}

/** The current level-of-detail, reported to `onLodChange` (test/harness hook). */
export interface MatrixLodInfo {
  readonly level: number
  /** the visible level-column window `[colStart, colEnd)` actually uploaded. */
  readonly colStart: number
  readonly colEnd: number
  /** approximate number of BASE columns currently visible in the viewport. */
  readonly visibleCols: number
}

export interface MatrixHeatmapViewProps {
  /** the base (full-resolution) matrix. */
  base: MatrixData
  /** continuous colormap (default viridis). */
  colormap?: ContinuousColormap
  /** value domain `[lo, hi]` mapped across the colormap (default `[0, 255]`). */
  valueDomain?: [number, number]
  /** an inclusive base value-range filter `[lo, hi]`; rebuilds the pyramid filter-aware. */
  filter?: MatrixValueRange
  /** the SHARED dense point/column selection (CONSUME): columns NOT in it render dimmed. Fed
   *  from the Coordination store's `pointSelection` at the wiring site. `null`/empty ⇒ no dim. */
  selection?: Uint32Array | null
  /** fired on brush-commit (PRODUCE) with the base point indices of the dragged column span
   *  `[c0, c1)`. Providing it enables the pan/select mode toggle + the column brush. */
  onSelectColumns?: (indices: Uint32Array) => void
  /** controlled navigation WINDOW (SYNC-ZOOM): when provided, the parent OWNS the window — two
   *  same-matrix heatmaps sharing one `window`/handler pan+zoom together. Omit for the view's
   *  own internal (full-matrix) window. */
  window?: MatrixWindow
  /** notified on every window change (dataZoom bar / drag-pan). Required to drive a controlled
   *  `window`; also fires in uncontrolled mode (a passive observer). */
  onWindowChange?: (win: MatrixWindow) => void
  /** notified as the pointer moves over a cell (or `null` off any cell / over an empty bin). */
  onHoverCell?: (cell: HoveredMatrixCell | null) => void
  /** notified when the level-of-detail / visible window changes (test/harness hook). */
  onLodChange?: (info: MatrixLodInfo) => void
  /** prefix for this view's data-testids (default `viz-matrix-heatmap`); pass distinct values
   *  when two views coexist on a page (e.g. a SYNC-ZOOM pair). */
  testId?: string
  /**
   * Per-instance dataZoom config: `false` disables the zoom UI entirely; `{ x, y, wheel }` picks
   * each axis' control kind + wheel gate. Default (omitted) = cols + rows sliders, wheel OFF
   * (the matrix heatmap navigates by sliders + drag-pan, no scroll-wheel zoom).
   */
  dataZoom?: false | DataZoomConfig
}

/** Default matrix-heatmap dataZoom: both sliders, no wheel (drag-pan is unaffected). */
const DEFAULT_MATRIX_DATAZOOM: DataZoomConfig = { x: 'slider', y: 'slider', wheel: false }

/** deck.gl types pick info loosely; a tiny local alias keeps casts honest. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PickInfo = any

/** Extra level-columns padded on each side of the visible window (smoother panning). */
const WINDOW_PAD = 2
/** Nominal canvas width (px) used to derive the LOD before the container is measured. */
const NOMINAL_WIDTH_PX = 1000

type Mode = 'pan' | 'select'

export function MatrixHeatmapView({
  base,
  colormap = DEFAULT_CONTINUOUS_COLORMAP,
  valueDomain = [VALUE_MIN, VALUE_MAX],
  filter,
  selection,
  onSelectColumns,
  window: controlledWindow,
  onWindowChange,
  onHoverCell,
  onLodChange,
  testId = 'viz-matrix-heatmap',
  dataZoom,
}: MatrixHeatmapViewProps) {
  const rows = base.rows
  const baseCols = base.cols

  // ── The CPU pyramid. Rebuilt on filter change (correct at ALL zoom levels).
  // TODO(gpu-recompute): replace this CPU buildPyramid with the GPU render-to-texture pass
  // (build each coarser level in a fragment shader over the level below) so a filter change
  // doesn't re-walk the whole matrix on the CPU. The RG8 texture format + the count-weighted
  // aggregation rule (matrixPyramid.ts) are already the exact contract that pass must match.
  const pyramid = useMemo(
    () => buildPyramid(base, filter),
    // filter is a {lo,hi}; depend on its fields so a new-object-same-values doesn't rebuild.
    [base, filter?.lo, filter?.hi], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const levelCount = pyramid.length

  const view = useMemo(() => new OrthographicView({ id: 'matrix-heatmap', flipY: true }), [])

  // The colormap LUT texture bytes (256×4 RGBA); rebuilt only on colormap change.
  const lut = useMemo(() => buildColormapLUT(colormap), [colormap])

  // The deck canvas wrapper — measured for the LOD width + used to unproject brush pixels. It is
  // INSIDE the MatrixDataZoom (so it excludes the slider gutters); measuring the outer container
  // instead would over-report the width by the rail thickness.
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })

  // ── Navigation WINDOW. Controlled by a parent for SYNC-ZOOM; else an internal window that
  // starts at the full matrix and is reset whenever the matrix DIMENSIONS change. ─────────────
  const controlled = controlledWindow != null
  const [internalWindow, setInternalWindow] = useState<MatrixWindow>(() => fullWindow(rows, baseCols))
  useEffect(() => {
    if (!controlled) setInternalWindow(fullWindow(rows, baseCols))
  }, [rows, baseCols, controlled])
  const win = controlled ? controlledWindow : internalWindow

  const emitWindow = useCallback(
    (next: MatrixWindow) => {
      if (!controlled) setInternalWindow(next)
      onWindowChange?.(next)
    },
    [controlled, onWindowChange],
  )

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── FRAMING: frame the OrthographicView so the visible window fills the canvas (no free
  // camera — `controller={false}`). The window's `[col0,col1] × [row0,row1]` sub-rect is
  // centred + per-axis-zoomed to the measured canvas via `windowToViewFit`. ──────────────────
  const viewState = useMemo<OrthographicViewState>(() => {
    const w = size.width > 0 ? size.width : NOMINAL_WIDTH_PX
    const h = size.height > 0 ? size.height : NOMINAL_WIDTH_PX
    const fit = windowToViewFit(win, w, h)
    return { target: fit.target, zoom: fit.zoom } as OrthographicViewState
  }, [win, size.width, size.height])

  // ── Derive the level + visible level-column window from the WINDOW's column span. ──────────
  const lod = useMemo(() => {
    const width = size.width > 0 ? size.width : NOMINAL_WIDTH_PX
    const baseStart = Math.max(0, Math.min(baseCols, win.col0))
    const baseEnd = Math.max(baseStart, Math.min(baseCols, win.col1))
    // cellsPerPixel: BASE columns per screen pixel for the visible span → the pyramid level.
    const cellsPerPixel = (baseEnd - baseStart) / Math.max(1, width)
    const level = pickLevel(cellsPerPixel, levelCount)
    const step = Math.pow(2, level) // base cols per level-col at this level

    const lvl = pyramid[level]
    let colStart = Math.max(0, Math.floor(baseStart / step) - WINDOW_PAD)
    let colEnd = Math.min(lvl.cols, Math.ceil(baseEnd / step) + WINDOW_PAD)
    if (colEnd <= colStart) {
      colStart = 0
      colEnd = Math.min(lvl.cols, MAX_TEXTURE_DIM)
    }
    // Single-texture simplification for THIS wave: cap the window to one texture width. For
    // the in-memory demo the visible window always fits (coarse levels are small; base-level
    // windows are small when zoomed in), so this never actually clips. A tiled deployment
    // would instead upload `residentTilesFor(...)` as several textures.
    if (colEnd - colStart > MAX_TEXTURE_DIM) colEnd = colStart + MAX_TEXTURE_DIM

    return {
      level,
      step,
      colStart,
      colEnd,
      visibleCols: Math.max(0, Math.round(baseEnd - baseStart)),
    }
  }, [win, size.width, pyramid, levelCount, baseCols])

  useEffect(() => {
    onLodChange?.({
      level: lod.level,
      colStart: lod.colStart,
      colEnd: lod.colEnd,
      visibleCols: lod.visibleCols,
    })
  }, [lod.level, lod.colStart, lod.colEnd, lod.visibleCols, onLodChange])

  // RG8 window bytes for the selected level + window (repacked only when the window changes).
  const rgData = useMemo(
    () => packLevelToRG(pyramid[lod.level], lod.colStart, lod.colEnd),
    [pyramid, lod.level, lod.colStart, lod.colEnd],
  )

  const filterActive = lod.level === 0 && !!filter

  // ── CONSUME: the per-column dim mask for the CURRENT displayed window. Build the whole-level
  // lit mask (downsample-OR of the selection) then slice it to the uploaded window so its width
  // matches the data texture (`uv.x` samples the same column). `null` when no selection.
  const selectionActive = hasAnySelection(selection)
  const maskWindow = useMemo(() => {
    if (!selectionActive) return null
    const levelCols = pyramid[lod.level].cols
    const full = columnSelectionMaskForLevel(selection, baseCols, lod.level, levelCols)
    return full.slice(lod.colStart, lod.colEnd) // width == texWidth
  }, [selectionActive, selection, baseCols, pyramid, lod.level, lod.colStart, lod.colEnd])

  const layers = useMemo(() => {
    const texWidth = lod.colEnd - lod.colStart
    // world bounds of this level-window: [minX, minY, maxX, maxY] = base-col span × rows.
    const bounds: [number, number, number, number] = [
      lod.colStart * lod.step,
      rows,
      lod.colEnd * lod.step,
      0,
    ]
    return [
      new MatrixHeatmapLayer({
        id: 'matrix-heatmap-layer',
        rgData,
        texWidth,
        texHeight: rows,
        valueColorLut: lut,
        valueDomain,
        filterActive,
        filterLo: filter?.lo ?? VALUE_MIN,
        filterHi: filter?.hi ?? VALUE_MAX,
        tileColStart: lod.colStart,
        levelIndex: lod.level,
        bounds,
        maskData: maskWindow,
        maskWidth: maskWindow?.length ?? 0,
        selectionActive,
        dimOpacity: DIM_OPACITY,
        pickable: true,
        onHover: (info: PickInfo) => {
          const obj = info?.object as HoveredMatrixCell | null
          if (obj) {
            onHoverCell?.({
              level: lod.level,
              col: obj.col,
              row: obj.row,
              value: obj.value,
              coverage: obj.coverage,
            })
          } else {
            onHoverCell?.(null)
          }
        },
      }),
    ]
  }, [
    rgData,
    lod,
    rows,
    lut,
    valueDomain,
    filterActive,
    filter?.lo,
    filter?.hi,
    maskWindow,
    selectionActive,
    onHoverCell,
  ])

  // ── PRODUCE: the column brush. Gated behind a pan/select MODE toggle (only offered when a
  // parent wired `onSelectColumns`) so the drag never fights the dataZoom drag-pan — exactly how
  // SpatialScatterView gates its region gesture. In select mode an overlay div captures a
  // horizontal drag (and stops the event bubbling to the MatrixDataZoom pan); the SPAN of columns
  // dragged over becomes the selection (the y extent is irrelevant — selection is over columns).
  const brushEnabled = !!onSelectColumns
  const [mode, setMode] = useState<Mode>('pan')
  const [brushPx, setBrushPx] = useState<{ x0: number; x1: number } | null>(null)
  const dragging = useRef(false)

  // Screen (canvas-relative) px → world x (== base column, fractional). Uses the LIVE view state.
  const worldXAtPx = useCallback(
    (px: number): number | null => {
      const el = canvasRef.current
      if (!el) return null
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return null
      const vp = view.makeViewport({ width: rect.width, height: rect.height, viewState })
      if (!vp) return null
      const world = vp.unproject([px, rect.height / 2])
      return world[0]
    },
    [view, viewState],
  )

  const relX = useCallback((clientX: number): number | null => {
    const el = canvasRef.current
    if (!el) return null
    return clientX - el.getBoundingClientRect().left
  }, [])

  const onBrushDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (mode !== 'select') return
      // Stop the pointerdown from bubbling to the MatrixDataZoom canvas-pan handler.
      e.stopPropagation()
      const x = relX(e.clientX)
      if (x == null) return
      dragging.current = true
      setBrushPx({ x0: x, x1: x })
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    [mode, relX],
  )

  const onBrushMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return
      const x = relX(e.clientX)
      if (x == null) return
      setBrushPx(prev => (prev ? { x0: prev.x0, x1: x } : { x0: x, x1: x }))
    },
    [relX],
  )

  const onBrushUp = useCallback(() => {
    if (!dragging.current) return
    dragging.current = false
    setBrushPx(current => {
      if (current) {
        const wa = worldXAtPx(current.x0)
        const wb = worldXAtPx(current.x1)
        if (wa != null && wb != null) {
          // Half-open [c0, c1): floor the low world-x, ceil the high; clamp to [0, baseCols].
          // A near-zero drag (a click) still selects at least the one column under it.
          const c0 = Math.max(0, Math.floor(Math.min(wa, wb)))
          let c1 = Math.min(baseCols, Math.ceil(Math.max(wa, wb)))
          if (c1 <= c0) c1 = Math.min(baseCols, c0 + 1)
          onSelectColumns?.(columnRangeToPointIndices(c0, c1))
        }
      }
      return null
    })
  }, [worldXAtPx, baseCols, onSelectColumns])

  const selecting = brushEnabled && mode === 'select'

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid={`${testId}-view`}
    >
      <MatrixDataZoom
        nRows={rows}
        nCols={baseCols}
        value={win}
        onChange={emitWindow}
        dataZoom={dataZoom ?? DEFAULT_MATRIX_DATAZOOM}
        testId={`${testId}-datazoom`}
      >
        <div ref={canvasRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
          <DeckGL
            views={view}
            controller={false}
            viewState={viewState as never}
            layers={layers}
          />

          {/* PRODUCE — pan/select toggle (only when a parent wired onSelectColumns) */}
          {brushEnabled && (
            <div
              data-testid={`${testId}-toolbar`}
              style={{
                position: 'absolute',
                top: 8,
                left: 8,
                display: 'flex',
                gap: 4,
                zIndex: 2,
                fontSize: 12,
              }}
            >
              {(['pan', 'select'] as Mode[]).map(m => (
                <button
                  key={m}
                  type="button"
                  data-testid={`${testId}-tool-${m}`}
                  aria-pressed={mode === m}
                  onClick={() => {
                    setMode(m)
                    setBrushPx(null)
                    dragging.current = false
                  }}
                  style={{ fontWeight: mode === m ? 700 : 400 }}
                >
                  {m === 'pan' ? 'Pan' : 'Select columns'}
                </button>
              ))}
            </div>
          )}

          {/* the column-brush capture overlay + visible band (select mode only) */}
          {selecting && (
            <div
              data-testid={`${testId}-brush-overlay`}
              onPointerDown={onBrushDown}
              onPointerMove={onBrushMove}
              onPointerUp={onBrushUp}
              style={{ position: 'absolute', inset: 0, cursor: 'col-resize', touchAction: 'none', zIndex: 1 }}
            >
              {brushPx && (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: Math.min(brushPx.x0, brushPx.x1),
                    width: Math.abs(brushPx.x1 - brushPx.x0),
                    background: 'rgba(56,132,255,0.18)',
                    borderLeft: '1px solid rgba(56,132,255,0.7)',
                    borderRight: '1px solid rgba(56,132,255,0.7)',
                    pointerEvents: 'none',
                  }}
                />
              )}
            </div>
          )}
        </div>
      </MatrixDataZoom>
    </div>
  )
}
