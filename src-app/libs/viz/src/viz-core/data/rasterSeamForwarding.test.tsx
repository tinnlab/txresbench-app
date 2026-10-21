// @vitest-environment jsdom
//
// rasterSeamForwarding.test.tsx — #159 TEST-6, TEST-7.
//
// The two WRAPPERS between a data source and a renderer, and the seam each of them used to
// drop. `asDataSource` is on the production path always (the app builds
// `asDataSource(streamingSource)` and hands the grid THAT); `filteredSource` is on it whenever
// a grouped pane is under an active link filter.
//
// ── WHY THIS MOUNTS THE HOOK RATHER THAN PROBING THE OBJECT ──────────────────────────────────
// The same reason `omeTiffFallback.test.tsx` gives for its own shape, and it is worth repeating
// because the temptation here is stronger. `expect('imagePixelSource' in wrapped).toBe(true)` is
// a property assertion: it stays green if the forwarded function is wired to the wrong source,
// returns the wrong thing, or is never callable. So each case drives the REAL `useGridRaster`
// through the REAL wrapper and asserts the OUTCOME differs — a resolved pyramid on one side, an
// unreserved slot and a single-texture fetch on the other.
//
// The `in`-checks that do appear are the ones about ABSENCE, where there is no outcome to
// observe: `undefined` and "key not present" behave identically at the guard today, and the
// distinction only matters because the shipped invariant test is written against it.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useRef } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useGridRaster } from '../grid/useGridRaster'
import type { GridCell } from '../grid/gridModel'
import type { DataSource, ImageUnderlay } from './wire'
import type { StreamingSource } from './streamingSource'
import { asDataSource } from './streamingAdapter'
import { filteredSource } from './filteredSource'
import { loadOmeTiffPyramid, type ByteRangeSource } from '../spatial/omeTiffPyramid'
import { imagePixelSource } from '../spatial/imageFixture'

const HIRES = path.resolve(process.cwd(), 'src/viz-core/spatial/fixtures/spatial-image-hires.ome.tif')

function fileSource(file: string): ByteRangeSource {
  const bytes = readFileSync(file)
  return {
    byteLength: bytes.byteLength,
    async read(start, end) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
    },
  }
}

const UNDERLAY: ImageUnderlay = {
  data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
  width: 2,
  height: 2,
  channels: 4,
  affine: [1, 0, 0, 0, 1, 0],
}

const CATALOG = {
  datasetId: 'd1',
  pointCount: 0,
  layouts: [],
  valueColumns: [],
  categoricalColumns: [],
  continuousColumns: [],
  hasImage: true,
  image: { width: 2, height: 2, channels: 4 as const, affine: [1, 0, 0, 0, 1, 0] as const },
}

/** A streaming source that serves the underlay bytes on the `image` channel, and optionally
 *  declares the two raster seams. */
function streaming(opts: { pyramid?: boolean; mask?: unknown } = {}): StreamingSource {
  const base = {
    catalog: async () => CATALOG,
    async *stream(channel: { kind: string }) {
      if (channel.kind !== 'image') throw new Error(`no ${channel.kind} channel here`)
      yield UNDERLAY.data
    },
  }
  return {
    ...base,
    ...(opts.pyramid
      ? { imagePixelSource: async () => (await loadOmeTiffPyramid(fileSource(HIRES))).pyramid }
      : {}),
    ...(opts.mask !== undefined ? { imageLabelMask: () => opts.mask } : {}),
  } as unknown as StreamingSource
}

const PANE: GridCell = { id: 'pane-1', kind: 'image' } as unknown as GridCell

interface Seed {
  id: string
  target: readonly number[]
  zoom: number
}

