// productionRasterSeams.test.ts — #159 TEST-5 [acceptance] [invariant: INV-2].
//
// > *"`imageUnderlay()` / `imagePixelSource()` / `imageLabelMask()` in the production data
// >  source | `workbenchDataSource.ts` throws; the pyramid/mask methods are **absent** and
// >  implemented only by 5 showcase stories. **`ui/src` work, i.e. `src-app`.** | required to
// >  *see* anything"* — `docs/design/spatial-storage-layout.md` §10
//
// ── WHY THIS TEST IS ABOUT AN OBJECT'S IDENTITY, NOT ABOUT A CLASS ──────────────────────────
// The trap this whole item exists to avoid is implementing the seams on the wrong object.
// Production does NOT hand the grid a `WorkbenchDataSource`. It builds
// `asDataSource(WorkbenchStreamingSource)` and hands the grid THAT, and the adapter used to
// forward neither raster seam — so a data source could implement `imagePixelSource()` perfectly
// and every renderer would still see a source that has none, with nothing anywhere saying why.
//
// So the first case here reaches into the REAL `buildProjectSources` and asks the object it
// returns, rather than asking the class. A version of this test written against
// `new WorkbenchDataSource(...)` would pass with the adapter's forwarding deleted, which is the
// exact defect.
//
// ── AND WHY THE MASK IS ASSERTED ABSENT ─────────────────────────────────────────────────────
// §10 names three methods and this item ships two. The third is not merely unbuilt: a label
// raster's producer-declared structure is byte-identical to an intensity raster's, its kind is
// forbidden from declaring a capability, and its id may not be spelled in this workspace — so
// there is no route by which a consumer could tell the two apart (DEC-4). What CAN ship is the
// forwarding, and the last case here proves it: a source that declares a mask gets one through
// the whole production chain, so the day a producer exists the work is one method on one class.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@ziee/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkbenchAPI } from '@/modules/workbench/core'
import { createCapabilityBroker } from '@/modules/workbench/core/capabilities/broker'
import { buildProjectSources, __resetProjectSourcesForTests } from './projectSources'
import { WorkbenchDataSource, type DataPlaneArtifact, type WorkbenchDataSourceDeps } from './workbenchDataSource'
import { WorkbenchStreamingSource } from './workbenchStreamingSource'

const SLOW = 120_000
const FIXTURES = path.resolve(process.cwd(), '../libs/viz/src/viz-core/spatial/fixtures')
const RASTER_BYTES = readFileSync(path.join(FIXTURES, 'spatial-image-hires.ome.tif'))
const EMITTED = JSON.parse(
  readFileSync(path.join(FIXTURES, 'emitted-manifest-entries.json'), 'utf8'),
) as { id: string; structure: unknown; meta: { to_space: number[]; coordinate_space: string } }[]
const HIRES = EMITTED.find(e => e.id === 'spatial-image-hires')!

/**
 * The entity-axis name a coordinates artifact declares, READ FROM THE FIXTURE rather than typed.
 *
 * Same reason the datatype ids above are read from `emitted-manifest-entries.json`: the app must
 * carry ZERO of the domain lattice (`lint-no-domain-in-builtin`), and an axis name is part of it.
 * The fixture is a producer-derived data file outside the linted roots, so naming the axis there
 * and reading it here keeps the vocabulary where it belongs — in the data.
 */
const ENTITY_AXIS = (
  JSON.parse(readFileSync(path.join(FIXTURES, 'vendor-spot-positions.json'), 'utf8')) as {
    entity_axis: string
  }
).entity_axis

const RASTER_ROW: DataPlaneArtifact = {
  id: 'r1',
  datatype: 'nobody/has-ever-registered-this',
  structure: HIRES.structure,
  meta: HIRES.meta,
  stored_bytes: RASTER_BYTES.byteLength,
}

async function realPyramid() {
  const { loadOmeTiffPyramid } = await import('@ziee/viz/core')
  return loadOmeTiffPyramid({
    byteLength: RASTER_BYTES.byteLength,
    async read(start: number, end: number) {
      return RASTER_BYTES.buffer.slice(RASTER_BYTES.byteOffset + start, RASTER_BYTES.byteOffset + end + 1)
    },
  })
}

