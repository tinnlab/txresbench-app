// ChunkedScatter.tsx — the 10M+ multi-chunk GPU scatter (ITEM-62). Framework-agnostic
// (viz-core): depends ONLY on @deck.gl/* + react. The COMPLEMENT to DeckScatterCanvas —
// where that path uploads ONE big binary buffer as a single ScatterplotLayer (great to a
// few million points, risky at 10M+ where a single attribute buffer can hit GPU
// max-buffer-size limits and stalls the thread during upload), this path splits the shared
// positions/colors buffers into N chunks under a per-layer VRAM budget and renders ONE
// ScatterplotLayer PER CHUNK — all inside a SINGLE DeckGL / OrthographicView (one WebGL
// context). Each layer is fed a ZERO-COPY `.subarray` view of the shared big typed arrays
// (via planChunks + subarrayView) — no per-chunk allocation, no copy — so per-layer VRAM
// is capped and uploads are incremental.

import { useCallback, useEffect, useMemo } from 'react'
import { DeckGL } from '@deck.gl/react'
import { OrthographicView, type OrthographicViewState } from '@deck.gl/core'
import { ScatterplotLayer } from '@deck.gl/layers'
import { buildScatterProps } from '../layers/scatter'
import { planChunks, subarrayView, strideSample, bytesPerPoint, type ChunkPlan } from './chunking'
import { chunkOrdinalFromLayerId, globalIndexFor } from './chunkPicking'

/** What `ChunkedScatter` actually rendered, surfaced to a parent readout / tests. When the
 *  full dataset is over the aggregate VRAM budget, an LOD stride is applied BEFORE chunking:
 *  `plan` is the original full-dataset budget plan (verdict + recommended stride) while
 *  `renderPlan` describes the reduced set that was really uploaded. When within budget the
 *  two are identical and `lodApplied` is false (byte-for-byte the full-detail path). */
export interface ChunkRenderPlan {
  /** budget plan over the FULL dataset — carries `verdict` + recommended `lodStride`. */
  plan: ChunkPlan
  /** plan for the set actually rendered (== `plan` unless LOD downsampling was applied). */
  renderPlan: ChunkPlan
  /** true when the dataset was over-budget and a stride was applied before chunking. */
  lodApplied: boolean
  /** effective downsample stride applied (1 = full detail). */
  lodStride: number
  /** original full-dataset point count. */
  sourceTotal: number
  /** points actually rendered (= `renderPlan.total`). */
  shownTotal: number
}

export interface ChunkedScatterProps {
  /** interleaved xy Float32Array, length N*2 (the shared big buffer — never copied). */
  positions: Float32Array
  /** RGBA Uint8Array, length N*4 (the shared big buffer — never copied). */
  colors: Uint8Array
  /** hard per-layer point cap (default 1M — a safe single-attribute upload size). */
  maxPointsPerChunk?: number
  /** per-layer (per-chunk) VRAM byte budget (default 64 MB). */
  gpuByteBudget?: number
  /** max simultaneous layers before the plan recommends an LOD overview (default 256). */
  maxChunks?: number
  radius?: number
  additive?: boolean
  initialViewState?: Partial<OrthographicViewState>
  /** surfaced whenever the plan (re)computes — for a parent readout / tests. Carries both the
   *  full-dataset budget plan and (if over-budget) the reduced LOD render plan. */
  onPlan?: (render: ChunkRenderPlan) => void
  /**
   * Fired on hover with the GLOBAL point index the pick resolves to (`null` when the cursor
   * leaves all points). deck's `info.index` is LOCAL to a chunk layer; this maps it back to a
   * point index in the rendered buffer (chunk `start` + local index). When an LOD stride is
   * active the index is into the DOWNSAMPLED rendered set (the point the user hovered in the
   * overview), not the source dataset — see `chunkPicking.ts`. */
  onPick?: (globalIndex: number | null) => void
}

/** Test hook: the last global index a chunk pick resolved to (mirrors `onPick`). */
interface VizTestHook {
  pickedGlobalIndex?: number | null
}

const DEFAULT_MAX_POINTS_PER_CHUNK = 1_000_000
const DEFAULT_GPU_BYTE_BUDGET = 64 * 1024 * 1024 // 64 MB per layer
const DEFAULT_VIEW_STATE: OrthographicViewState = {
  target: [0, 0, 0],
  zoom: 4,
} as OrthographicViewState

/**
 * N ScatterplotLayers (one per chunk) over ONE DeckGL/OrthographicView. Each layer binds a
 * zero-copy subarray of the shared positions/colors — the multi-chunk 10M tier. Uncontrolled
 * (initialViewState + controller): panning/zooming runs Deck-internally with no React
 * re-render, and the layer array is rebuilt only when the plan / buffers change.
 */
