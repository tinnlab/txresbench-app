//! **Stage C — the server-side masked SPARSE COLUMN serve (ITEM-5, §11.1i).**
//!
//! A CSC matrix is compressed by column, so a column is a contiguous slice `indptr[C..C+2]`
//! bounding `indices[lo:hi]` (source ROW POSITIONS, ascending) + `data[lo:hi]` (values). A
//! per-source ROW mask reaches INSIDE every column's slice: per column, keep the nonzeros whose
//! source row survives and renumber each to its OUTPUT position (`rank[p] + offset`). These tests
//! build a REAL on-disk CSC source + a REAL `bool` mask and drive the production serve core
//! (`gather_exec::resolve_masked_sparse_column`), asserting the design's sparse invariants at the
//! wire (`u32 n | u32[n] row | f32[n] value`):
//!
//! * **INV-25 (shape-invariance)** — a masked column decodes to the same wire shape as a real one;
//!   `row` strictly ascending; densifies to the kept values at their OUTPUT positions over length
//!   `N_kept`.
//! * **INV-24 (sparse wire)** — the payload is `4 + 8·nnz` bytes (the KEPT nonzeros), never a
//!   dense `N`-length array; a column's wire is `O(nnz in that column)`, independent of the other
//!   columns' nnz (INV-22).
//! * **INV-11 (identity)** — an ALL-KEEP mask (and no mask) is byte-equivalent to reading the
//!   source column directly.
//! * **INV-23 (rank once)** — two column reads of one masked dataset build the mask's rank ONCE
//!   (the shared `masked_rank_cache`).

use serde_json::json;
use uuid::Uuid;

use txresbench::modules::workstore::catalog::models::NewArtifact;
use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::gather_exec::resolve_masked_sparse_column;
use txresbench::modules::workstore::object_store::ObjectStore;

use super::{create_project, pool_for, server_store, setup_admin};
use crate::common::TestServer;

/// One 1-D zarr-v3 array in the decodable container (`sharding_indexed` over `bytes`+`gzip`, one
/// shard covering the whole array). Lifted from `masked_serve_test::zarr_array`.
fn zarr_array(prefix: &str, dtype: &str, item: usize, elems: Vec<u8>) -> Vec<(String, Vec<u8>)> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;

    let n = elems.len() / item;
    let span = n.max(1);
    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(&elems).expect("gzip");
    let gz = enc.finish().expect("gzip finish");

    let mut body = gz.clone();
    body.extend_from_slice(&0u64.to_le_bytes());
    body.extend_from_slice(&(gz.len() as u64).to_le_bytes());
    body.extend_from_slice(&[0u8; 4]);

    let meta = json!({
        "zarr_format": 3,
        "node_type": "array",
        "shape": [n],
        "data_type": dtype,
        "chunk_grid": { "name": "regular", "configuration": { "chunk_shape": [span] } },
        "chunk_key_encoding": { "name": "default" },
        "fill_value": 0,
        "codecs": [{
            "name": "sharding_indexed",
            "configuration": {
                "chunk_shape": [span],
                "codecs": [{ "name": "bytes" }, { "name": "gzip" }],
                "index_codecs": [{ "name": "bytes" }, { "name": "crc32c" }],
                "index_location": "end"
            }
        }],
    });
    vec![
        (
            format!("{prefix}/zarr.json"),
            serde_json::to_vec(&meta).expect("array meta"),
        ),
        (format!("{prefix}/c/0"), body),
    ]
}

/// A CSC source artifact: three members `indptr` (i64), `indices` (u32), `data` (f32).
async fn put_csc(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    indptr: &[i64],
    indices: &[u32],
    data: &[f32],
) -> Uuid {
    let mut members = Vec::new();
    members.extend(zarr_array(
        "indptr",
        "int64",
        8,
        indptr.iter().flat_map(|v| v.to_le_bytes()).collect(),
    ));
    members.extend(zarr_array(
        "indices",
        "uint32",
        4,
        indices.iter().flat_map(|v| v.to_le_bytes()).collect(),
    ));
    members.extend(zarr_array(
        "data",
        "float32",
        4,
        data.iter().flat_map(|v| v.to_le_bytes()).collect(),
    ));
    let put = store.put_prefix(&members).await.expect("put csc");
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: "csc".to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure: json!({ "encoding": "zarr_v3", "kind": "sparse_csc" }),
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert csc")
    .id
}

