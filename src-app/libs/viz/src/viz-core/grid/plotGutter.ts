// plotGutter.ts — ITEM-1's pure half.
//
// A cell's legend gutter is conceptually one value, `{ w, side }`, and that is exactly why it was
// the single referentially-unstable prop `GridWorkspace` handed `CellView`: `legendGutterFor(cell)`
// builds a FRESH object literal on every call, so `plotGutter={legendGutterFor(cell) ?? undefined}`
// changed identity on every render and `memo(CellView)` would have been 100% inert — a shallow
// comparator finds a difference every time.
//
// DEC-7's answer is to FLATTEN it to two primitives at the boundary rather than to memoize the
// object. Memoizing would need a per-cell cache keyed by cell id AND by the measured legend width,
// i.e. new state whose invalidation is a new place to get it wrong; two primitives compare by value
// for free and can never go stale. The object is reassembled where it is consumed, which costs one
// allocation in a place that is not on the camera path.
//
// `left`/`right` here are PHYSICAL because they map onto `paddingLeft`/`paddingRight` of the plot
// body, mirroring the existing `resolveLegendCorner(...).hSide` vocabulary this feeds from.

export type GutterSide = 'left' | 'right'

export interface PlotGutter {
  readonly w: number
  readonly side: GutterSide
}

/** The flattened form handed across the memo boundary: two primitives, or `undefined` for "no
 *  gutter". Both are `undefined` together — a width with no side (or vice versa) is not a state the
 *  producer can express, and `gutterFromParts` treats it as absent. */
export interface PlotGutterParts {
  readonly plotGutterW?: number
  readonly plotGutterSide?: GutterSide
}

/** Flatten a gutter (or its absence) into the two primitives crossing the prop boundary. */
export function gutterToParts(g: PlotGutter | null | undefined): PlotGutterParts {
  return g ? { plotGutterW: g.w, plotGutterSide: g.side } : {}
}

/** Reassemble the gutter on the consuming side. Returns `undefined` unless BOTH parts are present
 *  and the width is a usable positive number — a zero-width gutter is indistinguishable from no
 *  gutter in every consumer, so it is normalized to absent rather than producing an object that
 *  pads by nothing. */
export function gutterFromParts(parts: PlotGutterParts): PlotGutter | undefined {
  const { plotGutterW: w, plotGutterSide: side } = parts
  if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || !side) return undefined
  return { w, side }
}

/** The padding declaration a gutter produces, so the physical-side mapping lives in ONE place
 *  instead of being re-derived at each consumer. */
export function gutterPadding(g: PlotGutter | undefined): Record<string, number> {
  if (!g) return {}
  return { [g.side === 'left' ? 'paddingLeft' : 'paddingRight']: g.w }
}
