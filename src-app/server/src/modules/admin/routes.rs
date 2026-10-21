//! Admin HTTP routes — the cross-account admin surface (Tier-0 #31 proof + Tier-1
//! #33/#34/#35). aide-documented so they appear in the OpenAPI spec; `.id("Admin.*")`
//! drives `ApiClient.Admin.*` + the `Permissions`/`ApiEndpoints` codegen. Re-run
//! `just openapi-regen` after any change here.
//!
//! Gating:
//! - `GET /api/admin/accounts` (#33, list ALL accounts) + `GET
//!   /api/admin/accounts/{account_id}` (#31, read one) are gated `admin::accounts`
//!   (`RequirePermissions<(AdminAccounts,)>` / the `AdminAccountScope` extractor —
//!   same authority: is_admin OR the grant; 401 unauth / 403 authed-without-grant).
//! - The member-CRUD routes (#35) resolve the account membership-free via
//!   `AdminAccountScope` (so they inherit the `admin::accounts` gate + the resolved
//!   account) AND bind `account::manage` via `RequirePermissions<(AccountManage,)>`
//!   — the "manage members" grant. Both are admin-held via `*`, so a real admin
//!   passes both; a non-admin fails the first (DEC-3).

use aide::axum::routing::{delete_with, get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use sqlx::PgPool;
use uuid::Uuid;

use ziee_core::{ApiResult, AppError};

use crate::modules::account::sync::{publish_account, publish_account_member};
use crate::modules::account::{
    Account, AccountAdminStatus, AccountMember, AccountMemberEventsResponse, AccountRepository,
    ActorCeiling, AddMemberRequest, AdminAccountStatusResponse, AdminAccountSummary,
    AdminAccountsListResponse, AdminAccountsQuery, SetRoleRequest,
    SuspendAccountRequest,
};
use crate::modules::permissions::{with_permission, RequirePermissions};
use crate::modules::sync::{publish, Actor, Audience, SyncAction, SyncEntity};

use super::extractor::AdminAccountScope;
use super::permissions::AdminAccounts;
use crate::modules::account::AccountManage;

pub fn admin_routes() -> ApiRouter {
    ApiRouter::new()
        // #33 — list ALL accounts (paged, optional ?kind= filter).
        .api_route(
            "/admin/accounts",
            get_with(list_all_accounts, list_all_accounts_docs),
        )
        // #31 — read ANY account by id (the Tier-0 proof).
        .api_route(
            "/admin/accounts/{account_id}",
            get_with(get_admin_account, get_admin_account_docs),
        )
        // #35 — add a member.
        .api_route(
            "/admin/accounts/{account_id}/members",
            post_with(add_account_member, add_member_docs),
        )
        // #35 — remove a member / change a member's role.
        .api_route(
            "/admin/accounts/{account_id}/members/{user_id}",
            delete_with(remove_account_member, remove_member_docs)
                .patch_with(set_member_role, set_role_docs),
        )
        // #148 — the staff view of the membership audit ledger. Full projection (the staff
        // actor id and the `reason` the account-scoped twin redacts), which is what makes
        // that redaction a falsifiable decision rather than an unobservable claim.
        .api_route(
            "/admin/accounts/{account_id}/members/events",
            get_with(list_admin_member_events, list_admin_member_events_docs),
        )
        // #37 — admin suspend / reactivate / status (the admin-set suspension flag).
        .api_route(
            "/admin/accounts/{account_id}/suspend",
            post_with(suspend_account, suspend_account_docs),
        )
        .api_route(
            "/admin/accounts/{account_id}/reactivate",
            post_with(reactivate_account, reactivate_account_docs),
        )
        .api_route(
            "/admin/accounts/{account_id}/status",
            get_with(get_account_status, get_account_status_docs),
        )
}

// ============================== #37 — suspend / reactivate / status ===========

/// Map the repository status row to the wire DTO (shared by suspend/reactivate/status).
fn status_response(s: AccountAdminStatus) -> AdminAccountStatusResponse {
    AdminAccountStatusResponse {
        account_id: s.account_id,
        admin_suspended: s.admin_suspended,
        admin_suspended_at: s.admin_suspended_at,
        admin_suspended_by: s.admin_suspended_by,
        admin_suspend_reason: s.admin_suspend_reason,
    }
}

/// Read + map the account's admin-suspension status (used by all three handlers after a
/// mutation, so the response reflects the fresh persisted state). The `AdminAccountScope`
/// extractor already proved the account exists; `None` is defensive (a delete racing the read)
/// and maps to 404, never a 500.
async fn read_status(
    pool: &PgPool,
    account_id: Uuid,
) -> Result<AdminAccountStatusResponse, AppError> {
    let s = AccountRepository::new(pool.clone())
        .account_admin_status(account_id)
        .await?
        .ok_or_else(|| AppError::not_found("Account"))?;
    Ok(status_response(s))
}

/// `POST /api/admin/accounts/{account_id}/suspend` — set the admin-suspension flag (#37). Records
/// the acting admin + optional reason. An admin-suspended account is refused by `check_quota`
/// (job-create + ingest), taking precedence over any credit/premium comp. Idempotent (re-suspend
/// re-writes the same target). Emits an account sync frame. Returns the fresh status.
async fn suspend_account(
    scope: AdminAccountScope,
    Extension(pool): Extension<PgPool>,
    // `Option<Json<…>>` (the body-consuming extractor MUST be last): the `reason` is optional, so a
    // bodyless POST (or one with no `Content-Type: application/json`) is a valid "suspend, no reason"
    // call → `None`, rather than a 415/422. A malformed body is likewise treated as no reason.
    body: Option<Json<SuspendAccountRequest>>,
) -> ApiResult<Json<AdminAccountStatusResponse>> {
    let reason = body.and_then(|Json(b)| b.reason);
    AccountRepository::new(pool.clone())
        .set_admin_suspended(scope.account_id, true, scope.admin_user_id, reason.as_deref())
        .await
        .map_err(e)?;
    publish_account(&pool, scope.account_id, SyncAction::Update, Actor::detached()).await;
    let body = read_status(&pool, scope.account_id).await.map_err(e)?;
    Ok((StatusCode::OK, Json(body)))
}

/// `POST /api/admin/accounts/{account_id}/reactivate` — clear the admin-suspension flag + its
/// audit columns (#37). Idempotent. Emits an account sync frame. Returns the fresh status. Note:
/// this clears ONLY the admin-set flag — a DERIVED billing suspension (`is_suspended`) is
/// independent and unaffected (DEC-3).
async fn reactivate_account(
    scope: AdminAccountScope,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<AdminAccountStatusResponse>> {
    AccountRepository::new(pool.clone())
        .set_admin_suspended(scope.account_id, false, scope.admin_user_id, None)
        .await
        .map_err(e)?;
    publish_account(&pool, scope.account_id, SyncAction::Update, Actor::detached()).await;
    let body = read_status(&pool, scope.account_id).await.map_err(e)?;
    Ok((StatusCode::OK, Json(body)))
}

/// `GET /api/admin/accounts/{account_id}/status` — read the account's admin-suspension status
/// (#37). Gated to `is_admin` / `admin::accounts` by the extractor.
async fn get_account_status(
    scope: AdminAccountScope,
    Extension(pool): Extension<PgPool>,
) -> ApiResult<Json<AdminAccountStatusResponse>> {
    let body = read_status(&pool, scope.account_id).await.map_err(e)?;
    Ok((StatusCode::OK, Json(body)))
}

fn suspend_account_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts,)>(op)
        .description(
            "Suspend / disable any account by id (cross-account admin). Sets an admin-managed \
             suspension flag that is OR-ed into the quota gate: a suspended account's job-create \
             and storage-ingest are refused (BlockOverQuota), taking precedence over any credit \
             or premium comp. Independent of the Stripe-derived billing suspension. Optional \
             `reason` (audit). Requires admin::accounts (or is_admin); 403 without it, 404 on a \
             nonexistent id. Idempotent.",
        )
        .id("Admin.suspendAccount")
        .tag("admin")
        .response::<200, Json<AdminAccountStatusResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<403, (), _>(|r| {
            r.description("Missing the `admin::accounts` permission (`ADMIN_ACCOUNTS_REQUIRED`)")
        })
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn reactivate_account_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts,)>(op)
        .description(
            "Reactivate any account by id (cross-account admin) — clears the admin-managed \
             suspension flag + its audit columns. Clears ONLY the admin flag; a derived billing \
             suspension (a delinquent subscription) is independent and unaffected. Requires \
             admin::accounts (or is_admin); 403 without it, 404 on a nonexistent id. Idempotent.",
        )
        .id("Admin.reactivateAccount")
        .tag("admin")
        .response::<200, Json<AdminAccountStatusResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<403, (), _>(|r| {
            r.description("Missing the `admin::accounts` permission (`ADMIN_ACCOUNTS_REQUIRED`)")
        })
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn get_account_status_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts,)>(op)
        .description(
            "Read any account's admin-suspension status by id (cross-account admin): the \
             admin-set `admin_suspended` flag + who/when/why audit fields. Requires \
             admin::accounts (or is_admin); 403 without it, 404 on a nonexistent id.",
        )
        .id("Admin.getAccountStatus")
        .tag("admin")
        .response::<200, Json<AdminAccountStatusResponse>>()
        .response_with::<401, (), _>(|r| r.description("Unauthenticated"))
        .response_with::<403, (), _>(|r| {
            r.description("Missing the `admin::accounts` permission (`ADMIN_ACCOUNTS_REQUIRED`)")
        })
        .response_with::<404, (), _>(|r| r.description("No account with that id"))
}

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

