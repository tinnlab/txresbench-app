// rectEquality.ts — ITEM-4's pure half.
//
// `measure()` rebuilds ALL `PaneRect` objects from `getBoundingClientRect()` and hands them straight
// to `setRects`. Every object is fresh, so every call is a state change even when nothing moved, and
// every downstream consumer keyed on rect identity is invalidated.
//
// That was survivable while nothing memoized on it. After ITEM-1 it is not: `rect` is a prop of the
// now-`memo`'d `CellView`, so an unchanged-but-fresh rect set re-renders every pane's chrome — the
// exact cost ITEM-1 just removed, re-entering through the resize path. `PaneToolbar.measure()` also
// now WRITES state it READS (`configCollapsed` / `leftSqueeze`), so a resize already costs an extra
// render pass and does not need a second one on top.
//
// The guard mirrors `measureLegend`'s existing one in the same file, including its tolerance idea:
// sub-pixel jitter from fractional layout is not movement, and treating it as movement would make
// the guard a no-op on exactly the continuous-resize path it exists for.

import type { PaneRect } from '../layers/multiView'

/** Movement below this (in CSS px) is layout jitter, not a layout change. `measureLegend` uses the
 *  same 1px idea for the same reason. */
export const RECT_EPSILON_PX = 0.5

/** True when two rect SETS describe the same layout: same panes, same order, same geometry within
 *  `RECT_EPSILON_PX`. Order is significant on purpose — it mirrors `cells`, so a reorder is a real
 *  layout change even when every rect keeps its geometry. */
export function rectSetsEqual(
  a: readonly PaneRect[],
  b: readonly PaneRect[],
  eps = RECT_EPSILON_PX,
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]
    const q = b[i]
    if (p.id !== q.id) return false
    if (
      Math.abs(p.x - q.x) > eps ||
      Math.abs(p.y - q.y) > eps ||
      Math.abs(p.width - q.width) > eps ||
      Math.abs(p.height - q.height) > eps
    )
      return false
  }
  return true
}

/** The `setState` updater form of the guard: returns the PREVIOUS array (same identity, so React
 *  bails out of the update entirely) when nothing moved, and the next one otherwise.
 *
 *  Written as an updater rather than as an `if` around `setRects` deliberately — the previous value
 *  is read inside React's own update, so it cannot be stale the way a ref-mirrored copy compared
 *  outside the setter can be. */
export function keepRectsIfUnchanged(next: PaneRect[]): (prev: PaneRect[]) => PaneRect[] {
  return prev => (rectSetsEqual(prev, next) ? prev : next)
}
