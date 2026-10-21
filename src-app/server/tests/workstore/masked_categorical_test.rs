//! **Stage C — the masked CATEGORICAL serve (ITEM-7, INV-6/13/14).**
//!
//! A categorical column stores integer CODES plus a declared `levels` array on the member's
//! `zarr.json`; a label is `levels[code]`. Two axes act INDEPENDENTLY (§11.1d): ROWS (the mask,
//! exactly as for numeric) and CODES (remapped into the unified vocabulary ONLY when an alignment
//! is present — the cost of INTEGRATION, not of masking). For a FILTER (lone source, no alignment)
//! a categorical therefore behaves EXACTLY like a numeric — pure row selection, codes pass through
//! — and its `levels` travel once on the OUTPUT member's `zarr.json` so the single metadata fetch
//! matches the served codes (INV-13). The levels table is CODE-indexed and UNTOUCHED by the mask
//! (INV-6/14): dropping every row of a level does not change the declared vocabulary.
//!
//! The INTEGRATION remap (`remap_codes`) and its two ordered refusals
//! (`GATHER_LEVEL_CODE_UNMAPPED` / `GATHER_LEVEL_ABSENT`, INV-15/16) are exercised as pure
//! arithmetic in `gathered.rs`'s unit tests; a mask never co-occurs with an alignment in one
//! recipe (filtering an integration is CHAINING), so this file covers the FILTER categorical.

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

