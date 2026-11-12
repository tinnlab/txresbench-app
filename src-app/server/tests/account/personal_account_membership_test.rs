//! H-2 (#144) — **no account other than an organization may have its membership
//! mutated** (INV-12).
//!
//! `AccountRepository::add_member` validated the target USER (404) and the
//! duplicate membership (409) but never the ACCOUNT's `kind`, so
//! `POST /api/admin/accounts/{id}/members` would add an arbitrary user to another
//! user's PERSONAL account. Under A3 DEC-12 that single call grants the added
//! user ≥Viewer over everything the victim has ever created — no share, no
//! consent, no affordance on the victim's side.
//!
//! Every deny below is paired with the IDENTICAL call against an ORGANIZATION
//! account, which must succeed. Without that control, "the personal account was
//! refused" would also pass if the admin route were simply broken, if the token
//! were wrong, or if the fixture's account id did not exist.

use serde_json::Value;

use txresbench::modules::account::{
    AccountRepository, AccountRole, PERSONAL_ACCOUNT_NOT_MANAGEABLE,
};

use super::{create_user, login, make_org_account, pool_for, setup_admin};
use crate::admin::{admin_add_member, admin_remove_member, admin_set_role};
use crate::common::TestServer;

/// The refusal code the guard must produce, spelled out here so the test binds to
/// the NAME and not merely to the 422 status — `LAST_OWNER` is also a 422 from the
/// same functions, and #144 requires the personal-account refusal to be explicit
/// and by name rather than incidental.
const CODE: &str = "PERSONAL_ACCOUNT_NOT_MANAGEABLE";

/// Pull the error code out of an `AppError` body, whatever envelope it uses.
fn code_of(body: &Value) -> String {
    for key in ["code", "error_code"] {
        if let Some(s) = body.get(key).and_then(Value::as_str) {
            return s.to_string();
        }
    }
    if let Some(err) = body.get("error") {
        if let Some(s) = err.as_str() {
            return s.to_string();
        }
        for key in ["code", "error_code"] {
            if let Some(s) = err.get(key).and_then(Value::as_str) {
                return s.to_string();
            }
        }
    }
    body.to_string()
}

async fn personal_account_of(pool: &sqlx::SqlitePool, user: uuid::Uuid) -> uuid::Uuid {
    sqlx::query_scalar("SELECT id FROM accounts WHERE kind = 'personal' AND personal_user_id = $1")
        .bind(user)
        .fetch_one(pool)
        .await
        .expect("every user has exactly one personal account")
}

async fn member_count(pool: &sqlx::SqlitePool, account: uuid::Uuid) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM account_members WHERE account_id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// TEST-20 [acceptance] [invariant: INV-12] — ADD is refused on a personal
/// account (422 by name, member count unchanged); POSITIVE CONTROL: the identical
/// call against an organization succeeds.
#[tokio::test]
async fn add_member_to_a_personal_account_is_refused_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let victim = create_user(&server, &admin, "victim", "victim@x.test").await;
    let attacker = create_user(&server, &admin, "attacker", "attacker@x.test").await;
    let pool = pool_for(&server).await;

    let personal = personal_account_of(&pool, victim).await;
    let before = member_count(&pool, personal).await;
    assert_eq!(before, 1, "precondition: a personal account has ONE member");

    // DENY.
    let (status, body) = admin_add_member(
        &server,
        Some(&admin),
        &personal.to_string(),
        attacker,
        "member",
    )
    .await;
    assert_eq!(
        status, 422,
        "H-2: adding a member to someone's PERSONAL account must be refused"
    );
    assert_eq!(code_of(&body), CODE, "refused BY NAME");
    assert_eq!(
        member_count(&pool, personal).await,
        before,
        "and nothing was written"
    );

    // POSITIVE CONTROL — the identical call against an ORGANIZATION.
    let org = make_org_account(&pool, "Lab", victim).await;
    let org_before = member_count(&pool, org).await;
    let (ok_status, _) =
        admin_add_member(&server, Some(&admin), &org.to_string(), attacker, "member").await;
    assert!(
        (200..300).contains(&ok_status),
        "positive control: the same admin call against an ORG account succeeds \
         (got {ok_status}) — so the deny above is the kind check, not a broken route"
    );
    assert_eq!(
        member_count(&pool, org).await,
        org_before + 1,
        "positive control: and the org membership really was written"
    );
}

