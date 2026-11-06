//! TEST-PC-14 — the ONE-object wire parity of the eligibility providers: the
//! same `InventoryEligibilityRequest` produces the SAME verdict from the
//! pretrained catalogue entry (this module's `POST /api/txr/pretrained/
//! eligibility`) and from the installed store row (model-store's
//! `POST /api/txr/models/eligibility`, PROV-MS-9) — identical status,
//! reason codes, coverage, min_draws, missing markers, and the identical
//! PROV-MC-6 estimate. The installed row is driven by the REAL packer
//! (`pack_model_txr.py` — the only writer of fixture `.txr` bytes) with a
//! rule-carrying facts block whose needs mirror the catalogue entry's card
//! facts, so the parity is over the container seam, not a hand-written row.
//! The method is `cox-cutpoint-risk` (a real runnable, containerized,
//! gate-passed, non-frozen method of the committed method catalogue) — the
//! parity is the rule-carrying construction both providers share (the
//! rule-less divergence is a recorded-facts difference, PLAN note (s)).
//!
//! Patient ids S0000.., marker M1 — synthetic; no real patient data.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::common::{TestOptions, TestServer};

use super::*;

const FX_PARITY: &str = "fx-parity-001";
const METHOD: &str = "cox-cutpoint-risk";

/// The rule the card and the container header share: `other`-system id `m1`
/// matches the inventory marker's key `M1` (the provider's rule vocabulary).
fn parity_rule() -> Value {
    json!({
        "markers": [{"name": "M1", "id_system": "other", "id": "m1"}],
        "match": "all",
        "min_fraction": 1.0,
        "list_source": "Fixture parity rule"
    })
}

/// The facts block the packer writes into the container header — method_id
/// `cox-cutpoint-risk` (runnable in the committed method catalogue), task
/// `pfs` (the header's outcome flavor), a rule-carrying marker set, one
/// value marker M1, min_draws 2 with baseline, licence + env digests.
fn parity_facts() -> Value {
    json!({
        "name": "Fx parity rule",
        "token": FX_PARITY,
        "catalogue_id": FX_PARITY,
        "licence": "CC0 1.0 (synthetic fixture)",
        "method_id": METHOD,
        "method_version": "2.0.0",
        "group": "dynamic-risk",
        "group_label": "Dynamic risk",
        "task": "pfs",
        "decision_day": 56.0,
        "endpoint": "pfs",
        "horizon": 180.0,
        "contract": "2.0",
        "env": {
            "base_digest": "ab".repeat(32),
            "layer_digest": "cd".repeat(32)
        },
        "features": ["M1"],
        "required_markers": parity_rule(),
        "marker_facts": {
            "kind": "single",
            "count": 1,
            "min_draws": 2,
            "needs_baseline": true,
            "uses_history": "landmark",
            "needs_detection_call": false,
            "marker_groups_required": []
        },
        "covariates": {"catalogue": "none", "used": false},
        "embeds_training_data": false,
        "trained_on_patients": 312,
        "trained_at": "2026-10-19T14:30:00Z",
        "own_auc": 0.66,
        "own_c": 0.63
    })
}

/// Pack the parity facts through the REAL packer and return (file, size, sha).
fn pack_parity(dir: &std::path::Path) -> (PathBuf, u64, String) {
    let facts = dir.join("facts.json");
    std::fs::write(&facts, serde_json::to_vec_pretty(&parity_facts()).expect("facts serialize"))
        .expect("write facts");
    let out = dir.join(format!("{FX_PARITY}@1.0.0.txr"));
    let run = std::process::Command::new("python3")
        .arg(repo_root().join("scripts/pretrained-catalogue/pack_model_txr.py"))
        .args([
            "--tree",
            repo_root()
                .join("scripts/pretrained-catalogue/fixtures/pack/tree")
                .to_str()
                .expect("utf-8"),
            "--facts",
            facts.to_str().expect("utf-8"),
            "--out",
            out.to_str().expect("utf-8"),
        ])
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .expect("pack spawn");
    assert!(
        run.status.success(),
        "pack failed: {}",
        String::from_utf8_lossy(&run.stderr)
    );
    let report = String::from_utf8_lossy(&run.stdout);
    let size = report
        .lines()
        .find_map(|l| l.strip_prefix("size_bytes: ").map(|v| v.parse::<u64>().expect("size")))
        .expect("size line");
    let sha = report
        .lines()
        .find_map(|l| l.strip_prefix("sha256: ").map(|v| v.trim().to_string()))
        .expect("sha line");
    (out, size, sha)
}

