// retainStrategy.ts — the RETAIN-RAW vs BASE-GRID memory-budget decision + the pure primitives the
// data-mode ZOOM RE-BIN drives through (STREAMING_PROGRESSIVE_PLAN Wave 2c, item 16).
//
// Today (Wave 2a/2b) a `<Viz data>` stream bins the DATA extent once and a post-stream zoom just
// REPROJECTS that fixed raster (blurry when zoomed in). Item 16: on zoom, RE-BIN the retained
// streamed cloud at the new (tighter) viewport bounds → crisp detail — guarded by a memory budget:
//
//   • ≤ RETAIN_MAX_POINTS (a documented threshold / byte budget) → `retain-raw`: the worker keeps
//     the raw streamed positions and does an EXACT re-bin over them at the tighter bounds
//     (`requestBin` over the retained cloud — pixel-accurate at any zoom).
//   • above it → `base-grid`: the raster is served from a COARSE high-res base count grid (a global
//     data-cube) that rolls up ADDITIVELY for zoom-out and CROPS for zoom-in — bounded detail,
//     constant memory / bounded per-zoom work regardless of N (via {@link baseGridRollup}).
//   • > SERVER_TILE_PYRAMID_THRESHOLD (~100M) → OUT OF SCOPE here (lib-only): the binning must move
//     server-side (Datashader-style quadtree tile pyramid, pre-binned rasters streamed as tiles). See
//     the constant's doc — this module marks where the CLIENT strategy ends.
//
// No deck.gl / DOM / React dependency: plain math over counts + camera geometry, so it unit-tests in
// node. Domain-neutral (counts + world rects only).

import { cellForPoint, type DensityBounds } from '../density/densityBin'
import { viewportWorldBounds, type ViewportCamera } from './lod'

export type RetainStrategy = 'retain-raw' | 'base-grid'

/**
 * Point ceiling for the exact `retain-raw` path. At the f32-interleaved default (8 B/point) ~15M
 * points ≈ 120 MB of retained positions — the "keep it all, re-bin exactly at any zoom" regime the
 * plan blesses (see the retain-vs-cube decision line). Above it we cross into `base-grid`.
 */
export const RETAIN_MAX_POINTS = 15_000_000

/** Byte budget for the retained raw positions (128 MiB). The SECOND guard alongside the point cap:
 *  a wide `bytesPerPoint` (extra retained channels) trips this before the point cap. */
export const RETAIN_RAW_BYTE_BUDGET = 128 * 1024 * 1024

/** Retained bytes per point — f32 interleaved xy = 8 B (16-bit packed xy would be 4). */
export const RETAIN_BYTES_PER_POINT = 8

/**
 * DOCUMENTED upper boundary of the CLIENT strategy. Beyond ~100M points neither retain-raw (~800 MB
 * at 8 B/pt) nor a client base-grid can keep pace; the binning must move SERVER-SIDE (a Datashader-
 * style quadtree tile pyramid streamed as pre-binned rasters — constant client memory, detail bounded
 * by tile resolution). NOT built here — this is the seam where item 16's client work stops.
 */
export const SERVER_TILE_PYRAMID_THRESHOLD = 100_000_000

/**
 * Default base-grid resolution — a coarse GLOBAL data-cube of `DEFAULT_BASE_GRID_DIM²` cells
 * (2048² ≈ 32 MB float64), CONSTANT memory regardless of N. It rolls up additively for zoom-out and
 * crops for zoom-in; zoom-in detail is bounded by this resolution (the base-grid tradeoff).
 */
export const DEFAULT_BASE_GRID_DIM = 2048

export interface RetainStrategyOptions {
  /** bytes per retained point (default {@link RETAIN_BYTES_PER_POINT} = 8, f32 xy). */
  readonly bytesPerPoint?: number
  /** retained-cloud byte budget (default {@link RETAIN_RAW_BYTE_BUDGET}). */
  readonly byteBudget?: number
  /** hard point cap (default {@link RETAIN_MAX_POINTS}). */
  readonly maxPoints?: number
}

/**
 * Decide whether a streamed cloud of `pointCount` points is re-binned EXACTLY over the retained raw
 * positions (`retain-raw`) or served from the bounded base-grid roll-up (`base-grid`). `retain-raw`
 * requires BOTH guards to pass — the point cap AND the byte budget; either exceeded ⇒ `base-grid`.
 * A non-finite / negative count is treated as 0 (retain-raw). Pure + deterministic.
 */
