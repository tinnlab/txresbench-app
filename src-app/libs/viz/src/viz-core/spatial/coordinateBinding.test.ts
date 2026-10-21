// coordinateBinding.test.ts — #228 TEST-1/2/3/5/7/8.
//
// ── THE BAR THESE ARE WRITTEN TO ──────────────────────────────────────────────────────────────
//
// #156's TEST-9 is the model: *a deliberately wrong affine passed every check that system had*,
// and the blind auditor's mutation — ignore the mapping, draw circles on an arbitrary lattice —
// left all 38 tests green, because the acceptance test was sensitive to the circle RADIUS rather
// than the spot POSITION.
//
// So: nothing here asserts a radius, a colour, a layer count on its own, or that a function
// returned. Every placement assertion names WHERE a point lands, and the expected coordinate is
// written literally in this file from the PRODUCER's own committed declaration
// (`fixtures/emitted-manifest-entries.json`) rather than read back out of the thing under test.
// The point-mapping helper below is four lines of arithmetic written here on purpose: reusing the
// module's own transform would make every assertion a tautology.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  asPlacementAffine,
  frameExtent,
  imageExtentInSpace,
  imagePlacementMatrix,
  levelPlacementMatrix,
  resolvePaneFrame,
  resolveOverlayBinding,
  isIdentityAffine,
  overlayRefusal,
} from './coordinateBinding'
import { underlayAffine, OmeTiffPlacementError } from './omeTiffUnderlay'
import { buildImagePaneLayers } from '../grid/useGridDeckInputs'
import type { GridCell } from '../grid/gridModel'
import type { Affine } from '../data/image'

// ── the producer's own declaration, read rather than retyped ───────────────────────────────────

