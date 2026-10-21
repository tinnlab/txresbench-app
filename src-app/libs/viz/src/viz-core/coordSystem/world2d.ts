// coordSystem/world2d.ts — the `world2d` coordinate system (EXTENSIBILITY_STUDY §3.2 /
// §5.3, Part 6 STEP 5): the shared single-`<DeckGL>`/N-`OrthographicView` deck with a free
// orthographic camera. Scatter + image cells compose into it. It is the deck analog of
// ECharts' `grid` component providing N cartesian regions (§1.4): the grid builds ONE
// `world2d` region per dense cell on the shared deck, each identified by its `spaceKey`
// (the `cellSpaceKey` link-zoom scope). See `grid/multiView.ts`.
//
// STEP 5 is behavior-preserving: `create` returns the minimal region handle the later
// `option` pipeline consumes; the real free-ortho projection stays inside the shared deck's
// `OrthographicView` (unchanged).

import type { CoordSystemDef } from '../registry/coordSystem'
import { sharedDeckHost } from './RenderHost'

/** `world2d` — shared-deck, free orthographic camera (scatter / image). */
export const world2d: CoordSystemDef = {
  id: 'world2d',
  host: sharedDeckHost,
  dimensions: ['x', 'y'],
  camera: 'free-ortho',
  create(region) {
    return {
      type: 'world2d',
      regionId: region.regionId,
      spaceKey: region.spaceKey,
      dimensions: ['x', 'y'],
      hostId: sharedDeckHost.id,
    }
  },
}
