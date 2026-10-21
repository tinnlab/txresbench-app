// chartVector.ts — turn a CHART cell's published deck layers into TRUE VECTOR marks so box / bar /
// histogram / volcano / violin / dotplot / heatmap export as publication-quality SVG/PDF/EPS (real
// <rect>/<line>/<polygon>/<circle>/<text>) instead of a raster crop. The scatter has `scatterVector.ts`;
// this is its chart analog — GENERIC over the deck layer types the chart builders emit (ChartFrame's
// LineLayer/TextLayer, box/bar/histogram SolidPolygonLayer, violin/box-outlier/volcano/dotplot
// ScatterplotLayer, heatmap BitmapLayer), projecting every layer's data-space geometry to screen through
// the SAME OrthographicView the shared deck renders it with (respecting the cell's `flipY`).
//
// Dense/un-vectorable layers (the heatmap value grid; a scatter cloud over the circle cap) fall back to a
// raster IMAGE tile via the caller-supplied `rasterize(screenRect)` (which crops the live deck canvas) —
// the standard publication hybrid: vector frame + labels, raster data texture.
//
// Reads deck Layer `.props` (accessors + data) directly; handles both the plain-array-with-accessor form
// and the `{ length, attributes:{ getX:{value,size} } }` binary form the scatter builders produce.

import { OrthographicView, type Layer } from '@deck.gl/core'
import type { VectorScene, VectorMark, VectorText } from './vector'
import type { CellViewStateLike } from '../grid/gridSelection'

// One reusable view per flipY convention — `makeViewport` is pure matrix math (no GL).
const ORTHO_NOFLIP = new OrthographicView({ flipY: false })
const ORTHO_FLIP = new OrthographicView({ flipY: true })

/** Above this many points a single ScatterplotLayer rasterizes (its projected region) instead of emitting
 *  per-point circles — an SVG with hundreds of thousands of `<circle>`s chokes the string builder. */
export const CHART_VECTOR_MAX_CIRCLES = 60_000

type Pt = readonly [number, number]
type AnyLayer = Layer & { props: Record<string, unknown> }

const hx = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
/** deck color ([r,g,b] or [r,g,b,a], 0–255) → CSS. Alpha < 255 ⇒ rgba(). */
function css(c: ArrayLike<number> | undefined, fallback = '#000000'): string {
  if (!c || c.length < 3) return fallback
  const a = c.length >= 4 ? c[3] : 255
  return a >= 255 ? `#${hx(c[0])}${hx(c[1])}${hx(c[2])}` : `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${(a / 255).toFixed(3)})`
}

/** Resolve a deck accessor (a constant OR a `(d, info) => value` function) over one datum. */
function acc<T>(a: unknown, d: unknown, i: number, data: unknown): T {
  return (typeof a === 'function' ? (a as (d: unknown, info: { index: number; data: unknown }) => T)(d, { index: i, data }) : a) as T
}

/** A layer's data as an iterable of {datum,index}, for the plain-array form. Binary data is handled inline. */
function isBinary(data: unknown): data is { length: number; attributes: Record<string, { value: ArrayLike<number>; size: number }> } {
  return !!data && typeof data === 'object' && 'attributes' in (data as object) && 'length' in (data as object)
}

export interface ChartVectorInput {
  readonly layers: readonly Layer[]
  readonly viewState: CellViewStateLike
  /** Plot (projection) size in CSS px — the deck view rect (toolbar + legend gutter already removed). */
  readonly width: number
  readonly height: number
  readonly flipY: boolean
  /** Shift every mark by (offsetX, offsetY) — the left legend gutter offset (mirror scatterVector). */
  readonly offsetX?: number
  readonly offsetY?: number
  /** Total scene size (≥ plot + offset) so a beside legend gutter is reserved. Default = width/height. */
  readonly sceneWidth?: number
  readonly sceneHeight?: number
  readonly background?: string
  readonly maxCircles?: number
  /** Crop the live deck canvas to a SCREEN rect (post-offset, scene coords) → a data:PNG. Used for the
   *  heatmap value grid + over-cap scatter clouds. `null` ⇒ that layer is dropped (frame stays vector). */
  readonly rasterize?: (x: number, y: number, w: number, h: number) => string | null
}

/** Build a VectorScene from a chart cell's published deck layers, or `null` when the viewport is
 *  degenerate / nothing converted (caller then falls back to the raster crop). */
