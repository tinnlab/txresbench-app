//! TEST-20 / TEST-A7 [ITEM-20 / ITEM-21] — the multi-modal data plane serves obs/var PER
//! modality via the EXISTING per-artifact path (INV-9/INV-7/INV-8: a modality is referenced BY
//! NAME, MuData-shaped, never positionally; no modality is privileged).
//!
//! A multi-modal ingest lands each modality as its OWN first-class artifact (an RNA
//! `single-cell/expression` matrix + a protein `single-cell/protein` (ADT) matrix — PEERS, per
//! `datatype::builtin`), sharing one run/project. There is no modality-specific serve route: each
//! modality's bytes are retrieved through the ONE existing per-artifact data-plane
//! (`GET /artifacts/{id}/data`), resolved by the modality's own artifact id (its `output_id` is the
//! modality NAME `rna`/`prot` — `$data.modality.<name>`), so:
//!   * BOTH modalities surface in the project catalog listing (each addressable by name);
//!   * EACH modality's distinct bytes are served independently over the existing per-artifact path
//!     (proving per-modality serve, not a single flattened matrix and not a positional coupling).
//!
//! This closes the Phase-3 enumeration↔implementation gap: `data_api` has no modality-specific
//! serve path because none is needed — modalities are separate per-modality artifacts served by the
//! existing per-artifact path, which this test exercises end-to-end (real server + real store + real
//! HTTP), rather than only indirectly via the FE `$data.modality.<name>` resolution (TEST-21).

use serde_json::{json, Value};
use uuid::Uuid;

use cytoanalyst::modules::workstore::catalog::models::NewArtifact;
use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::object_store::ObjectStore;

use super::{create_project, pool_for, server_store, setup_admin};

/// One per-modality catalog row: `output_id` is the modality NAME (`rna`/`prot` —
/// `$data.modality.<name>`), `datatype` its own peer datatype, sharing one ingest `run_id`.
fn modality_artifact(
    project_id: Uuid,
    run_id: Uuid,
    modality: &str,
    datatype: &str,
    object_key: &str,
) -> NewArtifact {
    NewArtifact {
        project_id: Some(project_id),
        dataset_id: None,
        run_id: Some(run_id),
        output_id: modality.to_string(),
        datatype: datatype.to_string(),
        object_key: Some(object_key.to_string()),
        is_multifile: false,
        content_hash: format!("sha256:{}", "0".repeat(64)),
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

#[tokio::test]
async fn multimodal_per_modality_artifacts_are_each_served_by_name_over_the_existing_path() {
    let server = crate::common::TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "modality serve").await;
    let pool = pool_for(&server).await;
    let store = server_store(&server);
    let repo = CatalogRepository::new(pool);

    // ONE multi-modal ingest (shared run): each modality is a SEPARATE artifact with its OWN blob —
    // distinct bytes prove they are not the same flattened matrix.
    let run_id = Uuid::new_v4();
    let rna_bytes: Vec<u8> = (0u8..16).collect();
    let prot_bytes: Vec<u8> = (100u8..116).collect();
    let rna_key = store.put(&rna_bytes).await.unwrap();
    let prot_key = store.put(&prot_bytes).await.unwrap();

    let rna = repo
        .insert_artifact(&modality_artifact(
            sid,
            run_id,
            "rna",
            "single-cell/expression",
            rna_key.as_str(),
        ))
        .await
        .unwrap();
    let prot = repo
        .insert_artifact(&modality_artifact(
            sid,
            run_id,
            "prot",
            "single-cell/protein",
            prot_key.as_str(),
        ))
        .await
        .unwrap();

    // --- BOTH modalities surface in the project catalog listing, each addressable BY NAME ---
    let items: Value = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/artifacts")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let arr = items.as_array().expect("artifacts array");
    let by_modality = |name: &str| arr.iter().find(|a| a["output_id"].as_str() == Some(name));
    let rna_row = by_modality("rna").expect("rna modality artifact listed");
    let prot_row = by_modality("prot").expect("prot modality artifact listed");
    // The modalities are PEERS with distinct datatypes — protein is not folded into / privileged
    // under expression (INV-8), and neither is a positional index into a flattened matrix.
    assert_eq!(rna_row["datatype"], json!("single-cell/expression"));
    assert_eq!(prot_row["datatype"], json!("single-cell/protein"));
    assert_ne!(
        rna_row["id"].as_str().unwrap(),
        prot_row["id"].as_str().unwrap(),
        "each modality is its OWN artifact (not one shared matrix)"
    );

    // --- EACH modality's bytes are served independently via the EXISTING per-artifact path ---
    // (no modality-specific route — the modality name resolves to its artifact id, then the ONE
    //  `GET /artifacts/{id}/data` streams that modality's own blob).
    let serve = |id: Uuid| {
        let server = &server;
        let token = &token;
        async move {
            let r = server
                .client
                .get(server.api_url(&format!("/artifacts/{id}/data")))
                .bearer_auth(token)
                .send()
                .await
                .unwrap();
            assert_eq!(
                r.status().as_u16(),
                200,
                "per-modality artifact served over the existing path"
            );
            r.bytes().await.unwrap().to_vec()
        }
    };
    assert_eq!(
        serve(rna.id).await,
        rna_bytes,
        "the rna modality serves ITS OWN bytes"
    );
    assert_eq!(
        serve(prot.id).await,
        prot_bytes,
        "the prot modality serves ITS OWN bytes"
    );
}
