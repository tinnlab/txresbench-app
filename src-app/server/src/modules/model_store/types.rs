//! The `model_store` type contract — the serde + JsonSchema surface of every
//! request and response the module owns (PROV-MS-2..MS-9): the inventory
//! projections (`ModelSummary` / `ModelDetail` / `SetSummary`), the save /
//! rename / delete bodies, the `.txr` import outcome, the verified-asset
//! resolution payload and the per-model eligibility verdicts.
//!
//! Every type in this file is a WIRE shape; the persisted rows are one level
//! narrower (the repository / migration half, ITEM-2). The provider-typed
//! fields below are bound to the providers' own types, never re-declared:
//! - `RequiredMarkers`, `MarkerKind`, `UsesHistory`, `CovariateMode`,
//!   `EligibilityStatus`, `ReasonCode` (through [`ModelReasonCode`]),
//!   `MissingMarker`, `Coverage`, `MinDraws`, `TimingQuality` and
//!   `InventoryEligibilityRequest` come from `method_catalogue` (PROV-MC-1/5/7);
//! - `TxrTask`, `TxrEndpoint` and `TxrMethodEnv` come from `execution_engine`
//!   (PROV-EE-2/9) — a model recorded against the engine's own typed
//!   vocabulary renders without a second normalizer, and the resolution
//!   payload is byte-compatible with the engine's asset element by
//!   construction (PROV-EE-9's caller-side join shape).
//!
//! INV-2's discipline holds for the types: a model tree is opaque bytes (the
//! record carries the digest + dir, never a parsed meaning); `features` /
//! `required_markers` / `marker_facts` are RECORDED facts, and the eligibility
//! vocabulary is the provider's (plus the store's own
//! `MODEL_REQUIREMENTS_UNRECORDED` for a container that carried none).

use std::collections::BTreeMap;

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::modules::execution_engine::types::{TxrEndpoint, TxrMethodEnv, TxrTask};
use crate::modules::method_catalogue::types::{
    CovariateMode, Coverage, EligibilityStatus, InventoryEligibilityRequest, MarkerKind,
    MinDraws, MissingMarker, ReasonCode, RequiredMarkers, TimingQuality, UsesHistory,
};

// ─────────────────────────────────────────────────────────────────────────────
// Limits (DEC-13) — fixed, named defensive bounds on untrusted input files and
// request fan-out, in ONE place to promote.
// ─────────────────────────────────────────────────────────────────────────────

/// The module's defensive bounds (DEC-13: anti-footgun constants on an
/// untrusted `.txr` input and on request fan-out, not operational tunables).
pub struct ModelStoreLimits;

impl ModelStoreLimits {
    /// `POST /api/txr/models/save` `method_ids` ceiling (PROV-MS-3).
    pub const MAX_MODELS_PER_SAVE: usize = 64;
    /// `POST /api/txr/models/eligibility` `model_ids` ceiling (PROV-MS-9).
    pub const MAX_ELIGIBILITY_MODELS: usize = 200;
    /// The `.txr` container size cap (DEC-4/13; a colleague's file is an
    /// untrusted input — 16 GiB leaves every real model set room while
    /// bounding a single import).
    pub const MAX_CONTAINER_BYTES: u64 = 16 * 1024 * 1024 * 1024;
    /// Set / model display-name ceiling (PROV-MS-3's `INVALID_SET_NAME`).
    pub const MAX_NAME_LEN: usize = 80;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request validation (the routes' 400 layer)
// ─────────────────────────────────────────────────────────────────────────────

/// A save/rename/resolve/eligibility validation failure — the named 400 of the
/// routes' typed-body extractor (the `TxrRequestError` precedent).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRequestError {
    pub code: ModelRequestErrorCode,
    /// The offending field path (`method_ids`, `target.set_id`, …).
    pub field: String,
    pub message: String,
}

impl std::fmt::Display for ModelRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: {} ({})",
            self.code.code(),
            self.message,
            self.field
        )
    }
}

impl std::error::Error for ModelRequestError {}

/// The 400 machine codes of the module's request validation (PROV-MS-3/8/9's
/// named error set; the repository/container/resolve failures carry their own
/// codes at the route layer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelRequestErrorCode {
    EmptyMethods,
    InvalidSetName,
    InvalidTarget,
    InvalidName,
    EmptyModels,
    TooManyModels,
}

impl ModelRequestErrorCode {
    /// The stable machine code of the failure.
    pub fn code(self) -> &'static str {
        match self {
            ModelRequestErrorCode::EmptyMethods => "EMPTY_METHODS",
            ModelRequestErrorCode::InvalidSetName => "INVALID_SET_NAME",
            ModelRequestErrorCode::InvalidTarget => "INVALID_TARGET",
            ModelRequestErrorCode::InvalidName => "INVALID_NAME",
            ModelRequestErrorCode::EmptyModels => "EMPTY_MODELS",
            ModelRequestErrorCode::TooManyModels => "TOO_MANY_MODELS",
        }
    }
}

