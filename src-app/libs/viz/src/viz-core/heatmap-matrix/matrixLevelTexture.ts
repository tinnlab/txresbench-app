// matrixLevelTexture.ts — PURE helpers that turn a `MatrixLevel` (or a column-window of
// one) into GPU-ready texture bytes for the `MatrixHeatmapLayer`, plus the level-of-detail
// selection + picking-decode math. NO deck.gl / WebGL / React here — just typed-array
// packing and integer arithmetic, so every rule below is directly unit-testable and the
// GPU shader can be checked against it.
//
// ── THE RG8 DATA TEXTURE (value + coverage) ───────────────────────────────────────
// `packLevelToRG` packs a column-window `[colStart, colEnd)` of a level into an RG8 texture
// of width `colEnd-colStart` and height `rows`:
//   • texel (x, y) holds the level cell (row = y, col = colStart + x);
//   • channel **R = value** (the cell's uint8 value, 0..255);
//   • channel **G = coverage** = `min(counts, 255)` — a saturated population/coverage short.
// The single most important consequence: **G === 0 ⟺ empty bin** (because `counts === 0` is
// the authoritative empty marker — see matrixTypes.ts — and `min(0,255) === 0`, while any
// `counts >= 1` saturates to `>= 1`). That is what lets the fragment shader render an empty
// bin as fully transparent with a single `if (G == 0) discard`.
//
// A level with NO `counts` plane (the base level — see matrixTypes.ts) means "every cell covered,
// weight 1": the packer writes `G = 1` (fully covered, never discarded) for every texel of it.
//
// Texture-byte order is standard row-major with 2 channels: byte offset of texel (x, y) is
// `(y * width + x) * 2` (R) and `+ 1` (G). The SOURCE `MatrixLevel` is COLUMN-MAJOR
// (`values[col * rows + row]`, via `matrixIndex`), so the pack transposes column-major →
// row-major texel order as it copies.

import { matrixIndex, type MatrixLevel } from './matrixTypes'

/** Max GPU texture dimension a single data-texture window may span (deck/luma cap). */
export const MAX_TEXTURE_DIM = 32768

/** The value written to G for a cell — `min(counts, 255)`; **0 ⟺ empty bin**. */
export function coverageByte(count: number): number {
  const c = Math.floor(count)
  if (c <= 0) return 0
  return c >= 255 ? 255 : c
}

/**
 * Pack the column-window `[colStart, colEnd)` of `level` into an RG8 texture byte array.
 *
 * Result length is `(colEnd - colStart) * rows * 2`. For texel (x, y): `R = value`,
 * `G = coverageByte(counts)` where the source cell is `(row = y, col = colStart + x)` read
 * column-major via `matrixIndex`. `G === 0` marks an empty bin (see the module header). A level
 * with NO `counts` plane (the base level) is "every cell covered / weight 1", so `G = 1` for all
 * of it.
 *
 * `colStart`/`colEnd` are a HALF-OPEN range in the level's own column coordinates; they are
 * clamped to `[0, level.cols]`. An empty/degenerate range yields a zero-length array.
 */
export function packLevelToRG(level: MatrixLevel, colStart: number, colEnd: number): Uint8Array {
  const rows = level.rows
  const counts = level.counts
  const c0 = Math.max(0, Math.min(level.cols, Math.floor(colStart)))
  const c1 = Math.max(c0, Math.min(level.cols, Math.floor(colEnd)))
  const width = c1 - c0
  const out = new Uint8Array(width * rows * 2)
  for (let x = 0; x < width; x++) {
    const col = c0 + x
    for (let y = 0; y < rows; y++) {
      const si = matrixIndex(y, col, rows)
      const o = (y * width + x) * 2
      out[o] = level.values[si]
      // No counts plane ⇒ every cell covered (weight 1): write G = 1 (never discarded).
      out[o + 1] = counts ? coverageByte(counts[si]) : 1
    }
  }
  return out
}

/**
 * Choose the pyramid level so ~1 texel maps to ~1 screen pixel. `cellsPerPixel` is how many
 * BASE cells span one screen pixel at the current zoom; a level halves the column axis, so
 * the natural choice is `round(log2(cellsPerPixel))`, clamped to a valid level index.
 *
 *   `level = clamp(round(log2(max(1, cellsPerPixel))), 0, levelCount - 1)`
 *
 * Hand-worked: `cellsPerPixel <= 1 → 0`; `= 2 → 1`; `= 4 → 2`; a huge value clamps to the
 * coarsest level `levelCount - 1`.
 */
export function pickLevel(cellsPerPixel: number, levelCount: number): number {
  const top = Math.max(0, levelCount - 1)
  const cpp = Math.max(1, cellsPerPixel)
  const raw = Math.round(Math.log2(cpp))
  if (raw < 0) return 0
  return raw > top ? top : raw
}

/** A picked cell: which pyramid `level`, and its `(row, col)` in that level's coordinates. */
export interface PickedCell {
  readonly level: number
  readonly col: number
  readonly row: number
}

/**
 * Map a picked texel back to its `(row, col)` at its pyramid `level`. `tileColStart` is the
 * level-column of the uploaded window's first texel, so `col = tileColStart + texelX` is the
 * cell's column in the level's own coordinates (for the base level this IS the base column,
 * since level 0 columns == base columns). `row = texelY`.
 */
export function decodePickedCell(
  level: number,
  tileColStart: number,
  texelX: number,
  texelY: number,
): PickedCell {
  return { level, col: tileColStart + texelX, row: texelY }
}

/**
 * Decode a picking-color RGB into its texel `(texelX, texelY)`, MIRRORING the layer shader's
 * LINEAR row-major encode `enc = texelY*texWidth + texelX` (little-endian 24-bit: r=low byte).
 * `texWidth` is the picked layer's data-texture width. This supersedes the old
 * `texelX*256 + texelY` scheme, which silently mis-decoded any row ≥ 256 (`enc % 256` only
 * recovers `texelY` when `texelY < 256`); the linear scheme is correct for any row count while
 * the total texel index stays under 2^24 (~16.7M).
 */
export function decodePickTexel(
  color: Uint8Array | number[],
  texWidth: number,
): { texelX: number; texelY: number } {
  const enc = color[0] + color[1] * 256 + color[2] * 65536
  const w = texWidth > 0 ? texWidth : 1
  return { texelX: enc % w, texelY: Math.floor(enc / w) }
}
