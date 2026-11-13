//! The method output — `predictions.rs` (PLAN ITEM-5 + ITEM-6, re-pinned by
//! DRIFT-2 to package contract 2.0): parse + validate `/output/predictions.csv`
//! and `/output/run.json`, resolve the per-method "chance" column, the
//! per-patient abstention notes and the coverage (ITEM-5), and run the U2
//! recalibration engine (ITEM-6): the risk→probability conversion the package
//! fits on the training scores of a method that declares no native
//! probability.
//!
//! The rules are a port of the package's `core/src/method.cpp`
//! (`validate_method_output`, `own_risk`, `own_probability`, `declares`,
//! `risk_col`) with the `package/contract/2.0/predictions.schema.json`
//! `method_output` shapes as the fixed column set — a method's output is
//! either valid or a typed [`PredictionError`] (`PREDICTION_INVALID`, the
//! engine's contract-failure code); nothing is repaired (the schema's
//! x-rules: "nothing is repaired: a failure stops the call").
//!
//! ### What is pinned here
//!
//! - **Rows are exactly the test patients** (`patients.csv` rows — the
//!   [`crate::modules::execution_engine::bundle::TestBundle`]'s `scored`
//!   set): none missing, none extra, none duplicated.
//! - **Every number is finite or empty; a probability is within [0, 1]**;
//!   `call` must be 0/1 when present. `risk` empty only with a `note`, and
//!   not for every patient; the same risk for every patient is refused
//!   unless the method declares `constant_ok` (methods with fewer than 5
//!   scored patients are exempt — the package's own floor).
//! - **Declared columns are present**: `risk_<outcome>` / `p_<outcome>_H<h>`
//!   / `p_<outcome>` / `call` per the method's `own_outputs` (the
//!   wildcard `p_progression_H*` form) — and a scored patient's declared
//!   probability cell is never empty.
//! - **Chance column** (the plan's `p_event_H-<h>`/`p_fail` are v1.2 names):
//!   survival → `p_<outcome>_H<h>` (the run's horizon), response →
//!   `p_<outcome>` (`p_no_response`; `progressive_disease` is never
//!   learnable from the app's files, ITEM-3 note (n)); the native-
//!   probability detection is the package's `own_probability` over
//!   `own_outputs`, and ITEM-6 recalibrates the risk when there is none.
//! - **Coverage + notes**: one [`PredictionRow`] per predict-side patient
//!   (the scored rows, then the test side's skips); a skip carries the
//!   bundle's reason as its note; `probability` is the method's native
//!   column value where declared (None when the method has no native column
//!   — the ITEM-6 conversion fills those) or the abstention; the notes are
//!   the per-patient `note` / skip reason.
//! - **`run.json` is permissive** (the package's `read_run_json`): missing
//!   or unparseable is an empty object, never a failure — the file is the
//!   method's own report, carried through.
//! - **The recalibration band (ITEM-6)** is a faithful port of the package's
//!   `conversion.cpp`: one [`Conversion`] per (outcome, horizon) — a weighted
//!   logistic regression of the event on the STANDARDISED score
//!   (`p = expit(a + b·(risk−mu)/sd)`, `b ≥ 0` so a higher score never gives a
//!   lower probability; the weighted event rate when the scores do not vary,
//!   do not rise with the event, or when they separate the labels). The
//!   survival horizons use inverse-probability-of-censoring weights (`1/G`,
//!   G = the Kaplan–Meier estimate of the censoring distribution, floored at
//!   [`G_FLOOR`]); a method that learns from outcomes (`fitted: true`) gets
//!   an inner 3-fold cross-fit so its training scores are out-of-fold —
//!   [`crossfit_folds`] is the seeded fold construction of the package's Rng
//!   (the tests pin its output against the package's own golden file).
//!   The conversion is fitted on the TRAINING patients only and applied
//!   unchanged to the test patients ([`fit_recalibration`] +
//!   [`converted_rows`]); a method that declares a native probability is
//!   never converted (INV-3 — the [`CalibrationError::NativeProbability`]
//!   refusal) and a conversion with no usable (risk, label) pair is
//!   [`CalibrationError::NoUsableTrainingData`] → `RECALIBRATION_FAILED`,
//!   never an all-empty column.
//! - **The saved conversions** (the package's `model.conversions`, kept with
//!   the model by `save()` and applied by `predict()`): a train run fits one
//!   map per need its training scores cover (the shown one makes its
//!   column) and records them as `output/<method_id>/conversions.json`
//!   ([`write_conversions`]
//!   / [`read_conversions`], the [`Conversions`] map keyed by
//!   [`conversion_key`]); the model store keeps it with a saved model, and a
//!   predict-only reuse applies the map for its (outcome, horizon)
//!   ([`saved_conversion_rows`] — `prob_source: converted`), or reports no
//!   chances with a note naming why. Every map from outside the engine
//!   passes [`check_conversions`] (the package schema's key + value rules).
//!
//! Pure functions: text in, typed facts out — no I/O (ITEM-9 reads the
//! files); the CSV bytes are read with the module's own codec
//! ([`parse_csv`], the package's `table.cpp` port — no `csv` crate).

use std::collections::{BTreeMap, BTreeSet};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::modules::execution_engine::bundle::{parse_csv, parse_number, CsvTable};
use crate::modules::execution_engine::types::{EngineReasonCode, TxrCoverage, TxrTask};
use crate::modules::method_catalogue::types::{Method, MethodGroup};

/// The package's `read_predictions` join cap: the first 8 problems are
/// reported, the rest counted ("… and N more").
pub const MAX_PROBLEMS_REPORTED: usize = 8;

/// The recorded outcome of the response task the app can learn (ITEM-3 note
/// (n): the app's file schema has no `best_response`, so `no_response` is
/// the only derivable response label; `progressive_disease` is never
/// learned).
pub const RESPONSE_OUTCOME: &str = "no_response";

// ─────────────────────────────────────────────────────────────────────────────
// The method's declared-output facts (the package's `MethodSpec` subset)
// ─────────────────────────────────────────────────────────────────────────────

/// The declared-output facts of one method, as the validation needs them — a
/// projection of the catalogue `Method` ([`PredictionSpec::new`]) with one
/// deliberate gap made explicit: the package's `constant_ok` field is NOT
/// carried by the app's catalogue facts yet, so the catalogue path fixes it
/// to `None` (the strict rule); tests and a later catalogue growth set it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PredictionSpec<'a> {
    /// The method id (the error lines' "method 'x' …" prefix).
    pub method_id: &'a str,
    /// The declared output columns (`method.json` `own_outputs`; the package
    /// vocabulary incl. the `p_progression_H*` wildcard).
    pub own_outputs: &'a [String],
    /// The method's group (`response-call` declares `call`).
    pub group: MethodGroup,
    /// Why the same risk for all patients can be legitimate (the package's
    /// `constant_ok`); `None` = not declared → the strict rule.
    pub constant_ok: Option<&'a str>,
}

impl<'a> PredictionSpec<'a> {
    /// From the catalogue facts. `constant_ok` is `None` — see the struct
    /// doc (a catalogue data gap, recorded in DRIFT-1 ITEM-5).
    pub fn new(method: &'a Method) -> Self {
        Self {
            method_id: &method.id,
            own_outputs: &method.own_outputs,
            group: method.group,
            constant_ok: None,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Column names + native-column detection (the package's method.hpp helpers)
// ─────────────────────────────────────────────────────────────────────────────

/// The package's `is_survival_outcome`: `progression`/`death` carry a
/// horizon, the response outcomes do not.
pub fn is_survival(outcome: &str) -> bool {
    outcome == "progression" || outcome == "death"
}

/// The package's `horizon_name`: a whole horizon is "238", a fractional one
/// is the shortest round-trip text ("238.5") — the `H<h>` column suffix.
pub fn horizon_name(h: f64) -> String {
    if h == h.floor() && h.abs() < 1e15 {
        format!("{}", h as i64)
    } else {
        number_text(h)
    }
}

/// The package's `declares`: an exact `own_outputs` entry, or a trailing-`*`
/// prefix pattern (`p_progression_H*` declares every `p_progression_H<h>`).
pub fn declares(own_outputs: &[String], column: &str) -> bool {
    own_outputs
        .iter()
        .any(|o| o == column || (o.ends_with('*') && column.starts_with(&o[..o.len() - 1])))
}

/// The package's `own_risk`: does the method write its own per-outcome risk
/// (`risk_<outcome>`), so the plain `risk` column is not the score for the
/// outcome?
pub fn own_risk(own_outputs: &[String], outcome: &str) -> bool {
    declares(own_outputs, &format!("risk_{outcome}"))
}

/// The package's `own_probability(outcome, horizon)`: does the method write
/// its own probability for the outcome (per horizon for the survival
/// outcomes)?
pub fn own_probability(own_outputs: &[String], outcome: &str, horizon: Option<f64>) -> bool {
    if is_survival(outcome) {
        declares(
            own_outputs,
            &format!(
                "p_{outcome}_H{}",
                horizon_name(horizon.expect("survival outcome needs a horizon"))
            ),
        )
    } else {
        declares(own_outputs, &format!("p_{outcome}"))
    }
}

/// The "chance" column of one (outcome, horizon): `p_<outcome>_H<h>` for the
/// survival outcomes, `p_<outcome>` for the response outcomes — contract 2.0
/// (the plan's v1.2 `p_event_H-<h>`/`p_fail` names are superseded).
pub fn chance_column(outcome: &str, horizon: Option<f64>) -> String {
    match horizon {
        Some(h) => format!("p_{outcome}_H{}", horizon_name(h)),
        None => format!("p_{outcome}"),
    }
}

/// The outcome the response task displays (the app learns `no_response`
/// only — [`RESPONSE_OUTCOME`]).
pub fn task_outcome(task: TxrTask) -> &'static str {
    match task {
        TxrTask::Pfs => "progression",
        TxrTask::Os => "death",
        TxrTask::Response => RESPONSE_OUTCOME,
    }
}

/// The per-outcome risk column (the package's `risk_col`): the method's own
/// `risk_<outcome>` when it declares one, else the shared `risk`.
pub fn risk_column(own_outputs: &[String], outcome: &str) -> String {
    if own_risk(own_outputs, outcome) {
        format!("risk_{outcome}")
    } else {
        "risk".to_string()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The failure typing
// ─────────────────────────────────────────────────────────────────────────────

/// A method-output refusal (the plan's `PREDICTION_INVALID` + a named
/// reason kept on the method row — INV-2's "failure kept with its reason";
/// every variant is the one engine code, the details differ).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PredictionError {
    /// The method exited without writing `/output/predictions.csv` (the
    /// package's `read_predictions` throw).
    MissingPredictionsFile { method_id: String },
    /// The file exists but cannot be parsed (the package's `parse_csv`
    /// throws: a row wider/narrower than the header, unclosed quotes).
    MalformedCsv { method_id: String, detail: String },
    /// Contract violations (the package's `validate_method_output`
    /// problem list — the first [`MAX_PROBLEMS_REPORTED`] are named).
    Invalid {
        method_id: String,
        problems: Vec<String>,
    },
}

impl PredictionError {
    /// The engine's reason code for every variant (the wire `reason.code`).
    pub fn engine_code(&self) -> EngineReasonCode {
        EngineReasonCode::PredictionInvalid
    }

    /// The human line kept on the method row — the package's throw text.
    pub fn detail(&self) -> String {
        match self {
            PredictionError::MissingPredictionsFile { method_id } => {
                format!("method '{method_id}' exited without writing /output/predictions.csv")
            }
            PredictionError::MalformedCsv { method_id, detail } => {
                format!("method '{method_id}' wrote an unreadable predictions.csv: {detail}")
            }
            PredictionError::Invalid {
                method_id,
                problems,
            } => {
                let mut s = format!("method '{method_id}' wrote an invalid predictions.csv:");
                for p in problems.iter().take(MAX_PROBLEMS_REPORTED) {
                    s.push_str("\n  - ");
                    s.push_str(p);
                }
                if problems.len() > MAX_PROBLEMS_REPORTED {
                    s.push_str(&format!(
                        "\n  ... and {} more",
                        problems.len() - MAX_PROBLEMS_REPORTED
                    ));
                }
                s
            }
        }
    }
}

impl std::fmt::Display for PredictionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail())
    }
}

impl std::error::Error for PredictionError {}

// ─────────────────────────────────────────────────────────────────────────────
// validation — a port of method.cpp::validate_method_output
// ─────────────────────────────────────────────────────────────────────────────

/// The first five ids, then "… (N in all)" (the package's `show`).
fn show_ids(ids: &[&str]) -> String {
    let mut s = String::new();
    for (i, id) in ids.iter().take(5).enumerate() {
        if i > 0 {
            s.push_str(", ");
        }
        s.push_str(id);
    }
    if ids.len() > 5 {
        s.push_str(&format!(", ... ({} in all)", ids.len()));
    }
    s
}

/// Validate a parsed `predictions.csv` against the contract (the package's
/// `validate_method_output` verbatim): the column pair `patient_id`/`risk`
/// must exist; the rows are exactly the `expected` (test-side) patients; a
/// number is finite or empty and a probability is in [0, 1] (`call` is
/// 0/1); every declared own column is present; `risk` is empty only with a
/// note, not empty for every patient, and not constant for every patient
/// (≥ 5 scored, without `constant_ok`); a scored patient's declared
/// probability cell is never empty. Each problem is named (ids, columns,
/// rows); an empty list = valid. Nothing is repaired.
pub fn validate_output(
    spec: &PredictionSpec<'_>,
    table: &CsvTable,
    expected: &[String],
    outcomes: &[String],
    horizons: &[f64],
) -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    if !table.has("patient_id") || !table.has("risk") {
        problems.push("predictions.csv must have the columns patient_id and risk".to_string());
        return problems;
    }
    let ids = table.col("patient_id").expect("checked above");
    let n = table.nrow();

    // rows are exactly the test patients
    let mut count: BTreeMap<&str, usize> = BTreeMap::new();
    for id in ids {
        *count.entry(id.as_str()).or_insert(0) += 1;
    }
    let want: BTreeSet<&str> = expected.iter().map(|s| s.as_str()).collect();
    let dup: Vec<&str> = count
        .iter()
        .filter(|(_, c)| **c > 1)
        .map(|(k, _)| *k)
        .collect();
    let extra: Vec<&str> = count
        .iter()
        .filter(|(k, _)| !want.contains(*k))
        .map(|(k, _)| *k)
        .collect();
    let missing: Vec<&str> = want
        .iter()
        .filter(|w| !count.contains_key(**w))
        .map(|w| *w)
        .collect();
    if !missing.is_empty() {
        problems.push(format!(
            "patient missing from predictions.csv: {}",
            show_ids(&missing)
        ));
    }
    if !extra.is_empty() {
        problems.push(format!(
            "patient in predictions.csv that was not asked for: {}",
            show_ids(&extra)
        ));
    }
    if !dup.is_empty() {
        problems.push(format!(
            "patient appears more than once in predictions.csv: {}",
            show_ids(&dup)
        ));
    }

