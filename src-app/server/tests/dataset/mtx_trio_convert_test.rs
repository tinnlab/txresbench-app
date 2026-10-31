//! **TEST-5 for #182 (INV-4).** This file is the shipped end-to-end precedent the
//! streaming rewrite must not regress, in BOTH the loose-files and the real `.zip`
//! shape, through a real sandbox. It is cited by
//! `.lifecycle/streaming-upload/TESTS.md` and is deliberately UNCHANGED below this
//! line — the invariant is that it still passes as written, so the only thing #182
//! adds here is this citation. (Deliberately free of domain vocabulary: the
//! no-domain-in-builtin guard's per-file prose counts are shrink-only, so even a
//! comment may not add one.)
//! TEST-17 [ITEM-14] — the 10x trio (and a `.zip` of it) group AND convert.
//!
//! Extends `mtx_trio_group_test.rs` (which proves the auto-GROUPING) through the
//! CONVERT step. Two halves, split by what each can actually prove:
//!
//!   * [`mtx_trio_and_zip_group_and_enqueue`] — SYNTHETIC magic-byte payloads (no
//!     real matrix). Proves the upload path's GROUPING (3 files → 1 dataset),
//!     TYPING (`single-cell/matrix-mtx` from the canonical trio filenames;
//!     `single-cell/anndata` from PK magic), and the auto-ENQUEUE of the on-ingest
//!     converter. Runs on ANY box: no rootfs, no compute.
//!   * [`mtx_trio_converts_to_completion`] — the REAL, COMMITTED 10x trio fixture
//!     (`fixtures/mtx_trio/`, a deterministic 50×100 subsample of the pinned
//!     `pbmc3k_raw.h5ad`; see `fixtures/make_mtx_trio.py`). Uploads it BOTH as a
//!     trio and as a real `.zip` bundle, lets the on-ingest converter RUN in the
//!     sandbox, and asserts the conversion is CORRECT — the harvested dataset
//!     metadata reports the trio's own dimensions (50 cells × 100 genes, 4774
//!     stored counts, `source_format=10x_mtx`), the run cataloged a real SOMA store
//!     + the CSC expression projection, and the `cells_index` carries the fixture's
//!     OWN barcodes in file order.
//!
//! Before the fixture existed, the completion half could only be written against
//! synthetic bytes (a converter fed garbage), so it never proved a conversion. It is
//! gated behind [`rootfs_gate`](super::hardening_common::rootfs_gate) and SELF-SKIPS
//! (never a compile-time ignore) when no rootfs is mounted — the capsule-suite
//! precedent. The fixture ships in git, so it is never itself a skip reason.

use std::io::Write;
use std::path::PathBuf;

use reqwest::multipart::{Form, Part};
use serde_json::Value;
use uuid::Uuid;

use super::convert_soma_test::{MATRIX_DATATYPE, RETIRED_STORE_DATATYPE};
use super::hardening_common::{poll_job_terminal_api, pool_for, rootfs_gate, skip_no_rootfs};
use super::{create_user, login, setup_admin};
use crate::common::TestServer;

/// The committed fixture's own shape (see `fixtures/make_mtx_trio.py`) — the numbers
/// the conversion must independently rediscover from the matrix bytes.
const TRIO_CELLS: i64 = 50;
const TRIO_GENES: i64 = 100;
const TRIO_NNZ: i64 = 4774;
/// The fixture's first barcode — a real pbmc3k barcode, in the source's obs order.
/// Cell Ranger member order (also the dataset-file ordinal order).
const TRIO_MEMBERS: [&str; 3] = ["matrix.mtx.gz", "barcodes.tsv.gz", "features.tsv.gz"];

fn part(name: &str, bytes: &[u8]) -> Part {
    Part::bytes(bytes.to_vec()).file_name(name.to_string())
}

