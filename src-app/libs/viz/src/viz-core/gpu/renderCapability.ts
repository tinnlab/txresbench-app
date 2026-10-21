// renderCapability.ts — the A4 render-capability probe for the CPU-raster fast path
// (PERFORMANCE_PLAN.md Phase 1). A SOFTWARE WebGL backend (SwiftShader / llvmpipe /
// Mesa software / Microsoft Basic Render) draws N GL_POINTS at an enormous per-point
// constant, so a dense scatter that is smooth on a hardware GPU collapses to <1fps. The
// bin-then-shade raster (density/cpuRaster.ts) draws ONE textured quad instead — O(pixels),
// N-independent — which is only worth swapping IN when the renderer is actually software.
//
// This module is the pure DECISION core (no React / deck.gl / DOM): given a WebGL context OR
// a luma `Device`, extract the renderer string and match it; and given `{auto, override}`,
// decide whether the raster path is active. `auto` is "software detected"; a manual `override`
// (a boolean) always wins — the e2e harness is ITSELF SwiftShader, so a story/spec forces the
// mode deterministically rather than depending on the ambient auto result.

import type { Device } from '@luma.gl/core'
import { deviceSupportsDensify } from './densifyGpu'

/**
 * Renderer strings that denote a SOFTWARE rasterizer (no hardware GPU). Matched
 * case-insensitively against `UNMASKED_RENDERER_WEBGL` (or the plain `RENDERER`). Covers the
 * common headless/CI + fallback backends: Google SwiftShader, Mesa llvmpipe / softpipe /
 * "software rasterizer", and Windows' "Microsoft Basic Render Driver".
 */
const SOFTWARE_RENDERER_RE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i

/** Pure predicate: does a renderer string denote a software rasterizer? (unit-tested directly). */
export function matchesSoftwareRenderer(renderer: string | null | undefined): boolean {
  return typeof renderer === 'string' && SOFTWARE_RENDERER_RE.test(renderer)
}

/** A minimal WebGL-context shape (the subset this probe reads). */
interface GLLike {
  getParameter(pname: number): unknown
  getExtension(name: string): unknown
}

/** `RENDERER` GL enum (0x1F01) — the fallback when the debug-renderer-info extension is absent. */
const GL_RENDERER = 0x1f01

function isGlLike(t: unknown): t is GLLike {
  return (
    !!t &&
    typeof (t as GLLike).getParameter === 'function' &&
    typeof (t as GLLike).getExtension === 'function'
  )
}

/**
 * Extract the renderer string from a WebGL context or a luma `Device`. Returns `null` when no
 * string is readable (a Device that exposes no `.info`, a context whose driver masks the
 * renderer, or a non-graphics object). For a WebGL context it prefers the UNMASKED renderer
 * (via `WEBGL_debug_renderer_info`) and falls back to the plain `RENDERER` parameter.
 */
export function readRendererString(target: unknown): string | null {
  if (!target) return null

  // luma Device: `.info.renderer` / `.info.vendor` (populated at device creation).
  const dev = target as { info?: { renderer?: unknown; vendor?: unknown } }
  if (dev.info && (typeof dev.info.renderer === 'string' || typeof dev.info.vendor === 'string')) {
    const s = `${(dev.info.vendor as string) ?? ''} ${(dev.info.renderer as string) ?? ''}`.trim()
    return s.length > 0 ? s : null
  }

  // Raw WebGL(2) context.
  if (isGlLike(target)) {
    try {
      const ext = target.getExtension('WEBGL_debug_renderer_info') as
        | { UNMASKED_RENDERER_WEBGL?: number }
        | null
      if (ext && typeof ext.UNMASKED_RENDERER_WEBGL === 'number') {
        const r = target.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        if (typeof r === 'string' && r.length > 0) return r
      }
      const r2 = target.getParameter(GL_RENDERER)
      if (typeof r2 === 'string' && r2.length > 0) return r2
    } catch {
      /* driver refused a parameter read — treat as unknown */
    }
  }
  return null
}

/**
 * True when `target` (a WebGL context or a luma `Device`) is a SOFTWARE renderer. Primary
 * signal is the renderer string (`matchesSoftwareRenderer`). Secondary, ONLY when no string is
 * readable AND `target` is a luma Device: a device that cannot render into a float target
 * (`!deviceSupportsDensify`) also can't run the GPU density path, so the CPU raster is the
 * better route — treat it as software-class. A hardware GPU (readable "NVIDIA …" string,
 * float-renderable) returns `false`, keeping the default path unchanged.
 */
export function isSoftwareRenderer(target: unknown): boolean {
  const str = readRendererString(target)
  if (str != null) return matchesSoftwareRenderer(str)
  const dev = target as Device | null | undefined
  if (dev && typeof (dev as { features?: unknown }).features !== 'undefined') {
    return !deviceSupportsDensify(dev)
  }
  return false
}

