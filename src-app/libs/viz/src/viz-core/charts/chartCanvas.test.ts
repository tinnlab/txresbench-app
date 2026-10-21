// chartCanvas.test.ts — pure unit coverage for the ChartCanvas auto-fit math.
// The statistical + matrix charts share ONE framing helper, `fitViewState`, whose
// DEFAULT must return an INDEPENDENT per-axis zoom `[zoomX, zoomY]` so the data fills
// the canvas on BOTH axes (x and y are unrelated units). An equal-aspect single zoom
// collapsed one axis to a sliver — the squished-bars bug this guards against.

import { describe, expect, it } from 'vitest'
import { fitViewState, fitSignature, boundsOfLayers, robustValueRange } from './ChartCanvas'

describe('fitViewState', () => {
  it('returns an independent per-axis zoom [zx, zy] by default (fill both axes)', () => {
    // Non-square bounds: x-range 4, y-range 2500. A tall/narrow value axis must NOT
    // squish the short category axis — each axis gets its own zoom.
    const vs = fitViewState([0, 0, 4, 2500])
    expect(Array.isArray(vs.zoom)).toBe(true)
    const zoom = vs.zoom as [number, number]
    expect(zoom).toHaveLength(2)
    const [zx, zy] = zoom
    // Smaller data range → larger zoom. x-range (4) < y-range (2500) ⇒ zx > zy.
    expect(zx).toBeGreaterThan(zy)
    expect(zx).not.toBe(zy)
  })

  it('centers the target on the data center', () => {
    const vs = fitViewState([2, 100, 6, 2600])
    expect(vs.target).toEqual([4, 1350, 0])
  })

  it('equal-aspect mode returns a single scalar zoom = min(zx, zy)', () => {
    const vs = fitViewState([0, 0, 4, 2500], undefined, undefined, undefined, true)
    expect(typeof vs.zoom).toBe('number')
    // The equal zoom must be the tighter (smaller) of the two per-axis zooms.
    const indep = fitViewState([0, 0, 4, 2500]).zoom as [number, number]
    expect(vs.zoom).toBe(Math.min(indep[0], indep[1]))
  })

  it('honors optional viewport width/height overrides', () => {
    const a = fitViewState([0, 0, 10, 10]) as { zoom: [number, number] }
    const b = fitViewState([0, 0, 10, 10], 1640, 1240) as { zoom: [number, number] }
    // Doubling the viewport (820→1640, 620→1240) raises both per-axis zooms by ~1.
    expect(b.zoom[0]).toBeGreaterThan(a.zoom[0])
    expect(b.zoom[1]).toBeGreaterThan(a.zoom[1])
  })

  it('is finite for a degenerate (zero-extent) axis', () => {
    // A single-value axis (e.g. one category) must not blow up to Infinity.
    const vs = fitViewState([3, 0, 3, 100]) as { zoom: [number, number] }
    expect(Number.isFinite(vs.zoom[0])).toBe(true)
    expect(Number.isFinite(vs.zoom[1])).toBe(true)
  })
})

describe('fitSignature', () => {
  // The controlled ChartCanvas gates its RE-FRAME on this VALUE signature, not on the
  // fit memo's identity — so an equal-but-new fit object must yield an equal signature
  // (else a parent re-render would clobber the user's live pan/zoom), while a genuine
  // resize / data-bounds change (a new framing) must yield a DIFFERENT signature.
  it('is stable for equal fits (equal value ⇒ equal signature — no spurious re-frame)', () => {
    const a = fitViewState([0, 0, 4, 2500], 800, 600)
    const b = fitViewState([0, 0, 4, 2500], 800, 600)
    expect(a).not.toBe(b) // distinct objects…
    expect(fitSignature(a)).toBe(fitSignature(b)) // …but the same framing signature
  })

  it('changes when the canvas size changes (a genuine resize re-frames)', () => {
    const small = fitViewState([0, 0, 4, 2500], 400, 300)
    const large = fitViewState([0, 0, 4, 2500], 900, 700)
    expect(fitSignature(small)).not.toBe(fitSignature(large))
  })

  it('changes when the data bounds change', () => {
    const a = fitViewState([0, 0, 4, 2500], 800, 600)
    const b = fitViewState([0, 0, 4, 3000], 800, 600)
    expect(fitSignature(a)).not.toBe(fitSignature(b))
  })

  it('serializes both scalar and 2-tuple zoom forms without throwing', () => {
    const tuple = fitViewState([0, 0, 4, 2500]) // default → [zx, zy]
    const scalar = fitViewState([0, 0, 4, 2500], undefined, undefined, undefined, true)
    expect(typeof fitSignature(tuple)).toBe('string')
    expect(typeof fitSignature(scalar)).toBe('string')
    // The empty/degenerate view state ({target:[0,0,0], zoom:0}) is also serializable.
    expect(fitSignature({ target: [0, 0, 0], zoom: 0 } as never)).toBe('0,0,0|0')
  })
})

describe('boundsOfLayers', () => {
  it('returns null for empty layers', () => {
    expect(boundsOfLayers([])).toBeNull()
  })
})

describe('robustValueRange', () => {
  it('returns null when nothing finite is supplied', () => {
    expect(robustValueRange([])).toBeNull()
    expect(robustValueRange([NaN, Infinity], [NaN])).toBeNull()
  })

  it('frames the core with a small pad when there are no soft points', () => {
    // core spans [0, 10] → 5% pad each side
    expect(robustValueRange([0, 10])).toEqual([-0.5, 10.5])
  })

  it('includes soft points that fall within the clamp cap', () => {
    // core [0,10] span=10, default cap=0.5*span=5 → soft up to 15 (top) / -5 (bottom) allowed
    const [lo, hi] = robustValueRange([0, 10], [-3, 13])!
    // -3 and 13 are within [−5, 15], so fully included, plus 5% pad
    expect(lo).toBeCloseTo(-3.5)
    expect(hi).toBeCloseTo(13.5)
  })

  it('CLAMPS a far outlier so it cannot dominate the frame (the squished-box fix)', () => {
    // A box set: bodies q1..q3 in [3,5], fences [2,6], plus ONE far outlier at 1000.
    // core = fences + bodies; soft = the outlier.
    const core = [2, 6, 3, 5, 4] // lowerFence, upperFence, q1, q3, median
    const soft = [1000]
    const [lo, hi] = robustValueRange(core, soft)!
    const span = 6 - 2 // core span = 4, cap = 0.5*4 = 2
    // The outlier may push the top by at most `cap` beyond the core (6 + 2 = 8), NOT to 1000.
    expect(hi).toBeLessThanOrEqual(8 + span * 0.05 + 1e-9)
    expect(hi).toBeGreaterThan(6) // it DID extend a little toward the outlier
    // The box body (q1=3..q3=5) still occupies a healthy fraction of the frame, not a sliver.
    const bodyFrac = (5 - 3) / (hi - lo)
    expect(bodyFrac).toBeGreaterThan(0.2)
  })

  it('falls back to the soft points when the core is empty', () => {
    const [lo, hi] = robustValueRange([], [2, 8])!
    expect(lo).toBeCloseTo(2 - 0.3) // span 6, 5% pad
    expect(hi).toBeCloseTo(8 + 0.3)
  })

  it('is finite for a degenerate (zero-span) core', () => {
    const r = robustValueRange([5, 5], [5])!
    expect(Number.isFinite(r[0])).toBe(true)
    expect(Number.isFinite(r[1])).toBe(true)
  })
})
