// selectionSync.ts — PURE cross-plot selection mapping (DEC-25 / ITEM-25).
//
// A selection made in ANY grid cell writes a dense-index point selection into the
// Coordination store; every OTHER cell must then render it in its own idiom. This
// module is the framework-agnostic, testable CORE of that fan-out: it turns a point
// selection (a `Uint32Array` of dense indices) into the per-kind highlight artefacts
// each view consumes —
//
//   • `highlightMaskForPoints` — a per-point 0/1 buffer a `ScatterplotLayer` feeds to
//     a `DataFilterExtension` (getFilterValue + filterRange [1,1]) so it redraws ONLY
//     the selected points at full opacity over a dimmed base. A GPU attribute swap:
//     NO per-point CPU recolor on the hot path (the mask is built ONCE per selection).
//   • `selectedGroupCodes` — the set of categorical GROUP CODES a point selection
//     covers. This is what turns a scatter point-selection into "which heatmap
//     rows/columns light up": each selected point belongs to a group (its code), and
//     those groups' cells emphasise.
//   • `highlightedRowPositions` — the heatmap display rows a group-code set lights up.
//
// PURE (no deck.gl, no React, no store) so the mapping math is unit-tested in the
// node vitest pass; the store slice + the component read-sides build on these helpers.
//
// ITEM-7 (linked-highlight acceleration): the SELECTION→group direction above stays
// O(selection); the REVERSE — a set of GROUPS → the per-point highlight mask of their
// members (a heatmap row/group emphasising the scatter's points) — is O(N) if you scan
// every point testing `codes[i] ∈ groups`. When the caller precomputes a `GroupIndex`
// (the CSR membership index, built ONCE per grouping), that reverse becomes O(sum of
// selected group sizes) — see `highlightMaskForGroupSelection` below. The `groupIndex`
// param is OPTIONAL on every helper that accepts it: absent ⇒ the existing O(N) scan
// (back-compat), present ⇒ the O(group) contiguous-run path.

import {
  groupsInSelection,
  highlightMaskForGroups,
  type GroupIndex,
} from './groupIndex'

// Re-export the CSR index surface so a caller (HeatmapView + future linked views) can
// build + thread a `GroupIndex` through these helpers from a single import site.
export { buildGroupIndex, type GroupIndex } from './groupIndex'

/** Opacity the UNSELECTED (dimmed) points render at while a selection is active. The
 *  selected points redraw at full opacity in a separate `DataFilterExtension` overlay
 *  on top, so the net effect is "emphasise selected, dim the rest". */
export const DIM_OPACITY = 0.12

/** True when a point selection carries at least one index (a live selection to fan
 *  out). A `null` / empty selection means "no selection" → nothing dims or highlights. */
export function hasAnySelection(
  selection: Uint32Array | null | undefined,
): boolean {
  return selection != null && selection.length > 0
}

/**
 * The set of categorical group codes a point selection covers. Turns a scatter
 * point-selection into "which groups (heatmap rows/cols) light up": for every
 * selected dense index, read its group code from the per-point `codes` column.
 *
 * Out-of-range indices (`index >= codes.length`, e.g. a selection carried over from a
 * larger dataset) are ignored — never a crash, never a phantom code. An empty
 * selection yields an empty set.
 */
export function selectedGroupCodes(
  selection: Uint32Array,
  codes: Uint16Array | Uint32Array,
): Set<number> {
  const out = new Set<number>()
  const n = codes.length
  for (let k = 0; k < selection.length; k++) {
    const i = selection[k]
    if (i < n) out.add(codes[i])
  }
  return out
}

