// ChartFrame.tsx — the shared GPU chart-chrome helper (ITEM-17 / DEC-23). `buildChartFrameLayers`
// turns a chart's data bounds + tick spec into deck.gl `LineLayer` + `TextLayer` instances:
// axis lines, dashed gridlines, tick marks, tick LABELS, and axis TITLES — 100% GPU, NO SVG,
// NO DOM text. Every position is DATA-SPACE, so the frame aligns exactly with ChartCanvas's
// auto-fit OrthographicView; screen nudges ride `getPixelOffset`. The pure geometry lives in
// `chartFrameGeometry.ts` (node-testable); this module is the thin layer wrapper (mirrors the
// pure-builder → thin-layer split in `chartLayers.ts` / `ChartCanvas`). CHROME is theme-aware
// (DEC-39): a `ChartTheme` supplies fg/grid/muted colors so the frame reads on light AND dark;
// the caller passes the theme, defaulting to `LIGHT_CHART_THEME`.

import { LineLayer, TextLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import {
  buildChartFrameGeometry,
  type FrameBounds,
  type FrameLabel,
  type FrameRGBA,
  type FrameSegment,
  type TickSpec,
} from './chartFrameGeometry'

/** Theme-aware chrome colors (DEC-39). `fg` = axis/title, `grid` = gridlines, `muted` = tick labels. */
export interface ChartTheme {
  /** Axis lines, tick marks, axis titles. */
  readonly fg: string
  /** Gridlines. */
  readonly grid: string
  /** Secondary text (tick labels). */
  readonly muted: string
}

/** Default light-theme chrome (slate ramp) — matches the app's light design tokens. */
export const LIGHT_CHART_THEME: ChartTheme = {
  fg: '#334155', // slate-700
  grid: '#e2e8f0', // slate-200
  muted: '#64748b', // slate-500
}

/** Companion dark-theme chrome, for stories/tests that render dark directly. */
export const DARK_CHART_THEME: ChartTheme = {
  fg: '#cbd5e1', // slate-300
  grid: '#1e293b', // slate-800 — subtle gridlines on a dark background (#14: slate-700 was too bright)
  muted: '#94a3b8', // slate-400
}

/**
 * The theme a chart VIEW defaults to when its caller passes none (#14). Reads the showcase's
 * published `document.documentElement.dataset.vizTheme` so a story renders dark chrome in dark
 * mode without every story having to thread a theme prop. Falls back to light (SSR / no document /
 * unset). An explicit `theme` prop always wins.
 */
export function defaultChartTheme(): ChartTheme {
  if (typeof document !== 'undefined' && document.documentElement.dataset.vizTheme === 'dark') {
    return DARK_CHART_THEME
  }
  return LIGHT_CHART_THEME
}

export interface ChartFrameOpts {
  readonly bounds: FrameBounds
  readonly xTitle?: string
  readonly yTitle?: string
  readonly xTicks?: TickSpec
  readonly yTicks?: TickSpec
  /** default true. */
  readonly showGrid?: boolean
  readonly theme?: ChartTheme
  readonly tickCount?: number
  /** deck.gl layer-id prefix (default `viz-frame`); pass a per-view value to stay unique. */
  readonly id?: string
  /** Typography override (from a cell's `typography`): a free-text `family` + tick/title sizes for the
   *  axis labels + titles. Absent fields ⇒ the built-in defaults (tick 11 / title 13 / deck default font). */
  readonly font?: { readonly family?: string; readonly tickSize?: number; readonly titleSize?: number }
}

/** Parse a `#rgb` / `#rrggbb` / `rgb()` / `rgba()` color string into an RGBA byte tuple. */
export function parseColor(input: string, fallbackAlpha = 255): FrameRGBA {
  const s = input.trim()
  if (s.startsWith('#')) {
    let hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split('')
        .map(c => c + c)
        .join('')
    }
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    const a = hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) : fallbackAlpha
    if ([r, g, b].every(Number.isFinite)) return [r, g, b, Number.isFinite(a) ? a : fallbackAlpha]
  }
  const m = s.match(/rgba?\(([^)]+)\)/i)
  if (m) {
    const parts = m[1].split(',').map(p => parseFloat(p.trim()))
    const [r, g, b] = parts
    const a = parts.length >= 4 ? Math.round((parts[3] as number) * 255) : fallbackAlpha
    if ([r, g, b].every(Number.isFinite)) return [r, g, b, a]
  }
  // opaque black fallback — a visible frame beats an invisible one on parse failure
  return [0, 0, 0, fallbackAlpha]
}

