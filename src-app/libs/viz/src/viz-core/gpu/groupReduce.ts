// groupReduce.ts — a reusable GPU SEGMENTED-REDUCTION primitive (DEC-26/29). The
// per-point aggregations that today loop over ALL N points on the CPU
// (`dotplotMatrix` / `heatmapMatrix` / `proportions` / `computeCentroids`) reduce to
// the same shape: for each GROUP g, accumulate { sum, nonzero, count } over the points
// whose `code == g`. This module runs that reduction on the GPU via the classic WebGL2
// additive-blend-into-framebuffer HISTOGRAM technique, with a CPU oracle that is the
// parity reference (mirroring how color.ts is the oracle for ColormapScatterLayer).
//
// HOW THE GPU PATH WORKS (luma.gl v9 / WebGL2):
//   • render N points as GL_POINTS (topology 'point-list', gl_PointSize = 1.0) into an
//     `nGroups × 1` RGBA32F framebuffer;
//   • each point's clip-x maps its `code` to the CENTER of column `code`:
//         x = (code + 0.5) / nGroups * 2 - 1        (clip-y fixed at 0 → the 1px row);
//   • the fragment outputs  vec4(value, value > 0 ? 1 : 0, 1, value*value);
//   • BLEND is additive (srcFactor 'one', dstFactor 'one', op 'add') so overlapping
//     points at the same column ACCUMULATE — r = Σvalue, g = Σ(value>0), b = Σ1 = count,
//     a = Σvalue² (the formerly-unused Alpha channel — DEC-26/29);
//   • readback the nGroups texels → per group { sum, nonzero, count, sumSq }.
// From the result: mean = sum/count, fraction-expressing = nonzero/count, and EXACT
// population variance = sumSq/count − mean² (→ SD). The Alpha addition does NOT perturb
// the r/g/b channels: they blend independently, so sum/nonzero/count stay byte-identical.
//
// The GPU path only runs in a browser (needs a real WebGL2 device + float-blend); the
// node/vitest suite covers the CPU oracle + the input/output SHAPES. The orchestrator's
// browser harness calls `verifyGroupReduceParity(device)` (exposed on `window`) to prove
// GPU == CPU on a real context. Mirrors DEC-27 (CPU parity oracle + e2e GPU render).

import type { Device } from '@luma.gl/core'
import { Model } from '@luma.gl/engine'
import { resolveComputeBackend } from './computeDevice'

// ── Public shapes ────────────────────────────────────────────────────────────

/** One value column + the per-point group code + the group cardinality. */
export interface GroupReduceInput {
  /** per-point scalar value, length N. */
  readonly values: Float32Array
  /** per-point group index (0..nGroups-1), length N. Out-of-range points are ignored. */
  readonly codes: Uint16Array
  /** number of groups (columns of the histogram). */
  readonly nGroups: number
}

/**
 * Per-group reduction, each array length `nGroups`:
 * `sum[g]` = Σ value, `nonzero[g]` = count of value>0, `count[g]` = number of points,
 * `sumSq[g]` = Σ value² (the RGBA target's previously-unused Alpha channel — DEC-26/29).
 * Derive mean = sum/count, fraction = nonzero/count, and EXACT population variance =
 * sumSq/count − mean² (→ SD) at the call site (see `charts/groupStatsGpu.ts`).
 */
export interface GroupReduceResult {
  readonly sum: Float32Array
  readonly nonzero: Float32Array
  readonly count: Float32Array
  readonly sumSq: Float32Array
}

/**
 * Per-group MIN/MAX reduction, each array length `nGroups`. Empty groups carry the
 * sentinel `min[g] = +Infinity`, `max[g] = −Infinity` (so `min > max` unambiguously flags
 * "no finite points" — the caller then routes that group to its exact scalar path). Non-finite
 * inputs are skipped (they never widen a group's extent). This is the per-group DOMAIN source
 * for the box-plot per-group binning (`charts/groupStatsGpu.ts`): binning each group over its
 * OWN [min,max] instead of the whole column's global extent stops a heavy-tail outlier in one
 * group from collapsing every OTHER group's box to a bin-0 sliver.
 */
export interface GroupMinMaxResult {
  /** per-group finite minimum; `+Infinity` for an empty group. */
  readonly min: Float32Array
  /** per-group finite maximum; `−Infinity` for an empty group. */
  readonly max: Float32Array
}

