// @vitest-environment jsdom
//
// imageOverlayEmit.test.tsx — #228 TEST-13, on the REAL hook that hands layers to `<DeckGL>`.
//
// ── WHY THIS MOUNTS THE WHOLE MEMO ────────────────────────────────────────────────────────────
//
// `buildImagePaneLayers` (unit-tested next door) decides WHETHER the points ride the raster. It
// cannot show that they actually DO: the emit is a fall-through — the image branch stops
// `continue`ing and the loop carries on into the ordinary dense-scatter path — and a fall-through
// is precisely the kind of wiring a pure test of the decision function cannot reach. FB-17's rule
// is the one that applies: "exists and is unit-tested" is not "is on the runtime path".
//
// So this drives `useGridDeckInputs` itself and reads the layer list it produces.
//
// ── AND WHY IT ASSERTS AN ARRAY *IDENTITY* ────────────────────────────────────────────────────
//
// The mutation this whole item is held to is #156's: ignore the mapping and draw on an arbitrary
// lattice. On the points side that means the emitted positions are not the layout's. Asserting
// the emitted attribute is the SAME `Float32Array` REFERENCE the layout supplied catches that
// exactly, and it catches the other half too: a CPU `transformPositions` pass — the O(2N) copy
// DEC-26 retired in favour of the GPU matrix — would produce an equal-looking but different array.

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Matrix4 } from '@math.gl/core'
import { useGridDeckInputs } from './useGridDeckInputs'
import type { GridCell, CellRenderData, PyramidEntry } from './gridModel'
import type { PaneRect } from '../layers/multiView'
import type { PaneFrame } from '../spatial/coordinateBinding'
import { DEFAULT_SELECTION_SPACE } from '../../adapter/Coordination.store'

const SPACE = 'visium:Visium_Mouse_Olfactory_Bulb'
const TO_SPACE = [5, 0, 0, 0, 5, 0] as const
/** column-major 4x4 for `[5,0,0,0,5,0]` — the value `affineToModelMatrix` produces. */
const MATRIX = [5, 0, 0, 0, 0, 5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const CELL: GridCell = { id: 'pane-1', kind: 'image', layoutId: 'coords' }
const RECT: PaneRect = { id: 'pane-1', x: 0, y: 0, width: 600, height: 400 }

/** Two real vendor spot positions, in the coordinate space (full-resolution pixels). */
const POSITIONS = new Float32Array([3955, 4191, 3954, 4078])

const RENDER_DATA: CellRenderData = {
  positions: POSITIONS,
  colors: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]),
  colorEpoch: 1,
  pointIds: null,
  nPoints: 2,
  status: 'ready',
}

const PYRAMID: PyramidEntry = {
  loader: [
    {
      shape: [1, 1800, 1400, 3],
      labels: ['c', 'y', 'x', '_c'],
      dtype: 'Uint8',
      tileSize: 512,
      getRaster: async () => ({ data: new Uint8Array(0), width: 0, height: 0 }),
      getTile: async () => ({ data: new Uint8Array(0), width: 0, height: 0 }),
      onTileError: () => {},
    },
  ],
  channels: [
    { name: 'r', color: [255, 0, 0], contrastLimits: [0, 255], visible: true },
  ],
  contrastMax: 255,
} as unknown as PyramidEntry

/** Everything `useGridDeckInputs` needs that this file does not vary. */
const BASE_ARGS = {
  denseRects: [RECT],
  chartDeckRects: [] as PaneRect[],
  plotInset: (x: PaneRect) => x,
  cells: [CELL],
  denseCells: [CELL],
  denseIds: new Set([CELL.id]),
  cellMap: { [CELL.id]: CELL },
  cellData: () => RENDER_DATA,
  cellSelectionSpace: () => DEFAULT_SELECTION_SPACE,
  radius: 3,
  positions: POSITIONS,
  codes: undefined,
  graph: undefined,
  categories: undefined,
  graphColorByOrder: false,
  graphColormap: 'viridis' as never,
  perCellColors: {},
  perCellLegend: {},
  perCellGroupLegend: {},
  perCellRange: {},
  colorOverrides: {} as never,
  linkedHiddenFor: () => undefined,
  linkColumnFilterFor: () => null,
  pointSelection: null,
  selectionBySpace: {},
  idToRowFor: () => new Map() as never,
  committedByCell: {},
  effectiveHighlight: {},
  imageUnderlays: {},
  imagePyramids: {},
  chartContribs: new Map(),
  maskReview: {},
  maskEpoch: 0,
  resolvedLabelMask: () => null,
  sharedSessionForCell: () => null,
  applyMaskPick: () => {},
} as unknown as Parameters<typeof useGridDeckInputs>[0]

