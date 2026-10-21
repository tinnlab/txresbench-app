// pointIndex.test.ts — correctness proof for the static KD-tree (research item #2).
//
// The core proof is a brute-force O(N) ORACLE cross-check on a large seeded random
// cloud: for every range/within/nearest query, the KD-tree result must match a
// naive linear scan EXACTLY (as a set for range/within; as a minimal distance for
// nearest, which tolerates ties among coincident points). Plus known-answer small
// sets and the degenerate contracts (N=0/1, all-same-point, NaN parking, bbox edge).

import { describe, it, expect } from 'vitest'
import { buildPointIndex, polygonCandidates, type PointIndex } from './pointIndex'
import { selectInPolygon, polygonBoundingBox } from '../data/selection'

// Deterministic RNG so the large cross-check is reproducible without hand-listing points.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── brute-force oracles (the ground truth the KD-tree is checked against) ─────

function isFinitePoint(pos: Float32Array, i: number): boolean {
  return Number.isFinite(pos[2 * i]) && Number.isFinite(pos[2 * i + 1])
}

function oracleRange(pos: Float32Array, n: number, a: number, b: number, c: number, d: number): Set<number> {
  const out = new Set<number>()
  for (let i = 0; i < n; i++) {
    if (!isFinitePoint(pos, i)) continue
    const x = pos[2 * i]
    const y = pos[2 * i + 1]
    if (x >= a && x <= c && y >= b && y <= d) out.add(i)
  }
  return out
}

function oracleWithin(pos: Float32Array, n: number, qx: number, qy: number, r: number): Set<number> {
  const out = new Set<number>()
  const r2 = r * r
  for (let i = 0; i < n; i++) {
    if (!isFinitePoint(pos, i)) continue
    const dx = pos[2 * i] - qx
    const dy = pos[2 * i + 1] - qy
    if (dx * dx + dy * dy <= r2) out.add(i)
  }
  return out
}

function oracleNearestD2(pos: Float32Array, n: number, qx: number, qy: number): number {
  let best = Infinity
  for (let i = 0; i < n; i++) {
    if (!isFinitePoint(pos, i)) continue
    const dx = pos[2 * i] - qx
    const dy = pos[2 * i + 1] - qy
    const d2 = dx * dx + dy * dy
    if (d2 < best) best = d2
  }
  return best
}

function d2At(pos: Float32Array, i: number, qx: number, qy: number): number {
  const dx = pos[2 * i] - qx
  const dy = pos[2 * i + 1] - qy
  return dx * dx + dy * dy
}

function asSet(arr: Uint32Array): Set<number> {
  return new Set(Array.from(arr))
}

// ── known small point set ─────────────────────────────────────────────────────
//   index: 0    1    2    3    4     5
//   x:     0    10   10   20   -5    10
//   y:     0    0    10   20   -5    0     (5 duplicates (10,0) at ids 1 and 5)
const SMALL = new Float32Array([0, 0, 10, 0, 10, 10, 20, 20, -5, -5, 10, 0])

describe('buildPointIndex — known small set', () => {
  const idx = buildPointIndex(SMALL, 2)

  it('reports the indexed size', () => {
    expect(idx.size).toBe(6)
  })

  it('range returns exactly the points inside an inclusive bbox', () => {
    // bbox [-1,-1]..[11,11] → ids 0,1,2,5 (the (10,0) duplicate 1 & 5, plus (0,0),(10,10))
    expect(asSet(idx.range(-1, -1, 11, 11))).toEqual(new Set([0, 1, 2, 5]))
    // whole space
    expect(asSet(idx.range(-100, -100, 100, 100))).toEqual(new Set([0, 1, 2, 3, 4, 5]))
    // empty bbox
    expect(idx.range(100, 100, 200, 200).length).toBe(0)
  })

  it('range is inclusive on an exact edge coincidence', () => {
    // A point sitting exactly on the bbox max edge must be included.
    // (10,10) at id 2: bbox [0,0]..[10,10] includes ids 0,1,2,5.
    expect(asSet(idx.range(0, 0, 10, 10))).toEqual(new Set([0, 1, 2, 5]))
    // degenerate zero-area bbox exactly on a point → that point (both dupes).
    expect(asSet(idx.range(10, 0, 10, 0))).toEqual(new Set([1, 5]))
  })

  it('within returns exactly the points inside a radius', () => {
    // r=1 around (0,0) → only id 0
    expect(asSet(idx.within(0, 0, 1))).toEqual(new Set([0]))
    // r=10 around (10,0), inclusive: ids 1,5 (d=0), 2 (10,10) d=10, and 0 (0,0) d=10.
    expect(asSet(idx.within(10, 0, 10))).toEqual(new Set([0, 1, 2, 5]))
    // huge radius → everything
    expect(asSet(idx.within(0, 0, 1000)).size).toBe(6)
  })

  it('nearest returns the single closest index', () => {
    expect(idx.nearest(0, 0)).toBe(0)
    expect(idx.nearest(19, 21)).toBe(3) // near (20,20)
    expect(idx.nearest(-4, -6)).toBe(4) // near (-5,-5)
    // Query near the duplicate (10,0): either dupe (1 or 5) is a correct answer.
    expect([1, 5]).toContain(idx.nearest(11, 0))
  })
})