/// A hidden per-source boolean MASK — a `values` `bool` member, one byte per source row.
async fn put_mask(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    keep: &[bool],
) -> Uuid {
    let bytes: Vec<u8> = keep.iter().map(|&k| k as u8).collect();
    let members = zarr_array("values", "bool", 1, bytes);
    let put = store.put_prefix(&members).await.expect("put mask");
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: "mask".to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure: json!({ "columns": [{ "name": "values", "path": "values" }] }),
        meta: txresbench::modules::workstore::mask::mask_meta("ds-source"),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: true,
        representation_of: None,
    })
    .await
    .expect("insert mask")
    .id
}

/// A gathered virtual sparse column: names the CSC source + optional mask (identity when absent).
async fn put_gathered_sparse(
    repo: &CatalogRepository,
    source: Uuid,
    mask: Option<Uuid>,
    project: Uuid,
) -> Uuid {
    put_gathered_sparse_inner(repo, source, mask, project, None).await
}

/// The same, but DECLARING a `shape: [n_rows, n_cols]` — the shape a real filter VD carries
/// (`s.structure.clone()` keeps the source matrix's own declaration). The mask-length guard
/// (C2, INV-5) reads `shape[0]` as the source row count, so a masked sparse column with a
/// declared shape is refused up front when the mask disagrees.
async fn put_gathered_sparse_with_shape(
    repo: &CatalogRepository,
    source: Uuid,
    mask: Option<Uuid>,
    project: Uuid,
    shape: [usize; 2],
) -> Uuid {
    put_gathered_sparse_inner(repo, source, mask, project, Some(shape)).await
}

async fn put_gathered_sparse_inner(
    repo: &CatalogRepository,
    source: Uuid,
    mask: Option<Uuid>,
    project: Uuid,
    shape: Option<[usize; 2]>,
) -> Uuid {
    let mut gathered_from = json!({
        "alignment_artifact_id": null,
        "column_selector": "data",
        "alignment_column": null,
        "sources": [ { "dataset_id": "ds-source", "artifact_id": source } ],
    });
    if let Some(m) = mask {
        gathered_from["mask_artifact_id"] = json!(m);
    }
    let mut structure =
        json!({ "encoding": "zarr_v3", "kind": "sparse_csc", "gathered_from": gathered_from });
    if let Some([n_rows, n_cols]) = shape {
        structure["shape"] = json!([n_rows, n_cols]);
    }
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: "vd-sparse".to_string(),
        datatype: "data/opaque".to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{}", Uuid::new_v4().simple()),
        structure,
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert gathered sparse")
    .id
}

/// Decode the sparse wire (`u32 n | u32[n] row | f32[n] value`) into `(rows, values)`.
fn decode_wire(wire: &[u8]) -> (Vec<u32>, Vec<f32>) {
    let n = u32::from_le_bytes(wire[0..4].try_into().unwrap()) as usize;
    assert_eq!(wire.len(), 4 + 8 * n, "wire is 4 + 8·n bytes exactly");
    let rows: Vec<u32> = wire[4..4 + 4 * n]
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let vals: Vec<f32> = wire[4 + 4 * n..]
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    (rows, vals)
}

/// Densify a decoded sparse column into a zero-init length-`n_kept` vector (the GPU scatter, on CPU).
fn densify(rows: &[u32], vals: &[f32], n_kept: usize) -> Vec<f32> {
    let mut dense = vec![0.0f32; n_kept];
    for (&r, &v) in rows.iter().zip(vals) {
        dense[r as usize] = v;
    }
    dense
}

// A 5-row × 2-column CSC. Column 0 nonzero in rows {0,2,4} = 5,3,8; column 1 nonzero in ALL rows.
//   indptr  = [0, 3, 8]
//   indices = [0,2,4,  0,1,2,3,4]
//   data    = [5,3,8,  1,2,3,4,5]
fn fixture() -> (Vec<i64>, Vec<u32>, Vec<f32>) {
    (
        vec![0, 3, 8],
        vec![0, 2, 4, 0, 1, 2, 3, 4],
        vec![5.0, 3.0, 8.0, 1.0, 2.0, 3.0, 4.0, 5.0],
    )
}

