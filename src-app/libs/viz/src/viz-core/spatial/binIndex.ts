// binIndex.ts — a PURE counting-sort spatial index over interleaved xy positions: "which point
// indices fell into this grid cell?" It is the raster-mode answer to overlap tooltips — raster
// draws ONE BitmapLayer quad (no per-point picking), so to list the individual points under the
// cursor we keep a bin→indices membership index. Built lazily (first hover) and off the paint
// path; additive to the retained positions.
//
// Layout (CSR / counting sort): `binOffsets[b]..binOffsets[b+1]` slices `pointIndices` to the
// point indices in bin `b` (row-major `by*bx + bx`). `binOffsets` is sized by BIN count (bounded
// by raster resolution); `pointIndices` is one Uint32 PER POINT (the 4B/point) — 4 bytes because
// at 2M–10M points the index values exceed Uint16 range.
//
// No deck.gl / DOM / React — plain typed-array math, node-unit-testable. Query is O(points in the
// touched bins), never O(N); the caller filters by exact distance + orders nearest-first.

export interface BinBounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export interface BinIndex {
  readonly bx: number
  readonly by: number
  readonly bounds: BinBounds
  /** prefix-sum offsets, length `bx*by + 1`; `binOffsets[bx*by] === N`. */
  readonly binOffsets: Uint32Array
  /** point indices grouped by bin, length `N`. */
  readonly pointIndices: Uint32Array
  /** the positions the index was built over (needed for the exact-radius refine in `queryRadius`). */
  readonly positions: Float32Array
}

/** Cell column for a world x, clamped to `[0, bx-1]`. Degenerate span (maxX==minX) → column 0.
 *  A non-finite coordinate (NaN/±Infinity — e.g. a missing value in scientific data) is placed in
 *  bin 0 rather than dropped, so the counting sort stays consistent (`binOffsets[last]===N`); the
 *  exact-distance refine in `queryRadius` then excludes it from any hover (a NaN distance fails ≤r). */
function cellX(b: BinBounds, bx: number, x: number): number {
  if (!Number.isFinite(x)) return 0
  const span = b.maxX - b.minX
  if (!(span > 0)) return 0
  const c = Math.floor(((x - b.minX) / span) * bx)
  return c < 0 ? 0 : c >= bx ? bx - 1 : c
}
function cellY(b: BinBounds, by: number, y: number): number {
  if (!Number.isFinite(y)) return 0
  const span = b.maxY - b.minY
  if (!(span > 0)) return 0
  const c = Math.floor(((y - b.minY) / span) * by)
  return c < 0 ? 0 : c >= by ? by - 1 : c
}

/**
 * Build the bin membership index. `positions` is interleaved xy, length `N*2`. `bx`/`by` are the
 * grid dims (each coerced to ≥1). Points outside `bounds` are clamped into the edge bins (bounds is
 * normally the data extent, so this only guards float error). O(N) two-pass counting sort.
 */
export function buildBinIndex(
  positions: Float32Array,
  bounds: BinBounds,
  bx: number,
  by: number,
): BinIndex {
  const gx = Math.max(1, Math.floor(bx))
  const gy = Math.max(1, Math.floor(by))
  const n = positions.length >>> 1
  const nbins = gx * gy

  const binOffsets = new Uint32Array(nbins + 1)
  // pass 1: count per bin (into binOffsets[b+1] so the prefix sum lands in place).
  for (let i = 0; i < n; i++) {
    const cx = cellX(bounds, gx, positions[2 * i])
    const cy = cellY(bounds, gy, positions[2 * i + 1])
    binOffsets[cy * gx + cx + 1]++
  }
  // prefix sum → start offsets.
  for (let b = 0; b < nbins; b++) binOffsets[b + 1] += binOffsets[b]
  // pass 2: scatter indices using a moving cursor per bin.
  const cursor = binOffsets.slice(0, nbins)
  const pointIndices = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const cx = cellX(bounds, gx, positions[2 * i])
    const cy = cellY(bounds, gy, positions[2 * i + 1])
    const b = cy * gx + cx
    pointIndices[cursor[b]++] = i
  }
  return { bx: gx, by: gy, bounds, binOffsets, pointIndices, positions }
}

