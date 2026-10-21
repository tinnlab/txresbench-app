// @vitest-environment jsdom
//
// useGridColoring.test.tsx — TEST-16 (ITEM-12) + TEST-17 (ITEM-15).
//
// ── WHY THIS MOUNTS THE HOOK ──────────────────────────────────────────────────────────────────
//
// Both defects live in the INTERACTION of the hook's two effects, not in either one. The recolor
// effect streams a continuous column for its domain; the legend effect independently calls
// `computeColoring` (a second read) and `src.continuous` (a third). Nothing short of running both
// effects against ONE source can count the reads that actually happen, which is why this is a
// mounted-hook test and not a unit test of a helper.
//
// ── WHAT EACH TEST DOES WHEN THE DEFECT IS PRESENT (the standing check) ───────────────────────
//
// TEST-16 counted 3 reads before the fix and counts 1 after; its control is the SECOND leg, where a
// switch to a DIFFERENT column must still cost exactly one read — a cache keyed too coarsely (or
// never invalidated) passes the first leg alone while serving stale bytes.
//
// TEST-17 counts LIVE reads — reads that were never aborted — not discarded results. That is the
// distinction the pre-fix `alive` boolean fails: it lets every read run to completion and throws the
// answer away, so a "results were discarded" assertion stays green with the defect fully intact.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useGridColoring, type GridColoringInputs } from './useGridColoring'
import { createVizStores } from '../../adapter/vizStores'
import { createCellDisplayStore } from '../../adapter/CellDisplay.store'
import type { Channel, StreamingSource } from '../data/streamingSource'
import type { DataSource, DatasetCatalog } from '../data/wire'
import type { GridCell } from './gridModel'
import { asDataSource } from '../data/streamingAdapter'
import { useRef, type RefObject } from 'react'

const ROWS = 64

/** A counting `StreamingSource` over two continuous columns. Records one entry per `stream()` CALL
 *  and marks it `live` until the iteration either completes or is aborted — so an aborted read is
 *  distinguishable from a read that ran to completion and had its result thrown away. */
interface CountingSource {
  readonly source: StreamingSource
  /** every `stream()` call, in order */
  readonly calls: { channel: string; key: string; live: boolean; aborted: boolean; signal: AbortSignal | undefined }[]
  reads(key: string): number
  liveReads(): number
  /** Resolve to release the chunk currently held back (reads hang until then). */
  release: () => void
}

function countingSource(): CountingSource {
  const calls: CountingSource['calls'] = []
  let release: () => void = () => {}
  const held = new Promise<void>(r => {
    release = r
  })
  const columns: Record<string, Float32Array> = {
    alpha: Float32Array.from({ length: ROWS }, (_, i) => i),
    beta: Float32Array.from({ length: ROWS }, (_, i) => ROWS - i),
  }
  // A categorical column, so the DataSource-shaped read path (the one leg (b) is about) can be
  // driven: `asDataSource.categorical` streams u16 codes and never goes through streamColumnDomain.
  const codes = new Uint16Array(ROWS)
  for (let i = 0; i < ROWS; i++) codes[i] = i % 3
  const catalog: DatasetCatalog = {
    pointCount: ROWS,
    hasPointIds: false,
    layouts: [{ id: 'primary', encoding: { kind: 'f32', stride: 8 } }],
    continuousColumns: [{ id: 'alpha' }, { id: 'beta' }],
    valueColumns: [],
    categoricalColumns: [{ id: 'gamma', categories: ['a', 'b', 'c'] }],
  } as never
  const source: StreamingSource = {
    catalog: async () => catalog,
    stream(channel: Channel, opts?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
      const key = channel.kind === 'continuous' || channel.kind === 'categorical' ? channel.key : ''
      const rec = { channel: channel.kind, key, live: true, aborted: false, signal: opts?.signal }
      calls.push(rec)
      return {
        async *[Symbol.asyncIterator]() {
          try {
            const col = channel.kind === 'continuous' ? columns[key] : null
            const bytes =
              channel.kind === 'categorical'
                ? new Uint8Array(codes.buffer)
                : col
                  ? new Uint8Array(col.buffer)
                  : (() => {
                      throw new Error(`unsupported channel ${channel.kind}`)
                    })()
            const half = Math.floor(bytes.byteLength / 8) * 4
            yield bytes.subarray(0, half)
            // Hold the tail until released — this is the window a colour switch aborts in.
            const onAbort = new Promise<void>((_, reject) => {
              if (opts?.signal) {
                if (opts.signal.aborted) return reject(new Error('aborted'))
                opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
              }
            })
            // Mark the loser of the race handled: once the generator has returned, nothing awaits it
            // any more, and an unattended rejection would be reported as an unhandled one.
            void onAbort.catch(() => {})
            await Promise.race([held, onAbort])
            yield bytes.subarray(half)
          } catch (e) {
            rec.aborted = true
            throw e
          } finally {
            rec.live = false
          }
        },
      }
    },
  }
  return {
    source,
    calls,
    reads: key => calls.filter(c => c.channel === 'continuous' && c.key === key).length,
    liveReads: () => calls.filter(c => c.live).length,
    release: () => release(),
  }
}

