//! The pretrained-catalogue wire contract (PROV-PC-1..PROV-PC-8) — every
//! request/response type of the module's eight operations, the catalogue
//! document shape the generator (`scripts/pretrained-catalogue/
//! gen_pretrained_catalogue.py`) emits and the server boot-validates, the
//! closed enum vocabularies, the aide doc ids and the request-validation
//! rules.
//!
//! ## Vocabulary ownership (the seam rule)
//!
//! The pretrained card is DATA assembled from the siblings' declarations —
//! the method facts (`data/method-catalogue/catalogue.json`, PROV-MC-1) and
//! the asset's own header (CONS-PC-5) — so the SHARED vocabularies are
//! provider-typed binds, never restated (the model_store / history_store
//! posture):
//!
//! - `InventoryEligibilityRequest` (+ `InventoryMarker`, `InventoryCovariate`,
//!   `PatientDrawCounts`, `StandardId`, `FileOutcomes`) is PROV-MC-5's request
//!   shape VERBATIM — imported, so one request object feeds the methods,
//!   saved-models and pretrained list endpoints byte-identically (PROV-PC-8's
//!   acceptance).
//! - `EligibilityStatus` / `Coverage` / `MinDraws` / `MissingMarker` /
//!   `RequiredMarkers` / `RequiredMarker` / `MatchMode` / `MarkerKind` /
//!   `UsesHistory` / `CovariateMode` / `TimingQuality` are PROV-MC-1/5/7's
//!   vocabularies, re-exported by the D-list's response shapes below.
//!
//! The ONLY new vocabulary this node owns is the card document's own
//! container fields (`kind`, `endpoint`, `task`, the asset facts) and the one
//! reason code the catalogue path adds (`ASSET_NOT_AVAILABLE` — an entry
//! whose asset is neither bundled nor downloadable; never emitted by the
//! generator, defensive in the runtime verdict — PROV-PC-8).
//!
//! The remainder mirrors PROV-MC-5's [`Reason`] shape (code + params +
//! optional group_id) with this node's own code enum, exactly as
//! `model_store`'s `ModelReasonCode` does for the saved-model path — the
//! per-code renderer a consumer writes switches on a CLOSED set, so the
//! exhaustive `from_catalogue` mapper below is compile-time drift proof.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::modules::method_catalogue::types::{
    CovariateMode, Coverage, EligibilityStatus, InventoryEligibilityRequest, MarkerKind, MinDraws,
    MissingMarker, ReasonCode, RequiredMarkers, TimingQuality, UsesHistory,
};

/// The catalogue document schema version (the generator's `SCHEMA_VERSION`).
pub const PRETRAINED_SCHEMA_VERSION: u32 = 1;

/// The upper bound of `PretrainedEligibilityRequest.model_ids` (PROV-PC-8's
/// 1..=200).
pub const ELIGIBILITY_MODEL_IDS_MAX: usize = 200;

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-1 — the catalogue document (`data/pretrained-catalogue/catalogue.json`,
// the embedded snapshot + the live/disk copies)
// ─────────────────────────────────────────────────────────────────────────────

/// The generated catalogue document.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedCatalogue {
    pub schema_version: u32,
    pub generated_from: PretrainedGeneratedFrom,
    pub models: Vec<PretrainedModel>,
}

/// The generation provenance block.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedGeneratedFrom {
    /// The benchmark registry the card facts were read from.
    pub registry_name: String,
    /// The registry commit (content identity of the fact pipeline).
    pub registry_commit: String,
    /// The model-asset repository (`tinnlab/txresbench-models` — INV-1).
    pub models_repo: String,
    /// The generation date (`YYYY-MM-DDTHH:MM:SSZ`; a date, not a status —
    /// INV-9).
    pub generated_at: String,
}

/// The model-contract kind — the board's Published / Learned here tags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedKind {
    /// A frozen published rule shipped as an immutable release asset.
    #[serde(rename = "published-rule")]
    PublishedRule,
    /// A model fitted by the benchmark and exported as a release asset
    /// (the schema carries it; the generator emits none until the benchmark
    /// saves fitted models — DEC-1).
    #[serde(rename = "benchmark-trained")]
    BenchmarkTrained,
}

impl PretrainedKind {
    /// The wire strings (the closed vocabulary the generator emits).
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedKind::PublishedRule => "published-rule",
            PretrainedKind::BenchmarkTrained => "benchmark-trained",
        }
    }
}

/// The card's outcome flavor — the ASSET's analysis endpoint (`pfs` | `os`).
/// Distinct from the engine's task vocabulary; the card's
/// `needs.task` is the task class ([`PretrainedTask`]) and the packer's header
/// `task` is this endpoint flavor (DRIFT-1 ITEM-2 #4 — never merge them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedEndpoint {
    Pfs,
    Os,
}

