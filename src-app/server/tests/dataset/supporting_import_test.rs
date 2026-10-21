//! TEST-10 [ITEM-10, ITEM-11] — "the import never sees supporting files" (DEC-23).
//!
//! A combined `/datasets/upload` carrying a PRIMARY (`.h5ad`) + an `annotation-table`
//! SUPPORTING part links the primary `role=primary` and the annotation `role=supporting`
//! (deriving `pending` while its integrate child is blocked on the import), and
//! enqueues ONLY the primary import job. The import job's spec inputs contain the
//! PRIMARY file alone — the supporting file is folded on AFTER the import is enqueued
//! (DEC-23: one primary import processor per domain that knows NOTHING about supporting
//! files; a separate reused kind-processor aligns the annotation). We prove it by
//! asserting the import spec is byte-identical (modulo the differing file/dataset ids)
//! to a PRIMARY-ALONE import of the same primary, and that the supporting file_id never
//! appears among the import spec inputs.
//!
//! No rootfs is needed: the LINK + the ENQUEUE + the DAG wiring happen synchronously in
//! the upload handler; the sandboxed execution is exercised in `supporting_convert_test`.

use reqwest::multipart::{Form, Part};
use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::hardening_common::pool_for;
use super::setup_admin;
use crate::common::TestServer;

/// A minimal `.h5ad` payload — typed by its extension to `single-cell/anndata`
/// (which DECLARES the `cells`+`genes` axes + an on-ingest import converter). Opaque
/// bytes: only the ENQUEUE/wiring is asserted here, not the sandboxed conversion.
const H5AD_BYTES: &[u8] = b"\x89HDF\r\n\x1a\n fake anndata payload for the import-guard test";

/// A barcode-keyed annotation CSV → the supporting `annotation-table` datatype.
const ANNOTATION_CSV: &[u8] = b"barcode,cluster\nAAACCCAAGAAACACT,0\nAAACCCACAGAAACAC,1\n";

/// The `AnalysisSpec` params of the dataset's IMPORT (on-ingest "Convert …") job. The
/// import and the integrate job are BOTH dataset-scoped `analysis` jobs; the import is
/// the one named `Convert …` (`auto_convert_test` pins that contract). Returns
/// `(job_id, params)`.
async fn import_job_params(pool: &PgPool, dataset_id: Uuid) -> (Uuid, Value) {
    let (id, params): (Uuid, Value) = sqlx::query_as(
        "SELECT j.id, j.params FROM jobs j \
         JOIN job_scope s ON s.job_id = j.id \
         WHERE s.scope_kind = 'dataset' AND s.scope_id = $1 AND j.name LIKE 'Convert %'",
    )
    .bind(dataset_id)
    .fetch_one(pool)
    .await
    .expect("the dataset's primary import (`Convert …`) job exists");
    (id, params)
}

/// Upload primary `file` parts + optional supporting parts → the parsed body. `supporting`
/// is a JSON array of `{index, axis}` tagging which `file` parts are supporting.
async fn upload(
    server: &TestServer,
    token: &str,
    parts: &[(&str, &[u8])],
    supporting: Option<Value>,
) -> Value {
    let mut form = Form::new();
    for (name, bytes) in parts {
        form = form.part(
            "file",
            Part::bytes(bytes.to_vec()).file_name(name.to_string()),
        );
    }
    if let Some(s) = supporting {
        form = form.text("supporting", s.to_string());
    }
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .expect("combined upload");
    assert_eq!(resp.status().as_u16(), 200, "upload succeeds");
    resp.json().await.expect("upload json")
}

