// TEST-538 (ITEM-66) — the workbench `DataSource` over the project data plane + the
// resident client `DataCtx` warm path (the two halves of the single viz seam).
//
// The DataSource half proves `positions()` returns REAL interleaved xy from the raw
// dense layout blob (2D directly + a >2-dim de-interleave + a shape-less inference),
// `catalog()` classifies the project artifacts, `continuous()` reads a dense row-axis
// column, and the honest gaps (`valueColumn`/`categorical`/`imageUnderlay`/`table`/
// `graph`/multi-file positions) throw rather than fabricate a data path.
//
// The ctx half proves `warm(refs)` fills the process-shared column cache so
// `resolveAnnotation` returns REAL values, and that a ref the client cannot address (an
// entry ref — drift DR-2) degrades to an all-NA column instead of throwing.
//
// ITEM-39 replaced this file's `createClientDataCtx()` layout block: the ctx's layout and
// grouping accessors, and the optional layout-source seam beside them, existed ONLY for the
// predicate evaluator's `inPolygon`/`inBox` geometry hit-tests, which are deleted with the
// evaluator and the dimension primitives that drove it. That source seam had had no
// production wiring since ITEM-9 deleted `createRealSelectionRuntime`.
//
// Only the octet/catalog BOUNDARY is faked (injected deps); every decode path runs for
// real. `@ziee/kit` (a browser UI boundary irrelevant to data logic) is neutralized so
// the host module imports under the node runner.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@ziee/kit', () => ({
  message: { info: () => {}, success: () => {}, error: () => {} },
}))

import { datatypeRegistry, type Datatype } from '@/core/datatypes'
// TEST-15 reads a layout's DECLARED width through the one reader every surface uses for it,
// rather than restating the expected number — the point of the case is that `structure` still
// answers, so a hand-written `2` would assert nothing about the reader that has to agree.
import { declaredDims, parseStructure } from '@/core/workstore'
import { createClientDataCtx, type ClientColumnSource } from '../../core/host/createHost'
import type { AxisSummary } from './contract'
import {
  NotReachableError,
  WorkbenchDataSource,
  WorkbenchDataSourceError,
  type DataPlaneArtifact,
  type WorkbenchDataSourceDeps,
} from './workbenchDataSource'

// The DECLARED capabilities a contributed manifest ships for the fixture datatypes — the
// catalog channels (layouts/continuous/categorical) dispatch on these (DEC-7), never on a
// hardcoded datatype id.
// The fixture's DECLARED row axis: the axis every fixture datatype binds to its first
// dimension, so `rowAxisFor` resolves it and the catalog reports its length. Named
// neutrally on purpose — the source under test must never depend on the axis's NAME.
const ROW_AXIS = 'positions'
/** The row axis's IDENTITY — the `content_hash` of the key artifact that IS it (INV-3).
 *  The label above is display only, so every fixture catalog carries both. */
const ROW_AXIS_HASH = 'h-positions'

const DATATYPE_CAPS: Record<string, string[]> = {
  'demo/layout': ['rows-aligned', 'plottable-xy'],
  'demo/column': ['rows-aligned', 'continuous-column'],
  'demo/grouping': ['categorical', 'rows-aligned'],
}

// interleaved f32 → a fresh, tightly-sized ArrayBuffer (the octet blob the endpoint serves).
function f32Buf(values: number[]): ArrayBuffer {
  return new Float32Array(values).buffer
}

function art(over: Partial<DataPlaneArtifact> = {}): DataPlaneArtifact {
  return {
    id: 'e1',
    datatype: 'demo/layout',
    is_multifile: false,
    // The `opaque` arm: a raw interleaved-f32 blob, which is what `fetchArtifactBytes`
    // below serves. A test covering the ZARR arm declares `{ encoding: 'zarr_v3', … }`
    // and gets `readPositions`/`readNumeric` instead — the dispatch is on this field.
    structure: { encoding: 'opaque' },
    ...over,
  }
}

/** A minimal REGISTRABLE datatype — the boilerplate `Datatype` requires, so a test can
 *  state only the fields it is actually about (`axes` / `labels` / `capabilities`).
 *  ITEM-12: `axes` here carry IDENTITY ONLY unless a case deliberately says otherwise. */
function demoDatatype(id: string, over: Partial<Datatype> = {}): Datatype {
  return {
    id,
    extends: null,
    title: id,
    description: id,
    storage: { layout: { kind: 'chunked_dense' }, format: 'zarr', selector_map: {}, file_layout: 'single', tiers: [] },
    capabilities: [],
    viewers: [],
    converters: [],
    is_abstract: false,
    ...over,
  } as Datatype
}

/** Merge datatypes into the REAL FE registry (replacing any same-id entry), so the
 *  registry-backed DEFAULT deps (`rowAxisFor`, `columnLabel`, `hasCapability`) resolve
 *  them exactly as the running app would — no bespoke lookup path. */
function upsertDatatypes(...types: Datatype[]): void {
  const ids = new Set(types.map(t => t.id))
  datatypeRegistry.replaceAll([...datatypeRegistry.all().filter(t => !ids.has(t.id)), ...types])
}

/** A fake data plane over a single layout + arbitrary extra artifacts/bytes. */
function makeDeps(opts: {
  /** the length of the fixture's declared row axis (`null` ⇒ the project has no
   *  entries on it, so the catalog reports no axes at all). */
  nRows: number | null
  artifacts?: DataPlaneArtifact[]
  bytesById?: Record<string, ArrayBuffer>
  metaById?: Record<string, DataPlaneArtifact>
  readSparseColumn?: WorkbenchDataSourceDeps['readSparseColumn']
  readCategorical?: WorkbenchDataSourceDeps['readCategorical']
  readPositions?: WorkbenchDataSourceDeps['readPositions']
  readNumeric?: WorkbenchDataSourceDeps['readNumeric']
  onChunk?: WorkbenchDataSourceDeps['onChunk']
  /** ITEM-14 / DEC-4 — the OPTIONAL per-column display-label override. Omitted here ⇒
   *  the source falls back to `defaultDeps()`'s registry-backed lookup, which is silent
   *  for an unregistered datatype (so a test that does not care about labels gets the
   *  raw column identifier, deterministically). */
  columnLabel?: WorkbenchDataSourceDeps['columnLabel']
}): WorkbenchDataSourceDeps {
  const artifacts = opts.artifacts ?? [art()]
  const metaById = opts.metaById ?? Object.fromEntries(artifacts.map(a => [a.id, a]))
  return {
    getCatalog: async () => ({
      axes:
        opts.nRows == null
          ? []
          : [{ content_hash: ROW_AXIS_HASH, name: ROW_AXIS, length: opts.nRows }],
      artifacts,
    }),
    getArtifact: async id => metaById[id] ?? art({ id }),
    // #159 — these fixtures declare no raster, so nothing should ever reach the reader. A
    // throwing stub rather than a silent `null`: if a change ever makes a non-raster fixture
    // try to open one, that is a discovery bug and it should be loud here.
    openPyramid: async artifactId => {
      throw new Error(`the fixture plane declares no raster; nothing should open ${artifactId}`)
    },
    fetchArtifactBytes: async id => {
      const b = opts.bytesById?.[id]
      if (!b) throw new Error(`no fake bytes for ${id}`)
      return b
    },
    // Capability-driven catalog (DEC-7): map the fixture datatypes to the DECLARED
    // capabilities a real contributed manifest ships — the catalog classifies on these,
    // not on any hardcoded datatype id.
    hasCapability: (datatypeId, capability) => DATATYPE_CAPS[datatypeId]?.includes(capability) ?? false,
    // #229 — the view-kind seam. These fixtures declare none, which is the fail-open answer
    // ("every raster is a picture") and therefore preserves the behaviour every case here was
    // written against; the label-mask cases live in `workbenchRasterDiscovery.test.ts`.
    viewKindsFor: () => [],
    // The BYTE boundary (mocked per-test; everything above it runs for real). These are
    // the four artifact reads — sparse column, categorical, positions, numeric — that
    // `artifactReader` implements over `/data/{*member}` ranges in production.
    readSparseColumn:
      opts.readSparseColumn ??
      (async () => ({ row: new Uint32Array(0), value: new Float32Array(0) })),
    readCategorical:
      opts.readCategorical ?? (async () => ({ codes: new Uint32Array(0), categories: [] })),
    readPositions:
      opts.readPositions ?? (async () => ({ positions: new Float32Array(0), length: 0 })),
    readNumeric: opts.readNumeric ?? (async () => new Float32Array(0)),
    onChunk: opts.onChunk,
    // every fixture datatype binds the SAME declared row axis.
    rowAxisFor: () => ROW_AXIS,
    ...(opts.columnLabel ? { columnLabel: opts.columnLabel } : {}),
  }
}

describe('WorkbenchDataSource.positions — real interleaved xy (ITEM-66)', () => {
  it('returns a 2D layout blob verbatim as interleaved [x0,y0,…]', async () => {
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({ nRows: 3, bytesById: { e1: f32Buf([0, 0, 5, 5, 10, 10]) } }),
    )
    const p = await ds.positions('e1')
    expect(p.length).toBe(3)
    expect(Array.from(p.positions)).toEqual([0, 0, 5, 5, 10, 10])
  })

  // ITEM-7: an `opaque` blob declares no extent (the `shape` column that used to carry
  // `{rows, cols}` is gone), so the dims come from the SAME inference the arm always had
  // as its second step — the declared row-axis length divides the float count.
  it('de-interleaves the first two dims of a >2-dim dense layout (dims from the row axis)', async () => {
    const meta = art({ id: 'e3' })
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 2,
        artifacts: [meta],
        metaById: { e3: meta },
        bytesById: { e3: f32Buf([1, 2, 99, 3, 4, 99]) },
      }),
    )
    const p = await ds.positions('e3')
    expect(p.length).toBe(2)
    expect(Array.from(p.positions)).toEqual([1, 2, 3, 4])
  })

  it('infers dims from the row-axis length when shape is empty (the real ingest case today)', async () => {
    // 2 rows × 3 floats each, shape {} → dims inferred = total/row-axis length = 3 → first-two cols.
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({ nRows: 2, bytesById: { e1: f32Buf([1, 2, 9, 3, 4, 9]) } }),
    )
    const p = await ds.positions('e1')
    expect(p.length).toBe(2)
    expect(Array.from(p.positions)).toEqual([1, 2, 3, 4])
  })

  // artifact-model ITEM-25 — the REPLACEMENT for "refuses a multi-file (Zarr) layout".
  //
  // That test asserted `positions()` threw `NotReachableError` for `is_multifile: true`,
  // and it passed for the right reason at the time: there was no client Zarr decoder, so
  // refusing beat mis-reading a manifest as coordinates. Then the producers moved to Zarr
  // and EVERY real layout artifact became multi-file (a Zarr directory) — so the
  // guard turned into an unconditional refusal of the only shape that exists, and the
  // green test certified it. It is replaced, not deleted: the same input now has to READ.
  it('reads a Zarr-declared layout through the chunked reader (was: refused as multi-file)', async () => {
    const meta = art({
      id: 'e1',
      is_multifile: true,
      structure: { encoding: 'zarr_v3', kind: 'table', arrays: [{ path: 'coords', kind: 'numeric' }] },
    })
    const seen: string[] = []
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts: [meta],
        readPositions: async (artifactId, structure) => {
          seen.push(artifactId)
          expect(structure.encoding).toBe('zarr_v3')
          return { positions: new Float32Array([1, 2, 3, 4, 5, 6]), length: 3 }
        },
      }),
    )
    const p = await ds.positions('e1')
    expect(seen).toEqual(['e1'])
    expect(p.length).toBe(3)
    expect(Array.from(p.positions)).toEqual([1, 2, 3, 4, 5, 6])
  })

  // The progressive-rendering contract at this seam: chunk arrival is forwarded, in order,
  // to whoever wants to repaint. Deleting the streaming route is only safe because this
  // hook exists — without it a large layout goes "blank, then everything".
  it('forwards chunk arrival to the injected onChunk (progressive paint survives)', async () => {
    const meta = art({
      id: 'e1',
      structure: { encoding: 'zarr_v3', kind: 'table', arrays: [{ path: 'coords', kind: 'numeric' }] },
    })
    const painted: number[] = []
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 4,
        artifacts: [meta],
        onChunk: slice => painted.push(slice.index),
        readPositions: async (_id, _structure, onChunk) => {
          // Stand in for the reader's chunk loop: two chunks, delivered in order.
          onChunk?.({ index: 0, total: 2, offset: 0, values: new Float32Array([1, 2, 3, 4]) })
          onChunk?.({ index: 1, total: 2, offset: 4, values: new Float32Array([5, 6, 7, 8]) })
          return { positions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), length: 4 }
        },
      }),
    )
    await ds.positions('e1')
    expect(painted, 'every chunk repainted, in order').toEqual([0, 1])
  })
})