impl PretrainedEndpoint {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedEndpoint::Pfs => "pfs",
            PretrainedEndpoint::Os => "os",
        }
    }
}

/// The task class a model's eligibility is computed against (`survival` |
/// `response`; null = not classified).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedTask {
    Survival,
    Response,
}

impl PretrainedTask {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedTask::Survival => "survival",
            PretrainedTask::Response => "response",
        }
    }
}

/// The method environment image digests the asset was packed against
/// (INV-7 — recorded from the env-images manifest at generation time, never
/// re-derived).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedEnv {
    pub base_digest: String,
    pub layer_digest: String,
}

/// The card's marker-input facts (the method's assembled facts, PROV-MC-1 —
/// the same facts the methods list's verdicts run on, so a pretrained
/// "Can run" means the same thing as the method's, DEC-10).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedMarkerFacts {
    pub kind: MarkerKind,
    pub count: u32,
    pub min_draws: u32,
    pub needs_baseline: bool,
    pub uses_history: UsesHistory,
    pub needs_detection_call: bool,
    pub marker_groups_required: Vec<String>,
}

/// The card's needs block — what the D-list verdicts are computed from.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedNeeds {
    pub marker_facts: PretrainedMarkerFacts,
    /// The method's required standard-id markers (PROV-MC-1's rule; null = a
    /// method with no fixed marker list).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_markers: Option<RequiredMarkers>,
    pub covariates: CovariateMode,
    pub decision_day: f64,
    pub endpoint: PretrainedEndpoint,
    pub horizon: f64,
    /// The task class (`survival`/`response`; null = unclassified).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task: Option<PretrainedTask>,
}

/// The card's paper block (null on a card with no recorded paper facts).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedPaper {
    pub journal: String,
    pub year: u32,
    pub doi: String,
    pub citation: String,
}

/// The summary row's paper projection (no citation — the list row renders
/// journal/year/doi only; the full citation is the card's).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedPaperSummary {
    pub journal: String,
    pub year: u32,
    pub doi: String,
}

impl PretrainedPaperSummary {
    /// Project a summary paper block from the card's.
    pub fn from_paper(p: &PretrainedPaper) -> Self {
        Self {
            journal: p.journal.clone(),
            year: p.year,
            doi: p.doi.clone(),
        }
    }
}

/// The transfer metric a published rule was evaluated with on other cohorts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedTransferMetric {
    AucRule,
    CIndex,
}

impl PretrainedTransferMetric {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedTransferMetric::AucRule => "auc_rule",
            PretrainedTransferMetric::CIndex => "c_index",
        }
    }
}

/// One cohort's transfer value (the benchmark's primary-scores median for that
/// dataset).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedTransferCohort {
    pub dataset: String,
    pub value: f64,
}

/// The results-on-other-cohorts aggregate (null renders the board's "not yet
/// checked elsewhere").
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedTransfer {
    pub metric: PretrainedTransferMetric,
    pub median: f64,
    pub n_cohorts: u32,
    pub cohorts: Vec<PretrainedTransferCohort>,
}

/// The summary row's transfer projection (per-cohort list is card-only).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedTransferSummary {
    pub metric: PretrainedTransferMetric,
    pub median: f64,
    pub n_cohorts: u32,
}

impl PretrainedTransferSummary {
    /// Project a summary transfer block from the card's.
    pub fn from_transfer(t: &PretrainedTransfer) -> Self {
        Self {
            metric: t.metric,
            median: t.median,
            n_cohorts: t.n_cohorts,
        }
    }
}

/// One assay warning of the card (the ⚠ lines — data, rendered by the
/// consumer).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedAssayWarning {
    pub code: String,
    pub detail: String,
}

/// One dataset a model's data comes from (the card's licence facts — INV-3).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedDataSource {
    pub dataset: String,
    /// The registry's access class; after the build gate every shipped entry
    /// is `open` (INV-3 — the runtime refuses anything else, belt over the
    /// build gate).
    pub access: PretrainedDataSourceAccess,
    pub licence: String,
}

/// The access-class vocabulary of the benchmark registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedDataSourceAccess {
    Open,
    Controlled,
}

impl PretrainedDataSourceAccess {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedDataSourceAccess::Open => "open",
            PretrainedDataSourceAccess::Controlled => "controlled",
        }
    }
}

/// The release-asset facts (INV-1 — an immutable release asset of
/// `tinnlab/txresbench-models`, content-addressed by the entry's sha256).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedAsset {
    /// The installer ships the file when true (INV-8 — the offline path).
    pub bundled: bool,
    /// `<id>@<version>.txr` — the release asset's file name.
    pub file: String,
    pub url: String,
    pub size_bytes: u64,
    /// 64 lowercase hex — the content identity every download/install
    /// verifies against (INV-2).
    pub sha256: String,
    /// Always empty (owner decision: sha256 only, NO signing — DEC-7).
    pub signature: String,
}

