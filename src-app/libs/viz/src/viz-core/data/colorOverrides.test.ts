// colorOverrides.test.ts — the CATEGORICAL color-override layer (COLOR_PALETTE_PLAN):
// `extendPalette` (shortfall auto-extend), `resolveEffectivePalette` (by-name ∪ ordered ∪
// auto-extend, precedence), and `displayCategory` (label override + fallback). The critical
// invariant is BYTE-IDENTITY of the NO-override path: with no palette/by-name/labels and ≤20
// groups the resolution equals the built-in `categoryColor(code)`, so the pre-override render is
// unchanged. The color BUFFER + LEGEND parity guards live alongside.

import { describe, it, expect } from 'vitest'
import {
  extendPalette,
  resolveEffectivePalette,
  displayCategory,
  categoryColor,
  categoricalColors,
  legendDescriptor,
  CATEGORICAL_PALETTE,
  DEFAULT_CATEGORICAL_PALETTE,
  rgbToHex,
} from './color'
import { computeColoring, type ColorBy } from './engine'
import { buildPaletteLUT } from '../gpu/colormapLut'
import type { DataSource } from './wire'

const seed3 = CATEGORICAL_PALETTE.slice(0, 3) as (readonly [number, number, number])[]

describe('extendPalette — shortfall auto-extend (never a silent cycle)', () => {
  it('n <= seed.length returns the seed PREFIX unchanged (byte-identical)', () => {
    const out = extendPalette(seed3, 2)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual([...seed3[0]])
    expect(out[1]).toEqual([...seed3[1]])
  })

  it('n === seed.length returns the whole seed unchanged', () => {
    const out = extendPalette(seed3, 3)
    expect(out.map(c => c.join(','))).toEqual(seed3.map(c => c.join(',')))
  })

  it('n > seed.length keeps the seed prefix then appends generated colors', () => {
    const out = extendPalette(seed3, 8)
    expect(out).toHaveLength(8)
    // prefix preserved
    for (let i = 0; i < 3; i++) expect(out[i]).toEqual([...seed3[i]])
    // generated tail present
    expect(out.slice(3)).toHaveLength(5)
  })

  it('n > seed.length yields n DISTINCT colors (no two identical)', () => {
    const out = extendPalette(seed3, 40)
    const unique = new Set(out.map(c => c.join(',')))
    expect(unique.size).toBe(40)
  })

  it('generated colors are valid bytes in [0,255]', () => {
    const out = extendPalette(seed3, 30)
    for (const [r, g, b] of out) {
      for (const c of [r, g, b]) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(255)
        expect(Number.isInteger(c)).toBe(true)
      }
    }
  })
})

