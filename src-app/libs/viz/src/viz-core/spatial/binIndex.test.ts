import { describe, it, expect } from 'vitest'
import { buildBinIndex, binOf, indicesInBin, indicesNear, queryRadius, type BinBounds } from './binIndex'

const B: BinBounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 }

/** Gather a bin's members as a sorted plain array (order within a bin is build-order, not sorted). */
function bin(idx: ReturnType<typeof buildBinIndex>, b: number): number[] {
  return Array.from(indicesInBin(idx, b)).sort((a, z) => a - z)
}

describe('buildBinIndex', () => {
  it('places every point in exactly one bin; offsets are monotone and end at N', () => {
    // 4 points, 2x2 grid over [0,10]²: cells are 5-wide.
    const pos = new Float32Array([1, 1, /*→(0,0)*/ 6, 1, /*→(1,0)*/ 1, 6, /*→(0,1)*/ 6, 6 /*→(1,1)*/])
    const idx = buildBinIndex(pos, B, 2, 2)
    expect(idx.binOffsets[idx.binOffsets.length - 1]).toBe(4) // N
    for (let i = 1; i < idx.binOffsets.length; i++) {
      expect(idx.binOffsets[i]).toBeGreaterThanOrEqual(idx.binOffsets[i - 1])
    }
    // each of the 4 cells holds exactly its one point (row-major: cy*bx+cx).
    expect(bin(idx, 0)).toEqual([0]) // (0,0)
    expect(bin(idx, 1)).toEqual([1]) // (1,0)
    expect(bin(idx, 2)).toEqual([2]) // (0,1)
    expect(bin(idx, 3)).toEqual([3]) // (1,1)
    // total membership across bins == N, no dupes.
    const all = [0, 1, 2, 3].flatMap(b => bin(idx, b)).sort()
    expect(all).toEqual([0, 1, 2, 3])
  })

  it('groups co-located (overlapping) points into the SAME bin', () => {
    const pos = new Float32Array([2, 2, 2.1, 2.1, 2.2, 1.9, 8, 8])
    const idx = buildBinIndex(pos, B, 2, 2)
    expect(bin(idx, 0)).toEqual([0, 1, 2]) // three near (2,2)
    expect(bin(idx, 3)).toEqual([3]) // one near (8,8)
  })

  it('clamps out-of-bounds points into the edge bins (no drop, no crash)', () => {
    const pos = new Float32Array([-5, -5, 99, 99])
    const idx = buildBinIndex(pos, B, 2, 2)
    expect(idx.binOffsets[idx.binOffsets.length - 1]).toBe(2)
    expect(bin(idx, 0)).toEqual([0]) // clamped to (0,0)
    expect(bin(idx, 3)).toEqual([1]) // clamped to (1,1)
  })

  it('degenerate bounds (zero span) puts everything in bin 0', () => {
    const pos = new Float32Array([3, 3, 4, 4])
    const idx = buildBinIndex(pos, { minX: 5, minY: 5, maxX: 5, maxY: 5 }, 4, 4)
    expect(bin(idx, 0)).toEqual([0, 1])
  })

  it('counts a NaN/Infinity coordinate (invariant held) instead of dropping it', () => {
    // pt0 (NaN,5): non-finite X clamps to col 0, finite Y=5 → row 1 → bin 2.
    // pt1 (3,3) → bin 0. pt2 (Inf,2): non-finite X → col 0, Y=2 → row 0 → bin 0.
    const pos = new Float32Array([NaN, 5, 3, 3, Infinity, 2])
    const idx = buildBinIndex(pos, B, 2, 2)
    // every point is counted — the JSDoc invariant binOffsets[last]===N holds (not dropped).
    expect(idx.binOffsets[idx.binOffsets.length - 1]).toBe(3)
    // all three indices appear across bins exactly once.
    const all = [0, 1, 2, 3].flatMap(b => bin(idx, b)).sort((a, z) => a - z)
    expect(all).toEqual([0, 1, 2])
    // queryRadius's exact-distance refine EXCLUDES the non-finite point (NaN distance fails <= r).
    expect(Array.from(queryRadius(idx, 3, 3, 1))).toEqual([1])
  })

  it('coerces bx/by to >=1 and handles an empty cloud', () => {
    const idx = buildBinIndex(new Float32Array(0), B, 0, 0)
    expect(idx.bx).toBe(1)
    expect(idx.by).toBe(1)
    expect(idx.binOffsets[idx.binOffsets.length - 1]).toBe(0)
    expect(indicesInBin(idx, 0).length).toBe(0)
  })
})

describe('binOf', () => {
  it('maps world coords to the row-major bin id', () => {
    const idx = buildBinIndex(new Float32Array([1, 1]), B, 2, 2)
    expect(binOf(idx, 1, 1)).toBe(0)
    expect(binOf(idx, 6, 1)).toBe(1)
    expect(binOf(idx, 1, 6)).toBe(2)
    expect(binOf(idx, 6, 6)).toBe(3)
  })
})

describe('indicesNear', () => {
  it('gathers only the touched bins at a small radius', () => {
    // points spread across a 4x4 grid; hover near (2,2) with radius 1 touches just that cell.
    const pos = new Float32Array([2, 2, 2.4, 2.4, 8, 8])
    const idx = buildBinIndex(pos, B, 4, 4) // 2.5-wide cells
    const near = Array.from(indicesNear(idx, 2, 2, 1)).sort((a, z) => a - z)
    expect(near).toEqual([0, 1]) // not the (8,8) point
  })

  it('a radius spanning multiple cells unions them', () => {
    const pos = new Float32Array([1, 1, 4, 4, 9, 9])
    const idx = buildBinIndex(pos, B, 4, 4)
    const near = Array.from(indicesNear(idx, 3, 3, 3)).sort((a, z) => a - z)
    expect(near).toContain(0)
    expect(near).toContain(1)
  })

  it('returns empty when no bin in range holds a point', () => {
    const pos = new Float32Array([9, 9])
    const idx = buildBinIndex(pos, B, 4, 4)
    expect(indicesNear(idx, 1, 1, 0.5).length).toBe(0)
  })
})

describe('queryRadius (exact circle)', () => {
  it('refines a coarse bin gather to the true circle', () => {
    // Two points in the same coarse cell but at different distances from the query point.
    // grid 2x2 over [0,10] → cell 0 spans [0,5)². Both (1,1) and (4,4) share cell 0.
    const pos = new Float32Array([1, 1, 4, 4])
    const idx = buildBinIndex(pos, B, 2, 2)
    // radius 1 around (1,1): only idx0 is within, idx1 (dist ~4.24) is excluded despite same bin.
    expect(Array.from(queryRadius(idx, 1, 1, 1))).toEqual([0])
    // a big radius includes both.
    expect(Array.from(queryRadius(idx, 1, 1, 10)).sort((a, z) => a - z)).toEqual([0, 1])
  })

  it('gathers co-located overlapping points (the tooltip stack case)', () => {
    const pos = new Float32Array([5, 5, 5.05, 4.98, 4.97, 5.02, 9, 1])
    const idx = buildBinIndex(pos, B, 8, 8)
    const hit = Array.from(queryRadius(idx, 5, 5, 0.2)).sort((a, z) => a - z)
    expect(hit).toEqual([0, 1, 2]) // the three near (5,5), not the (9,1) point
  })

  it('empty when nothing is within radius', () => {
    const idx = buildBinIndex(new Float32Array([9, 9]), B, 4, 4)
    expect(queryRadius(idx, 1, 1, 0.5).length).toBe(0)
  })
})
