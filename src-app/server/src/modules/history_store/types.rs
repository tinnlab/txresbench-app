//! The `history_store` type contract — the serde + JsonSchema surface of
//! every request and response the module owns (PROV-HS-2..HS-6): the K
//! screen's paged history row (`TxrHistoryItem`) and expanded block
//! (`TxrHistoryDetail`), the retention preference + copy-clear responses,
//! and the data-usage figure.
//!
//! Every type in this file is a WIRE shape; the persisted rows are one level
//! narrower (the repository / migration half, ITEM-2/3). The provider-typed
//! fields below are bound to the providers' own types, never re-declared:
//! - `TxrRunMode`, `TxrEndpoint`, `TxrRunReason` and `TxrRunMethod` come
//!   from `execution_engine` (PROV-EE-3) — the history view is a READ-SIDE
//!   PROJECTION over the engine's run records (INV-6), so the K screen and
//!   the F/G screens render the same vocabulary and the same reason/detail
//!   text (CONS-HS-15: codes + detail pass VERBATIM, never re-authored);
//! - `TimingQuality` comes from `method_catalogue` (PROV-MC-7) — the
//!   detail's `use_estimate` ("took X, estimated Y") is the SAME in-process
//!   estimator call the engine's detail serves (CONS-HS-12), so the two
//!   renderings can never disagree.
//!
//! Wire spellings are the crate's serde-default (snake_case — no
//! `rename_all`), which is what the emitted openapi + generated client carry
//! (the `TxrRunSummary` precedent); the PLAN's JSONC examples are that exact
//! spelling. INV-2/INV-3 hold in the types: the list row is consumer-shaped
//! and compact (no per-method body — the bounded paged view, never a
//! fetch-all), and every capability boolean is DATA (`can_rerun`,
//! `can_reopen`, `can_download`) — the module never fabricates an affordance
//! a provider route cannot serve (DEC-6).

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::modules::execution_engine::types::{
    TxrEndpoint, TxrRunMethod, TxrRunMode, TxrRunReason,
};
use crate::modules::method_catalogue::types::TimingQuality;

// ─────────────────────────────────────────────────────────────────────────────
// Bounds + error vocabulary (DEC-15 / PROV-HS-2 / PROV-HS-5)
// ─────────────────────────────────────────────────────────────────────────────

/// The history list's paging bounds (DEC-3/INV-3: the view is bounded and
/// server-side paged — a single-user local app never needs render-all, and
/// the cap keeps one page from unwinding the engine's whole run table).
pub struct HistoryLimits;

impl HistoryLimits {
    /// `GET /api/txr/history` `limit` default.
    pub const DEFAULT_LIMIT: u32 = 20;
    /// The `limit` clamp ceiling (a caller asking for 200 gets the cap).
    pub const MAX_LIMIT: u32 = 100;
}

/// The module's named error codes (PROV-HS-3's `RUN_NOT_FOUND`, PROV-HS-5's
/// `UNSAFE_RUN_DIR`). Both are the provider/route vocabulary the K screen
/// renders one not-found/failure state from (DEC-20: one entity, one code).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryErrorCode {
    RunNotFound,
    UnsafeRunDir,
}

impl HistoryErrorCode {
    /// The stable machine code.
    pub fn code(self) -> &'static str {
        match self {
            HistoryErrorCode::RunNotFound => "RUN_NOT_FOUND",
            HistoryErrorCode::UnsafeRunDir => "UNSAFE_RUN_DIR",
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The history list (PROV-HS-2)
// ─────────────────────────────────────────────────────────────────────────────

/// The four-bucket run vocabulary of the K list (DEC-4's map — the engine's
/// `creating|preparing|running|finishing` all land in `running`; the K
/// display words Done/Failed/Stopped/Running are the consumer's, this node
/// delivers the bucket, never display text). The engine-status → bucket map
/// lives in the repository (ITEM-2, TEST-HS-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrHistoryBucket {
    Running,
    Finished,
    Stopped,
    Failed,
}

impl TxrHistoryBucket {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            TxrHistoryBucket::Running => "running",
            TxrHistoryBucket::Finished => "finished",
            TxrHistoryBucket::Stopped => "stopped",
            TxrHistoryBucket::Failed => "failed",
        }
    }
}