/// TEST-21 [acceptance] [invariant: INV-12] — PATCH (set_role) is refused on a
/// personal account; POSITIVE CONTROL: the identical PATCH against an org member
/// succeeds.
#[tokio::test]
async fn set_role_on_a_personal_account_is_refused_422() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let victim = create_user(&server, &admin, "victim", "victim@x.test").await;
    let other = create_user(&server, &admin, "other", "other@x.test").await;
    let pool = pool_for(&server).await;

    let personal = personal_account_of(&pool, victim).await;

    let (status, body) = admin_set_role(
        &server,
        Some(&admin),
        &personal.to_string(),
        victim,
        "member",
    )
    .await;
    assert_eq!(
        status, 422,
        "H-2: nothing may re-role the sole personal owner"
    );
    assert_eq!(code_of(&body), CODE, "refused BY NAME");
    let role: String = sqlx::query_scalar(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(personal)
    .bind(victim)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(role, "owner", "and the owner's role is unchanged");

    // POSITIVE CONTROL — the same PATCH against an org member.
    let org = make_org_account(&pool, "Lab", victim).await;
    let (add_status, _) =
        admin_add_member(&server, Some(&admin), &org.to_string(), other, "member").await;
    assert!((200..300).contains(&add_status), "control fixture");
    let (ok_status, _) =
        admin_set_role(&server, Some(&admin), &org.to_string(), other, "admin").await;
    assert!(
        (200..300).contains(&ok_status),
        "positive control: set_role against an ORG member succeeds (got {ok_status})"
    );
    let new_role: String = sqlx::query_scalar(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(org)
    .bind(other)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        new_role, "admin",
        "positive control: the role really changed"
    );
}

/// TEST-22 [acceptance] [invariant: INV-12] — DELETE is refused on a personal
/// account **by name**, not incidentally through `LAST_OWNER`; POSITIVE CONTROL:
/// the identical DELETE against a non-last org member succeeds.
///
/// The distinction matters: `LAST_OWNER` catches this today only by the accident
/// of a personal account having exactly one owner. #144 requires the refusal to
/// be explicit, so this asserts the CODE, not just the status.
#[tokio::test]
async fn remove_member_from_a_personal_account_is_refused_by_name() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let victim = create_user(&server, &admin, "victim", "victim@x.test").await;
    let other = create_user(&server, &admin, "other", "other@x.test").await;
    let pool = pool_for(&server).await;

    let personal = personal_account_of(&pool, victim).await;

    // The helper returns only a status, so drive the repository call directly to read the
    // code — the same `PlatformStaff` principal the removed admin handler acted under
    // (see `tests/admin/mod.rs` for the strip note).
    let err = AccountRepository::new(pool.clone())
        .remove_member(
            personal,
            victim,
            txresbench::modules::account::ActorCeiling::PlatformStaff {
                staff_user_id: uuid::Uuid::nil(),
            },
        )
        .await
        .expect_err("H-2: the personal owner may not be removed");
    assert_eq!(
        err.status_code(),
        422,
        "H-2: the personal owner may not be removed"
    );
    assert_eq!(
        err.error_code(),
        CODE,
        "refused BY NAME — not incidentally via LAST_OWNER, which would silently \
         stop protecting this the day a personal account had two owners"
    );
    assert_eq!(
        member_count(&pool, personal).await,
        1,
        "and the membership still exists"
    );

    // POSITIVE CONTROL — the identical DELETE against a NON-last org member.
    let org = make_org_account(&pool, "Lab", victim).await;
    let (add_status, _) =
        admin_add_member(&server, Some(&admin), &org.to_string(), other, "member").await;
    assert!((200..300).contains(&add_status), "control fixture");
    let before = member_count(&pool, org).await;
    let ok_status = admin_remove_member(&server, Some(&admin), &org.to_string(), other).await;
    assert!(
        (200..300).contains(&ok_status),
        "positive control: removing a non-last ORG member succeeds (got {ok_status})"
    );
    assert_eq!(
        member_count(&pool, org).await,
        before - 1,
        "positive control: and the membership really was deleted"
    );
}

