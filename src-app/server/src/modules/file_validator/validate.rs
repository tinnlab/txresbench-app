//! The full validation engine — `validate.rs` (ITEM-5, PROV-FV-3): cross-table
//! checks, the user's joins and vocabulary mappings (DEC-12: applied only when
//! the user confirms), unit verdicts (DEC-10), per-patient marker coverage with
//! the 2026-10-19 baseline rule, and the EXACT `method_catalogue` inventory
//! body (CONS-FV-2 — the intake screens post it straight to
//! `POST /api/methods/eligibility`, so the type is the provider's own).
//!
//! Everything is pure over [`ValidationRequest`]: one request in, one
//! deterministic response out, no state between calls — a repeat call yields a
//! byte-equal body.
//!
//! ## The coverage definition (contract.md 2026-10-19)
//!
//! `baseline` = a draw at `day ≤ baseline_max_day` (pre-treatment negative
//! days are baseline); `on-treatment` = `baseline_max_day < day ≤
//! decision_day`. The marker-level counts are the plain per-window patient
//! counts (a patient counts once per window); the board's cohort ("baseline +
//! ≥ 1 on-treatment draw") is the intersection, derivable from the
//! `per_patient` entries ([`patient_cohort`] — TEST-FV-11 pins both readings).
//!
//! ## The join/mapping contract (DEC-12)
//!
//! A join offer is a spelling-variant group: every `variants` and the `key`
//! must be raw spellings of ONE group (normalized) — anything else is
//! [`ValidationError::InvalidJoin`]. A mapping key must be a marker column
//! key (post-join), and its `marker_id` must name a vocabulary entry — the
//! vocabulary is the only source of display_name / standard_ids / unit_family,
//! so a mapping to an unknown id is never silently degraded into an unmapped
//! column. Until a join is applied, an unjoined variant group is ONE marker
//! column carrying BOTH spellings (no auto-join — EXAMPLE-FV-1), while the
//! canonical bundle keeps the raw spellings as separate features unless the
//! join merged them (EXAMPLE-FV-5).
//!
//! ## The unit verdict (DEC-10)
//!
//! The vocabulary reference of a column at validate time is the user's MAPPING
//! (a candidate match is a suggestion until confirmed). The drop-time preview
//! (inspect) uses the best non-fuzzy candidate; validate's verdicts are the
//! confirmed ones. An unmapped column is classifier-only: a known unit family
//! is carried silently, an unrecognizable unit is the honest no-claim
//! warning.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use crate::modules::file_validator::inspect::build_model;
use crate::modules::file_validator::rules::{
    companion_base, resolve_column_role, validate_model, CanonicalModel, PatientRow, ValueRow,
};
use crate::modules::file_validator::types::{
    AnalysisParameters, FileProblem, FileTableKind, InventoryEligibilityRequest, JoinOffer,
    Limits, MarkerColumn, MarkerCoverage, MarkerMapping, MeasurementsSummary, PatientsSummary,
    ProblemCode, ProblemSeverity, UnitStatus, ValidationError, ValidationMode, ValidationRequest,
    ValidationResponse,
};
use crate::modules::file_validator::units::{
    compare_unit_to_canonical, infer_unit_family, marker_unit_facts, unit_absent_problem,
    unit_mismatch_problem, unit_mixed_problem, unit_unclassified_problem, MarkerUnitFacts,
    UnitAgreement,
};
use crate::modules::file_validator::vocab::{marker_matches_set, normalize_marker_name};
use crate::modules::method_catalogue::catalogue::marker_vocabulary;
use crate::modules::method_catalogue::eligibility::is_companion;
use crate::modules::method_catalogue::types::{
    PatientDrawCounts, StandardId, UnitFamily, VocabularyMarker,
};

// ─────────────────────────────────────────────────────────────────────────────
// The resolution (shared by `validate` and `canonical_bundle`)
// ─────────────────────────────────────────────────────────────────────────────

/// One post-join marker column: the column key, every raw spelling, the raw
/// unit cells and the user's confirmed mapping (when present).
pub(crate) struct ResolvedMarker {
    pub key: String,
    /// Every raw spelling with its FILE rows, file order.
    pub spellings: Vec<crate::modules::file_validator::vocab::MarkerSpelling>,
    pub unit_cells: Vec<(String, u32)>,
    pub mapping: Option<&'static VocabularyMarker>,
}

impl ResolvedMarker {
    fn unit_facts(&self) -> MarkerUnitFacts {
        marker_unit_facts(self.unit_cells.iter().map(|(t, r)| (t.as_str(), *r)))
    }
}

/// The resolved request: the canonical model, the post-join marker columns,
/// the normalized-group → join-key map and the raw-spelling → column-key map
/// (the bundle's feature resolution).
pub(crate) struct ResolvedRequest {
    pub mode: ValidationMode,
    pub parameters: AnalysisParameters,
    pub model: CanonicalModel,
    pub marker_columns: Vec<ResolvedMarker>,
    /// Normalized spelling group → the applied join key (the bundle merges the
    /// group's features into ONE effective feature only when joined).
    pub joined_groups: BTreeMap<String, String>,
    /// Trimmed raw spelling → post-join column key (coverage + column facts).
    pub spelling_to_key: BTreeMap<String, String>,
}

