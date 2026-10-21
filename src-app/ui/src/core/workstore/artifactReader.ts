// artifactReader.ts — the ARTIFACT-level read layer (artifact-model ITEM-25).
//
// `zarrReader.ts` decodes one Zarr array. This is the layer above it: given an artifact
// and the thing a surface wants (a sparse column, a categorical, a 2-D layout, a table),
// it dispatches on the artifact's PRODUCER-DECLARED `structure` and issues the byte
// ranges. It replaced `arrowClient.ts`, which fetched `GET /artifacts/{id}/read?<selection>`
// and decoded an Arrow-IPC body with `apache-arrow` — the surface ITEM-12 deleted and the
// dependency ITEM-24 dropped.
//
// ── DISPATCH IS ON THE DECLARATION, NEVER ON THE BYTES ──────────────────────────────
//
// `structure.encoding` + `structure.kind` are what the producer said it wrote
// (`cyto_zarr.Table.close()` / `cyto_csc.write_csc_zarr()` / `cyto_columns.opaque()`).
// This module reads those and nothing else — no extension sniffing, no "if it looks like
// a Zarr group", no default branch. An unrecognized encoding or kind THROWS with the value
// in the message (INV-2: absence and novelty are errors, not silently-handled cases). That
// is the same rule the server half follows by construction: it cannot infer, because it
// never opens a byte.
//
//   zarr_v3 / table       n Zarr arrays under one directory, one per column/array member.
//   zarr_v3 / sparse_csc  three Zarr arrays under one directory — `indptr` i64,
//                         `indices` u32, `data` f32 — written incrementally in bands so
//                         the producer's peak RSS is bounded by a band.
//   opaque                bytes with a media type and no member structure (a report, a
//                         JSON blob).
//
// THE `kind` IS LOAD-BEARING, not decoration. Both Zarr artifacts declare
// `encoding: "zarr_v3"`, so a reader that dispatched on `encoding` alone would hand a CSC
// matrix to the table path — where `columns`/`arrays` are absent, every member list is
// empty, and the answer is a table with no rows. That is the silent-empty failure INV-2
// exists to forbid, so `asZarrTable`/`asSparseCsc` narrow on the kind and throw naming
// what they got.
//
// There is exactly ONE spelling of a CSC. An earlier draft of this module also accepted
// `encoding: "raw_csc_trio"` — three raw little-endian bins, byte-addressable without a
// codec — which no producer in this repo has ever emitted: `write_csc_zarr` writes Zarr,
// because §0.3 says everything is Zarr (D26). It is gone rather than kept as an alias, so
// the two vocabularies cannot drift apart a second time.
//
// ── PROGRESSIVE READING ────────────────────────────────────────────────────────────
//
// Every bulk read here takes an optional `onChunk`, and passes it straight to
// `ZarrArray.readInto` — which fills a pre-allocated buffer chunk by chunk, in order,
// with a prefetch window keeping the next few fetches in flight. A caller that paints
// per chunk gets a surface that fills in; a caller that just awaits gets the same bytes.
// That is the whole replacement for the deleted streaming route, and it is strictly
// better: `/read` streamed its TRANSMISSION but materialized the entire Arrow result
// server-side first, and the client then did `await res.arrayBuffer()` — so nothing
// painted until everything had landed anyway.
//
// The one read that does NOT take `onChunk` is `readSparseColumn`: a CSC column is two
// short element ranges after a 2-element `indptr` probe, and there is nothing to be
// progressive about. It is chunk-granular in the sense that matters — the inner chunk is
// 4096 elements, so one column of a 368 MB artifact costs the chunks its own non-zeros
// fall in, not the artifact.

import { WorkstoreHttpError, fetchArtifactRange } from './binaryClient'
import {
  ZarrFormatError,
  ZarrNotAnArrayError,
  artifactStore,
  openSplitStringColumn,
  openZarrArray,
  type ZarrArray,
  type ZarrChunkSlice,
  type ZarrStore,
  type ZarrStringColumn,
  type ZarrTypedArray,
} from './zarrReader'

// ── the producer's declaration ──────────────────────────────────────────────────

/**
 * Which declared member KINDS carry text (the ENCODING union).
 *
 * `kind` on a table member names an ENCODING, not a semantic type: `string` is inline
 * utf8, `categorical` is dictionary-encoded with a level set. Both hold TEXT; `numeric`
 * does not. It lives HERE, on the module that declares {@link ZarrMember.kind}, because
 * this is where the stored-structure vocabulary is defined and because two of this
 * module's own readers ({@link previewableColumn}, and the categorical channel through
 * `readCategoricalColumn`) dispatch on it — it used to sit in the package barrel, which
 * this module imports nothing from, so a reader here could not consult the union it is
 * implementing.
 *
 * Its consumers sit in different workbench layers — the `data` capability's categorical
 * channel and core's axis-source resolver. Each used to spell the union out for itself,
 * and the resolver's copy was the NARROWER one (`string` alone), so a control asking
 * "which column holds the labels" admitted only the axis's own inline-utf8 index and
 * excluded every dictionary-encoded label column beside it.
 */
export const TEXT_VALUE_KINDS: readonly string[] = ['string', 'categorical']

/** One member of a `zarr_v3` artifact — a column (1-D) or an array (N-D). Mirrors the
 *  fragment `cyto_zarr.write_array` returns; only the fields a reader consults are
 *  named, the rest ride through untouched. */
export interface ZarrMember {
  /** the member's ADDRESS inside the artifact directory — also its Zarr array path, and
   *  the only thing that resolves through the merkle manifest (INV-4). Required. */
  path: string
  /** `numeric` | `categorical` | `string` — the producer's declaration of MEANING. */
  kind?: string
  dtype?: string
  shape?: number[]
  /**
   * A display LABEL — **never an address**, and OPTIONAL (`cyto_csc`'s trio carries none).
   *
   * The framework conformance gate states the same rule from the other side, verbatim:
   * *"a display LABEL. INV-3: the name is a label, never a key — `path` is the address,
   * and every check in this suite resolves members by `path`."*
   * (`_lib/conformance.py::_OPTIONAL_MEMBER_KEYS`).
   *
   * So nothing in this module resolves a member by it. Render it, carry it through, join
   * on it never — see {@link resolveMember}.
   */
  name?: string
  /** categorical: the DECLARED level set, in code order. Absent on artifacts written
   *  since the row moved to `levels_digest`; resolve via `attributes.cyto.levels`. */
  levels?: string[]
  /** categorical: how many levels the DECLARED set holds (`cyto_zarr.Table.categorical`
   *  writes it beside `levels_digest`). It is the COUNT that stayed on the row when the
   *  set itself moved into `attributes.cyto.levels` — so it is free to read and needs no
   *  request, which is the whole reason a surface may show it. It is a cardinality, not a
   *  excerpt: it separates an annotation-like column from an identifier-like one and can
   *  never separate two identifier-like columns from each other. */
  n_levels?: number
  /** string: `split` ⇒ an `offsets` + `values` pair under a group. The ONLY value this
   *  reader decodes — every other spelling, and an absent one, is refused by name in
   *  `openStringColumn`. Typed `string` rather than `'split'` because it is a producer's
   *  declaration being read, not a value this side chooses. */
  layout?: string
  /** string: how many strings the layout holds. */
  n?: number
}

/** A `zarr_v3` table: *n* arrays sharing ONE axis, under one directory (ITEM-4). */
export interface ZarrTableStructure {
  encoding: 'zarr_v3'
  kind: 'table'
  axis?: string
  /** entries along the shared axis. */
  n?: number
  /** 1-D members. */
  columns?: ZarrMember[]
  /** N-D members (a 2-D layout, a stat matrix). */
  arrays?: ZarrMember[]
  /** ITEM-19: the member holding this axis's KEYS, when the producer declared one. The
   *  matching `key_sequence_digest` is not written by the producer — it is recomputed from
   *  the stored bytes by the framework conformance suite (`_lib/conformance.py`), which is
   *  the only side that can tell whether the declaration and the bytes agree. Carried here
   *  so a consumer can read the field through rather than lose it; nothing in this reader
   *  interprets either. */
  key?: string
  key_sequence_digest?: string
}

/**
 * A `zarr_v3` CSC matrix: three Zarr array members that only mean anything together
 * (`cyto_csc.write_csc_zarr`). Column `j`'s non-zeros are `indices[indptr[j]..indptr[j+1]]`
 * paired with `data` over the same span.
 *
 * The three are named FIELDS rather than a `members[]` list because their roles are not
 * interchangeable — reading `data` where `indices` was meant is a plausible-looking wrong
 * answer, and a positional list is exactly how that happens.
 */
export interface SparseCscStructure {
  encoding: 'zarr_v3'
  kind: 'sparse_csc'
  axes?: string[]
  /** `[rows, columns]` of the logical matrix. */
  shape?: number[]
  nnz?: number
  indptr: ZarrMember
  indices: ZarrMember
  data: ZarrMember
}

/** Bytes with a media type and no member structure. */
export interface OpaqueStructure {
  encoding: 'opaque'
  media_type?: string
  [key: string]: unknown
}

export type ArtifactStructure = ZarrTableStructure | SparseCscStructure | OpaqueStructure

/** Raised when an artifact's `structure` is missing, malformed, or names an encoding
 *  this reader does not implement. Always names the artifact and what was declared —
 *  a reader that cannot say WHICH artifact confused it is not debuggable. */
export class UnsupportedArtifactStructure extends Error {
  constructor(
    readonly artifactId: string,
    readonly declared: unknown,
    detail: string,
  ) {
    super(`artifact ${artifactId}: ${detail} (declared: ${summarize(declared)})`)
    this.name = 'UnsupportedArtifactStructure'
  }
}

