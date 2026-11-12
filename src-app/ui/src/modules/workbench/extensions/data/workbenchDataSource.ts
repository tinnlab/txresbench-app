// workbenchDataSource.ts — ITEM-66: the project `DataSource` (the single
// viz-integration seam). Implements `@txresbench/viz`'s domain-agnostic `DataSource`
// (`viz/src/viz-core/data/wire.ts`) over the TxResBench project data plane (the P1
// workstore artifact catalog + the raw-bytes octet endpoints reachable through
// `@/core/workstore`). It is the real-data source ITEM-56 will bind the canvas
// `GridWorkspace` to, AND the coordinate provider that fixes `createHost`'s
// all-NA `embedding()` stub (so `inPolygon`/`inBox` predicates evaluate — W6 Route B).
//
// The reference impl is viz's `FixtureSource` (`viz/src/viz-core/data/fixtures.ts`):
// same method set, same wire framings; only the bytes come from the real octet
// endpoints instead of a generated fixture.
//
// SCOPE: `catalog()`, `positions()`, `continuous()`, `valueColumn()` (color-by-value: a
// CSC feature column) and `categorical()` (an annotation column) are all reachable — the
// catalog surfaces value columns (from the ingest-populated `shape.cols`) and categorical
// columns as composite `<artifactId>#<column>` keys those two methods resolve.
// `table()`/`graph()` (no project data path today) throw a typed `NotReachableError`
// rather than fabricate a path.
//
// `imageUnderlay()` used to be in that list and no longer is (#159). A project's tissue
// RASTER is now a served channel: it is discovered from the producer-declared layout (an
// opaque artifact whose media type is a pyramidal OME-TIFF — never from a datatype id),
// opened over byte RANGES rather than fetched whole, and offered two ways — the tiling
// `imagePixelSource()` the raster pane prefers, and the single coarsest-level texture
// `imageUnderlay()` it falls back to. A project with no raster still refuses, unchanged.
//
// ── READS (artifact-model ITEM-25) ─────────────────────────────────────────────────
//
// Every byte read here goes through `@/core/workstore`'s `artifactReader`, which
// dispatches on the artifact's PRODUCER-DECLARED `structure` and issues byte ranges
// against `GET /artifacts/{id}/data[/{*member}]`. Before ITEM-12 these four methods split
// across two very different wires: `valueColumn`/`categorical` asked the server for a
// Selection and decoded Arrow-IPC; `positions`/`continuous` fetched a whole raw-f32 blob
// and refused outright (`NotReachableError`) if the artifact was multi-file. That refusal
// is why this seam had to move rather than merely being tidied: the producers now emit
// Zarr DIRECTORIES (`txr_columns.write_embedding` / `write_metadata_column`), so
// `is_multifile` is true for every embedding and every metadata column, and the old
// `positions()` threw on all of them.
//
// PROGRESSIVE: `positions()` and `continuous()` accept an `onChunk` through the deps and
// pass it down, so a consumer that wants to paint as data lands can. Chunk arrival IS the
// progressive path (there is no streaming side-channel any more), and an embedding is
// written rows-chunked at full width, so chunk k completes whole POINTS.

import { ApiClient } from '@/api-client'
import { datatypeRegistry } from '@/core/datatypes'
import type { AnnotationType, Datatype } from '@/core/datatypes'
import {
  artifactByteRangeSource,
  declaredDims,
  declaredDimsForDisplay,
  fetchArtifactRange,
  getArtifact as wsGetArtifact,
  getCatalog as wsGetCatalog,
  parseStructure,
  readCategoricalColumn,
  readPositions,
  readSparseColumn,
  tableMembers,
  TEXT_VALUE_KINDS,
  toUint16Codes,
  type ArtifactStructure,
  type OpaqueStructure,
  type ZarrChunkSlice,
  type ZarrMember,
} from '@/core/workstore'
// Type-only: erased at runtime, so this node-safe module never loads viz's deck.gl
// barrel. wire.ts's barrel only re-exports `DataSource`/`DatasetCatalog`/`GraphData`,
// so the remaining wire return shapes are DERIVED from the `DataSource` interface
// itself — perfectly in sync with wire.ts, no unexported-name import needed.
//
// #159 adds `OmeTiffPyramid`, which the barrel DOES export (it is the reader's own public
// result type) — still type-only, so the runtime import of the reader stays where it
// belongs, behind the dynamic `import('@txresbench/viz')` in `defaultDeps`.
import type { DataSource, DatasetCatalog, OmeTiffPyramid } from '@txresbench/viz'
import {
  axisAmbiguousMessage,
  resolveAxisLabel,
  type AxisResolution,
  type AxisSummary,
} from './contract'

type Positions = Awaited<ReturnType<DataSource['positions']>>
type SparseColumn = Awaited<ReturnType<DataSource['valueColumn']>>
type CategoricalColumn = Awaited<ReturnType<DataSource['categorical']>>
type ContinuousColumn = Awaited<ReturnType<DataSource['continuous']>>
type ImageUnderlay = Awaited<ReturnType<DataSource['imageUnderlay']>>
/** The Viv resolution pyramid the raster pane consumes — derived from the wire interface for
 *  the same reason every shape above is: this module must not reach into viv's own packages. */
type ImagePixelSource = Awaited<ReturnType<NonNullable<DataSource['imagePixelSource']>>>
type DataTable = Awaited<ReturnType<DataSource['table']>>
type GraphData = Awaited<ReturnType<DataSource['graph']>>
type CatalogEntry = DatasetCatalog['layouts'][number]

/** The subset of an API `Artifact` this DataSource reads (a P1 catalog row).
 *
 *  ITEM-7 removed `storage_layout` and `shape`. This module used BOTH to answer
 *  questions `structure` answers exactly and they answered only approximately: which
 *  artifacts are sparse matrices (`storage_layout === 'chunked-sparse'`), how many
 *  feature columns one has (`shape.cols`), and which columns a table holds
 *  (`shape.columns`, "empty `{}` at ingest today" — i.e. the answer was usually absent
 *  and every reader had a fallback for it). All three now come off the producer's
 *  declaration. */
export interface DataPlaneArtifact {
  id: string
  datatype: string
  /** manifest-backed multi-file — a Zarr artifact directory. Informational only since
   *  ITEM-25: `structure` says how to read it, and multi-file is the NORMAL case. */
  is_multifile?: boolean
  /**
   * Bytes in the object store (`Artifact.stored_bytes`) — EXACT for a single-blob artifact,
   * and 0 for a gathered one, which owns no blob.
   *
   * Read for exactly one thing (#159): a pyramidal-raster reader opens a file over byte
   * RANGES, so it needs the object's length before it can address the end of it — the last
   * block of a block-aligned read is otherwise an out-of-range span and a 416, which is
   * silent from the rendered output. It is NOT a display size (`logical_bytes` is), and it
   * is deliberately taken from the artifact row rather than discovered by probing.
   *
   * OPTIONAL because the catalog mapper is the only hop that can supply it and an older
   * caller may not; a raster resolution that reaches the reader without one refuses loudly
   * (`UnknownArtifactLengthError`) rather than reading from offset 0 of nothing.
   */
  stored_bytes?: number
  /** Producer-declared decode contract (`Artifact.structure`). Every byte read here
   *  dispatches on it; `NOT NULL` server-side, so its absence is a partial row. */
  structure?: unknown
  /** Producer-declared: what the bytes MEAN, for display (`Artifact.meta`, carried
   *  verbatim by the server, which never interprets it).
   *
   *  Read here for ONE thing: `meta.name`, the producer's own name for a WHOLE-ARTIFACT
   *  column. `structure` cannot supply it — `txr_columns.write_metadata_column` writes
   *  every such column as a one-member table whose member path is the constant
   *  `"values"` — identical for every column in the project — and puts the column's real
   *  name in `meta`. That name is the key
   *  {@link WorkbenchDataSourceDeps.columnLabel} is looked up by, so
   *  without this field a per-column label override cannot address the commonest kind of
   *  column there is.
   *
   *  ITEM-13 adds the SECOND read: `meta.component_columns`, the producer's declaration
   *  that a layout's components are also emitted as that many named 1-D sibling columns
   *  (see {@link declaredComponentColumns} below for the acceptance rule and for why a
   *  shape fact has to ride in `meta`). Still never a decode input — it is resolved to
   *  artifact ids in `catalog()` and the read that follows goes through the ordinary
   *  continuous channel, on those siblings' own declarations. */
  meta?: unknown
  /** ITEM-13 / DEC-8 — the dataset this artifact is STORED IN (`Artifact.dataset_id`), and
   *  the scope the component-column join runs inside.
   *
   *  The artifact's OWN column, not the provenance-derived `source_dataset_id` lineage: it
   *  rides the project catalog already (`ProjectCatalog.artifacts` are bare `Artifact`s,
   *  which carry `dataset_id` and NOT the derived lineage — see `ArtifactCatalogSource`'s
   *  doc-comment on why the overview cannot answer a lineage walk), so this join needs no
   *  second query and no widening of any wire type.
   *
   *  It is also the RIGHT scope, not merely the available one. Materialising a narrowed row
   *  set inserts every gathered artifact with the new dataset's id
   *  (`src-app/server/src/modules/workstore/virtual_dataset.rs:1725`,
   *  `dataset_id: Some(dataset)`), so equality on this column says exactly "these two came
   *  out of the SAME narrowing" — which is the fact the join needs. A shared *source* is
   *  weaker and would match a sibling from a different narrowing of the same upstream data:
   *  the right column name over the wrong rows.
   *
   *  Optional, and absence is NOT a wildcard: a layout carrying no `dataset_id` resolves no
   *  components at all, rather than reaching project-wide for a same-named column belonging
   *  to someone else. */
  dataset_id?: string | null
}

/** The subset of the project catalog this DataSource reads: the project's DECLARED
 *  axes (identity + label + cardinality) and its artifacts. Replaces `{n_cells,
 *  n_genes}` — a structural commitment to exactly two axes, which the declaration layer
 *  (`ArrayDecl.dims` over an OPEN axis set) never made.
 *
 *  The axes are full `AxisSummary`s, `content_hash` included (INV-3), so a same-label
 *  pair arrives here as two axes rather than one. */
export interface DataPlaneCatalog {
  axes: AxisSummary[]
  artifacts: DataPlaneArtifact[]
}

/** The reachable project data-plane reads (injected for tests; default = real
 *  `@/core/workstore` + the P2 datatype lattice). */
/** The project's raster, opened once: which artifact, how long, where it sits, and the
 *  lazily-tiling reader over it. */
interface ResolvedRaster {
  readonly artifactId: string
  readonly byteLength: number
  /** the producer's declared `to_space`, carried verbatim; validated by the reducer. */
  readonly toSpace: readonly number[] | undefined
  /** the producer's declared `coordinate_space` id — the FRAME an overlay binds against (#228). */
  readonly space: string | undefined
  readonly pyramid: OmeTiffPyramid
}

