//! `POST /api/sandbox/wsl/setup` on the headless server the tests run: only
//! the desktop app offers a setup, so this server never does, on any system
//! (a Windows PC whose WSL is missing or too old, like the test VM,
//! included). The notice has no offer, the POST is refused with 409
//! `WSL_SETUP_NOT_OFFERED`, and nothing changes. Like every route, it is
//! behind the local API lock: without the key it is refused before anything
//! else. The setup itself (the offer, the app's own question, one at a
//! time, the result) is unit-tested in `sandbox::wsl_setup` behind its seams.

use serde_json::Value;

use super::{restricted_user_token, setup_admin};
use crate::common::TestServer;

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
async fn a_headless_server_offers_no_setup_and_refuses_one() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let before = stack(&server, &token).await;
    if let Some(setup) = before.get("wsl_setup") {
        assert!(cfg!(windows), "a WSL notice only on Windows: {before}");
        assert_eq!(before["supported"], false, "{before}");
        assert!(before["reason"].as_str().is_some_and(|r| !r.is_empty()), "the notice says why: {before}");
        assert_eq!(setup["running"], false, "{setup}");
        assert!(setup.get("offer").is_none(), "only the desktop app offers a setup: {setup}");
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

/// The permission is checked before the route runs.
#[tokio::test]
async fn a_setup_needs_the_sandbox_manage_permission() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let user = restricted_user_token(&server, &admin).await;
    let resp = post_setup(&server, &user).await;
    assert_eq!(resp.status().as_u16(), 403, "a user without sandbox::settings::manage");
}

/// Without the local API key the lock refuses the request before the route
/// (403), whatever the token.
#[tokio::test]
async fn a_setup_without_the_local_api_key_is_refused() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let before = stack(&server, &token).await;
    let resp = reqwest::Client::new()
        .post(server.api_url("/sandbox/wsl/setup"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("post setup");
    assert_eq!(resp.status().as_u16(), 403, "no key");
    assert_eq!(stack(&server, &token).await, before, "the refused setup changed nothing");
}
