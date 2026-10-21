// selection.ts — point SETS as a packed bitmask + polygon hit-testing (ITEM-6).
// Per DATA_STORAGE_REDESIGN §3.9: cell sets are a packed `Uint32Array[⌈N/32⌉]`
// indexed by the dense point index; membership = O(1) bit test; union/intersection/
// difference = bitwise OR/AND/ANDNOT over the words; count = popcount. This
// replaces the legacy `HashSet<string>` + `new Set(strings).intersection(...)`.

import { polygonContains } from 'd3-polygon'
import type { PointIndex } from '../spatial/pointIndex'

/** A packed bitmask over N points (dense index space). */
export class IndexMask {
  readonly words: Uint32Array
  readonly length: number

  constructor(length: number, words?: Uint32Array) {
    this.length = length
    this.words = words ?? new Uint32Array((length + 31) >>> 5)
  }

  static fromIndices(length: number, indices: Iterable<number>): IndexMask {
    const m = new IndexMask(length)
    for (const i of indices) m.set(i)
    return m
  }

  set(i: number): void {
    this.words[i >>> 5] |= 1 << (i & 31)
  }

  clear(i: number): void {
    this.words[i >>> 5] &= ~(1 << (i & 31))
  }

  has(i: number): boolean {
    return (this.words[i >>> 5] & (1 << (i & 31))) !== 0
  }

  /** Number of set bits (selected points). */
  count(): number {
    let c = 0
    const w = this.words
    for (let k = 0; k < w.length; k++) c += popcount32(w[k])
    return c
  }

  isEmpty(): boolean {
    const w = this.words
    for (let k = 0; k < w.length; k++) if (w[k] !== 0) return false
    return true
  }

  union(other: IndexMask): IndexMask {
    const out = new IndexMask(this.length)
    for (let k = 0; k < this.words.length; k++) out.words[k] = this.words[k] | other.words[k]
    return out
  }

  intersect(other: IndexMask): IndexMask {
    const out = new IndexMask(this.length)
    for (let k = 0; k < this.words.length; k++) out.words[k] = this.words[k] & other.words[k]
    return out
  }

  /** this AND NOT other. */
  difference(other: IndexMask): IndexMask {
    const out = new IndexMask(this.length)
    for (let k = 0; k < this.words.length; k++) out.words[k] = this.words[k] & ~other.words[k]
    return out
  }

  /** Materialise the set indices (for downstream emit / small selections). */
  toIndices(): Uint32Array {
    const out = new Uint32Array(this.count())
    let j = 0
    for (let i = 0; i < this.length; i++) if (this.has(i)) out[j++] = i
    return out
  }
}

/** Hamming weight of a 32-bit word. */
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >>> 24
}

/**
 * Select cells whose position falls inside a screen/world polygon. The CPU
 * point-in-polygon test is confined to the lasso's bounding box so it stays cheap
 * even at 10M total cells. Candidate source precedence:
 *
 *   1. an explicit `candidates` set (e.g. a caller-supplied region pick) — used verbatim;
 *   2. else a prebuilt KD-tree `index` — `index.range(polygonBBox)` is an O(log N + k)
 *      bbox query that REPLACES the O(N) coordinate scan; the `polygonContains` test
 *      then runs only on those O(k) candidates;
 *   3. else a full O(N) `polygonContains` scan (back-compat fallback).
 *
 * A point OUTSIDE the polygon's bbox can never be inside the polygon, so narrowing to
 * the bbox (whether by index or by scan) changes NO result: the returned mask is
 * BYTE-IDENTICAL to the full-N scan. `positions` is the interleaved xy Float32Array;
 * the polygon is in the SAME coordinate space as the positions.
 */
export function selectInPolygon(
  positions: Float32Array,
  polygon: readonly [number, number][],
  totalCells: number,
  candidates?: Iterable<number>,
  index?: PointIndex,
): IndexMask {
  const mask = new IndexMask(totalCells)
  if (polygon.length < 3) return mask
  const test = (i: number) => {
    const x = positions[i * 2]
    const y = positions[i * 2 + 1]
    if (polygonContains(polygon as [number, number][], [x, y])) mask.set(i)
  }
  // KD-tree fast path: bbox candidates via O(log N + k) range query instead of the
  // O(N) coordinate scan. Explicit `candidates` still win (a tighter caller source).
  let cands = candidates
  if (!cands && index) {
    const [x0, y0, x1, y1] = polygonBoundingBox(polygon)
    cands = index.range(x0, y0, x1, y1)
  }
  if (cands) {
    for (const i of cands) test(i)
  } else {
    for (let i = 0; i < totalCells; i++) test(i)
  }
  return mask
}

/** Axis-aligned bounding box `[x0,y0,x1,y1]` of a polygon ring (min/max of its vertices). */
export function polygonBoundingBox(
  polygon: readonly (readonly [number, number])[],
): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of polygon) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/**
 * Yield the dense indices whose position falls inside an axis-aligned bbox — the
 * cheap coordinate pre-filter that narrows an expensive point-in-polygon test to a
 * lasso's bounding box (a point OUTSIDE the bbox can never be inside the polygon, so
 * skipping it changes no result). A single scalar-compare scan; the caller runs the
 * costly `polygonContains` only on what this yields, so a lasso is O(bbox) not O(N)
 * `polygonContains` calls. A real deck.gl `pickObjects(bbox)` region pick can supply
 * a tighter candidate set to `selectInPolygon` directly in place of this.
 */
export function* bboxCandidates(
  positions: Float32Array,
  totalCells: number,
  bbox: readonly [number, number, number, number],
): Generator<number> {
  const [x0, y0, x1, y1] = bbox
  for (let i = 0; i < totalCells; i++) {
    const x = positions[i * 2]
    const y = positions[i * 2 + 1]
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) yield i
  }
}

/**
 * Select cells inside an axis-aligned box [x0,y0,x1,y1] (world space). An axis-aligned
 * box IS exactly a KD-tree range query, so when a prebuilt `index` is supplied (and no
 * tighter explicit `candidates` set is), `index.range(...)` returns the exact membership
 * directly in O(log N + k) — no per-point scalar scan at all. The result is
 * BYTE-IDENTICAL to the O(N) scan (same inclusive `>=`/`<=` box test; the index parks
 * non-finite points, which the scan's comparisons also reject). Otherwise the scan (over
 * `candidates` if given, else all N) is used.
 */
export function selectInBox(
  positions: Float32Array,
  box: readonly [number, number, number, number],
  totalCells: number,
  candidates?: Iterable<number>,
  index?: PointIndex,
): IndexMask {
  const [ax, ay, bx, by] = box
  const x0 = Math.min(ax, bx)
  const x1 = Math.max(ax, bx)
  const y0 = Math.min(ay, by)
  const y1 = Math.max(ay, by)
  const mask = new IndexMask(totalCells)
  // KD-tree fast path: the box selection is exactly the range query — O(log N + k).
  if (index && !candidates) {
    const hits = index.range(x0, y0, x1, y1)
    for (let k = 0; k < hits.length; k++) mask.set(hits[k])
    return mask
  }
  const test = (i: number) => {
    const x = positions[i * 2]
    const y = positions[i * 2 + 1]
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) mask.set(i)
  }
  if (candidates) {
    for (const i of candidates) test(i)
  } else {
    for (let i = 0; i < totalCells; i++) test(i)
  }
  return mask
}
