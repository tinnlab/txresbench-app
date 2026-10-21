import { describe, it, expect } from 'vitest'
import {
  buildScatterProps,
  chooseLayerMode,
  computeCentroids,
  DEFAULT_LOD,
  DEFAULT_SIZE_ALPHA,
  sizeAlphaForDensity,
  shouldAdditiveBlend,
  ADDITIVE_ENTER_PPP,
  ADDITIVE_EXIT_PPP,
} from './scatter'

describe('scatter layer builder — binary attributes (TEST-4)', () => {
  it('feeds binary typed-array attributes (never array-of-objects)', () => {
    const positions = new Float32Array([0, 0, 1, 1, 2, 2])
    const colors = new Uint8Array(3 * 4)
    const props = buildScatterProps({ positions, colors })
    expect(props.data.length).toBe(3)
    expect(props.data.attributes.getPosition.value).toBe(positions)
    expect(props.data.attributes.getPosition.size).toBe(2)
    expect(props.data.attributes.getFillColor.value).toBe(colors)
    expect(props.data.attributes.getFillColor.size).toBe(4)
    expect(props.data.attributes.getFillColor.normalized).toBe(true)
    // scientific-scatter defaults
    expect(props.radiusUnits).toBe('pixels')
    expect(props.radiusMinPixels).toBe(1)
    expect(props.stroked).toBe(false)
    expect(props.antialiasing).toBe(true)
  })

  it('additive mode turns off AA and sets additive blend params', () => {
    const props = buildScatterProps({
      positions: new Float32Array([0, 0]),
      colors: new Uint8Array(4),
      additive: true,
    })
    expect(props.antialiasing).toBe(false)
    expect(props.parameters?.blendColorDstFactor).toBe('one')
  })

  it('additive mode lowers the radius floor sub-pixel; crisp mode keeps the 1px floor', () => {
    const crisp = buildScatterProps({ positions: new Float32Array([0, 0]), colors: new Uint8Array(4) })
    const dense = buildScatterProps({
      positions: new Float32Array([0, 0]),
      colors: new Uint8Array(4),
      additive: true,
    })
    expect(crisp.radiusMinPixels).toBe(1)
    expect(dense.radiusMinPixels).toBe(0.5)
    expect(dense.radiusMinPixels).toBeLessThan(crisp.radiusMinPixels)
  })
})

describe('overdraw-bounding: sizeAlphaForDensity (research item #5)', () => {
  const base = 3

  it('is crisp + opaque at (or below) low density — DEFAULT-SAFE identity', () => {
    for (const d of [0, DEFAULT_SIZE_ALPHA.lowPpp * 0.5, DEFAULT_SIZE_ALPHA.lowPpp]) {
      const { radius, alpha } = sizeAlphaForDensity(d, base)
      expect(radius).toBeCloseTo(base, 6)
      expect(alpha).toBeCloseTo(1, 6)
    }
  })

  it('is small + translucent at high density (pinned to the floors)', () => {
    const { radius, alpha } = sizeAlphaForDensity(DEFAULT_SIZE_ALPHA.highPpp, base)
    expect(radius).toBeCloseTo(base * DEFAULT_SIZE_ALPHA.radiusFloorFactor, 6)
    expect(alpha).toBeCloseTo(DEFAULT_SIZE_ALPHA.alphaFloor, 6)
    expect(radius).toBeLessThan(base)
    expect(alpha).toBeLessThan(1)
  })

  it('is monotonic non-increasing in density (both radius and alpha)', () => {
    let prevR = Infinity
    let prevA = Infinity
    for (let d = 0; d <= 3; d += 0.05) {
      const { radius, alpha } = sizeAlphaForDensity(d, base)
      expect(radius).toBeLessThanOrEqual(prevR + 1e-9)
      expect(alpha).toBeLessThanOrEqual(prevA + 1e-9)
      prevR = radius
      prevA = alpha
    }
  })

  it('clamps beyond high density (pins to floors) and for non-finite / negative input', () => {
    const beyond = sizeAlphaForDensity(DEFAULT_SIZE_ALPHA.highPpp * 100, base)
    expect(beyond.radius).toBeCloseTo(base * DEFAULT_SIZE_ALPHA.radiusFloorFactor, 6)
    expect(beyond.alpha).toBeCloseTo(DEFAULT_SIZE_ALPHA.alphaFloor, 6)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const { radius, alpha } = sizeAlphaForDensity(bad, base)
      expect(radius).toBeCloseTo(base, 6) // treated as sparse → identity
      expect(alpha).toBeCloseTo(1, 6)
    }
  })

  it('honors a custom config (floors + knees)', () => {
    const cfg = { lowPpp: 0, highPpp: 1, radiusFloorFactor: 0.2, alphaFloor: 0.1 }
    expect(sizeAlphaForDensity(0, base, cfg).alpha).toBeCloseTo(1, 6)
    const hi = sizeAlphaForDensity(1, base, cfg)
    expect(hi.radius).toBeCloseTo(base * 0.2, 6)
    expect(hi.alpha).toBeCloseTo(0.1, 6)
  })
})

