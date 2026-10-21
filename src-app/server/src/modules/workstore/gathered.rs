//! **ITEM-17/19 — serving a GATHERED artifact: synthetic Zarr + the chunk gather.**
//!
//! A gathered artifact has no blob (ITEM-16). Its `structure.gathered_from` names a source
//! artifact and a ROW VECTOR, and this module produces, on demand, exactly the bytes a
//! stored artifact would have had. **The client cannot tell** — that is INV-3, and it is the
//! design's central claim, which is why the proof is a client-side parity test
//! (`zarrReader.gatheredParity.test.ts`) rather than anything asserted here.
//!
//! ## Why the client cannot tell — the three premises, verified at the point of use
//!
//! Each was carried forward from an abandoned branch as a DOCUMENT and re-checked against
//! `ui/src/core/workstore/zarrReader.ts` before a line of this was written:
//!
//! * **codecs are per-array** — `splitCodecChain` returns `codecs.slice(bytesAt + 1)`, so a
//!   chain of exactly `[bytes]` leaves an EMPTY bytes→bytes chain and the reader returns the
//!   stored bytes untouched. An uncompressed virtual array is decodable.
//! * **sharding is OPTIONAL** — `sharded = sharding !== undefined`, and the `else` branch
//!   sets `innerChunkElements = outerChunkElements`, `chain = splitCodecChain(codecs)`,
//!   `chunksPerShard = 1`. `#plainChunkBytes` is the live unsharded read path. This was the
//!   riskiest premise: every artifact the Python writer emits is sharded, so the unsharded
//!   branch could have been dead code. It is not.
//! * **chunk geometry** — `#assertRowChunked` permits splitting dimension 0 only. A 1-D
//!   column satisfies it by construction.
//!
//! So a gathered array declares: `zarr_format 3`, a `regular` chunk grid, `codecs: [bytes]`,
//! and NO sharding. The reader then fetches `c/0`, `c/1`, … — which is why serving these
//! needs **no new route**: they are members, and `serve_data_inner`'s member arm already
//! forks here.

use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use ziee_core::AppError;

/// **The error code every gather-recipe refusal carries (audit finding 12).**
///
/// Same reasoning as `ALIGNMENT_DECLARATION_INVALID`: a malformed `structure.gathered_from`,
/// an empty `sources`, an empty `column_selector`, a row vector whose entries address past
/// the source they were computed against — all statements about a row's DECLARATION, none
/// about the server failing. A 500 points the operator at logs that will say nothing.
const GATHER_RECIPE_INVALID: &str = "GATHER_RECIPE_INVALID";

/// **The resolution recipe carried at `structure.gathered_from` (DEC-8).**
///
/// Its PRESENCE is what makes a row gathered — there is no discriminant column, and the
/// `artifacts_bytes_or_recipe` CHECK constraint makes "recipe xor object_key" a database
/// invariant rather than a convention.
///
/// ## What it is, and what it deliberately is NOT
///
/// DEC-8 fixes the content: **alignment id + source ids + column selector**. It is a
/// REFERENCE to the alignment artifact the producer emitted, not a copy of it. The two
/// superseded shapes both tried to carry the alignment's own content inline — first as a
/// single source plus a row-vector artifact, then as an inline segment model — and both were
/// dialects no producer writes. The alignment's vectors live inside the alignment artifact,
/// where the producer put them; this side names it and reads it (see
/// [`crate::modules::workstore::alignment::AlignmentPlan`]).
///
/// ```json
/// "gathered_from": {
///   "alignment_artifact_id": "…uuid…",
///   "column_selector": "values",
///   "alignment_column": "group",
///   "sources": [ { "dataset_id": "ds-a", "artifact_id": "…uuid…" }, … ]
/// }
/// ```
///
/// `sources` is the (dataset → artifact) resolution made once, when the virtual dataset is
/// created, rather than re-derived per request: the alignment names DATASETS, the byte plane
/// addresses ARTIFACTS, and re-deriving that mapping at read time would let a later import
/// silently re-point an existing virtual dataset at different bytes.
#[derive(Debug, Clone, Deserialize)]
pub struct GatheredSource {
    /// Matches an `AlignmentPlan::sources[…].dataset_id`. Matched **by name, never by
    /// position** — the two lists are written by different sides and their orders are not a
    /// contract.
    pub dataset_id: String,
    /// The artifact whose member bytes this source contributes.
    pub artifact_id: Uuid,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GatheredFrom {
    /// The producer-emitted `dataset-alignment` artifact this column reads through, or
    /// `None` when this recipe reads a SINGLE source through a MASK alone (§3.4-correction,
    /// ITEM-2).
    ///
    /// **Nullable, subject to the source-count rule.** An INTEGRATION fuses two or more
    /// sources, and the join across them is a fact no reader may re-derive (INV-3), so a
    /// multi-source recipe MUST name its alignment. A single-source FILTER carries no join —
    /// there is nothing to align a lone source to — so its alignment is legitimately absent
    /// and the row selection rides `mask_artifact_id` instead. The pairing
    /// (`sources ≥ 2 ⇒ alignment NOT NULL`) is a database CHECK
    /// (`artifacts_recipe_alignment_or_single_source`, DEC-8) so a violating recipe cannot
    /// commit, and it is re-asserted in [`GatheredFrom::parse`] so a hand-built `structure`
    /// that reached a reader without passing the constraint is refused rather than served.
    ///
    /// Read it through [`GatheredFrom::require_alignment`] on any alignment-gather path — a
    /// `None` there is a routing bug (a masked single-source recipe took the alignment path),
    /// not a value to unwrap.
    #[serde(default)]
    pub alignment_artifact_id: Option<Uuid>,
    /// The MASK artifact this recipe's rows are selected by, or `None` for the identity case
    /// (§11.1b / INV-11: absence encodes "keep everything"; an all-ones mask is never
    /// materialised).
    ///
    /// The mask is a per-source packed boolean in each source's OWN row order (DEC-1/DEC-11),
    /// owned by the virtual dataset (`role='mask'`, `hidden`, exactly one per VD). A gathered
    /// column names it so the masked serve path (ITEM-3, Stage B) can resolve output rows
    /// from `segments + mask + rank`; a recipe with neither an alignment nor a mask is the
    /// identity read of a lone source.
    #[serde(default)]
    pub mask_artifact_id: Option<Uuid>,
    /// Which member of each source artifact is being gathered.
    ///
    /// A path INSIDE the source artifact's store (`values`, `expression/values`), never the
    /// alignment's name for the column. See [`GatheredFrom::alignment_column`].
    pub column_selector: String,
    /// The name the ALIGNMENT knows this column by — the key into `levels__<column>__<i>`
    /// and into `attributes.cyto_alignment.unified_levels`.
    ///
    /// **This used to be `column_selector`, and the two coinciding was a property of the old
    /// reference fixture, not of the producer.** That fixture carried every column of a
    /// dataset in ONE `rows.zarr` store, so the member was named after the column and one
    /// string served both jobs. Stage 1's slot rework makes each grid entry its own artifact:
    /// the fused categorical arrives as the `level:<i>:<column>` binding, whose store is a
    /// `metadata-column` and whose member is **always `values`**, with the column's own name
    /// carried by the SLOT and never staged into the store. So the member path is `values`
    /// and the alignment's column is `group` — two different strings, and a reader that
    /// keyed the level lookups on the member path would find none, take the
    /// `remaps_levels_for == false` branch, and serve each source's RAW per-source codes.
    /// That is CRITICAL-2 of this stage exactly, re-reachable through a name.
    ///
    /// `null` means *this gather is not of a fused categorical* — the key/identifier gather
    /// (ITEM-22(b)) has no alignment column at all; that absence is a DECLARATION that no
    /// remap applies. A name that IS declared but that the alignment does not fuse is refused
    /// by [`super::gather_exec`] rather than silently serving raw codes.
    ///
    /// **A MISSING key is a third state and is not the same fact** — see
    /// [`GatheredFrom::vocabulary`].
    #[serde(default)]
    pub alignment_column: Option<String>,
    /// Whether the `alignment_column` KEY was present at all, captured at parse time.
    ///
    /// `Option<String>` alone collapses "declared to have no fused vocabulary" onto "the
    /// writer never mentioned it", and those are two facts with two remedies. This field is
    /// what keeps them apart; read it through [`GatheredFrom::vocabulary`], never directly.
    #[serde(skip)]
    column_key_present: bool,
    /// One entry per source dataset of the alignment.
    pub sources: Vec<GatheredSource>,
}

/// **What a recipe SAYS about its fused vocabulary — three states, not two.**
///
/// `Option<String>` has two inhabitants and the recipe has three facts, so the type was
/// lossy in exactly the direction that hurts:
///
/// | JSON | fact | what a reader should do |
/// |---|---|---|
/// | `"alignment_column": "group"` | this gather is of a FUSED categorical | remap the codes through `levels__group__<i>` |
/// | `"alignment_column": null` | DECLARED to fuse nothing — the key gather (ITEM-22(b)) | serve the bytes as they are |
/// | *(key absent)* | **nothing was declared** | refuse; a writer that omitted it and a key gather are indistinguishable, and guessing "no remap" serves each source's raw code space |
///
/// The first two were already distinct. The third collapsed onto the second under
/// `#[serde(default)]`, which means **a creator (or a migration, or a hand-written row) that
/// simply forgot the key would take the no-remap branch and re-open CRITICAL-2 through
/// ABSENCE** — no error, no log, the right row count, and one dataset's rows wearing
/// another dataset's labels.
///
/// This is the "make the distinction exist in the TYPE, not in the assertion" move: no
/// output-level assertion can separate two states that produce identical output, so the
/// separation has to be upstream of the output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ColumnVocabulary {
    /// The alignment's name for this column.
    Fused(String),
    /// Explicitly `null` — the recipe declares that no fused vocabulary applies.
    DeclaredNone,
    /// The key is absent. Nothing was declared, so nothing may be assumed.
    Undeclared,
}

impl GatheredFrom {
    /// Parse the recipe out of a `structure`, or say precisely what is missing.
    pub fn parse(structure: &Value) -> Result<Self, AppError> {
        let raw = structure.get("gathered_from").ok_or_else(|| {
            AppError::bad_request(
                GATHER_RECIPE_INVALID,
                "artifact has no object_key and no `structure.gathered_from` — the \
                 `artifacts_bytes_or_recipe` CHECK should have made this row unrepresentable, \
                 so reaching here means the constraint was dropped or bypassed",
            )
        })?;
        let column_key_present = raw
            .as_object()
            .is_some_and(|o| o.contains_key("alignment_column"));
        let parsed: Self = serde_json::from_value(raw.clone()).map_err(|e| {
            AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!("malformed `structure.gathered_from`: {e}"),
            )
        })?;
        if parsed.sources.is_empty() {
            return Err(AppError::bad_request(
                GATHER_RECIPE_INVALID,
                "`structure.gathered_from.sources` is empty, so no dataset of the alignment \
                 resolves to bytes. An alignment over zero sources is not an alignment",
            ));
        }
        if parsed.column_selector.is_empty() {
            return Err(AppError::bad_request(
                GATHER_RECIPE_INVALID,
                "`structure.gathered_from.column_selector` is empty — which member of each \
                 source to gather is then undefined, and a guess here reads plausible bytes \
                 out of the wrong column",
            ));
        }
        // The source-count rule, re-asserted at the READ boundary (ITEM-2 / DEC-8). The
        // `artifacts_recipe_alignment_or_single_source` CHECK makes a violating row
        // uncommittable, so this can only fire for a `structure` that reached a reader without
        // passing the constraint (a hand-built fixture, a bypassed insert). A multi-source
        // gather with no alignment would serve rows from an intersection nobody computed —
        // the join re-derivation INV-3 forbids — so it is refused here rather than guessed.
        if parsed.sources.len() >= 2 && parsed.alignment_artifact_id.is_none() {
            return Err(AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!(
                    "`structure.gathered_from` fuses {} sources but names no \
                     `alignment_artifact_id`. Two or more sources join through an alignment \
                     that is the AUTHORITY (INV-3); a null alignment is legal only for a \
                     single-source masked recipe. Re-deriving the join here would return rows \
                     from an intersection nobody computed",
                    parsed.sources.len()
                ),
            ));
        }
        Ok(Self {
            column_key_present,
            ..parsed
        })
    }

    /// The alignment id this recipe reads through, or a refusal when the recipe declares none.
    ///
    /// A single-source FILTER recipe (the mask case, §3.4) carries `alignment_artifact_id:
    /// null` and is served by the masked read path (ITEM-3, Stage B), NOT the alignment
    /// gather. Every alignment-gather site funnels the null through this ONE refusal instead
    /// of unwrapping: the CHECK + [`GatheredFrom::parse`] guarantee a multi-source recipe HAS
    /// an alignment, so reaching an alignment-gather path with `None` means a single-source
    /// masked recipe took the alignment route by mistake — a routing bug, named as one.
    pub fn require_alignment(&self) -> Result<Uuid, AppError> {
        self.alignment_artifact_id.ok_or_else(|| {
            AppError::bad_request(
                GATHER_RECIPE_INVALID,
                "this recipe declares no alignment (`alignment_artifact_id: null`): it is a \
                 single-source masked recipe, served by the masked read path rather than the \
                 alignment gather. Reaching the alignment gather with no alignment is a \
                 routing bug, not a user error",
            )
        })
    }

    /// The three-state reading of `alignment_column`. See [`ColumnVocabulary`].
    pub fn vocabulary(&self) -> ColumnVocabulary {
        match (&self.alignment_column, self.column_key_present) {
            (Some(c), _) => ColumnVocabulary::Fused(c.clone()),
            (None, true) => ColumnVocabulary::DeclaredNone,
            (None, false) => ColumnVocabulary::Undeclared,
        }
    }

    /// The artifact contributing one alignment source's bytes, **looked up by dataset id**.
    ///
    /// Positional lookup is the failure this signature rules out: the alignment's source
    /// order is the producer's, the recipe's is this side's, and nothing keeps them equal.
    pub fn artifact_for_dataset(&self, dataset_id: &str) -> Result<Uuid, AppError> {
        self.sources
            .iter()
            .find(|s| s.dataset_id == dataset_id)
            .map(|s| s.artifact_id)
            .ok_or_else(|| {
                AppError::bad_request(
                    "GATHER_SOURCE_UNRESOLVED",
                    format!(
                        "the alignment reads through dataset {dataset_id:?}, which this \
                         column's recipe does not resolve to an artifact. Known: {:?}. \
                         Serving anything here would be bytes from a dataset the user did \
                         not align",
                        self.sources
                            .iter()
                            .map(|s| s.dataset_id.as_str())
                            .collect::<Vec<_>>()
                    ),
                )
            })
    }

    /// The source ids that enter the DEFINITION hash (ITEM-26), in a stable form.
    pub fn definition_source_ids(&self) -> Vec<String> {
        self.sources.iter().map(|s| s.dataset_id.clone()).collect()
    }

    /// Every source dataset this column reads through — what GC must keep reachable.
    pub fn source_dataset_ids(&self) -> Vec<&str> {
        self.sources.iter().map(|s| s.dataset_id.as_str()).collect()
    }
}

