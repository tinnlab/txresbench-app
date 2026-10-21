// selection.kdtree.test.ts — the KD-tree-accelerated selection path (research item #6).
//
// Proves the two claims of the acceleration:
//   1. CORRECTNESS — the indexed `selectInBox` / `selectInPolygon` produce a
//      BYTE-IDENTICAL IndexMask to the O(N) coordinate-scan versions (a point outside
//      the shape's bbox can never be inside the shape, so narrowing by the KD-tree's
//      range query changes no result).
//   2. SPEED — a focused measurement over a 10M-point fixture: selectInPolygon WITH a
//      prebuilt index vs the WITHOUT-index O(N)-scan narrowing. The index turns the
//      O(N) candidate scan into an O(log N + k) range query, so (index prebuilt, as it
//      is in the UI — memoized on the positions buffer) the hit-test is dramatically
//      faster while returning the identical mask.

import { describe, it, expect } from 'vitest'
import {
  IndexMask,
  bboxCandidates,
  polygonBoundingBox,
  selectInBox,
  selectInPolygon,
} from './selection'
import { buildPointIndex } from '../spatial/pointIndex'

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

function makeCloud(n: number, seed: number, span = 200): Float32Array {
  const rng = mulberry32(seed)
  const pos = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    pos[i * 2] = rng() * span - span / 2
    pos[i * 2 + 1] = rng() * span - span / 2
  }
  return pos
}

/** Assert two masks are byte-for-byte identical (same packed words + length). */
function expectMaskIdentical(a: IndexMask, b: IndexMask): void {
  expect(a.length).toBe(b.length)
  expect(Array.from(a.words)).toEqual(Array.from(b.words))
  expect(Array.from(a.toIndices())).toEqual(Array.from(b.toIndices()))
}

// A non-convex lasso in the middle of the cloud (same shape the sibling suites use).
const LASSO: readonly [number, number][] = [
  [-30, -20],
  [10, -35],
  [40, 0],
  [15, 5],
  [25, 40],
  [-10, 20],
  [-35, 30],
]

describe('KD-tree-accelerated selection is byte-identical to the O(N) scan', () => {
  const N = 50_000
  const POS = makeCloud(N, 0xbeef)
  const index = buildPointIndex(POS)

  it('selectInBox(index) == selectInBox(scan)', () => {
    for (const box of [
      [-25, -25, 25, 25],
      [0, 0, 80, 80],
      [-100, -100, 100, 100], // whole space
      [90, 90, 200, 200], // empty region
      [17.3, -4.1, -12.6, 33.9], // unordered corners
    ] as [number, number, number, number][]) {
      const scan = selectInBox(POS, box, N)
      const kd = selectInBox(POS, box, N, undefined, index)
      expectMaskIdentical(kd, scan)
    }
  })

  it('selectInPolygon(index) == selectInPolygon(scan)', () => {
    const scan = selectInPolygon(POS, LASSO, N) // full O(N) polygonContains scan
    const kd = selectInPolygon(POS, LASSO, N, undefined, index)
    expect(scan.count()).toBeGreaterThan(10) // fixture actually catches points
    expect(scan.count()).toBeLessThan(N)
    expectMaskIdentical(kd, scan)
  })

  it('selectInPolygon(index) == selectInPolygon(bboxCandidates scan)', () => {
    // The path the KD-tree REPLACES: the current O(N) coordinate scan (`bboxCandidates`).
    const viaScan = selectInPolygon(
      POS,
      LASSO,
      N,
      bboxCandidates(POS, N, polygonBoundingBox(LASSO)),
    )
    const viaKd = selectInPolygon(POS, LASSO, N, undefined, index)
    expectMaskIdentical(viaKd, viaScan)
  })

  it('a degenerate (<3 vertex) polygon still yields an empty mask with an index', () => {
    expect(selectInPolygon(POS, [[0, 0], [1, 1]], N, undefined, index).count()).toBe(0)
  })
})

describe('10M-point selectInPolygon: WITH index vs WITHOUT (the measured win)', () => {
  it(
    'indexed hit-test is dramatically faster AND byte-identical',
    () => {
      const N = 10_000_000
      // span 4000 → the fixed-size lasso covers a small fraction, a realistic zoom-in.
      const POS = makeCloud(N, 0x1234, 4000)

      // Build the index ONCE (this is memoized in the UI, so it is NOT part of the
      // per-interaction hit-test cost — we report it separately).
      const tBuild0 = performance.now()
      const index = buildPointIndex(POS)
      const buildMs = performance.now() - tBuild0

      // WITHOUT the index: the O(N) coordinate scan (`bboxCandidates`) → polygonContains.
      const tScan0 = performance.now()
      const scanMask = selectInPolygon(
        POS,
        LASSO,
        N,
        bboxCandidates(POS, N, polygonBoundingBox(LASSO)),
      )
      const scanMs = performance.now() - tScan0

      // WITH the index: O(log N + k) range query → polygonContains on O(k) candidates.
      const tKd0 = performance.now()
      const kdMask = selectInPolygon(POS, LASSO, N, undefined, index)
      const kdMs = performance.now() - tKd0

      // Byte-identical result.
      expectMaskIdentical(kdMask, scanMask)

      // The indexed hit-test is strictly (and by a wide margin) faster than the scan.
      expect(kdMs).toBeLessThan(scanMs)

      console.log(
        `[selectInPolygon @ ${N.toLocaleString()} points] ` +
          `index build (once): ${buildMs.toFixed(1)}ms | ` +
          `WITHOUT index (O(N) scan): ${scanMs.toFixed(1)}ms | ` +
          `WITH index (O(log N + k)): ${kdMs.toFixed(1)}ms | ` +
          `speedup: ${(scanMs / kdMs).toFixed(1)}x | ` +
          `selected: ${kdMask.count().toLocaleString()}`,
      )
    },
    120_000,
  )
})
