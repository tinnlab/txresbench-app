// densifyGpu.ts — a GPU SCATTER primitive that projects a sparse value column
// (`{row, value, length: N}`) into a dense `Float32Array[N]` on the GPU (DEC-26/27,
// ITEM-27). This is the GPU form of `data/wire.ts::densify`, which stays as the CPU
// PARITY ORACLE + fallback. Densify runs on every color-by-value switch and feeds the
// GPU colormap layer's per-point `getColorValue` attribute, so keeping the O(nnz) scatter
// off the JS main thread matters at 10M-point scale.
//
// HOW THE GPU PATH WORKS (luma.gl v9 / WebGL2 — mirrors gpu/groupReduce.ts):
//   • the dense output is a Float32Array[N] viewed as a 2D texel grid: an
//     `N`-wide-clamped RGBA32F framebuffer tiled to `width × height`, where
//     `width = min(N, MAX_WIDTH)` and `height = ceil(N / width)` (so N can exceed the
//     max texture dimension);
//   • render `nnz` points as GL_POINTS (topology 'point-list', gl_PointSize = 1.0). Each
//     point maps its `row` index to the CENTER of texel (tx, ty) where
//         tx = row mod width,  ty = floor(row / width),
//         clip.x = (tx + 0.5)/width  * 2 - 1,   clip.y = (ty + 0.5)/height * 2 - 1;
//   • the fragment outputs vec4(value, 0, 0, 1) — the R channel carries the value;
//   • BLEND IS DISABLED (plain write / REPLACE): rows are unique in a CSC column, so no
//     two points land on the same texel — the write is exact and needs only
//     `float32-renderable` (NOT float-blendable, unlike groupReduce's additive path);
//   • the framebuffer is cleared to 0 first, so every texel with no point stays 0 — the
//     sparse "0-default" (matches `densify`'s zero-initialised output);
//   • readback the width×height RGBA32F texels → dense[i] = texel(i).R for i in [0, N).
//
// Out-of-range guard: a `row >= N` point is culled in the vertex shader (parked outside
// clip space), mirroring `densify`'s behaviour exactly — a TypedArray out-of-bounds
// write (`dense[row] = value` when `row >= length`) is silently ignored in JS.
//
// PRECISION: `row` is uploaded as float32 (WebGL2 attributes have no u32 vertex-format on
// all impls); an integer index is EXACT in f32 up to 2^24 = 16,777,216. For N beyond that
// the tiling math (mod/floor) loses integer precision — 10M (the stated scale) is well
// under the ceiling; the CPU oracle has no such limit and remains the fallback.
//
// The GPU path only runs in a browser (needs a real WebGL2 device + float-renderable);
// node/vitest covers the CPU fallback (which IS the `densify` oracle) + the shapes. The
// orchestrator's browser harness calls `verifyDensifyParity(device)` to prove GPU == CPU
// on a real context (DEC-27: GPU behaviour is proven by running it, not the oracle alone).

import type { Device } from '@luma.gl/core'
import { Model } from '@luma.gl/engine'
import { densify, type SparseColumn } from '../data/wire'
import { resolveComputeBackend } from './computeDevice'

// ── CPU oracle (re-exported from wire.ts — the single parity reference) ───────

/** The CPU densify oracle (`data/wire.ts::densify`), re-exported for call-site clarity. */
export { densify } from '../data/wire'

// ── Capability probe ──────────────────────────────────────────────────────────

/** WebGL2 feature the GPU scatter needs: render INTO an RGBA32F target (no blend needed). */
const FLOAT_RENDERABLE_WEBGL: string = 'float32-renderable-webgl'
const FLOAT_BLENDABLE_WEBGPU: string = 'float32-blendable'

/**
 * True when the device can render into an RGBA32F target. Densify writes (blend disabled),
 * so — unlike groupReduce — it does NOT require float-BLENDABLE, only float-renderable.
 */
export function deviceSupportsDensify(device: Device): boolean {
  const f = device.features
  return f.has(FLOAT_RENDERABLE_WEBGL as never) || f.has(FLOAT_BLENDABLE_WEBGPU as never)
}

