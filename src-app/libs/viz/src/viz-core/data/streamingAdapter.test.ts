import { describe, it, expect, vi } from 'vitest'
import { asDataSource } from './streamingAdapter'
import { fromArray, type Channel, type StreamingSource } from './streamingSource'
import type { DatasetCatalog } from './wire'

// ITEM-14 bridge: a fixture StreamingSource routed through asDataSource must satisfy the legacy pull
// DataSource for EVERY channel — proving the whole decode stack + the add→route→remove seam.

/** Build the sparse-CSC bytes `u32 n | u32[n] row | f32[n] value`. */
function cscBytes(row: number[], value: number[]): Uint8Array {
  const n = row.length
  const buf = new ArrayBuffer(4 + n * 8)
  new DataView(buf).setUint32(0, n, true)
  new Uint32Array(buf, 4, n).set(row)
  new Float32Array(buf, 4 + n * 4, n).set(value)
  return new Uint8Array(buf)
}

async function* one(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

const N = 4
const positions = Float32Array.from([0, 0, 1, 1, 2, 2, 3, 3])
const groupCodes = Uint16Array.from([0, 1, 0, 1])
const qc = Float32Array.from([0.1, 0.2, 0.3, 0.4])
const geneRow = [1, 3]
const geneVal = [4.5, -2]
const ids = Uint32Array.from([100, 101, 102, 103])
const imagePixels = Uint8Array.from([255, 0, 0, 0, 255, 0]) // 2px RGB
const de_log2fc = Float32Array.from([1, -1, 2, -2])
const de_pval = Float32Array.from([0.01, 0.5, 0.001, 0.9])

const catalog: DatasetCatalog = {
  datasetId: 'd',
  pointCount: N,
  layouts: [{ id: 'umap', kind: 'layout', label: 'UMAP', encoding: { kind: 'f32', stride: 8 } }],
  valueColumns: ['GENE1'],
  categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group', categories: ['A', 'B'] }],
  continuousColumns: [{ id: 'qc', kind: 'continuous', label: 'QC' }],
  hasImage: true,
  image: { width: 2, height: 1, channels: 3, affine: [1, 0, 0, 0, 1, 0] },
  tables: [{ name: 'de', rowLabels: ['g1', 'g2', 'g3', 'g4'], columns: ['log2fc', 'pval'] }],
  graphs: [{ nodeKey: 'group', paths: [[0, 1]] }],
  hasPointIds: true,
}

const source: StreamingSource = {
  async catalog() {
    return catalog
  },
  stream(ch: Channel) {
    switch (ch.kind) {
      case 'positions':
        return fromArray(positions)
      case 'value':
        return one(cscBytes(geneRow, geneVal))
      case 'categorical':
        return fromArray(groupCodes)
      case 'continuous':
        return fromArray(qc)
      case 'pointIds':
        return fromArray(ids)
      case 'image':
        return one(imagePixels)
      case 'tableColumn':
        return fromArray(ch.column === 'log2fc' ? de_log2fc : de_pval)
      // The switch is EXHAUSTIVE on purpose. `members` (the gathered channel, ITEM-11/15/16)
      // was added to `Channel` after this fixture was written, and TypeScript typed the gap
      // exactly as it is: an arm-less kind makes `stream()` return
      // `AsyncIterable<Uint8Array> | undefined`, which does not satisfy the interface it
      // claims to implement. Nothing ran `tsc` over this file, so the drift sat here (#276).
      //
      // It REFUSES rather than stubs. `asDataSource` is the LEGACY PULL bridge and has no
      // gather: all nine of its `source.stream({ kind: … })` call sites are positions /
      // value / categorical / continuous / pointIds / image / tableColumn, and `members`
      // appears nowhere in `streamingAdapter.ts`. A fixture that quietly answered a gather
      // with ungathered bytes would make a future adapter bug LOOK correct here; a named
      // throw says what this fixture is, and fails loudly if the bridge ever grows a gather
      // without this suite growing a real one.
      case 'members':
        throw new Error(
          'streamingAdapter fixture: the legacy pull DataSource has no gather, so `asDataSource` ' +
            'never requests a `members` channel. If it now does, this fixture needs a real ' +
            'gathered-segment implementation, not this refusal.',
        )
    }
  },
}

describe('asDataSource — StreamingSource satisfies the legacy pull DataSource (ITEM-14)', () => {
  const ds = asDataSource(source)

  it('positions(layout) decodes the f32 xy', async () => {
    const p = await ds.positions('umap')
    expect(Array.from(p.positions)).toEqual(Array.from(positions))
    expect(p.length).toBe(N)
  })

  it('valueColumn(key) decodes the sparse CSC (length from catalog.pointCount)', async () => {
    const v = await ds.valueColumn('GENE1')
    expect(Array.from(v.row)).toEqual(geneRow)
    expect(Array.from(v.value)).toEqual(geneVal)
    expect(v.length).toBe(N)
  })

  it('categorical(key) decodes codes + catalog categories', async () => {
    const c = await ds.categorical('group')
    expect(Array.from(c.codes)).toEqual([0, 1, 0, 1])
    expect(c.categories).toEqual(['A', 'B'])
  })

  it('continuous(key) decodes dense f32', async () => {
    const c = await ds.continuous('qc')
    expect(Array.from(c.value)).toEqual([0.1, 0.2, 0.3, 0.4].map(Math.fround))
  })

  it('imageUnderlay() = streamed pixels + catalog dims/affine', async () => {
    const img = await ds.imageUnderlay()
    expect(Array.from(img.data)).toEqual(Array.from(imagePixels))
    expect(img.width).toBe(2)
    expect(img.channels).toBe(3)
    expect(img.affine).toEqual([1, 0, 0, 0, 1, 0])
  })

  it('table(name) = each column streamed + catalog rowLabels', async () => {
    const t = await ds.table('de')
    expect(t.rowLabels).toEqual(['g1', 'g2', 'g3', 'g4'])
    expect(Array.from(t.columns.log2fc)).toEqual([1, -1, 2, -2])
    expect(Array.from(t.columns.pval)).toEqual([0.01, 0.5, 0.001, 0.9].map(Math.fround))
  })

  it('graph(id) comes from the catalog topology (control-plane)', async () => {
    const g = await ds.graph('0')
    expect(g.nodeKey).toBe('group')
    expect(g.paths).toEqual([[0, 1]])
  })

  it('graph(id) with a NON-matching id THROWS — no silent fallback to graphs[0]', async () => {
    // Regression: a non-index id fell back to graphs[0], serving the WRONG graph with no signal.
    await expect(ds.graph('5')).rejects.toThrow(/no graph '5'/)
    await expect(ds.graph('nope')).rejects.toThrow(/no graph 'nope'/)
  })

  it('pointIds() decodes u32; isolated dataset THROWS (→ store null → isolated space)', async () => {
    const p = await ds.pointIds!()
    expect(Array.from(p)).toEqual([100, 101, 102, 103])
    const isolated = asDataSource({ ...source, catalog: async () => ({ ...catalog, hasPointIds: false }) })
    await expect(isolated.pointIds!()).rejects.toThrow(/isolated/)
  })

  it('caches the catalog (fetched once across many reads)', async () => {
    let calls = 0
    const counting = asDataSource({ ...source, catalog: async () => { calls++; return catalog } })
    await counting.positions('umap')
    await counting.categorical('group')
    await counting.valueColumn('GENE1')
    expect(calls).toBe(1)
  })
})

// D20 (ITEM-12, INV-26): a virtual/masked embedding's positions are TWO 1-D numeric columns,
// interleaved by the adapter — there is NO 2-D gathered member and no 2-D `positions` channel.
describe('positions() from two component columns (D20 / INV-26)', () => {
  it('interleaves two masked numeric columns to Positions, reading no 2-D member', async () => {
    const xs = Float32Array.from([10, 20, 30]) // the kept rows' x, in output order
    const ys = Float32Array.from([-1, -2, -3]) // the kept rows' y
    const requested: Channel[] = []
    const src: StreamingSource = {
      async catalog(): Promise<DatasetCatalog> {
        return {
          datasetId: 'vd',
          pointCount: 3,
          layouts: [{ id: 'umap', kind: 'layout', label: 'UMAP', components: ['umap_0', 'umap_1'] }],
          valueColumns: [],
          categoricalColumns: [],
          continuousColumns: [],
          hasImage: false,
        }
      },
      stream(ch: Channel) {
        requested.push(ch)
        if (ch.kind === 'continuous' && ch.key === 'umap_0') return fromArray(xs)
        if (ch.kind === 'continuous' && ch.key === 'umap_1') return fromArray(ys)
        throw new Error(`unexpected channel ${JSON.stringify(ch)}`)
      },
    }
    const pos = await asDataSource(src).positions('umap')
    expect(pos.length).toBe(3)
    // nc: drop the interleave loop and this order is wrong; swap the two reads and x/y flip.
    expect(Array.from(pos.positions)).toEqual([10, -1, 20, -2, 30, -3])
    // It read TWO numeric columns, never a `{kind:'positions'}` (2-D member) channel.
    expect(requested.every(c => c.kind === 'continuous')).toBe(true)
    expect(requested.length).toBe(2)
  })

  it('bounds the interleave to the shorter column (a length mismatch never reads past either)', async () => {
    const xs = Float32Array.from([1, 2, 3])
    const ys = Float32Array.from([9, 8]) // one shorter
    const src: StreamingSource = {
      async catalog(): Promise<DatasetCatalog> {
        return {
          datasetId: 'vd',
          pointCount: 3,
          layouts: [{ id: 'e', kind: 'layout', label: 'E', components: ['x', 'y'] }],
          valueColumns: [],
          categoricalColumns: [],
          continuousColumns: [],
          hasImage: false,
        }
      },
      stream(ch: Channel) {
        if (ch.kind === 'continuous' && ch.key === 'x') return fromArray(xs)
        return fromArray(ys)
      },
    }
    const pos = await asDataSource(src).positions('e')
    expect(pos.length).toBe(2)
    expect(Array.from(pos.positions)).toEqual([1, 9, 2, 8])
  })

  it('SURFACES a component-length mismatch rather than truncating it silently (P3)', async () => {
    // Two masked components MUST be equal length (same axis, same mask). A disagreement is a real
    // defect — masked against different row sequences — so it is logged, not swallowed. Equal
    // lengths (the positive control) must NOT log, or the surfacing is noise.
    const mk = (xs: Float32Array, ys: Float32Array): StreamingSource => ({
      async catalog(): Promise<DatasetCatalog> {
        return {
          datasetId: 'vd',
          pointCount: Math.min(xs.length, ys.length),
          layouts: [{ id: 'e', kind: 'layout', label: 'E', components: ['x', 'y'] }],
          valueColumns: [],
          categoricalColumns: [],
          continuousColumns: [],
          hasImage: false,
        }
      },
      stream(ch: Channel) {
        return ch.kind === 'continuous' && ch.key === 'x' ? fromArray(xs) : fromArray(ys)
      },
    })

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // POSITIVE CONTROL: equal length → no log.
      await asDataSource(mk(Float32Array.from([1, 2]), Float32Array.from([3, 4]))).positions('e')
      expect(spy).not.toHaveBeenCalled()

      // Mismatch → logged, naming both lengths; nc: drop the console.error and this fails.
      await asDataSource(mk(Float32Array.from([1, 2, 3]), Float32Array.from([9, 8]))).positions('e')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]?.[0])).toContain('x=3')
      expect(String(spy.mock.calls[0]?.[0])).toContain('y=2')
    } finally {
      spy.mockRestore()
    }
  })

  it('falls back to the positions channel when a layout declares no components (real dataset)', async () => {
    // The shared `umap` layout has an `encoding` and NO `components` — the unchanged path.
    const pos = await asDataSource(source).positions('umap')
    expect(Array.from(pos.positions)).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
  })
})
