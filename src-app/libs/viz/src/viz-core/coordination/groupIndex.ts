// groupIndex.ts — a precomputed group→point-indices CSR membership index (ITEM-7).
//
// The cross-plot highlight path (see `selectionSync.ts`) maps a point-selection to the
// GROUP CODES it covers (`selectedGroupCodes`, O(selection)) and back to a per-point
// highlight buffer (`highlightMaskForPoints`, O(selection) + an O(N) zero-fill). Those
// are fine for the SELECTION→points direction. The reverse — "given a set of GROUPS,
// light up their points" (a linked-view highlight: click a heatmap column/box/bar → the
// scatter emphasises that group's points) — needs the MEMBERS of a group, which the raw
// per-point `codes: Uint16Array` only answers by scanning all N points every time.
//
// This module precomputes, ONCE per grouping, a compressed-sparse-row (CSR) membership
// index via a counting sort, so:
//   • `groupMembers(gi, code)` is O(1) + a zero-copy slice (the group's point indices lie
//     CONTIGUOUS in one typed array), and
//   • `highlightMaskForGroups(gi, groups, n)` builds the per-point mask by writing over
//     ONLY the selected groups' contiguous index runs — O(sum of selected group sizes),
//     cache-friendly, vs an O(N) per-point scan-and-test.
//
// PURE + self-contained (no deck.gl, no React, no store), typed-array only, so the
// mapping math is unit-tested in the node vitest pass and viz-core stays extractable.

/**
 * A compressed-sparse-row membership index over a categorical grouping: every point
 * index appears exactly once, grouped contiguously by its group code.
 *
 *   • `offsets` — length `nGroups + 1`. Group `g` owns the half-open index range
 *     `[offsets[g], offsets[g + 1])` within `indices`; `offsets` is non-decreasing and
 *     `offsets[nGroups]` is the total number of indexed points. An empty group is a
 *     zero-length run (`offsets[g] === offsets[g + 1]`).
 *   • `indices` — the point (dense) indices, ordered so that all of group 0's members
 *     come first, then group 1's, etc. Ascending WITHIN each group (stable counting
 *     sort). Its length is the number of IN-RANGE points, which is < `codes.length`
 *     when some codes were out of range (see `buildGroupIndex`).
 */
export interface GroupIndex {
  /** Prefix-sum group boundaries; length `nGroups + 1`, non-decreasing. */
  readonly offsets: Uint32Array
  /** Point indices, grouped contiguously by code; length = total in-range points. */
  readonly indices: Uint32Array
}

/**
 * Build the CSR membership index for a per-point group-code column via a two-pass
 * counting sort — O(N) time, O(N) space, allocation-only (no comparisons/sorting).
 *
 * Pass 1 counts members per group and prefix-sums the counts into `offsets` (so
 * `offsets[g]` is group `g`'s start). Pass 2 scatters each point index into its group's
 * contiguous slot using a per-group write cursor. Iterating points in ascending order
 * keeps each group's members ascending (a stable sort).
 *
 * Out-of-range codes (`code >= nGroups`) are SKIPPED — they contribute to no group and
 * are absent from `indices` (so `indices.length` is the count of in-range points, not
 * `codes.length`). This mirrors `selectedGroupCodes`' tolerance of stray codes and lets
 * a caller pass `nGroups = categories.length` without pre-filtering. `nGroups === 0`
 * (or `codes.length === 0`) yields `offsets = [0]` (or an all-zero run) and an empty
 * `indices`.
 *
 * @param codes   per-point group codes (the categorical column's `codes`)
 * @param nGroups number of groups (typically `categories.length`); codes `>= nGroups`
 *                are skipped
 */
