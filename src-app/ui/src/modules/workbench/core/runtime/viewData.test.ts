import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ViewSpec, ScatterWidget } from '@/modules/workbench/core/manifest/viewSpec'

// The ONE external boundary these tests mock: the artifact byte read — which since
// ITEM-29 is the TYPED surface `readColumn({expect: 'table'})`, not `readTable` directly.
// Everything above it (classifier → aggregator → store landing) is the real code path.
// `importOriginal` keeps the rest of the module real, including the `readTable` the
// cross-language decode block below calls DIRECTLY against on-disk fixtures.
const readerMock = vi.hoisted(() => ({ readColumn: vi.fn() }))
vi.mock('@/core/workstore', async importOriginal => ({
  ...(await importOriginal<typeof import('@/core/workstore')>()),
  readColumn: readerMock.readColumn,
}))

import {
  beginViewDataLanding,
  columnarFromTable,
  dataArgsRequestKey,
  landedData,
  landViewDataChunk,
  readSliceFromApi,
  resolveAndApplyViewData,
  resolveViewData,
  retryViewData,
  RESOLVED_SOURCES,
  VIEW_DATA_TIMEOUT_MS,
  __resetViewDataForTests,
  __resetEntryKeysForTests,
} from './viewData'
import type { DataSourceSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import { makeColumnarFrameReader } from '@/modules/workbench/extensions/data/columnarRead'
import { paneScopeStore } from './paneScope.store'
import { NO_COORDINATE_REFUSAL } from './rowSpaceColumns'
import { PANE_FRAME_SOURCE } from './paneFrame'
import { COLUMN_VALUES_SOURCE } from './columnValues'
// The `@/core/workstore` BARREL is mocked above, so the real decode is imported from the
// concrete modules — otherwise the cross-language block below would assert against the
// mock and prove nothing.
import { memoryStore } from '@/core/workstore/zarrReader'
import { categories_by_column, keep_mask } from './primitives'
import { isColumn } from '../columns/columnCoerce'
import { parseStructure, readColumnarTable, readTable as decodeTable } from '@/core/workstore/artifactReader'
import { resolveDeclarativeCanvas } from '@/modules/workbench/extensions/canvas/canvasFeed'
import { aggregateDataStatus, sliceDatatype } from './dataStatus'
import { createViewStore } from './store'
import { getViewStore, registerViewStore, __resetViewStoresForTests } from './viewStores'
import { buildScatterOption, buildScatterSource, FrameDataSource } from '@/modules/workbench/extensions/canvas/viz'
import type { Scope } from './expr'

// DRIFT-3.5 — the job-result DATA RESOLVER seam: a `view_spec`'s `data.rowmeta = { source:
// job.result, args: { path: /rowmeta } }` declaration resolves (via an injected reader, no
// backend) into the columnar `/rowmeta` slice, which the scatter data source /
// `buildScatterOption` decode into the `@txresbench/viz` `VizOption` + source the center scatter
// paints from.

/** A resolved slice in the shape the reader ACTUALLY mints — a bare columnar
 *  `{ column: values[] }` record (`columnarFromArrowTable`'s only possible output). The
 *  fixture used to be the retired wrapped `{ columns, rowmeta: {…}, … }` artifact blob, which no
 *  reader can produce since the S6 Arrow migration; testing the resolver against a shape
 *  production cannot deliver is what kept the dead unwrap arm looking alive (C7). */
const ROWMETA_SLICE: Record<string, unknown[]> = {
  id: ['r1', 'r2', 'r3', 'r4'],
  label_a: ['g1', 'g1', 'g2', 'g2'],
  metric_total: [1000, 2000, 3000, 500],
  metric_y: [300, 600, 900, 150],
  metric_a: [2, 5, 8, 40],
}

// FE3 (INV-6) — the slice datatype comes from the view's DECLARED `data.<slice>.args.datatype`,
// NOT a hardcoded `demo/report`; a slice declaring no datatype resolves nothing (renders structure).
describe('sliceDatatype (FE3, INV-6 — declared datatype, not hardcoded demo/report)', () => {
  it('reads the declared `args.datatype`', () => {
    const decl: DataSourceSpec = { source: 'job.result', args: { path: '/rowmeta', datatype: 'demo/clustering' } }
    expect(sliceDatatype(decl)).toBe('demo/clustering')
  })
  it('a slice with no declared datatype → undefined (resolves nothing, no hardcoded fallback)', () => {
    expect(sliceDatatype({ source: 'job.result', args: { path: '/rowmeta' } })).toBeUndefined()
    expect(sliceDatatype({ source: 'job.result' })).toBeUndefined()
  })
  it('honors a NON-demo/report datatype (a different analysis processor resolves its OWN type)', () => {
    expect(sliceDatatype({ source: 'job.result', args: { datatype: 'annotation' } })).toBe('annotation')
  })
})

// artifact-model ITEM-25/29 — the rowmeta slice is read with `readColumn({expect: 'table'})`,
// whose `table` arm is `readTable`: it opens the artifact's DECLARED Zarr members and
// range-reads each column's chunks.
// `columnarFromTable` transposes the row-major table back to the columnar
// `{ col: values[] }` slice the widgets read.
//
// Proven against the fixture tree the PYTHON writer produced (`txr_zarr.Table` →
// `src/core/workstore/__fixtures__/zarr/table`), decoded through the REAL shipped reader
// with the fixture files served as a `memoryStore` — the exact `{ path → bytes }` shape
// `/data/{*member}` serves. So this is a cross-language byte-parity check of the whole
// rowmeta path, not a round-trip against a stub we also wrote.
const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '../../../../core/workstore/__fixtures__/zarr')

function loadTree(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.set(relative(root, full).split(sep).join('/'), new Uint8Array(readFileSync(full)))
    }
  }
  walk(root)
  return files
}

describe('columnarFromTable (ITEM-25 rowmeta wire — a REAL Zarr decode of the Python writer\'s bytes)', () => {
  it('transposes a decoded Zarr table back to the columnar slice the widgets read', async () => {
    const tree = loadTree(join(FIXTURES, 'table'))
    const groupMeta = JSON.parse(new TextDecoder().decode(tree.get('zarr.json')!)) as {
      attributes: { txr: unknown }
    }
    // The producer stamps the SAME `structure` document into the group's `zarr.json` and
    // into the artifact row, so reading it here reads what production reads.
    const structure = parseStructure('fixture', groupMeta.attributes.txr)
    const table = await decodeTable('fixture', structure, { store: memoryStore(tree) })
    const slice = columnarFromTable(table)

    // Every declared member surfaces as a column of ARRAYS — the same columnar shape the
    // retired `{rowmeta:{col:[…]}}` JSON path and the retired Arrow path both produced.
    expect(Object.keys(slice).sort()).toEqual(['cat16', 'cat8', 'f32col', 'str'])
    expect(Object.values(slice).every(Array.isArray)).toBe(true)
    expect(slice.f32col).toHaveLength(500)

    // A categorical decodes to its LABELS via the DECLARED level set — including the
    // non-ASCII one, which is what makes this a byte-parity claim and not a shape claim.
    expect(slice.cat8.slice(0, 4)).toEqual(['group-A', '', 'café ☕', 'group-B'])
    // …and a numeric column to real numbers the widgets can scale.
    expect(slice.f32col[0]).toBeCloseTo(-3.25, 6)

    // …and it feeds the scatter source identically (positions interleave x×y).
    const scope: Scope = { params: {}, state: {}, derived: {}, const: {}, data: { rowmeta: slice } }
    const w: ScatterWidget = {
      kind: 'scatter',
      id: 'metricScatter',
      frame: '$data.rowmeta',
      encode: { x: 'f32col', y: 'f32col', colorBy: 'f32col', groupBy: 'cat8' },
    }
    expect(buildScatterSource(w, scope)).toBeInstanceOf(FrameDataSource)
  })

  it('an empty table → an empty columnar slice (region renders structure)', () => {
    expect(columnarFromTable({ columns: ['metric_total'], rows: [] })).toEqual({ metric_total: [] })
  })
})

