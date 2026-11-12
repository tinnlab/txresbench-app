//! **`status = 'ready'` records that INGEST succeeded, not that the bytes are still here.**
//!
//! Measured on a live project: 89 artifacts, every one `ready`, and every one of the 83
//! distinct blobs they referenced absent from the store. Every read of those artifacts
//! answered `404 Blob`, the plots came back empty, and nothing in the API could say WHY —
//! `GET /artifacts/{id}` reported a healthy `ready` row for each of them. The owner had to
//! ask a human.
//!
//! The report under test answers that question, and does ONLY that: it is read-only. It
//! never writes a status, never deletes a blob, never invents a cause. A blob can be
//! absent for legitimate reasons — an operator pruning a cache, a partial restore, a store
//! mounted at the wrong root — so the report says the bytes are not here and stops there.
//!
//! The two properties worth a test are therefore "it FINDS them" and "it CHANGES nothing",
//! and the second is asserted on both sides: the catalog rows still say `ready`, and the
//! blobs that WERE present are still present afterwards.

use serde_json::{json, Value};
use uuid::Uuid;

use txresbench::modules::workstore::catalog::repository::CatalogRepository;
use txresbench::modules::workstore::object_store::ObjectStore;

use super::{
    create_member_token, create_project, new_artifact, pool_for, server_store, setup_admin,
};
use crate::common::TestServer;

async fn presence_report(server: &TestServer, token: &str, project: Uuid) -> (u16, Value) {
    let resp = server
        .client
        .get(server.api_url(&format!("/projects/{project}/artifacts/bytes-presence")))
        .bearer_auth(token)
        .send()
        .await
        .expect("bytes-presence request");
    let code = resp.status().as_u16();
    (code, resp.json().await.unwrap_or(Value::Null))
}

/// The row the report emitted for `artifact_id`, or `None` when it emitted none.
fn row_for<'a>(report: &'a Value, artifact_id: Uuid) -> Option<&'a Value> {
    report["artifacts"]
        .as_array()?
        .iter()
        .find(|r| r["artifact_id"].as_str() == Some(&artifact_id.to_string()))
}

/// The measured incident, reproduced in miniature: three `ready` artifacts, two whose
/// bytes are in the store and one whose are not.
#[tokio::test]
async fn the_report_names_the_ready_artifacts_whose_bytes_are_not_here() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "presence").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    // Two artifacts whose bytes are really there…
    let mut here = Vec::new();
    for (i, payload) in [b"first blob".as_slice(), b"second blob".as_slice()]
        .into_iter()
        .enumerate()
    {
        let key = store.put(payload).await.expect("store a blob");
        let a = repo
            .insert_artifact(&new_artifact(
                project,
                &format!("present_{i}"),
                key.as_str(),
                false,
            ))
            .await
            .expect("insert artifact");
        here.push((a.id, key));
    }
    // …and one whose are not. Content-addressed, so a key with no blob behind it is
    // exactly the shape a freed blob leaves: the row is intact and points at nothing.
    let orphan_key = format!("sha256:{}", "b".repeat(64));
    let gone = repo
        .insert_artifact(&new_artifact(project, "gone", &orphan_key, false))
        .await
        .expect("insert artifact");
    assert_eq!(
        gone.status, "ready",
        "ingest succeeded, so the row says ready"
    );

    let (code, report) = presence_report(&server, &token, project).await;
    assert_eq!(code, 200, "the report is served: {report}");

    assert_eq!(
        report["checked"],
        json!(3),
        "every row was examined: {report}"
    );
    assert_eq!(report["present"], json!(2));
    assert_eq!(report["absent"], json!(1));
    assert_eq!(report["indeterminate"], json!(0));

    let row = row_for(&report, gone.id).expect("the artifact whose bytes are gone is listed");
    assert_eq!(row["presence"], json!("absent"));
    assert_eq!(row["output_id"], json!("gone"));
    let detail = row["detail"].as_str().unwrap_or_default();
    assert!(
        detail.contains("not in this store"),
        "the report says the bytes are NOT HERE: {detail:?}"
    );
    // Vocabulary: a blob can be absent for legitimate reasons, so the report must not
    // accuse anything of having removed it.
    for accusation in ["deleted", "delete", "lost", "corrupt"] {
        assert!(
            !detail.to_lowercase().contains(accusation),
            "the report must not accuse something of {accusation}: {detail:?}"
        );
    }

    // A row whose bytes ARE here is not listed — the report is the exception list, and a
    // report that listed everything would be indistinguishable from one that checked
    // nothing.
    for (id, _) in &here {
        assert!(
            row_for(&report, *id).is_none(),
            "an artifact whose bytes are present must not be reported"
        );
    }

    // ---- READ-ONLY, asserted on both sides ----
    for (id, key) in &here {
        assert_eq!(
            repo.get_any_status(*id).await.unwrap().unwrap().status,
            "ready",
            "the report must not restate a healthy row"
        );
        assert!(
            store.exists(key).await.unwrap(),
            "the report must never unlink a blob — it is not a second GC"
        );
    }
    assert_eq!(
        repo.get_any_status(gone.id).await.unwrap().unwrap().status,
        "ready",
        "the report REPORTS; it does not condemn. Flipping the status here would be a \
         write on a read path, and an absent blob is not evidence that the bytes were \
         ever wrong — an operator who restores the store must get their artifact back."
    );
}

