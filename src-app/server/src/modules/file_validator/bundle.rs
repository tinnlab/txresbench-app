//! The canonical bundle — `bundle.rs` (ITEM-5, PROV-FV-5): the in-process rows
//! an execution engine writes as `/input`'s `long.csv` / `outcomes.csv` /
//! `covariates.csv` (contract.md's fixed column set). All draws are KEPT — no
//! landmark cutting here; the engine owns landmark cutting and bundle
//! assembly.
//!
//! The bundle is built over the SAME resolution as the validate response
//! ([`crate::modules::file_validator::validate::resolve_request`]): joins and
//! mappings validated once, one join/mapping contract. Feature identity:
//! WITHOUT a join, each raw spelling is its own feature (EXAMPLE-FV-5 — an
//! unjoined variant group is two data series to the engine); WITH the user's
//! join, the merged key is the one feature. Rows whose patient_id/day/marker
//! cells are not usable are SKIPPED by the bundle (R03/R04 report them); a
//! non-numeric value cell is carried as `value: None` — the R03 report is the
//! validate response's, and no cell is guessed.
//!
//! Deterministic: file order, no timestamps — the same request yields
//! byte-equal serialization (TEST-FV-12).

use crate::modules::file_validator::types::{
    CanonCell, CanonicalBundle, CanonicalFeature, CanonicalPatient, CanonicalValue,
    ValidationError, ValidationRequest,
};
use crate::modules::file_validator::validate::resolve_request;
use crate::modules::file_validator::vocab::normalize_marker_name;
use crate::modules::method_catalogue::eligibility::is_companion;

