//! Jobs scheduler integration tests — the full production path through a real
//! spawned server + real Postgres: create → FCFS queue → the background
//! scheduler runs a real stub child → logs + metrics + stop → owner-scoping +
//! the admin concurrency settings + A9 permission denials.
//!
//! Jobs use `params.steps` = a small number so the stub finishes in ~2s.

use std::time::Duration;

use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::common::TestServer;

mod dag_test;
mod milestone_test;
// T4 (INV-1/INV-2 / PROV-T4-1): the cap-folded claim under N concurrent claimers —
// per-tenant + global caps never exceeded, no double-claim (the DB-level core proof).
mod cap_in_claim_concurrency_test;
// T4 (INV-3/INV-4): the stale-claim reaper reclaims a dead worker's rows, leaves a
// live worker's fresh rows, and heartbeat touches only a worker's own rows.
mod reaper_reclaim_test;
// T4 (INV-3 / DEC-9): the reaper's single-leader advisory-lock gate + discard-at-max.
mod reaper_single_runner_test;
// T4 (INV-6): two concurrent claimers on one queue both make progress (no single-instance).
mod worker_mode_no_single_instance_test;
// T4 (INV-4 / ITEM-1): the reaper is additive to the boot reconcile; schema deltas exist.
mod boot_reconcile_preserved_test;
// T4 (ITEM-1/ITEM-6): the per-tenant cap round-trips through the job_settings admin GET/PUT.
mod settings_per_tenant_cap_test;
// #54 (jobs-settings): the SSE + admission knobs — admin GET/PUT, bounds, updated_by audit,
// read-at-use, A9 deny.
mod settings_knobs_test;
// #56 (jobs-reaper-settings): the scheduler/reaper timing knobs — admin GET/PUT, bounds,
// the stale>=3×heartbeat guardrail, updated_by audit, read-at-use, A9 deny, reaper-honors-config.
mod settings_scheduler_knobs_test;
// T4 (ITEM-7): the shipped KEDA scaler query counts ONLY claimable (queued) work.
mod keda_scaler_query_test;
// T3 / G2 (PROV-T3-2): an enqueue-only serve pod never claims; a flag-on serve pod does.
mod serve_worker_split_test;
mod stop_sync_test;
// T3 / G3 (PROV-T3-3): the child-exit teardown compute-usage signal, exactly-once per job.
mod teardown_metrics_test;
// The running→completed transition emits `SyncEntity::Job` to the owner — the finalize
// emit the frontend's notify-and-refetch (no more polling) depends on.
mod terminal_sync_test;
// A failed job must carry its REASON in its own log stream, not only in the `jobs.error`
// column — for the six writers that fail a job with no child process to have logged it.
mod terminal_reason_test;
// Who may SEE a job, and who may STOP one — the companion to `799d0cf3`'s "who may
// CREATE one". Both scope arms (dataset + project), four principals each.
mod visibility_test;

// ----------------------------------------------------------------- helpers

fn token_of(body: &Value) -> String {
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("response carries an access token")
        .to_string()
}

async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "itadmin",
            "email": "it@txresbench.test",
            "password": "itPassw0rd!",
            "display_name": "IT Admin"
        }))
        .send()
        .await
        .expect("setup/admin request");
    assert_eq!(resp.status().as_u16(), 200, "setup/admin creates the owner");
    token_of(&resp.json().await.expect("setup/admin json"))
}

async fn register_user(server: &TestServer, username: &str) -> (String, String) {
    let resp = server
        .client
        .post(server.api_url("/auth/register"))
        .json(&json!({
            "username": username,
            "email": format!("{username}@txresbench.test"),
            "password": "userPassw0rd!",
            "display_name": username,
        }))
        .send()
        .await
        .expect("register request");
    let status = resp.status().as_u16();
    assert_eq!(status, 201, "register creates a user (got {status})");
    let token = token_of(&resp.json().await.expect("register json"));
    let me: Value = server
        .client
        .get(server.api_url("/auth/me"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("/auth/me")
        .json()
        .await
        .expect("/auth/me json");
    let id = me["user"]["id"].as_str().expect("user id").to_string();
    (token, id)
}

/// A user that LACKS `jobs::use`: register (gets the Users group + jobs::use),
/// then have the admin remove them from the Users group so no group grants it.
/// The `/groups` HTTP surface is stripped on this node, so the removal goes
/// through the SDK user repository over the per-test DB pool.
async fn restricted_user(server: &TestServer, _admin_token: &str, username: &str) -> String {
    let (token, user_id) = register_user(server, username).await;
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect restricted-user pool");
    crate::common::group_remove_from_users(
        &pool,
        Uuid::parse_str(&user_id).expect("user id is a uuid"),
    )
    .await;
    token
}

async fn create_job(server: &TestServer, token: &str, name: &str, steps: i64) -> String {
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&json!({ "job_type": "stub", "name": name, "params": { "steps": steps } }))
        .send()
        .await
        .expect("create job");
    assert_eq!(resp.status().as_u16(), 201, "job created");
    let body: Value = resp.json().await.expect("job json");
    assert_eq!(body["status"], json!("queued"), "new job is queued");
    body["id"].as_str().expect("job id").to_string()
}

async fn get_job(server: &TestServer, token: &str, id: &str) -> (u16, Value) {
    let resp = server
        .client
        .get(server.api_url(&format!("/jobs/{id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get job");
    let status = resp.status().as_u16();
    let body = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// Poll a job's detail until its status is in `wanted` (or timeout).
/// Parse a wire `started_at` for ORDER comparison.
///
/// These assertions used to compare the RFC3339 strings directly, which is not
/// order-safe. chrono serializes `DateTime<Utc>` with `SecondsFormat::AutoSi`,
/// so the number of fractional digits VARIES with the value: a start landing on
/// an exact millisecond emits `.123`, one that does not emits `.123456`. Compare
/// those as text and the shorter one wins on the first differing byte — `'4'`
/// (0x34) sorts below `'Z'` (0x5A) — so `.123456Z < .123Z`, exactly inverting
/// the real order. It only bites when two starts agree through the millisecond,
/// which is why it has never been seen firing here; it is still the wrong
/// comparison, and parsing costs nothing.
fn started(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .unwrap_or_else(|e| panic!("started_at {s:?} is not RFC3339: {e}"))
        .with_timezone(&chrono::Utc)
}

async fn poll_until(
    server: &TestServer,
    token: &str,
    id: &str,
    wanted: &[&str],
    timeout: Duration,
) -> Value {
    let start = tokio::time::Instant::now();
    loop {
        let (code, body) = get_job(server, token, id).await;
        if code == 200 {
            let status = body["job"]["status"].as_str().unwrap_or("");
            if wanted.contains(&status) {
                return body;
            }
        }
        if start.elapsed() > timeout {
            panic!("job {id} did not reach {wanted:?} in time (last: {body})");
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

// ----------------------------------------------------------------- TEST-9

// TEST-9: create → 201 queued owned by caller; GET /jobs lists only own jobs.
#[tokio::test]
async fn create_and_list_owned_jobs() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, user_id) = register_user(&server, "alice").await;

    let id = create_job(&server, &token, "my analysis", 2).await;

    let list: Value = server
        .client
        .get(server.api_url("/jobs"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list")
        .json()
        .await
        .expect("list json");
    let jobs = list["jobs"].as_array().expect("jobs array");
    assert_eq!(jobs.len(), 1, "the user sees their one job");
    assert_eq!(jobs[0]["job"]["id"], json!(id));
    assert_eq!(jobs[0]["job"]["owner_id"], json!(user_id), "owned by the caller");
    assert_eq!(
        jobs[0]["can_stop"],
        json!(true),
        "the list STATES stop-authority per row; the creator has it"
    );
}

// ----------------------------------------------------------------- TEST-10 + 11

// TEST-10: the scheduler auto-runs the job → logs appear → completed.
// TEST-11: the run produced ≥1 metric sample (cpu + mem).
#[tokio::test]
async fn job_runs_to_completion_with_logs_and_metrics() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, _) = register_user(&server, "bob").await;

    let id = create_job(&server, &token, "runme", 2).await;
    let detail = poll_until(&server, &token, &id, &["completed"], Duration::from_secs(45)).await;

    // TEST-10: real stub child produced log lines.
    let logs = detail["logs"].as_array().expect("logs array");
    assert!(!logs.is_empty(), "the job captured stdout log lines");
    assert!(
        logs.iter().any(|l| l["content"].as_str().unwrap_or("").contains("step")),
        "logs include the stub's progress lines"
    );

    // TEST-11: ≥1 resource metric with non-null cpu + positive rss.
    let metrics = detail["metrics"].as_array().expect("metrics array");
    assert!(!metrics.is_empty(), "the job sampled ≥1 resource metric");
    let m = &metrics[0];
    assert!(m["cpu_pct"].is_number(), "metric has a cpu_pct");
    assert!(m["mem_bytes"].as_i64().unwrap_or(0) > 0, "metric has positive rss");
}

// ----------------------------------------------------------------- TEST-12

// TEST-12: with max_concurrent_jobs=1, three jobs never run >1 at once and
// start in FCFS (created_at) order.
#[tokio::test]
async fn fcfs_respects_concurrency_cap_of_one() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Cap concurrency at 1 BEFORE creating jobs (read-at-use next tick).
    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 1 }))
        .send()
        .await
        .expect("put settings");
    assert_eq!(put.status().as_u16(), 200, "admin set concurrency=1");

    let id1 = create_job(&server, &admin, "first", 2).await;
    let id2 = create_job(&server, &admin, "second", 2).await;
    let id3 = create_job(&server, &admin, "third", 2).await;

    // Sample the running count repeatedly while they drain; it must never exceed 1.
    let start = tokio::time::Instant::now();
    let mut max_running = 0;
    loop {
        let list: Value = server
            .client
            .get(server.api_url("/jobs"))
            .bearer_auth(&admin)
            .send()
            .await
            .expect("list")
            .json()
            .await
            .expect("list json");
        let jobs = list["jobs"].as_array().expect("jobs");
        let running = jobs.iter().filter(|j| j["job"]["status"] == "running").count();
        max_running = max_running.max(running);
        let done = jobs
            .iter()
            .filter(|j| j["job"]["status"] == "completed" || j["job"]["status"] == "stopped" || j["job"]["status"] == "failed")
            .count();
        if done == 3 || start.elapsed() > Duration::from_secs(60) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    assert!(max_running <= 1, "concurrency cap of 1 was never exceeded (saw {max_running})");

    // FCFS: first-created started first.
    let d1 = poll_until(&server, &admin, &id1, &["completed"], Duration::from_secs(10)).await;
    let d2 = poll_until(&server, &admin, &id2, &["completed"], Duration::from_secs(10)).await;
    let d3 = poll_until(&server, &admin, &id3, &["completed"], Duration::from_secs(10)).await;
    let s1 = d1["job"]["started_at"].as_str().expect("s1");
    let s2 = d2["job"]["started_at"].as_str().expect("s2");
    let s3 = d3["job"]["started_at"].as_str().expect("s3");
    assert!(
        started(s1) <= started(s2) && started(s2) <= started(s3),
        "FCFS: {s1} <= {s2} <= {s3}"
    );
}

// ----------------------------------------------------------------- TEST-13

// TEST-13: stop a running job → stopped; cancel a queued job → stopped, never runs.
#[tokio::test]
async fn stop_running_and_cancel_queued() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Cap=1 so a second job stays queued while the first runs (for the cancel case).
    server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 1 }))
        .send()
        .await
        .expect("put settings");

    // A long-running job to stop.
    let running_id = create_job(&server, &admin, "longrunner", 30).await;
    let queued_id = create_job(&server, &admin, "waiter", 30).await;
    poll_until(&server, &admin, &running_id, &["running"], Duration::from_secs(20)).await;

    // Cancel the queued one (never runs).
    let stop_q = server
        .client
        .post(server.api_url(&format!("/jobs/{queued_id}/stop")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("stop queued");
    assert_eq!(stop_q.status().as_u16(), 200, "cancel queued job");
    let dq = poll_until(&server, &admin, &queued_id, &["stopped"], Duration::from_secs(10)).await;
    assert!(dq["job"]["started_at"].is_null(), "a cancelled queued job never started");

    // Stop the running one.
    let stop_r = server
        .client
        .post(server.api_url(&format!("/jobs/{running_id}/stop")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("stop running");
    assert_eq!(stop_r.status().as_u16(), 200, "stop running job");
    poll_until(&server, &admin, &running_id, &["stopped"], Duration::from_secs(20)).await;
}

// ----------------------------------------------------------------- TEST-14

// TEST-14 (ITEM-19 / DEC-18): boot run-durability reconcile fails an orphaned
// `running` job that has NO finalizable outputs (a non-analysis job / a mid-run
// crash) — with the workspace preserved, never silently discarded. (The finalize
// leg — an uningested run recovered — is TEST-62 below.)
#[tokio::test]
async fn boot_reconcile_fails_orphan_without_manifest() {
    use txresbench::modules::jobs::scheduler::reconcile_orphaned_running;

    let server = TestServer::spawn().await;
    setup_admin(&server).await;

    // Connect our own pool to this test's DB and insert an orphaned running job
    // (as if the server had died mid-run).
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect test db");
    let owner: Uuid = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("an admin user exists");
    let orphan = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at) \
         VALUES ($1, $2, 'stub', 'orphan', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    )
    .bind(orphan)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("insert orphan running job");

    // The REAL boot reconcile: a stub job has no /outputs manifest → fail-preserve.
    // Empty workspace + staging roots (no per-run dir in either) make "no manifest"
    // unambiguous. ITEM-17: outputs are looked for in the STAGING root, so both are
    // passed — the shape `JobsModule::init` uses.
    let base = std::env::temp_dir().join(format!("txr-recon14-{}", Uuid::new_v4()));
    let root = base.join("sandboxes");
    let staging_root = base.join("run-staging");
    let report = reconcile_orphaned_running(&pool, &root, &staging_root).await;
    assert!(report.failed_preserved.contains(&orphan), "orphan without manifest is failed-preserved");
    assert!(report.finalized.is_empty(), "nothing to finalize");

    let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(orphan)
        .fetch_one(&pool)
        .await
        .expect("read orphan status");
    assert_eq!(status, "failed", "orphaned running w/o manifest → failed");
    let err: Option<String> = sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
        .bind(orphan)
        .fetch_one(&pool)
        .await
        .expect("read orphan error");
    assert!(
        err.unwrap_or_default().contains("interrupted"),
        "carries an interrupted-by-restart error"
    );
}

// ----------------------------------------------------------------- TEST-15

// TEST-15: settings GET default 2, PUT updates, out-of-bounds rejected.
#[tokio::test]
async fn job_settings_get_put_and_bounds() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let get: Value = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get")
        .json()
        .await
        .expect("get json");
    assert_eq!(get["max_concurrent_jobs"], json!(2), "default cap is 2");

    let put: Value = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 5 }))
        .send()
        .await
        .expect("put")
        .json()
        .await
        .expect("put json");
    assert_eq!(put["max_concurrent_jobs"], json!(5), "cap updated");

    for bad in [0, 65] {
        let resp = server
            .client
            .put(server.api_url("/job-settings"))
            .bearer_auth(&admin)
            .json(&json!({ "max_concurrent_jobs": bad }))
            .send()
            .await
            .expect("put bad");
        assert!(
            resp.status().as_u16() == 400 || resp.status().as_u16() == 422,
            "out-of-bounds {bad} rejected (got {})",
            resp.status().as_u16()
        );
    }
}

