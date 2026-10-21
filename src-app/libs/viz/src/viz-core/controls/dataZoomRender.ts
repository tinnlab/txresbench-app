// dataZoomRender.ts — the SHARED dataZoom range-slider renderer. ONE geometry
// (`computeDataZoomLayout`) drives BOTH the on-screen rail (`drawDataZoomCanvas` → a 2D canvas)
// AND the export (`dataZoomToMarks` → VectorScene marks), so the exported chart's range-zoom
// slider is pixel-identical to the on-screen one (the ECharts single-surface / WYSIWYG model).
//
// The control = a light TRACK spanning the rail + a highlighted WINDOW band (the zoomed [lo,hi]
// fraction) + TWO HANDLES at the window edges. The window is given as a [loFrac,hiFrac] in 0..1
// rail space (from `axisWindow.windowToFraction`). Horizontal: left=0→right=1. Vertical: the same
// fraction runs bottom(0)→top(1) — matching `DragRail`. PURE (no react/deck/DOM in the geometry +
// marks; the canvas draw takes a 2D context). Node-testable.

import type { VectorMark, VectorScene } from '../export/vector'
import { LIGHT_THEME, type VizTheme } from '../theme'

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}
export type DataZoomOrientation = 'horizontal' | 'vertical'

export interface DataZoomLayout {
  readonly box: Box
  readonly orientation: DataZoomOrientation
  /** the light track rect (fills the rail). */
  readonly track: Box
  /** the highlighted window band rect (the zoomed [lo,hi] fraction). */
  readonly band: Box
  /** the two handle rects (at the lo + hi window edges). */
  readonly handles: readonly [Box, Box]
}

// Look constants — MATCH `DragRail`'s DOM chrome so screen==export:
//   track  rgba(127,127,127,0.22) rounded; band rgba(120,150,255,0.18); handle surface + fg border.
const TRACK_FILL = 'rgba(127,127,127,0.22)'
const BAND_FILL = 'rgba(120,150,255,0.20)'
const HANDLE_T = 8 // handle thickness across the rail's long axis

/** fraction (0..1) → pixel position along the box's long axis. Horizontal: left→right.
 *  Vertical: bottom→top (frac 0 = bottom), matching DragRail. */
function fracToPx(frac: number, box: Box, orientation: DataZoomOrientation): number {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac
  return orientation === 'horizontal' ? box.x + f * box.w : box.y + box.h * (1 - f)
}

/** Compute the full geometry of the dataZoom rail inside `box`. Pure. `window` = [loFrac,hiFrac] 0..1.
 *  `scale` multiplies the fixed-pixel chrome (handle thickness + overhang) so the SAME CSS-px look
 *  can be drawn into a device-pixel EXPORT scene (scale = dpr) while the on-screen canvas — which is
 *  itself ctx-scaled by dpr — uses the default `scale = 1`. Keeps screen == export on HiDPI. */
export function computeDataZoomLayout(
  box: Box,
  window: readonly [number, number],
  orientation: DataZoomOrientation,
  scale = 1,
): DataZoomLayout {
  const lo = Math.max(0, Math.min(window[0], window[1]))
  const hi = Math.min(1, Math.max(window[0], window[1]))
  const ht = HANDLE_T * scale // handle thickness across the long axis
  const over = scale // handle overhang past the rail's short axis (was a fixed 1px)
  const track: Box = { ...box }
  let band: Box
  let handles: [Box, Box]
  if (orientation === 'horizontal') {
    const xLo = fracToPx(lo, box, orientation)
    const xHi = fracToPx(hi, box, orientation)
    band = { x: xLo, y: box.y, w: Math.max(1, xHi - xLo), h: box.h }
    handles = [
      { x: xLo - ht / 2, y: box.y - over, w: ht, h: box.h + 2 * over },
      { x: xHi - ht / 2, y: box.y - over, w: ht, h: box.h + 2 * over },
    ]
  } else {
    const yLo = fracToPx(lo, box, orientation) // bottom of window (frac lo)
    const yHi = fracToPx(hi, box, orientation) // top of window (frac hi) — smaller y
    band = { x: box.x, y: yHi, w: box.w, h: Math.max(1, yLo - yHi) }
    handles = [
      { x: box.x - over, y: yLo - ht / 2, w: box.w + 2 * over, h: ht }, // lo (bottom)
      { x: box.x - over, y: yHi - ht / 2, w: box.w + 2 * over, h: ht }, // hi (top)
    ]
  }
  return { box, orientation, track, band, handles }
}