/// The PRODUCTION chunk size for a gathered array, in elements.
///
/// **This was `4` until a blind audit pointed at it**, chosen so the parity fixture would
/// span several chunks — a test constant on the production wire. At 4 elements a real column
/// is one HTTP request per 4 rows: a million-row column is 250,000 requests, each re-running
/// the whole resolution. The value that belongs here is the writer's own inner-chunk size, so
/// a gathered array chunks like a stored one and the client's fetch pattern is unchanged.
pub const CHUNK_ELEMENTS: usize = 4096;

/// The size the SINGLE-source `gather_chunk` and the committed parity fixture use.
///
/// Kept small deliberately: that function exists only to produce the fixture the client
/// parity test reads, and a fixture that fits in one chunk cannot exercise the cross-chunk
/// path. It is not on the production wire — `gather_chunk_multi` is, and it takes its size
/// from the artifact's declaration.
pub const CHUNK_ELEMENTS_TEST: usize = 4;

/// How many elements one chunk of THIS artifact holds.
///
/// Read from the artifact's own declaration (`structure.chunk_elements`) and defaulting to
/// [`CHUNK_ELEMENTS`]. Declared rather than global because a fixture needs a small value to
/// exercise the cross-chunk path and production needs a large one — and an ENV seam would
/// have put that difference somewhere the artifact's own `zarr.json` could not see, leaving
/// the declaration and the served chunking free to disagree. Here they cannot: the same
/// number writes `zarr.json` and drives the assembly.
pub fn chunk_elements_of(structure: &Value) -> usize {
    structure
        .get("chunk_elements")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .filter(|n| *n > 0)
        .unwrap_or(CHUNK_ELEMENTS)
}

/// **DEC-B's depth limit.** A chain deeper than this is REFUSED, naming the chain.
///
/// The primary safety argument is not this number — it is that the dependency graph is a DAG
/// by construction: an alignment names sources that already EXIST at creation time, so every
/// edge points strictly backwards in creation order, and artifacts are IMMUTABLE, so an
/// existing alignment can never be re-pointed at a later dataset. A cycle is unconstructible.
///
/// This bound is defense in depth, and it exists because an unbounded recursion whose safety
/// rests on an argument — however sound — is one schema change away from a stack overflow in
/// a request handler. A bound converts that into a refusal with a message. Chains deeper than
/// 2 are not an expected workflow; 8 is comfortably beyond any plausible use while still
/// small enough that the refusal fires before any resource does.
///
/// The bound may be moved (DEC-2 promotes it to a settings row); it may NOT be removed, and
/// validation must reject a null/zero value rather than let it mean "unbounded".
pub const MAX_CHAIN_DEPTH: usize = 8;

/// Compose two row vectors: `outer` indexes into a source that is ITSELF gathered by `inner`.
///
/// This is the whole of ITEM-21's logic, and it is why DEC-B could reverse the abandoned
/// round's "a gather of a gather has no meaning". That ruling was about a MEMBERSHIP, whose
/// positions are into an axis and compose into nothing. An alignment's row vector is a
/// FUNCTION `output row -> source row`, and functions compose:
///
/// ```text
///   V.rows[r] = i          (output row r comes from V's source row i)
///   S.rows[i] = j          (…and V's source S is itself gathered: its row i is T's row j)
///   ⇒ composed[r] = j      (so output row r comes from the REAL leaf T's row j)
/// ```
///
/// Total and associative, so a chain of any depth collapses to ONE vector into a real leaf —
/// which is what lets the reader do a single gather rather than a nested one, and what makes
/// the digest check (ITEM-20) land on the LEAF rather than on an intermediate.
pub fn compose_rows(outer: &[u32], inner: &[u32]) -> Result<Vec<u32>, AppError> {
    outer
        .iter()
        .map(|&i| {
            inner.get(i as usize).copied().ok_or_else(|| {
                AppError::bad_request(
                    GATHER_RECIPE_INVALID,
                    format!(
                        "chain composition: an outer row vector entry {i} addresses row {i} of an \
                     inner vector of length {} — the two were computed against different \
                     sources, so composing them would silently return the wrong rows",
                        inner.len()
                    ),
                )
            })
        })
        .collect()
}

/// Elements per chunk for a split column's OFFSETS member, and bytes per chunk for its
/// VALUES member — read from the artifact's own declaration, defaulting per member.
///
/// **They are independent, and that is the point.** Offsets are chunked by ELEMENT and values
/// by BYTE, so chunk 1 begins at a different place in each. A router that derives one from
/// the other — or reuses the numeric path's arithmetic for both — is right for chunk 0 and
/// wrong after it, which is the copied-offsets bug reappearing one level up.
pub fn values_chunk_bytes_of(structure: &Value) -> usize {
    structure
        .get("values_chunk_bytes")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .filter(|n| *n > 0)
        .unwrap_or(1 << 20)
}

/// The `zarr.json` for a split column's `offsets` member (`uint32`, `n+1` entries).
pub fn split_offsets_zarr_json(n_rows: usize, chunk: usize) -> Value {
    json!({
        "zarr_format": 3, "node_type": "array",
        "shape": [n_rows + 1], "data_type": "uint32",
        "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [chunk] } },
        "chunk_key_encoding": { "name": "default", "configuration": { "separator": "/" } },
        "codecs": [{ "name": "bytes", "configuration": { "endian": "little" } }],
        "fill_value": 0, "attributes": {}
    })
}

/// The `zarr.json` for a split column's `values` member (`uint8` payload).
pub fn split_values_zarr_json(n_bytes: usize, chunk_bytes: usize) -> Value {
    json!({
        "zarr_format": 3, "node_type": "array",
        "shape": [n_bytes], "data_type": "uint8",
        "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [chunk_bytes] } },
        "chunk_key_encoding": { "name": "default", "configuration": { "separator": "/" } },
        "codecs": [{ "name": "bytes", "configuration": { "endian": "little" } }],
        "fill_value": 0, "attributes": {}
    })
}

/// One chunk of a flat little-endian array, padded to full width like every other chunk here.
pub fn slice_chunk(bytes: &[u8], g: usize, chunk_elements: usize, item: usize) -> Vec<u8> {
    let lo = g * chunk_elements * item;
    if lo >= bytes.len() {
        return Vec::new();
    }
    let hi = usize::min(lo + chunk_elements * item, bytes.len());
    let mut out = vec![0u8; chunk_elements * item];
    out[..hi - lo].copy_from_slice(&bytes[lo..hi]);
    out
}

/// The keys a gathered artifact's `structure` carries for the SERVER's own use, which are
/// not part of the store declaration a client or a processor reads.
///
/// `gathered_from` is the recipe (how to produce the bytes); `chunk_elements` /
/// `values_chunk_bytes` are this store's geometry, already expressed in each array node's
/// `chunk_grid`. Stamping them into `attributes.cyto` would put a second, redundant spelling
/// of the geometry next to the authoritative one — the two-sources-of-truth shape this
/// address change exists to remove.
const SERVER_PRIVATE_STRUCTURE_KEYS: [&str; 3] =
    ["gathered_from", "chunk_elements", "values_chunk_bytes"];

/// **The GROUP node at a gathered store's root (DEC-26).**
///
/// Measured off the real writer (`tests/fixtures/stage1_alignment/sources/
/// level_0_group.zarr/zarr.json`) rather than designed: a `cyto_zarr` store's root is a
/// `group` whose `attributes.cyto` is the artifact's declaration, and its members live
/// BENEATH it. A gathered store used to serve its array AT the root, so a client following
/// `columns[].path` asked for `values/…` and got a 404 — three surfaces disagreeing about
/// where one member lives.
///
/// The attributes are the artifact's own `structure` minus
/// [`SERVER_PRIVATE_STRUCTURE_KEYS`], so the row and the served node are ONE source of truth
/// rather than two spellings that can drift.
pub fn gathered_group_zarr_json(structure: &Value) -> Result<Value, AppError> {
    let obj = structure.as_object().ok_or_else(|| {
        AppError::bad_request(
            GATHER_RECIPE_INVALID,
            "gathered artifact's structure is not an object",
        )
    })?;
    let mut cyto = serde_json::Map::new();
    for (k, v) in obj {
        if SERVER_PRIVATE_STRUCTURE_KEYS.contains(&k.as_str()) {
            continue;
        }
        cyto.insert(k.clone(), v.clone());
    }
    Ok(json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": { "cyto": Value::Object(cyto) },
    }))
}

/// **The member path a gathered store serves its one column under** (DEC-26).
///
/// Read from the artifact's own `columns[0].path` so the declaration and the address cannot
/// disagree; `values` is the fallback, which is what every `metadata-column` store the
/// producer writes uses (`cyto_columns.write_metadata_column` names its single member
/// `values`). It is never the empty string: a member at the ROOT is the address this change
/// exists to remove, and `resolveMember` cannot express it.
pub fn gathered_member_path(structure: &Value) -> String {
    structure
        .get("columns")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("path"))
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .unwrap_or("values")
        .to_string()
}

/// **The GROUP node at a SPLIT string member's own root** — `<root>/values/zarr.json`.
///
/// A split string column is a group holding `offsets` and `values` arrays, and the writer
/// stamps `{kind, name, layout, n}` on it (measured: `rows.zarr/values/zarr.json`). The
/// client's `openSplitStringColumn` reads it when the caller did not already know the row
/// count, so omitting it makes a member the reader can address but not size.
pub fn split_group_zarr_json(member: &str, n: usize) -> Value {
    json!({
        "zarr_format": 3,
        "node_type": "group",
        "attributes": { "cyto": {
            "kind": "string",
            "name": member,
            "layout": "split",
            "n": n,
        }},
    })
}

/// The `zarr.json` a gathered array declares, built from its own `structure`.
///
/// **Uncompressed and unsharded, deliberately.** Re-encoding a gathered chunk to match the
/// real chunks' shuffle+gzip would burn CPU per request for no benefit; codecs are declared
/// per array, so the same client decoder reads both.
pub fn synthetic_zarr_json(structure: &Value) -> Result<Value, AppError> {
    let n = structure.get("n").and_then(Value::as_u64).ok_or_else(|| {
        AppError::bad_request(
            GATHER_RECIPE_INVALID,
            "gathered artifact's structure has no `n`",
        )
    })?;
    let data_type = structure
        .get("data_type")
        .and_then(Value::as_str)
        .unwrap_or("float32");
    Ok(json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [n],
        "data_type": data_type,
        "chunk_grid": { "name": "regular",
                        "configuration": { "chunk_shape": [chunk_elements_of(structure)] } },
        "chunk_key_encoding": { "name": "default", "configuration": { "separator": "/" } },
        // Exactly `[bytes]`: an EMPTY bytes→bytes chain, so the reader hands back what we
        // wrote. Adding a codec here without encoding to match is the silent-corruption
        // failure the reader's own `splitCodecChain` comment warns about.
        "codecs": [{ "name": "bytes", "configuration": { "endian": "little" } }],
        "fill_value": 0,
        "attributes": {}
    }))
}

/// **The ARRAY node at `<root>/<member>/zarr.json`** — the geometry plus the member's own
/// `attributes.cyto`.
///
/// **The levels ride the ARRAY node, beside `kind`** — measured off the real writer
/// (`level_0_group.zarr/values/zarr.json`), and it is where `readCategoricalColumn`'s
/// `array.cyto?.levels` and `cyto_zarr_read.read_column`'s `attributes.cyto.kind` both
/// already look. They used to be stamped on a ROOT array no client path could reach, and
/// without the `kind` a consumer at the right address still got raw integers where every
/// real dataset gives labels.
///
/// `missing_level` (DEC-27) names which entry of `levels` was INVENTED to stand for a level
/// `authority` dropped. It is declared rather than derivable on purpose: without it the
/// browser renders absence as an ordinary category that happens to be spelled `NA`, which is
/// indistinguishable from a real level a dataset spells that way — two states agreeing in the
/// output, which no assertion on the output can separate.
///
/// A free function rather than a `ResolvedGather` method so the offline parity fixture can
/// build the SAME node the route serves. Two spellings of one declaration is how the fixture
/// and the route came to be able to drift.
pub fn gathered_array_zarr_json(
    structure: &Value,
    levels: Option<&Value>,
    missing_level: Option<&Value>,
) -> Result<Value, AppError> {
    let mut decl = synthetic_zarr_json(structure)?;
    let mut cyto = serde_json::Map::new();
    cyto.insert(
        "name".into(),
        Value::String(gathered_member_path(structure)),
    );
    let kind = structure
        .get("columns")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("kind"))
        .and_then(Value::as_str);
    if let Some(kind) = kind {
        cyto.insert("kind".into(), Value::String(kind.to_string()));
    }
    if let Some(levels) = levels {
        cyto.insert("levels".into(), levels.clone());
    }
    // **DEC-27 — which entry of `levels` means "not in this vocabulary".**
    //
    // Emitted only when the run actually dropped something, mirroring the producer, which
    // invents the level only then: a run that drops nothing has no invented entry, and a
    // key present with a null would make a consumer branch on a fact that is not there.
    //
    // The name matches `cyto_columns`' per-column `meta.missing_level` — ONE spelling for
    // this concept across the tree, so a reader that already handles a source column's
    // missing level handles a gathered one with the same code.
    if let Some(missing) = missing_level {
        cyto.insert("missing_level".into(), missing.clone());
    }
    decl["attributes"] = json!({ "cyto": Value::Object(cyto) });
    Ok(decl)
}

