// blendReduce.test.ts — BLEND MODE Phase 2 (BLEND_MODE_PLAN Phase 2). The PURE multi-column
// REDUCE math: concatenate N categorical columns into one composite category (cross-product,
// stable order, only-occurring combos), aggregate M continuous columns via each operator
// (mean/sum/min/max/median) with pre-aggregate [0,1] normalization, and the single-column
// PARITY guard (one categorical + one continuous reduces byte-identically to the Phase-1
// inputs). Also the `computeColoring` multi-column blend DISPATCH.

import { describe, it, expect } from 'vitest'
import {
  reduceBlendColumns,
  concatCategoricalColumns,
  aggregateContinuousColumns,
  DEFAULT_BLEND_AGGREGATE,
  COMPOSITE_SEPARATOR,
  ALL_CATEGORY_LABEL,
} from './blendReduce'
import { computeColoring, type ColorBy } from './engine'
import type { DataSource } from './wire'

describe('concatCategoricalColumns — composite cross-product', () => {
  it('concatenates two columns into the observed cross-product (first-occurrence order, only-occurring combos)', () => {
    // Points:  (A,X) (A,Y) (B,X) (A,X) (B,Y)  — 4 distinct occurring combos, (B,X) also occurs.
    const col0 = { codes: new Uint16Array([0, 0, 1, 0, 1]), categories: ['A', 'B'] }
    const col1 = { codes: new Uint16Array([0, 1, 0, 0, 1]), categories: ['X', 'Y'] }
    const r = concatCategoricalColumns([col0, col1])
    const sep = COMPOSITE_SEPARATOR
    // first-occurrence order: A|X, A|Y, B|X, B|Y
    expect(r.compositeCategories).toEqual([`A${sep}X`, `A${sep}Y`, `B${sep}X`, `B${sep}Y`])
    expect([...r.compositeCodes]).toEqual([0, 1, 2, 0, 3])
    // exactly the combos that occur — a non-occurring combo is NOT in the domain
    expect(r.compositeCategories).toHaveLength(4) // NOT 2×2 unless all occur
  })

  it('omits combinations that never occur (domain = observed cross-product, not full product)', () => {
    // Only (A,X) and (B,Y) occur — the full 2×2 product would have 4; observed has 2.
    const col0 = { codes: new Uint16Array([0, 1, 0]), categories: ['A', 'B'] }
    const col1 = { codes: new Uint16Array([0, 1, 0]), categories: ['X', 'Y'] }
    const r = concatCategoricalColumns([col0, col1])
    expect(r.compositeCategories).toEqual([`A${COMPOSITE_SEPARATOR}X`, `B${COMPOSITE_SEPARATOR}Y`])
    expect([...r.compositeCodes]).toEqual([0, 1, 0])
  })

  it('concatenates THREE columns', () => {
    const a = { codes: new Uint16Array([0, 1]), categories: ['A', 'B'] }
    const b = { codes: new Uint16Array([0, 0]), categories: ['X', 'Y'] }
    const c = { codes: new Uint16Array([1, 0]), categories: ['P', 'Q'] }
    const r = concatCategoricalColumns([a, b, c])
    const s = COMPOSITE_SEPARATOR
    expect(r.compositeCategories).toEqual([`A${s}X${s}Q`, `B${s}X${s}P`])
    expect([...r.compositeCodes]).toEqual([0, 1])
  })

  it('SINGLE column is a pass-through: original codes + FULL category list (Phase-1 parity)', () => {
    const col = { codes: new Uint16Array([2, 0, 1, 2]), categories: ['A', 'B', 'C'] }
    const r = concatCategoricalColumns([col])
    expect([...r.compositeCodes]).toEqual([2, 0, 1, 2]) // NOT occurrence-remapped
    expect(r.compositeCategories).toEqual(['A', 'B', 'C']) // FULL list, original order
  })

  it('zero columns → empty', () => {
    const r = concatCategoricalColumns([])
    expect(r.compositeCategories).toEqual([])
    expect(r.compositeCodes).toHaveLength(0)
  })
})

