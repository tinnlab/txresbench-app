//! TEST-8/9/10 — the frontend-action manifest catalog: permission-filtered
//! `list_capabilities`, a real end-to-end relay through the agent channel to
//! a SIMULATED engine, and the two invoke failure paths
//! (`FRONTEND_NOT_CONNECTED`, `NOT_PERMITTED` checked BEFORE relay).
//!
//! Re-audit gap: the `MAX_INFLIGHT_PER_USER` cap added alongside the
//! reload-race fix in `agent_channel.rs` (`try_reserve_inflight`/
//! `release_inflight`) had no integration coverage — see
//! `inflight_cap_rejects_the_17th_then_frees_capacity_on_release` below.

use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use super::{
    create_user, create_user_with_only_mcp_use, login, next_sse_event, open_agent_stream, post_agent_result,
    setup_admin, tools_call,
};
use crate::common::TestServer;

// ------------------------------- TEST-8 -------------------------------

#[tokio::test]
async fn list_capabilities_includes_permission_filtered_frontend_actions() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // A full Users-group member holds BOTH mcp::use and projects::use → sees
    // both manifest frontend actions.
    create_user(&server, &admin, "full", "full@x.test").await;
    let full = login(&server, "full").await;
    let result = tools_call(&server, &full, "list_capabilities", json!({})).await;
    let ops = result["structuredContent"]["operations"].as_array().unwrap();
    let frontend_ids: Vec<&str> = ops
        .iter()
        .filter(|o| o["kind"] == "frontend")
        .map(|o| o["operation_id"].as_str().unwrap())
        .collect();
    assert!(frontend_ids.contains(&"app.navigate"), "{frontend_ids:?}");
    assert!(frontend_ids.contains(&"project.openProject"), "{frontend_ids:?}");

    // A user holding ONLY mcp::use (no projects::use) sees app.navigate
    // (permission=mcp::use) but NOT project.openProject (permission=projects::use)
    // — proving list_capabilities pre-filters frontend actions per caller.
    create_user_with_only_mcp_use(&server, &admin, "mcponly", "mcponly@x.test").await;
    let mcp_only = login(&server, "mcponly").await;
    let result2 = tools_call(&server, &mcp_only, "list_capabilities", json!({})).await;
    let ops2 = result2["structuredContent"]["operations"].as_array().unwrap();
    let frontend_ids2: Vec<&str> = ops2
        .iter()
        .filter(|o| o["kind"] == "frontend")
        .map(|o| o["operation_id"].as_str().unwrap())
        .collect();
    assert!(
        frontend_ids2.contains(&"app.navigate"),
        "mcp::use holder sees app.navigate: {frontend_ids2:?}"
    );
    assert!(
        !frontend_ids2.contains(&"project.openProject"),
        "lacking projects::use excludes project.openProject: {frontend_ids2:?}"
    );
}

// ------------------------------- TEST-9 -------------------------------

#[tokio::test]
async fn invoke_frontend_action_relays_through_the_real_agent_channel() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "driver", "driver@x.test").await;
    let driver = login(&server, "driver").await;

    let session_id = Uuid::new_v4();
    let (mut stream, mut buf) = open_agent_stream(&server, &driver, session_id).await;

    // The AI host's invoke_capability(app.navigate) call over /api/mcp BLOCKS
    // until the "engine" below posts a result — drive both concurrently on
    // this task (no spawn needed; `tokio::join!` interleaves both futures).
    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &driver,
            "invoke_capability",
            json!({ "operation_id": "app.navigate", "body": { "path": "/projects" } }),
        ),
        async {
            let invoke_frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(10))
                .await
                .expect("agent_invoke frame arrives over the real SSE channel");
            assert_eq!(invoke_frame["type"], "agent_invoke");
            assert_eq!(invoke_frame["action_id"], "app.navigate");
            assert_eq!(invoke_frame["params"]["path"], "/projects");
            let request_id = invoke_frame["request_id"].clone();

            post_agent_result(
                &server,
                &driver,
                request_id,
                true,
                json!({ "navigated": true }),
                None,
            )
            .await;
        }
    );

    assert!(
        invoke_result.get("isError").is_none(),
        "frontend invoke succeeded end-to-end: {invoke_result}"
    );
    let structured = &invoke_result["structuredContent"];
    assert_eq!(structured["kind"], "frontend");
    assert_eq!(structured["ok"], true);
    assert_eq!(structured["result"]["navigated"], true);
}

// ------------------------------- TEST-10 -------------------------------

#[tokio::test]
async fn frontend_invoke_not_connected_and_not_permitted() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // No control session open at all → FRONTEND_NOT_CONNECTED.
    create_user(&server, &admin, "lonely", "lonely@x.test").await;
    let lonely = login(&server, "lonely").await;
    let result = tools_call(
        &server,
        &lonely,
        "invoke_capability",
        json!({ "operation_id": "app.navigate", "body": { "path": "/projects" } }),
    )
    .await;
    assert_eq!(result["isError"], true);
    assert_eq!(result["structuredContent"]["error_code"], "FRONTEND_NOT_CONNECTED");

    // A user holding mcp::use but NOT projects::use invoking project.openProject
    // → NOT_PERMITTED. Crucially: no agent channel is opened for this user at
    // all, so a relay attempt would have failed as FRONTEND_NOT_CONNECTED
    // instead — getting NOT_PERMITTED here is direct proof the permission
    // check runs BEFORE any relay onto the channel.
    create_user_with_only_mcp_use(&server, &admin, "restricted", "restricted@x.test").await;
    let restricted = login(&server, "restricted").await;
    let result2 = tools_call(
        &server,
        &restricted,
        "invoke_capability",
        json!({
            "operation_id": "project.openProject",
            "body": { "project_id": "11111111-1111-1111-1111-111111111111" }
        }),
    )
    .await;
    assert_eq!(result2["isError"], true);
    assert_eq!(result2["structuredContent"]["error_code"], "NOT_PERMITTED");
}

