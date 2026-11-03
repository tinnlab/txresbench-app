//! TEST-FV-17 / TEST-FV-18 — the rule-port acceptance suite (ITEM-3, INV-8).
//!
//! The canonical model (`file_validator::rules`) is materialized as JSON rows
//! the way the in-process seam will build it — the model's serde shape IS part
//! of the contract here — and fed to `validate_model`. The everything-correct
//! fixture is the COMMITTED synthetic example
//! (`data/file-validator/examples/{patients,measurements}.csv`, generated from
//! the open benchmark `data-synth` world by ITEM-1): a file a clinician could
//! actually download and run must validate with ZERO problems. The broken
//! variants break ONE fact at a time and must produce exactly the planned code
//! — the benchmark schema's own fixture contract ("one correct + several
//! deliberately broken, right message"), ported to the app's canonical model.
//!
//! No server, no network, no benchmark tree: the files are read from the repo
//! (`CARGO_MANIFEST_DIR`-relative), the model is pure, the rules are pure —
//! this suite runs on a machine with nothing but the repo.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use cytoanalyst::modules::file_validator::rules::{
    rule_declarations, validate_model, CanonicalModel, RuleApplicability, RuleKind,
    DAY_SOURCE_FILE,
};

/// The repo root (the test binary runs with cwd = the crate dir under
/// `cargo test`; `CARGO_MANIFEST_DIR` is `src-app/server`).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-app")
        .parent()
        .expect("repo root")
        .to_path_buf()
}

/// A minimal RFC-4180-ish CSV splitter (quoted cells, doubled quotes,
/// LF/CRLF rows) — the tests must not depend on a third-party parser
/// (the server links no format crate, and the browser decodes files).
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if in_quotes => {
                if chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            },
            '"' => in_quotes = true,
            ',' if !in_quotes => {
                cur.push(std::mem::take(&mut cell));
            },
            '\r' if !in_quotes => {},
            '\n' if !in_quotes => {
                cur.push(std::mem::take(&mut cell));
                rows.push(std::mem::take(&mut cur));
            },
            c => cell.push(c),
        }
    }
    if !cell.is_empty() || !cur.is_empty() {
        cur.push(cell);
        rows.push(cur);
    }
    rows
}

/// One cell as model JSON: the raw text (null when blank), the FILE row
/// (header at row 1, so data row `i` (0-based) is file row `i + 2`) and the
/// user's column spelling.
fn cell_json(rows: &[Vec<String>], header: &[String], row_idx: usize, col: usize) -> Value {
    let raw = rows[row_idx][col].trim();
    json!({
        "text": if raw.is_empty() { Value::Null } else { json!(raw) },
        "row": row_idx + 1,
        "column": header[col],
    })
}

/// The example as a model JSON value: patients + values + features (folded per
/// marker), both table shapes, and the null outcome columns a file without the
/// response pair carries.
fn example_model_json() -> Value {
    let repo = repo_root();
    let p = read_csv(&repo.join("data/file-validator/examples/patients.csv"));
    let m = read_csv(&repo.join("data/file-validator/examples/measurements.csv"));
    let p_header = &p[0];
    let m_header = &m[0];
    let p_col = |name: &str| -> usize {
        p_header
            .iter()
            .position(|h| h.trim().eq_ignore_ascii_case(name))
            .unwrap_or_else(|| panic!("example patients header has {name}: {p_header:?}"))
    };
    let m_col = |name: &str| -> usize {
        m_header
            .iter()
            .position(|h| h.trim().eq_ignore_ascii_case(name))
            .unwrap_or_else(|| panic!("example measurements header has {name}: {m_header:?}"))
    };

    let patients: Vec<Value> = (1..p.len())
        .map(|i| {
            let c = |name: &str| cell_json(&p, p_header, i, p_col(name));
            json!({
                "patient_id": c("patient_id"),
                "pfs_days": c("pfs_days"),
                "pfs_event": c("pfs_event"),
                "os_days": c("os_days"),
                "os_event": c("os_event"),
                "responder": {"text": null, "row": i + 1, "column": "responder"},
                "response_day": {"text": null, "row": i + 1, "column": "response_day"},
                "time_unit": null,
                "covariates": [
                    ["age", c("age")],
                    ["sex", c("sex")],
                    ["stage", c("stage")],
                ],
            })
        })
        .collect();

    let values: Vec<Value> = (1..m.len())
        .map(|i| {
            let c = |name: &str| cell_json(&m, m_header, i, m_col(name));
            json!({
                "patient_id": c("patient_id"),
                "day": c("day"),
                "marker": c("marker"),
                "value": c("value"),
                "unit": c("unit"),
            })
        })
        .collect();

    // The features table folded from the distinct markers.
    let mut features: Vec<Value> = Vec::new();
    for marker in ["M1", "M2"] {
        let i = (1..m.len())
            .find(|j| m[*j][m_col("marker")].trim() == marker)
            .expect("the example carries M1 and M2");
        features.push(json!({
            "feature": cell_json(&m, m_header, i, m_col("marker")),
            "unit": cell_json(&m, m_header, i, m_col("unit")),
        }));
    }

    json!({
        "patients_shape": {
            "header_row": 1,
            "columns": p_header.iter().map(|s| s.trim().to_string()).collect::<Vec<_>>(),
        },
        "measurements_shape": {
            "header_row": 1,
            "columns": m_header.iter().map(|s| s.trim().to_string()).collect::<Vec<_>>(),
        },
        "patients": patients,
        "values": values,
        "features": features,
    })
}

