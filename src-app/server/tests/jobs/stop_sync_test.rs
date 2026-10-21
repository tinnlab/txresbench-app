//! Cancelling a QUEUED job tells the job's OWNER.
//!
//! `stop_job` was the one status writer in the module that published nothing —
//! not even a dropped seam call, so there was no emit point to find by grepping.
//! `mark_stopped` already published the DATASET consequence
//! (`publish_dataset_after_terminal`); the JOB list, which is what the user is
//! actually looking at when they cancel, was told by nobody. The running path is
//! covered by the executor's `finalize`, so this is specifically the queued branch.
//!
//! The frame must be addressed to the JOB's owner rather than the acting user:
//! `authorize_job` admits an ADMIN acting on another user's job, so the two differ.
//! An admin-stops-own-job test cannot see that; this one has the admin stop a
//! job belonging to somebody else.

use std::time::Duration;

use serde_json::json;

use super::{create_job, poll_until, register_user, setup_admin};
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

#[tokio::test]
async fn cancelling_anothers_queued_job_reaches_that_jobs_owner() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (owner, _owner_id) = register_user(&server, "jobowner").await;

    // Cap=1 so the second job is GUARANTEED to sit queued behind the first — the
    // `mark_stopped` branch, deterministically, with no reliance on timing.
    let put = server
        .client
        .put(server.api_url("/job-settings"))
        .bearer_auth(&admin)
        .json(&json!({ "max_concurrent_jobs": 1 }))
        .send()
        .await
        .expect("put settings");
    assert_eq!(put.status().as_u16(), 200, "admin set concurrency=1");

    // Both jobs belong to the NON-admin owner.
    let running_id = create_job(&server, &owner, "holds-the-slot", 30).await;
    let queued_id = create_job(&server, &owner, "waits", 30).await;
    poll_until(
        &server,
        &owner,
        &running_id,
        &["running"],
        Duration::from_secs(20),
    )
    .await;

    // Open the OWNER's stream only after the first job is already running, so the
    // frames under test are the ones the cancel produces.
    let mut owner_probe = SyncProbe::open(&server, &owner).await;

    // The ADMIN cancels the owner's queued job.
    let stop = server
        .client
        .post(server.api_url(&format!("/jobs/{queued_id}/stop")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("stop queued");
    assert_eq!(stop.status().as_u16(), 200, "admin may cancel another's job");

    // THE ASSERTION: the job's owner is told, and the frame names the cancelled job.
    // Narrowed by ID: the first job is still running in the background and emits its
    // own `job`/`update` frames on this same stream.
    let f = owner_probe
        .expect_event_for("job", "update", &queued_id, Duration::from_secs(10))
        .await;
    assert_eq!(f.entity, "job");
    assert_eq!(f.action, "update");

    // And the row really did change — the frame is not announcing a no-op.
    let d = poll_until(
        &server,
        &owner,
        &queued_id,
        &["stopped"],
        Duration::from_secs(10),
    )
    .await;
    assert!(
        d["job"]["started_at"].is_null(),
        "a cancelled queued job never started"
    );
}