// ----------------------------------------------------------------- TEST-16

// TEST-16: the per-job SSE stream delivers replay + live log/metric/status frames.
#[tokio::test]
async fn job_sse_stream_delivers_frames() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, _) = register_user(&server, "carol").await;

    let id = create_job(&server, &token, "streamed", 4).await;
    // Let it start so there is live activity.
    poll_until(&server, &token, &id, &["running", "completed"], Duration::from_secs(20)).await;

    // Read the raw SSE stream for a couple seconds and collect event names.
    let resp = server
        .client
        .get(server.api_url(&format!("/jobs/{id}/stream")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("open stream");
    assert_eq!(resp.status().as_u16(), 200, "stream opens");
    let body = tokio::time::timeout(Duration::from_secs(8), resp.text())
        .await
        .map(|r| r.unwrap_or_default())
        .unwrap_or_default();
    // SSE wire format uses "event: <name>" (with a space).
    assert!(body.contains("event: status"), "stream carries a status frame:\n{body}");
    assert!(
        body.contains("event: log") || body.contains("event: metric"),
        "stream carries log/metric frames:\n{body}"
    );
}

// ----------------------------------------------------------------- TEST-17

// TEST-17: detail is owner-or-admin; a foreign user's job → 404; admin sees any.
#[tokio::test]
async fn detail_owner_scoping() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (alice, _) = register_user(&server, "alice2").await;
    let (bob, _) = register_user(&server, "bob2").await;

    let id = create_job(&server, &alice, "alice-only", 2).await;

    // Owner sees it.
    let (own_code, own_body) = get_job(&server, &alice, &id).await;
    assert_eq!(own_code, 200, "owner reads their job");
    assert_eq!(own_body["job"]["id"], json!(id));

    // A different user gets 404 (existence not leaked).
    let (foreign_code, _) = get_job(&server, &bob, &id).await;
    assert_eq!(foreign_code, 404, "foreign job → 404");

    // Admin reads any.
    let (admin_code, _) = get_job(&server, &admin, &id).await;
    assert_eq!(admin_code, 200, "admin reads any job");
}

// ----------------------------------------------------------------- TEST-18

// TEST-18: a freshly-registered (Users-group) user holds jobs::use → create 201.
#[tokio::test]
async fn users_group_grants_jobs_use() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, _) = register_user(&server, "dave").await;

    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(&token)
        .json(&json!({ "job_type": "stub", "name": "granted", "params": { "steps": 1 } }))
        .send()
        .await
        .expect("create");
    assert_eq!(resp.status().as_u16(), 201, "the grant migration gave Users jobs::use");
}

// ----------------------------------------------------------------- TEST-19 (A9)

// TEST-19 (A9 deny): 401 unauth; 403 for a user lacking jobs::use; 403 on
// settings for a non-admin.
#[tokio::test]
async fn permission_denials() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // 401 — no token.
    let unauth = server
        .client
        .get(server.api_url("/jobs"))
        .send()
        .await
        .expect("unauth");
    assert_eq!(unauth.status().as_u16(), 401, "GET /jobs without a token → 401");

    // 403 — a user lacking jobs::use.
    let restricted = restricted_user(&server, &admin, "nobody").await;
    let denied = server
        .client
        .get(server.api_url("/jobs"))
        .bearer_auth(&restricted)
        .send()
        .await
        .expect("restricted list");
    assert_eq!(denied.status().as_u16(), 403, "user without jobs::use → 403");

    // 403 — a normal user (has jobs::use, NOT settings) on the settings endpoints.
    let (user, _) = register_user(&server, "eve").await;
    let get_settings = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&user)
        .send()
        .await
        .expect("get settings");
    assert_eq!(get_settings.status().as_u16(), 403, "non-admin GET /job-settings → 403");
    let put_settings = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&user)
        .json(&json!({ "max_concurrent_jobs": 4 }))
        .send()
        .await
        .expect("put settings");
    assert_eq!(put_settings.status().as_u16(), 403, "non-admin PUT /job-settings → 403");
}