export interface WorkbenchDataSourceDeps {
  getCatalog(projectId: string): Promise<DataPlaneCatalog>
  getArtifact(id: string): Promise<DataPlaneArtifact>
  /**
   * Open a pyramidal raster over the artifact byte plane (#159).
   *
   * The injected boundary is the TRANSPORT, not the decode: the default composes the shipped
   * byte-range source with the shipped reader, and a test substitutes a file-backed byte source
   * so the REAL loader runs against a REAL emitted `.ome.tif`. Mocking the reader itself would
   * leave the one thing that can be subtly wrong — the pixels — untested.
   *
   * `byteLength` is the artifact's `stored_bytes`; the reader clamps its spans against it.
   */
  openPyramid(artifactId: string, byteLength: number): Promise<OmeTiffPyramid>
  /** whole single-file artifact bytes (`GET /api/artifacts/{id}/data`, no Range). Kept
   *  for the OPAQUE case; a Zarr artifact is read through `readPositions`/`readNumeric`. */
  fetchArtifactBytes(id: string): Promise<ArrayBuffer>
  /**
   * Does `datatypeId` advertise `capability`? The catalog channels (layouts /
   * continuous / categorical) are resolved off DECLARED capabilities (DEC-7) — the app
   * knows ZERO domain datatype ids. Default = the P2 registry's capability match
   * (`datatypeRegistry.matches(id, { capabilities: [cap] })`).
   */
  hasCapability(datatypeId: string, capability: string): boolean
  /**
   * The VIEW KINDS `datatypeId` declares, resolved UP the lattice (#229).
   *
   * The second declaration-driven seam beside {@link hasCapability}, and it exists because the
   * first one cannot answer this question: INV-7 forbids an opaque container from declaring a
   * capability at all, so a raster's kind is unreachable through capabilities BY RULE. A viewer
   * is the channel that stays open — see {@link LABEL_MASK_VIEW_KIND}. Default = the P2
   * registry's own resolution (`datatypeRegistry.viewersFor(id)`), the same walk the Rust side
   * is parity-gated against.
   */
  viewKindsFor(datatypeId: string): readonly string[]
  /** Read a sparse (feature) value column → `{row, value}` non-zeros, over three byte
   *  ranges on the declared CSC trio. Injected so tests mock the octet boundary. */
  readSparseColumn(
    artifactId: string,
    col: number,
    structure: ArtifactStructure,
  ): Promise<{ row: Uint32Array; value: Float32Array }>
  /** Read an annotation categorical column (the sole member when `column` is empty) →
   *  codes+categories. Codes stay `Uint32Array` here; the narrowing to the GPU's u16 (and
   *  the cap that makes it lossless) is `toUint16Codes`, applied once in `categorical()`. */
  readCategorical(
    artifactId: string,
    structure: ArtifactStructure,
    column?: string,
  ): Promise<{ codes: Uint32Array; categories: string[] }>
  /** Read a 2-D layout member → interleaved `[x0,y0,…]`. `onChunk` fires per inner chunk
   *  as it lands — the progressive-paint hook (there is no streaming route any more). */
  readPositions(
    artifactId: string,
    structure: ArtifactStructure,
    onChunk?: (slice: ZarrChunkSlice) => void,
  ): Promise<{ positions: Float32Array; length: number }>
  /** Read a numeric column → `Float32Array`, chunk by chunk. */
  readNumeric(
    artifactId: string,
    structure: ArtifactStructure,
    onChunk?: (slice: ZarrChunkSlice) => void,
  ): Promise<Float32Array>
  /**
   * Fires as each inner chunk of a `positions()` / `continuous()` read lands, in order.
   * The seam a surface hooks to repaint progressively instead of holding a spinner:
   * `slice.index`/`slice.total` are known before the first byte, so progress is
   * determinate. Default: absent (the caller simply awaits the whole read).
   */
  onChunk?: (slice: ZarrChunkSlice) => void
  /** OPTIONAL display-label override for one column, keyed by the column's own NAME
   *  (DEC-4) — {@link AxisAnnotation.column}, NEVER {@link AxisAnnotation.name}.
   *
   *  This is all that survives of the datatype's `annotations` block. That block
   *  enumerated the columns a dataset "would" carry, with a `label` and a `capability`
   *  each — and on one real import 8 of its 9 entries did not exist while 64 of the
   *  dataset's 65 columns went unmentioned. The column LIST now comes from the artifacts
   *  (see `annotationsForAxis`); only the human-facing name needed a home, because a raw
   *  column name → a display label is not derivable from the data.
   *
   *  ── THE KEY IS THE NAME, NOT THE ADDRESS ────────────────────────────────────────
   *
   *  This used to be consulted with the catalog's CHANNEL ID — `<artifactId>#<member>`
   *  for a member column and the BARE ARTIFACT ID for a whole-artifact one. Artifact ids
   *  are server-minted UUIDs, so the map shape the `Datatype.labels` doc comment shows
   *  could not match anything a real deployment produced, and the override was inert for
   *  exactly the case it exists for: the metric columns a run emits are whole-artifact
   *  columns, one artifact each. The key is now the column name the entry reports as
   *  `column`, so an author reads it off the same surface that renders
   *  the label. A column with no derivable name is NOT consulted at all — a lookup that
   *  cannot be addressed is worse than no lookup, because it looks wired.
   *
   *  It is a NAME, so it does not identify one artifact: two artifacts carrying a column
   *  of the same name on one axis are renamed together. That is inherent to a name-keyed
   *  map and is the trade DEC-4 makes for a key an author can write down.
   *
   *  A lookup cannot assert a column exists — silent for anything it does not mention —
   *  which is exactly the property the list lacked. */
  columnLabel?(datatypeId: string, name: string): string | undefined
  /**
   * The axis whose entries are the POSITIONS a layout/column of `datatypeId` has one
   * value per — the datatype's DECLARED entity axis. Registry DATA
   * (`Datatype.entity_axis`, resolved by {@link resolveEntityAxis}); this module knows
   * ZERO domain axis names.
   *
   * `undefined` when the datatype declares no axes, declares SEVERAL and names none of
   * them as its entity axis, or is unknown to the registry — in which case the caller
   * falls back to the catalog's own declared axis order. That fallback is licensed by
   * SILENCE only; it is not what this returns when a declaration is present and wrong.
   *
   * This is what replaced `cat.n_cells`: a column's length is the length of ITS
   * datatype's entity axis, not of one globally-privileged axis that only single-cell
   * data has. It used to be `axes[0].name` — a position standing in for a declaration;
   * {@link resolveEntityAxis} has the three declared axis sets that made wrong.
   */
  rowAxisFor(datatypeId: string): string | undefined
}

/** The catalog capability-channel that supplies runtime option values for a declared
 *  annotation TYPE — the same channel mapping the datatype manifests use (categorical /
 *  ordinal → the categorical channel; continuous → the continuous-column channel; a value
 *  (expression) column → the value channel). Used to synthesize the channel for a
 *  producer-declared column (which declares only `{name,type,axis}`). */
function capabilityForType(type: AnnotationType): string {
  switch (type) {
    case 'continuous':
      return CAP_CONTINUOUS
    case 'categorical':
    case 'ordinal':
      return CAP_CATEGORICAL
    case 'value':
      return 'value-column'
  }
}

/** One annotation column of an axis, resolved for a primitive to render from
 *  (dimension-primitives ITEM-5). The `type` drives the control shape (INV-4); the
 *  `label` is the user-facing text (from DATA); `name` is the runtime column the value
 *  plane resolves from; `capability` names the catalog channel that supplies its
 *  options. `available` records whether ≥1 runtime catalog column backs it today. */
export interface AxisAnnotation {
  /** The ADDRESS — the catalog channel key the value plane resolves this column from
   *  (`categorical()` / `continuous()` / `valueColumn()` all take exactly this string).
   *  Composite (`<artifactId>#<member>` / `<artifactId>#<colIndex>`) or a bare artifact
   *  id, per channel. Not a display string and not a lookup key: it carries an artifact
   *  id, which is a server-minted UUID nobody can write down in advance. */
  name: string
  label: string
  /** The column's own NAME inside its artifact — the key an author writes in a
   *  `Datatype.labels` map / {@link WorkbenchDataSourceDeps.columnLabel} (DEC-4), and the
   *  reason that key is computable at all: it is reported here, on the same entry that
   *  renders the label.
   *
   *  `undefined` when the producer declared no name for the column (a whole-artifact
   *  column whose `meta` carries none) — the label lookup is then skipped rather than
   *  consulted with `name`, which is an address and can never match an author's map. */
  column?: string
  type: AnnotationType
  capability: string
  available: boolean
}

/** The DECLARED capabilities the catalog channels dispatch on (DEC-7) — the app carries
 *  NO domain datatype id. A contributed datatype opts a project artifact into a channel
 *  by declaring the matching capability in its manifest. */
const CAP_PLOTTABLE_XY = 'plottable-xy' // → layouts (embedding scatter); formerly isA(_, 'embedding')
/**
 * The DISPATCH MARKER that says a set of positions is a SPATIAL element rather than a computed
 * layout — the capability §6.2 mints for exactly this, and which the spatial type package
 * declares on its coordinates kind. Named as a CAPABILITY and never as a datatype id: the app
 * carries zero of the domain lattice, and the leaf package's own zero-core guard scans this file
 * for exactly that (it caught an earlier draft of this comment).
 *
 * It is what enforces INV-1's second half. SpatialData's axiom, adopted verbatim by §5, is
 * *"Images, Labels, Points and Shapes MUST have one or more coordinate systems and coordinate
 * transformations, while Tables CAN NOT have a coordinate system or coordinate transforms."* An
 * ordinary computed layout is a Table's companion, not a Point element; harvesting a
 * `coordinate_space` off
 * one — because some producer happened to write the key — would let it be painted onto tissue.
 * Capability-driven (DEC-7): no hardcoded domain datatype id anywhere.
 */
const CAP_SPATIAL_COORDINATES = 'spatial-coordinates'
const CAP_CONTINUOUS = 'continuous-column' // → continuous columns; formerly isA(_, 'metadata-column')
const CAP_CATEGORICAL = 'categorical' // → categorical columns; formerly isA(_, 'clustering')

/**
 * THE RASTER CHANNEL DISPATCHES ON THE DECLARED LAYOUT, NOT ON A CAPABILITY (#159).
 *
 * Every other channel above resolves off a declared CAPABILITY, which is the house rule
 * (DEC-7). The raster cannot, and the reason is not laziness — it is that BOTH of the
 * ordinary routes are closed by shipped guards, in opposite directions:
 *
 *   * a raster container declares NO capability, and is forbidden from declaring one. The
 *     contribution gate derives the container set from the lattice and asserts that an
 *     opaque descendant's capability list is EMPTY; two earlier attempts at a marker
 *     capability were removed under exactly that rule, and the second was inert besides.
 *   * and this file may not name the datatype id. The vocabulary guard derives its
 *     forbidden token set from the package manifests themselves, so every contributed
 *     id is a raw-substring violation here.
 *
 * What is left is what the byte plane itself routes on: the PRODUCER-DECLARED LAYOUT.
 * An artifact whose `structure` says "opaque bytes, and their media type is this" is
 * readable as a pyramidal raster whatever it is called and whoever contributed it — which
 * is the same property that makes the whole storage layout cost zero core code. A reader
 * already refuses a non-matching media type on this very field, so this is the existing
 * dispatch key, used the existing way.
 */
const RASTER_MEDIA_TYPE = 'image/tiff'
const RASTER_MEDIA_PARAM = 'application=ome'

/**
 * The declared VIEW KIND that says a raster's pixel values are an INDEX, not a picture (#229).
 *
 * ── WHY A VIEW KIND IS SPELLABLE HERE WHERE A DATATYPE ID IS NOT ───────────────────────────
 * The block above records the two guards that leave "the producer-declared layout" as the only
 * discovery route, and they are why this file may not name a contributed id. Both are about
 * DOMAIN vocabulary, and neither reaches this one:
 *
 *   * The type package's own `test_a_new_kind_costs_zero_core_code` scans this tree for every
 *     id that package contributes. A `view_kind_id` is not one — it is PRESENTATION
 *     vocabulary, the name of a renderer, which this workspace necessarily knows the same way
 *     it knows `kind: 'table'`.
 *   * `lint-no-domain-in-builtin.mjs` forbids biological nouns AND every contributed datatype
 *     literal, the latter DERIVED by reading the manifests. That derivation is also why a
 *     "generic" datatype tier cannot be the answer here: a token like a shared labels tier
 *     passes this lint only while nothing declares it, and declaring it is the whole idea —
 *     at which point the consumer may no longer spell it. Measured, not argued.
 *
 * ── WHAT IT IS DECLARED AGAINST, SO THIS IS NOT A PRIVATE HANDSHAKE ────────────────────────
 * The type package that owns the two raster kinds declares this on the index one, through the
 * SAME `viewers` channel a coordinate set uses to reach its renderer, and that package's own
 * suite (`test_raster_kind_discovery.py`) pins three things: that the two OME-TIFF kinds are
 * otherwise declared IDENTICALLY — so nothing else could be carrying the distinction — that this
 * token is vocabulary a domain-blind consumer is allowed to hold, and that the constant below
 * still matches what the manifest declares. Rename either side and that suite goes red.
 *
 * The rule is one-sided and FAILS OPEN, matching the posture {@link declaresDisplayRole}
 * already takes: a raster that declares THIS is refused as an underlay; every other raster,
 * including one whose producer declares nothing, stays renderable. Excluding the undeclared
 * case would trade a wrong picture for a certain absent one.
 */