describe('WorkbenchDataSource.catalog / continuous / honest gaps (ITEM-66)', () => {
  const lay = art({ id: 'lay', datatype: 'demo/layout' })
  const meta = art({ id: 'meta', datatype: 'demo/column' })
  // ITEM-7: a categorical artifact is enumerated from its DECLARED members. This is what
  // `cyto_columns`' whole-artifact column writer emits for a pandas Categorical — a
  // one-member table whose member declares its level set.
  const grp = art({
    id: 'grp',
    datatype: 'demo/grouping',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ROW_AXIS,
      n: 4200,
      columns: [{ path: 'values', kind: 'categorical', levels: ['a', 'b'] }],
    },
  })

  it('classifies the layout datatype→layouts, the column datatype→continuous, the grouping datatype→categorical', async () => {
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({ nRows: 4200, artifacts: [lay, meta, grp] }),
    )
    const cat = await ds.catalog()
    expect(cat.datasetId).toBe('p1')
    expect(cat.pointCount).toBe(4200)
    expect(cat.layouts.map(l => l.id)).toEqual(['lay'])
    expect(cat.continuousColumns.map(c => c.id)).toEqual(['meta'])
    // The key NAMES the declared member. The old bare `<artifactId>#` key is gone with
    // the empty `shape.columns` it stood in for: it resolved "the sole member", which is
    // a guess the moment an artifact declares two.
    expect(cat.categoricalColumns.map(c => c.id)).toEqual(['grp#values'])
    // value columns need the deferred column-index→NAME map — an honest empty gap.
    expect(cat.valueColumns).toEqual([])
    expect(cat.hasImage).toBe(false)
  })

  it('emits one composite <artifactId>#<member> key per DECLARED categorical member (H2)', async () => {
    // A two-member table — a string key column + a categorical label column, both
    // readable as categoricals. Under the old `shape`-driven path an artifact like this
    // offered ONE bare key that resolved "the sole member" — and threw, because it has
    // more than one. This is the shape a real multi-column producer writes.
    const multiMember = art({
      id: 'multi',
      datatype: 'demo/grouping',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: ROW_AXIS,
        n: 4,
        columns: [
          { path: 'key', kind: 'string' },
          { path: 'label', kind: 'categorical', levels: ['1', '2'] },
          // A numeric member is the CONTINUOUS channel's shape, not this one.
          { path: 'score', kind: 'numeric' },
        ],
      },
    })
    const ds = new WorkbenchDataSource('p1', makeDeps({ nRows: 4, artifacts: [multiMember] }))
    const cat = await ds.catalog()
    expect(cat.categoricalColumns.map(c => c.id)).toEqual(['multi#key', 'multi#label'])
  })

  it('excludes an artifact whose declaration cannot be read, rather than guessing at it', async () => {
    // INV-2: absence is an error. A catalog LISTING cannot throw the whole project's
    // channels away over one bad row, so the artifact contributes nothing and the reason
    // is logged — it is never given a fabricated column.
    const broken = art({ ...grp, id: 'broken', structure: { encoding: 'parquet' } })
    const ds = new WorkbenchDataSource('p1', makeDeps({ nRows: 4, artifacts: [broken] }))
    const cat = await ds.catalog()
    expect(cat.categoricalColumns).toEqual([])
  })

  it('reads a dense per-entry continuous column', async () => {
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts: [meta],
        metaById: { meta },
        bytesById: { meta: f32Buf([1.5, 2.5, 3.5]) },
      }),
    )
    const c = await ds.continuous('meta')
    expect(c.length).toBe(3)
    expect(Array.from(c.value)).toEqual([1.5, 2.5, 3.5])
  })

  // ── ITEM-29: the DEFAULT read dep goes through the TYPED surface ────────────────
  //
  // Every test above injects `readNumeric`, so none of them can tell what the PRODUCTION
  // default does. These two do: they leave `readNumeric` out entirely, so the source runs
  // `defaultDeps()`'s real dep — `ApiClient.Workstore.readColumn({expect: 'numeric'})`.
  //
  // The guarantee being asserted is not "an error happens". It is that the continuous
  // channel now DECLARES what it expects, so a member the producer declared `categorical`
  // is refused at the boundary NAMING BOTH KINDS, before a byte is requested. On the
  // previous wiring (`readNumericColumn`) this same input silently coerced the column's
  // CODES into a `Float32Array` and painted them as a continuous ramp — a plausible wrong
  // picture with nothing raised anywhere.
  it('the DEFAULT continuous read declares `expect: "numeric"` and refuses a categorical member', async () => {
    const { WorkstoreTypeMismatch } = await import('@/core/workstore')
    const categoricalTable: DataPlaneArtifact = {
      id: 'cat-col',
      // A NEUTRAL fixture datatype id: `continuous()` never consults the capability
      // registry (only `catalog()` does), so this test needs no domain type at all.
      datatype: 'fixture-column',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        // The producer's own spelling for a pandas Categorical column
        // (`cyto_columns`' column writer → `cyto_zarr.Table.categorical`).
        columns: [{ path: 'values', kind: 'categorical', levels: ['a', 'b'], n: 3 }],
      },
    }
    // NOTE: `readNumeric` is deliberately ABSENT — the constructor fills it from
    // `defaultDeps()`, which is the thing under test.
    const ds = new WorkbenchDataSource('p1', {
      getCatalog: async () => ({
        axes: [{ content_hash: ROW_AXIS_HASH, name: ROW_AXIS, length: 3 }],
        artifacts: [categoricalTable],
      }),
      getArtifact: async () => categoricalTable,
      hasCapability: () => false,
      rowAxisFor: () => ROW_AXIS,
    })

    const err = await ds.continuous('cat-col').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err, 'a categorical member must not read as a continuous column').toBeInstanceOf(
      WorkstoreTypeMismatch,
    )
    const mismatch = err as InstanceType<typeof WorkstoreTypeMismatch>
    expect(mismatch.expected).toBe('numeric')
    expect(mismatch.actual).toBe('categorical')
    expect(mismatch.vocabulary).toBe('kind')
    expect(mismatch.message).toContain('cat-col')
  })

  it('…and the DECLARED-numeric member gets PAST that check (negative control)', async () => {
    // Anti-vacuity for the case above: without this, a default dep that threw
    // `WorkstoreTypeMismatch` unconditionally — or one that never resolved a declaration at
    // all — would satisfy it. Same source, same absent `readNumeric`, only the member's
    // declared `kind` differs; the read must proceed past the declaration check and fail at
    // the TRANSPORT instead (there is no server here), i.e. NOT with a type mismatch.
    const numericTable: DataPlaneArtifact = {
      id: 'num-col',
      datatype: 'fixture-column',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        columns: [{ path: 'values', kind: 'numeric', dtype: 'float32', n: 3 }],
      },
    }
    const ds = new WorkbenchDataSource('p1', {
      getCatalog: async () => ({
        axes: [{ content_hash: ROW_AXIS_HASH, name: ROW_AXIS, length: 3 }],
        artifacts: [numericTable],
      }),
      getArtifact: async () => numericTable,
      hasCapability: () => false,
      rowAxisFor: () => ROW_AXIS,
    })

    const err = await ds.continuous('num-col').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err, 'the read must have been attempted, so it must have failed').not.toBeNull()
    expect((err as Error).name).not.toBe('WorkstoreTypeMismatch')
    // Positive evidence that it got PAST the check rather than failing earlier: the failure
    // is the TRANSPORT's, and it names the member's own `zarr.json` — i.e. the read reached
    // the point of asking the store for that member. (`window is not defined` here: the
    // base-URL resolver has no browser to read, which is exactly as far as a test with no
    // server can get.)
    expect((err as Error).name).toBe('WorkstoreHttpError')
    expect((err as Error).message).toContain('num-col/values/zarr.json')
  })

  it('throws NotReachableError for image/table/graph (no fabrication)', async () => {
    const ds = new WorkbenchDataSource('p1', makeDeps({ nRows: 1, artifacts: [] }))
    await expect(ds.imageUnderlay()).rejects.toBeInstanceOf(NotReachableError)
    await expect(ds.table('t1')).rejects.toBeInstanceOf(NotReachableError)
    await expect(ds.graph('traj')).rejects.toBeInstanceOf(NotReachableError)
  })

  it('reads a value column off the Arrow /read channel (composite key)', async () => {
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 6,
        artifacts: [],
        // mock ONLY the octet boundary (the arrow /read fetch) — the composite-key
        // parse + wire-through run for real.
        readSparseColumn: async (artifactId, col) => {
          expect(artifactId).toBe('expr')
          expect(col).toBe(3)
          return { row: new Uint32Array([0, 2, 5]), value: new Float32Array([1.5, 2.5, 3.5]) }
        },
      }),
    )
    const sc = await ds.valueColumn('expr#3')
    expect(Array.from(sc.row)).toEqual([0, 2, 5])
    expect(Array.from(sc.value)).toEqual([1.5, 2.5, 3.5])
    expect(sc.length).toBe(6) // dense length = pointCount
    // a malformed key (no `#<index>`) is a typed error, never a fabricated column.
    await expect(ds.valueColumn('')).rejects.toBeInstanceOf(WorkbenchDataSourceError)
  })

  it('reads an annotation categorical column (declared codes + level set)', async () => {
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 4,
        artifacts: [],
        readCategorical: async (artifactId, structure, column) => {
          expect(artifactId).toBe('ann')
          expect(structure.encoding).toBe('opaque') // whatever the row declares, carried through
          expect(column).toBe('label')
          return { codes: new Uint32Array([0, 1, 0, 1]), categories: ['grpA', 'grpB'] }
        },
      }),
    )
    const c = await ds.categorical('ann#label')
    // The viz consumer packs to u16; the decoder's Uint32 codes are narrowed losslessly.
    expect(c.codes).toBeInstanceOf(Uint16Array)
    expect(Array.from(c.codes)).toEqual([0, 1, 0, 1])
    expect(c.categories).toEqual(['grpA', 'grpB'])
    expect(c.length).toBe(4)
    // An EMPTY key (no artifactId) is a typed error; a bare `<artifactId>` (col 0) is valid.
    await expect(ds.categorical('')).rejects.toBeInstanceOf(WorkbenchDataSourceError)
  })

  /**
   * ONE sparse fixture builder for every CSC catalog case below.
   *
   * It is a helper rather than three near-copies because the three cases differ ONLY in the
   * declared `shape`, which is the variable under test. (It carried a second reason while
   * the fixture's datatype id and row-axis option name were still DOMAIN vocabulary,
   * count-ratcheted per file by `lint-no-domain-in-builtin`: writing them once kept a new
   * case from raising that ratchet. Both are neutral now, so only the first reason stands.)
   */
  const sparseCatalog = async (shape: unknown) => {
    const expr = art({
      id: 'expr',
      datatype: 'demo/expression',
      structure: {
        encoding: 'zarr_v3',
        kind: 'sparse_csc',
        axes: [ROW_AXIS, 'columns'],
        ...(shape === undefined ? {} : { shape }),
        indptr: { path: 'indptr' },
        indices: { path: 'indices' },
        data: { path: 'data' },
      } as never,
    })
    return new WorkbenchDataSource('p1', makeDeps({ nRows: 6, artifacts: [expr] })).catalog()
  }

  // NOTE the title below kept its domain wording through the r20 refactor, deliberately:
  // every such word was already baselined for this file, and that ratchet is
  // shrink-only-DELIBERATELY, so dropping one incidentally — in a change about a
  // silent-empty bug — would have spent a `--prune-baseline` on a rename nobody had
  // decided on. The rename IS decided now, so it reads like the rest of the fixture.
  it('surfaces sparse value-columns in the catalog (composite keys, capped)', async () => {
    // ITEM-7: "is this a sparse matrix" and "how many columns" both come off the
    // producer's declaration (`kind: sparse_csc` + `shape: [rows, columns]`) — previously
    // `storage_layout === 'chunked-sparse'` plus `shape.cols`, two columns that could
    // disagree with each other and with the bytes.
    expect((await sparseCatalog([6, 3])).valueColumns).toEqual(['expr#0', 'expr#1', 'expr#2'])
  })

  // r20 — the SILENT-EMPTY sibling of the `pointCount` refusal below. `Math.min(cols ?? 0,
  // CAP)` turned a `sparse_csc` whose declared `shape` is missing or unreadable into zero
  // value columns with nothing warned and nothing thrown, and nothing upstream catches it:
  // the server's `validate_declared_structure` requires only an object naming an
  // `encoding`, and `parseStructure` checks `encoding` + `kind`. Absence is an error
  // (INV-2), not a zero.
  it.each([
    ['no `shape` at all', undefined, /declares no second dimension/],
    ['a `shape` that is not a list', 'huge', /unreadable declared shape/],
    ['a `shape` with a non-number entry', ['6', 3], /unreadable declared shape/],
    ['a 1-D `shape` (no second dimension)', [6], /declares no second dimension/],
  ])('SAYS SO instead of silently serving zero value columns: %s', async (_label, shape, expected) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await sparseCatalog(shape)
      // The OUTCOME is still "no columns" — a listing must not throw, so one bad row
      // cannot take the project's other channels with it…
      expect(cat.valueColumns).toEqual([])
      expect(cat.pointCount).toBe(6)
      // …but the REASON is recoverable, which is the whole difference from before.
      expect(warn).toHaveBeenCalled()
      const said = warn.mock.calls.map(c => c.join(' ')).join('\n')
      expect(said).toMatch(expected)
      expect(said).toMatch(/expr/)
    } finally {
      warn.mockRestore()
    }
  })

  it('NEGATIVE CONTROL: a well-formed declaration warns about nothing', async () => {
    // Without this, "it warns" above would be satisfied by a build that warns ALWAYS.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await sparseCatalog([6, 2])).valueColumns).toEqual(['expr#0', 'expr#1'])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// INV-3 at the `WorkbenchDataSource` seam — the LAST layer that turned an axis refusal
// back into a name-keyed guess.
//
// `axisByLabel` refuses a label that names two distinct axes (`axisIdentity.test.ts`), but
// three call sites here spelled that refusal `?? cat.axes[0]?.length ?? 0`. The refusal is
// what MADE that fallback reachable: before the hardening the label resolved to the first
// same-label match, so the `??` arm was dead. After it, an ambiguous label falls straight
// through to axis 0 — a DIFFERENT axis, chosen by its position in a list the caller never
// saw, with a real and entirely plausible cardinality.
//
// The fixture is the shape that discriminates: THREE declared axes, of which TWO share a
// label, and axis 0 is neither of them. A project with unique labels produces identical
// numbers before and after, which is why this survived five previous layers of the fix.
describe('WorkbenchDataSource — an ambiguous row-axis label is REFUSED, never resolved to axis 0', () => {
  /** `[{columns,32000}, {rows,1000}, {rows,5000}]`: the two `rows` axes are distinct
   *  identities (INV-3 permits the shared label), and `columns` — the axis nothing here is
   *  aligned to — is FIRST, so a positional fallback is visibly wrong rather than
   *  coincidentally right. Named neutrally: the source under test must never depend on an
   *  axis's NAME, so the shape is what matters and the labels carry no meaning. */
  const AMBIGUOUS_AXES: AxisSummary[] = [
    { content_hash: 'h-columns', name: 'columns', length: 32000 },
    { content_hash: 'h-rows-a', name: 'rows', length: 1000 },
    { content_hash: 'h-rows-b', name: 'rows', length: 5000 },
  ]
  /** The same project with the collision removed — the negative control's axes. */
  const UNAMBIGUOUS_AXES: AxisSummary[] = [
    { content_hash: 'h-columns', name: 'columns', length: 32000 },
    { content_hash: 'h-rows-a', name: 'rows', length: 1000 },
  ]

  /** ONE artifact feeding the `plottable-xy` channel, whose datatype declares `rows` as its
   *  row axis. A NEUTRAL fixture datatype id with a per-test capability answer, so nothing
   *  here depends on a domain datatype or on the capability table above. */
  const XY = art({ id: 'xy-1', datatype: 'fixture-layout' })

  function sourceOver(axes: AxisSummary[]): WorkbenchDataSource {
    return new WorkbenchDataSource('p-ambig', {
      getCatalog: async () => ({ axes, artifacts: [XY] }),
      getArtifact: async id => (id === 'xy-1' ? XY : art({ id })),
      hasCapability: (_datatypeId, capability) => capability === 'plottable-xy',
      // The DECLARED row-axis LABEL — ambiguous against `AMBIGUOUS_AXES`, resolvable
      // against `UNAMBIGUOUS_AXES`. Same declaration in both; only the project differs.
      rowAxisFor: () => 'rows',
      readSparseColumn: async () => ({
        row: new Uint32Array([0, 2, 5]),
        value: new Float32Array([1.5, 2.5, 3.5]),
      }),
    })
  }

  it('catalog().pointCount reports NO count (not axis 0\'s 32000) and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await sourceOver(AMBIGUOUS_AXES).catalog()
      // The confirmed defect: `?? cat.axes[0]?.length` answered 32000 here — the
      // cardinality of an axis nothing is aligned to, reported as the number of POINTS.
      expect(cat.pointCount).not.toBe(32000)
      // …and it is not silently one of the two `rows` candidates either.
      expect(cat.pointCount).not.toBe(1000)
      expect(cat.pointCount).not.toBe(5000)
      expect(cat.pointCount).toBe(0)
      // the refusal is RECOVERABLE, and names both colliding identities.
      expect(warn).toHaveBeenCalledTimes(1)
      const said = warn.mock.calls[0].map(String).join(' ')
      expect(said).toContain('AXIS_AMBIGUOUS')
      expect(said).toContain('h-rows-a (length 1000)')
      expect(said).toContain('h-rows-b (length 5000)')
    } finally {
      warn.mockRestore()
    }
  })

  it('valueColumn() THROWS rather than densifying over axis 0', async () => {
    // Oracle-confirmed second site: `valueColumn().length` also answered 32000, so the
    // sparse non-zeros would have been densified over an unrelated entity set.
    const err = await sourceOver(AMBIGUOUS_AXES)
      .valueColumn('expr#3')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(WorkbenchDataSourceError)
    expect((err as Error).message).toContain('AXIS_AMBIGUOUS')
    expect((err as Error).message).toContain('value column "expr#3"')
  })

  it('positions() on an opaque layout THROWS rather than inferring dims from axis 0', async () => {
    // 6 floats: with the refused count (32000) the old path could not divide, and with
    // 1000 or 5000 it would reshape the cloud. Either way the number is not knowable, so
    // the read fails instead of painting.
    const ds = new WorkbenchDataSource('p-ambig', {
      getCatalog: async () => ({ axes: AMBIGUOUS_AXES, artifacts: [XY] }),
      getArtifact: async () => XY,
      fetchArtifactBytes: async () => f32Buf([0, 0, 5, 5, 10, 10]),
      hasCapability: () => false,
      rowAxisFor: () => 'rows',
    })
    const err = await ds.positions('xy-1').then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(WorkbenchDataSourceError)
    expect((err as Error).message).toContain('AXIS_AMBIGUOUS')
    expect((err as Error).message).toContain('layout "xy-1"')
  })

  // ── NEGATIVE CONTROL ────────────────────────────────────────────────────────────────
  // Without this, "throw / report 0 on every project whose axes I dislike" would pass the
  // three cases above. Same artifacts, same declared row-axis label, ONE `rows` axis: the
  // reads must resolve it BY IDENTITY and produce its 1000 — never axis 0's 32000, which
  // is also what the positional fallback would have answered here.
  it('[control] the SAME declaration resolves normally when the label names ONE axis', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const ds = sourceOver(UNAMBIGUOUS_AXES)
      expect((await ds.catalog()).pointCount).toBe(1000)
      const sc = await ds.valueColumn('expr#3')
      expect(sc.length).toBe(1000)
      expect(Array.from(sc.row)).toEqual([0, 2, 5])
      expect(Array.from(sc.value)).toEqual([1.5, 2.5, 3.5])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('[control] an opaque layout still reads, with dims from the resolved row axis', async () => {
    // 3 positions × 2 dims over a 3-long `rows` axis — the resolution feeds the SAME
    // inference the ambiguous case refuses to feed.
    const ds = new WorkbenchDataSource('p-ambig', {
      getCatalog: async () => ({
        axes: [
          { content_hash: 'h-columns', name: 'columns', length: 32000 },
          { content_hash: 'h-rows-a', name: 'rows', length: 3 },
        ],
        artifacts: [XY],
      }),
      getArtifact: async () => XY,
      fetchArtifactBytes: async () => f32Buf([0, 0, 5, 5, 10, 10]),
      hasCapability: () => false,
      rowAxisFor: () => 'rows',
    })
    const p = await ds.positions('xy-1')
    expect(p.length).toBe(3)
    expect(Array.from(p.positions)).toEqual([0, 0, 5, 5, 10, 10])
  })
})

// INV-3 — the u16 narrowing at the GPU hand-off has exactly ONE implementation
// (`toUint16Codes`), and this method is the boundary its docstring names. The rule used to
// be re-stated inline here with a message claiming a cap (">65535") that its own check did
// not enforce; 65536 levels is the correct cap (a u16 code spans 0…65535).
describe('WorkbenchDataSource.categorical — the u16 cap is the codec\'s, stated once', () => {
  function sourceWithLevels(count: number): WorkbenchDataSource {
    // Codes are irrelevant to the cap (it is the LEVEL count that decides), so keep them
    // tiny and let the category list carry the size.
    const categories = Array.from({ length: count }, (_, i) => `lvl-${i}`)
    return new WorkbenchDataSource('p-cap', {
      getCatalog: async () => ({ axes: [], artifacts: [] }),
      getArtifact: async id => art({ id }),
      readCategorical: async () => ({ codes: new Uint32Array([0, 1]), categories }),
    })
  }

  it('accepts a level set of exactly 65536 — the largest a u16 code can address', async () => {
    const c = await sourceWithLevels(65536).categorical('ann-1#label')
    expect(c.codes).toBeInstanceOf(Uint16Array)
    expect(Array.from(c.codes)).toEqual([0, 1])
    expect(c.categories.length).toBe(65536)
  })

  it('refuses 65537 with the codec\'s own wording, naming the column', async () => {
    const err = await sourceWithLevels(65537)
      .categorical('ann-1#label')
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(WorkbenchDataSourceError)
    // the codec's message (one implementation) …
    expect((err as Error).message).toContain('cannot narrow 65537 categories to uint16 codes')
    expect((err as Error).message).toContain('max 65536')
    // … plus the column, which the codec cannot know.
    expect((err as Error).message).toContain('categorical column "ann-1#label"')
  })
})

describe('createClientDataCtx().warm(refs) — resident columns vs. honest degrade', () => {
  /** A column source over a project whose declared axes are named by the CALLER — the
   *  ctx must derive `n` from them, never from a fixed field name. */
  function source(
    length: number,
    values: number[],
    axisName = ROW_AXIS,
  ): ClientColumnSource {
    return {
      catalog: async () => ({
        axes: [{ content_hash: `h-${axisName}`, name: axisName, length }],
      }),
      readColumn: async () => ({ values: Float32Array.from(values) }),
    }
  }

  it('warms a col ref into the shared cache so resolveAnnotation returns the REAL values', async () => {
    const { ctx, warm } = createClientDataCtx(source(4, [1, 2, 3, 4]), 'p-warm-1')
    await warm([{ col: 'col_a' }])
    const c = ctx.resolveAnnotation(ctx.positionAxis, 'col_a')
    if (!c) throw new Error('resolveAnnotation returned undefined')
    expect(Array.from(c.values)).toEqual([1, 2, 3, 4])
    expect(Array.from(c.na)).toEqual([0, 0, 0, 0])
  })

  it('warms the EXPLICIT axis-scoped annotation ref ON THE AXIS IT NAMES', async () => {
    // Both axes the refs below name are DECLARED. That is the fixture change INV-3 forced:
    // the cache key is the axis's `content_hash`, so a ref's label has to resolve to a
    // declared axis for the column to have a slot at all. It used to name `region` against a
    // catalog declaring only `positions`, and the label-keyed cache served the column anyway
    // — sized by the POSITION axis's `n`, for an axis the project never reported. The claim
    // under test is unchanged and now sharper: the same column NAME on a DIFFERENT axis is a
    // distinct entry because the two axes are distinct identities, not distinct strings.
    const twoAxes: ClientColumnSource = {
      catalog: async () => ({
        axes: [
          { content_hash: 'h-region', name: 'region', length: 3 },
          { content_hash: 'h-channel', name: 'channel', length: 3 },
        ],
      }),
      readColumn: async () => ({ values: Float32Array.from([7, 8, 9]) }),
    }
    const { ctx, warm } = createClientDataCtx(twoAxes, 'p-warm-2')
    await warm([{ axis: 'region', annotation: 'mean_intensity' }])
    expect(Array.from(ctx.resolveAnnotation('region', 'mean_intensity')?.values ?? [])).toEqual([
      7, 8, 9,
    ])
    // …and NOT on some other axis: the warm cache is keyed by (axis identity, name), so the
    // same column NAME on a different axis is a distinct, still-uncovered entry (B1).
    expect(Array.from(ctx.resolveAnnotation('channel', 'mean_intensity')?.na ?? [])).toEqual([
      1, 1, 1,
    ])
  })

  it('degrades a ref naming an UNDECLARED axis to all-NA instead of serving it', async () => {
    // The behaviour change stated as its own case (INV-3). A label the catalog does not
    // report identifies no axis, so there is no identity to key the column by and no
    // cardinality to size it with — the ctx cannot serve it without inventing both. It is
    // reachable only from an explicit `{axis, annotation}` ref (a `{col}`/`{metric}` ref
    // takes the position axis, which is a declared axis by construction), and nothing in
    // the app emits one yet.
    const { ctx, warm } = createClientDataCtx(source(3, [7, 8, 9]), 'p-warm-undeclared')
    await warm([{ axis: 'nowhere', annotation: 'mean_intensity' }])
    const c = ctx.resolveAnnotation('nowhere', 'mean_intensity')
    expect(Array.from(c?.na ?? [])).toEqual([1, 1, 1])
    expect(Array.from(c?.values ?? [])).toEqual([0, 0, 0])
  })

  // B2 (DOMAIN_AUDIT §2) REGRESSION GUARD. `n` used to be read off ONE privileged,
  // domain-named catalog field, so a catalog with a different axis set (one whose axes are
  // `region`/`channel`, or `comparison`/`target`) reported n = 0 → naColumn(0) → EVERY
  // column silently resolved empty, and the surrounding `catch {}` hid it. `n` is now the
  // length of the DECLARED position axis, whatever it is called.
  it('[B2] derives N from the DECLARED position axis, for an axis set with no domain noun in it', async () => {
    const { ctx, warm, refresh } = createClientDataCtx(source(12, [1, 2, 3], 'region'), 'p-b2')
    await refresh()
    expect(ctx.positionAxis).toBe('region')
    expect(ctx.n).toBe(12)
    await warm([{ axis: 'region', annotation: 'area_px' }])
    const c = ctx.resolveAnnotation('region', 'area_px')
    if (!c) throw new Error('resolveAnnotation returned undefined')
    expect(c.values.length).toBe(12)
    // the first three positions carry the read values; the rest are honestly uncovered.
    expect(Array.from(c.values.slice(0, 3))).toEqual([1, 2, 3])
    expect(Array.from(c.na.slice(0, 3))).toEqual([0, 0, 0])
  })

  it('[B2] a FAILED catalog read is recorded, not swallowed into an all-empty ctx', async () => {
    const boom = new Error('catalog unreachable')
    const { ctx, refresh, lastError } = createClientDataCtx(
      {
        catalog: async () => {
          throw boom
        },
        readColumn: async () => ({ values: new Float32Array() }),
      },
      'p-b2-err',
    )
    await refresh()
    expect(lastError()).toBe(boom)
    expect(ctx.n).toBe(0)
  })

  it('[B2] an explicitly named position axis wins over the catalog order', async () => {
    const { ctx, refresh } = createClientDataCtx(
      {
        catalog: async () => ({
          axes: [
            { content_hash: 'h-comparison', name: 'comparison', length: 3 },
            { content_hash: 'h-target', name: 'target', length: 20000 },
          ],
        }),
        readColumn: async () => ({ values: new Float32Array() }),
      },
      'p-b2-named',
      { positionAxis: 'target', valueAxis: 'comparison' },
    )
    await refresh()
    expect(ctx.positionAxis).toBe('target')
    expect(ctx.valueAxis).toBe('comparison')
    expect(ctx.n).toBe(20000)
  })

  it('skips a ref the client cannot address (an entry ref — DR-2) and degrades to all-NA, never throws', async () => {
    const { ctx, warm } = createClientDataCtx(source(3, [1, 2, 3]), 'p-warm-3')
    await warm([{ entry: 'entry-1' }])
    // nothing was cached for it (the warm loop skipped the entry ref)…
    expect(Array.from(ctx.resolveAnnotation(ctx.positionAxis, 'entry-1')?.na ?? [])).toEqual([1, 1, 1])
    // …and reading it yields an UNCOVERED column rather than raising (the ctx never throws).
    const g = ctx.readColumn({ entry: 'entry-1' })
    expect(Array.from(g.na)).toEqual([1, 1, 1])
    expect(Array.from(g.values)).toEqual([0, 0, 0])
  })
})

// ─────────────────────── TEST-5 [acceptance, INV-5] (ITEM-12) ───────────────────────
//
// REPLACES "dimension-primitives TEST-4 (ITEM-5) — declared, axis-scoped, type-driven".
// That suite asserted the OPPOSITE contract: `annotationsForAxis` returned the datatype's
// DECLARED `AxisSpec.annotations` merged with an analysis' `produces_annotations`, and
// `[]` for a datatype declaring none. Both inputs are deleted (INV-5), so those four cases
// have no subject left — they are replaced, not relaxed, and the replacement asserts the
// inverse claim on the same method.
//
// INV-5: *facts about produced data are read from artifacts, never declared ahead of time.*
// The measurement that motivated it, encoded below: on one real imported dataset 8 of the
// datatype's 9 DECLARED annotations DID NOT EXIST, while the dataset carried 65 metadata
// columns the declaration never mentioned. So the acceptance is two-sided —
//   (a) every column an artifact STAMPED is reported, INCLUDING one no analysis declared;
//   (b) every column a declaration merely PROMISED is absent unless an artifact stamped it.
// Flip the invariant off (read the declaration again) and (a)'s `label_b` disappears
// while (b)'s eight phantoms come back; both directions go red.
describe('WorkbenchDataSource.annotationsForAxis — read from the artifacts, not the declaration (TEST-5, INV-5)', () => {
  /** The datatype under test. Its `axes` carry IDENTITY ONLY (ITEM-12) — the assertion
   *  below checks that, so "a datatype whose declaration contains NO annotations" is a
   *  verified premise of this suite rather than a claim in a comment. */
  const DECLARATION_FREE: Datatype = demoDatatype('demo/matrix', {
    axes: [{ name: ROW_AXIS, key_label: 'entry_id' }],
  })

  /** THE MEASUREMENT ON ONE REAL IMPORTED DATASET, as a fixture: a legacy datatype that
   *  still forecasts the 9 columns a dataset "would" carry. Exactly ONE of them
   *  (`label_a`) is stamped by an artifact below; the other EIGHT do not exist — the
   *  shipped ratio. */
  const FORECAST_COLUMNS = [
    'label_a', // the one that exists
    'metric_a',
    'metric_b',
    'metric_c',
    'metric_d',
    'metric_e',
    'metric_f',
    'metric_g',
    'metric_h',
  ]
  const LEGACY_FORECASTER: Datatype = demoDatatype('demo/legacy-forecaster', {
    axes: [
      {
        name: ROW_AXIS,
        key_label: 'entry_id',
        // The removed shape, present precisely so the test can prove it is IGNORED — a
        // fixture that declared nothing could not tell the two contracts apart.
        //
        // It now needs a CAST to exist at all: `AxisSpec.annotations` was deleted from the
        // type (not merely emptied), so this is no longer "an optional back-compat field"
        // as the old comment claimed. The cast is the point — a forecast can only reach
        // this code by lying about its type, which is the strongest form of the guarantee.
        annotations: FORECAST_COLUMNS.map(name => ({
          name,
          label: name,
          type: 'categorical' as const,
          capability: 'categorical',
        })),
      },
    ],
  } as unknown as Partial<Datatype>)

  // The columns that ACTUALLY LANDED on the project, each stamping its own kind:
  //   `a-ann`    a Zarr table with two CATEGORICAL members — `label_a` (which the legacy
  //              forecast also names) and `label_b`, which NO analysis and NO datatype
  //              ever declared (a user's own annotation upload). `label_b` is the clause
  //              that would have failed before.
  //   `a-metric` a CONTINUOUS metric column (capability-classified; an opaque blob).
  //   `a-expr`   a CSC matrix → VALUE columns.
  const artifacts: DataPlaneArtifact[] = [
    art({
      id: 'a-ann',
      datatype: 'demo/grouping',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: ROW_AXIS,
        n: 3,
        columns: [
          { path: 'label_a', kind: 'categorical', levels: ['B', 'T'] },
          { path: 'label_b', kind: 'categorical', levels: ['d1', 'd2'] },
        ],
      },
    }),
    art({ id: 'a-metric', datatype: 'demo/column' }),
    art({
      id: 'a-expr',
      datatype: 'demo/expression',
      structure: { encoding: 'zarr_v3', kind: 'sparse_csc', shape: [3, 2] },
    }),
  ]

  /** What the catalog stamps, in catalog order: two categorical members, one continuous
   *  artifact, two value columns. */
  const STAMPED: Array<[string, string]> = [
    ['a-ann#label_a', 'categorical'],
    ['a-ann#label_b', 'categorical'],
    ['a-metric', 'continuous'],
    ['a-expr#0', 'value'],
    ['a-expr#1', 'value'],
  ]

  it('the datatype under test declares axis IDENTITY only — no annotations (the ITEM-12 premise)', () => {
    for (const axis of DECLARATION_FREE.axes ?? []) {
      expect(Object.keys(axis).sort()).toEqual(['key_label', 'name'])
      expect((axis as { annotations?: unknown }).annotations).toBeUndefined()
    }
  })

  it('returns ONE entry per column the artifacts stamped, with the STAMPED type', async () => {
    const ds = new WorkbenchDataSource('p1', makeDeps({ nRows: 3, artifacts }))
    const annotations = await ds.annotationsForAxis(DECLARATION_FREE.id, ROW_AXIS)
    expect(annotations.map(a => [a.name, a.type])).toEqual(STAMPED)
    // the type drives the control shape, so it must also carry the matching catalog
    // channel — the same capability the value plane resolves the column through.
    expect(annotations.map(a => a.capability)).toEqual([
      'categorical',
      'categorical',
      'continuous-column',
      'value-column',
      'value-column',
    ])
  })

  it('includes a column NO analysis and NO datatype ever declared (the 65-unmentioned-columns half)', async () => {
    const ds = new WorkbenchDataSource('p1', makeDeps({ nRows: 3, artifacts }))
    const annotations = await ds.annotationsForAxis(DECLARATION_FREE.id, ROW_AXIS)
    const undeclared = annotations.find(a => a.name === 'a-ann#label_b')
    expect(undeclared, 'a stamped column absent from every declaration must still be reported').toBeDefined()
    // …and it arrives TYPED, from the artifact's own stamp — so it is filterable/groupable
    // exactly like a declared one. Under the old contract it was invisible.
    expect(undeclared?.type).toBe('categorical')
    expect(undeclared?.available).toBe(true)
  })

  it('a DECLARED column that no artifact stamped is NOT reported (the 8-of-9 half)', async () => {
    // The legacy datatype is registered through the REAL registry, so its forecast is
    // genuinely present and genuinely reachable — and still contributes nothing.
    upsertDatatypes(LEGACY_FORECASTER)
    const ds = new WorkbenchDataSource('p1', makeDeps({ nRows: 3, artifacts }))
    const annotations = await ds.annotationsForAxis(LEGACY_FORECASTER.id, ROW_AXIS)
    // identical to the declaration-free datatype's answer: the declaration changed nothing.
    expect(annotations.map(a => [a.name, a.type])).toEqual(STAMPED)
    const forecastOnly = FORECAST_COLUMNS.filter(c => c !== 'label_a')
    expect(forecastOnly).toHaveLength(8)
    for (const phantom of forecastOnly) {
      expect(annotations.some(a => a.name === phantom || a.name.endsWith(`#${phantom}`))).toBe(false)
    }
  })

  it('a project with NO artifacts yields NO columns — even for a datatype forecasting nine', async () => {
    upsertDatatypes(LEGACY_FORECASTER)
    const ds = new WorkbenchDataSource('p1', makeDeps({ nRows: 3, artifacts: [] }))
    expect(await ds.annotationsForAxis(LEGACY_FORECASTER.id, ROW_AXIS)).toEqual([])
  })
})

