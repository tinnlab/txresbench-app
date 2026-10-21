// scatterConventions.ts — single-cell embedding-scatter conventions (ITEM-22). Two pure helpers the dense
// scatter View consumes: point-size that AUTO-SCALES DOWN as cell count grows (a UMAP of 200k cells needs
// tiny points; a plot of 200 needs large ones), and minimal "corner-arrow" axes (UMAP1 → / UMAP2 ↑) since
// embedding coordinates aren't metric so full ticked axes mislead. Node-safe, no GL.

/** Point radius (px) as a decreasing function of the plotted cell count, clamped to a usable range. A log
 *  falloff matches how density grows: ~6px at 100 cells, ~3px at 10k, ~1px at 1M. */
export function pointSizeForCount(n: number, opts: { min?: number; max?: number } = {}): number {
  const min = opts.min ?? 1
  const max = opts.max ?? 6
  const size = max - Math.log10(Math.max(1, n))
  return Math.max(min, Math.min(max, size))
}

export interface AxisArrow { x1: number; y1: number; x2: number; y2: number; label: string }

/** The two corner-arrow axis segments for an embedding scatter, anchored at the plot's bottom-left corner
 *  `(ox, oy)` in scene (top-left origin, y-down) space: X points right, Y points up. `len` px each. */
export function cornerArrowAxes(ox: number, oy: number, len: number, labels: [string, string] = ['UMAP1', 'UMAP2']): AxisArrow[] {
  return [
    { x1: ox, y1: oy, x2: ox + len, y2: oy, label: labels[0] }, // X → right
    { x1: ox, y1: oy, x2: ox, y2: oy - len, label: labels[1] }, // Y ↑ up (y-down space, so subtract)
  ]
}
