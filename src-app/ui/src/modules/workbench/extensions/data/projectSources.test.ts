// projectSources.test.ts — ITEM-42's move, and the ONE property the move exists for.
//
// `canvasDataSource.test.ts` (ITEM-8, deliberately UNEDITED) pins that the memo returns one
// instance per `(handle, project)`. It CANNOT see the property this file is about, because it
// passes identity-only handles: that two consumers holding DIFFERENT `WorkbenchAPI` objects over
// the SAME broker reach the SAME source.
//
// That is not hypothetical. `createWorkbenchApi(host, extensionId)` mints a new handle per
// extension while `capabilitiesFor(host)` memoizes ONE broker per host, so a handle-keyed memo
// hands two consumers of one project two sources — two multicasts, two decodes, the "second byte
// path" DEC-20 forbids. The capability's columnar read (ITEM-42) is exactly such a second
// consumer, so this is the assertion the unification rests on.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@ziee/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import { statSync } from 'node:fs'
import path from 'node:path'
import { datatypeRegistry, type Datatype } from '@/core/datatypes'
import type { WorkbenchAPI } from '@/modules/workbench/core'
// The broker implementation, reached DIRECTLY: a test file is exempt from the layer guard
// (`lint-layer-boundary.mjs::isExempt`), and the ITEM-13 cases below need a real broker to
// publish a `data` capability into — a stand-in would resolve to nothing and the source's
// lazy `getCatalog` would throw before it ever mapped a row.
import { createCapabilityBroker } from '@/modules/workbench/core/capabilities/broker'
import type { ArtifactRow } from './contract'
import type { Artifact as WireArtifact } from '@/api-client/types'
import { toArtifactRow } from './dataHost'
import {
  buildProjectDataSource,
  buildProjectSources,
  toDataPlaneArtifact,
  __resetProjectSourcesForTests,
} from './projectSources'

/** A broker STAND-IN with the right identity and nothing else — no case here resolves a
 *  capability (the control-plane read is lazy, inside `getCatalog`). The subject is which
 *  INSTANCE comes back. */
function fakeBroker(): WorkbenchAPI['capabilities'] {
  return {} as WorkbenchAPI['capabilities']
}

function handleOn(broker: WorkbenchAPI['capabilities']): WorkbenchAPI {
  return { capabilities: broker } as WorkbenchAPI
}

describe('ITEM-42 — the memo is keyed on the BROKER, so a second consumer joins rather than forks', () => {
  it('two DIFFERENT handles over ONE broker reach the SAME source', () => {
    const broker = fakeBroker()
    const canvasHandle = handleOn(broker)
    const capabilityHandle = handleOn(broker)
    __resetProjectSourcesForTests(canvasHandle)
    // Distinct objects — otherwise this asserts nothing about the KEY.
    expect(capabilityHandle).not.toBe(canvasHandle)

    const a = buildProjectSources(canvasHandle, 'p1')
    const b = buildProjectSources(capabilityHandle, 'p1')
    // Identity. Two structurally-identical sources share no cache and no in-flight multicast, so
    // this is the difference between one decode and two for every column both consumers read.
    expect(b.streaming).toBe(a.streaming)
    expect(b.pull).toBe(a.pull)
  })

  it('a DIFFERENT broker still gets a cold source — sharing is per plane, not global', () => {
    const one = handleOn(fakeBroker())
    const two = handleOn(fakeBroker())
    __resetProjectSourcesForTests(one)
    __resetProjectSourcesForTests(two)
    // The non-vacuity half of the case above: if the memo had simply become global, that case
    // would pass while this one — two genuinely different data planes — wrongly shared a cache.
    expect(buildProjectSources(two, 'p1').streaming).not.toBe(
      buildProjectSources(one, 'p1').streaming,
    )
  })

  it('a DIFFERENT project on the same broker gets a cold source', () => {
    const handle = handleOn(fakeBroker())
    __resetProjectSourcesForTests(handle)
    const p1 = buildProjectSources(handle, 'p1')
    const p2 = buildProjectSources(handle, 'p2')
    // Every artifact id changes with the project, so serving p2 out of p1's cache would hand back
    // another project's bytes.
    expect(p2.streaming).not.toBe(p1.streaming)
    expect(buildProjectSources(handle, 'p1').streaming).toBe(p1.streaming)
  })

  it('a handle with NO broker is its own key — the identity-only fallback', () => {
    // What keeps ITEM-8's memoization test meaningful after the move: two bare handles carry no
    // broker to share, so they must not collapse onto one another (they would, under a naive
    // `handle.capabilities` key, since both read `undefined`).
    const a = {} as WorkbenchAPI
    const b = {} as WorkbenchAPI
    __resetProjectSourcesForTests(a)
    __resetProjectSourcesForTests(b)
    expect(buildProjectSources(b, 'p1').streaming).not.toBe(buildProjectSources(a, 'p1').streaming)
    expect(buildProjectSources(a, 'p1').streaming).toBe(buildProjectSources(a, 'p1').streaming)
  })
})

