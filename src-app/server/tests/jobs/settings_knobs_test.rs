//! #54 (per-module admin-settings coverage), jobs — the SSE + admission knob acceptance tests.
//! Extends `job_settings` with the SSE (keep-alive, max clients) + admission (wait, poll) knobs
//! and an `updated_by` audit column, all admin GET/PUT-editable with read-at-use + const fallback.
//!
//! TEST-3  (INV-1): a freshly-migrated DB returns the const-equal defaults for GET and the
//!                  read-at-use accessors (byte-identical to today).
//! TEST-4  (INV-2): an out-of-bounds PUT is a 422 and no row changes (Rust validate before write).
//! TEST-5  (INV-3): the guardrail values (a hang, an OOM, poll>=wait) are rejected.
//! TEST-6  (INV-4): updated_by is stamped from the acting admin, never the wire body.
//! TEST-7  (INV-5): a PUT is reflected by the read-at-use accessors WITHOUT a restart.
//! TEST-8         : a partial PUT COALESCEs — one knob changes, the rest are untouched.
//! TEST-9  (A9)   : a user lacking jobs::settings::{read,manage} is 403 on GET+PUT; admin 200.
//! TEST-10        : after a valid SSE-knob PUT, GET /jobs/{id}/stream returns 200 text/event-stream.
//! TEST-13        : admit_within honors the configured poll — it waits the whole budget when full.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::jobs::admission;
use cytoanalyst::modules::jobs::models::CreateJobRequest;
use cytoanalyst::modules::jobs::repository::JobRepository;
use cytoanalyst::modules::jobs::settings::{
    JobSettingsRepository, DEFAULT_ADMISSION_POLL_MS, DEFAULT_ADMISSION_WAIT_SECS,
    DEFAULT_SSE_KEEP_ALIVE_SECS, DEFAULT_SSE_MAX_CLIENTS,
};

use crate::account::{create_user_without_projects, login, pool_for, setup_admin};
use crate::common::TestServer;

async fn admin_id(pool: &sqlx::PgPool) -> Uuid {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(pool)
        .await
        .expect("admin id")
}

// TEST-3 [acceptance][invariant: INV-1][covers: ITEM-1, ITEM-3]: a freshly-migrated DB returns
// the const-equal defaults on GET AND on the read-at-use accessors — byte-identical to today.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn defaults_are_byte_identical_to_the_constants() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let get: Value = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("json");
    assert_eq!(get["sse_keep_alive_secs"], json!(DEFAULT_SSE_KEEP_ALIVE_SECS));
    assert_eq!(get["sse_max_clients"], json!(DEFAULT_SSE_MAX_CLIENTS));
    assert_eq!(get["admission_wait_secs"], json!(DEFAULT_ADMISSION_WAIT_SECS));
    assert_eq!(get["admission_poll_ms"], json!(DEFAULT_ADMISSION_POLL_MS));
    assert!(get["updated_by"].is_null(), "no updater before any PUT");

    // The read-at-use accessors return the SAME const-equal values.
    let repo = JobSettingsRepository::new(pool.clone());
    let (keep_alive, max_clients) = repo.sse_config().await;
    assert_eq!(keep_alive, Duration::from_secs(DEFAULT_SSE_KEEP_ALIVE_SECS as u64));
    assert_eq!(max_clients, DEFAULT_SSE_MAX_CLIENTS as usize);
    let (wait, poll) = repo.admission_config().await;
    assert_eq!(wait, Duration::from_secs(DEFAULT_ADMISSION_WAIT_SECS as u64));
    assert_eq!(poll, Duration::from_millis(DEFAULT_ADMISSION_POLL_MS as u64));
}

// TEST-4 [acceptance][invariant: INV-2][covers: ITEM-4]: an out-of-bounds PUT is a 422 and the
// row is UNCHANGED (Rust validate fires before the write).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn out_of_bounds_put_is_422_and_no_write() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    for body in [
        json!({ "sse_keep_alive_secs": 0 }),
        json!({ "sse_keep_alive_secs": 301 }),
        json!({ "admission_poll_ms": 5 }),
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

    let get: Value = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("json");
    assert_eq!(
        get["sse_keep_alive_secs"],
        json!(DEFAULT_SSE_KEEP_ALIVE_SECS),
        "a rejected PUT left the default intact"
    );
    assert_eq!(get["admission_poll_ms"], json!(DEFAULT_ADMISSION_POLL_MS));
}

