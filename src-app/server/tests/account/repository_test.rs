//! A1 `AccountRepository` acceptance tests (TEST-6/9/11 + the idempotent-ensure
//! concurrency proof). Exercises the frozen resolver seams PROV-A1-3/-4/-5 against
//! a real per-test DB.

use cytoanalyst::modules::account::{AccountKind, AccountRepository, AccountRole};

use super::{create_user, pool_for, setup_admin};
use crate::common::TestServer;
use uuid::Uuid;

// TEST-6 [acceptance, PROV-A1-5] (covers ITEM-7): ensure_personal_account creates
// one personal account + one owner membership; personal_account_of returns it;
// list_user_accounts / list_members / get return the expected rows.
#[tokio::test]
async fn ensure_and_reads_return_expected_rows() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;
    // A5's create_user (ITEM-1) now auto-ensures a personal account at creation, so
    // clear it to exercise ensure-from-empty + the reads exactly as this A1 test was
    // originally written (pre-A5 behavior).
    sqlx::query("DELETE FROM accounts WHERE kind = 'personal' AND personal_user_id = $1")
        .bind(alice)
        .execute(&pool)
        .await
        .expect("clear the A5 auto-created account");
    let repo = AccountRepository::new(pool);

    // No personal account before ensure (cleared above).
    assert_eq!(
        repo.personal_account_of(alice).await.unwrap(),
        None,
        "no personal account until ensured"
    );

    let acct = repo
        .ensure_personal_account(alice, "alice")
        .await
        .expect("ensure creates the personal account");

    // personal_account_of now returns it.
    assert_eq!(repo.personal_account_of(alice).await.unwrap(), Some(acct));

    // get() returns the account with the expected shape.
    let got = repo.get(acct).await.unwrap().expect("account exists");
    assert_eq!(got.id, acct);
    assert_eq!(got.kind, AccountKind::Personal);
    assert_eq!(got.name, "alice");
    assert_eq!(got.personal_user_id, Some(alice));

    // list_user_accounts returns exactly this one account.
    let accts = repo.list_user_accounts(alice).await.unwrap();
    assert_eq!(accts.len(), 1);
    assert_eq!(accts[0].id, acct);

    // list_members returns exactly one owner membership for alice.
    let members = repo.list_members(acct).await.unwrap();
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].user_id, alice);
    assert_eq!(members[0].role, AccountRole::Owner);
}

// TEST-9 [acceptance, INV-1, PROV-A1-1/-4]: ensure is idempotent (twice → the same
// single account + one owner membership); a direct second-personal insert is
// rejected by uq_accounts_personal_user (one-personal-per-user).
#[tokio::test]
async fn ensure_is_idempotent_one_personal_per_user() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;
    let repo = AccountRepository::new(pool.clone());

    let a1 = repo.ensure_personal_account(alice, "alice").await.unwrap();
    let a2 = repo.ensure_personal_account(alice, "alice").await.unwrap();
    assert_eq!(a1, a2, "ensure twice returns the same account id");

    let personal_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(personal_count, 1, "exactly one personal account");

    let owner_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account_members WHERE account_id=$1 AND role='owner'",
    )
    .bind(a1)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owner_count, 1, "exactly one owner membership");

    // A DIRECT second personal insert is rejected by the DB (partial unique index).
    let dup = sqlx::query(
        "INSERT INTO accounts (id, kind, name, personal_user_id) VALUES ($1, 'personal', 'x', $2)",
    )
    .bind(Uuid::new_v4())
    .bind(alice)
    .execute(&pool)
    .await;
    assert!(
        dup.is_err(),
        "a second personal account for one user is rejected by uq_accounts_personal_user"
    );
}

// The idempotent-ensure CONCURRENCY proof (DEC-7 / the plan's explicit concurrency
// test): N concurrent ensure calls for the same user converge on ONE account +
// ONE owner membership — no partial-unique race, no duplicate membership.
#[tokio::test]
async fn concurrent_ensure_converges_on_one_account() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    // Fire many concurrent ensures against the same user.
    let mut handles = Vec::new();
    for _ in 0..8 {
        let repo = AccountRepository::new(pool.clone());
        handles.push(tokio::spawn(async move {
            repo.ensure_personal_account(alice, "alice").await
        }));
    }
    let mut ids = Vec::new();
    for h in handles {
        ids.push(h.await.expect("task").expect("ensure ok"));
    }

    // Every call returned the SAME account id.
    assert!(
        ids.windows(2).all(|w| w[0] == w[1]),
        "all ensures agree on one account: {ids:?}"
    );

    let personal_count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        personal_count, 1,
        "exactly one personal account despite concurrency"
    );

    let member_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM account_members WHERE account_id=$1")
            .bind(ids[0])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        member_count, 1,
        "exactly one owner membership despite concurrency"
    );
}

