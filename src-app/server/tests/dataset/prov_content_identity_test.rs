//! TEST-51 [ITEM-25, ITEM-1] — content identity. A multi-file artifact (a Zarr
//! prefix / BAM+bai) has exactly ONE merkle `content_hash` (order-independent,
//! member-sensitive), and that hash equals `content_hash_of_path` over the staged
//! directory (the P1 identity, no drift). Two runs whose scripts are byte-identical
//! dedup to ONE `provenance_code_blobs` row (a distinct script → a second row).

use uuid::Uuid;

use txresbench::modules::workstore::ingest::ingest_run_outputs;
use txresbench::modules::workstore::object_store::content_hash_of_path;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn multifile_merkle_is_single_hash_and_code_dedups() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "content identity project").await;
    let pool = pool_for(&server).await;

    // A multi-file artifact (3 chunk-dir members) ingests to ONE catalog row with
    // ONE merkle content_hash.
    let run = Uuid::new_v4();
    let (ws, _) = stage_manifest(
        &server,
        run,
        &[OutSpec::multifile(
            "umap",
            "single-cell/anndata",
            "chunked-sparse",
            &[
                ("a.bin", b"AAAA"),
                ("sub/b.bin", b"BBBB"),
                ("sub/c.bin", b"CCCC"),
            ],
            "artifact",
        )],
    )
    .await;
    let store = server_store(&server);
    let rows = ingest_run_outputs(&pool, &store, Some(project), None, run, None, &ws)
        .await
        .expect("ingest multi-file output");
    assert_eq!(rows.len(), 1, "a multi-file artifact is ONE catalog row");
    let art = &rows[0];
    assert!(art.is_multifile, "flagged multi-file");
    assert!(
        art.content_hash.starts_with("sha256:"),
        "one merkle content_hash"
    );

    // The merkle identity matches P1's `content_hash_of_path` over the same dir
    // (the drift guard against the workstore's identity).
    let recomputed = content_hash_of_path(&ws.join("outputs").join("umap"))
        .await
        .unwrap();
    assert_eq!(
        recomputed, art.content_hash,
        "merkle == content_hash_of_path (single identity, no drift)"
    );

    // Exactly one artifacts row for this run/output despite the merkle over 3 files.
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1, "one row for the whole multi-file artifact");

    // ---- code-blob dedup by sha256 ----
    let src = "import scanpy as sc\nsc.pp.filter_cells(adata, min_genes=200)\n";
    let sha_a = store_code(&pool, src, "python").await;
    let sha_b = store_code(&pool, src, "python").await; // byte-identical
    assert_eq!(
        sha_a, sha_b,
        "byte-identical scripts share a sha (the dedup key)"
    );

    // Two runs both reference the SAME code sha → still ONE code-blob row.
    for _ in 0..2 {
        let rid = Uuid::new_v4();
        let mut r = run_template(rid, Some(project), None);
        r.code_sha256 = Some(sha_a.clone());
        insert_run(&pool, &r).await;
    }
    let dedup: i64 =
        sqlx::query_scalar("SELECT count(*) FROM provenance_code_blobs WHERE sha256 = $1")
            .bind(&sha_a)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        dedup, 1,
        "two runs, byte-identical code → ONE deduped code-blob row"
    );

    // A DIFFERENT script → a distinct sha → a second row.
    let sha_c = store_code(&pool, "print('different')\n", "python").await;
    assert_ne!(sha_a, sha_c, "different source → different sha");
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM provenance_code_blobs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(total, 2, "two distinct code blobs total");
}
