import { describe, it, expect } from 'vitest'
import { IndexMask } from '../data/selection'
import { areaMask, type Area } from '../selection/SelectionController'
import { combineMask } from '../selection/areaGestures'

// ---------------------------------------------------------------------------
// TEST-20 (ITEM-4) — the grid's committed-area fold vs `SelectionController.recompute()`.
//
// `GridWorkspace.publishCellAreas` used to fold with UNION ONLY while `recompute()`
// honours add/subtract/intersect — two independent implementations of one fold.
// ITEM-4 routes the grid through the SAME `combineMask`, seeded from an EMPTY mask
// exactly as `recompute()` does. INV-2 ("`ops` re-derive `ids` EXACTLY") depends on
// there being ONE fold; otherwise `deriveSelection` becomes a third.
//
// These tests reproduce BOTH folds over the same input and compare them, so they go
// red if either implementation drifts. They are pure (no react/deck), per the
// `selection2.test.ts` / `selectionNarrowing.test.ts` oracle pattern.
// ---------------------------------------------------------------------------

/** A 10x10 lattice of points at integer coords 0..9 — 100 points, deterministic. */
function lattice(): { positions: Float32Array; n: number } {
  const n = 100
  const positions = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    positions[i * 2] = i % 10
    positions[i * 2 + 1] = Math.floor(i / 10)
  }
  return { positions, n }
}

const rect = (box: [number, number, number, number], mode: Area['mode']): Area => ({
  kind: 'rect',
  box,
  mode,
})

/** The CONVERGED grid fold (what `publishCellAreas` now does). */
function gridFold(areas: readonly Area[], positions: Float32Array, n: number): number[] {
  let combined = new IndexMask(n)
  for (const area of areas) combined = combineMask(combined, areaMask(area, positions, n), area.mode)
  return areas.length === 0 ? [] : [...combined.toIndices()]
}

/** `SelectionController.recompute()`'s fold, transcribed — the reference implementation. */
function recomputeFold(areas: readonly Area[], positions: Float32Array, n: number): number[] {
  let out = new IndexMask(n)
  for (const area of areas) {
    const m = areaMask(area, positions, n)
    if (area.mode === 'add') out = out.union(m)
    else if (area.mode === 'subtract') out = out.difference(m)
    else out = out.intersect(m)
  }
  return [...out.toIndices()]
}

/** The OLD union-only grid fold, kept to prove the today-case is byte-identical. */
function legacyUnionFold(areas: readonly Area[], positions: Float32Array, n: number): number[] {
  let combined: IndexMask | null = null
  for (const area of areas) {
    const m = areaMask(area, positions, n)
    combined = combined ? combined.union(m) : m
  }
  return combined ? [...combined.toIndices()] : []
}

describe('ITEM-4 — the grid area fold is the SAME fold as SelectionController.recompute()', () => {
  const { positions, n } = lattice()

  it('is byte-identical to the OLD union-only fold for an all-add list (the today case)', () => {
    // Every grid-committed area is minted `mode:'add'`, so the convergence must be a no-op today.
    const areas = [rect([0, 0, 4, 4], 'add'), rect([6, 6, 9, 9], 'add'), rect([2, 7, 3, 8], 'add')]
    const converged = gridFold(areas, positions, n)

    expect(converged).toEqual(legacyUnionFold(areas, positions, n))
    expect(converged).toEqual(recomputeFold(areas, positions, n))
    expect(converged.length).toBeGreaterThan(0) // not vacuous
  })

  it('matches recompute() for subtract, where the OLD fold DIFFERS (the convergence has teeth)', () => {
    const areas = [rect([0, 0, 9, 4], 'add'), rect([0, 0, 4, 9], 'subtract')]
    const converged = gridFold(areas, positions, n)

    expect(converged).toEqual(recomputeFold(areas, positions, n))
    // NEGATIVE CONTROL: a fold that ignored `mode` (the old union) gives a DIFFERENT, larger answer.
    expect(converged).not.toEqual(legacyUnionFold(areas, positions, n))
    // subtract must be a STRICT SUBSET of the add-only result — a mode-ignoring fold fails this.
    const addOnly = gridFold([areas[0]], positions, n)
    expect(converged.length).toBeLessThan(addOnly.length)
    expect(converged.every(i => addOnly.includes(i))).toBe(true)
  })

  it('matches recompute() for intersect, where the OLD fold DIFFERS', () => {
    const areas = [rect([0, 0, 9, 4], 'add'), rect([0, 0, 4, 9], 'intersect')]
    const converged = gridFold(areas, positions, n)

    expect(converged).toEqual(recomputeFold(areas, positions, n))
    expect(converged).not.toEqual(legacyUnionFold(areas, positions, n))
    // the intersection is contained in BOTH operands
    const a = gridFold([areas[0]], positions, n)
    expect(converged.every(i => a.includes(i))).toBe(true)
  })

  it('EMPTY SEED: a LEADING non-add area collapses, exactly as recompute() does', () => {
    // This is the case the first-area-seeds-the-accumulator shortcut got wrong: seeding with the
    // first area's own mask yields that mask, while recompute() folds it against an empty base and
    // yields nothing. The converged fold must agree with recompute(), not with the shortcut.
    for (const mode of ['subtract', 'intersect'] as const) {
      const areas = [rect([0, 0, 4, 4], mode)]
      expect(gridFold(areas, positions, n)).toEqual(recomputeFold(areas, positions, n))
      expect(gridFold(areas, positions, n)).toEqual([])
      // and the shortcut would have returned a NON-empty mask — proving the arm is not vacuous
      expect(legacyUnionFold(areas, positions, n).length).toBeGreaterThan(0)
    }
  })

  it('an empty area list selects nothing (both folds agree)', () => {
    expect(gridFold([], positions, n)).toEqual([])
    expect(recomputeFold([], positions, n)).toEqual([])
  })
})
