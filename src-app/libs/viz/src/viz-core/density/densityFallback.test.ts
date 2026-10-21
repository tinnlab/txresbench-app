// densityFallback.test.ts — BUG #6: the GPU-binned density grid (DensityView → ScreenGridLayer with
// `gpuAggregation:true`) renders BLANK on software/weak GL that can't render into a float target (the
// aggregation texture reads back empty). The fix gates `gpuAggregation` on device float-target
// capability (`resolveDensityGpuAggregation`), routing such a device to ScreenGridLayer's
// CPU-aggregation draw path — capability-gated, NOT renderer-name-gated. These tests pin the decision.

import { describe, it, expect } from 'vitest'
import type { Device } from '@luma.gl/core'
import { resolveDensityGpuAggregation } from '../gpu/renderCapability'

/** A minimal device stub whose `.features` set is what `deviceSupportsDensify` reads. */
function fakeDevice(features: string[]): Device {
  return { features: new Set(features) } as unknown as Device
}

describe('resolveDensityGpuAggregation (BUG #6 fallback gate)', () => {
  it('uses the GPU aggregation path on a FLOAT-RENDERABLE device (render UNCHANGED on capable GPUs)', () => {
    // A real GPU — and this box's SwiftShader — advertises float32-renderable-webgl.
    expect(resolveDensityGpuAggregation(fakeDevice(['float32-renderable-webgl']))).toBe(true)
    // The WebGPU float capability also qualifies.
    expect(resolveDensityGpuAggregation(fakeDevice(['float32-blendable']))).toBe(true)
  })

  it('falls back to the CPU aggregation path when the device CANNOT render a float target', () => {
    // Software/weak GL: no float-renderable feature ⇒ the GPU aggregation texture reads back empty,
    // so `gpuAggregation` must be false (ScreenGridLayer's CPU-aggregation draw path renders it).
    expect(resolveDensityGpuAggregation(fakeDevice([]))).toBe(false)
    expect(resolveDensityGpuAggregation(fakeDevice(['some-unrelated-feature']))).toBe(false)
  })

  it('keeps the GPU default until the device is initialized (null/undefined)', () => {
    // Before `onDeviceInitialized` supplies the device, keep the GPU path (the capable-GPU default);
    // a software device flips it to false on that first callback, before a blank frame can persist.
    expect(resolveDensityGpuAggregation(null)).toBe(true)
    expect(resolveDensityGpuAggregation(undefined)).toBe(true)
  })
})