fn read_csv(path: &std::path::Path) -> Vec<Vec<String>> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let rows = parse_csv(&text);
    assert!(!rows.is_empty(), "the committed example must have a header row: {}", path.display());
    rows
}

fn model_of(json: Value) -> CanonicalModel {
    serde_json::from_value(json).expect("the example materializes into the canonical model")
}

fn codes(model: &CanonicalModel) -> Vec<&'static str> {
    validate_model(model).iter().map(|p| p.code.code()).collect()
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-17 — the rule-port fixtures: one correct, five deliberately broken
// ─────────────────────────────────────────────────────────────────────────────

/// A CORRECT canonical model — the generated example materialized as JSON
/// rows — yields zero problems. This is the fastest possible repetition of the
/// app's own promise: a clinician who fills the template (or the example) with
/// clinical-shaped data sees no error.
#[test]
fn test_fv17_correct_example_yields_zero_problems() {
    let model = model_of(example_model_json());
    let problems = validate_model(&model);
    assert!(
        problems.is_empty(),
        "the committed example validates clean (INV-8, board C/N contract): {problems:?}"
    );
    assert!(model.derived_samples().len() > 300, "the derived sample set is non-trivial");
    for s in &model.derived_samples() {
        assert_eq!(s.day_source, DAY_SOURCE_FILE);
    }
}

/// Broken variant 1 — duplicate patient ids → R07.
#[test]
fn test_fv17_broken_duplicate_patient_id_is_r07() {
    let mut v = example_model_json();
    v["patients"][1]["patient_id"]["text"] = json!("J0000");
    let model = model_of(v);
    let codes = codes(&model);
    assert!(codes.contains(&"R07"), "codes: {codes:?}");
    let all = validate_model(&model);
    let r07: Vec<_> = all
        .iter()
        .filter(|p| p.code.code() == "R07")
        .collect();
    let at_second = all
        .iter()
        .filter(|p| p.code.code() == "R07" && p.row == Some(3))
        .count();
    assert_eq!(r07.len(), 1, "R07s: {r07:?}");
    assert_eq!(
        at_second,
        1,
        "the second occurrence is reported at its own row; all R07s: {r07:?}"
    );
}

/// Broken variant 2 — a non-numeric value → R03 (row + column + cell text).
#[test]
fn test_fv17_broken_non_numeric_value_is_r03() {
    let mut v = example_model_json();
    v["values"][0]["value"]["text"] = json!("high");
    let expected_row = v["values"][0]["value"]["row"].as_u64().unwrap() as u32;
    let model = model_of(v);
    let problems = validate_model(&model);
    let r03: Vec<_> = problems
        .iter()
        .filter(|p| p.code.code() == "R03")
        .collect();
    assert_eq!(r03.len(), 1, "problems: {problems:?}");
    assert_eq!(r03[0].row, Some(expected_row));
    assert_eq!(r03[0].column.as_deref(), Some("value"));
    assert!(r03[0].message.contains("high"), "{}", r03[0].message);
}

/// Broken variant 3 — an event value of 2 → R05.
#[test]
fn test_fv17_broken_event_two_is_r05() {
    let mut v = example_model_json();
    v["patients"][0]["pfs_event"]["text"] = json!("2");
    let model = model_of(v);
    let codes = codes(&model);
    assert!(codes.contains(&"R05"), "codes: {codes:?}");
}

/// Broken variant 4 — pfs_days without pfs_event → R18 (the pair rule).
#[test]
fn test_fv17_broken_pfs_days_without_event_is_r18() {
    let mut v = example_model_json();
    v["patients"][0]["pfs_event"]["text"] = Value::Null;
    let model = model_of(v);
    let codes = codes(&model);
    assert!(codes.contains(&"R18"), "codes: {codes:?}");
}

