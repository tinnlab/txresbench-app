// The `datatypes` contribution point — the type surface an extension declares
// `accepts`/`produces` against (ITEM-7). These are a STRUCTURAL MIRROR of the P2
// datatype contract (`src-app/server/src/modules/datatype/types.rs` and its FE
// twin `src-app/ui/src/core/datatypes/types.ts`). P2 OWNS the registry impl +
// the subtyping lattice + storage layouts + viewers; workbench-api re-declares
// the type shape here (DEC-3) so the package stays an ACYCLIC leaf — it never
// imports app-local `@/core/datatypes` (that would be an app→package cycle
// inverted). The concrete lattice runtime is host-INJECTED (`DatatypeLattice`,
// `./lattice.ts`). A later slice inverts P2's FE module to consume these types
// FROM this package (P2 already anticipates the extraction).

export type SparseOrientation = 'csc' | 'csr'

/** Domain-neutral storage layout (matches Rust `LayoutKind`, `#[serde(tag="kind")]`). */
export type LayoutKind =
  | { kind: 'chunked_dense' }
  | { kind: 'chunked_sparse'; orientation: SparseOrientation }
  | { kind: 'columnar_table' }
  | { kind: 'chunked_1d' }
  | { kind: 'opaque_as_is' }

export type FileLayout = 'single' | 'prefix' | 'manifest'

export type AccessTier = 'tier1_range_client_decode' | 'tier2_layout_slice' | 'tier3_precompute'

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

/** The declared TYPE of an annotation (matches Rust `AnnotationType`, dimension-primitives
 *  ITEM-1 / DEC-A). The sole driver of the general filter/group control shape —
 *  categorical→multiselect, continuous→min/max, ordinal→ordered-select, value→value control. */
export type AnnotationType = 'categorical' | 'continuous' | 'ordinal' | 'value'

/** A type-match selector (the gating primitive) — matches Rust `TypeSelector`.
 *  An analysis's `accepts` ARE its artifact-ref inputs (§4.3): one declaration
 *  both gates availability AND drives the picker. */
export interface TypeSelector {
  /** The INPUT SLOT this selector names, when it appears in an analysis' `appliesTo`.
   *  It is the key a caller sends (`inputs: { matrix: <artifact id> }`) and the key the
   *  compute resolves from `/inputs/inputs.json`. Absent for selectors used as a bare
   *  type match (a converter's `accepts`, a view's picker `source`). */
  slot?: string
  /** an exact datatype id (`embedding`) */
  type_id?: string | null
  /** any subtype of this id (`subtypes_of: 'matrix'`) */
  subtypes_of?: string | null
  multiple?: boolean
  required?: boolean
  /**
   * BIND the sole compatible artifact for this SLOT automatically (R2 / INV-3, ITEM-29f).
   *
   * Opt-IN — absence means OFF (DEC-15) — and it is the manifest twin of the view-spec widget's
   * `auto_bind_sole_candidate`. Two declaration surfaces because there are two AUDIENCES: the
   * widget's governs a control a user is looking at, this one governs the two paths where there
   * is no control at all.
   *
   * Those two are the reason this key has to exist rather than the widget's being enough:
   * `resolveInputs` binds a sole candidate at LAUNCH for a caller that supplied nothing — an
   * agent or MCP call — and `autoPickSoleArtifacts` patches one into `params` from a MOUNT
   * effect, after which the run gate reports READY. Neither can "show what it bound", so under
   * R2 neither may bind at all unless the analysis said so. Absent, the slot stays unbound and
   * the compute reports it by name, which is a better error than a silent wrong input.
   *
   * Ignored for a `multiple` slot, which is 0-or-more by definition and was never auto-bound.
   */
  auto_bind_sole_candidate?: boolean
  /** required datatype capabilities (`['sparse']`) */
  capabilities?: string[]
  /** datatype ids (or their subtypes) to REJECT even when the base match holds — the
   *  "subtypes of X except Y" primitive (ITEM-19). A datatype that `isA` any excluded id fails. */
  excludes?: string[] | null
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
  ingest?: IngestSpec | null
  converters: ConverterRef[]
  is_abstract: boolean
}
