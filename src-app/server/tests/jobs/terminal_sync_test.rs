//! A job reaching its TERMINAL state tells the owner's devices — the emit the
//! frontend's running→completed liveness rests on.
//!
//! The client stopped polling `/api/jobs`: the Jobs drawer, the workbench Jobs pane,
//! and the status-bar running-count/completion-toast all refetch off `sync:job` now
//! (notify-and-refetch, §7). That is only correct if the backend actually emits a
//! `SyncEntity::Job` frame at the running→completed transition — the scheduler's
//! `finalize` (`scheduler.rs`, `publish_job_changed(JobChange::Updated)`). Drop that
//! one call and every one of those surfaces silently goes stale on the most important
//! transition there is: the run the user is waiting on finishes and nothing tells them.
//!
//! `create` and the queued-`stop` `update` are pinned elsewhere (`visibility_test.rs`
//! sync arm, `stop_sync_test.rs`). This pins the FINALIZE `update`, and isolates it:
//! the probe is opened only AFTER the job is already `running`, so the create frame and
//! the claim(queued→running) frame have both already gone by. The one `update` that can
//! still arrive on this stream is finalize's — so an assertion that it arrives cannot be
//! satisfied by any earlier emit, and fails iff the terminal emit is dropped.

use std::time::Duration;

use super::{create_job, poll_until, register_user, setup_admin};
use crate::common::sync_probe::SyncProbe;
use crate::common::TestServer;

#[tokio::test]
async fn a_job_running_to_completion_tells_its_owner() {
    let server = TestServer::spawn().await;
    setup_admin(&server).await;
    let (owner, _owner_id) = register_user(&server, "termowner").await;

    // ~5 one-second steps: long enough to catch it `running` and open the probe before
    // it finishes, short enough that the whole test is a few seconds.
    let job = create_job(&server, &owner, "runs-to-completion", 5).await;
    poll_until(&server, &owner, &job, &["running"], Duration::from_secs(20)).await;

    // Open the OWNER's stream AFTER the job is running: the `create` and claim→`running`
    // frames are already in the past, so the only `job`/`update` that can still land for
    // this id is the one `finalize` emits when it reaches `completed`.
    let mut owner_probe = SyncProbe::open(&server, &owner).await;

    // THE ASSERTION: the terminal transition is announced to the job's owner.
    let f = owner_probe
        .expect_event_for("job", "update", &job, Duration::from_secs(20))
        .await;
    assert_eq!(f.entity, "job");
    assert_eq!(f.action, "update");
    assert_eq!(f.id, job, "the finalize frame names the completed job");

    // …and the frame was not announcing a no-op: the row really did reach a terminal
    // state (the change the owner's devices are being told to refetch).
    let d = poll_until(
        &server,
        &owner,
        &job,
        &["completed"],
        Duration::from_secs(20),
    )
    .await;
    assert_eq!(d["job"]["status"], serde_json::json!("completed"));
}
