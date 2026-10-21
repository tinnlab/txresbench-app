// CpuRasterView.tsx — the A1+A2 render surface for the CPU-raster fast path
// (PERFORMANCE_PLAN.md Phase 1). On a SOFTWARE renderer a dense scatter is drawn as ONE
// deck.gl `BitmapLayer` quad of a CPU-binned+shaded raster (density/cpuRaster.ts) instead of
// N GL_POINTS — cost O(pixels), independent of N. Framework shape mirrors DensityView /
// CategoricalPointsView: a single <DeckGL> + OrthographicView, viewport measured via
// ResizeObserver.
//
// A2 amortization — the raster is binned over a world rect and handed to the BitmapLayer as
// its `bounds`:
//   • PAN keeps the SAME world `bounds`; deck re-projects the fixed quad, so a pan does ZERO
//     CPU re-binning (the raster just scrolls with the camera). Small pans stay covered because
//     we bin a rect PADDED (RASTER_PAD) around the viewport.
//   • ZOOM (or a data / viewport-size change, or a pan past the padded margin) schedules a
//     DEBOUNCED (~120ms) re-bin over the new viewport world rect; the STALE raster keeps
//     drawing until the fresh one lands (no blank frame).
// The raster resolution is `viewport px × RASTER_PAD × resolutionScale` (half-res by default),
// capped, so the bin cost is bounded by the screen, never by N.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { BitmapLayer } from '@deck.gl/layers'
import { boundsForPositions, type DensityBounds } from './densityBin'
import { toBitmapImage, type RasterImage, type RasterNormalize } from './cpuRaster'
import { U16_MAX, type PackedPositions } from './quantize'
import { createCpuRasterClient, type CpuRasterClient, type RasterStreamHandle } from './cpuRasterClient'
import type { ShadeMode } from './cpuRaster'
import type { ChannelConfig } from './accumulator'
import { viewportWorldBounds, type ViewportCamera } from '../scale/lod'
import { chooseRetainStrategy, shouldRebinForView, DEFAULT_BASE_GRID_DIM } from '../scale/retainStrategy'
import { DEFAULT_CONTINUOUS_COLORMAP, type ContinuousColormap } from '../data/color'
import { ChartError } from '../charts/useAsyncChartData'
import { dataKeyOf } from './dataKey'
import { LIGHT_THEME, type VizTheme } from '../theme'
import type { OverlapTooltipHandle } from '../tooltip/useOverlapTooltip'
import {
  normalizeVizData,
  normalizeChannelColumn,
  type VizData,
  type ChannelInput,
} from '../../adapter/vizData'

/**
 * How the raster is COLORED (STREAMING_PROGRESSIVE_PLAN Wave 2b). The friendly default `'density'`
 * (count → colormap) is byte-identical to today. `{ label: key }` colors by the per-cell ARGMAX
 * streamed category; `{ value: key }` colors by the streamed continuous mean, its scale driven by the
 * channel's KLL p1/p99. The `key` names the channel — resolved to a source via {@link ColorByResolver}
 * or the `data` object form's own `labels`/`value`. Switching a `{ value }` key re-binds ONE column
 * over the resident positions (never the whole matrix).
 */
export type ColorBy = 'density' | { readonly label: string } | { readonly value: string }

/** Resolve a channel `key` → its column source (the matrix "bind-a-column" seam, item 14). */
export type ColorByResolver = (key: string, kind: 'label' | 'value') => ChannelInput | null | undefined

/** Default number of category slots (top-K label codes) tracked when coloring by label. */
const DEFAULT_CATEGORY_SLOTS = 16

/** True when `data` is the object form (`{ positions, … }`) rather than a bare source. */
function isObjectForm(
  data: VizData,
): data is Extract<VizData, { positions: unknown }> {
  return (
    data != null &&
    typeof data === 'object' &&
    !(data instanceof Float32Array) &&
    !(data instanceof Uint8Array) &&
    'positions' in (data as Record<string, unknown>)
  )
}

/** Resolve a colorBy `key` to a channel source: the resolver seam wins, else the `data` object form's
 *  own `labels`/`value`. `null` when neither supplies it (the mode then degrades to density). */
function resolveChannelInput(
  key: string,
  kind: 'label' | 'value',
  data: VizData,
  resolver?: ColorByResolver,
): ChannelInput | null {
  const fromResolver = resolver?.(key, kind)
  if (fromResolver != null) return fromResolver
  if (isObjectForm(data)) {
    const own = kind === 'label' ? data.labels : data.value
    if (own != null) return own
  }
  return null
}

/** Merge a resolved channel into `data` as its `labels`/`value` so the ONE `normalizeVizData` stream
 *  carries positions + the channel aligned by offset. */
function withChannel(data: VizData, kind: 'label' | 'value', channel: ChannelInput): VizData {
  const field = kind === 'label' ? 'labels' : 'value'
  if (isObjectForm(data)) return { ...data, [field]: channel }
  return { positions: data as Extract<VizData, { positions: unknown }>['positions'], [field]: channel }
}

/** The stream plan for a `colorBy`: the shade `mode`, the channel config, the (channel-merged) data,
 *  and — for a value bind — the value channel `key` + resolved source. */
interface ChannelPlan {
  readonly mode: ShadeMode
  readonly channels?: ChannelConfig
  readonly data: VizData
  readonly valueKey?: string
  readonly valueSource?: ChannelInput | null
}

