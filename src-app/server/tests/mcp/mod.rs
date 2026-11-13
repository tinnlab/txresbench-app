//! MCP module integration tests — full production path through a real spawned
//! server + real Postgres (per-test DB). Covers the JSON-RPC surface
//! (`initialize`/`tools/list`), the merged REST + frontend-action capability
//! catalogs, the agent SSE channel (a SIMULATED engine acting as the test
//! client — the real channel path, not a mock of the claimed behavior), the
//! A9 deny path, the Users-group grant, and one-time-code pairing.
//! See `.lifecycle/ai-mcp/TESTS.md` TEST-6..14.

use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use crate::common::TestServer;

// ------------------------------- auth helpers -------------------------------

pub(crate) async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": "admin",
            "email": "admin@txresbench.test",
            "password": "adminPassw0rd!",
            "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 200);
    token_of(resp.json().await.expect("setup json"))
}

pub(crate) fn token_of(body: Value) -> String {
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

/// Create a user (admin-created). Auto-joined to the Users group, so they
/// hold `mcp::use` (mcp_grants migration) + `jobs::use` (jobs baseline grant)
/// — the default "full" caller shape most tests want. The `projects::use`
/// grant went with the removed project module, so a Users-group member no
/// longer holds it (only the admin's `*` wildcard does).
pub(crate) async fn create_user(server: &TestServer, admin: &str, username: &str, email: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": username,
            "email": email,
            "password": "userPassw0rd!",
        }))
        .send()
        .await
        .expect("create user");
    assert!(resp.status().is_success(), "create user {username}: {}", resp.status());
    let body: Value = resp.json().await.expect("user json");
    body["user"]["id"].as_str().expect("user id").to_string()
}

/// Log in → an access token.
pub(crate) async fn login(server: &TestServer, username: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "userPassw0rd!" }))
        .send()
        .await
        .expect("login");
    assert_eq!(resp.status().as_u16(), 200, "login {username}");
    token_of(resp.json().await.expect("login json"))
}