const LABEL_MASK_VIEW_KIND = 'label-mask'

/** Cap on feature value-columns surfaced in the catalog picker (a full feature axis can
 *  run to tens of thousands; the client index→NAME map is a follow-up, so v1 lists
 *  indexed columns). */
const VALUE_COLUMN_CAP = 50

/** A `value`/`categorical` channel key is a composite `<artifactId>#<column>` so the
 *  channel resolves to a specific (artifact, column) without a separate lookup.
 *
 *  Exported for {@link import('./workbenchStreamingSource').WorkbenchStreamingSource}, which
 *  serves the SAME composite keys this catalog mints and must split them the same way. A second
 *  copy of "where does the artifact id end" is how the two planes drift apart. */
export function parseChannelKey(key: string): { artifactId: string; column: string } {
  const hash = key.lastIndexOf('#')
  if (hash < 0) return { artifactId: key, column: '' }
  return { artifactId: key.slice(0, hash), column: key.slice(hash + 1) }
}

/**
 * The datatype's DECLARED entity axis — the axis whose entries a value of that type has
 * exactly ONE PER, so its cardinality is a layout's point count and a column's dense
 * length. `undefined` = the datatype does not say, and nothing here invents an answer.
 *
 * ── WHY THIS IS NOT `axes[0]` ─────────────────────────────────────────────────────
 *
 * It was, and that was a leak with no token to grep for. `Datatype.axes` is an IDENTITY
 * list — `AxisSpec` says the core knows an axis has a `name` and a `key_label` and never
 * what the axis REPRESENTS — so taking element 0 as "the entity axis" asserted a
 * semantic the contract disclaims, and every point count, layout length and dense column
 * extent downstream rested on it.
 *
 * It was already producing wrong answers on axis sets DECLARED IN THIS TREE, not
 * hypothetically:
 *   · the microscopy image fixture (`fixtures/imageDatatype.ts`) declares four axes of
 *     which the first THREE are raster dimensions, so its entity axis resolved to a
 *     raster dimension. The axis a value of it has one per is the one declared LAST.
 *   · two CONTRIBUTED composite kinds (`geneset/collection`, `de/result`) declare their
 *     axes in one order and bind them in their PRIMARY array in the other, so a column
 *     of either is dense over the axis they declare SECOND. Compare each `axes:` block
 *     with the `dims:` of the array below it in that datatype's manifest.
 * None of those surfaced, because a wrong entity axis reports a plausible NUMBER.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────
 *
 *   1. `entity_axis` when the datatype DECLARES it and it names one of that datatype's
 *      own axes. A declaration naming an axis the datatype does not declare is not
 *      honored — it is a stale/typo'd manifest, and the build gate
 *      (`processor_manifest.rs::validate_parsed`) fails it there; here it degrades to
 *      the silent branch rather than resolving a label the type never claimed.
 *   2. otherwise the SOLE axis when the datatype declares exactly ONE. This is not
 *      position 0 in disguise: with one element there is no choice to make, so no
 *      semantic is being asserted. It is what keeps a single-axis contributed column
 *      datatype working with nothing to declare.
 *   3. otherwise NOTHING — several axes and no declaration is a question this module may
 *      not answer. It is WARNED (once per datatype id) because the caller's fallback for
 *      silence is positional on the CATALOG's axes, so an undeclared multi-axis type
 *      degrades to exactly the class of guess this function exists to remove, and that
 *      has to be recoverable from the console rather than merely invisible.
 */
export function resolveEntityAxis(dt: Datatype | undefined): string | undefined {
  const axes = dt?.axes
  if (!axes || axes.length === 0) return undefined
  const declared = dt?.entity_axis
  if (typeof declared === 'string' && declared.trim() !== '') {
    if (axes.some(a => a.name === declared)) return declared
    warnEntityAxisOnce(
      dt.id,
      `declares entity_axis "${declared}", which is not one of its declared axes`,
      axes.map(a => a.name),
    )
    return undefined
  }
  if (axes.length === 1) return axes[0].name
  warnEntityAxisOnce(dt.id, 'declares several axes and no entity_axis', axes.map(a => a.name))
  return undefined
}

/** One warning per datatype id — the resolution is asked once per artifact per catalog
 *  build, so an unguarded `console.warn` would repeat the same fact tens of times. */
const entityAxisWarned = new Set<string>()
function warnEntityAxisOnce(id: string, why: string, names: string[]): void {
  if (entityAxisWarned.has(id)) return
  entityAxisWarned.add(id)
  console.warn(
    `[workbench] no entity axis: datatype "${id}" ${why}`,
    names,
    '— reads of its artifacts fall back to the catalog`s own axis order',
  )
}

/** A data-plane read the client cannot satisfy yet (an honest gap, not a fabrication). */
export class WorkbenchDataSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkbenchDataSourceError'
  }
}
export class NotReachableError extends WorkbenchDataSourceError {
  constructor(what: string) {
    super(`${what} is not reachable from the client data plane yet`)
    this.name = 'NotReachableError'
  }
}

/**
 * The real reads, and WHICH of them declare what they expect (ITEM-29).
 *
 * `readNumeric` goes through the TYPED read surface — `ApiClient.Workstore.readColumn`
 * with `expect: 'numeric'`, so the producer's DECLARED member kind is compared against
 * what this channel is about to do with the bytes, and a mismatch throws naming both
 * before a data byte moves. That check is not decoration here: `readNumericColumn`
 * coerces WHATEVER member it is handed to `Float32Array`, so a `categorical` member
 * reaching the continuous channel used to paint its CODES as a continuous ramp — a
 * plausible wrong picture with nothing raised anywhere. Costs no extra request: the
 * declaration is read off the `structure` this method already holds, and when a member
 * omits its `kind` the array open that resolves it is the SAME one the read then reuses
 * out of `artifactReader`'s shared `MEMBER_ARRAYS` cache.
 *
 * The other three deliberately do NOT, because their expectation is not statable in
 * either vocabulary — a token `expect` there would be a comparison of a value against
 * itself. `readPositions` is a SHAPE read (`(n × dims)` → interleaved xy) allocated at the
 * member's own declared width, so a fixed `expect: 'float32'` would hard-fail a
 * legitimately-wider producer; `readCategorical` serves a channel the catalog fills from
 * BOTH `categorical` and `string` members, and `expect` takes one literal; a CSC column is
 * three members with non-interchangeable roles. See the "WHERE THE PRODUCTION READ PATHS
 * ENTER" block in `core/workstore/typedRead.ts` for the full reasoning.
 */
function defaultDeps(): WorkbenchDataSourceDeps {
  return {
    getCatalog: projectId => wsGetCatalog(projectId),
    getArtifact: id => wsGetArtifact(id),
    // Dynamically imported so the TIFF reader (and the codec stack under it) stays out of the
    // main bundle for every project that has no raster — which is almost all of them. The same
    // shape the workstore's own pyramid seam uses.
    openPyramid: async (artifactId, byteLength) => {
      const { loadOmeTiffPyramid } = await import('@txresbench/viz')
      return loadOmeTiffPyramid(artifactByteRangeSource(artifactId, byteLength))
    },
    fetchArtifactBytes: id => fetchArtifactRange(id),
    hasCapability: (datatypeId, capability) =>
      datatypeRegistry.matches(datatypeId, { capabilities: [capability] }),
    viewKindsFor: datatypeId => datatypeRegistry.viewersFor(datatypeId).map(v => v.view_kind_id),
    readSparseColumn: (artifactId, col, structure) => readSparseColumn(artifactId, col, structure),
    readCategorical: (artifactId, structure, column) =>
      readCategoricalColumn(artifactId, structure, column),
    readPositions: (artifactId, structure, onChunk) =>
      readPositions(artifactId, structure, undefined, { onChunk }),
    readNumeric: (artifactId, structure, onChunk) =>
      ApiClient.Workstore.readColumn({ id: artifactId, expect: 'numeric', structure, onChunk }),
    // A datatype no longer declares its columns (INV-5) — `axes` carries identity only
    // (`name`, `key_label`). Both annotation lookups therefore read the ARTIFACTS that
    // actually landed on the axis, each of which stamps its own kind and has that stamp
    // VERIFIED by the conformance gate.
    //
    // What this replaces was wrong in both directions on real data: on one real
    // import, 8 of the datatype's 9 declared annotations did not exist, while the
    // dataset carried 65 metadata columns the declaration never mentioned. Reading the
    // artifacts is 65-for-65 by construction, and a column typed by no declaration
    // (a user's own annotation upload, a custom QC metric) is filterable for the first
    // time.
    //
    // The trade the phase-2 audit flagged: types are known AFTER a run, not before. A
    // column that does not exist cannot be filtered or grouped on, so nothing is lost —
    // but callers must tolerate the set GROWING as runs complete rather than being
    // fixed at load.
    // The entity axis is the one the DATATYPE DECLARES by name (`entity_axis`) — never a
    // position in its axis list. See `resolveEntityAxis` for the rule and for what the
    // positional form got wrong on data already in the tree.
    rowAxisFor: datatypeId => resolveEntityAxis(datatypeRegistry.get(datatypeId)),
    /** Optional display-label overrides, keyed by column name (DEC-4). A lookup, not a
     *  schema claim: silent for a column it does not mention, so it cannot assert a
     *  column exists — which is the property that made the old `annotations` list wrong. */
    columnLabel: (datatypeId, name) =>
      datatypeRegistry.get(datatypeId)?.labels?.[name] ?? undefined,
  }
}

function labelFor(a: DataPlaneArtifact): string {
  return `${a.datatype} · ${a.id.slice(0, 8)}`
}

/**
 * The producer's DECLARED name for a WHOLE-ARTIFACT column (`meta.name`), or `undefined`
 * when it declared none.
 *
 * `structure` cannot answer this. `txr_columns.write_metadata_column` writes each such
 * column as a one-member table whose member path is the constant `"values"` — identical
 * for every column in the project — and returns the real name on the `meta` half of the
 * pair. So `meta.name` is the ONLY place the name exists, and it is a producer
 * declaration like every other fact this module reads.
 *
 * Deliberately narrow: a non-string, empty or absent `name` yields `undefined` (no
 * coercion, no fallback to the artifact id — an id is an address, and handing one to a
 * name-keyed lookup is the defect this exists to close).
 */
function declaredColumnName(a: DataPlaneArtifact | undefined): string | undefined {
  const meta = a?.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const name = (meta as { name?: unknown }).name
  return typeof name === 'string' && name.trim() !== '' ? name : undefined
}

/**
 * The COMPONENT COLUMNS a producer declared for a layout artifact
 * (`meta.component_columns`) — the NAMES of the 1-D sibling columns whose values ARE its
 * components, one per component, in component order. `undefined` for an artifact that
 * declared none, or declared something this reader refuses.
 *
 * ── WHY THE DECLARATION IS IN `meta` AND NOT IN `structure` ────────────────────────────
 *
 * Because `structure` does not survive a narrowing. Materialising a narrowed row set
 * GATHERS each source artifact and mints the result a FRESH declaration
 * (`src-app/server/src/modules/workstore/virtual_dataset.rs:1688-1705` →
 * `gathered_structure`, `:574-641`): one `values` column of `shape: [n_kept]`,
 * `arrays: []`, for every non-sparse source — while `meta` is copied VERBATIM (`:1714`)
 * along with the `datatype` (`:1729`). A 2-D layout put through a narrowing therefore
 * arrives declaring ONE dimension and still advertising `plottable-xy`, and the
 * interleaved-`positions` channel has no 2-D member left to serve. `meta` is the only
 * channel the producer's own statement of its shape still exists in. DEC-9.
 *
 * ── WHY THIS RULE IS WRITTEN TWICE, AND WHAT KEEPS THE TWO HONEST ─────────────────────
 *
 * `core/runtime/axisSource.ts::declaredComponentColumns` is the same rule on the SELECTION
 * side (it is what lets a `dims: 2` narrowing keep a gathered layout). The two are not one
 * function because an extension may not import past core's barrel
 * (`scripts/lint-layer-boundary.mjs` R1) and that barrel does not publish core's runtime —
 * `extensions/data/` carries zero boundary violations today and this is not the change that
 * introduces one. The duplication is therefore deliberate and BOUNDED: the accepted shape
 * is pinned identically on both sides (`axisSource.test.ts` for selection, this module's
 * suite for the render half), because a declaration one side accepts and the other refuses
 * is exactly the offered-but-unrenderable state the whole mechanism exists to prevent.
 *
 * Fails closed, never throws — `catalog()` is a LISTING and one malformed `meta` must not
 * take the project's channels with it. Accepted ONLY as ≥2 non-empty, DISTINCT strings: a
 * repeated name would point two components at ONE column and paint a perfect diagonal,
 * which is wrong and looks like data. Names are returned VERBATIM because they are joined
 * against another producer declaration (`meta.name`) below, and normalising one side of a
 * join is how the two sides stop matching.
 */
