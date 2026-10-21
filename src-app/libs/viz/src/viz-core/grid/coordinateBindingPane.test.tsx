// @vitest-environment jsdom
//
// coordinateBindingPane.test.tsx — #228 TEST-9 and TEST-14, on the hook that actually runs.
//
// Both are behaviours of `useGridRaster`'s effects, so both MOUNT it. `omeTiffFallback.test.tsx`
// established that a hook here can be driven for real; the alternative — re-implementing the
// framing arithmetic in the test — would assert the formula against itself.

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { useGridRaster } from './useGridRaster'
import type { GridCell } from './gridModel'
import type { GridViewState } from './linkZoom'
import type { PaneRect } from '../layers/multiView'
import type { DataSource } from '../data/wire'
import type { PaneFrame } from '../spatial/coordinateBinding'

/** The producer's committed numbers for the hires image, written literally (see TEST-3). */
const TO_SPACE = [5, 0, 0, 0, 5, 0] as const
const FULL_W = 1400
const FULL_H = 1800
/** the COARSEST level of the same real fixture — the single-texture path's own grid. */
const LEVEL_W = 350
const LEVEL_H = 450
const SPACE = 'visium:Visium_Mouse_Olfactory_Bulb'

const CELL: GridCell = { id: 'pane-1', kind: 'image', layoutId: 'coords' }
/**
 * An IMAGE cell in a workspace whose source resolves NO raster.
 *
 * The first version of this control used a `kind: 'scatter'` cell, which exits the warning effect
 * at its FIRST guard (`kind !== 'image'`) and never reaches the `hasRaster` check it claimed to
 * exercise — a blind audit confirmed by mutation that deleting `if (!hasRaster) continue` left the
 * whole suite green. An IMAGE cell in a rasterless workspace is the state that actually reaches
 * it, and it is the ordinary project: an image pane offered on a dataset with no picture.
 */
const NO_RASTER_CELL: GridCell = { id: 'pane-2', kind: 'image', layoutId: 'coords' }
const RECTS: readonly PaneRect[] = [{ id: 'pane-1', x: 0, y: 0, width: 600, height: 400 }]

/**
 * A level whose axes are INTERLEAVED RGB — `['c','y','x','_c']`.
 *
 * Not decoration: a positional read of this shape takes `shape[len-1]` = 3 (the sample count) as
 * the width and frames a 1400x1800 image as 3x1800 — half off the edge of its own pane, with a
 * clean console. That is #159's measured defect, and this file edits the very effect it was fixed
 * in, so it is re-pinned here rather than assumed still fixed.
 */
const INTERLEAVED_LEVEL = {
  shape: [1, FULL_H, FULL_W, 3],
  labels: ['c', 'y', 'x', '_c'],
  dtype: 'Uint8',
  tileSize: 512,
  getRaster: async () => ({ data: new Uint8Array(0), width: 0, height: 0 }),
  getTile: async () => ({ data: new Uint8Array(0), width: 0, height: 0 }),
  onTileError: () => {},
}

const reject = (what: string) => () => Promise.reject(new Error(`${what} not used here`))
const baseSource = {
  catalog: reject('catalog'),
  positions: reject('positions'),
  valueColumn: reject('valueColumn'),
  categorical: reject('categorical'),
  continuous: reject('continuous'),
  table: reject('table'),
  graph: reject('graph'),
}

/** A source that serves the TILED pyramid — the path a real emitted OME-TIFF takes. */
function sourceWithPyramid(): DataSource {
  return {
    ...baseSource,
    imageUnderlay: reject('imageUnderlay'),
    imagePixelSource: async () => [INTERLEAVED_LEVEL],
  } as unknown as DataSource
}

/**
 * A source with NO pyramid seam and a single-texture underlay — the SERVED-LEVEL path.
 *
 * Its extent is the COARSEST level (350x450 on the real fixture), which is a different grid at a
 * different scale from the tiled path's level 0 (1400x1800), so the two must be framed by
 * DIFFERENT affines. A blind audit's mutation — always use `frame.imageToSpace` — survived the
 * whole suite because nothing ever took this branch.
 */