/// The summary row's asset projection (no url/signature — the list row renders
/// state + size only).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedAssetSummary {
    pub bundled: bool,
    pub file: String,
    pub size_bytes: u64,
    pub sha256: String,
}

impl PretrainedAssetSummary {
    /// Project a summary asset block from the card's.
    pub fn from_asset(a: &PretrainedAsset) -> Self {
        Self {
            bundled: a.bundled,
            file: a.file.clone(),
            size_bytes: a.size_bytes,
            sha256: a.sha256.clone(),
        }
    }
}

/// One `models[]` entry of the catalogue — the card payload (PROV-PC-4) and
/// the board-D row's data source.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PretrainedModel {
    /// The stable catalogue slug (`relchange-threshold`-shaped; the asset
    /// file name and the store row's `pretrained_catalogue_id` key off it).
    pub id: String,
    pub version: String,
    pub kind: PretrainedKind,
    pub name: String,
    pub description: String,
    pub method_id: String,
    pub method_version: String,
    pub group: String,
    pub group_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper: Option<PretrainedPaper>,
    pub needs: PretrainedNeeds,
    pub env: PretrainedEnv,
    pub contract: String,
    pub embeds_training_data: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer: Option<PretrainedTransfer>,
    #[serde(default)]
    pub assay_warnings: Vec<PretrainedAssayWarning>,
    /// Always true in the shipped catalogue (the card's research-use notice
    /// FLAG — the copy is the board's, D18).
    pub research_notice: bool,
    /// The model's DATA licence (non-empty — INV-3).
    pub licence: String,
    pub data_sources: Vec<PretrainedDataSource>,
    pub asset: PretrainedAsset,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-2 — the bundled-models manifest (`data/pretrained-catalogue/
// bundled-models.json`, the installer-build extract; PROV-PC-12)
// ─────────────────────────────────────────────────────────────────────────────

/// The bundled-models manifest (one source of truth, parsed by the installer
/// build and this app — PROV-PC-12).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BundledModels {
    pub schema_version: u32,
    pub models: Vec<BundledAsset>,
}

/// One bundled entry — exactly the `asset` fields of the catalogue entries
/// with `bundled: true`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BundledAsset {
    pub id: String,
    pub version: String,
    pub file: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-3 — GET /api/txr/pretrained
// ─────────────────────────────────────────────────────────────────────────────

/// The catalogue layer a served copy came from (INV-8's live → disk →
/// embedded order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedOrigin {
    Live,
    Disk,
    Embedded,
}

impl PretrainedOrigin {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedOrigin::Live => "live",
            PretrainedOrigin::Disk => "disk",
            PretrainedOrigin::Embedded => "embedded",
        }
    }
}

/// The D-list row state — the merge of the catalogue entry, the bundled-file
/// presence, the download-manager state and the installed store row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedEntryState {
    NotDownloaded,
    Downloading,
    Ready,
    Bundled,
    Installed,
    Unavailable,
}

impl PretrainedEntryState {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedEntryState::NotDownloaded => "not_downloaded",
            PretrainedEntryState::Downloading => "downloading",
            PretrainedEntryState::Ready => "ready",
            PretrainedEntryState::Bundled => "bundled",
            PretrainedEntryState::Installed => "installed",
            PretrainedEntryState::Unavailable => "unavailable",
        }
    }
}

/// One D-list row (PROV-PC-3).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedSummary {
    pub id: String,
    pub version: String,
    pub kind: PretrainedKind,
    pub name: String,
    pub description: String,
    pub method_id: String,
    pub method_version: String,
    pub group: String,
    pub group_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper: Option<PretrainedPaperSummary>,
    pub decision_day: f64,
    pub endpoint: PretrainedEndpoint,
    pub horizon: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer: Option<PretrainedTransferSummary>,
    pub warnings: Vec<PretrainedAssayWarning>,
    pub research_notice: bool,
    pub licence: String,
    pub asset: PretrainedAssetSummary,
    pub state: PretrainedEntryState,
    /// The real store row the D Run passes (the grown
    /// `model_store::store::list_pretrained` mapping, GAP-PC-3 — strict
    /// id+version match); null before install.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_model_id: Option<String>,
}

/// The list response (unpaged — the catalogue is bounded; PROV-PC-3).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedListResponse {
    pub origin: PretrainedOrigin,
    /// The active catalogue's generation date (null only in the not-yet-
    /// refreshed embedded state with a malformed provenance — never in a
    /// shipped snapshot).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    pub models: Vec<PretrainedSummary>,
    pub total: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-4 — GET /api/txr/pretrained/{id}
