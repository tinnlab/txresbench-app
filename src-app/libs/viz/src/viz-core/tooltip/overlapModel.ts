// overlapModel.ts — PURE ordering + lazy resolution for OVERLAP tooltips (the top-3 + "N more"
// model, shared by point mode and raster mode). Both modes hand this a set of overlapping point
// indices; this orders them NEAREST-TO-CURSOR first and builds ONLY the top-N tooltip rows (the
// full list is resolved lazily, per visible row, by the dialog). Reuses `resolveTooltip` so a row
// is identical to a single-point tooltip.
//
// No deck.gl / DOM / React — index + typed-array math, node-unit-testable.

import { resolveTooltip, type TooltipField, type TooltipResult } from './tooltipModel'

export interface OverlapResolution {
  /** ≤ topN resolved tooltips, nearest-cursor first. */
  readonly top: TooltipResult[]
  /** ALL overlapping indices, nearest-first — the dialog builds rows from these lazily. */
  readonly ordered: Uint32Array
  /** how many beyond `top` (the "N more" count); 0 when everything fit in `top`. */
  readonly moreCount: number
  /** total overlapping points. */
  readonly total: number
}

/**
 * Order `indices` by squared world distance to `(cursorX, cursorY)`, nearest first, with a STABLE
 * tiebreak on the point index (so equal-distance points have a deterministic order across modes).
 * Returns a fresh Uint32Array. O(k log k) for k = `indices.length` (a hovered bin / pick region),
 * never O(N).
 */
export function orderByCursor(
  indices: Uint32Array | readonly number[],
  positions: Float32Array,
  cursorX: number,
  cursorY: number,
): Uint32Array {
  const arr = Array.from(indices)
  arr.sort((a, b) => {
    const dxa = positions[2 * a] - cursorX
    const dya = positions[2 * a + 1] - cursorY
    const dxb = positions[2 * b] - cursorX
    const dyb = positions[2 * b + 1] - cursorY
    const da = dxa * dxa + dya * dya
    const db = dxb * dxb + dyb * dyb
    if (da !== db) return da - db
    return a - b // stable tiebreak
  })
  return Uint32Array.from(arr)
}

/**
 * Order the overlapping `indices` nearest-first and resolve ONLY the top-N tooltip rows (the rest
 * stay unresolved — the dialog builds them lazily via {@link resolveOverlapRow}). `topN` defaults
 * to 3. When `total <= topN`, `moreCount` is 0 (no "N more").
 */
export function resolveOverlap(
  indices: Uint32Array | readonly number[],
  positions: Float32Array,
  cursorX: number,
  cursorY: number,
  fields: readonly TooltipField[],
  topN = 3,
): OverlapResolution {
  const ordered = orderByCursor(indices, positions, cursorX, cursorY)
  const total = ordered.length
  const n = Math.min(Math.max(0, topN), total)
  const top: TooltipResult[] = []
  for (let i = 0; i < n; i++) top.push(resolveTooltip(fields, ordered[i]))
  return { top, ordered, moreCount: total - n, total }
}

/** Resolve ONE overlapping point's tooltip (the dialog's per-visible-row lazy builder). Identical
 *  to a single-point hover tooltip — reuses `resolveTooltip`. */
export function resolveOverlapRow(index: number, fields: readonly TooltipField[]): TooltipResult {
  return resolveTooltip(fields, index)
}
