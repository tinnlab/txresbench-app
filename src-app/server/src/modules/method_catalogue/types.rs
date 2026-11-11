//! The `method_catalogue` type contract — the serde + JsonSchema surface of every
//! request and response the module owns (in-process `Catalogue` model, the
//! method-list/detail/vocabulary projections, the eligibility request/response,
//! the estimate request/response).
//!
//! The catalogue data model mirrors `data/method-catalogue/catalogue.json` (schema
//! version 1, emitted by `scripts/method-catalogue/gen_method_catalogue.py`)
//! EXACTLY: a field the generator emits is a field here, and the whole model is
//! `deny_unknown_fields` so a catalogue that disagrees with the code is a boot
//! failure (first-party data posture, `catalogue.rs`), never a silent mismatch.
//!
//! Enumerated vocabularies in this file are the CLOSED lists the generator emits
//! today; a new value from a future generator run fails the parse loudly so the
//! schema bump is a code change, not a silent fall-through. The one deliberately
//! open string is `required_markers[].id_system` — the registry carries raw
//! system spellings (`HGNC`, `LOINC`, `UniProt`, `other`) and the matching engine
//! treats them case-insensitively (ITEM-3), so no closed list is asserted here.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The catalogue schema version this module understands. A different value at
/// boot is a named refusal (see `catalogue::CatalogueLoadError`).
pub const CATALOGUE_SCHEMA_VERSION: u32 = 1;

/// The default per-job CPU count assumed when an estimate request omits `cpus`
/// (the app's standard per-job cap; DEC-7).
pub const DEFAULT_ESTIMATE_CPUS: u32 = 4;

/// The default run-N-at-a-time lane count assumed when an estimate request omits
/// `at_a_time` (DEC-7 / the bottom-bar schedule).
pub const DEFAULT_ESTIMATE_AT_A_TIME: u32 = 3;

/// The human-name field caps (qa-fixes3 ITEM-1; the generator derives the
/// values under the SAME constants — `scripts/method-catalogue/gen_method_catalogue.py`).
pub const MAX_METHOD_TITLE_CHARS: usize = 60;
pub const MAX_METHOD_SUMMARY_CHARS: usize = 170;

// ─────────────────────────────────────────────────────────────────────────────
// Catalogue data model (PROV-MC-1)
// ─────────────────────────────────────────────────────────────────────────────

/// The root of `data/method-catalogue/catalogue.json` (schema version 1).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Catalogue {
    /// The catalogue schema version (= [`CATALOGUE_SCHEMA_VERSION`] at boot).
    pub schema_version: u32,
    /// Build-time provenance of the committed file (registry name + repo HEADs +
    /// generation date). A date, not a state.
    pub generated_from: GeneratedFrom,
    /// The runnable method set (method-level facts; no per-patient or per-dataset
    /// content — INV-6).
    pub methods: Vec<Method>,
    /// The marker vocabulary (every standard-id marker the methods reference,
    /// with alias and group mapping).
    pub markers: Vec<VocabularyMarker>,
    /// The 7 board marker groups (screen B checkboxes).
    pub groups: Vec<MarkerGroup>,
}

impl Catalogue {
    /// Look a method up by its stable package slug.
    pub fn method(&self, id: &str) -> Option<&Method> {
        self.methods.iter().find(|m| m.id == id)
    }

    /// Look a marker group up by its board id.
    pub fn group(&self, id: &str) -> Option<&MarkerGroup> {
        self.groups.iter().find(|g| g.id == id)
    }
}

/// Build-time provenance record. `generated_at` is a date the generator wrote
/// (not a freshness state); the commits are the benchmark-tree HEADs the file
/// was generated from.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GeneratedFrom {
    /// The registry name (`txresbench-methods`, or the fixture marker in the
    /// synthetic fixture run).
    pub registry_name: String,
    /// The `methods` repo HEAD the facts were read from.
    pub methods_commit: String,
    /// The sigtrans repo HEAD (registry + benchmark results) the facts were read
    /// from.
    pub manifest_commit: String,
    /// The results-repo HEAD (`runs.csv` / `scores.csv`) the aggregates were read
    /// from.
    pub results_commit: String,
    /// The generation timestamp (`SOURCE_DATE_EPOCH`-pinned for reproducibility).
    pub generated_at: String,
}

