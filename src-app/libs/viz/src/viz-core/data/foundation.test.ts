import { describe, it, expect } from 'vitest'
import { IndexMask, selectInBox, selectInPolygon, popcount32 } from './selection'
import { statVerdict, zscore, finiteValues, isFinitePoint } from './missing'
import { continuousColors, categoricalColors } from './color'
import { FixtureSource, generateFixture } from './fixtures'
import { decodePositions } from './wire'

describe('IndexMask set ops (TEST-8)', () => {
  it('set/has/count/popcount', () => {
    const m = new IndexMask(100)
    m.set(3); m.set(70); m.set(70)
    expect(m.has(3)).toBe(true)
    expect(m.has(4)).toBe(false)
    expect(m.count()).toBe(2)
    expect(popcount32(0b1011)).toBe(3)
  })

  it('union / intersect / difference combine modes', () => {
    const a = IndexMask.fromIndices(64, [1, 2, 3, 40])
    const b = IndexMask.fromIndices(64, [3, 40, 50])
    expect(Array.from(a.union(b).toIndices())).toEqual([1, 2, 3, 40, 50])
    expect(Array.from(a.intersect(b).toIndices())).toEqual([3, 40])
    expect(Array.from(a.difference(b).toIndices())).toEqual([1, 2])
  })

  it('box + polygon selection over positions', () => {
    // 4 points; box selects the two on the left
    const pos = new Float32Array([0, 0, 1, 1, 10, 10, 11, 11])
    const box = selectInBox(pos, [-1, -1, 2, 2], 4)
    expect(Array.from(box.toIndices())).toEqual([0, 1])
    const poly = selectInPolygon(pos, [[-1, -1], [2, -1], [2, 2], [-1, 2]], 4)
    expect(Array.from(poly.toIndices())).toEqual([0, 1])
  })
})

describe('missing-data + degenerate contract (TEST-75)', () => {
  it('isFinitePoint + finiteValues skip NaN/Inf', () => {
    expect(isFinitePoint(1, 2)).toBe(true)
    expect(isFinitePoint(NaN, 2)).toBe(false)
    expect(finiteValues([1, NaN, 3, Infinity])).toEqual([1, 3])
  })

  it('stat verdicts: empty / single / flat / ok', () => {
    expect(statVerdict([])).toBe('empty')
    expect(statVerdict([5])).toBe('single')
    expect(statVerdict([3, 3, 3])).toBe('flat')
    expect(statVerdict([1, 2, 3, 4])).toBe('ok')
  })

  it('zscore guards divide-by-zero on flat groups', () => {
    expect(zscore(5, 5, 0)).toBe(0)
    expect(zscore(4, 2, 2)).toBeCloseTo(1)
  })
})

describe('color pipeline (TEST-3)', () => {
  it('continuous colormap fills RGBA and reports domain', () => {
    const { colors, domain } = continuousColors(new Float32Array([0, 5, 10]))
    expect(colors.length).toBe(3 * 4)
    expect(domain[0]).toBe(0)
    expect(domain[1]).toBe(10)
    // alpha channel set for non-zero-transparent default
    expect(colors[3]).toBe(255)
  })

  it('zeroTransparent leaves unexpressed points transparent', () => {
    const { colors } = continuousColors(new Float32Array([0, 5]), { zeroTransparent: true })
    expect(colors[3]).toBe(0) // first point (value 0) → transparent
    expect(colors[7]).toBe(255) // second point → opaque
  })

  it('categorical palette is stable + colorblind-safe count', () => {
    const c = categoricalColors(new Uint16Array([0, 1, 0]))
    expect(c.length).toBe(3 * 4)
    // same code → same color
    expect(Array.from(c.slice(0, 3))).toEqual(Array.from(c.slice(8, 11)))
  })
})

describe('FixtureSource + wire round-trip (TEST-2)', () => {
  it('is deterministic for a fixed seed', () => {
    const a = generateFixture({ seed: 7, pointCount: 1000 })
    const b = generateFixture({ seed: 7, pointCount: 1000 })
    expect(new Uint8Array(a.layoutBuf)).toEqual(new Uint8Array(b.layoutBuf))
  })

  it('serves the wire shapes through the DataSource contract', async () => {
    const src = new FixtureSource({ seed: 1, pointCount: 5000 })
    const cat = await src.catalog()
    expect(cat.pointCount).toBe(5000)
    expect(cat.hasImage).toBe(true)
    expect(cat.valueColumns.length).toBeGreaterThan(0)

    const pos = await src.positions('primary')
    expect(pos.length).toBe(5000)

    const col = await src.valueColumn(cat.valueColumns[0])
    expect(col.length).toBe(5000)
    expect(col.row.length).toBeGreaterThan(0)

    const grp = await src.categorical('group')
    expect(grp.length).toBe(5000)
    expect(grp.categories.length).toBeGreaterThan(0)

    const img = await src.imageUnderlay()
    expect(img.width).toBeGreaterThan(0)
    expect(img.data.length).toBe(img.width * img.height * 4)

    const tbl = await src.table('de')
    expect(tbl.rowLabels.length).toBe(cat.valueColumns.length)
    expect(tbl.columns.effect.length).toBe(cat.valueColumns.length)
  })

  it('generates 1M points within a sane budget', () => {
    const t0 = Date.now()
    const fx = generateFixture({ seed: 3, pointCount: 1_000_000 })
    const pos = decodePositions(fx.layoutBuf)
    expect(pos.length).toBe(1_000_000)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})
