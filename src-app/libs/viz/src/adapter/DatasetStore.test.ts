// DatasetStore.test.ts — TEST-7 (ITEM-7): acquire resolves-or-reuses (ref-count), release evicts at 0,
// ensureBuffers pulls lazily, pointIds captured (absent ⇒ isolated).
import { describe, it, expect, vi } from 'vitest'
import { createDatasetStore } from './DatasetStore'
import type { DataSource, DatasetCatalog } from '../viz-core/data/wire'
import type { Channel, StreamingSource } from '../viz-core/data/streamingSource'

const CATALOG: DatasetCatalog = {
  layouts: [{ id: 'primary' }],
  continuousColumns: [],
  valueColumns: [],
  categoricalColumns: [],
} as never

function mockSource(pointIds?: Uint32Array): DataSource {
  const src: Partial<DataSource> = {
    catalog: vi.fn(async () => CATALOG),
    positions: vi.fn(async () => ({ positions: new Float32Array([0, 0, 1, 1]) }) as never),
    // computeColoring calls source columns; make the default color-by best-effort fail → neutral buffer.
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
  if (pointIds) src.pointIds = vi.fn(async () => pointIds)
  return src as DataSource
}

describe('DatasetStore — acquire / reuse / ref-count / evict', () => {
  it('acquire resolves once, reuses on repeat, evicts at refCount 0', async () => {
    const store = createDatasetStore()
    const resolve = vi.fn(async (_id: string) => mockSource())
    store.getState().setResolver(resolve)

    await store.getState().acquire('A')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(store.getState().getEntry('A')?.refCount).toBe(1)
    expect(store.getState().getEntry('A')?.status).toBe('ready')

    // Reuse: no 2nd resolve, refCount bumps.
    await store.getState().acquire('A')
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(store.getState().getEntry('A')?.refCount).toBe(2)

    // Release once → still present.
    store.getState().release('A')
    expect(store.getState().getEntry('A')?.refCount).toBe(1)

    // Release to 0 → evicted.
    store.getState().release('A')
    expect(store.getState().getEntry('A')).toBeNull()
  })

  it('an inline source bypasses the resolver', async () => {
    const store = createDatasetStore()
    const resolve = vi.fn(async () => mockSource())
    store.getState().setResolver(resolve)
    await store.getState().acquire('B', mockSource())
    expect(resolve).not.toHaveBeenCalled()
    expect(store.getState().getEntry('B')?.status).toBe('ready')
  })

  it('captures pointIds when the source advertises them; null when absent (isolated)', async () => {
    const store = createDatasetStore()
    const ids = Uint32Array.from([10, 11, 12])
    await store.getState().acquire('withIds', mockSource(ids))
    await store.getState().acquire('noIds', mockSource())
    expect(store.getState().getEntry('withIds')?.pointIds).toEqual(ids)
    expect(store.getState().getEntry('noIds')?.pointIds).toBeNull()
  })

  it('ensureBuffers pulls positions lazily and only once per layout', async () => {
    const store = createDatasetStore()
    const src = mockSource()
    await store.getState().acquire('C', src)
    await store.getState().ensureBuffers('C', 'primary')
    expect(store.getState().getEntry('C')?.positionsByLayout.primary?.length).toBe(4)
    expect(src.positions).toHaveBeenCalledTimes(1)
    // Second call is a no-op (already pulled).
    await store.getState().ensureBuffers('C', 'primary')
    expect(src.positions).toHaveBeenCalledTimes(1)
  })

  it('ensureBuffers with NO streaming source is unchanged: ONE snapshot, colours sized from the read (TEST-12 leg 2)', async () => {
    const store = createDatasetStore()
    const src = mockSource()
    const snaps: number[] = []
    store.subscribe(s => {
      const e = s.datasets.L
      if (e) snaps.push(e.positionsByLayout.primary?.length ?? -1)
    })
    await store.getState().acquire('L', src)
    snaps.length = 0
    await store.getState().ensureBuffers('L', 'primary')
    const e = store.getState().getEntry('L')!
    expect(src.positions).toHaveBeenCalledTimes(1)
    // Exactly ONE positions publication, carrying the whole array — the byte-identical fallback.
    expect(snaps).toEqual([4])
    expect(Array.from(e.positionsByLayout.primary)).toEqual([0, 0, 1, 1])
    // Colours sized from the READ (2 points → 8 bytes), which is today's behaviour: this leg is the
    // regression control for the `catalog.pointCount` sizing the streaming leg introduces.
    expect(e.colors?.length).toBe(2 * 4)
  })

  it('a failed resolve marks the entry errored, does not throw', async () => {
    const store = createDatasetStore()
    store.getState().setResolver(async () => {
      throw new Error('boom')
    })
    await store.getState().acquire('bad')
    expect(store.getState().getEntry('bad')?.status).toBe('error')
  })
})

// ── ITEM-9 (restated) + ITEM-10 — the PROGRESSIVE positions fill ──────────────────────────────────
//
// DRIFT-1.33 is the trap these tests are shaped around: `reframeBytes` coalesces to 65536 rows by
// default, so ANY fixture below that size paints in one step and looks progressive. `ROWS` is chosen
// STRICTLY ABOVE the store's published batch size (8192) so a single-step fill cannot pass —
// `expect(prefixes.length).toBeGreaterThan(1)` is the assertion that goes RED if the store ever
// publishes only the finished array.
const BATCH_ROWS = 8192
const ROWS = BATCH_ROWS * 2 + 137 // 2 whole batches + a short final one (a boundary that is NOT aligned)

/** xy = (i, i * 2) for row i — so a prefix's CONTENT identifies exactly which rows have landed. */
function positionsFixture(rows: number): Float32Array {
  const f = new Float32Array(rows * 2)
  for (let i = 0; i < rows; i++) {
    f[i * 2] = i
    f[i * 2 + 1] = i * 2
  }
  return f
}

interface StreamingProbe {
  readonly source: StreamingSource
  /** Resolve to let the FIRST positions chunk be emitted (closed until called). */
  openGate: () => void
  gateOpen: () => boolean
}

/**
 * @param rows      what the CATALOG declares (`pointCount`) — the buffer allocation.
 * @param chunkRows bytes per yielded chunk.
 * @param streamRows how many rows the STREAM actually carries. Defaults to `rows`; a smaller value
 *   is the catalog/artifact disagreement H1 is about (a catalog written before rows were dropped,
 *   a truncated member, an empty stream).
 */
function streamingProbe(
  rows: number,
  chunkRows = BATCH_ROWS,
  streamRows = rows,
): StreamingProbe {
  const bytes = new Uint8Array(positionsFixture(rows).buffer, 0, streamRows * 8)
  let open = false
  let release: () => void = () => {}
  const gate = new Promise<void>(r => {
    release = () => {
      open = true
      r()
    }
  })
  const catalog: DatasetCatalog = {
    pointCount: rows,
    // `hasPointIds: false` ⇒ `asDataSource.pointIds` throws the "isolated identity space" error the
    // store already handles, so this probe exercises the positions channel and nothing else.
    hasPointIds: false,
    layouts: [{ id: 'primary', encoding: { kind: 'f32', stride: 8 } }],
    continuousColumns: [],
    valueColumns: [],
    categoricalColumns: [],
  } as never
  const source: StreamingSource = {
    catalog: async () => catalog,
    stream(channel: Channel): AsyncIterable<Uint8Array> {
      if (channel.kind !== 'positions') {
        return {
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            throw new Error(`streamingProbe: unsupported channel ${channel.kind}`)
          },
        }
      }
      return {
        async *[Symbol.asyncIterator]() {
          await gate
          const step = chunkRows * 8
          for (let off = 0; off < bytes.byteLength; off += step) {
            yield bytes.subarray(off, Math.min(off + step, bytes.byteLength))
          }
        },
      }
    },
  }
  return { source, openGate: release, gateOpen: () => open }
}

