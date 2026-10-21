// selectionSync.test.ts — L0 unit tests for cross-plot selection sync (DEC-25 /
// ITEM-25): the pure mapping helpers (point selection → per-point highlight buffer +
// covered group codes + highlighted heatmap rows) + the Coordination store's selection
// slice (origin-tagged fan-out). Runs in the node vitest pass.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  applyMarkOpacity,
  buildGroupIndex,
  buildIdToRow,
  DIM_OPACITY,
  groupEmphasis,
  groupEmphasisByIds,
  hasAnySelection,
  highlightMaskForGroupSelection,
  highlightMaskForIds,
  highlightMaskForPoints,
  highlightedRowPositions,
  identityPointIds,
  isDimmed,
  mapRowsToIds,
  markOpacity,
  NO_ROW,
  resolveSelectionGroupCodes,
  selectedGroupCodes,
  selectedGroupCodesByIds,
} from './selectionSync'
import { useCoordinationStore } from '../../adapter/Coordination.store'

// ---------------------------------------------------------------------------
// hasAnySelection
// ---------------------------------------------------------------------------

describe('hasAnySelection', () => {
  it('is false for null / undefined / empty', () => {
    expect(hasAnySelection(null)).toBe(false)
    expect(hasAnySelection(undefined)).toBe(false)
    expect(hasAnySelection(new Uint32Array(0))).toBe(false)
  })

  it('is true for a non-empty selection', () => {
    expect(hasAnySelection(new Uint32Array([3]))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// selectedGroupCodes — scatter point-selection → which groups light up
// ---------------------------------------------------------------------------

describe('selectedGroupCodes', () => {
  // points:        0  1  2  3  4  5
  const codes = new Uint16Array([0, 1, 0, 2, 2, 1])

  it('maps a known selection to the exact covered group codes', () => {
    // select points 0 (grp 0), 3 (grp 2), 5 (grp 1) → {0, 2, 1}
    const got = selectedGroupCodes(new Uint32Array([0, 3, 5]), codes)
    expect(got).toEqual(new Set([0, 2, 1]))
  })

  it('collapses duplicate group memberships to a set', () => {
    // points 0 and 2 are both group 0 → a single code
    const got = selectedGroupCodes(new Uint32Array([0, 2]), codes)
    expect(got).toEqual(new Set([0]))
  })

  it('empty selection → empty set (no group lights up)', () => {
    expect(selectedGroupCodes(new Uint32Array(0), codes).size).toBe(0)
  })

  it('ignores out-of-range indices (a selection from a larger dataset)', () => {
    // 99 is past the end of `codes` → skipped, never a phantom code / crash
    const got = selectedGroupCodes(new Uint32Array([1, 99]), codes)
    expect(got).toEqual(new Set([1]))
  })

  it('accepts a Uint32Array codes column too', () => {
    const wide = new Uint32Array([5, 6, 7])
    expect(selectedGroupCodes(new Uint32Array([0, 2]), wide)).toEqual(new Set([5, 7]))
  })
})

// ---------------------------------------------------------------------------
// groupEmphasis — point-selection → which GROUP MARKS light up (box/violin/bar/dot)
// ---------------------------------------------------------------------------

describe('groupEmphasis', () => {
  // points:        0  1  2  3  4  5
  const codes = new Uint16Array([0, 1, 0, 2, 2, 1])

  it('empty / null selection is inactive with no covered codes', () => {
    expect(groupEmphasis(null, codes)).toEqual({ selectedCodes: new Set(), active: false })
    expect(groupEmphasis(new Uint32Array(0), codes)).toEqual({
      selectedCodes: new Set(),
      active: false,
    })
  })

  it('active selection covers exactly the selected points’ group codes', () => {
    // select points in groups {1, 3-index→2} … points 1 (grp1) + 3 (grp2) → {1,2}
    const got = groupEmphasis(new Uint32Array([1, 3]), codes)
    expect(got.active).toBe(true)
    expect(got.selectedCodes).toEqual(new Set([1, 2]))
  })

  it('selected points spanning groups {1,3} emphasise those, others dim', () => {
    // groups present: 0,1,2,3; select points from group 1 and group 3
    const wide = new Uint16Array([0, 1, 2, 3])
    const { selectedCodes, active } = groupEmphasis(new Uint32Array([1, 3]), wide)
    expect(active).toBe(true)
    // marks for groups 1 & 3 stay full; 0 & 2 dim
    expect(markOpacity(1, selectedCodes, active)).toBe(1)
    expect(markOpacity(3, selectedCodes, active)).toBe(1)
    expect(markOpacity(0, selectedCodes, active)).toBe(DIM_OPACITY)
    expect(markOpacity(2, selectedCodes, active)).toBe(DIM_OPACITY)
  })
})

// ---------------------------------------------------------------------------
// markOpacity — the per-group mark emphasis factor
// ---------------------------------------------------------------------------

describe('markOpacity', () => {
  it('no active selection → every group is full opacity', () => {
    const empty = new Set<number>()
    expect(markOpacity(0, empty, false)).toBe(1)
    expect(markOpacity(7, empty, false)).toBe(1)
  })

  it('active selection → covered codes full, others dimmed', () => {
    const sel = new Set([1, 3])
    expect(markOpacity(1, sel, true)).toBe(1)
    expect(markOpacity(3, sel, true)).toBe(1)
    expect(markOpacity(0, sel, true)).toBe(DIM_OPACITY)
    expect(markOpacity(2, sel, true)).toBe(DIM_OPACITY)
  })
})

// ---------------------------------------------------------------------------
// applyMarkOpacity — RGBA alpha scaling (identity at factor 1)
// ---------------------------------------------------------------------------

describe('applyMarkOpacity', () => {
  it('factor 1 returns the SAME tuple (no-op — byte-unchanged fill)', () => {
    const c: [number, number, number, number] = [10, 20, 30, 200]
    expect(applyMarkOpacity(c, 1)).toBe(c)
  })

  it('scales only the alpha channel, rounded', () => {
    expect(applyMarkOpacity([10, 20, 30, 200], 0.5)).toEqual([10, 20, 30, 100])
    expect(applyMarkOpacity([10, 20, 30, 100], DIM_OPACITY)).toEqual([
      10,
      20,
      30,
      Math.round(100 * DIM_OPACITY),
    ])
  })
})

// ---------------------------------------------------------------------------
// highlightMaskForPoints — the per-point GPU highlight buffer
// ---------------------------------------------------------------------------

describe('highlightMaskForPoints', () => {
  it('sets 1 at each selected index, 0 elsewhere', () => {
    const mask = highlightMaskForPoints(new Uint32Array([1, 4]), 6)
    expect(Array.from(mask)).toEqual([0, 1, 0, 0, 1, 0])
  })

  it('empty selection → an all-zero buffer of length n', () => {
    const mask = highlightMaskForPoints(new Uint32Array(0), 4)
    expect(mask.length).toBe(4)
    expect(Array.from(mask)).toEqual([0, 0, 0, 0])
  })

  it('ignores out-of-range indices (no overflow write)', () => {
    const mask = highlightMaskForPoints(new Uint32Array([0, 10]), 3)
    expect(Array.from(mask)).toEqual([1, 0, 0])
  })

  it('is idempotent across a duplicate index', () => {
    const mask = highlightMaskForPoints(new Uint32Array([2, 2]), 3)
    expect(Array.from(mask)).toEqual([0, 0, 1])
  })
})

// ---------------------------------------------------------------------------
// isDimmed — the emphasis complement
// ---------------------------------------------------------------------------

describe('isDimmed', () => {
  const mask = highlightMaskForPoints(new Uint32Array([1]), 3) // [0,1,0]

  it('unselected points are dimmed', () => {
    expect(isDimmed(mask, 0)).toBe(true)
    expect(isDimmed(mask, 2)).toBe(true)
  })

  it('selected points are NOT dimmed', () => {
    expect(isDimmed(mask, 1)).toBe(false)
  })

  it('out-of-range indices read as dimmed', () => {
    expect(isDimmed(mask, -1)).toBe(true)
    expect(isDimmed(mask, 99)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// highlightedRowPositions — group codes → heatmap display rows
// ---------------------------------------------------------------------------

describe('highlightedRowPositions', () => {
  it('un-clustered identity order: display position == group code', () => {
    const rowOrder = [0, 1, 2, 3]
    expect(highlightedRowPositions(rowOrder, new Set([1, 3]))).toEqual([1, 3])
  })

  it('respects a cluster reorder (display position of the matching original row)', () => {
    // display rows show original indices [2, 0, 3, 1]; groups {0, 3} → positions 1 and 2
    const rowOrder = [2, 0, 3, 1]
    expect(highlightedRowPositions(rowOrder, new Set([0, 3]))).toEqual([1, 2])
  })

  it('empty code set → no rows', () => {
    expect(highlightedRowPositions([0, 1, 2], new Set())).toEqual([])
  })

  it('a code with no matching row is ignored', () => {
    expect(highlightedRowPositions([0, 1], new Set([5]))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// resolveSelectionGroupCodes — GroupIndex path == the plain O(selection) scan
// ---------------------------------------------------------------------------

describe('resolveSelectionGroupCodes', () => {
  // points:        0  1  2  3  4  5
  const codes = new Uint16Array([0, 1, 0, 2, 2, 1])
  const gi = buildGroupIndex(codes, 3)

  it('with a GroupIndex matches the plain selectedGroupCodes path (identical rows)', () => {
    const sel = new Uint32Array([0, 3, 5])
    expect(resolveSelectionGroupCodes(sel, codes, gi)).toEqual(
      selectedGroupCodes(sel, codes),
    )
    // …and equals the fallback (no index) branch too.
    expect(resolveSelectionGroupCodes(sel, codes)).toEqual(
      selectedGroupCodes(sel, codes),
    )
  })

  it('the GroupIndex bounds stray codes but the visible rows are unchanged', () => {
    // code 9 is out of range for nGroups=3; it would never match a heatmap row anyway.
    const stray = new Uint16Array([0, 9, 1])
    const gi2 = buildGroupIndex(stray, 3)
    const sel = new Uint32Array([0, 1, 2])
    // GroupIndex drops the >= nGroups code; the plain scan keeps it — but a code 9 has no
    // display row (rowOrder ∈ 0..nRows-1), so highlightedRowPositions yields the same rows.
    expect(highlightedRowPositions([0, 1, 2], resolveSelectionGroupCodes(sel, stray, gi2)))
      .toEqual(
        highlightedRowPositions([0, 1, 2], selectedGroupCodes(sel, stray)),
      )
  })
})

// ---------------------------------------------------------------------------
// highlightMaskForGroupSelection — group→points mask: O(group) == O(N) scan
// ---------------------------------------------------------------------------

describe('highlightMaskForGroupSelection', () => {
  // points:        0  1  2  3  4  5  6  7  8
  const codes = new Uint16Array([2, 0, 1, 2, 0, 3, 1, 2, 0])
  const n = codes.length
  const gi = buildGroupIndex(codes, 4)

  /** Brute-force per-point oracle (the "old scan" the GroupIndex path replaces). */
  const oracle = (groups: Set<number>) => {
    const m = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (groups.has(codes[i])) m[i] = 1
    return m
  }

  it('GroupIndex path == fallback scan == oracle, over many group subsets', () => {
    const subsets: Set<number>[] = [
      new Set(),
      new Set([0]),
      new Set([2]),
      new Set([0, 2]),
      new Set([1, 3]),
      new Set([0, 1, 2, 3]),
      new Set([3]),
    ]
    for (const groups of subsets) {
      const viaIndex = highlightMaskForGroupSelection(groups, n, codes, gi)
      const viaScan = highlightMaskForGroupSelection(groups, n, codes) // no index → O(N)
      const expected = oracle(groups)
      expect(Array.from(viaIndex)).toEqual(Array.from(expected))
      expect(Array.from(viaScan)).toEqual(Array.from(expected))
    }
  })

  it('empty group set → all-zero mask (both paths)', () => {
    expect(Array.from(highlightMaskForGroupSelection(new Set(), n, codes, gi))).toEqual(
      Array.from(new Uint8Array(n)),
    )
    expect(Array.from(highlightMaskForGroupSelection(new Set(), n, codes))).toEqual(
      Array.from(new Uint8Array(n)),
    )
  })

  it('out-of-range group codes are ignored (both paths)', () => {
    expect(Array.from(highlightMaskForGroupSelection(new Set([99]), n, codes, gi))).toEqual(
      Array.from(new Uint8Array(n)),
    )
    expect(Array.from(highlightMaskForGroupSelection(new Set([99]), n, codes))).toEqual(
      Array.from(new Uint8Array(n)),
    )
  })

  it('a smaller n than the indexed dataset never overflows (both paths)', () => {
    // n=6 with a group whose members include indices >= 6 — those are skipped.
    const viaIndex = highlightMaskForGroupSelection(new Set([2]), 6, codes, gi)
    const viaScan = highlightMaskForGroupSelection(new Set([2]), 6, codes)
    expect(viaIndex.length).toBe(6)
    expect(Array.from(viaIndex)).toEqual(Array.from(viaScan))
  })

  // LOW-3 regression: when the CODES column itself carries an out-of-range value (>= nGroups)
  // AND that value is present in `groupCodes`, the CSR path drops it (buildGroupIndex never
  // indexed that point) but the unclamped O(N) fallback would light it up — divergence. The
  // `nGroups` arg makes the fallback filter it out too, so the two paths stay byte-identical.
  it('out-of-range code in BOTH the codes column and the group set — fallback matches CSR when nGroups is given', () => {
    // point 2 carries code 5, which is out of range for nGroups=3.
    const oorCodes = new Uint16Array([2, 0, 5, 1, 0])
    const nGroups = 3
    const oorGi = buildGroupIndex(oorCodes, nGroups)
    const groups = new Set([0, 5]) // 5 is out of range — must never mark point 2

    const viaIndex = highlightMaskForGroupSelection(groups, oorCodes.length, oorCodes, oorGi)
    // Unclamped fallback (no nGroups) WOULD diverge — it marks point 2 (code 5 ∈ groups).
    const viaScanUnclamped = highlightMaskForGroupSelection(groups, oorCodes.length, oorCodes)
    // Clamped fallback (nGroups given) matches the CSR path byte-for-byte.
    const viaScanClamped = highlightMaskForGroupSelection(
      groups,
      oorCodes.length,
      oorCodes,
      undefined,
      nGroups,
    )

    // CSR marks only group-0 members (points 1 and 4), never the out-of-range point 2.
    expect(Array.from(viaIndex)).toEqual([0, 1, 0, 0, 1])
    // The bug the clamp fixes: the unclamped scan lights up point 2.
    expect(viaScanUnclamped[2]).toBe(1)
    // The fix: clamped scan == CSR, byte-for-byte.
    expect(Array.from(viaScanClamped)).toEqual(Array.from(viaIndex))
  })
})

// ---------------------------------------------------------------------------
// Cell-ID selection seam — identityPointIds / mapRowsToIds / buildIdToRow /
// highlightMaskForIds / selectedGroupCodesByIds / groupEmphasisByIds
//
// The correctness contract: for IDENTITY pointIds the id path is byte-identical to the
// old index path; for a PERMUTED pointIds it highlights the right ROWS (not the same
// positions); for a SUBSET it highlights only present ids; for a DISJOINT id set it
// highlights nothing.
// ---------------------------------------------------------------------------

describe('identityPointIds', () => {
  it('is pointIds[i] === i of length n', () => {
    expect(Array.from(identityPointIds(4))).toEqual([0, 1, 2, 3])
    expect(identityPointIds(0).length).toBe(0)
  })
})

describe('mapRowsToIds (PRODUCE direction)', () => {
  it('identity pointIds (or absent) is a plain copy of rows', () => {
    const rows = new Uint32Array([2, 0, 3])
    expect(Array.from(mapRowsToIds(rows, identityPointIds(4)))).toEqual([2, 0, 3])
    // absent pointIds ⇒ identity copy (single-source no-op)
    const copy = mapRowsToIds(rows)
    expect(Array.from(copy)).toEqual([2, 0, 3])
    expect(copy).not.toBe(rows) // a fresh array, not the same reference
  })

  it('maps local rows through a permutation pointIds', () => {
    // row r carries canonical id perm[r]
    const perm = new Uint32Array([3, 1, 0, 2])
    // select local rows 0 and 3 → canonical ids 3 and 2
    expect(Array.from(mapRowsToIds(new Uint32Array([0, 3]), perm))).toEqual([3, 2])
  })
})

describe('buildIdToRow (CONSUME direction)', () => {
  it('identity pointIds → the identity map (id === row)', () => {
    const idToRow = buildIdToRow(identityPointIds(5))
    for (let i = 0; i < 5; i++) expect(idToRow(i)).toBe(i)
    // out of range → NO_ROW
    expect(idToRow(5)).toBe(NO_ROW)
    expect(idToRow(-1)).toBe(NO_ROW)
  })

  it('permutation pointIds → the real reverse', () => {
    // row 0 = id 3, row 1 = id 1, row 2 = id 0, row 3 = id 2
    const idToRow = buildIdToRow(new Uint32Array([3, 1, 0, 2]))
    expect(idToRow(3)).toBe(0)
    expect(idToRow(1)).toBe(1)
    expect(idToRow(0)).toBe(2)
    expect(idToRow(2)).toBe(3)
  })

  it('subset pointIds → present ids map, absent ids are NO_ROW', () => {
    // this view holds only canonical ids {10, 4, 7} at rows {0,1,2}
    const idToRow = buildIdToRow(new Uint32Array([10, 4, 7]))
    expect(idToRow(10)).toBe(0)
    expect(idToRow(4)).toBe(1)
    expect(idToRow(7)).toBe(2)
    // dense-id gaps within [0..maxId] that aren't present → NO_ROW
    expect(idToRow(0)).toBe(NO_ROW)
    expect(idToRow(5)).toBe(NO_ROW)
    // beyond maxId → NO_ROW
    expect(idToRow(11)).toBe(NO_ROW)
  })

  it('empty pointIds → NO_ROW for every id', () => {
    const idToRow = buildIdToRow(new Uint32Array(0))
    expect(idToRow(0)).toBe(NO_ROW)
    expect(idToRow(3)).toBe(NO_ROW)
  })
})

describe('highlightMaskForIds', () => {
  it('IDENTITY pointIds equals highlightMaskForPoints (byte-identical)', () => {
    const n = 6
    const idToRow = buildIdToRow(identityPointIds(n))
    for (const sel of [
      new Uint32Array([1, 4]),
      new Uint32Array(0),
      new Uint32Array([0, 10]), // out of range
      new Uint32Array([2, 2]), // duplicate
    ]) {
      expect(Array.from(highlightMaskForIds(sel, idToRow, n))).toEqual(
        Array.from(highlightMaskForPoints(sel, n)),
      )
    }
  })

  it('PERMUTED pointIds highlights the right ROWS, not the same positions', () => {
    // View A (producer): identity — selecting canonical ids {0, 2}.
    const selIds = new Uint32Array([0, 2])
    // View B: row r carries canonical id perm[r]. id 0 is at row 2; id 2 is at row 3.
    const perm = new Uint32Array([3, 1, 0, 2])
    const idToRowB = buildIdToRow(perm)
    const maskB = highlightMaskForIds(selIds, idToRowB, perm.length)
    expect(Array.from(maskB)).toEqual([0, 0, 1, 1]) // rows 2 & 3, NOT rows 0 & 2
    // The index-based (wrong) answer would light rows 0 & 2 — prove they differ.
    expect(Array.from(maskB)).not.toEqual(Array.from(highlightMaskForPoints(selIds, 4)))
  })

  it('SUBSET pointIds highlights only present ids, ignores absent ones', () => {
    // View holds canonical ids {10, 4, 7}. Selection {4, 99, 7} → rows for 4 and 7 only.
    const idToRow = buildIdToRow(new Uint32Array([10, 4, 7]))
    const mask = highlightMaskForIds(new Uint32Array([4, 99, 7]), idToRow, 3)
    expect(Array.from(mask)).toEqual([0, 1, 1]) // row1(id4), row2(id7); id99 absent
  })

  it('DISJOINT id set highlights nothing', () => {
    // View B holds ids [100..103]; selection is ids [0..2] (from a different point set).
    const idToRow = buildIdToRow(new Uint32Array([100, 101, 102, 103]))
    const mask = highlightMaskForIds(new Uint32Array([0, 1, 2]), idToRow, 4)
    expect(Array.from(mask)).toEqual([0, 0, 0, 0])
  })
})

describe('selectedGroupCodesByIds', () => {
  // canonical ids 0..5 ; group codes by canonical id
  const codesByCanonical = new Uint16Array([0, 1, 0, 2, 2, 1])

  it('IDENTITY view equals selectedGroupCodes', () => {
    const idToRow = buildIdToRow(identityPointIds(6))
    const sel = new Uint32Array([0, 3, 5])
    expect(selectedGroupCodesByIds(sel, idToRow, codesByCanonical)).toEqual(
      selectedGroupCodes(sel, codesByCanonical),
    )
  })

  it('PERMUTED view resolves the right rows → the right codes', () => {
    // View B: row r = canonical id perm[r]; codes are indexed by B's LOCAL row.
    const perm = new Uint32Array([3, 1, 0, 2, 4, 5])
    // B's per-row codes must equal the canonical id's code: codesB[r] = codesByCanonical[perm[r]]
    const codesB = new Uint16Array(perm.length)
    for (let r = 0; r < perm.length; r++) codesB[r] = codesByCanonical[perm[r]]
    const idToRowB = buildIdToRow(perm)
    // select canonical ids {0(grp0), 3(grp2), 5(grp1)} → codes {0,2,1}
    const got = selectedGroupCodesByIds(new Uint32Array([0, 3, 5]), idToRowB, codesB)
    expect(got).toEqual(new Set([0, 2, 1]))
  })

  it('absent ids contribute no code', () => {
    const idToRow = buildIdToRow(new Uint32Array([10, 4, 7]))
    const codes = new Uint16Array([5, 6, 7])
    // id 4 → row1 → code 6 ; id 99 absent
    expect(selectedGroupCodesByIds(new Uint32Array([4, 99]), idToRow, codes)).toEqual(
      new Set([6]),
    )
  })
})

describe('groupEmphasisByIds', () => {
  const codes = new Uint16Array([0, 1, 0, 2, 2, 1])

  it('IDENTITY view equals groupEmphasis', () => {
    const idToRow = buildIdToRow(identityPointIds(6))
    const sel = new Uint32Array([1, 3])
    expect(groupEmphasisByIds(sel, idToRow, codes)).toEqual(groupEmphasis(sel, codes))
  })

  it('null/empty selection is inactive', () => {
    const idToRow = buildIdToRow(identityPointIds(6))
    expect(groupEmphasisByIds(null, idToRow, codes)).toEqual({
      selectedCodes: new Set(),
      active: false,
    })
    expect(groupEmphasisByIds(new Uint32Array(0), idToRow, codes)).toEqual({
      selectedCodes: new Set(),
      active: false,
    })
  })

  it('disjoint id selection is active but covers no code in this view', () => {
    // view holds ids [100..105]; selection ids [0..2] → no rows → empty codes
    const idToRow = buildIdToRow(identityPointIds(6).map(i => i + 100) as Uint32Array)
    const got = groupEmphasisByIds(new Uint32Array([0, 1, 2]), idToRow, codes)
    expect(got.active).toBe(true)
    expect(got.selectedCodes).toEqual(new Set())
  })
})

// ---------------------------------------------------------------------------
// Coordination store — the selection fan-out slice (origin-tagged)
// ---------------------------------------------------------------------------

describe('Coordination store — setSelection / origin', () => {
  beforeEach(() => {
    useCoordinationStore.getState().clearSelection()
  })

  it('setSelection writes the indices + tags the originating cell', () => {
    const sel = new Uint32Array([1, 2, 3])
    useCoordinationStore.getState().setSelection('cell-A', sel)
    const s = useCoordinationStore.getState()
    expect(s.pointSelection).toBe(sel)
    expect(s.selectionOrigin).toBe('cell-A')
  })

  it('an empty selection clears the origin (nothing to attribute)', () => {
    useCoordinationStore.getState().setSelection('cell-A', new Uint32Array(0))
    expect(useCoordinationStore.getState().selectionOrigin).toBeNull()
  })

  it('setSelection(null) clears the selection', () => {
    useCoordinationStore.getState().setSelection('cell-A', new Uint32Array([1]))
    useCoordinationStore.getState().setSelection('cell-A', null)
    expect(useCoordinationStore.getState().pointSelection).toBeNull()
    expect(useCoordinationStore.getState().selectionOrigin).toBeNull()
  })

  it('setPointSelection stays origin-less (back-compat)', () => {
    useCoordinationStore.getState().setPointSelection(new Uint32Array([4, 5]))
    const s = useCoordinationStore.getState()
    expect(Array.from(s.pointSelection!)).toEqual([4, 5])
    expect(s.selectionOrigin).toBeNull()
  })

  it('clearSelection resets both fields', () => {
    useCoordinationStore.getState().setSelection('cell-B', new Uint32Array([7]))
    useCoordinationStore.getState().clearSelection()
    const s = useCoordinationStore.getState()
    expect(s.pointSelection).toBeNull()
    expect(s.selectionOrigin).toBeNull()
  })
})

// A tiny guard so the exported constant stays a sane dim (0 < x < 1).
describe('DIM_OPACITY', () => {
  it('is a fractional opacity', () => {
    expect(DIM_OPACITY).toBeGreaterThan(0)
    expect(DIM_OPACITY).toBeLessThan(1)
  })
})
