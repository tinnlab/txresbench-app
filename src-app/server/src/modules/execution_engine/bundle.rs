//! The contract bundle — `bundle.rs` (PLAN ITEM-3 + ITEM-4, re-pinned by
//! DRIFT-2 to package contract 2.0): the canonical rows → the files a method
//! receives under `/input/` (`train/long.csv`, `train/long_full.csv`,
//! `train/outcomes.csv`, `train/covariates.csv`, `test/long.csv`,
//! `test/patients.csv`, `test/covariates.csv`) plus `/input/params.json`.
//!
//! The rules are a port of the package's `core/src/prepare.cpp`
//! (`build_train`, `build_test`, `draw_status`, `train_files`, `write_test`,
//! `make_params`) — the published contract 2.0 implementation — with the
//! `package/contract/2.0/*.schema.json` column sets as the fixed shapes.
//! `dev/code/benchmark/schema/contract.md` v1.2 and `driver/bundle.py` are NOT
//! port sources (DRIFT-2).
//!
//! ### What is pinned here
//!
//! - **Landmark/cohort**: a patient's draw status counts ONE sample per
//!   distinct draw day — the app's measurements carry no `sample_id`, so
//!   `sample_id := the draw day` (DRIFT-2); a draw on or before
//!   `baseline_max_day` is a baseline draw (negative pre-treatment days
//!   count), a later draw up to the landmark is an on-treatment draw; the
//!   cohort = baseline + on-treatment + `≥ min_draws` distinct samples.
//!   Companion rows (`<marker>__detected` / `<marker>__lod`) never count as
//!   draws — they are data the method receives, not evidence.
//! - **Per-method marker set (ITEM-4)**: contract 2.0's caller-passed-marker
//!   rule — the engine selects exactly the markers the method declares
//!   ([`method_marker_set`] + the package's `check_marker_count` count rule),
//!   and every bundle file, the cohort draw status and `params.markers` are
//!   scoped to that set; companions follow their base; the test side must
//!   carry the same set ("predict gets markers the model was not trained on,
//!   or lacks one it was").
//! - **Outcomes** (`outcomes.csv` is the FIXED column set of contract 2.0:
//!   `pfs_time, pfs_event, os_time, os_event, no_response,
//!   progressive_disease, progression_H<h>, death_H<h>`; an empty cell = not
//!   available / not applicable / censored before h): an outcome is learned
//!   from a patient only while the patient is event-free at the landmark
//!   (survival: time > landmark) or, for response, was assessed after the
//!   landmark (`response_day > landmark`, or the user's `label_day`
//!   override) and did not progress by it. An outcome with fewer than
//!   [`MIN_TRAINING_PATIENTS`] eligible patients is not learned (a warning is
//!   carried, never a silent drop); a bundle with no learnable outcome is a
//!   typed refusal.
//! - **Task compatibility (ITEM-4)**: [`task_compatibility`] is the engine's
//!   own check of the method's `tasks` against the file's resolved outcome
//!   columns, returning the provider's reason codes verbatim.
//! - **History**: `train/long.csv` holds every draw up to the landmark;
//!   `train/long_full.csv` holds, additionally, every draw before the
//!   patient's own (earliest) outcome time — the method's history window.
//! - **Input passthrough**: patient ids pass through untouched (char ids
//!   allowed); values pass through raw from the canonical rows (a
//!   non-numeric value cell is an empty cell — the file-validator's R03
//!   reported it, nothing is repaired); covariate cells are written as
//!   declared (number or text, one type per column — never guessed).
//!   Companion rows ride along in the CSV files exactly as declared.
//! - **`params.json`** (contract 2.0): `landmark_day, horizons [the run's
//!   single look-ahead], outcomes, markers (the method's selected main
//!   markers, sorted, without the companions), baseline_max_day,
//!   covariates (bool), method_params {}, seed 1, threads`. No
//!   `task`/`endpoint`/`features`/`marker_ranking` — those were contract v1.2
//!   shapes (DRIFT-2).
//! - **Run endpoint**: the bundle is endpoint-agnostic by the contract — the
//!   package learns every outcome the tables support; the run's `endpoint`
//!   picks the PRIMARY outcome the results screen renders (ITEM-5's
//!   column-selection), never which rows the file carries.
//!
//! Pure functions: no I/O, no state — the same canonical bundle + settings
//! yield byte-equal files (the caller writes them under the run dir).

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use crate::modules::execution_engine::types::RunConfig;
use crate::modules::file_validator::rules::companion_base;
use crate::modules::file_validator::types::{CanonCell, CanonicalBundle, CanonicalFeature, CanonicalPatient, CanonicalValue};
use crate::modules::method_catalogue::eligibility::is_companion;
use crate::modules::method_catalogue::types::{
    FileOutcomes, MarkerKind, MethodMarkers, ReasonCode, RequiredMarker, RequiredMarkers,
};

// ─────────────────────────────────────────────────────────────────────────────
// Contract 2.0 constants (the package's `core/include/txresbench/*.hpp`)
// ─────────────────────────────────────────────────────────────────────────────

/// Fewest eligible training patients an outcome needs before it is learned
/// (the package's `MIN_TRAINING_PATIENTS`; the contract's
/// "enough patients (fit): fewer than 10 training patients have an outcome"
/// x-check).
pub const MIN_TRAINING_PATIENTS: usize = 10;

/// The outcome vocabulary of the contract (`progression` = pfs,
/// `death` = os, `no_response` / `progressive_disease` = the response
/// labels), in the package's `outcome_names()` order — the order
/// `params.outcomes` and the `n_outcome` map follow.
pub const OUTCOME_NAMES: [&str; 4] = [
    "progression",
    "death",
    "no_response",
    "progressive_disease",
];

/// The fixed column set of `outcomes.csv` before the per-horizon columns
/// (contract 2.0, `input.schema.json` `train/outcomes.csv`).
pub const OUTCOMES_COLUMNS_PREFIX: [&str; 7] = [
    "patient_id",
    "pfs_time",
    "pfs_event",
    "os_time",
    "os_event",
    "no_response",
    "progressive_disease",
];

/// A horizon's column name: `progression_H238` / `death_H238` (the package's
/// `horizon_name`: "238" / "238.5"; the schema's `^…_H[0-9.]+$` pattern).
pub fn horizon_column(outcome: &str, horizon: f64) -> String {
    format!("{outcome}_H{horizon}")
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings + outputs
// ─────────────────────────────────────────────────────────────────────────────

/// The run's bundle settings — the `RunConfig` fields the bundle reads, plus
/// the per-method pieces ITEM-8/9 computes (DEC-12's `threads` = the
/// per-method lane CPU count; `seed` is the fixed contract default 1).
#[derive(Debug, Clone, PartialEq)]
pub struct BundleSettings {
    /// The landmark (`landmark_day` in params.json) — board E's decision day.
    pub decision_day: f64,
    /// The single horizon (`horizons = [look_ahead_day]`).
    pub look_ahead_day: f64,
    /// A draw on or before this day is a baseline draw. The app's own
    /// file-validator default is 0 (`DEFAULT_BASELINE_MAX_DAY`) — board B has
    /// no baseline-maximum input, so the engine pins 0.
    pub baseline_max_day: f64,
    /// Whether the `covariates.csv` files are written (board E's covariates
    /// checkbox; `params.covariates`).
    pub covariates: bool,
    /// The response label day override (DEC-9's D3 guard). `None` = the
    /// per-patient `response_day` rule of the package; `Some(l)` = the run
    /// asserts every response was assessed at day `l`, so `no_response` is
    /// learned only when `l > decision_day`.
    pub label_day: Option<f64>,
    /// The fixed contract seed (1).
    pub seed: u32,
    /// The per-method CPU count (`params.threads`, DEC-12).
    pub threads: u32,
}

impl BundleSettings {
    /// The settings for a run config: the engine pins `baseline_max_day` to
    /// the file-validator's default (0) and `seed` to the contract default
    /// (1); `threads` is the per-method lane CPU count DEC-12 computes for
    /// each method (so it is an argument here — a methods's params.threads is
    /// never the "unset" placeholder).
    pub fn for_run(config: &RunConfig, threads: u32) -> Self {
        Self {
            decision_day: config.decision_day,
            look_ahead_day: config.look_ahead_day,
            baseline_max_day: crate::modules::file_validator::types::DEFAULT_BASELINE_MAX_DAY,
            covariates: config.covariates,
            label_day: config.label_day,
            seed: 1,
            threads,
        }
    }
}

/// One written bundle file: the package's file name (relative to `train/` or
/// `test/`) and its full CSV text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleFile {
    pub name: &'static str,
    pub csv: String,
}

/// The `train/` bundle (the port of `build_train` + `train_files` +
/// `make_params`): the cohort, the learned outcomes, the written files and
/// the params the method receives.
#[derive(Debug, Clone, PartialEq)]
pub struct TrainBundle {
    /// `long.csv`, `long_full.csv`, `outcomes.csv` and, when covariates are
    /// on, `covariates.csv` — in package order.
    pub files: Vec<BundleFile>,
    /// The `/input/params.json` value (contract 2.0 field set).
    pub params: serde_json::Value,
    /// The learned outcomes, in [`OUTCOME_NAMES`] order.
    pub outcomes: Vec<String>,
    /// One entry per outcome — the eligible-patient count (the package's
    /// `n_outcome` map; an outcome absent from the tables stays at 0).
    pub n_outcome: BTreeMap<String, usize>,
    /// The data-side warnings (an outcome not learned: too few eligible
    /// patients).
    pub warnings: Vec<String>,
    /// The main (non-companion) marker names, sorted — `params.markers`.
    pub marker_names: Vec<String>,
    /// The cohort patient ids, sorted as the `outcomes.csv` rows are written.
    pub patient_ids: Vec<String>,
}

/// The `test/` bundle (the port of `build_test` + `write_test`): the scored
/// row set (the contract's "exactly the rows to predict") and the per-patient
/// skip reasons the engine turns into abstention notes + coverage.
#[derive(Debug, Clone, PartialEq)]
pub struct TestBundle {
    /// `long.csv`, `patients.csv` and, when covariates are on,
    /// `covariates.csv` — in package order.
    pub files: Vec<BundleFile>,
    /// The scored patient ids, sorted (`patients.csv` rows — the rows the
    /// method must predict, exactly).
    pub scored: Vec<String>,
    /// Every predict-side patient NOT scored, with the reason (the package's
    /// `skipped` map: the note the engine carries per patient, EXAMPLE-EE-1's
    /// "fewer than 3 draws by day 56").
    pub skipped: Vec<(String, String)>,
    /// The main (non-companion) marker names, sorted.
    pub marker_names: Vec<String>,
}

/// The per-method marker set — ITEM-4's selection (contract 2.0: the caller
/// passes the markers it wants used; `MethodSpec::check_marker_count` is the
/// package's count rule, so the engine picks exactly what the method declares
/// and writes `/input` from it). The mains are what `params.markers` lists;
/// companions (`__detected`/`__lod`) ride along in the CSV rows only when
/// their base marker is in the set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerSelection {
    /// The main (non-companion) marker names the method receives, sorted.
    pub mains: Vec<String>,
    /// The companion names whose base marker is selected, sorted.
    pub companions: Vec<String>,
}

impl MarkerSelection {
    /// The selection the engine applies when a method is marker-agnostic or
    /// declares no fixed list: every main marker of the bundle.
    pub fn all(bundle: &CanonicalBundle) -> Self {
        Self::with_mains(main_markers(bundle), bundle)
    }

