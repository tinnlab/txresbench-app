// `extensions/data` — the PUBLISHED CONTRACT of the `data` capability (ITEM-10).
//
// This file is the extension's exported surface, the VS Code `extension.exports`
// pattern: core knows only the id string it routes on; the TYPES live here, with
// the extension that publishes them. A consumer does
// `resolveOrThrow<DataApi>(api.capabilities, DATA_CAPABILITY_ID, DATA_CAPABILITY_RANGE)`.
//
// Reads wire to the REAL P1 workstore endpoints: the JSON control plane (catalog +
// `/artifacts`) and ONE byte surface, `GET /artifacts/{id}/data[/{*member}]`. The plane
// below is a dumb authed project-scoped byte-Range server — every decode is the
// consumer's (INV-1; artifact-model ITEM-12 deleted the Tier-2 Selection→Arrow slicer).
//
// ITEM-7 deleted `writeResult`/`writeAnnotation`: they were documented UNCONDITIONAL
// throws (there is no write REST; results are ingested only through the sandbox
// `/outputs` manifest) with no remaining callers, so they are gone rather than carried
// into the new contract as a guaranteed rejection.

import type { ColumnarTableData } from '@/core/workstore'
import type {
  ArtifactCatalogSource,
  ArtifactRow,
  ArtifactValuePreviewSource,
  TypeSelector,
  ValuePreview,
  ValuePreviewRequest,
} from '@/modules/workbench/core'

// `ArtifactRow` is declared by CORE (`core/artifacts/catalog.ts`), not here, because core's
// own engine names it — see that module's header. It is re-exported as part of this
// capability's published surface so a consumer still reads ONE contract file, and the
// dependency runs the legal way round: this extension imports core.
export type { ArtifactRow } from '@/modules/workbench/core'
// Same story for the value-preview shapes (`core/artifacts/valuePreview.ts`): core's own
// `artifact_ref` control names them, so core declares them and this capability's published
// surface re-exports them.
export type { ValuePreview, ValuePreviewRequest } from '@/modules/workbench/core'

/** The broker id this extension publishes under. Core routes on this string and
 *  nothing else (INV-6). */
export const DATA_CAPABILITY_ID = 'data'
/** The published version. */
export const DATA_CAPABILITY_VERSION = '1.0.0'
/** The range every in-tree consumer asks for. */
export const DATA_CAPABILITY_RANGE = '^1'

/** One declared AXIS of the project, with its cardinality (mirrors P1 `AxisSummary`).
 *  `name` is a DECLARED `AxisSpec.name` — `cells`/`genes`/`region`/`comparison`/… —
 *  never an obs/var enum (DEC-6).
 *
 *  ── INV-3: THE HASH IS THE KEY, THE LABEL IS DECORATION ──────────────────────────
 *
 *  An axis IS its key artifact, and `content_hash` is that artifact's — the identity
 *  every client map, lookup and cache key must be built on. `name` is a display LABEL:
 *  two DISTINCT axes may legitimately carry the same one, so a `Map` or a `.find()`
 *  keyed on it folds them together and reports ONE axis where the project has two,
 *  with one of the two lengths silently winning.
 *
 *  The server already derives this list by hash for exactly that reason (it dropped a
 *  name-keyed table to do it). Carrying the hash across this contract is what stops the
 *  invariant from holding on the server side of the wire and nowhere else. */
export interface AxisSummary {
  /** **IDENTITY** (INV-3) — the `content_hash` of the key artifact that IS this axis.
   *  This is the field to key on; see {@link axesByHash} / {@link axisByHash}. */
  content_hash: string
  /** The declared axis LABEL, for DISPLAY. Never a key (INV-3). */
  name: string
  length: number
  /** The axis's ordered KEY SEQUENCE, by digest — what an ALIGNED artifact declares about
   *  itself (ITEM-31). A second identity, not a duplicate of `content_hash`: a producer
   *  cannot name a `content_hash` (ingest mints it after the fact), so a declaration can
   *  only ever carry this one. It rides the catalog so `ArtifactQuery.onAxis` can be asked
   *  WITHOUT first fetching the artifact list the filter exists to narrow. `undefined` when
   *  the key artifact declares none. */
  key_sequence_digest?: string
}