/// The dataset detail's files array.
async fn dataset_files(server: &TestServer, token: &str, dataset_id: &str) -> Vec<Value> {
    let detail: Value = server
        .client
        .get(server.api_url(&format!("/datasets/{dataset_id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get dataset")
        .json()
        .await
        .expect("detail json");
    detail["files"].as_array().cloned().expect("files array")
}

#[tokio::test]
async fn import_never_sees_supporting_files() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // ── the combined upload: one primary h5ad + one annotation-table supporting ──
    let body = upload(
        &server,
        &admin,
        &[("pbmc.h5ad", H5AD_BYTES), ("clusters.csv", ANNOTATION_CSV)],
        Some(json!([{ "index": 1, "axis": "cells" }])),
    )
    .await;
    let datasets = body["datasets"].as_array().expect("datasets array");
    assert_eq!(
        datasets.len(),
        1,
        "primary + supporting fold into ONE dataset"
    );
    let ds = datasets[0]["id"].as_str().expect("dataset id").to_string();
    let ds_uuid = Uuid::parse_str(&ds).unwrap();

    // Read the derived per-file status IMMEDIATELY (before the scheduler advances the
    // import), then take the wiring evidence.
    let files = dataset_files(&server, &admin, &ds).await;
    let primary = files
        .iter()
        .find(|f| f["role"] == "primary")
        .expect("a primary file");
    let supporting = files
        .iter()
        .find(|f| f["role"] == "supporting")
        .expect("a supporting file");
    let primary_file_id =
        Uuid::parse_str(primary["file_id"].as_str().expect("primary file_id")).unwrap();
    let supporting_file_id =
        Uuid::parse_str(supporting["file_id"].as_str().expect("supporting file_id")).unwrap();

    // The primary links role=primary (no supporting kind); the annotation links
    // role=supporting/kind=annotation_table with a DERIVED `pending` status — its
    // integrate child is `blocked` on the (still-unfinished) import (DAG wiring below).
    assert_eq!(
        primary["kind"],
        Value::Null,
        "the primary carries no supporting kind"
    );
    assert_eq!(
        supporting["kind"],
        json!("annotation_table"),
        "the supporting file's kind is surfaced"
    );
    assert_eq!(
        supporting["integration_status"],
        json!("pending"),
        "the supporting file derives `pending` while its integrate child is blocked on the import"
    );

    // ── the import job: ONLY the primary; the supporting file is NOT an input ──
    let (import_job, import_params) = import_job_params(&pool, ds_uuid).await;
    let import_inputs = import_params["inputs"]
        .as_array()
        .expect("import spec inputs");
    assert_eq!(
        import_inputs.len(), 1,
        "the import binds exactly the ONE primary file (the supporting file is NOT an input): {import_inputs:?}"
    );
    // The single input is the PRIMARY file, by dataset_file_ref …
    assert_eq!(
        import_inputs[0]["dataset_file_ref"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok()),
        Some(primary_file_id),
        "the import input is the primary file"
    );
    // … and the supporting file_id appears NOWHERE in the import spec (the guard).
    assert!(
        !import_params
            .to_string()
            .contains(&supporting_file_id.to_string()),
        "the supporting file_id must not appear anywhere in the import spec"
    );

    // The DAG wiring that CAUSES the derived `pending`: the integrate child depends on
    // this import job (deterministic — no scheduler race).
    let integrate_deps_on_import: Option<(Uuid,)> = sqlx::query_as(
        "SELECT jd.job_id FROM job_dependencies jd WHERE jd.depends_on_job_id = $1 LIMIT 1",
    )
    .bind(import_job)
    .fetch_optional(&pool)
    .await
    .expect("query job_dependencies");
    assert!(
        integrate_deps_on_import.is_some(),
        "the supporting integrate job depends on the primary import job (the pending cause)"
    );

    // ── byte-identical to a PRIMARY-ALONE import (modulo the differing ids) ──
    // The same primary, uploaded WITHOUT a supporting part, produces an import spec
    // whose inputs are structurally identical. Normalize away the per-upload
    // dataset_file_ref (a different upload ⇒ a different file id) and assert the rest
    // of the two specs match byte-for-byte — proving the supporting part added NOTHING
    // to the import.
    let alone_body = upload(&server, &admin, &[("pbmc.h5ad", H5AD_BYTES)], None).await;
    let alone_ds = Uuid::parse_str(alone_body["datasets"][0]["id"].as_str().unwrap()).unwrap();
    let (_alone_job, alone_params) = import_job_params(&pool, alone_ds).await;

    assert_eq!(
        normalize_import_spec(&import_params),
        normalize_import_spec(&alone_params),
        "the primary import spec is byte-identical to a primary-alone import (the supporting file changed nothing)"
    );
}

/// Blank the per-upload identity of an import spec's inputs (the `dataset_file_ref`
/// UUID differs between two uploads of the same bytes) so two specs can be compared
/// for structural byte-equality (slots, subpaths, code_ref, language, params, produces).
fn normalize_import_spec(params: &Value) -> Value {
    let mut p = params.clone();
    if let Some(inputs) = p["inputs"].as_array_mut() {
        for input in inputs {
            if let Some(obj) = input.as_object_mut() {
                obj.insert("dataset_file_ref".to_string(), Value::Null);
            }
        }
    }
    p
}
