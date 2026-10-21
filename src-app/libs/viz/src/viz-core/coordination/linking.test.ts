// linking.test.ts — L0 unit tests for image↔data linking SPACE ROUTING (ITEM-13 / DEC-F).
//
// The image↔data link routes through the shared `Coordination.store` selection channel — no new
// bus. The correctness property this pins down is IDENTITY-SPACE ISOLATION: a selection published
// into one datasource's identity space must surface ONLY on a view reading that same space, and
// NEVER on a view reading another space (so a selection in dataset A never highlights dataset B).
// The consume leg then maps the shared CANONICAL ids → a view's own local rows via the pure
// `buildIdToRow` + `highlightMaskForIds` seam, lighting exactly the selected ids. This is the pure,
// framework-agnostic core the store `*InSpace` methods + `RasterUnderlayScatterView`'s consume path
// build on; the full bidirectional (region→scatter + scatter→tissue) e2e is the gallery's job.

import { describe, expect, it } from 'vitest'

import {
  createCoordinationStore,
  DEFAULT_SELECTION_SPACE,
} from '../../adapter/Coordination.store'
import { buildIdToRow, highlightMaskForIds, identityPointIds } from './selectionSync'

const SPACE_A = 'dataset-A'
const SPACE_B = 'dataset-B'

describe('ITEM-13 identity-space routing (Coordination store)', () => {
  it('a selection in space A is visible only to a reader of space A, not space B', () => {
    const store = createCoordinationStore()
    const idsA = Uint32Array.of(1, 3, 5)
    store.getState().setSelectionInSpace(SPACE_A, 'scatter-A', idsA)

    // Space A holds the selection + its origin…
    expect(store.getState().pointSelectionInSpace(SPACE_A)).toEqual(idsA)
    expect(store.getState().selectionOriginInSpace(SPACE_A)).toBe('scatter-A')
    // …space B sees NOTHING (identity-space isolation).
    expect(store.getState().pointSelectionInSpace(SPACE_B)).toBeNull()
    expect(store.getState().selectionOriginInSpace(SPACE_B)).toBeNull()
    // …and a NON-default space write does not leak into the legacy top-level selection.
    expect(store.getState().pointSelection).toBeNull()
  })

  it('a space-A consumer lights exactly the selected canonical ids; a space-B consumer lights none', () => {
    const store = createCoordinationStore()
    const N = 6
    // A tissue view over the SAME dataset uses identity ids (pointIds[i] = i ⇒ id == local row).
    const idToRow = buildIdToRow(identityPointIds(N))
    store.getState().setSelectionInSpace(SPACE_A, 'scatter-A', Uint32Array.of(1, 4))

    // The consumer READING SPACE A lights exactly rows 1 and 4 — no more, no less.
    const selA = store.getState().pointSelectionInSpace(SPACE_A)
    const maskA = selA ? highlightMaskForIds(selA, idToRow, N) : new Uint8Array(N)
    expect(Array.from(maskA)).toEqual([0, 1, 0, 0, 1, 0])

    // The SAME consumer wired to SPACE B sees no selection → lights nothing (isolation).
    const selB = store.getState().pointSelectionInSpace(SPACE_B)
    const maskB = selB ? highlightMaskForIds(selB, idToRow, N) : new Uint8Array(N)
    expect(Array.from(maskB)).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('maps canonical ids to a consuming view\'s OWN local rows (cross-dataset id space)', () => {
    const store = createCoordinationStore()
    // Canonical ids selected by the producer.
    store.getState().setSelectionInSpace(SPACE_A, 'src', Uint32Array.of(10, 20))
    // A consuming view whose local rows carry those canonical ids in a DIFFERENT order.
    const viewPointIds = Uint32Array.of(20, 99, 10) // row0→id20, row1→id99, row2→id10
    const idToRow = buildIdToRow(viewPointIds)

    const sel = store.getState().pointSelectionInSpace(SPACE_A)!
    const mask = highlightMaskForIds(sel, idToRow, viewPointIds.length)
    // Rows carrying id20 (row0) and id10 (row2) light; the id99 row (row1) stays dark.
    expect(Array.from(mask)).toEqual([1, 0, 1])
  })

  it('clearSelectionInSpace clears ONE space and leaves the others untouched', () => {
    const store = createCoordinationStore()
    store.getState().setSelectionInSpace(SPACE_A, 'a', Uint32Array.of(1))
    store.getState().setSelectionInSpace(SPACE_B, 'b', Uint32Array.of(2))

    store.getState().clearSelectionInSpace(SPACE_A)
    expect(store.getState().pointSelectionInSpace(SPACE_A)).toBeNull()
    expect(store.getState().selectionOriginInSpace(SPACE_A)).toBeNull()
    // Space B is untouched by clearing A.
    expect(store.getState().pointSelectionInSpace(SPACE_B)).toEqual(Uint32Array.of(2))
  })

  it('the DEFAULT space stays in lockstep with the legacy top-level selection', () => {
    const store = createCoordinationStore()
    store.getState().setSelectionInSpace(DEFAULT_SELECTION_SPACE, 'd', Uint32Array.of(3, 4))
    // Writing the default space mirrors the byte-identical legacy single-space surface.
    expect(store.getState().pointSelection).toEqual(Uint32Array.of(3, 4))
    expect(store.getState().pointSelectionInSpace(DEFAULT_SELECTION_SPACE)).toEqual(
      Uint32Array.of(3, 4),
    )
    // …and a read of a foreign space still isolates.
    expect(store.getState().pointSelectionInSpace(SPACE_A)).toBeNull()
  })
})
