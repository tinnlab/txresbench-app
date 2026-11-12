//! A4 ITEM-2 — the account read REST surface (A1 left `handlers.rs`/`routes.rs` as
//! stubs). Two GET endpoints, both gated `RequirePermissions<(AccountRead,)>`
//! (CONS-A4-4 / PROV-A1-8 — `account::read`, held by the Users group; the self-gate
//! the FE `Accounts` store mirrors):
//!
//! - `GET /api/accounts` — the switcher list (`list_user_accounts`, owner-filtered
//!   to the caller's memberships — no cross-account leak; PROV-A1-5 / CONS-A4-2).
//! - `GET /api/accounts/{id}/members` — one account's members, paged, but ONLY for an
//!   account the caller is a member of; a non-member's request 404s through the same
//!   membership gate (PROV-A3-1 — the existence oracle).
//!
//! There is **no** `POST /switch` — switching is a client-header operation (DEC-2)
//! validated per-request by the `ActiveAccount` extractor. All SQL lives in
//! `repository.rs` (guideline §9); handlers only call the resolvers.

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::{Extension, Json};
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::{ApiResult, AppError};

use crate::modules::permissions::RequirePermissions;

use crate::modules::sync::{
    publish, Actor, Audience, SyncAction, SyncEntity, SyncOrigin,
};

use super::accept::InvitationRedeemer;
use super::member_scope::{AccountScope, RoleAdmin, SelfMembership};
use super::invitation_limits::InvitationLimits;
use super::models::{
    Account, AcceptInvitationRequest, AcceptInvitationResponse, AccountListResponse,
    AccountMember, AccountMemberEventsResponse, AccountMembersManageContext,
    AccountMembersResponse, CreateInvitationRequest, CreateInvitationResponse,
    CreateOrganizationRequest, InvitationsListResponse, ResendInvitationResponse, SetRoleRequest,
};
use super::permissions::{AccountManage, AccountRead};
use super::repository::{AccountRepository, ActorCeiling, AuditActor};
use super::sync::{publish_account_created, publish_account_member};

fn e(err: AppError) -> (StatusCode, AppError) {
    err.to_api_error()
}

/// Validate + normalize a submitted account name: trim, and reject an empty /
/// whitespace-only value (400) BEFORE any DB call. Pure (unit-tested TEST-6).
fn validate_account_name(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::bad_request(
            "INVALID_NAME",
            "account name must not be empty",
        ));
    }
    Ok(trimmed.to_string())
}

