// typedRead.ts — typed artifact reads THROUGH the generated ApiClient (ITEM-29).
//
// The caller DECLARES what it expects and the return type FOLLOWS from that literal:
//
//   ApiClient.Workstore.readColumn({ id, member, expect: 'numeric' })     → Float32Array
//   ApiClient.Workstore.readColumn({ id, member, expect: 'categorical' }) → {codes, categories}
//   ApiClient.Workstore.readColumn({ id, member, expect: 'string' })      → the LAZY accessor
//   ApiClient.Workstore.readColumn({ id, expect: 'table' })               → {columns, rows}
//   ApiClient.Workstore.readColumn({ id, expect: 'document' })            → the JSON object
//
// No cast at the call site, and no `any` anywhere on the path — the generated
// `getArtifactData*` methods are `any` (an `application/octet-stream` response has no
// JSON schema to generate from), and an `any` that reaches a call site silences every
// subsequent check. So the api-client binding replaces those two methods as well, and a
// byte read is `Promise<Uint8Array>` from the transport up.
//
// ── WHY AN OVERRIDE AND NOT CODEGEN ────────────────────────────────────────────────
//
// `ApiClient` is a mapped type that emits a NON-generic function per endpoint
// (`(params: P) => Promise<R>`), so "the output type depends on the value of an input
// field" is structurally inexpressible in the generated shape — no amount of generator
// work produces it. It is therefore an OVERRIDE: a type-level `Omit` + intersection
// replacing exactly these three methods (`api-client/index.ts`), plus a runtime wrapper
// around the generated proxy. Every other generated method is untouched.
//
// ── ONE VOCABULARY: the logical column KIND ────────────────────────────────────────
//
// `expect` is a logical `kind` — `numeric | categorical | string | table | document` — the
// PRODUCER's
// declaration of what the values MEAN. Deliberately not a dtype: `uint16` is a dtype,
// `categorical` is a meaning, and a `uint16` array is not a categorical because its
// values happen to be small (INV-2).
//
// There WAS a second entry point, `readArray`, speaking the Zarr v3 dtype set directly
// (`expect: 'float32'` → `Float32Array`, `expect: 'complex64'` → a deinterleaved `{re,
// im}` pair, `r<N>` → the raw stride). It is deleted, because it never acquired a
// production caller: every read in the app is an ARTIFACT-level read that dispatches on
// the producer's `structure`, and the four listed below are all of them. A public typed
// entry point nothing reaches is not a smaller version of something useful, it is dead
// code that each audit round has to re-triage.
//
// What that deletion did NOT remove is the READER's dtype coverage. `resolveDataType`
// (`zarrCodecs.ts`) is called from `ZarrArray`'s constructor, so every array open — every
// read below — resolves the full v3 core set including ITEM-31's `float16`, `complex64`/
// `complex128` and `r<N>`; `readComplex` / `deinterleaveComplex` / `decodeFloat16` remain
// the reader-level surface for the shapes those decode to. What is gone is only the typed
// *entry point* keyed on a dtype literal, which no producer in the tree needs today (none
// emits complex or `r<N>` at all).
//
// ── THE MISMATCH CHECK RUNS ALWAYS ─────────────────────────────────────────────────
//
// After the member's declared `kind` is read (from the `structure`, else the array's own
// `attributes.txr.kind`), the declared `expect` is compared against it and a mismatch
// THROWS, naming both. Unconditionally: not behind a dev flag, not behind an env var.
//
// Two reasons, both decisive. It is one string comparison against metadata that has
// already been fetched and parsed, so there is nothing to save by skipping it. And an
// env-gated check means production behaves differently from where it was tested, which
// is precisely where this class of bug survives: coercing a categorical member's codes
// into a `Float32Array` produces plausible wrong numbers and renders a plausible wrong
// picture, with nothing anywhere raising a hand. A loud failure at the boundary, naming
// the expected AND the actual kind, is strictly better than a quiet wrong answer three
// layers downstream.
//
// ── EVERY PRODUCTION READ PATH, AND WHICH ONES CANNOT DECLARE ───────────────────────
//
// This accounts for the WHOLE typed surface (there is one entry point, `readColumn`) and
// for every artifact read in the app. A mismatch check nothing reaches protects nothing,
// so the two paths whose expectation IS statable declare it here:
//
//   `viewData.readSliceFromApi`               → `readColumn({expect: 'table'})`
//   `WorkbenchDataSource.continuous()`        → `readColumn({expect: 'numeric'})`
//
// The second is the one that closed a live gap: `readNumericColumn` coerces whatever
// member it is handed to `Float32Array`, so a `categorical` member reaching the
// continuous channel used to render its CODES as a continuous ramp with nothing thrown
// anywhere. It now fails at the boundary, naming both kinds, before a data byte moves.
//
// THREE read paths genuinely cannot state an `expect`, and route around this module on
// purpose rather than through a token call:
//
//   `WorkbenchDataSource.positions()` — a SHAPE read, not a typed read: `(n × dims)` →
//       interleaved `[x0,y0,…]`, with the destination allocated at the member's OWN
//       declared width so a `float64` layout reads correctly instead of interleaving
//       halves of each double. `ColumnKind` has no term for it, and a per-dtype literal
//       would hard-fail every legitimately-wider producer; the interleave + `dims > 2`
//       projection would also have to be copied out of `readPositions` into the consumer.
//       It stays on `readPositions`.
//   `WorkbenchDataSource.categorical()` — a genuine UNION. The catalog surfaces both
//       `categorical` (a declared level set) and `string` (coded on read) members in that
//       channel, and `expect` takes ONE literal by construction. Resolving the member's
//       kind and then declaring it back would make the comparison `kind === kind` —
//       vacuous, which is worse than absent. It stays on `readCategoricalColumn`, the
//       permissive entry point this module's `readColumn` doc already designates for
//       exactly this caller.
//   `WorkbenchDataSource.valueColumn()` / `dataHost.readColumn` — a CSC column is three
//       members whose roles are not interchangeable (`indptr`/`indices`/`data`), read as
//       three ranges. It is not a column kind and not a single array, so the vocabulary
//       does not describe it. It stays on `readSparseColumn`.
//
// Extending `ColumnKind` to cover those would be a change to ITEM-29's stated vocabulary,
// not an implementation detail. `document` IS such a change, made deliberately: an `opaque`
// JSON blob turned out to be TWO shapes, not one, and the reader beneath was silently
// approximating one as the other (see `classifyJsonPayload`). The three paths above are
// unaffected — none of them reads a JSON blob.
//
// ── CACHING ────────────────────────────────────────────────────────────────────────
//
// Artifacts are immutable and content-addressed, so a decoded result is valid forever.
// One `ZarrArray` serves a whole read — its shard-index cache, its byte-budgeted
// decoded-chunk LRU (64 MB) and its in-flight chunk map apply across every chunk of that
// read — and, since it comes from `artifactReader`'s shared `MEMBER_ARRAYS` cache, ACROSS
// READS of the same member too: a second consumer of a member already resident pays no
// requests at all. `expect: 'string'` returns the LAZY accessor, which holds its
// `ZarrArray` handles alive: successive `.slice()` calls on one accessor reuse the same
// chunk cache rather than re-fetching.

