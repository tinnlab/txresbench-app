// DatasetStore.rev.test.ts — G1: `VizDataset.rev` is the EXPLICIT content-invalidation token.
// `option/types.ts` declares the contract: same `id` + NEW `rev` ⇒ re-acquire/re-stream; same `id`
// + same `rev` ⇒ no-op reuse; ABSENT `rev` ⇒ pure identity reuse. These pin it AT THE STORE — the
// layer that owns the resolve/ref-count/evict machinery `rev` has to hook into.
import { describe, it, expect, vi } from 'vitest'
import { createDatasetStore } from './DatasetStore'
import type { DataSource, DatasetCatalog } from '../viz-core/data/wire'

function catalogOf(pointCount: number): DatasetCatalog {
  return {
    layouts: [{ id: 'primary' }],
    continuousColumns: [],
    valueColumns: [],
    categoricalColumns: [],
    pointCount,
  } as never
}

/** A `DataSource` whose catalog + positions identify WHICH revision produced it (so a test can tell
 *  the re-acquired content apart from the first one, not merely count resolver calls). */
function revSource(n: number): DataSource {
  const src: Partial<DataSource> = {
    catalog: vi.fn(async () => catalogOf(n)),
    positions: vi.fn(async () => ({ positions: new Float32Array(n * 2).fill(n) }) as never),
    // the default color-by is best-effort: fail it so the store synthesizes the neutral buffer
    categorical: vi.fn(async () => {
      throw new Error('no default')
    }),
    continuous: vi.fn(async () => {
      throw new Error('no default')
    }),
    valueColumn: vi.fn(async () => {
      throw new Error('no default')
    }),
  }
  return src as DataSource
}

