// matrixTypes.ts — the core, framework-agnostic types for the "matrix-as-multiscale-
// image" heatmap tier. A large numeric matrix (rows × columns; the COLUMN axis is the
// long one — e.g. 50 rows × 10,000,000 columns) is rendered as a GPU IMAGE, not as
// individual rectangles. These types are the CPU-side contract the pyramid planner,
// the reference downsample oracle, and (later) the GPU upload path all share.
//
// Domain-agnostic by construction: a "matrix" here is just rows × columns of scalar
// `value`s. Nothing in this file (or this whole module) names a domain — no gene, cell,
// or expression; only category/point/group/region/channel/value/column/row/matrix.
//
// ── STORAGE ORDER: COLUMN-MAJOR (documented once, obeyed everywhere) ──────────────
// `values` is stored **column-major**: the cell at (row, col) lives at index
// `col * rows + row` (see `matrixIndex`). A whole column is therefore a CONTIGUOUS run
// of `rows` bytes. This is deliberate, because the column axis is the one that gets
// tiled + streamed:
//   • A GPU tile is a contiguous span of columns `[c0, c1)`, so its bytes are exactly
//     `values.subarray(c0 * rows, c1 * rows)` — a zero-copy slice ready for texture
//     upload; a row-major layout would need a strided gather per tile.
//   • The downsample oracle aggregates the two source columns of an output column, and
//     in column-major those two source columns are two adjacent contiguous blocks —
//     cache-friendly, and the output column is a contiguous block too.
// Every reader/writer in this module goes through `matrixIndex`; never hand-inline the
// arithmetic with the other convention.

/** The value domain: uint8, `0..255` inclusive on both ends. */
export const VALUE_MIN = 0
export const VALUE_MAX = 255

/**
 * A dense numeric matrix. `values` is length `rows * cols`, **column-major**
 * (`values[col * rows + row]`; see the module header). `value ∈ [0, 255]` (uint8).
 */
export interface MatrixData {
  readonly rows: number
  readonly cols: number
  /** row-major? NO — **column-major**. Length `rows * cols`. See `matrixIndex`. */
  readonly values: Uint8Array
}

/**
 * An inclusive value-range filter `[lo, hi]` in the uint8 value domain (`0..255`). A
 * base cell "passes" iff `lo <= value <= hi` (both ends inclusive). Used by the
 * filter-aware pyramid recompute: at the base level the filter is applied per-cell (in
 * the GPU shader); at aggregated levels the pyramid is recomputed so each coarse cell
 * aggregates only the base cells whose value was in `[lo, hi]`.
 */
export interface MatrixValueRange {
  readonly lo: number
  readonly hi: number
}

/**
 * A pyramid LEVEL: a `MatrixData` plus an OPTIONAL parallel `counts` plane (same column-major
 * layout, length `rows * cols`). `counts[i]` is the number of in-range BASE cells that
 * were aggregated into coarse cell `i` — i.e. that cell's population/coverage.
 *
 * `counts[i] === 0` is the AUTHORITATIVE "empty bin" marker (no base cell under this
 * coarse cell passed the filter). The value plane at an empty bin holds `EMPTY_VALUE`,
 * but a value alone can NOT distinguish "real 0" from "empty" — always test `counts`.
 * `counts` is `Uint32Array` (not uint8): a level-k cell can cover up to `2^k` base
 * cells, which exceeds 255 within a few levels of a wide matrix.
 *
 * `counts` is ABSENT (`undefined`) only on the BASE level (level 0): every base cell is present
 * with weight 1, so materializing an all-ones plane (up to ~400 MB on a wide base) is pure waste.
 * An absent plane means "every cell covered / weight 1" — readers treat `!counts` as fully
 * covered (see `packLevelToRG`) and aggregators treat an absent source `counts` as weight 1 (see
 * `downsampleLevel`). Every level ≥ 1 carries a real `counts` plane.
 */
export interface MatrixLevel extends MatrixData {
  readonly counts?: Uint32Array
}

/**
 * Column-major linear index of cell (row, col): `col * rows + row`. The single source
 * of truth for the storage order (see the module header) — every access in this module
 * routes through here.
 */
export function matrixIndex(row: number, col: number, rows: number): number {
  return col * rows + row
}

/** Whether `value` passes an (inclusive) range filter; `undefined` filter passes all. */
export function valueInRange(value: number, filter?: MatrixValueRange): boolean {
  if (!filter) return true
  return value >= filter.lo && value <= filter.hi
}
