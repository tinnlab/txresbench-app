//! TEST-49 [ITEM-25, ITEM-6] — a multi-output run where only `expression` is
//! consumed downstream leaves the unused `qc-density` intermediate OFF the export
//! dependency closure (a sibling of an upstream run the walk never followed is
//! excluded), yet the intermediate still REGENERATES when the producer re-runs
//! (produce-atomically — it is part of the run's atomic output set, not dropped).

use serde_json::json;
use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn unused_intermediate_excluded_from_export_but_regenerates() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "dead output project").await;
    let pool = pool_for(&server).await;

    // Root R.
    let h_root = h(1);
    let root_id = seed_artifact(
        &pool,
        Some(project),
        None,
        None,
        "upload",
        &h_root,
        "single-cell/expression",
        false)
    .await;

    // qc-10x: a real multi-output run — expression (artifact, consumed) +
    // qc-density (intermediate, viz-only, NEVER consumed downstream).
    let run1 = Uuid::new_v4();
    let mut r = run_template(run1, Some(project), None);
    r.inputs_json = json!([used_edge("input", "upload", Some(root_id), &h_root)]);
    insert_run(&pool, &r).await;
    let rows = ingest_manifest(
        &server,
        &pool,
        Some(project),
        None,
        run1,
        &[
            OutSpec::file(
                "expression",
                "single-cell/expression",
                b"EXPRESSION-MATRIX-BYTES",
                "artifact",
            ),
            OutSpec::file(
                "qc-density",
                "report/html",
                b"QC-DENSITY-VIZ-ONLY",
                "intermediate",
            ),
        ],
    )
    .await;
    let h_expr = rows
        .iter()
        .find(|a| a.output_id == "expression")
        .unwrap()
        .content_hash
        .clone();
    let h_qc = rows
        .iter()
        .find(|a| a.output_id == "qc-density")
        .unwrap()
        .content_hash
        .clone();
    assert_ne!(
        h_expr, h_qc,
        "the two outputs have distinct content identities"
    );

    // cell-filter: consumes ONLY expression.
    let run2 = Uuid::new_v4();
    let mut r = run_template(run2, Some(project), None);
    r.inputs_json = json!([used_edge("input", "artifact", None, &h_expr)]);
    insert_run(&pool, &r).await;
    let _ = seed_blob_artifact(
        &server,
        Some(project),
        None,
        Some(run2),
        "filtered",
        b"FILTERED-EXPRESSION",
        "single-cell/expression")
    .await;

    // Export the run2 closure: it carries the CONSUMED expression, NOT the dead
    // qc-density sibling of the upstream producer.
    let export_id = export_bundle(&server, &admin, project, Some(run2), "single").await;
    let zip = download_zip(&server, &admin, &export_id).await;
    let names: Vec<String> = unzip_store(&zip).into_iter().map(|(n, _)| n).collect();
    let expr_member = format!("data/{}", h_expr.strip_prefix("sha256:").unwrap());
    let qc_member = format!("data/{}", h_qc.strip_prefix("sha256:").unwrap());
    assert!(
        names.contains(&expr_member),
        "the CONSUMED expression is in the export closure"
    );
    assert!(
        !names.contains(&qc_member),
        "the UNUSED qc-density intermediate is OFF the dependency path (excluded from the export)"
    );

    // Produce-atomically: re-running the producer regenerates the intermediate —
    // it is not garbage-collected just because it is unused downstream.
    let rows2 = ingest_manifest(
        &server,
        &pool,
        Some(project),
        None,
        run1,
        &[
            OutSpec::file(
                "expression",
                "single-cell/expression",
                b"EXPRESSION-MATRIX-BYTES",
                "artifact",
            ),
            OutSpec::file(
                "qc-density",
                "report/html",
                b"QC-DENSITY-VIZ-ONLY",
                "intermediate",
            ),
        ],
    )
    .await;
    assert!(
        rows2.iter().any(|a| a.output_id == "qc-density"),
        "the intermediate regenerates on the producer's re-run (atomic output set)"
    );
    let qc_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM artifacts WHERE run_id = $1 AND output_id = 'qc-density'",
    )
    .bind(run1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        qc_count, 1,
        "re-run is idempotent — one qc-density row, not two"
    );
}
