//! TEST-3/4 — realtime sync: the `/api/sync/subscribe` SSE endpoint auth-gate +
//! handshake, and an owner-scoped account-create frame delivered to the owner's
//! stream but NOT to another user's (owner isolation over the full mount →
//! publish → deliver path).

use std::time::Duration;

use serde_json::json;

use crate::common::{TestOptions, TestServer};

async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({"username":"syncadmin","email":"sync@x.test","password":"syncPassw0rd!"}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200, "sync setup_admin");
    let body: serde_json::Value = resp.json().await.unwrap();
    body["access_token"].as_str().or_else(|| body["token"].as_str()).unwrap().to_string()
}

async fn make_user(server: &TestServer, admin: &str, name: &str) -> String {
    server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({"username":name,"email":format!("{name}@x.test"),"password":"userPassw0rd!"}))
        .send()
        .await
        .unwrap();
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({"username":name,"password":"userPassw0rd!"}))
        .send()
        .await
        .unwrap();
    let body: serde_json::Value = resp.json().await.unwrap();
    body["access_token"].as_str().unwrap().to_string()
}

/// Read from an open SSE response until `needle` appears (or overall timeout).
async fn read_until(resp: &mut reqwest::Response, needle: &str, overall: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + overall;
    let mut buf = String::new();
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, resp.chunk()).await {
            Ok(Ok(Some(bytes))) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if buf.contains(needle) {
                    return true;
                }
            }
            _ => return false,
        }
    }
}

/// Read from an open SSE response until the server ENDS it, or `overall` runs
/// out. `true` = the stream terminated (what a teardown looks like to a client);
/// `false` = it was still open when the budget expired.
///
/// Frames that arrive meanwhile (keep-alives, sync events) are drained and
/// ignored — only the end-of-body matters here.
async fn stream_ends_within(resp: &mut reqwest::Response, overall: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + overall;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        match tokio::time::timeout(remaining, resp.chunk()).await {
            // Clean end-of-body, or a transport-level end: either way the
            // server dropped the stream.
            Ok(Ok(None)) | Ok(Err(_)) => return true,
            // A frame — keep waiting.
            Ok(Ok(Some(_))) => continue,
            // Budget expired with the stream still open.
            Err(_) => return false,
        }
    }
}

/// A logout must end an ALREADY-OPEN sync stream.
///
/// The subscribe gate validates the access token exactly once; the stream then
/// lives until the token's `exp` (24h by default). So without an epoch gate in
/// the periodic re-check, a logged-out user's SSE stream keeps delivering for
/// up to a day — and the client-side session fan-out is no defense against a
/// holder of a stolen token, who does not run our JS.
///
/// Alice is the positive case. Bob, who does NOT log out, is the negative
/// control: he proves the teardown is caused by the logout and not by streams
/// simply dying on their own (a bug that would otherwise make this test pass
/// for the wrong reason).
///
/// This fails on BOTH halves of the change: with no epoch check in
/// `SyncSurface::recheck`, and with the check present but the resolver leaving
/// `IdentityResolver::access_token_ver` at its `None` default (which disables
/// the gate).
#[tokio::test]
async fn logout_tears_down_an_already_open_stream() {
    // Shorten the 60s production re-check cadence so the teardown is observable.
    let server = TestServer::spawn_with(TestOptions {
        sync_recheck_tick_ms: Some(200),
        ..Default::default()
    })
    .await;
    let admin = setup_admin(&server).await;
    let alice = make_user(&server, &admin, "alice").await;
    let bob = make_user(&server, &admin, "bob").await;

    let mut a_stream = server
        .client
        .get(server.api_url("/sync/subscribe"))
        .bearer_auth(&alice)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    let mut b_stream = server
        .client
        .get(server.api_url("/sync/subscribe"))
        .bearer_auth(&bob)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert_eq!(a_stream.status().as_u16(), 200);
    assert_eq!(b_stream.status().as_u16(), 200);
    assert!(read_until(&mut a_stream, "connected", Duration::from_secs(5)).await);
    assert!(read_until(&mut b_stream, "connected", Duration::from_secs(5)).await);

    // Alice logs out on a SEPARATE client, so her stream keeps reading. Logout
    // bumps `users.token_version` — the epoch her open stream's token carried
    // is now stale.
    let client2 = reqwest::Client::new();
    let out = client2
        .post(server.api_url("/auth/logout"))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap();
    assert!(out.status().is_success(), "logout: {}", out.status());

    assert!(
        stream_ends_within(&mut a_stream, Duration::from_secs(15)).await,
        "logout must tear down the logged-out user's already-open SSE stream"
    );
    // Negative control: Bob never logged out, so his epoch still matches and his
    // stream must survive the same window.
    assert!(
        !stream_ends_within(&mut b_stream, Duration::from_secs(3)).await,
        "another user's stream must NOT be torn down by Alice's logout"
    );
}