function planChannels(
  colorBy: ColorBy | undefined,
  data: VizData,
  resolver: ColorByResolver | undefined,
  categorySlots: number,
): ChannelPlan {
  if (colorBy && typeof colorBy === 'object') {
    if ('label' in colorBy) {
      const src = resolveChannelInput(colorBy.label, 'label', data, resolver)
      if (src != null) {
        return { mode: 'category', channels: { categories: categorySlots }, data: withChannel(data, 'label', src) }
      }
    } else if ('value' in colorBy) {
      const src = resolveChannelInput(colorBy.value, 'value', data, resolver)
      if (src != null) {
        return {
          mode: 'value',
          channels: { value: true },
          data: withChannel(data, 'value', src),
          valueKey: colorBy.value,
          valueSource: src,
        }
      }
    }
  }
  return { mode: 'density', data }
}

export { dataKeyOf } from './dataKey'

/** Coerce an unknown thrown value into a human-readable message for `<ChartError>`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return 'Failed to load the visualization data'
}

/** A stable structural key for a {@link ColorBy} — so an effect fires only on a genuine change. */
function colorByKeyOf(cb: ColorBy): string {
  if (typeof cb === 'string') return cb
  if ('label' in cb) return `label:${cb.label}`
  return `value:${cb.value}`
}

/** Progress of a progressive `data` stream — surfaced to `<Viz onProgress>`. */
export interface VizProgress {
  /** points binned so far. */
  readonly rowsSeen: number
  /** `rowsSeen / total * 100` when the total is known (object `total` / URL `Content-Length`), else `null`. */
  readonly coveragePct: number | null
}

/** Bin a rect this many times the viewport extent, so small pans stay covered without a re-bin. */
const RASTER_PAD = 1.3
/** Default raster resolution vs viewport px (half-res: cheap to bin, plenty for a density image). */
const DEFAULT_RESOLUTION_SCALE = 0.5
/** Hard cap on a raster dimension (keeps the bin + the texture upload bounded). */
const MAX_RASTER_DIM = 2048
/** Debounce before a zoom/data re-bin commits (bridges the discrete events of one gesture). */
const DEFAULT_DEBOUNCE_MS = 120

const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 0,
} as OrthographicViewState

/** An OrthographicViewState that FITS `bounds` into a `w×h` px viewport. Needed in `data` (stream)
 *  mode: the raster is binned over the DATA extent (not the viewport rect like the Phase-1 path), so
 *  the camera must frame that extent or the BitmapLayer draws off-screen. Deck ortho:
 *  pixelSpan = worldSpan · 2^zoom ⇒ zoom = log2(px / world); 0.9 leaves a 10% margin. */
function fitViewToBounds(b: DensityBounds, w: number, h: number): OrthographicViewState {
  const spanX = Math.max(1e-6, b.maxX - b.minX)
  const spanY = Math.max(1e-6, b.maxY - b.minY)
  const zoom = Math.log2(Math.max(1e-6, Math.min((w * 0.9) / spanX, (h * 0.9) / spanY)))
  return { target: [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0], zoom } as OrthographicViewState
}

export interface CpuRasterViewProps {
  /** interleaved xy Float32Array, length N*2 — the WHOLE dense cloud (no LOD subset needed).
   *  OPTIONAL when {@link CpuRasterViewProps.data} is provided (the stream owns the positions). */
  positions?: Float32Array
  /**
   * PROGRESSIVE data source (STREAMING_PROGRESSIVE_PLAN Wave 2a). A `Float32Array` (one instant
   * frame), a URL, a `ReadableStream`/`AsyncIterable<Uint8Array>`, or the object form
   * (`{ positions, stride?, packed?, total? }`). When present, the view OWNS fetch → reframe → bin →
   * progressive emit → cancellation via `normalizeVizData` + the worker accumulator: the raster fills
   * blurry→sharp and the completed image equals a one-shot bin of the whole cloud. ABSENT ⇒ the
   * existing `positions`/`packed` whole-array path, byte-identical to today.
   */
  data?: VizData
  /** Fired with `{ rowsSeen, coveragePct }` as a `data` stream arrives (coverage known when a total is). */
  onProgress?: (progress: VizProgress) => void
  /** Fired when the progressive `data` stream (or a value-column bind) FAILS — a 404 / dropped
   *  connection / malformed stream. The failure is ALSO surfaced visually (a `<ChartError>` replaces
   *  the blank raster) so a broken stream is never a permanent silent blank. */
  onError?: (err: unknown) => void
  /**
   * OPTIONAL 16-bit packed cloud (PERFORMANCE_PLAN.md Phase 2). When provided the view bins the
   * HALF-SIZE `Uint16` codes (`binAndShadePacked`) and transfers half the bytes to the worker;
   * `positions` is then used ONLY for a stable reference/identity. ABSENT ⇒ the Float32 path,
   * byte-identical to today.
   */
  packed?: PackedPositions
  /** continuous colormap for the per-cell shading (default viridis). */
  colormap?: ContinuousColormap
  /** count→shade normalization (default `log`). */
  normalize?: RasterNormalize
  /** raster resolution as a fraction of viewport px (default 0.5 = half-res). */
  resolutionScale?: number
  /** debounce (ms) before a zoom/data re-bin commits (default 120). */
  debounceMs?: number
  initialViewState?: Partial<OrthographicViewState>
  /**
   * OPTIONAL fully-controlled camera (data mode). When provided, the HOST owns the camera (e.g. so a
   * selection overlay can share it) — it OVERRIDES the internal data-extent fit + `dataViewState`, and
   * every user gesture is reported through `onViewStateChange` for the host to apply. Absent ⇒ the
   * byte-identical internal-fit behaviour.
   */
  viewState?: OrthographicViewState
  onViewStateChange?: (viewState: OrthographicViewState) => void
  /** bump when `positions` CONTENTS change under a stable reference to force a re-bin. */
  dataEpoch?: number
  /**
   * PROGRESSIVE coloring channel (Wave 2b). `'density'` (default) is byte-identical to today. In
   * `data` (stream) mode, `{ label: key }` / `{ value: key }` color by a streamed category / value
   * channel (accumulated additively). Switching a `{ value }` key re-binds ONE column over the
   * resident positions via {@link resolveChannel}, never re-streaming the matrix.
   */
  colorBy?: ColorBy
  /** Resolve a colorBy `key` → its channel column source (the matrix bind-a-column seam, item 14). */
  resolveChannel?: ColorByResolver
  /** number of category slots (top-K label codes) when coloring by label (default 16). */
  categorySlots?: number
  /**
   * OPT-IN overlap-tooltip handle (from `useOverlapTooltip`, owned by the host that holds the
   * resident positions + fields — e.g. `CategoricalPointsView`). When provided, this view drives it
   * from its DeckGL hover (world coordinate) and renders its badge + dialog. Absent ⇒ no hover
   * tooltip (the byte-identical default; a pure data-stream raster has no resident per-point columns).
   */
  overlap?: OverlapTooltipHandle
  /** theme for the overlap badge/dialog chrome (default light). */
  theme?: VizTheme
}

