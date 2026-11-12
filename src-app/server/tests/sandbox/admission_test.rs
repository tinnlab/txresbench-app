//! Admission control for the two sandbox spawners that had none.
//!
//! # What these tests are for
//!
//! `POST /sandbox/execute` and the conformance gate each spawn a full bwrap child.
//! Neither was bounded by anything: no cap, no queue, no refusal. `max_concurrent_jobs`
//! bounded the scheduler's children and nothing else, so a caller (or a loop, or a test)
//! could spawn concurrent sandboxes until the box fell over, while every admission
//! mechanism in the process reported itself satisfied.
//!
//! # Why every test here saturates FIRST
//!
//! A concurrency bound is proven by the request that arrives while the bound is already
//! consumed. A test that starts one job and asserts it succeeds proves only that the
//! happy path still works — it passes identically against a build with NO admission
//! control at all, which is precisely the build these tests exist to fail. So each test
//! below burns the pool with a holding job, waits for that job to actually reach
//! `running` (the cap counts `running`, never `queued` — a queued holder would prove
//! nothing), and only then makes the call under test.
//!
//! Each refusal test carries a POSITIVE CONTROL: the identical call, once capacity
//! frees, must be admitted. Without it a blanket "always refuse" bug would pass every
//! assertion here.

use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use super::{pool_for, setup_admin};
use crate::common::TestServer;

// ── helpers ─────────────────────────────────────────────────────────────────────

/// Set the box-wide concurrency cap.
async fn set_cap(server: &TestServer, admin: &str, cap: i64) {
    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(admin)
        // `reserved_interactive_slots` must stay < cap (DB CHECK), and at cap=1 the only
        // legal value is 0. Set it explicitly rather than relying on the seeded 1, which
        // would be auto-clamped and make the test's intent depend on that clamp.
        .json(&json!({ "max_concurrent_jobs": cap, "reserved_interactive_slots": 0 }))
        .send()
        .await
        .expect("put job-settings");
    assert_eq!(put.status().as_u16(), 200, "cap set to {cap}");
}

