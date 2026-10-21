// heatmapExtras.ts — pure helpers that ENRICH the BitmapLayer heatmap (ITEM-36/37/38):
// row/col dendrogram tree paths, per-row z-score normalization, and a categorical
// annotation-track texture. STRICT all-GPU / no-SVG (DEC-18/23): dendrograms are
// `PathLayer` polylines, tracks are `BitmapLayer` `ImageData`, never SVG. Naming is
// domain-agnostic (DEC-28): `row`/`col`/`leaf`/`code`/`category` — no biology terms.
// Every function is PURE (no GL context, no store, no I/O) so it unit-tests in node;
// the degenerate contract (empty / single / flat) mirrors `statsKernels` — never throw,
// never emit NaN geometry.

import { categoryColor } from '../data/color'
import type { Merge } from '../data/statsKernels'
import type { RGBA } from './chartLayers'

// ── 1. Dendrogram tree paths (ITEM-36) ───────────────────────────────────────────

/** One inverted-U branch of a dendrogram as a `PathLayer` polyline (+ its color). */
export interface DendrogramPath {
  readonly path: [number, number][]
  readonly color: RGBA
}

export interface DendrogramOpts {
  /** `row` → tree grows along −x beside the rows; `col` → along −y above the cols. */
  readonly side: 'row' | 'col'
  /** How far (data units) the tree extends perpendicular to the leaf axis. */
  readonly extent: number
  /** Branch color (default a neutral gray). */
  readonly color?: RGBA
}

/**
 * Turn a merge sequence (from `hierarchicalClustering`) into an array of inverted-U
 * `PathLayer` polylines positioned alongside the matrix. Each leaf sits at its rank in
 * `order` along the leaf axis; each merge draws a U from child a up to the join height,
 * across to child b, and down to b — so N leaves (N−1 merges) yield **N−1** branch
 * polylines. Heights are normalized to `extent` and mapped onto the perpendicular axis
 * (negative, so the tree sits outside the matrix). Empty / single-leaf → `[]`.
 */
export function dendrogramPaths(
  merges: readonly Merge[],
  order: readonly number[],
  count: number,
  opts: DendrogramOpts,
): DendrogramPath[] {
  const n = count
  if (n <= 1 || merges.length === 0) return []
  const color: RGBA = opts.color ?? [90, 90, 90, 255]
  const { extent, side } = opts

  // Original leaf id → its position along the leaf axis (rank in the display order).
  const leafAxisPos = new Array<number>(n).fill(0)
  for (let i = 0; i < order.length; i++) leafAxisPos[order[i]] = i + 0.5

  // Per-cluster leaf-axis position + merge height (leaves start at height 0).
  const pos = new Map<number, number>()
  const ht = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    pos.set(i, leafAxisPos[i])
    ht.set(i, 0)
  }

  let maxH = 0
  for (const m of merges) if (m.height > maxH) maxH = m.height
  if (!(maxH > 0)) maxH = 1 // flat tree (all-zero heights) → avoid /0

  const toXY = (leafAxis: number, heightVal: number): [number, number] => {
    const perp = -(heightVal / maxH) * extent
    return side === 'row' ? [perp, leafAxis] : [leafAxis, perp]
  }

  const paths: DendrogramPath[] = []
  merges.forEach((m, k) => {
    const pa = pos.get(m.a) ?? 0
    const pb = pos.get(m.b) ?? 0
    const ha = ht.get(m.a) ?? 0
    const hb = ht.get(m.b) ?? 0
    const h = m.height
    paths.push({
      path: [toXY(pa, ha), toXY(pa, h), toXY(pb, h), toXY(pb, hb)],
      color,
    })
    const id = n + k // scipy Z convention: the k-th merge creates internal id n+k
    pos.set(id, (pa + pb) / 2)
    ht.set(id, h)
  })
  return paths
}

// ── 2. Per-row z-score normalization (ITEM-38) ────────────────────────────────────

/**
 * Z-score standardize each ROW of a row-major `nRows`×`nCols` matrix independently
 * (mean 0, sd 1 within the row) → a fresh `Float32Array`. Non-finite cells are excluded
 * from the row's mean/sd and map to 0; a flat / zero-variance row maps to all zeros
 * (the degenerate contract, matching `zscoreColumn`). Feed the result through a diverging
 * colormap centered at 0.
 */
export function zscoreRows(values: Float32Array, nRows: number, nCols: number): Float32Array {
  const out = new Float32Array(Math.max(0, nRows * nCols))
  for (let r = 0; r < nRows; r++) {
    const base = r * nCols
    let sum = 0
    let cnt = 0
    for (let c = 0; c < nCols; c++) {
      const v = values[base + c]
      if (Number.isFinite(v)) {
        sum += v
        cnt++
      }
    }
    if (cnt === 0) continue // empty row → all zeros
    const mean = sum / cnt
    let ss = 0
    for (let c = 0; c < nCols; c++) {
      const v = values[base + c]
      if (Number.isFinite(v)) {
        const d = v - mean
        ss += d * d
      }
    }
    const std = Math.sqrt(ss / cnt) // population sd (per-row standardization)
    if (!(std > 0)) continue // flat row → all zeros (degenerate contract)
    for (let c = 0; c < nCols; c++) {
      const v = values[base + c]
      out[base + c] = Number.isFinite(v) ? (v - mean) / std : 0
    }
  }
  return out
}

// ── 3. Categorical annotation-track texture (ITEM-37) ─────────────────────────────

/**
 * Build a thin categorical color-bar `ImageData` for a row/col annotation track: one
 * pixel per code, colored via the stable categorical palette (`categoryColor`). A code
 * outside `[0, categories.length)` renders transparent. `orient:'row'` yields a vertical
 * bar (width 1 × height N — colors vary along y/rows); `orient:'col'` a horizontal bar
 * (width N × height 1). The returned data length is always N×4 (RGBA). A `BitmapLayer`
 * renders this reliably (a raw {data,width,height} object uploads black in deck.gl v9).
 */
export function annotationTrackTexture(
  codes: ArrayLike<number>,
  categories: readonly string[],
  orient: 'row' | 'col' = 'row',
  /** Optional EFFECTIVE per-code palette (custom / by-name / auto-extended). Absent ⇒ the
   *  built-in `categoryColor` (byte-identical to before). */
  palette?: readonly (readonly [number, number, number])[],
): ImageData {
  const n = codes.length
  const data = new Uint8ClampedArray(Math.max(1, n) * 4)
  for (let i = 0; i < n; i++) {
    const code = codes[i]
    if (code < 0 || code >= categories.length) continue // out-of-range → transparent
    const [r, g, b] = palette?.[code] ?? categoryColor(code)
    const o = i * 4
    data[o] = r
    data[o + 1] = g
    data[o + 2] = b
    data[o + 3] = 255
  }
  const w = orient === 'row' ? 1 : Math.max(1, n)
  const h = orient === 'row' ? Math.max(1, n) : 1
  return new ImageData(data, w, h)
}