function summarize(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 200)}…` : text
  } catch {
    return String(value)
  }
}

const KNOWN_ENCODINGS = ['zarr_v3', 'opaque'] as const

/** The `kind`s a `zarr_v3` artifact may declare — one per producer entry point.
 *  `cyto_zarr.Table.close()` → `table`; `cyto_csc.write_csc_zarr()` → `sparse_csc`. */
const KNOWN_ZARR_KINDS = ['table', 'sparse_csc'] as const

/**
 * Read an artifact row's `structure` column as a typed declaration.
 *
 * `structure` is `NOT NULL` with no default server-side (ITEM-5), so `undefined` here
 * means the caller passed the wrong object, not that the producer declared nothing —
 * which is why it throws rather than returning a permissive default.
 */
export function parseStructure(artifactId: string, declared: unknown): ArtifactStructure {
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new UnsupportedArtifactStructure(artifactId, declared, 'structure is not an object')
  }
  const record = declared as { encoding?: unknown; kind?: unknown }
  // ── A LIVE VOCABULARY DRIFT, reconciled here and NOT hidden ──────────────────
  //
  // The processors declare `{"encoding": "opaque", "media_type": …}`
  // (`cyto_columns.opaque()`), but the SERVER-AUTHORED paths — provenance run output,
  // the selection recipe, upload, the datatype registry's fixture — write
  // `{"kind": "opaque"}`. That is not merely a different spelling: in the producer
  // vocabulary `kind` is already taken (`structure.kind == "table"`, and a MEMBER's
  // `kind` is numeric/categorical/string), so the two meanings collide on one field.
  //
  // The fix is ONE vocabulary at the ~14 server-authored sites, which belongs with
  // ITEM-5/ITEM-6 rather than here. Until then this accepts the alias for `opaque` ONLY,
  // and deliberately does not generalize it: `{"kind": "zarr_v3"}` is NOT accepted, so
  // the alias cannot quietly become a second way to declare a real encoding.
  const encoding =
    typeof record.encoding === 'string'
      ? record.encoding
      : record.kind === 'opaque'
        ? 'opaque'
        : undefined
  if (typeof encoding !== 'string') {
    throw new UnsupportedArtifactStructure(artifactId, declared, 'structure declares no `encoding`')
  }
  if (!(KNOWN_ENCODINGS as readonly string[]).includes(encoding)) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      declared,
      `unsupported encoding "${encoding}" — this reader implements ${KNOWN_ENCODINGS.join(' / ')}`,
    )
  }
  if (encoding === 'zarr_v3' && !(KNOWN_ZARR_KINDS as readonly string[]).includes(record.kind as string)) {
    // A `zarr_v3` artifact that names no kind, or names one this reader has no decoder
    // for, is an ERROR here rather than a table-shaped guess. Guessing is what produced a
    // CSC matrix read as a zero-row table with nothing thrown anywhere.
    throw new UnsupportedArtifactStructure(
      artifactId,
      declared,
      `zarr_v3 artifact declares kind ${JSON.stringify(record.kind)} — this reader implements ${KNOWN_ZARR_KINDS.join(' / ')}`,
    )
  }
  // Normalize the alias so every consumer downstream sees `encoding` and only `encoding`.
  return (record.encoding === undefined
    ? { ...record, encoding }
    : declared) as ArtifactStructure
}

/**
 * Narrow to a Zarr TABLE, or throw naming what was declared instead.
 *
 * The `kind` check is the load-bearing half: `sparse_csc` is also `encoding: "zarr_v3"`,
 * carries no `columns`/`arrays`, and would otherwise flow through every table entry point
 * as an artifact with zero members.
 */
export function asZarrTable(artifactId: string, structure: ArtifactStructure): ZarrTableStructure {
  if (structure.encoding !== 'zarr_v3' || structure.kind !== 'table') {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `expected a \`zarr_v3\` table, got ${describeStructure(structure)}`,
    )
  }
  return structure
}

/** Narrow to a Zarr CSC matrix, or throw naming what was declared instead. */
export function asSparseCsc(artifactId: string, structure: ArtifactStructure): SparseCscStructure {
  if (structure.encoding !== 'zarr_v3' || structure.kind !== 'sparse_csc') {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `a sparse column read needs a \`zarr_v3\` \`sparse_csc\` artifact, got ${describeStructure(structure)}`,
    )
  }
  return structure
}

/** `encoding`/`kind` as one phrase, for an error that has to say what it actually got. */
export function describeStructure(structure: ArtifactStructure): string {
  return structure.encoding === 'zarr_v3'
    ? `\`zarr_v3\` kind "${structure.kind}"`
    : `\`${structure.encoding}\``
}

/** Every member of a Zarr table, columns then arrays, in declaration order. */
export function tableMembers(structure: ZarrTableStructure): ZarrMember[] {
  return [...(structure.columns ?? []), ...(structure.arrays ?? [])]
}

/**
 * The artifact's DECLARED dimensions, in axis order — the successor to the dropped
 * `artifacts.shape` column (ITEM-7).
 *
 * `shape` was one JSONB column carrying three incompatible shapes depending on who wrote
 * it (`[rows, cols]` here, `{rows, cols}` there, `{columns:[{name,kind}]}` somewhere
 * else), so every reader guessed. There is no such column now: an artifact's extent is
 * whatever its PRODUCER declared in `structure`, and this is the one place that reads it.
 *
 *   `sparse_csc`  the declared `[rows, columns]` of the logical matrix (`cyto_csc`).
 *   `table`       a SINGLE-member table is that member's OWN declared `shape` — a 2-D
 *                 layout is one `(n × dims)` array and `[5000, 2]` is what it is. With
 *                 two or more members no such tuple exists, so it is `[n]`: the entries
 *                 on the shared axis. The member COUNT is never a dimension — a table's
 *                 members share one axis, they are not a second one, and reading them as
 *                 "columns" is what made the old `{rows, cols}` view of a table wrong.
 *   `opaque`      `[]` — bytes with a media type declare no extent, and inventing one
 *                 from `size_bytes` would be exactly the byte-interpretation INV-1
 *                 forbids.
 *
 * Absent numbers are OMITTED, never defaulted to 0: "the producer did not say" and "the
 * producer said zero" are different facts and a display that renders `0` asserts the
 * second (INV-2).
 *
 * ── A MALFORMED SHAPE IS REFUSED, NOT COMPACTED ─────────────────────────────────
 *
 * There is a THIRD fact the rule above does not name, and for a POSITION-KEYED reader it
 * is the dangerous one. This used to `filter()` the non-numbers out of a declared shape,
 * which is "omission" only for the entry that went missing: every LATER entry silently
 * moves down an index. Measured, `shape: ['5000', 100, 7]` yielded `[100, 7]`, so
 * `declaredDims(...)[1]` — the sparse column count, read strictly by position — answered
 * 7 for a 100-column matrix, and `runDiff`'s `dim${i}` labels reported axis 1's extent
 * as `dim0`. An omission in the MIDDLE is not an omission; it is a wrong answer at every
 * index after it.
 *
 * So a `shape` that is PRESENT but not a list of finite numbers throws. Absence still
 * yields `[]` (unchanged — that is the producer saying nothing, which is legitimate for
 * a member with no declared extent). Display surfaces still RENDER the same either way:
 * they go through {@link declaredDimsForDisplay}, which turns a throw into `[]` — but it
 * warns first, so the third fact survives in the record even where it cannot survive in
 * the pixels.
 */
export function declaredDims(structure: ArtifactStructure, artifactId = '<unidentified>'): number[] {
  if (structure.encoding !== 'zarr_v3') return []
  const dimsOf = (dims: unknown, what: string): number[] => {
    if (dims === undefined || dims === null) return []
    if (!Array.isArray(dims) || dims.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new UnsupportedArtifactStructure(
        artifactId,
        dims,
        `${what} of ${describeStructure(structure)} is declared but is not a list of finite ` +
          `numbers — dropping an entry would RE-INDEX every later one, and this shape is ` +
          `read by position`,
      )
    }
    return dims as number[]
  }
  if (structure.kind === 'sparse_csc') return dimsOf(structure.shape, '`shape`')
  const members = tableMembers(structure)
  if (members.length === 1) {
    const own = dimsOf(members[0].shape, `member \`${members[0].path}\`'s \`shape\``)
    if (own.length > 0) return own
  }
  return typeof structure.n === 'number' && Number.isFinite(structure.n) ? [structure.n] : []
}

/**
 * {@link declaredDims} for a DISPLAY surface: `[]` instead of a throw when the artifact's
 * declaration cannot be parsed.
 *
 * This is the ONE place that tolerance is spelled, because it is needed by several
 * unrelated surfaces (a KPI card, a run-diff table, a picker option label) and three
 * private copies of a `try {} catch { return [] }` is how they drift apart. It is NOT a
 * default: an unreadable declaration yields NO dimensions, so the surface simply omits
 * the segment rather than rendering an invented `0` (INV-2 forbids the invented value,
 * not the omission).
 *
 * Never reach for this on a READ path. A caller about to decode bytes must use
 * {@link parseStructure} and let it throw — a read that silently proceeds on an
 * unreadable declaration is exactly the silent-wrong-answer failure this module exists
 * to prevent.
 *
 * ── THE REFUSAL IS WARNED, NOT SWALLOWED ────────────────────────────────────────
 *
 * {@link declaredDims} exists to keep a MALFORMED declaration a third fact, distinct from
 * an ABSENT one. This function's `catch` collapses the two back together for its callers,
 * which is the right RENDERING (a surface omits the segment either way — there is no
 * dimension to draw and inventing one is forbidden) and the wrong RECORD: without a line
 * in the console, "this producer wrote `shape: ['5000', 100, 7]`" is indistinguishable
 * from "this producer declared no extent", and only one of those is a bug somebody has to
 * fix. `workbenchDataSource`'s own call to `declaredDims` warns on exactly this path; the
 * asymmetry was inside a single change. So the throw is reported and then absorbed.
 *
 * `console.warn`, never `console.error`: a display surface degrading to "no dimensions" is
 * not a runtime failure, and the gallery's runtime-health pass gates on `console-error`.
 */
export function declaredDimsForDisplay(artifactId: string, declared: unknown): number[] {
  try {
    return declaredDims(parseStructure(artifactId, declared), artifactId)
  } catch (e) {
    console.warn(
      '[workstore] no dimensions shown: the artifact declares a structure this reader cannot parse',
      artifactId,
      e,
    )
    return []
  }
}

/**
 * Resolve the member a caller asked for, **BY PATH**.
 *
 * `path` empty/absent picks the SOLE member — legitimate and unambiguous for a
 * SINGLE-member artifact, which is what a producer declares whenever the artifact IS one
 * column (a lone 1-D `values` member) or one 2-D coordinate array.
 * With two or more members and no path it THROWS rather than taking the first: "the
 * first one" is a guess, and a silently-wrong column is worse than an error (INV-2).
 *
 * ── A MEMBER HAS EXACTLY ONE ADDRESS, AND IT IS ITS PATH (INV-4) ────────────────
 *
 * §0.3: *"One row, one file or one directory. Members of a directory are addressed by
 * path through a merkle manifest."* The server half is already built that way and is
 * pinned by TEST-5 (`server/tests/workstore/member_path_test.rs`): resolution is
 * EXACT-MATCH on the path, and a prefix, a suffix or a case variant of a real member path
 * is a `404`. The manifest has no other key to offer.
 *
 * This function used to accept a second one — `m.path === name || m.name === name` — so a
 * DISPLAY LABEL addressed a member here that could not address it anywhere else. That is
 * the same shape as INV-3's name-vs-identity defect, and it is the label side of the very
 * rule the framework gate spells out for producers: *"the name is a label, never a key —
 * `path` is the address"* (`conformance.py::_OPTIONAL_MEMBER_KEYS["name"]`).
 *
 * It never resolved to the WRONG member, and could not have: every producer in this repo
 * writes the two identical — `cyto_zarr.Table.{numeric,categorical}` pass one `name`
 * argument to `write_array` (which returns it as `path`) and then stamp `entry["name"]`
 * from that same argument, `Table.string` writes `{"name": name, "path": name}` literally,
 * `Table._claim` rejects a name containing `/` so a path is always one flat segment equal
 * to its name, and `cyto_csc`'s trio declares no `name` at all. The label was therefore
 * never ambiguous in practice; the defect was that the invariant held by COINCIDENCE of
 * the producers rather than by construction of the reader, and the type's own doc — plus
 * the gate's explicit permission for a `name` that is a label — invited the divergence
 * that would have made it ambiguous. Removing the arm is a no-op today and a load-bearing
 * one the first time a producer labels a member.
 */
export function resolveMember(
  artifactId: string,
  structure: ZarrTableStructure,
  path?: string,
): ZarrMember {
  const members = tableMembers(structure)
  if (members.length === 0) {
    throw new UnsupportedArtifactStructure(artifactId, structure, 'declares no members')
  }
  if (!path) {
    if (members.length === 1) return members[0]
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `holds ${members.length} members (${members.map(m => m.path).join(', ')}) — name the one to read`,
    )
  }
  const hit = members.find(m => m.path === path)
  if (!hit) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `has no member "${path}" (members: ${members.map(m => m.path).join(', ')})`,
    )
  }
  return hit
}

