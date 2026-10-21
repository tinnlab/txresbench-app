// chunkPicking.test.ts — unit tests for the pure local→global chunk-pick index mapping.
// No deck.gl / DOM: pure integer math, so it runs in node under vitest.

import { describe, it, expect } from 'vitest'
import { planChunks, bytesPerPoint, type Chunk } from './chunking'
import { globalIndexFor, chunkOrdinalFromLayerId } from './chunkPicking'

// A known 3-chunk plan: 250 points, 100/chunk → chunks [0,100), [100,200), [200,250).
const bpp = bytesPerPoint({ position: true, color: true })
const plan = planChunks(250, {
  maxPointsPerChunk: 100,
  gpuByteBudget: 1024 * 1024,
  bytesPerPoint: bpp,
  maxChunks: 256,
})
const chunks: readonly Chunk[] = plan.chunks

describe('planChunks fixture sanity', () => {
  it('is 3 contiguous chunks starting at 0/100/200', () => {
    expect(chunks.map(c => c.start)).toEqual([0, 100, 200])
    expect(chunks.map(c => c.count)).toEqual([100, 100, 50])
    // planChunks emits index === array position (the assumption chunkPicking relies on).
    expect(chunks.map(c => c.index)).toEqual([0, 1, 2])
  })
})

describe('globalIndexFor', () => {
  it('maps a local index in chunk 0 to itself (start 0)', () => {
    expect(globalIndexFor(chunks, 0, 0)).toBe(0)
    expect(globalIndexFor(chunks, 0, 42)).toBe(42)
    expect(globalIndexFor(chunks, 0, 99)).toBe(99)
  })

  it('offsets a local index by the chunk start for later chunks', () => {
    expect(globalIndexFor(chunks, 1, 0)).toBe(100)
    expect(globalIndexFor(chunks, 1, 99)).toBe(199)
    expect(globalIndexFor(chunks, 2, 0)).toBe(200)
    expect(globalIndexFor(chunks, 2, 49)).toBe(249) // last point of the last (short) chunk
  })

  it('rejects an out-of-range chunk ordinal', () => {
    expect(globalIndexFor(chunks, -1, 0)).toBe(-1)
    expect(globalIndexFor(chunks, 3, 0)).toBe(-1)
  })

  it('rejects a local index outside [0, chunk.count)', () => {
    expect(globalIndexFor(chunks, 0, -1)).toBe(-1)
    expect(globalIndexFor(chunks, 0, 100)).toBe(-1) // chunk 0 holds 100 pts → local 100 invalid
    expect(globalIndexFor(chunks, 2, 50)).toBe(-1) // last chunk holds only 50 pts
  })
})

describe('chunkOrdinalFromLayerId', () => {
  it('parses a chunk-<n> id back to its ordinal', () => {
    expect(chunkOrdinalFromLayerId('chunk-0')).toBe(0)
    expect(chunkOrdinalFromLayerId('chunk-2')).toBe(2)
    expect(chunkOrdinalFromLayerId('chunk-137')).toBe(137)
  })

  it('returns -1 for a non-chunk / malformed / missing id', () => {
    expect(chunkOrdinalFromLayerId('ortho')).toBe(-1)
    expect(chunkOrdinalFromLayerId('chunk-')).toBe(-1)
    expect(chunkOrdinalFromLayerId('chunk-1a')).toBe(-1)
    expect(chunkOrdinalFromLayerId(null)).toBe(-1)
    expect(chunkOrdinalFromLayerId(undefined)).toBe(-1)
  })

  it('composes with globalIndexFor to resolve a picked layer id + local index', () => {
    const ordinal = chunkOrdinalFromLayerId('chunk-1')
    expect(globalIndexFor(chunks, ordinal, 5)).toBe(105)
  })
})
