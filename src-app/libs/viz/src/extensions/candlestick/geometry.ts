// geometry.ts — the PURE candlestick geometry (no React, no deck, no store), so it
// unit-tests in the node vitest pass exactly like `chartLayers.ts` / `axisTicks.ts`.
// A candlestick bar draws two GPU marks: a HIGH→LOW wick (a `LineLayer` segment) and an
// OPEN↔CLOSE body (a `SolidPolygonLayer` rect ring), colored UP (close ≥ open) vs DOWN.
// These builders return plain data (rings / segments / colors / domains); the View spreads
// them into the real deck layer constructors. NO SVG anywhere (the engine's binding constraint).

/** A closed polygon ring as [x,y] vertices (SolidPolygonLayer input). */
export type Ring = [number, number][]
/** An RGBA byte tuple (deck color). */
export type RGBA = [number, number, number, number]

/** UP candle (close ≥ open): a calm green. */
export const CANDLE_UP: RGBA = [22, 163, 74, 255]
/** DOWN candle (close < open): a red. */
export const CANDLE_DOWN: RGBA = [220, 38, 38, 255]

/** Half-width (data units) of a candle BODY around its bar center (bars are spaced 1 apart). */
export const HALF_BODY = 0.32

/** One resolved OHLC bar in chart space: `x` is its axis position, `i` its ordinal index. */
export interface OhlcBar {
  readonly i: number
  readonly x: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}

/** A single wick line segment (`LineLayer` source/target). */
export interface WickSegment {
  readonly source: [number, number]
  readonly target: [number, number]
}

/** UP iff the close finished at or above the open (the doji `open === close` counts as up). */
export function isUp(open: number, close: number): boolean {
  return close >= open
}

/** The direction color for a bar: green up, red down. */
export function candleColor(open: number, close: number): RGBA {
  return isUp(open, close) ? CANDLE_UP : CANDLE_DOWN
}

/**
 * The BODY rect ring for a bar centered at `x`: a rectangle spanning `[x-hw, x+hw]` in x and
 * `[min(open,close), max(open,close)]` in y (CCW from bottom-left). A doji (open === close)
 * yields a zero-height ring (a flat line at that price) — the wick still shows the range.
 */
export function bodyRing(x: number, open: number, close: number, halfWidth = HALF_BODY): Ring {
  const y0 = Math.min(open, close)
  const y1 = Math.max(open, close)
  return [
    [x - halfWidth, y0],
    [x + halfWidth, y0],
    [x + halfWidth, y1],
    [x - halfWidth, y1],
  ]
}

/** The HIGH→LOW wick segment for a bar centered at `x` (drawn low→high). */
export function wickSegment(x: number, low: number, high: number): WickSegment {
  return { source: [x, low], target: [x, high] }
}

/**
 * The value (price) domain `[lo, hi]` a candlestick's y-axis + `ValueDataZoom` span: the min
 * of every LOW and the max of every HIGH, with a little padding. `null` for an empty set.
 */
export function ohlcValueDomain(bars: readonly OhlcBar[]): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const b of bars) {
    if (b.low < lo) lo = b.low
    if (b.high > hi) hi = b.high
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.04
  return [lo - pad, hi + pad]
}

/**
 * Zip four (or five) index-aligned OHLC value columns into `OhlcBar[]`. `index` supplies each
 * bar's axis position (`x`); when absent the ordinal `i` is used. The bar count is the MIN of
 * the supplied column lengths (defensive against a short column). Pure.
 */
export function barsFromColumns(
  index: ArrayLike<number> | null,
  open: ArrayLike<number>,
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
): OhlcBar[] {
  const n = Math.min(open.length, high.length, low.length, close.length)
  const out: OhlcBar[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      i,
      x: index && i < index.length ? index[i] : i,
      open: open[i],
      high: high[i],
      low: low[i],
      close: close[i],
    })
  }
  return out
}

/**
 * The bar indices whose center `x` falls inside the inclusive axis window `[a, b]` (order-
 * insensitive) — the PRODUCE hit-test for a brushed bar-range → a selection. Returns a
 * `Uint32Array` of the covered bar ORDINALS (`bar.i`), which the View publishes as the
 * canonical point-selection through the coordination handle. Pure.
 */
export function barsInXRange(bars: readonly OhlcBar[], a: number, b: number): Uint32Array {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  const hits: number[] = []
  for (const bar of bars) {
    if (bar.x >= lo && bar.x <= hi) hits.push(bar.i)
  }
  return Uint32Array.from(hits)
}
