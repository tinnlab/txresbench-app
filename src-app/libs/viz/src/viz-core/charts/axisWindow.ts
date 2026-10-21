// axisWindow.ts — ONE pure, domain-agnostic per-axis dataZoom window model. An axis is
// navigated NOT by a free camera but by a contiguous `AxisWindow = {lo, hi}` in the axis'
// DOMAIN units; the PLOT decides what the window does (re-densify a KDE, re-frame + re-LOD a
// matrix, …). This module is the union of the window math formerly split across
// `valueWindow.ts` (1-axis value units) and `matrixWindow.ts` (per-axis index units): clamp,
// zoom-about-an-anchor, pan, and the DragRail fraction mapping (with `invert` for a top=max
// vertical axis). NO DOM, NO GL — it unit-tests in node. The React shell is `AxisDataZoom`;
// `valueWindow`/`matrixWindow` are thin shims that re-export these + keep their view-specific
// framing helpers (`windowToViewFit` / `windowToBounds` / the KDE filter), which are NOT
// window math and STAY there.

/** A contiguous sub-window over ONE axis, in that axis' domain units. Invariant: `lo ≤ hi`. */
export interface AxisWindow {
  readonly lo: number
  readonly hi: number
}

/** Default smallest window span, as a fraction of the full domain span. A per-axis `minSpan`
 *  overrides this (e.g. a matrix axis passes `1` = one index cell). */
export const MIN_SPAN_FRAC = 0.02

/** The default minimum span (domain units) for `[domainLo, domainHi]`. Degenerate-safe. */
export function minSpanFor(domainLo: number, domainHi: number): number {
  const full = Math.abs(domainHi - domainLo)
  return full > 0 ? full * MIN_SPAN_FRAC : 1e-9
}

/** The full domain as a window (the default, un-zoomed framing). Orders the pair. */
export function fullAxisWindow(domainLo: number, domainHi: number): AxisWindow {
  return { lo: Math.min(domainLo, domainHi), hi: Math.max(domainLo, domainHi) }
}

/** True when the window covers (or over-covers) the entire domain. */
export function isFullAxisWindow(win: AxisWindow, domainLo: number, domainHi: number): boolean {
  const lo = Math.min(domainLo, domainHi)
  const hi = Math.max(domainLo, domainHi)
  return win.lo <= lo && win.hi >= hi
}

/**
 * Normalize a pair of edges into an ordered, in-domain `[lo, hi]` window of at least `minSpan`.
 * Orders the pair, clamps into `[domainLo, domainHi]`, and — if thinner than `minSpan` — grows
 * it to `minSpan` while keeping it inside the domain (grow up, then borrow downward at the top
 * edge). This is what a slider (two draggable handles) emits: two raw edge values → a valid
 * window. Merges the former `clampValueWindow` (value units) and `normalizeRange` (index units).
 */
export function clampWindow(
  a: number,
  b: number,
  domainLo: number,
  domainHi: number,
  minSpan: number = minSpanFor(domainLo, domainHi),
): AxisWindow {
  const dLo = Math.min(domainLo, domainHi)
  const dHi = Math.max(domainLo, domainHi)
  const clamp = (v: number) => (v < dLo ? dLo : v > dHi ? dHi : v)
  let lo = clamp(Math.min(a, b))
  let hi = clamp(Math.max(a, b))
  const cap = Math.min(minSpan, dHi - dLo)
  if (hi - lo < cap) {
    hi = lo + cap
    if (hi > dHi) {
      hi = dHi
      lo = dHi - cap
    }
    if (lo < dLo) lo = dLo
  }
  return { lo, hi }
}

/**
 * Zoom the window toward an ANCHOR VALUE (domain units) by `factor` (<1 narrows / zooms in,
 * >1 widens / zooms out) — the "inside" wheel zoom. The anchor keeps its fractional position
 * inside the window: the new span is `span * factor` (clamped to `[minSpan, fullSpan]`),
 * positioned so the anchor stays put, then shifted back inside the domain. An out-of-window
 * anchor is clamped to the nearest edge (no fling). Merges `zoomValueWindow` + `zoomRange`.
 */
