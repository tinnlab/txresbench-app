// computeDevice.ts — a lazy SINGLETON offscreen WebGL2 luma device used purely for
// COMPUTE (the segmented-reduction GPU path in `gpu/groupReduce.ts`, driven by the
// `charts/aggregateGpu.ts` variants). DEC-26: every per-point aggregation should run on
// the GPU; those kernels need a `Device`, but the chart VIEWS render onto their own deck
// canvases — a reduction shouldn't fight for (or depend on) a visible canvas' context.
//
// So this module owns ONE shared, headless, offscreen WebGL2 device created against a
// detached 1×1 <canvas>. It is:
//   • lazy — created on the first `getComputeDevice()` call, never at import time;
//   • a singleton — the promise is memoized, so N concurrent callers share ONE device
//     (creating a device per reduction would thrash GL contexts);
//   • browser-only — in node/SSR (no `document`) it resolves `null`, which every
//     `aggregateGpu` variant treats as "run the CPU oracle" (DEC-27 fallback).
//
// The GPU path itself is proven in the orchestrator's browser harness
// (`verifyAggregateParity`); node/vitest only ever sees the `null` → CPU fallback.

import { luma } from '@luma.gl/core'
import type { Device } from '@luma.gl/core'
import { webgl2Adapter } from '@luma.gl/webgl'

/** True only in a browser-like environment where an offscreen canvas can back a device. */
function inBrowser(): boolean {
  return typeof document !== 'undefined' && typeof document.createElement === 'function'
}

/**
 * Cheap synchronous capability probe: whether `getComputeDevice()` could plausibly
 * return a device. Callers can gate UI/telemetry on this without awaiting; the authoritative
 * answer is still the (possibly `null`) result of `getComputeDevice()`.
 */
export function computeAvailable(): boolean {
  return inBrowser()
}

// Memoized single-flight device promise (so parallel callers share ONE device).
let devicePromise: Promise<Device | null> | null = null

/**
 * The shared offscreen compute device. Resolves `null` when not in a browser or when
 * WebGL2 device creation fails (headless-CI-safe); callers then use the CPU oracle. The
 * promise is cached, so this is safe to call on every data load.
 */
export function getComputeDevice(): Promise<Device | null> {
  if (!inBrowser()) return Promise.resolve(null)
  if (!devicePromise) {
    devicePromise = (async () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const device = await luma.createDevice({
          type: 'webgl',
          adapters: [webgl2Adapter],
          createCanvasContext: { canvas },
        })
        return device ?? null
      } catch {
        // No WebGL2 (or blocked context) → signal "unavailable"; callers fall back to CPU.
        return null
      }
    })()
  }
  return devicePromise
}

/** Test/teardown hook: drop the memoized device so the next call re-creates it. */
export function __resetComputeDeviceForTest(): void {
  devicePromise = null
}

// ── Compute-backend seam (Phase 4 — WebGPU-ready, no runtime change today) ────
//
// The compute helpers (`gpu/groupReduce.ts`, `gpu/densifyGpu.ts`) dispatch over a
// small backend enum instead of an implicit "device-or-null" boolean. This is a
// PURE EXPRESSION of the existing dispatch — cpu / webgl2 arms are behaviourally
// identical to before; a `webgpu` arm is compiled in but is NEVER selected at
// runtime today because no WebGPU adapter is registered with luma (see
// `getComputeDevice` above: it only ever creates a `type: 'webgl'` device). The
// seam exists so that a future `luma.createDevice({ adapters: [webgpuAdapter] })`
// drops a WebGPU `Device` in with a one-line adapter registration — the enum
// already routes it (a WGSL compute kernel would be authored at that point). No
// `@luma.gl/webgpu` dependency is added by any of this.

/**
 * Which compute backend a `Device` maps to.
 *   • `'cpu'`    — no device (node/SSR/headless) → run the CPU oracle.
 *   • `'webgl2'` — the classic additive-blend-into-framebuffer histogram path
 *     (`runGroupReduceOnDevice` / `densifyOnDevice`). The only GPU path wired today.
 *   • `'webgpu'` — a WGSL compute-shader path. Compiled in but unreachable at
 *     runtime today (no WebGPU adapter registered ⇒ `resolveComputeBackend` never
 *     returns this). Reserved so a hardware-GPU WebGPU device drops in later.
 */
export type ComputeBackend = 'cpu' | 'webgl2' | 'webgpu'

/**
 * The subset of a luma `Device` this seam inspects: its backend `type` tag
 * (`'webgl' | 'webgpu' | 'null' | 'unknown'`). Kept structural so unit tests can
 * pass a `{ type }` stub without constructing a real GL device.
 */
type BackendTagged = { readonly type?: string }

/**
 * Map a (possibly absent) compute `Device` to its {@link ComputeBackend} family.
 * `webgpu` when the device is a luma WebGPU device (`device.type === 'webgpu'`);
 * `webgl2` when it is a WebGL2 device (`device.type === 'webgl'` — luma's single
 * GL backend is WebGL2); `cpu` otherwise (no device, or a `'null'`/`'unknown'`
 * device that can't run the GPU kernels).
 *
 * This chooses the backend FAMILY only; the per-helper capability probe
 * (`deviceSupportsGroupReduce` / `deviceSupportsDensify`) still gates whether the
 * chosen GPU arm actually runs or falls back to CPU — so a WebGL2 device lacking
 * float-renderable/blendable still degrades to the oracle exactly as before.
 */
export function resolveComputeBackend(device?: Device | BackendTagged | null): ComputeBackend {
  if (!device) return 'cpu'
  const type = (device as BackendTagged).type
  if (type === 'webgpu') return 'webgpu'
  if (type === 'webgl') return 'webgl2'
  return 'cpu'
}
