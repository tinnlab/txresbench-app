// scatterVector.ts — turn a scatter pane's per-point data into TRUE VECTOR circles so a
// publication export (SVG/PDF/EPS/high-DPI PNG) is INFINITELY SHARP at any output resolution,
// instead of a bilinear upscale of the screen-res GPU canvas (the all-GPU render only ever
// draws at display density — DEC-18/23). Each on-screen point becomes one `VectorCircle`,
// projected world→screen through the SAME `OrthographicView` viewport the live deck + the
// selection hit-test use (`makeCellViewport`), so the exported figure is pixel-faithful (WYSIWYG).
//
// PURE (no deck-layer / react / DOM beyond deck's pure `makeViewport` matrix math), so it's
// node-testable beside this file, exactly like `vector.ts` / `legendMarks.ts`.
//
// Coordinate space: CSS/logical px (NOT device px). Vector is resolution-independent — `buildSVG`
// stamps the target output width and scales the whole viewBox, so circles stay crisp AND the legend
// (also authored in CSS px by `legendMarks.ts`) composes at the SAME scale → proportional, unlike the
// raster path where the plot tile sits at device px and the legend at CSS px.

import type { VectorScene, VectorMark } from './vector'
import type { CellViewStateLike } from '../grid/gridSelection'
import { makeCellViewport } from '../grid/gridSelection'

// A scatter pane at more points than this exports as a raster TILE (the caller falls back to
// `canvasToVectorScene(crop)`), not per-point circles: an SVG with hundreds of thousands of
// `<circle>`s is multi-tens-of-MB and chokes the string builder / jsPDF. A dimensionality-reduction
// embedding (the common scatter) is typically well under this. Mirrors the spirit of
// `layers/scatter.ts`'s `DEFAULT_LOD.pointThreshold` (which switches to GPU aggregation far higher).
export const SCATTER_VECTOR_MAX = 150_000

/** deck's ScatterplotLayer default pixel-radius clamps (see `layers/scatter.ts` buildScatterProps). */
const RADIUS_MIN = 1
const RADIUS_MAX = 8

export interface ScatterVectorInput {
  /** Interleaved world x,y (length = 2·nPoints). */
  readonly positions: Float32Array
  /** RGBA bytes (length = 4·nPoints), already LUT-applied on screen; alpha 0 ⇒ filtered-out (skipped). */
  readonly colors: Uint8Array
  readonly nPoints: number
  /** Per-point radius in CSS px (the cell's resolved mark radius). */
  readonly radius: number
  /** Cell viewport size in CSS px (the INSET plot area — toolbar strip already removed). */
  readonly width: number
  readonly height: number
  /** The cell's live view state (`target`/`zoom`) — same object the deck view renders with. */
  readonly viewState: CellViewStateLike
  /** Over this many points ⇒ return null (raster fallback). Default `SCATTER_VECTOR_MAX`. */
  readonly maxPoints?: number
  /** Optional plot background (CSS color) painted behind the marks. */
  readonly background?: string
  /** Shift every projected point by (offsetX, offsetY) — used when the plot sits beside a LEFT legend
   *  gutter, so the circles occupy the plot region and the gutter stays clear. Default 0. */
  readonly offsetX?: number
  readonly offsetY?: number
  /** Total scene size (≥ the projected plot size + offset) — used to reserve a legend gutter beside the
   *  plot. Default = `width`/`height` (no gutter). */
  readonly sceneWidth?: number
  readonly sceneHeight?: number
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/**
 * Build a `VectorScene` of one circle per visible point, or `null` when the pane is empty / too dense
 * / the viewport is degenerate (caller then falls back to the raster crop). Circles are emitted in
 * point-array order — the SAME painter's order the deck draws in — so overlapping/alpha stacking matches.
 */
export function scatterToVectorScene(inp: ScatterVectorInput): VectorScene | null {
  const cap = inp.maxPoints ?? SCATTER_VECTOR_MAX
  if (inp.nPoints <= 0 || inp.nPoints > cap) return null
  if (inp.positions.length < inp.nPoints * 2 || inp.colors.length < inp.nPoints * 4) return null
  const vp = makeCellViewport(inp.width, inp.height, inp.viewState)
  if (!vp) return null
  const r = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, inp.radius))
  const dx = inp.offsetX ?? 0
  const dy = inp.offsetY ?? 0
  const W = inp.width // the PLOT (projection) width — culling is against the plot region, pre-offset
  const H = inp.height
  const marks: VectorMark[] = []
  for (let i = 0; i < inp.nPoints; i++) {
    const a = inp.colors[i * 4 + 3]
    if (a === 0) continue // filtered-out by the value-range visualMap mask (WYSIWYG)
    const s = vp.project([inp.positions[i * 2], inp.positions[i * 2 + 1]])
    const px = s[0]
    const py = s[1]
    // Cull points projected outside the PLOT (deck clips them on screen too) — with a radius margin.
    if (px < -r || py < -r || px > W + r || py > H + r) continue
    const cx = px + dx
    const cy = py + dy
    const rr = inp.colors[i * 4]
    const gg = inp.colors[i * 4 + 1]
    const bb = inp.colors[i * 4 + 2]
    const fill = a >= 255 ? `#${hex2(rr)}${hex2(gg)}${hex2(bb)}` : `rgba(${rr},${gg},${bb},${(a / 255).toFixed(3)})`
    marks.push({ type: 'circle', cx, cy, r, fill })
  }
  return { width: inp.sceneWidth ?? W, height: inp.sceneHeight ?? H, marks, background: inp.background }
}
