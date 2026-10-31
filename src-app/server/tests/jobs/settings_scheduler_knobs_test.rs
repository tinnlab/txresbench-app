//! #56 (jobs-reaper-settings) — the scheduler/reaper timing-knob acceptance tests.
//! Extends `job_settings` with the reaper (heartbeat, reaper_tick, stale_threshold,
//! max_reclaims, reclaim_batch) + tick-cadence (dispatch_tick_ms, metric_tick_secs) knobs,
//! all admin GET/PUT-editable with read-at-use + const fallback.
//!
//! TEST-3  (INV-5): a freshly-migrated DB returns the const-equal defaults for GET and the
//!                  `scheduler_limits()` accessor (byte-identical to `ReaperLimits::default()`).
//! TEST-4  (INV-4): the stale>=3×heartbeat guardrail — a too-low stale (or a heartbeat raised
//!                  above stale/3) is a typed 422 and no row changes; never a DB-CHECK 500.
//! TEST-5  (INV-1): a PUT is reflected by `scheduler_limits()` WITHOUT a restart.
//! TEST-6  (INV-3): updated_by is stamped from the acting admin, never the wire body.
//! TEST-7         : each out-of-bounds single-knob PUT is a 422 and no row changes.
//! TEST-8         : a partial PUT COALESCEs — one knob changes, the rest (incl. SSE) untouched.
//! TEST-9  (INV-2/A9): a user lacking jobs::settings::{read,manage} is 403 on GET+PUT; admin 200.
//! TEST-10        : the reaper reclaims by the CONFIGURED stale threshold, not the compiled default.

use std::time::Duration;

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::jobs::repository::JobRepository;
use cytoanalyst::modules::jobs::settings::{
    JobSettingsRepository, DEFAULT_DISPATCH_TICK_MS, DEFAULT_HEARTBEAT_SECS, DEFAULT_MAX_RECLAIMS,
    DEFAULT_METRIC_TICK_SECS, DEFAULT_REAPER_TICK_SECS, DEFAULT_RECLAIM_BATCH,
    DEFAULT_STALE_THRESHOLD_SECS,
};

use crate::account::{create_user_without_projects, login, pool_for, setup_admin};
use crate::common::{TestOptions, TestServer};

async fn admin_id(pool: &SqlitePool) -> Uuid {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(pool)
        .await
        .expect("admin id")
}

async fn get_settings(server: &TestServer, token: &str) -> Value {
    server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(token)
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("json")
}

/// Insert a `running` row `claimed_by = worker`, heartbeat `age_secs` in the past.
async fn insert_running(pool: &SqlitePool, owner: Uuid, worker: &str, age_secs: i64) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at, claimed_by, claim_heartbeat) \
         VALUES ($1, $2, 'stub', 'r', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), $3, strftime('%Y-%m-%dT%H:%M:%fZ','now') - make_interval(secs => $4::double precision))",
    )
    .bind(id)
    .bind(owner)
    .bind(worker)
    .bind(age_secs as f64)
    .execute(pool)
    .await
    .expect("insert running row");
    id
}

// TEST-3 [acceptance][invariant: INV-5][covers: ITEM-1, ITEM-2, ITEM-3]: a freshly-migrated DB
// returns the const-equal defaults on GET AND from `scheduler_limits()` — byte-identical to
// `ReaperLimits::default()` + the inline tick literals.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduler_defaults_are_byte_identical() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let get = get_settings(&server, &admin).await;
    assert_eq!(get["heartbeat_secs"], json!(DEFAULT_HEARTBEAT_SECS));
    assert_eq!(get["reaper_tick_secs"], json!(DEFAULT_REAPER_TICK_SECS));
    assert_eq!(get["stale_threshold_secs"], json!(DEFAULT_STALE_THRESHOLD_SECS));
    assert_eq!(get["max_reclaims"], json!(DEFAULT_MAX_RECLAIMS));
    assert_eq!(get["reclaim_batch"], json!(DEFAULT_RECLAIM_BATCH));
    assert_eq!(get["dispatch_tick_ms"], json!(DEFAULT_DISPATCH_TICK_MS));
    assert_eq!(get["metric_tick_secs"], json!(DEFAULT_METRIC_TICK_SECS));

    // The read-at-use accessor returns the SAME const-equal ReaperLimits::default().
    let limits = JobSettingsRepository::new(pool.clone()).scheduler_limits().await;
    assert_eq!(limits.heartbeat, Duration::from_secs(DEFAULT_HEARTBEAT_SECS as u64));
    assert_eq!(limits.reaper_tick, Duration::from_secs(DEFAULT_REAPER_TICK_SECS as u64));
    assert_eq!(limits.stale_threshold, Duration::from_secs(DEFAULT_STALE_THRESHOLD_SECS as u64));
    assert_eq!(limits.max_reclaims, DEFAULT_MAX_RECLAIMS);
    assert_eq!(limits.reclaim_batch, DEFAULT_RECLAIM_BATCH);
    assert_eq!(limits.dispatch_tick, Duration::from_millis(DEFAULT_DISPATCH_TICK_MS as u64));
    assert_eq!(limits.metric_tick, Duration::from_secs(DEFAULT_METRIC_TICK_SECS as u64));
}

