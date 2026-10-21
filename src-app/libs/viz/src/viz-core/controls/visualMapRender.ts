// visualMapRender.ts — the SHARED, ECharts-style continuous visual-map renderer. ONE geometry
// (`computeVisualMapLayout`) drives BOTH the on-screen overlay (`drawVisualMapCanvas` → a 2D canvas)
// AND the export (`visualMapToMarks` → VectorScene marks), so what you see IS what you export
// (pixel-identical by construction — the ECharts single-surface model).
//
// The control = a vertical GRADIENT BAR (low at bottom, high at top) + the SELECTED BAND between two
// handles + TWO HANDLES (a triangle pointer + a value-label chip at each handle's data value) + the
// dimmed out-of-range portions. Handle pixel-y = linearMap(value, domain, barHeight) (high at top).
// PURE — no react/deck/DOM in the geometry + marks; the canvas draw takes a 2D context. Node-testable.

import type { VectorMark } from '../export/vector'
import { LIGHT_THEME, type VizTheme } from '../theme'

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Which side the gradient BAR hugs (the mirror of the categorical `SwatchSide`). `right` (default) →
 *  bar on the right, value labels on the left, handles poke LEFT toward the labels; `left` → mirrored
 *  (bar left, labels right, handles poke RIGHT) so the labels face INTO a plot the legend sits left of. */
export type VisualMapSide = 'left' | 'right'

export interface VisualMapLayout {
  readonly box: Box
  readonly domain: readonly [number, number]
  readonly range: readonly [number, number]
  readonly stops: readonly string[]
  /** which side the bar hugs (drives handle direction + label anchor in draw/marks). */
  readonly side: VisualMapSide
  /** the gradient rail rect. */
  readonly bar: Box
  /** selected band pixel span (yTop = high handle, yBot = low handle). */
  readonly band: { readonly yTop: number; readonly yBot: number }
  /** handle pixel-y for the low + high bounds (hi is above lo). */
  readonly handles: { readonly yHi: number; readonly yLo: number }
  /** value labels shown at each handle. */
  readonly labels: {
    readonly hi: { readonly x: number; readonly y: number; readonly text: string }
    readonly lo: { readonly x: number; readonly y: number; readonly text: string }
  }
}

// Layout constants (px).
const VPAD = 12 // top/bottom room so the top/bottom handle chips don't clip
const BAR_W = 14
const HANDLE_W = 7 // triangle pointer width poking right of the bar
const LABEL_GAP = HANDLE_W + 4
const LABEL_H = 15
const LABEL_W = 44
export const VISUALMAP_MIN_W = BAR_W + LABEL_GAP + LABEL_W // total width the control needs

/** ECharts-style value formatter: compact exponential for large magnitudes, else 2 decimals. */
export function fmtVal(v: number): string {
  return Math.abs(v) >= 1000 ? v.toExponential(1) : v.toFixed(2)
}

/** high value at TOP: y = barTop + barH*(1 - (v-lo)/(hi-lo)). */
function valueToY(v: number, domain: readonly [number, number], barTop: number, barH: number): number {
  const [lo, hi] = domain
  const t = hi === lo ? 0 : (v - lo) / (hi - lo)
  return barTop + barH * (1 - Math.max(0, Math.min(1, t)))
}

/** inverse: a pixel-y on the bar → a data value (clamped to the domain). */
export function yToValue(y: number, domain: readonly [number, number], barTop: number, barH: number): number {
  const [lo, hi] = domain
  const t = barH === 0 ? 0 : (y - barTop) / barH
  const frac = 1 - Math.max(0, Math.min(1, t)) // top = 1
  return lo + frac * (hi - lo)
}

