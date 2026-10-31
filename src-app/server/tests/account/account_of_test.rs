//! A2 `account_of_*` resolver acceptance tests (TEST-3, TEST-8) — the frozen
//! seams PROV-A2-1/-2/-4 against a real per-test DB.

use cytoanalyst::modules::account::scope::{
    account_of_artifact, account_of_dataset, account_of_project, ensure_personal_account_for,
};
use cytoanalyst::modules::dataset::repository::DatasetRepository;
use cytoanalyst::modules::project::ProjectRepository;
use uuid::Uuid;

use super::{create_user, pool_for, setup_admin};
use crate::common::TestServer;

// TEST-3 [covers: ITEM-3] (PROV-A2-1/-2/-4): the resolvers return `Some(account_id)`
// for an existing row and `None` for an absent id; `account_of_artifact` resolves
// transitively via its parent project/dataset.
#[tokio::test]
async fn account_of_resolvers_return_some_for_existing_none_for_absent() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());

    let project = projects
        .create(alice, "P", "")
        .await
        .expect("create project");
    let dataset = datasets
        .create(alice, "D", None, &serde_json::json!({}))
        .await
        .expect("create dataset");

    // Existing rows resolve to Some(account_id).
    let alice_account = ensure_personal_account_for(&pool, alice)
        .await
        .expect("alice personal account");
    assert_eq!(
        account_of_project(&pool, project.id).await.unwrap(),
        Some(alice_account),
        "account_of_project returns the project's account"
    );
    assert_eq!(
        account_of_dataset(&pool, dataset.id).await.unwrap(),
        Some(alice_account),
        "account_of_dataset returns the dataset's account"
    );

    // Absent ids resolve to None (the 404 signal A3 maps).
    assert_eq!(
        account_of_project(&pool, Uuid::new_v4()).await.unwrap(),
        None,
        "absent project → None"
    );
    assert_eq!(
        account_of_dataset(&pool, Uuid::new_v4()).await.unwrap(),
        None,
        "absent dataset → None"
    );
    assert_eq!(
        account_of_artifact(&pool, Uuid::new_v4()).await.unwrap(),
        None,
        "absent artifact → None"
    );

    // account_of_artifact resolves transitively via a project_id back-pointer.
    let artifact_id: Uuid = sqlx::query_scalar(
        "INSERT INTO artifacts \
           (project_id, output_id, datatype, object_key, is_multifile, content_hash, \
            structure, meta, role, status, stored_bytes, hidden) \
         VALUES ($1, 'out-1', 'data/opaque', 'k/1', false, $2, \
                 '{}', '{}', 'artifact', 'ready', 1, false) \
         RETURNING id",
    )
    .bind(project.id)
    .bind(format!("sha256:{}", "a".repeat(64)))
    .fetch_one(&pool)
    .await
    .expect("insert project-scoped artifact");

    assert_eq!(
        account_of_artifact(&pool, artifact_id).await.unwrap(),
        Some(alice_account),
        "account_of_artifact == account_of its parent project (transitive)"
    );
}

// TEST-8 [acceptance, INV-4] [covers: ITEM-3] (PROV-A2-1): `account_of_project`
// returns the ACCOUNT_ID, never the `owner_id` — the account_id-not-user_id tenant
// key the billing/metering epic binds.
#[tokio::test]
async fn account_of_project_returns_account_id_not_owner_id() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());
    let project = projects.create(bob, "P", "").await.expect("create project");

    let account = account_of_project(&pool, project.id)
        .await
        .unwrap()
        .expect("project has an account");
    let bob_personal = ensure_personal_account_for(&pool, bob)
        .await
        .expect("bob personal account");

    assert_eq!(account, bob_personal, "resolves to the account_id");
    assert_ne!(
        account, bob,
        "the resolver returns the ACCOUNT id, never the owner user id"
    );
}
