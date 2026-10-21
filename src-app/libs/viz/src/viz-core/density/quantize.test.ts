// quantize.test.ts — round-trip + precision-bound coverage for the 16-bit position packing
// (PERFORMANCE_PLAN.md Phase 2). Pure math, no GPU/DOM.

import { describe, it, expect } from 'vitest'
import { packPositions, unpackXY, readX, readY, U16_MAX } from './quantize'

/** Max per-axis round-trip error must be ≤ one code step (span / 65535). */
function axisStep(min: number, max: number): number {
  return (max - min) / U16_MAX
}

describe('packPositions / unpackXY round-trip', () => {
  it('reproduces the source within one code step per axis', () => {
    // A spread with distinct x/y ranges so the two scales differ.
    const xy = new Float32Array([
      -100, 0, 0, 50, 100, 100, 25, -20, 60, 80, -40, 33,
    ])
    const packed = packPositions(xy)
    const back = unpackXY(packed)

    const stepX = axisStep(-100, 100)
    const stepY = axisStep(-20, 100)
    expect(back.length).toBe(xy.length)
    for (let i = 0; i < xy.length; i += 2) {
      expect(Math.abs(back[i] - xy[i])).toBeLessThanOrEqual(stepX + 1e-4)
      expect(Math.abs(back[i + 1] - xy[i + 1])).toBeLessThanOrEqual(stepY + 1e-4)
    }
  })

  it('codes land in [0, 65535] and the extremes hit the endpoints', () => {
    const xy = new Float32Array([0, 0, 10, 20, 5, 10])
    const { packed } = packPositions(xy)
    for (const c of packed) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThanOrEqual(U16_MAX)
    }
    // min → 0, max → 65535 on each axis.
    expect(packed[0]).toBe(0) // x=0 (min)
    expect(packed[1]).toBe(0) // y=0 (min)
    expect(packed[2]).toBe(U16_MAX) // x=10 (max)
    expect(packed[3]).toBe(U16_MAX) // y=20 (max)
  })

  it('round-trip error shrinks as the axis span shrinks (precision is span-relative)', () => {
    const wide = packPositions(new Float32Array([0, 0, 1000, 1000, 500, 500]))
    const narrow = packPositions(new Float32Array([0, 0, 1, 1, 0.5, 0.5]))
    expect(narrow.scaleX).toBeLessThan(wide.scaleX)
    // decode the mid point in each; both within their own step.
    expect(Math.abs(readX(narrow.packed, 2, narrow) - 0.5)).toBeLessThanOrEqual(axisStep(0, 1) + 1e-7)
    expect(Math.abs(readX(wide.packed, 2, wide) - 500)).toBeLessThanOrEqual(axisStep(0, 1000) + 1e-3)
  })

  it('a degenerate axis (all equal) packs to code 0 and decodes exactly to the origin', () => {
    const xy = new Float32Array([7, 3, 7, 3, 7, 3])
    const packed = packPositions(xy)
    expect(packed.scaleX).toBe(0)
    expect(packed.scaleY).toBe(0)
    for (const c of packed.packed) expect(c).toBe(0)
    const back = unpackXY(packed)
    for (let i = 0; i < xy.length; i += 2) {
      expect(back[i]).toBe(7)
      expect(back[i + 1]).toBe(3)
    }
  })

  it('readX/readY equal the corresponding unpackXY entries (no separate decode drift)', () => {
    const xy = new Float32Array([-3, 12, 4, -8, 9, 0, 1, 1])
    const packed = packPositions(xy)
    const back = unpackXY(packed)
    // unpackXY narrows readX/readY's f64 result into a Float32Array; compare at f32 precision.
    for (let i = 0; i < xy.length / 2; i++) {
      expect(Math.fround(readX(packed.packed, i, packed))).toBe(back[i * 2])
      expect(Math.fround(readY(packed.packed, i, packed))).toBe(back[i * 2 + 1])
    }
  })

  it('an empty buffer yields an empty packed buffer', () => {
    const packed = packPositions(new Float32Array(0))
    expect(packed.packed.length).toBe(0)
    expect(unpackXY(packed).length).toBe(0)
  })
})
