//! A2 create/duplicate/transfer stamping acceptance tests (TEST-4) — ITEM-5/6:
//! every write path stamps `account_id` behaviour-preservingly (the creating/new
//! owner's personal account).

use cytoanalyst::modules::account::scope::{
    account_of_dataset, account_of_project, ensure_personal_account_for,
};
use cytoanalyst::modules::dataset::repository::DatasetRepository;
use cytoanalyst::modules::project::ProjectRepository;

use super::{create_user, pool_for, setup_admin};
use crate::common::TestServer;

// TEST-4a [covers: ITEM-5]: create stamps `account_id = personal_account_of(creator)`
// for both projects and datasets.
#[tokio::test]
async fn create_stamps_creators_personal_account() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());

    let project = projects.create(alice, "P", "").await.expect("project");
    let dataset = datasets
        .create(alice, "D", None, &serde_json::json!({}))
        .await
        .expect("dataset");

    let alice_personal = ensure_personal_account_for(&pool, alice).await.unwrap();
    assert_eq!(
        account_of_project(&pool, project.id).await.unwrap(),
        Some(alice_personal),
        "project stamped with creator's personal account"
    );
    assert_eq!(
        account_of_dataset(&pool, dataset.id).await.unwrap(),
        Some(alice_personal),
        "dataset stamped with creator's personal account"
    );
    // The stamped value is ON the returned row (DEC-9 — account_id is on the wire).
    assert_eq!(project.account_id, alice_personal);
    assert_eq!(dataset.account_id, alice_personal);
}

// TEST-4b [covers: ITEM-5]: `duplicate_in_tx` inherits the source's account.
#[tokio::test]
async fn duplicate_inherits_source_account() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());
    let source = projects.create(alice, "Src", "").await.expect("source");

    let mut tx = pool.begin().await.expect("begin");
    let dup = projects
        .duplicate_in_tx(&mut tx, &source)
        .await
        .expect("duplicate");
    tx.commit().await.expect("commit");

    assert_eq!(
        dup.account_id, source.account_id,
        "the duplicate inherits the source project's account"
    );
}

// TEST-4c [covers: ITEM-6]: `accept_transfer` and `admin_change_owner` re-stamp
// `account_id` to the NEW owner's personal account.
#[tokio::test]
async fn transfer_and_admin_change_owner_restamp_account() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());

    // --- accept_transfer ---
    let p1 = projects.create(alice, "P1", "").await.expect("p1");
    let alice_personal = ensure_personal_account_for(&pool, alice).await.unwrap();
    assert_eq!(p1.account_id, alice_personal, "starts in alice's account");

    let transfer = projects
        .create_transfer(p1.id, alice, bob)
        .await
        .expect("create transfer");
    let accepted = projects
        .accept_transfer(transfer.id, bob)
        .await
        .expect("accept");
    assert!(accepted, "transfer accepted");

    let bob_personal = ensure_personal_account_for(&pool, bob).await.unwrap();
    assert_eq!(
        account_of_project(&pool, p1.id).await.unwrap(),
        Some(bob_personal),
        "accept_transfer re-stamps to the new owner's personal account"
    );
    assert_ne!(bob_personal, alice_personal, "the account actually moved");

    // --- admin_change_owner ---
    let p2 = projects.create(alice, "P2", "").await.expect("p2");
    let old = projects
        .admin_change_owner(p2.id, bob, false)
        .await
        .expect("admin change owner");
    assert_eq!(old, Some(alice), "old owner reported");
    assert_eq!(
        account_of_project(&pool, p2.id).await.unwrap(),
        Some(bob_personal),
        "admin_change_owner re-stamps to the new owner's personal account"
    );
}
