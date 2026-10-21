// Coordination.store.test.ts — TEST-13 (ITEM-14 / ITEM-16): the point selection is SHARDED BY
// IDENTITY SPACE. A selection in one space must be invisible from another space, while the legacy
// single-space API (`pointSelection`/`setSelection`/`clearSelection`) stays byte-identical by
// operating on `DEFAULT_SELECTION_SPACE`. These tests lock both halves of that contract.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  type CoordinationStore,
  createCoordinationStore,
  DEFAULT_SELECTION_SPACE,
} from './Coordination.store'

describe('Coordination store — per-identity-space selection (ITEM-14 / ITEM-16)', () => {
  let store: CoordinationStore
  beforeEach(() => {
    // A fresh, isolated store per test (VIZ_ISOLATION factory) so cases can't bleed into each other.
    store = createCoordinationStore()
  })

  it('a selection in space A is invisible when reading space B', () => {
    const selA = new Uint32Array([1, 2, 3])
    store.getState().setSelectionInSpace('spaceA', 'cell-A', selA)

    // Space A sees its own selection…
    expect(store.getState().pointSelectionInSpace('spaceA')).toBe(selA)
    expect(store.getState().selectionOriginInSpace('spaceA')).toBe('cell-A')
    // …but space B (never written) is empty.
    expect(store.getState().pointSelectionInSpace('spaceB')).toBeNull()
    expect(store.getState().selectionOriginInSpace('spaceB')).toBeNull()

    // Writing space B must not disturb space A.
    const selB = new Uint32Array([9])
    store.getState().setSelectionInSpace('spaceB', 'cell-B', selB)
    expect(store.getState().pointSelectionInSpace('spaceA')).toBe(selA)
    expect(store.getState().pointSelectionInSpace('spaceB')).toBe(selB)
  })

  it('a NON-default space never touches the legacy top-level fields', () => {
    store.getState().setSelectionInSpace('spaceA', 'cell-A', new Uint32Array([1, 2]))
    // The single-space surface stays empty — space A lives only in the sharded map.
    expect(store.getState().pointSelection).toBeNull()
    expect(store.getState().selectionOrigin).toBeNull()
  })

  it('a default-space read equals the prior global selection (byte-identical mirror)', () => {
    const sel = new Uint32Array([4, 5, 6])
    // The LEGACY API writes the default space…
    store.getState().setSelection('cell-A', sel)
    // …and the per-space read of DEFAULT surfaces the exact same array + origin.
    expect(store.getState().pointSelectionInSpace(DEFAULT_SELECTION_SPACE)).toBe(sel)
    expect(store.getState().selectionOriginInSpace(DEFAULT_SELECTION_SPACE)).toBe('cell-A')
    // The top-level derived view matches (same reference — no copy).
    expect(store.getState().pointSelection).toBe(sel)
    expect(store.getState().selectionBySpace[DEFAULT_SELECTION_SPACE]?.ids).toBe(sel)
  })

  it('writing the DEFAULT space updates the legacy top-level fields in lockstep', () => {
    const sel = new Uint32Array([7, 8])
    store.getState().setSelectionInSpace(DEFAULT_SELECTION_SPACE, 'cell-Z', sel)
    expect(store.getState().pointSelection).toBe(sel)
    expect(store.getState().selectionOrigin).toBe('cell-Z')
  })

  it('clearing a space nulls its origin (and its ids)', () => {
    store.getState().setSelectionInSpace('spaceA', 'cell-A', new Uint32Array([1]))
    store.getState().clearSelectionInSpace('spaceA')
    expect(store.getState().pointSelectionInSpace('spaceA')).toBeNull()
    expect(store.getState().selectionOriginInSpace('spaceA')).toBeNull()
    expect(store.getState().selectionBySpace.spaceA).toBeUndefined()
  })

  it('setting null / empty ids clears the space and nulls its origin', () => {
    store.getState().setSelectionInSpace('spaceA', 'cell-A', new Uint32Array([1]))
    store.getState().setSelectionInSpace('spaceA', 'cell-A', new Uint32Array(0))
    expect(store.getState().pointSelectionInSpace('spaceA')).toBeNull()
    expect(store.getState().selectionOriginInSpace('spaceA')).toBeNull()

    store.getState().setSelectionInSpace('spaceB', 'cell-B', new Uint32Array([2]))
    store.getState().setSelectionInSpace('spaceB', 'cell-B', null)
    expect(store.getState().pointSelectionInSpace('spaceB')).toBeNull()
    expect(store.getState().selectionOriginInSpace('spaceB')).toBeNull()
  })

  it('clearing the DEFAULT space mirrors back to the legacy fields', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1, 2]))
    store.getState().clearSelectionInSpace(DEFAULT_SELECTION_SPACE)
    expect(store.getState().pointSelection).toBeNull()
    expect(store.getState().selectionOrigin).toBeNull()
    expect(store.getState().selectionBySpace[DEFAULT_SELECTION_SPACE]).toBeUndefined()
  })

  it('legacy clearSelection empties the default space entry', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1]))
    expect(store.getState().selectionBySpace[DEFAULT_SELECTION_SPACE]).toBeDefined()
    store.getState().clearSelection()
    expect(store.getState().selectionBySpace[DEFAULT_SELECTION_SPACE]).toBeUndefined()
    // A non-default space read of an all-empty store is still null.
    expect(store.getState().pointSelectionInSpace('spaceA')).toBeNull()
  })
})