// ------------------------------- inflight cap (re-audit gap) -------------------------------

/// Mirrors `MAX_INFLIGHT_PER_USER` in `agent_channel.rs` (16) — kept as a
/// literal here rather than importing it because the module is private to
/// the server crate; bump both together if the cap ever changes.
const MAX_INFLIGHT_PER_USER: usize = 16;

#[tokio::test]
async fn inflight_cap_rejects_the_17th_then_frees_capacity_on_release() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "capdriver", "capdriver@x.test").await;
    let driver = login(&server, "capdriver").await;

    let session_id = Uuid::new_v4();
    let (mut stream, mut buf) = open_agent_stream(&server, &driver, session_id).await;

    // Fire MAX_INFLIGHT_PER_USER concurrent invoke_capability calls and hold
    // them open by never answering — each spawned task blocks inside the
    // REAL dispatch/liveness loop (`agent_channel::dispatch`) until it gets a
    // result or fails. `TestServer` itself isn't `Clone`, so each task gets
    // its own owned `reqwest::Client` (cheap — internally `Arc`-backed) +
    // owned URL/token and drives the raw MCP `tools/call` JSON-RPC body
    // directly instead of going through the `&TestServer`-borrowing
    // `tools_call` helper.
    let mcp_url = server.api_url("/mcp");
    let mut handles = Vec::new();
    for i in 0..MAX_INFLIGHT_PER_USER {
        let client = server.client.clone();
        let mcp_url = mcp_url.clone();
        let driver = driver.clone();
        handles.push(tokio::spawn(async move {
            let resp = client
                .post(&mcp_url)
                .bearer_auth(&driver)
                .json(&json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "invoke_capability",
                        "arguments": {
                            "operation_id": "app.navigate",
                            "body": { "path": format!("/cap-{i}") }
                        }
                    }
                }))
                .send()
                .await
                .expect("mcp rpc");
            let body: Value = resp.json().await.expect("mcp rpc json");
            body["result"].clone()
        }));
    }

    // Drain exactly MAX_INFLIGHT_PER_USER `agent_invoke` frames off the real
    // SSE channel (skipping any interleaved liveness `ping`s) — each arrives
    // only AFTER its dispatch successfully reserved an inflight slot via
    // `try_reserve_inflight`, so seeing all of them proves all the
    // concurrent reservations succeeded.
    let mut request_ids = Vec::new();
    while request_ids.len() < MAX_INFLIGHT_PER_USER {
        let frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(10))
            .await
            .expect("agent_invoke frame arrives for each of the concurrent dispatches");
        if frame["type"] == "agent_invoke" {
            request_ids.push(frame["request_id"].clone());
        }
    }

    // The over-cap invoke is rejected outright — it never reaches the
    // channel (no extra agent_invoke frame is sent for it).
    let over_cap = tools_call(
        &server,
        &driver,
        "invoke_capability",
        json!({ "operation_id": "app.navigate", "body": { "path": "/over-cap" } }),
    )
    .await;
    assert_eq!(over_cap["isError"], true, "{over_cap}");
    assert_eq!(over_cap["structuredContent"]["error_code"], "TOO_MANY_INFLIGHT");

    // Release capacity: answer 3 of the held-open dispatches.
    for request_id in request_ids.iter().take(3) {
        post_agent_result(&server, &driver, request_id.clone(), true, json!({ "navigated": true }), None).await;
    }

    // A freed slot lets a brand-new invoke through end to end.
    let (freed_result, ()) = tokio::join!(
        tools_call(
            &server,
            &driver,
            "invoke_capability",
            json!({ "operation_id": "app.navigate", "body": { "path": "/freed" } }),
        ),
        async {
            loop {
                let frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(10))
                    .await
                    .expect("freed invoke reaches the channel");
                if frame["type"] == "agent_invoke" {
                    post_agent_result(
                        &server,
                        &driver,
                        frame["request_id"].clone(),
                        true,
                        json!({ "navigated": true }),
                        None,
                    )
                    .await;
                    break;
                }
                // else: a liveness ping for one of the still-open held dispatches; ignore.
            }
        }
    );
    assert!(
        freed_result.get("isError").is_none(),
        "a freed inflight slot lets a new invoke through: {freed_result}"
    );
    assert_eq!(freed_result["structuredContent"]["ok"], true);

    // Cleanup: answer the remaining held-open dispatches so the spawned
    // tasks resolve instead of leaking past the test.
    for request_id in request_ids.iter().skip(3) {
        post_agent_result(&server, &driver, request_id.clone(), true, json!({ "navigated": true }), None).await;
    }
    for h in handles {
        let result = h.await.expect("spawned invoke task did not panic");
        assert!(result.get("isError").is_none(), "held-open invoke eventually resolved OK: {result}");
    }
}
