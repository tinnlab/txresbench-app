// cpuRasterClient.ts — the main-thread side of the A3 off-thread bin+shade
// (PERFORMANCE_PLAN.md Phase 1). It owns a single module Worker (density/cpuRaster.worker.ts)
// that RETAINS the positions typed array, so a re-bin never re-transfers N points — only the
// small W×H shaded raster crosses back. The client:
//   • sends `init(positions)` ONCE per positions change (transfers a COPY so the caller keeps its
//     own buffer un-neutered — the view still needs `positions` for its data bounds + fallback);
//   • exposes `requestBin(params)` keyed by a monotonically increasing epoch. Because the worker
//     is single-threaded (FIFO), rapid re-bins queue; only the LATEST requested epoch resolves
//     with an image — every superseded request resolves `null` (never leaks a pending promise);
//   • falls back to the SHARED synchronous `binAndShade` when no Worker exists (SSR / the node
//     vitest env), so output is byte-identical and behavior is unchanged off-thread.
//
// Output is byte-identical to calling `binAndShade` directly (same pure function runs in both
// places) — this only moves the O(N) work off the frame thread.

import {
  binAndShade,
  binAndShadePacked,
  type BinAndShadeParams,
  type RasterImage,
  type RasterNormalize,
  type ShadeMode,
} from './cpuRaster'
import { DensityAccumulator, ChannelAccumulator, type ChannelConfig } from './accumulator'
import { boundsForPositions, type DensityBounds } from './densityBin'
import type { ContinuousColormap } from '../data/color'
import type { PackMeta } from './quantize'

/** A bin request = every `binAndShade` input EXCEPT `positions` (retained in the worker). */
export type RasterBinRequest = Omit<BinAndShadeParams, 'positions'>

/**
 * main → worker messages. `init` transfers the retained Float32 positions; `initPacked` transfers
 * the HALF-SIZE `Uint16` packed codes + their decode meta (PERFORMANCE_PLAN.md Phase 2 — half the
 * transfer bytes). `bin` carries one request; the worker bins whichever source it last retained.
 */
export type MainToWorker =
  | { readonly type: 'init'; readonly positions: Float32Array }
  | { readonly type: 'initPacked'; readonly packed: Uint16Array; readonly meta: PackMeta }
  | ({ readonly type: 'bin'; readonly epoch: number } & RasterBinRequest)
  // ── Base-grid zoom re-bin (STREAMING_PROGRESSIVE_PLAN Wave 2c, item 16) ─────────────
  // Roll up / crop the worker's coarse base-grid data-cube to a target viewport rect + dims (bounded
  // per-zoom work), instead of re-scanning N raw points. Same epoch/stale-drop bookkeeping as `bin`.
  | ({ readonly type: 'binFromBase'; readonly epoch: number } & RasterBinRequest)
  // ── Progressive streaming (STREAMING_PROGRESSIVE_PLAN Wave 2a) ──────────────────────
  // `beginStream` fixes the accumulator geometry + shade config; `append`/`appendPacked` grow the
  // count grid (throttled `streamFrame` partials); `endStream` posts the EXACT terminal frame;
  // `cancelStream` drops an in-flight stream. All carry a `streamEpoch` so the worker drops stale.
  | { readonly type: 'beginStream'; readonly streamEpoch: number; readonly geometry: StreamGeometryMsg }
  | {
      readonly type: 'append'
      readonly streamEpoch: number
      readonly positions: Float32Array
      // ── Wave 2b channels (present iff the stream configured them) ──
      readonly labels?: Uint16Array
      readonly value?: Float32Array
    }
  | {
      readonly type: 'appendPacked'
      readonly streamEpoch: number
      readonly packed: Uint16Array
      readonly meta: PackMeta
      readonly labels?: Uint16Array
      readonly value?: Float32Array
    }
  | { readonly type: 'endStream'; readonly streamEpoch: number }
  | { readonly type: 'cancelStream'; readonly streamEpoch: number }
  // ── Matrix bind-a-column (STREAMING_PROGRESSIVE_PLAN Wave 2b, item 14) ──────────────
  // Re-bind a NEW continuous column over the worker's RETAINED positions (never re-streaming the
  // matrix). `beginValueBind` fixes the value-channel geometry; `appendValue` carries a value slice
  // at a point `offset`; `endValueBind` posts the EXACT terminal value frame. Same `streamEpoch`
  // stale-drop + `streamFrame` relay as the positions stream.
  | { readonly type: 'beginValueBind'; readonly streamEpoch: number; readonly geometry: StreamGeometryMsg }
  | {
      readonly type: 'appendValue'
      readonly streamEpoch: number
      readonly offset: number
      readonly value: Float32Array
    }
  | { readonly type: 'endValueBind'; readonly streamEpoch: number }

