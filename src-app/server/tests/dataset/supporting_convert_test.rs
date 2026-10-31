//! TEST-15 + TEST-24 [ITEM-7, ITEM-8, ITEM-10, ITEM-13, ITEM-21] — the FULL real
//! supporting-file pipeline, ROOTFS-GATED (+ fixture-gated).
//!
//! With the analysis rootfs mounted AND the real `pbmc3k_raw.h5ad` fixture present
//! (`fixtures/fetch.sh pbmc3k`), this drives the WHOLE production path:
//!
//!   1. import a tiny real h5ad → the sandboxed `h5ad_import` produces the
//!      `single-cell/expression` CSC matrix PLUS the `cells` entity-INDEX
//!      (`cells_index`) metadata-column (DEC-7);
//!   2. add a REAL barcode-keyed CSV supporting file (keyed on the dataset's OWN
//!      barcodes, read back from `cells_index` so the join is genuine) and let the
//!      `annotation-integrate` kind-processor RUN under the sandbox;
//!   3. assert it emits NEW `metadata-column` artifacts aligned to `cells`, the primary
//!      MATRIX content-hash is UNCHANGED (DEC-1 — integrated columns are sidecars, the
//!      primary is never rewritten), the supporting row's derived `integration_status`
//!      reaches `integrated`, and its `integration_summary` carries coverage
//!      (`matched`/`total`);
//!   4. (TEST-24) a categorical integrated column exposes its `categories` in the
//!      catalog `meta` (fetchable via the artifact API WITHOUT the column body) and a
//!      continuous one exposes `{min,max}` — the SAME compact summary shape an
//!      import-time column carries (the kind-processor reuses the shared
//!      `colsummary` helper).
//!
//! The WHOLE test is gated behind [`rootfs_gate`](super::hardening_common::rootfs_gate)
//! + [`fixture_path`](super::hardening_common::fixture_path): it RUNS + asserts on a
//! rootfs-capable host with the fixture fetched, and SELF-SKIPS (never a compile-time
//! ignore) otherwise — the `auto_convert_test` / `convert_soma_test` precedent.

use reqwest::multipart::{Form, Part};
use serde_json::Value;
use uuid::Uuid;

use super::hardening_common::{
    fixture_path, pool_for, record_skip, rootfs_gate, server_store, skip_no_rootfs,
};
use super::setup_admin;
use crate::common::zarr;
use crate::common::TestServer;

/// The fetch-on-demand real fixture (`fixtures/fetch.sh pbmc3k`). Absent ⇒ self-skip.
const PBMC3K: &str = "pbmc3k_raw.h5ad";
const PBMC3K_SHA256: &str = "89a96f1beaa2dd83a687666d3f19a4513ac27a2a2d12581fcd77afed7ea653a1";

