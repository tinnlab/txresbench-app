//! **THE CREATOR** — the write half of the virtual-dataset capability.
//!
//! Everything else in this stage READS a gathered artifact. Until this module existed
//! nothing in the server could WRITE one: every gathered row in the tree was inserted by a
//! test through `CatalogRepository`. That hole is not a coverage gap, it is the reason two
//! CRITICALs of this stage lived behind a green suite — a reader and its fixtures written by
//! the same hand agree with each other by construction, and the producer was never in the
//! loop to disagree.
//!
//! ## What it does, once, at the end of a successful run
//!
//! A run that emitted a `dataset-alignment` artifact gets:
//!
//!  * one `datasets` row with `source = 'integrate'` — the VIRTUAL dataset, which owns no
//!    bytes and is browsable through the ordinary catalog;
//!  * one GATHERED artifact per fused column the alignment declares a level lookup for, plus
//!    one for the unified KEY column — each with `object_key = NULL` and a
//!    `structure.gathered_from` recipe (the `artifacts_bytes_or_recipe` CHECK makes that
//!    exclusive-or a database invariant, ITEM-16).
//!
//! Every other run is a no-op, decided by a single query: no `dataset-alignment` output on
//! this run ⇒ return.
//!
//! ## The two strings on the recipe, and why omitting the second fails SILENTLY
//!
//! `column_selector` is the MEMBER PATH inside a source store; `alignment_column` is the
//! ALIGNMENT's name for the column. Under the slot layout every per-dataset store is a
//! `metadata-column` holding one member named `values`, so the member path is the constant
//! `values` for every column and the two strings never coincide. A recipe that carried only
//! the member path would make `AlignmentPlan::level_lookup_for` miss for every column, take
//! the `remaps_levels_for == false` branch, and serve **each source's raw per-source level
//! codes against the unified vocabulary** — one dataset's entries rendered under another
//! dataset's labels, right row count, clean console. That is CRITICAL-2 of this stage,
//! re-reachable through the creator instead of through a rename, which is why
//! `alignment_column` is written from the alignment's own `remapped_columns()` and never
//! from a member path.
//!
//! ## Identity: the source index is the DATASET index, and never a segment index
//!
//! `plan.sources[i]`, `params.dataset_ids[i]` and the slot families `entity:<i>:<c>` /
//! `level:<i>:<c>` all index the SAME dimension — the producer builds its sources by
//! enumerating the relayed ids (`load_grid`), so they are one permutation by construction.
//! The creator therefore never touches `segment_order` or a segment index. That is
//! deliberate: with two sources the segment permutation `[1,0]` is its own inverse, so a
//! consumer that inverted the segment→source direction would pass against every two-source
//! fixture in the tree. The creator sidesteps the question by not asking it.
//!
//! **The corollary, stated so it is not read as a check it is not:** `plan.sources[i]
//! .dataset_id == params.dataset_ids[i]` is a TAUTOLOGY, not a cross-check — both come from
//! the same relayed list. The one genuinely independent channel is the `rows` binding's own
//! catalog `content_hash` versus `params.dataset_content_hashes[dataset_id]`, and that is
//! the check [`cross_check_row_bindings`] makes.

use std::collections::BTreeMap;
use std::path::Path;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::SqlitePool;
use uuid::Uuid;
use ziee_core::AppError;

use super::alignment::AlignmentPlan;
use super::catalog::models::{Artifact, NewArtifact};
use super::catalog::repository::CatalogRepository;
use super::gathered::{definition_content_hash, GatheredFrom};
use crate::modules::jobs::models::Job;
use crate::modules::sandbox::spec::AnalysisSpec;

/// **What makes a run an alignment run: the SHAPE of one of its outputs, not its datatype
/// id.**
///
/// The obvious selector is `datatype = "dataset-alignment"`. That id belongs to a
/// CONTRIBUTED package (its manifest declares the type lattice), and a core module that
/// hardcodes it puts a domain vocabulary back inside the loader — the leak
/// `lint-no-domain-in-builtin` exists to catch, and the same objection that removed
/// `datatype` from `derive_artifact_mount_name`.
///
/// Selecting on the shape is also STRICTLY more accurate. What the creator needs is an
/// artifact whose declaration it can read as an alignment, and that is exactly what
/// `AlignmentPlan::parse` decides — six required roles plus their extents. An artifact
/// carrying the right id and the wrong shape would have satisfied the id test and then failed
/// at the first field; one carrying the right shape under a future id would have been missed
/// entirely. So this is not a euphemism adopted to satisfy a matcher: the guard found a real
/// selector defect, which is the test `BASE.md` asks a forced rename to pass.
fn alignment_of(artifacts: &[Artifact]) -> Option<(&Artifact, AlignmentPlan)> {
    artifacts.iter().find_map(|a| {
        // A gathered row has no bytes and is never a source of one — skip before parsing so
        // a re-finalize cannot pick up what a previous pass wrote.
        (a.object_key.is_some())
            .then(|| {
                AlignmentPlan::parse(&a.structure, &a.meta)
                    .ok()
                    .map(|p| (a, p))
            })
            .flatten()
    })
}

/// `datasets.source` for a virtual dataset (migration `202608040005` widened the CHECK).
pub const DATASET_SOURCE_INTEGRATE: &str = "integrate";

/// `datasets.source` for a FILTER virtual dataset (migration `202608040011`, ITEM-13 / §11.3).
/// A filter has ONE source and a MASK, no alignment — the mirror of `integrate`, never the same
/// value: integration→alignment→VD and filtering→mask→VD are DISTINCT creation paths.
pub const DATASET_SOURCE_FILTER: &str = "filter";

/// The input slot a filter run binds its source count matrix at — the artifact whose
/// `dataset_id` IS the dataset being filtered (the filter processor's `expression` slot).
const EXPRESSION_SLOT: &str = "expression";

/// **What makes a run a FILTER run: a stored keep-mask output MARKED as a filter mask.**
///
/// The filter processor stamps `meta.filter_mask` (an object carrying the run LABEL, DEC-6) onto the
/// per-row boolean keep-mask it emits — the mirror of how integrate marks the alignment by its
/// SHAPE (`alignment_of`). Recognising the MARKER rather than a datatype id keeps a contributed
/// vocabulary out of core (the same `lint-no-domain-in-builtin` objection `alignment_of`
/// documents). The mask carries REAL bytes (`object_key.is_some()`), which is also what
/// [`super::catalog::repository::CatalogRepository::bind_mask_to_dataset`] requires — so a
/// gathered row can never be mistaken for the mask.
fn filter_mask_of(artifacts: &[Artifact]) -> Option<&Artifact> {
    artifacts.iter().find(|a| {
        a.object_key.is_some()
            && a.meta
                .get("filter_mask")
                .map(serde_json::Value::is_object)
                .unwrap_or(false)
    })
}

/// The run LABEL a filter mask records for naming its VD (DEC-6), trimmed; `None` when the label
/// is blank or absent, in which case the sink falls back to a source-derived name.
fn filter_mask_label(meta: &serde_json::Value) -> Option<String> {
    meta.get("filter_mask")?
        .get("label")
        .and_then(|l| l.as_str())
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
}

/// The DECLARED first-axis (row) length of an artifact's store — `shape[0]` of a matrix/dense
/// member, or a 1-D column's `n` / `columns[0].shape[0]`. `None` when no length is declared.
///
/// This is how the filter sink decides whether the per-row MASK applies to a given source
/// column: the mask indexes exactly the source's masked rows, so a source member whose first axis
/// has the mask's length is on that axis and is gathered THROUGH the mask; one of a different
/// length (a column-axis `var` member) is off-axis and gathered as an IDENTITY passthrough (INV-1:
/// a mask never touches an artifact that is not on its axis). Matching by declared length rather
/// than by an axis LABEL is robust to a producer that spells the axis differently on the mask and
/// on the column, and the serve path's length-mismatch refusal (Stage B) is the backstop.
pub fn declared_row_count(structure: &serde_json::Value) -> Option<usize> {
    let first_of = |v: &serde_json::Value| {
        v.get("shape")
            .and_then(|s| s.as_array())
            .and_then(|a| a.first())
            .and_then(serde_json::Value::as_u64)
    };
    first_of(structure)
        .or_else(|| structure.get("n").and_then(serde_json::Value::as_u64))
        .or_else(|| {
            structure
                .get("columns")
                .and_then(|c| c.as_array())
                .and_then(|c| c.first())
                .and_then(|c0| {
                    c0.get("n")
                        .and_then(serde_json::Value::as_u64)
                        .or_else(|| first_of(c0))
                })
        })
        .map(|n| n as usize)
}

/// The MEMBER PATH inside every per-dataset source store. A `metadata-column` artifact holds
/// exactly one member and the slot layout names it `values`; the column's own name is carried
/// by the SLOT and never staged into the store. NOT the alignment's name for the column —
/// see the module header.
pub const SOURCE_MEMBER: &str = "values";

/// **The axis a gathered column lives on: the SHARED AXIS KIND its sources declare, carried
/// through — NOT a name minted here.**
///
/// This used to be the constant `"unified_rows"`, on the reasoning that the alignment's ROW
/// plane is a NEW row space and therefore deserves a new name. The row space is indeed new;
/// the mistake was expressing that in the NAME. Axis identity is the key artifact's
/// `content_hash` (INV-3 — *"an axis IS its key artifact; the axis NAME is a label, never a
/// key"*), and a gathered key column's hash is a definition hash no source can collide with.
/// So distinctness was already carried, and the invented label was a NAME doing an
/// IDENTITY's job.
///
/// What it cost: an axis LABEL is what every consumer matches on. `resolveIntegrationGrid`
/// asks each candidate dataset for a row index on the view's declared level axis; a virtual
/// dataset answered `unified_rows`, matched nothing, and was refused as an input
/// **whatever the picker offered** — so integrating a filtered or an already-integrated
/// dataset was unreachable at the creator, no matter how the serve path chained.
///
/// The replacement rule, and the precondition that makes it meaningful:
///
/// * a gathered column declares the axis kind **its sources declare** — whatever kind of
///   thing their rows are, the gathered rows are the same kind of thing;
/// * the sources must AGREE. Combining one row space with an unrelated one is not an
///   integration whose axis needs a new word for it, it is not an integration at all, and
///   [`resolve_shared_axis`] refuses it the same way disagreeing dtypes / member kinds /
///   datatypes are already refused three lines apart.
///
/// Core may not spell a domain axis (`lint-no-domain-in-builtin`), which is not merely a
/// constraint tolerated here but the same statement from the other side: the shared kind is
/// DATA read off the sources, and the creator's job is to carry it, not to know it.
///
/// ---
///
/// This function answers the narrow half: the axis a SOURCE store declares —
/// `structure.axis`, the singular TABLE key, and nothing else.
///
/// The plural `axes: […]` of a matrix declaration is deliberately NOT read, not even when it
/// holds a single entry. Sources under the slot layout are single-member `metadata-column`
/// tables, which declare the singular key; taking an element of a declared COLLECTION would
/// be this side deciding by position which of a producer's axes a column is gathered along,
/// and the caller refuses an undeclared axis loudly, which is the better answer than a
/// positional guess that is invisible when wrong.
pub fn source_axis(structure: &serde_json::Value) -> Option<String> {
    structure
        .get("axis")
        .and_then(|a| a.as_str())
        .filter(|a| !a.is_empty())
        .map(str::to_string)
}

/// ONE source's answer to "which axis are these rows?", carried with enough of its origin to
/// name the disagreement rather than merely report one.
///
/// `axis: None` is a claim too — "this source declares nothing" — and it compares UNEQUAL to
/// a source that declares an axis, which is the behaviour wanted: a silent source and a
/// declaring source do not agree — they are one source that answered and one that did not.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AxisClaim {
    axis: Option<String>,
    /// The alignment's name for the column, or `None` for the unified KEY column.
    column: Option<String>,
    dataset_id: String,
    artifact_id: Uuid,
}

impl AxisClaim {
    fn describe(&self) -> String {
        let column = match &self.column {
            Some(c) => format!("column {c:?}"),
            None => "the unified key column".to_string(),
        };
        format!(
            "{column}'s source artifact {} (dataset {:?})",
            self.artifact_id, self.dataset_id
        )
    }

    fn axis_word(&self) -> String {
        match &self.axis {
            Some(a) => format!("{a:?}"),
            None => "no axis at all".to_string(),
        }
    }

    fn disagreement(&self, other: &Self) -> String {
        format!(
            "the sources of this alignment do not share a row axis: {} declares {}, while {} \
             declares {}. Integration combines LIKE with LIKE — one row space with another \
             of the SAME kind — and a gathered column carries the kind its sources declare \
             rather than inventing a new name for the pair, so sources that disagree are not \
             an integration this can name",
            self.describe(),
            self.axis_word(),
            other.describe(),
            other.axis_word(),
        )
    }

    fn unlabelled(&self) -> String {
        format!(
            "{} declares no `structure.axis`, so the gathered columns have no row-axis kind \
             to carry. The creator will not mint one: an axis label is what every consumer \
             matches on, and a name minted here matches nothing a producer declares",
            self.describe(),
        )
    }
}