/// Broken variant 5 — a `__detected` feature whose base is not described →
/// R13 (the companion rule).
#[test]
fn test_fv17_broken_detected_without_base_is_r13() {
    let mut v = example_model_json();
    v["values"]
        .as_array_mut()
        .expect("values is an array")
        .push(json!({
            "patient_id": {"text": "J0000", "row": 2, "column": "patient_id"},
            "day": {"text": "7", "row": 2, "column": "day"},
            "marker": {"text": "M9__detected", "row": 2, "column": "marker"},
            "value": {"text": "1", "row": 2, "column": "value"},
            "unit": {"text": "a.u.", "row": 2, "column": "unit"},
        }));
    let model = model_of(v);
    let codes = codes(&model);
    assert!(codes.contains(&"R13"), "codes: {codes:?}");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-FV-18 — EVERY rule kind has a named check with a passing fixture and a
// breaking fixture (in the app's canonical model); the kind enum is
// exhaustive with no `unimplemented` arm.
// ─────────────────────────────────────────────────────────────────────────────

/// The all-clean model the per-kind fixtures build from.
fn clean_model() -> CanonicalModel {
    model_of(example_model_json())
}

/// The derivation-guard model: the correct example with one value row whose
/// day is not a number — the adversarial shape that would break a
/// samples-table port of R09/R11/R16/R17, answered here by the derivation
/// (the row is R03's report and contributes no sample).
fn derivation_guard_model() -> CanonicalModel {
    let mut v = example_model_json();
    v["values"][0]["day"]["text"] = json!("week 4");
    model_of(v)
}

#[test]
fn test_fv18_every_kind_has_a_named_check_with_fixtures() {
    // The kind enum is the exhaustive list (15 = the contract's kinds minus
    // tables_present/preview_consistent, which are declared not-applicable);
    // the match in RuleKind::check has NO wildcard/unimplemented arm, so this
    // test is the runtime half of the compile-time guarantee.
    assert_eq!(RuleKind::ALL.len(), 15);

    let mut declared = std::collections::BTreeSet::new();
    for rule in rule_declarations() {
        if let Some(k) = rule.kind {
            declared.insert(k.as_str());
        }
    }
    assert_eq!(
        declared.len(),
        15,
        "all 15 kinds are declared by some rule (kinds are shared by rule families)"
    );

    // Passing fixture: the correct example model — every kind's check must be
    // silent.
    let clean = clean_model();
    for k in RuleKind::ALL {
        let problems = k.check(&clean);
        assert!(
            problems.is_empty(),
            "{:?} passes a correct model: {problems:?}",
            k.as_str()
        );
    }

    // Breaking (or guard) fixture per kind. The two kinds that hold BY
    // CONSTRUCTION (join_equal R11/R16 — the derived sample IS the value
    // row's key; null_iff R17 — day_source is always "file") have no failing
    // fixture: their breaking fixture is the GUARD fixture, an adversarial
    // row that must stay silent because the derivation answers it (the
    // surrounding R03 reports the row instead).
    for k in RuleKind::ALL {
        let broken = broken_for(k);
        let problems = k.check(&broken);
        if is_by_construction(k) {
            assert!(
                problems.is_empty(),
                "{:?} guard fixture stays silent: {problems:?}",
                k.as_str()
            );
        } else {
            let in_family = problems
                .iter()
                .any(|p| k.problem_codes().iter().any(|c| *c == p.code));
            assert!(
                in_family,
                "{:?} fires on its breaking fixture: {problems:?}",
                k.as_str()
            );
        }
    }
}

/// A kind is answered by construction only when EVERY rule it covers is a
/// `HoldsByConstruction` property (join_equal: R11+R16; null_iff: R17). The
/// mixed families (foreign_key covers the real R08/R10/R15 AND the
/// by-construction R09) keep their real breaking fixtures.
fn is_by_construction(kind: RuleKind) -> bool {
    let rules: Vec<_> = rule_declarations()
        .iter()
        .filter(|r| r.kind == Some(kind))
        .collect();
    !rules.is_empty()
        && rules
            .iter()
            .all(|r| matches!(r.applicability, RuleApplicability::HoldsByConstruction(_)))
}

/// The breaking model of one kind. For the two kinds that hold BY CONSTRUCTION
/// (join_equal R11/R16 — the derived sample IS the value row's key) the
/// breaking fixture is the GUARD fixture: an adversarial row (a non-numeric
/// day, the exact shape that would break a naive samples-table port) must
/// still not fire, because the derivation answers it (the surrounding R03
/// does). A failing fixture cannot exist for a property the derivation makes
/// true — TESTS.md's "passing + failing fixture" wording for those two kinds
/// is amended here (recorded in DRIFT-1 ITEM-3).
fn broken_for(kind: RuleKind) -> CanonicalModel {
    let mut v = example_model_json();
    match kind {
        RuleKind::RequiredColumns => {
            v["measurements_shape"]["columns"] =
                json!(["patient_id", "day", "marker"]);
        },
        RuleKind::ColumnTypes => {
            v["values"][0]["value"]["text"] = json!("high");
        },
        RuleKind::NotNull => {
            v["values"][0]["day"]["text"] = Value::Null;
        },
        RuleKind::Enum => {
            v["patients"][0]["pfs_event"]["text"] = json!("2");
        },
        RuleKind::Minimum => {
            v["patients"][0]["pfs_days"]["text"] = json!("-1");
        },
        RuleKind::Unique => {
            v["patients"][1]["patient_id"]["text"] = json!("J0000");
        },
        RuleKind::ForeignKey => {
            v["values"][0]["patient_id"]["text"] = json!("J9999");
        },
        RuleKind::JoinEqual | RuleKind::NullIff => {
            // The guard fixture: the minimally adversarial sample-shape row.
            v["values"][0]["day"]["text"] = json!("week 4");
            return model_of(v);
        },
        RuleKind::SingleValue => {
            v["patients"][0]["time_unit"] = json!({
                "text": "weeks",
                "row": v["patients"][0]["patient_id"]["row"].clone(),
                "column": "time_unit",
            });
        },
        RuleKind::CompanionFeatures => {
            // A companion whose base (M9) is NOT described — the example's
            // markers are M1/M2, so the base-missing arm of R13 fires.
            v["values"]
        .as_array_mut()
        .expect("values is an array")
        .push(json!({
                "patient_id": {"text": "J0000", "row": 2, "column": "patient_id"},
                "day": {"text": "7", "row": 2, "column": "day"},
                "marker": {"text": "M9__detected", "row": 2, "column": "marker"},
                "value": {"text": "1", "row": 2, "column": "value"},
                "unit": {"text": "a.u.", "row": 2, "column": "unit"},
            }));
        },
        RuleKind::MinNonNull => {
            // A file whose outcome columns exist but whose patients carry no
            // outcome — fewer than 10, the R14 threshold.
            for i in 0..v["patients"].as_array().unwrap().len() {
                v["patients"][i]["pfs_days"]["text"] = Value::Null;
                v["patients"][i]["os_days"]["text"] = Value::Null;
            }
        },
        RuleKind::PairedNull => {
            v["patients"][0]["pfs_event"]["text"] = Value::Null;
        },
        RuleKind::ExclusiveMinimum => {
            v["patients"][0]["pfs_days"]["text"] = json!("0");
        },
        RuleKind::Range => {
            v["values"][0]["day"]["text"] = json!("4000");
        },
    }
    model_of(v)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry cross-checks (the acceptance half of TEST-FV-6)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_fv18_registry_verdicts_match_the_kind_checks() {
    for rule in rule_declarations() {
        match &rule.applicability {
            RuleApplicability::NotApplicable(reason) => {
                assert!(reason.len() > 20, "a written reason for {}", rule.rule_id);
                assert!(rule.kind.is_none(), "{} is not a check kind", rule.rule_id);
            },
            RuleApplicability::HoldsByConstruction(reason) => {
                assert!(
                    reason.len() > 20,
                    "a written construction proof for {}",
                    rule.rule_id
                );
                let k = rule.kind.expect("a by-construction rule still has a kind");
                // The guard fixture: the adversarial shape — a value row whose
                // day is not a number — must not fire the by-construction rule
                // (the derivation answers it; R03 reports the row), and it must
                // be silent for the whole family too (R09 shares the
                // foreign_key family with the real R08/R10/R15 checks).
                let guard = derivation_guard_model();
                assert!(
                    k.check(&guard)
                        .iter()
                        .all(|p| !k.problem_codes().contains(&p.code)),
                    "{} guard fixture stays silent",
                    rule.rule_id
                );
            },
            RuleApplicability::Implemented => {
                let k = rule.kind.expect("an implemented rule has a kind");
                assert!(
                    k.problem_codes().contains(&rule.code),
                    "{}'s kind covers itself",
                    rule.rule_id
                );
            },
        }
    }
}
