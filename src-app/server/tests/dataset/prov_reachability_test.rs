//! TEST-48 [ITEM-25, ITEM-20] — provenance reachability under branching: one
//! dataset ROOT fans into TWO independent pipelines; each pipeline's final output
//! backward-reaches the shared ROOT; a THIRD, unrelated chain is NOT reachable
//! (isolation); the closure has no cycle and terminates (a bounded run set).

use serde_json::{json, Value};
use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn one_root_fans_into_two_pipelines_isolated_and_acyclic() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "reachability project").await;
    let pool = pool_for(&server).await;

    // Shared uploaded ROOT R (run-less → a closure terminus).
    let h_root = h(1);
    // Distinct output_id per run-less root — the catalog natural key COALESCEs a
    // NULL run_id to nil, so two roots sharing an output_id would collide/upsert.
    let root_id = seed_artifact(
        &pool,
        Some(project),
        None,
        None,
        "upload_shared",
        &h_root,
        "single-cell/expression",
        false)
    .await;

    // ---- Pipeline A: R → runA1 → runA2 (final A2). ----
    let (h_a1, h_a2) = (h(2), h(3));
    let run_a1 = Uuid::new_v4();
    let mut r = run_template(run_a1, Some(project), None);
    r.inputs_json = json!([used_edge("input", "upload", Some(root_id), &h_root)]);
    insert_run(&pool, &r).await;
    let a1 = seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run_a1),
        "expr",
        &h_a1,
        "single-cell/expression",
        false)
    .await;

    let run_a2 = Uuid::new_v4();
    let mut r = run_template(run_a2, Some(project), None);
    r.inputs_json = json!([used_edge("input", "artifact", Some(a1), &h_a1)]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run_a2),
        "filtered",
        &h_a2,
        "single-cell/expression",
        false)
    .await;

    // ---- Pipeline B: R → runB1 (final B1). ----
    let h_b1 = h(4);
    let run_b1 = Uuid::new_v4();
    let mut r = run_template(run_b1, Some(project), None);
    r.inputs_json = json!([used_edge("input", "upload", Some(root_id), &h_root)]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run_b1),
        "report",
        &h_b1,
        "report/html",
        false)
    .await;

    // ---- Third, UNRELATED chain in the same project (different root). ----
    let (h_troot, h_t1) = (h(5), h(6));
    let troot = seed_artifact(
        &pool,
        Some(project),
        None,
        None,
        "upload_third",
        &h_troot,
        "single-cell/expression",
        false)
    .await;
    let run_t = Uuid::new_v4();
    let mut r = run_template(run_t, Some(project), None);
    r.inputs_json = json!([used_edge("input", "upload", Some(troot), &h_troot)]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run_t),
        "expr",
        &h_t1,
        "single-cell/expression",
        false)
    .await;

    // Backward from pipeline A's FINAL (runA2): reaches runA2 + runA1 + the shared
    // root, and NOT the third chain.
    let g = get_graph(&server, &admin, project, Some(run_a2)).await;
    let runs: Vec<String> = run_ids(&g);
    assert!(
        runs.contains(&run_a2.to_string()) && runs.contains(&run_a1.to_string()),
        "pipeline A's closure has both its runs"
    );
    assert!(
        !runs.contains(&run_b1.to_string()),
        "pipeline B is a separate branch, not in A's closure"
    );
    assert!(
        !runs.contains(&run_t.to_string()),
        "the third chain is NOT reachable (isolation)"
    );
    assert!(
        root_hashes(&g).contains(&h_root),
        "A backward-reaches the shared upload root"
    );
    assert!(
        !root_hashes(&g).contains(&h_troot),
        "the third chain's root is not a terminus here"
    );
    // No cycle → the run set is BOUNDED (exactly the two A-runs, not runaway).
    assert_eq!(
        runs.len(),
        2,
        "the closure terminates at exactly runA1 + runA2 (acyclic, finite)"
    );

    // Backward from pipeline B's FINAL (runB1): reaches the SAME shared root.
    let g = get_graph(&server, &admin, project, Some(run_b1)).await;
    assert!(
        root_hashes(&g).contains(&h_root),
        "B backward-reaches the SAME shared root"
    );
    assert!(
        !run_ids(&g).contains(&run_a1.to_string()),
        "B's closure excludes A's runs"
    );

    // Backward from the third chain: reaches ONLY its own root, never the shared R.
    let g = get_graph(&server, &admin, project, Some(run_t)).await;
    assert!(
        root_hashes(&g).contains(&h_troot),
        "the third chain reaches its own root"
    );
    assert!(
        !root_hashes(&g).contains(&h_root),
        "the third chain never reaches the shared root"
    );
}

fn run_ids(graph: &Value) -> Vec<String> {
    graph["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect()
}
fn root_hashes(graph: &Value) -> Vec<String> {
    graph["roots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["content_hash"].as_str().unwrap_or("").to_string())
        .collect()
}
