//! ITEM-5's route-landing suite (TEST-PC-21/22/27/31) over the real spawned
//! server: the fixture catalogue arrives through the module's own LIVE
//! refresh (a loopback fixture server — the seams' documented `catalogue_url`
//! knob), so the routes serve the same catalogue + validation path a real
//! deployment does; the eligibility verdicts are the D-list's, computed from
//! the catalogue's recorded `needs`; the route matrix is the JobsUse gate
//! (A10 not triggered); and the module-shape leg greps the shipped source
//! (no reimplemented matcher, no sandbox, no store tables — INV-11).

use std::path::PathBuf;

use serde_json::{json, Value};
use uuid::Uuid;

use crate::common::{TestOptions, TestServer};

use super::*;

/// The fixture entries: `fx-rule-a` is a REAL runnable method (the estimate
/// is the catalogue estimator's measured value); `fx-rule-b` carries a method
/// the current catalogue does not ship (NOT_RUNNABLE).
const FX_A: &str = "fx-rule-a";
const FX_B: &str = "fx-rule-b";

/// Spawn the fixture catalogue server (loopback) + a live server pointed at
/// it; the sine qua non is the module's own refresh elevating the runtime to
/// `origin: live` with the fixture entries.
async fn live_fixture_server() -> (TestServer, FixtureHttpServer) {
    let fx = FixtureHttpServer::spawn(
        serde_json::to_vec(&fixture_catalogue(vec![
            fixture_entry(
                FX_A,
                "cox-cutpoint-risk",
                1,
                false,
                "http://127.0.0.1:1/assets/unused-a.txr",
                false,
                8,
                &"ab".repeat(32),
            ),
            fixture_entry(
                FX_B,
                "retired-method",
                1,
                false,
                "http://127.0.0.1:1/assets/unused-b.txr",
                false,
                8,
                &"cd".repeat(32),
            ),
        ]))
        .expect("fixture catalogue serializes"),
        vec![],
    )
    .await;
    let url = fx.catalogue_url();
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(url),
        ..Default::default()
    })
    .await;
    (server, fx)
}

/// Elevate (or confirm) the live layer and return the owner token.
async fn live_and_owner(server: &TestServer) -> String {
    let token = super::super::model_store::owner_token(server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202, "refresh -> 202");
    let body: Value = resp.json().await.expect("refresh json");
    assert_eq!(body["origin"], "live", "the fixture catalogue is live: {body}");
    assert_eq!(body["models"], 2, "the fixture entries");
    token
}