// ─────────────────────────────────────────────────────────────────────────────

/// The model card: the full `models[]` entry (the models.md card — source
/// paper, needs, decision day, other-cohort results, assay warnings,
/// research-use notice, licence, data sources, asset).
pub type PretrainedModelCard = PretrainedModel;

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-5 — POST /api/txr/pretrained/refresh
// ─────────────────────────────────────────────────────────────────────────────

/// The refresh response: the origin actually in use + the catalogue facts of
/// the layer chosen (a failed refresh is silent — offline is a valid state —
/// so the response never carries an error).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedRefreshResponse {
    pub origin: PretrainedOrigin,
    pub models: u32,
    /// The active catalogue's generation date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_at: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-6 — the download-manager surface
// ─────────────────────────────────────────────────────────────────────────────

/// The download-state vocabulary (PROV-PC-6 — MIRRORS the method-environment
/// vocabulary per models.md; this node does not import the sandbox module,
/// DEC-6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedDownloadState {
    NotDownloaded,
    Downloading,
    Ready,
    Failed,
}

impl PretrainedDownloadState {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedDownloadState::NotDownloaded => "not_downloaded",
            PretrainedDownloadState::Downloading => "downloading",
            PretrainedDownloadState::Ready => "ready",
            PretrainedDownloadState::Failed => "failed",
        }
    }
}

/// One download's status (PROV-PC-6; `bytes_downloaded` is polled from the
/// growing staged file, `bytes_total` the catalogue's `asset.size_bytes`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedDownloadStatus {
    pub id: String,
    pub version: String,
    pub state: PretrainedDownloadState,
    pub bytes_downloaded: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes_total: Option<u64>,
    /// The verified sha256 (present once the asset has verified once —
    /// bundled or cached or downloaded).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// The verified file is in the content-addressed cache.
    pub cached: bool,
    /// The entry's asset is bundled (the bundle is the source; it is never
    /// downloaded — INV-8).
    pub bundled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `GET /api/txr/pretrained/downloads`
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedDownloadsResponse {
    pub downloads: Vec<PretrainedDownloadStatus>,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-7 — POST /api/txr/pretrained/{id}/install
// ─────────────────────────────────────────────────────────────────────────────

/// The install status (200 = installed now; 202 = the download was started
/// and the caller polls PROV-PC-6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedInstallStatus {
    Installed,
    Installing,
}

impl PretrainedInstallStatus {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedInstallStatus::Installed => "installed",
            PretrainedInstallStatus::Installing => "installing",
        }
    }
}

/// Where the verified bytes came from (source order: bundled → cache →
/// download — INV-8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PretrainedInstallSource {
    Bundled,
    Cache,
    Download,
}

impl PretrainedInstallSource {
    /// The (closed) wire strings.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedInstallSource::Bundled => "bundled",
            PretrainedInstallSource::Cache => "cache",
            PretrainedInstallSource::Download => "download",
        }
    }
}

/// The install response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedInstallResponse {
    /// The store row id (null while the install is pending a download).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub status: PretrainedInstallStatus,
    pub catalogue_id: String,
    pub version: String,
    pub licence: String,
    pub size_bytes: u64,
    pub source: PretrainedInstallSource,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-PC-8 — POST /api/txr/pretrained/eligibility
// ─────────────────────────────────────────────────────────────────────────────

/// The eligibility request body — `model_ids` bounded 1..=200; `inventory` is
/// PROV-MC-5's `InventoryEligibilityRequest` VERBATIM (imported, not restated),
/// the same object `ui-models` feeds the methods / saved-models /
/// pretrained list endpoints.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedEligibilityRequest {
    pub model_ids: Vec<String>,
    pub inventory: InventoryEligibilityRequest,
}

/// The pretrained eligibility reason-code vocabulary: PROV-MC-5's
/// [`ReasonCode`] set (the SAME wire strings — a per-code renderer in the UI
/// never meets an undocumented code) plus the catalogue's own
/// `ASSET_NOT_AVAILABLE` (an entry whose asset is neither bundled nor
/// downloadable — never emitted by the generator, defensive in the runtime
/// verdict). The `from_catalogue` mapper is exhaustive: a new provider code
/// fails to compile here instead of silently passing through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum PretrainedReasonCode {
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
    #[serde(rename = "TASK_INCOMPATIBLE")]
    TaskIncompatible,
    #[serde(rename = "RESPONSE_LABEL_MISSING")]
    ResponseLabelMissing,
    #[serde(rename = "SURVIVAL_OUTCOME_MISSING")]
    SurvivalOutcomeMissing,
    #[serde(rename = "ASSET_NOT_AVAILABLE")]
    AssetNotAvailable,
}