// ----------------------------------------------------------------- P3: scheduling classes

/// Create a job with an explicit job_type + priority_class + params.
async fn create_job_full(
    server: &TestServer,
    token: &str,
    name: &str,
    job_type: &str,
    priority: Option<&str>,
    params: Value,
) -> (u16, Value) {
    let mut body = json!({ "job_type": job_type, "name": name, "params": params });
    if let Some(p) = priority {
        body["priority_class"] = json!(p);
    }
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("create job");
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

// TEST-24 + TEST-18(schema): an analysis job persists priority/resource class;
// a malformed analysis spec is rejected 400; priority_class clamps unknown→normal.
#[tokio::test]
async fn analysis_job_create_persists_class_and_validates_spec() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // A valid analysis spec (an inline python script; no inputs).
    let params = json!({
        "language": "python",
        "script": "print('hi')",
        "schedule": { "class": "interactive" }
    });
    let (code, body) = create_job_full(&server, &admin, "an", "analysis", None, params).await;
    assert_eq!(code, 201, "valid analysis job created (body: {body})");
    // priority comes from schedule.class (interactive); resource defaults cpu-sandbox.
    assert_eq!(body["priority_class"], json!("interactive"), "spec class inferred");
    assert_eq!(body["resource_class"], json!("cpu-sandbox"), "default resource class");

    // An explicit priority_class overrides + an unknown value clamps to normal.
    let (code2, body2) = create_job_full(
        &server, &admin, "an2", "analysis",
        Some("not-a-class"),
        json!({ "language": "python", "script": "print(1)" }),
    ).await;
    assert_eq!(code2, 201);
    assert_eq!(body2["priority_class"], json!("normal"), "unknown priority clamps to normal");

    // A malformed analysis spec (no script / no code_ref) is rejected at create.
    let (code3, body3) = create_job_full(
        &server, &admin, "bad", "analysis", None,
        json!({ "language": "python" }),
    ).await;
    assert_eq!(code3, 400, "spec with no script → 400 (body: {body3})");
    assert_eq!(body3["error_code"], json!("ANALYSIS_SPEC_INVALID"));
}

// TEST-25: job-settings carries reserved_interactive_slots; PUT updates it;
// out-of-range is 422; non-admin is 403.
#[tokio::test]
async fn job_settings_reserved_interactive_slots() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let get: Value = server
        .client
        .get(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .send().await.expect("get").json().await.expect("json");
    assert!(get["reserved_interactive_slots"].is_number(), "settings expose reserved slots");

    // Set cap=4, reserved=2 (valid).
    let ok = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 4, "reserved_interactive_slots": 2 }))
        .send().await.expect("put");
    assert_eq!(ok.status().as_u16(), 200);
    let updated: Value = ok.json().await.expect("json");
    assert_eq!(updated["reserved_interactive_slots"], json!(2), "reserved updated");

    // reserved >= cap → 422.
    let bad = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 2, "reserved_interactive_slots": 2 }))
        .send().await.expect("put bad");
    assert_eq!(bad.status().as_u16(), 422, "reserved == cap rejected");

    // Non-admin PUT → 403.
    let (user, _id) = register_user(&server, "bob").await;
    let denied = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&user)
        .json(&json!({ "reserved_interactive_slots": 0 }))
        .send().await.expect("put denied");
    assert_eq!(denied.status().as_u16(), 403, "non-admin cannot change settings");
}

// TEST-26: class-priority claiming — with a blocker holding the single slot, a
// later-arriving interactive job is claimed BEFORE an earlier-queued batch job.
#[tokio::test]
async fn interactive_claimed_before_queued_batch() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // cap=1 so the blocker holds the pool while batch + interactive queue.
    server.client.put(server.api_url("/job-settings")).bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 1, "reserved_interactive_slots": 0 }))
        .send().await.expect("put");

    // A blocker fills the one slot.
    let blocker = create_job(&server, &admin, "blocker", 6).await;
    poll_until(&server, &admin, &blocker, &["running"], Duration::from_secs(20)).await;

    // Now BOTH queue while the blocker runs: batch first (older), interactive second.
    let (_c1, batch) = create_job_full(&server, &admin, "batch", "stub", Some("batch"),
        json!({ "steps": 2 })).await;
    let (_c2, inter) = create_job_full(&server, &admin, "inter", "stub", Some("interactive"),
        json!({ "steps": 2 })).await;
    let batch_id = batch["id"].as_str().unwrap().to_string();
    let inter_id = inter["id"].as_str().unwrap().to_string();

    // Both complete; the interactive must have STARTED before the batch (claimed
    // first out of the queue despite being created later) — class priority.
    let di = poll_until(&server, &admin, &inter_id, &["completed"], Duration::from_secs(40)).await;
    let db = poll_until(&server, &admin, &batch_id, &["completed"], Duration::from_secs(40)).await;
    let si = di["job"]["started_at"].as_str().expect("inter started");
    let sb = db["job"]["started_at"].as_str().expect("batch started");
    assert!(
        started(si) <= started(sb),
        "interactive claimed before batch: inter {si} <= batch {sb}"
    );
}

// TEST-27: per-user fair-share (WFQ by owner running-count, ITEM-20) — owner B's
// single job is not starved behind owner A's burst. Needs cap>=2: the metric is
// "owner's CURRENT running count", so B only jumps ahead while A already holds a
// running slot (at cap=1 nothing is running at claim time → it degrades to FCFS).
#[tokio::test]
async fn fair_share_across_two_owners() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    server.client.put(server.api_url("/job-settings")).bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 2, "reserved_interactive_slots": 0 }))
        .send().await.expect("put");

    let (a, _ai) = register_user(&server, "ownerA").await;
    let (b, _bi) = register_user(&server, "ownerB").await;

    // A submits a burst FIRST (4 jobs, ~3s each so they stay running); B submits
    // one AFTER. Under FCFS, B waits behind all of A's burst. Under fair-share,
    // once A holds a running slot, B's owner-running-count (0) beats A's (>=1),
    // so B is claimed into the next free slot — B does not run dead-last.
    let a1 = create_job(&server, &a, "a1", 3).await;
    let a2 = create_job(&server, &a, "a2", 3).await;
    let a3 = create_job(&server, &a, "a3", 3).await;
    let a4 = create_job(&server, &a, "a4", 3).await;
    let b1 = create_job(&server, &b, "b1", 3).await;

    let da4 = poll_until(&server, &a, &a4, &["completed"], Duration::from_secs(60)).await;
    let db1 = poll_until(&server, &b, &b1, &["completed"], Duration::from_secs(60)).await;
    let sa4 = da4["job"]["started_at"].as_str().expect("a4 started");
    let sb1 = db1["job"]["started_at"].as_str().expect("b1 started");
    // B's single job started before A's LAST — it interleaved, not starved (FCFS
    // would start a4 before b1).
    assert!(
        started(sb1) <= started(sa4),
        "fair-share: B's job started before A's last (b1 {sb1} <= a4 {sa4})"
    );
    let _ = (a1, a2, a3);
}

// TEST-31: the stub queue path (create → running → completed + logs + metrics)
// STILL works end-to-end after the class-scheduler/runner rewrite (regression).
#[tokio::test]
async fn stub_job_completes_end_to_end_after_rewrite() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let id = create_job(&server, &admin, "regression", 2).await;
    let detail = poll_until(&server, &admin, &id, &["completed"], Duration::from_secs(30)).await;
    assert_eq!(detail["job"]["status"], json!("completed"));
    assert_eq!(detail["job"]["priority_class"], json!("normal"), "stub defaults to normal");
    assert!(!detail["logs"].as_array().unwrap().is_empty(), "logs captured");
    assert!(!detail["metrics"].as_array().unwrap().is_empty(), "metrics captured");
}

// TEST-32 (project_id authz, from blind-audit): an analysis job that names a
// `project_id` requires EDIT access to it — a user cannot write outputs into
// another user's project (foreign project → 404, no existence leak); the owner can.
#[tokio::test]
async fn analysis_job_project_id_requires_edit_access() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (a, _ai) = register_user(&server, "projectowner").await;
    let (b, _bi) = register_user(&server, "outsider").await;

    // Owner A creates a project.
    let project: Value = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(&a)
        .json(&json!({ "name": "A's project", "description": "" }))
        .send().await.expect("create project").json().await.expect("project json");
    let project_id = project["id"].as_str().expect("project id");

    let analysis = |token: &str, sid: &str| {
        let body = json!({
            "job_type": "analysis",
            "name": "an",
            "params": { "language": "python", "script": "print(1)" },
            "project_id": sid
        });
        server.client.post(server.api_url("/jobs")).bearer_auth(token).json(&body).send()
    };

    // Outsider B → foreign project → 404 (invisible, no write).
    let denied = analysis(&b, project_id).await.expect("b create");
    assert_eq!(denied.status().as_u16(), 404, "outsider cannot target A's project");

    // Owner A → 201 (has edit access).
    let ok = analysis(&a, project_id).await.expect("a create");
    assert_eq!(ok.status().as_u16(), 201, "owner can scope a job to their project");
}