function emit(
  frame: PaneFrame,
  raster: { pyramid?: PyramidEntry; underlay?: { texture: unknown; width: number; height: number } } = {
    pyramid: PYRAMID,
  },
): unknown[] {
  const holder: { layers?: readonly unknown[] } = {}
  function Probe() {
    const r = useGridDeckInputs({
      ...BASE_ARGS,
      imageUnderlays: raster.underlay ? { [CELL.id]: raster.underlay as never } : {},
      imagePyramids: raster.pyramid ? { [CELL.id]: raster.pyramid } : {},
      cellFrame: () => frame,
    })
    holder.layers = r.deckLayersBefore
    return null
  }
  render(<Probe />)
  return [...(holder.layers ?? [])]
}

/** the SERVED level's placement — 20x, the coarsest level of the real fixture. */
const LEVEL_MATRIX = [20, 0, 0, 0, 0, 20, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

const BOUND: PaneFrame = {
  catalogResolved: true,
  imageSpace: SPACE,
  layoutSpace: SPACE,
  imageToSpace: TO_SPACE,
  imageMatrix: MATRIX,
  levelMatrix: LEVEL_MATRIX,
  layoutToSpace: [1, 0, 0, 0, 1, 0],
  binding: { bound: true, space: SPACE },
}
const UNBOUND: PaneFrame = {
  catalogResolved: true,
  imageSpace: SPACE,
  imageToSpace: TO_SPACE,
  imageMatrix: MATRIX,
  levelMatrix: LEVEL_MATRIX,
  binding: { bound: false, reason: 'the layout declares none' },
}

const idsOf = (layers: unknown[]) => layers.map(l => (l as { id: string }).id)

afterEach(cleanup)

describe('TEST-13 the overlay is on the runtime path, and the points are not copied', () => {
  it('a BOUND image cell emits BOTH the raster layer and this cell`s scatter layer', () => {
    const bound = idsOf(emit(BOUND))
    const unbound = idsOf(emit(UNBOUND))

    // The raster is drawn either way — a refused binding withdraws the POINTS, never the picture.
    expect(bound).toContain('pane-1::image')
    expect(unbound).toContain('pane-1::image')
    // The overlay is the difference, and it is the ordinary dense-scatter layer id, because it is
    // the ordinary dense-scatter path.
    expect(bound).toContain('pane-1::scatter')
    expect(unbound).not.toContain('pane-1::scatter')
  })

  it('the raster carries the DECLARED placement as its modelMatrix', () => {
    const layer = emit(BOUND).find(l => (l as { id: string }).id === 'pane-1::image') as {
      props: { modelMatrix?: Matrix4 | number[] }
    }
    const raw = layer.props.modelMatrix
    const m = Array.isArray(raw) ? raw : ((raw as Matrix4 | undefined)?.toArray?.() ?? [])
    // element-by-element, so a matrix that is merely "some 4x4" cannot pass
    expect(Array.from(m)).toEqual(MATRIX)
  })

  it('the emitted positions are the layout`s OWN buffer — same reference, no CPU transform', () => {
    const layer = emit(BOUND).find(l => (l as { id: string }).id === 'pane-1::scatter') as {
      props: { data: { length: number; attributes: { getPosition: { value: Float32Array; size: number } } } }
    }
    // IDENTITY, not equality. An arbitrary lattice is a different array; so is a
    // `transformPositions` copy, even one that happened to hold the same numbers. `toBe` on a
    // typed array is reference equality in vitest, which is exactly the question.
    expect(layer.props.data.attributes.getPosition.value).toBe(POSITIONS)
    expect(layer.props.data.attributes.getPosition.size).toBe(2)
    expect(layer.props.data.length).toBe(2)
    // …and the values really are the vendor's, so the reference check is not over an empty array.
    expect(Array.from(POSITIONS)).toEqual([3955, 4191, 3954, 4078])
  })

  it('an image cell whose placement is REFUSED emits nothing at all for that cell', () => {
    const layers = idsOf(
      emit({
        catalogResolved: true,
        imageSpace: SPACE,
        placementError: 'a placement of 4 value(s)',
        binding: { bound: false, reason: 'refused' },
      }),
    )
    expect(layers).not.toContain('pane-1::image')
    expect(layers).not.toContain('pane-1::scatter')
  })
})

// ── TEST-22 — the SINGLE-TEXTURE branch, which no test took ──────────────────────────────────

describe('TEST-22 the fallback BitmapLayer is placed too', () => {
  const UNDERLAY = { texture: {} as never, width: 350, height: 450 }

  it('carries `frame.levelMatrix` — the value whose absence draws the fixture 20x too small', () => {
    // ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
    // A blind audit forced `modelMatrix = null` on this branch and ALL 45 tests stayed green: every
    // case passed `underlay: undefined` or `imageUnderlays: {}`, so the branch was never emitted.
    // `levelPlacementMatrix` was asserted in isolation and nothing pinned that the LAYER got it.
    //
    // The uncovered regression is the one the source names by value: once the camera is in the
    // coordinate space, a `BitmapLayer` left at its raw pixel bounds draws the committed Visium
    // fixture 20x too small in the corner of its own pane. And this is the path the declarative
    // `image` widget and the showcase story take, i.e. the path the screenshots come from.
    const layers = emit(BOUND, { underlay: UNDERLAY })
    const layer = layers.find(l => (l as { id: string }).id === 'pane-1::image') as {
      props: { modelMatrix?: Matrix4 | number[]; bounds: number[] }
    }
    expect(layer, 'the fallback emits its BitmapLayer').toBeDefined()
    const raw = layer.props.modelMatrix
    const m = Array.isArray(raw) ? raw : ((raw as Matrix4 | undefined)?.toArray?.() ?? [])
    expect(Array.from(m)).toEqual(LEVEL_MATRIX)
    // …at the level's own raw pixel bounds, which is what the matrix is placing.
    expect(layer.props.bounds).toEqual([0, 0, 350, 450])
    // and the overlay still rides on top
    expect(layers.map(l => (l as { id: string }).id)).toContain('pane-1::scatter')
  })

  it('emits NOTHING when the served-level affine cannot be inverted', () => {
    // The fallback has no usable placement; drawing it unplaced under a space-framed camera is
    // the same error as drawing it at identity, with extra steps. The TILED path is unaffected —
    // `coordinateBinding.test.ts` TEST-20 pins that half.
    const layers = emit(
      { ...BOUND, levelMatrix: undefined, levelPlacementError: 'singular affine' },
      { underlay: UNDERLAY },
    )
    expect(layers.map(l => (l as { id: string }).id)).not.toContain('pane-1::image')
  })
})

// ── TEST-23 — the POINTS are never moved, by ANY cell ────────────────────────────────────────

describe('TEST-23 no dense cell`s scatter layer carries a placement', () => {
  it('a BOUND image cell emits its points with NO modelMatrix — they are already in the space', () => {
    // The frame decision, at the layer: the RASTER moves and the points do not (DEC-17). An
    // earlier cut put the layout's placement here as a matrix, which moved the marks and left the
    // lasso mask, the hover ring, the provenance replay, the cross-pane tooltip and the vector
    // export all reading the raw buffer — five separate modules, found across three audit rounds.
    // A non-identity layout placement is REFUSED by the binding instead (TEST-28).
    const scatter = emit(BOUND).find(l => (l as { id: string }).id === 'pane-1::scatter') as {
      props: { modelMatrix?: unknown }
    }
    expect(scatter).toBeDefined()
    // deck's own default for an unspecified `modelMatrix` is `null`.
    expect(scatter.props.modelMatrix).toBeNull()
  })

  it('and neither does an ordinary scatter pane — byte-identical to before #228', () => {
    const holder: { layers?: readonly unknown[] } = {}
    function Probe() {
      const scatterCell: GridCell = { id: 'pane-1', kind: 'scatter', layoutId: 'coords' }
      const r = useGridDeckInputs({
        ...BASE_ARGS,
        cells: [scatterCell],
        denseCells: [scatterCell],
        cellMap: { 'pane-1': scatterCell },
        cellFrame: () => BOUND,
      })
      holder.layers = r.deckLayersBefore
      return null
    }
    render(<Probe />)
    const scatter = (holder.layers ?? []).find(l => (l as { id: string }).id === 'pane-1::scatter') as {
      props: { modelMatrix?: unknown }
    }
    expect(scatter).toBeDefined()
    expect(scatter.props.modelMatrix).toBeNull()
  })
})

// ── TEST-33 — everything that reads the RAW buffer agrees, because nothing transforms it ─────

describe('TEST-33 the hover ring carries no placement either', () => {
  it('rings the mark where the mark is, on a bound image pane and on a scatter pane alike', () => {
    // The ring reads `cd.positions[idx*2]` — the RAW buffer — and the marks it rings come from
    // that same buffer untouched, so the two agree BY CONSTRUCTION rather than by two matrices
    // being kept in step. That is the whole reason a non-identity layout placement is refused
    // instead of applied (DEC-17): five modules read this buffer and each projects it itself.
    for (const cell of [
      CELL,
      { id: 'pane-1', kind: 'scatter', layoutId: 'coords' } as GridCell,
    ]) {
      const holder: { layers?: readonly unknown[] } = {}
      function Probe() {
        const r = useGridDeckInputs({
          ...BASE_ARGS,
          cells: [cell],
          denseCells: [cell],
          cellMap: { 'pane-1': cell },
          imagePyramids: { [CELL.id]: PYRAMID },
          effectiveHighlight: { 'pane-1': 0 },
          cellFrame: () => BOUND,
        })
        holder.layers = r.deckLayersBefore
        return null
      }
      render(<Probe />)
      const ring = (holder.layers ?? []).find(
        l => (l as { id: string }).id === 'pane-1::hover-highlight',
      ) as { props: { modelMatrix?: unknown; data: { position: [number, number] }[] } }
      expect(ring, `the ring is emitted for a ${cell.kind} pane`).toBeDefined()
      expect(ring.props.modelMatrix).toBeNull()
      // …at the RAW coordinate of row 0, which is where its mark is drawn.
      expect(ring.props.data[0].position).toEqual([POSITIONS[0], POSITIONS[1]])
      cleanup()
    }
  })
})

// ── TEST-34 — a pane with no PICTURE has nothing to overlay onto ─────────────────────────────

describe('TEST-34 no raster ⇒ no overlay, even when the two spaces agree', () => {
  it('a bound frame whose served-level affine is un-invertible draws nothing at all', () => {
    // Reachable only since the placement errors were split per path: the BitmapLayer is dropped
    // for a fault in ITS number while `binding.bound` — which is about the two declared SPACES —
    // still says yes. Points alone under a space-framed camera are not a smaller version of the
    // overlay; they are a dot cloud floating over nothing. Removing the guard SURVIVED the suite.
    const layers = emit(
      { ...BOUND, levelMatrix: undefined, levelPlacementError: 'singular affine' },
      { underlay: { texture: {} as never, width: 350, height: 450 } },
    )
    expect(layers.map(l => (l as { id: string }).id)).toEqual([])
  })

  it('…and a bound frame with a real raster still draws both', () => {
    // The control, so the guard cannot be satisfied by never drawing anything.
    const layers = emit(BOUND, { underlay: { texture: {} as never, width: 350, height: 450 } })
    expect(layers.map(l => (l as { id: string }).id)).toEqual(['pane-1::image', 'pane-1::scatter'])
  })
})

// ── TEST-27 — the memo actually RE-RUNS when the frame changes ───────────────────────────────
//
// RESTORED. Written in round 2, deleted by accident in round 3's rewrite of TEST-23/TEST-33 (an
// index splice took everything between two anchors, and this sat between them), and a round-4
// audit measured the consequence: dropping `cellFrame` from the memo's deps went from RED to
// surviving the whole package. The dependency it pins was never touched.

describe('TEST-27 a frame that arrives late still reaches the layers', () => {
  it('re-emits when `cellFrame` changes — the dependency, not the ordering, is what guarantees it', () => {
    // `cellFrame` closes over the CATALOG, which arrives on its own schedule and is not a
    // dependency of `cellData` or of either raster cache. Left out of the memo's dep array the
    // layers hold a stale frame, and whether the overlay ever appears depends on some unrelated
    // dep happening to change afterwards. It does today; that is luck, not correctness.
    let frame: PaneFrame = {
      catalogResolved: false,
      binding: { bound: false, reason: 'the catalog has not been read' },
    }
    const holder: { layers?: readonly unknown[] } = {}
    // A module-STABLE pyramid map. A fresh literal per render would give the memo a changed
    // dependency of its own and re-run it for a reason that has nothing to do with the frame —
    // which is exactly how the first version of this case let the missing dependency survive.
    const pyramids = { [CELL.id]: PYRAMID }
    function Probe() {
      const r = useGridDeckInputs({ ...BASE_ARGS, imagePyramids: pyramids, cellFrame: () => frame })
      holder.layers = r.deckLayersBefore
      return null
    }
    const view = render(<Probe />)
    const before = (holder.layers ?? []).map(l => (l as { id: string }).id)
    expect(before).not.toContain('pane-1::scatter')

    // The catalog lands. NOTHING ELSE about the inputs changes — same cells, same buffers, same
    // raster caches — so only the frame dependency can carry this through.
    frame = BOUND
    view.rerender(<Probe />)
    const after = (holder.layers ?? []).map(l => (l as { id: string }).id)
    expect(after, 'the overlay appears once the frame is known').toContain('pane-1::scatter')
    const raster = (holder.layers ?? []).find(l => (l as { id: string }).id === 'pane-1::image') as {
      props: { modelMatrix?: Matrix4 | number[] }
    }
    const raw = raster.props.modelMatrix
    const m = Array.isArray(raw) ? raw : ((raw as Matrix4 | undefined)?.toArray?.() ?? [])
    expect(Array.from(m), 'and the raster is placed by it').toEqual(MATRIX)
  })
})
