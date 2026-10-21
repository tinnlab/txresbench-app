//! TEST-15 [ITEM-5, ITEM-6] — the on-ingest auto-convert trigger.
//!
//! Uploading a single `.h5ad` file (sniffed to `single-cell/anndata`, a datatype
//! the `anndata-import` extension declares an `on-ingest` converter for)
//! AUTO-ENQUEUES a zero-param converter `analysis` job scoped to that dataset —
//! the `maybe_autoconvert_on_ingest` wiring in `dataset/routes.rs`. The
//! ENQUEUE + wiring assertion runs on ANY box (no rootfs needed): the job row is
//! created synchronously in the upload handler before the response returns.
//!
//! What the job DOES with those bytes needs the analysis rootfs mounted, so that
//! assertion is gated behind [`rootfs_gate`](super::hardening_common::rootfs_gate) —
//! it RUNS + asserts on a rootfs-capable host and SELF-SKIPS (never a compile-time
//! ignore) otherwise, mirroring the capsule suite (`capsule_reproduces_test.rs`).
//!
//! The payload is a FAKE `\x89HDF…` blob (an HDF5 magic followed by garbage), so the
//! gated assertion is the MALFORMED-INPUT contract, not a completion: an unparseable
//! upload must reach a terminal `failed` FAST and carry a DIAGNOSTIC error. This test
//! previously asserted `status == "completed"` for these same bytes — an outcome the
//! converter can never produce, since `h5ad_import.py` does `ad.read_h5ad(...)` on
//! them. It never went red only because its private poller read the wrong JSON path
//! (`body["status"]` on a `JobDetail`, whose status lives at `body["job"]["status"]`),
//! so it always burned its full 180s deadline and reported "no terminal state" —
//! masking BOTH the impossible assertion and the fact that the job had actually failed
//! in ~2s. Both are fixed: the shared `poll_job_terminal_api` reads the right path and
//! panics loudly with the last body, and the assertion states the real contract.

use reqwest::multipart::{Form, Part};
use serde_json::Value;

use super::hardening_common::{poll_job_terminal_api, pool_for, rootfs_gate, skip_no_rootfs};
use super::setup_admin;
use crate::common::TestServer;

/// A MALFORMED `.h5ad` payload: the HDF5 magic (so the extension/magic sniff types it
/// `single-cell/anndata` and the on-ingest converter is selected) followed by garbage
/// that is not a valid HDF5 superblock. The real parse happens inside the sandboxed
/// converter, which must reject it fast.
const H5AD_BYTES: &[u8] = b"\x89HDF\r\n\x1a\n fake anndata payload for on-ingest trigger";

/// The bound the malformed-input path must settle well inside. Parsing a superblock is
/// sub-second work; the sandbox's wall-clock ceiling (600s by default) is the LAST
/// resort, not the expected path — so a regression that only "terminates" by hitting the
/// ceiling fails this test.
const FAIL_FAST_BUDGET: std::time::Duration = std::time::Duration::from_secs(90);