// ============================== #33 — list all accounts ======================

/// `GET /api/admin/accounts` — one page of ALL accounts (membership-free), for an
/// `is_admin` / `admin::accounts` caller. Optional `?kind=` filter; `total` drives
/// "Showing N of M". A non-admin → 403 (the `RequirePermissions` gate).
async fn list_all_accounts(
    _auth: RequirePermissions<(AdminAccounts,)>,
    Extension(pool): Extension<PgPool>,
    Query(q): Query<AdminAccountsQuery>,
) -> ApiResult<Json<AdminAccountsListResponse>> {
    // Clamp pagination (guideline §4: never unbounded; default 20 — an admin console
    // list; cap 100), mirroring the members-list idiom.
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let repo = AccountRepository::new(pool);
    let total = repo.count_all_accounts(q.kind).await.map_err(e)?;
    let accounts: Vec<AdminAccountSummary> = repo
        .list_all_accounts(per_page, offset, q.kind)
        .await
        .map_err(e)?;

    Ok((
        StatusCode::OK,
        Json(AdminAccountsListResponse {
            accounts,
            total,
            page,
            per_page,
        }),
    ))
}

fn list_all_accounts_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts,)>(op)
        .description(
            "List ALL accounts (cross-account admin), paged, optionally filtered by \
             kind. Each row carries the account, its member count, and its owner. \
             Requires admin::accounts (or is_admin); a caller without it gets 403.",
        )
        .id("Admin.listAccounts")
        .tag("admin")
        .response::<200, Json<AdminAccountsListResponse>>()
}

