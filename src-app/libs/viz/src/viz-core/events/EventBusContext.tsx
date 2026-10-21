// events/EventBusContext.tsx — the React seam that lets a per-plot DataZoom component (deep inside
// a chart View, rendered by `GridWorkspace`) reach the `VizController`'s event emitter WITHOUT
// prop-drilling through every intermediate (the grid + View chain). `<Viz>` provides the
// controller's bus around `<GridWorkspace>`; the `ValueDataZoom` / `DataZoomMatrix` components read
// it and emit `dataZoom` on commit. When there is NO provider (a bare `<GridWorkspace>` /
// pop-out / a story), `useContext` returns `null` → the component emits nothing (byte-identical).
//
// viz-core rule: react + sibling viz-core only — the context carries the narrow `VizEventBus`
// interface (an `emit` capability), never the adapter `VizController` type.

import { createContext } from 'react'
import type { VizEventBus } from './emitter'

/** The optional plot-event bus for the current `<Viz>` subtree (`null` when unprovided). */
export const VizEventBusContext = createContext<VizEventBus | null>(null)

/**
 * A bus that forwards ONLY the controlled-close gesture to `onClose`, keyed by the pane the user
 * closed. Every other plot event is ignored.
 *
 * It exists for a host that composes `<GridWorkspace>` itself rather than mounting `<Viz>`: such a
 * host gets no provider, and a `controlled` pane's close then reaches nothing at all — a live,
 * styled, focusable X that silently does nothing. Building the bus HERE rather than at each host
 * keeps the event's name and payload shape viz's own business, which is what stops a host from
 * spelling either of them itself and drifting.
 */
export function closeEventBus(onClose: (paneId: string) => void): VizEventBus {
  return {
    emit(event) {
      if (event.type === 'cell-close') onClose(event.cellId)
    },
  }
}
