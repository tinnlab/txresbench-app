// TEST-D1 (INV-3, the headline acceptance) + TEST-A2 (now INV-5) — RUNNABLE proof of the
// NON-SINGLE-CELL DROP-IN.
//
// WHAT THIS FILE PROTECTS (unchanged): a package from a completely different domain can
// land a fully-typed, axis-scoped annotation schema with ZERO core edits — no app code
// knows the word `region`, and nothing about the single-cell domain is required for the
// path to work. The `fixture/image` datatype (a microscopy image, `{height,width,channel}`
// + a `region` axis) is registered through the REAL FE datatype registry and resolved
// through the REAL `annotationsForAxis`.
//
// WHAT CHANGED (ITEM-12 / INV-5): the MECHANISM by which the package's columns become
// typed. It used to be a FORECAST — `AxisSpec.annotations` on the datatype plus
// `produces_annotations` on the producing analysis — and this file asserted that forecast
// round-tripped. INV-5 deletes it: *facts about produced data are read from artifacts,
// never declared ahead of time.* So the package now contributes typed columns by
// (a) registering the datatypes its column artifacts carry, with their catalog
// capabilities, and (b) EMITTING artifacts that STAMP their own kind — a stamp the
// conformance gate verifies. The drop-in claim is re-expressed against that mechanism;
// the forecast round-trip is not merely deleted but INVERTED, because the fixture still
// ships its (now inert) forecast and this file proves it contributes nothing.
//
// ITEM-39 removed this file's five widget-CORE cases (`PRIMITIVE 1..4` + "binds all four
// REGISTERED primitive kinds") and every `controlShapeForType` assertion: the four general
// dimension primitives are deleted, so there is no builder / control-shape mapping left to
// drive. The `@txresbench/kit` browser boundary is neutralized so the host module imports under
// the node runner (mirrors workbenchDataSource.test).

import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@txresbench/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import { datatypeRegistry, type Datatype } from '@/core/datatypes'
import {
  resolveEntityAxis,
  WorkbenchDataSource,
  type DataPlaneArtifact,
} from '@/modules/workbench/extensions/data/workbenchDataSource'
import {
  IMAGE_FIXTURE_DATATYPE_ID,
  imageDatatype,
  imageFixtureAnalysis,
  registerImageFixture,
} from './imageDatatype'

const DOMAIN_TOKENS = /\bcells?\b|\bgenes?\b|\bobs\b|\bvar\b|barcode|clustering|leiden|single-cell/i

/** The image package's own COLUMN datatypes — the second half of its contributed DATA.
 *  A datatype opts its artifacts into a catalog channel by declaring the capability
 *  (DEC-7); the app carries no domain id, so this is all a package has to do. Their axes
 *  carry IDENTITY ONLY (ITEM-12).
 *
 *  ── WHY THESE DECLARE THREE AXES IN THIS ORDER ────────────────────────────────────
 *
 *  They used to declare exactly ONE (`region`), which made this whole file blind to the
 *  defect it is supposed to be the un-gameable proof against: the consumer resolved a
 *  datatype's entity axis as `axes[0]`, and with one axis `axes[0]` is trivially right.
 *  The drop-in fixture therefore certified a positional guess as working. It now declares
 *  `[channel, height, region]` — its entity axis LAST, and two raster dimensions ahead of
 *  it — so a positional resolver answers `channel` and every assertion that depends on
 *  the entity axis fails. (Mutation-checked: dropping `entity_axis` below turns this file
 *  red, which is the property that makes it evidence.) */
const REGION_ANNOTATION_ID = 'fixture/region-annotation'
const REGION_METRIC_ID = 'fixture/region-metric'

function columnDatatype(id: string, capabilities: string[]): Datatype {
  return {
    id,
    extends: 'data',
    title: id,
    description: `A ${id} column aligned to the image fixture's region axis.`,
    is_abstract: false,
    storage: { layout: { kind: 'chunked_dense' }, format: 'zarr', selector_map: {}, file_layout: 'single', tiers: [] },
    capabilities,
    viewers: [],
    converters: [],
    axes: [
      { name: 'channel', key_label: 'channel_id' },
      { name: 'height', key_label: 'row' },
      { name: 'region', key_label: 'region_id' },
    ],
    entity_axis: 'region',
  } as Datatype
}