function declaredComponentColumns(a: DataPlaneArtifact): readonly string[] | undefined {
  const meta = a.meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined
  const declared = (meta as { component_columns?: unknown }).component_columns
  if (!Array.isArray(declared) || declared.length < 2) return undefined
  const names: string[] = []
  for (const entry of declared) {
    if (typeof entry !== 'string' || entry.trim() === '') return undefined
    if (names.includes(entry)) return undefined
    names.push(entry)
  }
  return names
}

/**
 * Is this artifact's DECLARED structure a pyramidal raster this app can open?
 *
 * Structural only: `encoding: opaque` plus a media type whose type is `image/tiff` and whose
 * parameters carry `application=ome`. Parsed rather than string-compared, so an equivalent
 * spelling (`image/tiff;application=ome`, a different parameter order, different case) resolves
 * and a plain non-OME `image/tiff` — which the pyramid reader would refuse anyway — does not.
 *
 * Note what is deliberately NOT consulted: `datatype`. See {@link RASTER_MEDIA_TYPE}.
 */
function declaresRaster(structure: ArtifactStructure | undefined): boolean {
  if (!structure || structure.encoding !== 'opaque') return false
  const declared = (structure as OpaqueStructure).media_type
  if (typeof declared !== 'string') return false
  const parts = declared.split(';').map(part => part.trim().toLowerCase())
  const [type, ...params] = parts
  // Parameter values may be QUOTED (`application="ome"`) — a legal spelling of the identical
  // media type, and one a string comparison silently rejects.
  const normalized = params.map(p => p.replace(/\s+/g, '').replace(/"/g, ''))
  return type === RASTER_MEDIA_TYPE && normalized.includes(RASTER_MEDIA_PARAM)
}

/** The producer's declared full-resolution extent, when it states one — used ONLY to order
 *  candidates, never to describe the texture (which comes from the file). */
function declaredExtentArea(a: DataPlaneArtifact): number {
  const meta = a.meta
  if (!meta || typeof meta !== 'object') return 0
  const extent = (meta as { extent?: unknown }).extent
  if (!extent || typeof extent !== 'object') return 0
  const w = (extent as { width?: unknown }).width
  const h = (extent as { height?: unknown }).height
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0 ? w * h : 0
}

/**
 * Does this artifact's producer declare it as something MEANT TO BE LOOKED AT?
 *
 * ── THE PROBLEM THIS NARROWS, STATED HONESTLY ──────────────────────────────────────────────
 * {@link declaresRaster} matches a layout, and a SEGMENTATION LABEL raster declares byte-for-byte
 * the same one: opaque bytes, the same media type, one file. The two kinds are distinguishable
 * only by their datatype id, which this workspace may not read. So a project holding both would
 * choose between a tissue image and a label mask by extent and then by artifact id — a
 * deterministic, arbitrary, silently-wrong picture the moment a labels producer ships.
 *
 * The producer does state something usable: its own `meta.role`, which the emitter writes as the
 * DISPLAY role of the raster (a full-detail view, an overview). A label mask is not a display
 * derivative and carries no such role. So a candidate that declares one is PREFERRED over one
 * that does not.
 *
 * It is a preference and not a filter, deliberately: a raster whose producer declares no role is
 * still renderable, and excluding it would trade a hypothetical wrong picture for a certain
 * absent one. This narrows the ambiguity; it does not close it.
 *
 * ── AND IT IS NO LONGER THE ONLY SIGNAL (#229) ─────────────────────────────────────────────
 * "Closing it needs the kinds to be distinguishable by something a consumer is allowed to read,
 * which is a question for the type package" — that question was answered, and the answer is
 * {@link LABEL_MASK_VIEW_KIND}. An index raster is now EXCLUDED from the candidate set outright,
 * so this preference has one job left: ordering two rasters that are both meant to be looked at
 * (a full-detail view and its overview). It is kept rather than folded in because those two are
 * a real pair a single import emits, and a producer that declares no view kind at all still gets
 * the fail-open behaviour described above.
 *
 * NOTE the name collision, because it is a real trap: `Artifact.role` is a COLUMN meaning the
 * promotion tier (`artifact` / `intermediate`). This reads the producer's `meta.role`, which is
 * a different field with a different vocabulary, and the two must never be conflated.
 */
function declaresDisplayRole(a: DataPlaneArtifact): boolean {
  const meta = a.meta
  if (!meta || typeof meta !== 'object') return false
  return typeof (meta as { role?: unknown }).role === 'string'
}

/** The producer's declared placement (`to_space`), carried through as DATA and validated by the
 *  reducer, not here — this function's job is to find the key, not to judge it. */
function declaredPlacement(a: DataPlaneArtifact): readonly number[] | undefined {
  const meta = a.meta
  if (!meta || typeof meta !== 'object') return undefined
  const to = (meta as { to_space?: unknown }).to_space
  return Array.isArray(to) ? (to as number[]) : undefined
}

/**
 * The producer's declared FRAME (`meta.coordinate_space`) — the id that says which shared
 * coordinate space this artifact's numbers are stated in (#228; design §4 binding (2), §6.6).
 *
 * ── READ OFF A FULL ROW, NOT A LISTING ROW, AND THE FIRST CUT OF THIS GOT IT WRONG ────────────
 * `compact_declaration` (`dataset/models.rs:288`) is a SIZE bound over a producer declaration.
 * The obvious half is the ARRAY cap — it drops every array longer than four, so a six-element
 * affine read off a summary row arrives MISSING, which is why `openRaster` takes the placement
 * off the full artifact row. The half that is easy to miss, and that this comment used to argue
 * the wrong way about, is that it ALSO keeps only the first `DECL_MAX_KEYS = 8` keys IN KEY ORDER
 * and truncates a string value past `DECL_MAX_VALUE_CHARS = 120`. A `coordinate_space` id is a
 * string and so is NOT immune: a listing row can lose it to the key cap or mangle it to the char
 * cap, and a MANGLED id is worse than a missing one — it is a spurious refusal indistinguishable
 * from two artifacts genuinely being in different frames.
 *
 * So both halves of the declaration come off the FULL row (`spatialFrames`), for the bounded set
 * of artifacts that declare a spatial coordinate capability. Where this is still called on a
 * listing row it is a fallback behind that read, never the primary.
 *
 * A non-string value is IGNORED rather than coerced: `String(undefined)` is `"undefined"`, and two
 * artifacts that each stringify a missing key would then "agree" on a frame neither declared.
 */
function declaredSpace(a: DataPlaneArtifact): string | undefined {
  const meta = a.meta
  if (!meta || typeof meta !== 'object') return undefined
  const space = (meta as { coordinate_space?: unknown }).coordinate_space
  return typeof space === 'string' && space.length > 0 ? space : undefined
}

/**
 * A `DataSource` bound to one project. Deps are injected so tests drive it over a fake
 * data plane (mock only the octet/catalog boundary — never the decode logic).
 */
export class WorkbenchDataSource implements DataSource {
  private readonly projectId: string
  private readonly deps: WorkbenchDataSourceDeps
  private catalogCache?: Promise<DataPlaneCatalog>

  constructor(projectId: string, deps: Partial<WorkbenchDataSourceDeps> = {}) {
    this.projectId = projectId
    this.deps = { ...defaultDeps(), ...deps }
  }

  /**
   * Cached project catalog (one fetch per instance — the declared axes + artifacts).
   *
   * The memo is DROPPED on rejection. It used not to be, which made every retry above it a lie:
   * the raster resolver clears its own memo so a transient failure is retried, and the retry ran
   * straight back into this same permanently-rejected promise. A cached rejection is a failure
   * that outlives its cause.
   */
  private projectCatalog(): Promise<DataPlaneCatalog> {
    if (!this.catalogCache) {
      this.catalogCache = this.deps.getCatalog(this.projectId).catch(e => {
        this.catalogCache = undefined
        throw e
      })
    }
    return this.catalogCache
  }

  /**
   * THE PROJECT'S RENDERABLE RASTER, resolved once per source (#159).
   *
   * Memoized on the INSTANCE, which is one per project (`buildProjectSources` memoizes the
   * source itself), because `catalog()` and `imagePixelSource()` and `imageUnderlay()` all
   * need the same opened file and two panes on one raster must not each re-open it. A FAILED
   * resolution is not cached as permanent — the promise is dropped so a transient read error
   * does not condemn the pane for the life of the session, which is the same stance
   * `WorkbenchStreamingSource.catalog()` takes on its own failure.
   *
   * Resolves to `null` — not a throw — when the project simply has no raster. That is the
   * ordinary case for almost every project and it is not an error.
   */
  private rasterCache?: Promise<ResolvedRaster | null>

  private resolveRaster(): Promise<ResolvedRaster | null> {
    if (!this.rasterCache) {
      this.rasterCache = this.openRaster().catch(e => {
        // Drop the memo so this is retried, then re-throw to the caller that asked. Each
        // public entry point decides for itself whether a raster failure is fatal
        // (`imageUnderlay`/`imagePixelSource`: yes, the caller asked for pixels) or must
        // degrade (`catalog`: no, a listing cannot take the project down for one row).
        this.rasterCache = undefined
        throw e
      })
    }
    return this.rasterCache
  }

  /**
   * Find the raster, read its length + placement off the ARTIFACT ROW, and open the pyramid
   * over byte ranges.
   *
   * ── WHY THE SINGLE-ROW FETCH AND NOT THE CATALOG ROW ────────────────────────────────────
   * `stored_bytes` and the full `meta` both come from `deps.getArtifact(id)`. The placement is
   * a SIX-element array, and the summary-row projection this app also consumes compacts
   * declarations by dropping every array longer than four — so a `to_space` read from a summary
   * arrives MISSING rather than short, and a consumer that fell back to identity on a missing
   * key would place the raster at array-index units with nothing anywhere saying so. Taking
   * both from the row that carries them verbatim removes the question.
   */
  private async openRaster(): Promise<ResolvedRaster | null> {
    const cat = await this.projectCatalog()
    const rasters = (cat.artifacts ?? []).filter(a => declaresRaster(this.declaredStructure(a)))
    // #229: an INDEX raster shares this container exactly and is not a picture — its values are
    // keys into an entity axis, read nearest-neighbour with no interpolation and no windowing.
    // Refused here rather than merely deprioritised, because "chosen last" still means "chosen"
    // for a project whose only raster is a mask, and painting one as tissue is a plausible wrong
    // picture with nothing anywhere saying so.
    const candidates = rasters.filter(a => !this.declaresIndexRaster(a))
    if (candidates.length < rasters.length) {
      console.info(
        '[workbench] raster candidates excluded: their datatype declares an index (label-mask) ' +
          'view kind, so they are not tissue images',
        this.projectId,
        rasters.filter(a => this.declaresIndexRaster(a)).map(a => a.id),
      )
    }
    if (candidates.length === 0) return null

    // A DETERMINISTIC pick, because an import emits more than one (a full-detail raster and a
    // small overview of the same field of view). Largest declared extent wins — strictly more
    // information over the same ground — and the artifact id breaks every tie, so the rule
    // names exactly one row and two loads of the same project agree. Ordering by anything
    // that is not a total order is how two identical projects render different pictures.
    const ordered = [...candidates].sort(
      (x, y) =>
        // A producer-declared DISPLAY ROLE first — the only signal available that separates a
        // raster meant to be looked at from one that merely shares its container shape.
        Number(declaresDisplayRole(y)) - Number(declaresDisplayRole(x)) ||
        declaredExtentArea(y) - declaredExtentArea(x) ||
        (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    )
    const chosen = ordered[0]
    if (ordered.length > 1) {
      console.info(
        '[workbench] project has several renderable rasters; the largest declared extent was chosen',
        this.projectId,
        { chosen: chosen.id, alternatives: ordered.slice(1).map(a => a.id) },
      )
    }

    // The FULL row: `stored_bytes` (exact for a single blob) and the uncompacted `meta`.
    const row = await this.deps.getArtifact(chosen.id)
    const byteLength = row.stored_bytes ?? chosen.stored_bytes
    // A POSITIVE INTEGER, not merely "not undefined". The field's own documentation says it is
    // ZERO for a gathered artifact, which owns no blob — and `0 ?? x` is `0` while
    // `0 === undefined` is false, so the first version of this guard tested only the value the
    // wire type says cannot occur and waved through the one that can. A length of 0 reaches a
    // range reader as "read from offset 0 of nothing".
    if (typeof byteLength !== 'number' || !Number.isInteger(byteLength) || byteLength <= 0) {
      throw new WorkbenchDataSourceError(
        `raster artifact "${chosen.id}" carries no usable stored byte length (${String(byteLength)}) — ` +
          'a range reader cannot address the end of an object whose size it does not know, an ' +
          'unclamped read of the last block is a 416, and a length of 0 reads nothing at all. ' +
          'Both are silent from the rendered output.',
      )
    }
    const pyramid = await this.deps.openPyramid(chosen.id, byteLength)
    return {
      artifactId: chosen.id,
      byteLength,
      toSpace: declaredPlacement(row) ?? declaredPlacement(chosen),
      // Off the SAME full row as the placement, for the same reason and with one extra: the two
      // are one declaration (`coordinate_space` names the frame, `to_space` places this raster in
      // it), and reading the halves from two different rows is how they come to disagree.
      space: declaredSpace(row) ?? declaredSpace(chosen),
      pyramid,
    }
  }

  // Defensive capability classification (a fresh registry may not know a datatype yet).
  // Capability-driven (DEC-7): NO hardcoded domain datatype id — a contributed type opts
  // an artifact into a catalog channel by declaring the capability.
  private hasCap(dt: string, capability: string): boolean {
    try {
      return this.deps.hasCapability(dt, capability)
    } catch {
      return false
    }
  }

  /**
   * Does this artifact's DATATYPE declare that its pixels are an INDEX (#229)?
   *
   * Defensive in the same way — and for the same reason — as {@link hasCap}: a fresh registry
   * legitimately may not know a datatype yet, and the fail-open answer here (`false`, "treat it
   * as a picture") is the posture {@link LABEL_MASK_VIEW_KIND} documents. An artifact with no
   * datatype string cannot be classified at all and takes the same branch.
   */
  private declaresIndexRaster(a: DataPlaneArtifact): boolean {
    const dt = a.datatype
    if (typeof dt !== 'string' || dt === '') return false
    try {
      return this.deps.viewKindsFor(dt).includes(LABEL_MASK_VIEW_KIND)
    } catch {
      return false
    }
  }

  /**
   * The artifact's PRODUCER-DECLARED decode contract, parsed.
   *
   * Deliberately NOT defensive — unlike `hasCap`/`rowAxisOf` above, which fall back
   * because a fresh registry legitimately may not know a datatype yet. `structure` is
   * `NOT NULL` on the row (ITEM-5) and it is the only thing that says how to read the
   * bytes: a fallback here would mean guessing an encoding, which is the exact inference
   * INV-2 forbids and the failure mode (silently-wrong pixels) is invisible.
   */
  private structureOf(id: string, meta: DataPlaneArtifact): ArtifactStructure {
    return parseStructure(id, meta.structure)
  }

  /**
   * One artifact's parsed declaration, on the READ contract (throws for an artifact whose
   * `structure` will not parse — see {@link structureOf}).
   *
   * Exists for the streaming source, which dispatches on exactly the same declaration these
   * pull methods do and must reach it through the same `deps.getArtifact` — so a test that
   * injects the octet boundary injects it ONCE, and the two planes cannot disagree about what
   * an artifact is. It is the whole of "expose the deps the streaming source shares".
   */
  async structureFor(id: string): Promise<ArtifactStructure> {
    return this.structureOf(id, await this.deps.getArtifact(id))
  }

  /**
   * The artifact's declaration for CATALOG use — `undefined` (with the reason logged)
   * when it cannot be parsed, instead of throwing.
   *
   * `structureOf` above is the READ path and throws by design: a read of one artifact
   * that cannot be decoded must fail loudly at that artifact. `catalog()` is a listing
   * over every artifact in the project, and one undeclared row must not take the whole
   * canvas catalog with it. The error is still SURFACED (`console.warn` naming the
   * artifact and what it declared) and the artifact contributes NO channels — it is
   * dropped, never guessed at, so nothing downstream sees a fabricated column.
   */
  private declaredStructure(a: DataPlaneArtifact): ArtifactStructure | undefined {
    try {
      return parseStructure(a.id, a.structure)
    } catch (e) {
      console.warn('[workbench] artifact excluded from the catalog', a.id, e)
      return undefined
    }
  }

  /** The members an artifact DECLARES, or `[]` for anything that is not a Zarr table
   *  (a CSC matrix and an opaque blob both declare no member list to enumerate). */
  private declaredMembers(a: DataPlaneArtifact): ZarrMember[] {
    const structure = this.declaredStructure(a)
    if (structure?.encoding !== 'zarr_v3' || structure.kind !== 'table') return []
    return tableMembers(structure)
  }

  /**
   * The axis an artifact's COLUMNS sit on, exactly as its producer declared it in
   * `structure` — or `undefined` when the declaration says nothing about an axis.
   *
   * This is a different question from {@link rowAxisOf}, which asks the DATATYPE
   * REGISTRY what axis a type's first dimension binds. That one answers "how long is a
   * read of this artifact" for a type the project knows; this one answers "which axis
   * does this artifact's column BELONG to", and it must come off the artifact itself:
   * two artifacts of the same datatype legitimately sit on different axes (one metadata
   * column per axis is exactly what an import writes).
   *
   * Two declaration shapes, one per producer entry point:
   *
   *   `table`      → the SINGULAR `axis`. Every member of a table shares ONE axis by
   *                  construction — `txr_zarr.Table(root, axis=…)` stamps the group's
   *                  `axis` and each member entry's from the same `self.axis` — so the
   *                  table-level key is the whole answer and a per-member one would be a
   *                  second copy of it.
   *   `sparse_csc` → `axes[0]`, the ROW axis (`txr_csc.write_csc_zarr(axes=(row, col))`
   *                  — an import declares the two axes its matrix spans). A value column
   *                  is ONE column's values ACROSS the row entries — column `j`'s
   *                  non-zeros are ROW indices, spanned by `indptr[j]..indptr[j+1]`, so
   *                  `axes[1]`
   *                  names the set the columns are drawn FROM, not the set they are
   *                  dense OVER. `valueColumn()` reads the same fact from the other end
   *                  when it densifies against the row axis.
   *   `opaque`     → nothing. Bytes with a media type declare no structure at all.
   *
   * A declaration that will not parse is `undefined` too, and for the same reason as an
   * absent one: this is a LISTING, and it must not throw the project's channels away
   * over one row. The caller reports the artifact on every axis and SAYS SO; see there.
   *
   * The comparison the caller makes is LABEL to LABEL — a structure declares an axis by
   * name and carries no `content_hash`, and the requested `axis` is a label as well — so
   * it inherits INV-3's caveat that a label does not identify an axis. Unlike
   * {@link resolveRowAxis} that is not resolvable here and does not need to be: nothing
   * is being turned into a cardinality, so two same-labelled axes simply share a column
   * list rather than one silently standing in for the other.
   */
  private declaredAxisOf(a: DataPlaneArtifact): string | undefined {
    let structure: ArtifactStructure
    try {
      structure = parseStructure(a.id, a.structure)
    } catch {
      return undefined
    }
    if (structure.encoding !== 'zarr_v3') return undefined
    const declared = structure.kind === 'sparse_csc' ? structure.axes?.[0] : structure.axis
    return typeof declared === 'string' && declared.trim() !== '' ? declared : undefined
  }

  /** The DECLARED row axis of an artifact's datatype (defensive: a fresh registry may
   *  not know the datatype yet). The axis whose length is this artifact's point count.
   *
   *  This is a LABEL — a datatype declares `AxisSpec.name` and carries no
   *  `content_hash`, so {@link resolveRowAxis} below performs the documented label→axis
   *  join. */
  private rowAxisOf(a: { datatype: string }): string | undefined {
    try {
      return this.deps.rowAxisFor(a.datatype)
    } catch {
      return undefined
    }
  }

  /**
   * Resolve an artifact's declared row-axis LABEL against the project's declared axes,
   * reporting WHY it did not resolve when it did not (`AxisResolution`).
   *
   * ── INV-3: A REFUSAL STAYS A REFUSAL ──────────────────────────────────────────────
   *
   * Every reader of this used to be `axisLength(cat, this.rowAxisOf(x)) ?? cat.axes[0]?.length
   * ?? 0`, and that `??` is what made the hardening of `axisByLabel` (which correctly
   * REFUSES a label naming two axes) worse than useless: the refusal came back as
   * `axes[0]`, i.e. as a name-keyed guess wearing a positional disguise. With declared axes
   * `[{columns, 32000}, {rows, 1000}, {rows, 5000}]` and an artifact whose datatype
   * declares its row axis as `rows`, the label is ambiguous, the resolution refuses — and
   * the old expression answered 32000, the cardinality of the axis at index 0 (which
   * nothing here is aligned to), as the point count AND as the dense length of a value
   * column. Every number downstream stayed plausible.
   *
   * Returning the RESOLUTION rather than a `number | undefined` is what stops that shape
   * from being writable again: an `undefined` cannot distinguish "the label said nothing"
   * (silence — the positional last resort is legitimate) from "the label named two axes"
   * (a contradiction — nothing may stand in), so the callers below dispatch on `status`.
   */
  private resolveRowAxis(cat: DataPlaneCatalog, a: { datatype: string }): AxisResolution {
    return resolveAxisLabel(cat, this.rowAxisOf(a))
  }

  /**
   * The row-axis length a READ of `meta` is dense over, or `undefined` when the label
   * said nothing (`undeclared`/`absent` — the caller's own positional/format fallback
   * then applies).
   *
   * THROWS on `ambiguous`. A read that cannot identify its own entity set has to fail:
   * `positions()` would infer `dims` from an unrelated axis's cardinality and
   * `valueColumn()` would report one axis's length for another axis's non-zeros, and
   * neither failure is visible in the result. `catalog()` — a LISTING, which must not
   * throw the whole project's channels away over one row — degrades instead; see there.
   */
  private rowAxisLengthForRead(
    cat: DataPlaneCatalog,
    meta: { datatype: string },
    what: string,
  ): number | undefined {
    const resolution = this.resolveRowAxis(cat, meta)
    if (resolution.status === 'resolved') return resolution.axis.length
    if (resolution.status === 'ambiguous') {
      throw new WorkbenchDataSourceError(
        `${what}: ${axisAmbiguousMessage(resolution.label, resolution.candidates)}`,
      )
    }
    return undefined
  }

  /**
   * D20 / INV-26, the row of its change table that was never built: which two CONTINUOUS
   * columns a layout's positions are, when the layout has no 2-D member to serve.
   *
   * `CatalogEntry.components` and the adapter that reads it have shipped since ITEM-12
   * (`libs/viz/src/viz-core/data/streamingAdapter.ts:53-93` streams each named key through
   * the continuous channel and INTERLEAVES the two into one `[x0,y0,…]` buffer, inheriting
   * that channel's masking, so no mask logic exists here or there). Nothing in production
   * ever set the field — both producers of `layouts[]` omitted it — so a layout with no 2-D
   * member had no servable positions path at all. This is the producer.
   *
   * ── WHEN IT SPEAKS ───────────────────────────────────────────────────────────────────
   *
   * Only for a layout whose STRUCTURE declares fewer than two components AND whose producer
   * declared component columns. Structure wins wherever it speaks: an artifact declaring its
   * own `(n × 2)` member keeps the interleaved-`positions` channel exactly as before, which
   * is every layout in every project shipped to date (nothing emitted
   * `meta.component_columns` before ITEM-8). The gathered row is the case this exists for —
   * `virtual_dataset.rs:1688-1705` re-mints its declaration as a single 1-D `values` column
   * and copies `meta` verbatim (`:1714`), so the declaration is all that is left of its
   * width. It is also the SAME declaration `axisSource.ts::declaredComponentCount` narrows
   * on, so a layout is offered exactly when it can be drawn.
   *
   * ── THE JOIN, AND WHY IT REFUSES RATHER THAN GUESSES (DEC-8) ──────────────────────────
   *
   * A producer cannot name an artifact id — ids are minted at ingest — and this row carries
   * no output id, so the only address available is the column's own declared NAME, scoped to
   * the artifacts in the SAME DATASET that carry the continuous-column capability. The
   * producer owns uniqueness of those names within its dataset, which it trivially has.
   *
   * The scope is the artifact's own {@link DataPlaneArtifact.dataset_id}, not a shared
   * lineage. A narrowing inserts the gathered layout and its gathered siblings under the new
   * dataset's id (`virtual_dataset.rs:1725`), so equality here says "these came out of the
   * same narrowing" — the precise fact the join needs. A shared SOURCE would additionally
   * match a sibling from a DIFFERENT narrowing of the same upstream data, which is a column
   * of the right name over the wrong rows: exactly the confident-wrong-picture failure the
   * fail-closed rule below exists to refuse. An absent `dataset_id` matches nothing, for the
   * same reason: an unknown scope is not a wildcard.
   *
   * A name resolving to anything but EXACTLY ONE sibling sets NO components at all, and says
   * so once. Taking the first match is the tempting alternative and it is the worse failure:
   * `core/workstore/artifactReader.ts:429-431` states the rule this follows — *"the first one
   * is a guess, and a silently-wrong column is worse than an error"*. A wrong component here
   * does not error anywhere; it paints a confident, wrong picture. Refusing leaves the layout
   * on the unservable interleaved path, which fails visibly.
   */
  private resolveComponentColumns(
    layout: DataPlaneArtifact,
    arts: readonly DataPlaneArtifact[],
  ): readonly string[] | undefined {
    // The declaration is checked FIRST, so an artifact that declares nothing — i.e. every
    // artifact in the tree today — costs one property read and this method is otherwise
    // inert. It also keeps `declaredDimsForDisplay`'s warning off the common path: that
    // helper reports an unparseable declaration, and the value-column loop below already
    // reports the same row once.
    const declared = declaredComponentColumns(layout)
    if (!declared) return undefined
    // `declaredDims` reports an artifact's dimensions IN AXIS ORDER, so the SECOND entry is
    // its component width — the same read `axisSource.ts::declaredComponentCount` performs,
    // which is what keeps offering and drawing keyed on one answer. Named rather than
    // indexed: `[1]` here would say nothing about which of the two it is.
    const [, structuralComponents] = declaredDimsForDisplay(layout.id, layout.structure)
    // A structure that states a real width owns the answer, and the interleaved-`positions`
    // channel serves it — which is every layout shipped to date. Only a declaration that has
    // lost its width (the gathered row) falls through to the producer's names.
    if (structuralComponents !== undefined && structuralComponents >= 2) return undefined
    // An unknown scope resolves NOTHING. Written as an early return rather than folded into
    // the predicate so that `undefined === undefined` can never quietly become a match and
    // pair a dataset-less layout with every other dataset-less artifact in the project.
    const dataset = layout.dataset_id
    if (dataset == null) {
      console.warn(
        '[workbench] layout components unresolved: the layout declares component columns but ' +
          'no dataset to resolve them in — an unknown scope is not a wildcard, so no ' +
          'components are set',
        this.projectId,
        layout.id,
      )
      return undefined
    }
    const siblings = arts.filter(
      a => a.dataset_id === dataset && this.hasCap(a.datatype, CAP_CONTINUOUS),
    )
    const ids: string[] = []
    for (const name of declared) {
      const hits = siblings.filter(s => declaredColumnName(s) === name)
      if (hits.length !== 1) {
        console.warn(
          '[workbench] layout components unresolved: the declared component column names ' +
            `${hits.length} sibling column(s) in this artifact's own dataset, not exactly ` +
            'one — no components set, so the layout is not served as two columns',
          this.projectId,
          layout.id,
          name,
          hits.length,
        )
        return undefined
      }
      // The bare artifact id, which is the key `continuousColumns` below mints and the key
      // `continuous()` resolves (a whole-artifact column: the artifact IS the column, so
      // there is no member half to address). A composite `<id>#<member>` would be rejected
      // by that method, and the adapter reads these through exactly that channel.
      ids.push(hits[0].id)
    }
    return ids
  }

  /**
   * The FRAME of every SPATIAL coordinate artifact in the project (#228) — its `coordinate_space`
   * and its own `to_space`, read off each artifact's FULL row.
   *
   * ── WHY A FULL ROW PER ARTIFACT, WHEN DEC-3 BOUNDS `catalog()` TO ONE READ ─────────────────
   * Because the declaration cannot survive the listing. `compact_declaration` drops arrays over
   * four items (the affine) and keeps only the first eight keys in key order, truncating strings
   * past 120 chars (the id). A frame read from a listing row is therefore either MISSING or
   * QUIETLY WRONG, and a quietly wrong frame is a spurious refusal indistinguishable from two
   * artifacts genuinely being in different spaces.
   *
   * The cost is bounded by the number of SPATIAL COORDINATE artifacts — not by the number of
   * layouts, and not by the number of artifacts. On a Visium import that is one. The gate is the
   * declared CAPABILITY, which is a datatype-level fact and therefore immune to compaction, and
   * it is the same gate that enforces INV-1: an ordinary computed layout is never asked.
   *
   * A row that fails to read is skipped, not fatal: a listing may not take the project's layouts
   * down for one artifact (the rule `declaredStructure` already follows), and a missing frame is
   * a REFUSAL downstream rather than a fabricated placement.
   */
  private spatialFramesCache?: Promise<Map<string, { space?: string; toSpace?: readonly number[] }>>

  private spatialFrames(
    arts: readonly DataPlaneArtifact[],
  ): Promise<Map<string, { space?: string; toSpace?: readonly number[] }>> {
    // MEMOIZED ON THE INSTANCE, which is one per project, for the same reason `resolveRaster` is:
    // `catalog()` is NOT itself memoized and has many callers, so an un-cached read here would
    // pay its round trips per CALL rather than per project. A rejection is not remembered — the
    // whole promise is dropped so a transient control-plane failure does not condemn the project's
    // frames for the life of the session (the stance `projectCatalog` and `resolveRaster` take).
    if (!this.spatialFramesCache) {
      this.spatialFramesCache = this.readSpatialFrames(arts)
        .then(({ frames, complete }) => {
          // A PARTIAL answer is not remembered either, and that is the half a plain
          // `.catch()` cannot reach: each artifact's read is caught individually so one bad row
          // cannot take the listing down, which means the outer promise RESOLVES on a failure
          // and the memo would keep the degraded map forever. One blinked control-plane request
          // and every spatial pane in the project refuses silently for the life of the tab.
          if (!complete) this.spatialFramesCache = undefined
          return frames
        })
        .catch(e => {
          this.spatialFramesCache = undefined
          throw e
        })
    }
    return this.spatialFramesCache
  }

  private async readSpatialFrames(arts: readonly DataPlaneArtifact[]): Promise<{
    frames: Map<string, { space?: string; toSpace?: readonly number[] }>
    /** did EVERY spatial artifact's row read succeed? A partial answer must not be memoized. */
    complete: boolean
  }> {
    const out = new Map<string, { space?: string; toSpace?: readonly number[] }>()
    let complete = true
    const spatial = arts.filter(
      a => this.hasCap(a.datatype, CAP_PLOTTABLE_XY) && this.hasCap(a.datatype, CAP_SPATIAL_COORDINATES),
    )
    await Promise.all(
      spatial.map(async a => {
        try {
          const row = await this.deps.getArtifact(a.id)
          const space = declaredSpace(row) ?? declaredSpace(a)
          const toSpace = declaredPlacement(row)
          if (space === undefined && toSpace === undefined) return
          out.set(a.id, {
            ...(space === undefined ? {} : { space }),
            ...(toSpace === undefined ? {} : { toSpace }),
          })
        } catch (e) {
          complete = false
          console.warn(
            '[workbench] could not read a spatial coordinate artifact`s frame; its points will ' +
              'not be overlaid on a raster (a refusal, not a fabricated placement)',
            this.projectId,
            a.id,
            e,
          )
        }
      }),
    )
    return { frames: out, complete }
  }

  async catalog(): Promise<DatasetCatalog> {
    const cat = await this.projectCatalog()
    const arts = cat.artifacts ?? []
    const spatialFrames = await this.spatialFrames(arts)
    // plottable-XY artifacts → deck layouts.
    const layouts: CatalogEntry[] = arts
      .filter(a => this.hasCap(a.datatype, CAP_PLOTTABLE_XY))
      .map(a => {
        const entry: CatalogEntry = { id: a.id, kind: 'layout' as const, label: labelFor(a) }
        // ITEM-13: present ONLY for a layout with no 2-D member of its own to serve, so
        // absence still means the interleaved-`positions` channel, unchanged. Spread
        // conditionally rather than assigning `undefined` — an entry carrying the key with
        // no value reads as a declaration that there are none.
        const components = this.resolveComponentColumns(a, arts)
        // #228: the layout's declared FRAME, resolved from its FULL row above. Spread
        // conditionally: an entry carrying `space: undefined` reads as a declaration that there
        // is none, and the binding treats "declares none" and "declares nothing" as the same
        // refusal only because neither is ever spelled as a present-but-empty value.
        const frame = spatialFrames.get(a.id)
        const withComponents = components ? { ...entry, components } : entry
        return frame ? { ...withComponents, ...frame } : withComponents
      })
    // continuous-column artifacts read as dense per-cell continuous columns (below).
    const continuousColumns: CatalogEntry[] = arts
      .filter(a => this.hasCap(a.datatype, CAP_CONTINUOUS))
      .map(a => ({ id: a.id, kind: 'continuous' as const, label: labelFor(a) }))
    // categorical columns — each keyed as a composite `<artifactId>#<columnName>` so the
    // picker's selection resolves to the exact (artifact, column) `categorical()` reads
    // (H2). The names are the artifact's DECLARED members (ITEM-7): a table declares
    // every member it holds, so the composite key always names one and the old bare
    // `<artifactId>#` fallback is gone with the `shape.columns` it stood in for. That
    // fallback was not a convenience — it was a latent bug: `categorical('<id>#')`
    // resolves the SOLE member, so on the two-member clustering table `demo-analysis`
    // actually writes (`cell` + `cluster`) the only key the catalog offered threw.
    const categoricalColumns: CatalogEntry[] = arts
      .filter(a => this.hasCap(a.datatype, CAP_CATEGORICAL))
      .flatMap(a =>
        // WHICH members: the ones a categorical read can decode BY DECLARATION —
        // `categorical` (a declared level set) and `string` (coded on read). A `numeric`
        // member is the continuous channel's shape, not this one. The channel itself is
        // still decided by the datatype's CAPABILITY (DEC-7); `structure` only says which
        // members exist and how each decodes, so this filter narrows within an
        // already-classified artifact rather than re-classifying it.
        this.declaredMembers(a)
          .filter(m => m.kind != null && TEXT_VALUE_KINDS.includes(m.kind))
          .map(m => {
            // The composite key is an ADDRESS — `categorical()` splits it and hands the
            // right-hand half to `resolveMember`, which resolves by `path` and only by
            // `path` (INV-4: "members are addressed by path through a merkle manifest").
            // The DISPLAY half may use the producer's label, which is what `name` is —
            // "a label, never a key" in the framework gate's own words. Minting the key
            // from `m.name ?? m.path` conflated the two: identical today, because every
            // producer writes `name === path`, and an unresolvable key the first time one
            // does not.
            const label = m.name ?? m.path
            return {
              id: `${a.id}#${m.path}`,
              kind: 'categorical' as const,
              label: `${label} · ${a.id.slice(0, 8)}`,
            }
          }),
      )
    // value (feature) columns — a sparse (CSC) matrix serves each feature column as three
    // byte ranges over its declared trio. Keys are composite `<artifactId>#<colIndex>` so
    // `valueColumn()` resolves to the exact (artifact, column); the index→NAME map (the
    // feature axis) is the follow-up.
    //
    // ITEM-7: which artifacts are sparse, and how many columns each has, are both read
    // off the producer's declaration — `kind: "sparse_csc"` and its `shape: [rows, cols]`
    // (`txr_csc.write_csc_zarr`). Previously `storage_layout === 'chunked-sparse'` plus
    // `shape.cols`, two columns that a producer could set inconsistently with the bytes.
    const valueColumns: string[] = []
    for (const a of arts) {
      const structure = this.declaredStructure(a)
      if (structure?.encoding !== 'zarr_v3' || structure.kind !== 'sparse_csc') continue
      // INV-2, the same rule the `pointCount` refusal below states: absence is not a
      // zero. This was `Math.min(cols ?? 0, CAP)`, which turned a `sparse_csc` whose
      // declared `shape` is missing or unreadable into ZERO columns with NOTHING said —
      // the silent-empty failure mode, in the costume of a defaulted `??`. Nothing
      // upstream catches it either: the server's `validate_declared_structure` requires
      // only an object naming an `encoding`, and `parseStructure` checks `encoding` +
      // `kind`; neither looks at `shape`. So this artifact contributes nothing (a
      // listing must not throw — one bad row must not take the project's channels with
      // it), and the REASON is recoverable.
      let cols: number | undefined
      try {
        cols = declaredDims(structure, a.id)[1]
      } catch (e) {
        console.warn('[workbench] catalog value columns skipped: unreadable declared shape', this.projectId, a.id, e)
        continue
      }
      if (cols === undefined) {
        console.warn(
          '[workbench] catalog value columns skipped: the artifact declares no second dimension',
          this.projectId,
          a.id,
        )
        continue
      }
      const g = Math.min(cols, VALUE_COLUMN_CAP)
      for (let i = 0; i < g; i++) valueColumns.push(`${a.id}#${i}`)
    }
    // `pointCount` is the viz wire's ONE scalar for "how many points does this
    // dataset have". It is the length of the ROW AXIS the plotted artifacts bind —
    // resolved from the DECLARED axes of the artifacts that actually feed a channel
    // (layout first, then the column channels), NOT from a globally-privileged axis.
    const channelArtifacts = [
      ...arts.filter(a => this.hasCap(a.datatype, CAP_PLOTTABLE_XY)),
      ...arts.filter(a => this.hasCap(a.datatype, CAP_CONTINUOUS)),
      ...arts.filter(a => this.hasCap(a.datatype, CAP_CATEGORICAL)),
    ]
    // INV-3 (see `resolveRowAxis`): the catalog's own first declared axis is the
    // last-resort fallback, and it is licensed by SILENCE ONLY — every channel artifact's
    // datatype declared no row axis, or declared one this project does not report, so
    // there is no resolution for a positional answer to contradict. A REFUSED label
    // (one naming several axes) does NOT reach it: `axes[0]` there is precisely the
    // name-keyed guess the refusal exists to prevent, and it is how this method used to
    // report the cardinality of an axis nothing is aligned to as the point count.
    let pointCount: number | undefined
    let refused = false
    for (const a of channelArtifacts) {
      const resolution = this.resolveRowAxis(cat, a)
      if (resolution.status === 'resolved') {
        pointCount = resolution.axis.length
        break
      }
      if (resolution.status === 'ambiguous') {
        refused = true
        // A listing cannot throw (one bad row must not take the project's channels with
        // it — same rule as `declaredStructure`), so the refusal degrades to no answer.
        // It is SAID, though: `pointCount: 0` renders an empty canvas, which is visible,
        // but the REASON has to be recoverable or this is the silent-empty failure mode
        // in a different costume.
        console.warn(
          '[workbench] catalog pointCount unresolved',
          this.projectId,
          a.id,
          axisAmbiguousMessage(resolution.label, resolution.candidates),
        )
      }
    }
    if (pointCount === undefined && !refused) pointCount = cat.axes[0]?.length
    // THE RASTER CHANNEL (#159). `hasImage` was a hardcoded `false` and its consumer is the
    // chart-type gate, so a project with a real tissue raster offered an image pane that drew
    // an "unsupported" box. It is now the truth, and `image` carries the dimensions + placement
    // of the exact texture `imageUnderlay()` will serve.
    //
    // This is the ONE read `catalog()` performs, and it is deliberate: `ImageMeta` needs the
    // served level's size and its channel count, and NO declaration carries either — the
    // producer states the FULL-resolution extent, while the level count (hence the coarsest
    // level's size) is a fact about the file. It is bounded to the reader's header/IFD reads
    // (no tile is fetched), it is shared with `imagePixelSource()` through one memo, and it is
    // guarded below.
    //
    // GUARDED, because a listing cannot throw: one raster that will not open must not take the
    // project's layouts and columns with it. The refusal degrades to `hasImage: false` — which
    // is the same answer a project with no raster gets, and therefore leaves the pane offering
    // nothing rather than offering something broken — and the REASON is logged, because a
    // silently image-less project is otherwise indistinguishable from one that has no image.
    let image: DatasetCatalog['image']
    // TRUE when a raster opened, even if no single texture can describe it. The two are
    // DIFFERENT questions and conflating them was a regression this item shipped and then
    // caught: `hasImage` gates whether the raster view is OFFERED at all, and `image` describes
    // the single-texture FALLBACK. A gigapixel raster has no fallback and renders perfectly
    // from its pyramid — reporting `hasImage: false` for it withdrew the view from precisely
    // the image the tiling path exists for.
    let openedRaster = false
    try {
      const raster = await this.resolveRaster()
      if (raster) {
        openedRaster = true
        const { omeTiffUnderlayMeta } = await import('@txresbench/viz')
        image = omeTiffUnderlayMeta(raster.pyramid, raster.toSpace, raster.space)
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'OmeTiffTooLargeForOneTextureError') {
        // Not a failure. The raster opened; it is simply larger than one texture, so the
        // fallback is unavailable and the tiling path — which reads only the viewport — is the
        // only one, which is the correct outcome for an image this size. Logged at info: it
        // explains why `imageUnderlay()` refuses on this project, and it is not a defect.
        console.info(
          '[workbench] raster is too large for a single fallback texture; it renders from its ' +
            'resolution pyramid only',
          this.projectId,
          e.message,
        )
      } else {
        // A PRODUCER BUG and a transport failure are not the same event. The reducer refuses a
        // declared-but-broken placement precisely so identity is not silently substituted, and
        // filing that next to a busy object store loses the distinction the refusal exists to
        // draw. Classified on the refusal's OWN class rather than on a name that also covers
        // every other reason the reduction can decline — the size refusal above is an
        // `OmeTiffUnderlayError` too, and it is not a bug at all.
        const producerBug = e instanceof Error && e.name === 'OmeTiffPlacementError'
        const report = producerBug ? console.error : console.warn
        report(
          producerBug
            ? '[workbench] catalog raster REFUSED: the artifact declares a placement this reader ' +
                'will not guess at — a producer bug, not a transport failure'
            : '[workbench] catalog raster skipped: the artifact could not be opened',
          this.projectId,
          e,
        )
      }
    }
    return {
      datasetId: this.projectId,
      pointCount: pointCount ?? 0,
      layouts,
      valueColumns,
      categoricalColumns,
      continuousColumns,
      // `hasImage` asks whether there IS a raster; `image` describes the single-texture
      // fallback for it. A raster too large for one texture answers yes to the first and
      // nothing to the second.
      hasImage: openedRaster,
      ...(image ? { image } : {}),
    }
  }

  /**
   * The annotation columns present on ONE axis of the project — one entry per column the
   * ARTIFACTS stamped, scoped to `axis`, typed by the stamp the conformance gate verified.
   *
   * A `<x>`-axis query returns ONLY the columns sitting on that axis, never another
   * axis's: the two sets are disjoint on any real multi-axis import (per-entity metadata
   * on one axis, per-feature metadata on the other), and a criteria picker offered the
   * wrong one cannot evaluate it against its entries at all. The axis is each artifact's
   * own PRODUCER DECLARATION — see {@link declaredAxisOf} for the two shapes and for why
   * a CSC matrix's value columns follow `axes[0]`.
   *
   * `available` is TRUE by construction: the list IS the columns present. It used to mean
   * "the declared column's channel has some data", which could be true while the specific
   * column did not exist — the declaration promised a column and the flag only reported
   * that its channel was non-empty.
   */
  async annotationsForAxis(datatypeId: string, axis: string): Promise<AxisAnnotation[]> {
    // Read the columns that ACTUALLY LANDED, from the catalog. There is no declaration
    // to merge with any more: a datatype declares axis IDENTITY only, and an analysis
    // declares the DATATYPES it produces, not the columns (INV-5).
    //
    // Each catalog column carries the channel it was filed under, which the producing
    // artifact STAMPED and the conformance gate verified — so the control shape still
    // comes from a declared type, just one that is checked against the bytes rather than
    // forecast before they existed.
    let cat: DatasetCatalog | null = null
    try {
      cat = await this.catalog()
    } catch {
      cat = null
    }
    if (!cat) return []
    // The rows behind those columns. `projectCatalog()` is cached and `catalog()` above
    // already awaited it, so this costs no request — it recovers the DECLARATIONS the
    // `DatasetCatalog` framing (`{id, kind, label}`) drops on the way out.
    const plane = await this.projectCatalog()
    const byId = new Map((plane.artifacts ?? []).map(a => [a.id, a]))
    const axisOf = new Map(
      (plane.artifacts ?? []).map(a => [a.id, this.declaredAxisOf(a)] as const),
    )
    /** One warning per ARTIFACT, not per column of it: a multi-member table would
     *  otherwise repeat the same fact once per member. */
    const warned = new Set<string>()
    // Each catalog id is an ADDRESS whose left half is the artifact that stamped the
    // column — `<artifactId>#<memberPath>` (categorical), `<artifactId>#<colIndex>`
    // (value), a bare artifact id (continuous, where the artifact IS the column). That is
    // what recovers the artifact, and with it BOTH facts the catalog framing drops: the
    // axis the column sits on, and the column's own name.
    const member = (id: string) => {
      const { artifactId, column } = parseChannelKey(id)
      return { id, artifactId, column: column === '' ? undefined : column }
    }
    const cols: Array<{ id: string; artifactId: string; column?: string; label?: string; type: AnnotationType }> = [
      ...cat.categoricalColumns.map(c => ({ ...member(c.id), label: c.label, type: 'categorical' as const })),
      // A whole-artifact column: no member address, so its name is the producer's
      // `meta.name` rather than a half of the id (see `declaredColumnName`).
      ...cat.continuousColumns.map(c => ({
        id: c.id,
        artifactId: c.id,
        column: declaredColumnName(byId.get(c.id)),
        label: c.label,
        type: 'continuous' as const,
      })),
      ...cat.valueColumns.map(id => ({ ...member(id), type: 'value' as const })),
    ]
    if (cols.length === 0) return []
    return cols
      .filter(c => {
        const declared = axisOf.get(c.artifactId)
        if (declared === axis) return true
        if (declared !== undefined) return false
        // ── UNDECLARED: reported on EVERY axis, and SAID ────────────────────────────
        // The artifact named no axis it could read (an `opaque` blob, a table that
        // omitted `axis`, a declaration that will not parse). Dropping it would make a
        // real, readable column vanish from every axis with nothing said — the
        // silent-empty failure INV-2 forbids ("absence is not a zero"), and there is no
        // second surface it could be reached from. So the widest honest answer is given.
        //
        // It is WARNED, unlike `resolveRowAxis`'s silence-licensed positional fallback,
        // because the two fallbacks are not the same shape: that one picks ONE axis by
        // position, this one places a column on axes it may not belong to. A listing that
        // may pollute has to be recoverable, on the same rule as the value-column skip in
        // `catalog()` — the outcome degrades, the reason does not.
        if (!warned.has(c.artifactId)) {
          warned.add(c.artifactId)
          console.warn(
            '[workbench] annotation column listed on every axis: the artifact declares no axis',
            this.projectId,
            c.artifactId,
            `requested axis "${axis}"`,
          )
        }
        return true
      })
      .map(c => ({
        name: c.id,
        column: c.column,
        // The override is keyed by the column NAME, never by `name` (an address carrying
        // a server-minted id no author can write down — DEC-4, see `columnLabel`). A
        // column with no derivable name is not looked up at all rather than looked up by
        // something that cannot match.
        label:
          (c.column === undefined ? undefined : this.deps.columnLabel?.(datatypeId, c.column)) ??
          c.label ??
          c.id,
        type: c.type,
        capability: capabilityForType(c.type),
        available: true,
      }))
  }

  /**
   * The 2D layout for `layoutId` (a 2-D coordinate artifact id) as interleaved
   * `[x0,y0,x1,y1,…]` — the wire `positions` framing viz's deck grid consumes.
   *
   * TWO encodings, chosen by the producer's DECLARATION, never sniffed:
   *   `zarr_v3` — an `(n × dims)` member, read chunk by chunk. `deps.onChunk` fires as
   *               each lands, and the writer chunks rows at full width, so chunk k
   *               completes whole POINTS: a consumer can paint a growing cloud.
   *   `opaque`  — a raw interleaved f32 blob (the pre-Zarr producers + the e2e seed
   *               fixtures). Read whole, with the dims inference the older path had.
   *
   * ITEM-25 removed the `is_multifile` refusal that used to head this method. Every
   * layout a current producer writes IS multi-file (a Zarr directory), so that guard
   * had become an unconditional throw for the real data path.
   *
   * ITEM-7 NOTE — the `opaque` arm lost its one declared input. It used to seed `dims`
   * and `count` from the artifact's `shape` column (`{rows, cols}`) before falling back
   * to inference; that column is gone and `{"encoding":"opaque"}` declares a media type
   * and nothing else, so the arm is now inference ONLY. That is not a fallback this
   * migration invented — the inference chain below is unchanged and predates it — but it
   * is now the sole path, which is why every current producer writes `zarr_v3` instead:
   * a Zarr layout carries its extent in its own metadata and never reaches here.
   */
  async positions(layoutId: string): Promise<Positions> {
    const meta = await this.deps.getArtifact(layoutId)
    const structure = this.structureOf(layoutId, meta)
    if (structure.encoding === 'zarr_v3') {
      return this.deps.readPositions(layoutId, structure, this.deps.onChunk)
    }
    const cat = await this.projectCatalog()
    const bytes = await this.deps.fetchArtifactBytes(layoutId)
    if (bytes.byteLength % 4 !== 0) {
      throw new WorkbenchDataSourceError(
        `layout "${layoutId}": ${bytes.byteLength} bytes are not f32-aligned`,
      )
    }
    const flat = new Float32Array(bytes)
    const total = flat.length
    if (total === 0) throw new WorkbenchDataSourceError(`layout "${layoutId}" has no data`)

    let dims = 0
    // The point count is the length of THIS artifact's declared row axis (a
    // `(region, channel)` image resolves `region`, a matrix resolves its own row axis).
    // An AMBIGUOUS label throws (`rowAxisLengthForRead`) rather than resolving to
    // `axes[0]`: `dims` is inferred from this number, so a substitute count does not
    // merely mis-report the extent, it reshapes the cloud.
    let count =
      this.rowAxisLengthForRead(cat, meta, `layout "${layoutId}"`) ?? cat.axes[0]?.length ?? 0
    {
      // An opaque blob declares no extent (ITEM-7) → infer dims from the project
      // cardinality, else fall back to the wire's 2-column interleaving.
      if (count > 0 && total % count === 0) dims = total / count
      else if (total % 2 === 0) {
        dims = 2
        count = total / 2
      } else {
        throw new WorkbenchDataSourceError(
          `layout "${layoutId}": cannot infer dims from ${total} floats (row-axis length=${count})`,
        )
      }
    }
    if (dims < 2) {
      throw new WorkbenchDataSourceError(`layout "${layoutId}": needs ≥2 dims, has ${dims}`)
    }
    if (count <= 0) count = Math.floor(total / dims)

    if (dims === 2) {
      // Already interleaved xy — a zero-copy view (trim any trailing padding to N*2).
      const positions = total === count * 2 ? flat : flat.subarray(0, count * 2)
      return { positions, length: count }
    }
    // >2-dim dense layout: project the first two columns into the wire framing.
    const positions = new Float32Array(count * 2)
    for (let i = 0; i < count; i++) {
      positions[i * 2] = flat[i * dims]
      positions[i * 2 + 1] = flat[i * dims + 1]
    }
    return { positions, length: count }
  }

  /**
   * A dense per-entity continuous column. `zarr_v3` reads the declared numeric member
   * chunk by chunk (`deps.onChunk` per chunk); `opaque` reads the raw f32 blob whole.
   */
  async continuous(key: string): Promise<ContinuousColumn> {
    const meta = await this.deps.getArtifact(key)
    const structure = this.structureOf(key, meta)
    if (structure.encoding === 'zarr_v3') {
      const value = await this.deps.readNumeric(key, structure, this.deps.onChunk)
      return { value, length: value.length }
    }
    const bytes = await this.deps.fetchArtifactBytes(key)
    if (bytes.byteLength % 4 !== 0) {
      throw new WorkbenchDataSourceError(
        `continuous "${key}": ${bytes.byteLength} bytes are not f32-aligned`,
      )
    }
    const value = new Float32Array(bytes)
    return { value, length: value.length }
  }

  /**
   * A sparse (feature) value column → `{row, value}` (non-zeros only), read over three
   * byte ranges on the declared CSC trio. `key` is a composite `<artifactId>#<colIndex>`
   * (the catalog surfaces these). This is the color-by-value path.
   */
  async valueColumn(key: string): Promise<SparseColumn> {
    const cat = await this.projectCatalog()
    const { artifactId, column } = parseChannelKey(key)
    const col = Number(column)
    // Require the composite `<artifactId>#<colIndex>`: a non-`#` key (a viz channel
    // default like `value`) or an empty/non-numeric column is NOT a resolvable column
    // — reject rather than issue a spurious `GET /api/artifacts/<key>/read?col=…`.
    if (!key.includes('#') || !artifactId || column === '' || !Number.isFinite(col)) {
      throw new WorkbenchDataSourceError(
        `value column key "${key}" must be "<artifactId>#<colIndex>"`,
      )
    }
    const meta = await this.deps.getArtifact(artifactId)
    const sparse = await this.deps.readSparseColumn(artifactId, col, this.structureOf(artifactId, meta))
    // The sparse column is dense over THIS artifact's declared row axis. An AMBIGUOUS
    // label throws (`rowAxisLengthForRead`) rather than resolving to `axes[0]`: the
    // non-zeros carry their own row indices, so a substituted length is a densification
    // over the wrong entity set and every value lands on the wrong entry.
    const length =
      this.rowAxisLengthForRead(cat, meta, `value column "${key}"`) ?? cat.axes[0]?.length ?? 0
    return { row: sparse.row, value: sparse.value, length }
  }

  /**
   * An annotation categorical column → `{codes, categories}`, decoded from the declared
   * `uint8`/`uint16` codes plus the DECLARED level set (D10: ONE artifact, not a codes
   * artifact and a levels artifact). `key` is a composite `<artifactId>#<columnName>`
   * (the catalog surfaces these); a bare `<artifactId>#` reads the artifact's sole member.
   */
  async categorical(key: string): Promise<CategoricalColumn> {
    const { artifactId, column } = parseChannelKey(key)
    // A resolvable key MUST be the composite `<artifactId>#<column>` the catalog emits
    // (a bare `<artifactId>#` is the single-column fallback). A key with NO `#` — e.g. a
    // viz binding-channel default like `group` that was never bound to a catalog column —
    // is NOT an artifact id: reject it (a typed error the viz caller degrades on) rather
    // than issuing a spurious `GET /api/artifacts/group/read` → 400.
    if (!key.includes('#') || !artifactId) {
      throw new WorkbenchDataSourceError(
        `categorical column key "${key}" must be "<artifactId>#<columnName>"`,
      )
    }
    const meta = await this.deps.getArtifact(artifactId)
    const cat = await this.deps.readCategorical(
      artifactId,
      this.structureOf(artifactId, meta),
      column || undefined,
    )
    // The viz GPU consumer packs codes to u16, so narrow the decoder's Uint32 codes
    // losslessly — and ERROR (never a silent wrap) when the level set is too large, so
    // over-cap mis-colouring surfaces instead of painting confidently wrong labels.
    //
    // ONE implementation of that rule: `toUint16Codes` (`core/workstore/zarrCodecs.ts`),
    // whose docstring already names THIS method as its boundary. It used to be
    // re-implemented inline here, and the two copies had drifted — the inline message
    // claimed the cap was ">65535" while its own check allowed exactly 65536. 65536 is
    // the correct cap and the copy that stated it is the one that survived: a u16 code
    // spans 0…65535, so a 65536-level set fits exactly and a 65537th level wraps to 0.
    let codes: Uint16Array
    try {
      codes = toUint16Codes(cat.codes, cat.categories.length)
    } catch (e) {
      // Re-raised in this module's taxonomy, naming the COLUMN — which the shared codec
      // cannot know — while the RULE and its wording stay in the one place that owns them.
      throw new WorkbenchDataSourceError(
        `categorical column "${key}": ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    return {
      codes,
      categories: cat.categories,
      length: cat.codes.length,
    }
  }

  /**
   * The single-texture raster underlay (#159) — the fallback the raster pane draws when a
   * source offers no resolution pyramid, and the channel `asDataSource` reconstitutes over the
   * streamed bytes.
   *
   * It serves the COARSEST pyramid level, never level 0. That is a contract, not a tuning
   * choice: this method MATERIALIZES whatever level it names, and level 0 of a whole-slide
   * raster is gigabytes — the whole-object read the range-reading design exists to prevent. The
   * reduction (and the affine inversion that goes with it) lives beside the reader in the viz
   * package; see `omeTiffUnderlay`.
   */
  async imageUnderlay(): Promise<ImageUnderlay> {
    const raster = await this.resolveRaster()
    if (!raster) throw new NotReachableError('image underlay')
    const { omeTiffUnderlay } = await import('@txresbench/viz')
    return omeTiffUnderlay(raster.pyramid, raster.toSpace)
  }

  /**
   * The gigapixel-capable resolution pyramid (#159) — the path the raster pane actually takes
   * when it is available, tiling from the viewport instead of materializing a texture.
   *
   * PRESENT ON THE CLASS UNCONDITIONALLY, and the consequence is worth stating precisely rather
   * than in the reassuring shorthand this comment first used.
   *
   * The pane's opt-out is `if (!src?.imagePixelSource) continue`, and because this is a declared
   * class method the adapter always forwards it — so for a project with NO raster the opt-out
   * does not fire. The pane reserves a slot, calls through, receives the named refusal, and
   * records `null`. The single-texture path still runs, and it runs because it was never gated
   * on the pyramid — NOT because anything "falls through". The two effects are independent.
   *
   * That is correct behaviour, and it is one wasted round trip on a project that has no raster
   * to show. The absent-vs-present distinction still matters at the WRAPPERS, where a source
   * that genuinely cannot serve a pyramid must not appear to.
   */
  async imagePixelSource(): Promise<ImagePixelSource> {
    const raster = await this.resolveRaster()
    if (!raster) throw new NotReachableError('image pixel source')
    return raster.pyramid.pyramid
  }

  async table(name: string): Promise<DataTable> {
    throw new NotReachableError(`table "${name}"`)
  }

  async graph(id: string): Promise<GraphData> {
    throw new NotReachableError(`graph "${id}"`)
  }
}

// DEV-only testability seam: expose a project-bound `WorkbenchDataSource` on
// `window.__txr_ds` so an e2e can drive the REAL catalog→select flow (the exact path
// the color-by picker uses: `catalog()` → a composite value/categorical key →
// `valueColumn()`/`categorical()`) against the running backend with NO route mocking —
// proving the composite-key threading (H2) + the ingest column-catalog (M6) end-to-end,
// not via the low-level `__txr_read` decoder shortcut. Gated so it is tree-shaken out of
// a real release (present under the Vite dev server AND the e2e preview build, which sets
// `VITE_ENABLE_TEST_SEAMS=1`; a shipped release sets neither).
if ((import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS) && typeof window !== 'undefined') {
  ;(window as unknown as { __txr_ds?: unknown }).__txr_ds = (projectId: string) =>
    new WorkbenchDataSource(projectId)
}