/** Compute the full geometry of the visual-map inside `box`. Pure. */
export function computeVisualMapLayout(
  box: Box,
  domain: readonly [number, number],
  range: readonly [number, number],
  stops: readonly string[],
  side: VisualMapSide = 'right',
): VisualMapLayout {
  const barTop = box.y + VPAD
  const barH = Math.max(1, box.h - VPAD * 2)
  // `right` (default): value labels on the LEFT, gradient bar on the RIGHT (handles poke LEFT to the
  // labels). `left` (mirror): bar on the LEFT, labels on the RIGHT (handles poke RIGHT) — so a legend
  // sitting on the plot's LEFT shows its labels facing INTO the plot.
  const bar: Box =
    side === 'right'
      ? { x: box.x + LABEL_W + LABEL_GAP, y: barTop, w: BAR_W, h: barH }
      : { x: box.x, y: barTop, w: BAR_W, h: barH }
  const rLo = Math.min(range[0], range[1])
  const rHi = Math.max(range[0], range[1])
  const yHi = valueToY(rHi, domain, barTop, barH)
  const yLo = valueToY(rLo, domain, barTop, barH)
  // right ⇒ chip at the far LEFT (box.x); left ⇒ chip just RIGHT of the bar.
  const labelX = side === 'right' ? box.x : box.x + BAR_W + LABEL_GAP
  return {
    box,
    domain,
    range: [rLo, rHi],
    stops,
    side,
    bar,
    band: { yTop: yHi, yBot: yLo },
    handles: { yHi, yLo },
    labels: {
      hi: { x: labelX, y: yHi, text: fmtVal(rHi) },
      lo: { x: labelX, y: yLo, text: fmtVal(rLo) },
    },
  }
}

/** Is the on-screen visual-map filtering (a strict sub-range of the domain)? */
export function isStrictSubRange(domain: readonly [number, number], range: readonly [number, number]): boolean {
  const [dLo, dHi] = domain
  const rLo = Math.min(range[0], range[1])
  const rHi = Math.max(range[0], range[1])
  return rLo > dLo || rHi < dHi
}

/** A semi-transparent veil in the theme's SURFACE color (`#rrggbb` → `rgba(r,g,b,a)`), so a "dim"
 *  overlay reads correctly on both light and dark. Falls back to a light veil for a non-hex surface. */
function surfaceVeil(surface: string, alpha: number): string {
  if (surface.startsWith('#') && surface.length === 7) {
    const r = parseInt(surface.slice(1, 3), 16)
    const g = parseInt(surface.slice(3, 5), 16)
    const b = parseInt(surface.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${alpha})`
  }
  return `rgba(255,255,255,${alpha})`
}

// ── ON-SCREEN: draw the layout to a 2D canvas ───────────────────────────────────────────────────
export function drawVisualMapCanvas(ctx: CanvasRenderingContext2D, layout: VisualMapLayout, theme: VizTheme = LIGHT_THEME, family = 'system-ui, sans-serif'): void {
  const { bar, stops, band, labels } = layout
  ctx.save()
  // gradient rail (low at bottom → high at top)
  const grad = ctx.createLinearGradient(0, bar.y + bar.h, 0, bar.y)
  stops.forEach((s, i) => grad.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), s))
  ctx.fillStyle = grad
  ctx.fillRect(bar.x, bar.y, bar.w, bar.h)
  // dim out-of-range portions (above the high handle + below the low handle) toward the THEME surface
  // (a light veil on light, a dark veil on dark) — a hardcoded white veil lit up the dark-mode rail.
  ctx.fillStyle = surfaceVeil(theme.surface, 0.62)
  if (band.yTop > bar.y) ctx.fillRect(bar.x, bar.y, bar.w, band.yTop - bar.y)
  if (band.yBot < bar.y + bar.h) ctx.fillRect(bar.x, band.yBot, bar.w, bar.y + bar.h - band.yBot)
  // bar border (subtle, all sides) + the selected-band outline ONLY while actually FILTERING — a full
  // range needs no outline (drawing it around the whole gradient looked like a dark left border), and
  // the outline no longer pokes left of the bar toward the labels.
  ctx.strokeStyle = theme.border
  ctx.lineWidth = 1
  ctx.strokeRect(bar.x + 0.5, bar.y + 0.5, bar.w - 1, bar.h - 1)
  if (isStrictSubRange(layout.domain, layout.range)) {
    ctx.strokeStyle = theme.fg
    ctx.lineWidth = 1.5
    ctx.strokeRect(bar.x, band.yTop, bar.w, Math.max(1, band.yBot - band.yTop))
  }
  // handles (triangle poking toward the labels) + a value-label chip on the labels' side, at hi and lo.
  const right = layout.side === 'right'
  const tipX = right ? bar.x : bar.x + bar.w // triangle base edge (bar edge facing the labels)
  const tipDir = right ? -1 : 1 // labels are LEFT (poke left) for right side, RIGHT for left side
  for (const h of [labels.hi, labels.lo]) {
    const y = h.y
    ctx.fillStyle = theme.fg
    ctx.beginPath()
    ctx.moveTo(tipX, y)
    ctx.lineTo(tipX + tipDir * HANDLE_W, y - HANDLE_W * 0.7)
    ctx.lineTo(tipX + tipDir * HANDLE_W, y + HANDLE_W * 0.7)
    ctx.closePath()
    ctx.fill()
    // value label flush toward the bar: right side ⇒ right-anchored at the chip's right edge; left side
    // ⇒ left-anchored at the chip's left edge. NO background chip (reads on light + dark).
    ctx.fillStyle = theme.fg
    ctx.font = `11px ${family}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = right ? 'right' : 'left'
    ctx.fillText(h.text, right ? h.x + LABEL_W - 4 : h.x + 4, y)
  }
  ctx.restore()
}