function mountRaster(source: DataSource, rect?: { width: number; height: number }) {
  const holder: { result?: ReturnType<typeof useGridRaster>; seeds: Seed[] } = { seeds: [] }
  function Probe() {
    const datasetEntriesRef = useRef<Record<string, { source: DataSource | null }>>({})
    const localStatesRef = useRef<Record<string, never>>({})
    const seedViewStateRef = useRef<(id: string, s: { target: number[]; zoom: number }) => void>(
      (id, state) => {
        holder.seeds.push({ id, target: state.target, zoom: state.zoom })
      },
    )
    holder.result = useGridRaster({
      cells: [PANE],
      source,
      datasetEntriesRef,
      rects: rect ? [{ id: PANE.id, x: 0, y: 0, ...rect }] : [],
      insetPane: (r: unknown) => r,
      localStatesRef,
      seedViewStateRef,
      // #228: these fixtures declare NO coordinate space and NO placement, so the frame is
      // RESOLVED-but-empty. That is the honest state for a source that says nothing about where
      // it sits, and it is what keeps TEST-19's expected centres — (700, 900) and (200, 150) —
      // in the raster's own array-index units, unchanged by the coordinate binding.
      cellFrame: () => ({
        catalogResolved: true,
        binding: { bound: false, reason: 'this fixture declares no coordinate_space' },
      }),
    } as never)
    return null
  }
  render(<Probe />)
  return holder as { result: ReturnType<typeof useGridRaster>; seeds: Seed[] }
}

const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise(resolve => setTimeout(resolve, 5))
}

afterEach(cleanup)

describe('TEST-6 — `asDataSource` forwards the pyramid to the renderer, or nothing sees it', () => {
  it('a streaming source that declares a pyramid resolves one THROUGH the adapter', async () => {
    const wrapped = asDataSource(streaming({ pyramid: true }))
    const held = mountRaster(wrapped)
    await settle()

    const entry = held.result.imagePyramids[PANE.id]
    expect(
      entry,
      'the pane must resolve a pyramid through the adapter — before this item the adapter ' +
        'dropped the seam, so a source that implemented it perfectly reached no renderer',
    ).toBeTruthy()
    expect(entry).not.toBe('loading')
    expect((entry as { loader: unknown[] }).loader).toHaveLength(3)
    // Seeded display state, i.e. the entry the emit site actually reads — not just a loader.
    expect((entry as { channels: unknown[] }).channels.length).toBeGreaterThan(0)
  })

  it('a streaming source WITHOUT one leaves the slot unreserved and takes the byte channel', async () => {
    // The control. Without it, the case above cannot distinguish "the adapter forwards" from
    // "the hook resolves a pyramid for everything".
    const wrapped = asDataSource(streaming({}))
    expect('imagePixelSource' in (wrapped as object)).toBe(false)

    const held = mountRaster(wrapped)
    await settle()

    // NEVER RESERVED — `undefined`, not `null`. The emit site reads those differently.
    expect(held.result.imagePyramids[PANE.id]).toBeUndefined()
    // …and the single-texture path really ran, over the `image` byte channel.
    const under = held.result.imageUnderlays[PANE.id]
    expect(under).not.toBe('loading')
    expect(under).toMatchObject({ width: 2, height: 2 })
  })

  it('forwards a declared label mask, and keeps the key absent when there is none', async () => {
    const token = { labels: new Uint16Array([9]) }
    const withMask = asDataSource(streaming({ mask: token }))
    expect('imageLabelMask' in (withMask as object)).toBe(true)
    expect(await withMask.imageLabelMask!()).toBe(token)

    const without = asDataSource(streaming({}))
    expect('imageLabelMask' in (without as object)).toBe(false)
  })
})

describe('TEST-7 — `filteredSource` keeps both seams while it filters the columns', () => {
  const FILTERS = [{ column: 'c', range: [0, 1] as const }]

  it('a filtered wrapper still resolves the pyramid the pane needs', async () => {
    // `filteredSource` short-circuits to the SAME object when there are no filters, so the hole
    // is only reachable WITH one — which is why this case supplies one. A pane going blank the
    // moment a user drags a visual-map window is exactly the shape that gets reported as "the
    // image is flaky" rather than as a dropped seam.
    const base = asDataSource(streaming({ pyramid: true }))
    const wrapped = filteredSource(base, FILTERS as never)
    expect(wrapped).not.toBe(base)

    const held = mountRaster(wrapped)
    await settle()

    const entry = held.result.imagePyramids[PANE.id]
    expect(entry).toBeTruthy()
    expect(entry).not.toBe('loading')
    expect((entry as { loader: unknown[] }).loader).toHaveLength(3)
  })

  it('forwards a label mask, and keeps absence absent', async () => {
    const token = { labels: new Uint16Array([9]) }
    const withMask = filteredSource(asDataSource(streaming({ mask: token })), FILTERS as never)
    expect('imageLabelMask' in (withMask as object)).toBe(true)
    expect(await withMask.imageLabelMask!()).toBe(token)

    const without = filteredSource(asDataSource(streaming({})), FILTERS as never)
    expect('imagePixelSource' in (without as object)).toBe(false)
    expect('imageLabelMask' in (without as object)).toBe(false)
  })

  it('with NO filters it is the base object itself — the short-circuit is intact', () => {
    // Stated because it is what makes the wrapper cheap, and because a change that made it
    // always allocate would make every pane's source identity churn per render.
    const base = asDataSource(streaming({ pyramid: true }))
    expect(filteredSource(base, [])).toBe(base)
    expect(filteredSource(base, undefined)).toBe(base)
  })
})

