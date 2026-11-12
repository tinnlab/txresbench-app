//! Dataset wire + DB types (the owner-corrected entity, DESIGN §5).
//!
//! A **Dataset** is one-or-many files in the txresbench-file store — owner-scoped,
//! shareable, attachable to many projects — with type-dependent `metadata` (a
//! JSONB bag the pipeline fills) and NO domain counts. The files live in
//! `dataset_files`; the merkle `content_hash` over those files is the provenance
//! link key (ITEM-20).

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// A dataset row: an owner-scoped, shareable, typed set of files.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct Dataset {
    pub id: Uuid,
    pub name: String,
    /// The owning user (txresbench-file-style ownership). Visibility = owner ∪ sharees.
    pub owner_id: Uuid,
    /// The account this dataset belongs to (A2 ownership key). `owner_id` is
    /// retained alongside; authz still runs on `owner_id` until A3 flips it.
    pub account_id: Uuid,
    /// The P2 datatype id (set by the upload sniffer / pipeline; null until typed).
    pub datatype: Option<String>,
    /// Type-dependent metadata bag, populated by the ingest/processing pipeline
    /// per datatype (e.g. a container format's declared axis names + shape). No fixed
    /// domain columns.
    pub metadata: serde_json::Value,
    /// How the dataset came to be: `upload` (user drop) or `promote` (from an
    /// artifact, ITEM-7).
    pub source: String,
    /// For `source='promote'`: the workstore artifact this dataset was promoted
    /// from (null otherwise). ITEM-7 populates it.
    pub source_artifact_id: Option<Uuid>,
    /// The merkle content-hash over the dataset's file(s) (`sha256:<hex>`), the
    /// provenance link key. Null until files are linked.
    pub content_hash: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One file linked into a dataset (a `dataset_files` row joined to the file's
/// display fields).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct DatasetFile {
    pub file_id: Uuid,
    pub filename: String,
    pub file_size: i64,
    pub ordinal: i32,
    /// The file's role in the dataset (ITEM-9 / DEC-5): `primary` (its bytes are
    /// the dataset, hashed into `content_hash`) or `supporting` (an axis-aligned
    /// annotation folded on). Defaults `primary`.
    pub role: String,
    /// The supporting-file kind (ITEM-9, open string, e.g. `annotation_table`);
    /// null for primary files.
    pub kind: Option<String>,
    /// A supporting file's integrate-job status (`pending`|`running`|`integrated`
    /// |`failed`); null for primary files.
    pub integration_status: Option<String>,
    /// The integrate run's coverage/summary JSON (matched/missing/extra); null
    /// until the integrate job completes (and for primary files).
    pub integration_summary: Option<serde_json::Value>,
}

/// A dataset plus its linked files — the detail-view payload. Carries the
/// DERIVED primary-processing status (see [`map_processing_status`]) so the
/// detail page can show that the primary convert/import job is running / done /
/// FAILED.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DatasetWithFiles {
    #[serde(flatten)]
    pub dataset: Dataset,
    pub files: Vec<DatasetFile>,
    /// The dataset's PRIMARY processing (convert/import) status, DERIVED from its
    /// `processing_job_id` job: `pending`|`running`|`completed`|`failed`, or null
    /// when there is no processing job (e.g. a split-child / pre-existing dataset).
    #[serde(default)]
    pub processing_status: Option<String>,
    /// The failure reason when `processing_status == "failed"` (the job's `error`);
    /// null otherwise.
    #[serde(default)]
    pub processing_error: Option<String>,
}

/// A dataset list-row: the dataset plus its DERIVED primary-processing status, so
/// the datasets LIBRARY table can badge a running / failed convert per row. The
/// `dataset` is flattened so the wire shape is a `Dataset` + the two extra fields.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DatasetListItem {
    #[serde(flatten)]
    pub dataset: Dataset,
    /// See [`DatasetWithFiles::processing_status`].
    pub processing_status: Option<String>,
    /// See [`DatasetWithFiles::processing_error`].
    pub processing_error: Option<String>,
}