/// `GET /api/accounts` — every account the caller is a member of (personal + any
/// orgs), the switcher list. Owner-filtered by the repository (`WHERE m.user_id =
/// $auth`), so a caller never sees an account they are not a member of.
pub async fn list_accounts(
    auth: RequirePermissions<(AccountRead,)>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<AccountListResponse>> {
    let repo = AccountRepository::new(pool);
    let accounts = repo.list_user_accounts(auth.user.id).await.map_err(e)?;
    Ok((StatusCode::OK, Json(AccountListResponse { accounts })))
}

/// `POST /api/accounts` — create an ORGANIZATION account (#34), gated
/// `account::manage` (admin-only; not group-granted, so a plain user 403s). The
/// account + its `owner` membership are created in ONE transaction (INV-2); the
/// owner defaults to the caller, or a supplied existing `owner_id`. Emits the
/// account + owner-membership CREATE sync frames. Returns 201 + the new account.
pub async fn create_organization(
    auth: RequirePermissions<(AccountManage,)>,
    Extension(pool): Extension<SqlitePool>,
    Json(body): Json<CreateOrganizationRequest>,
) -> ApiResult<Json<Account>> {
    let name = validate_account_name(&body.name).map_err(e)?;
    let owner_id = body.owner_id.unwrap_or(auth.user.id);

    let repo = AccountRepository::new(pool.clone());
    // #148 — attributed to the CALLER (`auth.user.id`), never to `owner_id`: this route
    // accepts an explicit owner, so the two differ whenever an operator founds an
    // organization for somebody else.
    //
    // `AuditActor::Admin`, not `User`. The first implementation said `User` on the reasoning
    // that `actor_kind` tracks the SURFACE, and a blind audit reproduced the consequence: this
    // route is gated on `AccountManage`, the platform-staff capability that is NOT granted to
    // the Users group, so EVERY caller here is acting with staff authority — and a `user` row
    // escapes the account-scoped projection's `admin`-only redaction, serving a platform
    // employee's user id straight to the tenant, in direct contradiction of this route's own
    // published description. `actor_kind` classifies the AUTHORITY the actor used, and on this
    // route there is only one.
    let account = repo
        .create_organization(&name, owner_id, AuditActor::Admin(auth.user.id))
        .await
        .map_err(e)?;

    // Notify-and-refetch the new account's members (the owner). Detached actor —
    // the admin creator is not necessarily a member's device to suppress.
    publish_account_created(&pool, account.id).await;

    Ok((StatusCode::CREATED, Json(account)))
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct MembersQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

/// `GET /api/accounts/{id}/members` — the members of an account the caller is a
/// member of, paged (numbered settings-list idiom). A non-member's request 404s,
/// byte-identical to a nonexistent account (the membership gate — PROV-A3-1).
pub async fn list_account_members(
    auth: RequirePermissions<(AccountRead,)>,
    Extension(pool): Extension<SqlitePool>,
    Path(account_id): Path<Uuid>,
    Query(q): Query<MembersQuery>,
) -> ApiResult<Json<AccountMembersResponse>> {
    let repo = AccountRepository::new(pool);
    // Membership gate FIRST: a non-member (or nonexistent account) ⇒ 404 (never a
    // 403, never any member data). Routed through A1's `membership_role` — the
    // PROV-A3-1 `None ⇒ 404` signal — so a foreign account id is an existence oracle.
    if repo
        .membership_role(account_id, auth.user.id)
        .await
        .map_err(e)?
        .is_none()
    {
        return Err(e(AppError::not_found("Account")));
    }

    // Clamp pagination (guideline §4: never unbounded; default 10 — the settings-list
    // page size; cap 100).
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(10).clamp(1, 100);
    // Saturating: `page` is caller-supplied and floored at 1 but never capped, so an unchecked
    // multiply overflows on `?page=9223372036854775807` — a panic in a dev/test build (this
    // workspace sets no [profile] overrides, so overflow checks are ON there) and a wrap to a
    // negative OFFSET in release, which Postgres refuses outright.
    //
    // This line is PRE-EXISTING and belongs to the members-list route, not to the audit ledger.
    // It is changed anyway, deliberately: it is one identical character in a file this branch
    // already edits, `saturating_mul` differs from `*` only where `*` would panic or wrap, and
    // "report, do not fix" is a rule about not masking pre-existing RED GATES — not a reason to
    // leave a reachable panic sitting next to its own fix. Called out in the branch report.
    let offset = (page - 1).saturating_mul(per_page);

    let total = repo.count_members(account_id).await.map_err(e)?;
    let members = repo
        .list_members_paged(account_id, per_page, offset)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(AccountMembersResponse {
            members,
            total,
            page,
            per_page,
        }),
    ))
}

