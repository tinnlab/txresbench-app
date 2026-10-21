// DatasetStore.streaming.test.ts — ITEM-12: DatasetStore accepts a `StreamingSource` (via `asDataSource`
// at the boundary) so a `<Viz source={StreamingSource}>` / `resolveDataset(id)=>StreamingSource` works
// while the downstream store logic (positionsByLayout / catalog / pointIds / colors) stays UNCHANGED.
//
// A fixture StreamingSource streams per keyed channel (mirrors streamingAdapter.test.ts). We drive it
// through the store's streaming seams (`setStreamingResolver` / `provideStreamingSource`) and assert an
// entry acquires + pulls positions/catalog/pointIds correctly — byte-identical to the DataSource path.
import { describe, it, expect, vi } from 'vitest'
import { createDatasetStore } from './DatasetStore'
import { fromArray, type Channel, type StreamingSource } from '../viz-core/data/streamingSource'
import { asDataSource } from '../viz-core/data/streamingAdapter'
import { streamColumnDomain, kllDomain } from '../viz-core/data/progressiveDomain'
import { KllSketch } from '../viz-core/data/sketches'
import type { DatasetCatalog } from '../viz-core/data/wire'

const N = 4
const positions = Float32Array.from([0, 0, 1, 1, 2, 2, 3, 3])
const groupCodes = Uint16Array.from([0, 1, 0, 1])
const qc = Float32Array.from([0.1, 0.2, 0.3, 0.4])
const ids = Uint32Array.from([100, 101, 102, 103])

const CATALOG: DatasetCatalog = {
  datasetId: 'd',
  pointCount: N,
  layouts: [{ id: 'umap', kind: 'layout', label: 'UMAP', encoding: { kind: 'f32', stride: 8 } }],
  valueColumns: [],
  categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'Group', categories: ['A', 'B'] }],
  continuousColumns: [{ id: 'qc', kind: 'continuous', label: 'QC' }],
  hasImage: false,
  hasPointIds: true,
}

/** A resident fixture StreamingSource streaming per keyed channel (like streamingAdapter.test.ts).
 *  `withIds` toggles the catalog's `hasPointIds` so we exercise both the present + isolated paths. */
function fixtureStreamingSource(withIds = true): StreamingSource {
  return {
    async catalog() {
      return withIds ? CATALOG : { ...CATALOG, hasPointIds: false }
    },
    stream(ch: Channel) {
      switch (ch.kind) {
        case 'positions':
          return fromArray(positions)
        case 'categorical':
          return fromArray(groupCodes)
        case 'continuous':
          return fromArray(qc)
        case 'pointIds':
          return fromArray(ids)
        default:
          // No value/image/tableColumn in this fixture — default color-by falls back to neutral gray.
          return fromArray(new Float32Array(0))
      }
    },
  }
}