// ── shared read options ─────────────────────────────────────────────────────────

/** Options every bulk read accepts. */
export interface ArtifactReadOptions {
  /**
   * Invoked as each inner chunk lands, in order. THIS is the progressive-rendering
   * hook: `slice.index`/`slice.total` are known before the first byte arrives, so a
   * consumer can show determinate progress and repaint per chunk instead of holding a
   * spinner until the whole column is resident.
   */
  onChunk?: (slice: ZarrChunkSlice) => void
  /** An injected store — the unit suite drives fixtures through the exact HTTP path. */
  store?: ZarrStore
}

function storeFor(artifactId: string, options: ArtifactReadOptions): ZarrStore {
  return options.store ?? artifactStore(artifactId)
}

/**
 * Every member array this module opens, keyed by `(artifactId, member path)` and REUSED
 * across reads.
 *
 * Opening a member costs a `zarr.json` fetch, and the `ZarrArray` it returns owns the
 * decoded shard-index cache, the byte-budgeted decoded-chunk LRU, and the in-flight
 * chunk map. Those three are the reason this cache is at the READ layer rather than in
 * each consumer: they only do their job for reads that share one instance.
 *
 * That matters because a member is routinely read by SEVERAL INDEPENDENT consumers, none
 * of which can see the others. One project layout is read by the canvas grid's positions
 * handoff (`GridWorkspace`, inside `@ziee/viz`) AND by the declarative-canvas host's
 * plottable-XY resolve (`canvasHostProvider`) — different packages, different lifecycles,
 * each already memoizing its OWN single read. Without this cache each one re-fetched
 * `zarr.json` and every chunk of the same immutable bytes; concurrently, so no consumer-
 * level memo could have helped. With it, the second consumer's read is served from the
 * first's decoded chunks (or, if it starts while the first is still in flight, joins the
 * same requests through `ZarrArray`'s in-flight map).
 *
 * Safe to hold forever: an artifact is immutable and content-addressed, so `artifactId`
 * identifies bytes that cannot change under the cache. Bounded because a session can
 * touch many artifacts and each entry pins decoded chunks up to that array's cache
 * budget. A caller that injects its own store bypasses this entirely — the key is the
 * artifact id, and an injected store is not derivable from one.
 */
const MEMBER_ARRAYS = new Map<string, Promise<ZarrArray>>()
/** 24 member arrays ≈ 8 artifacts × 3 members — the ceiling the CSC-trio cache this
 *  generalizes already carried (`CSC_ARRAYS_MAX` was 8 entries of three arrays each). */
const MEMBER_ARRAYS_MAX = 24

/**
 * Open (or reuse) one member of an artifact as a Zarr array.
 *
 * Exported because `typedRead`'s declaration lookups open the same members through the
 * same store; a second cache there would reintroduce exactly the duplication this one
 * removes.
 */
export function openArtifactArray(
  artifactId: string,
  path: string,
  options: ArtifactReadOptions = {},
): Promise<ZarrArray> {
  // An injected store is not keyable, so it never participates.
  if (options.store) return openZarrArray(options.store, path)

  const key = `${artifactId}\n${path}`
  const hit = MEMBER_ARRAYS.get(key)
  if (hit) {
    // Re-insert to move it to the END of the insertion order: eviction below takes the
    // FRONT, so without this a session sweeping columns of one matrix would evict the
    // very members it is actively reading.
    MEMBER_ARRAYS.delete(key)
    MEMBER_ARRAYS.set(key, hit)
    return hit
  }
  const opened = openZarrArray(artifactStore(artifactId), path)
  // A failed open must not be remembered — a transient 5xx would otherwise poison every
  // later read of this member for the life of the tab.
  opened.catch(() => MEMBER_ARRAYS.delete(key))
  MEMBER_ARRAYS.set(key, opened)
  while (MEMBER_ARRAYS.size > MEMBER_ARRAYS_MAX) {
    const oldest = MEMBER_ARRAYS.keys().next().value
    if (oldest === undefined) break
    MEMBER_ARRAYS.delete(oldest)
  }
  return opened
}

/** Drop every cached member array. For a test that asserts on request counts — the cache
 *  is process-wide by design, so a suite sharing one module instance needs a way to start
 *  from cold rather than inheriting the previous case's opens. */
export function __resetArtifactArrayCache(): void {
  MEMBER_ARRAYS.clear()
}

/** Open one declared member as a Zarr array. */
async function openMember(
  artifactId: string,
  member: ZarrMember,
  options: ArtifactReadOptions,
): Promise<ZarrArray> {
  return openArtifactArray(artifactId, member.path, options)
}

/** Read a whole member, reporting chunk arrival. `readInto` allocates once from the
 *  DECLARED length and fills — the shape §2.5b asks for. */
async function readWhole(array: ZarrArray, options: ArtifactReadOptions): Promise<ZarrTypedArray> {
  return array.readInto(array.dtype.alloc(array.length), 0, array.length, options.onChunk)
}

// ── sparse (CSC) columns ────────────────────────────────────────────────────────

/** One CSC column's non-zeros: parallel row-index + value arrays. */
export interface SparseColumnData {
  row: Uint32Array
  value: Float32Array
}

/** One of the trio, looked up by ROLE from the declaration. The three roles are not
 *  interchangeable, so a declaration missing one is an error naming which — never a
 *  positional guess at which member was meant. */
function cscMember(artifactId: string, structure: SparseCscStructure, role: 'indptr' | 'indices' | 'data'): ZarrMember {
  const hit = structure[role]
  if (!hit?.path) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `sparse_csc declares no "${role}" member`,
    )
  }
  return hit
}

/**
 * The three member arrays of a CSC artifact, opened once and REUSED.
 *
 * This path is the colour-by-value hot path — a user sweeping through columns of ONE
 * matrix — so re-opening per column would re-fetch three metadata documents and throw
 * away the shard index before every read. Reuse comes from `MEMBER_ARRAYS`, the ONE
 * opened-array cache every read in this module shares; this function used to keep a
 * second, CSC-only cache of its own, which meant the sparse path got reuse and the dense
 * layout / numeric / categorical paths — reading the very same kind of member out of the
 * very same kind of store — did not.
 */
function openCsc(
  artifactId: string,
  structure: SparseCscStructure,
  options: ArtifactReadOptions,
): Promise<{ indptr: ZarrArray; indices: ZarrArray; data: ZarrArray }> {
  // Resolve all three BEFORE opening any. A missing member is a declaration error, and
  // discovering it halfway through would leave an in-flight fetch for the members that did
  // resolve with nobody awaiting it — an unhandled rejection, which in the browser is a
  // console error rather than the clean throw the caller is owed.
  const paths = (['indptr', 'indices', 'data'] as const).map(
    role => cscMember(artifactId, structure, role).path,
  )
  return Promise.all(paths.map(path => openArtifactArray(artifactId, path, options))).then(
    ([indptr, indices, data]) => ({ indptr, indices, data }),
  )
}

/**
 * Read ONE column of a `sparse_csc` artifact — the colour-by-value hot path.
 *
 * Three element ranges, exactly as the design's §4.2 read path describes: probe
 * `indptr[col..col+2]` for the column's non-zero window, then read `indices` and `data`
 * over it. Each range resolves to the inner chunks it falls in (4096 elements each) and
 * a byte range INSIDE the covering shard, located through that shard's index — so a
 * column of a 368 MB matrix costs its own non-zeros plus at most a chunk of overfetch at
 * each end, never the artifact.
 *
 * This replaced `readSparseColumnArrow`, which asked the server to slice the CSC, build
 * an Arrow COO `RecordBatch` and stream it as IPC.
 *
 * The `mask` parameter is GONE with it. `/read?mask=<artifact>` resolved a row-subset
 * artifact server-side and intersected the served rows — server-side interpretation of
 * two artifacts' bytes, which INV-1 forbids. It had no production caller (only the e2e
 * decoder seam), so nothing regressed; a client that wants a masked column intersects
 * `row` against its own subset, where the subset already lives.
 */
export async function readSparseColumn(
  artifactId: string,
  col: number,
  structure: ArtifactStructure,
  options: ArtifactReadOptions = {},
): Promise<SparseColumnData> {
  const csc = asSparseCsc(artifactId, structure)
  if (!Number.isInteger(col) || col < 0) {
    throw new UnsupportedArtifactStructure(artifactId, structure, `column index ${col} is not a non-negative integer`)
  }

  // The DECLARED `indptr` length bounds the column index. Checked before anything is
  // opened, so an out-of-range column is "no such column" rather than a transport fault
  // from a read past the end of a member.
  const declaredColumns = (cscMember(artifactId, csc, 'indptr').shape?.[0] ?? 0) - 1
  if (declaredColumns >= 0 && col >= declaredColumns) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `column ${col} is out of range — the artifact declares ${declaredColumns} columns`,
    )
  }

  const arrays = await openCsc(artifactId, csc, options)
  const window = await arrays.indptr.read(col, col + 2)
  if (window.length < 2) {
    throw new ZarrFormatError(
      `artifact ${artifactId}: indptr holds no window for column ${col} — malformed CSC`,
    )
  }
  // `indptr` is i64, so it decodes to a `BigInt64Array`. Row counts stay far below 2^53,
  // so `Number()` on the BigInt is lossless here; a matrix that broke that would be beyond
  // what a browser could hold anyway. Reading the low half only would silently truncate.
  const lo = Number(window[0])
  const hi = Number(window[1])
  if (!(hi >= lo)) {
    throw new ZarrFormatError(
      `artifact ${artifactId}: indptr[${col}]=${lo} > indptr[${col + 1}]=${hi} — malformed CSC`,
    )
  }
  if (hi === lo) return { row: new Uint32Array(0), value: new Float32Array(0) }

  // The two payload reads are independent — issue them together, not in sequence.
  const [rawRow, rawValue] = await Promise.all([
    arrays.indices.read(lo, hi),
    arrays.data.read(lo, hi),
  ])
  return { row: asRowIds(rawRow), value: asValues(rawValue) }
}

/** Row ids as `Uint32Array`. `uint32` is what `cyto_csc` declares, and that arm is
 *  zero-copy; the conversion exists so a producer declaring another integer width reads
 *  correctly instead of being reinterpreted at the wrong stride. */
function asRowIds(values: ZarrTypedArray): Uint32Array {
  if (values instanceof Uint32Array) return values
  const out = new Uint32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = Number(values[i])
  return out
}

/** Values as `Float32Array` — `cyto_csc` casts to f32 on write, so that arm is zero-copy. */
function asValues(values: ZarrTypedArray): Float32Array {
  if (values instanceof Float32Array) return values
  return Float32Array.from(values as ArrayLike<number>, Number)
}

// ── string columns (LAZY — ITEM-32) ─────────────────────────────────────────────

