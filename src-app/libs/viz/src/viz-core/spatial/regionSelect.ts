// regionSelect.ts — PURE helpers for a region selection over a point layout (the "lasso a
// region → the points inside" bridge that turns a viewer into an analysis tool). Depends
// ONLY on the KD-tree (`spatial/pointIndex`) + the packed-bitmask polygon test
// (`data/selection`) — NO deck.gl, NO React, NO store — so the mapping math unit-tests in
// the node vitest pass and viz-core stays extractable.
//
// The two pieces the region-select→analysis bridge needs:
//   • `selectRegion` — a drawn polygon (world/view coords) → the dense point indices inside
//     it, narrowed through the KD-tree so the point-in-polygon test runs on O(log N + k)
//     bbox candidates, NEVER an O(N) coordinate scan (reuses `selectInPolygon`'s index seam).
//   • `regionComposition` — those indices + the per-point group codes → the categorical
//     COMPOSITION (counts + fractions per category) of the region: "what point types are in
//     this region". Reuses the same group-code column the cross-plot highlight reads.
//
// GENERIC naming (DEC-28): region / point / group — nothing here knows about any domain.

import { selectInPolygon } from '../data/selection'
import type { PointIndex } from './pointIndex'

/** A 2D vertex in the SAME coordinate space as the positions the polygon is tested against. */
export type Vec2 = readonly [number, number]

/**
 * The dense point indices whose position falls inside a drawn ROI `polygon`, as an ascending
 * `Uint32Array`. `positions` MUST be in the SAME coordinate space as `polygon` (the world
 * positions the ROI was drawn over — apply any layout affine to the positions first). When a
 * prebuilt KD-tree `index` is supplied, the point-in-polygon test is confined to the polygon's
 * bounding box via an O(log N + k) range query (a point outside the bbox can never be inside the
 * ring), so the result is BYTE-IDENTICAL to an O(N) scan but far cheaper. A degenerate ring
 * (< 3 vertices) selects nothing.
 */
export function selectRegion(
  polygon: readonly Vec2[],
  positions: Float32Array,
  totalPoints: number,
  index?: PointIndex,
): Uint32Array {
  const mask = selectInPolygon(
    positions,
    polygon as [number, number][],
    totalPoints,
    undefined,
    index,
  )
  return mask.toIndices()
}

/** One category's share of a region. */
export interface RegionCompositionEntry {
  /** the category's group code (index into `categories`). */
  readonly code: number
  /** the category's display label (`categories[code]`). */
  readonly category: string
  /** number of selected points in this category. */
  readonly count: number
  /** `count / total` (0 when the region is empty). */
  readonly fraction: number
}

/** The categorical make-up of a selected region — counts + fractions per category. */
export interface RegionComposition {
  /** total categorizable selected points (the sum of every entry's `count`). */
  readonly total: number
  /** per-category entries for categories present in the region (`count > 0`), DESCENDING by
   *  `count` then ascending by `code` — the "what types are in this region" readout, largest first. */
  readonly entries: readonly RegionCompositionEntry[]
}

/**
 * The categorical / group COMPOSITION of a selected region: for every selected point, read its
 * group code from the per-point `groupCodes` column and tally per category. Reuses the exact
 * group-code column the cross-plot highlight reads, so the region's composition is consistent with
 * the linked views' grouping.
 *
 * `total` counts only CATEGORIZABLE points — a selected index out of range (`i >= groupCodes.length`)
 * or an out-of-range code (`code >= categories.length`) is skipped (mirrors `selectedGroupCodes` /
 * `groupsInSelection` tolerance), so every entry's `fraction` sums to 1 over a non-empty region.
 * An empty selection yields `{ total: 0, entries: [] }` (no division by zero). O(selection).
 */
export function regionComposition(
  selection: Uint32Array | Iterable<number>,
  groupCodes: Uint16Array | Uint32Array,
  categories: readonly string[],
): RegionComposition {
  const nCats = categories.length
  const counts = new Uint32Array(nCats)
  const n = groupCodes.length
  let total = 0
  const visit = (i: number): void => {
    if (i >= 0 && i < n) {
      const c = groupCodes[i]
      if (c < nCats) {
        counts[c]++
        total++
      }
    }
  }
  if (selection instanceof Uint32Array) {
    for (let k = 0; k < selection.length; k++) visit(selection[k])
  } else {
    for (const i of selection) visit(i)
  }
  const entries: RegionCompositionEntry[] = []
  for (let c = 0; c < nCats; c++) {
    if (counts[c] > 0) {
      entries.push({
        code: c,
        category: categories[c],
        count: counts[c],
        fraction: counts[c] / total,
      })
    }
  }
  entries.sort((a, b) => b.count - a.count || a.code - b.code)
  return { total, entries }
}
