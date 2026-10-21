//! TEST-63 [ITEM-25, ITEM-19] — job SSE. `GET /jobs/{id}/stream` delivers
//! replay-then-live frames (`Status` + `Log` + `Metric`) for a running job, and
//! `GET /jobs/{id}` (the poll fallback) returns the same terminal state with the
//! replayed logs. (The `$CYTO_PROGRESS_FIFO` phase/pct `Progress` frame rides the
//! real sandbox path — exercised by the rootfs-gated capsule tests.)

use std::time::Duration;

use super::hardening_common::*;
use super::{read_until, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn stream_replays_then_lives_and_poll_fallback_agrees() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let job = submit_stub(
        &server,
        &admin,
        "streamed",
        serde_json::json!({ "steps": 4 }),
        None,
    )
    .await;

    // Open the SSE stream (subscribe-before-snapshot → no gap): expect a Status
    // frame then live Log frames.
    let mut stream = server
        .client
        .get(server.api_url(&format!("/jobs/{job}/stream")))
        .bearer_auth(&admin)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .expect("open job stream");
    assert_eq!(stream.status().as_u16(), 200, "stream is 200");

    assert!(
        read_until(&mut stream, "event: status", Duration::from_secs(15)).await,
        "the stream emits a Status frame (current status)"
    );
    assert!(
        read_until(&mut stream, "event: log", Duration::from_secs(20)).await,
        "the stream delivers live Log frames as the job runs"
    );
    drop(stream);

    // Poll fallback: the terminal state + replayed logs match.
    assert_eq!(
        wait_terminal(&pool, job, Duration::from_secs(60)).await,
        "completed"
    );
    let detail = get_job(&server, &admin, job).await;
    assert_eq!(
        detail["job"]["status"], "completed",
        "poll returns the same terminal state"
    );
    assert!(
        detail["job"]["finished_at"].is_string(),
        "terminal finished_at present"
    );
    assert!(
        detail["logs"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        "the poll fallback replays the job's logs"
    );
}
