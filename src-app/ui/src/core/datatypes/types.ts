// TS mirror of the P2 datatype type contract (ITEM-1). Structurally matches the
// Rust wire (`server/src/modules/datatype/types.rs`) so `GET /api/datatypes`
// responses deserialize straight into these. The BACKEND is the source of truth
// (the registry is populated from the API at boot — no hand-maintained lattice
// here); the Rust↔TS parity is gated by the shared golden fixture (ITEM-7). Lives
// in `core/` so it survives the P5 `@/modules/workbench/core` extraction unmoved.

export type SparseOrientation = 'csc' | 'csr'

/** Domain-neutral storage layout (matches Rust `LayoutKind`, `#[serde(tag="kind")]`). */
export type LayoutKind =
  | { kind: 'chunked_dense' }
  | { kind: 'chunked_sparse'; orientation: SparseOrientation }
  | { kind: 'columnar_table' }
  | { kind: 'chunked_1d' }
  | { kind: 'opaque_as_is' }

export type FileLayout = 'single' | 'prefix' | 'manifest'

export type AccessTier =
  | 'tier1_range_client_decode'
  | 'tier2_layout_slice'
  | 'tier3_precompute'

/** Where a semantic selector maps in the physical layout (matches Rust `LayoutIndexRef`). */
export type LayoutIndexRef = { index: 'column' } | { index: 'row' } | { index: 'range' }

export interface StorageSpec {
  layout: LayoutKind
  format: string
  selector_map: Record<string, LayoutIndexRef>
  file_layout: FileLayout
  tiers: AccessTier[]
}

export interface ViewerRef {
  view_kind_id: string
  family: string
  consumes: string[]
}

export type ConverterRun = 'host' | 'sandbox'

export interface ConverterRef {
  from: string
  to: string
  run: ConverterRun
  entry?: string | null
}

export interface IngestSpec {
  extensions: string[]
  magic_hex: string[]
}

/**
 * The file SHAPE an uploaded input of a type must arrive as (matches Rust
 * `InputRequirements`, `#[serde(tag="requires")]`). An archive is NOT a distinct
 * variant — it is the same named `members` delivered bundled, so `manifest` carries
 * `allow_archive` ("the N files OR a single `.zip`/`.tar` that expands to them").
 */
export type InputRequirements =
  | { requires: 'single' }
  | { requires: 'manifest'; members: string[]; allow_archive: boolean }

/** The control shape a column's values drive — categorical→multiselect, continuous→min/max,
 *  ordinal→ordered-select, value→value control.
 *
 *  This is a VOCABULARY, not a declaration. It is no longer a mirror of a Rust type (the
 *  backend has none: `AnnotationType` existed only to type the deleted column forecast).
 *  It now types a column READ FROM AN ARTIFACT that landed — `WorkbenchDataSource`
 *  classifies each real column and tags it with one of these. */
export type AnnotationType = 'categorical' | 'continuous' | 'ordinal' | 'value'

/** A named ENTITY AXIS a datatype declares (matches Rust `AxisSpec`) — the axis a
 *  supporting file / selector references (`name`) + the human label for its entity
 *  KEY (`key_label`, e.g. `barcode`/`gene_id`). Drives the upload wizard's optional
 *  per-axis annotation dropzones (ITEM-16).
 *
 *  The list is an IDENTITY LIST and its ORDER MEANS NOTHING. The one role a consumer
 *  needs — WHICH axis is the entity axis — is declared separately and by NAME on
 *  {@link Datatype.entity_axis}. Reading it off position 0 was a leak; see there.
 *
 *  IDENTITY ONLY. There is no `annotations` field and no `AnnotationSpec`: an axis listing
 *  the columns a dataset "would" carry was an unverified forecast (INV-5) — on a real
 *  CELLxGENE dataset 8 of the 9 declared annotations did not exist while 64 of the 65 actual
 *  columns went undeclared. WHICH columns exist is read from the artifacts that landed
 *  (`WorkbenchDataSource.annotationsForAxis`); the only non-derivable fact, a per-column
 *  display LABEL, survives as the contribution-level `labels` lookup, which is silent for a
 *  column it does not mention and therefore cannot assert one exists. */
export interface AxisSpec {
  name: string
  key_label: string
}

/** One DIMENSION binding of a declared array (matches Rust `ArrayDim`, untagged) — an
 *  entity AXIS (`{ axis }`, an `AxisSpec.name`) XOR an anonymous positional latent
 *  extent (`{ k }`, an embedding's dims). The open-axis model (INV-7). */
export type ArrayDim = { axis: string } | { k: number }

/** One typed ATTRIBUTE an array carries (matches Rust `ArrayAttr`). `dtype` is an OPEN
 *  string (`f32`/`i64`/`bool`/`categorical`/`str`/…). */
