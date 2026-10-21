// plotWindow.test.ts — the pure Wave-2 plot window helpers: the box/bar value-axis reframe
// (`boundsWithValueWindow`) and the scatter camera↔window mapping (`axisVisibleWindow` /
// `axisViewFromWindow`), proven to round-trip. No DOM, no GL.

import { describe, expect, it } from 'vitest'
import { axisVisibleWindow, axisViewFromWindow, boundsWithValueWindow } from './plotWindow'

describe('boundsWithValueWindow', () => {
  it('keeps the x extent and frames y to the window', () => {
    expect(boundsWithValueWindow(-0.6, 5.6, { lo: 2, hi: 8 })).toEqual([-0.6, 2, 5.6, 8])
  })
  it('orders reversed y edges defensively', () => {
    expect(boundsWithValueWindow(0, 10, { lo: 8, hi: 2 })).toEqual([0, 2, 10, 8])
  })
})

describe('axisVisibleWindow', () => {
  it('half-extent is (px/2)/2^zoom, centered on the camera', () => {
    // zoom 0 → 1 device-px per world unit → half = px/2.
    expect(axisVisibleWindow(10, 0, 200)).toEqual({ lo: 10 - 100, hi: 10 + 100 })
    // zoom 1 → 2 px per world unit → half = px/4.
    expect(axisVisibleWindow(0, 1, 200)).toEqual({ lo: -50, hi: 50 })
  })
  it('degenerate viewport collapses to the center', () => {
    expect(axisVisibleWindow(7, 3, 0)).toEqual({ lo: 7, hi: 7 })
  })
  it('tolerates a non-finite zoom (treats it as 0)', () => {
    expect(axisVisibleWindow(0, Number.NaN, 100)).toEqual({ lo: -50, hi: 50 })
  })
})

describe('axisViewFromWindow', () => {
  it('center is the midpoint, zoom = log2(px/span)', () => {
    const { center, zoom } = axisViewFromWindow({ lo: -50, hi: 50 }, 200)
    expect(center).toBe(0)
    expect(zoom).toBeCloseTo(1, 12) // 200/100 = 2 → log2 = 1
  })
  it('degenerate span/viewport falls back to zoom 0 (never NaN)', () => {
    expect(axisViewFromWindow({ lo: 5, hi: 5 }, 200)).toEqual({ center: 5, zoom: 0 })
    expect(axisViewFromWindow({ lo: 0, hi: 10 }, 0)).toEqual({ center: 5, zoom: 0 })
  })
})

describe('camera ↔ window round-trip (per axis)', () => {
  const cases: Array<{ center: number; zoom: number; px: number }> = [
    { center: 0, zoom: 4, px: 600 },
    { center: -12.5, zoom: 2.3, px: 820 },
    { center: 100, zoom: -1, px: 300 },
    { center: 3.14, zoom: 0, px: 1024 },
  ]
  for (const c of cases) {
    it(`window→view→window is identity for ${JSON.stringify(c)}`, () => {
      const win = axisVisibleWindow(c.center, c.zoom, c.px)
      const view = axisViewFromWindow(win, c.px)
      expect(view.center).toBeCloseTo(c.center, 10)
      expect(view.zoom).toBeCloseTo(c.zoom, 10)
      // and forward again reproduces the same window
      const win2 = axisVisibleWindow(view.center, view.zoom, c.px)
      expect(win2.lo).toBeCloseTo(win.lo, 8)
      expect(win2.hi).toBeCloseTo(win.hi, 8)
    })
  }
})
