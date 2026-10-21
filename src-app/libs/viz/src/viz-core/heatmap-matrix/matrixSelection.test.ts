import { describe, it, expect } from 'vitest'
import { columnSelectionMaskForLevel, columnRangeToPointIndices } from './matrixSelection'
import { identityPointIds } from '../coordination/selectionSync'

describe('columnSelectionMaskForLevel — per-level lit-column mask (downsample-OR)', () => {
  it('base level (level 0) is the identity: mask[j] = 1 iff j ∈ selection', () => {
    const sel = Uint32Array.from([0, 3, 4])
    const mask = columnSelectionMaskForLevel(sel, 6, 0, 6)
    expect(Array.from(mask)).toEqual([1, 0, 0, 1, 1, 0])
  })

  it('level 2: a level-column is lit iff ANY of its 4 base columns is selected', () => {
    // level 2 → step 4. level-col 0 covers base [0,4); level-col 1 covers base [4,8);
    // level-col 2 covers base [8,12). baseCols = 12, levelCols = 3.
    // select base col 5 (in level-col 1) and base col 9 (in level-col 2); level-col 0 unlit.
    const mask = columnSelectionMaskForLevel(Uint32Array.from([5, 9]), 12, 2, 3)
    expect(Array.from(mask)).toEqual([0, 1, 1])
  })

  it('level 2: multiple base cols under one level-col still light exactly that one column', () => {
    // base cols 0,1,2,3 all under level-col 0 → only level-col 0 lit.
    const mask = columnSelectionMaskForLevel(Uint32Array.from([0, 1, 2, 3]), 12, 2, 3)
    expect(Array.from(mask)).toEqual([1, 0, 0])
  })

  it('level 1: step 2 — base col c lights level-col floor(c/2)', () => {
    // baseCols 8 → levelCols 4. select base 0 (→lc0), 3 (→lc1), 6 (→lc3); lc2 unlit.
    const mask = columnSelectionMaskForLevel(Uint32Array.from([0, 3, 6]), 8, 1, 4)
    expect(Array.from(mask)).toEqual([1, 1, 0, 1])
  })

  it('empty / null selection → ALL-LIT sentinel (nothing dims)', () => {
    expect(Array.from(columnSelectionMaskForLevel(new Uint32Array(0), 6, 0, 6))).toEqual([
      1, 1, 1, 1, 1, 1,
    ])
    expect(Array.from(columnSelectionMaskForLevel(null, 4, 2, 1))).toEqual([1])
    expect(Array.from(columnSelectionMaskForLevel(undefined, 8, 1, 4))).toEqual([1, 1, 1, 1])
  })

  it('out-of-range indices (negative / >= baseCols) are ignored, not phantom-lit', () => {
    // -1 and 6,7 (>= baseCols 6) ignored; only base col 2 lights level-col 2 at base level.
    const mask = columnSelectionMaskForLevel(Uint32Array.from([2, 6, 7, 100]), 6, 0, 6)
    expect(Array.from(mask)).toEqual([0, 0, 1, 0, 0, 0])
  })

  it('a base col beyond the level width never writes past the mask (clamped)', () => {
    // levelCols deliberately smaller than baseCols/step would imply: no OOB write / crash.
    const mask = columnSelectionMaskForLevel(Uint32Array.from([0, 2, 4]), 6, 0, 3)
    expect(Array.from(mask)).toEqual([1, 0, 1]) // base col 4 → j=4 >= 3 → dropped
  })
})

describe('columnRangeToPointIndices — brushed [c0, c1) column span → dense point indices', () => {
  it('is half-open [c0, c1): (3, 6) → [3, 4, 5]', () => {
    expect(Array.from(columnRangeToPointIndices(3, 6))).toEqual([3, 4, 5])
  })

  it('empty range (c0 === c1) → empty', () => {
    expect(columnRangeToPointIndices(5, 5).length).toBe(0)
  })

  it('inverted range (c1 < c0) → empty (never a negative allocation)', () => {
    expect(columnRangeToPointIndices(6, 3).length).toBe(0)
  })

  it('clamps c0 up to 0 (a brush starting left of the matrix begins at column 0)', () => {
    expect(Array.from(columnRangeToPointIndices(-2, 3))).toEqual([0, 1, 2])
  })

  it('floors fractional bounds (screen→world unproject yields fractional columns)', () => {
    expect(Array.from(columnRangeToPointIndices(2.7, 5.9))).toEqual([2, 3, 4])
  })

  it('a base column index IS its dense point index (identity mapping)', () => {
    const idx = columnRangeToPointIndices(100, 104)
    expect(Array.from(idx)).toEqual([100, 101, 102, 103])
  })
})