/**
 * Open a declared string member as a WINDOWED accessor — `length` now, values on demand.
 *
 * This is the default way to reach a string column, and the reason is measured: the
 * eager form on a 10M × 18-char column costs **979 ms and 580 MB of heap**, against
 * **0.08 ms** for the 100 rows a table actually shows. The accessor fetches only the
 * chunks covering the window it is asked for, so a virtualized list costs a window, not a
 * column. `.readAll()` is still one call away for a caller that genuinely wants every
 * value (an export, a categorical coding pass) — the point is that it is now a decision.
 *
 * Dispatch is on the producer's declared `layout`, never on the bytes — and there is
 * exactly ONE layout: `split`, an `offsets` + `values` pair under a group. Anything else
 * (including an absent `layout`) is REFUSED by name. It used to fall through to a
 * single-buffer arrow decoder, which no producer emits and which the framework
 * conformance gate refuses outright, so the fallthrough could only ever turn a malformed
 * declaration into a confusing failure two layers down. That decoder is deleted; this is
 * where its absence is stated.
 */
export async function openStringColumn(
  artifactId: string,
  structure: ArtifactStructure,
  column?: string,
  options: ArtifactReadOptions = {},
): Promise<ZarrStringColumn> {
  const table = asZarrTable(artifactId, structure)
  const member = resolveMember(artifactId, table, column)
  if (member.kind !== undefined && member.kind !== 'string') {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `member "${member.path}" is declared ${member.kind}, not a string column`,
    )
  }
  if (member.layout !== 'split') {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `string member "${member.path}" declares layout ${member.layout === undefined ? '(none)' : `"${member.layout}"`} — the only string layout this reader decodes is "split" (a uint32 \`offsets\` member and a uint8 \`values\` member under a group), which is the only one \`cyto_zarr.Table.string\` writes`,
    )
  }
  const store = storeFor(artifactId, options)
  return openSplitStringColumn(store, member.path, { count: member.n })
}

// ── categorical columns ─────────────────────────────────────────────────────────

/** A decoded categorical column: one code per entity + the DECLARED labels.
 *
 *  Codes are `Uint32Array` — NOT `Uint16Array`. A string-valued annotation column can
 *  carry more than 65536 distinct labels (any near-unique per-row identifier does), and
 *  a 16-bit code wraps mod 65536 into the WRONG label rather than failing. The viz GPU
 *  consumer packs to u16 at its own boundary (`toUint16Codes`, called from
 *  `WorkbenchDataSource.categorical`), where it can check the count and error. */
export interface CategoricalColumnData {
  codes: Uint32Array
  categories: string[]
}

/**
 * Read a categorical column of a `zarr_v3` artifact → codes + the DECLARED level set.
 *
 * Three storage shapes, all declared, none inferred:
 *   `categorical` — `uint8`/`uint16` codes; the levels live in the array's
 *                   `attributes.cyto.levels` (D10: ONE artifact). The member DECLARATION
 *                   no longer restates them — it carries `levels_digest` + `n_levels`,
 *                   because inlining a 35k-level set made one manifest entry 450 KB and
 *                   blew the server's 1 MiB manifest cap. `member.levels` is still read
 *                   first (below) so an older artifact that has it keeps working; the
 *                   fallback is now the normal path, not the exceptional one.
 *   `string`      — the `split` pair (an `offsets` member and a `values` member under a
 *                   group), which is the ONLY string layout this reader decodes — anything
 *                   else `openStringColumn` refuses BY NAME rather than decoding. Decoded
 *                   to strings, then coded here, because a free-text column has no
 *                   declared level set to code against.
 *   `numeric`     — a bool/int column a surface wants to colour categorically; the
 *                   values ARE the codes and the labels are their decimal spellings.
 *
 * The string arm is the one that costs: it materializes every value. That is inherent —
 * a column whose producer declared no level set has no compact encoding — and it is why
 * `cyto_columns` writes a pandas Categorical as `categorical` rather than as strings.
 */
export async function readCategoricalColumn(
  artifactId: string,
  structure: ArtifactStructure,
  column?: string,
  options: ArtifactReadOptions = {},
): Promise<CategoricalColumnData> {
  const table = asZarrTable(artifactId, structure)
  const member = resolveMember(artifactId, table, column)

  if (member.kind === 'string') {
    // Coding a free-text column against no declared level set requires seeing every
    // value, so this is one of the two places that legitimately reaches for the eager
    // path — spelled out via `readAll()` rather than arrived at by default (ITEM-32).
    const column = await openStringColumn(artifactId, structure, member.path, options)
    return codeStrings(await column.readAll())
  }

  const array = await openMember(artifactId, member, options)
  const raw = await readWhole(array, options)
  const levels = member.levels ?? array.cyto?.levels

  if (member.kind === 'categorical') {
    if (!levels) {
      throw new UnsupportedArtifactStructure(
        artifactId,
        structure,
        `member "${member.path}" is declared categorical but carries no level set — a categorical's levels are DECLARED, never inferred from its codes`,
      )
    }
    return { codes: toCodes(raw), categories: [...levels] }
  }

  // A numeric member coloured categorically (a bool flag, an integer cluster id). The
  // declared levels win when present — and "present" means the two sources resolved
  // above: the member row's `levels` in `structure`, or the array's own
  // `attributes.cyto.levels`. It does NOT mean `cyto_columns`' bool `["false","true"]`:
  // that pair rides on the per-column `meta` document `write_metadata_column` returns
  // ALONGSIDE `structure`, and this function is handed `structure` only, so a bool column
  // reaches here with no levels and is labelled by the branch below. Otherwise the labels
  // are the values' own spellings, which is a rendering choice, not an inference about
  // what the column MEANS.
  const codes = toCodes(raw)
  if (levels) return { codes, categories: [...levels] }
  const distinct = [...new Set(codes)].sort((a, b) => a - b)
  const index = new Map(distinct.map((v, i) => [v, i]))
  const remapped = new Uint32Array(codes.length)
  for (let i = 0; i < codes.length; i++) remapped[i] = index.get(codes[i]) ?? 0
  return { codes: remapped, categories: distinct.map(String) }
}

/** Widen any integer code array to `Uint32Array` (a copy; the source may be a cache view). */
function toCodes(values: ZarrTypedArray): Uint32Array {
  const out = new Uint32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = Number(values[i])
  return out
}

/** Code a decoded string column: first-seen order, so the codes are stable for a given
 *  column. `null`/absent cannot occur, and the reason is on the WRITING side: the layout
 *  carries no null bitmap, so `cyto_zarr.Table.string` REFUSES a missing value outright
 *  unless the caller declares the string it stands for (`missing=`), and `cyto_columns`
 *  substitutes `''` for it BEFORE calling, counting the substitutions in `meta.missing`.
 *  Neither can put a hole in the payload, so every decoded span is a `string`. */
function codeStrings(values: string[]): CategoricalColumnData {
  const categories: string[] = []
  const index = new Map<string, number>()
  const codes = new Uint32Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    let code = index.get(v)
    if (code === undefined) {
      code = categories.length
      index.set(v, code)
      categories.push(v)
    }
    codes[i] = code
  }
  return { codes, categories }
}

// ── value PREVIEW: a bounded EXCERPT of one column's values ──────────────────────
//
// The read behind a "what does this column actually contain" affordance. It exists as its
// own entry point, rather than as a `.slice()` on an existing one, because the existing
// ones all materialize the column: `readCategoricalColumn` returns `{codes, categories}`
// and reads the WHOLE code array to do it — 35,477 entries on a real import, to show five
// strings. A preview that pulls the whole column is not a preview, and the cost is
// invisible in a test with a five-row fixture.

/** How many values a preview yields when the caller names no limit. */
export const DEFAULT_VALUE_PREVIEW = 5

/** A short EXCERPT of a text column's values, and WHICH declaration answered.
 *
 *  `source` is not decoration — the two are different KINDS of excerpt and a surface that
 *  rendered either as "the first N" would assert an ordering one of them does not have:
 *
 *    `levels` — the column's declared VOCABULARY, in dictionary order. A fair excerpt of
 *               what the column CONTAINS; not its first rows, and not in row order.
 *    `rows`   — literally the first `limit` stored values, in row order. */
export interface ValuePreviewData {
  values: string[]
  source: 'levels' | 'rows'
}

/**
 * The ONE declared member a value preview would excerpt, or `undefined` when the artifact
 * declares none — the single place this rule is written.
 *
 * Two conditions, both read off the producer's DECLARATION and neither inferred from
 * bytes:
 *
 *   · the artifact declares exactly ONE 1-D member. With several, a preview would be
 *     choosing a column on the user's behalf, which is the guess the surrounding controls
 *     exist to remove. (A caller that KNOWS which member it wants names it — see
 *     {@link previewColumnValues}'s `member` — and this predicate is bypassed.)
 *   · that member's declared `kind` is a TEXT-carrying ENCODING ({@link TEXT_VALUE_KINDS}).
 *     `kind` names an ENCODING, not a semantic type: `string` is inline utf8 and
 *     `categorical` is dictionary-encoded, and both hold text. A `numeric` member has no
 *     text excerpt — five numbers are not a summary of a numeric column (min/max/n is, and
 *     that is a different read) — so it yields nothing here rather than something
 *     plausible.
 *
 * Takes `unknown` and is TOTAL: a caller holding a catalog row's raw `structure` can ask
 * without first parsing it, and a declaration that will not parse simply previews nothing.
 * That is a determinate answer about the declaration, not a swallowed read failure.
 */
export function previewableColumn(declared: unknown): ZarrMember | undefined {
  if (declared == null || typeof declared !== 'object' || Array.isArray(declared)) return undefined
  const s = declared as { encoding?: unknown; kind?: unknown; columns?: unknown }
  if (s.encoding !== 'zarr_v3' || s.kind !== 'table') return undefined
  if (!Array.isArray(s.columns) || s.columns.length !== 1) return undefined
  const member = s.columns[0]
  if (member == null || typeof member !== 'object') return undefined
  const kind = (member as ZarrMember).kind
  return typeof kind === 'string' && TEXT_VALUE_KINDS.includes(kind) ? (member as ZarrMember) : undefined
}

/**
 * A bounded excerpt of ONE column's values.
 *
 * Dispatch is on the member's declared ENCODING, and the two arms cost very different
 * things:
 *
 *   `categorical` — dictionary-encoded, so the values ARE the level set, and the level set
 *                   lives in the member array's own `zarr.json`
 *                   (`attributes.cyto.levels`). ONE metadata request; **not one byte of
 *                   the data array is fetched**. An older artifact that still inlines
 *                   `levels` on the member row costs no request at all.
 *   `string`      — inline utf8, so there is no vocabulary to read and the excerpt is the
 *                   first `limit` values: a WINDOW through `openStringColumn`, which
 *                   fetches only the chunks that window covers (ITEM-32's whole point).
 *
 * `undefined` means the DECLARATION offers nothing to preview — a determinate answer read
 * off the producer's own words, never a swallowed failure. A read that genuinely fails
 * THROWS, so a caller can tell "there is nothing to show" from "I could not find out" and
 * degrade differently.
 */
export async function previewColumnValues(
  artifactId: string,
  structure: ArtifactStructure,
  options: ArtifactReadOptions & { member?: string; limit?: number } = {},
): Promise<ValuePreviewData | undefined> {
  const limit = Math.trunc(options.limit ?? DEFAULT_VALUE_PREVIEW)
  if (limit <= 0) return undefined
  // A NAMED member resolves by path and only by path (INV-4) — and a name that does not
  // exist is a caller bug, so `resolveMember` throws rather than previewing nothing. An
  // unnamed one goes through the sole-text-member rule above.
  const member =
    options.member === undefined
      ? previewableColumn(structure)
      : resolveMember(artifactId, asZarrTable(artifactId, structure), options.member)
  if (!member) return undefined

  if (member.kind === 'categorical') {
    const levels = member.levels ?? (await openArtifactArray(artifactId, member.path, options)).cyto?.levels
    if (!levels || levels.length === 0) return undefined
    // `String(...)`, not a cast: a producer's level set is JSON and a bool/int column's
    // levels arrive as bools/numbers on some writers. A preview renders text.
    return { values: levels.slice(0, limit).map(String), source: 'levels' }
  }
  if (member.kind === 'string') {
    const column = await openStringColumn(artifactId, structure, member.path, options)
    const values = await column.slice(0, limit)
    return values.length === 0 ? undefined : { values, source: 'rows' }
  }
  return undefined
}

