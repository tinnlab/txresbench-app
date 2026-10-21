// matrixWindow.test.ts — pure unit coverage for the matrix dataZoom window math
// (DEC-38): handle→index snapping, wheel-zoom-toward-cursor narrowing, pan clamping to
// the matrix bounds, and the min-window-size guard. No DOM, no GL.

import { describe, expect, it } from 'vitest'
import {
  MIN_WINDOW,
  fullWindow,
  isFullWindow,
  handleToIndex,
  normalizeRange,
  zoomRange,
  panRange,
  wheelZoomWindow,
  panWindow,
  withColRange,
  withRowRange,
  windowToBounds,
  windowToViewFit,
  type MatrixWindow,
} from './matrixWindow'

describe('fullWindow / isFullWindow', () => {
  it('full window spans the whole matrix', () => {
    expect(fullWindow(10, 6)).toEqual({ row0: 0, row1: 10, col0: 0, col1: 6 })
    expect(isFullWindow(fullWindow(10, 6), 10, 6)).toBe(true)
  })
  it('a sub-window is not full', () => {
    expect(isFullWindow({ row0: 2, row1: 8, col0: 0, col1: 6 }, 10, 6)).toBe(false)
  })
})

describe('handleToIndex', () => {
  it('rounds to the nearest integer index', () => {
    expect(handleToIndex(3.4, 10)).toBe(3)
    expect(handleToIndex(3.6, 10)).toBe(4)
  })
  it('clamps to [0, n]', () => {
    expect(handleToIndex(-2, 10)).toBe(0)
    expect(handleToIndex(999, 10)).toBe(10)
  })
})

describe('normalizeRange (min-size guard)', () => {
  it('orders the pair', () => {
    expect(normalizeRange(7, 3, 10)).toEqual([3, 7])
  })
  it('clamps into [0, n]', () => {
    expect(normalizeRange(-3, 12, 10)).toEqual([0, 10])
  })
  it('grows a sub-min span up to MIN_WINDOW', () => {
    expect(normalizeRange(4, 4, 10, MIN_WINDOW)).toEqual([4, 5])
  })
  it('grows downward when at the top edge', () => {
    // both handles at n → cannot grow up, must borrow from below.
    expect(normalizeRange(10, 10, 10, MIN_WINDOW)).toEqual([9, 10])
  })
  it('honors a larger explicit min size', () => {
    const [lo, hi] = normalizeRange(2, 2.5, 10, 3)
    expect(hi - lo).toBeCloseTo(3)
  })
})

describe('zoomRange (wheel-zoom toward cursor)', () => {
  it('narrows toward the cursor when factor < 1', () => {
    // span [0,10], cursor at the middle (0.5) → symmetric narrowing.
    const [lo, hi] = zoomRange(0, 10, 10, 0.5, 0.5)
    expect(hi - lo).toBeCloseTo(5)
    expect((lo + hi) / 2).toBeCloseTo(5) // anchor (cursor) held fixed
  })
  it('holds the cursor coordinate fixed while narrowing off-center', () => {
    // cursor at 0.2 of [0,10] → data coord 2. After 0.5 zoom the same coord stays put.
    const [lo, hi] = zoomRange(0, 10, 10, 0.5, 0.2)
    expect(hi - lo).toBeCloseTo(5)
    const anchorAfter = lo + 0.2 * (hi - lo)
    expect(anchorAfter).toBeCloseTo(2)
  })
  it('widens when factor > 1 and clamps to the full axis', () => {
    const [lo, hi] = zoomRange(3, 7, 10, 100, 0.5)
    expect([lo, hi]).toEqual([0, 10])
  })
  it('never narrows below MIN_WINDOW', () => {
    const [lo, hi] = zoomRange(0, 10, 10, 0.0001, 0.5)
    expect(hi - lo).toBeGreaterThanOrEqual(MIN_WINDOW)
  })
  it('shifts back inside the axis when the cursor is at an edge', () => {
    const [lo, hi] = zoomRange(0, 10, 10, 0.5, 1) // cursor at the far edge
    expect(lo).toBeGreaterThanOrEqual(0)
    expect(hi).toBeLessThanOrEqual(10)
    expect(hi - lo).toBeCloseTo(5)
  })
})