// TEST-33 (wall-clock timeout, blind-audit A1): a job with a wall-clock budget
// shorter than its runtime is KILLED and marked failed — a low-CPU/long job can
// never run forever holding a slot (the executor's deadline path, shared with the
// analysis runner).
#[tokio::test]
async fn wall_clock_timeout_kills_and_fails_the_job() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // steps=30 (~30s) but a 2s wall-clock budget → the executor must kill it.
    let (code, body) = create_job_full(
        &server, &admin, "runaway", "stub", None,
        json!({ "steps": 30, "timeout_secs": 2 }),
    ).await;
    assert_eq!(code, 201);
    let id = body["id"].as_str().unwrap().to_string();

    let detail = poll_until(&server, &admin, &id, &["failed", "completed"], Duration::from_secs(20)).await;
    assert_eq!(detail["job"]["status"], json!("failed"), "the over-budget job is failed, not left running");
    let err = detail["job"]["error"].as_str().unwrap_or("");
    assert!(err.contains("timeout"), "failure reason names the wall-clock timeout: {err}");
}

// ----------------------------------------------------------------- TEST-62 (ITEM-19)

// TEST-62: boot run-durability reconcile — one analysis job that finished but was
// never ingested (its workspace holds a valid /outputs/manifest.json) is
// FINALIZED (ingest is idempotent via the artifact natural key — no double-insert);
// one analysis job that crashed mid-run (no manifest) is FAILED with its workspace
// PRESERVED. Follows the direct-call boot-safety pattern (the harness can't respawn
// a server on the same DB) with an injected sink that models the real natural key.
#[tokio::test]
async fn boot_reconcile_finalizes_uningested_and_fails_midrun() {
    use std::collections::BTreeSet;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use txresbench::modules::jobs::models::Job;
    use txresbench::modules::jobs::scheduler::reconcile_orphaned_running_in;
    use txresbench::modules::jobs::seams::{ArtifactIngestSink, PeakMetrics, RunRecorder};
    use txresbench::modules::sandbox::outputs::ProducedOutput;

    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect test db");
    let owner: Uuid = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("an admin user exists");

    // A per-test pair of roots, the shape `JobsModule::init` passes (ITEM-17): a
    // sandboxes root holding per-run WORKSPACES, and a SEPARATE staging root holding
    // per-run OUTPUTS. Both name their per-run dirs <root>/<job_id>.
    let base = std::env::temp_dir().join(format!("txr-recon-{}", Uuid::new_v4()));
    let root = base.join("sandboxes");
    let staging_root = base.join("run-staging");
    assert!(
        !staging_root.starts_with(&root),
        "the staging root is outside the workspace root"
    );

    // --- job1: finished-but-uningested — a valid manifest + output files on disk,
    // in its STAGING dir (where a real run writes them), not in its workspace.
    let job1 = Uuid::new_v4();
    let run1 = Uuid::new_v4();
    tokio::fs::create_dir_all(root.join(job1.to_string()))
        .await
        .unwrap();
    let out1 = staging_root.join(job1.to_string()).join("outputs");
    tokio::fs::create_dir_all(&out1).await.unwrap();
    tokio::fs::write(out1.join("a.bin"), b"aaa").await.unwrap();
    tokio::fs::write(out1.join("b.bin"), b"bbb").await.unwrap();
    let manifest = json!({ "outputs": [
        { "id": "out_a", "datatype": "data", "path": "a.bin", "layout": "opaque", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" },
        { "id": "out_b", "datatype": "data", "path": "b.bin", "layout": "opaque", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" },
    ]});
    tokio::fs::write(out1.join("manifest.json"), serde_json::to_vec(&manifest).unwrap())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at, run_id) \
         VALUES ($1, $2, 'analysis', 'uningested', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), $3)",
    )
    .bind(job1)
    .bind(owner)
    .bind(run1)
    .execute(&pool)
    .await
    .expect("insert job1 (uningested)");

    // --- job2: crashed mid-run — both dirs exist, NO manifest (partial state): a
    // half-written file in staging is exactly what a killed child leaves.
    let job2 = Uuid::new_v4();
    let ws2 = root.join(job2.to_string());
    let stg2 = staging_root.join(job2.to_string());
    tokio::fs::create_dir_all(&ws2).await.unwrap();
    tokio::fs::create_dir_all(stg2.join("outputs")).await.unwrap();
    tokio::fs::write(stg2.join("outputs").join("partial.tmp"), b"half").await.unwrap();
    sqlx::query(
        "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at) \
         VALUES ($1, $2, 'analysis', 'midrun', 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    )
    .bind(job2)
    .bind(owner)
    .execute(&pool)
    .await
    .expect("insert job2 (mid-run)");

    // A sink modeling the `artifacts` natural key (run_id, output_id): a set, so a
    // re-ingested output UPSERTS (no dup). `inserts` counts every insert ATTEMPT.
    #[derive(Default)]
    struct NaturalKeyIngest {
        keys: Mutex<BTreeSet<(Uuid, String)>>,
        inserts: AtomicUsize,
    }
    #[async_trait]
    impl ArtifactIngestSink for NaturalKeyIngest {
        async fn ingest_outputs(
            &self,
            job: &Job,
            outputs: &[ProducedOutput],
            _ws: &Path,
        ) -> Result<(), String> {
            let run = job.run_id.unwrap_or(job.id);
            let mut k = self.keys.lock().unwrap();
            for o in outputs {
                self.inserts.fetch_add(1, Ordering::SeqCst);
                k.insert((run, o.id.clone()));
            }
            Ok(())
        }
    }
    struct NoopRec;
    #[async_trait]
    impl RunRecorder for NoopRec {
        async fn record_run(
            &self,
            _j: &Job,
            _o: &[ProducedOutput],
            _e: i32,
            _p: PeakMetrics,
            _ws: &std::path::Path,
        ) {
        }
    }

    // Simulate a PARTIAL prior ingest before the crash: (run1, out_a) already landed.
    let sink = Arc::new(NaturalKeyIngest::default());
    sink.keys.lock().unwrap().insert((run1, "out_a".to_string()));

    // --- reconcile ---
    let report =
        reconcile_orphaned_running_in(&pool, &root, &staging_root, sink.clone(), Arc::new(NoopRec))
            .await;

    // job1: finalized → completed; both outputs ingested; natural key deduped.
    assert!(report.finalized.contains(&job1), "uningested run finalized");
    let s1: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(job1)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(s1, "completed", "uningested run reconciled to completed");
    assert_eq!(sink.inserts.load(Ordering::SeqCst), 2, "both declared outputs ingested");
    assert_eq!(
        sink.keys.lock().unwrap().len(),
        2,
        "no double-insert: (run1,out_a) upserted, not duplicated"
    );
    assert!(
        !root.join(job1.to_string()).exists(),
        "finalized workspace cleaned after successful ingest"
    );
    // ITEM-17: and its output staging, which is a different tree — the outputs were
    // READ from there, so this cannot pass by the dir never having existed.
    assert!(
        !staging_root.join(job1.to_string()).exists(),
        "finalized output staging cleaned after successful ingest"
    );

    // job2: failed + workspace PRESERVED.
    assert!(report.failed_preserved.contains(&job2), "mid-run crash failed-preserved");
    let s2: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(job2)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(s2, "failed", "mid-run crash reconciled to failed");
    let e2: Option<String> = sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
        .bind(job2)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(e2.unwrap_or_default().contains("preserved"), "error notes the workspace is preserved");
    assert!(ws2.exists(), "mid-run workspace PRESERVED (not silently discarded)");
    // ITEM-17: its output staging is preserved with it — a fail-preserve exists so a
    // half-finished run can be inspected, and its partial outputs are the part worth
    // inspecting. Reclaimed later by the boot sweep, once it is no longer live.
    assert!(stg2.exists(), "mid-run output staging PRESERVED");

    // Idempotent across a SECOND restart: job1 is terminal now → not re-finalized,
    // no re-ingest (proves the reconcile itself doesn't double-process).
    let report2 =
        reconcile_orphaned_running_in(&pool, &root, &staging_root, sink.clone(), Arc::new(NoopRec))
            .await;
    assert!(!report2.finalized.contains(&job1), "already-completed run not re-finalized");
    assert_eq!(sink.inserts.load(Ordering::SeqCst), 2, "no re-ingest on the second reconcile");

    let _ = tokio::fs::remove_dir_all(&base).await;
}

// ----------------------------------------------------------------- ITEM-12b (log paging)