// ITEM-21 / DEC-16: the MULTI-DATASET (per-identity-space) selection must survive serialize→hydrate.
// Today only the DEFAULT space round-trips (the `selection` field); a non-default space (a second
// dataset's canonical-id selection) is LOST on save/restore. These lock the new `spaces` round-trip and
// the byte-identical single-dataset guarantee.
describe('Coordination store — per-space selection serialize/hydrate round-trip (ITEM-21)', () => {
  let store: CoordinationStore
  beforeEach(() => {
    store = createCoordinationStore()
  })

  it('a selection in a NON-DEFAULT space serializes into `spaces` and hydrates back', () => {
    store.getState().setSelectionInSpace('datasetB', 'cell-B', new Uint32Array([10, 20, 30]))
    const snap = store.getState().serialize()

    // The non-default space is captured under `spaces` (projected to a plain number[] + origin).
    expect(snap.spaces).toEqual({ datasetB: { ids: [10, 20, 30], origin: 'cell-B' } })
    // The default `selection` stays empty — the non-default space never leaks into it.
    expect(snap.selection).toEqual({ ids: [], origin: null })

    // Mutate live state, then hydrate a FRESH store from the snapshot → the space comes back.
    const fresh = createCoordinationStore()
    fresh.getState().hydrate(snap)
    expect(Array.from(fresh.getState().pointSelectionInSpace('datasetB') ?? [])).toEqual([10, 20, 30])
    expect(fresh.getState().selectionOriginInSpace('datasetB')).toBe('cell-B')
    // Re-inflated as a Uint32Array (data-independent canonical ids).
    expect(fresh.getState().selectionBySpace.datasetB?.ids).toBeInstanceOf(Uint32Array)
  })

  it('DEFAULT + a non-default space BOTH round-trip (multi-dataset survives)', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1, 2])) // default space
    store.getState().setSelectionInSpace('datasetB', 'cell-B', new Uint32Array([7])) // second dataset
    const snap = store.getState().serialize()

    expect(snap.selection).toEqual({ ids: [1, 2], origin: 'cell-A' })
    expect(snap.spaces).toEqual({ datasetB: { ids: [7], origin: 'cell-B' } })

    const fresh = createCoordinationStore()
    fresh.getState().hydrate(snap)
    // default (legacy) surface intact…
    expect(Array.from(fresh.getState().pointSelection ?? [])).toEqual([1, 2])
    expect(fresh.getState().selectionOrigin).toBe('cell-A')
    // …AND the second dataset's selection survived.
    expect(Array.from(fresh.getState().pointSelectionInSpace('datasetB') ?? [])).toEqual([7])
  })

  it('a SINGLE-dataset serialize is byte-identical to the pre-ITEM-21 shape (no `spaces` key)', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1, 2, 3]))
    const snap = store.getState().serialize()
    // `spaces` is OMITTED entirely (not present, not empty) → the JSON shape is unchanged.
    expect('spaces' in snap).toBe(false)
    expect(snap).toEqual({
      viewStates: {},
      selection: { ids: [1, 2, 3], origin: 'cell-A' },
      gridLinked: false,
      colorScales: {},
      colorBySelection: null,
    })
    // Exact key order preserved (byte-identical JSON).
    expect(Object.keys(snap)).toEqual([
      'viewStates',
      'selection',
      'gridLinked',
      'colorScales',
      'colorBySelection',
    ])
  })

  it('an EMPTY store serialize omits `spaces` (byte-identical empty snapshot)', () => {
    const snap = store.getState().serialize()
    expect('spaces' in snap).toBe(false)
    expect(snap.selection).toEqual({ ids: [], origin: null })
  })

  it('hydrate REPLACES stale non-default spaces (a slice without them clears them)', () => {
    // Seed a live non-default space, then hydrate a snapshot that has none.
    store.getState().setSelectionInSpace('datasetB', 'cell-B', new Uint32Array([5]))
    store.getState().hydrate({
      viewStates: {},
      selection: { ids: [], origin: null },
      gridLinked: false,
      colorScales: {},
      colorBySelection: null,
    })
    expect(store.getState().pointSelectionInSpace('datasetB')).toBeNull()
    expect(store.getState().selectionBySpace).toEqual({})
  })

  it('hydrate detaches the snapshot (post-capture mutation does not retro-edit it)', () => {
    store.getState().setSelectionInSpace('datasetB', 'cell-B', new Uint32Array([1, 2]))
    const snap = store.getState().serialize()
    // Mutating the live store after capture must not change the captured `spaces`.
    store.getState().setSelectionInSpace('datasetB', 'cell-B', new Uint32Array([9]))
    expect(snap.spaces).toEqual({ datasetB: { ids: [1, 2], origin: 'cell-B' } })
  })

  it('a `spaces` entry naming DEFAULT is ignored on hydrate (default owned by `selection`)', () => {
    store.getState().hydrate({
      viewStates: {},
      selection: { ids: [1], origin: 'from-selection' },
      gridLinked: false,
      colorScales: {},
      colorBySelection: null,
      // A malformed slice that tries to override the default via `spaces` must not win.
      spaces: { [DEFAULT_SELECTION_SPACE]: { ids: [99], origin: 'from-spaces' } },
    })
    expect(Array.from(store.getState().pointSelection ?? [])).toEqual([1])
    expect(store.getState().selectionOrigin).toBe('from-selection')
    expect(Array.from(store.getState().selectionBySpace[DEFAULT_SELECTION_SPACE]?.ids ?? [])).toEqual([1])
  })
})

