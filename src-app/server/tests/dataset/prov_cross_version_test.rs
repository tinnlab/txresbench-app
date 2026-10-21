//! TEST-53 [ITEM-25, ITEM-22] — cross-version (heterogeneous-environment) chain.
//! Step 1 ran under rootfs digest D1, step 2 under D2. Each run node records its
//! OWN `env_rootfs_sha256`; the chain is intact (step 2 consumes step 1's output);
//! and an export of the chain lists BOTH digests in `environments.json`.

use serde_json::json;
use uuid::Uuid;

use super::hardening_common::*;
use super::setup_admin;
use crate::common::TestServer;

#[tokio::test]
async fn each_step_pins_its_own_env_and_export_lists_both() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "cross version project").await;
    let pool = pool_for(&server).await;

    let d1 = "1".repeat(64); // rootfs digest for step 1 (bare hex)
    let d2 = "2".repeat(64); // rootfs digest for step 2 (a DIFFERENT app version)

    // Root R.
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

    // Step 1 @ D1 → output O1.
    let sha1 = store_code(&pool, "import scanpy as sc\nprint('step1')\n", "python").await;
    let run1 = Uuid::new_v4();
    let mut r = run_template(run1, Some(project), None);
    r.env_rootfs_sha256 = Some(d1.clone());
    r.code_sha256 = Some(sha1);
    r.inputs_json = json!([used_edge("input", "upload", Some(root), &h_root)]);
    insert_run(&pool, &r).await;
    let (_o1, h_o1) = seed_blob_artifact(
        &server,
        Some(project),
        None,
        Some(run1),
        "expr",
        b"STEP1-OUTPUT",
        "single-cell/expression")
    .await;

    // Step 2 @ D2 → consumes O1 → output O2.
    let sha2 = store_code(&pool, "import scanpy as sc\nprint('step2')\n", "python").await;
    let run2 = Uuid::new_v4();
    let mut r = run_template(run2, Some(project), None);
    r.env_rootfs_sha256 = Some(d2.clone());
    r.code_sha256 = Some(sha2);
    r.inputs_json = json!([used_edge("input", "artifact", None, &h_o1)]);
    insert_run(&pool, &r).await;
    let _ = seed_blob_artifact(
        &server,
        Some(project),
        None,
        Some(run2),
        "filtered",
        b"STEP2-OUTPUT",
        "single-cell/expression")
    .await;

    // Each run node records its OWN env digest (via the graph read).
    let g = get_graph(&server, &admin, project, Some(run2)).await;
    let env_of = |rid: Uuid| -> String {
        g["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["run_id"] == json!(rid.to_string()))
            .and_then(|r| r["env_rootfs_sha256"].as_str())
            .unwrap_or("")
            .to_string()
    };
    assert_eq!(env_of(run1), d1, "step 1 pins D1");
    assert_eq!(env_of(run2), d2, "step 2 pins D2 (its own, distinct env)");
    // The chain is intact — the backward closure spans both steps.
    let runs: Vec<String> = g["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        runs.contains(&run1.to_string()) && runs.contains(&run2.to_string()),
        "the 2-step chain is intact across the version boundary"
    );

    // The export's environments.json lists BOTH distinct digests.
    let export_id = export_bundle(&server, &admin, project, Some(run2), "single").await;
    let members = unzip_store(&download_zip(&server, &admin, &export_id).await);
    let (_, env_bytes) = members
        .iter()
        .find(|(n, _)| n == "environments.json")
        .expect("environments.json member present");
    let env_txt = String::from_utf8_lossy(env_bytes);
    assert!(
        env_txt.contains(&d1),
        "environments.json lists step 1's rootfs digest D1"
    );
    assert!(
        env_txt.contains(&d2),
        "environments.json lists step 2's rootfs digest D2"
    );
}