describe('resolveViewData (DRIFT-3.5) → the store `$data`', () => {
  const spec = {
    id: 'demo.filter/interactive',
    data: {
      rowmeta: { source: 'job.result', args: { path: '/rowmeta' } },
      extra: { source: 'job.result', args: { path: '/extra' } },
    },
  } as unknown as ViewSpec

  it('resolves the job.result `/rowmeta` slice; an absent slice (extra) is omitted', async () => {
    const res = await resolveViewData(spec, async key =>
      key === 'rowmeta' ? { status: 'ready', payload: ROWMETA_SLICE } : undefined,
    )
    expect(Object.keys(res.data)).toEqual(['rowmeta'])
    // Pass-through: the resolver lands the reader's payload by IDENTITY (C7 — no unwrapping).
    expect(res.data.rowmeta).toBe(ROWMETA_SLICE)
    expect(res.status).toBe('ready')
  })

  it('the resolved `/rowmeta` slice feeds the scatter data source + `VizOption` the center paints', async () => {
    const { data } = await resolveViewData(spec, async () => ({ status: 'ready', payload: ROWMETA_SLICE }))
    const scope: Scope = { params: {}, state: {}, derived: {}, const: {}, data }
    const w: ScatterWidget = {
      kind: 'scatter',
      id: 'metricScatter',
      frame: '$data.rowmeta',
      encode: { x: 'metric_total', y: 'metric_y', colorBy: 'metric_a', groupBy: 'label_a' },
    }

    // the source decodes the resolved slice: metric layout interleaves x×y, categorical labels.
    const src = buildScatterSource(w, scope)
    expect(src).toBeInstanceOf(FrameDataSource)
    const pos = await src.positions('metric')
    expect(pos.length).toBe(4)
    expect(Array.from(pos.positions.slice(0, 2))).toEqual([1000, 300])
    const cat = await src.categorical('label_a')
    expect(cat.categories).toEqual(['g1', 'g2'])

    // the option binds the continuous colorBy the resolved slice carries.
    const option = buildScatterOption(w, scope)
    expect(option.series[0].encode?.colorBy).toEqual({ mode: 'continuous', key: 'metric_a' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// declarative-rendering-hardening Slice 2 (F3) — the failure-surface vocabulary.
//
// The engine used to collapse "the fetch FAILED" and "there is genuinely nothing yet" into
// the same `undefined`, so a backend-down region was pixel-identical to an untouched
// project. These tests pin the classification, the worst-of aggregation, and the
// terminal-status guarantee that keeps a region from being stuck on a skeleton.
// ─────────────────────────────────────────────────────────────────────────────

const DECL: DataSourceSpec = { source: 'job.result', args: { path: '/rowmeta', datatype: 'demo/report' } }

/** A minimal WorkbenchAPI stub. The resolver reaches the catalog through the CAPABILITY
 *  BROKER now (ITEM-6), so the stub publishes a fake `data` implementation under that id
 *  and the resolver resolves it exactly as it does in production. */
function fakeApi(over: { query?: () => Promise<unknown[]>; catalog?: () => Promise<unknown> }): WorkbenchAPI {
  const capabilities = createCapabilityBroker()
  capabilities.publish('data', '1.0.0', {
    artifacts: { query: over.query ?? (async () => []) },
    // The CONTROL plane. A slice that decides its read strategy from a DECLARED length reads
    // it here, before any byte is opened, so a fake that omits it cannot exercise that arm.
    catalog: over.catalog ?? (async () => ({ axes: [] })),
  })
  return { capabilities } as unknown as WorkbenchAPI
}

const ARTIFACT = {
  id: 'a1',
  datatype: 'demo/report',
  created_at: '2026-01-01T00:00:00Z',
  // ITEM-25: the read dispatches on the row's DECLARED structure, so the stub row carries one.
  structure: { encoding: 'zarr_v3', kind: 'table', columns: [{ path: 'metric_total', kind: 'numeric' }] },
}

/** The wire shape `readColumn({expect: 'table'})` yields, at the MOCKED byte boundary.
 *  Hand-built is correct
 *  here: these tests are about the classifier/aggregator/store above the read, and the
 *  decode itself is proven for real against the Python fixtures above. */
function tableWith(rows: number): { columns: string[]; rows: unknown[][] } {
  return {
    columns: ['metric_total'],
    rows: Array.from({ length: rows }, (_, i) => [i * 10]),
  }
}

beforeEach(() => {
  readerMock.readColumn.mockReset()
  __resetViewDataForTests()
  __resetViewStoresForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// TEST-1 (ITEM-1)
describe('readSliceFromApi — classifies error vs genuine no-data (F3)', () => {
  it('a throwing artifacts.query → error, carrying the message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await readSliceFromApi(
      fakeApi({
        query: async () => {
          throw new Error('403 Forbidden')
        },
      }),
      'rowmeta',
      DECL,
    )
    expect(res?.status).toBe('error')
    expect(res?.error).toContain('403 Forbidden')
    expect(res?.error).toContain('rowmeta')
    errSpy.mockRestore()
  })

  it('a throwing Arrow /read → error, carrying the message', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    readerMock.readColumn.mockRejectedValue(new Error('connection refused'))
    const res = await readSliceFromApi(fakeApi({ query: async () => [ARTIFACT] }), 'rowmeta', DECL)
    expect(res?.status).toBe('error')
    expect(res?.error).toContain('connection refused')
    errSpy.mockRestore()
  })

  it('NO artifact of the declared datatype → empty (expected, not a fault)', async () => {
    const res = await readSliceFromApi(fakeApi({ query: async () => [] }), 'rowmeta', DECL)
    expect(res).toEqual({ status: 'empty' })
    expect(readerMock.readColumn).not.toHaveBeenCalled()
  })

  it('a served table with ZERO rows → empty', async () => {
    readerMock.readColumn.mockResolvedValue(tableWith(0))
    const res = await readSliceFromApi(fakeApi({ query: async () => [ARTIFACT] }), 'rowmeta', DECL)
    expect(res).toEqual({ status: 'empty' })
  })

  it('a populated table → ready, with the transposed columnar payload', async () => {
    readerMock.readColumn.mockResolvedValue(tableWith(3))
    const res = await readSliceFromApi(fakeApi({ query: async () => [ARTIFACT] }), 'rowmeta', DECL)
    expect(res?.status).toBe('ready')
    expect(res?.payload).toEqual({ metric_total: [0, 10, 20] })
  })

  it('a slice declaring NO datatype is SKIPPED entirely (contributes no status)', async () => {
    const res = await readSliceFromApi(fakeApi({}), 'rowmeta', { source: 'job.result', args: { path: '/rowmeta' } })
    expect(res).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C7 — the WRAPPED-`{rowmeta:{…}}` UNWRAP ARM IS STRUCTURALLY UNREACHABLE.
//
// This is the risk control for deleting the retired wrapped-payload type + its slice
// extractor. The deleted unwrap arm only ever fired when a slice payload carried a key
// NAMED FOR THE SLICE (here `rowmeta`) holding a
// PLAIN OBJECT. Every payload is minted by exactly one expression — `columnarFromTable`,
// which assigns `out[name] = table.rows.map(…)`. `.map()` returns an ARRAY for every
// column, and the retired `isColumnarObject` guard rejected arrays (`!Array.isArray`). So
// no payload reaching the resolver could ever have satisfied the unwrap arm.
//
// The adversarial case: an artifact holding a column whose name COLLIDES with the slice's
// own (`rowmeta`) — the closest the wire can come to re-creating the retired
// `{<slice>:{col:[…]}}` JSON blob. Built as a
// real Zarr store and decoded through the REAL `readTable`, so the claim rests on what
// the shipped reader actually produces rather than on a stub we also wrote.
//
// ITEM-25 made this case STRICTLY harder to construct, which is itself worth recording:
// the old Arrow wire could carry a Struct column whose ELEMENTS were objects, and that was
// the adversarial input. A Zarr member is a typed array or an arrow-layout string array —
// there is no element type that is an object — so the object-valued element is now
// unreachable at the format level, not merely unreachable through the transposition.
//
// Phrased against `readSliceFromApi`'s payload and `resolveViewData`'s LANDED slice — never
// against the deleted symbols — so it holds identically before and after the deletion, and
// FAILS loudly if an unwrap ever creeps back in (it would land `payload.rowmeta`, not `payload`).
// ─────────────────────────────────────────────────────────────────────────────
describe('C7 — readSliceFromApi yields a BARE columnar payload (the `{rowmeta:{…}}` unwrap arm is dead)', () => {
  /** A RAW (uncompressed, unsharded) Zarr v3 float64 column as `{ path → bytes }`. Raw
   *  rather than shuffle+gzip so the fixture is hand-laid and obvious; the reader's
   *  empty-codec-chain path decodes it through exactly the same code as a compressed one. */
  function rawZarrColumn(name: string, values: number[]): Record<string, Uint8Array> {
    const meta = {
      zarr_format: 3,
      node_type: 'array',
      shape: [values.length],
      data_type: 'float64',
      chunk_grid: { name: 'regular', configuration: { chunk_shape: [values.length] } },
      chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
      fill_value: 0,
      codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
      attributes: {},
    }
    return {
      [`${name}/zarr.json`]: new TextEncoder().encode(JSON.stringify(meta)),
      [`${name}/c/0`]: new Uint8Array(Float64Array.from(values).buffer),
    }
  }

  /** A REAL decode of an artifact whose members include one literally named `rowmeta`. */
  async function tableWithSliceNamedColumn() {
    const files = { ...rawZarrColumn('rowmeta', [1, 2, 3]), ...rawZarrColumn('metric_total', [10, 20, 30]) }
    const structure = parseStructure('adversarial', {
      encoding: 'zarr_v3',
      kind: 'table',
      columns: [
        { path: 'rowmeta', kind: 'numeric' },
        { path: 'metric_total', kind: 'numeric' },
      ],
    })
    return decodeTable('adversarial', structure, { store: memoryStore(files) })
  }

  it('an artifact with a column NAMED `rowmeta` still transposes to a bare columnar payload', async () => {
    readerMock.readColumn.mockResolvedValue(await tableWithSliceNamedColumn())
    const res = await readSliceFromApi(fakeApi({ query: async () => [ARTIFACT] }), 'rowmeta', DECL)

    expect(res?.status).toBe('ready')
    const payload = res?.payload as Record<string, unknown>

    // EVERY column transposes to an Array — the invariant that kills the unwrap arm.
    expect(Object.keys(payload).sort()).toEqual(['metric_total', 'rowmeta'])
    expect(Object.values(payload).every(Array.isArray)).toBe(true)

    // The negative control, stated explicitly: the `rowmeta` key is an ARRAY of the column's
    // per-row values — NOT the plain `Record<string, unknown[]>` the unwrap arm required.
    expect(Array.isArray(payload.rowmeta)).toBe(true)
    expect(payload.rowmeta).toHaveLength(3)
  })

  it('the PRODUCTION composition lands the payload UNCHANGED (pass-through, never unwrapped)', async () => {
    readerMock.readColumn.mockResolvedValue(await tableWithSliceNamedColumn())
    const api = fakeApi({ query: async () => [ARTIFACT] })
    const spec = { id: 'x/y', data: { rowmeta: DECL } } as unknown as ViewSpec

    // The EXACT reader composition production uses (`viewData.ts` — `resolveAndApplyViewData`
    // is the sole caller of `resolveViewData`, and it injects precisely this lambda).
    const captured: unknown[] = []
    const res = await resolveViewData(spec, async (key, decl) => {
      const r = await readSliceFromApi(api, key, decl)
      if (r?.status === 'ready') captured.push(r.payload)
      return r
    })

    // Identity, not equality: the resolver hands the reader's payload straight through. Had
    // the unwrap arm fired, this would be `payload.rowmeta` (a 3-element array) instead.
    expect(res.status).toBe('ready')
    expect(res.data.rowmeta).toBe(captured[0])
    expect(Object.keys(res.data.rowmeta as object).sort()).toEqual(['metric_total', 'rowmeta'])
  })

  it('a plain columnar payload (no `rowmeta` key at all) also lands unchanged', async () => {
    readerMock.readColumn.mockResolvedValue(tableWith(2))
    const api = fakeApi({ query: async () => [ARTIFACT] })
    const spec = { id: 'x/y', data: { rowmeta: DECL } } as unknown as ViewSpec
    const res = await resolveViewData(spec, (key, decl) => readSliceFromApi(api, key, decl))
    expect(res.data.rowmeta).toEqual({ metric_total: [0, 10] })
  })
})

// TEST-2 (ITEM-2)
describe('resolveViewData — worst-of status aggregation', () => {
  const twoSlices = {
    id: 'x/y',
    data: {
      a: { source: 'job.result', args: { datatype: 't1' } },
      b: { source: 'job.result', args: { datatype: 't2' } },
    },
  } as unknown as ViewSpec

  it('[error, ready] → error (a partial failure is still a failure the user must see)', async () => {
    const res = await resolveViewData(twoSlices, async key =>
      key === 'a' ? { status: 'error', error: 'boom' } : { status: 'ready', payload: { c: [1] } },
    )
    expect(res.status).toBe('error')
    expect(res.error).toBe('boom')
    // …and the slice that DID resolve is still baked, so the region keeps whatever it has.
    expect(Object.keys(res.data)).toEqual(['b'])
  })

  it('[empty, ready] → ready', async () => {
    const res = await resolveViewData(twoSlices, async key =>
      key === 'a' ? { status: 'empty' } : { status: 'ready', payload: { c: [1] } },
    )
    expect(res.status).toBe('ready')
  })

  it('[empty, empty] → empty', async () => {
    const res = await resolveViewData(twoSlices, async () => ({ status: 'empty' }))
    expect(res.status).toBe('empty')
    expect(res.data).toEqual({})
  })

  it('a spec whose slices are ALL skipped → ready (never a skeleton pinned forever, DEC-3)', async () => {
    const res = await resolveViewData(twoSlices, async () => undefined)
    expect(res.status).toBe('ready')
  })

  it('a spec declaring NO data at all → ready', async () => {
    const res = await resolveViewData({ id: 'x/y' } as unknown as ViewSpec, async () => undefined)
    expect(res.status).toBe('ready')
  })

  it('aggregateDataStatus is the pure rule behind it', () => {
    expect(aggregateDataStatus([]).status).toBe('ready')
    expect(aggregateDataStatus([{ status: 'empty' }]).status).toBe('empty')
    expect(aggregateDataStatus([{ status: 'empty' }, { status: 'ready' }]).status).toBe('ready')
    expect(aggregateDataStatus([{ status: 'ready' }, { status: 'error', error: 'e' }])).toEqual({
      status: 'error',
      error: 'e',
    })
  })

  // ITEM-1 — `unreadable` OUTRANKS `ready`, and that ranking IS the fix.
  //
  // The reported shape has exactly two slices: one resolves `ready` off the catalog rows
  // alone, the other reads bytes and cannot. Under `ready`-beats-everything the region
  // reported `ready` with nothing in the frame — a clean status over a blank form, and no
  // surface anywhere said why. Ranked below `error` because an outright resolve failure is
  // the stronger fault (and the one a retry is the whole answer to).
  it('[ready, unreadable] → unreadable (a status may not read clean over a blank it cannot explain)', async () => {
    const res = await resolveViewData(twoSlices, async key =>
      key === 'a'
        ? { status: 'ready', payload: { c: [1] } }
        : { status: 'unreadable', error: 'none of them could be read' },
    )
    expect(res.status).toBe('unreadable')
    expect(res.error).toBe('none of them could be read')
    // The slice that DID resolve is still baked — the region keeps what it has.
    expect(Object.keys(res.data)).toEqual(['a'])
  })

  it('[error, unreadable] → error (an outright resolve failure is the stronger fault)', async () => {
    const res = await resolveViewData(twoSlices, async key =>
      key === 'a' ? { status: 'error', error: 'boom' } : { status: 'unreadable', error: 'unread' },
    )
    expect(res).toMatchObject({ status: 'error', error: 'boom' })
  })

  it('[empty, unreadable] → unreadable (present-but-unreadable is not an emptiness)', async () => {
    const res = await resolveViewData(twoSlices, async key =>
      key === 'a' ? { status: 'empty' } : { status: 'unreadable', error: 'unread' },
    )
    expect(res.status).toBe('unreadable')
  })

  it('the worst-of order is error > unreadable > ready > empty, as a pure rule', () => {
    expect(aggregateDataStatus([{ status: 'unreadable' }]).status).toBe('unreadable')
    expect(aggregateDataStatus([{ status: 'ready' }, { status: 'unreadable', error: 'u' }])).toEqual({
      status: 'unreadable',
      error: 'u',
    })
    expect(
      aggregateDataStatus([{ status: 'unreadable', error: 'u' }, { status: 'error', error: 'e' }]),
    ).toEqual({ status: 'error', error: 'e' })
    expect(aggregateDataStatus([{ status: 'unreadable', error: 'u' }, { status: 'empty' }]).status).toBe(
      'unreadable',
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// ITEM-1 — the FRAME arm distinguishes "the axis carries nothing" from "the axis carries
// columns and none of them could be read".
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// `readAxisColumnsFrame` deliberately TOLERATES a per-artifact read failure: one column
// being unreadable must not blank a builder the other columns can still populate. That
// tolerance has an end nobody had named — when it consumes EVERY candidate, the frame comes
// back `{}` and the slice reported `empty`, i.e. "this dataset carries no measurements"
// about a dataset whose columns are sitting right there in the catalog.
describe('readSliceFromApi — axis_columns FRAME: present-but-unreadable is not empty', () => {
  const frameApi = (artifacts: unknown[]): WorkbenchAPI => {
    const capabilities = createCapabilityBroker()
    capabilities.publish('data', '1.0.0', {
      catalog: async () => ({ project_id: 'p1', axes: [], artifacts }),
      artifacts: { query: async () => artifacts },
    })
    return { capabilities } as unknown as WorkbenchAPI
  }
  const column = (id: string, name: string) => ({
    id,
    project_id: 'p1',
    datatype: 'demo/column',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds1',
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', columns: [{ name, kind: 'numeric' }] },
  })
  const anchor = {
    id: 'm1',
    project_id: 'p1',
    datatype: 'demo/matrix',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds1',
    structure: { kind: 'sparse_csc', axes: ['rows', 'cols'], shape: [2, 3] },
  }
  const frameDecl = { source: 'axis_columns', args: { of: '$state.ds', axis: 'rows' } } as DataSourceSpec
  const scope: Scope = { state: { ds: 'm1' } }

  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('EVERY column artifact present and none readable → unreadable, naming how many', async () => {
    readerMock.readColumn.mockRejectedValue(new Error('no bytes here'))
    const api = frameApi([anchor, column('a-one', 'metric_a'), column('a-two', 'metric_b')])
    const res = await readSliceFromApi(api, 'rowmeta', frameDecl, scope)
    expect(res?.status).toBe('unreadable')
    expect(res?.error).toContain('2 of the 2')
    // …and the developer-facing log survives: the user-facing status is the OTHER half.
    expect(errSpy).toHaveBeenCalled()
  })

  // The MIXED outcome: one source refuses, another reads cleanly and declares nothing, so
  // the frame is empty and the refusal is NOT total. `empty` is a positive claim about what
  // the host holds, and the refused source's contents are unknown — so the claim is
  // unsupported and the honest answer is still `unreadable`. (This window is why the first
  // predicate, `refused === opened`, was wrong: it survived mutation, and adopting the
  // weaker one is what killed it.)
  it('ONE refusal is enough when nothing landed — a partly-read axis is not an empty one', async () => {
    readerMock.readColumn.mockImplementation(async ({ id }: { id: string }) =>
      id === 'a-one' ? { columns: [], rows: [] } : Promise.reject(new Error('no bytes')),
    )
    const api = frameApi([anchor, column('a-one', 'metric_a'), column('a-two', 'metric_b')])
    const res = await readSliceFromApi(api, 'rowmeta', frameDecl, scope)
    expect(res?.status).toBe('unreadable')
    expect(res?.error).toContain('1 of the 2')
  })

  it('an axis carrying NO column artifact is still `empty` (nothing was attempted)', async () => {
    readerMock.readColumn.mockRejectedValue(new Error('never called'))
    const res = await readSliceFromApi(frameApi([anchor]), 'rowmeta', frameDecl, scope)
    expect(res).toEqual({ status: 'empty' })
  })

  it('a PARTIAL read failure still lands the columns that read — `ready`, not unreadable', async () => {
    readerMock.readColumn.mockImplementation(async ({ id }: { id: string }) =>
      id === 'a-one' ? { columns: ['metric_a'], rows: [[1], [2]] } : Promise.reject(new Error('no bytes')),
    )
    const api = frameApi([anchor, column('a-one', 'metric_a'), column('a-two', 'metric_b')])
    const res = await readSliceFromApi(api, 'rowmeta', frameDecl, scope)
    expect(res?.status).toBe('ready')
    expect(res?.payload).toEqual({ metric_a: [1, 2] })
  })

  it('a column that reads CLEANLY but declares no values is `empty`, not unreadable', async () => {
    // Nothing threw: the tolerance was never consumed, so this is an emptiness and the
    // sentence for an untouched project is the true one.
    readerMock.readColumn.mockResolvedValue({ columns: [], rows: [] })
    const api = frameApi([anchor, column('a-one', 'metric_a')])
    expect(await readSliceFromApi(api, 'rowmeta', frameDecl, scope)).toEqual({ status: 'empty' })
  })
})

// TEST-6 (ITEM-2 + ITEM-6)
describe('resolveAndApplyViewData / retryViewData — terminal status + retry', () => {
  const spec = {
    id: 'x/y',
    data: { rowmeta: { source: 'job.result', args: { datatype: 'demo/report' } } },
  } as unknown as ViewSpec

  function mountStore(viewId: string) {
    const store = createViewStore(spec, viewId)
    registerViewStore(viewId, store)
    return store
  }

  it('a store for a data-declaring spec starts `loading` (there IS something to wait for)', () => {
    const store = mountStore('v-loading')
    expect(store.dataStatus).toBe('loading')
    store.dispose()
  })

  it('success lands `ready` + the data (never leaves loading pinned)', async () => {
    readerMock.readColumn.mockResolvedValue(tableWith(2))
    const store = mountStore('v-ok')
    await resolveAndApplyViewData('v-ok', spec, fakeApi({ query: async () => [ARTIFACT] }))
    expect(store.dataStatus).toBe('ready')
    expect(store.data).toEqual({ rowmeta: { metric_total: [0, 10] } })
    store.dispose()
  })

  it('a per-slice failure lands `error` + the message (never leaves loading pinned)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = mountStore('v-err')
    await resolveAndApplyViewData(
      'v-err',
      spec,
      fakeApi({
        query: async () => {
          throw new Error('backend down')
        },
      }),
    )
    expect(store.dataStatus).toBe('error')
    expect(store.dataError).toContain('backend down')
    errSpy.mockRestore()
    store.dispose()
  })

  it('genuine no-data lands `empty` — distinguishable from the error above', async () => {
    const store = mountStore('v-empty')
    await resolveAndApplyViewData('v-empty', spec, fakeApi({ query: async () => [] }))
    expect(store.dataStatus).toBe('empty')
    expect(store.dataError).toBeUndefined()
    store.dispose()
  })

  // ITEM-1 — `unreadable` sits on the FAULT side of the authoritative/fault line with
  // `error`, not with `empty`. `empty` is a statement about what the host HOLDS and so
  // clears; a fault is a statement about this ATTEMPT and keeps whatever last resolved, or
  // the form loses every option it was offering the moment one read fails.
  //
  // Driven through `resolveAndApplyViewData` (not through a hand-rolled copy of its merge
  // expression): the landing rule is the thing under test, and a test that re-implements it
  // asserts against itself.
  it('an `unreadable` outcome KEEPS the slices a previous resolve had landed', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const axisSpec = {
      id: 'x/y',
      state: { ds: { type: 'string', default: 'm1' } },
      data: {
        frame: { source: 'axis_columns', args: { of: '$state.ds', axis: 'rows' } },
        ids: { source: 'axis_columns', args: { of: '$state.ds', axis: 'rows', as: 'sources' } },
      },
    } as unknown as ViewSpec
    const rows = [
      {
        id: 'm1',
        project_id: 'p1',
        datatype: 'demo/matrix',
        created_at: '2026-01-01T00:00:00Z',
        source_dataset_id: 'ds1',
        structure: { kind: 'sparse_csc', axes: ['rows', 'cols'], shape: [2, 3] },
      },
      {
        id: 'a-one',
        project_id: 'p1',
        datatype: 'demo/column',
        created_at: '2026-01-01T00:00:00Z',
        source_dataset_id: 'ds1',
        structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', columns: [{ name: 'metric_a', kind: 'numeric' }] },
      },
    ]
    const capabilities = createCapabilityBroker()
    capabilities.publish('data', '1.0.0', {
      catalog: async () => ({ project_id: 'p1', axes: [], artifacts: rows }),
      artifacts: { query: async () => rows },
    })
    const api = { capabilities } as unknown as WorkbenchAPI

    const store = createViewStore(axisSpec, 'v-unreadable-keep')
    registerViewStore('v-unreadable-keep', store)
    store.setData({ frame: { metric_a: [1, 2] }, ids: { metric_a: 'stale' } }, 'ready')

    readerMock.readColumn.mockRejectedValue(new Error('no bytes'))
    await resolveAndApplyViewData('v-unreadable-keep', axisSpec, api)

    expect(store.dataStatus, 'the frame was found and refused').toBe('unreadable')
    // The ids slice re-resolved off the catalog; the frame the reads could not land is the
    // one a previous resolve left behind, NOT dropped.
    expect(store.data).toEqual({ frame: { metric_a: [1, 2] }, ids: { metric_a: 'a-one' } })
    errSpy.mockRestore()
    store.dispose()
  })

  it('a throw from the resolver ITSELF still lands a terminal `error`', async () => {
    const store = mountStore('v-throw')
    // `spec.data` is a getter that throws → `resolveViewData` itself blows up.
    const hostileSpec = { id: 'x/y', get data(): never { throw new Error('spec exploded') } } as unknown as ViewSpec
    await resolveAndApplyViewData('v-throw', hostileSpec, fakeApi({}))
    expect(store.dataStatus).toBe('error')
    expect(store.dataError).toContain('spec exploded')
    store.dispose()
  })

  it('retryViewData clears the in-flight guard, flips to loading, and RE-HITS the host', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = mountStore('v-retry')
    let calls = 0
    const api = fakeApi({
      query: async () => {
        calls += 1
        if (calls === 1) throw new Error('transient')
        return [ARTIFACT]
      },
    })
    readerMock.readColumn.mockResolvedValue(tableWith(1))

    await resolveAndApplyViewData('v-retry', spec, api)
    expect(store.dataStatus).toBe('error')
    expect(calls).toBe(1)

    await retryViewData('v-retry', spec, api)
    expect(calls).toBe(2)
    expect(store.dataStatus).toBe('ready')
    expect(store.data).toEqual({ rowmeta: { metric_total: [0] } })
    errSpy.mockRestore()
    store.dispose()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// FIX-2 — the CONCURRENCY contract (request key + generation). Round-2 audit found the whole
// guard untested: deleting every generation check left the suite green. These tests drive the
// actual interleavings.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolve concurrency: de-dupe, supersede, last-request-wins', () => {
  const spec = {
    id: 'x/y',
    data: { rowmeta: { source: 'job.result', args: { datatype: 'demo/report' } } },
  } as unknown as ViewSpec

  /** A host whose `query` blocks until the test releases it. */
  function gatedApi() {
    const gates: Array<(rows: unknown[]) => void> = []
    const api = fakeApi({
      query: () =>
        new Promise<never[]>(resolve => {
          gates.push(resolve as (rows: unknown[]) => void)
        }) as Promise<never[]>,
    })
    return { api, gates }
  }

  it('the SAME request key de-dupes (the fanned regions cause ONE fetch, not three)', async () => {
    const store = createViewStore(spec, 'v-dedupe')
    registerViewStore('v-dedupe', store)
    const { api, gates } = gatedApi()

    const a = resolveAndApplyViewData('v-dedupe', spec, api, 'catalog:0')
    const b = resolveAndApplyViewData('v-dedupe', spec, api, 'catalog:0')
    const c = resolveAndApplyViewData('v-dedupe', spec, api, 'catalog:0')
    expect(gates.length).toBe(1) // exactly one fetch started
    gates[0]([])
    await Promise.all([a, b, c])
    expect(store.dataStatus).toBe('empty')
    store.dispose()
  })

  it('a DIFFERENT request key SUPERSEDES an in-flight resolve instead of being dropped', async () => {
    const store = createViewStore(spec, 'v-supersede')
    registerViewStore('v-supersede', store)
    const { api, gates } = gatedApi()

    const stale = resolveAndApplyViewData('v-supersede', spec, api, 'catalog:0')
    expect(gates.length).toBe(1)
    // The catalog changed (a run just produced the artifact). Under the old `inFlight.has`
    // short-circuit this second call was silently DROPPED and never rescheduled.
    const fresh = resolveAndApplyViewData('v-supersede', spec, api, 'catalog:1')
    expect(gates.length).toBe(2)

    // The STALE resolve lands LAST with a different answer — and must be discarded.
    gates[1]([ARTIFACT])
    readerMock.readColumn.mockResolvedValue(tableWith(2))
    await fresh
    expect(store.dataStatus).toBe('ready')

    gates[0]([]) // stale would have written `empty`
    await stale
    expect(store.dataStatus, 'a superseded resolve must not write to the store').toBe('ready')
    store.dispose()
  })

  it('retryViewData supersedes an in-flight resolve, and the stale one cannot clobber it', async () => {
    const store = createViewStore(spec, 'v-retry-race')
    registerViewStore('v-retry-race', store)
    const { api, gates } = gatedApi()

    const stale = resolveAndApplyViewData('v-retry-race', spec, api, 'catalog:0')
    expect(gates.length).toBe(1)
    const retried = retryViewData('v-retry-race', spec, api)
    expect(gates.length).toBe(2)
    expect(store.dataStatus, 'the retry flips the surface to loading immediately').toBe('loading')

    readerMock.readColumn.mockResolvedValue(tableWith(1))
    gates[1]([ARTIFACT])
    await retried
    expect(store.dataStatus).toBe('ready')

    gates[0]([])
    await stale
    expect(store.dataStatus).toBe('ready')
    store.dispose()
  })

  it('the in-flight guard is RELEASED after a resolve settles (a later request still runs)', async () => {
    const store = createViewStore(spec, 'v-release')
    registerViewStore('v-release', store)
    let calls = 0
    const api = fakeApi({
      query: async () => {
        calls += 1
        return []
      },
    })
    await resolveAndApplyViewData('v-release', spec, api, 'catalog:0')
    await resolveAndApplyViewData('v-release', spec, api, 'catalog:0')
    expect(calls, 'the guard must not stay latched after the first resolve settled').toBe(2)
    store.dispose()
  })

  it('a genuine EMPTY clears previously-landed data (no stale rows under "No data yet")', async () => {
    const store = createViewStore(spec, 'v-empty-clears')
    registerViewStore('v-empty-clears', store)
    readerMock.readColumn.mockResolvedValue(tableWith(2))
    await resolveAndApplyViewData('v-empty-clears', spec, fakeApi({ query: async () => [ARTIFACT] }), 'c:0')
    expect(store.data).toEqual({ rowmeta: { metric_total: [0, 10] } })

    // The artifact is gone (deleted / a different project). `empty` is AUTHORITATIVE.
    await resolveAndApplyViewData('v-empty-clears', spec, fakeApi({ query: async () => [] }), 'c:1')
    expect(store.dataStatus).toBe('empty')
    expect(store.data, 'stale slices must not survive an authoritative empty').toBeUndefined()
    store.dispose()
  })

  it('an ERROR is NOT authoritative — the last good data survives so the canvas is not blanked', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = createViewStore(spec, 'v-error-keeps')
    registerViewStore('v-error-keeps', store)
    readerMock.readColumn.mockResolvedValue(tableWith(2))
    await resolveAndApplyViewData('v-error-keeps', spec, fakeApi({ query: async () => [ARTIFACT] }), 'c:0')
    expect(store.data).toEqual({ rowmeta: { metric_total: [0, 10] } })

    await resolveAndApplyViewData(
      'v-error-keeps',
      spec,
      fakeApi({
        query: async () => {
          throw new Error('transient 503')
        },
      }),
      'c:1',
    )
    expect(store.dataStatus).toBe('error')
    expect(store.data).toEqual({ rowmeta: { metric_total: [0, 10] } })
    errSpy.mockRestore()
    store.dispose()
  })

  it('a hung request does not pin the view on loading forever (bounded by VIEW_DATA_TIMEOUT_MS)', async () => {
    vi.useFakeTimers()
    const store = createViewStore(spec, 'v-timeout')
    registerViewStore('v-timeout', store)
    const { api } = gatedApi() // never released

    const p = resolveAndApplyViewData('v-timeout', spec, api, 'c:0')
    await vi.advanceTimersByTimeAsync(VIEW_DATA_TIMEOUT_MS + 10)
    await p
    expect(store.dataStatus).toBe('error')
    expect(store.dataError).toMatch(/timed out/i)
    vi.useRealTimers()
    store.dispose()
  })
})

// FIX-4.1 — the `outstanding` counter. Round-4 audit reverted it to a plain
// `generation.delete()` and every existing test still passed, because none of them starts a
// THIRD request after a winner settles while an OLDER superseded resolve is still running.
// That is the exact ABA the counter exists to prevent, so it needs its own test.
describe('a straggler cannot alias a fresh generation (ABA)', () => {
  const spec = {
    id: 'x/y',
    data: { rowmeta: { source: 'job.result', args: { datatype: 'demo/report' } } },
  } as unknown as ViewSpec

  it('a resolve superseded LONG ago cannot write after two later requests have settled', async () => {
    const store = createViewStore(spec, 'v-aba')
    registerViewStore('v-aba', store)
    const gates: Array<(rows: unknown[]) => void> = []
    const api = fakeApi({
      query: () =>
        new Promise<never[]>(resolve => {
          gates.push(resolve as (rows: unknown[]) => void)
        }) as Promise<never[]>,
    })

    // #1 starts and is immediately superseded by #2; #1 is still OUTSTANDING.
    const first = resolveAndApplyViewData('v-aba', spec, api, 'c:0')
    const second = resolveAndApplyViewData('v-aba', spec, api, 'c:1')
    expect(gates.length).toBe(2)

    // #2 wins and settles. If the generation counter were dropped here (it must NOT be,
    // because #1 is still outstanding), the next request would restart at generation 1 —
    // the same number #1 is holding.
    readerMock.readColumn.mockResolvedValue(tableWith(3))
    gates[1]([ARTIFACT])
    await second
    expect(store.dataStatus).toBe('ready')
    expect(store.data).toEqual({ rowmeta: { metric_total: [0, 10, 20] } })

    // #3 starts (this is the request that would ALIAS #1's generation).
    const third = resolveAndApplyViewData('v-aba', spec, api, 'c:2')
    expect(gates.length).toBe(3)

    // …and now the long-superseded #1 finally lands with a DIFFERENT answer. It must be
    // discarded, and it must not steal #3's in-flight slot.
    gates[0]([])
    await first
    expect(store.dataStatus, 'a long-superseded resolve wrote to the store').toBe('ready')

    // #3 is still the current request and its result must land.
    readerMock.readColumn.mockResolvedValue(tableWith(1))
    gates[2]([ARTIFACT])
    await third
    expect(store.data, 'the newest request was discarded').toEqual({ rowmeta: { metric_total: [0] } })
    store.dispose()
  })
})

// `axis_columns` with `args.as: sources` — the SAME slice declaration asked for the ARTIFACT
// ID behind each column instead of its values, so a view can bind a slot whose NAME is data
// (`column:metric_a`). Its cost claim is load-bearing and is asserted here: a column's name
// and id are both producer DECLARATIONS on the catalog row, so this answer reads NO bytes.
describe('readSliceFromApi — axis_columns `as: sources`', () => {
  const catalogApi = (artifacts: unknown[]): WorkbenchAPI => {
    const capabilities = createCapabilityBroker()
    capabilities.publish('data', '1.0.0', {
      catalog: async () => ({ project_id: 'p1', axes: [], artifacts }),
      artifacts: { query: async () => artifacts },
    })
    return { capabilities } as unknown as WorkbenchAPI
  }
  const col = (id: string, name: string) => ({
    id,
    project_id: 'p1',
    datatype: 'demo/column',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds1',
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', columns: [{ name, kind: 'numeric' }] },
  })
  const anchor = {
    id: 'm1',
    project_id: 'p1',
    datatype: 'demo/matrix',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds1',
    structure: { kind: 'sparse_csc', axes: ['rows', 'cols'], shape: [2, 3] },
  }
  const decl = {
    source: 'axis_columns',
    args: { of: '$state.ds', axis: 'rows', as: 'sources' },
  } as DataSourceSpec
  const scope: Scope = { state: { ds: 'm1' } }

  it('lands the `{ column: artifactId }` map', async () => {
    const api = catalogApi([anchor, col('a-metric', 'metric_a'), col('a-label', 'label_a')])
    const res = await readSliceFromApi(api, 'rowmetaSources', decl, scope)
    expect(res).toEqual({ status: 'ready', payload: { metric_a: 'a-metric', label_a: 'a-label' } })
  })

  it('reads NO artifact bytes (the whole answer is on the catalog row)', async () => {
    readerMock.readColumn.mockReset()
    const api = catalogApi([anchor, col('a-metric', 'metric_a')])
    await readSliceFromApi(api, 'rowmetaSources', decl, scope)
    expect(readerMock.readColumn).not.toHaveBeenCalled()
  })

  it('is SKIPPED (not empty) until the anchor resolves — the same rule as the values arm', async () => {
    const api = catalogApi([anchor, col('a-metric', 'metric_a')])
    expect(await readSliceFromApi(api, 'rowmetaSources', decl, { state: {} })).toBeUndefined()
  })

  it('an axis carrying no column artifact is `empty`, not an error', async () => {
    const api = catalogApi([anchor])
    expect(await readSliceFromApi(api, 'rowmetaSources', decl, scope)).toEqual({ status: 'empty' })
  })

  // A slice may be anchored on a LIST — "which column names are already taken on the axes
  // this run writes to" is asked of every selected input. This arm used to answer by merging
  // one independently-built map per anchor with `Object.assign`, i.e. LAST ANCHOR WINS: a
  // name carried by two of the selected instances resolved to whichever the user happened to
  // list last, silently. The union is minted over the combined selection instead.
  describe('anchored on SEVERAL axis instances', () => {
    const otherAnchor = {
      ...anchor,
      id: 'm2',
      source_dataset_id: 'ds2',
    }
    const colOn = (id: string, name: string, dataset: string) => ({
      ...col(id, name),
      source_dataset_id: dataset,
    })
    const plural: Scope = { state: { ds: ['m1', 'm2'] } }

    it('a name carried by BOTH instances resolves to neither — and both remain addressable', async () => {
      const api = catalogApi([
        anchor,
        otherAnchor,
        colOn('a-one', 'metric_a', 'ds1'),
        colOn('a-two', 'metric_a', 'ds2'),
      ])
      const res = await readSliceFromApi(api, 'rowmetaSources', decl, plural)
      expect(res).toEqual({
        status: 'ready',
        payload: {
          'metric_a · a-one': 'a-one',
          'metric_a · a-two': 'a-two',
          // still TAKEN — this is what `require.not_in` reads — and bound to nothing.
          metric_a: '',
        },
      })
    })

    it('does not depend on the order the anchors were selected in', async () => {
      const api = catalogApi([
        anchor,
        otherAnchor,
        colOn('a-one', 'metric_a', 'ds1'),
        colOn('a-two', 'metric_a', 'ds2'),
      ])
      const forward = await readSliceFromApi(api, 'rowmetaSources', decl, plural)
      const reversed = await readSliceFromApi(api, 'rowmetaSources', decl, { state: { ds: ['m2', 'm1'] } })
      expect(reversed).toEqual(forward)
    })

    it('two anchors in ONE dataset do not make that dataset’s columns contest themselves', async () => {
      // Both anchors are siblings on the same axis of the same dataset, so each anchor's
      // selection contains almost the same rows. Counting a column once per anchor would
      // make every name look contested with ITSELF and qualify the whole axis.
      const second = { ...anchor, id: 'm1b' }
      const api = catalogApi([anchor, second, colOn('a-one', 'metric_a', 'ds1')])
      const res = await readSliceFromApi(api, 'rowmetaSources', decl, { state: { ds: ['m1', 'm1b'] } })
      expect(res).toEqual({ status: 'ready', payload: { metric_a: 'a-one' } })
    })
  })

  // ── `produced_by: others`, through the REACT BINDING ─────────────────────────────────
  //
  // The narrowing is resolved from the view's OWN `run_processor` ops, so it only works if
  // the reader is handed the spec the resolver is walking. That handoff is ONE line inside
  // `resolveAndApplyViewData`, and every other tier composes its own reader — so a wiring
  // that dropped the spec would leave the whole suite green and the app unnarrowed. This is
  // the same failure `source_dataset_id` shipped: a fact carried everywhere but the seam.
  describe('narrowed by producer, landed through resolveAndApplyViewData', () => {
    const producedBy = (id: string, name: string, generator: string | null) => ({
      ...col(id, name),
      generator_id: generator,
    })
    const narrowedSpec = {
      id: 'x/y',
      data: {
        rowmetaSources: {
          source: 'axis_columns',
          args: { of: '$state.ds', axis: 'rows', as: 'sources', produced_by: 'others' },
        },
      },
      actions: [{ id: 'run', body: [{ run_processor: { id: 'pkg.thing' } }] }],
    } as unknown as ViewSpec

    it('the landed slice holds only the columns this view’s own analysis did NOT make', async () => {
      const store = createViewStore(narrowedSpec, 'v-produced-by')
      registerViewStore('v-produced-by', store)
      store.set('ds', 'm1')
      const api = catalogApi([
        anchor,
        producedBy('a-mine', 'metric_mine', 'pkg.thing'),
        producedBy('a-theirs', 'metric_theirs', 'other.thing'),
        producedBy('a-import', 'metric_import', null),
      ])
      await resolveAndApplyViewData('v-produced-by', narrowedSpec, api, 'c:produced-by')
      expect(
        store.data,
        'the view launches `pkg.thing`, so its own previous output must not be reported as ' +
          'taken — while another producer’s column, and an unattributed one, still are',
      ).toEqual({ rowmetaSources: { metric_theirs: 'a-theirs', metric_import: 'a-import' } })
      store.dispose()
    })
  })
})

// The GATE and the DISPATCH must name the same sources (visualize-pane, phase 5).
//
// `resolveViewData` filters on `RESOLVED_SOURCES` before it ever calls the reader, so a
// source `readSliceFromApi` knows how to read but the gate does not list is DEAD: the slice
// is skipped and the branch is unreachable. `row_space_columns` shipped in exactly that
// state — a correct resolver, correct tests, two shipped section slices naming it, and a
// section that populated nothing in the app.
//
// Asserted on STATE, not on source text: each source is driven through the real
// `resolveViewData` with a spying reader, and the assertion is that the reader was REACHED.
// A syntax-shaped guard over the two literals would have been evadable in the usual ways
// and would not have caught the shape that actually shipped.
describe('every readable source reaches the reader', () => {
  // DERIVED, never hand-listed. The list here used to be six literals — and it omitted
  // `pane_frame` and `column_values`, the two the whole emit model rests on, so this suite
  // survived deleting `COLUMN_VALUES_SOURCE` from the gate: every emitted plot would have
  // died and the unit tier would have stayed green. A hand-maintained list of the thing it is
  // supposed to cover drifts from it; that is the same class as the gate/dispatch pair this
  // describe block exists to guard, reproduced inside the guard.
  const SOURCES = [...RESOLVED_SOURCES]

  it('the gate is not EMPTY and still carries the sources the emit model needs', () => {
    // A derived list can collapse to nothing and every `it.each` below would report green
    // with zero cases. Floor it, and name the two the omission actually cost, so a future
    // deletion argues with this line rather than passing silently.
    expect(SOURCES.length).toBeGreaterThanOrEqual(8)
    expect(RESOLVED_SOURCES.has(PANE_FRAME_SOURCE)).toBe(true)
    expect(RESOLVED_SOURCES.has(COLUMN_VALUES_SOURCE)).toBe(true)
  })

  it.each(SOURCES)('resolveViewData calls the reader for "%s"', async source => {
    const spec = {
      id: 'demo/spec',
      title: 'T',
      permission: 'p',
      state: {},
      data: { slice: { source } },
      widgets: [],
      actions: [],
    } as unknown as ViewSpec
    const read = vi.fn(async () => ({ status: 'ready', payload: { ok: [1] } }) as const)
    await resolveViewData(spec, read)
    expect(read).toHaveBeenCalledTimes(1)
  })

  // ── AMENDED (ITEM-41 follow-on). This test used to assert `res.status === 'ready'`. ──
  //
  // Its NAME and its stated reason are about not being pinned on a SKELETON, and that
  // concern is real and still asserted below. But `ready` is a much stronger claim than the
  // concern needs, and it was the claim that made a blank surface report healthy: a view
  // whose only slice named a source nothing reads resolved to a clean `ready` and rendered
  // widgets bound to `$data.slice` holding nothing.
  //
  // A skeleton is the `loading` state, and `loading` is the ONLY status `DeclarativeRegion`
  // suppresses widgets for. So `unsupported` satisfies the original concern exactly — the
  // view still renders, nothing is pinned — while no longer telling the region everything is
  // fine. The old assertion was pinning the bug, not the requirement.
  it('does not CALL a reader for a source nothing reads, and is not pinned on a skeleton', async () => {
    const spec = {
      id: 'demo/spec',
      title: 'T',
      permission: 'p',
      state: {},
      data: { slice: { source: 'not.a.source' } },
      widgets: [],
      actions: [],
    } as unknown as ViewSpec
    const read = vi.fn(async () => ({ status: 'ready', payload: {} }) as const)
    const res = await resolveViewData(spec, read)

    // Unchanged and still the point: no reader is invented for a source there is none for.
    expect(read).not.toHaveBeenCalled()

    // The ORIGINAL concern, asserted directly rather than via `ready`: a skeleton is
    // `loading`, and `loading` is the only status that suppresses this view's widgets.
    expect(res.status).not.toBe('loading')

    // What replaced `ready` — the region is told it could not honour the declaration.
    expect(res.status).toBe('unsupported')
    expect(res.error).toContain('not.a.source')

    // Still contributes no data, exactly as before.
    expect(res.data.slice).toBeUndefined()
  })

  // The control for the amendment above: a view that declares NO data at all is still
  // `ready`, so "not pinned on a skeleton" has not quietly become "always unsupported".
  it('a view declaring no data at all is still ready', async () => {
    const spec = {
      id: 'demo/spec',
      title: 'T',
      permission: 'p',
      state: {},
      widgets: [],
      actions: [],
    } as unknown as ViewSpec
    const res = await resolveViewData(spec, vi.fn())
    expect(res.status).toBe('ready')
  })
})

// THE ANCHORED SLICE RESOLVES (visualize-pane ITEM-10 / ITEM-12, phase 5).
//
// `resolveAndApplyViewData` builds the scope the SLICE RESOLVER evaluates `$`-refs against —
// a different object from the one `DeclarativeRegion` builds for the render. A section
// declares `aligned_to: "$scope.axis"`, so a `scope` root present in the render scope and
// absent from THIS one is the shape that ships a pane whose control says a row space is
// anchored while every section beneath it states "no row space anchored yet". Driven through
// the real resolver, with the pane scope set the way the anchor control sets it.
describe('an anchored slice resolves against the PANE scope', () => {
  const KEY_HASH = 'h'.repeat(64)
  const keyArtifact = {
    id: 'k1',
    project_id: 'p',
    datatype: 'demo/key',
    created_at: '2026-01-01T00:00:00Z',
    content_hash: KEY_HASH,
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', key_sequence_digest: 'd1' },
  }

  afterEach(() => {
    paneScopeStore.getState().reset()
    __resetViewDataForTests()
  })

  // `setDerivedAxis` replaced `setAxis` here as a pure SETUP rename (owner, 2026-08-13): the
  // pane no longer ASKS which rows it is about, so the only writer of `$scope.axis` is the
  // derivation from the chosen coordinate set (`runtime/coordinateAxis.ts`). What this asserts
  // is unchanged — an anchored slice resolves `$scope.axis` off the PANE and reports it.
  it('reports `anchored` once the pane scope carries a derived `$scope.axis`', async () => {
    const api = fakeApi({ query: async () => [keyArtifact] })
    const spec = {
      id: 'sec/one',
      data: { cols: { source: 'row_space_columns', args: { aligned_to: '$scope.axis' } } },
    } as unknown as ViewSpec
    registerViewStore('v-anchored', createViewStore(spec, 'v-anchored'))
    paneScopeStore.getState().setDerivedAxis('p', [KEY_HASH])
    await resolveAndApplyViewData('v-anchored', spec, api, 'k1')
    expect((getViewStore('v-anchored')?.data as Record<string, { anchored: boolean }>).cols.anchored).toBe(true)
  })

  it('and reports A0 — anchored:false — while nothing is anchored (the negative control)', async () => {
    const api = fakeApi({ query: async () => [keyArtifact] })
    const spec = {
      id: 'sec/two',
      data: { cols: { source: 'row_space_columns', args: { aligned_to: '$scope.axis' } } },
    } as unknown as ViewSpec
    registerViewStore('v-unanchored', createViewStore(spec, 'v-unanchored'))
    await resolveAndApplyViewData('v-unanchored', spec, api, 'k2')
    expect((getViewStore('v-unanchored')?.data as Record<string, { anchored: boolean }>).cols.anchored).toBe(false)
  })
})

// A SLICE ARG THAT IS A `$`-REF IS RESOLVED, NOT READ VERBATIM (visualize-pane ITEM-60).
//
// This is a REGRESSION test for a defect the e2e caught and nothing else could: the entry
// section's header binds `show: "$state.show"`, and the slice reader passed that string
// STRAIGHT to the resolver. It matched no annotation, so the resolver fell back to the axis key
// — and the header select changed the display to nothing at all, silently, while every unit
// test on the pure resolver passed (the pure resolver is handed the RESOLVED value, so it can
// never see this).
//
// The assertion is therefore at the SLICE READER, driven through the real
// `resolveAndApplyViewData`, with the section's own state holding the choice.
describe('a slice arg that names section state is RESOLVED before the resolver sees it', () => {
  const ROW_HASH = 'r'.repeat(64)
  const ENTRY_HASH = 'e'.repeat(64)
  const rowsIndex = {
    id: 'rows-1',
    project_id: 'p',
    datatype: 'demo/key',
    created_at: '2026-01-01T00:00:00Z',
    content_hash: ROW_HASH,
    source_dataset_id: 'ds-1',
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'rows', key_sequence_digest: 'd1' },
  }
  const entryIndex = {
    id: 'entries-1',
    project_id: 'p',
    datatype: 'demo/key',
    created_at: '2026-01-01T00:00:00Z',
    content_hash: ENTRY_HASH,
    source_dataset_id: 'ds-1',
    meta: { name: 'entry keys' },
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'items', columns: [{ path: 'values', kind: 'string' }] },
  }
  const annotation = {
    id: 'ann-1',
    project_id: 'p',
    datatype: 'demo/column',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds-1',
    meta: { name: 'Alpha' },
    structure: { encoding: 'zarr_v3', kind: 'table', axis: 'items', columns: [{ path: 'values', kind: 'string' }] },
  }

  afterEach(() => {
    paneScopeStore.getState().reset()
    __resetViewDataForTests()
  })

  it('the chosen annotation reaches the payload — not the literal `$state.show`', async () => {
    readerMock.readColumn.mockImplementation(async () => ({ readAll: async () => ['k-1', 'k-2'] }))
    const api = fakeApi({
      query: async () => [rowsIndex, entryIndex, annotation],
      catalog: async () => ({
        axes: [
          { content_hash: ROW_HASH, name: 'rows', length: 2 },
          { content_hash: ENTRY_HASH, name: 'items', length: 2 },
        ],
      }),
    })
    const spec = {
      id: 'sec/entries',
      state: { show: { type: 'string', default: null } },
      data: {
        rows: {
          source: 'axis_entry_rows',
          args: { axis_of: '$scope.axis', axis: 'items', show: '$state.show' },
        },
      },
    } as unknown as ViewSpec
    const store = createViewStore(spec, 'v-entries')
    registerViewStore('v-entries', store)
    paneScopeStore.getState().setDerivedAxis('p', [ROW_HASH])

    // Nothing chosen — the engine answers with the axis KEY and SAYS it is the default.
    await resolveAndApplyViewData('v-entries', spec, api, 'rows-1')
    const unchosen = (store.data as Record<string, { show: string; show_is_default: boolean }>).rows
    expect(unchosen.show).toBe(entryIndex.id)
    expect(unchosen.show_is_default).toBe(true)

    // …and once the section's own state holds a choice, THAT is what the payload carries.
    store.set('show', annotation.id)
    __resetViewDataForTests()
    await resolveAndApplyViewData('v-entries', spec, api, 'rows-1')
    const chosen = (store.data as Record<string, { show: string; show_is_default: boolean }>).rows
    expect(chosen.show).toBe(annotation.id)
    expect(chosen.show_is_default).toBe(false)
  })

  // ── THE FRAME REF, through the SAME join ──────────────────────────────────────────
  //
  // `axis_entry_rows { coordinate: "$scope.coordinate" }` (ITEM-39) has the identical shape
  // to `show` above, and the identical failure mode: the PURE resolver is handed the RESOLVED
  // value, so a resolver test that passes an artifact id cannot see whether the `$`-ref was
  // ever resolved. Delete the `anchorId(args.coordinate, …)` line in `readAxisEntryRowsSlice`
  // and the resolver receives the literal string `"$scope.coordinate"`, matches no artifact,
  // and reports UNFRAMED forever — every entry row permanently refused, with every unit
  // test on the pure resolver still green. This is the middle of that join, asserted.
  it('the CHOSEN coordinate reaches the resolver — not the literal `$scope.coordinate`', async () => {
    readerMock.readColumn.mockImplementation(async () => ({ readAll: async () => ['k-1', 'k-2'] }))
    // An artifact indexed by BOTH axes: what makes the entries plottable at all, so
    // `n_sources` is non-zero and the FRAME gate is the only thing that can refuse.
    const matrix = {
      id: 'mat-1',
      project_id: 'p',
      datatype: 'demo/values',
      created_at: '2026-01-01T00:00:00Z',
      source_dataset_id: 'ds-1',
      meta: { name: 'the values' },
      structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['rows', 'items'], aligned_to: 'd1' },
    }
    const api = fakeApi({
      query: async () => [rowsIndex, entryIndex, annotation, matrix],
      catalog: async () => ({
        axes: [
          { content_hash: ROW_HASH, name: 'rows', length: 2 },
          { content_hash: ENTRY_HASH, name: 'items', length: 2 },
        ],
      }),
    })
    const spec = {
      id: 'sec/entries-frame',
      state: {},
      data: {
        rows: {
          source: 'axis_entry_rows',
          args: {
            axis_of: '$scope.axis',
            axis: 'items',
            values_datatype: 'demo/values',
            coordinate: '$scope.coordinate',
          },
        },
      },
    } as unknown as ViewSpec
    const store = createViewStore(spec, 'v-entries-frame')
    registerViewStore('v-entries-frame', store)
    paneScopeStore.getState().setDerivedAxis('p', [ROW_HASH])

    type Rows = { rows: Array<{ plot_refusal: string | null }> }
    // UNFRAMED — pane scope holds no coordinate, so every row refuses.
    await resolveAndApplyViewData('v-entries-frame', spec, api, 'rows-1')
    const unframed = (store.data as Record<string, Rows>).rows
    expect(unframed.rows.length).toBeGreaterThan(0)
    expect(unframed.rows.every(r => r.plot_refusal === NO_COORDINATE_REFUSAL)).toBe(true)

    // FRAMED — the coordinate is written to PANE SCOPE, never to the args. If the `$`-ref were
    // passed through unresolved this would still read UNFRAMED, because `"$scope.coordinate"`
    // is not an artifact id. That is the assertion.
    paneScopeStore.getState().setValue('coordinate', matrix.id)
    __resetViewDataForTests()
    await resolveAndApplyViewData('v-entries-frame', spec, api, 'rows-1')
    const framed = (store.data as Record<string, Rows>).rows
    expect(framed.rows.length).toBeGreaterThan(0)
    expect(framed.rows.every(r => r.plot_refusal === null)).toBe(true)
  })
})

// THE STATE HALF OF THE RE-RESOLVE TRIGGER (visualize-pane — the emit model + ITEM-60).
//
// Two shipped slices bind their args to the view's OWN state: the emit model's values read
// (`column_values { of: "$state.plots" }`) and the entry section's header
// (`axis_entry_rows { show: "$state.show" }`). The catalog epoch does not move when that state
// changes and `axisSourceRequestKey` digests `axis_columns` slices only — so before this key
// existed both resolved once per mount and never again.
//
// The failure mode is why it is tested as a DIGEST rather than trusted as a dependency array:
// it is invisible from below (a resolver test is handed the resolved args) and invisible from
// an e2e that asserts a pane EXISTS (it does — it is simply empty).
describe('dataArgsRequestKey — a state-bound slice re-resolves, and nothing else does', () => {
  const spec = (data: Record<string, unknown>) => ({ id: 's', data }) as unknown as ViewSpec

  it('moves when the state a slice NAMES changes', () => {
    const s = spec({ plotted: { source: 'column_values', args: { of: '$state.plots' } } })
    const one = dataArgsRequestKey(s, { plots: [{ artifact: 'a' }] })
    const two = dataArgsRequestKey(s, { plots: [{ artifact: 'a' }, { artifact: 'b' }] })
    expect(one).not.toBe(two)
    expect(one).not.toBe('')
  })

  it('does NOT move for state no slice reads — a drag must not become a refetch storm', () => {
    const s = spec({ plotted: { source: 'column_values', args: { of: '$state.plots' } } })
    const before = dataArgsRequestKey(s, { plots: [], slider: 1 })
    const after = dataArgsRequestKey(s, { plots: [], slider: 999 })
    expect(after).toBe(before)
  })

  it('digests a `$state` arg of ANY slice, not only the two that ship today', () => {
    const s = spec({ rows: { source: 'axis_entry_rows', args: { axis: 'items', show: '$state.show' } } })
    expect(dataArgsRequestKey(s, { show: null })).not.toBe(dataArgsRequestKey(s, { show: 'ann-1' }))
    // a LITERAL arg contributes nothing — it cannot change without the spec changing
    expect(dataArgsRequestKey(s, { show: null })).toContain('rows.show=')
    expect(dataArgsRequestKey(s, { show: null })).not.toContain('items')
  })

  it('a spec with no state-bound arg digests to the empty string (the previous behaviour)', () => {
    expect(dataArgsRequestKey(spec({ a: { source: 'job.result' } }), { x: 1 })).toBe('')
    expect(dataArgsRequestKey(spec({}), { x: 1 })).toBe('')
  })

  it('a LARGE resolved value is hashed, never truncated', () => {
    // Truncation would make two different states digest EQUAL, which de-dupes a resolve that
    // should have superseded — the failure this whole key exists to prevent, one level down.
    const s = spec({ plotted: { source: 'column_values', args: { of: '$state.plots' } } })
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ artifact: `artifact-${i}`, name: `name-${i}` }))
    const a = dataArgsRequestKey(s, { plots: many(40) })
    const b = dataArgsRequestKey(s, { plots: many(41) })
    expect(a.length).toBeLessThan(80)
    expect(a).not.toBe(b)
  })
})

// ── TEST-50 [ITEM-38] — the CONTRACT a decoded slice owes, independent of representation ────
//
// `columnarFromTable`'s existing assertion is `Object.values(slice).every(Array.isArray)`. It is
// the single guard standing between the typed migration and a silent no-op across five call
// sites, and it WILL go red when the decode starts producing typed columns.
//
// When it does, it must be STRENGTHENED — replaced by this — and never loosened. That distinction
// matters because loosening is the easy move and it is indistinguishable from progress: relaxing
// the predicate to `isColumn` would make the suite green while asserting strictly less than
// before, and nothing would notice the arc had stopped being checked.
//
// So this test asserts the CONTRACT rather than the container: whatever representation a column
// arrives in, the kernels must be able to consume it, and the values must be the producer's. That
// holds for boxed and typed alike, so it cannot be satisfied by weakening — only by the decode
// actually being correct.
describe('a decoded slice satisfies the KERNEL CONTRACT, whatever its representation (TEST-50)', () => {
  it('every column is consumable, correctly sized, and carries the producer\'s values', async () => {
    const tree = loadTree(join(FIXTURES, 'table'))
    const groupMeta = JSON.parse(new TextDecoder().decode(tree.get('zarr.json')!)) as {
      attributes: { txr: unknown }
    }
    const structure = parseStructure('fixture', groupMeta.attributes.txr)
    const table = await decodeTable('fixture', structure, { store: memoryStore(tree) })
    const slice = columnarFromTable(table)

    for (const [name, col] of Object.entries(slice)) {
      // 1. CONSUMABLE — the predicate every kernel guards with. A column that fails this is
      //    skipped silently by `keep_mask`, `categories_by_column`, `columns_of` and
      //    `sliceRevision` alike, which is the fail-open class this migration must not ship.
      expect(isColumn(col), `${name} must be consumable by the kernels`).toBe(true)
      // 2. SIZED — all columns of one table span the same rows. A representation change that
      //    truncated or padded would pass a mere type check.
      expect(col.length, `${name} spans the table's rows`).toBe(500)
    }

    // 3. VALUED — the producer's actual bytes, not merely something of the right shape. These
    //    are the same values the row-major reader yields, so a representation change cannot
    //    quietly alter one.
    const f32 = slice.f32col as ArrayLike<number>
    expect([f32[0], f32[1], f32[2]]).toEqual([-3.25, -2.75, -2.25])
    const cat = slice.cat8 as ArrayLike<unknown>
    expect([cat[0], cat[1], cat[2], cat[3]]).toEqual(['group-A', '', 'café ☕', 'group-B'])
  })

  it('the kernels ACTUALLY consume it — asserted by running them, not by predicate', async () => {
    // The wired-and-behaving half: a predicate can be satisfied by a value no kernel accepts.
    // Running two of them over the real decoded slice is what proves the contract is the right
    // one. `keep_mask` must CONSTRAIN (an all-true answer means the column was not recognised),
    // and the categorical must offer its levels.
    const tree = loadTree(join(FIXTURES, 'table'))
    const groupMeta = JSON.parse(new TextDecoder().decode(tree.get('zarr.json')!)) as {
      attributes: { txr: unknown }
    }
    const structure = parseStructure('fixture', groupMeta.attributes.txr)
    const table = await decodeTable('fixture', structure, { store: memoryStore(tree) })
    const slice = columnarFromTable(table)

    const mask = keep_mask([{ column: 'f32col', max: 0 }], slice)
    expect(mask).toHaveLength(500)
    expect(
      mask.some(k => !k),
      'a PRESENT numeric column must constrain — all-true means it was not recognised',
    ).toBe(true)
    expect(Object.keys(categories_by_column(slice))).toContain('cat8')
  })

  // ── TEST-31 [ITEM-26] — the CONSUMER half of the type-split containment proof ───────────────
  //
  // TESTS.md declares TEST-31 against `core/runtime/columnValues.test.ts`; the assertions are
  // actually here and in `core/workstore/artifactReader.test.ts` (which carries the producer half).
  // The two legs ABOVE drive `keep_mask` / `categories_by_column` over the BOXED `axis_columns`
  // representation and require them unchanged; the leg BELOW drives the typed reader. Together
  // they are the containment claim: the typed frame must not leak into the criteria-builder path.
  //
  // ── ITEM-21 — the same contract over the reader that ACTUALLY produces the typed form ──────
  //
  // The two legs above decode through `readTable` + `columnarFromTable`, which is the
  // `job.result` / `axis_columns` path and re-boxes on transposition. That path is deliberately
  // NOT converted (the ITEM-26 type split keeps `primitives.ts` / `store.ts` / `viz.tsx` on the
  // boxed representation), so those legs cannot observe the typed representation at all — and
  // `viewData.test.ts:120`'s `every(Array.isArray)` is, correctly, still TRUE of it.
  //
  // The typed arc is the OTHER reader: `readColumnarTable`, which `column_values` reaches through
  // `readColumnarTableChecked`. Without this leg the contract test would be watching the one path
  // the migration does not change, which is the test-shaped form of the very failure this work
  // exists to prevent — a capability with no consumer, certified green.
  it('the reader that PRODUCES the typed form satisfies the identical contract', async () => {
    const tree = loadTree(join(FIXTURES, 'table'))
    const groupMeta = JSON.parse(new TextDecoder().decode(tree.get('zarr.json')!)) as {
      attributes: { txr: unknown }
    }
    const structure = parseStructure('fixture', groupMeta.attributes.txr)
    const slice = await readColumnarTable('fixture', structure, { store: memoryStore(tree) })

    // The representation really is the new one — otherwise every assertion below would be
    // re-proving the boxed path and this leg would be decorative.
    expect(ArrayBuffer.isView(slice.f32col), 'the numeric column arrives typed').toBe(true)

    for (const [name, col] of Object.entries(slice)) {
      expect(isColumn(col), `${name} must be consumable by the kernels`).toBe(true)
      expect((col as ArrayLike<unknown>).length, `${name} spans the table's rows`).toBe(500)
    }
    const f32 = slice.f32col as ArrayLike<number>
    expect([f32[0], f32[1], f32[2]]).toEqual([-3.25, -2.75, -2.25])
    const cat = slice.cat8 as ArrayLike<unknown>
    expect([cat[0], cat[1], cat[2], cat[3]]).toEqual(['group-A', '', 'café ☕', 'group-B'])
  })

  // The CONSUMER half of the same binding, and the one with teeth (TEST-26 asserts this guard
  // against SYNTHETIC typed columns; nothing asserted it against a real decode).
  //
  // `sliceRevision` skips a column it does not recognise and fails OPEN, so an unconverted guard
  // anywhere on this cascade makes the digest a function of the column NAMES alone — constant
  // across every content change. viz then reuses its first dataset forever and the canvas
  // FREEZES with a clean console. This drives the REAL decoded slice through the REAL resolver:
  // the rev must move when the bytes move.
  it('a REALLY-decoded typed slice moves the canvas revision (the freeze guard, end to end)', async () => {
    const tree = loadTree(join(FIXTURES, 'table'))
    const groupMeta = JSON.parse(new TextDecoder().decode(tree.get('zarr.json')!)) as {
      attributes: { txr: unknown }
    }
    const structure = parseStructure('fixture', groupMeta.attributes.txr)
    const slice = await readColumnarTable('fixture', structure, { store: memoryStore(tree) })

    const spec = {
      id: 'rev.probe.decoded',
      canvas: {
        datasets: [{ id: 'frame' }],
        series: [
          { id: 's_a', type: 'violin', coordId: 'v_a', datasetId: 'frame', encode: { valueKey: 'f32col' } },
        ],
        grid: [{ id: 'v_a', region: { row: 0, col: 0 } }],
      },
    } as unknown as ViewSpec
    const revOf = (frame: Record<string, unknown>): string => {
      const feed = resolveDeclarativeCanvas(spec, {
        data: { frame },
        scope: { state: {}, derived: {}, const: {}, data: { frame } },
      })
      return String(((feed?.option.datasets ?? [])[0] as { rev?: unknown })?.rev ?? '')
    }

    const before = revOf(slice)
    // A ONE-VALUE edit of the decoded buffer — the smallest content change there is, on a fresh
    // object so the resolver's identity-keyed digest memo cannot answer from cache.
    const bumped = { ...slice, f32col: Float32Array.from(slice.f32col as ArrayLike<number>) }
    ;(bumped.f32col as Float32Array)[0] += 1
    expect(revOf(bumped), 'a typed column that does not reach the digest freezes the canvas').not.toBe(
      before,
    )
    // …and it is a DIGEST, not a counter: the same decoded bytes must answer the same.
    const again = await readColumnarTable('fixture', structure, { store: memoryStore(tree) })
    expect(revOf(again)).toBe(before)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE CORRESPONDENCE, ACROSS THE CAPABILITY CONTRACT (dimension-membership ITEM-16 / ITEM-19)
//
// This is the PRODUCER/CONSUMER crossing for the correspondence: CORE builds the
// `ColumnarFrameRead` (it cannot import the data extension — `lint-layer-boundary` R2), and the
// EXTENSION's REAL `makeColumnarFrameReader` interprets it. Both halves' own unit fixtures agree
// with themselves; what this case asserts is that they agree with EACH OTHER — that the segments
// core emits are the segments the reader turns into `value` channels, at the right indices, in
// the anchor's declared order.
//
// The byte layer below the channel is stubbed here and proven for real one file over
// (`workbenchStreamingSource.test.ts`'s TEST-20, against the fixture store).
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('axis_entry_values (ITEM-19) — the correspondence crosses core → extension', () => {
  const ROW_A = 'a'.repeat(64)
  const ROW_B = 'b'.repeat(64)
  const ENTRY_A = 'c'.repeat(64)
  const ENTRY_B = 'd'.repeat(64)
  const DIGEST_A = 'digest-rows-a'
  const DIGEST_B = 'digest-rows-b'

  const keyArtifact = (id: string, hash: string, axis: string, dataset: string, digest?: string) => ({
    id,
    project_id: 'p',
    datatype: 'demo/key',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: dataset,
    content_hash: hash,
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis,
      key: 'values',
      columns: [{ name: 'values', kind: 'string' }],
      ...(digest ? { key_sequence_digest: digest } : {}),
    },
  })

  /** A matrix indexed by (rows, entries), declaring `full` membership on its dataset's rows. */
  const matrix = (id: string, dataset: string, digest: string) => ({
    id,
    project_id: 'p',
    datatype: 'demo/matrix',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: dataset,
    meta: { name: 'counts' },
    structure: {
      encoding: 'zarr_v3',
      kind: 'sparse_csc',
      axes: ['rows', 'entries'],
      memberships: [{ axis: 'rows', aligned_to: digest, kind: 'full', n_members: 100 }],
    },
  })

  /** The INTEGRATED coordinate: a SUBSET of each dataset's rows, declared A then B. */
  const COORDINATE = {
    id: 'coord',
    project_id: 'p',
    datatype: 'demo/layout',
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds-1',
    content_hash: 'z'.repeat(64),
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      memberships: [
        { axis: 'rows', aligned_to: DIGEST_A, kind: 'subset', n_members: 6, members: 'mem-a' },
        { axis: 'rows', aligned_to: DIGEST_B, kind: 'subset', n_members: 4, members: 'mem-b' },
      ],
    },
  }

  const ARTIFACTS = [
    keyArtifact('k-rows-a', ROW_A, 'rows', 'ds-1', DIGEST_A),
    keyArtifact('k-rows-b', ROW_B, 'rows', 'ds-2', DIGEST_B),
    keyArtifact('k-entries-a', ENTRY_A, 'entries', 'ds-1'),
    keyArtifact('k-entries-b', ENTRY_B, 'entries', 'ds-2'),
    matrix('mat-a', 'ds-1', DIGEST_A),
    matrix('mat-b', 'ds-2', DIGEST_B),
    COORDINATE,
  ]

  const CATALOG = {
    axes: [
      { content_hash: ROW_A, name: 'rows', length: 100 },
      { content_hash: ROW_B, name: 'rows', length: 90 },
      { content_hash: ENTRY_A, name: 'entries', length: 3 },
      { content_hash: ENTRY_B, name: 'entries', length: 3 },
    ],
  }

  /** THE ENTRY KEYS, IN DIFFERENT ORDERS PER DATASET — which is the whole of INV-6. `e1` is at
   *  index 1 on ds1's axis and index 2 on ds2's, so an index-identity read is distinguishable
   *  from a correspondence. A same-order fixture would pass both. */
  const KEYS: Record<string, readonly string[]> = {
    'k-entries-a': ['e0', 'e1', 'e2'],
    'k-entries-b': ['e2', 'e0', 'e1'],
  }

  function correspondenceApi(seen: { read?: unknown }): WorkbenchAPI {
    const capabilities = createCapabilityBroker()
    capabilities.publish('data', '1.0.0', {
      artifacts: { query: async () => ARTIFACTS },
      catalog: async () => CATALOG,
      // The REAL reader, over a streaming source that answers each segment's channel with a
      // recognisable run. Nothing here re-implements the mapping under test.
      readColumnarFrame: makeColumnarFrameReader(
        () =>
          ({
            streaming: {
              stream: (channel: { kind: string; members?: { segments: { of: { key: string }; count: number }[] } }) => {
                seen.read = channel
                const segments = channel.members?.segments ?? []
                const out: number[] = []
                for (const segment of segments) {
                  // Each row of a segment carries its own channel KEY's column index, so the
                  // returned values NAME the column each side was read at.
                  const index = Number(segment.of.key.slice(segment.of.key.lastIndexOf('#') + 1))
                  for (let i = 0; i < segment.count; i++) out.push(index)
                }
                const values = Float32Array.from(out)
                return (async function* () {
                  yield new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
                })()
              },
            },
          }) as unknown as Parameters<typeof makeColumnarFrameReader>[0] extends () => infer S ? S : never,
      ),
    })
    return { capabilities } as unknown as WorkbenchAPI
  }

  beforeEach(() => {
    readerMock.readColumn.mockReset()
    // `entryKeysOf` reads each sibling axis's key column through the typed surface.
    readerMock.readColumn.mockImplementation(async ({ id }: { id: string }) => ({
      readAll: async () => KEYS[id] ?? [],
    }))
    __resetViewDataForTests()
    __resetEntryKeysForTests()
  })

  const scope = {
    scope: { axis: [ROW_A, ROW_B], coordinate: COORDINATE.id },
    state: { chosen: ['e1'] },
  }

  it('emits ONE segment per row space, each at ITS OWN column index, in the anchor`s order', async () => {
    const seen: { read?: unknown } = {}
    const res = await readSliceFromApi(
      correspondenceApi(seen),
      'values',
      {
        source: 'axis_entry_values',
        args: { axis_of: '$scope.axis', axis: 'entries', entries: '$state.chosen' },
      },
      scope,
    )
    expect(res?.status).toBe('ready')
    const channel = seen.read as { kind: string; members: { segments: { of: { key: string }; member: string; count: number }[] } }
    expect(channel.kind).toBe('members')
    // ds1's matrix at index 1 (`e1`'s position on ds1's axis) and ds2's at index 2 (its position
    // on ds2's, which lists the keys in a different order). An index-identity implementation
    // sends `#1` for both — same length, same type, wrong for every row of side B.
    expect(channel.members.segments.map(s => s.of.key)).toEqual(['mat-a#1', 'mat-b#2'])
    // The membership triple and the SEQUENCE come off the COORDINATE, in its declared order.
    expect(channel.members.segments.map(s => s.member)).toEqual(['mem-a', 'mem-b'])
    expect(channel.members.segments.map(s => s.count)).toEqual([6, 4])
  })

  it('lands ONE column whose rows are side A`s then side B`s, at the gathered length', async () => {
    const res = await readSliceFromApi(
      correspondenceApi({}),
      'values',
      {
        source: 'axis_entry_values',
        args: { axis_of: '$scope.axis', axis: 'entries', entries: '$state.chosen' },
      },
      scope,
    )
    const frame = (res as { payload: Record<string, readonly number[]> }).payload
    // ONE offer — the two datasets' same-named matrices are ONE source, not two halves the
    // reader has to reconcile.
    expect(Object.keys(frame)).toHaveLength(1)
    const values = Object.values(frame).reduce(first => first)
    // 6 rows carrying ds1's column index, then 4 carrying ds2's — the coordinate's own row
    // sequence, in the coordinate's own declared segment order.
    expect([...values]).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2])
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════
// incremental-landing (#29) — accumulation + per-slice epoch + partial merge (ITEM-1/2/6)
// ════════════════════════════════════════════════════════════════════════════════════════════

function accSpec(): ViewSpec {
  return {
    id: 'x/acc',
    title: 'Acc',
    permission: 'jobs::use',
    state: {},
    const: {},
    derived: {},
    widgets: [],
    actions: [],
  } as unknown as ViewSpec
}

describe('TEST-2/3 — chunk accumulation + per-slice epoch (ITEM-2)', () => {
  it('TEST-2: two chunks of one slice ACCUMULATE — chunk 1 rows survive chunk 2', () => {
    const store = createViewStore(accSpec(), 'v-acc')
    registerViewStore('v-acc', store)
    const epoch = beginViewDataLanding('v-acc')
    landViewDataChunk('v-acc', { s: { c: [1, 2] } }, { done: false, epoch })
    // Chunks are CUMULATIVE (the producer accumulates the stream). After chunk 2, chunk 1's rows
    // (1, 2) must STILL be present AND not duplicated — a wholesale replace would drop them, a
    // delta-append fed cumulative prefixes would produce [1,2,1,2,3,4].
    landViewDataChunk('v-acc', { s: { c: [1, 2, 3, 4] } }, { done: true, epoch })
    expect(store.data).toEqual({ s: { c: [1, 2, 3, 4] } })
    expect(store.dataStatus).toBe('ready')
  })

  it('TEST-3: a SUPERSEDED slice\'s late chunk is DISCARDED while the live slice keeps accumulating', () => {
    const store = createViewStore(accSpec(), 'v-sup-vd')
    registerViewStore('v-sup-vd', store)
    const e1 = beginViewDataLanding('v-sup-vd')
    landViewDataChunk('v-sup-vd', { s: { c: [1] } }, { done: false, epoch: e1 })
    // A new landing supersedes e1.
    const e2 = beginViewDataLanding('v-sup-vd')
    landViewDataChunk('v-sup-vd', { s: { c: [2] } }, { done: false, epoch: e2 })
    // The LATE straggler from e1 must be discarded (per-slice epoch guard) — not corrupt the frame.
    landViewDataChunk('v-sup-vd', { s: { c: [999] } }, { done: false, epoch: e1 })
    // The LIVE (e2) slice continues (CUMULATIVE: rows 0..1 of its own sequence).
    landViewDataChunk('v-sup-vd', { s: { c: [2, 3] } }, { done: true, epoch: e2 })
    expect(store.data).toEqual({ s: { c: [2, 3] } })
  })
})

describe('TEST-8 — a partial resolution takes the MERGE branch, never wholesale-replace (ITEM-1)', () => {
  it('partial (like error/unreadable) KEEPS prior slices and merges the new one; ready REPLACES', () => {
    const prior = { a: { x: [1] }, b: { y: [2] } }
    // PARTIAL: the second landing carries only slice `b`; slice `a` must survive (more is coming).
    const merged = landedData(prior, 'partial', { b: { y: [2, 3] } })
    expect(merged).toEqual({ a: { x: [1] }, b: { y: [2, 3] } })
    // NEGATIVE CONTROL: the silent-fallthrough would hit the else (replace) and DISCARD slice `a`.
    // `ready` is that replace branch — so the same call under `ready` proves the branch differs.
    const replaced = landedData(prior, 'ready', { b: { y: [2, 3] } })
    expect(replaced).toEqual({ b: { y: [2, 3] } })
    // error/unreadable share the merge arm (regression guard).
    expect(landedData(prior, 'error', { b: { y: [9] } })).toEqual({ a: { x: [1] }, b: { y: [9] } })
    expect(landedData(prior, 'unreadable', {})).toEqual(prior)
  })
})

describe('TEST-18 — the tree\'s wholesale-landing STATEMENT matches the renegotiated behaviour (ITEM-6)', () => {
  it('canvasFeed.ts no longer asserts an unconditional "replaced wholesale"; it names the incremental replace, and the behaviour matches', () => {
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), '../../extensions/canvas/canvasFeed.ts'),
      'utf8',
    )
    // The amended statement acknowledges the renegotiated (incremental) landing and the
    // replace-not-mutate discipline INV-10 rests on. NOT a bare string-presence guard: the
    // behaviour it describes is exercised below, and would diverge from the text if broken.
    expect(src).toMatch(/incremental/i)
    expect(src).toMatch(/never a mutation in place|never mutated in place/i)
    // BEHAVIOUR the statement describes: a landing REPLACES the slice object (new identity), never
    // mutates it — so the content-digest memo re-reads it. Exercised on the real store landing path.
    const store = createViewStore(accSpec(), 'v-reconcile')
    registerViewStore('v-reconcile', store)
    const epoch = beginViewDataLanding('v-reconcile')
    landViewDataChunk('v-reconcile', { s: { c: [1] } }, { done: false, epoch })
    const first = store.data
    landViewDataChunk('v-reconcile', { s: { c: [1, 2] } }, { done: true, epoch }) // CUMULATIVE
    expect(store.data).not.toBe(first) // replaced, not mutated in place
    expect(store.data).toEqual({ s: { c: [1, 2] } })
  })
})