fn too_many_models(code: ModelRequestErrorCode, field: &str, max: usize, got: usize) -> ModelRequestError {
    ModelRequestError {
        code,
        field: field.to_string(),
        message: format!("at most {max} model ids, got {got}"),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Save (PROV-MS-3)
// ─────────────────────────────────────────────────────────────────────────────

/// The save target — EXACTLY one of the two arms (L's "Name of this set" is
/// `set_name`, L2's "into an existing set" is `set_id`). `deny_unknown_fields`
/// on the untagged enum makes a payload carrying BOTH arms fail as loud as one
/// carrying neither (an untagged match would otherwise silently keep the first
/// arm and ignore the second).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
pub enum SaveTarget {
    NewSet {
        set_name: String,
    },
    ExistingSet {
        set_id: Uuid,
    },
}

/// `POST /api/txr/models/save` (PROV-MS-3): save the run's produced models into
/// a new or existing set, optionally keeping the training files + writing the
/// one-off `.txr` export.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SaveModelsRequest {
    pub run_id: Uuid,
    /// The run's produced models to save (≥ 1 — the run seam's method ids).
    pub method_ids: Vec<String>,
    pub target: SaveTarget,
    /// Copy the run dir's `input/` files into `<data_root>/models/training/
    /// <set_id>/` (the L board's "keep the training files" checkbox; default
    /// false).
    #[serde(default)]
    pub keep_training_files: bool,
    /// Also write `<data_root>/models/exports/<set-name-slug>-<id8>.txr`
    /// (the "Also save as a file" checkbox).
    #[serde(default)]
    pub also_export: bool,
    /// The source file's name the save dialog showed (e.g. `patients.csv`);
    /// recorded on the set for the I-board "trained on patients.csv" line.
    /// The engine-grown run `input_summary.file_names.patients` is the
    /// fallback when omitted (CONS-MS-6b / GAP-D) — always engine truth,
    /// never the run dir stem.
    #[serde(default)]
    pub source_label: Option<String>,
}

/// The one-off export record of a save (PROV-MS-3's `also_export` arm) — the
/// file is already written; `dir` is where the user's "Open the folder" points.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ExportTarget {
    pub name: String,
    pub size_bytes: u64,
    pub dir: String,
}

/// The save response (201): the set (created or grown), the saved rows and the
/// optional one-off export.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelSaveResponse {
    pub set: SetSummary,
    pub models: Vec<ModelSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<ExportTarget>,
}

impl SaveModelsRequest {
    /// The save request rules (in check order — the first failure names the
    /// 400):
    /// - `method_ids` must be non-empty (`EMPTY_METHODS`);
    /// - a `set_name` target must be non-empty and ≤
    ///   [`ModelStoreLimits::MAX_NAME_LEN`] (`INVALID_SET_NAME`);
    /// - `target` must be exactly one arm (`INVALID_TARGET` — enforced at
    ///   deserialization by the untagged `deny_unknown_fields` shape; this
    ///   arm is the direct statement of the rule);
    /// - `method_ids` ≤ [`ModelStoreLimits::MAX_MODELS_PER_SAVE`]
    ///   (`TOO_MANY_MODELS`).
    pub fn validate(&self) -> Result<(), ModelRequestError> {
        if self.method_ids.is_empty() {
            return Err(ModelRequestError {
                code: ModelRequestErrorCode::EmptyMethods,
                field: "method_ids".to_string(),
                message: "at least one method id is required".to_string(),
            });
        }
        if self.method_ids.len() > ModelStoreLimits::MAX_MODELS_PER_SAVE {
            return Err(too_many_models(
                ModelRequestErrorCode::TooManyModels,
                "method_ids",
                ModelStoreLimits::MAX_MODELS_PER_SAVE,
                self.method_ids.len(),
            ));
        }
        match &self.target {
            SaveTarget::NewSet { set_name } => {
                let n = set_name.trim();
                if n.is_empty() || n.chars().count() > ModelStoreLimits::MAX_NAME_LEN {
                    return Err(ModelRequestError {
                        code: ModelRequestErrorCode::InvalidSetName,
                        field: "target.set_name".to_string(),
                        message: format!(
                            "set name must be 1..={} chars",
                            ModelStoreLimits::MAX_NAME_LEN
                        ),
                    });
                }
            }
            SaveTarget::ExistingSet { .. } => {}
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inventory (PROV-MS-2 / PROV-MS-4 / PROV-MS-5)
// ─────────────────────────────────────────────────────────────────────────────

/// A model's provenance kind (DEC-16: the user's own `.txr` file needs no
/// licence — the J board's "not recorded" rows; pretrained installs require
/// one, enforced at the pretrained seam).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelProvenance {
    Run,
    Imported,
    Pretrained,
}

impl ModelProvenance {
    /// The stored/wire spelling (the serde derive's `snake_case`).
    pub fn as_str(self) -> &'static str {
        match self {
            ModelProvenance::Run => "run",
            ModelProvenance::Imported => "imported",
            ModelProvenance::Pretrained => "pretrained",
        }
    }
}

/// The inventory list row (the J screen's model line + the I screen's
/// per-model rows). Query-parameter projections are optional and
/// `serde(default)`-free inside list responses: `models_dir` is grown at
/// reconcile (CONS-UM-4 — "Open the folder" + "Models are stored in …"
/// render the real path; null renders the footnote pathless).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelSummary {
    pub id: Uuid,
    pub set_id: Option<Uuid>,
    pub set_name: Option<String>,
    /// The display label (default = the catalogue label at save).
    pub name: String,
    pub method_id: String,
    pub method_version: String,
    pub group: String,
    pub group_label: String,
    /// The outcome task the model was fitted as (`null` until the run's method
    /// row classifies it — the run seam's [`TxrTask`]).
    pub task: Option<TxrTask>,
    pub provenance: ModelProvenance,
    /// The `.txr` file name for `imported` provenance (board J: "opened from
    /// breast-panel.txr").
    pub imported_from: Option<String>,
    pub pretrained_catalogue_id: Option<String>,
    /// The asset version of the pretrained row, so a strict id+version match
    /// can be made without a detail fetch (GAP-PC-3 / TEST-MS-24).
    pub pretrained_catalogue_version: Option<String>,
    /// The data licence declared at install (`pretrained` always; `null` for
    /// a user's own rows — the J board's "not recorded").
    pub licence: Option<String>,
    pub trained_on_patients: Option<u32>,
    /// The run's `finished_at` (RFC3339 UTC — the I board's "trained 19 Oct").
    pub trained_at: Option<DateTime<Utc>>,
    pub decision_day: f64,
    pub endpoint: TxrEndpoint,
    pub horizon: f64,
    /// Sum of the tree files (the run record's size — the engine's dir walk;
    /// GAP-B).
    pub size_bytes: u64,
    /// The catalogue's `embeds_training_data` fact verbatim (GAP-A / DEC-9 —
    /// the L dialog's ⚠ is data, never app-invented).
    pub embeds_training_data: bool,
    /// The engine-computed cross-check (GAP-C — "own data, cross-checked:
    /// AUC 0.66"; null when the outcome/data does not allow it).
    pub own_auc: Option<f64>,
    /// Mirrors the row's `marker_facts.count` (TEST-MS-24 — the J "N markers"
    /// subline with no per-row detail fetch).
    pub marker_count: Option<u32>,
    /// Mirrors the row's `marker_facts.kind` — the catalogue's marker mode
    /// (qa-fixes ITEM-5, RES-19): a `count` of 0 with kind `any` IS "any
    /// marker" — the J subline renders the kind's word, never a "0 markers".
    pub marker_kind: Option<MarkerKind>,
    /// Mirrors the row's `covariates.used` (the J "uses age" subline).
    pub uses_covariates: bool,
    pub created_at: DateTime<Utc>,
}

