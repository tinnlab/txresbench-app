// streamingAdapter.ts — the "route the old surface through the new" bridge (Part B, ITEM-14).
//
// Every current consumer reads the pull `DataSource` (8 `Promise<TypedArray>` methods). `asDataSource`
// implements that interface OVER a `StreamingSource` by streaming + decoding each keyed channel, so the
// grid / DatasetStore / every chart View keep working UNCHANGED while call sites migrate to `stream()`
// incrementally. The pull interface is deleted last. This is the add→route→remove seam the PLAN_AUDIT
// requires for the widest-blast-radius item.
//
// ITEM-15 leg (b) (owner grant, 2026-08-16): every bulk-byte method FORWARDS an optional trailing
// `DataReadOptions` into `source.stream(channel, opts)`. Before this the adapter dropped the caller's
// `AbortSignal` on the floor, so a DataSource-shaped read could only ever be DISCARDED after running
// to completion — `useGridColoring`'s `alive` boolean was the whole of viz's "cancellation". The
// grant is for exactly this: ACCEPT and FORWARD. The adapter does nothing else with the options.

import type { PixelSource } from '@vivjs/types'
import type {
  DataReadOptions,
  DataSource,
  DatasetCatalog,
  Positions,
  SparseColumn,
  CategoricalColumn,
  ContinuousColumn,
  ImageUnderlay,
  DataTable,
  GraphData,
} from './wire'
import type { StreamingSource } from './streamingSource'
import { collectStream } from './streamingSource'
import {
  decodePositionsStream,
  decodeContinuousStream,
  decodeCategoricalStream,
  decodeSparseColumnStream,
  decodeFloat32Stream,
  decodeUint32Stream,
} from './streamDecode'

/**
 * Present a {@link StreamingSource} as the legacy pull {@link DataSource}. The catalog is fetched once
 * and cached (control-plane metadata + the streaming descriptors the decoders need). Each read streams
 * its keyed channel and decodes to the complete typed value the caller expects.
 */