export interface ArrayAttr {
  name: string
  dtype: string
}

/** One ARRAY a datatype declares over an OPEN axis set (matches Rust `ArrayDecl`,
 *  INV-7). Generalizes the single implicit `storage` array to a LIST of named arrays,
 *  each binding its `dims` to declared axes (or an anonymous `k`), carrying typed
 *  `attrs`, and owning its OWN `layout` + `selector_map` — so a `(group,group)` graph, a
 *  `(comparison,item)` result table or an `(itemset,item)` membership (none of which have
 *  a per-axis home) become first-class declared arrays served by the same core. */
export interface ArrayDecl {
  name: string
  kind: string
  dims: ArrayDim[]
  attrs: ArrayAttr[]
  layout: LayoutKind
  selector_map: Record<string, LayoutIndexRef>
}

/** A type-match selector (the gating primitive) — matches Rust `TypeSelector`. */
export interface TypeSelector {
  type_id?: string | null
  subtypes_of?: string | null
  multiple?: boolean
  required?: boolean
  capabilities?: string[]
  /** Datatype ids (or their subtypes) to REJECT even when the base match holds — the
   *  "subtypes of X except Y" primitive (ITEM-19). A datatype that `isA` any excluded id fails. */
  excludes?: string[]
}

/** The datatype descriptor — one registry entry (matches Rust `Datatype`). */
export interface Datatype {
  id: string
  extends: string | null
  title: string
  description: string
  schema?: unknown
  storage: StorageSpec
  capabilities: string[]
  viewers: ViewerRef[]
  ingest?: IngestSpec | null
  input_requirements?: InputRequirements | null
  /** The entity axes this datatype declares (drives the upload wizard's supporting
   *  annotation dropzones, ITEM-16). Omitted/empty for types with no aligned axes.
   *  UNORDERED — see {@link Datatype.entity_axis}. */
  axes?: AxisSpec[]
  /** WHICH of {@link Datatype.axes} is this datatype's ENTITY axis — the axis whose
   *  entries a value of this type has exactly ONE PER, i.e. the axis a read of one of
   *  its artifacts is dense over (a layout's point count, a dense column's length, a
   *  sparse column's densified length). Names an `AxisSpec.name` this datatype declares.
   *
   *  ── WHY IT IS DECLARED AND NOT POSITIONAL ─────────────────────────────────────
   *
   *  The consumer used to take `axes[0]`, the FIRST declared axis. `AxisSpec` itself
   *  disclaims that semantic — the core knows an axis has a name and a key label and
   *  never what it REPRESENTS — so position 0 was an app-side assertion the contract
   *  denied, carrying no token any guard could grep for.
   *
   *  It was already wrong on declared data, not hypothetically: the microscopy image
   *  fixture declares four axes of which the first three are raster dimensions, and
   *  resolved a raster dimension as its entity axis; and two CONTRIBUTED composite kinds
   *  (`geneset/collection`, `de/result`) declare their axes in one order while their
   *  primary array binds them in the other, so each is dense over the axis it declares
   *  SECOND. Each wrong answer is a plausible number, so nothing surfaced.
   *
   *  `undefined` is honest silence, NOT "use the first": the resolver answers with the
   *  SOLE axis when the datatype declares exactly one (no choice to make) and otherwise
   *  refuses, so the caller's documented, silence-licensed fallback applies instead of a
   *  guess wearing a declaration's clothes. */
  entity_axis?: string | null
  /** The arrays this datatype declares OVER its axes (open-axis DATA, INV-7).
   *  Omitted/empty for a single-implicit-array datatype (its `storage` IS its one
   *  array); a composite kind (geneset/graph/DE/trajectory) declares its arrays here. */
  arrays?: ArrayDecl[]
  converters: ConverterRef[]
  is_abstract: boolean
  /** OPTIONAL per-column display labels, keyed by column name (ITEM-14 / DEC-4) —
   *  `{ <column>: "<display label>" }`. The only surviving piece of the removed
   *  `axes[].annotations` block: a raw column name is not always a good label, and that
   *  is not derivable from the data. A LOOKUP, silent for a column it does not mention,
   *  so it can never assert that a column exists.
   *
   *  The key is the column's OWN NAME — never a catalog channel id, which carries a
   *  server-minted artifact id no author can write down. The exact string is what
   *  `WorkbenchDataSource.annotationsForAxis` reports as `AxisAnnotation.column`: a
   *  member path for a column inside a multi-column artifact, and the producer's declared
   *  `meta.name` for an artifact that IS one column (which is what the metric columns a
   *  run emits are — one artifact each, so the example above is that shape). */
  labels?: Record<string, string> | null
}
