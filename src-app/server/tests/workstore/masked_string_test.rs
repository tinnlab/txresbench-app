//! **Stage C — the masked STRING (split utf8) serve (ITEM-8, INV-18/19).**
//!
//! A string column is two members: `offsets` (`n+1` cumulative positions) and `values` (the
//! concatenated payload). Row `i` is `values[offsets[i]..offsets[i+1]]`. Under a mask the offsets
//! are REBUILT to index the COMPACTED values (never byte-copied from the source, INV-18), and the
//! `values` amplification is bounded by the LENGTH DISTRIBUTION of kept-vs-dropped rows, not by
//! density (INV-19). Stage B routes a lone-source masked utf8 column through
//! `resolve_single_source_node` → `gather_split_strings`; these tests VERIFY that path at the bytes
//! against a REAL split-string source whose rows differ in LENGTH (so a copied-offsets
//! implementation produces visible garbage rather than a subtle shift).

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::gather_exec::{resolve, ResolvedGather};
use cytoanalyst::modules::workstore::object_store::ObjectStore;
use cytoanalyst::modules::workstore::virtual_dataset::{gathered_structure, KeyIdentity};

use super::{create_project, pool_for, server_store, setup_admin};
use crate::common::TestServer;

const AXIS: &str = "rows";

/// One 1-D zarr-v3 array in the decodable container. Lifted from `masked_serve_test::zarr_array`.
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

