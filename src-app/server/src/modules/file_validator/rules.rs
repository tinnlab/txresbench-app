//! The tidy-2.0 rule port — `rules.rs` (ITEM-3).
//!
//! The benchmark's one machine-readable dataset rule set
//! (`data/file-validator/tidy-2.0.json`, a byte-identical provenance copy of
//! `dev/code/benchmark/analysis-engine/contract/tidy/2.0.json`) is applied here
//! to the APP's two-file contract. INV-8: the app validates user files against
//! the same rule semantics the benchmark applies to its datasets — a user file
//! and a benchmark dataset meet the same rules. The reference implementation is
//! `dev/code/datasets/tools/validate_tidy.py`; this file is the Rust contract,
//! and the rule *semantics* are the port (the benchmark tree is never read at
//! run time — INV-1).
//!
//! ## The canonical model (DEC-4)
//!
//! The tidy four-table shape is a benchmark-internal canonical form; the app's
//! file contract is the two-table CSV/Excel shape (screen C: patients +
//! measurements; screen N: measurements only). The port runs over ONE
//! in-memory canonical model:
//!
//! - `patients` — the patients table (outcome columns + covariates);
//! - `values` — the measurements table (one row per patient x day x marker);
//! - `features` — the per-marker metadata table (the tidy `features` table
//!   folded into marker metadata — unit, id, companion flag — DEC-4);
//! - `samples` — DERIVED, never in the model: a sample is the distinct
//!   `(patient_id, day)` key of the value rows, with `day_source = "file"`
//!   (the app's measurements have no `sample_id`/`day_source`/position
//!   columns). Sample id = `"<patient_id>@<day>"`.
//!
//! The derivation makes the sample-shape rules honest without a fourth table:
//! R09 (every value row's sample exists), R11 (day agreement between values
//! and samples), R16 (a value row names the same patient as its sample) and
//! R17 (sample day null exactly when `day_source` is "unknown") hold BY
//! CONSTRUCTION — the derived sample's day and patient ARE the value row's.
//! They are still asserted: each has a check function that runs in
//! `validate_model` and returns no problem for any model the derivation can
//! produce, the derivation facts (unique keys, `day_source = "file"`, a
//! non-null day per sample) are pinned by tests (TEST-FV-3), and the registry
//! below declares them `HoldsByConstruction` with the written reason — never a
//! silent skip.
//!
//! One adapter, recorded everywhere: a value row whose day cell is not a
//! number is REPORTED (R03) and contributes no derived sample — the tidy rule
//! "a row whose day cannot be established is left out" becomes the app's
//! row-accurate report; a blank cell in a required column is R04.
//!
//! ## The rules and their app adaptation
//!
//! The tidy 2.0 set has 21 rule ids, R01–R21. R01 (tables present) and R21
//! (preview consistent) are DECLARED NOT APPLICABLE — the app has no
//! four-table Parquet shape (the two user tables are present by the request
//! contract) and no `preview/` files (the engine generates any preview from the
//! canonical rows). The remaining 19 are ported:
//!
//! | tidy rule | app port |
//! |---|---|
//! | R02 required columns | `patient_id` + the board's four outcome columns in a patients table; `patient_id, day, marker, value` in a measurements table (the outcome columns are REQUIRED per the owner decision on the board column set; `responder`/`response_day` stay optional) |
//! | R03 column types | ids/marker/unit are strings (ids stay strings even when numeric — the tidy type definition); day/value/response day are float64; event/responder are int64 (integral only) |
//! | R04 nullability | `patient_id`, `day`, `marker` and a present `time_unit` cell are NOT NULL; value, unit, outcomes and covariates are nullable |
//! | R05 allowed values | `pfs_event`/`os_event`/`responder` in {0,1}; the app has no `day_source`/position enumerations (derived, R09/R11/R16/R17) and `time_unit` is R12 |
//! | R06 minimum | outcome days ≥ 0 (pfs/os/response day) |
//! | R07 unique keys | `patient_id` unique; `(patient_id, day, marker)` unique (the derived-sample x feature key); `feature` unique |
//! | R08 values→patients FK | a measurement row whose patient is not in the patients table (files mode only — predict mode has no patients side) |
//! | R09 values→samples FK | by construction (derived) |
//! | R10 values→features FK | by construction (derived: the feature list is folded from the measurement rows themselves, so a value row's marker is always a described feature — a spelling variant the user has not joined is its own feature, see A03) |
//! | R11 day agreement | by construction (derived) |
//! | R12 single time unit | the app's columns are days; a present `time_unit` column must read `days` (anything else is R12) |
//! | R13 companion features | `<F>__detected` values in {0,1}, `<F>__lod` values ≥ 0, base `<F>` described |
//! | R14 outcome available | adapted severity: the benchmark's error becomes the app's WARNING when outcome columns exist but fewer than `Limits::R14_MIN_OUTCOME` patients have an outcome; the no-outcome-column case is the app's A02 error (DEC-7) |
//! | R15 samples→patients FK | a derived sample whose patient is not in the patients table (files mode) |
//! | R16 value/sample same patient | by construction (derived) |
//! | R17 unknown day iff null | by construction (derived: `day_source` is always "file", never "unknown") |
//! | R18 paired null | pfs and os time/event both-or-neither; the app adds the responder/response_day pair (DEC-7) |
//! | R19 outcome time positive | warning when an outcome time is exactly 0 (pfs/os; the response assessment day is not in the tidy R19 column list) |
//! | R20 day range | warning when a measurement day is outside [−180, 3650] |
//!
//! ## Row numbers (DEC-6)
//!
//! Every cell carries its FILE row (1-based, header included) and the user's
//! column spelling, so a problem is exactly the cell the user sees ("Row 14:
//! day is 'week 4'"). File-level facts (R14's count verdict) use `row: null`.
//!
//! ## The rule registry and the not-applicable record (TEST-FV-6)
//!
//! [`rule_declarations`] lists all 21 tidy ids with an applicability verdict:
//! every id is either `Implemented`, `HoldsByConstruction` (with the written
//! reason) or `NotApplicable` (with the written reason) — no id slips through
//! as an unmapped silent skip, and the tests fail the day a new tidy rule id
//! appears without a declaration. The check kinds are an EXHAUSTIVE enum
//! ([`RuleKind`], no `unimplemented!` arm): a kind the port does not handle is
//! a compile error here, before a response can omit it.
//!
//! All functions are pure: no I/O, no state, no timestamps — the same request
//! yields the same problem list (determinism is part of the contract).

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::modules::file_validator::types::{
    ColumnRole, FileProblem, FileTableKind, Limits, ProblemCode, ProblemSeverity,
};
use crate::modules::method_catalogue::eligibility::is_companion;

// ─────────────────────────────────────────────────────────────────────────────
// Name folding + the alias table (DEC-5)
// ─────────────────────────────────────────────────────────────────────────────

/// Fold a header name for alias matching: lowercase, `_`/`-` become a space,
/// whitespace runs collapse to one space, and the ends are trimmed. So
/// `"PFS_Days"`, `"pfs-days"` and `"Pfs Days"` all read as `"pfs days"`.
pub fn normalize_header_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut pending_space = false;
    for c in name.chars() {
        match c {
            '_' | '-' => {
                if !out.is_empty() {
                    pending_space = true;
                }
            },
            c if c.is_whitespace() => {
                if !out.is_empty() {
                    pending_space = true;
                }
            },
            c => {
                if pending_space {
                    out.push(' ');
                    pending_space = false;
                }
                out.push(c.to_ascii_lowercase());
            },
        }
    }
    out
}

const PATIENT_ID_ALIASES: &[&str] = &["patient id", "patientid"];
const PFS_DAYS_ALIASES: &[&str] = &["pfs days", "pfs time"];
const PFS_EVENT_ALIASES: &[&str] = &["pfs event"];
const OS_DAYS_ALIASES: &[&str] = &["os days", "os time"];
const OS_EVENT_ALIASES: &[&str] = &["os event"];
const RESPONDER_ALIASES: &[&str] = &["responder", "responder binary", "response binary"];
const RESPONSE_DAY_ALIASES: &[&str] = &[
    "response day",
    "response assessment day",
    "response assessment",
];
const DAY_ALIASES: &[&str] = &["day", "day from start", "dayfromstart", "days from start"];
const MARKER_ALIASES: &[&str] = &["marker", "feature"];
const VALUE_ALIASES: &[&str] = &["value"];
const UNIT_ALIASES: &[&str] = &["unit", "units"];
/// The app's known-by-name covariates (DEC-5: covariate columns are named by
/// name or by the tidy `cov_<name>` prefix; the template ships age/sex/stage).
const KNOWN_COVARIATE_NAMES: &[&str] = &["age", "sex", "stage", "ecog"];
/// R12's column, direct-name matched (the app has no `time_unit` role in the
/// alias table — a `time_unit` column is an allowed extra UNLESS it disagrees
/// with the app's days).
const TIME_UNIT_ALIASES: &[&str] = &["time unit", "timeunit"];

/// Whether a column is the R12 time-unit column (direct-name match, folded).
/// ITEM-5's model build uses this to populate the per-row `time_unit` cells
/// the R12 check reads; a column that does not match here is an extra.
pub fn is_time_unit_column(name: &str) -> bool {
    TIME_UNIT_ALIASES.contains(&normalize_header_name(name).as_str())
}

/// The column role a header name resolves to in one table (alias resolution,
/// DEC-5): case-insensitive, whitespace/`_`/`-`-folded, first alias wins in
/// file order (a second column resolving to the same role is an ambiguity the
/// inspect step reports as an unresolvable extra — the resolution here is
/// deterministic: first match).
pub fn resolve_column_role(name: &str, table: FileTableKind) -> Option<ColumnRole> {
    let n = normalize_header_name(name);
    match table {
        FileTableKind::Patients => {
            if PATIENT_ID_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::PatientId);
            }
            if PFS_DAYS_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::PfsDays);
            }
            if PFS_EVENT_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::PfsEvent);
            }
            if OS_DAYS_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::OsDays);
            }
            if OS_EVENT_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::OsEvent);
            }
            if RESPONDER_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::Responder);
            }
            if RESPONSE_DAY_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::ResponseDay);
            }
            if let Some(rest) = n.strip_prefix("cov ") {
                let cov = rest.trim().to_string();
                if !cov.is_empty() {
                    return Some(ColumnRole::Covariate(cov));
                }
            }
            if KNOWN_COVARIATE_NAMES.contains(&n.as_str()) {
                return Some(ColumnRole::Covariate(n));
            }
            None
        },
        FileTableKind::Measurements => {
            if PATIENT_ID_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::PatientId);
            }
            if DAY_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::Day);
            }
            if MARKER_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::Marker);
            }
            if VALUE_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::Value);
            }
            if UNIT_ALIASES.contains(&n.as_str()) {
                return Some(ColumnRole::Unit);
            }
            None
        },
    }
}