// ── numeric columns + N-D arrays ────────────────────────────────────────────────

/**
 * Read a numeric member as `Float32Array`, painting per chunk.
 *
 * The allocate-once path: the length is known from the declaration before any byte is
 * fetched, so the destination exists up front and each chunk lands into it. A consumer
 * that holds a GPU buffer passes `onChunk` and re-uploads the filled prefix.
 */
export async function readNumericColumn(
  artifactId: string,
  structure: ArtifactStructure,
  column?: string,
  options: ArtifactReadOptions = {},
): Promise<Float32Array> {
  const table = asZarrTable(artifactId, structure)
  const member = resolveMember(artifactId, table, column)
  const array = await openMember(artifactId, member, options)
  const raw = await readWhole(array, options)
  return raw instanceof Float32Array ? raw : Float32Array.from(raw as ArrayLike<number>, Number)
}

/** A 2-D layout as the viz wire frames it: interleaved `[x0,y0,x1,y1,…]`. */
export interface PositionsData {
  positions: Float32Array
  length: number
}

/**
 * Read an `(n × dims)` member as interleaved 2-D positions, painting per chunk.
 *
 * A rows-chunked 2-D member carries the full width in every chunk, so
 * ONE chunk is a contiguous run of whole points — which is exactly what makes the
 * progressive path meaningful here rather than decorative: after chunk k the first
 * `k · rows_per_chunk` POINTS are complete and paintable, not a smear of half-points.
 *
 * `dims > 2` projects onto the first two columns (the wire framing is 2-D), which is the
 * same reduction the pre-ITEM-25 dense path did.
 */
export async function readPositions(
  artifactId: string,
  structure: ArtifactStructure,
  member?: string,
  options: ArtifactReadOptions = {},
): Promise<PositionsData> {
  const table = asZarrTable(artifactId, structure)
  const declared = resolveMember(artifactId, table, member)
  const array = await openMember(artifactId, declared, options)
  const dims = array.rowElements
  if (dims < 2) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `member "${declared.path}" has ${dims} value(s) per entity — a layout needs at least 2`,
    )
  }
  const count = array.shape[0]
  // The destination is allocated at the ARRAY's element width, not at `Float32Array`.
  // `readInto` fills it with a raw byte copy sized by `dtype.itemSize`, so handing it a
  // `Float32Array` for an `float64` member would interleave halves of each double into
  // plausible-looking garbage — wrong coordinates that render as a plot rather than as an
  // error. A member DECLARED f32 takes the zero-copy branch below; the conversion exists
  // so a producer that declares another width reads correctly instead of silently wrong.
  const wide = await array.readInto(array.dtype.alloc(array.length), 0, array.length, options.onChunk)
  if (dims === 2 && wide instanceof Float32Array) {
    return { positions: wide, length: count }
  }
  const positions = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    positions[i * 2] = Number(wide[i * dims])
    positions[i * 2 + 1] = Number(wide[i * dims + 1])
  }
  return { positions, length: count }
}

// ── chunk-level BYTE streams (ITEM-2/3) ─────────────────────────────────────────

/**
 * What a chunk-level byte stream takes. `signal` is the only addition over
 * {@link ArtifactReadOptions}: a whole-array read has one exit (its promise), a stream has
 * a consumer that can walk away, and INV-4 requires that walking away actually STOPS the
 * reads rather than discarding their results.
 */
export interface ArtifactStreamOptions extends ArtifactReadOptions {
  signal?: AbortSignal
}

/** Uniform abort, thrown at the top of each chunk turn so a cancelled stream cannot
 *  schedule the next fetch. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('the artifact byte stream was aborted', 'AbortError')
  }
}

/** A byte view over a FRESH `Float32Array` copy of `values`.
 *
 *  The copy is not optional. `ZarrArray.chunks()` yields VIEWS into its decoded-chunk
 *  cache and says so ("copy anything you keep"); a stream's chunks are kept — a multicast
 *  replays them to a consumer that arrives later, by which point the cache slot may hold
 *  another chunk entirely. */
function f32ChunkBytes(values: ZarrTypedArray): Uint8Array {
  const out =
    values instanceof Float32Array
      ? new Float32Array(values)
      : Float32Array.from(values as ArrayLike<number>, Number)
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

/**
 * Stream one numeric member's chunks as the dense f32 wire bytes viz's `continuous`
 * channel consumes — the chunk-granular twin of {@link readNumericColumn}.
 *
 * Concatenating every yielded chunk is byte-identical to `readNumericColumn`'s result:
 * both walk `chunks(0, length)` over the same member and coerce each element the same way.
 * The DIFFERENCE is only when the bytes become available.
 */
export async function* streamNumericBytes(
  artifactId: string,
  structure: ArtifactStructure,
  column?: string,
  options: ArtifactStreamOptions = {},
): AsyncGenerator<Uint8Array, void, void> {
  const table = asZarrTable(artifactId, structure)
  const member = resolveMember(artifactId, table, column)
  const array = await openMember(artifactId, member, options)
  throwIfAborted(options.signal)
  for await (const slice of array.chunks(0, array.length)) {
    throwIfAborted(options.signal)
    options.onChunk?.(slice)
    yield f32ChunkBytes(slice.values)
  }
}

/**
 * The Zarr member a MEMBERSHIP ENTRY declares its index body in, or `undefined` when this
 * structure declares no such entry.
 *
 * Matched on the entry's `members` NAME (which is what a consumer holds — `DeclaredMembership`
 * carries it) and addressed by the entry's own `path`, so the two spellings stay the producer's
 * to choose. `path` falls back to `members` because they are the same string in everything the
 * writer emits (`write_array(root, name, …)` returns `{path: name}`); the fallback exists so an
 * entry that names its body and omits the address is readable rather than silently unreadable.
 */
function membershipIndexMember(structure: ArtifactStructure, member: string): ZarrMember | undefined {
  const entries = (structure as { memberships?: unknown }).memberships
  if (!Array.isArray(entries)) return undefined
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { members?: unknown; path?: unknown }
    if (e.members !== member) continue
    const path = typeof e.path === 'string' && e.path !== '' ? e.path : member
    // `kind`/`dtype`/`shape` are deliberately NOT asserted from the declaration: the body's own
    // `zarr.json` is the authority on all three and `openMember` reads it, so restating them
    // here would add a second opinion that could disagree with the bytes.
    return { path }
  }
  return undefined
}

/**
 * READ A MEMBER INDEX BODY (ITEM-3) — the gather list, ascending member positions.
 *
 * A 1-D `uint32` member the producer wrote alongside its declaration. Read whole and once: it
 * is the MEMBER count long, not the parent's length, and every gather below walks it in one
 * pass against the parent's chunks.
 *
 * REFUSES a non-ascending or out-of-range body rather than gathering with it. A set is not an
 * order, but the STORED sequence is one, and both the writer (`encode_member_set`) and the
 * per-chunk gather depend on it: a descending pair would silently drop rows and a duplicate
 * would emit one twice, in each case producing a full-looking column of the wrong rows.
 *
 * ── `ordered: false` — A CORRESPONDENCE SEQUENCE BODY (INV-6 / INV-7) ────────────────────────
 *
 * The ascending refusal is the ONE-PASS gather's guard, and it is right for a SUBSET's index
 * body — a set stored ascending, walked once against the parent's chunks. A CORRESPONDENCE
 * coordinate's per-axis body is a different thing: it is the coordinate's declared row SEQUENCE
 * (INV-7 — "a coordinate's rows are a sequence"), and INV-6 pairs entry *i* of one axis with an
 * arbitrary entry *j* of the other, so the body is a PERMUTATION by construction and ascending
 * cannot express it. Such a body is only ever consumed by a RANDOM-ACCESS gather
 * (`gatherFrame` — `column[positions[i]]`), which neither drops nor duplicates on an unordered
 * body, so the one-pass guard does not apply and would wrongly refuse a legitimate
 * correspondence. `ordered: false` skips exactly that check and NOTHING else; the caller that
 * passes it is the one that also reads the body by random access.
 *
 * ── IT IS RESOLVED OFF THE MEMBERSHIP ENTRY, NOT OFF `columns`/`arrays` ─────────────────────
 *
 * The producer declares this member on the MEMBERSHIP ENTRY that owns it (`members` names it,
 * `path` addresses it) and deliberately NOT among the table's columns:
 *
 *   *"its length is the member COUNT, its values are positions into a DIFFERENT sequence (the
 *    axis), and offering it in the column picker would offer the row numbers as a thing to
 *    colour by … `columns` keeps meaning 'one value per row of this table'"*
 *   — `cyto_zarr.Table.close()`
 *
 * So {@link resolveMember} — which searches exactly `columns` + `arrays` — cannot find it on a
 * real producer's artifact, and this read failed with *"has no member"* on every artifact the
 * writer actually emits. The entry is consulted FIRST for that reason; `resolveMember` remains
 * the fallback so a body a fixture or a future writer does declare as a member still resolves.
 */
export async function readMemberIndex(
  artifactId: string,
  structure: ArtifactStructure,
  member: string,
  options: ArtifactReadOptions = {},
  ordered = true,
): Promise<Uint32Array> {
  const table = asZarrTable(artifactId, structure)
  const declared = membershipIndexMember(structure, member) ?? resolveMember(artifactId, table, member)
  const array = await openMember(artifactId, declared, options)
  const raw = await readWhole(array, options)
  const out = raw instanceof Uint32Array ? raw : Uint32Array.from(raw as ArrayLike<number>, Number)
  // A correspondence sequence body is a declared permutation read by random access — the
  // ascending guard is the one-pass gather's and does not apply to it (see the docstring).
  if (!ordered) return out
  for (let i = 1; i < out.length; i++) {
    if (out[i] <= out[i - 1]) {
      throw new UnsupportedArtifactStructure(
        artifactId,
        structure,
        `member index "${member}" is not strictly ascending at position ${i} ` +
          `(${out[i - 1]} then ${out[i]}) — a gather walks it in one pass against the ` +
          'parent\'s chunks, so an unordered body drops or duplicates rows silently',
      )
    }
  }
  return out
}

/**
 * The refusal that makes a gather safe (ITEM-12) — the parent and the membership must be ONE
 * AXIS, checked BEFORE a single byte of the parent is requested.
 *
 * A membership carrying positions selected out of axis X while the parent column is aligned to
 * axis Y gathers the right COUNT of the wrong rows. Nothing downstream can detect it: both
 * declarations are well-formed, every byte is present, and the picture is complete and
 * plausible. It is the read-side half of the writer's own `derived_from` comparison
 * (`cyto_zarr._membership_entries`) — the same check at the other end of the wire — and it is
 * LOUD because the alternative is an off-by-thousands paint with a clean console.
 */
