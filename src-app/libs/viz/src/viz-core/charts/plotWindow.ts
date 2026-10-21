// plotWindow.ts — the pure, domain-agnostic window helpers Wave-2 plots add on top of the
// generic `./axisWindow` model. Two families, both DOM/GL-free (they unit-test in node):
//
//   • VALUE-AXIS REFRAME (box / bar): a cartesian plot whose category (x) axis is fixed and
//     whose value (y) axis is navigated by a contiguous `AxisWindow`. `boundsWithValueWindow`
//     turns an x-extent + the y window into the `[xLo, yLo, xHi, yHi]` bounds a `ChartCanvas`
//     (`controller={false}`) frames — the box/bar analog of the violin's re-frame (NO KDE:
//     box/bar just re-frame the y-bounds, they don't re-densify).
//
//   • SCATTER CAMERA ↔ WINDOW (deck OrthographicView, SCALAR aspect-preserving zoom): the
//     bidirectional map between one axis' visible world window and the camera's (center, zoom).
//     deck's OrthographicView maps `2^zoom` device-px per world unit, so the visible half-extent
//     on an axis is `(viewportPx / 2) / 2^zoom`. `axisVisibleWindow` derives the slider window
//     FROM the live camera; `axisViewFromWindow` computes the (center, zoom) that FRAMES a
//     dragged window. They round-trip per axis. Because the scatter keeps a SINGLE scalar zoom
//     (aspect-preserving — it's a real spatial plot, not two independent stretch axes), framing
//     one axis' window also rescales the other; the two sliders are coupled through that shared
//     zoom, which is the correct, honest behaviour for a spatial scatter (a genuine camera zoom,
//     not an axis stretch). This is the documented limitation of the scatter binding.

import type { AxisWindow } from './axisWindow'

/**
 * The `[xLo, yLo, xHi, yHi]` chart bounds for a category-vs-value plot whose x extent is fixed
 * (`[xLo, xHi]`) and whose value (y) axis is framed to `win`. Orders the y edges defensively.
 */
export function boundsWithValueWindow(
  xLo: number,
  xHi: number,
  win: AxisWindow,
): [number, number, number, number] {
  const yLo = Math.min(win.lo, win.hi)
  const yHi = Math.max(win.lo, win.hi)
  return [xLo, yLo, xHi, yHi]
}

/**
 * The world window currently visible on ONE axis of a deck OrthographicView: centered on the
 * camera `center` for that axis, with half-extent `(viewportPx / 2) / 2^zoom` (deck maps `2^zoom`
 * device-px per world unit). `zoom` is the SCALAR log₂ zoom (aspect-preserving). A degenerate
 * viewport (`≤ 0`) collapses to a zero-width window at the center.
 */
export function axisVisibleWindow(center: number, zoom: number, viewportPx: number): AxisWindow {
  const z = Number.isFinite(zoom) ? zoom : 0
  const px = Math.max(0, viewportPx)
  const half = px / 2 / 2 ** z
  return { lo: center - half, hi: center + half }
}

/** The (center, scalar zoom) that FRAMES `win` on one axis of a `viewportPx`-wide/high view: the
 *  inverse of `axisVisibleWindow`. `center` is the window midpoint; `zoom = log₂(viewportPx /
 *  span)`. A degenerate span/viewport yields a finite fallback (zoom 0) so the camera never NaNs. */
export function axisViewFromWindow(
  win: AxisWindow,
  viewportPx: number,
): { center: number; zoom: number } {
  const lo = Math.min(win.lo, win.hi)
  const hi = Math.max(win.lo, win.hi)
  const center = (lo + hi) / 2
  const span = hi - lo
  const px = Math.max(0, viewportPx)
  if (!(span > 0) || !(px > 0)) return { center, zoom: 0 }
  return { center, zoom: Math.log2(px / span) }
}
