//! The VIEW-SCOPED capability population, over the FULL production path: a
//! controlled session opens the real agent SSE stream, REPORTS the capabilities
//! it registered, and they reach the agent through the real
//! `list_capabilities` / `describe_capability` / `invoke_capability` surface.
//!
//! ## What this replaces, and why
//!
//! The server used to DERIVE this population by walking
//! `<data_root>/processors/<pkg>/ui/*.yaml` and parsing each `view_spec` with a
//! partial Rust mirror of a schema the FE runtime owns. Two parsers of one
//! document is the defect class; and the derived set was advertised whether or
//! not a browser was bound, while `invoke_capability(kind=frontend)` can only
//! ever reach a bound session. So the projection moved to the side that owns the
//! document, and the catalog is now REPORTED.
//!
//! The ACCEPTANCE property is asserted twice over, both ways round:
//!   - a view action reaches the AI capability catalog with the server parsing
//!     NO view_spec ([`a_reported_view_action_reaches_the_agent`]) — and the
//!     payload here is a hand-written, domain-neutral capability, which is
//!     itself the proof: nothing in the repo's processor tree is consulted;
//!   - what the server would once have advertised with no browser bound is no
//!     longer advertised ([`view_scoped_capabilities_vanish_with_the_session`]).
//!
//! The trust boundary the report opens (fail-closed permission, anti-shadowing,
//! caps) is unit-tested in `modules/mcp/capabilities.rs`; the two rules whose
//! failure would be a REAL capability leak are re-asserted here over HTTP.

use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use super::{create_user, login, next_sse_event, post_agent_result, setup_admin, tools_call};
use crate::common::TestServer;

/// A domain-neutral view-scoped capability, in the shape the FE projects from a
/// declarative view_spec (`workbench/core/spec/aiCapabilities.ts`): a namespaced
/// `<view>::<action>` id, `kind:"instance"`, and a `params_schema` requiring the
/// instance target.
fn capability(id: &str, permission: &str) -> Value {
    json!({
        "id": id,
        "title": "Set a value",
        "kind": "instance",
        "mutating": true,
        "stateful": false,
        "context": "global",
        "permission": permission,
        "description": "Set the value of the demo view.",
        "params_schema": {
            "type": "object",
            "required": ["view_id", "value"],
            "additionalProperties": false,
            "properties": {
                "view_id": { "type": "string" },
                "value": { "type": "string" }
            }
        }
    })
}

/// `POST /api/mcp/agent/capabilities` — returns the ack's `ok` flag (whether the
/// report correlated to the caller's currently bound control connection).
async fn post_capabilities(
    server: &TestServer,
    token: &str,
    connection_id: &Value,
    capabilities: Value,
) -> bool {
    let resp = server
        .client
        .post(server.api_url("/mcp/agent/capabilities"))
        .bearer_auth(token)
        .json(&json!({ "connection_id": connection_id, "capabilities": capabilities }))
        .send()
        .await
        .expect("agent capabilities");
    assert_eq!(resp.status().as_u16(), 200, "capabilities report status");
    let body: Value = resp.json().await.expect("capabilities ack json");
    body["ok"].as_bool().unwrap_or(false)
}

/// Open the agent SSE stream and return `(response, buffer, connection_id)` —
/// the handshake's server-minted connection id is what a capability report must
/// echo back.
async fn open_stream_with_connection_id(
    server: &TestServer,
    token: &str,
) -> (reqwest::Response, String, Value) {
    let session_id = Uuid::new_v4();
    let mut resp = server
        .client
        .get(server.api_url(&format!("/mcp/agent/stream?session_id={session_id}")))
        .bearer_auth(token)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .expect("open agent stream");
    assert_eq!(resp.status().as_u16(), 200, "agent stream open");
    let mut buf = String::new();
    let connected = next_sse_event(&mut resp, &mut buf, Duration::from_secs(5))
        .await
        .expect("connected handshake frame");
    assert_eq!(connected["type"], "connected");
    let connection_id = connected["connection_id"].clone();
    assert!(
        connection_id.as_str().is_some(),
        "the handshake must carry the connection_id a report correlates on: {connected}"
    );
    (resp, buf, connection_id)
}

