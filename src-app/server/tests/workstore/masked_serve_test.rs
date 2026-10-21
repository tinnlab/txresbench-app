//! **Stage B — the server-side masked SERVE core (ITEM-3 / ITEM-4 / ITEM-9).**
//!
//! A filter virtual dataset is a LONE source read through a hidden per-source boolean mask
//! (`alignment_artifact_id: null`, `mask_artifact_id: <mask>`). These tests build such a VD
//! against a REAL on-disk zarr source + a REAL `bool` mask member and drive the production
//! resolver (`gather_exec::resolve` / `resolve_shared`), asserting the design's serve-core
//! invariants at the bytes:
//!
//! * **INV-25 (shape-invariance)** — a masked numeric column decodes to the same shape as the
//!   unmasked one; only the rows (filter → in output order) and the length (`N → N_kept`)
//!   differ, and the kept rows come out ASCENDING.
//! * **INV-11 (identity fast path)** — an ALL-KEEP mask is byte-equivalent to NO mask, which is
//!   byte-equivalent to the source's own bytes. The mask machinery cannot perturb the identity
//!   read.
//! * **INV-17 (`zarr.json` RESOLVED)** — the served declaration's shape is `N_kept`, not the
//!   source count, on BOTH the array node and the group node — from the same resolution that
//!   produced the chunks.
//! * **INV-31 (cache keyed on the mask)** — two VDs differing ONLY by mask never serve each
//!   other's rows.
//!
//! Every fixture member is written in the container the gather is permitted to decode
//! (`sharding_indexed` with a `bytes`+`gzip` inner chain), matching `gather_scale_test`.

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::gather_exec::{resolve, resolve_shared, ResolvedGather};
use cytoanalyst::modules::workstore::gathered::ResolutionCache;
use cytoanalyst::modules::workstore::object_store::ObjectStore;
use cytoanalyst::modules::workstore::virtual_dataset::{gathered_structure, KeyIdentity};

use super::{create_project, pool_for, server_store, setup_admin};
use crate::common::TestServer;

const AXIS: &str = "rows";

/// One 1-D zarr-v3 array in the decodable container: `sharding_indexed` over `bytes`+`gzip`,
/// one shard covering the whole array. Lifted from `gather_scale_test::zarr_array`.
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

async fn put_multifile(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    members: Vec<(String, Vec<u8>)>,
    structure: Value,
    meta: Value,
) -> Uuid {
    let put = store.put_prefix(&members).await.expect("put_prefix");
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        structure,
        meta,
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert multifile")
    .id
}

/// A float32 source column of `vals`, one `values` member, on axis `rows`.
async fn put_source(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    vals: &[f32],
) -> Uuid {
    let bytes: Vec<u8> = vals.iter().flat_map(|v| v.to_le_bytes()).collect();
    let members = zarr_array("values", "float32", 4, bytes);
    put_multifile(
        repo,
        store,
        project,
        output_id,
        members,
        json!({
            "encoding": "zarr_v3", "kind": "table", "axis": AXIS, "n": vals.len(),
            "columns": [{ "name": "values", "path": "values", "kind": "numeric",
                          "dtype": "float32", "shape": [vals.len()], "axis": AXIS, "n": vals.len() }],
            "arrays": [],
        }),
        json!({}),
    )
    .await
}

