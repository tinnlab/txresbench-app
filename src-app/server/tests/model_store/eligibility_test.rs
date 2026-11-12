//! TEST-MS-13 — PROV-MS-9 (per-model eligibility) over the real spawned
//! server: the I-list verdicts for saved models against the file's inventory
//! (the SAME `InventoryEligibilityRequest` object one component would feed
//! both eligibility providers), the totals' arithmetic, the typed refusals,
//! and the one-shape acceptance — the same inventory object is accepted
//! verbatim by `POST /api/methods/eligibility`.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::common::TestServer;
use super::{error_code, owner_token, pool, seed_run_with_models};
use txresbench::modules::execution_engine::repository::TxrRepository;

/// The two seeded methods (real catalogue + env-manifest entries, so the save
/// records the catalogue's marker facts — the eligibility engine's inputs).
const METHOD_A: &str = "cox-cutpoint-risk";
const METHOD_B: &str = "landmark-cox-current";

/// The file inventory (the validator-built shape): 6 patients, markers M1/M2,
/// draws at day 0/14/28/56 (baseline only for two patients — the
/// needs-baseline model's `can_run_some`), survival outcome columns present.
fn inventory() -> Value {
    json!({
        "patients": 6,
        "decision_day": 56.0,
        "baseline_max_day": 0.0,
        "markers": [
            {
                "key": "M1",
                "display_name": "M1",
                "unit_family": "none",
                "standard_ids": [],
                "is_detection_call": false,
                "has_detection_companion": false,
                "n_patients_with_value": 6,
                "n_patients_with_baseline": 2,
                "n_patients_with_ontreatment": 6,
                "per_patient": [
                    {"patient_key": "S0001", "baseline_draws": 1, "ontreatment_draws": 2},
                    {"patient_key": "S0002", "baseline_draws": 0, "ontreatment_draws": 3},
                    {"patient_key": "S0003", "baseline_draws": 1, "ontreatment_draws": 2},
                    {"patient_key": "S0004", "baseline_draws": 0, "ontreatment_draws": 1},
                    {"patient_key": "S0005", "baseline_draws": 0, "ontreatment_draws": 2},
                    {"patient_key": "S0006", "baseline_draws": 0, "ontreatment_draws": 0}
                ]
            },
            {
                "key": "M2",
                "display_name": "M2",
                "unit_family": "none",
                "standard_ids": [],
                "is_detection_call": false,
                "has_detection_companion": false,
                "n_patients_with_value": 6,
                "n_patients_with_baseline": 2,
                "n_patients_with_ontreatment": 6,
                "per_patient": [
                    {"patient_key": "S0001", "baseline_draws": 1, "ontreatment_draws": 1},
                    {"patient_key": "S0002", "baseline_draws": 0, "ontreatment_draws": 2},
                    {"patient_key": "S0003", "baseline_draws": 1, "ontreatment_draws": 2},
                    {"patient_key": "S0004", "baseline_draws": 0, "ontreatment_draws": 1},
                    {"patient_key": "S0005", "baseline_draws": 0, "ontreatment_draws": 1},
                    {"patient_key": "S0006", "baseline_draws": 0, "ontreatment_draws": 0}
                ]
            }
        ],
        "covariates": [],
        "outcomes": {"has_responder": false, "has_response_day": false, "has_event": true, "has_survival_day": true}
    })
}

