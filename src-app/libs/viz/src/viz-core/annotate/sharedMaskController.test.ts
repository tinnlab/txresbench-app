// sharedMaskController.test.ts — Track A ITEM-5 (TEST-6) + INV-9 acceptance (TEST-A9).
import { describe, it, expect, vi } from 'vitest'
import { createSharedLabelMask, type WorldRect } from './sharedMask'
import { createSharedMaskController } from './sharedMaskController'

// world == pixel (span 40, dims 40) so a "pixel-space" assertion reads directly.
const BOUNDS: WorldRect = [0, 0, 40, 40]
const mk = () => createSharedLabelMask({ id: 'g', worldBounds: BOUNDS, width: 40, height: 40 })

describe('sharedMaskController — wrap-not-fork (TEST-6)', () => {
  it('delegates to the wrapped per-raster controller with MAPPED pixel coords (world→shared pixel)', () => {
    const m = mk()
    const ctl = createSharedMaskController({ mask: m })
    // spy the WRAPPED controller's brush — brushWorld must map world→pixel then delegate to it unchanged.
    const brushSpy = vi.spyOn(ctl.inner, 'brush')
    ctl.brushWorld({ wx: 10, wy: 12, rWorld: 3, id: 7 })
    expect(brushSpy).toHaveBeenCalledTimes(1)
    // world==pixel here, so the mapped op is pixel-space (10,12) r=3 — NOT the raw world object.
    expect(brushSpy.mock.calls[0][0]).toMatchObject({ x: 10, y: 12, r: 3, id: 7 })
    // and it actually mutated the ONE shared raster (real delegation, not a fork).
    expect(m.raster.some(v => v === 7)).toBe(true)
    brushSpy.mockRestore()
  })

  it('maps a world brush on a NON-identity affine to the correct shared pixel + pixel radius', () => {
    // span 80 over 40px ⇒ 2 world units/pixel; world (20,10) → pixel (10,5); rWorld 8 → 4px.
    const m = createSharedLabelMask({ id: 'g', worldBounds: [0, 0, 80, 80], width: 40, height: 40 })
    const ctl = createSharedMaskController({ mask: m })
    const brushSpy = vi.spyOn(ctl.inner, 'brush')
    ctl.brushWorld({ wx: 20, wy: 10, rWorld: 8, id: 3 })
    expect(brushSpy.mock.calls[0][0]).toMatchObject({ x: 10, y: 5, r: 4, id: 3 })
    brushSpy.mockRestore()
  })

  it('relabel / merge pass through to the wrapped per-raster controller (no coordinate mapping)', () => {
    const m = mk()
    // seed two labels
    m.raster[0] = 1
    m.raster[1] = 2
    m.categoryForId[0] = 0
    const cats: Uint16Array[] = []
    const ctl = createSharedMaskController({ mask: m, onCategories: c => cats.push(Uint16Array.from(c)) })
    ctl.relabel(1, 9)
    expect(cats.length).toBeGreaterThan(0)
    // merge 2→1 mutates the one raster
    ctl.merge(2, 1)
    expect(m.raster[1]).toBe(1)
  })

  it('exposes the inner controller and shares its ONE undo stack', () => {
    const m = mk()
    const ctl = createSharedMaskController({ mask: m })
    expect(ctl.canUndo).toBe(false)
    ctl.brushWorld({ wx: 5, wy: 5, rWorld: 1, id: 4 })
    expect(ctl.canUndo).toBe(true)
    expect(ctl.historyDepth).toBe(1)
    expect(ctl.inner.canUndo).toBe(true) // same underlying stack
  })
})

describe('sharedMaskController — seam-invisible edit path (TEST-A9, INV-9)', () => {
  // two DIFFERENT pane screen→world mappers (different offsets/scales, i.e. different panes viewing
  // different world regions). Applied to a screen point they each yield a world point.
  const paneA = (sx: number, sy: number): [number, number] => [sx * 0.5 + 2, sy * 0.5 + 3]
  const paneB = (sx: number, sy: number): [number, number] => [sx * 0.25 + 18, sy * 0.5 + 3]

  it('the SAME world point via pane A or pane B maps to the IDENTICAL shared pixel', () => {
    const m = createSharedLabelMask({ id: 'g', worldBounds: [0, 0, 40, 40], width: 80, height: 80 })
    const toPixelSpy = vi.spyOn(m, 'worldToPixel')
    const ctl = createSharedMaskController({ mask: m })

    // choose screen points in each pane that land on the SAME world point (20, 15):
    // paneA: sx*0.5+2=20 → sx=36 ; sy*0.5+3=15 → sy=24
    // paneB: sx*0.25+18=20 → sx=8 ; sy*0.5+3=15 → sy=24
    const [wax, way] = paneA(36, 24)
    const [wbx, wby] = paneB(8, 24)
    expect([wax, way]).toEqual([wbx, wby]) // same world point

    ctl.brushWorld({ wx: wax, wy: way, rWorld: 0.5, id: 1 })
    const pixA = [...(toPixelSpy.mock.results.at(-1)!.value as readonly number[])]
    ctl.undo()
    ctl.brushWorld({ wx: wbx, wy: wby, rWorld: 0.5, id: 1 })
    const pixB = [...(toPixelSpy.mock.results.at(-1)!.value as readonly number[])]
    expect(pixA).toEqual(pixB) // identical shared pixel — the seam is invisible
    toPixelSpy.mockRestore()
  })

  it('a stroke dragged from pane A across the seam into pane B is one continuous run of texels', () => {
    // world==pixel, span 40 dims 40. The "seam" is the world x=20 boundary between the two panes.
    const m = createSharedLabelMask({ id: 'g', worldBounds: [0, 0, 40, 40], width: 40, height: 40 })
    const ctl = createSharedMaskController({ mask: m })
    // drag a 1px brush along y=20 from world x=17 (pane A) to x=23 (pane B), stepping every world unit
    for (let wx = 17; wx <= 23; wx++) ctl.brushWorld({ wx, wy: 20, rWorld: 0.6, id: 8 })
    // the painted texels along the row are a CONTIGUOUS run crossing x=20 (no gap, no duplication)
    const row = 20
    const painted: number[] = []
    for (let x = 0; x < 40; x++) if (m.raster[row * 40 + x] === 8) painted.push(x)
    expect(painted.length).toBeGreaterThan(0)
    // contiguous: max-min+1 == count (no hole at the seam)
    expect(painted[painted.length - 1] - painted[0] + 1).toBe(painted.length)
    // and the run actually spans the seam
    expect(painted[0]).toBeLessThanOrEqual(19)
    expect(painted[painted.length - 1]).toBeGreaterThanOrEqual(20)
  })

  it('the edit path does NO pane-local pixel math — all mapping routes through the shared affine', () => {
    const m = createSharedLabelMask({ id: 'g', worldBounds: [0, 0, 40, 40], width: 40, height: 40 })
    const toPixelSpy = vi.spyOn(m, 'worldToPixel')
    const lenSpy = vi.spyOn(m, 'worldLengthToPixels')
    const ctl = createSharedMaskController({ mask: m })
    ctl.brushWorld({ wx: 10, wy: 10, rWorld: 2, id: 1 })
    // every coordinate/length that reached the raster came from the shared mask's affine, nothing else.
    expect(toPixelSpy).toHaveBeenCalled()
    expect(lenSpy).toHaveBeenCalled()
    toPixelSpy.mockRestore()
    lenSpy.mockRestore()
  })
})