// ============================== #31 — read one account =======================

/// `GET /api/admin/accounts/{account_id}` — read ANY account by id (membership-free),
/// gated to `is_admin` / `admin::accounts` by the extractor. A non-admin → 403
/// (before any lookup); an admin on a nonexistent id → 404.
async fn get_admin_account(scope: AdminAccountScope) -> ApiResult<Json<Account>> {
    Ok((StatusCode::OK, Json(scope.account)))
}

fn get_admin_account_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts,)>(op)
        .description(
            "Read any account by id (cross-account admin). Requires admin::accounts \
             (or is_admin); a caller without it gets 403, an admin on a nonexistent \
             id gets 404.",
        )
        .id("Admin.getAccount")
        .tag("admin")
        .response::<200, Json<Account>>()
}

// ======================= #148 — the membership audit ledger ==================

/// Paging for the staff ledger read. Same shape and same clamp as the account-scoped twin
/// (`page`/`per_page`, default 10, cap 100) so a client pages both surfaces identically.
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct AdminMemberEventsQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

/// `GET /api/admin/accounts/{account_id}/members/events` — the FULL membership audit ledger
/// for one account (#148), paged. The staff counterpart of
/// `GET /api/accounts/{account_id}/members/events`.
///
/// The account-scoped route withholds three things (the unattended `system` event that seeds
/// an account — not every `system` event; the individual staff member's id on `admin` rows;
/// and the staff-authored `reason`). This route serves all of them — which is precisely what
/// makes that redaction a REAL decision: without a surface
/// that shows the staff identity, "redacted from the account admin" and "never recorded at
/// all" would be the same observation.
///
/// Like every row in this ledger, these record mutations that COMMITTED. A refused action
/// leaves nothing, because the audit write shares the mutation's transaction.
async fn list_admin_member_events(
    scope: AdminAccountScope,
    _manage: RequirePermissions<(AccountManage,)>,
    Extension(pool): Extension<PgPool>,
    Query(q): Query<AdminMemberEventsQuery>,
) -> ApiResult<Json<AccountMemberEventsResponse>> {
    let repo = AccountRepository::new(pool);
    // Saturating, for the reason set out at the account-scoped twin: a caller-supplied `page`
    // is only floored at 1, so an unchecked multiply overflows into a negative OFFSET.
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(10).clamp(1, 100);
    let offset = (page - 1).saturating_mul(per_page);

    let total = repo
        .count_member_events_staff(scope.account_id)
        .await
        .map_err(e)?;
    let events = repo
        .list_member_events_staff(scope.account_id, per_page, offset)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(AccountMemberEventsResponse {
            events,
            total,
            page,
            per_page,
        }),
    ))
}

