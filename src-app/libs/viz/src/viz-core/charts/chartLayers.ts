// chartLayers.ts — pure deck.gl layer-PROP builders for the companion statistical
// charts (violin / box / dotplot / heatmap / volcano / bar / histogram). STRICT
// all-GPU: every mark is a deck.gl layer, NO SVG (DEC-18/23). These are pure
// functions that return plain prop OBJECTS (no GL context, no layer instances) so
// they unit-test in node — the canvas component spreads them into the real layer
// constructors. Naming is domain-agnostic (DEC-28): `group`/`category`/`series`/
// `row`/`col`/`value`/`fraction`/`x`/`y` — no biology terms. This module only
// BUILDS layer props; the statistical PRE-PASS math lives in `./aggregate` (DEC-29).
//
// Style mirrors `../layers/scatter.ts`: large point marks feed BINARY typed-array
// attributes (via `buildScatterProps`), while the low-cardinality chart chrome
// (polygon rings / line segments) stays as small plain arrays with accessors.

import { buildScatterProps, type ScatterProps } from '../layers/scatter'
import {
  categoryColor,
  continuousColors,
  DEFAULT_CONTINUOUS_COLORMAP,
  type ContinuousColormap,
} from '../data/color'
import type { DensityPoint, ViolinGroup } from './aggregate'

// A closed polygon ring as an array of [x, y] vertices (SolidPolygonLayer input).
export type Ring = [number, number][]
export type RGBA = [number, number, number, number]

/** Axis-aligned rectangle → a 4-vertex ring (CCW), reused by box/bar/histogram. */
export function rectRing(x0: number, y0: number, x1: number, y1: number): Ring {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
}

/** A single line segment for `LineLayer` (whiskers / median / threshold guides). */
export interface Segment {
  readonly source: [number, number]
  readonly target: [number, number]
  readonly color: RGBA
}

/** `LineLayer`-style props object shared by box whiskers + volcano guides. */
export interface LineSegmentProps {
  readonly id: string
  readonly data: readonly Segment[]
  readonly getSourcePosition: (s: Segment) => [number, number]
  readonly getTargetPosition: (s: Segment) => [number, number]
  readonly getColor: (s: Segment) => RGBA
  readonly getWidth: number
  readonly widthUnits: 'pixels'
  readonly widthMinPixels: number
}

function lineSegmentProps(id: string, data: Segment[], width = 1.5): LineSegmentProps {
  return {
    id,
    data,
    getSourcePosition: s => s.source,
    getTargetPosition: s => s.target,
    getColor: s => s.color,
    getWidth: width,
    widthUnits: 'pixels',
    widthMinPixels: 1,
  }
}

// ── 1. Violin — KDE mirrored into a SolidPolygonLayer ring (+ optional jitter) ──

/** One violin polygon: a group's KDE mirrored L/R around its category center. */
export interface ViolinRing {
  readonly group: string
  readonly polygon: Ring
  readonly fillColor: RGBA
}

export interface ViolinProps {
  readonly id: string
  readonly data: readonly ViolinRing[]
  readonly getPolygon: (d: ViolinRing) => Ring
  readonly getFillColor: (d: ViolinRing) => RGBA
  readonly filled: true
  readonly stroked: boolean
  readonly extruded: false
  readonly pickable: boolean
}

/** An EFFECTIVE per-group-code palette (from `resolveEffectivePalette`). Absent ⇒ the built-in
 *  `categoryColor(i)` cycle (byte-identical to the pre-override builders). */
export type EffectivePalette = readonly (readonly [number, number, number])[]

/** Effective color for group index `i`: the override palette entry, else the built-in cycle. */
function paletteColorAt(colors: EffectivePalette | undefined, i: number): readonly [number, number, number] {
  return colors?.[i] ?? categoryColor(i)
}

export interface ViolinBuildOpts {
  id?: string
  /** Half-width (data units) at the group's max density. */
  width?: number
  /** Category center-to-center spacing. */
  spacing?: number
  fillAlpha?: number
  /** Optional raw values per group (index-aligned to `groups`) for the jitter overlay. */
  jitter?: readonly { readonly group: string; readonly values: ArrayLike<number> }[]
  jitterWidth?: number
  jitterRadiusPixels?: number
  /** Optional EFFECTIVE per-group palette (custom / by-name / auto-extended). */
  colors?: EffectivePalette
}