/// `GET /api/accounts/{account_id}/members/events` — the account's membership audit ledger
/// (#148), paged with the same numbered settings-list idiom as the members list.
///
/// # What the caller gets, and what they do not
///
/// The **account-scoped projection** (DEC-7, corrected by DEC-19), applied in SQL by
/// `AccountRepository::list_member_events_scoped`: the unattended `system` event that SEEDS an
/// account is omitted — but not every `system` event, since a membership that ENDED with no
/// attributable human actor is a real event here — the staff `actor_user_id` is redacted to
/// NULL on `admin` rows, and `reason` is never selected.
///
/// The ledger records membership mutations that COMMITTED. A **refused** attempt is not a row
/// — the audit write shares the mutation's transaction, so a refusal rolls it back. This
/// surface answers "what happened to this account"; it does NOT answer "who tried what".
///
/// # Authorization
///
/// `AccountScope<RoleAdmin>`: a proven `admin`-or-`owner` membership in THIS account, plus the
/// member-management capability the extractor's step 2 checks. A non-member — or a member of a
/// different account — gets 404, byte-identical to a nonexistent account id. A bare `member`
/// gets 403.
pub async fn list_account_member_events(
    scope: AccountScope<RoleAdmin>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<MembersQuery>,
) -> ApiResult<Json<AccountMemberEventsResponse>> {
    let repo = AccountRepository::new(pool);
    // Same clamp as `list_account_members` — deliberately the same bounds, not a second
    // tunable, so the two adjacent surfaces page identically (#148 DEC-15). The multiply is
    // SATURATING, which the sibling's is not: `page` is caller-supplied and only floored at 1,
    // so `?page=9223372036854775807` overflows it — a panic in a debug build, and in release a
    // wrap to a NEGATIVE offset that Postgres refuses outright (a 500). Saturating instead
    // yields an offset past the end, i.e. an empty page, which is the honest answer to a
    // request for page nine quintillion. (`list_account_members` above had the same defect and
    // is fixed the same way — see the note there for why that pre-existing line was touched.)
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(10).clamp(1, 100);
    let offset = (page - 1).saturating_mul(per_page);

    let total = repo
        .count_member_events_scoped(scope.account_id)
        .await
        .map_err(e)?;
    let events = repo
        .list_member_events_scoped(scope.account_id, per_page, offset)
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

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-6 [covers: ITEM-4]: the create-org name validator trims a valid name and
    // rejects an empty / whitespace-only one with a 400 — BEFORE any DB call.
    #[test]
    fn validate_account_name_trims_and_rejects_blank() {
        assert_eq!(validate_account_name("  Acme Lab  ").unwrap(), "Acme Lab");
        assert_eq!(validate_account_name("x").unwrap(), "x");

        for blank in ["", "   ", "\t\n"] {
            let err = validate_account_name(blank).unwrap_err();
            assert_eq!(err.status_code(), 400, "blank name is a 400: {blank:?}");
        }
    }
}

/// `GET /api/accounts/{account_id}/members/manage-context` (#139) — the proof route
/// for the `AccountScope<Min>` seam, and the preflight a management UI runs before
/// rendering member-write affordances.
///
/// **The handler performs NO authorization of its own, and that is the point.** Taking
/// `AccountScope<RoleAdmin>` in the signature IS the check: by the time this body runs
/// the caller has been authenticated (401), shown to hold `account::members::manage`
/// (403, before any account lookup), had the PATH `account_id` parsed (400/500), been
/// proven a MEMBER of that account (404 otherwise — the cross-tenant guard), been
/// graded at `admin` or above (403 otherwise), and the account shown not to be personal
/// (422 otherwise). Omitting the gate is not a forgotten call here — it is a type
/// error, because there is no other way to obtain the account id.
pub async fn account_members_manage_context(
    scope: AccountScope<RoleAdmin>,
    Extension(pool): Extension<SqlitePool>,
) -> ApiResult<Json<AccountMembersManageContext>> {
    let member_count = AccountRepository::new(pool)
        .count_members(scope.account_id)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(AccountMembersManageContext {
            // The PATH id the extractor resolved — never the `X-Account-Id` header.
            account_id: scope.account_id,
            actor_role: scope.actor_role,
            member_count,
        }),
    ))
}

// ======================= #142 — self-service member mutations =======================
//
// Three routes, all on `AccountScope<Min>`: change a member's role, remove a member,
// and leave. They are the SELF-SERVICE twins of `admin/routes.rs`'s member CRUD, and the
// only differences are the two that matter:
//
//   * the extractor (`AccountScope<Min>` — path-authoritative, membership-proven, no
//     `is_admin` short-circuit) instead of `AdminAccountScope`; and
//   * `ActorCeiling::SelfService` instead of `ActorCeiling::PlatformStaff`, which is
//     what makes R-1 (the role-escalation guard) apply here and not there.
//
// Everything else is deliberately the SAME code path: `set_role` / `remove_member`
// unmodified in substance, so the race-safe `LAST_OWNER` guard, `refuse_if_personal`
// and #171's offboarding hook are REACHED rather than re-implemented (#142 R-2). No
// handler in this file contains a second copy of any of them.