export function assertMembershipOnParentAxis(
  parentArtifactId: string,
  parentStructure: ArtifactStructure,
  alignedTo: string,
): void {
  const declared = (parentStructure as { aligned_to?: unknown }).aligned_to
  const memberships = (parentStructure as { memberships?: unknown }).memberships
  const digests = new Set<string>()
  if (typeof declared === 'string' && declared !== '') digests.add(declared)
  if (Array.isArray(memberships)) {
    for (const entry of memberships) {
      const to = (entry as { aligned_to?: unknown })?.aligned_to
      if (typeof to === 'string' && to !== '') digests.add(to)
    }
  }
  if (digests.size === 0) {
    throw new UnsupportedArtifactStructure(
      parentArtifactId,
      parentStructure,
      'a gather was requested against a column that declares no axis at all — the membership ' +
        'cannot be checked against it, and an unchecked gather is the failure this refusal exists for',
    )
  }
  if (!digests.has(alignedTo)) {
    throw new UnsupportedArtifactStructure(
      parentArtifactId,
      parentStructure,
      `the membership names axis ${alignedTo.slice(0, 12)}… but this column is aligned to ` +
        `${[...digests].map(d => `${d.slice(0, 12)}…`).join(', ')} — the positions were selected ` +
        'out of one axis and are being gathered out of another, which returns the right NUMBER ' +
        'of the wrong rows',
    )
  }
}

/**
 * GATHER one numeric member to a member subset, CHUNK-WISE (ITEM-14).
 *
 * As each inner chunk arrives from `ZarrArray.chunks()`, only the member rows falling in that
 * chunk's `[offset, offset + len)` window are kept, and the compacted bytes are emitted. So
 * RETAINED MEMORY SCALES WITH THE SUBSET, not with the parent: a 6,000-row population read out
 * of a 1,000,000-row column never holds the million.
 *
 * That is the whole reason this is not `collectStream`-then-filter. The two produce identical
 * final values — which is why TEST-17 measures DURING the stream rather than on the result.
 *
 * No `(lo, hi)` primitive changes and no scatter is added to `zarrReader`: the window test is
 * arithmetic over the slice's own declared `offset`, and `range.rs`'s refusal of a batched
 * range form (*"A list is the batched form, which does not exist. Refuse — never widen."*)
 * stands untouched.
 *
 * `members` MUST be strictly ascending ({@link readMemberIndex} enforces it), which is what
 * lets the walk keep ONE cursor across chunk boundaries instead of re-scanning per chunk.
 */
export async function* streamGatheredNumericBytes(
  artifactId: string,
  structure: ArtifactStructure,
  members: Uint32Array,
  column?: string,
  options: ArtifactStreamOptions = {},
): AsyncGenerator<Uint8Array, void, void> {
  const table = asZarrTable(artifactId, structure)
  const member = resolveMember(artifactId, table, column)
  const array = await openMember(artifactId, member, options)
  throwIfAborted(options.signal)
  // ONE cursor over the ascending member list, carried ACROSS chunks. A member before this
  // chunk's window has already been emitted; a member past its end belongs to a later chunk.
  let at = 0
  for await (const slice of array.chunks(0, array.length)) {
    throwIfAborted(options.signal)
    options.onChunk?.(slice)
    const values = slice.values
    const start = slice.offset
    const end = start + values.length
    // The window is HALF-OPEN. An off-by-one here drops or duplicates the member sitting on a
    // chunk boundary while keeping the count plausible, which is why TEST-18 compares the
    // value SET across a boundary rather than its length.
    let n = 0
    while (at + n < members.length && members[at + n] < end) n++
    if (n === 0) continue
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = Number(values[members[at + i] - start])
    at += n
    // A fresh buffer per emission — `chunks()` warns its values are a view into the cache
    // ("copy anything you keep"), and `out` is a copy by construction.
    yield new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  }
}

/**
 * Stream an `(n × dims)` layout member as the interleaved `[x0,y0,…]` wire bytes viz's
 * `positions` channel consumes — the chunk-granular twin of {@link readPositions}.
 *
 * Chunking may split dimension 0 only (the reader refuses anything else), so every chunk
 * holds the FULL width of a contiguous run of rows: chunk *k* completes whole POINTS, and
 * the byte stream is row-aligned by construction. That is what makes INV-3 hold — chunk
 * *k*'s byte span is exactly rows `[offset/dims, …)` of the same row space every other
 * channel of the dataset indexes by.
 *
 * The clamping matters and is the reader's, not ours: `chunks()` is asked for
 * `[0, array.length)` where `length = product(shape)`, so the fill padding a
 * sharded layout's last chunk carries is trimmed off the final slice. Reading the raw chunk bytes
 * instead would stream that padding as if it were data.
 */
export async function* streamPositionBytes(
  artifactId: string,
  structure: ArtifactStructure,
  member?: string,
  options: ArtifactStreamOptions = {},
): AsyncGenerator<Uint8Array, void, void> {
  const table = asZarrTable(artifactId, structure)
  const declared = resolveMember(artifactId, table, member)
  const array = await openMember(artifactId, declared, options)
  const dims = array.rowElements
  if (dims < 2) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `member "${declared.path}" has ${dims} value(s) per entity — a layout needs at least 2`,
    )
  }
  throwIfAborted(options.signal)
  for await (const slice of array.chunks(0, array.length)) {
    throwIfAborted(options.signal)
    options.onChunk?.(slice)
    const values = slice.values
    if (values.length % dims !== 0) {
      // Cannot happen while the reader refuses a chunk that splits a trailing dimension
      // (`#assertRowChunked`), and is checked anyway: a half-row chunk would shift every
      // later point by a fraction of a row — a plot rather than an error.
      throw new ZarrFormatError(
        `artifact ${artifactId} member "${declared.path}": chunk holds ${values.length} values, not a multiple of ${dims}`,
      )
    }
    if (dims === 2) {
      yield f32ChunkBytes(values)
      continue
    }
    const rows = values.length / dims
    const out = new Float32Array(rows * 2)
    for (let i = 0; i < rows; i++) {
      out[i * 2] = Number(values[i * dims])
      out[i * 2 + 1] = Number(values[i * dims + 1])
    }
    yield new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  }
}

// ── whole tables ────────────────────────────────────────────────────────────────

/** A decoded table: column names + row-major values, addressed `rows[r][c]`. The shape
 *  the workbench's `$data` slices and the pre-ITEM-25 `/read` table arm both produced. */
export interface TableData {
  columns: string[]
  rows: unknown[][]
}

/**
 * One decoded column (ITEM-21).
 *
 * A string or categorical member decodes to a boxed array of labels. A NUMERIC member decodes
 * to the reader's own `TypedArray`, handed on WITHOUT a boxing copy — this union is where the
 * typed representation enters the tree, and it is deliberately expressed as a union rather than
 * widened to `unknown[]`, so every consumer is forced by the type checker to say which it means.
 *
 * Consumers narrow with `isColumn` (`modules/workbench/core/columns/columnCoerce`), never
 * `Array.isArray` — `Array.isArray(new Float32Array())` is **false** and every column guard in
 * the declarative tree fails OPEN, so an unconverted guard drops the column silently.
 */
export type DecodedColumn = unknown[] | ArrayLike<number>

/**
 * A table in its NATIVE columnar shape — `{ <column name>: values }` (ITEM-24).
 *
 * This is what the decode already produces. {@link readTable} then transposes it to row-major,
 * and every declarative consumer transposes it straight back (`columnarFromTable`), so the two
 * passes cancel out while each allocating a full N-length structure. `readColumnarTable` skips
 * both.
 *
 * Since ITEM-21 the saving is TWO-fold, and the second half is the one with teeth: a numeric
 * column also skips the per-value BOXING copy, arriving as the decoder's `Float32Array`. That is
 * why the value type is {@link DecodedColumn} and not `unknown[]` — the row-major
 * {@link readTable} still boxes on transposition, so this reader is the ONLY entry point that
 * yields the typed form, and the split is what keeps the `job.result` / `axis_columns` consumers
 * (which are NOT converted) on the boxed representation by construction rather than by promise.
 */
export type ColumnarTableData = Record<string, DecodedColumn>

/**
 * Read every declared column of a `zarr_v3` table.
 *
 * Columns are read CONCURRENTLY and each column's chunks stream — so a 12-column
 * table is 12 parallel progressive reads, not one blocking fetch of a 2 MB JSON blob
 * (which is what this path did before the columns became Zarr). `onColumn` fires as each
 * column completes, for a consumer that can render partial columns.
 *
 * The row-major transposition at the end is a deliberate cost: it is the shape the
 * existing widget/`derived`-primitive consumers read, so the wire swap is invisible to
 * them. A future consumer wanting columnar should call the per-column readers directly.
 */
export async function readTable(
  artifactId: string,
  structure: ArtifactStructure,
  options: ArtifactReadOptions & { onColumn?: (name: string, values: DecodedColumn) => void } = {},
): Promise<TableData> {
  // A JSON-columnar blob is a table too, and the producer says so: shipping processors write a
  // per-entity column table as a JSON document and declare `opaque("application/json")` for it.
  // Until ITEM-12 the SERVER decoded that — `/read`'s Table arm parsed the blob and transcoded
  // it to Arrow. Deleting the endpoint moved the decode to the client (INV-1), so it has to live
  // HERE, in the function every table consumer already calls. Dispatching on the declaration is
  // this module's whole job; refusing the one encoding those producers emit left the declarative
  // views' table slice unreadable against real output.
  if (structure.encoding === 'opaque') return readJsonTable(artifactId, structure, options)

  const table = asZarrTable(artifactId, structure)
  const members = tableMembers(table)
  if (members.length === 0) {
    // NOT `{columns: [], rows: []}`. An empty result and "this artifact is not a table I
    // can read" are indistinguishable to every consumer downstream — the table renders
    // blank, the derived primitive computes over nothing, and no error reaches a log. That
    // is the failure this branch used to produce for any artifact whose members live
    // somewhere other than `columns`/`arrays`, and INV-2 says absence is an error.
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      'declares no members — a table with nothing in it is a producer bug, not an empty result',
    )
  }

  const decoded = await decodeTableColumns(artifactId, table, members, options)

  const rowCount = decoded.reduce((max, c) => Math.max(max, c.values.length), 0)
  const rows: unknown[][] = new Array(rowCount)
  for (let r = 0; r < rowCount; r++) {
    const rowValues: unknown[] = new Array(decoded.length)
    for (let c = 0; c < decoded.length; c++) rowValues[c] = decoded[c].values[r]
    rows[r] = rowValues
  }
  return { columns: decoded.map(c => c.name), rows }
}

/** Decode every member of a zarr table to `{name, values}` — the shape BOTH table readers build on. */
async function decodeTableColumns(
  artifactId: string,
  table: ZarrTableStructure,
  members: ZarrMember[],
  options: ArtifactReadOptions & { onColumn?: (name: string, values: DecodedColumn) => void },
): Promise<{ name: string; values: DecodedColumn }[]> {
  return Promise.all(
    members.map(async member => {
      // A LABEL, deliberately — `TableData.columns` is what a rendered table shows and what
      // `columnarFromTable` keys the `$data.<col>` slice by, both of which are naming, not
      // addressing. It is NOT an address: `resolveMember` resolves by `path` and only by
      // `path` (INV-4), so a consumer that wants to READ a column back must carry
      // `member.path`, never a string it took out of this array.
      const name = member.name ?? member.path
      const values = await readColumnValues(artifactId, table, member, options)
      options.onColumn?.(name, values)
      return { name, values }
    }),
  )
}