/// TEST-23 [acceptance] [invariant: INV-12] — the PROVISIONING regression guard.
///
/// #144 asks for the personal-account provisioning paths to be "proven exempt by a
/// test, not by inspection". They are exempt BY CONSTRUCTION — `ensure_personal_
/// account`, `ensure_personal_account_in_tx`, `create_organization` and the
/// `PersonalAccountHook` insert into `account_members` directly and never call
/// `add_member` — but the whole point is not to take that on trust: a freshly
/// registered user must still end up with exactly ONE personal account carrying
/// exactly ONE `owner` membership.
#[tokio::test]
async fn a_freshly_registered_user_still_gets_one_personal_account_with_one_owner() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let fresh = create_user(&server, &admin, "fresh", "fresh@x.test").await;

    let accounts: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM accounts WHERE kind = 'personal' AND personal_user_id = $1",
    )
    .bind(fresh)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        accounts, 1,
        "the hook still provisions exactly one personal account — the new refusal \
         did not catch the provisioning path"
    );

    let personal = personal_account_of(&pool, fresh).await;
    let rows: Vec<(uuid::Uuid, String)> =
        sqlx::query_as("SELECT user_id, role FROM account_members WHERE account_id = $1")
            .bind(personal)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(rows.len(), 1, "exactly one membership");
    assert_eq!(rows[0].0, fresh, "and it is the user themselves");
    assert_eq!(rows[0].1, "owner", "as owner");

    // Creating an ORGANIZATION also seeds its owner membership without routing
    // through `add_member` — the other constructor the guard must not have broken.
    let org = make_org_account(&pool, "Lab", fresh).await;
    assert_eq!(member_count(&pool, org).await, 1);
}

/// TEST-18 — PERSONA: **platform staff, account surface**. The refusal is scoped
/// to membership MUTATION; admin READS of both account kinds are untouched.
#[tokio::test]
async fn admin_account_reads_still_work_for_both_account_kinds() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let user = create_user(&server, &admin, "reads_user", "reads_user@x.test").await;
    let pool = pool_for(&server).await;
    let personal = personal_account_of(&pool, user).await;
    let org = make_org_account(&pool, "Lab", user).await;

    // SQLite port: the `/admin/accounts/*` HTTP read surface is stripped on this node
    // (see DRIFT-1.25), so the reads it served are asserted at the repository layer they
    // delegated to — the same reachable surface, with the route removed.
    let repo = AccountRepository::new(pool.clone());
    let personal_row = repo
        .get(personal)
        .await
        .expect("admin get personal account")
        .expect("the personal account exists");
    assert_eq!(
        personal_row.kind,
        txresbench::modules::account::AccountKind::Personal,
        "platform staff must still READ a personal account"
    );
    let org_row = repo
        .get(org)
        .await
        .expect("admin get org account")
        .expect("the org account exists");
    assert_eq!(
        org_row.kind,
        txresbench::modules::account::AccountKind::Organization,
        "platform staff must still READ an organization account"
    );

    let listed = repo
        .list_all_accounts(100, 0, None)
        .await
        .expect("admin list all accounts");
    assert!(
        listed.iter().any(|a| a.account.id == personal)
            && listed.iter().any(|a| a.account.id == org),
        "and still list both account kinds: {:?}",
        listed
            .iter()
            .map(|a| (a.account.id, a.account.kind))
            .collect::<Vec<_>>()
    );

    // The account owner can still log in and use their own account — the refusal
    // touches no read path.
    let _token = login(&server, "reads_user").await;
}