// ── CPU oracle (the parity reference — DEC-27) ───────────────────────────────

/**
 * The correctness reference: a plain scalar segmented reduction. Accumulates in float64
 * (like the existing `dotplotMatrix`) for accuracy, then narrows to Float32Array so the
 * returned shape matches the GPU readback exactly. This is the oracle the unit tests and
 * `verifyGroupReduceParity` compare the GPU path against.
 */
export function cpuGroupReduce(
  values: Float32Array,
  codes: Uint16Array,
  nGroups: number,
): GroupReduceResult {
  const sum = new Float64Array(nGroups)
  const nonzero = new Float64Array(nGroups)
  const count = new Float64Array(nGroups)
  const sumSq = new Float64Array(nGroups)
  const n = Math.min(values.length, codes.length)
  for (let i = 0; i < n; i++) {
    const g = codes[i]
    if (g >= nGroups) continue // ignore out-of-range codes (mirrors GPU clip-cull)
    const v = values[i]
    sum[g] += v
    if (v > 0) nonzero[g] += 1
    count[g] += 1
    sumSq[g] += v * v
  }
  return {
    sum: Float32Array.from(sum),
    nonzero: Float32Array.from(nonzero),
    count: Float32Array.from(count),
    sumSq: Float32Array.from(sumSq),
  }
}

/** CPU oracle for M value columns sharing one `codes`/`nGroups` (dotplot = genes × G). */
export function cpuGroupReduceMulti(
  valueColumns: readonly Float32Array[],
  codes: Uint16Array,
  nGroups: number,
): GroupReduceResult[] {
  return valueColumns.map(values => cpuGroupReduce(values, codes, nGroups))
}

/**
 * CPU oracle / no-device fallback for the per-group MIN/MAX reduction. Empty groups keep the
 * `+Inf / −Inf` sentinels; out-of-range codes and non-finite values are skipped (mirroring
 * the GPU clip-cull + the scalar-path finite filter). This is the parity reference for
 * {@link runGroupMinMaxOnDevice}, and the device-free box-plot per-group binning uses it
 * directly (`charts/groupStatsGpu.ts::boxStatsFromColumnBinnedPerGroup`).
 */
export function cpuGroupMinMax(
  values: ArrayLike<number>,
  codes: ArrayLike<number>,
  nGroups: number,
): GroupMinMaxResult {
  const min = new Float32Array(Math.max(0, nGroups)).fill(Infinity)
  const max = new Float32Array(Math.max(0, nGroups)).fill(-Infinity)
  const n = Math.min(values.length, codes.length)
  for (let i = 0; i < n; i++) {
    const g = codes[i]
    if (g < 0 || g >= nGroups) continue
    const v = values[i]
    if (!Number.isFinite(v)) continue
    if (v < min[g]) min[g] = v
    if (v > max[g]) max[g] = v
  }
  return { min, max }
}

// ── GPU shaders ──────────────────────────────────────────────────────────────

/**
 * Vertex shader: place one GL_POINT per input point at the center of its group's column.
 * `aCode` is uploaded as float32 (a uint16 code is exactly representable in f32), and
 * points whose code is out of [0,nGroups) are pushed outside clip space so they are
 * culled (matches the CPU oracle's out-of-range skip).
 */
const REDUCE_VS = /* glsl */ `\
#version 300 es
in float aValue;
in float aCode;
uniform float uNGroups;
out float vValue;
void main() {
  vValue = aValue;
  if (aCode < 0.0 || aCode >= uNGroups) {
    // cull: park off-screen so it lands in no column
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float x = (aCode + 0.5) / uNGroups * 2.0 - 1.0;
  gl_Position = vec4(x, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`

/**
 * Fragment shader: emit (value, value>0 ? 1 : 0, 1, value²). Additive blend turns the four
 * channels into (Σvalue, Σnonzero, Σcount, Σvalue²) per column. The Alpha channel (Σvalue²)
 * is what lets the caller derive EXACT per-group variance/SD; it blends independently of the
 * r/g/b channels so sum/nonzero/count are byte-identical to the pre-Alpha version.
 */
const REDUCE_FS = /* glsl */ `\
#version 300 es
precision highp float;
in float vValue;
out vec4 fragColor;
void main() {
  fragColor = vec4(vValue, vValue > 0.0 ? 1.0 : 0.0, 1.0, vValue * vValue);
}
`

