//! TEST-18 — a `provenance_reference_resources` row (accession/DOI + content
//! hash) is a valid closure terminus: an input pinned to it passes the resolver
//! and the backward walk stops there.

use super::*;

use cytoanalyst::modules::provenance::repository::{NewReference, ProvenanceRepository};

#[tokio::test]
async fn reference_resource_is_a_valid_closure_terminus() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project_id = create_project(&server, &admin, "reference project").await;

    // Seed a project-scoped reference resource (a pinned genome/annotation root).
    let pool = pool_for(&server).await;
    let ref_hash = format!("sha256:{}", "b".repeat(64));
    let reference = ProvenanceRepository::new(pool.clone())
        .insert_reference(&NewReference {
            project_id: Some(project_id),
            kind: "annotation".to_string(),
            name: "GENCODE".to_string(),
            version: "v45".to_string(),
            accession: Some("GENCODE-45".to_string()),
            doi: Some("10.1093/nar/gkaa1087".to_string()),
            content_hash: ref_hash.clone(),
        })
        .await
        .expect("seed reference resource");

    // A selection whose input resolves to the reference passes the resolver.
    let run = record_selection(&server, &admin, project_id, reference.id, column_recipe("3")).await;
    let inputs = run["inputs"].as_array().expect("inputs");
    assert_eq!(inputs.len(), 1);
    assert_eq!(inputs[0]["kind"], json!("reference"), "used edge kind is reference");
    assert_eq!(inputs[0]["content_hash"], json!(ref_hash), "pins the reference hash");

    // The backward walk from that run terminates (no producing run for the
    // reference input) — the graph read returns cleanly with the run present.
    let run_id = run["run_id"].as_str().unwrap();
    let resp = server
        .client
        .get(server.api_url(&format!(
            "/provenance/graph?project_id={project_id}&target={run_id}"
        )))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("get graph");
    assert_eq!(resp.status().as_u16(), 200);
    let graph: Value = resp.json().await.expect("graph json");
    let runs = graph["runs"].as_array().expect("runs");
    assert!(
        runs.iter().any(|r| r["run_id"] == json!(run_id)),
        "the run is in the terminating walk"
    );

    // An UNKNOWN input (never seeded) is rejected by the closure guard (400).
    let bogus = Uuid::new_v4();
    let deny = server
        .client
        .post(server.api_url("/provenance/selections"))
        .bearer_auth(&admin)
        .json(&json!({
            "project_id": project_id,
            "input_artifact_id": bogus,
            "recipe": column_recipe("3"),
            "label": null,
        }))
        .send()
        .await
        .expect("record unknown selection");
    assert_eq!(deny.status().as_u16(), 400, "an unknown input is rejected (no from-nowhere hole)");
}
