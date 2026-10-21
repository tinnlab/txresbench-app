import { describe, it, expect } from 'vitest'
import { SelectionController, type Area } from './SelectionController'
import { IndexMask } from '../data/selection'

// A tiny deterministic point cloud (world space, interleaved xy).
//   idx0 (0,0)  idx1 (1,0)  idx2 (2,0)   ← the "y≈0" row
//   idx3 (0,2)  idx4 (1,2)               ← the "y≈2" row
//   idx5 (5,5)                           ← the far outlier
const POSITIONS = new Float32Array([0, 0, 1, 0, 2, 0, 0, 2, 1, 2, 5, 5])
const N = 6

const RECT_ROW0: Area = { kind: 'rect', box: [-0.5, -0.5, 2.5, 0.5], mode: 'add' } // {0,1,2}
const POLY_ROW2: Area = {
  kind: 'polygon',
  polygon: [
    [-0.5, 1.5],
    [1.5, 1.5],
    [1.5, 2.5],
    [-0.5, 2.5],
  ],
  mode: 'add',
} // {3,4}

function indicesOf(mask: IndexMask): number[] {
  return Array.from(mask.toIndices())
}

describe('SelectionController — combine modes (TEST-24)', () => {
  it('a rect area unioned with a polygon area gives the combined mask + count', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    ctrl.applyArea(RECT_ROW0)
    expect(indicesOf(ctrl.selection)).toEqual([0, 1, 2])
    expect(ctrl.count).toBe(3)

    ctrl.applyArea(POLY_ROW2)
    expect(indicesOf(ctrl.selection)).toEqual([0, 1, 2, 3, 4])
    expect(ctrl.count).toBe(5)
  })

  it('a subtract area removes its points from the running selection', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    ctrl.applyArea(RECT_ROW0) // {0,1,2}
    // subtract the middle point (idx1 at x=1)
    ctrl.applyArea({ kind: 'rect', box: [0.5, -0.5, 1.5, 0.5], mode: 'subtract' })
    expect(indicesOf(ctrl.selection)).toEqual([0, 2])
    expect(ctrl.count).toBe(2)
  })

  it('an intersect area keeps only points common to both areas', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    ctrl.applyArea(RECT_ROW0) // {0,1,2}
    // intersect with a box covering x>=1.5 (idx2 at x=2 and idx5 at 5,5)
    ctrl.applyArea({ kind: 'rect', box: [1.5, -0.5, 5.5, 5.5], mode: 'intersect' })
    expect(indicesOf(ctrl.selection)).toEqual([2])
    expect(ctrl.count).toBe(1)
  })

  it('subtract then intersect compose in draw order', () => {
    const ctrl = new SelectionController({ positions: POSITIONS, totalPoints: N })
    ctrl.applyArea(RECT_ROW0) // {0,1,2}
    ctrl.applyArea(POLY_ROW2) // ∪ {3,4} = {0,1,2,3,4}
    ctrl.applyArea({ kind: 'rect', box: [-0.5, 1.5, 2.5, 2.5], mode: 'subtract' }) // − {3,4} = {0,1,2}
    ctrl.applyArea({ kind: 'rect', box: [-0.5, -0.5, 1.5, 0.5], mode: 'intersect' }) // ∩ {0,1} = {0,1}
    expect(indicesOf(ctrl.selection)).toEqual([0, 1])
    expect(ctrl.count).toBe(2)
  })
})

describe('SelectionController — onChange emission + area list (TEST-24)', () => {
  it('emits the combined mask on every applyArea', () => {
    const emitted: number[][] = []
    const ctrl = new SelectionController({
      positions: POSITIONS,
      totalPoints: N,
      onChange: m => emitted.push(indicesOf(m)),
    })
    ctrl.applyArea(RECT_ROW0)
    ctrl.applyArea(POLY_ROW2)
    expect(emitted).toEqual([
      [0, 1, 2],
      [0, 1, 2, 3, 4],
    ])
    // the last emitted mask is the controller's current selection
    expect(emitted[emitted.length - 1]).toEqual(indicesOf(ctrl.selection))
  })

  it('tracks the drawn areas in order and undo/clear roll them back', () => {
    const events: number[] = []
    const ctrl = new SelectionController({
      positions: POSITIONS,
      totalPoints: N,
      onChange: m => events.push(m.count()),
    })
    ctrl.applyArea(RECT_ROW0)
    ctrl.applyArea(POLY_ROW2)
    expect(ctrl.areasList()).toHaveLength(2)

    ctrl.undo()
    expect(ctrl.areasList()).toHaveLength(1)
    expect(indicesOf(ctrl.selection)).toEqual([0, 1, 2])

    ctrl.clear()
    expect(ctrl.areasList()).toHaveLength(0)
    expect(ctrl.count).toBe(0)
    // add → union(5) → undo(3) → clear(0)
    expect(events).toEqual([3, 5, 3, 0])
  })

  it('applyArea accepts explicit positions/totalPoints (prompt signature)', () => {
    const ctrl = new SelectionController({ positions: new Float32Array(), totalPoints: N })
    // pass the real positions explicitly on the call, as applyArea(area, positions, totalPoints)
    ctrl.applyArea(RECT_ROW0, POSITIONS, N)
    expect(indicesOf(ctrl.selection)).toEqual([0, 1, 2])
  })
})