/// The K filter's `kind` vocabulary (PROV-HS-2): `learned` = the run's
/// `mode: train`, `saved-model` = `mode: reuse` — the engine's own mode
/// enum mapped to the filter words, never a third vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TxrHistoryKind {
    Learned,
    #[serde(rename = "saved-model")]
    SavedModel,
}

impl TxrHistoryKind {
    /// The wire spelling (the filter value the K select sends).
    pub fn as_str(self) -> &'static str {
        match self {
            TxrHistoryKind::Learned => "learned",
            TxrHistoryKind::SavedModel => "saved-model",
        }
    }

    /// The mode the filter selects (the plan's `kind` ↔ `mode` binding).
    pub fn selects_mode(self) -> TxrRunMode {
        match self {
            TxrHistoryKind::Learned => TxrRunMode::Train,
            TxrHistoryKind::SavedModel => TxrRunMode::Reuse,
        }
    }
}

/// One K list row, consumer-shaped (PROV-HS-2): the row's subtitle fields
/// (`method_count`, `file_names`, `learned_from`, `predicted`, `endpoint`,
/// `decision_day`, `look_ahead_day`), the compact per-method times, the
/// first terminal reason (verbatim — K's "Stopped: marker LDH is missing…"
/// is the engine's `detail`), the made/used model names (through the
/// PROV-MS-11 seam, DEC-9), the retention + capability flags. The meta
/// fields come from the engine's own run record — the view is a projection,
/// never a parallel model (INV-6).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryItem {
    /// The engine's run id (one entity, one id — DEC-20).
    pub id: Uuid,
    /// The engine's mode vocabulary, verbatim (`train`|`reuse`).
    pub mode: TxrRunMode,
    /// The DEC-4 bucket the K list filters/renders on.
    pub bucket: TxrHistoryBucket,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    /// The run's recorded "took" seconds (the K "Took 3 minutes 10 seconds").
    pub elapsed_secs: Option<u64>,
    /// The create-time estimate's total (the K "(estimated 4 minutes)");
    /// null when never computed (never a fabricated zero).
    pub estimate_total_seconds: Option<f64>,
    pub method_count: u32,
    /// The uploaded source names (engine-grown `input_summary.file_names`,
    /// GAP-HS-1) in the run's own order — never a name derived from the dir
    /// stem.
    pub file_names: Vec<String>,
    /// `input_summary.patients` (train mode's "learned from N patients").
    pub learned_from: Option<u32>,
    /// `input_summary.predict_patients` (the "predicted N" figure —
    /// the predict side's distinct patient count, qa-fixes2 R2-04).
    pub predicted: Option<u32>,
    /// `input_summary.markers` (distinct resolved marker facts).
    pub markers: u32,
    pub endpoint: TxrEndpoint,
    pub decision_day: f64,
    pub look_ahead_day: f64,
    /// Compact per-method facts only (no per-method body — the row is the
    /// bounded view, INV-3; the expanded block's rich rows are the detail's
    /// `methods`).
    pub methods: Vec<TxrHistoryMethodRef>,
    /// The first terminal method's reason (earliest failed → cannot_run →
    /// stopped, ITEM-2) — code + detail VERBATIM (CONS-HS-15).
    pub reason: Option<TxrRunReason>,
    /// The K "Made: N models (…)" block.
    pub models_made: TxrHistoryModelsMade,
    /// The reuse run's consumed set/model names (GROWN at reconcile for
    /// GAP-HIST-2 — through the engine's `model_ids` over the PROV-MS-11
    /// seam); `[]` in train mode, never a fabricated name.
    pub models_used: Vec<TxrHistoryModelRef>,
    /// The retention flag (the retention row's `copies_kept`; a run without
    /// a row reads `true` — INV-2's conservative default).
    pub copies_kept: bool,
    /// `copies_kept && bucket != running` — "Run again with the same
    /// settings" works only while the stored input copies exist (DEC-6).
    pub can_rerun: bool,
    /// `predictions_ready` — "Open the results" / "Download predictions".
    pub can_reopen: bool,
    /// `predictions_ready` (the engine's CSV download, CONS-HS-10).
    pub can_download: bool,
    /// The engine's run dir verbatim (`<data_root>/analysis-…-<id8>`).
    pub dir: String,
    /// The run produced models that were saved (`run.models[]` non-empty):
    /// the K row's save semantics — the field is DATA, the rendering is the
    /// consumer's.
    pub markers_saved: bool,
}

