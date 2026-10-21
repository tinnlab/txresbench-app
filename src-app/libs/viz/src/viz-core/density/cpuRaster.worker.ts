// cpuRaster.worker.ts — the off-main-thread bin+shade worker (PERFORMANCE_PLAN.md Phase 1, A3 +
// STREAMING_PROGRESSIVE_PLAN Wave 2a). Two jobs, one thread:
//   • WHOLE-ARRAY (unchanged): RETAIN positions on `init`/`initPacked`, then service each `bin`
//     message via the SHARED pure `binAndShade` against the retained cloud, posting the shaded RGBA
//     back with its buffer TRANSFERRED. Output is byte-identical to a main-thread `binAndShade`.
//   • PROGRESSIVE (new): `beginStream` fixes an additive `DensityAccumulator` (geometry + shade
//     config); each `append`/`appendPacked` grows the count grid and, on a ~throttle, shades the
//     accumulator-SO-FAR (EMA-blended, anti-flicker) and posts a partial `streamFrame`. `endStream`
//     posts one EXACT terminal frame (byte-identical to `binAndShade` of the whole cloud) and (on the
//     `retain-raw` path) folds the streamed positions into `retained`, so a subsequent zoom `bin`
//     re-bins the full cloud. A `streamEpoch` stamps every message; a stale epoch is dropped (cancel).
//
// The message reducer is factored into `handleMessage(msg, post)` over module-level state so it
// unit-tests in node (no `Worker`/`self`): a test drives it directly + captures `post(...)`. At
// runtime the dedicated-worker `self.onmessage` routes each message into it with the real
// `postMessage`. Threading `post` (vs a closed-over `ctx`) does not change a single shaded byte.

import { binAndShade, binAndShadePacked, shadeCounts, type ShadeMode, type RasterImage } from './cpuRaster'
import { DensityAccumulator, ChannelAccumulator, type ChannelConfig } from './accumulator'
import { baseGridRollup } from '../scale/retainStrategy'
import type { MainToWorker, WorkerToMain } from './cpuRasterClient'
import type { DensityBounds } from './densityBin'
import type { PackMeta } from './quantize'

// The dedicated-worker global scope, typed minimally (the WebWorker lib is not in tsconfig — DOM
// is — so `self` is otherwise a Window with an incompatible `postMessage` signature).
interface DedicatedWorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null
  postMessage(message: WorkerToMain, transfer: Transferable[]): void
}

/** How the reducer posts back to the main thread (the real `self.postMessage`, or a test capture). */
type PostFn = (message: WorkerToMain, transfer: Transferable[]) => void

// Exactly one source is live: the last `init`/`initPacked` wins. `retainedPacked` (16-bit codes +
// decode meta) halves the retained + transferred bytes vs the Float32 `retained`.
let retained: Float32Array = new Float32Array(0)
let retainedPacked: { packed: Uint16Array; meta: PackMeta } | null = null

// ── Base-grid data-cube (STREAMING_PROGRESSIVE_PLAN Wave 2c, item 16 — `base-grid` strategy) ─────
// When a data-stream was flagged `base-grid` (point count over the retain-raw budget), the worker
// keeps a COARSE high-res global count grid over the full data extent. A `binFromBase` zoom re-bin
// then ROLLS UP / CROPS this grid (`baseGridRollup`) → bounded detail at CONSTANT per-zoom work,
// instead of re-scanning N raw points. `null` when no base grid was requested (the retain-raw path).
let baseGrid: { count: Float64Array; width: number; height: number; bounds: DensityBounds } | null = null

// ── Post-stream RETAINED per-point channel (color-by-label / color-by-value) ──────────────────────
// Folded at `endStream` alongside `retained` positions on the retain-raw path (index-aligned). Lets a
// post-stream ZOOM re-bin re-shade by the SAME channel + mode instead of collapsing to density — the
// fix for "color-by-label/value reverts to density on zoom/drag". `null` ⇒ density (byte-identical to
// before). Cleared by a density stream / whole-array `init` so a stale channel can't leak.
let retainedChannels: {
  labels?: Uint16Array
  values?: Float32Array
  config: ChannelConfig
  mode: ShadeMode
} | null = null