describe('Coordination store — multi-plot per-origin UNION (accumulate)', () => {
  let store: CoordinationStore
  beforeEach(() => {
    store = createCoordinationStore()
  })

  it('accumulate=false REPLACES (single-selection, byte-identical legacy behavior)', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1, 2, 3]))
    store.getState().setSelection('cell-B', new Uint32Array([7, 8]))
    // A new origin in replace mode clears the previous one → only cell-B survives.
    expect(Array.from(store.getState().pointSelection ?? [])).toEqual([7, 8])
    expect(store.getState().selectionOrigin).toBe('cell-B')
  })

  it('accumulate=true UNIONS distinct origins (combined highlight across plots)', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1, 2, 3]), true)
    store.getState().setSelection('cell-B', new Uint32Array([3, 4, 5]), true)
    // Union of both plots' selections, sorted + de-duplicated (3 appears once).
    expect(Array.from(store.getState().pointSelection ?? [])).toEqual([1, 2, 3, 4, 5])
  })

  it('accumulate=true with an EMPTY selection drops just that origin (others remain)', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1, 2]), true)
    store.getState().setSelection('cell-B', new Uint32Array([9]), true)
    store.getState().setSelection('cell-A', new Uint32Array([]), true)
    expect(Array.from(store.getState().pointSelection ?? [])).toEqual([9])
    expect(store.getState().selectionOrigin).toBe('cell-B')
  })

  it('a REPLACE write collapses an accumulated union back to one origin', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1, 2]), true)
    store.getState().setSelection('cell-B', new Uint32Array([9]), true)
    store.getState().setSelection('cell-C', new Uint32Array([5]), false) // single mode
    expect(Array.from(store.getState().pointSelection ?? [])).toEqual([5])
    expect(store.getState().selectionOrigin).toBe('cell-C')
  })

  it('clearSelection empties the per-origin union', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1]), true)
    store.getState().setSelection('cell-B', new Uint32Array([2]), true)
    store.getState().clearSelection()
    expect(store.getState().pointSelection).toBeNull()
    expect(store.getState().selectionOrigin).toBeNull()
  })
})