/// `GET /api/txr/models` (PROV-MS-2; no pagination — DEC-19).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelListResponse {
    pub models: Vec<ModelSummary>,
    pub total: u32,
    /// `<data_root>/models` (exposed ONCE here — CONS-UM-4's "Open the
    /// folder"; `null` renders the pathless footnote).
    pub models_dir: Option<String>,
}

/// The inventory list's optional filters (all optional; `q` is a substring on
/// the model's name / method id).
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
pub struct ModelListQuery {
    #[serde(default)]
    pub set_id: Option<Uuid>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub provenance: Option<ModelProvenance>,
}

/// A set row of the J/I screens (PROV-MS-4).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct SetSummary {
    pub id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
    pub source_run_id: Option<Uuid>,
    /// The `patients.csv`-style label the save dialog showed (engine truth,
    /// never the run dir stem).
    pub source_label: Option<String>,
    pub keep_training_files: bool,
    /// `<data_root>/models/training/<set_id>` (null when not kept).
    pub training_dir: Option<String>,
    pub model_count: u32,
    pub total_size_bytes: u64,
}

/// `GET /api/txr/model-sets` (PROV-MS-4; no pagination — DEC-19).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelSetListResponse {
    pub sets: Vec<SetSummary>,
    pub total: u32,
}

/// The rename body (models + sets — board J's Rename).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RenameRequest {
    pub name: String,
}

impl RenameRequest {
    /// The rename rule: non-empty and ≤ [`ModelStoreLimits::MAX_NAME_LEN`].
    pub fn validate(&self) -> Result<(), ModelRequestError> {
        let n = self.name.trim();
        if n.is_empty() || n.chars().count() > ModelStoreLimits::MAX_NAME_LEN {
            return Err(ModelRequestError {
                code: ModelRequestErrorCode::InvalidName,
                field: "name".to_string(),
                message: format!(
                    "name must be 1..={} chars",
                    ModelStoreLimits::MAX_NAME_LEN
                ),
            });
        }
        Ok(())
    }
}

/// `DELETE /api/txr/model-sets/{id}` (PROV-MS-4): `keep_files=true` leaves the
/// tree + training files and removes the rows only (the I board's "Delete the
/// run's models" escape); the default (`false`) is the cascade that prunes
/// unreferenced trees.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(default)]
pub struct SetDeleteQuery {
    pub keep_files: bool,
}

impl Default for SetDeleteQuery {
    fn default() -> Self {
        Self { keep_files: false }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail (PROV-MS-2)
// ─────────────────────────────────────────────────────────────────────────────

/// The marker-input facts recorded on a saved model at save time (the
/// catalogue's [`MarkerKind`]/[`UsesHistory`] vocabulary verbatim — a model
/// INSTANCE's facts, since the D5-selected feature set is per instance).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MarkerFacts {
    pub kind: MarkerKind,
    pub count: u32,
    pub min_draws: u32,
    pub needs_baseline: bool,
    pub uses_history: UsesHistory,
    pub needs_detection_call: bool,
    pub marker_groups_required: Vec<String>,
}

/// The covariate facts of a saved model: the catalogue's mode + whether the
/// run actually ran with covariates on (both recorded at save — the J screen's
/// "uses age" is `used`, never a re-derivation).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CovariateFacts {
    pub catalogue: CovariateMode,
    pub used: bool,
}