function sourceWithUnderlayOnly(): DataSource {
  return {
    ...baseSource,
    imageUnderlay: async () => ({
      data: new Uint8Array(LEVEL_W * LEVEL_H * 4),
      width: LEVEL_W,
      height: LEVEL_H,
      channels: 4 as const,
      affine: [0.05, 0, 0, 0, 0.05, 0] as const,
    }),
  } as unknown as DataSource
}

/** A source that resolves NO raster at all — the ordinary project with an image pane offered. */
function sourceWithNoRaster(): DataSource {
  return { ...baseSource, imageUnderlay: reject('imageUnderlay') } as unknown as DataSource
}

function mount(
  frame: PaneFrame,
  cells: readonly GridCell[] = [CELL],
  source: DataSource = sourceWithPyramid(),
  rects: readonly PaneRect[] = RECTS,
) {
  const seeds: { cellId: string; viewState: GridViewState }[] = []
  function Probe() {
    const datasetEntriesRef = useRef<Record<string, { source: DataSource | null }>>({})
    const localStatesRef = useRef<Record<string, GridViewState>>({})
    // IDEMPOTENT, exactly as the real writer is: `GridDeckLayer.seedViewState` applies a seed
    // only where the cell has no camera yet (`prev[cellId] ? prev : {...}`). A stub that recorded
    // every call would count the effect's re-runs — an artifact of the harness — instead of the
    // seeds the product actually performs, and it is the "only if absent" rule that makes the
    // catalog race in TEST-25 permanent rather than self-correcting.
    const seedViewStateRef = useRef((cellId: string, viewState: GridViewState) => {
      if (localStatesRef.current[cellId]) return
      localStatesRef.current[cellId] = viewState
      seeds.push({ cellId, viewState })
    })
    useGridRaster({
      cells,
      source,
      datasetEntriesRef,
      rects,
      insetPane: (r: PaneRect) => r,
      localStatesRef,
      seedViewStateRef,
      cellFrame: () => frame,
    })
    return null
  }
  const view = render(<Probe />)
  return { seeds, rerender: () => view.rerender(<Probe />) }
}

const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise(resolve => setTimeout(resolve, 5))
}