/// The element width of the declared dtype. Only the widths a gathered column can currently
/// carry; an unknown one is REFUSED rather than guessed, because a wrong width silently
/// reinterprets every value.
///
/// There is ONE width table. This delegates to [`super::gather_decode::item_size`] rather than
/// re-listing the dtypes: two hand-maintained match arms are exactly how these drifted (this
/// one refused `bool`, which the decoder's table has always sized at 1 byte — the width a
/// per-source boolean row mask is read at). `gather_decode`'s table is the load-bearing one —
/// it sizes the buffer the decoder actually copies — so it is the single source of truth, and
/// `an_unknown_dtype_is_refused_rather_than_sized_by_guess` fails if a second, diverging table
/// is ever reintroduced here.
pub fn item_size(data_type: &str) -> Result<usize, AppError> {
    super::gather_decode::item_size(data_type)
}

/// Verify a resolved LEAF source against the digest the pinning recipe declared (ITEM-20).
///
/// ## Why the LEAF, and why that is not obvious
///
/// Row vectors COMPOSE (ITEM-21), so a chain of any depth collapses to one vector into one
/// real leaf — and the leaf is the only artifact the gather ever reads bytes from. A check
/// against an INTERMEDIATE would therefore verify something the gather never touches: it
/// would look exactly like a check, pass and fail at plausible moments, and constrain
/// nothing. The pinning recipe is the LAST one in the chain, the one whose source is stored.
///
/// ## The three outcomes, and why two of them refuse
///
/// * declared and equal ⇒ proceed.
/// * declared and DIFFERENT ⇒ refuse, naming both. The source changed under the alignment.
/// * either side absent ⇒ refuse as **unknown**. INV-5 is explicit that a source whose
///   digest cannot be checked is "unknown, never matches" — treating absence as agreement is
///   exactly the silent-pass this check exists to prevent, and it is the reading a future
///   maintainer will be tempted toward when an old fixture lacks a digest.
pub fn verify_leaf_digest(
    leaf_id: &str,
    declared: Option<&str>,
    actual: Option<&str>,
) -> Result<(), AppError> {
    match (declared, actual) {
        (Some(d), Some(a)) if d == a => Ok(()),
        (Some(d), Some(a)) => Err(AppError::bad_request(
            "SOURCE_DIGEST_MISMATCH",
            format!(
                "source {leaf_id} no longer has the key sequence this alignment was computed \
                 against: pinned {d}, found {a}. The row vector is POSITIONAL, so reading it \
                 anyway would return the right number of the WRONG rows with nothing to \
                 indicate it. Re-run the alignment against the current source."
            ),
        )),
        (None, _) => Err(AppError::bad_request(
            "SOURCE_DIGEST_UNPINNED",
            format!(
                "the alignment does not record a key_sequence_digest for source {leaf_id}, so \
                 the gather cannot be checked. Unknown is not a match (INV-5): an unpinned \
                 positional read is the failure this refusal exists for."
            ),
        )),
        (Some(_), None) => Err(AppError::bad_request(
            "SOURCE_DIGEST_UNKNOWN",
            format!(
                "source {leaf_id} declares NEITHER `structure.key_sequence_digest` (which the \
                 writer emits on the artifact that CARRIES an axis's keys) NOR \
                 `structure.aligned_to` (which a table merely living on that axis declares). \
                 Both name the same identity from opposite sides, and this side reads both — \
                 so this is a source that pinned no identity at all, not one that pinned a \
                 different one. Unknown is not a match (INV-5): an unpinned positional read \
                 is the failure this refusal exists for, and re-writing the source with an \
                 `aligned_to` is what makes it checkable."
            ),
        )),
    }
}

/// **The DEFINITION hash — ITEM-26.** A fused column's identity is its recipe, not its bytes.
///
/// A fused column is a Postgres row read THROUGH an alignment; it has no bytes of its own to
/// hash. So its identity is the alignment it reads through, the sources, and which column.
///
/// Stability across re-emission is the property that matters, because it is what makes an
/// `immutable` cache header TRUE: hashing gathered bytes instead would mint a new hash for
/// every identical re-emission and quietly invalidate every cached read.
///
/// ## This MUST agree byte-for-byte with the producer's `definition_content_hash`
///
/// The producer (`packages/_helpers/alignment.py`) computes this hash when it emits the
/// abstract column; this side recomputes it to key the chunk cache. **Two independently
/// correct hashes that disagree would give a cache that never hits and nothing that says
/// why** — a pure performance loss with no error, no log, and no failing test. So the
/// algorithm is replicated exactly, and `tests::agrees_with_the_producers_definition_hash`
/// pins it against vectors computed from the producer's own implementation.
///
/// The shared algorithm, and why each part is there:
/// * **length-prefixed** parts, so `("ab","c")` and `("a","bc")` cannot collide;
/// * `alignment_id` then `column_selector`, in that order;
/// * sources **SORTED** — the same definition with its sources listed differently is the
///   SAME definition. Segment ORDER rides the alignment's `declared_order` (ITEM-6), never
///   this list, so sorting here cannot lose it;
/// * a terminating `0xff` + source COUNT, so two different groupings cannot concatenate alike.
pub fn definition_content_hash(
    alignment_id: &str,
    source_ids: &[String],
    column_selector: &str,
) -> Result<String, AppError> {
    use sha2::{Digest, Sha256};

    if alignment_id.is_empty() || column_selector.is_empty() {
        return Err(AppError::bad_request(
            GATHER_RECIPE_INVALID,
            "a fused column's definition needs both an alignment id and a column selector — \
             without either, the hash would not identify the thing it names",
        ));
    }
    let mut h = Sha256::new();
    for part in [alignment_id, column_selector] {
        h.update((part.len() as u64).to_le_bytes());
        h.update(part.as_bytes());
    }
    let mut sorted: Vec<&str> = source_ids.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    for id in &sorted {
        h.update((id.len() as u64).to_le_bytes());
        h.update(id.as_bytes());
    }
    h.update([0xffu8]);
    h.update((source_ids.len() as u64).to_le_bytes());
    Ok(hex::encode(h.finalize()))
}

/// **A BYTE-BOUNDED FIFO cache of resolved gathers (ITEM-25, re-aimed).**
///
/// ## What it replaces, and why the target moved
///
/// This was a `ChunkCache` keyed on `(definition hash, chunk index)`, holding one assembled
/// CHUNK per entry. It had **no caller** — the serve path resolved and sliced without ever
/// consulting it — and it was the wrong unit besides. Measured at 500k rows
/// (`tests/workstore/gather_scale_test.rs`), a whole-column scan of a gathered column read
/// **123x** the bytes one pass needs, because `serve_gathered_member` re-runs the entire
/// resolution — every source's whole column, inflated and decoded — once per chunk. A chunk
/// cache cannot touch that: on a cold scan every chunk index is a MISS, so all 123 full
/// resolutions still happen. The repeated unit is the RESOLUTION, so that is what is cached.
///
/// ## The key is a RESOLUTION IDENTITY, not the artifact id and not the definition hash
///
/// [`super::gather_exec::resolution_key`] hashes the gathered artifact's own `structure`
/// together with the CONTENT ADDRESS of every input the walk touched — the alignment blob and
/// each leaf source blob. Those are content-addressed and immutable, so an entry can only be
/// hit by a resolution whose inputs are byte-for-byte the ones that produced it.
///
/// The definition hash would NOT have been safe here: it is
/// `(alignment id, sorted DATASET ids, column selector)`, which names neither the source
/// ARTIFACTS those datasets resolve to, nor the gathered column's own declared dtype / `n` /
/// `chunk_elements`. Two recipes agreeing on all three of its parts and disagreeing on any of
/// those would share an entry and serve each other's bytes.
///
/// ## THE ORDERING INVARIANT — this stays BEHIND the gates, and behind the walk
///
/// **The cache answers only questions the gates have already allowed.** Every lookup is
/// reached from `serve_gathered_member`, which runs *after* `load_readable_artifact` →
/// `ConsumableArtifact::try_new` (authorization, then status). A lookup hoisted ahead of
/// either would serve bytes for an artifact the byte route now REFUSES — the two paths
/// disagreeing about one artifact, visible only under a stale entry. That is pinned by
/// `a_warm_chunk_is_still_refused_once_the_artifact_is_unresolvable`, which now runs against a
/// path that genuinely consults a cache rather than one where the cache was unreachable by
/// absence.
///
/// **A SECOND ordering claim exists now that a hit skips work**: the metadata half —
/// `plan_chain`, which resolves every source and verifies every leaf's key-sequence digest —
/// runs on EVERY request, hit or miss. Only the byte fetch and decode are skipped. A cache
/// that also skipped the walk would keep serving a column whose source has since been deleted
/// or re-declared, and would never reach the discovery points that mark the row
/// `unresolvable` — so the row would never enter the state the status gate above exists to
/// catch. `a_warm_resolution_is_refused_once_a_source_changes_underneath_it` is what holds
/// that line.
///
/// ## The bound is BYTES, not entries
///
/// A resolved gather is not a fixed size: it holds the whole row plan plus every source's
/// decoded column — measured at 10.0 MB for a 500k-row column, i.e. **5x the output column's
/// own bytes**, because the row plan alone is a `(usize, usize)` per output row. An
/// entry-count bound over an object of unbounded size is not a bound. Entries are evicted
/// oldest-first until the total fits, and an entry larger than the whole budget is never
/// admitted rather than emptying the cache to hold one thing.
pub struct ResolutionCache<V> {
    inner: std::sync::Mutex<CacheInner<V>>,
    max_bytes: usize,
}

struct CacheInner<V> {
    entries: std::collections::VecDeque<(String, std::sync::Arc<V>, usize)>,
    bytes: usize,
}

impl<V> ResolutionCache<V> {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            inner: std::sync::Mutex::new(CacheInner {
                entries: std::collections::VecDeque::new(),
                bytes: 0,
            }),
            max_bytes: max_bytes.max(1),
        }
    }

    /// A warm resolution, if these exact inputs produced one.
    ///
    /// Poison-recovering: a panic while another thread held the lock must degrade to a cache
    /// MISS, never take the serve path down with it. A cache is an optimisation, and an
    /// optimisation that can fail a request is a liability.
    pub fn get(&self, key: &str) -> Option<std::sync::Arc<V>> {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .entries
            .iter()
            .find(|(k, _, _)| k == key)
            .map(|(_, v, _)| std::sync::Arc::clone(v))
    }

    /// Admit an entry of `weight` bytes, evicting oldest-first to stay inside the budget.
    pub fn put(&self, key: &str, value: std::sync::Arc<V>, weight: usize) {
        if weight > self.max_bytes {
            // Refused rather than admitted-then-evicted: admitting it would evict every warm
            // entry to hold one that cannot fit, which is strictly worse than not caching it.
            return;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.entries.iter().any(|(k, _, _)| k == key) {
            // Two panes resolving the same column concurrently both `put`. Growing the deque
            // here would evict live entries under exactly the load the cache exists to serve.
            return;
        }
        while guard.bytes + weight > self.max_bytes {
            match guard.entries.pop_front() {
                Some((_, _, w)) => guard.bytes = guard.bytes.saturating_sub(w),
                None => break,
            }
        }
        guard.bytes += weight;
        guard.entries.push_back((key.to_string(), value, weight));
    }

    /// Entries currently held. Exposed for the eviction tests — a bound nothing observes is a
    /// comment.
    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entries
            .len()
    }

    /// Bytes currently held.
    pub fn bytes(&self) -> usize {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).bytes
    }
}

/// Parse `c/<n>` into a chunk index. Anything else is not a chunk key.
pub fn chunk_index(member: &str) -> Option<usize> {
    member.strip_prefix("c/")?.parse::<usize>().ok()
}

/// The row vector's `u32` entries, decoded from its raw little-endian bytes.
pub fn decode_row_vector(bytes: &[u8]) -> Result<Vec<u32>, AppError> {
    if bytes.len() % 4 != 0 {
        return Err(AppError::bad_request(
            GATHER_RECIPE_INVALID,
            format!(
                "row vector is {} bytes, not a whole number of u32 entries",
                bytes.len()
            ),
        ));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// **The gather.** Produce chunk `g`'s bytes for a gathered column.
///
/// ## The partition, not the length
///
/// Output row `i` takes source row `rows[i]`. Chunk `g` covers output rows
/// `[g*CHUNK, (g+1)*CHUNK)` — a **half-open** window — clamped to `rows.len()`. The rows it
/// emits are therefore exactly that slice of the row vector, and **not** the first `k`
/// source rows.
///
/// That distinction is the whole point, and it is why the tests compare the row SET a chunk
/// selects against the declared partition rather than counting: taking a contiguous PREFIX
/// of the source returns the right NUMBER of the WRONG rows, and every length assertion
/// above it stays green. The abandoned round injected exactly that mutation as a negative
/// control and watched the length assertions pass.
///
/// ## The cursor
///
/// The window is computed from `g` arithmetically rather than by walking a cursor across
/// calls, because a chunk is served by an independent HTTP request — there is no state to
/// carry between them. `lo` is derived, so a chunk cannot inherit a neighbour's position;
/// the cross-chunk property the tests pin is that consecutive chunks tile the output
/// exactly once, with no gap and no overlap at the boundary.
pub fn gather_chunk(
    g: usize,
    rows: &[u32],
    source_values: &[u8],
    item: usize,
) -> Result<Vec<u8>, AppError> {
    let chunk = CHUNK_ELEMENTS_TEST;
    let lo = g * chunk;
    if lo >= rows.len() {
        return Ok(Vec::new());
    }
    let hi = usize::min(lo + chunk, rows.len());

    // A partial trailing chunk is padded to a whole chunk: the reader checks the decoded
    // length against `innerChunkElements * itemSize` and refuses a short one. Padding with
    // the declared `fill_value` (0) is what a stored array does, so this matches rather
    // than special-cases.
    let mut out = vec![0u8; chunk * item];
    for (slot, &row) in rows[lo..hi].iter().enumerate() {
        let start = row as usize * item;
        let end = start + item;
        if end > source_values.len() {
            return Err(AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!(
                    "row vector entry {row} addresses bytes {start}..{end} of a {}-byte source \
                 member — the vector was computed against a different source than the one \
                 being read",
                    source_values.len()
                ),
            ));
        }
        out[slot * item..slot * item + item].copy_from_slice(&source_values[start..end]);
    }
    Ok(out)
}

/// A gathered SPLIT STRING column: the two members a client reads as one column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatheredStrings {
    /// `n + 1` cumulative byte offsets into [`Self::values`]. **Recomputed, never copied.**
    pub offsets: Vec<u32>,
    /// The concatenated payload.
    pub values: Vec<u8>,
}