/// The four benchmark method groups (the group chips on the list screen).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum MethodGroup {
    /// A rule/statistic that calls response vs no response at the decision day.
    ResponseCall,
    /// A model of response probability at the decision day.
    ResponseProbability,
    /// A risk score from baseline values.
    StaticRisk,
    /// A landmark / joint / dynamic model of risk over time.
    DynamicRisk,
}

impl MethodGroup {
    /// The wire spelling (the serde derive's kebab-case — the single form the
    /// HTTP consumers and the run rows' `group` column store; added for the
    /// execution engine's row insert, which takes the catalogue id as a
    /// string rather than the enum).
    pub fn as_str(self) -> &'static str {
        match self {
            MethodGroup::ResponseCall => "response-call",
            MethodGroup::ResponseProbability => "response-probability",
            MethodGroup::StaticRisk => "static-risk",
            MethodGroup::DynamicRisk => "dynamic-risk",
        }
    }
}

/// Whether a method's inputs include patient covariates beyond the markers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CovariateMode {
    None,
    Optional,
    Required,
}

/// How much measurement history a method consumes. The manifest vocabulary is
/// `landmark | full` (the plan's `none` never occurs in the registry — DRIFT-1
/// ITEM-1); `full` renders as "uses all available history".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UsesHistory {
    Landmark,
    Full,
}

/// The marker-input shape of a method: `any` (marker-agnostic; `count` 0 =
/// unbounded), `single` (1 marker), `panel` (N named markers from a fixed list),
/// `multi` (N markers, no fixed list).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MarkerKind {
    Any,
    Single,
    Panel,
    Multi,
}

/// The marker identifier system of a vocabulary marker (the registry's systems;
/// the matching engine also knows the `other`-system fallback as an open string).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "UPPERCASE")]
pub enum MarkerSystem {
    Loinc,
    Hgnc,
    Uniprot,
    Hmdb,
    Mirbase,
    Other,
}

impl MarkerSystem {
    /// The wire form of the system.
    pub fn as_str(self) -> &'static str {
        match self {
            MarkerSystem::Loinc => "LOINC",
            MarkerSystem::Hgnc => "HGNC",
            MarkerSystem::Uniprot => "UNIPROT",
            MarkerSystem::Hmdb => "HMDB",
            MarkerSystem::Mirbase => "MIRBASE",
            MarkerSystem::Other => "OTHER",
        }
    }
}

/// The unit family a marker's values are measured in — the unit-compatibility
/// vocabulary of the eligibility engine (a file column in one family never
/// satisfies a method needing another).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum UnitFamily {
    ConcentrationMass,
    ConcentrationMolar,
    Count,
    Percent,
    Ratio,
    Detection,
    None,
}

/// Timing fact quality: `measured` from the benchmark's stored per-fold seconds,
/// `estimate` from the language-based fallback default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TimingQuality {
    Measured,
    Estimate,
}

/// The `required_markers` match mode (the data.py port's `match:` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MatchMode {
    All,
    MinFraction,
}

/// The method's wrapper gate record (methods/gates/<id>.json).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Gate {
    pub pass: bool,
    pub report_name: String,
}

/// The benchmark container-image reference the catalogue carries as DATA (the
/// runtime `EnvRef` is built from `method-env-images.json` — a different
/// artifact; see the PLAN's env note). The image string carries no scheme and is
/// never fetched by this module.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CatalogueEnv {
    /// `ghcr.io/tinnlab/txresbench-<method-id>:<method-version>`.
    pub image: String,
    /// The gate's image digest.
    pub digest: String,
    /// The benchmark container contract version (e.g. "2.0").
    pub contract: String,
}

