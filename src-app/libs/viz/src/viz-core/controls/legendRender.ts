// legendRender.ts — the SHARED categorical-legend renderer. ONE geometry (`computeLegendLayout`)
// drives BOTH the on-screen overlay (`drawLegendCanvas` → a 2D canvas) AND the export
// (`legendLayoutToMarks` → VectorScene marks), so the exported legend is pixel-identical to the
// on-screen one (WYSIWYG, the ECharts single-surface model — mirrors `visualMapRender.ts`).
//
// The control = a title + one label + swatch (color rect) per category, wrapped into bounded columns.
// It is RIGHT-ALIGNED (publication convention): the swatch sits at each column's RIGHT edge and the label
// is right-anchored to its LEFT (`[label ][swatch]`); the title is right-anchored to the block's right
// edge. A category HIDDEN on screen is GREYED in both surfaces. PURE geometry + marks (no react/deck/DOM);
// the canvas draw takes a 2D context. Node-testable.

import type { VectorMark } from '../export/vector'
import { LIGHT_THEME, type VizTheme } from '../theme'
import type { Box } from './visualMapRender'

export interface LegendEntry {
  readonly code: number
  readonly label: string
  readonly hex: string
}

export interface LegendItem {
  readonly code: number
  readonly label: string
  readonly hex: string
  /** swatch top-left. */
  readonly x: number
  readonly y: number
  readonly hidden: boolean
}

/** Which side of each column the color SWATCH hugs. `right` (default, publication) → `[label ][swatch]`
 *  with the label right-anchored to the swatch's left. `left` → `[swatch][ label]` (mirrored) — used when
 *  the legend sits on the plot's LEFT so the labels face INTO the plot (the label is on the plot-facing
 *  side of the swatch). Both surfaces (on-screen canvas + export marks) honor it, so they stay WYSIWYG. */
export type SwatchSide = 'left' | 'right'

/** Which CORNER of the plot the legend sits in (edit-form control). */
export type LegendCorner = 'tl' | 'tr' | 'bl' | 'br'

/** A corner resolved into the sides that drive both the on-screen wrapper position AND the legend's own
 *  internal mirror: `hSide`/`vSide` place the block; `swatchSide` = `hSide` so the label always faces INTO
 *  the plot (legend on the right → swatch right/label left; on the left → swatch left/label right). */
export interface ResolvedLegendPlacement {
  readonly hSide: 'left' | 'right'
  readonly vSide: 'top' | 'bottom'
  readonly swatchSide: SwatchSide
}

export function resolveLegendCorner(corner: LegendCorner): ResolvedLegendPlacement {
  const hSide = corner === 'tl' || corner === 'bl' ? 'left' : 'right'
  const vSide = corner === 'tl' || corner === 'tr' ? 'top' : 'bottom'
  return { hSide, vSide, swatchSide: hSide }
}

/** The default legend corner when a cell hasn't set one (top-right — the historical on-screen position). */
export const DEFAULT_LEGEND_CORNER: LegendCorner = 'tr'

export interface LegendLayout {
  readonly box: Box
  readonly title?: string
  readonly titleH: number
  readonly items: readonly LegendItem[]
  readonly more?: { readonly x: number; readonly y: number; readonly text: string }
  /**
   * A PER-SERIES PROVENANCE MARKER the host handed this legend, laid out as one muted line
   * under the entries.
   *
   * The legend is the load-bearing surface for a marker that must survive leaving the app:
   * a screenshot crops the pane chrome and keeps the legend, and this geometry is SHARED by
   * the on-screen canvas and the vector export, so the mark travels into the exported figure
   * by construction rather than by a second implementation agreeing with this one.
   *
   * The legend renders whatever string it is handed and knows nothing about what the mark
   * MEANS — deciding that is the host's (in ziee: an artifact whose producer declared no
   * alignment to the row space the points are drawn in).
   */
  readonly note?: { readonly x: number; readonly y: number; readonly text: string }
  readonly width: number
  readonly height: number
  readonly swatchSide: SwatchSide
}

// Layout constants (px) — kept in lockstep with the pre-shared categoricalMarks values.
export const TITLE_SIZE = 12
export const LABEL_SIZE = 11
export const ROW_H = 18
export const SWATCH = 12
export const COL_W = 120
export const LABEL_DX = SWATCH + 5
/** Gap (px) between the right-aligned label text and the swatch to its right. */
export const LABEL_GAP = 5

