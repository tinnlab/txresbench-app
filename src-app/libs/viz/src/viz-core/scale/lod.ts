// lod.ts — pure LOD-while-interacting policy for the large-N scatter path (companion to
// chunking.ts). The 10M pan/zoom stall isn't the GPU drawing dots — it's the per-frame
// cost of pushing 10M instances through the pipeline (+ the GC stalls a churny heap feeds).
// While the CAMERA IS MOVING we don't need every point on screen: a uniform strided subset
// (~1M) is visually indistinguishable in motion and renders ~10× cheaper, so pan/zoom stays
// smooth. The instant the camera SETTLES we swap back to the full N for full detail.
//
// This module is the pure decision core (no deck.gl / DOM / React) so it unit-tests in node:
// it decides the stride, whether to engage, and the resulting visible count. The component
// (DeckScatterCanvas) owns the "interacting" flag + the (memoised, once-per-stride) strided
// picks. Generic naming — framework/domain-agnostic scale infra.

import { lodStride } from './chunking'
import type { DensityBounds } from '../density/densityBin'

/** Engage LOD only ABOVE this point count — at/below it the full set already pans at 60fps,
 *  so downsampling would only add a (visible) detail drop for no gain. */
export const LOD_THRESHOLD = 1_500_000

/** Target visible count while interacting: stride is chosen so ~this many points render.
 *  ALSO the FIXED on-screen point BUDGET for the adaptive sampler (research item #4/Potree):
 *  the drawn point count is capped here regardless of N, for a constant frame cost. */
export const LOD_TARGET = 1_000_000

/** Debounce: how long after the LAST camera change before we call the camera "settled" and
 *  render the full set again. Short enough to feel instant, long enough to bridge the gaps
 *  between discrete wheel/drag events of one continuous gesture. */
export const LOD_IDLE_MS = 150

/**
 * The integer stride to render during camera motion for a dataset of `n` points. Returns 1
 * (no downsampling — full detail) at or below `threshold`; above it, `ceil(n / target)` so the
 * strided subset is capped at ~`target` points. Uniform stride (every k-th point), never a
 * spatial gap, so the motion overview stays representative of the whole cloud.
 */
export function lodStrideForCount(
  n: number,
  threshold: number = LOD_THRESHOLD,
  target: number = LOD_TARGET,
): number {
  const total = Math.max(0, Math.floor(n))
  if (total <= Math.max(0, Math.floor(threshold))) return 1
  return lodStride(total, Math.max(1, Math.floor(target)))
}

/** Whether to render the downsampled subset RIGHT NOW: only while interacting AND a real
 *  stride (>1) is in effect. Below the threshold (`stride === 1`) LOD is always off. */
export function shouldUseLod(interacting: boolean, stride: number): boolean {
  return interacting && stride > 1
}

/** Points visible under a stride = `ceil(n / stride)` (matches `strideSample`'s kept-count). */
export function lodVisibleCount(n: number, stride: number): number {
  const total = Math.max(0, Math.floor(n))
  const s = Math.max(1, Math.floor(stride))
  return Math.ceil(total / s)
}

// ── Density-aggregate auto-switch (research item #1 integration) ──────────────────
//
// At the extreme zoom-out tier a screen is only ~1-2M pixels, so once the points visible in the
// viewport vastly outnumber the pixels, even the budgeted/adaptive point sample draws >1 point
// per pixel — pure overdraw that reads as a flat blob. There, the GPU density-aggregate image
// (DensityView / ScreenGridLayer) is both cheaper (cost ∝ cells, not points) AND more honest
// (it SHOWS the density instead of a saturated smear). We switch INTO that image automatically
// and switch back to points the moment zooming in drops the visible count under the budget.
//
// Two guards keep it safe:
//   • It only engages for genuinely large datasets (`n > DENSITY_MIN_N`), so 1M-and-below is
//     byte-for-byte the existing point path — no behaviour change for the common case.
//   • HYSTERESIS: the enter threshold is well above the exit threshold, so a camera hovering
//     right at the boundary can't oscillate between images frame to frame.

/** Only auto-switch to the density image for datasets larger than this (opt-in-safe). */
export const DENSITY_MIN_N = 3_000_000

/** ENTER the density image when the viewport holds ≥ this many points PER PIXEL (≫ 1 px⁻¹). */
export const DENSITY_ENTER_PPP = 2.0

/** LEAVE the density image (back to points) when density drops below this — hysteresis band. */
export const DENSITY_EXIT_PPP = 0.75

