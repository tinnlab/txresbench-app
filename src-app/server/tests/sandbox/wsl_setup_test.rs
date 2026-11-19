//! `POST /api/sandbox/wsl/setup` on a machine with nothing to set up (any
//! system but a Windows PC whose WSL is missing or too old): 409
//! `WSL_SETUP_NOT_OFFERED`, and nothing changes. The setup itself (the offer,
//! one at a time, the result) is unit-tested in `sandbox::wsl_setup` behind
//! its seam.
//!
//! On a Windows PC that IS offered a setup (WSL missing or too old, like the
//! test VM), a POST would really install or update WSL as administrator: the
//! test checks what the notice reads there and skips the POST (recorded).

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