/** The geometry + shade config carried on `beginStream` / `beginValueBind`. */
export interface StreamGeometryMsg {
  readonly bounds: DensityBounds
  readonly width: number
  readonly height: number
  readonly colormap?: ContinuousColormap
  readonly normalize?: RasterNormalize
  readonly alpha?: number
  readonly flipY?: boolean
  /** anti-flicker EMA retention for partial frames (exact on the terminal frame). */
  readonly ema?: number
  /** min ms between partial emits (coalesce under burst). */
  readonly throttleMs?: number
  /** which channels the accumulator maintains (absent ⇒ density-only, byte-identical path). */
  readonly channels?: ChannelConfig
  /** which channel to shade (default `'density'`). */
  readonly mode?: ShadeMode
  /** item 16 `base-grid` strategy: when set, the worker also grows a coarse base grid at these dims
   *  over the stream extent, so a post-stream zoom re-bin can `binFromBase` (roll up) it. */
  readonly baseGrid?: { readonly width: number; readonly height: number }
  /** A-H2 memory bound: `true` (default) → the worker RETAINS the raw streamed positions (exact zoom
   *  re-bin). `false` (the `base-grid` path) → it retains ONLY the coarse base grid, so memory is
   *  O(baseCells), NOT O(N); the chunks are never kept + `endStream` folds no full cloud. */
  readonly retainRaw?: boolean
}

/** worker → main: a shaded raster tagged with the epoch it was requested under. */
export type WorkerToMain =
  | {
      readonly type: 'binResult'
      readonly epoch: number
      readonly rgba: Uint8ClampedArray
      readonly width: number
      readonly height: number
    }
  | {
      readonly type: 'streamFrame'
      readonly streamEpoch: number
      readonly rgba: Uint8ClampedArray
      readonly width: number
      readonly height: number
      readonly rowsSeen: number
      readonly final: boolean
    }

/**
 * The minimal transport the client drives. A real `Worker` is adapted to this by the default
 * factory; tests inject a fake so the epoch/stale-drop bookkeeping is exercised as pure logic
 * (no real Worker spun up in vitest).
 */
export interface RasterWorkerLike {
  postMessage(message: MainToWorker, transfer?: Transferable[]): void
  terminate(): void
  setOnMessage(handler: (msg: WorkerToMain) => void): void
}