/// The shape a consumer (the execution engine's env picker) reads back for one
/// method — the runtime env reference assembled from the catalogue facts
/// (PROV-MC-7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct MethodEnv {
    pub image: String,
    pub version: String,
    pub digest: String,
    pub contract: String,
}

/// A method's marker-input summary (`markers{kind,count}`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MethodMarkers {
    pub kind: MarkerKind,
    pub count: u32,
}

/// One required standard-id marker of a method (`required_markers.markers[]`).
/// `id_system` is the raw registry spelling (matches the RULE, case-insensitively,
/// in the engine port).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequiredMarker {
    pub name: String,
    pub id_system: String,
    pub id: String,
}

/// A method's required-marker rule (the port of data.py's `required_marker_match`
/// input): the fixed marker list + the `all | min_fraction` mode + the source
/// citation the curated rule came from.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RequiredMarkers {
    pub markers: Vec<RequiredMarker>,
    /// The JSON field is `match` — a Rust keyword, hence the rename.
    #[serde(rename = "match")]
    pub match_mode: MatchMode,
    pub min_fraction: f64,
    pub list_source: String,
}

/// A method's per-fold time estimate fact (median of the benchmark's `status==ok`
/// per-fold seconds, or the language fallback with `quality: estimate`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Timing {
    pub base_seconds_per_fold: f64,
    pub benchmarked_units: u32,
    pub quality: TimingQuality,
}

/// Method-level performance aggregates (medians over the benchmark's primary
/// units on other cohorts — the model/card fact; no per-patient or per-dataset
/// content, INV-6).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Performance {
    pub c_index_median: f64,
    /// Present when the benchmark evaluated the AUC call rule for the method.
    pub auc_rule_median: Option<f64>,
    pub n_units: u32,
    pub n_datasets: u32,
}

/// A method's software declaration (`software{language, packages}`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Software {
    pub language: String,
    pub packages: BTreeMap<String, String>,
}

/// One method's full fact set — the `methods[]` entry of the committed catalogue
/// and the `GET /api/methods/{id}` payload (PROV-MC-3's MethodDetail is exactly
/// this entry).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Method {
    /// The stable package slug (identity of the method in the app).
    pub id: String,
    pub version: String,
    pub group: MethodGroup,
    pub group_label: String,
    /// The short human name (qa-fixes3 ITEM-1): the generator derives it from
    /// the description's lead phrase, capped at [`MAX_METHOD_TITLE_CHARS`],
    /// falling back to the prettified id — never empty.
    pub title: String,
    /// The one-sentence summary (the description's first sentence, capped at
    /// [`MAX_METHOD_SUMMARY_CHARS`]) — never empty.
    pub summary: String,
    /// The primary paper's published title when the benchmark tree knows it
    /// (built from the literature store at generation time); `None` when
    /// unknown — the list row shows the derived `title`, never this blank.
    pub paper_title: Option<String>,
    pub journal: String,
    pub year: u32,
    pub citations: u32,
    pub language: String,
    pub paper_doi: String,
    pub spec_status: String,
    pub frozen_model: bool,
    pub container: bool,
    pub runnable: bool,
    pub gate: Gate,
    pub env: CatalogueEnv,
    pub markers: MethodMarkers,
    pub covariates: CovariateMode,
    pub min_draws: u32,
    pub needs_baseline: bool,
    pub uses_history: UsesHistory,
    pub fitted: bool,
    pub saves_model: bool,
    pub own_outputs: Vec<String>,
    pub tasks: Vec<String>,
    pub required_markers: Option<RequiredMarkers>,
    pub needs_detection_call: bool,
    pub marker_groups_required: Vec<String>,
    pub description: String,
    pub timing: Timing,
    pub performance: Option<Performance>,
    pub embeds_training_data: bool,
    pub software: Software,
    pub licence: String,
    pub references: Vec<String>,
    pub params: BTreeMap<String, serde_json::Value>,
}