/** Row-major bin id for a world point (clamped). */
export function binOf(idx: BinIndex, x: number, y: number): number {
  const cx = cellX(idx.bounds, idx.bx, x)
  const cy = cellY(idx.bounds, idx.by, y)
  return cy * idx.bx + cx
}

/** The point indices in a single bin (a view into `pointIndices`; do not mutate). */
export function indicesInBin(idx: BinIndex, bin: number): Uint32Array {
  if (bin < 0 || bin >= idx.bx * idx.by) return EMPTY
  return idx.pointIndices.subarray(idx.binOffsets[bin], idx.binOffsets[bin + 1])
}

const EMPTY = new Uint32Array(0)

/**
 * Gather all point indices in the bins overlapping the world rect
 * `[worldX ± worldRadius, worldY ± worldRadius]`. A hover radius can straddle bin boundaries, so we
 * union every touched cell (the caller filters by EXACT distance + orders). Returns a fresh
 * Uint32Array (possibly empty). O(points in the touched bins).
 */
export function indicesNear(
  idx: BinIndex,
  worldX: number,
  worldY: number,
  worldRadius: number,
): Uint32Array {
  const r = Math.max(0, worldRadius)
  const cxLo = cellX(idx.bounds, idx.bx, worldX - r)
  const cxHi = cellX(idx.bounds, idx.bx, worldX + r)
  const cyLo = cellY(idx.bounds, idx.by, worldY - r)
  const cyHi = cellY(idx.bounds, idx.by, worldY + r)
  // First tally the total so we allocate once.
  let total = 0
  for (let cy = cyLo; cy <= cyHi; cy++) {
    for (let cx = cxLo; cx <= cxHi; cx++) {
      const b = cy * idx.bx + cx
      total += idx.binOffsets[b + 1] - idx.binOffsets[b]
    }
  }
  if (total === 0) return EMPTY
  const out = new Uint32Array(total)
  let w = 0
  for (let cy = cyLo; cy <= cyHi; cy++) {
    for (let cx = cxLo; cx <= cxHi; cx++) {
      const b = cy * idx.bx + cx
      for (let p = idx.binOffsets[b]; p < idx.binOffsets[b + 1]; p++) out[w++] = idx.pointIndices[p]
    }
  }
  return out
}

/**
 * EXACT circular query: the point indices within euclidean world distance `radius` of
 * `(worldX, worldY)`. Coarse-gathers the touched bins (`indicesNear`), then refines to the true
 * circle — so a coarse grid never over-reports overlap. This is the shared overlap-set primitive
 * for both point mode (radius = the point's screen radius in world units) and raster mode
 * (radius ≈ one bin). O(points in the touched bins).
 */
export function queryRadius(
  idx: BinIndex,
  worldX: number,
  worldY: number,
  radius: number,
): Uint32Array {
  const candidates = indicesNear(idx, worldX, worldY, radius)
  const r2 = radius * radius
  const pos = idx.positions
  // count exact hits, then fill (avoids a growable array).
  let hits = 0
  for (let k = 0; k < candidates.length; k++) {
    const i = candidates[k]
    const dx = pos[2 * i] - worldX
    const dy = pos[2 * i + 1] - worldY
    if (dx * dx + dy * dy <= r2) hits++
  }
  if (hits === 0) return EMPTY
  const out = new Uint32Array(hits)
  let w = 0
  for (let k = 0; k < candidates.length; k++) {
    const i = candidates[k]
    const dx = pos[2 * i] - worldX
    const dy = pos[2 * i + 1] - worldY
    if (dx * dx + dy * dy <= r2) out[w++] = i
  }
  return out
}
