// coordSystem/matrix2d.ts — the `matrix2d` coordinate system (EXTENSIBILITY_STUDY §3.2,
// Part 6 STEP 5): an own-`ChartCanvas` host with `controller:false` texel-window framing.
// Heatmap / dotplot compose into it. A free camera zoom is meaningless on a texel matrix
// (DEC-38), so navigation is a RANGE window driven by `bounds` only (the `MatrixDataZoom`).
// Like `chart2d` it owns its OWN `<DeckGL>` (`ownCanvasHost`, not shared).
//
// STEP 5 is behavior-preserving: `create` returns the minimal region handle; the window
// framing stays inside `ChartCanvas` (`controller:false`, unchanged).

import type { CoordSystemDef } from '../registry/coordSystem'
import { ownCanvasHost } from './RenderHost'

/** `matrix2d` — own `ChartCanvas`, `controller:false` texel-window framing (heatmap / dotplot). */
export const matrix2d: CoordSystemDef = {
  id: 'matrix2d',
  host: ownCanvasHost,
  dimensions: ['x', 'y'],
  camera: 'window',
  create(region) {
    return {
      type: 'matrix2d',
      regionId: region.regionId,
      spaceKey: region.spaceKey,
      dimensions: ['x', 'y'],
      hostId: ownCanvasHost.id,
    }
  },
}
