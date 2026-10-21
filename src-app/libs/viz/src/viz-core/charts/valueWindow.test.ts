// valueWindow.test.ts — the pure VALUE-AXIS window math for the violin's y-only dataZoom
// (clamp, wheel-zoom-about-cursor, pan, and the KDE-over-window FILTER). No DOM, no GL.

import { describe, it, expect } from 'vitest'
import {
  MIN_SPAN_FRAC,
  minSpanFor,
  fullValueWindow,
  isFullValueWindow,
  clampValueWindow,
  zoomValueWindow,
  panValueWindow,
  valuesInWindow,
  filterCellsToWindow,
} from './valueWindow'
import { violinByGroup } from './aggregate'

const DOMAIN: [number, number] = [0, 100]

describe('fullValueWindow / isFullValueWindow', () => {
  it('orders the pair and reports full coverage', () => {
    expect(fullValueWindow(100, 0)).toEqual({ lo: 0, hi: 100 })
    expect(isFullValueWindow({ lo: 0, hi: 100 }, 0, 100)).toBe(true)
    expect(isFullValueWindow({ lo: -1, hi: 200 }, 0, 100)).toBe(true) // over-covers
    expect(isFullValueWindow({ lo: 20, hi: 80 }, 0, 100)).toBe(false)
  })
})

describe('minSpanFor', () => {
  it('is a fraction of the domain span, degenerate-safe', () => {
    expect(minSpanFor(0, 100)).toBeCloseTo(100 * MIN_SPAN_FRAC, 10)
    expect(minSpanFor(5, 5)).toBeGreaterThan(0) // never zero for a degenerate domain
  })
})

describe('clampValueWindow', () => {
  it('orders the handles and clamps into the domain', () => {
    expect(clampValueWindow(80, 20, ...DOMAIN)).toEqual({ lo: 20, hi: 80 })
    expect(clampValueWindow(-30, 130, ...DOMAIN)).toEqual({ lo: 0, hi: 100 })
  })

  it('grows a too-thin window to the min span, staying in-domain', () => {
    const w = clampValueWindow(50, 50.0001, ...DOMAIN)
    expect(w.hi - w.lo).toBeCloseTo(minSpanFor(...DOMAIN), 6)
    expect(w.lo).toBeGreaterThanOrEqual(0)
    expect(w.hi).toBeLessThanOrEqual(100)
  })

  it('when pinned at the top edge, grows DOWNWARD to keep the min span in-domain', () => {
    const w = clampValueWindow(100, 100, ...DOMAIN)
    expect(w.hi).toBe(100)
    expect(w.hi - w.lo).toBeCloseTo(minSpanFor(...DOMAIN), 6)
  })
})

describe('zoomValueWindow — wheel zoom about the cursor value', () => {
  it('zooms IN (factor<1) and holds the cursor value fixed under the pointer', () => {
    const win = { lo: 0, hi: 100 }
    const cursor = 30
    const z = zoomValueWindow(win, ...DOMAIN, 0.5, cursor)
    // span halves
    expect(z.hi - z.lo).toBeCloseTo(50, 6)
    // the cursor value keeps its fractional position (was 0.3 of the window)
    const fracBefore = (cursor - win.lo) / (win.hi - win.lo)
    const fracAfter = (cursor - z.lo) / (z.hi - z.lo)
    expect(fracAfter).toBeCloseTo(fracBefore, 6)
  })

  it('zooms OUT (factor>1) but never past the full domain', () => {
    const z = zoomValueWindow({ lo: 40, hi: 60 }, ...DOMAIN, 100, 50)
    expect(z).toEqual({ lo: 0, hi: 100 })
  })

  it('floors the span at the min span when zooming in hard', () => {
    const z = zoomValueWindow({ lo: 0, hi: 100 }, ...DOMAIN, 1e-9, 50)
    expect(z.hi - z.lo).toBeCloseTo(minSpanFor(...DOMAIN), 6)
  })

  it('anchors an out-of-window cursor at the nearest edge (no fling)', () => {
    const z = zoomValueWindow({ lo: 20, hi: 40 }, ...DOMAIN, 0.5, 999)
    expect(z.lo).toBeGreaterThanOrEqual(0)
    expect(z.hi).toBeLessThanOrEqual(100)
    expect(z.hi - z.lo).toBeCloseTo(10, 6)
  })
})