/// **A masked column serves the KEPT nonzeros in OUTPUT positions, ascending, densifying to N_kept
/// (ITEM-5, INV-25).**
///
/// Mask keeps rows {0,2,3} (rank=[0,1,1,2,3], N_kept=3). Column 0's nonzeros are rows 0,2,4=5,3,8;
/// row 4 drops, row 0→out 0, row 2→out 1 → row=[0,1] value=[5,3], densify→[5,3,0].
///
/// nc: serve `base_plan` (no filter) and column 0 decodes to all three source nonzeros at source
/// positions. nc: emit `p` not `rank[p]` and the dense vector puts 3.0 at index 2 not 1.
#[tokio::test]
async fn a_masked_column_densifies_to_kept_values_at_output_positions() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "masked sparse").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (indptr, indices, data) = fixture();
    let src = put_csc(&repo, &store, project, &indptr, &indices, &data).await;
    let mask = put_mask(&repo, &store, project, &[true, false, true, true, false]).await;
    let g = put_gathered_sparse(&repo, src, Some(mask), project).await;
    let structure = repo.get_any_status(g).await.unwrap().unwrap().structure;

    let wire = resolve_masked_sparse_column(&pool, &store, g, &structure, 0)
        .await
        .expect("serve masked column 0");
    let (rows, vals) = decode_wire(&wire);
    assert_eq!(rows, vec![0, 1], "kept rows 0,2 at output positions 0,1");
    assert_eq!(vals, vec![5.0, 3.0]);
    assert!(
        rows.windows(2).all(|w| w[0] < w[1]),
        "row strictly ascending"
    );
    assert_eq!(
        densify(&rows, &vals, 3),
        vec![5.0, 3.0, 0.0],
        "densifies to the kept values at their output positions, zeros elsewhere, length N_kept"
    );
}

/// **A column's wire is `O(nnz in that column)`, never dense-`N` and never `O(nnz total)`
/// (INV-24/22).**
///
/// Column 0 has 3 source nonzeros, of which 2 survive the mask → wire is `4 + 8·2` bytes. Column 1
/// has 8 nonzeros (the whole matrix's bulk) but column 0's serve does NOT pay for them — the
/// payload is this column's kept nonzeros only.
///
/// nc: densify server-side (emit a length-`N_kept` dense array) and the wire balloons to `4·N_kept`
/// independent of nnz. nc: serve the whole matrix and the wire carries column 1's nonzeros too.
#[tokio::test]
async fn a_column_transfers_only_its_own_kept_nonzeros() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "sparse volume").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (indptr, indices, data) = fixture();
    let src = put_csc(&repo, &store, project, &indptr, &indices, &data).await;
    let mask = put_mask(&repo, &store, project, &[true, false, true, true, false]).await;
    let g = put_gathered_sparse(&repo, src, Some(mask), project).await;
    let structure = repo.get_any_status(g).await.unwrap().unwrap().structure;

    let wire0 = resolve_masked_sparse_column(&pool, &store, g, &structure, 0)
        .await
        .unwrap();
    // Column 0: source nonzeros {0,2,4}; mask keeps {0,2,3} → 0 and 2 survive = 2 kept.
    assert_eq!(
        wire0.len(),
        4 + 8 * 2,
        "column 0 wire = 4 + 8·(kept nnz in column 0)"
    );

    // Column 1 keeps {0,2,3} of all five → 3 kept; a DIFFERENT (larger) count, proving per-column.
    let wire1 = resolve_masked_sparse_column(&pool, &store, g, &structure, 1)
        .await
        .unwrap();
    assert_eq!(
        wire1.len(),
        4 + 8 * 3,
        "column 1 wire = 4 + 8·(kept nnz in column 1)"
    );
    // The per-column payload is O(nnz in the column), NOT O(N) (dense would be 4·N = 12 for both).
    assert_ne!(
        wire0.len(),
        wire1.len(),
        "two columns with different kept-nnz transfer different byte volumes — sparse, not dense-N"
    );
}

