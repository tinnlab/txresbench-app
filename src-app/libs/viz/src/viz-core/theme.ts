// theme.ts — the framework-agnostic viz CHROME theme (DEC-39). viz-core NEVER reads the
// app theme; every DOM control widget + chart chrome takes fg/line/grid/surface colors
// from a `VizTheme` prop (the txresbench adapter passes the app theme; the showcase passes a
// toggle). DATA marks (colormaps, categorical palette, heatmap texture) are unchanged by
// this — they read on both themes on their own. No @txresbench/* imports.

/** The theme-aware CHROME colors a viz control/frame draws with (never the data ramp). */
export interface VizTheme {
  /** Primary foreground: labels, tick text, handle strokes. */
  readonly fg: string
  /** De-emphasized foreground: min/max labels, secondary captions. */
  readonly muted: string
  /** Gridlines / axis rules / faint separators. */
  readonly grid: string
  /** Widget/panel surface (legend row hover, sidebar, stage background). */
  readonly surface: string
  /** Border around a strip/rail/panel. */
  readonly border: string
}

/** Dark text on a light surface — the default. */
export const LIGHT_THEME: VizTheme = {
  fg: '#1a1a1a',
  muted: 'rgba(0,0,0,0.55)',
  grid: 'rgba(0,0,0,0.15)',
  surface: '#ffffff',
  border: 'rgba(0,0,0,0.2)',
}

/** Light text on a dark surface. */
export const DARK_THEME: VizTheme = {
  fg: '#e8ecf4',
  muted: 'rgba(232,236,244,0.6)',
  grid: 'rgba(232,236,244,0.18)',
  surface: '#0b1220',
  border: 'rgba(232,236,244,0.28)',
}

/** Resolve the active `VizTheme` from the published `document.documentElement.dataset.vizTheme`
 *  (`'dark'` ⇒ dark, else light) — the SAME signal `defaultChartTheme()` uses, so the DOM-canvas
 *  control chrome (legend / visual-map / data-zoom labels) reads on light AND dark. SSR-safe. */
export function defaultVizTheme(): VizTheme {
  if (typeof document !== 'undefined' && document.documentElement.dataset.vizTheme === 'dark') {
    return DARK_THEME
  }
  return LIGHT_THEME
}