export interface ViolinResult {
  readonly violin: ViolinProps
  readonly jitter?: ScatterProps
  /** The x center of each group (for chrome / ticks). */
  readonly centers: number[]
}

/** Deterministic [0,1) pseudo-random so the jitter is stable + unit-testable. */
function stableRand(i: number): number {
  const s = Math.sin((i + 1) * 127.1) * 43758.5453
  return s - Math.floor(s)
}

/**
 * Build the violin `SolidPolygonLayer` props: each group's KDE curve is mirrored
 * into a closed ring — up the left side (center − w) then back down the right
 * (center + w) — where w scales with density. An optional jitter `ScatterplotLayer`
 * companion is emitted when raw per-group values are supplied.
 */
export function buildViolinProps(
  groups: readonly ViolinGroup[],
  opts: ViolinBuildOpts = {},
): ViolinResult {
  const halfWidth = opts.width ?? 0.4
  const spacing = opts.spacing ?? 1
  const alpha = opts.fillAlpha ?? 180

  let maxDensity = 0
  for (const g of groups) {
    for (const d of g.density) if (d.density > maxDensity) maxDensity = d.density
  }
  const norm = maxDensity > 0 ? halfWidth / maxDensity : 0

  const centers: number[] = []
  const data: ViolinRing[] = groups.map((g, gi) => {
    const cx = gi * spacing
    centers.push(cx)
    const curve: DensityPoint[] = g.density
    const left: [number, number][] = curve.map(d => [cx - d.density * norm, d.x])
    const right: [number, number][] = []
    for (let i = curve.length - 1; i >= 0; i--) {
      right.push([cx + curve[i].density * norm, curve[i].x])
    }
    const [r, gg, b] = paletteColorAt(opts.colors, gi)
    return { group: g.group, polygon: [...left, ...right], fillColor: [r, gg, b, alpha] as RGBA }
  })

  const violin: ViolinProps = {
    id: opts.id ?? 'viz-violin',
    data,
    getPolygon: d => d.polygon,
    getFillColor: d => d.fillColor,
    filled: true,
    stroked: false,
    extruded: false,
    pickable: true,
  }

  let jitter: ScatterProps | undefined
  if (opts.jitter && opts.jitter.length > 0) {
    const jw = opts.jitterWidth ?? halfWidth * 0.6
    let total = 0
    for (const j of opts.jitter) total += j.values.length
    const positions = new Float32Array(total * 2)
    const colors = new Uint8Array(total * 4)
    let p = 0
    let k = 0
    for (let gi = 0; gi < opts.jitter.length; gi++) {
      const cx = gi * spacing
      const [r, gg, b] = paletteColorAt(opts.colors, gi)
      const vals = opts.jitter[gi].values
      for (let i = 0; i < vals.length; i++) {
        const off = (stableRand(k) - 0.5) * 2 * jw
        positions[p * 2] = cx + off
        positions[p * 2 + 1] = vals[i]
        colors[p * 4] = r
        colors[p * 4 + 1] = gg
        colors[p * 4 + 2] = b
        colors[p * 4 + 3] = 200
        p++
        k++
      }
    }
    jitter = buildScatterProps({
      id: (opts.id ?? 'viz-violin') + '-jitter',
      positions,
      colors,
      radius: opts.jitterRadiusPixels ?? 1.5,
      radiusUnits: 'pixels',
      pickable: false,
    })
  }

  return { violin, jitter, centers }
}

// ── 2. Box — SolidPolygon rects + LineLayer whiskers/median + Scatter outliers ──

export interface BoxStat {
  readonly group: string
  readonly q1: number
  readonly median: number
  readonly q3: number
  readonly lowerFence: number
  readonly upperFence: number
  readonly outliers: readonly number[]
}

export interface BoxRect {
  readonly group: string
  readonly polygon: Ring
  readonly fillColor: RGBA
}