// ACCUMULATOR NOTE (WebGPU seam — Phase 4): the `count` channel is INTEGER counts (Σ1)
// and the `nonzero` channel is an integer tally (Σ[value>0]); both port directly to a
// WGSL `atomic<i32>` bin (WGSL has no `atomic<f32>`). The `sum`/`sumSq` channels are
// WEIGHTED float accumulations — on a future WebGPU compute kernel they would take a
// fixed-point path (multiply→round→i32 atomicAdd→divide, since WGSL has no `atomic<f32>`).
// Nothing here needs that today; the WebGL2 additive-blend path below accumulates in float
// and its results are unchanged.

/** WebGL2 device features the GPU histogram path needs (render-to + blend float32). */
const FLOAT_RENDERABLE: string = 'float32-renderable-webgl'
const FLOAT_BLENDABLE_WEBGL: string = 'texture-blend-float-webgl'
const FLOAT_BLENDABLE_WEBGPU: string = 'float32-blendable'

/** True when the device can render into AND additively blend an RGBA32F target. */
export function deviceSupportsGroupReduce(device: Device): boolean {
  const f = device.features
  const renderable = f.has(FLOAT_RENDERABLE as never) || f.has(FLOAT_BLENDABLE_WEBGPU as never)
  const blendable =
    f.has(FLOAT_BLENDABLE_WEBGL as never) || f.has(FLOAT_BLENDABLE_WEBGPU as never)
  return renderable && blendable
}

// ── GPU reduction ────────────────────────────────────────────────────────────

/**
 * Additive-blend histogram reducer. Builds the `nGroups × 1` RGBA32F framebuffer + the
 * point-list Model ONCE, and can reduce many value columns against the same `codes`
 * (the dotplot genes × G case) by swapping only the value buffer. Call `destroy()` when
 * done. Browser-only (needs a real WebGL2 device with float-blend).
 */
class GroupReducer {
  readonly device: Device
  readonly nGroups: number
  readonly count: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private target: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private framebuffer: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private codeBuffer: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private valueBuffer: any
  private model: Model

  constructor(device: Device, codes: Uint16Array, nGroups: number) {
    this.device = device
    this.nGroups = nGroups
    this.count = codes.length

    // RGBA32F render target, nGroups × 1.
    this.target = device.createTexture({
      format: 'rgba32float',
      width: Math.max(nGroups, 1),
      height: 1,
      sampler: { minFilter: 'nearest', magFilter: 'nearest' },
    })
    this.framebuffer = device.createFramebuffer({
      width: Math.max(nGroups, 1),
      height: 1,
      colorAttachments: [this.target],
    })

    // codes → float32 attribute buffer (uint16 is exactly representable in f32).
    const codeF32 = Float32Array.from(codes)
    this.codeBuffer = device.createBuffer({ data: codeF32 })
    // value buffer is (re)filled per column; allocate a zeroed one up front.
    this.valueBuffer = device.createBuffer({ data: new Float32Array(codes.length) })

    this.model = new Model(device, {
      vs: REDUCE_VS,
      fs: REDUCE_FS,
      topology: 'point-list',
      vertexCount: codes.length,
      bufferLayout: [
        { name: 'aValue', format: 'float32' },
        { name: 'aCode', format: 'float32' },
      ],
      attributes: { aValue: this.valueBuffer, aCode: this.codeBuffer },
      // uNGroups is fixed for this reducer's lifetime (WebGL-only classic uniform).
      uniforms: { uNGroups: nGroups },
      parameters: {
        blend: true,
        blendColorOperation: 'add',
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one',
        blendAlphaOperation: 'add',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one',
        depthWriteEnabled: false,
        depthCompare: 'always',
      },
    })
  }

  /** Reduce one value column → per-group { sum, nonzero, count }. */
  reduce(values: Float32Array): GroupReduceResult {
    // Upload the column, point the model at it, additively blend into a cleared target.
    this.valueBuffer.write(values)
    this.model.setAttributes({ aValue: this.valueBuffer, aCode: this.codeBuffer })

    const renderPass = this.device.beginRenderPass({
      framebuffer: this.framebuffer,
      clearColor: [0, 0, 0, 0],
    })
    this.model.draw(renderPass)
    renderPass.end()

    return this.readback()
  }

