//! Compute T6 — quota-enforcement acceptance tests (design `metering-billing-quota.md` §4).
//!
//! These bind billing B4's frozen `check_quota` at the two admission points wired by T6:
//! `create_job` (compute → 402) and `workstore::ingest::ingest_run_outputs` (storage → 507).
//! They compile ONLY under `--features saas` (the enforcement arms + billing helpers are
//! saas-gated, INV-3) and reuse `tests/billing/helpers` + `tests/account`. NO Stripe, NO network —
//! `usage_rollup` is seeded directly (standing in for B1's fold), exactly as `billing::quota_test`.

use serde_json::json;
use uuid::Uuid;

use cytoanalyst::modules::billing::quota::{check_quota, QuotaAsk, QuotaVerdict};
use cytoanalyst::modules::workstore::ingest::ingest_run_outputs;
use cytoanalyst::modules::workstore::object_store::LocalFsStore;

use crate::account::{create_user, login, make_org_account, pool_for, setup_admin};
use crate::billing::helpers::{
    personal_account_id, seed_project, seed_rollup_usage, set_account_plan,
};
use crate::common::TestServer;

// Free plan: compute allowance = 3600 compute-seconds ÷ 3600 = 1.0 core-hour; storage = 5 GB-months.
// Pro plan: compute allowance = 100 core-hours (catalog `billing::catalog`).
const FREE_COMPUTE_ALLOWANCE: f64 = 1.0;
const PRO_COMPUTE_ALLOWANCE: f64 = 100.0;
const FREE_STORAGE_ALLOWANCE_GBM: f64 = 5.0;

/// POST /jobs with a `project_id`, returning `(status, body)`. A `stub` job is used so the create
/// path runs the SAME (job-type-independent) compute quota pre-check without needing a full
/// analysis spec (`est_core_hours` defaults to 1 core for a non-analysis job).
async fn create_project_job(
    server: &TestServer,
    token: &str,
    project_id: Uuid,
) -> (u16, serde_json::Value) {
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&json!({
            "job_type": "stub",
            "name": "quota-probe",
            "params": { "steps": 1 },
            "project_id": project_id,
        }))
        .send()
        .await
        .expect("POST /jobs");
    let status = resp.status().as_u16();
    let body = resp.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-1 [acceptance][INV-1] + TEST-2 [acceptance][INV-2] — a FREE account AT its compute