/**
 * A table read in its native COLUMNAR shape, skipping the row-major round-trip (ITEM-24).
 *
 * Identical decode to {@link readTable} — same members, same per-column values, same errors —
 * differing only in that it never builds the row-major intermediate that every declarative
 * consumer immediately transposes back. Two full N-length allocations per read disappear.
 *
 * Duplicate column NAMES collapse last-wins, exactly as `columnarFromTable`'s
 * `out[name] = …` always did; `columns` is a label rather than an address (see `readTable`).
 */
export async function readColumnarTable(
  artifactId: string,
  structure: ArtifactStructure,
  options: ArtifactReadOptions & { onColumn?: (name: string, values: DecodedColumn) => void } = {},
): Promise<ColumnarTableData> {
  if (structure.encoding === 'opaque') {
    // The JSON arm is ALREADY columnar upstream; going through the row-major reader and back
    // would re-introduce exactly the round-trip this function exists to remove.
    const t = await readJsonTable(artifactId, structure, options)
    const out: ColumnarTableData = {}
    t.columns.forEach((name, ci) => {
      out[name] = t.rows.map(row => row[ci])
    })
    return out
  }
  const table = asZarrTable(artifactId, structure)
  const members = tableMembers(table)
  if (members.length === 0) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      'declares no members — a table with nothing in it is a producer bug, not an empty result',
    )
  }
  const decoded = await decodeTableColumns(artifactId, table, members, options)
  const out: ColumnarTableData = {}
  for (const c of decoded) out[c.name] = c.values
  return out
}

/**
 * One member's values, decoded per its DECLARED kind: a categorical yields its LABELS (not its
 * codes), a string column its strings, a numeric column its numbers.
 *
 * ── THE NUMERIC ARM IS THE PRODUCER OF THE TYPED REPRESENTATION (ITEM-21) ────────────────────
 *
 * It used to end in `Array.from(raw, …)`, which allocated a second N-length BOXED array over a
 * `Float32Array` the decoder had just filled — a per-value copy whose only purpose was to make
 * `Array.isArray` answer true. It now hands the decoder's own buffer on.
 *
 * This is the last half of the typed arc: the guards accept typed columns (`isColumn`), the
 * kernels consume them, and `sliceRevision` hashes them — but until this line nothing PRODUCED
 * one, so the typed branch was capability with no caller. Note what it does NOT change: only
 * {@link readColumnarTable} surfaces this value directly. {@link readTable} transposes it into
 * row-major `rows`, and every consumer of THAT (`columnarFromTable`'s `job.result` and
 * `axis_columns` call sites) re-boxes per column — so those paths, which are deliberately not
 * converted, stay boxed by CONSTRUCTION and cannot be silently changed by this line.
 */
async function readColumnValues(
  artifactId: string,
  table: ZarrTableStructure,
  member: ZarrMember,
  options: ArtifactReadOptions,
): Promise<DecodedColumn> {
  if (member.kind === 'string') {
    // A row-major `{columns, rows}` table holds every value by construction, so this is
    // the second (and last) legitimately-eager string read — `readAll()` on purpose.
    return (await openStringColumn(artifactId, table, member.path, options)).readAll()
  }
  if (member.kind === 'categorical') {
    const { codes, categories } = await readCategoricalColumn(artifactId, table, member.path, options)
    return Array.from(codes, code => categories[code] ?? null)
  }
  const array = await openMember(artifactId, member, options)
  const raw = await readWhole(array, options)
  // ITEM-40 — int64/uint64 decode to a `BigInt64Array`/`BigUint64Array`, and a BigInt is NOT a
  // number to any consumer: `typeof v === 'number'` is false, so `asNumsNaNMissing` would yield
  // `NaN` for every row and any numeric criterion would drop the whole column. Widening EXPLICITLY
  // (rather than passing the bigint buffer through) keeps the exact semantics the boxed
  // `typeof v === 'bigint' ? Number(v) : v` had, including its precision loss above 2^53.
  if (raw instanceof BigInt64Array || raw instanceof BigUint64Array) {
    return Float64Array.from(raw as unknown as ArrayLike<bigint>, (v: bigint) => Number(v))
  }
  return raw as ArrayLike<number>
}

// ── JSON-columnar tables (the `opaque` table arm) ───────────────────────────────

/** Is this value a column map — an object whose every member is an array? */
function isColumnMap(value: unknown): value is Record<string, unknown[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.values(value as Record<string, unknown>)
  return entries.length > 0 && entries.every(Array.isArray)
}

/**
 * Locate the column map inside a column-oriented blob.
 *
 * A producer may nest its columns under an ENVELOPE member (`{<envelope>:{col:[…]}}`,
 * alongside non-columnar siblings) or write a bare `{col:[…]}` map. The server resolved
 * this with a hardcoded list of accepted envelope NAMES — the dataframe-member spelling of
 * one particular producer — and carried a standing TODO to move that name into the datatype
 * manifest instead. Porting the name here would have re-imported a domain literal into core,
 * which the app-builtin guard rightly refuses (INV-3), so the envelope is resolved
 * STRUCTURALLY and, where that is ambiguous, from the blob's OWN declaration:
 *
 *   · candidates are the nested members that ARE column maps;
 *   · a declared `columns` list picks between them — the envelope is the candidate that
 *     covers the most declared names (this is what separates the real column map from a
 *     sibling that merely happens to hold arrays);
 *   · with no declaration, one candidate is unambiguous and is taken; SEVERAL is an error
 *     naming them, never a guess at which was meant (INV-2);
 *   · with no nested candidate, the blob object itself is the map.
 *
 * This accepts every shape the hardcoded version did, needs no name to be registered for a
 * new producer, and — unlike a name list — cannot silently pick the wrong member in
 * silence.
 */
function resolveColumnMap(
  artifactId: string,
  structure: ArtifactStructure,
  obj: Record<string, unknown>,
  declaredOrder: string[] | null,
): Record<string, unknown> {
  const located = locateColumnMap(obj, declaredOrder)
  if (!located.ambiguous) return located.map
  throw new UnsupportedArtifactStructure(
    artifactId,
    structure,
    `nests ${located.ambiguous.length} candidate column maps ` +
      `(${located.ambiguous.map(n => `"${n}"`).join(', ')}) and ` +
      'its `columns` list does not single one out — which member holds the table is not a guess',
  )
}

/** The declared column ORDER of a blob, when it carries one. Shared so the classifier and the
 *  reader read the same declaration out of the same field. */
function declaredColumnOrder(obj: Record<string, unknown>): string[] | null {
  return Array.isArray(obj.columns) ? obj.columns.filter((c): c is string => typeof c === 'string') : null
}

/**
 * WHERE the column map lives, with no opinion about what to do when the answer is ambiguous —
 * the pure half of {@link resolveColumnMap}, shared with {@link classifyJsonPayload}.
 *
 * Split out because the two had to agree and were separately stated. A classifier applying its
 * own envelope rules refused blobs the reader decodes correctly (measured: a payload carrying a
 * SECOND nested member of arrays, disambiguated by the declared `columns` list, was called a
 * document) — two hand-maintained copies of one rule, which is the shape this module has
 * already retired twice.
 */
function locateColumnMap(
  obj: Record<string, unknown>,
  declaredOrder: string[] | null,
): { map: Record<string, unknown>; ambiguous?: undefined } | { map?: undefined; ambiguous: string[] } {
  const nested = Object.entries(obj).filter(([, v]) => isColumnMap(v))
  if (nested.length === 0) return { map: obj }
  if (nested.length === 1) return { map: nested[0][1] as Record<string, unknown> }

  if (declaredOrder && declaredOrder.length > 0) {
    const scored = nested
      .map(([name, map]) => ({
        name,
        map: map as Record<string, unknown>,
        covered: declaredOrder.filter(c => Object.hasOwn(map as Record<string, unknown>, c)).length,
      }))
      .sort((a, b) => b.covered - a.covered)
    if (scored[0].covered > 0 && scored[0].covered !== scored[1]?.covered) return { map: scored[0].map }
  }
  return { ambiguous: nested.map(([n]) => n) }
}

/**
 * What an `opaque` JSON blob IS — the two shapes a producer writes, told apart by whether the
 * COLUMNAR reading of it is lossless.
 *
 * `table` — `{columns, rows}`, or a column map (bare or under an envelope) whose members are
 *     all arrays OF THE SAME LENGTH. Every byte of the blob survives the decode.
 * `document` — anything else: a `kind`-tagged object, members of unequal length, members that
 *     are not arrays at all. Several shipping producers emit exactly this.
 *
 * ── WHY THE TEST IS "IS THE COLUMNAR READING LOSSLESS", AND NOT A LOOK-UP OF `kind` ────────
 *
 * The columnar reader zips every array-valued key to `max(len)` and pads the short ones with
 * `null`, and drops every key that is not an array. Applied to a document that produces a
 * plausible, WRONG table: phantom blank rows for the short members, and the discriminator that
 * says which artifact this even is silently gone. Measured on a real producer's bytes:
 * `{kind, sources[2], normalize[0], candidates[1]}` decoded to three columns over TWO rows —
 * one real candidate and one blank — with `kind` absent.
 *
 * So the discriminating question is not "does it carry a magic field" (a producer need not, and
 * core may not know any producer's vocabulary) but "does reading it as columns THROW ANYTHING
 * AWAY". Where it does, the columnar reading is not a lesser answer, it is a wrong one, and the
 * caller is told rather than served an approximation.
 *
 * PURE and exported, because this is the decision a silent drift would re-introduce under a new
 * name — it is asserted directly rather than only through the two readers that consult it.
 */
export function classifyJsonPayload(obj: Record<string, unknown>): 'table' | 'document' {
  // Row-oriented is SELF-DESCRIBING: the producer wrote down both the column names and the
  // rows, so there is nothing to infer and nothing that can be dropped.
  if (Array.isArray(obj.columns) && Array.isArray(obj.rows)) return 'table'

  // An ENVELOPE (`{columns?, <name>:{col:[…]}}`) declares its column map explicitly, so its
  // non-columnar siblings are documented company rather than dropped members — the one case
  // where a top-level non-array is NOT evidence of a document. The envelope is located by the
  // SAME rules the reader uses, sharing `locateColumnMap` rather than re-stating them: a
  // classifier that disagreed with the reader about which member holds the table would refuse
  // blobs the reader decodes correctly, which is how this function first got written.
  const located = locateColumnMap(obj, declaredColumnOrder(obj))
  // AMBIGUOUS is table-SHAPED and the refusal belongs to the reader, which names the rival
  // members. Calling it a document here would answer a precise question with a vague one.
  if (located.ambiguous) return 'table'
  const map = located.map

  const values = Object.values(columnCandidates(obj, map))
  if (values.length === 0) return 'document'
  if (!values.every(Array.isArray)) return 'document'
  const lengths = (values as unknown[][]).map(v => v.length)
  return lengths.every(n => n === lengths[0]) ? 'table' : 'document'
}