/// One compact method ref of the list row (id + version + the recorded
/// seconds — the K row's "1.0 (2 min)" facts without a per-method body).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryMethodRef {
    pub id: String,
    pub version: String,
    pub elapsed_secs: Option<u64>,
}

/// The K "Made: N models (…)" block (PROV-HS-2): `produced` = the run's
/// produced-model count, `saved_sets` = the model-store sets whose
/// `source_run_id` is this run (PROV-MS-11, DEC-9 — read-only; this node
/// never writes a model row).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryModelsMade {
    pub produced: u32,
    pub saved_sets: Vec<TxrHistorySavedSet>,
}

/// One saved set in the "Made" block.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistorySavedSet {
    pub set_id: Uuid,
    pub set_name: String,
    pub model_count: u32,
}

/// One consumed model reference of a reuse run (GROWN at reconcile for
/// GAP-HIST-2: the engine's `model_ids` joined over `txr_model_sets` /
/// `txr_models` — the K row's "Model CRC cohort, day 56 on march_new.csv"
/// facts; `[]` in train mode).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryModelRef {
    pub set_id: Uuid,
    pub set_name: String,
    pub model_id: Uuid,
    pub model_name: String,
}

/// One paged history page (PROV-HS-2): newest-first (`created_at DESC`, id
/// tie-break), server-side bounded, `total` the engine-truth count under the
/// active q/kind/status filters.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryPage {
    pub items: Vec<TxrHistoryItem>,
    pub total: u64,
    pub limit: u32,
    pub offset: u32,
}

/// `GET /api/txr/history` query (PROV-HS-2): `q` = ASCII-folded substring
/// over file names / method ids / saved set names (DEC-3 —
/// `instr(lower(...), lower($1)) > 0`, no FTS); `kind` = the filter above;
/// `status` = ONE bucket or the comma-separated multi-value (GROWN at
/// reconcile for GAP-HIST-3: "Stopped or failed" is one call, OR semantics
/// — the string is validated/parsed by the repository, ITEM-2); `limit`
/// default + clamp per [`HistoryLimits`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryListQuery {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub kind: Option<TxrHistoryKind>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
}

// ─────────────────────────────────────────────────────────────────────────────
// The history detail (PROV-HS-3)
// ─────────────────────────────────────────────────────────────────────────────

/// One input file copy's recorded size (the detail's "Your files" block).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryFileSize {
    pub name: String,
    pub size_bytes: u64,
}

/// The expanded-block settings line (from the run's `config` JSON + the
/// `txr_runs` columns — PROV-HS-3; `cpus: null` = "detect at run start",
/// `seed` is the run's recorded contract seed).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrRunSettingsView {
    pub endpoint: TxrEndpoint,
    pub decision_day: f64,
    pub look_ahead_day: f64,
    pub covariates: bool,
    pub seed: Option<i64>,
    pub cpus: Option<u32>,
    pub memory_total_bytes: Option<u64>,
    pub at_a_time: u32,
    pub save_models: bool,
    pub mode: TxrRunMode,
}

/// One saved model of the run's "Made" record in the detail
/// (`txr_models`/`txr_model_sets` joined over `source_run_id` — PROV-MS-11).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryModelSaved {
    pub set_id: Uuid,
    pub set_name: String,
    pub model_id: Uuid,
    pub model_name: String,
    pub size_bytes: u64,
}

/// The detail's retention block.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryCopies {
    /// `txr_run_retention.copies_kept` (default true).
    pub kept: bool,
    /// The last copy-clear stamp (null until one ran — PROV-HS-5).
    pub cleared_at: Option<DateTime<Utc>>,
}

/// The detail's "took X (estimated Y)" facts (CONS-HS-12): the same
/// in-process estimator call the engine's detail uses, projected to the two
/// facts the K expanded block renders; `estimate_quality` is the
/// catalogue's own vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryEstimate {
    pub total_seconds: f64,
    pub estimate_quality: TimingQuality,
}

