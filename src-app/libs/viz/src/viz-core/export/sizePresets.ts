// sizePresets.ts — publication FINAL-SIZE + DPI framing for export (ITEM-3 / ITEM-4). Journals require a
// figure designed at its printed COLUMN WIDTH (in mm) and rendered at a fixed DPI, so a font declared "7pt"
// is actually 7pt on the page. This module converts between mm / px / DPI and folds a (size, dpi) choice
// into the ONE `scale` factor the existing raster path (raster.ts) already consumes — additive: with no
// preset chosen the caller passes `scale` directly and output is byte-identical to today.

/** Millimetres per inch (the print unit bridge). */
export const MM_PER_INCH = 25.4

/** Journal COLUMN-WIDTH presets (mm) — the superset of the common single / 1.5 / double column widths
 *  across Nature, Science, Cell, PLOS, Elsevier. Values are representative mid-points of each venue's range. */
export const COLUMN_PRESETS = {
  single: 88, // ~85–90 mm (1 column)
  oneAndHalf: 120, // ~114–140 mm (1.5 columns)
  double: 180, // ~174–190 mm (2 columns / full width)
} as const
export type ColumnPreset = keyof typeof COLUMN_PRESETS

/** The strictest max figure HEIGHT (mm) — Nature's 170 mm cap. A taller figure is clamped/flagged. */
export const MAX_HEIGHT_MM = 170

/** DPI targets by figure kind (final-size resolution). Line-art is strictest; a figure with a raster layer
 *  (our hybrid dense scatter/heatmap) is "combination" = 600; a pure photo/halftone is 300. */
export const DPI_TARGETS = { lineArt: 1200, combination: 600, halftone: 300 } as const
export type DpiTarget = keyof typeof DPI_TARGETS
/** DEC-3: the dialog default is 600 (combination) — the safe superset for our hybrid figures. */
export const DEFAULT_DPI: number = DPI_TARGETS.combination

/** mm → device pixels at a DPI. */
export function mmToPx(mm: number, dpi: number): number {
  return (mm / MM_PER_INCH) * dpi
}

/** device pixels → mm at a DPI. */
export function pxToMm(px: number, dpi: number): number {
  return (px / dpi) * MM_PER_INCH
}

/** Clamp a height in mm to the journal max, returning the clamped value + whether it was over. */
export function clampHeightMm(hMm: number, maxMm: number = MAX_HEIGHT_MM): { mm: number; clamped: boolean } {
  return hMm > maxMm ? { mm: maxMm, clamped: true } : { mm: hMm, clamped: false }
}

/** Resolve the raster SCALE factor that makes a `sourceWidthPx`-wide canvas print at `targetWidthMm` and
 *  `dpi`. This is what ties a (column-preset, dpi) choice into raster.ts's existing `scale` knob:
 *  scale = targetPx / sourcePx. `dpi` defaults to 600; an explicit `scale` (manual override) bypasses this. */
export function scaleForFinalSize(sourceWidthPx: number, targetWidthMm: number, dpi: number = DEFAULT_DPI): number {
  if (sourceWidthPx <= 0) return 1
  const targetPx = mmToPx(targetWidthMm, dpi)
  return targetPx / sourceWidthPx
}

/** Full resolution of an export size intent → the numbers the raster/vector paths need. `column` picks a
 *  preset width (or pass `widthMm` directly); `scale` (if given) is the manual override and wins. */
export function resolveExportSize(opts: {
  sourceWidthPx: number
  sourceHeightPx: number
  column?: ColumnPreset
  widthMm?: number
  dpi?: number
  scale?: number
}): { scale: number; widthMm: number; heightMm: number; dpi: number; heightClamped: boolean } {
  const dpi = opts.dpi ?? DEFAULT_DPI
  const widthMm = opts.widthMm ?? (opts.column ? COLUMN_PRESETS[opts.column] : pxToMm(opts.sourceWidthPx, dpi))
  const scale = opts.scale ?? scaleForFinalSize(opts.sourceWidthPx, widthMm, dpi)
  const aspect = opts.sourceHeightPx / Math.max(1, opts.sourceWidthPx)
  const rawHeightMm = widthMm * aspect
  const { mm: heightMm, clamped } = clampHeightMm(rawHeightMm)
  return { scale, widthMm, heightMm, dpi, heightClamped: clamped }
}