impl PretrainedReasonCode {
    /// The closed code list, in documentation order (12 provider codes + the
    /// catalogue's own).
    pub const ALL: [PretrainedReasonCode; 13] = [
        PretrainedReasonCode::RequiredMarkerMissing,
        PretrainedReasonCode::MarkerGroupMissing,
        PretrainedReasonCode::DetectionCallMissing,
        PretrainedReasonCode::MinDrawsUnmet,
        PretrainedReasonCode::CovariateMissing,
        PretrainedReasonCode::CovariateRequiredUnmet,
        PretrainedReasonCode::UnitMismatch,
        PretrainedReasonCode::DecisionDayUnmet,
        PretrainedReasonCode::NotRunnable,
        PretrainedReasonCode::TaskIncompatible,
        PretrainedReasonCode::ResponseLabelMissing,
        PretrainedReasonCode::SurvivalOutcomeMissing,
        PretrainedReasonCode::AssetNotAvailable,
    ];

    /// The code's wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedReasonCode::RequiredMarkerMissing => "REQUIRED_MARKER_MISSING",
            PretrainedReasonCode::MarkerGroupMissing => "MARKER_GROUP_MISSING",
            PretrainedReasonCode::DetectionCallMissing => "DETECTION_CALL_MISSING",
            PretrainedReasonCode::MinDrawsUnmet => "MIN_DRAWS_UNMET",
            PretrainedReasonCode::CovariateMissing => "COVARIATE_MISSING",
            PretrainedReasonCode::CovariateRequiredUnmet => "COVARIATE_REQUIRED_UNMET",
            PretrainedReasonCode::UnitMismatch => "UNIT_MISMATCH",
            PretrainedReasonCode::DecisionDayUnmet => "DECISION_DAY_UNMET",
            PretrainedReasonCode::NotRunnable => "NOT_RUNNABLE",
            PretrainedReasonCode::TaskIncompatible => "TASK_INCOMPATIBLE",
            PretrainedReasonCode::ResponseLabelMissing => "RESPONSE_LABEL_MISSING",
            PretrainedReasonCode::SurvivalOutcomeMissing => "SURVIVAL_OUTCOME_MISSING",
            PretrainedReasonCode::AssetNotAvailable => "ASSET_NOT_AVAILABLE",
        }
    }

    /// The provider code → catalogue code mapping (1:1; the exhaustiveness IS
    /// the drift guard — a new provider code cannot pass silently, TEST-PC-02).
    pub fn from_catalogue(code: ReasonCode) -> Self {
        match code {
            ReasonCode::RequiredMarkerMissing => PretrainedReasonCode::RequiredMarkerMissing,
            ReasonCode::MarkerGroupMissing => PretrainedReasonCode::MarkerGroupMissing,
            ReasonCode::DetectionCallMissing => PretrainedReasonCode::DetectionCallMissing,
            ReasonCode::MinDrawsUnmet => PretrainedReasonCode::MinDrawsUnmet,
            ReasonCode::CovariateMissing => PretrainedReasonCode::CovariateMissing,
            ReasonCode::CovariateRequiredUnmet => PretrainedReasonCode::CovariateRequiredUnmet,
            ReasonCode::UnitMismatch => PretrainedReasonCode::UnitMismatch,
            ReasonCode::DecisionDayUnmet => PretrainedReasonCode::DecisionDayUnmet,
            ReasonCode::NotRunnable => PretrainedReasonCode::NotRunnable,
            ReasonCode::TaskIncompatible => PretrainedReasonCode::TaskIncompatible,
            ReasonCode::ResponseLabelMissing => PretrainedReasonCode::ResponseLabelMissing,
            ReasonCode::SurvivalOutcomeMissing => PretrainedReasonCode::SurvivalOutcomeMissing,
        }
    }
}

/// One structured reason of a pretrained verdict — PROV-MC-5's [`Reason`]
/// shape (code + per-code params + the optional group scope) with this node's
/// own code vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedReason {
    pub code: PretrainedReasonCode,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, serde_json::Value>,
    /// The board group the reason belongs to, when the reason is group-scoped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

/// One entry's D-list verdict (the verdict rules are PROV-MC-5's / PROV-MS-9's
/// — DEC-10 — with the catalogue's recorded `needs` as the input and the
/// `ASSET_NOT_AVAILABLE` addition above).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedEligibilityEntry {
    pub id: String,
    pub status: EligibilityStatus,
    pub reasons: Vec<PretrainedReason>,
    /// The provider's [`MissingMarker`] shape (the board's "2 lack LDH" list).
    pub missing_markers: Vec<MissingMarker>,
    pub coverage: Coverage,
    pub min_draws: MinDraws,
    /// The catalogue estimator's value for the entry's method; null when the
    /// method is absent from the method catalogue (the verdict still stands
    /// without a time).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimated_seconds: Option<f64>,
    /// The estimator's fact quality (measured from the benchmark, else the
    /// language fallback).
    pub estimate_quality: TimingQuality,
}