// TEST-4 [acceptance][invariant: INV-4][covers: ITEM-1, ITEM-3, ITEM-5]: the reaper safety
// guardrail. Setting stale below 3×heartbeat — by either field — is a typed 422 and the row is
// UNCHANGED; flipping the guardrail off would let one of these PUTs stick, turning the test red.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_below_three_heartbeats_is_422_and_no_write() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // (a) Both fields at once, stale 20 < 3*10=30 → rejected.
    let both = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "heartbeat_secs": 10, "stale_threshold_secs": 20 }))
        .send()
        .await
        .expect("put both");
    assert_eq!(both.status().as_u16(), 422, "stale < 3×heartbeat rejected");

    // (b) Seed a valid high pair (heartbeat 10, stale 45 == default). Now RAISE heartbeat alone
    //     to 20 → effective stale 45 < 3*20=60 → rejected against the stored stale, NOT a 500.
    let raise_hb = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "heartbeat_secs": 20 }))
        .send()
        .await
        .expect("raise hb");
    assert_eq!(
        raise_hb.status().as_u16(),
        422,
        "raising heartbeat alone above stored-stale/3 is a typed 422, never a DB 500"
    );

    // (c) Lower stale alone below 3×stored-heartbeat (10) → 20 < 30 → rejected.
    let lower_stale = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "stale_threshold_secs": 20 }))
        .send()
        .await
        .expect("lower stale");
    assert_eq!(lower_stale.status().as_u16(), 422, "stale alone below 3×heartbeat rejected");

    // The row is intact at the defaults (no rejected PUT stuck).
    let get = get_settings(&server, &admin).await;
    assert_eq!(get["heartbeat_secs"], json!(DEFAULT_HEARTBEAT_SECS));
    assert_eq!(get["stale_threshold_secs"], json!(DEFAULT_STALE_THRESHOLD_SECS));
}

// TEST-5 [acceptance][invariant: INV-1][covers: ITEM-3, ITEM-4]: a valid PUT is reflected by
// `scheduler_limits()` on the SAME repo without a restart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_at_use_reflects_a_scheduler_put() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let resp = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({
            "heartbeat_secs": 20,
            "reaper_tick_secs": 30,
            "stale_threshold_secs": 120,
            "max_reclaims": 8,
            "reclaim_batch": 250,
            "dispatch_tick_ms": 1000,
            "metric_tick_secs": 3
        }))
        .send()
        .await
        .expect("put");
    assert_eq!(resp.status().as_u16(), 200);

    let limits = JobSettingsRepository::new(pool.clone()).scheduler_limits().await;
    assert_eq!(limits.heartbeat, Duration::from_secs(20));
    assert_eq!(limits.reaper_tick, Duration::from_secs(30));
    assert_eq!(limits.stale_threshold, Duration::from_secs(120));
    assert_eq!(limits.max_reclaims, 8);
    assert_eq!(limits.reclaim_batch, 250);
    assert_eq!(limits.dispatch_tick, Duration::from_millis(1000));
    assert_eq!(limits.metric_tick, Duration::from_secs(3));
}

// TEST-6 [acceptance][invariant: INV-3][covers: ITEM-2, ITEM-5]: a valid scheduler-knob PUT
// stamps updated_by == the acting admin; a body-supplied updated_by is IGNORED.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduler_put_stamps_updated_by_from_admin() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let admin_uuid = admin_id(&pool).await;

    let bogus = Uuid::new_v4();
    let put: Value = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "reaper_tick_secs": 20, "updated_by": bogus }))
        .send()
        .await
        .expect("put")
        .json()
        .await
        .expect("json");
    assert_eq!(put["reaper_tick_secs"], json!(20));
    assert_eq!(put["updated_by"], json!(admin_uuid), "updated_by is the acting admin");
    assert_ne!(put["updated_by"], json!(bogus), "the wire body did not win");
}

// TEST-7 [covers: ITEM-5]: each out-of-bounds single-knob PUT is a 422 and no row changes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn out_of_bounds_scheduler_puts_are_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    for body in [
        json!({ "heartbeat_secs": 0 }),
        json!({ "heartbeat_secs": 61 }),
        json!({ "reaper_tick_secs": 0 }),
        json!({ "reaper_tick_secs": 301 }),
        json!({ "stale_threshold_secs": 4 }),
        json!({ "stale_threshold_secs": 3601 }),
        json!({ "max_reclaims": 0 }),
        json!({ "max_reclaims": 101 }),
        json!({ "reclaim_batch": 0 }),
        json!({ "reclaim_batch": 10001 }),
        json!({ "dispatch_tick_ms": 10 }),
        json!({ "dispatch_tick_ms": 60001 }),
        json!({ "metric_tick_secs": 0 }),
        json!({ "metric_tick_secs": 61 }),
    ] {
        let resp = server
            .client
            .put(server.api_url("/job-settings"))
            .bearer_auth(&admin)
            .json(&body)
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status().as_u16(), 422, "rejected: {body}");
    }

    // The row is still at the defaults.
    let get = get_settings(&server, &admin).await;
    assert_eq!(get["heartbeat_secs"], json!(DEFAULT_HEARTBEAT_SECS));
    assert_eq!(get["dispatch_tick_ms"], json!(DEFAULT_DISPATCH_TICK_MS));
}