/// The [`ActorCeiling`] for a request that arrived through [`AccountScope`].
///
/// One-line helper because getting it wrong is silent: passing `PlatformStaff` here
/// would disable R-1 for the entire self-service surface and every other test in the
/// suite would still pass (TEST-15 is what would catch it). Building it in one place,
/// from the scope's own proven fields, means no handler assembles it by hand.
fn ceiling_of<Min: super::member_scope::MinAccountRole>(scope: &AccountScope<Min>) -> ActorCeiling {
    ActorCeiling::SelfService {
        actor_user_id: scope.actor_user_id,
        observed_role: scope.actor_role,
    }
}

/// Tell the DEPARTED member their membership is gone.
///
/// [`publish_account_member`] fans to `account_audience`, which is resolved from
/// `list_members` — and by the time it runs the removed row is already deleted, so the
/// one person who most needs the frame is the one person NOT in the audience. Without
/// this, a removed or departed member's client keeps the account in its switcher until
/// a full reload, and #142 requires otherwise: *"The removal frame must reach the removed
/// user so their client drops the account from the switcher."*
///
/// Two entities, because the client keys two different things off them: `AccountMember`
/// invalidates the members list, `Account` invalidates `GET /api/accounts` — the
/// switcher list itself (`Account.store.ts` subscribes to both).
///
/// `origin` is stamped only when the departed user IS the actor (a `leave`), mirroring
/// `Actor::origin_for` exactly, so the acting tab does not refetch what it just wrote
/// while every OTHER device of that same user does.
///
/// The equivalent gap on the ADMIN removal path (`admin/routes.rs`) is real and is
/// REPORTED, not silently widened into this diff — that route has its own audience
/// semantics (a detached actor) and changing it is not this item's scope.
fn notify_departed_member(account_id: uuid::Uuid, departed: Uuid, actor: Actor) {
    let origin = if actor.user_id == Some(departed) {
        actor.connection
    } else {
        None
    };
    publish(
        SyncEntity::AccountMember,
        SyncAction::Delete,
        account_id,
        Audience::owner(departed),
        origin,
    );
    // `Update`, not `Delete`: the ACCOUNT was not deleted — the reader's membership of it
    // was. `Account.store.ts` subscribes action-agnostically (`on('sync:account', reload)`)
    // so either works today, but a future consumer that branches on `action === 'delete'`
    // would conclude the organization had been destroyed. `Update` carries the same
    // invalidation with a true action.
    publish(
        SyncEntity::Account,
        SyncAction::Update,
        account_id,
        Audience::owner(departed),
        origin,
    );
}