/// The roles a table MUST carry (R02). Patients: the board's four outcome
/// columns are required by the owner decision on the file column set
/// (D48: "optional response columns; four board columns required"),
/// `patient_id` is the key. Measurements: the four measurement columns;
/// `unit` stays optional (DEC-10, A07).
pub fn required_roles(table: FileTableKind) -> &'static [ColumnRole] {
    match table {
        FileTableKind::Patients => &[
            ColumnRole::PatientId,
            ColumnRole::PfsDays,
            ColumnRole::PfsEvent,
            ColumnRole::OsDays,
            ColumnRole::OsEvent,
        ],
        FileTableKind::Measurements => &[
            ColumnRole::PatientId,
            ColumnRole::Day,
            ColumnRole::Marker,
            ColumnRole::Value,
        ],
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The canonical model (DEC-4)
// ─────────────────────────────────────────────────────────────────────────────

/// One cell of the canonical model: the raw file text (the type checks read
/// it) plus its FILE row (1-based, header included — DEC-6) and the user's
/// column spelling. `text: null` is a blank cell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCell {
    pub text: Option<String>,
    pub row: u32,
    pub column: String,
}

impl ModelCell {
    /// A blank cell: null text, or whitespace-only text.
    pub fn blank(&self) -> bool {
        match self.text.as_deref() {
            None => true,
            Some(t) => t.trim().is_empty(),
        }
    }

    /// The non-blank trimmed text.
    pub fn text(&self) -> Option<&str> {
        self.text.as_deref().map(str::trim).filter(|t| !t.is_empty())
    }

    /// Parse the cell as a finite float64 (the tidy `float64` check: NaN is
    /// not a number in the schema). A blank cell is not a number — the
    /// nullability rule (R04) speaks for blanks.
    pub fn parse_f64(&self) -> Option<f64> {
        let t = self.text()?;
        match t.parse::<f64>() {
            Ok(v) if v.is_finite() => Some(v),
            _ => None,
        }
    }

    /// Parse the cell as an int64 (the tidy `int64` check): a finite float64
    /// with no fractional part, in the i64 range. `"2.0"` is an integer,
    /// `"1.5"` and `"week 4"` are not.
    pub fn parse_i64(&self) -> Option<i64> {
        let v = self.parse_f64()?;
        if v.fract() != 0.0 || v < i64::MIN as f64 || v > i64::MAX as f64 {
            return None;
        }
        Some(v as i64)
    }

    /// A located cell (blank when `text` is null).
    pub fn new(text: Option<String>, row: u32, column: String) -> ModelCell {
        ModelCell { text, row, column }
    }
}

/// The file-side shape facts of one table: the header row and the raw column
/// names (what R02's required-columns check and the A01/A02 checks resolve
/// against).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableShape {
    pub header_row: u32,
    pub columns: Vec<String>,
}

impl TableShape {
    pub fn new(header_row: u32, columns: Vec<String>) -> TableShape {
        TableShape { header_row, columns }
    }
}

/// One patients-table row of the canonical model. Every cell is located
/// (FILE row + user column spelling); the outcome cells are raw — the rules
/// decide presence, type and pairing, never the caller.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PatientRow {
    pub patient_id: ModelCell,
    pub pfs_days: ModelCell,
    pub pfs_event: ModelCell,
    pub os_days: ModelCell,
    pub os_event: ModelCell,
    pub responder: ModelCell,
    pub response_day: ModelCell,
    /// The `time_unit` cell when the file carries the column (R12); `None`
    /// means the column is absent, i.e. the app's implicit days.
    pub time_unit: Option<ModelCell>,
    pub covariates: Vec<(String, ModelCell)>,
}

/// One measurements-table row: patient x day x marker, with the optional unit
/// cell (`None` when the file has no unit column — DEC-10).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ValueRow {
    pub patient_id: ModelCell,
    pub day: ModelCell,
    pub marker: ModelCell,
    pub value: ModelCell,
    pub unit: Option<ModelCell>,
}

/// One features-table row (the tidy `features` table folded into per-marker
/// metadata, DEC-4): the feature name and its unit cell (`None` when the file
/// has no unit column).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FeatureRow {
    pub feature: ModelCell,
    pub unit: Option<ModelCell>,
}

/// A derived sample (DEC-4): the distinct `(patient_id, day)` key of the value
/// rows. `day_source` is always [`DAY_SOURCE_FILE`] — the app's measurements
/// carry no day-source column, so no derived sample is ever "unknown-day".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DerivedSample {
    pub patient_id: String,
    pub day: f64,
    pub day_source: String,
    /// The FILE row of the sample's first value row (the sample's report row).
    pub row: u32,
}

/// The derived samples' day source (the app's measurements are file-dated).
pub const DAY_SOURCE_FILE: &str = "file";

/// The canonical in-memory model the rules run over: patients + values +
/// features, plus the two tables' shape facts (column names + header row) so
/// the column rules (R02/A01/A02) resolve against the real file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanonicalModel {
    /// The patients table's shape; `None` in predict mode (screen N — no
    /// patients side).
    pub patients_shape: Option<TableShape>,
    pub measurements_shape: TableShape,
    /// The patients-table rows (empty in predict mode).
    pub patients: Vec<PatientRow>,
    pub values: Vec<ValueRow>,
    pub features: Vec<FeatureRow>,
}

impl CanonicalModel {
    /// Derive the samples: one per distinct `(patient_id, day)` key of the
    /// value rows, in file order of first appearance, `day_source = "file"`.
    /// A value row whose day cell is not a number (R03 reports it) contributes
    /// no sample — the tidy "a row whose day cannot be established is left
    /// out" adapter (documented in the module doc).
    pub fn derived_samples(&self) -> Vec<DerivedSample> {
        let mut seen = BTreeSet::new();
        let mut out = Vec::new();
        for row in &self.values {
            let (Some(patient), Some(day)) = (row.patient_id.text(), row.day.parse_f64()) else {
                continue;
            };
            let key = (patient.to_string(), day.to_bits());
            if seen.insert(key) {
                out.push(DerivedSample {
                    patient_id: patient.to_string(),
                    day,
                    day_source: DAY_SOURCE_FILE.to_string(),
                    row: row.day.row,
                });
            }
        }
        out
    }