/// Map a processing JOB's raw `(status, error)` to the dataset's DISPLAY
/// `(processing_status, processing_error)`. Mirrors the supporting-file job→status
/// mapping in `repository.rs::list_files`: `blocked`/`queued`→`pending`,
/// `running`→`running`, `completed`→`completed`, `failed`/`stopped`→`failed`
/// (carrying the error). No job (`None`) → `(None, None)` — no badge. The error is
/// surfaced ONLY for a failed job.
pub fn map_processing_status(
    job_status: Option<String>,
    job_error: Option<String>,
) -> (Option<String>, Option<String>) {
    match job_status.as_deref() {
        None => (None, None),
        Some("blocked") | Some("queued") => (Some("pending".to_string()), None),
        Some("running") => (Some("running".to_string()), None),
        Some("completed") => (Some("completed".to_string()), None),
        Some("failed") | Some("stopped") => (Some("failed".to_string()), job_error),
        Some(other) => (Some(other.to_string()), None),
    }
}

// ------------------ artifact summary (the attach-picker preview) ------------------
//
// "How many artifacts, and what is in there" for a dataset, assembled ONLY out of
// declarations that are already stored: the manifest slot name, the datatype id, the
// byte size, and the producer's own `meta` + `structure`. The server reads none of
// them by name and parses no bytes — artifact-model ITEM-7 dropped the columns that
// were the host's reading of an artifact, and re-deriving one here would restate
// exactly that. Forwarding the producer's OWN `structure` is the opposite move: it is
// the declaration the producer already wrote, travelling unread.
//
// See `docs/design/dataset-attach-readiness-and-preview.md`.

/// At most this many DISTINCT datatype groups travel per dataset (most-numerous
/// first). A single import emits one primary product and one column artifact per
/// source column, so the group count is small while the artifact count is not.
pub const GROUP_CAP: i64 = 6;

/// At most this many datasets are summarised in one response. Matches the page the
/// picker fetches from the list endpoints, so the two sets line up.
pub const SUMMARY_DATASET_CAP: i64 = 500;

/// Bounds on a producer-declared bag carried out to the client (DEC-5). A size
/// rule, not an interpretation: keys are kept in sorted order so the choice is
/// deterministic, and no key is ever read by name.
///
/// The SAME bound applies to BOTH declarations a group carries (`meta` and
/// `structure`). They are the same kind of thing — unbounded third-party input the
/// server stores and forwards without opening — so giving them two different size
/// rules would only mean two places to reason about.
pub const DECL_MAX_KEYS: usize = 8;
/// Longest string VALUE carried per surviving key.
pub const DECL_MAX_VALUE_CHARS: usize = 120;
/// Longest ARRAY carried per surviving key. A longer one is DROPPED WHOLE rather
/// than truncated: a truncated `[3460, 32738]` is not a smaller declaration, it is a
/// false one, and every rule here has to stay a size rule.
pub const DECL_MAX_ARRAY_ITEMS: usize = 4;
/// Longest string ITEM inside a surviving array. An array holding a longer item is
/// dropped whole (same reason). Tighter than [`DECL_MAX_VALUE_CHARS`] so the wire
/// ceiling per bag stays ~1 KB with the second declaration added, not ~4 KB.
pub const DECL_MAX_ARRAY_ITEM_CHARS: usize = 32;