// ─────────────────────────── TEST-23 (ITEM-14 / DEC-4) ───────────────────────────
//
// The label override — all that survives of the removed `annotations` block, reduced from
// a schema CLAIM to a LOOKUP. The property the old list lacked, and the one asserted here:
// a lookup cannot assert that a column exists, so an override naming an absent column is
// silently ignored instead of conjuring a row.
//
// ── WHY TWO CASES BELOW ARE RE-KEYED (DEFECT B) ─────────────────────────────────────────
//
// This suite used to assert that the override is consulted with the SAME identifier the
// entry reports as its `name`. That coherence claim was correct in form and wrong in
// substance: `name` is the catalog's channel ADDRESS, which carries the artifact id, and a
// real artifact id is a server-minted UUID. So the identifier an author had to key their
// map on was one they could not know until after the run — and `Datatype.labels`' own
// documented shape (`{ metric_a: "Metric A" }`) could never match. The property is
// not dropped, it is RE-EXPRESSED against the key that replaced it: the entry now reports
// its lookup key as `column` (the column's own name), and the override is consulted with
// exactly that. See the DEFECT B suite at the end of this file for the full statement;
// the two cases here are the same claims, re-keyed.
describe('WorkbenchDataSource.annotationsForAxis — columnLabel overrides (TEST-23, ITEM-14)', () => {
  const artifacts: DataPlaneArtifact[] = [
    art({
      id: 'a-ann',
      datatype: 'demo/grouping',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: ROW_AXIS,
        n: 3,
        columns: [{ path: 'label_a', kind: 'categorical', levels: ['B', 'T'] }],
      },
    }),
    art({ id: 'a-metric', datatype: 'demo/column' }),
    art({
      id: 'a-expr',
      datatype: 'demo/expression',
      structure: { encoding: 'zarr_v3', kind: 'sparse_csc', shape: [3, 1] },
    }),
  ]

  it('an override RENAMES that column; a column with no override keeps its fallback label', async () => {
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts,
        // RE-KEYED (DEFECT B): the key is the column's own NAME, not the channel address.
        columnLabel: (datatypeId, name) =>
          datatypeId === 'demo/matrix' && name === 'label_a' ? 'Label A' : undefined,
      }),
    )
    const annotations = await ds.annotationsForAxis('demo/matrix', ROW_AXIS)
    const renamed = annotations.find(a => a.name === 'a-ann#label_a')
    expect(renamed?.label).toBe('Label A')
    // the un-overridden neighbours are untouched: the catalog's own label where it has
    // one, and the RAW NAME where it does not (a value column carries no catalog label).
    expect(annotations.find(a => a.name === 'a-metric')?.label).toBe('demo/column · a-metric')
    expect(annotations.find(a => a.name === 'a-expr#0')?.label).toBe('a-expr#0')
  })

  it('with NO override at all, every label falls back (raw name where the catalog has none)', async () => {
    const ds = new WorkbenchDataSource('p1', makeDeps({ nRows: 3, artifacts }))
    const annotations = await ds.annotationsForAxis('demo/matrix', ROW_AXIS)
    expect(annotations.map(a => a.name)).toEqual(['a-ann#label_a', 'a-metric', 'a-expr#0'])
    // a value column carries no catalog label, so the fallback bottoms out at the RAW NAME.
    const valueColumn = annotations.find(a => a.name === 'a-expr#0')!
    expect(valueColumn.label).toBe('a-expr#0')
    // …and the catalog's own label is used where there IS one (the middle fallback rung).
    expect(annotations.find(a => a.name === 'a-ann#label_a')!.label).toBe('label_a · a-ann')
  })

  it('an override naming an ABSENT column is silently ignored — no row, no throw', async () => {
    const withoutOverride = await new WorkbenchDataSource(
      'p1',
      makeDeps({ nRows: 3, artifacts }),
    ).annotationsForAxis('demo/matrix', ROW_AXIS)
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts,
        // `metric_a` is exactly the shape the removed list used to promise. A LOOKUP can
        // name it without asserting it exists — so nothing appears.
        columnLabel: (_datatypeId, name) => (name === 'metric_a' ? 'Metric A' : undefined),
      }),
    )
    const annotations = await ds.annotationsForAxis('demo/matrix', ROW_AXIS)
    // non-vacuity first: there ARE columns, so "unchanged" is a real comparison.
    expect(withoutOverride).toHaveLength(3)
    expect(annotations.map(a => a.name)).toEqual(withoutOverride.map(a => a.name))
    expect(annotations.some(a => a.label === 'Metric A')).toBe(false)
  })

  it('the override is consulted with the SAME identifier the entry reports as its `column`', async () => {
    // Otherwise the override is unusable: an author cannot key a map on an identifier the
    // surface never shows them. This is the coherence the two halves of the override share.
    //
    // RE-EXPRESSED (DEFECT B, see this suite's header): the identifier is `column`, not
    // `name`. Keeping it on `name` is what made the override inert — that identifier
    // carries a server-minted artifact id. `a-metric` drops out of the consulted list here
    // because it is a whole-artifact column whose fixture declares no `meta.name`: there
    // is no name to key on, and consulting the lookup with its ID is the defect itself.
    const consulted: string[] = []
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts,
        columnLabel: (_datatypeId, name) => {
          consulted.push(name)
          return undefined
        },
      }),
    )
    const annotations = await ds.annotationsForAxis('demo/matrix', ROW_AXIS)
    expect(consulted).toEqual(['label_a', '0'])
    expect(consulted).toEqual(annotations.flatMap(a => (a.column === undefined ? [] : [a.column])))
    // …and the ADDRESSES are unchanged, so the value plane still resolves every column.
    expect(annotations.map(a => a.name)).toEqual(['a-ann#label_a', 'a-metric', 'a-expr#0'])
  })

  it('the DEFAULT (registry-backed) override reads the datatype`s own `labels` map', async () => {
    // The real wiring: `defaultDeps().columnLabel` → `datatypeRegistry.get(id).labels[name]`.
    // The key is derived from what the source itself reports (see the coherence case above)
    // rather than hardcoded, so this test does not bless any particular identifier shape.
    const bare = await new WorkbenchDataSource('p1', makeDeps({ nRows: 3, artifacts })).annotationsForAxis(
      'demo/labelled',
      ROW_AXIS,
    )
    // RE-KEYED (DEFECT B): `column`, the key the entry reports, not `name`, its address.
    const target = bare[0].column
    if (target === undefined) throw new Error('the first entry reports no lookup key')
    upsertDatatypes(
      demoDatatype('demo/labelled', {
        axes: [{ name: ROW_AXIS, key_label: 'entry_id' }],
        labels: { [target]: 'Renamed by the package', 'no-such-column': 'never rendered' },
      }),
    )
    const annotations = await new WorkbenchDataSource('p1', makeDeps({ nRows: 3, artifacts })).annotationsForAxis(
      'demo/labelled',
      ROW_AXIS,
    )
    expect(annotations[0].label).toBe('Renamed by the package')
    // the un-mentioned columns are untouched, and the absent key added nothing.
    expect(annotations.map(a => a.name)).toEqual(bare.map(a => a.name))
    expect(annotations.slice(1).map(a => a.label)).toEqual(bare.slice(1).map(a => a.label))
  })
})