    /// Whether the model carries the patients side (files mode).
    pub fn has_patients(&self) -> bool {
        self.patients_shape.is_some()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Problem helpers
// ─────────────────────────────────────────────────────────────────────────────

fn problem(code: ProblemCode, severity: ProblemSeverity, cell: &ModelCell, msg: String) -> FileProblem {
    FileProblem::new(code, severity, Some(cell.row), Some(cell.column.clone()), msg)
}

fn problem_row(
    code: ProblemCode,
    severity: ProblemSeverity,
    row: Option<u32>,
    column: Option<&str>,
    msg: String,
) -> FileProblem {
    FileProblem::new(code, severity, row, column.map(|c| c.to_string()), msg)
}

fn error_row(row: u32, column: &str, msg: String) -> FileProblem {
    problem_row(ProblemCode::R02RequiredColumns, ProblemSeverity::Error, Some(row), Some(column), msg)
}

// ─────────────────────────────────────────────────────────────────────────────
// A01 / A02 — the app's own file-level column verdicts
// ─────────────────────────────────────────────────────────────────────────────

/// A01 — no recognizable header: a table whose columns resolve to ZERO known
/// roles. The browser's header scan found no row that matches any required
/// alias (DEC-6), so the file's shape is not one the app can read; the problem
/// sits on the header row and asks whether row 1 is the header.
pub fn check_no_recognizable_header(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    if let Some(s) = &model.patients_shape {
        out.extend(check_no_recognizable_header_in(s, FileTableKind::Patients, "patients"));
    }
    out.extend(check_no_recognizable_header_in(
        &model.measurements_shape,
        FileTableKind::Measurements,
        "measurements",
    ));
    out
}

/// The A01 check for ONE table shape — the per-file inspect half (ITEM-5: a
/// dropped file is judged before the other file exists; the two-table
/// [`check_no_recognizable_header`] delegates here and runs both shapes).
pub fn check_no_recognizable_header_in(
    shape: &TableShape,
    kind: FileTableKind,
    table_name: &str,
) -> Vec<FileProblem> {
    let resolved = shape
        .columns
        .iter()
        .any(|c| resolve_column_role(c, kind).is_some());
    if resolved {
        return Vec::new();
    }
    vec![problem_row(
        ProblemCode::A01NoRecognizableHeader,
        ProblemSeverity::Error,
        Some(shape.header_row),
        None,
        format!(
            "no recognizable header in the {table_name} table: none of the {} column(s) matches a known name; is row {} the header?",
            shape.columns.len(),
            shape.header_row
        ),
    )]
}

/// R02 — required columns (the tidy `required_columns` kind). Every role in
/// [`required_roles`] must resolve; a missing role is one error per missing
/// role, on the header row, naming the canonical column.
pub fn check_required_columns(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    if let Some(s) = &model.patients_shape {
        out.extend(check_required_columns_in(s, FileTableKind::Patients, "patients"));
    }
    out.extend(check_required_columns_in(
        &model.measurements_shape,
        FileTableKind::Measurements,
        "measurements",
    ));
    out
}

/// The R02 check for ONE table shape — the per-file inspect half (ITEM-5: the
/// required set is judged per dropped file; [`check_required_columns`]
/// delegates here and runs both shapes).
pub fn check_required_columns_in(
    shape: &TableShape,
    kind: FileTableKind,
    table_name: &str,
) -> Vec<FileProblem> {
    let mut out = Vec::new();
    let resolved: BTreeSet<String> = shape
        .columns
        .iter()
        .filter_map(|c| resolve_column_role(c, kind).map(|r| r.wire_key()))
        .collect();
    for role in required_roles(kind) {
        let key = role.wire_key();
        if !resolved.contains(&key) {
            out.push(error_row(
                shape.header_row,
                &key,
                format!("required column `{key}` is missing from the {table_name} table"),
            ));
        }
    }
    out
}

/// A02 — no outcome column (the app's adaptation of the R14 no-outcome case,
/// DEC-7): a patients table carrying NONE of the three outcome column sets
/// (pfs, os, responder) cannot answer any outcome task. The four board columns
/// are also R02-required, so this verdict fires alongside the per-column R02
/// errors and names the file-level reason; `responder`/`response_day` optional
/// per the owner decision (D48).
///
/// The message lists EVERY required column (qa-fixes4 ITEM-5, help-r3's
/// accuracy table): following the advice must fix the R02 errors too — the old
/// "or responder + response_day" ending invited a set the board does not
/// require, and a patient table with only responder/response_day still carries
/// four R02 errors (the R02 check, not this one, is the authority on what the
/// board requires).
pub fn check_outcome_columns(model: &CanonicalModel) -> Vec<FileProblem> {
    let Some(shape) = &model.patients_shape else {
        return Vec::new();
    };
    let has = |aliases: &[&str]| {
        shape
            .columns
            .iter()
            .any(|c| aliases.contains(&normalize_header_name(c).as_str()))
    };
    let has_pfs = has(PFS_DAYS_ALIASES) || has(PFS_EVENT_ALIASES);
    let has_os = has(OS_DAYS_ALIASES) || has(OS_EVENT_ALIASES);
    let has_resp = has(RESPONDER_ALIASES) || has(RESPONSE_DAY_ALIASES);
    if has_pfs || has_os || has_resp {
        return Vec::new();
    }
    vec![problem_row(
        ProblemCode::A02RequiredColumnNotFound,
        ProblemSeverity::Error,
        Some(shape.header_row),
        None,
        "no outcome column: the patients table has none of the outcome columns the app requires — the required columns are patient_id, pfs_days, pfs_event, os_days and os_event (responder and response_day are extra)".to_string(),
    )]
}

// ─────────────────────────────────────────────────────────────────────────────
// The row-level tidy rules (R03..R20)
// ─────────────────────────────────────────────────────────────────────────────

/// R03 — column types. Ids, marker and unit are strings (a numeric-looking id
/// is still a string — the tidy type definition); day, value and the outcome
/// times are float64; the event/responder columns are int64 (integral only).
/// Rows with a non-numeric day (the board's "day is 'week 4'") are reported
/// here and contribute no derived sample.
pub fn check_column_types(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for row in &model.patients {
        let cols = [
            ("pfs_days", &row.pfs_days),
            ("os_days", &row.os_days),
            ("response_day", &row.response_day),
        ];
        for (name, cell) in cols {
            if !cell.blank() && cell.parse_f64().is_none() {
                out.push(problem(
                    ProblemCode::R03ColumnTypes,
                    ProblemSeverity::Error,
                    cell,
                    format!("`{}` is not a number in the {name} column", cell.text().unwrap_or("")),
                ));
            }
        }
        let ints = [
            ("pfs_event", &row.pfs_event),
            ("os_event", &row.os_event),
            ("responder", &row.responder),
        ];
        for (name, cell) in ints {
            if !cell.blank() && cell.parse_i64().is_none() {
                out.push(problem(
                    ProblemCode::R03ColumnTypes,
                    ProblemSeverity::Error,
                    cell,
                    format!("`{}` is not an integer in the {name} column", cell.text().unwrap_or("")),
                ));
            }
        }
    }
    for row in &model.values {
        if !row.day.blank() && row.day.parse_f64().is_none() {
            out.push(problem(
                ProblemCode::R03ColumnTypes,
                ProblemSeverity::Error,
                &row.day,
                format!("`{}` is not a number in the day column", row.day.text().unwrap_or("")),
            ));
        }
        if !row.value.blank() && row.value.parse_f64().is_none() {
            out.push(problem(
                ProblemCode::R03ColumnTypes,
                ProblemSeverity::Error,
                &row.value,
                format!("`{}` is not a number in the value column", row.value.text().unwrap_or("")),
            ));
        }
    }
    out
}

/// R04 — nullability: `patient_id`, `day` and `marker` are NOT NULL; `value`,
/// `unit`, the outcome columns and covariates are nullable (missing units are
/// A07's business, missing outcome times R18's). A present `time_unit` column
/// is NOT NULL too (a blank cell is R04, a non-`days` value R12).
pub fn check_nullability(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for row in &model.patients {
        let cells = [("patient_id", &row.patient_id)];
        for (_, cell) in cells {
            if cell.blank() {
                out.push(problem(
                    ProblemCode::R04Nullability,
                    ProblemSeverity::Error,
                    cell,
                    "empty cell in a required (not-null) column".to_string(),
                ));
            }
        }
        if let Some(tu) = &row.time_unit {
            if tu.blank() {
                out.push(problem(
                    ProblemCode::R04Nullability,
                    ProblemSeverity::Error,
                    tu,
                    "empty cell in the time_unit column (the column may be absent, but a present cell must be `days`)".to_string(),
                ));
            }
        }
    }
    for row in &model.values {
        let cells = [("patient_id", &row.patient_id), ("day", &row.day), ("marker", &row.marker)];
        for (_, cell) in cells {
            if cell.blank() {
                out.push(problem(
                    ProblemCode::R04Nullability,
                    ProblemSeverity::Error,
                    cell,
                    "empty cell in a required (not-null) column".to_string(),
                ));
            }
        }
    }
    out
}

/// R05 — allowed values: `pfs_event`, `os_event` and `responder` are binary
/// (0/1). The app has no position/source enumerations (derived, R09/R11/R16/
/// R17) and no `best_response_recist` column (a plain free-text extra at
/// worst); `time_unit` values are R12's.
pub fn check_allowed_values(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for row in &model.patients {
        let cols = [
            ("pfs_event", &row.pfs_event),
            ("os_event", &row.os_event),
            ("responder", &row.responder),
        ];
        for (name, cell) in cols {
            if let Some(v) = cell.parse_i64() {
                if v != 0 && v != 1 {
                    out.push(problem(
                        ProblemCode::R05AllowedValues,
                        ProblemSeverity::Error,
                        cell,
                        format!("{name} value `{v}` is not 0 or 1"),
                    ));
                }
            }
        }
    }
    out
}

/// R06 — minimum: outcome days are ≥ 0 (the tidy minimum for outcome times;
/// the response assessment day carries the same minimum per DEC-7).
pub fn check_ranges(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for row in &model.patients {
        let cols = [
            ("pfs_days", &row.pfs_days),
            ("os_days", &row.os_days),
            ("response_day", &row.response_day),
        ];
        for (name, cell) in cols {
            if let Some(v) = cell.parse_f64() {
                if v < 0.0 {
                    out.push(problem(
                        ProblemCode::R06Ranges,
                        ProblemSeverity::Error,
                        cell,
                        format!("{name} value `{v}` is below the minimum 0"),
                    ));
                }
            }
        }
    }
    out
}

/// R07 — unique keys: `patient_id` in the patients table;
/// `(patient_id, day, marker)` in the measurements table (the
/// derived-sample × feature key); `feature` in the features table. A group of
/// size ≥ 2 reports one problem per occurrence AFTER the first (the first
/// occurrence is the reference), and every message names all rows of the
/// group. Rows whose day does not parse are R03's report and take no part in
/// the key (the "left out" adapter).
pub fn check_unique_keys(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    // patient_id (positions are the rows the message names).
    let mut groups: Vec<(String, Vec<u32>)> = Vec::new();
    for row in &model.patients {
        if let Some(pid) = row.patient_id.text() {
            push_group(&mut groups, pid.to_string(), row.patient_id.row);
        }
    }
    for (pid, rows) in groups {
        if rows.len() >= 2 {
            for &row in rows.iter().skip(1) {
                out.push(problem_row(
                    ProblemCode::R07UniqueKeys,
                    ProblemSeverity::Error,
                    Some(row),
                    Some("patient_id"),
                    format!("duplicate patient_id `{pid}` (rows {})", join_rows(&rows)),
                ));
            }
        }
    }
    // (patient_id, day, marker).
    let mut key_groups: Vec<(String, Vec<u32>)> = Vec::new();
    for row in &model.values {
        let (Some(pid), Some(day), Some(marker)) =
            (row.patient_id.text(), row.day.parse_f64(), row.marker.text())
        else {
            continue;
        };
        let key = format!("{pid} @ {day} @ {marker}");
        push_group(&mut key_groups, key, row.day.row);
    }
    for (key, rows) in key_groups {
        if rows.len() >= 2 {
            for &row in rows.iter().skip(1) {
                out.push(problem_row(
                    ProblemCode::R07UniqueKeys,
                    ProblemSeverity::Error,
                    Some(row),
                    Some("patient_id, day, marker"),
                    format!("duplicate (patient_id, day, marker) key `{key}` (rows {})", join_rows(&rows)),
                ));
            }
        }
    }
    // features.
    let mut feat_groups: Vec<(String, Vec<u32>)> = Vec::new();
    for row in &model.features {
        if let Some(f) = row.feature.text() {
            push_group(&mut feat_groups, f.to_string(), row.feature.row);
        }
    }
    for (f, rows) in feat_groups {
        if rows.len() >= 2 {
            for &row in rows.iter().skip(1) {
                out.push(problem_row(
                    ProblemCode::R07UniqueKeys,
                    ProblemSeverity::Error,
                    Some(row),
                    Some("feature"),
                    format!("duplicate feature `{f}` (rows {})", join_rows(&rows)),
                ));
            }
        }
    }
    out
}

fn push_group(groups: &mut Vec<(String, Vec<u32>)>, key: String, row: u32) {
    match groups.iter_mut().find(|(k, _)| *k == key) {
        Some((_, rows)) => rows.push(row),
        None => groups.push((key, vec![row])),
    }
}

fn join_rows(rows: &[u32]) -> String {
    rows.iter()
        .map(|r| r.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// R08 + R15 + R09 + R10 — the foreign-key family of the derived shape:
/// measurements → patients (R08, per value row), derived samples → patients
/// (R15, per sample), measurements → derived samples (R09, by construction)
/// and measurements → features (R10, per value row — the feature list is
/// folded from the same rows, so also by construction; the check still runs
/// and stays silent, the registry's written proof). R08/R15 only exist in
/// files mode (predict mode has no patients side).
pub fn check_foreign_keys(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    let patient_ids: BTreeSet<String> = model
        .patients
        .iter()
        .filter_map(|r| r.patient_id.text().map(|t| t.to_string()))
        .collect();
    if model.has_patients() {
        for row in &model.values {
            if let Some(pid) = row.patient_id.text() {
                if !patient_ids.contains(pid) {
                    out.push(problem(
                        ProblemCode::R08ValuesPatientExists,
                        ProblemSeverity::Error,
                        &row.patient_id,
                        format!("`{pid}` is not in the patients table"),
                    ));
                }
            }
        }
        for sample in model.derived_samples() {
            if !patient_ids.contains(&sample.patient_id) {
                out.push(problem_row(
                    ProblemCode::R15SamplesPatientExists,
                    ProblemSeverity::Error,
                    Some(sample.row),
                    Some("patient_id"),
                    format!(
                        "derived sample `{} @ {}` is not in the patients table",
                        sample.patient_id, sample.day
                    ),
                ));
            }
        }
    }
    let sample_keys: BTreeSet<(String, u64)> = model
        .derived_samples()
        .iter()
        .map(|s| (s.patient_id.clone(), s.day.to_bits()))
        .collect();
    for row in &model.values {
        let (Some(pid), Some(day)) = (row.patient_id.text(), row.day.parse_f64()) else {
            continue;
        };
        if !sample_keys.contains(&(pid.to_string(), day.to_bits())) {
            out.push(problem(
                ProblemCode::R09ValuesSampleExists,
                ProblemSeverity::Error,
                &row.day,
                format!("the sample of `{pid}` at day `{day}` is not in the derived sample set"),
            ));
        }
    }
    let feature_names: BTreeSet<String> = model
        .features
        .iter()
        .filter_map(|f| f.feature.text().map(|t| t.to_string()))
        .collect();
    for row in &model.values {
        if let Some(marker) = row.marker.text() {
            if !feature_names.contains(marker) {
                out.push(problem(
                    ProblemCode::R10FeatureDescribed,
                    ProblemSeverity::Error,
                    &row.marker,
                    format!("`{marker}` is not described in the features table"),
                ));
            }
        }
    }
    out
}

/// R11 + R16 — the value↔sample join equality of the derived shape, BOTH by
/// construction (a derived sample IS the value row's (patient, day) key):
/// every value row's day agrees with its sample's day within the tidy
/// tolerance 0.5, and every value row names the same patient as its sample.
pub fn check_join_equality(model: &CanonicalModel) -> Vec<FileProblem> {
    let samples = model.derived_samples();
    let mut out = Vec::new();
    for row in &model.values {
        let (Some(pid), Some(day)) = (row.patient_id.text(), row.day.parse_f64()) else {
            continue;
        };
        let sample = samples
            .iter()
            .find(|s| s.patient_id == pid && (s.day - day).abs() <= 0.5);
        match sample {
            None => out.push(problem(
                ProblemCode::R11DayAgreement,
                ProblemSeverity::Error,
                &row.day,
                format!("day `{day}` of `{pid}` differs between the value row and its sample"),
            )),
            Some(s) if s.patient_id != pid => out.push(problem(
                ProblemCode::R16ValueSampleSamePatient,
                ProblemSeverity::Error,
                &row.patient_id,
                format!("`{pid}` is not the patient of the value row's sample"),
            )),
            Some(_) => {},
        }
    }
    out
}

/// R12 — single time unit. The app's day columns are days by contract, so a
/// `time_unit` column (resolved directly by name; the app has no time-unit
/// role) must read `days`; anything else is R12 at the offending cell. The
/// whole-file single-value requirement falls out of the per-cell loop: any
/// non-`days` cell is reported, and the column is one column (patients only).
pub fn check_single_time_unit(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for row in &model.patients {
        let Some(tu) = &row.time_unit else { continue };
        if let Some(text) = tu.text() {
            let folded = normalize_header_name(text);
            if folded != "days" {
                out.push(problem(
                    ProblemCode::R12SingleTimeUnit,
                    ProblemSeverity::Error,
                    tu,
                    format!("time_unit `{text}` is not `days`; the app's day columns are days"),
                ));
            }
        }
    }
    out
}

/// R13 — companion features. `<F>__detected` values are binary, `<F>__lod`
/// values are ≥ 0, and the base `<F>` must be described in the features table.
/// The suffix rule is the provider's `is_companion` (one implementation, no
/// second spelling of the suffixes).
pub fn check_companion_features(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    let feature_names: BTreeSet<String> = model
        .features
        .iter()
        .filter_map(|f| f.feature.text().map(|t| t.to_string()))
        .collect();
    for row in &model.values {
        let Some(marker) = row.marker.text() else { continue };
        if !is_companion(marker) {
            continue;
        }
        let base = strip_companion_suffix(marker);
        if !feature_names.contains(base) {
            out.push(problem(
                ProblemCode::R13NondetectCompanions,
                ProblemSeverity::Error,
                &row.marker,
                format!(
                    "the base feature `{base}` of the companion feature `{marker}` is not described"
                ),
            ));
        }
        if let Some(v) = row.value.parse_f64() {
            let bad = if marker.ends_with("__detected") {
                v != 0.0 && v != 1.0
            } else {
                v < 0.0
            };
            if bad {
                let what = if marker.ends_with("__detected") {
                    "must be 0 or 1"
                } else {
                    "must be >= 0"
                };
                out.push(problem(
                    ProblemCode::R13NondetectCompanions,
                    ProblemSeverity::Error,
                    &row.value,
                    format!("{marker} values {what}; got `{v}`"),
                ));
            }
        }
    }
    out
}

fn strip_companion_suffix(marker: &str) -> &str {
    if let Some(base) = marker.strip_suffix("__detected") {
        base
    } else if let Some(base) = marker.strip_suffix("__lod") {
        base
    } else {
        marker
    }
}

/// The base marker of a companion spelling (`<F>__detected`/`<F>__lod` → the
/// base with the suffix removed) — the ITEM-5 metadata rule (a column that has
/// a detection companion in the file) reads the same suffix contract as R13.
pub(crate) fn companion_base(marker: &str) -> &str {
    strip_companion_suffix(marker)
}

/// R14 — outcome available (adapted severity): when outcome columns EXIST but
/// fewer than [`Limits::R14_MIN_OUTCOME`] patients carry a non-null outcome
/// (pfs_days, os_days or responder — the tidy `any_of` set), the verdict is a
/// WARNING (the benchmark's error is too harsh for a clinician's own file:
/// the file is valid, the cohort is small — DEC/TESTS recorded divergence).
/// The no-outcome-column case is A02's error, so this check reports nothing
/// there (one verdict per condition, not two).
pub fn check_outcome_available(model: &CanonicalModel) -> Vec<FileProblem> {
    let Some(shape) = &model.patients_shape else {
        return Vec::new();
    };
    let has_outcome_col = |aliases: &[&str]| {
        shape
            .columns
            .iter()
            .any(|c| aliases.contains(&normalize_header_name(c).as_str()))
    };
    let outcome_cols_present = has_outcome_col(PFS_DAYS_ALIASES)
        || has_outcome_col(PFS_EVENT_ALIASES)
        || has_outcome_col(OS_DAYS_ALIASES)
        || has_outcome_col(OS_EVENT_ALIASES)
        || has_outcome_col(RESPONDER_ALIASES)
        || has_outcome_col(RESPONSE_DAY_ALIASES);
    if !outcome_cols_present {
        return Vec::new();
    }
    let mut pfs = 0usize;
    let mut os = 0usize;
    let mut resp = 0usize;
    for row in &model.patients {
        if row.pfs_days.parse_f64().is_some() {
            pfs += 1;
        }
        if row.os_days.parse_f64().is_some() {
            os += 1;
        }
        if row.responder.parse_i64().is_some() {
            resp += 1;
        }
    }
    let best = pfs.max(os).max(resp);
    if (best as u32) < Limits::R14_MIN_OUTCOME {
        return vec![problem_row(
            ProblemCode::R14OutcomeAvailable,
            ProblemSeverity::Warning,
            None,
            None,
            format!(
                "fewer than {} patients (the most is {best}: pfs_days {pfs}, os_days {os}, responder {resp}) have a non-null outcome",
                Limits::R14_MIN_OUTCOME
            ),
        )];
    }
    Vec::new()
}

/// R17 — sample day null exactly when `day_source` is "unknown", BY
/// CONSTRUCTION for derived samples: `day_source` is always "file" (never
/// "unknown"), and a derived sample's day is a number (a non-numeric value row
/// is R03's report and contributes no sample). The check still runs and still
/// verifies the derivation's own promise, so a future derivation change that
/// produced an "unknown"-source sample fails HERE, not silently.
pub fn check_null_iff(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for sample in model.derived_samples() {
        if sample.day_source != DAY_SOURCE_FILE {
            out.push(problem_row(
                ProblemCode::R17UnknownDayIffNull,
                ProblemSeverity::Error,
                Some(sample.row),
                Some("day"),
                format!(
                    "sample `{} @ {}` carries day_source `{}`; derived samples always carry `{}` (a non-numeric day is R03 and produces no sample)",
                    sample.patient_id, sample.day, sample.day_source, DAY_SOURCE_FILE
                ),
            ));
        }
    }
    out
}

/// R18 — paired null: pfs time/event both-or-neither, os same. The app adds
/// the responder/response_day pair (DEC-7: both-or-neither, matching the
/// three-pair shape engine consumes).
pub fn check_paired_null(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for row in &model.patients {
        for (time, event, time_name, event_name) in [
            (&row.pfs_days, &row.pfs_event, "pfs_days", "pfs_event"),
            (&row.os_days, &row.os_event, "os_days", "os_event"),
            (&row.responder, &row.response_day, "responder", "response_day"),
        ] {
            let t = time.text();
            let e = event.text();
            match (t, e) {
                (Some(_), None) => out.push(problem_row(
                    ProblemCode::R18EventHasTime,
                    ProblemSeverity::Error,
                    Some(time.row),
                    None,
                    format!("{time_name} is set but {event_name} is empty (the pair is both-or-neither)"),
                )),
                (None, Some(_)) => out.push(problem_row(
                    ProblemCode::R18EventHasTime,
                    ProblemSeverity::Error,
                    Some(event.row),
                    None,
                    format!("{event_name} is set but {time_name} is empty (the pair is both-or-neither)"),
                )),
                _ => {},
            }
        }
    }
    out
}

/// R19 — outcome time positive (WARNING): an outcome time of exactly 0 can
/// never be eligible after a landmark. The tidy column list (pfs_time,
/// os_time) ports to pfs_days/os_days; the response assessment day is not in
/// the tidy list (R06's ≥ 0 minimum covers it).
pub fn check_exclusive_minimum(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for row in &model.patients {
        for (name, cell) in [("pfs_days", &row.pfs_days), ("os_days", &row.os_days)] {
            if let Some(v) = cell.parse_f64() {
                if v == 0.0 {
                    out.push(problem(
                        ProblemCode::R19OutcomeTimePositive,
                        ProblemSeverity::Warning,
                        cell,
                        format!("{name} is 0; a zero outcome time cannot be eligible"),
                    ));
                }
            }
        }
    }
    out
}

/// R20 — day range (WARNING): a measurement day outside [−180, 3650]
/// (the tidy values-day bounds).
pub fn check_day_range(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    for row in &model.values {
        if let Some(day) = row.day.parse_f64() {
            if day < R20_DAY_MIN || day > R20_DAY_MAX {
                out.push(problem(
                    ProblemCode::R20DayRange,
                    ProblemSeverity::Warning,
                    &row.day,
                    format!("day `{day}` is outside [{R20_DAY_MIN}, {R20_DAY_MAX}]"),
                ));
            }
        }
    }
    out
}

/// The tidy R20 day bounds (the schema's own values).
pub const R20_DAY_MIN: f64 = -180.0;
/// The tidy R20 day bounds (the schema's own values).
pub const R20_DAY_MAX: f64 = 3650.0;

// ─────────────────────────────────────────────────────────────────────────────
// The rule-kind enum + the exhaustive dispatch (TEST-FV-18)
// ─────────────────────────────────────────────────────────────────────────────

/// Every check KIND the tidy 2.0 contract defines — the 15 `kind` values of
/// rules.json minus the two dataset/file-scope kinds the app cannot have
/// (`tables_present` R01, `preview_consistent` R21 — both declared
/// `NotApplicable` in the registry, TEST-FV-6). The enum is exhaustive: a kind
/// without an arm is a COMPILE error here, never a silently skipped check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RuleKind {
    RequiredColumns,
    ColumnTypes,
    NotNull,
    Enum,
    Minimum,
    Unique,
    ForeignKey,
    JoinEqual,
    SingleValue,
    CompanionFeatures,
    MinNonNull,
    NullIff,
    PairedNull,
    ExclusiveMinimum,
    Range,
}

impl RuleKind {
    /// The tidy `kind` string of the rule set.
    pub fn as_str(&self) -> &'static str {
        match self {
            RuleKind::RequiredColumns => "required_columns",
            RuleKind::ColumnTypes => "column_types",
            RuleKind::NotNull => "not_null",
            RuleKind::Enum => "enum",
            RuleKind::Minimum => "minimum",
            RuleKind::Unique => "unique",
            RuleKind::ForeignKey => "foreign_key",
            RuleKind::JoinEqual => "join_equal",
            RuleKind::SingleValue => "single_value",
            RuleKind::CompanionFeatures => "companion_features",
            RuleKind::MinNonNull => "min_non_null",
            RuleKind::NullIff => "null_iff",
            RuleKind::PairedNull => "paired_null",
            RuleKind::ExclusiveMinimum => "exclusive_minimum",
            RuleKind::Range => "range",
        }
    }

    /// Every kind, in the rule set's order (the deterministic check order).
    pub const ALL: [RuleKind; 15] = [
        RuleKind::RequiredColumns,
        RuleKind::ColumnTypes,
        RuleKind::NotNull,
        RuleKind::Enum,
        RuleKind::Minimum,
        RuleKind::Unique,
        RuleKind::ForeignKey,
        RuleKind::JoinEqual,
        RuleKind::SingleValue,
        RuleKind::CompanionFeatures,
        RuleKind::MinNonNull,
        RuleKind::NullIff,
        RuleKind::PairedNull,
        RuleKind::ExclusiveMinimum,
        RuleKind::Range,
    ];

    /// The tidy rule ids this kind covers (the declaration↔kind link the
    /// registry completeness test walks).
    pub fn problem_codes(&self) -> &'static [ProblemCode] {
        match self {
            RuleKind::RequiredColumns => &[ProblemCode::R02RequiredColumns],
            RuleKind::ColumnTypes => &[ProblemCode::R03ColumnTypes],
            RuleKind::NotNull => &[ProblemCode::R04Nullability],
            RuleKind::Enum => &[ProblemCode::R05AllowedValues],
            RuleKind::Minimum => &[ProblemCode::R06Ranges],
            RuleKind::Unique => &[ProblemCode::R07UniqueKeys],
            RuleKind::ForeignKey => &[
                ProblemCode::R08ValuesPatientExists,
                ProblemCode::R09ValuesSampleExists,
                ProblemCode::R10FeatureDescribed,
                ProblemCode::R15SamplesPatientExists,
            ],
            RuleKind::JoinEqual => &[
                ProblemCode::R11DayAgreement,
                ProblemCode::R16ValueSampleSamePatient,
            ],
            RuleKind::SingleValue => &[ProblemCode::R12SingleTimeUnit],
            RuleKind::CompanionFeatures => &[ProblemCode::R13NondetectCompanions],
            RuleKind::MinNonNull => &[ProblemCode::R14OutcomeAvailable],
            RuleKind::NullIff => &[ProblemCode::R17UnknownDayIffNull],
            RuleKind::PairedNull => &[ProblemCode::R18EventHasTime],
            RuleKind::ExclusiveMinimum => &[ProblemCode::R19OutcomeTimePositive],
            RuleKind::Range => &[ProblemCode::R20DayRange],
        }
    }

    /// Run the check(s) of this kind over the model. The 15-arm match is the
    /// compile-time completeness guarantee of TEST-FV-18 (no wildcard arm, no
    /// `unimplemented!`).
    pub fn check(&self, model: &CanonicalModel) -> Vec<FileProblem> {
        match self {
            RuleKind::RequiredColumns => check_required_columns(model),
            RuleKind::ColumnTypes => check_column_types(model),
            RuleKind::NotNull => check_nullability(model),
            RuleKind::Enum => check_allowed_values(model),
            RuleKind::Minimum => check_ranges(model),
            RuleKind::Unique => check_unique_keys(model),
            RuleKind::ForeignKey => check_foreign_keys(model),
            RuleKind::JoinEqual => check_join_equality(model),
            RuleKind::SingleValue => check_single_time_unit(model),
            RuleKind::CompanionFeatures => check_companion_features(model),
            RuleKind::MinNonNull => check_outcome_available(model),
            RuleKind::NullIff => check_null_iff(model),
            RuleKind::PairedNull => check_paired_null(model),
            RuleKind::ExclusiveMinimum => check_exclusive_minimum(model),
            RuleKind::Range => check_day_range(model),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The rule registry (TEST-FV-6) — every tidy id has an applicability verdict
// ─────────────────────────────────────────────────────────────────────────────

/// The applicability verdict of a tidy rule id in the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleApplicability {
    /// A real check runs for this rule in `validate_model`.
    Implemented,
    /// The property holds by the sample-derivation rule; the check still runs
    /// and returns no problem for any model the derivation can produce
    /// (asserted by tests, never skipped) — the reason is the written proof.
    HoldsByConstruction(&'static str),
    /// The app's shape has no such object; the reason is the written record
    /// (R01, R21 — never silently dropped).
    NotApplicable(&'static str),
}

/// One tidy rule id's declaration: the rule's own id/kind/severity from the
/// contract plus the app's applicability verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleDeclaration {
    pub code: ProblemCode,
    /// The benchmark's spelled rule id (`R02_required_columns`).
    pub rule_id: &'static str,
    /// The rule kind (the contract's `kind` string; the kinds enum for the
    /// checks), `None` for the two declared-not-applicable rules.
    pub kind: Option<RuleKind>,
    pub severity: ProblemSeverity,
    pub applicability: RuleApplicability,
}

/// All 21 tidy rule ids, in id order, each with its applicability verdict.
pub const RULES: [RuleDeclaration; 21] = [
    RuleDeclaration {
        code: ProblemCode::R01TablesPresent,
        rule_id: "R01_tables_present",
        kind: None,
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::NotApplicable(
            "the app request contract always carries the two user tables; the four-table Parquet shape never exists here",
        ),
    },
    RuleDeclaration {
        code: ProblemCode::R02RequiredColumns,
        rule_id: "R02_required_columns",
        kind: Some(RuleKind::RequiredColumns),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R03ColumnTypes,
        rule_id: "R03_column_types",
        kind: Some(RuleKind::ColumnTypes),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R04Nullability,
        rule_id: "R04_nullability",
        kind: Some(RuleKind::NotNull),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R05AllowedValues,
        rule_id: "R05_allowed_values",
        kind: Some(RuleKind::Enum),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R06Ranges,
        rule_id: "R06_ranges",
        kind: Some(RuleKind::Minimum),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R07UniqueKeys,
        rule_id: "R07_unique_keys",
        kind: Some(RuleKind::Unique),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R08ValuesPatientExists,
        rule_id: "R08_values_patient_exists",
        kind: Some(RuleKind::ForeignKey),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R09ValuesSampleExists,
        rule_id: "R09_values_sample_exists",
        kind: Some(RuleKind::ForeignKey),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::HoldsByConstruction(
            "samples are derived FROM the value rows (distinct (patient_id, day) keys), so every value row's sample exists by construction",
        ),
    },
    RuleDeclaration {
        code: ProblemCode::R10FeatureDescribed,
        rule_id: "R10_feature_described",
        kind: Some(RuleKind::ForeignKey),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::HoldsByConstruction(
            "the feature list is folded from the measurement rows themselves (one feature per distinct marker spelling, `inspect::feature_rows`), so a value row's marker is always a described feature — a by-construction property of the app's derived shape, the written proof of the R09/R11/R16/R17 class",
        ),
    },
    RuleDeclaration {
        code: ProblemCode::R11DayAgreement,
        rule_id: "R11_day_agreement",
        kind: Some(RuleKind::JoinEqual),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::HoldsByConstruction(
            "the derived sample's day IS the value row's day (same (patient_id, day) key), so the agreement tolerance 0.5 holds for every row",
        ),
    },
    RuleDeclaration {
        code: ProblemCode::R12SingleTimeUnit,
        rule_id: "R12_single_time_unit",
        kind: Some(RuleKind::SingleValue),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R13NondetectCompanions,
        rule_id: "R13_nondetect_companions",
        kind: Some(RuleKind::CompanionFeatures),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R14OutcomeAvailable,
        rule_id: "R14_outcome_available",
        kind: Some(RuleKind::MinNonNull),
        severity: ProblemSeverity::Warning,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R15SamplesPatientExists,
        rule_id: "R15_samples_patient_exists",
        kind: Some(RuleKind::ForeignKey),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R16ValueSampleSamePatient,
        rule_id: "R16_value_sample_same_patient",
        kind: Some(RuleKind::JoinEqual),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::HoldsByConstruction(
            "the derived sample's patient IS the value row's patient (same key), so a value row can never name a different patient",
        ),
    },
    RuleDeclaration {
        code: ProblemCode::R17UnknownDayIffNull,
        rule_id: "R17_unknown_day_iff_null",
        kind: Some(RuleKind::NullIff),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::HoldsByConstruction(
            "day_source is always \"file\" for derived samples (never \"unknown\"), and a derived sample's day is a number — a non-numeric day row is R03 and produces no sample",
        ),
    },
    RuleDeclaration {
        code: ProblemCode::R18EventHasTime,
        rule_id: "R18_event_has_time",
        kind: Some(RuleKind::PairedNull),
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R19OutcomeTimePositive,
        rule_id: "R19_outcome_time_positive",
        kind: Some(RuleKind::ExclusiveMinimum),
        severity: ProblemSeverity::Warning,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R20DayRange,
        rule_id: "R20_day_range",
        kind: Some(RuleKind::Range),
        severity: ProblemSeverity::Warning,
        applicability: RuleApplicability::Implemented,
    },
    RuleDeclaration {
        code: ProblemCode::R21PreviewConsistent,
        rule_id: "R21_preview_consistent",
        kind: None,
        severity: ProblemSeverity::Error,
        applicability: RuleApplicability::NotApplicable(
            "the app has no preview/ files: any preview is generated from the canonical rows by the consumer (the engine), so there is nothing to compare",
        ),
    },
];

/// The declarations, in id order (the registry's one accessor).
pub fn rule_declarations() -> &'static [RuleDeclaration] {
    &RULES
}

// ─────────────────────────────────────────────────────────────────────────────
// The app-only code declarations (A01–A07) — the same registry shape as the
// tidy rules, for the app's own conditions (DEC-7). The Help page's
// troubleshooting list is generated from RULES + APP_RULES through
// `catalog::catalog()` — one table, so a code, a severity or an applicability
// change in the validator is a catalogue change, never a silent drift.
// ─────────────────────────────────────────────────────────────────────────────

/// One app-only code's declaration: the code, the severity (or severities)
/// it is reported with and the applicability verdict — the same record as a
/// tidy rule declaration, with no benchmark `rule_id` (these conditions have
/// no tidy-2.0 id; A04 reports BOTH severities: mixed units is the ERROR
/// (`units::unit_mixed_problem`), a scale that differs or cannot be classed
/// is the WARNING (`unit_mismatch_problem` / `unit_unclassified_problem`)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppRuleDeclaration {
    pub code: ProblemCode,
    /// `Some(severity)` when the code is reported with exactly one severity;
    /// `None` for the DUAL code (A04) whose report severity depends on the
    /// condition the message describes.
    pub severity: Option<ProblemSeverity>,
    /// True when the code is emitted with BOTH severities (A04: mixed units
    /// error, scale mismatch warning) — the catalogue's
    /// `error_or_warning` verdict.
    pub dual_severity: bool,
    pub applicability: RuleApplicability,
}

/// All seven app-only codes, in id order (A01–A07), each with its declared
/// severity and applicability — the closed set next to `RULES`.
pub const APP_RULES: [AppRuleDeclaration; 7] = [
    AppRuleDeclaration {
        code: ProblemCode::A01NoRecognizableHeader,
        severity: Some(ProblemSeverity::Error),
        dual_severity: false,
        applicability: RuleApplicability::Implemented,
    },
    AppRuleDeclaration {
        code: ProblemCode::A02RequiredColumnNotFound,
        severity: Some(ProblemSeverity::Error),
        dual_severity: false,
        applicability: RuleApplicability::Implemented,
    },
    AppRuleDeclaration {
        code: ProblemCode::A03SpellingVariantGroup,
        severity: Some(ProblemSeverity::Warning),
        dual_severity: false,
        applicability: RuleApplicability::Implemented,
    },
    AppRuleDeclaration {
        code: ProblemCode::A04UnitDiffers,
        severity: None,
        dual_severity: true,
        applicability: RuleApplicability::Implemented,
    },
    AppRuleDeclaration {
        code: ProblemCode::A05VocabularyCandidatesTruncated,
        severity: Some(ProblemSeverity::Warning),
        dual_severity: false,
        applicability: RuleApplicability::Implemented,
    },
    AppRuleDeclaration {
        code: ProblemCode::A06LargeFileNotice,
        severity: Some(ProblemSeverity::Warning),
        dual_severity: false,
        applicability: RuleApplicability::Implemented,
    },
    AppRuleDeclaration {
        code: ProblemCode::A07UnitAbsent,
        severity: Some(ProblemSeverity::Warning),
        dual_severity: false,
        applicability: RuleApplicability::Implemented,
    },
];

/// The app-only declarations, in id order (the registry's one accessor).
pub fn app_rule_declarations() -> &'static [AppRuleDeclaration] {
    &APP_RULES
}

// ─────────────────────────────────────────────────────────────────────────────
// The top-level dispatch
// ─────────────────────────────────────────────────────────────────────────────

/// Validate the whole canonical model: the app's file-level verdicts (A01,
/// A02) first, then every tidy rule kind in the rule set's order (R02..R20;
/// R01/R21 are declared not-applicable in the registry and emit nothing —
/// the declaration IS the record, and the registry test pins it). Output order
/// is deterministic, so a repeat request yields a byte-equal problem list.
pub fn validate_model(model: &CanonicalModel) -> Vec<FileProblem> {
    let mut out = Vec::new();
    out.extend(check_no_recognizable_header(model));
    out.extend(check_outcome_columns(model));
    for kind in RuleKind::ALL {
        out.extend(kind.check(model));
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-FV-1..6 (the ITEM-3 unit suite)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A located cell with the default column name for the role.
    fn cell(text: Option<&str>, row: u32, column: &str) -> ModelCell {
        ModelCell::new(text.map(|t| t.to_string()), row, column.to_string())
    }

    fn shape() -> TableShape {
        TableShape::new(
            1,
            vec![
                "patient_id".into(),
                "pfs_days".into(),
                "pfs_event".into(),
                "os_days".into(),
                "os_event".into(),
                "age".into(),
            ],
        )
    }

    fn meas_shape() -> TableShape {
        TableShape::new(
            1,
            vec![
                "patient_id".into(),
                "day".into(),
                "marker".into(),
                "value".into(),
            ],
        )
    }

    fn patient(
        pid: Option<&str>,
        pfs_days: Option<&str>,
        pfs_event: Option<&str>,
        os_days: Option<&str>,
        os_event: Option<&str>,
        row: u32,
    ) -> PatientRow {
        PatientRow {
            patient_id: cell(pid, row, "patient_id"),
            pfs_days: cell(pfs_days, row, "pfs_days"),
            pfs_event: cell(pfs_event, row, "pfs_event"),
            os_days: cell(os_days, row, "os_days"),
            os_event: cell(os_event, row, "os_event"),
            responder: cell(None, row, "responder"),
            response_day: cell(None, row, "response_day"),
            time_unit: None,
            covariates: Vec::new(),
        }
    }

    fn value(pid: Option<&str>, day: Option<&str>, marker: Option<&str>, val: Option<&str>, row: u32) -> ValueRow {
        ValueRow {
            patient_id: cell(pid, row, "patient_id"),
            day: cell(day, row, "day"),
            marker: cell(marker, row, "marker"),
            value: cell(val, row, "value"),
            unit: Some(cell(Some("U/L"), row, "unit")),
        }
    }

    fn model_with(values: Vec<ValueRow>) -> CanonicalModel {
        CanonicalModel {
            patients_shape: Some(shape()),
            measurements_shape: meas_shape(),
            patients: vec![patient(Some("P1"), Some("100"), Some("1"), Some("200"), Some("0"), 2)],
            values,
            features: vec![FeatureRow {
                feature: cell(Some("M1"), 2, "feature"),
                unit: Some(cell(Some("U/L"), 2, "unit")),
            }],
        }
    }

    fn valid_model() -> CanonicalModel {
        let mut m = model_with(vec![
            value(Some("P1"), Some("0"), Some("M1"), Some("1.5"), 3),
            value(Some("P1"), Some("28"), Some("M1"), Some("2.5"), 4),
            value(Some("P1"), Some("28"), Some("M2"), Some("3.5"), 5),
        ])
        .with_features();
        // Twelve patients with a resolvable pfs + os outcome: R14's threshold
        // (10) is satisfied, so the clean fixture carries no warning either.
        m.patients = (1..=12)
            .map(|i| {
                patient(
                    Some(&format!("P{i}")),
                    Some("100"),
                    Some("1"),
                    Some("200"),
                    Some("0"),
                    2 + i as u32,
                )
            })
            .collect();
        m
    }

    /// The default feature set plus a second marker.
    impl CanonicalModel {
        fn with_features(self) -> CanonicalModel {
            let mut m = self;
            if !m.features.iter().any(|f| f.feature.text() == Some("M2")) {
                m.features.push(FeatureRow {
                    feature: cell(Some("M2"), 5, "feature"),
                    unit: Some(cell(Some("U/L"), 5, "unit")),
                });
            }
            m
        }
    }

    // ── TEST-FV-1: types / nullability / enums / ranges ────────────────────

    #[test]
    fn test_fv1_value_high_is_r03_with_row_and_column() {
        let m = model_with(vec![value(Some("P1"), Some("28"), Some("M1"), Some("high"), 14)])
            .with_features();
        let problems = validate_model(&m);
        let r03: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R03ColumnTypes)
            .collect();
        assert_eq!(r03.len(), 1, "exactly one R03: {problems:?}");
        assert_eq!(r03[0].severity, ProblemSeverity::Error);
        assert_eq!(r03[0].row, Some(14), "the FILE row of the offending cell");
        assert_eq!(r03[0].column.as_deref(), Some("value"));
        assert!(r03[0].message.contains("high"), "the message names the cell text: {}", r03[0].message);
    }

    #[test]
    fn test_fv1_blank_patient_id_is_r04() {
        let m = model_with(vec![value(None, Some("28"), Some("M1"), Some("1.0"), 5)]).with_features();
        let problems = validate_model(&m);
        let r04: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R04Nullability)
            .collect();
        assert_eq!(r04.len(), 1, "one R04: {problems:?}");
        assert_eq!(r04[0].row, Some(5));
        assert_eq!(r04[0].column.as_deref(), Some("patient_id"));
    }

