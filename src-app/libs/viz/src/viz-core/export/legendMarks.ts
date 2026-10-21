// legendMarks.ts — turn a legend/colorbar/blend-2D descriptor into VectorScene marks so a plot's
// legend EXPORTS WITH IT (SVG/PDF/PNG), instead of being a DOM-only overlay the export never sees.
// PURE (no deck/react/DOM) — node-testable beside this file, exactly like `vector.ts`'s builders.
//
// The three inputs are the SAME descriptors `data/engine.ts::computeColoring` already produces
// (`.legend` / `.colorbar` / `.blend.legend2d`) and that `controls/{Legend,Colorbar,BlendLegend}.tsx`
// render on screen — so the exported legend matches what the user saw. Data colors come from the
// descriptor (`hex`/`stops`); chrome (label text, swatch/strip outline) comes from the export theme
// (never a hardcoded hue — ITEM-8).

import type { VectorMark, VectorScene } from './vector'
import type { LegendDescriptor, ColorbarDescriptor } from '../data/color'
import type { Blend2DLegend } from '../data/blend'
import { LIGHT_THEME, type VizTheme } from '../theme'
import { computeVisualMapLayout, visualMapToMarks, VISUALMAP_MIN_W } from '../controls/visualMapRender'
import { computeLegendLayout, legendLayoutToMarks, resolveLegendCorner, DEFAULT_LEGEND_CORNER, type LegendFont, type SwatchSide, type LegendCorner } from '../controls/legendRender'

/** A legend to bake into an export — one of the three descriptor kinds + an optional title, plus the
 *  LIVE visual-map state so the export is a snapshot of what's on screen (WYSIWYG, ITEM-13):
 *  `range` draws the selected window on a continuous colorbar; `hidden` greys categorical entries. */
export interface LegendExportSpec {
  readonly descriptor: LegendDescriptor | ColorbarDescriptor | Blend2DLegend
  readonly title?: string
  /** continuous: the on-screen VisualMap `[lo,hi]` window (a strict sub-range draws a window). */
  readonly range?: readonly [number, number]
  /** categorical: the on-screen hidden category codes (greyed in the exported legend). */
  readonly hidden?: ReadonlySet<number> | readonly number[]
  /** typography-derived legend font (family + sizes) so the exported legend matches the on-screen one
   *  (WYSIWYG). Absent ⇒ the built-in defaults. */
  readonly font?: LegendFont
  /** Which side the swatch/bar hugs so the label faces INTO the plot (mirrors the on-screen legend for a
   *  left- vs right-placed legend). Absent ⇒ `right` (the historical publication default). */
  readonly swatchSide?: SwatchSide
  /** categorical: a per-cell provenance marker, exported as one muted line under the entries — the
   *  leg that makes the mark survive into the figure that leaves the building. */
  readonly note?: string
}

/** A self-contained legend block laid out at origin (0,0), with its own bounding box. */
export interface LegendMarksResult {
  readonly marks: VectorMark[]
  readonly width: number
  readonly height: number
}

// Layout constants (px, in scene coordinate space). Kept here as named constants (DEC-7).
const PAD = 8
const TITLE_SIZE = 12
const LABEL_SIZE = 11
const ROW_H = 18
const SWATCH = 12
const COL_W = 120
export const LEGEND_MAX_ROWS = 16
export const LEGEND_MAX_COLS = 3
const LEGEND_MAX_ENTRIES = LEGEND_MAX_ROWS * LEGEND_MAX_COLS // 48
const RAMP_W = 16
const RAMP_H = 110
const RAMP_LABEL_W = 46
const BLEND_RAMP_STEPS = 10
const BLEND_CELL = 12

function titleMarks(title: string | undefined, x: number, y: number, theme: VizTheme, family?: string): VectorMark[] {
  if (!title) return []
  return [{ type: 'text', x, y: y + TITLE_SIZE, text: title, fill: theme.fg, size: TITLE_SIZE, fontFamily: family }]
}

