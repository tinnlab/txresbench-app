// typography.ts — the per-cell TYPOGRAPHY model for publication-ready figures. A FIGURE-WIDE font
// (family + base size) drives every text element; each element (plot title / axis titles / tick labels /
// legend) may OVERRIDE the family and/or size. Font family is FREE TEXT: the SVG/PNG export renders it
// faithfully (if the system has it) and deck's on-canvas TextLayer renders any font the browser can load,
// falling back to the default atlas font otherwise. Pure + node-testable — no React/deck/DOM.

/** Which text element a style resolves for. */
export type TextElement = 'title' | 'axis' | 'tick' | 'legend'

/** A per-element override (both fields optional — absent ⇒ inherit the figure default / element scale). */
export interface TextOverride {
  readonly size?: number
  readonly family?: string
  /** only meaningful for the title today. */
  readonly weight?: 'normal' | 'bold'
}

/** The per-cell typography config (all optional ⇒ byte-identical defaults). */
export interface Typography {
  /** figure-wide font family (free text, e.g. "Inter", "Arial, sans-serif"). */
  readonly fontFamily?: string
  /** figure-wide base size (px); every element scales off it unless it overrides. */
  readonly baseSize?: number
  readonly title?: TextOverride
  readonly axis?: TextOverride
  readonly tick?: TextOverride
  readonly legend?: TextOverride
}

/** A fully-resolved text style (never partial) for a render/export site. */
export interface ResolvedTextStyle {
  readonly family: string
  readonly size: number
  readonly weight: 'normal' | 'bold'
}

export const DEFAULT_FONT_FAMILY = 'system-ui, sans-serif'
export const DEFAULT_BASE_SIZE = 12

/** Per-element size scale off the figure base (keeps the today-defaults: title 13/tick 11/legend 11 at
 *  base 12 → ~1.08/0.92/0.92; axis title 13 → 1.08). */
const SCALE: Record<TextElement, number> = { title: 1.3, axis: 1.08, tick: 0.92, legend: 0.92 }

const OVERRIDE_KEY: Record<TextElement, keyof Typography> = {
  title: 'title',
  axis: 'axis',
  tick: 'tick',
  legend: 'legend',
}

/**
 * Resolve the effective {family, size, weight} for `el` from `t`. Precedence: per-element override →
 * figure-wide default → built-in. Undefined `t` ⇒ the built-in defaults.
 */
export function resolveTextStyle(t: Typography | undefined, el: TextElement): ResolvedTextStyle {
  const base = t?.baseSize && t.baseSize > 0 ? t.baseSize : DEFAULT_BASE_SIZE
  const family = t?.fontFamily || DEFAULT_FONT_FAMILY
  const ov = t?.[OVERRIDE_KEY[el]] as TextOverride | undefined
  return {
    family: ov?.family || family,
    size: ov?.size && ov.size > 0 ? ov.size : Math.round(base * SCALE[el]),
    weight: el === 'title' ? ov?.weight ?? 'bold' : ov?.weight ?? 'normal',
  }
}

/** A CSS `font` shorthand for a resolved style (canvas 2D `ctx.font` / DOM). */
export function fontShorthand(s: ResolvedTextStyle): string {
  return `${s.weight === 'bold' ? '700 ' : ''}${s.size}px ${s.family}`
}

/** Resolve a chart-FRAME font (tick-label + axis-title sizes + a shared family) from a cell's
 *  typography, for `buildChartFrameLayers({ font })`. Family is left `undefined` when it's the built-in
 *  default so deck keeps its own atlas font (only a real override forces a family). */
export function chartFrameFont(t?: Typography): { family?: string; tickSize: number; titleSize: number } {
  const tick = resolveTextStyle(t, 'tick')
  const axis = resolveTextStyle(t, 'axis')
  return {
    family: tick.family === DEFAULT_FONT_FAMILY ? undefined : tick.family,
    tickSize: tick.size,
    titleSize: axis.size,
  }
}
