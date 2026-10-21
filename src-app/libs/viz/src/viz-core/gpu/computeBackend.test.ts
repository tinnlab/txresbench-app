import { describe, it, expect } from 'vitest'
import { resolveComputeBackend, type ComputeBackend } from './computeDevice'
import { groupReduce, cpuGroupReduce } from './groupReduce'
import { densifyGpu } from './densifyGpu'
import { densify as wireDensify, type SparseColumn } from '../data/wire'

// Phase 4 — the WebGPU-ready compute seam. These tests prove:
//   • resolveComputeBackend maps a device's `type` to the backend enum correctly;
//   • the enum-based dispatch in groupReduce/densifyGpu is BYTE-IDENTICAL to the CPU
//     oracle when no capable device is present (i.e. always, in node/vitest).
// (The 'webgpu' backend value is a forward-compatible tag consumed by groupReduce/densifyGpu;
// no WebGPU device is ever created today, so it is never selected — see computeDevice.ts.)

// A structural device stub — resolveComputeBackend only inspects `.type`.
const dev = (type: string) => ({ type }) as unknown as import('@luma.gl/core').Device

describe('resolveComputeBackend — maps device.type to the ComputeBackend enum', () => {
  it('no device → cpu', () => {
    expect(resolveComputeBackend()).toBe('cpu' satisfies ComputeBackend)
    expect(resolveComputeBackend(null)).toBe('cpu')
    expect(resolveComputeBackend(undefined)).toBe('cpu')
  })

  it("a WebGL2 device (type 'webgl') → webgl2", () => {
    expect(resolveComputeBackend(dev('webgl'))).toBe('webgl2')
  })

  it("a WebGPU device (type 'webgpu') → webgpu", () => {
    expect(resolveComputeBackend(dev('webgpu'))).toBe('webgpu')
  })

  it("a null / unknown device → cpu (cannot run the GPU kernels)", () => {
    expect(resolveComputeBackend(dev('null'))).toBe('cpu')
    expect(resolveComputeBackend(dev('unknown'))).toBe('cpu')
    expect(resolveComputeBackend(dev(''))).toBe('cpu')
  })

  it('webgpu is never returned in the node/vitest environment (no adapter registered)', () => {
    // There is no device to inspect here — the ONLY way to get 'webgpu' is to be handed a
    // real WebGPU device, which the compute-device singleton never constructs.
    expect(resolveComputeBackend()).not.toBe('webgpu')
  })
})

describe('enum dispatch stays byte-identical to the CPU oracle (no capable device)', () => {
  it('groupReduce() with no device === cpuGroupReduce()', async () => {
    const values = new Float32Array([1, 0, 3, 4, 2])
    const codes = new Uint16Array([0, 1, 0, 1, 2])
    const viaDispatch = await groupReduce({ values, codes, nGroups: 3 })
    const oracle = cpuGroupReduce(values, codes, 3)
    expect(Array.from(viaDispatch.sum)).toEqual(Array.from(oracle.sum))
    expect(Array.from(viaDispatch.nonzero)).toEqual(Array.from(oracle.nonzero))
    expect(Array.from(viaDispatch.count)).toEqual(Array.from(oracle.count))
    expect(Array.from(viaDispatch.sumSq)).toEqual(Array.from(oracle.sumSq))
  })

  it('densifyGpu() with no device === wire densify()', async () => {
    const col: SparseColumn = {
      row: new Uint32Array([0, 2, 5]),
      value: new Float32Array([1.5, 3.25, -4]),
      length: 6,
    }
    const viaDispatch = await densifyGpu(col)
    expect(Array.from(viaDispatch)).toEqual(Array.from(wireDensify(col)))
  })

  it("a non-capable stub 'webgl' device still degrades to CPU (no float features)", async () => {
    // The stub advertises no features, so deviceSupportsGroupReduce is false → CPU arm.
    const values = new Float32Array([2, 5, 0])
    const codes = new Uint16Array([0, 0, 1])
    const stub = { type: 'webgl', features: new Set<string>() } as unknown as import('@luma.gl/core').Device
    const viaDispatch = await groupReduce({ values, codes, nGroups: 2 }, stub)
    const oracle = cpuGroupReduce(values, codes, 2)
    expect(Array.from(viaDispatch.sum)).toEqual(Array.from(oracle.sum))
    expect(Array.from(viaDispatch.count)).toEqual(Array.from(oracle.count))
  })
})