fn list_admin_member_events_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts, AccountManage)>(op)
        .description(
            "The FULL membership audit ledger for one account: who joined, left, was removed \
             or was re-roled, when, and who did it — including the unattended `system` \
             provisioning event that seeds a new account, the individual staff member's id on \
             platform-staff actions, and the staff-authored reason. All three are withheld \
             from the account-scoped twin (`Account.listMemberEvents`). Paged, newest first. Requires admin::accounts \
             + account::manage. \
             \
             THE LEDGER RECORDS COMPLETED MUTATIONS, NOT ATTEMPTS. Each row is written inside \
             the same database transaction as the mutation it records, so a refused action \
             leaves NO row. Rows are append-only and permanent: a correction is a new row, \
             never an edit, and they are deleted only when the account itself is.",
        )
        .id("Admin.listAccountMemberEvents")
        .tag("admin")
        .response::<200, Json<AccountMemberEventsResponse>>()
        // The refusals `AdminAccountScope` can return, declared — the same sweep applied to the
        // account-scoped twin. A response set of 200/403 on a route that also returns 400, 401
        // and 404 is a contract disagreeing with its own code.
        .response_with::<404, (), _>(|r| r.description("No such account."))
        .response_with::<401, (), _>(|r| r.description("Unauthenticated."))
        .response_with::<400, (), _>(|r| {
            r.description("INVALID_ACCOUNT_ID — the path segment is not a uuid.")
        })
}

// ============================== #35 — member CRUD ============================

/// `POST /api/admin/accounts/{account_id}/members` — add a user to the account with a
/// role (#35). `AdminAccountScope` resolves + gates `admin::accounts`;
/// `account::manage` is additionally required. 404 if the user does not exist, 409 if
/// already a member. Emits the member CREATE sync frame.
async fn add_account_member(
    scope: AdminAccountScope,
    _manage: RequirePermissions<(AccountManage,)>,
    Extension(pool): Extension<PgPool>,
    Json(body): Json<AddMemberRequest>,
) -> ApiResult<Json<AccountMember>> {
    let repo = AccountRepository::new(pool.clone());
    // `ActorCeiling::PlatformStaff` — the deliberate, greppable R-1 bypass. As of #145
    // `add_member` takes a REQUIRED ceiling like its two siblings, so this call site now
    // has to STATE that staff are exempt rather than inherit the exemption by the
    // parameter's absence. Behaviour here is unchanged: staff have already cleared
    // `admin::accounts` + `account::manage` and are trusted by design on this surface,
    // which is where an operator repairs an account whose own owners cannot or will not.
    let member = repo
        // #145 threaded the R-1 ceiling through here; #148 widened its staff variant to
        // carry the acting employee's id. ONE parameter does both jobs: the ceiling is the
        // authority, and the audit actor is DERIVED from it inside the repository
        // (`actor.audit_actor()`), so the `joined` row this writes carries
        // `actor_kind = 'admin'` and that employee's id, and the two can never disagree.
        // `AdminAccountScope` has carried `admin_user_id` since #37 (it stamps
        // `admin_suspended_by`); this is its third consumer.
        .add_member(
            scope.account_id,
            body.user_id,
            body.role,
            ActorCeiling::PlatformStaff {
                staff_user_id: scope.admin_user_id,
            },
        )
        .await
        .map_err(e)?;
    publish_account_member(
        &pool,
        scope.account_id,
        SyncAction::Create,
        Actor::detached(),
    )
    .await;
    Ok((StatusCode::CREATED, Json(member)))
}