/// Validate the request shape and build the canonical model + the post-join
/// marker columns (the pure engine behind both the validate response and the
/// canonical bundle — one resolution, one join/mapping contract).
pub(crate) fn resolve_request(
    req: &ValidationRequest,
) -> Result<ResolvedRequest, ValidationError> {
    if req.mode == ValidationMode::Files && req.patients.is_none() {
        return Err(ValidationError::MissingPatients);
    }
    let model = build_model(req.patients.as_ref(), &req.measurements);
    let (marker_columns, joined_groups) = resolve_marker_columns(&model, &req.joins, &req.mapping)?;
    let spelling_to_key = marker_columns
        .iter()
        .flat_map(|c| {
            c.spellings
                .iter()
                .map(move |s| (s.spelling.clone(), c.key.clone()))
        })
        .collect();
    Ok(ResolvedRequest {
        mode: req.mode,
        parameters: req.parameters,
        model,
        marker_columns,
        joined_groups,
        spelling_to_key,
    })
}

/// The marker columns of the model: one per distinct normalized spelling, in
/// file order, with the user's joins and mappings applied (both validated).
fn resolve_marker_columns(
    model: &CanonicalModel,
    joins: &[JoinOffer],
    mapping: &[MarkerMapping],
) -> Result<(Vec<ResolvedMarker>, BTreeMap<String, String>), ValidationError> {
    // The pre-join groups (normalized identity → spellings + unit cells).
    let mut groups: Vec<(
        String,
        Vec<crate::modules::file_validator::vocab::MarkerSpelling>,
        Vec<(String, u32)>,
    )> = Vec::new();
    for row in &model.values {
        let Some(spelling) = row.marker.text() else { continue };
        let norm = normalize_marker_name(spelling);
        let unit_text = row
            .unit
            .as_ref()
            .and_then(|u| u.text())
            .map(|t| t.to_string());
        let spelling_row = row.marker.row;
        match groups.iter_mut().find(|(k, _, _)| k == &norm) {
            Some((_, spellings, unit_cells)) => {
                match spellings.iter_mut().find(|s| s.spelling == spelling) {
                    Some(s) => s.rows.push(spelling_row),
                    None => spellings.push(crate::modules::file_validator::vocab::MarkerSpelling {
                        spelling: spelling.to_string(),
                        rows: vec![spelling_row],
                    }),
                }
                if let Some(t) = unit_text {
                    unit_cells.push((t, spelling_row));
                }
            },
            None => groups.push((
                norm,
                vec![crate::modules::file_validator::vocab::MarkerSpelling {
                    spelling: spelling.to_string(),
                    rows: vec![spelling_row],
                }],
                unit_text.map(|t| (t, spelling_row)).into_iter().collect(),
            )),
        }
    }

    // Apply the joins: all names of one join must be raw spellings of ONE
    // group, and a group joins at most once (the A03 answer, DEC-12).
    let mut joined_groups: BTreeMap<String, String> = BTreeMap::new();
    for join in joins {
        let norm = normalize_marker_name(&join.key);
        for variant in &join.variants {
            if normalize_marker_name(variant) != norm {
                return Err(ValidationError::InvalidJoin {
                    key: variant.clone(),
                });
            }
        }
        let Some((_, spellings, _)) = groups.iter().find(|(k, _, _)| k == &norm) else {
            return Err(ValidationError::InvalidJoin {
                key: join.key.clone(),
            });
        };
        for name in join.variants.iter().chain(std::iter::once(&join.key)) {
            if !spellings.iter().any(|s| s.spelling == *name) {
                return Err(ValidationError::InvalidJoin {
                    key: name.clone(),
                });
            }
        }
        if joined_groups.contains_key(&norm) {
            return Err(ValidationError::InvalidJoin {
                key: join.key.clone(),
            });
        }
        joined_groups.insert(norm, join.key.clone());
    }

    let mut columns: Vec<ResolvedMarker> = Vec::new();
    for (norm, spellings, unit_cells) in groups {
        let key = joined_groups
            .get(&norm)
            .cloned()
            .unwrap_or_else(|| spellings[0].spelling.clone());
        columns.push(ResolvedMarker {
            key,
            spellings,
            unit_cells,
            mapping: None,
        });
    }

    // Apply the mappings (the user-confirmed vocabulary identity).
    let vocabulary = marker_vocabulary();
    for m in mapping {
        let Some(column) = columns.iter_mut().find(|c| c.key == m.key) else {
            return Err(ValidationError::InvalidJoin {
                key: m.key.clone(),
            });
        };
        let entry = vocabulary
            .iter()
            .find(|e| e.id.eq_ignore_ascii_case(&m.marker_id))
            .ok_or_else(|| ValidationError::InvalidJoin {
                key: m.marker_id.clone(),
            })?;
        column.mapping = Some(entry);
    }
    Ok((columns, joined_groups))
}