  /** Read the nGroups RGBA32F texels back into typed arrays. */
  private readback(): GroupReduceResult {
    const width = Math.max(this.nGroups, 1)
    const rgba = new Float32Array(width * 4)
    // luma.gl v9 keeps the WebGL fast-path readback as `readPixelsToArrayWebGL`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dev = this.device as any
    if (typeof dev.readPixelsToArrayWebGL === 'function') {
      dev.readPixelsToArrayWebGL(this.framebuffer, { target: rgba })
    } else if (typeof dev.readPixels === 'function') {
      dev.readPixels(this.framebuffer, { target: rgba })
    } else {
      throw new Error('groupReduce: device exposes no framebuffer readback method')
    }

    const sum = new Float32Array(this.nGroups)
    const nonzero = new Float32Array(this.nGroups)
    const cnt = new Float32Array(this.nGroups)
    const sumSq = new Float32Array(this.nGroups)
    for (let g = 0; g < this.nGroups; g++) {
      sum[g] = rgba[g * 4]
      nonzero[g] = rgba[g * 4 + 1]
      cnt[g] = rgba[g * 4 + 2]
      sumSq[g] = rgba[g * 4 + 3]
    }
    return { sum, nonzero, count: cnt, sumSq }
  }

  destroy(): void {
    this.model.destroy()
    this.framebuffer?.destroy?.()
    this.target?.destroy?.()
    this.codeBuffer?.destroy?.()
    this.valueBuffer?.destroy?.()
  }
}

/**
 * GPU path for a SINGLE value column. Async to mirror the eventual WebGPU compute path
 * (readback there is a promise); the WebGL2 readback is synchronous under the hood.
 */
export async function runGroupReduceOnDevice(
  device: Device,
  input: GroupReduceInput,
): Promise<GroupReduceResult> {
  const reducer = new GroupReducer(device, input.codes, input.nGroups)
  try {
    return reducer.reduce(input.values)
  } finally {
    reducer.destroy()
  }
}

/**
 * GPU path for M value columns sharing one `codes`/`nGroups` (dotplot genes × G). Builds
 * the target + code buffer ONCE and loops the reduction, swapping only the value buffer.
 */
export async function runGroupReduceMultiOnDevice(
  device: Device,
  valueColumns: readonly Float32Array[],
  codes: Uint16Array,
  nGroups: number,
): Promise<GroupReduceResult[]> {
  const reducer = new GroupReducer(device, codes, nGroups)
  try {
    return valueColumns.map(values => reducer.reduce(values))
  } finally {
    reducer.destroy()
  }
}

// ── GPU MIN/MAX reduction (per-group extent via min/max blend equation) ───────

/**
 * Fragment shader for the min/max passes: emit the raw value in every channel. Unlike the
 * additive reducer's `add` blend, the min/max reducer sets `blendColorOperation` to `'min'`
 * / `'max'` (WebGL2 `MIN` / `MAX`), so overlapping points at the same column collapse to the
 * per-group extremum instead of summing. The framebuffer is CLEARED to the identity of the
 * op (`+Inf` for min, `−Inf` for max), so an empty column stays at the sentinel.
 */
const MINMAX_FS = /* glsl */ `\
#version 300 es
precision highp float;
in float vValue;
out vec4 fragColor;
void main() {
  fragColor = vec4(vValue, vValue, vValue, vValue);
}
`

/**
 * Per-group MIN + MAX via two min/max-blend passes into two RGBA32F targets, sharing ONE
 * code + value buffer + the reducer's cull-VS. Browser-only (needs float render + the
 * min/max blend equation). `destroy()` frees GPU resources.
 */
class GroupMinMaxReducer {
  readonly device: Device
  readonly nGroups: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private minTarget: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private maxTarget: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private minFb: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private maxFb: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private codeBuffer: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private valueBuffer: any
  private minModel: Model
  private maxModel: Model

