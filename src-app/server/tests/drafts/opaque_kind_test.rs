//! TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-9] — a second,
//! fictitious `kind` with an arbitrary `data` shape round-trips through create → get
//! → update unchanged; core never branches on the `kind` value nor parses `data`.
//!
//! The freeze half of INV-1 (an opaque `kind` producing a frozen artifact the core
//! never inspects) is sandbox-tier — see `freeze_note`. This pins the storage +
//! serialization half: a `kind` core has no manifest for, and a deeply-nested `data`
//! blob, survive the write path byte-for-byte.

use serde_json::json;

use super::*;
use crate::common::TestServer;

#[tokio::test]
async fn a_fictitious_opaque_kind_round_trips_unchanged() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;

    // A `kind` no package declares (core has no manifest for it) and an arbitrary,
    // deeply-nested `data` shape. Core stores + serves both opaquely (INV-1).
    let weird_kind = "test/xyzzy-1234";
    let weird_data = json!({
        "nested": { "a": [1, 2, {"b": true}], "s": "λ ünïcode ✓" },
        "num": 42.5,
        "null_ok": null,
        "arr": [[], [{}], [null]]
    });

    let created = create_draft(&server, &alice, &project, weird_kind, weird_data.clone()).await;
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["kind"], json!(weird_kind), "kind stored verbatim");
    assert_eq!(
        created["data"], weird_data,
        "data stored verbatim (never parsed)"
    );

    // GET round-trips both unchanged.
    let g: serde_json::Value = server
        .client
        .get(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(g["kind"], json!(weird_kind));
    assert_eq!(g["data"], weird_data);

    // A DIFFERENT fictitious kind coexists (core does not conflate kinds).
    let other = create_draft(
        &server,
        &alice,
        &project,
        "test/another-99",
        json!([1, 2, 3]),
    )
    .await;
    assert_eq!(other["data"], json!([1, 2, 3]));

    // Update replaces the opaque blob with a completely different shape — still verbatim.
    let new_shape = json!("a bare string is valid jsonb too");
    let u: serde_json::Value = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": new_shape }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        u["data"], new_shape,
        "an arbitrary replacement shape round-trips"
    );
    assert_eq!(
        u["kind"],
        json!(weird_kind),
        "kind is immutable across edits"
    );
}