describe('resolveEffectivePalette — precedence + byte-identity', () => {
  const cats = ['A', 'B', 'C', 'D']

  it('NO overrides + ≤20 groups === built-in categoryColor(code) (byte-identical)', () => {
    const eff = resolveEffectivePalette(cats)
    eff.forEach((rgb, code) => expect(rgb).toEqual([...categoryColor(code)]))
  })

  it('an ORDERED palette overrides by code index', () => {
    const eff = resolveEffectivePalette(cats, { palette: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'] })
    expect(eff[0]).toEqual([255, 0, 0])
    expect(eff[1]).toEqual([0, 255, 0])
    expect(eff[2]).toEqual([0, 0, 255])
    expect(eff[3]).toEqual([255, 255, 255])
  })

  it('accepts both CSS strings and byte triples in the ordered palette', () => {
    const eff = resolveEffectivePalette(['A', 'B'], { palette: ['rgb(10, 20, 30)', [40, 50, 60]] })
    expect(eff[0]).toEqual([10, 20, 30])
    expect(eff[1]).toEqual([40, 50, 60])
  })

  it('a BY-NAME map wins over the ordered palette for a matching category', () => {
    const eff = resolveEffectivePalette(cats, {
      palette: ['#ff0000', '#00ff00', '#0000ff', '#ffffff'],
      categoryColors: { C: '#123456' },
    })
    // C (code 2) taken from the by-name map, not the ordered palette
    expect(eff[2]).toEqual([0x12, 0x34, 0x56])
    // the others still come from the ordered palette
    expect(eff[0]).toEqual([255, 0, 0])
  })

  it('by-name identity is STABLE regardless of code order (same name → same color)', () => {
    const colors = { T: '#aa0000', B: '#00aa00' }
    const a = resolveEffectivePalette(['T', 'B'], { categoryColors: colors })
    const b = resolveEffectivePalette(['B', 'T'], { categoryColors: colors })
    // 'T' gets #aa0000 in both, at whatever code it lands
    expect(a[0]).toEqual([0xaa, 0, 0]) // T at code 0
    expect(b[1]).toEqual([0xaa, 0, 0]) // T at code 1
    expect(a[1]).toEqual([0, 0xaa, 0]) // B at code 1
    expect(b[0]).toEqual([0, 0xaa, 0]) // B at code 0
  })

  it('a SHORT custom palette auto-extends (does not cycle) to the category count', () => {
    const many = Array.from({ length: 6 }, (_, i) => `g${i}`)
    const eff = resolveEffectivePalette(many, { palette: ['#ff0000', '#00ff00'] })
    expect(eff).toHaveLength(6)
    // the two provided win at codes 0/1
    expect(eff[0]).toEqual([255, 0, 0])
    expect(eff[1]).toEqual([0, 255, 0])
    // the rest are generated + all 6 are distinct (no cycle back to red/green)
    expect(new Set(eff.map(c => c.join(','))).size).toBe(6)
  })

  it('beyond the default palette, auto-extends instead of cycling', () => {
    const base = DEFAULT_CATEGORICAL_PALETTE.length // 28 (Okabe-Ito + tab20)
    const N = base + 8
    const many = Array.from({ length: N }, (_, i) => `g${i}`)
    const eff = resolveEffectivePalette(many)
    expect(eff).toHaveLength(N)
    // first `base` are the DEFAULT palette (byte-identical, Okabe-Ito-first per ITEM-11)
    for (let i = 0; i < base; i++) expect(eff[i]).toEqual([...DEFAULT_CATEGORICAL_PALETTE[i]])
    // code `base` would have been DEFAULT_CATEGORICAL_PALETTE[0] under a naive cycle — it must NOT be
    expect(eff[base]).not.toEqual([...DEFAULT_CATEGORICAL_PALETTE[0]])
    // all distinct
    expect(new Set(eff.map(c => c.join(','))).size).toBe(N)
  })
})

describe('displayCategory — label override + fallback', () => {
  it('returns the override label when present', () => {
    expect(displayCategory('3', { '3': 'T cells' })).toBe('T cells')
  })
  it('falls back to the raw name when no override', () => {
    expect(displayCategory('3', { '7': 'B cells' })).toBe('3')
    expect(displayCategory('3')).toBe('3')
  })
})

describe('categoricalColors — override-aware color buffer', () => {
  it('NO categories arg keeps the exact built-in cycle (byte-identical)', () => {
    const c = categoricalColors(new Uint16Array([0, 1, 0]))
    expect(c.length).toBe(3 * 4)
    // same code → same color
    expect(Array.from(c.slice(0, 3))).toEqual(Array.from(c.slice(8, 11)))
    // code 0 == default palette[0] (Okabe-Ito black, ITEM-11)
    expect(Array.from(c.slice(0, 3))).toEqual([...DEFAULT_CATEGORICAL_PALETTE[0]])
  })

  it('with categories + no overrides === the built-in buffer (byte-identical)', () => {
    const codes = new Uint16Array([0, 1, 2])
    const withCats = categoricalColors(codes, { categories: ['A', 'B', 'C'] })
    const plain = categoricalColors(codes)
    expect(Array.from(withCats)).toEqual(Array.from(plain))
  })

  it('applies a by-name override to the matching code', () => {
    const codes = new Uint16Array([0, 1])
    const c = categoricalColors(codes, { categories: ['A', 'B'], categoryColors: { B: '#010203' } })
    expect(Array.from(c.slice(4, 7))).toEqual([1, 2, 3]) // code 1 (B)
  })

  it('honors the hidden set (transparent) regardless of overrides', () => {
    const codes = new Uint16Array([0, 1])
    const c = categoricalColors(codes, {
      categories: ['A', 'B'],
      palette: ['#ff0000', '#00ff00'],
      hidden: new Set([1]),
    })
    expect(Array.from(c.slice(4, 8))).toEqual([0, 0, 0, 0]) // hidden → transparent
  })
})

describe('legendDescriptor — override-aware swatches + labels', () => {
  it('NO overrides === raw labels + built-in swatch hex (byte-identical)', () => {
    const d = legendDescriptor(['A', 'B'])
    expect(d.entries[0].label).toBe('A')
    expect(d.entries[0].hex).toBe(rgbToHex(categoryColor(0)))
    expect(d.entries[1].hex).toBe(rgbToHex(categoryColor(1)))
  })

  it('routes the swatch color + label through the overrides', () => {
    const d = legendDescriptor(['3', '7'], {
      categoryColors: { '3': '#abcdef' },
      categoryLabels: { '3': 'T cells' },
    })
    expect(d.entries[0].label).toBe('T cells')
    expect(d.entries[0].hex).toBe('#abcdef')
    // untouched entry keeps its raw label + built-in color
    expect(d.entries[1].label).toBe('7')
    expect(d.entries[1].hex).toBe(rgbToHex(categoryColor(1)))
  })
})

describe('buildPaletteLUT — GPU LUT from the effective palette', () => {
  it('NO arg === the default palette cycle (byte-identical)', () => {
    const lut = buildPaletteLUT()
    const n = DEFAULT_CATEGORICAL_PALETTE.length
    for (const i of [0, 1, n - 1, n, 255]) {
      const [r, g, b] = DEFAULT_CATEGORICAL_PALETTE[i % n]
      const o = i * 4
      expect([lut[o], lut[o + 1], lut[o + 2]]).toEqual([r, g, b])
    }
  })

  it('an effective palette drives the low texels (code → override color)', () => {
    const eff = resolveEffectivePalette(['A', 'B', 'C'], { categoryColors: { B: '#010203' } })
    const lut = buildPaletteLUT(eff)
    expect([lut[0], lut[1], lut[2]]).toEqual([...eff[0]])
    expect([lut[4], lut[5], lut[6]]).toEqual([1, 2, 3]) // code 1 (B) override
    expect([lut[8], lut[9], lut[10]]).toEqual([...eff[2]])
  })
})

// The GPU LUT ⇔ CPU/legend PARITY guard (the color-consistency bug this change fixes): for a
// categorical scatter with >20 groups + NO custom palette, the GPU in-shader palette LUT (built
// from `resolveEffectivePalette`) must sample the SAME auto-extended color per code as the CPU
// buffer (`categoricalColors`) — NOT the built-in 20-cycle. The render path (CategoricalPointsView
// / DeckScatterCanvas via `GpuColormapSpec.palette`) now threads that effective palette into
// `buildPaletteLUT`, so GPU == CPU == legend for any N.
describe('GPU palette LUT ⇔ CPU categorical parity (>20 groups, no override)', () => {
  const lutTexel = (lut: Uint8Array, code: number): [number, number, number] => [
    lut[code * 4],
    lut[code * 4 + 1],
    lut[code * 4 + 2],
  ]
  const cpuColor = (colors: Uint8Array, i: number): [number, number, number] => [
    colors[i * 4],
    colors[i * 4 + 1],
    colors[i * 4 + 2],
  ]

  it('N=24: the effective-palette LUT texel per code === the CPU buffer color (auto-extended, NOT cycled)', () => {
    const N = 24
    const cats = Array.from({ length: N }, (_, i) => `g${i}`)
    const codes = Uint16Array.from(cats.map((_, i) => i))
    const eff = resolveEffectivePalette(cats)
    const lut = buildPaletteLUT(eff)
    // The CPU precompute path (override/auto-extend-aware) over one point per code.
    const cpu = categoricalColors(codes, { categories: cats })
    for (let code = 0; code < N; code++) {
      expect(lutTexel(lut, code)).toEqual(cpuColor(cpu, code))
      expect(lutTexel(lut, code)).toEqual([...eff[code]])
    }
    // The bug's signature: higher codes must NOT collapse back onto the default palette head
    // (a naive `palette[code % base]` cycle) — they are distinct generated colors.
    for (let code = 20; code < N; code++) {
      expect(lutTexel(lut, code)).not.toEqual([...DEFAULT_CATEGORICAL_PALETTE[0]])
    }
    // All 24 sampled texels are DISTINCT (no silent cycle collision).
    const distinct = new Set(
      Array.from({ length: N }, (_, code) => lutTexel(lut, code).join(',')),
    )
    expect(distinct.size).toBe(N)
  })

  it('N=30 legend swatch === LUT texel per code (CategoricalPointsView legend/GPU agree)', () => {
    const N = 30
    const cats = Array.from({ length: N }, (_, i) => `Category ${i}`)
    const eff = resolveEffectivePalette(cats)
    const lut = buildPaletteLUT(eff)
    for (let code = 0; code < N; code++) {
      // the legend swatch hex is rgbToHex(eff[code]); the GPU samples LUT texel `code`.
      expect(rgbToHex(lutTexel(lut, code))).toBe(rgbToHex(eff[code]))
    }
  })

  it('≤20 groups: sampled LUT texels stay byte-identical to the built-in cycle', () => {
    const N = 12
    const cats = Array.from({ length: N }, (_, i) => `g${i}`)
    const eff = resolveEffectivePalette(cats)
    const withEff = buildPaletteLUT(eff)
    const builtin = buildPaletteLUT() // no-arg = the pre-fix built-in cycle
    for (let code = 0; code < N; code++) {
      // sampled texels (the only ones the shader reads: codes [0, N)) are unchanged
      expect(lutTexel(withEff, code)).toEqual(lutTexel(builtin, code))
      expect(lutTexel(withEff, code)).toEqual([...categoryColor(code)])
    }
  })
})

// A tiny in-memory DataSource for the categorical computeColoring path (mirrors blend.test).
function stubSource(categories: string[], codes: number[]): DataSource {
  return {
    categorical: async () => ({ codes: new Uint16Array(codes), categories, length: codes.length }),
  } as unknown as DataSource
}

describe('computeColoring — categorical dispatch honors + defaults the overrides', () => {
  const base: ColorBy = {
    mode: 'categorical',
    key: 'group',
    colormap: 'viridis',
    scale: 'linear',
    hidden: new Set<number>(),
  }

  it('NO overrides is byte-identical to the default palette (Okabe-Ito, ITEM-11)', async () => {
    const c = await computeColoring(stubSource(['A', 'B'], [0, 1, 0]), base)
    expect(Array.from(c.colors.slice(0, 3))).toEqual([...DEFAULT_CATEGORICAL_PALETTE[0]])
    expect(Array.from(c.colors.slice(4, 7))).toEqual([...DEFAULT_CATEGORICAL_PALETTE[1]])
    // legend labels are the raw category names
    expect(c.legend?.entries.map(e => e.label)).toEqual(['A', 'B'])
  })

  it('by-name + label overrides flow into BOTH the color buffer and the legend', async () => {
    const c = await computeColoring(stubSource(['A', 'B'], [0, 1]), {
      ...base,
      categoryColors: { A: '#010203' },
      categoryLabels: { A: 'Alpha' },
    })
    expect(Array.from(c.colors.slice(0, 3))).toEqual([1, 2, 3]) // A override
    expect(c.legend?.entries[0].label).toBe('Alpha')
    expect(c.legend?.entries[0].hex).toBe('#010203')
  })
})