// ── degenerate / edge contracts ───────────────────────────────────────────────

describe('degenerate inputs', () => {
  it('N=0 → empty results, nearest is -1', () => {
    const idx = buildPointIndex(new Float32Array(0))
    expect(idx.size).toBe(0)
    expect(idx.range(-1, -1, 1, 1).length).toBe(0)
    expect(idx.within(0, 0, 5).length).toBe(0)
    expect(idx.nearest(0, 0)).toBe(-1)
  })

  it('N=1 → the single point answers every containing query', () => {
    const idx = buildPointIndex(new Float32Array([3, 4]))
    expect(idx.size).toBe(1)
    expect(idx.nearest(0, 0)).toBe(0)
    expect(asSet(idx.range(0, 0, 5, 5))).toEqual(new Set([0]))
    expect(idx.range(10, 10, 20, 20).length).toBe(0)
    expect(asSet(idx.within(3, 4, 0.001))).toEqual(new Set([0]))
    expect(idx.within(0, 0, 1).length).toBe(0)
  })

  it('all points identical → range/within return the whole set, nearest is one of them', () => {
    const N = 500
    const pos = new Float32Array(N * 2)
    for (let i = 0; i < N; i++) {
      pos[2 * i] = 7
      pos[2 * i + 1] = -2
    }
    const idx = buildPointIndex(pos, 16)
    expect(idx.size).toBe(N)
    expect(idx.range(7, -2, 7, -2).length).toBe(N)
    expect(idx.within(7, -2, 0).length).toBe(N)
    const near = idx.nearest(7.5, -2.5)
    expect(near).toBeGreaterThanOrEqual(0)
    expect(near).toBeLessThan(N)
  })

  it('NaN / non-finite coords are PARKED (never in any result)', () => {
    // ids: 0 finite, 1 NaN-x, 2 finite, 3 Infinity-y, 4 finite
    const pos = new Float32Array([0, 0, NaN, 5, 10, 10, 20, Infinity, -5, -5])
    const idx = buildPointIndex(pos, 2)
    expect(idx.size).toBe(3) // only ids 0,2,4 indexed
    const all = asSet(idx.range(-100, -100, 100, 100))
    expect(all).toEqual(new Set([0, 2, 4]))
    // a query landing near the parked NaN point still returns only finite points
    expect([0, 2, 4]).toContain(idx.nearest(0, 5))
    expect(asSet(idx.within(0, 0, 1000))).toEqual(new Set([0, 2, 4]))
  })
})

// ── large brute-force cross-check (the correctness proof) ─────────────────────