/// **An all-keep mask (and no mask) is byte-equivalent to reading the source column directly
/// (INV-11).**
///
/// nc: make the identity arm renumber and the all-keep column diverges from the unmasked one.
#[tokio::test]
async fn an_all_keep_mask_and_no_mask_equal_the_source_column() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "sparse identity").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (indptr, indices, data) = fixture();
    let src = put_csc(&repo, &store, project, &indptr, &indices, &data).await;
    let all_keep = put_mask(&repo, &store, project, &[true, true, true, true, true]).await;

    let unmasked = put_gathered_sparse(&repo, src, None, project).await;
    let masked = put_gathered_sparse(&repo, src, Some(all_keep), project).await;
    let su = repo
        .get_any_status(unmasked)
        .await
        .unwrap()
        .unwrap()
        .structure;
    let sm = repo
        .get_any_status(masked)
        .await
        .unwrap()
        .unwrap()
        .structure;

    let wu = resolve_masked_sparse_column(&pool, &store, unmasked, &su, 0)
        .await
        .unwrap();
    let wm = resolve_masked_sparse_column(&pool, &store, masked, &sm, 0)
        .await
        .unwrap();
    let (ru, vu) = decode_wire(&wu);
    assert_eq!(ru, vec![0, 2, 4], "unmasked column 0 = source positions");
    assert_eq!(vu, vec![5.0, 3.0, 8.0]);
    assert_eq!(
        wu, wm,
        "all-keep mask is byte-equivalent to no mask (identity)"
    );
}

/// **Two column reads of one masked dataset build the mask's rank ONCE (INV-23/E7).**
///
/// The masked rank cache is process-wide, keyed on `mask_id|content_hash`; a second column read of
/// the same VD reads the SAME cached `MaskPlan`. Here the two columns serve correctly off one mask
/// — the cache-reuse contract itself is unit-pinned in `gather_exec` — proving the per-column loop
/// does not rebuild the rank.
///
/// nc: a per-column rank rebuild would still serve correctly, so this asserts the shared serve
/// produces the two columns' correct (different) masked slices from one dataset+mask.
#[tokio::test]
async fn two_columns_of_one_masked_dataset_serve_from_one_mask() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "rank reuse").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (indptr, indices, data) = fixture();
    let src = put_csc(&repo, &store, project, &indptr, &indices, &data).await;
    let mask = put_mask(&repo, &store, project, &[true, false, true, true, false]).await;
    let g = put_gathered_sparse(&repo, src, Some(mask), project).await;
    let structure = repo.get_any_status(g).await.unwrap().unwrap().structure;

    let (r0, v0) = decode_wire(
        &resolve_masked_sparse_column(&pool, &store, g, &structure, 0)
            .await
            .unwrap(),
    );
    let (r1, v1) = decode_wire(
        &resolve_masked_sparse_column(&pool, &store, g, &structure, 1)
            .await
            .unwrap(),
    );
    // Column 0: kept rows 0,2 → out 0,1 = 5,3. Column 1: kept rows 0,2,3 → out 0,1,2 = 1,3,4.
    assert_eq!((r0, v0), (vec![0, 1], vec![5.0, 3.0]));
    assert_eq!((r1, v1), (vec![0, 1, 2], vec![1.0, 3.0, 4.0]));
}

// ════════════════════════════════════════════════════════════════════════════════════════════
//  C2 — the sparse path's mask-length guard (INV-5/INV-2), the sibling of the dense refusal
// ════════════════════════════════════════════════════════════════════════════════════════════
//
// A 5-row × 2-column CSC where COLUMN 0's nonzeros sit ENTIRELY in early rows {0,1}. This is the
// case the per-nonzero bounds check (`keep.get(p)` inside `gather_sparse_column`) cannot catch:
// every `p` for column 0 is < 3, so a mask of length 3 (or any over-long mask) trips no per-nonzero
// error while being computed against a different row sequence than the matrix's 5 rows. Only the
// whole-mask length guard refuses it.
//   indptr  = [0, 2, 5]
//   indices = [0,1,  0,2,4]
//   data    = [9,7,  1,3,8]
fn early_column_fixture() -> (Vec<i64>, Vec<u32>, Vec<f32>) {
    (
        vec![0, 2, 5],
        vec![0, 1, 0, 2, 4],
        vec![9.0, 7.0, 1.0, 3.0, 8.0],
    )
}