/// One vocabulary marker — the `markers[]` entry of the catalogue and the
/// vocabulary surface for the upload screen's marker-join offer.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VocabularyMarker {
    /// The marker id within `system` (e.g. a LOINC code or an HGNC symbol).
    pub id: String,
    pub system: MarkerSystem,
    pub display_name: String,
    pub aliases: Vec<String>,
    /// Board-group ids this marker belongs to (curated `marker-groups.tsv`).
    pub groups: Vec<String>,
    pub unit_family: UnitFamily,
    pub canonical_unit: String,
    /// How many runnable methods reference this marker.
    pub n_methods: u32,
}

/// One of the 7 board marker groups (screen B checkbox row).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MarkerGroup {
    pub id: String,
    pub display_name: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-2 — GET /api/methods
// ─────────────────────────────────────────────────────────────────────────────

/// The list-row projection — the full PROV-MC-1 fact set minus the
/// detail-only fields (description/software/licence/references/params and the
/// internal-ish gate/env/fitted/saves_model/own_outputs facts). Named explicitly
/// so a consumer binds the exact row vocabulary (the E-row performance text and
/// the models-dialog warning bind named fields here).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MethodSummary {
    pub id: String,
    pub group: MethodGroup,
    pub group_label: String,
    pub title: String,
    pub summary: String,
    pub paper_title: Option<String>,
    pub year: u32,
    pub language: String,
    pub journal: String,
    pub paper_doi: String,
    pub frozen_model: bool,
    pub runnable: bool,
    pub container: bool,
    pub spec_status: String,
    pub markers: MethodMarkers,
    pub covariates: CovariateMode,
    pub min_draws: u32,
    pub needs_detection_call: bool,
    pub uses_history: UsesHistory,
    pub tasks: Vec<String>,
    pub marker_groups_required: Vec<String>,
    pub required_markers: Option<RequiredMarkers>,
    pub needs_baseline: bool,
    pub embeds_training_data: bool,
    pub timing: Timing,
    pub performance: Option<Performance>,
}

impl MethodSummary {
    /// Project a summary from a full catalogue entry.
    pub fn from_method(m: &Method) -> Self {
        Self {
            id: m.id.clone(),
            group: m.group,
            group_label: m.group_label.clone(),
            title: m.title.clone(),
            summary: m.summary.clone(),
            paper_title: m.paper_title.clone(),
            year: m.year,
            language: m.language.clone(),
            journal: m.journal.clone(),
            paper_doi: m.paper_doi.clone(),
            frozen_model: m.frozen_model,
            runnable: m.runnable,
            container: m.container,
            spec_status: m.spec_status.clone(),
            markers: m.markers,
            covariates: m.covariates,
            min_draws: m.min_draws,
            needs_detection_call: m.needs_detection_call,
            uses_history: m.uses_history,
            tasks: m.tasks.clone(),
            marker_groups_required: m.marker_groups_required.clone(),
            required_markers: m.required_markers.clone(),
            needs_baseline: m.needs_baseline,
            embeds_training_data: m.embeds_training_data,
            timing: m.timing,
            performance: m.performance,
        }
    }
}

/// The `GET /api/methods` response — the full (unpaged) runnable set, bounded at
/// roughly 400 rows; the list screen filters client-side (DEC-11).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MethodListResponse {
    pub methods: Vec<MethodSummary>,
    pub total: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-3 — GET /api/methods/{method_id}
// ─────────────────────────────────────────────────────────────────────────────

/// The method detail payload: the full catalogue entry (the About dialog + list
/// row facts). `GET /api/methods/{id}` is typed with this name in the route docs.
pub type MethodDetail = Method;

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-4 — GET /api/markers
// ─────────────────────────────────────────────────────────────────────────────

