// workbenchStreamingSource.test.ts — TEST-1..7, 9, 10 (ITEM-1..7).
//
// The oracle throughout is the PULL source. `streamingFixtures.test.ts:24` set the bar for a
// `StreamingSource` in this codebase — byte-parity between `asDataSource(streaming)` and the
// equivalent pull method — and this holds the app's source to the same one, against the SHIPPING
// Python writer's bytes (`core/workstore/__fixtures__/zarr/`, produced by `txr_zarr`), not
// against a sketch of them.
//
// ONLY the octet boundary is faked. Every decode — the shard index, the gzip inflate, the
// unshuffle, the categorical level resolution, the CSC window arithmetic — runs for real, on both
// sides of every comparison. A test that mocked the decode would compare two copies of the same
// mock.
//
// ── THE STANDING CHECK: what does each of these do when the DEFECT is present? ──────
//
// Recorded per test below, because this branch has produced four tests that would have shipped
// the bug they were written for. The shapes that keep coming back, and where each is answered:
//
//   • a proxy standing in for the property — TEST-7 counts DECODES, not requests: artifact bytes
//     are `immutable`, so a duplicate read issues no second request and a request-count test
//     reads 1 whether the multicast works or not.
//   • an assertion that cannot go red — TEST-10's second leg. An implementation that tore the
//     whole read down on any abort passes a single-consumer abort test.
//   • a vacuous loop — TEST-2 enumerates channels from the CATALOG and asserts the enumeration
//     is non-empty, so a catalog that lost its channels fails instead of passing over nothing.
//   • a stub that was never armed — TEST-4 asserts the throwing `fetch` stub DOES fire when viz's
//     `streamBinaryColumn` is called directly.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@txresbench/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import {
  asDataSource,
  collectStream,
  reframeBytes,
  streamBinaryColumn,
  type Channel,
  type MembersRef,
} from '@txresbench/viz'
import { datatypeRegistry, type Datatype } from '@/core/datatypes'
import {
  __resetArtifactArrayCache,
  decodeCounts,
  enableDecodeCounter,
  memoryStore,
  readCategoricalColumn,
  readDeclaredLevels,
  readMemberIndex,
  streamGatheredNumericBytes,
  readNumericColumn,
  readPositions,
  readSparseColumn,
  resetDecodeCounts,
  streamNumericBytes,
  streamPositionBytes,
  type ZarrStore,
} from '@/core/workstore'
import {
  WorkbenchDataSource,
  type DataPlaneArtifact,
  type WorkbenchDataSourceDeps,
} from './workbenchDataSource'
import {
  WorkbenchStreamingSource,
  type WorkbenchStreamingDeps,
  type StreamProgress,
} from './workbenchStreamingSource'
import { readColumnValues } from '@/modules/workbench/core/runtime/columnValues'
import type { ArtifactRow } from '@/modules/workbench/core'
import { makeColumnarFrameReader } from './columnarRead'
import { createDataApi } from './dataCapability'
import type { DataApi, DataHost } from './contract'
import type { ProjectSources } from './projectSources'

// ── the fixture data plane ──────────────────────────────────────────────────────

const FIXTURES = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'core',
  'workstore',
  '__fixtures__',
  'zarr',
)

/** The whole fixture tree as `{ storePath → bytes }` — the same paths `/data/{*member}` serves. */
function loadFixtureTree(root: string): Map<string, Uint8Array> {
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

const FIXTURE_FILES = loadFixtureTree(FIXTURES)

/** A store that records every path it is asked for, so a test can assert on the READS a channel
 *  issues rather than on the values it returns — which is the only way to see the difference
 *  between a bounded CSC window and a whole-matrix read (TEST-6), or between an abort that stops
 *  the network and one that discards results (TEST-10). */
function recordingStore(): { store: ZarrStore; calls: string[] } {
  const inner = memoryStore(FIXTURE_FILES)
  const calls: string[] = []
  return {
    calls,
    store: {
      get: path => {
        calls.push(path)
        return inner.get(path)
      },
      getRange: (path, start, length) => {
        calls.push(`${path}@${start}+${length}`)
        return inner.getRange(path, start, length)
      },
      getSuffix: (path, length) => {
        calls.push(`${path}@-${length}`)
        return inner.getSuffix(path, length)
      },
    },
  }
}

const ROW_AXIS = 'rows'
const ROW_AXIS_HASH = 'h-rows'
/** The CSC fixture spans 5000 rows, and the value channel's dense length is the ROW axis. It is
 *  also what bounds `decodeSparseColumnStream`'s eager allocation (`nnz ≤ length`), so a smaller
 *  axis here would make the value channel throw on a legitimate column. */
const N_ROWS = 5000

const LAYOUT_ID = 'a-layout'
const CONTINUOUS_ID = 'a-continuous'
const CATEGORICAL_ID = 'a-categorical'
const VALUE_ID = 'a-value'

/** `f32_rowchunk_2d` is `(48 × 2)` chunked `[32, 2]` — TWO inner chunks, which is what makes every
 *  progressive claim below non-vacuous. The fixture rule in TESTS.md is asserted, not assumed:
 *  see `it('the fixtures are genuinely multi-chunk')`. */
const LAYOUT_MEMBER = 'f32_rowchunk_2d'
/** `table/f32col` is 500 rows chunked 128 — FOUR inner chunks. */
const CONTINUOUS_MEMBER = 'table/f32col'
/** `table/cat8` declares its level set, including `NEVER-OBSERVED` (a declared level with zero
 *  rows) — the DEC-8 case: the levels ride the catalog and cannot be recovered from the codes. */
const CATEGORICAL_MEMBER = 'table/cat8'

const ARTIFACTS: DataPlaneArtifact[] = [
  {
    id: LAYOUT_ID,
    datatype: 'demo/layout',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ROW_AXIS,
      arrays: [{ path: LAYOUT_MEMBER, kind: 'numeric', dtype: 'float32', shape: [48, 2] }],
    },
  },
  {
    id: CONTINUOUS_ID,
    datatype: 'demo/column',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ROW_AXIS,
      columns: [{ path: CONTINUOUS_MEMBER, kind: 'numeric', dtype: 'float32', shape: [500] }],
    },
  },
  {
    id: CATEGORICAL_ID,
    datatype: 'demo/grouping',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ROW_AXIS,
      columns: [{ path: CATEGORICAL_MEMBER, kind: 'categorical', dtype: 'uint8', shape: [500] }],
    },
  },
  {
    id: VALUE_ID,
    datatype: 'demo/matrix',
    structure: {
      encoding: 'zarr_v3',
      kind: 'sparse_csc',
      axes: [ROW_AXIS, 'columns'],
      shape: [N_ROWS, 5],
      indptr: { path: 'csc/indptr', kind: 'numeric', dtype: 'int64', shape: [6] },
      indices: { path: 'csc/indices', kind: 'numeric', dtype: 'uint32', shape: [5000] },
      data: { path: 'csc/data', kind: 'numeric', dtype: 'float32', shape: [5000] },
    },
  },
]

const DATATYPE_CAPS: Record<string, string[]> = {
  'demo/layout': ['rows-aligned', 'plottable-xy'],
  'demo/column': ['rows-aligned', 'continuous-column'],
  'demo/grouping': ['rows-aligned', 'categorical'],
  'demo/matrix': ['rows-aligned'],
}

function demoDatatype(id: string): Datatype {
  return {
    id,
    extends: null,
    title: id,
    description: id,
    storage: {
      layout: { kind: 'chunked_dense' },
      format: 'zarr',
      selector_map: {},
      file_layout: 'single',
      tiers: [],
    },
    capabilities: [],
    viewers: [],
    converters: [],
    is_abstract: false,
  } as unknown as Datatype
}

function registerDatatypes(): void {
  const types = Object.keys(DATATYPE_CAPS).map(demoDatatype)
  const ids = new Set(types.map(t => t.id))
  datatypeRegistry.replaceAll([...datatypeRegistry.all().filter(t => !ids.has(t.id)), ...types])
}

/** The pull source's deps, with every byte read pointed at the injected store. The streaming
 *  source is compared against THIS — same bytes, same decoders, so a difference is a difference
 *  in the source under test and nothing else. */
function pullDeps(store: ZarrStore): WorkbenchDataSourceDeps {
  return {
    getCatalog: async () => ({
      axes: [{ content_hash: ROW_AXIS_HASH, name: ROW_AXIS, length: N_ROWS }],
      artifacts: ARTIFACTS,
    }),
    getArtifact: async id => {
      const hit = ARTIFACTS.find(a => a.id === id)
      if (!hit) throw new Error(`no fixture artifact ${id}`)
      return hit
    },
    // #159 — these fixtures declare no raster, so nothing should ever reach the reader. A
    // throwing stub rather than a silent `null`: if a change ever makes a non-raster fixture
    // try to open one, that is a discovery bug and it should be loud here.
    openPyramid: async artifactId => {
      throw new Error(`the fixture plane declares no raster; nothing should open ${artifactId}`)
    },
    fetchArtifactBytes: async id => {
      throw new Error(`the fixture plane has no opaque bytes for ${id}`)
    },
    hasCapability: (datatypeId, capability) =>
      DATATYPE_CAPS[datatypeId]?.includes(capability) ?? false,
    // #229 — no fixture here declares a view kind; every raster stays a picture.
    viewKindsFor: () => [],
    readSparseColumn: (id, col, structure) => readSparseColumn(id, col, structure, { store }),
    readCategorical: (id, structure, column) =>
      readCategoricalColumn(id, structure, column, { store }),
    readPositions: (id, structure, onChunk) =>
      readPositions(id, structure, undefined, { onChunk, store }),
    readNumeric: (id, structure, onChunk) =>
      readNumericColumn(id, structure, undefined, { onChunk, store }),
    rowAxisFor: () => ROW_AXIS,
  }
}

/** The streaming source's deps, pointed at the SAME store. Only the byte boundary is injected —
 *  `streamPositionBytes` / `streamNumericBytes` / `readCategoricalColumn` / `readSparseColumn`
 *  are the production functions. */
function streamDeps(store: ZarrStore): Partial<WorkbenchStreamingDeps> {
  return {
    streamPositions: (id, structure, signal) =>
      streamPositionBytes(id, structure, undefined, { signal, store }),
    streamNumeric: (id, structure, signal) =>
      streamNumericBytes(id, structure, undefined, { signal, store }),
    readCategorical: (id, structure, column) =>
      readCategoricalColumn(id, structure, column, { store }),
    readSparse: (id, col, structure) => readSparseColumn(id, col, structure, { store }),
    declaredLevels: (id, memberPath) => readDeclaredLevels(id, memberPath, { store }),
    readMembers: (id, structure, member) => readMemberIndex(id, structure, member, { store }),
    streamGathered: (id, structure, members, signal) =>
      streamGatheredNumericBytes(id, structure, members, undefined, { signal, store }),
  }
}

interface Rig {
  pull: WorkbenchDataSource
  source: WorkbenchStreamingSource
  calls: string[]
  /** the SAME store the source reads through — so a control can issue a SECOND, independent read
   *  of the same bytes and show it costs a second decode (TEST-54). */
  store: ZarrStore
}

function rig(): Rig {
  const { store, calls } = recordingStore()
  const pull = new WorkbenchDataSource('p-stream', pullDeps(store))
  const source = new WorkbenchStreamingSource('p-stream', { pull, deps: streamDeps(store) })
  return { pull, source, calls, store }
}

async function chunksOf(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const chunk of iterable) out.push(new Uint8Array(chunk))
  return out
}