/// Fetch one page of `/jobs/{id}/logs`.
async fn logs_page(server: &TestServer, token: &str, id: &str, after: i32, limit: i64) -> Value {
    let resp = server
        .client
        .get(server.api_url(&format!("/jobs/{id}/logs?after_seq={after}&limit={limit}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("logs page request");
    assert_eq!(resp.status().as_u16(), 200, "logs page → 200");
    resp.json().await.expect("logs page json")
}

// ITEM-12b: paged log retrieval returns BOUNDED pages + a STABLE forward cursor
// over a large log, covering every line exactly once with NO silent truncation.
// The SSE stream (TEST-16) stays the live/replay path and is untouched.
#[tokio::test]
async fn job_logs_paging_bounded_pages_and_stable_cursor() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, _uid) = register_user(&server, "pager").await;

    // A completed job (produces some real captured logs).
    let id = create_job(&server, &token, "long-run", 3).await;
    poll_until(&server, &token, &id, &["completed"], Duration::from_secs(30)).await;

    // Append a controlled batch so the log is comfortably multi-page + deterministic,
    // independent of the stub's exact line count (mirrors TEST-14's direct-DB seed).
    let pool = sqlx::SqlitePool::connect(server.database_url()).await.expect("db");
    let job_uuid = Uuid::parse_str(&id).unwrap();
    let max_seq: i32 = sqlx::query_scalar("SELECT COALESCE(MAX(seq), 0) FROM job_logs WHERE job_id = $1")
        .bind(job_uuid)
        .fetch_one(&pool)
        .await
        .unwrap();
    for i in 1..=40 {
        sqlx::query(
            "INSERT INTO job_logs (id, job_id, seq, stream, content) VALUES ($1, $2, $3, 'stdout', $4)",
        )
        .bind(Uuid::new_v4())
        .bind(job_uuid)
        .bind(max_seq + i)
        .bind(format!("extra line {i}"))
        .execute(&pool)
        .await
        .unwrap();
    }

    let first = logs_page(&server, &token, &id, 0, 7).await;
    let total = first["total"].as_i64().expect("total present");
    assert!(total >= 40, "total counts every line (got {total})");

    // Stable cursor: the same after_seq returns the identical page.
    let first_again = logs_page(&server, &token, &id, 0, 7).await;
    assert_eq!(first["logs"], first_again["logs"], "cursor is stable — the same page repeats");

    // Walk every page forward; collect seqs.
    let mut seqs: Vec<i64> = Vec::new();
    let mut after = 0i32;
    let mut guard = 0;
    loop {
        let p = logs_page(&server, &token, &id, after, 7).await;
        let logs = p["logs"].as_array().expect("logs array");
        assert!(logs.len() <= 7, "page is bounded to the limit");
        for l in logs {
            seqs.push(l["seq"].as_i64().unwrap());
        }
        match p["next_cursor"].as_i64() {
            Some(c) => after = c as i32,
            None => break,
        }
        guard += 1;
        assert!(guard < 1000, "paging terminates");
    }
    // No silent truncation: every line is covered exactly once, ascending.
    assert_eq!(seqs.len() as i64, total, "all {total} lines paged (no truncation)");
    let mut sorted = seqs.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), seqs.len(), "no duplicate lines across pages");
    assert_eq!(seqs, sorted, "pages are in ascending seq order");

    // Owner-scoped like the other jobs routes: a foreign user → 404 (no leak).
    let (bob, _) = register_user(&server, "pager-bob").await;
    let denied = server
        .client
        .get(server.api_url(&format!("/jobs/{id}/logs")))
        .bearer_auth(&bob)
        .send()
        .await
        .expect("foreign logs request");
    assert_eq!(denied.status().as_u16(), 404, "foreign job's logs → 404");
}

// ------------------------------------------------- FIX-1/FIX-5 security helpers

/// A pool onto the SAME per-test DB the spawned server uses (lets a test drive the
/// library authz/ingest chokepoints directly).
async fn pool_for(server: &TestServer) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(4)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// Upload one real file into a fresh dataset owned by `token`'s user → its
/// `(dataset_id, file_id)`. The `files` row is owned by the uploading user.
async fn upload_dataset(
    server: &TestServer,
    token: &str,
    name: &str,
    filename: &str,
    bytes: &[u8],
) -> (Uuid, Uuid) {
    let create = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(token)
        .json(&json!({ "name": name }))
        .send()
        .await
        .expect("create dataset");
    assert_eq!(create.status().as_u16(), 201, "create dataset {name}");
    let dataset_id =
        Uuid::parse_str(create.json::<Value>().await.unwrap()["id"].as_str().unwrap()).unwrap();

    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(filename.to_string()),
    );
    let up = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/upload")))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload dataset file");
    assert_eq!(up.status().as_u16(), 200, "upload {filename}");
    let file_id =
        Uuid::parse_str(up.json::<Value>().await.unwrap()["file_id"].as_str().unwrap()).unwrap();
    (dataset_id, file_id)
}

/// Share dataset `id` (owned by `owner_token`) with user `principal_id` (view).
async fn share_dataset_with_user(
    server: &TestServer,
    owner_token: &str,
    id: Uuid,
    principal_id: Uuid,
) {
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{id}/shares")))
        .bearer_auth(owner_token)
        .json(&json!({ "principal_type": "user", "principal_id": principal_id, "role": "view" }))
        .send()
        .await
        .expect("share dataset");
    let s = resp.status().as_u16();
    assert!(s == 200 || s == 201, "share dataset → {s}");
}

// FIX-1 (cross-user input IDOR): the input-ref authorization the sandbox input
// chokepoint enforces. A stranger may NOT read another user's file; the file OWNER
// may; and a SHAREE of the dataset the file belongs to may (so the intended
// shared-dataset processing flow is preserved, not broken by the fix). Tested
// directly on the authz predicate (`file_readable_by`) — the exact decision
// `materialize_inputs` gates every `dataset_file_ref` on.
#[tokio::test]
async fn dataset_file_ref_authz_owner_sharee_stranger() {
    use txresbench::modules::sandbox::inputs::file_readable_by;

    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Owner B uploads a real dataset file (owned by B).
    let (owner_b_token, owner_b_id) = register_user(&server, "authz_owner_b").await;
    let owner_b_id = Uuid::parse_str(&owner_b_id).unwrap();
    let (ds_b, file_b) =
        upload_dataset(&server, &owner_b_token, "B private", "b.csv", b"cell,gene\nc1,9\n").await;

    // Stranger A: a different user with no access to B's dataset.
    let (_a_token, owner_a_id) = register_user(&server, "authz_stranger_a").await;
    let owner_a_id = Uuid::parse_str(&owner_a_id).unwrap();

    // OWNER may read; STRANGER may not (the IDOR is closed).
    assert!(file_readable_by(&pool, file_b, owner_b_id).await.unwrap(), "owner reads own file");
    assert!(
        !file_readable_by(&pool, file_b, owner_a_id).await.unwrap(),
        "a stranger may NOT read another user's file (IDOR closed)"
    );
    // A nonexistent file id → false (uniform reject, no existence oracle).
    assert!(!file_readable_by(&pool, Uuid::new_v4(), owner_b_id).await.unwrap());

    // After B SHARES the dataset with A, A (a sharee) may read the file — the
    // intended shared-dataset processing flow is preserved.
    share_dataset_with_user(&server, &owner_b_token, ds_b, owner_a_id).await;
    assert!(
        file_readable_by(&pool, file_b, owner_a_id).await.unwrap(),
        "a sharee of the dataset may read its files (flow not over-blocked)"
    );
}

// FIX-1 (chokepoint wiring): `materialize_inputs` gates on the authz above, so a
// cross-user `dataset_file_ref` is rejected there BEFORE any byte is staged — the
// job fails safely and the other user's bytes never reach the sandbox.
#[tokio::test]
async fn materialize_rejects_cross_user_dataset_file_ref() {
    use txresbench::modules::sandbox::inputs::materialize_inputs;
    use txresbench::modules::sandbox::spec::AnalysisSpec;
    use txresbench::modules::workstore::object_store::LocalFsStore;

    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Owner B uploads a real dataset file (owned by B).
    let (owner_b_token, _owner_b_id) = register_user(&server, "mat_owner_b").await;
    let (_ds_b, file_b) =
        upload_dataset(&server, &owner_b_token, "B private", "b.csv", b"cell,gene\nc1,9\n").await;

    // Attacker A references B's file as a sandbox input.
    let (_a_token, owner_a_id) = register_user(&server, "mat_attacker_a").await;
    let owner_a_id = Uuid::parse_str(&owner_a_id).unwrap();

    let store = LocalFsStore::new(
        std::env::temp_dir().join(format!("txr-idor-store-{}", Uuid::new_v4())),
    );
    let spec = AnalysisSpec::parse(&json!({
        "language": "python", "script": "print(1)",
        "inputs": [{ "slot": "x", "dataset_file_ref": file_b, "sandbox_subpath": "x.csv" }],
    }))
    .expect("spec parses");

    let in_a = std::env::temp_dir().join(format!("txr-idor-inA-{}", Uuid::new_v4()));
    let err = materialize_inputs(&spec, &in_a, owner_a_id, &[], &pool, &store)
        .await
        .expect_err("cross-user file ref is rejected at materialize");
    assert!(err.to_string().contains("not accessible"), "IDOR closed: {err}");
    assert!(!in_a.join("x.csv").exists(), "B's bytes were never staged for A");

    let _ = std::fs::remove_dir_all(&in_a);
}

