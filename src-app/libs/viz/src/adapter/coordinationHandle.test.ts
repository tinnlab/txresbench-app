// coordinationHandle.test.ts — the SELECTION component's `CoordinationHandle` (STEP 3). The
// handle is the seam a chart View publishes/clears the shared selection THROUGH (instead of
// touching the `Coordination` store directly), so the store becomes an implementation detail. The
// imperative publishers (`setSelection`/`setPointSelection`/`clearSelection`) are callable outside
// React (they route through `useCoordinationStore.getState()`), so their store round-trip is
// node-testable here; the reactive `use*` hooks are asserted to be present (rendering is a browser
// concern). Behavior must be byte-identical to the former direct store calls.

import { describe, it, expect, beforeEach } from 'vitest'
import { defaultCoordinationHandle } from './coordinationHandle'
import { useCoordinationStore } from './Coordination.store'

beforeEach(() => {
  // Reset the shared selection between tests so they don't bleed.
  useCoordinationStore.getState().clearSelection()
})

describe('CoordinationHandle — shape', () => {
  it('exposes the full read (hook) + publish surface', () => {
    for (const k of [
      'usePointSelection',
      'useSelectionOrigin',
      'useGroupEmphasis',
      'useSharedColorDomain',
      'setSelection',
      'setPointSelection',
      'clearSelection',
    ] as const) {
      expect(typeof defaultCoordinationHandle[k]).toBe('function')
    }
  })
})

describe('CoordinationHandle — publish routes through the Coordination store', () => {
  it('setSelection writes the ids AND tags the origin', () => {
    const ids = Uint32Array.from([3, 7, 11])
    defaultCoordinationHandle.setSelection('scatter-A', ids)
    const s = useCoordinationStore.getState()
    expect(s.pointSelection).toBe(ids)
    expect(s.selectionOrigin).toBe('scatter-A')
  })

  it('setSelection with an EMPTY selection carries no origin (matches the store rule)', () => {
    defaultCoordinationHandle.setSelection('scatter-A', Uint32Array.from([]))
    const s = useCoordinationStore.getState()
    expect(s.selectionOrigin).toBeNull()
  })

  it('setSelection(null) clears the selection + origin', () => {
    defaultCoordinationHandle.setSelection('scatter-A', Uint32Array.from([1]))
    defaultCoordinationHandle.setSelection('scatter-A', null)
    const s = useCoordinationStore.getState()
    expect(s.pointSelection).toBeNull()
    expect(s.selectionOrigin).toBeNull()
  })

  it('setPointSelection writes the ids with NO origin attribution', () => {
    const ids = Uint32Array.from([2, 4])
    defaultCoordinationHandle.setPointSelection(ids)
    const s = useCoordinationStore.getState()
    expect(s.pointSelection).toBe(ids)
    expect(s.selectionOrigin).toBeNull()
  })

  it('clearSelection clears both the selection and its origin', () => {
    defaultCoordinationHandle.setSelection('violin', Uint32Array.from([9]))
    defaultCoordinationHandle.clearSelection()
    const s = useCoordinationStore.getState()
    expect(s.pointSelection).toBeNull()
    expect(s.selectionOrigin).toBeNull()
  })
})