// allowance → create_job REFUSED (402, QUOTA_EXCEEDED, with a reason); UNDER allowance → created.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn free_tier_over_compute_allowance_refuses_job_402() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "t6_free_u", "t6_free_u@cyto.test").await;
    let token = login(&server, "t6_free_u").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await; // defaults to plan 'free'
    let project = seed_project(&pool, uid, account, "t6-free-proj").await;

    // AT the free compute allowance → the next job (est ≥ 1 core-hour) tips it over → block.
    seed_rollup_usage(&pool, account, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    let (status, body) = create_project_job(&server, &token, project).await;
    assert_eq!(status, 402, "free at allowance → 402, body={body}");
    // TEST-2 (INV-2): the refusal is TYPED + non-silent — a code the UI maps + a reason.
    assert_eq!(
        body["error_code"].as_str(),
        Some("QUOTA_EXCEEDED"),
        "typed error code, body={body}"
    );
    assert!(
        body["error"]
            .as_str()
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        "the 402 carries a human reason, body={body}"
    );

    // NEGATIVE CONTROL: well UNDER allowance → the job is created (201/202).
    seed_rollup_usage(&pool, account, 0.1, 0.0, 0.0).await;
    let (ok_status, ok_body) = create_project_job(&server, &token, project).await;
    assert!(
        ok_status == 201 || ok_status == 202,
        "free under allowance → job created, got {ok_status} body={ok_body}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-3 [acceptance][INV-1] — a PAID (pro) account PAST allowance with NO spend cap → create_job
// PROCEEDS (the AllowMeteredOverage arm proceeds; paid overage meters, not blocks).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn paid_over_compute_allowance_proceeds() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "t6_pro_u", "t6_pro_u@cyto.test").await;
    let token = login(&server, "t6_pro_u").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    set_account_plan(&pool, account, "pro").await;
    let project = seed_project(&pool, uid, account, "t6-pro-proj").await;

    // PAST the pro allowance, no cap → the overage arm proceeds.
    seed_rollup_usage(&pool, account, PRO_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    let (status, body) = create_project_job(&server, &token, project).await;
    assert!(
        status == 201 || status == 202,
        "paid over allowance, no cap → proceeds (metered), got {status} body={body}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-4 [acceptance][INV-2] — a FREE account AT its STORAGE allowance → the ingest path is
// REFUSED with 507 STORAGE_QUOTA_EXCEEDED; UNDER allowance → ingest succeeds.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn free_tier_over_storage_allowance_refuses_ingest_507() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "t6_stor_u", "t6_stor_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await; // plan 'free'
    let project = seed_project(&pool, uid, account, "t6-stor-proj").await;
    let store = LocalFsStore::new(server.data_dir().join("workstore"));

    // AT the free storage allowance → any positive add tips it over the hard cap.
    seed_rollup_usage(&pool, account, 0.0, 0.0, FREE_STORAGE_ALLOWANCE_GBM).await;
    let ws = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    write_manifest(
        &ws,
        &json!({ "outputs": [
            { "id": "expression", "datatype": "data/opaque", "path": "expr.bin",
              "layout": "opaque", "role": "artifact",
              "structure": { "encoding": "opaque" }, "meta": {} }
        ]}),
        &[("expr.bin", b"expression-matrix-bytes-over-quota")],
    )
    .await;

    let err = ingest_run_outputs(
        &pool,
        &store,
        Some(project),
        None,
        Uuid::new_v4(),
        None,
        &ws,
    )
    .await
    .expect_err("ingest must be refused over the storage hard cap");
    assert_eq!(
        err.status_code(),
        507,
        "storage over cap → 507, got {err:?}"
    );
    assert_eq!(
        err.error_code(),
        "STORAGE_QUOTA_EXCEEDED",
        "typed code, {err:?}"
    );

    // NEGATIVE CONTROL: UNDER the storage allowance → ingest succeeds and returns the row.
    seed_rollup_usage(&pool, account, 0.0, 0.0, 0.0).await;
    let ws2 = server
        .data_dir()
        .join(format!("staging-{}", Uuid::new_v4()));
    write_manifest(
        &ws2,
        &json!({ "outputs": [
            { "id": "expression", "datatype": "data/opaque", "path": "expr.bin",
              "layout": "opaque", "role": "artifact",
              "structure": { "encoding": "opaque" }, "meta": {} }
        ]}),
        &[("expr.bin", b"small-under-quota")],
    )
    .await;
    let rows = ingest_run_outputs(
        &pool,
        &store,
        Some(project),
        None,
        Uuid::new_v4(),
        None,
        &ws2,
    )
    .await
    .expect("ingest under storage allowance succeeds");
    assert_eq!(
        rows.len(),
        1,
        "the under-quota ingest produced its catalog row"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-5 [acceptance][INV-4] — the verdict follows the PROJECT's account_of_project, NOT the
// acting user's personal account. A user whose PERSONAL account is under allowance, creating a
// job in a project owned by a DIFFERENT (free, at-ceiling) account, is REFUSED (402).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn compute_quota_is_keyed_on_project_account_not_user() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "t6_key_u", "t6_key_u@cyto.test").await;
    let token = login(&server, "t6_key_u").await;
    let pool = pool_for(&server).await;

    // The user's OWN personal account is a paid account well under allowance → would never block.
    let personal = personal_account_id(&pool, uid).await;
    set_account_plan(&pool, personal, "pro").await;
    seed_rollup_usage(&pool, personal, 0.0, 0.0, 0.0).await;

    // The PROJECT lives in a SEPARATE account that is free + AT its compute ceiling.
    let project_account = make_org_account(&pool, "t6-key-org", uid).await;
    set_account_plan(&pool, project_account, "free").await;
    seed_rollup_usage(&pool, project_account, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    let project = seed_project(&pool, uid, project_account, "t6-key-proj").await;

    let (status, body) = create_project_job(&server, &token, project).await;
    assert_eq!(
        status, 402,
        "the verdict must read the PROJECT's account (at ceiling), not the user's personal (pro, empty); body={body}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-6 [acceptance][INV-5] — the PROV-B4-1 CONSUMER/Pact contract: T6's OWN ask-construction
// (`jobs::quota::compute_ask` + the storage ask it builds) fed to billing's frozen `check_quota`
// returns a real `QuotaVerdict`. A B4 field/signature change breaks this at COMPILE time.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn t6_binds_check_quota_exact_shape() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "t6_pact_u", "t6_pact_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    seed_rollup_usage(&pool, account, 0.0, 0.0, 0.0).await;

    // The compute ask is built by T6's OWN constructor — the exact QuotaAsk::Compute shape B4
    // declares — and check_quota returns a real verdict (empty usage → Allow).
    let compute_ask = cytoanalyst::modules::jobs::quota::compute_ask("cpu-sandbox", Some(2));
    match &compute_ask {
        QuotaAsk::Compute {
            resource_class,
            est_core_hours,
        } => {
            assert_eq!(resource_class, "cpu-sandbox");
            assert!(*est_core_hours > 0.0);
        }
        other => panic!("T6 must build a Compute ask, got {other:?}"),
    }
    let cv = check_quota(&pool, account, compute_ask)
        .await
        .expect("check_quota accepts T6's compute ask");
    assert_eq!(cv, QuotaVerdict::Allow, "empty usage → Allow");

    // The storage ask T6 builds at ingest (QuotaAsk::Storage { add_bytes }) is likewise accepted.
    let sv = check_quota(&pool, account, QuotaAsk::Storage { add_bytes: 1_000 })
        .await
        .expect("check_quota accepts T6's storage ask");
    assert_eq!(sv, QuotaVerdict::Allow, "empty storage usage → Allow");
}

/// Stage a run's `/outputs` manifest + files under `<ws>/outputs/` (mirrors
/// `tests/workstore/mod.rs::write_manifest` — replicated here so this saas-gated module needs no
/// cross-module test helper).
async fn write_manifest(
    ws: &std::path::Path,
    manifest: &serde_json::Value,
    files: &[(&str, &[u8])],
) {
    let outputs = ws.join("outputs");
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    tokio::fs::write(
        outputs.join("manifest.json"),
        serde_json::to_vec(manifest).unwrap(),
    )
    .await
    .unwrap();
    for (rel, bytes) in files {
        let p = outputs.join(rel);
        tokio::fs::create_dir_all(p.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(p, bytes).await.unwrap();
    }
}
