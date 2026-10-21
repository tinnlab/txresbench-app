// blend.test.ts — BLEND MODE Phase 1 (BLEND_MODE_PLAN). Covers the PURE blend reduce math
// (per-group vs shared-global normalization), the RGB↔HSL helper (round-trip + lightness
// scaling), the 2D legend descriptor, and the `computeColoring` blend DISPATCH (two-attribute
// payload present for blend, ABSENT for every single-channel mode — the byte-identity guard).

import { describe, it, expect } from 'vitest'
import {
  computeBlendEncoding,
  buildBlend2DLegend,
  normalizeMod,
  DEFAULT_ALPHA_FLOOR,
} from './blend'
import { rgbToHsl, hslToRgb, scaleLightness, categoryColor } from './color'
import { computeColoring, type ColorBy } from './engine'
import type { DataSource } from './wire'

describe('normalizeMod', () => {
  it('maps a value into [0,1] over [lo,hi]', () => {
    expect(normalizeMod(5, 0, 10)).toBeCloseTo(0.5)
    expect(normalizeMod(0, 0, 10)).toBe(0)
    expect(normalizeMod(10, 0, 10)).toBe(1)
  })
  it('clamps out-of-range', () => {
    expect(normalizeMod(-5, 0, 10)).toBe(0)
    expect(normalizeMod(15, 0, 10)).toBe(1)
  })
  it('a degenerate span → 1 (uniform group shows at FULL modulation, not dim)', () => {
    expect(normalizeMod(7, 7, 7)).toBe(1)
  })
  it('non-finite → 0', () => {
    expect(normalizeMod(NaN, 0, 10)).toBe(0)
  })
})

describe('computeBlendEncoding — per-group (default) domain math', () => {
  it('normalizes each point WITHIN its own category [min,max]', () => {
    const codes = new Uint16Array([0, 0, 1, 1])
    const values = new Float32Array([10, 20, 100, 300])
    const enc = computeBlendEncoding(codes, values) // perGroupDomain defaults true
    expect(enc.perGroupDomain).toBe(true)
    expect([...enc.codes]).toEqual([0, 0, 1, 1])
    // group 0: [10,20] → 0,1 ; group 1: [100,300] → 0,1
    expect([...enc.modValue]).toEqual([0, 1, 0, 1])
    expect(enc.modDomain).toEqual([0, 1])
    expect(enc.globalDomain).toEqual([10, 300])
    expect(enc.groupDomains.get(0)).toEqual([10, 20])
    expect(enc.groupDomains.get(1)).toEqual([100, 300])
  })

  it('a single-value group ramps to 1 (full), not 0', () => {
    const enc = computeBlendEncoding(new Uint16Array([0, 0]), new Float32Array([5, 5]))
    expect([...enc.modValue]).toEqual([1, 1])
  })

  it('applies the domain scale (log2) before the per-group normalization', () => {
    const codes = new Uint16Array([0, 0, 0])
    const values = new Float32Array([0, 3, 15]) // log2(x+1) = 0, 2, 4
    const enc = computeBlendEncoding(codes, values, { scale: 'log2' })
    // scaled group domain [0,4] → 0, 0.5, 1
    expect(enc.modValue[0]).toBeCloseTo(0)
    expect(enc.modValue[1]).toBeCloseTo(0.5)
    expect(enc.modValue[2]).toBeCloseTo(1)
    expect(enc.groupDomains.get(0)![0]).toBeCloseTo(0)
    expect(enc.groupDomains.get(0)![1]).toBeCloseTo(4)
  })
})

describe('computeBlendEncoding — shared-global domain', () => {
  it('keeps the scaled raw value + the real global domain (for cross-panel comparability)', () => {
    const codes = new Uint16Array([0, 0, 1, 1])
    const values = new Float32Array([10, 20, 100, 300])
    const enc = computeBlendEncoding(codes, values, { perGroupDomain: false })
    expect(enc.perGroupDomain).toBe(false)
    expect([...enc.modValue]).toEqual([10, 20, 100, 300]) // raw (identity scale)
    expect(enc.modDomain).toEqual([10, 300])
    expect(enc.globalDomain).toEqual([10, 300])
  })
})

