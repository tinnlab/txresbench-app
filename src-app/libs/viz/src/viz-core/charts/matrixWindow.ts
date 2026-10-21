// matrixWindow.ts — the MATRIX (2-axis, index-unit) view of the dataZoom window model
// (DEC-38). A matrix chart (heatmap / dotplot) is navigated NOT by a free camera but by a
// contiguous RANGE window into an nRows×nCols index grid: `{row0,row1,col0,col1}` (index
// units, row0<row1, col0<col1). The per-axis window MATH (clamp/zoom/pan) now lives in the
// generic `./axisWindow`; this module is a THIN shim that adapts it to the 2-axis `[lo,hi]`
// tuple form + keeps the matrix-specific FRAMING helpers (`windowToBounds` / `windowToViewFit`),
// which are NOT window math and STAY here. No DOM, no GL → unit-testable in node. The React
// control `MatrixDataZoom` is a thin shell over `AxisDataZoom`; the consumer converts a window
// to a `ChartCanvas` `bounds`.

import { clampWindow, panWindow as panAxisWindow, zoomWindow } from './axisWindow'

/** A contiguous sub-window into an nRows×nCols matrix, in fractional index units.
 *  Invariants: `row0 ≤ row1` (top→bottom), `col0 ≤ col1` (left→right); both inside
 *  `[0,nRows]` / `[0,nCols]`. row0 is the TOP row edge (row 0 is drawn at the top). */
export interface MatrixWindow {
  readonly row0: number
  readonly row1: number
  readonly col0: number
  readonly col1: number
}

/** Smallest addressable window span (index units): never collapse below one cell. */
export const MIN_WINDOW = 1

/** The full matrix as a window (the default framing). */
export function fullWindow(nRows: number, nCols: number): MatrixWindow {
  return { row0: 0, row1: nRows, col0: 0, col1: nCols }
}

/** True when the window covers (or over-covers) the entire matrix on both axes. */
export function isFullWindow(win: MatrixWindow, nRows: number, nCols: number): boolean {
  return win.row0 <= 0 && win.row1 >= nRows && win.col0 <= 0 && win.col1 >= nCols
}

/** Snap a continuous rail/handle value to an integer matrix index clamped to [0,n]. */
export function handleToIndex(value: number, n: number): number {
  const i = Math.round(value)
  return i < 0 ? 0 : i > n ? n : i
}

/**
 * Normalize a pair of edge values into an ordered, in-range `[lo,hi]` span of at least
 * `minSize` on an axis of length `n`. Orders the pair, clamps into `[0,n]`, and — if the
 * span is thinner than `minSize` — grows it to `minSize` while keeping it inside `[0,n]`.
 */
export function normalizeRange(
  a: number,
  b: number,
  n: number,
  minSize: number = MIN_WINDOW,
): [number, number] {
  const w = clampWindow(a, b, 0, n, Math.min(minSize, n))
  return [w.lo, w.hi]
}

/**
 * Zoom one axis' `[lo,hi]` span toward a cursor by `factor` (<1 narrows / zooms in,
 * >1 widens / zooms out). `cursorFrac` (0..1 across the CURRENT span) names the data
 * coordinate held fixed under the cursor. The new span is clamped to `[minSize,n]` and
 * shifted back inside `[0,n]`.
 */
export function zoomRange(
  lo: number,
  hi: number,
  n: number,
  factor: number,
  cursorFrac: number,
  minSize: number = MIN_WINDOW,
): [number, number] {
  const anchor = lo + cursorFrac * (hi - lo)
  const w = zoomWindow({ lo, hi }, 0, n, factor, anchor, Math.min(minSize, n))
  return [w.lo, w.hi]
}

/** Pan one axis' `[lo,hi]` span by `delta` (index units), clamped so it stays in `[0,n]`
 *  (span width preserved). */
export function panRange(lo: number, hi: number, n: number, delta: number): [number, number] {
  const w = panAxisWindow({ lo, hi }, 0, n, delta)
  return [w.lo, w.hi]
}

