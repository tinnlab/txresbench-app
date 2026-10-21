//! TEST-2 [acceptance] [INV-2] — the geneset KIND exercised through the generic draftable
//! lifecycle: a `geneset/collection` draft is a mutable, project-scoped NON-artifact whose
//! opaque `data` round-trips create → edit (PUT) → get, with NO artifact minted until an
//! explicit freeze. This is the geneset-kind proof of INV-2; the kind-agnostic lifecycle
//! mechanics live in `tests/drafts/` (DEC-8), but the plan requires a geneset-kind roundtrip
//! here rather than only delegating (LEDGER: INV-2 in-diff coverage).
//!
//! Rootfs-FREE: freezing (which runs the producer in the sandbox) is covered by
//! `freeze_test.rs`; this asserts only the pre-freeze draft CRUD, so it EXECUTES everywhere.

use serde_json::{json, Value};

use crate::common::TestServer;
use crate::drafts::{create_draft, create_project, create_user, login, setup_admin};

const KIND: &str = "geneset/collection";

fn body(name: &str, genes: &[&str]) -> Value {
    json!({
        "name": name,
        "default_kind": "celltype-markers",
        "sets": [ { "name": "T cells", "kind": "celltype-markers", "genes": genes, "origin": "manual" } ]
    })
}

/// Create → GET → edit (PUT) → GET: the opaque geneset `data` round-trips verbatim and NO
/// artifact is minted before freeze (`frozen_artifact_id` stays null, `status` stays `open`).
#[tokio::test]
async fn geneset_draft_data_roundtrips_without_an_artifact() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "alice", "alice@x.test").await;
    let alice = login(&server, "alice").await;
    let project = create_project(&server, &alice, "Atlas").await;

    // Create — a geneset/collection draft is created (201) as a non-artifact.
    let created = create_draft(
        &server,
        &alice,
        &project,
        KIND,
        body("PBMC", &["CD3D", "CD3E"]),
    )
    .await;
    let id = created["id"].as_str().expect("draft id").to_string();
    assert_eq!(created["kind"], json!(KIND), "kind carried opaquely");
    assert_eq!(created["status"], json!("open"), "a fresh draft is open");
    assert!(
        created["frozen_artifact_id"].is_null(),
        "no artifact is minted before freeze: {created}"
    );
    assert_eq!(
        created["data"]["sets"][0]["genes"],
        json!(["CD3D", "CD3E"]),
        "opaque data round-trips on create"
    );

    // GET — the row reads back with the same opaque data.
    let got: Value = server
        .client
        .get(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("get draft")
        .json()
        .await
        .expect("draft json");
    assert_eq!(
        got["data"]["name"],
        json!("PBMC"),
        "GET returns the stored data"
    );

    // Edit (PUT) — a jsonb data replace; still no artifact, still open.
    let edited: Value = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": body("PBMC v2", &["CD3D", "CD8A", "IL7R"]) }))
        .send()
        .await
        .expect("put draft")
        .json()
        .await
        .expect("draft json");
    assert_eq!(
        edited["status"],
        json!("open"),
        "an edit keeps the draft open"
    );
    assert!(
        edited["frozen_artifact_id"].is_null(),
        "editing mints no artifact (freeze does): {edited}"
    );
    assert_eq!(
        edited["data"]["sets"][0]["genes"],
        json!(["CD3D", "CD8A", "IL7R"]),
        "the edit replaced the opaque data"
    );

    // GET after edit — the new data persisted.
    let refetched: Value = server
        .client
        .get(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("get draft")
        .json()
        .await
        .expect("draft json");
    assert_eq!(
        refetched["data"]["name"],
        json!("PBMC v2"),
        "the edit persisted across a reload"
    );
}