/// A hidden per-source boolean MASK: a `values` `bool` member, one byte per source row.
async fn put_mask(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    output_id: &str,
    keep: &[bool],
) -> Uuid {
    let bytes: Vec<u8> = keep.iter().map(|&k| k as u8).collect();
    let members = zarr_array("values", "bool", 1, bytes);
    let put = store.put_prefix(&members).await.expect("put mask");
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: Some(put.object_key.as_str().to_string()),
        is_multifile: true,
        content_hash: put.content_hash.clone(),
        // A real mask store's member is `values` (a metadata-column's single member).
        structure: json!({ "columns": [{ "name": "values", "path": "values" }] }),
        meta: cytoanalyst::modules::workstore::mask::mask_meta("ds-source"),
        // Role is irrelevant to the serve path (it reads the mask by id); the one-per-VD
        // storage constraint is `mask_storage_test`'s concern, so keep this fixture minimal.
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

/// A single-source gathered column, optionally masked. `n_source` is the SOURCE row count the
/// writer stamps at creation (the serve path resolves it to `N_kept`).
async fn put_gathered(
    repo: &CatalogRepository,
    source: Uuid,
    mask: Option<Uuid>,
    project: Uuid,
    output_id: &str,
    n_source: usize,
) -> Uuid {
    let mut gathered_from = json!({
        "alignment_artifact_id": null,
        "column_selector": "values",
        "alignment_column": null,
        "sources": [ { "dataset_id": "ds-source", "artifact_id": source } ],
    });
    if let Some(m) = mask {
        gathered_from["mask_artifact_id"] = json!(m);
    }
    let structure = gathered_structure(
        "float32",
        None,
        AXIS,
        n_source,
        KeyIdentity::Unpinned,
        gathered_from,
    );
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: output_id.to_string(),
        datatype: "data/opaque".to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{}", "f".repeat(64)),
        structure,
        meta: json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some((n_source * 4) as i64),
        created_by: None,
        hidden: false,
        representation_of: None,
    })
    .await
    .expect("insert gathered")
    .id
}

/// Decode a resolved flat float32 column: every chunk, concatenated, trimmed to `n × 4`.
fn decode_f32(resolved: &ResolvedGather) -> Vec<f32> {
    let mut bytes = Vec::new();
    for g in 0..resolved.chunk_count() {
        bytes.extend_from_slice(&resolved.member(&format!("values/c/{g}")).unwrap().unwrap());
    }
    bytes.truncate(resolved.n * 4);
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

async fn structure_of(repo: &CatalogRepository, id: Uuid) -> Value {
    repo.get_any_status(id)
        .await
        .expect("read")
        .expect("row")
        .structure
}

/// **A masked numeric column serves the KEPT rows in output order, at `N_kept` (ITEM-3, INV-25).**
///
/// The mask keeps rows 0,2,3 of a 5-row source, so the column decodes to exactly those three
/// values, ascending in output order — filter + rank + segment-offset in one pass.
///
/// nc: delete the `MaskPlan::apply` filter (serve `base_plan`) and the column decodes to all
/// five source values — the mask would be inert. nc: index the mask in reverse and the kept
/// values arrive permuted.
#[tokio::test]
async fn a_masked_numeric_column_serves_the_kept_rows_in_output_order() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "masked serve").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let vals = [10.0f32, 11.0, 12.0, 13.0, 14.0];
    let keep = [true, false, true, true, false]; // rows 0,2,3 → [10,12,13]
    let src = put_source(&repo, &store, project, "src", &vals).await;
    let mask = put_mask(&repo, &store, project, "mask", &keep).await;
    let g = put_gathered(&repo, src, Some(mask), project, "masked", vals.len()).await;

    let structure = structure_of(&repo, g).await;
    let resolved = resolve(&pool, &store, g, &structure)
        .await
        .expect("resolve");

    assert_eq!(resolved.n, 3, "N_kept = kept rows");
    assert_eq!(
        decode_f32(&resolved),
        vec![10.0, 12.0, 13.0],
        "the masked column serves exactly the kept rows, ascending in output order"
    );
}