// TEST-4b [acceptance][invariant: INV-2][covers: ITEM-4] (FIX_ROUND-1, finding #1): lowering
// admission_wait_secs ALONE below an already-stored high poll is a typed 422 (validated before
// the write), not a raw DB-CHECK 500. This is the asymmetric-cross-field path the blind audit
// corroborated.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lowering_wait_below_stored_poll_is_422_not_500() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Store a high-but-valid pair: poll 5000 < wait 60*1000.
    let seed = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "admission_wait_secs": 60, "admission_poll_ms": 5000 }))
        .send()
        .await
        .expect("seed");
    assert_eq!(seed.status().as_u16(), 200);

    // Now lower the wait ALONE below the stored poll (4*1000 = 4000 <= 5000).
    let resp = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "admission_wait_secs": 4 }))
        .send()
        .await
        .expect("lower wait");
    assert_eq!(
        resp.status().as_u16(),
        422,
        "lowering wait below the stored poll is a typed 422, never a 500"
    );

    // The stored pair is intact (the rejected write did not stick).
    let get: Value = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("json");
    assert_eq!(get["admission_wait_secs"], json!(60));
    assert_eq!(get["admission_poll_ms"], json!(5000));
}

// TEST-5 [acceptance][invariant: INV-3][covers: ITEM-4]: the guardrail values are rejected — an
// admin cannot set a hang (wait too long), an OOM (max clients too high), or a poll that does not
// fit inside the budget.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guardrail_values_are_rejected() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    for body in [
        json!({ "admission_wait_secs": 3600 }),                       // a hang
        json!({ "admission_wait_secs": 1, "admission_poll_ms": 1000 }), // poll >= wait*1000
        json!({ "sse_max_clients": 1_000_000 }),                      // an OOM
    ] {
        let resp = server
            .client
            .put(server.api_url("/job-settings"))
            .bearer_auth(&admin)
            .json(&body)
            .send()
            .await
            .expect("put");
        assert_eq!(resp.status().as_u16(), 422, "guardrail rejected: {body}");
    }
}

// TEST-6 [acceptance][invariant: INV-4][covers: ITEM-2, ITEM-4]: a valid PUT stamps updated_by ==
// the acting admin; a body carrying `updated_by` is IGNORED (not a field on the request).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn updated_by_is_stamped_from_the_admin_not_the_body() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let admin_uuid = admin_id(&pool).await;

    let bogus = Uuid::new_v4();
    let put: Value = server
        .client
        .put(server.api_url("/job-settings"))
        // The extra `updated_by` key must be ignored — it is not on UpdateJobSettingsRequest.
        .bearer_auth(&admin)
        .json(&json!({ "sse_keep_alive_secs": 30, "updated_by": bogus }))
        .send()
        .await
        .expect("put")
        .json()
        .await
        .expect("json");
    assert_eq!(put["sse_keep_alive_secs"], json!(30));
    assert_eq!(
        put["updated_by"],
        json!(admin_uuid),
        "updated_by is the acting admin, never the body-supplied value"
    );
    assert_ne!(put["updated_by"], json!(bogus), "the wire body did not win");
}

// TEST-7 [acceptance][invariant: INV-5][covers: ITEM-3, ITEM-6]: a PUT is reflected by the
// read-at-use accessors on the SAME repo without a restart.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_at_use_reflects_a_put_without_restart() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let resp = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({
            "sse_keep_alive_secs": 42,
            "sse_max_clients": 512,
            "admission_wait_secs": 30,
            "admission_poll_ms": 500
        }))
        .send()
        .await
        .expect("put");
    assert_eq!(resp.status().as_u16(), 200);

    let repo = JobSettingsRepository::new(pool.clone());
    let (keep_alive, max_clients) = repo.sse_config().await;
    assert_eq!(keep_alive, Duration::from_secs(42), "SSE keep-alive read at-use");
    assert_eq!(max_clients, 512, "SSE max clients read at-use");
    let (wait, poll) = repo.admission_config().await;
    assert_eq!(wait, Duration::from_secs(30), "admission wait read at-use");
    assert_eq!(poll, Duration::from_millis(500), "admission poll read at-use");
}