export interface BoxPolyProps {
  readonly id: string
  readonly data: readonly BoxRect[]
  readonly getPolygon: (d: BoxRect) => Ring
  readonly getFillColor: (d: BoxRect) => RGBA
  readonly filled: true
  readonly stroked: boolean
  readonly extruded: false
  readonly pickable: boolean
}

export interface BoxBuildOpts {
  id?: string
  /** Half-width of the box rect in data units. */
  width?: number
  spacing?: number
  fillAlpha?: number
  outlierRadiusPixels?: number
  /** Optional EFFECTIVE per-group palette (custom / by-name / auto-extended). */
  colors?: EffectivePalette
}

export interface BoxResult {
  readonly boxes: BoxPolyProps
  readonly lines: LineSegmentProps
  readonly outliers?: ScatterProps
  readonly centers: number[]
}

/**
 * Build the box-plot layer props: the IQR box as a `SolidPolygonLayer` rect, the
 * whiskers + fence caps + median as `LineLayer` segments, and any outliers as a
 * `ScatterplotLayer` — each returned as its own prop object.
 */
export function buildBoxProps(boxes: readonly BoxStat[], opts: BoxBuildOpts = {}): BoxResult {
  const hw = opts.width ?? 0.3
  const spacing = opts.spacing ?? 1
  const alpha = opts.fillAlpha ?? 160
  const lineColor: RGBA = [60, 60, 60, 255]

  const centers: number[] = []
  const rects: BoxRect[] = []
  const segments: Segment[] = []
  const outlierXY: number[] = []
  const outlierRGBA: number[] = []

  boxes.forEach((b, gi) => {
    const cx = gi * spacing
    centers.push(cx)
    const [r, g, bl] = paletteColorAt(opts.colors, gi)
    rects.push({
      group: b.group,
      polygon: rectRing(cx - hw, b.q1, cx + hw, b.q3),
      fillColor: [r, g, bl, alpha],
    })
    // whiskers (box edge → fence)
    segments.push({ source: [cx, b.q3], target: [cx, b.upperFence], color: lineColor })
    segments.push({ source: [cx, b.q1], target: [cx, b.lowerFence], color: lineColor })
    // fence caps
    segments.push({
      source: [cx - hw / 2, b.upperFence],
      target: [cx + hw / 2, b.upperFence],
      color: lineColor,
    })
    segments.push({
      source: [cx - hw / 2, b.lowerFence],
      target: [cx + hw / 2, b.lowerFence],
      color: lineColor,
    })
    // median line across the box
    segments.push({
      source: [cx - hw, b.median],
      target: [cx + hw, b.median],
      color: lineColor,
    })
    for (const o of b.outliers) {
      outlierXY.push(cx, o)
      outlierRGBA.push(r, g, bl, 220)
    }
  })

  const boxProps: BoxPolyProps = {
    id: (opts.id ?? 'viz-box') + '-boxes',
    data: rects,
    getPolygon: d => d.polygon,
    getFillColor: d => d.fillColor,
    filled: true,
    stroked: false,
    extruded: false,
    pickable: true,
  }

  let outliers: ScatterProps | undefined
  if (outlierXY.length > 0) {
    outliers = buildScatterProps({
      id: (opts.id ?? 'viz-box') + '-outliers',
      positions: new Float32Array(outlierXY),
      colors: new Uint8Array(outlierRGBA),
      radius: opts.outlierRadiusPixels ?? 2,
      radiusUnits: 'pixels',
      pickable: true,
    })
  }

  return {
    boxes: boxProps,
    lines: lineSegmentProps((opts.id ?? 'viz-box') + '-lines', segments),
    outliers,
    centers,
  }
}

// ── 3. Dotplot — categorical grid ScatterplotLayer (radius=fraction, color=value) ─

/** One dotplot cell on a `row × col` categorical grid (value→color, fraction→radius). */
export interface DotCellInput {
  readonly row: string
  readonly col: string
  readonly value: number
  readonly fraction: number
}

export interface DotplotBuildOpts {
  id?: string
  colormap?: ContinuousColormap
  domain?: readonly [number, number]
  maxRadiusPixels?: number
}