/** The project catalog (mirrors P1 `ProjectCatalog`).
 *
 *  `axes` replaced the `{n_cells, n_genes}` scalar pair. That pair was not a naming
 *  problem but a STRUCTURAL commitment to exactly two axes, in the PUBLISHED contract
 *  of the `data` capability — and the two-axis model does not fit the declaration layer
 *  it is supposed to serve: a `(comparison, gene)` DE table or a `(cluster, cluster)`
 *  graph has no obs/var home, and an image has `(region, channel)`. The list is ordered
 *  by the DECLARED axis order of the project's artifacts' datatypes. */
export interface ProjectCatalog {
  project_id: string
  axes: AxisSummary[]
  artifacts: ArtifactRow[]
}

/** Index a catalog's axes BY IDENTITY (INV-3) — the one place a client turns the axis
 *  list into a map. Keyed by `content_hash`, so two axes carrying the same LABEL stay
 *  two entries; a name-keyed map would have collapsed them to one. */
export function axesByHash(catalog: { axes: AxisSummary[] }): Map<string, AxisSummary> {
  return new Map(catalog.axes.map(a => [a.content_hash, a]))
}

/** The axis a `content_hash` identifies, or `undefined` when the project has none. */
export function axisByHash(
  catalog: { axes: AxisSummary[] },
  contentHash: string | undefined,
): AxisSummary | undefined {
  if (!contentHash) return undefined
  return catalog.axes.find(a => a.content_hash === contentHash)
}

/** Every axis carrying `label`. A LIST, not an option, because a label does not
 *  identify an axis (INV-3) and the honest answer to "which axis is called X" can be
 *  none, one, or several. */
export function axesLabelled(
  catalog: { axes: AxisSummary[] },
  label: string | undefined,
): AxisSummary[] {
  if (!label) return []
  return catalog.axes.filter(a => a.name === label)
}

/**
 * Resolve a declared axis LABEL to the ONE axis it names.
 *
 * This is the one label→axis join the client cannot avoid: a datatype declares its
 * axes by `AxisSpec.name` and carries no `content_hash`, so a consumer holding
 * "this type's row axis is called X" has nothing but the label to look X up with.
 *
 * It is therefore explicitly PARTIAL. `undefined` when NO axis carries the label —
 * and equally when SEVERAL do, because a label that names two distinct axes has not
 * identified either, and returning the first match would assert an identity the label
 * does not carry (INV-3) while inventing a cardinality for the caller (INV-2: absence
 * over a fabricated answer). Callers already treat `undefined` as "not resolvable" and
 * fall back explicitly.
 */