function cellFor(key: string): GridCell {
  return {
    id: 'cell-1',
    kind: 'scatter',
    layoutId: 'primary',
    datasetId: 'DS',
    colorBy: { mode: 'continuous', key, hidden: new Set<number>() },
  } as never
}

/** Mount the hook over a real `VizStores` whose DatasetStore holds the counting streaming source. */
function Harness({ cell, stores, cellDisplay, pull }: {
  cell: GridCell
  stores: ReturnType<typeof createVizStores>
  cellDisplay: ReturnType<typeof createCellDisplayStore>
  pull: DataSource
}) {
  const denseCells = [cell]
  const denseCellsRef = useRef(denseCells) as RefObject<readonly GridCell[]>
  denseCellsRef.current = denseCells
  const entries = stores.datasetStore.getState().datasets
  const datasetEntriesRef = useRef(entries) as RefObject<typeof entries>
  datasetEntriesRef.current = entries
  const cellMapRef = useRef({ [cell.id]: cell }) as RefObject<Record<string, GridCell>>
  cellMapRef.current = { [cell.id]: cell }
  const inputs: GridColoringInputs = {
    stores,
    cellDisplay,
    source: pull,
    catalog: null,
    cells: denseCells,
    denseCells,
    denseIds: new Set([cell.id]),
    datasetEntries: entries,
    denseCellsRef,
    datasetEntriesRef,
    cellMapRef,
    colorOverrides: {},
    linkedHiddenFor: () => undefined,
    linkColumnFilterFor: () => null,
    perCellRange: {},
    linkGroups: [] as never,
  }
  useGridColoring(inputs)
  return null
}

async function settle(ticks = 40): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve()
}

afterEach(cleanup)

describe('useGridColoring — ITEM-12: one read per column per colour change (TEST-16)', () => {
  it('ONE continuous colour change issues exactly ONE read of that column', async () => {
    const counting = countingSource()
    const stores = createVizStores()
    const cellDisplay = createCellDisplayStore()
    stores.datasetStore.getState().provideStreamingSource('DS', counting.source)
    await stores.datasetStore.getState().acquire('DS')
    const pull = asDataSource(counting.source)

    render(<Harness cell={cellFor('alpha')} stores={stores} cellDisplay={cellDisplay} pull={pull} />)
    counting.release()
    await settle()

    // Non-vacuity: the pass really did read the column (a hook that never ran would also report 0
    // duplicate reads).
    expect(counting.reads('alpha')).toBeGreaterThan(0)
    // The property: the domain, the coloring and the legend share ONE read. Before ITEM-12 this was
    // 3 — `streamColumnDomain`, `computeColoring`, and `src.continuous`.
    expect(counting.reads('alpha')).toBe(1)
  })

  it('a switch to a DIFFERENT column still issues exactly one read — the stale-cache control', async () => {
    const counting = countingSource()
    const stores = createVizStores()
    const cellDisplay = createCellDisplayStore()
    stores.datasetStore.getState().provideStreamingSource('DS', counting.source)
    await stores.datasetStore.getState().acquire('DS')
    const pull = asDataSource(counting.source)

    const view = render(
      <Harness cell={cellFor('alpha')} stores={stores} cellDisplay={cellDisplay} pull={pull} />,
    )
    counting.release()
    await settle()
    view.rerender(<Harness cell={cellFor('beta')} stores={stores} cellDisplay={cellDisplay} pull={pull} />)
    await settle()

    // The new column is genuinely read (a cache that survived the switch would serve `alpha`'s bytes
    // under `beta`'s name and read nothing) …
    expect(counting.reads('beta')).toBe(1)
    // … and the old one was not re-read by the switch.
    expect(counting.reads('alpha')).toBe(1)
  })
})

