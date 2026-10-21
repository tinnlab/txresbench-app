// sharedMaskFanout.test.ts — Track A ITEM-6 (TEST-7): cross-pane dirty-rect fan-out.
import { describe, it, expect } from 'vitest'
import { createSharedLabelMask } from './sharedMask'
import { fanOutDirtyRect, intersectRect, viewPixelWindow } from './sharedMaskFanout'
import { EMPTY_RECT, isEmptyRect, type DirtyRect } from './maskEdit'

// world == pixel (span 40, dims 40) so world viewports read as pixel windows directly.
const mk = () => createSharedLabelMask({ id: 'g', worldBounds: [0, 0, 40, 40], width: 40, height: 40 })

describe('intersectRect', () => {
  it('intersects overlapping inclusive rects and returns EMPTY when disjoint', () => {
    expect(intersectRect([0, 0, 10, 10], [5, 5, 20, 20])).toEqual([5, 5, 10, 10])
    expect(isEmptyRect(intersectRect([0, 0, 4, 4], [10, 10, 12, 12]))).toBe(true)
    expect(isEmptyRect(intersectRect([...EMPTY_RECT], [0, 0, 4, 4]))).toBe(true)
  })
})

describe('viewPixelWindow', () => {
  it('maps a world viewport to a clamped inclusive pixel window', () => {
    const m = mk()
    // world y=40 → pixel 40, clamped to the last valid inclusive index (height-1 = 39).
    expect(viewPixelWindow(m, [0, 0, 20, 40])).toEqual([0, 0, 20, 39])
    // out-of-bounds world clamps to the raster
    expect(viewPixelWindow(m, [-100, -100, 5, 5])).toEqual([0, 0, 5, 5])
  })
})

describe('fanOutDirtyRect (TEST-7)', () => {
  it('emits, per view, ONLY the intersection of the edit with that view — no full re-encode', () => {
    const m = mk()
    m.registerView('A', [0, 0, 20, 40]) // left half
    m.registerView('B', [20, 0, 40, 40]) // right half
    // an edit straddling the seam: pixels x∈[18..24], y∈[10..12]
    const edit: DirtyRect = [18, 10, 24, 12]
    const targets = fanOutDirtyRect(edit, m)
    const byCell = Object.fromEntries(targets.map(t => [t.cellId, t.rect]))
    // A gets [18..20], B gets [20..24] — each ONLY its slice, never the whole edit
    expect(byCell['A']).toEqual([18, 10, 20, 12])
    expect(byCell['B']).toEqual([20, 10, 24, 12])
  })

  it('a non-overlapping view receives NO upload', () => {
    const m = mk()
    m.registerView('A', [0, 0, 10, 10]) // top-left corner
    m.registerView('far', [30, 30, 40, 40]) // bottom-right corner
    const targets = fanOutDirtyRect([0, 0, 5, 5], m)
    expect(targets.map(t => t.cellId)).toEqual(['A'])
  })

  it('a view with a null viewport ("covers everything") gets the full clamped edit rect', () => {
    const m = mk()
    m.registerView('full', null)
    const targets = fanOutDirtyRect([5, 6, 9, 9], m)
    expect(targets).toEqual([{ cellId: 'full', rect: [5, 6, 9, 9] }])
  })

  it('clamps the edit rect to the raster before fanning out', () => {
    const m = mk()
    m.registerView('full', null)
    // edit exceeds raster (0..39) → clamped
    const targets = fanOutDirtyRect([35, 35, 100, 100], m)
    expect(targets[0].rect).toEqual([35, 35, 39, 39])
  })

  it('an empty edit rect fans out to nothing', () => {
    const m = mk()
    m.registerView('A', null)
    expect(fanOutDirtyRect([...EMPTY_RECT], m)).toEqual([])
  })
})