/// TEST-PC-27 (PROV-PC-4): the card is the full `models[]` entry verbatim
/// (paper, needs in full, env digests, contract, per-cohort transfer,
/// warnings, licence, data sources, asset), and an unknown id is the one 404
/// with `PRETRAINED_UNKNOWN`.
#[tokio::test]
async fn get_model_carries_the_card_shape_and_404s() {
    let (server, fx) = live_fixture_server().await;
    let token = live_and_owner(&server).await;

    let resp = server
        .client
        .get(server.api_url(&format!("/txr/pretrained/{FX_A}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("card");
    assert_eq!(resp.status().as_u16(), 200);
    let card: Value = resp.json().await.expect("card json");
    assert_eq!(card["id"], FX_A);
    assert_eq!(card["kind"], "published-rule");
    assert_eq!(card["method_id"], "cox-cutpoint-risk");
    assert_eq!(card["name"], format!("{FX_A} synthetic rule"));
    assert_eq!(
        card["description"],
        "Synthetic card facts — never real model, method or patient data."
    );
    assert_eq!(card["paper"]["journal"], "Synthetic Journal");
    assert_eq!(card["paper"]["year"], 2024);
    assert_eq!(card["paper"]["citation"], "Synthetic et al. 2024.");
    assert_eq!(card["needs"]["decision_day"], 56.0);
    assert_eq!(card["needs"]["endpoint"], "pfs");
    assert_eq!(card["needs"]["horizon"], 180.0);
    assert_eq!(card["needs"]["task"], "survival");
    assert_eq!(card["needs"]["marker_facts"]["min_draws"], 1);
    assert!(card["needs"]["required_markers"].is_null());
    assert_eq!(card["env"]["base_digest"], format!("sha256:{}", "aa".repeat(32)));
    assert_eq!(card["contract"], "2.0");
    assert_eq!(card["transfer"]["metric"], "auc_rule");
    assert_eq!(card["transfer"]["median"], 0.64);
    assert_eq!(card["transfer"]["cohorts"][0]["dataset"], "fx-dataset-1");
    assert_eq!(card["assay_warnings"][0]["code"], "FX_WARN");
    assert_eq!(card["research_notice"], true);
    assert_eq!(card["licence"], "CC0 1.0 (synthetic fixture)");
    assert_eq!(card["data_sources"][0]["access"], "open");
    assert_eq!(card["asset"]["file"], format!("{FX_A}@1.0.0.txr"));
    assert_eq!(card["asset"]["url"], "http://127.0.0.1:1/assets/unused-a.txr");
    assert_eq!(card["asset"]["sha256"], "ab".repeat(32));
    assert_eq!(card["asset"]["signature"], "");

    let resp = server
        .client
        .get(server.api_url("/txr/pretrained/no-such-model"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("unknown card");
    assert_eq!(resp.status().as_u16(), 404);
    assert_eq!(
        super::super::model_store::error_code(&resp.json().await.expect("body")),
        "PRETRAINED_UNKNOWN"
    );
    drop(fx);
}

/// TEST-PC-22: the route matrix — 401 unauthenticated on every one of the 8
/// routes, 403 for a user lacking `jobs::use`, with the unauthenticated
/// `/health` positive control (the refusal is the gate, not a broken route).
#[tokio::test]
async fn the_route_matrix_is_401_403_with_the_health_control() {
    let (server, fx) = live_fixture_server().await;
    let routes: Vec<(&str, String)> = vec![
        ("GET", "/txr/pretrained".to_string()),
        ("GET", format!("/txr/pretrained/{FX_A}")),
        ("POST", "/txr/pretrained/refresh".to_string()),
        ("GET", "/txr/pretrained/downloads".to_string()),
        ("POST", format!("/txr/pretrained/{FX_A}/download")),
        ("DELETE", format!("/txr/pretrained/{FX_A}/download")),
        ("POST", format!("/txr/pretrained/{FX_A}/install")),
        ("POST", "/txr/pretrained/eligibility".to_string()),
    ];
    for (verb, path) in &routes {
        let req = match *verb {
            "GET" => server.client.get(server.api_url(path)),
            "POST" => server.client.post(server.api_url(path)),
            "DELETE" => server.client.delete(server.api_url(path)),
            other => panic!("unhandled verb {other}"),
        };
        let resp = req.send().await.expect("request");
        assert_eq!(resp.status().as_u16(), 401, "{verb} {path} unauthenticated");
    }
    let resp = server
        .client
        .get(server.api_url("/health"))
        .send()
        .await
        .expect("health");
    assert!(resp.status().is_success());

    // 403: a user LACKING jobs::use — the engine's matrix pattern
    // (registration seeds the JobsUse group; removing it takes the gate).
    let (restricted, restricted_id) = {
        let resp = server
            .client
            .post(server.api_url("/auth/register"))
            .json(&json!({
                "username": "txr-pretrained-restricted",
                "email": "pretrained@txr.test",
                "password": "txrUserP0!",
                "permissions": []
            }))
            .send()
            .await
            .expect("register");
        let body: Value = resp.json().await.expect("json");
        let t = body["access_token"]
            .as_str()
            .or_else(|| body["token"].as_str())
            .expect("token")
            .to_string();
        let me: Value = server
            .client
            .get(server.api_url("/auth/me"))
            .bearer_auth(&t)
            .send()
            .await
            .expect("me")
            .json()
            .await
            .expect("me json");
        (t, Uuid::parse_str(me["user"]["id"].as_str().expect("id")).expect("uuid"))
    };
    let rp = pool(&server).await;
    super::super::common::group_remove_from_users(&rp, restricted_id).await;
    for (verb, path) in &routes {
        let req = match *verb {
            "GET" => server.client.get(server.api_url(path)),
            "POST" => server.client.post(server.api_url(path)),
            "DELETE" => server.client.delete(server.api_url(path)),
            other => panic!("unhandled verb {other}"),
        };
        let resp = req.bearer_auth(&restricted).send().await.expect("request");
        assert_eq!(resp.status().as_u16(), 403, "{verb} {path} restricted");
    }
    let resp = server
        .client
        .get(server.api_url("/health"))
        .bearer_auth(&restricted)
        .send()
        .await
        .expect("health");
    assert!(resp.status().is_success());
    drop(fx);
}

/// TEST-PC-31 (PROV-PC-8): the per-model eligibility verdicts over HTTP — the
/// runnable fixture answers `can_run` with the catalogue estimator's value,
/// the absent-method fixture answers `NOT_RUNNABLE` without a time, the
/// coverage soft reasons flip the row to `can_run_some`, the totals
/// arithmetic holds, the SAME inventory object is accepted verbatim by the
/// methods provider, and the request-validation refusals are typed 400s.
#[tokio::test]
async fn per_model_eligibility_over_the_fixture_catalogue() {
    let (server, fx) = live_fixture_server().await;
    let token = live_and_owner(&server).await;

    let inv = inventory_json(&[("S0001", 1, 1), ("S0002", 1, 2)], 56.0);
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [FX_A, FX_B], "inventory": inv.clone()}))
        .send()
        .await
        .expect("eligibility");
    assert_eq!(resp.status().as_u16(), 200, "eligibility -> 200");
    let body: Value = resp.json().await.expect("eligibility json");

    let models = body["models"].as_array().expect("models array");
    assert_eq!(models.len(), 2);
    assert_eq!(models[0]["id"], FX_A, "request order");
    assert_eq!(models[1]["id"], FX_B);

    // FX_A: every patient meets the 1-draw rule (no baseline needed) → can_run.
    assert_eq!(models[0]["status"], "can_run");
    assert_eq!(models[0]["coverage"]["eligible"], 2);
    assert_eq!(models[0]["coverage"]["total"], 2);
    assert_eq!(models[0]["coverage"]["fraction"], 1.0);
    assert_eq!(models[0]["min_draws"]["required"], 1);
    assert_eq!(models[0]["min_draws"]["unmet_patients"], 0);
    assert!(models[0]["estimated_seconds"].is_number());
    assert_eq!(models[0]["estimate_quality"], "measured");

    // FX_B: its method is absent from the current catalogue → NOT_RUNNABLE,
    // cannot_run, and the time is NOT promised.
    assert_eq!(models[1]["status"], "cannot_run");
    let reasons: Vec<&str> = models[1]["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    assert!(reasons.contains(&"NOT_RUNNABLE"), "{reasons:?}");
    assert!(models[1]["estimated_seconds"].is_null());
    assert_eq!(models[1]["estimate_quality"], "estimate");

    assert_eq!(body["total_fit"], 1);
    assert_eq!(body["total_some"], 0);
    assert_eq!(body["total_cannot"], 1);

    // The soft coverage case: one patient has values only after the decision
    // day (0,0) — the row answers can_run_some with the soft reasons.
    let inv_some = inventory_json(&[("S0001", 1, 1), ("S0002", 1, 1), ("S0003", 0, 0)], 56.0);
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [FX_A], "inventory": inv_some}))
        .send()
        .await
        .expect("eligibility some");
    let body: Value = resp.json().await.expect("eligibility some json");
    let row = &body["models"][0];
    assert_eq!(row["status"], "can_run_some", "{row}");
    assert_eq!(row["coverage"]["eligible"], 2);
    assert_eq!(row["coverage"]["fraction"], 0.667);
    let reasons: Vec<&str> = row["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    assert!(reasons.contains(&"MIN_DRAWS_UNMET"), "{reasons:?}");
    assert!(reasons.contains(&"DECISION_DAY_UNMET"), "{reasons:?}");
    assert_eq!(body["total_some"], 1);

    // The one-shape acceptance: the SAME inventory object is accepted
    // verbatim by the methods eligibility provider.
    let resp = server
        .client
        .post(server.api_url("/methods/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"inventory": inv}))
        .send()
        .await
        .expect("methods eligibility");
    assert_eq!(resp.status().as_u16(), 200, "the same inventory shape");
    drop(fx);
}

/// TEST-PC-31's refusal arms: unknown id in the batch → 400
/// PRETRAINED_UNKNOWN (a batch's ids are request data — PROV-PC-8); the
/// 1..=200 bound → 400 EMPTY_MODEL_IDS / TOO_MANY_MODEL_IDS.
#[tokio::test]
async fn eligibility_refusals_are_typed() {
    let (server, fx) = live_fixture_server().await;
    let token = live_and_owner(&server).await;
    let inv = inventory_json(&[("S0001", 1, 1)], 56.0);

    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": ["no-such-model"], "inventory": inv}))
        .send()
        .await
        .expect("unknown id");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        super::super::model_store::error_code(&resp.json().await.expect("body")),
        "PRETRAINED_UNKNOWN"
    );

    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [], "inventory": inv}))
        .send()
        .await
        .expect("empty ids");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        super::super::model_store::error_code(&resp.json().await.expect("body")),
        "EMPTY_MODEL_IDS"
    );

    let ids: Vec<String> = (0..201).map(|i| format!("id-{i}")).collect();
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": ids, "inventory": inv}))
        .send()
        .await
        .expect("too many ids");
    assert_eq!(resp.status().as_u16(), 400);
    assert_eq!(
        super::super::model_store::error_code(&resp.json().await.expect("body")),
        "TOO_MANY_MODEL_IDS"
    );
    drop(fx);
}

