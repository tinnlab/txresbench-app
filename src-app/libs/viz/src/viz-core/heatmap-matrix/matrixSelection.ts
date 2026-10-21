// matrixSelection.ts — PURE helpers that join the matrix heatmap to the cross-plot
// COORDINATION selection (DEC-25 / ITEM-25). NO deck.gl / WebGL / React here — just
// integer arithmetic over typed arrays, so every rule is directly unit-testable and the
// GPU shader (the per-column dim) can be checked against the same math.
//
// CONTRACT: in this heatmap **each BASE COLUMN is a point** — the base column index IS the
// dense point index the shared Coordination `pointSelection` carries. So a selection of dense
// indices maps directly onto columns, and every OTHER linked view (scatter, …) shares that
// index space.
//
// TODO(point-id): this identity contract (base column index == canonical point id) holds only
// for the single-source case. To sync against a view over a DIFFERENT point set/order, thread a
// row→id `pointIds` map: CONSUME by mapping the shared ids → local base columns via
// `buildIdToRow`/`highlightMaskForIds`, and PRODUCE by mapping the brushed column indices →
// canonical ids via `mapRowsToIds` before writing the store (the seam GridWorkspace/ViolinView use).
//
// Two directions:
//   • CONSUME — `columnSelectionMaskForLevel` turns a point/column selection into a
//     per-DISPLAYED-LEVEL 1/0 column mask (a level-column is "lit" iff ANY base column it
//     covers is selected — a downsample-OR). The view slices this to the uploaded window +
//     hands it to the layer as a 1-row R8 texture; the shader dims un-lit columns.
//   • PRODUCE — `columnRangeToPointIndices` turns a brushed contiguous column span into the
//     dense point indices the view writes into the shared store.
//
// POINT-ID SEAM (multi-source): both functions accept an OPTIONAL `pointIds` (row→id) map.
// Absent ⇒ the identity contract above (base column index == canonical point id), byte-for-byte
// unchanged. Present ⇒ CONSUME resolves the incoming canonical ids → local base columns via
// `buildIdToRow`/`highlightMaskForIds` before the downsample-OR, and PRODUCE maps the brushed
// local columns → canonical ids via `mapRowsToIds` — the same seam GridWorkspace/ViolinView use.

import {
  buildIdToRow,
  highlightMaskForIds,
  mapRowsToIds,
} from '../coordination/selectionSync'

/**
 * Build the per-LEVEL column "lit" mask (length `levelCols`) a displayed pyramid level
 * needs to dim unselected columns. `mask[j] === 1` ⟺ level-column `j` is LIT (rendered
 * full); `0` ⟺ dimmed.
 *
 * At the BASE level (`level === 0`, step `2^0 === 1`) a level-column `j` covers exactly base
 * column `j`, so the mask IS the point selection (identity: `mask[j] = 1` iff `j ∈ selection`).
 * At an AGGREGATED level `L` (step `2^L`) a level-column `j` covers base columns
 * `[j*2^L, (j+1)*2^L)`, and is lit iff ANY of those base columns is selected — a
 * **downsample-OR** of the base selection.
 *
 * EMPTY-selection sentinel: a `null` / empty selection yields an ALL-LIT mask
 * (`fill(1)`) — "no selection ⇒ nothing dims" (the shader also skips dimming via its
 * `selectionActive` uniform, so this is defence-in-depth). Out-of-range indices
 * (`< 0` or `>= baseCols`) are ignored — never a crash, never a phantom lit column.
 *
 * `pointIds` (optional, multi-source seam): when given, the incoming `selection` carries
 * canonical POINT IDs rather than local base-column indices, so each id is resolved to this
 * view's local base column via the shared `buildIdToRow`/`highlightMaskForIds` seam BEFORE the
 * downsample-OR (an id absent from this view lights nothing). Absent (or an identity
 * `pointIds[i] = i`) ⇒ the identity path above, byte-for-byte unchanged.
 */
export function columnSelectionMaskForLevel(
  selection: Uint32Array | null | undefined,
  baseCols: number,
  level: number,
  levelCols: number,
  pointIds?: Uint32Array,
): Uint8Array {
  const cols = Math.max(0, Math.floor(levelCols))
  const mask = new Uint8Array(cols)
  if (!selection || selection.length === 0) {
    mask.fill(1) // no-dim sentinel: everything lit ⇒ nothing dims
    return mask
  }
  const step = Math.pow(2, Math.max(0, Math.floor(level))) // base cols per level-col
  if (pointIds) {
    // Multi-source: `selection` is canonical ids. Resolve ids → a per-base-column 0/1 mask
    // via the shared seam (out-of-view ids / out-of-range rows contribute nothing), then run
    // the SAME downsample-OR over the lit base columns.
    const idToRow = buildIdToRow(pointIds)
    const baseMask = highlightMaskForIds(selection, idToRow, Math.max(0, Math.floor(baseCols)))
    for (let c = 0; c < baseMask.length; c++) {
      if (baseMask[c] === 0) continue
      const j = Math.floor(c / step) // the level-column covering base column c
      if (j >= 0 && j < cols) mask[j] = 1 // downsample-OR: any covered base col lights it
    }
    return mask
  }
  for (let k = 0; k < selection.length; k++) {
    const c = selection[k]
    if (c < 0 || c >= baseCols) continue // out-of-range index → ignored
    const j = Math.floor(c / step) // the level-column covering base column c
    if (j >= 0 && j < cols) mask[j] = 1 // downsample-OR: any covered base col lights it
  }
  return mask
}

/**
 * Turn a brushed contiguous COLUMN span into the dense point indices to write into the
 * shared selection. The span is **half-open `[c0, c1)`** — `c0` INCLUSIVE, `c1` EXCLUSIVE
 * (so a brush over columns `3..5` selects `[3, 4, 5]`, i.e. `columnRangeToPointIndices(3, 6)`),
 * matching this module's window convention (`packLevelToRG`).
 *
 * `c0` is clamped up to `0` (a brush that starts left of the matrix begins at column 0); the
 * CALLER pre-clamps `c1` to the matrix width (`baseCols`). A degenerate or inverted range
 * (`c1 <= c0`) yields an EMPTY array (never a negative-length allocation). Since a base column
 * index IS its dense point index, the returned indices are exactly `c0 .. c1-1`.
 *
 * `pointIds` (optional, multi-source seam): when given, the brushed LOCAL column indices are
 * mapped to canonical POINT IDs via the shared `mapRowsToIds` seam before being published, so
 * a view over a different point order publishes ids other views can resolve. Absent (or an
 * identity `pointIds[i] = i`) ⇒ the identity path above (column index IS the id), unchanged.
 */
export function columnRangeToPointIndices(
  c0: number,
  c1: number,
  pointIds?: Uint32Array,
): Uint32Array {
  const lo = Math.max(0, Math.floor(c0))
  const hi = Math.floor(c1)
  if (hi <= lo) return new Uint32Array(0) // empty or inverted range → empty selection
  const out = new Uint32Array(hi - lo)
  for (let i = 0; i < out.length; i++) out[i] = lo + i
  // Multi-source: map local columns → canonical ids. Absent ⇒ `out` returned as-is (identity).
  return pointIds ? mapRowsToIds(out, pointIds) : out
}