const BOUND: PaneFrame = {
  catalogResolved: true,
  imageSpace: SPACE,
  layoutSpace: SPACE,
  imageToSpace: TO_SPACE,
  imageMatrix: [5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  layoutToSpace: [1, 0, 0, 0, 1, 0],
  binding: { bound: true, space: SPACE },
}

afterEach(cleanup)

// ── TEST-9 ────────────────────────────────────────────────────────────────────────────────────

describe('TEST-9 the camera is seeded in the COORDINATE SPACE, not in image pixels', () => {
  it('frames the placed extent — and the pre-#228 pixel values are asserted ABSENT', async () => {
    const { seeds } = mount(BOUND)
    await settle()

    expect(seeds).toHaveLength(1)
    const { target, zoom } = seeds[0].viewState

    // Written literally from the producer's declaration, not read back from the module:
    // 1400 x 5 = 7000 wide and 1800 x 5 = 9000 tall, so the centre is (3500, 4500) and the pane's
    // shorter side (400 px) must fit the longer space side (9000).
    expect(target).toEqual([3500, 4500, 0])
    expect(zoom).toBeCloseTo(Math.log2(400 / 9000), 12)

    // THE REVERT CONTROL. These are exactly what this effect produced before #228 — the image's
    // own pixel grid. Nothing else in the suite would notice a silent return to them, because
    // nothing else asserts the framing numbers at all (which is how #159's sample-count framing
    // survived with a clean console).
    expect(target).not.toEqual([FULL_W / 2, FULL_H / 2, 0])
    expect(zoom).not.toBeCloseTo(Math.log2(400 / FULL_H), 6)
  })

  it('reads the level extent BY AXIS LABEL — an interleaved RGB level is 1400 wide, never 3', async () => {
    const { seeds } = mount(BOUND)
    await settle()
    // If the width were taken positionally it would be 3 (the `_c` sample count), the extent would
    // be 15 x 9000 in space, and the zoom would fit 9000 all the same — so the ZOOM alone cannot
    // catch this. The TARGET can: 15/2 = 7.5, not 3500.
    expect(seeds[0].viewState.target[0]).toBe(3500)
    expect(seeds[0].viewState.target[0]).not.toBe(7.5)
  })

  it('an UNPLACED raster keeps the identity extent it always had', async () => {
    // A raster that declares nothing is not a defect; it renders at array-index units, and the
    // camera must frame THAT rather than a fabricated placement.
    const { seeds } = mount({ catalogResolved: true, binding: { bound: false, reason: 'no declaration' } })
    await settle()
    expect(seeds[0].viewState.target).toEqual([FULL_W / 2, FULL_H / 2, 0])
    expect(seeds[0].viewState.zoom).toBeCloseTo(Math.log2(400 / FULL_H), 12)
  })

  it('a raster whose declared placement is REFUSED seeds no camera at all', async () => {
    // The emit site draws nothing for such a cell, so a seeded camera would be a camera onto an
    // empty pane at an arbitrary zoom.
    const { seeds } = mount({
      catalogResolved: true,
      placementError: 'a placement of 4 value(s)',
      binding: { bound: false, reason: 'refused' },
    })
    await settle()
    expect(seeds).toEqual([])
  })
})

// ── TEST-14 ───────────────────────────────────────────────────────────────────────────────────

describe('TEST-14 a refused binding is said out loud, once', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('names BOTH declared spaces and the cell, exactly once across re-renders', async () => {
    const refused: PaneFrame = {
      catalogResolved: true,
      imageSpace: 'visium:sectionA',
      layoutSpace: 'visium:sectionB',
      imageToSpace: TO_SPACE,
      binding: {
        bound: false,
        reason:
          'the raster is in coordinate_space "visium:sectionA" and the layout is in "visium:sectionB".',
      },
    }
    const { rerender } = mount(refused)
    await settle()

    const calls = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('draws NO point overlay'))
    expect(calls).toHaveLength(1)
    expect(String(calls[0][0])).toContain('pane-1')
    expect(String(calls[0][0])).toContain('visium:sectionA')
    expect(String(calls[0][0])).toContain('visium:sectionB')

    // The layers memo re-runs on every camera move. A warning that repeats per frame is a console
    // a user learns to scroll past, which is the same as not having said it.
    rerender()
    rerender()
    await settle()
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('draws NO point overlay'))).toHaveLength(1)
  })

  it('says NOTHING for a bound cell, and NOTHING for a cell that has no raster at all', async () => {
    mount(BOUND)
    await settle()
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('draws NO point overlay'))).toHaveLength(0)
    cleanup()

    // An image cell with no image has nothing to overlay and nothing to explain. Warning here
    // would put a line in the console of every ordinary project.
    mount(
      { catalogResolved: true, binding: { bound: false, reason: 'x' } },
      [NO_RASTER_CELL],
      sourceWithNoRaster(),
    )
    await settle()
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('draws NO point overlay'))).toHaveLength(0)
  })
})

// ── TEST-21 — the SINGLE-TEXTURE framing branch, which nothing took ──────────────────────────

