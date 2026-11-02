//! The `method_catalogue` HTTP routes suite — TEST-MC-10..14, TEST-MC-21,
//! TEST-MC-26/28/29/30/31 (the endpoint halves), over the REAL embedded
//! catalogue (the shipped runnable-only set, DEC-2).
//!
//! ## Why the EXAMPLE-E2/E3 methods differ from the plan text
//!
//! The plan's examples name `dynforest` (min_draws 3) and
//! `cox-ctdna-status-rfs` (needs_detection_call); neither is in the runnable
//! set the app ships (the gate-failed set is excluded per DEC-2 — a method
//! with no env image cannot run on a user's machine). The same plan SHAPES
//! are pinned here on real methods that carry them: `crp-flare-response-kinetics`
//! (min_draws 3, needs_baseline) reproduces EXAMPLE-E3's exact numbers
//! (120/151, 31 unmet), and the detection-call rule is pinned by ITEM-3's
//! in-module fixture tests (no real method pair is needed to prove the rule).
//! The fixture-registry world (hermetic, every rule) belongs to the generator
//! + engine unit suites; this suite proves the TRANSPORT over the shipped data.

use serde_json::{json, Value};

use crate::common::TestServer;

/// The fixed-owner mint (the desktop's local session) → bearer token.
async fn owner_token(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({}))
        .send()
        .await
        .expect("local session");
    assert_eq!(resp.status().as_u16(), 200, "local session mints the owner");
    let body: Value = resp.json().await.expect("session body");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("session carries a token")
        .to_string()
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-10 / TEST-MC-26 — GET /api/methods
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn method_catalogue_list_returns_the_full_set_with_the_named_fields() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    // Unauthenticated → 401 (the gated-route proof).
    let unauth = server
        .client
        .get(server.api_url("/methods"))
        .send()
        .await
        .expect("unauth list");
    assert_eq!(unauth.status().as_u16(), 401, "gated without a token");

    let resp = server
        .client
        .get(server.api_url("/methods"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET /api/methods");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("list body");

    let methods = body["methods"].as_array().expect("methods array");
    // Non-vacuity + bounded: the real runnable set (the same file the server
    // embedded at boot — TEST-MC-9's no-bench-tree property is the catalogue
    // suite's; here the 200 proves the byte path).
    assert!(methods.len() >= 300, "the runnable set ({})", methods.len());
    assert_eq!(body["total"], methods.len() as u64);

    // TEST-MC-26's named fact set is present and populated per row.
    let row = methods.iter().find(|m| m["id"] == "asm-best-change-rule").expect("row");
    for field in [
        "id",
        "group",
        "group_label",
        "year",
        "language",
        "journal",
        "paper_doi",
        "frozen_model",
        "runnable",
        "container",
        "spec_status",
        "markers",
        "covariates",
        "min_draws",
        "needs_detection_call",
        "uses_history",
        "tasks",
        "marker_groups_required",
        "required_markers",
        "needs_baseline",
        "embeds_training_data",
        "timing",
    ] {
        assert!(row.get(field).is_some(), "summary row carries `{field}`");
    }
    assert_eq!(row["timing"]["quality"], "measured");
    assert!(row["performance"]["c_index_median"].is_number());

    // Filters.
    let group = server
        .client
        .get(server.api_url("/methods?group=dynamic-risk"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("group filter");
    let body: Value = group.json().await.expect("group body");
    let rows = body["methods"].as_array().expect("array");
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|m| m["group"] == "dynamic-risk"));

    let q = server
        .client
        .get(server.api_url("/methods?q=ASM-BEST"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("q filter");
    let body: Value = q.json().await.expect("q body");
    assert_eq!(body["total"], 1, "case-insensitive id substring");
    assert_eq!(body["methods"][0]["id"], "asm-best-change-rule");

    let frozen = server
        .client
        .get(server.api_url("/methods?frozen=true"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("frozen filter");
    let body: Value = frozen.json().await.expect("frozen body");
    assert!(body["methods"].as_array().expect("array").iter().all(|m| m["frozen_model"] == true));

    // An unparseable group value is a 400 (framework rejection — never a
    // silently-empty filter).
    let bad = server
        .client
        .get(server.api_url("/methods?group=no-such-group"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("bad group");
    assert_eq!(bad.status().as_u16(), 400);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-11 / TEST-MC-28 — GET /api/methods/{id}
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn method_catalogue_detail_returns_the_full_entry_and_404_named() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let resp = server
        .client
        .get(server.api_url("/methods/asm-best-change-rule"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("detail");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("detail body");
    // The detail IS the full catalogue entry: description + software + licence
    // + references + params + timing + performance.
    assert!(body["description"].as_str().expect("description").len() > 10);
    assert!(body["software"]["language"].as_str().expect("language").len() > 0);
    assert!(body["licence"].as_str().expect("licence").len() > 0);
    assert!(body["references"].as_array().expect("references").len() >= 1);
    assert!(!body["params"].as_object().expect("params").is_empty());
    assert!(body["timing"]["base_seconds_per_fold"].is_number());
    assert!(body["performance"]["c_index_median"].is_number());
    assert_eq!(body["required_markers"]["match"], "all");
    assert_eq!(body["required_markers"]["markers"].as_array().unwrap().len(), 5);

    // Unknown id → 404 with the named code (the framework's flat
    // `{error, error_code, details?}` body).
    let resp = server
        .client
        .get(server.api_url("/methods/no-such-method"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("404");
    assert_eq!(resp.status().as_u16(), 404);
    let body: Value = resp.json().await.expect("404 body");
    assert_eq!(body["error_code"], "METHOD_NOT_FOUND");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-12 / TEST-MC-29 — GET /api/markers
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn method_catalogue_markers_return_the_vocabulary_and_seven_groups() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let resp = server
        .client
        .get(server.api_url("/markers"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("markers");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("markers body");

    let groups = body["groups"].as_array().expect("groups");
    let ids: Vec<&str> = groups.iter().map(|g| g["id"].as_str().expect("id")).collect();
    for expected in [
        "ctdna",
        "counts",
        "ldh",
        "tumour-markers",
        "inflammation",
        "methylation-sequencing",
        "other",
    ] {
        assert!(ids.contains(&expected), "group {expected} in {ids:?}");
    }
    assert_eq!(ids.len(), 7, "the 7 board groups");

    let markers = body["markers"].as_array().expect("markers array");
    assert!(markers.len() >= 2, "non-vacuity");
    let crp = markers
        .iter()
        .find(|m| m["system"] == "LOINC" && m["id"] == "1988-5")
        .expect("CRP vocabulary entry");
    assert_eq!(crp["display_name"], "CRP");
    assert_eq!(crp["unit_family"], "concentration_mass");
    assert!(crp["groups"].as_array().expect("groups").contains(&json!("inflammation")));
    assert!(crp["aliases"].as_array().expect("aliases").len() >= 1);
    assert!(crp["n_methods"].is_number());
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-13 — POST /api/methods/eligibility
// ─────────────────────────────────────────────────────────────────────────────

/// EXAMPLE-E2 (missing markers): `asm-best-change-rule` requires the five HGNC
/// methylation markers with `match: all`; an inventory without them is
/// `cannot_run` + the five missing ids.
#[tokio::test]
async fn method_catalogue_eligibility_e2_missing_required_markers() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({
            "inventory": {
                "patients": 151,
                "decision_day": 56.0,
                "baseline_max_day": 0.0,
                "markers": [{
                    "key": "CEA",
                    "display_name": "CEA",
                    "unit_family": "none",
                    "standard_ids": [{"system": "LOINC", "id": "2039-6"}],
                    "is_detection_call": false,
                    "has_detection_companion": false,
                    "n_patients_with_value": 151,
                    "n_patients_with_baseline": 151,
                    "n_patients_with_ontreatment": 151,
                    "per_patient": [{"patient_key": "p0", "baseline_draws": 1, "ontreatment_draws": 1}]
                }],
                "covariates": []
            }
        }))
        .send()
        .await
        .expect("eligibility");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("eligibility body");

    let verdict = body["methods"]
        .as_array()
        .expect("methods")
        .iter()
        .find(|m| m["id"] == "asm-best-change-rule")
        .expect("verdict")
        .clone();
    assert_eq!(verdict["status"], "cannot_run");
    let codes: Vec<&str> = verdict["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    assert!(codes.contains(&"REQUIRED_MARKER_MISSING"), "{codes:?}");

    let missing: Vec<&str> = verdict["missing_markers"]
        .as_array()
        .expect("missing")
        .iter()
        .map(|m| m["id"].as_str().expect("id"))
        .collect();
    for expected in ["EYA4", "GRIA4", "ITGA4", "MAP3K14-AS1", "MSC"] {
        assert!(missing.contains(&expected), "missing {expected} in {missing:?}");
    }
    assert_eq!(missing.len(), 5);
}

/// EXAMPLE-E2 (positive): the five markers present, every patient ≥ 2 draws →
/// `can_run`, coverage 1.0.
#[tokio::test]
async fn method_catalogue_eligibility_e2_can_run_when_required_are_present() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let per_patient = vec![
        json!({"patient_key": "p0", "baseline_draws": 1, "ontreatment_draws": 1}),
        json!({"patient_key": "p1", "baseline_draws": 1, "ontreatment_draws": 2}),
    ];
    let marker = |id: &str| {
        json!({
            "key": id,
            "display_name": id,
            "unit_family": "percent",
            "standard_ids": [{"system": "HGNC", "id": id}],
            "is_detection_call": false,
            "has_detection_companion": false,
            "n_patients_with_value": 2,
            "n_patients_with_baseline": 2,
            "n_patients_with_ontreatment": 2,
            "per_patient": per_patient.clone()
        })
    };
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({
            "inventory": {
                "patients": 2,
                "decision_day": 56.0,
                "baseline_max_day": 0.0,
                "markers": [
                    marker("EYA4"), marker("GRIA4"), marker("ITGA4"),
                    marker("MAP3K14-AS1"), marker("MSC")
                ],
                "covariates": []
            }
        }))
        .send()
        .await
        .expect("eligibility");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("body");

    let verdict = body["methods"]
        .as_array()
        .expect("methods")
        .iter()
        .find(|m| m["id"] == "asm-best-change-rule")
        .expect("verdict")
        .clone();
    assert_eq!(verdict["status"], "can_run");
    assert_eq!(verdict["coverage"], json!({"eligible": 2, "total": 2, "fraction": 1.0}));
    assert_eq!(verdict["min_draws"]["unmet_patients"], 0);
    assert_eq!(verdict["estimated_seconds"], 8.9_f64 * (2.0_f64 / 150.0_f64) * (4.0_f64 / 4.0_f64));
}

/// TEST-MC-2's `other`-system name/alias fallback over the wire (the
/// data.py rule port at transport level): `cftl-combined-response` requires
/// `cfTL_max_maf` + `pa_score` (`id_system: other`, `match: all`); the file
/// columns answer by NAME (their own keys), not by a parsed standard id.
#[tokio::test]
async fn method_catalogue_eligibility_other_system_name_fallback() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let per_patient = vec![
        json!({"patient_key": "p0", "baseline_draws": 1, "ontreatment_draws": 2}),
        json!({"patient_key": "p1", "baseline_draws": 1, "ontreatment_draws": 2}),
    ];
    let other_marker = |key: &str| {
        json!({
            "key": key,
            "display_name": key,
            "unit_family": "none",
            // A standard id that does NOT equal the required one: the match
            // is the column NAME fallback, not the (system, id) equality.
            "standard_ids": [{"system": "other", "id": "no-such-id"}],
            "is_detection_call": false,
            "has_detection_companion": false,
            "n_patients_with_value": 2,
            "n_patients_with_baseline": 2,
            "n_patients_with_ontreatment": 2,
            "per_patient": per_patient.clone()
        })
    };
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({
            "inventory": {
                "patients": 2,
                "decision_day": 56.0,
                "baseline_max_day": 0.0,
                "markers": [other_marker("cfTL_max_maf"), other_marker("pa_score")],
                "covariates": []
            }
        }))
        .send()
        .await
        .expect("eligibility");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("body");
    let verdict = body["methods"]
        .as_array()
        .expect("methods")
        .iter()
        .find(|m| m["id"] == "cftl-combined-response")
        .expect("verdict")
        .clone();
    assert_eq!(verdict["status"], "can_run", "the name fallback satisfies both required ids");
}

/// EXAMPLE-E3 (coverage): `crp-flare-response-kinetics` (min_draws 3,
/// needs_baseline) over 151 patients where 120 have 3 draw-days → the exact
/// 120/151 numbers, `can_run_some`.
#[tokio::test]
async fn method_catalogue_eligibility_e3_coverage_120_of_151() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let per_patient: Vec<Value> = (0..151)
        .map(|i| {
            let (base, on) = if i < 120 { (1, 2) } else { (1, 1) };
            json!({
                "patient_key": format!("p{i}"),
                "baseline_draws": base,
                "ontreatment_draws": on
            })
        })
        .collect();
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({
            "inventory": {
                "patients": 151,
                "decision_day": 56.0,
                "baseline_max_day": 0.0,
                "markers": [{
                    "key": "CRP",
                    "display_name": "CRP",
                    "unit_family": "concentration_mass",
                    "standard_ids": [{"system": "LOINC", "id": "1988-5"}],
                    "is_detection_call": false,
                    "has_detection_companion": false,
                    "n_patients_with_value": 151,
                    "n_patients_with_baseline": 151,
                    "n_patients_with_ontreatment": 151,
                    "per_patient": per_patient
                }],
                "covariates": []
            }
        }))
        .send()
        .await
        .expect("eligibility");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("body");

    let verdict = body["methods"]
        .as_array()
        .expect("methods")
        .iter()
        .find(|m| m["id"] == "crp-flare-response-kinetics")
        .expect("verdict")
        .clone();
    assert_eq!(verdict["status"], "can_run_some");
    assert_eq!(verdict["coverage"], json!({"eligible": 120, "total": 151, "fraction": 0.795}));
    assert_eq!(verdict["min_draws"], json!({"required": 3, "met": 120, "unmet_patients": 31}));
    let codes: Vec<&str> = verdict["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    assert!(codes.contains(&"MIN_DRAWS_UNMET"), "{codes:?}");
    assert!(!codes.contains(&"DECISION_DAY_UNMET"), "{codes:?}");
    // The DEC-7 estimate at the default 4 CPUs.
    assert_eq!(verdict["estimated_seconds"], 11.6_f64 * (151.0_f64 / 150.0_f64) * (4.0_f64 / 4.0_f64));
}

/// Screen B (preview): group checkboxes → `MARKER_GROUP_MISSING` reasons; the
/// all-groups-true schedule (always-baseline, 4 draws) fits 357 of 359 (two
/// methods need 6 draws).
#[tokio::test]
async fn method_catalogue_eligibility_preview_screen_b() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let all_true = json!({
        "preview": {
            "marker_groups": {
                "ctdna": true, "counts": true, "ldh": true, "tumour-markers": true,
                "inflammation": true, "methylation-sequencing": true, "other": true
            },
            "before_treatment": "always",
            "draws_during_treatment": 4,
            "last_draw_day": 42.0
        }
    });
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&all_true)
        .send()
        .await
        .expect("preview");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("body");

    assert_eq!(body["total_fit"], 357, "all groups true, 5 planned draws");
    assert_eq!(body["total_some"], 0, "before-treatment always");
    assert_eq!(body["total_cannot"], 2, "the two 6-draw methods");

    let verdict = body["methods"]
        .as_array()
        .expect("methods")
        .iter()
        .find(|m| m["id"] == "landmark-cox-current")
        .expect("verdict")
        .clone();
    assert_eq!(verdict["status"], "can_run");
    // No patient count at screen B: the estimate is the zero-patient value.
    assert_eq!(verdict["estimated_seconds"], 0.0);

    // The `inflammation` group unchecked → the group reason.
    let mut groups = json!({
        "ctdna": false, "counts": false, "ldh": false, "tumour-markers": false,
        "inflammation": false, "methylation-sequencing": false, "other": true
    });
    groups
        .as_object_mut()
        .expect("object");
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({
            "preview": {
                "marker_groups": groups,
                "before_treatment": "always",
                "draws_during_treatment": 1,
                "last_draw_day": 42.0
            }
        }))
        .send()
        .await
        .expect("preview");
    let body: Value = resp.json().await.expect("body");
    let verdict = body["methods"]
        .as_array()
        .expect("methods")
        .iter()
        .find(|m| m["id"] == "crp-flare-response-kinetics")
        .expect("verdict")
        .clone();
    assert_eq!(verdict["status"], "cannot_run");
    let codes: Vec<&str> = verdict["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    assert!(codes.contains(&"MARKER_GROUP_MISSING"), "{codes:?}");
    assert_eq!(verdict["missing_groups"][0]["group_id"], "inflammation");
}

/// TEST-MC-27 (HTTP half): the outcome-availability codes reach the wire —
/// RESPONSE_LABEL_MISSING for a response method without the outcome columns,
/// SURVIVAL_OUTCOME_MISSING for a survival method, TASK_INCOMPATIBLE for a
/// method whose declared tasks do not consume the file's outcome columns.
#[tokio::test]
async fn method_catalogue_eligibility_outcome_availability_codes() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let none = json!({
        "has_responder": false, "has_response_day": false,
        "has_event": false, "has_survival_day": false
    });
    let inventory = |outcomes: Value| {
        json!({
            "inventory": {
                "patients": 2,
                "decision_day": 56.0,
                "baseline_max_day": 0.0,
                "markers": [{
                    "key": "CRP",
                    "display_name": "CRP",
                    "unit_family": "concentration_mass",
                    "standard_ids": [{"system": "LOINC", "id": "1988-5"}],
                    "is_detection_call": false,
                    "has_detection_companion": false,
                    "n_patients_with_value": 2,
                    "n_patients_with_baseline": 2,
                    "n_patients_with_ontreatment": 2,
                    "per_patient": [
                        {"patient_key": "p0", "baseline_draws": 1, "ontreatment_draws": 1},
                        {"patient_key": "p1", "baseline_draws": 0, "ontreatment_draws": 1}
                    ]
                }],
                "covariates": [],
                "outcomes": outcomes
            }
        })
    };

    let verify = |id: &str, body: &Value, code: &str| {
        let verdict = body["methods"]
            .as_array()
            .expect("methods")
            .iter()
            .find(|m| m["id"] == id)
            .unwrap_or_else(|| panic!("verdict for {id}"))
            .clone();
        let codes: Vec<&str> = verdict["reasons"]
            .as_array()
            .expect("reasons")
            .iter()
            .map(|r| r["code"].as_str().expect("code"))
            .collect();
        assert!(
            codes.contains(&code),
            "{id} must carry {code}; got {codes:?}"
        );
        assert_eq!(verdict["status"], "cannot_run");
    };

    // `max-reduction-threshold`: tasks ["response"] without responder columns.
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&inventory(none.clone()))
        .send()
        .await
        .expect("eligibility");
    let body: Value = resp.json().await.expect("body");
    verify("max-reduction-threshold", &body, "RESPONSE_LABEL_MISSING");

    // `cox-cutpoint-risk`: tasks ["survival"] without event/day columns.
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&inventory(none.clone()))
        .send()
        .await
        .expect("eligibility");
    let body: Value = resp.json().await.expect("body");
    verify("cox-cutpoint-risk", &body, "SURVIVAL_OUTCOME_MISSING");

    // `crp-flare-response-kinetics`: no declared tasks, file carries response
    // columns → the tasks-vs-outcome mismatch.
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&inventory(json!({
            "has_responder": true, "has_response_day": true,
            "has_event": false, "has_survival_day": false
        })))
        .send()
        .await
        .expect("eligibility");
    let body: Value = resp.json().await.expect("body");
    verify("crp-flare-response-kinetics", &body, "TASK_INCOMPATIBLE");
}

/// Malformed bodies: invalid JSON → 400 (the plan's pin); a body that parses
/// but does not match the schema → the framework's 422.
#[tokio::test]
async fn method_catalogue_eligibility_rejects_malformed_bodies() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body("{not json")
        .send()
        .await
        .expect("syntax error");
    assert_eq!(resp.status().as_u16(), 400, "invalid JSON body");

    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({}))
        .send()
        .await
        .expect("shape error");
    assert_eq!(resp.status().as_u16(), 422, "JSON that does not match the schema");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-14 / TEST-MC-30 — POST /api/methods/estimate
// ─────────────────────────────────────────────────────────────────────────────

/// The independent recomputation: read the per-method `timing` facts from the
/// DETAIL endpoint, apply the documented DEC-7 formula in the test, and compare
/// with the estimate endpoint; the schedule total must be the test-local LPT
/// makespan of the response's own per-method seconds (descending order, each
/// place on the least-loaded lane — the plan's greedy rule).
fn expected_lpt(seconds: &[f64], lanes: u32) -> f64 {
    let mut sorted: Vec<f64> = seconds.to_vec();
    sorted.sort_by(|a, b| b.partial_cmp(a).expect("finite seconds"));
    let mut loads: Vec<f64> = vec![0.0; lanes as usize];
    for &s in sorted.iter() {
        let mut best = 0usize;
        for (i, load) in loads.iter().enumerate() {
            if load < &loads[best] {
                best = i;
            }
        }
        loads[best] += s;
    }
    loads.into_iter().max_by(|a, b| a.partial_cmp(b).expect("finite")).expect("non-empty")
}

#[tokio::test]
async fn method_catalogue_estimate_is_deterministic_and_dec7_consistent() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let ids = [
        "asm-best-change-rule",
        "crp-flare-response-kinetics",
        "landmark-cox-current",
    ];
    // Read the facts from the detail surface (never from the estimate body —
    // the recomputation stays independent).
    let mut facts = Vec::new();
    for id in ids {
        let resp = server
            .client
            .get(server.api_url(&format!("/methods/{id}")))
            .bearer_auth(&token)
            .send()
            .await
            .expect("detail");
        let body: Value = resp.json().await.expect("body");
        facts.push(body["timing"]["base_seconds_per_fold"].as_f64().expect("seconds"));
    }

    let req = json!({
        "method_ids": ids,
        "patients": 151,
        "cpus": 4,
        "at_a_time": 2
    });
    let expected: Vec<f64> = facts
        .iter()
        .map(|b| b * (151.0_f64 / 150.0_f64) * (4.0_f64 / 4.0_f64))
        .collect();

    let resp = server
        .client
        .post(server.api_url("/methods/estimate"))
        .bearer_auth(&token)
        .json(&req)
        .send()
        .await
        .expect("estimate");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("body");

    assert_eq!(body["at_a_time"], 2);
    let rows = body["methods"].as_array().expect("methods");
    assert_eq!(rows.len(), 3);
    for (i, row) in rows.iter().enumerate() {
        assert_eq!(row["id"], ids[i], "response mirrors the request order");
        assert_eq!(
            row["estimated_seconds"].as_f64().expect("seconds"),
            expected[i],
            "DEC-7 shape for {}",
            ids[i]
        );
    }
    let sum: f64 = rows.iter().map(|r| r["estimated_seconds"].as_f64().expect("s")).sum();
    assert_eq!(body["total_seconds"].as_f64().expect("total"), sum, "the plain sum");
    let mut seconds: Vec<f64> = rows.iter().map(|r| r["estimated_seconds"].as_f64().expect("s")).collect();
    assert_eq!(
        body["schedule_seconds"].as_f64().expect("schedule"),
        expected_lpt(&seconds, 2),
        "the LPT makespan over the response's own seconds"
    );

    // Determinism (TEST-MC-14): the same request → the same response.
    let again = server
        .client
        .post(server.api_url("/methods/estimate"))
        .bearer_auth(&token)
        .json(&req)
        .send()
        .await
        .expect("estimate again");
    let again: Value = again.json().await.expect("body");
    assert_eq!(body, again, "no wall-clock dependence");

    // One lane = the plain sum — and the engine guarantees that BITWISE
    // (`schedule_seconds` is `total_seconds` verbatim for at_a_time == 1; the
    // LPT's sorted-order accumulation would differ by 1 ULP — f64 addition is
    // non-associative, 46.40733333333333 vs 46.407333333333334 on these
    // facts — so the exact equality is implemented, not luck; DRIFT-1 ITEM-5
    // #9, pinned by `one_lane_schedule_is_bitwise_the_total`).
    let mut req1 = req.clone();
    req1["at_a_time"] = json!(1);
    let resp = server
        .client
        .post(server.api_url("/methods/estimate"))
        .bearer_auth(&token)
        .json(&req1)
        .send()
        .await
        .expect("estimate 1 lane");
    let body1: Value = resp.json().await.expect("body");
    assert_eq!(body1["schedule_seconds"], body1["total_seconds"]);
}

