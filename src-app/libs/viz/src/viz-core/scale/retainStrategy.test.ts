// retainStrategy.test.ts — unit tests for the item-16 retain-raw vs base-grid budget guard + the
// pure base-grid roll-up/crop + the zoom-vs-pan re-bin decision. No deck.gl / DOM: pure math over
// counts + camera geometry, so it runs in node under vitest.

import { describe, it, expect } from 'vitest'
import {
  chooseRetainStrategy,
  baseGridRollup,
  shouldRebinForView,
  rectContains,
  RETAIN_MAX_POINTS,
  RETAIN_RAW_BYTE_BUDGET,
  RETAIN_BYTES_PER_POINT,
  SERVER_TILE_PYRAMID_THRESHOLD,
  DEFAULT_BASE_GRID_DIM,
} from './retainStrategy'
import type { DensityBounds } from '../density/densityBin'
import { binDensity } from '../density/densityBin'

describe('chooseRetainStrategy — the memory-budget threshold', () => {
  it('retain-raw at/below the point cap, base-grid above it', () => {
    expect(chooseRetainStrategy(0)).toBe('retain-raw')
    expect(chooseRetainStrategy(1_000_000)).toBe('retain-raw')
    expect(chooseRetainStrategy(RETAIN_MAX_POINTS)).toBe('retain-raw') // inclusive boundary
    expect(chooseRetainStrategy(RETAIN_MAX_POINTS + 1)).toBe('base-grid')
    expect(chooseRetainStrategy(100_000_000)).toBe('base-grid')
  })

  it('the BYTE budget is the second guard — a wide bytesPerPoint trips base-grid before the point cap', () => {
    // 10M points is under the 15M point cap …
    expect(chooseRetainStrategy(10_000_000)).toBe('retain-raw')
    // … but at 32 B/point (positions + several retained channels) it exceeds the 128 MiB byte budget.
    expect(chooseRetainStrategy(10_000_000, { bytesPerPoint: 32 })).toBe('base-grid')
  })

  it('both guards must pass for retain-raw (exact byte-budget boundary)', () => {
    const maxByBytes = Math.floor(RETAIN_RAW_BYTE_BUDGET / RETAIN_BYTES_PER_POINT)
    // Raise the point cap so ONLY the byte budget decides, then straddle it.
    expect(chooseRetainStrategy(maxByBytes, { maxPoints: Number.MAX_SAFE_INTEGER })).toBe('retain-raw')
    expect(chooseRetainStrategy(maxByBytes + 1, { maxPoints: Number.MAX_SAFE_INTEGER })).toBe('base-grid')
  })

  it('honors explicit overrides + treats non-finite/negative counts as 0', () => {
    expect(chooseRetainStrategy(2000, { maxPoints: 1000 })).toBe('base-grid')
    expect(chooseRetainStrategy(500, { maxPoints: 1000 })).toBe('retain-raw')
    expect(chooseRetainStrategy(Number.NaN)).toBe('retain-raw')
    expect(chooseRetainStrategy(-5)).toBe('retain-raw')
  })

  it('documents the >100M server-tile-pyramid boundary (out of scope) as a constant', () => {
    expect(SERVER_TILE_PYRAMID_THRESHOLD).toBe(100_000_000)
    expect(DEFAULT_BASE_GRID_DIM).toBeGreaterThan(0)
    // Beyond the boundary the client strategy is still base-grid (the doc says binning must move
    // server-side there; this module doesn't build that — it only marks the seam).
    expect(chooseRetainStrategy(SERVER_TILE_PYRAMID_THRESHOLD + 1)).toBe('base-grid')
  })
})

const FULL: DensityBounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

