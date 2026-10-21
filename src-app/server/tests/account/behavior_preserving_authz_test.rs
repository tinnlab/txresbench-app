//! A3 TEST-9 [acceptance, INV-4] — THE behaviour-preserving proof. With only
//! single-member (personal) accounts, the FLIPPED predicates
//! (`list_visible`/`effective_permission`/dataset `access`/workstore `require_*_read`)
//! return the byte-identical row sets / decisions they returned when scoped by
//! `owner_id` — because for a personal account "member of the project's account" ≡
//! "`owner_id == user_id`". A3 is observably a no-op wherever no org exists; the
//! existing cross-user-404 behaviour is unchanged.

use cytoanalyst::modules::dataset::repository::{DatasetAccess, DatasetRepository};
use cytoanalyst::modules::project::scope::ProjectScope;
use cytoanalyst::modules::project::{EffectivePermission, ProjectRepository};
use cytoanalyst::modules::workstore::authz::{require_dataset_read, require_project_read};

use super::{create_user, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn flip_is_a_noop_for_single_account_users() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let pool = pool_for(&server).await;
    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());

    // Only personal accounts exist (auto-created); no org anywhere.
    let pa = projects.create(alice, "A", "").await.unwrap();
    let pb = projects.create(bob, "B", "").await.unwrap();
    let da = datasets
        .create(alice, "DA", None, &serde_json::json!({}))
        .await
        .unwrap();
    let db = datasets
        .create(bob, "DB", None, &serde_json::json!({}))
        .await
        .unwrap();

    // effective_permission: owner→Owner, foreign→None (unchanged owner-scoping).
    assert_eq!(
        projects.effective_permission(pa.id, alice).await.unwrap(),
        Some(EffectivePermission::Owner)
    );
    assert_eq!(
        projects.effective_permission(pa.id, bob).await.unwrap(),
        None,
        "a foreign project is invisible — same 404 as before the flip"
    );

    // resolve_in_account matches the pre-flip resolve exactly: owner Some, foreign None.
    assert!(ProjectScope::resolve_in_account(&projects, pa.id, alice)
        .await
        .unwrap()
        .is_some());
    assert!(ProjectScope::resolve_in_account(&projects, pa.id, bob)
        .await
        .unwrap()
        .is_none());

    // list_visible: each user sees EXACTLY their own project, nobody else's.
    let (alice_list, alice_total) = projects.list_visible(alice, None, 1, 50).await.unwrap();
    assert_eq!(alice_total, 1);
    assert_eq!(alice_list.len(), 1);
    assert_eq!(alice_list[0].id, pa.id);
    assert_eq!(alice_list[0].effective_permission, "owner");
    let (bob_list, bob_total) = projects.list_visible(bob, None, 1, 50).await.unwrap();
    assert_eq!(bob_total, 1);
    assert_eq!(bob_list[0].id, pb.id);
    assert!(
        !alice_list.iter().any(|p| p.id == pb.id),
        "alice never sees bob's project (no widening for personal accounts)"
    );

    // dataset access: owner CanEdit, foreign NotVisible (unchanged).
    assert_eq!(
        datasets.access(da.id, alice, &[]).await.unwrap(),
        DatasetAccess::CanEdit
    );
    assert_eq!(
        datasets.access(da.id, bob, &[]).await.unwrap(),
        DatasetAccess::NotVisible
    );
    assert!(datasets.is_visible_to(da.id, alice, &[]).await.unwrap());
    assert!(!datasets.is_visible_to(da.id, bob, &[]).await.unwrap());
    let _ = db;

    // workstore gates: owner OK, foreign 404 (unchanged owner-scoping).
    assert!(require_project_read(&pool, pa.id, alice).await.is_ok());
    assert_eq!(
        require_project_read(&pool, pa.id, bob)
            .await
            .unwrap_err()
            .0
            .as_u16(),
        404
    );
    assert!(require_dataset_read(&pool, da.id, alice).await.is_ok());
    assert_eq!(
        require_dataset_read(&pool, da.id, bob)
            .await
            .unwrap_err()
            .0
            .as_u16(),
        404
    );
}