/// One (dataset, datatype) group of artifacts, plus ONE representative member's
/// producer declarations for a contributed preview to read.
///
/// # How the representative is chosen — and why it is no longer the biggest
///
/// The representative exists to hand a preview ONE member's `meta` + `structure`. What
/// makes a member a good one is therefore its DECLARATION, so that is what the rule is
/// about. In order:
///
/// 1. **it declares a `structure`** — the half a preview usually needs (dimensions live
///    there). A member declaring `{}` cannot describe the group to anyone.
/// 2. **it declares a `meta`** — same reason, second because it is the half a preview
///    can more often do without.
/// 3. **it is the most recent** (`created_at DESC`) — among members that declare equally
///    well, the current producer's statement is the group's statement.
/// 4. **`output_id` then `id`** — a total order, so the rule always names exactly one row.
///
/// This replaced `ORDER BY size_bytes DESC, id`, which the previous version of this
/// comment named for what it was: *a size rule, not a semantic one*. The magnitude of a
/// byte count decided whose declaration shipped, which is incidental; and every tie fell
/// through to `id`, which is `gen_random_uuid()` — so two ingests of the SAME data, with
/// the same sizes, picked different representatives at random. Steps 1-2 make the rule
/// about the thing it is for, and steps 3-4 make it reproducible.
///
/// The three aggregates in `artifact_summary_rows` must all order by this identical
/// clause: the group ships ONE member's declarations, and pairing one row's `meta` with
/// another's `structure` describes an artifact that does not exist.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DatasetArtifactGroup {
    /// The P2 datatype id shared by every artifact in this group. Opaque here — the
    /// client resolves its display title through the datatype registry.
    pub datatype: String,
    /// How many artifacts of this datatype the dataset holds.
    pub count: i64,
    /// Their combined LOGICAL size — the size the data represents, which is what a
    /// user reads this total as. NOT the stored-byte sum: a gathered member stores no
    /// bytes, and counting it as 0 understated the group by its whole content.
    ///
    /// Rows whose logical size is UNKNOWN contribute nothing (SQL `sum` skips NULL)
    /// rather than a fabricated 0. A scalar total cannot express "and some unknown
    /// amount more", so this field does not pretend to.
    pub logical_bytes: i64,
    /// The manifest slot name of the member the type-level rule above selected — the
    /// best-declared, then most recent, then lowest `output_id`.
    pub representative_output_id: String,
    /// That member's producer-declared `meta` (what the bytes MEAN), compacted by
    /// [`compact_declaration`].
    pub representative_meta: serde_json::Value,
    /// That member's producer-declared `structure` (how to DECODE the bytes),
    /// compacted by [`compact_declaration`].
    ///
    /// Carried for the same reason `meta` is, and it is the half a preview usually
    /// needs: a producer states an array's dimensions in `structure` (its `shape` /
    /// its axis length), not in `meta`, so a summary built from `meta` alone can
    /// only ever describe one side of a matrix. Nothing here reads a key by name —
    /// the bag travels whole (under the size bound) and a CONTRIBUTED declaration
    /// decides which of its keys mean anything.
    pub representative_structure: serde_json::Value,
}

/// What a dataset's artifacts add up to: the totals plus the per-datatype groups.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DatasetArtifactSummary {
    pub dataset_id: Uuid,
    /// Every counted artifact, INCLUDING those beyond the [`GROUP_CAP`] groups.
    pub artifact_count: i64,
    /// Their combined LOGICAL size, on the same population as `artifact_count`.
    /// See [`DatasetArtifactGroup::logical_bytes`] for why it is not the stored sum.
    pub total_logical_bytes: i64,
    /// At most [`GROUP_CAP`] groups, most-numerous first.
    pub groups: Vec<DatasetArtifactGroup>,
}

/// The batched response. A dataset the caller can see but which holds NO counted
/// artifact is ABSENT (DEC-3) — the response is complete when it arrives, so absence
/// is unambiguously zero.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DatasetArtifactSummaryList {
    pub summaries: Vec<DatasetArtifactSummary>,
}

/// WHICH keys survive the [`DECL_MAX_KEYS`] cap: the first that many in KEY order.
///
/// Split out of [`compact_declaration`], and it is not decoration. `serde_json::Map` is a
/// `BTreeMap` with the crate's defaults, so it already iterates sorted and a
/// sort applied to its keys in place cannot be observed — a test written against
/// `compact_declaration` alone passes with or without one, which makes the rule un-tested
/// rather than proven. Enabling serde_json's `preserve_order` anywhere in the
/// dependency graph flips `Map` to insertion-ordered and would silently change WHICH
/// keys a truncated declaration keeps. Taking an ITERATOR lets the test hand it an
/// unsorted sequence directly, so the ordering rule is asserted on its own terms.
fn capped_keys<'a>(keys: impl Iterator<Item = &'a String>) -> Vec<&'a String> {
    let mut keys: Vec<&String> = keys.collect();
    keys.sort();
    keys.truncate(DECL_MAX_KEYS);
    keys
}

fn is_scalar(v: &serde_json::Value) -> bool {
    v.is_string() || v.is_number() || v.is_boolean()
}