describe('panRange (clamp to bounds)', () => {
  it('shifts within range', () => {
    expect(panRange(2, 5, 10, 3)).toEqual([5, 8])
  })
  it('clamps at the high edge preserving width', () => {
    expect(panRange(6, 9, 10, 5)).toEqual([7, 10])
  })
  it('clamps at the low edge preserving width', () => {
    expect(panRange(2, 5, 10, -10)).toEqual([0, 3])
  })
})

describe('wheelZoomWindow', () => {
  it('narrows both axes toward the 2-D cursor', () => {
    const win: MatrixWindow = fullWindow(10, 8)
    const z = wheelZoomWindow(win, 10, 8, 0.5, 0.5, 0.5)
    expect(z.col1 - z.col0).toBeCloseTo(4)
    expect(z.row1 - z.row0).toBeCloseTo(5)
  })
})

describe('panWindow', () => {
  it('pans both axes clamped to the matrix', () => {
    const win: MatrixWindow = { row0: 0, row1: 4, col0: 0, col1: 4 }
    const p = panWindow(win, 10, 8, 2, 3)
    expect([p.col0, p.col1]).toEqual([2, 6])
    expect([p.row0, p.row1]).toEqual([3, 7])
    // over-pan clamps
    const p2 = panWindow(win, 10, 8, 100, 100)
    expect([p2.col0, p2.col1]).toEqual([4, 8])
    expect([p2.row0, p2.row1]).toEqual([6, 10])
  })
})

describe('withColRange / withRowRange', () => {
  it('replaces the column span, enforcing order + min size', () => {
    const win = fullWindow(10, 8)
    expect(withColRange(win, 5, 2, 8)).toMatchObject({ col0: 2, col1: 5, row0: 0, row1: 10 })
    expect(withColRange(win, 3, 3, 8).col1 - withColRange(win, 3, 3, 8).col0).toBeGreaterThanOrEqual(MIN_WINDOW)
  })
  it('replaces the row span', () => {
    const win = fullWindow(10, 8)
    expect(withRowRange(win, 8, 2, 10)).toMatchObject({ row0: 2, row1: 8, col0: 0, col1: 8 })
  })
})

describe('windowToBounds', () => {
  it('emits [col0, row0, col1, row1] matching the heatmap [0,rows,cols,0] convention', () => {
    expect(windowToBounds(fullWindow(10, 6))).toEqual([0, 0, 6, 10])
    expect(windowToBounds({ row0: 2, row1: 8, col0: 1, col1: 5 })).toEqual([1, 2, 5, 8])
  })
})

describe('windowToViewFit (frame the window to fill the canvas)', () => {
  it('centres the target on the window and per-axis zooms it to fill the pane', () => {
    // full 40×4000 window into an 800×600 pane: target = window centre, zoom = log2(px/span).
    const fit = windowToViewFit(fullWindow(40, 4000), 800, 600)
    expect(fit.target).toEqual([2000, 20, 0])
    expect(fit.zoom[0]).toBeCloseTo(Math.log2(800 / 4000), 6)
    expect(fit.zoom[1]).toBeCloseTo(Math.log2(600 / 40), 6)
  })
  it('zooming into a narrower COLUMN span raises the x-zoom (more px per column)', () => {
    const wide = windowToViewFit(fullWindow(40, 4000), 800, 600)
    const narrow = windowToViewFit({ row0: 0, row1: 40, col0: 1000, col1: 1400 }, 800, 600)
    expect(narrow.zoom[0]).toBeGreaterThan(wide.zoom[0])
    expect(narrow.target[0]).toBe(1200) // centred on the sub-window
  })
  it('a sub-window on ROWS re-centres + re-zooms the y-axis (row bar zooms too)', () => {
    const fit = windowToViewFit({ row0: 10, row1: 20, col0: 0, col1: 4000 }, 800, 600)
    expect(fit.target[1]).toBe(15)
    expect(fit.zoom[1]).toBeCloseTo(Math.log2(600 / 10), 6)
  })
  it('guards a degenerate span / zero px so the zoom stays finite', () => {
    const fit = windowToViewFit({ row0: 5, row1: 5, col0: 3, col1: 3 }, 0, 0)
    expect(Number.isFinite(fit.zoom[0])).toBe(true)
    expect(Number.isFinite(fit.zoom[1])).toBe(true)
  })
})