/// TEST-24 [acceptance] [invariant: INV-12] — the refusal lives in the REPOSITORY,
/// and has the shape the API contract promises.
///
/// The HTTP tests above prove the admin ROUTES refuse. #144 asks for the guard to
/// live in `AccountRepository` "so it lands for the admin surface and the new
/// self-service surface at once and cannot be forgotten by a future third caller"
/// — which is a claim about the repository, not the routes. So this drives all
/// three methods DIRECTLY, bypassing every handler, and pins both the 422 status
/// mapping and the code by name.
///
/// (An earlier version of this test constructed the `AppError` itself and asserted
/// it was a 422 — which was a tautology: it would have passed with the guard
/// deleted from all three call sites. It is recorded in LEDGER.jsonl.)
#[tokio::test]
async fn the_refusal_lives_in_the_repository_not_the_handlers() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let victim = create_user(&server, &admin, "victim", "victim@x.test").await;
    let other = create_user(&server, &admin, "other", "other@x.test").await;
    let pool = pool_for(&server).await;
    let repo = AccountRepository::new(pool.clone());

    let personal = personal_account_of(&pool, victim).await;

    // All three mutators, called directly on the repository.
    for (label, err) in [
        (
            "add_member",
            // #145: `add_member` now takes the same REQUIRED `ActorCeiling` its two
            // siblings already took, and #148 widened its staff variant to carry the acting
            // employee's id. `staff_ceiling()` is that variant — this arm still tests what it
            // always tested, that `refuse_if_personal` refuses regardless of authority.
            repo.add_member(personal, other, AccountRole::Member, super::staff_ceiling())
                .await
                .expect_err("add_member on a personal account must be refused"),
        ),
        (
            "set_role",
            repo.set_role(personal, victim, AccountRole::Member, super::staff_ceiling())
                .await
                .expect_err("set_role on a personal account must be refused"),
        ),
        (
            "remove_member",
            repo.remove_member(personal, victim, super::staff_ceiling())
                .await
                .expect_err("remove_member on a personal account must be refused"),
        ),
    ] {
        let rendered = format!("{err:?}");
        assert!(
            rendered.contains(PERSONAL_ACCOUNT_NOT_MANAGEABLE),
            "{label}: refused BY NAME, not incidentally (got {rendered})"
        );
        assert_eq!(
            err.to_api_error().0.as_u16(),
            422,
            "{label}: and mapped to 422, like the sibling LAST_OWNER guard"
        );
    }
    assert_eq!(
        member_count(&pool, personal).await,
        1,
        "and none of the three wrote anything"
    );

    // POSITIVE CONTROL — the identical three calls against an ORGANIZATION account
    // all SUCCEED through the same repository methods. Without this, the three
    // refusals above would also hold if the methods were simply broken.
    let org = make_org_account(&pool, "Lab", victim).await;
    repo.add_member(org, other, AccountRole::Member, super::staff_ceiling())
        .await
        .expect("positive control: add_member succeeds on an organization");
    let updated = repo
        .set_role(org, other, AccountRole::Admin, super::staff_ceiling())
        .await
        .expect("positive control: set_role succeeds on an organization");
    assert_eq!(
        updated.role,
        AccountRole::Admin,
        "and really changed the role"
    );
    repo.remove_member(org, other, super::staff_ceiling())
        .await
        .expect("positive control: remove_member succeeds on an organization");
    assert_eq!(
        member_count(&pool, org).await,
        1,
        "and really removed the membership"
    );
}