// TEST-8 [covers: ITEM-2, ITEM-3]: a partial PUT COALESCEs — one scheduler knob changes, the
// other scheduler knobs AND the existing SSE/concurrency knobs are untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_scheduler_put_coalesces() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let put: Value = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_reclaims": 9 }))
        .send()
        .await
        .expect("put")
        .json()
        .await
        .expect("json");
    assert_eq!(put["max_reclaims"], json!(9), "changed knob applied");
    assert_eq!(put["heartbeat_secs"], json!(DEFAULT_HEARTBEAT_SECS), "untouched");
    assert_eq!(put["reaper_tick_secs"], json!(DEFAULT_REAPER_TICK_SECS), "untouched");
    assert_eq!(put["reclaim_batch"], json!(DEFAULT_RECLAIM_BATCH), "untouched");
    assert_eq!(put["metric_tick_secs"], json!(DEFAULT_METRIC_TICK_SECS), "untouched");
    // The #54 SSE knob is untouched by a #56 scheduler PUT.
    assert_eq!(put["sse_keep_alive_secs"], json!(15), "SSE knob untouched");
    assert_eq!(put["max_concurrent_jobs"], json!(2), "concurrency knob untouched");
}

// TEST-9 [acceptance][invariant: INV-2][covers: ITEM-5]: A9 deny — a user lacking
// jobs::settings::{read,manage} is 403 on GET and on a scheduler-knob PUT; the admin
// (positive control) is 200.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scheduler_settings_denied_without_perm() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _uid = create_user_without_projects(&server, &admin, "sk_np", "sk_np@cyto.test").await;
    let token = login(&server, "sk_np").await;

    let get = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("get");
    assert_eq!(get.status().as_u16(), 403, "GET denied without jobs::settings::read");

    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&token)
        .json(&json!({ "reaper_tick_secs": 30 }))
        .send()
        .await
        .expect("put");
    assert_eq!(put.status().as_u16(), 403, "PUT denied without jobs::settings::manage");

    // Positive control: the admin CAN read (and the earlier tests prove admin PUT is 200).
    let ok = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin get");
    assert_eq!(ok.status().as_u16(), 200, "admin GET is allowed");
}

// TEST-10 [covers: ITEM-4]: the reaper reclaims by the CONFIGURED stale threshold, not the
// compiled default. A row aged 60s is NOT reclaimed when the configured threshold is 90s (it
// WOULD be under the default 45s), proving the read-at-use value flows into the reaper.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reaper_honors_configured_stale_threshold() {
    // No live scheduler loop — this test drives the reclaim primitive directly.
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false),
        ..Default::default()
    })
    .await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;
    let repo = JobRepository::new(pool.clone());
    let settings = JobSettingsRepository::new(pool.clone());

    // Configure a HIGH stale window: heartbeat 20, stale 90 (90 >= 3*20).
    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "heartbeat_secs": 20, "stale_threshold_secs": 90 }))
        .send()
        .await
        .expect("put");
    assert_eq!(put.status().as_u16(), 200);

    // A row 60s stale — dead under the DEFAULT 45s, but LIVE under the configured 90s.
    let row = insert_running(&pool, owner, "deadish", 60).await;

    // The reaper reads the threshold at use: scheduler_limits().stale_threshold == 90s.
    let limits = settings.scheduler_limits().await;
    assert_eq!(limits.stale_threshold, Duration::from_secs(90));
    let stale = limits.stale_threshold.as_secs() as i64;
    let reclaimed = repo
        .reclaim_stale(stale, limits.max_reclaims, limits.reclaim_batch)
        .await
        .expect("reclaim");
    assert_eq!(reclaimed, 0, "60s row is NOT reclaimed under the configured 90s threshold");

    // Control: under the compiled DEFAULT 45s the same row WOULD be reclaimed — proving 90s
    // (the configured value) is what spared it.
    let reclaimed_default = repo
        .reclaim_stale(DEFAULT_STALE_THRESHOLD_SECS, 5, 100)
        .await
        .expect("reclaim default");
    assert_eq!(reclaimed_default, 1, "the same row IS reclaimed under the default 45s threshold");

    // Sanity: it was our row.
    let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(row)
        .fetch_one(&pool)
        .await
        .expect("status");
    assert_eq!(status, "queued", "the reclaimed row is re-queued");
}
