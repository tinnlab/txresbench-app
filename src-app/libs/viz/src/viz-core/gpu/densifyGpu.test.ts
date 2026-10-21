import { describe, it, expect } from 'vitest'
import {
  densifyGpu,
  densifyOnDevice,
  verifyDensifyParity,
  deviceSupportsDensify,
  densifyTiling,
  densify,
} from './densifyGpu'
import { densify as wireDensify, type SparseColumn } from '../data/wire'

// The GPU path only runs in a real browser WebGL2 context (the orchestrator's headless
// harness calls `verifyDensifyParity` there). In node/vitest we exercise the CPU fallback
// of `densifyGpu` — which IS the `densify` oracle (DEC-27) — proving byte-exact parity
// with `data/wire.ts::densify`, plus the tiling math, the shapes, and the async dispatch.

/** Small helper: assert densifyGpu (no device → CPU fallback) === wire densify, exactly. */
async function expectFallbackEqualsOracle(col: SparseColumn) {
  const viaDispatch = await densifyGpu(col)
  const viaOracle = wireDensify(col)
  expect(viaDispatch).toBeInstanceOf(Float32Array)
  expect(viaDispatch.length).toBe(viaOracle.length)
  expect(Array.from(viaDispatch)).toEqual(Array.from(viaOracle))
}

describe('densifyGpu — CPU fallback is byte-exact with wire densify (TEST: DEC-26/27)', () => {
  it('re-exports the wire densify oracle (same function reference)', () => {
    expect(densify).toBe(wireDensify)
  })

  it('dense projection with the 0-default for absent points', async () => {
    // length 6, only rows 0,2,5 present → the rest default to 0
    const col: SparseColumn = {
      row: new Uint32Array([0, 2, 5]),
      value: new Float32Array([1.5, 3.25, -4]),
      length: 6,
    }
    await expectFallbackEqualsOracle(col)
    // spell out the expected dense form too
    expect(Array.from(await densifyGpu(col))).toEqual([1.5, 0, 3.25, 0, 0, -4])
  })

  it('every point present → no zero fill', async () => {
    const col: SparseColumn = {
      row: new Uint32Array([0, 1, 2, 3]),
      value: new Float32Array([10, 20, 30, 40]),
      length: 4,
    }
    await expectFallbackEqualsOracle(col)
  })

  it('empty sparse column → all-zeros dense of length N', async () => {
    const col: SparseColumn = {
      row: new Uint32Array([]),
      value: new Float32Array([]),
      length: 5,
    }
    await expectFallbackEqualsOracle(col)
    expect(Array.from(await densifyGpu(col))).toEqual([0, 0, 0, 0, 0])
  })

  it('length 0 → empty dense', async () => {
    const col: SparseColumn = {
      row: new Uint32Array([]),
      value: new Float32Array([]),
      length: 0,
    }
    await expectFallbackEqualsOracle(col)
    expect((await densifyGpu(col)).length).toBe(0)
  })

  it('out-of-range rows are ignored (mirrors the CPU oracle / TypedArray OOB write)', async () => {
    // row 9 >= length 3 → densify silently drops it (OOB TypedArray write is a no-op)
    const col: SparseColumn = {
      row: new Uint32Array([0, 9, 2]),
      value: new Float32Array([7, 999, 8]),
      length: 3,
    }
    await expectFallbackEqualsOracle(col)
    expect(Array.from(await densifyGpu(col))).toEqual([7, 0, 8])
  })

  it('last-write-wins for a duplicated row (matches densify loop order)', async () => {
    // densify assigns in order → the later value at the same row wins
    const col: SparseColumn = {
      row: new Uint32Array([1, 1]),
      value: new Float32Array([5, 9]),
      length: 3,
    }
    await expectFallbackEqualsOracle(col)
    expect(Array.from(await densifyGpu(col))).toEqual([0, 9, 0])
  })

  it('negative + fractional values round-trip through the fallback', async () => {
    const col: SparseColumn = {
      row: new Uint32Array([0, 1, 2]),
      value: new Float32Array([-1.5, 0.125, 42.75]),
      length: 3,
    }
    await expectFallbackEqualsOracle(col)
  })

  it('explicit null device also takes the CPU fallback', async () => {
    const col: SparseColumn = {
      row: new Uint32Array([1]),
      value: new Float32Array([3]),
      length: 4,
    }
    const out = await densifyGpu(col, null)
    expect(Array.from(out)).toEqual(Array.from(wireDensify(col)))
  })
})

describe('densifyTiling — width/height tiling of the dense grid', () => {
  it('N below the max width → a single row', () => {
    expect(densifyTiling(1000)).toEqual({ width: 1000, height: 1 })
  })

  it('N exactly at the max width → a single row', () => {
    expect(densifyTiling(16384)).toEqual({ width: 16384, height: 1 })
  })

  it('N above the max width → tiled to multiple rows, covering all texels', () => {
    const t = densifyTiling(16384 + 1)
    expect(t.width).toBe(16384)
    expect(t.height).toBe(2)
    expect(t.width * t.height).toBeGreaterThanOrEqual(16384 + 1)
  })

  it('a large N tiles with enough texels to cover every index', () => {
    const n = 10_000_003
    const t = densifyTiling(n)
    expect(t.width).toBe(16384)
    expect(t.width * t.height).toBeGreaterThanOrEqual(n)
  })

  it('length 0 → zero grid', () => {
    expect(densifyTiling(0)).toEqual({ width: 0, height: 0 })
  })
})

describe('GPU-path exports — present with the right shapes (browser-run)', () => {
  it('exposes the async GPU + parity + capability entry points', () => {
    expect(typeof densifyOnDevice).toBe('function')
    expect(typeof densifyGpu).toBe('function')
    expect(typeof verifyDensifyParity).toBe('function')
    expect(typeof deviceSupportsDensify).toBe('function')
    // async contract (mirrors the eventual WebGPU compute readback)
    expect(densifyOnDevice.constructor.name).toBe('AsyncFunction')
    expect(densifyGpu.constructor.name).toBe('AsyncFunction')
    expect(verifyDensifyParity.constructor.name).toBe('AsyncFunction')
  })
})
