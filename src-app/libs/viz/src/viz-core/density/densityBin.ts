// densityBin.ts — pure bin-planning MATH + the CPU density oracle for the "aggregate
// then shade" render tier (research item #1). At the 10M+/zoomed-out scale a screen is
// only ~2M pixels, so drawing every point is pointless overdraw: instead we bin points
// to a VIEWPORT-SIZED grid (one cell ≈ `cellPx × cellPx` screen pixels) and colormap the
// per-cell aggregate — cost bounded by CELLS, not points.
//
// This module is the framework-agnostic, deterministic core:
//   • `planDensityGrid` — viewport px + cell px → grid dims (the cost bound);
//   • `cellForPoint` — project one point into its grid cell (row-major index, −1 = outside);
//   • `binDensity` — the CPU ORACLE: bin positions+values → per-cell {count, sum}. This is
//     the parity reference for any GPU bin pass (mirrors how color.ts is the oracle for the
//     GPU colormap layer, and cpuGroupReduce for gpu/groupReduce), and the data source for
//     the CPU/BitmapLayer render fallback;
//   • `binWeight` — the per-cell count-or-mean weight rule (the production shading in
//     `cpuRaster.ts` colors by this; the actual RGBA shading lives there, not here).
//
// Domain-agnostic by construction: "mean of the value column per bin" IS "mean expression
// per bin" for the single-cell use, "mean intensity per bin" for imaging, etc. — the module
// never names a domain.

import type { PackMeta, PackedPositions } from './quantize'

// ── Shapes ────────────────────────────────────────────────────────────────────

/** World-space extent the grid tiles over (the binning domain). */
export interface DensityBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

/** A planned density grid: dims + the (guarded) cell size that produced them. */
export interface DensityGrid {
  /** columns = ceil(viewportW / cellPx). */
  readonly gridW: number
  /** rows = ceil(viewportH / cellPx). */
  readonly gridH: number
  /** the effective cell edge in screen pixels (guarded to ≥ 1). */
  readonly cellPx: number
  /** total cells = gridW × gridH (the render cost bound). */
  readonly cellCount: number
}

/** Per-cell reduction, each array length `gridW × gridH` (row-major). */
export interface DensityBins {
  /** number of points that fell in the cell. */
  readonly count: Float32Array
  /** Σ of the (finite) value column over the cell's points. */
  readonly sum: Float32Array
}

/** How a cell's aggregate maps to a color weight. */
export type DensityMode = 'count' | 'mean'

// ── Grid planning ───────────────────────────────────────────────────────────────

/**
 * Plan the viewport-sized grid: one cell ≈ `cellPx × cellPx` screen pixels, so the number
 * of cells (and thus the render + readback cost) scales with the SCREEN, never with the
 * point count. `cellPx` is guarded to ≥ 1 and the dims to ≥ 1 (a degenerate 0-size viewport
 * still yields a 1×1 grid rather than an empty one).
 */
export function planDensityGrid(
  viewportW: number,
  viewportH: number,
  cellPx: number,
): DensityGrid {
  const cell = Math.max(1, cellPx)
  const w = Math.max(0, viewportW)
  const h = Math.max(0, viewportH)
  const gridW = Math.max(1, Math.ceil(w / cell))
  const gridH = Math.max(1, Math.ceil(h / cell))
  return { gridW, gridH, cellPx: cell, cellCount: gridW * gridH }
}

// ── Point → cell projection ─────────────────────────────────────────────────────

/**
 * Project a world-space point into its grid cell, returning the ROW-MAJOR cell index
 * (`row * gridW + col`) or `−1` when the point lies outside `bounds` (skipped — matches
 * `binDensity`). A point exactly on the `max` edge is clamped into the last cell (in-bounds).
 * A degenerate axis (`max == min`) collapses that axis to column/row 0.
 */
export function cellForPoint(
  x: number,
  y: number,
  bounds: DensityBounds,
  gridW: number,
  gridH: number,
): number {
  const spanX = bounds.maxX - bounds.minX
  const spanY = bounds.maxY - bounds.minY

  let col: number
  if (spanX <= 0) {
    col = 0
  } else {
    const nx = (x - bounds.minX) / spanX
    if (nx < 0 || nx > 1) return -1
    col = Math.min(gridW - 1, Math.floor(nx * gridW))
  }

  let row: number
  if (spanY <= 0) {
    row = 0
  } else {
    const ny = (y - bounds.minY) / spanY
    if (ny < 0 || ny > 1) return -1
    row = Math.min(gridH - 1, Math.floor(ny * gridH))
  }

  return row * gridW + col
}