// TEST-17 (ITEM-17 / "C1") — canonical point-id seam. With an OPTIONAL `pointIds` (row→id)
// map the two pure functions work across datasets with different point orders, WHILE the
// identity / no-`pointIds` path stays byte-identical to today.
describe('point-id seam — identity path is byte-identical (no behavior change)', () => {
  it('CONSUME: identityPointIds equals passing no pointIds at all', () => {
    const sel = Uint32Array.from([0, 3, 4])
    const withNone = columnSelectionMaskForLevel(sel, 6, 0, 6)
    const withIdentity = columnSelectionMaskForLevel(sel, 6, 0, 6, identityPointIds(6))
    expect(Array.from(withIdentity)).toEqual([1, 0, 0, 1, 1, 0])
    expect(Array.from(withIdentity)).toEqual(Array.from(withNone))
  })

  it('CONSUME: identity is byte-identical at an AGGREGATED level too (downsample-OR)', () => {
    const sel = Uint32Array.from([5, 9])
    const withNone = columnSelectionMaskForLevel(sel, 12, 2, 3)
    const withIdentity = columnSelectionMaskForLevel(sel, 12, 2, 3, identityPointIds(12))
    expect(Array.from(withIdentity)).toEqual([0, 1, 1])
    expect(Array.from(withIdentity)).toEqual(Array.from(withNone))
  })

  it('PRODUCE: identityPointIds equals passing no pointIds at all', () => {
    const withNone = columnRangeToPointIndices(3, 6)
    const withIdentity = columnRangeToPointIndices(3, 6, identityPointIds(6))
    expect(Array.from(withIdentity)).toEqual([3, 4, 5])
    expect(Array.from(withIdentity)).toEqual(Array.from(withNone))
  })
})

describe('point-id seam — NON-identity permutation round-trips PRODUCE → CONSUME', () => {
  // A view whose local base column `r` carries canonical id `pointIds[r]`. This is a genuine
  // permutation (not the identity), so an id-blind (array-index) path would light wrong columns.
  const pointIds = Uint32Array.from([3, 1, 0, 2]) // 4 base columns
  const N = pointIds.length

  it('PRODUCE maps brushed LOCAL columns → canonical ids', () => {
    // brush half-open [1, 3) → local columns 1, 2 → ids pointIds[1], pointIds[2] = [1, 0].
    const ids = columnRangeToPointIndices(1, 3, pointIds)
    expect(Array.from(ids)).toEqual([1, 0])
  })

  it('CONSUME resolves canonical ids → the SAME local base columns (base level)', () => {
    // consuming those ids in THIS view must light exactly local columns 1 and 2.
    const ids = columnRangeToPointIndices(1, 3, pointIds)
    const mask = columnSelectionMaskForLevel(ids, N, 0, N, pointIds)
    expect(Array.from(mask)).toEqual([0, 1, 1, 0])
  })

  it('full round-trip lights exactly the brushed local span, for every NON-empty span', () => {
    // Non-empty spans only: an empty brush (lo === hi) publishes an empty selection, which
    // CONSUME treats as the documented "no selection ⇒ all-lit" sentinel, not a lit span.
    for (let lo = 0; lo < N; lo++) {
      for (let hi = lo + 1; hi <= N; hi++) {
        const ids = columnRangeToPointIndices(lo, hi, pointIds)
        const mask = columnSelectionMaskForLevel(ids, N, 0, N, pointIds)
        const expected = Array.from({ length: N }, (_, c) => (c >= lo && c < hi ? 1 : 0))
        expect(Array.from(mask)).toEqual(expected)
      }
    }
  })

  it('CONSUME: a canonical id absent from THIS view lights nothing (cross-dataset isolation)', () => {
    // ids 3 (→ local col 0) and 99 (not in this view). Only local col 0 lights.
    const mask = columnSelectionMaskForLevel(Uint32Array.from([3, 99]), N, 0, N, pointIds)
    expect(Array.from(mask)).toEqual([1, 0, 0, 0])
  })

  it('CONSUME: id-mapped selection also downsample-ORs at an aggregated level', () => {
    // level 1, step 2: local col 0 → level-col 0, local col 2 → level-col 1. ids 3,0 map to
    // local cols 0,2 → level-cols 0,1 lit; level-col missing for local col 1/3 stays per-OR.
    const mask = columnSelectionMaskForLevel(Uint32Array.from([3, 0]), N, 1, 2, pointIds)
    // id 3 → local col 0 → floor(0/2)=0; id 0 → local col 2 → floor(2/2)=1.
    expect(Array.from(mask)).toEqual([1, 1])
  })
})