export function asDataSource(source: StreamingSource): DataSource {
  let catalogPromise: Promise<DatasetCatalog> | null = null
  const catalog = (): Promise<DatasetCatalog> => {
    if (!catalogPromise) catalogPromise = source.catalog()
    return catalogPromise
  }

  return {
    catalog,

    async positions(layoutId: string, opts?: DataReadOptions): Promise<Positions> {
      const cat = await catalog()
      const layout = cat.layouts.find(l => l.id === layoutId)
      // D20 (ITEM-12, INV-26): a layout stored as two 1-D NUMERIC columns (a virtual/masked
      // embedding — no 2-D gathered member) is read as two numeric column streams and INTERLEAVED
      // here. Each column is masked by the numeric path server-side, so the interleave is the ONLY
      // change and `scatter.ts`/`getPosition` still receives one `[x0,y0,…]` buffer. Absent
      // `components` ⇒ the interleaved `positions` channel (a real coordinate artifact), unchanged.
      const components = layout?.components
      if (components && components.length >= 2) {
        const [xs, ys] = await Promise.all([
          decodeFloat32Stream(source.stream({ kind: 'continuous', key: components[0] }, opts)),
          decodeFloat32Stream(source.stream({ kind: 'continuous', key: components[1] }, opts)),
        ])
        // The two masked columns are the KEPT rows in output order and MUST be equal length: both
        // components live on the same axis of one dataset and are masked by the SAME mask
        // server-side (the numeric path refuses a per-source length mismatch), so N_kept is
        // identical. A disagreement is therefore a real defect — the two were masked against
        // different row sequences — not a benign short read. SURFACE it (P3) rather than silently
        // truncating a wrong answer to `min` with a clean console; still bound the interleave so
        // the scatter renders rather than reading past either buffer.
        if (xs.length !== ys.length) {
          console.error(
            `[viz] positions(${layoutId}): masked components disagree in length ` +
              `(x=${xs.length}, y=${ys.length}) — they were masked against different row ` +
              `sequences; rendering the ${Math.min(xs.length, ys.length)} aligned points only.`,
          )
        }
        const length = Math.min(xs.length, ys.length)
        const positions = new Float32Array(length * 2)
        for (let i = 0; i < length; i++) {
          positions[i * 2] = xs[i]
          positions[i * 2 + 1] = ys[i]
        }
        return { positions, length }
      }
      return decodePositionsStream(
        source.stream({ kind: 'positions', layout: layoutId }, opts),
        layout?.encoding,
      )
    },

    async valueColumn(key: string, layer?: string, opts?: DataReadOptions): Promise<SparseColumn> {
      const cat = await catalog()
      return decodeSparseColumnStream(
        source.stream({ kind: 'value', key, ...(layer ? { layer } : {}) }, opts),
        cat.pointCount,
      )
    },

    async categorical(key: string, opts?: DataReadOptions): Promise<CategoricalColumn> {
      const cat = await catalog()
      const categories = cat.categoricalColumns.find(c => c.id === key)?.categories ?? []
      return decodeCategoricalStream(source.stream({ kind: 'categorical', key }, opts), categories)
    },

    continuous(key: string, opts?: DataReadOptions): Promise<ContinuousColumn> {
      return decodeContinuousStream(source.stream({ kind: 'continuous', key }, opts))
    },

    async imageUnderlay(opts?: DataReadOptions): Promise<ImageUnderlay> {
      const cat = await catalog()
      const meta = cat.image
      if (!meta) throw new Error('asDataSource.imageUnderlay: catalog has no `image` metadata')
      const data = await collectStream(source.stream({ kind: 'image' }, opts))
      return { data, width: meta.width, height: meta.height, channels: meta.channels, affine: meta.affine }
    },

    async table(name: string, opts?: DataReadOptions): Promise<DataTable> {
      const cat = await catalog()
      const meta = cat.tables?.find(t => t.name === name)
      if (!meta) throw new Error(`asDataSource.table: catalog has no table '${name}'`)
      const columns: Record<string, Float32Array> = {}
      for (const column of meta.columns) {
        columns[column] = await decodeFloat32Stream(
          source.stream({ kind: 'tableColumn', name, column }, opts),
        )
      }
      return { rowLabels: meta.rowLabels, columns }
    },

    async graph(id: string): Promise<GraphData> {
      const cat = await catalog()
      // Graph is CONTROL-PLANE (catalog-only, DEC-8) — no byte channel. Match by index id with NO
      // silent fallback to graphs[0] (mirrors `table` above): a non-matching id must fail LOUD, not
      // return the WRONG graph — against a real multi-graph source the fallback served wrong data.
      const g = cat.graphs?.find((_, i) => `${i}` === id)
      if (!g) throw new Error(`asDataSource.graph: catalog has no graph '${id}' (${cat.graphs?.length ?? 0} available)`)
      return g
    },

    async pointIds(layoutId?: string, opts?: DataReadOptions): Promise<Uint32Array> {
      const cat = await catalog()
      if (cat.hasPointIds === false) {
        // Isolated identity space (DEC-10/E). THROW rather than return an empty array: the DatasetStore
        // treats a `pointIds()` throw as "no canonical namespace" → `entry.pointIds = null` → isolated,
        // matching the legacy DataSource which OMITTED the method for isolated datasets. An empty array
        // would read as `pointIds != null` and wrongly route the cell to the CANONICAL selection space.
        throw new Error('streaming source: dataset has no canonical pointIds (isolated identity space)')
      }
      return decodeUint32Stream(
        source.stream({ kind: 'pointIds', ...(layoutId ? { layout: layoutId } : {}) }, opts),
      )
    },

    // ── THE RASTER SEAMS (#159) ──────────────────────────────────────────────────────────────
    //
    // Spread CONDITIONALLY, and the difference between this and `imagePixelSource: () => …` is
    // the whole reason the block is written this way. `useGridRaster` opts a pane out of the
    // pyramid path with `if (!src?.imagePixelSource) continue`, and it distinguishes THREE
    // states for a pane: `undefined` (never reserved — take the single-texture fallback),
    // `'loading'`, and a resolved entry. An unconditional key whose value is `undefined` is
    // falsy and passes that guard identically TODAY, but it makes `'imagePixelSource' in src`
    // true, and the shipped invariant test (`omeTiffFallback.test.tsx`) is written against a
    // source that must not carry the key at all. So: present only when the wrapped source has
    // one, absent otherwise — the same idiom `filteredSource` uses for `pointIds`.
    //
    // Why forward at all, when both are OPTIONAL on `DataSource` and the adapter type-checked
    // fine without them: because `asDataSource(streamingSource)` IS what the app hands the grid
    // (`projectSources.ts`), so a seam that stops here reaches no renderer. That was the state
    // before #159 — a data source could implement `imagePixelSource()` perfectly and the pane
    // would still draw nothing, with nothing anywhere saying why.
    ...(source.imagePixelSource
      ? { imagePixelSource: (): Promise<PixelSource<['c']>[]> => source.imagePixelSource!() }
      : {}),
    ...(source.imageLabelMask
      ? {
          imageLabelMask: (params?: { readonly cellId: string }) => source.imageLabelMask!(params),
        }
      : {}),
  }
}
