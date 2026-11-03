//! Per-file inspection and the canonical-model build — `inspect.rs` (ITEM-5,
//! PROV-FV-2).
//!
//! [`inspect`] answers the drop-time question for ONE file (screen C inspects
//! each file as it is dropped; screen N inspects its only file — INV-3): which
//! of the file's columns resolve to known roles (DEC-5), which per-file tidy
//! rules are broken (by row), what the file's marker columns + draw days look
//! like, and the per-file join-offer / unit / vocabulary facts (A03–A07). The
//! cross-table checks (R08/R15, joins against the patients side) are not
//! inspectable with one file and belong to
//! [`crate::modules::file_validator::validate`].
//!
//! This module also owns the `ParsedTable` → canonical model build
//! ([`build_model`], DEC-4): the browser sends raw cells; the rules run over
//! the located-cell model (every cell keeps its FILE row and the user's column
//! spelling — DEC-6). Inspect builds one side; validate builds both.
//!
//! All functions are pure: no I/O, no state, no timestamps.

use std::collections::BTreeMap;

use crate::modules::file_validator::rules::{
    check_no_recognizable_header_in, check_outcome_columns, check_required_columns_in,
    is_time_unit_column, resolve_column_role, CanonicalModel, FeatureRow, ModelCell, PatientRow,
    RuleKind, TableShape, ValueRow,
};
use crate::modules::file_validator::types::{
    ColumnRole, CovariateColumn, FileColumns, FileInspection, FileInspectionRequest, FileProblem,
    FileSummary, FileTableKind, Limits, MarkerSummary, MatchKind, ParsedTable, ProblemCode,
    ProblemSeverity,
};
use crate::modules::file_validator::units::{
    compare_unit_to_canonical, infer_unit_family, marker_unit_facts, unit_absent_problem,
    unit_mismatch_problem, unit_mixed_problem, unit_unclassified_problem, MarkerUnitFacts,
    UnitAgreement,
};
use crate::modules::file_validator::vocab::{
    marker_matches_set, normalize_marker_name, MarkerSpelling,
};
use crate::modules::method_catalogue::types::UnitFamily;

// ─────────────────────────────────────────────────────────────────────────────
// The canonical-model build (DEC-4: located cells from the browser-decoded rows)
// ─────────────────────────────────────────────────────────────────────────────

/// One parsed table's shape facts (the R02/A01 column rules resolve against the
/// real column names + header row).
pub(crate) fn table_shape(table: &ParsedTable) -> TableShape {
    TableShape::new(table.header_row, table.columns.clone())
}

/// The role of each column (file order), resolved by the DEC-5 alias table.
/// First column per role wins; a second column resolving to an already-taken
/// role is `None` here (the inspect response reports it under `unresolved`,
/// never silently dropped).
pub(crate) fn role_indices(table: &ParsedTable, kind: FileTableKind) -> Vec<Option<ColumnRole>> {
    let mut seen: Vec<String> = Vec::new();
    table
        .columns
        .iter()
        .map(|name| {
            let role = resolve_column_role(name, kind);
            match &role {
                Some(r) if !seen.contains(&r.wire_key()) => {
                    seen.push(r.wire_key());
                    role
                },
                _ => None,
            }
        })
        .collect()
}

/// The located cell of one data row: the raw text (a blank cell is `None` —
/// `ModelCell::blank` owns the whitespace verdict too), the FILE row (1-based,
/// header included), and the user's column spelling.
fn cell_at(table: &ParsedTable, row_idx: usize, col_idx: usize) -> ModelCell {
    let text = table
        .rows
        .get(row_idx)
        .and_then(|r| r.get(col_idx))
        .cloned()
        .flatten()
        .filter(|t| !t.is_empty());
    ModelCell::new(
        text,
        table.header_row + 1 + row_idx as u32,
        table.columns.get(col_idx).cloned().unwrap_or_default(),
    )
}