import {
  artifactStore,
  openZarrGroupAttributes,
  type ZarrChunkSlice,
  type ZarrStore,
} from './zarrReader'
import {
  asZarrTable,
  openArtifactArray,
  openStringColumn,
  parseStructure,
  readCategoricalColumn,
  readColumnarTable,
  readJsonDocument,
  readNumericColumn,
  readTable,
  resolveMember,
  type ArtifactReadOptions,
  type ArtifactStructure,
  type CategoricalColumnData,
  type ColumnarTableData,
  type OpaqueStructure,
  type TableData,
  type ZarrMember,
} from './artifactReader'
import type { ZarrStringColumn } from './zarrReader'
import { getArtifact } from './catalog'

// ── the vocabulary: logical column kinds ────────────────────────────────────────

/** What a column MEANS, as the producer declared it. `table` is the artifact-level
 *  kind: every declared member at once, row-major.
 *
 *  `document` is the OTHER artifact-level kind, and it is a deliberate widening of ITEM-29's
 *  stated vocabulary rather than an implementation detail. An `opaque` JSON blob is not one
 *  shape: several producers write a `kind`-tagged object whose members are unrelated and of
 *  unequal length, and the columnar reader was zipping those into padded phantom rows while
 *  dropping every non-array key. The two shapes now have two names and a caller says which one
 *  it means — see `classifyJsonPayload`. */
