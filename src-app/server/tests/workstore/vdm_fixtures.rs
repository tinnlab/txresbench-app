//! Shared fixtures for the virtual-dataset-mask Stage-D serve tests (ITEM-10 / ITEM-15).
//!
//! The masked-serve invariants are asserted at the bytes against REAL on-disk zarr sources +
//! REAL `bool` masks driving the production resolver. These helpers are the same shapes
//! `masked_serve_test` builds, lifted here so the attached-artifact / identity-fast-path /
//! axis-attribution suites share ONE fixture vocabulary instead of re-deriving it.

use serde_json::{json, Value};
use uuid::Uuid;

use txresbench::modules::workstore::catalog::models::NewArtifact;
use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::gather_exec::ResolvedGather;
use txresbench::modules::workstore::object_store::ObjectStore;
use txresbench::modules::workstore::virtual_dataset::{gathered_structure, KeyIdentity};

pub(crate) const AXIS: &str = "rows";

/// One 1-D zarr-v3 array in the decodable container: `sharding_indexed` over `bytes`+`gzip`,
/// one shard covering the whole array.
pub(crate) fn zarr_array(
    prefix: &str,
    dtype: &str,
    item: usize,
    elems: Vec<u8>,
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

pub(crate) async fn put_multifile(
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

/// A float32 source column of `vals`, one `values` member, on axis `rows` — a STORED artifact
/// (`object_key` present), the shape a real dataset column has.
pub(crate) async fn put_source(
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
pub(crate) async fn put_mask(
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

/// A single-source gathered column, optionally masked (`object_key` NULL — a recipe, not bytes).
pub(crate) async fn put_gathered(
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

/// Concatenate every resolved chunk's raw member bytes, trimmed to `n × item`.
pub(crate) fn resolved_bytes(resolved: &ResolvedGather, item: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    for g in 0..resolved.chunk_count() {
        bytes.extend_from_slice(&resolved.member(&format!("values/c/{g}")).unwrap().unwrap());
    }
    bytes.truncate(resolved.n * item);
    bytes
}

/// Decode a resolved flat float32 column.
pub(crate) fn decode_f32(resolved: &ResolvedGather) -> Vec<f32> {
    resolved_bytes(resolved, 4)
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub(crate) async fn structure_of(repo: &CatalogRepository, id: Uuid) -> Value {
    repo.get_any_status(id)
        .await
        .expect("read")
        .expect("row")
        .structure
}