/// The 400s: unknown method, zero CPUs, zero lanes — each with its named code
/// (TEST-MC-30's acceptance; METHOD_NOT_RUNNABLE is not reachable over HTTP on
/// the shipped runnable-only set — DEC-2 — and is pinned at the engine seam).
#[tokio::test]
async fn method_catalogue_estimate_rejects_with_named_codes() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let post = |req: Value| {
        let server = &server;
        let token = &token;
        async move {
            server
                .client
                .post(server.api_url("/methods/estimate"))
                .bearer_auth(token)
                .json(&req)
                .send()
                .await
                .expect("estimate")
        }
    };

    let resp = post(json!({
        "method_ids": ["no-such-method"], "patients": 10, "cpus": 4, "at_a_time": 2
    }))
    .await;
    assert_eq!(resp.status().as_u16(), 400);
    let body: Value = resp.json().await.expect("body");
    assert_eq!(body["error_code"], "UNKNOWN_METHOD");

    let resp = post(json!({
        "method_ids": ["landmark-cox-current"], "patients": 10, "cpus": 0, "at_a_time": 2
    }))
    .await;
    assert_eq!(resp.status().as_u16(), 400, "cpus 0");
    let body: Value = resp.json().await.expect("body");
    assert_eq!(body["error_code"], "INVALID_CPUS");

    let resp = post(json!({
        "method_ids": ["landmark-cox-current"], "patients": 10, "cpus": 4, "at_a_time": 0
    }))
    .await;
    assert_eq!(resp.status().as_u16(), 400, "at_a_time 0");
    let body: Value = resp.json().await.expect("body");
    assert_eq!(body["error_code"], "INVALID_AT_A_TIME");

    // Validation order: the structural failure (cpus) wins over the method one.
    let resp = post(json!({
        "method_ids": ["no-such-method"], "patients": 10, "cpus": 0, "at_a_time": 2
    }))
    .await;
    assert_eq!(resp.status().as_u16(), 400);
    let body: Value = resp.json().await.expect("body");
    assert_eq!(body["error_code"], "INVALID_CPUS");

    // Omission defaults (serde 4/3) are the valid omission path.
    let resp = post(json!({"method_ids": ["landmark-cox-current"], "patients": 10}))
        .await;
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("body");
    assert_eq!(body["at_a_time"], 3, "the D20/D37 default lanes");
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST-MC-31 (HTTP half) — the HTTP surface and the in-process seam agree for
// the same input (one implementation, no transport drift).
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn method_catalogue_http_equals_the_in_process_seam() {
    use cytoanalyst::modules::method_catalogue::eligibility::eligibility;
    use cytoanalyst::modules::method_catalogue::estimate::estimate;
    use cytoanalyst::modules::method_catalogue::types::{
        EligibilityRequest, EstimateRequest, InventoryEligibilityRequest, StandardId,
        UnitFamily,
    };

    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;

    let per_patient = vec![
        cytoanalyst::modules::method_catalogue::types::PatientDrawCounts {
            patient_key: "p0".to_string(),
            baseline_draws: 1,
            ontreatment_draws: 1,
        },
        cytoanalyst::modules::method_catalogue::types::PatientDrawCounts {
            patient_key: "p1".to_string(),
            baseline_draws: 1,
            ontreatment_draws: 2,
        },
    ];
    let inv = InventoryEligibilityRequest {
        patients: 2,
        decision_day: 56.0,
        baseline_max_day: 0.0,
        markers: vec![cytoanalyst::modules::method_catalogue::types::InventoryMarker {
            key: "CRP".to_string(),
            display_name: "CRP".to_string(),
            unit_family: UnitFamily::ConcentrationMass,
            standard_ids: vec![StandardId {
                system: "LOINC".to_string(),
                id: "1988-5".to_string(),
            }],
            is_detection_call: false,
            has_detection_companion: false,
            n_patients_with_value: 2,
            n_patients_with_baseline: 2,
            n_patients_with_ontreatment: 2,
            per_patient: Some(per_patient),
        }],
        covariates: vec![],
        outcomes: None,
    };
    let req = EligibilityRequest::Inventory { inventory: inv };

    let in_process = eligibility(&req);
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&serde_json::to_value(&req).expect("serialize request"))
        .send()
        .await
        .expect("eligibility");
    let body: Value = resp.json().await.expect("body");
    let expected = serde_json::to_value(in_process).expect("serialize engine result");
    // Structural equality is EXACT; the f64 `estimated_seconds` are compared
    // with a tolerance: the server and the test are two separately-compiled
    // binaries, and the DEC-7 product can differ by 1 ULP between builds (an
    // instruction-selection artifact of the same expression — measured, not
    // transport code: no rounding/shaping happens in the route handler). The
    // FORMULA is one code path (`eligibility_for` on both sides); the seam's
    // contract is "no drift", not bit-identical FP.
    assert_seam_structurally_equal(&body, &expected, "eligibility");

    let est_req = EstimateRequest {
        method_ids: vec!["landmark-cox-current".to_string()],
        patients: 2,
        cpus: 4,
        at_a_time: 3,
    };
    let in_process = estimate(&est_req).expect("engine estimate");
    let resp = server
        .client
        .post(server.api_url("/methods/estimate"))
        .bearer_auth(&token)
        .json(&serde_json::to_value(&est_req).expect("serialize"))
        .send()
        .await
        .expect("estimate");
    let body: Value = resp.json().await.expect("body");
    let expected = serde_json::to_value(in_process).expect("serialize engine result");
    assert_seam_structurally_equal(&body, &expected, "estimate");
}