/// **ITEM-22(b) — gather a SPLIT STRING column (an axis's own keys).**
///
/// A string column is two members: `offsets` (`n+1` cumulative positions) and `values` (the
/// payload). Value `i` is `values[offsets[i] .. offsets[i+1]]`. Gathering one is NOT the
/// fixed-width gather with a different element size:
///
/// * the payload is a CONCATENATION of the selected rows' bytes, in output order;
/// * the offsets are **recomputed** from the lengths of what was selected.
///
/// ## Why copying the offsets is the failure to design against
///
/// A copied offsets array is correct for the first segment and wrong for every one after it,
/// because each source's offsets are relative to ITS OWN payload. The result is monotonic,
/// plausible, and wrong — this branch's signature failure. It is also the worst possible
/// column to get wrong: **these are the axis's own keys**, so every row in the UI would be
/// labelled with another row's name and nothing about the display would look broken.
///
/// The tests use sources whose strings differ in LENGTH across segments, so a copied-offsets
/// implementation produces visible garbage rather than a subtle shift — a same-length fixture
/// would let the copy look right.
pub fn gather_split_strings(
    plan: &[(usize, usize)],
    sources: &[(Vec<u32>, Vec<u8>)],
) -> Result<GatheredStrings, AppError> {
    let mut offsets: Vec<u32> = Vec::with_capacity(plan.len() + 1);
    let mut values: Vec<u8> = Vec::new();
    offsets.push(0);

    for (out_row, &(src_ix, row)) in plan.iter().enumerate() {
        let (src_offsets, src_values) = sources.get(src_ix).ok_or_else(|| {
            AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!(
                    "output row {out_row} names source {src_ix}, but {} source(s) were \
                     resolved — a gather that fell back to another source would label this \
                     row with a different dataset's key",
                    sources.len()
                ),
            )
        })?;
        // `n+1` offsets bound `n` values, so row `r` needs entries `r` and `r+1`.
        let (lo, hi) = match (src_offsets.get(row), src_offsets.get(row + 1)) {
            (Some(lo), Some(hi)) => (*lo as usize, *hi as usize),
            _ => {
                return Err(AppError::bad_request(
                    GATHER_RECIPE_INVALID,
                    format!(
                        "output row {out_row} addresses row {row} of source {src_ix}, whose \
                         offsets bound {} value(s) — the column and the alignment were \
                         computed against different versions of that source",
                        src_offsets.len().saturating_sub(1)
                    ),
                ))
            }
        };
        if hi < lo || hi > src_values.len() {
            return Err(AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!(
                    "source {src_ix} row {row} spans offsets {lo}..{hi} of a {}-byte payload. \
                     Offsets that run backwards or past the end would slice another row's \
                     bytes into this one's key",
                    src_values.len()
                ),
            ));
        }
        values.extend_from_slice(&src_values[lo..hi]);
        offsets.push(values.len() as u32);
    }
    Ok(GatheredStrings { offsets, values })
}

/// **Rewrite one source's level codes into the UNIFIED code space.**
///
/// `lookup[local_code]` is the unified code, or **`-1` for absence** — a source level that is
/// not in the unified vocabulary. Both failure modes are refusals rather than writes, and
/// they are different facts:
///
/// * a code the lookup does not cover ⇒ the column and the alignment were computed against
///   different versions of that source;
/// * a code the lookup maps to `-1` ⇒ the level exists in the source and not in the unified
///   vocabulary, so there is no correct value to write.
///
/// ## IT ALSO CONVERTS THE WIDTH, and that is not incidental
///
/// `src_item` is the width the SOURCE bytes are; `dst_item` is the width the GATHERED column
/// declares. They differ exactly when the unified vocabulary needs more room than a source's
/// own — two 200-level `donor` columns sharing 143 fuse to 257, past `uint8` while both
/// sources are `uint8` — which is the case `unified_code_dtype` exists for.
///
/// Reading at the gathered width instead is a **width mismatch against the source buffer**,
/// and it fails in three ways depending on the data: `GATHER_RECIPE_INVALID` on an odd
/// element count, `GATHER_LEVEL_CODE_UNMAPPED` on most even ones (two adjacent rows read as
/// one little-endian `u16`), and — in the residual case — `Ok(())` having written across two
/// rows. Measured, all three. That is why this returns a NEW buffer rather than rewriting in
/// place: widening cannot be done in place, and an in-place signature is what made the
/// mismatch expressible at all.
///
/// ## Why this is a function rather than a loop inside `resolve`
///
/// **No emitter fixture can produce a `-1`.** The reference emitter's vocabulary is the union
/// of the sources' levels in `strict` and in `authority` mode alike, so every local code maps
/// — measured, not assumed. The absence path is in the producer's declared contract and is
/// unreachable from any producer-faithful fixture, which would leave it implemented and
/// unexercised: the guards-the-call-not-the-installation shape. Extracted so the arithmetic
/// can be driven directly with the contract's own value.
pub fn remap_codes(
    buf: &[u8],
    src_item: usize,
    dst_item: usize,
    lookup: &[i64],
) -> Result<Vec<u8>, AppError> {
    if src_item == 0 || dst_item == 0 || buf.len() % src_item != 0 {
        return Err(AppError::bad_request(
            GATHER_RECIPE_INVALID,
            format!(
                "a column of {} byte(s) is not a whole number of {src_item}-byte elements",
                buf.len()
            ),
        ));
    }
    let n = buf.len() / src_item;
    let mut out = vec![0u8; n * dst_item];
    for e in 0..n {
        let code = {
            let mut v = 0u64;
            for (i, byte) in buf[e * src_item..e * src_item + src_item]
                .iter()
                .enumerate()
                .take(8)
            {
                v |= (*byte as u64) << (8 * i);
            }
            v
        };
        let mapped = *lookup.get(code as usize).ok_or_else(|| {
            AppError::bad_request(
                "GATHER_LEVEL_CODE_UNMAPPED",
                format!(
                    "row {e} holds level code {code}, which the level lookup ({} entries) does \
                     not map — the column and the alignment were computed against different \
                     versions of that source",
                    lookup.len()
                ),
            )
        })?;
        if mapped < 0 {
            return Err(AppError::bad_request(
                "GATHER_LEVEL_ABSENT",
                format!(
                    "row {e} holds level code {code}, which the alignment maps to ABSENT \
                     (-1): that level is not in the unified vocabulary, so there is no \
                     correct value to write. Refused rather than written — a -1 reaching the \
                     output is an index the vocabulary either does not have or, worse, does, \
                     and it would render as some other label."
                ),
            ));
        }
        // ORDER IS LOAD-BEARING: `mapped < 0` is tested FIRST. `-1 as u64` is
        // 0xffff_ffff_ffff_ffff, so a width check placed ahead of it reports an ABSENT level
        // as "too wide" — one message for two facts with different remedies (a design
        // conflict about NA encoding vs a column declared too narrow). Caught by the ABSENT
        // test going red with the width message, which is the split-the-bucket rule arriving
        // as a test failure instead of as a review comment.
        // **The UPPER bound, and it was missing.** `mapped` is written back into the SAME
        // width the source used, and the unified vocabulary is a UNION — so a fused column
        // over two ≤256-level sources can carry a code past 255 while every source is
        // `uint8`. The write-back loop masks each byte with `& 0xff`, so an over-wide code
        // did not fail: it TRUNCATED. Measured, not reasoned: `lookup=[256,257,258,299]`,
        // `buf=[3u8]`, `item=1` returned `Ok(())` having written **43** for code **299** —
        // and 43 is a real index into the unified vocabulary, so the client renders a
        // genuine label belonging to a different entity. Silent, plausible, wrong.
        //
        // The creator now sizes the gathered width from the unified vocabulary rather than
        // copying the sources' (`virtual_dataset::unified_code_dtype`), which is where the
        // condition is PREVENTED. This is the guard that makes any future writer that gets
        // it wrong loud instead of quiet — the two are not redundant: one fixes today's
        // writer, the other refuses tomorrow's.
        if dst_item < 8 && (mapped as u64) >= (1u64 << (8 * dst_item)) {
            return Err(AppError::bad_request(
                "GATHER_LEVEL_CODE_TOO_WIDE",
                format!(
                    "row {e} maps to unified level code {mapped}, which does not fit the \
                     column's {dst_item}-byte element. The unified vocabulary is a UNION of the \
                     sources' and can be wider than any one of them, so a column sized from \
                     a SOURCE truncates here — silently, because the write-back masks each \
                     byte: {mapped} would have been stored as {}, a real index into the \
                     vocabulary pointing at a different label. The gathered column must be \
                     declared wide enough for the unified vocabulary ({} levels)",
                    (mapped as u64) & ((1u64 << (8 * dst_item)) - 1),
                    lookup.iter().filter(|v| **v >= 0).count(),
                ),
            ));
        }
        for (i, byte) in out[e * dst_item..e * dst_item + dst_item]
            .iter_mut()
            .enumerate()
            .take(8)
        {
            *byte = ((mapped as u64 >> (8 * i)) & 0xff) as u8;
        }
    }
    Ok(out)
}

/// **The gather, over SEVERAL sources.** Produce chunk `g` for a fused column.
///
/// `plan` is one entry per OUTPUT row: `(source index, row within that source)` — exactly
/// what `AlignmentVectors::resolve_row` returns. `sources[i]` is source `i`'s decoded element
/// bytes.
///
/// ## Why this exists beside `gather_chunk`
///
/// `gather_chunk` takes ONE source buffer, which is the single-source shape this side
/// invented before the producer existed. A real alignment's row axis is a CONCATENATION of
/// per-source segments, so an output chunk spanning a segment boundary draws from two
/// different source arrays — measured on both reference alignments, where output chunk 0
/// draws from two sources. A single-buffer gather cannot express that at all: it would have
/// to pick one source and read the right ROW NUMBER out of the wrong dataset, which is the
/// failure with a correct count and no symptom.
///
/// Everything else is `gather_chunk`'s shape and for its reasons: a half-open window derived
/// arithmetically from `g` (a chunk is served by an independent HTTP request, so there is no
/// cursor to carry), the declared PARTITION rather than a contiguous prefix, and a partial
/// trailing chunk padded to full width with the declared fill value.
pub fn gather_chunk_multi(
    g: usize,
    plan: &[(usize, usize)],
    sources: &[Vec<u8>],
    item: usize,
    chunk: usize,
) -> Result<Vec<u8>, AppError> {
    let lo = g * chunk;
    if lo >= plan.len() {
        return Ok(Vec::new());
    }
    let hi = usize::min(lo + chunk, plan.len());

    let mut out = vec![0u8; chunk * item];
    for (slot, &(src_ix, row)) in plan[lo..hi].iter().enumerate() {
        let src = sources.get(src_ix).ok_or_else(|| {
            AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!(
                    "output row {} names source {src_ix}, but {} source(s) were resolved — a \
                 gather that fell back to another source would return the right row number \
                 of the wrong dataset",
                    lo + slot,
                    sources.len()
                ),
            )
        })?;
        let start = row * item;
        let end = start + item;
        if end > src.len() {
            return Err(AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!(
                    "output row {} addresses bytes {start}..{end} of source {src_ix}, which holds \
                 {} — the alignment was computed against a different version of that source",
                    lo + slot,
                    src.len()
                ),
            ));
        }
        out[slot * item..slot * item + item].copy_from_slice(&src[start..end]);
    }
    Ok(out)
}

/// **A masked/sliced sparse COLUMN of a CSC matrix — its nonzeros in OUTPUT coordinates (ITEM-5).**
///
/// The wire-facing shape the viz decodes (`streamDecode.ts::decodeSparseColumnStream`): the
/// nonzeros only, `row` = the OUTPUT position each nonzero lands at (ascending), `value` its
/// stored value. `length` (the point count `N_kept`) is NOT here — it rides the structure channel
/// (the gathered column's resolved `zarr.json` shape, §11.1h/DEC-8), so the two never travel
/// together on the byte wire.
#[derive(Debug, Clone, PartialEq)]
pub struct SparseSlice {
    /// Output positions of the kept nonzeros, ASCENDING (INV-25). `u32` per the wire.
    pub row: Vec<u32>,
    /// The kept nonzeros' values, paired with [`Self::row`].
    pub value: Vec<f32>,
}