    /// The `params.markers` list (the mains, sorted).
    pub fn mains(&self) -> &[String] {
        &self.mains
    }

    /// Whether a feature name belongs to the method's bundle (a selected main
    /// or a companion of one).
    pub fn contains(&self, feature: &str) -> bool {
        self.mains.iter().any(|m| m == feature)
            || self.companions.iter().any(|c| c == feature)
    }

    /// The companion names from the bundle's own rows whose base marker is
    /// selected — a companion never rides without its base (and never counts
    /// as a draw; `draw_status` skips it).
    fn with_mains(mains: Vec<String>, bundle: &CanonicalBundle) -> Self {
        let base: std::collections::BTreeSet<&str> = mains.iter().map(|s| s.as_str()).collect();
        let mut companions: Vec<String> = bundle
            .values
            .iter()
            .map(|v| v.feature.clone())
            .filter(|f| is_companion(f) && base.contains(companion_base(f)))
            .collect();
        companions.sort();
        companions.dedup();
        Self { mains, companions }
    }
}

/// A bundle construction refusal (the package's thrown `Error`s, typed). The
/// orchestrator maps each onto the run/method row's reason — a method whose
/// bundle cannot be built is a failure with the named code, never a silent
/// run with an empty train set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BundleError {
    /// No training patient has a baseline draw, a draw during treatment by
    /// the landmark AND an outcome to learn (the package's "no training
    /// patient …" refusal; `min_draws` is the method's).
    NoTrainingPatient { min_draws: u32 },
    /// No outcome reaches [`MIN_TRAINING_PATIENTS`] eligible patients.
    NoLearnableOutcome { min: usize },
    /// `covariates: true` but the patients table carries no covariate
    /// column (the package's "covariates=True but the patients table has no
    /// cov_* column").
    CovariatesWithoutColumns,
    /// The test side uses covariates but no predict-side patients table was
    /// given (the package's "this model uses covariates: pass patients …").
    TestCovariatesNeedPatients,
    /// A scored predict patient has no row in the predict patients table
    /// while covariates are on.
    TestPatientWithoutCovariateRow { patient_id: String },
    /// The bundle carries no main (non-companion) marker — the package's
    /// "needs at least one marker" refusal of `check_marker_count`.
    NoMainMarker,
    /// The method's declared marker-count rule is not satisfied by the
    /// per-method marker set (the package's `check_marker_count` message:
    /// "takes exactly one marker, but 2 were passed (M1, M2)").
    MarkerCountUnmet {
        /// The declared count (`1` for `single`, the `count` for
        /// `multi`/`panel`).
        expected: usize,
        /// The markers the set held.
        names: Vec<String>,
    },
    /// The predict side carries no row for a marker the train side / model
    /// was trained on (the contract's "predict gets markers the model was
    /// not trained on, or lacks one it was").
    TestMarkerMissing { marker: String },
}

impl BundleError {
    /// The stable machine code (the run/method reason vocabulary this node
    /// grows by the bundle-refusal names; the UI renders the detail).
    pub fn code(&self) -> &'static str {
        match self {
            BundleError::NoTrainingPatient { .. } => "BUNDLE_NO_TRAINING_PATIENT",
            BundleError::NoLearnableOutcome { .. } => "BUNDLE_NO_LEARNABLE_OUTCOME",
            BundleError::CovariatesWithoutColumns => "BUNDLE_COVARIATES_MISSING",
            BundleError::TestCovariatesNeedPatients => "BUNDLE_TEST_COVARIATES_MISSING",
            BundleError::TestPatientWithoutCovariateRow { .. } => "BUNDLE_TEST_PATIENT_UNKNOWN",
            BundleError::NoMainMarker => "BUNDLE_NO_MAIN_MARKER",
            BundleError::MarkerCountUnmet { .. } => "BUNDLE_MARKER_COUNT_UNMET",
            BundleError::TestMarkerMissing { .. } => "BUNDLE_TEST_MARKER_MISSING",
        }
    }
}

impl fmt::Display for BundleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BundleError::NoTrainingPatient { min_draws } => write!(
                f,
                "{}: no training patient has a baseline draw (day <= 0), a draw during treatment by the landmark and {min_draws} or more draws",
                self.code()
            ),
            BundleError::NoLearnableOutcome { min } => write!(
                f,
                "{}: no outcome has at least {min} eligible training patients",
                self.code()
            ),
            BundleError::CovariatesWithoutColumns => write!(
                f,
                "{}: covariates are on but the patients table has no cov_* column",
                self.code()
            ),
            BundleError::TestCovariatesNeedPatients => write!(
                f,
                "{}: the predict side uses covariates — pass the predict patients with patient_id and the cov_* columns",
                self.code()
            ),
            BundleError::TestPatientWithoutCovariateRow { patient_id } => write!(
                f,
                "{}: predict patient `{patient_id}` has no row, but covariates are on",
                self.code()
            ),
            BundleError::NoMainMarker => write!(
                f,
                "{}: the file carries no main (non-companion) marker — the method needs at least one",
                self.code()
            ),
            BundleError::MarkerCountUnmet { expected, names } => {
                let rule = if *expected == 1 {
                    "exactly one marker".to_string()
                } else {
                    format!("exactly {expected} markers")
                };
                let list = names.join(", ");
                write!(
                    f,
                    "{}: the method takes {rule}, but {} were passed ({list})",
                    self.code(),
                    names.len()
                )
            }
            BundleError::TestMarkerMissing { marker } => write!(
                f,
                "{}: the predict table carries no row for marker `{marker}`, but the train side was built on it",
                self.code()
            ),
        }
    }
}

impl std::error::Error for BundleError {}

// ─────────────────────────────────────────────────────────────────────────────
// The port: draw status → cohort → rows → files → params
// ─────────────────────────────────────────────────────────────────────────────

/// One patient's draw facts up to the landmark (the package's
/// `draw_status`): a baseline draw, a draw during treatment, and the count of
/// DISTINCT samples — the app has no `sample_id`, so one sample = one
/// distinct draw day (DRIFT-2). Companion rows never count.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct DrawStatus {
    baseline: bool,
    on_treatment: bool,
    samples: Vec<u64>,
}

fn draw_status(bundle: &CanonicalBundle, settings: &BundleSettings) -> BTreeMap<String, DrawStatus> {
    let mut out: BTreeMap<String, DrawStatus> = BTreeMap::new();
    for v in &bundle.values {
        if is_companion(&v.feature) {
            continue;
        }
        let s = out.entry(v.patient_id.clone()).or_default();
        if v.day <= settings.baseline_max_day {
            s.baseline = true;
        } else if v.day <= settings.decision_day {
            s.on_treatment = true;
        }
        if v.day <= settings.decision_day {
            let bits = v.day.to_bits();
            if !s.samples.contains(&bits) {
                s.samples.push(bits);
            }
        }
    }
    out
}

/// Whether the patient is IN the training cohort (baseline + on-treatment +
/// ≥ min_draws distinct samples).
fn in_cohort(status: &DrawStatus, min_draws: u32) -> bool {
    status.baseline && status.on_treatment && status.samples.len() >= min_draws as usize
}

/// One training row's outcome facts (the package's `OutcomeRow`; `None` = the
/// contract's empty cell).
#[derive(Debug, Clone, Default, PartialEq)]
struct OutcomeRow {
    patient_id: String,
    pfs_time: Option<f64>,
    pfs_event: Option<i64>,
    os_time: Option<f64>,
    os_event: Option<i64>,
    no_response: Option<i64>,
    progressive_disease: Option<i64>,
    progression_h: Vec<Option<i64>>,
    death_h: Vec<Option<i64>>,
    end_time: f64,
}

/// The label horizon values of one survival row (the package's per-horizon
/// rule: event by h → 1, event-free beyond h → 0, censored at or before h →
/// empty).
fn horizon_labels(time: f64, event: Option<i64>, horizons: &[f64]) -> Vec<Option<i64>> {
    horizons
        .iter()
        .map(|&h| {
            if event == Some(1) && time <= h {
                Some(1)
            } else if time > h {
                Some(0)
            } else {
                None
            }
        })
        .collect()
}

/// Assemble the outcome row of one training patient (the package's
/// `build_train` body): survival when event-free at the landmark, response
/// when assessed after the landmark and not progressed by it. The app's
/// patient tables carry no `best_response` column (board D48 — the four
/// required outcome columns + the optional `responder`/`response_day`), so
/// `no_response` comes from `responder` and `progressive_disease` is never
/// derivable (an empty cell — nothing is guessed).
fn outcome_row(
    patient: &CanonicalPatient,
    status: Option<&DrawStatus>,
    settings: &BundleSettings,
    horizons: &[f64],
    min_draws: u32,
) -> Option<OutcomeRow> {
    let status = status?;
    if !in_cohort(status, min_draws) {
        return None;
    }
    let mut r = OutcomeRow {
        patient_id: patient.patient_id.clone(),
        // A patient without a survival label keeps the horizon cells EMPTY
        // (the package's `assign(nh, NA)` creation — never a shorter row).
        progression_h: vec![None; horizons.len()],
        death_h: vec![None; horizons.len()],
        ..Default::default()
    };
    let mut any = false;

    // Survival outcomes: event-free at the landmark (the immigrant-time
    // exclusion — a patient with an event by the landmark has no label for
    // that outcome, but keeps the other one when it is open).
    if let (Some(t), Some(e)) = (patient.pfs_days, patient.pfs_event) {
        if t > settings.decision_day {
            r.pfs_time = Some(t);
            r.pfs_event = Some(e);
            r.progression_h = horizon_labels(t, Some(e), horizons);
            any = true;
        }
    }
    if let (Some(t), Some(e)) = (patient.os_days, patient.os_event) {
        if t > settings.decision_day {
            r.os_time = Some(t);
            r.os_event = Some(e);
            r.death_h = horizon_labels(t, Some(e), horizons);
            any = true;
        }
    }

    // Response outcome: D3's label-day guard. `assessed_late` is the user's
    // label-day override when given, else the per-patient response_day rule
    // (a missing response_day counts as assessed after the landmark).
    let progressed = matches!(
        (patient.pfs_days, patient.pfs_event),
        (Some(t), Some(e)) if e == 1 && t <= settings.decision_day
    );
    let assessed_late = match settings.label_day {
        Some(l) => l > settings.decision_day,
        None => match patient.response_day {
            None => true,
            Some(d) => d > settings.decision_day,
        },
    };
    if assessed_late && !progressed {
        if let Some(rsp) = patient.responder {
            r.no_response = Some(1 - rsp);
            any = true;
        }
    }

    if !any {
        return None;
    }

    // The history window stops at the patient's earliest outcome time (the
    // package's `end_time`; the landmark when no survival time is open).
    let mut end = f64::INFINITY;
    for t in [r.pfs_time, r.os_time].into_iter().flatten() {
        end = end.min(t);
    }
    r.end_time = if end.is_finite() { end } else { settings.decision_day };
    Some(r)
}

