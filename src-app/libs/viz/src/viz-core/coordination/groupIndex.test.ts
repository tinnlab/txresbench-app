// groupIndex.test.ts — L0 unit tests for the group→point CSR membership index (ITEM-7).
// Proves the CSR is a true partition (offsets monotonic, every in-range index placed
// exactly once, zero-copy slices), that the selection→groups query is correct, and that
// the O(group) group→mask build matches a brute-force per-point oracle. Runs in the node
// vitest pass (pure, typed-array only).

import { describe, expect, it } from 'vitest'

import {
  buildGroupIndex,
  type GroupIndex,
  groupMembers,
  groupsInSelection,
  highlightMaskForGroups,
} from './groupIndex'

// ── helpers ────────────────────────────────────────────────────────────────────

/** Assert the CSR is a valid partition of the in-range points of `codes`, and that
 *  `indices` places every in-range point index exactly once in its group's slice. */
function assertPartition(
  gi: GroupIndex,
  codes: Uint16Array | Uint32Array,
  nGroups: number,
): void {
  expect(gi.offsets.length).toBe(nGroups + 1)
  // offsets non-decreasing, starts at 0.
  expect(gi.offsets[0]).toBe(0)
  for (let g = 0; g < nGroups; g++) {
    expect(gi.offsets[g + 1]).toBeGreaterThanOrEqual(gi.offsets[g])
  }
  // total = last offset = indices length = count of in-range codes.
  let inRange = 0
  for (let i = 0; i < codes.length; i++) if (codes[i] < nGroups) inRange++
  expect(gi.offsets[nGroups]).toBe(inRange)
  expect(gi.indices.length).toBe(inRange)

  // Every index in group g's slice actually has code g; each in-range point appears once.
  const seen = new Uint8Array(codes.length)
  for (let g = 0; g < nGroups; g++) {
    for (let p = gi.offsets[g]; p < gi.offsets[g + 1]; p++) {
      const idx = gi.indices[p]
      expect(codes[idx]).toBe(g)
      expect(seen[idx]).toBe(0) // not seen before → placed exactly once
      seen[idx] = 1
    }
  }
  // …and every in-range point WAS placed.
  for (let i = 0; i < codes.length; i++) {
    if (codes[i] < nGroups) expect(seen[i]).toBe(1)
  }
}

/** Brute-force per-point oracle for `highlightMaskForGroups`: scan ALL n points, set 1
 *  iff the point's code is in the selected group set. This is the O(N) path the CSR
 *  index replaces with an O(group) one. */
function maskOracle(
  codes: Uint16Array | Uint32Array,
  groupCodes: Set<number>,
  n: number,
): Uint8Array {
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (i < codes.length && groupCodes.has(codes[i])) mask[i] = 1
  }
  return mask
}

// ── buildGroupIndex — partition correctness ─────────────────────────────────────

describe('buildGroupIndex — CSR partition', () => {
  it('partitions a typical multi-group column (offsets monotonic, each index placed once)', () => {
    // 4 groups; interleaved codes so the scatter step is exercised.
    const codes = new Uint16Array([2, 0, 1, 2, 0, 3, 1, 2, 0])
    const nGroups = 4
    const gi = buildGroupIndex(codes, nGroups)
    assertPartition(gi, codes, nGroups)

    // Explicit shape: group 0 → {1,4,8}, 1 → {2,6}, 2 → {0,3,7}, 3 → {5}.
    expect(Array.from(gi.offsets)).toEqual([0, 3, 5, 8, 9])
    expect(Array.from(groupMembers(gi, 0))).toEqual([1, 4, 8])
    expect(Array.from(groupMembers(gi, 1))).toEqual([2, 6])
    expect(Array.from(groupMembers(gi, 2))).toEqual([0, 3, 7])
    expect(Array.from(groupMembers(gi, 3))).toEqual([5])
  })

  it('keeps each group’s members ascending (stable counting sort)', () => {
    const codes = new Uint16Array([1, 1, 0, 1, 0, 0, 1])
    const gi = buildGroupIndex(codes, 2)
    expect(Array.from(groupMembers(gi, 0))).toEqual([2, 4, 5])
    expect(Array.from(groupMembers(gi, 1))).toEqual([0, 1, 3, 6])
  })

  it('accepts a Uint32Array code column', () => {
    const codes = new Uint32Array([0, 2, 1, 0])
    const gi = buildGroupIndex(codes, 3)
    assertPartition(gi, codes, 3)
    expect(Array.from(groupMembers(gi, 0))).toEqual([0, 3])
  })
})

// ── groupMembers — zero-copy views ──────────────────────────────────────────────

describe('groupMembers — zero-copy slice', () => {
  it('returns a subarray VIEW over the shared indices buffer (.buffer identity)', () => {
    const codes = new Uint16Array([0, 1, 0, 1])
    const gi = buildGroupIndex(codes, 2)
    const g0 = groupMembers(gi, 0)
    expect(g0.buffer).toBe(gi.indices.buffer) // zero-copy — no allocation of new bytes
    expect(Array.from(g0)).toEqual([0, 2])
  })

  it('returns an empty view for an out-of-range or negative code (no throw)', () => {
    const gi = buildGroupIndex(new Uint16Array([0, 1]), 2)
    const oob = groupMembers(gi, 5)
    expect(oob.length).toBe(0)
    expect(oob.buffer).toBe(gi.indices.buffer)
    expect(groupMembers(gi, -1).length).toBe(0)
  })
})

// ── groupsInSelection — point selection → covered group codes ────────────────────

