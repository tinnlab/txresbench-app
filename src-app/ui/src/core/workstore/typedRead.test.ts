// typedRead.test.ts — TEST-39 / TEST-40 / TEST-41 (ITEM-29 + ITEM-30).
//
// ── WHY THE TYPE LEVEL IS THE POINT ────────────────────────────────────────────────
//
// The deliverable of ITEM-29 is a SIGNATURE: `expect: 'float32'` must make the call site
// see `Float32Array` with no cast. A runtime-only assertion —
// `expect(values).toBeInstanceOf(Float32Array)` — passes unchanged if the method returns
// `any`, which is precisely the regression this item exists to prevent, and which the
// GENERATED method (`Promise<any>`, because an `application/octet-stream` response has no
// schema to type from) actually has. So every derivation claim below is asserted with
// `expectTypeOf`, and the anti-`any` claim with an explicit `IsAny` probe.
//
// Those assertions are checked by `tsc --noEmit`, which covers `src/**` — test files
// included (`tsconfig.json` `include: ["src"]`). `npm run check` runs it, so a signature
// that stops deriving fails the build, not merely a `--typecheck` pass nobody runs. The
// executed assertions run beside them, on the SAME expression, so the two levels cannot
// drift apart.
//
// ── BYTES COME FROM THE REAL WRITER ────────────────────────────────────────────────
//
// The fixtures are the ones `zarrReader.test.ts` uses: written by `packages/_lib`'s
// `cyto_zarr` (plus a handful of hand-built exotic dtypes the writer does not emit) and
// checked in. Reading them through `memoryStore` drives the EXACT decode path HTTP uses;
// TEST-41 then drives the same read over a stubbed network so the transport itself is
// exercised rather than bypassed.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { ApiClient } from '@/api-client'
import { memoryStore, resolveDataType, type ZarrStore } from './zarrReader'
import { __resetArtifactArrayCache, parseStructure, readNumericColumn } from './artifactReader'
import { WorkstoreTypeMismatch } from './typedRead'
import { decodeCounts, enableDecodeCounter, resetDecodeCounts } from './decodeCounter'
import type {
  CategoricalColumnData,
  TableData,
  ZarrStringColumn,
} from './index'
import type { ColumnKind, ReadColumnParams } from './typedRead'

// ── fixtures ────────────────────────────────────────────────────────────────────

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIXTURES = join(HERE, '__fixtures__', 'zarr')

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

const TREE = loadFixtureTree(FIXTURES)

/** The members of ONE fixture directory, re-rooted — i.e. exactly what
 *  `/artifacts/{id}/data/{*member}` serves for an artifact whose payload is that tree. */
function subtree(prefix: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  for (const [path, bytes] of TREE) {
    if (path.startsWith(`${prefix}/`)) out.set(path.slice(prefix.length + 1), bytes)
  }
  if (out.size === 0) throw new Error(`fixture "${prefix}" is empty — the fixture tree moved`)
  return out
}

const storeOf = (prefix: string): ZarrStore => memoryStore(subtree(prefix))

/** The `table` fixture's producer declaration, read from the group's own `zarr.json` —
 *  the same object an artifact row's `structure` column carries. */
const TABLE_STRUCTURE = (
  JSON.parse(new TextDecoder().decode(TREE.get('table/zarr.json')!)) as {
    attributes: { cyto: unknown }
  }
).attributes.cyto

/** The `csc` fixture's producer declaration — `cyto_csc.write_csc_zarr`'s own output. */
const CSC_STRUCTURE = (
  JSON.parse(new TextDecoder().decode(TREE.get('csc/zarr.json')!)) as {
    attributes: { cyto: unknown }
  }
).attributes.cyto

/** A store that records every request, so "the mismatch fires before any DATA byte" is
 *  asserted on the request log rather than assumed. */
function loggingStore(inner: ZarrStore): { store: ZarrStore; paths: string[] } {
  const paths: string[] = []
  return {
    paths,
    store: {
      get(path) {
        paths.push(path)
        return inner.get(path)
      },
      getRange(path, start, length) {
        paths.push(path)
        return inner.getRange(path, start, length)
      },
      getSuffix(path, length) {
        paths.push(path)
        return inner.getSuffix(path, length)
      },
    },
  }
}

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-39 — the return type is DERIVED from the `expect` literal
// ══════════════════════════════════════════════════════════════════════════════════

/** The type a CALL SITE receives for `readColumn({expect: K})`, read off the ACTUAL
 *  method on `ApiClient` rather than off `ColumnFor` directly.
 *
 *  That distinction is the whole assertion: a battery over `ColumnFor<'numeric'>` alone
 *  would stay green if `readColumn`'s signature ignored `expect` entirely (or returned
 *  `any`). Going through the method type means the mapping AND its wiring into the client
 *  are both under test. */