// ── categorical: swatch rect + label per entry, wrapped into bounded columns (DEC-3) ────────────
function categoricalMarks(
  d: LegendDescriptor,
  title: string | undefined,
  theme: VizTheme,
  hidden: ReadonlySet<number>,
  font: LegendFont | undefined,
  swatchSide: SwatchSide,
  note: string | undefined,
): LegendMarksResult {
  // Delegate to the SHARED legend geometry so the export is pixel-identical to the on-screen
  // `InCellLegend` (WYSIWYG) — same swatch/label layout, column wrap, "+N more" cap, hidden-grey, AND
  // the same typography-derived font + swatch side.
  const layout = computeLegendLayout({ x: 0, y: 0, w: 0, h: 0 }, d.entries, hidden, title, swatchSide, note)
  return { marks: legendLayoutToMarks(layout, theme, 0, 0, font), width: layout.width, height: layout.height }
}

// ── continuous colorbar → the SAME visual-map SLIDER the on-screen `InCellVisualMap` draws (bar +
//    two handles at the [lo,hi] range + selected band), from the SHARED `visualMapRender` geometry,
//    so the export is pixel-identical to the on-screen control (WYSIWYG). `range` defaults to the
//    full domain (handles at top+bottom). ─────────────────────────────────────────────────────────
function colorbarMarks(
  d: ColorbarDescriptor,
  title: string | undefined,
  theme: VizTheme,
  range: readonly [number, number] | undefined,
  family: string | undefined,
  swatchSide: SwatchSide,
): LegendMarksResult {
  const marks: VectorMark[] = []
  const titleH = title ? TITLE_SIZE + PAD : 0
  marks.push(...titleMarks(title, 0, 0, theme, family))
  const box = { x: 0, y: titleH, w: VISUALMAP_MIN_W, h: RAMP_H }
  const layout = computeVisualMapLayout(box, d.domain, range ?? d.domain, d.stops, swatchSide)
  marks.push(...visualMapToMarks(layout, theme, 0, 0, family))
  return { marks, width: VISUALMAP_MIN_W, height: titleH + RAMP_H }
}

/** Parse `#rrggbb` → [r,g,b] (0–255); tolerant of a leading `#` and 3-digit shorthand. */
function parseHex(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (!Number.isFinite(n)) return [0, 0, 0] // malformed/empty hex → black (never emit #NaNNaNNaN)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

/** A per-hue value ramp: from a dim end (at `alphaFloor`) up to the full `hex` (lightness/alpha
 *  channel both approximated as an RGB lerp from the dim end — a legend approximation of the shader
 *  modulation, matching the on-screen BlendLegend's direction). */
function rampColors(hex: string, alphaFloor: number, steps: number, channel: 'lightness' | 'alpha'): string[] {
  const [r, g, b] = parseHex(hex)
  // lightness: dim toward black; alpha: dim toward white (as if composited over a white page).
  const base: [number, number, number] = channel === 'alpha' ? [255, 255, 255] : [0, 0, 0]
  const lo: [number, number, number] = [
    base[0] + (r - base[0]) * alphaFloor,
    base[1] + (g - base[1]) * alphaFloor,
    base[2] + (b - base[2]) * alphaFloor,
  ]
  const out: string[] = []
  for (let j = 0; j < steps; j++) {
    const t = steps === 1 ? 1 : j / (steps - 1)
    out.push(toHex(lo[0] + (r - lo[0]) * t, lo[1] + (g - lo[1]) * t, lo[2] + (b - lo[2]) * t))
  }
  return out
}

// ── blend-2D: hue rows × value-ramp columns + row labels + a low/high value axis ────────────────
function blendMarks(d: Blend2DLegend, title: string | undefined, theme: VizTheme, family: string | undefined): LegendMarksResult {
  const marks: VectorMark[] = []
  const titleH = title ? TITLE_SIZE + PAD : 0
  const gridW = BLEND_RAMP_STEPS * BLEND_CELL
  const labelX = gridW + 6
  d.rows.forEach((row, r) => {
    const y = titleH + r * ROW_H
    const ramp = rampColors(row.hex, d.alphaFloor, BLEND_RAMP_STEPS, d.channel)
    ramp.forEach((c, j) => {
      marks.push({ type: 'rect', x: j * BLEND_CELL, y, w: BLEND_CELL + 0.5, h: BLEND_CELL, fill: c })
    })
    marks.push({ type: 'text', x: labelX, y: y + BLEND_CELL - 1, text: row.label, fill: theme.fg, size: LABEL_SIZE, fontFamily: family })
  })
  // value axis under the grid (low → high).
  const axisY = titleH + d.rows.length * ROW_H + LABEL_SIZE
  const [lo, hi] = d.valueDomain
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2))
  marks.push({ type: 'text', x: 0, y: axisY, text: `low (${fmt(lo)})`, fill: theme.muted, size: LABEL_SIZE, fontFamily: family })
  marks.push({ type: 'text', x: gridW, y: axisY, text: `high (${fmt(hi)})`, fill: theme.muted, size: LABEL_SIZE, anchor: 'end', fontFamily: family })
  marks.push(...titleMarks(title, 0, 0, theme, family))
  const labelW = 90
  return { marks, width: gridW + 6 + labelW, height: axisY + PAD }
}