/// The per-column unit verdict, its problem and the INVENTORY unit family
/// (DEC-10): the mapping's entry is the vocabulary reference; an unmapped
/// column is classifier-only. The inventory family of a MAPPED column stays
/// the vocabulary's authoritative one (DRIFT-1 ITEM-4 #3), the classifier's
/// verdict for an unmapped one.
fn column_unit_verdict(
    column: &ResolvedMarker,
) -> (UnitStatus, Option<FileProblem>, UnitFamily) {
    let facts = column.unit_facts();
    match column.mapping {
        Some(entry) => {
            if facts.is_absent() {
                return (UnitStatus::Absent, Some(unit_absent_problem(&column.key)), entry.unit_family);
            }
            if !facts.is_constant() {
                return (
                    UnitStatus::Mixed,
                    unit_mixed_problem(&column.key, &facts),
                    UnitFamily::None,
                );
            }
            let Some(unit) = facts.the_unit() else {
                return (UnitStatus::Absent, Some(unit_absent_problem(&column.key)), entry.unit_family);
            };
            let agreement =
                compare_unit_to_canonical(&unit.spelling, &entry.canonical_unit, entry.unit_family);
            match agreement {
                UnitAgreement::Matches => (UnitStatus::Matches, None, entry.unit_family),
                UnitAgreement::Family(_) => (
                    UnitStatus::Family,
                    Some(unit_mismatch_problem(
                        &column.key,
                        &unit.spelling,
                        &entry.canonical_unit,
                        agreement,
                    )),
                    entry.unit_family,
                ),
                UnitAgreement::Unknown => (
                    UnitStatus::Unknown,
                    Some(unit_mismatch_problem(
                        &column.key,
                        &unit.spelling,
                        &entry.canonical_unit,
                        agreement,
                    )),
                    entry.unit_family,
                ),
            }
        },
        None => {
            if facts.is_absent() {
                return (UnitStatus::Absent, None, UnitFamily::None);
            }
            if !facts.is_constant() {
                return (
                    UnitStatus::Mixed,
                    unit_mixed_problem(&column.key, &facts),
                    UnitFamily::None,
                );
            }
            let Some(unit) = facts.the_unit() else {
                return (UnitStatus::Absent, None, UnitFamily::None);
            };
            let family = infer_unit_family(&unit.spelling);
            if family == UnitFamily::None {
                (
                    UnitStatus::Unknown,
                    Some(unit_unclassified_problem(&column.key, &unit.spelling)),
                    family,
                )
            } else {
                (UnitStatus::Unknown, None, family)
            }
        },
    }
}

/// The per-marker coverage math (contract.md 2026-10-19): baseline draw =
/// day ≤ `baseline_max_day`; on-treatment draw = `baseline_max_day < day ≤
/// decision_day`. The per-patient entries cover EVERY patient with ≥ 1 value
/// row (draw counts 0/0 for rows whose day is unparseable — R03 reports
/// those), and the board's cohort is the intersection ([`patient_cohort`]).
fn coverage_of(
    values: &[ValueRow],
    key: &str,
    spelling_to_key: &BTreeMap<String, String>,
    parameters: &AnalysisParameters,
) -> (MarkerCoverage, Vec<PatientDrawCounts>) {
    let mut patients: Vec<(String, u32, u32)> = Vec::new();
    let mut index: BTreeMap<String, usize> = BTreeMap::new();
    for row in values {
        let Some(marker) = row.marker.text() else { continue };
        if !spelling_to_key.get(marker).is_some_and(|k| k == key) {
            continue;
        }
        let Some(pid) = row.patient_id.text() else { continue };
        let i = match index.get(pid) {
            Some(&i) => i,
            None => {
                index.insert(pid.to_string(), patients.len());
                patients.push((pid.to_string(), 0, 0));
                patients.len() - 1
            },
        };
        if let Some(day) = row.day.parse_f64() {
            if day <= parameters.baseline_max_day {
                patients[i].1 += 1;
            } else if day <= parameters.decision_day {
                patients[i].2 += 1;
            }
        }
    }
    let coverage = MarkerCoverage {
        patients_with_value: patients.len() as u32,
        patients_with_baseline: patients.iter().filter(|p| p.1 > 0).count() as u32,
        patients_with_ontreatment: patients.iter().filter(|p| p.2 > 0).count() as u32,
    };
    let per_patient = patients
        .into_iter()
        .map(|(patient_key, baseline_draws, ontreatment_draws)| PatientDrawCounts {
            patient_key,
            baseline_draws,
            ontreatment_draws,
        })
        .collect();
    (coverage, per_patient)
}

/// The board's cohort count: patients with a baseline draw AND ≥ 1
/// on-treatment draw (the intersection of the two windows — TEST-FV-11 pins
/// the relationship between the per-window counts, the cohort and the
/// `per_patient` entries).
pub fn patient_cohort(per_patient: &[PatientDrawCounts]) -> u32 {
    per_patient
        .iter()
        .filter(|p| p.baseline_draws > 0 && p.ontreatment_draws > 0)
        .count() as u32
}

/// Whether the column is a detection call (the provider's fact set): the
/// resolved unit family is Detection, or the spelling itself is a
/// `__detected`/`__lod` companion (the detection result of its base — the
/// provider's "a signal, not a value" reading of these columns).
fn column_is_detection_call(column: &ResolvedMarker, unit_family: UnitFamily) -> bool {
    unit_family == UnitFamily::Detection || is_companion(&column.key)
}

/// Whether the column's base carries a detection companion in the file (a
/// `__detected`/`__lod` sibling column of the same base — R13's suffix
/// contract; companions never rank or match).
fn column_has_detection_companion(column: &ResolvedMarker, columns: &[ResolvedMarker]) -> bool {
    if is_companion(&column.key) {
        return false;
    }
    let base = column.key.clone();
    columns
        .iter()
        .any(|other| is_companion(&other.key) && companion_base(&other.key) == base)
}

// ─────────────────────────────────────────────────────────────────────────────
// The validate response
// ─────────────────────────────────────────────────────────────────────────────