/// TEST-MS-13 (acceptance, INV-4): save a run's two produced models, then
/// POST the file inventory — the verdicts are the I-list's (METHOD_A:
/// `can_run` — every patient meets the recorded 1-draw rule without a
/// baseline need; METHOD_B: `can_run_some` with `MIN_DRAWS_UNMET` + the
/// baseline-only cohort). The totals' arithmetic holds, and the SAME
/// inventory object is accepted verbatim by the methods provider.
#[tokio::test]
async fn per_model_eligibility_uses_the_one_inventory_shape() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let repo = TxrRepository::new(pool(&server).await);
    let (run_id, _run_dir) =
        seed_run_with_models(&server, &repo, "elig-ms13", &[METHOD_A, METHOD_B]).await;

    let resp = server
        .client
        .post(server.api_url("/txr/models/save"))
        .bearer_auth(&token)
        .json(&json!({
            "run_id": run_id,
            "method_ids": [METHOD_A, METHOD_B],
            "target": {"set_name": "eligibility cohort"},
        }))
        .send()
        .await
        .expect("save");
    assert_eq!(resp.status().as_u16(), 201, "save -> 201");
    let saved: Value = resp.json().await.expect("save json");
    let ids: Vec<String> = saved["models"]
        .as_array()
        .expect("models")
        .iter()
        .map(|m| m["id"].as_str().expect("id").to_string())
        .collect();
    assert_eq!(ids.len(), 2);

    let inv = inventory();
    let resp = server
        .client
        .post(server.api_url("/txr/models/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": ids, "inventory": inv}))
        .send()
        .await
        .expect("eligibility");
    assert_eq!(resp.status().as_u16(), 200, "eligibility -> 200");
    let body: Value = resp.json().await.expect("eligibility json");

    let models = body["models"].as_array().expect("models array");
    assert_eq!(models.len(), 2);
    // Order: the request order.
    assert_eq!(models[0]["id"], ids[0]);
    assert_eq!(models[1]["id"], ids[1]);

    // METHOD_A — cox-cutpoint-risk: recorded features M1/M2 present, recorded
    // draw rule 1 (no baseline) met by every patient; S0006 has values only
    // after the decision day → the soft DECISION_DAY_UNMET reason, eligible 5
    // of 6 → can_run_some, NOT can_run. (The seed's recorded min_draws is the
    // catalogue's current 1.)
    assert_eq!(models[0]["status"], "can_run_some", "{}", models[0]);
    assert_eq!(models[0]["coverage"]["eligible"], 5);
    assert_eq!(models[0]["coverage"]["total"], 6);
    assert_eq!(models[0]["min_draws"]["required"], 1);
    assert!(models[0]["estimated_seconds"].is_number());
    assert_eq!(models[0]["estimate_quality"], "measured");

    // METHOD_B — landmark-cox-current: needs a baseline — two patients have
    // one → 2 of 6 → can_run_some with the coverage counts.
    assert_eq!(models[1]["status"], "can_run_some");
    assert_eq!(models[1]["coverage"]["eligible"], 2);
    assert_eq!(models[1]["coverage"]["total"], 6);
    assert_eq!(models[1]["min_draws"]["required"], 1);
    assert_eq!(models[1]["min_draws"]["unmet_patients"], 4);
    let reasons: Vec<&str> = models[1]["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    assert!(reasons.contains(&"MIN_DRAWS_UNMET"), "{reasons:?}");
    assert!(reasons.contains(&"DECISION_DAY_UNMET"), "{reasons:?}");

    // The totals arithmetic.
    assert_eq!(body["total_cannot"], 0);
    assert_eq!(body["total_fit"], 0);
    assert_eq!(body["total_some"], 2, "{}", body);

    // The one-shape acceptance: the SAME inventory object into the methods
    // eligibility provider (the tagged inventory arm) is accepted verbatim —
    // one component feeds both endpoints from one object.
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"inventory": inv}))
        .send()
        .await
        .expect("methods eligibility");
    assert_eq!(resp.status().as_u16(), 200, "the same inventory shape");
    let mbody: Value = resp.json().await.expect("methods json");
    assert!(mbody["methods"].as_array().expect("methods").len() > 0);
    assert_eq!(mbody["total_fit"].as_u64().expect("fit") + mbody["total_some"].as_u64().expect("some") + mbody["total_cannot"].as_u64().expect("cannot"), 359);
}

/// TEST-MS-13's refusal arms: an unknown model id → 404 MODEL_NOT_FOUND (the
/// caller's selection should be re-read); an empty id list → 400
/// EMPTY_MODELS.
#[tokio::test]
async fn eligibility_refusals_are_typed() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let inv = inventory();

    let resp = server
        .client
        .post(server.api_url("/txr/models/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [Uuid::new_v4().to_string()], "inventory": inv}))
        .send()
        .await
        .expect("unknown model");
    assert_eq!(resp.status().as_u16(), 404);
    assert_eq!(error_code(&resp.json().await.expect("body")), "MODEL_NOT_FOUND");

    let resp = server
        .client
        .post(server.api_url("/txr/models/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [], "inventory": inv}))
        .send()
        .await
        .expect("empty models");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(error_code(&resp.json().await.expect("body")), "EMPTY_MODELS");
}