/// The marker-vocabulary response (the join-offer + the B-screen group-panel
/// vocabulary; the checkbox set is built from `groups`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MarkerVocabularyResponse {
    pub markers: Vec<VocabularyMarker>,
    pub groups: Vec<MarkerGroup>,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-5 — POST /api/methods/eligibility
// ─────────────────────────────────────────────────────────────────────────────

/// Screen B's preview body: which marker groups the user picked, and the
/// draw-schedule answers (before-treatment values, draws during treatment, last
/// draw day).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PreviewEligibilityRequest {
    /// group id → checked. Absent groups count as unchecked.
    pub marker_groups: BTreeMap<String, bool>,
    /// `always` | `sometimes` (whether the treating clinician always has a
    /// before-treatment sample).
    pub before_treatment: String,
    /// The number of on-treatment draws the user will record (1|2|4).
    pub draws_during_treatment: u32,
    /// The last draw day the schedule reaches (28|42|56|84).
    pub last_draw_day: f64,
}

/// A standard identifier of a file marker column (`(system, id)`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StandardId {
    pub system: String,
    pub id: String,
}

/// One patient's marker coverage (baseline + on-treatment draw counts).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PatientDrawCounts {
    pub patient_key: String,
    pub baseline_draws: u32,
    pub ontreatment_draws: u32,
}

/// One marker column of the file inventory.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InventoryMarker {
    /// The file column key (the validator's stable key).
    pub key: String,
    pub display_name: String,
    pub unit_family: UnitFamily,
    pub standard_ids: Vec<StandardId>,
    /// The column is a detection call (present/absent, not a measured value).
    pub is_detection_call: bool,
    /// The column has a `__detected`/`__lod` companion (data.py's companion
    /// semantics — companions never rank or match).
    pub has_detection_companion: bool,
    pub n_patients_with_value: u32,
    pub n_patients_with_baseline: u32,
    pub n_patients_with_ontreatment: u32,
    /// Per-patient draw counts; OMITTED when the validator does not carry them
    /// (coverage then falls back to the patient-level counts above).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_patient: Option<Vec<PatientDrawCounts>>,
}

/// One covariate column of the file inventory.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InventoryCovariate {
    /// The file column key (the validator's stable key).
    pub key: String,
    pub display_name: String,
    pub unit_family: UnitFamily,
    pub standard_ids: Vec<StandardId>,
}

/// The file's outcome-column facts — the availability of the four outcome
/// column kinds the validator resolves (`responder`/`response_day` for the
/// response task, `pfs_*`/`os_*` event + time for the survival task). The
/// engine needs them to emit the three outcome-availability verdicts
/// (`RESPONSE_LABEL_MISSING`, `SURVIVAL_OUTCOME_MISSING`,
/// `TASK_INCOMPATIBLE` — PROV-MC-5's grown vocabulary); they are facts the
/// validator knows and puts on the inventory it posts.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FileOutcomes {
    /// The file carries a `responder` column (per patient).
    pub has_responder: bool,
    /// The file carries a `response_day` column (per patient).
    pub has_response_day: bool,
    /// The file carries a survival event column (`pfs_event`/`os_event`).
    pub has_event: bool,
    /// The file carries a survival time column (`pfs_days`/`os_days`).
    pub has_survival_day: bool,
}

/// The file-inventory body (screens C/N/E — the consumer that holds the file
/// posts it).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InventoryEligibilityRequest {
    pub patients: u32,
    pub decision_day: f64,
    pub baseline_max_day: f64,
    pub markers: Vec<InventoryMarker>,
    pub covariates: Vec<InventoryCovariate>,
    /// The outcome-column facts of the file, when the consumer knows them
    /// (absence skips the outcome-availability checks — a request without them
    /// is not misclassified by the engine).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcomes: Option<FileOutcomes>,
}

/// The eligibility request body — a tagged union carrying exactly one of the two
/// request kinds (`{"preview": …}` or `{"inventory": …}`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum EligibilityRequest {
    Preview {
        preview: PreviewEligibilityRequest,
    },
    Inventory {
        inventory: InventoryEligibilityRequest,
    },
}

