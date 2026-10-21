//! TEST-54 [ITEM-25, ITEM-23] — dataset-scoped (project-less) provenance. A
//! dataset-scoped run records a run node and is BOTH backward- (its used-edge
//! pins the dataset hash) and forward-walkable (`GET /provenance/forward`); a
//! project-scoped run is unchanged; and BOTH scopes coexist in one project graph read
//! (the attached dataset's processing lineage folds into the project closure).

use serde_json::json;
use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn dataset_and_project_scoped_runs_coexist_and_are_walkable() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "scope project").await;
    let pool = pool_for(&server).await;

    // A dataset, attached to the project.
    let (dataset, _file, h_d) = upload_dataset(
        &server,
        &admin,
        "PBMC scope",
        "matrix.csv",
        b"cell,gene\nc1,3\n",
    )
    .await;
    attach_dataset(&server, &admin, project, dataset).await;

    // A DATASET-scoped (project-less) processing run over D.
    let h_ods = h(2);
    let run_ds = Uuid::new_v4();
    let mut r = run_template(run_ds, None, Some(dataset));
    r.inputs_json = json!([used_edge("dataset", "dataset", Some(dataset), &h_d)]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        None,
        Some(dataset),
        Some(run_ds),
        "expr",
        &h_ods,
        "single-cell/expression",
        false)
    .await;

    // A PROJECT-scoped run (the workbench path) over a project root — unchanged.
    let h_root = h(3);
    let root = seed_artifact(
        &pool,
        Some(project),
        None,
        None,
        "upload",
        &h_root,
        "single-cell/expression",
        false)
    .await;
    let h_ost = h(4);
    let run_st = Uuid::new_v4();
    let mut r = run_template(run_st, Some(project), None);
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run_st),
        "out",
        &h_ost,
        "single-cell/expression",
        false)
    .await;

    // Both scopes coexist in ONE project graph read (whole-project, target=None).
    let g = get_graph(&server, &admin, project, None).await;
    let node = |rid: Uuid| {
        g["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["run_id"] == json!(rid.to_string()))
            .cloned()
    };
    let ds_node = node(run_ds).expect("the dataset-scoped run appears in the project graph");
    assert!(
        node(run_st).is_some(),
        "the project-scoped run appears too (both scopes coexist)"
    );

    // Backward-walkable: the dataset-scoped run's used-edge pins the dataset hash.
    assert_eq!(
        ds_node["inputs"][0]["kind"],
        json!("dataset"),
        "dataset-scoped used-edge kind"
    );
    assert_eq!(
        ds_node["inputs"][0]["content_hash"],
        json!(h_d),
        "pins the dataset content hash"
    );

    // Forward-walkable: the dataset's forward lineage includes the dataset-scoped run.
    let resp = get_forward_resp(&server, &admin, dataset).await;
    assert_eq!(resp.status().as_u16(), 200);
    let fg: serde_json::Value = resp.json().await.unwrap();
    let fwd_runs: Vec<String> = fg["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        fwd_runs.contains(&run_ds.to_string()),
        "the dataset-scoped run is forward-reachable from D"
    );

    // The project-scoped run node is untouched — project-scoped, its own root edge.
    let st_node = node(run_st).unwrap();
    assert_eq!(
        st_node["inputs"][0]["content_hash"],
        json!(h_root),
        "project-scoped run pins its project root"
    );
}
