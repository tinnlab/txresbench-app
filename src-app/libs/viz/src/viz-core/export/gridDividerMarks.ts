// gridDividerMarks.ts — the grid's cell dividers (the react-resizable-panels resize-handle
// separators) live in the DOM as 1px hairlines; they are NEVER painted on the shared deck canvas.
// So a WHOLE-grid export (`canvasToVectorScene(canvas)`) captures the points but NOT the dividers,
// and the exported figure reads as one seamless plot. This helper re-derives the dividers as vector
// LINE marks (in the export scene's DEVICE-pixel space) from the live separator geometry, so the
// host can compose them into a whole-grid export and it stays WYSIWYG.

import type { VectorMark } from './vector'

// The on-screen separator hairline color (SEP_V_STYLE / SEP_H_STYLE in GridWorkspace).
const DIVIDER_STROKE = 'rgba(128,128,128,0.4)'

/**
 * Vector LINE marks for every panel divider (`[role="separator"]`) inside `root`, positioned
 * relative to `canvas` in DEVICE pixels (the scene space `canvasToVectorScene` uses:
 * `canvas.width` = CSS × dpr). A vertical separator → a vertical hairline at its horizontal
 * center; a horizontal one → a horizontal hairline at its vertical center — matching where the
 * DOM draws the 1px line. Returns `[]` when there are no dividers (a single cell) or the geometry
 * can't be measured. Clamped to the canvas box so a separator taller than the deck canvas (chrome
 * above it) never draws outside the figure.
 */
export function gridDividerMarks(
  root: HTMLElement | null,
  canvas: HTMLCanvasElement | null,
  dpr = 1,
): VectorMark[] {
  if (!root || !canvas) return []
  const cb = canvas.getBoundingClientRect()
  if (cb.width <= 0 || cb.height <= 0) return []
  const W = canvas.width || cb.width * dpr
  const H = canvas.height || cb.height * dpr
  const clampX = (v: number) => Math.max(0, Math.min(W, v))
  const clampY = (v: number) => Math.max(0, Math.min(H, v))
  const strokeW = Math.max(1, dpr) // a 1-CSS-px hairline → dpr device px
  const marks: VectorMark[] = []
  for (const el of root.querySelectorAll('[role="separator"]')) {
    const r = (el as HTMLElement).getBoundingClientRect()
    // Position relative to the canvas, in device px.
    const x = (r.left - cb.left) * dpr
    const y = (r.top - cb.top) * dpr
    const ew = r.width * dpr
    const eh = r.height * dpr
    if (eh >= ew) {
      // Vertical separator → vertical hairline at its horizontal center.
      const cx = clampX(x + ew / 2)
      marks.push({ type: 'line', x1: cx, y1: clampY(y), x2: cx, y2: clampY(y + eh), stroke: DIVIDER_STROKE, width: strokeW })
    } else {
      // Horizontal separator → horizontal hairline at its vertical center.
      const cy = clampY(y + eh / 2)
      marks.push({ type: 'line', x1: clampX(x), y1: cy, x2: clampX(x + ew), y2: cy, stroke: DIVIDER_STROKE, width: strokeW })
    }
  }
  return marks
}
