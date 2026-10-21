// faceting.ts — the PURE facet-partition math (ITEM-46). FACETING / small-multiples
// splits a dataset by a CATEGORICAL column into one subset ("facet") per category value,
// laid out in a row/grid of mini-views that SHARE scales. GENERIC, domain-agnostic
// (DEC-28): a facet is just "the points whose categorical code == c"; nothing here is
// bio-specific. No React, no deck.gl — unit-testable in node.
//
// The point-membership is exposed as `Uint32Array` index lists (for a subarray path or a
// count), but the GPU render path filters by the categorical CODE attribute + a per-view
// filterRange uniform — so all facets share ONE positions/codes buffer, zero-copy.

/** One facet: the subset of points sharing a single categorical value. */
export interface Facet {
  /** The categorical code this facet holds (0..categories.length-1). */
  readonly code: number
  /** Human label from the categorical's category list. */
  readonly label: string
  /** Canonical point indices (0..N-1) belonging to this facet. May be empty. */
  readonly indices: Uint32Array
}

/** A `{rows, cols}` grid arrangement for `nFacets` mini-views. */
export interface FacetGridLayout {
  readonly rows: number
  readonly cols: number
}

/**
 * Partition points into one `Facet` per category value. Two-pass (count → fill) so each
 * facet's `indices` is an exactly-sized `Uint32Array`. EVERY category yields a facet —
 * an empty category gets a length-0 `indices` (never dropped). Points whose code is out
 * of range (≥ categories.length) are ignored (defensive). The union of all facets'
 * indices covers every in-range point exactly once (a partition).
 */
export function partitionByCategorical(
  codes: Uint16Array | Uint32Array | Int32Array | readonly number[],
  categories: readonly string[],
): Facet[] {
  const nCat = categories.length
  const counts = new Uint32Array(nCat)
  const n = codes.length
  for (let i = 0; i < n; i++) {
    const c = codes[i]
    if (c >= 0 && c < nCat) counts[c]++
  }
  const facets: { code: number; label: string; indices: Uint32Array }[] = []
  const cursors = new Uint32Array(nCat)
  for (let c = 0; c < nCat; c++) {
    facets.push({ code: c, label: categories[c], indices: new Uint32Array(counts[c]) })
  }
  for (let i = 0; i < n; i++) {
    const c = codes[i]
    if (c >= 0 && c < nCat) {
      facets[c].indices[cursors[c]++] = i
    }
  }
  return facets
}

/**
 * Grid dimensions for `nFacets` mini-views, capped at `maxCols` columns. Fills rows
 * left-to-right, top-to-bottom (`cols = min(maxCols, nFacets)`, `rows = ceil(n/cols)`).
 * `nFacets === 0` → `{rows:0, cols:0}`.
 */
export function facetGridLayout(
  nFacets: number,
  opts: { maxCols?: number } = {},
): FacetGridLayout {
  const maxCols = Math.max(1, Math.floor(opts.maxCols ?? 4))
  if (nFacets <= 0) return { rows: 0, cols: 0 }
  const cols = Math.min(maxCols, nFacets)
  const rows = Math.ceil(nFacets / cols)
  return { rows, cols }
}

/**
 * The SHARED value domain `[min,max]` across ALL facets — the union of `valueOf(index)`
 * over every facet's points — so every mini-view can plot on ONE common scale. Skips
 * non-finite values. Returns `[0, 0]` when there are no finite values at all.
 */
export function sharedDomain(
  facets: readonly Facet[],
  valueOf: (index: number) => number,
): [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const facet of facets) {
    const idx = facet.indices
    for (let i = 0; i < idx.length; i++) {
      const v = valueOf(idx[i])
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 0]
  return [min, max]
}
