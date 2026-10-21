// streamingFixtures.ts — a RESIDENT `StreamingSource` over the SAME synthetic data `FixtureSource`
// generates (ITEM-10/17). It proves the ONE streaming data-input seam end-to-end WITHOUT a real
// results-streaming backend: `generateFixture()` produces the exact wire buffers (positions f32,
// categorical u16 codes, continuous f32, value sparse-CSC, image RGBA, table columns, u32 pointIds),
// and this class re-exposes each as a KEYED byte `stream(channel)` plus a `catalog()` carrying the
// streaming metadata a headerless stream can't self-describe (per-layout `encoding`, image dims/affine,
// table structure, graph topology, `hasPointIds`).
//
// It does NOT re-invent the data — it reuses `FixtureSource`'s generator, so
// `asDataSource(new StreamingFixtureSource(opts))` decodes BYTE-IDENTICALLY to the equivalent
// `FixtureSource` methods for the same `opts` (the deterministic seed makes both generate the same
// bytes). See `streamingFixtures.test.ts` for the per-channel parity oracle.

import { generateFixture, type FixtureOptions } from './fixtures'
import {
  fromArray,
  type Channel,
  type StreamOptions,
  type StreamingSource,
} from './streamingSource'
import type { CatalogEntry, DatasetCatalog } from './wire'

/** The single fixture table's name (mirrors `FixtureSource.table()`, which ignores its `name` arg). */
export const STREAMING_FIXTURE_TABLE = 'stats'

/** Yield a resident byte buffer as a single stream chunk (the structured-kind analog of `fromArray`,
 *  for the mixed-field sparse-CSC value bytes + the image pixel bytes that have no single typed form). */
async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

/**
 * A resident {@link StreamingSource} backed by the synthetic fixture generator — the streaming-path
 * twin of {@link import('./fixtures').FixtureSource}. Bulk data flows the progressive `stream()` path;
 * small structure rides `catalog()`.
 */
export class StreamingFixtureSource implements StreamingSource {
  private readonly fx: ReturnType<typeof generateFixture>
  /** canonical point ids ONLY when barcodes were supplied — else the dataset is an isolated identity
   *  space (`catalog().hasPointIds === false`), matching `FixtureSource` which omits `pointIds`. */
  private readonly ids?: Uint32Array

  constructor(opts: FixtureOptions = {}) {
    this.fx = generateFixture(opts)
    this.ids = opts.pointIds
  }

  async catalog(): Promise<DatasetCatalog> {
    const base = this.fx.catalog
    // Every layout streams headerless f32 xy (stride 8) — the decoder needs the encoding descriptor.
    const layouts: CatalogEntry[] = base.layouts.map(l => ({
      ...l,
      encoding: { kind: 'f32', stride: 8 } as const,
    }))
    const img = this.fx.imageUnderlay
    return {
      ...base,
      layouts,
      // Image dims + affine ride the catalog; the pixels stream via `stream({kind:'image'})` (DEC-8/10).
      image: { width: img.width, height: img.height, channels: img.channels, affine: img.affine },
      // Table structure rides the catalog; each column's f32 bytes stream via `tableColumn` (DEC-8).
      tables: [
        {
          name: STREAMING_FIXTURE_TABLE,
          rowLabels: this.fx.table.rowLabels,
          columns: Object.keys(this.fx.table.columns),
        },
      ],
      // Graph topology is control-plane only — NOT a byte channel (DEC-8/B).
      graphs: [this.fx.graph],
      // Isolated identity space unless barcodes were supplied (DEC-10/E).
      hasPointIds: this.ids != null,
    }
  }

  stream(channel: Channel, _opts?: StreamOptions): AsyncIterable<Uint8Array> {
    switch (channel.kind) {
      case 'positions': {
        // 'image' layout has its own raster-grid positions; every other layout uses the primary layout.
        const buf = channel.layout === 'image' ? this.fx.imageLayoutBuf : this.fx.layoutBuf
        return fromArray(new Float32Array(buf))
      }
      case 'value': {
        // sparse-CSC wire `u32 n | u32[n] row | f32[n] value` — a mixed-field buffer streamed verbatim.
        const buf = this.fx.valueBufs.get(channel.key)
        if (!buf) throw new Error(`streaming fixture has no value column "${channel.key}"`)
        return oneChunk(new Uint8Array(buf))
      }
      case 'categorical': {
        const entry = this.fx.categoricalBufs.get(channel.key)
        if (!entry) throw new Error(`streaming fixture has no categorical "${channel.key}"`)
        return fromArray(new Uint16Array(entry.buf))
      }
      case 'continuous': {
        const buf = this.fx.continuousBufs.get(channel.key)
        if (!buf) throw new Error(`streaming fixture has no continuous "${channel.key}"`)
        return fromArray(new Float32Array(buf))
      }
      case 'pointIds': {
        if (!this.ids) {
          throw new Error('streaming fixture has no canonical pointIds (isolated identity space)')
        }
        return fromArray(this.ids)
      }
      case 'tableColumn': {
        const col = this.fx.table.columns[channel.column]
        if (!col) throw new Error(`streaming fixture table has no column "${channel.column}"`)
        return fromArray(col)
      }
      case 'image':
        return oneChunk(this.fx.imageUnderlay.data)
      case 'members':
        // The fixture source serves WHOLE columns. A gather is a property of a real store's
        // chunking, so there is nothing here to subset — and answering with the parent's bytes
        // would hand back a full-length column under a subset key, which every consumer would
        // then paint as if it were the subset. Refusing names the channel it could not serve.
        throw new Error(
          `streaming fixture cannot gather ` +
            `[${channel.members.segments.map(s => s.of.key).join(', ')}] to ` +
            `${channel.members.segments.reduce((n, s) => n + s.count, 0)} members ` +
            '— the fixture serves whole columns, and answering with the parent would be a ' +
            'full-length column wearing a subset key',
        )
      default: {
        // Exhaustiveness guard: a new `Channel` kind fails to compile here until handled.
        const _never: never = channel
        throw new Error(`streaming fixture: unhandled channel ${JSON.stringify(_never)}`)
      }
    }
  }
}
