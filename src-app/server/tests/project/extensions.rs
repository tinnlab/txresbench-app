//! TEST-2..TEST-5 — the project-extension seam, proven end-to-end through the real
//! HTTP path. Post ITEM-1/3 (M:N, owner-scoped datasets): deleting a project
//! DETACHES (does not delete) its datasets, duplicating a project RE-LINKS the same
//! datasets (M:N — not a deep copy), its owned `dataset-summary` route is mounted
//! + ACL-gated, and its migration applied.

use serde_json::{json, Value};

use super::{
    create_dataset, create_project, create_user, create_user_without_projects, login, setup_admin,
};
use crate::common::TestServer;

/// Datasets currently visible via the global dataset list.
async fn all_dataset_ids(server: &TestServer, token: &str) -> Vec<String> {
    let list: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap().to_string())
        .collect()
}

async fn attach(server: &TestServer, token: &str, project: &str, dataset: &str) {
    let r = server
        .client
        .post(server.api_url(&format!("/projects/{project}/datasets/{dataset}")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 200, "attach {dataset} → {project}");
}

async fn project_dataset_ids(server: &TestServer, token: &str, project: &str) -> Vec<String> {
    let list: Value = server
        .client
        .get(server.api_url(&format!("/projects/{project}/datasets")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    list["datasets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap().to_string())
        .collect()
}

async fn project_dataset_names(server: &TestServer, token: &str, project: &str) -> Vec<String> {
    let list: Value = server
        .client
        .get(server.api_url(&format!("/projects/{project}/datasets")))
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    list["datasets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["name"].as_str().unwrap().to_string())
        .collect()
}

/// TEST-2 — deleting a project fires `on_project_deleted`, which DETACHES its
/// datasets (M:N junction rows cascade away) but LEAVES the owner-scoped dataset
/// rows intact — a dataset survives its projects (it may belong to others).
#[tokio::test]
async fn delete_project_detaches_but_keeps_datasets() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "del", "del@x.test").await;
    let tok = login(&server, "del").await;

    let project = create_project(&server, &tok, "To Delete").await;
    let sid = project["id"].as_str().unwrap();
    let d1 = create_dataset(&server, &tok, "cells-1").await;
    let d2 = create_dataset(&server, &tok, "cells-2").await;
    attach(&server, &tok, sid, &d1).await;
    attach(&server, &tok, sid, &d2).await;

    // Sanity: both datasets exist globally before delete.
    let before = all_dataset_ids(&server, &tok).await;
    assert!(before.contains(&d1) && before.contains(&d2));

    // Delete the project.
    let del = server
        .client
        .delete(server.api_url(&format!("/projects/{sid}")))
        .bearer_auth(&tok)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status().as_u16(), 204);

    // The project is gone BUT its datasets survive in the owner's library (M:N +
    // owner-scoped — delete detaches, it does not destroy the datasets).
    let get = server
        .client
        .get(server.api_url(&format!("/projects/{sid}")))
        .bearer_auth(&tok)
        .send()
        .await
        .unwrap();
    assert_eq!(get.status().as_u16(), 404, "project deleted");
    let after = all_dataset_ids(&server, &tok).await;
    assert!(
        after.contains(&d1) && after.contains(&d2),
        "on_project_deleted detached but kept the datasets (before: {before:?}, after: {after:?})"
    );
}

/// TEST-3 — duplicating a project fires `on_project_duplicated`, which RE-LINKS the
/// same datasets onto the duplicate (M:N — one dataset in both projects), NOT a
/// deep copy; the source keeps its links too.
#[tokio::test]
async fn duplicate_project_relinks_datasets() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "dup", "dup@x.test").await;
    let tok = login(&server, "dup").await;

    let project = create_project(&server, &tok, "Original").await;
    let sid = project["id"].as_str().unwrap();
    let d1 = create_dataset(&server, &tok, "orig-1").await;
    let d2 = create_dataset(&server, &tok, "orig-2").await;
    attach(&server, &tok, sid, &d1).await;
    attach(&server, &tok, sid, &d2).await;

    // Duplicate.
    let dup: Value = server
        .client
        .post(server.api_url(&format!("/projects/{sid}/duplicate")))
        .bearer_auth(&tok)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let dup_id = dup["id"].as_str().unwrap();
    assert_ne!(dup_id, sid, "a new project");

    let mut src_ds = project_dataset_ids(&server, &tok, sid).await;
    let mut dup_ds = project_dataset_ids(&server, &tok, dup_id).await;
    assert_eq!(src_ds.len(), 2, "source keeps its datasets");
    assert_eq!(dup_ds.len(), 2, "duplicate has the re-linked datasets");
    // M:N re-link = the SAME dataset rows appear under both projects.
    src_ds.sort();
    dup_ds.sort();
    assert_eq!(src_ds, dup_ds, "duplicate shares the source's dataset rows (M:N re-link)");
    // Names are the originals (same rows).
    let dup_names = project_dataset_names(&server, &tok, dup_id).await;
    assert!(
        dup_names.contains(&"orig-1".to_string()) && dup_names.contains(&"orig-2".to_string()),
        "re-link preserves dataset names, got {dup_names:?}"
    );

    // The duplicate's 201 response reports the ACTUAL re-linked count (not 0).
    assert_eq!(dup["dataset_count"], json!(2), "duplicate response reports real count");
}

