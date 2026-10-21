import { describe, it, expect } from 'vitest'
import {
  cpuGroupReduce,
  cpuGroupReduceMulti,
  groupReduce,
  groupReduceMulti,
  verifyGroupReduceParity,
  runGroupReduceOnDevice,
  deviceSupportsGroupReduce,
  type GroupReduceResult,
} from './groupReduce'

// The GPU path only runs in a real browser WebGL2 context (the orchestrator's headless
// harness calls `verifyGroupReduceParity` there). In node/vitest we exercise the CPU
// oracle thoroughly — it IS the parity reference (DEC-27) — plus the input/output shapes
// and the top-level dispatch's CPU fallback.

describe('cpuGroupReduce — the parity oracle (TEST: DEC-26/29 segmented reduction)', () => {
  it('known values → known per-group sum / nonzero / count', () => {
    // 3 groups. Points: (g0,1) (g1,2) (g0,3) (g2,0) (g1,0) (g0,4)
    const values = new Float32Array([1, 2, 3, 0, 0, 4])
    const codes = new Uint16Array([0, 1, 0, 2, 1, 0])
    const r = cpuGroupReduce(values, codes, 3)
    // g0: 1+3+4 = 8, all non-zero (3), count 3
    // g1: 2+0 = 2, one non-zero, count 2
    // g2: 0, zero non-zero, count 1
    expect(Array.from(r.sum)).toEqual([8, 2, 0])
    expect(Array.from(r.nonzero)).toEqual([3, 1, 0])
    expect(Array.from(r.count)).toEqual([3, 2, 1])
  })

  it('mean = sum/count and fraction = nonzero/count derive correctly', () => {
    const values = new Float32Array([1, 3, 0, 4])
    const codes = new Uint16Array([0, 0, 0, 1])
    const r = cpuGroupReduce(values, codes, 2)
    // g0: sum 4, nonzero 2, count 3 → mean 4/3, fraction 2/3
    expect(r.sum[0] / r.count[0]).toBeCloseTo(4 / 3, 6)
    expect(r.nonzero[0] / r.count[0]).toBeCloseTo(2 / 3, 6)
    // g1: sum 4, nonzero 1, count 1 → mean 4, fraction 1
    expect(r.sum[1] / r.count[1]).toBe(4)
    expect(r.nonzero[1] / r.count[1]).toBe(1)
  })

  it('empty group → zeros (no divide, count stays 0)', () => {
    const values = new Float32Array([5, 6])
    const codes = new Uint16Array([0, 0]) // group 1 gets nothing
    const r = cpuGroupReduce(values, codes, 2)
    expect(r.sum[1]).toBe(0)
    expect(r.nonzero[1]).toBe(0)
    expect(r.count[1]).toBe(0)
  })

  it('all points in one group', () => {
    const values = new Float32Array([2, 0, 3, 0, 5])
    const codes = new Uint16Array([1, 1, 1, 1, 1])
    const r = cpuGroupReduce(values, codes, 3)
    expect(Array.from(r.sum)).toEqual([0, 10, 0])
    expect(Array.from(r.nonzero)).toEqual([0, 3, 0])
    expect(Array.from(r.count)).toEqual([0, 5, 0])
  })

  it('ignores out-of-range codes (mirrors the GPU clip-cull)', () => {
    const values = new Float32Array([1, 2, 3])
    const codes = new Uint16Array([0, 9, 1]) // 9 >= nGroups(2) → dropped
    const r = cpuGroupReduce(values, codes, 2)
    expect(Array.from(r.sum)).toEqual([1, 3])
    expect(Array.from(r.count)).toEqual([1, 1])
  })

  it('negative values count as NOT expressing (value > 0 predicate)', () => {
    const values = new Float32Array([-1, -2, 4])
    const codes = new Uint16Array([0, 0, 0])
    const r = cpuGroupReduce(values, codes, 1)
    expect(r.sum[0]).toBe(1) // -1 + -2 + 4
    expect(r.nonzero[0]).toBe(1) // only the 4
    expect(r.count[0]).toBe(3)
  })

  it('handles nGroups = 0 → empty typed arrays', () => {
    const r = cpuGroupReduce(new Float32Array([1, 2]), new Uint16Array([0, 1]), 0)
    expect(r.sum.length).toBe(0)
    expect(r.nonzero.length).toBe(0)
    expect(r.count.length).toBe(0)
  })

  it('returns Float32Array of length nGroups for every channel (readback shape)', () => {
    const r = cpuGroupReduce(new Float32Array([1]), new Uint16Array([0]), 4)
    for (const arr of [r.sum, r.nonzero, r.count] as const) {
      expect(arr).toBeInstanceOf(Float32Array)
      expect(arr.length).toBe(4)
    }
  })
})