  constructor(device: Device, codes: Uint16Array, nGroups: number) {
    this.device = device
    this.nGroups = nGroups
    const width = Math.max(nGroups, 1)

    this.minTarget = device.createTexture({
      format: 'rgba32float',
      width,
      height: 1,
      sampler: { minFilter: 'nearest', magFilter: 'nearest' },
    })
    this.maxTarget = device.createTexture({
      format: 'rgba32float',
      width,
      height: 1,
      sampler: { minFilter: 'nearest', magFilter: 'nearest' },
    })
    this.minFb = device.createFramebuffer({ width, height: 1, colorAttachments: [this.minTarget] })
    this.maxFb = device.createFramebuffer({ width, height: 1, colorAttachments: [this.maxTarget] })

    this.codeBuffer = device.createBuffer({ data: Float32Array.from(codes) })
    this.valueBuffer = device.createBuffer({ data: new Float32Array(codes.length) })

    const mk = (op: 'min' | 'max') =>
      new Model(device, {
        vs: REDUCE_VS,
        fs: MINMAX_FS,
        topology: 'point-list',
        vertexCount: codes.length,
        bufferLayout: [
          { name: 'aValue', format: 'float32' },
          { name: 'aCode', format: 'float32' },
        ],
        attributes: { aValue: this.valueBuffer, aCode: this.codeBuffer },
        uniforms: { uNGroups: nGroups },
        parameters: {
          blend: true,
          blendColorOperation: op,
          blendColorSrcFactor: 'one',
          blendColorDstFactor: 'one',
          blendAlphaOperation: op,
          blendAlphaSrcFactor: 'one',
          blendAlphaDstFactor: 'one',
          depthWriteEnabled: false,
          depthCompare: 'always',
        },
      })
    this.minModel = mk('min')
    this.maxModel = mk('max')
  }

  reduce(values: Float32Array): GroupMinMaxResult {
    this.valueBuffer.write(values)
    this.minModel.setAttributes({ aValue: this.valueBuffer, aCode: this.codeBuffer })
    this.maxModel.setAttributes({ aValue: this.valueBuffer, aCode: this.codeBuffer })

    // Clear to the blend-op identity: +Inf for min, −Inf for max → an empty column stays there.
    const minPass = this.device.beginRenderPass({
      framebuffer: this.minFb,
      clearColor: [Infinity, Infinity, Infinity, Infinity],
    })
    this.minModel.draw(minPass)
    minPass.end()

    const maxPass = this.device.beginRenderPass({
      framebuffer: this.maxFb,
      clearColor: [-Infinity, -Infinity, -Infinity, -Infinity],
    })
    this.maxModel.draw(maxPass)
    maxPass.end()

    return { min: this.readChannel(this.minFb), max: this.readChannel(this.maxFb) }
  }