// FIX-5 / ITEM-68: `WorkstoreIngestSink` resolves the DATASET scope from the
// `job_scope` table (via `JobRepository::job_scope`) rather than a hand-passed
// scope, so a dataset-scoped analysis run's outputs are cataloged with
// `artifacts.dataset_id` set (and no `project_id`). This is the real sink path (not
// the `ingest_run_outputs(dataset_id=…)` shortcut the existing process test uses),
// and it proves the sink no longer silently downgrades a dataset-scoped run to
// scope-less.
#[tokio::test]
async fn ingest_sink_resolves_dataset_scope_from_job() {
    use txresbench::modules::jobs::models::CreateJobRequest;
    use txresbench::modules::jobs::repository::JobRepository;
    use txresbench::modules::jobs::seams::{ArtifactIngestSink, WorkstoreIngestSink};

    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (owner_token, owner_id) = register_user(&server, "ingest_owner").await;
    let owner_id = Uuid::parse_str(&owner_id).unwrap();
    let pool = pool_for(&server).await;

    // A dataset owned by the job owner (the FK target for artifacts.dataset_id).
    let (dataset_id, _file) =
        upload_dataset(&server, &owner_token, "scope ds", "s.csv", b"a\n1\n").await;

    // The sink's `try_get_object_store()` must resolve, so make sure the test
    // binary's process-wide store is installed. It is the HARNESS's, not this
    // test's: `OBJECT_STORE`/`STORE_CLAIM` are `OnceCell`s, so a private root
    // installed here would either lose the race silently or — as it used to —
    // outlive its own directory and strand every later test that sweeps. We
    // assert catalog ROWS, not blobs, so the shared content-addressed root is
    // exactly as good.
    crate::common::object_store::shared_object_store_root();

    // A dataset-scoped analysis job (project_id=None, dataset_id=Some) via the REAL
    // create path → a `job_scope(scope_kind='dataset')` row is persisted (ITEM-68),
    // which is what the sink resolves.
    let job = JobRepository::new(pool.clone())
        .create(
            owner_id,
            &CreateJobRequest {
                job_type: "analysis".into(),
                name: Some("scope run".into()),
                params: Some(json!({ "language": "python", "script": "print(1)" })),
                priority_class: None,
                resource_class: None,
                project_id: None,
                dataset_id: Some(dataset_id),
            },
        )
        .await
        .expect("create dataset-scoped job");

    // Stage a real /outputs/manifest.json + file.
    let ws = std::env::temp_dir().join(format!("txr-ingest-ws-{}", Uuid::new_v4()));
    let outputs = ws.join("outputs");
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    let manifest = json!({ "outputs": [
        { "id": "result", "datatype": "report/html", "path": "r.html", "layout": "opaque", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" }
    ]});
    tokio::fs::write(outputs.join("manifest.json"), serde_json::to_vec(&manifest).unwrap())
        .await
        .unwrap();
    tokio::fs::write(outputs.join("r.html"), b"<html>ok</html>").await.unwrap();

    // The sink resolves the dataset scope from the job — we pass NO scope. The
    // produced artifact must carry the dataset scope (and no project scope).
    WorkstoreIngestSink::new(pool.clone())
        .ingest_outputs(&job, &[], &ws)
        .await
        .expect("dataset-scoped ingest via the sink");

    let (dsid, stid): (Option<Uuid>, Option<Uuid>) =
        sqlx::query_as("SELECT dataset_id, project_id FROM artifacts WHERE run_id = $1")
            .bind(job.id)
            .fetch_one(&pool)
            .await
            .expect("the run's cataloged artifact");
    assert_eq!(dsid, Some(dataset_id), "sink resolved dataset scope → artifacts.dataset_id set");
    assert!(stid.is_none(), "a dataset-scoped artifact carries no project_id");

    let _ = tokio::fs::remove_dir_all(&ws).await;
}

// ============================================================ ITEM-68: job_scope
//
// The scope refactor: a job's tenancy scope moved off two mutually-exclusive
// nullable `jobs.project_id`/`jobs.dataset_id` columns onto a single-source-of-truth
// `job_scope(job_id, scope_kind, scope_id)` table. TEST-317..320 cover the migration
// backfill + the create/list/ingest rewiring.

/// Create a project owned by `token`'s user → its id (mirrors the workstore/dataset
/// helpers). Needed so a project-scoped job's produced artifacts have a real FK target.
async fn create_project(server: &TestServer, token: &str, name: &str) -> Uuid {
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(token)
        .json(&json!({ "name": name, "description": "" }))
        .send()
        .await
        .expect("create project");
    assert_eq!(resp.status().as_u16(), 201, "create project {name}");
    let body: Value = resp.json().await.expect("project json");
    Uuid::parse_str(body["id"].as_str().expect("project id")).unwrap()
}

/// `POST /jobs` for a stub job with an optional scope object merged in
/// (`{project_id}` / `{dataset_id}` / `{}`). Returns `(status_code, body)`.
async fn post_scoped_stub(server: &TestServer, token: &str, name: &str, scope: Value) -> (u16, Value) {
    let mut body = json!({ "job_type": "stub", "name": name, "params": { "steps": 1 } });
    if let Value::Object(m) = scope {
        for (k, v) in m {
            body[k] = v;
        }
    }
    let resp = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .expect("create scoped job");
    let code = resp.status().as_u16();
    (code, resp.json().await.unwrap_or(Value::Null))
}

// TEST-317 [ITEM-68]: the job_scope migration backfills ONE row per pre-existing
// SCOPED job from the old `jobs.project_id`/`dataset_id` columns, preserving the
// project-XOR-dataset invariant, and is IDEMPOTENT (a re-apply is a no-op). The
// migration already DROPped those columns, so this faithfully re-exercises the
// backfill SQL: re-add the columns, seed a project-scoped + a dataset-scoped + a
// scope-less pre-migration job, run the EXACT backfill statement, assert the rows,
// then run it AGAIN to prove `ON CONFLICT DO NOTHING` idempotency.
#[tokio::test]
async fn test317_migration_backfill_idempotent_and_preserves_scope() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let (_owner_token, owner_id) = register_user(&server, "backfill_owner").await;
    let owner = Uuid::parse_str(&owner_id).unwrap();

    // Re-create the PRE-migration scope columns (the two the migration dropped) so
    // the backfill statement — which reads them — can run against seeded rows.
    // (Two statements: SQLite permits one ADD COLUMN per ALTER TABLE.)
    sqlx::query("ALTER TABLE jobs ADD COLUMN project_id uuid")
        .execute(&pool)
        .await
        .expect("re-add project_id");
    sqlx::query("ALTER TABLE jobs ADD COLUMN dataset_id uuid")
        .execute(&pool)
        .await
        .expect("re-add dataset_id");

    let project = Uuid::new_v4();
    let dataset = Uuid::new_v4();
    let job_proj = Uuid::new_v4();
    let job_ds = Uuid::new_v4();
    let job_none = Uuid::new_v4();
    for (id, p, d) in [
        (job_proj, Some(project), None::<Uuid>),
        (job_ds, None, Some(dataset)),
        (job_none, None, None),
    ] {
        sqlx::query(
            "INSERT INTO jobs (id, owner_id, job_type, name, status, project_id, dataset_id)
             VALUES ($1, $2, 'analysis', 'seed', 'completed', $3, $4)",
        )
        .bind(id)
        .bind(owner)
        .bind(p)
        .bind(d)
        .execute(&pool)
        .await
        .expect("seed pre-migration job");
    }

    // The EXACT backfill statement from 202607260001_jobs_scope_table.sql.
    const BACKFILL: &str = "INSERT INTO job_scope (job_id, scope_kind, scope_id)
        SELECT id,
               CASE WHEN project_id IS NOT NULL THEN 'project' ELSE 'dataset' END,
               COALESCE(project_id, dataset_id)
        FROM jobs
        WHERE project_id IS NOT NULL OR dataset_id IS NOT NULL
        ON CONFLICT (job_id) DO NOTHING";
    sqlx::query(BACKFILL).execute(&pool).await.expect("backfill");

    // One row per SCOPED job, with the right kind + id (project-XOR-dataset preserved).
    let proj_row: (String, Uuid) =
        sqlx::query_as("SELECT scope_kind, scope_id FROM job_scope WHERE job_id = $1")
            .bind(job_proj)
            .fetch_one(&pool)
            .await
            .expect("project-scoped backfill row");
    assert_eq!(proj_row, ("project".to_string(), project), "project scope preserved");
    let ds_row: (String, Uuid) =
        sqlx::query_as("SELECT scope_kind, scope_id FROM job_scope WHERE job_id = $1")
            .bind(job_ds)
            .fetch_one(&pool)
            .await
            .expect("dataset-scoped backfill row");
    assert_eq!(ds_row, ("dataset".to_string(), dataset), "dataset scope preserved");
    // A scope-less job gets NO row.
    let none_ct: i64 = sqlx::query_scalar("SELECT count(*) FROM job_scope WHERE job_id = $1")
        .bind(job_none)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(none_ct, 0, "a scope-less pre-migration job is not backfilled");

    // IDEMPOTENT: re-running the backfill neither errors nor duplicates (the PK +
    // ON CONFLICT DO NOTHING). Each scoped job still has exactly one row.
    sqlx::query(BACKFILL).execute(&pool).await.expect("re-run backfill is idempotent");
    for id in [job_proj, job_ds] {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM job_scope WHERE job_id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 1, "re-apply did not duplicate the backfilled row for {id}");
    }

    // Restore the post-migration (scope-agnostic) jobs schema for this DB.
    sqlx::query("ALTER TABLE jobs DROP COLUMN project_id, DROP COLUMN dataset_id")
        .execute(&pool)
        .await
        .ok();
}

