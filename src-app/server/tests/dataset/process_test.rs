//! ITEM-18 / Wave-4 — `POST /datasets/{id}/process`: running a processor on a
//! dataset creates an owner/dataset-scoped `analysis` job (NO project), resolves the
//! dataset's txresbench-file file(s) into `dataset_file_ref` sandbox inputs, and — when
//! that run finalizes — its outputs ingest into the working store with
//! `artifacts.dataset_id` set (ITEM-23). The sandbox EXECUTION is stubbed the way
//! the workstore ingest tests do (a hand-written `/outputs/manifest.json` fed to
//! the REAL `ingest_run_outputs`), so no rootfs is required.

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::workstore::ingest::ingest_run_outputs;
use txresbench::modules::workstore::object_store::LocalFsStore;

use super::setup_admin;
use crate::common::TestServer;

/// A pool against the spawned server's per-test DB (for the `jobs.dataset_id` +
/// artifact-scope assertions the REST surface has no endpoint for).
async fn pool_for(server: &TestServer) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(2)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// A store rooted at the SERVER's workstore blob dir (mirrors the workstore tests).
fn server_store(server: &TestServer) -> LocalFsStore {
    LocalFsStore::new(server.data_dir().join("workstore"))
}

/// Upload one file → one dataset; returns `(dataset_id, file_id, filename)`.
async fn upload_one(server: &TestServer, token: &str, filename: &str) -> (Uuid, Uuid, String) {
    let form = Form::new().part(
        "file",
        Part::bytes(b"cell,gene_a\ncell_1,3\n".to_vec()).file_name(filename.to_string()),
    );
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload");
    assert_eq!(resp.status().as_u16(), 200, "upload succeeds");
    let body: Value = resp.json().await.expect("upload json");
    let ds = &body["datasets"][0];
    let dataset_id = Uuid::parse_str(ds["id"].as_str().unwrap()).unwrap();
    let file_id = Uuid::parse_str(ds["files"][0]["file_id"].as_str().unwrap()).unwrap();
    (dataset_id, file_id, filename.to_string())
}

