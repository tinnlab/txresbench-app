//! TEST-21 (ITEM-21) — derive an output artifact's SOURCE dataset from provenance,
//! with NO denormalized `source_dataset_id` column: `output.run_id → the run's USED
//! inputs → the input's dataset`. Drives the real `ProvenanceRepository::source_dataset_of`
//! against the per-test DB (mirrors `verify_test.rs`).

use super::*;

use cytoanalyst::modules::provenance::repository::{NewRun, ProvenanceRepository};

/// A minimal `NewArtifact` for the walk (only scope + run linkage matter here).
fn art(
    project: Option<Uuid>,
    dataset: Option<Uuid>,
    run: Option<Uuid>,
    datatype: &str,
    output_id: &str,
    hash: &str,
) -> NewArtifact {
    NewArtifact {
        project_id: project,
        dataset_id: dataset,
        run_id: run,
        output_id: output_id.into(),
        datatype: datatype.into(),
        object_key: Some(hash.into()),
        is_multifile: false,
        content_hash: hash.into(),
        structure: serde_json::json!({ "encoding": "opaque", "media_type": "application/octet-stream" }),
        meta: serde_json::json!({}),
        role: "artifact".to_string(),
        stored_bytes: 0,
        logical_bytes: Some(0),
        created_by: None,
        hidden: false,
        representation_of: None,
    }
}

/// Seed a project-scoped workbench run with the given `inputs_json` USED edges.
async fn seed_run(prov: &ProvenanceRepository, project: Uuid, inputs_json: Value) -> Uuid {
    let run_id = Uuid::new_v4();
    prov.insert_run(&NewRun {
        run_id,
        project_id: Some(project),
        dataset_id: None, // a WORKBENCH run carries the PROJECT scope (jobs_dataset_scope)
        kind: "compute".into(),
        status: "completed".into(),
        generator_id: "qc.10x".into(),
        generator_version: "test".into(),
        code_sha256: None,
        env_rootfs_sha256: None,
        lockfile_json: None,
        seed: Some(0),
        params: json!({}),
        inputs_json,
        acting_user: None,
        rerun_spec_json: None,
    })
    .await
    .expect("seed run");
    run_id
}

#[tokio::test]
async fn source_dataset_of_derives_via_artifact_input_edge() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "prov-src-ds").await;
    let dataset =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "src-ds").await).unwrap();
    let pool = pool_for(&server).await;
    let catalog = CatalogRepository::new(pool.clone());
    let prov = ProvenanceRepository::new(pool.clone());

    // A dataset-scoped raw-counts matrix (the QC input) — no run of its own.
    let matrix = catalog
        .insert_artifact(&art(None, Some(dataset), None, "single-cell/counts", "matrix", "sha256:mtx"))
        .await
        .unwrap();

    // (1) a dataset-scoped artifact IS its own dataset.
    assert_eq!(
        prov.source_datasets_of(matrix.id).await.unwrap(),
        vec![dataset],
        "a dataset-scoped artifact resolves to its own dataset"
    );

    // A workbench QC run consuming the matrix as an "upload" input edge (ref_id = the artifact id).
    let run_id = seed_run(
        &prov,
        project,
        json!([{ "slot": "matrix", "kind": "upload", "ref_id": matrix.id, "content_hash": "sha256:mtx" }]),
    )
    .await;

    // The metric-column OUTPUT: project-scoped, produced by the run (dataset_id NULL).
    let out = catalog
        .insert_artifact(&art(Some(project), None, Some(run_id), "metadata-column", "pct_mito", "sha256:pctmito"))
        .await
        .unwrap();

    // (2) the output's source dataset is DERIVED: out.run_id → input matrix → matrix's dataset.
    assert_eq!(
        prov.source_datasets_of(out.id).await.unwrap(),
        vec![dataset],
        "a run output inherits its input matrix's dataset via provenance"
    );

    // (3) a two-hop chain (filter output whose input is the QC output) still resolves.
    let chain_run = seed_run(
        &prov,
        project,
        json!([{ "slot": "metrics", "kind": "artifact", "ref_id": out.id, "content_hash": "sha256:pctmito" }]),
    )
    .await;
    let mask = catalog
        .insert_artifact(&art(Some(project), None, Some(chain_run), "metadata-column", "keep_strict", "sha256:keep"))
        .await
        .unwrap();
    assert_eq!(
        prov.source_datasets_of(mask.id).await.unwrap(),
        vec![dataset],
        "a chained output (filter mask ← QC column ← matrix) walks up to the dataset"
    );
}