describe('panValueWindow', () => {
  it('shifts by the delta, preserving the span', () => {
    expect(panValueWindow({ lo: 20, hi: 40 }, ...DOMAIN, 10)).toEqual({ lo: 30, hi: 50 })
  })
  it('clamps at the domain edges without shrinking', () => {
    expect(panValueWindow({ lo: 80, hi: 100 }, ...DOMAIN, 50)).toEqual({ lo: 80, hi: 100 })
    expect(panValueWindow({ lo: 0, hi: 20 }, ...DOMAIN, -50)).toEqual({ lo: 0, hi: 20 })
  })
})

describe('valuesInWindow — the KDE re-densify filter', () => {
  it('keeps only finite values inside the inclusive band', () => {
    const vals = [-5, 0, 10, 50, 100, 200, NaN, Infinity]
    const out = valuesInWindow(vals, 0, 100)
    expect(Array.from(out)).toEqual([0, 10, 50, 100])
  })
  it('is order-insensitive in its bounds', () => {
    const vals = [10, 20, 30, 40]
    expect(Array.from(valuesInWindow(vals, 30, 15))).toEqual([20, 30])
  })
})

describe('filterCellsToWindow — windowed + per-group subsample', () => {
  it('filters to the window and aligns codes with values, per group', () => {
    const values = Float32Array.from([5, 15, 25, 95, 35, 200])
    const codes = Uint16Array.from([0, 1, 0, 1, 0, 1])
    const { values: fv, codes: fc } = filterCellsToWindow(values, codes, 10, 40, 2, 1000)
    // in-window: idx1(15,g1), idx2(25,g0), idx4(35,g0) → emitted group-major (g0 then g1)
    expect(Array.from(fc)).toEqual([0, 0, 1])
    expect(Array.from(fv)).toEqual([25, 35, 15])
  })

  it('drops out-of-range codes and non-finite values', () => {
    const values = Float32Array.from([50, NaN, 60])
    const codes = Uint16Array.from([0, 0, 9]) // code 9 is out of range for nGroups=1
    const { values: fv, codes: fc } = filterCellsToWindow(values, codes, 0, 100, 1, 1000)
    expect(Array.from(fv)).toEqual([50])
    expect(Array.from(fc)).toEqual([0])
  })

  it('caps each group deterministically at capPerGroup (same input → same sample)', () => {
    const n = 500
    const values = Float32Array.from({ length: n }, (_, i) => i / 5) // 0..99.8, all in [0,100]
    const codes = new Uint16Array(n) // one group
    const a = filterCellsToWindow(values, codes, 0, 100, 1, 50)
    const b = filterCellsToWindow(values, codes, 0, 100, 1, 50)
    expect(a.values.length).toBe(50)
    expect(Array.from(a.values)).toEqual(Array.from(b.values)) // deterministic
  })
})

describe('windowed KDE recompute (filter → domain grid)', () => {
  // The full pipeline the ViolinView zoom drives: filter cells to the window, then run the
  // KDE with the window as its grid domain — so the shape RE-DENSIFIES over the focused band.
  const values = Float32Array.from([2, 5, 10, 12, 48, 50, 52, 90, 95])
  const codes = new Uint16Array(values.length) // one group
  const categories = ['g0']

  it('samples the KDE grid over the WINDOW, not [0,max]', () => {
    const win: [number, number] = [40, 60]
    const { values: fv, codes: fc } = filterCellsToWindow(values, codes, win[0], win[1], 1, 1000)
    const g = violinByGroup(fv, fc, categories, { ticks: 5, domain: win })
    const xs = g[0].density.map(d => d.x)
    expect(xs[0]).toBeCloseTo(40, 6)
    expect(xs[xs.length - 1]).toBeCloseTo(60, 6)
  })

  it('only in-window cells reach the KDE (filter is applied before recompute)', () => {
    const win: [number, number] = [40, 60]
    const { values: fv } = filterCellsToWindow(values, codes, win[0], win[1], 1, 1000)
    // 48,50,52 are the only in-window values
    expect(Array.from(fv).sort((a, b) => a - b)).toEqual([48, 50, 52])
  })

  it('re-densifies: the windowed KDE mass concentrates in the focused band', () => {
    const wide = violinByGroup(values, codes, categories, { ticks: 41, domain: [0, 100] })
    const { values: fv, codes: fc } = filterCellsToWindow(values, codes, 40, 60, 1, 1000)
    const zoomed = violinByGroup(fv, fc, categories, { ticks: 41, domain: [40, 60] })
    // Peak density around 50 is HIGHER in the zoomed (re-densified) view than the full view
    const peak = (gs: { density: { x: number; density: number }[] }) =>
      Math.max(...gs.density.map(d => d.density))
    expect(peak(zoomed[0])).toBeGreaterThan(peak(wide[0]))
  })
})
