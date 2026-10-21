// rasterUnderlaySelection.test.ts — correctness proof for the raster-underlay region
// lasso's PRODUCE mapping (TEST-18 / multi-source seam). The lasso resolves LOCAL point
// rows; `regionSelectionIds` turns those into the CANONICAL point ids published into the
// Coordination store. Identity / absent `pointIds` must be byte-identical to the old
// index-based publish (index == canonical id); a non-identity `pointIds` must publish the
// mapped ids. Pure — no React, no deck.gl, no store.

import { describe, it, expect } from 'vitest'
import { regionSelectionIds } from './RasterUnderlayScatterView'
import { identityPointIds } from '../coordination/selectionSync'

describe('regionSelectionIds (region lasso PRODUCE direction)', () => {
  it('absent pointIds ⇒ identity: returns the SAME indices array unchanged', () => {
    const indices = new Uint32Array([2, 0, 3])
    const out = regionSelectionIds(indices)
    // No remap, no copy — the single-source path is byte-identical to publishing indices.
    expect(out).toBe(indices)
    expect(Array.from(out)).toEqual([2, 0, 3])
  })

  it('explicit identity pointIds ⇒ output contents unchanged (index == canonical id)', () => {
    const indices = new Uint32Array([2, 0, 3])
    const out = regionSelectionIds(indices, identityPointIds(4))
    expect(Array.from(out)).toEqual([2, 0, 3])
  })

  it('non-identity pointIds ⇒ publishes the MAPPED canonical ids', () => {
    // Local row → canonical id: row 0→10, 1→11, 2→12, 3→13 (a shifted/foreign id space).
    const pointIds = new Uint32Array([10, 11, 12, 13])
    const indices = new Uint32Array([2, 0, 3])
    const out = regionSelectionIds(indices, pointIds)
    expect(Array.from(out)).toEqual([12, 10, 13])
  })

  it('permuted pointIds ⇒ each local row maps through its canonical id', () => {
    // A subset/reorder view: local rows carry canonical ids [3, 1, 4, 0].
    const pointIds = new Uint32Array([3, 1, 4, 0])
    const indices = new Uint32Array([0, 2, 3])
    const out = regionSelectionIds(indices, pointIds)
    expect(Array.from(out)).toEqual([3, 4, 0])
  })

  it('preserves length (so the caller empty-⇒-clear decision is unaffected)', () => {
    const pointIds = new Uint32Array([10, 11, 12, 13])
    const empty = new Uint32Array([])
    expect(regionSelectionIds(empty, pointIds).length).toBe(0)
    expect(regionSelectionIds(empty).length).toBe(0)
    const three = new Uint32Array([0, 1, 2])
    expect(regionSelectionIds(three, pointIds).length).toBe(3)
  })
})