export type ColumnKind = 'numeric' | 'categorical' | 'string' | 'table' | 'document'

/** An `opaque` JSON blob read as itself: member names to whatever the producer wrote there,
 *  at its own length, discriminator included. */
export type JsonDocument = Record<string, unknown>

/**
 * The value a declared column kind reads back as.
 *
 * `string` yields the LAZY accessor, never a `string[]`. Measured at 10M × 18 chars, the
 * eager form is 979 ms and 580 MB of heap against 0.08 ms for the 100 rows a table
 * actually shows (ITEM-32) — so the expensive path must not be the one a caller reaches
 * for by default. It is still one call away: `(await readColumn({expect:'string'})).readAll()`.
 */
export type ColumnFor<K extends ColumnKind> = K extends 'numeric'
  ? Float32Array
  : K extends 'categorical'
    ? CategoricalColumnData
    : K extends 'string'
      ? ZarrStringColumn
      : K extends 'table'
        ? TableData
        : K extends 'document'
          ? JsonDocument
          : never

// ── the mismatch ────────────────────────────────────────────────────────────────

/** Spelling for "the producer declared nothing here" in a mismatch message. Absence is
 *  an error, not a case to guess through (INV-2). */
const UNDECLARED = '(undeclared)'

/**
 * The declared `expect` does not match what the artifact says it holds.
 *
 * Carries `expected` and `actual` as fields as well as in the message, so a caller can
 * branch on them without parsing prose — and names the vocabulary the two are spoken in
 * (`kind`), so a message reads as the category error it is rather than as a bare pair of
 * words. `vocabulary` was `'data_type' | 'kind'` while `readArray` existed; the
 * `'data_type'` arm went with it rather than being left as an unconstructible variant.
 */
export class WorkstoreTypeMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly where: string,
    readonly vocabulary: 'kind',
  ) {
    super(
      `${where}: the read expects ${vocabulary} "${expected}" but the artifact declares "${actual}" — ` +
        'a typed read never decodes bytes as a type it was not told to expect',
    )
    this.name = 'WorkstoreTypeMismatch'
  }
}

function requireMatch(
  expected: string,
  actual: string | undefined,
  where: string,
  vocabulary: 'kind',
): void {
  if (actual === expected) return
  throw new WorkstoreTypeMismatch(expected, actual ?? UNDECLARED, where, vocabulary)
}

function where(id: string, member?: string): string {
  return `artifact ${id}${member ? ` member "${member}"` : ''}`
}

// ── readColumnarTable (ITEM-24) ─────────────────────────────────────────────────

/**
 * A whole table as `{ column: values[] }`, with the SAME declared-kind check `readColumn`'s
 * `expect: 'table'` arm performs (ITEM-24).
 *
 * Exists because every declarative consumer of `expect: 'table'` immediately transposed the
 * row-major result back to columnar. Same decode, same errors, same per-column value type — it
 * simply never builds the intermediate. Prefer it over `readColumn({expect:'table'})` wherever
 * the caller wants columns; the row-major reader stays for the table RENDERERS, which want rows.
 */
export async function readColumnarTableChecked(
  params: Omit<ReadColumnParams<'table'>, 'expect' | 'member'>,
): Promise<ColumnarTableData> {
  const { id, onChunk, store } = params
  const declared = params.structure ?? (await getArtifact(id)).structure
  const structure = parseStructure(id, declared)
  const actual = notATable(structure)
  if (actual !== undefined) {
    throw new WorkstoreTypeMismatch('table', actual, where(id), 'kind')
  }
  return readColumnarTable(id, structure, { onChunk, store })
}

// ── readColumn ──────────────────────────────────────────────────────────────────