describe('rgbToHsl / hslToRgb — round-trip + lightness scaling', () => {
  const samples: [number, number, number][] = [
    [31, 119, 180],
    [255, 127, 14],
    [44, 160, 44],
    [0, 0, 0],
    [255, 255, 255],
    [128, 128, 128],
    [200, 30, 90],
  ]
  it('round-trips rgb → hsl → rgb within ±2 bytes', () => {
    for (const rgb of samples) {
      const back = hslToRgb(rgbToHsl(rgb))
      for (let k = 0; k < 3; k++) expect(Math.abs(back[k] - rgb[k])).toBeLessThanOrEqual(2)
    }
  })
  it('scaleLightness(_, 1) is (near) identity; a smaller factor darkens (lower luminance)', () => {
    const rgb: [number, number, number] = [31, 119, 180]
    const id = scaleLightness(rgb, 1)
    for (let k = 0; k < 3; k++) expect(Math.abs(id[k] - rgb[k])).toBeLessThanOrEqual(2)
    const dim = scaleLightness(rgb, 0.3)
    const lum = (c: readonly number[]) => c[0] + c[1] + c[2]
    expect(lum(dim)).toBeLessThan(lum(rgb))
    // lightness monotonic in the factor
    const mid = scaleLightness(rgb, 0.6)
    expect(lum(dim)).toBeLessThanOrEqual(lum(mid))
    expect(lum(mid)).toBeLessThanOrEqual(lum(scaleLightness(rgb, 1)))
  })
  it('scaleLightness preserves hue (hsl h stays constant under L scaling)', () => {
    const rgb: [number, number, number] = [200, 30, 90]
    const h0 = rgbToHsl(rgb)[0]
    const h1 = rgbToHsl(scaleLightness(rgb, 0.5))[0]
    expect(Math.abs(h1 - h0)).toBeLessThan(2)
  })
})

describe('buildBlend2DLegend', () => {
  it('produces one hue row per category with its stable palette hex', () => {
    const legend = buildBlend2DLegend(['A', 'B', 'C'], {
      channel: 'lightness',
      alphaFloor: 0.1,
      perGroupDomain: true,
      valueDomain: [0, 1],
    })
    expect(legend.kind).toBe('blend')
    expect(legend.channel).toBe('lightness')
    expect(legend.rows).toHaveLength(3)
    expect(legend.rows[0].code).toBe(0)
    expect(legend.rows[1].label).toBe('B')
    // hex matches the categorical palette (same source as the scatter hue)
    const [r, g, b] = categoryColor(0)
    expect(legend.rows[0].hex.toLowerCase()).toBe(
      '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join(''),
    )
    expect(legend.valueDomain).toEqual([0, 1])
    expect(legend.perGroupDomain).toBe(true)
  })
})

// A tiny in-memory DataSource: computeColoring's blend branch only calls categorical() +
// continuous(), so a partial stub suffices (cast through unknown).
function stubSource(): DataSource {
  return {
    categorical: async () => ({
      codes: new Uint16Array([0, 0, 1]),
      categories: ['A', 'B'],
      length: 3,
    }),
    continuous: async () => ({ value: new Float32Array([1, 2, 3]), length: 3 }),
  } as unknown as DataSource
}

describe('computeColoring — blend dispatch (the two-attribute path)', () => {
  const blendColorBy: ColorBy = {
    mode: 'blend',
    key: 'group',
    categoryKey: 'group',
    valueKey: 'qcA',
    channel: 'lightness',
    perGroupDomain: true,
    colormap: 'viridis',
    scale: 'linear',
    hidden: new Set(),
  }

  it('returns the GPU blend payload (codes + normalized mod + modDomain + 2D legend) + CPU colors', async () => {
    const c = await computeColoring(stubSource(), blendColorBy)
    expect(c.blend).toBeDefined()
    const b = c.blend!
    expect(b.codes).toBeInstanceOf(Float32Array)
    expect([...b.codes]).toEqual([0, 0, 1])
    expect(b.modValue).toBeInstanceOf(Float32Array)
    expect(b.modValue).toHaveLength(3)
    expect(b.modDomain).toEqual([0, 1]) // per-group
    expect(b.channel).toBe('lightness')
    expect(b.alphaFloor).toBe(DEFAULT_ALPHA_FLOOR)
    expect(b.legend2d.rows).toHaveLength(2)
    // the CPU fallback color buffer is still N*4 (callers reading `.colors` unaffected)
    expect(c.colors).toHaveLength(3 * 4)
  })

  it('an alpha-channel blend ramps alpha (not lightness) from the floor', async () => {
    const c = await computeColoring(stubSource(), { ...blendColorBy, channel: 'alpha', alphaFloor: 0.2 })
    const b = c.blend!
    expect(b.channel).toBe('alpha')
    // point 0 is the group-0 min (modValue 0) → alpha ≈ floor*255; rgb = the base hue
    const [r, g] = categoryColor(0)
    expect(c.colors[0]).toBe(r)
    expect(c.colors[1]).toBe(g)
    expect(c.colors[3]).toBe(Math.round(0.2 * 255))
  })

  it('a SINGLE-CHANNEL mode returns NO blend field (byte-identity guard)', async () => {
    const cat = await computeColoring(stubSource(), {
      mode: 'categorical',
      key: 'group',
      colormap: 'viridis',
      scale: 'linear',
      hidden: new Set(),
    })
    expect(cat.blend).toBeUndefined()
    expect(cat.legend).toBeDefined()
  })
})
