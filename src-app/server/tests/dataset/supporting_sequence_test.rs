//! TEST-22 [ITEM-20] — the Phase-A conversion DAG for a primary+supporting upload.
//!
//! A combined upload (a primary `.h5ad` + one axis-tagged supporting annotation)
//! enqueues the primary IMPORT job PLUS one integrate child per supporting file,
//! each born `blocked` and `depends_on` the import (asserted straight from the DB —
//! `job_dependencies` + `job_scope` + status), with each supporting
//! `dataset_files.integration_status='pending'`. When the import FAILS, every
//! supporting child CASCADES to `failed` (`dependency_failed`) and never runs —
//! the main-file-failed ⇒ all-supporting-fail rule (ITEM-19/20).
//!
//! No rootfs: the enqueue + DAG wiring is synchronous in the upload handler, and
//! the failure is driven via the repo — the sandboxed import/align execution is
//! the rootfs-gated path exercised elsewhere.

use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::jobs::repository::JobRepository;

use super::hardening_common::pool_for;
use super::setup_admin;
use crate::common::TestServer;

const H5AD_BYTES: &[u8] = b"\x89HDF\r\n\x1a\n fake anndata payload for supporting-sequence test";
const ANNOTATION_CSV: &[u8] = b"barcode,cluster\nAAACCCAAGAAACACT,0\nAAACCCACAGAAACAC,1\n";

async fn status_of(pool: &SqlitePool, id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read job status")
}

async fn name_of(pool: &SqlitePool, id: Uuid) -> String {
    sqlx::query_scalar("SELECT name FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("read job name")
}

async fn poll_status(pool: &SqlitePool, id: Uuid, wanted: &str, timeout: Duration) -> String {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let s = status_of(pool, id).await;
        if s == wanted {
            return s;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("job {id} did not reach {wanted} within {timeout:?} (last = {s})");
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

#[tokio::test]
async fn primary_plus_supporting_upload_chains_integrate_on_import_and_cascades_on_failure() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Combined upload: a primary `.h5ad` (index 0) + one supporting annotation CSV
    // (index 1, axis `cells`).
    let form = Form::new()
        .part(
            "file",
            Part::bytes(H5AD_BYTES.to_vec()).file_name("pbmc.h5ad"),
        )
        .part(
            "file",
            Part::bytes(ANNOTATION_CSV.to_vec()).file_name("clusters.csv"),
        )
        .text(
            "supporting",
            json!([{ "index": 1, "axis": "cells" }]).to_string(),
        );
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&admin)
        .multipart(form)
        .send()
        .await
        .expect("combined upload");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "combined primary+supporting upload succeeds"
    );
    let body: Value = resp.json().await.expect("upload json");
    let datasets = body["datasets"].as_array().expect("datasets array");
    assert_eq!(
        datasets.len(),
        1,
        "the supporting file folds onto the ONE primary dataset"
    );
    let ds_id = Uuid::parse_str(datasets[0]["id"].as_str().expect("dataset id")).unwrap();

    // The supporting file is linked role=supporting and POINTS at its integrate job
    // (`integration_job_id`) — the single source of truth its per-file status derives
    // from (no longer a hand-set `integration_status` column, which never advanced).
    let (support_role, support_job): (String, Option<Uuid>) = sqlx::query_as(
        "SELECT role, integration_job_id FROM dataset_files WHERE dataset_id = $1 AND role = 'supporting'",
    )
    .bind(ds_id)
    .fetch_one(&pool)
    .await
    .expect("a supporting dataset_files row");
    assert_eq!(support_role, "supporting");
    assert!(
        support_job.is_some(),
        "the supporting file points at its integrate job"
    );

    // The DAG edge: the integrate child `depends_on` the import job (both dataset-
    // scoped via `job_scope`, NOT a jobs.dataset_id column). Read straight from the
    // DB — the exact structural proof of the Phase-A chain.
    let (integrate_id, import_id): (Uuid, Uuid) = sqlx::query_as(
        "SELECT jd.job_id, jd.depends_on_job_id \
         FROM job_dependencies jd \
         JOIN job_scope s ON s.job_id = jd.job_id \
         WHERE s.scope_kind = 'dataset' AND s.scope_id = $1",
    )
    .bind(ds_id)
    .fetch_one(&pool)
    .await
    .expect("exactly one integrate→import dependency edge for the dataset");

    // Both are dataset-scoped `analysis` jobs; names disambiguate the roles.
    let import_scope: (String, Uuid) =
        sqlx::query_as("SELECT scope_kind, scope_id FROM job_scope WHERE job_id = $1")
            .bind(import_id)
            .fetch_one(&pool)
            .await
            .expect("import job_scope row");
    assert_eq!(
        import_scope,
        ("dataset".to_string(), ds_id),
        "the import is dataset-scoped"
    );
    assert!(
        name_of(&pool, import_id).await.starts_with("Convert "),
        "the parent is the import/convert job"
    );
    assert!(
        name_of(&pool, integrate_id).await.starts_with("Integrate "),
        "the child is the integrate job"
    );

    // The integrate child is born `blocked` — observable while the import has not yet
    // terminalized (the background scheduler cannot complete an analysis import with
    // no rootfs, so this reliably holds right after the synchronous enqueue).
    if !matches!(
        status_of(&pool, import_id).await.as_str(),
        "completed" | "failed" | "stopped"
    ) {
        assert_eq!(
            status_of(&pool, integrate_id).await,
            "blocked",
            "the integrate child is blocked on the import"
        );
        // …and the DERIVED per-file status (blocked integrate job → 'pending') is what
        // the detail view surfaces (proves the job-derived status wiring).
        if status_of(&pool, integrate_id).await == "blocked" {
            let detail: Value = server
                .client
                .get(server.api_url(&format!("/datasets/{ds_id}")))
                .bearer_auth(&admin)
                .send()
                .await
                .expect("get dataset")
                .json()
                .await
                .expect("detail json");
            let support = detail["files"]
                .as_array()
                .expect("files array")
                .iter()
                .find(|f| f["role"] == "supporting")
                .expect("a supporting file");
            assert_eq!(
                support["integration_status"],
                json!("pending"),
                "a blocked integrate job derives integration_status='pending'"
            );
        }
    }

    // Simulate the import FAILING via the repo → the supporting child cascades.
    // (A no-op if the scheduler already failed the rootfs-less import; the cascade
    // then already fired — either way the child ends failed/dependency_failed.)
    JobRepository::new(pool.clone())
        .fail(import_id, "simulated import failure")
        .await
        .expect("fail the import job");

    poll_status(&pool, integrate_id, "failed", Duration::from_secs(20)).await;
    let (err, started): (Option<String>, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT error, started_at FROM jobs WHERE id = $1")
            .bind(integrate_id)
            .fetch_one(&pool)
            .await
            .expect("read integrate terminal row");
    assert_eq!(
        err.as_deref(),
        Some("dependency_failed"),
        "the child cascaded (dependency_failed)"
    );
    assert!(
        started.is_none(),
        "the cascaded integrate child NEVER ran (cascade, not self-failure)"
    );
}