/// TEST-PC-22's list half + the PROV-PC-3 row shape: the served rows come
/// from the fuse-heightened LIVE layer (`origin: live`, the fixture entries),
/// carry the merged state (`not_downloaded` — no bundle, no cache, no
/// install) and the null `installed_model_id` before any install; the
/// downloads surface reports one status per entry.
#[tokio::test]
async fn list_and_downloads_serve_the_live_fixture_rows() {
    let (server, fx) = live_fixture_server().await;
    let token = live_and_owner(&server).await;

    let resp = server
        .client
        .get(server.api_url("/txr/pretrained"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("list json");
    assert_eq!(body["origin"], "live");
    assert_eq!(body["generated_at"], "2026-01-01T00:00:00Z");
    assert_eq!(body["total"], 2);
    let rows = body["models"].as_array().expect("models");
    assert_eq!(rows[0]["id"], FX_A);
    assert_eq!(rows[0]["state"], "not_downloaded");
    assert!(rows[0]["installed_model_id"].is_null());
    assert_eq!(rows[0]["warnings"][0]["code"], "FX_WARN");
    assert_eq!(rows[0]["transfer"]["median"], 0.64);
    assert!(rows[0]["asset"]["url"].is_null(), "the summary carries no url");
    assert_eq!(rows[0]["asset"]["sha256"], "ab".repeat(32));
    assert_eq!(rows[1]["state"], "not_downloaded");

    let resp = server
        .client
        .get(server.api_url("/txr/pretrained/downloads"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("downloads");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("downloads json");
    let dl = body["downloads"].as_array().expect("downloads array");
    assert_eq!(dl.len(), 2);
    assert_eq!(dl[0]["id"], FX_A);
    assert_eq!(dl[0]["state"], "not_downloaded");
    assert_eq!(dl[0]["bundled"], false);
    assert_eq!(dl[0]["bytes_total"], 8);
    assert!(dl[0]["digest"].is_null());
    drop(fx);
}

/// TEST-PC-21 (INV-11, module-shape leg) + TEST-PC-08's grep half: the
/// module builds on the provided seams — its eligibility engine has no
/// duplicated marker matcher (the provider's `required_marker_match` is the
/// one), no `parse_standard_ids` reimplementation, no model execution, no
/// sandbox import, no direct store-table read.
#[tokio::test]
async fn module_shape_has_no_reimplemented_matcher_or_store() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/modules/pretrained_catalogue");
    let mut sources = String::new();
    for name in [
        "mod.rs",
        "types.rs",
        "catalogue.rs",
        "downloader.rs",
        "install.rs",
        "bundled.rs",
        "eligibility.rs",
        "routes.rs",
    ] {
        let text = std::fs::read_to_string(dir.join(name))
            .unwrap_or_else(|e| panic!("read {name}: {e}"));
        sources.push_str(&text);
        sources.push('\n');
    }

    // The one matcher: the provider's function is called; a local definition
    // would be a reimplementation (INV-11).
    assert!(
        sources.contains("required_marker_match("),
        "eligibility binds the provider's matcher"
    );
    assert!(
        !sources.contains("fn parse_standard_ids"),
        "no local parse_standard_ids reimplementation"
    );
    // No model execution, no sandbox, no store tables, no second OCI/env
    // fetch (the downloader is HTTPS + sha256 only).
    assert!(!sources.contains("run_method"), "no model execution here");
    assert!(
        !sources.contains("sandbox::"),
        "the module never imports the sandbox"
    );
    assert!(
        !sources.contains("txr_models") && !sources.contains("txr_model_sets"),
        "no direct read of the store's tables (the seam is list_pretrained)"
    );
    assert!(
        !sources.contains("oras::") && !sources.contains("oci"),
        "no OCI machinery (the env manager is a different module)"
    );
}