/// A multi-file artifact is not present just because its MANIFEST is: the manifest is a
/// map to member blobs, and a report that stopped at the manifest would call an artifact
/// healthy when every chunk behind it is gone. This is the shape of the measured incident
/// — a Zarr artifact whose members were freed.
#[tokio::test]
async fn a_multifile_artifact_missing_a_member_is_reported_even_though_its_manifest_is_here() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let project = create_project(&server, &token, "presence-multifile").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());
    let store = server_store(&server);

    let put = store
        .put_prefix(&[
            ("zarr.json".to_string(), b"{\"shape\":[2]}".to_vec()),
            ("c/0".to_string(), b"CHUNK-ZERO".to_vec()),
        ])
        .await
        .expect("store a multi-file artifact");
    let a = repo
        .insert_artifact(&new_artifact(
            project,
            "chunked",
            put.object_key.as_str(),
            true,
        ))
        .await
        .expect("insert artifact");

    // Control: with every member here, it is reported as present (i.e. not listed).
    let (_, healthy) = presence_report(&server, &token, project).await;
    assert_eq!(healthy["present"], json!(1), "control: {healthy}");
    assert!(row_for(&healthy, a.id).is_none(), "control: {healthy}");

    // Now ONE member's bytes go away, exactly as a sweep would leave them: the manifest
    // blob survives and still names it.
    let member = put
        .members
        .iter()
        .find(|m| m.path == "c/0")
        .expect("the chunk member");
    store.delete(&member.blob).await.expect("free one member");
    assert!(
        store.exists(&put.object_key).await.unwrap(),
        "the manifest itself is still here — that is the whole point of this test"
    );

    let (code, report) = presence_report(&server, &token, project).await;
    assert_eq!(code, 200);
    assert_eq!(report["absent"], json!(1), "{report}");
    let row = row_for(&report, a.id).expect("the artifact is listed");
    assert_eq!(row["presence"], json!("absent"));
    let detail = row["detail"].as_str().unwrap_or_default();
    assert!(
        detail.contains("c/0"),
        "the report NAMES the member that is not here, so an operator can act on it: \
         {detail:?}"
    );
}

/// The report reads a project's catalog, so it is gated exactly as the catalog is: a
/// principal with no role on the project gets the project's own 404, never a report and
/// never a 403 (which would confirm the project exists).
#[tokio::test]
async fn a_principal_with_no_role_on_the_project_gets_the_projects_own_404() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let project = create_project(&server, &admin, "presence-authz").await;
    let (_uid, outsider) = create_member_token(&server, &admin, "outsider").await;

    let (code, body) = presence_report(&server, &outsider, project).await;
    assert_eq!(
        code, 404,
        "a foreign project is invisible, so its storage health is too: {body}"
    );
}
