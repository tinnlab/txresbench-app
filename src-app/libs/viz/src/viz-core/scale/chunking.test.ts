// chunking.test.ts — unit tests for the pure 10M+ chunk-planning + GPU-budget math.
// No deck.gl / DOM: pure math + typed-array views, so it runs in node under vitest.

import { describe, it, expect } from 'vitest'
import {
  bytesPerPoint,
  estimateLayerBytes,
  planChunks,
  lodStride,
  subarrayView,
  strideSample,
  MAX_SINGLE_LAYER_BYTES,
  type ChunkPlan,
} from './chunking'

describe('bytesPerPoint / estimateLayerBytes', () => {
  it('defaults to position(8) + color(4) = 12 B/point', () => {
    expect(bytesPerPoint()).toBe(12)
    expect(bytesPerPoint({})).toBe(12)
  })

  it('adds 4 B per extra f32 value attribute', () => {
    expect(bytesPerPoint({ valueAttrs: 1 })).toBe(16)
    expect(bytesPerPoint({ valueAttrs: 3 })).toBe(24)
  })

  it('drops position / color when disabled', () => {
    expect(bytesPerPoint({ color: false })).toBe(8)
    expect(bytesPerPoint({ position: false })).toBe(4)
    expect(bytesPerPoint({ position: false, color: false, valueAttrs: 2 })).toBe(8)
  })

  it('estimateLayerBytes = count × bytesPerPoint', () => {
    expect(estimateLayerBytes(10, {})).toBe(120)
    expect(estimateLayerBytes(1_000_000)).toBe(12_000_000)
    expect(estimateLayerBytes(0)).toBe(0)
  })
})

// helper: a generous budget (bytes) that never binds before maxPointsPerChunk.
const BIG_BUDGET = 1 << 30 // 1 GiB