/// **The identity fast path is byte-equivalent to the general path (INV-11).**
///
/// Three reads of the SAME source column must produce identical bytes: (a) an unmasked gathered
/// column, (b) an ALL-KEEP masked gathered column, (c) the source's own stored bytes. The mask
/// machinery cannot perturb the identity read.
///
/// nc: make `MaskPlan::apply` drop or reorder an all-true keep vector and arm (b) diverges from
/// (a)/(c).
#[tokio::test]
async fn an_all_keep_mask_is_byte_equivalent_to_no_mask_and_to_the_source() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "identity path").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let vals = [1.0f32, 2.0, 3.0, 4.0];
    let src = put_source(&repo, &store, project, "src", &vals).await;
    let all_keep = put_mask(&repo, &store, project, "allkeep", &[true, true, true, true]).await;

    let unmasked = put_gathered(&repo, src, None, project, "unmasked", vals.len()).await;
    let masked = put_gathered(&repo, src, Some(all_keep), project, "allkeep-g", vals.len()).await;

    let a = decode_f32(
        &resolve(
            &pool,
            &store,
            unmasked,
            &structure_of(&repo, unmasked).await,
        )
        .await
        .unwrap(),
    );
    let b = decode_f32(
        &resolve(&pool, &store, masked, &structure_of(&repo, masked).await)
            .await
            .unwrap(),
    );
    assert_eq!(a, vals.to_vec(), "unmasked gather == source values");
    assert_eq!(
        b,
        vals.to_vec(),
        "all-keep mask == source values (identity)"
    );
    assert_eq!(a, b, "the all-keep mask is byte-equivalent to no mask");
}

/// **A gathered masked column's `zarr.json` is RESOLVED to `N_kept` (ITEM-9, INV-17).**
///
/// Both the array node (`values/zarr.json`) and the group node (`zarr.json`
/// `attributes.cyto`) declare the kept-row count, not the source count — from the same
/// resolution that produced the chunks.
///
/// nc: serve the structure-only `zarr.json` (source `n`) and the shape reads 5 not 3.
#[tokio::test]
async fn a_masked_columns_zarr_json_shape_is_the_kept_count() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "resolved zarr").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let vals = [10.0f32, 11.0, 12.0, 13.0, 14.0];
    let keep = [true, false, true, true, false]; // 3 kept
    let src = put_source(&repo, &store, project, "src", &vals).await;
    let mask = put_mask(&repo, &store, project, "mask", &keep).await;
    let g = put_gathered(&repo, src, Some(mask), project, "masked", vals.len()).await;

    let resolved = resolve(&pool, &store, g, &structure_of(&repo, g).await)
        .await
        .unwrap();

    let arr: Value =
        serde_json::from_slice(&resolved.member("values/zarr.json").unwrap().unwrap()).unwrap();
    assert_eq!(arr["shape"], json!([3]), "array node shape is N_kept");

    let grp: Value =
        serde_json::from_slice(&resolved.member("zarr.json").unwrap().unwrap()).unwrap();
    assert_eq!(
        grp["attributes"]["cyto"]["n"],
        json!(3),
        "group node's resolved declaration also carries N_kept, not the source count"
    );
    assert_eq!(
        grp["attributes"]["cyto"]["columns"][0]["shape"],
        json!([3]),
        "the column entry's shape is resolved too — no drift between array and group nodes"
    );
}

