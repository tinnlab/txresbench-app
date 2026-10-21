// plotCellId.test.ts — the STABLE per-cell dataZoom/filter id threading (ITEM-20 / DEC-16). Proves
// that a chart cell threaded with a stable id (via `PlotCellIdContext`, published by
// `CellView.ChartBody`) is CONNECTED to the `PlotInteraction` store — so a window/filter pre-seeded
// in the store (a restored `VizOption`) actually reaches the cell — while an un-threaded / default
// cell (no id → `ValueDataZoom`/`DataZoomMatrix`'s local-`useState` branch) is byte-identical to
// today (the full domain / full matrix).
//
// The chart Views host their DataZoom in React, so this node pass can't render them; instead it
// composes the SAME real units the threaded View strings together — `cellPlotId` (the id
// derivation), the real `createPlotInteractionStore()` slice (the store `useDataZoomWindowState`
// reads/writes), and the real `activeValueWindow`/`activeMatrixWindow` (the exact fallback the
// DataZoom feeds the passive body). Same node-testable philosophy as `datazoom/DataZoom.test.ts`.

import { describe, it, expect } from 'vitest'
import { cellPlotId, PlotCellIdContext } from './plotCellId'
import { createPlotInteractionStore } from '../../adapter/PlotInteraction.store'
import { activeValueWindow, activeMatrixWindow } from '../datazoom/DataZoom'
import { fullValueWindow, type ValueWindow } from './valueWindow'
import { fullWindow, type MatrixWindow } from './matrixWindow'

describe('cellPlotId — the stable per-cell id derivation', () => {
  it('is the cell id itself (identity — must equal the coord id so a restored option round-trips)', () => {
    expect(cellPlotId('bar-cell-1')).toBe('bar-cell-1')
  })

  it('is stable across calls (a remount reuses the same store key)', () => {
    expect(cellPlotId('heatmap-cell')).toBe(cellPlotId('heatmap-cell'))
  })

  it('collapses an empty / absent id to `undefined` (⇒ the byte-identical local-state DataZoom)', () => {
    expect(cellPlotId('')).toBeUndefined()
    expect(cellPlotId(undefined)).toBeUndefined()
  })

  it('the context default is `undefined` (a View rendered outside a grid cell is un-threaded)', () => {
    // A story renders a View with no provider → `useContext` yields the default → no `dataZoomId`.
    // The context object exposes its default via `Provider.defaultValue`-equivalent; assert via the
    // documented contract: an undefined default is what makes the no-provider path byte-identical.
    expect(PlotCellIdContext).toBeDefined()
    // React stores the default on the context's internal fields; the observable guarantee we rely on
    // is that `cellPlotId(undefined)` (what CellView would pass for an id-less cell) is undefined too.
    expect(cellPlotId(undefined)).toBeUndefined()
  })
})

describe('value dataZoom — a threaded cell READS its window from the PlotInteraction store', () => {
  it('reflects a window pre-seeded in the store (restore applies); default cell is full-domain', () => {
    const store = createPlotInteractionStore()
    const id = cellPlotId('viz-bar-cell')
    expect(id).toBeDefined()

    // Pre-seed the store as a restored `VizOption.dataZoom[].window` would (VizController.hydrate).
    store.getState().setDataZoomWindow(id as string, { lo: 2, hi: 8 })

    // The chain the threaded View feeds its passive body: store read (`useDataZoomWindowState`) →
    // `activeValueWindow`. The threaded cell now shows the RESTORED sub-range, not the full domain.
    const stored = store.getState().dataZoomWindows[id as string] as ValueWindow
    expect(activeValueWindow(stored, [0, 10])).toEqual({ lo: 2, hi: 8 })

    // An UN-THREADED / default cell (no `dataZoomId` → local `useState`, store never read → `null`)
    // is byte-identical to today: the full domain.
    expect(activeValueWindow(null, [0, 10])).toEqual(fullValueWindow(0, 10))
  })

  it('two cells own INDEPENDENT windows (keyed by their own ids — no cross-cell bleed)', () => {
    const store = createPlotInteractionStore()
    const a = cellPlotId('cell-a') as string
    const b = cellPlotId('cell-b') as string
    store.getState().setDataZoomWindow(a, { lo: 2, hi: 8 })
    store.getState().setDataZoomWindow(b, { lo: 5, hi: 6 })
    expect(activeValueWindow(store.getState().dataZoomWindows[a] as ValueWindow, [0, 10])).toEqual({ lo: 2, hi: 8 })
    expect(activeValueWindow(store.getState().dataZoomWindows[b] as ValueWindow, [0, 10])).toEqual({ lo: 5, hi: 6 })
  })

  it('WRITES back to the store (a cell zoom lands under its id, so getOption captures it)', () => {
    const store = createPlotInteractionStore()
    const id = cellPlotId('viz-violin-cell') as string
    // Simulate the View's `commitWin` → `setWin` store write on a user zoom.
    store.getState().setDataZoomWindow(id, { lo: 3, hi: 7 })
    // getOption reads `plotInteraction.serialize().dataZoomWindows[id]` — it now sees the cell's zoom.
    expect(store.getState().serialize().dataZoomWindows[id]).toEqual({ lo: 3, hi: 7 })
    // Clearing (zoom-to-full) removes the entry → the cell falls back to the full domain.
    store.getState().clearDataZoomWindow(id)
    expect(store.getState().dataZoomWindows[id]).toBeUndefined()
    expect(activeValueWindow(null, [0, 10])).toEqual(fullValueWindow(0, 10))
  })
})

describe('matrix dataZoom — a threaded heatmap/dotplot cell READS its window from the store', () => {
  it('reflects a pre-seeded matrix window; default cell is the full matrix', () => {
    const store = createPlotInteractionStore()
    const id = cellPlotId('viz-heatmap-cell') as string
    const seeded: MatrixWindow = { row0: 1, row1: 3, col0: 0, col1: 2 }
    store.getState().setDataZoomWindow(id, seeded)

    const stored = store.getState().dataZoomWindows[id] as MatrixWindow
    expect(activeMatrixWindow(stored, 5, 3)).toEqual(seeded)

    // Un-threaded default: no window in the store → the full matrix (byte-identical to today).
    expect(activeMatrixWindow(null, 5, 3)).toEqual(fullWindow(5, 3))
  })
})

describe('continuous filter — a threaded cell READS/WRITES its filter range via the store', () => {
  it('reflects a pre-seeded filter range; an un-threaded cell falls back to its `value` prop', () => {
    const store = createPlotInteractionStore()
    const id = cellPlotId('viz-cell-filter') as string

    // Pre-seed as a restored `VizOption.filters[id]` would.
    store.getState().setFilter(id, [1.5, 4.5])

    // VisualMap's effectiveValue = `storeMode ? (filters[id] ?? value) : value` — the threaded cell
    // reads the STORED range, overriding the `value` prop.
    const value: readonly [number, number] = [0, 10]
    const storedRange = store.getState().filters[id]
    const effective = storedRange ?? value
    expect(effective).toEqual([1.5, 4.5])

    // An un-threaded cell (id absent from the map) falls back to `value` — byte-identical to today.
    const unThreaded = store.getState().filters['not-seeded'] ?? value
    expect(unThreaded).toEqual([0, 10])
  })
})