describe('DatasetStore — StreamingSource path (ITEM-12)', () => {
  it('a StreamingSource resolver acquires an entry (catalog + pointIds streamed through)', async () => {
    const store = createDatasetStore()
    const resolve = vi.fn(async (_id: string) => fixtureStreamingSource())
    store.getState().setStreamingResolver(resolve)

    await store.getState().acquire('S')
    expect(resolve).toHaveBeenCalledTimes(1)
    const entry = store.getState().getEntry('S')
    expect(entry?.status).toBe('ready')
    expect(entry?.refCount).toBe(1)
    // Catalog decoded off the streaming source's control plane.
    expect(entry?.catalog?.layouts[0]?.id).toBe('umap')
    // pointIds streamed + decoded through the asDataSource bridge.
    expect(entry?.pointIds).toEqual(ids)

    // Reuse: no re-resolve, refCount bumps.
    await store.getState().acquire('S')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(store.getState().getEntry('S')?.refCount).toBe(2)

    // Release to 0 → evicted.
    store.getState().release('S')
    store.getState().release('S')
    expect(store.getState().getEntry('S')).toBeNull()
  })

  it('ensureBuffers pulls positions through the streaming channel (lazy, once per layout)', async () => {
    const store = createDatasetStore()
    store.getState().setStreamingResolver(async () => fixtureStreamingSource())
    await store.getState().acquire('S')

    await store.getState().ensureBuffers('S', 'umap')
    const entry = store.getState().getEntry('S')
    // Positions decoded from the f32 stream (interleaved xy, length N*2).
    expect(Array.from(entry?.positionsByLayout.umap ?? [])).toEqual(Array.from(positions))
    // colors synthesized (neutral gray fallback — the fixture has no default color-by column).
    expect(entry?.colors?.length).toBe(N * 4)

    // Idempotent: a second ensureBuffers is a no-op (positions already resident).
    const epochAfterFirst = store.getState().getEntry('S')?.epoch
    await store.getState().ensureBuffers('S', 'umap')
    expect(store.getState().getEntry('S')?.epoch).toBe(epochAfterFirst)
  })

  it('provideStreamingSource registers an inline streaming source (bypasses the resolver)', async () => {
    const store = createDatasetStore()
    const resolve = vi.fn(async () => fixtureStreamingSource())
    store.getState().setStreamingResolver(resolve)

    store.getState().provideStreamingSource('inline', fixtureStreamingSource())
    await store.getState().acquire('inline')
    expect(resolve).not.toHaveBeenCalled()
    expect(store.getState().getEntry('inline')?.status).toBe('ready')
    expect(store.getState().getEntry('inline')?.pointIds).toEqual(ids)
  })

  it('getStreamingSource exposes the RAW source, feeding the grid progressive-domain primitive (ITEM-11)', async () => {
    const store = createDatasetStore()
    const src = fixtureStreamingSource()
    store.getState().provideStreamingSource('S', src)
    await store.getState().acquire('S')
    // The RAW StreamingSource is retrievable (the seam the grid progressive path taps) — not the wrapper.
    const raw = store.getState().getStreamingSource('S')
    expect(raw).toBe(src)
    // Drive the progressive-domain primitive over it: the final frame converges to the full-array KLL domain.
    let final: { domain: readonly [number, number]; count: number; final: boolean } | null = null
    for await (const frame of streamColumnDomain(raw!, { kind: 'continuous', key: 'qc' })) final = frame
    expect(final?.final).toBe(true)
    expect(final?.count).toBe(N)
    const oneShot = new KllSketch()
    for (const v of qc) oneShot.update(v)
    expect([final!.domain[0], final!.domain[1]]).toEqual(kllDomain(oneShot))
    // Evicting clears the raw source too (no unbounded growth).
    store.getState().release('S')
    expect(store.getState().getStreamingSource('S')).toBeNull()
  })

  it('an isolated streaming source (hasPointIds:false) yields a NULL id namespace (isolated)', async () => {
    const store = createDatasetStore()
    store.getState().provideStreamingSource('iso', fixtureStreamingSource(false))
    await store.getState().acquire('iso')
    // asDataSource.pointIds() THROWS for hasPointIds:false; the store's try/catch → pointIds = null,
    // so the cell stays in an ISOLATED identity space (a non-null empty array would wrongly route to
    // the shared canonical space). Matches the legacy DataSource null-means-isolated semantics.
    expect(store.getState().getEntry('iso')?.pointIds).toBeNull()
  })

  it('the legacy DataSource resolver still works after a streaming resolver is set then cleared', async () => {
    const store = createDatasetStore()
    // Streaming resolver installs; clearing it with null restores an un-set slot.
    store.getState().setStreamingResolver(async () => fixtureStreamingSource())
    store.getState().setStreamingResolver(null)
    // A fresh DataSource resolver (back-compat path) still resolves.
    store.getState().setResolver(async () => asDataSourceFixture())
    await store.getState().acquire('legacy')
    expect(store.getState().getEntry('legacy')?.status).toBe('ready')
  })
})

// A legacy DataSource fixture (back-compat) — the streaming source routed through the public bridge.
function asDataSourceFixture() {
  return asDataSource(fixtureStreamingSource())
}