/**
 * Preferred max texel width per row before tiling to a second row. NOTE: this is the
 * DESIRED cap only — WebGL2 merely *guarantees* `MAX_TEXTURE_SIZE >= 2048`, so a real
 * device may support less than 16384. The GPU path therefore clamps the effective width to
 * the device's actual `maxTextureDimension2D` (see `deviceMaxWidth`); rendering into a
 * target wider than the device allows silently clamps the framebuffer, after which the
 * readback (which uses the nominal width) reads 0 past the real edge — the values in the
 * second tile row vanish. That was the parity bug: a 16384-wide strip exceeded the headless
 * device limit, so tile-1 texels read back as 0 (max error == the largest fixture value,
 * which happened to land in tile 1). groupReduce never caught it — its target is
 * `nGroups × 1`, always tiny and single-row.
 */
const MAX_WIDTH = 16384

/**
 * The effective max texel width for THIS device: the smaller of our preferred `MAX_WIDTH`
 * and the device's actual `maxTextureDimension2D`. Guards against creating a render target
 * wider than the device supports (which clamps the framebuffer and drops the outer texels).
 */
function deviceMaxWidth(device: Device): number {
  const lim = device.limits?.maxTextureDimension2D
  const max = typeof lim === 'number' && lim > 0 ? lim : 2048
  return Math.max(1, Math.min(MAX_WIDTH, max))
}

/**
 * Tiling for a dense length N: `width × height` texel grid, width clamped to `maxWidth`
 * (defaults to `MAX_WIDTH`; the GPU path passes the device's real 2D-texture limit so the
 * render target never exceeds what the device can allocate). The tiling math (col = r %
 * width, rowTile = floor(r / width)) is width-agnostic, so render + readback stay exact for
 * any clamped width as long as the SAME width feeds both — which it does (both read `this.width`).
 */
export function densifyTiling(
  length: number,
  maxWidth: number = MAX_WIDTH,
): { width: number; height: number } {
  if (length <= 0) return { width: 0, height: 0 }
  const width = Math.min(length, Math.max(1, maxWidth))
  const height = Math.ceil(length / width)
  return { width, height }
}

// ── GPU shaders ────────────────────────────────────────────────────────────────

/**
 * Vertex shader: place one GL_POINT per sparse entry at the center of its dense index's
 * texel. `aRow` is uploaded as float32 (exact for indices < 2^24). A row >= uLength is
 * pushed outside clip space so it is culled (matches `densify`'s silent out-of-range skip).
 */