// TEST-11 [acceptance, INV-5, PROV-A1-3/-6]: membership_role(account, non_member)
// == None (the cross-account-404 signal); membership_role(account, member) returns
// their role; has_role grades against the ordering.
#[tokio::test]
async fn membership_role_and_has_role_grading() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let pool = pool_for(&server).await;
    let repo = AccountRepository::new(pool.clone());

    let acct = repo.ensure_personal_account(alice, "alice").await.unwrap();

    // A NON-member resolves to None — the 404 signal (never 403, never a row).
    assert_eq!(
        repo.membership_role(acct, bob).await.unwrap(),
        None,
        "a non-member is None (cross-account-404 signal)"
    );

    // The owner resolves to Owner.
    assert_eq!(
        repo.membership_role(acct, alice).await.unwrap(),
        Some(AccountRole::Owner)
    );

    // has_role grades against the ordering: owner satisfies every floor.
    assert!(repo
        .has_role(acct, alice, AccountRole::Owner)
        .await
        .unwrap());
    assert!(repo
        .has_role(acct, alice, AccountRole::Admin)
        .await
        .unwrap());
    assert!(repo
        .has_role(acct, alice, AccountRole::Member)
        .await
        .unwrap());
    // a non-member satisfies no floor.
    assert!(!repo.has_role(acct, bob, AccountRole::Member).await.unwrap());

    // Add bob as a plain 'member' and re-grade: he satisfies Member, not Admin/Owner.
    sqlx::query(
        "INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')",
    )
    .bind(acct)
    .bind(bob)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        repo.membership_role(acct, bob).await.unwrap(),
        Some(AccountRole::Member)
    );
    assert!(repo.has_role(acct, bob, AccountRole::Member).await.unwrap());
    assert!(!repo.has_role(acct, bob, AccountRole::Admin).await.unwrap());
    assert!(!repo.has_role(acct, bob, AccountRole::Owner).await.unwrap());
}

// TEST-4 (billing-read-surface) [covers: ITEM-3] — personal_accounts_of resolves a SET of users to
// their personal-account ids in ONE query (no N+1), OMITTING a user with no personal account; an
// empty input yields an empty map (no query).
#[tokio::test]
async fn personal_accounts_of_batches_and_omits_missing() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "pab_alice", "pab_alice@x.test").await;
    let bob = create_user(&server, &admin, "pab_bob", "pab_bob@x.test").await;
    let carol = create_user(&server, &admin, "pab_carol", "pab_carol@x.test").await;
    let pool = pool_for(&server).await;

    // Carol has no personal account (delete it → exercises the omission branch).
    sqlx::query("DELETE FROM accounts WHERE kind='personal' AND personal_user_id=$1")
        .bind(carol)
        .execute(&pool)
        .await
        .expect("drop carol's personal account");

    let repo = AccountRepository::new(pool.clone());
    let alice_acct = repo
        .personal_account_of(alice)
        .await
        .unwrap()
        .expect("alice account");
    let bob_acct = repo
        .personal_account_of(bob)
        .await
        .unwrap()
        .expect("bob account");

    // Empty input → empty map (short-circuit, no query).
    assert!(repo.personal_accounts_of(&[]).await.unwrap().is_empty());

    let map = repo
        .personal_accounts_of(&[alice, bob, carol])
        .await
        .unwrap();
    assert_eq!(map.get(&alice).copied(), Some(alice_acct), "alice resolved");
    assert_eq!(map.get(&bob).copied(), Some(bob_acct), "bob resolved");
    assert!(
        !map.contains_key(&carol),
        "carol (no personal account) is omitted from the map"
    );
    assert_eq!(map.len(), 2, "exactly the two resolvable users");
}