/** Wheel-zoom the whole window toward a 2-D cursor. `cursorColFrac`/`cursorRowFrac`
 *  (0..1) are the cursor position over the canvas (col: left→right, row: top→bottom,
 *  matching row 0 at the top). */
export function wheelZoomWindow(
  win: MatrixWindow,
  nRows: number,
  nCols: number,
  factor: number,
  cursorColFrac: number,
  cursorRowFrac: number,
  minSize: number = MIN_WINDOW,
): MatrixWindow {
  const [col0, col1] = zoomRange(win.col0, win.col1, nCols, factor, cursorColFrac, minSize)
  const [row0, row1] = zoomRange(win.row0, win.row1, nRows, factor, cursorRowFrac, minSize)
  return { row0, row1, col0, col1 }
}

/** Pan the whole window by `(dCol,dRow)` index-unit deltas, clamped to the matrix. */
export function panWindow(
  win: MatrixWindow,
  nRows: number,
  nCols: number,
  dCol: number,
  dRow: number,
): MatrixWindow {
  const [col0, col1] = panRange(win.col0, win.col1, nCols, dCol)
  const [row0, row1] = panRange(win.row0, win.row1, nRows, dRow)
  return { row0, row1, col0, col1 }
}

/** Replace the column span from two (already index-snapped) handle values. */
export function withColRange(
  win: MatrixWindow,
  a: number,
  b: number,
  nCols: number,
  minSize: number = MIN_WINDOW,
): MatrixWindow {
  const [col0, col1] = normalizeRange(a, b, nCols, minSize)
  return { ...win, col0, col1 }
}

/** Replace the row span from two (already index-snapped) handle values. */
export function withRowRange(
  win: MatrixWindow,
  a: number,
  b: number,
  nRows: number,
  minSize: number = MIN_WINDOW,
): MatrixWindow {
  const [row0, row1] = normalizeRange(a, b, nRows, minSize)
  return { ...win, row0, row1 }
}

/**
 * The `ChartCanvas` fit `bounds` = `[col0, row0, col1, row1]` for a window, matching the
 * heatmap's `[0, rows, cols, 0]` convention. `fitViewState` frames purely by center +
 * extent (it uses |max−min|), so the y-edge order is immaterial — the window fills the
 * canvas either way.
 */
export function windowToBounds(win: MatrixWindow): [number, number, number, number] {
  return [win.col0, win.row0, win.col1, win.row1]
}

/** A framing for an OrthographicView: a `[cx, cy, 0]` target + a per-axis `[zoomX, zoomY]`.
 *  Plain numbers (no deck type) so it stays node-testable; the view casts it to a view state. */
export interface WindowViewFit {
  readonly target: [number, number, number]
  readonly zoom: [number, number]
}

/**
 * Frame a matrix `window` so it exactly FILLS a `widthPx × heightPx` canvas (the matrix-heatmap
 * replacement for the deleted `fitRowsViewState`/free-camera math). World x = base column index,
 * world y = row index, so the target centres on the window and the per-axis zoom solves
 * `span · 2^-zoom = px` ⟹ `zoom = log2(px / span)` (independent x/y, like `ChartCanvas.fitViewState`).
 * A degenerate span/px is guarded to `MIN_WINDOW`/`1` so the log is always finite.
 */
export function windowToViewFit(
  win: MatrixWindow,
  widthPx: number,
  heightPx: number,
  minSize: number = MIN_WINDOW,
): WindowViewFit {
  const w = widthPx > 0 ? widthPx : 1
  const h = heightPx > 0 ? heightPx : 1
  const colSpan = Math.max(win.col1 - win.col0, minSize)
  const rowSpan = Math.max(win.row1 - win.row0, minSize)
  return {
    target: [(win.col0 + win.col1) / 2, (win.row0 + win.row1) / 2, 0],
    zoom: [Math.log2(w / colSpan), Math.log2(h / rowSpan)],
  }
}
