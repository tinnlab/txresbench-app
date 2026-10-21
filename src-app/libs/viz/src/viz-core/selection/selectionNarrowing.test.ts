import { describe, it, expect } from 'vitest'
import { SelectionController, areaMask, type PolygonArea } from './SelectionController'
import {
  bboxCandidates,
  polygonBoundingBox,
  selectInPolygon,
  type IndexMask,
} from '../data/selection'

// A deterministic pseudo-random point cloud (mulberry32) so the parity assertions
// are reproducible without a fixed hand-listing of thousands of points.
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

const N = 4000
const rand = mulberry32(1234)
const POS = new Float32Array(N * 2)
for (let i = 0; i < N; i++) {
  POS[i * 2] = rand() * 200 - 100 // x ∈ [-100, 100)
  POS[i * 2 + 1] = rand() * 200 - 100 // y ∈ [-100, 100)
}

// A non-convex lasso somewhere in the middle of the cloud.
const LASSO: readonly [number, number][] = [
  [-30, -20],
  [10, -35],
  [40, 0],
  [15, 5],
  [25, 40],
  [-10, 20],
  [-35, 30],
]
const POLY_AREA: PolygonArea = { kind: 'polygon', polygon: LASSO, mode: 'add' }

function indicesOf(mask: IndexMask): number[] {
  return Array.from(mask.toIndices())
}

// The parity ORACLE: the full-N point-in-polygon scan (no candidate narrowing).
const FULL_SCAN = indicesOf(selectInPolygon(POS, LASSO, N))

describe('selection candidate-narrowing parity (TASK 2)', () => {
  it('the oracle actually selects a non-trivial, strict subset (fixture sanity)', () => {
    expect(FULL_SCAN.length).toBeGreaterThan(10)
    expect(FULL_SCAN.length).toBeLessThan(N)
  })

  it('bboxCandidates yields exactly the points inside the polygon bbox', () => {
    const bbox = polygonBoundingBox(LASSO)
    const [x0, y0, x1, y1] = bbox
    const got = Array.from(bboxCandidates(POS, N, bbox)).sort((a, b) => a - b)
    const expected: number[] = []
    for (let i = 0; i < N; i++) {
      const x = POS[i * 2]
      const y = POS[i * 2 + 1]
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) expected.push(i)
    }
    expect(got).toEqual(expected)
    // the bbox is a strict superset of the polygon hits (corners lie outside the lasso)
    expect(got.length).toBeGreaterThan(FULL_SCAN.length)
  })

  it('areaMask bbox pre-filter (no candidates) == full-N scan', () => {
    const narrowed = indicesOf(areaMask(POLY_AREA, POS, N))
    expect(narrowed).toEqual(FULL_SCAN)
  })

  it('areaMask with an EXPLICIT candidate set (simulated deck region pick) == full-N scan', () => {
    // A region pick supplies the bbox candidate indices; the polygon test runs only
    // on those. Result must be byte-identical to the full scan.
    const candidates = Array.from(bboxCandidates(POS, N, polygonBoundingBox(LASSO)))
    const narrowed = indicesOf(areaMask(POLY_AREA, POS, N, candidates))
    expect(narrowed).toEqual(FULL_SCAN)
  })

  it('any superset of the true hits as candidates still yields the exact mask', () => {
    // Even feeding EVERY index as candidates (the degenerate full set) must match —
    // proves the polygon test, not the candidate set, decides membership.
    const allIndices = Array.from({ length: N }, (_, i) => i)
    const narrowed = indicesOf(areaMask(POLY_AREA, POS, N, allIndices))
    expect(narrowed).toEqual(FULL_SCAN)
  })

  it('SelectionController.applyArea narrows without changing the result', () => {
    const viaController = new SelectionController({ positions: POS, totalPoints: N })
    viaController.applyArea(POLY_AREA)
    expect(indicesOf(viaController.selection)).toEqual(FULL_SCAN)

    // passing explicit candidates gives the same mask + survives undo/recompute reuse
    const withCands = new SelectionController({ positions: POS, totalPoints: N })
    withCands.applyArea(
      { kind: 'rect', box: [-100, -100, 100, 100], mode: 'add' },
      POS,
      N,
    )
    withCands.applyArea(
      POLY_AREA,
      POS,
      N,
      Array.from(bboxCandidates(POS, N, polygonBoundingBox(LASSO))),
    )
    // rect(all) ∪ polygon = all points selected by the full-cover rect
    expect(withCands.count).toBe(N)
    withCands.undo() // drop the polygon; the cached rect candidates recompute cleanly
    expect(withCands.count).toBe(N)
  })
})