export function ChunkedScatter({
  positions,
  colors,
  maxPointsPerChunk = DEFAULT_MAX_POINTS_PER_CHUNK,
  gpuByteBudget = DEFAULT_GPU_BYTE_BUDGET,
  maxChunks,
  radius = 2,
  additive = false,
  initialViewState,
  onPlan,
  onPick,
}: ChunkedScatterProps) {
  const total = Math.floor(positions.length / 2)

  // 12 B/point for the position+color layout this canvas uploads.
  const bpp = useMemo(() => bytesPerPoint({ position: true, color: true }), [])

  const view = useMemo(() => new OrthographicView({ id: 'ortho', flipY: false }), [])

  // Budget plan over the FULL dataset. When it fits (`ok`), this is the plan we render from
  // (full detail, zero-copy). When it's `over-budget`, its `lodStride` is the downsample
  // factor that brings the visible count within the aggregate VRAM capacity.
  const plan = useMemo(
    () => planChunks(total, { maxPointsPerChunk, gpuByteBudget, bytesPerPoint: bpp, maxChunks }),
    [total, maxPointsPerChunk, gpuByteBudget, bpp, maxChunks],
  )

  // If over-budget, apply the recommended LOD stride BEFORE chunking: build a downsampled
  // copy of positions/colors (every Nth point — a strided pick can't be a zero-copy view, so
  // this allocates ONCE here, memoised, never per frame), then RE-PLAN on the reduced count
  // (now within budget) and render THAT. This is what actually enforces the budget the plan
  // recommended — without it, `plan.chunks` covers 100% of the points in an uncapped number
  // of layers, defeating the LOD overview. When within budget, render buffers/plan are the
  // originals untouched (byte-for-byte the full-detail path).
  const render = useMemo<{
    positions: Float32Array
    colors: Uint8Array
    renderPlan: ChunkPlan
    lodApplied: boolean
    lodStride: number
  }>(() => {
    if (plan.verdict === 'over-budget' && plan.lodStride > 1) {
      const stride = plan.lodStride
      const dsPositions = strideSample(positions, stride, 2)
      const dsColors = strideSample(colors, stride, 4)
      const reducedTotal = Math.floor(dsPositions.length / 2)
      const renderPlan = planChunks(reducedTotal, {
        maxPointsPerChunk,
        gpuByteBudget,
        bytesPerPoint: bpp,
        maxChunks,
      })
      return { positions: dsPositions, colors: dsColors, renderPlan, lodApplied: true, lodStride: stride }
    }
    return { positions, colors, renderPlan: plan, lodApplied: false, lodStride: 1 }
  }, [plan, positions, colors, maxPointsPerChunk, gpuByteBudget, bpp, maxChunks])

  useEffect(() => {
    onPlan?.({
      plan,
      renderPlan: render.renderPlan,
      lodApplied: render.lodApplied,
      lodStride: render.lodStride,
      sourceTotal: total,
      shownTotal: render.renderPlan.total,
    })
  }, [plan, render, total, onPlan])

  // One ScatterplotLayer per chunk, each fed ZERO-COPY subarray views (stride 2 for xy,
  // 4 for RGBA) of the (possibly LOD-reduced) render buffers — no per-chunk allocation.
  const layers = useMemo(
    () =>
      render.renderPlan.chunks.map(chunk => {
        const pos = subarrayView(render.positions, chunk, 2)
        const col = subarrayView(render.colors, chunk, 4)
        const props = buildScatterProps({
          id: `chunk-${chunk.index}`,
          positions: pos,
          colors: col,
          radius,
          additive,
          // Picking ON per chunk (ITEM-62): deck reports a chunk-LOCAL `info.index` on hover;
          // `onDeckHover` below maps it back to the global rendered index via the chunk's start.
          pickable: true,
        })
        return new ScatterplotLayer(props)
      }),
    [render, radius, additive],
  )

  const viewState = useMemo(
    () => ({ ...DEFAULT_VIEW_STATE, ...initialViewState }),
    [initialViewState],
  )

  // Cross-chunk picking (ITEM-62): resolve deck's chunk-LOCAL `info.index` to a GLOBAL index in
  // the rendered buffer. The picked layer id is `chunk-<ordinal>`; the ordinal is the chunk's
  // array position (planChunks emits `index === position`), so `chunk.start + info.index` is the
  // global index. Surfaced via `onPick` + a `window.__VIZ_TEST__.pickedGlobalIndex` hook.
  const onDeckHover = useCallback(
    (info: { index: number; layer?: { id?: string } | null }) => {
      const ordinal = chunkOrdinalFromLayerId(info?.layer?.id)
      const global =
        info && info.index >= 0 && ordinal >= 0
          ? globalIndexFor(render.renderPlan.chunks, ordinal, info.index)
          : -1
      const picked = global >= 0 ? global : null
      onPick?.(picked)
      if (typeof window !== 'undefined') {
        const w = window as unknown as { __VIZ_TEST__?: VizTestHook }
        w.__VIZ_TEST__ = { ...(w.__VIZ_TEST__ ?? {}), pickedGlobalIndex: picked }
      }
    },
    [render.renderPlan.chunks, onPick],
  )

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      data-testid="viz-chunked-scatter"
    >
      <DeckGL
        views={view}
        controller
        initialViewState={viewState}
        layers={layers}
        onHover={onDeckHover as never}
      />
      <div
        data-testid="viz-chunk-readout"
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          pointerEvents: 'none',
          fontSize: 12,
          opacity: 0.7,
        }}
      >
        {render.lodApplied
          ? `${total.toLocaleString()} pts → LOD ${render.lodStride}× → ` +
            `${render.renderPlan.total.toLocaleString()} shown in ${render.renderPlan.chunkCount} chunks`
          : `${render.renderPlan.chunkCount} chunks · ${total.toLocaleString()} pts · ` +
            `${(plan.bytesEstimate / (1024 * 1024)).toFixed(1)} MB`}
      </div>
    </div>
  )
}
