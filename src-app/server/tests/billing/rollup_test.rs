//! B1 — usage-rollup fold + report + read-API acceptance tests (PROV-B1-1 / PROV-B1-2).
//!
//! The fold + report tests call the repository/rollup functions DIRECTLY against the
//! per-test DB (`pool_for`) — the exactly-once + GB-months invariants are properties of
//! those functions, provable with no Stripe and no network (mirrors B2's
//! `meter_push_test`, which drives `report_usage` directly). The read-API + sync tests
//! go through the real HTTP surface / the real subprocess rollup loop. FAKE
//! `compute_meter`/`storage_meter` rows (T5's account-keyed finalize is compute-epic's;
//! B1 only READS them) are seeded via the helpers.

use std::time::Duration;

use chrono::{TimeZone, Utc};

use cytoanalyst::modules::billing::client::StripeClient;
use cytoanalyst::modules::billing::repository::fold_account;
use cytoanalyst::modules::billing::rollup::report_all;

use crate::account::{create_user, create_user_without_projects, login, pool_for, setup_admin};
use crate::billing::helpers::{
    current_rollup, personal_account_id, seed_compute_meter, seed_storage_meter, usage,
    usage_unauth,
};
use crate::common::stripe_sim::meter_capture;

/// A fixed 30-day past period (June 2026) so GB-months / core-hours arithmetic is
/// deterministic regardless of when the test runs.
fn june_2026() -> (chrono::DateTime<Utc>, chrono::DateTime<Utc>) {
    (
        Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap(),
        Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap(),
    )
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-1 [acceptance][INV-1, INV-4] — EXACTLY-ONCE: a raw compute row folded twice
// yields ONE aggregate (the exactly-once proof + a negative control).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn compute_fold_is_exactly_once() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b1_eo_u", "b1_eo_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let (ps, pe) = june_2026();
    let at = Utc.with_ymd_and_hms(2026, 6, 10, 0, 0, 0).unwrap();

    // One CPU-class job of exactly 3600 cpu-seconds ⇒ 1.0 core-hour.
    seed_compute_meter(&pool, account, "cpu-sandbox", 3600.0, 0.0, at).await;

    let o1 = fold_account(&pool, account, ps, pe).await.expect("fold 1");
    assert!(o1.changed, "first fold changed the row");
    let (core, _gpu, _st, hwm, _rep) = current_rollup(&pool, account).await.expect("rollup exists");
    assert!(
        (core - 1.0).abs() < 1e-9,
        "3600 cpu-secs = 1.0 core-hours, got {core}"
    );
    assert!(hwm.is_some(), "the high-water mark advanced");

    // Fold the SAME rows AGAIN → the aggregate is UNCHANGED (exactly-once, INV-1).
    let o2 = fold_account(&pool, account, ps, pe).await.expect("fold 2");
    assert!(!o2.changed, "a re-fold of the same rows changes nothing");
    assert_eq!(o1.id, o2.id, "one rollup row (UNIQUE account+period)");
    let (core2, ..) = current_rollup(&pool, account).await.unwrap();
    assert!(
        (core2 - 1.0).abs() < 1e-9,
        "the aggregate did NOT double, got {core2}"
    );

    // NEGATIVE CONTROL: a genuinely NEW compute row IS folded (proves the fold is not
    // simply ignoring everything). Another 3600 cpu-secs, later ⇒ total 2.0.
    let later = Utc.with_ymd_and_hms(2026, 6, 20, 0, 0, 0).unwrap();
    seed_compute_meter(&pool, account, "cpu-sandbox", 3600.0, 0.0, later).await;
    let o3 = fold_account(&pool, account, ps, pe).await.expect("fold 3");
    assert!(o3.changed, "a new compute row DID fold");
    let (core3, ..) = current_rollup(&pool, account).await.unwrap();
    assert!(
        (core3 - 2.0).abs() < 1e-9,
        "the new row added exactly one more core-hour, got {core3}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-2 [acceptance][INV-3] — GB-months: seed storage deltas over a period, assert
// the time-weighted integral; re-run is idempotent.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn storage_gb_months_is_time_weighted_and_idempotent() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b1_gm_u", "b1_gm_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let (ps, pe) = june_2026();
    let mid = Utc.with_ymd_and_hms(2026, 6, 16, 0, 0, 0).unwrap(); // +15 days

    // +1 GB at period start (ingest), −1 GB at mid (gc): 1 GB held for 15 of 30 days
    // ⇒ 0.5 GB-months (the time-weighted integral, Lago WEIGHTED_SUM shape).
    seed_storage_meter(
        &pool,
        account,
        1_000_000_000,
        Some(1_000_000_000),
        "ingest",
        ps,
    )
    .await;
    seed_storage_meter(&pool, account, -1_000_000_000, None, "gc", mid).await;

    fold_account(&pool, account, ps, pe).await.expect("fold");
    let (_c, _g, gbm, ..) = current_rollup(&pool, account).await.expect("rollup exists");
    assert!(
        (gbm - 0.5).abs() < 1e-6,
        "1 GB for half the month = 0.5 GB-months, got {gbm}"
    );

    // Recompute-from-scratch is idempotent (DEC-3): a re-fold yields the SAME figure.
    fold_account(&pool, account, ps, pe).await.expect("re-fold");
    let (_c2, _g2, gbm2, ..) = current_rollup(&pool, account).await.unwrap();
    assert!(
        (gbm2 - gbm).abs() < 1e-12,
        "re-fold is idempotent: {gbm2} vs {gbm}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-5 [acceptance][INV-3] — resource_class split: a CPU-class row folds to
// compute_core_hours, a GPU-class row to gpu_hours.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn resource_class_splits_cpu_and_gpu() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b1_rc_u", "b1_rc_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let (ps, pe) = june_2026();
    let at = Utc.with_ymd_and_hms(2026, 6, 5, 0, 0, 0).unwrap();

    // A CPU-class job: 7200 cpu-secs ⇒ 2.0 core-hours (its gpu_secs is 0).
    seed_compute_meter(&pool, account, "cpu-sandbox", 7200.0, 0.0, at).await;
    // A GPU-class job: 3600 gpu-secs ⇒ 1.0 gpu-hours (folded off gpu_secs, by class).
    seed_compute_meter(&pool, account, "gpu-a100", 100.0, 3600.0, at).await;

    fold_account(&pool, account, ps, pe).await.expect("fold");
    let (core, gpu, ..) = current_rollup(&pool, account).await.expect("rollup exists");
    assert!(
        (core - 2.0).abs() < 1e-9,
        "CPU-class → 2.0 core-hours, got {core}"
    );
    assert!(
        (gpu - 1.0).abs() < 1e-9,
        "GPU-class → 1.0 gpu-hours, got {gpu}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-4 [acceptance][INV-5] — reader-only: a fold issues NO write against the meter
// ledgers; only usage_rollup is written.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn fold_never_mutates_the_meter_ledgers() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b1_ro_u", "b1_ro_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let (ps, pe) = june_2026();
    let at = Utc.with_ymd_and_hms(2026, 6, 5, 0, 0, 0).unwrap();

    let job = seed_compute_meter(&pool, account, "cpu-sandbox", 1800.0, 0.0, at).await;
    seed_storage_meter(&pool, account, 500_000_000, Some(500_000_000), "ingest", ps).await;

    // Snapshot the meter rows BEFORE the fold.
    let before_compute: (f64, f64) =
        sqlx::query_as("SELECT cpu_secs, gpu_secs FROM compute_meter WHERE job_id = $1")
            .bind(job)
            .fetch_one(&pool)
            .await
            .unwrap();
    let compute_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM compute_meter")
        .fetch_one(&pool)
        .await
        .unwrap();
    let storage_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM storage_meter")
        .fetch_one(&pool)
        .await
        .unwrap();

    fold_account(&pool, account, ps, pe).await.expect("fold");

    // The meter rows are byte-identical, and no rows were added/removed (INV-5).
    let after_compute: (f64, f64) =
        sqlx::query_as("SELECT cpu_secs, gpu_secs FROM compute_meter WHERE job_id = $1")
            .bind(job)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before_compute, after_compute, "compute_meter row unchanged");
    let compute_count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM compute_meter")
        .fetch_one(&pool)
        .await
        .unwrap();
    let storage_count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM storage_meter")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        compute_count_before, compute_count_after,
        "no compute_meter rows added/removed"
    );
    assert_eq!(
        storage_count_before, storage_count_after,
        "no storage_meter rows added/removed"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-3 [acceptance][INV-1] — report: the fold's rollup pushes to the PROV-B0-3
// meter-events stand-in with the right shape + a stable identifier; a re-report is a
// no-op (exactly-once), and a NEW fold re-reports with a FRESH identifier.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn report_pushes_once_and_reports_fresh_usage_again() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b1_rep_u", "b1_rep_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let (ps, pe) = june_2026();

    // The account must have a Stripe customer for its usage to be reportable.
    sqlx::query("UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2")
        .bind("cus_b1_rep")
        .bind(account)
        .execute(&pool)
        .await
        .expect("stamp customer");

    // Seed + fold → a dirty rollup row (reported_at NULL).
    seed_compute_meter(
        &pool,
        account,
        "cpu-sandbox",
        3600.0,
        0.0,
        Utc.with_ymd_and_hms(2026, 6, 3, 0, 0, 0).unwrap(),
    )
    .await;
    fold_account(&pool, account, ps, pe).await.expect("fold");

    // Stand up the PROV-B0-3 capture on an ephemeral loopback port; point a client at it.
    let (router, log) = meter_capture();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let client = StripeClient::new(format!("http://{addr}"), "sk_test_local");

    // First report → one meter push with the compute_core_hours shape + an identifier.
    let n = report_all(&pool, &client).await.expect("report");
    assert_eq!(n, 1, "one rollup row reported");
    let calls = log.calls();
    assert_eq!(
        calls.len(),
        1,
        "exactly one meter event pushed (the non-zero compute)"
    );
    assert_eq!(calls[0].event_name, "compute_core_hours");
    assert_eq!(calls[0].stripe_customer_id, "cus_b1_rep");
    assert_eq!(
        calls[0].value, "1",
        "the DELTA 1.0 core-hours serialized as '1'"
    );
    let first_id = calls[0].identifier.clone();
    assert!(
        !first_id.is_empty(),
        "a stable exactly-once identifier is carried"
    );

    // Re-report with NO intervening fold → the resource's reported watermark already
    // equals the current figure → NOT dirty → NO second push (exactly-once, INV-1).
    let n2 = report_all(&pool, &client).await.expect("re-report");
    assert_eq!(n2, 0, "nothing dirty to report");
    assert_eq!(log.calls().len(), 1, "no second push for the same usage");

    // A NEW fold advances usage (2.0 core) → dirty again → the next report pushes the
    // NEW DELTA (2.0 − 1.0 = 1.0) under a DIFFERENT identifier (segment [1,2]). Pushing
    // DELTAS to a summing meter reconstructs the cumulative 2.0 exactly; pushing the
    // cumulative "2" here would double-count to 3 (blind-audit F2).
    seed_compute_meter(
        &pool,
        account,
        "cpu-sandbox",
        3600.0,
        0.0,
        Utc.with_ymd_and_hms(2026, 6, 25, 0, 0, 0).unwrap(),
    )
    .await;
    fold_account(&pool, account, ps, pe).await.expect("fold 2");
    report_all(&pool, &client).await.expect("report 2");
    let calls = log.calls();
    assert_eq!(calls.len(), 2, "the new usage was reported");
    assert_ne!(
        calls[1].identifier, first_id,
        "a fresh identifier for the new delta segment"
    );
    assert_eq!(
        calls[1].value, "1",
        "the DELTA (2.0 − 1.0), NOT the cumulative 2.0"
    );
    // The two delta segments SUM to the true cumulative (1 + 1 = 2.0 core-hours) — this
    // is why a summing Stripe meter bills correctly.
    let total: f64 = calls.iter().map(|c| c.value.parse::<f64>().unwrap()).sum();
    assert!(
        (total - 2.0).abs() < 1e-9,
        "deltas sum to the cumulative 2.0 (summing meter is correct)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-9 [INV-1 concurrency] — two concurrent folds for the same account produce ONE
// rollup row and DO NOT double-count (the FOR UPDATE row lock serializes them).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn concurrent_folds_do_not_double_count() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b1_cc_u", "b1_cc_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let (ps, pe) = june_2026();

    seed_compute_meter(
        &pool,
        account,
        "cpu-sandbox",
        3600.0,
        0.0,
        Utc.with_ymd_and_hms(2026, 6, 12, 0, 0, 0).unwrap(),
    )
    .await;

    // Two folds racing on the SAME account/period.
    let (p1, p2) = (pool.clone(), pool.clone());
    let (r1, r2) = tokio::join!(
        fold_account(&p1, account, ps, pe),
        fold_account(&p2, account, ps, pe),
    );
    r1.expect("fold a");
    r2.expect("fold b");

    // Exactly ONE rollup row, and the compute is 1.0 — NOT 2.0 (no double count).
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usage_rollup WHERE account_id = $1")
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 1, "UNIQUE(account_id, period_start) → one rollup row");
    let (core, ..) = current_rollup(&pool, account).await.unwrap();
    assert!(
        (core - 1.0).abs() < 1e-9,
        "no double count under concurrency, got {core}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-6 [acceptance][INV-2, PROV-B1-2] — the read API is account-scoped: 401 unauth,
// 403 without billing::read, cross-account 404, and A sees only A's rollup rows.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn usage_read_is_account_scoped_and_gated() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid_a = create_user(&server, &admin, "b1_rd_a", "b1_rd_a@cyto.test").await;
    let uid_b = create_user(&server, &admin, "b1_rd_b", "b1_rd_b@cyto.test").await;
    let token_a = login(&server, "b1_rd_a").await;
    let pool = pool_for(&server).await;
    let account_a = personal_account_id(&pool, uid_a).await;
    let account_b = personal_account_id(&pool, uid_b).await;
    let (ps, pe) = june_2026();

    // Seed a rollup for A (fold a compute row) and a DIFFERENT one for B.
    seed_compute_meter(
        &pool,
        account_a,
        "cpu-sandbox",
        3600.0,
        0.0,
        Utc.with_ymd_and_hms(2026, 6, 5, 0, 0, 0).unwrap(),
    )
    .await;
    fold_account(&pool, account_a, ps, pe)
        .await
        .expect("fold a");
    seed_compute_meter(
        &pool,
        account_b,
        "cpu-sandbox",
        7200.0,
        0.0,
        Utc.with_ymd_and_hms(2026, 6, 5, 0, 0, 0).unwrap(),
    )
    .await;
    fold_account(&pool, account_b, ps, pe)
        .await
        .expect("fold b");

    // 401 — no bearer.
    assert_eq!(
        usage_unauth(&server).await.status().as_u16(),
        401,
        "unauth → 401"
    );

    // 403 — a user stripped from the Users group loses billing::read.
    let _np = create_user_without_projects(&server, &admin, "b1_rd_np", "b1_rd_np@cyto.test").await;
    let token_np = login(&server, "b1_rd_np").await;
    assert_eq!(
        usage(&server, &token_np, None, 1, 20)
            .await
            .status()
            .as_u16(),
        403,
        "missing billing::read → 403"
    );

    // A on its own account → 200 with EXACTLY A's one row (never B's).
    let resp = usage(&server, &token_a, None, 1, 20).await;
    assert_eq!(resp.status().as_u16(), 200, "A reads its own usage");
    let body: serde_json::Value = resp.json().await.expect("usage json");
    assert_eq!(
        body["total"].as_i64(),
        Some(1),
        "A sees exactly one rollup row"
    );
    let rows = body["rows"].as_array().expect("rows array");
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0]["account_id"].as_str(),
        Some(account_a.to_string().as_str()),
        "the row is A's account, never B's"
    );

    // Cross-account: A requests B's account (A is not a member) → 404 (existence-oracle
    // guard; never B's usage).
    let cross = usage(&server, &token_a, Some(account_b), 1, 20).await;
    assert_eq!(
        cross.status().as_u16(),
        404,
        "cross-account id → 404, never another tenant's usage"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-7 [contract][CONS-B1-1] — the REAL T5 compute_meter/storage_meter carry the
// exact columns B1's fold binds (PROV-compute-metering-1). A later T5 shape change
// that dropped one fails HERE, in B1's own suite (Pact across the boundary).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn t5_meter_schema_contract_holds() {
    let server = crate::common::TestServer::spawn().await;
    let pool = pool_for(&server).await;

    async fn columns(pool: &sqlx::PgPool, table: &str) -> Vec<String> {
        sqlx::query_scalar::<_, String>(
            "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
        )
        .bind(table)
        .fetch_all(pool)
        .await
        .expect("read information_schema")
    }

    let compute = columns(&pool, "compute_meter").await;
    for col in [
        "job_id",
        "account_id",
        "resource_class",
        "cpu_secs",
        "gpu_secs",
        "finished_at",
    ] {
        assert!(
            compute.contains(&col.to_string()),
            "compute_meter must carry `{col}` (PROV-compute-metering-1)"
        );
    }
    let storage = columns(&pool, "storage_meter").await;
    for col in ["account_id", "delta_bytes", "logical_bytes", "created_at"] {
        assert!(
            storage.contains(&col.to_string()),
            "storage_meter must carry `{col}` (PROV-compute-metering-1)"
        );
    }

    // job_id is the exactly-once natural key — assert it is UNIQUE/PK (guard 1).
    let job_id_unique: bool = sqlx::query_scalar(
        "SELECT EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name
           WHERE tc.table_name = 'compute_meter'
             AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
             AND kcu.column_name = 'job_id')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        job_id_unique,
        "compute_meter.job_id must be UNIQUE/PK (exactly-once natural key)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-8 [acceptance][PROV-B1-2] — a fold that changes a rollup row emits
// `sync:account_usage` to the account owner. Driven END-TO-END through the subprocess
// rollup loop (the debug-only fast tick), so the emit happens where the sync registry
// lives.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn fold_emits_account_usage_sync() {
    let opts = crate::common::TestOptions {
        billing_rollup_tick_ms: Some(250),
        ..Default::default()
    };
    let server = crate::common::TestServer::spawn_with(opts).await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b1_sy_u", "b1_sy_u@cyto.test").await;
    let token = login(&server, "b1_sy_u").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;

    // The owner's device subscribes.
    let mut probe = crate::common::sync_probe::SyncProbe::open(&server, &token).await;

    // Seed a compute row in the CURRENT period, so the subprocess loop folds it on its
    // next (≤250 ms) tick and emits AccountUsage/update for the account.
    seed_compute_meter(&pool, account, "cpu-sandbox", 3600.0, 0.0, Utc::now()).await;

    let f = probe
        .expect_event_for(
            "account_usage",
            "update",
            &account.to_string(),
            Duration::from_secs(15),
        )
        .await;
    assert_eq!(
        f.id,
        account.to_string(),
        "the wire id is the account id (client refetches its usage)"
    );

    // Sanity: the loop actually wrote the rollup (the emit corresponds to real state).
    let (core, ..) = current_rollup(&pool, account).await.expect("rollup exists");
    assert!(
        (core - 1.0).abs() < 1e-9,
        "the folded row carries 1.0 core-hour"
    );
}