/// A split-string source: `values/offsets` (uint32, n+1) + `values/values` (bytes).
async fn put_string_source(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    rows: &[&str],
) -> (Uuid, usize) {
    let mut offsets: Vec<u32> = Vec::with_capacity(rows.len() + 1);
    let mut values: Vec<u8> = Vec::new();
    offsets.push(0);
    for r in rows {
        values.extend_from_slice(r.as_bytes());
        offsets.push(values.len() as u32);
    }
    let mut members = zarr_array(
        "values/offsets",
        "uint32",
        4,
        offsets.iter().flat_map(|v| v.to_le_bytes()).collect(),
    );
    members.extend(zarr_array("values/values", "uint8", 1, values));
    let put = store.put_prefix(&members).await.expect("put string src");
    let id = repo
        .insert_artifact(&NewArtifact {
            project_id: Some(project),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: "str-src".to_string(),
            datatype: "data/opaque".to_string(),
            object_key: Some(put.object_key.as_str().to_string()),
            is_multifile: true,
            content_hash: put.content_hash.clone(),
            structure: json!({ "kind": "table", "axis": AXIS, "n": rows.len() }),
            meta: json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert string src")
        .id;
    (id, rows.len())
}

async fn put_mask(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    keep: &[bool],
) -> Uuid {
    let members = zarr_array("values", "bool", 1, keep.iter().map(|&k| k as u8).collect());
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
        meta: cytoanalyst::modules::workstore::mask::mask_meta("ds-source"),
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

async fn put_gathered_string(
    repo: &CatalogRepository,
    source: Uuid,
    mask: Uuid,
    project: Uuid,
    n_source: usize,
) -> Uuid {
    let structure = gathered_structure(
        "utf8",
        Some("string"),
        AXIS,
        n_source,
        KeyIdentity::Unpinned,
        json!({
            "alignment_artifact_id": null,
            "column_selector": "values",
            "alignment_column": null,
            "sources": [ { "dataset_id": "ds-source", "artifact_id": source } ],
            "mask_artifact_id": mask,
        }),
    );
    repo.insert_artifact(&NewArtifact {
        project_id: Some(project),
        dataset_id: None,
        run_id: Some(Uuid::new_v4()),
        output_id: "masked-str".to_string(),
        datatype: "data/opaque".to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{}", "d".repeat(64)),
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
    .expect("insert gathered str")
    .id
}

async fn structure_of(repo: &CatalogRepository, id: Uuid) -> Value {
    repo.get_any_status(id).await.unwrap().unwrap().structure
}

/// Decode a resolved split-string column into its rows (`values[offsets[i]..offsets[i+1]]`).
fn decode_strings(resolved: &ResolvedGather) -> Vec<String> {
    let s = resolved.strings.as_ref().expect("a split column");
    (0..resolved.n)
        .map(|i| {
            let (lo, hi) = (s.offsets[i] as usize, s.offsets[i + 1] as usize);
            String::from_utf8(s.values[lo..hi].to_vec()).unwrap()
        })
        .collect()
}

/// **A masked string column round-trips to the exact kept strings; offsets are REBUILT, not copied
/// (ITEM-8, INV-18).**
///
/// Rows differ in LENGTH, so a copied-offsets implementation slices the wrong spans (visible
/// garbage, not a subtle shift). Mask keeps rows 0,2,3 → ["a","cc","ddd"]; the rebuilt offsets
/// start at 0 and their deltas are the kept rows' byte lengths.
///
/// nc: byte-copy the source offsets instead of rebuilding → row 1 ("cc") slices source bytes
/// `[1..5]` = "bbbb", the copied-offsets failure this fixture is shaped to expose.
#[tokio::test]
async fn a_masked_string_column_round_trips_to_the_kept_strings() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "masked string").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let (src, n) =
        put_string_source(&repo, &store, project, &["a", "bbbb", "cc", "ddd", "e"]).await;
    let mask = put_mask(&repo, &store, project, &[true, false, true, true, false]).await;
    let g = put_gathered_string(&repo, src, mask, project, n).await;

    let resolved = resolve(&pool, &store, g, &structure_of(&repo, g).await)
        .await
        .expect("resolve masked string");
    assert_eq!(resolved.n, 3, "three rows kept");
    assert_eq!(
        decode_strings(&resolved),
        vec!["a".to_string(), "cc".to_string(), "ddd".to_string()],
        "the masked column serves exactly the kept strings"
    );
    let s = resolved.strings.as_ref().unwrap();
    assert_eq!(s.offsets[0], 0, "rebuilt offsets start at 0 (INV-18)");
    assert_eq!(
        s.offsets,
        vec![0, 1, 3, 6],
        "offset deltas equal the KEPT rows' byte lengths (1,2,3), not the source's"
    );
}

/// **`values` amplification is LENGTH-distribution-bounded, not density-bounded (ITEM-8, INV-19).**
///
/// Two masks keeping the SAME COUNT (2) but DIFFERENT-length rows read measurably different
/// `values` bytes: keep {0,1} = "a"+"bbbb" = 5 bytes; keep {0,4} = "a"+"e" = 2 bytes. A single
/// density bound (both keep 40%) would predict equal `values` volume — it is wrong.
///
/// nc: size the `values` member from the kept COUNT (a density model) and the two reads report
/// equal byte volume, contradicting the measured 5 vs 2.
#[tokio::test]
async fn two_masks_same_count_different_lengths_read_different_values_bytes() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "string amplification").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let rows = ["a", "bbbb", "cc", "ddd", "e"];
    let (src, n) = put_string_source(&repo, &store, project, &rows).await;
    let mask_long = put_mask(&repo, &store, project, &[true, true, false, false, false]).await; // {0,1}
    let mask_short = put_mask(&repo, &store, project, &[true, false, false, false, true]).await; // {0,4}

    let g_long = put_gathered_string(&repo, src, mask_long, project, n).await;
    let g_short = put_gathered_string(&repo, src, mask_short, project, n).await;

    let long = resolve(&pool, &store, g_long, &structure_of(&repo, g_long).await)
        .await
        .unwrap();
    let short = resolve(&pool, &store, g_short, &structure_of(&repo, g_short).await)
        .await
        .unwrap();

    assert_eq!(long.n, short.n, "same kept COUNT (2)");
    let long_bytes = long.strings.as_ref().unwrap().values.len();
    let short_bytes = short.strings.as_ref().unwrap().values.len();
    assert_eq!(long_bytes, 5, "\"a\"+\"bbbb\" = 5 value bytes");
    assert_eq!(short_bytes, 2, "\"a\"+\"e\" = 2 value bytes");
    assert_ne!(
        long_bytes, short_bytes,
        "same count, different value-byte volume — length-distribution-bounded, not density"
    );
}