// TEST-318 [ITEM-68]: a PROJECT-run and a DATASET-run job each create the correct
// `job_scope` row, AND their produced artifacts are cataloged with the matching
// scope (project → `artifacts.project_id`; dataset → `artifacts.dataset_id`) when
// the scope is resolved from `job_scope` (the production resolver
// `JobRepository::job_scope`) and threaded into the ingest — proving scope flows
// job_scope → resolver → artifact for BOTH scopes.
#[tokio::test]
async fn test318_project_and_dataset_jobs_scope_rows_and_artifact_tagging() {
    use txresbench::modules::jobs::models::CreateJobRequest;
    use txresbench::modules::jobs::repository::JobRepository;
    use txresbench::modules::workstore::ingest::ingest_run_outputs;
    use txresbench::modules::workstore::object_store::LocalFsStore;

    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, owner_id) = register_user(&server, "scope_user").await;
    let owner = Uuid::parse_str(&owner_id).unwrap();
    let pool = pool_for(&server).await;

    // Real project + dataset (the FK targets for artifacts.project_id/dataset_id).
    let project = create_project(&server, &token, "scope proj").await;
    let (dataset, _file) =
        upload_dataset(&server, &token, "scope ds", "s.csv", b"a\n1\n").await;

    // Two jobs via the REAL create path — each persists ONE job_scope row.
    let repo = JobRepository::new(pool.clone());
    let mk = |project_id, dataset_id| CreateJobRequest {
        job_type: "analysis".into(),
        name: Some("scope run".into()),
        params: Some(json!({ "language": "python", "script": "print(1)" })),
        priority_class: None,
        resource_class: None,
        project_id,
        dataset_id,
    };
    let proj_job = repo.create(owner, &mk(Some(project), None)).await.expect("project-scoped job");
    let ds_job = repo.create(owner, &mk(None, Some(dataset))).await.expect("dataset-scoped job");

    // Each created the CORRECT job_scope row.
    let pr: (String, Uuid) =
        sqlx::query_as("SELECT scope_kind, scope_id FROM job_scope WHERE job_id = $1")
            .bind(proj_job.id).fetch_one(&pool).await.expect("project job_scope row");
    assert_eq!(pr, ("project".to_string(), project), "project-run job → project scope row");
    let dr: (String, Uuid) =
        sqlx::query_as("SELECT scope_kind, scope_id FROM job_scope WHERE job_id = $1")
            .bind(ds_job.id).fetch_one(&pool).await.expect("dataset job_scope row");
    assert_eq!(dr, ("dataset".to_string(), dataset), "dataset-run job → dataset scope row");

    // Resolve each job's scope FROM job_scope (production resolver) and ingest a
    // staged run manifest under that scope — then assert the artifact's scope columns.
    let store_root = std::env::temp_dir().join(format!("txr-test318-store-{}", Uuid::new_v4()));
    let store = LocalFsStore::new(store_root.clone());
    for (job, exp_project, exp_dataset) in
        [(&proj_job, Some(project), None), (&ds_job, None, Some(dataset))]
    {
        let scope = JobRepository::job_scope(&pool, job.id)
            .await
            .expect("scope lookup")
            .expect("the job has a job_scope row");
        let (p, d) = scope.split();

        let ws = std::env::temp_dir().join(format!("txr-test318-ws-{}", Uuid::new_v4()));
        let outputs = ws.join("outputs");
        tokio::fs::create_dir_all(&outputs).await.unwrap();
        let manifest = json!({ "outputs": [
            { "id": "result", "datatype": "report/html", "path": "r.html", "layout": "opaque", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" }
        ]});
        tokio::fs::write(outputs.join("manifest.json"), serde_json::to_vec(&manifest).unwrap())
            .await.unwrap();
        tokio::fs::write(outputs.join("r.html"), b"<html>ok</html>").await.unwrap();

        ingest_run_outputs(&pool, &store, p, d, job.id, Some(owner), &ws)
            .await
            .expect("ingest run outputs under the resolved scope");

        let (aproj, adset): (Option<Uuid>, Option<Uuid>) =
            sqlx::query_as("SELECT project_id, dataset_id FROM artifacts WHERE run_id = $1")
                .bind(job.id).fetch_one(&pool).await.expect("the run's cataloged artifact");
        assert_eq!(aproj, exp_project, "artifact project scope matches job_scope");
        assert_eq!(adset, exp_dataset, "artifact dataset scope matches job_scope");

        let _ = tokio::fs::remove_dir_all(&ws).await;
    }
    let _ = std::fs::remove_dir_all(&store_root);
}

