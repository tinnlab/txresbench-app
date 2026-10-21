// axisWindow.test.ts — the ONE pure per-axis dataZoom window model that `valueWindow` +
// `matrixWindow` now delegate to. Covers the merged math (clamp / zoom-about-anchor / pan) and
// the new DragRail fraction mapping (`windowToFraction` / `fractionToWindow`, incl. `invert`
// for a top=max axis and `snap` for an index axis). The value-specific + matrix-specific tests
// still live in `valueWindow.test.ts` / `matrixWindow.test.ts` and prove the shims preserve
// behavior. No DOM, no GL.

import { describe, expect, it } from 'vitest'
import {
  clampWindow,
  fractionToWindow,
  fullAxisWindow,
  isFullAxisWindow,
  minSpanFor,
  panWindow,
  windowToFraction,
  zoomWindow,
} from './axisWindow'

const DOMAIN: [number, number] = [0, 100]

describe('fullAxisWindow / isFullAxisWindow', () => {
  it('orders the pair and reports full coverage', () => {
    expect(fullAxisWindow(100, 0)).toEqual({ lo: 0, hi: 100 })
    expect(isFullAxisWindow({ lo: 0, hi: 100 }, 0, 100)).toBe(true)
    expect(isFullAxisWindow({ lo: -1, hi: 200 }, 0, 100)).toBe(true)
    expect(isFullAxisWindow({ lo: 20, hi: 80 }, 0, 100)).toBe(false)
  })
})

describe('clampWindow', () => {
  it('orders the handles and clamps into the domain', () => {
    expect(clampWindow(80, 20, ...DOMAIN)).toEqual({ lo: 20, hi: 80 })
    expect(clampWindow(-30, 130, ...DOMAIN)).toEqual({ lo: 0, hi: 100 })
  })
  it('grows a too-thin window to the min span, staying in-domain', () => {
    const w = clampWindow(50, 50.0001, ...DOMAIN, 4)
    expect(w.hi - w.lo).toBeCloseTo(4, 6)
  })
  it('borrows downward when pinned at the top edge', () => {
    const w = clampWindow(100, 100, ...DOMAIN, 4)
    expect(w.hi).toBe(100)
    expect(w.hi - w.lo).toBeCloseTo(4, 6)
  })
  it('serves the matrix index-axis case (domain [0,n], minSpan 1)', () => {
    expect(clampWindow(7, 3, 0, 10, 1)).toEqual({ lo: 3, hi: 7 })
    expect(clampWindow(4, 4, 0, 10, 1)).toEqual({ lo: 4, hi: 5 })
    expect(clampWindow(10, 10, 0, 10, 1)).toEqual({ lo: 9, hi: 10 })
  })
})

describe('zoomWindow — zoom about an anchor value', () => {
  it('zooms IN and holds the anchor value fixed', () => {
    const win = { lo: 0, hi: 100 }
    const z = zoomWindow(win, ...DOMAIN, 0.5, 30)
    expect(z.hi - z.lo).toBeCloseTo(50, 6)
    expect((30 - z.lo) / (z.hi - z.lo)).toBeCloseTo((30 - win.lo) / (win.hi - win.lo), 6)
  })
  it('zooms OUT but never past the full domain', () => {
    expect(zoomWindow({ lo: 40, hi: 60 }, ...DOMAIN, 100, 50)).toEqual({ lo: 0, hi: 100 })
  })
  it('floors the span at minSpan', () => {
    const z = zoomWindow({ lo: 0, hi: 100 }, ...DOMAIN, 1e-9, 50, 4)
    expect(z.hi - z.lo).toBeCloseTo(4, 6)
  })
  it('anchors an out-of-window value at the nearest edge (no fling)', () => {
    const z = zoomWindow({ lo: 20, hi: 40 }, ...DOMAIN, 0.5, 999)
    expect(z.lo).toBeGreaterThanOrEqual(0)
    expect(z.hi).toBeLessThanOrEqual(100)
    expect(z.hi - z.lo).toBeCloseTo(10, 6)
  })
})

describe('panWindow', () => {
  it('shifts by the delta, preserving the span', () => {
    expect(panWindow({ lo: 20, hi: 40 }, ...DOMAIN, 10)).toEqual({ lo: 30, hi: 50 })
  })
  it('clamps at the domain edges without shrinking', () => {
    expect(panWindow({ lo: 80, hi: 100 }, ...DOMAIN, 50)).toEqual({ lo: 80, hi: 100 })
    expect(panWindow({ lo: 0, hi: 20 }, ...DOMAIN, -50)).toEqual({ lo: 0, hi: 20 })
  })
})

describe('windowToFraction — DragRail mapping', () => {
  it('maps a window to ordered [lo,hi] fractions (non-inverted)', () => {
    expect(windowToFraction({ lo: 20, hi: 80 }, 0, 100)).toEqual([0.2, 0.8])
    expect(windowToFraction({ lo: 0, hi: 100 }, 0, 100)).toEqual([0, 1])
  })
  it('inverts so the LOW edge sits at the rail HIGH end (top=max vertical axis)', () => {
    // matrix rows: window {lo:row0=2, hi:row1=8} on domain [0,10], invert → row0 near the top.
    const [lo, hi] = windowToFraction({ lo: 2, hi: 8 }, 0, 10, true)
    expect(lo).toBeCloseTo(0.2, 6) // = (10-8)/10, the row1 (bottom) edge
    expect(hi).toBeCloseTo(0.8, 6) // = (10-2)/10, the row0 (top) edge
  })
})

describe('fractionToWindow — inverse of windowToFraction', () => {
  it('round-trips a non-inverted window', () => {
    const win = { lo: 20, hi: 80 }
    const [lo, hi] = windowToFraction(win, 0, 100)
    expect(fractionToWindow(lo, hi, 0, 100, false, minSpanFor(0, 100))).toEqual(win)
  })
  it('round-trips an inverted window', () => {
    const win = { lo: 2, hi: 8 }
    const [lo, hi] = windowToFraction(win, 0, 10, true)
    expect(fractionToWindow(lo, hi, 0, 10, true, 1)).toEqual(win)
  })
  it('snaps each edge to a whole cell before clamping (index axis)', () => {
    // fractions 0.23 / 0.78 of [0,10] → 2.3 / 7.8 → snap round → 2 / 8.
    const snap = (v: number) => Math.round(v)
    expect(fractionToWindow(0.23, 0.78, 0, 10, false, 1, snap)).toEqual({ lo: 2, hi: 8 })
  })
  it('snap that collapses two edges still honors the min span', () => {
    const snap = (v: number) => Math.round(v)
    const w = fractionToWindow(0.41, 0.44, 0, 10, false, 1, snap) // both round to 4
    expect(w.hi - w.lo).toBeGreaterThanOrEqual(1)
  })
})
