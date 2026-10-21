// parallelCoordinatesModel.ts — the PURE math of the parallel-coordinates extension
// (no React, no deck, no store), so every geometric decision is unit-testable in node.
// This mirrors the built-ins' split: the deck-free "model" math lives apart from the View,
// exactly as `registry/model.ts` / `coordination/selectionSync.ts` are deck-free.
//
// A parallel-coordinates plot draws N evenly-spaced VERTICAL value axes (one per bound
// value column = "dimension"); each DATA POINT becomes a POLYLINE connecting its
// per-dimension value, normalized into [0,1] against that dimension's own min→max. An
// axis BRUSH (a value range dragged on ONE dimension) selects the points whose value on
// that dimension falls inside the range — the PRODUCE direction, which fans out to every
// linked view through the shared canonical-id selection seam (`mapRowsToIds`).

import { mapRowsToIds } from '../../viz-core/coordination/selectionSync'

/** One dimension's value range (its own min→max), the domain each axis normalizes against. */
export interface DimensionExtent {
  readonly min: number
  readonly max: number
}

/**
 * The min→max extent of a dense value column over its first `count` rows (the rendered
 * slice). A non-finite value is ignored. An empty / all-non-finite range collapses to
 * `{min:0,max:0}` (which `normalizeValue` maps to the axis midline).
 */
export function columnExtent(values: Float32Array, count = values.length): DimensionExtent {
  let min = Infinity
  let max = -Infinity
  const n = Math.min(count, values.length)
  for (let i = 0; i < n; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 }
  return { min, max }
}

/**
 * Normalize a value into `[0,1]` against a dimension's extent (0 = min, 1 = max). A
 * degenerate extent (max ≤ min — a constant column) maps EVERY value to the axis midline
 * `0.5` (so a constant dimension draws a flat mid-line, never a divide-by-zero NaN).
 * The result is clamped to `[0,1]` so an out-of-extent value (e.g. from a wider brush)
 * never escapes the axis.
 */
export function normalizeValue(v: number, ext: DimensionExtent): number {
  const span = ext.max - ext.min
  if (!(span > 0)) return 0.5
  const t = (v - ext.min) / span
  return t < 0 ? 0 : t > 1 ? 1 : t
}

/**
 * The x-position of each of `nDims` axes: evenly spaced at integer coordinates
 * `[0, 1, …, nDims-1]`. (The data-space x-unit is one dimension; ChartCanvas auto-fits
 * the `[0, nDims-1]` span to the pane.) `nDims ≤ 0` yields `[]`.
 */
export function axisXPositions(nDims: number): number[] {
  const out: number[] = []
  for (let d = 0; d < nDims; d++) out.push(d)
  return out
}

/**
 * The axis index nearest a world-x, or `null` when the pointer is farther than `threshold`
 * (data units) from every axis — i.e. a drag that started in the empty gap between axes
 * brushes nothing. Axes sit at integer x, so the nearest is `round(worldX)` when in range.
 */
export function nearestAxis(
  worldX: number,
  nDims: number,
  threshold = 0.35,
): number | null {
  if (nDims <= 0) return null
  const d = Math.round(worldX)
  if (d < 0 || d > nDims - 1) return null
  return Math.abs(worldX - d) <= threshold ? d : null
}

/**
 * The polyline VERTICES for one data row: `[[0, y0], [1, y1], …, [nDims-1, y_{n-1}]]`,
 * where `y_d` is the row's value on dimension `d` normalized against `extents[d]`. This is
 * the per-point geometry the View memoizes ONCE over the data (never per frame). A
 * dimension whose column is shorter than `row` contributes its midline (defensive; the
 * View always passes equal-length columns).
 */
export function pointVertices(
  row: number,
  columns: readonly Float32Array[],
  extents: readonly DimensionExtent[],
): [number, number][] {
  const out: [number, number][] = []
  for (let d = 0; d < columns.length; d++) {
    const col = columns[d]
    const v = row < col.length ? col[row] : Number.NaN
    const y = Number.isFinite(v) ? normalizeValue(v, extents[d]) : 0.5
    out.push([d, y])
  }
  return out
}

/**
 * Build the polyline vertices for EVERY rendered row at once (rows `0..count-1`). One
 * memoized pass over the data — the only per-point CPU work; the GPU draws thereafter.
 */
export function buildAllVertices(
  columns: readonly Float32Array[],
  extents: readonly DimensionExtent[],
  count: number,
): [number, number][][] {
  const out: [number, number][][] = new Array(count)
  for (let r = 0; r < count; r++) out[r] = pointVertices(r, columns, extents)
  return out
}

/**
 * The PRODUCE direction — an axis brush → the selected canonical point ids.
 *
 * Given ONE dimension's dense `values`, its `ext`, and a NORMALIZED brush range
 * `[loNorm, hiNorm]` (the two y-coordinates the user dragged on that axis, each in
 * `[0,1]`), return the canonical ids of every row (in `0..count-1`) whose value on this
 * dimension normalizes INTO the range. The range endpoints are sorted defensively, so the
 * caller may pass them in drag order.
 *
 * Ids come through the shared `mapRowsToIds` seam (NOT raw array indices): with no
 * `pointIds` it is identity (`id == row`), but a multi-source view supplies its own
 * `pointIds` and the produced selection is then correct across independently-ordered point
 * sets — exactly the seam the scatter/heatmap fan-out uses.
 */
export function idsInAxisBrush(
  values: Float32Array,
  ext: DimensionExtent,
  loNorm: number,
  hiNorm: number,
  count: number,
  pointIds?: Uint32Array | null,
): Uint32Array {
  const lo = Math.min(loNorm, hiNorm)
  const hi = Math.max(loNorm, hiNorm)
  const n = Math.min(count, values.length)
  const rows: number[] = []
  for (let r = 0; r < n; r++) {
    const t = normalizeValue(values[r], ext)
    if (t >= lo && t <= hi) rows.push(r)
  }
  return mapRowsToIds(Uint32Array.from(rows), pointIds)
}

/** Clamp a raw world-y (from the draw overlay) to the `[0,1]` axis domain. */
export function clampAxisY(worldY: number): number {
  return worldY < 0 ? 0 : worldY > 1 ? 1 : worldY
}