describe('cpuGroupReduceMulti — M value columns share one codes/nGroups (dotplot)', () => {
  it('reduces each column independently against the same grouping', () => {
    const codes = new Uint16Array([0, 1, 0, 1])
    const geneA = new Float32Array([1, 2, 3, 0])
    const geneB = new Float32Array([0, 0, 5, 7])
    const [ra, rb] = cpuGroupReduceMulti([geneA, geneB], codes, 2)
    // geneA g0: 1+3=4 (nz 2, cnt 2); g1: 2+0=2 (nz 1, cnt 2)
    expect(Array.from(ra.sum)).toEqual([4, 2])
    expect(Array.from(ra.nonzero)).toEqual([2, 1])
    // geneB g0: 0+5=5 (nz 1, cnt 2); g1: 0+7=7 (nz 1, cnt 2)
    expect(Array.from(rb.sum)).toEqual([5, 7])
    expect(Array.from(rb.nonzero)).toEqual([1, 1])
  })

  it('returns one result per column', () => {
    const cols = [new Float32Array([1]), new Float32Array([2]), new Float32Array([3])]
    const out = cpuGroupReduceMulti(cols, new Uint16Array([0]), 1)
    expect(out).toHaveLength(3)
  })
})

describe('groupReduce dispatch — CPU fallback when no device (TEST: DEC-26 compute seam)', () => {
  it('groupReduce() with no device === cpuGroupReduce()', async () => {
    const values = new Float32Array([1, 0, 3, 4])
    const codes = new Uint16Array([0, 1, 0, 1])
    const viaDispatch = await groupReduce({ values, codes, nGroups: 2 })
    const viaOracle = cpuGroupReduce(values, codes, 2)
    expectResultEqual(viaDispatch, viaOracle)
  })

  it('groupReduceMulti() with no device === cpuGroupReduceMulti()', async () => {
    const codes = new Uint16Array([0, 1, 0])
    const cols = [new Float32Array([1, 2, 3]), new Float32Array([0, 5, 6])]
    const viaDispatch = await groupReduceMulti(cols, codes, 2)
    const viaOracle = cpuGroupReduceMulti(cols, codes, 2)
    expect(viaDispatch).toHaveLength(viaOracle.length)
    viaDispatch.forEach((r, i) => expectResultEqual(r, viaOracle[i]))
  })
})

describe('GPU-path exports — present with the right shapes (browser-run)', () => {
  it('exposes the async GPU + parity + capability entry points', () => {
    expect(typeof runGroupReduceOnDevice).toBe('function')
    expect(typeof verifyGroupReduceParity).toBe('function')
    expect(typeof deviceSupportsGroupReduce).toBe('function')
    // async contract
    expect(runGroupReduceOnDevice.constructor.name).toBe('AsyncFunction')
    expect(verifyGroupReduceParity.constructor.name).toBe('AsyncFunction')
  })
})

function expectResultEqual(a: GroupReduceResult, b: GroupReduceResult) {
  expect(Array.from(a.sum)).toEqual(Array.from(b.sum))
  expect(Array.from(a.nonzero)).toEqual(Array.from(b.nonzero))
  expect(Array.from(a.count)).toEqual(Array.from(b.count))
}