/// Create a long-running stub job and WAIT until it is actually `running`.
///
/// The wait is the load-bearing half: `create` lands a `queued` row, and the admission
/// count is `WHERE status = 'running'`. Asserting a refusal against a merely-queued
/// holder would assert nothing.
async fn burn_a_slot(server: &TestServer, admin: &str, name: &str) -> Uuid {
    let id: Uuid = server
        .client
        .post(server.api_url("/jobs"))
        .bearer_auth(admin)
        .json(&json!({ "job_type": "stub", "name": name, "params": { "steps": 600 } }))
        .send()
        .await
        .expect("create holding job")
        .json::<Value>()
        .await
        .expect("json")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let body: Value = server
            .client
            .get(server.api_url(&format!("/jobs/{id}")))
            .bearer_auth(admin)
            .send()
            .await
            .expect("get holding job")
            .json()
            .await
            .expect("json");
        if body["job"]["status"].as_str() == Some("running") {
            return id;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the holding job never reached `running`, so the pool was never saturated \
             and nothing below would be a real test"
        );
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn stop_job(server: &TestServer, admin: &str, id: Uuid) {
    let resp = server
        .client
        .post(server.api_url(&format!("/jobs/{id}/stop")))
        .bearer_auth(admin)
        .send()
        .await
        .expect("stop job");
    assert_eq!(resp.status().as_u16(), 200, "the holding job is stopped");
}

async fn post_execute(server: &TestServer, token: &str) -> reqwest::Response {
    server
        .client
        .post(server.api_url("/sandbox/execute"))
        .bearer_auth(token)
        .json(&json!({ "command": "echo admission" }))
        .send()
        .await
        .expect("post /sandbox/execute")
}

/// Every `jobs` row of a given type, terminal or not.
async fn jobs_of_type(server: &TestServer, admin: &str, job_type: &str) -> Vec<Value> {
    let body: Value = server
        .client
        .get(server.api_url("/jobs?per_page=100"))
        .bearer_auth(admin)
        .send()
        .await
        .expect("list jobs")
        .json()
        .await
        .expect("json");
    body["jobs"]
        .as_array()
        .expect("jobs array")
        .iter()
        .filter(|it| it["job"]["job_type"].as_str() == Some(job_type))
        .cloned()
        .collect()
}

// ── POST /sandbox/execute ───────────────────────────────────────────────────────

/// **THE REGRESSION: the second caller is refused, and told why.**
///
/// With the only slot already consumed, `/sandbox/execute` must answer 429
/// `SANDBOX_POOL_FULL` — a typed, actionable refusal — rather than spawning a second
/// bwrap child (the old behaviour) or blocking the connection on an invisible queue.
///
/// The 429 is asserted BEFORE any sandbox-availability gate matters: admission runs
/// ahead of the 503 `SANDBOX_UNAVAILABLE` path, so this assertion holds on a host with
/// no bwrap at all. That ordering is deliberate — a full pool must not be reported as a
/// broken sandbox, and a broken sandbox must not consume a slot.
#[tokio::test]
async fn execute_is_refused_when_the_compute_pool_is_full() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    set_cap(&server, &admin, 1).await;

    let holder = burn_a_slot(&server, &admin, "burns-the-only-slot").await;

    let refused = post_execute(&server, &admin).await;
    assert_eq!(
        refused.status().as_u16(),
        429,
        "THE REGRESSION: /sandbox/execute spawned a bwrap child with the compute pool \
         already full — it is admitted under max_concurrent_jobs, not beside it"
    );
    let body: Value = refused.json().await.expect("429 json");
    assert_eq!(
        body["error_code"],
        json!("SANDBOX_POOL_FULL"),
        "the refusal is typed, so a client can distinguish `full, retry` from \
         `sandbox is broken` and retry the right one"
    );

    // The refusal left NO row behind: admission is the INSERT, so a rejected caller
    // cannot leak a `running` row that would hold the slot it was just denied.
    assert!(
        jobs_of_type(&server, &admin, "sandbox").await.is_empty(),
        "a refused execute minted no jobs row"
    );

    // ── POSITIVE CONTROL ──
    // Free the slot; the IDENTICAL request must stop being refused. Without this, a
    // build that refused every execute unconditionally would pass everything above.
    stop_job(&server, &admin, holder).await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let status = loop {
        let again = post_execute(&server, &admin).await;
        let s = again.status().as_u16();
        if s != 429 {
            break s;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the slot never freed — execute stayed refused after the holder stopped, so \
             the cap is not the reason it was refused"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    };

    // Admission SUCCEEDED. What happens next depends on whether this host has a usable
    // sandbox, and that is not what this test is about: 200 (it ran) and 503
    // (SANDBOX_UNAVAILABLE — no bwrap/rootfs here) are both proof that the caller got
    // past the gate. Any other status is a real failure.
    assert!(
        status == 200 || status == 503,
        "once capacity freed the same caller was admitted (got {status})"
    );
    // …and being admitted means a row was minted, which is the durable evidence that
    // the slot was actually claimed rather than the check being skipped.
    let rows = jobs_of_type(&server, &admin, "sandbox").await;
    assert_eq!(
        rows.len(),
        1,
        "the admitted execute minted exactly one `sandbox` jobs row"
    );
}

/// **The slot is RELEASED on every exit path, including the failure one.**
///
/// This is the other half of a cap, and the more dangerous half to get wrong: a
/// `running` row that never closes permanently consumes a slot, so leaking one per call
/// wedges the box for the life of the process — a worse bug than the unbounded spawning
/// it replaced, and one that would look like a working cap in the test above.
///
/// Three sequential calls at cap=1 can only all be admitted if each released its slot.
/// On a host with no sandbox these fail at 503, which is exactly the exit path most
/// likely to skip a cleanup tail — so this host is the harder case, not a weaker one.
#[tokio::test]
async fn a_finished_execute_frees_its_slot_for_the_next_caller() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    set_cap(&server, &admin, 1).await;

    for attempt in 1..=3 {
        let resp = post_execute(&server, &admin).await;
        let status = resp.status().as_u16();
        assert_ne!(
            status, 429,
            "call {attempt} was refused for capacity on an otherwise-idle box — the \
             previous call leaked its concurrency slot instead of closing its jobs row"
        );
        assert!(
            status == 200 || status == 503,
            "call {attempt} got an unexpected {status}"
        );
    }

    // Every minted row reached a terminal status; none is still holding a slot.
    let rows = jobs_of_type(&server, &admin, "sandbox").await;
    assert_eq!(rows.len(), 3, "three calls minted three rows");
    for row in &rows {
        let status = row["job"]["status"].as_str().unwrap_or("");
        assert!(
            matches!(status, "completed" | "failed" | "stopped"),
            "a `sandbox` row is still {status} after its call returned — it holds a \
             concurrency slot until the process restarts"
        );
    }
}

/// A `sandbox` row is NOT an `analysis` row, and that is load-bearing rather than
/// cosmetic: `reconcile_orphaned_running` FINALIZES and INGESTS an orphaned running
/// *analysis* job at boot. A `/sandbox/execute` run that answered to that name would be
/// pushed into the artifact catalog by a restart.
#[tokio::test]
async fn an_executes_row_is_not_an_analysis_row() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let resp = post_execute(&server, &admin).await;
    assert_ne!(resp.status().as_u16(), 429, "an idle box admits the call");

    let rows = jobs_of_type(&server, &admin, "sandbox").await;
    assert_eq!(rows.len(), 1, "the call minted its row");
    assert!(
        jobs_of_type(&server, &admin, "analysis").await.is_empty(),
        "a sandbox execute must never be job_type=analysis — boot reconcile would \
         finalize and INGEST it into the catalog"
    );
}