describe('TEST-21 the fallback path is framed by ITS OWN affine, not the pyramid`s', () => {
  it('frames the SERVED level through `levelToSpace` — a 4x difference from the tiled path', async () => {
    // ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
    // A blind audit replaced `usePyramidExtent ? frame.imageToSpace : frame.levelToSpace` with an
    // unconditional `frame.imageToSpace` and ALL 45 tests stayed green: every case resolved a
    // pyramid, so the fallback branch was never taken. The source comment calls confusing the two
    // affines "a 4x mis-frame", and nothing would have caught it.
    //
    // The two affines describe ONE picture: the tiled path places 1400x1800 level-0 pixels by
    // `to_space = 5`, the fallback places 350x450 coarsest-level pixels by `levelToSpace = 20`.
    // Both land on 7000x9000 — which is the point, and is what makes the WRONG pairing (350x450
    // through 5) land on 1750x2250 instead.
    const { seeds } = mount(
      {
        catalogResolved: true,
        imageSpace: SPACE,
        layoutSpace: SPACE,
        imageToSpace: TO_SPACE,
        levelToSpace: [20, 0, 0, 0, 20, 0],
        imageMatrix: [5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        levelMatrix: [20, 0, 0, 0, 0, 20, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        layoutToSpace: [1, 0, 0, 0, 1, 0],
        binding: { bound: true, space: SPACE },
      },
      [CELL],
      sourceWithUnderlayOnly(),
    )
    await settle()

    expect(seeds).toHaveLength(1)
    // 350 x 20 = 7000 and 450 x 20 = 9000 — the SAME space box the tiled path frames, reached
    // from a different grid through a different affine.
    expect(seeds[0].viewState.target).toEqual([3500, 4500, 0])
    expect(seeds[0].viewState.zoom).toBeCloseTo(Math.log2(400 / 9000), 12)
    // The wrong pairing — this level's grid through the FULL-RESOLUTION affine — would centre at
    // (875, 1125). Named so a silent collapse of the two branches is caught rather than uncovered.
    expect(seeds[0].viewState.target).not.toEqual([875, 1125, 0])
  })
})

// ── TEST-25 — the camera-seed RACE, which nothing observed ───────────────────────────────────

describe('TEST-25 no camera is seeded on a frame that has not been read', () => {
  it('an UNRESOLVED catalog seeds nothing, even with the raster fully resolved', async () => {
    // ── THE DEFECT ─────────────────────────────────────────────────────────────────────────
    // The seed is IDEMPOTENT-ONCE and the two inputs are INDEPENDENT async effects: the raster
    // fetch keys on `[imageCellsKey, source]` and never waits for the catalog. So on any ordering
    // where the raster lands first, seeding on the not-yet-known frame fixes the pane in the
    // raster's own PIXEL units — 1400x1800 — while the placed contents arrive a moment later in a
    // 7000x9000 space, and the "only if absent" rule makes that permanent. Nothing here controls
    // the ordering, which is what makes a passing run meaningless as evidence.
    //
    // Removing the `catalogResolved` guard SURVIVED the whole suite before this case existed.
    const { seeds } = mount({
      catalogResolved: false,
      binding: { bound: false, reason: 'the catalog has not been read' },
    })
    await settle()
    expect(seeds, 'nothing is framed until the frame is known').toEqual([])
  })

  it('…and once it IS read, the same pane frames the PLACED extent', async () => {
    // The other half, so the guard cannot be satisfied by never seeding at all.
    const { seeds } = mount(BOUND)
    await settle()
    expect(seeds).toHaveLength(1)
    expect(seeds[0].viewState.target).toEqual([3500, 4500, 0])
  })
})

// ── TEST-26 — a CALLER-SUPPLIED loader is the same path for the camera and the layers ────────

describe('TEST-26 `cell.loader` picks the tiled path for BOTH the emit and the camera', () => {
  it('frames level 0 through the full-resolution affine when the loader came from the cell', async () => {
    // The framing predicate and the emit's path choice used to be written separately
    // (`Boolean(imagePyramids[id])` vs `cell.loader ?? entry?.loader`) and disagreed for exactly
    // this input: the raster drawn on the tiled path and placed by `to_space`, while the camera
    // fell through to the served level's affine — or, with no level affine, to no camera at all.
    // Both now go through `effectiveLoaderFor`. Ignoring `cell.loader` there SURVIVED the suite
    // before this case existed.
    const cellWithLoader: GridCell = {
      id: 'pane-1',
      kind: 'image',
      layoutId: 'coords',
      loader: [INTERLEAVED_LEVEL] as never,
    }
    // The source resolves NO raster of its own, so the CALLER's loader is the only thing that can
    // supply an extent. Ignoring `cell.loader` therefore produces no camera at all rather than a
    // subtly different one — the sharpest available discriminator, and the honest worst case the
    // predicate mismatch actually caused.
    const { seeds } = mount(BOUND, [cellWithLoader], sourceWithNoRaster())
    await settle()

    expect(seeds, 'the caller`s loader is a raster, and a raster gets framed').toHaveLength(1)
    // 1400 x 5 and 1800 x 5 — level 0 through the FULL-RESOLUTION affine, because that is the
    // grid the caller's loader serves.
    expect(seeds[0].viewState.target).toEqual([3500, 4500, 0])
    expect(seeds[0].viewState.zoom).toBeCloseTo(Math.log2(400 / 9000), 12)
  })
})

// ── TEST-31 — an UNMEASURED pane seeds no camera at all ──────────────────────────────────────

describe('TEST-31 `frameExtent` returning null actually stops the seed', () => {
  it('a pane with no measured area is left where it is', async () => {
    // `frameExtent`'s `null` is pinned in isolation by TEST-7, and the GUARD it exists to enable
    // was not: replacing `continue` with a seeded `{target:[0,0,0], zoom:0}` SURVIVED the suite.
    // A zero-width rect is the real occurrence — a pane measured before layout settles — and
    // seeding it would put the camera at the space's origin at zoom 0, which the idempotent-once
    // rule then makes permanent.
    const { seeds } = mount(BOUND, [CELL], sourceWithPyramid(), [
      { id: CELL.id, x: 0, y: 0, width: 0, height: 0 },
    ])
    await settle()
    expect(seeds).toEqual([])
  })
})

// ── TEST-35 — the refusals that were MUTE, and the terminal arm ─────────────────────────────

describe('TEST-35 every refused pane explains itself, and none of them lies', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })
  const said = () => warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('NO point overlay'))

  it('a pane that resolved NO RASTER but whose spaces AGREE still says why', async () => {
    // The emit refuses this (nothing to overlay onto) while `binding.bound` is true, and the
    // reporter used to short-circuit on `binding.bound` — leaving a pane with neither picture nor
    // points and no explanation at all. That is the exact outcome this reporter exists to
    // prevent, and it was reachable the moment the placement errors were split per path.
    mount(
      {
        ...BOUND,
        levelMatrix: undefined,
        levelToSpace: undefined,
        levelPlacementError: 'the served-level affine is singular',
      },
      [CELL],
      sourceWithUnderlayOnly(),
    )
    await settle()
    expect(said()).toHaveLength(1)
    expect(String(said()[0][0])).toContain('singular')
  })

  it('says NOTHING while the raster is still FETCHING', async () => {
    // A pane mid-fetch has nothing to explain, and a reporter that fabricated a reason during
    // `'loading'` would put a line in the console of every ordinary project on every open.
    mount(
      { catalogResolved: false, binding: { bound: false, reason: 'not read yet' } },
      [CELL],
      sourceWithNoRaster(),
    )
    expect(said()).toHaveLength(0)
  })
})

// ── TEST-39 — the framing guard for a fallback path with no usable placement ─────────────────

describe('TEST-39 an un-drawable fallback raster gets no camera', () => {
  it('does not seed a pixel-unit camera onto a pane that will draw nothing', () => {
    // The EMIT half of this pair is pinned by TEST-34 (no picture ⇒ no overlay). The CAMERA half
    // was not, and it is the pair that has to agree: without the guard the effect falls through
    // to the identity-pixel-extent branch and seeds a camera in PIXELS onto an empty pane, which
    // the idempotent-once rule then makes permanent. That is the split-frame state
    // `catalogResolved` exists to prevent, reached by a second route.
    return (async () => {
      const { seeds } = mount(
        {
          ...BOUND,
          levelMatrix: undefined,
          levelToSpace: undefined,
          levelPlacementError: 'the served-level affine is singular',
        },
        [CELL],
        sourceWithUnderlayOnly(),
      )
      await settle()
      expect(seeds).toEqual([])
    })()
  })
})
