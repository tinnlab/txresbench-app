// categoryFilter.ts — pure per-category show/hide policy for the categorical-points
// view. GENERIC by design: each point carries one categorical CODE, and the filter
// hides/shows points by category. There is no deck.gl / DOM / React here — it is the
// pure decision core (like scale/lod.ts) so it unit-tests in node.
//
// ── TWO filter designs, and WHY the categorical one is a UNIFORM update ───────────────
//
// The whole point of the categorical-points view is that toggling a category's
// visibility must NOT re-upload positions/colors (tens of millions of points). There are
// two ways to
// drive `@deck.gl/extensions` `DataFilterExtension`, and this module supplies the inputs
// for both:
//
//  • CATEGORY filter (PREFERRED — a true uniform update, up to 128 categories).
//    DataFilterExtension in `categorySize: 1` mode. Each point carries its category CODE
//    in the `getFilterCategory` attribute, uploaded to the GPU exactly ONCE. Which
//    categories are visible is the `filterCategories` prop, which deck folds into a
//    128-bit `categoryBitMask` (a `uvec4` UNIFORM). Toggling a category rewrites ONLY
//    that uniform — the per-point attribute (and positions/colors) never re-upload, and
//    there is NO per-point CPU loop on toggle. `visibleCategoryList()` builds that prop.
//    (deck runs its category→bit `transform` even on binary attributes — the binary
//    buffer falls through to the auto-updater when a `transform` is set — so the per-
//    point codes and the bitmask share one consistent category→bit map. That is what
//    makes the compact-code binary path correct.)
//
//  • MASK filter (FALLBACK — for > 128 distinct categories). DataFilterExtension in
//    `filterSize: 1` mode with `filterRange: [1, 1]`: a per-point 0/1 `getFilterValue`
//    attribute (`categoryVisibilityMask()`). Toggling a category REBUILDS + re-uploads
//    that N-length attribute (an O(N) CPU pass + one buffer upload). This is the honest
//    cost when the category count exceeds the 128-bit mask; it still never touches
//    positions/colors. `filterModeForCategoryCount()` picks between the two.

/** The `DataFilterExtension` category-bitmask holds 128 bits (a `uvec4`) at
 *  `categorySize: 1`, so the uniform-update path supports at most this many categories. */
export const MAX_UNIFORM_CATEGORIES = 128

export type FilterMode = 'category' | 'mask'

/**
 * Pick the filter design for a dataset with `distinctCategoryCount` distinct categories:
 * the uniform-update `'category'` path while it fits the 128-bit mask, else the per-point
 * `'mask'` fallback. Boundary is inclusive: exactly 128 categories still fits.
 */
export function filterModeForCategoryCount(distinctCategoryCount: number): FilterMode {
  const k = Math.max(0, Math.floor(distinctCategoryCount))
  return k <= MAX_UNIFORM_CATEGORIES ? 'category' : 'mask'
}

/**
 * The `filterCategories` prop for the categorical (uniform-update) path: the visible
 * category codes as a sorted-ascending array. Sorted so the value is deterministic (a
 * stable reference-independent list); deck diffs it to decide whether to recompute the
 * `categoryBitMask` uniform. Toggling a category = call this again with the new set — a
 * uniform rewrite, never an attribute re-upload.
 */
export function visibleCategoryList(visible: ReadonlySet<number>): number[] {
  return Array.from(visible).sort((a, b) => a - b)
}

/**
 * The per-point 0/1 visibility MASK for the fallback (`filterSize: 1`, `filterRange:
 * [1, 1]`) path: `mask[i] = 1` when point `i`'s category is visible, else `0`. Length
 * `n` (default = `categoryCodes.length`); indices beyond `categoryCodes.length` stay 0.
 * This is the ONLY design that costs an O(N) rebuild on toggle — used only when the
 * category count exceeds `MAX_UNIFORM_CATEGORIES`.
 */
export function categoryVisibilityMask(
  categoryCodes: Uint16Array | Uint32Array,
  visible: ReadonlySet<number>,
  n: number = categoryCodes.length,
): Uint8Array {
  const len = Math.max(0, Math.floor(n))
  const mask = new Uint8Array(len)
  const bound = Math.min(len, categoryCodes.length)
  for (let i = 0; i < bound; i++) {
    if (visible.has(categoryCodes[i])) mask[i] = 1
  }
  return mask
}

/**
 * Per-category occurrence counts: `counts[c]` = number of points whose code is `c`.
 * Length = `categoryCount` when given, else `max(code) + 1`. Out-of-length codes are
 * ignored (so a caller that under-sizes `categoryCount` can't overflow).
 */
export function countByCategory(
  categoryCodes: Uint16Array | Uint32Array,
  categoryCount?: number,
): Uint32Array {
  let len = categoryCount != null ? Math.max(0, Math.floor(categoryCount)) : 0
  if (categoryCount == null) {
    for (let i = 0; i < categoryCodes.length; i++) {
      if (categoryCodes[i] + 1 > len) len = categoryCodes[i] + 1
    }
  }
  const counts = new Uint32Array(len)
  for (let i = 0; i < categoryCodes.length; i++) {
    const c = categoryCodes[i]
    if (c >= 0 && c < len) counts[c]++
  }
  return counts
}

/**
 * The `k` most frequent category codes (descending count; ties broken by ascending
 * code, so the result is deterministic). Used to seed a sensible DEFAULT visible set for
 * a many-category dataset (show the top-k, hide the long tail). `k <= 0` → `[]`;
 * `k >= distinctCount` → every present category, still count-ordered.
 */
export function topCategoriesByCount(
  categoryCodes: Uint16Array | Uint32Array,
  k: number,
  categoryCount?: number,
): number[] {
  const want = Math.max(0, Math.floor(k))
  if (want === 0) return []
  const counts = countByCategory(categoryCodes, categoryCount)
  const present: number[] = []
  for (let c = 0; c < counts.length; c++) {
    if (counts[c] > 0) present.push(c)
  }
  present.sort((a, b) => (counts[b] - counts[a]) || (a - b))
  return present.slice(0, want)
}

/**
 * The visible-point COUNT for a visible-set — a cheap O(K) readout (K = category
 * count), summing the per-category counts of the visible categories. This is a derived
 * DISPLAY number only; the filter itself runs on the GPU (uniform/attribute), never from
 * this. Pass the memoised `countByCategory()` result so a toggle costs O(K), not O(N).
 */
export function visibleCount(counts: Uint32Array, visible: ReadonlySet<number>): number {
  let total = 0
  for (const c of visible) {
    if (c >= 0 && c < counts.length) total += counts[c]
  }
  return total
}