/** Font override for the legend (from a cell's typography). Absent fields ⇒ the built-in defaults. */
export interface LegendFont {
  readonly titleSize?: number
  readonly labelSize?: number
  readonly family?: string
}
const DEFAULT_FAMILY = 'system-ui, sans-serif'
export const LEGEND_MAX_ROWS = 16
export const LEGEND_MAX_COLS = 3
export const LEGEND_MAX_ENTRIES = LEGEND_MAX_ROWS * LEGEND_MAX_COLS // 48
const TITLE_GAP = 8
/** Vertical space (px) a legend NOTE occupies below the entries — the line plus its gap. */
export const NOTE_H = 15
const NOTE_GAP = 4

/** Compute the full geometry of a categorical legend inside `box` (top-left origin at box.x/box.y).
 *  Wraps into up to `LEGEND_MAX_COLS` columns of `LEGEND_MAX_ROWS`; caps at 48 with a "+N more".
 *  `note` (optional) adds ONE muted line under the entries — see {@link LegendLayout.note}. */
export function computeLegendLayout(
  box: Box,
  entries: readonly LegendEntry[],
  hidden: ReadonlySet<number>,
  title?: string,
  swatchSide: SwatchSide = 'right',
  note?: string,
): LegendLayout {
  const titleH = title ? TITLE_SIZE + TITLE_GAP : 0
  const capped = entries.length > LEGEND_MAX_ENTRIES
  const shown = capped ? entries.slice(0, LEGEND_MAX_ENTRIES - 1) : entries
  const items: LegendItem[] = shown.map((e, i) => {
    const col = Math.floor(i / LEGEND_MAX_ROWS)
    const row = i % LEGEND_MAX_ROWS
    return {
      code: e.code,
      label: e.label,
      hex: e.hex,
      x: box.x + col * COL_W,
      y: box.y + titleH + row * ROW_H,
      hidden: hidden.has(e.code),
    }
  })
  let more: LegendLayout['more']
  if (capped) {
    const i = LEGEND_MAX_ENTRIES - 1
    const col = Math.floor(i / LEGEND_MAX_ROWS)
    const row = i % LEGEND_MAX_ROWS
    more = { x: box.x + col * COL_W, y: box.y + titleH + row * ROW_H, text: `+${entries.length - (LEGEND_MAX_ENTRIES - 1)} more` }
  }
  const cols = Math.min(LEGEND_MAX_COLS, Math.ceil(shown.length / LEGEND_MAX_ROWS) || 1)
  const rows = Math.min(LEGEND_MAX_ROWS, shown.length || 1)
  const width = cols * COL_W
  const entriesH = titleH + rows * ROW_H
  // The note sits BELOW the entries, so every item's own x/y — and therefore `legendHitTest` —
  // is byte-identical whether or not a note is present. A legend that re-laid-out its swatches
  // to make room would move the click targets of an unrelated control.
  const trimmed = typeof note === 'string' ? note.trim() : ''
  const noteLine =
    trimmed.length > 0
      ? { x: swatchSide === 'right' ? box.x + width : box.x, y: box.y + entriesH + NOTE_GAP, text: trimmed }
      : undefined
  return {
    box,
    title,
    titleH,
    items,
    more,
    ...(noteLine ? { note: noteLine } : {}),
    width,
    height: entriesH + (noteLine ? NOTE_H : 0),
    swatchSide,
  }
}

/** Total pixel size the legend occupies. */
export function legendExtent(layout: LegendLayout): { width: number; height: number } {
  return { width: layout.width, height: layout.height }
}

/** The swatch's left-x for a column at `colX`. Right side ⇒ hug the column's RIGHT edge; left side ⇒
 *  hug the column's LEFT edge. */
const swatchX = (colX: number, side: SwatchSide): number => (side === 'right' ? colX + COL_W - SWATCH : colX)
/** The label's anchor x for a column at `colX`. Right side ⇒ label ENDS just left of the swatch (anchor
 *  `end`); left side ⇒ label STARTS just right of the swatch (anchor `start`). */
const labelAnchorX = (colX: number, side: SwatchSide): number =>
  side === 'right' ? colX + COL_W - SWATCH - LABEL_GAP : colX + SWATCH + LABEL_GAP