export interface DensitySwitchParams {
  /** total dataset size N. */
  n: number
  /** ESTIMATED points currently inside the viewport (see `estimateVisiblePoints`). */
  estimatedVisiblePoints: number
  /** viewport area in device-independent pixels (width × height). */
  pixels: number
  /** whether the density image is showing RIGHT NOW (drives the hysteresis branch). */
  currentlyDensity: boolean
  minN?: number
  enterPpp?: number
  exitPpp?: number
}

/**
 * Decide whether to render the density-aggregate image (vs points) — the pure, hysteretic core.
 * Returns `false` for small N (`≤ minN`) unconditionally. Otherwise compares the viewport point
 * DENSITY (points ÷ pixels) against an ENTER threshold when currently drawing points, or an EXIT
 * threshold when currently drawing density (`enterPpp > exitPpp` ⇒ a dead band ⇒ no oscillation).
 */
export function shouldUseDensity(params: DensitySwitchParams): boolean {
  const minN = params.minN ?? DENSITY_MIN_N
  if (Math.floor(params.n) <= Math.floor(minN)) return false
  const pixels = Math.max(1, params.pixels)
  const density = Math.max(0, params.estimatedVisiblePoints) / pixels
  const enter = params.enterPpp ?? DENSITY_ENTER_PPP
  const exit = params.exitPpp ?? DENSITY_EXIT_PPP
  return params.currentlyDensity ? density > exit : density >= enter
}

/** An orthographic camera pose sufficient to derive the visible world rectangle. */
export interface ViewportCamera {
  /** world-space camera target `[x, y]` (screen center). */
  readonly target?: readonly number[]
  /** deck OrthographicView zoom (log₂): device pixels per world unit = 2^zoom. deck allows a
   *  per-axis `[zx, zy]`; the scalar x-zoom is used (square pixels assumed). */
  readonly zoom?: number | readonly number[]
}

/**
 * The world-space rectangle currently visible for an OrthographicView of `pixelW × pixelH`
 * pixels at the given camera. deck's OrthographicView maps `2^zoom` pixels per world unit, so
 * the half-extent in world units is `(pixels / 2) / 2^zoom`. A non-finite/degenerate camera
 * collapses to a zero-area rect at the origin.
 */
export function viewportWorldBounds(
  camera: ViewportCamera,
  pixelW: number,
  pixelH: number,
): DensityBounds {
  const rawZoom = Array.isArray(camera.zoom) ? camera.zoom[0] : (camera.zoom as number | undefined)
  const zoom = typeof rawZoom === 'number' && Number.isFinite(rawZoom) ? rawZoom : 0
  const scale = 2 ** zoom
  const cx = camera.target?.[0] ?? 0
  const cy = camera.target?.[1] ?? 0
  const halfW = Math.max(0, pixelW) / 2 / scale
  const halfH = Math.max(0, pixelH) / 2 / scale
  return { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH }
}

/**
 * A cheap UNIFORM estimate of how many of `n` points fall inside `view`: `n × (overlap area of
 * view ∩ data) / (data area)`. Clamped to `[0, n]`. It assumes uniform spatial density, so it
 * under/over-counts clustered data — fine for a hysteretic mode switch (the decision only needs
 * to know "far more points than pixels" vs "fewer points than pixels", not an exact count).
 */
export function estimateVisiblePoints(
  n: number,
  view: DensityBounds,
  data: DensityBounds,
): number {
  const total = Math.max(0, Math.floor(n))
  const dataW = data.maxX - data.minX
  const dataH = data.maxY - data.minY
  const dataArea = dataW * dataH
  // Degenerate data extent (a collinear/coincident cloud: spanX==0 or spanY==0 ⇒ zero area).
  // Returning `total` here would make the estimate CAMERA-INDEPENDENT, so `shouldUseDensity`
  // would stay above EXIT_PPP at every zoom and lock the view into the density image forever
  // (zoom-in never restores points). Return 0 instead — a degenerate embedding must never
  // force density mode, and the estimate stays exitable/zoom-modulated as the caller expects.
  if (!(dataArea > 0)) return 0
  const ox = Math.max(0, Math.min(view.maxX, data.maxX) - Math.max(view.minX, data.minX))
  const oy = Math.max(0, Math.min(view.maxY, data.maxY) - Math.max(view.minY, data.minY))
  const fraction = Math.min(1, (ox * oy) / dataArea)
  return total * fraction
}
