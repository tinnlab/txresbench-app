// events/emitter.ts — the typed PLOT-EVENT surface for `@txresbench/viz` (EVENT_API_PLAN Phases 1+2).
// The equivalent of ECharts' `chart.on('selectchanged' | 'datazoom' | 'legendselectchanged',
// handler)`: a small, pure, DOM/store/React-free emitter carrying a domain-neutral event union
// (canonical point ids, axis windows, category codes, column names). Unlike the app-level
// notify-and-refetch sync, this is a CLIENT API (not a security boundary), so it carries the
// actual PAYLOAD.
//
// Phase 1 shipped `select` + `dataZoom`; Phase 2 adds `hover` + `legend` + `filter` (surfacing the
// component-local hover / Legend-hidden / visualMap-range signals into the same emitter). Living in
// viz-core (not adapter) keeps it importable from BOTH the pure control/canvas components (which emit
// `dataZoom` / `hover` / `legend` / `filter` via the React `VizEventBusContext`) and the adapter
// `VizController` (which bridges the coordination store's selection → `select`) without a
// viz-core→adapter edge.
//
// viz-core rule: no @txresbench/*, no store, no React — a plain listener registry.

import type { VizWindow } from '../option/types'

/** A points-selected/cleared event: the CANONICAL point ids (NOT array indices) + the origin
 *  view id that produced it (`null` when unknown / empty), so a consumer can skip its own echo. */
export interface VizSelectEvent {
  readonly type: 'select'
  /** The selected canonical point ids; an EMPTY array when the selection was cleared. */
  readonly ids: Uint32Array
  readonly origin: string | null
}

/** A per-plot dataZoom window change: which plot (`id`), which axis/axes moved, and the new
 *  window in DATA units. `axis` is `'xy'` when both axes moved in the one commit (matrix). */
export interface VizDataZoomEvent {
  readonly type: 'dataZoom'
  readonly id: string
  readonly axis: 'x' | 'y' | 'xy'
  readonly window: VizWindow
}

/** A pointer HOVER over a picked mark (Phase 2): the mark's `id` (a picked point/mark index; the
 *  scatter's picked index), or `null` on leave / empty space. `value` is the mark's scalar value
 *  when the producing surface knows it (optional — the scatter carries none). rAF-throttled at the
 *  producer (it reuses the canvas's existing hover coalescer), so this is at most one per frame. */
export interface VizHoverEvent {
  readonly type: 'hover'
  readonly id: number | null
  readonly value?: number
}

/** A categorical LEGEND toggle (Phase 2): the color-by `column` id whose legend changed + the full
 *  set of currently-HIDDEN category codes (ascending, so a consumer diffs it directly). Mirrors the
 *  cell's `ColorBy.hidden` — an empty array means "all categories visible". */
export interface VizLegendEvent {
  readonly type: 'legend'
  readonly column: string
  readonly hidden: readonly number[]
}

/** A continuous FILTER (visualMap / value-gate) range change (Phase 2): which control (`id`), the
 *  optional bound `column` id, and the new `[lo, hi]` range in DATA units — `null` when the filter
 *  is cleared (full range / no clamp). */
export interface VizFilterEvent {
  readonly type: 'filter'
  readonly id: string
  readonly column?: string
  readonly range: [number, number] | null
}

/** A user-initiated CELL CLOSE (Phase 3): the user clicked a cell's close affordance. Fired ONLY for a
 *  cell marked `controlled` — its built-in remove is SUPPRESSED so the APP owns the close (it routes the
 *  `cellId` to a declared action). A non-controlled cell removes itself directly and fires nothing. The
 *  event does NOT itself remove the cell — the app performs the actual removal (or state mutation). */
export interface VizCellCloseEvent {
  readonly type: 'cell-close'
  readonly cellId: string
}

/** The public plot-event union (Phase 1: select + dataZoom; Phase 2: hover + legend + filter;
 *  Phase 3: cell-close). */
export type VizEvent =
  | VizSelectEvent
  | VizDataZoomEvent
  | VizHoverEvent
  | VizLegendEvent
  | VizFilterEvent
  | VizCellCloseEvent
export type VizEventType = VizEvent['type']
/** The concrete event for a given `type` tag. */
export type VizEventOf<T extends VizEventType> = Extract<VizEvent, { type: T }>
/** A handler for events of one `type`. */
export type VizEventHandler<T extends VizEventType> = (event: VizEventOf<T>) => void

/** The minimal EMIT capability a producer needs (what the DataZoom React context carries). Kept
 *  narrow so a component can emit without a reference to the whole `VizController`. */
export interface VizEventBus {
  emit(event: VizEvent): void
}

/** Derive the moved-axis tag from a window's populated bounds (`x` only → 'x', `y` only → 'y',
 *  both → 'xy'; an empty window degrades to 'xy'). */
export function windowAxis(window: VizWindow): 'x' | 'y' | 'xy' {
  const hasX = window.x != null
  const hasY = window.y != null
  if (hasX && hasY) return 'xy'
  return hasX ? 'x' : hasY ? 'y' : 'xy'
}

/**
 * A tiny typed listener registry: `on(type, handler)` returns an unsubscribe fn; `emit(event)`
 * fans an event to every listener of its `type`. Delivery iterates a COPY of the listener set so a
 * handler may unsubscribe (itself or another) mid-dispatch without skipping / re-invoking peers.
 * Pure — no React, no store, no DOM — so the whole contract is node-unit-testable.
 */
export class VizEmitter implements VizEventBus {
  private readonly listeners = new Map<VizEventType, Set<(e: VizEvent) => void>>()

  /** Subscribe to one event `type`. Returns an idempotent unsubscribe fn. */
  on<T extends VizEventType>(type: T, handler: VizEventHandler<T>): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    const h = handler as (e: VizEvent) => void
    set.add(h)
    return () => {
      set!.delete(h)
    }
  }

  /** Fan an event to every current listener of its `type` (a snapshot, so mid-emit unsub is safe). */
  emit(event: VizEvent): void {
    const set = this.listeners.get(event.type)
    if (!set || set.size === 0) return
    for (const h of [...set]) h(event)
  }

  /** How many listeners are attached for `type` (used to lazily manage bridge subscriptions). */
  listenerCount(type: VizEventType): number {
    return this.listeners.get(type)?.size ?? 0
  }
}
