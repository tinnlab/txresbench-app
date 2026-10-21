import { describe, it, expect } from 'vitest'
import {
  jitterUnit,
  jitterX,
  buildJitterPositions,
  cellsInGroupValueBand,
} from './violinJitter'
import { buildGroupIndex } from '../coordination/groupIndex'

describe('jitterUnit / jitterX — deterministic per-cell jitter', () => {
  it('jitterUnit is stable + in [0,1)', () => {
    for (const i of [0, 1, 2, 7, 100, 99999]) {
      const a = jitterUnit(i)
      const b = jitterUnit(i)
      expect(a).toBe(b) // same index → same value (never per-frame)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(1)
    }
  })

  it('jitterX is deterministic — same index → same x', () => {
    expect(jitterX(42, 3, 0.24)).toBe(jitterX(42, 3, 0.24))
  })

  it('jitterX lies within [center − w/2, center + w/2)', () => {
    const cx = 5
    const w = 0.24
    for (let i = 0; i < 2000; i++) {
      const x = jitterX(i, cx, w)
      expect(x).toBeGreaterThanOrEqual(cx - w / 2)
      expect(x).toBeLessThan(cx + w / 2)
    }
  })

  it('spreads distinct indices across the band (not a constant)', () => {
    const xs = new Set<number>()
    for (let i = 0; i < 50; i++) xs.add(jitterX(i, 0, 1))
    // A good hash gives ~50 distinct offsets; assert it is clearly not degenerate.
    expect(xs.size).toBeGreaterThan(40)
  })
})

describe('buildJitterPositions — full (non-subsampled) selection positions', () => {
  const codes = new Uint16Array([0, 1, 0, 2, 1])
  const values = new Float32Array([10, 20, 30, 40, 50])
  const centers = [0, 1, 2]

  it('emits length 2*N', () => {
    const pos = buildJitterPositions(codes, values, centers, 0.24)
    expect(pos.length).toBe(codes.length * 2)
  })

  it('y maps the value through valueToY (identity by default)', () => {
    const pos = buildJitterPositions(codes, values, centers, 0.24)
    for (let i = 0; i < codes.length; i++) {
      expect(pos[i * 2 + 1]).toBe(values[i])
    }
  })

  it('y honours a custom valueToY', () => {
    const pos = buildJitterPositions(codes, values, centers, 0.24, v => v * 2 + 1)
    for (let i = 0; i < codes.length; i++) {
      expect(pos[i * 2 + 1]).toBe(values[i] * 2 + 1)
    }
  })

  it('x equals jitterX around the point group center', () => {
    const w = 0.3
    const pos = buildJitterPositions(codes, values, centers, w)
    for (let i = 0; i < codes.length; i++) {
      // stored as float32, so compare against the f32-rounded jitterX
      expect(pos[i * 2]).toBe(Math.fround(jitterX(i, centers[codes[i]], w)))
      // and within the group's band (epsilon for float32 boundary rounding; the exact
      // band property is asserted on the f64 jitterX above)
      const cx = centers[codes[i]]
      const eps = 1e-6
      expect(pos[i * 2]).toBeGreaterThanOrEqual(cx - w / 2 - eps)
      expect(pos[i * 2]).toBeLessThanOrEqual(cx + w / 2 + eps)
    }
  })

  it('parks out-of-range codes at NaN (excluded from the KD-tree)', () => {
    const c = new Uint16Array([0, 9]) // 9 >= centers.length
    const v = new Float32Array([1, 2])
    const pos = buildJitterPositions(c, v, centers, 0.24)
    expect(Number.isNaN(pos[2])).toBe(true)
    expect(Number.isNaN(pos[3])).toBe(true)
    expect(Number.isNaN(pos[0])).toBe(false)
  })
})

describe('cellsInGroupValueBand — value-band producer', () => {
  // groups: 0 → {0:10, 2:30, 5:15}; 1 → {1:20, 4:40}; 2 → {3:50}
  const codes = new Uint16Array([0, 1, 0, 2, 1, 0])
  const values = new Float32Array([10, 20, 30, 40, 15, 15])
  const gi = buildGroupIndex(codes, 3)

  it('returns a group’s members whose value is in the inclusive band', () => {
    const sel = cellsInGroupValueBand(gi, 0, values, 10, 20)
    // group 0 members: 0(10), 2(30), 5(15) → in [10,20]: 0 and 5
    expect(Array.from(sel)).toEqual([0, 5])
  })

  it('is order-insensitive in the band endpoints', () => {
    const a = cellsInGroupValueBand(gi, 0, values, 10, 20)
    const b = cellsInGroupValueBand(gi, 0, values, 20, 10)
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('is inclusive at both endpoints', () => {
    const sel = cellsInGroupValueBand(gi, 0, values, 15, 30)
    // group 0 in [15,30]: 2(30), 5(15)
    expect(Array.from(sel).sort((x, y) => x - y)).toEqual([2, 5])
  })

  it('empty band → empty', () => {
    expect(cellsInGroupValueBand(gi, 0, values, 100, 200).length).toBe(0)
  })

  it('only scans the requested group (never other groups’ cells)', () => {
    // group 1 members: 1(20), 4(15); value 40 belongs to group 2 (index 3) — never returned.
    const sel = cellsInGroupValueBand(gi, 1, values, 0, 100)
    expect(Array.from(sel)).toEqual([1, 4])
  })

  it('ascending + deduped (member order from the CSR index)', () => {
    const sel = cellsInGroupValueBand(gi, 0, values, 0, 100)
    const arr = Array.from(sel)
    expect(arr).toEqual([0, 2, 5])
    expect(new Set(arr).size).toBe(arr.length)
  })

  it('out-of-range code → empty', () => {
    expect(cellsInGroupValueBand(gi, 99, values, 0, 100).length).toBe(0)
  })
})
