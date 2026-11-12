//! TEST-2 [ITEM-1] — dataset entity CRUD, owner-scoped: create/list-mine/get/
//! rename/delete; a foreign owner 404s; a promoted dataset's `source='promote'` +
//! `source_artifact_id` round-trip (the schema ITEM-1 owns — the promote endpoint
//! itself is ITEM-7, so the promote row is seeded via SQL here).

use serde_json::{json, Value};

use super::{create_user, login, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn crud_is_owner_scoped() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "ann", "ann@x.test").await;
    let ann = login(&server, "ann").await;
    create_user(&server, &admin, "bob", "bob@x.test").await;
    let bob = login(&server, "bob").await;

    // Create (owner = ann).
    let resp = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&ann)
        .json(&json!({ "name": "PBMC 3k", "datatype": "single-cell/anndata" }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 201, "create");
    let ds: Value = resp.json().await.unwrap();
    let id = ds["id"].as_str().unwrap().to_string();
    assert_eq!(ds["datatype"], json!("single-cell/anndata"));
    assert_eq!(ds["source"], json!("upload"));
    assert!(ds["source_artifact_id"].is_null());
    assert!(
        ds["content_hash"].is_null(),
        "no files yet → no content_hash"
    );

    // list-mine returns ann's dataset.
    let mine: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(&ann)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        mine["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["id"] == json!(id)),
        "in ann's library"
    );

    // bob does NOT see ann's dataset in his library, and get → 404.
    let bob_mine: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        bob_mine["items"].as_array().unwrap().is_empty(),
        "bob owns nothing"
    );
    let bob_get = server
        .client
        .get(server.api_url(&format!("/datasets/{id}")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(bob_get.status().as_u16(), 404, "foreign get → 404");

    // ann's get returns the dataset + (empty) files.
    let get: Value = server
        .client
        .get(server.api_url(&format!("/datasets/{id}")))
        .bearer_auth(&ann)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(get["id"], json!(id));
    assert_eq!(get["files"].as_array().unwrap().len(), 0);

    // bob cannot rename or delete ann's dataset → 404.
    let bob_rename = server
        .client
        .put(server.api_url(&format!("/datasets/{id}")))
        .bearer_auth(&bob)
        .json(&json!({"name":"hax"}))
        .send()
        .await
        .unwrap();
    assert_eq!(bob_rename.status().as_u16(), 404, "foreign rename → 404");
    let bob_delete = server
        .client
        .delete(server.api_url(&format!("/datasets/{id}")))
        .bearer_auth(&bob)
        .send()
        .await
        .unwrap();
    assert_eq!(bob_delete.status().as_u16(), 404, "foreign delete → 404");

    // ann renames.
    let renamed: Value = server
        .client
        .put(server.api_url(&format!("/datasets/{id}")))
        .bearer_auth(&ann)
        .json(&json!({"name":"PBMC renamed"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(renamed["name"], json!("PBMC renamed"));

    // ann deletes (DELETE → 204 No Content).
    let del = server
        .client
        .delete(server.api_url(&format!("/datasets/{id}")))
        .bearer_auth(&ann)
        .send()
        .await
        .unwrap();
    assert_eq!(del.status().as_u16(), 204);
    let after: Value = server
        .client
        .get(server.api_url("/datasets"))
        .bearer_auth(&ann)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(after["items"].as_array().unwrap().is_empty(), "deleted");
}

#[tokio::test]
async fn promote_source_columns_round_trip() {
    // ITEM-1's schema must carry a promote's provenance (source='promote' +
    // source_artifact_id). Promote (ITEM-7) is not in this backbone, so the row is
    // seeded directly and read back through the owner-scoped GET.
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let cid = create_user(&server, &admin, "cara", "cara@x.test").await;
    let cara = login(&server, "cara").await;
    let cid_uuid = uuid::Uuid::parse_str(&cid).expect("cara id is a uuid");

    let dataset_id = uuid::Uuid::new_v4();
    let artifact_id = uuid::Uuid::new_v4();
    let pool = sqlx::SqlitePool::connect(server.database_url()).await.unwrap();
    // A2: `datasets.account_id` is NOT NULL. This raw seed bypasses the repository
    // (the promote endpoint is ITEM-7), so ensure the owner's personal account and
    // stamp it — the same value the repository's `create_promoted` would stamp.
    txresbench::modules::account::scope::ensure_personal_account_for(
        &pool,
        cid_uuid,
    )
    .await
    .expect("ensure cara's personal account");
    sqlx::query(
        "INSERT INTO datasets (id, name, owner_id, account_id, datatype, source, source_artifact_id, content_hash)
         VALUES ($1, $2, $3, (SELECT id FROM accounts WHERE kind='personal' AND personal_user_id = $3), $4, 'promote', $5, $6)",
    )
    .bind(dataset_id)
    .bind("PBMC filtered")
    .bind(cid_uuid)
    .bind("single-cell/expression")
    .bind(artifact_id)
    .bind("sha256:deadbeef")
    .execute(&pool)
    .await
    .expect("seed promote row");

    let get: Value = server
        .client
        .get(server.api_url(&format!("/datasets/{dataset_id}")))
        .bearer_auth(&cara)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(get["source"], json!("promote"));
    assert_eq!(get["source_artifact_id"], json!(artifact_id.to_string()));
    assert_eq!(get["content_hash"], json!("sha256:deadbeef"));
}