export interface DotplotResult {
  readonly dots: ScatterProps
  readonly rows: string[]
  readonly cols: string[]
  readonly domain: readonly [number, number]
}

/** First-seen-order unique values (stable categorical axis ordering). */
export function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/**
 * Build the dotplot `ScatterplotLayer` props on a categorical grid: getPosition is
 * (colIndex, rowIndex), getRadius scales with `fraction`, and getFillColor maps
 * `value` through the continuous colormap. Rows/cols axes are returned for chrome.
 */
export function buildDotplotProps(
  cells: readonly DotCellInput[],
  opts: DotplotBuildOpts = {},
): DotplotResult {
  const rows = uniqueInOrder(cells.map(c => c.row))
  const cols = uniqueInOrder(cells.map(c => c.col))
  const rowIdx = new Map(rows.map((r, i) => [r, i] as const))
  const colIdx = new Map(cols.map((c, i) => [c, i] as const))
  const maxR = opts.maxRadiusPixels ?? 12

  const n = cells.length
  const positions = new Float32Array(n * 2)
  const radii = new Float32Array(n)
  const values = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const c = cells[i]
    positions[i * 2] = colIdx.get(c.col) ?? 0
    positions[i * 2 + 1] = rowIdx.get(c.row) ?? 0
    radii[i] = Math.max(0, Math.min(1, c.fraction)) * maxR
    values[i] = c.value
  }
  const { colors, domain } = continuousColors(values, {
    colormap: opts.colormap ?? DEFAULT_CONTINUOUS_COLORMAP,
    domain: opts.domain,
  })

  const dots = buildScatterProps({
    id: opts.id ?? 'viz-dotplot',
    positions,
    colors,
    radii,
    radiusUnits: 'pixels',
    radiusMaxPixels: maxR,
    pickable: true,
  })

  return { dots, rows, cols, domain }
}

// ── 4. Heatmap — BitmapLayer RGBA data-texture (Vitessce pattern) ────────────────

export interface HeatmapMatrix {
  readonly rows: readonly string[]
  readonly cols: readonly string[]
  /** Row-major, length rows×cols. */
  readonly values: Float32Array
}

export interface HeatmapBuildOpts {
  id?: string
  colormap?: ContinuousColormap
  domain?: readonly [number, number]
}

export interface HeatmapProps {
  readonly id: string
  readonly image: { readonly data: Uint8Array; readonly width: number; readonly height: number }
  readonly bounds: readonly [number, number, number, number]
  readonly textureParameters: { readonly minFilter: 'nearest'; readonly magFilter: 'nearest' }
  readonly pickable: boolean
  readonly domain: readonly [number, number]
}

/**
 * Build the heatmap `BitmapLayer` props by colormapping the row-major value matrix
 * into an RGBA `Uint8Array` data-texture (width=cols, height=rows). `bounds` is
 * [0, rows, cols, 0] so grid cell (col c, row r) covers unit square (c..c+1, r..r+1)
 * with row 0 at the top; nearest-neighbor sampling keeps cells crisp (no blur).
 */
export function buildHeatmapProps(
  matrix: HeatmapMatrix,
  opts: HeatmapBuildOpts = {},
): HeatmapProps {
  const width = matrix.cols.length
  const height = matrix.rows.length
  const { colors, domain } = continuousColors(matrix.values, {
    colormap: opts.colormap ?? DEFAULT_CONTINUOUS_COLORMAP,
    domain: opts.domain,
  })
  return {
    id: opts.id ?? 'viz-heatmap',
    image: { data: colors, width, height },
    bounds: [0, height, width, 0],
    textureParameters: { minFilter: 'nearest', magFilter: 'nearest' },
    pickable: true,
    domain,
  }
}

// ── 5. Volcano — ScatterplotLayer (color by direction) + LineLayer guides ────────

export type VolcanoDirection = 'up' | 'down' | 'ns'

export interface VolcanoPointInput {
  readonly label: string
  /** Effect-size axis (x). */
  readonly x: number
  /** Significance axis (y). */
  readonly y: number
  readonly direction: VolcanoDirection
}