/// Create a user then STRIP them from the Users group → they hold neither
/// `mcp::use` nor `jobs::use` (for the A9 deny path).
pub(crate) async fn create_user_without_mcp_use(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> String {
    let id = create_user(server, admin, username, email).await;
    // The `/groups` HTTP surface is stripped on this node; the removal goes
    // through the SDK user repository.
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect strip pool");
    crate::common::group_remove_from_users(
        &pool,
        uuid::Uuid::parse_str(&id).expect("user id is a uuid"),
    )
    .await;
    id
}

/// Create a user holding `mcp::use` and NOTHING else — strips the default
/// Users grant (which bundles `mcp::use` + `jobs::use` together) then
/// grants `mcp::use` alone via a bespoke group. Isolates the
/// permission-filter assertions (TEST-8/TEST-10) from `jobs::use` (the
/// kept stand-in for the removed `projects::use`-gated actions).
pub(crate) async fn create_user_with_only_mcp_use(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> String {
    let id = create_user_without_mcp_use(server, admin, username, email).await;

    let group_name = format!("mcp-only-{username}");
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect mcp-only pool");
    let group_id = crate::common::group_create(&pool, &group_name, vec!["mcp::use".to_string()])
        .await
        .to_string();
    crate::common::group_assign(
        &pool,
        uuid::Uuid::parse_str(&id).expect("user id is a uuid"),
        uuid::Uuid::parse_str(&group_id).expect("group id is a uuid"),
    )
    .await;
    id
}

// ------------------------------- MCP JSON-RPC helpers -------------------------------

/// POST a raw JSON-RPC request to `/api/mcp`, returning `(http_status, body)`.
pub(crate) async fn mcp_rpc(server: &TestServer, token: &str, method: &str, params: Value) -> (u16, Value) {
    let resp = server
        .client
        .post(server.api_url("/mcp"))
        .bearer_auth(token)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .expect("mcp rpc");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.expect("mcp rpc json");
    (status, body)
}

/// `tools/call` convenience wrapper — returns the JSON-RPC `result` value.
/// Panics if the call errored at the JSON-RPC level (tests that expect a
/// JSON-RPC-level error use [`mcp_rpc`] directly); a `tools/call` result
/// carrying an MCP `isError` tool result is NOT a JSON-RPC-level error (per
/// CONTRACT.md) and passes through fine.
pub(crate) async fn tools_call(server: &TestServer, token: &str, name: &str, arguments: Value) -> Value {
    let (status, body) = mcp_rpc(
        server,
        token,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
    )
    .await;
    assert_eq!(status, 200, "tools/call http status: {body}");
    assert!(
        body["error"].is_null(),
        "tools/call unexpected JSON-RPC-level error: {body}"
    );
    body["result"].clone()
}

// ------------------------------- agent channel (simulated engine) -------------------------------

/// Open the agent SSE stream for `token`, draining the `connected` handshake
/// frame first. Returns the response + a read buffer to keep threading
/// through subsequent [`next_sse_event`] calls (partial reads persist there).
pub(crate) async fn open_agent_stream(
    server: &TestServer,
    token: &str,
    session_id: Uuid,
) -> (reqwest::Response, String) {
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
    (resp, buf)
}

/// Read the next parsed SSE `data:` JSON event out of `resp`, buffering
/// partial network reads in `buf` across calls (so callers can interleave
/// many small reads over one long-lived stream). Skips comment-only
/// (keep-alive) blocks. Returns `None` on timeout.
pub(crate) async fn next_sse_event(resp: &mut reqwest::Response, buf: &mut String, overall: Duration) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + overall;
    loop {
        if let Some(pos) = buf.find("\n\n") {
            let block: String = buf.drain(..pos + 2).collect();
            for line in block.lines() {
                if let Some(data) = line.strip_prefix("data:") {
                    if let Ok(v) = serde_json::from_str::<Value>(data.trim()) {
                        return Some(v);
                    }
                }
            }
            continue; // comment-only block (keep-alive) — keep looking.
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, resp.chunk()).await {
            Ok(Ok(Some(bytes))) => buf.push_str(&String::from_utf8_lossy(&bytes)),
            _ => return None,
        }
    }
}

/// `POST /api/mcp/agent/result` — the simulated engine's final answer.
pub(crate) async fn post_agent_result(
    server: &TestServer,
    token: &str,
    request_id: Value,
    ok: bool,
    result: Value,
    error: Option<&str>,
) {
    let resp = server
        .client
        .post(server.api_url("/mcp/agent/result"))
        .bearer_auth(token)
        .json(&json!({
            "request_id": request_id,
            "ok": ok,
            "result": result,
            "error": error,
            "logs": ["did it"],
        }))
        .send()
        .await
        .expect("agent result");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("agent result json");
    assert_eq!(body["ok"], true, "result correlated to a pending dispatch");
}

/// `POST /api/mcp/agent/pong` — the simulated engine's liveness answer.
/// Returns the ack's `ok` flag (whether the request_id still correlated to a
/// pending dispatch).
pub(crate) async fn post_agent_pong(server: &TestServer, token: &str, request_id: Value, status: &str) -> bool {
    let resp = server
        .client
        .post(server.api_url("/mcp/agent/pong"))
        .bearer_auth(token)
        .json(&json!({ "request_id": request_id, "status": status }))
        .send()
        .await
        .expect("agent pong");
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.expect("agent pong json");
    body["ok"].as_bool().unwrap_or(false)
}

mod context_gating;
mod frontend_actions;
mod instance_actions;
mod liveness;
mod pairing;
mod settings_test;
mod view_capabilities;

// ------------------------------- TEST-6 -------------------------------

#[tokio::test]
async fn initialize_and_tools_list_expose_three_control_tools() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    let (status, init) = mcp_rpc(&server, &admin, "initialize", json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(init["result"]["serverInfo"]["name"], "txresbench-mcp");
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert!(init["result"]["capabilities"]["tools"].is_object());

    let (status, list) = mcp_rpc(&server, &admin, "tools/list", json!({})).await;
    assert_eq!(status, 200);
    let tools = list["result"]["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 3, "exactly the 3 control tools: {list}");
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        vec!["list_capabilities", "describe_capability", "invoke_capability"]
    );
}

// ------------------------------- TEST-7 (deleted) -------------------------------
// `backend_actions.rs` tested the ONE backend op the old suite exercised from
// the live OpenAPI catalog — `Project.list` (the REST half of TEST-7). With
// `/api/projects*` stripped, that op no longer exists in the catalog (the
// catalog is derived from the live aide doc), so both arms — the
// list_capabilities presence check and the loopback invoke — are deleted
// rather than emptied; no kept backend op replaces them in this suite.

// ------------------------------- TEST-11: A9 deny -------------------------------

#[tokio::test]
async fn a9_deny_mcp_surface_without_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Unauthenticated → 401 on both surfaces.
    let un_rpc = server
        .client
        .post(server.api_url("/mcp"))
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(un_rpc.status().as_u16(), 401, "unauthenticated → 401 on POST /api/mcp");

    let sid_un = Uuid::new_v4();
    let un_stream = server
        .client
        .get(server.api_url(&format!("/mcp/agent/stream?session_id={sid_un}")))
        .send()
        .await
        .unwrap();
    assert_eq!(un_stream.status().as_u16(), 401, "unauthenticated → 401 on GET agent/stream");

    // Authenticated but lacking `mcp::use` → 403 on both surfaces.
    create_user_without_mcp_use(&server, &admin, "nogrant", "nogrant@x.test").await;
    let nogrant = login(&server, "nogrant").await;

    let rpc = server
        .client
        .post(server.api_url("/mcp"))
        .bearer_auth(&nogrant)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(rpc.status().as_u16(), 403, "no mcp::use → 403 on POST /api/mcp");

    let sid = Uuid::new_v4();
    let stream = server
        .client
        .get(server.api_url(&format!("/mcp/agent/stream?session_id={sid}")))
        .bearer_auth(&nogrant)
        .send()
        .await
        .unwrap();
    assert_eq!(stream.status().as_u16(), 403, "no mcp::use → 403 on GET agent/stream");
}

// ------------------------------- TEST-13: Users-group grant -------------------------------

#[tokio::test]
async fn users_group_member_reaches_mcp_surface() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // A fresh, non-admin user who is ONLY a member of the default Users
    // group (no bespoke grants) must reach the MCP surface — proving the
    // `mcp_grants` migration's grant of `mcp::use` to Users.
    create_user(&server, &admin, "member", "member@x.test").await;
    let member = login(&server, "member").await;

    let (status, resp) = mcp_rpc(&server, &member, "tools/list", json!({})).await;
    assert_eq!(status, 200, "a plain Users-group member holds mcp::use via the migration grant");
    assert_eq!(resp["result"]["tools"].as_array().unwrap().len(), 3);
}
