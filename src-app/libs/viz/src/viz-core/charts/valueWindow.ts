// valueWindow.ts — the VALUE-AXIS (violin y) view of the dataZoom window model (the legacy
// CytoAnalyst `dataZoom: {type:'inside', yAxisIndex:[0]}`). A violin is navigated NOT by a
// free 2-D camera but by a contiguous VALUE window `[lo, hi]`: the category (group / x) axis
// is FIXED, and zooming the value window RE-FILTERS + RE-DENSIFIES each group's KDE to the
// visible band. The window MATH (clamp/zoom/pan) now lives in the generic `./axisWindow`; this
// module is a THIN shim that re-exports it under the value-axis names + keeps the value-SPECIFIC
// helpers (`valuesInWindow` / `filterCellsToWindow` — the KDE re-densify filter), which are NOT
// window math and STAY here. DOM/GL-free → unit-tests in node. The React shell is
// `ValueAxisZoom`; the recompute consumer is `ViolinView`.

import { clampWindow, minSpanFor, panWindow, zoomWindow, type AxisWindow } from './axisWindow'

export { MIN_SPAN_FRAC, minSpanFor } from './axisWindow'

/** A contiguous sub-window over the value axis, in value units. Invariant: `lo ≤ hi`. */
export type ValueWindow = AxisWindow

/** The full domain as a window (the default, un-zoomed framing). Orders the pair. */
export function fullValueWindow(domainLo: number, domainHi: number): ValueWindow {
  return { lo: Math.min(domainLo, domainHi), hi: Math.max(domainLo, domainHi) }
}

/** True when the window covers (or over-covers) the entire value domain. */
export function isFullValueWindow(win: ValueWindow, domainLo: number, domainHi: number): boolean {
  const lo = Math.min(domainLo, domainHi)
  const hi = Math.max(domainLo, domainHi)
  return win.lo <= lo && win.hi >= hi
}

/** Slider edges → a valid value window (order + clamp + min-span). See `axisWindow.clampWindow`. */
export function clampValueWindow(
  a: number,
  b: number,
  domainLo: number,
  domainHi: number,
  minSpan: number = minSpanFor(domainLo, domainHi),
): ValueWindow {
  return clampWindow(a, b, domainLo, domainHi, minSpan)
}

/** Wheel-zoom the value window toward a cursor value. See `axisWindow.zoomWindow`. */
export function zoomValueWindow(
  win: ValueWindow,
  domainLo: number,
  domainHi: number,
  factor: number,
  cursorValue: number,
  minSpan: number = minSpanFor(domainLo, domainHi),
): ValueWindow {
  return zoomWindow(win, domainLo, domainHi, factor, cursorValue, minSpan)
}

/** Pan the value window by `delta` value units (grab-the-axis). See `axisWindow.panWindow`. */
export function panValueWindow(
  win: ValueWindow,
  domainLo: number,
  domainHi: number,
  delta: number,
): ValueWindow {
  return panWindow(win, domainLo, domainHi, delta)
}

/**
 * PURE filter — the finite values that fall inside the INCLUSIVE window `[lo, hi]`. This is
 * the defining legacy step: the KDE re-densify recomputes over ONLY the in-window values, so
 * zooming the value axis reveals finer structure in the focused band (not mere magnification).
 * Order-insensitive (caller may pass a drag's start/end in either order).
 */
export function valuesInWindow(values: ArrayLike<number>, lo: number, hi: number): Float32Array {
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  const out: number[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (Number.isFinite(v) && v >= a && v <= b) out.push(v)
  }
  return Float32Array.from(out)
}

/**
 * Filter a flat (value, code) cell set to the value window AND deterministically SUBSAMPLE
 * each group to `capPerGroup` — the input the windowed KDE recompute feeds to
 * `violinByGroupGpu`. Mirrors the legacy 50k-per-group subsample cap (the legacy used a
 * seeded `_.sampleSize`; we use an even, deterministic stride so there is NO PRNG dependency
 * and the same window always yields the same sample). Returns flat arrays in group order
 * (`codes[k]` is the group of `values[k]`). Cells with an out-of-range code or a non-finite
 * value are dropped (mirrors `buildJitterPositions` / `buildGroupIndex`).
 */
export function filterCellsToWindow(
  values: ArrayLike<number>,
  codes: ArrayLike<number>,
  lo: number,
  hi: number,
  nGroups: number,
  capPerGroup: number,
): { values: Float32Array; codes: Uint16Array } {
  const a = Math.min(lo, hi)
  const b = Math.max(lo, hi)
  const buckets: number[][] = Array.from({ length: nGroups }, () => [])
  const n = codes.length
  for (let i = 0; i < n; i++) {
    const c = codes[i]
    if (c < 0 || c >= nGroups) continue
    const v = values[i]
    if (!Number.isFinite(v) || v < a || v > b) continue
    buckets[c].push(i)
  }
  let total = 0
  for (const bucket of buckets) total += Math.min(bucket.length, capPerGroup)
  const outV = new Float32Array(total)
  const outC = new Uint16Array(total)
  let w = 0
  for (let g = 0; g < nGroups; g++) {
    const bucket = buckets[g]
    if (bucket.length <= capPerGroup) {
      for (let k = 0; k < bucket.length; k++) {
        outV[w] = values[bucket[k]]
        outC[w] = g
        w++
      }
    } else {
      // Even, deterministic stride over the in-window members (no PRNG).
      for (let k = 0; k < capPerGroup; k++) {
        const idx = bucket[Math.floor((k * bucket.length) / capPerGroup)]
        outV[w] = values[idx]
        outC[w] = g
        w++
      }
    }
  }
  return { values: outV, codes: outC }
}