/// The frontend-kind entries `list_capabilities` returns for `token`.
async fn frontend_ids(server: &TestServer, token: &str) -> Vec<String> {
    let result = tools_call(server, token, "list_capabilities", json!({})).await;
    result["structuredContent"]["operations"]
        .as_array()
        .expect("operations array")
        .iter()
        .filter(|o| o["kind"] == "frontend")
        .map(|o| o["operation_id"].as_str().unwrap().to_string())
        .collect()
}

// ---------------------------- the acceptance property ----------------------------

/// A view action reaches the AI capability catalog WITHOUT the server parsing a
/// view_spec: the controlled session reports it, `list_capabilities` lists it,
/// `describe_capability` describes it, and `invoke_capability` relays it down
/// the real agent channel.
#[tokio::test]
async fn a_reported_view_action_reaches_the_agent() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "reporter", "reporter@x.test").await;
    let user = login(&server, "reporter").await;

    let (mut stream, mut buf, connection_id) = open_stream_with_connection_id(&server, &user).await;

    // Before the report: the catalog is the app-owned half only.
    let before = frontend_ids(&server, &user).await;
    assert!(
        !before.iter().any(|id| id == "demo.view::d.setValue"),
        "not reported yet: {before:?}"
    );
    assert!(
        before.iter().any(|id| id == "app.navigate"),
        "the app-owned half is still there: {before:?}"
    );

    // `jobs::use` is granted to the Users group, so this caller is permitted.
    assert!(
        post_capabilities(
            &server,
            &user,
            &connection_id,
            json!([capability("demo.view::d.setValue", "jobs::use")]),
        )
        .await,
        "the report must correlate to the bound connection"
    );

    // list_capabilities — the entry the server never parsed a document to learn.
    let after = frontend_ids(&server, &user).await;
    assert!(
        after.iter().any(|id| id == "demo.view::d.setValue"),
        "a REPORTED view action must reach the agent: {after:?}"
    );

    // describe_capability — the reported metadata is surfaced verbatim.
    let described = tools_call(
        &server,
        &user,
        "describe_capability",
        json!({ "operation_id": "demo.view::d.setValue" }),
    )
    .await;
    let structured = &described["structuredContent"];
    assert_eq!(structured["kind"], "frontend", "{structured}");
    assert_eq!(structured["frontend_kind"], "instance", "{structured}");
    assert_eq!(
        structured["required_permission"], "jobs::use",
        "{structured}"
    );
    assert_eq!(structured["view_id_required"], true, "{structured}");
    assert_eq!(
        structured["params_schema"]["required"],
        json!(["view_id", "value"]),
        "the schema the FE projected is the schema the agent is shown: {structured}"
    );

    // invoke_capability — the real dispatch reaches the real SSE stream.
    let (invoke_result, ()) = tokio::join!(
        tools_call(
            &server,
            &user,
            "invoke_capability",
            json!({
                "operation_id": "demo.view::d.setValue",
                "body": { "view_id": "v1", "value": "x" }
            }),
        ),
        async {
            let frame = next_sse_event(&mut stream, &mut buf, Duration::from_secs(10))
                .await
                .expect("agent_invoke frame arrives over the real SSE channel");
            assert_eq!(frame["type"], "agent_invoke");
            assert_eq!(frame["action_id"], "demo.view::d.setValue");
            assert_eq!(frame["view_id"], "v1", "{frame}");
            post_agent_result(
                &server,
                &user,
                frame["request_id"].clone(),
                true,
                json!({ "applied": true }),
                None,
            )
            .await;
        }
    );
    assert!(invoke_result.get("isError").is_none(), "{invoke_result}");
    assert_eq!(
        invoke_result["structuredContent"]["result"]["applied"], true,
        "{invoke_result}"
    );
}

