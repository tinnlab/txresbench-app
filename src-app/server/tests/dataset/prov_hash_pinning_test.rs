//! TEST-50 [ITEM-25, ITEM-20] — used-edge content-hash pinning. A run's
//! `inputs_json` pins each input's `content_hash`, and the backward walk links an
//! input to a producer ONLY when the producer's output hash MATCHES. A
//! tampered/different-hash artifact does NOT create a false edge; an input pinned
//! to a hash no producer has terminates as a root (no from-nowhere edge).

use serde_json::json;
use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn backward_walk_links_only_matching_output_hash() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "hash pinning project").await;
    let pool = pool_for(&server).await;

    let h_root = h(1);
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

    // Producer P → output pinned at H_real.
    let h_real = h(2);
    let run_p = Uuid::new_v4();
    let mut r = run_template(run_p, Some(project), None);
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;
    let _ = seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run_p),
        "out",
        &h_real,
        "single-cell/expression",
        false)
    .await;

    // A DIFFERENT producer X → output pinned at H_diff (the "tamper" — a producer
    // with a mismatched hash must never be linked to a consumer of H_real).
    let h_diff = h(3);
    let run_x = Uuid::new_v4();
    let mut r = run_template(run_x, Some(project), None);
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;
    let _ = seed_artifact(
        &pool,
        Some(project),
        None,
        Some(run_x),
        "out",
        &h_diff,
        "single-cell/expression",
        false)
    .await;

    // Consumer C pins H_real → its backward walk reaches P (matching hash), NOT X.
    let run_c = Uuid::new_v4();
    let mut r = run_template(run_c, Some(project), None);
    r.inputs_json = json!([used_edge("input", "artifact", None, &h_real)]);
    insert_run(&pool, &r).await;

    let g = get_graph(&server, &admin, project, Some(run_c)).await;
    let runs: Vec<String> = g["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        runs.contains(&run_p.to_string()),
        "the consumer links to the producer whose hash MATCHES"
    );
    assert!(
        !runs.contains(&run_x.to_string()),
        "a producer with a DIFFERENT output hash is NOT falsely linked (no tamper edge)"
    );

    // Consumer G pins a GHOST hash no producer emits → the walk terminates there
    // (a from-nowhere root), never fabricating an edge.
    let h_ghost = h(9);
    let run_g = Uuid::new_v4();
    let mut r = run_template(run_g, Some(project), None);
    r.inputs_json = json!([used_edge("input", "artifact", None, &h_ghost)]);
    insert_run(&pool, &r).await;
    let g = get_graph(&server, &admin, project, Some(run_g)).await;
    let runs: Vec<String> = g["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        runs,
        vec![run_g.to_string()],
        "a pinned hash with no producer yields ONLY the run itself — no phantom producer edge"
    );
    // (A dangling hash with no artifact/reference row is a terminating leaf but is
    // not projected as a `roots[]` node — roots are drawn from existing rows. The
    // `runs == [run_g]` check above IS the no-phantom-edge proof.)
}