/// TEST-PC-14's parity: one inventory object, two providers, identical
/// verdict facts. The catalogue entry is served live (bundle = the packed
/// fixture), the install answers 200 `bundled`, and the two eligibility
/// endpoints then agree field-for-field; the estimate equals the catalogue
/// estimator's in-process value at the same patient count (PROV-MC-6's one
/// formula), and both totals sum to one.
#[tokio::test]
async fn pretrained_and_installed_rows_answer_identically() {
    let scratch = std::env::temp_dir().join(format!(
        "pc-parity-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let bundled_dir = scratch.join("pretrained-bundled");
    std::fs::create_dir_all(&bundled_dir).expect("bundled dir");
    let (packed, size, sha) = pack_parity(&scratch);
    std::fs::copy(&packed, bundled_dir.join(format!("{FX_PARITY}@1.0.0.txr")))
        .expect("bundle the packed asset");

    let mut entry = fixture_entry(
        FX_PARITY,
        METHOD,
        2,
        true,
        "http://127.0.0.1:1/assets/unused.txr",
        true,
        size,
        &sha,
    );
    entry["needs"]["required_markers"] = parity_rule();
    let fx = FixtureHttpServer::spawn(
        serde_json::to_vec(&fixture_catalogue(vec![entry])).expect("catalogue serializes"),
        vec![],
    )
    .await;
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(fx.catalogue_url()),
        pretrained_bundled_dir: Some(bundled_dir.clone()),
        ..Default::default()
    })
    .await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);

    // Install: the same entry the card serves; the packed bytes verify under
    // the recorded sha256 (INV-2) and land as the store row.
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/pretrained/{FX_PARITY}/install")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("install");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("install json");
    assert_eq!(body["source"], "bundled");
    let model_id = body["model_id"].as_str().expect("model id").to_string();

    // The ONE inventory object (provider's shape): 2 patients, values at the
    // decision day, M1 with baseline + 2 on-treatment draws each.
    let inv = inventory_json(&[("S0001", 1, 2), ("S0002", 1, 2)], 56.0);
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [FX_PARITY], "inventory": inv.clone()}))
        .send()
        .await
        .expect("pretrained eligibility");
    assert_eq!(resp.status().as_u16(), 200);
    let pretrained: Value = resp.json().await.expect("pretrained json");
    let resp = server
        .client
        .post(server.api_url("/txr/models/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [model_id], "inventory": inv}))
        .send()
        .await
        .expect("models eligibility");
    assert_eq!(resp.status().as_u16(), 200);
    let installed: Value = resp.json().await.expect("models json");

    let pr = &pretrained["models"][0];
    let mr = &installed["models"][0];
    assert_eq!(pr["id"], FX_PARITY);
    assert_eq!(mr["id"], model_id);
    // The heads of the two verdicts agree field-for-field.
    assert_eq!(pr["status"], mr["status"], "{pr} vs {mr}");
    let pr_codes: Vec<&str> = pr["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    let mr_codes: Vec<&str> = mr["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    assert_eq!(pr_codes, mr_codes, "the reason-code sets are identical");
    assert_eq!(pr["coverage"], mr["coverage"]);
    assert_eq!(pr["min_draws"], mr["min_draws"]);
    assert_eq!(pr["missing_markers"], mr["missing_markers"]);
    assert_eq!(pr["estimated_seconds"], mr["estimated_seconds"]);
    assert_eq!(pr["estimate_quality"], mr["estimate_quality"]);

    // The verdict is the can_run the plan's example names; the totals sum.
    assert_eq!(pr["status"], "can_run");
    assert_eq!(pr["coverage"]["eligible"], 2);
    assert_eq!(pr["coverage"]["total"], 2);
    assert_eq!(pr["coverage"]["fraction"], 1.0);
    assert_eq!(pr["min_draws"]["required"], 2);
    assert_eq!(pr["min_draws"]["met"], 2);
    assert_eq!(pr["min_draws"]["unmet_patients"], 0);
    assert_eq!(
        pretrained["total_fit"].as_u64().unwrap()
            + pretrained["total_some"].as_u64().unwrap()
            + pretrained["total_cannot"].as_u64().unwrap(),
        1
    );
    assert_eq!(
        installed["total_fit"].as_u64().unwrap()
            + installed["total_some"].as_u64().unwrap()
            + installed["total_cannot"].as_u64().unwrap(),
        1
    );

    // The estimate is PROV-MC-6's one formula, in-process (the provider's
    // estimator at the file's patient count with the default CPU pairing).
    let method = cytoanalyst::modules::method_catalogue::catalogue::method(METHOD)
        .expect("the method is in the committed catalogue");
    let expect_seconds = cytoanalyst::modules::method_catalogue::eligibility::estimate_seconds_for(
        method,
        2,
        cytoanalyst::modules::method_catalogue::types::DEFAULT_ESTIMATE_CPUS,
    );
    assert_eq!(
        pr["estimated_seconds"].as_f64(),
        Some(expect_seconds),
        "the estimate is the catalogue estimator's value"
    );
    assert_eq!(pr["estimate_quality"], "measured");

    // The package-gate round-trip, in-process (the plan's pack →
    // install_imported → resolve_assets chain): the store's resolve
    // re-verifies the tree digest over the imported tree — the bytes the
    // packer wrote are the bytes the engine would run.
    let p = pool(&server).await;
    let assets = cytoanalyst::modules::model_store::store::resolve_assets(
        &p,
        &[model_id.clone()],
    )
    .await
    .expect("in-process resolve accepts the imported asset");
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].method_id, METHOD);
    assert_eq!(assets[0].method_version, "2.0.0");
    let recomputed = cytoanalyst::modules::sandbox::stack::tree_sha256(
        std::path::Path::new(&assets[0].host_dir),
    )
    .expect("tree digest");
    assert_eq!(
        assets[0].tree_sha256, recomputed,
        "the in-process resolve re-verifies over the store tree"
    );
    drop((fx, server, scratch));
}

