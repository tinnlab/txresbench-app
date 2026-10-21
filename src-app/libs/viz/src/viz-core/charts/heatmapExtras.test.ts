// heatmapExtras.test.ts — unit tests for the pure heatmap-enrichment helpers
// (ITEM-36/37/38): dendrogram branch count, per-row z-score (incl. flat rows), and the
// categorical annotation-track texture mapping. Node env — `ImageData` is polyfilled.

import { describe, it, expect } from 'vitest'
import { dendrogramPaths, zscoreRows, annotationTrackTexture } from './heatmapExtras'
import { hierarchicalClustering } from '../data/statsKernels'

// `ImageData` is a browser primitive absent in the node test env; a minimal shim lets us
// verify the byte mapping (browsers use the native constructor).
if (typeof (globalThis as { ImageData?: unknown }).ImageData === 'undefined') {
  class ImageDataPoly {
    readonly data: Uint8ClampedArray
    readonly width: number
    readonly height: number
    constructor(data: Uint8ClampedArray, width: number, height: number) {
      this.data = data
      this.width = width
      this.height = height
    }
  }
  ;(globalThis as { ImageData?: unknown }).ImageData = ImageDataPoly
}

// ── 1. dendrogramPaths (TEST-46 / ITEM-36) ────────────────────────────────────────

describe('dendrogramPaths', () => {
  // 4 well-separated rows over 2 cols → a full binary merge tree of 3 merges.
  const matrix = new Float32Array([0, 0, 0.2, 0.1, 10, 10, 10.2, 9.9])
  const nRows = 4
  const nCols = 2
  const { order, merges } = hierarchicalClustering(matrix, nRows, nCols, {
    linkage: 'average',
    distance: 'euclidean',
  })

  it('produces exactly N−1 branch polylines for N leaves', () => {
    expect(merges).toHaveLength(nRows - 1)
    const paths = dendrogramPaths(merges, order, nRows, { side: 'row', extent: 3 })
    expect(paths).toHaveLength(nRows - 1)
  })

  it('each branch is a 4-point inverted-U polyline', () => {
    const paths = dendrogramPaths(merges, order, nRows, { side: 'row', extent: 3 })
    for (const p of paths) expect(p.path).toHaveLength(4)
  })

  it("side:'row' grows into −x; leaf tips rest at x=0", () => {
    const paths = dendrogramPaths(merges, order, nRows, { side: 'row', extent: 3 })
    const allX = paths.flatMap(p => p.path.map(pt => pt[0]))
    expect(Math.max(...allX)).toBeCloseTo(0) // leaves at height 0 → x = 0
    expect(Math.min(...allX)).toBeLessThan(0) // internal joins pushed to negative x
    expect(Math.min(...allX)).toBeGreaterThanOrEqual(-3) // bounded by extent
  })

  it("side:'col' grows into −y (perpendicular axis swapped)", () => {
    const paths = dendrogramPaths(merges, order, nRows, { side: 'col', extent: 5 })
    const allY = paths.flatMap(p => p.path.map(pt => pt[1]))
    expect(Math.max(...allY)).toBeCloseTo(0)
    expect(Math.min(...allY)).toBeLessThan(0)
    expect(Math.min(...allY)).toBeGreaterThanOrEqual(-5)
  })

  it('returns [] for a single leaf / no merges', () => {
    expect(dendrogramPaths([], [0], 1, { side: 'row', extent: 3 })).toEqual([])
  })
})

// ── 2. zscoreRows (ITEM-38) ───────────────────────────────────────────────────────

describe('zscoreRows', () => {
  const nCols = 4
  const values = new Float32Array([
    1, 2, 3, 4, // row 0 — varied
    5, 5, 5, 5, // row 1 — flat (zero variance)
    -2, 0, 2, 8, // row 2 — varied
  ])
  const nRows = 3

  it('gives each varied row ~0 mean and unit-ish spread', () => {
    const z = zscoreRows(values, nRows, nCols)
    for (const r of [0, 2]) {
      let sum = 0
      for (let c = 0; c < nCols; c++) sum += z[r * nCols + c]
      expect(sum / nCols).toBeCloseTo(0, 6) // mean of z-scores is exactly 0
    }
    // population sd of the standardized row is 1.
    let ss = 0
    for (let c = 0; c < nCols; c++) ss += z[0 * nCols + c] ** 2
    expect(Math.sqrt(ss / nCols)).toBeCloseTo(1, 6)
  })

  it('maps a flat (zero-variance) row to all zeros', () => {
    const z = zscoreRows(values, nRows, nCols)
    for (let c = 0; c < nCols; c++) expect(z[1 * nCols + c]).toBe(0)
  })

  it('does not mutate the input and returns a fresh array of matching length', () => {
    const copy = Float32Array.from(values)
    const z = zscoreRows(values, nRows, nCols)
    expect(z).toHaveLength(nRows * nCols)
    expect(values).toEqual(copy)
  })
})

// ── 3. annotationTrackTexture (TEST-47 / ITEM-37) ─────────────────────────────────

describe('annotationTrackTexture', () => {
  const categories = ['A', 'B', 'C']

  it('produces an RGBA texture with one pixel (4 bytes) per code', () => {
    const codes = Uint16Array.from([0, 1, 2, 0, 1])
    const tex = annotationTrackTexture(codes, categories)
    expect(tex.data.length).toBe(codes.length * 4)
  })

  it("orient:'row' is a vertical 1×N bar, 'col' a horizontal N×1 bar", () => {
    const codes = Uint16Array.from([0, 1, 2])
    const row = annotationTrackTexture(codes, categories, 'row')
    expect([row.width, row.height]).toEqual([1, codes.length])
    const col = annotationTrackTexture(codes, categories, 'col')
    expect([col.width, col.height]).toEqual([codes.length, 1])
  })

  it('colors each code from the categorical palette and renders opaque', () => {
    const tex = annotationTrackTexture(Uint16Array.from([0, 1]), categories)
    // both in-range codes are fully opaque (alpha 255) and colored. NB: default code 0 is Okabe-Ito
    // BLACK (ITEM-11), so assert the colored channel on code 1 (orange) — code 0's opacity is checked above.
    expect(tex.data[3]).toBe(255)
    expect(tex.data[7]).toBe(255)
    expect(tex.data[4] + tex.data[5] + tex.data[6]).toBeGreaterThan(0)
  })

  it('renders an out-of-range code transparent', () => {
    const tex = annotationTrackTexture(Uint16Array.from([9]), categories) // 9 ≥ 3 categories
    expect([tex.data[0], tex.data[1], tex.data[2], tex.data[3]]).toEqual([0, 0, 0, 0])
  })
})