type ColumnCallSite<K extends ColumnKind> = Awaited<
  ReturnType<typeof ApiClient.Workstore.readColumn<K>>
>

/** Compile-time proof that the params type is the one the client method takes — the alias
 *  above instantiates it, so a signature that stopped accepting it would fail here rather
 *  than silently resolving to `never`. */
type _ParamsAreWired = [ReadColumnParams<'numeric'>]

/** `true` only for `any` — the one type that makes every assertion below vacuous. */
type IsAny<T> = 0 extends 1 & T ? true : false

describe('TEST-39 (ITEM-29) — the return type is DERIVED from the `expect` literal', () => {
  it('every logical column kind derives its declared shape (type level)', () => {
    expectTypeOf<ColumnCallSite<'numeric'>>().toEqualTypeOf<Float32Array>()
    expectTypeOf<ColumnCallSite<'categorical'>>().toEqualTypeOf<CategoricalColumnData>()
    expectTypeOf<ColumnCallSite<'string'>>().toEqualTypeOf<ZarrStringColumn>()
    expectTypeOf<ColumnCallSite<'table'>>().toEqualTypeOf<TableData>()

    // `expect: 'string'` yields the LAZY accessor, NOT a materialized `string[]`
    // (ITEM-32). Asserted as a type, because the whole point is that the expensive path
    // is not what a caller reaches for by default — and a `string[]` return would make it
    // exactly that, silently, with every runtime value still correct.
    expectTypeOf<ColumnCallSite<'string'>>().not.toEqualTypeOf<string[]>()
    expectTypeOf<ColumnCallSite<'numeric'>>().not.toEqualTypeOf<Float64Array>()
    expectTypeOf<IsAny<ColumnCallSite<'categorical'>>>().toEqualTypeOf<false>()
  })

  it('the two GENERATED byte reads are Uint8Array, not the codegen `any`', () => {
    // `application/octet-stream` has no schema, so codegen emits `Promise<any>` for both
    // — and an `any` at a call site disables checking on everything downstream of it.
    // The override retypes them; these two probes are what would catch a revert.
    type Bytes = Awaited<ReturnType<typeof ApiClient.Workstore.getArtifactData>>
    type MemberBytes = Awaited<ReturnType<typeof ApiClient.Workstore.getArtifactDataMember>>
    expectTypeOf<Bytes>().toEqualTypeOf<Uint8Array>()
    expectTypeOf<MemberBytes>().toEqualTypeOf<Uint8Array>()
    expectTypeOf<IsAny<Bytes>>().toEqualTypeOf<false>()
    expectTypeOf<IsAny<MemberBytes>>().toEqualTypeOf<false>()
  })

  it('the deleted dtype-keyed entry point is GONE from the client surface', () => {
    // `readArray` had no production caller (`typedRead.ts`'s accounting block enumerates
    // every read path in the app), so it was deleted rather than kept as a public typed
    // surface nothing reaches. This is what would catch it being re-added without one.
    expect('readArray' in ApiClient.Workstore).toBe(false)
    // …and the reader's dtype coverage is what survived, unaffected: `resolveDataType` is
    // called from `ZarrArray`'s constructor, so every read below resolves the full v3 core
    // set — including ITEM-31's three, which have no producer in the tree but do decode.
    expect(resolveDataType('complex64').itemSize).toBe(8)
    expect(resolveDataType('complex128').itemSize).toBe(16)
    expect(resolveDataType('r24').itemSize).toBe(3)
    expect(resolveDataType('float16').itemSize).toBe(2)
  })

  it('every OTHER generated method is carried through untouched', () => {
    // The override is an `Omit` + intersection over exactly three methods. If it had
    // replaced the namespace wholesale, or dropped a namespace on the spread, this is
    // what would fail — and nothing else in the app would compile either.
    expectTypeOf<Awaited<ReturnType<typeof ApiClient.Workstore.getArtifact>>>().toExtend<{
      id: string
      content_hash: string
      structure: unknown
    }>()
    expect(typeof ApiClient.Workstore.listArtifacts).toBe('function')
    expect(typeof ApiClient.Auth.me).toBe('function')
  })

  // ── the same claims, EXECUTED against real fixture bytes ──────────────────────
  //
  // `expectTypeOf` on the value the read returned: one expression carrying both levels,
  // so the type assertion cannot drift away from what the code does.

  it('expect: "numeric" → Float32Array', async () => {
    const values = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'numeric',
      member: 'f32col',
      structure: TABLE_STRUCTURE,
      store: storeOf('table'),
    })
    expectTypeOf(values).toEqualTypeOf<Float32Array>()
    expect(values).toBeInstanceOf(Float32Array)
    expect(values.length).toBe(500)
  })

  it('expect: "categorical" → {codes, categories}', async () => {
    const column = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'categorical',
      member: 'cat8',
      structure: TABLE_STRUCTURE,
      store: storeOf('table'),
    })
    expectTypeOf(column).toEqualTypeOf<CategoricalColumnData>()
    expectTypeOf(column.codes).toEqualTypeOf<Uint32Array>()
    expectTypeOf(column.categories).toEqualTypeOf<string[]>()
    expect(column.codes.length).toBe(500)
    // The DECLARED level set survives, including a level that never occurs.
    expect(column.categories).toContain('NEVER-OBSERVED')
  })

  it('expect: "string" → the LAZY accessor, never a materialized string[]', async () => {
    const column = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'string',
      member: 'str',
      structure: TABLE_STRUCTURE,
      store: storeOf('table'),
    })
    expectTypeOf(column).toEqualTypeOf<ZarrStringColumn>()
    expect(Array.isArray(column)).toBe(false)
    // The length is DECLARED, so it is known before a byte of data is fetched — which is
    // what lets a virtualized list size itself and then pull only the window it paints.
    expect(column.length).toBe(500)
    expect(await column.at(1)).toBe('naïve')
    expect(await column.slice(0, 3)).toEqual(['ROW-000123-a', 'naïve', '日本語テスト'])
    // …and the eager path is still one explicit call away.
    expect((await column.readAll()).length).toBe(500)
  })

  it('the lazy accessor keeps the reader\'s chunk cache — a repeat window is free', async () => {
    // Artifacts are immutable, so a decoded chunk is valid for the process lifetime. The
    // accessor holds its `ZarrArray` handles, and those hold the byte-budgeted LRU — so
    // the wrapper must not re-open the member per call, which would silently turn a
    // virtualized list's scroll into a re-fetch per frame.
    const logged = loggingStore(storeOf('table'))
    const column = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'string',
      member: 'str',
      structure: TABLE_STRUCTURE,
      store: logged.store,
    })
    await column.slice(0, 3)
    const afterFirst = logged.paths.length
    expect(afterFirst).toBeGreaterThan(0)
    await column.slice(0, 3)
    expect(logged.paths.length, 'the second identical window touched the network').toBe(afterFirst)
  })

  it('a member whose structure omits `kind` falls back to the array declaration', async () => {
    // Both places the design says the declaration lives are consulted: the structure's
    // `kind`, then the array's own `attributes.cyto.kind`. Neither is inferred from the
    // dtype — a `uint16` array is not a categorical because its values happen to be small.
    const declaration = JSON.parse(JSON.stringify(TABLE_STRUCTURE)) as {
      columns: { path: string; kind?: string }[]
    }
    const stripped = declaration.columns.find(c => c.path === 'f32col')!
    delete stripped.kind

    const values = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'numeric',
      member: 'f32col',
      structure: declaration,
      store: storeOf('table'),
    })
    expect(values.length).toBe(500)

    // …and the fallback still DISAGREES when it should: the array declares `numeric`.
    await expect(
      ApiClient.Workstore.readColumn({
        id: 'fx',
        expect: 'categorical',
        member: 'f32col',
        structure: declaration,
        store: storeOf('table'),
      }),
    ).rejects.toThrow(/expects kind "categorical".*declares "numeric"/s)
  })

  it('expect: "table" → {columns, rows}', async () => {
    const table = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'table',
      structure: TABLE_STRUCTURE,
      store: storeOf('table'),
    })
    expectTypeOf(table).toEqualTypeOf<TableData>()
    expect(table.columns).toEqual(['f32col', 'cat8', 'cat16', 'str'])
    expect(table.rows.length).toBe(500)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-40 — a declared/actual mismatch THROWS, naming both, unconditionally