/**
 * A per-point 0/1 highlight buffer (`Uint8Array[n]`): `1` at every selected dense
 * index, `0` elsewhere. A `ScatterplotLayer` feeds this to a `DataFilterExtension`
 * (`getFilterValue`, `filterRange [1,1]`) to redraw ONLY the selected points at full
 * opacity over a dimmed base — a GPU attribute swap, NOT a per-point CPU recolor.
 *
 * Built once per selection change in O(selection) (+ the unavoidable O(n) zero-fill
 * allocation), which the caller memoises and hands to the layer as an attribute; the
 * per-frame render path never touches it in JS. Out-of-range indices are ignored; an
 * empty selection yields an all-zero buffer (nothing highlighted).
 */
export function highlightMaskForPoints(
  selection: Uint32Array,
  n: number,
): Uint8Array {
  const mask = new Uint8Array(n)
  for (let k = 0; k < selection.length; k++) {
    const i = selection[k]
    if (i < n) mask[i] = 1
  }
  return mask
}

/**
 * True when point `i` is DIMMED — i.e. NOT in the highlight mask (or out of range).
 * The complement of "selected"; the scatter base/overlay split uses it as the emphasis
 * predicate. An out-of-range index reads as dimmed (a point with no membership).
 */
export function isDimmed(mask: Uint8Array, i: number): boolean {
  return i < 0 || i >= mask.length || mask[i] === 0
}

/**
 * D (ITEM-7): the deck `getSelected` vertex attribute for the SINGLE-LAYER emphasis scatter — a
 * per-point 0/1 `Float32Array` derived from a highlight `mask` (Uint8), which the `SelectableScatterLayer`
 * shader reads to dim UNSELECTED points in-place (replacing the old base-dim + separate highlight-overlay
 * layer). A `null` mask (no active selection) ⇒ `undefined` (no attribute; the layer draws full-opacity).
 * Pure — the only new data transform D introduces, so it is unit-testable without a GL context.
 */
export function selectionAttribute(
  mask: Uint8Array | null,
): { value: Float32Array; size: 1 } | undefined {
  return mask ? { value: Float32Array.from(mask), size: 1 } : undefined
}

// ── Point-ID selection seam (multi-source correctness) ────────────────────────────
//
// `highlightMaskForPoints`/`selectedGroupCodes` above treat the shared point selection
// as ARRAY-INDEX values into "the" point set — correct ONLY when every view shares one
// identical, identically-ordered point array. For two independently-computed embeddings,
// a filtered subset, or two datasets, row `i` is a DIFFERENT point in each view, so an
// index-keyed selection highlights the wrong points.
//
// The fix: the shared selection carries STABLE CANONICAL IDs, and each view maps its own
// rows ↔ ids. A "point id" here is a domain-agnostic canonical POINT IDENTITY (a small
// dense non-negative integer) — NOT the string origin/panel id the Coordination
// store's `setSelection(originId, …)` origin uses (different concept, unfortunate word
// overlap). Two views of the SAME points share ids → their selections sync; disjoint
// point sets have disjoint ids → selection never crosses.
//
// DEFAULT IS IDENTITY: when a view has no `pointIds` it is treated as `pointIds[i] = i`,
// so `mapRowsToIds` is a copy and `buildIdToRow` is the identity function — the id path
// is then byte-identical to the old index path. This is a SEAM, not a behavior change
// for single-source views.

/** Sentinel returned by an `IdToRow` for a canonical id NOT present in this view. */
export const NO_ROW = -1

/** Reverse map: a canonical point id → this view's LOCAL row, or `NO_ROW` when the id is
 *  not present in the view (a selected id from another point set contributes nothing). */
export type IdToRow = (id: number) => number

/** The identity `pointIds` for an `n`-row view: `pointIds[i] = i`. A view with no explicit
 *  id column behaves as if it had this (single-source back-compat). */
export function identityPointIds(n: number): Uint32Array {
  const a = new Uint32Array(n)
  for (let i = 0; i < n; i++) a[i] = i
  return a
}

/**
 * Map a view's LOCAL selected rows → canonical point IDs (the PRODUCE direction): a view
 * that makes a selection publishes ids, not its own row indices. `pointIds[row]` is the
 * canonical id of local `row`. Absent / null `pointIds` ⇒ identity, so the result is a
 * plain copy of `rows` (the single-source case is a no-op — existing callers unchanged).
 * A row out of range for `pointIds` passes through unchanged (defensive; local rows are
 * always in range in practice).
 */
