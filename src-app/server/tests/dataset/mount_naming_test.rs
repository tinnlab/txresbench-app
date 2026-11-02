//! TEST-33 [covers: ITEM-23] — **how the runner NAMES each `/inputs` mount.**
//!
//! ## Why this file exists at all
//!
//! The mount path had no test that would catch a WRONG mount name. Every existing
//! assertion on it is incidental: `sandbox/mod.rs`'s hardlink test names
//! `counts.zarr` only to have a path to stat, and the capsule tests name one only so
//! an inline script can `open()` it. None of them says anything about where the name
//! CAME FROM, so the shipped defect ITEM-23 removes — `qc`'s manifest declaring
//! `run: { inputs: { matrix: matrix.h5ad } }` for a slot that resolves to a
//! multi-file **Zarr store**, i.e. a DIRECTORY wearing an `.h5ad` name, which
//! `qc-10x.py::load_matrix` then hands to `anndata.read_h5ad` — is invisible to the
//! whole suite. PLAN's ITEM-23 verdict (CONCERN) names this file as the missing test
//! and requires it to land BEFORE the removal.
//!
//! ## What it pins
//!
//! 1. a **multi-file** artifact stages as a DIRECTORY and binds read-only as one;
//! 2. a **single-file** artifact stages as a FILE and binds read-only as one;
//! 3. the mount name is a function of the **ARTIFACT** — not of any string the
//!    caller (a manifest, a view, the FE launch site) declared. Asserted by
//!    materializing the SAME artifacts twice under DIFFERENT declared
//!    `sandbox_subpath`s and requiring the resulting mounts to be IDENTICAL, and by
//!    a negative control that requires the derivation to still DISCRIMINATE (two
//!    artifacts that differ only in their declared `structure.encoding`, bound at
//!    the same slot, must get DIFFERENT names — otherwise clause 3 is satisfied by a
//!    derivation that returns a constant);
//! 4. `/inputs/inputs.json` records `slot → sandbox_path` for BOTH, and the recorded
//!    path is the one actually bound (no host path leaks).
//!
//! Clauses 1, 2 and 4 hold before and after ITEM-23. Clause 3 is the behaviour
//! ITEM-23 introduces.
//!
//! Not rootfs-gated: it drives the real `materialize_inputs` chokepoint (real
//! Postgres, real content-addressed store, real authz) — no bwrap needed. That is
//! deliberately the same seam `sandbox/mod.rs`'s hardlink test uses, because the
//! mount NAME is decided there, before any backend sees a `ComputeSpec`.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::sandbox::inputs::{input_mounts, materialize_inputs, MaterializedInput};
use cytoanalyst::modules::sandbox::spec::AnalysisSpec;
use cytoanalyst::modules::sandbox::types::MountMode;
use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::object_store::{LocalFsStore, ObjectStore};

use super::hardening_common::{admin_user_id, create_project, pool_for, server_store};
use super::setup_admin;
use crate::common::TestServer;

/// A Zarr-v3 store's members — shaped like the real thing (`zarr.json` metadata
/// documents + chunk keys under a `c/` directory), because the property under test is
/// "this artifact is a DIRECTORY of many files", and a one-member fixture would pass a
/// staging path that had silently degraded to a single file.
fn zarr_members() -> Vec<(String, Vec<u8>)> {
    vec![
        (
            "zarr.json".to_string(),
            br#"{"zarr_format":3,"node_type":"group"}"#.to_vec(),
        ),
        (
            "indptr/zarr.json".to_string(),
            br#"{"zarr_format":3,"node_type":"array"}"#.to_vec(),
        ),
        ("indptr/c/0".to_string(), (0u8..64).collect()),
        ("data/c/0".to_string(), (7u8..200).collect()),
    ]
}

/// The `structure` a real `single-cell/expression` artifact declares — the CSC Zarr
/// store `packages/_lib/cyto_csc.py::write_csc_zarr` emits. Copied in shape (not by
/// import: the server may not know a contributed package's vocabulary), because the
/// whole point of ITEM-23 is that the mount name is read off THIS document.
fn zarr_v3_structure() -> Value {
    json!({
        "encoding": "zarr_v3",
        "kind": "sparse_csc",
        "axes": ["cells", "genes"],
        "shape": [3460, 35477],
        "nnz": 4264551,
        "data": { "kind": "numeric" }
    })
}