/// One 1-D zarr-v3 array in the decodable container, optionally carrying `attributes.cyto.levels`.
fn zarr_array(
    prefix: &str,
    dtype: &str,
    item: usize,
    elems: Vec<u8>,
    levels: Option<Value>,
) -> Vec<(String, Vec<u8>)> {
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

    let mut meta = json!({
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
    if let Some(levels) = levels {
        meta["attributes"] = json!({ "cyto": { "kind": "categorical", "levels": levels } });
    }
    vec![
        (
            format!("{prefix}/zarr.json"),
            serde_json::to_vec(&meta).expect("array meta"),
        ),
        (format!("{prefix}/c/0"), body),
    ]
}

/// A categorical source: uint8 `values` codes + a code-indexed `levels` vocabulary.
async fn put_categorical_source(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    codes: &[u8],
    levels: Value,
) -> (Uuid, usize) {
    let members = zarr_array("values", "uint8", 1, codes.to_vec(), Some(levels));
    let put = store.put_prefix(&members).await.expect("put cat src");
    let id = repo
        .insert_artifact(&NewArtifact {
            project_id: Some(project),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: "cat-src".to_string(),
            datatype: "data/opaque".to_string(),
            object_key: Some(put.object_key.as_str().to_string()),
            is_multifile: true,
            content_hash: put.content_hash.clone(),
            structure: json!({ "kind": "table", "axis": AXIS, "n": codes.len() }),
            meta: json!({}),
            role: "artifact".to_string(),
            stored_bytes: 0,
            logical_bytes: Some(0),
            created_by: None,
            hidden: false,
            representation_of: None,
        })
        .await
        .expect("insert cat src")
        .id;
    (id, codes.len())
}

async fn put_mask(
    repo: &CatalogRepository,
    store: &dyn ObjectStore,
    project: Uuid,
    keep: &[bool],
) -> Uuid {
    let members = zarr_array(
        "values",
        "bool",
        1,
        keep.iter().map(|&k| k as u8).collect(),
        None,
    );
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

async fn put_gathered_categorical(
    repo: &CatalogRepository,
    source: Uuid,
    mask: Uuid,
    project: Uuid,
    n_source: usize,
) -> Uuid {
    let structure = gathered_structure(
        "uint8",
        Some("categorical"),
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
        output_id: "masked-cat".to_string(),
        datatype: "data/opaque".to_string(),
        object_key: None,
        is_multifile: false,
        content_hash: format!("sha256:{}", "c".repeat(64)),
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
    .expect("insert gathered cat")
    .id
}

async fn structure_of(repo: &CatalogRepository, id: Uuid) -> Value {
    repo.get_any_status(id).await.unwrap().unwrap().structure
}

/// Decode a resolved uint8 categorical column's codes (one chunk, trimmed to `n`).
fn decode_codes(resolved: &ResolvedGather) -> Vec<u8> {
    let mut bytes = Vec::new();
    for g in 0..resolved.chunk_count() {
        bytes.extend_from_slice(&resolved.member(&format!("values/c/{g}")).unwrap().unwrap());
    }
    bytes.truncate(resolved.n);
    bytes
}

/// The `levels` array on the served member's `zarr.json` (`attributes.cyto.levels`).
fn served_levels(resolved: &ResolvedGather) -> Value {
    let arr: Value =
        serde_json::from_slice(&resolved.member("values/zarr.json").unwrap().unwrap()).unwrap();
    arr["attributes"]["cyto"]["levels"].clone()
}

/// **A masked categorical's labels equal the unmasked labels of the KEPT rows — with a vocabulary
/// whose order differs from source order, so an off-by-one is visible (ITEM-7, INV-6).**
///
/// Levels `["zebra","apple","mango"]` (NOT alphabetical, so `levels[code]` is not a no-op), codes
/// `[2,0,1,2,0]` = [mango,zebra,apple,mango,zebra]. Mask keeps rows 0,2,3 → codes `[2,1,2]` =
/// [mango,apple,mango]. The code column is masked exactly like a numeric; labels resolve through
/// the UNTOUCHED code-indexed levels.
///
/// nc: index the mask off-by-one (rows 1,2,3) and the labels become [zebra,apple,mango] — the
/// non-alphabetical vocabulary makes the wrong selection visible. nc: serve `base_plan` (no filter)
/// and all five codes come back.
#[tokio::test]
async fn a_masked_categorical_serves_the_kept_rows_labels() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "masked categorical").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let levels = json!(["zebra", "apple", "mango"]);
    let (src, n) =
        put_categorical_source(&repo, &store, project, &[2, 0, 1, 2, 0], levels.clone()).await;
    let mask = put_mask(&repo, &store, project, &[true, false, true, true, false]).await;
    let g = put_gathered_categorical(&repo, src, mask, project, n).await;

    let resolved = resolve(&pool, &store, g, &structure_of(&repo, g).await)
        .await
        .expect("resolve masked categorical");
    assert_eq!(resolved.n, 3, "three rows kept");
    let codes = decode_codes(&resolved);
    assert_eq!(
        codes,
        vec![2, 1, 2],
        "kept codes are rows 0,2,3 — pass-through, no remap"
    );
    let labels: Vec<&str> = codes
        .iter()
        .map(|&c| levels[c as usize].as_str().unwrap())
        .collect();
    assert_eq!(
        labels,
        vec!["mango", "apple", "mango"],
        "labels of the kept rows"
    );
}

/// **The `levels` ride the OUTPUT member's `zarr.json` (single metadata fetch, INV-13) and are
/// UNTOUCHED by the mask (INV-14) — dropping every row of a level does not change the declared
/// vocabulary.**
///
/// The mask drops EVERY row holding code 1 ("apple"), yet the served vocabulary still declares all
/// three levels: width is from the DECLARED set, not observed codes.
///
/// nc: derive `levels` from the surviving codes (observed) and "apple" vanishes from the served
/// vocabulary — a masked categorical would then renumber codes against a shrunken table, the
/// right-codes-wrong-labels failure INV-13 forbids.
#[tokio::test]
async fn the_levels_travel_on_the_output_and_the_mask_never_touches_them() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "categorical levels").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let levels = json!(["zebra", "apple", "mango"]);
    // Code 1 ("apple") sits at rows 2 only; the mask drops it entirely.
    let (src, n) =
        put_categorical_source(&repo, &store, project, &[0, 2, 1, 0, 2], levels.clone()).await;
    let mask = put_mask(&repo, &store, project, &[true, true, false, true, true]).await;
    let g = put_gathered_categorical(&repo, src, mask, project, n).await;

    let resolved = resolve(&pool, &store, g, &structure_of(&repo, g).await)
        .await
        .expect("resolve");
    assert_eq!(
        decode_codes(&resolved),
        vec![0, 2, 0, 2],
        "code 1 dropped entirely"
    );
    assert_eq!(
        served_levels(&resolved),
        levels,
        "the served vocabulary is the DECLARED set — dropping every 'apple' row keeps 'apple' \
         in the levels (INV-14), and the single zarr.json fetch matches the served codes (INV-13)"
    );
}