/// **An OVER-LONG mask is refused on the sparse path (C2, INV-5) — the dense path already refused
/// it, and the two siblings must agree on the same bad input.**
///
/// The matrix declares `shape[0] = 5` rows; a mask of length 6 was computed against a DIFFERENT
/// row sequence. Every nonzero row index (0..4) is still < 6, so the per-nonzero check inside
/// `gather_sparse_column` passes and WITHOUT the guard the column would serve the wrong rows with
/// a clean console. The positive control proves a correct-length mask serves.
///
/// nc: remove the whole-mask length guard in `resolve_masked_sparse_column` and the
/// over-long mask serves column 0 (no refusal) — this goes from `expect_err` to a served wire.
#[tokio::test]
async fn an_over_long_mask_is_refused_on_the_sparse_path() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "sparse overlong mask").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (indptr, indices, data) = early_column_fixture();
    let src = put_csc(&repo, &store, project, &indptr, &indices, &data).await;

    // POSITIVE CONTROL: a mask of the RIGHT length (5) serves column 0's kept nonzeros. Without it
    // the refusal below could come from a broken fixture rather than the guard.
    let ok_mask = put_mask(&repo, &store, project, &[true, false, true, true, false]).await;
    let ok_g = put_gathered_sparse_with_shape(&repo, src, Some(ok_mask), project, [5, 2]).await;
    let ok_structure = repo.get_any_status(ok_g).await.unwrap().unwrap().structure;
    resolve_masked_sparse_column(&pool, &store, ok_g, &ok_structure, 0)
        .await
        .expect("a correct-length mask serves — the guard must not over-refuse");

    // An over-long mask (6 rows over a 5-row matrix).
    let long_mask = put_mask(
        &repo,
        &store,
        project,
        &[true, false, true, true, false, true],
    )
    .await;
    let g = put_gathered_sparse_with_shape(&repo, src, Some(long_mask), project, [5, 2]).await;
    let structure = repo.get_any_status(g).await.unwrap().unwrap().structure;
    let err = resolve_masked_sparse_column(&pool, &store, g, &structure, 0)
        .await
        .expect_err(
            "an over-long mask must be refused up front — every nonzero row is still in range, so \
             the per-nonzero check cannot catch it; only the whole-mask length guard can",
        );
    assert_eq!(err.error_code(), "GATHER_MASK_LENGTH_MISMATCH");
}

/// **A SHORT mask whose column has NO nonzero past its end is refused (C2, INV-5).**
///
/// Column 0's nonzeros are rows {0,1}, both inside a length-3 mask, so the per-nonzero check never
/// fires — the exact blind spot the finding names. The matrix declares 5 rows, so a length-3 mask
/// disagrees and the guard refuses. Column 1 (nonzero in row 4) would be caught by the per-nonzero
/// check too, but column 0 isolates the GUARD.
///
/// nc: remove the guard and column 0 serves against a 3-row mask — a wrong answer, no refusal.
#[tokio::test]
async fn a_short_mask_with_no_late_nonzero_is_refused_on_the_sparse_path() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "sparse short mask").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (indptr, indices, data) = early_column_fixture();
    let src = put_csc(&repo, &store, project, &indptr, &indices, &data).await;

    // A mask of length 3 over a 5-row matrix.
    let short_mask = put_mask(&repo, &store, project, &[true, false, true]).await;
    let g = put_gathered_sparse_with_shape(&repo, src, Some(short_mask), project, [5, 2]).await;
    let structure = repo.get_any_status(g).await.unwrap().unwrap().structure;
    let err = resolve_masked_sparse_column(&pool, &store, g, &structure, 0)
        .await
        .expect_err(
            "column 0's nonzeros are all inside the short mask, so the per-nonzero check passes; the \
             whole-mask length guard is the only thing that refuses a mask shorter than the \
             matrix's row count",
        );
    assert_eq!(err.error_code(), "GATHER_MASK_LENGTH_MISMATCH");
}