// ── ITEM-13 — the MAPPER is a seam, and a seam that drops a field is invisible from above ──
//
// `buildProjectDataSource`'s `getCatalog` projects each `ArtifactRow` from the `data`
// capability down to a `DataPlaneArtifact`, and that projection is the ONE hop every
// production read of the project catalog crosses. It used to emit `{id, datatype, structure}`,
// which was not merely incomplete — it silently disabled shipped behaviour:
// `DataPlaneArtifact.meta`'s own doc-comment names `meta.name` as "the key `columnLabel` is
// looked up by", and the field never arrived, so that override could not fire in any real
// project. ITEM-13 would have been inert in exactly the same way: `meta.component_columns` is
// the producer's declaration of a layout's two component columns and `dataset_id` is the scope
// they are resolved in.
//
// EVERY unit test of `catalog()` hand-builds its own `DataPlaneArtifact` and therefore cannot
// see this — the fixture simply asserts the field it was given. Only a case driven through the
// real mapper can, which is precisely why the gap existed and why this case is here.
describe('ITEM-13 — the catalog mapper carries `meta` and `dataset_id`, not just the decode contract', () => {
  const DATASET = 'ds-alpha'
  const ROW_AXIS = 'positions'
  const N = 4

  /** A `Datatype` the REAL registry accepts, declaring the capabilities the catalog channels
   *  dispatch on. `buildProjectDataSource` does NOT override `hasCapability`/`rowAxisFor`, so
   *  the classification here runs through `defaultDeps()`'s registry lookup exactly as the
   *  running app's does — which is half of what makes this a runtime-path proof. */
  const demoDatatype = (id: string, capabilities: string[]): Datatype =>
    ({
      id,
      extends: null,
      title: id,
      description: id,
      storage: { layout: { kind: 'chunked_dense' }, format: 'zarr', selector_map: {}, file_layout: 'single', tiers: [] },
      capabilities,
      axes: [{ name: ROW_AXIS, key_label: ROW_AXIS }],
      entity_axis: ROW_AXIS,
      viewers: [],
      converters: [],
      is_abstract: false,
    }) as unknown as Datatype

  /** One catalog row as the `data` capability delivers it — an `ArtifactRow`, which is what
   *  `dataHost.ts::toArtifactRow` mints from the wire. */
  const artifactRow = (over: Partial<ArtifactRow> & { id: string }): ArtifactRow => ({
    project_id: 'p1',
    datatype: 'demo/column',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ROW_AXIS,
      n: N,
      columns: [{ path: 'values', kind: 'numeric', dtype: 'float32', shape: [N], n: N }],
    },
    created_at: '2026-01-01T00:00:00Z',
    dataset_id: DATASET,
    ...over,
  })

  /** The gathered layout: ONE 1-D `values` column, empty `arrays`, and the producer's
   *  declaration surviving in `meta` — the shape a narrowing actually mints. */
  const layoutRow = artifactRow({
    id: 'lay',
    datatype: 'demo/layout',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ROW_AXIS,
      n: N,
      columns: [{ path: 'values', name: 'values', kind: 'numeric', dtype: 'float32', shape: [N], n: N }],
      arrays: [],
      data_type: 'float32',
      gathered_from: { artifact_id: 'source-1', mask_len: 9 },
    },
    meta: { component_columns: ['c_one', 'c_two'] },
  })
  const ROWS: ArtifactRow[] = [
    layoutRow,
    artifactRow({ id: 'col-x', meta: { name: 'c_one' } }),
    artifactRow({ id: 'col-y', meta: { name: 'c_two' } }),
  ]

  /** A broker publishing a `data` capability over `ROWS`, and the source built on it — the
   *  real `buildProjectDataSource`, so the projection under test is the shipped one. */
  function sourceOverRows() {
    datatypeRegistry.replaceAll([
      ...datatypeRegistry.all().filter(t => t.id !== 'demo/layout' && t.id !== 'demo/column'),
      demoDatatype('demo/layout', ['rows-aligned', 'plottable-xy']),
      demoDatatype('demo/column', ['rows-aligned', 'continuous-column']),
    ])
    const broker = createCapabilityBroker()
    broker.publish('data', '1.0.0', {
      catalog: async () => ({
        project_id: 'p1',
        axes: [{ content_hash: 'h-rows', name: ROW_AXIS, length: N }],
        artifacts: ROWS,
      }),
      artifacts: { query: async () => ROWS },
    } as never)
    return buildProjectDataSource({ capabilities: broker }, 'p1')
  }

  it('a declared layout reaches `catalog()` with its components RESOLVED, through the real mapper', async () => {
    // The end-to-end statement: the producer's `meta.component_columns` and the `dataset_id`
    // the join is scoped by both survive the hop, so the layout is served as two continuous
    // columns rather than as an unservable interleaved read. A mapper that drops either field
    // turns this red — which a hand-built `DataPlaneArtifact` fixture cannot do.
    const cat = await sourceOverRows().catalog()
    const layout = cat.layouts.find(l => l.id === 'lay')
    expect(layout?.components).toEqual(['col-x', 'col-y'])
  })

  it('and each column reaches it under the PRODUCER’S declared name (the latent inertness)', async () => {
    // `meta.name` is the key the per-column label override is looked up by, and it was being
    // dropped at this same hop — so the override could not fire in any real project. Stated as
    // its own case because it is a SECOND thing the mapper was silently disabling, not a
    // side-effect of the one above.
    const annotations = await sourceOverRows().annotationsForAxis('demo/column', ROW_AXIS)
    expect(annotations.filter(a => a.type === 'continuous').map(a => a.column).sort()).toEqual([
      'c_one',
      'c_two',
    ])
  })
})

