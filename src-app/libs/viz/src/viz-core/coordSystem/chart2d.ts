// coordSystem/chart2d.ts — the `chart2d` coordinate system (EXTENSIBILITY_STUDY §3.2,
// Part 6 STEP 5): an own-`ChartCanvas` host with an independent-axis AUTO-FIT orthographic
// camera. Violin / box / bar / histogram / volcano (and the nested `grid` container)
// compose into it. Each such cell owns its OWN `<DeckGL>` (WebGL-context budget, Part 7
// gap #1), so `host` is `ownCanvasHost` (not shared).
//
// STEP 5 is behavior-preserving: `create` returns the minimal region handle; the auto-fit
// framing stays inside `ChartCanvas` (unchanged).

import type { CoordSystemDef } from '../registry/coordSystem'
import { ownCanvasHost } from './RenderHost'

/** `chart2d` — own `ChartCanvas`, independent-axis auto-fit (violin / box / bar / …). */
export const chart2d: CoordSystemDef = {
  id: 'chart2d',
  host: ownCanvasHost,
  dimensions: ['x', 'y'],
  camera: 'auto-fit',
  create(region) {
    return {
      type: 'chart2d',
      regionId: region.regionId,
      spaceKey: region.spaceKey,
      dimensions: ['x', 'y'],
      hostId: ownCanvasHost.id,
    }
  },
}
