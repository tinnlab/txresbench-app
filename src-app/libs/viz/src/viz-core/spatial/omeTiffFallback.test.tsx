// @vitest-environment jsdom
//
// omeTiffFallback.test.tsx — #158 TEST-10 [acceptance] [invariant: INV-3].
//
// > *"ABSENT ⇒ the cell falls back to `imageUnderlay()` (byte-identical to pre-ITEM-1
// >  behavior)."* — `viz-core/data/wire.ts`
//
// ── WHY THIS MOUNTS THE HOOK ─────────────────────────────────────────────────────────────
//
// The first version of this test asserted that a production `DataSource` has no
// `imagePixelSource` property. That is an ABSENCE assertion, not a FALLBACK assertion: it
// stays green with the guard it names — `if (!src?.imagePixelSource) continue` — deleted
// outright, which is precisely the line the invariant depends on. Two blind reviewers found
// it independently.
//
// So this drives the real hook, with two sources that differ in exactly one property, and
// asserts the OUTCOME differs:
//
//   * WITH the seam   → the pane gets a resolved pyramid entry, seeded from the loader.
//   * WITHOUT it      → the pane's pyramid slot is left `undefined` (never even reserved),
//                       and `imageUnderlay()` is the call that happens.
//
// `undefined` rather than `null` is the load-bearing distinction and it is what makes the
// mutation visible: with the guard removed, the hook reserves the slot, calls a method that
// is not there, catches the TypeError and writes `null` — a DIFFERENT value that the emit
// site reads differently. A test that accepted "falsy" would pass with the guard gone.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useGridRaster } from '../grid/useGridRaster'
// Each type from its DECLARING module — the same three imports `useGridRaster.ts` itself
// takes (lines 55/57), and the convention every other consumer in the package follows
// (`useGridWindows`, `useGridAnnotate`, `GridPaneLayer`, `GridDockLayer`, `gridSelection`,
// `propStability.test`). `gridModel` exports neither `PaneRect` (which it does not declare
// or even import) nor `GridViewState` (which it imports type-only from `./linkZoom` for its
// own `INITIAL_VIEW_STATE`), so this file named a module that could never have served it.
// vitest strips types, so the suite ran green against a broken import until #276 gave the
// package's `tsc` a caller.
import type { GridCell } from '../grid/gridModel'
import type { PaneRect } from '../layers/multiView'
import type { GridViewState } from '../grid/linkZoom'
import type { DataSource, ImageUnderlay } from '../data/wire'
import { loadOmeTiffPyramid, type ByteRangeSource } from './omeTiffPyramid'

// jsdom rewrites `import.meta.url` to an http URL, so the fixture is resolved from the
// vitest root instead — the file is read by node either way.
const HIRES = path.resolve(
  process.cwd(),
  'src/viz-core/spatial/fixtures/spatial-image-hires.ome.tif',
)

function fileSource(file: string): ByteRangeSource {
  const bytes = readFileSync(file)
  return {
    byteLength: bytes.byteLength,
    async read(start, end) {
      return bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + end + 1)
    },
  }
}

/** A 2x2 RGBA underlay — the single-texture path the invariant says must remain reachable. */
const UNDERLAY: ImageUnderlay = {
  data: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]),
  width: 2,
  height: 2,
  channels: 4,
  affine: [1, 0, 0, 0, 1, 0],
}

const reject = (what: string) => () => Promise.reject(new Error(`${what} not used here`))

function baseSource(underlay: () => Promise<ImageUnderlay>): DataSource {
  return {
    catalog: reject('catalog'),
    positions: reject('positions'),
    valueColumn: reject('valueColumn'),
    categorical: reject('categorical'),
    continuous: reject('continuous'),
    imageUnderlay: underlay,
    table: reject('table'),
    graph: reject('graph'),
  } as unknown as DataSource
}

const CELL: GridCell = { id: 'pane-1', kind: 'image' } as unknown as GridCell

/** Mount the hook once and return its raster state after the effects have settled. */
function mountRaster(source: DataSource): {
  result: ReturnType<typeof useGridRaster>
} {
  const holder: { result?: ReturnType<typeof useGridRaster> } = {}
  function Probe() {
    const datasetEntriesRef = useRef<Record<string, { source: DataSource | null }>>({})
    const localStatesRef = useRef<Record<string, GridViewState>>({})
    const seedViewStateRef = useRef<(cellId: string, viewState: GridViewState) => void>(() => {})
    holder.result = useGridRaster({
      cells: [CELL],
      source,
      datasetEntriesRef,
      rects: [] as readonly PaneRect[],
      insetPane: (r: PaneRect) => r,
      localStatesRef,
      seedViewStateRef,
      // #228: this suite drives the FALLBACK path only, so no frame is declared — which is itself
      // a meaningful input rather than a stub: an undeclared frame keeps the identity placement
      // the fallback has always had and binds no overlay, so every assertion below is unchanged.
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

describe('TEST-10 [acceptance] [invariant: INV-3] absent seam ⇒ the underlay path, unchanged', () => {
  it('a source WITHOUT `imagePixelSource` never reserves a pyramid slot and uses imageUnderlay()', async () => {
    const underlay = vi.fn(async () => UNDERLAY)
    const source = baseSource(underlay)
    expect('imagePixelSource' in source).toBe(false)

    const held = mountRaster(source)
    await settle()

    // NEVER RESERVED — `undefined`, not `null`. With the opt-in guard deleted, the hook would
    // reserve the slot, call a method that is not there, catch the TypeError and store `null`;
    // the emit site reads those two values differently, so this is the assertion that turns
    // red for that mutation and nothing else does.
    expect(held.result.imagePyramids[CELL.id]).toBeUndefined()
    expect(Object.keys(held.result.imagePyramids)).toEqual([])

    // …and the fallback really ran: the single-texture underlay was fetched and cached.
    expect(underlay).toHaveBeenCalledTimes(1)
    const entry = held.result.imageUnderlays[CELL.id]
    expect(entry).not.toBe('loading')
    expect(entry).not.toBeNull()
    expect(entry).toMatchObject({ width: 2, height: 2 })
  })

  it('the SAME source WITH the seam resolves a real pyramid instead — the control', async () => {
    // Without this leg, the assertions above would be satisfied by a hook that never resolves
    // anything at all, and "the fallback is intact" would be indistinguishable from "the
    // raster plane is broken".
    const underlay = vi.fn(async () => UNDERLAY)
    const withSeam = {
      ...baseSource(underlay),
      imagePixelSource: async () => (await loadOmeTiffPyramid(fileSource(HIRES))).pyramid,
    } as unknown as DataSource
    expect('imagePixelSource' in withSeam).toBe(true)

    const held = mountRaster(withSeam)
    await settle()

    const pyramid = held.result.imagePyramids[CELL.id]
    expect(pyramid).not.toBeUndefined()
    expect(pyramid).not.toBe('loading')
    expect(pyramid).not.toBeNull()
    // three levels of the REAL emitted artifact, resolved through the shipped seam
    expect((pyramid as { loader: unknown[] }).loader).toHaveLength(3)
    // and its per-channel display state was seeded from the loader, as the seam's contract says
    expect((pyramid as { channels: unknown[] }).channels.length).toBeGreaterThan(0)
    expect((pyramid as { contrastMax: number }).contrastMax).toBe(255)
  })
})