/// The seam comparator: every field must match EXACTLY except the numeric
/// seconds, which must agree within a 1e-9 relative tolerance (see the
/// comment at the eligibility call site above).
fn assert_seam_structurally_equal(body: &Value, expected: &Value, what: &str) {
    fn walk(a: &Value, b: &Value, path: &str, what: &str) {
        match (a, b) {
            (Value::Object(oa), Value::Object(ob)) => {
                let keys_a: std::collections::BTreeSet<&String> = oa.keys().collect();
                let keys_b: std::collections::BTreeSet<&String> = ob.keys().collect();
                assert_eq!(keys_a, keys_b, "{what}: field set at {path}");
                for (k, va) in oa {
                    walk(va, &ob[k], &format!("{path}.{k}"), what);
                }
            }
            (Value::Array(aa), Value::Array(bb)) => {
                assert_eq!(aa.len(), bb.len(), "{what}: array length at {path}");
                for (i, (x, y)) in aa.iter().zip(bb.iter()).enumerate() {
                    walk(x, y, &format!("{path}[{i}]"), what);
                }
            }
            (Value::Number(x), Value::Number(y)) => {
                if let (Some(xf), Some(yf)) = (x.as_f64(), y.as_f64()) {
                    let tol = 1e-9 * yf.abs().max(1.0);
                    assert!(
                        (xf - yf).abs() <= tol,
                        "{what}: numeric drift at {path}: {xf} vs {yf}"
                    );
                } else {
                    assert_eq!(x, y, "{what}: number at {path}");
                }
            }
            _ => assert_eq!(a, b, "{what}: value at {path}"),
        }
    }
    walk(body, expected, "$", what);
}