export function mapRowsToIds(
  rows: Uint32Array,
  pointIds?: Uint32Array | null,
): Uint32Array {
  if (!pointIds) return Uint32Array.from(rows)
  const out = new Uint32Array(rows.length)
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k]
    out[k] = r < pointIds.length ? pointIds[r] : r
  }
  return out
}

/**
 * Build the reverse id→row lookup for a view (the CONSUME direction). Representation: a
 * DENSE reverse array of length `maxId + 1` (an `Int32Array` indexed BY id), each slot
 * holding the local row that carries that id or `NO_ROW`. O(n) build, O(1) lookup.
 *
 * DENSE-ID ASSUMPTION: ids are small non-negative integers (as `identityPointIds` and a
 * permutation/subset of `0..N-1` produce). Sparse/huge ids waste memory (`maxId + 1`
 * slots); if a deployment ever needs sparse ids, swap the backing array for a `Map` here
 * — every caller goes through this function, so it's the single change point.
 *
 * Duplicate ids: the LAST row wins (documented; canonical ids should be unique per view).
 * An empty `pointIds` yields a lookup that returns `NO_ROW` for every id.
 *
 * For identity `pointIds` this returns the identity map (`id → id`), so a consumer built on
 * `highlightMaskForIds` is byte-identical to `highlightMaskForPoints`.
 */
export function buildIdToRow(pointIds: Uint32Array): IdToRow {
  let maxId = -1
  for (let r = 0; r < pointIds.length; r++) {
    if (pointIds[r] > maxId) maxId = pointIds[r]
  }
  const rev = new Int32Array(maxId + 1).fill(NO_ROW)
  for (let r = 0; r < pointIds.length; r++) rev[pointIds[r]] = r
  return (id: number) => (id >= 0 && id <= maxId ? rev[id] : NO_ROW)
}

/**
 * The id-aware analog of `highlightMaskForPoints`: a per-row 0/1 buffer (`Uint8Array[n]`)
 * for THIS view, built by mapping each selected canonical id → its local row via `idToRow`
 * and setting that row. A selected id NOT present in this view (`idToRow → NO_ROW`, or a
 * row out of range) contributes NOTHING — no spurious highlight. O(selection) + the O(n)
 * zero-fill; the layer consumes the mask exactly as before.
 *
 * With `idToRow = buildIdToRow(identityPointIds(n))` this equals `highlightMaskForPoints`.
 */
export function highlightMaskForIds(
  selectionIds: Uint32Array,
  idToRow: IdToRow,
  n: number,
): Uint8Array {
  const mask = new Uint8Array(n)
  for (let k = 0; k < selectionIds.length; k++) {
    const row = idToRow(selectionIds[k])
    if (row >= 0 && row < n) mask[row] = 1
  }
  return mask
}

/**
 * The id-aware analog of `selectedGroupCodes`: the set of group codes a canonical-id
 * selection covers IN THIS VIEW. Each selected id is mapped to its local row (`idToRow`),
 * then that row's group code is read from `codes`. A selected id absent from this view is
 * skipped (no phantom code); an in-view row past `codes.length` is skipped. Empty
 * selection ⇒ empty set.
 *
 * With an identity `idToRow` this equals `selectedGroupCodes(selection, codes)`.
 */
export function selectedGroupCodesByIds(
  selectionIds: Uint32Array,
  idToRow: IdToRow,
  codes: Uint16Array | Uint32Array,
): Set<number> {
  const out = new Set<number>()
  const n = codes.length
  for (let k = 0; k < selectionIds.length; k++) {
    const row = idToRow(selectionIds[k])
    if (row >= 0 && row < n) out.add(codes[row])
  }
  return out
}