const FIXTURES = path.resolve(process.cwd(), 'src/viz-core/spatial/fixtures')
const ENTRIES = JSON.parse(
  readFileSync(path.join(FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as { id: string; meta: Record<string, unknown> }[]

const entry = (id: string): Record<string, unknown> => {
  const found = ENTRIES.find(e => e.id === id)
  if (!found) throw new Error(`fixture has no entry "${id}"`)
  return found.meta
}

const HIRES = entry('spatial-image-hires')
const LOWRES = entry('spatial-image-lowres')

/** The space both committed images declare — one run's slide id. */
const SPACE = 'visium:Visium_Mouse_Olfactory_Bulb'

/**
 * THE ORACLE, and it is four lines on purpose.
 *
 * A deck `modelMatrix` is a COLUMN-MAJOR 4x4; the x' of a 2-D point is `m[0]*x + m[4]*y + m[12]`
 * and the y' is `m[1]*x + m[5]*y + m[13]`. Written out here rather than imported so that a change
 * to the module's own affine handling cannot move the expectations with it.
 */
function through(matrix: readonly number[], x: number, y: number): [number, number] {
  return [matrix[0] * x + matrix[4] * y + matrix[12], matrix[1] * x + matrix[5] * y + matrix[13]]
}

/** A minimal catalog shape for `resolvePaneFrame`. */
function catalogOf(opts: {
  imageSpace?: string
  toSpace?: readonly number[]
  affine?: Affine
  layoutSpace?: string
  layoutId?: string
  /** the LAYOUT's own `to_space` (§6.6). Defaults to identity — what both shipped importers
   *  write — so a case that is not about the points' placement does not have to state it; pass
   *  `null` to model a layout that declares a space and NO placement. */
  layoutToSpace?: readonly number[] | null
}) {
  const { imageSpace, toSpace, affine = [1, 0, 0, 0, 1, 0] as Affine, layoutSpace } = opts
  const layoutToSpace = opts.layoutToSpace === undefined ? [1, 0, 0, 0, 1, 0] : opts.layoutToSpace
  return {
    image: {
      affine: affine as readonly [number, number, number, number, number, number],
      ...(imageSpace === undefined ? {} : { space: imageSpace }),
      ...(toSpace === undefined ? {} : { toSpace }),
    },
    layouts: [
      {
        id: opts.layoutId ?? 'coords',
        ...(layoutSpace === undefined ? {} : { space: layoutSpace }),
        ...(layoutToSpace === null ? {} : { toSpace: layoutToSpace }),
      },
    ],
  }
}

const IMAGE_CELL: GridCell = { id: 'pane-1', kind: 'image', layoutId: 'coords' }

/** A one-level pyramid entry, so `buildImagePaneLayers` takes the TILED path. */
const PYRAMID = {
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
    { name: 'r', color: [255, 0, 0] as [number, number, number], contrastLimits: [0, 255] as [number, number], visible: true },
  ],
  contrastMax: 255,
} as never

/** Emit for one image cell against a catalog, through the REAL builder the grid uses. */
function emitFor(catalog: ReturnType<typeof catalogOf>) {
  return buildImagePaneLayers({
    cell: IMAGE_CELL,
    frame: resolvePaneFrame(catalog, IMAGE_CELL.layoutId),
    pyramid: PYRAMID,
    underlay: undefined,
  })
}

// ── TEST-3 [acceptance] [invariant: INV-4] ────────────────────────────────────────────────────

describe('TEST-3 [acceptance] [invariant: INV-4] `to_space` is applied in the declared direction, ALONE', () => {
  // > `"to_space": [a, b, tx, c, d, ty],   // 2x3 row-major affine: THIS artifact -> coordinate_space`
  //                                                          — design §6.6

  it('places the emitted grid where the PRODUCER said it sits, corner to corner', () => {
    const toSpace = HIRES.to_space as number[]
    const extent = HIRES.extent as { width: number; height: number }
    // The producer's own numbers, asserted as READ rather than assumed, so a fixture that drifted
    // would fail here instead of quietly moving every expectation below.
    expect(toSpace).toEqual([5.0, 0.0, 0.0, 0.0, 5.0, 0.0])
    expect(extent).toEqual({ width: 1400, height: 1800 })

    const m = imagePlacementMatrix(toSpace)
    // Written literally: 1400 x 5 = 7000, 1800 x 5 = 9000. The direction is what is under test —
    // the INVERSE placement would map (1400,1800) to (280,360), a picture 25x too small.
    expect(through(m, 0, 0)).toEqual([0, 0])
    expect(through(m, 1400, 1800)).toEqual([7000, 9000])
    expect(through(m, 1400, 0)).toEqual([7000, 0])
    expect(through(m, 0, 1800)).toEqual([0, 9000])
  })

  it('composes NO pixel size over the placement — the composed value is excluded BY VALUE', () => {
    // #258 TEST-2 [acceptance] [invariant: INV-2].
    // #158 measured this on the Visium emit of the day: the image's own micron pitch, the
    // space's `microns_per_pixel` and `to_space[0]` are three different numbers, the third being
    // exactly the ratio of the first two. Composing the pixel size over the placement draws a
    // perfectly plausible tissue image at the wrong size in the wrong place.
    //
    // NO MICRON MAGNITUDE IS TYPED IN HERE — both are read off the artifact. `5.0` IS typed in,
    // deliberately: it is `to_space[0]`, the producer declaration this test exists to hold the
    // code to, and the one number of the three #222 did not move (it is `1/tissue_hires_scalef`).
    // The magnitudes in the trailing comments are the FROZEN PRE-#222 fixture's — that fixture is
    // the Visium importer's output as of #154/#155/#176, kept byte-identical under #222's
    // fix-forward-only ruling, and it declares
    // [frozen-magnitude: microns_per_pixel] [frozen-magnitude: spatial-image-hires.original_resolution_um]
    // `original_resolution_um = 3.7356857…` and `microns_per_pixel = 0.7471371…`.
    // [producer-magnitude: microns_per_pixel] [producer-magnitude: spatial-image-hires.original_resolution_um]
    // The importer TODAY derives `4.4149…` and `0.88298…` for the same bundle, because #222
    // [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]
    // changed the numerator from the 55 µm capture footprint to the 65 µm rendered spot diameter.
    // Both pairs have ratio exactly 5.0 — `original_resolution_um`
    // is `microns_per_pixel / tissue_hires_scalef` and `to_space[0]` is `1/tissue_hires_scalef`,
    // so the scalefactor cancels — which is why this test is indifferent to which pair the
    // fixture holds.
    const physical = (HIRES.display_derivative as { original_resolution_um: number }).original_resolution_um
    const micronsPerPixel = HIRES.microns_per_pixel as number
    expect(physical / micronsPerPixel).toBeCloseTo(5.0, 9) // the ratio that makes this confusable

    const m = imagePlacementMatrix(HIRES.to_space as number[])
    const [x] = through(m, 1, 0)
    expect(x).toBe(5.0)
    // Every plausible composition, named and refused. A test that only asserted `5.0` would also
    // pass if the code multiplied and divided by the same wrong factor somewhere; these name the
    // specific wrong answers this epic has already produced once.
    // [frozen-magnitude: spatial-image-hires.composed_pitch_over_affine]
    expect(x).not.toBeCloseTo(5.0 * physical, 6) // 18.68 on this fixture — pixel size composed over the placement
    // [frozen-magnitude: spatial-image-hires.affine_over_pitch]
    expect(x).not.toBeCloseTo(5.0 / physical, 6) // 1.3384 on this fixture — composed the other way
    // [frozen-magnitude: microns_per_pixel]
    expect(x).not.toBeCloseTo(micronsPerPixel, 6) // 0.7471 on this fixture — the space's scale mistaken for the placement
    expect(x).not.toBeCloseTo(1 / 5.0, 6) // 0.2 — the vendor scalefactor, i.e. the inverse
  })


  it('REFUSES a declared placement that is not six finite numbers, rather than substituting identity', () => {
    // `compact_declaration` drops arrays longer than four, so a `to_space` read off a summary row
    // arrives MISSING rather than short. Both routes land here. Identity would render the raster
    // at array-index units with nothing anywhere saying so.
    expect(() => asPlacementAffine([5, 0, 0, 0])).toThrow(OmeTiffPlacementError)
    expect(() => asPlacementAffine([5, 0, 0, 0, 5, 0, 1])).toThrow(OmeTiffPlacementError)
    expect(() => asPlacementAffine([5, 0, 0, 0, Number.NaN, 0])).toThrow(OmeTiffPlacementError)
    expect(() => asPlacementAffine([5, 0, 0, 0, 5, 0])).not.toThrow()
  })
})

// ── TEST-1 [acceptance] [invariant: INV-2] ────────────────────────────────────────────────────

// ── #258 TEST-5 ───────────────────────────────────────────────────────────────────────────────
//
// NOT a behaviour test and not an acceptance test: it exercises no production code. It pins the
// PROVENANCE claim `fixtures/README.md` makes about the committed bytes, so that README and the
// fixtures cannot drift apart in silence — which is the failure #258 itself was. It lives in its
// own block because the `TEST-N` ids in the rest of this file belong to #228's lifecycle and
// have nothing to do with #258's.

describe('#258 TEST-5 — the committed fixtures are the PRE-#222 emit their README claims', () => {
  // `fixtures/README.md` says these files are the importer's output AS OF #154/#155/#176 —
  // frozen deliberately, not regenerated — and that the regen recipe printed there would NOT
  // reproduce them today. This is that claim, executable.
  //
  // Both numerators are shipped constants of, and are checked against,
  // [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM] [producer-magnitude: VISIUM_RENDERED_SPOT_DIAMETER_UM]
  // `src-app/packages/spatial-import-visium/compute/import_visium.py`:
  // `VISIUM_CAPTURE_SPOT_DIAMETER_UM = 55.0` (what the emit used) and
  // `VISIUM_RENDERED_SPOT_DIAMETER_UM = 65.0` (what #222 replaced it with, and what
  // `micron_scale()` uses today). The denominator and the two scalefactors are from that
  // package's committed `tests/fixtures/visium-outs/spatial/scalefactors_json.json`.
  //
  // These four were hand-copies of values that live in another tree — the same class of rot
  // #258 fixes, one layer down — and #277 closed it. `scripts/check-viz-producer-magnitudes.mjs`
  // now DERIVES the `producer-` values by executing the importer over that package's own
  // committed bundle, and reads the `frozen-` value out of this package's fixture bytes, so a
  // constant change on the producer side reddens these lines instead of silently falsifying
  // them. The literals stay (they are what the test asserts against); what changed is that
  // nothing can move underneath them unnoticed.
  // [producer-magnitude: spot_diameter_fullres]
  const SPOT_DIAMETER_FULLRES = 73.61433
  const TISSUE_HIRES_SCALEF = 0.2
  const TISSUE_LOWRES_SCALEF = 0.06
  // [frozen-magnitude: microns_per_pixel]
  const preMicronScale = 55.0 / SPOT_DIAMETER_FULLRES // 0.7471371402823337
  // [producer-magnitude: microns_per_pixel] [producer-magnitude: spot_diameter_fullres]
  // post-#222 the same bundle derives 65.0 / 73.61433 = 0.8829802566973034, i.e. +18.18%

  // [producer-magnitude: VISIUM_CAPTURE_SPOT_DIAMETER_UM]
  it('declares the 55 µm-derived micron scale, and the two image pitches that follow from it', () => {
    const micronsPerPixel = HIRES.microns_per_pixel as number
    expect(micronsPerPixel).toBeCloseTo(preMicronScale, 12)

    // each image's own pitch is that scale over its vendor scalefactor — `emit_images()`
    const hiresPitch = (HIRES.display_derivative as { original_resolution_um: number }).original_resolution_um
    const lowresPitch = (LOWRES.display_derivative as { original_resolution_um: number }).original_resolution_um
    expect(hiresPitch).toBeCloseTo(preMicronScale / TISSUE_HIRES_SCALEF, 9)
    expect(lowresPitch).toBeCloseTo(preMicronScale / TISSUE_LOWRES_SCALEF, 9)

    // …and the one number #222 did NOT move, so the README's fourth row is pinned too
    expect((HIRES.to_space as number[])[0]).toBe(1 / TISSUE_HIRES_SCALEF)
  })
})

describe('TEST-1 [acceptance] [invariant: INV-2] the declared coordinate_space id is what binds', () => {
  // > *"World coordinate space (image <-> everything geometric) — a declared `coordinate_space` id
  // >  + affine. This is the new binding … It rides in each spatial artifact's `meta`"* — §4

  it('EQUAL ids ⇒ the points ride the raster; ONE character different ⇒ they do not', () => {
    const bound = emitFor(
      catalogOf({ imageSpace: SPACE, toSpace: HIRES.to_space as number[], layoutSpace: SPACE }),
    )
    const unbound = emitFor(
      catalogOf({ imageSpace: SPACE, toSpace: HIRES.to_space as number[], layoutSpace: `${SPACE}x` }),
    )

    // The two inputs differ in ONE character of ONE string, so the id is provably the cause.
    expect(bound.overlay).toBe(true)
    expect(unbound.overlay).toBe(false)
    // …and the raster is drawn either way: a refused binding withdraws the POINTS, never the
    // picture. A version that hid the image too would pass a bare `overlay === false` check.
    expect(bound.layers.length).toBe(unbound.layers.length)
    expect(bound.layers.length).toBeGreaterThan(0)
    expect(unbound.refusal).toContain(SPACE)
    expect(unbound.refusal).toContain(`${SPACE}x`)
  })

  it('the raster is placed by the SAME declaration that binds it', () => {
    const emit = emitFor(
      catalogOf({ imageSpace: SPACE, toSpace: HIRES.to_space as number[], layoutSpace: SPACE }),
    )
    const layer = emit.layers[0] as { props: { modelMatrix?: { toArray?: () => number[] } | number[] } }
    const raw = layer.props.modelMatrix
    const m = Array.isArray(raw) ? raw : (raw?.toArray?.() ?? [])
    // The matrix that reaches the GPU, checked by where it puts the image's far corner.
    expect(through(m, 1400, 1800)).toEqual([7000, 9000])
  })
})

// ── TEST-2 [acceptance] [invariant: INV-3] ────────────────────────────────────────────────────

describe('TEST-2 [acceptance] [invariant: INV-3] adjacency does not place anything', () => {
  // > *"Anti-pattern to refuse explicitly: binding image to coords by artifact adjacency in the
  // >  same run. A user who later registers an H&E image to a Xenium run creates a second image
  // >  artifact in a different run that shares the coordinate space. Only binding (2) survives
  // >  that."* — §4

  it('SAME run, DIFFERENT declared spaces ⇒ NOT bound', () => {
    // These two are as adjacent as artifacts get: one run, consecutive ids, one catalog. An
    // implementation that bound on "they arrived together" would draw this overlay.
    const emit = emitFor(
      catalogOf({
        imageSpace: 'run-7:sectionA',
        toSpace: HIRES.to_space as number[],
        layoutSpace: 'run-7:sectionB',
      }),
    )
    expect(emit.overlay).toBe(false)
    expect(emit.refusal).toContain('sectionA')
    expect(emit.refusal).toContain('sectionB')
  })

  it('DIFFERENT runs, SAME declared space ⇒ bound — the H&E-registered-later case, by name', () => {
    // The image comes from a later registration run and the coordinates from the original import.
    // Nothing about their provenance is shared. The DECLARATION is, and that is the whole binding.
    const emit = emitFor(
      catalogOf({
        imageSpace: 'xenium:0010234__region_1',
        toSpace: [1, 0, 0, 0, 1, 0],
        layoutSpace: 'xenium:0010234__region_1',
      }),
    )
    expect(emit.overlay).toBe(true)
  })
})

// ── TEST-5 [acceptance] [invariant: INV-1] ────────────────────────────────────────────────────

describe('TEST-5 [acceptance] [invariant: INV-1] an artifact declaring no coordinate system is never placed into one', () => {
  // > *"Images, Labels, Points and Shapes MUST have one or more coordinate systems and coordinate
  // >  transformations, while Tables CAN NOT have a coordinate system or coordinate transforms."*
  //                                          — §5, quoting SpatialData's central axiom

  it('a layout with NO declared space never overlays, whatever the raster declares', () => {
    // This is the ordinary embedding — a Table in SpatialData's vocabulary, bound by row identity
    // and not by any coordinate system. It is what stops a UMAP being painted onto tissue.
    const emit = emitFor(
      catalogOf({ imageSpace: SPACE, toSpace: HIRES.to_space as number[], layoutSpace: undefined }),
    )
    expect(emit.overlay).toBe(false)
    expect(emit.refusal).toContain('declares none')
  })

  it('BOTH undeclared is a refusal, not a match — `undefined === undefined` is not agreement', () => {
    const emit = emitFor(catalogOf({}))
    expect(emit.overlay).toBe(false)
    expect(
      resolveOverlayBinding({
        imageSpace: undefined,
        layoutSpace: undefined,
        imagePlaced: false,
        layoutPlaced: false,
        layoutIsIdentity: false,
      }).bound,
    ).toBe(false)
  })

  it('a raster with NO to_space renders at array-index units and overlays nothing', () => {
    // Asserted by the ABSENCE of an overlay and by the refusal's reason — never by a matrix value,
    // so "identity happened to be right here" cannot pass it.
    const emit = emitFor(catalogOf({ layoutSpace: SPACE }))
    expect(emit.overlay).toBe(false)
    const layer = emit.layers[0] as { props: { modelMatrix?: unknown } }
    expect(layer.props.modelMatrix).toBeUndefined()
  })

  it('a raster that NAMES a space but declares no to_space binds nothing — half a declaration is not one', () => {
    // Not hypothetical: the server's summary projection caps ARRAYS at four items, so a
    // six-element `to_space` read off a compacted row arrives MISSING while the
    // `coordinate_space` STRING beside it survives intact. Binding on the two ids alone would
    // draw points stated in the space over a raster sitting at array-index units. TEST-12 found
    // this against the real compaction rule before it could ship.
    const emit = emitFor(catalogOf({ imageSpace: SPACE, layoutSpace: SPACE }))
    expect(emit.overlay).toBe(false)
    expect(emit.refusal).toContain('declares no to_space')
    // …and the raster is still drawn, at the array-index units it honestly has.
    expect(emit.layers.length).toBeGreaterThan(0)
  })

  it('a raster whose DECLARED placement is malformed renders NOTHING, not a mis-placed picture', () => {
    // Absent is a fact about the artifact; malformed is a producer bug, and the two get different
    // outcomes on purpose. Drawing the picture unplaced under a space-framed camera is the same
    // error as drawing it at identity, with extra steps.
    const frame = resolvePaneFrame(
      catalogOf({ imageSpace: SPACE, toSpace: [5, 0, 0, 0], layoutSpace: SPACE }),
      'coords',
    )
    expect(frame.placementError).toBeTruthy()
    const emit = buildImagePaneLayers({ cell: IMAGE_CELL, frame, pyramid: PYRAMID, underlay: undefined })
    expect(emit.layers).toEqual([])
    expect(emit.overlay).toBe(false)
  })
})

// ── TEST-7 ────────────────────────────────────────────────────────────────────────────────────

describe('TEST-7 the placed extent maps all four corners', () => {
  it('a rotated placement yields a WIDER box than scaling the two sides would', () => {
    const theta = Math.PI / 4
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    const rotated = [cos, -sin, 0, sin, cos, 0]
    const e = imageExtentInSpace(1400, 1800, rotated)
    // Computed here from cos/sin, not from the module: a 1400x1800 rectangle rotated 45 degrees
    // spans (1400+1800)/sqrt(2) on each axis.
    const span = (1400 + 1800) / Math.SQRT2
    expect(e.maxX - e.minX).toBeCloseTo(span, 6)
    expect(e.maxY - e.minY).toBeCloseTo(span, 6)
    // The cheap two-sides expression would report 1400*cos = 990 and 1800*cos = 1273 — a box that
    // does not contain the image, i.e. a pane framed on a picture half off its own edge.
    expect(e.maxX - e.minX).toBeGreaterThan(1400 * cos)
  })

  it('a diagonal placement agrees exactly with the sides — the general path costs the ordinary case nothing', () => {
    const e = imageExtentInSpace(1400, 1800, HIRES.to_space as number[])
    expect(e).toEqual({ minX: 0, minY: 0, maxX: 7000, maxY: 9000 })
  })

  it('a translation in the declaration moves the box', () => {
    // Identically zero for everything this system emits today (#176's CORNER convention), which is
    // exactly why it needs an assertion: nothing else in the suite would notice it being dropped.
    const e = imageExtentInSpace(100, 200, [2, 0, 30, 0, 2, 40])
    expect(e).toEqual({ minX: 30, minY: 40, maxX: 230, maxY: 440 })
  })

  it('frames the extent centre at the zoom that fits its longer side', () => {
    const seeded = frameExtent({ minX: 0, minY: 0, maxX: 7000, maxY: 9000 }, 400)
    expect(seeded).not.toBeNull()
    expect(seeded!.target).toEqual([3500, 4500, 0])
    expect(seeded!.zoom).toBeCloseTo(Math.log2(400 / 9000), 12)
  })

  it('fits a SUB-UNIT span rather than clamping it — the space`s unit is the producer`s', () => {
    // A space stated in millimetres, where a whole section spans 0.9. The old expression clamped
    // the fitted span to 1 (unit-safe only while the extent was in image PIXELS) and would have
    // framed this at `log2(400)` — the image drawn microscopically small, with nothing saying so.
    const seeded = frameExtent({ minX: 0, minY: 0, maxX: 0.7, maxY: 0.9 }, 400)
    expect(seeded).not.toBeNull()
    expect(seeded!.zoom).toBeCloseTo(Math.log2(400 / 0.9), 12)
    expect(seeded!.zoom).not.toBeCloseTo(Math.log2(400), 6)
  })

  it('refuses to seed a camera on a degenerate extent', () => {
    // No framing of a zero-area box is better than leaving the pane where it is.
    expect(frameExtent({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 400)).toBeNull()
    expect(frameExtent({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0)).toBeNull()
  })
})

// ── TEST-8 ────────────────────────────────────────────────────────────────────────────────────

describe('TEST-8 the two render paths of ONE artifact land in the same place', () => {
  it('the coarsest-level fallback and the full-res pyramid put their far corners on the same point', () => {
    const toSpace = HIRES.to_space as number[]
    // The served level is the coarsest of the three (1400x1800 -> 700x900 -> 350x450), so its
    // shrink is 4 on both axes — the number `omeTiffUnderlay` derives as 2**index, not as a
    // dimension ratio. `underlayAffine` is the SHIPPED producer of `ImageMeta.affine`.
    const levelAffine = underlayAffine(toSpace, [4, 4])
    expect(levelAffine[0]).toBeCloseTo(0.05, 12) // space -> level pixels: 1/(5*4)

    const pyramidMatrix = imagePlacementMatrix(toSpace)
    const levelMatrix = levelPlacementMatrix(levelAffine)

    // 1400x1800 full-res pixels and 350x450 level pixels are the SAME picture, so their far
    // corners must land on the same space coordinate. A camera that framed one and drew the other
    // would be off by exactly the pyramid depth — a silent 4x.
    const [px, py] = through(pyramidMatrix, 1400, 1800)
    const [lx, ly] = through(levelMatrix, 350, 450)
    expect(px).toBeCloseTo(7000, 6)
    expect(py).toBeCloseTo(9000, 6)
    expect(lx).toBeCloseTo(px, 6)
    expect(ly).toBeCloseTo(py, 6)
    expect(through(levelMatrix, 0, 0)[0]).toBeCloseTo(0, 9)
  })

  it('TWO artifacts, TWO pixel grids, ONE space — which is what the binding MEANS', () => {
    // The hires and lowres images of the same section. Their marker pixel addresses differ by 686
    // px in x, and each placed by its OWN declared affine lands on the same space coordinate.
    // Nothing about a pixel frame can express this; it is the reason the camera is in the space.
    const hires = imagePlacementMatrix(HIRES.to_space as number[])
    const lowres = imagePlacementMatrix(LOWRES.to_space as number[])
    const hiresCorner = through(hires, (HIRES.extent as { width: number }).width, (HIRES.extent as { height: number }).height)
    const lowresCorner = through(lowres, (LOWRES.extent as { width: number }).width, (LOWRES.extent as { height: number }).height)
    expect(hiresCorner[0]).toBeCloseTo(lowresCorner[0], 6)
    expect(hiresCorner[1]).toBeCloseTo(lowresCorner[1], 6)
    expect(hiresCorner).toEqual([7000, 9000])
  })
})

// ── TEST-19 — the mutation the first round of tests could not see ────────────────────────────

describe('TEST-19 a NON-DIAGONAL placement is applied without transposing it', () => {
  // ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────
  // A blind audit ran the obvious mutation — swap `b` and `c` in the affine handed to the matrix
  // builder — and ALL 45 tests stayed green. Every affine anywhere in the suite was DIAGONAL
  // (`[5,0,0,0,5,0]`, `[1,0,0,0,1,0]`, `[2,0,0,0,2,0]`, `[0.05,0,0,0,0.05,0]`), so `b` and `c`
  // were both 0 and a transposition was arithmetically invisible. TEST-7 does use a rotated
  // affine, but only through `imageExtentInSpace` — where the bounding box of a rotated rectangle
  // is symmetric under transposition too, so it could not catch it either.
  //
  // That is precisely the hazard #176 names for the PRODUCER side — *"a square image passes a
  // transposed affine silently"* — reappearing on the consumer side as a square TEST SUITE.
  //
  // A SHEARED affine is used rather than a rotation, and asymmetrically: `b !== c` and both
  // non-zero, so transposing produces a different answer at every probe point rather than a
  // mirrored-but-equal one.
  const SHEARED = [3, 0.5, 0, 0.25, 2, 0] as const

  it('maps the unit axes where the DECLARED affine says, not where its transpose would', () => {
    const m = imagePlacementMatrix(SHEARED)
    // x' = a*x + b*y + tx ; y' = c*x + d*y + ty, written out from the declaration itself.
    expect(through(m, 1, 0)).toEqual([3, 0.25]) // the FIRST column: [a, c]
    expect(through(m, 0, 1)).toEqual([0.5, 2]) // the SECOND column: [b, d]
    // The transpose would put (1,0) at [3, 0.5] and (0,1) at [0.25, 2] — both plausible numbers.
    expect(through(m, 1, 0)).not.toEqual([3, 0.5])
    expect(through(m, 0, 1)).not.toEqual([0.25, 2])
    // …and an off-axis probe, so a fix that only got the axes right is caught too.
    expect(through(m, 10, 4)).toEqual([3 * 10 + 0.5 * 4, 0.25 * 10 + 2 * 4])
  })

  it('the layout`s own placement is read through the SAME arithmetic, and it is a DIFFERENT matrix', () => {
    // §6.6 requires `to_space` on the coordinates artifact too, and it is read through the same
    // builder — which is what makes the refusal below an informed decision rather than a failure
    // to look. The two matrices are deliberately different, so a consumer that mixed them up
    // would still produce a picture and it would not be THIS picture.
    const frame = resolvePaneFrame(
      catalogOf({ imageSpace: SPACE, toSpace: [5, 0, 0, 0, 5, 0], layoutSpace: SPACE, layoutToSpace: SHEARED }),
      'coords',
    )
    expect(through(frame.imageMatrix!, 1, 0)).toEqual([5, 0])
    expect(frame.layoutToSpace).toEqual(SHEARED)
    // …and the sheared layout is REFUSED, because this renderer moves the raster and never the
    // points (DEC-17). TEST-28 carries that argument.
    expect(frame.binding.bound).toBe(false)
  })

  it('a SINGULAR declared placement is refused, not collapsed onto a line', () => {
    // Six finite numbers and rank 1. It passes every length/finiteness check, collapses the grid,
    // gives `imageExtentInSpace` a zero-area box, and would seed a camera from nothing.
    expect(() => imagePlacementMatrix([0, 0, 0, 0, 0, 0])).toThrow(OmeTiffPlacementError)
    expect(() => imagePlacementMatrix([5, 0, 0, 0, 0, 0])).toThrow(OmeTiffPlacementError)
    expect(() => imagePlacementMatrix([2, 4, 0, 1, 2, 0])).toThrow(OmeTiffPlacementError) // rows parallel
    // …and a well-conditioned but TINY affine is NOT rejected — the test is conditioning, not
    // magnitude (an isotropic 1e-7 micron scale has det 1e-14).
    expect(() => imagePlacementMatrix([1e-7, 0, 0, 0, 1e-7, 0])).not.toThrow()
  })
})

// ── TEST-20 — §6.6 for the POINTS, and the refusals that come with it ────────────────────────

describe('TEST-20 [acceptance] [invariant: INV-1] the LAYOUT carries a coordinate system too', () => {
  // > *"Images, Labels, Points and Shapes MUST have one or more coordinate systems and coordinate
  // >  transformations …"* — §5. Both halves: a coordinate SYSTEM (the space id) and a
  // >  TRANSFORMATION (`to_space`). The first cut of this module required the first of a layout
  // >  and only the second of a raster.

  it('a layout that names a space but declares NO to_space does not bind', () => {
    const emit = emitFor(
      catalogOf({
        imageSpace: SPACE,
        toSpace: [5, 0, 0, 0, 5, 0],
        layoutSpace: SPACE,
        layoutToSpace: null,
      }),
    )
    expect(emit.overlay).toBe(false)
    expect(emit.refusal).toContain('declares no to_space')
    // The raster is still drawn — a refusal withdraws the points, never the picture.
    expect(emit.layers.length).toBeGreaterThan(0)
  })

  it('a layout whose declared placement is malformed refuses, and does not blank the raster', () => {
    const frame = resolvePaneFrame(
      catalogOf({
        imageSpace: SPACE,
        toSpace: [5, 0, 0, 0, 5, 0],
        layoutSpace: SPACE,
        layoutToSpace: [1, 0, 0, 0],
      }),
      'coords',
    )
    expect(frame.binding.bound).toBe(false)
    expect(frame.binding.bound ? '' : frame.binding.reason).toContain('layout declares a placement')
    // The RASTER's own placement is fine and survives — a fault in one artifact's declaration may
    // not withdraw another's picture.
    expect(frame.placementError).toBeUndefined()
    expect(frame.imageMatrix).toBeDefined()
  })

  it('a SERVED-LEVEL affine that cannot be inverted disables only the FALLBACK path', () => {
    // The tiled path's own `to_space` is fine here; blanking it over a fault in the other path's
    // number would be a refusal wider than its cause.
    const frame = resolvePaneFrame(
      catalogOf({
        imageSpace: SPACE,
        toSpace: [5, 0, 0, 0, 5, 0],
        affine: [0, 0, 0, 0, 0, 0] as Affine,
        layoutSpace: SPACE,
      }),
      'coords',
    )
    expect(frame.levelPlacementError).toBeTruthy()
    expect(frame.levelMatrix).toBeUndefined()
    expect(frame.placementError).toBeUndefined()
    expect(frame.imageMatrix).toBeDefined()
    expect(frame.binding.bound).toBe(true) // the TILED path can still draw a bound overlay
  })

  it('an UNREAD catalog is distinguishable from one that declares nothing', () => {
    // Two different facts that produce the same undefined fields, and the camera seed has to tell
    // them apart: it is idempotent-once, so seeding on a not-yet-known frame fixes the pane in
    // pixel units forever.
    expect(resolvePaneFrame(null, 'coords').catalogResolved).toBe(false)
    expect(resolvePaneFrame(catalogOf({}), 'coords').catalogResolved).toBe(true)
  })
})

// ── TEST-28 — the points are NEVER moved, and a layout that needs moving is REFUSED ──────────

describe('TEST-28 [acceptance] [invariant: INV-1] a non-identity layout placement is refused, not applied', () => {
  // ── WHY THIS IS A REFUSAL AND NOT A TRANSFORM (DEC-17) ─────────────────────────────────────
  //
  // An earlier cut of this feature DID move the points, with a deck `modelMatrix` on the scatter
  // layer. It moved the marks on the GPU and left every CPU-side consumer of the raw position
  // buffer exactly where it was, and three successive blind audit rounds each enumerated one the
  // previous had missed: the lasso/rect mask, the hover-highlight ring, the selection PROVENANCE
  // replay, the cross-pane tooltip, the vector export. Each is a separate module that reads
  // `positions` and projects it itself.
  //
  // So the raster moves and the points never do — the module's own frame decision, applied
  // consistently rather than almost-consistently — and a layout that would need moving is
  // refused with its reason. Both shipped importers state their coordinates directly in the
  // space, so the cost today is zero and the narrowing is real and stated.

  it('an IDENTITY placement binds; a non-identity one does not', () => {
    const identity = emitFor(
      catalogOf({ imageSpace: SPACE, toSpace: [5, 0, 0, 0, 5, 0], layoutSpace: SPACE }),
    )
    expect(identity.overlay).toBe(true)

    for (const moved of [
      [2, 0, 0, 0, 2, 0], // a scale
      [1, 0, 100, 0, 1, 200], // a translation
      [0, -1, 0, 1, 0, 0], // a rotation
    ]) {
      const emit = emitFor(
        catalogOf({
          imageSpace: SPACE,
          toSpace: [5, 0, 0, 0, 5, 0],
          layoutSpace: SPACE,
          layoutToSpace: moved,
        }),
      )
      expect(emit.overlay, `to_space ${JSON.stringify(moved)} must refuse`).toBe(false)
      expect(emit.refusal).toContain('NON-IDENTITY')
      // The RASTER is still drawn — the refusal withdraws the points, never the picture.
      expect(emit.layers.length).toBeGreaterThan(0)
    }
  })

  it('the declaration is still READ — the refusal is informed, not blind', () => {
    // `layoutToSpace` is carried on the frame even though nothing renders with it. That is what makes
    // the refusal a decision about a KNOWN value rather than a failure to look.
    const frame = resolvePaneFrame(
      catalogOf({
        imageSpace: SPACE,
        toSpace: [5, 0, 0, 0, 5, 0],
        layoutSpace: SPACE,
        layoutToSpace: [2, 0, 0, 0, 2, 0],
      }),
      'coords',
    )
    expect(frame.layoutToSpace).toEqual([2, 0, 0, 0, 2, 0])
    expect(frame.binding.bound).toBe(false)
  })

  it('identity is EXACT — a near-identity affine is a transform the producer meant', () => {
    // A tolerance here would approximate a declared transform away, which is the same class of
    // "plausible wrong answer" this module refuses everywhere else, and it would be a threshold
    // in a feature DEC-10 records as having none.
    expect(isIdentityAffine([1, 0, 0, 0, 1, 0])).toBe(true)
    expect(isIdentityAffine([1, 0, 0, 0, 1, 1e-9])).toBe(false)
    expect(isIdentityAffine([1 + 1e-12, 0, 0, 0, 1, 0])).toBe(false)
    expect(isIdentityAffine([1, 0, 0, 0, 1])).toBe(false)
  })
})


// ── TEST-30 — the singularity test measures CONDITIONING, not equality with zero ─────────────
//
// RESTORED. It was written in round 2, deleted by accident in round 3's rewrite of TEST-28 (an
// index splice took everything between two anchors, and this sat between them), and a round-4
// audit measured the consequence: `det === 0` went from RED to surviving the whole package. The
// guard it pins was never touched. Two lessons, both recorded rather than absorbed: never splice a
// test file by index, and a mutation that WAS caught is worth re-running after a refactor.

describe('TEST-30 a near-singular placement is refused too', () => {
  it('refuses an affine whose determinant is tiny RELATIVE to its entries', () => {
    // Every other refusal fixture has `det` exactly 0, so a mutation to `det === 0` — which drops
    // the whole scale-invariant argument — is indistinguishable from the real test without this.
    // Here `det = 1e-15` against a Frobenius norm² of ~4: two rows parallel to fifteen digits,
    // which is a collapsed grid in every sense that matters to a renderer.
    const nearlyParallel = [1, 1, 0, 1, 1 + 1e-15, 0]
    expect(nearlyParallel[0] * nearlyParallel[4] - nearlyParallel[1] * nearlyParallel[3]).not.toBe(0)
    expect(() => imagePlacementMatrix(nearlyParallel)).toThrow(OmeTiffPlacementError)
  })

  it('…and does NOT refuse a well-conditioned affine that merely has a tiny determinant', () => {
    // The other half, and the reason the test is relative rather than absolute: an isotropic 1e-7
    // scale has `det = 1e-14` — SMALLER than the case above — and is perfectly invertible. An
    // absolute floor would reject it, which is the mistake `invertAffine`'s own comment records
    // having made once.
    const tiny = [1e-7, 0, 0, 0, 1e-7, 0]
    expect(tiny[0] * tiny[4]).toBeLessThan(1e-13)
    expect(() => imagePlacementMatrix(tiny)).not.toThrow()
  })
})

// ── TEST-42 — `isIdentityAffine`, term by term ───────────────────────────────────────────────

describe('TEST-42 identity is checked on ALL SIX terms', () => {
  it('every term that can differ is asserted, one at a time', () => {
    // DEC-17 rests entirely on this predicate: a layout it calls identity is drawn UNMOVED over a
    // raster that IS moved. TEST-28's three fixtures (a scale, a translation, a rotation) each
    // happen to trip only `toSpace[0]` or `toSpace[5]`, so four of the six terms were unasserted —
    // an x-only translation, an anisotropic scale or a pure shear would each have been misread as
    // identity and drawn in the wrong place. Measured by mutation, not supposed.
    expect(isIdentityAffine([1, 0, 0, 0, 1, 0])).toBe(true)
    const NOT_IDENTITY: [string, number[]][] = [
      ['a — x scale', [2, 0, 0, 0, 1, 0]],
      ['b — shear into x', [1, 0.5, 0, 0, 1, 0]],
      ['tx — x translation', [1, 0, 7, 0, 1, 0]],
      ['c — shear into y', [1, 0, 0, 0.5, 1, 0]],
      ['d — y scale (anisotropic)', [1, 0, 0, 0, 3, 0]],
      ['ty — y translation', [1, 0, 0, 0, 1, 7]],
    ]
    for (const [name, affine] of NOT_IDENTITY) {
      expect(isIdentityAffine(affine), `${name} must not read as identity`).toBe(false)
    }
  })

  it('a WRONG-LENGTH array is not identity, whatever its first entries say', () => {
    // A five-element array whose entries all match would otherwise read as identity by falling off
    // the end into `undefined === undefined`… which it does not, but only because the length is
    // checked FIRST. Dropping that check survived the suite.
    expect(isIdentityAffine([1, 0, 0, 0, 1])).toBe(false)
    expect(isIdentityAffine([1, 0, 0, 0, 1, 0, 0])).toBe(false)
    expect(isIdentityAffine([])).toBe(false)
  })

  it('and it is EXACT — a near-identity affine is a transform the producer meant', () => {
    expect(isIdentityAffine([1, 0, 0, 0, 1, 1e-9])).toBe(false)
    expect(isIdentityAffine([1 + 1e-12, 0, 0, 0, 1, 0])).toBe(false)
  })
})

// ── TEST-43 — the emit and the reporter say the SAME thing ───────────────────────────────────

describe('TEST-43 overlayRefusal — one derivation, two callers', () => {
  const bound = { levelPlacementError: undefined, binding: { bound: true as const, space: 'S' } }
  const unbound = { levelPlacementError: undefined, binding: { bound: false as const, reason: 'different spaces' } }

  it('a pane with no RASTER is refused for that, whatever the spaces say', () => {
    // PRECEDENCE, which is the thing that drifted: the emit refused raster-first while the
    // reporter explained binding-first, so a pane that was BOTH un-drawable and unbound was
    // refused for one reason and explained with another. One function now decides both.
    expect(overlayRefusal(bound, false)).toContain('no raster')
    expect(overlayRefusal(unbound, false)).toContain('no raster')
    expect(overlayRefusal(unbound, false)).not.toContain('different spaces')
  })

  it('a served-level placement error is named rather than generalized', () => {
    expect(
      overlayRefusal({ levelPlacementError: 'singular affine', binding: bound.binding }, false),
    ).toBe('singular affine')
  })

  it('a drawable pane falls back to the binding, and a bound one has nothing to say', () => {
    expect(overlayRefusal(unbound, true)).toBe('different spaces')
    expect(overlayRefusal(bound, true)).toBeUndefined()
  })
})