// ── H1 — a SHORT positions stream must not publish zero padding as data ────────────────────────
//
// WHAT THIS DOES WHEN THE DEFECT IS PRESENT: the terminal publish handed out `full`, the whole
// `pointCount`-sized allocation, instead of the arrived prefix. Nothing else in the suite notices —
// every other probe streams exactly `pointCount` rows, where the two are identical. So this fixes
// the CATALOG at `ROWS` and the STREAM at fewer, which is the only configuration that tells them
// apart, and asserts on the FINAL buffer (the intermediate prefixes were already correct).
//
// The symptom being excluded is not "a wrong length": it is `pointCount - streamRows` points
// stacked at the origin, in a buffer whose colours are sized from the same count so nothing reads
// as undefined, selectable by a lasso.
describe('DatasetStore — a short positions stream (H1)', () => {
  it('publishes only the rows that ARRIVED, not the zero-padded allocation', async () => {
    const SHORT = BATCH_ROWS + 11 // > one batch, so the read is genuinely progressive, and < ROWS
    const store = createDatasetStore()
    const probe = streamingProbe(ROWS, BATCH_ROWS, SHORT)
    store.getState().provideStreamingSource('S', probe.source)
    await store.getState().acquire('S')
    probe.openGate()
    await store.getState().ensureBuffers('S', 'primary')

    const final = store.getState().getEntry('S')!.positionsByLayout.primary
    expect(final.length / 2, 'the padded rows were published as data').toBe(SHORT)
    // …and the rows it does carry are the right ones — a length-only assertion is satisfied by a
    // buffer truncated at the wrong place.
    expect(Array.from(final)).toEqual(Array.from(positionsFixture(ROWS).subarray(0, SHORT * 2)))
    // The padding would have been (0,0). Assert none of it survived, in the form the user sees:
    // no point sits at the origin, because no fixture row does (row 0 is (0,0) — so check beyond it).
    const atOrigin = []
    for (let i = 1; i < final.length / 2; i++) {
      if (final[i * 2] === 0 && final[i * 2 + 1] === 0) atOrigin.push(i)
    }
    expect(atOrigin, 'phantom points at the origin').toEqual([])
  })

  it('an EMPTY stream publishes no points at all', async () => {
    const store = createDatasetStore()
    const probe = streamingProbe(ROWS, BATCH_ROWS, 0)
    store.getState().provideStreamingSource('E', probe.source)
    await store.getState().acquire('E')
    probe.openGate()
    await store.getState().ensureBuffers('E', 'primary')

    const final = store.getState().getEntry('E')!.positionsByLayout.primary
    // The whole-read path below paints none; the streaming path used to paint `pointCount` of them
    // on top of each other at (0,0), which reads as a dense blob rather than as "no data".
    expect(final?.length ?? 0, 'an empty read painted the whole point count at the origin').toBe(0)
  })
})