/// **Gather ONE column of a CSC matrix through a per-source mask (ITEM-5, §11.1i).**
///
/// A CSC matrix is compressed by column, so a column is a contiguous slice: `indptr[col..col+2]`
/// bounds `indices[lo:hi]` (source ROW POSITIONS, ascending within a column) paired with
/// `data[lo:hi]` (values). A per-source ROW mask reaches INSIDE that slice: each nonzero at source
/// position `p` is KEPT iff `mask` keeps `p`, and its output position is `rank[p] + row_offset`
/// (the exclusive prefix-sum places a kept row at its compacted position; `row_offset` is the
/// segment offset for an integrated read — a second source's rows sit above the first source's
/// kept count, §11.1i).
///
/// `mask = None` is the IDENTITY read (a real dataset / an all-keep mask, INV-11): every nonzero
/// survives at its own source position + offset — byte-equivalent to reading the source column
/// directly. `mask = Some((keep, rank))` filters + renumbers.
///
/// ## Why the output is ascending for free — and why that is load-bearing
///
/// Source positions in a CSC column are ascending, and `rank` is monotone non-decreasing, so the
/// kept outputs come out ascending WITHOUT a re-sort — still a valid CSC column slice the client
/// decodes exactly as a real column (INV-25). The serve path touches only this column's `[lo,hi)`
/// span; it NEVER materialises a filtered matrix (INV-22) — whole-matrix work is a processor.
///
/// The result is `O(nnz in the column)` (INV-24): dropped nonzeros are simply not emitted, and a
/// zero row never was a nonzero, so the wire is the kept nonzeros, never a dense `N`-length array.
pub fn gather_sparse_column(
    indptr: &[i64],
    indices: &[u32],
    data: &[f32],
    col: usize,
    mask: Option<(&[bool], &[u32])>,
    row_offset: u32,
) -> Result<SparseSlice, AppError> {
    // `n_cols + 1` offsets bound `n_cols` columns, so column C needs entries C and C+1.
    let (lo, hi) = match (indptr.get(col), indptr.get(col + 1)) {
        (Some(&lo), Some(&hi)) if lo >= 0 && hi >= lo => (lo as usize, hi as usize),
        (Some(&lo), Some(&hi)) => {
            return Err(AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!(
                    "column {col} bounds indptr {lo}..{hi} run backwards or negative — the CSC \
                     indptr is corrupt or the column index and the matrix were computed against \
                     different versions"
                ),
            ))
        }
        _ => {
            return Err(AppError::bad_request(
                GATHER_RECIPE_INVALID,
                format!(
                    "column {col} is out of range — indptr bounds {} column(s), so the column \
                     selector and the matrix disagree about how many columns exist",
                    indptr.len().saturating_sub(1)
                ),
            ))
        }
    };
    if hi > indices.len() || hi > data.len() {
        return Err(AppError::bad_request(
            GATHER_RECIPE_INVALID,
            format!(
                "column {col} spans nonzeros {lo}..{hi}, but indices/data hold {}/{} — the \
                 indptr and the value members were computed against different versions of the \
                 matrix",
                indices.len(),
                data.len()
            ),
        ));
    }

    let mut row: Vec<u32> = Vec::new();
    let mut value: Vec<f32> = Vec::new();
    for k in lo..hi {
        let p = indices[k] as usize;
        match mask {
            // IDENTITY: no filter, source position → output position (+ segment offset).
            None => {
                row.push(indices[k] + row_offset);
                value.push(data[k]);
            }
            // MASKED: keep iff the mask keeps position `p`; output position is its rank.
            Some((keep, rank)) => {
                let kept = *keep.get(p).ok_or_else(|| {
                    AppError::bad_request(
                        GATHER_RECIPE_INVALID,
                        format!(
                            "column {col} nonzero at source row {p} is outside the mask's {} \
                             row(s) — the mask and the matrix were computed against different \
                             row sequences (INV-5)",
                            keep.len()
                        ),
                    )
                })?;
                if kept {
                    // `rank` is the same length as `keep`; a kept row always has a rank entry.
                    row.push(rank[p] + row_offset);
                    value.push(data[k]);
                }
            }
        }
    }
    Ok(SparseSlice { row, value })
}

