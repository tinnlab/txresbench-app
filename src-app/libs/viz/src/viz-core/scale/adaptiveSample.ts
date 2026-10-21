// adaptiveSample.ts — the STABLE, DENSITY-ADAPTIVE, FIXED-BUDGET point sampler that replaces
// the uniform-stride LOD pick (research items #3 + #4). Pure math over typed arrays (no
// deck.gl / DOM / React) so it unit-tests in node. Generic naming — framework/domain-agnostic
// scale infra, mirroring chunking.ts / densityBin.ts.
//
// Three properties, each independently testable:
//
//   #3 STABLE SUPERSET — the sample is drawn from a FIXED order (a deterministic permutation
//      or the natural buffer order). Growing the budget/cap only ever APPENDS points to the
//      kept set — sample(k) ⊂ sample(k+1) — so an LOD level change never re-picks a disjoint
//      subset. That is what kills LOD "popping": the coarse overview is a strict subset of the
//      finer one, so refining only ADDS dots, never repositions them.
//
//   #4a DENSITY-ADAPTIVE PER-CELL CAP — instead of a single global stride (which spends the
//      whole budget on the densest blob and drops sparse structure), we bin points into a
//      uniform grid and keep at most `capPerCell` per cell. On-screen density is then roughly
//      uniform: a dense cluster is capped, a sparse thread of points survives intact.
//
//   #4b FIXED ON-SCREEN BUDGET — the total kept count is hard-capped at `budget` regardless of
//      N (the Potree idea: constant frame cost). Combined with the per-cell cap, the drawn
//      cloud is both bounded AND density-flattened.
//
// Because we walk the points in a FIXED order and the accept test for a point depends only on
// how many EARLIER-in-order points already landed in its cell (a monotonic counter) and the
// running total, raising either the per-cell cap OR the budget can only ever ADD points —
// never drop a previously-kept one. So the superset property holds across BOTH knobs.

import { cellForPoint, type DensityBounds } from '../density/densityBin'

/** Default permutation seed. Any fixed value yields a stable (reproducible) sample. */
export const DEFAULT_SAMPLE_SEED = 0x9e3779b9

// ── #3: stable order + prefix budget ────────────────────────────────────────────

/** A well-mixed 32-bit integer hash (two rounds of the xorshift-multiply finaliser). */
function hashU32(x: number): number {
  let h = x >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = h ^ (h >>> 16)
  return h >>> 0
}

/**
 * A stable per-point PRIORITY in [0, 1) — a deterministic hash of the point index (mixed with
 * `seed`). Points are sampled lowest-priority-first, so the same points are always chosen for a
 * given budget: a "fixed random permutation" without materialising one. Exported for callers
 * that want to rank without building the whole order.
 */
export function pointPriority(i: number, seed: number = DEFAULT_SAMPLE_SEED): number {
  return hashU32((i >>> 0) ^ (seed >>> 0)) / 4294967296
}

/**
 * A deterministic permutation of `[0, n)` — the indices sorted ascending by `pointPriority`
 * (ties broken by index, so it is a total order). `takeBudget(order, k)` is then a strict
 * PREFIX, which is the whole point: `takeBudget(order, k) ⊂ takeBudget(order, k+1)`.
 *
 * O(n log n) (a comparison sort) — this is the pure PRIMITIVE, used for the superset guarantee
 * and for small/medium N. The hot large-N path (`adaptiveSample` in buffer order) never sorts.
 */
export function stableSampleOrder(n: number, seed: number = DEFAULT_SAMPLE_SEED): Uint32Array {
  const total = Math.max(0, Math.floor(n))
  const idx = new Array<number>(total)
  for (let i = 0; i < total; i++) idx[i] = i
  idx.sort((a, b) => {
    const ka = pointPriority(a, seed)
    const kb = pointPriority(b, seed)
    if (ka < kb) return -1
    if (ka > kb) return 1
    return a - b
  })
  return Uint32Array.from(idx)
}

/**
 * The first `k` indices of a stable `order` — the budgeted sample. Because `order` is a fixed
 * permutation, this is a prefix, so `takeBudget(order, k)` is a subset of `takeBudget(order, j)`
 * for every `j ≥ k` (the stable-superset property). `k` is clamped to `[0, order.length]`.
 */
export function takeBudget(order: Uint32Array, k: number): Uint32Array {
  const kk = Math.max(0, Math.min(order.length, Math.floor(k)))
  return order.subarray(0, kk)
}

// ── #4a: per-cell cap from a budget ──────────────────────────────────────────────

/**
 * Choose a per-cell cap so that, spread over `cellCount` cells, the kept count lands near
 * `budget` (`ceil(budget / cellCount)`, guarded ≥ 1). `oversample` (> 1) lets denser cells keep
 * a few more than the flat share so the budget is actually reached when many cells are sparse.
 */