#[tokio::test]
async fn source_dataset_of_dataset_edge_and_unknown() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "prov-src-ds2").await;
    let dataset =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "src-ds2").await).unwrap();
    let pool = pool_for(&server).await;
    let catalog = CatalogRepository::new(pool.clone());
    let prov = ProvenanceRepository::new(pool.clone());

    // A run whose input is a whole-DATASET edge: ref_id IS the dataset id (terminal).
    let run_id = seed_run(
        &prov,
        project,
        json!([{ "slot": "dataset", "kind": "dataset", "ref_id": dataset, "content_hash": "sha256:ds" }]),
    )
    .await;
    let out = catalog
        .insert_artifact(&art(Some(project), None, Some(run_id), "metadata-column", "keep_strict", "sha256:k2"))
        .await
        .unwrap();
    assert_eq!(
        prov.source_datasets_of(out.id).await.unwrap(),
        vec![dataset],
        "a `dataset` edge terminates the walk at the dataset id"
    );

    // A reference-only input + a project-scoped output with no dataset in its lineage → None.
    let ref_run = seed_run(
        &prov,
        project,
        json!([{ "slot": "ref", "kind": "reference", "ref_id": Uuid::new_v4(), "content_hash": "sha256:ref" }]),
    )
    .await;
    let orphan = catalog
        .insert_artifact(&art(Some(project), None, Some(ref_run), "report/html", "orphan", "sha256:orphan"))
        .await
        .unwrap();
    assert!(
        prov.source_datasets_of(orphan.id).await.unwrap().is_empty(),
        "a lineage with no dataset-scoped ancestor yields no source dataset"
    );
}

// ---------------------------------------------------------------------------
// MULTI-SOURCE (the integration shape). An artifact produced by INTEGRATING two
// datasets has TWO source-dataset edges. A single-valued answer must not silently
// pick one — the collapse is decided by DECLARATION ORDER, which means nothing.
// ---------------------------------------------------------------------------

/// Two `dataset` edges on one run: the honest answer names BOTH, in declared order.
/// This assertion FAILS if the code goes back to returning only the first-declared one.
#[tokio::test]
async fn source_datasets_of_reports_every_source_of_an_integration() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "prov-src-multi").await;
    let ds_a =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "Dataset 1").await).unwrap();
    let ds_b =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "Dataset 2").await).unwrap();
    let pool = pool_for(&server).await;
    let catalog = CatalogRepository::new(pool.clone());
    let prov = ProvenanceRepository::new(pool.clone());

    let run_id = seed_run(
        &prov,
        project,
        json!([
            { "slot": "a", "kind": "dataset", "ref_id": ds_a, "content_hash": "sha256:a" },
            { "slot": "b", "kind": "dataset", "ref_id": ds_b, "content_hash": "sha256:b" }
        ]),
    )
    .await;
    let integrated = catalog
        .insert_artifact(&art(Some(project), None, Some(run_id), "demo/table", "integrated", "sha256:int"))
        .await
        .unwrap();

    assert_eq!(
        prov.source_datasets_of(integrated.id).await.unwrap(),
        vec![ds_a, ds_b],
        "an integration of two datasets reports BOTH sources, not the first-declared one"
    );
}

/// The same collapse one hop up: two `artifact` edges, each rooted in a different
/// dataset. The walk must not stop at the first input whose lineage resolves.
#[tokio::test]
async fn source_datasets_of_reports_every_source_through_artifact_edges() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "prov-src-multi2").await;
    let ds_a =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "Dataset 1").await).unwrap();
    let ds_b =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "Dataset 2").await).unwrap();
    let pool = pool_for(&server).await;
    let catalog = CatalogRepository::new(pool.clone());
    let prov = ProvenanceRepository::new(pool.clone());

    let prim_a = catalog
        .insert_artifact(&art(None, Some(ds_a), None, "demo/table", "primary", "sha256:pa"))
        .await
        .unwrap();
    let prim_b = catalog
        .insert_artifact(&art(None, Some(ds_b), None, "demo/table", "primary", "sha256:pb"))
        .await
        .unwrap();
    let run_id = seed_run(
        &prov,
        project,
        json!([
            { "slot": "a", "kind": "upload", "ref_id": prim_a.id, "content_hash": "sha256:pa" },
            { "slot": "b", "kind": "artifact", "ref_id": prim_b.id, "content_hash": "sha256:pb" }
        ]),
    )
    .await;
    let integrated = catalog
        .insert_artifact(&art(Some(project), None, Some(run_id), "demo/table", "integrated", "sha256:int2"))
        .await
        .unwrap();

    assert_eq!(
        prov.source_datasets_of(integrated.id).await.unwrap(),
        vec![ds_a, ds_b],
        "both input matrices' datasets are reported; the walk does not stop at the first"
    );

    // A chained output one hop further still carries BOTH sources.
    let chain = seed_run(
        &prov,
        project,
        json!([{ "slot": "x", "kind": "artifact", "ref_id": integrated.id, "content_hash": "sha256:int2" }]),
    )
    .await;
    let downstream = catalog
        .insert_artifact(&art(Some(project), None, Some(chain), "demo/column", "derived", "sha256:dv"))
        .await
        .unwrap();
    assert_eq!(
        prov.source_datasets_of(downstream.id).await.unwrap(),
        vec![ds_a, ds_b],
        "a downstream artifact of an integration inherits BOTH sources"
    );

    // De-duplication: the same dataset reached twice is reported ONCE.
    let dup_run = seed_run(
        &prov,
        project,
        json!([
            { "slot": "a", "kind": "upload", "ref_id": prim_a.id, "content_hash": "sha256:pa" },
            { "slot": "a2", "kind": "dataset", "ref_id": ds_a, "content_hash": "sha256:a" }
        ]),
    )
    .await;
    let dup = catalog
        .insert_artifact(&art(Some(project), None, Some(dup_run), "demo/column", "dup", "sha256:dup"))
        .await
        .unwrap();
    assert_eq!(
        prov.source_datasets_of(dup.id).await.unwrap(),
        vec![ds_a],
        "one dataset reached by two edges is reported once"
    );
}