/// A detail-level warning the inventory renders flag-only (board D18: the UI
/// renders the copy — the store carries the code + fact).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelWarning {
    pub code: ModelWarningCode,
    /// The fact-bearing detail line (e.g. the recorded vs current version).
    pub detail: String,
}

/// The warning code vocabulary. `MODEL_VERSION_MISMATCH` / `DIGEST_MISMATCH`
/// compare the RECORDED values against the catalogue's current ones — the
/// run's own provenance is kept either way, mirroring PROV-EE-9's
/// "row records both digests". `REQUIREMENTS_UNRECORDED` is an imported
/// container that carried no requirements (the store never invents them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum ModelWarningCode {
    #[serde(rename = "MODEL_VERSION_MISMATCH")]
    ModelVersionMismatch,
    #[serde(rename = "DIGEST_MISMATCH")]
    DigestMismatch,
    #[serde(rename = "REQUIREMENTS_UNRECORDED")]
    RequirementsUnrecorded,
}

impl ModelWarningCode {
    /// The closed code list, in documentation order.
    pub const ALL: [ModelWarningCode; 3] = [
        ModelWarningCode::ModelVersionMismatch,
        ModelWarningCode::DigestMismatch,
        ModelWarningCode::RequirementsUnrecorded,
    ];

    /// The code's wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            ModelWarningCode::ModelVersionMismatch => "MODEL_VERSION_MISMATCH",
            ModelWarningCode::DigestMismatch => "DIGEST_MISMATCH",
            ModelWarningCode::RequirementsUnrecorded => "REQUIREMENTS_UNRECORDED",
        }
    }
}

