// renderCapacity.ts — MEASURED, CACHED render-capacity probe (the machine-adaptive source for the
// raster-vs-points size threshold). The pure decision core (`resolveCpuRasterMode`) takes a
// `pointThreshold`; a FIXED default (2M) is the safe fallback. THIS module derives that threshold
// from the ACTUAL machine instead of a guess: a tiny offscreen WebGL2 point-throughput micro-bench
// classifies the GPU, converts throughput → a realtime point budget, and CACHES it in localStorage
// keyed by the renderer string so the cost is paid ONCE per machine/browser.
//
// WHY CLAMPED (critical): raw draw throughput measures pixel/vertex fill, NOT the interaction cost
// that actually degrades a large point cloud (deck's per-frame layer rebuild, per-point picking
// buffers, pan/zoom reprojection). A workstation GPU (e.g. an H200) benches as "tens of millions
// fine" and would push the threshold so high that 10M renders as points at ~22fps — WORSE than the
// flat-60fps raster. So the probe is primarily a FLOOR-LOWERING signal for weak hardware; it is
// clamped to [`PROBE_POINT_FLOOR`, `CAPACITY_CEILING`] so a fast box never disables raster where
// raster is the better read, and a weak box gets a low threshold.
//
// Layering: the PURE helpers (`rendererHash`, `capacityToThreshold`, cache-record validation, the
// injectable `resolveMachineThreshold`) are unit-tested without a GL context; the impure bits (the
// GL probe, `localStorage`) are dependency-injected so tests drive them deterministically.

import { DEFAULT_RASTER_POINT_THRESHOLD } from './renderCapability'

/** Never probe / never raster below this many points — the user-facing floor: small clouds always
 *  stay on the crisp, pickable GL point path. Also the lower clamp on any measured threshold. */
export const PROBE_POINT_FLOOR = 100_000

/** Upper clamp on a MEASURED threshold. Even if the machine benches enormous, we never let the
 *  auto-threshold exceed this — beyond it the density raster is the better experience regardless of
 *  raw GPU muscle (see the "WHY CLAMPED" note above). */
export const CAPACITY_CEILING = 5_000_000

/** Fraction of a 60fps frame (16.7ms) the point draw may consume and still be called "realtime".
 *  8ms leaves headroom for the rest of the frame (compositing, React, picking). */
export const FRAME_BUDGET_MS = 8

/** Bump to invalidate every cached record (probe method / clamp semantics changed). */
export const CAPACITY_SCHEMA_VERSION = 1

/** localStorage key for the cached capacity record. */
export const CAPACITY_STORAGE_KEY = 'txresbench.viz.renderCapacity'

/** Re-probe after this long even for the same renderer (driver/OS updates change perf). 30 days. */
export const CAPACITY_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** The persisted record. `threshold` is already clamped + ready to feed `resolveCpuRasterMode`. */
export interface CapacityRecord {
  readonly version: number
  /** hash of `UNMASKED_RENDERER_WEBGL` — cache is invalid if the current renderer differs. */
  readonly rendererHash: number
  /** the derived, clamped raster point threshold. */
  readonly threshold: number
  /** raw measured realtime capacity (points drawable within `FRAME_BUDGET_MS`), pre-clamp — kept
   *  for diagnostics; the decision uses `threshold`. */
  readonly measuredCapacity: number
  /** epoch ms the measurement was taken. */
  readonly measuredAt: number
}

