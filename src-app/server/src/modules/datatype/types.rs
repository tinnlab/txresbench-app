//! The datatype type contract (ITEM-1) — authored once in Rust, mirrored in
//! `ui/src/core/datatypes/types.ts` (parity-gated, ITEM-7).
//!
//! A `Datatype` descriptor gives MEANING to a P1 `artifacts.datatype` string: its
//! place in the subtyping lattice (`extends`), its storage layout, its capabilities,
//! the viewers that render it, and how it is ingested/converted. P2 owns this
//! meaning; P1 owns the `artifacts` table + slicer (DEC-1). Every field here is
//! serializable so the whole registry can be dumped over `GET /api/datatypes`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The domain-neutral storage layout a datatype's artifacts use. Keyed on LAYOUT,
/// never on domain (DEC-4) — every layout below is one option among several and NONE
/// is privileged, so no domain's favourite physical shape becomes the core's default.
/// Maps to P1's coarse `workstore::artifact::StorageLayout` string via
/// [`LayoutKind::as_storage_layout`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LayoutKind {
    /// A chunked dense array (Zarr) — e.g. a low-dimensional coordinate array.
    ChunkedDense,
    /// A chunked sparse array (CSC/CSR) — e.g. a large sparse measurement matrix.
    ChunkedSparse { orientation: SparseOrientation },
    /// A columnar table (Parquet) — e.g. a per-row statistics table / label
    /// codes+categories.
    ColumnarTable,
    /// A chunked 1-D vector — e.g. a metadata column / genomic track. The explicit
    /// `rename` is REQUIRED: serde's `snake_case` renders `Chunked1d` as `chunked1d`
    /// (no underscore around a digit), which would diverge from the TS mirror's
    /// `chunked_1d` and the `chunked-1d` DB string. Pin it.
    #[serde(rename = "chunked_1d")]
    Chunked1d,
    /// An opaque blob served as-is (no host decode) — e.g. an HTML report.
    OpaqueAsIs,
}

/// Sparse-matrix orientation (which axis is contiguous), i.e. which one-axis slice is
/// the cheap one. CSC = a COLUMN is contiguous, so a column slice is the hot path;
/// CSR = a ROW is. A datatype declares whichever matches how its readers slice.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SparseOrientation {
    Csc,
    Csr,
}

impl LayoutKind {
    /// Map to P1's coarse `workstore::artifact::StorageLayout` (the CSC/CSR detail P2
    /// carries collapses to the coarse `chunked-sparse` P1 knows). An enum→enum map —
    /// the LAYOUT-STRING table itself lives ONCE, in P1's `StorageLayout::as_str`.
    pub fn to_storage_layout(&self) -> crate::modules::workstore::artifact::StorageLayout {
        use crate::modules::workstore::artifact::StorageLayout;
        match self {
            LayoutKind::ChunkedDense => StorageLayout::ChunkedDense,
            LayoutKind::ChunkedSparse { .. } => StorageLayout::ChunkedSparse,
            LayoutKind::ColumnarTable => StorageLayout::ColumnarTable,
            LayoutKind::Chunked1d => StorageLayout::Chunked1d,
            LayoutKind::OpaqueAsIs => StorageLayout::Opaque,
        }
    }

    /// The P1 `storage_layout` string this layout is stored as — sourced from P1's
    /// single string table (`StorageLayout::as_str`), NOT re-hardcoded here. That
    /// table's own unit test pins every arm's spelling. (It used to say the assertion
    /// lived in `layout.rs`; ITEM-14 deleted that file, and the round-trip it named
    /// went with `StorageLayout::parse`.)
    pub fn as_storage_layout(&self) -> &'static str {
        self.to_storage_layout().as_str()
    }
}

/// How an artifact's bytes map to physical files. P1's store already resolves the
/// physical members (`is_multifile` + merkle `content_hash`); P2 only DECLARES the
/// shape so the reader knows how to assemble (ITEM-14).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FileLayout {
    /// One physical blob.
    Single,
    /// A prefix of member blobs under one key (a Zarr chunk-dir).
    Prefix,
    /// A manifest that maps member-path → member-blob (a data file beside its sidecar
    /// index; an N-part export whose members are one logical artifact).
    Manifest,
}

/// A datatype's storage declaration.
///
/// **artifact-model ITEM-14 removed two fields from this struct**, `selector_map` and
/// `tiers`, and with them the `LayoutIndexRef` / `SelectorMap` / `AccessTier` types and
/// the `layout.rs` tier router that read them. They existed to answer "which transport
/// decodes this selector — a server-side layout slice or a client-side range read?",
/// which is a question that no longer has two answers: ITEM-12 deleted the
/// Selection→Arrow serve core, so `GET /artifacts/{id}/data[/{*member}]` serves opaque
/// byte ranges and the client decodes, always. §0.3 lists *the tier system*,
/// *`selector_map`* and *`tiers`* under **Deleted**, and the design's own sentence for
/// a datatype is: *a node in an is-a lattice; the only question asked of it is
/// `is_a(a,b)`, for analysis gating. Nothing else.*
///
/// The removal is COMPLETE, not tolerated: the manifest-facing shapes
/// (`DatatypeContributionStorage`, [`ArrayDecl`]) are `#[serde(deny_unknown_fields)]`,
/// so a manifest that still writes `selector_map:` / `tiers:` no longer parses at all —
/// its whole datatype contribution is refused rather than silently declaring nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StorageSpec {
    pub layout: LayoutKind,
    /// The served wire format (`zarr` / `parquet` / `html` / …). Documentation for
    /// the client reader; the Rust serve path stays codec-free (DEC-5).
    pub format: String,
    pub file_layout: FileLayout,
}