/**
 * The members a COLUMN MAP offers as columns — everything except the blob's own `columns`
 * DECLARATION.
 *
 * That exclusion is load-bearing and its absence was a REGRESSION. On the bare-map arm
 * (`{columns:[…], a:[…], b:[…]}`, a shape this reader's own doc advertises as accepted) the
 * located map IS the top-level object, so the declaration — itself an array — was counted as a
 * column and length-compared against the real ones. A 2-column × 3-row table was therefore
 * refused as "ragged" while the 2 × 2 version of the same blob decoded fine: the decoder worked
 * or failed depending on whether the table happened to be SQUARE. No fixture wrote that
 * combination (every `columns:`-carrying fixture nests under an envelope, where the declaration
 * is excluded by construction), which is exactly why it survived.
 *
 * `columns` is only excluded where it IS the declaration — i.e. where it was read as one. A
 * producer whose column is genuinely named `columns` under an ENVELOPE keeps it.
 */
function columnCandidates(
  obj: Record<string, unknown>,
  map: Record<string, unknown>,
): Record<string, unknown> {
  if (map !== obj) return map
  if (!Array.isArray(obj.columns)) return map
  const { columns: _declaration, ...rest } = map
  return rest
}

/** Which members of a would-be table are not columns — the SENTENCE a refusal owes the reader,
 *  so "this is a document" names the evidence instead of asserting a verdict.
 *
 *  Computed over the SAME located map the verdict was computed over, never the top-level object:
 *  with a ragged map under an envelope, inspecting the top level named the envelope member
 *  itself as "not an array" and never mentioned the raggedness that actually caused the refusal. */
function documentEvidence(obj: Record<string, unknown>): string {
  const located = locateColumnMap(obj, declaredColumnOrder(obj))
  const map = located.ambiguous ? obj : columnCandidates(obj, located.map)
  const nonArray = Object.keys(map).filter(k => !Array.isArray(map[k]))
  const arrays = Object.entries(map).filter(([, v]) => Array.isArray(v))
  const lengths = arrays.map(([k, v]) => `${k}[${(v as unknown[]).length}]`)
  const parts: string[] = []
  if (nonArray.length > 0) parts.push(`${nonArray.map(k => `\`${k}\``).join(', ')} ${nonArray.length === 1 ? 'is' : 'are'} not an array, so no column can hold ${nonArray.length === 1 ? 'it' : 'them'}`)
  // RAGGED means the lengths DIFFER — not merely that there are several. The old predicate was
  // `lengths.length > 1`, so every refusal for the non-array reason also carried a fabricated
  // raggedness claim over arrays that were equal, sending an operator to look for a fault that
  // was not there. This sentence is the whole `error` a region surfaces.
  if (new Set(arrays.map(([, v]) => (v as unknown[]).length)).size > 1) {
    parts.push(`its arrays are of unequal length (${lengths.join(', ')})`)
  }
  if (parts.length === 0) parts.push('it declares no columnar members')
  return parts.join('; ')
}

/**
 * Read an `opaque` JSON blob as the DOCUMENT it is — every member, at its own length, with the
 * non-array keys (the discriminator among them) intact.
 *
 * REFUSES a columnar table, by name. That refusal is the point rather than strictness for its
 * own sake: a binding that declared `document` and silently received a table's `{columns, rows}`
 * pair as two document members would render something, and the something would be wrong in the
 * quiet way this whole seam exists to stop. The converse refusal lives in {@link readJsonTable}.
 */
export async function readJsonDocument(
  artifactId: string,
  structure: ArtifactStructure,
  options: ArtifactReadOptions = {},
): Promise<Record<string, unknown>> {
  const obj = await parseJsonObject(artifactId, structure, options)
  if (classifyJsonPayload(obj) === 'table') {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      'is a COLUMNAR TABLE and this read declared a document — every member is a same-length ' +
        'column, so it is a table read that was wanted here, not a document read',
    )
  }
  return obj
}

/** Fetch + parse the blob into a plain object. Shared by both JSON arms so the media-type
 *  refusal, the injected-store path and the parse diagnostics are written ONCE — two copies of
 *  this is how the two arms would drift into accepting different things. */
async function parseJsonObject(
  artifactId: string,
  structure: ArtifactStructure,
  options: ArtifactReadOptions,
): Promise<Record<string, unknown>> {
  // A declared media type that is not JSON is a real mismatch worth NAMING: decoding a
  // TIFF as a table otherwise surfaces as a cryptic parse error about byte 1. An
  // UNdeclared media type is not an error — server-authored rows and the e2e seed both
  // spell opaque without one.
  const mediaType = (structure as OpaqueStructure).media_type
  if (typeof mediaType === 'string' && !mediaType.includes('json')) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `declares media type "${mediaType}" — a JSON read decodes a JSON blob`,
    )
  }

  // An injected store spells "the whole artifact" as the EMPTY member path (the artifact IS
  // the blob), which is how the unit suite drives these shapes; the real path is the same
  // `GET /artifacts/{id}/data` every other opaque read uses.
  let bytes: Uint8Array
  if (options.store) {
    const injected = await options.store.get('')
    if (!injected) throw new WorkstoreHttpError(404, `no blob for artifact "${artifactId}"`)
    bytes = injected
  } else {
    bytes = await readOpaque(artifactId)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch (e) {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `is not parseable as JSON (${e instanceof Error ? e.message : String(e)})`,
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UnsupportedArtifactStructure(artifactId, structure, 'JSON blob is not a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Decode an `opaque` JSON blob into the same row-major `{columns, rows}` a Zarr table read
 * yields, so no consumer can tell which encoding it got.
 *
 * BOTH storage shapes are accepted, as the server's `parse_columnar` accepted them: the
 * row-oriented `{columns, rows}` and the column-oriented `{columns?, <envelope>:{col:[…]}}`
 * (or a bare `{col:[…]}` map). A declared `columns` list fixes the column ORDER — dropping
 * it would reorder every widget's columns for a blob whose map order differs.
 *
 * Values ride through as the JSON types they already are (number / string / null), which is
 * what the Arrow transcode produced downstream (`Float32` → number, `Dictionary<Utf8>` →
 * string, null → null) — with one strict improvement: numbers keep their full f64 precision
 * instead of being narrowed to f32 on the wire.
 */
async function readJsonTable(
  artifactId: string,
  structure: ArtifactStructure,
  options: ArtifactReadOptions & { onColumn?: (name: string, values: unknown[]) => void },
): Promise<TableData> {
  const obj = await parseJsonObject(artifactId, structure, options)

  // ── A DOCUMENT IS REFUSED, NOT ZIPPED (see `classifyJsonPayload`) ────────────────────────
  //
  // This used to zip whatever it was handed: array-valued keys became columns padded to
  // `max(len)`, everything else was dropped. On a real producer's document that rendered a
  // table with a phantom blank row and no discriminator, passing every gate on both sides.
  // The best-effort answer is the defect, so it is not kept under a caveat — the caller is
  // told, deterministically, and `readJsonDocument` is the read it wanted.
  if (classifyJsonPayload(obj) === 'document') {
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      `is a JSON DOCUMENT, not a columnar table — ${documentEvidence(obj)}. Reading it as a ` +
        'table would pad the short members into blank rows and drop the rest; declare a ' +
        'document read instead',
    )
  }

  const declaredOrder = declaredColumnOrder(obj)

  // Row-oriented `{columns, rows}` — already the shape this function returns.
  if (declaredOrder && Array.isArray(obj.rows)) {
    const rows = obj.rows.map(row => {
      const fields = Array.isArray(row) ? row : []
      return declaredOrder.map((_, ci) => fields[ci] ?? null)
    })
    for (const [ci, name] of declaredOrder.entries()) {
      options.onColumn?.(name, rows.map(r => r[ci]))
    }
    return { columns: declaredOrder, rows }
  }

  // Column-oriented. Order from the declared list (restricted to columns actually present),
  // else the map's own key order.
  const map = resolveColumnMap(artifactId, structure, obj, declaredOrder)
  const isColumn = (name: string): boolean => Array.isArray(map[name])
  const names = (declaredOrder ?? Object.keys(map)).filter(isColumn)
  if (names.length === 0) {
    // Same refusal the server made (`NOT_TABLE`), and for the same reason INV-2 gives: an
    // empty table and "these bytes are not a table" are indistinguishable downstream.
    throw new UnsupportedArtifactStructure(
      artifactId,
      structure,
      'has no recognizable columnar data (`rows`, a column-envelope object, or a bare `{col:[…]}` map)',
    )
  }
  const decoded = names.map(name => {
    const values = map[name] as unknown[]
    options.onColumn?.(name, values)
    return values
  })
  // Padded/truncated to one row count, so a ragged blob cannot produce ragged rows.
  const rowCount = decoded.reduce((max, values) => Math.max(max, values.length), 0)
  const rows: unknown[][] = new Array(rowCount)
  for (let r = 0; r < rowCount; r++) {
    rows[r] = decoded.map(values => values[r] ?? null)
  }
  return { columns: names, rows }
}

// ── opaque blobs ────────────────────────────────────────────────────────────────

/** Whole bytes of an `opaque` artifact. Kept here so a caller reaches ONE module for
 *  every artifact read and the dispatch stays in one place; the transport underneath is
 *  the same `GET /artifacts/{id}/data`. */
export async function readOpaque(artifactId: string, memberPath?: string): Promise<Uint8Array> {
  return new Uint8Array(await fetchArtifactRange(artifactId, memberPath))
}

export { WorkstoreHttpError }

/**
 * The DECLARED level set of one categorical member — a METADATA read, never a values read.
 *
 * This is what lets the criteria picker offer a column's categories without downloading the
 * column. Opening a member costs one `zarr.json` fetch and no chunks (`openArtifactArray`), and
 * the levels are declared right there in `attributes.cyto.levels` — the producer writes them as
 * the authoritative set (D10: declared, never inferred from the observed codes), so reading the
 * bodies to re-derive them was always redundant as well as expensive.
 *
 * That distinction is load-bearing, not an optimisation: the affordance of listing a column's
 * categories must not pull its values, because a list is rendered for every column on the axis
 * while the values are wanted for the one or two a criterion names.
 *
 * `undefined` when the member declares none — a numeric column, or a producer that did not
 * declare (which is an error at USE, reported by the reader that needs them, not silently
 * defaulted here).
 *
 * ── A SPLIT-STRING MEMBER IS AN ABSENCE, NOT A FAILURE ──────────────────────────────────────────
 * A `kind: "string"` column is written as a GROUP (`node_type: "group"`) holding `offsets`/`values`,
 * so opening it as an array throws — and the producer stamps such a column's catalog `meta.kind` as
 * `categorical` (`cyto_columns.py` routes every object-dtype pandas Series through
 * `Table.string()`), so the categorical path genuinely arrives here at a group path. The docstring
 * above already promised "absence is an answer, not an error"; it was not true, and the cost was
 * severe: the rejection escaped `Promise.all` in the streaming source's `#buildCatalog`, whose
 * `catalog()` cached the REJECTED promise, and one text column took the entire streaming canvas
 * down for that project until reload.
 *
 * Only `ZarrNotAnArrayError` is caught, and only to answer `undefined`. A malformed member, a 404,
 * or a transport failure still propagates — those are not absences.
 */
export async function readDeclaredLevels(
  artifactId: string,
  memberPath: string,
  options: ArtifactReadOptions = {},
): Promise<readonly string[] | undefined> {
  try {
    const array = await openArtifactArray(artifactId, memberPath, options)
    return array.cyto?.levels
  } catch (error) {
    if (error instanceof ZarrNotAnArrayError) return undefined
    throw error
  }
}