// TEST-319 [ITEM-68]: `GET /api/jobs?project_id=X` returns ONLY jobs scoped to
// project X (via the `job_scope` JOIN), excluding other-project and dataset-scoped
// and scope-less jobs.
#[tokio::test]
async fn test319_list_filters_by_project_scope_via_join() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, _uid) = register_user(&server, "list_scope_user").await;

    let project_x = create_project(&server, &token, "proj X").await;
    let project_y = create_project(&server, &token, "proj Y").await;
    let (dataset, _f) = upload_dataset(&server, &token, "list ds", "d.csv", b"a\n1\n").await;

    let (c1, b1) = post_scoped_stub(&server, &token, "x1", json!({ "project_id": project_x })).await;
    assert_eq!(c1, 201, "project-X job created: {b1}");
    let job_x = b1["id"].as_str().unwrap().to_string();
    let (c2, _b2) = post_scoped_stub(&server, &token, "y1", json!({ "project_id": project_y })).await;
    assert_eq!(c2, 201);
    let (c3, _b3) = post_scoped_stub(&server, &token, "d1", json!({ "dataset_id": dataset })).await;
    assert_eq!(c3, 201);
    let (c4, _b4) = post_scoped_stub(&server, &token, "u1", json!({})).await;
    assert_eq!(c4, 201, "scope-less job created");

    let list: Value = server
        .client
        .get(server.api_url(&format!("/jobs?project_id={project_x}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list ?project_id")
        .json()
        .await
        .expect("list json");
    let ids: Vec<&str> = list["jobs"].as_array().expect("jobs array")
        .iter().map(|j| j["job"]["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![job_x.as_str()], "only project X's job is returned via the JOIN");
    assert_eq!(list["total"], json!(1), "total counts only project X's jobs");
}

// TEST-320 [ITEM-68]: creating a job naming BOTH a project and a dataset scope is
// still rejected with `AMBIGUOUS_JOB_SCOPE` after the refactor (the project-XOR-
// dataset invariant survives the move to `job_scope`).
#[tokio::test]
async fn test320_ambiguous_double_scope_still_rejected() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (token, _uid) = register_user(&server, "ambiguous_user").await;

    let (code, body) = post_scoped_stub(
        &server,
        &token,
        "ambiguous",
        json!({ "project_id": Uuid::new_v4(), "dataset_id": Uuid::new_v4() }),
    )
    .await;
    assert_eq!(code, 400, "a double-scoped job is rejected (body: {body})");
    assert_eq!(body["error_code"], json!("AMBIGUOUS_JOB_SCOPE"), "with the ambiguity error code");

    // No job_scope row was created for a rejected double-scope (nothing to scope).
    // (The reject happens before any DB write — a belt-and-braces sanity check that
    // the ambiguous request left no artifact.)
    let pool = pool_for(&server).await;
    let orphans: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM job_scope js JOIN jobs j ON j.id = js.job_id WHERE j.name = 'ambiguous'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(orphans, 0, "a rejected ambiguous job created no jobs/job_scope rows");
}

// TEST-321 [ITEM-68 / dataset-delete regression — restores migration 202607250006's
// guarantee]: deleting the DATASET of an in-flight dataset-scoped job must NOT break
// the job. Under ITEM-68 the FK-LESS `job_scope` row SURVIVES the dataset delete, so
// at finalize the ingest sink would resolve `JobScope::Dataset(D)` and insert
// `artifacts.dataset_id = D` against a now-deleted FK target → FK violation → the job
// FAILS (a previously-succeeding run regresses). The fix makes `JobRepository::job_scope`
// EXISTENCE-AWARE: it resolves to `None` (SCOPE-LESS) when the target dataset is gone,
// so the sink SKIPS cataloging and the finalize returns Ok (the job completes with its
// outputs uncataloged) — the exact graceful behavior the old `ON DELETE SET NULL` gave.
#[tokio::test]
async fn test321_deleted_dataset_of_in_flight_job_finalizes_scope_less_no_fk_error() {
    use txresbench::modules::jobs::models::CreateJobRequest;
    use txresbench::modules::jobs::repository::{JobRepository, JobScope};
    use txresbench::modules::jobs::seams::{ArtifactIngestSink, WorkstoreIngestSink};

    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (owner_token, owner_id) = register_user(&server, "delds_owner").await;
    let owner_id = Uuid::parse_str(&owner_id).unwrap();
    let pool = pool_for(&server).await;

    // A dataset owned by the job owner + a dataset-scoped analysis job created via the
    // REAL path (persists a `job_scope(scope_kind='dataset')` row).
    let (dataset_id, _file) =
        upload_dataset(&server, &owner_token, "doomed ds", "s.csv", b"a\n1\n").await;
    let job = JobRepository::new(pool.clone())
        .create(
            owner_id,
            &CreateJobRequest {
                job_type: "analysis".into(),
                name: Some("in-flight run".into()),
                params: Some(json!({ "language": "python", "script": "print(1)" })),
                priority_class: None,
                resource_class: None,
                project_id: None,
                dataset_id: Some(dataset_id),
            },
        )
        .await
        .expect("create dataset-scoped job");

    // Baseline: while the dataset EXISTS the scope resolves to the dataset.
    let before = JobRepository::job_scope(&pool, job.id).await.expect("scope lookup");
    assert!(
        matches!(before, Some(JobScope::Dataset(d)) if d == dataset_id),
        "scope resolves to the dataset while it exists (got {before:?})"
    );

    // Delete the dataset out from under the in-flight job. Its FK-less `job_scope` row
    // survives (only a JOB delete cascades it). Raw SQL delete = "the dataset row is
    // gone" (every datasets(id) FK cascades), independent of any API delete guard.
    sqlx::query("DELETE FROM datasets WHERE id = $1")
        .bind(dataset_id)
        .execute(&pool)
        .await
        .expect("delete the dataset");

    // The existence-aware resolver now yields None (scope-less) — mirrors SET NULL.
    let after = JobRepository::job_scope(&pool, job.id)
        .await
        .expect("scope lookup after delete");
    assert!(after.is_none(), "a deleted-target scope resolves to None (scope-less)");
    // The dangling `job_scope` row is still present (harmless — never re-resolved;
    // reclaimed by CASCADE when the job is deleted).
    let dangling: i64 = sqlx::query_scalar("SELECT count(*) FROM job_scope WHERE job_id = $1")
        .bind(job.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(dangling, 1, "the FK-less job_scope row survives the dataset delete (harmless)");

    // The object store must resolve, so that a REGRESSION (scope wrongly resolving
    // to the deleted dataset) would reach the artifact insert + hit the FK — making
    // this a true regression guard, not a test that passes because the store was
    // missing. Harness-owned for the reason above.
    crate::common::object_store::shared_object_store_root();

    // Stage a genuinely-finished run's /outputs/manifest.json + file.
    let ws = std::env::temp_dir().join(format!("txr-delds-ws-{}", Uuid::new_v4()));
    let outputs = ws.join("outputs");
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    let manifest = json!({ "outputs": [
        { "id": "result", "datatype": "report/html", "path": "r.html", "layout": "opaque", "structure": {"encoding":"opaque","media_type":"application/octet-stream"}, "meta": {}, "role": "artifact" }
    ]});
    tokio::fs::write(outputs.join("manifest.json"), serde_json::to_vec(&manifest).unwrap())
        .await
        .unwrap();
    tokio::fs::write(outputs.join("r.html"), b"<html>ok</html>").await.unwrap();

    // The finalize/ingest path: the sink resolves scope-less and returns Ok (the job
    // would finalize COMPLETED), never hitting the deleted `artifacts.dataset_id` FK.
    WorkstoreIngestSink::new(pool.clone())
        .ingest_outputs(&job, &[], &ws)
        .await
        .expect("ingest of a deleted-dataset job completes scope-less (no FK error)");

    // Scope-less finalize catalogs NOTHING (outputs uncataloged, as SET NULL did).
    let artifact_ct: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(job.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(artifact_ct, 0, "a scope-less finalize catalogs no artifacts (outputs uncataloged)");

    let _ = tokio::fs::remove_dir_all(&ws).await;
}

// --------------------------------- job-hang fix: pre-spawn staging deadline ---

/// JOB-HANG FIX. `runner.spawn()` was NOT timeboxed: the job's wall-clock deadline
/// (`SpawnedJob.timeout_secs`, enforced by `run_and_sample`) only starts ticking
/// once a live CHILD PROCESS exists, so anything that stalled BEFORE the spawn left
/// the job pinned at `running` forever — no terminal state, no error, and the
/// concurrency slot held for good. The concrete production path was
/// `stage_and_launch` → `OciEnvImageProvider::provide` → synchronous `oras`/`cosign`
/// subprocesses with no timeout: a hung registry, DNS blackhole, stalled TLS
/// handshake, or partial pull on the FIRST-RUN (uncached env image) path.
///
/// This drives the REAL executor (`scheduler::execute_job`) against a REAL job row
/// in a REAL database, with runners that stall in staging exactly as the OCI
/// provider did. Two stall SHAPES, because the fix has two halves:
///
///   * `Pending` — an async stall (an await that never resolves).
///   * `Blocking` — a `spawn_blocking` thread that never finishes, which is the
///     literal shape `provide()` now has. Note the OLD code called `provide()`
///     INLINE, blocking the tokio worker inside a single `poll`; a timeout wrapper
///     alone could not have rescued that, because the task never yielded to let the
///     timer's branch run. Moving the blocking work onto `spawn_blocking` is what
///     makes a deadline able to fire at all — this case asserts that it does.
///
/// The assertion is the property that was missing: the job reaches a TERMINAL state
/// with a useful diagnostic, well inside the configured ceiling.
///
/// Deterministic (the runners stall outright; the test never sleeps a fixed wait)
/// and revert-red: remove the `tokio::time::timeout` in `execute_job` and the call
/// never returns, so the outer guard below fires with the REGRESSION message.
#[tokio::test]
async fn stalled_staging_phase_reaches_terminal_failed() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use async_trait::async_trait;
    use txresbench::modules::jobs::models::Job;
    use txresbench::modules::jobs::runner::{JobRunner, SpawnedJob};
    use txresbench::modules::jobs::scheduler::{execute_job, staging_ceiling};
    use txresbench::modules::sandbox::settings::SandboxResourceLimits;

    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect test db");
    let owner: Uuid = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("an admin user exists");

    // Shrink the OPERATOR-configured staging budget to its floor so the ceiling is
    // seconds rather than the 15-minute production default. Written through the
    // real column (the DB CHECK validates it) AND pushed into the in-process cache,
    // because that cache is process-wide and a sibling test may already have loaded
    // the default.
    sqlx::query("UPDATE sandbox_settings SET staging_timeout_secs = 5 WHERE id = TRUE")
        .execute(&pool)
        .await
        .expect("staging_timeout_secs=5 is within the DB CHECK range");
    let limits = SandboxResourceLimits { staging_timeout_secs: 5, ..SandboxResourceLimits::defaults() };
    let budget = limits.staging_budget();
    let ceiling = staging_ceiling(budget);
    txresbench::modules::sandbox::settings_cache::invalidate(limits);

    /// A runner whose staging phase never completes — the shape of `provide()`
    /// waiting on a registry that never answers.
    ///
    /// The blocking variant parks on a RELEASABLE loop rather than one long
    /// `thread::sleep`: dropping a `spawn_blocking` JoinHandle only detaches the
    /// task, and tokio's runtime shutdown then WAITS for it, so an unreleasable
    /// blocking stall would wedge the test harness at teardown even though the job
    /// itself terminated correctly. In production the equivalent release is
    /// `env_image::run`'s own subprocess timeout, which is what bounds the real
    /// blocking work.
    struct StallingRunner {
        blocking: bool,
        release: Arc<AtomicBool>,
    }
    #[async_trait]
    impl JobRunner for StallingRunner {
        async fn spawn(&self, _job: &Job) -> Result<SpawnedJob, String> {
            if self.blocking {
                // The literal shape of the fixed `provide()` call: real blocking
                // work, parked on the blocking pool so the caller stays pollable.
                let release = self.release.clone();
                tokio::task::spawn_blocking(move || {
                    while !release.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                })
                .await
                .ok();
            } else {
                std::future::pending::<()>().await;
            }
            unreachable!("the staging deadline must fire before this runner ever returns")
        }
    }
    let release = Arc::new(AtomicBool::new(false));

    for (label, blocking) in [("async-pending", false), ("blocking-thread", true)] {
        // A real `running` job row — exactly what the scheduler hands the executor
        // after `claim_next_fair`.
        let job_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO jobs (id, owner_id, job_type, name, status, started_at, params) \
             VALUES ($1, $2, 'analysis', $3, 'running', strftime('%Y-%m-%dT%H:%M:%fZ','now'), '{}')",
        )
        .bind(job_id)
        .bind(owner)
        .bind(format!("stalled-staging-{label}"))
        .execute(&pool)
        .await
        .expect("insert the claimed job");
        let job: Job = sqlx::query_as("SELECT * FROM jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(&pool)
            .await
            .expect("read back the claimed job");

        let (_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let started = Instant::now();
        // Guard the whole executor call so a REGRESSION fails loudly instead of
        // hanging the suite forever — which is precisely the production symptom.
        tokio::time::timeout(
            ceiling * 4,
            execute_job(
                pool.clone(),
                Arc::new(StallingRunner { blocking, release: release.clone() }),
                job,
                cancel_rx,
            ),
        )
        .await
        .unwrap_or_else(|_| {
            panic!("REGRESSION [{label}]: the executor never returned — a stalled staging phase is unbounded again")
        });
        let elapsed = started.elapsed();

        // 1. Terminal, not `running`.
        let (status, error): (String, Option<String>) =
            sqlx::query_as("SELECT status, error FROM jobs WHERE id = $1")
                .bind(job_id)
                .fetch_one(&pool)
                .await
                .expect("read the job's terminal state");
        assert_eq!(
            status, "failed",
            "[{label}] a stalled staging phase is FAILED, never left `running`"
        );

        // 2. With a diagnostic an operator can act on — it names the stall site and
        //    the budget that was blown, derived from the CONFIGURED value (so the
        //    message tracks the setting instead of a hardcoded number).
        let error = error.unwrap_or_default();
        assert!(
            error.contains(&format!("{}s", ceiling.as_secs()))
                || error.contains(&format!("{}s", budget.as_secs())),
            "[{label}] the error names the configured budget/ceiling it blew: {error:?}"
        );
        assert!(
            error.contains("staging") || error.contains("start a process"),
            "[{label}] the error names the pre-spawn staging phase as the stall site: {error:?}"
        );
        assert!(
            !error.trim().is_empty(),
            "[{label}] a terminal failure carries a reason, not an empty error"
        );

        // 3. Well inside the ceiling — bounded by the configured budget, not luck.
        assert!(
            elapsed < ceiling * 2,
            "[{label}] terminated in {elapsed:?}, inside the {ceiling:?} staging ceiling"
        );
    }

    // Let the detached blocking stall finish so the runtime can shut down (see the
    // note on `StallingRunner`), and restore the process-wide settings cache for
    // sibling tests in this binary.
    release.store(true, Ordering::SeqCst);
    txresbench::modules::sandbox::settings_cache::invalidate(SandboxResourceLimits::defaults());
}
