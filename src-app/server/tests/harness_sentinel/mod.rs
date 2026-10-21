//! The harness WORKTREE SENTINEL, asserted against a REALLY BOOTED SERVER.
//!
//! ## Why this exists as an integration test and not a unit test
//!
//! `harness_sentinel`'s in-source tests drive `install()` directly, so they prove the
//! route works — and they say NOTHING about whether `build_app` still calls it. That
//! gap is not hypothetical: deleting the `harness_sentinel::install(app)` line from
//! `lib.rs` was mutated in and SURVIVED the whole unit suite. A guard on the thing
//! being installed is not a guard on the installation.
//!
//! The failure that mutation produces is also the expensive kind. The route simply is
//! not there, so the full-backend Playwright tier's pre-flight classifies its own
//! backend as `unidentified` and refuses the run with a banner about somebody else's
//! server — a correct refusal for an incorrect reason, and a long way from the deleted
//! line. This test puts the kill next to the cause.
//!
//! It asserts what the NODE side actually parses (`harness-origin.mjs::classifyOrigin`
//! reads `worktreeRoot`), at the ROOT path it actually fetches.

use serde_json::Value;

use crate::common::TestServer;

#[tokio::test]
async fn booted_server_identifies_its_worktree_at_the_root_sentinel() {
    let server = TestServer::spawn().await;

    // Unauthenticated, exactly as the pre-flight asks it: the harness must be able to
    // establish provenance before it holds any credential.
    let resp = server
        .client
        .get(server.root_url("/__worktree"))
        .send()
        .await
        .expect("GET /__worktree");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "the booted app router must serve the sentinel — if this is 404, `build_app` \
         stopped calling `harness_sentinel::install`, and the e2e tier will refuse its \
         own backend as 'a server that will not identify itself'"
    );

    let body: Value = resp.json().await.expect("sentinel json");
    assert_eq!(
        body["worktreeRoot"].as_str(),
        Some(cytoanalyst::harness_sentinel::WORKTREE_ROOT),
        "the served root must be the tree this binary was compiled from"
    );
    assert!(body["pid"].as_u64().is_some(), "pid is part of the banner");

    // And it is NOT under the /api prefix: the Node probe fetches the root path, and a
    // sentinel only reachable at /api/__worktree would be invisible to every consumer.
    let api = server
        .client
        .get(server.api_url("/__worktree"))
        .send()
        .await
        .expect("GET /api/__worktree");
    assert_eq!(api.status().as_u16(), 404, "the sentinel lives at the ROOT path only");
}