/// `GET /api/txr/models/{id}` (PROV-MS-2) — the summary flattened (the
/// engine's detail flatten precedent: the wire is one object) plus the
/// recorded requirements/digests the J footer, the engine bind and the
/// eligibility engine read.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelDetail {
    #[serde(flatten)]
    pub summary: ModelSummary,
    pub own_c: Option<f64>,
    /// 64-hex sha256 of the model tree (the store's content-addressed key —
    /// PROV-SS-3's algorithm, the engine's own digest).
    pub tree_sha256: String,
    /// Absolute path of the tree (J's "Open the folder" + the engine bind).
    pub dir: String,
    /// The container contract version the tree was produced under (X1's
    /// contract, e.g. "2.0").
    pub contract: String,
    pub env: TxrMethodEnv,
    /// The run's selected feature keys (the engine's params — recorded, never
    /// re-derived).
    pub features: Vec<String>,
    /// The catalogue's required-marker rule (verbatim — PROV-MC-1).
    pub required_markers: Option<RequiredMarkers>,
    pub marker_facts: MarkerFacts,
    pub covariates: CovariateFacts,
    pub warnings: Vec<ModelWarning>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Import / export (PROV-MS-6 / PROV-MS-7)
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/models/import` (201) — the restored rows + the set they were
/// imported into. `set_id` is null when the multipart carried no `set_id`
/// form field (the container's recorded set is then recreated fresh); the
/// reader's default-set rule lives in `store.rs`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ImportOutcome {
    pub models: Vec<ModelSummary>,
    pub set_id: Option<Uuid>,
}

// ─────────────────────────────────────────────────────────────────────────────
// Reuse resolution (PROV-MS-8 — the `execution-engine` reuse contract)
// ─────────────────────────────────────────────────────────────────────────────

/// `POST /api/txr/models/resolve` (PROV-MS-8): the ids to re-verify + hand off.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResolveRequest {
    pub model_ids: Vec<String>,
}

impl ResolveRequest {
    /// The resolve rules (PROV-MS-8's `400 EMPTY_MODELS` + the 1..=64 bound).
    pub fn validate(&self) -> Result<(), ModelRequestError> {
        if self.model_ids.is_empty() {
            return Err(ModelRequestError {
                code: ModelRequestErrorCode::EmptyModels,
                field: "model_ids".to_string(),
                message: "at least one model id is required".to_string(),
            });
        }
        if self.model_ids.len() > ModelStoreLimits::MAX_MODELS_PER_SAVE {
            return Err(too_many_models(
                ModelRequestErrorCode::TooManyModels,
                "model_ids",
                ModelStoreLimits::MAX_MODELS_PER_SAVE,
                self.model_ids.len(),
            ));
        }
        Ok(())
    }
}

/// `ResolveResponse` (PROV-MS-8).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResolveResponse {
    pub assets: Vec<ResolvedAsset>,
}

/// One verified asset (PROV-MS-8 / CONS-MS-9) — byte-compatible with
/// `execution_engine::types::TxrModelAsset`'s `model_ids[]` element so
/// `ui-models` passes the response straight through into
/// `CreateRunRequest.model_ids` (DEC-10: the join happens at the caller; the
/// engine never imports this module).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResolvedAsset {
    pub model_id: String,
    pub host_dir: String,
    pub tree_sha256: String,
    pub method_id: String,
    pub method_version: String,
    pub env: TxrMethodEnv,
    pub contract: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-model eligibility (PROV-MS-9 — the I list)
// ─────────────────────────────────────────────────────────────────────────────

/// The one request shape `ui-list` feeds both eligibility engines: the file
/// inventory PROV-MC-5's `InventoryEligibilityRequest` carries (VERBATIM — this
/// module imports the provider's type, it does not restate it), plus the
/// model ids to score.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelEligibilityRequest {
    pub model_ids: Vec<String>,
    pub inventory: InventoryEligibilityRequest,
}

impl ModelEligibilityRequest {
    /// The eligibility rules (PROV-MS-9's `400 EMPTY_MODELS` + the 1..=200
    /// bound).
    pub fn validate(&self) -> Result<(), ModelRequestError> {
        if self.model_ids.is_empty() {
            return Err(ModelRequestError {
                code: ModelRequestErrorCode::EmptyModels,
                field: "model_ids".to_string(),
                message: "at least one model id is required".to_string(),
            });
        }
        if self.model_ids.len() > ModelStoreLimits::MAX_ELIGIBILITY_MODELS {
            return Err(too_many_models(
                ModelRequestErrorCode::TooManyModels,
                "model_ids",
                ModelStoreLimits::MAX_ELIGIBILITY_MODELS,
                self.model_ids.len(),
            ));
        }
        Ok(())
    }
}

/// The model eligibility reason-code vocabulary: PROV-MC-5's [`ReasonCode`]
/// set (the SAME wire strings — a per-code renderer in the UI never meets an
/// undocumented code) plus the store's own `MODEL_REQUIREMENTS_UNRECORDED`
/// (DEC-6: a container that carried no requirements is `cannot_run` with that
/// reason — the store never invents requirements). The `from_catalogue` mapper
/// is exhaustive: a new provider code fails to compile here instead of
/// silently passing through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum ModelReasonCode {
    #[serde(rename = "REQUIRED_MARKER_MISSING")]
    RequiredMarkerMissing,
    #[serde(rename = "MARKER_GROUP_MISSING")]
    MarkerGroupMissing,
    #[serde(rename = "DETECTION_CALL_MISSING")]
    DetectionCallMissing,
    #[serde(rename = "MIN_DRAWS_UNMET")]
    MinDrawsUnmet,
    #[serde(rename = "COVARIATE_MISSING")]
    CovariateMissing,
    #[serde(rename = "COVARIATE_REQUIRED_UNMET")]
    CovariateRequiredUnmet,
    #[serde(rename = "UNIT_MISMATCH")]
    UnitMismatch,
    #[serde(rename = "DECISION_DAY_UNMET")]
    DecisionDayUnmet,
    #[serde(rename = "NOT_RUNNABLE")]
    NotRunnable,
    #[serde(rename = "ENV_IMAGE_MISSING")]
    EnvImageMissing,
    #[serde(rename = "TASK_INCOMPATIBLE")]
    TaskIncompatible,
    #[serde(rename = "RESPONSE_LABEL_MISSING")]
    ResponseLabelMissing,
    #[serde(rename = "SURVIVAL_OUTCOME_MISSING")]
    SurvivalOutcomeMissing,
    #[serde(rename = "MODEL_REQUIREMENTS_UNRECORDED")]
    ModelRequirementsUnrecorded,
}

impl ModelReasonCode {
    /// The closed code list, in documentation order (13 provider codes + the
    /// store's own).
    pub const ALL: [ModelReasonCode; 14] = [
        ModelReasonCode::RequiredMarkerMissing,
        ModelReasonCode::MarkerGroupMissing,
        ModelReasonCode::DetectionCallMissing,
        ModelReasonCode::MinDrawsUnmet,
        ModelReasonCode::CovariateMissing,
        ModelReasonCode::CovariateRequiredUnmet,
        ModelReasonCode::UnitMismatch,
        ModelReasonCode::DecisionDayUnmet,
        ModelReasonCode::NotRunnable,
        ModelReasonCode::EnvImageMissing,
        ModelReasonCode::TaskIncompatible,
        ModelReasonCode::ResponseLabelMissing,
        ModelReasonCode::SurvivalOutcomeMissing,
        ModelReasonCode::ModelRequirementsUnrecorded,
    ];

    /// The code's wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            ModelReasonCode::RequiredMarkerMissing => "REQUIRED_MARKER_MISSING",
            ModelReasonCode::MarkerGroupMissing => "MARKER_GROUP_MISSING",
            ModelReasonCode::DetectionCallMissing => "DETECTION_CALL_MISSING",
            ModelReasonCode::MinDrawsUnmet => "MIN_DRAWS_UNMET",
            ModelReasonCode::CovariateMissing => "COVARIATE_MISSING",
            ModelReasonCode::CovariateRequiredUnmet => "COVARIATE_REQUIRED_UNMET",
            ModelReasonCode::UnitMismatch => "UNIT_MISMATCH",
            ModelReasonCode::DecisionDayUnmet => "DECISION_DAY_UNMET",
            ModelReasonCode::NotRunnable => "NOT_RUNNABLE",
            ModelReasonCode::EnvImageMissing => "ENV_IMAGE_MISSING",
            ModelReasonCode::TaskIncompatible => "TASK_INCOMPATIBLE",
            ModelReasonCode::ResponseLabelMissing => "RESPONSE_LABEL_MISSING",
            ModelReasonCode::SurvivalOutcomeMissing => "SURVIVAL_OUTCOME_MISSING",
            ModelReasonCode::ModelRequirementsUnrecorded => "MODEL_REQUIREMENTS_UNRECORDED",
        }
    }

    /// The provider code → store code mapping (1:1; the exhaustiveness IS the
    /// drift guard — TEST-MS-12's "a drift in the provider's semantics cannot
    /// pass silently").
    pub fn from_catalogue(code: ReasonCode) -> Self {
        match code {
            ReasonCode::RequiredMarkerMissing => ModelReasonCode::RequiredMarkerMissing,
            ReasonCode::MarkerGroupMissing => ModelReasonCode::MarkerGroupMissing,
            ReasonCode::DetectionCallMissing => ModelReasonCode::DetectionCallMissing,
            ReasonCode::MinDrawsUnmet => ModelReasonCode::MinDrawsUnmet,
            ReasonCode::CovariateMissing => ModelReasonCode::CovariateMissing,
            ReasonCode::CovariateRequiredUnmet => ModelReasonCode::CovariateRequiredUnmet,
            ReasonCode::UnitMismatch => ModelReasonCode::UnitMismatch,
            ReasonCode::DecisionDayUnmet => ModelReasonCode::DecisionDayUnmet,
            ReasonCode::NotRunnable => ModelReasonCode::NotRunnable,
            ReasonCode::EnvImageMissing => ModelReasonCode::EnvImageMissing,
            ReasonCode::TaskIncompatible => ModelReasonCode::TaskIncompatible,
            ReasonCode::ResponseLabelMissing => ModelReasonCode::ResponseLabelMissing,
            ReasonCode::SurvivalOutcomeMissing => ModelReasonCode::SurvivalOutcomeMissing,
        }
    }
}

/// One structured reason of a model verdict (code + per-code params; the
/// display strings are the consumer's).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelReason {
    pub code: ModelReasonCode,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, serde_json::Value>,
}

/// One model's I-list verdict (PROV-MS-9). `task` is the model's recorded
/// outcome task and `endpoint` its recorded endpoint — the verdict is always
/// about the model the user saved, never about the catalogue entry alone.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelEligibility {
    pub id: String,
    pub task: Option<TxrTask>,
    pub endpoint: TxrEndpoint,
    pub status: EligibilityStatus,
    pub reasons: Vec<ModelReason>,
    /// The provider's [`MissingMarker`] shape (the board's "2 lack LDH" list).
    pub missing_markers: Vec<MissingMarker>,
    pub coverage: Coverage,
    pub min_draws: MinDraws,
    /// The catalogue estimator's value for the model's method; null when the
    /// method is absent from the catalogue (an imported model of a method the
    /// app no longer ships — the verdict still stands without a time).
    pub estimated_seconds: Option<f64>,
    /// The estimator's fact quality (measured from the benchmark, else the
    /// language fallback) — the plan's PROV-MC-6 pairing.
    pub estimate_quality: TimingQuality,
}

/// The eligibility response: per-model verdicts plus the screen totals.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ModelEligibilityResponse {
    pub models: Vec<ModelEligibility>,
    pub total_fit: u32,
    pub total_some: u32,
    pub total_cannot: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// The route doc-id vocabulary (the routes' `.id(...)` seam — the inventory is
// the registration; the ids are emitted into the OpenAPI spec and the
// generated client, so a rename is one edit, and the routes' own test binds
// the registered set to this constant — the engine's ROUTE_DOC_IDS precedent).
// ─────────────────────────────────────────────────────────────────────────────
pub const ROUTE_DOC_IDS: [&str; 13] = [
    "Models.listModels",
    "Models.getModel",
    "Models.saveModels",
    "Models.importModel",
    "Models.exportModel",
    "Models.renameModel",
    "Models.deleteModel",
    "Models.resolveModels",
    "Models.checkEligibility",
    "ModelSets.listSets",
    "ModelSets.renameSet",
    "ModelSets.deleteSet",
    "ModelSets.exportSet",
];

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the ITEM-1 contract pins (TEST-MS-02): wire spellings, the doc-id
// vocabulary, the validation rules and the engine shape compatibility.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::execution_engine::types::TxrModelAsset;

    /// The wire types generate schemas — a schemars limitation surfaces at
    /// the first regen that references them, never silently.
    #[test]
    fn api_types_generate_schemas() {
        let _ = schemars::schema_for!(ModelSummary);
        let _ = schemars::schema_for!(ModelDetail);
        let _ = schemars::schema_for!(ModelListResponse);
        let _ = schemars::schema_for!(ModelListQuery);
        let _ = schemars::schema_for!(SetSummary);
        let _ = schemars::schema_for!(ModelSetListResponse);
        let _ = schemars::schema_for!(SaveModelsRequest);
        let _ = schemars::schema_for!(SaveTarget);
        let _ = schemars::schema_for!(ModelSaveResponse);
        let _ = schemars::schema_for!(RenameRequest);
        let _ = schemars::schema_for!(SetDeleteQuery);
        let _ = schemars::schema_for!(ImportOutcome);
        let _ = schemars::schema_for!(ResolveRequest);
        let _ = schemars::schema_for!(ResolveResponse);
        let _ = schemars::schema_for!(ResolvedAsset);
        let _ = schemars::schema_for!(ModelEligibilityRequest);
        let _ = schemars::schema_for!(ModelEligibilityResponse);
        let _ = schemars::schema_for!(ModelEligibility);
        let _ = schemars::schema_for!(ModelReason);
        let _ = schemars::schema_for!(ModelReasonCode);
        let _ = schemars::schema_for!(ModelProvenance);
        let _ = schemars::schema_for!(ModelWarning);
        let _ = schemars::schema_for!(ModelWarningCode);
        let _ = schemars::schema_for!(MarkerFacts);
        let _ = schemars::schema_for!(CovariateFacts);
    }

    /// The closed-vocabulary spellings: `provenance`, `status` and `endpoint`
    /// wire strings are the ones consumers switch on.
    #[test]
    fn enum_wire_spellings_are_declared() {
        for (p, wire) in [
            (ModelProvenance::Run, "run"),
            (ModelProvenance::Imported, "imported"),
            (ModelProvenance::Pretrained, "pretrained"),
        ] {
            let json = serde_json::to_value(p).expect("serialize");
            assert_eq!(json.as_str().expect("string"), wire);
            assert_eq!(p.as_str(), wire);
        }
        for (s, wire) in [
            (EligibilityStatus::CanRun, "can_run"),
            (EligibilityStatus::CanRunSome, "can_run_some"),
            (EligibilityStatus::CannotRun, "cannot_run"),
        ] {
            let json = serde_json::to_value(s).expect("serialize");
            assert_eq!(json.as_str().expect("string"), wire);
        }
        for (e, wire) in [(TxrEndpoint::Pfs, "pfs"), (TxrEndpoint::Os, "os")] {
            let json = serde_json::to_value(e).expect("serialize");
            assert_eq!(json.as_str().expect("string"), wire);
        }
        // The reason vocabulary is the provider's, spelled identically, plus
        // the store's own code.
        for code in ReasonCode::ALL {
            let mapped = ModelReasonCode::from_catalogue(code);
            assert_eq!(
                mapped.as_str(),
                code.as_str(),
                "store code must preserve the provider wire string"
            );
            let json = serde_json::to_value(mapped).expect("serialize");
            assert_eq!(json.as_str().expect("string"), code.as_str());
        }
        let json = serde_json::to_value(ModelReasonCode::ModelRequirementsUnrecorded)
            .expect("serialize");
        assert_eq!(json.as_str().expect("string"), "MODEL_REQUIREMENTS_UNRECORDED");

        // The warning codes round-trip.
        for code in ModelWarningCode::ALL {
            let json = serde_json::to_value(code).expect("serialize");
            let back: ModelWarningCode = serde_json::from_value(json.clone()).expect("deserialize");
            assert_eq!(back, code);
            assert_eq!(json.as_str().expect("string"), code.as_str());
        }
    }

    /// The doc-id vocabulary is exactly the 13 plan-pinned ids (the aide
    /// `operationId` values the OpenAPI regen must contain once the routes
    /// register — the routes' own suite binds the registered set to this).
    #[test]
    fn route_doc_ids_are_exactly_the_13_pinned() {
        assert_eq!(
            ROUTE_DOC_IDS,
            [
                "Models.listModels",
                "Models.getModel",
                "Models.saveModels",
                "Models.importModel",
                "Models.exportModel",
                "Models.renameModel",
                "Models.deleteModel",
                "Models.resolveModels",
                "Models.checkEligibility",
                "ModelSets.listSets",
                "ModelSets.renameSet",
                "ModelSets.deleteSet",
                "ModelSets.exportSet",
            ]
        );
        let mut sorted = ROUTE_DOC_IDS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ROUTE_DOC_IDS.len(), "ids are distinct");
    }

    fn set_name_target(name: &str) -> SaveTarget {
        SaveTarget::NewSet {
            set_name: name.to_string(),
        }
    }

    /// SaveModelsRequest validation (TEST-MS-02): empty methods, over-long set
    /// names, and the exactly-one-arm target rule.
    #[test]
    fn save_request_validation_rules() {
        let base = |method_ids: Vec<String>, target: SaveTarget| SaveModelsRequest {
            run_id: Uuid::new_v4(),
            method_ids,
            target,
            keep_training_files: false,
            also_export: false,
            source_label: None,
        };

        // Empty method_ids → EMPTY_METHODS.
        let err = base(vec![], set_name_target("CRC cohort")).validate().unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::EmptyMethods);
        assert_eq!(err.field, "method_ids");

        // A set_name over 80 chars → INVALID_SET_NAME.
        let long = "x".repeat(ModelStoreLimits::MAX_NAME_LEN + 1);
        let err = base(vec!["dynforest".into()], set_name_target(&long))
            .validate()
            .unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::InvalidSetName);
        assert_eq!(err.field, "target.set_name");

        // Empty set name → INVALID_SET_NAME.
        let err = base(vec!["dynforest".into()], set_name_target("  "))
            .validate()
            .unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::InvalidSetName);

        // A target carrying BOTH arms is refused at deserialization (untagged
        // + deny_unknown_fields), so `validate()` never sees a both-arms value.
        let both = serde_json::json!({
            "run_id": Uuid::new_v4(),
            "method_ids": ["dynforest"],
            "target": {"set_name": "CRC cohort", "set_id": Uuid::new_v4()},
        });
        assert!(
            serde_json::from_value::<SaveModelsRequest>(both).is_err(),
            "both arms must be refused"
        );
        // … and so is neither.
        let neither = serde_json::json!({
            "run_id": Uuid::new_v4(),
            "method_ids": ["dynforest"],
            "target": {},
        });
        assert!(
            serde_json::from_value::<SaveModelsRequest>(neither).is_err(),
            "neither arm must be refused"
        );

        // The happy path validates; the defaults are false/null.
        let req = base(vec!["dynforest".into(), "landmark-cox-current".into()], set_name_target("CRC cohort"));
        req.validate().expect("valid");
        let parsed: SaveModelsRequest = serde_json::from_value(serde_json::to_value(&req).unwrap())
            .expect("round-trip");
        assert!(!parsed.keep_training_files);
        assert!(!parsed.also_export);
        assert!(parsed.source_label.is_none());
    }

    /// The fan-out bounds: resolve caps at 64, eligibility at 200; both reject
    /// empty lists.
    #[test]
    fn resolve_and_eligibility_fan_out_rules() {
        let many64: Vec<String> = (0..ModelStoreLimits::MAX_MODELS_PER_SAVE)
            .map(|i| format!("m{i}"))
            .collect();
        let many65: Vec<String> = (0..=ModelStoreLimits::MAX_MODELS_PER_SAVE)
            .map(|i| format!("m{i}"))
            .collect();
        let err = ResolveRequest { model_ids: vec![] }.validate().unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::EmptyModels);
        ResolveRequest { model_ids: many64 }.validate().expect("64 is the ceiling");
        let err = ResolveRequest { model_ids: many65 }.validate().unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::TooManyModels);
        assert_eq!(err.field, "model_ids");

        let inventory = InventoryEligibilityRequest {
            patients: 38,
            decision_day: 56.0,
            baseline_max_day: 0.0,
            markers: vec![],
            covariates: vec![],
            outcomes: None,
        };
        let eligibility_req =
            |model_ids: Vec<String>| ModelEligibilityRequest {
                model_ids,
                inventory: inventory.clone(),
            };
        let err = eligibility_req(vec![]).validate().unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::EmptyModels);

        let many200: Vec<String> = (0..ModelStoreLimits::MAX_ELIGIBILITY_MODELS)
            .map(|i| format!("m{i}"))
            .collect();
        let many201: Vec<String> = (0..=ModelStoreLimits::MAX_ELIGIBILITY_MODELS)
            .map(|i| format!("m{i}"))
            .collect();
        eligibility_req(many200)
            .validate()
            .expect("200 is the eligibility ceiling");
        let err = eligibility_req(many201).validate().unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::TooManyModels);
    }

    /// The rename rule (non-empty, ≤ 80).
    #[test]
    fn rename_validation_rule() {
        RenameRequest {
            name: "CRC cohort, day 56".into(),
        }
        .validate()
        .expect("a normal name validates");
        let err = RenameRequest { name: " ".into() }.validate().unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::InvalidName);
        let err = RenameRequest {
            name: "x".repeat(ModelStoreLimits::MAX_NAME_LEN + 1),
        }
        .validate()
        .unwrap_err();
        assert_eq!(err.code, ModelRequestErrorCode::InvalidName);
    }

    /// The resolution payload is byte-compatible with the engine's asset
    /// element (PROV-EE-2/9's `CreateRunRequest.model_ids[]` shape) — a serde
    /// round-trip through the engine's OpenAPI model proves the join passes
    /// through unchanged.
    #[test]
    fn resolved_asset_is_byte_compatible_with_the_engine_element() {
        let engine_asset = TxrModelAsset {
            model_id: "model-id-1".into(),
            host_dir: "/data/models/trees/abc".into(),
            tree_sha256: "ab".repeat(32),
            method_id: "dynforest".into(),
            method_version: "1.0.0".into(),
            env: TxrMethodEnv {
                base_digest: "ba".repeat(32),
                layer_digest: "ca".repeat(32),
            },
            contract: "2.0".into(),
        };
        let json = serde_json::to_value(&engine_asset).expect("engine asset serializes");
        let mine: ResolvedAsset = serde_json::from_value(json.clone())
            .expect("store asset parses the engine payload");
        assert_eq!(serde_json::to_value(&mine).expect("store asset serializes"), json);
        assert_eq!(mine.env.base_digest, engine_asset.env.base_digest);
        assert_eq!(mine.env.layer_digest, engine_asset.env.layer_digest);

        // ModelEligibility carries the engine's typed vocabulary.
        let elig = ModelEligibility {
            id: "model-id-1".into(),
            task: Some(TxrTask::Pfs),
            endpoint: TxrEndpoint::Pfs,
            status: EligibilityStatus::CanRunSome,
            reasons: vec![ModelReason {
                code: ModelReasonCode::MinDrawsUnmet,
                params: BTreeMap::new(),
            }],
            missing_markers: vec![],
            coverage: Coverage {
                eligible: 30,
                total: 38,
                fraction: 30.0 / 38.0,
            },
            min_draws: MinDraws {
                required: 3,
                met: 30,
                unmet_patients: 8,
            },
            estimated_seconds: Some(42.0),
            estimate_quality: TimingQuality::Estimate,
        };
        let json = serde_json::to_value(&elig).expect("eligibility serializes");
        assert_eq!(json["task"], "pfs");
        assert_eq!(json["endpoint"], "pfs");
        assert_eq!(json["status"], "can_run_some");
        assert_eq!(json["reasons"][0]["code"], "MIN_DRAWS_UNMET");
    }
}