    #[test]
    fn test_fv1_event_two_is_r05() {
        let mut m = valid_model();
        m.patients[0].pfs_event = cell(Some("2"), 2, "pfs_event");
        let problems = validate_model(&m);
        let r05: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R05AllowedValues)
            .collect();
        assert_eq!(r05.len(), 1, "one R05: {problems:?}");
        assert_eq!(r05[0].row, Some(2));
        assert_eq!(r05[0].column.as_deref(), Some("pfs_event"));
    }

    #[test]
    fn test_fv1_negative_pfs_days_is_r06() {
        let mut m = valid_model();
        m.patients[0].pfs_days = cell(Some("-3"), 2, "pfs_days");
        let problems = validate_model(&m);
        assert_eq!(
            problems.iter().filter(|p| p.code == ProblemCode::R06Ranges).count(),
            1,
            "one R06: {problems:?}"
        );
    }

    // ── TEST-FV-2: uniqueness ───────────────────────────────────────────────

    #[test]
    fn test_fv2_duplicate_patient_id_is_r07_both_rows_listed() {
        let mut m = valid_model();
        m.patients.push(patient(Some("P1"), Some("50"), Some("0"), Some("60"), Some("0"), 7));
        let problems = validate_model(&m);
        let r07: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R07UniqueKeys)
            .collect();
        assert_eq!(r07.len(), 1, "one problem, on the second row: {problems:?}");
        assert_eq!(r07[0].row, Some(7), "the (second) duplicate occurrence");
        assert!(
            r07[0].message.contains("(rows 3, 7)"),
            "both rows listed: {}",
            r07[0].message
        );
    }

    #[test]
    fn test_fv2_duplicate_value_key_is_r07_on_second_row() {
        let m = model_with(vec![
            value(Some("P1"), Some("28"), Some("M1"), Some("1.0"), 3),
            value(Some("P1"), Some("28"), Some("M1"), Some("2.0"), 9),
        ])
        .with_features();
        let problems = validate_model(&m);
        let r07: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R07UniqueKeys)
            .collect();
        assert_eq!(r07.len(), 1, "one R07: {problems:?}");
        assert_eq!(r07[0].row, Some(9), "the second row");
    }

    #[test]
    fn test_fv2_same_marker_same_day_two_patients_is_clean() {
        let m = model_with(vec![
            value(Some("P1"), Some("28"), Some("M1"), Some("1.0"), 3),
            value(Some("P2"), Some("28"), Some("M1"), Some("2.0"), 4),
        ]);
        // P2 is not in the patients table — that is R08/R15, not R07; the R07
        // check itself must stay silent (different derived sample ids).
        let r07 = validate_model(&m)
            .iter()
            .filter(|p| p.code == ProblemCode::R07UniqueKeys)
            .count();
        assert_eq!(r07, 0, "no R07 for two patients at the same day");
        // And the R08/R15 reports for the missing P2 make the cross-table half
        // visible (asserted, not skipped).
        let r08 = validate_model(&m)
            .iter()
            .filter(|p| p.code == ProblemCode::R08ValuesPatientExists)
            .count();
        assert_eq!(r08, 1);
        let r15 = validate_model(&m)
            .iter()
            .filter(|p| p.code == ProblemCode::R15SamplesPatientExists)
            .count();
        assert_eq!(r15, 1, "the derived sample is reported once");
    }

    // ── TEST-FV-3: cross-table checks + the derivation assertions ──────────

    #[test]
    fn test_fv3_value_row_missing_patient_is_r08() {
        let m = model_with(vec![value(Some("P0187"), Some("88"), Some("M1"), Some("1.0"), 88)]);
        let problems = validate_model(&m);
        let r08: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R08ValuesPatientExists)
            .collect();
        assert_eq!(r08.len(), 1, "one R08: {problems:?}");
        assert_eq!(r08[0].row, Some(88));
        assert!(r08[0].message.contains("P0187"));
    }

    #[test]
    fn test_fv3_derived_samples_are_unique_with_day_source_file() {
        let m = valid_model();
        let samples = m.derived_samples();
        // Distinct (patient, day) keys, in file order, day_source "file".
        assert_eq!(samples.len(), 2, "P1@0 and P1@28 (the two distinct days)");
        let keys: BTreeSet<(String, u64)> = samples
            .iter()
            .map(|s| (s.patient_id.clone(), s.day.to_bits()))
            .collect();
        assert_eq!(keys.len(), samples.len(), "derived sample keys are unique");
        for s in &samples {
            assert_eq!(s.day_source, DAY_SOURCE_FILE);
        }
        assert_eq!(samples[0].day, 0.0);
        assert_eq!(samples[0].row, 3);
    }

    #[test]
    fn test_fv3_sample_less_shape_never_breaks_r09_r11_r16() {
        // A row whose day is not a number: R03 reports it, it contributes no
        // sample, and the derived-sample checks stay silent (the derivation is
        // the adapter for the tidy "left out" rule).
        let m = model_with(vec![
            value(Some("P1"), Some("week 4"), Some("M1"), Some("1.0"), 14),
            value(Some("P1"), Some("0"), Some("M1"), Some("2.0"), 3),
        ])
        .with_features();
        let problems = validate_model(&m);
        assert_eq!(
            problems.iter().filter(|p| p.code == ProblemCode::R03ColumnTypes).count(),
            1,
            "the non-numeric day is R03: {problems:?}"
        );
        for code in [
            ProblemCode::R09ValuesSampleExists,
            ProblemCode::R11DayAgreement,
            ProblemCode::R16ValueSampleSamePatient,
        ] {
            assert!(
                problems.iter().all(|p| p.code != code),
                "{code:?} must not fire: {problems:?}"
            );
        }
        assert_eq!(m.derived_samples().len(), 1, "only the numeric-day row yields a sample");
    }

    #[test]
    fn test_fv3_r17_is_vacuous_by_construction_and_asserted() {
        let m = model_with(vec![
            value(Some("P1"), Some("28"), Some("M1"), Some("1.0"), 4),
            value(Some("P1"), Some("week 4"), Some("M1"), Some("1.0"), 14),
        ])
        .with_features();
        // Every derived sample has a non-null day and day_source "file": R17
        // cannot fire (recorded, never skipped).
        for s in m.derived_samples() {
            assert_eq!(s.day_source, DAY_SOURCE_FILE);
            assert!(s.day.is_finite());
        }
        assert_eq!(
            validate_model(&m)
                .iter()
                .filter(|p| p.code == ProblemCode::R17UnknownDayIffNull)
                .count(),
            0
        );
    }

    // ── TEST-FV-4: companions + outcomes + r19/r20/r03-day ────────────────

    #[test]
    fn test_fv4_detected_values_outside_binary_is_r13() {
        let mut m = model_with(vec![
            value(Some("P1"), Some("28"), Some("ctDNA__detected"), Some("5"), 4),
        ]);
        // The base AND the companion are described (the value is the only
        // violation).
        m.features = vec![
            FeatureRow {
                feature: cell(Some("ctDNA"), 4, "feature"),
                unit: None,
            },
            FeatureRow {
                feature: cell(Some("ctDNA__detected"), 4, "feature"),
                unit: None,
            },
        ];
        let problems = validate_model(&m);
        let r13: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R13NondetectCompanions)
            .collect();
        assert_eq!(r13.len(), 1, "one R13: {problems:?}");
        assert!(r13[0].message.contains("0 or 1"), "{}", r13[0].message);
    }

    #[test]
    fn test_fv4_detected_without_base_is_r13() {
        // The companion exists in the model; its base ctDNA is not described.
        let mut m = model_with(vec![
            value(Some("P1"), Some("28"), Some("ctDNA__detected"), Some("1"), 4),
        ]);
        m.features = vec![FeatureRow {
            feature: cell(Some("ctDNA__detected"), 4, "feature"),
            unit: None,
        }];
        let problems = validate_model(&m);
        let r13: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R13NondetectCompanions)
            .collect();
        assert_eq!(r13.len(), 1, "one R13: {problems:?}");
        assert!(r13[0].message.contains("ctDNA"), "{}", r13[0].message);
    }

    #[test]
    fn test_fv4_pfs_days_without_pfs_event_is_r18() {
        let mut m = valid_model();
        m.patients[0].pfs_event = cell(None, 2, "pfs_event");
        let problems = validate_model(&m);
        let r18: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R18EventHasTime)
            .collect();
        assert_eq!(r18.len(), 1, "one R18: {problems:?}");
        assert!(r18[0].message.contains("pfs_days") && r18[0].message.contains("pfs_event"));
    }

    #[test]
    fn test_fv4_os_pair_and_responder_pair_are_checked_too() {
        let mut m = valid_model();
        m.patients[0].os_event = cell(None, 2, "os_event");
        m.patients[0].responder = cell(Some("1"), 2, "responder");
        let problems = validate_model(&m);
        let r18: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R18EventHasTime)
            .collect();
        assert_eq!(r18.len(), 2, "os pair + responder pair: {problems:?}");
    }

    #[test]
    fn test_fv4_zero_pfs_days_is_r19_warning() {
        let mut m = valid_model();
        m.patients[0].pfs_days = cell(Some("0"), 2, "pfs_days");
        let problems = validate_model(&m);
        let r19: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R19OutcomeTimePositive)
            .collect();
        assert_eq!(r19.len(), 1);
        assert_eq!(r19[0].severity, ProblemSeverity::Warning);
    }

    #[test]
    fn test_fv4_day_minus_200_is_r20_warning() {
        let m = model_with(vec![
            value(Some("P1"), Some("-200"), Some("M1"), Some("1.0"), 3),
        ])
        .with_features();
        let problems = validate_model(&m);
        let r20: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R20DayRange)
            .collect();
        assert_eq!(r20.len(), 1);
        assert_eq!(r20[0].severity, ProblemSeverity::Warning);
    }

    #[test]
    fn test_fv4_board_row_14_day_week_4_is_r03() {
        let m = model_with(vec![value(Some("P1"), Some("week 4"), Some("M1"), Some("1.0"), 14)])
            .with_features();
        let problems = validate_model(&m);
        let r03: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R03ColumnTypes)
            .collect();
        assert_eq!(r03.len(), 1);
        assert_eq!(r03[0].row, Some(14), "the board's row 14");
        assert_eq!(r03[0].column.as_deref(), Some("day"));
        assert!(r03[0].message.contains("week 4"));
    }

    // ── TEST-FV-5: outcome availability + R12 ───────────────────────────────

    #[test]
    fn test_fv5_no_outcome_column_is_a02_error() {
        let mut m = valid_model();
        m.patients_shape = Some(TableShape::new(
            1,
            vec!["patient_id".into(), "age".into()],
        ));
        m.patients = vec![patient(Some("P1"), None, None, None, None, 2)];
        let problems = validate_model(&m);
        let a02: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::A02RequiredColumnNotFound)
            .collect();
        assert_eq!(a02.len(), 1, "one A02: {problems:?}");
        assert_eq!(a02[0].severity, ProblemSeverity::Error);
        assert!(a02[0].message.contains("outcome"), "{}", a02[0].message);
        // qa-fixes4 ITEM-5 (help-r3 accuracy): the message lists EVERY
        // required column — following the advice must leave no R02 — and
        // names `responder`/`response_day` as extra, never as a substitute.
        for column in ["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"] {
            assert!(a02[0].message.contains(column), "lists {column}: {}", a02[0].message);
        }
        assert!(a02[0].message.contains("extra"), "{}", a02[0].message);
        // The four board outcome columns being required (owner D48) means the
        // per-column R02 errors accompany the verdict.
        let r02: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R02RequiredColumns)
            .collect();
        assert_eq!(r02.len(), 4, "pfs/os day+event: {problems:?}");
        // And no R14 (the A02 verdict is the no-column case; one verdict).
        assert!(
            problems.iter().all(|p| p.code != ProblemCode::R14OutcomeAvailable),
            "{problems:?}"
        );
    }

    /// qa-fixes4 ITEM-5, TEST-QF4-5 (the help-r3 accuracy probe): a patient
    /// table built by FOLLOWING the A02 advice (the message's required column
    /// set) validates with no A02 and no R02 — the advice and the R02 rule
    /// agree. And the report's "R02 only responder" shape (patient_id +
    /// responder/response_day, none of the board columns) keeps its four R02s:
    /// the optional set is never a substitute for the required one.
    #[test]
    fn test_fv5_following_a02_advice_leaves_no_r02() {
        let mut m = valid_model();
        m.patients_shape = Some(TableShape::new(
            1,
            vec![
                "patient_id".into(),
                "pfs_days".into(),
                "pfs_event".into(),
                "os_days".into(),
                "os_event".into(),
            ],
        ));
        m.patients = vec![patient(Some("P1"), Some("100"), Some("1"), Some("200"), Some("0"), 2)];
        let problems = validate_model(&m);
        assert!(
            problems.iter().all(|p| p.code != ProblemCode::A02RequiredColumnNotFound),
            "no A02 after following the advice: {problems:?}"
        );
        assert!(
            problems.iter().all(|p| p.code != ProblemCode::R02RequiredColumns),
            "no R02 after following the advice: {problems:?}"
        );

        // The report's probe: only the optional responder set → R02 x4.
        let mut m = valid_model();
        m.patients_shape = Some(TableShape::new(
            1,
            vec![
                "patient_id".into(),
                "responder".into(),
                "response_day".into(),
            ],
        ));
        m.patients = vec![patient(Some("P1"), None, None, None, None, 2)];
        let problems = validate_model(&m);
        let r02: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R02RequiredColumns)
            .collect();
        assert_eq!(r02.len(), 4, "the four board columns still required: {problems:?}");
        assert!(
            problems.iter().all(|p| p.code != ProblemCode::A02RequiredColumnNotFound),
            "the responder set is an outcome set for A02: {problems:?}"
        );
    }

    #[test]
    fn test_fv5_fewer_than_ten_outcome_patients_is_r14_warning() {
        let mut m = valid_model();
        // Nine patients with a pfs outcome (the tenth has none).
        m.patients = vec![patient(Some("P1"), Some("100"), Some("1"), Some("200"), Some("0"), 2)];
        for i in 1..9 {
            m.patients.push(patient(
                Some(&format!("P{}", i + 1)),
                Some("100"),
                Some("1"),
                None,
                None,
                3 + i as u32,
            ));
        }
        m.patients.push(patient(Some("P10"), None, None, None, None, 12));
        let problems = validate_model(&m);
        let r14: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R14OutcomeAvailable)
            .collect();
        assert_eq!(r14.len(), 1, "one R14: {problems:?}");
        assert_eq!(r14[0].severity, ProblemSeverity::Warning, "adapted severity");
        assert_eq!(r14[0].row, None, "file-level verdict");
    }

    #[test]
    fn test_fv5_ten_or_more_outcome_patients_is_clean() {
        let mut m = valid_model();
        m.patients = vec![patient(Some("P1"), Some("100"), Some("1"), Some("200"), Some("0"), 2)];
        for i in 1..10 {
            m.patients.push(patient(
                Some(&format!("P{}", i + 1)),
                Some("100"),
                Some("1"),
                None,
                None,
                3 + i as u32,
            ));
        }
        let problems = validate_model(&m);
        assert!(
            problems.iter().all(|p| p.code != ProblemCode::R14OutcomeAvailable),
            "{problems:?}"
        );
    }

    #[test]
    fn test_fv5_time_unit_weeks_is_r12() {
        let mut m = valid_model();
        m.patients[0].time_unit = Some(cell(Some("weeks"), 2, "time_unit"));
        let problems = validate_model(&m);
        let r12: Vec<_> = problems
            .iter()
            .filter(|p| p.code == ProblemCode::R12SingleTimeUnit)
            .collect();
        assert_eq!(r12.len(), 1, "one R12: {problems:?}");
        assert!(r12[0].message.contains("weeks"), "{}", r12[0].message);
    }

    #[test]
    fn test_fv5_time_unit_days_is_clean_and_absent_is_clean() {
        let mut m = valid_model();
        m.patients[0].time_unit = Some(cell(Some("days"), 2, "time_unit"));
        assert!(
            validate_model(&m).iter().all(|p| p.code != ProblemCode::R12SingleTimeUnit)
        );
        assert!(
            validate_model(&valid_model())
                .iter()
                .all(|p| p.code != ProblemCode::R12SingleTimeUnit),
            "no column = the app's implicit days"
        );
    }

    // ── TEST-FV-6: the registry — no silent skip ────────────────────────────

    #[test]
    fn test_fv6_not_applicable_rules_are_named_and_every_other_is_decided() {
        let rules = rule_declarations();
        assert_eq!(rules.len(), 21, "R01..R21, one declaration each");
        // Exactly R01 and R21 are NotApplicable.
        let not_applicable: Vec<_> = rules
            .iter()
            .filter(|r| matches!(r.applicability, RuleApplicability::NotApplicable(_)))
            .collect();
        assert_eq!(
            not_applicable.iter().map(|r| r.code.code()).collect::<Vec<_>>(),
            vec!["R01", "R21"],
            "only the four-table/preview rules: {:?}",
            not_applicable.iter().map(|r| r.rule_id).collect::<Vec<_>>()
        );
        for r in &not_applicable {
            let RuleApplicability::NotApplicable(reason) = &r.applicability else {
                unreachable!()
            };
            assert!(reason.len() > 20, "a written reason: {reason}");
        }
        // Every R02..R20 id has a kind and a verdict (implemented or by
        // construction) — no id slips through without an applicability decision.
        let mut seen = BTreeSet::new();
        for r in rules {
            assert!(seen.insert(r.code.code()), "no duplicate declaration for {}", r.code.code());
            match &r.applicability {
                RuleApplicability::NotApplicable(_) => assert!(r.kind.is_none()),
                _ => {
                    let kind = r.kind.expect("every implemented/by-construction rule has a kind");
                    // The declaration's rule_id carries its code prefix
                    // ("R04_nullability" → R04); the KIND name is the
                    // contract's check-kind vocabulary, not the rule_id's tail
                    // (R04's kind is `not_null`, R19's is
                    // `exclusive_minimum`), so the declaration↔kind link is
                    // the code-set membership below, not a name suffix.
                    assert!(
                        r.rule_id.starts_with(&format!("{}_", r.code.code())),
                        "{} carries its code prefix",
                        r.rule_id
                    );
                    assert!(
                        kind.problem_codes().contains(&r.code),
                        "the declaration's kind covers its own code: {}",
                        r.rule_id
                    );
                },
            }
        }
    }

    #[test]
    fn test_fv6_every_rule_kind_has_a_check_with_passing_and_failing_fixtures() {
        // The exhaustive-kind proof: RuleKind::ALL is the whole enumi, each
        // kind's check runs (the compiled match has no wildcard/unimplemented
        // arm — this test pins the registry↔kind agreement).
        assert_eq!(RuleKind::ALL.len(), 15);
        let kinds: BTreeSet<&'static str> = RuleKind::ALL.iter().map(|k| k.as_str()).collect();
        assert_eq!(kinds.len(), 15, "distinct kind names");
        for kind in RuleKind::ALL {
            let valid = valid_model();
            assert!(kind.check(&valid).is_empty(), "{:?} passes a valid model", kind.as_str());
            // A failing fixture exists per kind (moved to the acceptance
            // rules_test.rs, TEST-FV-18 — the in-module half here pins the
            // dispatch).
        }
    }

    #[test]
    fn test_fv6_valid_model_yields_zero_problems() {
        let problems = validate_model(&valid_model());
        assert!(
            problems.is_empty(),
            "the canonical example shape is clean: {problems:?}"
        );
    }

    #[test]
    fn test_fv6_rule_ids_map_to_the_closed_code_enum() {
        // Every declaration's code round-trips through from_id (the spelled id
        // AND the bare id), so the registry and the wire vocabulary agree.
        for r in rule_declarations() {
            assert_eq!(ProblemCode::from_id(r.rule_id), Some(r.code), "{}", r.rule_id);
            assert_eq!(ProblemCode::from_id(r.code.code()), Some(r.code));
        }
    }

    // ── alias resolution pins (DEC-5) ───────────────────────────────────────

    #[test]
    fn alias_resolution_matches_the_board_and_tidy_spellings() {
        assert_eq!(
            resolve_column_role("PFS_Days", FileTableKind::Patients),
            Some(ColumnRole::PfsDays)
        );
        assert_eq!(
            resolve_column_role("pfs_time", FileTableKind::Patients),
            Some(ColumnRole::PfsDays)
        );
        assert_eq!(
            resolve_column_role("day_from_start", FileTableKind::Measurements),
            Some(ColumnRole::Day)
        );
        assert_eq!(
            resolve_column_role("Feature", FileTableKind::Measurements),
            Some(ColumnRole::Marker)
        );
        assert_eq!(
            resolve_column_role("Units", FileTableKind::Measurements),
            Some(ColumnRole::Unit)
        );
        assert_eq!(
            resolve_column_role("cov_age", FileTableKind::Patients),
            Some(ColumnRole::Covariate("age".into()))
        );
        assert_eq!(
            resolve_column_role("Stage", FileTableKind::Patients),
            Some(ColumnRole::Covariate("stage".into()))
        );
        assert_eq!(resolve_column_role("age", FileTableKind::Measurements), None);
        assert_eq!(resolve_column_role("ploidy", FileTableKind::Patients), None);
        // R12's column is direct-name matched (never a role).
        assert!(is_time_unit_column("time_unit"));
        assert!(is_time_unit_column("Time Unit"));
        assert!(!is_time_unit_column("unit"));
    }

    #[test]
    fn model_materializes_from_json_rows() {
        // The acceptance test (TEST-FV-17) uses JSON rows; pin the shape here.
        let m: CanonicalModel = serde_json::from_value(json!({
            "patients_shape": {"header_row": 1, "columns": ["patient_id", "pfs_days"]},
            "measurements_shape": {"header_row": 1, "columns": ["patient_id", "day"]},
            "patients": [],
            "values": [],
            "features": [],
        }))
        .unwrap();
        assert!(m.has_patients());
        assert!(m.derived_samples().is_empty());
    }
}