/// A viewer reference (ITEM-19/DEC-7). Names a view-kind ID the FRONTEND resolves
/// to a renderer — today through the canvas extension's own chart-type registry, or
/// an external family like `molstar`/`igv`. (It once named `registerViewKind`, a
/// workbench-core registry deleted in processor-ui-language DEC-L for having zero
/// production registrants; the plot-type vocabulary belongs to canvas, not core.)
/// This module dispatches the ID; it NEVER renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ViewerRef {
    /// The P7 view-kind id (e.g. `matrix-grid`, `table`, `report`; a domain package
    /// contributes its own alongside these).
    pub view_kind_id: String,
    /// The renderer family (`deckgl` / `molstar` / `igv` / `html`).
    pub family: String,
    /// What this viewer consumes (a capability or selector hint), for the FE picker.
    #[serde(default)]
    pub consumes: Vec<String>,
}

/// Where a converter runs (DEC-6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConverterRun {
    /// In-process, host-lite (P3-independent) — e.g. `csv → columnar-table`.
    Host,
    /// Via P3's sandbox JobRunner — e.g. a heavyweight container-format convert that
    /// needs the analysis environment's reader libraries (deferred, ITEM-18).
    Sandbox,
}

/// A declared conversion from one datatype to another (ITEM-16).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ConverterRef {
    pub from: String,
    pub to: String,
    pub run: ConverterRun,
    /// The host-lite converter key or the sandbox entrypoint; `None` for a pure marker.
    #[serde(default)]
    pub entry: Option<String>,
}

/// How an uploaded file becomes an artifact of this type (ITEM-13/16). Drives the
/// sniffer's ext/magic ordering.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct IngestSpec {
    /// File extensions (without the dot) that hint this type, e.g. `["csv","tsv"]`.
    #[serde(default)]
    pub extensions: Vec<String>,
    /// Leading magic-byte signatures as lowercase hex, e.g. `["504b0304"]` (Zarr/zip).
    #[serde(default)]
    pub magic_hex: Vec<String>,
}

/// What file SHAPE an uploaded input of this type must arrive as (ITEM-13). Drives the
/// upload wizard's picker + pre-upload validation ("this type needs 3 files or a zip"),
/// and supersedes the implicit multi-file auto-grouper — which inferred one specific
/// format's trio by filename — with explicit declared intent (DEC-9).
///
/// Shape note: an ARCHIVE is not a distinct requirement — it is the same named
/// `members` delivered bundled, so `Manifest { allow_archive: true }` models "the N
/// files OR a single `.zip`/`.tar` that expands to them" without a redundant `Archive`
/// variant that would duplicate `members`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "requires", rename_all = "snake_case")]
pub enum InputRequirements {
    /// Exactly one file (e.g. a `.csv`).
    Single,
    /// N named required members that JOINTLY form one dataset — a format whose one
    /// dataset is several files, the way a shapefile is `.shp` + `.shx` + `.dbf`.
    /// When `allow_archive` is set, a single `.zip`/`.tar` that expands to those
    /// members is also accepted.
    Manifest {
        /// The required member filenames, e.g. `["map.shp","map.shx","map.dbf"]`.
        members: Vec<String>,
        /// Also accept a single `.zip`/`.tar` archive expanding to `members`.
        #[serde(default)]
        allow_archive: bool,
    },
}

/// A named ENTITY AXIS a datatype declares (ITEM-3 / DEC-15). A primary datatype
/// declares its OWN axes and there is no core-blessed pair: a tabular type declares
/// `rows`+`columns`, an image stack `frames`+`channels`, an assay type whichever two
/// (or three) entity axes IT measures over — each of those is just a contributed
/// datatype's DATA, and the core sees no difference between them.
/// OPEN + generic: the core knows only "an axis has a name + a key label", never what
/// the axis REPRESENTS. Supporting files align to an axis by `name`; the alignment
/// engine, the integrate converter, and the axis-tagged annotation-column output they
/// produce are all axis-agnostic. Contributable via a manifest AND attachable to an
/// existing Rust datatype (the loader merges axes onto the registry entry).
///
/// The list is an IDENTITY LIST and its ORDER MEANS NOTHING. The one role a consumer
/// needs — which axis is the ENTITY axis — is declared separately and by NAME, on
/// [`Datatype::entity_axis`]; see there for why reading it off position 0 was a leak and
/// what it got wrong. Do not re-privilege a position here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct AxisSpec {
    /// The axis name a supporting file / selector references, e.g. `rows`, `columns`.
    pub name: String,
    /// The human label for this axis's entity KEY, e.g. `Row ID`, `Channel name` —
    /// shown in the add-supporting-file form + used as the key-column detection hint.
    pub key_label: String,
    //
    // IDENTITY ONLY — there is no `annotations` field, and adding one back is the
    // regression this shape exists to prevent (INV-5). It listed, per axis, the columns a
    // dataset "would" carry: an unverified forecast written before any data existed. On one
    // real imported dataset 8 of the 9 declared annotations did not exist, while 64 of the
    // dataset's 65 actual columns went undeclared. WHICH columns exist on an axis is read
    // from the ARTIFACTS that landed — each stamps its own kind, and the conformance gate
    // verifies it — so a datatype may not restate it. A per-column DISPLAY LABEL (the one
    // fact about a column that is not derivable from the data) survives as the
    // contribution-level `labels` lookup, which is silent for a column it does not mention
    // and therefore cannot assert that a column exists.
}

