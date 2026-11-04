//! The contract bundle — `bundle.rs` (PLAN ITEM-3, re-pinned by DRIFT-2 to
//! package contract 2.0): the canonical rows → the files a method receives
//! under `/input/` (`train/long.csv`, `train/long_full.csv`,
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
//!   single look-ahead], outcomes, markers (every main marker, sorted,
//!   without the companions), baseline_max_day, covariates (bool),
//!   method_params {}, seed 1, threads`. No `task`/`endpoint`/`features`/
//!   `marker_ranking` — those were contract v1.2 shapes (DRIFT-2).
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
use crate::modules::file_validator::types::{CanonCell, CanonicalBundle, CanonicalPatient, CanonicalValue};
use crate::modules::method_catalogue::eligibility::is_companion;

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

/// Build the `train/` bundle of one method (the port of `build_train` +
/// `train_files` + `make_params`).
pub fn train_bundle(
    bundle: &CanonicalBundle,
    settings: &BundleSettings,
    min_draws: u32,
) -> Result<TrainBundle, BundleError> {
    if settings.covariates && bundle.patients.iter().all(|p| p.covariates.is_empty()) {
        return Err(BundleError::CovariatesWithoutColumns);
    }
    let horizons = [settings.look_ahead_day];
    let status = draw_status(bundle, settings);

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

    let markers = main_markers(bundle);
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

/// Build the `test/` bundle of one method (the port of `build_test` +
/// `write_test`): the predict-side row set, its per-patient skip reasons and
/// the files the method predicts from.
pub fn test_bundle(
    predict_patients: Option<&[CanonicalPatient]>,
    bundle: &CanonicalBundle,
    settings: &BundleSettings,
    min_draws: u32,
) -> Result<TestBundle, BundleError> {
    let status = draw_status(bundle, settings);

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
            marker_names: main_markers(bundle),
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
        marker_names: main_markers(bundle),
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
}