/** FNV-1a 32-bit hash of the renderer string (stable machine/browser key; not security-sensitive). */
export function rendererHash(renderer: string | null | undefined): number {
  let h = 0x811c9dc5
  const s = typeof renderer === 'string' ? renderer : ''
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Convert a raw realtime capacity (points/frame) into the clamped raster threshold. A machine that
 *  can draw `capacity` points per frame keeps points up to `capacity` and rasters above it — bounded
 *  to [`PROBE_POINT_FLOOR`, `CAPACITY_CEILING`]. Non-finite / non-positive input → the safe default. */
export function capacityToThreshold(
  capacity: number,
  opts: { floor?: number; ceiling?: number } = {},
): number {
  const floor = opts.floor ?? PROBE_POINT_FLOOR
  const ceiling = opts.ceiling ?? CAPACITY_CEILING
  if (!Number.isFinite(capacity) || capacity <= 0) return DEFAULT_RASTER_POINT_THRESHOLD
  return Math.max(floor, Math.min(ceiling, Math.round(capacity)))
}

/** True when a cached record is still usable for the current renderer + time (right version, same
 *  renderer, within TTL). */
export function isCapacityRecordValid(
  rec: unknown,
  currentRendererHash: number,
  now: number,
  ttlMs: number = CAPACITY_TTL_MS,
): rec is CapacityRecord {
  if (!rec || typeof rec !== 'object') return false
  const r = rec as Partial<CapacityRecord>
  return (
    r.version === CAPACITY_SCHEMA_VERSION &&
    typeof r.rendererHash === 'number' &&
    r.rendererHash === currentRendererHash &&
    typeof r.threshold === 'number' &&
    Number.isFinite(r.threshold) &&
    typeof r.measuredAt === 'number' &&
    now - r.measuredAt < ttlMs
  )
}

/** A minimal localStorage-shaped store (so tests inject a fake + SSR/private-mode degrades safely). */
export interface CapacityStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Best-effort `localStorage` (null in SSR / when access throws under privacy settings). */
export function defaultCapacityStore(): CapacityStore | null {
  try {
    const ls = (globalThis as { localStorage?: CapacityStore }).localStorage
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls
  } catch {
    /* access can throw in some privacy modes */
  }
  return null
}

function readRecord(store: CapacityStore | null): unknown {
  if (!store) return null
  try {
    const raw = store.getItem(CAPACITY_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeRecord(store: CapacityStore | null, rec: CapacityRecord): void {
  if (!store) return
  try {
    store.setItem(CAPACITY_STORAGE_KEY, JSON.stringify(rec))
  } catch {
    /* quota / privacy — the in-session value still holds; we just don't persist */
  }
}

/**
 * The offscreen WebGL2 point-throughput micro-bench. Draws a fixed batch of blended points a few
 * times, forces completion (`readPixels`), and extrapolates "points drawable within
 * `FRAME_BUDGET_MS`". Returns `null` when it can't run (no DOM / no WebGL2 / any error) — the caller
 * then falls back to the fixed default. Cost is a handful of ms; run ONCE per session, then cached.
 */
export function probePointThroughput(
  doc: Document | undefined = (globalThis as { document?: Document }).document,
): number | null {
  try {
    if (!doc || typeof doc.createElement !== 'function') return null
    const canvas = doc.createElement('canvas')
    canvas.width = 256
    canvas.height = 256
    const gl = canvas.getContext('webgl2')
    if (!gl) return null

    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null
    }
    const vs = compile(
      gl.VERTEX_SHADER,
      `#version 300 es
       layout(location=0) in vec2 p;
       void main(){ gl_Position = vec4(p, 0.0, 1.0); gl_PointSize = 1.0; }`,
    )
    const fs = compile(
      gl.FRAGMENT_SHADER,
      `#version 300 es
       precision mediump float; out vec4 o;
       void main(){ o = vec4(1.0, 1.0, 1.0, 0.02); }`,
    )
    if (!vs || !fs) return null
    const prog = gl.createProgram()
    if (!prog) return null
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
    gl.useProgram(prog)

    const N = 250_000
    const data = new Float32Array(N * 2)
    // deterministic pseudo-random spread so the batch is representative (not all at one texel).
    let seed = 0x9e3779b9
    for (let i = 0; i < data.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
      data[i] = (seed / 0xffffffff) * 2 - 1
    }
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE)

    // warmup (shader/pipeline JIT), then time ITER draws with a forced flush.
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.POINTS, 0, N)
    const warm = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, warm)

    const ITER = 4
    const t0 = performance.now()
    for (let k = 0; k < ITER; k++) {
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.POINTS, 0, N)
    }
    const px = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px) // forces completion of the queued draws
    const msPerDraw = (performance.now() - t0) / ITER

    // release GPU resources promptly.
    gl.deleteBuffer(buf)
    gl.deleteProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    gl.getExtension('WEBGL_lose_context')?.loseContext()

    if (!Number.isFinite(msPerDraw) || msPerDraw <= 0) return null
    const pointsPerMs = N / msPerDraw
    return Math.round(pointsPerMs * FRAME_BUDGET_MS)
  } catch {
    return null
  }
}

/** Injectable dependencies for {@link resolveMachineThreshold} (all defaulted; overridden in tests). */
export interface ResolveMachineThresholdDeps {
  /** current renderer string (from `readRendererString`). */
  readonly renderer: string | null
  /** the persisted store (default `localStorage`; `null` disables caching). */
  readonly store?: CapacityStore | null
  /** the impure probe (default {@link probePointThroughput}; return `null` to force the fallback). */
  readonly measure?: () => number | null
  /** clock (default `Date.now`). */
  readonly now?: () => number
}

/**
 * Resolve the machine's raster point threshold: cache-first, else probe + persist, else the fixed
 * default. Never throws. This is the value fed to `resolveCpuRasterMode({ pointThreshold })`.
 *
 * - a VALID cached record (same renderer, current version, within TTL) → its `threshold`, no probe;
 * - else run `measure()`, clamp via {@link capacityToThreshold}, persist, and return it;
 * - a failed/`null` probe → {@link DEFAULT_RASTER_POINT_THRESHOLD} (NOT persisted, so it re-probes).
 */
export function resolveMachineThreshold(deps: ResolveMachineThresholdDeps): number {
  const store = deps.store === undefined ? defaultCapacityStore() : deps.store
  const measure = deps.measure ?? probePointThroughput
  const now = (deps.now ?? Date.now)()
  const rHash = rendererHash(deps.renderer)

  const cached = readRecord(store)
  if (isCapacityRecordValid(cached, rHash, now)) return cached.threshold

  const capacity = measure()
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) {
    return DEFAULT_RASTER_POINT_THRESHOLD
  }
  const threshold = capacityToThreshold(capacity)
  writeRecord(store, {
    version: CAPACITY_SCHEMA_VERSION,
    rendererHash: rHash,
    threshold,
    measuredCapacity: capacity,
    measuredAt: now,
  })
  return threshold
}

/** Same-session memo (keyed by renderer) so the sync probe runs AT MOST ONCE per page load even with
 *  many views mounting; localStorage covers the cross-session case. Exposed `_reset` for tests. */
const sessionThresholdByRenderer = new Map<number, number>()
export function sessionMachineThreshold(deps: ResolveMachineThresholdDeps): number {
  const rHash = rendererHash(deps.renderer)
  const hit = sessionThresholdByRenderer.get(rHash)
  if (hit != null) return hit
  const t = resolveMachineThreshold(deps)
  sessionThresholdByRenderer.set(rHash, t)
  return t
}
/** @internal test helper — clears the same-session memo. */
export function _resetSessionThresholdCache(): void {
  sessionThresholdByRenderer.clear()
}
