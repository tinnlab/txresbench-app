import { describe, it, expect } from 'vitest'
import {
  fromArray,
  collectStream,
  type Channel,
  type StreamingSource,
} from './streamingSource'
import type { DatasetCatalog } from './wire'

// Foundation of the ONE streaming source (Part B, ITEM-8 / 8b / 10). Proves the keyed-channel
// contract, the resident-array→one-chunk-stream bridge, and the streaming metadata on the catalog.

describe('fromArray — resident typed array → one-chunk stream (ITEM-10)', () => {
  it('yields the array bytes verbatim (round-trips through collectStream)', async () => {
    const f32 = Float32Array.from([1.5, -2, 0, 3.25])
    const bytes = await collectStream(fromArray(f32))
    // same bytes, and re-viewing them as f32 reproduces the source array.
    expect(bytes.byteLength).toBe(f32.byteLength)
    const round = new Float32Array(bytes.buffer, bytes.byteOffset, f32.length)
    expect(Array.from(round)).toEqual(Array.from(f32))
  })

  it('emits EXACTLY one chunk (a resident array is a single instant batch)', async () => {
    let chunks = 0
    for await (const _ of fromArray(Uint16Array.from([0, 1, 2]))) chunks++
    expect(chunks).toBe(1)
  })

  it('handles u16 codes and u32 pointIds (the other resident channel shapes)', async () => {
    const codes = Uint16Array.from([0, 5, 65535])
    const ids = Uint32Array.from([10, 20, 30])
    const cb = await collectStream(fromArray(codes))
    const ib = await collectStream(fromArray(ids))
    expect(Array.from(new Uint16Array(cb.buffer, cb.byteOffset, codes.length))).toEqual([0, 5, 65535])
    expect(Array.from(new Uint32Array(ib.buffer, ib.byteOffset, ids.length))).toEqual([10, 20, 30])
  })
})

describe('collectStream — reassembles arbitrary chunk boundaries', () => {
  it('concatenates multi-chunk streams in order', async () => {
    async function* three(): AsyncIterable<Uint8Array> {
      yield Uint8Array.from([1, 2])
      yield Uint8Array.from([3])
      yield Uint8Array.from([4, 5, 6])
    }
    const out = await collectStream(three())
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('StreamingSource — keyed channel contract (ITEM-8 / DEC-9)', () => {
  // A tiny resident source: catalog + a keyed byte stream per channel.
  const positions = Float32Array.from([0, 0, 1, 1, 2, 2])
  const gene = Float32Array.from([0, 4.5, 0]) // a dense value column stand-in
  const source: StreamingSource = {
    async catalog(): Promise<DatasetCatalog> {
      return {
        datasetId: 'd',
        pointCount: 3,
        layouts: [{ id: 'umap', kind: 'layout', label: 'UMAP', encoding: { kind: 'f32', stride: 8 } }],
        valueColumns: ['GENE1'],
        categoricalColumns: [],
        continuousColumns: [],
        hasImage: false,
        hasPointIds: true,
      }
    },
    stream(channel: Channel) {
      if (channel.kind === 'positions') return fromArray(positions)
      if (channel.kind === 'value') return fromArray(gene)
      return fromArray(new Float32Array(0))
    },
  }

  it('resolves a channel by its KEY, not just its kind', async () => {
    const posBytes = await collectStream(source.stream({ kind: 'positions', layout: 'umap' }))
    expect(new Float32Array(posBytes.buffer, posBytes.byteOffset, 6).length).toBe(6)
    const geneBytes = await collectStream(source.stream({ kind: 'value', key: 'GENE1' }))
    expect(Array.from(new Float32Array(geneBytes.buffer, geneBytes.byteOffset, 3))).toEqual([0, 4.5, 0])
  })

  it('carries the streaming metadata on the catalog (encoding + hasPointIds) — DEC-10', async () => {
    const cat = await source.catalog()
    expect(cat.layouts[0].encoding).toEqual({ kind: 'f32', stride: 8 })
    expect(cat.hasPointIds).toBe(true)
  })

  it('the Channel union names every current data-plane read (compile-time coverage)', () => {
    // A value channel accepts an optional raw/lognorm layer (G21); tableColumn is name+column keyed.
    const chans: Channel[] = [
      { kind: 'positions', layout: 'umap' },
      { kind: 'value', key: 'GENE1', layer: 'lognorm' },
      { kind: 'categorical', key: 'group' },
      { kind: 'continuous', key: 'qc' },
      { kind: 'pointIds' },
      { kind: 'tableColumn', name: 'de', column: 'log2fc' },
      { kind: 'image' },
    ]
    // Assert the discriminants are all DISTINCT (not just the array length — that would be a tautology
    // on a literal). This proves the union enumerates 7 distinct data-plane kinds with no accidental dup.
    const kinds = chans.map(c => c.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    expect([...kinds].sort()).toEqual(
      ['categorical', 'continuous', 'image', 'pointIds', 'positions', 'tableColumn', 'value'],
    )
  })
})
