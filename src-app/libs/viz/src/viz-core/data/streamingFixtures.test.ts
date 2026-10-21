// streamingFixtures.test.ts — BYTE-PARITY oracle for the resident `StreamingFixtureSource` (ITEM-10/17).
//
// The streaming path must decode to EXACTLY what the pull `FixtureSource` returns: for the SAME `opts`
// (deterministic seed), `asDataSource(new StreamingFixtureSource(opts))` and `new FixtureSource(opts)`
// generate identical bytes, so every keyed channel — positions, categorical codes, continuous, sparse
// value CSC, image pixels, table columns, canonical pointIds — decodes byte-for-byte identically. This
// proves the streaming API is a faithful re-framing of the same data, not a parallel data set.

import { describe, expect, it } from 'vitest'
import { FixtureSource } from './fixtures'
import { StreamingFixtureSource, STREAMING_FIXTURE_TABLE } from './streamingFixtures'
import { asDataSource } from './streamingAdapter'
import { densify } from './wire'

// Small deterministic fixture: enough points to exercise the sparse encoder, fast to decode.
const OPTS = {
  seed: 42,
  pointCount: 2000,
  groupCount: 6,
  valueColumns: ['Feature A', 'Feature B', 'Feature C'],
  batchCount: 3,
}

describe('StreamingFixtureSource — byte-parity with FixtureSource via asDataSource', () => {
  const fixture = new FixtureSource(OPTS)
  const streamed = asDataSource(new StreamingFixtureSource(OPTS))

  it('catalog: pointCount + column keys + streaming metadata', async () => {
    const a = await fixture.catalog()
    const b = await streamed.catalog()
    expect(b.pointCount).toBe(a.pointCount)
    expect(b.valueColumns).toEqual(a.valueColumns)
    expect(b.layouts.map(l => l.id)).toEqual(a.layouts.map(l => l.id))
    expect(b.categoricalColumns.map(c => c.id)).toEqual(a.categoricalColumns.map(c => c.id))
    expect(b.continuousColumns.map(c => c.id)).toEqual(a.continuousColumns.map(c => c.id))
    // Streaming metadata a headerless stream needs (DEC-10): each layout carries an f32/stride-8 encoding.
    for (const l of b.layouts) expect(l.encoding).toEqual({ kind: 'f32', stride: 8 })
    expect(b.hasPointIds).toBe(false) // bare fixture ⇒ isolated identity space
  })

  it('positions (primary + image) decode identically', async () => {
    for (const layout of ['primary', 'image']) {
      const a = await fixture.positions(layout)
      const b = await streamed.positions(layout)
      expect(b.length).toBe(a.length)
      expect(Array.from(b.positions)).toEqual(Array.from(a.positions))
    }
  })

  it('categorical codes + categories identical', async () => {
    for (const key of ['group', 'type', 'batch']) {
      const a = await fixture.categorical(key)
      const b = await streamed.categorical(key)
      expect(Array.from(b.codes)).toEqual(Array.from(a.codes))
      expect(b.categories).toEqual(a.categories)
      expect(b.length).toBe(a.length)
    }
  })

  it('continuous columns identical', async () => {
    for (const key of ['qcA', 'qcB', 'pseudo']) {
      const a = await fixture.continuous(key)
      const b = await streamed.continuous(key)
      expect(Array.from(b.value)).toEqual(Array.from(a.value))
      expect(b.length).toBe(a.length)
    }
  })

  it('value columns (sparse CSC) — row + value + densified projection identical', async () => {
    for (const key of OPTS.valueColumns) {
      const a = await fixture.valueColumn(key)
      const b = await streamed.valueColumn(key)
      expect(Array.from(b.row)).toEqual(Array.from(a.row))
      expect(Array.from(b.value)).toEqual(Array.from(a.value))
      expect(b.length).toBe(a.length)
      // Full dense projection matches (the real color-by pre-pass).
      expect(Array.from(densify(b))).toEqual(Array.from(densify(a)))
    }
  })

  it('image underlay pixels + dims/affine identical', async () => {
    const a = await fixture.imageUnderlay()
    const b = await streamed.imageUnderlay()
    expect(b.width).toBe(a.width)
    expect(b.height).toBe(a.height)
    expect(b.channels).toBe(a.channels)
    expect(b.affine).toEqual(a.affine)
    expect(Array.from(b.data)).toEqual(Array.from(a.data))
  })

  it('table columns + rowLabels identical', async () => {
    const a = await fixture.table()
    const b = await streamed.table(STREAMING_FIXTURE_TABLE)
    expect(b.rowLabels).toEqual(a.rowLabels)
    for (const col of Object.keys(a.columns)) {
      expect(Array.from(b.columns[col])).toEqual(Array.from(a.columns[col]))
    }
  })

  it('pointIds: present + identical when barcodes supplied; isolated dataset throws', async () => {
    const ids = Uint32Array.from({ length: OPTS.pointCount }, (_, i) => 1000 + i)
    const withIds = new FixtureSource({ ...OPTS, pointIds: ids })
    const streamedIds = asDataSource(new StreamingFixtureSource({ ...OPTS, pointIds: ids }))
    const a = await withIds.pointIds!()
    const b = await streamedIds.pointIds!()
    expect(Array.from(b)).toEqual(Array.from(a))
    // A bare fixture is an isolated identity space → the adapter throws (store reads it as `null`).
    await expect(streamed.pointIds!()).rejects.toThrow(/isolated/)
  })
})