/// One DIMENSION binding of a declared array (INV-7 / open-axis). A dim binds either
/// to a named entity AXIS (an [`AxisSpec::name`] — the join-keyed dimension) OR to an
/// anonymous positional latent extent `k` (a 2..50-wide projection's second dim, whose
/// positions are ordinals and own no join key).
/// Untagged so a manifest writes the two forms verbatim as R4 declares them —
/// `{ axis: cluster }` XOR `{ k: 2 }` — and a `{}`/typo matches neither variant and
/// errors at parse (the exactly-one guard falls out of the untagged encoding).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ArrayDim {
    /// Bound to a declared entity AXIS (an `AxisSpec.name`: `rows`/`cluster`/`comparison`/…).
    Axis { axis: String },
    /// An anonymous positional latent extent (`k`) — a projection's dims, no join key.
    Anon { k: u64 },
}

impl ArrayDim {
    /// The declared axis this dim binds to, if it is an axis dim (not an anonymous `k`).
    pub fn axis(&self) -> Option<&str> {
        match self {
            ArrayDim::Axis { axis } => Some(axis.as_str()),
            ArrayDim::Anon { .. } => None,
        }
    }
}

/// One typed ATTRIBUTE (a measured/dependent value) an array carries (INV-7). `dtype`
/// is an OPEN string (`f32`/`i64`/`bool`/`categorical`/`str`/…) — the physical decoder
/// maps the ones it knows; an unrecognized dtype is carried verbatim, never a parse
/// error (the `SupportingKind::Other` open-vocabulary discipline, applied to attrs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArrayAttr {
    /// The attribute name (a table column / a sparse array's value name / an edge attr).
    pub name: String,
    /// The attribute's declared dtype (open string), e.g. `f32`, `i64`, `bool`, `categorical`.
    pub dtype: String,
}

/// One ARRAY a datatype declares over an OPEN axis set (INV-7 / R4 §4). This is the
/// generalization the whole lifecycle turns on: instead of ONE implicit `storage`
/// array over a FIXED pair of axes (all a two-axis store can hold), a datatype declares
/// a LIST of named arrays, each binding its `dims` to declared axes (or an anonymous
/// `k`), carrying typed `attrs`, and owning its OWN physical `layout`.
/// So a `(cluster,cluster)` graph, a `(comparison,item)` statistics table, or a
/// `(set,item)` membership — none of which fit that fixed pair — become first-class
/// declared arrays.
///
/// The serve layer reads NONE of this — not `kind`, not `layout`. `/data[/{*member}]`
/// resolves a member path and a byte range and hands the bytes over; the client decodes
/// from the artifact's producer-declared `structure` (ITEM-12 / INV-1). What an
/// `ArrayDecl` is FOR is declaration + viewer dispatch. `deny_unknown_fields` makes a
/// typo'd array field fail at manifest parse (the separability-gate discipline).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArrayDecl {
    /// The array name within its datatype (`X`, `abstracted_graph`, `membership`, `logFC`, …).
    pub name: String,
    /// The SEMANTIC array kind (OPEN string: `matrix`/`graph`/`projection`/`annotation-table`/…
    /// — a contributed datatype names its own) — the dim-signature/viewer dispatch key.
    /// NEVER a serve-core branch (DEC-4 split).
    pub kind: String,
    /// The array's dims, each bound to a declared axis or an anonymous `k` (open axis set).
    pub dims: Vec<ArrayDim>,
    /// The typed attributes this array carries (table columns / value name / edge attrs).
    #[serde(default)]
    pub attrs: Vec<ArrayAttr>,
    /// The array's OWN physical layout.
    pub layout: LayoutKind,
}

impl ArrayDecl {
    /// The declared axis names this array binds (skipping anonymous `k` dims) — the
    /// join-key registry a viewer keys on. Order-preserving.
    pub fn axes(&self) -> Vec<&str> {
        self.dims.iter().filter_map(|d| d.axis()).collect()
    }
}

/// The KIND of a supporting file (ITEM-4 / DEC-16/DEC-22). OPEN: the 5 canonical kinds
/// grounded by the file-type research PLUS an `Other(String)` escape hatch, so an
/// UNKNOWN kind string deserializes to `Other` (never a parse error) — a new kind is
/// manifest data, not a core enum edit. v1 IMPLEMENTS only `AnnotationTable` (+
/// `AxisDefinition` modelled as its near sibling); the other three are
/// representable-but-routed-elsewhere (DEC-16/DEC-17).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SupportingKind {
    /// (i) A keyed table of attribute columns joined to an axis. v1 implements this.
    AnnotationTable,
    /// (iv) A sample sheet / design that DEFINES an axis (near sibling of the table).
    AxisDefinition,
    /// (ii) An index / companion of a primary file (routed to the primary import).
    IndexCompanion,
    /// (iii) A dataset-INDEPENDENT reference (carved out to a shared library, DEC-17).
    Reference,
    /// (v) An auxiliary / opaque attachment (routed to the primary import).
    Auxiliary,
    /// Any kind outside the canonical set — an unknown string deserializes here so a
    /// new domain's kind is data, not a core enum edit (variant-level `untagged`).
    #[serde(untagged)]
    Other(String),
}

