import { describe, it, expect } from 'vitest'
import { fitContain } from './raster'

// The EXPORT-DIMENSION math (scale factor + custom-size contain-fit). These are the
// pure, DOM-free cores of the ExportDialog scale/custom-size controls; the actual
// canvas compositing (resizeCanvasToBox) + browser download run in the e2e.

describe('fitContain (custom-size, aspect-preserved letterbox)', () => {
  it('is identity when the box exactly matches the source', () => {
    const f = fitContain(640, 480, 640, 480)
    expect(f).toEqual({ width: 640, height: 480, x: 0, y: 0 })
  })

  it('scales uniformly when the box matches the source aspect (no letterbox)', () => {
    // Same 4:3 aspect, box is 2× → fills the whole box, centered at origin.
    const f = fitContain(640, 480, 1280, 960)
    expect(f.width).toBe(1280)
    expect(f.height).toBe(960)
    expect(f.x).toBe(0)
    expect(f.y).toBe(0)
  })

  it('letterboxes a wider box: source pinned to height, centered horizontally', () => {
    // 4:3 source into a 2:1 box (800×400). Fit by height: scale = 400/480 → w=533.33.
    const f = fitContain(640, 480, 800, 400)
    expect(f.height).toBeCloseTo(400, 5) // constrained axis fills
    expect(f.width).toBeCloseTo((640 * 400) / 480, 5) // ~533.33 — NOT stretched to 800
    expect(f.width).toBeLessThan(800)
    // horizontal letterbox margins are equal + centered
    expect(f.x).toBeCloseTo((800 - f.width) / 2, 5)
    expect(f.y).toBeCloseTo(0, 5)
    // aspect preserved: source ratio == fitted ratio (no distortion)
    expect(f.width / f.height).toBeCloseTo(640 / 480, 5)
  })

  it('letterboxes a taller box: source pinned to width, centered vertically', () => {
    // 4:3 source into a 1:1 box (500×500). Fit by width: scale = 500/640 → h=375.
    const f = fitContain(640, 480, 500, 500)
    expect(f.width).toBeCloseTo(500, 5)
    expect(f.height).toBeCloseTo((480 * 500) / 640, 5) // 375
    expect(f.x).toBeCloseTo(0, 5)
    expect(f.y).toBeCloseTo((500 - f.height) / 2, 5) // vertical letterbox
    expect(f.width / f.height).toBeCloseTo(640 / 480, 5) // aspect preserved
  })

  it('never exceeds either box dimension (contain, not cover)', () => {
    const f = fitContain(1000, 200, 300, 300)
    expect(f.width).toBeLessThanOrEqual(300 + 1e-9)
    expect(f.height).toBeLessThanOrEqual(300 + 1e-9)
  })

  it('returns a zero rect for degenerate (non-positive) inputs', () => {
    expect(fitContain(0, 480, 640, 480)).toEqual({ width: 0, height: 0, x: 0, y: 0 })
    expect(fitContain(640, 480, 0, 480)).toEqual({ width: 0, height: 0, x: 0, y: 0 })
    expect(fitContain(640, 480, 640, -1)).toEqual({ width: 0, height: 0, x: 0, y: 0 })
  })
})

describe('scale factor math (raster output pixel dims)', () => {
  // The dialog derives the whole-canvas raster output as round(size × scale); a
  // 2× export doubles W and H (same aspect ratio) — the primary high-res win.
  const outDims = (w: number, h: number, scale: number) => ({
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  })

  it('1× is unchanged (byte-identical default)', () => {
    expect(outDims(640, 480, 1)).toEqual({ w: 640, h: 480 })
  })

  it('2× doubles both dimensions, preserving aspect ratio', () => {
    const one = outDims(640, 480, 1)
    const two = outDims(640, 480, 2)
    expect(two).toEqual({ w: 1280, h: 960 })
    expect(two.w / two.h).toBeCloseTo(one.w / one.h, 10) // same aspect
  })

  it('3× and 4× scale linearly', () => {
    expect(outDims(300, 200, 3)).toEqual({ w: 900, h: 600 })
    expect(outDims(300, 200, 4)).toEqual({ w: 1200, h: 800 })
  })
})