describe('useGridColoring — ITEM-15: the colour pass is cancellable (TEST-17)', () => {
  it('streamColumnDomain receives a real AbortSignal, and rapid switches leave at most ONE live read', async () => {
    const counting = countingSource()
    const stores = createVizStores()
    const cellDisplay = createCellDisplayStore()
    stores.datasetStore.getState().provideStreamingSource('DS', counting.source)
    await stores.datasetStore.getState().acquire('DS')
    const pull = asDataSource(counting.source)

    // Three colour switches while every read is held mid-stream (the tail is never released).
    const view = render(
      <Harness cell={cellFor('alpha')} stores={stores} cellDisplay={cellDisplay} pull={pull} />,
    )
    await settle(6)
    view.rerender(<Harness cell={cellFor('beta')} stores={stores} cellDisplay={cellDisplay} pull={pull} />)
    await settle(6)
    view.rerender(<Harness cell={cellFor('alpha')} stores={stores} cellDisplay={cellDisplay} pull={pull} />)
    await settle(6)

    // ASSERT THE STATE WE MEASURE FROM: the reads really are suspended mid-stream — the tail was
    // never released — so "not live" can only mean ABORTED, never "finished normally".
    expect(counting.calls.length).toBeGreaterThan(1)
    // At most one read is still running: every superseded pass was cancelled, not merely discarded.
    expect(counting.liveReads()).toBeLessThanOrEqual(1)
    // And the cancellation was real — a signal reached the source and fired.
    expect(counting.calls.some(c => c.aborted)).toBe(true)
  })

  it('unmount aborts the in-flight read', async () => {
    const counting = countingSource()
    const stores = createVizStores()
    const cellDisplay = createCellDisplayStore()
    stores.datasetStore.getState().provideStreamingSource('DS', counting.source)
    await stores.datasetStore.getState().acquire('DS')
    const pull = asDataSource(counting.source)

    const view = render(
      <Harness cell={cellFor('alpha')} stores={stores} cellDisplay={cellDisplay} pull={pull} />,
    )
    await settle(6)
    expect(counting.liveReads()).toBeGreaterThan(0) // it really was in flight
    view.unmount()
    await settle()
    expect(counting.liveReads()).toBe(0)
  })
})


// ── TEST-17 leg (b) — `asDataSource` FORWARDS the signal (owner grant, 2026-08-16) ─────────────
//
// What this does when the defect is present: with the adapter dropping `opts`, `stream()` receives
// `undefined` and a DataSource-shaped read runs to completion after a colour switch. Leg (b) asserts
// the FORWARDING directly (the signal object reaches `source.stream`), and the categorical leg
// asserts the CONSEQUENCE — the read that the pass cache alone could never cancel now cancels.
describe('useGridColoring — ITEM-15 leg (b): the signal reaches source.stream', () => {
  it('an ADAPTER-shaped read carries the pass signal into source.stream', async () => {
    const counting = countingSource()
    const stores = createVizStores()
    const cellDisplay = createCellDisplayStore()
    stores.datasetStore.getState().provideStreamingSource('DS', counting.source)
    await stores.datasetStore.getState().acquire('DS')
    const pull = asDataSource(counting.source)

    // A CATEGORICAL colour-by, deliberately: it is the read that goes through `asDataSource` rather
    // than through `streamColumnDomain`, so it is the one leg (b) is actually about. Asserting over
    // ALL channels would NOT discriminate — the continuous stream reaches `source.stream` directly
    // and has carried a signal since leg (a), so a mixed assertion stays green with the adapter
    // dropping `opts` entirely. (That was this test's first draft; both controls left it green.)
    const catCell = {
      ...cellFor('gamma'),
      colorBy: { mode: 'categorical', key: 'gamma', hidden: new Set<number>() },
    } as never
    render(<Harness cell={catCell} stores={stores} cellDisplay={cellDisplay} pull={pull} />)
    counting.release()
    await settle()

    const viaAdapter = counting.calls.filter(c => c.channel === 'categorical')
    // Non-vacuity: the adapter path was genuinely exercised.
    expect(viaAdapter.length).toBeGreaterThan(0)
    expect(viaAdapter.every(c => c.signal instanceof AbortSignal)).toBe(true)
  })

  it('a CATEGORICAL colour-by — a DataSource-shaped read — is aborted by a switch', async () => {
    const counting = countingSource()
    const stores = createVizStores()
    const cellDisplay = createCellDisplayStore()
    stores.datasetStore.getState().provideStreamingSource('DS', counting.source)
    await stores.datasetStore.getState().acquire('DS')
    const pull = asDataSource(counting.source)

    const catCell = { ...cellFor('gamma'), colorBy: { mode: 'categorical', key: 'gamma', hidden: new Set<number>() } } as never
    const view = render(<Harness cell={catCell} stores={stores} cellDisplay={cellDisplay} pull={pull} />)
    await settle(6)
    // ASSERT THE STATE WE MEASURE FROM: the categorical read really is suspended mid-stream (its tail
    // is never released), so "not live" below can only mean ABORTED.
    const cat = counting.calls.filter(c => c.channel === 'categorical')
    expect(cat.length).toBeGreaterThan(0)
    expect(cat.some(c => c.live)).toBe(true)

    view.unmount()
    await settle()
    expect(counting.calls.filter(c => c.channel === 'categorical' && c.live)).toEqual([])
    expect(counting.calls.some(c => c.channel === 'categorical' && c.aborted)).toBe(true)
  })
})