    // numeric columns: finite or empty; probabilities in [0, 1]; call is 0/1
    for j in 0..table.names().len() {
        let name = &table.names()[j];
        if name == "patient_id" || name == "note" {
            continue;
        }
        let Some(col) = table.col(name) else {
            continue;
        };
        for (i, cell) in col.iter().enumerate() {
            if cell.is_empty() {
                continue;
            }
            let Some(x) = parse_number(cell) else {
                problems.push(format!(
                    "column {name} row {} (patient {}): '{cell}' is not a finite number",
                    i + 1,
                    ids[i]
                ));
                break;
            };
            if !x.is_finite() {
                problems.push(format!(
                    "column {name} row {} (patient {}): '{cell}' is not a finite number",
                    i + 1,
                    ids[i]
                ));
                break;
            }
            let prob = name.starts_with("p_");
            if (prob && (x < 0.0 || x > 1.0)) || (name == "call" && x != 0.0 && x != 1.0) {
                problems.push(format!(
                    "column {name} row {} (patient {}): {cell} is outside the allowed range",
                    i + 1,
                    ids[i]
                ));
                break;
            }
        }
    }

    // declared own columns present
    let mut need: Vec<String> = Vec::new();
    for o in outcomes {
        if own_risk(spec.own_outputs, o) {
            need.push(format!("risk_{o}"));
        }
        if is_survival(o) {
            for h in horizons {
                if own_probability(spec.own_outputs, o, Some(*h)) {
                    need.push(chance_column(o, Some(*h)));
                }
            }
        } else if own_probability(spec.own_outputs, o, None) {
            need.push(chance_column(o, None));
        }
    }
    if spec.group == MethodGroup::ResponseCall || declares(spec.own_outputs, "call") {
        need.push("call".to_string());
    }
    for c in &need {
        if !table.has(c) {
            problems.push(format!("declared column {c} is absent"));
        }
    }

    // risk empty only with a note; not empty for every patient; not constant
    let risk = table.col("risk").expect("checked above");
    let has_note = table.has("note");
    let note_col = has_note.then(|| table.col("note").expect("checked above"));
    let mut scored = 0usize;
    let mut rv: Vec<f64> = Vec::new();
    for i in 0..n {
        if risk[i].is_empty() {
            if !has_note || note_col.expect("checked above")[i].is_empty() {
                problems.push(format!(
                    "risk is empty for patient {} without a note",
                    ids[i]
                ));
                break;
            }
        } else {
            scored += 1;
            // Missing-word cells are NA (the package's parse_number) — NaN
            // never equals, so a NA cell cannot make a constant look equal.
            rv.push(parse_number(&risk[i]).unwrap_or(f64::NAN));
        }
    }
    if n > 0 && scored == 0 {
        problems.push("risk is empty for every patient".to_string());
    }
    let constant_ok = spec.constant_ok.map(|s| !s.is_empty()).unwrap_or(false);
    if scored >= 5 && !constant_ok {
        let mut same = true;
        for x in &rv {
            if *x != rv[0] {
                same = false;
                break;
            }
        }
        if same {
            problems.push(format!(
                "every patient has the same risk ({}); the method does not declare constant_ok",
                number_text(rv[0])
            ));
        }
    }

    // own probability columns: a scored patient needs a value
    for c in &need {
        if !c.starts_with("p_") {
            continue;
        }
        let Some(col) = table.col(c) else {
            continue;
        };
        for i in 0..n {
            if !risk[i].is_empty() && col[i].is_empty() {
                problems.push(format!(
                    "column {c} is empty for patient {}, who has a risk",
                    ids[i]
                ));
                break;
            }
        }
    }
    problems
}

// ─────────────────────────────────────────────────────────────────────────────
// run.json — a port of engine.cpp::read_run_json
// ─────────────────────────────────────────────────────────────────────────────

/// The method's `/output/run.json` as a JSON value — the package's permissive
/// read: a missing or unparseable file is an empty object (the file is the
/// method's own report; the engine never fails a run on it).
pub fn read_run_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| Value::Object(serde_json::Map::new()))
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-patient assembly
// ─────────────────────────────────────────────────────────────────────────────

/// One predict-side patient's row facts: the outcome-scoped risk, the native
/// chance-column probability (when the method declares one) and the note
/// (the row's own note, or the test side's skip reason — an abstention is a
/// note + no probability, never a number that looks scored).
#[derive(Debug, Clone, PartialEq)]
pub struct PredictionRow {
    pub patient_id: String,
    /// The risk for the displayed outcome (`risk_<outcome>` when declared —
    /// [`risk_column`] — else the plain `risk`); None = abstained (the row
    /// carries a note).
    pub risk: Option<f64>,
    /// The method's own probability of the displayed (outcome, horizon) when
    /// it declares one; None when the patient abstained OR the method has no
    /// native column (ITEM-6 recalibrates the risk into the probability).
    pub probability: Option<f64>,
    /// The per-patient note: the row's own `note` cell when the risk is
    /// empty, the test-side skip reason for a patient the method never saw,
    /// else empty.
    pub note: String,
}

/// The validated + assembled method output for one displayed (outcome,
/// horizon) — ITEM-5's deliverable; ITEM-6 consumes the rows' risks (or the
/// training side's [`outcome_risks`]) to fill the missing probabilities.
#[derive(Debug, Clone, PartialEq)]
pub struct MethodPredictions {
    /// The parsed `predictions.csv` (string cells, header order).
    pub table: CsvTable,
    /// `/output/run.json` (permissive — [`read_run_json`]).
    pub report: Value,
    /// All predict-side patients: the scored rows (`expected`, the
    /// `patients.csv` order) then the skips (the test bundle's reason order).
    pub rows: Vec<PredictionRow>,
    /// The outcomes the declared-columns check ran against (the model's
    /// `params.outcomes` — the trained outcomes; the package's `m.outcomes`).
    pub outcomes: Vec<String>,
    pub horizons: Vec<f64>,
    /// The displayed outcome this assembly resolved (the run's endpoint's
    /// primary outcome, or the method's task outcome — `task_outcome`).
    pub outcome: String,
    /// The displayed horizon (None = a response outcome).
    pub horizon: Option<f64>,
    /// The native chance column name when the method declares one for the
    /// displayed (outcome, horizon) — `prob_source: "native"`; None = ITEM-6
    /// converts ("recalibrated").
    pub native_column: Option<String>,
}

impl MethodPredictions {
    /// The coverage of the resolved probability column (the board's "120 of
    /// 151 have them"): `scored` = patients with a probability, `eligible` =
    /// every predict-side patient, `fraction` = the ratio (0 when none).
    /// A method without a native column starts at `scored: 0` — the ITEM-6
    /// conversion refills the rows and the orchestrator recomputes at
    /// finalize.
    pub fn coverage(&self) -> TxrCoverage {
        coverage(&self.rows)
    }
}

/// The coverage of a row set (a free function so ITEM-6's converted rows
/// feed the same math).
pub fn coverage(rows: &[PredictionRow]) -> TxrCoverage {
    let eligible = rows.len() as u32;
    let scored = rows.iter().filter(|r| r.probability.is_some()).count() as u32;
    TxrCoverage {
        scored,
        eligible,
        fraction: if eligible == 0 {
            0.0
        } else {
            scored as f64 / eligible as f64
        },
    }
}

/// The per-method normalized column artifact — `output/<method_id>/chance.csv`
/// (ITEM-10's read surface of PROV-EE-7): the assembled per-patient chance
/// column the heatmap + the CSV download serve, written by the executor at
/// the point the rows are final.
///
/// The container's raw `predictions.csv` stays the provenance (TEST-EE-18
/// pins it + `run.json`); THIS file is the engine's record of what it
/// validated and, where the method wrote no native probability, what it
/// recalibrated — the converted column cannot be re-derived from the raw
/// file (the conversion's training scores are per-call), so the records it
/// served are persisted instead of recomputed at read time. The shape is the
/// module's own: `patient_id,probability,note` — 6-decimal probability, empty
/// when abstained, the per-patient note (skip reason / explicit abstention)
/// escaped by the module's one codec ([`crate::modules::execution_engine::bundle::csv_cell`]).
pub fn write_chance_column(
    run_dir: &std::path::Path,
    method_id: &str,
    rows: &[PredictionRow],
) -> std::io::Result<()> {
    let out_dir = run_dir.join("output").join(method_id);
    std::fs::create_dir_all(&out_dir)?;
    let mut csv = String::from("patient_id,probability,note\n");
    for r in rows {
        csv.push_str(&crate::modules::execution_engine::bundle::csv_cell(&r.patient_id));
        csv.push(',');
        if let Some(p) = r.probability {
            csv.push_str(&format!("{p:.6}"));
        }
        csv.push(',');
        csv.push_str(&crate::modules::execution_engine::bundle::csv_cell(&r.note));
        csv.push('\n');
    }
    std::fs::write(out_dir.join("chance.csv"), csv)
}

/// The outcome-scoped risk values of every scored patient, in `expected`
/// order (the package's `take_scores` band over `risk_col`): the
/// per-outcome risks ITEM-6's conversion fitting reads off the training
/// side's call.
pub fn outcome_risks(
    spec: &PredictionSpec<'_>,
    table: &CsvTable,
    expected: &[String],
    outcome: &str,
) -> Vec<Option<f64>> {
    let column = risk_column(spec.own_outputs, outcome);
    let Some(ids) = table.col("patient_id") else {
        return expected.iter().map(|_| None).collect();
    };
    let Some(risk) = table.col(&column) else {
        // The column is declared missing only when the method owns it; a
        // plain-`risk` method always carries the column (validation).
        return expected.iter().map(|_| None).collect();
    };
    let mut by_id: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, id) in ids.iter().enumerate() {
        by_id.insert(id.as_str(), i);
    }
    expected
        .iter()
        .map(|id| {
            by_id
                .get(id.as_str())
                .and_then(|i| parse_number(&risk[*i]))
                .filter(|x| x.is_finite())
        })
        .collect()
}

/// The per-outcome native probability values of every scored patient
/// (`own_probability` detection + the column's cells; None where the row is
/// empty — an abstained patient or a method without that column). Returns
/// the chance-column name alongside, for the caller's `prob_source`.
pub fn outcome_probabilities(
    spec: &PredictionSpec<'_>,
    table: &CsvTable,
    expected: &[String],
    outcome: &str,
    horizon: Option<f64>,
) -> (Option<String>, Vec<Option<f64>>) {
    if !own_probability(spec.own_outputs, outcome, horizon) {
        return (None, vec![None; expected.len()]);
    }
    let column = chance_column(outcome, horizon);
    let ids = table.col("patient_id").expect("validated");
    let by_id: BTreeMap<&str, usize> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();
    let probs = match table.col(&column) {
        Some(col) => expected
            .iter()
            .map(|id| {
                by_id
                    .get(id.as_str())
                    .and_then(|i| parse_number(&col[*i]))
                    .filter(|x| x.is_finite())
            })
            .collect(),
        None => vec![None; expected.len()],
    };
    (Some(column), probs)
}

/// Parse + validate + assemble one method's output for one displayed
/// (outcome, horizon):
///
/// - `predictions_csv`: the file's text, None when the method wrote none
///   (a typed refusal — the package's "exited without writing"); `run_json`:
///   the report text (permissive).
/// - `expected`: the `patients.csv` rows (the [`TestBundle`]'s scored ids);
///   `skipped`: the predict-side patients the method never saw + reasons.
/// - `outcomes` / `horizons`: the trained outcome set + horizons the
///   declared-columns check runs against (the model's `params.outcomes`).
/// - `outcome` / `horizon`: the displayed column's identity.
///
/// The result rows are `expected` then `skipped`, each carrying the
/// outcome-scoped risk, the native probability (when declared) and the
/// note; a [`PredictionError`] is the failure typing
/// (`PREDICTION_INVALID` + the named problems).
pub fn method_predictions(
    predictions_csv: Option<&str>,
    run_json: &str,
    spec: &PredictionSpec<'_>,
    expected: &[String],
    skipped: &[(String, String)],
    outcomes: &[String],
    horizons: &[f64],
    outcome: &str,
    horizon: Option<f64>,
) -> Result<MethodPredictions, PredictionError> {
    let Some(csv) = predictions_csv else {
        return Err(PredictionError::MissingPredictionsFile {
            method_id: spec.method_id.to_string(),
        });
    };
    let table = parse_csv(csv).map_err(|e| PredictionError::MalformedCsv {
        method_id: spec.method_id.to_string(),
        detail: e.detail().to_string(),
    })?;
    let problems = validate_output(spec, &table, expected, outcomes, horizons);
    if !problems.is_empty() {
        return Err(PredictionError::Invalid {
            method_id: spec.method_id.to_string(),
            problems,
        });
    }

    let report = read_run_json(run_json);
    let native_column = own_probability(spec.own_outputs, outcome, horizon)
        .then(|| chance_column(outcome, horizon));
    let risks = outcome_risks(spec, &table, expected, outcome);

    let ids = table.col("patient_id").expect("validated");
    let note_cells = table.col("note");
    let risk_cells = table
        .col(&risk_column(spec.own_outputs, outcome))
        .expect("validated");
    let prob_cells = native_column.as_deref().and_then(|c| table.col(c));
    let row_of: BTreeMap<&str, usize> = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (id.as_str(), i))
        .collect();

    let mut rows: Vec<PredictionRow> = Vec::with_capacity(expected.len() + skipped.len());
    for (i, id) in expected.iter().enumerate() {
        let r = row_of
            .get(id.as_str())
            .copied()
            .expect("validated: every expected id present");
        let risk = parse_number(&risk_cells[r]).filter(|x| x.is_finite());
        let probability = prob_cells
            .and_then(|col| parse_number(&col[r]))
            .filter(|x| x.is_finite());
        let note = note_cells.map(|nc| nc[r].clone()).unwrap_or_default();
        debug_assert_eq!(risks[i], risk, "the row's risk is the outcome-scoped one");
        rows.push(PredictionRow {
            patient_id: id.clone(),
            risk,
            probability,
            note,
        });
    }
    for (id, reason) in skipped {
        rows.push(PredictionRow {
            patient_id: id.clone(),
            risk: None,
            probability: None,
            note: reason.clone(),
        });
    }

    Ok(MethodPredictions {
        table,
        report,
        rows,
        outcomes: outcomes.to_vec(),
        horizons: horizons.to_vec(),
        outcome: outcome.to_string(),
        horizon,
        native_column,
    })
}

/// The shortest decimal text of a number (the package's `format_number`:
/// Rust's shortest round-trip; `-0` is kept as the package prints it).
fn number_text(x: f64) -> String {
    format!("{x}")
}

// ─────────────────────────────────────────────────────────────────────────────
// ITEM-6 — the U2 recalibration engine (a port of the package's
// `core/src/conversion.cpp`: fit_conversion, censoring_km, ipcw_labels,
// conversion_key, and the 3-fold cross-fit of `engine.cpp::fit`)
// ─────────────────────────────────────────────────────────────────────────────

