//! TEST-52 [ITEM-25, ITEM-21] — forward lineage. `forward_reachable(dataset)`
//! (via `GET /provenance/forward?dataset_id=`) returns BOTH downstream pipelines'
//! runs + outputs (branching forward lineage) and stops at leaves — the inverse of
//! the backward walk.

use serde_json::json;
use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn forward_walk_returns_both_branches_and_stops_at_leaves() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _project = create_project(&server, &admin, "forward project").await;
    let pool = pool_for(&server).await;

    // A real uploaded dataset D → its content_hash is the forward-walk start.
    let (dataset, _file, h_d) = upload_dataset(
        &server,
        &admin,
        "PBMC forward",
        "matrix.csv",
        b"cell,gene\nc1,3\n",
    )
    .await;

    // Branch A: D → runA → runA2 (a two-step pipeline).
    let (h_a, h_a2) = (h(2), h(3));
    let run_a = Uuid::new_v4();
    let mut r = run_template(run_a, None, Some(dataset));
    r.inputs_json = json!([used_edge("dataset", "dataset", Some(dataset), &h_d)]);
    insert_run(&pool, &r).await;
    let a = seed_artifact(
        &pool,
        None,
        Some(dataset),
        Some(run_a),
        "expr",
        &h_a,
        "single-cell/expression",
        false)
    .await;

    let run_a2 = Uuid::new_v4();
    let mut r = run_template(run_a2, None, Some(dataset));
    r.inputs_json = json!([used_edge("input", "artifact", Some(a), &h_a)]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        None,
        Some(dataset),
        Some(run_a2),
        "filtered",
        &h_a2,
        "single-cell/expression",
        false)
    .await;

    // Branch B: D → runB (a separate one-step pipeline).
    let h_b = h(4);
    let run_b = Uuid::new_v4();
    let mut r = run_template(run_b, None, Some(dataset));
    r.inputs_json = json!([used_edge("dataset", "dataset", Some(dataset), &h_d)]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        None,
        Some(dataset),
        Some(run_b),
        "report",
        &h_b,
        "report/html",
        false)
    .await;

    let resp = get_forward_resp(&server, &admin, dataset).await;
    assert_eq!(resp.status().as_u16(), 200, "forward read is 200");
    let g: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(
        g["content_hash"],
        json!(h_d),
        "the forward start is the dataset's content hash"
    );

    let runs: Vec<String> = g["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect();
    for (label, id) in [("runA", run_a), ("runA2", run_a2), ("runB", run_b)] {
        assert!(
            runs.contains(&id.to_string()),
            "{label} is in the forward closure"
        );
    }
    assert_eq!(
        runs.len(),
        3,
        "forward closure is exactly the 3 downstream runs (stops at leaves)"
    );

    let outs: Vec<String> = g["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["content_hash"].as_str().unwrap_or("").to_string())
        .collect();
    for hh in [&h_a, &h_a2, &h_b] {
        assert!(
            outs.contains(hh),
            "the branch output {hh} is in the forward outputs"
        );
    }
    // The start (dataset) hash is not itself an "output" of the forward walk.
    assert!(
        !outs.contains(&h_d),
        "the dataset root is the start, not a derived output"
    );
}
