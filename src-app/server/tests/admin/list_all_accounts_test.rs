//! TEST-1 [acceptance, INV-1] — `GET /api/admin/accounts` (#33) lists ALL accounts.
//!
//! An admin (and an `admin::accounts` grant-holder) sees accounts they are NOT a
//! member of — a foreign org AND other users' personal accounts — paged, with each
//! row's member count + owner and a correct `total` and `?kind=` filter. A plain
//! non-admin → 403; unauthenticated → 401. This is the membership-free cross-account
//! read; any row for an account the caller does not belong to is the #33 proof.

use super::{admin_list_accounts, create_admin_accounts_holder};
use crate::account::{create_user, login, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn admin_lists_all_accounts_including_non_member_ones() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // alice owns an ORG the admin is NOT a member of; bob just has a personal account.
    let alice_id = create_user(&server, &admin, "la_alice", "la_alice@x.test").await;
    let _bob_id = create_user(&server, &admin, "la_bob", "la_bob@x.test").await;
    let org = make_org_account(&pool, "Acme Lab", alice_id).await;
    let org_s = org.to_string();

    // --- INV-1: the admin lists the foreign org + everyone's personal accounts.
    let (status, body) = admin_list_accounts(&server, Some(&admin), "").await;
    assert_eq!(status, 200, "admin lists accounts: {body}");
    let accounts = body["accounts"].as_array().expect("accounts array");

    let org_row = accounts
        .iter()
        .find(|a| a["account"]["id"] == org_s)
        .expect("the foreign org appears in the admin all-accounts list");
    assert_eq!(org_row["account"]["kind"], "organization");
    assert_eq!(
        org_row["member_count"].as_i64().unwrap(),
        1,
        "the org has one member (its owner)"
    );
    assert_eq!(
        org_row["owner_user_id"].as_str().unwrap(),
        alice_id.to_string(),
        "the owner is alice"
    );
    // TEST-2 [acceptance][invariant: INV-4] (#51): the admin list carries a human
    // `owner_label` (COALESCE(display_name, username)) — alice seeded no display_name,
    // so it falls back to her username. Never a bare UUID.
    assert_eq!(
        org_row["owner_label"], "la_alice",
        "owner_label is alice's human name (username fallback), not a UUID"
    );
    // None-iff-None: owner_label is present exactly when owner_user_id is, on EVERY row.
    for a in accounts {
        assert_eq!(
            a["owner_user_id"].is_null(),
            a["owner_label"].is_null(),
            "owner_label is null iff owner_user_id is null: {a}"
        );
        if !a["owner_label"].is_null() {
            let label = a["owner_label"].as_str().unwrap();
            assert!(
                !label.is_empty()
                    && uuid::Uuid::parse_str(label).is_err(),
                "owner_label is a human name, not a UUID: {label:?}"
            );
        }
    }

    // admin + alice + bob personal accounts (≥3) are ALL visible — not membership-filtered.
    let personal = accounts
        .iter()
        .filter(|a| a["account"]["kind"] == "personal")
        .count();
    assert!(
        personal >= 3,
        "an admin sees other users' personal accounts too (cross-account): {personal}"
    );
    let total = body["total"].as_i64().unwrap();
    assert!(
        total >= 4,
        "total counts every account (3 personal + org): {total}"
    );

    // --- ?kind= filter: organization → only the org.
    let (status, orgs) = admin_list_accounts(&server, Some(&admin), "?kind=organization").await;
    assert_eq!(status, 200);
    let orgs_arr = orgs["accounts"].as_array().unwrap();
    assert!(
        orgs_arr
            .iter()
            .all(|a| a["account"]["kind"] == "organization"),
        "the kind filter returns only orgs"
    );
    assert!(orgs_arr.iter().any(|a| a["account"]["id"] == org_s));
    assert_eq!(orgs["total"].as_i64().unwrap(), 1, "exactly one org");

    // --- an admin::accounts grant-holder (non-admin) also lists (the same gate).
    let holder =
        create_admin_accounts_holder(&server, &admin, "la_holder", "la_holder@x.test").await;
    let (status, _) = admin_list_accounts(&server, Some(&holder), "").await;
    assert_eq!(
        status, 200,
        "an admin::accounts holder can list all accounts"
    );

    // --- a plain non-admin → 403; unauthenticated → 401.
    create_user(&server, &admin, "la_carol", "la_carol@x.test").await;
    let carol = login(&server, "la_carol").await;
    let (status, _) = admin_list_accounts(&server, Some(&carol), "").await;
    assert_eq!(
        status, 403,
        "a non-admin is denied the admin all-accounts list"
    );
    let (status, _) = admin_list_accounts(&server, None, "").await;
    assert_eq!(status, 401, "unauthenticated is 401");
}