/// The main (non-companion) marker names, sorted (the package's
/// `main_markers`: distinct non-companion markers of the values, this
/// bundle's rows after the file-validator's row filtering).
fn main_markers(bundle: &CanonicalBundle) -> Vec<String> {
    let mut names: Vec<String> = bundle
        .values
        .iter()
        .map(|v| v.feature.clone())
        .filter(|f| !is_companion(f))
        .collect();
    names.sort();
    names.dedup();
    names
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-4 — the per-method marker set (contract 2.0's count rule), the fixed
// list resolution and the task-compatibility check
// ─────────────────────────────────────────────────────────────────────────────

/// Whether one required marker ids a bundle feature: the mapped vocabulary id
/// equality (a curated `(system, id)` and the file column's resolved
/// `marker_id` are ids of the same marker vocabulary) plus the
/// `other`-system name fallback (a required marker whose id system is
/// `other` is matched by its curated name, exactly the eligibility engine's
/// fallback path).
fn required_marker_matches(required: &RequiredMarker, feature: &CanonicalFeature) -> bool {
    let rid = required.id.trim().to_ascii_lowercase();
    if rid.is_empty() {
        return false;
    }
    if feature
        .marker_id
        .as_deref()
        .is_some_and(|m| m.trim().eq_ignore_ascii_case(&rid))
    {
        return true;
    }
    // The `other`-system name fallback (data.py's matching rule for a
    // required marker without a structured system identifier).
    if required.id_system.eq_ignore_ascii_case("other") {
        return feature
            .feature
            .trim()
            .eq_ignore_ascii_case(&required.name)
            || feature.feature.trim().eq_ignore_ascii_case(&rid);
    }
    false
}

/// The per-method marker set — the engine's side of contract 2.0's
/// caller-passed-marker rule plus `MethodSpec::check_marker_count`:
///
/// - a method with a **fixed marker list** (`required_markers`; every
///   `single`/`panel` method that names its markers) gets exactly the list's
///   markers as resolved in the FILE — the extras of a multi-marker upload
///   are not passed (the package would refuse "takes exactly N markers, but
///   M were passed");
/// - a method with **no fixed list** (`any`; `single`/`multi` without one)
///   gets the file's main markers, so its declared count rule is the file's
///   own marker count — a mismatch is a typed refusal before anything runs
///   (the package's "before anything is fitted");
/// - companions (`__detected`/`__lod`) follow their base: their rows are
///   written only when the base marker is selected, `params.markers` never
///   lists them.
///
/// The count rule is `single` → 1, `multi`/`panel` → `count`, `any` → ≥ 1;
/// `BUNDLE_MARKER_COUNT_UNMET`/`BUNDLE_NO_MAIN_MARKER` carry the machine
/// verdict (the package's own message text, quoted in the detail).
pub fn method_marker_set(
    bundle: &CanonicalBundle,
    declared: &MethodMarkers,
    required: Option<&RequiredMarkers>,
) -> Result<MarkerSelection, BundleError> {
    let file_mains = main_markers(bundle);
    let main_features: Vec<&CanonicalFeature> = bundle
        .features
        .iter()
        .filter(|f| !f.is_detection_companion)
        .collect();

    let selected = match required {
        // The fixed list: resolve it in the file, deduplicated (two entries
        // may hit one file marker — the eligibility engine's pointer-identity
        // dedup semantics).
        Some(req) if declared.kind != MarkerKind::Any => {
            let mut matched: Vec<String> = Vec::new();
            for r in &req.markers {
                if r.id.trim().is_empty() {
                    continue;
                }
                if let Some(f) = main_features
                    .iter()
                    .find(|f| required_marker_matches(r, f))
                {
                    let name = f.feature.clone();
                    if !matched.contains(&name) {
                        matched.push(name);
                    }
                }
            }
            matched.sort();
            matched
        }
        _ => file_mains.clone(),
    };

    match declared.kind {
        MarkerKind::Any if selected.is_empty() => return Err(BundleError::NoMainMarker),
        MarkerKind::Single if selected.len() != 1 => {
            return Err(BundleError::MarkerCountUnmet {
                expected: 1,
                names: selected,
            });
        }
        MarkerKind::Multi | MarkerKind::Panel if selected.len() != declared.count as usize => {
            return Err(BundleError::MarkerCountUnmet {
                expected: declared.count as usize,
                names: selected,
            });
        }
        _ => {}
    }

    Ok(MarkerSelection::with_mains(selected, bundle))
}

/// The bundle restricted to a marker set: values + features of the selected
/// mains and their companions (the package receives exactly the markers the
/// caller wants used; `draw_status` then counts the method's own draws).
fn filter_to_selection(
    bundle: &CanonicalBundle,
    selection: &MarkerSelection,
) -> CanonicalBundle {
    CanonicalBundle {
        patients: bundle.patients.clone(),
        values: bundle
            .values
            .iter()
            .filter(|v| selection.contains(&v.feature))
            .cloned()
            .collect(),
        features: bundle
            .features
            .iter()
            .filter(|f| selection.contains(&f.feature))
            .cloned()
            .collect(),
    }
}

/// The task-compatibility check (TEST-EE-11; the same truth table as the
/// eligibility engine's outcome-availability verdicts, so one vocabulary):
/// the method's declared `tasks` (an empty list = any outcome) against the
/// file's resolved outcome columns. The codes returned are the provider's
/// own ([`ReasonCode`]) — passed through verbatim onto the method row.
pub fn task_compatibility(tasks: &[String], outcomes: &FileOutcomes) -> Option<ReasonCode> {
    let has_response = outcomes.has_responder && outcomes.has_response_day;
    let has_survival = outcomes.has_event && outcomes.has_survival_day;
    let task_response = tasks.iter().any(|t| t.eq_ignore_ascii_case("response"));
    let task_survival = tasks.iter().any(|t| t.eq_ignore_ascii_case("survival"));
    if task_response && !has_response {
        Some(ReasonCode::ResponseLabelMissing)
    } else if task_survival && !has_survival {
        Some(ReasonCode::SurvivalOutcomeMissing)
    } else if (has_response || has_survival)
        && !((task_response && has_response) || (task_survival && has_survival))
    {
        Some(ReasonCode::TaskIncompatible)
    } else {
        None
    }
}

fn num_cell(v: f64) -> String {
    if v.is_nan() {
        return String::new();
    }
    let mut s = format!("{v}");
    if s == "-0" {
        s = "0".to_string();
    }
    s
}

fn int_cell(v: Option<i64>) -> String {
    v.map(|v| v.to_string()).unwrap_or_default()
}

/// Quote a CSV cell only when it needs it (the package's `put_cell`:
/// RFC-4180 quoting, `"` doubled).
fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\r', '\n']) {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for ch in s.chars() {
            if ch == '"' {
                out.push('"');
            }
            out.push(ch);
        }
        out.push('"');
        out
    } else {
        s.to_string()
    }
}

/// One CSV table: header + rows of string cells (the package's `Table` +
/// `to_csv`; an empty string = the contract's empty cell).
#[derive(Debug, Clone, PartialEq, Eq)]
struct CsvTable {
    names: Vec<String>,
    cols: Vec<Vec<String>>,
}

impl CsvTable {
    fn new(names: &[&str]) -> Self {
        Self::with_names(names.iter().map(|n| n.to_string()).collect())
    }

    fn with_names(names: Vec<String>) -> Self {
        let cols = vec![Vec::new(); names.len()];
        Self { names, cols }
    }

    fn push_row(&mut self, cells: &[String]) {
        debug_assert!(cells.len() == self.cols.len(), "{cells:?} vs {:?}", self.names);
        for (col, cell) in self.cols.iter_mut().zip(cells) {
            col.push(cell.clone());
        }
    }

    fn to_csv(&self) -> String {
        let mut out = String::new();
        for (i, name) in self.names.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&csv_cell(name));
        }
        out.push('\n');
        let n = self.cols.first().map(|c| c.len()).unwrap_or(0);
        for r in 0..n {
            for (i, col) in self.cols.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&csv_cell(&col[r]));
            }
            out.push('\n');
        }
        out
    }
}

/// Write the draws table (`long.csv` columns): sorted stable by
/// (patient_id, day, marker); `baseline` = 1 on or before baseline_max_day.
fn draws_table(draws: &[&CanonicalValue], settings: &BundleSettings) -> CsvTable {
    let mut idx: Vec<usize> = (0..draws.len()).collect();
    idx.sort_by(|&a, &b| {
        let (x, y) = (&draws[a], &draws[b]);
        x.patient_id
            .cmp(&y.patient_id)
            .then(x.day.partial_cmp(&y.day).unwrap_or(std::cmp::Ordering::Equal))
            .then(x.feature.cmp(&y.feature))
    });
    let mut t = CsvTable::new(&["patient_id", "day", "marker", "value", "baseline"]);
    for i in idx {
        let d = draws[i];
        t.push_row(&[
            d.patient_id.clone(),
            num_cell(d.day),
            d.feature.clone(),
            d.value.map(num_cell).unwrap_or_default(),
            if d.day <= settings.baseline_max_day {
                "1".to_string()
            } else {
                "0".to_string()
            },
        ]);
    }
    t
}

/// The covariate table (`covariates.csv`): patient_id + the covariate
/// columns, in `names` order, one row per `rows` entry (a patient without a
/// value is an empty cell — nothing is guessed).
fn cov_table(rows: &[(String, Vec<(String, CanonCell)>)], names: &[String]) -> CsvTable {
    let mut full: Vec<String> = vec!["patient_id".to_string()];
    full.extend(names.iter().cloned());
    let mut t = CsvTable::with_names(full);
    for (id, cells) in rows {
        let mut row = vec![id.clone()];
        for n in names {
            let cell = cells.iter().find(|(name, _)| name == n);
            row.push(match cell {
                Some((_, CanonCell::Number(v))) => num_cell(*v),
                Some((_, CanonCell::Text(s))) => s.clone(),
                None => String::new(),
            });
        }
        t.push_row(&row);
    }
    t
}