/// Does this ARRAY fit the wire bound? All-scalar, short, and no over-long string
/// item. It is a yes/no question by design — see [`DECL_MAX_ARRAY_ITEMS`].
fn array_fits(items: &[serde_json::Value]) -> bool {
    items.len() <= DECL_MAX_ARRAY_ITEMS
        && items.iter().all(|v| {
            is_scalar(v)
                && v.as_str()
                    .is_none_or(|s| s.chars().count() <= DECL_MAX_ARRAY_ITEM_CHARS)
        })
}

/// Bound a producer-declared bag (`meta` or `structure`) for the wire (DEC-5).
///
/// Keeps SCALAR-valued keys (string / number / bool) and SHORT ALL-SCALAR ARRAYS, at
/// most [`DECL_MAX_KEYS`] of them in key order, with string values truncated to
/// [`DECL_MAX_VALUE_CHARS`] (on CHAR boundaries — a byte slice would panic on a
/// multi-byte value). A non-object bag — including the `null` a producer may
/// declare — becomes `{}`.
///
/// Arrays are kept-or-dropped, never truncated: a producer's dimension list is the
/// one shape of value where dropping an item would turn a bounded declaration into a
/// WRONG one, and this function is only allowed to bound.
///
/// This is a size bound and nothing else: no key is read by name, none is required,
/// and none is given a meaning.
pub fn compact_declaration(decl: &serde_json::Value) -> serde_json::Value {
    let Some(obj) = decl.as_object() else {
        return serde_json::Value::Object(serde_json::Map::new());
    };
    let keys = capped_keys(
        obj.iter()
            .filter(|(_, v)| match v {
                serde_json::Value::Array(items) => array_fits(items),
                other => is_scalar(other),
            })
            .map(|(k, _)| k),
    );
    let mut out = serde_json::Map::new();
    for k in keys {
        let v = &obj[k];
        let v = match v.as_str() {
            Some(s) if s.chars().count() > DECL_MAX_VALUE_CHARS => {
                serde_json::Value::String(s.chars().take(DECL_MAX_VALUE_CHARS).collect::<String>())
            }
            _ => v.clone(),
        };
        out.insert(k.clone(), v);
    }
    serde_json::Value::Object(out)
}

/// Create-dataset request body (metadata-only; files land via upload/promote).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateDatasetRequest {
    pub name: String,
    /// Optional pre-known datatype (the upload path sets it from the sniffer).
    #[serde(default)]
    pub datatype: Option<String>,
    /// Optional seed metadata bag.
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

/// Rename-dataset request body.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct RenameDatasetRequest {
    pub name: String,
}

// ----------------------------- sharing (ITEM-2) -----------------------------

/// A dataset-share row (owner shares a dataset with a user/group at a role).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct DatasetShare {
    pub id: Uuid,
    pub dataset_id: Uuid,
    /// `user` | `group`.
    pub principal_type: String,
    pub principal_id: Uuid,
    /// `view` | `edit`.
    pub role: String,
    pub created_at: DateTime<Utc>,
}

/// Share-dataset request body.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct ShareDatasetRequest {
    /// `user` | `group`.
    pub principal_type: String,
    pub principal_id: Uuid,
    /// `view` | `edit`.
    pub role: String,
}

// ----------------------------- folders (ITEM-24) -----------------------------

/// An owner-scoped folder (a label/view over datasets).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct DatasetFolder {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Create/rename-folder request body.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct FolderNameRequest {
    pub name: String,
}

// ----------------------------- upload (ITEM-4) -----------------------------

/// The result of a streaming upload: the dataset(s) the files were grouped into.
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct UploadResponse {
    /// Each created dataset with its linked files.
    pub datasets: Vec<DatasetWithFiles>,
}

/// The result of uploading ONE file INTO an existing dataset (ITEM-4, the
/// `POST /datasets/{id}/upload` path). Carries the newly-stored file id, the
/// sniffed datatype, and the updated dataset (its `content_hash` re-merkled).
#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct DatasetFileUploadResponse {
    pub file_id: Uuid,
    /// The P2 datatype sniffed from the uploaded file (null = unrecognized).
    pub detected_datatype: Option<String>,
    /// The dataset after the file was linked (content_hash recomputed).
    pub dataset: Dataset,
}

// ----------------------------- promote (ITEM-7) -----------------------------