export function zoomWindow(
  win: AxisWindow,
  domainLo: number,
  domainHi: number,
  factor: number,
  anchorValue: number,
  minSpan: number = minSpanFor(domainLo, domainHi),
): AxisWindow {
  const dLo = Math.min(domainLo, domainHi)
  const dHi = Math.max(domainLo, domainHi)
  const fullSpan = dHi - dLo
  const span = win.hi - win.lo
  if (span <= 0 || fullSpan <= 0) return fullAxisWindow(dLo, dHi)
  const anchor = anchorValue < win.lo ? win.lo : anchorValue > win.hi ? win.hi : anchorValue
  const frac = (anchor - win.lo) / span
  let newSpan = span * factor
  const cap = Math.min(minSpan, fullSpan)
  if (newSpan < cap) newSpan = cap
  if (newSpan > fullSpan) newSpan = fullSpan
  let lo = anchor - frac * newSpan
  if (lo < dLo) lo = dLo
  if (lo + newSpan > dHi) lo = dHi - newSpan
  if (lo < dLo) lo = dLo
  return { lo, hi: lo + newSpan }
}

/**
 * Pan the window by `delta` domain units, clamped so it stays inside the domain (span
 * preserved). Used by a drag over the plot (grab-content / grab-axis; the sign is chosen by
 * the caller). Merges `panValueWindow` + `panRange`.
 */
export function panWindow(
  win: AxisWindow,
  domainLo: number,
  domainHi: number,
  delta: number,
): AxisWindow {
  const dLo = Math.min(domainLo, domainHi)
  const dHi = Math.max(domainLo, domainHi)
  const span = win.hi - win.lo
  let lo = win.lo + delta
  if (lo < dLo) lo = dLo
  if (lo + span > dHi) lo = dHi - span
  if (lo < dLo) lo = dLo
  return { lo, hi: lo + span }
}

/**
 * Map a window to the `[loFrac, hiFrac]` rail fractions (0..1) a `DragRail` renders. `invert`
 * reflects the axis so the window's LOW edge sits at the rail's HIGH end (a top=max vertical
 * axis: e.g. a matrix's row 0 drawn at the top). Always returns an ordered pair (`loFrac ≤
 * hiFrac`) as DragRail requires.
 */
export function windowToFraction(
  win: AxisWindow,
  domainLo: number,
  domainHi: number,
  invert = false,
): [number, number] {
  const dLo = Math.min(domainLo, domainHi)
  const dHi = Math.max(domainLo, domainHi)
  const span = dHi - dLo || 1
  const f = (v: number) => (invert ? (dHi - v) / span : (v - dLo) / span)
  const a = f(win.lo)
  const b = f(win.hi)
  return a <= b ? [a, b] : [b, a]
}

/**
 * Inverse of `windowToFraction`: two rail fractions (0..1) → a valid `AxisWindow`. `snap`
 * (optional) rounds each raw edge value BEFORE clamping (a categorical / index axis snaps to
 * whole cells; a continuous axis passes none). `invert` matches `windowToFraction`.
 */
export function fractionToWindow(
  loFrac: number,
  hiFrac: number,
  domainLo: number,
  domainHi: number,
  invert = false,
  minSpan?: number,
  snap?: (v: number) => number,
): AxisWindow {
  const dLo = Math.min(domainLo, domainHi)
  const dHi = Math.max(domainLo, domainHi)
  const span = dHi - dLo
  const g = (frac: number) => (invert ? dHi - frac * span : dLo + frac * span)
  let a = g(loFrac)
  let b = g(hiFrac)
  if (snap) {
    a = snap(a)
    b = snap(b)
  }
  return clampWindow(a, b, dLo, dHi, minSpan ?? minSpanFor(dLo, dHi))
}
