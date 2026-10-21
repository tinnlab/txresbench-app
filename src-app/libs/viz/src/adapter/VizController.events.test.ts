// VizController.events.test.ts — the typed plot-event BRIDGES (EVENT_API_PLAN Phase 1). The
// controller wraps the pure emitter with two bridges:
//   • select   — a coordination-store subscription (`pointSelection` + `selectionOrigin`) → emit,
//                 attached lazily on the first `on('select')` and torn down on the last unsubscribe.
//   • dataZoom  — `dispatch({ type: 'dataZoom' })` fans a typed event (the "make the stashed window
//                 a real signal" path).
// These exercise the bridges through the REAL store + the REAL dispatch path (no mocks of the seam).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VizController } from './VizController'
import { useCoordinationStore } from './Coordination.store'
import type {
  VizSelectEvent,
  VizDataZoomEvent,
  VizHoverEvent,
  VizLegendEvent,
  VizFilterEvent,
} from '../viz-core/events/emitter'

// A resolver is required to construct the controller, but the event bridges never touch it — the
// tests drive the store + dispatch directly, so a never-called stub is fine.
function makeController(): VizController {
  return new VizController({ resolveDataset: () => Promise.reject(new Error('unused')) })
}

beforeEach(() => {
  // The coordination store is a module singleton — reset the selection between tests.
  useCoordinationStore.getState().clearSelection()
})

describe('VizController — select bridge (coordination store → emitter)', () => {
  it('emits `select` with the ids + origin when the store selection is set', () => {
    const controller = makeController()
    const seen: VizSelectEvent[] = []
    controller.on('select', e => seen.push(e))

    const ids = new Uint32Array([4, 5, 6])
    useCoordinationStore.getState().setSelection('panel-x', ids)

    expect(seen).toHaveLength(1)
    expect(seen[0].ids).toBe(ids)
    expect(seen[0].origin).toBe('panel-x')
  })

  it('emits an EMPTY id array with origin null when the selection is cleared', () => {
    const controller = makeController()
    const seen: VizSelectEvent[] = []
    controller.on('select', e => seen.push(e))

    useCoordinationStore.getState().setSelection('panel-x', new Uint32Array([1]))
    useCoordinationStore.getState().clearSelection()

    const last = seen[seen.length - 1]
    expect(last.ids.length).toBe(0)
    expect(last.origin).toBeNull()
  })

  it('an empty (length-0) setSelection carries a null origin (store nulls it)', () => {
    const controller = makeController()
    const seen: VizSelectEvent[] = []
    controller.on('select', e => seen.push(e))

    // `setSelection(origin, EMPTY)` is the distinct path from `clearSelection()` (covered above):
    // the lasso-that-hit-nothing gesture. It must fan the SAME shape — empty ids, null origin.
    // Drive it from a LIVE selection: the bridge subscribes to `pointSelection`, so the empty write
    // has to be an observable TRANSITION for it to fan (the no-op case is pinned below).
    useCoordinationStore.getState().setSelection('panel-x', new Uint32Array([7]))
    useCoordinationStore.getState().setSelection('panel-x', new Uint32Array([]))

    const last = seen[seen.length - 1]
    expect(last.ids.length).toBe(0)
    expect(last.origin).toBeNull()
  })

  // CONTRACT LOCK — the select bridge is a CHANGE bridge over `pointSelection`, and the store
  // NORMALIZES an empty selection to `null` (the invariant `unionOriginSelections` + `applySlice` +
  // `setPointSelection` + `writeSelectionSpace` all enforce). So an empty write onto an ALREADY-empty
  // selection is a genuine no-op and must NOT fan a redundant `select`. Both spellings of "empty"
  // (`null` and a zero-length array) behave identically — before the normalization landed they did
  // NOT (a zero-length array was a fresh reference and fanned a phantom event, `null` did not), and
  // that reference-identity asymmetry is exactly what this pins shut.
  it('does NOT emit when an empty setSelection leaves an already-empty selection unchanged', () => {
    const controller = makeController()
    const seen: VizSelectEvent[] = []
    controller.on('select', e => seen.push(e))

    useCoordinationStore.getState().setSelection('panel-x', new Uint32Array([]))
    useCoordinationStore.getState().setSelection('panel-x', null)
    useCoordinationStore.getState().clearSelection()

    expect(seen).toHaveLength(0)
    expect(useCoordinationStore.getState().pointSelection).toBeNull()
    expect(useCoordinationStore.getState().selectionOrigin).toBeNull()
  })

  it('tears the store bridge down when the last select listener unsubscribes', () => {
    const controller = makeController()
    const h = vi.fn()
    const off = controller.on('select', h)

    useCoordinationStore.getState().setSelection('a', new Uint32Array([1]))
    expect(h).toHaveBeenCalledTimes(1)

    off()
    // With no select listeners the bridge is detached: a further store change must NOT deliver.
    useCoordinationStore.getState().setSelection('b', new Uint32Array([2]))
    expect(h).toHaveBeenCalledTimes(1)
  })
})

