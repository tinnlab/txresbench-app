import { describe, it, expect } from 'vitest'
import { SelectionController, areaMask, type Area, type CombineMode, type PolygonArea } from './SelectionController'
import { IndexMask } from '../data/selection'
import { buildPointIndex, polygonCandidates } from '../spatial/pointIndex'

// The same tiny deterministic point cloud used by selection2.test.ts (world space, xy).
//   idx0 (0,0)  idx1 (1,0)  idx2 (2,0)   ← the "y≈0" row
//   idx3 (0,2)  idx4 (1,2)               ← the "y≈2" row
//   idx5 (5,5)                           ← the far outlier
const POSITIONS = new Float32Array([0, 0, 1, 0, 2, 0, 0, 2, 1, 2, 5, 5])
const N = 6

function indicesOf(mask: IndexMask): number[] {
  return Array.from(mask.toIndices())
}

// ─────────────────────────────────────────────────────────────────────────────
// BUG #9 — SelectionController.updateArea (drag-to-move a committed area)
// ─────────────────────────────────────────────────────────────────────────────
describe('SelectionController.updateArea — moved geometry → new mask (BUG #9)', () => {
  it('translating a rect area recomputes membership over the NEW region', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    // a small box around idx0 (0,0)
    ctrl.applyArea({ kind: 'rect', box: [-0.5, -0.5, 0.5, 0.5], mode: 'add' })
    expect(indicesOf(ctrl.selection)).toEqual([0])

    // move it +1 in x → now around idx1 (1,0)
    ctrl.updateArea(0, { kind: 'rect', box: [0.5, -0.5, 1.5, 0.5], mode: 'add' })
    expect(indicesOf(ctrl.selection)).toEqual([1])

    // move it up to cover the whole y≈2 row → {3,4}
    ctrl.updateArea(0, { kind: 'rect', box: [-0.5, 1.5, 1.5, 2.5], mode: 'add' })
    expect(indicesOf(ctrl.selection)).toEqual([3, 4])
  })

  it('translating a polygon area drops the STALE cached candidates and re-selects', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    const idx = buildPointIndex(POSITIONS)
    const poly: PolygonArea = {
      kind: 'polygon',
      polygon: [
        [-0.5, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [-0.5, 0.5],
      ],
      mode: 'add',
    } // around idx0 (0,0)
    // seed with an EXPLICIT candidate set (the deck region-pick path) so a cache exists.
    ctrl.applyArea(poly, POSITIONS, N, polygonCandidates(idx, poly.polygon))
    expect(indicesOf(ctrl.selection)).toEqual([0])

    // translate the ring +2 in x → around idx2 (2,0). If the stale candidates (which only
    // covered idx0's neighborhood) were reused, this would select nothing.
    const moved: PolygonArea = {
      kind: 'polygon',
      polygon: poly.polygon.map(([x, y]) => [x + 2, y] as const),
      mode: 'add',
    }
    ctrl.updateArea(0, moved)
    expect(indicesOf(ctrl.selection)).toEqual([2])
  })

  it('a move recomputes the COMBINED mask, not just the moved area', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    ctrl.applyArea({ kind: 'rect', box: [-0.5, -0.5, 0.5, 0.5], mode: 'add' }) // {0}
    ctrl.applyArea({ kind: 'rect', box: [1.5, -0.5, 2.5, 0.5], mode: 'add' }) // ∪ {2} = {0,2}
    expect(indicesOf(ctrl.selection)).toEqual([0, 2])
    // move area#0 onto idx1 → {1,2}
    ctrl.updateArea(0, { kind: 'rect', box: [0.5, -0.5, 1.5, 0.5], mode: 'add' })
    expect(indicesOf(ctrl.selection)).toEqual([1, 2])
  })

  it('an out-of-range index is a no-op', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    ctrl.applyArea({ kind: 'rect', box: [-0.5, -0.5, 0.5, 0.5], mode: 'add' })
    const before = indicesOf(ctrl.selection)
    ctrl.updateArea(9, { kind: 'rect', box: [0, 0, 0, 0], mode: 'add' })
    expect(indicesOf(ctrl.selection)).toEqual(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// BUG #10 — live polygon preview parity: the preview mask the component shows WHILE
// drawing (committed ⟨mode-op⟩ areaMask(ring)) must equal the controller's committed
// mask AFTER finishPolygon commits the same ring. This proves Finish only ENDS the
// gesture; it does not change the result.
// ─────────────────────────────────────────────────────────────────────────────
describe('live polygon preview == committed mask after finish (BUG #10)', () => {
  const idx = buildPointIndex(POSITIONS)
  // a ring covering the whole y≈0 row {0,1,2}
  const RING: readonly [number, number][] = [
    [-0.5, -0.5],
    [2.5, -0.5],
    [2.5, 0.5],
    [-0.5, 0.5],
  ]

  // Exactly the fold the component's preview effect performs.
  function previewCombined(committed: IndexMask, mode: CombineMode): IndexMask {
    const area: Area = { kind: 'polygon', polygon: RING, mode }
    const preview = areaMask(area, POSITIONS, N, polygonCandidates(idx, RING))
    return mode === 'add'
      ? committed.union(preview)
      : mode === 'subtract'
        ? committed.difference(preview)
        : committed.intersect(preview)
  }

  it('add: preview over an empty selection equals the committed mask after finish', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    const preview = previewCombined(ctrl.selection, 'add')
    // commit the SAME ring (finishPolygon → commitArea)
    ctrl.applyArea({ kind: 'polygon', polygon: RING, mode: 'add' }, POSITIONS, N, polygonCandidates(idx, RING))
    expect(indicesOf(preview)).toEqual(indicesOf(ctrl.selection))
    expect(indicesOf(preview)).toEqual([0, 1, 2])
  })

  it('subtract: preview over a prior selection equals the committed mask after finish', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    ctrl.applyArea({ kind: 'rect', box: [-0.5, -0.5, 2.5, 2.5], mode: 'add' }) // {0,1,2,3,4}
    const committed = ctrl.selection // captured BEFORE the polygon commit
    const preview = previewCombined(committed, 'subtract')
    ctrl.applyArea({ kind: 'polygon', polygon: RING, mode: 'subtract' }, POSITIONS, N, polygonCandidates(idx, RING))
    expect(indicesOf(preview)).toEqual(indicesOf(ctrl.selection))
    expect(indicesOf(ctrl.selection)).toEqual([3, 4]) // the y≈0 row removed
  })

  it('intersect: preview over a prior selection equals the committed mask after finish', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    ctrl.applyArea({ kind: 'rect', box: [-0.5, -0.5, 1.5, 0.5], mode: 'add' }) // {0,1}
    const committed = ctrl.selection
    const preview = previewCombined(committed, 'intersect')
    ctrl.applyArea({ kind: 'polygon', polygon: RING, mode: 'intersect' }, POSITIONS, N, polygonCandidates(idx, RING))
    expect(indicesOf(preview)).toEqual(indicesOf(ctrl.selection))
    expect(indicesOf(ctrl.selection)).toEqual([0, 1]) // {0,1} ∩ {0,1,2}
  })
})
