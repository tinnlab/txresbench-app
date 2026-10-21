//! TEST-23 — deleting a project (the real project-delete REST path) cascades its
//! `provenance_run_repro` + project-scoped `provenance_reference_resources` rows via
//! the provenance project-extension (order 60).

use super::*;

use cytoanalyst::modules::provenance::repository::{NewReference, ProvenanceRepository};

#[tokio::test]
async fn deleting_a_project_cascades_provenance_rows() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let (project_id, root_id, _hash) =
        create_project_with_artifact(&server, &admin, "extension project").await;

    // Seed a run (records a provenance_run_repro row) + a project-scoped reference.
    record_selection(&server, &admin, project_id, root_id, column_recipe("3")).await;
    let pool = pool_for(&server).await;
    ProvenanceRepository::new(pool.clone())
        .insert_reference(&NewReference {
            project_id: Some(project_id),
            kind: "atlas".to_string(),
            name: "HLCA".to_string(),
            version: "v2".to_string(),
            accession: None,
            doi: None,
            content_hash: format!("sha256:{}", "c".repeat(64)),
        })
        .await
        .expect("seed reference");

    // Sanity: the rows exist before the delete.
    let runs_before: i64 =
        sqlx::query_scalar("SELECT count(*) FROM provenance_run_repro WHERE project_id = $1")
            .bind(project_id)
            .fetch_one(&pool)
            .await
            .expect("count runs before");
    assert_eq!(runs_before, 1, "one run row before delete");
    let refs_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM provenance_reference_resources WHERE project_id = $1",
    )
    .bind(project_id)
    .fetch_one(&pool)
    .await
    .expect("count refs before");
    assert_eq!(refs_before, 1, "one project-scoped reference before delete");

    // Delete the project via the real REST path → 204.
    let del = server
        .client
        .delete(server.api_url(&format!("/projects/{project_id}")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("delete project");
    assert_eq!(del.status().as_u16(), 204, "project delete is 204");

    // The provenance rows for that project are gone.
    let runs_after: i64 =
        sqlx::query_scalar("SELECT count(*) FROM provenance_run_repro WHERE project_id = $1")
            .bind(project_id)
            .fetch_one(&pool)
            .await
            .expect("count runs after");
    assert_eq!(runs_after, 0, "run rows cascaded on project delete");
    let refs_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM provenance_reference_resources WHERE project_id = $1",
    )
    .bind(project_id)
    .fetch_one(&pool)
    .await
    .expect("count refs after");
    assert_eq!(refs_after, 0, "project-scoped references cascaded on project delete");
}