/// The `structure` an opaque single blob declares.
fn opaque_structure() -> Value {
    json!({ "encoding": "opaque", "media_type": "application/octet-stream" })
}

#[allow(clippy::too_many_arguments)]
async fn insert_artifact(
    pool: &sqlx::SqlitePool,
    project_id: Uuid,
    output_id: &str,
    datatype: &str,
    object_key: &str,
    content_hash: &str,
    is_multifile: bool,
    structure: Value,
) -> Uuid {
    CatalogRepository::new(pool.clone())
        .insert_artifact(&NewArtifact {
            project_id: Some(project_id),
            dataset_id: None,
            run_id: Some(Uuid::new_v4()),
            output_id: output_id.to_string(),
            datatype: datatype.to_string(),
            object_key: Some(object_key.to_string()),
            is_multifile,
            content_hash: content_hash.to_string(),
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
        .expect("insert artifact")
        .id
}

/// The `/inputs`-relative NAME each slot was mounted under, from the materialized set.
fn mount_names(staged: &[MaterializedInput]) -> BTreeMap<String, String> {
    staged
        .iter()
        .map(|m| {
            let name = m
                .sandbox_path
                .strip_prefix("/inputs/")
                .unwrap_or_else(|| panic!("a mount must live under /inputs: {}", m.sandbox_path))
                .to_string();
            (m.slot.clone(), name)
        })
        .collect()
}

/// `slot → sandbox_path` as the RUN sees it — parsed from the derived
/// `/inputs/inputs.json` the sandbox binds read-only, which is the map every compute
/// resolves its slots through (`load_inputs_index`).
fn inputs_json_slot_map(inputs_dir: &Path) -> BTreeMap<String, String> {
    let raw = std::fs::read(inputs_dir.join("inputs.json")).expect("the run's inputs.json exists");
    let doc: Value = serde_json::from_slice(&raw).expect("inputs.json is JSON");
    doc["inputs"]
        .as_array()
        .expect("inputs.json carries an `inputs` array")
        .iter()
        .map(|e| {
            (
                e["slot"].as_str().expect("slot").to_string(),
                e["sandbox_path"]
                    .as_str()
                    .expect("sandbox_path")
                    .to_string(),
            )
        })
        .collect()
}

/// Materialize `inputs` into a FRESH staging dir under the server's data root and
/// return `(staged, inputs_dir)`. One helper so the two declaration variants below
/// differ ONLY in the declared `sandbox_subpath`s.
async fn stage(
    server: &TestServer,
    pool: &sqlx::SqlitePool,
    store: &LocalFsStore,
    owner: Uuid,
    inputs: Value,
) -> (Vec<MaterializedInput>, std::path::PathBuf) {
    let inputs_dir = server
        .data_dir()
        .join("sandboxes")
        .join(Uuid::new_v4().to_string())
        .join("inputs");
    let spec = AnalysisSpec::parse(&json!({
        "language": "python",
        "script": "print('mount naming')",
        "inputs": inputs,
    }))
    .expect("spec parses");
    let staged = materialize_inputs(&spec, &inputs_dir, owner, &[], pool, store)
        .await
        .expect("materialize inputs");
    (staged, inputs_dir)
}

#[tokio::test]
async fn test33_mounts_are_named_from_the_artifact_not_from_a_declared_string() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "mount naming").await;
    let pool = pool_for(&server).await;
    let owner = admin_user_id(&pool).await;
    let store = server_store(&server);

    // ── the two artifacts, in the SERVER's real content-addressed pool ──────────
    //
    // `expression` is what a real import actually emits for `single-cell/expression`:
    // a MULTI-FILE Zarr store (`is_multifile = true`, `structure.encoding = zarr_v3`).
    // It is NOT an `.h5ad` blob, which is the whole point — `qc`'s manifest declared
    // `matrix.h5ad` for exactly this slot.
    let members = zarr_members();
    let put = store.put_prefix(&members).await.expect("put_prefix");
    let zarr_id = insert_artifact(
        &pool,
        project,
        "expression",
        "single-cell/expression",
        put.object_key.as_str(),
        &put.content_hash,
        true,
        zarr_v3_structure(),
    )
    .await;

    // …and a single-file, opaque blob.
    let blob_bytes: Vec<u8> = (0u8..251).cycle().take(9_000).collect();
    let blob_key = store.put(&blob_bytes).await.expect("put blob");
    let blob_id = insert_artifact(
        &pool,
        project,
        "labels",
        "data/opaque",
        blob_key.as_str(),
        blob_key.as_str(),
        false,
        opaque_structure(),
    )
    .await;

    // ── RUN A — declared subpaths that LIE about both artifacts ────────────────
    // `matrix.h5ad` over a Zarr store is the shipped `qc` declaration verbatim.
    let (staged_a, dir_a) = stage(
        &server,
        &pool,
        &store,
        owner,
        json!([
            { "slot": "matrix", "artifact_ref": zarr_id, "sandbox_subpath": "matrix.h5ad" },
            { "slot": "labels", "artifact_ref": blob_id, "sandbox_subpath": "labels.h5ad" },
        ]),
    )
    .await;
    assert_eq!(staged_a.len(), 2, "both inputs materialized");
    let by_slot_a: BTreeMap<&str, &MaterializedInput> =
        staged_a.iter().map(|m| (m.slot.as_str(), m)).collect();
    let names_a = mount_names(&staged_a);

    // ── (1) the multi-file artifact is staged + bound as a DIRECTORY ────────────
    let matrix = by_slot_a["matrix"];
    assert!(
        matrix.host_path.is_dir(),
        "a multi-file (Zarr) artifact stages as a DIRECTORY, got {}",
        matrix.host_path.display()
    );
    for (rel, bytes) in &members {
        let at = matrix.host_path.join(rel);
        assert_eq!(
            &std::fs::read(&at).unwrap_or_else(|e| panic!("read member {rel}: {e}")),
            bytes,
            "member {rel} staged with faithful bytes"
        );
    }
    assert_eq!(
        matrix.kind, "artifact-prefix",
        "a multi-file artifact declares the prefix source kind"
    );

    // ── (2) the single-file artifact is staged + bound as a FILE ────────────────
    let labels = by_slot_a["labels"];
    assert!(
        labels.host_path.is_file(),
        "a single-blob artifact stages as a FILE, got {}",
        labels.host_path.display()
    );
    assert_eq!(
        std::fs::read(&labels.host_path).expect("read blob"),
        blob_bytes,
        "the staged blob is byte-faithful"
    );
    assert_eq!(labels.kind, "artifact");

    // …and the dir/file distinction survives into the BINDS the backend receives.
    let mounts_a = input_mounts(&staged_a, &dir_a);
    assert!(
        mounts_a.iter().all(|m| m.mode == MountMode::ReadOnly),
        "every input bind is read-only"
    );
    let matrix_mount = mounts_a
        .iter()
        .find(|m| m.sandbox_path == matrix.sandbox_path)
        .expect("the matrix mount is in the bind set");
    assert!(
        matrix_mount.host_path.is_dir(),
        "the matrix BIND points at the staged directory"
    );
    let labels_mount = mounts_a
        .iter()
        .find(|m| m.sandbox_path == labels.sandbox_path)
        .expect("the labels mount is in the bind set");
    assert!(
        labels_mount.host_path.is_file(),
        "the labels BIND points at the staged file"
    );

    // ── (4) inputs.json records slot → sandbox_path for BOTH ───────────────────
    let recorded_a = inputs_json_slot_map(&dir_a);
    assert_eq!(
        recorded_a.len(),
        2,
        "inputs.json records every slot: {recorded_a:?}"
    );
    for m in &staged_a {
        assert_eq!(
            recorded_a.get(&m.slot).map(String::as_str),
            Some(m.sandbox_path.as_str()),
            "inputs.json records slot {:?} at the path it was actually bound",
            m.slot
        );
        // The recorded path IS the staged file/dir's own name under /inputs — a
        // compute that resolves by slot lands on the bytes, never on a stale name.
        assert_eq!(
            m.sandbox_path,
            format!(
                "/inputs/{}",
                m.host_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .expect("staged name")
            ),
            "the recorded sandbox path names the staged entry"
        );
    }
    let raw_a = String::from_utf8(std::fs::read(dir_a.join("inputs.json")).unwrap()).unwrap();
    assert!(
        !raw_a.contains(dir_a.to_str().expect("utf8 staging dir")),
        "inputs.json must stay host-path-agnostic: {raw_a}"
    );

    // ── RUN B — the SAME artifacts, wildly DIFFERENT declared subpaths ──────────
    let (staged_b, dir_b) = stage(
        &server,
        &pool,
        &store,
        owner,
        json!([
            { "slot": "matrix", "artifact_ref": zarr_id, "sandbox_subpath": "totally_different.bin" },
            { "slot": "labels", "artifact_ref": blob_id, "sandbox_subpath": "also_different.tar.gz" },
        ]),
    )
    .await;
    let names_b = mount_names(&staged_b);
    let recorded_b = inputs_json_slot_map(&dir_b);
    assert_eq!(
        recorded_b.len(),
        2,
        "inputs.json records every slot on run B too"
    );

    // ── (3) the naming rule: the ARTIFACT decides, not the declaration ─────────
    //
    // Runs A and B differ in NOTHING but the declared `sandbox_subpath`s, so if the
    // declaration still decided the name these would differ. This is the assertion
    // that fails on the shipped tree (where the mount name is the declared string
    // verbatim, so the Zarr STORE above mounts as `matrix.h5ad` — a DIRECTORY
    // wearing an h5ad name, which `qc-10x.py::load_matrix` routes into
    // `anndata.read_h5ad`).
    assert_eq!(
        names_a, names_b,
        "the mount name must be a function of the ARTIFACT: two runs over the SAME \
         artifacts under DIFFERENT declared subpaths must mount them identically"
    );
    assert_eq!(
        recorded_a, recorded_b,
        "…and `inputs.json`'s slot → path map must be identical too"
    );

    // …and the name the artifact produced reflects the store form the artifact
    // ITSELF declares: the multi-file `zarr_v3` store is named a Zarr store, and
    // neither mount inherits the `.h5ad` the spec asked for.
    assert_eq!(
        names_a["matrix"], "matrix.zarr",
        "a multi-file `zarr_v3` artifact mounts under the store form it declares"
    );
    assert_eq!(
        names_a["labels"], "labels",
        "an opaque single blob makes no format claim, so neither does its mount name"
    );
    for (slot, name) in &names_a {
        assert!(
            !name.ends_with(".h5ad"),
            "slot {slot:?} mounted as {name:?} — the declared `.h5ad` string leaked \
             into the mount name"
        );
    }

    // ── NEGATIVE CONTROL — the derivation must still DISCRIMINATE ──────────────
    //
    // "The declared string does not decide the name" is satisfied just as well by a
    // derivation that returns a constant, which would silently stage every input of
    // a run over the same path. So: bind the SINGLE-FILE artifact at the SAME slot
    // the Zarr store used above. Same slot, same declaration, different artifact ⇒
    // the name must differ, and must differ in the direction the artifacts do.
    let (staged_c, _dir_c) = stage(
        &server,
        &pool,
        &store,
        owner,
        json!([
            { "slot": "matrix", "artifact_ref": blob_id, "sandbox_subpath": "matrix.h5ad" },
        ]),
    )
    .await;
    let names_c = mount_names(&staged_c);
    assert_ne!(
        names_c["matrix"], names_a["matrix"],
        "the SAME slot over a DIFFERENT artifact must derive a DIFFERENT mount name \
         — otherwise the derivation is a constant and clause (3) proves nothing"
    );
    assert!(
        staged_c[0].host_path.is_file(),
        "…and that artifact is still staged as a FILE (the dir/file form follows the \
         artifact, not the slot it was bound at)"
    );
}