  /** Read texel.R for each of the nGroups columns. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readChannel(fb: any): Float32Array {
    const width = Math.max(this.nGroups, 1)
    const rgba = new Float32Array(width * 4)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dev = this.device as any
    if (typeof dev.readPixelsToArrayWebGL === 'function') {
      dev.readPixelsToArrayWebGL(fb, { target: rgba })
    } else if (typeof dev.readPixels === 'function') {
      dev.readPixels(fb, { target: rgba })
    } else {
      throw new Error('groupMinMax: device exposes no framebuffer readback method')
    }
    const out = new Float32Array(this.nGroups)
    for (let g = 0; g < this.nGroups; g++) out[g] = rgba[g * 4]
    return out
  }

  destroy(): void {
    this.minModel.destroy()
    this.maxModel.destroy()
    this.minFb?.destroy?.()
    this.maxFb?.destroy?.()
    this.minTarget?.destroy?.()
    this.maxTarget?.destroy?.()
    this.codeBuffer?.destroy?.()
    this.valueBuffer?.destroy?.()
  }
}

/**
 * GPU per-group MIN/MAX (browser-only). Non-finite values are culled by pushing their code
 * out of range (so they never widen an extent — matches {@link cpuGroupMinMax}). Async to
 * mirror the eventual WebGPU compute path; the WebGL2 readback is synchronous under the hood.
 */
export async function runGroupMinMaxOnDevice(
  device: Device,
  input: GroupReduceInput,
): Promise<GroupMinMaxResult> {
  const { values, codes, nGroups } = input
  const safeCodes = Uint16Array.from(codes)
  for (let i = 0; i < safeCodes.length; i++) {
    if (i >= values.length || !Number.isFinite(values[i])) safeCodes[i] = nGroups // out of range → culled
  }
  const reducer = new GroupMinMaxReducer(device, safeCodes, nGroups)
  try {
    return reducer.reduce(values)
  } finally {
    reducer.destroy()
  }
}

// ── Top-level dispatch (GPU when a device is passed, else the CPU oracle) ─────

/**
 * Segmented reduction dispatched over the {@link ComputeBackend} seam (Phase 4). Runs
 * on the GPU when a WebGL2 `device` (with float-blend) is passed, else falls back to
 * the CPU oracle. The single call site that runs GPU in the browser and CPU in a node
 * unit test (DEC-26's compute seam).
 *
 * The three arms are BYTE-IDENTICAL in selection to the pre-seam `if (device &&
 * deviceSupportsGroupReduce(device))` form: the `webgl2` arm still gates the real GPU
 * run on `deviceSupportsGroupReduce`, so a non-float-capable device degrades to CPU
 * exactly as before. The `webgpu` arm is compiled in but UNREACHABLE today —
 * `resolveComputeBackend` only returns `'webgpu'` for a registered WebGPU device, and
 * none is (no `@luma.gl/webgpu` dependency). If such a device ever appears it falls
 * through to the WebGL2 kernel when it supports float-blend (a WebGPU device advertises
 * `float32-blendable`), otherwise to CPU — never a hard failure.
 */
export async function groupReduce(
  input: GroupReduceInput,
  device?: Device,
): Promise<GroupReduceResult> {
  const backend = resolveComputeBackend(device)
  if (
    (backend === 'webgl2' || backend === 'webgpu') &&
    device &&
    deviceSupportsGroupReduce(device)
  ) {
    return runGroupReduceOnDevice(device, input)
  }
  return cpuGroupReduce(input.values, input.codes, input.nGroups)
}

/** M-column segmented reduction (dotplot). GPU when a capable device is passed, else CPU. */
export async function groupReduceMulti(
  valueColumns: readonly Float32Array[],
  codes: Uint16Array,
  nGroups: number,
  device?: Device,
): Promise<GroupReduceResult[]> {
  const backend = resolveComputeBackend(device)
  if (
    (backend === 'webgl2' || backend === 'webgpu') &&
    device &&
    deviceSupportsGroupReduce(device)
  ) {
    return runGroupReduceMultiOnDevice(device, valueColumns, codes, nGroups)
  }
  return cpuGroupReduceMulti(valueColumns, codes, nGroups)
}

// ── Parity verification (browser harness hook — DEC-27) ──────────────────────

export interface GroupReduceParityReport {
  /** max |GPU − CPU| across sum/nonzero/count over the fixture. */
  readonly maxAbsError: number
  /** true when maxAbsError is within tolerance (float32 accumulation slack). */
  readonly ok: boolean
  /** the tolerance used. */
  readonly tolerance: number
}

/** Small deterministic fixture: N points, `nGroups` groups, mixed zero / non-zero. */
function parityFixture(): { input: GroupReduceInput } {
  const nGroups = 5
  const n = 500
  const values = new Float32Array(n)
  const codes = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    codes[i] = i % nGroups
    // deterministic mix: every 3rd point is exactly zero (exercises the nonzero channel)
    values[i] = i % 3 === 0 ? 0 : ((i * 7) % 13) + 0.5
  }
  return { input: { values, codes, nGroups } }
}

/**
 * Build the fixture, run BOTH the GPU path and the CPU oracle on the passed device, and
 * return the max absolute error. The orchestrator's browser harness exposes this on
 * `window` (e.g. `window.__VIZ_TEST__.verifyGroupReduceParity`) so a headless WebGL run
 * proves GPU == CPU (DEC-27: GPU behavior is proven by running it, not the oracle alone).
 */
export async function verifyGroupReduceParity(
  device: Device,
): Promise<GroupReduceParityReport> {
  const tolerance = 1e-3
  const { input } = parityFixture()
  const cpu = cpuGroupReduce(input.values, input.codes, input.nGroups)
  const gpu = await runGroupReduceOnDevice(device, input)

  let maxAbsError = 0
  const bump = (a: Float32Array, b: Float32Array) => {
    for (let i = 0; i < a.length; i++) {
      const e = Math.abs(a[i] - b[i])
      if (e > maxAbsError) maxAbsError = e
    }
  }
  bump(cpu.sum, gpu.sum)
  bump(cpu.nonzero, gpu.nonzero)
  bump(cpu.count, gpu.count)

  return { maxAbsError, ok: maxAbsError <= tolerance, tolerance }
}