const pullDeps = (): Partial<WorkbenchDataSourceDeps> => ({
  getCatalog: async () => ({ axes: [], artifacts: [RASTER_ROW] }),
  getArtifact: async () => RASTER_ROW,
  openPyramid: async () => await realPyramid(),
  hasCapability: () => false,
})

/** The EXACT composition `projectSources.ts` performs, with only the transport injected. */
async function productionChain() {
  const { asDataSource } = await import('@ziee/viz/core')
  const pull = new WorkbenchDataSource('p1', pullDeps())
  return asDataSource(new WorkbenchStreamingSource('p1', { pull }))
}

describe('TEST-5 [acceptance] INV-2 — the seams are on the object the GRID holds', () => {
  it('the real `buildProjectSources` output carries the pyramid seam', () => {
    // No bytes are read here on purpose: the property under test is whether the ADAPTER
    // forwards, and that is decided when the object is built. Deleting either forwarding
    // line in `asDataSource` turns this red without any transport being involved.
    const handle = { capabilities: createCapabilityBroker() } as WorkbenchAPI
    __resetProjectSourcesForTests(handle)
    const { pull } = buildProjectSources(handle, 'p1')

    expect(
      typeof (pull as { imagePixelSource?: unknown }).imagePixelSource,
      'the object production hands the grid must carry the pyramid seam — a source that ' +
        'implements it behind an adapter that drops it is invisible to every renderer',
    ).toBe('function')

    // The mask seam is genuinely ABSENT on the production object today — the honest state
    // recorded in DEC-4, not an oversight. Absent, not `undefined`.
    //
    // READ THIS BEFORE "FIXING" A FAILURE HERE. This is an OBSERVATION, not a requirement: it
    // exists so that half-wiring the mask is loud, NOT to keep it unwired. The day a producer
    // emits a label raster and the source can tell one from an intensity raster, the correct
    // change is to flip this expectation and delete this paragraph — not to work around it.
    expect(
      'imageLabelMask' in (pull as object),
      'the mask seam is unwired by DEC-4 because a label raster is indistinguishable from an ' +
        'intensity raster by every route this workspace may read. If that has changed, invert ' +
        'this expectation rather than routing around it.',
    ).toBe(false)
  })

  it('drives BOTH shipped seams end-to-end through that chain, over real emitted bytes', async () => {
    const source = await productionChain()

    // 1. the catalog advertises the raster…
    const catalog = await source.catalog()
    expect(catalog.hasImage).toBe(true)
    expect(catalog.image).toMatchObject({ width: 350, height: 450, channels: 4 })

    // 2. …the tiling pyramid resolves, full resolution first, each level halved…
    const pyramid = await source.imagePixelSource!()
    expect(pyramid.length).toBe(3)
    // Indexed through the level's own AXIS LABELS, not by position: an interleaved raster
    // carries a trailing per-pixel component axis (`['c','y','x','_c']`) and a planar one does
    // not, so a positional read silently reports a component count as a dimension.
    const dims = pyramid.map(p => {
      const labels = p.labels as readonly string[]
      return [p.shape[labels.indexOf('y')], p.shape[labels.indexOf('x')]]
    })
    expect(dims).toEqual([
      [1800, 1400],
      [900, 700],
      [450, 350],
    ])

    // 3. …and `imageUnderlay()` RETURNS rather than throwing, through the STREAM channel the
    //    adapter reconstitutes it from. That is the whole path: the pull source reduces, the
    //    streaming source serves the bytes, the adapter pairs them with the catalog header.
    const underlay = await source.imageUnderlay()

    // ── ASSERTED AGAINST LITERALS, NOT AGAINST THE CATALOG ──────────────────────────────────
    // Comparing `underlay.width` to `catalog.image.width` here is a TAUTOLOGY, and it read like
    // the load-bearing check: `asDataSource` CONSTRUCTS the returned underlay out of
    // `cat.image` (`{ data, width: meta.width, … }`), so the two sides are the same value and
    // the comparison passes with the header and the texture disagreeing arbitrarily. The real
    // cross-check lives where the two are computed independently — `workbenchDataSource.image.
    // test.ts` and `omeTiffUnderlay.test.ts`, both against the UN-adapted source.
    //
    // What this leg can honestly assert is that the numbers coming off the wire are the RIGHT
    // ones: the coarsest level of the real 3-level pyramid, and its byte length.
    expect([underlay.width, underlay.height, underlay.channels]).toEqual([350, 450, 4])
    expect(underlay.data.length).toBe(350 * 450 * 4)
    // …and the placement, inverted to the declared direction and rescaled to the served level:
    // the producer declares 5 space-units per full-resolution pixel, the level is the 4x one.
    expect(underlay.affine[0]).toBeCloseTo(0.05, 9)
    expect(underlay.affine[4]).toBeCloseTo(0.05, 9)
    // Not a blank texture: a zero-filled buffer of the right size would satisfy every
    // assertion above.
    expect(underlay.data.some(v => v !== 0)).toBe(true)
  }, SLOW)

  it('a source that DOES declare a mask gets one through the same chain — the forwarding half', async () => {
    // The mask has no producer, so this uses a hand-built streaming source. The subject is not
    // the mask's contents; it is that nothing between a source and a renderer drops the seam.
    const { asDataSource } = await import('@ziee/viz/core')
    const pull = new WorkbenchDataSource('p1', pullDeps())
    const withMask = new WorkbenchStreamingSource('p1', { pull })
    const token = { labels: new Uint16Array([1, 2, 3]) }
    ;(withMask as unknown as { imageLabelMask: () => unknown }).imageLabelMask = () => token

    const forwarded = asDataSource(withMask)
    expect('imageLabelMask' in (forwarded as object)).toBe(true)
    expect(await forwarded.imageLabelMask!()).toBe(token)
  }, SLOW)

  it('and a source that declares NEITHER seam produces an object carrying NEITHER key', async () => {
    // The non-vacuity control for every `in`-check above. Absence has to be reachable, or
    // "present" asserts nothing.
    const { asDataSource } = await import('@ziee/viz/core')
    const bare = {
      catalog: async () => ({
        datasetId: 'p1',
        pointCount: 0,
        layouts: [],
        valueColumns: [],
        categoricalColumns: [],
        continuousColumns: [],
        hasImage: false,
      }),
      // eslint-disable-next-line require-yield
      stream: async function* () {
        throw new Error('nothing streams here')
      },
    }
    const forwarded = asDataSource(bare as never)
    expect('imagePixelSource' in (forwarded as object)).toBe(false)
    expect('imageLabelMask' in (forwarded as object)).toBe(false)
  }, SLOW)
})