describe('brute-force oracle cross-check (100k seeded random points)', () => {
  const N = 100_000
  const rng = mulberry32(0xc0ffee)
  const pos = new Float32Array(N * 2)
  for (let i = 0; i < N; i++) {
    pos[2 * i] = rng() * 2000 - 1000 // x ∈ [-1000, 1000)
    pos[2 * i + 1] = rng() * 2000 - 1000
  }
  const idx: PointIndex = buildPointIndex(pos, 64)

  it('indexes all N finite points', () => {
    expect(idx.size).toBe(N)
  })

  it('range matches the O(N) oracle for many random boxes', () => {
    const q = mulberry32(1)
    for (let t = 0; t < 40; t++) {
      const cx = q() * 2000 - 1000
      const cy = q() * 2000 - 1000
      const hw = q() * 300
      const hh = q() * 300
      const a = cx - hw
      const b = cy - hh
      const c = cx + hw
      const d = cy + hh
      const got = asSet(idx.range(a, b, c, d))
      const want = oracleRange(pos, N, a, b, c, d)
      expect(got).toEqual(want)
    }
  })

  it('within matches the O(N) oracle for many random discs', () => {
    const q = mulberry32(2)
    for (let t = 0; t < 40; t++) {
      const qx = q() * 2000 - 1000
      const qy = q() * 2000 - 1000
      const r = q() * 200
      const got = asSet(idx.within(qx, qy, r))
      const want = oracleWithin(pos, N, qx, qy, r)
      expect(got).toEqual(want)
    }
  })

  it('nearest matches the O(N) oracle minimum distance for many random queries', () => {
    const q = mulberry32(3)
    for (let t = 0; t < 200; t++) {
      const qx = q() * 2400 - 1200 // include points slightly outside the cloud
      const qy = q() * 2400 - 1200
      const got = idx.nearest(qx, qy)
      expect(got).toBeGreaterThanOrEqual(0)
      const gotD2 = d2At(pos, got, qx, qy)
      const wantD2 = oracleNearestD2(pos, N, qx, qy)
      // Exact: the returned point must sit at the true minimum distance (ties OK).
      expect(gotD2).toBe(wantD2)
    }
  })
})

// ── polygonCandidates narrowing ───────────────────────────────────────────────

describe('polygonCandidates', () => {
  const N = 20_000
  const rng = mulberry32(777)
  const pos = new Float32Array(N * 2)
  for (let i = 0; i < N; i++) {
    pos[2 * i] = rng() * 200 - 100
    pos[2 * i + 1] = rng() * 200 - 100
  }
  const idx = buildPointIndex(pos, 64)

  // A non-convex lasso occupying a small region of the cloud.
  const LASSO: readonly [number, number][] = [
    [-30, -20],
    [10, -35],
    [40, 0],
    [15, 5],
    [25, 40],
    [-10, 20],
    [-35, 30],
  ]

  it('returns a SUPERSET of the true polygon selection, much smaller than N', () => {
    const candidates = polygonCandidates(idx, LASSO)
    const candSet = asSet(candidates)

    // The bbox candidate set equals the oracle bbox range (sanity on the bbox path).
    const [x0, y0, x1, y1] = polygonBoundingBox(LASSO)
    expect(candSet).toEqual(oracleRange(pos, N, x0, y0, x1, y1))

    // The true polygon selection (full O(N) scan) ⊆ candidates.
    const trueMask = selectInPolygon(pos, LASSO, N)
    const trueIdx = Array.from(trueMask.toIndices())
    expect(trueIdx.length).toBeGreaterThan(0) // the lasso actually catches points
    for (const i of trueIdx) expect(candSet.has(i)).toBe(true)

    // Narrowing is a big win: candidates ≪ N.
    expect(candidates.length).toBeLessThan(N / 4)
  })

  it('feeding candidates to selectInPolygon yields the SAME mask as a full scan', () => {
    const candidates = polygonCandidates(idx, LASSO)
    const viaKd = selectInPolygon(pos, LASSO, N, candidates)
    const viaFull = selectInPolygon(pos, LASSO, N)
    expect(Array.from(viaKd.toIndices())).toEqual(Array.from(viaFull.toIndices()))
  })

  it('degenerate ring (<3 vertices) → empty candidate set', () => {
    expect(polygonCandidates(idx, [[0, 0], [1, 1]]).length).toBe(0)
  })
})

// ── build performance (O(N log N)) ────────────────────────────────────────────

describe('build performance', () => {
  it('builds a 1,000,000-point index well under 500ms', () => {
    const N = 1_000_000
    const rng = mulberry32(999)
    const pos = new Float32Array(N * 2)
    for (let i = 0; i < N; i++) {
      pos[2 * i] = rng() * 1e6 - 5e5
      pos[2 * i + 1] = rng() * 1e6 - 5e5
    }
    const t0 = performance.now()
    const idx = buildPointIndex(pos, 64)
    const elapsed = performance.now() - t0
    // Measured build-only on the dev box: ~180–193ms for 1M points (3-run avg).
    // Loose 500ms bound leaves comfortable headroom on slower CI hardware.
    expect(idx.size).toBe(N)
    expect(elapsed).toBeLessThan(500)
  })
})