/// The other half of the acceptance property: what the deleted scan would have
/// advertised with NO browser bound is no longer advertised. `invoke_capability`
/// can only ever reach a bound session, so an entry outliving its session is an
/// entry the agent is told about and cannot use.
#[tokio::test]
async fn view_scoped_capabilities_vanish_with_the_session() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "vanisher", "vanisher@x.test").await;
    let user = login(&server, "vanisher").await;

    {
        let (_stream, _buf, connection_id) = open_stream_with_connection_id(&server, &user).await;
        assert!(
            post_capabilities(
                &server,
                &user,
                &connection_id,
                json!([capability("demo.view::d.setValue", "jobs::use")]),
            )
            .await
        );
        let listed = frontend_ids(&server, &user).await;
        assert!(
            listed.iter().any(|id| id == "demo.view::d.setValue"),
            "positive control — it IS advertised while the session lives: {listed:?}"
        );
        // `_stream` drops here: the SSE response is torn down, so the server
        // unbinds the control connection.
    }

    // The unbind is observed by the server asynchronously (the stream task has to
    // notice the dropped body), so poll rather than assume a single tick.
    let mut listed = frontend_ids(&server, &user).await;
    for _ in 0..40 {
        if !listed.iter().any(|id| id == "demo.view::d.setValue") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        listed = frontend_ids(&server, &user).await;
    }
    assert!(
        !listed.iter().any(|id| id == "demo.view::d.setValue"),
        "a capability nobody can invoke must not be advertised: {listed:?}"
    );
    assert!(
        listed.iter().any(|id| id == "app.navigate"),
        "…and the app-owned half is untouched: {listed:?}"
    );
}

// ---------------------------- the trust boundary, over HTTP ----------------------------

/// FAIL-CLOSED. The rule the deleted scan enforced on a `view_spec` action with
/// no `permission` now applies to a REPORTED one, and it is enforced on the
/// server: an ungated capability never reaches the agent, whoever supplies it.
#[tokio::test]
async fn a_permissionless_reported_capability_never_reaches_the_agent() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ungater", "ungater@x.test").await;
    let user = login(&server, "ungater").await;

    let (_stream, _buf, connection_id) = open_stream_with_connection_id(&server, &user).await;
    assert!(
        post_capabilities(
            &server,
            &user,
            &connection_id,
            json!([
                capability("demo.view::d.ungated", ""),
                capability("demo.view::d.gated", "jobs::use"),
            ]),
        )
        .await
    );

    let listed = frontend_ids(&server, &user).await;
    assert!(
        !listed.iter().any(|id| id == "demo.view::d.ungated"),
        "an ungated capability must not reach the agent: {listed:?}"
    );
    assert!(
        listed.iter().any(|id| id == "demo.view::d.gated"),
        "…while its well-formed sibling still does: {listed:?}"
    );

    // It is not merely hidden from the LIST — it never entered the catalog at
    // all, so a describe by exact id is refused as an unavailable operation
    // (the JSON-RPC-level shape an id nobody may run produces).
    let (status, body) = super::mcp_rpc(
        &server,
        &user,
        "tools/call",
        json!({
            "name": "describe_capability",
            "arguments": { "operation_id": "demo.view::d.ungated" }
        }),
    )
    .await;
    assert_eq!(status, 200);
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("is not available to you"),
        "an ungated capability must not be describable either: {body}"
    );
    assert!(body["result"].is_null(), "{body}");
}

/// ANTI-SHADOWING. A client cannot re-declare an APP-OWNED action under its own
/// terms — the baked entry wins, so a reported entry can never lower the
/// permission the agent is gated on.
#[tokio::test]
async fn a_reported_capability_cannot_shadow_an_app_owned_action() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "shadower", "shadower@x.test").await;
    let user = login(&server, "shadower").await;

    let (_stream, _buf, connection_id) = open_stream_with_connection_id(&server, &user).await;

    // `app.navigate` is app-owned, `context:"global"`, permission
    // `mcp::use`. The report tries to replace all three. (The old target,
    // `dataset.process` with its `projects::use` gate, was stripped with the
    // project/dataset modules; the collision rule is action-shape agnostic.)
    let mut impostor = capability("app.navigate", "mcp::use");
    impostor["title"] = json!("IMPOSTOR");
    impostor["context"] = json!("workbench");
    assert!(post_capabilities(&server, &user, &connection_id, json!([impostor])).await);

    let described = tools_call(
        &server,
        &user,
        "describe_capability",
        json!({ "operation_id": "app.navigate" }),
    )
    .await;
    let structured = &described["structuredContent"];
    assert_ne!(structured["title"], "IMPOSTOR", "{structured}");
    assert_eq!(
        structured["required_permission"], "mcp::use",
        "{structured}"
    );
    assert_eq!(structured["context"], "global", "{structured}");
}