// ── Group-mark emphasis (box / violin / bar / dotplot) ──────────────────────────
//
// The scatter/heatmap fan-out above works on POINTS/ROWS. The other statistical charts
// draw one mark PER GROUP (a box, a violin, a bar, a dot-row), so their emphasis is
// coarser: a group's mark lights up iff the shared point-selection covers ≥1 point in
// that group. These two helpers are that group-level analog — O(selection) once to
// resolve the covered codes, then O(1) per group at render. A per-MARK (per-group, small
// N) opacity change; NO per-point loop on the render hot path.

/** An RGBA color tuple (kept local so this module stays free of the chart-layer deps). */
export type MarkColor = [number, number, number, number]

/** The per-group emphasis a point selection implies for a group-based chart: the set of
 *  GROUP CODES the selection covers, plus whether a selection is even active. When
 *  `active` is false NOTHING dims (every group renders normally); when true a group's
 *  mark emphasises iff its code is in `selectedCodes`. Reuses `hasAnySelection` +
 *  `selectedGroupCodes`, so an empty/null selection yields `{ active:false, ∅ }`. */
export interface GroupEmphasis {
  readonly selectedCodes: Set<number>
  readonly active: boolean
}

export function groupEmphasis(
  selection: Uint32Array | null | undefined,
  codes: Uint16Array | Uint32Array,
): GroupEmphasis {
  const active = hasAnySelection(selection)
  return {
    selectedCodes: active ? selectedGroupCodes(selection!, codes) : new Set<number>(),
    active,
  }
}

/** The id-aware analog of `groupEmphasis`: resolve the covered group codes by mapping the
 *  canonical-id selection through THIS view's `idToRow` (so a code lights up iff the
 *  selection covers ≥1 of its cells BY ID, not by array position). Absent/empty selection
 *  ⇒ `{ active:false, ∅ }`. With an identity `idToRow` this equals `groupEmphasis`. */
export function groupEmphasisByIds(
  selection: Uint32Array | null | undefined,
  idToRow: IdToRow,
  codes: Uint16Array | Uint32Array,
): GroupEmphasis {
  const active = hasAnySelection(selection)
  return {
    selectedCodes: active
      ? selectedGroupCodesByIds(selection!, idToRow, codes)
      : new Set<number>(),
    active,
  }
}

/** The opacity FACTOR a single group's mark renders at: `1` when no selection is active
 *  OR the group is one the selection covers; `DIM_OPACITY` for every other group while a
 *  selection is active. O(1) per group — the group charts multiply their mark's fill
 *  alpha by this. */
export function markOpacity(
  code: number,
  selectedCodes: ReadonlySet<number>,
  active: boolean,
): number {
  if (!active) return 1
  return selectedCodes.has(code) ? 1 : DIM_OPACITY
}

/** Scale an RGBA color's ALPHA by a mark-opacity factor. Returns the SAME color tuple
 *  when the factor is 1 (a no-op — the fill is byte-unchanged for an inactive selection
 *  or a selected group); otherwise a copy with only the alpha channel dimmed. */
export function applyMarkOpacity(color: MarkColor, opacity: number): MarkColor {
  if (opacity === 1) return color
  return [color[0], color[1], color[2], Math.round(color[3] * opacity)]
}

/**
 * The DISPLAY positions of the rows a group-code set highlights, given the (possibly
 * cluster-reordered) `rowOrder` that maps a display position → the original row index.
 *
 * In the heatmap the original row index of a group IS its group code (rows are the
 * categories in code order), so a display row highlights when its original index is in
 * `groupCodes`. Pure — the heatmap feeds the returned positions to an overlay band
 * layer that marks the matching group rows. An empty code set yields no positions.
 */
export function highlightedRowPositions(
  rowOrder: readonly number[],
  groupCodes: ReadonlySet<number>,
): number[] {
  if (groupCodes.size === 0) return []
  const out: number[] = []
  for (let i = 0; i < rowOrder.length; i++) {
    if (groupCodes.has(rowOrder[i])) out.push(i)
  }
  return out
}