#[tokio::test]
async fn subscribe_auth_gate_and_handshake() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Unauthenticated → 401.
    let un = server.client.get(server.api_url("/sync/subscribe")).send().await.unwrap();
    assert_eq!(un.status().as_u16(), 401, "subscribe requires auth");

    // With a bearer → 200 + a `connected` handshake frame.
    let mut resp = server
        .client
        .get(server.api_url("/sync/subscribe"))
        .bearer_auth(&admin)
        .header("Accept", "text/event-stream")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert!(
        read_until(&mut resp, "connected", Duration::from_secs(5)).await,
        "the subscribe stream emits a connected handshake"
    );
}

#[tokio::test]
async fn account_create_frame_is_owner_scoped() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = make_user(&server, &admin, "alice").await;
    let bob = make_user(&server, &admin, "bob").await;

    // Open both users' streams; drain each handshake.
    let mut a_stream = server.client.get(server.api_url("/sync/subscribe")).bearer_auth(&alice).header("Accept","text/event-stream").send().await.unwrap();
    let mut b_stream = server.client.get(server.api_url("/sync/subscribe")).bearer_auth(&bob).header("Accept","text/event-stream").send().await.unwrap();
    assert!(read_until(&mut a_stream, "connected", Duration::from_secs(5)).await);
    assert!(read_until(&mut b_stream, "connected", Duration::from_secs(5)).await);

    // The old owner-scoped emit was the project-create frame (`/api/projects`
    // is removed with the projects module). The KEPT event source through the
    // same SSE spine is `sync::publish_account_created`: an admin founds an
    // org on alice's behalf (`POST /api/accounts` is gated `account::manage`,
    // admin-only; the body's `owner_id` makes HER the owner member), and the
    // account + account_member CREATE frames fan owner-scoped to alice — the
    // audience is owner ∪ members and the actor is detached, so nobody is
    // suppressed. A separate client so alice's stream keeps reading.
    let alice_uid: uuid::Uuid = {
        let pool = sqlx::SqlitePool::connect(server.database_url())
            .await
            .expect("connect id lookup pool");
        let id: uuid::Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'alice'")
            .fetch_one(&pool)
            .await
            .expect("alice user row");
        pool.close().await;
        id
    };
    let client2 = reqwest::Client::new();
    let r = client2
        .post(server.api_url("/accounts"))
        .bearer_auth(&admin)
        .json(&json!({"name":"synced","owner_id": alice_uid}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 201);

    // Alice's stream receives an `account` sync frame; Bob's does NOT.
    assert!(
        read_until(&mut a_stream, "\"account\"", Duration::from_secs(5)).await,
        "the owner's stream receives the account sync frame"
    );
    assert!(
        !read_until(&mut b_stream, "\"account\"", Duration::from_secs(2)).await,
        "another user's stream must NOT receive the owner-scoped frame"
    );
}
