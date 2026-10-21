// matrixFixture.ts — a synthetic `MatrixData` fixture for the matrix-heatmap showcase +
// oracle tests. Produces a matrix with visible STRUCTURE — a low-frequency column
// gradient, alternating high/low column BLOCK bands, and a per-row lift — plus a small
// seeded jitter, so a downsample (means change smoothly) and a value-range filter
// (alternating blocks light up) both have something meaningful to show, rather than the
// featureless mush a uniform-noise fill would give.
//
// Deterministic (seeded mulberry32 — the same PRNG the sibling fixtures use). Pure
// typed-array output, column-major (see matrixTypes.ts), no deck.gl / React / I/O.
// Cheap: O(rows * cols); call it with tiny sizes in tests (e.g. rows 8, cols 64) and it
// scales linearly to large sizes (the same generator fills a 50 × 10M base if asked).

import { matrixIndex, VALUE_MAX, type MatrixData } from './matrixTypes'

/** mulberry32 — a tiny deterministic PRNG (seed → repeatable float stream in [0,1)). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MatrixFixtureOpts {
  /** number of matrix rows (the short axis). */
  rows: number
  /** number of matrix columns (the long / tiled axis). */
  cols: number
  /** RNG seed (default 1) — same seed ⇒ byte-identical output. */
  seed?: number
  /** number of alternating column blocks the band pattern splits into (default 8). */
  blocks?: number
  /** jitter amplitude as a fraction of the full value range (default 0.10). */
  noise?: number
}

/**
 * Build a structured, deterministic `MatrixData` (column-major). Each cell's value is a
 * blend of three low-frequency signals plus seeded jitter, then quantized to `0..255`:
 *   • a column GRADIENT (`col/(cols-1)`) — so an aggregated (downsampled) column varies
 *     smoothly and a mean is meaningfully different from its neighbours;
 *   • alternating column BLOCK bands (high ≈ 0.75, low ≈ 0.25) — so a value-range filter
 *     `[lo,hi]` selects roughly every other block, a visible on/off structure that the
 *     filter-aware recompute must preserve up the pyramid;
 *   • a per-ROW lift (`row/(rows-1)`) — so rows are distinguishable.
 * The jitter is drawn from the seeded PRNG in a fixed column-major order, so the byte
 * output is fully reproducible for a given `{rows, cols, seed}`.
 */
export function makeMatrixFixture(opts: MatrixFixtureOpts): MatrixData {
  const rows = Math.max(0, Math.floor(opts.rows))
  const cols = Math.max(0, Math.floor(opts.cols))
  const blocks = Math.max(1, Math.floor(opts.blocks ?? 8))
  const noiseAmp = opts.noise ?? 0.1
  const rng = mulberry32(opts.seed ?? 1)

  const values = new Uint8Array(rows * cols)
  const blockWidth = Math.max(1, Math.floor(cols / blocks))

  // Column-major fill: iterate columns (outer) then rows (inner) so a column is written
  // contiguously and the PRNG-draw order is stable + storage-order-aligned.
  for (let col = 0; col < cols; col++) {
    const gradient = cols > 1 ? col / (cols - 1) : 0
    const bandUp = Math.floor(col / blockWidth) % 2 === 0
    const band = bandUp ? 0.75 : 0.25
    for (let row = 0; row < rows; row++) {
      const rowLift = rows > 1 ? row / (rows - 1) : 0
      const base = 0.35 * gradient + 0.45 * band + 0.2 * rowLift
      const jitter = (rng() - 0.5) * noiseAmp
      let v = Math.round((base + jitter) * VALUE_MAX)
      if (v < 0) v = 0
      else if (v > VALUE_MAX) v = VALUE_MAX
      values[matrixIndex(row, col, rows)] = v
    }
  }

  return { rows, cols, values }
}