/** Everything a logical-column read takes. */
export interface ReadColumnParams<K extends ColumnKind> {
  /** the artifact id. */
  id: string
  /** the logical kind the caller DECLARES it expects — checked against the producer's
   *  declaration before any value is decoded. */
  expect: K
  /** which member to read. Omit when the artifact declares exactly one — legitimate and
   *  unambiguous for a one-member artifact; with two or more it is an error, not "the
   *  first". Ignored for `expect: 'table'`, which reads every declared member. */
  member?: string
  /**
   * The producer-declared `structure`, when the caller already holds the artifact row.
   * Omitted, it is RESOLVED with one `GET /artifacts/{id}` — which is obtaining the
   * declaration, not defaulting one: dispatch is on what the producer said it wrote, and
   * an artifact with no `structure` is an error at ingest (INV-2).
   */
  structure?: unknown
  /** progressive-arrival hook, forwarded to every column this read decodes. */
  onChunk?: (slice: ZarrChunkSlice) => void
  /** an injected byte store (fixtures / tests). */
  store?: ZarrStore
}

/**
 * Read a column (or a whole table) as the logical kind the caller declared.
 *
 * STRICTER than the artifact-level readers it sits on, deliberately. `readCategoricalColumn`
 * will code a `numeric` member's values as categories for a surface that asks it to; this
 * entry point will not — `expect: 'categorical'` on a member the producer declared
 * `numeric` is a mismatch and throws, because the whole contract here is that the caller
 * states what it believes and is told when it is wrong. A caller that genuinely wants the
 * permissive behaviour keeps calling `readCategoricalColumn` directly.
 */
export async function readColumn<K extends ColumnKind>(
  params: ReadColumnParams<K>,
): Promise<ColumnFor<K>> {
  const { id, expect, member, onChunk, store } = params
  const declared = params.structure ?? (await getArtifact(id)).structure
  const structure = parseStructure(id, declared)
  const options: ArtifactReadOptions = { onChunk, store }

  if (expect === 'table') {
    const actual = notATable(structure)
    if (actual !== undefined) {
      throw new WorkstoreTypeMismatch('table', actual, where(id), 'kind')
    }
    return (await readTable(id, structure, options)) as ColumnFor<K>
  }

  if (expect === 'document') {
    // Same shape of check as `table`'s, one level up: the ENCODING-level refusal (a zarr
    // artifact, a non-JSON opaque blob) is stated here with both kinds named, and the
    // CONTENT-level refusal (a JSON blob that is genuinely a columnar table) is
    // `readJsonDocument`'s. Neither is best-effort.
    const actual = notADocument(structure)
    if (actual !== undefined) {
      throw new WorkstoreTypeMismatch('document', actual, where(id), 'kind')
    }
    return (await readJsonDocument(id, structure, options)) as ColumnFor<K>
  }

  const table = asZarrTable(id, structure)
  const target = resolveMember(id, table, member)
  requireMatch(expect, await declaredKind(id, target, options), where(id, target.path), 'kind')

  switch (expect) {
    case 'numeric':
      return (await readNumericColumn(id, structure, target.path, options)) as ColumnFor<K>
    case 'categorical':
      return (await readCategoricalColumn(id, structure, target.path, options)) as ColumnFor<K>
    default:
      // `string` — the LAZY accessor (ITEM-32), never a materialized `string[]`.
      return (await openStringColumn(id, structure, target.path, options)) as ColumnFor<K>
  }
}

/**
 * What this artifact is INSTEAD of a table — or `undefined` when it IS one.
 *
 * TWO encodings are a table, because two producers write one, and `readTable` (the
 * function this arm delegates to) dispatches on exactly that pair:
 *   `zarr_v3` + `kind: "table"` — `txr_zarr.Table`, *n* arrays sharing an axis (ITEM-4).
 *   `opaque` + a JSON media type — a per-entity column table written as a JSON document
 *       (`txr_columns.opaque("application/json")`), which is what several of the shipping
 *       processors emit today for exactly that. Reporting `"opaque"` as the actual kind
 *       here made `expect: "table"` REFUSE that encoding outright — the typed surface
 *       rejecting a table the reader beneath it decodes, on every processor that writes
 *       one. An `opaque` blob with NO declared media type is accepted for the same
 *       reason `readJsonTable` accepts it (server-authored rows and the e2e seed both
 *       spell `opaque` without one, and the JSON parse is itself the check).
 *
 * What is still refused, and why the discrimination has to happen HERE:
 *   `sparse_csc` — also `encoding: "zarr_v3"`, carries no `columns`/`arrays`, so an
 *       encoding-level answer would satisfy `expect: "table"` and then decode a table
 *       with no columns.
 *   an `opaque` blob whose declared media type is NOT JSON (`text/html`,
 *       `application/x-hdf5`) — named WITH its media type, because a bare `"opaque"` no
 *       longer distinguishes the accepted case from this one.
 */