export function chooseRetainStrategy(
  pointCount: number,
  opts: RetainStrategyOptions = {},
): RetainStrategy {
  const n = Number.isFinite(pointCount) ? Math.max(0, Math.floor(pointCount)) : 0
  const bpp = Math.max(1, Math.floor(opts.bytesPerPoint ?? RETAIN_BYTES_PER_POINT))
  const maxPoints = Math.max(0, Math.floor(opts.maxPoints ?? RETAIN_MAX_POINTS))
  const byteBudget = Math.max(0, Math.floor(opts.byteBudget ?? RETAIN_RAW_BYTE_BUDGET))
  const fitsPoints = n <= maxPoints
  const fitsBytes = n * bpp <= byteBudget
  return fitsPoints && fitsBytes ? 'retain-raw' : 'base-grid'
}

/**
 * Roll up / crop a coarse BASE count grid (row-major, `baseW × baseH` over `baseBounds`) into a
 * TARGET raster grid (`targetW × targetH` over `targetBounds`) — the pure primitive the `base-grid`
 * strategy re-bins through. Work is O(baseCells), INDEPENDENT of the point count N:
 *   • zoom-OUT / overview (target ⊇ base extent, or coarser): many base cells map into one target
 *     cell → summed (ADDITIVE roll-up — every source point counted once through its base cell).
 *   • zoom-IN / pan (target ⊂ base extent): base cells whose center lies OUTSIDE `targetBounds` are
 *     dropped (CROP); survivors distribute at BASE resolution, so zoom-in detail is bounded by the
 *     base grid (the documented tradeoff vs. an exact retain-raw re-bin).
 * Each populated base cell's CENTER is scattered into the target grid via the shared `cellForPoint`
 * (row 0 = `minY`; flipY is applied later at shade time), so the output is byte-consistent with the
 * density path and can be handed straight to `shadeCounts`.
 */
export function baseGridRollup(
  base: ArrayLike<number>,
  baseW: number,
  baseH: number,
  baseBounds: DensityBounds,
  targetBounds: DensityBounds,
  targetW: number,
  targetH: number,
): Float64Array {
  const bw = Math.max(1, Math.floor(baseW))
  const bh = Math.max(1, Math.floor(baseH))
  const tw = Math.max(1, Math.floor(targetW))
  const th = Math.max(1, Math.floor(targetH))
  const out = new Float64Array(tw * th)
  const spanX = baseBounds.maxX - baseBounds.minX
  const spanY = baseBounds.maxY - baseBounds.minY
  for (let r = 0; r < bh; r++) {
    const cy = baseBounds.minY + ((r + 0.5) / bh) * spanY
    const rowBase = r * bw
    for (let c = 0; c < bw; c++) {
      const v = base[rowBase + c]
      if (!(v > 0)) continue
      const cx = baseBounds.minX + ((c + 0.5) / bw) * spanX
      const cell = cellForPoint(cx, cy, targetBounds, tw, th)
      if (cell >= 0) out[cell] += v
    }
  }
  return out
}

/** True when world rect `inner` is fully contained in `outer` (a pan that stayed on the raster). */
export function rectContains(outer: DensityBounds, inner: DensityBounds): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  )
}

/** Inputs to {@link shouldRebinForView} — the current raster's binned rect + zoom vs the new camera. */
export interface RebinDecisionInput {
  /** the world rect the CURRENTLY-committed raster was binned over. */
  readonly rasterWorld: DensityBounds
  /** the zoom the current raster was binned at. */
  readonly rasterZoom: number
  /** the NEW camera after the view-state change. */
  readonly camera: ViewportCamera
  readonly viewportW: number
  readonly viewportH: number
  /** zoom-equality epsilon (default 1e-6). */
  readonly zoomEpsilon?: number
}

/**
 * The ZOOM-vs-PAN-margin decision (item 16). Returns `true` — schedule a re-bin over the tighter
 * viewport bounds — when the camera ZOOMED (zoom changed beyond the epsilon) OR PANNED PAST the
 * padded raster margin (the new viewport world rect no longer sits inside the binned rect). Returns
 * `false` for a pan that stayed WITHIN the margin, which the caller serves as a FREE reproject of the
 * fixed quad (0 re-bin). This is the SAME machinery the Phase-1 (non-data) path already uses, here
 * targeting the RETAINED streamed cloud.
 */
export function shouldRebinForView(input: RebinDecisionInput): boolean {
  const eps = input.zoomEpsilon ?? 1e-6
  const raw = Array.isArray(input.camera.zoom)
    ? input.camera.zoom[0]
    : (input.camera.zoom as number | undefined)
  const zoomNow = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
  const zoomChanged = Math.abs(zoomNow - input.rasterZoom) > eps
  if (zoomChanged) return true
  const worldNow = viewportWorldBounds(input.camera, input.viewportW, input.viewportH)
  return !rectContains(input.rasterWorld, worldNow)
}