beforeEach(() => {
  registerDatatypes()
  // Member arrays are cached PROCESS-WIDE by artifact id, and the decoded-chunk LRU rides on
  // them — so a case asserting on decodes or on reads must start cold or it measures the
  // previous case's cache.
  __resetArtifactArrayCache()
  resetDecodeCounts()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ══════════════════════════════════════════════════════════════════════════════════
// the fixture rule (TESTS.md) — asserted, so no progressive claim below is vacuous
// ══════════════════════════════════════════════════════════════════════════════════

describe('fixture precondition', () => {
  it('the positions and continuous fixtures are genuinely MULTI-chunk', async () => {
    const { source } = rig()
    const positions = await chunksOf(source.stream({ kind: 'positions', layout: LAYOUT_ID }))
    const continuous = await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    // A single-chunk fixture makes "it arrives in stages" unfalsifiable. This is the guard
    // `progressive-render.spec.ts:56-59` states for the e2e, applied to the unit suite.
    expect(positions.length, 'positions fixture must span >1 inner chunk').toBeGreaterThan(1)
    expect(continuous.length, 'continuous fixture must span >1 inner chunk').toBeGreaterThan(1)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-1 [covers: ITEM-1] — the control plane is a drop-in
// ══════════════════════════════════════════════════════════════════════════════════

describe('TEST-1 (ITEM-1) — catalog() is the pull source`s, channel for channel', () => {
  it('returns the SAME four channel sets and the same composite keys', async () => {
    const { pull, source } = rig()
    const a = await pull.catalog()
    const b = await source.catalog()

    expect(b.datasetId).toBe(a.datasetId)
    expect(b.pointCount).toBe(a.pointCount)
    expect(b.layouts.map(l => l.id)).toEqual(a.layouts.map(l => l.id))
    expect(b.continuousColumns.map(c => c.id)).toEqual(a.continuousColumns.map(c => c.id))
    expect(b.categoricalColumns.map(c => c.id)).toEqual(a.categoricalColumns.map(c => c.id))
    expect(b.valueColumns).toEqual(a.valueColumns)
    // Non-vacuity: every one of the four sets is actually populated, so a catalog that lost a
    // channel could not pass this by comparing two empties.
    expect(b.layouts.length).toBeGreaterThan(0)
    expect(b.continuousColumns.length).toBeGreaterThan(0)
    expect(b.categoricalColumns.length).toBeGreaterThan(0)
    expect(b.valueColumns.length).toBeGreaterThan(0)
  })

  it('ADDS only what a headerless stream cannot self-describe (DEC-10)', async () => {
    const { source } = rig()
    const cat = await source.catalog()
    for (const layout of cat.layouts) {
      expect(layout.encoding, 'a layout must declare its stream encoding').toEqual({
        kind: 'f32',
        stride: 8,
      })
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-2 [acceptance] [INV-1] [covers: ITEM-1, ITEM-4, ITEM-5]
// ══════════════════════════════════════════════════════════════════════════════════

/** Every channel the CATALOG advertises, derived — never a hand-written list. A channel added
 *  later with a non-streaming entry fails here rather than going unnoticed (INV-1's forcing
 *  function, and the reason DEC-2 puts the enumeration on the catalog). */
async function channelsFromCatalog(source: WorkbenchStreamingSource): Promise<Channel[]> {
  const cat = await source.catalog()
  return [
    ...cat.layouts.map((l): Channel => ({ kind: 'positions', layout: l.id })),
    ...cat.continuousColumns.map((c): Channel => ({ kind: 'continuous', key: c.id })),
    ...cat.categoricalColumns.map((c): Channel => ({ kind: 'categorical', key: c.id })),
    ...cat.valueColumns.map((k): Channel => ({ kind: 'value', key: k })),
  ]
}

describe('TEST-2 [acceptance] (INV-1) — EVERY advertised channel decodes byte-identically', () => {
  it('asDataSource(streaming) equals the pull source, for every channel the catalog names', async () => {
    const { pull, source } = rig()
    const adapted = asDataSource(source)
    const channels = await channelsFromCatalog(source)
    // The loop's own non-vacuity. A catalog that returned nothing would otherwise iterate zero
    // times and pass while asserting nothing — the failure DRIFT-1.27 records.
    expect(channels.length, 'the catalog must advertise channels to compare').toBeGreaterThan(3)

    for (const channel of channels) {
      switch (channel.kind) {
        case 'positions': {
          const want = await pull.positions(channel.layout)
          const got = await adapted.positions(channel.layout)
          expect(got.length, `positions length for ${channel.layout}`).toBe(want.length)
          expect(Array.from(got.positions), `positions bytes for ${channel.layout}`).toEqual(
            Array.from(want.positions),
          )
          break
        }
        case 'continuous': {
          const want = await pull.continuous(channel.key)
          const got = await adapted.continuous(channel.key)
          expect(Array.from(got.value), `continuous values for ${channel.key}`).toEqual(
            Array.from(want.value),
          )
          break
        }
        case 'categorical': {
          const want = await pull.categorical(channel.key)
          const got = await adapted.categorical(channel.key)
          expect(Array.from(got.codes), `categorical codes for ${channel.key}`).toEqual(
            Array.from(want.codes),
          )
          // The level set is the half that only exists because it rides the CATALOG (DEC-8).
          // A source that streamed codes and left `categories` to `?? []` would pass the codes
          // comparison and paint every point as an unnamed category.
          expect(got.categories, `categorical levels for ${channel.key}`).toEqual(want.categories)
          expect(got.categories.length).toBeGreaterThan(0)
          break
        }
        case 'value': {
          const want = await pull.valueColumn(channel.key)
          const got = await adapted.valueColumn(channel.key)
          expect(Array.from(got.row), `value rows for ${channel.key}`).toEqual(Array.from(want.row))
          expect(Array.from(got.value), `value data for ${channel.key}`).toEqual(
            Array.from(want.value),
          )
          expect(got.length, `value dense length for ${channel.key}`).toBe(want.length)
          break
        }
        default:
          throw new Error(`the catalog advertised an unhandled channel ${JSON.stringify(channel)}`)
      }
    }
  })

  it('there is NO read path that bypasses stream() — the two one-chunk channels included', async () => {
    const { source } = rig()
    const cat = await source.catalog()
    // Addressed by NAME, and asserted to be present, rather than by position — a catalog is a
    // DECLARED collection and its order promises nothing.
    const valueKey = `${VALUE_ID}#0`
    const categoricalKey = `${CATEGORICAL_ID}#${CATEGORICAL_MEMBER}`
    expect(cat.valueColumns).toContain(valueKey)
    expect(cat.categoricalColumns.map(c => c.id)).toContain(categoricalKey)
    // A `value` column is a bounded random-access read (INV-5) and a categorical's codes are
    // read whole — both are ONE chunk. That is not an exemption from the streaming entry, it IS
    // the streaming entry: they arrive through `stream()` like everything else, which is what
    // keeps DEC-2's forcing function true.
    const value = await chunksOf(source.stream({ kind: 'value', key: valueKey }))
    const categorical = await chunksOf(source.stream({ kind: 'categorical', key: categoricalKey }))
    expect(value).toHaveLength(1)
    expect(categorical).toHaveLength(1)
    expect(value[0].byteLength).toBeGreaterThan(0)
    expect(categorical[0].byteLength).toBeGreaterThan(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-3 [covers: ITEM-2, ITEM-3] — the genuinely chunked channels
// ══════════════════════════════════════════════════════════════════════════════════

describe('TEST-3 (ITEM-2/3) — positions and continuous yield MORE THAN ONE chunk', () => {
  it('the concatenation is byte-for-byte the pull read', async () => {
    const { pull, source } = rig()

    const positionChunks = await chunksOf(source.stream({ kind: 'positions', layout: LAYOUT_ID }))
    expect(positionChunks.length).toBeGreaterThan(1)
    const positionBytes = await collectStream(
      (async function* () {
        for (const c of positionChunks) yield c
      })(),
    )
    const wantPositions = await pull.positions(LAYOUT_ID)
    expect(Array.from(new Float32Array(positionBytes.slice().buffer))).toEqual(
      Array.from(wantPositions.positions),
    )

    const continuousChunks = await chunksOf(
      source.stream({ kind: 'continuous', key: CONTINUOUS_ID }),
    )
    expect(continuousChunks.length).toBeGreaterThan(1)
    const continuousBytes = await collectStream(
      (async function* () {
        for (const c of continuousChunks) yield c
      })(),
    )
    const wantContinuous = await pull.continuous(CONTINUOUS_ID)
    expect(Array.from(new Float32Array(continuousBytes.slice().buffer))).toEqual(
      Array.from(wantContinuous.value),
    )
  })

  it('a chunk is a whole number of ROWS — the alignment the raster indexes by', async () => {
    const { source } = rig()
    const chunks = await chunksOf(source.stream({ kind: 'positions', layout: LAYOUT_ID }))
    for (const chunk of chunks) {
      // 8 bytes per point (f32 xy). A chunk carrying a fraction of a point would shift every
      // later point by part of a row and still render as a plot.
      expect(chunk.byteLength % 8).toBe(0)
    }
  })

  it('refuses a member with fewer than two values per entity', async () => {
    const { source } = rig()
    // `table/f32col` is a 1-D column — a layout needs `(n × dims)`. The refusal is BY NAME
    // rather than a silent reinterpretation of the bytes at the wrong stride.
    const bad = source.stream({ kind: 'positions', layout: CONTINUOUS_ID })
    await expect(chunksOf(bad)).rejects.toThrow(/needs at least 2|value\(s\) per entity/)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-4 [acceptance] [INV-7] [covers: ITEM-1] — the transport is the generated client
// ══════════════════════════════════════════════════════════════════════════════════

describe('TEST-4 [acceptance] (INV-7) — no channel reaches a bare `fetch`', () => {
  // The invariant as TESTS.md states it — "with `globalThis.fetch` replaced by a throwing stub
  // and `ApiClient` the only working transport" — is not literally constructible, because the
  // generated client is itself built on `fetch`. What it MEANS is constructible and is what is
  // asserted: the source must reach the endpoint only through the injected/generated read path,
  // never through ambient `fetch`. The sibling half — that `binaryClient`'s streaming read
  // really does travel `ApiClient.Workstore.*` over the real transport — is TEST-20's, in
  // `binaryClient.test.ts`, where the network rather than the store is stubbed.
  it('every channel still streams with ambient `fetch` armed to throw', async () => {
    let fetchCalls = 0
    vi.stubGlobal('fetch', () => {
      fetchCalls++
      throw new Error('ambient fetch is not a transport this source may use')
    })
    const { source } = rig()
    const channels = await channelsFromCatalog(source)
    expect(channels.length).toBeGreaterThan(3)
    for (const channel of channels) {
      const chunks = await chunksOf(source.stream(channel))
      expect(chunks.length, `channel ${JSON.stringify(channel)} produced no bytes`).toBeGreaterThan(
        0,
      )
    }
    expect(fetchCalls, 'a channel reached ambient fetch').toBe(0)
  })

  it('NEGATIVE CONTROL — the stub fires when viz`s unauthenticated reader is called directly', async () => {
    let fetchCalls = 0
    vi.stubGlobal('fetch', () => {
      fetchCalls++
      throw new Error('ambient fetch is not a transport this source may use')
    })
    // Without this leg the test above would pass against a stub that was never armed — the
    // "a test that cannot fail" shape. `streamBinaryColumn` is exactly the path INV-7 forbids:
    // no bearer, no base URL, against a permission-gated route.
    await expect(
      (async () => {
        for await (const _ of streamBinaryColumn('/api/artifacts/x/data', {
          bytesPerRow: 8,
          fetchImpl: globalThis.fetch,
        })) {
          void _
        }
      })(),
    ).rejects.toThrow(/not a transport/)
    expect(fetchCalls, 'the stub was never armed').toBeGreaterThan(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-5 [acceptance] [INV-3] [covers: ITEM-2] — alignment ACROSS two channels
// ══════════════════════════════════════════════════════════════════════════════════

describe('TEST-5 [acceptance] (INV-3) — batch k covers the same row window in every channel', () => {
  it('reframed windows are contiguous, in order, non-overlapping and cover the whole column', async () => {
    const { source } = rig()

    /** Reframe a channel at its stride and read off the row windows. `reframeBytes` is viz's own
     *  boundary-carry implementation — hand-rolling one here would test the test. */
    async function windows(
      channel: Channel,
      bytesPerRow: number,
    ): Promise<Array<{ offset: number; length: number }>> {
      const out: Array<{ offset: number; length: number }> = []
      // `rowsPerBatch` is stated rather than defaulted. The default is 65536 rows, which
      // coalesces every fixture here into ONE batch — and a single-batch run cannot fail an
      // alignment assertion, so leaving it default would have made this test vacuous.
      for await (const batch of reframeBytes(source.stream(channel), {
        bytesPerRow,
        rowsPerBatch: 16,
      })) {
        out.push({ offset: batch.offset, length: batch.rows })
      }
      return out
    }

    const positions = await windows({ kind: 'positions', layout: LAYOUT_ID }, 8)
    const continuous = await windows({ kind: 'continuous', key: CONTINUOUS_ID }, 4)

    for (const [name, batches] of [
      ['positions', positions],
      ['continuous', continuous],
    ] as const) {
      expect(batches.length, `${name} produced no batches`).toBeGreaterThan(1)
      let cursor = 0
      for (const batch of batches) {
        expect(batch.offset, `${name} batch is not contiguous with its predecessor`).toBe(cursor)
        expect(batch.length).toBeGreaterThan(0)
        cursor += batch.length
      }
    }

    // The cross-channel half. A single-channel assertion cannot fail on MISALIGNMENT — every
    // channel is trivially contiguous with itself. This is the one that bites: both channels
    // must partition THEIR OWN row space starting from the same origin, so row i in one names
    // the same entity as row i in the other.
    expect(positions[0].offset).toBe(0)
    expect(continuous[0].offset).toBe(0)
    const positionRows = positions.reduce((n, b) => n + b.length, 0)
    const continuousRows = continuous.reduce((n, b) => n + b.length, 0)
    const pull = await rig().pull.positions(LAYOUT_ID)
    expect(positionRows, 'positions did not cover every row exactly once').toBe(pull.length)
    expect(continuousRows).toBe(500)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-6 [acceptance] [INV-5] [covers: ITEM-5] — the value channel is BOUNDED
// ══════════════════════════════════════════════════════════════════════════════════

describe('TEST-6 [acceptance] (INV-5) — a value column reads its window, never the matrix', () => {
  it('reads only indptr[col..col+2] plus that column`s two element ranges', async () => {
    const { source, calls } = rig()
    const cat = await source.catalog()
    // By NAME. Column 1 of the CSC fixture, chosen because it is neither the first nor the last
    // — a bug that read `indptr[0..2]` regardless would still look right on column 0.
    const key = `${VALUE_ID}#1`
    expect(cat.valueColumns).toContain(key)
    calls.length = 0
    const chunks = await chunksOf(source.stream({ kind: 'value', key }))
    expect(chunks).toHaveLength(1)

    const payload = calls.filter(c => c.includes('/c/'))
    expect(payload.length, 'the value channel issued no payload read at all').toBeGreaterThan(0)
    // The property, not a proxy for it: the BYTES this column costs are bounded by its own
    // non-zeros, not by the matrix. Flipping the source to a whole-matrix read leaves every
    // returned value correct and turns this red — which is the only thing that distinguishes
    // the two (`readSparseColumn`'s own guard is about correctness, not about extent).
    const wire = chunks[0]
    const nnz = new DataView(wire.buffer, wire.byteOffset).getUint32(0, true)
    expect(nnz).toBeGreaterThan(0)
    expect(nnz, 'one column of the fixture holds fewer non-zeros than the whole matrix').toBeLessThan(
      5000,
    )
    expect(wire.byteLength).toBe(4 + nnz * 8)
    // Nothing outside the CSC trio was touched.
    expect(payload.every(c => c.startsWith('csc/'))).toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-7 [acceptance] [INV-2] [covers: ITEM-6] — the multicast, counted in DECODES
// ══════════════════════════════════════════════════════════════════════════════════

function totalDecodes(): number {
  return Object.values(decodeCounts()).reduce((a, b) => a + b, 0)
}

describe('TEST-7 [acceptance] (INV-2) — one decode per column, however many readers', () => {
  beforeEach(() => {
    enableDecodeCounter()
    resetDecodeCounts()
  })

  it('(a) three CONCURRENT consumers of one channel produce ONE decode and identical bytes', async () => {
    const { source } = rig()
    const channel: Channel = { kind: 'positions', layout: LAYOUT_ID }
    const [a, b, c] = await Promise.all([
      chunksOf(source.stream(channel)),
      chunksOf(source.stream(channel)),
      chunksOf(source.stream(channel)),
    ])
    const flat = (chunks: Uint8Array[]): number[] => chunks.flatMap(x => Array.from(x))
    expect(flat(b)).toEqual(flat(a))
    expect(flat(c)).toEqual(flat(a))
    const decodes = totalDecodes()
    expect(decodes, 'a real read decodes at least one chunk').toBeGreaterThan(0)
    // The counter is per `(artifact, member)` chunk decode, so "one read" means the per-member
    // total equals the chunk count of a single pass — not that the number is 1.
    const single = a.length
    expect(decodes, 'three consumers decoded more than one pass').toBe(single)
  })

  it('(b) a consumer joining MID-stream gets the emitted prefix then the live tail, still one decode', async () => {
    const { source } = rig()
    const channel: Channel = { kind: 'continuous', key: CONTINUOUS_ID }
    const first: Uint8Array[] = []
    const iterator = source.stream(channel)[Symbol.asyncIterator]()
    const head = await iterator.next()
    expect(head.done).toBe(false)
    first.push(new Uint8Array(head.value as Uint8Array))
    const decodesAfterFirstChunk = totalDecodes()

    // A SECOND consumer starts while the first is still mid-iteration. It must receive chunk 0
    // (already emitted) and then the tail — off the same read.
    const late = chunksOf(source.stream(channel))
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      first.push(new Uint8Array(next.value))
    }
    const lateChunks = await late

    expect(first.length).toBeGreaterThan(1)
    expect(
      lateChunks.flatMap(x => Array.from(x)),
      'the late consumer did not observe the same column',
    ).toEqual(first.flatMap(x => Array.from(x)))
    expect(decodesAfterFirstChunk).toBeGreaterThan(0)
    expect(totalDecodes(), 'the late consumer started a SECOND decode').toBe(first.length)
  })

  it('(c) changing the bound colour column decodes the NEW column and re-decodes positions ZERO times', async () => {
    const { source } = rig()
    await chunksOf(source.stream({ kind: 'positions', layout: LAYOUT_ID }))
    // The counter keys on `<artifactId>|<member path>`, and the zarr layer addresses a STORE
    // rather than an artifact — so an injected store records the artifact id as empty. The key
    // still names the member, which is the granularity this assertion needs.
    const positionsKey = `|${LAYOUT_MEMBER}`
    const afterPositions = decodeCounts()
    expect(afterPositions[positionsKey], 'positions were never decoded').toBeGreaterThan(0)

    // "Change the colour-by": read a different column, then re-read positions the way a rebuilt
    // canvas source would.
    await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    await chunksOf(source.stream({ kind: 'positions', layout: LAYOUT_ID }))

    const after = decodeCounts()
    expect(
      after[positionsKey],
      'a colour change re-decoded positions — INV-2 says an encoding change fetches ONE column',
    ).toBe(afterPositions[positionsKey])
    expect(after[`|${CONTINUOUS_MEMBER}`]).toBeGreaterThan(0)
  })

  it('(c2) the ENCODING-CHANGE evidence — one instance costs zero re-decodes, two cost a full re-read', async () => {
    // ITEM-8's obligation, driven through the composition `buildCanvasSources` builds:
    // `asDataSource(streamingSource)` — the exact shape `CanvasView` hands `VizController` and
    // `canvasHostProvider` reads positions through.
    //
    // A colour change rebuilds the controller, re-installs the resolver and re-acquires the
    // dataset, so the coordinates ARE read again. What decides whether that costs anything is
    // which instance the re-read reaches.
    const { source } = rig()
    const adapted = asDataSource(source)
    const positionsKey = `|${LAYOUT_MEMBER}`

    await adapted.positions(LAYOUT_ID)
    const afterFirst = decodeCounts()[positionsKey]
    expect(afterFirst, 'positions were never decoded').toBeGreaterThan(0)

    // …the colour change: a different column, then the coordinates again.
    await adapted.continuous(CONTINUOUS_ID)
    await adapted.positions(LAYOUT_ID)

    expect(
      decodeCounts()[positionsKey],
      'an encoding change re-decoded the coordinates — INV-2 says it fetches ONE column',
    ).toBe(afterFirst)

    // NEGATIVE CONTROL, and it is the pre-ITEM-8 behaviour rather than an invented mutation:
    // `buildCanvasDataSource` minted a NEW source per call, so the re-read reached an instance
    // with an empty replay buffer. Two instances over the same bytes, and the coordinates are
    // decoded twice — which is what this test would report if `buildCanvasSources` stopped
    // memoizing, and what no amount of caching INSIDE one source can prevent.
    resetDecodeCounts()
    __resetArtifactArrayCache()
    const one = asDataSource(rig().source)
    await one.positions(LAYOUT_ID)
    const single = decodeCounts()[positionsKey]
    __resetArtifactArrayCache()
    const two = asDataSource(rig().source)
    await two.positions(LAYOUT_ID)
    expect(
      decodeCounts()[positionsKey],
      'two source instances shared a decode — the control is not measuring what it claims',
    ).toBe(single * 2)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-9 [covers: ITEM-4] — the categorical level set rides the CATALOG (DEC-8)
// ══════════════════════════════════════════════════════════════════════════════════

describe('TEST-9 (ITEM-4) — codes stream, levels ride the catalog', () => {
  it('the byte stream carries ONLY codes, and the catalog names the levels', async () => {
    const { source } = rig()
    const cat = await source.catalog()
    const entry = cat.categoricalColumns.find(c => c.id.startsWith(CATEGORICAL_ID))
    expect(entry, 'the fixture categorical is missing from the catalog').toBeDefined()

    // The producer DECLARED five levels including one no row uses. That level cannot be
    // recovered from the codes at all, so a source that derived categories from the bytes would
    // silently offer four — which is the failure DEC-8 exists to prevent, and it is why this
    // asserts the declared set rather than "some categories arrived".
    const declared = await readDeclaredLevels(CATEGORICAL_ID, CATEGORICAL_MEMBER, {
      store: recordingStore().store,
    })
    expect(entry?.categories).toEqual([...(declared ?? [])])
    expect(entry?.categories).toContain('NEVER-OBSERVED')

    const chunks = await chunksOf(source.stream({ kind: 'categorical', key: entry!.id }))
    expect(chunks).toHaveLength(1)
    // u16 codes, one per row — no level strings, no header. A consumer holding the catalog can
    // label chunk 0 without waiting for the stream to end.
    expect(chunks[0].byteLength).toBe(500 * 2)
    const codes = new Uint16Array(chunks[0].slice().buffer)
    expect(Math.max(...codes)).toBeLessThan((declared ?? []).length)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-10 [acceptance] [INV-4] [covers: ITEM-7] — abort STOPS the reads
// ══════════════════════════════════════════════════════════════════════════════════

describe('TEST-10 [acceptance] (INV-4) — an aborted consumer stops the network, and only its own', () => {
  it('aborting the ONLY consumer stops further reads — the request log stops growing', async () => {
    const { source, calls } = rig()
    const controller = new AbortController()
    const iterator = source
      .stream({ kind: 'continuous', key: CONTINUOUS_ID }, { signal: controller.signal })
      [Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    controller.abort()
    await expect(iterator.next()).rejects.toThrow(/abort/i)

    // Settle: any fetch already in flight when the abort landed may still complete. What must
    // NOT happen is the read continuing to SCHEDULE work. So the log is sampled twice, with
    // turns in between, and must be stable — an implementation that merely discarded results
    // would keep growing here while every assertion about the yielded values stayed green.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    const settled = calls.length
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.length, 'reads kept being issued after the abort').toBe(settled)

    // …and it stopped EARLY. A run that completed the whole column and then reported "stable"
    // would satisfy the check above while cancelling nothing.
    const full = rig()
    await chunksOf(full.source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    expect(settled, 'the aborted read cost as much as a complete one').toBeLessThan(
      full.calls.length,
    )
  })

  it('NON-VACUITY — a second consumer of the same multicast reads to completion', async () => {
    const { source } = rig()
    const channel: Channel = { kind: 'continuous', key: CONTINUOUS_ID }
    const controller = new AbortController()

    const quitter = source.stream(channel, { signal: controller.signal })[Symbol.asyncIterator]()
    await quitter.next()
    const survivor = chunksOf(source.stream(channel))
    controller.abort()
    await expect(quitter.next()).rejects.toThrow(/abort/i)

    // This is the leg that makes the first one non-vacuous: an implementation that tore the
    // whole read down on ANY abort passes a single-consumer abort test and starves everyone
    // else. INV-4 and ITEM-7 have to hold together, not one at the other's expense.
    const chunks = await survivor
    expect(chunks.length).toBeGreaterThan(1)
    const { pull } = rig()
    const want = await pull.continuous(CONTINUOUS_ID)
    const bytes = await collectStream(
      (async function* () {
        for (const c of chunks) yield c
      })(),
    )
    expect(Array.from(new Float32Array(bytes.slice().buffer))).toEqual(Array.from(want.value))
  })
})

// ── ITEM-19 — the progress the coverage indicator is fed by ────────────────────────────────────
//
// What these do when the defect is present: an `onProgress` that fired ONCE at completion (the easy
// implementation) satisfies "progress was reported" while telling the indicator nothing it can show
// — so the first test asserts an event landed with the read still UNFINISHED, and asserts that the
// number it carried was a strict fraction. The `done` leg is what lets the indicator disappear
// rather than sit at 100%.
describe('WorkbenchStreamingSource — progress (ITEM-19)', () => {
  it('emits per ARRIVED chunk with a rising row count, and once more when the read settles', async () => {
    const { source } = rig()
    await source.catalog() // resolves `pointCount`, the indicator's denominator
    const events: { chunks: number; rowsSeen: number | null; done: boolean; totalRows: number | null }[] = []
    const off = source.onProgress(p => {
      if (p.kind === 'positions') {
        events.push({ chunks: p.chunks, rowsSeen: p.rowsSeen, done: p.done, totalRows: p.totalRows })
      }
    })
    await chunksOf(source.stream({ kind: 'positions', layout: LAYOUT_ID }))
    off()

    // Non-vacuity, and the fixture's multi-chunk claim asserted rather than assumed.
    expect(events.length).toBeGreaterThan(1)
    // At least one event landed while the read was STILL RUNNING — that is the whole point. A
    // report-once-at-the-end implementation fails here and passes a bare "progress was emitted".
    const midFlight = events.filter(e => !e.done)
    expect(midFlight.length).toBeGreaterThan(0)
    // …and it carried a STRICT fraction, not the finished total.
    const total = events.at(-1)!.rowsSeen!
    expect(midFlight[0].rowsSeen).toBeLessThan(total)
    // Rows only ever grow.
    const rows = events.map(e => e.rowsSeen!)
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThanOrEqual(rows[i - 1])
    // A terminal event, so the indicator can leave rather than sit at 100%.
    expect(events.at(-1)!.done).toBe(true)
    // The denominator is real.
    expect(events.at(-1)!.totalRows).toBe(N_ROWS)
  })

  it('an unsubscribed observer stops receiving, and a throwing one cannot break the read', async () => {
    const { source } = rig()
    let afterOff = 0
    const off = source.onProgress(() => {
      afterOff++
    })
    off()
    source.onProgress(() => {
      throw new Error('an indicator blew up')
    })
    // The read still completes with correct bytes despite the throwing observer.
    const chunks = await chunksOf(source.stream({ kind: 'positions', layout: LAYOUT_ID }))
    expect(chunks.length).toBeGreaterThan(1)
    expect(afterOff).toBe(0)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-54 (ITEM-42) — PARTIAL: the ORACLE and the measured GAP. Read the scope note.
// ══════════════════════════════════════════════════════════════════════════════════
//
// DEC-20's requirement is that a column read by the declarative `column_values` slice and the SAME
// column read by the canvas cost ONE read between them — not two paths that happen to agree. The
// measurement is the DECODE counter, because the `immutable` HTTP cache hides a duplicate FETCH but
// not a duplicate DECODE, and because "the routes look the same" is an inspection, not a result.
//
// ── SCOPE, stated so this does not read as more than it is ───────────────────────────────────
//
// These two cases are the ORACLE ITEM-42 will be judged by and the MEASUREMENT of the gap it has
// to close. They do NOT yet drive the production `column_values` slice — that leg lands WITH the
// implementation, and TESTS.md records TEST-54 as partial until it does. Claiming otherwise would
// be the phantom-leg shape the standing check exists to catch (a spec whose assertions are
// narrower than its prose).
//
// What they establish today, by measurement rather than by inspection:
//   • two consumers of ONE source share ONE decode (the target state), and
//   • the CURRENT production route — `$data` reading the artifact through its own workstore call —
//     costs a SECOND decode. So the two paths are genuinely NOT unified today, and "they produce
//     the same values" was never evidence that they were.
describe('TEST-54 (ITEM-42, partial) — the oracle, and the measured second decode', () => {
  beforeEach(() => {
    enableDecodeCounter()
    resetDecodeCounts()
  })

  it('ORACLE: two consumers of ONE source cost ONE decode and observe identical bytes', async () => {
    const { source } = rig()
    // 1. The CANVAS read — chunk-by-chunk, the raster/domain path.
    const canvas = await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    const afterCanvas = totalDecodes()
    // Non-vacuity: the read really decoded, and really was multi-chunk.
    expect(canvas.length).toBeGreaterThan(1)
    expect(afterCanvas).toBeGreaterThan(0)

    // 2. The DECLARATIVE read of the same column — `$data` collects the stream WHOLE (its landing
    //    model stays wholesale; ITEM-42 unifies the BYTE ROUTE, not the landing).
    const whole = await collectStream(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    const afterBoth = totalDecodes()

    // The bytes the two consumers observe are identical…
    const flat = new Uint8Array(canvas.reduce((n, c) => n + c.byteLength, 0))
    let at = 0
    for (const c of canvas) {
      flat.set(c, at)
      at += c.byteLength
    }
    expect(Array.from(whole)).toEqual(Array.from(flat))
    // …and the second consumer JOINED the first's read rather than starting one. This is the
    // assertion that fails if the unification ever regresses into the SECOND BYTE PATH DEC-20 was
    // resolved to avoid — the exact failure `$data` reading through its own workstore call produces.
    expect(afterBoth).toBe(afterCanvas)
  })

  it('MEASURED GAP: the CURRENT $data route (a direct workstore read) costs a SECOND decode', async () => {
    const { source, store, pull } = rig()
    await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    const afterCanvas = totalDecodes()
    // The pre-ITEM-42 shape: `$data` reads the artifact through its own workstore call instead of
    // through the source. It produces the SAME values and a SECOND decode — which is precisely why
    // "the two paths agree" was never evidence, and why this control is what makes the assertion
    // above mean something.
    const structure = await pull.structureFor(CONTINUOUS_ID)
    await readNumericColumn(CONTINUOUS_ID, structure, undefined, { store })
    expect(totalDecodes()).toBeGreaterThan(afterCanvas)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-54 (ITEM-42) — the PRODUCTION leg: the real `column_values` reader on one byte route
// ══════════════════════════════════════════════════════════════════════════════════
//
// The two cases above are the ORACLE and the MEASURED GAP. These drive the SHIPPING reader —
// `readColumnValues` (the `column_values` slice's own read loop) → the `data` capability's
// `readColumnarFrame` → `makeColumnarFrameReader` → the source — and assert the gap is closed.
//
// What is NOT covered here, stated so the prose is not wider than the assertions: the slice's
// `resolveOrThrow` + `data.artifacts.query()` preamble (`viewData.ts`) is not driven; this starts
// at the artifact list, which is what `readColumnValues` itself takes. Everything from the
// capability inward is the real code.

describe('TEST-54 (ITEM-42) — the declarative reader and the canvas share ONE decode', () => {
  beforeEach(() => {
    enableDecodeCounter()
    resetDecodeCounts()
  })

  /** The capability, bound to a plane that THROWS on every method — so a read reaching the plane
   *  instead of the source fails loudly rather than passing by another route. */
  function capabilityOver(sources: () => { streaming: WorkbenchStreamingSource; pull: unknown }) {
    const refuse = (what: string) => () => {
      throw new Error(`the columnar read must not reach the plane (${what})`)
    }
    const plane = {
      catalog: refuse('catalog'),
      listArtifacts: refuse('listArtifacts'),
      readColumn: refuse('readColumn'),
      readArtifact: refuse('readArtifact'),
      readOpaque: refuse('readOpaque'),
      previewValues: refuse('previewValues'),
    } as unknown as DataHost
    return createDataApi(plane, 'p-stream', {
      readColumnarFrame: makeColumnarFrameReader(
        sources as unknown as () => ProjectSources,
        { readWhole: fallback.reader },
      ),
    })
  }

  /** The non-streamed route, injected so the GATE is observable without the fallback reaching the
   *  network. Records what it was asked for. */
  const fallback = {
    calls: [] as string[],
    reader: async (read: { artifactId: string }) => {
      fallback.calls.push(read.artifactId)
      return { fallback: [] as unknown[] }
    },
  }

  beforeEach(() => {
    fallback.calls = []
  })

  /** Drive the REAL slice loop for one artifact through the capability. */
  async function readViaSlice(api: DataApi, artifactId: string) {
    return readColumnValues(
      ARTIFACTS as unknown as ArtifactRow[],
      [{ key: 'k', artifact: artifactId }],
      row => api.readColumnarFrame({ artifactId: row.id, structure: row.structure }),
    )
  }

  it('the CANVAS first, then $data — the declarative read costs ZERO further decodes', async () => {
    const { source, pull } = rig()
    const api = capabilityOver(() => ({ streaming: source, pull }))

    const canvas = await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    const afterCanvas = totalDecodes()
    // Non-vacuity: the canvas read really decoded, and really was multi-chunk.
    expect(canvas.length).toBeGreaterThan(1)
    expect(afterCanvas).toBeGreaterThan(0)

    const payload = await readViaSlice(api, CONTINUOUS_ID)
    // THE ASSERTION. Before ITEM-42 this route read the artifact through its own workstore call
    // and the count rose (the MEASURED GAP case above). Now it joins.
    expect(totalDecodes()).toBe(afterCanvas)

    // …and it did not reach the plane, and it did not reach the non-streamed fallback.
    expect(fallback.calls).toEqual([])

    // THE REPRESENTATION IS PRESERVED (ITEM-21): a typed numeric column, value-for-value equal to
    // the pull read of the same column. A boxed result here would silently undo ITEM-21 for the
    // one arc it was built for, and every downstream `isColumn` guard would accept it either way.
    const column = Object.values(payload.k ?? {})[0]
    expect(column).toBeInstanceOf(Float32Array)
    const whole = await pull.continuous(CONTINUOUS_ID)
    expect(Array.from(column as Float32Array)).toEqual(Array.from(whole.value))
  })

  it('$data FIRST, then the canvas — the canvas joins the declarative read', async () => {
    const { source, pull } = rig()
    const api = capabilityOver(() => ({ streaming: source, pull }))

    await readViaSlice(api, CONTINUOUS_ID)
    const afterData = totalDecodes()
    expect(afterData).toBeGreaterThan(0)

    // The other order, which is the one a user reaches by emitting a plot before the pane paints.
    // A unification that only worked one way round would be a cache, not one route.
    const canvas = await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    expect(canvas.length).toBeGreaterThan(1)
    expect(totalDecodes()).toBe(afterData)
  })

  it('a member the channel would RE-TYPE keeps the previous reader — the gate, both ways', async () => {
    const { source, pull } = rig()
    const api = capabilityOver(() => ({ streaming: source, pull }))

    // A categorical column is not f32 and the `continuous` channel would not decode it as one, so
    // it must NOT be streamed. This is the leg that fails if the gate is widened to "any table".
    await readViaSlice(api, CATEGORICAL_ID)
    expect(fallback.calls).toEqual([CATEGORICAL_ID])

    // The POSITIVE control in the same case, without which the leg above is satisfied by a reader
    // that never streams anything: the declared-f32 column does NOT reach the fallback.
    await readViaSlice(api, CONTINUOUS_ID)
    expect(fallback.calls).toEqual([CATEGORICAL_ID])
  })

  it('a capability built with NO columnar reader REFUSES rather than finding another route', async () => {
    const api = createDataApi({} as unknown as DataHost, 'p-stream')
    // Fail-loud, per DEC-15's rule applied to this route: a silent fallback to a second byte path
    // is the exact failure DEC-20 forbids, and it would be invisible.
    await expect(api.readColumnarFrame({ artifactId: CONTINUOUS_ID })).rejects.toThrow(
      /without a columnar reader/,
    )
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// The read is HANDED the source's cancellation signal (the production wiring)
// ══════════════════════════════════════════════════════════════════════════════════
//
// ── WHAT THIS DOES WHEN THE DEFECT IS PRESENT ──────────────────────────────────────────────────
// The apparatus for cancellation was built at three layers — `WorkbenchStreamingDeps` declares
// `signal?: AbortSignal`, `defaultStreamingDeps()` threads it into `streamPositionBytes(…, {signal})`,
// and `artifactReader` calls `throwIfAborted(options.signal)` at every chunk turn — and then the two
// call sites in `#produce` omitted the argument. Every layer read as wired; nothing was.
//
// TEST-10 above does NOT catch it. It reads the recording store's request log, and the log stops
// growing either way: `#pump` breaks on `entry.abort.signal.aborted` when the NEXT chunk lands, so an
// unwired build merely cancels one 8 192-row chunk late. So this pins the argument itself: the
// signal the producer is handed must BE the multicast's own controller — the thing that makes
// `throwIfAborted` live. With the argument omitted the producer receives `undefined` and leg (a)
// fails on the first assertion.
//
// Leg (b) is what stops leg (a) being satisfiable by passing any always-aborted signal, or by a
// build that tears the shared read down whenever ANY consumer leaves: with a second consumer still
// reading, the SAME captured signal must still be UNaborted.
describe('cancellation is wired into the producer, not merely declared', () => {
  /** The rig, but with the byte producer replaced by one that records the signal it was given and
   *  yields on demand. Only the argument is under test, so the fixture must not be able to invent
   *  one: it records exactly what production passed, `undefined` included. */
  function capturingRig(): {
    source: WorkbenchStreamingSource
    seen: () => AbortSignal | undefined
    release: () => void
  } {
    const { store } = recordingStore()
    const pull = new WorkbenchDataSource('p-stream', pullDeps(store))
    let captured: AbortSignal | undefined
    let sawCall = false
    let gate = (): void => {}
    const source = new WorkbenchStreamingSource('p-stream', {
      pull,
      deps: {
        ...streamDeps(store),
        streamNumeric: (_id, _structure, signal) => {
          sawCall = true
          captured = signal
          return (async function* () {
            yield new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer)
            await new Promise<void>(resolve => {
              gate = resolve
            })
            yield new Uint8Array(new Float32Array([5, 6, 7, 8]).buffer)
          })()
        },
      } as WorkbenchStreamingDeps,
    })
    return {
      source,
      seen: () => {
        // Non-vacuity: `undefined` must mean "production passed nothing", never "the producer was
        // never reached" — the two are indistinguishable from the captured value alone.
        expect(sawCall, 'the capturing producer was never called — the rig is not under test').toBe(true)
        return captured
      },
      release: () => gate(),
    }
  }

  it('(a) the LAST consumer leaving fires the signal the producer is reading under', async () => {
    const { source, seen, release } = capturingRig()
    const controller = new AbortController()
    const iterator = source
      .stream({ kind: 'continuous', key: CONTINUOUS_ID }, { signal: controller.signal })
      [Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)

    controller.abort()
    await expect(iterator.next()).rejects.toThrow(/abort/i)
    await new Promise(resolve => setTimeout(resolve, 0))

    const signal = seen()
    expect(signal, 'the producer was handed no cancellation signal at all').toBeDefined()
    expect(signal?.aborted, 'the producer is reading under a signal that never fires').toBe(true)
    release()
  })

  it('(b) NON-VACUITY — with another consumer still reading, that same signal stays unaborted', async () => {
    const { source, seen, release } = capturingRig()
    const channel: Channel = { kind: 'continuous', key: CONTINUOUS_ID }
    const controller = new AbortController()

    const quitter = source.stream(channel, { signal: controller.signal })[Symbol.asyncIterator]()
    await quitter.next()
    const survivor = source.stream(channel)[Symbol.asyncIterator]()
    await survivor.next()

    controller.abort()
    await expect(quitter.next()).rejects.toThrow(/abort/i)
    await new Promise(resolve => setTimeout(resolve, 0))

    const signal = seen()
    expect(signal, 'the producer was handed no cancellation signal at all').toBeDefined()
    expect(signal?.aborted, 'one consumer walking away cancelled a read others are still using').toBe(
      false,
    )
    release()
    expect((await survivor.next()).done).toBe(false)
  })
})

// ── H3 — one failing member must not poison the project's catalog forever ──────────────────────
//
// WHAT THIS DOES WHEN THE DEFECT IS PRESENT: `catalog()` memoized the PROMISE, including a rejected
// one. The owner's own import has two text columns stored as split strings, whose `meta.kind` the
// producer stamps `categorical`, so `declaredLevels` was called at a group path and threw; the
// rejection escaped `Promise.all` in `#buildCatalog` and was then handed to every later caller with
// no new request issued. Since `asDataSource` memoizes this source and `buildProjectSources`
// memoizes that per (broker, project), the entire streaming canvas stayed down until a page reload.
//
// The transient failure is the honest general case: whatever the cause — a group member, a 5xx, a
// dropped connection — the SECOND call must be a real second attempt. `#streams` and
// `#categoricalReads` both already delete on failure; this memo did not.
describe('catalog() does not cache a rejection (H3)', () => {
  it('a failure is retried on the next call, and the retry can succeed', async () => {
    const { store } = recordingStore()
    const pull = new WorkbenchDataSource('p-stream', pullDeps(store))
    let attempts = 0
    const source = new WorkbenchStreamingSource('p-stream', {
      pull,
      deps: {
        ...streamDeps(store),
        declaredLevels: async (id, memberPath, structure) => {
          attempts++
          if (attempts === 1) throw new Error('transient member failure')
          return streamDeps(store).declaredLevels!(id, memberPath, structure)
        },
      } as WorkbenchStreamingDeps,
    })

    await expect(source.catalog()).rejects.toThrow(/transient member failure/)
    // The retry must actually RE-RUN the build — a cached rejection replays with `attempts` frozen.
    const catalog = await source.catalog()
    expect(attempts, 'the second call reused the cached rejection instead of retrying').
      toBeGreaterThan(1)
    expect(catalog.categoricalColumns.length).toBeGreaterThan(0)

    // Non-vacuity for the memo itself: a THIRD call must not rebuild — this fix must not have
    // turned the catalog into an uncached read.
    const at = attempts
    await source.catalog()
    expect(attempts, 'a successful catalog is no longer memoized').toBe(at)
  })
})

// ── F4 — the categorical cache is INSIDE the retention budget ──────────────────────────────────
//
// WHAT THIS DOES WHEN THE DEFECT IS PRESENT: `#evict` summed `#streams` only. `#categoricalReads`
// retained decoded codes + level sets for the life of the source, was never trimmed, and — worse —
// was not even COUNTED, so the "128 MB replay budget" the module documents was exceeded by an
// amount bounded only by how many categorical columns a session touched. `#evict` also ran only
// from `#pump`'s `finally`, so a categorical read (which never runs a pump) could put the source
// over budget and leave it there until some unrelated stream happened to start.
//
// Driven through the constructor's `replayBudgetBytes` seam rather than by allocating 128 MB.
//
// The observable is the DEP call count, not the decode count: the decode counter sits below the
// ZarrArray chunk cache, which serves a repeat read without decoding, so it reads the same whether
// this cache retained the entry or not — a proxy that cannot see the property (the first version of
// this test was exactly that, and was green under the defect).
describe('retention counts the categorical cache (F4)', () => {
  /** The rig with `readCategorical` counted — the call this cache exists to avoid. */
  function countingRig(replayBudgetBytes?: number): {
    source: WorkbenchStreamingSource
    reads: () => number
  } {
    const { store } = recordingStore()
    const pull = new WorkbenchDataSource('p-stream', pullDeps(store))
    let reads = 0
    const base = streamDeps(store)
    const source = new WorkbenchStreamingSource('p-stream', {
      pull,
      deps: {
        ...base,
        readCategorical: (id, structure, column) => {
          reads++
          return base.readCategorical!(id, structure, column)
        },
      } as WorkbenchStreamingDeps,
      ...(replayBudgetBytes === undefined ? {} : { replayBudgetBytes }),
    })
    return { source, reads: () => reads }
  }

  const CHANNEL: Channel = {
    kind: 'categorical',
    key: `${CATEGORICAL_ID}#${CATEGORICAL_MEMBER}`,
  }

  it('a categorical read over budget is evicted, so a later read re-reads the column', async () => {
    // One byte: any resolved categorical is over budget, and the eviction runs the moment the read
    // settles — the second half of the fix, since no pump ever runs on this path.
    const { source, reads } = countingRig(1)
    const first = await chunksOf(source.stream(CHANNEL))
    expect(reads(), 'the rig never reached the categorical read').toBe(1)
    // Read an UNRELATED channel in between. Two reasons, both load-bearing: it drops the
    // categorical CHANNEL's replay entry (which has no consumers by now and would otherwise serve
    // the second read off `#streams`, masking the cache under test), and its pump's `finally` is
    // the only `#evict` trigger the old code had — so under the defect this is the most generous
    // possible opportunity for the categorical cache to be trimmed, and it still is not.
    await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    const second = await chunksOf(source.stream(CHANNEL))
    expect(
      reads(),
      'the over-budget categorical cache was retained — its bytes are not being counted',
    ).toBe(2)
    // Eviction must cost correctness nothing: the re-read is the same bytes.
    expect(second.map(c => Array.from(c))).toEqual(first.map(c => Array.from(c)))
  })

  it('NON-VACUITY — inside the budget the same second read is still served from cache', async () => {
    const { source, reads } = countingRig()
    await chunksOf(source.stream(CHANNEL))
    await chunksOf(source.stream(CHANNEL))
    // The INV-2 guarantee the eviction must not have broken: a cache that evicted unconditionally
    // would pass the test above while destroying the multicast's whole point.
    expect(reads(), 'the categorical cache stopped serving a repeat read').toBe(1)
  })
})

// ── M4 / M5 — the progress a coverage indicator can actually act on ────────────────────────────
describe('progress reports the WIRE width, and settles on failure (M4/M5)', () => {
  it('M4 — a completed categorical read reports its FULL row count, not half of it', async () => {
    const { source, pull } = rig()
    const key = `${CATEGORICAL_ID}#${CATEGORICAL_MEMBER}`
    const events: StreamProgress[] = []
    const off = source.onProgress(p => {
      if (p.kind === 'categorical') events.push(p)
    })
    await chunksOf(source.stream({ kind: 'categorical', key }))
    off()

    const settled = events.at(-1)
    expect(settled, 'no terminal categorical progress event').toBeDefined()
    // The oracle is the PULL source's own decode of the same column — an independent count of the
    // rows, not a restatement of the bytes just streamed. The codes go on the wire as u16
    // (`toUint16Codes`) while `BYTES_PER_ROW.categorical` said 4 — the DECODED width — so a
    // finished read reported exactly HALF its rows and a coverage bar rested at 50% on a complete
    // column.
    const oracle = (await pull.categorical(key)).codes.length
    expect(oracle, 'the fixture column is empty — the ratio is not under test').toBeGreaterThan(0)
    expect(settled!.rowsSeen, 'a completed read did not report every row').toBe(oracle)
  })

  it('M5 — a FAILED read emits a terminal event instead of stopping mid-fraction', async () => {
    const { store } = recordingStore()
    const pull = new WorkbenchDataSource('p-stream', pullDeps(store))
    const source = new WorkbenchStreamingSource('p-stream', {
      pull,
      deps: {
        ...streamDeps(store),
        streamNumeric: () =>
          (async function* () {
            yield new Uint8Array(new Float32Array([1, 2]).buffer)
            throw new Error('the read died mid-column')
          })(),
      } as WorkbenchStreamingDeps,
    })
    const events: StreamProgress[] = []
    const off = source.onProgress(p => events.push(p))
    await expect(chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))).rejects.toThrow(
      /died mid-column/,
    )
    off()

    // Non-vacuity: the read really did report partial progress before dying, which is the state
    // that used to be final — the indicator sat at that fraction for the life of the page.
    expect(events.some(e => !e.done), 'no mid-flight event — the failure case is not exercised').
      toBe(true)
    const settled = events.at(-1)
    expect(settled?.done, 'a failed read never settled — the indicator sticks forever').toBe(true)
    expect(settled?.failed, 'the terminal event does not distinguish failure from completion').
      toBe(true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// THE GATHERED CHANNEL (dimension-membership ITEM-12 / ITEM-13 / ITEM-14 / ITEM-17)
// TEST-15, TEST-16, TEST-17, TEST-18, TEST-22.
//
// A coordinate that is a SUBSET of its axis has to paint a column that describes the WHOLE
// axis. The two lengths differ by orders of magnitude, so the read has to gather — and the
// property that makes it worth building is not the VALUES (a collect-then-filter produces the
// identical ones) but the memory: retained bytes scale with the SUBSET. Every assertion below
// that could be satisfied by collect-then-filter says so and is paired with one that cannot.
// ══════════════════════════════════════════════════════════════════════════════════

/** The member positions the gather fixture selects out of the 500-row continuous column.
 *  Chosen to CROSS chunk boundaries: `table/f32col` is chunked 128, so 128 is a chunk's FIRST
 *  position, 255 its LAST, 256 the next chunk's first and 499 the final chunk's last. An
 *  off-by-one in the `[offset, offset+len)` window drops or duplicates exactly those while
 *  keeping the count plausible. */
const GATHER_MEMBERS = [3, 100, 128, 129, 255, 256, 499]

const AXIS_DIGEST = 'd'.repeat(64)
/** An ADVERSARIAL id (INV-4): every character a delimiter would use. The membership triple's
 *  three components must survive it with nothing to re-split. */
const COORD_ID = 'coord:with/every|delimiter'
const COORD_MEMBER = 'seg:a/b|c'
/** The SECOND segment's index body (ITEM-15) — a two-axis coordinate names one per axis. */
const COORD_MEMBER_2 = 'seg:d/e|f'

/** The ascending `uint32` index body, as a codec-less zarr v3 array added to the fixture tree. */
function memberIndexFixture(prefix: string, members: readonly number[]): Map<string, Uint8Array> {
  const meta = {
    zarr_format: 3,
    node_type: 'array',
    shape: [members.length],
    data_type: 'uint32',
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [members.length] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    attributes: {},
  }
  const body = Uint32Array.from(members)
  return new Map<string, Uint8Array>([
    [`${prefix}/zarr.json`, new TextEncoder().encode(JSON.stringify(meta))],
    [`${prefix}/c/0`, new Uint8Array(body.buffer.slice(0))],
  ])
}

function gatherRig(members: readonly number[] = GATHER_MEMBERS, second?: readonly number[]) {
  const files = new Map(FIXTURE_FILES)
  for (const [path, bytes] of memberIndexFixture(COORD_MEMBER, members)) files.set(path, bytes)
  // ITEM-15 — a SECOND index body on the same coordinate, which is what a two-axis coordinate
  // declares: one membership per axis, each naming its own member.
  if (second) {
    for (const [path, bytes] of memberIndexFixture(COORD_MEMBER_2, second)) files.set(path, bytes)
  }
  const calls: string[] = []
  const inner = memoryStore(files)
  const store: ZarrStore = {
    get: path => {
      calls.push(path)
      return inner.get(path)
    },
    getRange: (path, start, length) => {
      calls.push(`${path}@${start}+${length}`)
      return inner.getRange(path, start, length)
    },
    getSuffix: (path, length) => {
      calls.push(`${path}@-${length}`)
      return inner.getSuffix(path, length)
    },
  }
  // The parent column DECLARES the axis the membership names, so ITEM-12's refusal passes; the
  // coordinate artifact carries the index body under an adversarially-named member.
  const artifacts: DataPlaneArtifact[] = [
    // …and the MATRIX declares it too (ITEM-16): a correspondence gathers one of its COLUMNS,
    // and ITEM-12's check is asked of the matrix's own declaration, never of the column key.
    ...ARTIFACTS.map(a =>
      a.id === CONTINUOUS_ID || a.id === VALUE_ID
        ? { ...a, structure: { ...(a.structure as object), aligned_to: AXIS_DIGEST } }
        : a,
    ),
    {
      id: COORD_ID,
      datatype: 'demo/column',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: ROW_AXIS,
        columns: [
          { path: COORD_MEMBER, kind: 'numeric', dtype: 'uint32', shape: [members.length] },
          ...(second
            ? [{ path: COORD_MEMBER_2, kind: 'numeric', dtype: 'uint32', shape: [second.length] }]
            : []),
        ],
      },
    },
  ]
  const pull = new WorkbenchDataSource('p-gather', {
    ...pullDeps(store),
    getCatalog: async () => ({
      axes: [{ content_hash: ROW_AXIS_HASH, name: ROW_AXIS, length: N_ROWS }],
      artifacts,
    }),
    getArtifact: async id => {
      const hit = artifacts.find(a => a.id === id)
      if (!hit) throw new Error(`no fixture artifact ${id}`)
      return hit
    },
  })
  const source = new WorkbenchStreamingSource('p-gather', { pull, deps: streamDeps(store) })
  return { source, pull, calls, store }
}

/** The membership triple, with the adversarial ids intact and independently readable — no
 *  component is ever re-split out of a composed string (INV-4). */
function gatherRef(count = GATHER_MEMBERS.length, alignedTo = AXIS_DIGEST) {
  return {
    segments: [
      {
        of: { kind: 'continuous' as const, key: CONTINUOUS_ID },
        alignedTo,
        artifact: COORD_ID,
        member: COORD_MEMBER,
        count,
      },
    ],
  }
}

async function gatheredFloats(
  source: WorkbenchStreamingSource,
  ref: MembersRef = gatherRef(),
): Promise<number[]> {
  const chunks = await chunksOf(source.stream({ kind: 'members', members: ref }))
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const flat = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    flat.set(c, at)
    at += c.length
  }
  return [...new Float32Array(flat.buffer, flat.byteOffset, flat.length / 4)]
}

describe('TEST-16 / TEST-49 (ITEM-13 / ITEM-17) — the channel exists, and its key stays OPAQUE', () => {
  it('the gathered channel has a `stream()` arm, and the parent it wraps is the catalog one', async () => {
    const { source } = gatherRig()
    // The `members` channel is DERIVED, not enumerated: it names a catalog channel plus a
    // membership, so `catalog()` cannot list one per possible subset. What TEST-16 protects —
    // a channel that exists but has no `stream()` arm, i.e. a capability the source advertises
    // and cannot serve — is asserted the only way it can be: by streaming it, and by checking
    // the parent it wraps IS advertised.
    const catalog = await source.catalog()
    expect(catalog.continuousColumns.map(c => c.id)).toContain(CONTINUOUS_ID)
    expect(await gatheredFloats(source)).toHaveLength(GATHER_MEMBERS.length)
  })

  it('an id carrying `:`, `/` and `|` round-trips with the triple intact — nothing is re-split', async () => {
    const { source } = gatherRig()
    // The fixture ids are adversarial by construction. A delimited-string encoding of the
    // triple splits wrongly on them and either fails to find the member or finds the wrong one;
    // a structured triple cannot.
    expect(COORD_ID).toContain(':')
    expect(COORD_ID).toContain('/')
    expect(COORD_ID).toContain('|')
    expect(COORD_MEMBER).toContain('|')
    const values = await gatheredFloats(source)
    expect(values).toHaveLength(GATHER_MEMBERS.length)
    // …and two DIFFERENT memberships of the same parent are different cache entries rather than
    // one — which is the property the opaque key buys. The second gather returns its own set.
    const half = await gatheredFloats(source, gatherRef(3))
    expect(half).toEqual(values)
  })
})

describe('TEST-17 / TEST-18 (ITEM-14) — chunk-wise, ascending, and bounded by the SUBSET', () => {
  it('emits ONLY the member rows, in ascending order, across every chunk boundary', async () => {
    const { source, pull } = gatherRig()
    const structure = await pull.structureFor(CONTINUOUS_ID)
    const whole = await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    const flatWhole = new Uint8Array(whole.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of whole) {
      flatWhole.set(c, at)
      at += c.length
    }
    const parent = [...new Float32Array(flatWhole.buffer, 0, flatWhole.length / 4)]
    expect(structure.encoding).toBe('zarr_v3')
    // The value SET, in order — never the length. A window off by one keeps the COUNT plausible
    // (it drops a boundary member and picks up its neighbour) and fails only this.
    expect(await gatheredFloats(source)).toEqual(GATHER_MEMBERS.map(i => parent[i]))
  })

  it('retains only the SUBSET while streaming — asserted DURING, not on the result', async () => {
    const { source } = gatherRig()
    // A `collectStream`-then-filter implementation returns the identical final values, so the
    // final values prove nothing about this. What distinguishes them is the peak bytes held by
    // the consumer at any point mid-stream: 7 members × 4 bytes, never the parent's 500 × 4.
    let peak = 0
    let held = 0
    let sawMidStream = false
    for await (const chunk of source.stream({ kind: 'members', members: gatherRef() })) {
      held += chunk.length
      peak = Math.max(peak, chunk.length)
      if (held < GATHER_MEMBERS.length * 4) sawMidStream = true
    }
    // The read genuinely spans more than one emission — otherwise "during the stream" is a
    // claim about a single event and the bound below is trivially met.
    expect(sawMidStream, 'the gather must emit across more than one chunk').toBe(true)
    // No single emission ever carries a whole parent chunk (128 rows × 4 bytes).
    expect(peak).toBeLessThan(128 * 4)
    expect(held).toBe(GATHER_MEMBERS.length * 4)
  })
})

describe('TEST-15 (ITEM-12) — a membership on the WRONG axis is refused before any byte', () => {
  it('throws, named, and the parent column is never opened', async () => {
    const { source, calls } = gatherRig()
    calls.length = 0
    await expect(
      gatheredFloats(source, gatherRef(GATHER_MEMBERS.length, 'e'.repeat(64))),
    ).rejects.toThrow(/aligned to/)
    // The refusal is worth nothing if it fires after the read. The parent's own member is the
    // one thing that must not have been touched.
    expect(calls.filter(c => c.includes(CONTINUOUS_MEMBER))).toEqual([])
  })

  it('a non-ascending index body is refused too — a gather walks it in one pass', async () => {
    const { source } = gatherRig([5, 4, 3])
    await expect(gatheredFloats(source, gatherRef(3))).rejects.toThrow(/ascending/)
  })
})

describe('TEST-19 (ITEM-11 / ITEM-15) — a MULTI-SEGMENT gather, in the declared order', () => {
  // Each segment's own body is strictly ascending (a gather walks it in one pass); the two
  // SEGMENTS are not, and must not be — segment order is the coordinate's declaration, not a
  // sort over the indices. B's first member sits BELOW A's last precisely so a `[...A,...B]`
  // implementation and a "sort the whole thing" one give different answers.
  const A = [3, 100, 128]
  const B = [4, 255, 256, 499]

  /** A two-segment reference over ONE parent column — the shape a coordinate resting on two
   *  axes produces. `order` is the DECLARED order and is passed through untouched. */
  function twoSegments(order: 'AB' | 'BA'): MembersRef {
    const a = {
      of: { kind: 'continuous' as const, key: CONTINUOUS_ID },
      alignedTo: AXIS_DIGEST,
      artifact: COORD_ID,
      member: COORD_MEMBER,
      count: A.length,
    }
    const b = { ...a, member: COORD_MEMBER_2, count: B.length }
    return { segments: order === 'AB' ? [a, b] : [b, a] }
  }

  async function parentValues(source: WorkbenchStreamingSource): Promise<number[]> {
    const chunks = await chunksOf(source.stream({ kind: 'continuous', key: CONTINUOUS_ID }))
    const flat = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let at = 0
    for (const c of chunks) {
      flat.set(c, at)
      at += c.length
    }
    return [...new Float32Array(flat.buffer, 0, flat.length / 4)]
  }

  it('emits segment A ENTIRELY before segment B, in the declared order', async () => {
    const { source } = gatherRig(A, B)
    const parent = await parentValues(source)
    // The VALUE SEQUENCE, never the length. Both orders are 7 rows long and carry exactly the
    // same seven values; only the sequence differs, and the sequence is what a colouring binds
    // to the positions beside it.
    expect(await gatheredFloats(source, twoSegments('AB'))).toEqual(
      [...A, ...B].map(i => parent[i]),
    )
  })

  it('a REVERSED declaration emits B before A — the same rows, a different sequence', async () => {
    const { source } = gatherRig(A, B)
    const parent = await parentValues(source)
    const ab = await gatheredFloats(source, twoSegments('AB'))
    const ba = await gatheredFloats(source, twoSegments('BA'))
    expect(ba).toEqual([...B, ...A].map(i => parent[i]))
    // …and the control that says why the assertion above is on the sequence: the two answers
    // are the same LENGTH and the same multiset. Every count-shaped check passes both.
    expect(ba).toHaveLength(ab.length)
    expect([...ba].sort((x, y) => x - y)).toEqual([...ab].sort((x, y) => x - y))
    expect(ba).not.toEqual(ab)
  })

  it('the two orders are two CACHE ENTRIES — an order-blind key would serve the wrong bytes', async () => {
    // The multicast keys on the channel (ITEM-17). If the key were built from a SORTED segment
    // list — the plausible "canonicalise it" move — the second consumer would join the first's
    // stream and receive the first's sequence under its own, different declaration. Nothing
    // would error: the length is right and every value is present.
    const { source } = gatherRig(A, B)
    const [ab, ba] = await Promise.all([
      gatheredFloats(source, twoSegments('AB')),
      gatheredFloats(source, twoSegments('BA')),
    ])
    expect(ab).not.toEqual(ba)
  })

  it('progress is denominated on the GATHERED length, not on the parents’', async () => {
    const { source } = gatherRig(A, B)
    const seen: Array<{ rowsSeen: number | null; totalRows: number | null; done: boolean }> = []
    const off = source.onProgress(p => {
      if (p.kind === 'members') seen.push({ rowsSeen: p.rowsSeen, totalRows: p.totalRows, done: p.done })
    })
    await gatheredFloats(source, twoSegments('AB'))
    off()
    expect(seen.length).toBeGreaterThan(0)
    const gathered = A.length + B.length
    // The parent is 500 rows and the catalog says so; a gather of 7 denominated on THAT reports
    // a bar that creeps to 1.4% and then completes. The defect is invisible to every assertion
    // on the final values, which is why it is asserted here and on the DENOMINATOR itself.
    expect(new Set(seen.map(s => s.totalRows))).toEqual(new Set([gathered]))
    expect(seen.every(s => s.totalRows !== N_ROWS)).toBe(true)
    // …and the numerator reaches it. A settled gather that reports fewer rows than it emitted
    // sticks the indicator short of full, forever.
    const settled = seen.filter(s => s.done)
    expect(settled.length).toBeGreaterThan(0)
    expect(settled[settled.length - 1].rowsSeen).toBe(gathered)
  })

  it('refuses to concatenate two DIFFERENT wire kinds into one column', async () => {
    // A u16 categorical segment laid after an f32 continuous one produces bytes that decode —
    // as the wrong thing, at the wrong stride, for the entire tail. Nothing downstream can see
    // it: the run is present, its length is plausible, and every code it invents is in range.
    const { source } = gatherRig(A, B)
    const mixed = twoSegments('AB')
    const bad: MembersRef = {
      segments: [
        mixed.segments[0],
        { ...mixed.segments[1], of: { kind: 'categorical' as const, key: CONTINUOUS_ID } },
      ],
    }
    await expect(gatheredFloats(source, bad)).rejects.toThrow(/one gathered column carries one wire kind/)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE CORRESPONDENCE (dimension-membership ITEM-16) — INV-6, at the byte tier
//
// A membership answers "which of MY axis's rows"; a correspondence answers "the same logical
// entry, at index i on ONE axis and index j on ANOTHER". One entry of a sibling axis is column
// *i* of ds1's matrix and column *j* of ds2's, and i ≠ j. That is the one derived thing this model
// cannot express as a membership, and it is what an entry-values section on an INTEGRATED
// coordinate rests on.
//
// The tests below decode their expectations from the source's OWN UNGATHERED `value` channel, so
// every assertion crosses the parent/gather boundary rather than comparing the gather against a
// second hand-built copy of what the gather is supposed to do.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** One CSC column of the fixture, DENSIFIED over the parent's rows — decoded from the source's
 *  own ungathered `value` wire (`u32 n | u32[n] row | f32[n] value`), never rebuilt by hand. */
async function ungatheredValueColumn(
  source: WorkbenchStreamingSource,
  col: number,
): Promise<Float32Array> {
  const chunks = await chunksOf(source.stream({ kind: 'value', key: `${VALUE_ID}#${col}` }))
  expect(chunks, 'the value channel is one chunk by construction (INV-5)').toHaveLength(1)
  const wire = chunks[0]
  const view = new DataView(wire.buffer, wire.byteOffset)
  const n = view.getUint32(0, true)
  const dense = new Float32Array(N_ROWS)
  for (let k = 0; k < n; k++) {
    const row = view.getUint32(4 + k * 4, true)
    dense[row] = view.getFloat32(4 + n * 4 + k * 4, true)
  }
  return dense
}

describe('TEST-20 (ITEM-16) — a correspondence reads side A at i and side B at j', () => {
  // Segment A's rows come from ONE side, segment B's from the other; each body is strictly
  // ascending on its own (a gather walks it in one pass) while the two segments are not, so a
  // "sort the whole thing" implementation and the declared order give different answers.
  const A = [3, 100, 128]
  const B = [4, 255, 256, 499]
  /** The two sides' column indices — DIFFERENT by construction. `i === j` is precisely the
   *  index-identity implementation this test exists to kill, and a fixture pairing a column with
   *  itself could not tell the two apart. */
  const I = 0
  const J = 3

  function correspondence(i = I, j = J): MembersRef {
    return {
      segments: [
        {
          of: { kind: 'value' as const, key: `${VALUE_ID}#${i}` },
          alignedTo: AXIS_DIGEST,
          artifact: COORD_ID,
          member: COORD_MEMBER,
          count: A.length,
        },
        {
          of: { kind: 'value' as const, key: `${VALUE_ID}#${j}` },
          alignedTo: AXIS_DIGEST,
          artifact: COORD_ID,
          member: COORD_MEMBER_2,
          count: B.length,
        },
      ],
    }
  }

  it('the two sides genuinely DIFFER on the gathered rows — the fixture precondition', async () => {
    const { source } = gatherRig(A, B)
    const [ci, cj] = await Promise.all([
      ungatheredValueColumn(source, I),
      ungatheredValueColumn(source, J),
    ])
    // Without this, an index-identity implementation could pass the assertions below for the
    // uninteresting reason that both columns hold the same values at the rows being read. The
    // control's teeth are here, stated as a precondition rather than assumed.
    expect(B.some(row => ci[row] !== cj[row]), 'columns i and j must differ on segment B`s rows').toBe(
      true,
    )
  })

  it('gathers each side at its OWN column index and emits them in the declared order', async () => {
    const { source } = gatherRig(A, B)
    const [ci, cj] = await Promise.all([
      ungatheredValueColumn(source, I),
      ungatheredValueColumn(source, J),
    ])
    const got = await gatheredFloats(source, correspondence())
    // The VALUE SEQUENCE, never the length: segment A read at column i, segment B at column j,
    // A entirely before B. Both the index-identity and the sorted-segments implementations
    // return exactly this many well-typed values.
    expect([...got]).toEqual([...A.map(r => ci[r]), ...B.map(r => cj[r])])
  })

  it('emits DENSE f32 — a gathered value never carries the parent`s CSC row indices', async () => {
    const { source } = gatherRig(A, B)
    const chunks = await chunksOf(source.stream({ kind: 'members', members: correspondence() }))
    const total = chunks.reduce((n, c) => n + c.length, 0)
    // The gather RE-INDEXES rows, so a surviving CSC row index would address the PARENT's row
    // space from inside the coordinate's. Dense f32 is the only framing in which member *k* IS
    // row *k*: exactly 4 bytes per gathered row, no `n` header, no row channel.
    expect(total).toBe((A.length + B.length) * 4)
  })

  it('reports progress on the GATHERED length — a `value` parent has no ungathered stride', async () => {
    const { source } = gatherRig(A, B)
    const seen: Array<{ rowsSeen: number | null; totalRows: number | null; done: boolean }> = []
    const off = source.onProgress(p => {
      if (p.kind === 'members') seen.push({ rowsSeen: p.rowsSeen, totalRows: p.totalRows, done: p.done })
    })
    await gatheredFloats(source, correspondence())
    off()
    const settled = seen.filter(s => s.done)
    expect(settled.length).toBeGreaterThan(0)
    // `value` is absent from the UNGATHERED per-row table (a CSC scatter has no per-row stride),
    // so reading the stride there reports a finished correspondence as `rowsSeen: null` forever —
    // a coverage indicator that never fills on a column that is entirely present.
    expect(settled[settled.length - 1].rowsSeen).toBe(A.length + B.length)
    expect(settled[settled.length - 1].totalRows).toBe(A.length + B.length)
  })

  it('refuses a membership on the WRONG axis before the matrix is opened (ITEM-12, via the ARTIFACT)', async () => {
    const { source, calls } = gatherRig(A, B)
    calls.length = 0
    const wrong: MembersRef = {
      segments: correspondence().segments.map(s => ({ ...s, alignedTo: 'e'.repeat(64) })),
    }
    // The check is asked of the MATRIX's declaration. Asking it of the composite column KEY
    // looks up an artifact whose id ends in `#0`, finds nothing, and fails with the wrong error
    // — or, worse, is skipped.
    await expect(gatheredFloats(source, wrong)).rejects.toThrow(/aligned to/)
    expect(calls.filter(c => c.startsWith('csc/'))).toEqual([])
  })
})

describe('TEST-21 (ITEM-16) — an unpaired correspondence refuses; it never fabricates a zero', () => {
  it('a correspondence with NO segments is refused, not answered with an empty column', async () => {
    const { source } = gatherRig()
    // "No pair for this entry" reaches the byte tier as a gather with nothing to read. Emitting
    // zero bytes would land a zero-length column that every shape and length check accepts and
    // that reads downstream as "this entry is absent everywhere" — a positive claim about data
    // this source never saw.
    await expect(gatheredFloats(source, { segments: [] })).rejects.toThrow(/no segments/)
  })

  it('a segment naming a column the matrix does not have is refused, not zero-filled', async () => {
    const { source } = gatherRig()
    const missing: MembersRef = {
      segments: [
        {
          of: { kind: 'value' as const, key: `${VALUE_ID}#99` },
          alignedTo: AXIS_DIGEST,
          artifact: COORD_ID,
          member: COORD_MEMBER,
          count: GATHER_MEMBERS.length,
        },
      ],
    }
    // The fixture matrix has 5 columns. A gather that answered `Float32Array(7)` here would be
    // full-length, well-typed and entirely fabricated — indistinguishable from a real column of
    // structural zeros, which a sparse matrix legitimately has.
    await expect(gatheredFloats(source, missing)).rejects.toThrow()
  })
})

describe('TEST-22 (ITEM-14 / ITEM-17) — two subsets of ONE parent share ONE parent decode', () => {
  it('both panes stream simultaneously and the parent is decoded once', async () => {
    const { source } = gatherRig()
    enableDecodeCounter()
    resetDecodeCounts()
    // ACTIVE isolation control: both gathers run concurrently. A quiescent second consumer
    // would pass with the sharing broken, which is why neither of these is awaited first.
    const [a, b] = await Promise.all([gatheredFloats(source), gatheredFloats(source)])
    expect(a).toEqual(b)
    expect(a).toHaveLength(GATHER_MEMBERS.length)
    const shared = totalDecodes()
    expect(shared, 'a real read decodes at least one chunk').toBeGreaterThan(0)
    // …and the number is the count of ONE pass over the parent, not two. Measured against a
    // SECOND, independent source over the same store — the control that says what "not shared"
    // would have cost, rather than asserting a bare literal.
    resetDecodeCounts()
    const other = gatherRig()
    await gatheredFloats(other.source)
    const onePass = totalDecodes()
    expect(shared).toBe(onePass)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE FALLBACK GATHERS TOO (dimension-membership ITEM-20)
//
// `makeColumnarFrameReader` streams exactly one shape — a zarr table whose sole member is a
// producer-declared `numeric`/`float32`. EVERYTHING ELSE takes `readWhole`, and "everything
// else" is not an edge: a categorical column is `uint32`, and categoricals are the rows
// § Colour by lists FIRST. That branch returned the parent-length column unchanged while the
// pane's positions were the coordinate's members — the right NUMBER of the wrong rows, with a
// clean console and a plausible picture.
//
// The tests below assert the VALUES are the coordinate's rows, per column and per
// representation, because a length assertion is satisfied by any 4 of the parent's 20.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('ITEM-20 — a column that does not stream is gathered anyway', () => {
  const PARENT = 20
  const PICKED = [1, 7, 12, 19]

  /** The whole-parent frame the non-streaming reader hands back: one BOXED column (a
   *  categorical's labels) and one TYPED one, so the gather is asserted against both
   *  representations rather than against whichever one the fixture happened to use. */
  const wholeFrame = () => ({
    labels: Array.from({ length: PARENT }, (_, i) => `L${i}`),
    metric: Float32Array.from({ length: PARENT }, (_, i) => i * 10),
  })

  /** ONE gather segment over a named parent column. */
  function seg(column: string, count: number, member = 'idx') {
    return { column, alignedTo: 'd', artifact: 'coord', member, count }
  }

  function readerWithMembers(members: Uint32Array) {
    const streaming = { memberIndex: async () => members } as unknown as WorkbenchStreamingSource
    return makeColumnarFrameReader(
      (() => ({ streaming, pull: undefined })) as unknown as () => ProjectSources,
      { readWhole: async () => wholeFrame() },
    )
  }

  it('compacts every column to the member positions, keeping each column’s representation', async () => {
    const read = readerWithMembers(Uint32Array.from(PICKED))
    const out = await read({
      artifactId: 'a',
      // No `structure` ⇒ the streamed route is not even considered; this is the fallback.
      members: { segments: [seg('a', PICKED.length)] },
    })
    expect(out.labels).toEqual(PICKED.map(i => `L${i}`))
    expect(out.metric).toBeInstanceOf(Float32Array)
    expect(Array.from(out.metric as Float32Array)).toEqual(PICKED.map(i => i * 10))
  })

  it('NEGATIVE CONTROL — a contiguous prefix has the right LENGTH and the wrong rows', async () => {
    // The failure this exists against, written down: both frames are 4 long, both are typed,
    // both render. Only the values tell them apart, which is why the assertion above is on the
    // values and never on the length.
    const read = readerWithMembers(Uint32Array.from([0, 1, 2, 3]))
    const out = await read({
      artifactId: 'a',
      members: { segments: [seg('a', 4)] },
    })
    expect((out.labels as unknown[]).length).toBe(PICKED.length)
    expect(out.labels).not.toEqual(PICKED.map(i => `L${i}`))
  })

  it('MULTI-SEGMENT — the fallback concatenates the segments IN THE DECLARED ORDER', async () => {
    // ITEM-15 on the path that serves § Colour by FIRST. A categorical column is `uint32` and
    // can never take the streamed branch, so if the fallback did not concatenate the segments
    // the pane's commonest column would paint one segment's rows against both segments'
    // positions — the right kind of column, silently short.
    const streaming = {
      memberIndex: async (seg: { member: string }) =>
        seg.member === 'idx-a' ? Uint32Array.from([1, 2]) : Uint32Array.from([7, 8]),
    } as unknown as WorkbenchStreamingSource
    const read = makeColumnarFrameReader(
      (() => ({ streaming, pull: undefined })) as unknown as () => ProjectSources,
      { readWhole: async () => wholeFrame() },
    )
    const ab = await read({
      artifactId: 'a',
      members: { segments: [seg('a', 2, 'idx-a'), seg('a', 2, 'idx-b')] },
    })
    expect(ab.labels).toEqual(['L1', 'L2', 'L7', 'L8'])
    expect(ab.metric).toBeInstanceOf(Float32Array)
    expect(Array.from(ab.metric as Float32Array)).toEqual([10, 20, 70, 80])

    // The REVERSED declaration — same rows, same length, different sequence. A fallback that
    // sorted, deduped or merged the segments would return `ab` here and nothing would report it.
    const ba = await read({
      artifactId: 'a',
      members: { segments: [seg('a', 2, 'idx-b'), seg('a', 2, 'idx-a')] },
    })
    expect(ba.labels).toEqual(['L7', 'L8', 'L1', 'L2'])
    expect((ba.labels as unknown[]).length).toBe((ab.labels as unknown[]).length)
    expect(ba.labels).not.toEqual(ab.labels)
  })

  it('a read declaring NO membership is byte-for-byte the read it was', async () => {
    // The state of every project that has produced no membership. A gather applied there would
    // be an identity permutation at best and a silent reshape at worst.
    const read = readerWithMembers(Uint32Array.from(PICKED))
    const out = await read({ artifactId: 'a' })
    expect(out.labels).toEqual(wholeFrame().labels)
    expect(Array.from(out.metric as Float32Array)).toEqual(Array.from(wholeFrame().metric))
  })
})

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE CORRESPONDENCE CROSSES THE CAPABILITY CONTRACT (ITEM-16, the `columnarRead` half)
//
// Core cannot import this extension (`lint-layer-boundary` R2), so a correspondence read reaches
// the byte route only through `DataApi.readColumnarFrame`. Two things had to change for it to be
// EXPRESSIBLE there at all, and this is where both are pinned:
//
//   · the segment carries a COLUMN INDEX, so `{matrix, column j}` can be named;
//   · the reader has a `value`-gather branch, because its own gate (`soleFloat32Member` of the
//     READ's artifact) is failed by a `sparse_csc` parent — and falling to `readWhole` on a
//     MATRIX is not the documented ITEM-32 slowness, it is a different column.
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe('ITEM-16 (contract) — a correspondence read crosses `readColumnarFrame`', () => {
  const A = [3, 100, 128]
  const B = [4, 255, 256, 499]

  /** The reader over the REAL gather source, with a `readWhole` that would be a LOUD wrong
   *  answer if the branch fell through to it — so "it took the value route" is asserted by the
   *  values, not by a spy on which function ran. */
  function reader(source: WorkbenchStreamingSource) {
    return makeColumnarFrameReader(
      (() => ({ streaming: source, pull: undefined })) as unknown as () => ProjectSources,
      { readWhole: async () => ({ 'the-whole-matrix': Float32Array.from([-1, -1, -1]) }) },
    )
  }

  function segments() {
    return [
      { column: VALUE_ID, columnIndex: 0, alignedTo: AXIS_DIGEST, artifact: COORD_ID, member: COORD_MEMBER, count: A.length },
      { column: VALUE_ID, columnIndex: 3, alignedTo: AXIS_DIGEST, artifact: COORD_ID, member: COORD_MEMBER_2, count: B.length },
    ]
  }

  it('routes to the `value` gather and returns the coordinate`s own rows, in order', async () => {
    const { source } = gatherRig(A, B)
    const [ci, cj] = await Promise.all([
      ungatheredValueColumn(source, 0),
      ungatheredValueColumn(source, 3),
    ])
    // The read's OWN artifact is the MATRIX — it declares no `float32` sole member, so every
    // pre-existing gate in this reader says "fall back". The branch is gated on the SEGMENTS.
    const frame = await reader(source)({ artifactId: VALUE_ID, members: { segments: segments() } })
    // ONE column, named for the PRIMARY segment's own artifact and column index — read BY NAME,
    // never by position (INV-4/ITEM-23), which is also how the consumer reads it.
    const primary = `${VALUE_ID}#0`
    expect(Object.keys(frame)).toEqual([primary])
    const gathered = frame[primary]
    expect(gathered).toBeInstanceOf(Float32Array)
    expect([...(gathered as Float32Array)]).toEqual([...A.map(r => ci[r]), ...B.map(r => cj[r])])
    // …and the fallback was NOT taken. Its answer is present in the fixture precisely so this
    // is an assertion about which route ran rather than about which values happened to match.
    expect(Object.keys(frame)).not.toContain('the-whole-matrix')
  })

  it('a segment WITHOUT a column index is not a value gather — the membership route is unchanged', async () => {
    const { source } = gatherRig(A, B)
    // The selector is OPTIONAL, and absence must mean exactly what it meant before it existed:
    // the artifact IS the column. A branch keyed on the segment merely HAVING the field would
    // capture every membership gather in the tree.
    const frame = await reader(source)({
      artifactId: CONTINUOUS_ID,
      members: { segments: segments().map(({ columnIndex: _drop, ...rest }) => ({ ...rest, column: CONTINUOUS_ID })) },
    })
    expect(Object.keys(frame)).toEqual(['the-whole-matrix'])
  })
})