/// The primary outcome of one patients-table row: the first resolvable
/// COMPLETE pair, pfs → os → responder (a complete pair = both cells non-blank
/// AND type-parseable — an event without a time is not an outcome), together
/// with the pair's indicator value (the event/response flag the time belongs
/// to). The pair ordering is the single ladder the summary's facts use:
/// `with_primary_outcome` (a complete pair exists) and
/// `primary_outcome_events` (that pair's indicator is 1) come from the SAME
/// resolution, so the two counts can never disagree about which patients an
/// "event" belongs to (qa-fixes ITEM-6, F1).
fn primary_outcome(row: &PatientRow) -> Option<(f64, i64)> {
    if let (Some(time), Some(event)) = (row.pfs_days.parse_f64(), row.pfs_event.parse_i64()) {
        return Some((time, event));
    }
    if let (Some(time), Some(event)) = (row.os_days.parse_f64(), row.os_event.parse_i64()) {
        return Some((time, event));
    }
    if let (Some(day), Some(response)) = (row.response_day.parse_f64(), row.responder.parse_i64()) {
        return Some((day, response));
    }
    None
}

/// The patients summary (PROV-FV-3): row count, patients with a resolvable
/// primary outcome (complete pair), events (the primary pair's indicator is
/// 1 — pfs_event/os_event = 1, responder = 1, on the same ladder) and the
/// median follow-up time.
fn patients_summary(rows: &[PatientRow]) -> PatientsSummary {
    let mut times: Vec<f64> = Vec::new();
    let mut events: u32 = 0;
    for row in rows {
        if let Some((time, indicator)) = primary_outcome(row) {
            times.push(time);
            if indicator == 1 {
                events += 1;
            }
        }
    }
    let median = if times.is_empty() {
        None
    } else {
        times.sort_by(f64::total_cmp);
        let mid = times.len() / 2;
        if times.len() % 2 == 0 {
            Some((times[mid - 1] + times[mid]) / 2.0)
        } else {
            Some(times[mid])
        }
    };
    PatientsSummary {
        rows: rows.len() as u32,
        with_primary_outcome: times.len() as u32,
        primary_outcome_events: events,
        median_followup_days: median,
    }
}