export function planAdaptiveCap(budget: number, cellCount: number, oversample = 1): number {
  const b = Math.max(0, Math.floor(budget))
  const cells = Math.max(1, Math.floor(cellCount))
  return Math.max(1, Math.ceil((b * Math.max(1, oversample)) / cells))
}

// ── #4: the sampler ──────────────────────────────────────────────────────────────

export interface AdaptiveSampleParams {
  /** interleaved xy positions, length N*2. */
  positions: Float32Array
  /** world-space extent the grid tiles over (the current viewport, or the full data bounds). */
  bounds: DensityBounds
  /** grid columns (over `bounds`). */
  gridW: number
  /** grid rows (over `bounds`). */
  gridH: number
  /** max kept points per grid cell (density flattening). */
  capPerCell: number
  /** hard cap on the total kept count (the fixed on-screen budget). */
  budget: number
  /**
   * The FIXED order to walk points in. When omitted, natural buffer order (`0,1,2,…`) is used
   * — itself a fixed order, so the superset property still holds and NO sort is paid (the
   * large-N default). Pass `stableSampleOrder(n, seed)` for a spatially-decorrelated pick.
   */
  order?: Uint32Array
}

export interface AdaptiveSampleResult {
  /** kept point indices into the ORIGINAL positions (a subset; length ≤ budget). */
  readonly indices: Uint32Array
  /** the per-cell cap applied. */
  readonly capPerCell: number
  /** the largest kept count in any single cell (≤ capPerCell) — observability. */
  readonly maxKeptPerCell: number
}

/**
 * Density-adaptive, budget-capped, stable sample of `positions` over `bounds`. Walks the points
 * in the fixed `order` (buffer order by default); keeps a point iff its cell is below
 * `capPerCell` AND the running total is below `budget`. Points outside `bounds` are dropped
 * (they aren't on screen). O(N) single pass, zero per-point allocation.
 *
 * Guarantees (see the module header): `indices.length ≤ budget`; no cell holds more than
 * `capPerCell`; and raising `capPerCell` or `budget` only ADDS indices (superset-stable).
 */
export function adaptiveSample(params: AdaptiveSampleParams): AdaptiveSampleResult {
  const { positions, bounds, order } = params
  const gridW = Math.max(1, Math.floor(params.gridW))
  const gridH = Math.max(1, Math.floor(params.gridH))
  const cap = Math.max(1, Math.floor(params.capPerCell))
  const budget = Math.max(0, Math.floor(params.budget))
  const n = positions.length >> 1
  const walk = order && order.length > 0 ? order : null
  const steps = walk ? walk.length : n

  const cellCounts = new Uint32Array(gridW * gridH)
  const kept = new Uint32Array(Math.min(n, budget))
  let keptLen = 0
  let maxKeptPerCell = 0

  for (let t = 0; t < steps && keptLen < budget; t++) {
    const i = walk ? walk[t] : t
    if (i < 0 || i >= n) continue
    const c = cellForPoint(positions[2 * i], positions[2 * i + 1], bounds, gridW, gridH)
    if (c < 0) continue // outside the viewport → not drawn
    const cur = cellCounts[c]
    if (cur >= cap) continue // cell already at its density cap
    cellCounts[c] = cur + 1
    if (cur + 1 > maxKeptPerCell) maxKeptPerCell = cur + 1
    kept[keptLen++] = i
  }

  return { indices: kept.subarray(0, keptLen), capPerCell: cap, maxKeptPerCell }
}

// ── gather: build a compact per-point buffer from a kept-index set ────────────────

/**
 * Copy the `elemsPerPoint` interleaved elements of each `indices[k]` out of `src` into a new,
 * tightly-packed typed array of the SAME subtype (length `indices.length * elemsPerPoint`).
 * This is how a kept-index set becomes a resident LOD attribute buffer (positions: epp 2;
 * a value/selected column: epp 1). A nullish `src` passes through unchanged (no allocation).
 */
export function gatherByIndices<
  T extends Float32Array | Float64Array | Uint8Array | Uint16Array | Uint32Array | Int32Array,
>(src: T | null | undefined, indices: Uint32Array, elemsPerPoint: number): T | null | undefined {
  if (!src) return src
  const epp = Math.max(1, Math.floor(elemsPerPoint))
  const Ctor = src.constructor as { new (length: number): T }
  const out = new Ctor(indices.length * epp)
  for (let k = 0; k < indices.length; k++) {
    const srcBase = indices[k] * epp
    const dstBase = k * epp
    for (let e = 0; e < epp; e++) out[dstBase + e] = src[srcBase + e]
  }
  return out
}