// ── the conformance gate ────────────────────────────────────────────────────────

/// **The gate obeys the same cap, and says so when it cannot run.**
///
/// The gate is DETACHED (nobody holds a socket), so it waits for a slot rather than
/// refusing instantly — but the wait is bounded, and its expiry is a terminal answer,
/// not a hang. With the pool held full for longer than the whole admission budget, the
/// gate must give up and return an INDETERMINATE error that names the pool.
///
/// Indeterminate is the correct verdict class and the assertion checks for it
/// specifically: "the box was busy" is not a statement about the bytes, so artifact
/// statuses must be left alone rather than flipped to `failed`.
#[tokio::test]
async fn the_conformance_gate_gives_up_when_the_pool_stays_full() {
    use txresbench::modules::jobs::admission::ADMISSION_WAIT;
    use txresbench::modules::jobs::conformance::{run_gate, GateTarget};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = super::admin_user_id(&server, &admin).await;
    set_cap(&server, &admin, 1).await;

    let _holder = burn_a_slot(&server, &admin, "holds-the-slot-past-the-gate-budget").await;

    let targets = vec![GateTarget {
        artifact_id: Uuid::new_v4(),
        project_id: None,
        dataset_id: None,
        structure: json!({}),
        meta: json!({}),
    }];

    // Bounded: the call must RETURN within the budget plus slack. If it does not, the
    // wait is not bounded and the "queue" is a hang.
    let started = tokio::time::Instant::now();
    let result = tokio::time::timeout(
        ADMISSION_WAIT + Duration::from_secs(20),
        run_gate(&pool, owner, &targets),
    )
    .await
    .expect("THE REGRESSION: the gate never returned — a wait with no deadline is a hang");

    let reason = result.expect_err(
        "THE REGRESSION: the gate spawned a bwrap child with the compute pool full — it \
         is admitted under max_concurrent_jobs like every other sandbox child",
    );
    assert!(
        reason.contains("compute pool") && reason.contains("max_concurrent_jobs"),
        "the give-up reason names the pool and the knob, so an operator reading the \
         run's log knows the artifacts are UNCHECKED rather than bad; got: {reason}"
    );
    assert!(
        started.elapsed() >= ADMISSION_WAIT,
        "the gate gave up before its budget expired — it must actually wait for a slot, \
         because the producing run's own row is still `running` when it dispatches"
    );

    // The refusal left no row: a gate that could not start holds nothing.
    assert!(
        jobs_of_type(&server, &admin, "conformance")
            .await
            .is_empty(),
        "a gate that never started minted no jobs row"
    );
}

/// **POSITIVE CONTROL for the gate**: on an idle box the same call is ADMITTED.
///
/// Without this, a build whose gate always returned the pool-full error would pass the
/// test above. Admission is proven by the outcome NOT being the pool-full one (on a host
/// with no sandbox the gate then fails for a different, honest reason) and by the row it
/// minted and closed.
#[tokio::test]
async fn the_conformance_gate_is_admitted_on_an_idle_box() {
    use txresbench::modules::jobs::conformance::{run_gate, GateTarget};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let owner = super::admin_user_id(&server, &admin).await;
    set_cap(&server, &admin, 2).await;

    let targets = vec![GateTarget {
        artifact_id: Uuid::new_v4(),
        project_id: None,
        dataset_id: None,
        structure: json!({}),
        meta: json!({}),
    }];

    let result = run_gate(&pool, owner, &targets).await;
    if let Err(reason) = &result {
        assert!(
            !reason.contains("compute pool"),
            "an idle box refused the gate for capacity: {reason}"
        );
    }

    // Admitted ⇒ a row exists, and it is closed: the gate released its slot on whichever
    // path it took (verdict or indeterminate), which is what keeps a busy box from
    // wedging one leaked slot per produced run.
    let rows = jobs_of_type(&server, &admin, "conformance").await;
    assert_eq!(rows.len(), 1, "the admitted gate minted exactly one row");
    let status = rows[0]["job"]["status"].as_str().unwrap_or("");
    assert!(
        matches!(status, "completed" | "failed" | "stopped"),
        "the gate's row is still {status} — it holds a concurrency slot"
    );
    assert_ne!(
        rows[0]["job"]["job_type"].as_str(),
        Some("analysis"),
        "the gate's row must never be job_type=analysis — boot reconcile would finalize \
         and INGEST a gate run into the catalog"
    );
}