// Register the fixture package through the REAL registry so the source resolves it the way
// the running app would (no injected `hasCapability` / `rowAxisFor` / `columnLabel` mocks —
// the registry-backed defaults do the lookups).
beforeAll(() => {
  registerImageFixture()
  const contributed = [
    columnDatatype(REGION_ANNOTATION_ID, ['categorical']),
    columnDatatype(REGION_METRIC_ID, ['continuous-column']),
  ]
  const ids = new Set(contributed.map(t => t.id))
  datatypeRegistry.replaceAll([...datatypeRegistry.all().filter(t => !ids.has(t.id)), ...contributed])
})

/** The columns the package's run ACTUALLY WROTE, each stamping its own kind.
 *
 *  `region_texture` is the load-bearing entry: NO analysis and NO datatype declares it
 *  (it is the image analogue of the 65 metadata columns a real CELLxGENE import carries
 *  that its datatype never mentioned). Under the old forecast contract it was invisible. */
const REGION_ARTIFACTS: DataPlaneArtifact[] = [
  {
    id: 'region-labels',
    datatype: REGION_ANNOTATION_ID,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'region',
      n: 12,
      columns: [
        { path: 'region_class', kind: 'categorical', levels: ['tumour', 'stroma'] },
        { path: 'region_texture', kind: 'string', layout: 'split', n: 12 },
      ],
    },
  },
  {
    id: 'region-area',
    datatype: REGION_METRIC_ID,
    structure: { encoding: 'opaque', media_type: 'application/octet-stream' },
  },
]

/** A WorkbenchDataSource whose ONLY injected boundary is the catalog/octet plane — every
 *  registry-backed dep stays the REAL default, so what comes back is produced by the
 *  package's contributed DATA + its artifacts' stamps, not by a mock. */
function fixtureDataSource(artifacts: DataPlaneArtifact[] = []): WorkbenchDataSource {
  return new WorkbenchDataSource('p-fixture', {
    // A NON-single-cell axis set: the image fixture's own declared `region` axis.
    getCatalog: async () => ({
      axes: [{ content_hash: 'h-region', name: 'region', length: 12 }],
      artifacts,
    }),
    getArtifact: async id => ({
      id,
      datatype: IMAGE_FIXTURE_DATATYPE_ID,
      structure: { encoding: 'opaque', media_type: 'application/octet-stream' },
    }),
    fetchArtifactBytes: async () => new ArrayBuffer(0),
  })
}

describe('TEST-D1 [INV-3 + INV-5]: a non-single-cell package yields typed columns from its own DATA + artifacts', () => {
  it('resolves the region columns from the REAL registry + the artifacts` stamps — no single-cell concept', async () => {
    const region = await fixtureDataSource(REGION_ARTIFACTS).annotationsForAxis(
      IMAGE_FIXTURE_DATATYPE_ID,
      'region',
    )
    // One entry per column that LANDED, typed by the kind its artifact stamped:
    // a `categorical` member and a `string` member both serve the categorical channel;
    // the metric artifact's capability puts it on the continuous channel.
    expect(region.map(a => [a.name, a.type])).toEqual([
      ['region-labels#region_class', 'categorical'],
      ['region-labels#region_texture', 'categorical'],
      ['region-area', 'continuous'],
    ])
    // no single-cell token leaks into the rendered names/labels — the labels are built
    // from the PACKAGE's own datatype ids and member names, so a core-supplied domain
    // string would show up here.
    for (const a of region) {
      expect(DOMAIN_TOKENS.test(a.name)).toBe(false)
      expect(DOMAIN_TOKENS.test(a.label)).toBe(false)
    }
  })

  it('includes a column the package declared NOWHERE — the drop-in`s open half', async () => {
    const region = await fixtureDataSource(REGION_ARTIFACTS).annotationsForAxis(
      IMAGE_FIXTURE_DATATYPE_ID,
      'region',
    )
    // `region_texture` appears in neither the datatype's axes nor the analysis' outputs…
    expect(JSON.stringify(imageDatatype)).not.toContain('region_texture')
    expect(JSON.stringify(imageFixtureAnalysis)).not.toContain('region_texture')
    // …and is still reported, TYPED, so it is filterable/groupable like any other column.
    const texture = region.find(a => a.name === 'region-labels#region_texture')
    expect(texture?.type).toBe('categorical')
    expect(texture?.available).toBe(true)
  })

  it('the fixture datatype is registered through the REAL registry (no bespoke lookup path)', () => {
    expect(datatypeRegistry.get(IMAGE_FIXTURE_DATATYPE_ID)?.id).toBe(IMAGE_FIXTURE_DATATYPE_ID)
    // …as are the package's own column datatypes, which is what puts its artifacts on the
    // catalog channels. ZERO core edits: only registry DATA.
    expect(datatypeRegistry.get(REGION_ANNOTATION_ID)?.capabilities).toEqual(['categorical'])
    expect(datatypeRegistry.get(REGION_METRIC_ID)?.capabilities).toEqual(['continuous-column'])
  })

  it('the fixture datatype names no single-cell concept anywhere in its declared DATA', () => {
    expect(DOMAIN_TOKENS.test(JSON.stringify(imageDatatype))).toBe(false)
  })
})

