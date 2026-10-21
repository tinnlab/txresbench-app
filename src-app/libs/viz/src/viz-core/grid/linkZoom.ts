// linkZoom.ts — pure logic for the grid's "Link zoom" behavior (DEC-37).
//
// The multi-cell grid zooms/pans each cell INDEPENDENTLY by default; an opt-in
// "Link zoom" toggle joins cells into a shared `viewState` coordination scope so
// wheeling one cell moves the linked ones in lockstep (Vitessce coordination
// pattern). Crucially, link-zoom is SCOPED BY COORDINATE SPACE (the
// embedding-blind-zoom fix): a shared `{target, zoom}` is only meaningful for cells
// in the SAME 2-D coordinate space. Two scatters over the same embedding sync; a
// scatter (embedding coords) and an image/spatial cell (pixel/physical coords) are
// DIFFERENT spaces and must NEVER sync. Each cell declares its space via a
// `spaceKey` (see `cellSpaceKey`); this module fans a move only WITHIN a space.
//
// This module holds the small, deck.gl-free brain of that behavior so it is
// unit-testable in node:
//   - `clampZoom` / `clampViewState` — the min/max zoom clamps (can't lose the
//     data off-screen) applied on every view-state change, in either mode.
//   - `applyViewStateChange` — given a changed cell's new view state, computes the
//     next per-cell view-state map: when linked, fan it out ONLY to cells in the
//     SAME space (other spaces untouched); when unlinked, update ONLY the changed cell.
//   - `buildControlledViewStates` — the controlled `{cellId: viewState}` deck reads:
//     each cell gets ITS SPACE's shared state when linked, else its own local state.
//
// Generic naming (DEC-28): a "cell" is a grid slot's view; a "space" is a coordinate
// space id; nothing bio here.

import type { ViewZoom } from '../layers/multiView'

/** A deck.gl orthographic view state (`target:[x,y,0]`, `zoom`) for a DENSE (world2d) cell — scalar
 *  zoom (equal-aspect free camera + link-zoom). Chart cells carry their own per-axis viewState
 *  (`CellViewState.zoom: ViewZoom`) via the chart-layer sink, not this dense link-zoom state. */
export interface GridViewState {
  target: [number, number, number]
  zoom: number
}

/** Sensible default zoom clamps so panning/zooming can never lose the data. */
export const MIN_ZOOM = -2
export const MAX_ZOOM = 12

/** The base Coordination-store scope PREFIX for the grid's linked view state. The
 *  actual scope is sharded per coordinate space (`grid:<spaceKey>`) — see the store's
 *  `gridScopeId`. Kept as a constant so the pure module + the store agree on the base. */
export const SHARED_GRID_SCOPE = 'grid'

/** Clamp a raw zoom into `[min, max]` — per-axis when it's a `[zx,zy]` (chart) zoom. Type-preserving
 *  (a scalar in → scalar out, an array in → array out) so it slots into either view-state shape. */
export function clampZoom(zoom: number, min?: number, max?: number): number
export function clampZoom(zoom: [number, number], min?: number, max?: number): [number, number]
export function clampZoom(zoom: ViewZoom, min?: number, max?: number): ViewZoom
export function clampZoom(zoom: ViewZoom, min: number = MIN_ZOOM, max: number = MAX_ZOOM): ViewZoom {
  const one = (z: number) => (Number.isNaN(z) ? min : Math.min(max, Math.max(min, z)))
  return Array.isArray(zoom) ? [one(zoom[0]), one(zoom[1])] : one(zoom)
}

/** Return a copy of `vs` with its zoom clamped into `[min, max]` (per-axis for array zoom). */
export function clampViewState<T extends { zoom: ViewZoom }>(
  vs: T,
  min: number = MIN_ZOOM,
  max: number = MAX_ZOOM,
): T {
  return { ...vs, zoom: clampZoom(vs.zoom, min, max) as T['zoom'] }
}