/// The eligibility response: per-entry verdicts plus the screen totals.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PretrainedEligibilityResponse {
    pub models: Vec<PretrainedEligibilityEntry>,
    pub total_fit: u32,
    pub total_some: u32,
    pub total_cannot: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// The route doc-id vocabulary (the routes' `.id(...)` seam — the inventory is
// the registration; the ids are emitted into the OpenAPI spec and the
// generated client, so a rename is one edit, and the routes' own test binds
// the registered set to this constant — the execution_engine ROUTE_DOC_IDS
// precedent).
// ─────────────────────────────────────────────────────────────────────────────
pub const ROUTE_DOC_IDS: [&str; 8] = [
    "Pretrained.listModels",
    "Pretrained.getModel",
    "Pretrained.installModel",
    "Pretrained.downloadModel",
    "Pretrained.listDownloads",
    "Pretrained.deleteDownload",
    "Pretrained.refreshCatalogue",
    "Pretrained.checkEligibility",
];

// ─────────────────────────────────────────────────────────────────────────────
// Error codes + request-validation rules (the closed error vocabulary of the
// surface — ITEM-5's routes map these onto status codes)
// ─────────────────────────────────────────────────────────────────────────────

/// The module's own error codes (the routes map each onto a status; the code
/// strings are the stable machine vocabulary consumers switch on).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PretrainedErrorCode {
    /// `404` — an unknown pretrained id (no such catalogue entry).
    Unknown,
    /// `409` — the asset bytes failed sha256 verification against the
    /// catalogue entry (INV-2).
    VerifyFailed,
    /// `409` — a lower-level download operation raced (the surface itself is
    /// idempotent — PROV-PC-6).
    DownloadInProgress,
    /// `409` — a catalogue entry without a licence refused at install (belt
    /// over the build gate — INV-3).
    LicenceMissing,
}

impl PretrainedErrorCode {
    /// The stable machine code of the failure.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedErrorCode::Unknown => "PRETRAINED_UNKNOWN",
            PretrainedErrorCode::VerifyFailed => "PRETRAINED_VERIFY_FAILED",
            PretrainedErrorCode::DownloadInProgress => "PRETRAINED_DOWNLOAD_IN_PROGRESS",
            PretrainedErrorCode::LicenceMissing => "PRETRAINED_LICENCE_MISSING",
        }
    }
}

/// The request-level validation errors of the eligibility surface (400s).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PretrainedRequestErrorCode {
    EmptyModelIds,
    TooManyModelIds,
}

impl PretrainedRequestErrorCode {
    /// The stable machine code of the failure.
    pub fn as_str(self) -> &'static str {
        match self {
            PretrainedRequestErrorCode::EmptyModelIds => "EMPTY_MODEL_IDS",
            PretrainedRequestErrorCode::TooManyModelIds => "TOO_MANY_MODEL_IDS",
        }
    }
}