/// A single-source artifact still reports exactly one, and no-source reports none —
/// the negative controls that keep the multi-source assertions from being vacuous.
#[tokio::test]
async fn source_datasets_of_single_and_none() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "prov-src-single").await;
    let dataset =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "Only").await).unwrap();
    let pool = pool_for(&server).await;
    let catalog = CatalogRepository::new(pool.clone());
    let prov = ProvenanceRepository::new(pool.clone());

    let seed = catalog
        .insert_artifact(&art(None, Some(dataset), None, "demo/table", "primary", "sha256:only"))
        .await
        .unwrap();
    assert_eq!(prov.source_datasets_of(seed.id).await.unwrap(), vec![dataset]);

    let ref_run = seed_run(
        &prov,
        project,
        json!([{ "slot": "ref", "kind": "reference", "ref_id": Uuid::new_v4(), "content_hash": "sha256:ref" }]),
    )
    .await;
    let orphan = catalog
        .insert_artifact(&art(Some(project), None, Some(ref_run), "report/html", "orphan", "sha256:orph2"))
        .await
        .unwrap();
    assert!(prov.source_datasets_of(orphan.id).await.unwrap().is_empty());
}


/// THE WIRE. The repository can be honest and the endpoint still collapse the set, so the
/// shape the picker actually receives is pinned here: an integration of two datasets lists
/// BOTH sources, and the singular convenience field refuses to name one of them.
#[tokio::test]
async fn list_row_carries_every_source_dataset_of_an_integration() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "prov-src-wire").await;
    let ds_a =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "Dataset 1").await).unwrap();
    let ds_b =
        Uuid::parse_str(&crate::dataset::create_dataset(&server, &token, "Dataset 2").await).unwrap();
    let pool = pool_for(&server).await;
    let catalog = CatalogRepository::new(pool.clone());
    let prov = ProvenanceRepository::new(pool.clone());

    let run_id = seed_run(
        &prov,
        project,
        json!([
            { "slot": "a", "kind": "dataset", "ref_id": ds_a, "content_hash": "sha256:a" },
            { "slot": "b", "kind": "dataset", "ref_id": ds_b, "content_hash": "sha256:b" }
        ]),
    )
    .await;
    let integrated = catalog
        .insert_artifact(&art(Some(project), None, Some(run_id), "demo/table", "integrated", "sha256:wire"))
        .await
        .unwrap();
    // POSITIVE CONTROL: a single-source row in the same response must still read exactly as
    // it always did, or "stop naming one" would have been achieved by naming none.
    let single_run = seed_run(
        &prov,
        project,
        json!([{ "slot": "a", "kind": "dataset", "ref_id": ds_a, "content_hash": "sha256:a" }]),
    )
    .await;
    let single = catalog
        .insert_artifact(&art(Some(project), None, Some(single_run), "demo/table", "single", "sha256:wire1"))
        .await
        .unwrap();

    let resp = server
        .client
        .get(server.api_url(&format!("/projects/{project}/artifacts")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list artifacts");
    assert_eq!(resp.status().as_u16(), 200);
    let list: Value = resp.json().await.expect("list json");
    let rows = list.as_array().expect("array");

    let find = |id: Uuid| {
        rows.iter()
            .find(|a| a["id"].as_str() == Some(id.to_string().as_str()))
            .unwrap_or_else(|| panic!("artifact {id} in the list read"))
            .clone()
    };

    let multi = find(integrated.id);
    assert_eq!(
        multi["source_dataset_ids"].as_array().map(|v| {
            v.iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>()
        }),
        Some(vec![ds_a.to_string(), ds_b.to_string()]),
        "the LIST row names BOTH source datasets of an integration, in declared-input order"
    );
    assert_eq!(
        multi["source_dataset_names"].as_array().map(|v| {
            v.iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>()
        }),
        Some(vec!["Dataset 1".to_string(), "Dataset 2".to_string()]),
        "and names both"
    );
    assert!(
        multi["source_dataset_id"].is_null(),
        "the singular field REFUSES to name one of several — it used to answer `Dataset 1` \
         here, a confident wrong answer decided by edge declaration order. Got: {:?}",
        multi["source_dataset_id"]
    );
    assert!(
        multi["source_dataset_name"].is_null(),
        "…and the singular NAME likewise. Got: {:?}",
        multi["source_dataset_name"]
    );

    let one = find(single.id);
    assert_eq!(one["source_dataset_id"].as_str(), Some(ds_a.to_string().as_str()));
    assert_eq!(one["source_dataset_name"].as_str(), Some("Dataset 1"));
    assert_eq!(
        one["source_dataset_ids"].as_array().map(|v| v.len()),
        Some(1),
        "a single-source row still carries its one source in the set"
    );
}