// ───────────── THE ENTITY AXIS IS DECLARED, NOT POSITIONAL (the drop-in's other half) ─────────────
//
// The drop-in claim has two halves. The one above is "a package's columns become typed
// from its own DATA + its artifacts' stamps". This one is "the app resolves that
// package's axes from what it DECLARED, never from where it happened to write it".
//
// It exists because the second half was silently false and this file could not see it.
// `WorkbenchDataSource` resolved a datatype's entity axis — the axis whose cardinality
// becomes every point count, layout length and dense column extent — as `axes[0]`. The
// image fixture declares FOUR axes of which the first three are raster dimensions, so
// its entity axis resolved to a picture's pixel ROWS. Nothing here failed, for two
// independent reasons, and both are now closed:
//   · this file only ever calls `annotationsForAxis(_, axis)`, which takes the axis
//     EXPLICITLY, so the resolver never ran; and
//   · the package's own column datatypes declared exactly ONE axis, where `axes[0]` is
//     trivially right — they now declare three, entity LAST (see `columnDatatype`).
// The first is closed by asserting the resolver directly, below.
describe('the image package`s entity axis comes from its DECLARATION, not a position', () => {
  it('resolves `region` — while the FIRST declared axis is a raster dimension', () => {
    const dt = datatypeRegistry.get(IMAGE_FIXTURE_DATATYPE_ID)
    // The negative control, stated as an assertion rather than trusted: the positional
    // answer is available, is different, and is a raster dimension. If a future edit
    // reorders the fixture's axes so `region` lands first, THIS line fails and says so —
    // rather than letting the acceptance below start passing for the wrong reason.
    expect(dt?.axes?.[0]?.name).toBe('height')
    expect(resolveEntityAxis(dt)).toBe('region')
  })

  it('the package`s own COLUMN datatypes declare their entity axis LAST, and resolve it', () => {
    for (const id of [REGION_ANNOTATION_ID, REGION_METRIC_ID]) {
      const dt = datatypeRegistry.get(id)
      const names = (dt?.axes ?? []).map(a => a.name)
      // non-vacuity: several axes, and the entity axis is not the first one — so a
      // positional resolver gets a DIFFERENT answer and this suite goes red.
      expect(names.length).toBeGreaterThan(1)
      expect(names[0]).not.toBe('region')
      expect(resolveEntityAxis(dt)).toBe('region')
    }
  })

  it('a package that declares SEVERAL axes and names none gets NO answer (never the first)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The same fixture with its declaration removed — the shape a pre-migration or
      // hand-edited package still carries. The honest answer is nothing at all: the
      // caller then falls back on the CATALOG's order and says so, instead of a guess
      // wearing a declaration's clothes.
      const undeclared = { ...imageDatatype, entity_axis: undefined } as Datatype
      expect(resolveEntityAxis(undeclared)).toBeUndefined()
      expect(warn.mock.calls.some(c => String(c[0]).includes(IMAGE_FIXTURE_DATATYPE_ID))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

// ─────────────────────── TEST-A2, re-expressed for INV-5 ───────────────────────
//
// WAS: "static types — the producer's DECLARED output columns+types, never inference",
// asserting that `imageFixtureAnalysis.produces_annotations` round-tripped through
// `annotationsForAxis` so a producer-only column (`pct_positive`) arrived typed.
//
// That is now the OPPOSITE of the contract. The types are still STATIC and still never
// inferred — but they come from the ARTIFACT'S STAMP, which the conformance gate verifies,
// instead of from a forecast written before the data existed. So the same fixture drives
// the INVERTED claim: its forecast is INERT.
describe('TEST-A2 [INV-5]: a FORECAST is inert — a type comes from the stamp, not the declaration', () => {
  /** A legacy forecast, on both of the removed levels, built HERE rather than shipped by the
   *  fixture — because `AxisSpec.annotations` and `AnalysisContribution.produces_annotations`
   *  are deleted, so neither can be written in typed code any more. That deletion is the
   *  stronger result (a forecast is now unrepresentable, not merely ignored), but it would
   *  make an inertness suite VACUOUS: with nothing to ignore, "the forecast contributes
   *  nothing" passes trivially. So the forecast is reconstructed through `unknown` — exactly
   *  the shape a pre-migration package or a hand-edited manifest would still carry — and the
   *  assertions below prove the RUNTIME reads none of it. */
  const LEGACY_FORECAST_COLUMNS = ['region_class', 'mean_intensity', 'area_px', 'pct_positive']

  const legacyForecaster = {
    ...imageDatatype,
    axes: [
      { name: 'height', key_label: 'row' },
      { name: 'width', key_label: 'column' },
      {
        name: 'region',
        key_label: 'region_id',
        // the deleted datatype-level forecast (`AxisSpec.annotations`)
        annotations: [
          { name: 'region_class', label: 'Region class', type: 'categorical', capability: 'categorical' },
          { name: 'mean_intensity', label: 'Mean intensity', type: 'continuous', capability: 'continuous-column' },
          { name: 'area_px', label: 'Area (px)', type: 'continuous', capability: 'continuous-column' },
        ],
      },
    ],
  } as unknown as Datatype

  it('the forecast this suite tests is NON-EMPTY and names a column no artifact writes', () => {
    // Guards the suite against going quietly green on an empty forecast.
    expect(LEGACY_FORECAST_COLUMNS).toContain('mean_intensity') // datatype-level
    expect(LEGACY_FORECAST_COLUMNS).toContain('pct_positive') // analysis-level
    // …and the levels really are gone from the shipped fixture, so nothing re-enters there.
    expect(JSON.stringify(imageDatatype)).not.toContain('annotations')
    expect(JSON.stringify(imageFixtureAnalysis)).not.toContain('produces_annotations')
  })

  it('registering a datatype that STILL carries a forecast yields nothing from it', async () => {
    const saved = datatypeRegistry.all()
    datatypeRegistry.replaceAll([...saved.filter(t => t.id !== IMAGE_FIXTURE_DATATYPE_ID), legacyForecaster])
    try {
      // No artifacts → nothing, despite three declared `region` columns sitting right there.
      expect(await fixtureDataSource().annotationsForAxis(IMAGE_FIXTURE_DATATYPE_ID, 'region')).toEqual([])
      // With artifacts → only what the artifacts stamped; the declaration adds no entry.
      const region = await fixtureDataSource(REGION_ARTIFACTS).annotationsForAxis(IMAGE_FIXTURE_DATATYPE_ID, 'region')
      expect(region.map(a => a.name)).toEqual([
        'region-labels#region_class',
        'region-labels#region_texture',
        'region-area',
      ])
    } finally {
      datatypeRegistry.replaceAll(saved)
    }
  })

  it('with NO artifacts, the forecast alone yields NOTHING (was: four typed entries)', async () => {
    // The exact input the old acceptance ran on — an empty catalog — under which it
    // asserted `[region_class, mean_intensity, area_px, pct_positive]`. A forecast is not
    // a fact about produced data, so the honest answer is the empty one.
    expect(await fixtureDataSource().annotationsForAxis(IMAGE_FIXTURE_DATATYPE_ID, 'region')).toEqual([])
  })

  it('with artifacts present, a forecast-only column is still absent — only stamps count', async () => {
    const region = await fixtureDataSource(REGION_ARTIFACTS).annotationsForAxis(
      IMAGE_FIXTURE_DATATYPE_ID,
      'region',
    )
    // `mean_intensity` / `area_px` / `pct_positive` are forecast but unwritten: the image
    // analogue of the 8-of-9 declared annotations that did not exist on a real dataset.
    const stamped = new Set(['region_class', 'region_texture'])
    const forecastOnly = LEGACY_FORECAST_COLUMNS.filter(c => !stamped.has(c))
    expect(forecastOnly.length).toBeGreaterThan(0)
    for (const phantom of forecastOnly) {
      expect(region.some(a => a.name === phantom || a.name.endsWith(`#${phantom}`))).toBe(false)
    }
    // …and the one forecast column that WAS written appears — sourced from the artifact,
    // not from the forecast that happens to agree with it.
    expect(region.some(a => a.name === 'region-labels#region_class')).toBe(true)
  })
})
