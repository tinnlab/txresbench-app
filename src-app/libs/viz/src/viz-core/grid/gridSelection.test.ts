import { describe, it, expect } from 'vitest'
import { OrthographicView } from '@deck.gl/core'
import type { PaneRect } from '../layers/multiView'
import {
  cellAtPoint,
  unprojectInCell,
  cellVisibleWorldBounds,
  selectRectInCell,
  selectPolygonInCell,
  type CellViewStateLike,
} from './gridSelection'
import { buildPointIndex } from '../spatial/pointIndex'

// ---------------------------------------------------------------------------
// Pure screen→world hit-testing for the grid selection tool (ITEM-25 producer).
// The screen coords in these tests are produced by PROJECTING known world points
// through the same viewport math the helper unprojects with (round-trip), so the
// tests assert the full screen→world→select path without hardcoding deck's ortho
// projection constants.
// ---------------------------------------------------------------------------

const RECT_A: PaneRect = { id: 'a', x: 0, y: 0, width: 200, height: 200 }
const RECT_B: PaneRect = { id: 'b', x: 200, y: 0, width: 200, height: 200 }
const VS: CellViewStateLike = { target: [0, 0, 0], zoom: 4 }

/** Project a world point through a cell's viewport → container-local screen px. */
function projectInCell(rect: PaneRect, vs: CellViewStateLike, world: [number, number]): [number, number] {
  const vp = new OrthographicView({ flipY: false }).makeViewport({
    width: rect.width,
    height: rect.height,
    viewState: { target: [vs.target[0], vs.target[1], 0], zoom: vs.zoom },
  })
  const [sx, sy] = vp!.project([world[0], world[1], 0])
  return [sx + rect.x, sy + rect.y]
}

describe('gridSelection — cellAtPoint', () => {
  it('attributes a screen point to the dense cell whose rect contains it', () => {
    expect(cellAtPoint([RECT_A, RECT_B], 100, 100)).toBe('a')
    expect(cellAtPoint([RECT_A, RECT_B], 300, 100)).toBe('b')
  })
  it('returns null for a point in no dense cell', () => {
    expect(cellAtPoint([RECT_A, RECT_B], 100, 500)).toBeNull()
  })
})

describe('gridSelection — unproject round-trip', () => {
  it('unprojectInCell inverts projectInCell (per-cell rect offset honored)', () => {
    for (const world of [[0, 0], [1.5, -2.25], [-3, 4]] as [number, number][]) {
      const screen = projectInCell(RECT_B, VS, world)
      const back = unprojectInCell(RECT_B, VS, screen[0], screen[1])
      expect(back).not.toBeNull()
      expect(back![0]).toBeCloseTo(world[0], 4)
      expect(back![1]).toBeCloseTo(world[1], 4)
    }
  })
})