/// A located BLANK cell of the row (a column the file does not carry — the
/// file-level R02 report speaks for it; the row-level checks must see "no
/// cell", never another column's value).
fn blank_cell(table: &ParsedTable, row_idx: usize) -> ModelCell {
    ModelCell::new(
        None,
        table.header_row + 1 + row_idx as u32,
        String::new(),
    )
}

fn role_col(roles: &[Option<ColumnRole>], role: &dyn Fn(&ColumnRole) -> bool) -> Option<usize> {
    roles.iter().position(|r| r.as_ref().is_some_and(role))
}

fn cell_or_blank(table: &ParsedTable, row_idx: usize, col: Option<usize>) -> ModelCell {
    match col {
        Some(c) => cell_at(table, row_idx, c),
        None => blank_cell(table, row_idx),
    }
}

/// The patients-table rows of the model.
fn patient_rows(table: &ParsedTable) -> Vec<PatientRow> {
    let roles = role_indices(table, FileTableKind::Patients);
    let pid = role_col(&roles, &|r| matches!(r, ColumnRole::PatientId));
    let pfs_days = role_col(&roles, &|r| matches!(r, ColumnRole::PfsDays));
    let pfs_event = role_col(&roles, &|r| matches!(r, ColumnRole::PfsEvent));
    let os_days = role_col(&roles, &|r| matches!(r, ColumnRole::OsDays));
    let os_event = role_col(&roles, &|r| matches!(r, ColumnRole::OsEvent));
    let responder = role_col(&roles, &|r| matches!(r, ColumnRole::Responder));
    let response_day = role_col(&roles, &|r| matches!(r, ColumnRole::ResponseDay));
    let time_unit = table
        .columns
        .iter()
        .position(|c| is_time_unit_column(c));
    let covariate_cols: Vec<usize> = roles
        .iter()
        .enumerate()
        .filter_map(|(i, r)| matches!(r, Some(ColumnRole::Covariate(_))).then_some(i))
        .collect();

    (0..table.rows.len())
        .map(|i| PatientRow {
            patient_id: cell_or_blank(table, i, pid),
            pfs_days: cell_or_blank(table, i, pfs_days),
            pfs_event: cell_or_blank(table, i, pfs_event),
            os_days: cell_or_blank(table, i, os_days),
            os_event: cell_or_blank(table, i, os_event),
            responder: cell_or_blank(table, i, responder),
            response_day: cell_or_blank(table, i, response_day),
            time_unit: time_unit.map(|c| cell_at(table, i, c)),
            covariates: covariate_cols
                .iter()
                .map(|&c| (table.columns[c].clone(), cell_at(table, i, c)))
                .collect(),
        })
        .collect()
}

/// The features rows folded from the measurements table (DEC-4): one entry per
/// distinct marker spelling (first-appearance order), unit cell of the first
/// row. Blank markers are skipped (R04 reports them; a missing marker is not a
/// feature).
fn feature_rows(table: &ParsedTable) -> Vec<FeatureRow> {
    let roles = role_indices(table, FileTableKind::Measurements);
    let marker = role_col(&roles, &|r| matches!(r, ColumnRole::Marker));
    let unit = role_col(&roles, &|r| matches!(r, ColumnRole::Unit));
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    if let Some(m) = marker {
        for i in 0..table.rows.len() {
            let cell = cell_at(table, i, m);
            let Some(name) = cell.text() else { continue };
            if seen.iter().any(|s| s == name) {
                continue;
            }
            seen.push(name.to_string());
            out.push(FeatureRow {
                feature: cell,
                unit: unit.map(|c| cell_at(table, i, c)),
            });
        }
    }
    out
}