/// The Kaplan–Meier weight floor: a patient whose censoring estimate has
/// fallen below this is weighted no more than `1/G_FLOOR` (the package's
/// `G_FLOOR`).
pub const G_FLOOR: f64 = 0.05;

/// The inner cross-fit fold count of the `fitted: true` arm (the package's
/// `K = 3`).
pub const CROSS_FIT_FOLDS: usize = 3;

/// The fold count a caller's value maps to (0 is treated as 1 — the
/// [`crossfit_folds`] arithmetic never divides by zero).
fn fold_count(folds: usize) -> usize {
    folds.max(1)
}

/// The two kinds of a [`Conversion`] (the package's `kind` strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConversionKind {
    /// `p = expit(a + b·(risk−mu)/sd)` — the fitted probability curve.
    Logistic,
    /// The (weighted) event rate, when the scores do not vary, do not rise
    /// with the event, or separate it.
    Constant,
}

/// One risk→probability conversion — the model-side record the package's
/// `fit()` stores per (outcome, horizon) (`model.conversions`). The serde
/// shape is the package's JSON exactly (`{kind, a, b, mu, sd, n, rate}`); a
/// conversion is fitted on the TRAINING scores only and applied unchanged to
/// the test patients (DEC-8). A saved model carries its conversions (the
/// [`Conversions`] map) so a later reuse run applies the same map.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "TxrConversion")]
pub struct Conversion {
    /// `"logistic"` | `"constant"` (the package's `kind` vocabulary — a
    /// String, not an enum, so the record's wire bytes stay the package's).
    pub kind: String,
    /// The logistic intercept where the score is standardised
    /// (`z = (risk − mu)/sd`); 0 for the constant kind.
    pub a: f64,
    /// The logistic slope on the standardised score, constrained to ≥ 0 (a
    /// higher score never gives a lower probability); 0 for the constant kind.
    pub b: f64,
    /// The weighted mean of the training scores (the standardisation centre).
    pub mu: f64,
    /// The weighted standard deviation of the training scores; 1 for the
    /// constant kind (the scale is irrelevant there).
    pub sd: f64,
    /// The patients the conversion was learned on.
    pub n: i64,
    /// The weighted event rate — the constant map's value; `None` when no
    /// (risk, label) pair was usable (n = 0; the package's NA rate).
    #[serde(default)]
    pub rate: Option<f64>,
}

impl Conversion {
    /// The map kind.
    pub fn kind(&self) -> ConversionKind {
        match self.kind.as_str() {
            "logistic" => ConversionKind::Logistic,
            _ => ConversionKind::Constant,
        }
    }

    /// Convert one risk: `None` (no score) gives `None` — the package's
    /// "NA risk gives NA" — and a constant map with a rate gives that rate
    /// for every score. The probability is in (0, 1) for a logistic map (the
    /// inverse-logit image), the rate itself for a constant map.
    pub fn apply(&self, risk: Option<f64>) -> Option<f64> {
        let r = risk?;
        if !r.is_finite() {
            return None;
        }
        match self.kind() {
            ConversionKind::Constant => self.rate,
            ConversionKind::Logistic => Some(expit(self.a + self.b * (r - self.mu) / self.sd)),
        }
    }
}

/// The inverse logit (the package's `expit` — same expression, same
/// overflow behaviour: `exp(−x)` → `inf` gives 0, → `0` gives 1).
fn expit(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// Fit a conversion from the training scores: `risk` is the method's score of
/// each training patient, `label` the outcome (0/1), `weight` the IPCW weight
/// (1 for the response outcomes) — an exact port of the package's
/// `fit_conversion`. Rows with a missing/non-finite risk, a missing label or
/// a non-positive weight are dropped; the result is the weighted logistic
/// regression on the standardised score (Newton with step halving + a tiny
/// ridge on the slope), or the weighted event rate when the scores do not
/// vary, do not rise with the event, or separate it — the package's
/// constraints, byte-for-byte.
pub fn fit_conversion(risk: &[Option<f64>], label: &[Option<f64>], weight: &[f64]) -> Conversion {
    let mut r: Vec<f64> = Vec::new();
    let mut yy: Vec<f64> = Vec::new();
    let mut ww: Vec<f64> = Vec::new();
    for i in 0..risk.len() {
        let Some(ri) = risk[i] else { continue };
        if !ri.is_finite() {
            continue;
        }
        let Some(yi) = label[i] else { continue };
        if !yi.is_finite() {
            continue;
        }
        if weight.get(i).copied().unwrap_or(0.0) <= 0.0 {
            continue;
        }
        r.push(ri);
        yy.push(yi);
        ww.push(weight[i]);
    }
    let n = r.len();
    let mut c = Conversion {
        kind: "constant".to_string(),
        a: 0.0,
        b: 0.0,
        mu: 0.0,
        sd: 1.0,
        n: n as i64,
        rate: None,
    };
    if r.is_empty() {
        return c;
    }
    let sw: f64 = ww.iter().sum();
    let swy: f64 = ww.iter().zip(&yy).map(|(w, y)| w * y).sum();
    let mean: f64 = ww.iter().zip(&r).map(|(w, x)| w * x).sum::<f64>() / sw;
    let mut var = 0.0;
    for i in 0..r.len() {
        var += ww[i] * (r[i] - mean) * (r[i] - mean);
    }
    var /= sw;
    let rate = swy / sw;
    c.rate = Some(rate);
    c.mu = mean;
    c.sd = var.sqrt();
    if !(c.sd > 1e-12) || rate <= 0.0 || rate >= 1.0 {
        // The scores do not vary or the event rate is degenerate: a constant
        // map (the package leaves the scale unused at 1).
        c.sd = 1.0;
        return c;
    }

    // Weighted logistic regression on the standardised score: Newton steps
    // with step halving and a tiny ridge `lam` on the slope (the package's
    // loop verbatim; `b` is clamped to ±30 and the fit falls back to the
    // constant when the slope is not positive).
    let lam = 1e-6 * sw;
    let mut a = (rate / (1.0 - rate)).ln();
    let mut b = 0.0;
    let loglik = |a_: f64, b_: f64| {
        let mut ll = 0.0;
        for i in 0..r.len() {
            let eta = a_ + b_ * (r[i] - c.mu) / c.sd;
            ll += ww[i] * (yy[i] * eta - eta.exp().ln_1p());
        }
        ll - 0.5 * lam * b_ * b_
    };
    for _ in 0..100 {
        let mut g0 = 0.0;
        let mut g1 = -lam * b;
        let mut h00 = 0.0;
        let mut h01 = 0.0;
        let mut h11 = lam;
        for i in 0..r.len() {
            let z = (r[i] - c.mu) / c.sd;
            let p = expit(a + b * z);
            let v = ww[i] * p * (1.0 - p);
            g0 += ww[i] * (yy[i] - p);
            g1 += ww[i] * (yy[i] - p) * z;
            h00 += v;
            h01 += v * z;
            h11 += v * z * z;
        }
        let det = h00 * h11 - h01 * h01;
        if !(det.abs() > 1e-300) {
            break;
        }
        let da = (h11 * g0 - h01 * g1) / det;
        let db = (-h01 * g0 + h00 * g1) / det;
        let l0 = loglik(a, b);
        let mut step = 1.0;
        while step > 1e-8 && loglik(a + step * da, b + step * db) < l0 - 1e-12 {
            step /= 2.0;
        }
        a += step * da;
        b += step * db;
        if b.abs() > 30.0 {
            b = if b > 0.0 { 30.0 } else { -30.0 };
        }
        if step * da.abs().max(db.abs()) < 1e-10 {
            break;
        }
    }
    if !(b > 0.0) {
        // A score that falls with the event is turned into the event rate —
        // never into a falling probability.
        c.sd = 1.0;
        return c;
    }
    c.kind = "logistic".to_string();
    c.a = a;
    c.b = b;
    c
}

/// The package's `conversion_key`: the outcome, or `outcome@<horizon>` for the
/// survival outcomes (the model record's map key).
pub fn conversion_key(outcome: &str, horizon: Option<f64>) -> String {
    match horizon {
        Some(h) => format!("{outcome}@{}", horizon_name(h)),
        None => outcome.to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The saved conversions (the package's `model.conversions` map): recorded on
// the run, carried by a saved model, applied by a reuse run
// ─────────────────────────────────────────────────────────────────────────────

/// A model's risk→probability conversions, keyed by [`conversion_key`] — the
/// package's `model.conversions` (contract 2.0 `model.schema.json`
/// `conversions`: "key = outcome, or outcome@horizon for progression and
/// death"). Sorted keys, so a recorded map serialises byte-stably.
pub type Conversions = BTreeMap<String, Conversion>;

/// The run-dir record of a method's conversions:
/// `output/<method_id>/conversions.json` (beside `chance.csv`). A train run
/// records the map of every need its training scores cover (the package's
/// `fit()`; the shown outcome's map made the run's column); a reuse run
/// records the one map it applied (the cohort's refit, or the saved model's
/// map). The save flow copies a train run's file into the saved model.
pub const CONVERSIONS_FILE: &str = "conversions.json";

/// The outcomes a conversion key may name (the package's outcome vocabulary).
const CONVERSION_OUTCOMES: [&str; 4] = ["progression", "death", "no_response", "progressive_disease"];

/// One refused entry of a conversions map: the key and what is wrong.
#[derive(Debug, Clone, PartialEq)]
pub struct ConversionProblem {
    pub key: String,
    pub problem: String,
}

impl std::fmt::Display for ConversionProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "conversion {:?}: {}", self.key, self.problem)
    }
}

impl Conversion {
    /// The package's value rules (`model.schema.json`): kind `logistic` or
    /// `constant`; finite a, b, mu; a finite sd > 0; b ≥ 0 (a higher score
    /// never gives a lower probability); n ≥ 0; rate null or in [0, 1].
    pub fn check(&self) -> Result<(), String> {
        if self.kind != "logistic" && self.kind != "constant" {
            return Err(format!("kind {:?} is not logistic or constant", self.kind));
        }
        for (name, v) in [("a", self.a), ("b", self.b), ("mu", self.mu)] {
            if !v.is_finite() {
                return Err(format!("{name} is not a finite number"));
            }
        }
        if !(self.sd.is_finite() && self.sd > 0.0) {
            return Err("sd is not a finite number above 0".to_string());
        }
        if self.b < 0.0 {
            return Err("b is negative".to_string());
        }
        if self.n < 0 {
            return Err("n is negative".to_string());
        }
        if let Some(r) = self.rate {
            if !(r.is_finite() && (0.0..=1.0).contains(&r)) {
                return Err("rate is not within [0, 1]".to_string());
            }
        }
        Ok(())
    }

    /// A flat map: every scored patient gets the same probability (the
    /// training fit fell back to the event rate — the score did not rise
    /// with the outcome, did not vary, or the labels were one class).
    pub fn is_flat(&self) -> bool {
        self.kind() == ConversionKind::Constant
    }
}

/// The key rule: an outcome of the package's vocabulary; progression/death
/// carry `@<h>` with a finite h > 0 in [`conversion_key`]'s own spelling (a
/// key is looked up by exact text, so `progression@238.0` would never match
/// and is refused); the response outcomes carry no horizon.
pub fn check_conversion_key(key: &str) -> Result<(), String> {
    let (outcome, horizon) = match key.split_once('@') {
        Some((o, h)) => (o, Some(h)),
        None => (key, None),
    };
    if !CONVERSION_OUTCOMES.contains(&outcome) {
        return Err(format!("{outcome:?} is not an outcome"));
    }
    match (is_survival(outcome), horizon) {
        (true, None) => Err(format!("{outcome} needs a horizon (\"{outcome}@<day>\")")),
        (false, Some(_)) => Err(format!("{outcome} takes no horizon")),
        (false, None) => Ok(()),
        (true, Some(h)) => {
            let day: f64 = h
                .parse()
                .map_err(|_| format!("the horizon {h:?} is not a number"))?;
            if !(day.is_finite() && day > 0.0) {
                return Err(format!("the horizon {h:?} is not a day above 0"));
            }
            if conversion_key(outcome, Some(day)) != key {
                return Err(format!(
                    "the key is not spelled {:?}",
                    conversion_key(outcome, Some(day))
                ));
            }
            Ok(())
        }
    }
}

/// Every entry of a map from outside the engine (a run request's asset, a
/// `.txr` header, a recorded file) passes the key and value rules; the first
/// failing entry is named.
pub fn check_conversions(map: &Conversions) -> Result<(), ConversionProblem> {
    for (key, c) in map {
        check_conversion_key(key)
            .and_then(|()| c.check())
            .map_err(|problem| ConversionProblem {
                key: key.clone(),
                problem,
            })?;
    }
    Ok(())
}

/// The plain words of a key for a note: `progression@238` → "progression at
/// 238 days", `no_response` → "no response".
pub fn conversion_label(key: &str) -> String {
    match key.split_once('@') {
        Some((outcome, h)) => format!("{} at {h} days", outcome.replace('_', " ")),
        None => key.replace('_', " "),
    }
}

/// Record the conversion a method's chances were made with
/// (`output/<method_id>/conversions.json`, the package's map shape).
pub fn write_conversions(
    run_dir: &std::path::Path,
    method_id: &str,
    map: &Conversions,
) -> std::io::Result<()> {
    let out_dir = run_dir.join("output").join(method_id);
    std::fs::create_dir_all(&out_dir)?;
    let mut text = serde_json::to_string_pretty(map)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    text.push('\n');
    std::fs::write(out_dir.join(CONVERSIONS_FILE), text)
}

/// Read a run's recorded conversion for one method. No file is an empty map
/// (a native-probability method, or a run made before the file was
/// recorded); an unreadable or invalid file is an error naming it.
pub fn read_conversions(run_dir: &std::path::Path, method_id: &str) -> Result<Conversions, String> {
    let path = run_dir.join("output").join(method_id).join(CONVERSIONS_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Conversions::new()),
        Err(e) => return Err(format!("read {}: {e}", path.display())),
    };
    let map: Conversions =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    check_conversions(&map).map_err(|p| format!("{}: {p}", path.display()))?;
    Ok(map)
}

/// The predict-only reuse column: its source, its rows and the map that was
/// applied (None = no chances).
pub struct SavedConversionRows {
    pub prob_source: super::types::TxrProbSource,
    pub rows: Vec<PredictionRow>,
    /// The applied map (`(key, conversion)`), recorded beside `chance.csv`.
    pub applied: Option<(String, Conversion)>,
}