export function axisByLabel(
  catalog: { axes: AxisSummary[] },
  label: string | undefined,
): AxisSummary | undefined {
  const matches = axesLabelled(catalog, label)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * WHAT a declared axis LABEL resolved to — a discriminated result, not
 * `AxisSummary | undefined`.
 *
 * The distinction exists because {@link axisByLabel}'s `undefined` conflates two
 * situations that license OPPOSITE caller behaviour, and every consumer that collapsed
 * them wrote the same bug: `axisByLabel(…) ?? <some other axis>`.
 *
 *   `undeclared` — there was no label to resolve (the datatype declares no axis). Nothing
 *       was asserted, so a caller MAY fall back to the catalog's own declared axis ORDER.
 *       That fallback is POSITIONAL, not name-keyed, which is why it is legitimate here.
 *   `absent` — the label names no axis this project reports. Also silence: the label
 *       contributed no information, so the same positional last resort applies.
 *   `ambiguous` — SEVERAL axes carry the label, so it identifies NONE of them. This is a
 *       CONTRADICTION, not silence, and it is the one case a fallback must not absorb:
 *       every candidate is a real axis with a real cardinality, so any substitute answer
 *       is one entity set's count reported for another's data and stays plausible all the
 *       way down. The server refuses the same input outright (`AXIS_AMBIGUOUS`, see
 *       `workstore/catalog/repository.rs::resolve_axis_key_artifact`); a client that
 *       guesses instead upholds INV-3 on one side of the wire only.
 */
export type AxisResolution =
  | { status: 'resolved'; axis: AxisSummary }
  | { status: 'undeclared' }
  | { status: 'absent'; label: string }
  | { status: 'ambiguous'; label: string; candidates: AxisSummary[] }

/** Resolve a declared axis LABEL, reporting WHY it did not resolve when it did not
 *  ({@link AxisResolution}). The one place a consumer turns an axis label into a
 *  cardinality — `resolution.status === 'resolved' && resolution.axis.length`. */
export function resolveAxisLabel(
  catalog: { axes: AxisSummary[] },
  label: string | undefined,
): AxisResolution {
  if (!label) return { status: 'undeclared' }
  const matches = axesLabelled(catalog, label)
  if (matches.length === 1) return { status: 'resolved', axis: matches[0] }
  if (matches.length === 0) return { status: 'absent', label }
  return { status: 'ambiguous', label, candidates: matches }
}

/**
 * How an ambiguous axis label is REPORTED — worded from the server's `AXIS_AMBIGUOUS`
 * (`resolve_axis_key_artifact`) so the two sides of the wire refuse the same input with
 * the same explanation, and names the candidate IDENTITIES rather than only the label:
 * "this label is ambiguous" is not actionable, "these two artifacts both claim it" is.
 */
export function axisAmbiguousMessage(label: string, candidates: AxisSummary[]): string {
  const detail = candidates.map(a => `${a.content_hash} (length ${a.length})`).join('; ')
  return (
    `AXIS_AMBIGUOUS: ${candidates.length} distinct key artifacts are labelled "${label}", so ` +
    `the label does not identify an axis: ${detail}. An axis IS its key artifact and its ` +
    `identity is that artifact's content hash; picking one of these would align the read ` +
    `against an entity set nobody chose.`
  )
}

export interface ArtifactQuery {
  /** filter to a datatype id or a subtype selector. */
  type?: string
  subtypesOf?: string
  capability?: string
  /**
   * NARROW to the artifacts that declare something about this axis — the axis's IDENTITY,
   * i.e. its key artifact's `key_sequence_digest` (dimension-membership ITEM-31).
   *
   * It NARROWS; it does not decide. Which candidate is OFFERED stays the client's
   * A1/A2/A3/A4 judgment, which is a question over identity, absence and intersection that
   * SQL cannot express — the server's filter is a strict SUPERSET of it by construction
   * (it keeps the legacy scalar spelling and the declares-nothing rows, and drops only
   * rows that positively name a DIFFERENT axis).
   */
  onAxis?: string
}

export interface ColumnRead {
  artifactId: string
  /** the selector, e.g. a feature id (sparse column) or an obs column. */
  selector?: string
}

export interface ArtifactRead {
  artifactId: string
  /**
   * a datatype-appropriate query shape, passed OPAQUE to the plane (mirrors the
   * backend `SchemaReader::Query`, built from the datatype's `selector_map` /
   * capabilities). Kept `unknown` so the contract stays modality-agnostic — the
   * datatype/viewer owns its concrete query shape.
   */
  query?: unknown
}

export interface OpaqueRead {
  artifactId: string
}

/** One artifact read as a COLUMNAR frame (ITEM-42). `structure` is the producer's declaration
 *  when the caller already holds the artifact row — every dispatch below is on it, so passing it
 *  saves a round-trip and passing nothing is still correct (the reader resolves it). */
export interface ColumnarFrameRead {
  artifactId: string
  structure?: unknown
  /**
   * GATHER this column to a member subset before landing it (dimension-membership ITEM-20).
   *
   * Present when the pane's coordinate is a SUBSET of its axis and this column describes the
   * WHOLE axis: the two lengths differ, and painting the column as it stands addresses row *i*
   * of a million where row *i* of six thousand was meant. Absent ⇒ the read is byte-for-byte
   * the read it was.
   *
   * Spelled STRUCTURALLY here rather than imported from viz: this contract is what CORE binds
   * against (`lint-layer-boundary` R2 forbids core → extensions, and core has no business
   * knowing viz's channel vocabulary either), and the extension maps it onto the `members`
   * channel. Independently-readable components, never a delimited string (INV-4).
   *
   * PLURAL (ITEM-11/15): a coordinate resting on two axes has rows from both, and the SEGMENT
   * ORDER is declared by the anchor rather than implied by either membership — a membership is
   * a set and has no order of its own (INV-7). The segments are read and emitted in exactly
   * this array's order; a reader may not sort them.
   */
  members?: {
    /**
     * The segments, in the coordinate's declared order. Spelled INLINE rather than as its own
     * exported interface: the segment shape has exactly one consumer (the `data` extension's
     * reader), and naming it in the barrel would add a public surface entry for a record that
     * nothing outside this contract constructs.
     */
    readonly segments: readonly {
      /** the parent COLUMN artifact this segment's rows come from. Per SEGMENT because a fused
       *  or integrated gather's two segments can be described by two datasets' columns. */
      readonly column: string
      /**
       * WHICH column WITHIN that artifact, when the artifact is a MATRIX rather than a column
       * (dimension-membership ITEM-16/ITEM-19). Absent ⇒ the artifact IS the column, which is
       * every membership gather; present ⇒ the segment is one column of a `sparse_csc` matrix.
       *
       * ── WHY THE SELECTOR HAD TO EXIST HERE, AND WHY IT IS A SEPARATE FIELD ─────────────────
       *
       * Core cannot import this extension (`lint-layer-boundary` R2), so a CORRESPONDENCE read
       * — one entry at column *i* of ds1's matrix and column *j* of ds2's — has to cross this
       * contract. With `column` alone a `{matrix, column j}` parent is NOT EXPRESSIBLE: the read
       * could only name the matrix, and the reader would have to guess which of its columns was
       * meant, or fall to a whole-matrix read. So the selector is carried, and it is carried as
       * its own INDEPENDENTLY READABLE component rather than folded into `column` as
       * `"<id>#<j>"` — an artifact id legitimately contains `#`, and INV-4 forbids a delimited
       * composed id on exactly this path.
       *
       * PER SEGMENT, because the whole point of the correspondence is that the two sides sit at
       * DIFFERENT indices; a per-read selector would state that they sit at the same one, which
       * is the index-identity error that returns a full-length, well-typed, wrong column.
       */
      readonly columnIndex?: number
      /** the axis's IDENTITY — checked against that column's own declaration before a byte is
       *  requested (ITEM-12). */
      readonly alignedTo: string
      /** the artifact holding the ascending index body — the COORDINATE, not the column. */
      readonly artifact: string
      /** the member within it. */
      readonly member: string
      /** how many members — what THIS segment contributes to the gathered length. */
      readonly count: number
      /**
       * The index body is a CORRESPONDENCE SEQUENCE, not a subset's ascending set
       * (dimension-membership ITEM-16/ITEM-19, INV-6/INV-7). An integrated coordinate pairs
       * entry *i* of one axis with an arbitrary entry *j* of the other, so its per-axis body is
       * a declared PERMUTATION that ascending cannot express. Present-and-true ⇒ the body is
       * read WITHOUT the ascending guard and gathered by RANDOM ACCESS (`column[positions[i]]`),
       * which neither drops nor duplicates on an unordered body. Absent ⇒ a subset gather, whose
       * body is ascending and walked in one pass — the guard stands.
       */
      readonly sequence?: boolean
    }[]
  }
}

/** A PROGRESSIVE consumer of `readColumnarFrame` (incremental-landing ITEM-7). Called with each
 *  accumulated prefix (`done: false`) as the stream arrives, then once with the complete frame
 *  (`done: true`). The complete frame is byte-identical to the wholesale return. Omitting it gives
 *  exactly the wholesale read, so every existing caller is unchanged. */
export type ColumnarFrameOnChunk = (frame: ColumnarTableData, done: boolean) => void

/** The BACKEND this capability is bound to (P1 workstore, real endpoints). The shell
 *  may inject one through `WorkbenchHost.planes[DATA_CAPABILITY_ID]` (the gallery/e2e
 *  fake does); otherwise the extension builds the real one. */
export interface DataHost {
  catalog(projectId: string): Promise<ProjectCatalog>
  listArtifacts(projectId: string, query: ArtifactQuery): Promise<ArtifactRow[]>
  /** typed-array column read (byte ranges + a client-side decode). */
  readColumn(read: ColumnRead): Promise<{ values: Float32Array | Uint32Array }>
  /** rich/multi-column read → RAW artifact bytes (caller decodes). */
  readArtifact(read: ArtifactRead): Promise<Uint8Array>
  /** opaque blob read (report/scalefactors/metadata) → raw bytes via the byte-range serve. */
  readOpaque(artifactId: string): Promise<Uint8Array>
  /**
   * A short EXCERPT of one column's values — the read behind "what does this column
   * actually contain", which is what tells an identifier column from a label column in a
   * picker that renders both as a name.
   *
   * Deliberately NOT expressible as a `readColumn` with a small selector: `readColumn`
   * returns a typed numeric array, and the two shapes a text column takes are decoded very
   * differently (a dictionary-encoded column's excerpt is its declared LEVEL SET, which is
   * metadata; an inline-utf8 column's is a windowed byte range). Folding it into an
   * existing read would mean materializing the column to slice it — the exact cost this
   * exists to avoid.
   */
  previewValues(request: ValuePreviewRequest): Promise<ValuePreview | undefined>
}

/** The `data` capability an extension resolves out of the broker.
 *
 *  It `extends` core's narrow {@link ArtifactCatalogSource} port deliberately: core
 *  resolves this capability by id and calls `catalog()` through that port, so the
 *  `extends` makes the two sides' agreement a COMPILE-TIME fact. Change the catalog read's
 *  shape and this file stops compiling, rather than core silently reading `undefined` off
 *  a result that no longer carries `artifacts`. */
export interface DataApi extends ArtifactCatalogSource, ArtifactValuePreviewSource {
  catalog(): Promise<ProjectCatalog>
  artifacts: {
    /** pick compatible artifacts (drives artifact-ref pickers, §4.3). */
    query(sel: ArtifactQuery | TypeSelector): Promise<ArtifactRow[]>
  }
  /** a typed-array column read (layout / feature column / obs / categorical). */
  readColumn(read: ColumnRead): Promise<{ values: Float32Array | Uint32Array }>
  /**
   * a rich / multi-column read → RAW artifact bytes. The wire type is `Uint8Array`
   * and the calling extension decodes it (`@/core/workstore`'s `artifactReader` is
   * the in-tree decoder). Keep this contract lean — do NOT pull a format library in
   * here; there is none in the tree to pull (ITEM-24).
   */
  read(read: ArtifactRead): Promise<Uint8Array>
  /**
   * an opaque blob read (inspect report / scalefactors / metadata) → raw bytes,
   * reusing the plane's byte-range serve. The caller interprets the bytes
   * (JSON / binary) per the datatype.
   */
  readOpaque(read: OpaqueRead): Promise<Uint8Array>
  /**
   * ONE artifact as a columnar frame — `{ column → values }`, with ITEM-21's typed numeric
   * columns preserved.
   *
   * ADDITIVE (ITEM-42), and it exists so the declarative `column_values` slice and the canvas
   * read a column's bytes through the SAME `WorkbenchStreamingSource`: one byte route, one
   * cache, one arrival clock, two consumers with different COMPLETION semantics rather than two
   * paths. Core cannot import the source directly (`lint-layer-boundary` R2 forbids
   * core → extensions), so this capability is the only conforming seam.
   *
   * The LANDING model is unchanged: this resolves whole. What changes is where the bytes come
   * from — see `columnarRead.ts` for what is streamed and what deliberately is not.
   */
  readColumnarFrame(read: ColumnarFrameRead, onChunk?: ColumnarFrameOnChunk): Promise<ColumnarTableData>
  /**
   * Advance the control-plane cache (`catalogCache.ts`) to a new catalog epoch, dropping the
   * cached `catalog()` / `artifacts.query()` reads so the next read refetches. The shell
   * calls it from `WorkbenchContext.refreshCatalog` — the single point the workbench's
   * `catalogEpoch` advances — so a real catalog change (a run's ingest, an attach/detach, a
   * delete) is a cache MISS while a colour-by selection that changes nothing is a hit.
   *
   * OPTIONAL because the cache lives only on the production `createDataCapability` bind: a
   * bare `createDataApi` (a unit fixture, a host that does not wrap it) has nothing to
   * invalidate, and the shell calls it as `setCatalogEpoch?.(epoch)`.
   */
  setCatalogEpoch?(epoch: number): void
}
