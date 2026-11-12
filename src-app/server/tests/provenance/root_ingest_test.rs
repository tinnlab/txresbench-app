//! TEST-19 — the dataset `set_uploaded` path records a root reference (kind
//! 'upload') carrying the blob's content_hash + name, so every backward walk
//! terminates at a checksummed upload root.

use super::*;

use txresbench::modules::workstore::object_store::sha256_hex;

#[tokio::test]
async fn dataset_upload_records_a_hashed_upload_root() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Create the dataset then upload a matrix blob (the real txresbench-file path).
    let ds: Value = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&admin)
        .json(&json!({ "name": "PBMC 3k", "description": "root ingest" }))
        .send()
        .await
        .expect("create dataset")
        .json()
        .await
        .expect("dataset json");
    let dataset_id = ds["id"].as_str().expect("dataset id").to_string();

    let matrix = b"cell,gene_a,gene_b\ncell_1,3,7\ncell_2,0,4\n".to_vec();
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(matrix.clone()).file_name("matrix.csv"),
    );
    let up = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/upload")))
        .bearer_auth(&admin)
        .multipart(form)
        .send()
        .await
        .expect("upload");
    assert_eq!(up.status().as_u16(), 200, "upload succeeds");

    // The upload recorded a global (project_id NULL) 'upload' reference root
    // carrying the blob's checksummed content identity + the filename.
    let expected_hash = format!("sha256:{}", sha256_hex(&matrix));
    let pool = pool_for(&server).await;
    let row = sqlx::query_as::<_, (String, String, Option<Uuid>)>(
        "SELECT kind, name, project_id FROM provenance_reference_resources WHERE content_hash = $1",
    )
    .bind(&expected_hash)
    .fetch_one(&pool)
    .await
    .expect("upload root reference row exists");
    assert_eq!(row.0, "upload", "kind is 'upload'");
    assert_eq!(row.1, "matrix.csv", "carries the uploaded filename");
    assert!(row.2.is_none(), "an upload root is a deployment-global reference");
}