export interface CpuRasterClient {
  /** Retain `positions` in the worker (transfers a copy; the caller's array is untouched). */
  init(positions: Float32Array): void
  /**
   * Retain a 16-bit PACKED cloud (`quantize.ts`) in the worker instead of Float32 positions —
   * half the transfer bytes. Subsequent `requestBin` calls bin the packed source. Transfers a
   * COPY of the codes so the caller's `Uint16Array` is not neutered.
   */
  initPacked(packed: Uint16Array, meta: PackMeta): void
  /**
   * Bin+shade the retained positions over `params`. Resolves with the raster when this request
   * is still the latest, or `null` when a newer `requestBin` superseded it (only the latest
   * bin wins). Never rejects.
   */
  requestBin(params: RasterBinRequest): Promise<RasterImage | null>
  /**
   * Re-bin over the worker's COARSE BASE GRID (STREAMING_PROGRESSIVE_PLAN Wave 2c, item 16 —
   * `base-grid` strategy). Rolls up / crops the base data-cube to `params` (bounded per-zoom work,
   * O(baseCells)) instead of re-scanning the raw cloud. When no base grid was built (the stream was
   * not flagged `base-grid`, or the fallback path), it degrades to an EXACT re-bin over the retained
   * cloud — a valid raster is always produced. Same latest-epoch-wins `null`-drop as {@link requestBin}.
   */
  requestBinFromBase(params: RasterBinRequest): Promise<RasterImage | null>
  /**
   * Drive a PROGRESSIVE raster from a normalized batch stream (STREAMING_PROGRESSIVE_PLAN Wave 2a).
   * Consumes `source` (from `normalizeVizData`), grows an additive count grid, and calls
   * `handlers.onFrame` with each throttled partial frame + one EXACT terminal frame — so a blurry
   * raster sharpens as bytes arrive and a whole-in-memory array (one batch) renders instantly. The
   * bin geometry is `geometry.bounds` when given, else seeded from the FIRST batch. Returns a handle
   * whose `cancel()` (or a new `streamRaster`/`requestBin`) bumps the epoch → late frames are dropped
   * + the source's `signal` aborts. The completed raster equals the one-shot `binAndShade`.
   */
  streamRaster(
    source: AsyncIterable<NormalizedRasterBatch>,
    geometry: RasterStreamGeometry,
    handlers: RasterStreamHandlers,
    opts?: RasterStreamOptions,
  ): RasterStreamHandle
  /**
   * Bind a NEW continuous column over the RESIDENT positions (matrix "bind-a-column", item 14). Does
   * NOT re-stream/re-fetch positions: it re-bins the retained cloud (`init`/`initPacked` or a folded
   * stream) with the streamed `value` slices into a fresh value channel + KLL sketch, and shades the
   * mean over the sketch's `[p1,p99]`. Progressive (a partial per throttled batch) + a final EXACT
   * frame. Switching the bound column = a new `bindValueColumn` (bumps the epoch, positions stay
   * resident). Returns a handle whose `cancel()` drops late frames.
   */
  bindValueColumn(
    source: AsyncIterable<ValueColumnBatch>,
    geometry: ValueBindGeometry,
    handlers: RasterStreamHandlers,
    opts?: RasterStreamOptions,
  ): RasterStreamHandle
  /** Tear down the worker and resolve any in-flight requests with `null`. Idempotent. */
  terminate(): void
}

/** One normalized batch the stream driver consumes (matches `adapter/vizData.ts::NormalizedBatch`,
 *  restated here to keep the density layer free of an adapter import). */
export interface NormalizedRasterBatch {
  readonly offset: number
  readonly positions: Float32Array
  /** label codes for this batch's points (category channel) — present iff a labels channel streams. */
  readonly labels?: Uint16Array
  /** continuous values for this batch's points (value channel) — present iff a value channel streams. */
  readonly value?: Float32Array
}

/** The geometry a progressive stream bins over. `bounds` optional → seeded from the first batch. */
export interface RasterStreamGeometry {
  readonly bounds?: DensityBounds
  readonly width: number
  readonly height: number
  readonly colormap?: ContinuousColormap
  readonly normalize?: RasterNormalize
  readonly alpha?: number
  readonly flipY?: boolean
  readonly ema?: number
  /** Wave 2b: which channels the accumulator maintains (absent ⇒ density-only, byte-identical). */
  readonly channels?: ChannelConfig
  /** Wave 2b: which channel to shade (default `'density'`). */
  readonly mode?: ShadeMode
  /** Wave 2c (item 16): maintain a coarse base grid at these dims for a `base-grid` zoom re-bin. */
  readonly baseGrid?: { readonly width: number; readonly height: number }
  /** A-H2 memory bound: `false` (the `base-grid` path) keeps ONLY the coarse base grid, not the raw
   *  streamed positions (memory O(baseCells), not O(N)). Default `true` (retain-raw, exact re-bin). */
  readonly retainRaw?: boolean
}

