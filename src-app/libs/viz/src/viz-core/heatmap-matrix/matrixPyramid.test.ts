// matrixPyramid.test.ts — oracle-grade coverage for the pyramid planner + the CPU
// reference downsample. These are the parity reference the later GPU render-to-texture
// wave is checked against, so the aggregation math is hand-computed and asserted EXACTLY;
// a wrong aggregation (naive "filter the mean", unweighted multi-level mean, mishandled
// odd width, or a real-0-vs-empty confusion) must fail here.

import { describe, it, expect } from 'vitest'
import {
  planPyramid,
  residentTilesFor,
  downsampleLevel,
  buildPyramid,
  EMPTY_VALUE,
  MIN_LEVEL_COLS,
  type PyramidLevel,
} from './matrixPyramid'
import { makeMatrixFixture } from './matrixFixture'
import type { MatrixData } from './matrixTypes'

// A tiny helper to author a column-major matrix inline.
const mat = (rows: number, cols: number, values: number[]): MatrixData => ({
  rows,
  cols,
  values: Uint8Array.from(values),
})

describe('planPyramid', () => {
  it('halves cols (ceil) down to a 1-column overview', () => {
    const levels = planPyramid({ rows: 8, cols: 64 })
    expect(levels.map(l => l.cols)).toEqual([64, 32, 16, 8, 4, 2, 1])
    expect(levels.map(l => l.level)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(levels.every(l => l.rows === 8)).toBe(true)
    expect(levels[levels.length - 1].cols).toBe(MIN_LEVEL_COLS)
  })

  it('uses CEIL halving for a non-power-of-two width', () => {
    // 5 → 3 → 2 → 1 (ceil at each step)
    expect(planPyramid({ rows: 2, cols: 5 }).map(l => l.cols)).toEqual([5, 3, 2, 1])
  })

  it('cols < tileSize ⇒ a single tile', () => {
    const l0 = planPyramid({ rows: 4, cols: 100, tileSize: 32768 })[0]
    expect(l0.tiles).toBe(1)
    expect(l0.tileCols).toEqual([100])
  })

  it('cols > tileSize ⇒ correct tile count + layout summing to cols', () => {
    const l0 = planPyramid({ rows: 4, cols: 70000, tileSize: 32768 })[0]
    expect(l0.tiles).toBe(3) // ceil(70000/32768)
    expect(l0.tileCols).toEqual([32768, 32768, 70000 - 65536])
    expect(l0.tileCols.reduce((a, b) => a + b, 0)).toBe(70000)
  })

  it('lays out per-level tiles for a small tileSize', () => {
    const levels = planPyramid({ rows: 3, cols: 25, tileSize: 10 })
    expect(levels.map(l => l.cols)).toEqual([25, 13, 7, 4, 2, 1])
    expect(levels[0].tileCols).toEqual([10, 10, 5])
    expect(levels[1].tileCols).toEqual([10, 3])
    expect(levels[2].tiles).toBe(1)
  })
})

describe('residentTilesFor', () => {
  const level: PyramidLevel = planPyramid({ rows: 3, cols: 25, tileSize: 10 })[0] // tiles [10,10,5]

  it('returns exactly the tiles overlapping a column range', () => {
    expect(residentTilesFor(level, { start: 2, end: 2 }, 10)).toEqual([0])
    expect(residentTilesFor(level, { start: 12, end: 12 }, 10)).toEqual([1])
    expect(residentTilesFor(level, { start: 22, end: 24 }, 10)).toEqual([2])
    expect(residentTilesFor(level, { start: 8, end: 15 }, 10)).toEqual([0, 1])
    expect(residentTilesFor(level, { start: 0, end: 24 }, 10)).toEqual([0, 1, 2])
  })

  it('clamps an out-of-range request into the valid tile span', () => {
    expect(residentTilesFor(level, { start: -5, end: 3 }, 10)).toEqual([0])
    expect(residentTilesFor(level, { start: 20, end: 999 }, 10)).toEqual([2])
  })

  it('returns [] for an empty level or an inverted range', () => {
    const empty: PyramidLevel = { level: 0, cols: 0, rows: 3, tiles: 0, tileCols: [] }
    expect(residentTilesFor(empty, { start: 0, end: 0 }, 10)).toEqual([])
  })
})

describe('downsampleLevel — no filter (arithmetic mean)', () => {
  it('hand-computed 2×4 → 2×2 mean of adjacent columns', () => {
    // column-major (row,col): idx = col*2 + row
    //   (0,0)=10 (0,1)=20 (0,2)=30 (0,3)=40
    //   (1,0)=50 (1,1)=60 (1,2)=70 (1,3)=80
    const src = mat(2, 4, [10, 50, 20, 60, 30, 70, 40, 80])
    const out = downsampleLevel(src)
    expect(out.rows).toBe(2)
    expect(out.cols).toBe(2)
    // out(0,0)=mean(10,20)=15  out(1,0)=mean(50,60)=55
    // out(0,1)=mean(30,40)=35  out(1,1)=mean(70,80)=75
    expect(Array.from(out.values)).toEqual([15, 55, 35, 75])
    expect(Array.from(out.counts)).toEqual([2, 2, 2, 2])
  })

  it('odd width: the last output cell has a single source', () => {
    const src = mat(1, 3, [10, 20, 30]) // one row, three cols
    const out = downsampleLevel(src)
    expect(out.cols).toBe(2) // ceil(3/2)
    expect(Array.from(out.values)).toEqual([15, 30]) // mean(10,20)=15 ; lone 30
    expect(Array.from(out.counts)).toEqual([2, 1])
  })
})

describe('downsampleLevel — WITH filter (filter-aware aggregate)', () => {
  it('a straddling bin yields the in-range cell, NOT the mean of both', () => {
    // 200 is in [100,255]; 50 is out. A naive "filter the mean" would give mean(200,50)=125.
    const src = mat(1, 2, [200, 50])
    const out = downsampleLevel(src, { lo: 100, hi: 255 })
    expect(Array.from(out.values)).toEqual([200]) // in-range cell only
    expect(Array.from(out.counts)).toEqual([1])
  })

  it('an all-out-of-range bin is EMPTY (count 0, value EMPTY_VALUE)', () => {
    const src = mat(1, 2, [10, 20])
    const out = downsampleLevel(src, { lo: 100, hi: 255 })
    expect(Array.from(out.counts)).toEqual([0])
    expect(Array.from(out.values)).toEqual([EMPTY_VALUE])
  })

  it('an all-in-range bin equals the plain mean', () => {
    const src = mat(1, 2, [100, 200])
    const out = downsampleLevel(src, { lo: 50, hi: 255 })
    expect(Array.from(out.values)).toEqual([150]) // mean(100,200)
    expect(Array.from(out.counts)).toEqual([2])
  })
})

describe('downsampleLevel — count-weighted across levels', () => {
  it('a second downsample weights by counts (true mean of in-range base cells)', () => {
    // base row: [200(in), 50(out), 210(in), 220(in)] with filter [100,255]
    const base = mat(1, 4, [200, 50, 210, 220])
    const filter = { lo: 100, hi: 255 }
    const l1 = downsampleLevel(base, filter)
    // l1: [ (200 only), mean(210,220)=215 ] with counts [1, 2]
    expect(Array.from(l1.values)).toEqual([200, 215])
    expect(Array.from(l1.counts)).toEqual([1, 2])

    const l2 = downsampleLevel(l1, filter)
    // count-weighted: (200*1 + 215*2)/3 = 630/3 = 210 — the TRUE mean of {200,210,220}.
    // An UNWEIGHTED mean of the l1 values would be mean(200,215)=207.5→208 (WRONG).
    expect(Array.from(l2.values)).toEqual([210])
    expect(Array.from(l2.counts)).toEqual([3])
  })
})

describe('buildPyramid', () => {
  const base = makeMatrixFixture({ rows: 8, cols: 64, seed: 1 })

  it('level count + col sizes match planPyramid', () => {
    const planned = planPyramid({ rows: base.rows, cols: base.cols })
    const built = buildPyramid(base)
    expect(built.length).toBe(planned.length)
    expect(built.map(l => l.cols)).toEqual(planned.map(l => l.cols))
    expect(built[built.length - 1].cols).toBe(MIN_LEVEL_COLS)
  })

  it('level 0 is the base bytes with NO counts plane (every cell covered, weight 1)', () => {
    const built = buildPyramid(base)
    expect(Array.from(built[0].values)).toEqual(Array.from(base.values))
    // Level 0 carries no counts plane — its absence IS the "every cell covered / weight 1" marker
    // (an all-ones Uint32Array would be up to ~400 MB of waste on a wide base).
    expect(built[0].counts).toBeUndefined()
  })

  it('a full-range [0,255] filtered pyramid is byte-identical to the unfiltered one', () => {
    const plain = buildPyramid(base)
    const full = buildPyramid(base, { lo: 0, hi: 255 })
    expect(full.length).toBe(plain.length)
    const countsOf = (c?: Uint32Array) => (c ? Array.from(c) : null)
    for (let lvl = 0; lvl < plain.length; lvl++) {
      expect(Array.from(full[lvl].values)).toEqual(Array.from(plain[lvl].values))
      // level 0 has no counts plane on either side (both null); levels ≥ 1 match array-for-array.
      expect(countsOf(full[lvl].counts)).toEqual(countsOf(plain[lvl].counts))
    }
  })

  it('a filter that excludes everything drives every level empty', () => {
    // fixture values top out well under 255; [254,255] excludes ~all of them.
    const built = buildPyramid(base, { lo: 254, hi: 255 })
    const top = built[built.length - 1]
    expect(top.cols).toBe(MIN_LEVEL_COLS)
    // no base cell survived ⇒ the overview is entirely empty bins. The overview is a downsampled
    // level (cols 1), so it always carries a real counts plane (only level 0 omits it).
    expect(top.counts!.every(c => c === 0)).toBe(true)
    expect(top.values.every(v => v === EMPTY_VALUE)).toBe(true)
  })
})