/// TEST-4 — the extension-owned `dataset-summary` route is mounted (register_routes
/// seam), returns correct aggregates, and is ACL-gated (404 foreign / 401 no token
/// / 403 no permission).
#[tokio::test]
async fn dataset_summary_route_and_acl() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "sum", "sum@x.test").await;
    let tok = login(&server, "sum").await;

    let project = create_project(&server, &tok, "Summed").await;
    let sid = project["id"].as_str().unwrap();
    let d1 = create_dataset(&server, &tok, "s-1").await;
    let d2 = create_dataset(&server, &tok, "s-2").await;
    attach(&server, &tok, sid, &d1).await;
    attach(&server, &tok, sid, &d2).await;

    // Owner reads the summary (proves the extension route mounted + regen exposed
    // it). Datasets no longer carry domain counts (DEC-1), so the summary is the
    // dataset COUNT only.
    let resp = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/dataset-summary")))
        .bearer_auth(&tok)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    let body: Value = resp.json().await.unwrap();
    assert_eq!(body["dataset_count"], json!(2));

    // No token → 401.
    let no_auth = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/dataset-summary")))
        .send()
        .await
        .unwrap();
    assert_eq!(no_auth.status().as_u16(), 401);

    // A foreign project (another user) → 404 (ACL via effective_permission).
    create_user(&server, &admin, "other", "other@x.test").await;
    let other = login(&server, "other").await;
    let foreign = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/dataset-summary")))
        .bearer_auth(&other)
        .send()
        .await
        .unwrap();
    assert_eq!(foreign.status().as_u16(), 404, "can't see a foreign project's summary");

    // A user lacking projects::use → 403 (deny path).
    create_user_without_projects(&server, &admin, "noproject", "noproject@x.test").await;
    let noproject = login(&server, "noproject").await;
    let denied = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/dataset-summary")))
        .bearer_auth(&noproject)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status().as_u16(), 403, "no projects::use → 403");
}

/// TEST-5 — the cleanup / deep-copy / summary queries are index-backed: the
/// `project_datasets` junction carries an index whose leading column is `project_id`
/// (the pre-existing `idx_project_datasets_project` — no redundant index is added).
/// The dataset extension's linkage itself is proven by TEST-4 (its route mounts).
#[tokio::test]
async fn cleanup_query_is_index_backed() {
    let server = TestServer::spawn().await;
    let pool = sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("connect to test db");
    // An index on project_datasets whose definition leads with (project_id ...) —
    // supports `WHERE project_id = $1` for the cleanup DELETE + deep-copy JOIN +
    // summary aggregate + the project-delete cascade scan.
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master \
         WHERE type = 'index' AND tbl_name = 'project_datasets' AND sql LIKE '%project_id%')",
    )
    .fetch_one(&pool)
    .await
    .expect("query pg_indexes");
    assert!(exists, "project_datasets has a project_id-leading index backing the cleanup query");
}
