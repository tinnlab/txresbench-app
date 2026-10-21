// persistentAttr.test.ts — unit tests for the persistent (reused-in-place) attribute-buffer
// helpers. Pure typed-array math, runs in node under vitest. The core guarantee under test:
// the SAME buffer is reused across updates (no per-interaction allocation), and the in-place
// writes produce correct contents.

import { describe, it, expect } from 'vitest'
import { ensureFloat32, writeColumn, writeMaskAsFloat } from './persistentAttr'

describe('ensureFloat32 — reuse vs realloc', () => {
  it('reuses the SAME array when the length already matches (no allocation)', () => {
    const first = ensureFloat32(null, 1000)
    const second = ensureFloat32(first, 1000)
    expect(second).toBe(first) // identical reference → zero allocation on the hot path
  })

  it('allocates a new array on first use (null/undefined existing)', () => {
    const a = ensureFloat32(null, 8)
    expect(a).toBeInstanceOf(Float32Array)
    expect(a.length).toBe(8)
    expect(ensureFloat32(undefined, 4).length).toBe(4)
  })

  it('reallocates when the length changes (a genuine N change)', () => {
    const first = ensureFloat32(null, 100)
    const grown = ensureFloat32(first, 200)
    expect(grown).not.toBe(first)
    expect(grown.length).toBe(200)
  })

  it('floors fractional length and never goes negative', () => {
    expect(ensureFloat32(null, 5.9).length).toBe(5)
    expect(ensureFloat32(null, -3).length).toBe(0)
  })
})

describe('writeMaskAsFloat — Uint8 → Float32 in place', () => {
  it('widens a 0/1 mask into a reused float buffer without allocating', () => {
    const buf = ensureFloat32(null, 5)
    writeMaskAsFloat(buf, Uint8Array.from([1, 0, 1, 1, 0]))
    expect(Array.from(buf)).toEqual([1, 0, 1, 1, 0])
  })

  it('a second write into the SAME buffer overwrites in place (no realloc)', () => {
    const buf = ensureFloat32(null, 4)
    writeMaskAsFloat(buf, Uint8Array.from([1, 1, 1, 1]))
    writeMaskAsFloat(buf, Uint8Array.from([0, 1, 0, 1]))
    expect(Array.from(buf)).toEqual([0, 1, 0, 1])
  })
})

describe('writeColumn — dense value column copy in place', () => {
  it('copies an equal-length column into the reused buffer', () => {
    const buf = ensureFloat32(null, 4)
    writeColumn(buf, Float32Array.from([1.5, 2.5, 3.5, 4.5]))
    expect(Array.from(buf)).toEqual([1.5, 2.5, 3.5, 4.5])
  })

  it('recolor: writing a second column into the SAME buffer swaps contents, same reference', () => {
    const buf = ensureFloat32(null, 3)
    const colA = Float32Array.from([1, 2, 3])
    const colB = Float32Array.from([9, 8, 7])
    writeColumn(buf, colA)
    expect(Array.from(buf)).toEqual([1, 2, 3])
    const ref = buf
    writeColumn(buf, colB)
    expect(buf).toBe(ref) // stable reference across recolors
    expect(Array.from(buf)).toEqual([9, 8, 7])
  })

  it('copies only up to the destination length when src is longer', () => {
    const buf = ensureFloat32(null, 2)
    writeColumn(buf, Float32Array.from([5, 6, 7, 8]))
    expect(Array.from(buf)).toEqual([5, 6])
  })
})