export interface VolcanoBuildOpts {
  id?: string
  fcThreshold?: number
  pThreshold?: number
  radiusPixels?: number
}

export interface VolcanoResult {
  readonly points: ScatterProps
  readonly guides: LineSegmentProps
}

const VOLCANO_COLORS: Record<VolcanoDirection, RGBA> = {
  up: [214, 39, 40, 230],
  down: [31, 119, 180, 230],
  ns: [160, 160, 160, 120],
}

/**
 * Build the volcano `ScatterplotLayer` props (getPosition = [x, y], color keyed by
 * `direction`) plus the `LineLayer` threshold guides: two vertical lines at ±fc and
 * one horizontal line at the p-threshold, spanning the data extent.
 */
export function buildVolcanoProps(
  points: readonly VolcanoPointInput[],
  opts: VolcanoBuildOpts = {},
): VolcanoResult {
  const fcT = opts.fcThreshold ?? 1
  const pT = opts.pThreshold ?? 1.30103 // −log10(0.05)

  const n = points.length
  const positions = new Float32Array(n * 2)
  const colors = new Uint8Array(n * 4)
  let xMin = Infinity
  let xMax = -Infinity
  let yMax = 0
  for (let i = 0; i < n; i++) {
    const pt = points[i]
    positions[i * 2] = pt.x
    positions[i * 2 + 1] = pt.y
    const [r, g, b, a] = VOLCANO_COLORS[pt.direction]
    colors[i * 4] = r
    colors[i * 4 + 1] = g
    colors[i * 4 + 2] = b
    colors[i * 4 + 3] = a
    if (pt.x < xMin) xMin = pt.x
    if (pt.x > xMax) xMax = pt.x
    if (pt.y > yMax) yMax = pt.y
  }
  if (!Number.isFinite(xMin)) {
    xMin = -fcT
    xMax = fcT
  }
  // widen so ±fc guides are always visible even with a narrow point cloud
  xMin = Math.min(xMin, -fcT)
  xMax = Math.max(xMax, fcT)
  yMax = Math.max(yMax, pT)

  const guideColor: RGBA = [120, 120, 120, 200]
  const guides: Segment[] = [
    { source: [fcT, 0], target: [fcT, yMax], color: guideColor },
    { source: [-fcT, 0], target: [-fcT, yMax], color: guideColor },
    { source: [xMin, pT], target: [xMax, pT], color: guideColor },
  ]

  const pointsProps = buildScatterProps({
    id: opts.id ?? 'viz-volcano',
    positions,
    colors,
    radius: opts.radiusPixels ?? 3,
    radiusUnits: 'pixels',
    pickable: true,
  })

  return { points: pointsProps, guides: lineSegmentProps((opts.id ?? 'viz-volcano') + '-guides', guides) }
}

// ── 6. Bar — SolidPolygon rects (grouped / stacked / percent) ────────────────────

export type BarMode = 'grouped' | 'stacked' | 'percent'

export interface BarSeries {
  readonly category: string
  /** One value per sub-series (bar within the category group). */
  readonly values: readonly number[]
}

export interface BarRect {
  readonly category: string
  readonly series: number
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
  readonly polygon: Ring
  readonly fillColor: RGBA
}

export interface BarProps {
  readonly id: string
  readonly data: readonly BarRect[]
  readonly getPolygon: (d: BarRect) => Ring
  readonly getFillColor: (d: BarRect) => RGBA
  readonly filled: true
  readonly stroked: boolean
  readonly extruded: false
  readonly pickable: boolean
  readonly mode: BarMode
}

export interface BarBuildOpts {
  id?: string
  mode?: BarMode
  /** Total width of a category group in data units (grouped) or bar width (stacked). */
  groupWidth?: number
  fillAlpha?: number
  /** Per-CATEGORY fill colors (index = category code), from `resolveEffectivePalette` — so a per-group
   *  recolor reaches the bars. Absent (or a missing index) ⇒ the built-in `categoryColor(j)`. */
  colors?: readonly (readonly [number, number, number])[]
}

