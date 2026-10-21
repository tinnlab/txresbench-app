//! TEST-1/3/4/6 [acceptance] — freezing a `geneset/collection` draft through the REAL seeded
//! `geneset` package mints an immutable `geneset/collection` artifact whose per-set metadata
//! carries kind/origin/data_driven (INV-3/4/5), and an edit forks a NEW artifact (INV-1/2/6).
//!
//! Runs the freeze producer through the analysis sandbox — gated by `rootfs_gate`. A runtime
//! dependency gate (via `record_skip`, never a compile-time attribute) fires when the sandbox
//! genuinely cannot execute, naming the blocker (point `CYTO_ENV_ROOTFS_SQUASHFS` at the
//! single-cell schema5 squashfs). With the rootfs staged, the suite EXECUTES — no gate fires.

use serde_json::json;

use crate::common::TestServer;
use crate::dataset::hardening_common::{record_skip, rootfs_gate};
use crate::drafts::{create_project, create_user, login, setup_admin, wait_frozen};

const KIND: &str = "geneset/collection";

/// POST the freeze; returns `(status, body)`.
async fn freeze(server: &TestServer, token: &str, draft_id: &str) -> (u16, serde_json::Value) {
    let resp = server
        .client
        .post(server.api_url(&format!("/drafts/{draft_id}/freeze")))
        .bearer_auth(token)
        .send()
        .await
        .expect("freeze");
    let status = resp.status().as_u16();
    let body = resp.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

/// Create a geneset/collection draft with the given opaque `data` body.
async fn create_collection_draft(
    server: &TestServer,
    token: &str,
    project_id: &str,
    data: serde_json::Value,
) -> String {
    let resp = server
        .client
        .post(server.api_url("/drafts"))
        .bearer_auth(token)
        .json(&json!({ "kind": KIND, "project_id": project_id, "data": data }))
        .send()
        .await
        .expect("create draft");
    assert_eq!(resp.status().as_u16(), 201, "create geneset draft");
    let body: serde_json::Value = resp.json().await.expect("draft json");
    body["id"].as_str().expect("draft id").to_string()
}

/// Create a geneset/collection FORK draft — a BRAND-NEW draft carrying `parent_frozen_artifact_id`,
/// exactly as the FE `draft.editFork` does when the frozen-view "Edit → new version" is used (a new
/// draft seeded from the frozen structure, NOT a PUT-reopen of the source draft). Returns its id.
async fn create_fork_draft(
    server: &TestServer,
    token: &str,
    project_id: &str,
    parent_artifact_id: &str,
    data: serde_json::Value,
) -> (u16, serde_json::Value) {
    let resp = server
        .client
        .post(server.api_url("/drafts"))
        .bearer_auth(token)
        .json(&json!({
            "kind": KIND,
            "project_id": project_id,
            "data": data,
            "parent_frozen_artifact_id": parent_artifact_id,
        }))
        .send()
        .await
        .expect("create fork draft");
    let status = resp.status().as_u16();
    let body = resp.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

/// GET a frozen artifact's version lineage chain (INV-7).
async fn get_lineage(server: &TestServer, token: &str, artifact_id: &str) -> serde_json::Value {
    server
        .client
        .get(server.api_url(&format!("/drafts/artifacts/{artifact_id}/lineage")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get lineage")
        .json()
        .await
        .expect("lineage json")
}

/// GET a frozen artifact → its catalog row (carries `datatype` + producer-declared `structure`).
async fn get_artifact(server: &TestServer, token: &str, id: &str) -> serde_json::Value {
    server
        .client
        .get(server.api_url(&format!("/artifacts/{id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get artifact")
        .json()
        .await
        .expect("artifact json")
}

/// Env: admin + alice (holds drafts::use via the Users group) + a project + the rootfs gate.
async fn ready_env(server: &TestServer, test: &str) -> Result<(String, String), ()> {
    let admin = setup_admin(server).await;
    create_user(server, &admin, "alice", "alice@x.test").await;
    let alice = login(server, "alice").await;
    let project = create_project(server, &alice, "Atlas").await;
    if rootfs_gate(server, &admin).await.is_none() {
        record_skip(
            test,
            "the analysis sandbox rootfs is not runnable here — the freeze runs the geneset \
             producer through the sandbox. Point CYTO_ENV_ROOTFS_SQUASHFS at the single-cell \
             schema5 rootfs.squashfs (+ unprivileged userns + bwrap + squashfuse) to run it.",
        );
        return Err(());
    }
    Ok((alice, project))
}

fn draft_body() -> serde_json::Value {
    json!({
        "name": "PBMC markers",
        "default_kind": "celltype-markers",
        "sets": [
            { "name": "T cells", "kind": "celltype-markers", "genes": ["CD3D", "CD3E", "IL7R"], "origin": "manual" },
            { "name": "NK signature", "kind": "signatures", "genes": ["NKG7", "GNLY"], "origin": "de-derived:abc", "data_driven": true }
        ]
    })
}

/// TEST-1/3/4 — freeze mints a geneset/collection whose per-set metadata carries kind/origin/
/// data_driven.
#[tokio::test]
async fn freeze_mints_geneset_collection_with_per_set_metadata() {
    let server = TestServer::spawn().await;
    let Ok((alice, project)) = ready_env(&server, "TEST-1/3/4").await else {
        return;
    };
    let id = create_collection_draft(&server, &alice, &project, draft_body()).await;

    let (status, body) = freeze(&server, &alice, &id).await;
    assert_eq!(status, 202, "freeze accepted (background): {body}");
    assert!(
        body["freeze_job_id"].is_string(),
        "a real freeze enqueues a producer job: {body}"
    );

    let frozen = wait_frozen(&server, &alice, &id).await;
    let artifact_id = frozen["frozen_artifact_id"]
        .as_str()
        .expect("frozen_artifact_id links the minted artifact")
        .to_string();

    let art = get_artifact(&server, &alice, &artifact_id).await;
    assert_eq!(
        art["datatype"],
        json!("geneset/collection"),
        "the frozen artifact is a geneset/collection: {art}"
    );
    let sets = art["structure"]["sets"]
        .as_array()
        .expect("structure.sets is the per-set metadata");
    assert_eq!(sets.len(), 2, "two sets frozen");
    let by_name: std::collections::HashMap<&str, &serde_json::Value> = sets
        .iter()
        .map(|s| (s["name"].as_str().unwrap(), s))
        .collect();
    // INV-4: kind recorded per set.
    assert_eq!(by_name["T cells"]["kind"], json!("celltype-markers"));
    assert_eq!(by_name["NK signature"]["kind"], json!("signatures"));
    // INV-3/5: origin + data_driven recorded; the data-driven set is flagged.
    assert_eq!(by_name["T cells"]["origin"], json!("manual"));
    assert_eq!(by_name["T cells"]["data_driven"], json!(false));
    assert_eq!(by_name["NK signature"]["data_driven"], json!(true));
    // INV-9: the flag is NOT composed into the human description.
    assert_eq!(by_name["NK signature"]["description"], json!(""));
}

/// TEST-6 [INV-1/2/6] — editing a frozen collection re-opens the draft, and the next freeze forks
/// a NEW artifact; the first artifact's bytes are never mutated.
#[tokio::test]
async fn edit_forks_a_new_version() {
    let server = TestServer::spawn().await;
    let Ok((alice, project)) = ready_env(&server, "TEST-6").await else {
        return;
    };
    let id = create_collection_draft(&server, &alice, &project, draft_body()).await;

    let (s1, _b1) = freeze(&server, &alice, &id).await;
    assert_eq!(s1, 202);
    let frozen1 = wait_frozen(&server, &alice, &id).await;
    let art1 = frozen1["frozen_artifact_id"].as_str().unwrap().to_string();

    // Edit → re-opens the draft (DEC-3) with different membership.
    let edited = json!({
        "name": "PBMC markers",
        "default_kind": "celltype-markers",
        "sets": [
            { "name": "T cells", "kind": "celltype-markers", "genes": ["CD3D", "CD8A"], "origin": "manual" },
            { "name": "NK signature", "kind": "signatures", "genes": ["NKG7", "GNLY"], "origin": "de-derived:abc", "data_driven": true }
        ]
    });
    let put: serde_json::Value = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": edited }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        put["status"],
        json!("open"),
        "an edit re-opens the frozen draft: {put}"
    );

    let (s2, _b2) = freeze(&server, &alice, &id).await;
    assert_eq!(s2, 202);
    let frozen2 = wait_frozen(&server, &alice, &id).await;
    let art2 = frozen2["frozen_artifact_id"].as_str().unwrap().to_string();
    assert_ne!(
        art1, art2,
        "a post-edit freeze forks a NEW immutable artifact (INV-1/2/6)"
    );

    // The FIRST artifact is untouched (retro-mutation impossible).
    let a1 = get_artifact(&server, &alice, &art1).await;
    let t1 = a1["structure"]["sets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == json!("T cells"))
        .unwrap();
    assert_eq!(
        t1["genes"],
        json!(["CD3D", "CD3E", "IL7R"]),
        "the prior version's membership is unchanged"
    );
}

/// TEST-7 (primitive half) [INV-7 / DEC-11] — freezing records version lineage: a first freeze is
/// version 1 with no parent; a re-freeze after an edit forks a NEW artifact stamped
/// `version = 2` + `parent_artifact_id = <the first artifact>`. The prior artifact is unchanged.
#[tokio::test]
async fn freeze_records_version_lineage() {
    let server = TestServer::spawn().await;
    let Ok((alice, project)) = ready_env(&server, "TEST-7").await else {
        return;
    };
    let id = create_collection_draft(&server, &alice, &project, draft_body()).await;

    // First freeze → version 1, no parent.
    assert_eq!(freeze(&server, &alice, &id).await.0, 202);
    let art1 = wait_frozen(&server, &alice, &id).await["frozen_artifact_id"]
        .as_str()
        .unwrap()
        .to_string();

    let chain1 = get_lineage(&server, &alice, &art1).await;
    let c1 = chain1["chain"].as_array().expect("chain array");
    assert_eq!(
        c1.len(),
        1,
        "a first freeze has a one-entry chain: {chain1}"
    );
    assert_eq!(c1[0]["artifact_id"], json!(art1));
    assert_eq!(c1[0]["version"], json!(1), "first freeze is version 1");
    assert_eq!(
        c1[0]["parent_artifact_id"],
        json!(null),
        "a first freeze has no parent"
    );

    // Edit (re-opens the draft) → re-freeze forks a new artifact.
    let edited = json!({
        "name": "PBMC markers",
        "default_kind": "celltype-markers",
        "sets": [
            { "name": "T cells", "kind": "celltype-markers", "genes": ["CD3D", "CD8A"], "origin": "manual" },
            { "name": "NK signature", "kind": "signatures", "genes": ["NKG7", "GNLY"], "origin": "de-derived:abc", "data_driven": true }
        ]
    });
    let put = server
        .client
        .put(server.api_url(&format!("/drafts/{id}")))
        .bearer_auth(&alice)
        .json(&json!({ "data": edited }))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status().as_u16(), 200, "edit re-opens the draft");

    assert_eq!(freeze(&server, &alice, &id).await.0, 202);
    // Wait for the RE-freeze to a DIFFERENT artifact (the first `wait_frozen` may observe the
    // still-frozen art1 briefly; loop until frozen_artifact_id advances).
    let mut art2 = art1.clone();
    for _ in 0..90 {
        let d = wait_frozen(&server, &alice, &id).await;
        let a = d["frozen_artifact_id"].as_str().unwrap().to_string();
        if a != art1 {
            art2 = a;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    }
    assert_ne!(art1, art2, "the re-freeze forked a new artifact");

    // The new artifact's lineage: version 2, parent = art1, then the root (art1, v1).
    let chain2 = get_lineage(&server, &alice, &art2).await;
    let c2 = chain2["chain"].as_array().expect("chain array");
    assert_eq!(
        c2.len(),
        2,
        "the forked version's chain is [v2, v1]: {chain2}"
    );
    assert_eq!(c2[0]["artifact_id"], json!(art2));
    assert_eq!(c2[0]["version"], json!(2), "the re-freeze is version 2");
    assert_eq!(
        c2[0]["parent_artifact_id"],
        json!(art1),
        "the re-freeze's parent is the first artifact"
    );
    assert_eq!(c2[1]["artifact_id"], json!(art1));
    assert_eq!(c2[1]["version"], json!(1));

    // The FIRST artifact's own lineage row is unchanged (still version 1, no parent) — a re-freeze
    // never retro-mutates a past version (INV-1/6).
    let chain1_again = get_lineage(&server, &alice, &art1).await;
    let c1b = chain1_again["chain"].as_array().unwrap();
    assert_eq!(
        c1b.len(),
        1,
        "the first version's chain is still just itself"
    );
    assert_eq!(c1b[0]["version"], json!(1));
    assert_eq!(c1b[0]["parent_artifact_id"], json!(null));
}

/// TEST-7 (real-FE-mechanism, round-3 negative control) [INV-7 / DEC-11] — the frozen-view
/// "Edit → new version" forks a BRAND-NEW draft (`draft.editFork` → POST /drafts with
/// `parent_frozen_artifact_id`), NOT a PUT-reopen of the source draft. This drives that exact path
/// and asserts the lineage chain LINKS (version = 2, parent = the source artifact) — the readout a
/// LineageWidget would render as v2←v1. It FAILS before the editFork-threads-parent fix (a fork
/// draft's `frozen_artifact_id` was NULL, so the freeze hook stamped version = 1 / parent = NULL and
/// the chain never linked in-app), and passes after.
#[tokio::test]
async fn editfork_new_draft_links_version_lineage() {
    let server = TestServer::spawn().await;
    let Ok((alice, project)) = ready_env(&server, "TEST-7-editfork").await else {
        return;
    };

    // A source collection, frozen → art1 (version 1, no parent).
    let source = create_collection_draft(&server, &alice, &project, draft_body()).await;
    assert_eq!(freeze(&server, &alice, &source).await.0, 202);
    let art1 = wait_frozen(&server, &alice, &source).await["frozen_artifact_id"]
        .as_str()
        .unwrap()
        .to_string();

    // "Edit → new version" from the FROZEN view: editFork creates a NEW draft seeded from the
    // frozen structure AND carrying parent_frozen_artifact_id = art1 (the real FE mechanism).
    let forked_body = json!({
        "name": "PBMC markers",
        "default_kind": "celltype-markers",
        "sets": [
            { "name": "T cells", "kind": "celltype-markers", "genes": ["CD3D", "CD8A"], "origin": "manual" },
            { "name": "NK signature", "kind": "signatures", "genes": ["NKG7", "GNLY"], "origin": "de-derived:abc", "data_driven": true }
        ]
    });
    let (fs, fbody) = create_fork_draft(&server, &alice, &project, &art1, forked_body).await;
    assert_eq!(fs, 201, "the fork draft is created: {fbody}");
    let fork_id = fbody["id"].as_str().expect("fork draft id").to_string();
    // A fork draft is BORN pointing at its parent (still `open` — the next freeze forks a version).
    assert_eq!(
        fbody["frozen_artifact_id"],
        json!(art1),
        "the fork draft is born with frozen_artifact_id = the source (the lineage parent): {fbody}"
    );
    assert_eq!(
        fbody["status"],
        json!("open"),
        "a fork draft is open until frozen"
    );

    // Freeze the fork → a NEW artifact whose lineage links back to art1 as version 2.
    assert_eq!(freeze(&server, &alice, &fork_id).await.0, 202);
    let art2 = wait_frozen(&server, &alice, &fork_id).await["frozen_artifact_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_ne!(art1, art2, "the fork's freeze minted a new artifact");

    let chain2 = get_lineage(&server, &alice, &art2).await;
    let c2 = chain2["chain"].as_array().expect("chain array");
    assert_eq!(
        c2.len(),
        2,
        "the editFork'd version links a [v2, v1] chain (the in-app path, not PUT-reopen): {chain2}"
    );
    assert_eq!(c2[0]["artifact_id"], json!(art2));
    assert_eq!(
        c2[0]["version"],
        json!(2),
        "the editFork freeze is version 2"
    );
    assert_eq!(
        c2[0]["parent_artifact_id"],
        json!(art1),
        "the editFork'd version's parent is the source frozen artifact — the chain LINKS"
    );
    assert_eq!(c2[1]["artifact_id"], json!(art1));
    assert_eq!(c2[1]["version"], json!(1));

    // The source version's own row is unchanged (a fork never retro-mutates the parent).
    let c1b = get_lineage(&server, &alice, &art1).await;
    let c1 = c1b["chain"].as_array().unwrap();
    assert_eq!(
        c1.len(),
        1,
        "the source version's chain is still just itself"
    );
    assert_eq!(c1[0]["version"], json!(1));
    assert_eq!(c1[0]["parent_artifact_id"], json!(null));
}