/// The validate call (PROV-FV-3): the full problem set (per-file +
/// cross-table + units + joins + outcome availability), the resolved marker
/// columns, both summaries and the provider's own inventory body.
pub fn validate(req: &ValidationRequest) -> Result<ValidationResponse, ValidationError> {
    let resolved = resolve_request(req)?;
    let ResolvedRequest {
        parameters,
        model,
        marker_columns,
        spelling_to_key,
        ..
    } = &resolved;

    let mut problems = validate_model(model);
    // A06: the large-file notice (never a cap — DEC-9).
    if req.measurements.rows.len() as u64 > Limits::A06_NOTICE_VALUE_ROWS {
        problems.push(FileProblem::new(
            ProblemCode::A06LargeFileNotice,
            ProblemSeverity::Warning,
            None,
            None,
            format!(
                "this measurements table carries {} rows (> {}); the per-row checks may take a moment",
                req.measurements.rows.len(),
                Limits::A06_NOTICE_VALUE_ROWS
            ),
        ));
    }
    // A03: the unanswered spelling-variant join offers (an applied join
    // answers its offer; an unjoined group stays a question — DEC-12).
    for column in marker_columns {
        if column.spellings.len() > 1
            && !resolved
                .joined_groups
                .contains_key(&normalize_marker_name(&column.key))
        {
            problems.push(FileProblem::new(
                ProblemCode::A03SpellingVariantGroup,
                ProblemSeverity::Warning,
                None,
                None,
                format!(
                    "marker spellings {} look the same — join them?",
                    column
                        .spellings
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
                ),
            ));
        }
    }

    // The per-column facts + unit/candidate problems.
    let mut markers: Vec<MarkerColumn> = Vec::new();
    for column in marker_columns {
        let (status, unit_problem, _inventory_family) = column_unit_verdict(column);
        if let Some(p) = unit_problem {
            problems.push(p);
        }
        let set = marker_matches_set(&column.key);
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
        let unit = column.unit_facts().the_unit().map(|u| u.spelling.clone());
        let (coverage, _per_patient) = coverage_of(
            &model.values,
            &column.key,
            spelling_to_key,
            parameters,
        );
        let n_rows = model
            .values
            .iter()
            .filter(|r| {
                r.marker
                    .text()
                    .is_some_and(|m| spelling_to_key.get(m) == Some(&column.key))
            })
            .count() as u32;
        markers.push(MarkerColumn {
            key: column.key.clone(),
            spellings: column.spellings.iter().map(|s| s.spelling.clone()).collect(),
            n_rows,
            unit,
            unit_status: status,
            vocabulary: set.matches,
            coverage,
        });
    }

    // The measurements summary.
    let mut patients_list: Vec<String> = Vec::new();
    let mut draw_days: Vec<f64> = Vec::new();
    for row in &model.values {
        if let Some(pid) = row.patient_id.text() {
            if !patients_list.iter().any(|p| p == pid) {
                patients_list.push(pid.to_string());
            }
        }
        if let Some(day) = row.day.parse_f64() {
            draw_days.push(day);
        }
    }
    draw_days.sort_by(f64::total_cmp);
    draw_days.dedup();

    Ok(ValidationResponse {
        problems,
        markers,
        patients: (resolved.mode == ValidationMode::Files)
            .then(|| patients_summary(&model.patients)),
        measurements: MeasurementsSummary {
            rows: model.values.len() as u32,
            patients: patients_list.len() as u32,
            distinct_draw_days: draw_days,
        },
        inventory: build_inventory(&resolved),
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// The inventory (CONS-FV-2: the provider's exact body)
// ─────────────────────────────────────────────────────────────────────────────

/// The provider's exact inventory body: the post-join marker-column facts, the
/// patients table's covariates, the analysis parameters, and the file's
/// outcome-column facts (files mode only). `per_patient` is carried — the file
/// layer has the draw counts.
fn build_inventory(resolved: &ResolvedRequest) -> InventoryEligibilityRequest {
    let model = &resolved.model;
    let mut patients_list: Vec<String> = Vec::new();
    for row in &model.values {
        if let Some(pid) = row.patient_id.text() {
            if !patients_list.iter().any(|p| p == pid) {
                patients_list.push(pid.to_string());
            }
        }
    }
    let mut inv_markers = Vec::new();
    for column in &resolved.marker_columns {
        let (_, _unit_problem, inventory_family) = column_unit_verdict(column);
        let reference = column.mapping;
        let display_name = reference
            .map(|e| e.display_name.clone())
            .unwrap_or_else(|| column.key.clone());
        let standard_ids = reference
            .map(|e| {
                vec![StandardId {
                    system: e.system.as_str().to_string(),
                    id: e.id.clone(),
                }]
            })
            .unwrap_or_default();
        let (coverage, per_patient) = coverage_of(
            &model.values,
            &column.key,
            &resolved.spelling_to_key,
            &resolved.parameters,
        );
        inv_markers.push(crate::modules::method_catalogue::types::InventoryMarker {
            key: column.key.clone(),
            display_name,
            unit_family: inventory_family,
            standard_ids,
            is_detection_call: column_is_detection_call(column, inventory_family),
            has_detection_companion: column_has_detection_companion(
                column,
                &resolved.marker_columns,
            ),
            n_patients_with_value: coverage.patients_with_value,
            n_patients_with_baseline: coverage.patients_with_baseline,
            n_patients_with_ontreatment: coverage.patients_with_ontreatment,
            per_patient: Some(per_patient),
        });
    }
    let covariate_names: Vec<String> = model
        .patients
        .iter()
        .flat_map(|p| p.covariates.iter().map(|(n, _)| n.clone()))
        .fold(Vec::<String>::new(), |mut acc, name| {
            if !acc.contains(&name) {
                acc.push(name);
            }
            acc
        });
    let covariates = covariate_names
        .iter()
        .map(|key| crate::modules::method_catalogue::types::InventoryCovariate {
            key: key.clone(),
            display_name: key.clone(),
            unit_family: UnitFamily::None,
            standard_ids: Vec::new(),
        })
        .collect();
    let outcomes = if resolved.mode == ValidationMode::Files {
        let resolved_keys: BTreeSet<String> = model
            .patients_shape
            .as_ref()
            .map(|s| {
                s.columns
                    .iter()
                    .filter_map(|c| resolve_column_role(c, FileTableKind::Patients).map(|r| r.wire_key()))
                    .collect()
            })
            .unwrap_or_default();
        Some(crate::modules::method_catalogue::types::FileOutcomes {
            has_responder: resolved_keys.contains("responder"),
            has_response_day: resolved_keys.contains("response_day"),
            has_event: resolved_keys.contains("pfs_event") || resolved_keys.contains("os_event"),
            has_survival_day: resolved_keys.contains("pfs_days") || resolved_keys.contains("os_days"),
        })
    } else {
        None
    };
    InventoryEligibilityRequest {
        patients: patients_list.len() as u32,
        decision_day: resolved.parameters.decision_day,
        baseline_max_day: resolved.parameters.baseline_max_day,
        markers: inv_markers,
        covariates,
        outcomes,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-FV-9/10/11 + the board scenario's engine half (TEST-FV-7)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::file_validator::types::{
        ParsedTable, ParsedTableSource, TableFormat,
    };

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

    fn meas_cols() -> Vec<&'static str> {
        vec!["patient_id", "day", "marker", "value", "unit"]
    }

    fn req(
        mode: ValidationMode,
        patients: Option<ParsedTable>,
        measurements: ParsedTable,
        joins: Vec<JoinOffer>,
        mapping: Vec<MarkerMapping>,
        decision_day: f64,
        baseline_max_day: f64,
    ) -> ValidationRequest {
        ValidationRequest {
            mode,
            patients,
            measurements,
            joins,
            mapping,
            parameters: AnalysisParameters {
                decision_day,
                baseline_max_day,
            },
        }
    }

    #[test]
    fn test_fv10_joins_merge_spellings_into_one_column() {
        let measurements = table(
            &meas_cols(),
            &[
                &["P1", "0", "ldh", "100", "U/L"],
                &["P1", "7", "LDH", "110", "U/L"],
                &["P2", "0", "ldh", "90", "U/L"],
            ],
        );
        let no_join = req(
            ValidationMode::Predict,
            None,
            measurements.clone(),
            vec![],
            vec![],
            56.0,
            0.0,
        );
        let v_no_join = validate(&no_join).expect("predict");
        // Without a join the variant group is ONE column carrying both
        // spellings (no auto-join — EXAMPLE-FV-1), key = first spelling.
        assert_eq!(v_no_join.markers.len(), 1);
        assert_eq!(v_no_join.markers[0].key, "ldh");
        assert_eq!(
            v_no_join.markers[0].spellings,
            vec!["ldh".to_string(), "LDH".to_string()]
        );
        assert_eq!(v_no_join.markers[0].n_rows, 3);
        assert!(
            v_no_join
                .problems
                .iter()
                .any(|p| p.code == ProblemCode::A03SpellingVariantGroup),
            "the offer is unanswered"
        );
        // The join answers the offer: one column, key = the user's spelling.
        let joined = req(
            ValidationMode::Predict,
            None,
            measurements,
            vec![JoinOffer {
                variants: vec!["ldh".to_string(), "LDH".to_string()],
                key: "LDH".to_string(),
            }],
            vec![],
            56.0,
            0.0,
        );
        let v = validate(&joined).expect("predict with a join");
        assert_eq!(v.markers.len(), 1);
        assert_eq!(v.markers[0].key, "LDH");
        assert_eq!(
            v.markers[0].spellings,
            vec!["ldh".to_string(), "LDH".to_string()]
        );
        assert_eq!(v.markers[0].n_rows, 3, "n_rows is the summed count");
        assert!(
            !v.problems
                .iter()
                .any(|p| p.code == ProblemCode::A03SpellingVariantGroup),
            "the accepted join answers its offer"
        );
    }

    #[test]
    fn test_fv10_mapping_fills_vocabulary_facts() {
        let patients = table(
            &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
            &[&["P1", "100", "1", "120", "0"]],
        );
        let measurements = table(
            &meas_cols(),
            &[&["P1", "0", "LDH", "100", "U/L"], &["P1", "7", "LDH", "110", "U/L"]],
        );
        // The shipped catalogue's LDH entry (LOINC 14804-9, family none,
        // canonical U/L — the ITEM-4 smoke binding).
        let r = req(
            ValidationMode::Files,
            Some(patients),
            measurements,
            vec![],
            vec![MarkerMapping {
                key: "LDH".to_string(),
                marker_id: "14804-9".to_string(),
            }],
            56.0,
            0.0,
        );
        let v = validate(&r).expect("files validate");
        let column = &v.markers[0];
        assert_eq!(column.key, "LDH");
        assert_eq!(column.unit_status, UnitStatus::Matches);
        assert!(column.vocabulary.iter().any(|m| m.marker_id == "14804-9"));
        let inv_marker = &v.inventory.markers[0];
        assert_eq!(inv_marker.standard_ids[0].id, "14804-9");
        assert_eq!(inv_marker.standard_ids[0].system, "LOINC");
        assert_eq!(inv_marker.display_name, "LDH");
        assert_eq!(inv_marker.unit_family, UnitFamily::None);
        let outcomes = v.inventory.outcomes.expect("files mode carries outcomes");
        assert!(outcomes.has_survival_day);
        assert!(outcomes.has_event);
        assert!(!outcomes.has_responder);
    }

    #[test]
    fn test_fv10_unmapped_column_keeps_user_spelling_and_classified_family() {
        let measurements = table(
            &meas_cols(),
            &[&["P1", "0", "M1", "42", "ng/mL"], &["P1", "7", "M1", "43", "ng/mL"]],
        );
        let r = req(ValidationMode::Predict, None, measurements, vec![], vec![], 56.0, 0.0);
        let v = validate(&r).expect("predict");
        let column = &v.markers[0];
        assert_eq!(column.key, "M1");
        assert!(column.vocabulary.is_empty(), "M1 is no vocabulary entry");
        // The classifier knows ng/mL → the family is carried, no false
        // warning.
        assert_eq!(column.unit_status, UnitStatus::Unknown);
        assert!(
            !v.problems
                .iter()
                .any(|p| p.code == ProblemCode::A04UnitDiffers)
        );
        let inv_marker = &v.inventory.markers[0];
        assert_eq!(inv_marker.unit_family, UnitFamily::ConcentrationMass);
        assert!(inv_marker.standard_ids.is_empty());
        assert_eq!(inv_marker.display_name, "M1");
    }

    #[test]
    fn test_fv10_invalid_join_and_mapping_are_the_engine_error() {
        let measurements = table(&meas_cols(), &[&["P1", "0", "LDH", "100", "U/L"]]);
        // A join variant from a different marker column.
        let r = req(
            ValidationMode::Predict,
            None,
            measurements.clone(),
            vec![JoinOffer {
                variants: vec!["cea".to_string()],
                key: "LDH".to_string(),
            }],
            vec![],
            56.0,
            0.0,
        );
        let err = validate(&r).err().expect("expected INVALID_JOIN");
        assert_eq!(err, ValidationError::InvalidJoin { key: "cea".to_string() });
        // A mapping key that is not a marker column key.
        let r = req(
            ValidationMode::Predict,
            None,
            measurements.clone(),
            vec![],
            vec![MarkerMapping {
                key: "cea".to_string(),
                marker_id: "14804-9".to_string(),
            }],
            56.0,
            0.0,
        );
        let err = validate(&r).err().expect("expected INVALID_JOIN");
        assert_eq!(err, ValidationError::InvalidJoin { key: "cea".to_string() });
        // A mapping to an id the vocabulary does not carry is never silently
        // degraded into an unmapped column.
        let r = req(
            ValidationMode::Predict,
            None,
            measurements,
            vec![],
            vec![MarkerMapping {
                key: "LDH".to_string(),
                marker_id: "no-such-id".to_string(),
            }],
            56.0,
            0.0,
        );
        let err = validate(&r).err().expect("expected INVALID_JOIN");
        assert_eq!(err, ValidationError::InvalidJoin { key: "no-such-id".to_string() });
    }

    #[test]
    fn test_fv9_predict_mode_has_no_patients_side() {
        let measurements = table(
            &meas_cols(),
            &[
                &["P1", "0", "M1", "42", "a.u."],
                &["P1", "7", "M1", "43", "a.u."],
                &["P2", "0", "M1", "40", "a.u."],
            ],
        );
        let r = req(ValidationMode::Predict, None, measurements.clone(), vec![], vec![], 56.0, 0.0);
        let v = validate(&r).expect("predict mode is valid");
        assert!(v.patients.is_none());
        assert_eq!(v.measurements.patients, 2);
        assert_eq!(v.inventory.patients, 2);
        assert!(
            v.inventory.outcomes.is_none(),
            "no patients side → no outcome facts"
        );
        // The same measurements table in files mode without the patients table
        // is the MISSING_PATIENTS error.
        let r = req(ValidationMode::Files, None, measurements, vec![], vec![], 56.0, 0.0);
        let err = validate(&r).err().expect("expected MISSING_PATIENTS");
        assert_eq!(err, ValidationError::MissingPatients);
    }

    #[test]
    fn test_fv11_coverage_math_pins_both_windows_and_the_cohort() {
        // 151 synthetic patients: 60 with baseline+early on-treatment (10/21),
        // 60 with baseline+late on-treatment (35/42/70), 20 baseline-only,
        // 6 on-treatment-only at day 70, 5 on-treatment-only at day 10.
        let mut patients: Vec<Vec<String>> = Vec::new();
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut schedule = |p: &str, baseline: &[&str], ontreatment: &[&str]| {
            patients.push(vec![
                p.to_string(),
                "100".to_string(),
                "1".to_string(),
                "120".to_string(),
                "0".to_string(),
            ]);
            for &d in baseline {
                rows.push(vec![
                    p.to_string(),
                    d.to_string(),
                    "M1".to_string(),
                    "42".to_string(),
                    "a.u.".to_string(),
                ]);
            }
            for &d in ontreatment {
                rows.push(vec![
                    p.to_string(),
                    d.to_string(),
                    "M1".to_string(),
                    "43".to_string(),
                    "a.u.".to_string(),
                ]);
            }
        };
        for i in 0..60 {
            schedule(&format!("P{i:03}"), &["0"], &["10", "21"]);
        }
        for i in 60..120 {
            schedule(&format!("P{i:03}"), &["0"], &["35", "42", "70"]);
        }
        for i in 120..140 {
            schedule(&format!("P{i:03}"), &["0"], &[]);
        }
        for i in 140..146 {
            schedule(&format!("P{i:03}"), &[], &["70"]);
        }
        for i in 146..151 {
            schedule(&format!("P{i:03}"), &[], &["10"]);
        }
        let patients_table = table(
            &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
            &patients
                .iter()
                .map(|r| r.iter().map(|s| s.as_str()).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
        );
        let measurements = table(
            &meas_cols(),
            &rows
                .iter()
                .map(|r| r.iter().map(|s| s.as_str()).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
        );
        let r = req(
            ValidationMode::Files,
            Some(patients_table),
            measurements,
            vec![],
            vec![],
            56.0,
            0.0,
        );
        let v = validate(&r).expect("files validate");
        let column = &v.markers[0];
        assert_eq!(column.coverage.patients_with_value, 151);
        assert_eq!(column.coverage.patients_with_baseline, 140);
        assert_eq!(column.coverage.patients_with_ontreatment, 125);
        let per_patient = v.inventory.markers[0].per_patient.as_ref().expect("carried");
        assert_eq!(per_patient.len(), 151, "every patient with a value row");
        assert_eq!(patient_cohort(per_patient), 120, "the board's cohort");
        let early = per_patient.iter().find(|p| p.patient_key == "P000").unwrap();
        assert_eq!(early.baseline_draws, 1);
        assert_eq!(early.ontreatment_draws, 2);
        let late = per_patient.iter().find(|p| p.patient_key == "P100").unwrap();
        assert_eq!(late.baseline_draws, 1);
        // At decision_day 56 the draw at day 70 is beyond the on-treatment
        // window (35, 42 count, 70 does not) — the window bound is pinned.
        assert_eq!(late.ontreatment_draws, 2);
        let baseline_only = per_patient.iter().find(|p| p.patient_key == "P120").unwrap();
        assert_eq!(baseline_only.baseline_draws, 1);
        assert_eq!(baseline_only.ontreatment_draws, 0);
        let late_only = per_patient.iter().find(|p| p.patient_key == "P140").unwrap();
        assert_eq!(late_only.baseline_draws, 0);
        // P140's only draw is at day 70 — beyond decision_day 56, so the
        // on-treatment window counts 0 (the day-84 variant counts it: 131).
        assert_eq!(late_only.ontreatment_draws, 0);
        let early_only = per_patient.iter().find(|p| p.patient_key == "P146").unwrap();
        assert_eq!(early_only.baseline_draws, 0);
        assert_eq!(early_only.ontreatment_draws, 1);
        // decision_day moves the window in the documented direction.
        let mut r28 = r.clone();
        r28.parameters.decision_day = 28.0;
        let v28 = validate(&r28).expect("files validate");
        assert_eq!(v28.markers[0].coverage.patients_with_ontreatment, 65);
        let mut r84 = r.clone();
        r84.parameters.decision_day = 84.0;
        let v84 = validate(&r84).expect("files validate");
        assert_eq!(v84.markers[0].coverage.patients_with_ontreatment, 131);
        // A repeat call is byte-equal (determinism).
        assert_eq!(
            serde_json::to_vec(&v).unwrap(),
            serde_json::to_vec(&v).unwrap()
        );
    }

    #[test]
    fn test_fv7_board_scenario_engine_half() {
        // The board C scenario: row 14 day "week 4", rows 88..91 a patient not
        // in the patients table, and the ldh/LDH variant group.
        let patients: Vec<Vec<String>> = (0..12)
            .map(|i| {
                vec![
                    format!("P{i:04}"),
                    "100".to_string(),
                    "1".to_string(),
                    "120".to_string(),
                    "0".to_string(),
                ]
            })
            .collect();
        // 84 rows (12 patients × 7): ldh/LDH ×2 + M1 ×5 per patient. The bad
        // row inserts at data index 12 = file row 14.
        let mut measurements: Vec<Vec<String>> = Vec::new();
        for i in 0..12usize {
            for (day, marker) in [
                ("0", "ldh"),
                ("7", "LDH"),
                ("0", "M1"),
                ("14", "M1"),
                ("28", "M1"),
                ("42", "M1"),
                ("56", "M1"),
            ] {
                measurements.push(vec![
                    format!("P{i:04}"),
                    day.to_string(),
                    marker.to_string(),
                    "100".to_string(),
                    "U/L".to_string(),
                ]);
            }
        }
        // Data index 12 = file row 14: the board's "week 4" day.
        measurements.insert(
            12,
            vec![
                "P0009".to_string(),
                "week 4".to_string(),
                "ldh".to_string(),
                "100".to_string(),
                "U/L".to_string(),
            ],
        );
        // Fill to data index 85 (file row 87): one more row so the four P0187
        // rows land at data indexes 86..89 = file rows 88..91 (the board's
        // "Rows 88 to 91").
        measurements.push(vec![
            "P0011".to_string(),
            "70".to_string(),
            "M1".to_string(),
            "100".to_string(),
            "U/L".to_string(),
        ]);
        assert_eq!(measurements.len(), 86);
        for _ in 0..4 {
            measurements.push(vec![
                "P0187".to_string(),
                "0".to_string(),
                "ldh".to_string(),
                "100".to_string(),
                "U/L".to_string(),
            ]);
        }
        let patients_table = table(
            &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
            &patients
                .iter()
                .map(|r| r.iter().map(|s| s.as_str()).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
        );
        let measurements_table = table(
            &meas_cols(),
            &measurements
                .iter()
                .map(|r| r.iter().map(|s| s.as_str()).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
        );
        let r = req(
            ValidationMode::Files,
            Some(patients_table),
            measurements_table,
            vec![],
            vec![],
            56.0,
            0.0,
        );
        let v = validate(&r).expect("files validate");
        let r03: Vec<_> = v
            .problems
            .iter()
            .filter(|p| p.code == ProblemCode::R03ColumnTypes && p.row == Some(14))
            .collect();
        assert_eq!(r03.len(), 1, "row 14 day 'week 4' → R03: {:?}", v.problems);
        assert!(r03[0].message.contains("week 4"));
        let r08: Vec<_> = v
            .problems
            .iter()
            .filter(|p| p.code == ProblemCode::R08ValuesPatientExists)
            .collect();
        assert_eq!(r08.len(), 4, "four measurement rows of P0187 → 4×R08");
        assert!(r08.iter().all(|p| (88..=91).contains(&p.row.unwrap())));
        let r15: Vec<_> = v
            .problems
            .iter()
            .filter(|p| p.code == ProblemCode::R15SamplesPatientExists)
            .collect();
        assert_eq!(r15.len(), 1, "one derived sample of P0187 → 1×R15");
        let a03: Vec<_> = v
            .problems
            .iter()
            .filter(|p| p.code == ProblemCode::A03SpellingVariantGroup)
            .collect();
        assert_eq!(a03.len(), 1, "the ldh/LDH join offer");
        let ldh = v.markers.iter().find(|m| m.key == "ldh").unwrap();
        assert_eq!(ldh.spellings, vec!["ldh".to_string(), "LDH".to_string()]);
    }

    #[test]
    fn test_fv15_patients_summary_counts_events_not_outcome_patients() {
        // qa-fixes ITEM-6, F1: the board's "N progressions or deaths" is the
        // EVENTS count (the primary outcome pair's indicator is 1), never the
        // patients-with-an-outcome count (the old display read
        // `with_primary_outcome` and reported "94 progressions or deaths" for
        // a file with 82 events). The ladder is the same one the outcome time
        // uses: pfs → os → responder, first COMPLETE pair wins.
        let patients = table(
            &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
            &[
                &["P1", "10", "1", "20", "1"], // pfs pair, event
                &["P2", "30", "0", "30", "0"], // pfs pair, censored
                &["P3", "", "", "15", "1"],    // complete OS pair only → event
                &["P4", "40", "1", "", "1"],   // pfs pair wins (os time missing)
            ],
        );
        let empty_meas: &[&[&str]] = &[];
        let v = validate(&req(
            ValidationMode::Files,
            Some(patients),
            table(&meas_cols(), empty_meas),
            vec![],
            vec![],
            56.0,
            0.0,
        ))
        .expect("validate");
        let s = v.patients.as_ref().expect("patients side");
        assert_eq!(s.rows, 4);
        assert_eq!(s.with_primary_outcome, 4, "all four have a complete pair");
        assert_eq!(s.primary_outcome_events, 3, "P1 + P3 + P4; P2 is censored");
    }
}