/** Compute the world-space extent of an interleaved xy positions buffer (length N*2). */
export function boundsForPositions(positions: Float32Array): DensityBounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i]
    const y = positions[i + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) {
    // empty / all-non-finite → a unit box so downstream spans are well-defined.
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  }
  return { minX, minY, maxX, maxY }
}

// ── CPU oracle: bin positions + values → per-cell {count, sum} ───────────────────

/**
 * The correctness reference (DEC-27 oracle pattern). Bins interleaved xy `positions`
 * (length N*2) and a parallel `values` column (length N) over `bounds` into a
 * `gridW × gridH` grid. `count[cell]` = points in the cell; `sum[cell]` = Σ of the finite
 * values of those points (a non-finite value still COUNTS its point but adds nothing to the
 * sum, so `mean = sum/count` stays finite). Out-of-bounds points are skipped. Accumulates
 * in float64 for accuracy, then narrows to Float32Array to match a GPU readback's shape.
 */
export function binDensity(
  positions: Float32Array,
  values: Float32Array | null | undefined,
  bounds: DensityBounds,
  gridW: number,
  gridH: number,
): DensityBins {
  const nCells = Math.max(0, gridW) * Math.max(0, gridH)
  const count = new Float64Array(nCells)
  const sum = new Float64Array(nCells)
  const n = positions.length >> 1
  for (let i = 0; i < n; i++) {
    const cell = cellForPoint(positions[i * 2], positions[i * 2 + 1], bounds, gridW, gridH)
    if (cell < 0) continue
    count[cell] += 1
    const v = values ? values[i] : 0
    if (Number.isFinite(v)) sum[cell] += v
  }
  return { count: Float32Array.from(count), sum: Float32Array.from(sum) }
}

/**
 * The PACKED-position twin of `binDensity` (PERFORMANCE_PLAN.md Phase 2, B2). Bins a 16-bit
 * packed cloud (`quantize.ts`) into the same `gridW × gridH` count grid, decoding each point's
 * world coord ON THE FLY from the `Uint16` codes (`origin + code * scale`) — so it never
 * materializes an 8 B/point Float32 array. The count grid is identical to `binDensity` on the
 * Float32 SOURCE up to the quantization step (`span / 65535`): a point can only cross a bin edge
 * when its true coord sits within one code step of that edge. `values` is optional (a `null`
 * value column bins COUNTS only, which is what the CPU raster uses). Accumulates in float64 then
 * narrows to Float32Array, matching `binDensity`'s output shape.
 */
export function binDensityPacked(
  packed: Uint16Array,
  meta: PackMeta,
  values: Float32Array | null | undefined,
  bounds: DensityBounds,
  gridW: number,
  gridH: number,
): DensityBins {
  const nCells = Math.max(0, gridW) * Math.max(0, gridH)
  const count = new Float64Array(nCells)
  const sum = new Float64Array(nCells)
  const n = packed.length >> 1
  for (let i = 0; i < n; i++) {
    // Inline decode (mirrors quantize.readX/readY) — a type-only import keeps the modules acyclic.
    const x = meta.originX + packed[i * 2] * meta.scaleX
    const y = meta.originY + packed[i * 2 + 1] * meta.scaleY
    const cell = cellForPoint(x, y, bounds, gridW, gridH)
    if (cell < 0) continue
    count[cell] += 1
    const v = values ? values[i] : 0
    if (Number.isFinite(v)) sum[cell] += v
  }
  return { count: Float32Array.from(count), sum: Float32Array.from(sum) }
}

/** Bin a {@link PackedPositions} directly (its `packed` + embedded meta). Convenience wrapper. */
export function binPacked(
  source: PackedPositions,
  values: Float32Array | null | undefined,
  bounds: DensityBounds,
  gridW: number,
  gridH: number,
): DensityBins {
  return binDensityPacked(source.packed, source, values, bounds, gridW, gridH)
}

// ── Per-cell aggregate weight ─────────────────────────────────────────────────────

/**
 * The per-cell color weight for a mode: `count` in count mode; `sum/count` (0 when the cell
 * is empty) in mean mode. The single rule the production shading path (`cpuRaster.ts`) and the
 * bin tests both compute means by.
 */
export function binWeight(count: number, sum: number, mode: DensityMode): number {
  if (mode === 'count') return count
  return count > 0 ? sum / count : 0
}