/// Fan the `ProjectTransfer` DELETE frames for the transfers #171's offboarding hook
/// cancelled inside the removal transaction — one per party. Mirrors
/// `admin/routes.rs::remove_account_member` and `project::handlers::cancel_transfer`.
///
/// **`origin` is `None` for both parties — and an earlier revision of this function that
/// "fixed" that was a REGRESSION, so the reasoning is recorded rather than the conclusion
/// alone.**
///
/// `origin` does not mean "the actor" — it means *"do not send this frame, because the
/// acting client is going to re-emit it locally instead"*. `core/sync/localEcho.ts` is
/// explicit that the echo is a MANUAL, per-call-site obligation: the client echoes
/// exactly the frames its own action declares. A Leave or Remove action declares
/// `account_member` and `account`; **nothing echoes `project_transfer`**, because from
/// the client's point of view this mutation was a membership change and the transfer
/// cancellation is a side effect it does not know about.
///
/// So stamping `origin` here does not spare a double fetch — it withholds the frame from
/// the one recipient who performed the action and whose project views are about to be
/// stale, with nothing to put it back. Three live subscribers (`Projects.store.ts`,
/// `ProjectDetail.store.ts`, `ProjectAdmin.store.ts`) would not refetch until that tab's
/// next `sync:reconnect` — a staleness WINDOW rather than a permanent loss, since
/// `localEcho.ts` is explicit that the echo is a latency path and reconnect is the
/// correctness path. A window is still the wrong trade when nothing is bought by it.
///
/// It reached both call sites. On `leave` the actor is a party to every cancelled
/// transfer, so their own frames vanished; on the admin/remove path the actor is
/// generally a third party — the cancellation is scoped to the REMOVED member
/// (`cancel_pending_transfers_for_removed_member`'s `from_user_id = $2 OR to_user_id = $2`)
/// — but when the acting admin happens to BE the counterparty, theirs vanished too.
///
/// **The rule this leaves behind**, stated as the criterion rather than the outcome:
/// suppress a frame with `origin` only when the acting client's OWN action can know to
/// echo it. That is what separates this function from [`notify_departed_member`] fifty
/// lines above, which DOES stamp `origin` — a Leave/Remove action knows it changed a
/// membership, so it can echo `account_member` and `account`; it does not know that a
/// project transfer was cancelled as a side effect, because that is not part of the
/// operation it invoked. "Is there an echo today?" is the wrong test — a frontend exists,
/// and it already echoes `project_transfer` for the operations that DO invoke a transfer
/// (`ProjectDetail.store.ts`); what does not exist yet is any client for THIS route
/// (#149). Applying "is there an echo today?" would therefore have argued for stamping
/// neither, which is why the criterion is about what the acting action can KNOW, not about
/// what happens to be wired.
///
/// `admin/routes.rs::remove_account_member` passes `None` too, but NOT for a reason that
/// transfers: it takes no `SyncOrigin` extractor at all and publishes with
/// `Actor::detached()`, so `None` is the only value in scope there regardless of who acts.
/// It is not a precedent for this decision, and an earlier version of this comment
/// justified it as one ("the acting admin is a third party") — which is also not
/// structurally true, since the cancellation matches the REMOVED member on either side and
/// the acting admin can be the counterparty.
/// `project::handlers::cancel_transfer` is NOT a precedent for `None` — it stamps
/// `origin` on the acting owner's frame and `None` on the counterparty's — and an earlier
/// version of this comment cited it as one.
fn fan_cancelled_transfers(cancelled: Vec<crate::modules::project::CancelledTransfer>) {
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
}

