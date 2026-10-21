// clip.ts — clip a chart's DATA marks to the plot rectangle (#3: on zoom, marks drew OUTSIDE the
// axes / over the titles + margins). Uses deck.gl's `ClipExtension` — `clipBounds` is in COMMON
// space, which equals DATA space for the chart2d cartesian `OrthographicView`. Applied to MARK layers
// ONLY: the axis FRAME (tick labels/titles) legitimately sits outside the plot rect (y-labels left of
// xMin, x-title below yMin), so clipping it would drop labels — the caller keeps frame layers separate
// and passes only the marks here.
import { ClipExtension } from '@deck.gl/extensions'
import type { Layer } from '@deck.gl/core'

// One shared extension instance (stateless) — deck keys on the extension identity.
const CLIP_EXT = new ClipExtension()

/**
 * Clip each mark layer to `bounds` = `[xMin, yMin, xMax, yMax]` (the plot's data-bounds / active
 * value/index window). When the chart is value-zoomed, `bounds` is the window, so marks beyond it are
 * clipped at the axis edge. Polygons (bars/boxes) clip by geometry (a partial bar is cut at the
 * boundary); points/text (dots) clip by anchor. Existing `extensions` on a layer are preserved.
 */
export function clipToBounds(
  marks: Layer[],
  bounds: readonly [number, number, number, number],
): Layer[] {
  const clipBounds: [number, number, number, number] = [bounds[0], bounds[1], bounds[2], bounds[3]]
  return marks.map(l => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const props = (l as any).props ?? {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (l as any).clone({
      extensions: [...(props.extensions ?? []), CLIP_EXT],
      clipBounds,
      updateTriggers: {
        ...(props.updateTriggers ?? {}),
        // re-clip when the window changes (bounds identity changes with the value/index window).
        clip: clipBounds,
      },
    })
  })
}
