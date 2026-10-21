// GridWorkspace.setCellKind.test.ts — Round-2 regression: a chrome view-kind switch
// must DROP the cell's stale `bindings` (keyed by the OLD chart's binding schema) so the
// NEW chart resolves its own catalog defaults; a SAME-kind call must PRESERVE them.
//
// Bug (MED): `setCellKind` did `{ ...existing, kind }` and left `bindings` intact, so
// after e.g. violin→histogram the histogram bound its `continuous` channel to a
// violin-era `value` column (silent wrong output).

import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { useGridWorkspaceStore, INITIAL_CELL_ID } from './GridWorkspace.store'
import { installBuiltins } from '../viz-core/charts/installBuiltins'
import type { ResolvedBindings } from '../viz-core/registry/types'
import type { GridCell } from '../viz-core/grid/gridModel'

const STALE: ResolvedBindings = { valueKey: 'value' }

/** Seed the initial cell with a kind + explicit bindings. */
function seedCell(patch: Partial<GridCell>) {
  useGridWorkspaceStore.setState(prev => ({
    cells: { ...prev.cells, [INITIAL_CELL_ID]: { ...prev.cells[INITIAL_CELL_ID], ...patch } },
  }))
}

describe('setCellKind + stale bindings', () => {
  // The preserve-vs-clear rule reads each chart's bindingSchema from the registry.
  beforeAll(() => {
    installBuiltins()
  })
  beforeEach(() => {
    useGridWorkspaceStore.getState().reset()
  })

  it('DROPS stale bindings when the kind actually changes', () => {
    // Seed the initial cell with bindings from an old chart's schema.
    const store = useGridWorkspaceStore
    store.setState(prev => ({
      cells: {
        ...prev.cells,
        [INITIAL_CELL_ID]: { ...prev.cells[INITIAL_CELL_ID], kind: 'violin', bindings: STALE },
      },
    }))
    expect(store.getState().cells[INITIAL_CELL_ID].bindings).toEqual(STALE)

    store.getState().setCellKind(INITIAL_CELL_ID, 'histogram')

    const cell = store.getState().cells[INITIAL_CELL_ID]
    expect(cell.kind).toBe('histogram')
    expect(cell.bindings).toBeUndefined()
  })

  it('PRESERVES bindings on a same-kind call (no-op must not wipe them)', () => {
    const store = useGridWorkspaceStore
    store.setState(prev => ({
      cells: {
        ...prev.cells,
        [INITIAL_CELL_ID]: { ...prev.cells[INITIAL_CELL_ID], kind: 'violin', bindings: STALE },
      },
    }))

    store.getState().setCellKind(INITIAL_CELL_ID, 'violin')

    const cell = store.getState().cells[INITIAL_CELL_ID]
    expect(cell.kind).toBe('violin')
    expect(cell.bindings).toEqual(STALE)
  })

  it('is a no-op on an unknown cell id', () => {
    const store = useGridWorkspaceStore
    const before = store.getState().cells
    store.getState().setCellKind('nope', 'histogram')
    expect(store.getState().cells).toBe(before)
  })
})

// The data-shape-aware preserve: a switch between COMPATIBLE types (that share binding channels)
// keeps the user's column picks; an INCOMPATIBLE switch clears (the round-2 stale-binding fix).
describe('setCellKind — preserve compatible channels vs clear incompatible', () => {
  const store = useGridWorkspaceStore
  beforeAll(() => {
    installBuiltins()
  })
  beforeEach(() => {
    store.getState().reset()
  })

  it('PRESERVES shared value + group channels on a COMPATIBLE switch (violin → box)', () => {
    // violin + box both declare a `value` (source: value) + `group` (source: categorical) channel.
    seedCell({ kind: 'violin', bindings: { value: 'A', group: 'group' } })
    store.getState().setCellKind(INITIAL_CELL_ID, 'box')
    const cell = store.getState().cells[INITIAL_CELL_ID]
    expect(cell.kind).toBe('box')
    expect(cell.bindings).toEqual({ value: 'A', group: 'group' })
  })

  it('DROPS the channels the target lacks but KEEPS the shared one (box → bar keeps group, drops value)', () => {
    seedCell({ kind: 'box', bindings: { value: 'A', group: 'group' } })
    store.getState().setCellKind(INITIAL_CELL_ID, 'bar') // bar declares ONLY `group`
    const cell = store.getState().cells[INITIAL_CELL_ID]
    expect(cell.kind).toBe('bar')
    expect(cell.bindings).toEqual({ group: 'group' }) // value dropped, group preserved
  })

  it('survives a full violin → box → bar chain, keeping the group pick throughout', () => {
    seedCell({ kind: 'violin', bindings: { value: 'A', group: 'group' } })
    store.getState().setCellKind(INITIAL_CELL_ID, 'box')
    store.getState().setCellKind(INITIAL_CELL_ID, 'bar')
    const cell = store.getState().cells[INITIAL_CELL_ID]
    expect(cell.kind).toBe('bar')
    expect(cell.bindings).toEqual({ group: 'group' })
  })

  it('CLEARS on an INCOMPATIBLE switch — violin → histogram (value channel differs: value vs continuous)', () => {
    seedCell({ kind: 'violin', bindings: { value: 'A', group: 'group' } })
    store.getState().setCellKind(INITIAL_CELL_ID, 'histogram')
    const cell = store.getState().cells[INITIAL_CELL_ID]
    expect(cell.kind).toBe('histogram')
    expect(cell.bindings).toBeUndefined()
  })

  it('CLEARS on a switch to a BINDINGLESS target (violin → scatter has no channels to carry)', () => {
    seedCell({ kind: 'violin', bindings: { value: 'A', group: 'group' } })
    store.getState().setCellKind(INITIAL_CELL_ID, 'scatter')
    const cell = store.getState().cells[INITIAL_CELL_ID]
    expect(cell.kind).toBe('scatter')
    expect(cell.bindings).toBeUndefined()
  })

  it('leaves bindings undefined when the cell had none (imperative default path)', () => {
    seedCell({ kind: 'violin', bindings: undefined })
    store.getState().setCellKind(INITIAL_CELL_ID, 'box')
    const cell = store.getState().cells[INITIAL_CELL_ID]
    expect(cell.kind).toBe('box')
    expect(cell.bindings).toBeUndefined()
  })
})