// ── #159 TEST-19 — the pane is framed on the IMAGE, not on its sample count ──────────────────
//
// A latent bug this item made reachable, found by looking at a real render rather than at a
// green test. The camera-framing effect read the level's dimensions POSITIONALLY —
// `shape[len-1]` as width, `shape[len-2]` as height — which is correct for the in-memory fixture
// (`['c','y','x']`) that was the only source ever to drive this path.
//
// A real emitted RGB raster is INTERLEAVED: `['c','y','x','_c']`, with a trailing per-pixel
// component axis. The positional read therefore took the SAMPLE COUNT — 3 — as the image width,
// framed the pane as if the image were 3 x 1800, and drew a real 1400 x 1800 tissue image at the
// wrong zoom, centred on the wrong point, half of it off the edge of its own pane.
//
// NOTHING CAUGHT IT: the pyramid resolved, the layer built, the tiles were fetched by range, the
// console was clean, and the existing camera spec asserts only that the camera MOVED — which it
// did, to the wrong place. It is visible in exactly one way, by looking at the picture.
describe('TEST-19 — camera framing reads the level’s axis LABELS, not positions', () => {
  it('frames a REAL interleaved raster on its true extent', async () => {
    const held = mountRaster(asDataSource(streaming({ pyramid: true })), { width: 370, height: 614 })
    await settle()

    expect(held.seeds.length, 'the framing effect ran').toBeGreaterThan(0)
    const seed = held.seeds[held.seeds.length - 1]

    // The real fixture is 1400 x 1800 and interleaved with 3 samples. Centre = (700, 900).
    expect(seed.target[0]).toBe(700)
    expect(seed.target[1]).toBe(900)

    // THE WRONG ANSWERS, NAMED. With the positional read, `iw` is the sample count (3) and `ih`
    // is the image WIDTH (1400) — so the centre lands at (1.5, 700) and the zoom is computed
    // against 1400 instead of 1800.
    //
    // The second line here used to exclude 700_000_000, a number nothing produces — an assertion
    // structurally incapable of failing, sitting inside the block whose entire purpose is naming
    // the values that CAN occur. It excluded a typo instead of a bug. The real wrong value is
    // 700: half the image's WIDTH, read as if it were the height.
    expect(seed.target[0], 'not half the sample count').not.toBe(1.5)
    expect(seed.target[1], 'not half the image WIDTH').not.toBe(700)
    expect(seed.zoom).toBeCloseTo(Math.log2(370 / 1800), 9)
    expect(seed.zoom, 'not the zoom that fits the image WIDTH').not.toBeCloseTo(
      Math.log2(370 / 1400),
      6,
    )
  })

  it('still frames a PLANAR source correctly — the fallback the old read assumed', async () => {
    // The non-vacuity control, driven by the SHIPPED in-memory fixture — the planar
    // `['c','y','x']` source every showcase story uses, and the one the old positional read was
    // written against. If this fix had broken it, every fixture-driven raster story would frame
    // on the channel count instead of the image.
    const loader = imagePixelSource({ base: 512 })
    const level0 = loader[0]
    const planar = {
      catalog: async () => CATALOG,
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('no channel here')
      },
      imagePixelSource: async () => loader,
    }
    expect(level0.labels).toEqual(['c', 'y', 'x'])

    const held = mountRaster(asDataSource(planar as never), { width: 300, height: 300 })
    await settle()
    const seed = held.seeds[held.seeds.length - 1]
    const width = level0.shape[2]
    const height = level0.shape[1]
    expect(seed.target[0]).toBe(width / 2)
    expect(seed.target[1]).toBe(height / 2)
    expect(seed.zoom).toBeCloseTo(Math.log2(300 / Math.max(width, height)), 9)
  })
})