describe('baseGridRollup — zoom-out roll-up + zoom-in crop', () => {
  it('rolls up a base grid onto a COARSER target additively (every source count preserved)', () => {
    // 4×4 base grid, one count in each cell → total 16. Roll up onto a 2×2 target over the SAME extent.
    const baseW = 4
    const baseH = 4
    const base = new Float64Array(baseW * baseH).fill(1)
    const out = baseGridRollup(base, baseW, baseH, FULL, FULL, 2, 2)
    expect(out.length).toBe(4)
    // Each 2×2 target cell gathers 4 base cells → 4 each; the grand total is conserved.
    expect(Array.from(out)).toEqual([4, 4, 4, 4])
    expect(out.reduce((a, b) => a + b, 0)).toBe(16)
  })

  it('CROPS to a tighter sub-extent — only the sub-region is non-empty (bounds math)', () => {
    // 8×8 base grid, one count per cell. Crop to the top-right quadrant [0.5,1]×[0.5,1].
    const baseW = 8
    const baseH = 8
    const base = new Float64Array(baseW * baseH).fill(1)
    const sub: DensityBounds = { minX: 0.5, minY: 0.5, maxX: 1, maxY: 1 }
    const tw = 4
    const th = 4
    const out = baseGridRollup(base, baseW, baseH, FULL, sub, tw, th)
    // Only the base cells whose center lies inside the sub-extent survive: the top-right 4×4 block =
    // 16 of the 64 counts. Everything outside was cropped.
    expect(out.reduce((a, b) => a + b, 0)).toBe(16)
    // The non-empty region fills the target (the sub-extent maps to the whole target grid).
    expect(Array.from(out).every((v) => v > 0)).toBe(true)
  })

  it('a tighter re-bin reflects the SUB-EXTENT — points outside the crop rect vanish', () => {
    // A base grid built from a cloud that is dense on the LEFT half only.
    const baseW = 16
    const baseH = 16
    const positions: number[] = []
    for (let i = 0; i < 400; i++) positions.push(0.25, Math.random()) // left-half column
    const base = binDensity(new Float32Array(positions), null, FULL, baseW, baseH).count
    // Crop to the RIGHT half — the left-only cloud contributes nothing there.
    const right: DensityBounds = { minX: 0.5, minY: 0, maxX: 1, maxY: 1 }
    const outRight = baseGridRollup(base, baseW, baseH, FULL, right, 8, 8)
    expect(outRight.reduce((a, b) => a + b, 0)).toBe(0)
    // Crop to the LEFT half — the whole cloud is retained.
    const left: DensityBounds = { minX: 0, minY: 0, maxX: 0.5, maxY: 1 }
    const outLeft = baseGridRollup(base, baseW, baseH, FULL, left, 8, 8)
    expect(outLeft.reduce((a, b) => a + b, 0)).toBe(400)
  })
})

describe('shouldRebinForView — zoom re-bins, small pan does not', () => {
  const raster: DensityBounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const base = {
    rasterWorld: raster,
    rasterZoom: 0,
    viewportW: 50,
    viewportH: 50,
  }

  it('a ZOOM change schedules a re-bin', () => {
    expect(
      shouldRebinForView({ ...base, camera: { target: [50, 50], zoom: 1 } }),
    ).toBe(true)
  })

  it('a SMALL pan that stays inside the padded raster does NOT re-bin (free reproject)', () => {
    // Same zoom, viewport 50×50 world units at zoom 0, centered inside the 100×100 raster rect.
    expect(
      shouldRebinForView({ ...base, camera: { target: [55, 55], zoom: 0 } }),
    ).toBe(false)
  })

  it('a pan PAST the raster margin re-bins', () => {
    // Center pushed so the 50×50 viewport rect spills past the raster's [0,100] bounds.
    expect(
      shouldRebinForView({ ...base, camera: { target: [90, 90], zoom: 0 } }),
    ).toBe(true)
  })

  it('rectContains is the pan-margin predicate', () => {
    expect(rectContains(raster, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true)
    expect(rectContains(raster, { minX: -1, minY: 10, maxX: 20, maxY: 20 })).toBe(false)
  })
})