/// The seat-refusal half of `add_member`'s 422 contract (#141), or an empty string on a
/// build that cannot emit it.
///
/// **Build-conditional on purpose (FIX_ROUND-3, R3-2).** `add_member_docs` is an
/// unconditional transform feeding BOTH generated specs, so a flat sentence saying "saas
/// builds only" would document, in the desktop client, a refusal that build can never
/// produce — the opposite of the two-spec presence-split discipline #50 established. Empty
/// here means the desktop spec simply does not mention seats, which is the truth for it.
#[cfg(feature = "saas")]
const SEAT_REFUSAL_DOC: &str = " Refuses **422 `SEAT_LIMIT_REACHED`** when the account \
    already holds its plan's `member_allowance` members (#141): `details` carries `plan_id`, \
    `limit` and `current` — the MEMBER count, the same quantity `members_used` reports on \
    `GET /api/billing/quota`. Re-adding an EXISTING member is still 409, never a seat refusal — that \
    write consumes no seat. Refuses **422 `SEAT_PLAN_UNKNOWN`** when the account's `plan_id` \
    names no catalog tier: a configuration problem, not a plan limit. The seat limit binds \
    this platform-staff route too, by design; the operator override is the audited \
    per-account comp flag.";

#[cfg(not(feature = "saas"))]
const SEAT_REFUSAL_DOC: &str = "";

fn add_member_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts, AccountManage)>(op)
        // ONE `.description()` call, with the build-conditional seat fragment APPENDED
        // (FIX_ROUND-3). Two calls do not concatenate — aide's `.description()` REPLACES,
        // so the first version blanked this route's description in the desktop spec, where
        // the fragment is empty. Caught by the regen diff, which is what that gate is for.
        .description(&format!(
            "Add a user to an account with a coarse role (owner/admin/member). \
             Requires admin::accounts + account::manage. 404 if the user does not \
             exist, 409 if already a member. Refuses (422 `PERSONAL_ACCOUNT_NOT_MANAGEABLE`) on a PERSONAL account: it has exactly one member, its owner, and account membership is an implicit grant over everything that user owns, so a personal account's membership is never mutable.{SEAT_REFUSAL_DOC}"
        ))
        .id("Admin.addMember")
        .tag("admin")
        .response::<201, Json<AccountMember>>()
        .response_with::<422, (), _>(|r| {
            r.description(
                // The "distinguish by code" clause lives INSIDE the saas fragment: on a
                // desktop build this route emits exactly one 422 code, so telling that
                // client to disambiguate would be describing a choice it never has. The
                // effect is that the DEFAULT spec is byte-unchanged by this whole item —
                // INV-3 at the wire (FIX_ROUND-3).
                &format!(
                    "`PERSONAL_ACCOUNT_NOT_MANAGEABLE` — the target is a personal account, \
                     whose membership cannot be modified.{SEAT_REFUSAL_DOC}"
                ),
            )
        })
}