type WorldRect = readonly [number, number, number, number] // [minX, minY, maxX, maxY] for BitmapLayer.bounds

/** True when world rect `inner` is fully contained in `outer` (a pan that stayed on the raster). */
function contains(outer: DensityBounds, inner: DensityBounds): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  )
}

/**
 * Choose the world rect to bin: the viewport world rect PADDED by `RASTER_PAD`. Falls back to
 * the full data bounds when the camera is degenerate (zero-area / non-finite) or when the
 * padded view does not overlap the data at all (so the raster is never blank).
 */
function chooseBinBounds(
  camera: ViewportCamera,
  w: number,
  h: number,
  dataBounds: DensityBounds,
): DensityBounds {
  const wv = viewportWorldBounds(camera, w, h)
  const halfW = (wv.maxX - wv.minX) / 2
  const halfH = (wv.maxY - wv.minY) / 2
  if (!(halfW > 0) || !(halfH > 0) || !Number.isFinite(halfW) || !Number.isFinite(halfH)) {
    return dataBounds
  }
  const cx = (wv.minX + wv.maxX) / 2
  const cy = (wv.minY + wv.maxY) / 2
  const pb: DensityBounds = {
    minX: cx - halfW * RASTER_PAD,
    minY: cy - halfH * RASTER_PAD,
    maxX: cx + halfW * RASTER_PAD,
    maxY: cy + halfH * RASTER_PAD,
  }
  const disjoint =
    pb.maxX < dataBounds.minX ||
    pb.minX > dataBounds.maxX ||
    pb.maxY < dataBounds.minY ||
    pb.minY > dataBounds.maxY
  return disjoint ? dataBounds : pb
}

/** The shaded raster + the world `bounds` it was binned over (drives the BitmapLayer). */
interface RasterState {
  image: RasterImage
  bounds: WorldRect
  world: DensityBounds
  zoom: number
}

/**
 * The CPU-raster dense view. Renders `positions` as a shaded density raster on ONE BitmapLayer
 * quad — the software-renderer fast path. Interactive: pan is a fixed-quad re-projection (0
 * re-bin), zoom/data changes debounce-re-bin with the stale raster held until the new one lands.
 */