/// The predict-only reuse rule (the package's `predict()`): the saved
/// model's conversion for this run's (outcome, horizon) turns the risk into
/// the probability — `prob_source: converted`. Without a matching map (or
/// with a flat map that has no event rate) the column stays empty and every
/// scored patient's note says why (a model saved before conversions were
/// kept, or a map for another outcome/day); an abstained patient keeps its
/// own note.
pub fn saved_conversion_rows(
    conversions: &Conversions,
    outcome: &str,
    horizon: Option<f64>,
    rows: Vec<PredictionRow>,
) -> SavedConversionRows {
    let key = conversion_key(outcome, horizon);
    let usable = conversions
        .get(&key)
        .filter(|c| c.kind() == ConversionKind::Logistic || c.rate.is_some());
    if let Some(c) = usable {
        return SavedConversionRows {
            prob_source: super::types::TxrProbSource::Converted,
            rows: converted_rows(c, &rows),
            applied: Some((key, c.clone())),
        };
    }
    let reason = if conversions.contains_key(&key) {
        "no native probability, and this saved model's score-to-chance conversion has no event rate"
            .to_string()
    } else if conversions.is_empty() {
        "no native probability, and this saved model has no score-to-chance conversion (it was saved before the app kept one)"
            .to_string()
    } else {
        let have: Vec<String> = conversions.keys().map(|k| conversion_label(k)).collect();
        format!(
            "no native probability, and this saved model's score-to-chance conversion is for {}, not {}",
            have.join(", "),
            conversion_label(&key)
        )
    };
    let rows = rows
        .into_iter()
        .map(|mut r| {
            if r.probability.is_none() && r.risk.is_some() && r.note.is_empty() {
                r.note = reason.clone();
            }
            r
        })
        .collect();
    SavedConversionRows {
        prob_source: super::types::TxrProbSource::None,
        rows,
        applied: None,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The IPCW band (censoring KM + horizon labels)
// ─────────────────────────────────────────────────────────────────────────────

/// The Kaplan–Meier estimate of the CENSORING distribution (`G(t) = P(C > t)`;
/// events precede censorings at tied times — the package's `CensoringKM`).
#[derive(Debug, Clone, PartialEq)]
pub struct CensoringKm {
    /// The distinct follow-up times (strictly increasing).
    pub t: Vec<f64>,
    /// `G` after each distinct time.
    pub g: Vec<f64>,
}

impl CensoringKm {
    /// `G(x)`: right-continuous, 1 before the first time.
    pub fn at(&self, x: f64) -> f64 {
        let mut v = 1.0;
        for (t, g) in self.t.iter().zip(&self.g) {
            if *t <= x {
                v = *g;
            } else {
                break;
            }
        }
        v
    }

    /// `G(x−)`: the value just before `x` (1 before the first time).
    pub fn before(&self, x: f64) -> f64 {
        let mut v = 1.0;
        for (t, g) in self.t.iter().zip(&self.g) {
            if *t < x {
                v = *g;
            } else {
                break;
            }
        }
        v
    }
}

/// The KM of the censoring distribution, `time`/`event` per patient (events
/// first at tied times: `event == Some(0.0)` is a censoring, anything else —
/// an event or an unknown flag — is not) — the package's `censoring_km`.
/// Callers pass finite times (the label extraction drops unknown ones).
pub fn censoring_km(time: &[f64], event: &[Option<f64>]) -> CensoringKm {
    let mut order: Vec<usize> = (0..time.len()).collect();
    order.sort_by(|&a, &b| time[a].total_cmp(&time[b]));
    let n = order.len();
    let mut km = CensoringKm {
        t: Vec::new(),
        g: Vec::new(),
    };
    let mut g = 1.0;
    let mut i = 0;
    while i < n {
        let mut j = i;
        let mut censored = 0.0;
        while j < n && time[order[j]] == time[order[i]] {
            if event[order[j]] == Some(0.0) {
                censored += 1.0;
            }
            j += 1;
        }
        let at_risk = (n - i) as f64;
        if censored > 0.0 {
            g *= 1.0 - censored / at_risk;
        }
        km.t.push(time[order[i]]);
        km.g.push(g);
        i = j;
    }
    km
}

/// One IPCW-labelled patient: the binary label, the weight and whether the
/// patient is kept at all (censored before the horizon → dropped; the
/// package's `ipcw_labels` triple).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IpcwLabel {
    /// 1 = event by the horizon, 0 = event-free beyond it; `None` = no label
    /// (censored before the horizon — `keep` is false).
    pub label: Option<f64>,
    /// `1/G` (floored at [`G_FLOOR`] — so no weight exceeds `1/G_FLOOR`).
    pub weight: f64,
    /// Whether the patient is used: false when censored before `h`.
    pub keep: bool,
}

/// The `P(event by day h)` training labels from follow-up times and event
/// flags (days since the first dose), with the IPCW weights — the package's
/// `ipcw_labels`: an event at or before h is 1 weighted by `1/G(time−)`, a
/// follow-up beyond h is 0 weighted by `1/G(h)`, a patient censored at or
/// before h is left out.
pub fn ipcw_labels(time: &[f64], event: &[Option<f64>], horizon: f64) -> Vec<IpcwLabel> {
    let km = censoring_km(time, event);
    (0..time.len())
        .map(|i| {
            if event[i] == Some(1.0) && time[i] <= horizon {
                IpcwLabel {
                    label: Some(1.0),
                    weight: 1.0 / km.before(time[i]).max(G_FLOOR),
                    keep: true,
                }
            } else if time[i] > horizon {
                IpcwLabel {
                    label: Some(0.0),
                    weight: 1.0 / km.at(horizon).max(G_FLOOR),
                    keep: true,
                }
            } else {
                IpcwLabel {
                    label: None,
                    weight: 0.0,
                    keep: false,
                }
            }
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// The seeded cross-fit fold construction (the package's Rng — pinned by
// `tests/golden/v2.0.0/rng/rng.tsv`, an independent implementation of the
// same specification)
// ─────────────────────────────────────────────────────────────────────────────

/// The deterministic generator of the package's folds (`rng.hpp`:
/// xoshiro256** seeded through SplitMix64; `below(n)` is uniform in [0, n) by
/// rejection; shuffle is Fisher–Yates from the back). Kept private — the
/// engine needs only the fold assignment, never the stream.
struct Rng {
    s: [u64; 4],
}

impl Rng {
    fn new(seed: u64) -> Self {
        let mut x = seed;
        let s = [
            splitmix64(&mut x),
            splitmix64(&mut x),
            splitmix64(&mut x),
            splitmix64(&mut x),
        ];
        Self { s }
    }

    fn next(&mut self) -> u64 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }

    fn below(&mut self, n: u64) -> u64 {
        let threshold = 0u64.wrapping_sub(n) % n;
        loop {
            let r = self.next();
            if r >= threshold {
                return r % n;
            }
        }
    }

    fn permutation(&mut self, n: usize) -> Vec<usize> {
        let mut a: Vec<usize> = (0..n).collect();
        for i in (1..n).rev() {
            let j = self.below(i as u64 + 1) as usize;
            a.swap(i, j);
        }
        a
    }
}

fn splitmix64(x: &mut u64) -> u64 {
    *x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// The fold of each patient of the `fitted: true` cross-fit arm (the
/// package's construction in `engine.cpp::fit`): the patients (callers pass
/// them in the deterministic `outcomes.csv` order — the sorted cohort) are
/// shuffled with the run's seed and every `folds`-th position forms one fold;
/// `fold_of_patient[i]` is the fold the model trained ON THE REST was
/// validated on for patient i, and the recalibration map is fitted on these
/// OUT-OF-FOLD risks plus the patients' own outcomes. `folds` is the
/// package's `K` (3 via [`CROSS_FIT_FOLDS`]); 0 is treated as 1.
pub fn crossfit_folds(n_patients: usize, seed: u64, folds: usize) -> Vec<usize> {
    let k = fold_count(folds);
    let perm = Rng::new(seed).permutation(n_patients);
    let mut fold_of = vec![0usize; n_patients];
    for (i, patient) in perm.iter().enumerate() {
        fold_of[*patient] = i % k;
    }
    fold_of
}

// ─────────────────────────────────────────────────────────────────────────────
// The calibration band: training labels + the conversion fitting entry
// ─────────────────────────────────────────────────────────────────────────────

/// One training patient's outcome facts, as the conversion band reads them
/// from the written `train/outcomes.csv` (the package's `OutcomeRow`
/// projection; an empty cell = not available for this patient).
#[derive(Debug, Clone, PartialEq)]
pub struct TrainingLabel {
    pub patient_id: String,
    pub pfs_time: Option<f64>,
    pub pfs_event: Option<f64>,
    pub os_time: Option<f64>,
    pub os_event: Option<f64>,
    pub no_response: Option<f64>,
    pub progressive_disease: Option<f64>,
}

/// Read the training labels from a parsed `train/outcomes.csv` (the row order
/// the bundle wrote — the sorted cohort). Only the fixed column set of
/// contract 2.0 is read; the per-horizon `progression_H<h>`/`death_H<h>`
/// cells are the method-bundle labels, not the conversion's (the conversion
/// fits the IPCW labels from the follow-up times/events).
pub fn training_labels(outcomes: &CsvTable) -> Vec<TrainingLabel> {
    let cell = |name: &str, row: usize| -> Option<f64> {
        outcomes
            .col(name)
            .and_then(|col| parse_number(&col[row]))
            .filter(|x| x.is_finite())
    };
    let n = outcomes.nrow();
    let ids = outcomes.col("patient_id");
    (0..n)
        .map(|row| TrainingLabel {
            patient_id: ids.map(|ids| ids[row].clone()).unwrap_or_default(),
            pfs_time: cell("pfs_time", row),
            pfs_event: cell("pfs_event", row),
            os_time: cell("os_time", row),
            os_event: cell("os_event", row),
            no_response: cell("no_response", row),
            progressive_disease: cell("progressive_disease", row),
        })
        .collect()
}

/// A recalibration refusal — the plan's `RECALIBRATION_FAILED` + the named
/// reason kept on the method row (INV-2). Both variants are the one engine
/// code; the details differ.
#[derive(Debug, Clone, PartialEq)]
pub enum CalibrationError {
    /// The method declares a native probability for the displayed (outcome,
    /// horizon) — the conversion band is never applied on top of one
    /// (INV-3: `prob_source` is never mixed silently within a column).
    NativeProbability { method_id: String, column: String },
    /// No usable (risk, label) pair on the training side: the conversion map
    /// cannot be learned (the package's constant-with-NA-rate outcome — the
    /// engine refuses it instead of serving an all-empty column).
    NoUsableTrainingData {
        method_id: String,
        outcome: String,
        horizon: Option<f64>,
    },
}

impl CalibrationError {
    /// The engine's reason code for every variant.
    pub fn engine_code(&self) -> EngineReasonCode {
        EngineReasonCode::RecalibrationFailed
    }

    /// The human line kept on the method row.
    pub fn detail(&self) -> String {
        match self {
            CalibrationError::NativeProbability { method_id, column } => format!(
                "method '{method_id}' writes its own probability column {column}; no conversion is fitted (native and recalibrated probabilities are never mixed)"
            ),
            CalibrationError::NoUsableTrainingData {
                method_id,
                outcome,
                horizon,
            } => match horizon {
                Some(h) => format!(
                    "method '{method_id}' gave no training score the {} probability at H{} can be fitted from",
                    outcome,
                    horizon_name(*h)
                ),
                None => format!(
                    "method '{method_id}' gave no training score the {outcome} probability can be fitted from"
                ),
            },
        }
    }
}

impl std::fmt::Display for CalibrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.detail())
    }
}

impl std::error::Error for CalibrationError {}

/// Fit the recalibration map for one displayed (outcome, horizon) from the
/// TRAINING side (the package's conversion band of `engine.cpp::fit`):
///
/// - `spec`: the method's declared outputs (a native probability for the
///   displayed outcome/horizon is a refusal — never converted).
/// - `outcomes`: the parsed `train/outcomes.csv` (the labels, in the bundle's
///   row order).
/// - `training_risks`: the method's scores of the training patients, keyed by
///   patient id — `fitted` methods' scores are the OUT-OF-FOLD risks of
///   [`crossfit_folds`] (the per-fold runs are the orchestrator's v1 calls);
///   a patient with no score is an unknown risk, dropped by the fit.
/// - `outcome` / `horizon`: the displayed column's identity.
///
/// Survival outcomes use the IPCW labels at the horizon; the response
/// outcomes are the plain 0/1 labels at weight 1. The result is the
/// [`Conversion`] (kind `logistic` or `constant`), or a typed
/// [`CalibrationError`] → `RECALIBRATION_FAILED`.
pub fn fit_recalibration(
    spec: &PredictionSpec<'_>,
    outcomes: &CsvTable,
    training_risks: &BTreeMap<String, Option<f64>>,
    outcome: &str,
    horizon: Option<f64>,
) -> Result<Conversion, CalibrationError> {
    if own_probability(spec.own_outputs, outcome, horizon) {
        return Err(CalibrationError::NativeProbability {
            method_id: spec.method_id.to_string(),
            column: chance_column(outcome, horizon),
        });
    }
    let labels = training_labels(outcomes);
    let mut risk: Vec<Option<f64>> = Vec::new();
    let mut y: Vec<Option<f64>> = Vec::new();
    let mut w: Vec<f64> = Vec::new();

    if is_survival(outcome) {
        // The package reads the follow-up time/event pair of the outcome
        // (pfs → progression, os → death), skips the patients without a
        // time, and lets ipcw_labels keep/weight the rest.
        let (time_col, event_col) = match outcome {
            "progression" => ("pfs_time", "pfs_event"),
            "death" => ("os_time", "os_event"),
            _ => unreachable!("is_survival gates the pair"),
        };
        let mut times: Vec<f64> = Vec::new();
        let mut events: Vec<Option<f64>> = Vec::new();
        let mut ids: Vec<&str> = Vec::new();
        for lbl in &labels {
            let Some(t) = training_label_cell(lbl, time_col) else {
                continue;
            };
            times.push(t);
            events.push(training_label_cell(lbl, event_col));
            ids.push(&lbl.patient_id);
        }
        let h = horizon.expect("a survival outcome carries the run's horizon");
        for (i, ipcw) in ipcw_labels(&times, &events, h).iter().enumerate() {
            if !ipcw.keep {
                continue;
            }
            risk.push(training_risks.get(ids[i]).copied().flatten());
            y.push(ipcw.label);
            w.push(ipcw.weight);
        }
    } else {
        for lbl in &labels {
            // The response label the package reads (no_response for the app's
            // displayed outcome; progressive_disease is never learned — the
            // arm stays symmetric for completeness).
            let Some(yy) = training_label_cell(lbl, outcome) else {
                continue;
            };
            risk.push(
                training_risks
                    .get(lbl.patient_id.as_str())
                    .copied()
                    .flatten(),
            );
            y.push(Some(yy));
            w.push(1.0);
        }
    }

    let conversion = fit_conversion(&risk, &y, &w);
    if conversion.n == 0 {
        return Err(CalibrationError::NoUsableTrainingData {
            method_id: spec.method_id.to_string(),
            outcome: outcome.to_string(),
            horizon,
        });
    }
    Ok(conversion)
}

/// The label cell of one training patient (the column names the conversion
/// band reads from `outcomes.csv`).
fn training_label_cell(lbl: &TrainingLabel, column: &str) -> Option<f64> {
    match column {
        "pfs_time" => lbl.pfs_time,
        "pfs_event" => lbl.pfs_event,
        "os_time" => lbl.os_time,
        "os_event" => lbl.os_event,
        "no_response" => lbl.no_response,
        "progressive_disease" => lbl.progressive_disease,
        _ => None,
    }
}

/// The predict-side rows with the recalibration map applied: every scored
/// patient's missing probability becomes `conversion.apply(risk)` (an
/// abstained patient keeps its note and no probability); a native value is
/// never overwritten — the caller calls this only for a
/// `native_column: None` method, and the rows' `prob_source` is then
/// `"recalibrated"` on the method record (one source per column, INV-3).
pub fn converted_rows(conversion: &Conversion, rows: &[PredictionRow]) -> Vec<PredictionRow> {
    rows.iter()
        .map(|row| {
            let mut converted = row.clone();
            if converted.probability.is_none() {
                converted.probability = conversion.apply(row.risk);
            }
            converted
        })
        .collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-EE-09 (contract 2.0 re-pin: the plan's `p_event_H-<h>` /
// `p_fail` assertions are `p_<outcome>_H<h>` / `p_<outcome>`), plus the
// package's one-failing-case-per-check pins. Fixtures are synthetic in-test
// constructs (ids T0000.., values by hand) — TEST-EE-22's hygiene rule.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::method_catalogue::types::MethodGroup;

    // ── fixture builders ────────────────────────────────────────────────────

    /// A predictions.csv text: header + rows. Cells the tests keep simple
    /// are written verbatim; `quote` marks a cell that needs RFC-4180
    /// quoting (a note with a comma).
    fn csv(header: &[&str], rows: &[&[&str]]) -> String {
        let mut out = String::new();
        for row in std::iter::once(header).chain(rows.iter().copied()) {
            for (j, cell) in row.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                out.push_str(cell);
            }
            out.push('\n');
        }
        out
    }

    /// An RFC-4180-quoted cell (the writer the method used; the one note in
    /// this fixture carries a comma so the parse must unquote it).
    fn q(s: &str) -> String {
        format!("\"{}\"", s.replace('"', "\"\""))
    }

    fn expected() -> Vec<String> {
        vec!["T0001", "T0002", "T0003", "T0004", "T0005"]
            .into_iter()
            .map(|s| s.to_string())
            .collect()
    }

    // ── the happy path: a native-probability method, all patients scored ────

    #[test]
    fn native_probability_method_parses_and_assembles() {
        let own: Vec<String> = vec!["risk".into(), "p_progression_H*".into()];
        let spec = PredictionSpec {
            method_id: "fake-prob",
            own_outputs: &own,
            group: MethodGroup::DynamicRisk,
            constant_ok: None,
        };
        let text = csv(
            &["patient_id", "risk", "p_progression_H238", "note"],
            &[
                &["T0001", "0.1", "0.31", ""],
                &["T0002", "0.2", "0.4", ""],
                &["T0003", "0.3", "0.5", ""],
                &["T0004", "0.4", "0.6", ""],
                &["T0005", "0.5", "0.7", ""],
            ],
        );
        let m = method_predictions(
            Some(&text),
            r#"{"marker":"M1","n_train":42}"#,
            &spec,
            &expected(),
            &[],
            &["progression".to_string()],
            &[238.0],
            "progression",
            Some(238.0),
        )
        .expect("the fixture is contract-valid");

        assert_eq!(m.native_column.as_deref(), Some("p_progression_H238"));
        assert_eq!(m.outcome, "progression");
        assert_eq!(m.horizon, Some(238.0));
        assert_eq!(m.rows.len(), 5);
        assert_eq!(m.rows[0].patient_id, "T0001");
        assert_eq!(m.rows[0].risk, Some(0.1));
        assert_eq!(m.rows[0].probability, Some(0.31));
        assert_eq!(m.rows[3].probability, Some(0.6));
        assert_eq!(m.rows[0].note, "");
        assert_eq!(m.rows[1].note, "");
        let cov = m.coverage();
        assert_eq!(cov.scored, 5);
        assert_eq!(cov.eligible, 5);
        assert_eq!(cov.fraction, 1.0);
        assert_eq!(m.report["n_train"], 42);

        // The outcome-scoped risk band: the plain-risk method reads `risk`.
        let risks = outcome_risks(&spec, &m.table, &expected(), "progression");
        assert_eq!(risks[4], Some(0.5));
    }

    #[test]
    fn run_json_missing_or_mangled_is_empty_object() {
        assert_eq!(read_run_json(""), Value::Object(serde_json::Map::new()));
        assert_eq!(
            read_run_json("{ not json"),
            Value::Object(serde_json::Map::new())
        );
        assert_eq!(read_run_json(r#"{"a":[1,2]}"#)["a"][1], 2);
    }

    // ── the row set: missing / extra / duplicate ────────────────────────────

    #[test]
    fn row_set_exactness_is_enforced() {
        let own: Vec<String> = vec!["risk".into()];
        let spec = PredictionSpec {
            method_id: "m",
            own_outputs: &own,
            group: MethodGroup::StaticRisk,
            constant_ok: None,
        };

        let missing = csv(
            &["patient_id", "risk"],
            &[
                &["T0001", "0.1"],
                &["T0002", "0.2"],
                &["T0003", "0.3"],
                &["T0004", "0.4"],
                // T0005 absent
            ],
        );
        let table = parse_csv(&missing).unwrap();
        let problems = validate_output(&spec, &table, &expected(), &[], &[]);
        assert!(
            problems
                .iter()
                .any(|p| p == "patient missing from predictions.csv: T0005"),
            "{problems:?}"
        );

        let extra = csv(
            &["patient_id", "risk"],
            &[
                &["T0001", "0.1"],
                &["T0002", "0.2"],
                &["T0003", "0.3"],
                &["T0004", "0.4"],
                &["T0005", "0.5"],
                &["T0009", "0.9"],
            ],
        );
        let table = parse_csv(&extra).unwrap();
        let problems = validate_output(&spec, &table, &expected(), &[], &[]);
        assert!(
            problems
                .iter()
                .any(|p| p == "patient in predictions.csv that was not asked for: T0009"),
            "{problems:?}"
        );

        let dup = csv(
            &["patient_id", "risk"],
            &[
                &["T0001", "0.1"],
                &["T0002", "0.2"],
                &["T0003", "0.3"],
                &["T0004", "0.4"],
                &["T0005", "0.5"],
                &["T0001", "0.1"],
            ],
        );
        let table = parse_csv(&dup).unwrap();
        let problems = validate_output(&spec, &table, &expected(), &[], &[]);
        assert!(
            problems
                .iter()
                .any(|p| p == "patient appears more than once in predictions.csv: T0001"),
            "{problems:?}"
        );

        // The assembly (PART-1: asserts the failure typing with the reason).
        let err = method_predictions(
            Some(&missing),
            "",
            &spec,
            &expected(),
            &[],
            &[],
            &[],
            "progression",
            Some(238.0),
        )
        .unwrap_err();
        assert_eq!(err.engine_code(), EngineReasonCode::PredictionInvalid);
        assert!(
            err.detail()
                .contains("patient missing from predictions.csv: T0005"),
            "{}",
            err.detail()
        );
    }

    // ── the columns themselves ──────────────────────────────────────────────

    #[test]
    fn patient_id_and_risk_are_required_columns() {
        let own: Vec<String> = vec!["risk".into()];
        let spec = PredictionSpec {
            method_id: "m",
            own_outputs: &own,
            group: MethodGroup::StaticRisk,
            constant_ok: None,
        };
        let table = parse_csv(&csv(&["patient_id"], &[&["T0001"]])).unwrap();
        let problems = validate_output(&spec, &table, &expected(), &[], &[]);
        assert_eq!(
            problems,
            vec!["predictions.csv must have the columns patient_id and risk".to_string()]
        );
    }

    #[test]
    fn numbers_must_be_finite_and_probabilities_in_range() {
        let own: Vec<String> = vec!["risk".into(), "p_no_response".into()];
        let spec = PredictionSpec {
            method_id: "m",
            own_outputs: &own,
            group: MethodGroup::ResponseProbability,
            constant_ok: None,
        };
        let expected: Vec<String> = vec!["T0001".to_string(), "T0002".to_string()];

        // "inf" is a number to the package's parser — the finite check refuses it.
        let inf = csv(
            &["patient_id", "risk", "p_no_response", "note"],
            &[&["T0001", "inf", "0.5", ""], &["T0002", "0.2", "0.6", ""]],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&inf).unwrap(),
            &expected,
            &["no_response".to_string()],
            &[],
        );
        assert!(
            problems
                .iter()
                .any(|p| p
                    .contains("column risk row 1 (patient T0001): 'inf' is not a finite number")),
            "{problems:?}"
        );

        // "nan" is not a number (the first bad row of the column is named —
        // the package reports one per column, then moves on).
        let nan = csv(
            &["patient_id", "risk", "p_no_response", "note"],
            &[&["T0001", "nan", "0.5", ""], &["T0002", "0.2", "0.6", ""]],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&nan).unwrap(),
            &expected,
            &["no_response".to_string()],
            &[],
        );
        assert!(
            problems
                .iter()
                .any(|p| p.contains("'nan' is not a finite number")),
            "{problems:?}"
        );

        // A pandas-missing word ("NA") is not a number either.
        let na = csv(
            &["patient_id", "risk", "p_no_response", "note"],
            &[&["T0001", "NA", "0.5", ""], &["T0002", "0.2", "0.6", ""]],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&na).unwrap(),
            &expected,
            &["no_response".to_string()],
            &[],
        );
        assert!(
            problems
                .iter()
                .any(|p| p.contains("'NA' is not a finite number")),
            "{problems:?}"
        );

        // A probability outside [0, 1] names the column, the row and the patient.
        let prob = csv(
            &["patient_id", "risk", "p_no_response", "note"],
            &[&["T0001", "0.1", "1.5", ""], &["T0002", "0.2", "0.6", ""]],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&prob).unwrap(),
            &expected,
            &["no_response".to_string()],
            &[],
        );
        assert!(
            problems.iter().any(|p| p
                == "column p_no_response row 1 (patient T0001): 1.5 is outside the allowed range"),
            "{problems:?}"
        );

        // A negative probability is refused the same way.
        let neg = csv(
            &["patient_id", "risk", "p_no_response", "note"],
            &[&["T0001", "0.1", "-0.1", ""], &["T0002", "0.2", "0.6", ""]],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&neg).unwrap(),
            &expected,
            &["no_response".to_string()],
            &[],
        );
        assert!(
            problems.iter().any(|p| p
                == "column p_no_response row 1 (patient T0001): -0.1 is outside the allowed range"),
            "{problems:?}"
        );
    }

    #[test]
    fn call_must_be_zero_or_one() {
        let own: Vec<String> = vec!["risk".into(), "call".into()];
        let spec = PredictionSpec {
            method_id: "rule",
            own_outputs: &own,
            group: MethodGroup::ResponseCall,
            constant_ok: None,
        };
        let expected: Vec<String> = vec!["T0001".to_string(), "T0002".to_string()];
        let bad = csv(
            &["patient_id", "risk", "call", "note"],
            &[&["T0001", "0.1", "2", ""], &["T0002", "0.2", "1", ""]],
        );
        let problems = validate_output(&spec, &parse_csv(&bad).unwrap(), &expected, &[], &[]);
        assert!(
            problems
                .iter()
                .any(|p| p == "column call row 1 (patient T0001): 2 is outside the allowed range"),
            "{problems:?}"
        );
        let good = csv(
            &["patient_id", "risk", "call", "note"],
            &[&["T0001", "0.1", "0", ""], &["T0002", "0.2", "1", ""]],
        );
        assert!(validate_output(&spec, &parse_csv(&good).unwrap(), &expected, &[], &[]).is_empty());
    }

    // ── the risk rules ──────────────────────────────────────────────────────

    #[test]
    fn constant_risk_rule_matches_the_package() {
        let own: Vec<String> = vec!["risk".into()];
        let mut spec = PredictionSpec {
            method_id: "m",
            own_outputs: &own,
            group: MethodGroup::StaticRisk,
            constant_ok: None,
        };
        let constant = csv(
            &["patient_id", "risk", "note"],
            &[
                &["T0001", "0.7", ""],
                &["T0002", "0.7", ""],
                &["T0003", "0.7", ""],
                &["T0004", "0.7", ""],
                &["T0005", "0.7", ""],
            ],
        );
        let problems =
            validate_output(&spec, &parse_csv(&constant).unwrap(), &expected(), &[], &[]);
        assert!(
            problems
                .iter()
                .any(|p| p == "every patient has the same risk (0.7); the method does not declare constant_ok"),
            "{problems:?}"
        );

        // constant_ok explains it → accepted.
        spec.constant_ok = Some("degenerate data");
        assert!(
            validate_output(&spec, &parse_csv(&constant).unwrap(), &expected(), &[], &[])
                .is_empty()
        );

        // Fewer than 5 scored patients: the package does not apply the check.
        spec.constant_ok = None;
        let small = csv(
            &["patient_id", "risk", "note"],
            &[
                &["T0001", "0.7", ""],
                &["T0002", "0.7", ""],
                &["T0003", "0.7", ""],
                &["T0004", "0.7", ""],
            ],
        );
        let exp4: Vec<String> = vec!["T0001", "T0002", "T0003", "T0004"]
            .into_iter()
            .map(|s| s.to_string())
            .collect();
        assert!(validate_output(&spec, &parse_csv(&small).unwrap(), &exp4, &[], &[]).is_empty());
    }

    #[test]
    fn abstain_rows_carry_note_and_cover_count() {
        let own: Vec<String> = vec!["risk".into(), "p_progression_H*".into()];
        let spec = PredictionSpec {
            method_id: "m",
            own_outputs: &own,
            group: MethodGroup::DynamicRisk,
            constant_ok: None,
        };
        let text = csv(
            &["patient_id", "risk", "p_progression_H238", "note"],
            &[
                &["T0001", "", "", "no value at the landmark"],
                &["T0002", "0.2", "0.4", ""],
                &["T0003", "0.3", "0.5", ""],
                &["T0004", "0.4", "0.6", ""],
                &["T0005", "0.5", "0.7", ""],
            ],
        );
        let m = method_predictions(
            Some(&text),
            "",
            &spec,
            &expected(),
            &[(
                "T0006".to_string(),
                "fewer than 3 draws by day 56".to_string(),
            )],
            &["progression".to_string()],
            &[238.0],
            "progression",
            Some(238.0),
        )
        .expect("an abstain row with a note is valid");

        assert_eq!(m.rows.len(), 6);
        assert_eq!(m.rows[0].risk, None);
        assert_eq!(m.rows[0].probability, None);
        assert_eq!(m.rows[0].note, "no value at the landmark");
        assert_eq!(m.rows[5].patient_id, "T0006");
        assert_eq!(m.rows[5].probability, None);
        assert_eq!(m.rows[5].note, "fewer than 3 draws by day 56");
        // coverage matches the abstain count: 4 of 6 have a probability
        let cov = m.coverage();
        assert_eq!((cov.scored, cov.eligible), (4, 6));
        assert!((cov.fraction - 4.0 / 6.0).abs() < 1e-12);

        // The same row without a note is a contract violation.
        let nonote = csv(
            &["patient_id", "risk", "p_progression_H238", "note"],
            &[
                &["T0001", "", "", ""],
                &["T0002", "0.2", "0.4", ""],
                &["T0003", "0.3", "0.5", ""],
                &["T0004", "0.4", "0.6", ""],
                &["T0005", "0.5", "0.7", ""],
            ],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&nonote).unwrap(),
            &expected(),
            &["progression".to_string()],
            &[238.0],
        );
        assert!(
            problems
                .iter()
                .any(|p| p == "risk is empty for patient T0001 without a note"),
            "{problems:?}"
        );

        // Every patient abstained is refused ("nothing is repaired").
        let all = csv(
            &["patient_id", "risk", "p_progression_H238", "note"],
            &[
                &["T0001", "", "", "no value"],
                &["T0002", "", "", "no value"],
                &["T0003", "", "", "no value"],
                &["T0004", "", "", "no value"],
                &["T0005", "", "", "no value"],
            ],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&all).unwrap(),
            &expected(),
            &["progression".to_string()],
            &[238.0],
        );
        assert!(
            problems
                .iter()
                .any(|p| p == "risk is empty for every patient"),
            "{problems:?}"
        );
    }

    // ── declared columns ────────────────────────────────────────────────────

    #[test]
    fn declared_columns_must_be_present_and_non_empty() {
        let own: Vec<String> = vec!["risk".into(), "p_death_H*".into()];
        let spec = PredictionSpec {
            method_id: "m",
            own_outputs: &own,
            group: MethodGroup::DynamicRisk,
            constant_ok: None,
        };
        let text = csv(
            &["patient_id", "risk", "note"],
            &[
                &["T0001", "0.1", ""],
                &["T0002", "0.2", ""],
                &["T0003", "0.3", ""],
                &["T0004", "0.4", ""],
                &["T0005", "0.5", ""],
            ],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&text).unwrap(),
            &expected(),
            &["death".to_string()],
            &[238.0],
        );
        assert!(
            problems
                .iter()
                .any(|p| p == "declared column p_death_H238 is absent"),
            "{problems:?}"
        );

        // A response-call rule must write `call` even when it forgot to declare it.
        let own: Vec<String> = vec!["risk".into()];
        let spec = PredictionSpec {
            method_id: "rule",
            own_outputs: &own,
            group: MethodGroup::ResponseCall,
            constant_ok: None,
        };
        let problems = validate_output(&spec, &parse_csv(&text).unwrap(), &expected(), &[], &[]);
        assert!(
            problems
                .iter()
                .any(|p| p == "declared column call is absent"),
            "{problems:?}"
        );

        // A scored patient's own probability cell is never empty.
        let own: Vec<String> = vec!["risk".into(), "p_progression_H*".into()];
        let spec = PredictionSpec {
            method_id: "m",
            own_outputs: &own,
            group: MethodGroup::DynamicRisk,
            constant_ok: None,
        };
        let empty = csv(
            &["patient_id", "risk", "p_progression_H238", "note"],
            &[
                &["T0001", "0.1", "0.31", ""],
                &["T0002", "0.2", "", ""],
                &["T0003", "0.3", "0.5", ""],
                &["T0004", "0.4", "0.6", ""],
                &["T0005", "0.5", "0.7", ""],
            ],
        );
        let problems = validate_output(
            &spec,
            &parse_csv(&empty).unwrap(),
            &expected(),
            &["progression".to_string()],
            &[238.0],
        );
        assert!(
            problems.iter().any(
                |p| p == "column p_progression_H238 is empty for patient T0002, who has a risk"
            ),
            "{problems:?}"
        );
    }

    // ── the chance-column selection (contract 2.0 names) ────────────────────

    #[test]
    fn chance_column_selection_and_native_detection() {
        assert_eq!(
            chance_column("progression", Some(238.0)),
            "p_progression_H238"
        );
        assert_eq!(chance_column("death", Some(238.5)), "p_death_H238.5");
        assert_eq!(chance_column("no_response", None), "p_no_response");
        assert_eq!(
            chance_column("progressive_disease", None),
            "p_progressive_disease"
        );
        assert_eq!(horizon_name(238.0), "238");
        assert_eq!(horizon_name(238.5), "238.5");
        assert!(is_survival("progression") && is_survival("death"));
        assert!(!is_survival("no_response") && !is_survival("progressive_disease"));

        let wild: Vec<String> = vec!["p_progression_H*".into()];
        // The wildcard declares EVERY horizon of the outcome (the package's
        // `declares` prefix rule) — and nothing of another outcome.
        assert!(own_probability(&wild, "progression", Some(238.0)));
        assert!(own_probability(&wild, "progression", Some(200.0)));
        assert!(!own_probability(&wild, "death", Some(238.0)));
        assert!(!own_probability(&wild, "no_response", None));

        let exact: Vec<String> = vec!["p_progression_H238".into()];
        assert!(own_probability(&exact, "progression", Some(238.0)));
        assert!(!own_probability(&exact, "progression", Some(239.0)));

        // The per-outcome risk column follows the method's own outputs.
        let own: Vec<String> = vec!["risk".into(), "risk_death".into()];
        assert_eq!(risk_column(&own, "progression"), "risk");
        assert_eq!(risk_column(&own, "death"), "risk_death");
        assert!(own_risk(&own, "death"));
        assert!(!own_risk(&own, "progression"));
        assert!(declares(&own, "risk_death"));

        // The run task → the app's displayed outcome.
        assert_eq!(task_outcome(TxrTask::Pfs), "progression");
        assert_eq!(task_outcome(TxrTask::Os), "death");
        assert_eq!(task_outcome(TxrTask::Response), "no_response");
    }

    /// The recorded chance-column artifact (ITEM-10's PROV-EE-7 read
    /// surface) round-trips the rows it was written from: the output dir
    /// placement, the 6-decimal probability, the empty cell for an
    /// abstention and the codec-escaped notes (incl. a comma-carrying one).
    #[test]
    fn chance_column_round_trips_through_the_recorded_artifact() {
        let run_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/txr-execution-engine-item10/chance-column")
            .join(uuid::Uuid::new_v4().simple().to_string());
        let rows = vec![
            PredictionRow {
                patient_id: "P001".to_string(),
                risk: Some(0.5),
                probability: Some(0.666666666),
                note: String::new(),
            },
            PredictionRow {
                patient_id: "P002".to_string(),
                risk: None,
                probability: None,
                note: "fewer than 3 draws by day 56".to_string(),
            },
            PredictionRow {
                patient_id: "P003".to_string(),
                risk: Some(0.2),
                probability: None,
                note: "a note, with a comma and \"quotes\"".to_string(),
            },
        ];
        write_chance_column(&run_dir, "dynforest", &rows).expect("writes");
        let table = parse_csv(
            &std::fs::read_to_string(
                run_dir.join("output").join("dynforest").join("chance.csv"),
            )
            .expect("chance.csv present"),
        )
        .expect("parses with the module codec");

        let ids = table.col("patient_id").expect("patient_id column");
        assert_eq!(ids, &["P001", "P002", "P003"]);
        let probs = table.col("probability").expect("probability column");
        assert_eq!(probs[0], "0.666667");
        assert!(probs[1].is_empty(), "abstained → the cell is empty");
        assert!(probs[2].is_empty(), "no native probability → empty here");
        let notes = table.col("note").expect("note column");
        assert!(notes[0].is_empty());
        assert_eq!(notes[1], "fewer than 3 draws by day 56");
        assert_eq!(
            notes[2],
            "a note, with a comma and \"quotes\"",
            "the codec's escaping survives the round trip"
        );
        let _ = std::fs::remove_dir_all(&run_dir);
    }

    // ── the risk band is outcome-scoped ─────────────────────────────────────

    #[test]
    fn outcome_risks_read_the_per_outcome_column() {
        let own: Vec<String> = vec!["risk".into(), "risk_death".into()];
        let spec = PredictionSpec {
            method_id: "m",
            own_outputs: &own,
            group: MethodGroup::DynamicRisk,
            constant_ok: None,
        };
        let text = csv(
            &["patient_id", "risk", "risk_death", "note"],
            &[
                &["T0001", "0.1", "0.9", ""],
                &["T0002", "0.2", "1.4", ""],
                &["T0003", "0.3", "1.7", ""],
                &["T0004", "0.4", "2.0", ""],
                &["T0005", "0.5", "2.2", ""],
            ],
        );
        let table = parse_csv(&text).unwrap();
        let risks = outcome_risks(&spec, &table, &expected(), "death");
        assert_eq!(risks[0], Some(0.9));
        assert_eq!(risks[4], Some(2.2));
        let probs = outcome_risks(&spec, &table, &expected(), "progression");
        assert_eq!(probs[0], Some(0.1));

        // No native probability → the caller gets the flag, ITEM-6 converts.
        let (col, probs) = outcome_probabilities(&spec, &table, &expected(), "death", Some(238.0));
        assert_eq!(col, None);
        assert_eq!(probs, vec![None; 5]);
        let (col, probs) =
            outcome_probabilities(&spec, &table, &expected(), "progression", Some(238.0));
        assert_eq!(col, None);
        assert_eq!(probs, vec![None; 5]);

        // The assembly carries the OUTCOME-SCOPED risk in its rows (the
        // conversion fitting reads these) and flags the missing native column.
        let m = method_predictions(
            Some(&text),
            "",
            &spec,
            &expected(),
            &[],
            &["death".to_string()],
            &[238.0],
            "death",
            Some(238.0),
        )
        .expect("valid");
        assert_eq!(m.native_column, None);
        assert_eq!(m.rows[0].risk, Some(0.9));
        assert_eq!(m.rows[4].risk, Some(2.2));
        assert_eq!(m.rows[0].probability, None);
        let cov = m.coverage();
        assert_eq!((cov.scored, cov.eligible, cov.fraction), (0, 5, 0.0));
    }

    // ── missing file / malformed CSV / quoted notes ─────────────────────────

    #[test]
    fn missing_file_and_malformed_csv_are_typed_refusals() {
        let own: Vec<String> = vec!["risk".into()];
        let spec = PredictionSpec {
            method_id: "fake-fail",
            own_outputs: &own,
            group: MethodGroup::StaticRisk,
            constant_ok: None,
        };
        let err = method_predictions(
            None,
            "",
            &spec,
            &expected(),
            &[],
            &[],
            &[],
            "progression",
            Some(238.0),
        )
        .unwrap_err();
        assert_eq!(err.engine_code(), EngineReasonCode::PredictionInvalid);
        assert_eq!(
            err.detail(),
            "method 'fake-fail' exited without writing /output/predictions.csv"
        );

        // A row whose width differs from the header is refused.
        let bad = "patient_id,risk\nT0001,0.1\nT0002\n";
        let err = method_predictions(
            Some(bad),
            "",
            &spec,
            &expected(),
            &[],
            &[],
            &[],
            "progression",
            Some(238.0),
        )
        .unwrap_err();
        match &err {
            PredictionError::MalformedCsv { detail, .. } => {
                assert_eq!(detail, "CSV row 3 has 1 cells, header has 2")
            }
            other => panic!("expected MalformedCsv, got {other:?}"),
        }

        // Unclosed quotes are refused; a quoted comma note parses back.
        let unclosed = "patient_id,risk,note\nT0001,0.1,\"no value\n";
        let err = method_predictions(
            Some(unclosed),
            "",
            &spec,
            &expected(),
            &[],
            &[],
            &[],
            "progression",
            Some(238.0),
        )
        .unwrap_err();
        match &err {
            PredictionError::MalformedCsv { detail, .. } => {
                assert_eq!(detail, "CSV ends inside a quoted cell")
            }
            other => panic!("expected MalformedCsv, got {other:?}"),
        }

        let quoted = format!(
            "patient_id,risk,note\nT0001,0.1,{}\nT0002,0.2,\nT0003,0.3,\nT0004,0.4,\nT0005,0.5,\n",
            q("a,b")
        );
        let m = method_predictions(
            Some(&quoted),
            "",
            &spec,
            &expected(),
            &[],
            &[],
            &[],
            "progression",
            Some(238.0),
        )
        .expect("quoted cells parse");
        assert_eq!(m.rows[0].note, "a,b");
    }

    // ── fixture hygiene (TEST-EE-22: nothing from a real dataset) ───────────

    #[test]
    fn fixtures_are_synthetic_in_test_constructs() {
        // Every fixture in this module is built from literal ids T0000.. and
        // hand-written numbers in this file — no data-folder path, no marker
        // table, nothing read from the tree. The assertions below ARE the
        // provenance declaration (TEST-EE-22): the id grammar is pinned so a
        // future edit cannot silently substitute a real dataset's ids.
        let synthetic = |id: &str| {
            id.len() == 5 && id.starts_with('T') && id[1..].chars().all(|c| c.is_ascii_digit())
        };
        for id in expected() {
            assert!(synthetic(&id), "{} is a synthetic id", id);
        }
        // The CSV builders take plain `&str` slices — strings only, no I/O —
        // and every number the fixtures carry is a literal in this file.
        let _ = csv(&["patient_id", "risk"], &[&["T0001", "0.1"]]);
        let _ = q("a,b");
    }

    // ── ITEM-6: the U2 recalibration engine (TEST-EE-16) ────────────────────

    /// The package's own golden values (`tests/golden/v2.0.0/rng/rng.tsv`,
    /// re-verified here against a build of the package's `rng.cpp`): the
    /// xoshiro256**/SplitMix64 stream, `below(n)` and the Fisher–Yates
    /// permutation of the fold construction.
    #[test]
    fn rng_matches_the_package_golden_file() {
        let mut rng = Rng::new(0);
        let next: Vec<u64> = (0..8).map(|_| rng.next()).collect();
        assert_eq!(
            next,
            vec![
                11091344671253066420,
                13793997310169335082,
                1900383378846508768,
                7684712102626143532,
                13521403990117723737,
                18442103541295991498,
                7788427924976520344,
                9881088229871127103
            ]
        );
        let mut rng = Rng::new(0);
        let mut below = Vec::new();
        for _ in 0..12 {
            below.push(rng.below(1000));
        }
        assert_eq!(
            below,
            vec![420, 82, 768, 532, 737, 498, 344, 103, 617, 797, 844, 693]
        );
        let mut rng1 = Rng::new(1);
        let mut below1 = Vec::new();
        for _ in 0..12 {
            below1.push(rng1.below(1000));
        }
        assert_eq!(
            below1,
            vec![557, 522, 900, 383, 371, 162, 286, 429, 321, 208, 841, 110]
        );
        assert_eq!(
            Rng::new(0).permutation(20),
            vec![11, 7, 5, 19, 18, 2, 14, 15, 13, 17, 10, 1, 3, 12, 8, 9, 16, 4, 6, 0]
        );
        assert_eq!(
            Rng::new(1).permutation(20),
            vec![12, 13, 2, 6, 4, 18, 16, 9, 19, 10, 11, 1, 8, 0, 7, 3, 5, 14, 15, 17]
        );
    }

    /// TEST-EE-16 half 1: the cross-fit fold construction equals the
    /// package's — the seeded shuffle then every K-th position, `K = 3` (the
    /// `rng.tsv`-pinned Rng; the 9-patient pin was produced by a build of the
    /// package's own `engine.cpp` construction).
    #[test]
    fn crossfit_folds_match_the_package_construction() {
        assert_eq!(
            crossfit_folds(9, 1, CROSS_FIT_FOLDS),
            vec![0, 1, 1, 2, 2, 2, 1, 0, 0],
            "seed 1, 9 patients: the package's fold_of_patient vector"
        );
        let folds = crossfit_folds(6, 0, 3);
        assert!(folds.iter().all(|f| *f < 3));
        // The partition: every fold is exactly every-3rd shuffled position.
        let mut counts = [0usize; 3];
        for f in &folds {
            counts[*f] += 1;
        }
        assert_eq!(counts, [2, 2, 2]);
        // Degenerate edges: 0 patients, and 0 folds treated as 1.
        assert_eq!(crossfit_folds(0, 1, CROSS_FIT_FOLDS), Vec::<usize>::new());
        assert_eq!(crossfit_folds(1, 1, 0), vec![0]);
    }

    /// The package's own hand-computed censoring KM example (`core_test.cpp`),
    /// pinned byte-for-byte.
    #[test]
    fn censoring_km_and_ipcw_labels_match_core_test() {
        let time = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let event: Vec<Option<f64>> = [1.0, 0.0, 1.0, 0.0, 1.0, 0.0].map(Some).to_vec();
        let km = censoring_km(&time, &event);
        assert_eq!(km.at(0.5), 1.0, "1 before the first time");
        assert!((km.at(2.0) - 0.8).abs() < 1e-12, "G(2) = 0.8");
        assert!(
            (km.at(4.0) - 0.8 * (2.0 / 3.0)).abs() < 1e-12,
            "G(4) = 0.5333…"
        );
        assert!((km.before(3.0) - 0.8).abs() < 1e-12, "G(3−) = 0.8");

        let labels = ipcw_labels(&time, &event, 4.0);
        let keep: Vec<bool> = labels.iter().map(|l| l.keep).collect();
        assert_eq!(keep, vec![true, false, true, false, true, true]);
        assert_eq!(labels[0].label, Some(1.0));
        assert_eq!(labels[2].label, Some(1.0));
        assert_eq!(labels[4].label, Some(0.0));
        assert_eq!(labels[5].label, Some(0.0));
        assert!((labels[0].weight - 1.0).abs() < 1e-12, "1/G(1−) = 1");
        assert!((labels[2].weight - 1.25).abs() < 1e-12, "1/G(3−) = 1.25");
        assert!((labels[4].weight - 1.875).abs() < 1e-12, "1/G(5−) = 1.875");
        assert!((labels[5].weight - 1.875).abs() < 1e-12, "1/G(4) = 1.875");

        // The floor: heavy censorings push G under G_FLOOR → the weight caps
        // at 1/G_FLOOR (verified against the package: G(before 21) = 1/21,
        // the kept event's weight is exactly 20).
        let t2: Vec<f64> = (1..=21).map(|d| d as f64).collect();
        let mut e2: Vec<Option<f64>> = vec![Some(0.0); 21];
        e2[20] = Some(1.0);
        let f = ipcw_labels(&t2, &e2, 30.0);
        assert_eq!(f[20].keep, true);
        assert!((f[20].weight - 1.0 / G_FLOOR).abs() < 1e-12);
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-12
    }

    /// A method with no declared outputs beyond the plain `risk` column (the
    /// recalibration band's caller shape).
    fn risk_only_spec<'a>(method_id: &'a str, own_outputs: &'a [String]) -> PredictionSpec<'a> {
        PredictionSpec {
            method_id,
            own_outputs,
            group: MethodGroup::DynamicRisk,
            constant_ok: None,
        }
    }

    /// TEST-EE-16 half 2: `fit_conversion` is the package's — the constant
    /// fallbacks (constant risk → the weighted event rate; one class → the
    /// rate itself; a falling relation → the rate, never a falling
    /// probability; no usable patient → no probability), the interior
    /// logistic fit on the standardised score, and the weights' effect. The
    /// numeric pins were produced by a build of the package's own
    /// `conversion.cpp` on the SAME vectors.
    #[test]
    fn fit_conversion_matches_the_package() {
        let cc = fit_conversion(
            &[Some(1.0), Some(1.0), Some(1.0), Some(1.0)],
            &[Some(1.0), Some(0.0), Some(0.0), Some(1.0)],
            &[1.0, 1.0, 1.0, 1.0],
        );
        assert_eq!(cc.kind(), ConversionKind::Constant);
        assert_eq!(cc.n, 4);
        assert!(approx(cc.rate.unwrap(), 0.5));
        assert!(approx(cc.apply(Some(1.0)).unwrap(), 0.5), "the event rate");

        let one = fit_conversion(
            &[Some(1.0), Some(2.0), Some(3.0)],
            &[Some(1.0), Some(1.0), Some(1.0)],
            &[1.0, 1.0, 1.0],
        );
        assert_eq!(one.kind(), ConversionKind::Constant);
        assert!(approx(one.apply(Some(2.0)).unwrap(), 1.0), "one class");

        let none = fit_conversion(&[None, None], &[Some(1.0), Some(0.0)], &[1.0, 1.0]);
        assert_eq!(none.n, 0);
        assert_eq!(none.rate, None);
        assert_eq!(
            none.apply(Some(1.0)),
            None,
            "no usable patient gives no probability"
        );
        assert_eq!(none.apply(None), None, "no risk gives no probability");

        // The interior logistic pin (the package's own output on this exact
        // 9-vector): p = expit(a + b·(risk−mu)/sd), b > 0, in (0, 1).
        let risk: Vec<Option<f64>> = [-2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0]
            .map(Some)
            .to_vec();
        let label: Vec<Option<f64>> = [0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0]
            .map(Some)
            .to_vec();
        let c = fit_conversion(&risk, &label, &[1.0; 9]);
        assert_eq!(c.kind(), ConversionKind::Logistic);
        assert!(approx(c.a, 0.27542780849523218));
        assert!(approx(c.b, 0.99169043940169499));
        assert!(approx(c.mu, 0.0));
        assert!(approx(c.sd, 1.2909944487358056));
        assert_eq!(c.n, 9);
        assert!(approx(c.rate.unwrap(), 5.0 / 9.0));
        assert!(approx(c.apply(Some(-2.0)).unwrap(), 0.22082030636303676));
        assert!(approx(c.apply(Some(0.0)).unwrap(), 0.56842493568537655));
        assert!(approx(c.apply(Some(2.0)).unwrap(), 0.85957300694451966));
        assert!(c.apply(Some(2.0)).unwrap() > c.apply(Some(0.0)).unwrap());
        assert!(c.apply(Some(0.0)).unwrap() > c.apply(Some(-2.0)).unwrap());

        // Weights change the fit (the events weighted ×3 — the package's own
        // check on a bigger sample; pinned here on the same 9-vector).
        let w3: Vec<f64> = label
            .iter()
            .map(|y| if *y == Some(1.0) { 3.0 } else { 1.0 })
            .collect();
        let cw = fit_conversion(&risk, &label, &w3);
        assert_eq!(cw.kind(), ConversionKind::Logistic);
        assert!(approx(cw.a, 1.5708711485883229));
        assert!(approx(cw.b, 0.95318676445032269));
        assert!(approx(cw.mu, 0.26315789473684209));
        assert!(approx(cw.rate.unwrap(), 15.0 / 19.0));

        // A score that falls with the event gives the event rate — never a
        // falling probability.
        let falling_label: Vec<Option<f64>> = [1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]
            .map(Some)
            .to_vec();
        let cf = fit_conversion(&risk, &falling_label, &[1.0; 9]);
        assert_eq!(cf.kind(), ConversionKind::Constant);
        assert!(approx(cf.rate.unwrap(), 4.0 / 9.0));
        assert_eq!(cf.apply(Some(-1.0)), cf.apply(Some(1.0)));

        // Missing labels / non-positive weights are dropped (the package's
        // filter); the two kept points separate so the anti-solution is
        // refused → the constant fallback.
        let mixed = fit_conversion(
            &[Some(1.0), None, Some(3.0), None, Some(5.0)],
            &[Some(1.0), Some(1.0), None, Some(0.0), Some(0.0)],
            &[1.0, 1.0, 1.0, 0.0, 1.0],
        );
        assert_eq!(mixed.kind(), ConversionKind::Constant);
        assert_eq!(mixed.n, 2);
        assert!(approx(mixed.mu, 3.0));
        assert!(approx(mixed.rate.unwrap(), 0.5));
    }

    /// The conversion record's JSON is the package's `{kind, a, b, mu, sd, n,
    /// rate}` shape (the model-record round trip, `core_test.cpp`'s check) —
    /// and `rate: null` when no patient was usable.
    #[test]
    fn conversion_json_round_trips_in_the_package_shape() {
        let c = fit_conversion(
            &[Some(1.0), Some(2.0), Some(3.0)],
            &[Some(1.0), Some(0.0), Some(1.0)],
            &[1.0, 1.0, 1.0],
        );
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"kind": "constant", "a": 0.0, "b": 0.0, "mu": 2.0, "sd": 1.0, "n": 3, "rate": 2.0 / 3.0})
        );
        let back: Conversion = serde_json::from_value(v).unwrap();
        assert_eq!(back, c);
        assert_eq!(
            conversion_key("progression", Some(238.0)),
            "progression@238"
        );
        assert_eq!(conversion_key("death", Some(238.5)), "death@238.5");
        assert_eq!(conversion_key("no_response", None), "no_response");

        let none = fit_conversion(&[None, None], &[Some(1.0), Some(0.0)], &[1.0, 1.0]);
        assert_eq!(
            serde_json::to_value(&none).unwrap()["rate"],
            serde_json::Value::Null
        );
    }

    /// TEST-EE-16 half 3: the calibration band is fitted on the TRAINING side
    /// only — the survival arm reads the IPCW labels from the written
    /// `outcomes.csv` (the package's arm on its own hand-computed example),
    /// and the map is one conversion, keyed per (outcome, horizon).
    #[test]
    fn fit_recalibration_uses_the_ipcw_training_labels() {
        let outcomes = csv(
            &[
                "patient_id",
                "pfs_time",
                "pfs_event",
                "os_time",
                "os_event",
                "no_response",
            ],
            &[
                &["P0001", "1", "1", "", "", "1"],
                &["P0002", "2", "0", "", "", "0"],
                &["P0003", "3", "1", "", "", "1"],
                &["P0004", "4", "0", "", "", "0"],
                &["P0005", "5", "1", "", "", "0"],
                &["P0006", "6", "0", "", "", "1"],
            ],
        );
        let outcomes_table = parse_csv(&outcomes).expect("the fixture parses");
        let own: Vec<String> = vec!["risk".into()];
        let spec = risk_only_spec("dyn", &own);
        let risks: BTreeMap<String, Option<f64>> = [
            ("P0001", Some(1.0)),
            ("P0002", Some(2.0)),
            ("P0003", Some(3.0)),
            ("P0004", Some(4.0)),
            ("P0005", Some(5.0)),
            ("P0006", Some(6.0)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let c = fit_recalibration(&spec, &outcomes_table, &risks, "progression", Some(4.0))
            .expect("the IPCW band fits");
        // The package's own output for the same construction: the four kept
        // patients (events at 1, 3; beyond-h at 5, 6) fit a FALLING relation
        // (risks 1,3,5,6 with labels 1,1,0,0) → the weighted event rate.
        assert_eq!(c.kind(), ConversionKind::Constant);
        assert_eq!(c.n, 4);
        assert!(approx(c.mu, 4.2291666666666652));
        assert!(approx(c.rate.unwrap(), 0.375));
        assert!(
            c.apply(Some(5.0)).unwrap() <= c.apply(Some(1.0)).unwrap() + 1e-12,
            "the falling band is the rate, never a rising-then-falling curve"
        );

        // The same construction against the response labels (weight 1) — the
        // map is per outcome: no_response is its own conversion.
        let c2 = fit_recalibration(&spec, &outcomes_table, &risks, "no_response", None).unwrap();
        assert_eq!(c2.n, 6);
        assert_eq!(c2.kind(), ConversionKind::Constant); // nearly falling
        assert_eq!(conversion_key("no_response", None), "no_response");
    }

    /// TEST-EE-16 half 4: the `fitted: true` arm — the map the orchestrator
    /// fits for a fitted method is built on the INNER 3-FOLD OUT-OF-FOLD
    /// risks: the fold partition is the package's (`crossfit_folds`), the
    /// per-fold risks are the caller's v1 calls, and the fitted conversion is
    /// exactly the one `fit_conversion` produces on those (risk, label)
    /// pairs — never on a different ranking.
    #[test]
    fn fitted_cross_fit_arm_fits_the_oof_risks() {
        let ids: Vec<String> = (0..9).map(|i| format!("S000{i}")).collect();
        let labels: Vec<f64> = [1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0].to_vec();
        let outcomes = csv(
            &["patient_id", "no_response"],
            &[
                &["S0000", "1"],
                &["S0001", "0"],
                &["S0002", "1"],
                &["S0003", "0"],
                &["S0004", "1"],
                &["S0005", "0"],
                &["S0006", "1"],
                &["S0007", "0"],
                &["S0008", "1"],
            ],
        );
        let outcomes_table = parse_csv(&outcomes).expect("the fixture parses");

        let folds = crossfit_folds(9, 1, CROSS_FIT_FOLDS);
        assert_eq!(folds, vec![0, 1, 1, 2, 2, 2, 1, 0, 0]);
        // The per-fold partition, in the outcomes.csv order: fold k = the
        // positions whose fold is k (every shuffle position's every-3rd).
        for k in 0..3usize {
            let members: Vec<usize> = (0..9).filter(|i| folds[*i] == k).collect();
            assert!(!members.is_empty(), "fold {k} is non-empty");
        }

        // The OOF risks of the per-fold runs (each fold's patients were
        // scored by the model trained on the REST — the fixture's numbers)
        // and the labels they were evaluated against.
        let oof: Vec<Option<f64>> = [
            Some(0.9),
            Some(0.2),
            Some(1.1),
            Some(0.3),
            Some(1.2),
            Some(0.35),
            Some(1.05),
            Some(0.15),
            Some(0.25),
        ]
        .to_vec();
        let oof_map: BTreeMap<String, Option<f64>> = ids
            .iter()
            .zip(&oof)
            .map(|(id, r)| (id.clone(), *r))
            .collect();
        let own: Vec<String> = vec!["risk".into()];
        let spec = risk_only_spec("fitted-method", &own);
        let fitted = fit_recalibration(&spec, &outcomes_table, &oof_map, "no_response", None)
            .expect("the OOF arm fits");
        let direct = fit_conversion(
            &oof,
            &labels.iter().map(|y| Some(*y)).collect::<Vec<_>>(),
            &[1.0; 9],
        );
        assert_eq!(fitted, direct, "one map over the union of OOF risks");
        assert_eq!(fitted.n, 9);
        assert_eq!(fitted.kind(), ConversionKind::Logistic);

        // A different ranking moves the map (the map is the OOF risks the
        // engine was given, never a recomputed one).
        let shifted: Vec<Option<f64>> = oof.iter().map(|r| r.map(|x| x + 0.5)).collect();
        let shifted_map: BTreeMap<String, Option<f64>> = ids
            .iter()
            .zip(&shifted)
            .map(|(id, r)| (id.clone(), *r))
            .collect();
        let moved =
            fit_recalibration(&spec, &outcomes_table, &shifted_map, "no_response", None).unwrap();
        assert_ne!(fitted.mu, moved.mu, "a shifted ranking must move the map");
        assert_ne!(fitted, moved);
    }

    /// TEST-EE-16 half 5: the failure typing — a method that declares a
    /// native probability is NEVER converted (INV-3's never-mixed rule, with
    /// the named column), and no usable (risk, label) pair is
    /// `RECALIBRATION_FAILED`, not an all-empty column (a single-value risk
    /// is NOT a failure — it is the package's constant/rate map; the
    /// plan's v1.2 "unrankable" wording is superseded by DRIFT-2).
    #[test]
    fn fit_recalibration_failure_typing() {
        let outcomes = csv(
            &[
                "patient_id",
                "pfs_time",
                "pfs_event",
                "os_time",
                "os_event",
                "no_response",
            ],
            &[
                &["P0001", "20", "1", "30", "0", "1"],
                &["P0002", "25", "0", "40", "1", "0"],
                &["P0003", "60", "1", "70", "0", "1"],
            ],
        );
        let outcomes_table = parse_csv(&outcomes).expect("the fixture parses");
        let own: Vec<String> = vec!["risk".into()];
        let spec = risk_only_spec("dyn", &own);
        let risks: BTreeMap<String, Option<f64>> = [
            ("P0001", Some(0.5)),
            ("P0002", Some(0.6)),
            ("P0003", Some(0.7)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();

        // A native probability → refusal, with the column named.
        let own: Vec<String> = vec!["risk".into(), "p_progression_H*".into()];
        let native = PredictionSpec {
            method_id: "native",
            own_outputs: &own,
            group: MethodGroup::DynamicRisk,
            constant_ok: None,
        };
        let err = fit_recalibration(&native, &outcomes_table, &risks, "progression", Some(238.0))
            .expect_err("a native column is never converted");
        assert_eq!(
            err,
            CalibrationError::NativeProbability {
                method_id: "native".to_string(),
                column: "p_progression_H238".to_string()
            }
        );
        assert_eq!(err.engine_code(), EngineReasonCode::RecalibrationFailed);
        assert!(err.detail().contains("p_progression_H238"));

        // No training score at all → RECALIBRATION_FAILED.
        let empty: BTreeMap<String, Option<f64>> = BTreeMap::new();
        let err = fit_recalibration(&spec, &outcomes_table, &empty, "no_response", None)
            .expect_err("no usable pair is a refusal");
        assert_eq!(
            err,
            CalibrationError::NoUsableTrainingData {
                method_id: "dyn".to_string(),
                outcome: "no_response".to_string(),
                horizon: None
            }
        );
        assert_eq!(err.engine_code(), EngineReasonCode::RecalibrationFailed);
        assert!(err.detail().contains("no training score"));

        // A single-value risk is the package's constant map, not a failure.
        let flat: BTreeMap<String, Option<f64>> = [
            ("P0001", Some(0.5)),
            ("P0002", Some(0.5)),
            ("P0003", Some(0.5)),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let c = fit_recalibration(&spec, &outcomes_table, &flat, "no_response", None).unwrap();
        assert_eq!(c.kind(), ConversionKind::Constant);
        assert!(approx(c.rate.unwrap(), 2.0 / 3.0));
    }

    /// The converted rows: the map is applied to the scored risks only, an
    /// abstained patient keeps its note and no probability, and a native
    /// value is never overwritten (the caller passes `native_column: None`
    /// methods only — one source per column).
    #[test]
    fn converted_rows_apply_the_map_and_keep_abstentions() {
        let c = Conversion {
            kind: "logistic".to_string(),
            a: 0.0,
            b: 1.0,
            mu: 0.0,
            sd: 1.0,
            n: 10,
            rate: Some(0.5),
        };
        let rows = vec![
            PredictionRow {
                patient_id: "T0001".to_string(),
                risk: Some(2.0),
                probability: None,
                note: String::new(),
            },
            PredictionRow {
                patient_id: "T0002".to_string(),
                risk: None,
                probability: None,
                note: "no value at the landmark".to_string(),
            },
            PredictionRow {
                patient_id: "T0003".to_string(),
                risk: Some(-1.0),
                probability: Some(0.9), // a native value: never overwritten
                note: String::new(),
            },
        ];
        let out = converted_rows(&c, &rows);
        assert!(approx(
            out[0].probability.unwrap(),
            1.0 / (1.0 + (-2.0f64).exp())
        ));
        assert_eq!(out[1].probability, None);
        assert_eq!(out[1].note, "no value at the landmark");
        assert!(approx(out[2].probability.unwrap(), 0.9), "native kept");
        // A constant map gives its rate for every score.
        let rate = Conversion {
            kind: "constant".to_string(),
            a: 0.0,
            b: 0.0,
            mu: 0.0,
            sd: 1.0,
            n: 10,
            rate: Some(0.4),
        };
        let out = converted_rows(&rate, &rows);
        assert!(approx(out[0].probability.unwrap(), 0.4));
        assert_eq!(out[1].probability, None);
        // Coverage recomputes over the converted rows (the plan's finalize).
        let cov = coverage(&out);
        assert_eq!((cov.scored, cov.eligible), (2, 3));
    }

    // ── the saved conversions (the package's `model.conversions`) ──────────

    fn logistic(a: f64, b: f64) -> Conversion {
        Conversion {
            kind: "logistic".to_string(),
            a,
            b,
            mu: 1.0,
            sd: 2.0,
            n: 40,
            rate: Some(0.3),
        }
    }

    fn flat(rate: Option<f64>) -> Conversion {
        Conversion {
            kind: "constant".to_string(),
            a: 0.0,
            b: 0.0,
            mu: 1.0,
            sd: 1.0,
            n: 40,
            rate,
        }
    }

    /// The key + value rules of `model.schema.json`, each refusal naming the
    /// key it found.
    #[test]
    fn check_conversions_accepts_the_package_shape_and_names_bad_entries() {
        let ok = Conversions::from([
            ("progression@238".to_string(), logistic(-0.5, 1.2)),
            ("death@238.5".to_string(), flat(Some(0.2))),
            ("no_response".to_string(), flat(None)),
            ("progressive_disease".to_string(), logistic(0.0, 0.0)),
        ]);
        assert_eq!(check_conversions(&ok), Ok(()));
        assert_eq!(check_conversions(&Conversions::new()), Ok(()));

        let bad_values = [
            (Conversion { a: f64::NAN, ..logistic(0.0, 1.0) }, "a is not a finite number"),
            (Conversion { mu: f64::INFINITY, ..logistic(0.0, 1.0) }, "mu is not a finite number"),
            (Conversion { sd: 0.0, ..logistic(0.0, 1.0) }, "sd is not a finite number above 0"),
            (Conversion { sd: -1.0, ..logistic(0.0, 1.0) }, "sd is not a finite number above 0"),
            (logistic(0.0, -0.1), "b is negative"),
            (Conversion { n: -1, ..logistic(0.0, 1.0) }, "n is negative"),
            (flat(Some(1.5)), "rate is not within [0, 1]"),
            (Conversion { kind: "spline".to_string(), ..logistic(0.0, 1.0) }, "kind \"spline\" is not logistic or constant"),
        ];
        for (c, problem) in bad_values {
            let map = Conversions::from([("progression@238".to_string(), c)]);
            assert_eq!(
                check_conversions(&map),
                Err(ConversionProblem {
                    key: "progression@238".to_string(),
                    problem: problem.to_string()
                })
            );
        }
        for key in [
            "progression",
            "death@-5",
            "death@0",
            "progression@238.0",
            "progression@abc",
            "foo@238",
            "no_response@238",
            "",
        ] {
            let map = Conversions::from([(key.to_string(), logistic(0.0, 1.0))]);
            let err = check_conversions(&map).expect_err(key);
            assert_eq!(err.key, key, "the refused key is named");
        }
    }

    /// The run-dir record: write → read is the same map; no file is "none
    /// recorded"; a broken file is an error naming the file.
    #[test]
    fn conversions_file_round_trips_and_a_missing_file_is_empty() {
        let run_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/txr-execution-engine-conversions")
            .join(uuid::Uuid::new_v4().simple().to_string());
        let map = Conversions::from([("progression@238".to_string(), logistic(-0.25, 0.75))]);
        write_conversions(&run_dir, "m-a", &map).expect("writes");
        assert_eq!(read_conversions(&run_dir, "m-a"), Ok(map.clone()));
        let text =
            std::fs::read_to_string(run_dir.join("output/m-a").join(CONVERSIONS_FILE)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"progression@238": {"kind": "logistic", "a": -0.25, "b": 0.75,
                "mu": 1.0, "sd": 2.0, "n": 40, "rate": 0.3}}),
            "the package's map shape"
        );
        assert_eq!(read_conversions(&run_dir, "m-none"), Ok(Conversions::new()));

        std::fs::create_dir_all(run_dir.join("output/m-bad")).unwrap();
        std::fs::write(run_dir.join("output/m-bad").join(CONVERSIONS_FILE), "{not json").unwrap();
        let err = read_conversions(&run_dir, "m-bad").expect_err("bad JSON");
        assert!(err.contains("m-bad"), "{err}");
        std::fs::write(
            run_dir.join("output/m-bad").join(CONVERSIONS_FILE),
            r#"{"progression": {"kind": "logistic", "a": 0, "b": 1, "mu": 0, "sd": 1, "n": 3, "rate": 0.5}}"#,
        )
        .unwrap();
        let err = read_conversions(&run_dir, "m-bad").expect_err("bad key");
        assert!(err.contains("\"progression\""), "{err}");
        let _ = std::fs::remove_dir_all(&run_dir);
    }

    #[test]
    fn conversion_labels_read_plainly() {
        assert_eq!(conversion_label("progression@238"), "progression at 238 days");
        assert_eq!(conversion_label("death@238.5"), "death at 238.5 days");
        assert_eq!(conversion_label("no_response"), "no response");
    }

    /// The predict-only reuse rule: the matching key converts every scored
    /// patient (an abstention keeps its note); no map / another key / a
    /// rate-less flat map give no chances and a note saying why.
    #[test]
    fn saved_conversion_rows_apply_the_matching_key() {
        let rows = || {
            vec![
                PredictionRow {
                    patient_id: "T0001".to_string(),
                    risk: Some(3.0),
                    probability: None,
                    note: String::new(),
                },
                PredictionRow {
                    patient_id: "T0002".to_string(),
                    risk: None,
                    probability: None,
                    note: "no value at the landmark".to_string(),
                },
                PredictionRow {
                    patient_id: "T0003".to_string(),
                    risk: Some(-1.0),
                    probability: None,
                    note: String::new(),
                },
            ]
        };
        let c = logistic(-0.5, 1.5);
        let map = Conversions::from([("progression@238".to_string(), c.clone())]);
        let hit = saved_conversion_rows(&map, "progression", Some(238.0), rows());
        assert_eq!(hit.prob_source, super::super::types::TxrProbSource::Converted);
        assert_eq!(hit.applied, Some(("progression@238".to_string(), c.clone())));
        assert!(approx(hit.rows[0].probability.unwrap(), c.apply(Some(3.0)).unwrap()));
        assert!(approx(hit.rows[2].probability.unwrap(), c.apply(Some(-1.0)).unwrap()));
        assert_eq!(hit.rows[1].probability, None);
        assert_eq!(hit.rows[1].note, "no value at the landmark");
        assert_eq!(coverage(&hit.rows).scored, 2);

        let old = saved_conversion_rows(&Conversions::new(), "progression", Some(238.0), rows());
        assert_eq!(old.prob_source, super::super::types::TxrProbSource::None);
        assert_eq!(old.applied, None);
        assert!(old.rows.iter().all(|r| r.probability.is_none()));
        assert_eq!(
            old.rows[0].note,
            "no native probability, and this saved model has no score-to-chance conversion (it was saved before the app kept one)"
        );
        assert_eq!(old.rows[1].note, "no value at the landmark", "an abstention keeps its own note");

        let other = saved_conversion_rows(&map, "death", Some(365.0), rows());
        assert_eq!(other.prob_source, super::super::types::TxrProbSource::None);
        assert_eq!(
            other.rows[2].note,
            "no native probability, and this saved model's score-to-chance conversion is for progression at 238 days, not death at 365 days"
        );
        // The horizon is part of the key: the same outcome at another day
        // does not match either.
        let day = saved_conversion_rows(&map, "progression", Some(180.0), rows());
        assert_eq!(day.prob_source, super::super::types::TxrProbSource::None);

        let rateless = Conversions::from([("no_response".to_string(), flat(None))]);
        let none = saved_conversion_rows(&rateless, "no_response", None, rows());
        assert_eq!(none.prob_source, super::super::types::TxrProbSource::None);
        assert_eq!(
            none.rows[0].note,
            "no native probability, and this saved model's score-to-chance conversion has no event rate"
        );
        // A flat map with a rate converts (every scored patient gets it).
        let rated = Conversions::from([("no_response".to_string(), flat(Some(0.25)))]);
        let out = saved_conversion_rows(&rated, "no_response", None, rows());
        assert_eq!(out.prob_source, super::super::types::TxrProbSource::Converted);
        assert_eq!(out.rows[0].probability, Some(0.25));
        assert!(out.applied.as_ref().unwrap().1.is_flat());
        assert!(!c.is_flat());
    }

    /// TEST-EE-22 (ITEM-6 fixtures): the new fixtures are synthetic in-test
    /// constructs — ids `S0000..`/`P0001..`, every number a literal, no
    /// data-folder path.
    #[test]
    fn item6_fixtures_are_synthetic_in_test_constructs() {
        let synthetic = |id: &str| {
            id.len() == 5
                && (id.starts_with('S') || id.starts_with('P'))
                && id[1..].chars().all(|c| c.is_ascii_digit())
        };
        for id in ["S0000", "S0008", "P0001", "P0006"] {
            assert!(synthetic(id), "{id} is a synthetic id");
        }
        assert!(!synthetic("Q0001"), "a non-fixture letter is refused");
    }
}