/// The expanded K block (PROV-HS-3): the row's fields (the summary half,
/// spelled out — the detail is a standalone wire shape, not a `flatten` of
/// the row: the row's compact `methods` and the detail's rich `methods`
/// share one JSON name, and the detail's `models_saved` list replaces the
/// row's save flag with the actual records) plus the per-method rows (the
/// engine's own [`TxrRunMethod`] verbatim — one vocabulary for F and K),
/// the made/used model records, the copies note, the dir size and the
/// estimate. `404 RUN_NOT_FOUND` on an unknown id.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryDetail {
    pub id: Uuid,
    pub mode: TxrRunMode,
    pub bucket: TxrHistoryBucket,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub elapsed_secs: Option<u64>,
    pub estimate_total_seconds: Option<f64>,
    pub method_count: u32,
    pub file_names: Vec<String>,
    pub learned_from: Option<u32>,
    pub predicted: Option<u32>,
    pub markers: u32,
    pub endpoint: TxrEndpoint,
    pub decision_day: f64,
    pub look_ahead_day: f64,
    /// The run's per-method rows, THE ENGINE'S TYPE verbatim (PROV-EE-3's
    /// `TxrRunMethod` — the K expanded block's "Methods … 1.0 (2 min)" line
    /// renders the same row the F screen renders).
    pub methods: Vec<TxrRunMethod>,
    pub reason: Option<TxrRunReason>,
    pub models_made: TxrHistoryModelsMade,
    pub models_used: Vec<TxrHistoryModelRef>,
    pub copies_kept: bool,
    pub can_rerun: bool,
    pub can_reopen: bool,
    pub can_download: bool,
    pub dir: String,
    pub markers_saved: bool,
    /// The input copies' recorded sizes (empty when the copies were cleared
    /// or the dir is gone).
    pub file_sizes: Vec<TxrHistoryFileSize>,
    pub settings: TxrRunSettingsView,
    /// The run's saved models (PROV-MS-11; `[]` when none were saved).
    pub models_saved: Vec<TxrHistoryModelSaved>,
    /// `txr_run_logs` count (the K "Show the log" badge).
    pub log_line_count: u64,
    pub copies: TxrHistoryCopies,
    /// The run dir's recursive size when it exists (null when gone).
    pub dir_bytes: Option<u64>,
    pub use_estimate: Option<TxrHistoryEstimate>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Retention (PROV-HS-4 / PROV-HS-5 / PROV-HS-6)
// ─────────────────────────────────────────────────────────────────────────────

/// The K footer's keep-copies preference (PROV-HS-4): the singleton row
/// `txr_history_preferences(id = 1)`, seeded by the migration with the
/// board's default `true` — "Copies are kept with this run so it can be
/// repeated". The ui-run node reads this route at create time (DEC-13).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryPreferences {
    pub keep_file_copies: bool,
    pub updated_at: Option<DateTime<Utc>>,
}

/// `PUT /api/txr/history/preferences` body (a missing/typed-wrong field is
/// the framework's 422 — serde-validated).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryPreferencesUpdate {
    pub keep_file_copies: bool,
}

/// The K footer's usage figure (PROV-HS-6): `run_count` from the DB (not
/// the walk), the recursive size walk of `rootfs::data_root()` grouped by
/// top-level segment (`analysis-*` → runs, `models/` → models, rest →
/// other), the user-visible `data_dir` (GROWN at reconcile for GAP-HIST-1 —
/// the UI never hardcodes a path and never derives one from a run dir), and
/// the stamp.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TxrHistoryUsage {
    pub run_count: u32,
    pub total_bytes: u64,
    pub runs_bytes: u64,
    pub models_bytes: u64,
    pub other_bytes: u64,
    pub data_dir: String,
    pub computed_at: DateTime<Utc>,
}

// ─────────────────────────────────────────────────────────────────────────────
// The routes' doc ids (PROV-HS-9)
// ─────────────────────────────────────────────────────────────────────────────