/// `DELETE /api/admin/accounts/{account_id}/members/{user_id}` — remove a member
/// (#35). Refuses (422) to remove the SOLE remaining owner (INV-3). 404 if the
/// membership does not exist. Emits the member DELETE sync frame.
///
/// #171 (a): the removal ALSO cancels the departing member's pending project
/// transfers on this account's projects, in both directions, inside the removal
/// transaction (`AccountRepository::remove_member`). This handler fans the resulting
/// `ProjectTransfer` DELETE frames out to BOTH parties of each cancelled offer. The
/// response stays 204 with no body (DEC-10), so `openapi.json` is unchanged.
///
/// **What those frames do, corrected (DEC-32).** An earlier revision of this comment
/// said each party "would keep rendering a pending transfer that no longer exists".
/// That is FALSE: no party-facing DTO carries pending-transfer state — `ProjectDto`
/// has no transfer field, and `transfer_pending` / `transfer` live only on the ADMIN
/// DTOs. What the frames actually buy is invalidation: the FE subscribes to
/// `sync:project_transfer` action-agnostically in the projects and project-detail
/// stores, so a party whose data could be affected refetches. That is worth having and
/// is what the fan-out is for.
///
/// The corollary is a KNOWN GAP, recorded rather than absorbed: the one surface that
/// DOES render pending-transfer state is the platform-admin project list, and it
/// belongs to the acting admin, who is deliberately not in either party's audience. So
/// an admin looking at that list still sees a stale "transfer pending" tag until they
/// reload. Filed, not fixed here — widening the audience to platform admins is a sync
/// design question, not part of this security fix.
async fn remove_account_member(
    scope: AdminAccountScope,
    _manage: RequirePermissions<(AccountManage,)>,
    Extension(pool): Extension<PgPool>,
    Path((_account_id, user_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<()> {
    let repo = AccountRepository::new(pool.clone());
    let cancelled = repo
        // `PlatformStaff` — no R-1 ceiling (#142). Deliberate and correct HERE: the
        // caller has already cleared `admin::accounts` + `account::manage`, and the
        // admin surface is where an operator repairs an account whose own owners
        // cannot or will not. The self-service twin passes `SelfService` instead.
        .remove_member(
            scope.account_id,
            user_id,
            // #148 widened `PlatformStaff` to carry the acting staff member's id. It had
            // none, so the audit ledger could not attribute a staff removal — the hole an
            // audit trail most exists to close. The R-1 semantics are unchanged: staff still
            // have no ceiling.
            ActorCeiling::PlatformStaff {
                staff_user_id: scope.admin_user_id,
            },
        )
        .await
        .map_err(e)?;
    publish_account_member(
        &pool,
        scope.account_id,
        SyncAction::Delete,
        Actor::detached(),
    )
    .await;
    // Mirrors `project::handlers::cancel_transfer`'s fan-out: one frame per party,
    // `origin: None` because the acting admin is neither of them (nothing to suppress).
    for t in cancelled {
        publish(
            SyncEntity::ProjectTransfer,
            SyncAction::Delete,
            t.id,
            Audience::owner(t.from_user_id),
            None,
        );
        publish(
            SyncEntity::ProjectTransfer,
            SyncAction::Delete,
            t.id,
            Audience::owner(t.to_user_id),
            None,
        );
    }
    Ok((StatusCode::NO_CONTENT, ()))
}

fn remove_member_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts, AccountManage)>(op)
        .description(
            "Remove a member from an account. Requires admin::accounts + \
             account::manage. Refuses (422) to remove the last owner — an account \
             must keep at least one owner. 404 if the membership does not exist. Refuses (422 `PERSONAL_ACCOUNT_NOT_MANAGEABLE`) on a PERSONAL account: it has exactly one member, its owner, and account membership is an implicit grant over everything that user owns, so a personal account's membership is never mutable.",
        )
        .id("Admin.removeMember")
        .tag("admin")
        .response::<204, ()>()
        .response_with::<422, (), _>(|r| {
            r.description(
                "`LAST_OWNER` — an account must keep at least one owner; or \
                 `PERSONAL_ACCOUNT_NOT_MANAGEABLE` — the target is a personal account, whose \
                 membership cannot be modified. Distinguish by the error CODE, not the status",
            )
        })
}

/// `PATCH /api/admin/accounts/{account_id}/members/{user_id}` — change a member's
/// role (#35). Refuses (422) to demote the SOLE remaining owner (INV-3). 404 if the
/// membership does not exist. Emits the member UPDATE sync frame.
async fn set_member_role(
    scope: AdminAccountScope,
    _manage: RequirePermissions<(AccountManage,)>,
    Extension(pool): Extension<PgPool>,
    Path((_account_id, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<SetRoleRequest>,
) -> ApiResult<Json<AccountMember>> {
    let repo = AccountRepository::new(pool.clone());
    let member = repo
        // `PlatformStaff` — no R-1 ceiling (#142); see `remove_account_member` above.
        .set_role(
            scope.account_id,
            user_id,
            body.role,
            // #148 — see `remove_account_member`: the staff id is what makes the
            // `role_changed` row attributable. R-1 semantics unchanged.
            ActorCeiling::PlatformStaff {
                staff_user_id: scope.admin_user_id,
            },
        )
        .await
        .map_err(e)?;
    publish_account_member(
        &pool,
        scope.account_id,
        SyncAction::Update,
        Actor::detached(),
    )
    .await;
    Ok((StatusCode::OK, Json(member)))
}

fn set_role_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AdminAccounts, AccountManage)>(op)
        .description(
            "Change a member's coarse role (owner/admin/member). Requires \
             admin::accounts + account::manage. Refuses (422) to demote the last \
             owner. 404 if the membership does not exist. Refuses (422 `PERSONAL_ACCOUNT_NOT_MANAGEABLE`) on a PERSONAL account: it has exactly one member, its owner, and account membership is an implicit grant over everything that user owns, so a personal account's membership is never mutable.",
        )
        .id("Admin.setMemberRole")
        .tag("admin")
        .response::<200, Json<AccountMember>>()
        .response_with::<422, (), _>(|r| {
            r.description(
                "`LAST_OWNER` — an account must keep at least one owner; or \
                 `PERSONAL_ACCOUNT_NOT_MANAGEABLE` — the target is a personal account, whose \
                 membership cannot be modified. Distinguish by the error CODE, not the status",
            )
        })
}