/** Turn a legend spec into a self-contained block of vector marks (laid out at origin). */
export function legendToMarks(spec: LegendExportSpec, theme: VizTheme = LIGHT_THEME): LegendMarksResult {
  const d = spec.descriptor
  const side: SwatchSide = spec.swatchSide ?? 'right'
  switch (d.kind) {
    case 'categorical':
      return categoricalMarks(d, spec.title, theme, new Set(spec.hidden ?? []), spec.font, side, spec.note)
    case 'continuous':
      return colorbarMarks(d, spec.title, theme, spec.range, spec.font?.family, side)
    case 'blend':
      return blendMarks(d, spec.title, theme, spec.font?.family)
  }
}

/** How the legend sits relative to the plot: which CORNER, and whether it OVERLAYS the plot (floats over
 *  it, plot keeps full area) or sits BESIDE it (in a reserved side gutter — the caller has already shrunk
 *  the plot into the non-gutter region, so this only fills the gutter; no figure resize). */
export interface LegendComposePlacement {
  readonly corner: LegendCorner
  readonly beside: boolean
}

const EDGE_PAD = 10

/**
 * Compose a legend block into a scene at the given CORNER. The block is placed against the corner's
 * horizontal + vertical edges (no figure resize — for `beside`, the caller pre-shrank the plot into the
 * complementary region, so the legend simply fills the reserved gutter). An OVERLAY draws a semi-opaque
 * readability box behind the legend (it sits over the plot); a `beside` legend does not (it's in a clear
 * gutter). PURE — returns a NEW scene, never mutates input.
 */
export function composeLegendIntoScene(
  scene: VectorScene,
  legend: LegendMarksResult,
  placement: LegendComposePlacement = { corner: DEFAULT_LEGEND_CORNER, beside: false },
): VectorScene {
  if (legend.marks.length === 0) return scene
  const { hSide, vSide } = resolveLegendCorner(placement.corner)
  const ox = hSide === 'left' ? EDGE_PAD : Math.max(EDGE_PAD, scene.width - legend.width - EDGE_PAD)
  const oy = vSide === 'top' ? EDGE_PAD : Math.max(EDGE_PAD, scene.height - legend.height - EDGE_PAD)
  // overlay (over the plot): a semi-opaque readability box so labels stay legible; a beside legend sits
  // in a clear gutter and needs none. Drawn BEFORE the legend marks so the legend sits on top.
  const bg: VectorMark[] = placement.beside
    ? []
    : [{ type: 'rect', x: ox - 5, y: oy - 5, w: legend.width + 10, h: legend.height + 10, fill: 'rgba(255,255,255,0.82)', stroke: 'rgba(0,0,0,0.15)', width: 0.5 }]
  const placed = legend.marks.map(m => offsetMark(m, ox, oy))
  return { ...scene, marks: [...scene.marks, ...bg, ...placed] }
}

/** Translate a mark by (dx,dy). Covers the mark types a legend uses (rect/text); others pass through
 *  translated where they carry x/y (defensive — legends emit only rect/text today). */
function offsetMark(m: VectorMark, dx: number, dy: number): VectorMark {
  switch (m.type) {
    case 'rect':
      return { ...m, x: m.x + dx, y: m.y + dy }
    case 'text':
      return { ...m, x: m.x + dx, y: m.y + dy }
    case 'line':
      return { ...m, x1: m.x1 + dx, y1: m.y1 + dy, x2: m.x2 + dx, y2: m.y2 + dy }
    case 'circle':
      return { ...m, cx: m.cx + dx, cy: m.cy + dy }
    case 'image':
      return { ...m, x: m.x + dx, y: m.y + dy }
    case 'polygon':
    case 'polyline':
      return { ...m, points: m.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
  }
}