// ── #228 TEST-11 — the DECLARATION survives every wrapper ──────────────────────────────────────

describe('TEST-11 the coordinate_space declaration survives the streaming adapter', () => {
  it(
    'the catalog the GRID holds carries `image.space`, all six of `image.toSpace`, and `layouts[].space`',
    async () => {
      // THIS FILE EXISTS BECAUSE OF EXACTLY THIS FAILURE MODE. #159 shipped a source that
      // implemented `imagePixelSource()` perfectly behind an adapter that dropped it, and the
      // renderer never saw it. A catalog FIELD is the same hazard in a quieter costume: a
      // `space` that the adapter fails to carry does not throw — the pane simply draws a picture
      // with no points, which is indistinguishable from a project whose artifacts genuinely
      // declare different frames.
      //
      // So this compares the catalog reached through the REAL production chain
      // (`asDataSource(WorkbenchStreamingSource)`) against the direct pull, field by field.
      const layoutRow: DataPlaneArtifact = {
        id: 'coords-1',
        datatype: 'nobody/has-ever-registered-this-either',
        structure: { encoding: 'zarr_v3', kind: 'table', axis: ENTITY_AXIS, n: 160 },
        meta: { coordinate_space: HIRES.meta.coordinate_space, unit: 'pixel', to_space: [1, 0, 0, 0, 1, 0] },
      }
      const deps: Partial<WorkbenchDataSourceDeps> = {
        getCatalog: async () => ({ axes: [], artifacts: [RASTER_ROW, layoutRow] }),
        getArtifact: async (id: string) => (id === layoutRow.id ? layoutRow : RASTER_ROW),
        openPyramid: async () => await realPyramid(),
        // the LAYOUT artifact is the plottable SPATIAL one; the raster is neither. Gated on the
        // DATATYPE, not on the capability alone — a blanket `true` would make the raster its own
        // layout and the assertion below would pass for the wrong reason.
        hasCapability: (dt: string, cap: string) =>
          dt === layoutRow.datatype && (cap === 'plottable-xy' || cap === 'spatial-coordinates'),
      }
      const { asDataSource } = await import('@ziee/viz/core')
      const pull = new WorkbenchDataSource('p1', deps)
      const direct = await pull.catalog()
      const throughAdapter = await asDataSource(
        new WorkbenchStreamingSource('p1', { pull: new WorkbenchDataSource('p1', deps) }),
      ).catalog()

      // The producer's own space id, carried verbatim — not a truthiness check.
      expect(direct.image?.space).toBe(HIRES.meta.coordinate_space)
      expect(throughAdapter.image?.space).toBe(HIRES.meta.coordinate_space)

      // ALL SIX elements. Four would be the `compact_declaration` truncation and it is a
      // plausible wrong answer rather than an error, so the length is asserted explicitly.
      expect(direct.image?.toSpace).toEqual(HIRES.meta.to_space)
      expect(direct.image?.toSpace).toHaveLength(6)
      expect(throughAdapter.image?.toSpace).toEqual(HIRES.meta.to_space)
      expect(throughAdapter.image?.toSpace).toHaveLength(6)

      // …and the layout half of the binding, which is the one a listing row carries.
      expect(direct.layouts.map(l => l.space)).toEqual([HIRES.meta.coordinate_space])
      expect(throughAdapter.layouts.map(l => l.space)).toEqual([HIRES.meta.coordinate_space])

      // The two halves agree, which is the whole point: this project's raster and its
      // coordinates are in ONE frame, so the overlay binds.
      const layoutEntry = throughAdapter.layouts.find(l => l.id === layoutRow.id)
      expect(throughAdapter.image?.space).toBe(layoutEntry?.space)
      // …and the layout's OWN placement rides too (§6.6): six elements, verbatim.
      expect(layoutEntry?.toSpace).toEqual([1, 0, 0, 0, 1, 0])
      expect(direct.layouts.find(l => l.id === layoutRow.id)?.toSpace).toEqual([1, 0, 0, 0, 1, 0])
    },
    SLOW,
  )

  it(
    'INV-1: a plottable artifact WITHOUT the spatial-coordinates capability declares NO frame',
    async () => {
      // > *"Images, Labels, Points and Shapes MUST have one or more coordinate systems and
      // >  coordinate transformations, while Tables CAN NOT have a coordinate system or
      // >  coordinate transforms."* — §5, the axiom §6.2 mints the `spatial-coordinates`
      // > capability for.
      //
      // The artifact below carries a `coordinate_space` in its `meta` — a producer may write any
      // key it likes — and is plottable. Without the capability it is an ordinary computed
      // layout, a Table's companion, and harvesting that key would let it be painted onto tissue.
      // Dropping the capability from the filter SURVIVED the suite before this case existed.
      const layoutRow: DataPlaneArtifact = {
        id: 'coords-2',
        datatype: 'nobody/has-ever-registered-this-either',
        structure: { encoding: 'zarr_v3', kind: 'table', axis: ENTITY_AXIS, n: 160 },
        meta: { coordinate_space: HIRES.meta.coordinate_space, to_space: [1, 0, 0, 0, 1, 0] },
      }
      const pull = new WorkbenchDataSource('p1', {
        getCatalog: async () => ({ axes: [], artifacts: [RASTER_ROW, layoutRow] }),
        getArtifact: async (id: string) => (id === layoutRow.id ? layoutRow : RASTER_ROW),
        openPyramid: async () => await realPyramid(),
        // plottable, and NOT spatial
        hasCapability: (dt: string, cap: string) => cap === 'plottable-xy' && dt === layoutRow.datatype,
      })
      const catalog = await pull.catalog()
      const entry = catalog.layouts.find(l => l.id === layoutRow.id)
      expect(entry, 'it IS offered as a layout — this is not about hiding it').toBeDefined()
      expect(entry?.space, 'but it declares no coordinate system').toBeUndefined()
      expect(entry?.toSpace).toBeUndefined()
      // the raster's own frame is unaffected, so this is a narrowing and not a blanket refusal
      expect(catalog.image?.space).toBe(HIRES.meta.coordinate_space)
    },
    SLOW,
  )
})