#[tokio::test]
async fn integrate_aligns_annotation_and_summarizes_columns() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;

    // Gate 1: the sandbox must be MOUNTED + EXECUTABLE (real conversion needs it).
    let Some(_digest) = rootfs_gate(&server, &admin).await else {
        skip_no_rootfs("integrate_aligns_annotation_and_summarizes_columns (no analysis rootfs)");
        return;
    };
    // Gate 2: the real h5ad fixture must be present + sha256-verified.
    // Gate 1 above already routes through `skip_no_rootfs` (a `record_skip` wrapper);
    // this second gate used a bare `eprintln!`, so a missing fixture reported a PASS and
    // was invisible to both the skip ledger and `CYTO_TEST_NO_SKIP=1`.
    let Some(fixture) = fixture_path(PBMC3K, PBMC3K_SHA256) else {
        record_skip(
            "integrate_aligns_annotation_and_summarizes_columns",
            &format!(
                "fixture {PBMC3K} absent or failed its sha256 check — run \
                 tests/dataset/fixtures/fetch.sh pbmc3k to make this RUN"
            ),
        );
        return;
    };
    let h5ad_bytes = std::fs::read(&fixture).expect("read h5ad fixture");

    // Raise the sandbox address-space cap (default 4 GiB). This was needed because the
    // native store library the import used to write RESERVED a large VIRTUAL address
    // space (RLIMIT_AS counts mmap reservations, not resident pages) and OOMed
    // (`std::bad_alloc`) under 4 GiB even for a tiny dataset. That library is gone
    // (artifact-model ITEM-27/ITEM-38) and the streaming writer is numpy+stdlib, so the
    // raise is now HEADROOM rather than a floor — kept because a real import under a
    // shared box is still the heaviest step here, and lowering it is a separate,
    // separately-measured change. 64 GiB of virtual AS is free (not resident).
    let put = server
        .client
        .put(server.api_url("/sandbox/settings"))
        .bearer_auth(&admin)
        .json(&serde_json::json!({ "address_space_bytes": 64i64 * 1024 * 1024 * 1024 }))
        .send()
        .await
        .expect("raise sandbox address_space");
    assert_eq!(
        put.status().as_u16(),
        200,
        "sandbox address-space raise accepted"
    );

    // ── (1) import the real h5ad → CSC matrix + cells_index ─────────────────────
    let form = Form::new().part("file", Part::bytes(h5ad_bytes).file_name("pbmc3k.h5ad"));
    let body: Value = server
        .client
        .post(server.api_url("/datasets/upload"))
        .bearer_auth(&admin)
        .multipart(form)
        .send()
        .await
        .expect("upload h5ad")
        .json()
        .await
        .expect("upload json");
    let ds = body["datasets"][0]["id"]
        .as_str()
        .expect("dataset id")
        .to_string();
    let ds_uuid = Uuid::parse_str(&ds).unwrap();
    assert_eq!(body["datasets"][0]["datatype"], "single-cell/anndata");

    let pool = pool_for(&server).await;
    // The primary import job (dataset-scoped `Convert …`).
    let import_job: Uuid = sqlx::query_scalar(
        "SELECT j.id FROM jobs j JOIN job_scope s ON s.job_id = j.id \
         WHERE s.scope_kind = 'dataset' AND s.scope_id = $1 AND j.name LIKE 'Convert %'",
    )
    .bind(ds_uuid)
    .fetch_one(&pool)
    .await
    .expect("import job auto-enqueued");
    assert_eq!(
        poll_terminal(&server, &admin, &pool, import_job, 300).await,
        "completed",
        "the real h5ad import runs to completion"
    );

    // The PRIMARY matrix (exactly one) — record its content_hash for the DEC-1 check.
    // This read used to name the lossless multi-file store; ITEM-27 deleted that output
    // (it was the transpose BUFFER the CSC was streamed out of) and ITEM-38 deleted the
    // datatype, so this test was asserting on a row the import can no longer produce —
    // a `fetch_one` that could only ever fail. The CSC matrix is the primary now.
    let (primary_id, primary_hash): (Uuid, String) = sqlx::query_as(
        "SELECT id, content_hash FROM artifacts \
         WHERE dataset_id = $1 AND datatype = 'single-cell/expression'",
    )
    .bind(ds_uuid)
    .fetch_one(&pool)
    .await
    .expect("the import produced exactly one single-cell/expression matrix");

    // The `cells` entity-index the import emitted (an axis=cells metadata-column) —
    // its VALUES are the dataset's real barcodes, which we key the CSV on.
    let cells_index_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM artifacts WHERE dataset_id = $1 AND datatype = 'metadata-column' AND output_id = 'cells_index'",
    )
    .bind(ds_uuid)
    .fetch_one(&pool)
    .await
    .expect("the import emitted the cells_index (axis=cells) metadata-column");

    // ── (2) read the real barcodes back + build a genuinely-matching CSV ────────
    //
    // The index artifact is a STORE (ITEM-26 moved every emitted column onto the
    // shared output adapter), so its values are a split arrow member, not a JSON
    // array. Reading it the old way panicked HERE — before the join this test exists
    // to prove was ever built — which is the failure mode a stale reader has: it does
    // not weaken the subject, it removes it.
    let index_key: String = sqlx::query_scalar("SELECT object_key FROM artifacts WHERE id = $1")
        .bind(cells_index_id)
        .fetch_one(&pool)
        .await
        .expect("the index artifact's object_key");
    // The byte plane still serves it — asserted here so migrating the DECODE does not
    // quietly drop this test's only exercise of the read surface.
    let served = server
        .client
        .get(server.api_url(&format!("/artifacts/{cells_index_id}/data/zarr.json")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("fetch the index store's root document");
    assert_eq!(served.status().as_u16(), 200, "the store root is served");

    let index_store = zarr::load_artifact(&server_store(&server), &index_key).await;
    let barcodes: Vec<String> = zarr::read_strings(&index_store, zarr::VALUES)
        .into_iter()
        .take(12)
        .collect();
    assert!(
        barcodes.len() >= 3,
        "the dataset has ≥3 barcodes to key on: {}",
        barcodes.len()
    );

    // A barcode-keyed CSV with ONE categorical column (`cluster`) + ONE continuous
    // column (`score`), keyed on the dataset's OWN barcodes → a real, non-degraded join.
    let mut csv = String::from("barcode,cluster,score\n");
    for (i, bc) in barcodes.iter().enumerate() {
        let cluster = ["A", "B", "C"][i % 3];
        let score = (i as f64) * 1.5 + 0.25;
        csv.push_str(&format!("{bc},{cluster},{score}\n"));
    }
    let matched_total = barcodes.len();

    // ── add the supporting file (aligned to `cells`) + let the integrate RUN ────
    let add_form = Form::new()
        .part(
            "file",
            Part::bytes(csv.into_bytes()).file_name("clusters.csv"),
        )
        .text("axis", "cells");
    let add: Value = server
        .client
        .post(server.api_url(&format!("/datasets/{ds}/supporting-files")))
        .bearer_auth(&admin)
        .multipart(add_form)
        .send()
        .await
        .expect("add supporting file")
        .json()
        .await
        .expect("add json");
    let supporting_file_id = Uuid::parse_str(add["file_id"].as_str().expect("file id")).unwrap();

    let integrate_job: Uuid = sqlx::query_scalar(
        "SELECT integration_job_id FROM dataset_files WHERE dataset_id = $1 AND file_id = $2",
    )
    .bind(ds_uuid)
    .bind(supporting_file_id)
    .fetch_one(&pool)
    .await
    .expect("the supporting link carries an integrate job id");
    assert_eq!(
        poll_terminal(&server, &admin, &pool, integrate_job, 180).await,
        "completed",
        "the annotation-integrate kind-processor runs to completion"
    );

    // ── (3) TEST-15 assertions ──────────────────────────────────────────────────
    // The integrate run cataloged NEW metadata-column artifacts (cluster + score),
    // aligned to `cells` — scoped to this run (run_id == the integrate job id).
    //
    // Read through `meta` — the producer's DECLARATION, carried into the row verbatim.
    // This read named `params`, the bag the server used to synthesize by merging three
    // manifest fields; ITEM-7 dropped that column, so the query could only ever raise
    // `column "params" does not exist`. It was invisible because the read above it
    // panicked first: one stale read hid the next.
    let integrate_cols: Vec<(Uuid, Value)> = sqlx::query_as(
        "SELECT id, meta FROM artifacts WHERE run_id = $1 AND datatype = 'metadata-column'",
    )
    .bind(integrate_job)
    .fetch_all(&pool)
    .await
    .expect("query integrate-run metadata-columns");
    let labels: Vec<&str> = integrate_cols
        .iter()
        .filter_map(|(_, m)| m["name"].as_str())
        .collect();
    assert!(
        labels.contains(&"cluster") && labels.contains(&"score"),
        "the integrate run emitted a metadata-column per non-key annotation column (cluster + score): {labels:?}"
    );

    // DEC-1: the primary matrix is UNTOUCHED — same content hash after integrate.
    let primary_hash_after: String =
        sqlx::query_scalar("SELECT content_hash FROM artifacts WHERE id = $1")
            .bind(primary_id)
            .fetch_one(&pool)
            .await
            .expect("re-read the primary matrix hash");
    assert_eq!(
        primary_hash_after, primary_hash,
        "the primary matrix content-hash is UNCHANGED by integration (sidecar columns, DEC-1)"
    );

    // The supporting row's derived status reaches `integrated`, and integration_summary
    // carries the alignment coverage (matched/total).
    let support = supporting_file(&server, &admin, &ds).await;
    assert_eq!(
        support["integration_status"], "integrated",
        "the supporting file's derived integration_status reaches `integrated`"
    );
    let summary = &support["integration_summary"];
    assert_eq!(
        summary["matched"],
        serde_json::json!(matched_total),
        "the coverage summary reports every keyed barcode as matched: {summary}"
    );
    assert!(
        summary["total"].as_i64().unwrap_or(0) >= matched_total as i64,
        "the coverage `total` is the axis-entity count (≥ matched): {summary}"
    );

    // ── (4) TEST-24 assertions — the compact per-column summary in the catalog meta ─
    // Identify the categorical (cluster) + continuous (score) integrate columns.
    let cat_id = integrate_cols
        .iter()
        .find(|(_, m)| m["kind"] == "categorical")
        .map(|(id, _)| *id)
        .expect("a categorical integrated column (cluster)");
    let cont_id = integrate_cols
        .iter()
        .find(|(_, m)| m["kind"] == "continuous")
        .map(|(id, _)| *id)
        .expect("a continuous integrated column (score)");

    // The categorical column exposes its `categories` in the catalog meta — fetched via
    // the artifact API, WITHOUT the column body.
    let cat_meta = artifact_meta(&server, &admin, cat_id).await;
    assert_eq!(cat_meta["kind"], "categorical");
    let cats = cat_meta["categories"]
        .as_array()
        .expect("categorical meta carries `categories`");
    assert!(
        !cats.is_empty(),
        "the categorical legend is non-empty (real matches): {cat_meta}"
    );

    // The continuous column exposes `{min, max}`.
    let cont_meta = artifact_meta(&server, &admin, cont_id).await;
    assert_eq!(cont_meta["kind"], "continuous");
    assert!(
        cont_meta["min"].is_number(),
        "continuous meta carries a numeric `min`: {cont_meta}"
    );
    assert!(
        cont_meta["max"].is_number(),
        "continuous meta carries a numeric `max`: {cont_meta}"
    );

    // SAME summary shape as an IMPORT-time column: the import's cells_index is a
    // categorical column produced by the SAME shared `colsummary` helper — it carries
    // the identical categorical key-set, proving the added-later column reuses the helper.
    let import_cat_meta = artifact_meta(&server, &admin, cells_index_id).await;
    assert_eq!(
        import_cat_meta["kind"], "categorical",
        "the import cells_index is categorical"
    );
    for key in ["kind", "categories", "n_categories", "high_cardinality"] {
        assert!(
            import_cat_meta.get(key).is_some(),
            "the import-time categorical summary carries `{key}` (shared shape): {import_cat_meta}"
        );
        assert!(
            cat_meta.get(key).is_some(),
            "the added-later categorical summary carries the SAME `{key}`: {cat_meta}"
        );
    }
}

/// The dataset's `role='supporting'` file (from `GET /datasets/{id}`).
async fn supporting_file(server: &TestServer, token: &str, dataset_id: &str) -> Value {
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
    detail["files"]
        .as_array()
        .expect("files array")
        .iter()
        .find(|f| f["role"] == "supporting")
        .cloned()
        .expect("a supporting file")
}

/// One artifact's catalog `meta` (`params.meta`) via `GET /artifacts/{id}/catalog` —
/// the registry-enriched view, which never carries the column body.
async fn artifact_meta(server: &TestServer, token: &str, id: Uuid) -> Value {
    // `GET /artifacts/{id}` with the declaration at the TOP level. This used to read
    // `artifact.params.meta` off a `/catalog` sub-route: neither the route nor the
    // column survives ITEM-7/ITEM-12, and `.json()` on the 404 envelope parsed happily,
    // so every assertion below it compared `null` to a string — reachable only once the
    // two reads above it stopped panicking. The status is asserted so a future
    // route change fails HERE, naming itself, instead of one layer down as `null`.
    let resp = server
        .client
        .get(server.api_url(&format!("/artifacts/{id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get the artifact");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "the artifact read surface answers for {id}"
    );
    let v: Value = resp.json().await.expect("artifact json");
    v["meta"].clone()
}

/// Poll a job to a terminal status via the DB (panics on timeout with the job's error
/// + last logs for a real, debuggable failure).
async fn poll_terminal(
    server: &TestServer,
    _token: &str,
    pool: &sqlx::SqlitePool,
    job_id: Uuid,
    secs: u64,
) -> String {
    let _ = server;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        let status: String = sqlx::query_scalar("SELECT status FROM jobs WHERE id = $1")
            .bind(job_id)
            .fetch_one(pool)
            .await
            .expect("job row");
        if matches!(status.as_str(), "completed" | "failed" | "stopped") {
            if status != "completed" {
                let err: Option<String> =
                    sqlx::query_scalar("SELECT error FROM jobs WHERE id = $1")
                        .bind(job_id)
                        .fetch_one(pool)
                        .await
                        .ok()
                        .flatten();
                let logs: Vec<(String, String)> = sqlx::query_as(
                    "SELECT stream, content FROM job_logs WHERE job_id = $1 ORDER BY seq DESC LIMIT 40",
                )
                .bind(job_id)
                .fetch_all(pool)
                .await
                .unwrap_or_default();
                let logstr: String = logs
                    .iter()
                    .rev()
                    .map(|(s, c)| format!("[{s}] {c}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                panic!("job {job_id} ended {status} (expected completed)\nerror={err:?}\n--- logs ---\n{logstr}");
            }
            return status;
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("job {job_id} did not reach a terminal state within {secs}s (last={status})");
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}