/// The canonical bundle (PROV-FV-5).
pub fn canonical_bundle(req: &ValidationRequest) -> Result<CanonicalBundle, ValidationError> {
    let resolved = resolve_request(req)?;
    let model = &resolved.model;

    // The covariate columns, one type per column (the tidy rule: a column is
    // float64 when every non-null value is numeric, else string).
    let covariate_numeric: Vec<bool> = {
        let mut cols: Vec<Vec<&str>> = Vec::new();
        for row in &model.patients {
            for (i, (_, cell)) in row.covariates.iter().enumerate() {
                while cols.len() <= i {
                    cols.push(Vec::new());
                }
                if let Some(t) = cell.text() {
                    cols[i].push(t);
                }
            }
        }
        cols.iter()
            .map(|cells| {
                !cells.is_empty() && cells.iter().all(|t| t.parse::<f64>().is_ok_and(|v| v.is_finite()))
            })
            .collect()
    };

    let patients: Vec<CanonicalPatient> = model
        .patients
        .iter()
        .map(|row| CanonicalPatient {
            patient_id: row.patient_id.text().unwrap_or("").to_string(),
            pfs_days: row.pfs_days.parse_f64(),
            pfs_event: row.pfs_event.parse_i64(),
            os_days: row.os_days.parse_f64(),
            os_event: row.os_event.parse_i64(),
            responder: row.responder.parse_i64(),
            response_day: row.response_day.parse_f64(),
            covariates: row
                .covariates
                .iter()
                .enumerate()
                .filter_map(|(i, (name, cell))| {
                    let text = cell.text()?;
                    let value = if covariate_numeric.get(i).copied().unwrap_or(false) {
                        CanonCell::Number(text.parse::<f64>().ok()?)
                    } else {
                        CanonCell::Text(text.to_string())
                    };
                    Some((name.clone(), value))
                })
                .collect(),
        })
        .collect();

    let values: Vec<CanonicalValue> = model
        .values
        .iter()
        .filter_map(|row| {
            let patient_id = row.patient_id.text()?.to_string();
            let day = row.day.parse_f64()?;
            let marker = row.marker.text()?;
            let feature = resolved
                .joined_groups
                .get(&normalize_marker_name(marker))
                .cloned()
                .unwrap_or_else(|| marker.to_string());
            Some(CanonicalValue {
                patient_id,
                day,
                feature,
                value: row.value.parse_f64(),
                unit: row.unit.as_ref().and_then(|u| u.text()).map(|t| t.to_string()),
            })
        })
        .collect();

    // One feature per effective name: the raw spelling (or the joined key), in
    // first-appearance order — the join is the ONLY merge of spellings.
    let mut features: Vec<CanonicalFeature> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for row in &model.features {
        let Some(spelling) = row.feature.text() else { continue };
        let effective = resolved
            .joined_groups
            .get(&normalize_marker_name(spelling))
            .cloned()
            .unwrap_or_else(|| spelling.to_string());
        if seen.contains(&effective) {
            continue;
        }
        seen.push(effective.clone());
        let marker_id = resolved
            .marker_columns
            .iter()
            .find(|c| {
                c.key == effective || c.spellings.iter().any(|s| s.spelling == effective)
            })
            .and_then(|c| c.mapping)
            .map(|e| e.id.clone());
        features.push(CanonicalFeature {
            feature: effective.clone(),
            unit: row.unit.as_ref().and_then(|u| u.text()).map(|t| t.to_string()),
            marker_id,
            is_detection_companion: is_companion(&effective),
        });
    }

    Ok(CanonicalBundle {
        patients,
        values,
        features,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — TEST-FV-12 + EXAMPLE-FV-5
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::file_validator::types::{
        AnalysisParameters, JoinOffer, MarkerMapping, ParsedTable, ParsedTableSource,
        ProblemCode, TableFormat, ValidationMode,
    };
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

    fn req(
        mode: ValidationMode,
        patients: Option<ParsedTable>,
        measurements: ParsedTable,
        joins: Vec<JoinOffer>,
        mapping: Vec<MarkerMapping>,
    ) -> ValidationRequest {
        ValidationRequest {
            mode,
            patients,
            measurements,
            joins,
            mapping,
            parameters: AnalysisParameters {
                decision_day: 56.0,
                baseline_max_day: 0.0,
            },
        }
    }

    #[test]
    fn test_fv12_bundle_keeps_all_draws_and_carries_outcomes() {
        let patients = table(
            &[
                "patient_id",
                "pfs_days",
                "pfs_event",
                "os_days",
                "os_event",
                "age",
            ],
            &[&["P1", "100", "1", "120", "0", "62"]],
        );
        let measurements = table(
            &["patient_id", "day", "marker", "value", "unit"],
            &[
                &["P1", "0", "M1", "10", "a.u."],
                &["P1", "7", "M1", "12", "a.u."],
                &["P1", "21", "M1", "15", "a.u."],
            ],
        );
        let r = req(
            ValidationMode::Files,
            Some(patients),
            measurements,
            vec![],
            vec![],
        );
        let bundle = canonical_bundle(&r).expect("the bundle");
        assert_eq!(bundle.values.len(), 3, "ALL draws are kept — no cutting");
        assert_eq!(bundle.features.len(), 1);
        assert_eq!(bundle.features[0].feature, "M1");
        assert_eq!(bundle.features[0].unit.as_deref(), Some("a.u."));
        assert_eq!(bundle.patients.len(), 1);
        let p = &bundle.patients[0];
        assert_eq!(p.patient_id, "P1");
        assert_eq!(p.pfs_days, Some(100.0));
        assert_eq!(p.pfs_event, Some(1));
        assert_eq!(p.os_days, Some(120.0));
        assert_eq!(p.os_event, Some(0));
        assert_eq!(p.responder, None);
        // The covariate cell is a number (the column is numeric).
        assert_eq!(
            p.covariates,
            vec![("age".to_string(), CanonCell::Number(62.0))]
        );
    }

    #[test]
    fn test_fv12_join_makes_the_feature_spelling_single() {
        // EXAMPLE-FV-5: with the join one feature; without it two features.
        let measurements = table(
            &["patient_id", "day", "marker", "value", "unit"],
            &[
                &["P1", "0", "ldh", "100", "U/L"],
                &["P1", "7", "LDH", "110", "U/L"],
            ],
        );
        let unjoined = req(
            ValidationMode::Predict,
            None,
            measurements.clone(),
            vec![],
            vec![],
        );
        let b = canonical_bundle(&unjoined).expect("bundle");
        assert_eq!(b.features.len(), 2, "no join → two distinct features");
        assert_eq!(b.features[0].feature, "ldh");
        assert_eq!(b.features[1].feature, "LDH");
        assert_eq!(b.values[0].feature, "ldh");
        assert_eq!(b.values[1].feature, "LDH");

        let joined = req(
            ValidationMode::Predict,
            None,
            measurements,
            vec![JoinOffer {
                variants: vec!["ldh".to_string(), "LDH".to_string()],
                key: "LDH".to_string(),
            }],
            vec![],
        );
        let b = canonical_bundle(&joined).expect("bundle");
        assert_eq!(b.features.len(), 1, "the join is the only merge");
        assert_eq!(b.features[0].feature, "LDH");
        assert_eq!(b.values[0].feature, "LDH");
        assert_eq!(b.values[1].feature, "LDH");
    }

    #[test]
    fn test_fv12_features_record_marker_id_unit_and_companion_flag() {
        let measurements = table(
            &["patient_id", "day", "marker", "value", "unit"],
            &[
                &["P1", "0", "LDH", "100", "U/L"],
                &["P1", "0", "ctDNA", "3.2", "copies/µL"],
                &["P1", "0", "ctDNA__detected", "1", " "],
            ],
        );
        let r = req(
            ValidationMode::Predict,
            None,
            measurements,
            vec![],
            vec![MarkerMapping {
                key: "LDH".to_string(),
                marker_id: "14804-9".to_string(),
            }],
        );
        let b = canonical_bundle(&r).expect("bundle");
        let ldh = b.features.iter().find(|f| f.feature == "LDH").unwrap();
        assert_eq!(ldh.marker_id.as_deref(), Some("14804-9"));
        assert_eq!(ldh.unit.as_deref(), Some("U/L"));
        assert!(!ldh.is_detection_companion);
        let ct = b.features.iter().find(|f| f.feature == "ctDNA").unwrap();
        assert!(!ct.is_detection_companion);
        let companion = b
            .features
            .iter()
            .find(|f| f.feature == "ctDNA__detected")
            .unwrap();
        assert!(companion.is_detection_companion, "R13's suffix contract");
    }

    #[test]
    fn test_fv12_non_numeric_value_is_carried_as_null_and_reported_r03() {
        let measurements = table(
            &["patient_id", "day", "marker", "value", "unit"],
            &[&["P1", "0", "M1", "high", "a.u."]],
        );
        let r = req(ValidationMode::Predict, None, measurements.clone(), vec![], vec![]);
        let b = canonical_bundle(&r).expect("bundle");
        assert_eq!(b.values.len(), 1);
        assert_eq!(b.values[0].value, None, "the cell is never guessed");
        let v = validate(&r).expect("validate");
        assert!(
            v.problems.iter().any(|p| {
                p.code == ProblemCode::R03ColumnTypes && p.row == Some(2)
            }),
            "R03 reports the row: {:?}",
            v.problems
        );
    }

    #[test]
    fn test_fv12_repeat_request_is_byte_equal() {
        let patients = table(
            &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
            &[&["P1", "100", "1", "120", "0"]],
        );
        let measurements = table(
            &["patient_id", "day", "marker", "value", "unit"],
            &[&["P1", "0", "M1", "10", "a.u."], &["P1", "7", "M1", "12", "a.u."]],
        );
        let r = req(
            ValidationMode::Files,
            Some(patients),
            measurements,
            vec![],
            vec![],
        );
        let a = canonical_bundle(&r).expect("bundle");
        let b = canonical_bundle(&r).expect("bundle");
        assert_eq!(
            serde_json::to_vec(&a).unwrap(),
            serde_json::to_vec(&b).unwrap(),
            "no timestamps, no state"
        );
    }

    #[test]
    fn test_fv12_bundle_inherits_the_request_errors() {
        let measurements = table(&["patient_id", "day", "marker", "value"], &[&["P1", "0", "M1", "1"]]);
        let r = req(ValidationMode::Files, None, measurements, vec![], vec![]);
        let err = canonical_bundle(&r).err().expect("expected MISSING_PATIENTS");
        assert_eq!(err, ValidationError::MissingPatients);
    }
}
