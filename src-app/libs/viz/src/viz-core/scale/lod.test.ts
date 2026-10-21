// lod.test.ts — unit tests for the pure LOD-while-interacting policy. No deck.gl / DOM:
// pure count math, so it runs in node under vitest.

import { describe, it, expect } from 'vitest'
import { strideSample } from './chunking'
import type { DensityBounds } from '../density/densityBin'
import {
  DENSITY_ENTER_PPP,
  DENSITY_EXIT_PPP,
  DENSITY_MIN_N,
  LOD_THRESHOLD,
  LOD_TARGET,
  estimateVisiblePoints,
  lodStrideForCount,
  lodVisibleCount,
  shouldUseDensity,
  shouldUseLod,
  viewportWorldBounds,
} from './lod'

describe('lodStrideForCount', () => {
  it('is 1 (full detail, NO LOD) at or below the threshold', () => {
    expect(lodStrideForCount(0)).toBe(1)
    expect(lodStrideForCount(10_000)).toBe(1)
    expect(lodStrideForCount(1_000_000)).toBe(1)
    expect(lodStrideForCount(LOD_THRESHOLD)).toBe(1)
  })

  it('engages (stride > 1) only ABOVE the threshold', () => {
    expect(lodStrideForCount(LOD_THRESHOLD + 1)).toBeGreaterThan(1)
    expect(lodStrideForCount(10_000_000)).toBeGreaterThan(1)
  })

  it('caps the visible count at ~LOD_TARGET for 10M (stride = ceil(N/target))', () => {
    const n = 10_000_000
    const stride = lodStrideForCount(n)
    expect(stride).toBe(Math.ceil(n / LOD_TARGET)) // = 10
    // the resulting visible subset never exceeds the target.
    expect(lodVisibleCount(n, stride)).toBeLessThanOrEqual(LOD_TARGET)
  })

  it('honours custom threshold / target', () => {
    expect(lodStrideForCount(2_000_000, 5_000_000, 1_000_000)).toBe(1) // below custom threshold
    expect(lodStrideForCount(4_000_000, 1_000_000, 2_000_000)).toBe(2) // ceil(4M/2M)
  })

  it('floors fractional input and never returns < 1', () => {
    expect(lodStrideForCount(-5)).toBe(1)
    expect(lodStrideForCount(1_500_000.9)).toBe(1)
  })
})

describe('shouldUseLod', () => {
  it('is true only while interacting AND stride > 1', () => {
    expect(shouldUseLod(true, 10)).toBe(true)
    expect(shouldUseLod(false, 10)).toBe(false) // idle → full detail
    expect(shouldUseLod(true, 1)).toBe(false) // below threshold → never LOD
    expect(shouldUseLod(false, 1)).toBe(false)
  })
})

describe('lodVisibleCount', () => {
  it('matches strideSample kept-count = ceil(n/stride)', () => {
    expect(lodVisibleCount(10_000_000, 10)).toBe(1_000_000)
    expect(lodVisibleCount(101, 10)).toBe(11)
    // cross-check against the actual strided-pick length for a small array.
    const stride = 3
    const src = new Float32Array(20) // 20 points, epp 1
    const kept = strideSample(src, stride, 1)
    expect(kept.length).toBe(lodVisibleCount(20, stride))
  })

  it('is n when stride is 1 (no downsampling)', () => {
    expect(lodVisibleCount(1_000_000, 1)).toBe(1_000_000)
  })
})

// ── density-aggregate auto-switch ──────────────────────────────────────────────────

describe('shouldUseDensity', () => {
  const PIXELS = 1_000_000 // ~1MP viewport

  it('is OFF for small N regardless of density (opt-in-safe: ≤ 1M unaffected)', () => {
    expect(
      shouldUseDensity({ n: 1_000_000, estimatedVisiblePoints: 1_000_000, pixels: PIXELS, currentlyDensity: false }),
    ).toBe(false)
    expect(
      shouldUseDensity({ n: DENSITY_MIN_N, estimatedVisiblePoints: 9e9, pixels: PIXELS, currentlyDensity: false }),
    ).toBe(false)
  })

  it('ENTERS for large N when visible points ≫ pixels (zoomed out)', () => {
    // 10M points, whole cloud in view → ~10 pts/px ≫ enter threshold.
    expect(
      shouldUseDensity({ n: 10_000_000, estimatedVisiblePoints: 10_000_000, pixels: PIXELS, currentlyDensity: false }),
    ).toBe(true)
  })

  it('does NOT enter just below the enter threshold', () => {
    const est = (DENSITY_ENTER_PPP - 0.1) * PIXELS
    expect(shouldUseDensity({ n: 10_000_000, estimatedVisiblePoints: est, pixels: PIXELS, currentlyDensity: false })).toBe(
      false,
    )
  })

  it('HYSTERESIS: in the dead band it holds the CURRENT mode (no oscillation)', () => {
    const mid = ((DENSITY_ENTER_PPP + DENSITY_EXIT_PPP) / 2) * PIXELS
    expect(DENSITY_ENTER_PPP).toBeGreaterThan(DENSITY_EXIT_PPP)
    // same density, opposite current mode → stays whatever it was.
    expect(shouldUseDensity({ n: 10_000_000, estimatedVisiblePoints: mid, pixels: PIXELS, currentlyDensity: true })).toBe(
      true,
    )
    expect(shouldUseDensity({ n: 10_000_000, estimatedVisiblePoints: mid, pixels: PIXELS, currentlyDensity: false })).toBe(
      false,
    )
  })

  it('EXITS to points when zoomed in drops density below the exit threshold', () => {
    const est = (DENSITY_EXIT_PPP - 0.1) * PIXELS
    expect(shouldUseDensity({ n: 10_000_000, estimatedVisiblePoints: est, pixels: PIXELS, currentlyDensity: true })).toBe(
      false,
    )
  })
})

