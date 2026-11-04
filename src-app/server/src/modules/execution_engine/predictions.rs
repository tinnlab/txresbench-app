//! The method output — `predictions.rs` (PLAN ITEM-5, re-pinned by DRIFT-2
//! to package contract 2.0): parse + validate `/output/predictions.csv` and
//! `/output/run.json`, and resolve the per-method "chance" column, the
//! per-patient abstention notes and the coverage.
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
//!
//! Pure functions: text in, typed facts out — no I/O (ITEM-9 reads the
//! files); the CSV bytes are read with the module's own codec
//! ([`parse_csv`], the package's `table.cpp` port — no `csv` crate).

use std::collections::{BTreeMap, BTreeSet};

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
}
