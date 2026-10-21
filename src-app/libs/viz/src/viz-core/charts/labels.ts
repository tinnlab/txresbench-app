// labels.ts — publication label conventions for life-science figures: gene-symbol ITALICS + species
// casing (ITEM-16) and REDUNDANT ENCODING accessors (ITEM-21, pair categorical color with a shape/dash so
// a figure reads in grayscale / for CVD viewers, WCAG 1.4.1). Pure + node-safe; the chart Views consume
// these when a cell opts in (the "gene labels" / "redundant encoding" flags).

export type Species = 'human' | 'mouse'

/** Species casing convention (HGNC/MGI): human gene symbols are ALL-CAPS (CD3E), mouse Title-case (Cd3e). */
export function formatGeneCasing(symbol: string, species: Species): string {
  if (species === 'human') return symbol.toUpperCase()
  // mouse: first letter upper, rest lower (Title-case a single token).
  return symbol.charAt(0).toUpperCase() + symbol.slice(1).toLowerCase()
}

/** The font-style a gene label uses when the cell's "gene labels" flag is on (italic) or off (normal). */
export function geneFontStyle(geneLabelsEnabled: boolean): 'italic' | 'normal' {
  return geneLabelsEnabled ? 'italic' : 'normal'
}

/** A coarse heuristic for "looks like a gene symbol" (short, alphanumeric, no spaces) — used to decide
 *  whether to apply italics automatically when the flag is on. Not authoritative (the flag is the intent). */
export function isLikelyGeneSymbol(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]{0,14}$/.test(s) && /[A-Za-z]/.test(s) && !s.includes(' ')
}

// ── ITEM-21: redundant encoding — a deterministic shape + dash per category, so color isn't the only channel.
export type MarkerShape = 'circle' | 'triangle-up' | 'square' | 'diamond' | 'cross' | 'triangle-down' | 'star' | 'hexagon'
export const MARKER_SHAPES: readonly MarkerShape[] = [
  'circle', 'triangle-up', 'square', 'diamond', 'cross', 'triangle-down', 'star', 'hexagon',
]
/** The shape assigned to a category index (cycles). Pairs with the category color for redundant encoding. */
export function categoryShape(code: number): MarkerShape {
  return MARKER_SHAPES[((code % MARKER_SHAPES.length) + MARKER_SHAPES.length) % MARKER_SHAPES.length]
}

/** SVG/canvas dash pattern per category index (for line/edge marks). `[]` = solid. */
export const DASH_PATTERNS: readonly (readonly number[])[] = [[], [6, 3], [2, 2], [8, 3, 2, 3], [1, 3], [10, 4]]
export function categoryDash(code: number): readonly number[] {
  return DASH_PATTERNS[((code % DASH_PATTERNS.length) + DASH_PATTERNS.length) % DASH_PATTERNS.length]
}