export function chartLayersToVectorScene(inp: ChartVectorInput): VectorScene | null {
  if (inp.width <= 0 || inp.height <= 0) return null
  const view = inp.flipY ? ORTHO_FLIP : ORTHO_NOFLIP
  const vp = view.makeViewport({
    width: inp.width,
    height: inp.height,
    viewState: { target: [inp.viewState.target[0] ?? 0, inp.viewState.target[1] ?? 0, 0], zoom: inp.viewState.zoom },
  })
  if (!vp) return null
  const dx = inp.offsetX ?? 0
  const dy = inp.offsetY ?? 0
  const cap = inp.maxCircles ?? CHART_VECTOR_MAX_CIRCLES
  const pr = (x: number, y: number): [number, number] => {
    const s = vp.project([x, y])
    return [s[0] + dx, s[1] + dy]
  }
  const marks: VectorMark[] = []
  let converted = 0

  for (const raw of inp.layers) {
    const layer = raw as AnyLayer
    const p = layer?.props
    if (!p || p.visible === false) continue
    const data = p.data
    try {
      // ── BitmapLayer (heatmap value grid) → raster IMAGE tile of its projected bounds ────────────
      if (p.image != null && Array.isArray(p.bounds)) {
        const [l, b, r, t] = p.bounds as number[]
        const [x0, y0] = pr(l, t)
        const [x1, y1] = pr(r, b)
        let rx = Math.min(x0, x1), ry = Math.min(y0, y1)
        let rex = Math.max(x0, x1), rey = Math.max(y0, y1)
        // Clip the projected full-matrix rect to the visible PLOT region so a WINDOWED (zoomed/panned)
        // heatmap exports a 1:1 crop of what's on screen, not the whole matrix stretched across the plot
        // (MED-3). `rasterize()` crops the live canvas, so region == placement ⇒ no stretch/misalignment.
        rx = Math.max(rx, dx); ry = Math.max(ry, dy)
        rex = Math.min(rex, dx + inp.width); rey = Math.min(rey, dy + inp.height)
        const rw = rex - rx, rh = rey - ry
        if (rw > 0 && rh > 0) {
          const href = inp.rasterize?.(rx, ry, rw, rh)
          if (href) { marks.push({ type: 'image', x: rx, y: ry, w: rw, h: rh, href }); converted++ }
        }
        continue
      }
      // ── TextLayer → VectorText ─────────────────────────────────────────────────────────────────
      if (p.getText != null && Array.isArray(data)) {
        const size = 12
        for (let i = 0; i < data.length; i++) {
          const d = data[i]
          const text = acc<string>(p.getText, d, i, data)
          if (text == null || text === '') continue
          const pos = acc<Pt>(p.getPosition, d, i, data)
          const [sx, sy] = pr(pos[0], pos[1])
          const off = (acc<Pt>(p.getPixelOffset, d, i, data) as Pt | undefined) ?? [0, 0]
          const fs = (acc<number>(p.getSize, d, i, data) as number | undefined) ?? size
          const anchor = ((acc<string>(p.getTextAnchor, d, i, data) as string) ?? 'start') as VectorText['anchor']
          const baseline = (acc<string>(p.getAlignmentBaseline, d, i, data) as string) ?? 'center'
          const angle = (acc<number>(p.getAngle, d, i, data) as number | undefined) ?? 0
          // deck y-alignment (top/center/bottom of glyph at `pos`) → SVG baseline y (approx ascent/2/descent).
          const by = baseline === 'top' ? fs * 0.8 : baseline === 'bottom' ? -fs * 0.1 : fs * 0.32
          marks.push({
            type: 'text', x: sx + off[0], y: sy + off[1] + by, text, size: fs,
            fill: css(acc<number[]>(p.getColor, d, i, data) ?? p.getColor as number[]), anchor,
            ...(angle ? { rotate: -angle } : {}), // deck angle is CCW; SVG rotate is CW
            ...(typeof p.fontFamily === 'string' ? { fontFamily: p.fontFamily } : {}),
          })
          converted++
        }
        continue
      }
      // ── Polygon (box IQR / bars / histogram bins) → VectorPolygon ──────────────────────────────
      if (p.getPolygon != null && Array.isArray(data)) {
        const stroked = p.stroked === true
        for (let i = 0; i < data.length; i++) {
          const d = data[i]
          const ring = acc<Pt[]>(p.getPolygon, d, i, data)
          if (!ring || ring.length < 2) continue
          const points = ring.map(pt => pr(pt[0], pt[1]))
          const fill = p.filled === false ? undefined : css(acc<number[]>(p.getFillColor, d, i, data), '#888888')
          const stroke = stroked ? css(acc<number[]>(p.getLineColor, d, i, data), '#333333') : undefined
          marks.push({ type: 'polygon', points, fill, stroke, ...(stroke ? { width: 1 } : {}) })
          converted++
        }
        continue
      }
      // ── LineLayer (axes / gridlines / whiskers / guides) → VectorLine ──────────────────────────
      if (p.getSourcePosition != null && Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          const d = data[i]
          const s = acc<Pt>(p.getSourcePosition, d, i, data)
          const t = acc<Pt>(p.getTargetPosition, d, i, data)
          const [x1, y1] = pr(s[0], s[1])
          const [x2, y2] = pr(t[0], t[1])
          const wRaw = acc<number>(p.getWidth, d, i, data)
          const w = typeof wRaw === 'number' ? wRaw : (p.getWidth as number) ?? 1
          marks.push({ type: 'line', x1, y1, x2, y2, stroke: css(acc<number[]>(p.getColor, d, i, data) ?? p.getColor as number[]), width: Math.max(0.5, w) })
          converted++
        }
        continue
      }
      // ── PathLayer → VectorPolyline ─────────────────────────────────────────────────────────────
      if (p.getPath != null && Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
          const d = data[i]
          const path = acc<Pt[] | Float64Array>(p.getPath, d, i, data)
          if (!path || path.length < 2) continue
          // A `PathLayer` path comes in TWO dialects: nested `[[x,y],…]` (normalized layers) or a
          // FLAT `[x0,y0,…]` typed array (layers that set `_pathType` + `positionFormat:'XY'` —
          // see the PATH-LAYER DATA CONTRACT in buildAnnotationLayers.ts). Reading a flat array as
          // nested silently yields NaN points, so branch on the shape.
          const pts: [number, number][] = []
          if (ArrayBuffer.isView(path)) {
            const flat = path as Float64Array
            for (let k = 0; k + 1 < flat.length; k += 2) pts.push(pr(flat[k], flat[k + 1]))
          } else {
            for (const pt of path as Pt[]) pts.push(pr(pt[0], pt[1]))
          }
          if (pts.length < 2) continue
          marks.push({ type: 'polyline', points: pts, stroke: css(acc<number[]>(p.getColor, d, i, data) ?? p.getColor as number[]), width: 1 })
          converted++
        }
        continue
      }
      // ── ScatterplotLayer (violin jitter / box outliers / volcano points / dotplot dots) ─────────
      if (p.getRadius != null || (p.getPosition != null && /Scatter/.test((layer.constructor as { layerName?: string }).layerName ?? ''))) {
        const rMin = (p.radiusMinPixels as number) ?? 0.5
        const rMax = (p.radiusMaxPixels as number) ?? 8
        const clampR = (r: number) => Math.max(rMin, Math.min(rMax, r))
        // STROKE support: a `stroked` layer (the box MEAN marker = white fill + dark ring, or a hollow
        // hover ring with `filled:false`) must export its outline, or the mark is invisible white-on-white.
        const stroked = p.stroked === true
        const noFill = p.filled === false
        const strokeW = stroked ? ((p.getLineWidth as number) ?? 1) : undefined
        if (isBinary(data)) {
          const n = data.length
          const pos = data.attributes.getPosition?.value
          const col = data.attributes.getFillColor?.value
          const rad = data.attributes.getRadius?.value
          const rConst = typeof p.getRadius === 'number' ? (p.getRadius as number) : 2
          if (!pos) continue
          if (n > cap) { rasterLayerRegion(marks, layer, pr, inp.rasterize); converted++; continue }
          const strokeCss = stroked ? css(acc<number[]>(p.getLineColor, undefined, 0, data), '#333333') : undefined
          for (let i = 0; i < n; i++) {
            const a = col ? col[i * 4 + 3] : 255
            if (a === 0 && !stroked) continue
            const [cx, cy] = pr(pos[i * 2], pos[i * 2 + 1])
            const r = clampR(rad ? rad[i] : rConst)
            marks.push({ type: 'circle', cx, cy, r, fill: noFill ? undefined : css(col ? [col[i * 4], col[i * 4 + 1], col[i * 4 + 2], a] : undefined, '#666666'), ...(strokeCss ? { stroke: strokeCss, width: strokeW } : {}) })
          }
          converted++
          continue
        }
        if (Array.isArray(data)) {
          if (data.length > cap) { rasterLayerRegion(marks, layer, pr, inp.rasterize); converted++; continue }
          for (let i = 0; i < data.length; i++) {
            const d = data[i]
            const pos = acc<Pt>(p.getPosition, d, i, data)
            const [cx, cy] = pr(pos[0], pos[1])
            const rRaw = acc<number>(p.getRadius, d, i, data)
            const r = clampR(typeof rRaw === 'number' ? rRaw : 2)
            marks.push({ type: 'circle', cx, cy, r, fill: noFill ? undefined : css(acc<number[]>(p.getFillColor, d, i, data), '#666666'), ...(stroked ? { stroke: css(acc<number[]>(p.getLineColor, d, i, data), '#333333'), width: strokeW } : {}) })
          }
          converted++
          continue
        }
      }
    } catch {
      // A layer we can't read → skip it (the rest still vectorizes; frame beats a crash).
      continue
    }
  }

  if (converted === 0) return null
  return { width: inp.sceneWidth ?? inp.width, height: inp.sceneHeight ?? inp.height, marks, background: inp.background }
}

/** Raster-tile an over-cap scatter layer's projected bounding box (best-effort; skipped if no rasterize
 *  or the layer has no readable positions). */
function rasterLayerRegion(marks: VectorMark[], layer: AnyLayer, pr: (x: number, y: number) => [number, number], rasterize?: (x: number, y: number, w: number, h: number) => string | null): void {
  if (!rasterize) return
  const data = (layer.props.data as { attributes?: Record<string, { value: ArrayLike<number> }>; length?: number })
  const pos = data?.attributes?.getPosition?.value
  const n = data?.length ?? 0
  if (!pos || n === 0) return
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const [x, y] = pr(pos[i * 2], pos[i * 2 + 1])
    if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y
  }
  const href = rasterize(minX, minY, maxX - minX, maxY - minY)
  if (href) marks.push({ type: 'image', x: minX, y: minY, w: maxX - minX, h: maxY - minY, href })
}