/// The measurements rows of the model.
fn value_rows(table: &ParsedTable) -> Vec<ValueRow> {
    let roles = role_indices(table, FileTableKind::Measurements);
    let pid = role_col(&roles, &|r| matches!(r, ColumnRole::PatientId));
    let day = role_col(&roles, &|r| matches!(r, ColumnRole::Day));
    let marker = role_col(&roles, &|r| matches!(r, ColumnRole::Marker));
    let value = role_col(&roles, &|r| matches!(r, ColumnRole::Value));
    let unit = role_col(&roles, &|r| matches!(r, ColumnRole::Unit));
    (0..table.rows.len())
        .map(|i| ValueRow {
            patient_id: cell_or_blank(table, i, pid),
            day: cell_or_blank(table, i, day),
            marker: cell_or_blank(table, i, marker),
            value: cell_or_blank(table, i, value),
            unit: unit.map(|c| cell_at(table, i, c)),
        })
        .collect()
}

/// Build the canonical model for BOTH tables (the `validate` / `bundle` path):
/// patients shape+rows when a patients table is present (files mode), the
/// measurements shape+rows+features always.
pub(crate) fn build_model(
    patients: Option<&ParsedTable>,
    measurements: &ParsedTable,
) -> CanonicalModel {
    CanonicalModel {
        patients_shape: patients.map(table_shape),
        measurements_shape: table_shape(measurements),
        patients: patients.map(patient_rows).unwrap_or_default(),
        values: value_rows(measurements),
        features: feature_rows(measurements),
    }
}

