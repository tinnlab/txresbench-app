//! TEST-3 [acceptance, INV-3] + TEST-4 [acceptance, INV-4] — admin member CRUD (#35).
//!
//! TEST-3: add / change-role / remove work; the SOLE remaining owner cannot be
//! removed NOR demoted (422), but once a SECOND owner exists the first can be — the
//! guard is "an account keeps ≥1 owner", not "this owner is sticky".
//! TEST-4: add-member validates the target user EXISTS (404) and is NOT already a
//! member (409).

use super::{admin_add_member, admin_remove_member, admin_set_role};
use crate::account::{create_user, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

#[tokio::test]
async fn member_add_patch_remove_and_last_owner_guard() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner_id = create_user(&server, &admin, "mc_owner", "mc_owner@x.test").await;
    let u_id = create_user(&server, &admin, "mc_u", "mc_u@x.test").await;
    let org = make_org_account(&pool, "Members Org", owner_id).await;
    let org_s = org.to_string();

    // --- add u as a member → 201.
    let (status, body) = admin_add_member(&server, Some(&admin), &org_s, u_id, "member").await;
    assert_eq!(status, 201, "add member: {body}");
    assert_eq!(body["role"], "member");
    assert_eq!(body["user_id"].as_str().unwrap(), u_id.to_string());
    // TEST-1 [acceptance][invariant: INV-2] (#51): the add response carries the
    // member's HUMAN identity from the source — username/email (NOT NULL) reflect the
    // seeded user; display_name is null (create_user seeds none). No bare UUID stands
    // in for a name.
    assert_eq!(body["username"], "mc_u", "add response carries username");
    assert_eq!(body["email"], "mc_u@x.test", "add response carries email");
    assert!(body["display_name"].is_null(), "no display_name seeded → null");

    // --- change u's role → admin (PATCH) → 200.
    let (status, body) = admin_set_role(&server, Some(&admin), &org_s, u_id, "admin").await;
    assert_eq!(status, 200, "set role: {body}");
    assert_eq!(body["role"], "admin");
    // TEST-1: the set-role (CTE UPDATE ... JOIN users) response ALSO carries identity.
    assert_eq!(body["username"], "mc_u", "set-role response carries username");
    assert_eq!(body["email"], "mc_u@x.test", "set-role response carries email");

    // --- remove u (DELETE) → 204.
    let status = admin_remove_member(&server, Some(&admin), &org_s, u_id).await;
    assert_eq!(status, 204, "remove member is 204");

    // --- last-owner guard: the sole owner cannot be removed…
    let status = admin_remove_member(&server, Some(&admin), &org_s, owner_id).await;
    assert_eq!(status, 422, "cannot remove the last owner");
    // …nor demoted.
    let (status, _) = admin_set_role(&server, Some(&admin), &org_s, owner_id, "member").await;
    assert_eq!(status, 422, "cannot demote the last owner");

    // the owner is still an owner (the guard did not partially mutate).
    let role: String = sqlx::query_scalar(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(org)
    .bind(owner_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        role, "owner",
        "the sole owner is untouched by the refused ops"
    );

    // --- add a SECOND owner → now the first CAN be demoted (≥1 owner remains).
    let owner2 = create_user(&server, &admin, "mc_owner2", "mc_owner2@x.test").await;
    let (status, _) = admin_add_member(&server, Some(&admin), &org_s, owner2, "owner").await;
    assert_eq!(status, 201, "add a second owner");
    let (status, body) = admin_set_role(&server, Some(&admin), &org_s, owner_id, "member").await;
    assert_eq!(
        status, 200,
        "with a second owner, the first can be demoted: {body}"
    );

    // owner2 is now the last owner — the guard tracks the CURRENT set, so it cannot go.
    let status = admin_remove_member(&server, Some(&admin), &org_s, owner2).await;
    assert_eq!(
        status, 422,
        "owner2 is now the last owner and cannot be removed"
    );
}

#[tokio::test]
async fn add_member_validates_user_existence_and_duplicates() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner_id = create_user(&server, &admin, "av_owner", "av_owner@x.test").await;
    let org = make_org_account(&pool, "Validate Org", owner_id).await;
    let org_s = org.to_string();

    // --- a nonexistent user → 404 (INV-4: user must exist).
    let (status, _) = admin_add_member(
        &server,
        Some(&admin),
        &org_s,
        uuid::Uuid::new_v4(),
        "member",
    )
    .await;
    assert_eq!(status, 404, "adding a phantom user is 404");

    // --- a valid new user → 201.
    let u = create_user(&server, &admin, "av_u", "av_u@x.test").await;
    let (status, _) = admin_add_member(&server, Some(&admin), &org_s, u, "member").await;
    assert_eq!(status, 201, "add a real user");

    // --- adding the same user again → 409 (INV-4: not already a member).
    let (status, _) = admin_add_member(&server, Some(&admin), &org_s, u, "member").await;
    assert_eq!(status, 409, "a duplicate membership is 409");
    // the owner (already a member) is likewise a 409, regardless of the role asked.
    let (status, _) = admin_add_member(&server, Some(&admin), &org_s, owner_id, "admin").await;
    assert_eq!(status, 409, "re-adding the owner is 409");
}