describe('aggregateContinuousColumns — each operator on a known vector', () => {
  // Two columns with DIFFERENT ranges → normalization matters. Pick a single point so the
  // per-column [0,1] normalization is exact and the operator output is hand-computable.
  //   col A over [0,10]: value 5 → normalized 0.5
  //   col B over [0,100]: value 25 → normalized 0.25
  const colA = new Float32Array([0, 10, 5]) // domain [0,10]
  const colB = new Float32Array([0, 100, 25]) // domain [0,100]
  // point index 2 holds (5, 25) → normalized (0.5, 0.25)

  it('mean (default) averages the per-column normalized values', () => {
    expect(DEFAULT_BLEND_AGGREGATE).toBe('mean')
    const r = aggregateContinuousColumns([colA, colB]) // default mean
    expect(r.value[2]).toBeCloseTo((0.5 + 0.25) / 2) // 0.375
  })

  it('sum adds the normalized values (can exceed 1)', () => {
    const r = aggregateContinuousColumns([colA, colB], { operator: 'sum' })
    expect(r.value[2]).toBeCloseTo(0.5 + 0.25) // 0.75
    expect(r.value[1]).toBeCloseTo(1 + 1) // both column maxima → 2
  })

  it('min / max pick the smaller / larger normalized value', () => {
    const mn = aggregateContinuousColumns([colA, colB], { operator: 'min' })
    const mx = aggregateContinuousColumns([colA, colB], { operator: 'max' })
    expect(mn.value[2]).toBeCloseTo(0.25)
    expect(mx.value[2]).toBeCloseTo(0.5)
  })

  it('median of an odd count is the middle normalized value', () => {
    // Three columns at point 0 → normalized (0.5, 0.25, 0.9) → median 0.5
    const c1 = new Float32Array([5, 0, 10]) // [0,10] → 0.5
    const c2 = new Float32Array([25, 0, 100]) // [0,100] → 0.25
    const c3 = new Float32Array([0.9, 0, 1]) // [0,1] → 0.9
    const r = aggregateContinuousColumns([c1, c2, c3], { operator: 'median' })
    expect(r.value[0]).toBeCloseTo(0.5)
  })

  it('median of an even count averages the two middle values', () => {
    // Four columns at point 0 → normalized (0.1, 0.2, 0.3, 0.4) → median (0.2+0.3)/2 = 0.25
    const cols = [
      new Float32Array([0.1, 0, 1]),
      new Float32Array([0.2, 0, 1]),
      new Float32Array([0.3, 0, 1]),
      new Float32Array([0.4, 0, 1]),
    ]
    const r = aggregateContinuousColumns(cols, { operator: 'median' })
    expect(r.value[0]).toBeCloseTo(0.25)
  })

  it('normalizes each column to [0,1] BEFORE aggregating (a wide column does not dominate)', () => {
    // Without normalization, sum(5, 25) = 30 would be dominated by col B; WITH it, 0.75.
    const r = aggregateContinuousColumns([colA, colB], { operator: 'sum' })
    expect(r.value[2]).toBeLessThan(1) // 0.75, not 30
  })

  it('normalizePerColumn:false sums the RAW (scaled) values (opt-out of pre-normalization)', () => {
    const r = aggregateContinuousColumns([colA, colB], { operator: 'sum', normalizePerColumn: false })
    expect(r.value[2]).toBeCloseTo(30) // 5 + 25
  })

  it('weights scale the mean (weighted average)', () => {
    // weighted mean of (0.5, 0.25) with weights (3, 1) = (3*0.5 + 1*0.25) / 4 = 0.4375
    const r = aggregateContinuousColumns([colA, colB], { operator: 'mean', weights: [3, 1] })
    expect(r.value[2]).toBeCloseTo((3 * 0.5 + 1 * 0.25) / 4)
  })

  it('the aggregated domain is the finite [min,max] of the aggregated value', () => {
    const r = aggregateContinuousColumns([colA, colB]) // mean
    // point0 → 0, point1 → 1, point2 → 0.375 ; domain [0,1]
    expect(r.domain[0]).toBeCloseTo(0)
    expect(r.domain[1]).toBeCloseTo(1)
  })

  it('SINGLE continuous column passes through RAW (no normalization) — Phase-1 parity', () => {
    const col = new Float32Array([2000, 5000, 8000])
    const r = aggregateContinuousColumns([col])
    expect([...r.value]).toEqual([2000, 5000, 8000])
    expect(r.domain).toEqual([2000, 8000])
  })

  it('a single column still honors the domain scale (log2) — parity with the single-channel path', () => {
    const col = new Float32Array([0, 3, 15]) // log2(x+1) = 0, 2, 4
    const r = aggregateContinuousColumns([col], { scale: 'log2' })
    expect(r.value[0]).toBeCloseTo(0)
    expect(r.value[1]).toBeCloseTo(2)
    expect(r.value[2]).toBeCloseTo(4)
  })

  it('zero continuous columns → empty value + [0,1] domain', () => {
    const r = aggregateContinuousColumns([])
    expect(r.value).toHaveLength(0)
    expect(r.domain).toEqual([0, 1])
  })
})