/// The main path: process a dataset → a dataset-scoped analysis job whose params
/// carry the resolved `dataset_file_ref` input; then a run of that scope ingests
/// outputs tagged with `dataset_id`.
#[tokio::test]
async fn process_creates_dataset_scoped_job_and_ingest_tags_dataset_id() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (dataset_id, file_id, filename) = upload_one(&server, &admin, "PBMC_donor1.csv").await;

    // Run a processor on the dataset (an inline python spec; the endpoint appends
    // the dataset file as a `dataset_file_ref` input).
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/process")))
        .bearer_auth(&admin)
        .json(&json!({
            "spec": { "language": "python", "script": "print('qc')" }
        }))
        .send()
        .await
        .expect("process");
    assert_eq!(resp.status().as_u16(), 201, "process enqueues a job");
    let job: Value = resp.json().await.expect("job json");
    let job_id = Uuid::parse_str(job["id"].as_str().unwrap()).unwrap();
    assert_eq!(job["job_type"], "analysis", "an analysis job");

    let pool = pool_for(&server).await;

    // The job is DATASET-scoped (ITEM-68): its scope lives in `job_scope`, not a
    // jobs column. Assert exactly one dataset-scoped row (and no project scope).
    let scoped: Option<(String, Uuid)> =
        sqlx::query_as("SELECT scope_kind, scope_id FROM job_scope WHERE job_id = $1")
            .bind(job_id)
            .fetch_optional(&pool)
            .await
            .expect("job_scope row");
    assert_eq!(
        scoped,
        Some(("dataset".to_string(), dataset_id)),
        "the job is dataset-scoped (no project scope)"
    );

    // The persisted analysis spec resolved the dataset's file into a
    // `dataset_file_ref` input (single-file dataset → slot 'dataset', basename subpath).
    let detail: Value = server
        .client
        .get(server.api_url(&format!("/jobs/{job_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get job")
        .json()
        .await
        .expect("job detail");
    let inputs = detail["job"]["params"]["inputs"]
        .as_array()
        .expect("inputs array");
    assert_eq!(inputs.len(), 1, "one resolved dataset input");
    assert_eq!(
        inputs[0]["dataset_file_ref"],
        file_id.to_string(),
        "resolved the dataset's file id"
    );
    assert_eq!(inputs[0]["slot"], "dataset");
    assert_eq!(
        inputs[0]["sandbox_subpath"], filename,
        "bound at the file's basename"
    );

    // Simulate the run finalizing: stage an `/outputs/manifest.json` + a file, then
    // drive the REAL working-store ingest with the DATASET scope (project_id=None,
    // dataset_id=Some) — exactly the scope `WorkstoreIngestSink` resolves for this
    // job. The produced artifact must carry `dataset_id` (and NO project_id).
    let store = server_store(&server);
    let ws = server
        .data_dir()
        .join(format!("proc-staging-{}", Uuid::new_v4()));
    let outputs = ws.join("outputs");
    tokio::fs::create_dir_all(&outputs).await.unwrap();
    let manifest = json!({ "outputs": [
        { "id": "expression", "datatype": "report/html", "path": "expr.html", "layout": "opaque", "role": "artifact",
          // ITEM-5/6: required, no serde default. This literal bypasses `OutSpec`, which
          // is why it drifted when the contract changed.
          "structure": { "encoding": "opaque", "media_type": "text/html" }, "meta": {} }
    ]});
    tokio::fs::write(
        outputs.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .await
    .unwrap();
    tokio::fs::write(outputs.join("expr.html"), b"<html>expr</html>")
        .await
        .unwrap();

    let run_id = Uuid::new_v4();
    let rows = ingest_run_outputs(&pool, &store, None, Some(dataset_id), run_id, None, &ws)
        .await
        .expect("dataset-scoped ingest");
    assert_eq!(rows.len(), 1, "one catalog row for the declared output");
    assert_eq!(
        rows[0].dataset_id,
        Some(dataset_id),
        "artifact carries the dataset scope"
    );
    assert!(
        rows[0].project_id.is_none(),
        "a dataset-scoped artifact has no project_id"
    );
    assert!(
        rows[0].content_hash.starts_with("sha256:"),
        "blob hash stamped"
    );
}

/// Gating + validation: a foreign/nonexistent dataset → 404; an empty dataset →
/// 422; a malformed processor spec → 400.
#[tokio::test]
async fn process_gates_visibility_and_validates() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Nonexistent dataset → 404 (no existence oracle).
    let ghost = Uuid::new_v4();
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{ghost}/process")))
        .bearer_auth(&admin)
        .json(&json!({ "spec": { "language": "python", "script": "print('x')" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        404,
        "a foreign/nonexistent dataset → 404"
    );

    // A metadata-only dataset (no files) → 422.
    let empty: Value = server
        .client
        .post(server.api_url("/datasets"))
        .bearer_auth(&admin)
        .json(&json!({ "name": "empty" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let empty_id = empty["id"].as_str().unwrap();
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{empty_id}/process")))
        .bearer_auth(&admin)
        .json(&json!({ "spec": { "language": "python", "script": "print('x')" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 422, "a dataset with no files → 422");

    // A dataset WITH a file but a malformed spec (neither script nor code_ref) → 400.
    let (ds_id, _file_id, _name) = upload_one(&server, &admin, "x.csv").await;
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{ds_id}/process")))
        .bearer_auth(&admin)
        .json(&json!({ "spec": { "language": "python" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        400,
        "a spec with no script/code_ref → 400"
    );

    // Unauthenticated → 401.
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{ds_id}/process")))
        .json(&json!({ "spec": { "language": "python", "script": "print('x')" } }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 401, "unauthenticated → 401");
}
