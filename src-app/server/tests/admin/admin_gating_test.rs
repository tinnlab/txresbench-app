//! TEST-5 [acceptance, INV-5] — every new account-management route is admin-gated.
//!
//! For EACH new route (`GET /api/admin/accounts`, `POST /api/accounts`,
//! `POST`/`DELETE`/`PATCH /api/admin/accounts/{id}/members[/{user}]`), an
//! unauthenticated request → 401 and an authenticated non-admin (a plain Users-group
//! user holding `account::read` but NOT `admin::accounts`/`account::manage`) → 403.
//! None leaks data or mutates.

use serde_json::json;

use super::{admin_add_member, admin_list_accounts, admin_remove_member, admin_set_role};
use crate::account::{create_user, login, make_org_account, pool_for, post_accounts, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn every_admin_account_route_rejects_unauth_and_non_admin() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner_id = create_user(&server, &admin, "g_owner", "g_owner@x.test").await;
    let org = make_org_account(&pool, "Gate Org", owner_id).await;
    let org_s = org.to_string();

    // A plain non-admin: Users group (account::read) but NOT admin::accounts /
    // account::manage.
    create_user(&server, &admin, "g_carol", "g_carol@x.test").await;
    let carol = login(&server, "g_carol").await;
    let target = create_user(&server, &admin, "g_target", "g_target@x.test").await;

    // GET /api/admin/accounts (#33)
    assert_eq!(
        admin_list_accounts(&server, None, "").await.0,
        401,
        "list unauth"
    );
    assert_eq!(
        admin_list_accounts(&server, Some(&carol), "").await.0,
        403,
        "list non-admin"
    );

    // POST /api/accounts (#34, create org)
    assert_eq!(
        post_accounts(&server, None, json!({ "name": "x" })).await.0,
        401,
        "create-org unauth"
    );
    assert_eq!(
        post_accounts(&server, Some(&carol), json!({ "name": "x" }))
            .await
            .0,
        403,
        "create-org non-manager"
    );

    // POST members (#35, add)
    assert_eq!(
        admin_add_member(&server, None, &org_s, target, "member")
            .await
            .0,
        401,
        "add-member unauth"
    );
    assert_eq!(
        admin_add_member(&server, Some(&carol), &org_s, target, "member")
            .await
            .0,
        403,
        "add-member non-admin"
    );

    // DELETE members (#35, remove)
    assert_eq!(
        admin_remove_member(&server, None, &org_s, owner_id).await,
        401,
        "remove-member unauth"
    );
    assert_eq!(
        admin_remove_member(&server, Some(&carol), &org_s, owner_id).await,
        403,
        "remove-member non-admin"
    );

    // PATCH members (#35, set-role)
    assert_eq!(
        admin_set_role(&server, None, &org_s, owner_id, "member")
            .await
            .0,
        401,
        "set-role unauth"
    );
    assert_eq!(
        admin_set_role(&server, Some(&carol), &org_s, owner_id, "member")
            .await
            .0,
        403,
        "set-role non-admin"
    );

    // And the gate actually protected state: carol changed nothing (the owner remains).
    let owner_role: String = sqlx::query_scalar(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(org)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owner_role, "owner", "no denied request mutated membership");
}
