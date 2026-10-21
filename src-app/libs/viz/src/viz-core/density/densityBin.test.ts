// densityBin.test.ts — unit coverage for the pure bin-planning math + the CPU density
// oracle. No GPU / no DOM: this is the deterministic reference the GPU/ScreenGridLayer
// render path is trusted to match (DEC-27 oracle pattern).

import { describe, it, expect } from 'vitest'
import {
  planDensityGrid,
  cellForPoint,
  boundsForPositions,
  binDensity,
  binDensityPacked,
  binPacked,
  binWeight,
  type DensityBounds,
} from './densityBin'
import { packPositions } from './quantize'

const BOUNDS: DensityBounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 }

describe('planDensityGrid', () => {
  it('divides the viewport into cellPx-sized cells (cost ∝ pixels)', () => {
    const g = planDensityGrid(1000, 800, 24)
    expect(g.gridW).toBe(Math.ceil(1000 / 24)) // 42
    expect(g.gridH).toBe(Math.ceil(800 / 24)) // 34
    expect(g.cellPx).toBe(24)
    expect(g.cellCount).toBe(g.gridW * g.gridH)
  })

  it('guards cellPx to ≥ 1 and dims to ≥ 1', () => {
    expect(planDensityGrid(100, 100, 0).cellPx).toBe(1)
    const degenerate = planDensityGrid(0, 0, 24)
    expect(degenerate.gridW).toBe(1)
    expect(degenerate.gridH).toBe(1)
    expect(degenerate.cellCount).toBe(1)
  })

  it('a viewport smaller than one cell still yields a 1×1 grid', () => {
    const g = planDensityGrid(100, 100, 200)
    expect(g.gridW).toBe(1)
    expect(g.gridH).toBe(1)
  })
})

describe('cellForPoint', () => {
  // 2×2 grid over [0,10]²: cell = row*2 + col
  //   0 = (x<5, y<5)   1 = (x≥5, y<5)
  //   2 = (x<5, y≥5)   3 = (x≥5, y≥5)
  it('maps points into the correct row-major cell', () => {
    expect(cellForPoint(1, 1, BOUNDS, 2, 2)).toBe(0)
    expect(cellForPoint(7, 1, BOUNDS, 2, 2)).toBe(1)
    expect(cellForPoint(1, 7, BOUNDS, 2, 2)).toBe(2)
    expect(cellForPoint(7, 7, BOUNDS, 2, 2)).toBe(3)
  })

  it('clamps the max edge into the last cell (in-bounds)', () => {
    expect(cellForPoint(10, 10, BOUNDS, 2, 2)).toBe(3)
    expect(cellForPoint(0, 0, BOUNDS, 2, 2)).toBe(0)
    expect(cellForPoint(5, 5, BOUNDS, 2, 2)).toBe(3) // 0.5 → col/row 1
  })

  it('returns −1 for out-of-bounds points', () => {
    expect(cellForPoint(-1, 5, BOUNDS, 2, 2)).toBe(-1)
    expect(cellForPoint(5, 11, BOUNDS, 2, 2)).toBe(-1)
    expect(cellForPoint(20, 20, BOUNDS, 2, 2)).toBe(-1)
  })

  it('collapses a degenerate axis to column/row 0', () => {
    const flat: DensityBounds = { minX: 3, minY: 0, maxX: 3, maxY: 10 }
    expect(cellForPoint(3, 1, flat, 4, 4)).toBe(0) // col 0 (span 0), row 0
    expect(cellForPoint(3, 9, flat, 4, 4)).toBe(3 * 4 + 0) // row 3, col 0
  })
})

describe('boundsForPositions', () => {
  it('computes the world extent, skipping non-finite', () => {
    const pos = new Float32Array([0, 0, 4, 8, -2, 3, NaN, 5])
    const b = boundsForPositions(pos)
    expect(b).toEqual({ minX: -2, minY: 0, maxX: 4, maxY: 8 })
  })

  it('returns a unit box for an empty buffer', () => {
    expect(boundsForPositions(new Float32Array(0))).toEqual({
      minX: 0,
      minY: 0,
      maxX: 1,
      maxY: 1,
    })
  })
})