/// `PATCH /api/accounts/{account_id}/members/{user_id}` (#142) — change a member's role
/// on an account you administer.
///
/// Authorization is the `AccountScope<RoleAdmin>` in the signature (all six steps: 401 →
/// 403 capability → 400/500 path → 404 membership → 403 floor → 422 personal), plus
/// **R-1** inside the repository transaction: both the target's CURRENT role and the
/// REQUESTED role must be at or below the caller's own, else 403 `ROLE_ABOVE_ACTOR`.
/// The sole-owner protection is `AccountRepository::set_role`'s existing race-safe
/// `LAST_OWNER` guard, reached, not duplicated.
pub async fn set_member_role(
    scope: AccountScope<RoleAdmin>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path((_account_id, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<SetRoleRequest>,
) -> ApiResult<Json<AccountMember>> {
    let ceiling = ceiling_of(&scope);
    let member = AccountRepository::new(pool.clone())
        .set_role(scope.account_id, user_id, body.role, ceiling)
        .await
        .map_err(e)?;
    publish_account_member(
        &pool,
        scope.account_id,
        SyncAction::Update,
        Actor::user(scope.actor_user_id, origin.0),
    )
    .await;
    Ok((StatusCode::OK, Json(member)))
}

/// `DELETE /api/accounts/{account_id}/members/{user_id}` (#142) — remove a member from
/// an account you administer.
///
/// Same authorization as the PATCH, with R-1 graded on the target's current role alone
/// (a removal requests no new role), so an Admin cannot evict an Owner. Routes through
/// `AccountRepository::remove_member`, so it inherits the `LAST_OWNER` guard, the
/// personal-account refusal and #171's in-transaction transfer cancellation unchanged.
pub async fn remove_member(
    scope: AccountScope<RoleAdmin>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Path((_account_id, user_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<()> {
    let ceiling = ceiling_of(&scope);
    let actor = Actor::user(scope.actor_user_id, origin.0);
    let cancelled = AccountRepository::new(pool.clone())
        .remove_member(scope.account_id, user_id, ceiling)
        .await
        .map_err(e)?;
    publish_account_member(&pool, scope.account_id, SyncAction::Delete, actor).await;
    notify_departed_member(scope.account_id, user_id, actor);
    fan_cancelled_transfers(cancelled);
    Ok((StatusCode::NO_CONTENT, ()))
}

/// `POST /api/accounts/{account_id}/members/leave` (#142) — end YOUR OWN membership.
///
/// Two things distinguish this from the DELETE above, and both are deliberate.
///
/// **It takes no target.** The removed user is `scope.actor_user_id`, so "leave someone
/// else" is not expressible — there is no parameter in which to say it. That is what
/// lets the route sit at the `member` floor safely.
///
/// **It does not require `account::members::manage`** — `SelfMembership` sets
/// `REQUIRES_MANAGE_CAPABILITY = false` (#232, DEC-3). Ending your own membership is not
/// "managing the members of accounts you administer"; gating it behind the operator's
/// kill switch trapped every existing member of every account the moment self-service
/// was switched off. Factor (b) still runs in full: a non-member gets 404, a personal
/// account gets 422, and the sole owner gets 422 `LAST_OWNER` from the same guard the
/// admin path reaches — which is exactly why this MUST route through `remove_member`
/// and not a `DELETE … WHERE user_id = me` (#142 R-2).
pub async fn leave_account(
    scope: AccountScope<SelfMembership>,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
) -> ApiResult<()> {
    let ceiling = ceiling_of(&scope);
    let actor = Actor::user(scope.actor_user_id, origin.0);
    let cancelled = AccountRepository::new(pool.clone())
        .remove_member(scope.account_id, scope.actor_user_id, ceiling)
        .await
        .map_err(e)?;
    publish_account_member(&pool, scope.account_id, SyncAction::Delete, actor).await;
    notify_departed_member(scope.account_id, scope.actor_user_id, actor);
    fan_cancelled_transfers(cancelled);
    Ok((StatusCode::NO_CONTENT, ()))
}

// ========================= #145 — account invitations ==========================
//
// Four handlers, all taking `AccountScope<RoleAdmin>`. As with
// `account_members_manage_context`, **the handler performs NO authorization of its own,
// and that is the point**: taking the scope in the signature IS the check (401 → 403
// capability → 400/500 path → 404 membership → 403 floor → 422 personal), and there is
// no other way to obtain the account id, so omitting the gate is a type error rather
// than a forgotten call.
//
// The one place a handler here does real work is `create_invitation`'s response, which
// must be identical in all four cases. That is enforced structurally rather than
// carefully — see `INVITATION_SENT_STATUS`.

/// The ONLY value `create_invitation` ever puts in its response body.
///
/// A `const` rather than an inline literal per branch, because there is exactly one
/// branch and there must remain exactly one: INV-8 requires the response to be
/// byte-identical whether the address belongs to no user, to a user, to a user who is
/// already a member, or to an address that already has a live invitation. Two of those
/// are server-side no-ops, and the natural "improvement" — a `409 ALREADY_A_MEMBER` — is
/// precisely the oracle invitations exist to close: it would tell the caller both that
/// the address is registered AND that it is in this account.
const INVITATION_SENT_STATUS: &str = "sent";

/// `POST /api/accounts/{account_id}/invitations` (#145) — invite an email address to
/// this account.
///
/// **Always `202 Accepted` with `{"status":"sent"}`.** The repository reports what it
/// actually did via `InvitationOutcome`, and this handler deliberately **ignores** that
/// value for the purposes of the response: it is bound to `_outcome` so the binding is
/// visible, and so a reader can see that the choice not to branch is a decision rather
/// than an omission. (#148's audit hook and the deny suite are its real consumers.)
///
/// Refusals that DO vary are the ones that carry no information about the invitee:
/// 403 `ROLE_ABOVE_ACTOR` (the requested role is above the caller's own — R-1), 429
/// `INVITATION_RATE_LIMITED`, 422 `PERSONAL_ACCOUNT_NOT_MANAGEABLE`, and the scope's own
/// 401/403/404. All of them are answers about the CALLER or the ACCOUNT, never about the
/// address.
pub async fn create_invitation(
    scope: AccountScope<RoleAdmin>,
    Extension(pool): Extension<SqlitePool>,
    Json(body): Json<CreateInvitationRequest>,
) -> ApiResult<Json<CreateInvitationResponse>> {
    let ceiling = ceiling_of(&scope);
    let _outcome = AccountRepository::new(pool)
        .create_invitation(
            scope.account_id,
            &body.email,
            body.role,
            ceiling,
            InvitationLimits::defaults(),
        )
        .await
        .map_err(e)?;

    // No sync frame is emitted here — `SyncEntity` has no `AccountInvitation` variant and
    // adding one whose only consumer (#149's surface) does not exist yet is the dead-seam
    // shape. The obligation is carried forward in `routes.rs`.
    Ok((
        StatusCode::ACCEPTED,
        Json(CreateInvitationResponse {
            status: INVITATION_SENT_STATUS.to_string(),
        }),
    ))
}

/// `GET /api/accounts/{account_id}/invitations` (#145) — this account's own pending
/// invitations, paged.
///
/// An inviter learning about their OWN account's invitations is not enumeration, which is
/// why this is a normal read at the `admin` floor. What it must not do is reveal whether
/// a pending invitee is a registered user — and it cannot, because
/// `list_pending_invitations`' SQL never joins `users` (see that function).
///
/// No invite LINK is returned. The token is stored only as a SHA-256, so the server
/// cannot reproduce a link it has already handed out; the link is minted afresh by the
/// resend route (#145 DEC-2).
pub async fn list_invitations(
    scope: AccountScope<RoleAdmin>,
    Extension(pool): Extension<SqlitePool>,
    Query(q): Query<MembersQuery>,
) -> ApiResult<Json<InvitationsListResponse>> {
    // Same clamp as `list_account_members` (guideline §4: never unbounded; default 10 —
    // the settings-list page size; cap 100).
    //
    // The offset is computed with SATURATING arithmetic (FIX_ROUND-1, F13). The sibling
    // handler above uses `(page - 1) * per_page` on an `i64` clamped only from below, so
    // `?page=9223372036854775807&per_page=100` overflows — a panic under overflow-checks,
    // or a negative `OFFSET` Postgres rejects, i.e. a 500 per request. That is a
    // PRE-EXISTING pattern on `list_account_members` and is reported rather than changed
    // here; this new route does not inherit it. A saturated offset simply returns an empty
    // page, which is the honest answer to "page 9 quintillion".
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(10).clamp(1, 100);
    let offset = page.saturating_sub(1).saturating_mul(per_page);

    let repo = AccountRepository::new(pool);
    let total = repo
        .count_pending_invitations(scope.account_id)
        .await
        .map_err(e)?;
    let invitations = repo
        .list_pending_invitations(scope.account_id, per_page, offset)
        .await
        .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(InvitationsListResponse {
            invitations,
            total,
            page,
            per_page,
        }),
    ))
}

/// `POST /api/accounts/{account_id}/invitations/{invitation_id}/resend` (#145) — mint a
/// fresh token for a pending invitation and return it.
///
/// **This is the copy-link channel**, and the only place a plaintext invitation token is
/// ever surfaced. It is enumeration-safe because it is keyed on an invitation ID the
/// caller obtained by listing their own account's invitations, and takes no email — there
/// is nothing to probe. A foreign, unknown or already-settled id is `404 Invitation`.
///
/// R-1 is re-graded inside the repository against the LIVE ceiling: a resend re-mints a
/// live token for a grant the actor may no longer be entitled to confer.
pub async fn resend_invitation(
    scope: AccountScope<RoleAdmin>,
    Extension(pool): Extension<SqlitePool>,
    Path((_account_id, invitation_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<ResendInvitationResponse>> {
    let ceiling = ceiling_of(&scope);
    let (invite_token, expires_at) = AccountRepository::new(pool)
        .resend_invitation(
            scope.account_id,
            invitation_id,
            ceiling,
            InvitationLimits::defaults(),
        )
        .await
        .map_err(e)?;
    Ok((
        StatusCode::OK,
        Json(ResendInvitationResponse {
            invitation_id,
            invite_token,
            expires_at,
        }),
    ))
}

/// `DELETE /api/accounts/{account_id}/invitations/{invitation_id}` (#145) — revoke a
/// pending invitation. Soft: the row is stamped, never deleted (audit).
///
/// R-1 is deliberately not graded on revoke — revoking removes no role, so there is no
/// standing to be above, and grading it would trap an `owner` invitation an Admin needs
/// to clean up. See `AccountRepository::revoke_invitation`.
pub async fn revoke_invitation(
    scope: AccountScope<RoleAdmin>,
    Extension(pool): Extension<SqlitePool>,
    Path((_account_id, invitation_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<()> {
    AccountRepository::new(pool)
        // #148 — `AuditActor::User`, not a bare id: the ledger row must record WHICH authority
        // revoked, and this route is the self-service surface. `revoked_by` is unchanged.
        .revoke_invitation(
            scope.account_id,
            invitation_id,
            AuditActor::User(scope.actor_user_id),
        )
        .await
        .map_err(e)?;
    Ok((StatusCode::NO_CONTENT, ()))
}

// ===================== #146 — invitation ACCEPT (the redemption half) =====================

/// `POST /api/account-invitations/accept` (#146) — redeem an invitation token.
///
/// **Authenticated, NOT account-scoped, and NOT permission-gated.** The redeemer is by
/// definition not yet a member, so `AccountScope` cannot gate them — it 404s a non-member by
/// design — and the TOKEN is the capability. See `accept::InvitationRedeemer` (#146 DEC-1)
/// for why no capability is checked either: gating redemption on `account::members::manage`
/// would let an operator turning self-service off strand every holder of a live token
/// OUTSIDE the account, which is #232's failure with no way back in.
///
/// The token arrives in the BODY. The route declares no path or query parameter, so there is
/// no other place it could arrive (INV-18).
///
/// All five ordered steps — lookup, email binding, the TOCTOU role re-check, the seat check
/// and the membership INSERT + `accepted_at` stamp — are `AccountRepository::accept_invitation`,
/// in one transaction. This handler performs NO authorization and NO validation of its own,
/// deliberately: everything that could refuse must refuse inside the transaction that writes,
/// or it is a check-then-act race.
///
/// Statuses: **201** on the join, **200** on the idempotent already-a-member path,
/// **404 `INVALID_INVITATION`** for every token miss (wrong / expired / used / revoked /
/// wrong recipient — byte-identical), **403 `ROLE_ABOVE_ACTOR`** when the inviter no longer
/// has the standing to confer the invitation's role, **422 `SEAT_LIMIT_REACHED`** when the
/// plan's seats are full, **422 `PERSONAL_ACCOUNT_NOT_MANAGEABLE`** for a personal account.
pub async fn accept_invitation(
    redeemer: InvitationRedeemer,
    Extension(pool): Extension<SqlitePool>,
    origin: SyncOrigin,
    Json(body): Json<AcceptInvitationRequest>,
) -> ApiResult<Json<AcceptInvitationResponse>> {
    let accepted = AccountRepository::new(pool.clone())
        .accept_invitation(&body.token, redeemer.user_id)
        .await
        .map_err(e)?;

    // AFTER the commit, never inside it: the audience read goes to the pool, and a frame
    // emitted for a transaction that then rolls back is a notification of something that
    // never happened. Mirrors `leave_account`.
    //
    // No frame on the idempotent path — nothing changed, and a `Create` frame for a
    // membership every device already knows about is noise the 60s sync re-check would only
    // have to reconcile.
    if !accepted.already_member {
        let actor = Actor::user(redeemer.user_id, origin.0);
        publish_account_member(&pool, accepted.account_id, SyncAction::Create, actor).await;
    }

    let status = if accepted.already_member {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((
        status,
        Json(AcceptInvitationResponse {
            account_id: accepted.account_id,
            role: accepted.role,
        }),
    ))
}
