// artifactReader.test.ts — the ARTIFACT-level read layer (artifact-model ITEM-25).
//
// `zarrReader.test.ts` proves one array decodes byte-identically to what the Python
// writer wrote. This proves the layer above it: given an artifact's producer-declared
// `structure`, the right members are opened, decoded per their DECLARED kind, and
// assembled into the shapes the viz/workbench consumers read.
//
// TWO fixture sources, both real:
//   * `__fixtures__/zarr/{table,csc}` — written by `src-app/packages/_lib`'s
//     `cyto_zarr.py` / `cyto_csc.py` (cross-language byte parity; the generator IMPORTS
//     the shipping writers).
//   * hand-laid raw Zarr bytes for the ONE shape the Python writer does not emit — an
//     uncompressed, unsharded column. Laid out here, and said so.
//
// The CSC fixture is here because of what its absence cost. This suite used to drive the
// sparse path with a hand-written `raw_csc_trio` declaration that NO producer emitted, on
// this branch or before it — so the reader and the writer spoke different vocabularies and
// every test passed. A fixture the thing under test also gets to define proves only
// self-consistency; these bytes come from the writer that will produce them in production.
//
// The transport is a `memoryStore` / a stubbed `fetch`, never a mocked decoder: every
// assertion below runs the SHIPPED decode path over real bytes.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  UnsupportedArtifactStructure,
  __resetArtifactArrayCache,
  declaredDims,
  declaredDimsForDisplay,
  openStringColumn,
  parseStructure,
  readCategoricalColumn,
  readDeclaredLevels,
  readNumericColumn,
  readPositions,
  readSparseColumn,
  readTable,
  readColumnarTable,
  readMemberIndex,
  resolveMember,
  tableMembers,
} from './artifactReader'
import { memoryStore } from './zarrReader'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__', 'zarr')

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

/** The Python-written table artifact + the `structure` its writer stamped into the
 *  group's `zarr.json` — the SAME document `close()` returns into the artifact row. */
const TABLE_TREE = loadTree(join(FIXTURES, 'table'))

/** The declaration the writer STAMPED into a fixture's group `zarr.json` — the same
 *  document `close()` returned into the artifact row. Reading it from the store is what
 *  makes these tests use the producer's vocabulary instead of one restated here. */
function stampedStructure(id: string, tree: Map<string, Uint8Array>) {
  return parseStructure(
    id,
    (JSON.parse(new TextDecoder().decode(tree.get('zarr.json')!)) as {
      attributes: { cyto: unknown }
    }).attributes.cyto,
  )
}

const TABLE_STRUCTURE = stampedStructure('table', TABLE_TREE)
const tableStore = () => memoryStore(TABLE_TREE)

/** The oracle the GENERATOR computed from its numpy inputs — never from the reader. */
const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  csc: {
    structure: Record<string, unknown>
    shape: [number, number]
    nnz: number
    innerChunk: number
    indptr: number[]
    columns: {
      col: number
      n: number
      rowFirst: number | null
      rowLast: number | null
      valueFirst: number | null
      valueLast: number | null
      rowSum: number
      valueSum: number
    }[]
    emptyColumn: number
    fullColumn: { col: number; row: number[]; value: number[] }
  }
}

/** A RAW (uncompressed, unsharded) Zarr column. Hand-laid — the writer never emits an
 *  empty codec chain — so the reader's stored-raw path is exercised rather than assumed. */
function rawColumn(name: string, dtype: 'float64' | 'uint8', values: number[]): Record<string, Uint8Array> {
  const buf = dtype === 'float64' ? Float64Array.from(values).buffer : Uint8Array.from(values).buffer
  return {
    [`${name}/zarr.json`]: new TextEncoder().encode(
      JSON.stringify({
        zarr_format: 3,
        node_type: 'array',
        shape: [values.length],
        data_type: dtype,
        chunk_grid: { name: 'regular', configuration: { chunk_shape: [values.length] } },
        chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
        fill_value: 0,
        codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
        attributes: {},
      }),
    ),
    [`${name}/c/0`]: new Uint8Array(buf),
  }
}

/** A RAW (uncompressed, unsharded) row-major `rows × dims` member — `rawColumn`'s 2-D
 *  sibling. `readPositions` dispatches on `dims` (= `shape[1]`) and on the element WIDTH,
 *  and the two arms it picks between are decided by facts only a 2-D member carries, so
 *  neither is reachable through a 1-D column. `values` is flat row-major, exactly as the
 *  bytes are laid out. */
function rawMatrix(
  name: string,
  dtype: 'float32' | 'float64',
  rows: number,
  dims: number,
  values: number[],
): Record<string, Uint8Array> {
  if (values.length !== rows * dims) throw new Error(`rawMatrix: ${values.length} ≠ ${rows}×${dims}`)
  const buf =
    dtype === 'float32' ? Float32Array.from(values).buffer : Float64Array.from(values).buffer
  return {
    [`${name}/zarr.json`]: new TextEncoder().encode(
      JSON.stringify({
        zarr_format: 3,
        node_type: 'array',
        shape: [rows, dims],
        data_type: dtype,
        chunk_grid: { name: 'regular', configuration: { chunk_shape: [rows, dims] } },
        chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
        fill_value: 0,
        codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
        attributes: {},
      }),
    ),
    [`${name}/c/0/0`]: new Uint8Array(buf),
  }
}

// ── the declaration is the dispatch (INV-2) ─────────────────────────────────────

describe('parseStructure — absence and novelty are ERRORS, never defaults', () => {
  it('accepts each implemented encoding', () => {
    expect(parseStructure('a', { encoding: 'opaque' }).encoding).toBe('opaque')
    for (const kind of ['table', 'sparse_csc']) {
      expect(parseStructure('a', { encoding: 'zarr_v3', kind }).encoding).toBe('zarr_v3')
    }
  })

  it('REFUSES a zarr_v3 artifact that names no kind, or an unimplemented one', () => {
    // Both Zarr artifacts share one encoding, so the kind is the dispatch. Accepting an
    // absent kind is what let a CSC matrix be read as a table with zero columns.
    expect(() => parseStructure('a', { encoding: 'zarr_v3' })).toThrow(/declares kind undefined/)
    expect(() => parseStructure('a', { encoding: 'zarr_v3', kind: 'raw_csc_trio' })).toThrow(
      /declares kind "raw_csc_trio" — this reader implements table \/ sparse_csc/,
    )
  })

  it('accepts the SERVER-AUTHORED `{kind:"opaque"}` alias, and normalizes it', () => {
    // The live cross-slice drift `parseStructure` reconciles: server-authored rows spell
    // opaque with `kind`, producers with `encoding`. Normalized so no consumer downstream
    // ever has to know there were two.
    expect(parseStructure('a', { kind: 'opaque' }).encoding).toBe('opaque')
  })

  it('does NOT generalize the alias to a real encoding', () => {
    // The alias must not become a second way to declare something decodable — that would
    // turn a temporary reconciliation into a permanent fork of the vocabulary.
    expect(() => parseStructure('a', { kind: 'zarr_v3' })).toThrow(/declares no `encoding`/)
    expect(() => parseStructure('a', { kind: 'table' })).toThrow(/declares no `encoding`/)
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an array', []],
    ['a string', 'zarr_v3'],
    ['an object whose only key is an unrelated `kind`', { kind: 'table' }],
    ['an unimplemented encoding', { encoding: 'parquet' }],
  ])('rejects %s', (_label, declared) => {
    expect(() => parseStructure('art-1', declared)).toThrow(UnsupportedArtifactStructure)
    // The message names the ARTIFACT and what was declared — a reader that cannot say
    // which artifact confused it is not debuggable from a console line.
    expect(() => parseStructure('art-1', declared)).toThrow(/art-1/)
  })
})

