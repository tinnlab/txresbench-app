//! The contract-2.0 bundle-assembly integration legs (TEST-EE-07/08/10/22's
//! integration halves over the REAL embedded catalogue facts): the canonical
//! bundle from the REAL file-validator path (`validate` + `canonical_bundle`)
//! → the engine's train/test bundle + `params.json`, the per-method marker
//! set applying the package's count rule, and the fixture-hygiene rule
//! (TEST-EE-22 — every fixture is an in-test construct).

use super::{cohort_measurements_parsed, cohort_patients_parsed};
use cytoanalyst::modules::execution_engine::bundle::{
    self, BundleError, BundleSettings, MarkerSelection,
};
use cytoanalyst::modules::execution_engine::envmanifest;
use cytoanalyst::modules::execution_engine::types::RunConfig;
use cytoanalyst::modules::file_validator::bundle::canonical_bundle;
use cytoanalyst::modules::file_validator::types::{
    AnalysisParameters, JoinOffer, MarkerMapping, ValidationMode, ValidationRequest,
};

fn cohort_vreq(decision_day: f64) -> ValidationRequest {
    ValidationRequest {
        mode: ValidationMode::Files,
        patients: Some(cohort_patients_parsed()),
        measurements: cohort_measurements_parsed(),
        joins: Vec::<JoinOffer>::new(),
        mapping: Vec::<MarkerMapping>::new(),
        parameters: AnalysisParameters {
            decision_day,
            ..Default::default()
        },
    }
}

/// The 30-patient canonical bundle through the REAL validator (the same call
/// the run start's `prepare_run` makes — one code path, DEC-15).
fn cohort_canonical() -> cytoanalyst::modules::file_validator::types::CanonicalBundle {
    canonical_bundle(&cohort_vreq(56.0)).expect("the cohort fixture validates")
}

/// TEST-EE-08's integration half: the written bundle matches the contract 2.0
/// file + params shapes — the fixed column sets, the single-horizon
/// `params.json`, and `test/patients.csv` carrying exactly the scored rows.
#[test]
fn the_cohort_bundle_matches_the_contract_2_0_shapes() {
    let canonical = cohort_canonical();
    let settings = BundleSettings::for_run(
        &RunConfig {
            decision_day: 56.0,
            look_ahead_day: 238.0,
            ..Default::default()
        },
        2,
    );

    let train = bundle::train_bundle(&canonical, &settings, 1).expect("train bundle");
    let names: Vec<&str> = train.files.iter().map(|f| f.name).collect();
    assert_eq!(
        names,
        vec!["long.csv", "long_full.csv", "outcomes.csv"],
        "no covariates on → the predictors + outcomes set only"
    );
    for f in &train.files {
        let mut lines = f.csv.lines();
        let header = lines.next().expect("header");
        match f.name {
            "long.csv" | "long_full.csv" => {
                assert_eq!(header, "patient_id,day,marker,value,baseline");
            }
            "outcomes.csv" => {
                assert!(
                    header.starts_with(
                        "patient_id,pfs_time,pfs_event,os_time,os_event,no_response,progressive_disease"
                    ),
                    "the contract 2.0 fixed set: {header}"
                );
                assert!(
                    header.contains("progression_H238") && header.contains("death_H238"),
                    "the horizon label cells: {header}"
                );
            }
            other => panic!("unexpected bundle file {other}"),
        }
    }

    // params.json — the 2.0 field set; no `task`/`endpoint`/`features`/
    // `marker_ranking` (the DRIFT-2 re-pin; v1.2-only shapes).
    let params = &train.params;
    for field in [
        "landmark_day",
        "horizons",
        "outcomes",
        "markers",
        "baseline_max_day",
        "covariates",
        "method_params",
        "seed",
        "threads",
    ] {
        assert!(params.get(field).is_some(), "params.json.{field}");
    }
    assert_eq!(params["landmark_day"], 56.0);
    assert_eq!(params["horizons"], serde_json::json!([238.0]));
    assert_eq!(params["markers"], serde_json::json!(["14804-9"]));
    assert_eq!(
        params["baseline_max_day"], 0.0,
        "the app pins 0 (2026-10-19 baseline)"
    );
    assert_eq!(params["covariates"], false);
    assert_eq!(params["method_params"], serde_json::json!({}));
    assert_eq!(params["seed"], 1, "the fixed contract seed");
    assert_eq!(params["threads"], 2, "the per-method lane CPU count");
    assert!(params.get("features").is_none(), "no v1.2 field");
    assert!(params.get("marker_ranking").is_none(), "no v1.2 field");
    assert!(params.get("task").is_none(), "no v1.2 field");

    // The test side: 30 scored patients, patient_id-only rows.
    let test = bundle::test_bundle(None, &canonical, &settings, 1).expect("test bundle");
    assert_eq!(test.scored.len(), 30, "every cohort patient has 3 draws");
    assert_eq!(test.skipped.len(), 0);
    let patients = test
        .files
        .iter()
        .find(|f| f.name == "patients.csv")
        .expect("patients.csv written");
    let mut lines = patients.csv.lines();
    assert_eq!(lines.next(), Some("patient_id"));
    assert_eq!(lines.count(), 30);
    let long = test
        .files
        .iter()
        .find(|f| f.name == "long.csv")
        .expect("long.csv");
    assert_eq!(
        long.csv.lines().next(),
        Some("patient_id,day,marker,value,baseline")
    );

    // The effects of a per-method marker scoping: a one-marker method on the
    // all-markers bundle is the same set; `params.markers` never lists the
    // companion rows (there are none on this fixture).
    let facts = envmanifest::facts_for("cox-cutpoint-risk").expect("real catalogue facts");
    let selection = bundle::method_marker_set(&canonical, &facts.markers, None)
        .expect("one marker on a one-marker file");
    assert_eq!(selection.mains, vec!["14804-9"]);
    let scoped = bundle::train_bundle_with_markers(&canonical, &settings, 1, &selection)
        .expect("scoped train bundle");
    assert_eq!(scoped.params["markers"], serde_json::json!(["14804-9"]));
}

