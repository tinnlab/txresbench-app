//! TEST-2 [acceptance] [invariant: INV-4] — the G2 serve/worker role split (PROV-T3-2).
//!
//! An enqueue-only `serve` process (`CYTO_SCHEDULER_ENABLED=0`) accepts `POST /jobs`
//! (status `queued`) but NEVER claims/executes it — the job stays queued. A `serve` process
//! with the flag ON (single-box default) DOES claim + run it (the positive control that
//! proves the flag is load-bearing, not vacuous). Workers being the ONLY claimer is the
//! precondition T4's cap-in-claim depends on; the real worker-pod-claims-it half runs at L2
//! (TEST-1).

use std::time::Duration;

use crate::common::{TestOptions, TestServer};

use super::{create_job, get_job, setup_admin};

/// A `serve` pod with the scheduler flag OFF enqueues but never claims: a queued job stays
/// queued across the interval the loop would otherwise have claimed it in.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enqueue_only_serve_never_claims() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(false), // the SaaS API-pod posture
        ..Default::default()
    })
    .await;
    let token = setup_admin(&server).await;

    // A short stub job the scheduler WOULD claim + finish in ~1s if it were running.
    let id = create_job(&server, &token, "enqueue-only", 2).await;

    // Give the loop generous time to (not) run — the tick is 500ms; 3s is ~6 ticks.
    tokio::time::sleep(Duration::from_secs(3)).await;

    let (status, body) = get_job(&server, &token, &id).await;
    assert_eq!(status, 200, "job is visible to its owner");
    assert_eq!(
        body["job"]["status"], "queued",
        "an enqueue-only serve pod (CYTO_SCHEDULER_ENABLED=0) NEVER claims — the job stays queued (G2 / PROV-T3-2). Got: {}",
        body["job"]["status"]
    );
}

/// Positive control (negative-of-negative): a `serve` pod with the flag ON DOES claim + run
/// the same shape of job — proving the flag is what gates claiming, not something else.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn flag_on_serve_claims_and_runs() {
    let server = TestServer::spawn_with(TestOptions {
        scheduler_enabled: Some(true), // single-box default (explicit)
        ..Default::default()
    })
    .await;
    let token = setup_admin(&server).await;

    let id = create_job(&server, &token, "flag-on", 2).await;

    // Poll up to ~8s for the job to leave `queued` (claimed → running/completed).
    let mut claimed = false;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let (_, body) = get_job(&server, &token, &id).await;
        if body["job"]["status"] != "queued" {
            claimed = true;
            break;
        }
    }
    assert!(
        claimed,
        "a flag-ON serve pod claims + runs the job (the flag is load-bearing) — it did not leave 'queued'"
    );
}