/**
 * Default point count at/above which the raster path auto-engages EVEN on a hardware GPU.
 *
 * Calibrated for a NORMAL machine (integrated Intel Iris Xe / Apple M-base / an entry discrete
 * GPU like a GTX 1650) — NOT a workstation card. On such hardware the deck.gl `GL_POINTS` path is
 * realtime to ~1–2M points, then degrades: dropped frames on continuous pan/zoom, plus hundreds of
 * MB of GPU attribute buffers (deck allocates per-point position + color + *picking* buffers). A
 * high-end GPU (H200 here) hides this — it still does 10M points at ~22fps — so we must NOT
 * calibrate to the fast box. At/above this many points the density raster is BOTH safer on weak
 * hardware AND a more faithful read (a cloud this dense overdraws `GL_POINTS` into a saturated
 * blob). Below it, the point path keeps per-point picking, crisp anti-aliased markers, and instant
 * GPU-side zoom, so we keep it. Tune per call via `CpuRasterModeInput.pointThreshold`; pass
 * `Infinity` to disable the size gate entirely (software detection still applies).
 */
export const DEFAULT_RASTER_POINT_THRESHOLD = 2_000_000

/** Inputs to the CPU-raster-mode decision: an `auto` signal, an optional manual `override`, and an
 *  optional dataset size for the hardware-GPU size-based upgrade. */
export interface CpuRasterModeInput {
  /** "software detected" — the ambient auto result (from `isSoftwareRenderer`). */
  readonly auto: boolean
  /** a manual force ON/OFF (story toggle / deterministic tests). A boolean here WINS over both
   *  `auto` and the size gate — `override:false` keeps the GL point path even at huge N. */
  readonly override?: boolean | null
  /** the dataset point count; drives the size-based upgrade. Omit to disable the size gate. */
  readonly pointCount?: number
  /** point count at/above which raster engages on a hardware GPU (default
   *  {@link DEFAULT_RASTER_POINT_THRESHOLD}; `Infinity` disables the size gate). */
  readonly pointThreshold?: number
}

/**
 * Resolve whether the CPU-raster path is active. Precedence:
 *   1. a boolean `override` wins (story + SwiftShader e2e must force the mode deterministically);
 *   2. else `auto` (software renderer detected) — raster is the only thing that stays interactive;
 *   3. else the SIZE gate: `pointCount >= pointThreshold` (default 2M) upgrades to raster even on a
 *      hardware GPU, protecting a normal machine from the large-N `GL_POINTS` degradation.
 * `null`/`undefined` override defers to (2)+(3); an omitted `pointCount` skips (3).
 */
export function resolveCpuRasterMode(input: CpuRasterModeInput): boolean {
  if (typeof input.override === 'boolean') return input.override
  if (input.auto) return true
  const threshold = input.pointThreshold ?? DEFAULT_RASTER_POINT_THRESHOLD
  return typeof input.pointCount === 'number' && input.pointCount >= threshold
}

/** luma.gl device features that mean "can render into a float color target" — the capability
 *  ScreenGridLayer's GPU aggregation needs (it accumulates into a float texture and reads it back). */
const FLOAT_RENDERABLE_FEATURES = ['float32-renderable-webgl', 'float32-blendable'] as const

/**
 * BUG #6 gate: should `DensityView`'s `ScreenGridLayer` use `gpuAggregation`? The GPU path
 * accumulates counts into a FLOAT color target and reads it back; on software / weak GL that can't
 * render a float target the readback is empty and the grid draws BLANK. So gate on the device's
 * float-renderable capability (capability-gated, NOT renderer-name-gated):
 *   - a device advertising a {@link FLOAT_RENDERABLE_FEATURES} feature ⇒ `true` (unchanged on real
 *     GPUs — and on this box's SwiftShader, which does advertise `float32-renderable-webgl`);
 *   - a device lacking all of them ⇒ `false` (ScreenGridLayer falls back to CPU aggregation, which
 *     renders);
 *   - `null`/`undefined` (before `onDeviceInitialized` supplies the device) ⇒ `true`, the
 *     capable-GPU default; a software device flips it to `false` on that first callback, before a
 *     blank frame can persist.
 */
export function resolveDensityGpuAggregation(device: Device | null | undefined): boolean {
  if (!device) return true
  // `Device.features` is a Set-like `DeviceFeatures` (real luma) or a plain `Set<string>` (test
  // stub); both expose `.has(feature)`, so read it structurally rather than assuming either concrete
  // type.
  const features = (device as unknown as { features?: { has(f: string): boolean } }).features
  if (!features) return true
  return FLOAT_RENDERABLE_FEATURES.some(f => features.has(f))
}
