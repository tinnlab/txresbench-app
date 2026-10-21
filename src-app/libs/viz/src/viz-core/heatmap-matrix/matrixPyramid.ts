// matrixPyramid.ts — pyramid PLANNING + the CPU REFERENCE downsample (the parity oracle
// the later GPU render-to-texture wave is checked against, DEC-27 oracle pattern). A big
// matrix is rendered as a multiscale image tiled along the COLUMN axis; zoom picks the
// level whose columns are ≈ 1 texel per screen pixel. This module computes, purely on the
// CPU over typed arrays (no deck.gl / WebGL / React):
//
//   • `planPyramid` — the level ladder: level 0 = base (full cols), each next level halves
//     cols (ceil), down to a 1-column overview; plus the column-axis TILE layout per level
//     (GPU textures cap at 32768, so cols are cut into `ceil(cols/tileSize)` tiles).
//   • `residentTilesFor` — which tiles overlap a visible column range (the GPU-memory bound).
//   • `downsampleLevel` — the next-coarser level: each output cell aggregates the (≤2) source
//     cells in its row. NO filter → arithmetic MEAN. WITH filter `[lo,hi]` → the FILTER-AWARE
//     aggregate: mean of only the in-range source population, carrying a `counts` plane so an
//     EMPTY bin (no in-range cell) is distinguishable from a real 0. Above the base, source
//     cells are weighted by their own `counts` (count-weighted mean), so every level holds the
//     true mean of the in-range BASE cells under it — the mathematically consistent recompute.
//   • `buildPyramid` — repeatedly `downsampleLevel` to materialize every level (index = level).
//     The O(N) CPU reference the GPU must match to within rounding.
//
// Domain-agnostic: a "matrix" is rows × columns of uint8 `value`s; nothing here names a domain.

import {
  matrixIndex,
  valueInRange,
  VALUE_MIN,
  VALUE_MAX,
  type MatrixData,
  type MatrixLevel,
  type MatrixValueRange,
} from './matrixTypes'

/** Max GPU texture dimension — the base column axis is tiled into `ceil(cols/this)` tiles. */
export const DEFAULT_TILE_SIZE = 32768

/** The coarsest level's column count: halving stops once `cols <= this` (a 1-column overview). */
export const MIN_LEVEL_COLS = 1

/**
 * The value written into an EMPTY bin's value plane (`counts === 0`). It is NOT a
 * distinguishable sentinel by value alone — `0` is also a legitimate value — so the empty
 * test is ALWAYS `counts[i] === 0`; this constant only fixes the (arbitrary, documented)
 * byte the GPU's "empty" texel and the oracle agree to write there.
 */
export const EMPTY_VALUE = VALUE_MIN

// ── Pyramid planning ─────────────────────────────────────────────────────────────

/** One planned pyramid level: its column count + the column-axis tile layout. */
export interface PyramidLevel {
  /** 0 = base (full-resolution columns); each higher index halves cols. */
  readonly level: number
  /** columns at this level. */
  readonly cols: number
  /** rows (unchanged across levels — the short axis fits in one tile). */
  readonly rows: number
  /** number of column tiles = `ceil(cols / tileSize)`. */
  readonly tiles: number
  /** per-tile column count (length `tiles`; sums to `cols`; last tile is the remainder). */
  readonly tileCols: number[]
}

export interface PlanPyramidParams {
  readonly rows: number
  readonly cols: number
  /** GPU texture-dim cap the column axis is tiled to (default 32768). */
  readonly tileSize?: number
}

/** The per-tile column widths for `cols` cut into `ceil(cols/tileSize)` tiles. */
function tileColumns(cols: number, tileSize: number): number[] {
  const out: number[] = []
  for (let c = 0; c < cols; c += tileSize) {
    out.push(Math.min(tileSize, cols - c))
  }
  return out
}

/**
 * Plan the pyramid level ladder for a `rows × cols` matrix. Level 0 is the base (full
 * `cols`); each subsequent level has `ceil(cols/2)` columns; halving STOPS when
 * `cols <= MIN_LEVEL_COLS` (so the coarsest level has exactly 1 column — a per-row
 * overview). Each level records its column-axis tile layout (`tiles`, `tileCols`); rows
 * are constant. A degenerate `cols <= 0` yields a single empty level.
 */
export function planPyramid(params: PlanPyramidParams): PyramidLevel[] {
  const rows = Math.max(0, Math.floor(params.rows))
  const tileSize = Math.max(1, Math.floor(params.tileSize ?? DEFAULT_TILE_SIZE))
  let cols = Math.max(0, Math.floor(params.cols))

  const levels: PyramidLevel[] = []
  let level = 0
  for (;;) {
    const tileCols = tileColumns(cols, tileSize)
    levels.push({ level, cols, rows, tiles: tileCols.length, tileCols })
    if (cols <= MIN_LEVEL_COLS) break
    cols = Math.ceil(cols / 2)
    level++
  }
  return levels
}

/** An inclusive column range `[start, end]` in a level's OWN column coordinates. */
export interface MatrixColRange {
  readonly start: number
  readonly end: number
}

/**
 * The tile indices that overlap `colRange` at `level` — the set that must be resident on
 * the GPU to draw that column span (the memory bound). `colRange` is in the level's own
 * column coordinates and is clamped to `[0, cols-1]`; tile `i` covers columns
 * `[i*tileSize, (i+1)*tileSize)`. Returns a contiguous ascending list (empty if the level
 * has no columns or the clamped range is empty).
 */