describe('groupsInSelection', () => {
  const codes = new Uint16Array([2, 0, 1, 2, 0, 3, 1, 2, 0])
  const gi = buildGroupIndex(codes, 4)

  it('returns exactly the group codes a Uint32Array selection touches', () => {
    // points 0(→2), 1(→0), 6(→1)
    const got = groupsInSelection(gi, new Uint32Array([0, 1, 6]), codes)
    expect(got).toEqual(new Set([2, 0, 1]))
  })

  it('accepts a Set<number> selection', () => {
    const got = groupsInSelection(gi, new Set([5, 8]), codes) // →3, →0
    expect(got).toEqual(new Set([3, 0]))
  })

  it('ignores out-of-range point indices; empty selection → empty set', () => {
    expect(groupsInSelection(gi, new Uint32Array([100, 200]), codes)).toEqual(new Set())
    expect(groupsInSelection(gi, new Uint32Array(0), codes)).toEqual(new Set())
  })

  it('ignores codes >= nGroups (stays consistent with the index partition)', () => {
    const strayCodes = new Uint16Array([0, 7, 1]) // 7 is out of range for nGroups=2
    const gi2 = buildGroupIndex(strayCodes, 2)
    // selecting the stray point (index 1) contributes no group.
    expect(groupsInSelection(gi2, new Uint32Array([0, 1, 2]), strayCodes)).toEqual(
      new Set([0, 1]),
    )
  })
})

// ── highlightMaskForGroups — matches the brute-force per-point oracle ─────────────

describe('highlightMaskForGroups — O(group) mask == O(N) oracle', () => {
  const codes = new Uint16Array([2, 0, 1, 2, 0, 3, 1, 2, 0])
  const n = codes.length
  const gi = buildGroupIndex(codes, 4)

  it('matches the oracle for a single selected group', () => {
    const groups = new Set([2])
    expect(Array.from(highlightMaskForGroups(gi, groups, n))).toEqual(
      Array.from(maskOracle(codes, groups, n)),
    )
  })

  it('matches the oracle for several selected groups', () => {
    const groups = new Set([0, 3])
    expect(Array.from(highlightMaskForGroups(gi, groups, n))).toEqual(
      Array.from(maskOracle(codes, groups, n)),
    )
  })

  it('matches the oracle across every subset of groups (exhaustive)', () => {
    for (let bits = 0; bits < 1 << 4; bits++) {
      const groups = new Set<number>()
      for (let g = 0; g < 4; g++) if (bits & (1 << g)) groups.add(g)
      expect(Array.from(highlightMaskForGroups(gi, groups, n))).toEqual(
        Array.from(maskOracle(codes, groups, n)),
      )
    }
  })

  it('empty group set → all-zero mask', () => {
    expect(Array.from(highlightMaskForGroups(gi, new Set(), n))).toEqual(
      Array.from(new Uint8Array(n)),
    )
  })

  it('skips out-of-range group codes and member indices >= n', () => {
    // out-of-range group code 99 contributes nothing.
    expect(Array.from(highlightMaskForGroups(gi, new Set([99]), n))).toEqual(
      Array.from(new Uint8Array(n)),
    )
    // a smaller n than the dataset clamps writes (index 8 dropped when n=6).
    const small = highlightMaskForGroups(gi, new Set([0]), 6)
    expect(small.length).toBe(6)
    // group 0 members are {1,4,8}; only 1 and 4 fit in n=6.
    expect(Array.from(small)).toEqual([0, 1, 0, 0, 1, 0])
  })
})

// ── degenerate shapes ───────────────────────────────────────────────────────────

describe('buildGroupIndex — degenerate cases', () => {
  it('N = 0 (empty column)', () => {
    const gi = buildGroupIndex(new Uint16Array(0), 3)
    expect(Array.from(gi.offsets)).toEqual([0, 0, 0, 0])
    expect(gi.indices.length).toBe(0)
    assertPartition(gi, new Uint16Array(0), 3)
  })

  it('nGroups = 0 (no groups) — every code is out of range', () => {
    const codes = new Uint16Array([0, 1, 2])
    const gi = buildGroupIndex(codes, 0)
    expect(Array.from(gi.offsets)).toEqual([0])
    expect(gi.indices.length).toBe(0)
    expect(groupMembers(gi, 0).length).toBe(0)
  })

  it('single group holding all points', () => {
    const codes = new Uint16Array([0, 0, 0, 0])
    const gi = buildGroupIndex(codes, 1)
    assertPartition(gi, codes, 1)
    expect(Array.from(gi.offsets)).toEqual([0, 4])
    expect(Array.from(groupMembers(gi, 0))).toEqual([0, 1, 2, 3])
  })

  it('empty group is a zero-length run between populated groups', () => {
    // no point carries code 1 → group 1 is empty (offsets[1] === offsets[2]).
    const codes = new Uint16Array([0, 2, 0, 2])
    const gi = buildGroupIndex(codes, 3)
    assertPartition(gi, codes, 3)
    expect(gi.offsets[1]).toBe(gi.offsets[2]) // group 1 empty
    expect(groupMembers(gi, 1).length).toBe(0)
    expect(Array.from(groupMembers(gi, 0))).toEqual([0, 2])
    expect(Array.from(groupMembers(gi, 2))).toEqual([1, 3])
  })

  it('out-of-range codes are skipped and absent from indices', () => {
    // codes 5 and 9 exceed nGroups=3 → not indexed.
    const codes = new Uint16Array([0, 5, 1, 9, 2, 0])
    const gi = buildGroupIndex(codes, 3)
    assertPartition(gi, codes, 3) // partition asserts indices.length === in-range count (4)
    expect(gi.indices.length).toBe(4)
    expect(Array.from(groupMembers(gi, 0))).toEqual([0, 5])
    expect(Array.from(groupMembers(gi, 1))).toEqual([2])
    expect(Array.from(groupMembers(gi, 2))).toEqual([4])
  })
})