/// **Two VDs differing ONLY by mask never serve each other's rows (ITEM-4, INV-31).**
///
/// Same source, same everything, two different masks → two different resolutions. The mask id
/// rides `structure.gathered_from.mask_artifact_id`, which `resolution_key` hashes, so the
/// process cache keys them apart; a mutation that dropped the mask from the key would let the
/// second VD serve the first's warm rows (right length, wrong rows).
///
/// nc: strip `mask_artifact_id` from `resolution_key`'s inputs and the second `resolve_shared`
/// returns VD-A's rows.
#[tokio::test]
async fn two_vds_differing_only_by_mask_do_not_serve_each_others_rows() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "mask cache key").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let vals = [10.0f32, 11.0, 12.0, 13.0, 14.0];
    let src = put_source(&repo, &store, project, "src", &vals).await;
    let mask_a = put_mask(
        &repo,
        &store,
        project,
        "mask-a",
        &[true, true, false, false, false],
    )
    .await;
    let mask_b = put_mask(
        &repo,
        &store,
        project,
        "mask-b",
        &[false, false, false, true, true],
    )
    .await;

    let g_a = put_gathered(&repo, src, Some(mask_a), project, "vd-a", vals.len()).await;
    let g_b = put_gathered(&repo, src, Some(mask_b), project, "vd-b", vals.len()).await;

    let cache = ResolutionCache::<ResolvedGather>::new(64 * 1024 * 1024);
    let struct_a = structure_of(&repo, g_a).await;
    let struct_b = structure_of(&repo, g_b).await;

    // Warm VD-A first so a mask-blind key would hand its rows to VD-B.
    let ra = resolve_shared(&pool, &store, g_a, &struct_a, &cache)
        .await
        .unwrap();
    let rb = resolve_shared(&pool, &store, g_b, &struct_b, &cache)
        .await
        .unwrap();

    assert_eq!(decode_f32(&ra), vec![10.0, 11.0], "VD-A keeps rows 0,1");
    assert_eq!(
        decode_f32(&rb),
        vec![13.0, 14.0],
        "VD-B keeps rows 3,4 — NOT VD-A's warm rows; the mask is in the cache key"
    );
}

/// **A masked numeric column round-trips to exactly the kept rows, chunk-served whole (ITEM-6,
/// TEST-39, INV-12).**
///
/// The masked numeric column equals the SOURCE values at the kept rows in output order, and each
/// served member is a whole CHUNK of the resolved grid — a stored/gathered read never decodes to a
/// row-exact partial (INV-12): every `values/c/<g>` is a full chunk, the last padded to width. The
/// row-addressed `offset`+`limit` request surface (§11.1c) is intentionally NOT added here — Stage
/// B already serves per-chunk members (each member IS one chunk, so a client reading rows maps them
/// to covering chunks and every response is chunk-aligned by construction); the additive
/// `offset`+`limit` endpoint (DEC-4, two request surfaces) is deferred to the row-addressed-API item
/// and is not part of the per-dtype masked-read core.
#[tokio::test]
async fn a_masked_numeric_column_round_trips_and_serves_whole_chunks() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "masked numeric roundtrip").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    // 10 rows over a 4-wide grid → 3 chunks (4,4,2). Keep a scattered subset spanning boundaries.
    let vals: Vec<f32> = (0..10).map(|i| i as f32 * 10.0).collect();
    let keep = [
        true, false, true, true, false, true, false, true, true, false,
    ]; // 6 kept
    let src = put_source(&repo, &store, project, "src", &vals).await;
    let mask = put_mask(&repo, &store, project, "mask", &keep).await;
    let g = put_gathered(&repo, src, Some(mask), project, "masked", vals.len()).await;

    let mut structure = structure_of(&repo, g).await;
    structure["chunk_elements"] = json!(4); // force a multi-chunk grid on the resolved column
    let resolved = resolve(&pool, &store, g, &structure)
        .await
        .expect("resolve");

    // Round-trip: kept source values in output order.
    let expected: Vec<f32> = vals
        .iter()
        .zip(keep.iter())
        .filter_map(|(v, &k)| k.then_some(*v))
        .collect();
    assert_eq!(resolved.n, 6, "six rows kept");
    assert_eq!(
        decode_f32(&resolved),
        expected,
        "kept source values, output order"
    );

    // Chunk-aligned (INV-12): each served member is a WHOLE chunk (4 elements = 16 bytes), the
    // last padded to full width — never a row-exact partial the server had to decode to produce.
    for gi in 0..resolved.chunk_count() {
        let bytes = resolved.member(&format!("values/c/{gi}")).unwrap().unwrap();
        assert_eq!(
            bytes.len(),
            4 * 4,
            "chunk {gi} is a whole 4-element chunk (chunk-aligned response, not row-exact)"
        );
    }
}
