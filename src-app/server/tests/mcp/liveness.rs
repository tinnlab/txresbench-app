//! TEST-14 — per-request liveness over the REAL agent channel (not the pure
//! `LivenessState` unit test — this exercises the real SSE-down + POST-up
//! wiring end to end): a simulated engine that periodically answers
//! `pong{processing}` keeps a slow invoke alive past a single liveness tick;
//! one that goes silent past the ping budget fails `FRONTEND_UNRESPONSIVE`.
//!
//! Re-audit gap: `reload_rebind_mid_dispatch_resolves_as_frontend_reloaded`
//! below exercises the reload/rebind race the initial-send + liveness-ping
//! re-resolution fix in `agent_channel.rs` (`current_sender`/
//! `send_to_current`) is meant to handle — previously only covered by the
//! pure `pong_unknown_fails_frontend_reloaded` unit test, never over a real
//! rebound SSE connection.

use std::time::Duration;

use serde_json::json;
use uuid::Uuid;

use super::{create_user, login, next_sse_event, open_agent_stream, post_agent_pong, post_agent_result, setup_admin, tools_call};
use crate::common::TestServer;

#[tokio::test]
async fn pong_processing_keeps_a_slow_invoke_alive() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "slowdriver", "slowdriver@x.test").await;
    let driver = login(&server, "slowdriver").await;

    let session_id = Uuid::new_v4();
    let (mut stream, mut buf) = open_agent_stream(&server, &driver, session_id).await;

    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &driver,
            "invoke_capability",
            json!({ "operation_id": "app.navigate", "body": { "path": "/slow" } }),
        ),
        async {
            let invoke_frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(5))
                .await
                .expect("agent_invoke frame");
            let request_id = invoke_frame["request_id"].clone();

            // Answer at least 2 liveness pings with pong{processing} — this
            // spans MORE than one liveness tick, so surviving proves the
            // pong keepalive is actually resetting the server's quiet timer,
            // not just a lucky single fast round trip.
            for i in 0..2 {
                let ping = next_sse_event(&mut stream, &mut buf, Duration::from_secs(8))
                    .await
                    .unwrap_or_else(|| panic!("ping frame #{i} arrives over the real channel"));
                assert_eq!(ping["type"], "ping");
                assert_eq!(ping["request_id"], request_id);
                let acked = post_agent_pong(&server, &driver, request_id.clone(), "processing").await;
                assert!(acked, "pong #{i} correlates to the pending dispatch");
            }

            post_agent_result(&server, &driver, request_id, true, json!({ "done": true }), None).await;
        }
    );

    assert!(
        invoke_result.get("isError").is_none(),
        "kept alive by pong{{processing}} across multiple ticks: {invoke_result}"
    );
    assert_eq!(invoke_result["structuredContent"]["ok"], true);
    assert_eq!(invoke_result["structuredContent"]["result"]["done"], true);
}

#[tokio::test]
async fn silence_past_the_ping_budget_fails_frontend_unresponsive() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "silentdriver", "silentdriver@x.test").await;
    let driver = login(&server, "silentdriver").await;

    let session_id = Uuid::new_v4();
    let (mut stream, mut buf) = open_agent_stream(&server, &driver, session_id).await;

    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &driver,
            "invoke_capability",
            json!({ "operation_id": "app.navigate", "body": { "path": "/silence" } }),
        ),
        async {
            // Never answer a ping (nor send a result) — drain whatever
            // arrives, up to a budget well past the server's internal
            // quiet-then-ping-then-missed-pings fail point, without acting
            // on any of it. This is NOT a wall-clock hang on our side: the
            // dispatch itself resolves (as a failure) well before this
            // drain loop's own budget expires.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            loop {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                if next_sse_event(&mut stream, &mut buf, remaining).await.is_none() {
                    break; // no further frames before the deadline — done draining.
                }
            }
        }
    );

    assert_eq!(invoke_result["isError"], true, "{invoke_result}");
    assert_eq!(
        invoke_result["structuredContent"]["error_code"],
        "FRONTEND_UNRESPONSIVE"
    );
}

// ------------------------------- reload/rebind (re-audit gap) -------------------------------

#[tokio::test]
async fn reload_rebind_mid_dispatch_resolves_as_frontend_reloaded() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "reloader", "reloader@x.test").await;
    let driver = login(&server, "reloader").await;

    let session_id = Uuid::new_v4();
    let (mut stream1, mut buf1) = open_agent_stream(&server, &driver, session_id).await;

    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &driver,
            "invoke_capability",
            json!({ "operation_id": "app.navigate", "body": { "path": "/reload-me" } }),
        ),
        async {
            // The initial `agent_invoke` send lands on the FIRST connection —
            // it's still the one bound at dispatch time.
            let invoke_frame = next_sse_event(&mut stream1, &mut buf1, Duration::from_secs(10))
                .await
                .expect("agent_invoke frame on the original connection");
            assert_eq!(invoke_frame["type"], "agent_invoke");
            let request_id = invoke_frame["request_id"].clone();

            // Simulate a browser reload: a SECOND `agent_stream` connection
            // for the SAME session_id (a real reload keeps the persisted
            // session_id) rebinds `user -> this new connection` — a
            // reconnect always rebinds regardless of session_id equality
            // (`bind_session` keys the registry by user_id; `conn_id`, not
            // the client-supplied `session_id`, disambiguates connections).
            let (mut stream2, mut buf2) = open_agent_stream(&server, &driver, session_id).await;

            // The next liveness ping re-resolves the CURRENTLY bound sender
            // (`current_sender`/`send_to_current` in `agent_channel.rs`) and
            // lands on the NEW connection — never on the stale first one,
            // which never sees it.
            let ping = next_sse_event(&mut stream2, &mut buf2, Duration::from_secs(10))
                .await
                .expect("ping frame arrives on the rebound (reloaded) connection");
            assert_eq!(ping["type"], "ping");
            assert_eq!(ping["request_id"], request_id);

            // The reloaded tab has no record of this request_id, so it
            // answers pong{unknown} — the FRONTEND_RELOADED signal.
            let acked = post_agent_pong(&server, &driver, request_id, "unknown").await;
            assert!(acked, "pong correlates to the pending dispatch");
        }
    );

    assert_eq!(invoke_result["isError"], true, "{invoke_result}");
    assert_eq!(
        invoke_result["structuredContent"]["error_code"],
        "FRONTEND_RELOADED"
    );
}