/// **The one row axis every gathered column of a virtual dataset lives on — or a refusal.**
///
/// Pure over the claims so the precondition can be exercised without a run: the creator
/// collects one claim per (column, source) and asks this question once, and the two failures
/// it must name — two datasets contributing different row spaces to one column, and two
/// columns landing on different planes — are the SAME comparison, so neither can be handled
/// and the other forgotten.
///
/// `Err` on disagreement and `Err` on a source that declares nothing. Neither is a case for a
/// default: a defaulted axis is a minted label, and a minted label is what this whole change
/// removed.
fn resolve_shared_axis(claims: &[AxisClaim]) -> Result<String, AppError> {
    let Some(first) = claims.first() else {
        return Err(creator_error(
            "the alignment declares no gathered column with a source, so this virtual dataset \
             has no row axis to live on",
        ));
    };
    if let Some(other) = claims.iter().find(|c| c.axis != first.axis) {
        return Err(creator_error(first.disagreement(other)));
    }
    match &first.axis {
        Some(axis) => Ok(axis.clone()),
        None => Err(creator_error(first.unlabelled())),
    }
}

/// One gathered column's RESOLVED declaration — everything pass 1 decided, handed to pass 2.
struct ColumnDeclaration {
    data_type: String,
    member_kind: Option<String>,
    source_datatype: String,
}

/// The slot the per-dataset ROW-AXIS index is bound at (one binding per dataset, in dataset
/// order) — the producer's `ROWS_SLOT`.
const ROWS_SLOT: &str = "rows";

/// The slot FAMILY carrying a fused categorical's per-dataset codes: `level:<i>:<column>`.
const LEVEL_SLOT_PREFIX: &str = "level:";

/// What one run's finalize did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The run emitted no `dataset-alignment` — the overwhelmingly common case.
    NotAnAlignmentRun,
    /// A virtual dataset for this run already exists. The boot re-finalize
    /// (`scheduler::reconcile_orphaned_running`) reaches this path a second time for one
    /// run, and the partial unique index on `(metadata->>'alignment_run_id')` is what makes
    /// the second pass this rather than a duplicate.
    AlreadyCreated { dataset_id: Uuid },
    Created {
        dataset_id: Uuid,
        gathered: Vec<Uuid>,
    },
}

/// One gathered column to write — resolved, but not yet inserted.
///
/// Pure data, so [`plan_gathers`] is unit-testable against no database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatherPlanItem {
    /// The artifact's `output_id`, i.e. its half of the `(project, dataset, run, output_id)`
    /// idempotency key.
    pub output_id: String,
    /// The ALIGNMENT's name for the column; `None` for the key gather, which fuses no
    /// vocabulary. Written to the recipe verbatim.
    pub alignment_column: Option<String>,
    /// `(dataset_id, artifact_id)` per source, in source-index order. `dataset_id` is the
    /// alignment's own string for that source, because that is what
    /// `GatheredFrom::artifact_for_dataset` looks up.
    pub sources: Vec<(String, Uuid)>,
}

impl GatherPlanItem {
    /// The string this column's DEFINITION is hashed under — see [`definition_selector`].
    pub fn definition_selector(&self, key_column: &str) -> String {
        definition_selector(self.alignment_column.as_deref(), key_column)
    }
}

/// **The answer to `definition_content_hash`'s third argument, and it is forced.**
///
/// The hash keys the chunk cache. Feeding it the MEMBER PATH would feed it the constant
/// `values` for every fused column of one alignment, so `group` and `donor` over the same
/// sources would hash IDENTICALLY — and a cache keyed on `(definition, chunk)` would serve
/// one column's warm bytes for the other. That is a correctness defect, not a cache miss,
/// and it is the same member-path-for-column-name confusion the recipe's two strings exist
/// to separate.
///
/// So the selector is the ALIGNMENT's name for the gathered column: `alignment_column` for a
/// fused categorical, and the alignment's own `key_column` for the key gather (which is
/// precisely the alignment's name for that column). One rule, one vocabulary, and the two
/// cannot collide inside one alignment — the key column is the key, so no fused column
/// carries its name.
///
/// ## "Answered on BOTH sides" — measured, and the obvious form of it is impossible
///
/// The stage brief asks for the producer to stamp this hash too, so a divergence can be
/// refused at run time. **It cannot.** `definition_content_hash`'s FIRST argument is the
/// alignment ARTIFACT's id, which the catalog mints at ingest — after the producer process
/// has exited. `alignment_id` appears nowhere in `packages/` except inside the Python
/// function's own signature, which is precisely why that function has zero callers there: it
/// is structurally uncallable in the producer's context.
///
/// So there is no moment at which both sides hold a value for one alignment, and a runtime
/// comparison would be a comparison against a field nothing can ever write. What IS available
/// — and is strictly stronger than a pinned copy of the producer's output — is agreement on
/// the FUNCTION, executed rather than remembered:
/// `gathered::tests::the_producers_own_implementation_is_executed_and_agrees` runs
/// `_helpers/alignment.py`'s implementation in a subprocess and compares it to this side's,
/// on every `cargo test --lib`. A divergence in either language goes red immediately instead
/// of becoming a cache that never hits with nothing that says why.
pub fn definition_selector(alignment_column: Option<&str>, key_column: &str) -> String {
    alignment_column.unwrap_or(key_column).to_string()
}

/// **The element type a SOURCE store declares for its member — read from the producer's own
/// vocabulary, not from this side's.**
///
/// A real `metadata-column` artifact's `structure` is the store's `attributes.cyto` verbatim
/// (that is what ingest records), and it carries **no top-level `data_type`**: the dtype
/// lives on the entry of `columns[]` whose `path` is the member. This side's GATHERED
/// declaration is the one that uses a top-level `data_type`, and conflating the two reads
/// `None` off every real artifact while working perfectly against a hand-built fixture.
///
/// Measured against `tests/fixtures/stage1_alignment/sources/*.zarr`, which are the real
/// writer's output: `level_*.zarr` → `columns[0] = {path:"values", kind:"categorical",
/// dtype:"uint8"}`, `rows.zarr` → `{path:"values", kind:"string", layout:"split",
/// dtype:"utf8"}`.
///
/// The top-level fallback is kept for a store that declares one, but it is second: a
/// per-column dtype is the more specific answer and cannot be right about the wrong member.
pub fn source_dtype(structure: &serde_json::Value, member: &str) -> Option<String> {
    structure
        .get("columns")
        .and_then(|c| c.as_array())
        .and_then(|cols| {
            cols.iter()
                .find(|c| c.get("path").and_then(|p| p.as_str()) == Some(member))
                .or_else(|| {
                    // A single-column store whose one member is unnamed in `path` is still
                    // unambiguous; more than one and a guess would pick a column at random.
                    (cols.len() == 1).then(|| &cols[0])
                })
        })
        .and_then(|c| c.get("dtype").and_then(|d| d.as_str()))
        .or_else(|| structure.get("data_type").and_then(|d| d.as_str()))
        .map(str::to_string)
}

/// **The member KIND a SOURCE store declares — the same lookup as [`source_dtype`], on the
/// same entry.**
///
/// It is the field `readCategoricalColumn` and `cyto_zarr_read.read_column` both dispatch on:
/// `categorical` resolves codes through a declared level set, `string` decodes the split
/// pair, anything else is read as raw numbers. A gathered column is the same KIND of thing as
/// the columns it gathers, so this is CARRIED rather than decided here — deciding it would be
/// this side inventing a semantics for the producer's bytes.
///
/// `None` when the source declares none; the caller then falls back on the dtype, which
/// distinguishes only `string` from `numeric` and can never invent a `categorical`.
pub fn source_kind(structure: &serde_json::Value, member: &str) -> Option<String> {
    structure
        .get("columns")
        .and_then(|c| c.as_array())
        .and_then(|cols| {
            cols.iter()
                .find(|c| c.get("path").and_then(|p| p.as_str()) == Some(member))
                .or_else(|| (cols.len() == 1).then(|| &cols[0]))
        })
        .and_then(|c| c.get("kind").and_then(|k| k.as_str()))
        .map(str::to_string)
}

/// **The element width a FUSED column must be declared at — sized from the SIZE OF THE
/// UNIFIED VOCABULARY, never from a source and never from the SUM of the sources.**
///
/// The sources' width is `code_dtype(that source's levels)`. The unified vocabulary is a
/// UNION, so it can be strictly wider than any source: two `donor` columns of 200 levels
/// each, sharing 143, fuse to 257 — past `uint8` while both sources are `uint8`. Copying the
/// source width then TRUNCATES in `remap_codes`, and truncation of a level code is not a
/// visible failure: `299 & 0xff == 43` is a real index into the unified vocabulary, so the
/// client renders a genuine label belonging to a different entity. Measured, not reasoned —
/// the arithmetic returns `Ok(())` and writes 43.
///
/// ## `unified_levels` IS THE QUANTITY. The sum of the lookup extents is NOT.
///
/// This function first computed `Σ(source level counts)` — an upper bound on the number of
/// distinct unified codes — reasoning that *"sizing to the upper bound can only ever be too
/// WIDE, which costs bytes, never correctness."* **That sentence was false**, and it shipped
/// a regression:
///
/// * **The bound is wrong in the normal case.** Heavy overlap is the REASON to fuse, so two
///   130-level sources whose union is 140 summed to 260 and were declared `uint16`. Two
///   IDENTICAL 200-level vocabularies (union 200, comfortably a byte) were declared `uint16`
///   too — and those served correctly before the bound was introduced.
/// * **Too wide is not free.** Nothing converts the source bytes, so a widened declaration
///   is a width MISMATCH against them. Measured: `item = 2` over a 1-byte-per-element
///   buffer gives `GATHER_RECIPE_INVALID` on an odd row count, `GATHER_LEVEL_CODE_UNMAPPED`
///   on most even ones (`row 0 holds level code 256`), and in the residual case `Ok(())`
///   having written across two rows.
///
/// The union size is not a guess — it is `|attributes.cyto_alignment.unified_levels[column]|`,
/// which the producer declares and the serve path already reads verbatim. `union_levels` is
/// that count, and `None` means the creator could not read it.
///
/// **`None` in, `None` out — the sources' width is kept, deliberately.** An invented width is
/// what caused this defect; the width the bytes actually ARE is always a safe declaration, and
/// `remap_codes`' `GATHER_LEVEL_CODE_TOO_WIDE` then makes a genuinely-too-narrow column LOUD
/// rather than silent. Prevention and detection are not redundant: one fixes today's writer,
/// the other refuses tomorrow's.
///
/// Also `None` when the alignment declares no lookup for the column — with no remap the codes
/// are written through unchanged, so the sources' width is not merely safe, it is correct.
pub fn unified_code_dtype(
    plan: &AlignmentPlan,
    column: &str,
    union_levels: Option<usize>,
) -> Option<&'static str> {
    if !plan.remaps_levels_for(column) {
        return None;
    }
    // The widest code an `n`-label vocabulary can carry is `n - 1`; an empty one still needs a
    // byte. DEC-27's declared missing level is already IN `unified_levels`, so no allowance is
    // added for it here — adding one would re-introduce a bound that is wrong by construction.
    Some(match (union_levels?).saturating_sub(1) {
        0..=0xff => "uint8",
        0x100..=0xffff => "uint16",
        _ => "uint32",
    })
}