async fn upload(server: &TestServer, token: &str, form: Form) -> (u16, Value) {
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

/// The `(job_id, job_type)` of the converter auto-enqueued for `dataset_id`. A job's
/// tenancy scope lives in `job_scope` (ITEM-68 — the `jobs.dataset_id` column was
/// dropped by migration …280001), so resolve via that join. Reads the server's own DB.
async fn converter_job_for(pool: &sqlx::SqlitePool, dataset_id: Uuid) -> Option<(Uuid, String)> {
    sqlx::query_as(
        "SELECT j.id, j.job_type FROM jobs j \
         JOIN job_scope s ON s.job_id = j.id \
         WHERE s.scope_kind = 'dataset' AND s.scope_id = $1",
    )
    .bind(dataset_id)
    .fetch_optional(pool)
    .await
    .expect("query jobs by dataset scope")
}

#[tokio::test]
async fn mtx_trio_and_zip_group_and_enqueue() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    create_user(&server, &admin, "trio", "trio@x.test").await;
    let trio = login(&server, "trio").await;

    // ── (a) the canonical 10x raw trio → ONE matrix-mtx dataset (3 files) ────────
    let form = Form::new()
        .part(
            "file",
            part("matrix.mtx.gz", b"\x1f\x8b\x08 fake matrix payload"),
        )
        .part(
            "file",
            part("barcodes.tsv.gz", b"\x1f\x8b\x08 fake barcodes payload"),
        )
        .part(
            "file",
            part("features.tsv.gz", b"\x1f\x8b\x08 fake features payload"),
        );
    let (status, body) = upload(&server, &trio, form).await;
    assert_eq!(status, 200, "trio upload succeeds: {body}");
    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(datasets.len(), 1, "the trio auto-groups into ONE dataset");
    let trio_ds = &datasets[0];
    assert_eq!(
        trio_ds["datatype"],
        serde_json::json!("single-cell/matrix-mtx"),
        "typed as the mtx-trio Manifest datatype (an accepted converter input)"
    );
    assert_eq!(
        trio_ds["files"].as_array().unwrap().len(),
        3,
        "one dataset, three trio files"
    );
    let trio_id = Uuid::parse_str(trio_ds["id"].as_str().unwrap()).unwrap();

    // ── (b) a `.zip` of the trio → ONE single-cell/anndata dataset (PK magic) ────
    // PK\x03\x04 is the `single-cell/anndata` magic (magic beats extension); the
    // zip's contents are unpacked inside the sandboxed converter — exercised for
    // REAL by `mtx_trio_converts_to_completion`.
    let zip_bytes = b"\x50\x4b\x03\x04 fake zip container holding a 10x trio";
    let form = Form::new().part("file", part("trio.zip", zip_bytes));
    let (status, body) = upload(&server, &trio, form).await;
    assert_eq!(status, 200, "zip upload succeeds: {body}");
    let datasets = body["datasets"].as_array().unwrap();
    assert_eq!(datasets.len(), 1, "the zip container is ONE dataset");
    let zip_ds = &datasets[0];
    assert_eq!(
        zip_ds["datatype"],
        serde_json::json!("single-cell/anndata"),
        "the PK-magic zip is typed single-cell/anndata (an accepted converter input)"
    );
    let zip_id = Uuid::parse_str(zip_ds["id"].as_str().unwrap()).unwrap();

    // ── BOTH datasets auto-enqueued an on-ingest converter job ──────────────────
    let pool = pool_for(&server).await;
    let (_trio_job, trio_type) = converter_job_for(&pool, trio_id)
        .await
        .expect("the matrix-mtx trio auto-enqueued a converter job");
    let (_zip_job, zip_type) = converter_job_for(&pool, zip_id)
        .await
        .expect("the anndata zip auto-enqueued a converter job");
    assert_eq!(trio_type, "analysis", "trio converter is an `analysis` job");
    assert_eq!(zip_type, "analysis", "zip converter is an `analysis` job");
}

/// The COMMITTED minimal 10x trio, as `(filename, bytes)` in Cell Ranger order.
/// It ships in git (~15 KB) — absence is a broken checkout, never a skip reason.
fn trio_fixture() -> Vec<(&'static str, Vec<u8>)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/dataset/fixtures/mtx_trio");
    TRIO_MEMBERS
        .into_iter()
        .map(|name| {
            let p = dir.join(name);
            let bytes = std::fs::read(&p).unwrap_or_else(|err| {
                panic!(
                    "committed 10x trio fixture missing at {}: {err} \
                     (regenerate with tests/dataset/fixtures/make_mtx_trio.py)",
                    p.display()
                )
            });
            (name, bytes)
        })
        .collect()
}

/// A real `.zip` bundle of the trio (STORED — the members are already gzipped), so
/// the converter's in-sandbox archive-extraction path runs on real bytes.
fn trio_zip() -> Vec<u8> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, bytes) in trio_fixture() {
        w.start_file(name, opts).expect("zip entry");
        w.write_all(&bytes).expect("zip write");
    }
    w.finish().expect("zip finish").into_inner()
}

