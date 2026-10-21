// coordSystem/RenderHost.ts — the two deck render HOSTS we already ship, captured as
// registered `RenderHost` entities (EXTENSIBILITY_STUDY §3.1 point 4, §5.1, Part 6 STEP 5).
//
// The visualization runs TWO host regimes (Part 7 gap #1): a *shared* single-`<DeckGL>`
// deck for `world2d` cells (one WebGL context, `layerFilter` routes each cell's
// `<cellId>::` layers to its own `OrthographicView`) and *per-cell* `<DeckGL>` for the
// chart / matrix cells (a `ChartCanvas` each — the WebGL-context budget forbids one shared
// context). STEP 5 names these two regimes as `RenderHost` singletons the coordinate
// systems reference; it does NOT reroute rendering (the `GridWorkspace` deck IS the
// `sharedDeckHost`; each `ChartCanvas` IS an `ownCanvasHost` instance).
//
// Pure data — no React, no deck — so the coord-system defs + `grid/multiView.ts` resolve
// a cell's host without pulling in the View layer.

import type { RenderHost } from '../registry/coordSystem'

/**
 * The SHARED single-`<DeckGL>` / N-`OrthographicView` deck (`GridWorkspace` + the
 * `layers/multiView` view/layerFilter builders). ONE WebGL context serves every `world2d`
 * region; regions are routed by their `<cellId>::` layer prefix and clipped to their own
 * viewport. `shared: true` — this is the single source of truth for the "dense" partition.
 */
export const sharedDeckHost: RenderHost = {
  id: 'shared-deck',
  shared: true,
  label: 'Shared single-<DeckGL> / N-OrthographicView deck',
}

/**
 * The PER-CELL `ChartCanvas` host (`charts/ChartCanvas.tsx`): one `<DeckGL>` per region,
 * with its own WebGL context. Used by `chart2d` (auto-fit ortho) and `matrix2d`
 * (`controller:false` window framing). `shared: false` — each region gets its own host.
 */
export const ownCanvasHost: RenderHost = {
  id: 'own-canvas',
  shared: false,
  label: 'Per-cell ChartCanvas (<DeckGL> per region)',
}