// ── Progressive-stream state (one accumulator at a time; last `beginStream` wins) ──────────────
// `acc` is the channel accumulator when channels were configured (color-by-label/value during load),
// else the density-only accumulator (byte-identical path). `mode` selects the shade channel.
interface StreamState {
  epoch: number
  acc: DensityAccumulator | ChannelAccumulator
  channels: boolean
  mode: ShadeMode
  colormap?: import('../data/color').ContinuousColormap
  normalize?: import('./cpuRaster').RasterNormalize
  alpha?: number
  flipY?: boolean
  ema: number
  throttleMs: number
  lastEmit: number
  /** streamed batches retained so `endStream` can fold them into `retained` (zoom re-bin). EMPTY on
   *  the `base-grid` path (`retainRaw === false`) — only `baseAcc` is kept, so memory is O(baseCells). */
  chunks: Float32Array[]
  total: number
  /** the color-by channel config (categories/value) when `channels` — retained at `endStream` so a
   *  zoom re-bin can re-shade the SAME channel. */
  channelConfig?: ChannelConfig
  /** per-batch label codes / values, retained ALONGSIDE `chunks` (retain-raw + channels) so
   *  `endStream` folds them index-aligned with the merged positions. */
  labelChunks: Uint16Array[]
  valueChunks: Float32Array[]
  /** A-H2: retain the raw streamed positions (default). `false` = `base-grid` path → keep no chunks. */
  retainRaw: boolean
  /** coarse base-grid accumulator fed alongside the display grid when `base-grid` was requested
   *  (item 16). Kept as the module `baseGrid` at `endStream`; null on the retain-raw path. */
  baseAcc: DensityAccumulator | null
}
let stream: StreamState | null = null

// ── Value-bind state (matrix bind-a-column; re-bins RETAINED positions, item 14) ──────────────
interface ValueBindState {
  epoch: number
  acc: ChannelAccumulator
  positions: Float32Array
  colormap?: import('../data/color').ContinuousColormap
  alpha?: number
  flipY?: boolean
  ema: number
  throttleMs: number
  lastEmit: number
}
let valueBind: ValueBindState | null = null

/** Reset ALL module state — test-only isolation between cases (never called at runtime). */
export function __resetWorkerStateForTest(): void {
  retained = new Float32Array(0)
  retainedPacked = null
  baseGrid = null
  stream = null
  valueBind = null
  retainedChannels = null
}

/** Concatenate typed-array chunks into one array of the same kind (index order preserved). */
function mergeU16(chunks: Uint16Array[], total: number): Uint16Array {
  const out = new Uint16Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}
