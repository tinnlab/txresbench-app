//! Finding-1 regression [P4 blind audit] — the forward-lineage endpoint must NOT
//! leak a PRIVATE downstream dataset's runs/artifacts to a mere view-sharee of the
//! START dataset. The forward walk crosses promote boundaries into datasets the
//! owner promoted from the start's artifacts; authorizing ONLY the start dataset
//! (the old behavior) exposed a downstream private dataset's run nodes (code
//! hashes / params / acting_user) + artifact hashes. The fix threads the CALLER's
//! identity into `read_forward_graph` and folds a downstream dataset ONLY when the
//! caller can see it (filter, don't authorize-once).
//!
//! Chain: X (uploaded, admin-owned; SHARED view→bob) → run_x → artifact A. Admin
//! promotes A into a PRIVATE dataset Y (NOT shared with bob); Y has a promote node
//! + a downstream compute run_y → artifact B.
//!   - admin (owner of both) sees the WHOLE forward closure (positive control —
//!     proves the data the leak WOULD have exposed actually exists).
//!   - bob (view-sharee of X only) sees ONLY X's own lineage; Y's promote/compute
//!     runs + artifact B are excluded.

use serde_json::json;
use uuid::Uuid;

use txresbench::modules::dataset::repository::DatasetRepository;

use super::hardening_common::*;
use super::{create_user, login, setup_admin};
use crate::common::TestServer;

/// Share a dataset with a user principal (view) via the owner's REST surface.
async fn share_view(server: &TestServer, owner: &str, dataset_id: Uuid, principal_user_id: &str) {
    let resp = server
        .client
        .post(server.api_url(&format!("/datasets/{dataset_id}/shares")))
        .bearer_auth(owner)
        .json(
            &json!({ "principal_type": "user", "principal_id": principal_user_id, "role": "view" }),
        )
        .send()
        .await
        .expect("share dataset");
    assert_eq!(
        resp.status().as_u16(),
        201,
        "share {dataset_id} → user (view)"
    );
}

#[tokio::test]
async fn forward_graph_excludes_private_downstream_dataset_for_a_view_sharee() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let bob_id = create_user(&server, &admin, "bob", "bob@x.test").await;
    let bob = login(&server, "bob").await;
    let pool = pool_for(&server).await;

    // START dataset X (admin-owned) with a real uploaded file → its content hash.
    let (dataset_x, _file_x, h_x) = upload_dataset(
        &server,
        &admin,
        "PBMC start",
        "matrix.csv",
        b"cell,gene\nc1,3\n",
    )
    .await;
    // admin shares X with bob (VIEW only).
    share_view(&server, &admin, dataset_x, &bob_id).await;
    let admin_id = DatasetRepository::new(pool.clone())
        .owner_of(dataset_x)
        .await
        .expect("owner lookup")
        .expect("X has an owner");

    // X's own processing: run_x consumes X's hash → produces artifact A (h_a).
    let h_a = h(2);
    let run_x = Uuid::new_v4();
    let mut r = run_template(run_x, None, Some(dataset_x));
    r.inputs_json = json!([used_edge("dataset", "dataset", Some(dataset_x), &h_x)]);
    insert_run(&pool, &r).await;
    let a = seed_artifact(
        &pool,
        None,
        Some(dataset_x),
        Some(run_x),
        "expr",
        &h_a,
        "single-cell/expression",
        false)
    .await;

    // A PRIVATE downstream dataset Y (admin-owned, NOT shared with bob), promoted
    // from A. A byte-preserving promote ⇒ Y's link hash == A's hash (h_a).
    let dataset_y = new_dataset(&server, &admin, "PRIVATE promoted").await;
    // The promote node crosses the boundary forward (kind='promote', acting_user =
    // X's owner so the forward walk's `promote_runs_for_user` discovers it).
    let run_promote = Uuid::new_v4();
    let mut r = run_template(run_promote, None, Some(dataset_y));
    r.kind = "promote".into();
    r.acting_user = Some(admin_id);
    r.inputs_json = json!([used_edge("source", "artifact", Some(a), &h_a)]);
    insert_run(&pool, &r).await;

    // Y's PRIVATE downstream compute: run_y consumes Y's hash (h_a) → artifact B.
    let h_b = h(3);
    let run_y = Uuid::new_v4();
    let mut r = run_template(run_y, None, Some(dataset_y));
    r.code_sha256 = Some(store_code(&pool, "secret_downstream_code()\n", "python").await);
    r.inputs_json = json!([used_edge("dataset", "dataset", Some(dataset_y), &h_a)]);
    insert_run(&pool, &r).await;
    seed_artifact(
        &pool,
        None,
        Some(dataset_y),
        Some(run_y),
        "filtered",
        &h_b,
        "single-cell/expression",
        false)
    .await;

    // ---- positive control: the OWNER sees the WHOLE forward closure ----
    // (proves the runs/artifacts the leak would expose genuinely exist).
    let admin_resp = get_forward_resp(&server, &admin, dataset_x).await;
    assert_eq!(
        admin_resp.status().as_u16(),
        200,
        "owner forward read is 200"
    );
    let ag: serde_json::Value = admin_resp.json().await.unwrap();
    let admin_runs: Vec<String> = ag["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect();
    for (label, id) in [
        ("run_x", run_x),
        ("run_promote", run_promote),
        ("run_y", run_y),
    ] {
        assert!(
            admin_runs.contains(&id.to_string()),
            "owner sees {label} in the forward closure"
        );
    }
    let admin_outs: Vec<String> = ag["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["content_hash"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(
        admin_outs.contains(&h_a) && admin_outs.contains(&h_b),
        "owner sees BOTH the visible + downstream-private outputs"
    );

    // ---- the fix: a VIEW-SHAREE of X sees ONLY X's own lineage ----
    let bob_resp = get_forward_resp(&server, &bob, dataset_x).await;
    assert_eq!(
        bob_resp.status().as_u16(),
        200,
        "sharee forward read is 200 (X is visible)"
    );
    let bg: serde_json::Value = bob_resp.json().await.unwrap();
    assert_eq!(
        bg["content_hash"],
        json!(h_x),
        "the forward start is X's content hash"
    );

    let bob_runs: Vec<String> = bg["runs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["run_id"].as_str().unwrap().to_string())
        .collect();
    assert!(
        bob_runs.contains(&run_x.to_string()),
        "sharee sees X's own run (visible lineage)"
    );
    assert!(
        !bob_runs.contains(&run_promote.to_string()),
        "sharee must NOT see the promote node of a private downstream dataset"
    );
    assert!(
        !bob_runs.contains(&run_y.to_string()),
        "sharee must NOT see a private downstream dataset's compute run (leak guard)"
    );
    assert_eq!(
        bob_runs.len(),
        1,
        "sharee's forward closure is exactly X's own run"
    );

    let bob_outs: Vec<String> = bg["outputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["content_hash"].as_str().unwrap_or("").to_string())
        .collect();
    assert!(
        bob_outs.contains(&h_a),
        "sharee sees X's own visible output"
    );
    assert!(
        !bob_outs.contains(&h_b),
        "sharee must NOT see a private downstream dataset's artifact hash (leak guard)"
    );
}
