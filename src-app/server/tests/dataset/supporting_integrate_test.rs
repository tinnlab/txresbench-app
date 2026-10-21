//! TEST-13 [ITEM-12, ITEM-13, ITEM-14] — `POST /datasets/{id}/supporting-files`
//! ENQUEUES a correctly-WIRED on-integrate job.
//!
//! Adding an `annotation-table` supporting file (axis `cells`) to a single-cell
//! dataset enqueues a dataset-scoped `analysis` job (the generic axis-agnostic
//! `annotation-integrate` kind-processor) whose spec binds EXACTLY the two integrate
//! inputs (ITEM-12 / DEC-7):
//!   * slot `annotation`  — the uploaded annotation-table file, a `dataset_file_ref`;
//!   * slot `axis_index`  — the dataset's `cells` entity-INDEX, a `dataset_axis_index`
//!                          `{dataset_id, axis}` (resolved at RUN time to the import's
//!                          `cells_index` metadata-column — NOT a multi-file store fetch).
//!
//! Non-rootfs: the LINK + ENQUEUE + spec build happen synchronously in the handler; the
//! sandboxed alignment itself is the rootfs-gated path in `supporting_convert_test`.

use reqwest::multipart::{Form, Part};
use serde_json::Value;
use uuid::Uuid;

use super::hardening_common::pool_for;
use super::setup_admin;
use crate::common::TestServer;

const H5AD_BYTES: &[u8] = b"\x89HDF\r\n\x1a\n fake anndata payload for the integrate-wiring test";
const ANNOTATION_CSV: &[u8] = b"barcode,cluster\nAAACCCAAGAAACACT,0\nAAACCCACAGAAACAC,1\n";

/// Upload a single `.h5ad` → `single-cell/anndata` dataset id (declares the `cells` axis).
async fn upload_h5ad(server: &TestServer, token: &str) -> String {
    let form = Form::new().part(
        "file",
        Part::bytes(H5AD_BYTES.to_vec()).file_name("pbmc.h5ad"),
    );
    let body: Value = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("upload h5ad")
        .json()
        .await
        .expect("upload json");
    body["datasets"][0]["id"]
        .as_str()
        .expect("dataset id")
        .to_string()
}

#[tokio::test]
async fn supporting_add_enqueues_wired_on_integrate_job() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let ds = upload_h5ad(&server, &admin).await;
    let ds_uuid = Uuid::parse_str(&ds).unwrap();

    // Add the annotation-table supporting file, aligned to the dataset's `cells` axis.
    let form = Form::new()
        .part(
            "file",
            Part::bytes(ANNOTATION_CSV.to_vec()).file_name("clusters.csv"),
        )
        .text("axis", "cells");
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/supporting-files")))
        .bearer_auth(&admin)
        .multipart(form)
        .send()
        .await
        .expect("add supporting file");
    assert_eq!(resp.status().as_u16(), 200, "supporting add succeeds");
    let add: Value = resp.json().await.expect("add json");
    let annotation_file_id = Uuid::parse_str(add["file_id"].as_str().expect("file id")).unwrap();

    // Resolve the integrate job the supporting link points at (its per-file
    // integration_status derives from this job — the single source of truth).
    let pool = pool_for(&server).await;
    let integrate_job_id: Uuid = sqlx::query_scalar(
        "SELECT integration_job_id FROM dataset_files WHERE dataset_id = $1 AND file_id = $2",
    )
    .bind(ds_uuid)
    .bind(annotation_file_id)
    .fetch_one(&pool)
    .await
    .expect("the supporting link carries an integrate job id");

    // It is a dataset-scoped `analysis` job (ITEM-68: tenancy scope lives in job_scope).
    let (job_type, params): (String, Value) = sqlx::query_as(
        "SELECT j.job_type, j.params FROM jobs j \
         JOIN job_scope s ON s.job_id = j.id \
         WHERE j.id = $1 AND s.scope_kind = 'dataset' AND s.scope_id = $2",
    )
    .bind(integrate_job_id)
    .bind(ds_uuid)
    .fetch_one(&pool)
    .await
    .expect("the integrate job is dataset-scoped");
    assert_eq!(
        job_type, "analysis",
        "the on-integrate kind-processor is an `analysis` job"
    );

    // ── the spec's two integrate inputs (ITEM-12 / DEC-7) ──
    let inputs = params["inputs"]
        .as_array()
        .expect("the integrate spec declares inputs");

    // (i) the annotation-table file itself — a dataset_file_ref at slot `annotation`.
    let annotation = inputs
        .iter()
        .find(|i| i["slot"] == "annotation")
        .expect("an `annotation` input slot");
    assert_eq!(
        annotation["dataset_file_ref"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok()),
        Some(annotation_file_id),
        "the `annotation` input is the uploaded annotation-table file (dataset_file_ref)"
    );
    assert!(
        annotation
            .get("dataset_axis_index")
            .map(|v| v.is_null())
            .unwrap_or(true),
        "the annotation input is a file ref, not an axis index"
    );

    // (ii) the dataset's `cells` entity-index — a dataset_axis_index at slot `axis_index`.
    let axis_index = inputs
        .iter()
        .find(|i| i["slot"] == "axis_index")
        .expect("an `axis_index` input slot");
    let axis_ref = &axis_index["dataset_axis_index"];
    assert!(
        !axis_ref.is_null(),
        "the axis_index input carries a dataset_axis_index source"
    );
    assert_eq!(
        axis_ref["dataset_id"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok()),
        Some(ds_uuid),
        "the axis index resolves against THIS dataset"
    );
    assert_eq!(
        axis_ref["axis"], "cells",
        "the axis index targets the `cells` axis the supporting file was aligned to"
    );
    assert!(
        axis_index
            .get("dataset_file_ref")
            .map(|v| v.is_null())
            .unwrap_or(true),
        "the axis_index input is an axis-index source, not a file ref"
    );
}