describe('declaredDims — a malformed shape is REFUSED, never compacted', () => {
  // r20: `declaredDims` used to `filter()` the non-numbers out of a declared shape. That
  // is "omission" for the entry that vanished and a WRONG ANSWER for every entry after
  // it, because both consumers key strictly by POSITION (`declaredDims(...)[1]` is the
  // sparse column count; `runDiff` labels `dim${i}`).
  const csc = (shape: unknown) => ({ encoding: 'zarr_v3', kind: 'sparse_csc', shape }) as never

  it('THE REGRESSION: a non-number entry no longer re-indexes the ones after it', () => {
    // The measured case. `['5000', 100, 7]` yielded `[100, 7]`, so the column count read
    // 7 — the extent of axis 2 — for a 100-column matrix.
    expect(() => declaredDims(csc(['5000', 100, 7]), 'art-1')).toThrow(UnsupportedArtifactStructure)
    expect(() => declaredDims(csc(['5000', 100, 7]), 'art-1')).toThrow(/art-1/)
    expect(() => declaredDims(csc(['5000', 100, 7]), 'art-1')).toThrow(/RE-INDEX every later one/)
    expect(() => declaredDims(csc([5000, null, 7]))).toThrow(UnsupportedArtifactStructure)
    expect(() => declaredDims(csc([5000, Number.NaN]))).toThrow(UnsupportedArtifactStructure)
    expect(() => declaredDims(csc([5000, Number.POSITIVE_INFINITY]))).toThrow(UnsupportedArtifactStructure)
    // Present but not a list at all is malformed too, not absence.
    expect(() => declaredDims(csc('huge'))).toThrow(UnsupportedArtifactStructure)
    expect(() => declaredDims(csc({ rows: 5000, cols: 100 }))).toThrow(UnsupportedArtifactStructure)
  })

  it('a WELL-FORMED shape is returned in axis order, and ABSENCE is still `[]`', () => {
    // The other side of the rule: refusing the malformed must not start refusing the
    // legitimate "the producer did not say", which is what `[]` means.
    expect(declaredDims(csc([5000, 100]))).toEqual([5000, 100])
    expect(declaredDims(csc([]))).toEqual([])
    expect(declaredDims(csc(undefined))).toEqual([])
    expect(declaredDims(csc(null))).toEqual([])
    // A member's own shape is held to the same rule…
    const table = (shape: unknown) =>
      ({ encoding: 'zarr_v3', kind: 'table', n: 12, columns: [{ path: 'x', kind: 'numeric', shape }] }) as never
    expect(declaredDims(table([5000, 2]))).toEqual([5000, 2])
    expect(() => declaredDims(table([5000, '2']), 'art-2')).toThrow(/member `x`'s `shape`/)
    // …and a member that declares none falls through to the table's own `n`, unchanged.
    expect(declaredDims(table(undefined))).toEqual([12])
  })

  it('a DISPLAY surface still degrades to `[]` rather than throwing', () => {
    // `declaredDimsForDisplay` is the one place the tolerance is spelled; the new throw
    // must not leak past it into a KPI card or a picker label.
    expect(declaredDimsForDisplay('art-1', { encoding: 'zarr_v3', kind: 'sparse_csc', shape: ['5000', 100] })).toEqual([])
    expect(declaredDimsForDisplay('art-1', { encoding: 'zarr_v3', kind: 'sparse_csc', shape: [5000, 100] })).toEqual([
      5000, 100,
    ])
  })

  it('…but the malformed declaration is REPORTED, not silently equated with absence', () => {
    // Rendering `[]` for both is right; RECORDING them the same is not. Without this the
    // third fact `declaredDims` was written to preserve is destroyed at 3 of its 4
    // production call sites (`StatCard`, `artifactLabel`, `runDiff`), and a producer
    // emitting `shape: ['5000', 100]` looks exactly like one that declared no extent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(
        declaredDimsForDisplay('art-warn', { encoding: 'zarr_v3', kind: 'sparse_csc', shape: ['5000', 100] }),
      ).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0].join(' ')).toContain('art-warn')

      // NEGATIVE CONTROL: a legitimate "the producer did not say" is NOT noise. If this
      // warned too, the signal above would be worthless.
      warn.mockClear()
      expect(declaredDimsForDisplay('art-quiet', { encoding: 'zarr_v3', kind: 'sparse_csc' })).toEqual([])
      expect(declaredDimsForDisplay('art-quiet', { encoding: 'zarr_v3', kind: 'sparse_csc', shape: [5000, 100] })).toEqual(
        [5000, 100],
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('resolveMember — a sole member is unambiguous; two are not', () => {
  const one = {
    encoding: 'zarr_v3' as const,
    kind: 'table' as const,
    columns: [{ path: 'values', kind: 'numeric' }],
  }
  const two = {
    encoding: 'zarr_v3' as const,
    kind: 'table' as const,
    columns: [{ path: 'a', kind: 'numeric' }, { path: 'b', kind: 'numeric' }],
  }

  it('picks the sole member when none is named', () => {
    expect(resolveMember('x', one).path).toBe('values')
  })

  it('REFUSES to pick a default from several — "the first one" is a guess', () => {
    expect(() => resolveMember('x', two)).toThrow(/name the one to read/)
  })

  it('names the available members when the requested one is absent', () => {
    expect(() => resolveMember('x', two, 'c')).toThrow(/has no member "c" \(members: a, b\)/)
  })

  it('lists columns then arrays, in declaration order', () => {
    const s = {
      encoding: 'zarr_v3' as const,
      kind: 'table' as const,
      columns: [{ path: 'c1' }],
      arrays: [{ path: 'a1' }],
    }
    expect(tableMembers(s).map(m => m.path)).toEqual(['c1', 'a1'])
  })
})

describe('resolveMember — a member has ONE address, and it is its `path` (INV-4)', () => {
  // §0.3: "Members of a directory are addressed by path through a merkle manifest." The
  // server half resolves EXACT-MATCH on the path (TEST-5, `member_path_test.rs`), and the
  // framework gate tells producers the same thing from the other side: "the name is a
  // label, never a key — `path` is the address" (`conformance.py`). So a `name` that is a
  // genuine LABEL must not address anything here either.
  //
  // Every producer in this repo happens to write `name === path`, which is exactly why
  // this needs a test: the invariant was holding by coincidence of the writers, and the
  // reader accepted the label as a second address. These cases are the ones no shipping
  // artifact can currently produce — which is the point of writing them.
  const labelled = {
    encoding: 'zarr_v3' as const,
    kind: 'table' as const,
    columns: [
      { path: 'col_0', name: 'Group', kind: 'categorical' as const },
      { path: 'col_1', name: 'Total', kind: 'numeric' as const },
    ],
  }

  it('resolves by PATH', () => {
    expect(resolveMember('x', labelled, 'col_0').name).toBe('Group')
    expect(resolveMember('x', labelled, 'col_1').name).toBe('Total')
  })

  it('REFUSES a display label as an address — the manifest cannot resolve one', () => {
    expect(() => resolveMember('x', labelled, 'Group')).toThrow(
      /has no member "Group" \(members: col_0, col_1\)/,
    )
  })

  // The negative control for the case that actually bites: a label that collides with a
  // DIFFERENT member's path. Under label-matching the answer depends on declaration order,
  // so the read is silently wrong rather than absent — the INV-3 failure mode. Path-only
  // resolution has one answer and it is the addressed member.
  it('never lets a label shadow another member whose PATH it collides with', () => {
    const colliding = {
      encoding: 'zarr_v3' as const,
      kind: 'table' as const,
      columns: [
        { path: 'a', name: 'b', kind: 'numeric' as const },
        { path: 'b', name: 'a', kind: 'categorical' as const },
      ],
    }
    expect(resolveMember('x', colliding, 'a').kind).toBe('numeric')
    expect(resolveMember('x', colliding, 'b').kind).toBe('categorical')
  })
})

// ── zarr_v3 reads, against the Python writer's bytes ────────────────────────────

describe('readTable — the Python writer\'s table artifact, decoded end to end', () => {
  it('decodes every declared member to the values the writer encoded', async () => {
    const table = await readTable('table', TABLE_STRUCTURE, { store: tableStore() })

    expect(table.columns).toEqual(['f32col', 'cat8', 'cat16', 'str'])
    expect(table.rows).toHaveLength(500)

    const col = (name: string) => table.rows.map(r => r[table.columns.indexOf(name)])
    // numeric → numbers (the writer's ramp starts at -3.25, step 0.5).
    expect(col('f32col').slice(0, 3)).toEqual([-3.25, -2.75, -2.25])
    // categorical → LABELS resolved through the DECLARED level set, incl. non-ASCII and
    // the deliberately empty one (which must stay a distinct level, not become null).
    expect(col('cat8').slice(0, 4)).toEqual(['group-A', '', 'café ☕', 'group-B'])
    // string (split arrow layout) → the strings themselves.
    expect(typeof col('str')[0]).toBe('string')
  })

  it('reports each column as it completes (the per-column progress hook)', async () => {
    const done: string[] = []
    await readTable('table', TABLE_STRUCTURE, { store: tableStore(), onColumn: name => done.push(name) })
    expect(done.sort()).toEqual(['cat16', 'cat8', 'f32col', 'str'])
  })
})

// TEST-29 [ITEM-24] — the COLUMNAR read is the same decode without the row-major round-trip.
//
// A table's decode is already columnar; `readTable` then transposes it to rows and every
// declarative consumer transposed it straight back (`columnarFromTable`). Two full N-length
// structures allocated so the two passes could cancel out. `readColumnarTable` skips both.
//
// The load-bearing assertion is PARITY against the row-major reader over the REAL Python-writer
// fixture — if the two ever disagree by a single value, the "pure allocation saving" claim is
// false and this change has altered data while claiming to alter only shape.
describe('readColumnarTable — same decode, no row-major round-trip (ITEM-24)', () => {
  // TEST-27 [ITEM-21] lives HERE, not at the path TESTS.md declares
  // (`core/runtime/columnValues.test.ts`, which this round never touched and which asserts
  // `toColumnRequests` keying instead). This is the parity claim TEST-27 states: the typed columns
  // the `column_values` arc now returns equal the previously-boxed ones element-for-element,
  // INCLUDING the string arm, which has no typed-array form. Cited here so the result binds to the
  // assertion rather than to a filename.
  it('is VALUE-IDENTICAL to readTable, column for column', async () => {
    const rowMajor = await readTable('table', TABLE_STRUCTURE, { store: tableStore() })
    const columnar = await readColumnarTable('table', TABLE_STRUCTURE, { store: tableStore() })

    // Same columns, same order.
    expect(Object.keys(columnar)).toEqual(rowMajor.columns)
    // Same VALUES, every column, every row — the parity oracle.
    //
    // ITEM-21 — compared value-by-value rather than container-to-container. The columnar reader
    // now yields the decoder's `Float32Array` for a numeric member while the row-major reader
    // still boxes on transposition, so `toEqual` between the two containers fails on their
    // CONSTRUCTORS even when every value agrees. `Array.from` normalises the representation and
    // leaves the claim — same values, same order, same length, every column — exactly as strong:
    // one differing value, a truncation or a pad still fails. It is NOT a relaxation, and the
    // representation itself is asserted separately (and strictly) in the test below, so nothing
    // that this normalisation hides goes unchecked.
    for (const [ci, name] of rowMajor.columns.entries()) {
      expect(Array.from(columnar[name] as ArrayLike<unknown>), `column ${name}`).toEqual(
        rowMajor.rows.map(r => r[ci]),
      )
    }
  })

  // TEST-31 [ITEM-26] — the PRODUCER half of the containment proof, and it lives here rather than
  // at the path TESTS.md declares. TEST-31's claim is the type SPLIT: a `column_values` slice
  // yields typed columns while an `axis_columns` slice over the SAME artifact still yields boxed
  // `unknown[]`. Both halves of that are asserted below, over one fixture. The CONSUMER half —
  // that the derived kernels consume the boxed form unchanged — is asserted in
  // `core/runtime/viewData.test.ts`, which cites TEST-31 at the same section.
  //
  // ITEM-21 — the REPRESENTATION claim, asserted here so the parity test above may normalise it.
  //
  // This is the producer of the typed arc: the guards (`isColumn`), the kernels and
  // `sliceRevision` were all converted to accept a typed column, but until the decode stopped
  // boxing, nothing in production ever handed them one — capability with no caller. It also pins
  // the SPLIT that keeps the unconverted consumers safe: `readTable` re-boxes on transposition,
  // so `job.result` and `axis_columns` (which read through it) cannot be silently typed by this
  // change. If that split ever collapses, this test says so.
  it('yields the decoder\'s TypedArray for a numeric member — and readTable still boxes', async () => {
    const columnar = await readColumnarTable('table', TABLE_STRUCTURE, { store: tableStore() })
    const rowMajor = await readTable('table', TABLE_STRUCTURE, { store: tableStore() })

    // The numeric member arrives unboxed — no per-value copy over a buffer the decoder filled.
    expect(ArrayBuffer.isView(columnar.f32col), 'a numeric column is typed').toBe(true)
    expect(Array.isArray(columnar.f32col), 'and is therefore NOT an Array').toBe(false)
    // A categorical yields LABELS and a string column strings — neither can be typed.
    expect(Array.isArray(columnar.cat8), 'a categorical stays boxed (it holds labels)').toBe(true)
    expect(Array.isArray(columnar.str), 'a string column stays boxed').toBe(true)

    // …and the row-major reader is unaffected: its rows hold plain values, so every consumer
    // that transposes them back (`columnarFromTable`) still gets boxed columns.
    expect(Array.isArray(rowMajor.rows[0])).toBe(true)
    expect(typeof rowMajor.rows[0][rowMajor.columns.indexOf('f32col')]).toBe('number')
  })

  it('yields ONE array per COLUMN, where the row-major reader yields one per ROW', async () => {
    // The observable shape difference the allocation saving comes from: 4 column arrays here
    // versus 500 row arrays there, over the same fixture.
    const rowMajor = await readTable('table', TABLE_STRUCTURE, { store: tableStore() })
    const columnar = await readColumnarTable('table', TABLE_STRUCTURE, { store: tableStore() })
    expect(rowMajor.rows).toHaveLength(500)
    expect(Object.keys(columnar)).toHaveLength(4)
    for (const v of Object.values(columnar)) expect(v).toHaveLength(500)
  })

  it('keeps readTable\'s refusals — a memberless table is still an error (INV-2)', async () => {
    // The columnar reader must not become a quieter way to get an empty result out of an
    // artifact the row-major reader refuses. That refusal is INV-2 — "absence is an error,
    // not an empty result" — and it is exactly the failure a second entry point invites.
    const memberless = parseStructure('table', { ...(TABLE_STRUCTURE as unknown as Record<string, unknown>), columns: [] })
    await expect(readColumnarTable('table', memberless, { store: tableStore() })).rejects.toThrow(
      /declares no members/,
    )
    // ...and the row-major reader refuses the SAME input the same way, so the two entry
    // points cannot drift into disagreeing about what is readable.
    await expect(readTable('table', memberless, { store: tableStore() })).rejects.toThrow(
      /declares no members/,
    )
  })
})

describe('readCategoricalColumn — codes + the DECLARED level set (D10)', () => {
  it('keeps a level that never occurs in the data', async () => {
    const c = await readCategoricalColumn('table', TABLE_STRUCTURE, 'cat8', { store: tableStore() })
    expect(c.categories).toEqual(['group-A', 'group-B', 'café ☕', '', 'NEVER-OBSERVED'])
    expect(c.codes).toBeInstanceOf(Uint32Array)
    expect(c.codes).toHaveLength(500)
    // The unused level is the point: a reader that derived levels FROM the codes would
    // silently drop it, and the legend would lose a category that legitimately exists.
    expect(new Set(c.codes).has(4)).toBe(false)
    expect(c.categories[4]).toBe('NEVER-OBSERVED')
  })

  it('widens uint16 codes without truncating (>255 levels)', async () => {
    const c = await readCategoricalColumn('table', TABLE_STRUCTURE, 'cat16', { store: tableStore() })
    expect(c.categories).toHaveLength(300)
    expect(Math.max(...c.codes)).toBeGreaterThan(255)
  })

  it('codes a STRING column, whose producer declared no level set', async () => {
    const c = await readCategoricalColumn('table', TABLE_STRUCTURE, 'str', { store: tableStore() })
    expect(c.codes).toHaveLength(500)
    expect(c.categories.length).toBeGreaterThan(0)
    // Round-trip: code → label reproduces the decoded string column exactly.
    const asStrings = Array.from(c.codes, code => c.categories[code])
    const table = await readTable('table', TABLE_STRUCTURE, { store: tableStore() })
    expect(asStrings).toEqual(table.rows.map(r => r[table.columns.indexOf('str')]))
  })

  it('REFUSES a categorical whose levels are neither declared nor stored', async () => {
    const store = memoryStore(rawColumn('values', 'uint8', [0, 1, 0]))
    const structure = parseStructure('x', {
      encoding: 'zarr_v3',
      kind: 'table',
      columns: [{ path: 'values', kind: 'categorical' }],
    })
    // A `uint8` array is not a categorical because its values happen to be small — the
    // level set is DECLARED. Inferring one here is the failure INV-2 exists to prevent.
    await expect(readCategoricalColumn('x', structure, undefined, { store })).rejects.toThrow(
      /levels are DECLARED, never inferred/,
    )
  })
})

// ── ROUND-6 FINDING 6 · `split` is the only string layout, and it is DECLARED ─────
//
// `openStringColumn` used to dispatch `layout === 'split'` ⇒ the offsets/values pair,
// ANYTHING ELSE ⇒ a single-buffer arrow decoder. That decoder was built, exported and
// unit-tested, and could never run: `cyto_zarr.Table.string` writes the split form and
// stamps `layout: "split"` on every string member, and `conformance.py`'s
// `_conform_string_member` reads `<path>/offsets` + `<path>/values` unconditionally, so a
// single-buffer member fails the framework gate before any reader sees it. It is deleted;
// the else-arm is now a refusal that names the layout, which is what an undeclared or
// unknown layout deserved all along (INV-2 — absence is an error, not a default branch).

describe('openStringColumn — an unknown string layout is refused, never guessed', () => {
  const stringMember = (layout?: string) =>
    parseStructure('x', {
      encoding: 'zarr_v3',
      kind: 'table',
      columns: [{ path: 'values', kind: 'string', ...(layout === undefined ? {} : { layout }) }],
    })

  it('refuses a layout this reader does not decode, naming it', async () => {
    const store = memoryStore(rawColumn('values', 'uint8', [0, 1, 0]))
    const opening = openStringColumn('x', stringMember('arrow'), undefined, { store })
    await expect(opening).rejects.toThrow(UnsupportedArtifactStructure)
    await expect(
      openStringColumn('x', stringMember('arrow'), undefined, { store }),
    ).rejects.toThrow(/declares layout "arrow"/)
    await expect(
      openStringColumn('x', stringMember('arrow'), undefined, { store }),
    ).rejects.toThrow(/only string layout this reader decodes is "split"/)
  })

  it('an ABSENT layout is refused too — it used to select the unreachable decoder', async () => {
    const store = memoryStore(rawColumn('values', 'uint8', [0, 1, 0]))
    await expect(openStringColumn('x', stringMember(), undefined, { store })).rejects.toThrow(
      /declares layout \(none\)/,
    )
  })

  it('NEGATIVE CONTROL: the writer\'s `split` column opens and yields its VALUES', async () => {
    // The one layout a producer emits, read through the same entry point — so the
    // refusals above cannot be passing by refusing everything.
    const column = await openStringColumn('table', TABLE_STRUCTURE, 'str', { store: tableStore() })
    expect(column.length).toBe(500)
    const table = await readTable('table', TABLE_STRUCTURE, { store: tableStore() })
    expect(await column.readAll()).toEqual(table.rows.map(r => r[table.columns.indexOf('str')]))
  })
})

describe('readNumericColumn / readPositions', () => {
  it('reads a numeric column as Float32Array', async () => {
    const values = await readNumericColumn('table', TABLE_STRUCTURE, 'f32col', { store: tableStore() })
    expect(values).toBeInstanceOf(Float32Array)
    expect(values).toHaveLength(500)
    expect(values[0]).toBeCloseTo(-3.25, 6)
  })

  it('PROGRESSIVE: chunks arrive in order and cover the whole read', async () => {
    const seen: { index: number; total: number; offset: number; n: number }[] = []
    const values = await readNumericColumn('table', TABLE_STRUCTURE, 'f32col', {
      store: tableStore(),
      onChunk: s => seen.push({ index: s.index, total: s.total, offset: s.offset, n: s.values.length }),
    })
    // The fixture is 500 elements at inner_chunk 64 ⇒ 8 chunks. More than one is what
    // makes "paints in stages" possible at all; the ordering is what makes it coherent.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.map(s => s.index)).toEqual(seen.map((_, i) => i))
    expect(new Set(seen.map(s => s.total))).toEqual(new Set([seen.length]))
    // Contiguous cover: chunk k starts exactly where chunk k-1 ended.
    let cursor = 0
    for (const s of seen) {
      expect(s.offset).toBe(cursor)
      cursor += s.n
    }
    expect(cursor).toBe(values.length)
  })

  it('reads a row-chunked 2-D member as interleaved positions', async () => {
    const tree = loadTree(join(FIXTURES, 'f32_rowchunk_2d'))
    const store = memoryStore(new Map([...tree].map(([k, v]) => [`coords/${k}`, v])))
    const structure = parseStructure('xy', {
      encoding: 'zarr_v3',
      kind: 'table',
      arrays: [{ path: 'coords', kind: 'numeric' }],
    })
    const chunks: number[] = []
    const p = await readPositions('xy', structure, undefined, { store, onChunk: s => chunks.push(s.index) })
    expect(p.positions).toBeInstanceOf(Float32Array)
    expect(p.positions).toHaveLength(p.length * 2)
    // …and they are the PRODUCER's coordinates. The oracle is the generator's own flat
    // dump, computed from its numpy input, so neither side of this comparison comes from
    // the reader. Shape + length alone passed for a `positions` of the right size holding
    // anything at all — including every y set to zero.
    const flat = (EXPECTED as unknown as { f32_rowchunk_2d: { flat: number[] } }).f32_rowchunk_2d
      .flat
    expect(p.length).toBe(flat.length / 2)
    expect([...p.positions]).toEqual(flat)
    // Chunk arrival is per ROW BLOCK at full width, so chunk k completes whole POINTS —
    // which is what makes painting inside the loop show a growing cloud rather than a
    // smear of half-points.
    expect(chunks).toEqual(chunks.map((_, i) => i))
  })

  // The N-D → 2-D REDUCTION arm — `dims > 2` keeps the first two columns and drops the
  // rest, because the viz wire is 2-D.
  //
  // It had no coverage at all. The 2-D f32 case above returns the decoded buffer
  // UNTOUCHED (a zero-copy `return wide`), so it never enters the loop that does the
  // reduction; every other positions test asserts shape, length, chunk order or request
  // counts. Zeroing the y write inside the loop left the whole suite green.
  //
  // The oracle is a hand-laid member whose values are chosen so a wrong INDEX is visible
  // rather than plausible: x is `10 + i`, y is `20 + i`, z is `30 + i`, so reading the
  // wrong column, the wrong stride, or a constant all produce a different number at every
  // row — the arrangement `[0,1,2,3,…]` would not, since `i*dims+1` and `i*2+1` agree at
  // i=0 for a run of consecutive integers.
  it('PROJECTS an n×3 member onto its first two columns, values and all', async () => {
    const rows = 6
    const flat: number[] = []
    for (let i = 0; i < rows; i++) flat.push(10 + i, 20 + i, 30 + i)
    const store = memoryStore(rawMatrix('xyz', 'float64', rows, 3, flat))
    const structure = parseStructure('nd', {
      encoding: 'zarr_v3',
      kind: 'table',
      arrays: [{ path: 'xyz', kind: 'numeric' }],
    })

    const p = await readPositions('nd', structure, undefined, { store })
    expect(p.length).toBe(rows)
    expect(p.positions).toBeInstanceOf(Float32Array)
    expect([...p.positions]).toEqual([10, 20, 11, 21, 12, 22, 13, 23, 14, 24, 15, 25])
    // Stated as the two properties the interleave has to hold, so a failure names which
    // half broke instead of dumping twelve numbers.
    for (let i = 0; i < rows; i++) {
      expect(p.positions[i * 2], `x of point ${i}`).toBe(10 + i)
      expect(p.positions[i * 2 + 1], `y of point ${i}`).toBe(20 + i)
    }
    // The third column is DROPPED, not folded in anywhere.
    expect([...p.positions].some(v => v >= 30)).toBe(false)
  })

  // The same loop's OTHER entrance: `dims === 2` at a non-f32 element width. The zero-copy
  // return is guarded on `wide instanceof Float32Array`, so an f64 layout — which a
  // producer may legitimately declare — is converted here rather than returned. Covered
  // alongside the projection because one `instanceof` separates them, and a "simplify the
  // branch" edit that returned `wide` unconditionally would hand a Float64Array out as
  // `positions` with every consumer typed to expect otherwise.
  it('CONVERTS a 2-D f64 member instead of handing back the wide buffer', async () => {
    const store = memoryStore(rawMatrix('xy64', 'float64', 4, 2, [1, -1, 2, -2, 3, -3, 4, -4]))
    const structure = parseStructure('f64xy', {
      encoding: 'zarr_v3',
      kind: 'table',
      arrays: [{ path: 'xy64', kind: 'numeric' }],
    })

    const p = await readPositions('f64xy', structure, undefined, { store })
    expect(p.positions).toBeInstanceOf(Float32Array)
    expect(p.length).toBe(4)
    expect([...p.positions]).toEqual([1, -1, 2, -2, 3, -3, 4, -4])
  })

  it('REFUSES a 1-value-per-entity member as a layout', async () => {
    const store = memoryStore(rawColumn('values', 'float64', [1, 2, 3]))
    const structure = parseStructure('x', {
      encoding: 'zarr_v3',
      kind: 'table',
      columns: [{ path: 'values', kind: 'numeric' }],
    })
    await expect(readPositions('x', structure, undefined, { store })).rejects.toThrow(/needs at least 2/)
  })
})

// ── sparse_csc: the PRODUCER's bytes, decoded by the SHIPPED reader ────────────
//
// Every assertion here runs `cyto_csc.write_csc_zarr`'s output — real shuffle+gzip inside
// a real sharding index — through `readSparseColumn`. The oracle is `expected.json`, which
// the generator computed from its numpy input, so neither side of the comparison is
// derived from the thing under test.

describe('readSparseColumn — the CSC hot path, over the real writer\'s output', () => {
  const CSC_TREE = loadTree(join(FIXTURES, 'csc'))
  const CSC_STRUCTURE = stampedStructure('csc', CSC_TREE)
  const csc = EXPECTED.csc

  /** A `memoryStore` that RECORDS every access, so "a column read is a range" is asserted
   *  rather than assumed. The store is the reader's whole view of the transport, so a
   *  whole-member read is visible here as `get()` rather than `getRange()`. */
  function countingStore() {
    const inner = memoryStore(CSC_TREE)
    const calls: { op: 'get' | 'getRange' | 'getSuffix'; path: string; bytes: number }[] = []
    return {
      calls,
      store: {
        async get(path: string) {
          const b = await inner.get(path)
          calls.push({ op: 'get', path, bytes: b?.byteLength ?? 0 })
          return b
        },
        async getRange(path: string, start: number, length: number) {
          const b = await inner.getRange(path, start, length)
          calls.push({ op: 'getRange', path, bytes: b.byteLength })
          return b
        },
        async getSuffix(path: string, length: number) {
          const b = await inner.getSuffix(path, length)
          calls.push({ op: 'getSuffix', path, bytes: b.byteLength })
          return b
        },
      },
    }
  }

  it('the writer stamped exactly the declaration the reader dispatches on', () => {
    // The reconciliation this suite exists to hold: the document `write_csc_zarr` returned
    // into the artifact row IS what `parseStructure` accepts, key for key.
    expect(CSC_STRUCTURE).toEqual(csc.structure)
    expect(CSC_STRUCTURE.encoding).toBe('zarr_v3')
    expect(CSC_STRUCTURE.kind).toBe('sparse_csc')
  })

  it('decodes EVERY column to the values the writer encoded', async () => {
    for (const want of csc.columns) {
      const { store } = countingStore()
      const got = await readSparseColumn('csc', want.col, CSC_STRUCTURE, { store })
      expect(got.row, `column ${want.col} row ids`).toBeInstanceOf(Uint32Array)
      expect(got.value, `column ${want.col} values`).toBeInstanceOf(Float32Array)
      expect(got.row.length, `column ${want.col} non-zero count`).toBe(want.n)
      expect(got.value.length).toBe(want.n)
      if (want.n === 0) continue
      expect(got.row[0]).toBe(want.rowFirst)
      expect(got.row[got.row.length - 1]).toBe(want.rowLast)
      expect(got.value[0]).toBeCloseTo(want.valueFirst as number, 5)
      expect(got.value[got.value.length - 1]).toBeCloseTo(want.valueLast as number, 5)
      expect(got.row.reduce((a, b) => a + b, 0)).toBe(want.rowSum)
      expect(got.value.reduce((a, b) => a + b, 0)).toBeCloseTo(want.valueSum, 2)
    }
  })

  it('decodes the chunk-STRADDLING column value for value', async () => {
    // The column whose non-zero span crosses an inner-chunk boundary — where a wrong range
    // returns a plausible half-column instead of an obvious error.
    const { col, row, value } = csc.fullColumn
    const { store } = countingStore()
    const got = await readSparseColumn('csc', col, CSC_STRUCTURE, { store })
    expect(Array.from(got.row)).toEqual(row)
    expect(Array.from(got.value)).toEqual(value)
    const chunk = csc.innerChunk
    const lo = csc.indptr[col]
    const hi = csc.indptr[col + 1]
    expect(Math.floor(lo / chunk), 'the fixture must really straddle a chunk edge').not.toBe(
      Math.floor((hi - 1) / chunk),
    )
  })

  it('reads a RANGE of the value members, not the whole of them', async () => {
    // A column that lands INSIDE one inner chunk — the ordinary case, and the one where a
    // whole-member read would be a real regression. (The straddling column legitimately
    // covers every chunk of its shard, at which point the reader fetches the shard in one
    // request instead of two ranges plus an index probe; that is the ITEM-33 optimization,
    // not a regression, which is why it is not the column asserted on here.)
    const single = csc.columns.find(
      c => c.n > 0 && Math.floor(csc.indptr[c.col] / csc.innerChunk) ===
        Math.floor((csc.indptr[c.col + 1] - 1) / csc.innerChunk),
    )!
    const { store, calls } = countingStore()
    await readSparseColumn('csc', single.col, CSC_STRUCTURE, { store })

    const values = calls.filter(c => /^(indices|data)\//.test(c.path) && !c.path.endsWith('zarr.json'))
    expect(values.length).toBeGreaterThan(0)
    expect(
      values.filter(c => c.op === 'get'),
      'a value member was fetched whole instead of by range',
    ).toEqual([])

    const members = CSC_STRUCTURE as unknown as {
      indices: { stored_bytes: number }
      data: { stored_bytes: number }
    }
    const fetched = values.reduce((n, c) => n + c.bytes, 0)
    const stored = members.indices.stored_bytes + members.data.stored_bytes
    expect(fetched, 'one column cost less than the two value members hold').toBeLessThan(stored)
  })

  it('an EMPTY column fetches NO payload at all', async () => {
    const { store, calls } = countingStore()
    const got = await readSparseColumn('csc', csc.emptyColumn, CSC_STRUCTURE, { store })
    expect(got.row).toHaveLength(0)
    expect(got.value).toHaveLength(0)
    // `indptr[c] === indptr[c+1]` ⇒ there is nothing to read. Issuing a zero-length range
    // would be a 416 from the server, which reads as a transport fault rather than "no
    // non-zeros".
    const touched = new Set(calls.filter(c => !c.path.endsWith('zarr.json')).map(c => c.path.split('/')[0]))
    expect([...touched]).toEqual(['indptr'])
  })

  it('rejects an out-of-range column from the DECLARATION, before any request', async () => {
    const { store, calls } = countingStore()
    await expect(
      readSparseColumn('csc', csc.shape[1], CSC_STRUCTURE, { store }),
    ).rejects.toThrow(/out of range/)
    expect(calls, 'refused without touching the transport').toHaveLength(0)
  })

  it('rejects a TABLE rather than reading it as a matrix', async () => {
    // The shipped break, in one assertion: both artifacts are `zarr_v3`, so only the kind
    // tells them apart. This must name what it got.
    await expect(readSparseColumn('table', 0, TABLE_STRUCTURE)).rejects.toThrow(
      /sparse column read needs a `zarr_v3` `sparse_csc` artifact, got `zarr_v3` kind "table"/,
    )
  })

  it('rejects a declaration missing one of the three members', async () => {
    const { indices: _dropped, ...partial } = CSC_STRUCTURE as unknown as Record<string, unknown>
    const structure = parseStructure('csc', partial)
    await expect(readSparseColumn('csc', 0, structure)).rejects.toThrow(
      /declares no "indices" member/,
    )
  })
})

// ── readTable — an unreadable artifact is an ERROR, never an empty table ────────

describe('readTable — absence is an error (INV-2)', () => {
  it('REFUSES a sparse matrix instead of returning zero rows', async () => {
    // The second half of the shipped break, and the quieter half: `readTable` walked
    // `columns`/`arrays`, found neither on a CSC declaration, and returned
    // `{columns: [], rows: []}` — a blank table with nothing thrown anywhere.
    const structure = stampedStructure('csc', loadTree(join(FIXTURES, 'csc')))
    await expect(readTable('csc', structure)).rejects.toThrow(
      /expected a `zarr_v3` table, got `zarr_v3` kind "sparse_csc"/,
    )
  })

  it('REFUSES a table that declares no members', async () => {
    const structure = parseStructure('empty', {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'rows',
      n: 0,
      columns: [],
      arrays: [],
    })
    await expect(readTable('empty', structure)).rejects.toThrow(/declares no members/)
  })
})

// ── the HTTP transport, end to end over the producer's bytes ────────────────────

describe('readSparseColumn over the real request path', () => {
  const CSC_TREE = loadTree(join(FIXTURES, 'csc'))
  const CSC_STRUCTURE = stampedStructure('csc', CSC_TREE)

  /** A `fetch` that serves the fixture tree and honours `?range=`, recording every request.
   *
   *  Only the NETWORK is stubbed — `readSparseColumn` → `artifactStore` → the generated
   *  `ApiClient.Workstore.getArtifactDataMember` → the framework transport → `getBaseUrl`
   *  all run for real, which is why `window` is stubbed too (this suite runs in the node
   *  environment). Injecting a fake store instead would have skipped the URL + parameter
   *  construction, which is precisely the part a member rename breaks.
   *
   *  The range rides as a QUERY PARAM and the answer is **200**, never 206 (ITEM-36): the
   *  URL names the exact bytes, so a ranged read is a complete response FOR THAT URL — and
   *  that is what makes it an ordinary cacheable GET. */
  function stubFetch() {
    const calls: { member: string; range: string | null; bytes: number }[] = []
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3155' } })
    vi.stubGlobal('fetch', async (url: string) => {
      const [member, query] = String(url).split('/data/')[1].split('?')
      const all = CSC_TREE.get(decodeURIComponent(member))
      if (!all) return new Response(null, { status: 404 })
      const range = new URLSearchParams(query ?? '').get('range')
      const m = range?.match(/^(\d+)-(\d+)$/)
      const suffix = range?.match(/^-(\d+)$/)
      const body = m
        ? all.subarray(Number(m[1]), Number(m[2]) + 1)
        : suffix
          ? all.subarray(Math.max(0, all.byteLength - Number(suffix[1])))
          : all
      calls.push({ member, range, bytes: body.byteLength })
      return new Response(body.slice() as unknown as BodyInit, { status: 200 })
    })
    return calls
  }

  // Opened member arrays are cached PROCESS-WIDE by artifact id (they hold decoded chunks
  // of immutable bytes), so a suite that counts requests must start each case from cold.
  // Without this the cases below would pass only for as long as their artifact ids happen
  // to differ — a later case reusing an id would be served from the previous case's
  // decoded chunks and see zero requests.
  afterEach(() => {
    vi.unstubAllGlobals()
    __resetArtifactArrayCache()
  })

  it('decodes a column over real HTTP requests, all of them member-scoped', async () => {
    const csc = EXPECTED.csc
    const calls = stubFetch()
    const want = csc.fullColumn
    const got = await readSparseColumn(`art-${Math.random()}`, want.col, CSC_STRUCTURE)

    expect(Array.from(got.row)).toEqual(want.row)
    expect(Array.from(got.value)).toEqual(want.value)

    expect(calls.length).toBeGreaterThan(0)
    // Every request names a MEMBER path under the artifact — never the artifact root, which
    // is what a "just fetch it all and decode client-side" regression would look like.
    expect(calls.every(c => /^(indptr|indices|data)\//.test(c.member))).toBe(true)
    const artifactBytes = [...CSC_TREE.values()].reduce((n, b) => n + b.byteLength, 0)
    expect(calls.reduce((n, c) => n + c.bytes, 0)).toBeLessThan(artifactBytes)
  })

  it('issues RANGED requests for a column inside one chunk', async () => {
    const csc = EXPECTED.csc
    const single = csc.columns.find(
      c => c.n > 0 && Math.floor(csc.indptr[c.col] / csc.innerChunk) ===
        Math.floor((csc.indptr[c.col + 1] - 1) / csc.innerChunk),
    )!
    const calls = stubFetch()
    await readSparseColumn(`art-${Math.random()}`, single.col, CSC_STRUCTURE)
    const values = calls.filter(c => /^(indices|data)\/c\//.test(c.member))
    expect(values.length).toBeGreaterThan(0)
    expect(values.every(c => c.range !== null), 'every value-member request is ranged').toBe(true)
  })
})

// ── one member, SEVERAL consumers: the opened-array cache ──────────────────────
//
// A member is routinely read by several independent consumers that cannot see each other
// (for a project layout: the canvas grid's positions handoff inside `@ziee/viz` AND the
// declarative-canvas host's plottable-XY resolve, in different packages, each already
// memoizing its OWN single read). The bytes are immutable and content-addressed, so the
// SECOND consumer must pay nothing — and a second consumer that starts while the first is
// still in flight must join its requests rather than issue its own.
//
// This is asserted on REQUEST COUNTS over the real transport, because that is the only
// thing that distinguishes reuse from a re-fetch that returns the same values: every
// version of this code returns correct positions.
describe('readPositions — repeat + concurrent reads of one member', () => {
  const XY_TREE = loadTree(join(FIXTURES, 'f32_rowchunk_2d'))
  const XY_STRUCTURE = parseStructure('xy', {
    encoding: 'zarr_v3',
    kind: 'table',
    arrays: [{ path: 'coords', kind: 'numeric' }, { path: 'other', kind: 'numeric' }],
  })
  /** The fixture served at BOTH member paths, so "member A is not satisfied by member B"
   *  is a check on the cache key rather than on the two trees differing. */
  const XY_MEMBERS = new Map<string, Uint8Array>([
    ...[...XY_TREE].map(([k, v]) => [`coords/${k}`, v] as const),
    ...[...XY_TREE].map(([k, v]) => [`other/${k}`, v] as const),
  ])

  /** Serve the member tree over a stubbed `fetch`, recording every request path. Only the
   *  NETWORK is stubbed — `artifactStore` → the generated ApiClient → the transport all run,
   *  which is the layer an injected store would skip. */
  function stubFetch(): string[] {
    const paths: string[] = []
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3155' } })
    vi.stubGlobal('fetch', async (url: string) => {
      const [member, query] = String(url).split('/data/')[1].split('?')
      const all = XY_MEMBERS.get(decodeURIComponent(member))
      if (!all) return new Response(null, { status: 404 })
      paths.push(member)
      const range = new URLSearchParams(query ?? '').get('range')
      const window = range?.match(/^(\d+)-(\d+)$/)
      const suffix = range?.match(/^-(\d+)$/)
      const body = window
        ? all.subarray(Number(window[1]), Number(window[2]) + 1)
        : suffix
          ? all.subarray(Math.max(0, all.byteLength - Number(suffix[1])))
          : all
      return new Response(body.slice() as unknown as BodyInit, { status: 200 })
    })
    return paths
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    __resetArtifactArrayCache()
  })

  it('a SECOND read of the same member issues NO further requests', async () => {
    const paths = stubFetch()
    const first = await readPositions('art-cache-1', XY_STRUCTURE, 'coords')
    const afterFirst = paths.length
    expect(afterFirst, 'the first read crossed the network').toBeGreaterThan(0)

    const second = await readPositions('art-cache-1', XY_STRUCTURE, 'coords')
    expect(paths.length - afterFirst, 'the second read re-fetched nothing').toBe(0)
    // …and it is the same DATA, not an empty/short answer that happens to cost nothing.
    expect(Array.from(second.positions)).toEqual(Array.from(first.positions))
    expect(second.length).toBe(first.length)
    // Each read still owns its OWN buffer — a consumer that mutates its positions in place
    // must not corrupt the next consumer's read.
    expect(second.positions).not.toBe(first.positions)
  })

  it('two CONCURRENT reads of one member fetch each chunk ONCE', async () => {
    const paths = stubFetch()
    // Started together, as two independent consumers do on first paint: neither can find
    // the other's decoded chunks, so this is served by the in-flight join, not the cache.
    const [a, b] = await Promise.all([
      readPositions('art-cache-2', XY_STRUCTURE, 'coords'),
      readPositions('art-cache-2', XY_STRUCTURE, 'coords'),
    ])
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions))
    // ── RESTATED for ITEM-18, not weakened ────────────────────────────────────────────
    //
    // This used to read `new Set(paths).size === paths.length` — "no path was requested
    // twice". ITEM-18 makes that false BY DESIGN: a sharded read now costs one SUFFIX
    // request for the fixed-size index plus one un-ranged request for the body, and both
    // name the same shard path. Counting distinct paths can no longer express the
    // property it was protecting.
    //
    // The property WAS "the second concurrent reader joins the first rather than
    // re-fetching", and that is asserted directly below and is strictly stronger: it
    // pins the exact per-path request count instead of inferring it from a set size, so
    // a third duplicate request would fail here where the old form could only fail once.
    expect(paths.filter(p => p === 'coords/zarr.json')).toHaveLength(1)
    for (const path of new Set(paths)) {
      if (path === 'coords/zarr.json') continue
      expect(
        paths.filter(p => p === path).length,
        `shard "${path}" is read at most twice — one index, one body — however many ` +
          'CONCURRENT readers ask for it; more than that means the in-flight join broke',
      ).toBeLessThanOrEqual(2)
    }
    // …and the join really happened: two readers of a 2-shard member cost the same
    // requests as one would. Without the join this doubles.
    expect(paths.length, 'two concurrent readers issue ONE read between them').toBe(
      new Set(paths).size + (new Set(paths).size - 1),
    )
  })

  it('the cache is keyed by (artifact, member) — and an INJECTED store never joins it', async () => {
    const paths = stubFetch()
    await readPositions('art-cache-3', XY_STRUCTURE, 'coords')
    const afterFirst = paths.length

    // A different MEMBER of the same artifact is a different key.
    await readPositions('art-cache-3', XY_STRUCTURE, 'other')
    expect(paths.length, 'another member is read for real').toBeGreaterThan(afterFirst)
    const afterOther = paths.length

    // A different ARTIFACT is a different key — bytes are never served across artifacts.
    await readPositions('art-cache-4', XY_STRUCTURE, 'coords')
    expect(paths.length, 'another artifact is read for real').toBeGreaterThan(afterOther)

    // The negative control for the whole mechanism: an injected store is not derivable from
    // an artifact id, so it must bypass the cache entirely — both directions. The unit suite
    // above depends on this (it would otherwise leak decoded chunks between cases).
    const injected = { store: memoryStore(XY_MEMBERS) }
    const before = paths.length
    await readPositions('art-cache-3', XY_STRUCTURE, 'coords', injected)
    await readPositions('art-cache-3', XY_STRUCTURE, 'coords', injected)
    expect(paths.length, 'an injected-store read never touches the network').toBe(before)
    // …and it did not populate the cache either: a later HTTP read of that same key still
    // has to fetch. (`art-cache-5` is untouched above, so this cannot be a cache hit.)
    await readPositions('art-cache-5', XY_STRUCTURE, 'coords', injected)
    const beforeHttp = paths.length
    await readPositions('art-cache-5', XY_STRUCTURE, 'coords')
    expect(paths.length, 'the injected read left the HTTP cache cold').toBeGreaterThan(beforeHttp)
  })
})


// ── the `opaque` JSON-columnar table arm ───────────────────────────────────────
//
// Shipping processors write a per-entity column table as a JSON document and DECLARE
// `opaque("application/json")` for it — so a table read of one dispatches to the JSON arm,
// not the Zarr one. Until ITEM-12 the SERVER decoded this (`/read`'s Table arm parsed the
// blob and transcoded it to Arrow); deleting the endpoint moved the decode here, and these
// assertions pin the shapes it must keep accepting. Without them the reader compiled, every
// Zarr test passed, and a table slice was unreadable for the one encoding those producers
// emit.
//
// Every fixture below is DOMAIN-FREE on purpose. The arm resolves the column envelope
// structurally (the server used a hardcoded producer-specific member NAME), so what needs
// proving is that it works for ANY producer's naming — a fixture spelling one producer's
// member names would demonstrate the opposite of the property under test. The real payloads
// are exercised end to end by the e2e specs, where that vocabulary belongs.
describe('readTable — an opaque JSON-columnar blob is a table too', () => {
  const blob = (value: unknown) =>
    memoryStore(new Map([['', new TextEncoder().encode(JSON.stringify(value))]]))
  const OPAQUE = parseStructure('t', { encoding: 'opaque', media_type: 'application/json' })

  it('decodes the ENVELOPED shape a producer writes, non-columnar siblings and all', async () => {
    // The envelope form: a declared `columns` list, the column map nested under a member,
    // and scalar/array siblings beside it that are NOT columns.
    const table = await readTable('t', OPAQUE, {
      store: blob({
        columns: ['key', 'score'],
        n_entities: 3,
        frame: { key: ['k0', 'k1', 'k2'], score: [0.5, 1.5, 2.5] },
        notes: [],
      }),
    })
    expect(table.columns).toEqual(['key', 'score'])
    expect(table.rows).toEqual([
      ['k0', 0.5],
      ['k1', 1.5],
      ['k2', 2.5],
    ])
  })

  it('prefers the nested column map over a sibling ARRAY at the top level', async () => {
    // `notes` is an array but not a column; a resolver that read the blob object itself
    // whenever it held any array would return the wrong table with no error.
    const table = await readTable('t', OPAQUE, {
      store: blob({ n_entities: 2, notes: ['a', 'b'], frame: { key: ['k0', 'k1'] } }),
    })
    expect(table.columns).toEqual(['key'])
    expect(table.rows).toEqual([['k0'], ['k1']])
  })

  it('accepts the ROW-oriented `{columns, rows}` shape unchanged', async () => {
    const table = await readTable('t', OPAQUE, {
      store: blob({ columns: ['a', 'b'], rows: [[1, 'x'], [2, 'y']] }),
    })
    expect(table.columns).toEqual(['a', 'b'])
    expect(table.rows).toEqual([[1, 'x'], [2, 'y']])
  })

  it('accepts a BARE `{col:[…]}` map (no envelope, no declared order)', async () => {
    const table = await readTable('t', OPAQUE, { store: blob({ a: [1, 2], b: ['x', 'y'] }) })
    expect(table.columns).toEqual(['a', 'b'])
    expect(table.rows).toEqual([[1, 'x'], [2, 'y']])
  })

  it('the DECLARED `columns` list fixes the order, not the map', async () => {
    // Dropping this reorders every widget's columns for a blob whose map order differs
    // from what its producer declared.
    const table = await readTable('t', OPAQUE, {
      store: blob({ columns: ['b', 'a'], frame: { a: [1], b: ['x'] } }),
    })
    expect(table.columns).toEqual(['b', 'a'])
    expect(table.rows).toEqual([['x', 1]])
  })

  it('the DECLARATION picks between two candidate column maps', async () => {
    // The shape that made the server hardcode an envelope name: a real payload can carry a
    // SECOND nested member whose values are also arrays. The declared `columns` list is what
    // distinguishes them — no member name is compiled in.
    const table = await readTable('t', OPAQUE, {
      store: blob({
        columns: ['key', 'score'],
        frame: { key: ['k0'], score: [7] },
        annotations: { score: ['unrelated'], extra: ['x'] },
      }),
    })
    expect(table.columns).toEqual(['key', 'score'])
    expect(table.rows).toEqual([['k0', 7]])
  })

  it('REFUSES two candidates the declaration does not single out — naming them', async () => {
    // Ambiguity is an error, not a guess at which member was meant (INV-2). Both branches:
    // no declared list at all, and a declared list that covers neither candidate.
    await expect(
      readTable('t', OPAQUE, { store: blob({ one: { a: [1] }, two: { b: [2] } }) }),
    ).rejects.toThrow(/2 candidate column maps \("one", "two"\)/)
    await expect(
      readTable('t', OPAQUE, {
        store: blob({ columns: ['absent'], one: { a: [1] }, two: { b: [2] } }),
      }),
    ).rejects.toThrow(/does not single one out/)
  })

  // ── THIS TEST USED TO ASSERT THE OPPOSITE, AND THE OPPOSITE WAS THE DEFECT ────────────────
  //
  // It read: "pads a RAGGED blob to one row count rather than emitting ragged rows", and
  // asserted `[[1,'x'],[2,null],[3,null]]`. Ragged rows are indeed wrong — but so is padding,
  // and the choice between them was false. A blob whose arrays disagree about length is not a
  // table with gaps, it is a DOCUMENT: measured on a real producer's output, the padding turned
  // one candidate into two rows, one of them blank, and dropped the discriminator that said
  // which artifact it was. A form bound to it rendered a phantom row and passed every gate.
  //
  // So the padding is gone rather than renamed, and the refusal is asserted in its place. The
  // green test that pinned the old behaviour is exactly how the defect survived this long.
  it('REFUSES a RAGGED blob — padding to max(len) invents rows that were never produced', async () => {
    await expect(readTable('t', OPAQUE, { store: blob({ a: [1, 2, 3], b: ['x'] }) })).rejects.toThrow(
      /JSON DOCUMENT, not a columnar table/,
    )
  })

  it('REFUSES a blob carrying members that are not columns, naming them', async () => {
    // The other half of the same rule: a key whose value is not an array has no column to be,
    // so a table read of it would silently drop it.
    await expect(
      readTable('t', OPAQUE, { store: blob({ kind: 'report', a: [1], b: [2] }) }),
    ).rejects.toThrow(/`kind` is not an array/)
  })

  it('REFUSES bytes with no columnar data — an empty table is not an empty result', async () => {
    await expect(readTable('t', OPAQUE, { store: blob({ n_entities: 0 }) })).rejects.toThrow(
      // Same refusal, now with the reason named: a lone scalar member is a document, and the
      // table read says so instead of reporting an absence of columns it could have padded.
      /JSON DOCUMENT, not a columnar table/,
    )
    await expect(readTable('t', OPAQUE, { store: blob([1, 2, 3]) })).rejects.toThrow(/not a JSON object/)
    await expect(
      readTable('t', OPAQUE, { store: memoryStore(new Map([['', new TextEncoder().encode('not json')]])) }),
    ).rejects.toThrow(/not parseable as JSON/)
  })

  it('REFUSES a declared NON-JSON media type, naming it', async () => {
    // The negative control for the arm: it must not try to parse arbitrary bytes as a table
    // just because the artifact is `opaque`.
    const png = parseStructure('img', { encoding: 'opaque', media_type: 'image/png' })
    await expect(readTable('img', png, { store: blob({ a: [1] }) })).rejects.toThrow(
      /declares media type "image\/png"/,
    )
  })

  it('an UNdeclared media type is not an error (server-authored + seeded rows omit it)', async () => {
    const bare = parseStructure('t', { encoding: 'opaque', origin: 'seed' })
    const table = await readTable('t', bare, { store: blob({ frame: { key: ['k0'] } }) })
    expect(table.columns).toEqual(['key'])
  })

  it('reports each column through `onColumn`, as the Zarr arm does', async () => {
    const seen: string[] = []
    await readTable('t', OPAQUE, {
      store: blob({ columns: ['a', 'b'], frame: { a: [1], b: [2] } }),
      onColumn: name => seen.push(name),
    })
    expect(seen).toEqual(['a', 'b'])
  })
})

// ── H3 — a split-string member is an ABSENCE of declared levels, not a failure ──────────────────
//
// WHAT THIS DOES WHEN THE DEFECT IS PRESENT: `readDeclaredLevels` opened the member as an ARRAY, and
// a `kind: "string"` column is written as a GROUP (`offsets` + `values` under it), so the open threw
// `node_type "group", expected "array"`. No fixture-backed test called it on the `str` member —
// every caller in the suite passed a numeric or categorical path — while the SHIPPING producer
// stamps such a column's catalog `meta.kind` as `categorical` (`cyto_columns.py` routes every
// object-dtype Series through `Table.string()`), so the categorical path reaches it in the field.
// The rejection then escaped `Promise.all` in the streaming source's `#buildCatalog` and was cached,
// taking the whole project's streaming canvas down until reload.
describe('readDeclaredLevels — a group member answers "none", it does not throw', () => {
  it('a split-string member has no declared level set', async () => {
    // Non-vacuity first: the same call on the CATEGORICAL member of the same fixture returns a real
    // set — so `undefined` below means "this member declares none", not "this function answers
    // undefined for everything".
    const declared = await readDeclaredLevels('table', 'cat8', { store: tableStore() })
    expect(declared, 'the fixture categorical declares no levels — the guard is not under test').
      toBeDefined()
    expect(declared!.length).toBeGreaterThan(0)

    await expect(readDeclaredLevels('table', 'str', { store: tableStore() })).resolves.toBeUndefined()
  })

  it('a member that is genuinely MISSING still fails — the catch is narrow', async () => {
    // The fix catches `ZarrNotAnArrayError` and only that. Swallowing every failure here would turn
    // a 404 or a malformed member into "declares no levels", i.e. into a silently level-less
    // categorical, which is the failure this reader exists to make loud.
    await expect(
      readDeclaredLevels('table', 'no_such_member', { store: tableStore() }),
    ).rejects.toThrow()
  })
})

// ── THE MEMBER INDEX BODY IS ADDRESSED BY ITS MEMBERSHIP ENTRY (ITEM-3) ─────────────────────
//
// `cyto_zarr.Table.close()` writes the index body through `write_array` and DECLARES it on the
// membership entry that owns it — never in `columns`/`arrays`, because "its length is the member
// COUNT, its values are positions into a DIFFERENT sequence (the axis), and offering it in the
// column picker would offer the row numbers as a thing to colour by".
//
// The reader resolved it with `resolveMember`, which searches exactly `columns` + `arrays`. So
// every gather over an artifact the WRITER actually emits failed with "has no member" — the two
// halves of one contract disagreeing, with both sides' unit tests green because each side's
// fixture agreed with itself. The e2e tier is what caught it, and this is the class.
describe('readMemberIndex — the body a MEMBERSHIP ENTRY declares (ITEM-3)', () => {
  const MEMBERS = [0, 5, 10, 15]
  const body = (name: string) => {
    const buf = Uint32Array.from(MEMBERS).buffer
    return {
      [`${name}/zarr.json`]: new TextEncoder().encode(
        JSON.stringify({
          zarr_format: 3,
          node_type: 'array',
          shape: [MEMBERS.length],
          data_type: 'uint32',
          chunk_grid: { name: 'regular', configuration: { chunk_shape: [MEMBERS.length] } },
          chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
          fill_value: 0,
          codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
          attributes: {},
        }),
      ),
      [`${name}/c/0`]: new Uint8Array(buf),
    }
  }

  /** The PRODUCER's shape: the coordinate's own member (`layout`) is the table's only
   *  declared one, and the index body is named + addressed on the entry beside it. */
  const PRODUCER_STRUCTURE = {
    encoding: 'zarr_v3',
    kind: 'table',
    n: MEMBERS.length,
    columns: [],
    arrays: [{ path: 'layout', kind: 'numeric', dtype: 'float32', shape: [MEMBERS.length, 2] }],
    memberships: [
      { aligned_to: 'd'.repeat(16), kind: 'subset', n_members: MEMBERS.length, members: 'membership_index', path: 'membership_index' },
    ],
  }

  it('resolves a body that is declared ONLY on the membership entry', async () => {
    const store = memoryStore(new Map(Object.entries({ ...body('membership_index'), ...rawColumn('layout', 'float64', [0, 0, 0, 0]) })))
    const out = await readMemberIndex('coord', parseStructure('coord', PRODUCER_STRUCTURE), 'membership_index', { store })
    expect(Array.from(out)).toEqual(MEMBERS)
  })

  it('NEGATIVE CONTROL — `resolveMember` alone cannot see it', () => {
    // The reason the read failed, stated as its own fact: this is what the previous
    // implementation asked, and the answer is a refusal. If a later change ever makes the
    // producer list the body among its columns, THIS line goes red and the fallback below can
    // be reconsidered deliberately rather than by accident.
    expect(() =>
      resolveMember('coord', parseStructure('coord', PRODUCER_STRUCTURE) as never, 'membership_index'),
    ).toThrow(UnsupportedArtifactStructure)
  })

  it('still resolves a body that IS declared as an ordinary member', async () => {
    // The fallback, so a fixture or a future writer that does declare it as a member is read
    // rather than refused — "consult the entry first" must not become "consult only the entry".
    const store = memoryStore(new Map(Object.entries(body('idx'))))
    const structure = parseStructure('coord', {
      encoding: 'zarr_v3',
      kind: 'table',
      columns: [{ path: 'idx', kind: 'numeric', dtype: 'uint32', shape: [MEMBERS.length] }],
    })
    expect(Array.from(await readMemberIndex('coord', structure, 'idx', { store }))).toEqual(MEMBERS)
  })
})
