// VizController.mutators.test.ts — the DATA-OWNERSHIP-INVERSION imperative surface.
//
// Once the viz OWNS its data (the buffers-omitted `<Viz source={...} option={...} />` handoff),
// the app manipulates the workspace WITHOUT re-passing any bulk buffer: every add/remove/split/
// set-kind/set-colorBy/select is a COMMAND on `VizController` that forwards to the shared grid /
// coordination stores (which pull whatever data they need from the owned `source`). These tests
// assert each mutator forwards correctly (node env — no browser/WebGL), plus that the pull the
// buffers-omitted `GridWorkspace` performs resolves real buffers + catalog from a `source`.

import { describe, it, expect, beforeEach } from 'vitest'
import { VizController } from './VizController'
import { useGridWorkspaceStore, INITIAL_CELL_ID } from './GridWorkspace.store'
import { useCoordinationStore } from './Coordination.store'
import { FixtureSource } from '../viz-core/data/fixtures'
import { computeColoring, DEFAULT_COLOR_BY, type ColorBy } from '../viz-core/data/engine'
import { installBuiltins } from '../viz-core/charts/installBuiltins'

installBuiltins()

const source = new FixtureSource({ seed: 42, pointCount: 1000 })
const controller = new VizController({ resolveDataset: () => source })

beforeEach(() => {
  // Fresh single-cell workspace + cleared selection before each mutator assertion.
  useGridWorkspaceStore.getState().reset()
  useCoordinationStore.getState().clearSelection()
})

describe('VizController mutators forward to the grid store (no buffer re-pass)', () => {
  it('addCell splits the last leaf, grows the cell map, and returns the new id', () => {
    const before = Object.keys(useGridWorkspaceStore.getState().cells).length
    const newId = controller.addCell()
    const cells = useGridWorkspaceStore.getState().cells
    expect(newId).toBe('cell-2')
    expect(Object.keys(cells).length).toBe(before + 1)
    expect(cells[newId]).toBeDefined()
  })

  it('splitCell inserts a fresh cell beside a specific leaf and returns its id', () => {
    const newId = controller.splitCell(INITIAL_CELL_ID, 'row', 'violin')
    const cells = useGridWorkspaceStore.getState().cells
    expect(newId).toBe('cell-2')
    expect(cells[newId]?.kind).toBe('violin')
    // The original leaf survives (a split keeps both panes).
    expect(cells[INITIAL_CELL_ID]).toBeDefined()
  })

  it('removeCell deletes a leaf and keeps the workspace non-empty', () => {
    const added = controller.addCell()
    expect(Object.keys(useGridWorkspaceStore.getState().cells).length).toBe(2)
    controller.removeCell(added)
    const cells = useGridWorkspaceStore.getState().cells
    expect(cells[added]).toBeUndefined()
    expect(cells[INITIAL_CELL_ID]).toBeDefined()
    expect(Object.keys(cells).length).toBe(1)
  })

  it('setCellKind changes a cell view-kind', () => {
    controller.setCellKind(INITIAL_CELL_ID, 'heatmap')
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID]?.kind).toBe('heatmap')
  })

  it('setCellColorBy stamps a per-cell color-by intent (recolored from the owned source)', () => {
    const colorBy: ColorBy = {
      mode: 'categorical',
      key: 'group',
      colormap: 'viridis',
      scale: 'linear',
      hidden: new Set<number>(),
    }
    controller.setCellColorBy(INITIAL_CELL_ID, colorBy)
    expect(useGridWorkspaceStore.getState().cells[INITIAL_CELL_ID]?.colorBy).toEqual(colorBy)
  })
})

describe('VizController.select forwards to the Coordination store', () => {
  it('publishes a Uint32Array selection with its origin', () => {
    controller.select(new Uint32Array([5, 9, 11]), 'cell-1')
    const s = useCoordinationStore.getState()
    expect(Array.from(s.pointSelection ?? [])).toEqual([5, 9, 11])
    expect(s.selectionOrigin).toBe('cell-1')
  })

  it('coerces a plain number[] to a Uint32Array', () => {
    controller.select([1, 2, 3], 'cell-1')
    const s = useCoordinationStore.getState()
    expect(s.pointSelection).toBeInstanceOf(Uint32Array)
    expect(Array.from(s.pointSelection ?? [])).toEqual([1, 2, 3])
  })

  it('null clears the shared selection + origin', () => {
    controller.select([1, 2, 3], 'cell-1')
    controller.select(null)
    const s = useCoordinationStore.getState()
    expect(s.pointSelection).toBeNull()
    expect(s.selectionOrigin).toBeNull()
  })
})

describe('buffers-omitted GridWorkspace pull resolves from the source', () => {
  it('positions + default coloring + catalog all resolve (the one-time ownership handoff)', async () => {
    // This is the exact pull the buffers-omitted `GridWorkspace` runs when `positions`/`colors`/
    // `catalog` props are absent: catalog → first layout id → positions + default coloring.
    const catalog = await source.catalog()
    const layoutId = catalog.layouts[0]?.id ?? 'primary'
    const pos = await source.positions(layoutId)
    const coloring = await computeColoring(source, DEFAULT_COLOR_BY)

    expect(catalog.pointCount).toBeGreaterThan(0)
    expect(pos.positions.length).toBe(catalog.pointCount * 2)
    expect(coloring.colors.length).toBe(catalog.pointCount * 4)
    expect(pos.positions).toBeInstanceOf(Float32Array)
    expect(coloring.colors).toBeInstanceOf(Uint8Array)
  })
})