#[tokio::test]
async fn mtx_trio_converts_to_completion() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let Some(_digest) = rootfs_gate(&server, &admin).await else {
        skip_no_rootfs("mtx_trio_converts_to_completion");
        return;
    };
    let pool = pool_for(&server).await;

    // libtiledb/tiledbsoma RESERVE a large VIRTUAL address space, and `RLIMIT_AS`
    // counts mmap reservations (not resident pages) — so even a 50×100 SOMA write
    // aborts (`std::bad_alloc`) under the default 4 GiB cap. Same raise the
    // supporting-convert suite makes; 64 GiB of virtual AS is not resident memory.
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

    // ── (a) the REAL trio → ONE matrix-mtx dataset that CONVERTS ────────────────
    let mut form = Form::new();
    for (name, bytes) in trio_fixture() {
        form = form.part("file", part(name, &bytes));
    }
    let (status, body) = upload(&server, &admin, form).await;
    assert_eq!(status, 200, "real trio upload succeeds: {body}");
    let trio_ds = &body["datasets"][0];
    assert_eq!(
        trio_ds["datatype"],
        serde_json::json!("single-cell/matrix-mtx"),
        "the real trio types as the mtx-trio Manifest datatype: {body}"
    );
    let trio_id = Uuid::parse_str(trio_ds["id"].as_str().unwrap()).unwrap();
    let (trio_job, _) = converter_job_for(&pool, trio_id)
        .await
        .expect("the real trio auto-enqueued a converter job");

    // ── (b) a REAL `.zip` of the same trio → the archive path also converts ─────
    let (status, body) = upload(
        &server,
        &admin,
        Form::new().part("file", part("trio.zip", &trio_zip())),
    )
    .await;
    assert_eq!(status, 200, "real zip upload succeeds: {body}");
    let zip_ds = &body["datasets"][0];
    assert_eq!(
        zip_ds["datatype"],
        serde_json::json!("single-cell/anndata"),
        "{body}"
    );
    let zip_id = Uuid::parse_str(zip_ds["id"].as_str().unwrap()).unwrap();
    let (zip_job, _) = converter_job_for(&pool, zip_id)
        .await
        .expect("the real zip auto-enqueued a converter job");

    // ── both converters run to COMPLETION on real matrix bytes ─────────────────
    // Polled through the SHARED `poll_job_terminal_api` (the single terminal-state
    // poller; it reads `GET /jobs/{id}`, whose `error` now carries the converter's
    // stderr tail, so a real failure is diagnosable from the assertion message).
    // 900s: a real SOMA write of the fixture is genuinely slower than the synthetic
    // reject-fast paths the 240s default was sized for.
    for (label, job) in [("trio", trio_job), ("zip", zip_job)] {
        let (status, detail) = poll_job_terminal_api(
            &server,
            &admin,
            &job.to_string(),
            std::time::Duration::from_secs(900),
        )
        .await;
        assert_eq!(
            status, "completed",
            "the {label} converter runs to completion: {}",
            detail["job"]["error"]
        );
    }

    // ── the conversion is CORRECT — not merely "a job completed" ───────────────
    for (label, dataset_id) in [("trio", trio_id), ("zip", zip_id)] {
        // (1) The harvested dataset metadata reports the FIXTURE's own dimensions,
        // read out of the matrix bytes by the converter and never declared by the
        // test. Two different delivery shapes (loose trio vs zip) must agree.
        let detail = dataset_detail(&server, &admin, dataset_id).await;
        let meta = &detail["metadata"];
        assert_eq!(
            meta["source_format"],
            serde_json::json!("10x_mtx"),
            "{label}: the converter read a 10x MTX trio (not a fallback path): {meta}"
        );
        assert_eq!(
            meta["n_obs"].as_i64(),
            Some(TRIO_CELLS),
            "{label}: the cataloged cell count is the trio's own: {meta}"
        );
        assert_eq!(
            meta["n_vars"].as_i64(),
            Some(TRIO_GENES),
            "{label}: the cataloged gene count is the trio's own: {meta}"
        );
        assert_eq!(
            meta["nnz"].as_i64(),
            Some(TRIO_NNZ),
            "{label}: every stored count in matrix.mtx.gz survived the conversion: {meta}"
        );
        assert_eq!(
            meta["x_state"],
            serde_json::json!("raw_counts"),
            "{label}: the trio's integer UMIs are classified as raw counts (no force-cast): {meta}"
        );
        assert_eq!(
            meta["has_gene_ids"],
            serde_json::json!(true),
            "{label}: the Ensembl gene ids in features.tsv.gz survived: {meta}"
        );

        // (2) The run cataloged the CSC expression projection and NO retired archive.
        //
        // INVERTED for ITEM-27, mirroring the sibling converter test: this asserted exactly
        // ONE artifact of the lossless multi-file archive type. That store was never a
        // product — it was the transpose BUFFER the CSC was streamed out of, and ITEM-27
        // replaced it with an out-of-core CSR->CSC transpose. Asserting zero (rather than
        // deleting the check) is what keeps this a regression guard: a converter that
        // quietly resurrected the write would otherwise pass unnoticed. The retired id is
        // named ONCE, in `RETIRED_STORE_DATATYPE` on the sibling file's model.
        let retired_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM artifacts WHERE dataset_id = $1 AND datatype = $2",
        )
        .bind(dataset_id)
        .bind(RETIRED_STORE_DATATYPE)
        .fetch_one(&pool)
        .await
        .expect("count retired-archive artifacts");
        assert_eq!(
            retired_count, 0,
            "{label}: ITEM-27 deleted the archive output — it was the transpose buffer, not a product"
        );
        // Positive control: the count query is looking at populated rows, so the zero
        // above is an absence and not an empty table.
        let total: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE dataset_id = $1")
            .bind(dataset_id)
            .fetch_one(&pool)
            .await
            .expect("count all artifacts");
        assert!(
            total > 0,
            "{label}: the run cataloged artifacts, so the zero above is an absence"
        );

        let expr_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM artifacts WHERE dataset_id = $1 \
             AND datatype = $2",
        )
        .bind(dataset_id)
        .bind(MATRIX_DATATYPE)
        .fetch_one(&pool)
        .await
        .expect("count expression artifacts");
        assert!(
            expr_count >= 1,
            "{label}: the CSC expression projection was cataloged"
        );

        // (3) The column axis's KEY ARTIFACT carries the trio's own per-column labels
        // — the strongest end-to-end check that the label member of the fixture was
        // read and aligned to the matrix COLUMNS. A transposed matrix, a dropped
        // label or a silently-substituted index fails here, where a bare "job
        // completed" would not.
        let axis_index_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM artifacts WHERE dataset_id = $1 AND datatype = 'metadata-column' \
             AND output_id = 'cells_index'",
        )
        .bind(dataset_id)
        .fetch_one(&pool)
        .await
        .expect("the import emitted the column-axis key artifact");
        // MIGRATED for ITEM-26: this used to `GET /data` and parse the body as JSON with a
        // `values` array. Metadata columns are Zarr now — a string column is `offsets` +
        // `values` MEMBERS of a directory, not a JSON document — so that read has no
        // successor in this shape.
        //
        // It asserts the DECLARED cardinality instead, and that is the right level for a
        // server-side test rather than a workaround: INV-1 says the server never opens a
        // byte for meaning, so a test of the SERVER should not either. Decoding the arrow
        // layout here would re-implement the client's reader in Rust and drift from it.
        // Cross-language decode parity is covered where it belongs — `artifactReader.test.ts`
        // reads writer-produced bytes.
        //
        // The check still discriminates: `structure.n` is what the producer declared
        // after reading the label member and aligning it to the matrix COLUMNS, so a
        // transposed matrix, a dropped label or a substituted index all move it.
        let index_structure: Value = sqlx::query_scalar(
            "SELECT structure FROM artifacts WHERE id = $1",
        )
        .bind(axis_index_id)
        .fetch_one(&pool)
        .await
        .expect("axis-index structure");
        assert_eq!(
            index_structure["axis"].as_str(),
            Some("cells"),
            "{label}: the axis index declares the axis it indexes"
        );
        assert_eq!(
            index_structure["n"].as_i64(),
            Some(TRIO_CELLS),
            "{label}: one label per matrix column (declared n)"
        );
        // Positive control: the bytes are actually served, so the declaration above is not
        // standing in for an artifact that failed to materialize.
        let index_head = server
            .client
            .get(server.api_url(&format!("/artifacts/{axis_index_id}/data/zarr.json")))
            .bearer_auth(&admin)
            .send()
            .await
            .expect("fetch the axis index's zarr.json");
        assert!(
            index_head.status().is_success(),
            "{label}: the axis-index member is served ({})",
            index_head.status()
        );
        // The label VALUES moved producer-side with ITEM-26. Asserting them here would
        // mean decoding an arrow string column (gunzip + u32 offsets + UTF-8 slice) in a
        // SERVER test — re-implementing the client's reader in Rust, where it would drift
        // from the real one. The CONTRIBUTING package's own suite (`tests/test_convert.py`)
        // converts this same fixture and asserts the emitted labels equal the source's,
        // which is where a decode belongs. What survives here is the end-to-end wiring:
        // the artifact exists, declares this axis, declares one entry per matrix column,
        // and serves.
    }
}

/// `GET /datasets/{id}` — the detail view carrying the harvested `metadata` bag.
async fn dataset_detail(server: &TestServer, token: &str, id: Uuid) -> Value {
    server
        .client
        .get(server.api_url(&format!("/datasets/{id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get dataset")
        .json()
        .await
        .expect("dataset detail json")
}