describe('gridSelection — box + polygon select in a cell', () => {
  // 4 points spread in world space; index 0 near origin, others further out.
  const positions = new Float32Array([
    0, 0, // 0
    1, 1, // 1
    5, 5, // 2
    -4, -4, // 3
  ])
  const total = 4

  it('selectRectInCell selects exactly the points inside the drawn screen box', () => {
    // Draw a screen rect around world points 0 and 1 (a small box near origin).
    const s0 = projectInCell(RECT_A, VS, [-0.5, -0.5])
    const s1 = projectInCell(RECT_A, VS, [1.5, 1.5])
    const mask = selectRectInCell(RECT_A, VS, positions, total, s0, s1)
    expect(mask.has(0)).toBe(true)
    expect(mask.has(1)).toBe(true)
    expect(mask.has(2)).toBe(false)
    expect(mask.has(3)).toBe(false)
    expect(mask.count()).toBe(2)
  })

  it('selectPolygonInCell selects the points inside the drawn screen polygon', () => {
    // A triangle around world points 0 and 1 only.
    const ring: [number, number][] = [
      [-1, -1],
      [3, -1],
      [1, 3],
    ]
    const screenRing = ring.map(w => projectInCell(RECT_A, VS, w))
    const mask = selectPolygonInCell(RECT_A, VS, positions, total, screenRing)
    expect(mask.has(0)).toBe(true)
    expect(mask.has(1)).toBe(true)
    expect(mask.has(2)).toBe(false)
    expect(mask.has(3)).toBe(false)
  })

  it('selectPolygonInCell returns an empty mask for a degenerate (<3 vertex) ring', () => {
    const mask = selectPolygonInCell(RECT_A, VS, positions, total, [[0, 0], [1, 1]])
    expect(mask.count()).toBe(0)
  })

  it('threading a KD-tree index yields the SAME masks as the O(N) scan path', () => {
    const index = buildPointIndex(positions)

    // rect around world points 0 and 1
    const s0 = projectInCell(RECT_A, VS, [-0.5, -0.5])
    const s1 = projectInCell(RECT_A, VS, [1.5, 1.5])
    const rectScan = selectRectInCell(RECT_A, VS, positions, total, s0, s1)
    const rectKd = selectRectInCell(RECT_A, VS, positions, total, s0, s1, index)
    expect(Array.from(rectKd.words)).toEqual(Array.from(rectScan.words))

    // triangle around world points 0 and 1
    const ring: [number, number][] = [
      [-1, -1],
      [3, -1],
      [1, 3],
    ]
    const screenRing = ring.map(w => projectInCell(RECT_A, VS, w))
    const polyScan = selectPolygonInCell(RECT_A, VS, positions, total, screenRing)
    const polyKd = selectPolygonInCell(RECT_A, VS, positions, total, screenRing, index)
    expect(Array.from(polyKd.words)).toEqual(Array.from(polyScan.words))
  })
})

describe('gridSelection — cellVisibleWorldBounds', () => {
  it('returns the world bbox whose corners round-trip to the cell rect corners', () => {
    const b = cellVisibleWorldBounds(RECT_A, VS)
    expect(b).not.toBeNull()
    const [minX, minY, maxX, maxY] = b!
    expect(minX).toBeLessThan(maxX)
    expect(minY).toBeLessThan(maxY)
    // Projecting the world-bbox extremes back must land on (or within a pixel of) the cell's screen
    // rect corners [0,0]..[width,height] (cell-local), confirming the visible window is exactly the rect.
    const c0 = projectInCell(RECT_A, VS, [minX, minY])
    const c1 = projectInCell(RECT_A, VS, [maxX, maxY])
    const xs = [c0[0], c1[0]].sort((a, z) => a - z)
    const ys = [c0[1], c1[1]].sort((a, z) => a - z)
    expect(xs[0]).toBeCloseTo(0, 6)
    expect(xs[1]).toBeCloseTo(RECT_A.width, 6)
    expect(ys[0]).toBeCloseTo(0, 6)
    expect(ys[1]).toBeCloseTo(RECT_A.height, 6)
  })

  it('a lower zoom (further out) yields a WIDER visible world window', () => {
    const near = cellVisibleWorldBounds(RECT_A, { target: [0, 0, 0], zoom: 4 })!
    const far = cellVisibleWorldBounds(RECT_A, { target: [0, 0, 0], zoom: 1 })!
    const wNear = near[2] - near[0]
    const wFar = far[2] - far[0]
    expect(wFar).toBeGreaterThan(wNear)
  })

  it('is centered on the view target', () => {
    const b = cellVisibleWorldBounds(RECT_A, { target: [100, 50, 0], zoom: 3 })!
    expect((b[0] + b[2]) / 2).toBeCloseTo(100, 6)
    expect((b[1] + b[3]) / 2).toBeCloseTo(50, 6)
  })

  it('returns null on a degenerate (zero-size) rect', () => {
    expect(cellVisibleWorldBounds({ id: 'z', x: 0, y: 0, width: 0, height: 0 }, VS)).toBeNull()
  })
})