/**
 * Build bar-chart rect props. `grouped` places each series side-by-side within the
 * category's group width; `stacked` accumulates each series on top of the previous
 * (cumulative y); `percent` is `stacked` with each category normalized to sum=1.
 */
export function buildBarProps(series: readonly BarSeries[], opts: BarBuildOpts = {}): BarProps {
  const mode: BarMode = opts.mode ?? 'grouped'
  const groupWidth = opts.groupWidth ?? 0.8
  const alpha = opts.fillAlpha ?? 230
  const nSeries = series.reduce((m, s) => Math.max(m, s.values.length), 0)

  const rects: BarRect[] = []
  series.forEach((s, ci) => {
    const total = s.values.reduce((a, b) => a + b, 0)
    let cum = 0
    for (let j = 0; j < s.values.length; j++) {
      const raw = s.values[j]
      // A categorical bar chart is one single-value series PER CATEGORY (nSeries === 1), so color by the
      // CATEGORY index `ci` → each category bar gets its own hue (+ honors the per-group override palette).
      // A genuine multi-value series (nSeries > 1) keeps the per-segment `j` coloring (byte-identical).
      const colorIdx = nSeries > 1 ? j : ci
      const [r, g, b] = opts.colors?.[colorIdx] ?? categoryColor(colorIdx)
      const fill: RGBA = [r, g, b, alpha]
      let x0: number
      let x1: number
      let y0: number
      let y1: number
      if (mode === 'grouped') {
        const barW = groupWidth / Math.max(1, nSeries)
        x0 = ci - groupWidth / 2 + j * barW
        x1 = x0 + barW
        y0 = 0
        y1 = raw
      } else {
        const barW = groupWidth
        x0 = ci - barW / 2
        x1 = ci + barW / 2
        const v = mode === 'percent' ? (total > 0 ? raw / total : 0) : raw
        y0 = cum
        y1 = cum + v
        cum = y1
      }
      rects.push({
        category: s.category,
        series: j,
        x0,
        x1,
        y0,
        y1,
        polygon: rectRing(x0, y0, x1, y1),
        fillColor: fill,
      })
    }
  })

  return {
    id: opts.id ?? 'viz-bar',
    data: rects,
    getPolygon: d => d.polygon,
    getFillColor: d => d.fillColor,
    filled: true,
    stroked: false,
    extruded: false,
    pickable: true,
    mode,
  }
}

// ── 7. Histogram — 1-D binned rects ──────────────────────────────────────────────

export interface HistRect {
  readonly bin: number
  readonly x0: number
  readonly x1: number
  readonly y0: number
  readonly y1: number
  readonly polygon: Ring
  readonly fillColor: RGBA
}

export interface HistogramProps {
  readonly id: string
  readonly data: readonly HistRect[]
  readonly getPolygon: (d: HistRect) => Ring
  readonly getFillColor: (d: HistRect) => RGBA
  readonly filled: true
  readonly stroked: boolean
  readonly extruded: false
  readonly pickable: boolean
}

export interface HistogramBuildOpts {
  id?: string
  fillColor?: RGBA
}

/**
 * Build 1-D histogram rect props from `binEdges` (length B+1) and `counts` (length
 * B): each bin is a rect [edge_i, edge_{i+1}] × [0, count_i].
 */
export function buildHistogramProps(
  binEdges: readonly number[],
  counts: readonly number[],
  opts: HistogramBuildOpts = {},
): HistogramProps {
  const fill = opts.fillColor ?? [70, 130, 180, 220]
  const nBins = Math.min(counts.length, Math.max(0, binEdges.length - 1))
  const rects: HistRect[] = []
  for (let i = 0; i < nBins; i++) {
    const x0 = binEdges[i]
    const x1 = binEdges[i + 1]
    const y1 = counts[i]
    rects.push({
      bin: i,
      x0,
      x1,
      y0: 0,
      y1,
      polygon: rectRing(x0, 0, x1, y1),
      fillColor: fill,
    })
  }
  return {
    id: opts.id ?? 'viz-histogram',
    data: rects,
    getPolygon: d => d.polygon,
    getFillColor: d => d.fillColor,
    filled: true,
    stroked: false,
    extruded: false,
    pickable: true,
  }
}
