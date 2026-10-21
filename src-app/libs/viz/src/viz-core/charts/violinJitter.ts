// violinJitter.ts — DETERMINISTIC per-cell jitter for the violin dot cloud, plus the two
// PURE producer helpers that back the violin's REAL cell-level selection (value-band brush +
// free lasso). Domain-agnostic (DEC-28): point / group / value / band — no biology terms.
//
// The dot cloud's screen-x for a cell is a STABLE hash of the cell's point INDEX (NOT
// Math.random, NOT re-rolled per frame), so a cell's on-screen position is reproducible
// across renders. That reproducibility is exactly what makes the dots a real selection
// surface: a lasso maps to SPECIFIC cells, and consume-emphasis can locate a given cell's
// dot. The FULL per-cell positions (`buildJitterPositions`) are the KD-tree + lasso input
// — never subsampled — while the DISPLAY layer may draw a density-adaptive SUBSET of them
// (the display sample ≠ the selection set; see ViolinView).
//
// PURE (no deck.gl, no React, no store), typed-array only, so it unit-tests in node.

import { groupMembers, type GroupIndex } from '../coordination/groupIndex'

/** A well-mixed 32-bit integer hash (xorshift-multiply finaliser; matches adaptiveSample). */
function hashU32(x: number): number {
  let h = x >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = h ^ (h >>> 16)
  return h >>> 0
}

/** A stable per-index pseudo-random in [0, 1) — a deterministic hash of the point index. */
export function jitterUnit(pointIndex: number): number {
  return hashU32(pointIndex >>> 0) / 4294967296
}

/**
 * The STABLE screen-x of a cell's jittered dot: `groupCenterX` offset by a deterministic
 * per-index amount within ±`jitterWidth`/2. Seeded by the point index via a cheap hash, so
 * the same index ALWAYS lands at the same x — reproducible across frames/renders, which is
 * what lets a lasso map to specific cells and lets consume-emphasis locate a cell's dot.
 * The result lies in `[groupCenterX − jitterWidth/2, groupCenterX + jitterWidth/2)`.
 */
export function jitterX(pointIndex: number, groupCenterX: number, jitterWidth: number): number {
  return groupCenterX + (jitterUnit(pointIndex) - 0.5) * jitterWidth
}

/**
 * Build the FULL per-cell jitter positions (`Float32Array` of length 2*N, interleaved
 * `[x, y]`) — the KD-tree + lasso input backing the violin's cell-level selection. Every
 * point gets an (x, y): x is the deterministic jitter around its group's center (`jitterX`),
 * y is `valueToY(value)` (identity by default, since the violin plots the raw value directly
 * on world-y). A point whose code is out of range (`>= groupCenters.length`) is PARKED at
 * NaN so the KD-tree excludes it (never selectable) — mirroring `buildGroupIndex`'s
 * out-of-range skip. NOT subsampled: this is the selection set, full N.
 */
export function buildJitterPositions(
  codes: Uint16Array | Uint32Array,
  values: ArrayLike<number>,
  groupCenters: readonly number[],
  jitterWidth: number,
  valueToY: (v: number) => number = v => v,
): Float32Array {
  const n = codes.length
  const nGroups = groupCenters.length
  const out = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const code = codes[i]
    if (code >= 0 && code < nGroups) {
      out[i * 2] = jitterX(i, groupCenters[code], jitterWidth)
      out[i * 2 + 1] = valueToY(values[i])
    } else {
      out[i * 2] = NaN
      out[i * 2 + 1] = NaN
    }
  }
  return out
}

/**
 * PRODUCER #1 — value-band brush. The point indices of GROUP `code` whose value falls in the
 * INCLUSIVE band `[y0, y1]` (order-insensitive: the caller may pass a drag's start/end in
 * either order). Scans ONLY that group's members via the CSR `GroupIndex` (`groupMembers`),
 * never all N. Members are ascending (stable counting sort) and each appears exactly once, so
 * the result is ascending + deduped. An empty/degenerate band, an out-of-range code, or an
 * empty group all yield an empty array.
 */
export function cellsInGroupValueBand(
  gi: GroupIndex,
  code: number,
  values: ArrayLike<number>,
  y0: number,
  y1: number,
): Uint32Array {
  const lo = Math.min(y0, y1)
  const hi = Math.max(y0, y1)
  const members = groupMembers(gi, code)
  const out: number[] = []
  for (let k = 0; k < members.length; k++) {
    const i = members[k]
    const v = values[i]
    if (v >= lo && v <= hi) out.push(i)
  }
  return Uint32Array.from(out)
}