/// **The `structure` a gathered artifact declares — the SAME vocabulary a real store's
/// `attributes.cyto` uses (DEC-26).**
///
/// It used to be `{kind, axis, n, data_type, gathered_from}`, which no client path could
/// read: `parseStructure` threw on the missing `encoding` before a byte was fetched,
/// `asZarrTable` requires `encoding == "zarr_v3"`, and `resolveMember` throws on an empty
/// `columns[]`. The server built a synthetic vocabulary specifically to feed
/// `readCategoricalColumn` and nothing could reach it.
///
/// Measured off the real writer (`stage1_alignment/sources/level_0_group.zarr`), so this is
/// the shape ingest already emits rather than a plausible one:
///
/// * `encoding`/`kind` — what `parseStructure` + `asZarrTable` gate on;
/// * `columns[0]` — ONE member at `values`, which is where the bytes are now served
///   (`gathered_member_path`), carrying the `kind` a client dispatches on;
/// * `arrays: []` — a gathered column contributes no unlabelled arrays.
///
/// `data_type` stays at the top level as well: it is what `synthetic_zarr_json` and
/// `gather_exec::resolve` size the elements from, and a real `metadata-column` legitimately
/// carries none, so the two spellings are not interchangeable and the server-side one is not
/// derivable from the member entry alone.
/// **Which side of the axis-identity relation a gathered artifact declares.**
///
/// `verify_leaf_digest` reads TWO fields and treats them as one assertion made from opposite
/// sides: `structure.key_sequence_digest` on the artifact that CARRIES an axis's keys, and
/// `structure.aligned_to` on a table merely LIVING on that axis. A gathered column is one or the
/// other and never both, so the choice is a variant rather than two `Option`s that could be set
/// together or neither.
///
/// **It is a REQUIRED parameter, deliberately.** Before this, the creator emitted a gathered row
/// carrying neither field, and `gather_exec::plan_chain` had to work around it by hoisting the
/// digest check and not demanding one from intermediates — a documented residual gap: *a
/// permutation of an intermediate that preserves row count is undetectable*. Making the identity
/// an argument means a future writer of gathered rows must ANSWER the question; the previous
/// shape let it be skipped by simply not thinking of it, which is how the gap arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyIdentity<'a> {
    /// This artifact carries the axis's keys — the gathered KEY column. Emits
    /// `structure.key_sequence_digest`.
    Carries(&'a str),
    /// This artifact lives on an axis someone else carries. Emits `structure.aligned_to`.
    AlignedTo(&'a str),
    /// Nothing to declare. Reached when the alignment itself pinned no unified digest, in which
    /// case inventing one here would be a fabricated identity — worse than none, because
    /// `verify_leaf_digest`'s whole contract is that unknown never matches.
    Unpinned,
}

/// `axis` is the SHARED axis kind the sources declare ([`source_axis`], agreed by
/// [`resolve_shared_axis`]) — a required argument for the same reason `identity` is: the
/// previous constant let the question go unasked, and the answer it stood in for was wrong
/// for every real input.
pub fn gathered_structure(
    data_type: &str,
    member_kind: Option<&str>,
    axis: &str,
    n: usize,
    identity: KeyIdentity<'_>,
    gathered_from: serde_json::Value,
) -> serde_json::Value {
    // Only two kinds are distinguishable from the dtype alone, and neither can be invented:
    // a `categorical` is only ever CARRIED from a source that declared one.
    let kind = member_kind.map(str::to_string).unwrap_or_else(|| {
        if data_type == "utf8" {
            "string"
        } else {
            "numeric"
        }
        .to_string()
    });
    let mut column = json!({
        "path": SOURCE_MEMBER,
        "name": SOURCE_MEMBER,
        "kind": kind,
        "dtype": data_type,
        "shape": [n],
        "axis": axis,
        "n": n,
    });
    if kind == "string" {
        // The split pair's own addresses, relative to the store root — exactly what
        // `cyto_zarr.Table.string` declares, and what `openSplitStringColumn` reads beneath
        // the member.
        column["layout"] = json!("split");
        column["offsets"] = json!(format!("{SOURCE_MEMBER}/offsets"));
        column["values"] = json!(format!("{SOURCE_MEMBER}/values"));
    }
    let mut structure = json!({
        "encoding": "zarr_v3",
        "kind": "table",
        "axis": axis,
        "n": n,
        "columns": [column],
        "arrays": [],
        "data_type": data_type,
        "gathered_from": gathered_from,
    });
    // Exactly one field, or none. Emitting both would make an artifact assert that it carries an
    // axis AND merely lives on one, and `verify_leaf_digest` reads the first it finds — so the
    // contradiction would be resolved silently by field order.
    match identity {
        KeyIdentity::Carries(d) => structure["key_sequence_digest"] = json!(d),
        KeyIdentity::AlignedTo(d) => structure["aligned_to"] = json!(d),
        KeyIdentity::Unpinned => {}
    }
    structure
}

/// The LOGICAL size of a gathered column — `rows × element width` — or `None` when this
/// dtype has no derivable fixed width.
///
/// The same arithmetic [`super::gather_exec::GatheredStore::gathered_size_bytes`] does at
/// serve time, taken here from the DECLARATION so the catalog can answer the question
/// without resolving the gather. The two must agree; `gathered_chain_test` pins that.
///
/// `None` rather than `0` for an unsupported dtype is the whole point of the `Option`:
/// [`super::gathered::item_size`] refuses a width it cannot know rather than guessing one,
/// and a size derived from a refused width would be a fabricated number of exactly the
/// kind that put `Size: 0 Bytes` on screen. A split string column is the live case — its
/// values are bounded by an offsets member, so its byte size is data-dependent and is not
/// knowable from `(dtype, n)` at all.
pub fn gathered_logical_bytes(data_type: &str, n: usize) -> Option<i64> {
    let item = super::gathered::item_size(data_type).ok()?;
    i64::try_from(n.checked_mul(item)?).ok()
}

/// The alignment's declared unified vocabularies, or `None` if they cannot be read.
///
/// `None` and "the column is absent from the map" are deliberately different: the first says
/// nothing is known, the second says this alignment fuses no vocabulary for that column.
/// Both lead to the sources' width, but only the first is a diagnostic worth logging.
async fn read_unified_levels(pool: &SqlitePool, alignment_id: Uuid) -> Option<serde_json::Value> {
    let store = super::get_object_store();
    let bytes = super::data_api::read_member_bytes(pool, store.as_ref(), alignment_id, "zarr.json")
        .await
        .map_err(|e| {
            tracing::warn!(
                %alignment_id,
                "could not read the alignment's group attributes; gathered columns will be \
                 declared at their SOURCES' width, which is the width their bytes are: {e}"
            )
        })
        .ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .pointer("/attributes/cyto_alignment/unified_levels")
        .cloned()
}

/// How many labels the unified vocabulary for `column` holds.
fn union_level_count(vocabularies: &Option<serde_json::Value>, column: &str) -> Option<usize> {
    vocabularies.as_ref()?.get(column)?.as_array().map(Vec::len)
}

/// The slot a fused column's per-dataset codes are bound at.
fn level_slot(source_index: usize, column: &str) -> String {
    format!("{LEVEL_SLOT_PREFIX}{source_index}:{column}")
}

/// Every `(slot, artifact_id)` the run's spec DECLARED, in declaration order.
///
/// Only artifact-backed inputs appear: a `dataset_file_ref` or a `host_path` binding
/// contributes no catalog artifact, so it cannot be a gather source and is dropped here
/// rather than surfacing later as a confusing "unresolved source".
pub fn artifact_bindings(spec: &AnalysisSpec) -> Vec<(String, Uuid)> {
    spec.inputs
        .iter()
        .filter_map(|i| i.artifact_ref.map(|a| (i.slot.clone(), a)))
        .collect()
}

/// Resolve one slot to its artifact, refusing an ambiguous multi-binding.
fn single_binding(bindings: &[(String, Uuid)], slot: &str) -> Option<Uuid> {
    let mut hits = bindings.iter().filter(|(s, _)| s == slot);
    let first = hits.next()?;
    // Two artifacts on one non-repeating slot is not a thing the runner can stage
    // (`unique_mount_name` disambiguates the MOUNT, not the binding), so a second hit means
    // a spec this function does not understand. Refuse by returning None rather than picking.
    hits.next().is_none().then_some(first.1)
}

/// The bindings on the repeating `rows` slot, in binding order (= dataset order).
fn row_bindings(bindings: &[(String, Uuid)]) -> Vec<Uuid> {
    bindings
        .iter()
        .filter(|(s, _)| s == ROWS_SLOT)
        .map(|(_, a)| *a)
        .collect()
}

fn creator_error(msg: impl Into<String>) -> AppError {
    AppError::bad_request("VIRTUAL_DATASET_UNCREATABLE", msg.into())
}

/// **The plan: which gathered columns this alignment yields, and from which artifacts.**
///
/// Pure — no database, no filesystem. Every refusal names the slot it wanted, because the
/// failure it replaces (a column silently missing from the virtual dataset) has no message.
pub fn plan_gathers(
    plan: &AlignmentPlan,
    bindings: &[(String, Uuid)],
) -> Result<Vec<GatherPlanItem>, AppError> {
    let n = plan.sources.len();
    if n == 0 {
        return Err(creator_error(
            "the alignment declares no sources, so there is nothing to gather through it. \
             An alignment over zero datasets is not an alignment",
        ));
    }

    let mut items: Vec<GatherPlanItem> = Vec::new();

    // ── the KEY gather (ITEM-22(b)) — the unified identifier column ─────────────────────
    //
    // Its sources are the per-dataset ROW-AXIS indexes bound at `rows`, aligned to the
    // source dimension by BINDING ORDER, which is the same relay the producer cross-checks
    // against `params.dataset_content_hashes`. It carries NO `alignment_column`: there is no
    // fused vocabulary for an identifier, and absence here is a DECLARATION that no remap
    // applies rather than a lookup that missed.
    let rows = row_bindings(bindings);
    if rows.len() != n {
        return Err(creator_error(format!(
            "the alignment has {n} source(s) but the run bound {} artifact(s) at slot \
             {ROWS_SLOT:?}. The row-axis index is one per dataset, aligned by binding order, \
             so an incomplete set means the key column cannot be resolved to bytes for every \
             source — and a partial gather would serve some datasets' keys as if they were \
             all of them",
            rows.len()
        )));
    }
    items.push(GatherPlanItem {
        output_id: format!("virtual-key-{}", plan.key_column),
        alignment_column: None,
        sources: plan
            .sources
            .iter()
            .zip(rows.iter())
            .map(|(s, a)| (s.dataset_id.clone(), *a))
            .collect(),
    });

    // ── one gather per FUSED column ─────────────────────────────────────────────────────
    //
    // The column list comes from the ALIGNMENT (`remapped_columns`), never from the spec's
    // slot names: a level slot the producer did not fuse would otherwise become a gathered
    // column with no level lookup, i.e. raw per-source codes served against a vocabulary
    // that does not describe them.
    for column in plan.remapped_columns() {
        let mut sources: Vec<(String, Uuid)> = Vec::with_capacity(n);
        for (index, source) in plan.sources.iter().enumerate() {
            let slot = level_slot(index, &column);
            let artifact = single_binding(bindings, &slot).ok_or_else(|| {
                creator_error(format!(
                    "the alignment fuses column {column:?} for source {index} \
                     ({dataset:?}), but the run has no single artifact bound at slot \
                     {slot:?}. The level lookup exists, so the codes it remaps must too — \
                     serving this column without that source is serving a hole",
                    dataset = source.dataset_id,
                ))
            })?;
            sources.push((source.dataset_id.clone(), artifact));
        }
        items.push(GatherPlanItem {
            output_id: format!("virtual-column-{column}"),
            alignment_column: Some(column),
            sources,
        });
    }

    Ok(items)
}

/// **The mount RECORD, and the two answers it distinguishes.**
///
/// `recorded_mount_names` returns `None` when `<workspace>/inputs/inputs.json` is not there
/// to read and `Some(vec![])` when the run genuinely staged nothing. Those call for
/// different actions and are therefore two buckets, not one:
///
/// * `None` — the record is GONE (an already-reclaimed workspace, a foreign finalize). The
///   creator cannot confirm the run staged the slots the spec declares, so it refuses and
///   says the workspace is what is missing. Re-running the analysis fixes it.
/// * `Some(vec![])` — the record is there and says the run staged NO inputs. An alignment
///   over no inputs is incoherent; the producer, not the workspace, is what to look at.
///
/// A single "no mounts" message would send half of its readers to the wrong place.
pub fn check_mount_record(
    recorded: Option<&[(String, String)]>,
    expected_slots: &[String],
) -> Result<(), AppError> {
    let Some(recorded) = recorded else {
        return Err(creator_error(
            "this run's `<workspace>/inputs/inputs.json` is gone, so which slot was staged \
             at which mount cannot be confirmed. The workspace is reclaimed immediately \
             after a successful finalize, so reaching here means the creator ran outside \
             that window — the alignment artifact is intact; re-run the analysis to create \
             its virtual dataset",
        ));
    };
    if recorded.is_empty() {
        return Err(creator_error(
            "this run's `inputs.json` records NO staged inputs, yet it emitted an alignment. \
             An alignment is computed FROM sources, so a run with none did not compute one \
             from anything — look at the producer's output, not at the workspace",
        ));
    }
    let staged: std::collections::BTreeSet<&str> =
        recorded.iter().map(|(slot, _)| slot.as_str()).collect();
    let missing: Vec<&str> = expected_slots
        .iter()
        .map(String::as_str)
        .filter(|s| !staged.contains(s))
        .collect();
    if !missing.is_empty() {
        return Err(creator_error(format!(
            "the spec declares artifact bindings at slot(s) {missing:?} that this run's \
             `inputs.json` does not record as staged. The recipe would then name artifacts \
             the run never read, so the gathered column's bytes and the alignment's vectors \
             would come from different input sets"
        )));
    }
    Ok(())
}

/// **The one genuinely independent cross-check available here.**
///
/// `params.dataset_content_hashes` is a map the LAUNCHER relayed; the `rows` binding's
/// `content_hash` is what INGEST computed over the artifact's own bytes. Those are two
/// channels and they can disagree — which is the whole point, and is why the tautological
/// `plan.sources[i].dataset_id == params.dataset_ids[i]` is deliberately not asserted here
/// (both sides of that come from the same relayed list; see the module header).
pub fn cross_check_row_bindings(
    dataset_ids: &[String],
    hashes: &BTreeMap<String, String>,
    row_artifacts: &[(Uuid, String)],
) -> Result<(), AppError> {
    if dataset_ids.len() != row_artifacts.len() {
        return Err(creator_error(format!(
            "params.dataset_ids relays {} dataset(s) but {} artifact(s) are bound at slot \
             {ROWS_SLOT:?}. The two lists are joined POSITIONALLY, so unequal lengths mean \
             every join past the shorter one is a guess",
            dataset_ids.len(),
            row_artifacts.len()
        )));
    }
    for (index, dataset_id) in dataset_ids.iter().enumerate() {
        let (artifact_id, actual) = &row_artifacts[index];
        let expected = hashes.get(dataset_id).ok_or_else(|| {
            creator_error(format!(
                "params.dataset_content_hashes has no entry for {dataset_id:?}, so the \
                 artifact bound at {ROWS_SLOT:?}[{index}] cannot be confirmed to be that \
                 dataset's row axis. The relay is the only thing tying a slot ORDINAL to a \
                 dataset IDENTITY, and an unchecked relay attributes rows silently"
            ))
        })?;
        if expected != actual {
            return Err(creator_error(format!(
                "dataset index {index} is {dataset_id:?} according to params.dataset_ids, \
                 but the artifact staged at {ROWS_SLOT:?}[{index}] ({artifact_id}) has \
                 content_hash {actual:?} while {dataset_id:?} is relayed as {expected:?}. \
                 The bindings and the identities disagree, so every gathered column would \
                 attribute one dataset's rows to another"
            )));
        }
    }
    Ok(())
}

// ─────────────────────────────── the DB-facing half ──────────────────────────────────────

/// The installed [`crate::modules::jobs::seams::VirtualDatasetSink`].
pub struct WorkstoreVirtualDatasetSink {
    pool: SqlitePool,
}

impl WorkstoreVirtualDatasetSink {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl crate::modules::jobs::seams::VirtualDatasetSink for WorkstoreVirtualDatasetSink {
    async fn on_run_finalized(&self, job: &Job, workspace_root: &Path) {
        // Two DISTINCT creation paths, tried in turn (a run emits ONE of the two, never both —
        // a filtered integration is CHAINING, §11.3). Integration (alignment→VD) is the built
        // path; filtering (mask→VD) is its mirror. Neither creates the other, so this dispatches
        // on which shaped artifact the run actually emitted.
        match create_for_run(&self.pool, job, workspace_root).await {
            Ok(Outcome::NotAnAlignmentRun) => self.finalize_filter(job).await,
            Ok(Outcome::AlreadyCreated { dataset_id }) => {
                tracing::info!(
                    job_id = %job.id, %dataset_id,
                    "virtual dataset already exists for this run; creator is a no-op"
                );
            }
            Ok(Outcome::Created {
                dataset_id,
                gathered,
            }) => {
                tracing::info!(
                    job_id = %job.id, %dataset_id, columns = gathered.len(),
                    "virtual dataset created from an alignment run"
                );
            }
            // Deliberately not fatal: the outputs are already cataloged and the run
            // succeeded. What failed is the convenience row over the alignment, and failing
            // the run here would discard a successful integration over a catalog write.
            Err(e) => tracing::error!(
                job_id = %job.id, error = ?e,
                "virtual-dataset creation FAILED; the alignment artifact is intact and \
                 browsable, but no virtual dataset was created for it"
            ),
        }
    }
}

impl WorkstoreVirtualDatasetSink {
    /// The FILTER mirror of `on_run_finalized`'s alignment arm — same fire-and-forget posture:
    /// a failure here is logged, never fatal (the mask + outputs are already cataloged; failing
    /// the run would discard a successful filter over a catalog write).
    async fn finalize_filter(&self, job: &Job) {
        match create_filter_vd_for_run(&self.pool, job).await {
            Ok(FilterOutcome::NotAFilterRun) => {}
            Ok(FilterOutcome::AlreadyCreated { dataset_id }) => tracing::info!(
                job_id = %job.id, %dataset_id,
                "filter virtual dataset already exists for this run; creator is a no-op"
            ),
            Ok(FilterOutcome::Created {
                dataset_id,
                gathered,
                ..
            }) => tracing::info!(
                job_id = %job.id, %dataset_id, columns = gathered.len(),
                "virtual dataset created from a filter run"
            ),
            Err(e) => tracing::error!(
                job_id = %job.id, error = ?e,
                "filter virtual-dataset creation FAILED; the mask artifact is intact, but no \
                 virtual dataset was created for it"
            ),
        }
    }
}

/// Every artifact this run cataloged, within the run's own tenancy scope.
async fn run_artifacts(
    pool: &SqlitePool,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    run_id: Uuid,
) -> Result<Vec<Artifact>, AppError> {
    sqlx::query_as!(
        Artifact,
        r#"SELECT id as "id: Uuid", project_id as "project_id?: Uuid", dataset_id as "dataset_id?: Uuid", run_id as "run_id?: Uuid", output_id, datatype,
                  object_key, is_multifile as "is_multifile: bool", content_hash,
                  structure as "structure: serde_json::Value",
                  meta as "meta: serde_json::Value",
                  role, status, stored_bytes, logical_bytes, created_by as "created_by: Uuid",
                  created_at as "created_at: DateTime<Utc>",
                  updated_at as "updated_at: DateTime<Utc>",
                  hidden as "hidden: bool", representation_of as "representation_of?: Uuid"
           FROM artifacts
           WHERE run_id = $1
             AND ($2 IS NULL OR project_id = $2)
             AND ($3 IS NULL OR dataset_id = $3)
           ORDER BY created_at ASC"#,
        run_id,
        project_id,
        dataset_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)
}

/// The `(id, content_hash, structure)` of one artifact, whatever its status.
async fn artifact_row(
    pool: &SqlitePool,
    id: Uuid,
) -> Result<Option<(String, serde_json::Value, String)>, AppError> {
    let row = sqlx::query!(
        r#"SELECT content_hash, structure as "structure: serde_json::Value", datatype
           FROM artifacts WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.map(|r| (r.content_hash, r.structure, r.datatype)))
}

/// The virtual dataset already created for this run, if any.
/// **Attach the virtual dataset to the project the run belongs to.**
///
/// Without this the row exists and is unreachable. `list_for_project_scope` — the workbench
/// catalog and every artifact picker behind it — resolves a project's artifacts as
/// *"`project_id = $1`, OR `project_id IS NULL` and the artifact's dataset is in
/// `project_datasets`"* (`catalog/repository.rs`). The creator's gathered artifacts are
/// deliberately dataset-scoped (`project_id: None`, `dataset_id: Some(...)`), so they can ONLY
/// arrive through the second disjunct — and the junction row it reads was never written. A
/// successful integration produced a dataset nobody could see.
///
/// `ON CONFLICT DO NOTHING` because this is called on both the create and the already-created
/// path: the second is a boot re-finalize, and it must repair a missing link without failing on
/// a present one.
///
/// A run with no project scope (a dataset-scoped run) links nothing, which is correct rather
/// than a gap — there is no project to link it to, and inventing one would put the dataset in a
/// project the run was not run in.
async fn attach_to_project(
    pool: &SqlitePool,
    project_id: Option<Uuid>,
    dataset: Uuid,
) -> Result<(), AppError> {
    let Some(project_id) = project_id else {
        return Ok(());
    };
    sqlx::query!(
        "INSERT INTO project_datasets (project_id, dataset_id) VALUES ($1, $2)
         ON CONFLICT (project_id, dataset_id) DO NOTHING",
        project_id,
        dataset,
    )
    .execute(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

async fn existing_virtual_dataset(
    pool: &SqlitePool,
    run_id: Uuid,
) -> Result<Option<Uuid>, AppError> {
    // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
    let bind_run_id_str = run_id.to_string();
    let row = sqlx::query!(
        r#"SELECT id as "id: Uuid" FROM datasets
         WHERE source = $1 AND json_extract(metadata, '$.alignment_run_id') = $2"#,
        DATASET_SOURCE_INTEGRATE,
        bind_run_id_str,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.map(|r| r.id))
}

/// **The creator proper.** See the module header for the ordering bounds this relies on.
pub async fn create_for_run(
    pool: &SqlitePool,
    job: &Job,
    workspace_root: &Path,
) -> Result<Outcome, AppError> {
    let run_id = job.run_id.unwrap_or(job.id);
    let (project_id, dataset_id) =
        match crate::modules::jobs::repository::JobRepository::job_scope(pool, job.id).await? {
            Some(scope) => scope.split(),
            None => (None, None),
        };

    // The no-op gate for every non-alignment run: ONE indexed query, before any parsing,
    // any file read, and any spec work.
    let produced = run_artifacts(pool, project_id, dataset_id, run_id).await?;
    let Some((alignment, plan)) = alignment_of(&produced) else {
        return Ok(Outcome::NotAnAlignmentRun);
    };

    if let Some(existing) = existing_virtual_dataset(pool, run_id).await? {
        // Re-linked, not just re-reported. This branch is the boot re-finalize's second pass,
        // and a link that failed (or was never written, for a row minted before the creator
        // linked at all) would otherwise stay missing forever — the row exists, so nothing ever
        // takes this code path again with a reason to write it.
        attach_to_project(pool, project_id, existing).await?;
        return Ok(Outcome::AlreadyCreated {
            dataset_id: existing,
        });
    }

    let spec = AnalysisSpec::parse(&job.params)?;
    let bindings = artifact_bindings(&spec);

    // The mount record, read BEFORE the reclaim (the hook's whole reason for living where it
    // does). `None` and `Some(vec![])` are kept distinct all the way to the message.
    let recorded =
        crate::modules::sandbox::inputs::recorded_mount_names(&workspace_root.join("inputs"));
    let expected_slots: Vec<String> = bindings.iter().map(|(s, _)| s.clone()).collect();
    check_mount_record(recorded.as_deref(), &expected_slots)?;

    // The relay cross-check, against the artifacts' OWN ingest-computed hashes.
    let dataset_ids: Vec<String> = spec
        .params
        .get("dataset_ids")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let hashes: BTreeMap<String, String> = spec
        .params
        .get("dataset_content_hashes")
        .and_then(|v| v.as_object())
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let mut row_artifacts: Vec<(Uuid, String)> = Vec::new();
    for artifact_id in row_bindings(&bindings) {
        let (content_hash, _, _) = artifact_row(pool, artifact_id).await?.ok_or_else(|| {
            creator_error(format!(
                "the artifact bound at slot {ROWS_SLOT:?} ({artifact_id}) is no longer in the \
                 catalog, so the relay that ties a slot ordinal to a dataset identity cannot \
                 be checked"
            ))
        })?;
        row_artifacts.push((artifact_id, content_hash));
    }
    cross_check_row_bindings(&dataset_ids, &hashes, &row_artifacts)?;

    let items = plan_gathers(&plan, &bindings)?;

    // ── the virtual dataset row ─────────────────────────────────────────────────────────
    let name = format!(
        "Integrated: {}",
        plan.source_dataset_ids()
            .iter()
            .take(4)
            .cloned()
            .collect::<Vec<_>>()
            .join(" + ")
    );
    let metadata = json!({
        "alignment_run_id": run_id.to_string(),
        "alignment": {
            "artifact_id": alignment.id.to_string(),
            "key_column": plan.key_column,
            "n_rows": plan.n_rows,
            "n_entities": plan.n_entities,
            "source_dataset_ids": plan.source_dataset_ids(),
        }
    });
    let new_dataset = Uuid::new_v4();
    // A2: stamp the run owner's personal account (behaviour-preserving; DEC-7).
    let account_id =
        crate::modules::account::scope::ensure_personal_account_for(pool, job.owner_id).await?;
    // Optimistic insert: the partial unique index on `(metadata->>'alignment_run_id')` is
    // the idempotency guard (migration `202608040005`), so the boot re-finalize's second
    // pass loses the race rather than minting a second dataset. `ON CONFLICT DO NOTHING`
    // turns that loss into the `AlreadyCreated` answer.
    let inserted = sqlx::query!(
        r#"INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id as "id: Uuid""#,
        new_dataset,
        name,
        job.owner_id,
        account_id,
        metadata,
        DATASET_SOURCE_INTEGRATE,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    let Some(inserted) = inserted else {
        let existing = existing_virtual_dataset(pool, run_id)
            .await?
            .ok_or_else(|| {
                creator_error(
                    "the virtual dataset insert conflicted but no `integrate` dataset carries \
                 this run's alignment_run_id — the conflict came from a constraint other \
                 than the per-run uniqueness index, so something else about the row is wrong",
                )
            })?;
        return Ok(Outcome::AlreadyCreated {
            dataset_id: existing,
        });
    };
    let dataset = inserted.id;
    attach_to_project(pool, project_id, dataset).await?;

    // ── the alignment's UNIFIED VOCABULARIES, read once ─────────────────────────────────
    //
    // `|unified_levels[column]|` is the only correct input to the gathered column's declared
    // width. It rides the alignment store's GROUP attributes rather than the artifact row
    // (`structure` travels into a manifest with a hard size cap, and a vocabulary truncated
    // there would be lost exactly where labels matter most), so reading it means reading one
    // `zarr.json` — a METADATA member, the same read `gather_exec::resolve` already makes for
    // the vocabulary itself. No array byte is opened, so INV-1 is untouched.
    //
    // **A failure here is not fatal and must not be.** The creator's job is to declare a
    // width; if the vocabulary cannot be read it declares the SOURCES' width, which is the
    // width the bytes actually are. Refusing to create the dataset over an unreadable
    // metadata member would trade a correct-but-unwidened column for no column at all.
    let vocabularies = read_unified_levels(pool, alignment.id).await;

    // ── PASS 1 — RESOLVE every column's declaration, and cross-check them, before a single
    //    row is written ─────────────────────────────────────────────────────────────────
    //
    // The resolve and the insert used to be one loop. Splitting them is what makes the axis
    // agreement a PRECONDITION rather than an observation: the shared axis spans EVERY
    // column (they are all the alignment's one row plane), so it cannot be decided from one
    // column, and a disagreement discovered at column 3 of 5 would otherwise leave two
    // gathered rows already inserted under an axis the creator then refused. A precondition
    // that has already written half its output is a report, not a precondition.
    let mut declarations: Vec<ColumnDeclaration> = Vec::with_capacity(items.len());
    let mut axis_claims: Vec<AxisClaim> = Vec::new();
    for item in &items {
        // The declared element type comes from the SOURCES, and every source must agree:
        // gathering a uint8 column against a utf8 one is not a narrowing, it is two
        // different decode contracts under one declaration.
        let mut data_type: Option<String> = None;
        let mut source_datatype: Option<String> = None;
        let mut member_kind: Option<String> = None;
        for (dataset_id, artifact_id) in &item.sources {
            let (_, structure, datatype) =
                artifact_row(pool, *artifact_id).await?.ok_or_else(|| {
                    creator_error(format!(
                        "source artifact {artifact_id} (dataset {dataset_id:?}) for column \
                     {:?} is not in the catalog",
                        item.alignment_column
                    ))
                })?;
            let declared = source_dtype(&structure, SOURCE_MEMBER).ok_or_else(|| {
                creator_error(format!(
                    "source artifact {artifact_id} (dataset {dataset_id:?}) declares no dtype \
                     for member {SOURCE_MEMBER:?} — neither `structure.columns[…].dtype` nor \
                     `structure.data_type` — so the gathered column would have to guess how \
                     to decode it. Declared structure: {structure}"
                ))
            })?;
            match &data_type {
                None => data_type = Some(declared),
                Some(first) if *first == declared => {}
                Some(first) => {
                    return Err(creator_error(format!(
                        "the sources of column {:?} declare different element types \
                         ({first:?} vs {declared:?}). One gathered declaration cannot \
                         describe both, and picking either serves the other's bytes decoded \
                         wrongly",
                        item.alignment_column
                    )))
                }
            }
            // The member KIND, carried and cross-checked exactly like the element type: a
            // client dispatches on it (`categorical` needs a level set, `string` needs the
            // split pair), so two sources disagreeing about it is two decode contracts under
            // one declaration — the same failure the dtype check refuses.
            let declared_kind = source_kind(&structure, SOURCE_MEMBER);
            match (&member_kind, &declared_kind) {
                (None, k) => member_kind = k.clone(),
                (Some(first), Some(k)) if first != k => {
                    return Err(creator_error(format!(
                        "the sources of column {:?} declare different member kinds \
                         ({first:?} vs {k:?}). A client dispatches on this field, so one \
                         declaration cannot describe both",
                        item.alignment_column
                    )))
                }
                _ => {}
            }
            // Carried from the sources for the same reason the element type is: a gathered
            // column is the same kind of thing as what it gathers, and core may not name a
            // contributed datatype id.
            match &source_datatype {
                None => source_datatype = Some(datatype),
                Some(first) if *first == datatype => {}
                Some(first) => {
                    return Err(creator_error(format!(
                        "the sources of column {:?} are of different datatypes ({first:?} vs \
                         {datatype:?}), so the gathered column has no single kind to declare",
                        item.alignment_column
                    )))
                }
            }
            // **THE SHARED AXIS KIND — the owner's rule, checked here.** *If we combine a
            // row space with another of the same kind, the axis becomes that kind. We cannot
            // combine one with something completely different.*
            //
            // Accumulated across EVERY source of EVERY column, in one variable, so the two
            // disagreements it must refuse are one comparison: two datasets contributing
            // different row spaces to one column, and two columns of one virtual dataset
            // landing on different planes. Both produce a dataset whose key column indexes
            // rows its other columns are not on — an axis index that indexes nothing, which
            // is invisible downstream because every count still agrees.
            axis_claims.push(AxisClaim {
                axis: source_axis(&structure),
                column: item.alignment_column.clone(),
                dataset_id: dataset_id.clone(),
                artifact_id: *artifact_id,
            });
        }
        let source_width = data_type.expect("plan_gathers refuses an item with no sources");
        // The SOURCES' width is right only for a column with no remap. For a fused column
        // the unified vocabulary is a union and can be wider than any source — see
        // `unified_code_dtype`, and `remap_codes`' `GATHER_LEVEL_CODE_TOO_WIDE` for what the
        // old behaviour did instead of failing.
        let data_type = match item.alignment_column.as_deref() {
            Some(column) => {
                unified_code_dtype(&plan, column, union_level_count(&vocabularies, column))
                    .unwrap_or(&source_width)
                    .to_string()
            }
            None => source_width.clone(),
        };
        let source_datatype =
            source_datatype.expect("plan_gathers refuses an item with no sources");
        declarations.push(ColumnDeclaration {
            data_type,
            member_kind,
            source_datatype,
        });
    }

    // The one axis every gathered column of this virtual dataset lives on — asked once, of
    // every claim, and REFUSED rather than defaulted.
    let axis = resolve_shared_axis(&axis_claims)?;

    // ── PASS 2 — one gathered artifact per column ───────────────────────────────────────
    let repo = CatalogRepository::new(pool.clone());
    let mut gathered: Vec<Uuid> = Vec::new();
    for (item, declaration) in items.iter().zip(declarations) {
        let ColumnDeclaration {
            data_type,
            member_kind,
            source_datatype,
        } = declaration;

        let source_ids: Vec<String> = item.sources.iter().map(|(d, _)| d.clone()).collect();
        let selector = item.definition_selector(&plan.key_column);
        let definition =
            definition_content_hash(&alignment.id.to_string(), &source_ids, &selector)?;

        let row = repo
            .insert_artifact(&NewArtifact {
                project_id: None,
                dataset_id: Some(dataset),
                run_id: Some(run_id),
                output_id: item.output_id.clone(),
                // The SOURCES' own datatype, carried through. A gathered column is the
                // same KIND of thing as the columns it gathers, so naming one here would
                // both hardcode a contributed id in core and be a guess; taking it from the
                // sources is neither.
                datatype: source_datatype.clone(),
                // NULL — a gathered artifact has no bytes (ITEM-16). The
                // `artifacts_bytes_or_recipe` CHECK is what makes the pair exclusive.
                object_key: None,
                is_multifile: false,
                // The DEFINITION hash, not a byte hash: a fused column has no bytes of its
                // own, and this is what makes an `immutable` response header true across a
                // re-emission of the same definition.
                content_hash: format!("sha256:{definition}"),
                structure: gathered_structure(
                    &data_type,
                    member_kind.as_deref(),
                    &axis,
                    plan.n_rows,
                    // **THE IDENTITY THIS ROW PINS.** The KEY column (the `rows` gather, the
                    // one item with no `alignment_column`) is the artifact that CARRIES the
                    // unified axis; every fused column merely lives on it. Both name the same
                    // digest — the alignment's own `structure.key_sequence_digest` — which is
                    // exactly the two-sided relation `verify_leaf_digest` reads.
                    //
                    // `Unpinned` when the alignment declared no digest: a virtual dataset built
                    // on an unpinned alignment has no identity to pass on, and minting one from
                    // (say) the definition hash would produce a value that compares equal to
                    // nothing and unequal to nothing — a check-shaped constant.
                    match (
                        plan.key_sequence_digest.as_deref(),
                        item.alignment_column.is_none(),
                    ) {
                        (Some(d), true) => KeyIdentity::Carries(d),
                        (Some(d), false) => KeyIdentity::AlignedTo(d),
                        (None, _) => KeyIdentity::Unpinned,
                    },
                    json!({
                        "alignment_artifact_id": alignment.id,
                        "column_selector": SOURCE_MEMBER,
                        "alignment_column": item.alignment_column,
                        "sources": item.sources.iter().map(|(d, a)| json!({
                            "dataset_id": d, "artifact_id": a
                        })).collect::<Vec<_>>(),
                    }),
                ),
                meta: json!({
                    "definition_content_hash": definition,
                    "alignment_artifact_id": alignment.id.to_string(),
                    "display_name": item.alignment_column.clone().unwrap_or_else(|| plan.key_column.clone()),
                    // **The key column DECLARES that it is the axis index (ITEM-8 / INV-3).**
                    // `resolve_axis_key_artifact` selects candidates on
                    // `meta.is_axis_index = true` + `structure.axis`, and it is a DECLARATION
                    // rather than a naming convention precisely so nothing has to infer it from
                    // an output_id. Without it a virtual dataset has a key column that nothing
                    // can find as the key of the axis it declares — the axis exists and is
                    // anonymous.
                    // `false`, not absent, on a fused column: the field is the answer to a
                    // question every gathered row is asked, and absence would read as "nobody
                    // said", which is the state this pair exists to eliminate.
                    "is_axis_index": item.alignment_column.is_none(),
                }),
                role: "artifact".to_string(),
                // 0 is the TRUE storage answer, not a residue: a gathered column writes
                // no blob, so zero bytes reach the object store. The export cap reads
                // this and is right to.
                stored_bytes: 0,
                // …and the served plane is `n × item_size`, which is what every consumer
                // asking "how big is this" wants. It used to be absent, so those
                // consumers read the 0 above and rendered `Size: 0 Bytes` beside
                // `Rows: 500000`. `None` where no element width is derivable (a split
                // string column's values are data-dependent) — unknown, never zero.
                logical_bytes: gathered_logical_bytes(&data_type, plan.n_rows),
                created_by: Some(job.owner_id),
                hidden: false,
                representation_of: None,
            })
            .await?;
        gathered.push(row.id);
    }

    Ok(Outcome::Created {
        dataset_id: dataset,
        gathered,
    })
}

// ═══════════════════════════════ the FILTER creation path (ITEM-13) ═══════════════════════════
//
// The mirror of `create_for_run` for a filter run: a run emits ONE marked keep-mask
// artifact, and the sink mints a `source='filter'` virtual dataset that reads the SINGLE source
// dataset through that hidden per-source mask (§11.3 / DEC-6). Integration and filtering are
// DISTINCT paths (§11.3): this NEVER reads an alignment, and `create_for_run` never reads a mask.

/// What one run's filter-finalize did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterOutcome {
    /// The run emitted no marked keep-mask — the overwhelmingly common case.
    NotAFilterRun,
    /// A filter virtual dataset for this run already exists (the boot re-finalize's second pass;
    /// the partial unique index `datasets_one_per_filter_run` is what makes this rather than a
    /// duplicate).
    AlreadyCreated { dataset_id: Uuid },
    Created {
        dataset_id: Uuid,
        mask: Uuid,
        gathered: Vec<Uuid>,
    },
}

/// The filter virtual dataset already created for this run, if any (the idempotency read the
/// `datasets_one_per_filter_run` index backs).
async fn existing_filter_dataset(
    pool: &SqlitePool,
    run_id: Uuid,
) -> Result<Option<Uuid>, AppError> {
    // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
    let bind_run_id_str2 = run_id.to_string();
    let row = sqlx::query!(
        r#"SELECT id as "id: Uuid" FROM datasets WHERE source = $1 AND json_extract(metadata, '$.filter_run_id') = $2"#,
        DATASET_SOURCE_FILTER,
        bind_run_id_str2,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    Ok(row.map(|r| r.id))
}

/// One artifact's owning `dataset_id`, whatever its status.
async fn artifact_dataset_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Uuid>, AppError> {
    let row = sqlx::query!(r#"SELECT dataset_id as "dataset_id?: Uuid" FROM artifacts WHERE id = $1"#, id)
        .fetch_optional(pool)
        .await
        .map_err(AppError::database_error)?;
    Ok(row.and_then(|r| r.dataset_id))
}

/// **Which dataset did this filter run filter?** The source is the dataset that OWNS the count
/// matrix the run read — the `expression` input's artifact `dataset_id`. Falls back to the FIRST
/// artifact-backed input (every input of a filter run comes from the one source dataset). This is
/// the channel the mask's `meta.sources[]` is then stamped from, so the VD's source, the detach
/// guard and the cascade all agree.
async fn filter_source_dataset(
    pool: &SqlitePool,
    bindings: &[(String, Uuid)],
) -> Result<Option<Uuid>, AppError> {
    let candidate = bindings
        .iter()
        .find(|(slot, _)| slot == EXPRESSION_SLOT)
        .or_else(|| bindings.first());
    match candidate {
        Some((_, artifact_id)) => artifact_dataset_id(pool, *artifact_id).await,
        None => Ok(None),
    }
}

/// **Is this source artifact a gatherable COLUMN or MATRIX?** `Some(is_sparse)` when it is one of
/// the two servable shapes; `None` for anything else (an opaque report), which the sink skips
/// rather than minting an unservable gathered row.
///
/// * `sparse_csc` — the expression matrix, served per-column through `resolve_masked_sparse_column`.
/// * a column — declares a singular `structure.axis` (a `metadata-column`).
fn source_gather_kind(structure: &serde_json::Value) -> Option<bool> {
    if structure.get("kind").and_then(|k| k.as_str()) == Some("sparse_csc") {
        return Some(true);
    }
    source_axis(structure).map(|_| false)
}

/// **The filter creator proper.** Mints a `source='filter'` virtual dataset over ONE source read
/// through the run's hidden per-source mask.
pub async fn create_filter_vd_for_run(
    pool: &SqlitePool,
    job: &Job,
) -> Result<FilterOutcome, AppError> {
    let run_id = job.run_id.unwrap_or(job.id);
    let (project_id, dataset_id) =
        match crate::modules::jobs::repository::JobRepository::job_scope(pool, job.id).await? {
            Some(scope) => scope.split(),
            None => (None, None),
        };

    // The no-op gate: is there a marked keep-mask among this run's outputs?
    let produced = run_artifacts(pool, project_id, dataset_id, run_id).await?;
    let Some(mask) = filter_mask_of(&produced) else {
        return Ok(FilterOutcome::NotAFilterRun);
    };

    // Idempotency: the boot re-finalize's second pass repairs the project link and returns.
    if let Some(existing) = existing_filter_dataset(pool, run_id).await? {
        attach_to_project(pool, project_id, existing).await?;
        return Ok(FilterOutcome::AlreadyCreated {
            dataset_id: existing,
        });
    }

    let spec = AnalysisSpec::parse(&job.params)?;
    let bindings = artifact_bindings(&spec);
    let source = filter_source_dataset(pool, &bindings)
        .await?
        .ok_or_else(|| {
            creator_error(
                "a filter run emitted a marked keep-mask but bound no artifact input the source \
             dataset can be read from (no `expression` slot, no artifact-backed input). The mask \
             records its source from that binding, so without it the virtual dataset's source is \
             unknowable and the detach guard would have nothing to protect",
            )
        })?;

    // The name is the RUN LABEL (DEC-6) — the string the filter run records on the mask's marker —
    // falling back to a source-derived name when the label is blank.
    let name = filter_mask_label(&mask.meta).unwrap_or_else(|| format!("Filtered: {source}"));

    let metadata = json!({
        "filter_run_id": run_id.to_string(),
        "filter": {
            "source_dataset_id": source.to_string(),
            "mask_artifact_id": mask.id.to_string(),
        }
    });
    let new_dataset = Uuid::new_v4();
    // A2: stamp the run owner's personal account (behaviour-preserving; DEC-7).
    let account_id =
        crate::modules::account::scope::ensure_personal_account_for(pool, job.owner_id).await?;
    let inserted = sqlx::query!(
        r#"INSERT INTO datasets (id, name, owner_id, account_id, datatype, metadata, source)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id as "id: Uuid""#,
        new_dataset,
        name,
        job.owner_id,
        account_id,
        metadata,
        DATASET_SOURCE_FILTER,
    )
    .fetch_optional(pool)
    .await
    .map_err(AppError::database_error)?;
    let Some(inserted) = inserted else {
        // Lost the idempotency race (the `datasets_one_per_filter_run` index). Re-read + report.
        let existing = existing_filter_dataset(pool, run_id)
            .await?
            .ok_or_else(|| {
                creator_error(
                "the filter dataset insert conflicted but no `filter` dataset carries this run's \
                 filter_run_id — the conflict came from a constraint other than the per-run \
                 uniqueness index, so something else about the row is wrong",
            )
            })?;
        return Ok(FilterOutcome::AlreadyCreated {
            dataset_id: existing,
        });
    };
    let dataset = inserted.id;
    attach_to_project(pool, project_id, dataset).await?;

    // Hand the mask to the VD: `dataset_id=VD`, `role='mask'`, `hidden`, recording its source (the
    // `ON DELETE CASCADE` on `dataset_id` is what makes deleting the VD remove the mask).
    let repo = CatalogRepository::new(pool.clone());
    if !repo
        .bind_mask_to_dataset(mask.id, dataset, &source.to_string())
        .await?
    {
        return Err(creator_error(format!(
            "the produced keep-mask {} could not be bound to the virtual dataset {dataset} — it \
             is not a stored artifact (no object_key), so it is not a mask this can own",
            mask.id
        )));
    }

    // ── one gathered column per SOURCE column/matrix, read through the mask (§3.4, INV-33) ─────
    let mask_len = declared_row_count(&mask.structure);
    let mask_axis = source_axis(&mask.structure);
    let source_arts = repo.list_usable_by_dataset(source).await?;

    // **Is the mask's length AMBIGUOUS across axes?** (INV-10, P1.) The mask normally selects the
    // ONE axis whose declared length equals it — but if two DECLARED axes share that length (the
    // `n_rows == n_cols` coincidence), length alone cannot say which is the row axis, and a
    // column-axis `var` member would be filtered by a row mask: right row count, wrong axis, and
    // the serve path's own length backstop cannot catch it because the lengths agree. ONLY in that
    // ambiguous case is the declared axis used to disambiguate; when a single axis matches by
    // length (the universal real-world case, `n_rows != n_cols`) behaviour is byte-identical to
    // pure length matching, preserving the documented robustness to a producer that spells the
    // axis differently on the mask and the column.
    let length_ambiguous = mask_len.is_some() && {
        let mut declared_axes = std::collections::HashSet::new();
        for s in &source_arts {
            if source_gather_kind(&s.structure).is_some()
                && declared_row_count(&s.structure) == mask_len
            {
                if let Some(ax) = source_axis(&s.structure) {
                    declared_axes.insert(ax);
                }
            }
        }
        declared_axes.len() > 1
    };

    let mut gathered: Vec<Uuid> = Vec::new();
    for s in &source_arts {
        let Some(is_sparse) = source_gather_kind(&s.structure) else {
            continue; // an opaque/non-column artifact — nothing to gather
        };
        let n = declared_row_count(&s.structure).unwrap_or(0);
        // The mask indexes the source's masked rows: it applies to an artifact whose declared row
        // length equals the mask's (INV-1). An off-axis (e.g. column-axis) member is gathered as an
        // IDENTITY passthrough — absence of `mask_artifact_id` encodes identity (INV-11). When the
        // length is AMBIGUOUS (INV-10, above), a source that DECLARES an axis differing from the
        // mask's is off-axis and excluded; a source with no declared axis (the sparse matrix,
        // whose axis is its shape rather than a label) still rides on length.
        let on_length = mask_len.is_some() && declared_row_count(&s.structure) == mask_len;
        let mask_applies = on_length
            && (!length_ambiguous
                || match (source_axis(&s.structure), mask_axis.as_deref()) {
                    (Some(a), Some(m)) => a.as_str() == m,
                    _ => true,
                });

        let mut gathered_from = json!({
            "alignment_artifact_id": null,
            "column_selector": SOURCE_MEMBER,
            "alignment_column": null,
            "sources": [ { "dataset_id": source.to_string(), "artifact_id": s.id } ],
        });
        if mask_applies {
            gathered_from["mask_artifact_id"] = json!(mask.id);
        }

        let structure = if is_sparse {
            // A matrix keeps its OWN declaration (kind/shape/member names) — the masked sparse
            // serve reads its members through the recipe; only the recipe is injected.
            let mut st = s.structure.clone();
            if let Some(obj) = st.as_object_mut() {
                obj.insert("gathered_from".to_string(), gathered_from);
            }
            st
        } else {
            // A column is declared through the same helper the alignment path uses, so the serve
            // path reads its top-level `data_type` and member kind. A filter carries no alignment
            // digest, so the identity is Unpinned — a masked key sequence has a digest nobody
            // computed (the carried-flag note in PLAN ITEM-13; Stage B's length + id guard holds).
            let data_type =
                source_dtype(&s.structure, SOURCE_MEMBER).unwrap_or_else(|| "float32".to_string());
            let member_kind = source_kind(&s.structure, SOURCE_MEMBER);
            let axis = source_axis(&s.structure).unwrap_or_default();
            gathered_structure(
                &data_type,
                member_kind.as_deref(),
                &axis,
                n,
                KeyIdentity::Unpinned,
                gathered_from,
            )
        };

        let logical_bytes = source_dtype(&s.structure, SOURCE_MEMBER)
            .as_deref()
            .and_then(|dt| gathered_logical_bytes(dt, n));

        // A deterministic definition hash keys the chunk cache and makes the `immutable` header
        // honest across a re-emission (a gathered artifact owns no bytes to hash).
        let definition =
            definition_content_hash(&mask.id.to_string(), &[s.id.to_string()], &s.output_id)?;
        let mut meta = match s.meta.clone() {
            serde_json::Value::Object(m) => serde_json::Value::Object(m),
            _ => json!({}),
        };
        if let Some(obj) = meta.as_object_mut() {
            obj.insert("definition_content_hash".to_string(), json!(definition));
        }

        let row = repo
            .insert_artifact(&NewArtifact {
                project_id: None,
                dataset_id: Some(dataset),
                run_id: Some(run_id),
                output_id: s.output_id.clone(),
                datatype: s.datatype.clone(),
                object_key: None,
                is_multifile: false,
                content_hash: format!("sha256:{definition}"),
                structure,
                meta,
                role: "artifact".to_string(),
                stored_bytes: 0,
                logical_bytes,
                created_by: Some(job.owner_id),
                hidden: false,
                representation_of: None,
            })
            .await?;
        gathered.push(row.id);
    }

    Ok(FilterOutcome::Created {
        dataset_id: dataset,
        mask: mask.id,
        gathered,
    })
}

// ═══════════════════ compute against a virtual dataset — the input-staging contract (ITEM-14) ══
//
// A processor run against a filtered/integrated VD receives the MASK (nullable) + the ALIGNMENT
// (nullable) + the already-mounted SOURCES — metadata into the sandbox, never a materialised
// merged matrix (INV-32, §3.5). This resolves that set from the VD's gathered columns' recipes so
// the run stager mounts index vectors (~MB) beside the source matrices, and the processor branches
// on which are present. It does NOT re-derive the join (INV-3) and mounts NO new matrix-sized
// artifact the sources did not already provide (INV-32).

/// The metadata a compute against a virtual dataset consumes (§3.5): the source artifacts it reads
/// directly, plus the row-selection/join index vectors it applies. NO merged matrix — every
/// `sources[]` id is a STORED artifact the source dataset already provides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VdComputeInputs {
    /// The SOURCE artifacts (already-mounted matrices/columns), de-duplicated. For a filter VD
    /// this is the single source's columns; for an integration, every source of the alignment.
    pub sources: Vec<Uuid>,
    /// The per-source mask, when the VD is filtered (`None` for a pure integration — INV-11).
    pub mask: Option<Uuid>,
    /// The alignment, when the VD is integrated (`None` for a lone-source filter — the mask is
    /// the whole selection, and there is no join to be the authority over).
    pub alignment: Option<Uuid>,
}

/// **Resolve a virtual dataset's compute inputs (ITEM-14).** Reads the VD's gathered columns (the
/// recipe rows, `object_key IS NULL`) and unions their `sources[]` + `mask_artifact_id` +
/// `alignment_artifact_id`. A real dataset (no gathered rows) resolves to `{sources: [], mask:
/// None, alignment: None}` — the identity case: it stages its own artifacts directly, with no mask
/// and no alignment to apply.
pub async fn resolve_vd_compute_inputs(
    pool: &SqlitePool,
    vd_dataset_id: Uuid,
) -> Result<VdComputeInputs, AppError> {
    let rows = sqlx::query!(
        r#"SELECT structure as "structure: serde_json::Value"
           FROM artifacts
           WHERE dataset_id = $1 AND object_key IS NULL"#,
        vd_dataset_id,
    )
    .fetch_all(pool)
    .await
    .map_err(AppError::database_error)?;

    let mut sources: std::collections::BTreeSet<Uuid> = std::collections::BTreeSet::new();
    let mut mask: Option<Uuid> = None;
    let mut alignment: Option<Uuid> = None;
    for r in &rows {
        // Only a gathered row carries a recipe; a stored row owned by the VD (a mask, or a
        // compute output attached later) has no `gathered_from` and `parse` is not called on it.
        if !r.structure.get("gathered_from").is_some() {
            continue;
        }
        let recipe = GatheredFrom::parse(&r.structure)?;
        for s in &recipe.sources {
            sources.insert(s.artifact_id);
        }
        if let Some(m) = recipe.mask_artifact_id {
            mask = Some(m);
        }
        if let Some(a) = recipe.alignment_artifact_id {
            alignment = Some(a);
        }
    }
    Ok(VdComputeInputs {
        sources: sources.into_iter().collect(),
        mask,
        alignment,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    // ══════════════════════════════════════════════════════════════════════════
    //  #149 — the gathered axis is the SOURCES' SHARED KIND, carried through
    // ══════════════════════════════════════════════════════════════════════════

    /// The axis a scene's sources declare. A LOCAL fixture value, deliberately not a
    /// production constant: the whole point of this change is that core names no axis, so a
    /// `const` here that the creator also read would re-create the coupling in test clothing.
    const SOURCE_SCENE_AXIS: &str = "entries";

    fn claim(axis: Option<&str>, column: Option<&str>) -> AxisClaim {
        AxisClaim {
            axis: axis.map(str::to_string),
            column: column.map(str::to_string),
            dataset_id: "ds".to_string(),
            artifact_id: Uuid::nil(),
        }
    }

    /// **The axis comes off the SOURCE's declaration — `axis`, or a one-entry `axes`.**
    #[test]
    fn a_sources_axis_is_read_from_its_declaration() {
        assert_eq!(
            source_axis(&json!({ "kind": "table", "axis": "cells" })),
            Some("cells".to_string())
        );
    }

    /// **A PLURAL `axes` declaration is not narrowed to one — at any length.**
    ///
    /// A matrix declares `axes: [rows, columns]`. Taking an element would be this side
    /// deciding by POSITION which of a producer's axes a gathered column runs along — a
    /// decision that is invisible when wrong, because every candidate is a real axis of a
    /// real artifact. The single-entry case is refused too: a collection promises nothing
    /// about its length either, and "it happened to have one" is still an index.
    #[test]
    fn a_plural_axes_declaration_is_not_narrowed_to_one() {
        assert_eq!(source_axis(&json!({ "axes": ["a", "b"] })), None);
        assert_eq!(source_axis(&json!({ "axes": ["a"] })), None);
        assert_eq!(source_axis(&json!({ "axis": "" })), None);
        assert_eq!(source_axis(&json!({ "kind": "table" })), None);
    }

    /// **The declared axis is the argument's value — there is no constant behind it.**
    ///
    /// Two calls differing ONLY in the axis must produce two different declarations, on the
    /// store AND on the member. This is the assertion a re-introduced
    /// `const GATHERED_AXIS` would fail: the old code stamped one literal on both fields
    /// regardless of what its sources said, and every consumer matches on that literal.
    #[test]
    fn the_gathered_declaration_carries_the_axis_it_is_given() {
        let cells = gathered_structure("uint8", None, "cells", 3, KeyIdentity::Unpinned, json!({}));
        let genes = gathered_structure("uint8", None, "genes", 3, KeyIdentity::Unpinned, json!({}));
        assert_eq!(cells["axis"], json!("cells"));
        assert_eq!(cells["columns"][0]["axis"], json!("cells"));
        assert_eq!(genes["axis"], json!("genes"));
        assert_eq!(genes["columns"][0]["axis"], json!("genes"));
        assert_ne!(cells["axis"], genes["axis"]);
    }

    /// **Agreeing sources yield their own kind — not a new name for the pair.**
    #[test]
    fn sources_that_agree_give_the_virtual_dataset_their_axis() {
        let axis = resolve_shared_axis(&[
            claim(Some("cells"), None),
            claim(Some("cells"), Some("batch")),
            claim(Some("cells"), Some("batch")),
        ])
        .expect("agreeing sources resolve");
        assert_eq!(axis, "cells");
    }

    /// **A MISMATCH is refused — the owner's rule, and the reason a rename alone is not the
    /// fix.**
    ///
    /// *"We cannot combine cells with something completely different."* Inventing a name for
    /// the pair (which is what `unified_rows` did) makes such a combination REPRESENTABLE:
    /// it produces a virtual dataset whose key column indexes one row space while its other
    /// columns are on another, with every count still agreeing.
    #[test]
    fn sources_on_different_axes_are_refused() {
        let err = resolve_shared_axis(&[claim(Some("cells"), None), claim(Some("genes"), None)])
            .expect_err("two row spaces are not one integration");
        let message = format!("{err:?}");
        assert!(
            message.contains("cells") && message.contains("genes"),
            "the refusal must name BOTH axes, or it is not actionable: {message}"
        );
    }

    /// **Cross-COLUMN disagreement is the same refusal**, not a separate case that could be
    /// implemented for one and forgotten for the other: the key column and every fused
    /// column are one row plane by construction.
    #[test]
    fn columns_landing_on_different_axes_are_refused() {
        resolve_shared_axis(&[
            claim(Some("cells"), None),
            claim(Some("cells"), Some("batch")),
            claim(Some("genes"), Some("symbol")),
        ])
        .expect_err("the key column and a fused column on different planes is not a dataset");
    }

    /// **A source that declares NOTHING does not agree with one that does**, and an entirely
    /// silent set is refused rather than defaulted. A minted label is exactly what this
    /// change removed, so falling back to one on absence would restore the defect through
    /// the error path.
    #[test]
    fn an_undeclared_axis_is_refused_not_defaulted() {
        resolve_shared_axis(&[claim(Some("cells"), None), claim(None, Some("batch"))])
            .expect_err("silence is not agreement");
        resolve_shared_axis(&[claim(None, None)]).expect_err("nothing declared, nothing to carry");
        resolve_shared_axis(&[]).expect_err("no sources at all");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  #145 — the LOGICAL size of a gathered column
    // ══════════════════════════════════════════════════════════════════════════

    /// **The logical size is rows × element width, and it is not the stored size.**
    ///
    /// The stored size of a gathered column is 0 (it owns no blob) and that is correct.
    /// This asserts the OTHER quantity exists and is non-zero for the same row, because
    /// a consumer asking "how big is this data" reading the 0 is the whole defect.
    #[test]
    fn a_gathered_columns_logical_size_is_rows_times_element_width() {
        assert_eq!(gathered_logical_bytes("uint8", 5), Some(5));
        assert_eq!(gathered_logical_bytes("float64", 500_000), Some(4_000_000));
        assert_eq!(gathered_logical_bytes("int32", 1_000), Some(4_000));
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  #149(3) — the axis identity a gathered column declares
    // ══════════════════════════════════════════════════════════════════════════

    fn structure_with(identity: KeyIdentity<'_>) -> Value {
        gathered_structure(
            "uint8",
            Some("categorical"),
            SOURCE_SCENE_AXIS,
            3,
            identity,
            json!({}),
        )
    }

    /// **The two sides of the relation land in DIFFERENT fields, and never both.**
    ///
    /// `verify_leaf_digest` reads `key_sequence_digest` first and falls back to `aligned_to`,
    /// so a row emitting both would have its contradiction resolved silently by lookup order.
    /// This is the assertion that would fail if the match arms were ever merged into "set both,
    /// it's the same digest anyway" — which is the tempting simplification.
    #[test]
    fn carrying_an_axis_and_living_on_one_are_different_declarations() {
        let carries = structure_with(KeyIdentity::Carries("sha256:unified"));
        assert_eq!(carries["key_sequence_digest"], "sha256:unified");
        assert!(carries["aligned_to"].is_null());

        let aligned = structure_with(KeyIdentity::AlignedTo("sha256:unified"));
        assert_eq!(aligned["aligned_to"], "sha256:unified");
        assert!(aligned["key_sequence_digest"].is_null());
    }

    /// **Unpinned emits NEITHER field — it does not emit an empty string.**
    ///
    /// `plan_chain` filters an identity on `!d.is_empty()` precisely because a present-but-empty
    /// digest reads as "pinned" to a naive check. Writing `""` here would satisfy a test that
    /// only asserted the key exists, and would then compare unequal to every real digest —
    /// turning "no identity" into "wrong identity", which is a different and worse refusal.
    #[test]
    fn an_unpinned_alignment_yields_no_identity_field_rather_than_an_empty_one() {
        let s = structure_with(KeyIdentity::Unpinned);
        assert!(s["key_sequence_digest"].is_null(), "{s}");
        assert!(s["aligned_to"].is_null(), "{s}");
        assert!(
            !s.as_object().unwrap().contains_key("key_sequence_digest"),
            "absent, not present-and-null: {s}"
        );
    }

    /// The identity is ADDITIVE — it does not disturb the declaration the byte plane reads.
    /// `gathered_fixture_test` pins those bytes; this pins that adding a field did not move them.
    #[test]
    fn stamping_an_identity_leaves_the_store_declaration_untouched() {
        let mut with = structure_with(KeyIdentity::Carries("sha256:unified"));
        with.as_object_mut().unwrap().remove("key_sequence_digest");
        assert_eq!(with, structure_with(KeyIdentity::Unpinned));
    }

    /// **A dtype with no derivable width answers UNKNOWN, not zero.**
    ///
    /// This is the case the `Option` exists for. `item_size` refuses a width it cannot
    /// know rather than guessing one; a size built on a refused width would be exactly
    /// the fabricated number this change removes, and `Some(0)` would reintroduce
    /// `Size: 0 Bytes` through the back door for split string columns.
    #[test]
    fn an_unsizable_dtype_is_unknown_rather_than_zero() {
        assert_eq!(gathered_logical_bytes("utf8", 500_000), None);
        assert_eq!(gathered_logical_bytes("complex128", 10), None);
    }

    /// **An empty column is a KNOWN zero, and stays distinguishable from unknown.**
    ///
    /// `Some(0)` and `None` must not collapse: one says "this column has no rows", the
    /// other says "nobody can say". Rendering them the same way is the confusion one
    /// level up from the one being fixed.
    #[test]
    fn zero_rows_is_a_known_zero_not_an_unknown() {
        assert_eq!(gathered_logical_bytes("uint8", 0), Some(0));
        assert_ne!(gathered_logical_bytes("uint8", 0), None);
    }

    /// **An overflowing product is UNKNOWN, not a wrapped number.**
    ///
    /// `n × item` is multiplication on sizes that arrive from a declaration. A wrap
    /// would produce a small, plausible, wrong figure — the failure mode this whole
    /// change is about — so it answers `None`.
    #[test]
    fn an_overflowing_product_is_unknown_rather_than_wrapped() {
        assert_eq!(gathered_logical_bytes("float64", usize::MAX), None);
    }

    /// A minimal alignment `structure`/`meta` pair with `n` sources and the named fused
    /// columns. Built here rather than loaded from a fixture because these tests are about
    /// the CREATOR's resolution, not about the producer's wire shape (the fixture drift test
    /// owns that) — and because a fixture cannot be made to have three sources on demand.
    fn alignment(n: usize, columns: &[&str]) -> (Value, Value) {
        alignment_with_levels(n, columns, 2)
    }

    /// The same, with each source's level-lookup EXTENT set explicitly — which is the only
    /// input `unified_code_dtype` reads, and the thing every fixture in this tree pins at a
    /// value so small (5 across all sources) that no width boundary is reachable.
    fn alignment_with_levels(n: usize, columns: &[&str], n_levels: usize) -> (Value, Value) {
        const N_ENTITIES: usize = 3;
        let n_levels = n_levels;
        let mut aux = vec![
            // D18 (ITEM-11): the alignment carries only the per-SEGMENT vectors; the per-row
            // `row_source`/`row_segment` members were dropped (positions reconstruct from the
            // segment table).
            json!({"path":"seg_ds","role":"alignment_segment_dataset","dtype":"uint32","shape":[n],"extent":["segments"]}),
            json!({"path":"seg_start","role":"alignment_segment_start","dtype":"uint32","shape":[n],"extent":["segments"]}),
            json!({"path":"seg_end","role":"alignment_segment_end","dtype":"uint32","shape":[n],"extent":["segments"]}),
            json!({"path":"seg_order","role":"alignment_segment_order","dtype":"uint32","shape":[n],"extent":["segments"]}),
            json!({"path":"entity_index","role":"alignment_entity_index","dtype":"uint32","shape":[N_ENTITIES],"extent":["unified_entities"]}),
        ];
        let mut extents = serde_json::Map::new();
        extents.insert("segments".into(), json!(n));
        extents.insert("sources".into(), json!(n));
        extents.insert("unified_entities".into(), json!(N_ENTITIES));
        for c in columns {
            for i in 0..n {
                aux.push(json!({
                    "path": format!("levels__{c}__{i}"),
                    "role": "alignment_level_lookup",
                    "dtype": "int32",
                    "shape": [n_levels],
                    "extent": [format!("levels_{c}_{i}")],
                }));
                extents.insert(format!("levels_{c}_{i}"), json!(n_levels));
            }
        }
        let structure = json!({
            "kind": "table",
            "axis": "unified_entities",
            "n": N_ENTITIES,
            "key": "unified_key",
            "columns": ["unified_key"],
            "arrays": [],
            "aux": aux,
            "extents": extents
        });
        let sources: Vec<Value> = (0..n)
            .map(|i| json!({"dataset_id": format!("ds-{i}"), "n_rows": 2}))
            .collect();
        (structure, json!({ "sources": sources }))
    }

    fn plan_of(n: usize, columns: &[&str]) -> AlignmentPlan {
        let (s, m) = alignment(n, columns);
        AlignmentPlan::parse(&s, &m).expect("the test alignment must parse")
    }

    fn bindings(n: usize, columns: &[&str]) -> Vec<(String, Uuid)> {
        let mut out: Vec<(String, Uuid)> = Vec::new();
        for i in 0..n {
            out.push((ROWS_SLOT.to_string(), Uuid::new_v4()));
            for c in columns {
                out.push((level_slot(i, c), Uuid::new_v4()));
            }
        }
        out
    }

    /// nc: drop `alignment_column` from the recipe (or key it on the member path) and this
    /// goes red. It is the assertion standing between the creator and CRITICAL-2.
    #[test]
    fn every_fused_column_carries_the_alignments_name_and_not_the_member_path() {
        let plan = plan_of(2, &["group", "donor"]);
        let items = plan_gathers(&plan, &bindings(2, &["group", "donor"])).unwrap();
        let fused: Vec<&GatherPlanItem> = items
            .iter()
            .filter(|i| i.alignment_column.is_some())
            .collect();
        assert_eq!(fused.len(), 2, "one gather per fused column");
        for item in fused {
            let column = item.alignment_column.as_deref().unwrap();
            assert!(
                column == "group" || column == "donor",
                "the recipe's alignment_column must be the ALIGNMENT's name for the column; \
                 got {column:?}"
            );
            assert_ne!(
                column, SOURCE_MEMBER,
                "the member path is the constant {SOURCE_MEMBER:?} for every column — \
                 writing it as the alignment column makes every level lookup miss and \
                 serves each source's raw code space"
            );
        }
    }

    /// The key gather is the one item that legitimately has no alignment column.
    #[test]
    fn the_key_gather_declares_no_alignment_column() {
        let plan = plan_of(2, &["group"]);
        let items = plan_gathers(&plan, &bindings(2, &["group"])).unwrap();
        let keyed: Vec<&GatherPlanItem> = items
            .iter()
            .filter(|i| i.alignment_column.is_none())
            .collect();
        assert_eq!(keyed.len(), 1, "exactly one key gather");
        assert_eq!(keyed[0].sources.len(), 2);
    }

    /// **The three-source test, and why two would not do.** With two sources every mapping
    /// between the source dimension and anything else is its own inverse, so a creator that
    /// reversed the order would pass. Three sources make the order observable.
    #[test]
    fn sources_are_resolved_in_source_index_order_and_three_makes_that_observable() {
        let plan = plan_of(3, &["group"]);
        let b = bindings(3, &["group"]);
        let items = plan_gathers(&plan, &b).unwrap();
        let fused = items.iter().find(|i| i.alignment_column.is_some()).unwrap();
        let expected: Vec<(String, Uuid)> = (0..3)
            .map(|i| {
                let slot = level_slot(i, "group");
                (
                    format!("ds-{i}"),
                    b.iter().find(|(s, _)| *s == slot).unwrap().1,
                )
            })
            .collect();
        assert_eq!(
            fused.sources, expected,
            "source i's bytes must come from slot level:i:<column> — reversed or rotated, \
             every row of every source is attributed to a different dataset"
        );
    }

    /// A fused column whose level slot was never bound is a HOLE, and a hole served as a
    /// column is indistinguishable from data.
    #[test]
    fn a_fused_column_with_no_bound_source_is_refused_by_name() {
        let plan = plan_of(2, &["group"]);
        let mut b = bindings(2, &["group"]);
        b.retain(|(s, _)| *s != level_slot(1, "group"));
        let err = plan_gathers(&plan, &b).unwrap_err();
        let text = format!("{err:?}");
        assert!(
            text.contains("level:1:group"),
            "the refusal must name the missing SLOT: {text}"
        );
    }

    #[test]
    fn an_incomplete_rows_binding_set_is_refused() {
        let plan = plan_of(3, &["group"]);
        let mut b = bindings(3, &["group"]);
        // Drop one `rows` binding — the key column then has bytes for only two of three.
        let pos = b.iter().position(|(s, _)| s == ROWS_SLOT).unwrap();
        b.remove(pos);
        let err = plan_gathers(&plan, &b).unwrap_err();
        assert!(format!("{err:?}").contains("rows"), "{err:?}");
    }

    /// The definition selector is the ALIGNMENT's vocabulary — never the member path, which
    /// is one constant and would collapse every column of an alignment onto one cache key.
    #[test]
    fn the_definition_selector_distinguishes_columns_that_share_a_member_path() {
        let a = "00000000-0000-0000-0000-0000000000aa";
        let s = vec!["ds-0".to_string(), "ds-1".to_string()];
        let group =
            definition_content_hash(a, &s, &definition_selector(Some("group"), "k")).unwrap();
        let donor =
            definition_content_hash(a, &s, &definition_selector(Some("donor"), "k")).unwrap();
        let member = definition_content_hash(a, &s, SOURCE_MEMBER).unwrap();
        assert_ne!(
            group, donor,
            "two fused columns of one alignment must not share a definition hash — the chunk \
             cache is keyed on it, so a collision serves one column's bytes for the other"
        );
        assert_ne!(group, member);
        // …and the key gather uses the alignment's own key column, which is in the same
        // vocabulary and cannot collide with a fused column's name.
        assert_eq!(definition_selector(None, "unified_key"), "unified_key");
    }

    /// **Read the dtype off the REAL writer's stores, not off a structure this file wrote.**
    ///
    /// The first version of `source_dtype` looked for a top-level `structure.data_type`,
    /// which is this side's GATHERED vocabulary. Every hand-built fixture would have
    /// carried it and every real artifact would have returned `None` — the creator would
    /// then have refused every real run with a message about a field the producer has never
    /// written. It was caught by opening a committed store's `zarr.json` instead of
    /// trusting the field name, which is the same "ask the parser, not the doc" move that
    /// found every seam defect on this branch.
    ///
    /// nc: point `source_dtype` back at `data_type` only, and this goes red while every
    /// other test in the file stays green.
    #[test]
    fn the_source_dtype_is_read_off_the_real_writers_own_stores() {
        let sources = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/stage1_alignment/sources");
        // The two shapes the creator must tell apart: a categorical grid cell and the
        // split-string row axis. They are the emitter's own output, committed whole.
        for (store, expected) in [("level_0_group.zarr", "uint8"), ("rows.zarr", "utf8")] {
            let zarr: serde_json::Value = serde_json::from_slice(
                &std::fs::read(sources.join(store).join("zarr.json"))
                    .unwrap_or_else(|e| panic!("{store} must be readable: {e}")),
            )
            .expect("zarr.json parses");
            // `attributes.cyto` is verbatim what ingest records as the artifact's
            // `structure` — so this is the value the creator will really be handed.
            let structure = zarr
                .get("attributes")
                .and_then(|a| a.get("cyto"))
                .expect("a real store stamps attributes.cyto");
            assert!(
                structure.get("data_type").is_none(),
                "{store}: a real store carries NO top-level `data_type` — if that ever \
                 changes, the fallback in `source_dtype` becomes the primary path and this \
                 assertion is the place to reconsider it"
            );
            assert_eq!(
                source_dtype(structure, SOURCE_MEMBER).as_deref(),
                Some(expected),
                "{store}: the creator must read the dtype the producer actually declares"
            );
        }
    }

    #[test]
    fn a_missing_mount_record_and_an_empty_one_say_different_things() {
        let gone = check_mount_record(None, &[]).unwrap_err();
        let empty = check_mount_record(Some(&[]), &[]).unwrap_err();
        let (gone, empty) = (format!("{gone:?}"), format!("{empty:?}"));
        assert!(gone.contains("workspace"), "{gone}");
        assert!(empty.contains("producer"), "{empty}");
        assert_ne!(
            gone, empty,
            "`None` (no record) and `Some(vec![])` (no inputs) call for different actions, \
             so one message for both is wrong for half its readers every time it appears"
        );
    }

    #[test]
    fn a_slot_the_run_never_staged_is_refused() {
        let recorded = vec![("rows".to_string(), "rows.zarr".to_string())];
        let err = check_mount_record(Some(&recorded), &["rows".into(), "level:0:group".into()])
            .unwrap_err();
        assert!(format!("{err:?}").contains("level:0:group"), "{err:?}");
    }

    #[test]
    fn the_relay_cross_check_catches_a_swapped_row_binding() {
        let ids = vec!["ds-a".to_string(), "ds-b".to_string()];
        let hashes: BTreeMap<String, String> = [
            ("ds-a".to_string(), "sha256:aaa".to_string()),
            ("ds-b".to_string(), "sha256:bbb".to_string()),
        ]
        .into_iter()
        .collect();
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        cross_check_row_bindings(
            &ids,
            &hashes,
            &[(a, "sha256:aaa".into()), (b, "sha256:bbb".into())],
        )
        .expect("the aligned case must pass, or the refusal below proves nothing");
        let err = cross_check_row_bindings(
            &ids,
            &hashes,
            &[(b, "sha256:bbb".into()), (a, "sha256:aaa".into())],
        )
        .unwrap_err();
        assert!(format!("{err:?}").contains("disagree"), "{err:?}");
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  `unified_code_dtype` — the PREVENTION half, which shipped with NO tests
    // ══════════════════════════════════════════════════════════════════════════
    //
    // `remap_codes`' `GATHER_LEVEL_CODE_TOO_WIDE` guard got two unit tests. The prevention
    // its own comment defers to — *"the creator now sizes the gathered width from the unified
    // vocabulary … which is where the condition is PREVENTED"* — got none, and every
    // integration fixture's source-level SUM is 5, so no width boundary was reachable from
    // any test in the tree. That is why a regression here was invisible to 144 green
    // integration tests.

    /// **THE REGRESSION: the trigger was Σ(source level counts), not |union|.**
    ///
    /// Two sources of 130 levels each sum to 260 and were sized `uint16`, even when their
    /// union is small enough for `uint8` — which is the NORMAL case for a fusion feature,
    /// since heavy overlap is the reason to fuse. The declared width then exceeded the
    /// SOURCE bytes' width, and nothing converts them: `item` is derived from the gathered
    /// dtype and applied to a buffer at the source's width.
    #[test]
    fn two_heavily_overlapping_sources_are_not_widened_past_their_own_bytes() {
        let (structure, meta) = alignment_with_levels(2, &["donor"], 130);
        let plan = AlignmentPlan::parse(&structure, &meta).expect("plan");
        // The union is what the vocabulary actually holds; 130 + 130 = 260 is an upper bound
        // that is wrong whenever the sources overlap at all.
        let union = 140;
        assert_eq!(
            unified_code_dtype(&plan, "donor", Some(union)),
            Some("uint8"),
            "a 140-label union fits a byte. Sizing from the SUM declared uint16 over uint8 \
             source bytes, and nothing converts them"
        );
    }

    /// The genuine C1 case still widens — the guard this whole thing exists for.
    #[test]
    fn a_union_past_the_byte_boundary_is_widened() {
        let (structure, meta) = alignment_with_levels(2, &["donor"], 200);
        let plan = AlignmentPlan::parse(&structure, &meta).expect("plan");
        assert_eq!(
            unified_code_dtype(&plan, "donor", Some(257)),
            Some("uint16"),
            "257 distinct unified levels do NOT fit a byte — this is C1, and copying the \
             sources' uint8 here truncates 299 to 43, a real index to the WRONG label"
        );
        // The boundary, both sides. 256 levels are codes 0..=255, which a byte holds exactly.
        assert_eq!(unified_code_dtype(&plan, "donor", Some(256)), Some("uint8"));
        assert_eq!(unified_code_dtype(&plan, "donor", Some(255)), Some("uint8"));
        assert_eq!(
            unified_code_dtype(&plan, "donor", Some(65536)),
            Some("uint16")
        );
        assert_eq!(
            unified_code_dtype(&plan, "donor", Some(65537)),
            Some("uint32")
        );
    }

    /// A column the alignment does not fuse has no unified width to declare.
    #[test]
    fn a_column_with_no_lookup_declares_no_unified_width() {
        let (structure, meta) = alignment_with_levels(2, &["donor"], 130);
        let plan = AlignmentPlan::parse(&structure, &meta).expect("plan");
        assert_eq!(unified_code_dtype(&plan, "not_fused", Some(140)), None);
    }

    /// **The vocabulary is UNKNOWN — and the answer is the SOURCES' width, never a guess.**
    ///
    /// The alignment's group attributes are the only place the unified vocabulary lives, and
    /// a creator that cannot read them (an older alignment, a store fault) must not invent a
    /// width. `None` here means "keep the sources' width", which is the width the bytes
    /// actually are — and `remap_codes`' `GATHER_LEVEL_CODE_TOO_WIDE` is then the guard that
    /// makes a genuinely-too-narrow column LOUD instead of silently truncating. The two are
    /// not redundant: this is prevention, that is detection.
    #[test]
    fn an_unreadable_vocabulary_keeps_the_sources_width_rather_than_guessing() {
        let (structure, meta) = alignment_with_levels(2, &["donor"], 130);
        let plan = AlignmentPlan::parse(&structure, &meta).expect("plan");
        assert_eq!(
            unified_code_dtype(&plan, "donor", None),
            None,
            "an unknown vocabulary must not be sized from the lookup EXTENTS — that is the \
             sum-not-union defect, and its answer is wrong in the common overlapping case"
        );
    }
}