/** One value-column batch {@link CpuRasterClient.bindValueColumn} consumes — `value` aligned to the
 *  resident positions starting at point `offset`. */
export interface ValueColumnBatch {
  readonly offset: number
  readonly value: Float32Array
}

/** Geometry a value-column bind re-bins over the RESIDENT positions (bounds REQUIRED — the positions
 *  extent is already known from the completed positions stream). */
export interface ValueBindGeometry {
  readonly bounds: DensityBounds
  readonly width: number
  readonly height: number
  readonly colormap?: ContinuousColormap
  readonly alpha?: number
  readonly flipY?: boolean
  readonly ema?: number
  /** KLL `k` + rng for the value color-scale sketch (rng injectable for deterministic tests). */
  readonly sketchK?: number
  readonly rng?: () => number
}

/** Metadata delivered with each progressive frame. */
export interface RasterStreamFrameMeta {
  readonly final: boolean
  readonly rowsSeen: number
  /** the world rect the frame was binned over (drives the `BitmapLayer` quad). */
  readonly bounds: DensityBounds
}

/** Callbacks a progressive stream fires. */
export interface RasterStreamHandlers {
  readonly onFrame: (image: RasterImage, meta: RasterStreamFrameMeta) => void
  readonly onProgress?: (rowsSeen: number) => void
  readonly onError?: (err: unknown) => void
  readonly onDone?: () => void
}

/** Options for {@link CpuRasterClient.streamRaster}. */
export interface RasterStreamOptions {
  readonly signal?: AbortSignal
  /** min ms between partial emits (default 60; `0` = a frame per batch, used by tests). */
  readonly throttleMs?: number
}

/** Handle to an in-flight progressive stream. */
export interface RasterStreamHandle {
  /** Stop iterating, drop any further frames, and (worker path) tell the worker to discard the stream. */
  cancel(): void
}

const DEFAULT_STREAM_THROTTLE_MS = 60
const DEFAULT_STREAM_EMA = 0.5

export interface CpuRasterClientOptions {
  /** Test seam: supply a fake transport. Default spawns the real module worker (if available). */
  workerFactory?: () => RasterWorkerLike
  /** Force the synchronous main-thread path even when a Worker exists (tests / opt-out). */
  forceMainThread?: boolean
}

/** Adapt a real dedicated `Worker` to the `RasterWorkerLike` transport (Vite-bundled URL). */
function spawnModuleWorker(): RasterWorkerLike {
  const worker = new Worker(new URL('./cpuRaster.worker.ts', import.meta.url), { type: 'module' })
  return {
    postMessage: (message, transfer) =>
      transfer ? worker.postMessage(message, transfer) : worker.postMessage(message),
    terminate: () => worker.terminate(),
    setOnMessage: (handler) => {
      worker.onmessage = (ev: MessageEvent) => handler(ev.data as WorkerToMain)
    },
  }
}

/**
 * Create a CPU-raster client. Uses a Web Worker when one is available (or an injected factory),
 * otherwise runs `binAndShade` synchronously on the main thread with identical output.
 */
