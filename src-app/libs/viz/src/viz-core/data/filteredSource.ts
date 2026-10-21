// filteredSource.ts — a DataSource WRAPPER that restricts every column to the points passing a set of
// value-window filters (LINK FILTERING). A grouped chart (box/violin/bar/dotplot/heatmap) fed a filtered
// source RE-COMPUTES its whole shape from only the surviving points — no change to the chart's stat/KDE
// code. The keep-mask is computed ONCE (lazily, from the filter columns) and cached; each column type is
// filtered + re-indexed into the collapsed 0..K-1 point space:
//   • categorical / continuous — per-point arrays, filtered to the kept points.
//   • valueColumn (sparse CSC) — entries whose row survives are kept + their row remapped to the new index.
// Non-column methods (positions/catalog/image/table/graph/pointIds) pass through unchanged.
//
// ── THE RASTER SEAMS PASS THROUGH TOO, AND DELIBERATELY UNFILTERED (#159) ──────────────────────
// `imagePixelSource()` and `imageLabelMask()` join `imageUnderlay()` in the pass-through set. A
// value-window filter selects POINTS; a raster has no point axis to filter, so restricting it is
// not merely unimplemented, it is meaningless — the same reason `imageUnderlay` has always passed
// through. What was NOT harmless is DROPPING them: this wrapper is on the production path for a
// grouped chart under an active link filter (`charts/installBuiltins.tsx`), and a wrapper that
// silently loses an optional seam turns "the user dragged a visual-map window" into "the raster
// pane went blank", with no error anywhere.

import type { DataSource } from './wire'

export interface ValueFilter {
  readonly column: string
  readonly range: readonly [number, number]
}

interface Mask {
  readonly keep: Uint8Array // length N, 1 = surviving point
  readonly remap: Int32Array // old point index → new index (0..K-1), or -1 when dropped
  readonly k: number // surviving point count
}

/** Wrap `base` so every column is restricted to points whose value in each filter column is in range.
 *  No filters ⇒ returns `base` unchanged (byte-identical, zero cost). */
export function filteredSource(base: DataSource, filters: readonly ValueFilter[] | undefined): DataSource {
  if (!filters || filters.length === 0) return base

  let maskPromise: Promise<Mask> | null = null
  const getMask = (): Promise<Mask> => {
    if (!maskPromise) {
      maskPromise = (async () => {
        const cols = await Promise.all(filters.map(f => base.continuous(f.column)))
        const n = cols.reduce((m, c) => Math.max(m, c.length), 0)
        const keep = new Uint8Array(n).fill(1)
        filters.forEach((f, i) => {
          const v = cols[i].value
          const lo = f.range[0]
          const hi = f.range[1]
          const m = Math.min(v.length, n)
          for (let j = 0; j < m; j++) if (v[j] < lo || v[j] > hi) keep[j] = 0
        })
        const remap = new Int32Array(n).fill(-1)
        let k = 0
        for (let j = 0; j < n; j++) if (keep[j]) remap[j] = k++
        return { keep, remap, k }
      })()
    }
    return maskPromise
  }

  return {
    catalog: () => base.catalog(),
    positions: layoutId => base.positions(layoutId),
    imageUnderlay: () => base.imageUnderlay(),
    table: name => base.table(name),
    graph: id => base.graph(id),
    ...(base.pointIds ? { pointIds: (layoutId?: string) => base.pointIds!(layoutId) } : {}),
    // Conditional, not `imagePixelSource: base.imagePixelSource` — an unconditional key holding
    // `undefined` makes `'imagePixelSource' in src` TRUE, and the raster pane's opt-out reads the
    // ABSENCE of the key, not its falsiness. Same idiom as `pointIds` directly above.
    ...(base.imagePixelSource ? { imagePixelSource: () => base.imagePixelSource!() } : {}),
    ...(base.imageLabelMask
      ? { imageLabelMask: (params?: { readonly cellId: string }) => base.imageLabelMask!(params) }
      : {}),
    async categorical(key) {
      const [col, { keep, k }] = await Promise.all([base.categorical(key), getMask()])
      const codes = new Uint16Array(k)
      let w = 0
      for (let j = 0; j < col.length; j++) if (keep[j]) codes[w++] = col.codes[j]
      return { codes, categories: col.categories, length: k }
    },
    async continuous(key) {
      const [col, { keep, k }] = await Promise.all([base.continuous(key), getMask()])
      const value = new Float32Array(k)
      let w = 0
      for (let j = 0; j < col.length; j++) if (keep[j]) value[w++] = col.value[j]
      return { value, length: k }
    },
    async valueColumn(key, layer) {
      const [col, { remap, k }] = await Promise.all([base.valueColumn(key, layer), getMask()])
      const rows: number[] = []
      const vals: number[] = []
      for (let i = 0; i < col.row.length; i++) {
        const nr = remap[col.row[i]]
        if (nr >= 0) {
          rows.push(nr)
          vals.push(col.value[i])
        }
      }
      return { row: Uint32Array.from(rows), value: Float32Array.from(vals), length: k }
    },
  }
}