// ── #159 TEST-16 — the object's LENGTH survives both mapper hops ─────────────────────────────
//
// Same seam, same failure class as ITEM-13 above, and stated separately because it is a
// DIFFERENT field with a different consumer: a pyramidal raster is opened over byte RANGES, and
// a range reader has to know where the object ends before it can address its last block. A
// field dropped at either hop is silently `undefined` at every consumer, and both ways that
// shows up are invisible from a rendered picture — an unclamped read of the final block is a
// 416, and a defaulted 0 reads nothing at all.
describe('#159 TEST-16 / #259 TEST-8 — `stored_bytes` survives wire → row → data plane', () => {
  /**
   * The hires OME-TIFF fixture's own on-disk length, READ from it (#259 TEST-8).
   *
   * Three lines of this block carried the bare literal 167778 with nothing saying which file it
   * came from. It came from
   * `libs/viz/src/viz-core/spatial/fixtures/spatial-image-hires.ome.tif`, and #227's tiling
   * changed what the writer emits, so #259's regeneration moved that artifact to 166,838 bytes.
   * NOTHING would have gone red: to the projection under test the literal is only a plausible
   * number, which is exactly why a value that has stopped describing anything can sit here
   * indefinitely. Using a REAL artifact's length is deliberate — the hop under test is the one a
   * range reader addresses the object's last block against — so it is read from the artifact
   * rather than transcribed from it, and cannot desynchronise again.
   */
  const HIRES_STORED_BYTES = statSync(
    path.resolve(
      process.cwd(),
      '../libs/viz/src/viz-core/spatial/fixtures/spatial-image-hires.ome.tif',
    ),
  ).size

  /** A row typed as the GENERATED wire type, so this fixture cannot express a field the
   *  endpoint does not actually deliver — the same discipline the shipped-form conformance
   *  tier applies. */
  const wireRow: WireArtifact = {
    id: 'blob-1',
    project_id: 'p1',
    datatype: 'demo/opaque',
    structure: { encoding: 'opaque', media_type: 'image/tiff; application=ome' },
    meta: { to_space: [5, 0, 0, 0, 5, 0] },
    content_hash: 'h1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    hidden: false,
    is_multifile: false,
    output_id: 'raster',
    role: 'artifact',
    status: 'ready',
    stored_bytes: HIRES_STORED_BYTES,
  }

  it('hop 1 — the wire row → `ArtifactRow`', () => {
    expect(toArtifactRow(wireRow).stored_bytes).toBe(HIRES_STORED_BYTES)
    // …and the hop is a PASS-THROUGH, not a constant that happens to agree. With the row's
    // value and the expectation both derived from the same fixture, the assertion above is an
    // identity over one number and would survive `stored_bytes` being hardcoded, dropped to a
    // default, or read from somewhere else entirely. A second, deliberately DIFFERENT value is
    // what separates "the field survives the hop" from "the field equals the fixture's size".
    const other = { ...wireRow, stored_bytes: HIRES_STORED_BYTES + 1 }
    expect(toArtifactRow(other).stored_bytes).toBe(HIRES_STORED_BYTES + 1)
    expect(toArtifactRow(other).stored_bytes).not.toBe(toArtifactRow(wireRow).stored_bytes)
  })

  it('hop 2 — `ArtifactRow` → `DataPlaneArtifact`, through the shipped projection', () => {
    const row = toDataPlaneArtifact(toArtifactRow(wireRow))
    expect(row.stored_bytes).toBe(HIRES_STORED_BYTES)
    // The same non-identity control on the second hop.
    const other = toDataPlaneArtifact(toArtifactRow({ ...wireRow, stored_bytes: 1 }))
    expect(other.stored_bytes).toBe(1)
    // The placement rides the same hop, uncompacted. Six elements is exactly the length a
    // summary-row projection drops, so a five-or-fewer result here would mean the catalog is
    // being fed from the wrong endpoint.
    expect((row.meta as { to_space: number[] }).to_space).toHaveLength(6)
  })

  it('and the projection is the one production uses — not a parallel copy', async () => {
    // The non-vacuity half: the two cases above test a named function, so this one proves that
    // function is what `buildProjectDataSource` actually runs. The observable is `structure`
    // reaching `structureFor()`, which only the real `getCatalog` path can supply.
    const broker = createCapabilityBroker()
    broker.publish('data', '1.0.0', {
      catalog: async () => ({ project_id: 'p1', axes: [], artifacts: [toArtifactRow(wireRow)] }),
      artifacts: { query: async () => [toArtifactRow(wireRow)] },
    } as never)
    const source = buildProjectDataSource({ capabilities: broker }, 'p1')

    // THE OBSERVABLE HAS TO SEPARATE THREE STATES, and `hasImage: false` does not. It is equally
    // what you get when the row never reached discovery, when the media type did not match, and
    // when the row DID reach discovery and the open failed. The distinguishing evidence is the
    // WARNING, which is only reachable from the last of the three — the code path that has
    // already selected this row and gone on to open it.
    const warnings: unknown[][] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args)
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cat = await source.catalog()
      expect(cat.datasetId).toBe('p1')
      // There is no transport in this runner, so the open fails — which is the point: reaching
      // the failure at all proves the row was selected as a raster candidate, which it can only
      // be if `structure` survived both mapper hops.
      expect(cat.hasImage).toBe(false)
      expect(
        warnings.some(w => String(w[0]).includes('raster')),
        'the row must have REACHED discovery — a row filtered out earlier produces the same ' +
          '`hasImage: false` and says nothing',
      ).toBe(true)
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