export function createCpuRasterClient(opts: CpuRasterClientOptions = {}): CpuRasterClient {
  const factory: (() => RasterWorkerLike) | null = opts.forceMainThread
    ? null
    : (opts.workerFactory ?? (typeof Worker !== 'undefined' ? spawnModuleWorker : null))

  const worker: RasterWorkerLike | null = factory ? factory() : null
  // Fallback (no worker) retains the source by reference — no copy/transfer needed off-thread.
  // Exactly one of `fallbackPositions` / `fallbackPacked` is active (the last `init*` wins).
  let fallbackPositions: Float32Array = new Float32Array(0)
  let fallbackPacked: { packed: Uint16Array; meta: PackMeta } | null = null
  let nextEpoch = 0
  let latestEpoch = 0
  let terminated = false
  const pending = new Map<number, (image: RasterImage | null) => void>()
  // Active progressive streams (worker path) keyed by their epoch — holds the frame handlers + the
  // resolved bin bounds so a worker `streamFrame` can be relayed with its geometry.
  const streams = new Map<number, { handlers: RasterStreamHandlers; bounds: DensityBounds }>()

  if (worker) {
    worker.setOnMessage((msg) => {
      if (terminated) return
      if (msg.type === 'binResult') {
        const resolve = pending.get(msg.epoch)
        if (!resolve) return
        pending.delete(msg.epoch)
        const image: RasterImage = { rgba: msg.rgba, width: msg.width, height: msg.height }
        // Only the latest requested epoch wins; anything older was superseded → drop it.
        resolve(msg.epoch === latestEpoch ? image : null)
        return
      }
      if (msg.type === 'streamFrame') {
        const st = streams.get(msg.streamEpoch)
        if (!st) return
        // A superseded stream (a newer requestBin/streamRaster bumped the epoch) drops its frames.
        if (msg.streamEpoch !== latestEpoch) {
          if (msg.final) streams.delete(msg.streamEpoch)
          return
        }
        const image: RasterImage = { rgba: msg.rgba, width: msg.width, height: msg.height }
        st.handlers.onFrame(image, { final: msg.final, rowsSeen: msg.rowsSeen, bounds: st.bounds })
        if (msg.final) {
          streams.delete(msg.streamEpoch)
          st.handlers.onDone?.()
        }
      }
    })
  }

  return {
    init(positions) {
      if (terminated) return
      if (worker) {
        // Transfer a COPY so the caller's `positions` buffer is NOT neutered.
        const copy = positions.slice()
        worker.postMessage({ type: 'init', positions: copy }, [copy.buffer as ArrayBuffer])
      } else {
        fallbackPositions = positions
        fallbackPacked = null
      }
    },

    initPacked(packed, meta) {
      if (terminated) return
      if (worker) {
        // Transfer a COPY of the codes so the caller's `Uint16Array` is NOT neutered.
        const copy = packed.slice()
        worker.postMessage({ type: 'initPacked', packed: copy, meta }, [copy.buffer as ArrayBuffer])
      } else {
        fallbackPacked = { packed, meta }
      }
    },

    requestBin(params) {
      if (terminated) return Promise.resolve(null)
      const epoch = ++nextEpoch
      latestEpoch = epoch
      if (worker) {
        return new Promise<RasterImage | null>((resolve) => {
          pending.set(epoch, resolve)
          worker.postMessage({ type: 'bin', epoch, ...params })
        })
      }
      // Main-thread fallback: identical pure computation, synchronous. Bins the packed source when
      // one was retained (`initPacked`), else the Float32 positions.
      const image = fallbackPacked
        ? binAndShadePacked({ packed: fallbackPacked.packed, meta: fallbackPacked.meta, ...params })
        : binAndShade({ positions: fallbackPositions, ...params })
      // Synchronous ⇒ epoch is still latest here; keep the check for symmetry with the worker path.
      return Promise.resolve(epoch === latestEpoch ? image : null)
    },

    requestBinFromBase(params) {
      if (terminated) return Promise.resolve(null)
      const epoch = ++nextEpoch
      latestEpoch = epoch
      if (worker) {
        return new Promise<RasterImage | null>((resolve) => {
          pending.set(epoch, resolve)
          worker.postMessage({ type: 'binFromBase', epoch, ...params })
        })
      }
      // Main-thread fallback: no separate off-thread base grid — serve an EXACT re-bin over the
      // retained cloud (correct raster; the bounded base-grid roll-up is a worker-path optimization).
      const image = fallbackPacked
        ? binAndShadePacked({ packed: fallbackPacked.packed, meta: fallbackPacked.meta, ...params })
        : binAndShade({ positions: fallbackPositions, ...params })
      return Promise.resolve(epoch === latestEpoch ? image : null)
    },

    streamRaster(source, geometry, handlers, opts) {
      if (terminated) {
        queueMicrotask(() => handlers.onDone?.())
        return { cancel() {} }
      }
      // Reserve the shared epoch so a new stream / any `requestBin` supersedes this one (its frames
      // are then dropped). Appends do NOT bump it, so a stream keeps emitting under one epoch.
      const epoch = ++nextEpoch
      latestEpoch = epoch
      const streamEpoch = epoch
      const throttleMs = opts?.throttleMs ?? DEFAULT_STREAM_THROTTLE_MS
      const ema = geometry.ema ?? DEFAULT_STREAM_EMA
      let cancelled = false
      const ac = new AbortController()
      if (opts?.signal) {
        if (opts.signal.aborted) ac.abort()
        else opts.signal.addEventListener('abort', () => ac.abort(), { once: true })
      }
      const stale = () => cancelled || ac.signal.aborted || terminated || epoch !== latestEpoch

      const shadeCfg = {
        colormap: geometry.colormap,
        normalize: geometry.normalize,
        alpha: geometry.alpha,
        flipY: geometry.flipY,
      }
      const mode: ShadeMode = geometry.mode ?? 'density'
      const channels = geometry.channels
      // The worker geometry must be structured-cloneable — strip the (function) `rng` from channels.
      const workerChannels: ChannelConfig | undefined = channels ? { ...channels, rng: undefined } : undefined

      const runWorker = async () => {
        let started = false
        let rowsSeen = 0
        try {
          for await (const batch of source) {
            // Superseded/cancelled/aborted before finishing → drop the (possibly-registered) stream
            // entry so the `streams` map can't leak under direct API misuse (defensive).
            if (stale()) {
              streams.delete(streamEpoch)
              return
            }
            const pos = batch.positions
            const points = pos.length >> 1
            if (!started) {
              const bounds = geometry.bounds ?? boundsForPositions(pos)
              streams.set(streamEpoch, { handlers, bounds })
              worker!.postMessage({
                type: 'beginStream',
                streamEpoch,
                geometry: { ...shadeCfg, bounds, width: geometry.width, height: geometry.height, ema, throttleMs, channels: workerChannels, mode, baseGrid: geometry.baseGrid, retainRaw: geometry.retainRaw },
              })
              started = true
            }
            rowsSeen += points
            // Transfer COPIES so whole in-memory arrays handed straight in are NOT neutered.
            const copy = pos.slice()
            const transfer: Transferable[] = [copy.buffer as ArrayBuffer]
            let labelsCopy: Uint16Array | undefined
            let valueCopy: Float32Array | undefined
            if (batch.labels) {
              labelsCopy = batch.labels.slice()
              transfer.push(labelsCopy.buffer as ArrayBuffer)
            }
            if (batch.value) {
              valueCopy = batch.value.slice()
              transfer.push(valueCopy.buffer as ArrayBuffer)
            }
            worker!.postMessage({ type: 'append', streamEpoch, positions: copy, labels: labelsCopy, value: valueCopy }, transfer)
            handlers.onProgress?.(rowsSeen)
          }
          if (stale()) {
            streams.delete(streamEpoch)
            return
          }
          if (!started) {
            const bounds = geometry.bounds ?? boundsForPositions(new Float32Array(0))
            streams.set(streamEpoch, { handlers, bounds })
            worker!.postMessage({
              type: 'beginStream',
              streamEpoch,
              geometry: { ...shadeCfg, bounds, width: geometry.width, height: geometry.height, ema, throttleMs, channels: workerChannels, mode, baseGrid: geometry.baseGrid, retainRaw: geometry.retainRaw },
            })
          }
          worker!.postMessage({ type: 'endStream', streamEpoch })
          // `onDone` fires from the terminal `streamFrame` relay above.
        } catch (err) {
          streams.delete(streamEpoch)
          if (!cancelled && epoch === latestEpoch) handlers.onError?.(err)
        }
      }

      const runFallback = async () => {
        // Channels present → the multi-channel accumulator; else the density-only one (byte-identical).
        let densAcc: DensityAccumulator | null = null
        let chanAcc: ChannelAccumulator | null = null
        let bounds: DensityBounds | null = geometry.bounds ?? null
        let rowsSeen = 0
        let lastEmit = Number.NEGATIVE_INFINITY
        // A-H2 memory bound (mirrors the worker): retain the raw positions ONLY when `retainRaw` (the
        // default). On the `base-grid` path (`retainRaw === false`) we keep NO chunks — memory stays
        // bounded, not O(N) — so a later value-bind re-bins whatever was already resident, not the cloud.
        const retainRaw = geometry.retainRaw !== false
        const foldChunks: Float32Array[] = []
        let foldTotal = 0
        const shadeNow = (final: boolean): RasterImage =>
          chanAcc
            ? chanAcc.shade({ ...shadeCfg, mode, ema, final })
            : densAcc!.shade({ ...shadeCfg, ema, final })
        try {
          for await (const batch of source) {
            if (stale()) return
            const pos = batch.positions
            if (!densAcc && !chanAcc) {
              if (!bounds) bounds = boundsForPositions(pos)
              const geom = { bounds, width: geometry.width, height: geometry.height }
              if (channels) chanAcc = new ChannelAccumulator(geom, channels)
              else densAcc = new DensityAccumulator(geom)
            }
            if (chanAcc) chanAcc.append(pos, { labels: batch.labels, values: batch.value })
            else densAcc!.append(pos)
            if (retainRaw) {
              foldChunks.push(pos)
              foldTotal += pos.length
            }
            rowsSeen = chanAcc ? chanAcc.rows : densAcc!.rows
            handlers.onProgress?.(rowsSeen)
            const now = Date.now()
            if (now - lastEmit >= throttleMs) {
              lastEmit = now
              const image = shadeNow(false)
              if (!stale()) handlers.onFrame(image, { final: false, rowsSeen, bounds: bounds as DensityBounds })
            }
          }
          if (stale()) return
          if (!densAcc && !chanAcc) {
            if (!bounds) bounds = boundsForPositions(new Float32Array(0))
            const geom = { bounds, width: geometry.width, height: geometry.height }
            if (channels) chanAcc = new ChannelAccumulator(geom, channels)
            else densAcc = new DensityAccumulator(geom)
          }
          const image = shadeNow(true)
          if (!stale()) {
            // Fold the streamed positions into the retained cloud so a later `bindValueColumn` re-bins
            // the resident positions (never re-fetching the matrix).
            if (foldChunks.length > 0) {
              const merged = new Float32Array(foldTotal)
              let off = 0
              for (const c of foldChunks) {
                merged.set(c, off)
                off += c.length
              }
              fallbackPositions = merged
              fallbackPacked = null
            }
            handlers.onFrame(image, { final: true, rowsSeen, bounds: bounds as DensityBounds })
            handlers.onDone?.()
          }
        } catch (err) {
          if (!cancelled && epoch === latestEpoch) handlers.onError?.(err)
        }
      }

      void (worker ? runWorker() : runFallback())

      return {
        cancel() {
          if (cancelled) return
          cancelled = true
          ac.abort()
          streams.delete(streamEpoch)
          if (worker && !terminated) worker.postMessage({ type: 'cancelStream', streamEpoch })
        },
      }
    },

    bindValueColumn(source, geometry, handlers, opts) {
      if (terminated) {
        queueMicrotask(() => handlers.onDone?.())
        return { cancel() {} }
      }
      const epoch = ++nextEpoch
      latestEpoch = epoch
      const streamEpoch = epoch
      const throttleMs = opts?.throttleMs ?? DEFAULT_STREAM_THROTTLE_MS
      const ema = geometry.ema ?? DEFAULT_STREAM_EMA
      const bounds = geometry.bounds
      let cancelled = false
      const ac = new AbortController()
      if (opts?.signal) {
        if (opts.signal.aborted) ac.abort()
        else opts.signal.addEventListener('abort', () => ac.abort(), { once: true })
      }
      const stale = () => cancelled || ac.signal.aborted || terminated || epoch !== latestEpoch
      const shadeCfg = { colormap: geometry.colormap, alpha: geometry.alpha, flipY: geometry.flipY }

      const runWorker = async () => {
        try {
          streams.set(streamEpoch, { handlers, bounds })
          worker!.postMessage({
            type: 'beginValueBind',
            streamEpoch,
            geometry: {
              ...shadeCfg,
              bounds,
              width: geometry.width,
              height: geometry.height,
              ema,
              throttleMs,
              channels: { value: true, sketchK: geometry.sketchK },
              mode: 'value',
            },
          })
          for await (const batch of source) {
            if (stale()) {
              streams.delete(streamEpoch)
              return
            }
            const copy = batch.value.slice()
            worker!.postMessage({ type: 'appendValue', streamEpoch, offset: batch.offset, value: copy }, [
              copy.buffer as ArrayBuffer,
            ])
          }
          if (stale()) {
            streams.delete(streamEpoch)
            return
          }
          worker!.postMessage({ type: 'endValueBind', streamEpoch })
        } catch (err) {
          streams.delete(streamEpoch)
          if (!cancelled && epoch === latestEpoch) handlers.onError?.(err)
        }
      }

      const runFallback = async () => {
        // Re-bind over the RESIDENT positions (never re-fetching them). `append` re-derives the count
        // grid from the resident positions slice (identical to the density count) + fills sum/sketch.
        const acc = new ChannelAccumulator(
          { bounds, width: geometry.width, height: geometry.height },
          { value: true, sketchK: geometry.sketchK, rng: geometry.rng },
        )
        let lastEmit = Number.NEGATIVE_INFINITY
        try {
          for await (const batch of source) {
            if (stale()) return
            const from = batch.offset * 2
            const to = from + batch.value.length * 2
            acc.append(fallbackPositions.subarray(from, to), { values: batch.value })
            const now = Date.now()
            if (now - lastEmit >= throttleMs) {
              lastEmit = now
              const image = acc.shade({ ...shadeCfg, mode: 'value', ema })
              if (!stale()) handlers.onFrame(image, { final: false, rowsSeen: acc.rows, bounds })
            }
          }
          if (stale()) return
          const image = acc.shade({ ...shadeCfg, mode: 'value', final: true })
          if (!stale()) {
            handlers.onFrame(image, { final: true, rowsSeen: acc.rows, bounds })
            handlers.onDone?.()
          }
        } catch (err) {
          if (!cancelled && epoch === latestEpoch) handlers.onError?.(err)
        }
      }

      void (worker ? runWorker() : runFallback())

      return {
        cancel() {
          if (cancelled) return
          cancelled = true
          ac.abort()
          streams.delete(streamEpoch)
          if (worker && !terminated) worker.postMessage({ type: 'cancelStream', streamEpoch })
        },
      }
    },

    terminate() {
      if (terminated) return
      terminated = true
      for (const resolve of pending.values()) resolve(null)
      pending.clear()
      streams.clear()
      if (worker) worker.terminate()
    },
  }
}