describe('VizController — dataZoom bridge (dispatch → emitter)', () => {
  it('emits a typed `dataZoom` event on dispatch, with the derived axis + window', () => {
    const controller = makeController()
    const seen: VizDataZoomEvent[] = []
    controller.on('dataZoom', e => seen.push(e))

    controller.dispatch({ type: 'dataZoom', id: 'plot-1', window: { x: [0.2, 0.8] } })

    expect(seen).toEqual([
      { type: 'dataZoom', id: 'plot-1', axis: 'x', window: { x: [0.2, 0.8] } },
    ])
  })

  it('a both-axis window derives axis "xy"', () => {
    const controller = makeController()
    const seen: VizDataZoomEvent[] = []
    controller.on('dataZoom', e => seen.push(e))

    controller.dispatch({ type: 'dataZoom', id: 'm', window: { x: [0, 4], y: [1, 3] } })
    expect(seen[0].axis).toBe('xy')
  })

  it('a select dispatch does NOT fire dataZoom listeners (per-type isolation)', () => {
    const controller = makeController()
    const onZoom = vi.fn()
    controller.on('dataZoom', onZoom)
    controller.dispatch({ type: 'select', originId: 'a', ids: new Uint32Array([1]) })
    expect(onZoom).not.toHaveBeenCalled()
  })
})

// The Phase-2 `hover` / `legend` / `filter` bridges live in the control/canvas COMPONENTS, which
// reach the emitter via the React `VizEventBusContext` whose value is the `VizController` itself —
// i.e. the component calls `controller.emit({ ... })`, and `<Viz>`'s props wire
// `controller.on(type, ...)`. These tests exercise that exact runtime path (the component's emit →
// the controller's typed `on`) without a React renderer: the payload a component builds is the one a
// listener receives. (The pure payload-derivation — Legend's `toggleHidden`/`soloHidden` ascending
// codes, VisualMap's `[lo,hi]` — is covered by the controls unit tests.)
describe('VizController — Phase-2 context-emitted bridges (hover / legend / filter)', () => {
  it('delivers a `hover` event (the scatter/chart canvas emit path) to an `on("hover")` listener', () => {
    const controller = makeController()
    const seen: VizHoverEvent[] = []
    controller.on('hover', e => seen.push(e))

    // What DeckScatterCanvas' rAF flush emits for a picked point, then a leave.
    controller.emit({ type: 'hover', id: 12 })
    controller.emit({ type: 'hover', id: null })

    expect(seen).toEqual([
      { type: 'hover', id: 12 },
      { type: 'hover', id: null },
    ])
  })

  it('delivers a `legend` event (the Legend hidden-set toggle) with the codes ascending', () => {
    const controller = makeController()
    const seen: VizLegendEvent[] = []
    controller.on('legend', e => seen.push(e))

    // What Legend's `commit` emits after `toggleHidden` — the color-by column id + hidden codes.
    controller.emit({ type: 'legend', column: 'cluster', hidden: [0, 2, 5] })

    expect(seen).toEqual([{ type: 'legend', column: 'cluster', hidden: [0, 2, 5] }])
  })

  it('delivers a `filter` event (the VisualMap range change) with the id/column/range', () => {
    const controller = makeController()
    const seen: VizFilterEvent[] = []
    controller.on('filter', e => seen.push(e))

    controller.emit({ type: 'filter', id: 'vm-1', column: 'expr', range: [0.1, 0.9] })

    expect(seen).toEqual([{ type: 'filter', id: 'vm-1', column: 'expr', range: [0.1, 0.9] }])
  })

  it('isolates the Phase-2 listeners by type (a hover emit fires only hover)', () => {
    const controller = makeController()
    const onHover = vi.fn()
    const onLegend = vi.fn()
    const onFilter = vi.fn()
    controller.on('hover', onHover)
    controller.on('legend', onLegend)
    controller.on('filter', onFilter)
    controller.emit({ type: 'hover', id: 3 })
    expect(onHover).toHaveBeenCalledTimes(1)
    expect(onLegend).not.toHaveBeenCalled()
    expect(onFilter).not.toHaveBeenCalled()
  })

  it('subscribing to a Phase-2 type never attaches the select store bridge (no store coupling)', () => {
    const controller = makeController()
    const off = controller.on('hover', vi.fn())
    // A store selection change must NOT reach a hover listener (the select bridge is select-only).
    const onHover = vi.fn()
    controller.on('hover', onHover)
    useCoordinationStore.getState().setSelection('p', new Uint32Array([1]))
    expect(onHover).not.toHaveBeenCalled()
    off()
  })
})

describe('VizController — cell-close (Phase 3 controlled close)', () => {
  it('delivers a cell-close event to on("cell-close") with the cellId', () => {
    const controller = makeController()
    const seen: string[] = []
    controller.on('cell-close', e => seen.push(e.cellId))
    // The bus a `controlled` CellView emits on IS the controller (it implements VizEventBus).
    controller.emit({ type: 'cell-close', cellId: 'criterion-2' })
    expect(seen).toEqual(['criterion-2'])
  })

  it('a cell-close listener does not see other event types (isolation)', () => {
    const controller = makeController()
    const onClose = vi.fn()
    controller.on('cell-close', onClose)
    controller.emit({ type: 'hover', id: 3, value: 1 })
    expect(onClose).not.toHaveBeenCalled()
  })
})