describe('overdraw-bounding: shouldAdditiveBlend hysteresis (research item #5)', () => {
  it('over-blends when sparse, additive-blends when dense', () => {
    expect(shouldAdditiveBlend(0, false)).toBe(false)
    expect(shouldAdditiveBlend(ADDITIVE_ENTER_PPP, false)).toBe(true)
    expect(shouldAdditiveBlend(ADDITIVE_ENTER_PPP + 1, false)).toBe(true)
  })

  it('has a dead band: inside [exit, enter) the current mode holds (no oscillation)', () => {
    const mid = (ADDITIVE_ENTER_PPP + ADDITIVE_EXIT_PPP) / 2
    expect(mid).toBeGreaterThan(ADDITIVE_EXIT_PPP)
    expect(mid).toBeLessThan(ADDITIVE_ENTER_PPP)
    // currently over-blending → stays over (mid < enter)
    expect(shouldAdditiveBlend(mid, false)).toBe(false)
    // currently additive → stays additive (mid > exit)
    expect(shouldAdditiveBlend(mid, true)).toBe(true)
  })

  it('leaves additive only once density drops below the exit threshold', () => {
    expect(shouldAdditiveBlend(ADDITIVE_EXIT_PPP + 0.01, true)).toBe(true)
    expect(shouldAdditiveBlend(ADDITIVE_EXIT_PPP, true)).toBe(false)
    expect(shouldAdditiveBlend(0, true)).toBe(false)
  })

  it('is safe for non-finite / negative density (defaults to over-blend)', () => {
    expect(shouldAdditiveBlend(Number.NaN, false)).toBe(false)
    expect(shouldAdditiveBlend(-1, false)).toBe(false)
  })
})

describe('LOD gating (TEST-10)', () => {
  it('swaps to density below the zoom floor or above the point threshold', () => {
    expect(chooseLayerMode(0, 1000)).toBe('scatter')
    expect(chooseLayerMode(DEFAULT_LOD.minScatterZoom - 1, 1000)).toBe('density')
    expect(chooseLayerMode(0, DEFAULT_LOD.pointThreshold + 1)).toBe('density')
  })
})

describe('centroids (TEST-21)', () => {
  it('computes per-group mean positions', () => {
    const positions = new Float32Array([0, 0, 2, 0, 10, 10, 12, 10])
    const codes = new Uint16Array([0, 0, 1, 1])
    const c = computeCentroids(positions, codes)
    expect(c.get(0)).toEqual([1, 0])
    expect(c.get(1)).toEqual([11, 10])
  })
})

// Audit GPU-INFO-6: buildScatterProps asserts the binary-attribute length invariant at the boundary.
describe('buildScatterProps — binary length invariant', () => {
  const pos = new Float32Array([0, 0, 1, 1, 2, 2]) // 3 points
  it('accepts matching colors (N*4) + radii (N)', () => {
    expect(() => buildScatterProps({ positions: pos, colors: new Uint8Array(12), radii: new Float32Array(3) })).not.toThrow()
  })
  it('throws a clear [viz] error on a colors length mismatch', () => {
    expect(() => buildScatterProps({ positions: pos, colors: new Uint8Array(8) })).toThrow(/\[viz\] buildScatterProps: colors length/)
  })
  it('accepts the length-0 EMPTY_COLORS sentinel (GPU-colormap path overrides `data`)', () => {
    // ColormapScatterLayer callers pass an empty colors buffer + override `data` with LUT-colored
    // attributes, so a 0-length `colors` must NOT throw (only a genuine non-zero mismatch does).
    expect(() => buildScatterProps({ positions: pos, colors: new Uint8Array(0) })).not.toThrow()
  })
  it('throws on a radii length mismatch', () => {
    expect(() => buildScatterProps({ positions: pos, colors: new Uint8Array(12), radii: new Float32Array(2) })).toThrow(/\[viz\] buildScatterProps: radii length/)
  })
})