/// Validate PROV-PC-8's `model_ids` bound (1..=200): empty → `400
/// EMPTY_MODEL_IDS`, over the cap → `400 TOO_MANY_MODEL_IDS`.
pub fn validate_model_ids(ids: &[String]) -> Result<(), axum::http::StatusCode> {
    if ids.is_empty() {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    if ids.len() > ELIGIBILITY_MODEL_IDS_MAX {
        return Err(axum::http::StatusCode::BAD_REQUEST);
    }
    Ok(())
}

/// The `404 PRETRAINED_UNKNOWN` refusal for an unknown id (the card/install/
/// download/delete routes' not-found answer — one code, one entity, the
/// pretrained id).
pub fn unknown_id(id: &str) -> ziee_core::AppError {
    ziee_core::AppError::new(
        axum::http::StatusCode::NOT_FOUND,
        PretrainedErrorCode::Unknown.as_str(),
        format!("no pretrained model {id} in the catalogue"),
    )
}

// The TEST-PC-02 suite: every wire type serializes the declared shapes; the
// aide doc ids are exactly the eight `Pretrained.*` ids; the closed enum
// vocabularies are exactly the plan's; the request-validation rules bind; and
// the imported `InventoryEligibilityRequest` body is byte-compatible with the
// methods module's shape (the import makes the compatibility a property of
// the type system — the round-trip pins the wire strings).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::types::{
        EligibilityStatus, FileOutcomes, InventoryEligibilityRequest, InventoryMarker, StandardId,
        UnitFamily,
    };

    #[test]
    fn api_types_generate_schemas() {
        let _ = schemars::schema_for!(PretrainedCatalogue);
        let _ = schemars::schema_for!(PretrainedListResponse);
        let _ = schemars::schema_for!(PretrainedModelCard);
        let _ = schemars::schema_for!(PretrainedRefreshResponse);
        let _ = schemars::schema_for!(PretrainedDownloadsResponse);
        let _ = schemars::schema_for!(PretrainedInstallResponse);
        let _ = schemars::schema_for!(PretrainedEligibilityRequest);
        let _ = schemars::schema_for!(PretrainedEligibilityResponse);
        let _ = schemars::schema_for!(PretrainedReasonCode);
        let _ = schemars::schema_for!(PretrainedKind);
        let _ = schemars::schema_for!(PretrainedEntryState);
        let _ = schemars::schema_for!(PretrainedDownloadState);
        let _ = schemars::schema_for!(BundledModels);
    }

    /// The eight registered doc ids, in the plan's order, all distinct.
    #[test]
    fn route_doc_ids_are_exactly_the_eight_pretrained_ids() {
        assert_eq!(
            ROUTE_DOC_IDS,
            [
                "Pretrained.listModels",
                "Pretrained.getModel",
                "Pretrained.installModel",
                "Pretrained.downloadModel",
                "Pretrained.listDownloads",
                "Pretrained.deleteDownload",
                "Pretrained.refreshCatalogue",
                "Pretrained.checkEligibility",
            ]
        );
        let mut ids = ROUTE_DOC_IDS.to_vec();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 8, "doc ids are distinct");
    }

    /// The closed enum vocabularies' wire strings are exactly the plan's
    /// (a consumer's per-code renderer can never meet an undocumented value).
    #[test]
    fn enum_wire_strings_are_the_declared_shapes() {
        let s = serde_json::to_value(schemars::schema_for!(PretrainedKind)).expect("schema");
        let s = format!("{s}");
        assert!(s.contains("\"published-rule\"") && s.contains("\"benchmark-trained\""));

        let s = serde_json::to_value(schemars::schema_for!(PretrainedEntryState)).expect("schema");
        let s = format!("{s}");
        for w in [
            "not_downloaded",
            "downloading",
            "ready",
            "bundled",
            "installed",
            "unavailable",
        ] {
            assert!(s.contains(w), "state schema must carry {w}");
        }

        let s =
            serde_json::to_value(schemars::schema_for!(PretrainedDownloadState)).expect("schema");
        let s = format!("{s}");
        for w in ["not_downloaded", "downloading", "ready", "failed"] {
            assert!(s.contains(w), "download state schema must carry {w}");
        }

        let s = serde_json::to_value(schemars::schema_for!(PretrainedEndpoint)).expect("schema");
        let s = format!("{s}");
        assert!(s.contains("\"pfs\"") && s.contains("\"os\""));

        let s = serde_json::to_value(schemars::schema_for!(PretrainedDataSourceAccess))
            .expect("schema");
        let s = format!("{s}");
        assert!(s.contains("\"open\"") && s.contains("\"controlled\""));

        let s = serde_json::to_value(schemars::schema_for!(PretrainedOrigin)).expect("schema");
        let s = format!("{s}");
        assert!(s.contains("\"live\"") && s.contains("\"disk\"") && s.contains("\"embedded\""));

        let s =
            serde_json::to_value(schemars::schema_for!(PretrainedInstallStatus)).expect("schema");
        let s = format!("{s}");
        assert!(s.contains("\"installed\"") && s.contains("\"installing\""));

        let s =
            serde_json::to_value(schemars::schema_for!(PretrainedInstallSource)).expect("schema");
        let s = format!("{s}");
        assert!(s.contains("\"bundled\"") && s.contains("\"cache\"") && s.contains("\"download\""));

        let s =
            serde_json::to_value(schemars::schema_for!(PretrainedTransferMetric)).expect("schema");
        let s = format!("{s}");
        assert!(s.contains("\"auc_rule\"") && s.contains("\"c_index\""));

        for code in PretrainedReasonCode::ALL {
            let s =
                serde_json::to_value(schemars::schema_for!(PretrainedReasonCode)).expect("schema");
            let s = format!("{s}");
            assert!(
                s.contains(code.as_str()),
                "schema must carry {}",
                code.as_str()
            );
        }
    }

    /// The reason-code vocabulary is closed with distinct wire strings, and
    /// the provider mapping is 1:1 exhaustive (a new provider code fails to
    /// compile the mapper).
    #[test]
    fn reason_code_vocabulary_is_closed_and_maps_provider_codes() {
        assert_eq!(
            PretrainedReasonCode::ALL.len(),
            13,
            "12 provider codes + ASSET_NOT_AVAILABLE"
        );
        let mut wires: Vec<&str> = PretrainedReasonCode::ALL
            .iter()
            .map(|c| c.as_str())
            .collect();
        wires.sort_unstable();
        wires.dedup();
        assert_eq!(wires.len(), 13, "wire strings are distinct");
        for code in PretrainedReasonCode::ALL {
            let json = serde_json::to_value(code).expect("serialize");
            let back: PretrainedReasonCode =
                serde_json::from_value(json.clone()).expect("deserialize");
            assert_eq!(back, code, "round-trip of {}", code.as_str());
            assert_eq!(json.as_str().expect("string"), code.as_str());
        }

        assert_eq!(
            crate::modules::method_catalogue::types::ReasonCode::ALL.len(),
            12,
            "the provider vocabulary"
        );
        let mut mapped: Vec<&str> = ReasonCode::ALL
            .iter()
            .map(|c| PretrainedReasonCode::from_catalogue(*c).as_str())
            .collect();
        mapped.sort_unstable();
        mapped.dedup();
        assert_eq!(
            mapped.len(),
            12,
            "the 12 provider codes map 1:1, no collisions"
        );
    }

    /// PROV-PC-8: an `InventoryEligibilityRequest`-shaped body is the same
    /// object the methods endpoint accepts — the type is IMPORTED, so this
    /// pins the wire round-trip (the serde shape of PROV-MC-5) rather than a
    /// second shape drifting away.
    #[test]
    fn inventory_request_shape_is_mc5_byte_compatible() {
        let inv = InventoryEligibilityRequest {
            patients: 38,
            decision_day: 56.0,
            baseline_max_day: 7.0,
            markers: vec![InventoryMarker {
                key: "ldh".to_string(),
                display_name: "LDH".to_string(),
                unit_family: UnitFamily::ConcentrationMass,
                standard_ids: vec![StandardId {
                    system: "LOINC".to_string(),
                    id: "2532-0".to_string(),
                }],
                is_detection_call: false,
                has_detection_companion: false,
                n_patients_with_value: 36,
                n_patients_with_baseline: 36,
                n_patients_with_ontreatment: 30,
                per_patient: None,
            }],
            covariates: vec![],
            outcomes: Some(FileOutcomes {
                has_responder: true,
                has_response_day: true,
                has_event: true,
                has_survival_day: true,
            }),
        };

        // The provider's own union wraps THE SAME value (imported type): the
        // `inventory` object the pretrained request carries serializes to the
        // identical bytes the methods endpoint accepts.
        let provider_body =
            crate::modules::method_catalogue::types::EligibilityRequest::Inventory {
                inventory: inv.clone(),
            };
        let provider_json = serde_json::to_value(&provider_body).expect("provider body");
        let pretrained_json = serde_json::to_value(&PretrainedEligibilityRequest {
            model_ids: vec!["relchange-threshold".to_string()],
            inventory: inv,
        })
        .expect("pretrained body");
        assert_eq!(
            provider_json["inventory"], pretrained_json["inventory"],
            "the inventory object is byte-identical across the two providers"
        );

        // And the provider's request round-trips through its own typed union —
        // same bytes, same shape.
        let back: crate::modules::method_catalogue::types::EligibilityRequest =
            serde_json::from_value(provider_json).expect("provider round-trip");
        assert!(matches!(
            back,
            crate::modules::method_catalogue::types::EligibilityRequest::Inventory { .. }
        ));
    }

    /// The request-validation rules: `model_ids` empty or over 200 is
    /// rejected (400), the bound constant is exactly the plan's.
    #[test]
    fn model_ids_bounds_are_validated() {
        assert_eq!(ELIGIBILITY_MODEL_IDS_MAX, 200);
        assert_eq!(
            validate_model_ids(&[]),
            Err(axum::http::StatusCode::BAD_REQUEST)
        );
        let ids = vec!["a".to_string(); 201];
        assert_eq!(
            validate_model_ids(&ids),
            Err(axum::http::StatusCode::BAD_REQUEST)
        );
        let ok = vec!["a".to_string(); 200];
        assert_eq!(validate_model_ids(&ok), Ok(()));
        assert_eq!(validate_model_ids(&["a".to_string()]), Ok(()));
    }

    /// Unknown id → the `404 PRETRAINED_UNKNOWN` refusal (the one not-found
    /// code of the surface).
    #[test]
    fn unknown_id_is_pretrained_unknown() {
        let err = unknown_id("relchange-threshold");
        assert_eq!(err.status_code(), 404);
        assert_eq!(err.error_code(), "PRETRAINED_UNKNOWN");
        let s = format!("{err}");
        assert!(s.contains("relchange-threshold"));
    }
}
