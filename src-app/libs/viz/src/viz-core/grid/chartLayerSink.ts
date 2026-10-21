// chartLayerSink.ts — the seam (DEC-6) that lets a CHART cell render as a VIEW in the ONE shared
// grid deck instead of its own `<ChartCanvas>` (so N charts = 1 WebGL context). Each chart View,
// mounted in the grid's content overlay, PUBLISHES its shared-deck contribution — the deck layers it
// wants drawn (all `<cellId>::`-prefixed so the grid `layerFilter` clips them to its viewport), the
// per-view render params (flipY/controller), and its fitted viewState — up to this per-workspace
// store. GridWorkspace SUBSCRIBES (via `useSyncExternalStore`) and merges every cell's contribution
// into the deck's `views` / `layers` / `controlledViewState`.
//
// Data flows CHILD → PARENT (the View is a descendant of GridWorkspace), so the store is an external
// store, not React state: publishing does NOT re-render the publisher, only notifies the grid. To
// avoid a publish↔re-render loop, `publish` is shallow-equal-gated — an unchanged contribution is a
// no-op (no notify), so a stable `layers` memo settles after one frame.

import { createContext } from 'react'
import type { Layer } from '@deck.gl/core'
import type { CellViewState } from '../layers/multiView'

/** Per-view render params a chart contributes for its `OrthographicView` (see `buildViews`). */
export interface ChartViewParams {
  /** matrix charts (heatmap/dotplot) flip Y so row 0 is at top. Default false. */
  readonly flipY?: boolean
  /** false ⇒ the pane's dataZoom rail / window owns framing (matrix + value-zoom charts). */
  readonly controller?: boolean
}

/** One chart cell's full contribution to the shared deck. */
export interface ChartContribution {
  readonly cellId: string
  /** Deck layers to draw for this cell — MUST be `<cellId>::<name>`-prefixed (layerFilter routing). */
  readonly layers: readonly Layer[]
  readonly view: ChartViewParams
  /** The cell's fitted camera (target + per-axis or scalar zoom). */
  readonly viewState: CellViewState
  /** Called by the grid when deck reports a camera change for THIS cell's view (free-camera charts),
   *  so the chart can update its controlled viewState + re-publish. Absent ⇒ camera is not user-driven
   *  (matrix/value charts framed by their dataZoom rail). */
  readonly onViewStateChange?: (viewState: CellViewState) => void
  /** Called by the grid's shared-deck onHover when the pointer is over THIS cell's view (or picks its
   *  layer), so the chart updates its axis-pointer crosshair / texel tooltip. `info` is deck's hover
   *  info (world `coordinate`, canvas `x`/`y`, picked `index`/`layer`); `null` ⇒ pointer left the cell. */
  readonly onHover?: (info: unknown | null) => void
}

/**
 * Context carrying the grid's chart-layer sink DOWN to each in-grid `ChartCanvas`. Present ⇒ the
 * chart renders as a VIEW in the shared grid deck (publishes to the sink, no own `<DeckGL>`). Absent
 * (the default) ⇒ `ChartCanvas` renders its own deck — the pop-out-window path (DEC-2/6b), unchanged.
 */
export const ChartLayerSinkContext = createContext<ChartLayerSink | null>(null)

function paramsEqual(a: ChartViewParams, b: ChartViewParams): boolean {
  return a.flipY === b.flipY && a.controller === b.controller
}
function zoomEqual(a: CellViewState['zoom'], b: CellViewState['zoom']): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a[0] === b[0] && a[1] === b[1]
  return a === b
}
function viewStateEqual(a: CellViewState, b: CellViewState): boolean {
  return a.target[0] === b.target[0] && a.target[1] === b.target[1] && zoomEqual(a.zoom, b.zoom)
}
/** Shallow-equal a contribution — layers by reference (a stable `useMemo` array), the rest by value. */
function contributionEqual(a: ChartContribution, b: ChartContribution): boolean {
  return (
    a.cellId === b.cellId &&
    a.layers === b.layers &&
    paramsEqual(a.view, b.view) &&
    viewStateEqual(a.viewState, b.viewState)
  )
}

export interface ChartLayerSink {
  /** Publish/replace a cell's contribution. No-op (no notify) if shallow-equal to the current one. */
  publish(contribution: ChartContribution): void
  /** Drop a cell's contribution on unmount. */
  remove(cellId: string): void
  /** Current contributions, keyed by cell id (a stable snapshot object for `useSyncExternalStore`). */
  snapshot(): ReadonlyMap<string, ChartContribution>
  /** Subscribe to changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void
}

export function createChartLayerSink(): ChartLayerSink {
  let map = new Map<string, ChartContribution>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const l of listeners) l()
  }
  return {
    publish(c) {
      const prev = map.get(c.cellId)
      if (prev && contributionEqual(prev, c)) return // stable ⇒ no re-render (breaks the loop)
      map = new Map(map) // new identity so useSyncExternalStore sees a change
      map.set(c.cellId, c)
      notify()
    },
    remove(cellId) {
      if (!map.has(cellId)) return
      map = new Map(map)
      map.delete(cellId)
      notify()
    },
    snapshot() {
      return map
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