/// A declarative ALIGNMENT descriptor (ITEM-4 / DEC-18/DEC-22) — how a supporting
/// file's rows map onto a datatype axis. OPEN: the STRATEGY is a known string
/// (`positional`/`key_join`/`namespace`/`none`) OR (in a manifest) a named extension
/// processor; a new strategy is manifest data, not a core enum edit. v1 implements
/// `key_join` with KEY NORMALIZATION (research's #1 alignment failure).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "strategy", rename_all = "snake_case")]
pub enum Alignment {
    /// Row POSITION is the axis index (no key column).
    Positional,
    /// A keyed left-join onto a named axis, with a key-normalization pipeline (v1).
    KeyJoin {
        /// The datatype axis this join targets (an `AxisSpec.name`).
        axis: String,
        /// The join key column in the supporting table; auto-detected when `None`.
        #[serde(default)]
        key_column: Option<String>,
        /// Ordered key-normalization steps (strip 10x `-1`, Ensembl `.N` version, …).
        #[serde(default)]
        normalize: Vec<String>,
    },
    /// A coordinate / ID NAMESPACE join (reserved for reference-consuming domains).
    Namespace {
        /// The id system the namespace aligns by (e.g. an assembly / annotation id).
        id_system: String,
    },
    /// No alignment (an unaligned attachment). Serialized as `none`.
    #[serde(rename = "none")]
    None_,
}

/// A type-match selector (ITEM-4). The gating primitive: an analysis input, a
/// viewer's consume, the artifact-ref picker's population — all one declaration.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TypeSelector {
    /// Exact datatype id to match (when `subtypes_of` is unset).
    #[serde(default)]
    pub type_id: Option<String>,
    /// Match any datatype that `is_a` this supertype (the Galaxy lattice rule).
    #[serde(default)]
    pub subtypes_of: Option<String>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub required: bool,
    /// Additional required capabilities (a subset check).
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Datatype ids (or their subtypes) to REJECT even when the base match holds — the
    /// "subtypes of X except Y" primitive (ITEM-19: QC accepts `single-cell/expression`
    /// but excludes `single-cell/normalized`). A datatype that `is_a` any excluded id fails.
    #[serde(default)]
    pub excludes: Vec<String>,
}

/// The datatype descriptor — the serializable registry entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Datatype {
    /// Namespaced id, e.g. `matrix`, `report/html`, or a package's own
    /// `<namespace>/<type>`.
    pub id: String,
    /// The single supertype (single-inheritance near-term, DEC-11). `None` only for `data`.
    #[serde(default)]
    pub extends: Option<String>,
    pub title: String,
    pub description: String,
    /// A JSON-schema document for FE/introspection. Runtime validation is shape-only
    /// (a per-type validator fn kept beside the descriptor; DEC-12), not this doc.
    #[serde(default)]
    pub schema: serde_json::Value,
    pub storage: StorageSpec,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// The entity AXES this datatype declares (ITEM-3 / DEC-15) — a generic, OPEN
    /// field a manifest contributes AND the loader can merge onto an existing Rust
    /// datatype. Empty for datatypes with no aligned axes. `#[serde(default)]` keeps
    /// the wire back-compatible (an omitted `axes` parses as empty).
    #[serde(default)]
    pub axes: Vec<AxisSpec>,
    /// WHICH of this datatype's [`axes`](Self::axes) is its ENTITY axis — the axis whose
    /// entries a value of this datatype has exactly ONE PER, i.e. the axis a read of one
    /// of its artifacts is dense over. Names an `AxisSpec.name` this datatype declares.
    ///
    /// ── WHY IT IS DECLARED AND NOT POSITIONAL ───────────────────────────────────────
    ///
    /// This exists because the client used to take `axes[0]` — the FIRST declared axis —
    /// as the entity axis, which is a semantic [`AxisSpec`] itself disclaims ("the core
    /// knows only that an axis has a name + a key label, never what the axis
    /// REPRESENTS"). `axes` is an IDENTITY LIST: it says which axes exist, in no
    /// meaningful order, so position 0 carries no more meaning than position 2.
    ///
    /// It was also already WRONG on declared data, in two shapes:
    ///   - a microscopy image declaring four axes of which THREE are raster dimensions
    ///     resolved a raster dimension as its entity axis, when the entity axis is the
    ///     segmented-object one it declares LAST;
    ///   - two CONTRIBUTED composite kinds declare their axes in one order while their
    ///     PRIMARY array binds them in the other, so a column of either is dense over
    ///     the axis declared SECOND. (This doc-comment ships verbatim inside the
    ///     OpenAPI contract, so it may not name the two ids — compare each `axes:`
    ///     block with the `dims:` of the array below it in the contributed manifests.)
    /// Nothing surfaced either: an entity-axis mistake reports a plausible number.
    ///
    /// ── WHY NOT `arrays[0].dims[0]` ─────────────────────────────────────────────────
    ///
    /// [`ArrayDecl::dims`] IS positional (row-major storage order), so it looks like the
    /// answer — but it answers a different question: "the first STORAGE dimension of the
    /// primary array". For an image those differ (the primary array is the raster; the
    /// entity axis is `region`), and most datatypes declare no `arrays` at all. So the
    /// entity axis is declared directly.
    ///
    /// `None` is honest silence, NOT a default: a consumer resolving this reads the SOLE
    /// axis when the datatype declares exactly one (there is no choice to make), and
    /// otherwise gets no answer at all rather than a positional guess.
    /// `#[serde(default)]` keeps the wire back-compatible (an omitted key parses `None`).
    #[serde(default)]
    pub entity_axis: Option<String>,
    /// The arrays this datatype declares OVER its axes (INV-7 / open-axis DATA). Empty
    /// for a single-implicit-array datatype (its `storage` IS its one array); a
    /// COMPOSITE kind (trajectory / set-membership / graph / statistics-table) declares
    /// its multiple arrays here, each self-describing (`dims`→axes, typed `attrs`, its
    /// own `layout`).
    /// `#[serde(default)]` keeps the wire back-compatible — an omitted `arrays` parses empty.
    #[serde(default)]
    pub arrays: Vec<ArrayDecl>,
    /// OPTIONAL per-column DISPLAY LABELS, keyed by column name — `{ <column>:
    /// "<display label>" }` (ITEM-14 / DEC-4). Carried verbatim from
    /// [`DatatypeContribution::labels`](crate::modules::extensions::types::DatatypeContribution)
    /// and served on `GET /api/datatypes`, which is what populates the FE registry the
    /// consumer reads (`WorkbenchDataSource`'s `columnLabel` dep is
    /// `datatypeRegistry.get(id)?.labels?.[name]`).
    ///
    /// It is the ONE surviving piece of the deleted `axes[].annotations` forecast, because a
    /// raw column name → a human label is the one fact about a column that is NOT derivable
    /// from the data. It is a LOOKUP, not a schema claim: silent for a column it does not
    /// mention, so — unlike the list it replaced — it can never assert that a column exists.
    /// That is why it coexists with INV-5 rather than contradicting it.
    ///
    /// This field had NO Rust home for three rounds: the manifest declared it, the TS mirror
    /// declared it and the FE read it, but `to_datatype()` had nothing to copy it into, so the
    /// value was permanently `undefined` at its only consumer. Do not remove it without
    /// removing the consumer, the TS mirror and the build-gate mirror in the same change —
    /// a half-present lookup is worse than none, because it looks wired.
    /// `#[serde(default)]` keeps the wire back-compatible — an omitted `labels` parses empty.
    #[serde(default)]
    pub labels: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub viewers: Vec<ViewerRef>,
    #[serde(default)]
    pub ingest: Option<IngestSpec>,
    /// The file SHAPE an uploaded input of this type must arrive as (ITEM-13) — drives
    /// the upload wizard's picker + pre-upload validation. `None` for types that are
    /// never directly uploaded (produced by a converter, abstract, etc.).
    #[serde(default)]
    pub input_requirements: Option<InputRequirements>,
    #[serde(default)]
    pub converters: Vec<ConverterRef>,
    /// An abstract type is a gating supertype only — no artifact is ever directly of
    /// it (DEC-10). Validation forbids an artifact whose datatype is abstract.
    #[serde(default)]
    pub is_abstract: bool,
}

