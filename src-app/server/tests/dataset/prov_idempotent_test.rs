//! TEST-55 [ITEM-25, ITEM-20] — idempotent re-ingest. Re-ingesting the same run
//! manifest (the `(project_id, run_id, output_id)` natural key) does NOT duplicate
//! artifacts, and the run's output SIGNATURE (the set of `(output_id,
//! content_hash)`) is byte-stable across ingests.

use serde_json::json;
use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn re_ingesting_same_manifest_does_not_duplicate() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "idempotent project").await;
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

    let run = Uuid::new_v4();
    let mut r = run_template(run, Some(project), None);
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;

    let outs = || {
        vec![
            OutSpec::file(
                "expression",
                "single-cell/expression",
                b"MATRIX-V1",
                "artifact",
            ),
            OutSpec::file("report", "report/html", b"REPORT-V1", "artifact"),
        ]
    };

    // First ingest → 2 rows.
    let rows1 = ingest_manifest(&server, &pool, Some(project), None, run, &outs()).await;
    assert_eq!(rows1.len(), 2, "two declared outputs → two rows");

    // Re-ingest the SAME manifest (same run_id, same bytes) → STILL 2 rows.
    let rows2 = ingest_manifest(&server, &pool, Some(project), None, run, &outs()).await;
    assert_eq!(
        rows2.len(),
        2,
        "re-ingest returns the two rows again (upsert, not insert)"
    );

    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM artifacts WHERE run_id = $1")
        .bind(run)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        total, 2,
        "the natural key prevented duplicate artifacts (2, not 4)"
    );

    // The output signature is stable: same (output_id, content_hash) both times.
    let sig = |rows: &[cytoanalyst::modules::workstore::catalog::models::Artifact]| {
        let mut v: Vec<(String, String)> = rows
            .iter()
            .map(|a| (a.output_id.clone(), a.content_hash.clone()))
            .collect();
        v.sort();
        v
    };
    assert_eq!(
        sig(&rows1),
        sig(&rows2),
        "the run's output signature is byte-stable across ingests"
    );

    // The provenance run node's used-edge set is untouched by re-ingest.
    let edges: i64 = sqlx::query_scalar(
        "SELECT json_array_length(inputs_json) FROM provenance_run_repro WHERE run_id = $1")
        .bind(run).fetch_one(&pool).await.unwrap();
    assert_eq!(
        edges, 1,
        "the run's used-edge set is unchanged (one pinned input)"
    );
}