export function buildGroupIndex(
  codes: Uint16Array | Uint32Array,
  nGroups: number,
): GroupIndex {
  const n = codes.length
  // offsets[c + 1] accumulates group c's count, so the later prefix-sum lands each
  // group's START at offsets[c] (the classic counting-sort layout).
  const offsets = new Uint32Array(nGroups + 1)
  let total = 0
  for (let i = 0; i < n; i++) {
    const c = codes[i]
    if (c < nGroups) {
      offsets[c + 1]++
      total++
    }
  }
  // Prefix-sum → offsets[g] = start of group g, offsets[nGroups] = total.
  for (let g = 0; g < nGroups; g++) {
    offsets[g + 1] += offsets[g]
  }
  // Scatter: a mutable copy of the group starts is the per-group write cursor.
  const indices = new Uint32Array(total)
  const cursor = offsets.slice()
  for (let i = 0; i < n; i++) {
    const c = codes[i]
    if (c < nGroups) {
      indices[cursor[c]++] = i
    }
  }
  return { offsets, indices }
}

/**
 * The point indices belonging to `code`, as a ZERO-COPY subarray VIEW over the index's
 * backing buffer (`.buffer === gi.indices.buffer`) — O(1) plus the slice. An empty
 * group returns a zero-length view; an out-of-range `code` returns an empty view too
 * (never throws). Do not mutate the returned view: it aliases the shared CSR buffer.
 */
export function groupMembers(gi: GroupIndex, code: number): Uint32Array {
  const nGroups = gi.offsets.length - 1
  if (code < 0 || code >= nGroups) return gi.indices.subarray(0, 0)
  return gi.indices.subarray(gi.offsets[code], gi.offsets[code + 1])
}

/**
 * The set of group codes a POINT selection touches — "which heatmap columns / group
 * marks light up" for a scatter selection. O(selection): reads `codes[i]` per selected
 * index, exactly like `selectedGroupCodes`, but bounds the result to codes present in
 * the index (`code < nGroups`) so it stays consistent with the CSR partition. Accepts a
 * dense-index `Uint32Array` OR a `Set<number>`. Out-of-range indices (`i >= codes.length`)
 * and out-of-range codes are ignored; an empty selection yields an empty set.
 */
export function groupsInSelection(
  gi: GroupIndex,
  selection: Uint32Array | Set<number>,
  codes: Uint16Array | Uint32Array,
): Set<number> {
  const nGroups = gi.offsets.length - 1
  const n = codes.length
  const out = new Set<number>()
  const visit = (i: number): void => {
    if (i >= 0 && i < n) {
      const c = codes[i]
      if (c < nGroups) out.add(c)
    }
  }
  if (selection instanceof Set) {
    for (const i of selection) visit(i)
  } else {
    for (let k = 0; k < selection.length; k++) visit(selection[k])
  }
  return out
}

/**
 * Build a per-point 0/1 highlight mask (`Uint8Array[n]`) for a set of GROUPS by writing
 * `1` over each selected group's CONTIGUOUS index run in the CSR index — the O(group)
 * linked-highlight this module exists for.
 *
 * Cost is O(n) for the zero-fill allocation plus O(sum of selected group sizes) for the
 * writes — it touches ONLY the members of the highlighted groups (sequential runs, so
 * cache-friendly), NOT all N points. Selecting a few small groups out of a large dataset
 * is thus near-free vs a per-point `codes[i] ∈ groupCodes` scan of all N.
 *
 * Out-of-range codes in `groupCodes` are skipped; a member index `>= n` is skipped
 * (defensive, e.g. a smaller `n` than the indexed dataset). An empty `groupCodes` yields
 * an all-zero mask. The result feeds a `ScatterplotLayer`'s `DataFilterExtension` exactly
 * like `highlightMaskForPoints`, so the two are interchangeable at the layer.
 */
export function highlightMaskForGroups(
  gi: GroupIndex,
  groupCodes: Set<number>,
  n: number,
): Uint8Array {
  const mask = new Uint8Array(n)
  const nGroups = gi.offsets.length - 1
  const { offsets, indices } = gi
  for (const code of groupCodes) {
    if (code < 0 || code >= nGroups) continue
    const end = offsets[code + 1]
    for (let p = offsets[code]; p < end; p++) {
      const idx = indices[p]
      if (idx < n) mask[idx] = 1
    }
  }
  return mask
}
