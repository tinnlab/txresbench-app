//! A2 THE behaviour-preserving proof (TEST-5, acceptance, INV-2) — the core
//! invariant of A2's "step 0": adding + backfilling `account_id` changes NOTHING
//! about the owner-scoped reads/authz. `owner_id` remains the authz key (ITEM-7);
//! A3 flips it later.
//!
//! In the always-migrated integration harness the literal pre-migration snapshot
//! is not reproducible (the schema is fully migrated at DB creation). The
//! equivalent, stronger proof asserted here: the owner-scoped reads
//! (`list_visible`, `effective_permission`, dataset `is_visible_to`) are
//! determined SOLELY by `owner_id`/shares — they return the exact same partition
//! regardless of the `account_id` column, whose value is a pure function of the
//! owner (`account_of(x) == personal_account_of(owner)`).

use std::collections::HashSet;

use txresbench::modules::account::scope::{
    account_of_dataset, account_of_project, ensure_personal_account_for,
};
use txresbench::modules::dataset::repository::DatasetRepository;
use txresbench::modules::project::ProjectRepository;

use super::{create_user, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn reads_are_owner_determined_and_account_of_equals_personal() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let pool = pool_for(&server).await;

    let projects = ProjectRepository::new(pool.clone());
    let datasets = DatasetRepository::new(pool.clone());

    let a1 = projects.create(alice, "A1", "").await.expect("a1");
    let a2 = projects.create(alice, "A2", "").await.expect("a2");
    let b1 = projects.create(bob, "B1", "").await.expect("b1");
    let da = datasets
        .create(alice, "DA", None, &serde_json::json!({}))
        .await
        .expect("da");
    let db = datasets
        .create(bob, "DB", None, &serde_json::json!({}))
        .await
        .expect("db");

    let alice_personal = ensure_personal_account_for(&pool, alice).await.unwrap();
    let bob_personal = ensure_personal_account_for(&pool, bob).await.unwrap();
    assert_ne!(alice_personal, bob_personal, "distinct accounts per owner");

    // (a) every resource resolves to its OWNER's personal account.
    for (pid, expect) in [
        (a1.id, alice_personal),
        (a2.id, alice_personal),
        (b1.id, bob_personal),
    ] {
        assert_eq!(
            account_of_project(&pool, pid).await.unwrap(),
            Some(expect),
            "account_of(project) == personal_account_of(owner)"
        );
    }
    assert_eq!(
        account_of_dataset(&pool, da.id).await.unwrap(),
        Some(alice_personal)
    );
    assert_eq!(
        account_of_dataset(&pool, db.id).await.unwrap(),
        Some(bob_personal)
    );

    // (b) the owner-scoped project reads are partitioned by OWNER, not account —
    // list_visible(alice) is EXACTLY alice's projects (b1 excluded despite living
    // in a different account); effective_permission is Owner on own.
    let (alice_visible, total) = projects.list_visible(alice, None, 1, 100).await.unwrap();
    let alice_ids: HashSet<_> = alice_visible.iter().map(|p| p.id).collect();
    assert_eq!(total, 2, "alice sees exactly her two projects");
    assert_eq!(
        alice_ids,
        HashSet::from([a1.id, a2.id]),
        "list_visible is owner-determined (unchanged by account_id)"
    );
    assert!(
        !alice_ids.contains(&b1.id),
        "bob's project (different owner, different account) is not visible to alice"
    );
    assert!(matches!(
        projects.effective_permission(a1.id, alice).await.unwrap(),
        Some(txresbench::modules::project::EffectivePermission::Owner)
    ));

    // (c) cross-user reads still 404 (invisible): effective_permission None, and a
    // foreign dataset is not visible.
    assert!(
        projects
            .effective_permission(b1.id, alice)
            .await
            .unwrap()
            .is_none(),
        "a foreign project is invisible (the 404 signal) — unchanged by A2"
    );
    assert!(
        datasets.is_visible_to(da.id, alice, &[]).await.unwrap(),
        "own dataset visible"
    );
    assert!(
        !datasets.is_visible_to(db.id, alice, &[]).await.unwrap(),
        "foreign dataset invisible — unchanged by A2"
    );
}
