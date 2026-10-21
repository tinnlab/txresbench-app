//! TEST-18 [ITEM-20] — hidden / alternate-representation artifacts. A derived
//! artifact marked `hidden=true` with `representation_of=Some(source_id)`:
//!   * ROUND-TRIPS through the catalog repository (`get` / `list_by_run` /
//!     `list_by_project` preserve both columns — the repo is pure SQL, it does
//!     NOT filter);
//!   * is FILTERED OUT of the catalog READ path (`GET /projects/{id}/artifacts`
//!     and `/catalog` exclude hidden, per `data_api::retain(|a| !a.hidden)`);
//!   * stays EXPOSED (fetchable by id) via `GET /artifacts/{id}`.
//!
//! `insert_artifact` doesn't take `hidden`/`representation_of` (a derived
//! representation is stamped by the converter emit path, ITEM-20), so the test
//! marks the row with a direct UPDATE on the server's per-test pool — then drives
//! the real HTTP read path to prove the filter/expose split.

use serde_json::Value;

use cytoanalyst::modules::workstore::catalog::repository::CatalogRepository;
use cytoanalyst::modules::workstore::catalog::ArtifactFilter;

use super::{create_project, new_artifact, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn hidden_representation_round_trips_and_is_filtered_from_listings() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let sid = create_project(&server, &token, "hidden reprs").await;
    let pool = pool_for(&server).await;
    let repo = CatalogRepository::new(pool.clone());

    // A first-class source artifact + a derived alternate encoding of it.
    let source = repo
        .insert_artifact(&new_artifact(
            sid,
            "expression",
            "sha256:src",
            false))
        .await
        .unwrap();
    let rep = repo
        .insert_artifact(&new_artifact(
            sid,
            "expression-soma",
            "sha256:rep",
            false))
        .await
        .unwrap();

    // Fresh rows are first-class: not hidden, representing nothing.
    assert!(!source.hidden, "a freshly-inserted artifact is not hidden");
    assert_eq!(source.representation_of, None);
    assert!(!rep.hidden);
    assert_eq!(rep.representation_of, None);

    // Stamp `rep` as a hidden alternate representation OF `source` (ITEM-20 emit
    // stamps these; there is no first-class insert column for them).
    sqlx::query("UPDATE artifacts SET hidden = true, representation_of = $2 WHERE id = $1")
        .bind(rep.id)
        .bind(source.id)
        .execute(&pool)
        .await
        .expect("mark rep hidden + link to source");

    // --- round-trip through the repository (pure SQL — both columns preserved) ---
    let rep_read = repo.get_any_status(rep.id).await.unwrap().expect("rep row present");
    assert!(
        rep_read.hidden,
        "hidden round-trips through the catalog repository"
    );
    assert_eq!(
        rep_read.representation_of,
        Some(source.id),
        "representation_of round-trips through the catalog repository"
    );
    let source_read = repo
        .get_any_status(source.id)
        .await
        .unwrap()
        .expect("source row present");
    assert!(!source_read.hidden, "the source stays first-class");
    assert_eq!(source_read.representation_of, None);

    // The repo layer does NOT filter — both rows are listed (the filter is the
    // handler's job, asserted below).
    let listed = repo
        .list_by_project(sid, &ArtifactFilter::default(), None)
        .await
        .unwrap();
    assert_eq!(
        listed.len(),
        2,
        "the repository returns hidden rows too (no filtering in SQL)"
    );

    // --- the HTTP read path FILTERS hidden out of listings ---
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
    assert_eq!(
        arr.len(),
        1,
        "the hidden representation is excluded from the catalog listing"
    );
    assert_eq!(
        arr[0]["id"].as_str().unwrap(),
        source.id.to_string(),
        "only the first-class source surfaces in the listing"
    );

    // The catalog overview excludes it the same way.
    let catalog: Value = server
        .client
        .get(server.api_url(&format!("/projects/{sid}/catalog")))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let cat_arts = catalog["artifacts"]
        .as_array()
        .expect("catalog artifacts array");
    assert_eq!(
        cat_arts.len(),
        1,
        "the catalog overview excludes the hidden representation"
    );
    assert!(
        !cat_arts
            .iter()
            .any(|a| a["id"].as_str() == Some(&rep.id.to_string())),
        "the hidden rep is not in the overview"
    );

    // --- but it stays EXPOSED (fetchable by id) via GET /artifacts/{id} ---
    let get_rep = server
        .client
        .get(server.api_url(&format!("/artifacts/{}", rep.id)))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        get_rep.status().as_u16(),
        200,
        "a hidden artifact is still fetchable by id"
    );
    let rep_body: Value = get_rep.json().await.unwrap();
    assert_eq!(
        rep_body["hidden"],
        serde_json::json!(true),
        "the fetched row reports hidden"
    );
    assert_eq!(
        rep_body["representation_of"].as_str().unwrap(),
        source.id.to_string(),
        "the fetched row names its source artifact"
    );

    // --- ITEM-20 direct WRITER path: `NewArtifact.hidden = true` persists via
    //     insert_artifact (no manual UPDATE) — the converter marks its
    //     dataset-metadata byproduct hidden exactly this way. Checked last so it
    //     doesn't perturb the count assertions above. ---
    let mut hidden_new = new_artifact(sid, "byproduct", "sha256:hid", false);
    hidden_new.hidden = true;
    let hid = repo
        .insert_artifact(&hidden_new)
        .await
        .expect("insert hidden");
    assert!(
        hid.hidden,
        "hidden=true persists straight through insert_artifact"
    );
    let hid_read = repo.get_any_status(hid.id).await.unwrap().expect("hidden row present");
    assert!(
        hid_read.hidden,
        "the directly-written hidden flag round-trips"
    );
}