export function CpuRasterView({
  positions,
  packed,
  data,
  onProgress,
  onError,
  colormap = DEFAULT_CONTINUOUS_COLORMAP,
  normalize = 'log',
  resolutionScale = DEFAULT_RESOLUTION_SCALE,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  initialViewState,
  viewState: controlledViewState,
  onViewStateChange,
  dataEpoch = 0,
  colorBy = 'density',
  resolveChannel,
  categorySlots = DEFAULT_CATEGORY_SLOTS,
  overlap,
  theme = LIGHT_THEME,
}: CpuRasterViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Overlap-tooltip hover: unproject the cursor to world + a ~6px world radius, feed the handle.
  const handleRasterHover = useCallback(
    (info: {
      x: number
      y: number
      coordinate?: number[]
      viewport?: { unproject: (xy: number[]) => number[] }
    }) => {
      if (!overlap) return
      const vp = info.viewport
      if (info.coordinate && vp) {
        const p0 = vp.unproject([info.x, info.y])
        const p1 = vp.unproject([info.x + 6, info.y])
        const worldRadius = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        overlap.hoverAt(info.coordinate[0], info.coordinate[1], info.x, info.y, worldRadius)
      } else {
        overlap.clear()
      }
    },
    [overlap],
  )
  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])
  const viewRef = useRef<OrthographicViewState>({ ...DEFAULT_VIEW_STATE, ...initialViewState })

  // World extent for the raster. From the packed decode meta when packed (no O(N) scan of an
  // 8 B/point Float32 array), else scanned from the Float32 positions. In `data` (streaming) mode
  // there are no local positions — the bounds are seeded by the stream driver from the first batch.
  const dataBounds = useMemo<DensityBounds>(() => {
    if (packed) {
      return {
        minX: packed.originX,
        minY: packed.originY,
        maxX: packed.originX + packed.scaleX * U16_MAX,
        maxY: packed.originY + packed.scaleY * U16_MAX,
      }
    }
    return positions ? boundsForPositions(positions) : { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  }, [positions, packed])
  const dataBoundsRef = useRef(dataBounds)
  dataBoundsRef.current = dataBounds

  const [viewportPx, setViewportPx] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const viewportRef = useRef({ w: 0, h: 0 })

  const [raster, setRaster] = useState<RasterState | null>(null)
  const rasterRef = useRef<RasterState | null>(null)
  rasterRef.current = raster

  // Count of committed raster frames — reflected on the container (`data-frame-count`) so a
  // progressive `data` stream's blurry→sharp fill (frames > 1) is observable by the visual harness.
  const [frameCount, setFrameCount] = useState(0)

  // A stream/value-bind failure (404 / dropped connection / malformed stream). When set, the view
  // renders a `<ChartError>` instead of the blank DeckGL; cleared when a fresh stream starts.
  const [streamError, setStreamError] = useState<unknown>(null)

  // A stable structural key for the `data` source (B-H1): the stream-start effect keys on THIS, not
  // raw `data` identity, so an inline `data={{ positions: stableRef, … }}` rebuilt each render (same
  // refs ⇒ same key) does NOT restart-loop. Mirrors `stableOptionKey` / `colorByKeyOf`.
  const dataKey = useMemo(() => (data == null ? '' : dataKeyOf(data)), [data])

  // Data-mode camera fit (Wave 2a): in `data` mode the raster is binned over the DATA extent, so the
  // camera is CONTROLLED + fitted to that extent on the FIRST frame; the user then owns it. Non-`data`
  // mode keeps Phase-1's uncontrolled `initialViewState` (viewport-rect raster, no fit needed).
  const [dataViewState, setDataViewState] = useState<OrthographicViewState | null>(null)
  const fittedRef = useRef(false)
  // Host-controlled camera (a selection overlay sharing this view): mirror it into `viewRef` so the
  // re-bin math uses the real camera, and SKIP the internal fit (the host owns framing).
  useEffect(() => {
    if (controlledViewState) viewRef.current = controlledViewState
  }, [controlledViewState])
  useEffect(() => {
    if (controlledViewState || !data || fittedRef.current || !raster || viewportPx.w === 0 || viewportPx.h === 0) return
    const b: DensityBounds = {
      minX: raster.bounds[0],
      minY: raster.bounds[1],
      maxX: raster.bounds[2],
      maxY: raster.bounds[3],
    }
    const fitted = fitViewToBounds(b, viewportPx.w, viewportPx.h)
    fittedRef.current = true
    viewRef.current = fitted
    setDataViewState(fitted)
  }, [data, raster, viewportPx])

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A3 off-thread: one CPU-raster client (owns the module Worker, or the sync fallback) for the
  // lifetime of the view. `binSeq` monotonically tags each rebin so a resolved (async) raster
  // whose request was superseded — by a newer rebin, or by unmount — is dropped.
  const clientRef = useRef<CpuRasterClient | null>(null)
  const binSeqRef = useRef(0)
  const mountedRef = useRef(false)
  // Tracks what positions/epoch the worker was last `init`ed with, so a colormap/normalize/
  // resolution change re-bins WITHOUT re-transferring the (unchanged) positions.
  const initedRef = useRef<{ positions: Float32Array; epoch: number } | null>(null)
  const dataEpochRef = useRef(dataEpoch)
  dataEpochRef.current = dataEpoch

  // Stable refs to the shading inputs so the debounced re-bin reads the latest without
  // resubscribing the timer each render.
  const positionsRef = useRef(positions)
  positionsRef.current = positions
  const packedRef = useRef(packed)
  packedRef.current = packed
  const shadeRef = useRef({ colormap, normalize, resolutionScale })
  shadeRef.current = { colormap, normalize, resolutionScale }

  // ── Progressive `data`-stream state (STREAMING_PROGRESSIVE_PLAN Wave 2a) ─────────────────────
  // Active only when `data` is provided. The stream OWNS fetch/reframe/bin/emit/cancel; these refs
  // hold the in-flight handle + abort so a data change / unmount tears it down, plus the streamed
  // bounds so a post-load colormap/resize change re-shades the retained cloud (no re-fetch).
  const dataRef = useRef(data)
  dataRef.current = data
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const colorByRef = useRef(colorBy)
  colorByRef.current = colorBy
  const resolveChannelRef = useRef(resolveChannel)
  resolveChannelRef.current = resolveChannel
  const categorySlotsRef = useRef(categorySlots)
  categorySlotsRef.current = categorySlots
  /** The value-channel key currently bound (matrix bind-a-column) — so a key change re-binds only. */
  const boundValueKeyRef = useRef<string | null>(null)
  const valueBindHandleRef = useRef<RasterStreamHandle | null>(null)
  const valueBindAbortRef = useRef<AbortController | null>(null)
  /** The colorBy structural key last applied to a stream (distinguishes a value-key rebind). */
  const appliedColorByRef = useRef<string | null>(null)
  const streamHandleRef = useRef<RasterStreamHandle | null>(null)
  const streamAbortRef = useRef<AbortController | null>(null)
  const streamStartedRef = useRef(false)
  const streamDoneRef = useRef(false)
  const streamBoundsRef = useRef<DensityBounds | null>(null)
  const streamTotalRef = useRef<number | null>(null)
  // ── Data-mode ZOOM RE-BIN state (Wave 2c, item 16) ──────────────────────────────────────────────
  // The point count of the completed stream (drives `chooseRetainStrategy` at zoom time) + the world
  // rect the retained cloud is CURRENTLY re-binned over (the full streamed extent post-stream, a
  // tighter rect after a zoom re-bin) — so a colormap/resize re-shade tracks the zoomed sub-region.
  const streamPointCountRef = useRef(0)
  const dataWorldRef = useRef<DensityBounds | null>(null)

  // Bin+shade over the current camera's padded viewport rect and commit the raster. The O(N) bin
  // runs OFF the frame thread in the worker (or synchronously in the fallback); the async result
  // is committed only if still current. Runs on (re)mount, on debounced zoom/data changes, and on
  // resize — never on a plain pan.
  // Re-bin the RETAINED streamed cloud (post-stream, data mode) over an EXPLICIT world rect + commit.
  // The item-16 core: on zoom the world rect is the tighter viewport-padded rect (crisp detail), on a
  // colormap/resize re-shade it is the CURRENT bin world. `chooseRetainStrategy(pointCount)` picks the
  // path: `retain-raw` → an EXACT `requestBin` over the retained positions; `base-grid` →
  // `requestBinFromBase` (bounded roll-up of the coarse base grid, exact-over-retained if none built).
  const binDataRetained = useCallback((world: DensityBounds, camera: ViewportCamera) => {
    const client = clientRef.current
    if (!client) return
    const { w, h } = viewportRef.current
    if (w <= 0 || h <= 0) return
    const { colormap: cm, normalize: nm, resolutionScale: rs } = shadeRef.current
    const rw = Math.max(1, Math.min(MAX_RASTER_DIM, Math.round(w * RASTER_PAD * rs)))
    const rh = Math.max(1, Math.min(MAX_RASTER_DIM, Math.round(h * RASTER_PAD * rs)))
    const zoomRaw = Array.isArray(camera.zoom) ? camera.zoom[0] : (camera.zoom as number | undefined)
    const zoom = typeof zoomRaw === 'number' && Number.isFinite(zoomRaw) ? zoomRaw : 0
    const bounds: WorldRect = [world.minX, world.minY, world.maxX, world.maxY]
    dataWorldRef.current = world
    const seq = ++binSeqRef.current
    const req = { bounds: world, width: rw, height: rh, colormap: cm, normalize: nm, flipY: true }
    const strategy = chooseRetainStrategy(streamPointCountRef.current)
    const p = strategy === 'base-grid' ? client.requestBinFromBase(req) : client.requestBin(req)
    p.then((image) => {
      if (!image) return // superseded bin (a newer request won)
      if (seq !== binSeqRef.current) return // a newer rebin superseded this one
      if (!mountedRef.current) return // unmounted mid-flight
      setRaster({ image, bounds, world, zoom })
      // A post-stream ZOOM re-bin commits a fresh frame → advance the observable frame count (C-H1:
      // the e2e asserts `data-frame-count` climbs on a zoom re-bin, not only on streaming frames).
      setFrameCount((c) => c + 1)
    }).catch(() => {
      /* worker error → keep the stale raster drawing (no blank frame) */
    })
  }, [])

  const rebin = useCallback(
    (camera: ViewportCamera) => {
      const client = clientRef.current
      if (!client) return
      const { w, h } = viewportRef.current
      if (w <= 0 || h <= 0) return
      // Data (streaming) mode: the stream drives frames while active — a `requestBin` here would bump
      // the shared epoch and CANCEL the live stream, so skip until the stream has completed. After
      // completion, re-shade the RETAINED cloud over its CURRENT bin world (the full streamed extent,
      // or a tighter rect after a zoom re-bin) — this is the colormap/resize re-shade path; ZOOM is
      // handled by `scheduleDataZoomRebin` from `handleViewStateChange`.
      const inDataMode = dataRef.current != null
      if (inDataMode) {
        if (!streamDoneRef.current || !streamBoundsRef.current) return
        binDataRetained(dataWorldRef.current ?? streamBoundsRef.current, camera)
        return
      }
      const { colormap: cm, normalize: nm, resolutionScale: rs } = shadeRef.current
      const world = chooseBinBounds(camera, w, h, dataBoundsRef.current)
      const rw = Math.max(1, Math.min(MAX_RASTER_DIM, Math.round(w * RASTER_PAD * rs)))
      const rh = Math.max(1, Math.min(MAX_RASTER_DIM, Math.round(h * RASTER_PAD * rs)))
      const zoomRaw = Array.isArray(camera.zoom) ? camera.zoom[0] : (camera.zoom as number | undefined)
      const zoom = typeof zoomRaw === 'number' && Number.isFinite(zoomRaw) ? zoomRaw : 0
      const bounds: WorldRect = [world.minX, world.minY, world.maxX, world.maxY]
      const seq = ++binSeqRef.current
      client
        .requestBin({
          bounds: world,
          width: rw,
          height: rh,
          colormap: cm,
          normalize: nm,
          flipY: true, // top-first → upright under BitmapLayer bounds=[minX,minY,maxX,maxY]
        })
        .then((image) => {
          if (!image) return // client dropped a superseded bin (a newer requestBin won)
          if (seq !== binSeqRef.current) return // a newer rebin superseded this one
          if (!mountedRef.current) return // unmounted mid-flight → ignore the late message
          setRaster({ image, bounds, world, zoom })
        })
        .catch(() => {
          /* worker error → keep the stale raster drawing (no blank frame) */
        })
    },
    [binDataRetained],
  )

  const scheduleRebin = useCallback((camera: ViewportCamera) => {
    if (debounceTimer.current != null) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => rebin(camera), debounceMs)
  }, [rebin, debounceMs])

  // Data-mode ZOOM re-bin (item 16): after the stream completes, a zoom (or a pan past the padded
  // margin) re-bins the RETAINED cloud at the TIGHTER viewport-padded rect → crisp detail, rather
  // than reprojecting the fixed data-extent raster (blurry when zoomed in). Debounced like the
  // Phase-1 path; the stale raster keeps drawing until the fresh one lands (no blank frame).
  const rebinDataZoom = useCallback(
    (camera: ViewportCamera) => {
      if (!streamDoneRef.current || !streamBoundsRef.current) return
      const { w, h } = viewportRef.current
      if (w <= 0 || h <= 0) return
      const world = chooseBinBounds(camera, w, h, streamBoundsRef.current)
      binDataRetained(world, camera)
    },
    [binDataRetained],
  )

  const scheduleDataZoomRebin = useCallback(
    (camera: ViewportCamera) => {
      if (debounceTimer.current != null) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(() => rebinDataZoom(camera), debounceMs)
    },
    [rebinDataZoom, debounceMs],
  )

  // Start (or restart) the progressive `data` stream: normalize the source → drive the raster
  // client's `streamRaster`, committing each partial/terminal frame + surfacing progress. The viz
  // owns fetch/reframe/bin/emit/cancel end-to-end — the app writes only `<Viz data={…} />`. Reads
  // refs so it can be triggered from either the data-change or the measure effect without churn.
  const startStream = useCallback(() => {
    const client = clientRef.current
    const d = dataRef.current
    if (!client || !d) return
    const { w, h } = viewportRef.current
    if (w <= 0 || h <= 0) return // wait for the measure effect to supply a viewport
    // Tear down any prior in-flight stream (incl. a value bind) before starting a fresh one.
    streamHandleRef.current?.cancel()
    valueBindHandleRef.current?.cancel()
    valueBindHandleRef.current = null
    streamAbortRef.current?.abort()
    // A fresh stream clears any prior error banner (a retry / new source is starting).
    setStreamError(null)
    const { colormap: cm, normalize: nm, resolutionScale: rs } = shadeRef.current
    const rw = Math.max(1, Math.min(MAX_RASTER_DIM, Math.round(w * RASTER_PAD * rs)))
    const rh = Math.max(1, Math.min(MAX_RASTER_DIM, Math.round(h * RASTER_PAD * rs)))
    const ac = new AbortController()
    streamAbortRef.current = ac
    streamStartedRef.current = true
    streamDoneRef.current = false
    streamBoundsRef.current = null
    streamTotalRef.current = null
    streamPointCountRef.current = 0
    dataWorldRef.current = null
    // Resolve the coloring channel plan (density-only ⇒ byte-identical to Wave 2a).
    const plan = planChannels(colorByRef.current, d, resolveChannelRef.current, categorySlotsRef.current)
    boundValueKeyRef.current = plan.valueKey ?? null
    appliedColorByRef.current = colorByKeyOf(colorByRef.current)
    // Budget guard (item 16): when the source DECLARES a `total` over the retain-raw budget, ask the
    // worker to also grow a coarse base-grid data-cube during the stream, so a post-stream zoom re-bin
    // rolls it up (`base-grid`) at bounded per-zoom work. Undeclared/under-budget ⇒ no base grid; zoom
    // then re-bins the retained cloud EXACTLY (`retain-raw`) — always correct. `> ~100M` (server tile
    // pyramid) is out of scope here (see retainStrategy.ts::SERVER_TILE_PYRAMID_THRESHOLD).
    const declaredTotal = isObjectForm(d) && typeof d.total === 'number' ? d.total : null
    // color-by-label/value MUST retain the raw positions + channel so a zoom re-bin re-shades the
    // channel EXACTLY (the density-only base grid can't carry per-point label/value) — so a channel
    // plan forces the retain-raw path regardless of point count (channel coloring needs per-point data).
    const wantBaseGrid =
      plan.channels == null && declaredTotal != null && chooseRetainStrategy(declaredTotal) === 'base-grid'
    const baseGrid = wantBaseGrid
      ? { width: DEFAULT_BASE_GRID_DIM, height: DEFAULT_BASE_GRID_DIM }
      : undefined
    const source = normalizeVizData(plan.data, {
      signal: ac.signal,
      onTotal: (t) => {
        streamTotalRef.current = t
      },
    })
    streamHandleRef.current = client.streamRaster(
      source,
      { width: rw, height: rh, colormap: cm, normalize: nm, channels: plan.channels, mode: plan.mode, baseGrid, retainRaw: !wantBaseGrid },
      {
        onFrame: (image, meta) => {
          if (!mountedRef.current) return
          streamBoundsRef.current = meta.bounds
          const bounds: WorldRect = [meta.bounds.minX, meta.bounds.minY, meta.bounds.maxX, meta.bounds.maxY]
          const camera = viewRef.current as ViewportCamera
          const zoomRaw = Array.isArray(camera.zoom) ? camera.zoom[0] : (camera.zoom as number | undefined)
          const zoom = typeof zoomRaw === 'number' && Number.isFinite(zoomRaw) ? zoomRaw : 0
          setRaster({ image, bounds, world: meta.bounds, zoom })
          setFrameCount((c) => c + 1)
          if (meta.final) {
            streamDoneRef.current = true
            // The completed cloud's point count (drives `chooseRetainStrategy` at zoom time) + the
            // current bin world (the full streamed extent, tightened on a later zoom re-bin).
            streamPointCountRef.current = meta.rowsSeen
            dataWorldRef.current = meta.bounds
          }
        },
        onProgress: (rowsSeen) => {
          const total = streamTotalRef.current
          onProgressRef.current?.({
            rowsSeen,
            coveragePct: total && total > 0 ? Math.min(100, (rowsSeen / total) * 100) : null,
          })
        },
        onError: (err) => {
          if (!mountedRef.current) return
          setStreamError(err) // → a visible `<ChartError>`, never a permanent silent blank
          onErrorRef.current?.(err)
        },
      },
      { signal: ac.signal },
    )
  }, [])

  // Matrix bind-a-column (item 14): re-bind ONE value column over the RESIDENT positions (never
  // re-streaming the matrix). Called on a `{ value }` key change after the positions stream has
  // completed — positions stay resident (in the worker's `retained` / the fallback's folded cloud).
  const rebindValue = useCallback((key: string) => {
    const client = clientRef.current
    const bounds = streamBoundsRef.current
    if (!client || !bounds || !dataRef.current) return
    const src = resolveChannelInput(key, 'value', dataRef.current, resolveChannelRef.current)
    if (src == null) return
    const { w, h } = viewportRef.current
    if (w <= 0 || h <= 0) return
    const { colormap: cm, resolutionScale: rs } = shadeRef.current
    const rw = Math.max(1, Math.min(MAX_RASTER_DIM, Math.round(w * RASTER_PAD * rs)))
    const rh = Math.max(1, Math.min(MAX_RASTER_DIM, Math.round(h * RASTER_PAD * rs)))
    // Tear down any prior value bind (a rapid key switch supersedes the earlier column).
    valueBindHandleRef.current?.cancel()
    valueBindAbortRef.current?.abort()
    const ac = new AbortController()
    valueBindAbortRef.current = ac
    boundValueKeyRef.current = key
    const valueSource = (async function* () {
      for await (const b of normalizeChannelColumn(src, 'f32', { signal: ac.signal })) {
        yield { offset: b.offset, value: b.data as Float32Array }
      }
    })()
    valueBindHandleRef.current = client.bindValueColumn(
      valueSource,
      { bounds, width: rw, height: rh, colormap: cm },
      {
        onFrame: (image, meta) => {
          if (!mountedRef.current) return
          const wr: WorldRect = [meta.bounds.minX, meta.bounds.minY, meta.bounds.maxX, meta.bounds.maxY]
          const camera = viewRef.current as ViewportCamera
          const zoomRaw = Array.isArray(camera.zoom) ? camera.zoom[0] : (camera.zoom as number | undefined)
          const zoom = typeof zoomRaw === 'number' && Number.isFinite(zoomRaw) ? zoomRaw : 0
          setRaster({ image, bounds: wr, world: meta.bounds, zoom })
          setFrameCount((c) => c + 1)
        },
        onProgress: (rowsSeen) => {
          const total = streamTotalRef.current
          onProgressRef.current?.({
            rowsSeen,
            coveragePct: total && total > 0 ? Math.min(100, (rowsSeen / total) * 100) : null,
          })
        },
        onError: (err) => {
          if (!mountedRef.current) return
          setStreamError(err)
          onErrorRef.current?.(err)
        },
      },
      { signal: ac.signal },
    )
  }, [])

  // Create the worker-backed client once, retain the initial positions, and tear it down on
  // unmount (terminate the worker; late messages are ignored via `mountedRef`). Declared BEFORE
  // the measure/data effects so the client exists when they first rebin.
  useEffect(() => {
    const client = createCpuRasterClient()
    clientRef.current = client
    mountedRef.current = true
    // Whole-array mode: retain positions up front. Data (streaming) mode: nothing to retain — the
    // stream `beginStream`s once the viewport is measured (see the measure + stream-start effects).
    if (!dataRef.current) {
      const pk = packedRef.current
      if (pk) client.initPacked(pk.packed, pk)
      else if (positionsRef.current) client.init(positionsRef.current)
      initedRef.current = { positions: positionsRef.current ?? new Float32Array(0), epoch: dataEpochRef.current }
    }
    return () => {
      mountedRef.current = false
      streamHandleRef.current?.cancel()
      streamAbortRef.current?.abort()
      valueBindHandleRef.current?.cancel()
      valueBindAbortRef.current?.abort()
      client.terminate()
      clientRef.current = null
      initedRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Measure the canvas; a size change re-bins (immediately — the raster aspect must track).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      const changed = w !== viewportRef.current.w || h !== viewportRef.current.h
      viewportRef.current = { w, h }
      setViewportPx({ w, h })
      if (changed && w > 0 && h > 0) {
        // Data mode: first time the viewport is known → START the stream; later size changes
        // re-shade the retained cloud post-load (rebin no-ops while the stream is live).
        if (dataRef.current && !streamStartedRef.current) startStream()
        else rebin(viewRef.current)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebin, startStream])

  // Data-content change (stable ref + epoch) or a new positions reference → re-init the worker's
  // retained positions, then re-bin. Colormap/normalize/resolution changes re-bin WITHOUT a
  // re-init (positions unchanged) so N points are not re-transferred.
  useEffect(() => {
    const client = clientRef.current
    if (!client) return
    // Data (streaming) mode: never re-init from `positions`. A colormap/normalize/resolution change
    // re-shades the RETAINED cloud once the stream has completed; a `data`/`dataEpoch` change is
    // handled by the dedicated stream-start effect below.
    if (dataRef.current) {
      if (streamDoneRef.current && viewportRef.current.w > 0 && viewportRef.current.h > 0) {
        rebin(viewRef.current)
      }
      return
    }
    const prev = initedRef.current
    if (!prev || prev.positions !== positions || prev.epoch !== dataEpoch) {
      if (packed) client.initPacked(packed.packed, packed)
      else if (positions) client.init(positions)
      initedRef.current = { positions: positions ?? new Float32Array(0), epoch: dataEpoch }
    }
    if (viewportRef.current.w > 0 && viewportRef.current.h > 0) rebin(viewRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, packed, dataEpoch, colormap, normalize, resolutionScale, rebin])

  // Progressive stream START / RESTART on a `data` (or `dataEpoch`) change — the viz owns the whole
  // fetch→reframe→bin→emit→cancel pipeline. Absent `data` this is a no-op (byte-identical path).
  useEffect(() => {
    if (!dataRef.current) {
      // Left data mode → drop any live stream + value bind.
      streamHandleRef.current?.cancel()
      streamAbortRef.current?.abort()
      valueBindHandleRef.current?.cancel()
      valueBindAbortRef.current?.abort()
      streamHandleRef.current = null
      streamStartedRef.current = false
      return
    }
    streamStartedRef.current = false
    // A GENUINE data change (new key / epoch) may carry a NEW extent → re-fit the camera on the first
    // frame (B-M2: `fittedRef` otherwise latches true forever and a new dataset never auto-fits).
    fittedRef.current = false
    startStream() // starts now if the viewport is known; otherwise the measure effect starts it
    return () => {
      streamHandleRef.current?.cancel()
      streamAbortRef.current?.abort()
    }
    // Keyed on the STRUCTURAL `dataKey` (not raw `data` identity) so a stable-ref inline object rebuilt
    // each render does NOT restart the stream (B-H1). The latest `data` is read via `dataRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, dataEpoch, startStream])

  // COLOR-BY change (Wave 2b). A genuine `colorBy` change either (a) re-binds ONLY the value column
  // over the RESIDENT positions when only the `{ value }` KEY changed and the positions stream has
  // completed (the matrix bind-a-column fast path — positions never re-fetched), or (b) restarts the
  // stream with the new channel plan (a mode change, or a key change mid-stream). The initial mount
  // is a no-op here (`startStream` already applied the plan).
  useEffect(() => {
    if (!dataRef.current) return // non-`data` (whole-array) mode is density-only
    const sig = colorByKeyOf(colorBy)
    const prev = appliedColorByRef.current
    if (prev == null) {
      appliedColorByRef.current = sig
      return // initial application handled by startStream
    }
    if (prev === sig) return
    appliedColorByRef.current = sig
    const cb = colorByRef.current
    const valueKeyOnly =
      typeof cb === 'object' && 'value' in cb && prev.startsWith('value:') && sig.startsWith('value:')
    if (valueKeyOnly && streamDoneRef.current && streamBoundsRef.current) {
      rebindValue((cb as { value: string }).value) // keep positions resident; re-bind one column
      return
    }
    // Mode change (or a key change before the stream completed) → restart with the new plan.
    streamStartedRef.current = false
    startStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorBy, rebindValue, startStream])

  useEffect(
    () => () => {
      if (debounceTimer.current != null) clearTimeout(debounceTimer.current)
    },
    [],
  )

  const handleViewStateChange = useCallback(
    (params: { viewState: OrthographicViewState }) => {
      const vs = params.viewState
      viewRef.current = vs
      // In `data` mode the controlled camera is kept in sync so the user owns it after the initial
      // fit. Post-stream (item 16), a genuine ZOOM — or a pan PAST the padded margin — schedules a
      // debounced re-bin of the RETAINED cloud at the TIGHTER viewport bounds (crisp detail); a pan
      // WITHIN the margin stays a FREE reproject of the fixed quad (0 re-bin). During the stream
      // (`!streamDone`) the stream owns frames, so we only reproject.
      if (dataRef.current) {
        setDataViewState(vs)
        const cur = rasterRef.current
        if (streamDoneRef.current && cur) {
          const should = shouldRebinForView({
            rasterWorld: cur.world,
            rasterZoom: cur.zoom,
            camera: vs as ViewportCamera,
            viewportW: viewportRef.current.w,
            viewportH: viewportRef.current.h,
          })
          if (should) scheduleDataZoomRebin(vs as ViewportCamera)
        }
        onViewStateChange?.(vs)
        return
      }
      const cur = rasterRef.current
      if (cur) {
        const camera = vs as ViewportCamera
        const zoomRaw = Array.isArray(camera.zoom) ? camera.zoom[0] : (camera.zoom as number | undefined)
        const zoom = typeof zoomRaw === 'number' && Number.isFinite(zoomRaw) ? zoomRaw : 0
        const worldNow = viewportWorldBounds(camera, viewportRef.current.w, viewportRef.current.h)
        const zoomChanged = Math.abs(zoom - cur.zoom) > 1e-6
        // Pan that stayed inside the padded raster AND same zoom ⇒ 0 re-bin (fixed-quad reproject).
        if (zoomChanged || !contains(cur.world, worldNow)) {
          scheduleRebin(camera)
        }
      } else {
        scheduleRebin(vs as ViewportCamera)
      }
      onViewStateChange?.(vs)
    },
    [scheduleRebin, scheduleDataZoomRebin, onViewStateChange],
  )

  const layers = useMemo(() => {
    if (!raster) return []
    return [
      new BitmapLayer({
        id: 'cpu-raster-image',
        // deck.gl v9 uploads a raw `{ data, width, height }` object as a texture whose RGB comes out
        // ZERO (a BLACK quad — only alpha survives); `toBitmapImage` wraps it in an `ImageData` so the
        // real viridis raster renders. Same fix HeatmapView already uses. See cpuRaster.ts.
        image: toBitmapImage(raster.image),
        bounds: [...raster.bounds] as [number, number, number, number],
        pickable: false,
        // NEAREST keeps the density cells crisp rather than blurring the low-res grid.
        textureParameters: {
          minFilter: 'nearest',
          magFilter: 'nearest',
        },
      } as never),
    ]
  }, [raster])

  // A cheap checksum of the COMMITTED raster RGBA — exposed on `data-raster-hash` so an e2e can prove
  // a re-SHADE (a colorBy change) actually produced a DIFFERENT raster at the source. The composited
  // canvas signature can't detect this when sparse cells collapse to near-black under alpha; this
  // reads the raw shaded bytes, so density-viridis vs category-hue differ even when both render dark.
  const rasterHash = useMemo(() => {
    if (!raster) return '0'
    const d = raster.image.rgba
    let h = 0
    for (let i = 0; i < d.length; i += 97) h = (Math.imul(h, 31) + d[i] + i) >>> 0
    return h.toString(16)
  }, [raster])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="viz-cpu-raster-view"
      data-raster-ready={raster ? '1' : '0'}
      data-frame-count={frameCount}
      data-raster-hash={rasterHash}
      data-viewport={`${viewportPx.w}x${viewportPx.h}`}
      data-stream-error={streamError !== null ? '1' : '0'}
    >
      {streamError !== null ? (
        // A failed stream surfaces a VISIBLE error (never a permanent silent blank raster).
        <ChartError message={errorMessage(streamError)} />
      ) : (
        <DeckGL
          views={view}
          controller
          {...(data
            ? { viewState: (controlledViewState ?? dataViewState ?? viewRef.current) as never }
            : { initialViewState: viewRef.current })}
          onViewStateChange={handleViewStateChange as never}
          {...(overlap ? { onHover: handleRasterHover as never } : {})}
          layers={layers}
        />
      )}
      {overlap?.render(theme)}
    </div>
  )
}