// ── GroupIndex-accelerated linked highlight (ITEM-7) ─────────────────────────────

/**
 * The set of group codes a point selection covers — the SELECTION→group direction, with
 * an OPTIONAL `GroupIndex` fast path. Result-identical to `selectedGroupCodes` for the
 * heatmap row highlight: both are O(selection) (each reads `codes[i]` per selected
 * index). Passing `groupIndex` routes through `groupsInSelection`, which additionally
 * bounds the result to codes present in the index (`code < nGroups`) so it stays
 * consistent with the CSR partition — an out-of-range code never matches a display row
 * anyway, so the rows that light up are byte-identical. Absent ⇒ the existing
 * `selectedGroupCodes` scan (back-compat).
 */
export function resolveSelectionGroupCodes(
  selection: Uint32Array,
  codes: Uint16Array | Uint32Array,
  groupIndex?: GroupIndex,
): Set<number> {
  return groupIndex
    ? groupsInSelection(groupIndex, selection, codes)
    : selectedGroupCodes(selection, codes)
}

/**
 * The per-point 0/1 highlight mask (`Uint8Array[n]`) for a set of GROUP codes — the
 * REVERSE of `selectedGroupCodes`: given the groups to emphasise (e.g. a heatmap
 * row/group the user picked), light up their member POINTS for the scatter's
 * `DataFilterExtension`. Interchangeable at the layer with `highlightMaskForPoints`.
 *
 * With a `groupIndex` this is the O(group) path: `highlightMaskForGroups` writes over
 * ONLY each selected group's contiguous index run (O(sum of selected group sizes)),
 * never touching the other N−|members| points. WITHOUT one it falls back to the O(N)
 * per-point membership scan (`codes[i] ∈ groupCodes`) — the two produce a byte-identical
 * mask (proven in the unit test); the index only changes the complexity. An empty
 * `groupCodes` yields an all-zero mask; out-of-range codes / member indices are ignored.
 *
 * `nGroups` (optional): the group count, used ONLY by the O(N) fallback to drop codes
 * `>= nGroups` — the SAME clamp the CSR path applies implicitly (`highlightMaskForGroups`
 * skips out-of-range codes, and `buildGroupIndex` never indexed a point whose own code is
 * `>= nGroups`). Pass it (typically `groupIndex.offsets.length - 1`, or the row/category
 * count) so the fallback is byte-identical to the CSR path even when the `codes` column
 * itself carries an out-of-range value that is also present in `groupCodes`. Omitted ⇒ no
 * clamp (back-compat; identical to the CSR path whenever every `codes[i] < nGroups`).
 */
export function highlightMaskForGroupSelection(
  groupCodes: ReadonlySet<number>,
  n: number,
  codes: Uint16Array | Uint32Array,
  groupIndex?: GroupIndex,
  nGroups?: number,
): Uint8Array {
  if (groupIndex) {
    // `highlightMaskForGroups` only iterates the set (for..of), so a ReadonlySet is safe.
    return highlightMaskForGroups(groupIndex, groupCodes as Set<number>, n)
  }
  // O(N) fallback: scan every in-range point and test group membership. When `nGroups` is
  // known, filter `groupCodes` to `[0, nGroups)` FIRST so a stray code `>= nGroups` (which
  // the CSR path silently drops) can't light up a point whose `codes[i]` equals it — keeping
  // the two paths byte-identical regardless of input. Omitted ⇒ the original unclamped scan.
  const effectiveCodes =
    nGroups == null
      ? groupCodes
      : new Set<number>([...groupCodes].filter(c => c >= 0 && c < nGroups))
  const mask = new Uint8Array(n)
  const len = Math.min(n, codes.length)
  for (let i = 0; i < len; i++) {
    if (effectiveCodes.has(codes[i])) mask[i] = 1
  }
  return mask
}