/// Build the canonical model for ONE table (the `inspect` path): the judged
/// side carries its rows, the other side is empty — its checks are not
/// inspectable with one file (see the module doc), and the file-level column
/// checks use the single-table variants.
pub(crate) fn build_single_model(table: &ParsedTable, kind: FileTableKind) -> CanonicalModel {
    let shape = table_shape(table);
    match kind {
        FileTableKind::Patients => CanonicalModel {
            patients_shape: Some(shape),
            measurements_shape: TableShape::new(1, Vec::new()),
            patients: patient_rows(table),
            values: Vec::new(),
            features: Vec::new(),
        },
        FileTableKind::Measurements => CanonicalModel {
            patients_shape: None,
            measurements_shape: shape,
            patients: Vec::new(),
            values: value_rows(table),
            features: feature_rows(table),
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The inspect response
// ─────────────────────────────────────────────────────────────────────────────

/// One marker column of the inspected file (the pre-join spelling groups: one
/// entry per distinct normalized spelling, carrying every raw spelling (with
/// its FILE rows) and the raw unit cells — the unit facts are collected once,
/// per column).
struct InspectColumn {
    /// The first raw spelling (the column's user-visible name).
    key: String,
    /// Every raw spelling with its FILE rows, file order.
    spellings: Vec<MarkerSpelling>,
    /// The raw unit cells (text, FILE row) — the `marker_unit_facts` input.
    unit_cells: Vec<(String, u32)>,
}

impl InspectColumn {
    fn unit_facts(&self) -> MarkerUnitFacts {
        marker_unit_facts(self.unit_cells.iter().map(|(t, r)| (t.as_str(), *r)))
    }
}

/// The marker columns of a single measurements table, grouped by normalized
/// identity (one group per distinct folded spelling, so `ldh`/`LDH` is one
/// column — the unit and A03 facts are column facts, not spelling facts).
fn inspect_columns(model: &CanonicalModel) -> Vec<InspectColumn> {
    let mut groups: Vec<(String, InspectColumn)> = Vec::new();
    for row in &model.values {
        let Some(spelling) = row.marker.text() else { continue };
        let norm = normalize_marker_name(spelling);
        let unit_text = row.unit.as_ref().and_then(|u| u.text()).map(|t| t.to_string());
        match groups.iter_mut().find(|(k, _)| k == &norm) {
            Some((_, column)) => {
                match column.spellings.iter_mut().find(|s| s.spelling == spelling) {
                    Some(s) => s.rows.push(row.marker.row),
                    None => column.spellings.push(MarkerSpelling {
                        spelling: spelling.to_string(),
                        rows: vec![row.marker.row],
                    }),
                }
                if let Some(t) = unit_text {
                    column.unit_cells.push((t, row.marker.row));
                }
            },
            None => groups.push((
                norm,
                InspectColumn {
                    key: spelling.to_string(),
                    spellings: vec![MarkerSpelling {
                        spelling: spelling.to_string(),
                        rows: vec![row.marker.row],
                    }],
                    unit_cells: unit_text.map(|t| (t, row.marker.row)).into_iter().collect(),
                },
            )),
        }
    }
    groups.into_iter().map(|(_, c)| c).collect()
}

/// The A03 message copy: `'ldh' (rows 3, 22) and 'LDH' (rows 4, 23)`.
fn spellings_with_rows(spellings: &[MarkerSpelling]) -> String {
    spellings
        .iter()
        .map(|s| {
            format!(
                "'{}' (rows {})",
                s.spelling,
                s.rows
                    .iter()
                    .map(|r| r.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join(" and ")
}

/// The unit problems of one inspected column with a vocabulary reference (the
/// best non-fuzzy candidate — a fuzzy suggestion is not a vocabulary identity,
/// DEC-12; the inspect verdict is the drop-time preview, the user's mapping at
/// validate time is the final one).
fn unit_problems_with_reference(
    column: &InspectColumn,
    canonical_family: UnitFamily,
    canonical_unit: &str,
) -> Vec<FileProblem> {
    let facts = column.unit_facts();
    if facts.is_absent() {
        return vec![unit_absent_problem(&column.key)];
    }
    if !facts.is_constant() {
        return unit_mixed_problem(&column.key, &facts).into_iter().collect();
    }
    let Some(unit) = facts.the_unit() else { return Vec::new() };
    match compare_unit_to_canonical(&unit.spelling, canonical_unit, canonical_family) {
        UnitAgreement::Matches => Vec::new(),
        agreement => vec![unit_mismatch_problem(
            &column.key,
            &unit.spelling,
            canonical_unit,
            agreement,
        )],
    }
}

/// The unit problems of one inspected column without a vocabulary reference
/// (DEC-10: classifier only — a known family is carried silently, an
/// unrecognizable unit is the honest no-claim warning).
fn unit_problems_unmapped(column: &InspectColumn) -> Vec<FileProblem> {
    let facts = column.unit_facts();
    if facts.is_absent() {
        return Vec::new();
    }
    if !facts.is_constant() {
        return unit_mixed_problem(&column.key, &facts).into_iter().collect();
    }
    let Some(unit) = facts.the_unit() else { return Vec::new() };
    if infer_unit_family(&unit.spelling) == UnitFamily::None {
        vec![unit_unclassified_problem(&column.key, &unit.spelling)]
    } else {
        Vec::new()
    }
}

/// The inspect call (PROV-FV-2): one file, per-file facts only. Deterministic
/// output; a repeat call yields a byte-equal response.
pub fn inspect(req: &FileInspectionRequest) -> FileInspection {
    let table = &req.table;
    let kind = req.kind;
    let model = build_single_model(table, kind);
    let shape = table_shape(table);
    let table_name = match kind {
        FileTableKind::Patients => "patients",
        FileTableKind::Measurements => "measurements",
    };

    let mut problems = Vec::new();
    // A01 + A02 + R02: the file-level column verdicts (validate runs the same
    // verdicts over both tables).
    problems.extend(check_no_recognizable_header_in(&shape, kind, table_name));
    problems.extend(check_outcome_columns(&model));
    problems.extend(check_required_columns_in(&shape, kind, table_name));
    // The row-level tidy kinds (the cross-table kinds are vacuous on a single
    // table; R14 outcome availability is the analysis-time verdict and runs
    // only in validate — the plan's inspect list is row-level + A01/A02).
    for rule_kind in RuleKind::ALL {
        if matches!(rule_kind, RuleKind::RequiredColumns | RuleKind::MinNonNull) {
            continue;
        }
        problems.extend(rule_kind.check(&model));
    }
    // A06: the soft large-file notice (never a cap — DEC-9).
    if table.rows.len() as u64 > Limits::A06_NOTICE_VALUE_ROWS {
        problems.push(FileProblem::new(
            ProblemCode::A06LargeFileNotice,
            ProblemSeverity::Warning,
            None,
            None,
            format!(
                "this table carries {} rows (> {}); the per-row checks may take a moment",
                table.rows.len(),
                Limits::A06_NOTICE_VALUE_ROWS
            ),
        ));
    }
    // The per-column facts (measurements only): A03 join offers, unit verdicts
    // (A04/A07) and the A05 candidate truncation.
    if kind == FileTableKind::Measurements {
        for column in inspect_columns(&model) {
            let set = marker_matches_set(&column.key);
            if column.spellings.len() > 1 {
                problems.push(FileProblem::new(
                    ProblemCode::A03SpellingVariantGroup,
                    ProblemSeverity::Warning,
                    Some(column.spellings[0].rows[0]),
                    None,
                    format!(
                        "marker spellings {} look the same — join them?",
                        spellings_with_rows(&column.spellings)
                    ),
                ));
            }
            let reference = set
                .matches
                .iter()
                .find(|m| m.match_kind != MatchKind::Fuzzy);
            if let Some(reference) = reference {
                problems.extend(unit_problems_with_reference(
                    &column,
                    reference.unit_family,
                    &reference.canonical_unit,
                ));
            } else {
                problems.extend(unit_problems_unmapped(&column));
            }
            if set.fuzzy_truncated {
                problems.push(FileProblem::new(
                    ProblemCode::A05VocabularyCandidatesTruncated,
                    ProblemSeverity::Warning,
                    None,
                    Some(column.key.clone()),
                    format!(
                        "more than {} vocabulary candidates exist for marker column `{}` — the list is truncated",
                        Limits::MAX_FUZZY_CANDIDATES, column.key
                    ),
                ));
            }
        }
    }

    FileInspection {
        kind,
        source_name: table.source.name.clone(),
        columns: inspect_columns_facts(table, kind),
        problems,
        summary: inspect_summary(table, kind, &model),
    }
}

/// `FileColumns` (PROV-FV-2): role wire-key → column name, unresolved names,
/// covariate numeric-ness.
fn inspect_columns_facts(table: &ParsedTable, kind: FileTableKind) -> FileColumns {
    let roles = role_indices(table, kind);
    let mut resolved: BTreeMap<String, String> = BTreeMap::new();
    let mut unresolved: Vec<String> = Vec::new();
    let mut covariate_columns: Vec<CovariateColumn> = Vec::new();
    for (i, role) in roles.iter().enumerate() {
        match role {
            Some(ColumnRole::Covariate(name)) => {
                resolved.insert(
                    ColumnRole::Covariate(name.clone()).wire_key(),
                    table.columns[i].clone(),
                );
                covariate_columns.push(CovariateColumn {
                    name: table.columns[i].clone(),
                    is_numeric: column_is_numeric(table, i),
                });
            },
            Some(role) => {
                resolved.insert(role.wire_key(), table.columns[i].clone());
            },
            None => unresolved.push(table.columns[i].clone()),
        }
    }
    FileColumns {
        resolved,
        unresolved,
        covariate_columns,
    }
}

/// A covariate column is numeric when it has at least one non-blank cell and
/// every non-blank cell parses as a float64 (the tidy per-column type rule).
fn column_is_numeric(table: &ParsedTable, col: usize) -> bool {
    let mut non_blank = 0usize;
    for row in &table.rows {
        let Some(cell) = row.get(col) else { continue };
        let Some(text) = cell.as_deref().map(str::trim).filter(|t| !t.is_empty()) else {
            continue;
        };
        non_blank += 1;
        if text.parse::<f64>().is_ok_and(|v| v.is_finite()) {
            continue;
        }
        return false;
    }
    non_blank > 0
}

/// The file summary (PROV-FV-2): row count, the marker spelling counts, and the
/// distinct draw days (ascending).
fn inspect_summary(table: &ParsedTable, kind: FileTableKind, model: &CanonicalModel) -> FileSummary {
    let mut markers: Vec<MarkerSummary> = Vec::new();
    let mut draw_days: Vec<f64> = Vec::new();
    if kind == FileTableKind::Measurements {
        for row in &model.values {
            if let Some(spelling) = row.marker.text() {
                match markers.iter_mut().find(|m| m.name == spelling) {
                    Some(m) => m.rows += 1,
                    None => markers.push(MarkerSummary {
                        name: spelling.to_string(),
                        rows: 1,
                    }),
                }
            }
            if let Some(day) = row.day.parse_f64() {
                draw_days.push(day);
            }
        }
        draw_days.sort_by(f64::total_cmp);
        draw_days.dedup();
    }
    FileSummary {
        rows: table.rows.len() as u32,
        markers,
        draw_days,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — the inspect contract (PROV-FV-2's engine half; the routes' TESTS
// build on these facts)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::file_validator::types::{ParsedTableSource, TableFormat, ValidationMode};
    use crate::modules::file_validator::validate::validate;

    fn table<'a, R: AsRef<[&'a str]>>(columns: &[&'a str], rows: &[R]) -> ParsedTable {
        ParsedTable {
            source: ParsedTableSource {
                name: "f.csv".to_string(),
                format: TableFormat::Csv,
            },
            header_row: 1,
            columns: columns.iter().map(|c| c.to_string()).collect(),
            rows: rows
                .iter()
                .map(|r| r.as_ref().iter().map(|c| Some(c.to_string())).collect())
                .collect(),
        }
    }

    /// The committed example CSVs are unquoted (verified) — a plain split is
    /// the honest test-side reader (the server links no CSV crate).
    fn csv_table(text: &str) -> ParsedTable {
        let mut lines = text.split('\n').filter(|l| !l.trim().is_empty());
        let header: Vec<String> = lines.next().unwrap().split(',').map(|s| s.to_string()).collect();
        let rows: Vec<Vec<Option<String>>> = lines
            .map(|l| l.split(',').map(|c| Some(c.to_string())).collect())
            .collect();
        ParsedTable {
            source: ParsedTableSource {
                name: "example.csv".to_string(),
                format: TableFormat::Csv,
            },
            header_row: 1,
            columns: header,
            rows,
        }
    }

    /// The board's measurements header.
    fn meas_columns() -> Vec<&'static str> {
        vec!["patient_id", "day", "marker", "value", "unit"]
    }

    #[test]
    fn test_fv2_inspect_patients_resolves_roles_and_outcome_errors() {
        let t = table(
            &["Patient ID", "pfs_time", "PFS Event", "os-time", "os_event", "Age", "year"],
            &[&["P1", "100", "1", "120", "0", "62", "x"]],
        );
        let f = inspect(&FileInspectionRequest {
            kind: FileTableKind::Patients,
            table: t,
        });
        assert_eq!(f.kind, FileTableKind::Patients);
        assert_eq!(f.source_name, "f.csv");
        // DEC-5 aliases resolve (patient id, pfs_time→pfs_days, os-time→os_days).
        assert_eq!(f.columns.resolved["patient_id"], "Patient ID");
        assert_eq!(f.columns.resolved["pfs_days"], "pfs_time");
        assert_eq!(f.columns.resolved["os_days"], "os-time");
        assert_eq!(f.columns.resolved["covariate:age"], "Age");
        // "year" is known to no rule → unresolved, never rejected.
        assert_eq!(f.columns.unresolved, vec!["year".to_string()]);
        assert_eq!(f.columns.covariate_columns.len(), 1);
        assert!(f.columns.covariate_columns[0].is_numeric);
        // The four board outcome columns are required (owner decision): the
        // missing os_event... wait — os_event IS present; missing? None here.
        assert!(f.problems.is_empty(), "clean patients file: {:?}", f.problems);
        assert_eq!(f.summary.rows, 1);
        assert!(f.summary.markers.is_empty(), "patients table has no markers");
        assert!(f.summary.draw_days.is_empty());
    }

    #[test]
    fn test_fv2_inspect_patients_missing_outcomes_report_r02_and_a02() {
        let t = table(&["patient_id", "age"], &[&["P1", "62"]]);
        let f = inspect(&FileInspectionRequest {
            kind: FileTableKind::Patients,
            table: t,
        });
        let codes: Vec<&str> = f.problems.iter().map(|p| p.code.code()).collect();
        // 4 board outcome columns missing (R02), plus the A02 no-outcome verdict.
        assert_eq!(
            codes.iter().filter(|c| **c == "R02").count(),
            4,
            "four outcome columns missing: {codes:?}"
        );
        assert!(codes.contains(&"A02"), "no outcome column: {codes:?}");
    }

    #[test]
    fn test_fv2_inspect_measurements_reports_by_row_the_board_cases() {
        let t = table(
            &meas_columns(),
            &[
                &["P1", "0", "ldh", "100", "U/L"],
                &["P1", "7", "LDH", "110", "U/L"],
                &["P1", "week 4", "ldh", "120", "U/L"],
            ],
        );
        let f = inspect(&FileInspectionRequest {
            kind: FileTableKind::Measurements,
            table: t,
        });
        let codes: Vec<(&str, Option<u32>, Option<String>)> = f
            .problems
            .iter()
            .map(|p| (p.code.code(), p.row, p.column.clone()))
            .collect();
        // The board's row-14 case: a non-numeric day reports the FILE row and
        // the cell text is in the message.
        assert!(
            codes.contains(&("R03", Some(4), Some("day".to_string()))),
            "row 3 (file row 4) day check: {codes:?}"
        );
        // ldh/LDH is one variant group with a join offer (never auto-joined).
        assert!(codes.iter().any(|(c, _, _)| *c == "A03"), "{codes:?}");
        // unit constant U/L, vocabulary candidate LDH → matches, no A04/A07.
        assert!(
            !codes.iter().any(|(c, _, _)| *c == "A04" || *c == "A07"),
            "matching unit is silent: {codes:?}"
        );
        // Summary: raw spelling counts + draw days (the unparseable day is
        // not a draw day).
        assert_eq!(f.summary.markers.len(), 2);
        assert_eq!(f.summary.markers[0].name, "ldh");
        assert_eq!(f.summary.markers[0].rows, 2);
        assert_eq!(f.summary.markers[1].name, "LDH");
        assert_eq!(f.summary.draw_days, vec![0.0, 7.0]);
    }

    #[test]
    fn test_fv2_inspect_no_recognizable_header_is_a01() {
        let t = table(&["foo", "bar"], &[&["x", "y"]]);
        let f = inspect(&FileInspectionRequest {
            kind: FileTableKind::Measurements,
            table: t,
        });
        assert_eq!(f.problems[0].code, ProblemCode::A01NoRecognizableHeader);
        assert_eq!(f.problems[0].row, Some(1));
        assert_eq!(f.columns.resolved.len(), 0);
        assert_eq!(f.columns.unresolved, vec!["foo".to_string(), "bar".to_string()]);
    }

    #[test]
    fn test_fv2_inspect_mixed_units_report_a04_error() {
        let t = table(
            &meas_columns(),
            &[
                &["P1", "0", "ldh", "100", "U/L"],
                &["P1", "7", "ldh", "110", "U/mL"],
            ],
        );
        let f = inspect(&FileInspectionRequest {
            kind: FileTableKind::Measurements,
            table: t,
        });
        let a04: Vec<_> = f
            .problems
            .iter()
            .filter(|p| p.code == ProblemCode::A04UnitDiffers)
            .collect();
        assert_eq!(a04.len(), 1);
        assert_eq!(a04[0].severity, ProblemSeverity::Error);
        assert!(a04[0].message.contains("U/L"));
        assert!(a04[0].message.contains("U/mL"));
    }

    #[test]
    fn test_fv2_inspect_absent_unit_on_matched_marker_is_a07() {
        let t = table(
            &["patient_id", "day", "marker", "value"],
            &[&["P1", "0", "ldh", "100"]],
        );
        let f = inspect(&FileInspectionRequest {
            kind: FileTableKind::Measurements,
            table: t,
        });
        assert!(
            f.problems
                .iter()
                .any(|p| p.code == ProblemCode::A07UnitAbsent && p.column.as_deref() == Some("ldh")),
            "A07 for the vocabulary-matched LDH column: {:?}",
            f.problems
        );
    }

    #[test]
    fn test_fv2_inspect_same_validate_codes_deterministic() {
        // ENGINE half of TEST-FV-7's determinism claim: a repeat inspect yields
        // a byte-equal response, and inspect + validate share the per-file
        // codes (the same validator code backs both screens — INV-3).
        let t = table(
            &meas_columns(),
            &[&["P1", "0", "ldh", "100", "U/L"], &["P1", "7", "LDH", "110", "U/L"]],
        );
        let req = FileInspectionRequest {
            kind: FileTableKind::Measurements,
            table: t.clone(),
        };
        let a = inspect(&req);
        let b = inspect(&req);
        assert_eq!(
            serde_json::to_vec(&a).unwrap(),
            serde_json::to_vec(&b).unwrap(),
            "repeat inspect is byte-equal"
        );
        let vr = crate::modules::file_validator::types::ValidationRequest {
            mode: ValidationMode::Predict,
            patients: None,
            measurements: t,
            joins: vec![],
            mapping: vec![],
            parameters: Default::default(),
        };
        let v = validate(&vr).expect("predict validate");
        for p in &a.problems {
            if p.code == ProblemCode::A03SpellingVariantGroup
                || p.code == ProblemCode::A06LargeFileNotice
            {
                continue;
            }
            assert!(
                v.problems.iter().any(|vp| vp.code == p.code && vp.row == p.row),
                "the per-file problem {} row {:?} is in the validate set too",
                p.code.code(),
                p.row
            );
        }
    }

    /// The committed synthetic example is inspectable with zero per-file
    /// problems (the example's M1/M2 markers have no unit problem — a.u. is
    /// the no-claim warning only at the unit layer, which the A04 warnings
    /// cover; ITEM-6's TEST-FV-14 "zero problems" wording needs the
    /// severity qualifier — recorded in DRIFT-1 ITEM-5).
    #[test]
    fn test_fv2_inspect_committed_example_has_no_header_or_row_errors() {
        let p = crate::modules::file_validator::assets::ASSETS.patients_example;
        let m = crate::modules::file_validator::assets::ASSETS.measurements_example;
        let fi = inspect(&FileInspectionRequest {
            kind: FileTableKind::Patients,
            table: csv_table(std::str::from_utf8(p).unwrap()),
        });
        assert!(
            fi.problems.iter().all(|pr| pr.severity == ProblemSeverity::Warning),
            "the example patients file has no row-level errors: {:?}",
            fi.problems
        );
        let fi = inspect(&FileInspectionRequest {
            kind: FileTableKind::Measurements,
            table: csv_table(std::str::from_utf8(m).unwrap()),
        });
        assert!(
            fi.problems
                .iter()
                .all(|pr| pr.severity == ProblemSeverity::Warning),
            "the example measurements file has no row-level errors: {}",
            fi.problems.iter().map(|p| p.code.code()).collect::<Vec<_>>().join(", ")
        );
    }
}