const DENSIFY_VS = /* glsl */ `\
#version 300 es
in float aRow;
in float aValue;
uniform float uWidth;
uniform float uHeight;
uniform float uLength;
out float vValue;
void main() {
  vValue = aValue;
  if (aRow < 0.0 || aRow >= uLength) {
    // cull: park off-screen so it writes to no texel
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float tx = mod(aRow, uWidth);
  float ty = floor(aRow / uWidth);
  float x = (tx + 0.5) / uWidth * 2.0 - 1.0;
  float y = (ty + 0.5) / uHeight * 2.0 - 1.0;
  gl_Position = vec4(x, y, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

/** Fragment shader: write the value into the R channel (blend disabled → REPLACE). */
const DENSIFY_FS = /* glsl */ `\
#version 300 es
precision highp float;
in float vValue;
out vec4 fragColor;
void main() {
  fragColor = vec4(vValue, 0.0, 0.0, 1.0);
}
`

// ── GPU scatter ──────────────────────────────────────────────────────────────

/**
 * Render a sparse column into a dense RGBA32F texel grid and read back the R channel.
 * Browser-only (needs a real WebGL2 device with float-renderable). Call `destroy()` when
 * done (or use `densifyOnDevice`, which builds + tears down for a single call).
 */
class Densifier {
  readonly device: Device
  readonly length: number
  readonly width: number
  readonly height: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private target: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private framebuffer: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rowBuffer: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private valueBuffer: any
  private model: Model

  constructor(device: Device, sparse: SparseColumn) {
    this.device = device
    this.length = sparse.length
    // Clamp the strip width to what THIS device can actually allocate (WebGL2 only
    // guarantees 2048). A wider target would clamp the framebuffer and drop the outer
    // texels — the second-tile-row parity bug. Same width feeds render + readback.
    const { width, height } = densifyTiling(sparse.length, deviceMaxWidth(device))
    this.width = width
    this.height = height

    const w = Math.max(width, 1)
    const h = Math.max(height, 1)

    // RGBA32F render target, width × height (the dense grid).
    this.target = device.createTexture({
      format: 'rgba32float',
      width: w,
      height: h,
      sampler: { minFilter: 'nearest', magFilter: 'nearest' },
    })
    this.framebuffer = device.createFramebuffer({
      width: w,
      height: h,
      colorAttachments: [this.target],
    })

    // row + value attribute buffers (row → float32; exact for indices < 2^24).
    const rowF32 = Float32Array.from(sparse.row)
    this.rowBuffer = device.createBuffer({ data: rowF32 })
    this.valueBuffer = device.createBuffer({ data: sparse.value })

    this.model = new Model(device, {
      vs: DENSIFY_VS,
      fs: DENSIFY_FS,
      topology: 'point-list',
      vertexCount: sparse.row.length,
      bufferLayout: [
        { name: 'aRow', format: 'float32' },
        { name: 'aValue', format: 'float32' },
      ],
      attributes: { aRow: this.rowBuffer, aValue: this.valueBuffer },
      uniforms: { uWidth: w, uHeight: h, uLength: sparse.length },
      parameters: {
        // Blend DISABLED: unique rows → one point per texel → exact write (REPLACE).
        blend: false,
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    })
  }

  /** Render the scatter and read back the dense Float32Array[N]. */
  run(): Float32Array {
    // Mirror the byte-exact groupReduce path: (re)bind attributes immediately before the
    // draw (not only at construction), then REPLACE-render into a freshly-cleared target.
    this.model.setAttributes({ aRow: this.rowBuffer, aValue: this.valueBuffer })
    const renderPass = this.device.beginRenderPass({
      framebuffer: this.framebuffer,
      clearColor: [0, 0, 0, 0],
    })
    this.model.draw(renderPass)
    renderPass.end()
    return this.readback()
  }

  /** Read the width×height RGBA32F texels back and pack the R channel into dense[0..N). */
  private readback(): Float32Array {
    const w = Math.max(this.width, 1)
    const h = Math.max(this.height, 1)
    const rgba = new Float32Array(w * h * 4)
    // luma.gl v9 keeps the WebGL fast-path readback as `readPixelsToArrayWebGL`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dev = this.device as any
    if (typeof dev.readPixelsToArrayWebGL === 'function') {
      dev.readPixelsToArrayWebGL(this.framebuffer, { target: rgba })
    } else if (typeof dev.readPixels === 'function') {
      dev.readPixels(this.framebuffer, { target: rgba })
    } else {
      throw new Error('densify: device exposes no framebuffer readback method')
    }

    const dense = new Float32Array(this.length)
    for (let i = 0; i < this.length; i++) {
      dense[i] = rgba[i * 4] // R channel of texel i (row-major, matches the tiling math)
    }
    return dense
  }

  destroy(): void {
    this.model.destroy()
    this.framebuffer?.destroy?.()
    this.target?.destroy?.()
    this.rowBuffer?.destroy?.()
    this.valueBuffer?.destroy?.()
  }
}

/**
 * GPU densify for a single sparse column → dense `Float32Array[N]`. Async to mirror the
 * eventual WebGPU compute readback (a promise there; the WebGL2 readback is synchronous
 * under the hood). Short-circuits the empty cases without touching the GPU.
 */
export async function densifyOnDevice(
  device: Device,
  sparse: SparseColumn,
): Promise<Float32Array> {
  if (sparse.length <= 0) return new Float32Array(0)
  // No non-zero entries → the dense projection is all-zeros; no render needed.
  if (sparse.row.length === 0) return new Float32Array(sparse.length)
  const densifier = new Densifier(device, sparse)
  try {
    return densifier.run()
  } finally {
    densifier.destroy()
  }
}

// ── Top-level dispatch (GPU when a capable device is passed, else the CPU oracle) ─

/**
 * Project a sparse column into a dense `Float32Array[N]`, dispatched over the
 * {@link ComputeBackend} seam (Phase 4): runs on the GPU when a WebGL2 `device`
 * (float-renderable) is passed, else falls back to the CPU `densify` oracle. The single
 * call site that runs GPU in the browser and CPU in a node unit test (DEC-26/27).
 *
 * BYTE-IDENTICAL in selection to the pre-seam `if (device && deviceSupportsDensify(...))`
 * form: the `webgl2` arm still gates the real GPU run on `deviceSupportsDensify`, so a
 * non-float-renderable device degrades to CPU exactly as before. The `webgpu` arm is
 * compiled in but UNREACHABLE today (no WebGPU adapter registered ⇒ `resolveComputeBackend`
 * never returns `'webgpu'`, and no `@luma.gl/webgpu` dependency); it falls through to the
 * WebGL2 scatter when the (future) device is float-renderable, else to CPU.
 */
export async function densifyGpu(
  sparse: SparseColumn,
  device?: Device | null,
): Promise<Float32Array> {
  const backend = resolveComputeBackend(device)
  if ((backend === 'webgl2' || backend === 'webgpu') && device && deviceSupportsDensify(device)) {
    return densifyOnDevice(device, sparse)
  }
  return densify(sparse)
}

// ── Parity verification (browser harness hook — DEC-27) ──────────────────────

/** One diagnostic mismatch tuple (the dense index + the diverging GPU / CPU values). */
export interface DensifyParitySample {
  readonly row: number
  readonly gpu: number
  readonly cpu: number
}

export interface DensifyParityReport {
  /** max |GPU − CPU| across the dense output over the fixture. */
  readonly maxAbsError: number
  /** true when maxAbsError is within tolerance (exact write → effectively 0). */
  readonly ok: boolean
  /** the tolerance used. */
  readonly tolerance: number
  /**
   * The first few (row, gpu, cpu) tuples that exceed tolerance, to PINPOINT a failure
   * without a browser debugger: an all-zero `gpu` column ⇒ nothing rendered/read; a
   * tile-boundary row cluster (row ≥ width) ⇒ a tiling/second-row bug; swapped values ⇒
   * a y-flip. Empty when parity holds.
   */
  readonly samples: readonly DensifyParitySample[]
}

/**
 * Deterministic fixture that exercises the interesting cases in ONE column:
 *   • the 0-default (most indices absent → stay 0),
 *   • tiling (N > MAX_WIDTH so height > 1),
 *   • an out-of-range row (dropped, matching `densify`),
 *   • negative + fractional values (R32F round-trips them exactly).
 */
function parityFixture(): SparseColumn {
  const length = MAX_WIDTH + 2000 // forces height = 2 (tiled)
  const nnz = 777
  const row = new Uint32Array(nnz)
  const value = new Float32Array(nnz)
  for (let i = 0; i < nnz; i++) {
    // spread across both tiles; deterministic, unique, in-range indices
    row[i] = (i * 23) % length
    value[i] = i % 5 === 0 ? -(i + 0.25) : (i % 7) + 0.5
  }
  // one deliberately out-of-range row (must be ignored, like the CPU oracle)
  row[nnz - 1] = length + 42
  value[nnz - 1] = 999
  return { row, value, length }
}

/**
 * Build the fixture, run BOTH the GPU path and the CPU `densify` oracle on the passed
 * device, and return the max absolute error. The orchestrator's browser harness exposes
 * this on `window` so a headless WebGL run proves GPU == CPU (DEC-27).
 */
export async function verifyDensifyParity(device: Device): Promise<DensifyParityReport> {
  const tolerance = 1e-4
  const sparse = parityFixture()
  const cpu = densify(sparse)
  const gpu = await densifyOnDevice(device, sparse)

  let maxAbsError = 0
  const samples: DensifyParitySample[] = []
  const n = Math.min(cpu.length, gpu.length)
  for (let i = 0; i < n; i++) {
    const e = Math.abs(cpu[i] - gpu[i])
    if (e > maxAbsError) maxAbsError = e
    if (e > tolerance && samples.length < 6) {
      samples.push({ row: i, gpu: gpu[i], cpu: cpu[i] })
    }
  }
  // a length mismatch is a hard failure regardless of per-element error
  const lengthOk = cpu.length === gpu.length
  return { maxAbsError, ok: lengthOk && maxAbsError <= tolerance, tolerance, samples }
}