/// TEST-EE-10's integration half: the per-method marker set applies the
/// package's count rule from the REAL catalogue facts — a one-marker `single`
/// method on a two-marker file is the package's own typed refusal with its
/// own message; `params.markers` is scoped to the method's set.
#[test]
fn per_method_marker_set_obeys_the_package_count_rule() {
    let mut canonical = cohort_canonical();
    // Grow the fixture by a second main marker (CEA's standard id): every
    // patient gets a day-0 CEA row.
    let mut values = canonical.values.clone();
    for v in &canonical.values {
        if v.day == 0.0 && v.feature == "14804-9" {
            values.push(
                cytoanalyst::modules::file_validator::types::CanonicalValue {
                    patient_id: v.patient_id.clone(),
                    day: 0.0,
                    feature: "2039-6".to_string(),
                    value: Some(10.0),
                    unit: None,
                },
            );
        }
    }
    canonical.values = values;

    let facts = envmanifest::facts_for("cox-cutpoint-risk").expect("facts");
    assert!(
        matches!(
            facts.markers.kind,
            cytoanalyst::modules::method_catalogue::types::MarkerKind::Single
        ),
        "the fixture method is a single-marker method"
    );
    let err =
        bundle::method_marker_set(&canonical, &facts.markers, None).expect_err("two markers ≠ one");
    match &err {
        BundleError::MarkerCountUnmet { expected, names } => {
            assert_eq!(*expected, 1);
            assert_eq!(names.len(), 2, "the passed set is named: {names:?}");
            assert!(
                names.contains(&"14804-9".to_string()) && names.contains(&"2039-6".to_string()),
                "both main markers: {names:?}"
            );
        }
        other => panic!("expected the count refusal, got {other:?}"),
    }
    assert_eq!(err.code(), "BUNDLE_MARKER_COUNT_UNMET");
    assert!(
        err.to_string().contains("takes exactly one marker"),
        "the package's message text: {err}"
    );

    // Scoped to ONE marker, the same file bundles fine and the method sees
    // only its marker (the selection is DATA the engine builds per method).
    let settings = BundleSettings::for_run(&RunConfig::default(), 2);
    let one = MarkerSelection {
        mains: vec!["14804-9".to_string()],
        companions: Vec::new(),
    };
    let scoped = bundle::train_bundle_with_markers(&canonical, &settings, 1, &one)
        .expect("one-marker scoped bundle");
    assert_eq!(scoped.params["markers"], serde_json::json!(["14804-9"]));
    let long = scoped
        .files
        .iter()
        .find(|f| f.name == "long.csv")
        .expect("long");
    assert!(
        long.csv
            .lines()
            .all(|l| l.starts_with("patient_id") || !l.contains("2039-6")),
        "a scoped bundle never carries another marker's rows"
    );
}

/// TEST-EE-22's integration half: every fixture in this suite is an in-test
/// construct — the ids follow the pinned grammar, no fixture value references
/// `restricted/`, `datasets/` or `results/` paths, and the serialized fixture
/// carries no data-folder fact.
#[test]
fn fixtures_are_synthetic_in_test_constructs() {
    let mut seen: Vec<String> = Vec::new();
    for r in cohort_patients_parsed().rows {
        for c in r {
            seen.push(c.unwrap_or_default());
        }
    }
    for r in cohort_measurements_parsed().rows {
        for c in r {
            seen.push(c.unwrap_or_default());
        }
    }
    for v in seen {
        assert!(
            !v.contains("restricted") && !v.contains("datasets") && !v.contains("results"),
            "no data-folder path in a fixture value: {v}"
        );
    }
    let serialized = serde_json::to_string(&cohort_canonical()).expect("serialize");
    assert!(
        !serialized.contains("/data/") && !serialized.contains("restricted"),
        "the canonical fixture carries no absolute path"
    );
    // The id grammar: C01..C30 + the LOINC standard ids.
    assert!(
        cohort_patients_parsed().rows.iter().all(|r| r[0]
            .as_deref()
            .is_some_and(|id| id.starts_with('C') && id.len() == 3)),
        "patient ids follow the fixture grammar"
    );
}

/// The wiring provenance of the REAL embedded facts the tests above bind
/// (TEST-EE-04's integration half): the committed catalogue + the committed
/// manifest are present and answer for the fixture methods.
#[test]
fn the_embedded_facts_answer_for_the_fixture_methods() {
    let facts = envmanifest::facts_for("cox-cutpoint-risk").expect("catalogue method");
    assert_eq!(facts.id, "cox-cutpoint-risk");
    let entry = envmanifest::env_for("cox-cutpoint-risk").expect("manifest entry");
    assert_eq!(entry.method_id, "cox-cutpoint-risk");
    assert!(entry.size_bytes > 0, "the F screen's bytes_total fact");
    let base = envmanifest::base_for("cox-cutpoint-risk").expect("base pair");
    assert!(base.name.contains("txresbench-base"), "{base:?}");
    // A runnable method without an entry — the runtime-env missing case.
    assert!(
        envmanifest::env_for("jm-mem-lq").is_none(),
        "A runnable catalogue method with no published layer → the ITEM-2 ENV_IMAGE_MISSING classification"
    );
    let _ = entry;
    let _ = facts;
}