/// Promote-artifact request body: turn a `role='artifact'` workstore output into
/// a new owner-scoped Dataset (byte-preserving copy, DEC-7).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct PromoteRequest {
    /// The workstore artifact to promote (must be `role='artifact'`).
    pub artifact_id: Uuid,
    /// Optional name for the new dataset (defaults to the artifact's output id).
    #[serde(default)]
    pub name: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::map_processing_status;

    fn s(x: &str) -> Option<String> {
        Some(x.to_string())
    }

    #[test]
    fn map_processing_status_covers_the_full_job_vocabulary() {
        // No job → no badge.
        assert_eq!(map_processing_status(None, None), (None, None));
        // blocked/queued → pending (no error surfaced).
        assert_eq!(
            map_processing_status(s("blocked"), s("x")),
            (s("pending"), None)
        );
        assert_eq!(
            map_processing_status(s("queued"), None),
            (s("pending"), None)
        );
        // running → running.
        assert_eq!(
            map_processing_status(s("running"), None),
            (s("running"), None)
        );
        // completed → completed, error dropped even if present.
        assert_eq!(
            map_processing_status(s("completed"), s("x")),
            (s("completed"), None)
        );
        // failed/stopped → failed, CARRYING the error.
        assert_eq!(
            map_processing_status(s("failed"), s("boom")),
            (s("failed"), s("boom"))
        );
        assert_eq!(
            map_processing_status(s("stopped"), s("cancelled")),
            (s("failed"), s("cancelled"))
        );
        // unknown status → passthrough label, no error (never panics on an enum drift).
        assert_eq!(
            map_processing_status(s("weird"), s("x")),
            (s("weird"), None)
        );
    }

    // ── compact_declaration (DEC-5) — a SIZE bound over a producer declaration ───
    //
    // Every assertion below is about SHAPE (how many keys, how long a value, which
    // JSON kinds survive). None of them names a key the server is supposed to find:
    // the fixtures use neutral key names precisely so that a rule which started
    // reading a key by name could not pass them.

    use super::{
        capped_keys, compact_declaration, DECL_MAX_ARRAY_ITEMS, DECL_MAX_ARRAY_ITEM_CHARS,
        DECL_MAX_KEYS, DECL_MAX_VALUE_CHARS,
    };
    use serde_json::json;

    #[test]
    fn capped_keys_takes_the_first_n_in_key_order_from_an_unsorted_sequence() {
        // Fed DESCENDING, which is what makes this an assertion about the RULE rather
        // than about `serde_json::Map` happening to be a BTreeMap today.
        let owned: Vec<String> = (0..DECL_MAX_KEYS * 3)
            .rev()
            .map(|i| format!("k{i:02}"))
            .collect();
        let got = capped_keys(owned.iter());
        assert_eq!(got.len(), DECL_MAX_KEYS, "the count is capped");
        let expected: Vec<String> = (0..DECL_MAX_KEYS).map(|i| format!("k{i:02}")).collect();
        assert_eq!(
            got.into_iter().cloned().collect::<Vec<String>>(),
            expected,
            "the survivors are the first {DECL_MAX_KEYS} in KEY order — an input in \
             descending order must not survive in descending order"
        );
    }

    #[test]
    fn capped_keys_is_a_no_op_below_the_cap() {
        let owned: Vec<String> = vec!["b".into(), "a".into()];
        assert_eq!(
            capped_keys(owned.iter())
                .into_iter()
                .cloned()
                .collect::<Vec<String>>(),
            vec!["a".to_string(), "b".to_string()],
            "under the cap everything survives — sorted, but nothing dropped"
        );
    }

    #[test]
    fn compact_declaration_keeps_scalars_and_short_scalar_arrays() {
        let out = compact_declaration(&json!({
            "alpha": 12,
            "beta": "two",
            "gamma": true,
            "delta": { "nested": 1 },
            "epsilon": [1, 2, 3],
            "zeta": null,
            "eta": ["a", "b"],
            "theta": [1, { "nested": 1 }],
        }));
        assert_eq!(
            out,
            json!({
                "alpha": 12, "beta": "two", "gamma": true,
                "epsilon": [1, 2, 3], "eta": ["a", "b"],
            }),
            "scalars and SHORT ALL-SCALAR arrays survive; mappings, nulls and an \
             array holding a mapping are dropped"
        );
    }

    #[test]
    fn compact_declaration_drops_an_over_long_array_whole_rather_than_truncating_it() {
        // THE RULE THIS PINS. A dimension list is the one value where dropping items
        // turns a bounded declaration into a WRONG one — `[3460, 32738, 9, 9, 9]`
        // truncated to four is not a smaller shape, it is a different shape, and a
        // contribution reading index 1 would print a number that was never declared.
        // So the bound is kept-or-dropped.
        let long: Vec<i64> = (0..(DECL_MAX_ARRAY_ITEMS as i64 + 1)).collect();
        let at_cap: Vec<i64> = (0..DECL_MAX_ARRAY_ITEMS as i64).collect();
        let out = compact_declaration(&json!({ "over": long, "at_cap": at_cap.clone() }));
        assert_eq!(
            out,
            json!({ "at_cap": at_cap }),
            "an array one item past the cap is GONE, not shortened; one AT the cap is \
             untouched"
        );
    }

    #[test]
    fn compact_declaration_drops_an_array_holding_an_over_long_string() {
        let long: String = "x".repeat(DECL_MAX_ARRAY_ITEM_CHARS + 1);
        let ok: String = "y".repeat(DECL_MAX_ARRAY_ITEM_CHARS);
        let out = compact_declaration(&json!({ "over": ["a", long], "fits": ["a", ok.clone()] }));
        assert_eq!(
            out,
            json!({ "fits": ["a", ok] }),
            "the per-ITEM char bound drops the array whole — items are never truncated"
        );
    }

    #[test]
    fn compact_declaration_counts_a_surviving_array_against_the_key_cap() {
        // The cap is applied to the SURVIVORS, so a bag of arrays is bounded exactly
        // like a bag of scalars — the second declaration cannot smuggle keys past it.
        let mut src = serde_json::Map::new();
        for i in (0..DECL_MAX_KEYS * 3).rev() {
            src.insert(format!("k{i:02}"), json!([i, i + 1]));
        }
        let out = compact_declaration(&serde_json::Value::Object(src));
        assert_eq!(
            out.as_object().expect("object out").len(),
            DECL_MAX_KEYS,
            "array-valued keys are capped like scalar ones"
        );
    }

    #[test]
    fn compact_declaration_caps_the_key_count_deterministically() {
        let mut src = serde_json::Map::new();
        // 3x the cap, inserted in an order that is NOT key order, so a rule that
        // simply truncated the input order would produce a different answer.
        for i in (0..DECL_MAX_KEYS * 3).rev() {
            src.insert(format!("k{i:02}"), json!(i));
        }
        let out = compact_declaration(&serde_json::Value::Object(src));
        let obj = out.as_object().expect("object out");
        assert_eq!(obj.len(), DECL_MAX_KEYS, "the key count is capped");
        let mut keys: Vec<&String> = obj.keys().collect();
        keys.sort();
        assert_eq!(
            keys.first().map(|s| s.as_str()),
            Some("k00"),
            "the surviving set is the first {DECL_MAX_KEYS} in KEY order, not insertion order"
        );
        assert!(
            !obj.contains_key(&format!("k{:02}", DECL_MAX_KEYS)),
            "the first key past the cap is gone"
        );
    }

    #[test]
    fn compact_declaration_truncates_long_strings_on_char_boundaries() {
        // A multi-byte value at exactly the boundary: a byte slice here PANICS.
        let long: String = "é".repeat(DECL_MAX_VALUE_CHARS + 40);
        let out = compact_declaration(&json!({ "a": long, "b": "short" }));
        let a = out["a"].as_str().expect("string survives");
        assert_eq!(
            a.chars().count(),
            DECL_MAX_VALUE_CHARS,
            "a long value is truncated to the char cap"
        );
        assert_eq!(out["b"], json!("short"), "a short value is untouched");
    }

    #[test]
    fn compact_declaration_of_a_non_object_is_an_empty_object() {
        // A producer may declare `meta: null` (the manifest's own default is None),
        // and may in principle declare a scalar. Neither is an error here and neither
        // becomes a key.
        for v in [json!(null), json!(7), json!("x"), json!([1, 2])] {
            assert_eq!(
                compact_declaration(&v),
                json!({}),
                "non-object declaration → {{}} ({v})"
            );
        }
    }
}