/// The three-method eligibility verdict vocabulary (the board's "Can run / Can
/// run for some patients / Cannot run").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EligibilityStatus {
    CanRun,
    CanRunSome,
    CannotRun,
}

/// The eligibility reason-code vocabulary — the FIXED, structured set of 12
/// codes a method verdict can carry. Display text is the consumer's; a renderer
/// switches on the code, so the set is closed and documented here (PROV-MC-5's
/// acceptance: every emitted code is one of these — consumers can never meet an
/// undocumented code).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum ReasonCode {
    /// A required standard-id marker is absent from the inventory.
    #[serde(rename = "REQUIRED_MARKER_MISSING")]
    RequiredMarkerMissing,
    /// A required board marker group is unchecked (preview body only).
    #[serde(rename = "MARKER_GROUP_MISSING")]
    MarkerGroupMissing,
    /// The method needs a detection call and the inventory has none.
    #[serde(rename = "DETECTION_CALL_MISSING")]
    DetectionCallMissing,
    /// Too few patients meet the method's minimum-draws rule.
    #[serde(rename = "MIN_DRAWS_UNMET")]
    MinDrawsUnmet,
    /// A covariate the method needs is absent from the inventory.
    #[serde(rename = "COVARIATE_MISSING")]
    CovariateMissing,
    /// A required covariate is absent (methods with `covariates: required`).
    #[serde(rename = "COVARIATE_REQUIRED_UNMET")]
    CovariateRequiredUnmet,
    /// A present marker's unit family differs from the method's.
    #[serde(rename = "UNIT_MISMATCH")]
    UnitMismatch,
    /// The last available draw falls after the decision day.
    #[serde(rename = "DECISION_DAY_UNMET")]
    DecisionDayUnmet,
    /// The method carries no runnable env image.
    #[serde(rename = "NOT_RUNNABLE")]
    NotRunnable,
    /// The method has no published environment image available (the
    /// app's env manifest carries no host-arch entry) — the run would fail at
    /// start, so the verdict names it in advance and the run row carries the
    /// SAME code (one vocabulary, CONS-EE-10; the catalogue still lists the
    /// method — the environment is the missing half).
    #[serde(rename = "ENV_IMAGE_MISSING")]
    EnvImageMissing,
    /// The method's task needs an outcome column the file lacks.
    #[serde(rename = "TASK_INCOMPATIBLE")]
    TaskIncompatible,
    /// A response method without `responder` / `response_day` columns.
    #[serde(rename = "RESPONSE_LABEL_MISSING")]
    ResponseLabelMissing,
    /// A survival method without event / survival-day columns.
    #[serde(rename = "SURVIVAL_OUTCOME_MISSING")]
    SurvivalOutcomeMissing,
}

impl ReasonCode {
    /// The closed code vocabulary, in documentation order — the compile-time
    /// constant the vocabulary test pins (TEST-MC-27).
    pub const ALL: [ReasonCode; 13] = [
        ReasonCode::RequiredMarkerMissing,
        ReasonCode::MarkerGroupMissing,
        ReasonCode::DetectionCallMissing,
        ReasonCode::MinDrawsUnmet,
        ReasonCode::CovariateMissing,
        ReasonCode::CovariateRequiredUnmet,
        ReasonCode::UnitMismatch,
        ReasonCode::DecisionDayUnmet,
        ReasonCode::NotRunnable,
        ReasonCode::EnvImageMissing,
        ReasonCode::TaskIncompatible,
        ReasonCode::ResponseLabelMissing,
        ReasonCode::SurvivalOutcomeMissing,
    ];