/// The exact aide doc-id vocabulary of the 7 `History.*` operations (the
/// routes item registers them; the OpenAPI regen diff at that item is these
/// operations and nothing else — the engine's `ROUTE_DOC_IDS` precedent).
pub const ROUTE_DOC_IDS: [&str; 7] = [
    "History.listHistory",
    "History.getHistory",
    "History.getPreferences",
    "History.updatePreferences",
    "History.clearCopies",
    "History.clearAllCopies",
    "History.getUsage",
];

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the ITEM-1 contract pins: wire spellings, the doc-id vocabulary,
// the schema generation of every wire type and the engine-shape binding.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// The doc-id vocabulary is exactly the plan's 7, distinct (a route with
    /// a spare id is a missing registration; a duplicate is a broken pin).
    #[test]
    fn route_doc_ids_are_the_seven_history_operations() {
        assert_eq!(
            ROUTE_DOC_IDS,
            [
                "History.listHistory",
                "History.getHistory",
                "History.getPreferences",
                "History.updatePreferences",
                "History.clearCopies",
                "History.clearAllCopies",
                "History.getUsage",
            ]
        );
        let mut sorted = ROUTE_DOC_IDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ROUTE_DOC_IDS.len(), "ids are distinct");
    }

    /// Every wire type generates a schema (a schemars limitation must
    /// surface HERE, at the type layer, not at the routes item's first
    /// regen — the method_catalogue precedent) and round-trips its JSON.
    #[test]
    fn wire_types_generate_schemas_and_round_trip() {
        let _ = schemars::schema_for!(TxrHistoryItem);
        let _ = schemars::schema_for!(TxrHistoryPage);
        let _ = schemars::schema_for!(TxrHistoryDetail);
        let _ = schemars::schema_for!(TxrHistoryListQuery);
        let _ = schemars::schema_for!(TxrHistoryPreferences);
        let _ = schemars::schema_for!(TxrHistoryPreferencesUpdate);
        let _ = schemars::schema_for!(TxrHistoryUsage);
        let _ = schemars::schema_for!(TxrHistoryModelsMade);
        let _ = schemars::schema_for!(TxrRunSettingsView);
        let _ = schemars::schema_for!(TxrHistoryBucket);
        let _ = schemars::schema_for!(TxrHistoryKind);

        let prefs = TxrHistoryPreferences {
            keep_file_copies: true,
            updated_at: None,
        };
        let json = serde_json::to_value(&prefs).expect("serialize");
        assert_eq!(json["keep_file_copies"], true);
        assert!(
            json["updated_at"].is_null(),
            "none serializes as null (the plan's `String|null` spelling)"
        );
        let back: TxrHistoryPreferences =
            serde_json::from_value(json).expect("deserialize");
        assert!(back.keep_file_copies);
    }

    /// The vocabulary wire strings are the plan's exactly: the four buckets,
    /// the two kinds (incl. the hyphenated `saved-model`), the error codes
    /// and the paging bounds.
    #[test]
    fn vocabulary_is_the_plan_strings() {
        assert_eq!(TxrHistoryBucket::Running.as_str(), "running");
        assert_eq!(TxrHistoryBucket::Finished.as_str(), "finished");
        assert_eq!(TxrHistoryBucket::Stopped.as_str(), "stopped");
        assert_eq!(TxrHistoryBucket::Failed.as_str(), "failed");
        for b in [
            TxrHistoryBucket::Running,
            TxrHistoryBucket::Finished,
            TxrHistoryBucket::Stopped,
            TxrHistoryBucket::Failed,
        ] {
            let json = serde_json::to_value(b).expect("serialize");
            let back: TxrHistoryBucket =
                serde_json::from_value(json.clone()).expect("deserialize");
            assert_eq!(back, b);
        }

        assert_eq!(TxrHistoryKind::Learned.as_str(), "learned");
        assert_eq!(TxrHistoryKind::SavedModel.as_str(), "saved-model");
        assert_eq!(
            TxrHistoryKind::Learned.selects_mode(),
            TxrRunMode::Train,
            "learned selects the train runs"
        );
        assert_eq!(
            TxrHistoryKind::SavedModel.selects_mode(),
            TxrRunMode::Reuse,
            "saved-model selects the reuse runs"
        );
        let json = serde_json::to_value(TxrHistoryKind::SavedModel).expect("serialize");
        assert_eq!(json.as_str(), Some("saved-model"));

        assert_eq!(HistoryErrorCode::RunNotFound.code(), "RUN_NOT_FOUND");
        assert_eq!(HistoryErrorCode::UnsafeRunDir.code(), "UNSAFE_RUN_DIR");
        assert_eq!(HistoryLimits::DEFAULT_LIMIT, 20);
        assert_eq!(HistoryLimits::MAX_LIMIT, 100);
    }

    /// The row is buildable from the ENGINE's types (the binding, not a
    /// restatement): `mode` is `TxrRunMode`, `endpoint` is `TxrEndpoint`,
    /// `reason` is the engine's `TxrRunReason` and the detail's `methods`
    /// are the engine's own `TxrRunMethod` rows — the wire spellings come
    /// from those derives (`train`/`reuse`, `pfs`/`os`).
    #[test]
    fn engine_vocabulary_is_bound_not_restated() {
        let reason = TxrRunReason {
            code: "REQUIRED_MARKER_MISSING".to_string(),
            detail: "marker LDH is missing from the measurements".to_string(),
        };
        let item = TxrHistoryItem {
            id: Uuid::nil(),
            mode: TxrRunMode::Train,
            bucket: TxrHistoryBucket::Finished,
            created_at: DateTime::<Utc>::from_timestamp(0, 0).expect("epoch"),
            started_at: None,
            finished_at: None,
            elapsed_secs: Some(190),
            estimate_total_seconds: Some(240.0),
            method_count: 2,
            file_names: vec!["patients.csv".to_string()],
            learned_from: Some(151),
            predicted: Some(38),
            markers: 5,
            endpoint: TxrEndpoint::Pfs,
            decision_day: 56.0,
            look_ahead_day: 238.0,
            methods: vec![TxrHistoryMethodRef {
                id: "landmark-cox-current".to_string(),
                version: "1.0".to_string(),
                elapsed_secs: Some(120),
            }],
            reason: Some(reason),
            models_made: TxrHistoryModelsMade {
                produced: 2,
                saved_sets: vec![],
            },
            models_used: vec![],
            copies_kept: true,
            can_rerun: true,
            can_reopen: true,
            can_download: true,
            dir: "/data-root/analysis-2026-10-26-1002-00000001".to_string(),
            markers_saved: false,
        };
        let json = serde_json::to_value(&item).expect("serialize");
        assert_eq!(json["mode"], "train");
        assert_eq!(json["bucket"], "finished");
        assert_eq!(json["endpoint"], "pfs");
        assert_eq!(json["reason"]["code"], "REQUIRED_MARKER_MISSING");
        assert_eq!(json["reason"]["detail"], "marker LDH is missing from the measurements");
        let _back: TxrHistoryItem = serde_json::from_value(json).expect("deserialize");

        let detail = TxrHistoryDetail {
            id: Uuid::nil(),
            mode: TxrRunMode::Reuse,
            bucket: TxrHistoryBucket::Finished,
            created_at: DateTime::<Utc>::from_timestamp(0, 0).expect("epoch"),
            started_at: None,
            finished_at: None,
            elapsed_secs: Some(120),
            estimate_total_seconds: None,
            method_count: 1,
            file_names: vec!["march_new.csv".to_string()],
            learned_from: None,
            predicted: Some(22),
            markers: 5,
            endpoint: TxrEndpoint::Pfs,
            decision_day: 56.0,
            look_ahead_day: 238.0,
            methods: vec![],
            reason: None,
            models_made: TxrHistoryModelsMade {
                produced: 0,
                saved_sets: vec![],
            },
            models_used: vec![TxrHistoryModelRef {
                set_id: Uuid::nil(),
                set_name: "CRC cohort, day 56".to_string(),
                model_id: Uuid::nil(),
                model_name: "cox-cutpoint-risk".to_string(),
            }],
            copies_kept: true,
            can_rerun: true,
            can_reopen: true,
            can_download: true,
            dir: "/data-root/analysis-2026-10-19-1436-00000002".to_string(),
            markers_saved: false,
            file_sizes: vec![],
            settings: TxrRunSettingsView {
                endpoint: TxrEndpoint::Pfs,
                decision_day: 56.0,
                look_ahead_day: 238.0,
                covariates: true,
                seed: Some(1),
                cpus: Some(4),
                memory_total_bytes: Some(16 * 1024 * 1024 * 1024),
                at_a_time: 4,
                save_models: false,
                mode: TxrRunMode::Reuse,
            },
            models_saved: vec![],
            log_line_count: 42,
            copies: TxrHistoryCopies {
                kept: true,
                cleared_at: None,
            },
            dir_bytes: Some(312 * 1024 * 1024),
            use_estimate: Some(TxrHistoryEstimate {
                total_seconds: 240.0,
                estimate_quality: TimingQuality::Estimate,
            }),
        };
        let json = serde_json::to_value(&detail).expect("serialize");
        assert_eq!(json["mode"], "reuse");
        assert_eq!(json["models_used"][0]["set_name"], "CRC cohort, day 56");
        assert_eq!(json["use_estimate"]["total_seconds"], 240.0);
        let _back: TxrHistoryDetail = serde_json::from_value(json).expect("deserialize");
    }
}