// ── ON-SCREEN: draw the layout to a 2D canvas ───────────────────────────────────────────────────
export function drawLegendCanvas(ctx: CanvasRenderingContext2D, layout: LegendLayout, theme: VizTheme = LIGHT_THEME, font?: LegendFont): void {
  const titleSize = font?.titleSize ?? TITLE_SIZE
  const labelSize = font?.labelSize ?? LABEL_SIZE
  const family = font?.family ?? DEFAULT_FAMILY
  const side = layout.swatchSide
  ctx.save()
  ctx.textBaseline = 'alphabetic'
  // Right side ⇒ labels/title right-anchored (swatch on the right); left side ⇒ left-anchored (swatch left).
  ctx.textAlign = side === 'right' ? 'right' : 'left'
  const titleX = side === 'right' ? layout.box.x + layout.width : layout.box.x
  if (layout.title) {
    ctx.fillStyle = theme.fg
    ctx.font = `${titleSize}px ${family}`
    ctx.fillText(layout.title, titleX, layout.box.y + TITLE_SIZE)
  }
  ctx.font = `${labelSize}px ${family}`
  for (const it of layout.items) {
    const sx = swatchX(it.x, side)
    ctx.fillStyle = it.hidden ? theme.muted : it.hex
    ctx.fillRect(sx, it.y, SWATCH, SWATCH)
    ctx.strokeStyle = theme.border
    ctx.lineWidth = 0.5
    ctx.strokeRect(sx + 0.25, it.y + 0.25, SWATCH - 0.5, SWATCH - 0.5)
    ctx.fillStyle = it.hidden ? theme.muted : theme.fg
    ctx.fillText(it.label, labelAnchorX(it.x, side), it.y + SWATCH - 1)
  }
  if (layout.more) {
    ctx.fillStyle = theme.muted
    ctx.fillText(layout.more.text, labelAnchorX(layout.more.x, side), layout.more.y + SWATCH - 1)
  }
  // The provenance note — muted, one line, under the entries. Drawn from the SAME layout the
  // export marks below use, which is what makes the mark survive into a screenshot.
  if (layout.note) {
    ctx.fillStyle = theme.muted
    ctx.fillText(layout.note.text, layout.note.x, layout.note.y + LABEL_SIZE)
  }
  ctx.restore()
}

// ── EXPORT: the SAME layout → VectorScene marks (offset by ox,oy) ────────────────────────────────
export function legendLayoutToMarks(layout: LegendLayout, theme: VizTheme = LIGHT_THEME, ox = 0, oy = 0, font?: LegendFont): VectorMark[] {
  const titleSize = font?.titleSize ?? TITLE_SIZE
  const labelSize = font?.labelSize ?? LABEL_SIZE
  const family = font?.family
  const side = layout.swatchSide
  const anchor: 'start' | 'end' = side === 'right' ? 'end' : 'start'
  const marks: VectorMark[] = []
  const titleX = side === 'right' ? layout.box.x + layout.width : layout.box.x
  if (layout.title) {
    marks.push({ type: 'text', x: titleX + ox, y: layout.box.y + TITLE_SIZE + oy, text: layout.title, fill: theme.fg, size: titleSize, anchor, fontFamily: family })
  }
  for (const it of layout.items) {
    const sx = swatchX(it.x, side)
    marks.push({ type: 'rect', x: sx + ox, y: it.y + oy, w: SWATCH, h: SWATCH, fill: it.hidden ? theme.muted : it.hex, stroke: theme.border, width: 0.5 })
    marks.push({ type: 'text', x: labelAnchorX(it.x, side) + ox, y: it.y + SWATCH - 1 + oy, text: it.label, fill: it.hidden ? theme.muted : theme.fg, size: labelSize, anchor, fontFamily: family })
  }
  if (layout.more) {
    marks.push({ type: 'text', x: labelAnchorX(layout.more.x, side) + ox, y: layout.more.y + SWATCH - 1 + oy, text: layout.more.text, fill: theme.muted, size: labelSize, anchor, fontFamily: family })
  }
  if (layout.note) {
    marks.push({ type: 'text', x: layout.note.x + ox, y: layout.note.y + labelSize + oy, text: layout.note.text, fill: theme.muted, size: labelSize, anchor, fontFamily: family })
  }
  return marks
}

/** Hit-test a local (x,y) against the legend's swatch/label rows → the clicked entry's code, or null. */
export function legendHitTest(layout: LegendLayout, x: number, y: number): number | null {
  for (const it of layout.items) {
    if (x >= it.x && x <= it.x + COL_W && y >= it.y && y <= it.y + ROW_H) return it.code
  }
  return null
}