// ══════════════════════════════════════════════════════════════════════════════════

/** Strip comments before a source scan. Prose legitimately NAMES the things a guard
 *  denies (this file and `typedRead.ts` both discuss env gating and raw fetches at
 *  length), so scanning raw text would make every guard below fail on its own
 *  documentation. Approximate but adequate: block comments, plus `//` line comments that
 *  are not the `://` of a URL. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const readSource = (file: string): string => readFileSync(join(HERE, file), 'utf8')

describe('TEST-40 (ITEM-29) — a declared/actual mismatch throws, naming both', () => {
  it('it fires BEFORE any data byte is read', async () => {
    const logged = loggingStore(storeOf('table'))
    await expect(
      ApiClient.Workstore.readColumn({
        id: 'fx',
        expect: 'numeric',
        member: 'cat8',
        structure: TABLE_STRUCTURE,
        store: logged.store,
      }),
    ).rejects.toBeInstanceOf(WorkstoreTypeMismatch)
    // The declaration came off the `structure` the caller already held, so NOTHING was
    // requested. A check placed after the read would still throw — and would still have
    // paid for (and mis-decoded) the whole column first.
    expect(logged.paths).toEqual([])
  })

  it('a wrong logical kind names the expected AND the actual kind', async () => {
    const failure = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'numeric',
      member: 'cat8',
      structure: TABLE_STRUCTURE,
      store: storeOf('table'),
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(WorkstoreTypeMismatch)
    const mismatch = failure as WorkstoreTypeMismatch
    expect(mismatch.expected).toBe('numeric')
    expect(mismatch.actual).toBe('categorical')
    expect(mismatch.vocabulary).toBe('kind')
    expect(mismatch.message).toContain('numeric')
    expect(mismatch.message).toContain('categorical')
    expect(mismatch.message).toContain('cat8')
  })

  it('a string column asked for as numeric is refused too', async () => {
    await expect(
      ApiClient.Workstore.readColumn({
        id: 'fx',
        expect: 'numeric',
        member: 'str',
        structure: TABLE_STRUCTURE,
        store: storeOf('table'),
      }),
    ).rejects.toThrow(/expects kind "numeric".*declares "string"/s)
  })

  it('`expect: "table"` against a non-table artifact names what it actually is', async () => {
    // The declaration is the PRODUCER's, read off the CSC fixture's own group node — the
    // vocabulary `cyto_csc.write_csc_zarr` actually emits. A matrix and a table share
    // `encoding: "zarr_v3"`, so this mismatch can only be detected on the `kind`, and a
    // reader reporting "table" for the encoding would satisfy the expectation and then
    // decode a table with no columns.
    await expect(
      ApiClient.Workstore.readColumn({
        id: 'fx',
        expect: 'table',
        structure: CSC_STRUCTURE,
        store: storeOf('csc'),
      }),
    ).rejects.toThrow(/expects kind "table".*declares "sparse_csc"/s)
  })

  // ── the opaque TABLE arm ───────────────────────────────────────────────────────
  //
  // `readTable` decodes TWO encodings, because two producers write a table: a `zarr_v3`
  // group, and an `opaque` JSON-columnar blob (`cyto_columns.opaque("application/json")` —
  // which is what several of the shipping processors emit for a per-entity column table).
  // This arm used to report the ENCODING as the actual kind, so `expect: 'table'` REFUSED
  // every one of them: the typed surface rejecting a table the reader beneath it reads, and
  // a test asserting that refusal was correct. The pair below is the class that was
  // missing — the JSON blob READS, and the non-JSON blob is still refused.

  it('`expect: "table"` READS an opaque JSON-columnar table (the shipped producers\' encoding)', async () => {
    const blob = (payload: unknown): ZarrStore =>
      memoryStore(new Map([['', new TextEncoder().encode(JSON.stringify(payload))]]))

    const rowOriented = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'table',
      structure: { encoding: 'opaque', media_type: 'application/json' },
      store: blob({ columns: ['a', 'b'], rows: [[1, 'x'], [2, 'y']] }),
    })
    expectTypeOf(rowOriented).toEqualTypeOf<TableData>()
    expect(rowOriented.columns).toEqual(['a', 'b'])
    expect(rowOriented.rows).toEqual([[1, 'x'], [2, 'y']])

    // …and with NO declared media type, which is how the server-authored rows and the e2e
    // seed spell `opaque`. `readJsonTable` accepts it (the JSON parse is itself the check),
    // so refusing it here would have been the same defect in a second spelling.
    const undeclared = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'table',
      structure: { encoding: 'opaque' },
      store: blob({ a: [1, 2, 3] }),
    })
    expect(undeclared.columns).toEqual(['a'])
    expect(undeclared.rows.length).toBe(3)
  })

  it('`expect: "table"` against an opaque blob that is NOT JSON names its MEDIA TYPE', async () => {
    // The refusal that must SURVIVE the fix above: `application/x-hdf5` and `text/html` are
    // both real opaque outputs in this tree and neither is a table. Named with the media
    // type, because a bare "opaque" no longer separates this from the accepted case.
    const { store, paths } = loggingStore(storeOf('table'))
    await expect(
      ApiClient.Workstore.readColumn({
        id: 'fx',
        expect: 'table',
        structure: { encoding: 'opaque', media_type: 'application/x-hdf5' },
        store,
      }),
    ).rejects.toThrow(/expects kind "table".*declares "opaque\(application\/x-hdf5\)"/s)
    expect(paths, 'the refusal fired before any byte was requested').toEqual([])
  })

  it('the MATCHING case is not merely tolerated — it reads (negative control)', async () => {
    // Without this, a check that threw on EVERY read would pass every assertion above.
    const column = await ApiClient.Workstore.readColumn({
      id: 'fx',
      expect: 'categorical',
      member: 'cat8',
      structure: TABLE_STRUCTURE,
      store: storeOf('table'),
    })
    expect(column.codes.length).toBe(500)
  })

  it('runs UNCONDITIONALLY — the module gates it on no flag at all', () => {
    // The runtime assertions above already ran with no flag set (vitest sets none of
    // these, and the reader consults none). This is the un-gameable half: the module
    // source, comments stripped, must contain no environment/build gate whatsoever —
    // so the check cannot LATER be wrapped in one without failing here.
    //
    // Needles are assembled rather than written literally, because this file is itself
    // prose about env gating and would otherwise be describing what it forbids.
    const env = ['import', 'meta', 'env'].join('.')
    const gates = [env, ['process', 'env'].join('.'), 'NODE_ENV', 'debug_assertions']
    const source = stripComments(readSource('typedRead.ts'))
    expect(source.length, 'the stripper left a real module behind').toBeGreaterThan(2000)
    expect(gates.filter(gate => source.includes(gate))).toEqual([])
    // Anti-vacuity: the stripper does not simply delete everything it is shown, and the
    // `includes` check does fire when the needle IS present.
    expect(source).toContain('WorkstoreTypeMismatch')
    expect(stripComments(`const a = 1 // ${env}\n/* ${env} */\nconst b = ${env}`)).toContain(env)
  })
})

// ══════════════════════════════════════════════════════════════════════════════════
// TEST-41 — byte requests go through the GENERATED ApiClient method
// ══════════════════════════════════════════════════════════════════════════════════

interface HttpCall {
  url: string
  auth: string | null
  rangeHeader: string | null
  rangeParam: string | null
  status: number
}

/** Serve a fixture subtree over a stubbed `fetch`, recording every request.
 *
 *  ONLY the network is stubbed: the read runs through `artifactStore` → `binaryClient` →
 *  `ApiClient.Workstore.getArtifactDataMember` → the framework transport, so the bearer
 *  token, the base URL and the `?range=` parameter are all applied by the code under
 *  test. Injecting a fake store instead (as every test above does, deliberately) skips
 *  exactly the layer this one is about. */
function stubHttp(prefix: string, row?: unknown): HttpCall[] {
  const members = subtree(prefix)
  const calls: HttpCall[] = []
  vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3155' } })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) =>
      key === 'auth-storage' ? JSON.stringify({ state: { token: 'test-token' } }) : null,
  })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const parsed = new URL(String(url))
    const headers = new Headers(init?.headers)
    const call: HttpCall = {
      url: String(url),
      auth: headers.get('Authorization'),
      rangeHeader: headers.get('Range'),
      rangeParam: parsed.searchParams.get('range'),
      status: 200,
    }
    // The CONTROL plane: `GET /api/artifacts/{id}` (the artifact row, JSON). `readColumn`
    // reaches it when the caller did not already hold the producer's `structure`.
    if (!parsed.pathname.includes('/data/')) {
      calls.push(call)
      return new Response(JSON.stringify(row ?? {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const all = members.get(parsed.pathname.split('/data/')[1] ?? '')
    if (!all) {
      call.status = 404
      calls.push(call)
      return new Response(null, { status: 404 })
    }
    let body = all
    if (call.rangeParam) {
      const suffix = /^-(\d+)$/.exec(call.rangeParam)
      const window = /^(\d+)-(\d+)$/.exec(call.rangeParam)
      if (suffix) body = all.subarray(Math.max(0, all.length - Number(suffix[1])))
      else if (window) body = all.subarray(Number(window[1]), Number(window[2]) + 1)
      else {
        call.status = 400
        calls.push(call)
        return new Response(null, { status: 400 })
      }
    }
    calls.push(call)
    // ITEM-36: always 200. The URL names the exact bytes, so a ranged read is a COMPLETE
    // response for that URL — which is what makes it an ordinary cacheable GET.
    return new Response(body.slice() as unknown as BodyInit, { status: 200 })
  })
  return calls
}

/** Modules whose transport this test governs. Test files are exempt: a suite that stubs
 *  the network necessarily names `fetch`, and including them would pressure someone into
 *  weakening a test to satisfy a guard. */
function productionModules(): string[] {
  return readdirSync(HERE)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
}

describe('TEST-41 (ITEM-30) — byte requests go through the generated ApiClient method', () => {
  // Opened member arrays are cached PROCESS-WIDE by artifact id, so a suite that asserts on
  // the requests a read makes must start each case from cold — otherwise a case reusing an
  // artifact id would be served from the previous case's decoded chunks and see none.
  afterEach(() => {
    vi.unstubAllGlobals()
    __resetArtifactArrayCache()
  })

  it('auth, base URL and range are all applied by ONE path', async () => {
    const calls = stubHttp('table')
    const values = await ApiClient.Workstore.readColumn({
      id: 'art-1',
      expect: 'numeric',
      member: 'f32col',
      structure: TABLE_STRUCTURE,
    })
    expect(values.length).toBe(500)

    expect(calls.length, 'the read actually crossed the stubbed network').toBeGreaterThan(0)
    // Every request: same origin, the artifact's own `/data` tree, bearer token attached.
    // None of those three is constructed anywhere under `core/workstore/` any more.
    for (const call of calls) {
      expect(call.url.startsWith('http://127.0.0.1:3155/api/artifacts/art-1/data/')).toBe(true)
      expect(call.auth).toBe('Bearer test-token')
      // ITEM-36: the range is a QUERY PARAM. A `Range:` header would yield a 206, which
      // browsers cache inconsistently and most CDNs refuse to store.
      expect(call.rangeHeader).toBeNull()
    }
    expect(calls[0].url).toContain('/data/f32col/zarr.json')
    // ── RESTATED for ITEM-18 (this is the restatement ITEM-23 requires) ──────────────
    //
    // This used to assert `calls.every(c => c.rangeParam === null)` — a full sharded read
    // carries NO range at all, because the shard came whole and the footer index came
    // free inside it. ITEM-18 makes that false BY DESIGN: the index is now read FIRST via
    // a suffix range so the body can be streamed and each inner chunk released as its
    // span arrives. Left as it was, this would have blocked the fix; relaxed to "some
    // calls have ranges", it would have stopped protecting anything.
    //
    // So it is restated to pin the property that was actually at risk — the request-count
    // win. A full sharded read costs, per shard, exactly ONE un-ranged body request and
    // ONE `-N` suffix index request, and ZERO per-chunk window ranges. That last clause
    // is the 2,749→1 win ITEM-33 bought; if the streaming path ever regressed into
    // per-chunk ranges, this goes red.
    expect(calls.length).toBeGreaterThan(1)
    const ranged = calls.filter(c => c.rangeParam !== null)
    // NON-VACUITY (T1). Everything below this line is a "no bad calls" shape: filters over
    // `ranged` and a `for` over its URLs. If `ranged` were empty — because the streaming
    // shard path regressed to a whole-shard fetch that never issues the suffix index read,
    // or because the recording stopped seeing ranged calls at all — `windowed` would be `[]`,
    // the `for` body would run zero times, and the whole block would pass while measuring
    // NOTHING. So pin the count first: a full sharded read issues exactly ONE suffix index
    // read per shard body, so the two counts must match, and both must be non-zero.
    // WHEN THE DEFECT IS PRESENT (no suffix index reads issued) this goes red at 0 !== 4
    // instead of silently green.
    const shardBodies = calls.filter(c => c.rangeParam === null && !c.url.includes('zarr.json'))
    expect(shardBodies.length, 'the read actually pulled shard bodies').toBeGreaterThan(0)
    expect(
      ranged.length,
      'exactly ONE suffix index read per shard body — if this is 0 the assertions below ' +
        'this line are vacuous and pin nothing',
    ).toBe(shardBodies.length)
    const windowed = ranged.filter(c => !String(c.rangeParam).startsWith('-'))
    expect(
      windowed.map(c => c.rangeParam),
      'a FULL sharded read must issue ZERO per-chunk window ranges — that is the ' +
        'request-count win, and it is the thing not to trade away for progressiveness',
    ).toEqual([])
    // Every range that IS issued is the fixed-size suffix index read, at most one per
    // shard path — never two, which would mean the index cache stopped working.
    for (const path of new Set(ranged.map(c => c.url))) {
      expect(ranged.filter(c => c.url === path)).toHaveLength(1)
    }
    // …and the bodies are still un-ranged whole-shard reads.
    expect(calls.filter(c => c.rangeParam === null).length).toBeGreaterThan(1)
  })

  it('both range spellings ride as `?range=`', async () => {
    const calls = stubHttp('table')
    // A WINDOWED read is what produces ranges, and the lazy string accessor is the typed
    // surface's window: `slice(0, 3)` of a 500-row column cannot want a whole shard, so the
    // reader locates the shard index with a SUFFIX range and then pulls the covering inner
    // chunks with window ranges — exercising both spellings the endpoint accepts.
    const column = await ApiClient.Workstore.readColumn({
      id: 'art-2',
      expect: 'string',
      member: 'str',
      structure: TABLE_STRUCTURE,
    })
    expect(await column.slice(0, 3)).toEqual(['ROW-000123-a', 'naïve', '日本語テスト'])
    const params = calls.map(c => c.rangeParam).filter((r): r is string => r !== null)
    expect(params.some(r => /^-\d+$/.test(r)), 'a suffix range').toBe(true)
    expect(params.some(r => /^\d+-\d+$/.test(r)), 'a window range').toBe(true)
    expect(params.every(r => /^(-\d+|\d+-\d+)$/.test(r))).toBe(true)
  })

  it('no module under core/workstore builds its own transport', () => {
    // The three primitives a hand-rolled transport needs. Two copies of them used to live
    // here (`binaryClient.ts` and `zarrReader.ts`), which is how the silent 401-refresh
    // and the retry in `callAsync` reached neither.
    const needles = [`${'fet'}${'ch'}(`, ['get', 'AuthToken'].join(''), ['get', 'BaseUrl'].join('')]
    const files = productionModules()
    expect(files.length, 'there are modules to scan').toBeGreaterThanOrEqual(5)

    const leaks: string[] = []
    for (const file of files) {
      const source = stripComments(readSource(file))
      for (const needle of needles) {
        if (source.includes(needle)) leaks.push(`${file}: ${needle}`)
      }
    }
    expect(
      leaks,
      'ITEM-30: artifact bytes travel through the generated ApiClient method — see ' +
        'core/workstore/binaryClient.ts:\n' + leaks.join('\n'),
    ).toEqual([])

    // POSITIVE CONTROL — the scan is not a no-op regex over a set it cannot match.
    const synthetic = stripComments(`const r = await ${needles[0]}url)\n${needles[1]}()`)
    expect(needles.filter(n => synthetic.includes(n))).toEqual([needles[0], needles[1]])
  })

  // ── the WIRING is free (ITEM-29) ────────────────────────────────────────────────
  //
  // `WorkbenchDataSource.continuous()` used to call `readNumericColumn` directly and now
  // calls `readColumn({expect: 'numeric'})`. The declaration check inserted in between
  // must cost NOTHING on the wire — a prior round shipped a 3× request regression by
  // adding a layer that opened members OUTSIDE `artifactReader`'s shared `MEMBER_ARRAYS`
  // cache, and only a request-count assertion caught it. These three cases are that
  // assertion, at the unit level, over the real stubbed transport (an injected store
  // bypasses the cache entirely and so cannot see this class of regression at all).

  /** Every member path a run requested, in order — the request set to compare. */
  const memberPaths = (calls: HttpCall[]): string[] =>
    calls.map(c => c.url.split('/data/')[1] ?? c.url)

  it('the typed read issues the SAME requests as the direct reader it replaced', async () => {
    const viaTyped = stubHttp('table')
    await ApiClient.Workstore.readColumn({
      id: 'art-typed',
      expect: 'numeric',
      member: 'f32col',
      structure: TABLE_STRUCTURE,
    })
    const typed = memberPaths(viaTyped)
    vi.unstubAllGlobals()
    __resetArtifactArrayCache()

    const viaDirect = stubHttp('table')
    await readNumericColumn('art-direct', parseStructure('art-direct', TABLE_STRUCTURE), 'f32col')
    const direct = memberPaths(viaDirect)

    expect(typed.length, 'the read really crossed the stubbed network').toBeGreaterThan(0)
    expect(typed, 'the typed surface added requests the direct reader did not make').toEqual(direct)
  })

  it('…including on the FALLBACK branch, where the declaration comes off the array', async () => {
    // The branch most at risk: with no `kind` in the structure, `readColumn` consults the
    // member's own `zarr.json` to learn what it holds — and the read that follows needs the
    // SAME array. If that lookup opened its own, every declaration-checked read would pay
    // for a second open (and lose the decoded-chunk cache with it).
    const stripped = JSON.parse(JSON.stringify(TABLE_STRUCTURE)) as {
      columns: { path: string; kind?: string }[]
    }
    delete stripped.columns.find(c => c.path === 'f32col')!.kind

    const viaTyped = stubHttp('table')
    await ApiClient.Workstore.readColumn({
      id: 'art-fb',
      expect: 'numeric',
      member: 'f32col',
      structure: stripped,
    })
    const typed = memberPaths(viaTyped)
    vi.unstubAllGlobals()
    __resetArtifactArrayCache()

    const viaDirect = stubHttp('table')
    await readNumericColumn('art-fb2', parseStructure('art-fb2', stripped), 'f32col')
    const direct = memberPaths(viaDirect)

    expect(typed.filter(p => p === 'f32col/zarr.json'), 'the array was opened TWICE').toHaveLength(1)
    expect(typed).toEqual(direct)
  })

  it('a SECOND typed read of the same member costs zero requests (MEMBER_ARRAYS still shared)', async () => {
    const calls = stubHttp('table')
    const read = (): Promise<Float32Array> =>
      ApiClient.Workstore.readColumn({
        id: 'art-cache',
        expect: 'numeric',
        member: 'f32col',
        structure: TABLE_STRUCTURE,
      })
    await read()
    const afterFirst = calls.length
    expect(afterFirst, 'the first read crossed the network').toBeGreaterThan(0)
    await read()
    expect(
      calls.length,
      'the second read re-fetched — the typed surface bypassed the shared opened-array cache',
    ).toBe(afterFirst)
    // Anti-vacuity: the cache is what made the second read free, so clearing it must make a
    // third read pay again. Otherwise a stub that answered nothing would satisfy the above.
    __resetArtifactArrayCache()
    await read()
    expect(calls.length, 'the cache reset did not restore the requests').toBeGreaterThan(afterFirst)
  })

  it('the generated byte method is what the store calls (and it returns bytes)', async () => {
    const calls = stubHttp('i32_plain')
    const bytes = await ApiClient.Workstore.getArtifactDataMember({
      id: 'art-3',
      '*member': 'zarr.json',
    })
    // The transport hands back a Blob for octet-stream; the override normalizes it, so a
    // caller gets bytes without a cast and without knowing the wire shape.
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(JSON.parse(new TextDecoder().decode(bytes)).data_type).toBe('int32')
    expect(calls).toHaveLength(1)
    expect(calls[0].auth).toBe('Bearer test-token')
    expect(calls[0].rangeParam).toBeNull()
  })

  it('an omitted `structure` is RESOLVED from the artifact row, not defaulted', async () => {
    // INV-2: dispatch is on what the producer DECLARED. Omitting `structure` fetches that
    // declaration through the generated control-plane method; it never invents one — an
    // artifact whose row carries no `structure` is an error, which the second half asserts.
    const calls = stubHttp('table', { id: 'art-5', structure: TABLE_STRUCTURE })
    const values = await ApiClient.Workstore.readColumn({
      id: 'art-5',
      expect: 'numeric',
      member: 'f32col',
    })
    expect(values.length).toBe(500)
    expect(calls[0].url).toBe('http://127.0.0.1:3155/api/artifacts/art-5')
    expect(calls[0].auth).toBe('Bearer test-token')

    vi.unstubAllGlobals()
    stubHttp('table', { id: 'art-6' })
    await expect(
      ApiClient.Workstore.readColumn({ id: 'art-6', expect: 'numeric', member: 'f32col' }),
    ).rejects.toThrow(/structure is not an object/)
  })

  it('a range on the whole-artifact route rides the same path', async () => {
    const calls = stubHttp('i32_plain')
    await ApiClient.Workstore.getArtifactDataMember({
      id: 'art-4',
      '*member': 'zarr.json',
      range: '0-9',
    }).then(bytes => expect(bytes.length).toBe(10))
    expect(calls[0].rangeParam).toBe('0-9')
    expect(calls[0].rangeHeader).toBeNull()
    expect(calls[0].url).toContain('range=0-9')
  })
})

// ── TEST-15 [ITEM-11] — the decode counter counts DECODES, not requests ─────────
//
// This is the instrument every later invariant is measured with ("an encoding change fetches ONE
// column, not a reload"; "positions are decoded ONCE per coordinate however many panes"), so it
// needs its own proof. The property that makes it worth having: artifact bytes are served
// `immutable`, so a repeated read is usually invisible as a REQUEST while still paying a full
// inflate + unshuffle. A request-counting test would read 1 for both the shared case and the
// repeated one — passing while the thing it protects is broken.
describe('decode counter — the unit the streaming invariants are measured in (ITEM-11)', () => {
  it('counts one decode per chunk decoded, keyed by member', async () => {
    const stop = enableDecodeCounter()
    try {
      const store = storeOf('table')
      await ApiClient.Workstore.readColumn({ id: 'table', expect: 'table', structure: TABLE_STRUCTURE, store })
      const first = decodeCounts()
      const total = Object.values(first).reduce((a, b) => a + b, 0)
      expect(total, 'a real read decodes at least one chunk').toBeGreaterThan(0)

      // THE LOAD-BEARING LEG: read the same member again through a fresh store, so the bytes
      // are served without a second network request — exactly what `immutable` does in the
      // browser — and confirm the counter STILL moves. This is the difference between counting
      // decodes and counting requests, and it is why the counter exists.
      __resetArtifactArrayCache()
      await ApiClient.Workstore.readColumn({ id: 'table', expect: 'table', structure: TABLE_STRUCTURE, store: storeOf('table') })
      const second = Object.values(decodeCounts()).reduce((a, b) => a + b, 0)
      expect(second, 'a second decode of the same member is VISIBLE').toBe(total * 2)
    } finally {
      stop()
    }
  })

  it('records NOTHING while disabled, so production pays no unbounded map', async () => {
    resetDecodeCounts()
    __resetArtifactArrayCache()
    await ApiClient.Workstore.readColumn({ id: 'table', expect: 'table', structure: TABLE_STRUCTURE, store: storeOf('table') })
    expect(decodeCounts()).toEqual({})
  })
})