impl Datatype {
    /// Does this datatype advertise `cap`?
    pub fn has_capability(&self, cap: &str) -> bool {
        self.capabilities.iter().any(|c| c == cap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-17: the contract types serde round-trip with every field, and every wire
    // tag (the discriminant the TS mirror switches on) is pinned — including the
    // open-vocabulary variants no current seed constructs (`Csr`, `FileLayout::Prefix`),
    // which exercises the FULL declared contract.
    #[test]
    fn contract_serde_roundtrips_full_datatype() {
        let dt = Datatype {
            id: "x/full".into(),
            extends: Some("matrix".into()),
            title: "Full".into(),
            description: "d".into(),
            schema: serde_json::json!({"type": "object"}),
            storage: StorageSpec {
                layout: LayoutKind::ChunkedSparse {
                    orientation: SparseOrientation::Csr,
                },
                format: "zarr".into(),
                file_layout: FileLayout::Prefix,
            },
            capabilities: vec!["sliceable".into(), "genomic-coords".into()],
            axes: vec![
                AxisSpec {
                    name: "cell".into(),
                    key_label: "barcode".into(),
                },
                AxisSpec {
                    name: "gene".into(),
                    key_label: "gene_id".into(),
                },
            ],
            // Deliberately the SECOND declared axis: this fixture pins the entity axis as
            // a NAME that a positional rule could not have produced, so a regression back
            // to `axes[0]` cannot round-trip through it unnoticed.
            entity_axis: Some("gene".into()),
            arrays: vec![ArrayDecl {
                name: "X".into(),
                kind: "matrix".into(),
                dims: vec![
                    ArrayDim::Axis {
                        axis: "cell".into(),
                    },
                    ArrayDim::Axis {
                        axis: "gene".into(),
                    },
                ],
                attrs: vec![ArrayAttr {
                    name: "value".into(),
                    dtype: "f32".into(),
                }],
                layout: LayoutKind::ChunkedSparse {
                    orientation: SparseOrientation::Csc,
                },
            }],
            labels: std::collections::HashMap::from([
                ("pct_mito".to_string(), "% Mitochondrial".to_string()),
                (
                    "n_genes_by_counts".to_string(),
                    "Genes detected".to_string(),
                ),
            ]),
            viewers: vec![ViewerRef {
                view_kind_id: "v".into(),
                family: "deckgl".into(),
                consumes: vec!["sliceable".into()],
            }],
            ingest: Some(IngestSpec {
                extensions: vec!["h5".into()],
                magic_hex: vec!["504b0304".into()],
            }),
            input_requirements: Some(InputRequirements::Manifest {
                members: vec!["matrix.mtx".into(), "barcodes.tsv".into()],
                allow_archive: true,
            }),
            converters: vec![ConverterRef {
                from: "a".into(),
                to: "b".into(),
                run: ConverterRun::Sandbox,
                entry: Some("e".into()),
            }],
            is_abstract: false,
        };
        let wire = serde_json::to_value(&dt).unwrap();
        let back: Datatype = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(dt, back, "full round-trip preserves every field");
        // Spot-check the serde tags the TS mirror discriminates on.
        assert_eq!(wire["storage"]["layout"]["kind"], "chunked_sparse");
        assert_eq!(wire["storage"]["layout"]["orientation"], "csr");
        assert_eq!(wire["storage"]["file_layout"], "prefix");
        // ITEM-14 (INVERSE pin — it holds the REMOVAL): the tier system and the
        // selector→layout-index map are GONE from the declared contract. A datatype
        // answers `is_a`, and nothing else.
        let storage = wire["storage"].as_object().expect("storage object");
        assert!(
            storage.contains_key("layout"),
            "storage lost its layout — the absence checks below would be vacuous"
        );
        for dropped in ["selector_map", "tiers"] {
            assert!(
                !storage.contains_key(dropped),
                "`storage.{dropped}` came back to the datatype contract (ITEM-14)"
            );
        }
        assert!(
            !wire["arrays"][0]
                .as_object()
                .expect("array object")
                .contains_key("selector_map"),
            "`arrays[].selector_map` came back to the datatype contract (ITEM-14)"
        );
        assert_eq!(wire["converters"][0]["run"], "sandbox");
        assert_eq!(wire["input_requirements"]["requires"], "manifest");
        assert_eq!(wire["input_requirements"]["allow_archive"], true);
        // ITEM-3: the declared axes serialize as `{name,key_label}` pairs.
        assert_eq!(wire["axes"][0]["name"], "cell");
        assert_eq!(wire["axes"][0]["key_label"], "barcode");
        assert_eq!(wire["axes"][1]["name"], "gene");
        // INV-5 (INVERSE pin — it holds the REMOVAL): an axis carries IDENTITY ONLY. The
        // per-axis column forecast is gone from the wire, so a re-added field would fail
        // here as well as at `boot_axis_tests::axis_identity_carries_no_column_forecast`.
        let axis = wire["axes"][0].as_object().expect("axis object");
        assert!(
            axis.contains_key("name") && axis.contains_key("key_label"),
            "the axis lost its identity — the absence check below would be vacuous"
        );
        assert!(
            !axis.contains_key("annotations"),
            "`axes[].annotations` came back to the datatype contract — a column forecast \
             re-entering through the type (INV-5)"
        );
        // INV-7: the declared arrays[] round-trip — dims as `{axis}`/`{k}`, typed attrs,
        // an own layout.
        assert_eq!(wire["arrays"][0]["name"], "X");
        assert_eq!(wire["arrays"][0]["kind"], "matrix");
        assert_eq!(wire["arrays"][0]["dims"][0]["axis"], "cell");
        assert_eq!(wire["arrays"][0]["dims"][1]["axis"], "gene");
        assert_eq!(wire["arrays"][0]["attrs"][0]["name"], "value");
        assert_eq!(wire["arrays"][0]["attrs"][0]["dtype"], "f32");
        assert_eq!(wire["arrays"][0]["layout"]["kind"], "chunked_sparse");
        // ITEM-14 / DEC-4: the per-column DISPLAY-LABEL lookup is ON the wire, keyed by the
        // column's OWN NAME. This is the layer that silently dropped it — `to_datatype()`
        // built a `Datatype` with no such field to copy into — so the contract pin belongs
        // here beside the axes/arrays pins, not only in the end-to-end test.
        assert_eq!(wire["labels"]["pct_mito"], "% Mitochondrial");
        assert_eq!(wire["labels"]["n_genes_by_counts"], "Genes detected");
        // A LOOKUP, not a schema claim: silent for a column it does not mention, which is
        // the property `axes[].annotations` lacked and the reason this key coexists with
        // INV-5. (`total_counts` is a real QC output column — absent here on purpose.)
        assert!(
            wire["labels"]
                .as_object()
                .expect("labels object")
                .get("total_counts")
                .is_none(),
            "an unmentioned column must be SILENT — `labels` may never assert a column exists"
        );
    }

    // INV-5: an `AxisSpec` is IDENTITY ONLY — `{name, key_label}` and nothing else. This
    // replaces `axis_spec_annotations_roundtrip`, which asserted the opposite contract (that
    // a per-axis column forecast round-tripped through the type, typed by every
    // `AnnotationType` discriminant). The forecast is deleted, so the test that certified it
    // is deleted with it, and this holds the REMOVAL: the round-trip must survive a wire
    // object carrying an `annotations` key WITHOUT that key becoming data again.
    #[test]
    fn axis_spec_is_identity_only() {
        let axis: AxisSpec =
            serde_json::from_value(serde_json::json!({ "name": "cells", "key_label": "barcode" }))
                .expect("an identity-only axis parses");
        let wire = serde_json::to_value(&axis).unwrap();
        // NOTE the comparison is on the key SET, sorted. `serde_json::Map` is a `BTreeMap`
        // (the `preserve_order` feature is not enabled anywhere in this workspace), so the
        // serialized key order is ALPHABETICAL and never the declaration order — asserting a
        // declaration-ordered `["name", "key_label"]` can never hold, whatever the fields are.
        let keys: Vec<&str> = wire
            .as_object()
            .expect("axis object")
            .keys()
            .map(|k| k.as_str())
            .collect();
        assert_eq!(
            keys,
            vec!["key_label", "name"],
            "an axis serializes identity only — any extra field is a column forecast"
        );
        let back: AxisSpec = serde_json::from_value(wire).unwrap();
        assert_eq!(axis, back, "identity-only AxisSpec round-trips");

        // A legacy declaration still carrying `annotations:` cannot smuggle the forecast
        // back in as DATA. (The manifest path is hard-failed earlier and harder: the build
        // gate's `DcAxisSpec` is `deny_unknown_fields`, so such a manifest fails the BUILD.)
        let legacy: AxisSpec = serde_json::from_value(serde_json::json!({
            "name": "cells",
            "key_label": "barcode",
            "annotations": [{ "name": "pct_flagged", "label": "L", "type": "continuous", "capability": "c" }],
        }))
        .expect("a legacy axis still parses");
        assert_eq!(
            serde_json::to_value(&legacy).unwrap(),
            serde_json::json!({ "name": "cells", "key_label": "barcode" }),
            "a legacy `annotations` block is not carried — there is no field to hold it",
        );
    }

    // INV-7: the open-axis `arrays[]` schema. A datatype declares a LIST of arrays over
    // an OPEN axis set (NOT a fixed obs/var pair): each binds its dims to declared axes
    // OR an anonymous `k`, carries typed attrs, owns its own layout.
    // Parses from the R4 wire shape; an unknown array field is DENIED; a `{}` dim errors.
    #[test]
    fn open_axis_arrays_parse_from_wire() {
        // A COMPOSITE kind's multi-array declaration over three DISTINCT axes — none of
        // which is obs/var (`cluster`, `lineage`) — the exact shape SOMA cannot hold.
        let wire = serde_json::json!({
            "id": "trajectory/paga",
            "extends": "graph/attributed",
            "title": "PAGA trajectory",
            "description": "d",
            "axes": [
                { "name": "obs",     "key_label": "barcode" },
                { "name": "cluster", "key_label": "cluster_id" },
                { "name": "lineage", "key_label": "lineage_id" }
            ],
            "arrays": [
                { "name": "pseudotime", "kind": "annotation-table",
                  "dims": [ { "axis": "obs" } ],
                  "attrs": [ { "name": "pseudotime", "dtype": "f32" } ],
                  "layout": { "kind": "columnar_table" } },
                { "name": "abstracted_graph", "kind": "graph",
                  "dims": [ { "axis": "cluster" }, { "axis": "cluster" } ],
                  "attrs": [ { "name": "connectivity", "dtype": "f32" } ],
                  "layout": { "kind": "chunked_sparse", "orientation": "csr" } },
                { "name": "cluster_pos", "kind": "embedding",
                  "dims": [ { "axis": "cluster" }, { "k": 2 } ],
                  "layout": { "kind": "chunked_dense" } }
            ],
            "storage": {
                "layout": { "kind": "chunked_sparse", "orientation": "csr" },
                "format": "zarr", "file_layout": "manifest"
            }
        });
        let dt: Datatype = serde_json::from_value(wire).expect("open-axis arrays parse");
        assert_eq!(dt.arrays.len(), 3);
        // The graph array binds BOTH dims to the SAME non-obs/var axis (`cluster`).
        let g = &dt.arrays[1];
        assert_eq!(g.name, "abstracted_graph");
        assert_eq!(g.axes(), vec!["cluster", "cluster"]);
        assert!(matches!(
            g.layout,
            LayoutKind::ChunkedSparse {
                orientation: SparseOrientation::Csr
            }
        ));
        // The embedding array mixes a declared axis with an anonymous positional `k`.
        let e = &dt.arrays[2];
        assert_eq!(
            e.dims[0],
            ArrayDim::Axis {
                axis: "cluster".into()
            }
        );
        assert_eq!(e.dims[1], ArrayDim::Anon { k: 2 });
        assert_eq!(
            e.axes(),
            vec!["cluster"],
            "an anonymous `k` dim is not an axis"
        );
    }

    // INV-7: `deny_unknown_fields` — a typo'd array/attr field is a parse ERROR (the
    // separability-gate discipline), and an axis-less `{}` dim matches neither untagged
    // variant and errors (the exactly-one guard).
    #[test]
    fn open_axis_schema_denies_unknown_and_empty_dim() {
        // Unknown field on an ArrayDecl → denied.
        let bad_field = serde_json::json!({
            "name": "X", "kind": "matrix", "dims": [ { "axis": "obs" } ],
            "layout": { "kind": "chunked_dense" }, "typpo": true
        });
        assert!(
            serde_json::from_value::<ArrayDecl>(bad_field).is_err(),
            "unknown ArrayDecl field denied"
        );
        // Unknown field on an ArrayAttr → denied.
        let bad_attr = serde_json::json!({ "name": "v", "dtype": "f32", "extra": 1 });
        assert!(
            serde_json::from_value::<ArrayAttr>(bad_attr).is_err(),
            "unknown ArrayAttr field denied"
        );
        // A `{}` dim (neither axis nor k) → error.
        assert!(
            serde_json::from_value::<ArrayDim>(serde_json::json!({})).is_err(),
            "empty dim errors"
        );
        // The two valid dim forms round-trip.
        assert_eq!(
            serde_json::from_value::<ArrayDim>(serde_json::json!({ "axis": "obs" })).unwrap(),
            ArrayDim::Axis { axis: "obs".into() }
        );
        assert_eq!(
            serde_json::from_value::<ArrayDim>(serde_json::json!({ "k": 50 })).unwrap(),
            ArrayDim::Anon { k: 50 }
        );
    }

    // INV-7 back-compat: a datatype wire with NO `arrays` parses as empty (a
    // single-implicit-array datatype's `storage` IS its one array).
    #[test]
    fn arrays_defaults_empty_when_absent() {
        let wire = serde_json::json!({
            "id": "x/no-arrays", "title": "t", "description": "d",
            "storage": {
                "layout": { "kind": "opaque_as_is" }, "format": "any",
                "file_layout": "single"
            }
        });
        let dt: Datatype = serde_json::from_value(wire).expect("parses without arrays");
        assert!(
            dt.arrays.is_empty(),
            "an omitted `arrays` defaults to empty (wire back-compat)"
        );
    }

    // ITEM-3: an `axes`-less wire object parses (back-compat) as empty axes.
    #[test]
    fn axes_defaults_empty_when_absent() {
        let wire = serde_json::json!({
            "id": "x/no-axes",
            "title": "No axes",
            "description": "d",
            "storage": {
                "layout": { "kind": "opaque_as_is" },
                "format": "any",
                "file_layout": "single"
            }
        });
        let dt: Datatype = serde_json::from_value(wire).expect("parses without axes");
        assert!(
            dt.axes.is_empty(),
            "an omitted `axes` defaults to empty (wire back-compat)"
        );
    }

    // ITEM-4: SupportingKind — canonical variants round-trip as snake_case; an UNKNOWN
    // string deserializes to `Other`, never a parse error (DEC-22).
    #[test]
    fn supporting_kind_open_vocabulary() {
        let cases = [
            (SupportingKind::AnnotationTable, "annotation_table"),
            (SupportingKind::AxisDefinition, "axis_definition"),
            (SupportingKind::IndexCompanion, "index_companion"),
            (SupportingKind::Reference, "reference"),
            (SupportingKind::Auxiliary, "auxiliary"),
        ];
        for (kind, tag) in cases {
            let v = serde_json::to_value(&kind).unwrap();
            assert_eq!(v, serde_json::json!(tag), "SupportingKind wire tag");
            let back: SupportingKind = serde_json::from_value(v).unwrap();
            assert_eq!(kind, back);
        }
        // An unknown kind → Other, not a hard error.
        let unknown: SupportingKind =
            serde_json::from_value(serde_json::json!("proteomics_peptide_table")).unwrap();
        assert_eq!(
            unknown,
            SupportingKind::Other("proteomics_peptide_table".into())
        );
        // Other round-trips back to its raw string.
        assert_eq!(
            serde_json::to_value(&unknown).unwrap(),
            serde_json::json!("proteomics_peptide_table")
        );
    }

    // ITEM-4: Alignment — the strategy-tagged descriptor round-trips; v1 `key_join`
    // carries axis + optional key_column + normalize; `None_` serializes as `none`.
    #[test]
    fn alignment_descriptor_wire() {
        let kj = Alignment::KeyJoin {
            axis: "cells".into(),
            key_column: Some("barcode".into()),
            normalize: vec!["strip_10x_suffix".into(), "trim".into()],
        };
        let v = serde_json::to_value(&kj).unwrap();
        assert_eq!(v["strategy"], "key_join");
        assert_eq!(v["axis"], "cells");
        assert_eq!(v["key_column"], "barcode");
        assert_eq!(v["normalize"][0], "strip_10x_suffix");
        assert_eq!(serde_json::from_value::<Alignment>(v).unwrap(), kj);

        // Positional + Namespace + None_ tags.
        assert_eq!(
            serde_json::to_value(Alignment::Positional).unwrap()["strategy"],
            "positional"
        );
        assert_eq!(
            serde_json::to_value(Alignment::Namespace {
                id_system: "grch38".into()
            })
            .unwrap()["strategy"],
            "namespace"
        );
        let none = serde_json::to_value(Alignment::None_).unwrap();
        assert_eq!(none["strategy"], "none");
        assert_eq!(
            serde_json::from_value::<Alignment>(none).unwrap(),
            Alignment::None_
        );

        // A key_join with an absent key_column/normalize parses (auto-detect path).
        let bare: Alignment =
            serde_json::from_value(serde_json::json!({"strategy":"key_join","axis":"genes"}))
                .unwrap();
        assert_eq!(
            bare,
            Alignment::KeyJoin {
                axis: "genes".into(),
                key_column: None,
                normalize: vec![]
            }
        );
    }

    // InputRequirements wire tags match the TS `InputRequirements` union (parity).
    #[test]
    fn input_requirements_wire_tags() {
        let single = serde_json::to_value(InputRequirements::Single).unwrap();
        assert_eq!(single["requires"], "single");
        let manifest = serde_json::to_value(InputRequirements::Manifest {
            members: vec!["matrix.mtx".into()],
            allow_archive: false,
        })
        .unwrap();
        assert_eq!(manifest["requires"], "manifest");
        assert_eq!(manifest["members"][0], "matrix.mtx");
        // `#[serde(default)]` does not skip serialization → the field is always present.
        assert_eq!(manifest["allow_archive"], false);
        // Both round-trip.
        let back: InputRequirements = serde_json::from_value(single).unwrap();
        assert_eq!(back, InputRequirements::Single);
    }

    // Every LayoutKind wire tag matches the TS `LayoutKind` union (parity — pins the
    // `chunked_1d` rename fix + all siblings).
    #[test]
    fn layout_kind_wire_tags() {
        let cases = [
            (LayoutKind::ChunkedDense, "chunked_dense"),
            (
                LayoutKind::ChunkedSparse {
                    orientation: SparseOrientation::Csc,
                },
                "chunked_sparse",
            ),
            (LayoutKind::ColumnarTable, "columnar_table"),
            (LayoutKind::Chunked1d, "chunked_1d"),
            (LayoutKind::OpaqueAsIs, "opaque_as_is"),
        ];
        for (kind, tag) in cases {
            let v = serde_json::to_value(&kind).unwrap();
            assert_eq!(v["kind"], tag, "LayoutKind wire tag");
            // Round-trips back to the same variant.
            let back: LayoutKind = serde_json::from_value(v).unwrap();
            assert_eq!(kind, back);
        }
    }
}