// TEST-8 [covers: ITEM-3]: a partial PUT COALESCEs — one knob changes, the rest are untouched.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn partial_put_leaves_other_knobs_unchanged() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let put: Value = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "sse_keep_alive_secs": 20 }))
        .send()
        .await
        .expect("put")
        .json()
        .await
        .expect("json");
    assert_eq!(put["sse_keep_alive_secs"], json!(20), "changed knob applied");
    assert_eq!(put["sse_max_clients"], json!(DEFAULT_SSE_MAX_CLIENTS), "untouched");
    assert_eq!(put["admission_wait_secs"], json!(DEFAULT_ADMISSION_WAIT_SECS), "untouched");
    assert_eq!(put["admission_poll_ms"], json!(DEFAULT_ADMISSION_POLL_MS), "untouched");
    assert_eq!(put["max_concurrent_jobs"], json!(2), "existing concurrency knob untouched");
}

// TEST-9 [covers: ITEM-4]: A9 deny — a user lacking jobs::settings::{read,manage} is 403 on GET
// and PUT; the admin (positive control) is 200.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_denied_without_jobs_settings_perm() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _uid = create_user_without_projects(&server, &admin, "jk_np", "jk_np@cyto.test").await;
    let token = login(&server, "jk_np").await;

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
        .json(&json!({ "sse_keep_alive_secs": 30 }))
        .send()
        .await
        .expect("put");
    assert_eq!(put.status().as_u16(), 403, "PUT denied without jobs::settings::manage");

    // Positive control: the admin can do both.
    let ok = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin get");
    assert_eq!(ok.status().as_u16(), 200, "admin GET is allowed");
}

// TEST-10 [covers: ITEM-5]: after a valid SSE-knob PUT, GET /jobs/{id}/stream returns 200
// text/event-stream (the handler reads sse_config on connect without erroring).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_boots_after_sse_knob_put() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    // A valid PUT of the SSE knobs.
    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "sse_keep_alive_secs": 5, "sse_max_clients": 10 }))
        .send()
        .await
        .expect("put");
    assert_eq!(put.status().as_u16(), 200);

    // A job to stream (queued is fine — the stream replays + yields status).
    let job = JobRepository::new(pool.clone())
        .create(
            owner,
            &CreateJobRequest {
                job_type: "stub".into(),
                name: Some("stream-smoke".into()),
                params: Some(json!({ "steps": 1 })),
                priority_class: None,
                resource_class: None,
                project_id: None,
                dataset_id: None,
            },
        )
        .await
        .expect("create job");

    let resp = server
        .client
        .get(server.api_url(&format!("/jobs/{}/stream", job.id)))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("stream");
    assert_eq!(resp.status().as_u16(), 200, "the SSE stream boots with the configured knobs");
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(ct.contains("text/event-stream"), "content-type is SSE, got {ct}");
}

// TEST-13 [covers: ITEM-6]: admit_within honors the configured poll — with the pool full it waits
// the WHOLE budget (looping on the poll) before the terminal Ok(None), rather than a one-shot.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn admit_within_waits_the_budget_when_full() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = admin_id(&pool).await;

    // Shrink the global cap to 1 so a single running row saturates the pool.
    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 1, "reserved_interactive_slots": 0 }))
        .send()
        .await
        .expect("put cap");
    assert_eq!(put.status().as_u16(), 200);

    // Fill the one slot.
    let held = admission::admit(
        &pool,
        Uuid::new_v4(),
        owner,
        "conformance",
        "hold",
        json!({}),
        None,
    )
    .await
    .expect("admit ok")
    .expect("a slot was free");

    // A detached admit with a small budget + poll → Ok(None) after ~budget (it looped).
    let budget = Duration::from_millis(300);
    let poll = Duration::from_millis(50);
    let start = Instant::now();
    let got = admission::admit_within(
        &pool,
        Uuid::new_v4(),
        owner,
        "conformance",
        "waiter",
        json!({}),
        None,
        budget,
        poll,
    )
    .await
    .expect("no db error");
    let elapsed = start.elapsed();
    assert!(got.is_none(), "the pool stayed full → terminal Ok(None)");
    assert!(
        elapsed >= budget,
        "admit_within polled until the budget expired (elapsed {elapsed:?} >= {budget:?})"
    );

    admission::close_slot(&pool, held.id, None).await;
}