const anchorMap = { start: 'start', middle: 'middle', end: 'end' } as const
const baselineMap = { top: 'top', center: 'center', bottom: 'bottom' } as const

function lineLayer(id: string, data: readonly FrameSegment[], color: FrameRGBA, width: number): LineLayer {
  return new LineLayer<FrameSegment>({
    id,
    data: data as FrameSegment[],
    getSourcePosition: (d: FrameSegment) => d.source,
    getTargetPosition: (d: FrameSegment) => d.target,
    getColor: color,
    getWidth: width,
    widthUnits: 'pixels',
    widthMinPixels: 1,
    pickable: false,
  })
}

function textLayer(id: string, data: readonly FrameLabel[], color: FrameRGBA, size: number, fontFamily?: string): TextLayer {
  return new TextLayer<FrameLabel>({
    id,
    data: data as FrameLabel[],
    getPosition: (d: FrameLabel) => d.position,
    getText: (d: FrameLabel) => d.text,
    getSize: size,
    sizeUnits: 'pixels',
    // A free-text family: deck builds a font atlas from it (renders any font the browser can load, else
    // falls back to its default atlas font). Omitted ⇒ deck's default.
    ...(fontFamily ? { fontFamily } : {}),
    getColor: color,
    getAngle: (d: FrameLabel) => d.angle,
    getTextAnchor: (d: FrameLabel) => anchorMap[d.anchor],
    getAlignmentBaseline: (d: FrameLabel) => baselineMap[d.baseline],
    getPixelOffset: (d: FrameLabel) => d.pixelOffset,
    pickable: false,
  })
}

/**
 * Build the deck.gl chart-frame layers (in back-to-front order: gridlines, axis lines, tick
 * marks, tick labels, axis titles) for the given data bounds. Prepend these behind a chart's
 * data marks so gridlines sit behind the data while the axis/labels frame it. Every position
 * is data-space, so the frame co-registers with ChartCanvas's auto-fit view.
 */
export function buildChartFrameLayers(opts: ChartFrameOpts): Layer[] {
  const theme = opts.theme ?? LIGHT_CHART_THEME
  const id = opts.id ?? 'viz-frame'
  const geom = buildChartFrameGeometry({
    bounds: opts.bounds,
    xTitle: opts.xTitle,
    yTitle: opts.yTitle,
    xTicks: opts.xTicks,
    yTicks: opts.yTicks,
    showGrid: opts.showGrid,
    tickCount: opts.tickCount,
  })

  const fg = parseColor(theme.fg)
  const grid = parseColor(theme.grid)
  const muted = parseColor(theme.muted)

  const family = opts.font?.family
  const tickSize = opts.font?.tickSize ?? 11
  const titleSize = opts.font?.titleSize ?? 13

  const layers: Layer[] = []
  if (geom.grid.length > 0) layers.push(lineLayer(`${id}-grid`, geom.grid, grid, 1))
  layers.push(lineLayer(`${id}-axis`, geom.axis, fg, 1.5))
  layers.push(lineLayer(`${id}-ticks`, geom.ticks, fg, 1))
  layers.push(textLayer(`${id}-tick-labels`, geom.tickLabels, muted, tickSize, family))
  if (geom.titles.length > 0) layers.push(textLayer(`${id}-titles`, geom.titles, fg, titleSize, family))
  return layers
}