/// One user's report is invisible to another, and a `connection_id` belonging to
/// somebody else's session does not correlate.
#[tokio::test]
async fn a_report_is_scoped_to_the_reporting_users_own_session() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "owner", "owner@x.test").await;
    create_user(&server, &admin, "bystander", "bystander@x.test").await;
    let owner = login(&server, "owner").await;
    let bystander = login(&server, "bystander").await;

    let (_owner_stream, _owner_buf, owner_conn) =
        open_stream_with_connection_id(&server, &owner).await;
    let (_by_stream, _by_buf, _by_conn) = open_stream_with_connection_id(&server, &bystander).await;

    assert!(
        post_capabilities(
            &server,
            &owner,
            &owner_conn,
            json!([capability("demo.view::d.owned", "jobs::use")]),
        )
        .await
    );

    let owner_ids = frontend_ids(&server, &owner).await;
    assert!(owner_ids.iter().any(|id| id == "demo.view::d.owned"));
    let bystander_ids = frontend_ids(&server, &bystander).await;
    assert!(
        !bystander_ids.iter().any(|id| id == "demo.view::d.owned"),
        "another user's reported capability must not appear: {bystander_ids:?}"
    );

    // …and the bystander cannot write into the owner's session by presenting the
    // owner's connection id.
    assert!(
        !post_capabilities(
            &server,
            &bystander,
            &owner_conn,
            json!([capability("demo.view::d.injected", "jobs::use")]),
        )
        .await,
        "a connection id owned by another user must not correlate"
    );
    let owner_ids = frontend_ids(&server, &owner).await;
    assert!(
        !owner_ids.iter().any(|id| id == "demo.view::d.injected"),
        "{owner_ids:?}"
    );
}

/// The report surface is gated exactly like the rest of the channel: 401
/// unauthenticated, 403 without `mcp::use`.
#[tokio::test]
async fn the_capability_report_is_permission_gated() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let body = json!({
        "connection_id": Uuid::new_v4(),
        "capabilities": [capability("demo.view::d.setValue", "jobs::use")],
    });

    let un = server
        .client
        .post(server.api_url("/mcp/agent/capabilities"))
        .json(&body)
        .send()
        .await
        .expect("unauthenticated report");
    assert_eq!(un.status().as_u16(), 401);

    super::create_user_without_mcp_use(&server, &admin, "nomcp", "nomcp@x.test").await;
    let nomcp = login(&server, "nomcp").await;
    let denied = server
        .client
        .post(server.api_url("/mcp/agent/capabilities"))
        .bearer_auth(&nomcp)
        .json(&body)
        .send()
        .await
        .expect("unpermitted report");
    assert_eq!(denied.status().as_u16(), 403);
}

/// A capability whose declared permission the caller does NOT hold is stored but
/// not offered — the report says what EXISTS in the browser, the server still
/// decides what this principal may SEE and may RUN. This is the half that makes
/// "the client declares the permission" safe to say out loud: the declaration
/// selects which gate applies, and `principal_holds` is still the gate.
#[tokio::test]
async fn a_reported_capability_the_caller_cannot_hold_is_not_offered() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    super::create_user_with_only_mcp_use(&server, &admin, "mcponly", "mcponly@x.test").await;
    let user = login(&server, "mcponly").await;

    let (_stream, _buf, connection_id) = open_stream_with_connection_id(&server, &user).await;
    assert!(
        post_capabilities(
            &server,
            &user,
            &connection_id,
            json!([
                capability("demo.view::d.needsJobs", "jobs::use"),
                capability("demo.view::d.needsMcp", "mcp::use"),
            ]),
        )
        .await
    );

    let listed = frontend_ids(&server, &user).await;
    assert!(
        !listed.iter().any(|id| id == "demo.view::d.needsJobs"),
        "a permission this caller does not hold must not be offered: {listed:?}"
    );
    assert!(
        listed.iter().any(|id| id == "demo.view::d.needsMcp"),
        "…and one they do hold still is: {listed:?}"
    );

    // …and invoking it by exact id is refused BEFORE any relay — per CONTRACT.md
    // a frontend-kind `NOT_PERMITTED` surfaces as an `isError` tool result, not
    // a JSON-RPC-level error.
    let invoked = tools_call(
        &server,
        &user,
        "invoke_capability",
        json!({
            "operation_id": "demo.view::d.needsJobs",
            "body": { "view_id": "v1", "value": "x" }
        }),
    )
    .await;
    assert_eq!(invoked["isError"], true, "{invoked}");
    assert_eq!(
        invoked["structuredContent"]["error_code"], "NOT_PERMITTED",
        "{invoked}"
    );
}