/// **Encode a sparse column slice to the wire (`u32 n | u32[n] row | f32[n] value`).**
///
/// The exact little-endian layout `decodeSparseColumnStream` consumes (§11.1h): a 4-byte header
/// `n` = KEPT nnz, then `n` row positions, then `n` values — `4 + 8·n` bytes total. `N` (the
/// point count) is deliberately NOT on the wire; it rides the structure channel, so a masked
/// slice's wire is byte-shaped exactly like a real column's and only the header `n` and the `row`
/// values differ (INV-25). This is a NEW per-column encoder, distinct from the retired whole-matrix
/// wire (`no_legacy_wire.rs`) it does not resurrect.
pub fn encode_sparse_slice_wire(slice: &SparseSlice) -> Vec<u8> {
    let n = slice.row.len();
    let mut out = Vec::with_capacity(4 + 8 * n);
    out.extend_from_slice(&(n as u32).to_le_bytes());
    for &r in &slice.row {
        out.extend_from_slice(&r.to_le_bytes());
    }
    for &v in &slice.value {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A source of 8 f32-sized elements, each byte-tagged by its row so a wrong row is
    /// visible in the bytes rather than merely in a count.
    fn source(n: usize, item: usize) -> Vec<u8> {
        (0..n)
            .flat_map(|r| std::iter::repeat(r as u8).take(item))
            .collect()
    }

    /// A row is taken from ITS OWN source — not from whichever source came first.
    ///
    /// The two sources hold byte-tagged values that differ, and the plan interleaves them, so
    /// a gather that read the right row number out of the wrong source produces the right
    /// COUNT and visibly wrong bytes.
    /// Sources whose strings differ in LENGTH across segments, so a copied-offsets
    /// implementation is visibly wrong rather than subtly shifted.
    fn split_sources() -> Vec<(Vec<u32>, Vec<u8>)> {
        // A: ["cell-1", "c2"]   B: ["barcode-XYZ", "b2", "bb3"]
        let a_vals = b"cell-1c2".to_vec();
        let a_offs = vec![0u32, 6, 8];
        let b_vals = b"barcode-XYZb2bb3".to_vec();
        let b_offs = vec![0u32, 11, 13, 16];
        vec![(a_offs, a_vals), (b_offs, b_vals)]
    }

    fn decode(g: &GatheredStrings) -> Vec<String> {
        g.offsets
            .windows(2)
            .map(|w| String::from_utf8(g.values[w[0] as usize..w[1] as usize].to_vec()).unwrap())
            .collect()
    }

    /// **The two geometries disagree about where chunk 1 starts, and each member uses its
    /// own.** A router that derived one from the other would be right for chunk 0 and wrong
    /// after it — the copied-offsets bug one level up.
    #[test]
    fn a_split_columns_two_members_chunk_independently() {
        let sources = split_sources();
        let plan = [(0usize, 0usize), (1, 0), (0, 1), (1, 2)];
        let g = gather_split_strings(&plan, &sources).expect("gather");

        // offsets: 5 entries of 4 bytes, chunked at 2 ELEMENTS -> chunk 1 starts at BYTE 8.
        // values: 22 bytes, chunked at 6 BYTES -> chunk 1 starts at BYTE 6.
        //
        // The 6 is load-bearing and was chosen after the assertion below caught 8: two
        // elements of four bytes and eight bytes are the SAME offset, so the two geometries
        // coincided and a shared-geometry implementation would have passed. The fixture's
        // own non-vacuity check is what said so — the coincidence class, caught at the
        // moment of writing rather than by a later audit.
        let off_bytes: Vec<u8> = g.offsets.iter().flat_map(|o| o.to_le_bytes()).collect();
        let off_c1 = slice_chunk(&off_bytes, 1, 2, 4);
        assert_eq!(
            &off_c1[..8],
            &g.offsets[2].to_le_bytes()[..]
                .iter()
                .chain(g.offsets[3].to_le_bytes().iter())
                .copied()
                .collect::<Vec<u8>>()[..],
            "the offsets member's chunk 1 begins at ELEMENT 2"
        );

        let val_c1 = slice_chunk(&g.values, 1, 6, 1);
        assert_eq!(
            &val_c1[..6],
            &g.values[6..12],
            "the values member's chunk 1 begins at BYTE 8 — a different place in the column, \
             which is why one geometry cannot be derived from the other"
        );
        assert_ne!(
            2 * 4,
            6 * 1,
            "…and the fixture must make the two boundaries genuinely differ, or a \
             shared-geometry implementation passes"
        );
    }

    #[test]
    fn a_split_string_gather_recomputes_offsets_rather_than_copying_them() {
        let sources = split_sources();
        // Interleaved across sources, and the lengths differ per row.
        let plan = [(0usize, 0usize), (1, 0), (0, 1), (1, 2)];
        let g = gather_split_strings(&plan, &sources).expect("gather");

        assert_eq!(decode(&g), vec!["cell-1", "barcode-XYZ", "c2", "bb3"]);
        assert_eq!(
            g.offsets,
            vec![0, 6, 17, 19, 22],
            "the offsets are CUMULATIVE over the gathered payload. Copying either source's \
             offsets gives a monotonic, plausible array that slices the wrong bytes — and \
             these are an axis's KEYS, so every row would be labelled with another row's name"
        );
        assert_eq!(g.values, b"cell-1barcode-XYZc2bb3".to_vec());
        assert_eq!(
            g.offsets.len(),
            plan.len() + 1,
            "n+1 offsets bound n values; an off-by-one here drops or duplicates the last key"
        );
    }

    #[test]
    fn a_split_gather_of_one_source_in_order_is_still_recomputed_correctly() {
        // The degenerate case a copied-offsets implementation gets RIGHT — asserted so the
        // test above cannot be satisfied by an implementation that only works when
        // interleaved, and so the two cases are visibly different.
        let sources = split_sources();
        let g = gather_split_strings(&[(1, 0), (1, 1), (1, 2)], &sources).expect("gather");
        assert_eq!(decode(&g), vec!["barcode-XYZ", "b2", "bb3"]);
        assert_eq!(g.offsets, vec![0, 11, 13, 16]);
    }

    #[test]
    fn a_split_gather_refuses_a_row_past_its_sources_offsets() {
        let sources = split_sources();
        let err = gather_split_strings(&[(0, 5)], &sources).expect_err("row 5 of 2");
        assert!(format!("{err:?}").contains("different versions"));
    }

    #[test]
    fn a_split_gather_refuses_an_unresolved_source_rather_than_substituting() {
        let sources = split_sources();
        let err = gather_split_strings(&[(9, 0)], &sources).expect_err("source 9");
        assert!(format!("{err:?}").contains("different dataset's key"));
    }

    #[test]
    fn a_split_gather_refuses_offsets_that_run_backwards_or_past_the_payload() {
        let bad = vec![(vec![0u32, 99], b"short".to_vec())];
        let err = gather_split_strings(&[(0, 0)], &bad).expect_err("past the payload");
        assert!(format!("{err:?}").contains("another row's bytes"));
    }

    #[test]
    fn a_level_code_mapped_to_absent_is_refused_rather_than_written() {
        // `-1` is the producer's declared value for a level absent from the unified
        // vocabulary. NO emitter fixture produces one — measured across `strict` and
        // `authority` — so this is where the contract's value gets exercised at all.
        let buf = vec![0u8, 1, 2];
        let err = remap_codes(&buf, 1, 1, &[0, -1, 2]).expect_err("code 1 maps to absent");
        let msg = format!("{err:?}");
        assert!(msg.contains("GATHER_LEVEL_ABSENT"), "{msg}");
        assert!(msg.contains("row 1"), "…naming the row: {msg}");

        // THE CONTROL that makes the refusal meaningful: without the -1, the same buffer
        // remaps cleanly. A refusal that fired on every input would satisfy the assertion
        // above and break the feature.
        let ok =
            remap_codes(&[0u8, 1, 2], 1, 1, &[0, 1, 2]).expect("an all-mapping lookup must remap");
        assert_eq!(ok, vec![0u8, 1, 2]);

        // And a NON-identity lookup actually rewrites — otherwise the control above passes
        // for a function that does nothing.
        let moved = remap_codes(&[0u8, 1, 2], 1, 1, &[0, 2, 1]).expect("remap");
        assert_eq!(
            moved,
            vec![0u8, 2, 1],
            "the lookup must be APPLIED, not merely read"
        );
    }

    #[test]
    fn a_code_outside_the_lookup_is_refused_as_a_version_mismatch() {
        let buf = vec![5u8];
        let err = remap_codes(&buf, 1, 1, &[0, 1]).expect_err("code 5 of a 2-entry lookup");
        assert!(format!("{err:?}").contains("GATHER_LEVEL_CODE_UNMAPPED"));
    }

    #[test]
    fn multi_source_gather_takes_each_row_from_its_own_source() {
        let item = 4;
        let a: Vec<u8> = (0..4u8).flat_map(|r| [0xAA, r, r, r]).collect();
        let b: Vec<u8> = (0..4u8).flat_map(|r| [0xBB, r, r, r]).collect();
        let sources = vec![a.clone(), b.clone()];
        // Interleaved across the segment boundary, and both sources use row 1 — so reading
        // the row number alone cannot tell the two apart.
        let plan = [(0usize, 1usize), (1, 1), (0, 3), (1, 0)];

        let out = gather_chunk_multi(0, &plan, &sources, item, CHUNK_ELEMENTS_TEST).unwrap();
        assert_eq!(&out[0..4], &[0xAA, 1, 1, 1]);
        assert_eq!(&out[4..8], &[0xBB, 1, 1, 1]);
        assert_eq!(&out[8..12], &[0xAA, 3, 3, 3]);
        assert_eq!(&out[12..16], &[0xBB, 0, 0, 0]);
    }

    /// Consecutive chunks tile the output exactly once — no gap, no overlap at the boundary.
    #[test]
    fn multi_source_chunks_tile_the_output_exactly_once() {
        let item = 1;
        let sources = vec![vec![10u8, 11, 12, 13, 14], vec![20u8, 21, 22]];
        let plan: Vec<(usize, usize)> =
            vec![(0, 0), (1, 0), (0, 1), (1, 1), (0, 2), (1, 2), (0, 3)];

        let mut seen = Vec::new();
        for g in 0..3 {
            let c = gather_chunk_multi(g, &plan, &sources, item, CHUNK_ELEMENTS_TEST).unwrap();
            if c.is_empty() {
                break;
            }
            let take = usize::min(
                CHUNK_ELEMENTS_TEST,
                plan.len().saturating_sub(g * CHUNK_ELEMENTS_TEST),
            );
            seen.extend_from_slice(&c[..take]);
        }
        assert_eq!(seen, vec![10u8, 20, 11, 21, 12, 22, 13]);
    }

    /// A source index the resolution did not produce is a refusal, never a fallback.
    #[test]
    fn an_unresolved_source_index_is_refused_rather_than_substituted() {
        let sources = vec![vec![0u8; 8]];
        let err = gather_chunk_multi(0, &[(1usize, 0usize)], &sources, 4, CHUNK_ELEMENTS_TEST)
            .expect_err("source 1 was never resolved");
        assert!(format!("{err:?}").contains("wrong dataset"));
    }

    /// A row past the source's length means the alignment and the source disagree — refuse,
    /// rather than emit fill and report a full-length column.
    #[test]
    fn a_row_past_the_end_of_its_source_is_refused() {
        let sources = vec![vec![0u8; 8]];
        let err = gather_chunk_multi(0, &[(0usize, 9usize)], &sources, 4, CHUNK_ELEMENTS_TEST)
            .expect_err("row 9 of 2");
        assert!(format!("{err:?}").contains("different version"));
    }

    #[test]
    fn gathers_the_declared_partition_not_a_contiguous_prefix() {
        let item = 4;
        let src = source(8, item);
        // A permutation that is NOT the identity and NOT sorted, so a prefix-taking
        // implementation produces the right COUNT and the wrong ROWS.
        let rows = [7u32, 1, 5, 3, 6, 0, 4, 2];

        let c0 = gather_chunk(0, &rows, &src, item).unwrap();
        // The row SET this chunk selected, read back out of the bytes.
        let got: Vec<u8> = c0.chunks_exact(item).map(|c| c[0]).collect();
        assert_eq!(
            got,
            vec![7, 1, 5, 3],
            "chunk 0 must emit the rows the vector declares, in order — a contiguous prefix \
             would give [0,1,2,3], the right COUNT of the WRONG rows"
        );
    }

    #[test]
    fn chunks_tile_the_output_exactly_once() {
        let item = 2;
        let src = source(10, item);
        let rows: Vec<u32> = (0..10).rev().collect(); // 9,8,…,0

        let mut seen = Vec::new();
        for g in 0..3 {
            let bytes = gather_chunk(g, &rows, &src, item).unwrap();
            let lo = g * CHUNK_ELEMENTS_TEST;
            let hi = usize::min(lo + CHUNK_ELEMENTS_TEST, rows.len());
            seen.extend(bytes.chunks_exact(item).take(hi - lo).map(|c| c[0] as u32));
        }
        assert_eq!(
            seen, rows,
            "consecutive chunks must tile the output exactly once — no gap, no overlap, and \
             the boundary row emitted precisely once"
        );
    }

    #[test]
    fn the_trailing_partial_chunk_is_padded_to_a_whole_chunk() {
        let item = 4;
        let src = source(6, item);
        let rows: Vec<u32> = (0..6).collect();
        let last = gather_chunk(1, &rows, &src, item).unwrap();
        assert_eq!(
            last.len(),
            CHUNK_ELEMENTS_TEST * item,
            "the reader checks decoded length against innerChunkElements * itemSize and \
             refuses a short chunk, so a partial tail is padded exactly as a stored array's is"
        );
        assert_eq!(&last[8..], &[0u8; 8], "the pad is the declared fill_value");
    }

    #[test]
    fn a_row_outside_the_source_is_refused_by_name() {
        let item = 4;
        let src = source(4, item);
        let err = gather_chunk(0, &[9u32], &src, item).unwrap_err();
        assert!(
            format!("{err:?}").contains("different source"),
            "a vector computed against another source must be refused, not read out of \
             bounds or silently clamped: {err:?}"
        );
    }

    /// **Cross-language agreement with the producer.** The vectors below were computed by
    /// running the PRODUCER's `definition_content_hash` (`_helpers/alignment.py`), not by
    /// running this function and recording what it said — which would pin this
    /// implementation to itself and prove nothing.
    ///
    /// nc: change any part of the algorithm here — drop the length prefixes, stop sorting,
    /// drop the terminator, swap the id/selector order — and these go red. Without them a
    /// divergence is SILENT: the producer stamps one hash, this side computes another, the
    /// cache never hits, and there is no error and no log to explain it.
    #[test]
    fn agrees_with_the_producers_definition_hash() {
        let a = "00000000-0000-0000-0000-0000000000aa";
        let s = vec![
            "11111111-1111-1111-1111-111111111111".to_string(),
            "22222222-2222-2222-2222-222222222222".to_string(),
        ];
        assert_eq!(
            definition_content_hash(a, &s, "celltype").unwrap(),
            "1584ba755acc5ab47f6fc3dcf39cb8e68b1f6babeb84975a7f2e9aba9e0c00b9"
        );
        assert_eq!(
            definition_content_hash(a, &s, "donor").unwrap(),
            "9f1d82a824e0790540abb708214f1c40c22344131c5f14805ebafaad0544dc07"
        );
        assert_eq!(
            definition_content_hash(a, &s[..1], "celltype").unwrap(),
            "cf62d539ecbc13853b8be3357e8f6437295bbfc4e1836e8a2de1caa3c0f26e0f"
        );
    }

    /// **The producer's own implementation, EXECUTED — not a copy of what it once said.**
    ///
    /// The test above pins three vectors that were computed from `_helpers/alignment.py` by
    /// hand. That is evidence about the moment they were copied and about nothing since: the
    /// Python side can drift afterwards and the pin stays green, because the pin no longer
    /// consults it.
    ///
    /// This runs it. A change to EITHER language goes red here on the next `cargo test
    /// --lib`, which is the only form "the two sides must agree" can take — see
    /// `virtual_dataset::definition_selector` for why the other form (the producer stamping
    /// the hash into its artifact, so the server could refuse a divergence) is impossible:
    /// the first argument is the catalog artifact id, minted after the producer has exited.
    ///
    /// It does NOT self-skip when python3 is missing. A skip here is indistinguishable from
    /// agreement, and this is the one assertion in the file whose whole value is that it
    /// consults the other implementation.
    #[test]
    fn the_producers_own_implementation_is_executed_and_agrees() {
        // **THE STAGED LAYOUT IS ONE FLAT DIRECTORY, and this test's model of it was wrong.**
        //
        // `PY_HELPER_FILES` stages every helper — `alignment.py` from `_helpers` AND
        // `cyto_columns.py` from `_lib` — flat into a single `/code` dir, so the source-tree
        // split is a LIFECYCLE distinction (runtime glue vs the on-disk format contract), not
        // an import boundary. When stage 1 added `from cyto_columns import _missing_level` to
        // `alignment.py`, the sandbox ran it correctly on the first real run while THIS test
        // died at `ModuleNotFoundError` — the runtime was right and the test's model of it
        // was wrong, which is BASE.md H17's shape: a faithful-looking harness that reproduces
        // a layout nobody actually runs.
        //
        // Both reserved package roots therefore go on the path, and they are named through
        // the staging module's OWN constants rather than as literals here, so a rename cannot
        // leave this test reproducing a directory layout that no longer exists.
        // `test_staged_imports.py` is the guard on the other side: it refuses a module-scope
        // import that is neither stdlib, a known dep, nor itself staged.
        let package_root = |name: &str| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../packages")
                .join(name)
                .canonicalize()
                .unwrap_or_else(|e| panic!("packages/{name} must be resolvable: {e}"))
        };
        let helpers = package_root(crate::modules::sandbox::processors::RESERVED_HELPER_PACKAGE);
        let lib = package_root(crate::modules::sandbox::processors::RESERVED_LIB_PACKAGE);
        let a = "00000000-0000-0000-0000-0000000000aa";
        let sources = [
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
        ];
        // Several selectors, including two that differ only by ORDER of the source list, so
        // an implementation that stopped sorting is caught here and not only by the pin.
        let cases = [
            (vec![sources[0], sources[1]], "celltype"),
            (vec![sources[1], sources[0]], "celltype"),
            (vec![sources[0], sources[1]], "donor"),
            (vec![sources[0]], "group"),
        ];
        let script = format!(
            r#"
import sys, json
sys.path.insert(0, {helpers:?})
sys.path.insert(0, {lib:?})
from alignment import definition_content_hash as h
cases = json.loads(sys.argv[1])
print(json.dumps([h(c[0], c[1], c[2]) for c in cases]))
"#,
            helpers = helpers.to_string_lossy(),
            lib = lib.to_string_lossy()
        );
        let payload = serde_json::to_string(
            &cases
                .iter()
                .map(|(s, sel)| serde_json::json!([a, s, sel]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let out = std::process::Command::new("python3")
            .arg("-c")
            .arg(&script)
            .arg(&payload)
            .output()
            .expect(
                "python3 must be available to execute the PRODUCER's implementation. A skip \
                 here would read exactly like agreement, so this fails instead",
            );
        assert!(
            out.status.success(),
            "the producer's implementation did not run: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let theirs: Vec<String> = serde_json::from_slice(&out.stdout).expect("producer output");
        assert_eq!(
            theirs.len(),
            cases.len(),
            "one hash per case, non-vacuously"
        );
        for ((sources, selector), theirs) in cases.iter().zip(theirs.iter()) {
            let owned: Vec<String> = sources.iter().map(|s| s.to_string()).collect();
            let ours = definition_content_hash(a, &owned, selector).unwrap();
            assert_eq!(
                &ours, theirs,
                "the two implementations disagree for selector {selector:?} over {sources:?}. \
                 A divergence is INVISIBLE at run time — the chunk cache simply never hits, \
                 with no error and no log — which is why it is asserted here"
            );
        }
    }

    /// **The three states of `alignment_column`, and the two that produce identical bytes.**
    ///
    /// `null` and a MISSING key both deserialize to `None`, so a reader keyed on the
    /// `Option` alone treats a writer that forgot the field exactly like a key gather that
    /// legitimately fuses nothing — and serves each source's raw code space. No assertion
    /// over the SERVED BYTES can catch that, because the two states agree on the output;
    /// the distinction has to exist in the type. This asserts it does.
    ///
    /// nc: make `vocabulary()` fold `Undeclared` into `DeclaredNone` and this goes red,
    /// while every byte-level test in the tree stays green — which is the whole point.
    #[test]
    fn a_missing_alignment_column_key_is_a_different_state_from_a_declared_null() {
        let base = json!({
            "alignment_artifact_id": "00000000-0000-0000-0000-0000000000aa",
            "column_selector": "values",
            "sources": [{ "dataset_id": "ds-a",
                          "artifact_id": "00000000-0000-0000-0000-0000000000b1" }],
        });
        let missing = GatheredFrom::parse(&json!({ "gathered_from": base })).unwrap();

        let mut with_null = base.clone();
        with_null["alignment_column"] = Value::Null;
        let declared_none = GatheredFrom::parse(&json!({ "gathered_from": with_null })).unwrap();

        let mut with_name = base.clone();
        with_name["alignment_column"] = json!("group");
        let fused = GatheredFrom::parse(&json!({ "gathered_from": with_name })).unwrap();

        // The Option collapses two of them — which is exactly the lossiness being fixed.
        assert_eq!(missing.alignment_column, declared_none.alignment_column);
        // …and the vocabulary does not.
        assert_eq!(missing.vocabulary(), ColumnVocabulary::Undeclared);
        assert_eq!(declared_none.vocabulary(), ColumnVocabulary::DeclaredNone);
        assert_eq!(
            fused.vocabulary(),
            ColumnVocabulary::Fused("group".to_string())
        );
        assert_ne!(
            missing.vocabulary(),
            declared_none.vocabulary(),
            "an omitted key and a declared `null` must not be one state: one is a writer \
             defect and the other is the key gather, and they serve identical bytes"
        );
    }

    /// **TEST-35 — the recipe round-trips a null AND a present `alignment_artifact_id`, plus a
    /// mask reference (ITEM-2).**
    ///
    /// `alignment_artifact_id` became `Option<Uuid>`: a single-source FILTER recipe carries
    /// `null` and reads through a mask, an INTEGRATION names its alignment. Both must parse.
    /// `require_alignment()` is the ONE funnel every alignment-gather site uses instead of
    /// unwrapping — a null there is a routing bug, a present id resolves.
    ///
    /// nc: revert `alignment_artifact_id` to a bare `Uuid` and the single-source arm fails to
    /// deserialize; drop `require_alignment` and a masked recipe would `unwrap` a `None` in the
    /// serve path.
    #[test]
    fn a_recipe_round_trips_a_null_and_a_present_alignment_plus_a_mask() {
        // Single-source filter: null alignment, a mask reference present.
        let filter = GatheredFrom::parse(&json!({ "gathered_from": {
            "column_selector": "values",
            "mask_artifact_id": "00000000-0000-0000-0000-0000000000c1",
            "sources": [{ "dataset_id": "ds-a",
                          "artifact_id": "00000000-0000-0000-0000-0000000000b1" }],
        }}))
        .expect("a single-source masked recipe with a null alignment must parse");
        assert!(filter.alignment_artifact_id.is_none());
        assert_eq!(
            filter.mask_artifact_id,
            Some(Uuid::parse_str("00000000-0000-0000-0000-0000000000c1").unwrap())
        );
        assert!(
            filter.require_alignment().is_err(),
            "an alignment-gather site reaching a masked single-source recipe must refuse, \
             never unwrap a None"
        );

        // Integration: a named alignment, no mask (`mask_artifact_id` absent → identity/None).
        let integrated = GatheredFrom::parse(&json!({ "gathered_from": {
            "alignment_artifact_id": "00000000-0000-0000-0000-0000000000aa",
            "column_selector": "values",
            "sources": [
                { "dataset_id": "ds-a", "artifact_id": "00000000-0000-0000-0000-0000000000b1" },
                { "dataset_id": "ds-b", "artifact_id": "00000000-0000-0000-0000-0000000000b2" },
            ],
        }}))
        .expect("a multi-source recipe naming its alignment must parse");
        assert_eq!(
            integrated.require_alignment().unwrap(),
            Uuid::parse_str("00000000-0000-0000-0000-0000000000aa").unwrap()
        );
        assert!(
            integrated.mask_artifact_id.is_none(),
            "absence encodes identity (INV-11)"
        );
    }

    /// **The source-count rule at the READ boundary (ITEM-2 / DEC-8) — the parse mirror of the
    /// `artifacts_recipe_alignment_or_single_source` CHECK.**
    ///
    /// A `structure` that reached a reader without passing the DB constraint (a hand-built
    /// fixture, a bypassed insert) must still be refused: a multi-source gather with no
    /// alignment would re-derive the join INV-3 forbids.
    ///
    /// nc: delete the `sources.len() >= 2 && alignment.is_none()` guard in `parse` and this
    /// two-source-no-alignment recipe parses, and the serve path re-derives an intersection
    /// nobody computed.
    #[test]
    fn a_multi_source_recipe_with_no_alignment_is_refused_at_parse() {
        let err = GatheredFrom::parse(&json!({ "gathered_from": {
            "column_selector": "values",
            "sources": [
                { "dataset_id": "ds-a", "artifact_id": "00000000-0000-0000-0000-0000000000b1" },
                { "dataset_id": "ds-b", "artifact_id": "00000000-0000-0000-0000-0000000000b2" },
            ],
        }}))
        .expect_err("two sources with no alignment must be refused");
        assert!(format!("{err:?}").contains(GATHER_RECIPE_INVALID));
    }

    /// **C1 — a unified code wider than the element must FAIL, not truncate.**
    ///
    /// The exact arithmetic that was measured returning `Ok(())`: `lookup[3] = 299`, a
    /// 1-byte element, and `299 & 0xff == 43`. 43 is a REAL index into the unified
    /// vocabulary, so the client rendered a genuine label belonging to a different entity —
    /// no error, no log, a plausible value.
    ///
    /// nc: delete the `GATHER_LEVEL_CODE_TOO_WIDE` guard and this goes red with `buf == [43]`.
    #[test]
    fn a_unified_code_too_wide_for_the_element_is_refused_not_truncated() {
        let lookup = vec![256i64, 257, 258, 299];
        let buf = vec![3u8];
        let err = remap_codes(&buf, 1, 1, &lookup).expect_err(
            "a code that does not fit the element must be REFUSED; truncating writes a real \
             index to the WRONG label",
        );
        let text = format!("{err:?}");
        assert!(text.contains("GATHER_LEVEL_CODE_TOO_WIDE"), "{text}");
        assert!(
            text.contains("43"),
            "the refusal must NAME the value truncation would have written, because that is \
             the number a reader would otherwise have to rediscover: {text}"
        );
        // POSITIVE CONTROL: the same call with a vocabulary that FITS still remaps, so the
        // guard refuses over-wide codes rather than every code.
        let ok =
            remap_codes(&[3u8], 1, 1, &[10i64, 11, 12, 13]).expect("an in-range remap still works");
        assert_eq!(ok, vec![13u8]);
    }

    /// The boundary itself, both sides — 255 fits a byte and 256 does not.
    /// **WIDENING — the source's width in, the gathered width out.**
    ///
    /// The case `unified_code_dtype` exists for: a fused vocabulary needs more room than a
    /// source's own. Nothing in this tree could reach it before — every fixture's sources
    /// carry 5 levels between them — which is why a regression that declared `uint16` over
    /// `uint8` bytes passed 144 integration tests.
    ///
    /// nc: pass `src_item = dst_item = 2` (the shape the regression produced) and this reads
    /// two rows as one little-endian `u16`; on this buffer that is code 256, which the lookup
    /// does not map, so it fails as a version mismatch — the RIGHT message for the wrong fact.
    #[test]
    fn a_remap_reads_at_the_sources_width_and_writes_at_the_gathered_one() {
        // Five uint8 rows, codes 0..4 — an ODD count, which a 2-byte read cannot even
        // divide, and the shape the regression rejected outright.
        let src = vec![0u8, 1, 2, 3, 4];
        let lookup: Vec<i64> = vec![300, 301, 302, 303, 304];
        let out = remap_codes(&src, 1, 2, &lookup).expect("uint8 source, uint16 gathered");
        assert_eq!(out.len(), 10, "five rows at two bytes each");
        let codes: Vec<u16> = out
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes(c.try_into().unwrap()))
            .collect();
        assert_eq!(
            codes,
            vec![300u16, 301, 302, 303, 304],
            "every row keeps its OWN identity across the widening — a read at the gathered \
             width would have paired adjacent rows instead"
        );

        // …and the codes genuinely need the extra byte, or the fixture is not exercising
        // widening at all: all five are past what a byte holds.
        assert!(
            codes.iter().all(|c| *c > 0xff),
            "FIXTURE IS VACUOUS: these codes fit a byte, so narrow and wide agree"
        );

        // THE CONTROL: the same call with equal widths still remaps in place-equivalent form,
        // so the conversion is about the WIDTHS and not a second code path.
        let same = remap_codes(&[0u8, 1], 1, 1, &[7i64, 9]).expect("equal widths");
        assert_eq!(same, vec![7u8, 9]);
    }

    /// A NARROWING remap is refused rather than truncated — the guard, at the new signature.
    #[test]
    fn a_code_that_does_not_fit_the_gathered_width_is_refused_even_when_the_source_is_wider() {
        let err = remap_codes(&[0u8, 0], 2, 1, &[256i64]).expect_err("256 does not fit a byte");
        assert!(
            format!("{err:?}").contains("GATHER_LEVEL_CODE_TOO_WIDE"),
            "{err:?}"
        );
    }

    #[test]
    fn the_width_guard_is_exact_at_the_element_boundary() {
        let fits =
            remap_codes(&[0u8], 1, 1, &[255i64]).expect("255 is the widest value a byte holds");
        assert_eq!(fits, vec![255u8]);
        assert!(
            remap_codes(&[0u8], 1, 1, &[256i64]).is_err(),
            "256 is one past it, and is exactly the case a UNION of two 128-level sources \
             reaches"
        );
        // …and a wider element accepts it, so the guard is about the WIDTH and not the value.
        let wide = remap_codes(&[0u8, 0], 2, 2, &[256i64]).expect("256 fits two bytes");
        assert_eq!(wide, vec![0u8, 1]);
    }

    #[test]
    fn source_order_does_not_change_the_definition_hash() {
        // The same definition with its sources listed differently is the SAME definition.
        // Segment order rides `declared_order`, never this list.
        let a = "00000000-0000-0000-0000-0000000000aa";
        let fwd = vec![
            "11111111-1111-1111-1111-111111111111".to_string(),
            "22222222-2222-2222-2222-222222222222".to_string(),
        ];
        let rev: Vec<String> = fwd.iter().rev().cloned().collect();
        assert_eq!(
            definition_content_hash(a, &fwd, "celltype").unwrap(),
            definition_content_hash(a, &rev, "celltype").unwrap()
        );
    }

    #[test]
    fn the_definition_hash_changes_when_any_part_of_the_definition_does() {
        // The negative half: a hash that ignored an input would satisfy every equality above.
        let a = "00000000-0000-0000-0000-0000000000aa";
        let b = "00000000-0000-0000-0000-0000000000bb";
        let s = vec!["11111111-1111-1111-1111-111111111111".to_string()];
        let base = definition_content_hash(a, &s, "celltype").unwrap();
        assert_ne!(base, definition_content_hash(b, &s, "celltype").unwrap());
        assert_ne!(base, definition_content_hash(a, &s, "donor").unwrap());
        let s2 = vec![
            s[0].clone(),
            "22222222-2222-2222-2222-222222222222".to_string(),
        ];
        assert_ne!(base, definition_content_hash(a, &s2, "celltype").unwrap());
    }

    /// A KEY identifies a resolution; a different key must never see it.
    #[test]
    fn the_cache_hits_on_the_same_key_and_misses_on_a_different_one() {
        let c = ResolutionCache::<Vec<u8>>::new(1024);
        let v = std::sync::Arc::new(vec![1u8, 2, 3]);
        assert!(c.get("keyA").is_none(), "cold");
        c.put("keyA", std::sync::Arc::clone(&v), v.len());
        assert_eq!(c.get("keyA").as_deref(), Some(&vec![1u8, 2, 3]));
        assert!(c.get("keyB").is_none(), "a different key must miss");
    }

    /// **The bound is BYTES.** An entry-count bound over resolutions of unbounded size is not
    /// a bound at all — one 500k-row column is ~14 MiB — so this is what says the budget is
    /// the thing being enforced.
    #[test]
    fn the_cache_is_byte_bounded_and_evicts_oldest_first() {
        // Room for two 100-byte entries, not three.
        let c = ResolutionCache::<Vec<u8>>::new(250);
        for i in 0..5u8 {
            c.put(&format!("k{i}"), std::sync::Arc::new(vec![i; 100]), 100);
        }
        assert_eq!(c.len(), 2, "the byte budget holds the entry count down");
        assert!(c.bytes() <= 250, "bytes held: {}", c.bytes());
        assert!(c.get("k0").is_none(), "the oldest entries were evicted");
        assert!(c.get("k4").is_some(), "the newest is retained");
    }

    /// An entry that cannot fit is REFUSED, not admitted after emptying the cache. Evicting a
    /// warm working set to hold one oversized thing is strictly worse than not caching it.
    #[test]
    fn an_entry_larger_than_the_whole_budget_is_refused_rather_than_emptying_the_cache() {
        let c = ResolutionCache::<Vec<u8>>::new(100);
        c.put("small", std::sync::Arc::new(vec![0u8; 40]), 40);
        c.put("huge", std::sync::Arc::new(vec![0u8; 4096]), 4096);
        assert!(c.get("huge").is_none(), "the oversized entry is not held");
        assert!(
            c.get("small").is_some(),
            "and it did not evict the entry that fits"
        );
    }

    #[test]
    fn a_repeated_put_does_not_duplicate_or_evict() {
        // Two panes resolving the same column concurrently both call `put`. If that grew the
        // deque, a bounded cache would evict live entries under exactly the load it exists to
        // serve.
        let c = ResolutionCache::<Vec<u8>>::new(250);
        c.put("a", std::sync::Arc::new(vec![0u8; 100]), 100);
        c.put("a", std::sync::Arc::new(vec![0u8; 100]), 100);
        c.put("b", std::sync::Arc::new(vec![1u8; 100]), 100);
        assert_eq!(c.len(), 2);
        assert_eq!(c.bytes(), 200, "the duplicate put was not double-counted");
        assert!(
            c.get("a").is_some(),
            "the duplicate put must not have evicted the entry it duplicated"
        );
    }

    #[test]
    fn a_definition_missing_its_identity_is_refused() {
        let s = vec!["1".to_string()];
        assert!(definition_content_hash("", &s, "celltype").is_err());
        assert!(definition_content_hash("a", &s, "").is_err());
    }

    #[test]
    fn chunk_keys_parse_and_non_chunk_members_do_not() {
        assert_eq!(chunk_index("c/0"), Some(0));
        assert_eq!(chunk_index("c/12"), Some(12));
        assert_eq!(chunk_index("zarr.json"), None);
        assert_eq!(chunk_index("c/x"), None);
    }

    #[test]
    fn the_synthetic_declaration_is_unsharded_and_uncompressed() {
        let s = json!({ "n": 10, "data_type": "float32" });
        let z = synthetic_zarr_json(&s).unwrap();
        let codecs = z["codecs"].as_array().unwrap();
        assert_eq!(
            codecs.len(),
            1,
            "exactly [bytes] — an empty bytes→bytes chain"
        );
        assert_eq!(codecs[0]["name"], "bytes");
        assert!(
            !z.to_string().contains("sharding_indexed"),
            "a gathered array is unsharded; the reader's else-branch handles it"
        );
        assert_eq!(
            z["chunk_grid"]["configuration"]["chunk_shape"][0],
            CHUNK_ELEMENTS
        );
    }

    #[test]
    fn composing_two_row_vectors_follows_the_chain_to_the_leaf() {
        // V picks S's rows [2,0]; S picks T's rows [7,9,5]. So V's output row 0 is T's row 5
        // (via S row 2) and output row 1 is T's row 7 (via S row 0).
        let composed = compose_rows(&[2, 0], &[7, 9, 5]).unwrap();
        assert_eq!(
            composed,
            vec![5, 7],
            "composition must follow BOTH hops — taking the outer vector alone gives [2,0], \
             which addresses the leaf's rows 2 and 0: the right COUNT of the WRONG rows"
        );
    }

    #[test]
    fn composition_is_associative_over_three_levels() {
        // The property that lets a chain of any depth collapse to ONE vector.
        let (a, b, c) = (vec![1u32, 0], vec![2u32, 1, 0], vec![9u32, 8, 7]);
        let left = compose_rows(&compose_rows(&a, &b).unwrap(), &c).unwrap();
        let right = compose_rows(&a, &compose_rows(&b, &c).unwrap()).unwrap();
        assert_eq!(
            left, right,
            "composition must be associative or depth would change results"
        );
        assert_eq!(left, vec![8, 7]);
    }

    #[test]
    fn composing_against_a_mismatched_inner_vector_is_refused_by_name() {
        let err = compose_rows(&[5u32], &[0, 1]).unwrap_err();
        assert!(
            format!("{err:?}").contains("different sources"),
            "an outer entry outside the inner vector means the two were computed against \
             different sources; that must refuse, not index out of bounds: {err:?}"
        );
    }

    #[test]
    fn an_identity_inner_vector_leaves_the_outer_unchanged() {
        // The control: composition that did nothing would pass the first test if the inner
        // vector happened to be the identity, so pin that identity is the ONLY case where
        // composing is a no-op.
        let outer = vec![3u32, 1, 2];
        let identity: Vec<u32> = (0..4).collect();
        assert_eq!(compose_rows(&outer, &identity).unwrap(), outer);
        let non_identity = vec![9u32, 8, 7, 6];
        assert_ne!(compose_rows(&outer, &non_identity).unwrap(), outer);
    }

    #[test]
    fn the_depth_limit_is_eight_and_is_not_removable() {
        assert_eq!(MAX_CHAIN_DEPTH, 8, "DEC-B fixes the bound at 8");
        assert!(
            MAX_CHAIN_DEPTH > 0,
            "a zero bound would mean 'unbounded' by accident"
        );
    }

    #[test]
    fn an_unknown_dtype_is_refused_rather_than_sized_by_guess() {
        assert!(item_size("float32").is_ok());
        assert!(item_size("complex128").is_err());
    }

    /// STATE guard: there is ONE width table. `gathered::item_size` and
    /// `gather_decode::item_size` must return the SAME width (and the same refusal) for every
    /// dtype — the two used to be independent match arms and drifted on `bool` (one accepted
    /// it, the other refused). This asserts agreement across the whole vocabulary, so a second,
    /// diverging table reintroduced in either place fails the build regardless of how it is
    /// spelled.
    #[test]
    fn the_two_item_size_tables_agree_on_every_dtype() {
        for dt in [
            "bool",
            "int8",
            "uint8",
            "int16",
            "uint16",
            "int32",
            "uint32",
            "float32",
            "int64",
            "uint64",
            "float64",
            "complex128",
            "utf8",
            "not-a-dtype",
        ] {
            assert_eq!(
                item_size(dt).ok(),
                super::super::gather_decode::item_size(dt).ok(),
                "the two item_size tables disagree on {dt:?} — they must be ONE table"
            );
        }
    }

    /// A per-source boolean row mask is the virtual-dataset row selector, so the gather MUST
    /// size `bool` at 1 byte rather than refuse it. Kills a mutant that drops `bool` from the
    /// shared table or hands it any width but 1.
    #[test]
    fn bool_is_sized_at_one_byte() {
        assert_eq!(item_size("bool").unwrap(), 1);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  DEC-26 — the gathered wire address, measured off the real writer
    // ══════════════════════════════════════════════════════════════════════════

    /// The declaration a real `metadata-column` store carries, and the two node shapes it
    /// implies. Kept as ONE fixture so the assertions below cannot drift apart.
    fn gathered_declaration() -> Value {
        json!({
            "encoding": "zarr_v3",
            "kind": "table",
            // The SOURCES' axis kind, carried through by the creator since #149 — a
            // gathered store declares the same axis its sources do, never a minted name.
            // Any label serves here (these assertions are about the NODE shape), so this
            // one is a plain fixture value rather than a second spelling of a production
            // constant — there is no longer a production constant to spell.
            "axis": "rows",
            "n": 5,
            "columns": [{ "path": "values", "name": "values", "kind": "categorical",
                          "dtype": "uint8", "shape": [5] }],
            "arrays": [],
            "data_type": "uint8",
            "chunk_elements": 4,
            "gathered_from": { "alignment_artifact_id": "x" },
        })
    }

    /// **The root is a GROUP whose `attributes.cyto` is the artifact's declaration.**
    ///
    /// Measured against `tests/fixtures/stage1_alignment/sources/level_0_group.zarr/
    /// zarr.json`, not designed: that is the node ingest already emits, so a client and a
    /// processor read a gathered store with the code they use for every other one.
    #[test]
    fn the_gathered_root_is_a_group_carrying_the_declaration_minus_the_recipe() {
        let node = gathered_group_zarr_json(&gathered_declaration()).expect("group node");
        assert_eq!(node["node_type"], json!("group"));
        assert_eq!(node["attributes"]["cyto"]["encoding"], json!("zarr_v3"));
        assert_eq!(node["attributes"]["cyto"]["kind"], json!("table"));
        assert_eq!(
            node["attributes"]["cyto"]["columns"][0]["path"],
            json!("values")
        );

        // The SERVER-PRIVATE keys are stripped. `gathered_from` is a recipe for producing
        // bytes and `chunk_elements` is already expressed in the array node's `chunk_grid` —
        // stamping either here would put a second spelling of one fact beside the
        // authoritative one, which is the drift this address change exists to remove.
        for key in SERVER_PRIVATE_STRUCTURE_KEYS {
            assert!(
                node["attributes"]["cyto"].get(key).is_none(),
                "{key} must not reach the store declaration: {node}"
            );
        }
        // …and the CONTROL: a key that is NOT private survives, so the strip is selective
        // rather than a filter that happens to drop everything checked above.
        assert_eq!(node["attributes"]["cyto"]["n"], json!(5));
    }

    /// **The member is an ARRAY under `values/`, carrying `kind` and the vocabulary.**
    ///
    /// Both fields are load-bearing and were BOTH absent: `readCategoricalColumn` reads
    /// `array.cyto.levels`, and `cyto_zarr_read.read_column` dispatches on
    /// `attributes.cyto.kind` — so a member without the kind returns raw integers at the
    /// right address, which is a wrong answer with a clean console.
    #[test]
    fn the_gathered_member_is_an_array_declaring_its_kind_and_levels() {
        let levels = json!(["g1", "g2", "g3", "g4"]);
        let node = gathered_array_zarr_json(&gathered_declaration(), Some(&levels), None)
            .expect("array node");
        assert_eq!(node["node_type"], json!("array"));
        assert_eq!(node["shape"], json!([5]));
        assert_eq!(node["data_type"], json!("uint8"));
        assert_eq!(
            node["chunk_grid"]["configuration"]["chunk_shape"],
            json!([4])
        );
        assert_eq!(node["attributes"]["cyto"]["kind"], json!("categorical"));
        assert_eq!(node["attributes"]["cyto"]["name"], json!("values"));
        assert_eq!(node["attributes"]["cyto"]["levels"], levels);

        // A column the alignment fuses no vocabulary for declares NO `levels` key — absent,
        // not empty. An empty list is a vocabulary of zero labels, and a consumer resolving
        // a code against it renders nothing rather than failing.
        let bare =
            gathered_array_zarr_json(&gathered_declaration(), None, None).expect("array node");
        assert!(
            bare["attributes"]["cyto"].get("levels").is_none(),
            "an absent vocabulary must be ABSENT, never an empty list: {bare}"
        );

        // …and a run that dropped NOTHING declares no `missing_level`, so a consumer never
        // branches on a fact that is not there. This is the state of nearly every run.
        assert!(
            node["attributes"]["cyto"].get("missing_level").is_none(),
            "a non-dropping run has no invented entry to name: {node}"
        );
    }

    /// **DEC-27 — the entry that MEANS absence is CARRIED, never inferred.**
    ///
    /// Stage 1 appends a real declared label for a level `authority` dropped and points the
    /// absent codes at its index, so `levels` already contains it and every code is in range.
    /// Which entry is the invented one is the part a consumer cannot compute: without it the
    /// browser renders absence as an ordinary category spelled `NA`, indistinguishable from a
    /// real level a dataset spells that way — two states agreeing in the output, which no
    /// assertion on the output can separate.
    ///
    /// nc: drop the `missing_level` insert in `gathered_array_zarr_json` and this goes red —
    /// and NOTHING about the served vocabulary, the codes or the labels changes, which is
    /// precisely why the distinction has to be carried rather than recovered downstream.
    #[test]
    fn the_declared_missing_level_rides_the_array_node_beside_the_vocabulary() {
        let levels = json!(["g1", "g2", "NA"]);
        let missing = json!("NA");
        let node = gathered_array_zarr_json(&gathered_declaration(), Some(&levels), Some(&missing))
            .expect("array node");
        assert_eq!(node["attributes"]["cyto"]["levels"], levels);
        assert_eq!(node["attributes"]["cyto"]["missing_level"], missing);

        // THE CONTROL: the vocabulary is passed through VERBATIM and is NOT filtered by the
        // missing level. Excluding it would be the mirror defect — the codes index into the
        // FULL list, so a vocabulary with the invented entry removed re-indexes every label
        // after it.
        assert_eq!(
            node["attributes"]["cyto"]["levels"]
                .as_array()
                .map(Vec::len),
            Some(3),
            "the invented entry stays IN the vocabulary — the codes index into it: {node}"
        );

        // …and a DIFFERENT declared label is carried unchanged, so the field is READ from the
        // producer rather than reconstructed from a convention about where it sits. A
        // consumer that assumed "the last entry" would pass the assertion above and fail
        // here, which is the only reason that assertion means anything.
        let odd = json!("__absent__");
        let other = gathered_array_zarr_json(&gathered_declaration(), Some(&levels), Some(&odd))
            .expect("array node");
        assert_eq!(
            other["attributes"]["cyto"]["missing_level"], odd,
            "the label is the PRODUCER's, not a convention this side re-derives"
        );
    }

    /// The member path comes from the DECLARATION, and is never the store root.
    #[test]
    fn the_member_path_is_read_from_the_declaration_and_defaults_to_values() {
        assert_eq!(gathered_member_path(&gathered_declaration()), "values");
        // A row written before `columns[]` existed still resolves — `values` is the member
        // name every `metadata-column` store the producer writes uses.
        assert_eq!(gathered_member_path(&json!({ "n": 1 })), "values");
        // …and a declaration naming something else is FOLLOWED, so the address cannot
        // silently disagree with what the row publishes.
        assert_eq!(
            gathered_member_path(&json!({ "columns": [{ "path": "codes" }] })),
            "codes"
        );
        // An EMPTY path is refused into the default: a member at the store ROOT is the
        // address this change removed, and `resolveMember` cannot express it.
        assert_eq!(
            gathered_member_path(&json!({ "columns": [{ "path": "" }] })),
            "values"
        );
    }

    // ── ITEM-5: the masked sparse-COLUMN gather (§11.1i) ────────────────────────────────
    //
    // Fixture: a 5-row × 2-column CSC. Column 0 is nonzero in rows {0,2,4}, column 1 in row {1}.
    //   indptr = [0, 3, 4]   (col 0: nonzeros 0..3 ; col 1: nonzero 3..4)
    //   indices = [0, 2, 4,  1]   (source ROW POSITIONS, ascending within each column)
    //   data    = [5.0, 3.0, 8.0,  9.0]
    fn csc_fixture() -> (Vec<i64>, Vec<u32>, Vec<f32>) {
        (vec![0, 3, 4], vec![0, 2, 4, 1], vec![5.0, 3.0, 8.0, 9.0])
    }

    /// **A masked column emits kept nonzeros in OUTPUT coordinates, ascending, `O(nnz in column)`
    /// (INV-25/24).**
    ///
    /// The design's own worked example (§11.1i): mask keeps {0,2,3}, rank(excl.)=[0,1,1,2,3].
    /// Column 0's nonzeros are rows 0,2,4 = 5,3,8; row 4 is DROPPED, row 0→output 0, row 2→
    /// output 1 → row=[0,1] value=[5,3]. Ascending, kept-only, no dense array.
    ///
    /// nc: drop the `if kept` guard (emit every nonzero) → row 4 leaks in at position 3, length 3.
    /// nc: emit `p` instead of `rank[p]` (no renumber) → row=[0,2] (source positions), which
    /// densifies to the WRONG texels.
    #[test]
    fn a_masked_column_emits_kept_nonzeros_in_output_positions_ascending() {
        let (indptr, indices, data) = csc_fixture();
        let keep = [true, false, true, true, false];
        let rank = [0u32, 1, 1, 2, 3]; // exclusive prefix-sum of keep
        let g = gather_sparse_column(&indptr, &indices, &data, 0, Some((&keep, &rank)), 0).unwrap();
        assert_eq!(g.row, vec![0, 1], "row0→out0, row2→out1, row4 dropped");
        assert_eq!(g.value, vec![5.0, 3.0]);
        assert!(
            g.row.windows(2).all(|w| w[0] < w[1]),
            "output rows ascending"
        );
    }

    /// **The IDENTITY read (no mask) is byte-equivalent to reading the source column directly
    /// (INV-11).**
    ///
    /// nc: apply a rank in the `None` arm → the identity read renumbers, diverging from the
    /// real column it must match.
    #[test]
    fn an_unmasked_column_is_the_source_slice_verbatim() {
        let (indptr, indices, data) = csc_fixture();
        let g = gather_sparse_column(&indptr, &indices, &data, 0, None, 0).unwrap();
        assert_eq!(g.row, vec![0, 2, 4], "source positions, unchanged");
        assert_eq!(g.value, vec![5.0, 3.0, 8.0]);
    }

    /// **A segment offset shifts a second source's rows above the first's kept count (INV-25,
    /// integration).**
    ///
    /// §11.1i: D2's rows sit at `rank + offset` where `offset` = D1's kept count. Here D2 keeps
    /// row 1 (rank 0) with offset 2 → output row 2.
    ///
    /// nc: drop `row_offset` from the push → D2's row collides with D1's output row 0.
    #[test]
    fn a_segment_offset_lifts_a_second_sources_rows() {
        // D2 alone: column 1 (row 1 = 9.0). keep {1}, rank[1]=0, offset = 2 (D1 kept 2).
        let (indptr, indices, data) = csc_fixture();
        let keep = [false, true, false, false, false];
        let rank = [0u32, 0, 1, 1, 1];
        let g = gather_sparse_column(&indptr, &indices, &data, 1, Some((&keep, &rank)), 2).unwrap();
        assert_eq!(g.row, vec![2], "row1 rank 0 + offset 2");
        assert_eq!(g.value, vec![9.0]);
    }

    /// A nonzero at a source row past the mask's length is refused, not silently kept (INV-5).
    #[test]
    fn a_nonzero_past_the_masks_length_is_refused() {
        let (indptr, indices, data) = csc_fixture();
        let keep = [true, false, true]; // only 3 rows — row 4's nonzero is out of range
        let rank = [0u32, 1, 1];
        let err =
            gather_sparse_column(&indptr, &indices, &data, 0, Some((&keep, &rank)), 0).unwrap_err();
        assert!(format!("{err:?}").contains("different row sequences"));
    }

    /// **The wire is `4 + 8·n`, header `n` = kept nnz; `N` is NOT on the wire (INV-24/25).**
    ///
    /// nc: write `N` (a length) into the header instead of the kept nnz → the decoder allocates
    /// the wrong `row`/`value` size and the `n > length` guard trips.
    #[test]
    fn the_sparse_slice_wire_is_header_plus_pairs() {
        let g = SparseSlice {
            row: vec![0, 1],
            value: vec![5.0, 3.0],
        };
        let wire = encode_sparse_slice_wire(&g);
        assert_eq!(
            wire.len(),
            4 + 8 * 2,
            "4-byte header + 2 (u32 row + f32 value)"
        );
        assert_eq!(
            u32::from_le_bytes(wire[0..4].try_into().unwrap()),
            2,
            "header n = kept nnz, not N"
        );
        assert_eq!(u32::from_le_bytes(wire[4..8].try_into().unwrap()), 0);
        assert_eq!(u32::from_le_bytes(wire[8..12].try_into().unwrap()), 1);
        assert_eq!(f32::from_le_bytes(wire[12..16].try_into().unwrap()), 5.0);
        assert_eq!(f32::from_le_bytes(wire[16..20].try_into().unwrap()), 3.0);
    }
}
