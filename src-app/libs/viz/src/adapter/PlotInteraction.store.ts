// PlotInteraction.store.ts — the LIFTED home of the two previously component-local plot-interaction
// pieces (SESSION_STATE_PLAN Phase 2): the per-plot dataZoom WINDOW (was `useState` inside
// `DataZoom.tsx`) and the per-plot continuous FILTER range (was owned by whoever renders
// `VisualMap.tsx`). Both were invisible to the session snapshot because they lived in React state;
// hoisting them into a serializable store — keyed by a stable per-plot id — is what makes an EXACT
// save/restore possible (the dataZoom band + the filter clamp round-trip like every other store).
//
// Keyed by PLOT id (a stable per-plot/per-cell identifier), NOT by chart-kind: two plots of the same
// kind must own INDEPENDENT windows/filters. Because the lift is OPT-IN (a component routes through
// the store only when it is handed a stable per-plot id — see DataZoom.tsx / VisualMap.tsx), every
// current caller that passes only a static `testId` keeps its local React state and stays
// byte-identical; the store home engages exactly when a unique id is threaded (the showcase story,
// and the union-time per-cell wiring).
//
// Plain-zustand (no @ziee SDK, no immer), matching `GridWorkspace.store.ts`:
// `create()(subscribeWithSelector(builder))` — so a consumer (e.g. `<Viz onStateChange>`) can
// `store.subscribe(cb)` the whole slice and re-capture on any interaction.
//
// SINGLE SERIALIZE SOURCE FOR dataZoom WINDOWS (ITEM-21 / DEC-13, the "two homes" fix): a dataZoom
// window historically had TWO homes — a `VizController` Map (fed by `dispatch`) and THIS store (fed by
// the UI). For save/restore this store is the AUTHORITATIVE, canonical home: `serialize()`/`hydrate()`
// here are the ONE round-trip source for `VizOption.dataZoom[].window` + `filters`. The controller Map
// must DEFER to this store — mirror its windows INTO here on dispatch and read them back OUT of here for
// `getOption` — so there is exactly one serialize source and no divergence. (VizController owns that
// mirroring; it is intentionally NOT edited here — this store just documents + guarantees the contract.)

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ValueWindow } from '../viz-core/charts/valueWindow'
import type { MatrixWindow } from '../viz-core/charts/matrixWindow'

/** A serializable dataZoom window: either a value-axis band (`{lo,hi}`) or a matrix range
 *  (`{row0,row1,col0,col1}`). Both are plain JSON objects; the owning component reads back ITS
 *  own shape by its own key, so no discriminant is needed. */
export type DataZoomWindow = ValueWindow | MatrixWindow

/** A continuous filter clamp in DATA units (`[lo, hi]`, lo ≤ hi). */
export type FilterRange = readonly [number, number]

/** The serializable plot-interaction slice — the unit `serialize()`/`hydrate()` round-trip. */
export interface PlotInteractionSlice {
  /** Per-plot dataZoom window, keyed by a stable plot id. */
  dataZoomWindows: Record<string, DataZoomWindow>
  /** Per-plot continuous filter range, keyed by a stable plot id. */
  filters: Record<string, FilterRange>
}

export interface PlotInteractionState extends PlotInteractionSlice {}

export interface PlotInteractionActions {
  /** Set (or replace) a plot's dataZoom window. */
  setDataZoomWindow: (id: string, window: DataZoomWindow) => void
  /** Drop a plot's dataZoom window (collapses back to the "no window / full domain" default). */
  clearDataZoomWindow: (id: string) => void
  /** Set (or replace) a plot's continuous filter range. */
  setFilter: (id: string, range: FilterRange) => void
  /** Drop a plot's filter range. */
  clearFilter: (id: string) => void
  /** Read the current slice (pure snapshot — the single serialize source). */
  serialize: () => PlotInteractionSlice
  /** REPLACE the slice from a hydrated snapshot (no side-effect fetches). Missing maps default
   *  to empty so a partial/legacy slice is tolerated. */
  hydrate: (slice: Partial<PlotInteractionSlice>) => void
  /** Reset to empty (both maps cleared). */
  reset: () => void
}

function emptySlice(): PlotInteractionSlice {
  return { dataZoomWindows: {}, filters: {} }
}

// PER-INSTANCE ISOLATION (VIZ_ISOLATION W1): the store DEFINITION is extracted into the
// `createPlotInteractionStore()` factory (a fresh, independent bound store per call);
// `usePlotInteractionStore` is the DEFAULT module singleton (factory invoked once) with a
// byte-identical public API. No existing consumer changes.
export function createPlotInteractionStore() {
  return create<PlotInteractionState & PlotInteractionActions>()(
    subscribeWithSelector((set, get) => ({
    ...emptySlice(),
    setDataZoomWindow: (id, window) =>
      set(prev => ({ dataZoomWindows: { ...prev.dataZoomWindows, [id]: window } })),
    clearDataZoomWindow: id =>
      set(prev => {
        if (!(id in prev.dataZoomWindows)) return {}
        const next = { ...prev.dataZoomWindows }
        delete next[id]
        return { dataZoomWindows: next }
      }),
    setFilter: (id, range) =>
      set(prev => ({ filters: { ...prev.filters, [id]: range } })),
    clearFilter: id =>
      set(prev => {
        if (!(id in prev.filters)) return {}
        const next = { ...prev.filters }
        delete next[id]
        return { filters: next }
      }),
    serialize: () => {
      const { dataZoomWindows, filters } = get()
      // Deep-ish copy so a mutation after capture can't retro-edit the snapshot.
      return {
        dataZoomWindows: { ...dataZoomWindows },
        filters: { ...filters },
      }
    },
    hydrate: slice =>
      set(() => ({
        dataZoomWindows: { ...(slice.dataZoomWindows ?? {}) },
        filters: { ...(slice.filters ?? {}) },
      })),
    reset: () => set(() => emptySlice()),
    })),
  )
}

/** SPLIT 0b (ITEM-21 / DEC-21) — the per-plot NARROWING of `filters`.
 *
 *  `GridWorkspace` subscribes to the WHOLE `filters` record (`s => s.filters`), so a visual-map
 *  range change on ANY cell re-renders every subscriber of the workspace. The HOIST for this value
 *  was already done (merge `7e35c62c` moved it out of a `useState`); the DECOUPLING was not. This
 *  selector is that decoupling: a per-cell subscriber reads only ITS plot's range, and the stored
 *  tuple is itself the identity, so an unchanged range never re-renders it.
 *
 *  `filters` stays the SINGLE SERIALIZE SOURCE for `option.filters` (DEC-13) — this is a narrower
 *  READ of the same home, never a second home. */
export function selectPlotFilter(plotId: string) {
  return (s: PlotInteractionSlice): FilterRange | undefined => s.filters[plotId]
}

/** A bound PlotInteraction store instance (the factory's return type). */
export type PlotInteractionStore = ReturnType<typeof createPlotInteractionStore>

/** The DEFAULT module-singleton PlotInteraction store — byte-identical to the pre-factory
 *  export. Existing consumers importing `usePlotInteractionStore` are unaffected. */
export const usePlotInteractionStore: PlotInteractionStore = createPlotInteractionStore()