/// Upload one file through the grouping upload endpoint → `(status, body)`.
async fn upload_one(server: &TestServer, token: &str, name: &str, bytes: &[u8]) -> (u16, Value) {
    let form = Form::new().part(
        "file",
        Part::bytes(bytes.to_vec()).file_name(name.to_string()),
    );
    let resp = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .unwrap();
    let status = resp.status().as_u16();
    let body = resp.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

#[tokio::test]
async fn h5ad_ingest_auto_enqueues_a_converter_job() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Upload a single `.h5ad` → a typed `single-cell/anndata` dataset.
    let (status, body) = upload_one(&server, &admin, "pbmc.h5ad", H5AD_BYTES).await;
    assert_eq!(status, 200, "h5ad upload succeeds: {body}");
    let datasets = body["datasets"].as_array().expect("datasets array");
    assert_eq!(datasets.len(), 1, "one file → one dataset");
    let ds = &datasets[0];
    assert_eq!(
        ds["datatype"],
        serde_json::json!("single-cell/anndata"),
        "a `.h5ad` is typed as single-cell/anndata (the converter's accepted type)"
    );
    let dataset_id = ds["id"].as_str().expect("dataset id").to_string();
    let ds_uuid = uuid::Uuid::parse_str(&dataset_id).unwrap();

    // ── NON-GATED wiring assertion: the on-ingest converter auto-enqueued a job.
    // The row is created synchronously in the upload handler, so no rootfs is
    // needed — this proves ITEM-5/6 (trigger + enqueue) independent of execution.
    // A job's tenancy scope lives in `job_scope` (ITEM-68 — the `jobs.dataset_id`
    // column was dropped by migration …280001), so resolve the dataset-scoped job via
    // that join. Like the rest of the hardening suite, this reads the DB the server owns.
    let pool = pool_for(&server).await;
    // Job tenancy scope lives in the `job_scope` table (a 'dataset' scope row),
    // not a `jobs.dataset_id` column (removed by the job_scope migration).
    let (job_id, job_type, job_name): (uuid::Uuid, String, String) = sqlx::query_as(
        "SELECT j.id, j.job_type, j.name FROM jobs j JOIN job_scope s ON s.job_id = j.id
          WHERE s.scope_kind = 'dataset' AND s.scope_id = $1",
    )
    .bind(ds_uuid)
    .fetch_one(&pool)
    .await
    .expect("an on-ingest converter job was auto-enqueued for the h5ad dataset");
    assert_eq!(
        job_type, "analysis",
        "the auto-enqueued converter is an `analysis` job"
    );
    assert!(
        job_name.starts_with("Convert "),
        "the converter job is named `Convert <dataset>`: {job_name}"
    );
    let job_id = job_id.to_string();

    // ── GATED execution assertion: only with the analysis rootfs mounted does the
    // sandboxed converter actually RUN over these bytes. Self-skip otherwise.
    let Some(_digest) = rootfs_gate(&server, &admin).await else {
        skip_no_rootfs("h5ad_ingest_auto_enqueues_a_converter_job (malformed-input assertion)");
        return;
    };

    // A MALFORMED payload must FAIL FAST with a terminal status — never hang, and never
    // reach terminal only by exhausting the sandbox wall-clock ceiling.
    let started = std::time::Instant::now();
    let (status, detail) = poll_job_terminal_api(&server, &admin, &job_id, FAIL_FAST_BUDGET).await;
    let elapsed = started.elapsed();
    assert_eq!(
        status, "failed",
        "an unparseable .h5ad must terminate as `failed` (not completed/stopped): {detail}"
    );
    assert!(
        elapsed < FAIL_FAST_BUDGET,
        "malformed input reached `failed` only after {elapsed:?} — it must fail FAST, not by \
         hitting a wall-clock ceiling"
    );

    // …and the terminal error must DIAGNOSE it, not just report an exit code. The executor
    // folds the child's stderr tail into `job.error`, so the reason the converter rejected
    // the bytes is on the surface every client already renders.
    let error = detail["job"]["error"].as_str().unwrap_or_default();
    assert!(
        error.contains("exited with code"),
        "the terminal error names the non-zero exit: {error:?}"
    );
    assert!(
        error.len() > "analysis exited with code 1".len(),
        "the terminal error carries a DIAGNOSTIC beyond the bare exit code (the converter's \
         stderr tail), not just a status: {error:?}"
    );
    assert!(
        error.to_lowercase().contains("h5ad_import")
            || error.to_lowercase().contains("failed")
            || error.to_lowercase().contains("error"),
        "the diagnostic quotes the converter's own failure line: {error:?}"
    );

    // Nothing was cataloged — a failed conversion must not leave partial artifacts behind.
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM artifacts WHERE dataset_id = $1")
        .bind(ds_uuid)
        .fetch_one(&pool)
        .await
        .expect("count artifacts");
    assert_eq!(n, 0, "a failed conversion catalogs no artifacts");
}