describe('DatasetStore — progressive positions (ITEM-9 restated / ITEM-10)', () => {
  it('publishes MORE THAN ONE positions prefix, each a strict prefix, converging to the whole array', async () => {
    const store = createDatasetStore()
    const probe = streamingProbe(ROWS)
    store.getState().provideStreamingSource('P', probe.source)
    await store.getState().acquire('P')
    const prefixes: number[] = []
    const epochs: number[] = []
    store.subscribe(s => {
      const e = s.datasets.P
      const p = e?.positionsByLayout.primary
      if (p) {
        prefixes.push(p.length / 2)
        epochs.push(e!.epoch)
      }
    })
    probe.openGate()
    await store.getState().ensureBuffers('P', 'primary')

    // Non-vacuity + the DRIFT-1.33 assertion: a single-step fill FAILS here.
    expect(prefixes.length).toBeGreaterThan(1)
    // Strictly increasing — a prefix never shrinks or repeats.
    for (let i = 1; i < prefixes.length; i++) expect(prefixes[i]).toBeGreaterThan(prefixes[i - 1])
    // Every intermediate publication is a STRICT prefix of the full row space.
    for (const n of prefixes.slice(0, -1)) expect(n).toBeLessThan(ROWS)
    expect(prefixes.at(-1)).toBe(ROWS)
    // Every publication bumped the epoch (deck re-uploads on it).
    for (let i = 1; i < epochs.length; i++) expect(epochs[i]).toBeGreaterThan(epochs[i - 1])

    // The final buffer is byte-identical to the whole-read result.
    const final = store.getState().getEntry('P')!.positionsByLayout.primary
    expect(final.length).toBe(ROWS * 2)
    expect(Array.from(final)).toEqual(Array.from(positionsFixture(ROWS)))
  })

  it('a published prefix carries exactly the rows that have ARRIVED (alignment by global row, INV-3/INV-10)', async () => {
    const store = createDatasetStore()
    const probe = streamingProbe(ROWS)
    store.getState().provideStreamingSource('Q', probe.source)
    await store.getState().acquire('Q')
    const oracle = positionsFixture(ROWS)
    const bad: string[] = []
    const observedPrefixRows: number[] = []
    store.subscribe(s => {
      const p = s.datasets.Q?.positionsByLayout.primary
      if (!p) return
      observedPrefixRows.push(p.length / 2)
      // Row i of ANY prefix must equal row i of the whole array — that is what makes a COMPLETE
      // colour buffer beside a PARTIAL positions buffer safe (row i means the same cell in both).
      for (let i = 0; i < p.length; i++) if (p[i] !== oracle[i]) bad.push(`row ${i >> 1}`)
    })
    probe.openGate()
    await store.getState().ensureBuffers('Q', 'primary')
    // NON-VACUITY. `bad` only ever accumulates behind `if (!p) return`, so `bad = []` is also
    // what a run with ZERO observations produces. WHEN THE DEFECT IS PRESENT — progressive
    // publication stops (e.g. `POSITIONS_ROWS_PER_BATCH` grows past the row count, so the whole
    // array lands in a single publish) — there are no PARTIAL prefixes left to check alignment
    // on, and the alignment claim in this test's title is measured on nothing while it reports
    // green. So pin that more than one publication was actually observed, and that at least one
    // of them was a genuinely PARTIAL prefix.
    expect(observedPrefixRows.length, 'no positions publication was observed at all').toBeGreaterThan(1)
    expect(
      observedPrefixRows.some(n => n < ROWS),
      'every observation was already the WHOLE array — no partial prefix was ever aligned',
    ).toBe(true)
    expect(observedPrefixRows.at(-1)).toBe(ROWS)
    expect(bad).toEqual([])
  })

  it('synthesizes the colour buffer from catalog.pointCount BEFORE any positions row lands (TEST-12 leg 1)', async () => {
    const store = createDatasetStore()
    const probe = streamingProbe(ROWS)
    store.getState().provideStreamingSource('R', probe.source)
    await store.getState().acquire('R')
    let colorsAt: { colors: number; positions: number; gateOpen: boolean } | null = null
    store.subscribe(s => {
      const e = s.datasets.R
      if (e?.colors && !colorsAt) {
        colorsAt = {
          colors: e.colors.length,
          positions: e.positionsByLayout.primary?.length ?? 0,
          gateOpen: probe.gateOpen(),
        }
      }
    })
    const pull = store.getState().ensureBuffers('R', 'primary')
    // Let the colour synthesis settle while the positions stream is still GATED.
    for (let i = 0; i < 20; i++) await Promise.resolve()

    expect(colorsAt).not.toBeNull()
    // ASSERT THE STATE WE MEASURE FROM: the gate really was still closed, so "no positions yet" is
    // the stream being held — not the stream having quietly finished first.
    expect(colorsAt!.gateOpen).toBe(false)
    expect(colorsAt!.positions).toBe(0)
    // Sized from `catalog.pointCount`, NOT from a materialized positions array.
    expect(colorsAt!.colors).toBe(ROWS * 4)

    probe.openGate()
    await pull
    expect(store.getState().getEntry('R')!.colors!.length).toBe(ROWS * 4)
  })
})