describe('planChunks — boundaries', () => {
  it('covers [0,total) with no gap or overlap; exact boundaries', () => {
    const total = 10_000_003
    const plan = planChunks(total, {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    // exact chunk count: ceil(10_000_003 / 1_000_000) = 11
    expect(plan.chunkCount).toBe(11)
    expect(plan.chunks).toHaveLength(11)

    // contiguity: each chunk starts exactly where the previous ended, no gaps/overlaps.
    let cursor = 0
    for (const c of plan.chunks) {
      expect(c.start).toBe(cursor)
      expect(c.count).toBeGreaterThan(0)
      expect(c.byteStart).toBe(c.start * 12)
      cursor = c.start + c.count
    }
    // full coverage: last chunk ends exactly at total.
    expect(cursor).toBe(total)
    // sum of counts == total.
    expect(plan.chunks.reduce((s, c) => s + c.count, 0)).toBe(total)
  })

  it('last chunk holds the remainder', () => {
    const plan = planChunks(2_500_000, {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    expect(plan.chunkCount).toBe(3)
    expect(plan.chunks[0].count).toBe(1_000_000)
    expect(plan.chunks[1].count).toBe(1_000_000)
    expect(plan.chunks[2].count).toBe(500_000) // remainder
    expect(plan.chunks[2].start).toBe(2_000_000)
  })

  it('exact multiple → no partial trailing chunk', () => {
    const plan = planChunks(3_000_000, {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    expect(plan.chunkCount).toBe(3)
    expect(plan.chunks.every(c => c.count === 1_000_000)).toBe(true)
  })

  it('total 0 → empty plan, ok verdict', () => {
    const plan = planChunks(0, {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    expect(plan.chunks).toHaveLength(0)
    expect(plan.chunkCount).toBe(0)
    expect(plan.bytesEstimate).toBe(0)
    expect(plan.verdict).toBe('ok')
  })

  it('single chunk when total ≤ cap', () => {
    const plan = planChunks(500, {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    expect(plan.chunkCount).toBe(1)
    expect(plan.chunks[0]).toMatchObject({ index: 0, start: 0, count: 500, byteStart: 0 })
  })
})

describe('planChunks — budget cap forces more chunks', () => {
  it('a tight per-layer byte budget shrinks the effective chunk size', () => {
    // maxPointsPerChunk = 1M, but budget only fits 100k points (100k × 12 = 1.2 MB).
    const budget = 100_000 * 12
    const plan = planChunks(1_000_000, {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: budget,
      bytesPerPoint: 12,
    })
    expect(plan.budgetPointsPerChunk).toBe(100_000)
    expect(plan.pointsPerChunk).toBe(100_000) // budget binds, not maxPointsPerChunk
    expect(plan.chunkCount).toBe(10) // 1M / 100k
    // every chunk fits the byte budget.
    for (const c of plan.chunks) {
      expect(estimateLayerBytes(c.count)).toBeLessThanOrEqual(budget)
    }
  })

  it('maxPointsPerChunk binds when it is the smaller cap', () => {
    const plan = planChunks(1_000_000, {
      maxPointsPerChunk: 250_000,
      gpuByteBudget: BIG_BUDGET, // budget fits far more than 250k
      bytesPerPoint: 12,
    })
    expect(plan.pointsPerChunk).toBe(250_000)
    expect(plan.chunkCount).toBe(4)
  })
})

describe('planChunks — over-budget → LOD verdict', () => {
  it('dataset exceeding aggregate capacity is over-budget with an LOD stride', () => {
    // per-layer budget = 100k points; maxChunks = 4 → aggregate capacity = 400k points.
    // total 10M ≫ 400k → over-budget.
    const plan = planChunks(10_000_000, {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: 100_000 * 12,
      bytesPerPoint: 12,
      maxChunks: 4,
    })
    expect(plan.pointsPerChunk).toBe(100_000)
    expect(plan.verdict).toBe('over-budget')
    // aggregate capacity = 4 × 100k = 400k → stride = ceil(10M / 400k) = 25.
    expect(plan.lodStride).toBe(25)
    // downsampling by the stride brings the visible count within capacity.
    const visible = Math.ceil(plan.total / plan.lodStride)
    expect(visible).toBeLessThanOrEqual(plan.maxChunks * plan.pointsPerChunk)
  })

  it('dataset within aggregate capacity is ok with stride 1', () => {
    const plan = planChunks(3_000_000, {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
      maxChunks: 256,
    })
    expect(plan.verdict).toBe('ok')
    expect(plan.lodStride).toBe(1)
  })
})

describe('lodStride', () => {
  it('returns 1 when the data already fits', () => {
    expect(lodStride(1000, 1000)).toBe(1)
    expect(lodStride(500, 1000)).toBe(1)
    expect(lodStride(0, 1000)).toBe(1)
  })

  it('returns ceil(total/targetVisible) when it does not fit', () => {
    expect(lodStride(10_000_000, 1_000_000)).toBe(10)
    expect(lodStride(10_000_001, 1_000_000)).toBe(11) // ceil rounds up
    expect(lodStride(2_500_000, 1_000_000)).toBe(3)
  })

  it('guards a zero / negative target', () => {
    expect(lodStride(100, 0)).toBe(100)
  })
})

describe('subarrayView — zero-copy', () => {
  it('returns the exact slice for a chunk at the given stride', () => {
    const positions = new Float32Array(20) // 10 points × 2
    for (let i = 0; i < positions.length; i++) positions[i] = i
    const plan = planChunks(10, {
      maxPointsPerChunk: 4,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    // chunks: [0..4)(4), [4..8)(4), [8..10)(2)
    const c1 = subarrayView(positions, plan.chunks[1], 2)
    expect(c1.length).toBe(4 * 2) // 4 points × stride 2
    // chunk 1 starts at point 4 → element offset 8.
    expect(Array.from(c1)).toEqual([8, 9, 10, 11, 12, 13, 14, 15])

    const c2 = subarrayView(positions, plan.chunks[2], 2)
    expect(c2.length).toBe(2 * 2) // remainder: 2 points × stride 2
    expect(Array.from(c2)).toEqual([16, 17, 18, 19])
  })

  it('SHARES the same ArrayBuffer as the source (no copy) — the 10M crux', () => {
    const positions = new Float32Array(20)
    const colors = new Uint8Array(40) // 10 points × 4
    const plan = planChunks(10, {
      maxPointsPerChunk: 4,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    const posView = subarrayView(positions, plan.chunks[0], 2)
    const colView = subarrayView(colors, plan.chunks[0], 4)
    // zero-copy: identical underlying buffer, not a clone.
    expect(posView.buffer).toBe(positions.buffer)
    expect(colView.buffer).toBe(colors.buffer)

    // mutating through the view is visible in the source (proves it's a view, not a copy).
    posView[0] = 42
    expect(positions[0]).toBe(42)
  })

  it('honours the color stride (4) with correct byte offsets', () => {
    const colors = new Uint8Array(40)
    for (let i = 0; i < colors.length; i++) colors[i] = i
    const plan = planChunks(10, {
      maxPointsPerChunk: 4,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    const view = subarrayView(colors, plan.chunks[1], 4)
    expect(view.length).toBe(4 * 4) // 4 points × RGBA
    // chunk 1 starts at point 4 → byte offset 16.
    expect(view.byteOffset).toBe(16)
    expect(view[0]).toBe(16)
  })
})

describe('strideSample — LOD downsample copy', () => {
  it('keeps ceil(total/stride) points, first point verbatim, xy interleaving preserved', () => {
    // 10 points × 2 (xy), values 0..19.
    const positions = new Float32Array(20)
    for (let i = 0; i < positions.length; i++) positions[i] = i
    // stride 3 → keep points 0,3,6,9 = ceil(10/3)=4 points.
    const out = strideSample(positions, 3, 2)
    expect(out.length).toBe(4 * 2)
    expect(Array.from(out)).toEqual([0, 1, 6, 7, 12, 13, 18, 19])
    // first kept point == source point 0; last kept point == source point 9 = (4-1)*3.
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(1)
    expect(out[out.length - 2]).toBe(18)
    expect(out[out.length - 1]).toBe(19)
  })

  it('preserves RGBA (4-elem) interleaving and picks every Nth from index 0', () => {
    // 12 points × 4 (RGBA), values 0..47.
    const colors = new Uint8Array(48)
    for (let i = 0; i < colors.length; i++) colors[i] = i
    // stride 5 → keep points 0,5,10 = ceil(12/5)=3 points (last kept = 10, NOT the last point 11).
    const out = strideSample(colors, 5, 4)
    expect(out).toBeInstanceOf(Uint8Array) // subtype preserved
    expect(out.length).toBe(3 * 4)
    expect(Array.from(out)).toEqual([0, 1, 2, 3, 20, 21, 22, 23, 40, 41, 42, 43])
  })

  it('kept-count matches ceil(total/stride) across strides', () => {
    const buf = new Float32Array(10 * 2) // 10 points, xy
    expect(strideSample(buf, 2, 2).length / 2).toBe(Math.ceil(10 / 2)) // 5
    expect(strideSample(buf, 4, 2).length / 2).toBe(Math.ceil(10 / 4)) // 3
    expect(strideSample(buf, 7, 2).length / 2).toBe(Math.ceil(10 / 7)) // 2
  })

  it('stride ≤ 1 returns the input unchanged (no copy — full-detail path)', () => {
    const positions = new Float32Array([1, 2, 3, 4])
    expect(strideSample(positions, 1, 2)).toBe(positions)
    expect(strideSample(positions, 0, 2)).toBe(positions)
  })

  it('a stride from planChunks brings the visible count within aggregate capacity', () => {
    const total = 1_000_000
    const budgetOpts = {
      maxPointsPerChunk: 1_000_000,
      gpuByteBudget: 100_000 * 12, // 100k points/layer
      bytesPerPoint: 12,
      maxChunks: 4, // aggregate cap = 4 × 100k = 400k
    }
    const plan = planChunks(total, budgetOpts)
    expect(plan.verdict).toBe('over-budget') // 1M > 400k
    // simulate the component: downsample positions (xy) by the recommended stride, re-plan.
    const positions = new Float32Array(total * 2)
    const reduced = strideSample(positions, plan.lodStride, 2)
    const reducedTotal = reduced.length / 2
    expect(reducedTotal).toBe(Math.ceil(total / plan.lodStride))
    const rePlan = planChunks(reducedTotal, budgetOpts)
    // the re-plan now fits: within budget, capped chunk count (not an uncapped layer count).
    expect(rePlan.verdict).toBe('ok')
    expect(rePlan.chunkCount).toBeLessThanOrEqual(plan.maxChunks)
  })
})

describe('single-alloc cap (Phase 2: no chunk asks for a >1 GiB buffer)', () => {
  it('MAX_SINGLE_LAYER_BYTES is 1 GiB', () => {
    expect(MAX_SINGLE_LAYER_BYTES).toBe(1024 * 1024 * 1024)
  })

  it('clamps a huge per-layer budget so a chunk never exceeds the single-alloc cap', () => {
    // Ask for a 32 GiB per-layer budget + a 500M point cap: both would blow past 1 GiB.
    const plan = planChunks(500_000_000, {
      maxPointsPerChunk: 500_000_000,
      gpuByteBudget: 32 * 1024 * 1024 * 1024,
      bytesPerPoint: 12,
      maxChunks: 4096,
    })
    // Every chunk's bytes stay under the cap.
    expect(plan.pointsPerChunk * plan.bytesPerPoint).toBeLessThanOrEqual(MAX_SINGLE_LAYER_BYTES)
    expect(plan.perChunkByteBudget).toBeLessThanOrEqual(MAX_SINGLE_LAYER_BYTES)
    for (const c of plan.chunks) {
      expect(c.count * plan.bytesPerPoint).toBeLessThanOrEqual(MAX_SINGLE_LAYER_BYTES)
    }
  })

  it('a 10M cloud stays a single under-cap chunk (89.5M points fit in 1 GiB at 12 B/pt)', () => {
    const plan = planChunks(10_000_000, {
      maxPointsPerChunk: 100_000_000,
      gpuByteBudget: 2 * 1024 * 1024 * 1024, // over the cap → clamped
      bytesPerPoint: 12,
    })
    expect(plan.chunkCount).toBe(1)
    expect(plan.chunks[0].count).toBe(10_000_000)
    expect(plan.chunks[0].count * 12).toBeLessThanOrEqual(MAX_SINGLE_LAYER_BYTES)
  })
})

describe('ChunkPlan is a plain serialisable object', () => {
  it('exposes the readout fields the UI/story surface', () => {
    const plan: ChunkPlan = planChunks(1_000_000, {
      maxPointsPerChunk: 300_000,
      gpuByteBudget: BIG_BUDGET,
      bytesPerPoint: 12,
    })
    expect(plan.total).toBe(1_000_000)
    expect(plan.bytesEstimate).toBe(12_000_000)
    expect(plan.chunkCount).toBe(4) // ceil(1M / 300k)
    expect(typeof plan.pointsPerChunk).toBe('number')
  })
})