// ─────────────────────────────── TEST-21 (ITEM-12) ───────────────────────────────
//
// `rowAxisFor` — WHAT IT ACTUALLY READS.
//
// ── WHAT THIS BLOCK USED TO ASSERT, AND WHY THAT WAS THE DEFECT ────────────────────
//
// It was titled "the datatype's FIRST declared axis" and its load-bearing case was
// literally `resolves the FIRST declared axis … not the catalog's order`: two datatypes
// over the same two labels differing ONLY in declaration ORDER, asserting the answer
// followed the order. That is a test CERTIFYING A BUG. `AxisSpec` says the core knows an
// axis has a name and a key label and never what it REPRESENTS, so position 0 was a
// semantic the contract disclaims — and it was already wrong on data in this tree (see
// `resolveEntityAxis`'s docstring for the three declared axis sets it mis-answered).
//
// The resolution is now the datatype's DECLARED `entity_axis`, read by NAME. The two
// fixtures below therefore declare their axes in the SAME order and differ only in which
// one they NAME, which is strictly stronger than the old shape: the old pair could still
// be explained by "the first declared axis", this pair cannot be explained by any
// position at all.
describe('WorkbenchDataSource.rowAxisFor — the datatype`s DECLARED entity axis (TEST-21, ITEM-12)', () => {
  const ROWS = { content_hash: 'h-rows', name: 'rows', length: 7 }
  const COLS = { content_hash: 'h-cols', name: 'cols', length: 5 }

  /** Two datatypes with IDENTICAL axis lists in IDENTICAL order, differing ONLY in the
   *  axis they NAME as their entity axis. Note `cols` is declared FIRST on both, so a
   *  positional resolver answers 5 for both and `PICKS_ROWS` fails. Both declare axis
   *  identity only (no `annotations`) — the entity axis is a datatype-level field. */
  const PICKS_ROWS = demoDatatype('demo/picks-rows', {
    capabilities: ['continuous-column'],
    axes: [
      { name: 'cols', key_label: 'col_id' },
      { name: 'rows', key_label: 'row_id' },
    ],
    entity_axis: 'rows',
  })
  const PICKS_COLS = demoDatatype('demo/picks-cols', {
    capabilities: ['continuous-column'],
    axes: [
      { name: 'cols', key_label: 'col_id' },
      { name: 'rows', key_label: 'row_id' },
    ],
    entity_axis: 'cols',
  })
  /** SEVERAL axes and NO declaration — the question this module refuses to answer. */
  const UNDECLARED = demoDatatype('demo/undeclared-entity', {
    capabilities: ['continuous-column'],
    axes: [
      { name: 'cols', key_label: 'col_id' },
      { name: 'rows', key_label: 'row_id' },
    ],
  })
  /** ONE axis — resolvable with nothing declared, because there is no choice to make. */
  const SOLE_AXIS = demoDatatype('demo/sole-axis', {
    capabilities: ['continuous-column'],
    axes: [{ name: 'rows', key_label: 'row_id' }],
  })
  /** A declaration naming an axis the datatype does not declare (a stale/typo'd
   *  manifest — the build gate refuses it, this is the runtime's own posture). */
  const NAMES_A_STRANGER = demoDatatype('demo/stranger-entity', {
    capabilities: ['continuous-column'],
    axes: [
      { name: 'cols', key_label: 'col_id' },
      { name: 'rows', key_label: 'row_id' },
    ],
    entity_axis: 'rowz',
  })
  const NO_AXES = demoDatatype('demo/no-axes', { capabilities: ['continuous-column'] })

  /** Deps that DO NOT override `rowAxisFor` (nor `hasCapability`) — so both run through
   *  `defaultDeps()` against the real `datatypeRegistry`, which is the path under test. */
  function realResolutionDeps(datatype: string, axes: AxisSummary[]): Partial<WorkbenchDataSourceDeps> {
    return {
      getCatalog: async () => ({ axes, artifacts: [art({ id: 'a1', datatype })] }),
      getArtifact: async id => art({ id, datatype }),
      fetchArtifactBytes: async () => new ArrayBuffer(0),
    }
  }

  it('every axis these datatypes declare carries identity only (name + key_label)', () => {
    for (const dt of [PICKS_ROWS, PICKS_COLS]) {
      for (const axis of dt.axes ?? []) expect(Object.keys(axis).sort()).toEqual(['key_label', 'name'])
    }
  })

  it('resolves the DECLARED entity axis — which no position, in either list, predicts', async () => {
    upsertDatatypes(PICKS_ROWS, PICKS_COLS)
    // ONE catalog for both cases, whose first axis is `cols` (length 5). Both datatypes
    // also declare `cols` FIRST. So every position available to a positional resolver —
    // the catalog's and the datatype's — points at 5.
    const axes = [COLS, ROWS]
    const picksRows = await new WorkbenchDataSource('p1', realResolutionDeps(PICKS_ROWS.id, axes)).catalog()
    const picksCols = await new WorkbenchDataSource('p1', realResolutionDeps(PICKS_COLS.id, axes)).catalog()
    // 7 is reachable ONLY by reading the NAME `entity_axis` carries.
    expect(picksRows.pointCount).toBe(7)
    // …and the same rule, pointed at the other axis, still answers 5 — so the test is not
    // passing merely because "not-first" happens to be right.
    expect(picksCols.pointCount).toBe(5)
  })

  it('a datatype with SEVERAL axes and no `entity_axis` resolves to nothing, and says so', async () => {
    upsertDatatypes(UNDECLARED)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The catalog's first axis is `cols` (5). With no declaration the resolution is
      // silent, so the caller's documented positional last resort supplies 5 — the SAME
      // number a positional resolver would have produced, which is exactly why the
      // warning is the load-bearing half of this case.
      const cat = await new WorkbenchDataSource('p1', realResolutionDeps(UNDECLARED.id, [COLS, ROWS])).catalog()
      expect(cat.pointCount).toBe(5)
      expect(warn.mock.calls.some(c => String(c[0]).includes(UNDECLARED.id))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('a datatype declaring exactly ONE axis resolves it with nothing declared', async () => {
    upsertDatatypes(SOLE_AXIS)
    // `rows` is SECOND in the catalog, so 7 cannot come from the catalog's order; the
    // datatype names one axis and it is the only answer there is.
    const cat = await new WorkbenchDataSource('p1', realResolutionDeps(SOLE_AXIS.id, [COLS, ROWS])).catalog()
    expect(cat.pointCount).toBe(7)
  })

  it('an `entity_axis` naming an axis the datatype does NOT declare resolves to nothing', async () => {
    upsertDatatypes(NAMES_A_STRANGER)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // It must NOT silently fall back to a position, and it must not resolve the
      // near-miss label either: `rowz` is not `rows`, and guessing is the defect.
      const cat = await new WorkbenchDataSource('p1', realResolutionDeps(NAMES_A_STRANGER.id, [COLS, ROWS])).catalog()
      expect(cat.pointCount).toBe(5) // the catalog's positional last resort, not `rows`
      expect(warn.mock.calls.some(c => String(c[0]).includes(NAMES_A_STRANGER.id))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  it('a datatype declaring NO axes resolves to nothing — the caller falls back positionally', async () => {
    upsertDatatypes(NO_AXES)
    // A catalog axis no datatype names, so a positional fallback is the ONLY way to 11.
    const cat = await new WorkbenchDataSource(
      'p1',
      realResolutionDeps(NO_AXES.id, [{ content_hash: 'h-unlisted', name: 'unlisted', length: 11 }]),
    ).catalog()
    expect(cat.pointCount).toBe(11)
  })

  it('an UNREGISTERED datatype resolves to nothing rather than throwing (a fresh registry)', async () => {
    const cat = await new WorkbenchDataSource(
      'p1',
      // `hasCapability` is the real registry lookup too, so an unknown datatype supplies no
      // channels at all; the point is that the resolution is silent, not fatal.
      realResolutionDeps('demo/never-registered', [ROWS]),
    ).catalog()
    expect(cat.pointCount).toBe(7)
  })
})

// ───────────────── DEFECT A — `annotationsForAxis(_, axis)` IGNORED its `axis` ─────────────────
//
// The method took an `axis` argument and never read it: every catalog column of the
// project came back for every axis. Its own docstring promised the opposite ("a
// `<x>`-axis query returns ONLY that axis's annotations"), and on a real two-axis import
// the two sets are DISJOINT — one axis's criteria picker offered the other axis's
// columns, which cannot be evaluated against its entries at all.
//
// The axis is a PRODUCER DECLARATION, read off `structure` (never inferred):
//   `table`      → the SINGULAR `axis`. A table's members share ONE axis by construction
//                  (`cyto_zarr.Table(root, axis=…)` writes the group's `axis` and each
//                  member entry's from the same `self.axis`).
//   `sparse_csc` → `axes[0]`, the ROW axis (`cyto_csc.write_csc_zarr(axes=(row, col))`).
//                  A value column is ONE column's values across the ROW entries — column
//                  `j`'s non-zeros are ROW indices spanned by `indptr` — so an `(A, B)`
//                  matrix serves value columns on A. `axes[1]` names the set the columns
//                  are drawn FROM, not the set they are dense OVER; it is also the axis
//                  `valueColumn()` already densifies against.
//   `opaque`     → nothing at all (bytes + a media type declare no structure).
describe('WorkbenchDataSource.annotationsForAxis — scoped to the REQUESTED axis', () => {
  const A_AXIS = 'alpha'
  const B_AXIS = 'beta'

  /** A one-member categorical table declaring `axis`. */
  const tableOn = (id: string, axis: string, path: string): DataPlaneArtifact =>
    art({
      id,
      datatype: 'demo/grouping',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis,
        n: 3,
        columns: [{ path, kind: 'categorical', levels: ['lo', 'hi'] }],
      },
    })

  /** A continuous (numeric) column artifact declaring `axis`. */
  const metricOn = (id: string, axis: string): DataPlaneArtifact =>
    art({
      id,
      datatype: 'demo/column',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis,
        n: 3,
        columns: [{ path: 'values', kind: 'numeric' }],
      },
    })

  /** A CSC matrix over `(rowAxis, colAxis)` — two value columns, dense over `rowAxis`. */
  const matrixOver = (id: string, rowAxis: string, colAxis: string): DataPlaneArtifact =>
    art({
      id,
      datatype: 'fixture-matrix',
      structure: {
        encoding: 'zarr_v3',
        kind: 'sparse_csc',
        axes: [rowAxis, colAxis],
        shape: [3, 2],
        indptr: { path: 'indptr' },
        indices: { path: 'indices' },
        data: { path: 'data' },
      } as never,
    })

  /** Four artifacts across TWO declared axes, every one of them declaring its axis. */
  const DECLARED: DataPlaneArtifact[] = [
    tableOn('tbl-a', A_AXIS, 'grade'),
    tableOn('tbl-b', B_AXIS, 'symbol'),
    metricOn('metric-b', B_AXIS),
    matrixOver('mat', A_AXIS, B_AXIS),
  ]

  const forAxis = (artifacts: DataPlaneArtifact[], axis: string) =>
    new WorkbenchDataSource('p-axis', makeDeps({ nRows: 3, artifacts })).annotationsForAxis(
      'demo/matrix',
      axis,
    )

  it('returns ONE entry per column present on THAT axis — never another axis`s', async () => {
    // A carries: the `tbl-a` member + BOTH value columns of the matrix whose ROW axis it is.
    expect(await forAxis(DECLARED, A_AXIS).then(as => as.map(a => [a.name, a.type]))).toEqual([
      ['tbl-a#grade', 'categorical'],
      ['mat#0', 'value'],
      ['mat#1', 'value'],
    ])
    // B carries: the `tbl-b` member + the metric artifact. NOT the matrix's value columns —
    // B is the set those columns are drawn FROM, not the set they are dense OVER.
    expect(await forAxis(DECLARED, B_AXIS).then(as => as.map(a => [a.name, a.type]))).toEqual([
      ['tbl-b#symbol', 'categorical'],
      ['metric-b', 'continuous'],
    ])
  })

  it('the two axes PARTITION the project`s columns — nothing lost, nothing duplicated', async () => {
    // Anti-vacuity for the case above from the other side: "return fewer things" is not the
    // claim. Every column the catalog stamps appears on EXACTLY ONE of the two axes.
    const onA = (await forAxis(DECLARED, A_AXIS)).map(a => a.name)
    const onB = (await forAxis(DECLARED, B_AXIS)).map(a => a.name)
    expect([...onA, ...onB].sort()).toEqual(
      ['mat#0', 'mat#1', 'metric-b', 'tbl-a#grade', 'tbl-b#symbol'].sort(),
    )
    expect(onA.filter(n => onB.includes(n))).toEqual([])
  })

  it('an axis NO artifact declares yields NO columns (not the whole project)', async () => {
    expect(await forAxis(DECLARED, 'gamma')).toEqual([])
  })

  it('a value column follows the matrix`s ROW axis — swap the declaration and it swaps', async () => {
    // The `axes[0]`-vs-`axes[1]` claim, isolated: the SAME matrix declared the other way
    // round serves its value columns on the other axis. Nothing but the declaration moved.
    const flipped = [matrixOver('mat', B_AXIS, A_AXIS)]
    expect((await forAxis(flipped, B_AXIS)).map(a => a.name)).toEqual(['mat#0', 'mat#1'])
    expect(await forAxis(flipped, A_AXIS)).toEqual([])
  })

  // ── the UNDECLARED case: reported everywhere, and SAID ────────────────────────────────
  //
  // An artifact whose declaration names no axis it can read (an `opaque` blob, a table
  // that omitted `axis`, a declaration that will not parse) has said NOTHING about where
  // its column belongs. Dropping it would make a real, readable column vanish from every
  // axis with no way to reach it — the silent-empty failure this module refuses elsewhere
  // (INV-2: absence is not a zero). So it is reported on EVERY axis, which is the widest
  // honest answer — and warned, because unlike `resolveRowAxis`'s positional last resort
  // (one axis, chosen by position) this fallback puts the column on axes it may not belong
  // to, and a listing that MAY pollute has to be recoverable.
  const UNDECLARED: DataPlaneArtifact[] = [
    ...DECLARED,
    art({ id: 'blob', datatype: 'demo/column', structure: { encoding: 'opaque' } }),
    art({
      id: 'axis-less',
      datatype: 'demo/grouping',
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        n: 3,
        columns: [{ path: 'note', kind: 'string' }],
      },
    }),
  ]

  it('an artifact declaring NO axis is reported on every axis rather than vanishing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const onA = (await forAxis(UNDECLARED, A_AXIS)).map(a => a.name)
      const onB = (await forAxis(UNDECLARED, B_AXIS)).map(a => a.name)
      for (const name of ['blob', 'axis-less#note']) {
        expect(onA, `${name} must not vanish from A`).toContain(name)
        expect(onB, `${name} must not vanish from B`).toContain(name)
      }
      // …and it does NOT drag the axis-declaring artifacts along with it.
      expect(onA).not.toContain('tbl-b#symbol')
      expect(onB).not.toContain('tbl-a#grade')
    } finally {
      warn.mockRestore()
    }
  })

  it('…and the REASON is recoverable — it names the artifact and the requested axis', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await forAxis(UNDECLARED, A_AXIS)
      expect(warn).toHaveBeenCalled()
      const said = warn.mock.calls.map(c => c.map(String).join(' ')).join('\n')
      expect(said).toMatch(/declares no axis/i)
      expect(said).toMatch(/blob/)
      expect(said).toMatch(/axis-less/)
      expect(said).toMatch(new RegExp(A_AXIS))
    } finally {
      warn.mockRestore()
    }
  })

  it('[control] a project whose artifacts all declare an axis warns about nothing', async () => {
    // Without this, "it warns" above is satisfied by a build that warns unconditionally.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await forAxis(DECLARED, A_AXIS)).toHaveLength(3)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// ───────────── DEFECT B — the label override was keyed by the channel ADDRESS ─────────────
//
// `columnLabel` was consulted with the catalog's channel id: `<artifactId>#<member>` for a
// categorical column and the BARE ARTIFACT ID for a continuous one. Artifact ids are
// server-minted UUIDs, so the shape DEC-4 documents on `Datatype.labels` —
// `{ metric_a: "Metric A" }` — could never match anything, and the override was inert
// for precisely the case it was designed for (a per-column analysis metric is exactly a
// whole-artifact continuous column).
//
// The key is now the column's OWN NAME, and the entry REPORTS it as `column` so an author
// can read the key off the same surface that renders the label:
//   member column      → the member path / column index (the half after the last `#`)
//   whole-artifact col → the producer's declared `meta.name` (its column writer's second half)
//   neither            → `undefined`; the lookup is SKIPPED rather than consulted with an
//                        address, which is the defect itself.
// `name` is untouched: it stays the composite address the value plane resolves from.
describe('WorkbenchDataSource.annotationsForAxis — the label override is keyed by the COLUMN NAME (DEC-4)', () => {
  /** A server-minted id: the shape that makes the old key uncomputable by an author. */
  const MINTED = '7f3c1a92-0b1e-4a77-9d2f-5c8e1b0a4d63'

  /** A whole-artifact continuous column whose producer DECLARED its name in `meta`
   *  (`cyto_columns`' column writer returns exactly this pair). */
  const metric = art({
    id: MINTED,
    datatype: 'demo/column',
    meta: { name: 'metric_a', kind: 'continuous', axis: ROW_AXIS, n: 3 },
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ROW_AXIS,
      n: 3,
      columns: [{ path: 'values', kind: 'numeric' }],
    },
  })
  /** A two-member table: the member PATH is the column's name. */
  const table = art({
    id: 'tbl',
    datatype: 'demo/grouping',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ROW_AXIS,
      n: 3,
      columns: [
        { path: 'grade', kind: 'categorical', levels: ['lo', 'hi'] },
        { path: 'batch', kind: 'categorical', levels: ['b1', 'b2'] },
      ],
    },
  })
  /** A whole-artifact continuous column whose producer declared NO name. */
  const nameless = art({ id: 'nameless', datatype: 'demo/column', structure: { encoding: 'opaque' } })

  const ARTIFACTS = [table, metric, nameless]

  it('the DOCUMENTED shape hits: `{ metric_a: … }` renames a whole-artifact metric column', async () => {
    // The flagship DEC-4 case, verbatim. Under the old key the lookup was handed
    // `7f3c1a92-…`, so no author-written map could ever match it.
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts: ARTIFACTS,
        columnLabel: (_datatypeId, name) => (name === 'metric_a' ? 'Metric A' : undefined),
      }),
    )
    const annotations = await ds.annotationsForAxis('demo/matrix', ROW_AXIS)
    const renamed = annotations.find(a => a.name === MINTED)
    expect(renamed?.label).toBe('Metric A')
    // …and `name` is UNCHANGED — the value plane still resolves the column by it.
    expect(renamed?.name).toBe(MINTED)
  })

  it('a member column is keyed by its member PATH, not by `<artifactId>#<path>`', async () => {
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts: ARTIFACTS,
        columnLabel: (_datatypeId, name) => (name === 'grade' ? 'Grade' : undefined),
      }),
    )
    const annotations = await ds.annotationsForAxis('demo/matrix', ROW_AXIS)
    expect(annotations.find(a => a.name === 'tbl#grade')?.label).toBe('Grade')
    // the sibling member is untouched: a lookup renames one column, not a whole artifact.
    expect(annotations.find(a => a.name === 'tbl#batch')?.label).toBe('batch · tbl')
  })

  it('the entry REPORTS the key as `column`, and the override is consulted with exactly that', async () => {
    // The re-expressed coherence property (see this file's DEFECT B note): the key can no
    // longer be `name`, so it has to be readable off the entry — otherwise it is a second
    // uncomputable key, which is the bug being fixed rather than a fix for it.
    const consulted: string[] = []
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts: ARTIFACTS,
        columnLabel: (_datatypeId, name) => {
          consulted.push(name)
          return undefined
        },
      }),
    )
    const annotations = await ds.annotationsForAxis('demo/matrix', ROW_AXIS)
    expect(annotations.map(a => a.column)).toEqual(['grade', 'batch', 'metric_a', undefined])
    expect(consulted).toEqual(annotations.flatMap(a => (a.column === undefined ? [] : [a.column])))
    // `name` stays the ADDRESS the value plane resolves — the two are deliberately different.
    expect(annotations.map(a => a.name)).toEqual(['tbl#grade', 'tbl#batch', MINTED, 'nameless'])
  })

  it('a column with NO derivable name is never consulted with its id (no UUID key)', async () => {
    const consulted: string[] = []
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: 3,
        artifacts: ARTIFACTS,
        columnLabel: (_datatypeId, name) => {
          consulted.push(name)
          return undefined
        },
      }),
    )
    const annotations = await ds.annotationsForAxis('demo/matrix', ROW_AXIS)
    expect(consulted).not.toContain('nameless')
    expect(consulted).not.toContain(MINTED)
    // it still RENDERS — the missing key costs the override, never the column.
    expect(annotations.find(a => a.name === 'nameless')?.label).toBe('demo/column · nameless')
  })

  it('the DEFAULT (registry-backed) override resolves the DOCUMENTED `labels` map', async () => {
    // End to end through the REAL wiring — `defaultDeps().columnLabel` →
    // `datatypeRegistry.get(id).labels[name]` — with the map written exactly as the
    // `Datatype.labels` doc comment shows it. This is the assertion that fails if the doc
    // and the code disagree about the key.
    upsertDatatypes(
      demoDatatype('demo/doc-example', {
        axes: [{ name: ROW_AXIS, key_label: 'entry_id' }],
        labels: { metric_a: 'Metric A', grade: 'Grade' },
      }),
    )
    const annotations = await new WorkbenchDataSource(
      'p1',
      makeDeps({ nRows: 3, artifacts: ARTIFACTS }),
    ).annotationsForAxis('demo/doc-example', ROW_AXIS)
    expect(annotations.find(a => a.name === MINTED)?.label).toBe('Metric A')
    expect(annotations.find(a => a.name === 'tbl#grade')?.label).toBe('Grade')
    // …and an un-mentioned column keeps its fallback (a lookup, never a schema claim).
    expect(annotations.find(a => a.name === 'tbl#batch')?.label).toBe('batch · tbl')
  })
})