function mergeF32(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/**
 * Re-shade a zoom/re-bin request by the RETAINED per-point channel (color-by-label/value) when one
 * was folded at `endStream`. Re-bins the retained positions + channel through a fresh
 * `ChannelAccumulator` over the request's world rect (exact, O(N) per zoom — the same cost as the
 * density `binAndShade` it replaces). Returns `null` when there is no retained channel (density mode),
 * so callers fall through to the unchanged density path.
 */
function shadeRetainedChannel(msg: {
  bounds: DensityBounds
  width: number
  height: number
  colormap?: import('../data/color').ContinuousColormap
  normalize?: import('./cpuRaster').RasterNormalize
  alpha?: number
  flipY?: boolean
}): RasterImage | null {
  const rc = retainedChannels
  if (!rc || rc.mode === 'density') return null
  const acc = new ChannelAccumulator({ bounds: msg.bounds, width: msg.width, height: msg.height }, rc.config)
  acc.append(retainedFloat32(), { labels: rc.labels, values: rc.values })
  return acc.shade({
    mode: rc.mode,
    colormap: msg.colormap,
    normalize: msg.normalize,
    alpha: msg.alpha,
    flipY: msg.flipY,
    final: true,
  })
}

function shadeStream(s: StreamState, final: boolean) {
  if (s.channels) {
    return (s.acc as ChannelAccumulator).shade({
      mode: s.mode,
      colormap: s.colormap,
      normalize: s.normalize,
      alpha: s.alpha,
      flipY: s.flipY,
      ema: s.ema,
      final,
    })
  }
  return (s.acc as DensityAccumulator).shade({
    colormap: s.colormap,
    normalize: s.normalize,
    alpha: s.alpha,
    flipY: s.flipY,
    ema: s.ema,
    final,
  })
}

function postFrame(s: StreamState, final: boolean, post: PostFn): void {
  const image = shadeStream(s, final)
  const msg: WorkerToMain = {
    type: 'streamFrame',
    streamEpoch: s.epoch,
    rgba: image.rgba,
    width: image.width,
    height: image.height,
    rowsSeen: s.acc.rows,
    final,
  }
  post(msg, [image.rgba.buffer as ArrayBuffer])
}

function postValueFrame(v: ValueBindState, final: boolean, post: PostFn): void {
  const image = v.acc.shade({
    mode: 'value',
    colormap: v.colormap,
    alpha: v.alpha,
    flipY: v.flipY,
    ema: v.ema,
    final,
  })
  const msg: WorkerToMain = {
    type: 'streamFrame',
    streamEpoch: v.epoch,
    rgba: image.rgba,
    width: image.width,
    height: image.height,
    rowsSeen: v.acc.rows,
    final,
  }
  post(msg, [image.rgba.buffer as ArrayBuffer])
}

/** The RETAINED positions as Float32 (decoding the packed cloud once when only that was retained). */
function retainedFloat32(): Float32Array {
  if (retainedPacked) {
    const { packed, meta } = retainedPacked
    const n = packed.length >> 1
    const out = new Float32Array(packed.length)
    for (let i = 0; i < n; i++) {
      out[i * 2] = meta.originX + packed[i * 2] * meta.scaleX
      out[i * 2 + 1] = meta.originY + packed[i * 2 + 1] * meta.scaleY
    }
    return out
  }
  return retained
}

/** Decode a PACKED batch to interleaved Float32 xy (identity code→world) — for retain-raw folding. */
function decodePackedBatch(packed: Uint16Array, meta: PackMeta): Float32Array {
  const n = packed.length >> 1
  const out = new Float32Array(packed.length)
  for (let i = 0; i < n; i++) {
    out[i * 2] = meta.originX + packed[i * 2] * meta.scaleX
    out[i * 2 + 1] = meta.originY + packed[i * 2 + 1] * meta.scaleY
  }
  return out
}

/** The pure message reducer over module state — the single source of behavior for BOTH the runtime
 *  worker and the node unit tests. `post` sends a worker→main message with its transfer list. */
export function handleMessage(msg: MainToWorker, post: PostFn): void {
  switch (msg.type) {
    case 'init':
      retained = msg.positions
      retainedPacked = null
      baseGrid = null
      retainedChannels = null // whole-array density mode — no color-by channel
      return
    case 'initPacked':
      retainedPacked = { packed: msg.packed, meta: msg.meta }
      baseGrid = null
      retainedChannels = null
      return
    case 'beginStream': {
      const g = msg.geometry
      const geom = { bounds: g.bounds, width: g.width, height: g.height }
      const channels = g.channels != null
      // `base-grid` strategy (item 16): also grow a coarse global count grid at the stream extent, so
      // a post-stream zoom re-bin can roll it up (`binFromBase`) at bounded per-zoom work.
      const baseAcc = g.baseGrid
        ? new DensityAccumulator({ bounds: g.bounds, width: g.baseGrid.width, height: g.baseGrid.height })
        : null
      baseGrid = null // a fresh stream supersedes any prior base grid until this one completes
      stream = {
        epoch: msg.streamEpoch,
        acc: channels ? new ChannelAccumulator(geom, g.channels) : new DensityAccumulator(geom),
        channels,
        mode: g.mode ?? 'density',
        colormap: g.colormap,
        normalize: g.normalize,
        alpha: g.alpha,
        flipY: g.flipY,
        ema: g.ema ?? 0,
        throttleMs: g.throttleMs ?? 0,
        lastEmit: Number.NEGATIVE_INFINITY,
        chunks: [],
        total: 0,
        channelConfig: g.channels,
        labelChunks: [],
        valueChunks: [],
        // A-H2: retain raw positions unless the client explicitly opted into the `base-grid` path.
        retainRaw: g.retainRaw !== false,
        baseAcc,
      }
      return
    }
    case 'append': {
      const s = stream
      if (!s || s.epoch !== msg.streamEpoch) return // stale/cancelled stream → drop
      if (s.channels) (s.acc as ChannelAccumulator).append(msg.positions, { labels: msg.labels, values: msg.value })
      else (s.acc as DensityAccumulator).append(msg.positions)
      s.baseAcc?.append(msg.positions)
      // A-H2: keep the raw chunk ONLY on the retain-raw path. On `base-grid`, dropping it bounds memory
      // to O(baseCells) — the base grid alone answers post-stream zooms (`binFromBase`).
      if (s.retainRaw) {
        s.chunks.push(msg.positions)
        s.total += msg.positions.length
        // Retain the channel batches index-aligned with the positions (color-by zoom re-bin).
        if (msg.labels) s.labelChunks.push(msg.labels)
        if (msg.value) s.valueChunks.push(msg.value)
      }
      const now = Date.now()
      if (now - s.lastEmit >= s.throttleMs) {
        s.lastEmit = now
        postFrame(s, false, post)
      }
      return
    }
    case 'appendPacked': {
      const s = stream
      if (!s || s.epoch !== msg.streamEpoch) return
      if (s.channels)
        (s.acc as ChannelAccumulator).appendPacked(msg.packed, msg.meta, { labels: msg.labels, values: msg.value })
      else (s.acc as DensityAccumulator).appendPacked(msg.packed, msg.meta)
      s.baseAcc?.appendPacked(msg.packed, msg.meta)
      // Defensive (mirror `append`): fold a packed batch into `retained` on the retain-raw path, so a
      // future packed stream re-bins the full cloud (decoded to f32, identity code→world).
      if (s.retainRaw) {
        const f = decodePackedBatch(msg.packed, msg.meta)
        s.chunks.push(f)
        s.total += f.length
        if (msg.labels) s.labelChunks.push(msg.labels)
        if (msg.value) s.valueChunks.push(msg.value)
      }
      const now = Date.now()
      if (now - s.lastEmit >= s.throttleMs) {
        s.lastEmit = now
        postFrame(s, false, post)
      }
      return
    }
    case 'beginValueBind': {
      const g = msg.geometry
      valueBind = {
        epoch: msg.streamEpoch,
        acc: new ChannelAccumulator(
          { bounds: g.bounds, width: g.width, height: g.height },
          g.channels ?? { value: true },
        ),
        positions: retainedFloat32(),
        colormap: g.colormap,
        alpha: g.alpha,
        flipY: g.flipY,
        ema: g.ema ?? 0,
        throttleMs: g.throttleMs ?? 0,
        lastEmit: Number.NEGATIVE_INFINITY,
      }
      return
    }
    case 'appendValue': {
      const v = valueBind
      if (!v || v.epoch !== msg.streamEpoch) return
      const from = msg.offset * 2
      const to = from + msg.value.length * 2
      // Re-bin the RESIDENT positions slice with the new value column (count re-derived + sum + KLL).
      v.acc.append(v.positions.subarray(from, to), { values: msg.value })
      const now = Date.now()
      if (now - v.lastEmit >= v.throttleMs) {
        v.lastEmit = now
        postValueFrame(v, false, post)
      }
      return
    }
    case 'endValueBind': {
      const v = valueBind
      if (!v || v.epoch !== msg.streamEpoch) return
      postValueFrame(v, true, post)
      valueBind = null
      return
    }
    case 'endStream': {
      const s = stream
      if (!s || s.epoch !== msg.streamEpoch) return
      postFrame(s, true, post) // EXACT terminal frame (no EMA)
      // Fold the streamed positions into `retained` so a later zoom `bin` re-bins the full cloud — ONLY
      // on the retain-raw path (chunks is empty on `base-grid`, so this naturally no-ops there).
      if (s.chunks.length > 0) {
        const merged = new Float32Array(s.total)
        let off = 0
        for (const c of s.chunks) {
          merged.set(c, off)
          off += c.length
        }
        retained = merged
        retainedPacked = null
      }
      // Retain the color-by channel (index-aligned with the merged positions) so a zoom re-bin
      // re-shades label/value instead of collapsing to density. A density stream (or no retained
      // cloud) clears it — the byte-identical density path. `total` counts xy floats ⇒ points = /2.
      if (s.channels && s.channelConfig && s.chunks.length > 0) {
        const points = s.total >> 1
        retainedChannels = {
          labels: s.labelChunks.length > 0 ? mergeU16(s.labelChunks, points) : undefined,
          values: s.valueChunks.length > 0 ? mergeF32(s.valueChunks, points) : undefined,
          config: s.channelConfig,
          mode: s.mode,
        }
      } else {
        retainedChannels = null
      }
      // Keep the coarse base grid (item 16) so `binFromBase` can roll it up on a zoom re-bin.
      baseGrid = s.baseAcc
        ? { count: s.baseAcc.counts(), width: s.baseAcc.width, height: s.baseAcc.height, bounds: s.baseAcc.bounds }
        : null
      stream = null
      return
    }
    case 'binFromBase': {
      // `base-grid` zoom re-bin (item 16): roll up / crop the coarse base grid to the target viewport
      // rect + dims (bounded, O(baseCells)), then shade. Falls back to an exact `binAndShade` over the
      // retained cloud when no base grid exists (e.g. the size wasn't known upfront) so a frame is
      // always produced.
      // A color-by channel takes precedence: the base grid is density-only, so re-shade the retained
      // channel exactly (channels force the retain-raw path ⇒ baseGrid is null here anyway).
      {
        const channelImage = shadeRetainedChannel(msg)
        if (channelImage) {
          post(
            { type: 'binResult', epoch: msg.epoch, rgba: channelImage.rgba, width: channelImage.width, height: channelImage.height },
            [channelImage.rgba.buffer as ArrayBuffer],
          )
          return
        }
      }
      if (baseGrid) {
        const count = baseGridRollup(
          baseGrid.count,
          baseGrid.width,
          baseGrid.height,
          baseGrid.bounds,
          msg.bounds,
          msg.width,
          msg.height,
        )
        const image = shadeCounts(count, msg.width, msg.height, {
          colormap: msg.colormap,
          normalize: msg.normalize,
          alpha: msg.alpha,
          flipY: msg.flipY,
        })
        post({ type: 'binResult', epoch: msg.epoch, rgba: image.rgba, width: image.width, height: image.height }, [
          image.rgba.buffer as ArrayBuffer,
        ])
        return
      }
      const image = retainedPacked
        ? binAndShadePacked({ packed: retainedPacked.packed, meta: retainedPacked.meta, bounds: msg.bounds, width: msg.width, height: msg.height, colormap: msg.colormap, normalize: msg.normalize, alpha: msg.alpha, flipY: msg.flipY })
        : binAndShade({ positions: retained, bounds: msg.bounds, width: msg.width, height: msg.height, colormap: msg.colormap, normalize: msg.normalize, alpha: msg.alpha, flipY: msg.flipY })
      post({ type: 'binResult', epoch: msg.epoch, rgba: image.rgba, width: image.width, height: image.height }, [
        image.rgba.buffer as ArrayBuffer,
      ])
      return
    }
    case 'cancelStream':
      if (stream && stream.epoch === msg.streamEpoch) stream = null
      if (valueBind && valueBind.epoch === msg.streamEpoch) valueBind = null
      return
    case 'bin': {
      // Color-by channel re-bin (label/value) takes precedence over the density path — re-shade the
      // retained per-point channel exactly, so a zoom/re-bin keeps its coloring instead of density.
      const channelImage = shadeRetainedChannel(msg)
      if (channelImage) {
        post({ type: 'binResult', epoch: msg.epoch, rgba: channelImage.rgba, width: channelImage.width, height: channelImage.height }, [
          channelImage.rgba.buffer as ArrayBuffer,
        ])
        return
      }
      // Bin the packed source when one was retained, else the Float32 positions.
      const { rgba, width, height } = retainedPacked
        ? binAndShadePacked({
            packed: retainedPacked.packed,
            meta: retainedPacked.meta,
            bounds: msg.bounds,
            width: msg.width,
            height: msg.height,
            colormap: msg.colormap,
            normalize: msg.normalize,
            alpha: msg.alpha,
            flipY: msg.flipY,
          })
        : binAndShade({
            positions: retained,
            bounds: msg.bounds,
            width: msg.width,
            height: msg.height,
            colormap: msg.colormap,
            normalize: msg.normalize,
            alpha: msg.alpha,
            flipY: msg.flipY,
          })
      post({ type: 'binResult', epoch: msg.epoch, rgba, width, height }, [rgba.buffer as ArrayBuffer])
      return
    }
  }
}

// Runtime wiring: in a real dedicated worker, route each message into the reducer with the real
// `postMessage`. Guarded so the module imports cleanly in node (unit tests), where `self` is absent.
if (typeof self !== 'undefined') {
  const ctx = self as unknown as DedicatedWorkerScope
  ctx.onmessage = (ev: MessageEvent) => {
    handleMessage(ev.data as MainToWorker, (message, transfer) => ctx.postMessage(message, transfer))
  }
}
