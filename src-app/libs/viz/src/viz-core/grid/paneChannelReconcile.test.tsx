// @vitest-environment jsdom
//
// paneChannelReconcile.test.tsx — #288 TEST-22.
//
// `useGridRaster` stores `imagePyramids[cellId].channels`, and that array is NOT the one the
// layer builder consumes — it is the one the per-channel EDITOR lists and the one
// `setImageChannel(cellId, i, patch)` indexes BY POSITION. So it has its own reconciliation,
// and it is not redundant with the builder's: the builder can only fix what is DRAWN.
//
// It was pinned by nothing. A blind audit reverted `useGridRaster.ts`'s call to
// `cell.channels ?? seedChannelsForLoader(loader)` and the whole package stayed green, which is
// how a persisted 5-entry array on a 2-channel image would have gone on offering three controls
// that move nothing — and a 1-entry array on a 5-channel image would have hidden four channels
// that are drawn.
//
// The hook is MOUNTED rather than reasoned about, for the same reason `omeTiffFallback.test.tsx`
// mounts it: the value under test is produced by an effect, and an absence assertion over a
// pure helper is not an assertion about this hook at all.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useRef } from 'react'
import { useGridRaster } from './useGridRaster'
import type { GridCell } from './gridModel'
import type { GridViewState } from './linkZoom'
import type { PaneRect } from '../layers/multiView'
import type { DataSource } from '../data/wire'
import { imagePixelSource, imagePixelSource16 } from '../spatial/imageFixture'
import type { RasterChannelState } from '../spatial/rasterImageLayers'

const reject = (what: string) => () => Promise.reject(new Error(`${what} not used here`))

function sourceWithChannels(channels: number): DataSource {
  return {
    catalog: reject('catalog'),
    positions: reject('positions'),
    valueColumn: reject('valueColumn'),
    categorical: reject('categorical'),
    continuous: reject('continuous'),
    imageUnderlay: reject('imageUnderlay'),
    table: reject('table'),
    graph: reject('graph'),
    imagePixelSource: async () => imagePixelSource({ base: 64, channels, levels: 1 }),
  } as unknown as DataSource
}

const chans = (n: number): RasterChannelState[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `C${i}`,
    color: [i, i, i] as [number, number, number],
    contrastLimits: [0, 255] as [number, number],
    visible: true,
  }))

function mount(cell: GridCell, source: DataSource) {
  const holder: { result?: ReturnType<typeof useGridRaster> } = {}
  function Probe() {
    const datasetEntriesRef = useRef<Record<string, { source: DataSource | null }>>({})
    const localStatesRef = useRef<Record<string, GridViewState>>({})
    const seedViewStateRef = useRef<(cellId: string, viewState: GridViewState) => void>(() => {})
    holder.result = useGridRaster({
      cells: [cell],
      source,
      datasetEntriesRef,
      rects: [] as readonly PaneRect[],
      insetPane: (r: PaneRect) => r,
      localStatesRef,
      seedViewStateRef,
      cellFrame: () => ({
        catalogResolved: true,
        binding: { bound: false, reason: 'no declared frame in this fixture' },
      }),
    })
    return null
  }
  render(<Probe />)
  return holder as { result: ReturnType<typeof useGridRaster> }
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 5))
}

afterEach(cleanup)