function notATable(structure: ArtifactStructure): string | undefined {
  if (structure.encoding === 'zarr_v3') {
    return structure.kind === 'table' ? undefined : structure.kind
  }
  const mediaType = (structure as OpaqueStructure).media_type
  if (mediaType === undefined) return undefined
  return typeof mediaType === 'string' && mediaType.includes('json')
    ? undefined
    : `opaque(${String(mediaType)})`
}

/**
 * What this artifact is INSTEAD of a JSON document — or `undefined` when it could be one.
 *
 * ONE encoding can be: `opaque` with a JSON media type, or with none (server-authored rows and
 * the e2e seed both spell `opaque` bare, and the JSON parse is itself the check — the same
 * reason `notATable` accepts it). A `zarr_v3` artifact is named by its own declared `kind`,
 * because "table" tells the caller what to ask for instead; a non-JSON blob is named WITH its
 * media type, for the same reason it is there.
 */
function notADocument(structure: ArtifactStructure): string | undefined {
  if (structure.encoding !== 'opaque') {
    return typeof (structure as { kind?: unknown }).kind === 'string'
      ? String((structure as { kind?: unknown }).kind)
      : structure.encoding
  }
  const mediaType = (structure as OpaqueStructure).media_type
  if (mediaType === undefined) return undefined
  return typeof mediaType === 'string' && mediaType.includes('json')
    ? undefined
    : `opaque(${String(mediaType)})`
}

/**
 * The member's DECLARED kind: the structure's `kind` when the producer put one there,
 * else the array's own `attributes.txr.kind` — the two places the design says the
 * declaration lives. `undefined` when neither carries it, which `requireMatch` reports
 * as `(undeclared)` rather than guessing from the dtype.
 *
 * The second lookup costs one `zarr.json` request and only happens on the path where the
 * structure omitted the declaration. It dispatches on `layout`, itself a declaration: a
 * `split` string column is a GROUP (an `offsets`+`values` pair), so its metadata is read
 * as group attributes — opening it as an array would fail on `node_type`.
 */
async function declaredKind(
  id: string,
  member: ZarrMember,
  options: ArtifactReadOptions,
): Promise<string | undefined> {
  if (member.kind !== undefined) return member.kind
  if (member.layout === 'split') {
    const store = options.store ?? artifactStore(id)
    return (await openZarrGroupAttributes(store, member.path))?.kind
  }
  // Through the shared opened-array cache: this reads the SAME `zarr.json` the read that
  // follows it needs, so a second open here would double every declaration-checked read.
  return (await openArtifactArray(id, member.path, options)).txr?.kind
}

// ── the shape the api-client binding splices in ─────────────────────────────────

/**
 * The two GENERATED byte-read methods, retyped.
 *
 * The generator emits `Promise<any>` for both (an `application/octet-stream` response
 * has no schema to derive a type from). `any` at a call site is worse than an untyped
 * value: it disables checking on everything it touches, which is exactly the propagation
 * this item exists to prevent. The runtime wrapper normalizes the transport's `Blob` to
 * `Uint8Array`, so the declared type is what actually arrives.
 */
export interface WorkstoreByteReads {
  getArtifactData(params: { id: string; range?: string }): Promise<Uint8Array>
  getArtifactDataMember(params: {
    id: string
    '*member': string
    range?: string
  }): Promise<Uint8Array>
  /** ITEM-17 — the same two reads, unparsed, resolving at HEADERS so the body can be
   *  consumed progressively. `null` is a bodyless response and is NOT coerced to an
   *  empty stream. Same transport, same auth, same `?range=`; only the parse differs. */
  getArtifactDataStream(params: {
    id: string
    range?: string
  }): Promise<ReadableStream<Uint8Array> | null>
  getArtifactDataMemberStream(params: {
    id: string
    '*member': string
    range?: string
  }): Promise<ReadableStream<Uint8Array> | null>
}

/** The typed read, whose return type is DERIVED from `expect`. */
export interface WorkstoreTypedReads {
  readColumn<K extends ColumnKind>(params: ReadColumnParams<K>): Promise<ColumnFor<K>>
}