describe('reduceBlendColumns — composed reduce', () => {
  it('single categorical + single continuous == the Phase-1 blend inputs (PARITY)', () => {
    const cat = { codes: new Uint16Array([0, 0, 1, 2]), categories: ['A', 'B', 'C'] }
    const cont = new Float32Array([10, 20, 30, 40])
    const r = reduceBlendColumns({ categoricalColumns: [cat], continuousColumns: [cont] })
    // codes + categories === the raw single-column inputs (no remap, full category list)
    expect([...r.compositeCodes]).toEqual([0, 0, 1, 2])
    expect(r.compositeCategories).toEqual(['A', 'B', 'C'])
    // value === raw (no pre-normalization for a lone continuous column)
    expect([...r.aggregatedValue]).toEqual([10, 20, 30, 40])
    expect(r.valueDomain).toEqual([10, 40])
  })

  it('multi categorical + multi continuous → composite category + aggregated value', () => {
    const c0 = { codes: new Uint16Array([0, 1, 0]), categories: ['A', 'B'] }
    const c1 = { codes: new Uint16Array([0, 0, 1]), categories: ['X', 'Y'] }
    const v0 = new Float32Array([0, 10, 5]) // [0,10]
    const v1 = new Float32Array([0, 100, 50]) // [0,100]
    const r = reduceBlendColumns({ categoricalColumns: [c0, c1], continuousColumns: [v0, v1], operator: 'mean' })
    const s = COMPOSITE_SEPARATOR
    expect(r.compositeCategories).toEqual([`A${s}X`, `B${s}X`, `A${s}Y`])
    expect([...r.compositeCodes]).toEqual([0, 1, 2])
    // point2 → normalized (0.5, 0.5) → mean 0.5
    expect(r.aggregatedValue[2]).toBeCloseTo(0.5)
  })

  it('ZERO categorical + one continuous → one "(all)" composite category', () => {
    const v = new Float32Array([1, 2, 3])
    const r = reduceBlendColumns({ categoricalColumns: [], continuousColumns: [v] })
    expect(r.compositeCategories).toEqual([ALL_CATEGORY_LABEL])
    expect([...r.compositeCodes]).toEqual([0, 0, 0])
    expect([...r.aggregatedValue]).toEqual([1, 2, 3]) // single continuous → raw
  })

  it('one categorical + ZERO continuous → composite category, empty aggregated value', () => {
    const cat = { codes: new Uint16Array([0, 1, 0]), categories: ['A', 'B'] }
    const r = reduceBlendColumns({ categoricalColumns: [cat], continuousColumns: [] })
    expect(r.compositeCategories).toEqual(['A', 'B'])
    expect([...r.compositeCodes]).toEqual([0, 1, 0])
    expect(r.aggregatedValue).toHaveLength(0)
  })
})

// A tiny in-memory DataSource with two categorical + two continuous columns.
function multiSource(): DataSource {
  const cats: Record<string, { codes: Uint16Array; categories: string[] }> = {
    group: { codes: new Uint16Array([0, 0, 1, 1]), categories: ['A', 'B'] },
    type: { codes: new Uint16Array([0, 1, 0, 1]), categories: ['X', 'Y'] },
  }
  const conts: Record<string, Float32Array> = {
    qcA: new Float32Array([0, 10, 5, 8]),
    qcB: new Float32Array([0, 100, 50, 20]),
  }
  return {
    categorical: async (k: string) => ({ ...cats[k], length: cats[k].codes.length }),
    continuous: async (k: string) => ({ value: conts[k], length: conts[k].length }),
  } as unknown as DataSource
}

describe('computeColoring — multi-column blend dispatch (Phase 2)', () => {
  const base: ColorBy = {
    mode: 'blend',
    key: 'group',
    categoryKey: 'group',
    valueKey: 'qcA',
    channel: 'lightness',
    perGroupDomain: true,
    colormap: 'viridis',
    scale: 'linear',
    hidden: new Set<number>(),
  }

  it('two categorical + two continuous → composite blend payload (codes over the composite domain)', async () => {
    const c = await computeColoring(multiSource(), {
      ...base,
      categoricalColumns: ['group', 'type'],
      continuousColumns: ['qcA', 'qcB'],
      aggregate: 'mean',
    })
    expect(c.blend).toBeDefined()
    const b = c.blend!
    // 4 points, 4 distinct (group,type) combos: A|X, A|Y, B|X, B|Y
    expect([...b.codes]).toEqual([0, 1, 2, 3])
    expect(b.legend2d.rows).toHaveLength(4)
    const s = COMPOSITE_SEPARATOR
    expect(b.legend2d.rows.map(r => r.label)).toEqual([`A${s}X`, `A${s}Y`, `B${s}X`, `B${s}Y`])
    expect(c.colors).toHaveLength(4 * 4)
  })

  it('multiple categorical, NO continuous columns → plain composite categorical (no blend payload)', async () => {
    const c = await computeColoring(multiSource(), {
      ...base,
      categoricalColumns: ['group', 'type'],
      continuousColumns: [],
      valueKey: undefined,
    })
    expect(c.blend).toBeUndefined()
    expect(c.legend).toBeDefined()
    expect(c.legend!.entries).toHaveLength(4) // composite domain
  })

  it('single categorical + single continuous (no arrays) still returns the Phase-1 blend payload', async () => {
    const c = await computeColoring(multiSource(), base)
    expect(c.blend).toBeDefined()
    expect(c.blend!.legend2d.rows).toHaveLength(2) // the two raw groups A,B (not composite)
  })
})