describe('Coordination store — exclusive-selection reconciliation (cross-cell lifecycle parity)', () => {
  let store: CoordinationStore
  beforeEach(() => {
    store = createCoordinationStore()
  })

  it('a SINGLE-mode selection names the exclusive owner + bumps the epoch', () => {
    const e0 = store.getState().exclusiveSelectionEpoch
    store.getState().setSelection('cell-A', new Uint32Array([1, 2]), false)
    expect(store.getState().exclusiveSelectionOrigin).toBe('cell-A')
    expect(store.getState().exclusiveSelectionEpoch).toBe(e0 + 1)
    // A different single owner replaces + bumps again.
    store.getState().setSelection('violin-1', new Uint32Array([9]), false)
    expect(store.getState().exclusiveSelectionOrigin).toBe('violin-1')
    expect(store.getState().exclusiveSelectionEpoch).toBe(e0 + 2)
  })

  it('MULTI-mode (accumulate) does NOT bump the exclusive epoch', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1]), false)
    const e1 = store.getState().exclusiveSelectionEpoch
    store.getState().setSelection('cell-B', new Uint32Array([2]), true)
    expect(store.getState().exclusiveSelectionEpoch).toBe(e1) // unchanged — additive
  })

  it('clearSelection sets a null owner + bumps the epoch', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1]), false)
    const e1 = store.getState().exclusiveSelectionEpoch
    store.getState().clearSelection()
    expect(store.getState().exclusiveSelectionOrigin).toBeNull()
    expect(store.getState().exclusiveSelectionEpoch).toBe(e1 + 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CONV-1 (fix round 2) — the M6 "an empty setSelection clears provenance" guard must be
// SPACE-AWARE. It originally tested only `pointSelection` (the DEFAULT space), so a default-space
// surface publishing empty destroyed the recipe of a live NON-default-space selection, and
// `getOption({selection:'ops-only'})` then emitted neither ids/spaces nor ops — the multi-dataset
// selection was silently lost on save. The correct predicate is the one `clearSelectionInSpace`
// already used: drop the recipe only when NO space holds a selection.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('Coordination store — provenance lifecycle is space-aware (CONV-1)', () => {
  let store: CoordinationStore
  const OPS = [
    { tool: 'rect', op: 'add', pane: 'cell-B', space: 'spaceB', region: [0, 0, 10, 10] },
  ] as never

  beforeEach(() => {
    store = createCoordinationStore()
  })

  it('an empty DEFAULT-space setSelection KEEPS the recipe while another space is still live', () => {
    store.getState().setSelectionInSpace('spaceB', 'cell-B', new Uint32Array([1, 2, 3]))
    store.getState().setSelectionProvenance({ ops: OPS })

    // A default-space surface publishes empty (RasterUnderlayScatterView / parallelCoordinates /
    // VizController.dispatch all do this) — spaceB's ids stay live, so the recipe must survive.
    store.getState().setSelection('cell-A', new Uint32Array(0), false)

    expect(store.getState().pointSelectionInSpace('spaceB')?.length).toBe(3) // still live
    expect(store.getState().selectionProvenance).not.toBeNull() // ← RED before the fix
  })

  it('an empty setSelection DOES clear the recipe once no space holds a selection', () => {
    store.getState().setSelection('cell-A', new Uint32Array([1, 2]), false)
    store.getState().setSelectionProvenance({ ops: OPS })
    store.getState().setSelection('cell-A', new Uint32Array(0), false)

    expect(store.getState().selectionProvenance).toBeNull() // M6's original guarantee, preserved
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CONV-8 (fix round 3) — the SAME default-space-only class, third recurrence, at a line fix
// round 2's own sweep certified as clean ("`clearSelection` is an unconditional full clear —
// correct"). It is not a full clear: it resets `selectionByOrigin`/`pointSelection` and calls
// `syncDefaultSelectionSpace`, which only DELETES THE DEFAULT ENTRY — every non-default
// `selectionBySpace` entry survives. `clearGridSelection` (GridWorkspace) proves it by having to
// call `clearSelection()` AND then loop `clearSelectionInSpace` over every non-default space.
//
// Reachable on the DEFAULT gesture: `selMulti` defaults false, and a single-mode click on empty
// space calls `coordinationRef.current.clearSelection()` with NO space loop. Also via
// `candlestick.tsx` and the public `coordinationHandle.clearSelection()`.
//
// The sweep that READ the code has now failed three times on this class (liveIsEmpty → :316 →
// :344). This block therefore drives EVERY clear/write path by EXECUTION with a live
// non-default space, so a fourth site cannot be certified clean by inspection.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('Coordination store — provenance lifecycle: every clear/write path, space-aware (CONV-8)', () => {
  let store: CoordinationStore
  const OPS = [
    { tool: 'rect', op: 'add', pane: 'cell-B', space: 'spaceB', region: [0, 0, 10, 10] },
  ] as never

  /** Arrange: spaceB holds a LIVE selection and a recipe explains it. */
  const liveNonDefault = () => {
    store = createCoordinationStore()
    store.getState().setSelectionInSpace('spaceB', 'cell-B', new Uint32Array([1, 2, 3]))
    store.getState().setSelectionProvenance({ ops: OPS })
  }

  it('clearSelection() KEEPS the recipe while a non-default space is still live', () => {
    liveNonDefault()
    store.getState().clearSelection()

    // spaceB survives `clearSelection` (it only syncs the DEFAULT entry) …
    expect(store.getState().pointSelectionInSpace('spaceB')?.length).toBe(3)
    // … so the recipe explaining those live ids must survive with them.
    expect(store.getState().selectionProvenance).not.toBeNull()
  })

  it('clearSelection() DOES clear the recipe once no space holds a selection', () => {
    store = createCoordinationStore()
    store.getState().setSelection('cell-A', new Uint32Array([1, 2]), false)
    store.getState().setSelectionProvenance({ ops: OPS })
    store.getState().clearSelection()

    expect(store.getState().selectionProvenance).toBeNull()
  })

  it('clearSelectionInSpace(last live space) clears the recipe; an earlier one does not', () => {
    liveNonDefault()
    store.getState().setSelectionInSpace('spaceC', 'cell-C', new Uint32Array([7]))

    store.getState().clearSelectionInSpace('spaceC')
    expect(store.getState().selectionProvenance).not.toBeNull() // spaceB still live

    store.getState().clearSelectionInSpace('spaceB')
    expect(store.getState().selectionProvenance).toBeNull() // nothing left to explain
  })

  it('setSelectionInSpace(empty) on the last live space clears the recipe', () => {
    liveNonDefault()
    store.getState().setSelectionInSpace('spaceB', 'cell-B', null)

    expect(store.getState().selectionProvenance).toBeNull()
  })

  it('the grid-wide clear (clearSelection + per-space loop) ends with no recipe', () => {
    liveNonDefault()
    // Mirrors GridWorkspace.clearGridSelection: the default clear, then every non-default space.
    store.getState().clearSelection()
    for (const spaceId of Object.keys(store.getState().selectionBySpace)) {
      store.getState().clearSelectionInSpace(spaceId)
    }

    expect(store.getState().selectionProvenance).toBeNull()
  })

  // CONV-13 (fix round 4) — the FIFTH site, and the one that proved a shared predicate is not
  // enough: `setPointSelection` simply never called it. It sits on the exported public
  // `CoordinationHandle` (`coordinationHandle.ts:112`, re-exported from both package barrels) and
  // in the chart-registry View context, with NO in-repo production caller — so nothing local ever
  // exercised it and the hole survived three sweeps. Now routed through `selectionMutation`.
  it('setPointSelection(null) clears the recipe once no space holds a selection', () => {
    store = createCoordinationStore()
    store.getState().setSelection('cell-A', new Uint32Array([1, 2]), false)
    store.getState().setSelectionProvenance({ ops: OPS })

    store.getState().setPointSelection(null)

    expect(store.getState().pointSelection).toBeNull()
    expect(Object.keys(store.getState().selectionBySpace)).toEqual([])
    // The recipe described a set that no longer exists — DEC-5's lie. It must be gone.
    expect(store.getState().selectionProvenance).toBeNull()
  })

  it('setPointSelection(empty array) is a clear too, and clears the recipe', () => {
    store = createCoordinationStore()
    store.getState().setSelection('cell-A', new Uint32Array([1, 2]), false)
    store.getState().setSelectionProvenance({ ops: OPS })

    store.getState().setPointSelection(new Uint32Array([]))

    expect(store.getState().selectionProvenance).toBeNull()
  })

  it('setPointSelection(null) KEEPS the recipe while a non-default space is still live', () => {
    liveNonDefault()
    store.getState().setPointSelection(null)

    // spaceB is untouched by an origin-less default-space write …
    expect(store.getState().pointSelectionInSpace('spaceB')?.length).toBe(3)
    // … so the ops still explaining it must survive (DEC-2: one op list spans several spaces).
    expect(store.getState().selectionProvenance).not.toBeNull()
  })
})