describe('binDensity (CPU oracle)', () => {
  // 5 in-bounds points + 1 out-of-bounds, over the 2×2 grid.
  const positions = new Float32Array([
    1, 1, // cell 0
    2, 2, // cell 0
    7, 1, // cell 1
    1, 7, // cell 2
    7, 7, // cell 3
    20, 20, // out of bounds → skipped
  ])
  const values = new Float32Array([2, 4, 10, 6, 8, 100])

  it('counts points per cell (out-of-bounds skipped)', () => {
    const { count } = binDensity(positions, values, BOUNDS, 2, 2)
    expect(Array.from(count)).toEqual([2, 1, 1, 1])
  })

  it('sums the value column per cell', () => {
    const { sum } = binDensity(positions, values, BOUNDS, 2, 2)
    expect(Array.from(sum)).toEqual([6, 10, 6, 8]) // 2+4, 10, 6, 8
  })

  it('mode=mean == sum/count, and 0 where count=0', () => {
    const { count, sum } = binDensity(positions, values, BOUNDS, 3, 3) // 9 cells, several empty
    for (let c = 0; c < count.length; c++) {
      const mean = binWeight(count[c], sum[c], 'mean')
      if (count[c] === 0) {
        expect(mean).toBe(0)
      } else {
        expect(mean).toBeCloseTo(sum[c] / count[c], 6)
      }
    }
    // spot-check the known cell-0 mean on the 2×2 grid
    const g2 = binDensity(positions, values, BOUNDS, 2, 2)
    expect(binWeight(g2.count[0], g2.sum[0], 'mean')).toBeCloseTo(3, 6) // (2+4)/2
    expect(binWeight(g2.count[1], g2.sum[1], 'mean')).toBeCloseTo(10, 6)
  })

  it('a non-finite value still counts the point but adds nothing to the sum', () => {
    const pos = new Float32Array([1, 1, 2, 2])
    const vals = new Float32Array([5, NaN])
    const { count, sum } = binDensity(pos, vals, BOUNDS, 2, 2)
    expect(count[0]).toBe(2)
    expect(sum[0]).toBe(5)
    expect(binWeight(count[0], sum[0], 'mean')).toBeCloseTo(2.5, 6) // 5 / 2
  })

  it('an empty grid (no points) yields all-zero count + sum', () => {
    const { count, sum } = binDensity(new Float32Array(0), new Float32Array(0), BOUNDS, 2, 2)
    expect(Array.from(count)).toEqual([0, 0, 0, 0])
    expect(Array.from(sum)).toEqual([0, 0, 0, 0])
  })
})

describe('binDensityPacked (16-bit packed twin of binDensity)', () => {
  // Points placed at 8×8 cell CENTRES over [0,80]² — 5 world units from every cell edge, which is
  // ~4000× the quantization step (80/65535 ≈ 0.0012), so packing cannot move a point across an
  // edge → the packed count grid is IDENTICAL to the Float32 one, not merely close.
  const bounds: DensityBounds = { minX: 0, minY: 0, maxX: 80, maxY: 80 }
  const pts: number[] = []
  const vals: number[] = []
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const mult = ((r * 8 + c) % 3) + 1 // 1..3 points per cell centre
      for (let k = 0; k < mult; k++) {
        pts.push(c * 10 + 5, r * 10 + 5)
        vals.push(r + c)
      }
    }
  }
  const positions = new Float32Array(pts)
  const values = new Float32Array(vals)
  const packed = packPositions(positions)

  it('produces a count grid identical to binDensity for edge-safe points', () => {
    const f32 = binDensity(positions, null, bounds, 8, 8)
    const pk = binDensityPacked(packed.packed, packed, null, bounds, 8, 8)
    expect(Array.from(pk.count)).toEqual(Array.from(f32.count))
  })

  it('binPacked (PackedPositions wrapper) matches binDensityPacked', () => {
    const a = binDensityPacked(packed.packed, packed, values, bounds, 8, 8)
    const b = binPacked(packed, values, bounds, 8, 8)
    expect(Array.from(b.count)).toEqual(Array.from(a.count))
    expect(Array.from(b.sum)).toEqual(Array.from(a.sum))
  })

  it('sums the value column identically to the Float32 path', () => {
    const f32 = binDensity(positions, values, bounds, 8, 8)
    const pk = binDensityPacked(packed.packed, packed, values, bounds, 8, 8)
    expect(Array.from(pk.sum)).toEqual(Array.from(f32.sum))
  })

  it('preserves the total in-bounds count for a random cloud (packing keeps points in-bounds)', () => {
    // A random spread; use the DATA bounds so every packed code stays in-bounds. Per-cell counts
    // may differ by a handful of near-edge points, but the TOTAL is conserved exactly.
    let seed = 42
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const n = 4000
    const rp = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      rp[i * 2] = rng() * 200 - 100
      rp[i * 2 + 1] = rng() * 200 - 100
    }
    const b = boundsForPositions(rp)
    const rpk = packPositions(rp)
    const f32 = binDensity(rp, null, b, 16, 16)
    const pk = binDensityPacked(rpk.packed, rpk, null, b, 16, 16)
    const total = (a: Float32Array) => a.reduce((s, v) => s + v, 0)
    expect(total(pk.count)).toBe(total(f32.count))
    expect(total(pk.count)).toBe(n)
    // And the per-cell grids agree except for a tiny fraction of near-edge migrations.
    let l1 = 0
    for (let c = 0; c < f32.count.length; c++) l1 += Math.abs(pk.count[c] - f32.count[c])
    expect(l1).toBeLessThanOrEqual(Math.ceil(n * 0.01)) // ≤1% edge migration
  })
})