/// The covariate columns of a side: the names in first-appearance order
/// across its rows. Each (name, cell) pair travels the file-validator's
/// column order; the CSV header re-maps them, so any deterministic order is
/// the same name-keyed table for the contract's readers.
fn cov_column_names(rows: &[(String, Vec<(String, CanonCell)>)]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for (_, cells) in rows {
        for (name, _) in cells {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
    }
    names
}

// ─────────────────────────────────────────────────────────────────────────────
// train_bundle
// ─────────────────────────────────────────────────────────────────────────────

/// Build the `train/` bundle over EVERY main marker of the file (the marker-
/// agnostic convenience: the ENGINE's per-method path is
/// [`train_bundle_with_markers`], which the marker-selection step feeds).
pub fn train_bundle(
    bundle: &CanonicalBundle,
    settings: &BundleSettings,
    min_draws: u32,
) -> Result<TrainBundle, BundleError> {
    let selection = MarkerSelection::all(bundle);
    train_bundle_with_markers(bundle, settings, min_draws, &selection)
}

/// Build the `train/` bundle of one method over its marker set (the port of
/// `build_train` + `train_files` + `make_params`): the draws, the cohort
/// counts and `params.markers` are all scoped to the selection — a method
/// that takes one marker never sees another marker's rows, and the draw
/// status counts the samples those rows give.
pub fn train_bundle_with_markers(
    bundle: &CanonicalBundle,
    settings: &BundleSettings,
    min_draws: u32,
    selection: &MarkerSelection,
) -> Result<TrainBundle, BundleError> {
    let bundle = filter_to_selection(bundle, selection);
    if settings.covariates && bundle.patients.iter().all(|p| p.covariates.is_empty()) {
        return Err(BundleError::CovariatesWithoutColumns);
    }
    let horizons = [settings.look_ahead_day];
    let status = draw_status(&bundle, settings);

    // The cohort rows, with their covariate (name, cell) pairs.
    let mut rows: Vec<(OutcomeRow, Vec<(String, CanonCell)>)> = Vec::new();
    for patient in &bundle.patients {
        if let Some(row) =
            outcome_row(patient, status.get(&patient.patient_id), settings, &horizons, min_draws)
        {
            rows.push((row, patient.covariates.clone()));
        }
    }
    if rows.is_empty() {
        return Err(BundleError::NoTrainingPatient { min_draws });
    }

    // Learn-ability: per outcome, the eligible-patient count; learned only at
    // >= MIN_TRAINING_PATIENTS (a warning carries the rest; nothing is
    // silently dropped).
    let mut n_outcome: BTreeMap<String, usize> = OUTCOME_NAMES
        .iter()
        .map(|o| (o.to_string(), 0))
        .collect();
    for (row, _) in &rows {
        for o in OUTCOME_NAMES {
            let has = match o {
                "progression" => row.pfs_time.is_some(),
                "death" => row.os_time.is_some(),
                "no_response" => row.no_response.is_some(),
                _ => row.progressive_disease.is_some(),
            };
            if has {
                *n_outcome.get_mut(o).unwrap() += 1;
            }
        }
    }
    let mut outcomes: Vec<String> = Vec::new();
    let mut warnings = Vec::new();
    for o in OUTCOME_NAMES {
        let n = n_outcome[o];
        if n == 0 {
            continue;
        }
        if n < MIN_TRAINING_PATIENTS {
            warnings.push(format!(
                "outcome {o} is not learned: only {n} training patients are eligible (at least \
                 {MIN_TRAINING_PATIENTS} are needed)"
            ));
        } else {
            outcomes.push(o.to_string());
        }
    }
    if outcomes.is_empty() {
        return Err(BundleError::NoLearnableOutcome {
            min: MIN_TRAINING_PATIENTS,
        });
    }

    // The draw sets: long = up to the landmark; long_full = up to the
    // landmark OR before the patient's own outcome time (the package's
    // `day <= landmark || day < end_time`).
    let end_of: BTreeMap<&str, f64> = rows
        .iter()
        .map(|(r, _)| (r.patient_id.as_str(), r.end_time))
        .collect();
    let mut upto: Vec<&CanonicalValue> = Vec::new();
    let mut full: Vec<&CanonicalValue> = Vec::new();
    for v in &bundle.values {
        let Some(&end) = end_of.get(v.patient_id.as_str()) else {
            continue;
        };
        if v.day <= settings.decision_day || v.day < end {
            full.push(v);
            if v.day <= settings.decision_day {
                upto.push(v);
            }
        }
    }

    // The outcomes table: fixed column set, rows sorted by patient id.
    let mut ids: Vec<&str> = rows.iter().map(|(r, _)| r.patient_id.as_str()).collect();
    ids.sort();
    let mut columns: Vec<String> = OUTCOMES_COLUMNS_PREFIX.iter().map(|s| s.to_string()).collect();
    for o in ["progression", "death"] {
        columns.push(horizon_column(o, settings.look_ahead_day));
    }
    let mut table = CsvTable::with_names(columns);
    let by_id: BTreeMap<&str, &OutcomeRow> =
        rows.iter().map(|(r, _)| (r.patient_id.as_str(), r)).collect();
    for id in &ids {
        let r = by_id[id];
        table.push_row(&[
            id.to_string(),
            r.pfs_time.map(num_cell).unwrap_or_default(),
            int_cell(r.pfs_event),
            r.os_time.map(num_cell).unwrap_or_default(),
            int_cell(r.os_event),
            int_cell(r.no_response),
            int_cell(r.progressive_disease),
            r.progression_h[0].map(|v| v.to_string()).unwrap_or_default(),
            r.death_h[0].map(|v| v.to_string()).unwrap_or_default(),
        ]);
    }

    // Covariates: per-patient (name, cell) pairs, columns in first-appearance
    // order across the cohort (row order = patient order); the rows are
    // written in the outcomes table's sorted id order.
    let cov_cols: Vec<String> = {
        let all: Vec<(String, Vec<(String, CanonCell)>)> = rows
            .iter()
            .map(|(row, cells)| (row.patient_id.clone(), cells.clone()))
            .collect();
        cov_column_names(&all)
    };
    let mut cov_rows_build: Vec<(String, Vec<(String, CanonCell)>)> = Vec::new();
    for id in &ids {
        let (_, cells) = rows.iter().find(|(r, _)| r.patient_id == *id).unwrap();
        cov_rows_build.push((id.to_string(), cells.clone()));
    }

    let mut files = Vec::new();
    files.push(BundleFile {
        name: "long.csv",
        csv: draws_table(&upto, settings).to_csv(),
    });
    files.push(BundleFile {
        name: "long_full.csv",
        csv: draws_table(&full, settings).to_csv(),
    });
    files.push(BundleFile {
        name: "outcomes.csv",
        csv: table.to_csv(),
    });
    if settings.covariates {
        files.push(BundleFile {
            name: "covariates.csv",
            csv: cov_table(&cov_rows_build, &cov_cols).to_csv(),
        });
    }

    let markers = main_markers(&bundle);
    let params = serde_json::json!({
        "landmark_day": settings.decision_day,
        "horizons": [settings.look_ahead_day],
        "outcomes": outcomes,
        "markers": markers,
        "baseline_max_day": settings.baseline_max_day,
        "covariates": settings.covariates,
        "method_params": {},
        "seed": settings.seed,
        "threads": settings.threads,
    });

    Ok(TrainBundle {
        files,
        params,
        outcomes,
        n_outcome,
        warnings,
        marker_names: markers,
        patient_ids: ids.iter().map(|s| s.to_string()).collect(),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// test_bundle
// ─────────────────────────────────────────────────────────────────────────────

/// Build the `test/` bundle over EVERY main marker of the predict file (the
/// marker-agnostic convenience; the engine's per-method path is
/// [`test_bundle_with_markers`]).
pub fn test_bundle(
    predict_patients: Option<&[CanonicalPatient]>,
    bundle: &CanonicalBundle,
    settings: &BundleSettings,
    min_draws: u32,
) -> Result<TestBundle, BundleError> {
    let selection = MarkerSelection::all(bundle);
    test_bundle_with_markers(predict_patients, bundle, settings, min_draws, &selection)
}

/// Build the `test/` bundle of one method (the port of `build_test` +
/// `write_test`): the predict-side row set scoped to the SAME marker set the
/// train side (or the loaded model) was built on, its per-patient skip
/// reasons and the files the method predicts from. A selected marker with no
/// predict-side row is a typed refusal (the contract's "predict gets markers
/// the model was not trained on, or lacks one it was"); markers outside the
/// set are never written — the method receives exactly what it was trained
/// on.
pub fn test_bundle_with_markers(
    predict_patients: Option<&[CanonicalPatient]>,
    bundle: &CanonicalBundle,
    settings: &BundleSettings,
    min_draws: u32,
    selection: &MarkerSelection,
) -> Result<TestBundle, BundleError> {
    let bundle = filter_to_selection(bundle, selection);
    let present = main_markers(&bundle);
    for m in selection.mains() {
        if !present.contains(m) {
            return Err(BundleError::TestMarkerMissing { marker: m.clone() });
        }
    }
    let status = draw_status(&bundle, settings);

    // The predict-side ids: the measurement rows' distinct patients in
    // first-appearance order, then the predict patients table's ids (the
    // reuse mode's covariate-carrying rows) — the package's `seen`-set order.
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for v in &bundle.values {
        if seen.insert(v.patient_id.as_str()) {
            ids.push(v.patient_id.clone());
        }
    }
    if let Some(p) = predict_patients {
        for row in p {
            if seen.insert(row.patient_id.as_str()) {
                ids.push(row.patient_id.clone());
            }
        }
    }

    // Scored vs skipped, with the package's exact reason wording.
    let mut scored: Vec<String> = Vec::new();
    let mut skipped: Vec<(String, String)> = Vec::new();
    for id in &ids {
        let why = match status.get(id.as_str()) {
            None => format!("no draw by day {}", num_cell(settings.decision_day)),
            Some(s) if !s.baseline => format!(
                "no baseline draw (day <= {})",
                num_cell(settings.baseline_max_day)
            ),
            Some(s) if !s.on_treatment => format!(
                "no draw during treatment by day {}",
                num_cell(settings.decision_day)
            ),
            Some(s) if (s.samples.len() as u32) < min_draws => format!(
                "fewer than {min_draws} draws by day {}",
                num_cell(settings.decision_day)
            ),
            Some(_) => {
                scored.push(id.clone());
                continue;
            }
        };
        skipped.push((id.clone(), why));
    }
    scored.sort();

    // The scored draws (up to the landmark, all markers incl. companions).
    let scored_set: HashSet<&str> = scored.iter().map(|s| s.as_str()).collect();
    let draws: Vec<&CanonicalValue> = bundle
        .values
        .iter()
        .filter(|v| scored_set.contains(v.patient_id.as_str()) && v.day <= settings.decision_day)
        .collect();

    // Covariates for the test rows: the scored patients' cov cells, keyed by
    // the predict patients table, in the table's first-appearance order.
    let mut cov_rows: Vec<(String, Vec<(String, CanonCell)>)> = Vec::new();
    if settings.covariates {
        let Some(table) = predict_patients else {
            return Err(BundleError::TestCovariatesNeedPatients);
        };
        let mut by_id: BTreeMap<&str, &Vec<(String, CanonCell)>> = BTreeMap::new();
        for row in table {
            by_id.insert(row.patient_id.as_str(), &row.covariates);
        }
        for id in &scored {
            let cells = by_id
                .get(id.as_str())
                .ok_or_else(|| BundleError::TestPatientWithoutCovariateRow {
                    patient_id: id.clone(),
                })?;
            cov_rows.push((id.clone(), (**cells).clone()));
        }
    }

    let mut files = Vec::new();
    files.push(BundleFile {
        name: "long.csv",
        csv: draws_table(&draws, settings).to_csv(),
    });
    let mut patients_table = CsvTable::new(&["patient_id"]);
    for id in &scored {
        patients_table.push_row(&[id.clone()]);
    }
    files.push(BundleFile {
        name: "patients.csv",
        csv: patients_table.to_csv(),
    });
    if settings.covariates && !cov_rows.iter().any(|(_, c)| !c.is_empty()) {
        // The predict patients table carries no covariate columns: the
        // package's write condition (cov_names non-empty) keeps the file
        // absent; the caller (ITEM-9) cross-checks the model's trained
        // column names — nothing is written that a method would misread.
        return Ok(TestBundle {
            files,
            scored,
            skipped,
            marker_names: main_markers(&bundle),
        });
    }
    if settings.covariates {
        let names = cov_column_names(&cov_rows);
        files.push(BundleFile {
            name: "covariates.csv",
            csv: cov_table(&cov_rows, &names).to_csv(),
        });
    }

    Ok(TestBundle {
        files,
        scored,
        skipped,
        marker_names: main_markers(&bundle),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-EE-07, TEST-EE-08, TEST-EE-22 (contract 2.0 pins; the
// fixtures are synthetic in-test constructs — TEST-EE-22 asserts their
// provenance so no fixture can ever source a real dataset)

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::file_validator::types::{CanonicalBundle, CanonicalFeature};
    use crate::modules::method_catalogue::types::MatchMode;

    // ── the synthetic fixture (TEST-EE-22: ids S0000.., markers M1/M2) ──────

    fn patient(
        id: &str,
        pfs: Option<(f64, i64)>,
        os: Option<(f64, i64)>,
        responder: Option<i64>,
        response_day: Option<f64>,
        covars: &[(&str, CanonCell)],
    ) -> CanonicalPatient {
        CanonicalPatient {
            patient_id: id.to_string(),
            pfs_days: pfs.map(|(t, _)| t),
            pfs_event: pfs.map(|(_, e)| e),
            os_days: os.map(|(t, _)| t),
            os_event: os.map(|(_, e)| e),
            responder,
            response_day,
            covariates: covars
                .iter()
                .map(|(n, c)| (n.to_string(), c.clone()))
                .collect(),
        }
    }

    fn value(pid: &str, day: f64, marker: &str, value: f64) -> CanonicalValue {
        CanonicalValue {
            patient_id: pid.to_string(),
            day,
            feature: marker.to_string(),
            value: Some(value),
            unit: None,
        }
    }

    /// The fixture: 23 training patients (S0000..S0022), 2 main markers
    /// M1/M2 + companion rows. Every trainable patient carries the standard
    /// draws (day 0 M1+M2, day 14 M1, day 28 M2 = 3 distinct samples);
    /// S0009 has 2 samples (two markers on one draw day), S0010 companion
    /// rows only; S0001 has no on-treatment draw, S0002 no baseline draw.
    /// Outcomes: S0004 progressed by the landmark, S0005/S0006/S0007 respond
    /// cases with response_day 84/84/28, S0011/S0012 the horizon-label
    /// boundaries, S0013 the history-window boundary. Everything is a
    /// synthetic in-test construct — TEST-EE-22 asserts the spelling.
    fn fixture() -> CanonicalBundle {
        let mut patients: Vec<CanonicalPatient> = Vec::new();
        let mut values: Vec<CanonicalValue> = Vec::new();

        for id in ["S0000", "S0003", "S0004", "S0005", "S0006", "S0007", "S0008", "S0011", "S0012", "S0013"] {
            patients.push(patient(id, None, None, None, None, &[]));
        }
        // The standard draws + the outcome facts, set per id.
        for id in ["S0000", "S0003", "S0004", "S0005", "S0006", "S0007", "S0008", "S0011", "S0012", "S0013"] {
            values.push(value(id, 0.0, "M1", 10.0));
            values.push(value(id, 0.0, "M2", 100.0));
            values.push(value(id, 14.0, "M1", 12.0));
            values.push(value(id, 28.0, "M2", 101.0));
        }
        // Custom outcome facts.
        for (id, pfs, os, rsp, rd) in [
            ("S0000", Some((100.0, 1)), Some((300.0, 0)), None, None),
            ("S0003", Some((200.0, 0)), Some((400.0, 1)), None, None),
            ("S0004", Some((30.0, 1)), Some((200.0, 0)), None, None),
            ("S0005", Some((300.0, 0)), Some((500.0, 0)), Some(0), Some(84.0)),
            ("S0006", Some((300.0, 0)), Some((500.0, 0)), Some(1), Some(84.0)),
            ("S0007", Some((300.0, 0)), Some((500.0, 0)), Some(1), Some(28.0)),
            ("S0008", Some((150.0, 0)), Some((400.0, 0)), None, None),
            ("S0011", Some((238.0, 0)), Some((200.0, 1)), None, None),
            ("S0012", Some((300.0, 1)), Some((500.0, 0)), None, None),
            ("S0013", Some((100.0, 1)), Some((150.0, 1)), None, None),
        ] {
            let ix = patients.iter().position(|p| p.patient_id == id).unwrap();
            patients[ix] = patient(id, pfs, os, rsp, rd, &[]);
        }
        // The responders S0014..S0022 (9 of them): no_response reaches
        // MIN_TRAINING_PATIENTS with S0005/S0006.
        for (i, id) in [
            "S0014", "S0015", "S0016", "S0017", "S0018", "S0019", "S0020", "S0021", "S0022",
        ]
        .iter()
        .enumerate()
        {
            patients.push(patient(
                id,
                Some((300.0, 0)),
                Some((500.0, 0)),
                Some((i % 2) as i64),
                Some(84.0),
                &[],
            ));
            values.push(value(id, 0.0, "M1", 10.0));
            values.push(value(id, 0.0, "M2", 100.0));
            values.push(value(id, 14.0, "M1", 12.0));
            values.push(value(id, 28.0, "M2", 101.0));
        }
        // S0001/S0002: baseline-only / on-treatment-only draw sets.
        for id in ["S0001", "S0002"] {
            patients.push(patient(
                id,
                Some((150.0, 0)),
                Some((400.0, 0)),
                None,
                None,
                &[],
            ));
        }
        values.push(value("S0001", 0.0, "M1", 10.0)); // no on-treatment draw
        values.push(value("S0002", 14.0, "M1", 12.0)); // no baseline draw
        // S0009: two samples only (two markers share the day-14 draw).
        patients.push(patient(
            "S0009",
            Some((150.0, 0)),
            Some((400.0, 0)),
            None,
            None,
            &[],
        ));
        values.push(value("S0009", 0.0, "M1", 10.0));
        values.push(value("S0009", 14.0, "M1", 12.0));
        values.push(value("S0009", 14.0, "M2", 100.0));
        // S0010: companion rows only (never evidence).
        patients.push(patient(
            "S0010",
            Some((150.0, 0)),
            Some((400.0, 0)),
            None,
            None,
            &[],
        ));
        values.push(value("S0010", 0.0, "M1__detected", 1.0));
        values.push(value("S0010", 14.0, "M1__detected", 1.0));
        values.push(value("S0010", 0.0, "M1__lod", 0.1));
        // S0013's history boundary: a draw before and one after its pfs time.
        values.push(value("S0013", 98.0, "M1", 11.0));
        values.push(value("S0013", 120.0, "M1", 13.0));
        // Companion rows ride along on one trainable patient (data, not
        // evidence).
        values.push(value("S0000", 0.0, "M1__detected", 1.0));
        values.push(value("S0000", 14.0, "M1__detected", 1.0));

        CanonicalBundle {
            patients,
            values,
            features: vec![
                CanonicalFeature {
                    feature: "M1".to_string(),
                    unit: None,
                    marker_id: None,
                    is_detection_companion: false,
                },
                CanonicalFeature {
                    feature: "M2".to_string(),
                    unit: None,
                    marker_id: None,
                    is_detection_companion: false,
                },
                CanonicalFeature {
                    feature: "M1__detected".to_string(),
                    unit: None,
                    marker_id: None,
                    is_detection_companion: true,
                },
                CanonicalFeature {
                    feature: "M1__lod".to_string(),
                    unit: None,
                    marker_id: None,
                    is_detection_companion: true,
                },
            ],
        }
    }

    fn settings() -> BundleSettings {
        BundleSettings {
            decision_day: 56.0,
            look_ahead_day: 238.0,
            baseline_max_day: 0.0,
            covariates: false,
            label_day: None,
            seed: 1,
            threads: 4,
        }
    }

    fn file_of<'a>(files: &'a [BundleFile], name: &str) -> &'a str {
        files
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("bundle file {} must exist", name))
            .csv
            .as_str()
    }

    fn split_lines(csv: &str) -> Vec<&str> {
        csv.trim_end().lines().collect()
    }

    // ── TEST-EE-07 — the cohort/landmark rules ─────────────────────────────

    #[test]
    fn ee07_cohort_baseline_on_treatment_and_min_draws() {
        let b = fixture();
        let t = train_bundle(&b, &settings(), 2).expect("bundle builds at min_draws 2");
        for id in ["S0001", "S0002", "S0010"] {
            assert!(
                !t.patient_ids.contains(&id.to_string()),
                "{id} must be OUT of the cohort (no baseline / no on-treatment draw / companion rows only)"
            );
        }
        for id in ["S0000", "S0003", "S0004", "S0009", "S0013"] {
            assert!(
                t.patient_ids.contains(&id.to_string()),
                "{id} must be IN the cohort at min_draws 2"
            );
        }
        // S0009 has 2 distinct samples (a two-marker draw day is ONE sample):
        // at min_draws 3 it leaves the cohort, the patients with 3 samples stay.
        let t3 = train_bundle(&b, &settings(), 3).expect("bundle builds at min_draws 3");
        assert!(
            !t3.patient_ids.contains(&"S0009".to_string()),
            "S0009 (2 distinct draw days) must be OUT at min_draws 3"
        );
        assert!(
            t3.patient_ids.contains(&"S0000".to_string())
                && t3.patient_ids.contains(&"S0014".to_string()),
            "patients with 3 distinct draw days stay IN at min_draws 3"
        );
        // An unbuildable train set is a typed refusal, never an empty run.
        let sparse = CanonicalBundle {
            patients: vec![patient(
                "S0099",
                Some((100.0, 1)),
                Some((300.0, 0)),
                None,
                None,
                &[],
            )],
            values: vec![value("S0099", 0.0, "M1", 1.0)],
            features: vec![],
        };
        assert_eq!(
            train_bundle(&sparse, &settings(), 2),
            Err(BundleError::NoTrainingPatient { min_draws: 2 }),
            "baseline-only draws: no on-treatment draw -> no training patient"
        );
    }

    #[test]
    fn ee07_negative_days_are_baseline_and_no_post_landmark_draws() {
        let mut neg = fixture();
        // S0003's draws become pre-treatment: day -7 + day 28.
        neg.values.retain(|v| v.patient_id != "S0003");
        neg.values.push(value("S0003", -7.0, "M1", 9.0));
        neg.values.push(value("S0003", -7.0, "M2", 95.0));
        neg.values.push(value("S0003", 28.0, "M1", 12.0));
        let t = train_bundle(&neg, &settings(), 2).expect("bundle builds");
        assert!(
            t.patient_ids.contains(&"S0003".to_string()),
            "a pre-treatment negative day counts as the baseline draw"
        );
        let long = file_of(&t.files, "long.csv");
        for line in split_lines(long).into_iter().skip(1) {
            let day: f64 = line.split(',').nth(1).unwrap().parse().unwrap();
            assert!(
                day <= 56.0,
                "long.csv must hold no draw after the landmark: {line}"
            );
        }
        // The baseline column marks day <= 0.
        let row: Vec<&str> = split_lines(long)
            .iter()
            .find(|l| l.starts_with("S0003,-7,"))
            .unwrap()
            .split(',')
            .collect();
        assert_eq!(row[4], "1", "a negative pre-treatment draw is baseline");
        let row: Vec<&str> = split_lines(long)
            .iter()
            .find(|l| l.starts_with("S0000,28,"))
            .unwrap()
            .split(',')
            .collect();
        assert_eq!(row[4], "0", "an on-treatment draw is not baseline");
    }

    #[test]
    fn ee07_long_full_stops_at_the_earliest_outcome_time() {
        let b = fixture();
        let t = train_bundle(&b, &settings(), 2).expect("bundle builds");
        let full = file_of(&t.files, "long_full.csv");
        let mut saw_98 = false;
        let long = file_of(&t.files, "long.csv");
        for line in split_lines(full).into_iter().skip(1) {
            if line.starts_with("S0013,98,") {
                saw_98 = true;
            }
            assert!(
                !line.starts_with("S0013,120,"),
                "a draw after the patient's own outcome time (pfs 100) is not in long_full: {line}"
            );
        }
        assert!(saw_98, "a draw before the outcome time stays in long_full");
        for line in split_lines(long).into_iter().skip(1) {
            assert!(
                !line.starts_with("S0013,98,") && !line.starts_with("S0013,120,"),
                "post-landmark draws never touch long.csv: {line}"
            );
        }
    }

    #[test]
    fn ee07_endpoint_columns_and_event_guard() {
        let b = fixture();
        let t = train_bundle(&b, &settings(), 2).expect("bundle builds");
        let outc = file_of(&t.files, "outcomes.csv");
        let rows: Vec<Vec<&str>> = split_lines(outc)
            .into_iter()
            .skip(1)
            .map(|l| l.split(',').collect())
            .collect();
        let row = |id: &str| rows.iter().find(|r| r[0] == id).unwrap().clone();

        // S0004 progressed by the landmark: no pfs label, no response label.
        let r4 = row("S0004");
        assert_eq!(r4[1], "", "S0004 pfs_time is empty (event by the landmark)");
        assert_eq!(r4[2], "", "S0004 pfs_event is empty");
        assert_eq!(r4[3], "200", "S0004 keeps its open os time");
        assert_eq!(r4[5], "", "S0004 no_response is empty (progressed by L)");
        assert_eq!(r4[7], "", "S0004 progression_H238 is empty");
        assert_eq!(r4[8], "", "S0004 death_H238 is empty (censored before h)");

        // The response label-day guard.
        let r5 = row("S0005");
        assert_eq!(r5[5], "1", "responder 0 -> no_response 1");
        let r6 = row("S0006");
        assert_eq!(r6[5], "0", "responder 1 -> no_response 0");
        let r7 = row("S0007");
        assert_eq!(r7[5], "", "assessed at day 28 (<= L): no response label");

        // The horizon labels.
        let r11 = row("S0011");
        assert_eq!(r11[7], "", "censored exactly at the horizon: no label");
        assert_eq!(r11[8], "1", "event by the horizon: 1");
        let r12 = row("S0012");
        assert_eq!(r12[7], "0", "event-free beyond the horizon: 0");
        let r0 = row("S0000");
        assert_eq!(r0[7], "1", "pfs event 100 <= 238: 1");
    }

    #[test]
    fn ee07_label_day_override_moves_the_guard() {
        let b = fixture();
        // S0007's response_day is 28 (<= L): with the override 84 the run
        // asserts the response was assessed after the landmark.
        let mut s = settings();
        s.label_day = Some(84.0);
        let t = train_bundle(&b, &settings(), 2).expect("bundle builds");
        let outc = file_of(&t.files, "outcomes.csv");
        let r7 = split_lines(outc)
            .into_iter()
            .find(|l| l.starts_with("S0007,"))
            .unwrap()
            .split(',')
            .collect::<Vec<_>>();
        assert_eq!(r7[5], "", "no override: assessed before the landmark -> no label");

        let t84 = train_bundle(&b, &s, 2).expect("bundle builds with the override");
        let outc = file_of(&t84.files, "outcomes.csv");
        let r7 = split_lines(outc)
            .into_iter()
            .find(|l| l.starts_with("S0007,"))
            .unwrap()
            .split(',')
            .collect::<Vec<_>>();
        assert_eq!(r7[5], "0", "label_day 84 -> the response is learned");
    }

    // ── TEST-EE-08 — the written bundle matches contract 2.0 ────────────────

    #[test]
    fn ee08_file_set_and_columns_match_the_contract() {
        let b = fixture();
        let t = train_bundle(&b, &settings(), 2).expect("bundle builds");
        let names: Vec<&str> = t.files.iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["long.csv", "long_full.csv", "outcomes.csv"]);

        let long = file_of(&t.files, "long.csv");
        assert_eq!(
            split_lines(long)[0],
            "patient_id,day,marker,value,baseline",
            "long.csv columns are the contract's fixed set"
        );
        let outc = file_of(&t.files, "outcomes.csv");
        assert_eq!(
            split_lines(outc)[0],
            "patient_id,pfs_time,pfs_event,os_time,os_event,no_response,progressive_disease,progression_H238,death_H238",
            "outcomes.csv is the contract's fixed column set with one horizon column"
        );
        // Rows are sorted by patient id, ids pass through untouched.
        let ids: Vec<&str> = split_lines(outc)
            .into_iter()
            .skip(1)
            .map(|l| l.split(',').next().unwrap())
            .collect();
        let mut sorted = ids.clone();
        sorted.sort();
        assert_eq!(ids, sorted, "outcomes.csv rows are patient-id sorted");
        assert!(ids.iter().all(|i| i.starts_with('S')), "char ids pass through");
    }

    #[test]
    fn ee08_params_json_emits_the_contract_fields() {
        let b = fixture();
        let t = train_bundle(&b, &settings(), 2).expect("bundle builds");
        assert_eq!(
            t.params,
            serde_json::json!({
                "landmark_day": 56.0,
                "horizons": [238.0],
                "outcomes": ["progression", "death", "no_response"],
                "markers": ["M1", "M2"],
                "baseline_max_day": 0.0,
                "covariates": false,
                "method_params": {},
                "seed": 1,
                "threads": 4,
            }),
            "params.json carries exactly the contract 2.0 field set"
        );
        // The outcome counts are the data facts (progression 19, death 20,
        // no_response 11, progressive_disease never derivable).
        assert_eq!(t.n_outcome["progression"], 19);
        assert_eq!(t.n_outcome["death"], 20);
        assert_eq!(t.n_outcome["no_response"], 11);
        assert_eq!(t.n_outcome["progressive_disease"], 0);
        assert!(t.n_outcome["progressive_disease"] < MIN_TRAINING_PATIENTS);
    }

    #[test]
    fn ee08_outcome_minimum_is_a_warning_not_a_silent_drop() {
        // Keep only 3 responder patients: no_response has 3 eligible -> not
        // learned, warned; the run answers the contract's rules.
        let mut b = fixture();
        b.patients.retain(|p| {
            ![
                "S0014", "S0015", "S0016", "S0017", "S0018", "S0019", "S0020", "S0021", "S0022",
            ]
            .contains(&p.patient_id.as_str())
        });
        b.values.retain(|v| {
            ![
                "S0014", "S0015", "S0016", "S0017", "S0018", "S0019", "S0020", "S0021", "S0022",
            ]
            .contains(&v.patient_id.as_str())
        });
        let t = train_bundle(&b, &settings(), 2).expect("bundle builds");
        assert_eq!(t.outcomes, vec!["progression", "death"]);
        assert!(t.warnings.iter().any(|w| w.contains("no_response")), "{:?}", t.warnings);
        // And a bundle with no learnable outcome refUSES.
        let mut few = fixture();
        few.patients = few
            .patients
            .into_iter()
            .filter(|p| {
                ["S0005", "S0006", "S0007"]
                    .contains(&p.patient_id.as_str())
            })
            .collect();
        few.values = few
            .values
            .into_iter()
            .filter(|v| {
                ["S0005", "S0006", "S0007"].contains(&v.patient_id.as_str())
            })
            .collect();
        assert_eq!(
            train_bundle(&few, &settings(), 2),
            Err(BundleError::NoLearnableOutcome { min: MIN_TRAINING_PATIENTS })
        );
    }

    #[test]
    fn ee08_covariates_csv_when_enabled_with_name_alignment() {
        let mut b = fixture();
        let mut s = settings();
        s.covariates = true;
        b.patients.iter_mut().for_each(|p| {
            if p.patient_id == "S0000" || p.patient_id == "S0014" {
                p.covariates = vec![
                    ("cov_age".to_string(), CanonCell::Number(62.0)),
                    ("cov_sex".to_string(), CanonCell::Text("F".to_string())),
                ];
            }
            if p.patient_id == "S0015" {
                // The text column carries its own string; the numeric column
                // is missing on this patient (an empty cell, never a guess).
                p.covariates = vec![("cov_sex".to_string(), CanonCell::Text("M".to_string()))];
            }
        });
        let t = train_bundle(&b, &s, 2).expect("bundle builds with covariates");
        let names: Vec<&str> = t.files.iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["long.csv", "long_full.csv", "outcomes.csv", "covariates.csv"]);
        let covs = file_of(&t.files, "covariates.csv");
        assert_eq!(
            split_lines(covs)[0],
            "patient_id,cov_age,cov_sex",
            "the covariate columns are name-keyed in first-appearance order"
        );
        let row = |id: &str| {
            split_lines(covs)
                .into_iter()
                .find(|l| l.starts_with(id))
                .unwrap()
                .split(',')
                .collect::<Vec<_>>()
        };
        assert_eq!(row("S0000"), vec!["S0000", "62", "F"]);
        assert_eq!(row("S0015"), vec!["S0015", "", "M"], "a missing covariate is an empty cell");
        assert_eq!(t.params["covariates"], serde_json::json!(true));

        // covariates = true without any covariate column refuses.
        let mut nocol = fixture();
        nocol.patients.iter_mut().for_each(|p| p.covariates.clear());
        assert_eq!(
            train_bundle(&nocol, &s, 2),
            Err(BundleError::CovariatesWithoutColumns)
        );
    }

    #[test]
    fn ee08_test_bundle_rows_reasons_and_patients_csv() {
        // A predict side: 6 patients. N0000/N0002/N0004 score; N0001 no
        // baseline; N0003 no draw at all; N0005 too few draws at min_draws 3.
        let mut predict = CanonicalBundle {
            patients: vec![],
            values: vec![],
            features: vec![],
        };
        for id in ["N0000", "N0001", "N0002", "N0003", "N0004", "N0005"] {
            predict.patients.push(patient(id, None, None, None, None, &[]));
        }
        predict.values.push(value("N0000", 0.0, "M1", 5.0));
        predict.values.push(value("N0000", 14.0, "M1", 6.0));
        predict.values.push(value("N0000", 28.0, "M2", 7.0));
        predict.values.push(value("N0001", 0.0, "M1", 5.0)); // baseline only
        predict.values.push(value("N0002", 14.0, "M1", 6.0)); // no baseline
        predict.values.push(value("N0004", 0.0, "M1", 5.0));
        predict.values.push(value("N0004", 14.0, "M1", 6.0));
        predict.values.push(value("N0004", 28.0, "M2", 7.0));
        predict.values.push(value("N0005", 0.0, "M1", 5.0));
        predict.values.push(value("N0005", 14.0, "M1", 6.0));
        predict.values.push(value("N0004", 70.0, "M1", 8.0)); // after the landmark

        let tb = test_bundle(Some(&predict.patients), &predict, &settings(), 3).expect("test bundle");
        assert_eq!(tb.scored, vec!["N0000", "N0004"]);
        assert_eq!(
            tb.skipped,
            vec![
                ("N0001".to_string(), "no draw during treatment by day 56".to_string()),
                ("N0002".to_string(), "no baseline draw (day <= 0)".to_string()),
                ("N0005".to_string(), "fewer than 3 draws by day 56".to_string()),
                ("N0003".to_string(), "no draw by day 56".to_string()),
            ],
            "skip reasons follow the ids' first-appearance order (N0003 has no measurement row)"
        );
        let patients_csv = file_of(&tb.files, "patients.csv");
        assert_eq!(
            split_lines(patients_csv),
            vec!["patient_id", "N0000", "N0004"],
            "patients.csv is exactly the scored rows, sorted"
        );
        let long = file_of(&tb.files, "long.csv");
        assert!(
            !split_lines(long).iter().any(|l| l.starts_with("N0004,70")),
            "the post-landmark draw never reaches the test bundle"
        );
        // With covariates on and NO covariate column in the predict table the
        // package's write condition keeps covariates.csv absent (the caller
        // cross-checks the model's trained names).
        let mut s = settings();
        s.covariates = true;
        let tbc = test_bundle(Some(&predict.patients), &predict, &s, 3).expect("test bundle");
        let names: Vec<&str> = tbc.files.iter().map(|f| f.name).collect();
        assert_eq!(names, vec!["long.csv", "patients.csv"]);
        // And without any predict patients the bundle refuses before writing.
        assert_eq!(
            test_bundle(None, &predict, &s, 3),
            Err(BundleError::TestCovariatesNeedPatients)
        );
    }

    #[test]
    fn ee08_test_bundle_covariates_and_missing_table() {
        let mut predict = CanonicalBundle {
            patients: vec![],
            values: vec![],
            features: vec![],
        };
        let mut s = settings();
        s.covariates = true;
        let err = test_bundle(None, &predict, &s, 2);
        assert_eq!(err, Err(BundleError::TestCovariatesNeedPatients));

        for id in ["N0000", "N0001"] {
            predict.patients.push(patient(id, None, None, None, None, &[("cov_age", CanonCell::Number(50.0))]));
        }
        predict.values.push(value("N0000", 0.0, "M1", 5.0));
        predict.values.push(value("N0000", 14.0, "M1", 6.0));
        predict.values.push(value("N0000", 28.0, "M2", 7.0));
        predict.values.push(value("N0001", 0.0, "M1", 5.0)); // baseline only -> skipped
        let tb = test_bundle(Some(&predict.patients), &predict, &s, 2).expect("test bundle");
        let covs = file_of(&tb.files, "covariates.csv");
        assert_eq!(split_lines(covs)[0], "patient_id,cov_age");
        assert_eq!(split_lines(covs)[1], "N0000,50");
        assert!(!split_lines(covs).iter().any(|l| l.starts_with("N0001")), "skipped patients carry no covariate row");
    }

    #[test]
    fn ee08_settings_carry_the_run_config_into_the_bundle() {
        use crate::modules::execution_engine::types::{RunConfig, TxrEndpoint};
        let mut config = RunConfig::default();
        config.decision_day = 28.0;
        config.look_ahead_day = 210.0;
        config.covariates = true;
        config.label_day = Some(84.0);
        let s = BundleSettings::for_run(&config, 3);
        assert_eq!(
            s,
            BundleSettings {
                decision_day: 28.0,
                look_ahead_day: 210.0,
                baseline_max_day: 0.0,
                covariates: true,
                label_day: Some(84.0),
                seed: 1,
                threads: 3,
            }
        );
        // The endpoint does not shape the bundle (the contract learns every
        // outcome the tables support; endpoint picks the displayed column).
        let mut os = RunConfig::default();
        os.endpoint = TxrEndpoint::Os;
        assert_eq!(
            BundleSettings::for_run(&os, 4).decision_day,
            BundleSettings::for_run(&RunConfig::default(), 4).decision_day
        );
    }

    // ── TEST-EE-22 — fixture hygiene: synthetic only ────────────────────────

    #[test]
    fn ee22_fixtures_are_synthetic_in_test_constructs() {
        let b = fixture();
        let synthetic_patient = |id: &str| {
            id.len() == 5
                && id.starts_with('S')
                && id[1..].chars().all(|c| c.is_ascii_digit())
        };
        for p in &b.patients {
            assert!(synthetic_patient(&p.patient_id), "{} is a synthetic id", p.patient_id);
        }
        for v in &b.values {
            assert!(synthetic_patient(&v.patient_id), "{} is a synthetic id", v.patient_id);
        }
        let markers: Vec<&str> = b
            .values
            .iter()
            .map(|v| v.feature.as_str())
            .collect();
        assert!(
            markers.iter().all(|m| ["M1", "M2", "M1__detected", "M1__lod"].contains(m)),
            "every marker is the synthetic fixture's own: {markers:?}"
        );
        // The fixture declares its provenance (this test IS that declaration —
        // an assertion on its own sources, per TEST-EE-22).
        let res = train_bundle(&b, &settings(), 2).unwrap();
        assert!(res.patient_ids.iter().all(|id| id.starts_with('S')));
        // No fixture field can be sourced from the data folders: the bundle is
        // built by this module's constructors only.
        let json = serde_json::to_string(&b).unwrap();
        for forbidden in ["/data/", "restricted", "datasets", "results"] {
            assert!(
                !json.contains(forbidden),
                "the fixture must not name a data path: {forbidden}"
            );
        }
    }

    // ── TEST-EE-10 — the per-method marker set (contract 2.0's count rule;      ──
    //    the plan's D5 ranking is superseded by DRIFT-2) and the fixed-list
    //    resolution; the fixtures are the same synthetic construct family
    //    (P0000.., markers LDH/CEA/CA199 + companions)

    fn declared(kind: MarkerKind, count: u32) -> MethodMarkers {
        MethodMarkers { kind, count }
    }

    fn required(entries: &[(&str, &str, &str)]) -> RequiredMarkers {
        RequiredMarkers {
            markers: entries
                .iter()
                .map(|(name, id_system, id)| RequiredMarker {
                    name: name.to_string(),
                    id_system: id_system.to_string(),
                    id: id.to_string(),
                })
                .collect(),
            match_mode: MatchMode::All,
            min_fraction: 1.0,
            list_source: "synthetic in-test construct".to_string(),
        }
    }

    fn feats(items: &[(&str, Option<&str>, bool)]) -> Vec<CanonicalFeature> {
        items
            .iter()
            .map(|(name, id, companion)| CanonicalFeature {
                feature: name.to_string(),
                unit: None,
                marker_id: id.map(|s| s.to_string()),
                is_detection_companion: *companion,
            })
            .collect()
    }

    /// The ITEM-4 fixture: 12 training patients (P0000..P0011), three main
    /// markers LDH/CEA/CA199 + companions, every patient event-free at the
    /// landmark (pfs 100, os 300) with 3 distinct draw days (the day-14 CEA
    /// draw is the only marker at that visit). Synthetic in-test construct.
    fn item4_fixture() -> CanonicalBundle {
        let mut patients = Vec::new();
        let mut values = Vec::new();
        for i in 0..12 {
            let id = format!("P{i:04}");
            patients.push(patient(
                &id,
                Some((100.0, 1)),
                Some((300.0, 0)),
                None,
                None,
                &[],
            ));
            values.push(value(&id, 0.0, "LDH", 100.0 + i as f64));
            values.push(value(&id, 0.0, "CEA", 10.0 + i as f64));
            values.push(value(&id, 0.0, "CA199", 2.0 + i as f64));
            values.push(value(&id, 14.0, "CEA", 12.0 + i as f64));
            values.push(value(&id, 28.0, "LDH", 110.0 + i as f64));
        }
        values.push(value("P0000", 0.0, "CEA__detected", 1.0));
        values.push(value("P0000", 14.0, "CEA__detected", 1.0));
        values.push(value("P0000", 0.0, "CEA__lod", 0.1));
        values.push(value("P0000", 0.0, "LDH__detected", 1.0));
        CanonicalBundle {
            patients,
            values,
            features: feats(&[
                ("LDH", Some("14804-9"), false),
                ("CEA", Some("2039-6"), false),
                ("CA199", None, false),
                ("CEA__detected", None, true),
                ("CEA__lod", None, true),
                ("LDH__detected", None, true),
            ]),
        }
    }

    /// The predict side of the ITEM-4 fixture: P0000-style rows on new ids.
    /// N0000 has 3 method-scoped samples, N0001 only the day-0 CEA (the
    /// day-14 CA199 draw is outside the method's set), N0002 has 2 LDH days.
    fn item4_predict_fixture(include_ldh: bool) -> CanonicalBundle {
        let mut values = Vec::new();
        values.push(value("N0000", 0.0, "CEA", 5.0));
        if include_ldh {
            values.push(value("N0000", 0.0, "LDH", 200.0));
        }
        values.push(value("N0000", 14.0, "CEA", 6.0));
        if include_ldh {
            values.push(value("N0000", 28.0, "LDH", 201.0));
        }
        values.push(value("N0001", 0.0, "CEA", 5.0));
        values.push(value("N0001", 14.0, "CA199", 3.0));
        if include_ldh {
            values.push(value("N0002", 0.0, "LDH", 200.0));
            values.push(value("N0002", 14.0, "LDH", 205.0));
        }
        CanonicalBundle {
            patients: vec![],
            values,
            features: feats(&[("LDH", None, false), ("CEA", None, false), ("CA199", None, false)]),
        }
    }

    #[test]
    fn ee10_any_marker_kind_takes_every_main_marker_and_its_companions() {
        let b = item4_fixture();
        let sel =
            method_marker_set(&b, &declared(MarkerKind::Any, 0), None).expect("any: no count rule");
        assert_eq!(sel.mains, vec!["CA199", "CEA", "LDH"]);
        assert_eq!(
            sel.companions,
            vec!["CEA__detected", "CEA__lod", "LDH__detected"]
        );
        let t = train_bundle_with_markers(&b, &settings(), 2, &sel).expect("bundle builds");
        assert_eq!(
            t.params["markers"],
            serde_json::json!(["CA199", "CEA", "LDH"]),
            "params.markers is the full set, never the companions"
        );
        let long = file_of(&t.files, "long.csv");
        assert!(split_lines(long).iter().any(|l| l.starts_with("P0000,0,CEA__lod,")));
        assert!(split_lines(long).iter().any(|l| l.starts_with("P0000,0,LDH__detected,")));
    }

    #[test]
    fn ee10_single_resolves_the_fixed_list_and_scopes_the_bundle() {
        let b = item4_fixture();
        let req = Some(required(&[("LDH", "LOINC", "14804-9")]));
        let sel = method_marker_set(&b, &declared(MarkerKind::Single, 1), req.as_ref())
            .expect("the file carries the required marker");
        assert_eq!(sel.mains, vec!["LDH"]);
        assert_eq!(sel.companions, vec!["LDH__detected"]);
        let t = train_bundle_with_markers(&b, &settings(), 2, &sel).expect("bundle builds");
        assert_eq!(t.params["markers"], serde_json::json!(["LDH"]));
        let long = file_of(&t.files, "long.csv");
        assert!(
            split_lines(long)
                .iter()
                .skip(1)
                .all(|l| l.contains(",LDH,") || l.contains("LDH__detected")),
            "only the selected marker + its companion reach long.csv: {}",
            split_lines(long).join(" | ")
        );
        // The draw status is scoped to the marker set: day 14 (CEA only) does
        // not count, so the 3-distinct-day patients have TWO LDH samples here
        // and drop out at min_draws 3 — the package's own counting.
        assert_eq!(
            train_bundle_with_markers(&b, &settings(), 3, &sel),
            Err(BundleError::NoTrainingPatient { min_draws: 3 })
        );
    }

    #[test]
    fn ee10_required_marker_matching_is_id_or_other_system_name() {
        let b = item4_fixture();
        // Structured id equality (case-insensitive).
        let sel = method_marker_set(
            &b,
            &declared(MarkerKind::Single, 1),
            Some(&required(&[("LDH (U/L)", "LOINC", "14804-9")])),
        )
        .expect("mapped id matches");
        assert_eq!(sel.mains, vec!["LDH"]);
        // The `other`-system name fallback.
        let sel = method_marker_set(
            &b,
            &declared(MarkerKind::Single, 1),
            Some(&required(&[("CEA", "other", "serum cea")])),
        )
        .expect("name fallback matches");
        assert_eq!(sel.mains, vec!["CEA"]);
        // A structured id the file does not carry resolves to an empty set.
        assert_eq!(
            method_marker_set(
                &b,
                &declared(MarkerKind::Single, 1),
                Some(&required(&[("LDH", "LOINC", "9999-9")])),
            ),
            Err(BundleError::MarkerCountUnmet {
                expected: 1,
                names: vec![]
            })
        );
        // An `other` entry neither the feature name nor any id spells.
        assert_eq!(
            method_marker_set(
                &b,
                &declared(MarkerKind::Single, 1),
                Some(&required(&[("something else", "other", "something else")])),
            ),
            Err(BundleError::MarkerCountUnmet {
                expected: 1,
                names: vec![]
            })
        );
    }

    #[test]
    fn ee10_single_without_a_fixed_list_is_exactly_one_file_marker() {
        let b = item4_fixture();
        assert_eq!(
            method_marker_set(&b, &declared(MarkerKind::Single, 1), None),
            Err(BundleError::MarkerCountUnmet {
                expected: 1,
                names: vec!["CA199".to_string(), "CEA".to_string(), "LDH".to_string()]
            })
        );
        // A one-marker file satisfies the rule.
        let mut one = item4_fixture();
        one.values.retain(|v| v.feature == "LDH" || v.feature == "LDH__detected");
        one.features.retain(|f| f.feature == "LDH" || f.feature == "LDH__detected");
        let sel = method_marker_set(&one, &declared(MarkerKind::Single, 1), None).expect("one marker");
        assert_eq!(sel.mains, vec!["LDH"]);
    }

    #[test]
    fn ee10_multi_count_is_the_file_set_and_panel_is_the_fixed_list() {
        let b = item4_fixture();
        // multi 2 on a 3-marker file: refused (the package's count message).
        assert_eq!(
            method_marker_set(&b, &declared(MarkerKind::Multi, 2), None),
            Err(BundleError::MarkerCountUnmet {
                expected: 2,
                names: vec!["CA199".to_string(), "CEA".to_string(), "LDH".to_string()]
            })
        );
        // multi 2 on a 2-marker file: exactly the file's markers.
        let mut two = item4_fixture();
        two.values.retain(|v| v.feature == "LDH" || v.feature == "CEA" || v.feature == "LDH__detected");
        two.features.retain(|f| f.feature == "LDH" || f.feature == "CEA" || f.feature == "LDH__detected");
        let sel = method_marker_set(&two, &declared(MarkerKind::Multi, 2), None).expect("two markers");
        assert_eq!(sel.mains, vec!["CEA", "LDH"]);
        // panel 2 = the fixed list; the file's extra marker is not passed.
        let sel = method_marker_set(
            &b,
            &declared(MarkerKind::Panel, 2),
            Some(&required(&[("LDH", "LOINC", "14804-9"), ("CEA", "LOINC", "2039-6")])),
        )
        .expect("panel list resolves");
        assert_eq!(sel.mains, vec!["CEA", "LDH"]);
        let t = train_bundle_with_markers(&b, &settings(), 2, &sel).expect("bundle builds");
        assert_eq!(t.params["markers"], serde_json::json!(["CEA", "LDH"]));
        let long = file_of(&t.files, "long.csv");
        assert!(
            !split_lines(long).iter().any(|l| l.contains(",CA199,")),
            "the file's unlisted marker is never passed"
        );
        // The catalogue's under-declared fixed list (count 3, one named
        // marker) is a refusal, never a guessed set.
        assert_eq!(
            method_marker_set(
                &b,
                &declared(MarkerKind::Panel, 3),
                Some(&required(&[("LDH", "LOINC", "14804-9")])),
            ),
            Err(BundleError::MarkerCountUnmet {
                expected: 3,
                names: vec!["LDH".to_string()]
            })
        );
    }

    #[test]
    fn ee10_companions_follow_their_base_only() {
        let b = item4_fixture();
        let sel = method_marker_set(
            &b,
            &declared(MarkerKind::Single, 1),
            Some(&required(&[("CEA", "LOINC", "2039-6")])),
        )
        .expect("CEA resolves");
        assert_eq!(sel.companions, vec!["CEA__detected", "CEA__lod"]);
        let t = train_bundle_with_markers(&b, &settings(), 2, &sel).expect("bundle builds");
        let long = file_of(&t.files, "long.csv");
        assert!(split_lines(long).iter().any(|l| l.starts_with("P0000,0,CEA__lod,")));
        assert!(
            !split_lines(long)
                .iter()
                .any(|l| l.contains("LDH__detected") || l.contains(",LDH,")),
            "an unselected base's companion never rides along"
        );
    }

    #[test]
    fn ee10_no_main_marker_is_a_typed_refusal() {
        let mut only_companions = item4_fixture();
        only_companions
            .values
            .retain(|v| v.feature.contains("__"));
        // A marker-agnostic method needs at least one main marker (the
        // package's "needs at least one marker").
        assert_eq!(
            method_marker_set(&only_companions, &declared(MarkerKind::Any, 0), None),
            Err(BundleError::NoMainMarker)
        );
    }

    #[test]
    fn ee10_count_refusal_carries_the_package_message() {
        let b = item4_fixture();
        let err = method_marker_set(&b, &declared(MarkerKind::Single, 1), None)
            .expect_err("three markers for a single-marker method");
        let msg = err.to_string();
        assert!(msg.starts_with("BUNDLE_MARKER_COUNT_UNMET: "), "{msg}");
        assert!(
            msg.contains("takes exactly one marker, but 3 were passed (CA199, CEA, LDH)"),
            "{msg}"
        );
    }

    #[test]
    fn ee10_test_bundle_uses_the_same_marker_set_and_draw_rule() {
        let b = item4_fixture();
        let sel = method_marker_set(
            &b,
            &declared(MarkerKind::Panel, 2),
            Some(&required(&[("LDH", "LOINC", "14804-9"), ("CEA", "LOINC", "2039-6")])),
        )
        .expect("panel");
        let predict = item4_predict_fixture(true);
        let tb =
            test_bundle_with_markers(None, &predict, &settings(), 2, &sel).expect("test bundle");
        assert_eq!(tb.scored, vec!["N0000", "N0002"]);
        assert_eq!(
            tb.skipped,
            vec![(
                "N0001".to_string(),
                "no draw during treatment by day 56".to_string()
            )],
            "N0001's day-14 CA199 draw is outside the method's set and does not count"
        );
        assert_eq!(tb.marker_names, sel.mains);
        let long = file_of(&tb.files, "long.csv");
        assert!(
            !split_lines(long).iter().any(|l| l.contains(",CA199,")),
            "the predict file's extra marker never reaches the method"
        );
        // A selected marker with no predict-side row refuses (the contract's
        // predict-marker check), rather than running a model on a table that
        // lacks a trained marker.
        let missing = item4_predict_fixture(false);
        assert_eq!(
            test_bundle_with_markers(None, &missing, &settings(), 2, &sel),
            Err(BundleError::TestMarkerMissing {
                marker: "LDH".to_string()
            })
        );
    }

    #[test]
    fn ee10_selection_is_deterministic_and_the_legacy_wrappers_keep_all_markers() {
        let b = item4_fixture();
        let sel = method_marker_set(
            &b,
            &declared(MarkerKind::Panel, 2),
            Some(&required(&[("CEA", "LOINC", "2039-6"), ("LDH", "LOINC", "14804-9")])),
        )
        .expect("panel");
        let again = method_marker_set(
            &b,
            &declared(MarkerKind::Panel, 2),
            Some(&required(&[("CEA", "LOINC", "2039-6"), ("LDH", "LOINC", "14804-9")])),
        )
        .expect("panel");
        assert_eq!(sel, again, "the selection is order-insensitive");
        // The ITEM-3 entry points are preserved as the all-markers path.
        assert_eq!(
            train_bundle(&b, &settings(), 2),
            train_bundle_with_markers(&b, &settings(), 2, &MarkerSelection::all(&b))
        );
    }

    // ── TEST-EE-11 — the task-compatibility check (the provider's codes
    //    pass through verbatim) ─────────────────────────────────────────────

    fn outcomes(
        has_responder: bool,
        has_response_day: bool,
        has_event: bool,
        has_survival_day: bool,
    ) -> FileOutcomes {
        FileOutcomes {
            has_responder,
            has_response_day,
            has_event,
            has_survival_day,
        }
    }

    #[test]
    fn ee11_task_compatibility_mirrors_the_eligibility_truth_table() {
        let response = vec!["response".to_string()];
        let survival = vec!["survival".to_string()];
        let none: Vec<String> = Vec::new();
        // A response method on a file without the response label columns.
        assert_eq!(
            task_compatibility(&response, &outcomes(false, false, true, true)),
            Some(ReasonCode::ResponseLabelMissing)
        );
        // Both columns are needed (a responder without the assessment day).
        assert_eq!(
            task_compatibility(&response, &outcomes(true, false, false, false)),
            Some(ReasonCode::ResponseLabelMissing)
        );
        // A survival method on a file without event / survival-day columns.
        assert_eq!(
            task_compatibility(&survival, &outcomes(true, true, false, false)),
            Some(ReasonCode::SurvivalOutcomeMissing)
        );
        // The specific missing-column code wins over the mismatch (the
        // eligibility engine's priority): a response method on a
        // survival-only file names the missing label, not the mismatch.
        let surv_only = outcomes(false, false, true, true);
        assert_eq!(
            task_compatibility(&response, &surv_only),
            Some(ReasonCode::ResponseLabelMissing)
        );
        let resp_only = outcomes(true, true, false, false);
        assert_eq!(
            task_compatibility(&survival, &resp_only),
            Some(ReasonCode::SurvivalOutcomeMissing)
        );
        // Tasks that name no outcome kind the file has are the mismatch — the
        // provider's own odd-task case (and its task-less real-data verdict:
        // a method with no declared task covers no file outcome).
        let odd = vec!["none".to_string()];
        assert_eq!(
            task_compatibility(&odd, &resp_only),
            Some(ReasonCode::TaskIncompatible)
        );
        // Compatible: the file carries the method's task (both, or the one).
        assert_eq!(task_compatibility(&response, &outcomes(true, true, true, true)), None);
        assert_eq!(task_compatibility(&survival, &outcomes(true, true, true, true)), None);
        assert_eq!(task_compatibility(&response, &resp_only), None);
        // No declared task: the same verdict the eligibility engine gives on
        // an outcome-carrying file (one truth table, one vocabulary).
        assert_eq!(
            task_compatibility(&none, &surv_only),
            Some(ReasonCode::TaskIncompatible)
        );
        assert_eq!(
            task_compatibility(&none, &outcomes(true, true, true, true)),
            Some(ReasonCode::TaskIncompatible)
        );
    }

    #[test]
    fn ee11_task_reasons_are_the_provider_codes_verbatim() {
        // The method row's reason.code is the provider's own vocabulary —
        // never a re-spelled engine copy.
        assert_eq!(ReasonCode::TaskIncompatible.as_str(), "TASK_INCOMPATIBLE");
        assert_eq!(ReasonCode::ResponseLabelMissing.as_str(), "RESPONSE_LABEL_MISSING");
        assert_eq!(
            ReasonCode::SurvivalOutcomeMissing.as_str(),
            "SURVIVAL_OUTCOME_MISSING"
        );
    }
}
