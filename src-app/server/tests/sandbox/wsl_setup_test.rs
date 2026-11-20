//! `POST /api/sandbox/wsl/setup` on a machine with nothing to set up (any
//! system but a Windows PC whose WSL is missing or too old): 409
//! `WSL_SETUP_NOT_OFFERED`, and nothing changes. A page from another web
//! origin (its `Origin`) or a request to another name for this PC (its
//! `Host`) is refused before anything else (403 `WSL_SETUP_NOT_FROM_THE_APP`).
//! The app window's origins pass that check (it does not tell TxResBench's
//! window from another Tauri app's; the app's own dialog does). The setup
//! itself (the offer, the app's own question, one at a time, the result) is
//! unit-tested in `sandbox::wsl_setup` behind its seams.
//!
//! On a Windows PC that IS offered a setup (WSL missing or too old, like the
//! test VM), an accepted POST would start a real setup: the app's own
//! dialog, which nobody can answer in a test, then (on Install WSL) an
//! install as administrator. The tests check what the notice reads there and skip every
//! POST that could be accepted (recorded); the refused ones run everywhere.

use serde_json::Value;

use super::{restricted_user_token, setup_admin};
use crate::common::{record_skip, TestServer};

async fn stack(server: &TestServer, token: &str) -> Value {
    let resp = server
        .client
        .get(server.api_url("/sandbox/envs"))
        .bearer_auth(token)
        .send()
        .await
        .expect("get envs");
    assert_eq!(resp.status().as_u16(), 200, "admin reads the envs");
    let body: Value = resp.json().await.expect("envs json");
    body["stack"].clone()
}

async fn post_setup(server: &TestServer, token: &str) -> reqwest::Response {
    server
        .client
        .post(server.api_url("/sandbox/wsl/setup"))
        .bearer_auth(token)
        .send()
        .await
        .expect("post setup")
}

#[tokio::test]
async fn a_setup_with_nothing_offered_is_refused_and_changes_nothing() {
    let name = stringify!(a_setup_with_nothing_offered_is_refused_and_changes_nothing);
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let before = stack(&server, &token).await;
    if let Some(setup) = before.get("wsl_setup") {
        assert!(cfg!(windows), "a WSL notice only on Windows: {before}");
        assert_eq!(before["supported"], false, "{before}");
        assert!(before["reason"].as_str().is_some_and(|r| !r.is_empty()), "the notice says why: {before}");
        assert_eq!(setup["running"], false, "{setup}");
        if let Some(offer) = setup.get("offer") {
            assert!(offer == "install" || offer == "update", "{setup}");
            record_skip(name, "this Windows PC is offered a real WSL setup: a POST would set WSL up as administrator");
            return;
        }
    }

    for _ in 0..2 {
        let resp = post_setup(&server, &token).await;
        assert_eq!(resp.status().as_u16(), 409, "nothing to set up");
        let body: Value = resp.json().await.expect("409 json");
        assert_eq!(body["error_code"], "WSL_SETUP_NOT_OFFERED", "{body}");
    }

    let after = stack(&server, &token).await;
    assert_eq!(after, before, "the refused setup changed nothing");
}

/// The permission is checked before anything else, so this never reaches a
/// setup, even where one is offered.
#[tokio::test]
async fn a_setup_needs_the_sandbox_manage_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let user = restricted_user_token(&server, &admin).await;
    let resp = post_setup(&server, &user).await;
    assert_eq!(resp.status().as_u16(), 403, "a user without sandbox::settings::manage");
}

async fn post_setup_with(server: &TestServer, token: &str, headers: &[(&str, String)]) -> reqwest::Response {
    let mut request = server.client.post(server.api_url("/sandbox/wsl/setup")).bearer_auth(token);
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    request.send().await.expect("post setup")
}

async fn refused_as_not_from_the_app(resp: reqwest::Response, what: &str) {
    assert_eq!(resp.status().as_u16(), 403, "{what}");
    let body: Value = resp.json().await.expect("403 json");
    assert_eq!(body["error_code"], "WSL_SETUP_NOT_FROM_THE_APP", "{what}: {body}");
}

/// A web page in a browser on this PC sends its origin, and one whose own
/// name was made to point at this PC ("DNS rebinding") sends that name as
/// the `Host`: both are refused before anything else, also where a setup is
/// offered. The app window's origins pass this check.
#[tokio::test]
async fn a_setup_from_a_web_page_or_another_name_is_refused() {
    let name = stringify!(a_setup_from_a_web_page_or_another_name_is_refused);
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let port = reqwest::Url::parse(&server.api_url("/")).expect("url").port().expect("port");
    let before = stack(&server, &token).await;

    for origin in ["https://evil.example", "null", "http://localhost:3000"] {
        let resp = post_setup_with(&server, &token, &[("Origin", origin.to_string())]).await;
        refused_as_not_from_the_app(resp, origin).await;
    }
    for host in [format!("evil.example:{port}"), format!("127.0.0.1:{}", port.wrapping_add(1))] {
        let resp = post_setup_with(&server, &token, &[("Host", host.clone())]).await;
        refused_as_not_from_the_app(resp, &host).await;
    }

    if before.get("wsl_setup").and_then(|s| s.get("offer")).is_some() {
        record_skip(name, "this Windows PC is offered a real WSL setup: an accepted POST would start it");
    } else {
        for origin in ["http://tauri.localhost", "tauri://localhost"] {
            let resp = post_setup_with(&server, &token, &[("Origin", origin.to_string())]).await;
            assert_eq!(resp.status().as_u16(), 409, "the app window's origin passes the check: {origin}");
            let body: Value = resp.json().await.expect("409 json");
            assert_eq!(body["error_code"], "WSL_SETUP_NOT_OFFERED", "{origin}: {body}");
        }
    }
    assert_eq!(stack(&server, &token).await, before, "the refused setups changed nothing");
}