// ── ON-SCREEN: draw the layout to a 2D canvas ───────────────────────────────────────────────────
export function drawDataZoomCanvas(ctx: CanvasRenderingContext2D, layout: DataZoomLayout, theme: VizTheme = LIGHT_THEME): void {
  const { track, band, handles } = layout
  ctx.save()
  // track
  ctx.fillStyle = TRACK_FILL
  ctx.fillRect(track.x, track.y, track.w, track.h)
  // window band
  ctx.fillStyle = BAND_FILL
  ctx.fillRect(band.x, band.y, band.w, band.h)
  // handles (surface fill + fg border)
  for (const h of handles) {
    ctx.fillStyle = theme.surface
    ctx.strokeStyle = theme.fg
    ctx.lineWidth = 1
    ctx.fillRect(h.x, h.y, h.w, h.h)
    ctx.strokeRect(h.x + 0.5, h.y + 0.5, h.w - 1, h.h - 1)
  }
  ctx.restore()
}

// ── EXPORT: the SAME layout → VectorScene marks (offset by ox,oy into the scene) ─────────────────
// `strokeW` scales the handle border (a 1-CSS-px line on screen) into the device-px export scene.
export function dataZoomToMarks(layout: DataZoomLayout, theme: VizTheme = LIGHT_THEME, ox = 0, oy = 0, strokeW = 1): VectorMark[] {
  const { track, band, handles } = layout
  const marks: VectorMark[] = [
    { type: 'rect', x: track.x + ox, y: track.y + oy, w: track.w, h: track.h, fill: TRACK_FILL },
    { type: 'rect', x: band.x + ox, y: band.y + oy, w: band.w, h: band.h, fill: BAND_FILL },
  ]
  for (const h of handles) {
    marks.push({ type: 'rect', x: h.x + ox, y: h.y + oy, w: h.w, h: h.h, fill: theme.surface, stroke: theme.fg, width: strokeW })
  }
  return marks
}

// ── EXPORT COMPOSE: append the rail to a scene where AxisDataZoom draws it (below/beside) ─────────
// Rail geometry MUST match AxisDataZoom's DOM layout: a horizontal rail sits BELOW the plot, a
// vertical rail sits BESIDE it, each `RAIL` thick with a `GAP` gutter — so the exported figure IS a
// picture of the plot + its slider(s) (WYSIWYG). Growing the figure (never occluding data) mirrors
// the legend `gutter` placement.
export const DATAZOOM_RAIL = 16 // matches AxisDataZoom's `RAIL`
const DATAZOOM_GAP = 4 // matches AxisDataZoom's flex `gap`

/** A per-axis dataZoom slider to bake into the export. `window` = [loFrac,hiFrac] 0..1
 *  (from `axisWindow.windowToFraction`). */
export interface DataZoomExportSpec {
  /** horizontal (x-axis) rail below the plot, if present. */
  readonly x?: { readonly window: readonly [number, number] }
  /** vertical (y-axis) rail beside the plot, if present. */
  readonly y?: { readonly window: readonly [number, number] }
}

/** Append the dataZoom slider(s) to a scene at their on-screen positions, growing the figure. The
 *  scene is in DEVICE pixels (`canvasToVectorScene` → `canvas.width` = CSS × dpr), so the CSS-px rail
 *  chrome (`RAIL`/`GAP`/handle) is scaled by `dpr` — otherwise the exported rail is 1/dpr too thin
 *  relative to the plot on HiDPI, breaking screen == export. `dpr = 1` ⇒ byte-identical to before. */
export function composeDataZoomIntoScene(scene: VectorScene, spec: DataZoomExportSpec, theme: VizTheme = LIGHT_THEME, dpr = 1): VectorScene {
  if (!spec.x && !spec.y) return scene
  const rail = DATAZOOM_RAIL * dpr
  const gap = DATAZOOM_GAP * dpr
  const marks: VectorMark[] = [...scene.marks]
  let width = scene.width
  let height = scene.height
  // Vertical rail BESIDE the plot (to the right), spanning the plot height.
  if (spec.y) {
    const box: Box = { x: scene.width + gap, y: 0, w: rail, h: scene.height }
    marks.push(...dataZoomToMarks(computeDataZoomLayout(box, spec.y.window, 'vertical', dpr), theme, 0, 0, dpr))
    width = scene.width + gap + rail
  }
  // Horizontal rail BELOW the plot, spanning the ORIGINAL plot width (aligns under the plot).
  if (spec.x) {
    const box: Box = { x: 0, y: scene.height + gap, w: scene.width, h: rail }
    marks.push(...dataZoomToMarks(computeDataZoomLayout(box, spec.x.window, 'horizontal', dpr), theme, 0, 0, dpr))
    height = scene.height + gap + rail
  }
  return { ...scene, width, height, marks }
}
