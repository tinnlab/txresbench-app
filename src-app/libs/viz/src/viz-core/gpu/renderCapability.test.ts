import { describe, it, expect } from 'vitest'
import {
  matchesSoftwareRenderer,
  readRendererString,
  isSoftwareRenderer,
  resolveCpuRasterMode,
  DEFAULT_RASTER_POINT_THRESHOLD,
} from './renderCapability'

describe('matchesSoftwareRenderer', () => {
  it('matches the known software backends (case-insensitive)', () => {
    for (const s of [
      'Google SwiftShader',
      'SwiftShader Device (Subzero)',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Mesa softpipe',
      'Software Rasterizer',
      'Microsoft Basic Render Driver',
    ]) {
      expect(matchesSoftwareRenderer(s), s).toBe(true)
    }
  })

  it('does NOT match hardware GPUs', () => {
    for (const s of [
      'NVIDIA H200',
      'NVIDIA GeForce RTX 4090/PCIe/SSE2',
      'Apple M3 Max',
      'AMD Radeon Pro 5500M',
      'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)',
    ]) {
      expect(matchesSoftwareRenderer(s), s).toBe(false)
    }
  })

  it('is false for empty / nullish input', () => {
    expect(matchesSoftwareRenderer('')).toBe(false)
    expect(matchesSoftwareRenderer(null)).toBe(false)
    expect(matchesSoftwareRenderer(undefined)).toBe(false)
  })
})

// A fake WebGL context exposing the debug-renderer-info extension + getParameter.
function fakeGl(renderer: string, opts: { withExt?: boolean } = {}): unknown {
  const UNMASKED = 0x9246
  const GL_RENDERER = 0x1f01
  const withExt = opts.withExt ?? true
  return {
    getExtension(name: string) {
      if (name === 'WEBGL_debug_renderer_info' && withExt) {
        return { UNMASKED_RENDERER_WEBGL: UNMASKED }
      }
      return null
    },
    getParameter(pname: number) {
      if (pname === UNMASKED && withExt) return renderer
      if (pname === GL_RENDERER) return withExt ? 'MASKED' : renderer
      return null
    },
  }
}

describe('readRendererString', () => {
  it('reads the UNMASKED renderer from a WebGL context', () => {
    expect(readRendererString(fakeGl('Google SwiftShader'))).toBe('Google SwiftShader')
  })

  it('falls back to plain RENDERER when the debug extension is absent', () => {
    expect(readRendererString(fakeGl('llvmpipe', { withExt: false }))).toBe('llvmpipe')
  })

  it('reads vendor+renderer from a luma Device .info', () => {
    const dev = { info: { vendor: 'Google Inc.', renderer: 'SwiftShader' } }
    expect(readRendererString(dev)).toBe('Google Inc. SwiftShader')
  })

  it('returns null for a non-graphics object', () => {
    expect(readRendererString({ foo: 1 })).toBe(null)
    expect(readRendererString(null)).toBe(null)
  })
})

describe('isSoftwareRenderer', () => {
  it('true for a SwiftShader / llvmpipe context', () => {
    expect(isSoftwareRenderer(fakeGl('Google SwiftShader'))).toBe(true)
    expect(isSoftwareRenderer(fakeGl('llvmpipe (LLVM 15)', { withExt: false }))).toBe(true)
  })

  it('false for a hardware GPU context', () => {
    expect(isSoftwareRenderer(fakeGl('NVIDIA H200'))).toBe(false)
  })

  it('false for a luma Device reporting a hardware renderer', () => {
    expect(isSoftwareRenderer({ info: { renderer: 'NVIDIA H200' } })).toBe(false)
  })

  it('true for a luma Device reporting SwiftShader', () => {
    expect(isSoftwareRenderer({ info: { renderer: 'SwiftShader' } })).toBe(true)
  })

  it('falls back to !float-renderable for a Device without a readable string', () => {
    // no `.info` string, but a `.features` set lacking float-renderable → software-class
    const noFloat = { features: new Set<string>() } as unknown
    expect(isSoftwareRenderer(noFloat)).toBe(true)
    const floatOk = { features: new Set(['float32-renderable-webgl']) } as unknown
    expect(isSoftwareRenderer(floatOk)).toBe(false)
  })
})

describe('resolveCpuRasterMode', () => {
  it('override wins over auto in both directions', () => {
    expect(resolveCpuRasterMode({ auto: false, override: true })).toBe(true)
    expect(resolveCpuRasterMode({ auto: true, override: false })).toBe(false)
  })

  it('defers to auto when override is null/undefined', () => {
    expect(resolveCpuRasterMode({ auto: true })).toBe(true)
    expect(resolveCpuRasterMode({ auto: false })).toBe(false)
    expect(resolveCpuRasterMode({ auto: true, override: null })).toBe(true)
    expect(resolveCpuRasterMode({ auto: false, override: undefined })).toBe(false)
  })

  describe('size-based upgrade on a hardware GPU', () => {
    it('does NOT engage below the default threshold', () => {
      expect(resolveCpuRasterMode({ auto: false, pointCount: 1_999_999 })).toBe(false)
      expect(resolveCpuRasterMode({ auto: false, pointCount: 100_000 })).toBe(false)
    })

    it('engages at/above the default 2M threshold', () => {
      expect(resolveCpuRasterMode({ auto: false, pointCount: DEFAULT_RASTER_POINT_THRESHOLD })).toBe(true)
      expect(resolveCpuRasterMode({ auto: false, pointCount: 10_000_000 })).toBe(true)
    })

    it('is skipped entirely when pointCount is omitted (back-compat)', () => {
      expect(resolveCpuRasterMode({ auto: false })).toBe(false)
    })

    it('honors a custom threshold; Infinity disables the size gate', () => {
      expect(resolveCpuRasterMode({ auto: false, pointCount: 600_000, pointThreshold: 500_000 })).toBe(true)
      expect(resolveCpuRasterMode({ auto: false, pointCount: 50_000_000, pointThreshold: Infinity })).toBe(false)
    })

    it('override:false keeps GL points even at huge N; software still wins', () => {
      expect(resolveCpuRasterMode({ auto: false, override: false, pointCount: 50_000_000 })).toBe(false)
      // a software renderer rasters regardless of a sub-threshold N
      expect(resolveCpuRasterMode({ auto: true, pointCount: 1_000 })).toBe(true)
    })
  })
})