    /// The code's wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            ReasonCode::RequiredMarkerMissing => "REQUIRED_MARKER_MISSING",
            ReasonCode::MarkerGroupMissing => "MARKER_GROUP_MISSING",
            ReasonCode::DetectionCallMissing => "DETECTION_CALL_MISSING",
            ReasonCode::MinDrawsUnmet => "MIN_DRAWS_UNMET",
            ReasonCode::CovariateMissing => "COVARIATE_MISSING",
            ReasonCode::CovariateRequiredUnmet => "COVARIATE_REQUIRED_UNMET",
            ReasonCode::UnitMismatch => "UNIT_MISMATCH",
            ReasonCode::DecisionDayUnmet => "DECISION_DAY_UNMET",
            ReasonCode::NotRunnable => "NOT_RUNNABLE",
            ReasonCode::EnvImageMissing => "ENV_IMAGE_MISSING",
            ReasonCode::TaskIncompatible => "TASK_INCOMPATIBLE",
            ReasonCode::ResponseLabelMissing => "RESPONSE_LABEL_MISSING",
            ReasonCode::SurvivalOutcomeMissing => "SURVIVAL_OUTCOME_MISSING",
        }
    }
}

/// One structured reason of a method verdict — code + per-code params (the
/// display strings are built from these by the consumer; the params keys are
/// per-code and rendered by the consumer's copy).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Reason {
    pub code: ReasonCode,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, serde_json::Value>,
    /// The board group the reason belongs to, when the reason is group-scoped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

/// A required marker the inventory lacks (listed with its group for the B-screen
/// reason list and the per-marker decision-day reasons).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MissingMarker {
    pub id: String,
    pub id_system: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

/// A board group a method needs and the file/preview does not provide.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MissingGroup {
    pub group_id: String,
    pub display_name: String,
}

/// Per-patient coverage aggregate (no per-patient payload in the response —
/// coverage facts only).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub struct Coverage {
    pub eligible: u32,
    pub total: u32,
    pub fraction: f64,
}

/// The minimum-draws verdict for a method (the board's "needs N draws; M of K
/// have them").
#[derive(Debug, Clone, Copy, Serialize, Deserialize, JsonSchema)]
pub struct MinDraws {
    pub required: u32,
    pub met: u32,
    pub unmet_patients: u32,
}

/// One method's eligibility verdict.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MethodEligibility {
    pub id: String,
    pub status: EligibilityStatus,
    pub reasons: Vec<Reason>,
    pub missing_markers: Vec<MissingMarker>,
    pub missing_groups: Vec<MissingGroup>,
    pub coverage: Coverage,
    pub min_draws: MinDraws,
    pub estimated_seconds: f64,
    pub estimate_quality: TimingQuality,
}

/// The eligibility response — per-method verdicts plus the screen-B totals.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EligibilityResponse {
    pub methods: Vec<MethodEligibility>,
    pub total_fit: u32,
    pub total_some: u32,
    pub total_cannot: u32,
    /// The `cannot_run` methods whose reason is
    /// [`ReasonCode::EnvImageMissing`] — the count of catalogue methods the
    /// app cannot actually start (no published environment available), so the
    /// list header can say how many exist while still
    /// listing them.
    pub total_no_env: u32,
}

// ─────────────────────────────────────────────────────────────────────────────
// PROV-MC-6 — POST /api/methods/estimate
// ─────────────────────────────────────────────────────────────────────────────

/// The estimate request: which methods, on how many patients, on how many
/// CPUs, running `at_a_time` lanes.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EstimateRequest {
    pub method_ids: Vec<String>,
    pub patients: u32,
    /// The CPU count an estimate is scaled to. Absent (or `null`) means the
    /// run's own resolution — the host's detected CPUs ([`estimate::host_cpus`],
    /// the ONE implementation the execution engine's run-start detection also
    /// calls), so the bar and the running header always employ the same count.
    /// A present value is used as posted (0 is rejected).
    #[serde(default)]
    pub cpus: Option<u32>,
    /// Defaults to [`DEFAULT_ESTIMATE_AT_A_TIME`] when omitted.
    #[serde(default = "default_estimate_at_a_time")]
    pub at_a_time: u32,
}