describe('DatasetStore — `rev` content invalidation (G1)', () => {
  it('same id + NEW rev RE-RESOLVES, and the entry carries the NEW content', async () => {
    const store = createDatasetStore()
    const a = revSource(3)
    const b = revSource(7)
    const resolve = vi.fn(async (_id: string) => (resolve.mock.calls.length === 1 ? a : b))
    store.getState().setResolver(resolve)

    await store.getState().acquire('D', undefined, 'r1')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(store.getState().getEntry('D')?.source).toBe(a)

    // The host republished D's CONTENT under the SAME logical id — the rev is the signal.
    await store.getState().acquire('D', undefined, 'r2')
    expect(resolve).toHaveBeenCalledTimes(2)
    const e = store.getState().getEntry('D')
    expect(e?.status).toBe('ready')
    expect(e?.source).toBe(b) // the NEW source, not the one built first
    expect(e?.catalog?.pointCount).toBe(7)
    expect(e?.rev).toBe('r2')
  })

  it('NEGATIVE CONTROL — same id + SAME rev does NOT re-resolve (identity reuse is preserved)', async () => {
    const store = createDatasetStore()
    const a = revSource(3)
    const resolve = vi.fn(async (_id: string) => a)
    store.getState().setResolver(resolve)

    await store.getState().acquire('D', undefined, 'r1')
    await store.getState().acquire('D', undefined, 'r1')
    await store.getState().acquire('D', undefined, 'r1')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(store.getState().getEntry('D')?.refCount).toBe(3)
  })

  it('NEGATIVE CONTROL — an ABSENT rev never re-resolves, and never clears a recorded rev', async () => {
    const store = createDatasetStore()
    const resolve = vi.fn(async (_id: string) => revSource(3))
    store.getState().setResolver(resolve)

    await store.getState().acquire('D', undefined, 'r1')
    await store.getState().acquire('D') // no opinion about content ⇒ cheap reuse
    expect(resolve).toHaveBeenCalledTimes(1)
    // The recorded rev survives a no-opinion acquire, so re-publishing r1 later is STILL a no-op…
    expect(store.getState().getEntry('D')?.rev).toBe('r1')
    await store.getState().acquire('D', undefined, 'r1')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('a supersede keeps ONE entry per id (no entry accumulates per revision) and drops the old buffers', async () => {
    const store = createDatasetStore()
    const a = revSource(3)
    const b = revSource(7)
    const resolve = vi.fn(async (_id: string) => (resolve.mock.calls.length === 1 ? a : b))
    store.getState().setResolver(resolve)

    await store.getState().acquire('D', undefined, 'r1')
    await store.getState().ensureBuffers('D', 'primary')
    const first = store.getState().getEntry('D')!
    expect(first.positionsByLayout.primary?.length).toBe(6)
    const epochBefore = first.epoch

    await store.getState().acquire('D', undefined, 'r2')
    // ONE entry, not one per revision.
    expect(Object.keys(store.getState().datasets)).toEqual(['D'])
    const after = store.getState().getEntry('D')!
    // the stale revision's buffers are GONE (else `ensureBuffers` early-returns them forever)…
    expect(after.positionsByLayout.primary).toBeUndefined()
    expect(after.colors).toBeNull()
    // …and the epoch is monotonic across the supersede so deck re-uploads.
    expect(after.epoch).toBeGreaterThan(epochBefore)

    await store.getState().ensureBuffers('D', 'primary')
    expect(store.getState().getEntry('D')?.positionsByLayout.primary?.length).toBe(14)
  })

  it('a supersede PRESERVES the other holders’ refs (it re-resolves in place, it does not evict)', async () => {
    const store = createDatasetStore()
    const resolve = vi.fn(async (_id: string) => revSource(3))
    store.getState().setResolver(resolve)

    await store.getState().acquire('D', undefined, 'r1') // pane 1
    await store.getState().acquire('D', undefined, 'r1') // pane 2 (reuse)
    expect(store.getState().getEntry('D')?.refCount).toBe(2)

    await store.getState().acquire('D', undefined, 'r2') // pane 3 at a new rev ⇒ supersede
    expect(store.getState().getEntry('D')?.refCount).toBe(3)

    store.getState().release('D')
    store.getState().release('D')
    expect(store.getState().getEntry('D')?.refCount).toBe(1)
    store.getState().release('D')
    expect(store.getState().getEntry('D')).toBeNull() // evicts at 0, as before
  })

  it('two CONCURRENT acquires at different revs settle on the NEWEST content, with both refs held', async () => {
    const store = createDatasetStore()
    const a = revSource(3)
    const b = revSource(7)
    const gates: Array<() => void> = []
    const resolve = vi.fn(
      (_id: string) =>
        new Promise<DataSource>(res => {
          const n = resolve.mock.calls.length
          gates.push(() => res(n === 1 ? a : b))
        }),
    )
    store.getState().setResolver(resolve)

    const p1 = store.getState().acquire('D', undefined, 'r1')
    const p2 = store.getState().acquire('D', undefined, 'r2')
    expect(resolve).toHaveBeenCalledTimes(2)
    let p1Settled = false
    void p1.then(() => {
      p1Settled = true
    })

    // Let the SUPERSEDED revision finish, and ONLY it. `acquire` resolves to mean "this id has
    // reached a terminal status" — its caller (a second pane, or a second controller's
    // `applyOption`) reads the catalog the moment it returns. Returning at its OWN, already-
    // invalidated load would hand back an entry that is loading again, with a null catalog.
    gates[0]!()
    await new Promise(r => setTimeout(r, 0))
    expect(p1Settled).toBe(false)
    expect(store.getState().getEntry('D')?.status).toBe('loading')

    gates[1]!()
    await p1
    const e = store.getState().getEntry('D')!
    expect(e.status).toBe('ready')
    expect(e.catalog).not.toBeNull()
    expect(e.source).toBe(b) // …and it is the NEWEST content, not the revision this caller asked for
    expect(e.rev).toBe('r2')

    await p2
    expect(store.getState().getEntry('D')?.refCount).toBe(2) // both callers hold a ref
  })
})