export function residentTilesFor(
  level: PyramidLevel,
  colRange: MatrixColRange,
  tileSize: number = DEFAULT_TILE_SIZE,
): number[] {
  const ts = Math.max(1, Math.floor(tileSize))
  if (level.cols <= 0 || level.tiles <= 0) return []
  const start = Math.max(0, Math.min(level.cols - 1, Math.floor(colRange.start)))
  const end = Math.max(0, Math.min(level.cols - 1, Math.floor(colRange.end)))
  if (end < start) return []
  const first = Math.min(level.tiles - 1, Math.floor(start / ts))
  const last = Math.min(level.tiles - 1, Math.floor(end / ts))
  const out: number[] = []
  for (let t = first; t <= last; t++) out.push(t)
  return out
}

// ── CPU reference downsample (the parity oracle) ──────────────────────────────────

/**
 * Downsample one level to the next coarser one: columns halved (`ceil(cols/2)`), rows
 * unchanged. Each output cell (row, j) aggregates the ≤2 source cells (row, 2j) and
 * (row, 2j+1) — the second is absent when the source width is odd (that output cell then
 * has a single source).
 *
 * Aggregation (the correctness contract the GPU pass must match):
 *   • Each source cell contributes with WEIGHT = its own `counts` when `src` is already a
 *     `MatrixLevel` (count-weighted mean → every level holds the true mean of the in-range
 *     BASE cells beneath it); a plain `MatrixData` source (the base) contributes weight 1.
 *   • A source cell participates iff `weight > 0` AND it passes `filter` (`lo<=value<=hi`,
 *     inclusive; no filter ⇒ all pass). NO filter ⇒ this is the plain arithmetic mean.
 *   • Output `value = round(Σ(value·weight) / Σweight)`; output `counts = Σweight`.
 *   • An output cell with NO participating source (all filtered out / all-empty children)
 *     is an EMPTY bin: `counts = 0`, `value = EMPTY_VALUE`. Test emptiness via `counts`.
 *
 * Re-checking `filter` above the base is a documented no-op (a mean of in-range values is
 * itself in range), kept for a single uniform rule; the `counts` weighting is what carries
 * the filtered population up the pyramid.
 */
export function downsampleLevel(
  src: MatrixData | MatrixLevel,
  filter?: MatrixValueRange,
): MatrixLevel & { readonly counts: Uint32Array } {
  const { rows, cols, values } = src
  const srcCounts = 'counts' in src ? src.counts : undefined
  const outCols = cols <= 0 ? 0 : Math.ceil(cols / 2)

  const outValues = new Uint8Array(rows * outCols)
  const outCounts = new Uint32Array(rows * outCols)

  for (let j = 0; j < outCols; j++) {
    const c0 = 2 * j
    const c1 = c0 + 1
    for (let row = 0; row < rows; row++) {
      let sum = 0
      let wsum = 0
      for (let sc = c0; sc <= c1 && sc < cols; sc++) {
        const si = matrixIndex(row, sc, rows)
        const weight = srcCounts ? srcCounts[si] : 1
        if (weight <= 0) continue
        const v = values[si]
        if (!valueInRange(v, filter)) continue
        sum += v * weight
        wsum += weight
      }
      const oi = matrixIndex(row, j, rows)
      if (wsum > 0) {
        let v = Math.round(sum / wsum)
        if (v < VALUE_MIN) v = VALUE_MIN
        else if (v > VALUE_MAX) v = VALUE_MAX
        outValues[oi] = v
        outCounts[oi] = wsum
      } else {
        outValues[oi] = EMPTY_VALUE
        outCounts[oi] = 0
      }
    }
  }

  return { rows, cols: outCols, values: outValues, counts: outCounts }
}

/**
 * Wrap a base `MatrixData` as level 0: values as-is, and NO `counts` plane. Level 0 has full base
 * population (every cell present, weight 1) and its per-cell filter is applied at RENDER, so an
 * explicit all-ones `counts` array would be pure waste — a 2000×50000 base is ~400 MB of `Uint32`
 * holding nothing but `1`. An ABSENT counts plane IS the "every cell covered / weight 1" marker:
 *   • `downsampleLevel` reads a source with no `counts` as weight 1 (its `srcCounts ? … : 1` rule),
 *     so level 0 → level 1 aggregates byte-identically to the old all-ones plane, and every level
 *     ≥ 1 (which DOES carry a real `counts` plane) is unchanged.
 *   • the texture packer reads an absent `counts` as fully covered (coverage byte ≥ 1).
 */
function baseAsLevel(base: MatrixData): MatrixLevel {
  return { rows: base.rows, cols: base.cols, values: base.values }
}

/**
 * Build the whole pyramid: level 0 is the base (values unchanged, NO `counts` plane — the base
 * filter is applied per-cell at RENDER, not baked into the base bytes, so every base cell counts
 * as covered/weight-1; see `baseAsLevel`), then repeated
 * `downsampleLevel(_, filter)` until the coarsest level has `MIN_LEVEL_COLS` columns. The
 * returned array is indexed by level and its length equals `planPyramid(...).length` for
 * the same shape. This is the O(N) CPU reference; the GPU builds each level in a
 * render-to-texture pass and must match it to within rounding.
 *
 * INVARIANT (a good parity check): a full-range filter `[0,255]` selects every base cell,
 * so `buildPyramid(base, {lo:0,hi:255})` is byte-identical to `buildPyramid(base)`.
 */
export function buildPyramid(base: MatrixData, filter?: MatrixValueRange): MatrixLevel[] {
  const levels: MatrixLevel[] = [baseAsLevel(base)]
  let cur: MatrixLevel = levels[0]
  while (cur.cols > MIN_LEVEL_COLS) {
    cur = downsampleLevel(cur, filter)
    levels.push(cur)
  }
  return levels
}