/// The tampered-`.txr` half of the package-gate rules: the STORE's reader
/// refuses a byte-flipped container (per-entry sha256) — the same refusal
/// the module's 409 answers before its store call; the cross-boundary pin
/// keeps the packer's output and the store's reader the two sides of one
/// contract.
#[test]
fn tampered_container_bytes_are_refused_by_the_store_reader() {
    use cytoanalyst::modules::model_store::container::read_container_bytes;
    use cytoanalyst::modules::model_store::types::ModelStoreLimits;
    let scratch = std::env::temp_dir().join(format!(
        "pc-parity-tamper-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let (packed_path, _, _) = pack_parity(&scratch);
    let good = std::fs::read(&packed_path).expect("read the packed container");
    let staging = scratch.join("staging");

    // The untouched bytes restore.
    let restored = read_container_bytes(&good, &staging, ModelStoreLimits::MAX_CONTAINER_BYTES)
        .expect("the store's reader accepts the packer's bytes");
    assert_eq!(restored.models.len(), 1);

    // One flipped byte in the LAST entry's payload (the tree file bytes —
    // the header survives; the per-entry sha256 then fails). The framing:
    // ... entry bytes, 32-byte entry sha256, u64 training count, end magic.
    use cytoanalyst::modules::model_store::container::END_MAGIC;
    let mut tampered = good.clone();
    let payload_at = tampered.len() - END_MAGIC.len() - 8 - 32 - 1;
    tampered[payload_at] ^= 0xFF;
    let err = read_container_bytes(&tampered, &staging, ModelStoreLimits::MAX_CONTAINER_BYTES)
        .expect_err("the store's reader refuses a tampered container");
    assert!(
        format!("{err}").contains("sha256"),
        "the refusal names the entry verification: {err}"
    );
}

/// The parity holds for the soft-coverage case too: one patient with no
/// values at the decision day flips BOTH verdicts to `can_run_some` with the
/// same soft reason codes + counts.
#[tokio::test]
async fn parity_holds_for_the_soft_coverage_case() {
    let scratch = std::env::temp_dir().join(format!(
        "pc-parity-some-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&scratch).expect("scratch");
    let bundled_dir = scratch.join("pretrained-bundled");
    std::fs::create_dir_all(&bundled_dir).expect("bundled dir");
    let (packed, size, sha) = pack_parity(&scratch);
    std::fs::copy(&packed, bundled_dir.join(format!("{FX_PARITY}@1.0.0.txr")))
        .expect("bundle the packed asset");

    let mut entry = fixture_entry(
        FX_PARITY,
        METHOD,
        2,
        true,
        "http://127.0.0.1:1/assets/unused.txr",
        true,
        size,
        &sha,
    );
    entry["needs"]["required_markers"] = parity_rule();
    let fx = FixtureHttpServer::spawn(
        serde_json::to_vec(&fixture_catalogue(vec![entry])).expect("catalogue serializes"),
        vec![],
    )
    .await;
    let server = TestServer::spawn_with(TestOptions {
        catalogue_url: Some(fx.catalogue_url()),
        pretrained_bundled_dir: Some(bundled_dir.clone()),
        ..Default::default()
    })
    .await;
    let token = super::super::model_store::owner_token(&server).await;
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/refresh"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("refresh");
    assert_eq!(resp.status().as_u16(), 202);
    let resp = server
        .client
        .post(server.api_url(&format!("/txr/pretrained/{FX_PARITY}/install")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("install");
    let body: Value = resp.json().await.expect("install json");
    let model_id = body["model_id"].as_str().expect("model id").to_string();

    // S0003 has no values at the decision day — the soft counts make both
    // verdicts can_run_some.
    let inv = inventory_json(&[("S0001", 1, 2), ("S0002", 1, 2), ("S0003", 0, 0)], 56.0);
    let resp = server
        .client
        .post(server.api_url("/txr/pretrained/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [FX_PARITY], "inventory": inv.clone()}))
        .send()
        .await
        .expect("pretrained eligibility");
    let pretrained: Value = resp.json().await.expect("pretrained json");
    let resp = server
        .client
        .post(server.api_url("/txr/models/eligibility"))
        .bearer_auth(&token)
        .json(&json!({"model_ids": [model_id], "inventory": inv}))
        .send()
        .await
        .expect("models eligibility");
    let installed: Value = resp.json().await.expect("models json");
    let pr = &pretrained["models"][0];
    let mr = &installed["models"][0];
    assert_eq!(pr["status"], "can_run_some");
    assert_eq!(mr["status"], "can_run_some");
    assert_eq!(
        pr["coverage"]["eligible"],
        mr["coverage"]["eligible"],
        "{pr} vs {mr}"
    );
    assert_eq!(pr["coverage"]["fraction"], mr["coverage"]["fraction"]);
    let pr_codes: Vec<&str> = pr["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    let mr_codes: Vec<&str> = mr["reasons"]
        .as_array()
        .expect("reasons")
        .iter()
        .map(|r| r["code"].as_str().expect("code"))
        .collect();
    assert_eq!(pr_codes, mr_codes, "the soft reason codes are identical");
    assert!(pr_codes.contains(&"MIN_DRAWS_UNMET"), "{pr_codes:?}");
    assert_eq!(pretrained["total_some"], 1);
    assert_eq!(installed["total_some"], 1);
    drop((fx, server, scratch));
}