/**
 * Compute the next per-cell view-state map after one cell's view changed — SCOPED BY
 * COORDINATE SPACE (the embedding-blind-zoom fix).
 *
 * `cellSpaces` maps each cell id → its coordinate-space key (`cellSpaceKey`). The
 * changed view state is always zoom-clamped first. Then:
 *  - **linked** — the clamped state is fanned out ONLY to cells that share the changed
 *    cell's space; cells in OTHER spaces keep their existing state untouched. So two
 *    scatters over the same embedding move together, while an image/spatial cell in a
 *    different space does not.
 *  - **unlinked** — only `changedId` is updated; the other cells keep their own
 *    independent state (space is irrelevant here).
 *
 * Pure: returns a new object, never mutates `states`.
 */
export function applyViewStateChange(
  states: Record<string, GridViewState>,
  changedId: string,
  changed: GridViewState,
  cellSpaces: Record<string, string>,
  linked: boolean,
  min: number = MIN_ZOOM,
  max: number = MAX_ZOOM,
): Record<string, GridViewState> {
  const clamped = clampViewState(changed, min, max)
  if (linked) {
    const space = cellSpaces[changedId]
    const next: Record<string, GridViewState> = { ...states }
    for (const id in cellSpaces) {
      if (cellSpaces[id] === space) next[id] = clamped
    }
    // Guard: a changed cell with no registered space still updates itself.
    next[changedId] = clamped
    return next
  }
  return { ...states, [changedId]: clamped }
}

/**
 * A VALUE signature of a per-cell camera map — the CAMERA-COMMIT CHOKEPOINT's key (DEC-46).
 *
 * The grid has FIVE camera writers (the deck's `onViewStateChange`, the linked-space store write, a
 * host `dispatchAction({type:'gridViewState'})`, a second popped-out workspace writing the same
 * space's scope, and the image-framing SEED). Only the first is a callback the shell can hook, so
 * notifying the shell FROM that callback misses the other four — which is exactly how an open
 * plot-data table came to list a pre-move window. `GridDeckLayer` therefore notifies from the ONE
 * place all five converge: the camera map it hands deck. This signature is what makes notifying
 * from an effect there safe.
 *
 * It is a VALUE signature, deliberately, not an identity check:
 *  - the memo that produces the map re-mints on inputs that are not the camera (a cell-list change,
 *    a link toggle), and the shell converts a commit notification into a RE-RENDER that feeds back
 *    into this component — an identity key is therefore a feedback loop; a value key cannot be one;
 *  - "the camera moved" means the NUMBERS moved: every consumer re-derives a visible window from them.
 *
 * Key order is normalized (sorted) so a cell-insertion-order change alone is not a camera move.
 * `zoom` may be scalar (a dense cell) or per-axis (a migrated chart view); both stringify stably.
 */
export function cameraSignature(
  states: Record<string, { target: readonly number[]; zoom: number | readonly number[] }>,
): string {
  let out = ''
  for (const id of Object.keys(states).sort()) {
    const vs = states[id]
    out += `${id}:${vs.target[0]},${vs.target[1]},${String(vs.zoom)};`
  }
  return out
}

/** Build the controlled `{ [cellId]: viewState }` map deck.gl consumes, SCOPED BY
 *  SPACE: when linked, each cell reads ITS OWN space's shared state from
 *  `sharedBySpace` (so cells in different spaces get INDEPENDENT view states — a
 *  scatter and an image cell never share one); when unlinked, each cell reads its own
 *  entry from `states`. `fallback` covers a cell with no stored/shared state yet.
 *  Iterates `cellSpaces` (cellId → spaceKey) in insertion order. */
export function buildControlledViewStates(
  cellSpaces: Record<string, string>,
  states: Record<string, GridViewState>,
  linked: boolean,
  sharedBySpace: Record<string, GridViewState>,
  fallback: GridViewState,
): Record<string, GridViewState> {
  const out: Record<string, GridViewState> = {}
  for (const id in cellSpaces) {
    out[id] = linked
      ? (sharedBySpace[cellSpaces[id]] ?? states[id] ?? fallback)
      : (states[id] ?? fallback)
  }
  return out
}