describe('TEST-22 the pane form lists exactly the channels the resolved loader has', () => {
  for (const [loaderChannels, persisted] of [
    [2, 5],
    [5, 1],
    [3, 3],
  ] as const) {
    it(`loader ${loaderChannels}, persisted cell.channels ${persisted}`, async () => {
      const cell = { id: 'pane-1', kind: 'image', channels: chans(persisted) } as unknown as GridCell
      const held = mount(cell, sourceWithChannels(loaderChannels))
      await settle()

      const entry = held.result.imagePyramids[cell.id]
      expect(entry).not.toBe('loading')
      expect(entry).not.toBeNull()
      const resolved = entry as { channels: RasterChannelState[] }
      expect(resolved.channels).toHaveLength(loaderChannels)
      // The caller's own state for the channels that survive is KEPT — reconciling must not
      // silently discard a user's colours and windows for the channels that do exist.
      for (let i = 0; i < Math.min(loaderChannels, persisted); i++) {
        expect([i, resolved.channels[i].name]).toEqual([i, `C${i}`])
      }
    })
  }

  it('a caller-supplied cell.loader wins over the fetched pyramid, for the WHOLE entry', async () => {
    // `effectiveLoaderFor(cell, entry)` is `cell.loader ?? entry.loader`, so this is the loader
    // the cell is DRAWN from — and this entry is what the editor lists, what `setImageChannel`
    // indexes and what `autoContrastChannel` reads. Keying only `channels` off it (which an
    // earlier cut did) fixed the row count and left `contrastMax` and `loader` on the fetched
    // pyramid.
    //
    // ── WHAT THAT COSTS *IN THIS CONFIGURATION*, MEASURED ───────────────────────────────
    // Stated exactly, because an earlier version of this note named two consequences that this
    // setup cannot produce — a guess narrated as a measurement, which is the class this branch
    // spent five audit rounds correcting.
    //
    // Here (`cell.loader` 2-channel Uint16, `cell.channels` 5 entries, fetch 5-channel Uint8)
    // the reconciliation TRUNCATES, so no channel is seeded and the caller's own `[0, 255]`
    // limits survive. What goes wrong is the pair around them: the form gets `contrastMax` 255
    // from the Uint8 FETCH while the layer draws from a Uint16 loader, and `autoContrastChannel`
    // reads `e.loader` — the fetched pyramid — so it SUCCEEDS, silently, with the wrong source's
    // statistics, and writes an 8-bit window onto a channel drawn from 16-bit pixels. A `catch`
    // that never fires is worse than one that swallows something.
    //
    // The two consequences the earlier note named are real but need other shapes, so they are
    // named with them rather than here — and the first was narrowed WRONGLY on the first
    // attempt, which is worth leaving on the record:
    //
    //   * a `[0, 65535]` seeded window is reached whenever the reconciliation SEEDS, which is
    //     `cell.channels` shorter than the effective loader (the extend path) **and, more
    //     commonly, `cell.channels` ABSENT** — `reconcileChannelsToLoader` answers `undefined`
    //     with a full `seedChannelsForLoader`. A cell with a caller-supplied `cell.loader` and
    //     no persisted channel state is the ORDINARY shape, not an edge, so the earlier
    //     "needs a SHORTER array" understated the blast radius while sounding measured.
    //     Measured under the earlier cut: `cell.loader` 5-channel Uint16, no `cell.channels`,
    //     5-channel Uint8 fetch gave `[0,65535] x 5` under `contrastMax` 255.
    //   * an out-of-range auto-contrast selection needs `cell.loader` WIDER than the fetch,
    //     because the index range is `channels.length`. That one is both necessary and
    //     sufficient, and it is not this case.
    //
    // Reverting any of the three fields to the fetched loader turns this red — measured, each
    // field on its own.
    //
    // It is not the only case here that sets `cell.loader`: the SEEDING case below sets one too,
    // and the two are complementary rather than redundant. This one takes the TRUNCATE branch
    // (five persisted entries, a two-channel loader); that one takes the SEED branch (no
    // persisted entries at all), and a mutation confined to seeding —
    // `cell.channels ? reconcile(cell.channels, effective) : reconcile(undefined, loader)` — is
    // invisible to every other case in this file and red only there.
    //
    // Outside this file, `coordinateBindingPane.test.tsx`'s TEST-26 also sets a `cell.loader`
    // and still could not have seen any of it: its source exposes no `imagePixelSource`, so
    // `useGridRaster` reserves no entry at all. Measured: with all three fields reverted, that
    // file is 14/14. (Two earlier versions of this line were wrong in turn — first "no other
    // case sets `cell.loader` at all", false of the package; then "no other case IN THIS FILE",
    // falsified 25 lines later by the same commit that wrote it.)
    const cellLoader = imagePixelSource16({ base: 64, channels: 2, levels: 1 })
    const cell = {
      id: 'pane-1',
      kind: 'image',
      loader: cellLoader,
      channels: chans(5),
    } as unknown as GridCell
    const held = mount(cell, sourceWithChannels(5)) // the FETCHED pyramid has five, Uint8
    await settle()

    const entry = held.result.imagePyramids[cell.id] as {
      channels: RasterChannelState[]
      contrastMax: number
      loader: unknown[]
    }
    expect(entry.channels).toHaveLength(2) // the cell's loader, not the fetch's five
    expect(entry.contrastMax).toBe(65535) // …and its DTYPE, not the fetch's Uint8
    expect(entry.loader).toBe(cellLoader) // …and the array auto-contrast will read
  })

  it('…and the ORDINARY shape — a cell.loader with NO persisted channel state — seeds from IT', async () => {
    // The seeding path (`reconcileChannelsToLoader(undefined, …)`), which is what a cell with a
    // caller-supplied loader and no saved channel state takes. Under the earlier cut this gave
    // `[0, 65535]` windows (seeded from the Uint16 `cell.loader`) under a `contrastMax` of 255
    // (from the Uint8 fetch) — a slider pinned right whose first touch collapses the window.
    const cellLoader = imagePixelSource16({ base: 64, channels: 5, levels: 1 })
    const cell = { id: 'pane-1', kind: 'image', loader: cellLoader } as unknown as GridCell
    const held = mount(cell, sourceWithChannels(5)) // the fetch is 5-channel Uint8
    await settle()
    const entry = held.result.imagePyramids[cell.id] as {
      channels: RasterChannelState[]
      contrastMax: number
    }
    expect(entry.channels).toHaveLength(5)
    expect(entry.contrastMax).toBe(65535)
    // the seeded windows and the slider bound agree — which is the whole property
    expect(entry.channels.map(c => c.contrastLimits)).toEqual(
      Array.from({ length: 5 }, () => [0, entry.contrastMax]),
    )
  })

  it('and with NO persisted state and NO cell.loader it seeds one entry per fetched channel', async () => {
    // Without this the assertions above would be satisfied by a hook that always seeds from the
    // loader and ignores `cell.channels` entirely, which is a different (and also wrong) thing.
    const cell = { id: 'pane-1', kind: 'image' } as unknown as GridCell
    const held = mount(cell, sourceWithChannels(4))
    await settle()
    const resolved = held.result.imagePyramids[cell.id] as { channels: RasterChannelState[] }
    expect(resolved.channels).toHaveLength(4)
    expect(resolved.channels[0].name).toBe('Channel 0')
  })
})
