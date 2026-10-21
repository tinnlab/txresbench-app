// rasterFirst.test.ts — the raster-first gate (PERFORMANCE_PLAN.md Phase 2). Verifies that in
// CPU-raster mode the point-layer path is SKIPPED (no O(N) allocation), and that in the normal
// path it builds exactly as before. Pure — no React/deck render needed.

import { describe, it, expect } from 'vitest'
import { shouldBuildPointLayers, pointColorValue } from './rasterFirst'

describe('shouldBuildPointLayers', () => {
  it('is FALSE in raster mode (the layers memo returns [] — no ScatterplotLayer built)', () => {
    expect(shouldBuildPointLayers(true)).toBe(false)
  })
  it('is TRUE in the normal GPU path (points build as before)', () => {
    expect(shouldBuildPointLayers(false)).toBe(true)
  })
})

describe('pointColorValue', () => {
  const codes = Uint16Array.from([0, 1, 2, 3, 1, 0])

  it('allocates NOTHING in raster mode — returns a length-0 buffer (the load fix)', () => {
    const v = pointColorValue(codes, true)
    expect(v.length).toBe(0)
    // The same shared empty buffer every time — a 10M cloud pays no 4·N allocation.
    expect(pointColorValue(codes, true)).toBe(v)
  })

  it('builds the full per-point float VALUE buffer in the normal path', () => {
    const v = pointColorValue(codes, false)
    expect(v.length).toBe(codes.length)
    expect(Array.from(v)).toEqual([0, 1, 2, 3, 1, 0])
    expect(v).toBeInstanceOf(Float32Array)
  })
})
