// vizStores.test.ts — the isolation-seam proof (VIZ_ISOLATION W1). Node env, no React renderer,
// so the scoped hooks (which call React hooks) are asserted structurally + via resolution logic;
// the store-independence + default-singleton-identity properties are asserted purely.

import { describe, it, expect } from 'vitest'
import {
  createVizStores,
  defaultVizStores,
  VizStoresContext,
  useVizStores,
  useCoordination,
  useGridWorkspace,
  useColorOverride,
  usePlotInteraction,
  type VizStores,
} from './vizStores'
import { useCoordinationStore } from './Coordination.store'
import { useGridWorkspaceStore, INITIAL_CELL_ID } from './GridWorkspace.store'
import { useColorOverrideStore } from './colorOverride.store'
import { usePlotInteractionStore } from './PlotInteraction.store'

describe('createVizStores — independence', () => {
  it('mints four distinct bound stores', () => {
    const s = createVizStores()
    const members = [s.coordination, s.gridWorkspace, s.colorOverride, s.plotInteraction]
    // all four present + distinct references
    expect(new Set(members).size).toBe(4)
    // each is a bound store: callable + static API
    for (const m of members) {
      expect(typeof m).toBe('function')
      expect(typeof m.getState).toBe('function')
      expect(typeof m.setState).toBe('function')
      expect(typeof m.subscribe).toBe('function')
    }
  })

  it('two sets are fully independent — coordination action on A does not affect B', () => {
    const a = createVizStores()
    const b = createVizStores()
    const ids = Uint32Array.from([1, 2, 3])
    a.coordination.getState().setSelection('paneA', ids)
    expect(a.coordination.getState().pointSelection).toEqual(ids)
    expect(a.coordination.getState().selectionOrigin).toBe('paneA')
    // B untouched
    expect(b.coordination.getState().pointSelection).toBeNull()
    expect(b.coordination.getState().selectionOrigin).toBeNull()
  })

  it('grid / colorOverride / plotInteraction actions are isolated per set', () => {
    const a = createVizStores()
    const b = createVizStores()

    a.gridWorkspace.getState().addCell()
    expect(Object.keys(a.gridWorkspace.getState().cells).length).toBe(2)
    expect(Object.keys(b.gridWorkspace.getState().cells).length).toBe(1)
    expect(b.gridWorkspace.getState().cells[INITIAL_CELL_ID]).toBeDefined()

    a.colorOverride.getState().setCategoryColor('cell_type', 'T cells', '#ff0000')
    expect(a.colorOverride.getState().overrides.cell_type?.categoryColors?.['T cells']).toBe(
      '#ff0000',
    )
    expect(b.colorOverride.getState().overrides.cell_type).toBeUndefined()

    a.plotInteraction.getState().setFilter('plot-1', [0, 5])
    expect(a.plotInteraction.getState().filters['plot-1']).toEqual([0, 5])
    expect(b.plotInteraction.getState().filters['plot-1']).toBeUndefined()
  })

  it('a fresh set does NOT share the module singletons', () => {
    const s = createVizStores()
    expect(s.coordination).not.toBe(useCoordinationStore)
    expect(s.gridWorkspace).not.toBe(useGridWorkspaceStore)
    expect(s.colorOverride).not.toBe(useColorOverrideStore)
    expect(s.plotInteraction).not.toBe(usePlotInteractionStore)
  })
})

describe('defaultVizStores — the singleton set', () => {
  it('each member is the SAME object as the module singleton', () => {
    expect(defaultVizStores.coordination).toBe(useCoordinationStore)
    expect(defaultVizStores.gridWorkspace).toBe(useGridWorkspaceStore)
    expect(defaultVizStores.colorOverride).toBe(useColorOverrideStore)
    expect(defaultVizStores.plotInteraction).toBe(usePlotInteractionStore)
  })

  it('is the context default value (unprovided resolution === singletons)', () => {
    // React exposes a context's default via the internal `_currentValue`; assert the seam's
    // safe-by-default invariant: no provider ⇒ the singleton set.
    const ctx = VizStoresContext as unknown as { _currentValue: VizStores }
    expect(ctx._currentValue).toBe(defaultVizStores)
  })
})

describe('exported hook surface', () => {
  it('exposes the resolver + scoped reactive hooks as functions', () => {
    for (const fn of [
      useVizStores,
      useCoordination,
      useGridWorkspace,
      useColorOverride,
      usePlotInteraction,
    ]) {
      expect(typeof fn).toBe('function')
    }
  })
})