describe('viewportWorldBounds', () => {
  it('maps 2^zoom pixels per world unit; zooming in shrinks the visible rect', () => {
    // zoom 0 → 1 px/unit → a 1000px viewport spans 1000 world units (±500 around target).
    const b0 = viewportWorldBounds({ target: [0, 0], zoom: 0 }, 1000, 1000)
    expect(b0.maxX - b0.minX).toBeCloseTo(1000)
    // zoom 4 → 16 px/unit → same viewport spans 1000/16 = 62.5 world units.
    const b4 = viewportWorldBounds({ target: [0, 0], zoom: 4 }, 1000, 1000)
    expect(b4.maxX - b4.minX).toBeCloseTo(62.5)
    // centered on target.
    const bt = viewportWorldBounds({ target: [10, -5], zoom: 0 }, 100, 100)
    expect((bt.minX + bt.maxX) / 2).toBeCloseTo(10)
    expect((bt.minY + bt.maxY) / 2).toBeCloseTo(-5)
  })
})

describe('estimateVisiblePoints', () => {
  const DATA: DensityBounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 }

  it('returns ~all N when the view covers the whole data extent', () => {
    const view: DensityBounds = { minX: -5, minY: -5, maxX: 15, maxY: 15 }
    expect(estimateVisiblePoints(1_000, view, DATA)).toBe(1_000)
  })

  it('scales with the overlap fraction (uniform assumption)', () => {
    // view covers a quarter of the data area → ~N/4.
    const view: DensityBounds = { minX: 0, minY: 0, maxX: 5, maxY: 5 }
    expect(estimateVisiblePoints(1_000, view, DATA)).toBeCloseTo(250)
  })

  it('is 0 when the view is disjoint from the data', () => {
    const view: DensityBounds = { minX: 100, minY: 100, maxX: 110, maxY: 110 }
    expect(estimateVisiblePoints(1_000, view, DATA)).toBe(0)
  })

  // MED-2: a collinear/coincident cloud (spanX==0 or spanY==0 ⇒ zero data area) must NOT
  // report a camera-independent "all N visible" — that would peg the density estimate above
  // EXIT_PPP at every zoom and lock the view into the density image (zoom-in never restores
  // points). It returns 0 for a degenerate extent so the estimate stays exitable.
  it('returns 0 for a degenerate (zero-area) data extent — collinear or coincident cloud', () => {
    const view: DensityBounds = { minX: -5, minY: -5, maxX: 15, maxY: 15 }
    const collinearY: DensityBounds = { minX: 0, minY: 5, maxX: 10, maxY: 5 } // spanY == 0
    const collinearX: DensityBounds = { minX: 5, minY: 0, maxX: 5, maxY: 10 } // spanX == 0
    const coincident: DensityBounds = { minX: 3, minY: 3, maxX: 3, maxY: 3 } // both spans 0
    expect(estimateVisiblePoints(1_000, view, collinearY)).toBe(0)
    expect(estimateVisiblePoints(1_000, view, collinearX)).toBe(0)
    expect(estimateVisiblePoints(1_000, view, coincident)).toBe(0)
  })
})

// MED-2: end-to-end — a degenerate (collinear) embedding must never LOCK into the density
// image. Across every zoom (out and in), the estimate stays 0 so `shouldUseDensity` is
// false when entering and EXITABLE (false) when currently in density mode.
describe('collinear embedding never locks into density mode (MED-2)', () => {
  // A large-N collinear cloud: all points share y=5 ⇒ zero-area data extent.
  const collinear: DensityBounds = { minX: 0, minY: 5, maxX: 100, maxY: 5 }
  const N = 10_000_000
  const PIXELS = 1000 * 1000

  it('is never entered and is exitable at every zoom', () => {
    for (const zoom of [-4, -2, 0, 2, 4, 6]) {
      const view = viewportWorldBounds({ target: [50, 5], zoom }, 1000, 1000)
      const est = estimateVisiblePoints(N, view, collinear)
      expect(est).toBe(0) // camera-independent 0 (degenerate), not all-N
      // Entering from points: never engages.
      expect(
        shouldUseDensity({ n: N, estimatedVisiblePoints: est, pixels: PIXELS, currentlyDensity: false }),
      ).toBe(false)
      // If somehow already in density mode: always exitable back to points.
      expect(
        shouldUseDensity({ n: N, estimatedVisiblePoints: est, pixels: PIXELS, currentlyDensity: true }),
      ).toBe(false)
    }
  })
})