// ── TEST-14 / TEST-15 (ITEM-13) — a layout served as its two DECLARED component columns ──
//
// D20 / INV-26 says positions are TWO NUMERIC COLUMNS, not one `n×2` member, and the client
// half of that has shipped since ITEM-12: `CatalogEntry.components` names the two keys and
// `libs/viz/src/viz-core/data/streamingAdapter.ts:53-93` streams each through the continuous
// channel and interleaves them. Nothing in production ever SET the field — both producers of
// `layouts[]` omitted it — so it was the one un-built row of D20's own change table.
//
// It is needed because `structure` does not survive a narrowing: materialising a narrowed row
// set re-mints every gathered artifact's declaration as a single 1-D `values` column
// (`server/src/modules/workstore/virtual_dataset.rs:1688-1705` → `gathered_structure`) while
// copying `meta` VERBATIM (`:1714`). The layout arrives with no 2-D member to serve, so the
// interleaved-`positions` channel has nothing to read; the producer's `meta.component_columns`
// is what is left, and it names two 1-D siblings that gathered perfectly well.
//
// Every fixture below is a controlled pair: the same artifacts, differing only in the one
// input the case is about (the declaration, the sibling count, the dataset scope, the
// structure's own width). The vocabulary is generic — this module knows no domain (DEC-7).
describe('WorkbenchDataSource.catalog — component columns (TEST-14 / TEST-15)', () => {
  const N_KEPT = 4
  const DS_A = 'ds-alpha'
  const DS_B = 'ds-beta'

  /** A layout exactly as the gather mints one: ONE `values` column of `shape: [n_kept]`, an
   *  empty `arrays`, and the source's `meta` + `datatype` carried through verbatim. */
  const gatheredLayout = (over: Partial<DataPlaneArtifact> = {}): DataPlaneArtifact =>
    art({
      id: 'lay',
      datatype: 'demo/layout',
      dataset_id: DS_A,
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: ROW_AXIS,
        n: N_KEPT,
        columns: [
          {
            path: 'values',
            name: 'values',
            kind: 'numeric',
            dtype: 'float32',
            shape: [N_KEPT],
            axis: ROW_AXIS,
            n: N_KEPT,
          },
        ],
        arrays: [],
        data_type: 'float32',
        gathered_from: { artifact_id: 'source-1', mask_len: 9 },
      },
      meta: { component_columns: ['c_one', 'c_two'] },
      ...over,
    })

  /** A 1-D sibling column, as the whole-artifact column writer emits one: the constant member
   *  path `values`, with the column's real name ONLY in `meta.name` — which is why the join
   *  is on that field and not on anything in `structure`. */
  const column = (id: string, name: string, dataset = DS_A): DataPlaneArtifact =>
    art({
      id,
      datatype: 'demo/column',
      dataset_id: dataset,
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: ROW_AXIS,
        n: N_KEPT,
        columns: [{ path: 'values', kind: 'numeric', dtype: 'float32', shape: [N_KEPT], n: N_KEPT }],
      },
      meta: { name },
    })

  const catalogOver = (artifacts: DataPlaneArtifact[]) =>
    new WorkbenchDataSource('p1', makeDeps({ nRows: N_KEPT, artifacts })).catalog()

  /** The fixture layout's catalog entry, resolved BY ID rather than by position — and
   *  REFUSING when it is absent, so a `components` assertion below can never pass because the
   *  layout fell out of the catalog entirely. */
  const layoutEntry = (cat: Awaited<ReturnType<WorkbenchDataSource['catalog']>>) => {
    const entry = cat.layouts.find(l => l.id === 'lay')
    if (!entry) throw new Error('the fixture layout is not in the catalog at all')
    return entry
  }

  it('resolves each declared name to its sibling and sets `components: [xId, yId]`', async () => {
    const arts = [gatheredLayout(), column('col-x', 'c_one'), column('col-y', 'c_two')]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await catalogOver(arts)
      expect(cat.layouts.map(l => l.id)).toEqual(['lay'])
      // ORDER is the declaration's, not the catalog's: `components[0]` is the first declared
      // name. Reversing them transposes every point, which renders and is wrong.
      expect(layoutEntry(cat).components).toEqual(['col-x', 'col-y'])
      // A well-formed resolution says nothing — without this the diagnostics below would be
      // satisfied by a build that warns always.
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('the ids it emits are KEYS THE CONTINUOUS CHANNEL ACCEPTS, not some other address', async () => {
    // The adapter reads each component with `stream({kind:'continuous', key})`, so a key the
    // continuous channel cannot resolve is a catalog that type-checks and cannot be drawn.
    // Asserted twice over: the keys are the ones `continuousColumns` itself mints, and a real
    // `continuous()` read of one returns that column's bytes.
    const arts = [gatheredLayout(), column('col-x', 'c_one'), column('col-y', 'c_two')]
    const ds = new WorkbenchDataSource(
      'p1',
      makeDeps({
        nRows: N_KEPT,
        artifacts: arts,
        readNumeric: async id => new Float32Array(id === 'col-x' ? [1, 2, 3, 4] : [5, 6, 7, 8]),
      }),
    )
    const cat = await ds.catalog()
    const components = layoutEntry(cat).components ?? []
    expect(components).toEqual(cat.continuousColumns.map(c => c.id))
    expect(Array.from((await ds.continuous(components[0])).value)).toEqual([1, 2, 3, 4])
  })

  it('FAILS CLOSED when a declared name resolves to NOTHING — no components, one diagnostic', async () => {
    // The layout stays on the interleaved-`positions` path, which has no 2-D member and so
    // fails VISIBLY. That is the trade: a missing picture over a confident wrong one.
    const arts = [gatheredLayout(), column('col-x', 'c_one')]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await catalogOver(arts)
      expect(layoutEntry(cat).components).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      const said = warn.mock.calls.map(c => c.join(' ')).join('\n')
      // The artifact, the unresolved column and the count — the three facts somebody needs to
      // fix it. A refusal nobody can trace is the silent-empty failure in a new costume.
      expect(said).toMatch(/lay/)
      expect(said).toMatch(/c_two/)
      expect(said).toMatch(/0/)
    } finally {
      warn.mockRestore()
    }
  })

  it('FAILS CLOSED when a declared name resolves to TWO siblings — never the first match', async () => {
    // `artifactReader.ts:429-431` states the rule: "the first one is a guess, and a
    // silently-wrong column is worse than an error". Both candidates are legitimate columns
    // of the right kind on the right dataset; nothing distinguishes them but arrival order.
    const arts = [
      gatheredLayout(),
      column('col-x', 'c_one'),
      column('col-y', 'c_two'),
      column('col-y-again', 'c_two'),
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await catalogOver(arts)
      expect(layoutEntry(cat).components).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      const said = warn.mock.calls.map(c => c.join(' ')).join('\n')
      expect(said).toMatch(/c_two/)
      expect(said).toMatch(/2/)
    } finally {
      warn.mockRestore()
    }
  })

  it('the join is SCOPED to the layout’s OWN dataset (DEC-8)', async () => {
    // Same names, same capability, other dataset — and therefore a different set of entries.
    // Reaching across would resolve to a column of the right NAME over the wrong rows, which
    // is a plotted picture of somebody else's data. The scope is the artifact's own
    // `dataset_id`, which a narrowing stamps on every row it gathers
    // (`virtual_dataset.rs:1725`) — so this is also what tells one narrowing of a dataset
    // from another narrowing of the same one, which a shared LINEAGE cannot.
    const arts = [gatheredLayout(), column('col-x', 'c_one'), column('col-y', 'c_two', DS_B)]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(layoutEntry(await catalogOver(arts)).components).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('a candidate must carry the CONTINUOUS-COLUMN capability, not merely the right name', async () => {
    // The channel the adapter reads these through is the continuous one (DEC-7 — the app
    // dispatches on declared capabilities, never on a datatype id).
    const wrongKind = art({
      id: 'col-y',
      datatype: 'demo/grouping',
      dataset_id: DS_A,
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: ROW_AXIS,
        n: N_KEPT,
        columns: [{ path: 'values', kind: 'categorical', levels: ['a', 'b'], n: N_KEPT }],
      },
      meta: { name: 'c_two' },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await catalogOver([gatheredLayout(), column('col-x', 'c_one'), wrongKind])
      expect(layoutEntry(cat).components).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it.each([
    ['no declaration at all', undefined],
    ['only ONE name', { component_columns: ['c_one'] }],
    ['a REPEATED name — two components, one column, a diagonal', { component_columns: ['c_one', 'c_one'] }],
    ['a non-string entry', { component_columns: ['c_one', 7] }],
    ['not a list at all', { component_columns: 'c_one,c_two' }],
  ])('sets nothing, SILENTLY, for a layout that declares %s', async (_label, meta) => {
    // A malformed or absent declaration is not an unresolved JOIN: there is no name to look
    // up, so there is nothing to report and the layout is simply the ordinary interleaved kind
    // it has always been. Warning here would put a line in the console for every layout in
    // every project that predates this field.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const arts = [
        gatheredLayout(meta === undefined ? { meta: undefined } : { meta }),
        column('col-x', 'c_one'),
        column('col-y', 'c_two'),
      ]
      expect(layoutEntry(await catalogOver(arts)).components).toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  // ── TEST-15 — the change is INERT on everything shipped today ────────────────────────────
  //
  // Every layout in every project today is one 2-D member written by the shared writer. Its
  // structure states its own width, the interleaved-`positions` channel serves it, and this
  // whole mechanism must not touch it — including when a producer declares component columns
  // anyway. Structure wins wherever it speaks, on both halves of the settlement.
  it('an UNFILTERED layout answers 2 from its STRUCTURE and gets NO components', async () => {
    const unfiltered = art({
      id: 'lay',
      datatype: 'demo/layout',
      dataset_id: DS_A,
      structure: {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: ROW_AXIS,
        n: N_KEPT,
        columns: [],
        arrays: [{ path: 'coordinates', kind: 'numeric', dtype: 'float32', shape: [N_KEPT, 2], n: N_KEPT }],
      },
      // The declaration is PRESENT and the siblings resolve — so this case is decided by the
      // structure and by nothing else.
      meta: { component_columns: ['c_one', 'c_two'] },
    })
    // The structure's own answer, through the one reader every surface uses for it.
    expect(declaredDims(parseStructure(unfiltered.id, unfiltered.structure), unfiltered.id)).toEqual([N_KEPT, 2])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await catalogOver([unfiltered, column('col-x', 'c_one'), column('col-y', 'c_two')])
      expect(cat.layouts.map(l => l.id)).toEqual(['lay'])
      expect(layoutEntry(cat).components).toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('a layout with NO dataset resolves nothing — an unknown scope is not a wildcard', async () => {
    // Reaching project-wide from a row whose dataset is unknown is how a picker silently
    // offers another dataset's columns. The siblings here are perfectly resolvable BY NAME —
    // only the scope is missing — so this case is decided by the scope and nothing else, and
    // the refusal is SAID (a layout that declared components and then got none is a fact
    // somebody has to be able to trace).
    const orphan = gatheredLayout({ dataset_id: null })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await catalogOver([orphan, column('col-x', 'c_one'), column('col-y', 'c_two')])
      expect(layoutEntry(cat).components).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('a candidate with NO dataset is not a sibling of a dataset-less layout either', async () => {
    // The other half of "an unknown scope is not a wildcard", and the one a `===` on two
    // optional fields gets wrong for free: `undefined === undefined` would pair a
    // dataset-less layout with every dataset-less artifact in the project. Both sides here
    // carry nothing, and nothing is what resolves.
    const orphanLayout = gatheredLayout({ dataset_id: null })
    const orphanColumns = [
      art({ ...column('col-x', 'c_one'), dataset_id: null }),
      art({ ...column('col-y', 'c_two'), dataset_id: null }),
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cat = await catalogOver([orphanLayout, ...orphanColumns])
      expect(layoutEntry(cat).components).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })
})