// ── EXPORT: the SAME layout → VectorScene marks (offset by ox,oy into the scene) ─────────────────
export function visualMapToMarks(layout: VisualMapLayout, theme: VizTheme = LIGHT_THEME, ox = 0, oy = 0, family?: string): VectorMark[] {
  const { bar, stops, band, labels } = layout
  const marks: VectorMark[] = []
  // stepped gradient (marks can't do a true gradient — one rect per stop, high at top)
  const n = stops.length
  const segH = bar.h / Math.max(1, n)
  stops.forEach((s, i) => {
    const y = bar.y + bar.h - (i + 1) * segH
    marks.push({ type: 'rect', x: bar.x + ox, y: y + oy, w: bar.w, h: segH + 0.5, fill: s })
  })
  // dim out-of-range
  if (band.yTop > bar.y) marks.push({ type: 'rect', x: bar.x + ox, y: bar.y + oy, w: bar.w, h: band.yTop - bar.y, fill: 'rgba(255,255,255,0.62)' })
  if (band.yBot < bar.y + bar.h) marks.push({ type: 'rect', x: bar.x + ox, y: band.yBot + oy, w: bar.w, h: bar.y + bar.h - band.yBot, fill: 'rgba(255,255,255,0.62)' })
  // bar border + the band outline ONLY while filtering (matches the on-screen draw — no dark border
  // around a full-range gradient).
  marks.push({ type: 'rect', x: bar.x + ox, y: bar.y + oy, w: bar.w, h: bar.h, stroke: theme.border, width: 1 })
  if (isStrictSubRange(layout.domain, layout.range)) {
    marks.push({ type: 'rect', x: bar.x + ox, y: band.yTop + oy, w: bar.w, h: Math.max(1, band.yBot - band.yTop), stroke: theme.fg, width: 1.5 })
  }
  // handles (triangle polygon + label chip + text) at hi and lo — mirrored by `side`.
  const right = layout.side === 'right'
  const tipX = right ? bar.x : bar.x + bar.w
  const tipDir = right ? -1 : 1
  const anchor: 'start' | 'end' = right ? 'end' : 'start'
  for (const h of [labels.hi, labels.lo]) {
    const y = h.y
    marks.push({
      type: 'polygon',
      points: [
        [tipX + ox, y + oy],
        [tipX + tipDir * HANDLE_W + ox, y - HANDLE_W * 0.7 + oy],
        [tipX + tipDir * HANDLE_W + ox, y + HANDLE_W * 0.7 + oy],
      ],
      fill: theme.fg,
    })
    marks.push({ type: 'rect', x: h.x + ox, y: y - LABEL_H / 2 + oy, w: LABEL_W, h: LABEL_H, fill: 'rgba(255,255,255,0.9)' })
    marks.push({ type: 'text', x: (right ? h.x + LABEL_W - 4 : h.x + 4) + ox, y: y + 4 + oy, text: h.text, fill: theme.fg, size: 11, anchor, fontFamily: family })
  }
  return marks
}

/** Total pixel size the control occupies (for laying out the on-screen canvas + the export block). */
export function visualMapExtent(box: Box): { width: number; height: number } {
  return { width: BAR_W + LABEL_GAP + LABEL_W, height: box.h }
}