fn default_estimate_at_a_time() -> u32 {
    DEFAULT_ESTIMATE_AT_A_TIME
}

/// One method's estimate.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct MethodEstimate {
    pub id: String,
    pub estimated_seconds: f64,
    pub estimate_quality: TimingQuality,
}

/// The estimate response: per-method seconds, the plain sum, and the
/// longest-processing-time schedule total over the `at_a_time` lanes (the
/// bottom-bar "about X minutes in total"). `cpus` is the
/// count actually used (the posted value, or the run's own resolution —
/// [`estimate::host_cpus`] — when omitted), so the consumer can show the
/// number the estimate was scaled to.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EstimateResponse {
    pub methods: Vec<MethodEstimate>,
    pub total_seconds: f64,
    pub schedule_seconds: f64,
    pub at_a_time: u32,
    pub cpus: u32,
}

/// The wire contracts stay generate-able: every request/response schema is
/// emitted into the openapi spec by the regen, so a schemars limitation (e.g.
/// on the untagged union) must surface HERE, not at the first regen that
/// references the types. The enum wire strings are asserted out of the
/// generated schema — the strings consumers switch on are those listed in the
/// vocabulary (the serde side is pinned by the catalogue-load tests).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_types_generate_schemas() {
        let _ = schemars::schema_for!(MethodListResponse);
        let _ = schemars::schema_for!(MethodDetail);
        let _ = schemars::schema_for!(MarkerVocabularyResponse);
        let _ = schemars::schema_for!(EligibilityRequest);
        let _ = schemars::schema_for!(EligibilityResponse);
        let _ = schemars::schema_for!(EstimateResponse);
        let _ = schemars::schema_for!(ReasonCode);
    }

    /// TEST-MC-27 (unit half): the reason-code vocabulary is a CLOSED compile-
    /// time set — exactly the 13 documented codes, each with a distinct wire
    /// string, so a consumer's per-code renderer can never meet an
    /// undocumented code and the serde side can never emit duplicates.
    #[test]
    fn reason_code_vocabulary_is_closed_and_distinct() {
        assert_eq!(ReasonCode::ALL.len(), 13, "the 13 documented codes");
        let mut wires: Vec<&str> = ReasonCode::ALL.iter().map(|c| c.as_str()).collect();
        wires.sort_unstable();
        wires.dedup();
        assert_eq!(wires.len(), 13, "wire strings are distinct");
        for code in ReasonCode::ALL {
            // The round-trip: serialize → deserialize must yield the same code
            // (the serde renames are the wire strings the engine emits).
            let json = serde_json::to_value(code).expect("serialize");
            let back: ReasonCode = serde_json::from_value(json.clone()).expect("deserialize");
            assert_eq!(back, code, "round-trip of {}", code.as_str());
            assert_eq!(json.as_str().expect("string"), code.as_str());
        }
    }

    #[test]
    fn enum_wire_strings_are_the_schema_strings() {        let s =
            serde_json::to_value(schemars::schema_for!(EligibilityStatus)).expect("serializable");
        let s = format!("{s}");
        assert!(
            s.contains("\"can_run\"")
                && s.contains("\"can_run_some\"")
                && s.contains("\"cannot_run\"")
        );

        let s = serde_json::to_value(schemars::schema_for!(ReasonCode)).expect("serializable");
        let s = format!("{s}");
        for code in ReasonCode::ALL {
            assert!(
                s.contains(code.as_str()),
                "schema must carry {}",
                code.as_str()
            );
        }

        let s = serde_json::to_value(schemars::schema_for!(MarkerSystem)).expect("serializable");
        let s = format!("{s}");
        assert!(s.contains("\"HGNC\"") && s.contains("\"UNIPROT\""));

        let s = serde_json::to_value(schemars::schema_for!(MethodGroup)).expect("serializable");
        let s = format!("{s}");
        assert!(s.contains("\"dynamic-risk\"") && s.contains("\"response-call\""));
    }
}
