//! `AccountScope<Min>` — the #139 ACCOUNT-SCOPED authorization seam (epic #138).
//!
//! `account::manage` answers *"may this principal manage accounts?"*. Self-service
//! needs *"may this principal manage **account X**?"* — an answer that varies per
//! `(principal, account)` and lives in `account_members.role`, a table
//! `principal_holds` never reads. Reusing the global key would mean any grant that
//! lets an owner manage their own account simultaneously lets them manage everyone's.
//!
//! So authorization here is **two-factor**, and the two factors' jobs must not be
//! merged:
//!
//! - **(a) the capability** `account::members::manage` — the operator kill switch and
//!   the codegen anchor. Granting/revoking it on the `Users` group turns self-service
//!   on/off deployment-wide, and it is what lands `Permissions.AccountMembersManage`
//!   in the generated FE enum. It carries **no** account identity and is **never**
//!   authority.
//! - **(b) the account role** — the authority. Resolved per-request from the
//!   membership table, therefore revocation-immediate (no token-revocation work: a
//!   removed member is refused on their very next request).
//!
//! Modelled on [`AdminAccountScope`](crate::modules::admin::AdminAccountScope), which
//! this codebase documents as **self-securing**: authz and resolution are bundled, so
//! the power is never reachable un-gated. Same discipline, **deliberately OPPOSITE
//! oracle semantics** — do not "fix" this into consistency with the admin path:
//!
//! | | admin surface | this surface |
//! |---|---|---|
//! | non-member / unauthorized | **403 before any lookup** (uniform — not an existence oracle) | **404 after the membership lookup** (byte-identical to a nonexistent id) |
//!
//! Both are correct for their caller. Platform staff may learn that an account
//! exists; a non-member must not.
//!
//! # Order of operations — this IS the specification, and it is SECURITY-CRITICAL
//!
//! 1. **Authenticate** via the app-installed `DefaultIdentityResolver` → **401**.
//! 2. **Capability** — `principal_holds(user, groups, "account::members::manage")` →
//!    **403 `ACCOUNT_MEMBERS_MANAGE_REQUIRED`**, **before any account lookup**, so a
//!    deployment with self-service off is not an existence oracle. **Conditional on
//!    [`MinAccountRole::REQUIRES_MANAGE_CAPABILITY`] since #142** — see
//!    [`SelfMembership`] and the "#232" section below. The const DEFAULTS to `true`,
//!    so every existing marker and every marker written without thinking about it is
//!    gated; the single exemption is `leave`.
//! 3. **Path `account_id`** — **400** malformed, **500** if the route omits the param
//!    (a wiring bug, never the client's fault). Keyed on the shared
//!    [`ACCOUNT_PATH_PARAM`] so route and extractor cannot drift.
//! 4. **Membership** — `AccountRepository::membership_role`; `None ⇒` **404**,
//!    byte-identical to a nonexistent account. **This is the cross-tenant guard**, and
//!    it is A1's own primitive, not a re-implementation.
//! 5. **Role floor** — `role.allows(Min::MIN)` false ⇒ **403
//!    `INSUFFICIENT_ACCOUNT_ROLE`**. 403 is right here and 404 is right at step 4: a
//!    bare member already knows the account exists, so 403 leaks nothing and is better
//!    UX; a non-member must not learn even that the id resolves.
//! 6. **Kind** — `account.kind == Personal ⇒` **422
//!    `PERSONAL_ACCOUNT_NOT_MANAGEABLE`**.
//!
//! Steps 4 → 5 → 6 must stay in that order. Moving the kind check ahead of the
//! membership check would turn it into an existence oracle for other users' personal
//! accounts.
//!
//! # Path, not header (DEC-1)
//!
//! `X-Account-Id` is the **ambient acting account** for resource attribution — the
//! frontend stamps it on *every* same-origin request via a global fetch/XHR
//! interceptor driven by the account switcher. It is ambient state, not a second
//! declaration of intent. For `/api/accounts/{account_id}/…` the **path is
//! authoritative and the header is IGNORED**: it is not parsed, not compared, and
//! `parse_account_header` is deliberately not imported here, so the property holds by
//! construction rather than by policy. Authorizing on one id while writing to the
//! other is a textbook confused deputy.
//!
//! # `leave` sits outside factor (a) — #232 / #142 DEC-3
//!
//! Step 2 was unconditional in #139, and that had a consequence #139 filed rather than
//! absorbed (**#232**): revoking `account::members::manage` to turn self-service OFF also
//! stopped every existing member LEAVING the account they were already in — they were
//! refused before the extractor ever read their membership row. An operator turning the
//! switch off is stopping *grants*; trapping current members inside a DEC-12 tenant-wide
//! grant they can no longer repudiate is not what they asked for, and platform staff
//! become the only exit — the dependency self-service exists to remove.
//!
//! #142 resolves it as #232's own option (ii): the omission lives in the marker's TYPE,
//! not in a handler author's memory. [`SelfMembership`] is the one marker that sets
//! `REQUIRES_MANAGE_CAPABILITY = false`, and exactly one route uses it.
//!
//! **Provenance, because this rewrites a decision recorded in a DEPENDENCY's header.**
//! #139's own DEC-12 records that "`leave`'s fix is a scope change to the floors table
//! that belongs to #142", and #232 names option (ii) — a marker-level omission — as the
//! remedy. #142's Routes table ("all on `AccountScope<Min>`") is satisfied literally:
//! `SelfMembership` IS a `Min`. So this is the delegated change landing where it was
//! delegated, not a dependent quietly re-deciding its dependency.
//!
//! **What the carve-out does NOT free, stated so nobody assumes otherwise.** A **sole
//! owner** in a self-service-off deployment is still stuck: `leave` refuses them with
//! `LAST_OWNER` (correctly — the account may not be left ownerless), and the only way
//! out, promoting a successor, is a management action that step 2 still gates. So the
//! carve-out frees every member who is NOT the last owner; for the last owner, platform
//! staff remain the exit. That residue is deliberate — appointing a successor really IS
//! managing other people's memberships, which is precisely what the operator switched
//! off — and it is pinned by a test arm rather than left to be rediscovered.
//!
//! **This does not weaken the seam, and the reason is worth stating precisely.** The
//! carve-out drops factor **(a)** only. Factor **(b)** — the authority — runs in full:
//! steps 3-6 are unchanged, so the caller is still proven a member of THIS account
//! (404 otherwise), still graded against the floor, and still refused on a personal
//! account. The `leave` route takes no target user, so "leave someone else" is not
//! expressible; the only reachable effect is to REDUCE the actor's own standing, and
//! even that is subject to the untouched `LAST_OWNER` guard. The escalation surface of
//! the exemption is empty.
//!
//! # What this extractor deliberately does NOT check
//!
//! **`accounts.admin_suspended` is not consulted here — see #235.** That column is
//! enforced in exactly one place today (`billing::quota`, for metered consumption), by
//! neither this extractor nor `ActiveAccount`. So a suspended account's owners can
//! still reach every route mounted on this seam. That is a PRE-EXISTING gap rather
//! than something this seam introduces, and the correct semantics are a real decision
//! (should a suspension block `leave`? the read surfaces? the admin path?) — so it is
//! filed rather than guessed. **Downstream items mounting on `AccountScope` must not
//! assume suspension is handled here.**
//!
//! **#145 widened the reach of that gap and is recording it rather than absorbing it.**
//! Invitations mount here too, so a suspended organization's admins can now also create,
//! resend and revoke invitations — and, once #146 lands, have them redeemed into
//! memberships. The change in KIND matters as much as the change in reach: until now every
//! route behind this extractor only RESHUFFLED existing membership. Invitations are the
//! first that MINT a bearer credential which redeems, days later and out of band, into a
//! new tenant-wide DEC-12 grant. An operator suspending an account to contain an incident
//! does not stop its admins issuing fresh 7-day tokens, and does not invalidate the ones
//! already issued. Under DEC-12 that is a suspended tenant continuing to hand out at least
//! Viewer over everything it holds, and an `owner` invitation hands out delete authority.
//! #145 did not add a check, for the same reason #139 did not: the semantics are #235's
//! to ratify, and guessing them here would be a silent behaviour change on a shipped
//! surface. If #235 decides suspension blocks GRANTING, the check belongs in this
//! extractor — one edit, and `create`/`resend` inherit it — but `revoke` and the
//! invitation READ must be EXEMPTED, or a suspended account's admins cannot even withdraw
//! outstanding invitations while the hold is in force, which is the trapped-member
//! failure [`SelfMembership`] already had to fix once (#232). Because this extractor
//! cannot express a per-route exemption today, that means either a fourth associated
//! const on [`MinAccountRole`] (`BLOCKED_BY_SUSPENSION`, defaulting to `true` by the same
//! forgetting-is-safe logic as [`MinAccountRole::REQUIRES_MANAGE_CAPABILITY`]) or a
//! repository guard on the two minting functions. If it also blocks REDEMPTION, that
//! lands in #146's accept transaction and must be re-read there rather than inherited
//! from mint time, since an account can be suspended after an invitation is issued —
//! and pending invitations should then survive the hold rather than be mass-revoked, or
//! a temporary operator action silently destroys state. Either way the refusal needs its
//! own code rather than a reuse of an existing 403: a client has to say something
//! different about it.
//!
//! # No admin bypass (DEC-4)
//!
//! There is **no** `is_admin` short-circuit in this file. A root admin clears step 2
//! (via `principal_holds`'s own short-circuit) and is then refused at step 4 like any
//! other non-member. Platform staff keep the parallel `/api/admin/accounts/*` surface,
//! whose different oracle semantics and audit stamping are deliberate. Two paths, two
//! oracles, one membership primitive.

use std::marker::PhantomData;
use std::sync::Arc;

use aide::OperationIo;
use axum::extract::{FromRequestParts, RawPathParams};
use axum::http::{request::Parts, StatusCode};
use sqlx::SqlitePool;
use uuid::Uuid;

use ziee_auth::auth::DefaultIdentityResolver;
use ziee_core::AppError;
use ziee_framework::permissions::IdentityResolver;

use crate::modules::permissions::{principal_holds, PermissionCheck};

use super::models::{Account, AccountKind, AccountRole};
use super::permissions::AccountMembersManage;
use super::repository::{AccountRepository, PERSONAL_ACCOUNT_NOT_MANAGEABLE};

/// The path parameter account-scoped routes declare and `AccountScope` keys on.
/// (The `admin` module that used to own this constant is gone — single-user app.)
pub const ACCOUNT_PATH_PARAM: &str = "account_id";

/// Refusal code for step 2 — the capability is absent (self-service is off for this
/// principal, or deployment-wide). Distinct from [`INSUFFICIENT_ACCOUNT_ROLE`]: this
/// one carries no account identity at all.
pub const ACCOUNT_MEMBERS_MANAGE_REQUIRED: &str = "ACCOUNT_MEMBERS_MANAGE_REQUIRED";

/// Refusal code for step 5 — the principal IS a member but ranks below the route's
/// floor. Deliberately distinguishable from a non-member's 404.
pub const INSUFFICIENT_ACCOUNT_ROLE: &str = "INSUFFICIENT_ACCOUNT_ROLE";

/// A compile-time minimum-role floor. Implemented by the marker types below and
/// supplied as `AccountScope<RoleAdmin>` in a handler signature.
///
/// A marker TYPE rather than a const-generic parameter because const generics cannot
/// (yet) be enums — the same reason `PermissionCheck` is a marker trait. The benefit
/// is that the floor is part of the handler's TYPE: a route cannot be mounted without
/// declaring one, so "forgot to check the role" is not expressible.
pub trait MinAccountRole {
    const MIN: AccountRole;

    /// Whether this route ALSO requires the `account::members::manage` capability —
    /// factor (a), the operator's kill switch (step 2 above).
    ///
    /// **Defaults to `true`, and that default is the safety property**: a marker added
    /// later that says nothing about this is GATED, so "forgot to think about it" can
    /// never mean "un-gated". The single `false` in the tree is [`SelfMembership`], for
    /// `leave` (#232 / #142 DEC-3) — see the module doc for why that exemption has an
    /// empty escalation surface.
    const REQUIRES_MANAGE_CAPABILITY: bool = true;
}

/// Floor: any member (`member`, `admin` or `owner`).
#[derive(Debug, Clone, Copy)]
pub struct RoleMember;
impl MinAccountRole for RoleMember {
    const MIN: AccountRole = AccountRole::Member;
}

/// Floor: `admin` or `owner`. The floor every membership mutation and invitation
/// route in this epic uses (#139's role-floor table).
#[derive(Debug, Clone, Copy)]
pub struct RoleAdmin;
impl MinAccountRole for RoleAdmin {
    const MIN: AccountRole = AccountRole::Admin;
}

/// Floor: `owner` only (ownership transfer).
#[derive(Debug, Clone, Copy)]
pub struct RoleOwner;
impl MinAccountRole for RoleOwner {
    const MIN: AccountRole = AccountRole::Owner;
}

/// Floor: any member — **and the ONE marker that does not require
/// `account::members::manage`** (#232, #142 DEC-3).
///
/// Used by exactly one route: `POST /api/accounts/{account_id}/members/leave`. Ending
/// your OWN membership is not "managing the members of accounts you administer", which
/// is what factor (a) gates; the authority it needs is factor (b) alone, and that still
/// runs in full (steps 3-6). Deliberately a SEPARATE type from [`RoleMember`] rather
/// than a flag on it, so a route that wants the ordinary member floor cannot acquire the
/// exemption by accident — and so `grep SelfMembership` enumerates every un-gated route
/// in the tree.
///
/// Do not reach for this for a route that READS or WRITES anything other than the
/// caller's own membership row. If a second route ever needs it, that is a decision to
/// re-make, not a precedent to follow.
#[derive(Debug, Clone, Copy)]
pub struct SelfMembership;
impl MinAccountRole for SelfMembership {
    const MIN: AccountRole = AccountRole::Member;
    const REQUIRES_MANAGE_CAPABILITY: bool = false;
}

/// An account-scoped, membership-PROVEN view onto ONE account, for a caller proven to
/// hold `account::members::manage` AND to rank at or above `Min` in **that** account.
///
/// Taking this in a handler signature is the whole authorization: every step above has
/// already run, so a handler cannot reach the account without them. `#[aide(input)]` so
/// it is transparent to the OpenAPI schema (a request-context extractor, not a body).
#[derive(Debug, Clone, OperationIo)]
#[aide(input)]
pub struct AccountScope<Min: MinAccountRole> {
    /// The PATH-scoped account id (proven to exist AND to have the actor as a member).
    pub account_id: Uuid,
    /// The resolved account row — handed to the handler so it need not re-read.
    pub account: Account,
    /// The authenticated caller's user id.
    pub actor_user_id: Uuid,
    /// The caller's REAL role in `account_id` — at or above `Min::MIN`. Downstream
    /// items grade against this for the role-escalation guard ("an Admin may not mint
    /// an Owner"), which needs the actor's own rank.
    pub actor_role: AccountRole,
    _min: PhantomData<Min>,
}

/// Pure resolver over `(name, value)` path pairs — robust to additional params on
/// nested routes (`/accounts/{account_id}/members/{user_id}`). Absent `account_id` ⇒
/// 500 (route wiring bug); malformed value ⇒ 400. Split out so it is unit-testable
/// without an axum request (`RawPathParams` has no public constructor) — mirrors
/// `admin/extractor.rs::resolve_account_id_param` exactly.
fn resolve_account_id_param<'a>(
    mut pairs: impl Iterator<Item = (&'a str, &'a str)>,
) -> Result<Uuid, AppError> {
    let raw = pairs
        .find(|(k, _)| *k == ACCOUNT_PATH_PARAM)
        .map(|(_, v)| v)
        .ok_or_else(|| {
            AppError::internal_error(format!(
                "account-scoped route is missing the `{ACCOUNT_PATH_PARAM}` path parameter"
            ))
        })?;
    Uuid::parse_str(raw.trim())
        .map_err(|_| AppError::bad_request("INVALID_ACCOUNT_ID", "account_id must be a UUID"))
}

impl<Min> FromRequestParts<()> for AccountScope<Min>
where
    Min: MinAccountRole + Send + Sync + 'static,
{
    type Rejection = (StatusCode, AppError);

    fn from_request_parts(
        parts: &mut Parts,
        _state: &(),
    ) -> impl std::future::Future<Output = Result<Self, Self::Rejection>> + Send {
        async move {
            // Same app-installed resolver `RequirePermissions` / `ActiveAccount` /
            // `AdminAccountScope` use. A missing resolver is a server misconfig ⇒ 500.
            let resolver = parts
                .extensions
                .get::<Arc<DefaultIdentityResolver>>()
                .cloned()
                .ok_or_else(|| {
                    AppError::internal_error("Identity resolver not configured").to_api_error()
                })?;

            // ── 1. authenticate (401 on any auth failure) ──
            let user = resolver.authenticate(parts).await?;

            // ── 2. capability, BEFORE any account lookup ──
            // Uniform 403 whether or not the account exists, so turning self-service
            // off does not hand out an existence oracle. This is factor (a): the
            // operator kill switch. It is NOT authority — step 4 is.
            //
            // Skipped ONLY for `Min::REQUIRES_MANAGE_CAPABILITY == false`, i.e. only for
            // `SelfMembership` / `leave` (#232, #142 DEC-3). The const defaults to
            // `true`, so this branch is taken by every other marker. `load_groups` is
            // inside the branch because it exists solely to answer this question.
            if Min::REQUIRES_MANAGE_CAPABILITY {
                let groups = resolver.load_groups(&user).await?;
                if !principal_holds(&user, &groups, AccountMembersManage::PERMISSION) {
                    return Err(AppError::forbidden(
                        ACCOUNT_MEMBERS_MANAGE_REQUIRED,
                        "Managing account members requires the account::members::manage permission",
                    )
                    .to_api_error());
                }
            }

            // ── 3. read the PATH account id (400 malformed / 500 wiring bug) ──
            // The `X-Account-Id` header is NOT consulted (DEC-1).
            let params = RawPathParams::from_request_parts(parts, &())
                .await
                .map_err(|rej| {
                    AppError::internal_error(format!("account-scoped route path params: {rej}"))
                        .to_api_error()
                })?;
            let account_id =
                resolve_account_id_param(params.iter()).map_err(|e| e.to_api_error())?;

            let pool = parts
                .extensions
                .get::<SqlitePool>()
                .cloned()
                .ok_or_else(|| AppError::internal_error("pool not configured").to_api_error())?;
            let repo = AccountRepository::new(pool);

            // ── 4. membership — THE CROSS-TENANT GUARD ──
            // `None` covers BOTH "no such account" and "not a member", and both map to
            // the same 404, so the two are indistinguishable by construction rather
            // than by matching response bodies. Factor (b): the authority.
            let actor_role = repo
                .membership_role(account_id, user.id)
                .await
                .map_err(|e| e.to_api_error())?
                .ok_or_else(|| AppError::not_found("Account").to_api_error())?;

            // ── 5. role floor ──
            // 403 (not 404) is correct: the caller is a proven member, so they already
            // know the account exists and nothing is leaked by naming the refusal.
            if !actor_role.allows(Min::MIN) {
                return Err(AppError::forbidden(
                    INSUFFICIENT_ACCOUNT_ROLE,
                    format!(
                        "this operation requires account role `{}` or higher; you are `{}`",
                        Min::MIN.as_str(),
                        actor_role.as_str()
                    ),
                )
                .to_api_error());
            }

            // ── 6. kind ──
            // Runs AFTER membership (step 4) on purpose: a non-member of someone
            // else's personal account must get 404, never 422, or this check becomes
            // an existence oracle.
            //
            // This is a SECOND enforcement point, and it is deliberate (DEC-5) — it is
            // NOT redundant with `AccountRepository::refuse_if_personal`, and neither
            // may be deleted in favour of the other:
            //   * `refuse_if_personal` sits in the repository so it covers EVERY
            //     caller — the admin surface and any future third caller that forgets
            //     (that placement is #144's fix and has a test pinning it).
            //   * this check covers every `AccountScope` route including READ-ONLY
            //     ones, which never reach a mutating repository function at all.
            // Removing this one would let an account-scoped read succeed against a
            // personal account; removing that one would re-open #144.
            let account = repo
                .get(account_id)
                .await
                .map_err(|e| e.to_api_error())?
                .ok_or_else(|| AppError::not_found("Account").to_api_error())?;
            if account.kind == AccountKind::Personal {
                return Err(AppError::unprocessable_entity(
                    PERSONAL_ACCOUNT_NOT_MANAGEABLE,
                    "a personal account's membership cannot be managed — it has exactly one \
                     member, its owner",
                )
                .to_api_error());
            }

            Ok(AccountScope {
                account_id,
                account,
                actor_user_id: user.id,
                actor_role,
                _min: PhantomData,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1 [covers: ITEM-1, ITEM-9] — the `MinAccountRole` floor truth table, all
    // NINE cells of {owner,admin,member} actor × {owner,admin,member} floor.
    //
    // Graded through the MARKER TYPES (`RoleOwner::MIN` etc.), not through
    // `AccountRole` directly, so a marker wired to the wrong constant is caught here
    // rather than hidden behind a correct `allows`. A mutation swapping RoleAdmin::MIN
    // to Member turns the (member, RoleAdmin) cell true and this goes RED.
    #[test]
    fn min_account_role_floor_truth_table() {
        let owner = AccountRole::Owner;
        let admin = AccountRole::Admin;
        let member = AccountRole::Member;

        // owner clears every floor.
        assert!(owner.allows(RoleOwner::MIN), "owner clears the owner floor");
        assert!(owner.allows(RoleAdmin::MIN), "owner clears the admin floor");
        assert!(owner.allows(RoleMember::MIN), "owner clears the member floor");

        // admin clears admin + member, but NOT owner.
        assert!(
            !admin.allows(RoleOwner::MIN),
            "an admin must NOT clear the owner floor — this is the escalation guard's \
             foundation (#150 INV-5)"
        );
        assert!(admin.allows(RoleAdmin::MIN), "admin clears the admin floor");
        assert!(admin.allows(RoleMember::MIN), "admin clears the member floor");

        // member clears only the member floor.
        assert!(!member.allows(RoleOwner::MIN), "member must NOT clear owner");
        assert!(!member.allows(RoleAdmin::MIN), "member must NOT clear admin");
        assert!(member.allows(RoleMember::MIN), "member clears the member floor");

        // The markers carry the constants they claim to (guards a mis-wired marker
        // even if `allows` were correct).
        assert_eq!(RoleOwner::MIN, AccountRole::Owner);
        assert_eq!(RoleAdmin::MIN, AccountRole::Admin);
        assert_eq!(RoleMember::MIN, AccountRole::Member);
    }

    // TEST-2 [covers: ITEM-4, ITEM-9] — the pure path-param resolver. Mirrors
    // `admin/extractor.rs`'s three tests: a well-formed id resolves, a nested route's
    // extra params do not confuse the lookup, an ABSENT param is a 500 (route wiring
    // bug — never the client's fault) and a malformed one is a 400. Never a panic,
    // never a silent fallthrough that could widen the scope.
    #[test]
    fn resolve_picks_account_id_ignoring_other_params() {
        let id = Uuid::new_v4();
        let ids = id.to_string();
        let pairs = [("user_id", "x"), (ACCOUNT_PATH_PARAM, ids.as_str())];
        assert_eq!(
            resolve_account_id_param(pairs.iter().map(|(k, v)| (*k, *v))).unwrap(),
            id
        );
    }

    #[test]
    fn resolve_absent_account_id_is_500() {
        let pairs = [("user_id", "x")];
        let err = resolve_account_id_param(pairs.iter().map(|(k, v)| (*k, *v))).unwrap_err();
        assert_eq!(err.status_code(), 500);
    }

    // TEST-2 [covers: ITEM-5, ITEM-12] (#142) — the capability-knob truth table.
    //
    // Three claims, and the THIRD is the one that makes the knob safe:
    //   1. every pre-#142 marker still requires factor (a);
    //   2. `SelfMembership` does not, and sits at the `member` floor;
    //   3. the trait DEFAULT is `true`, proven by a marker declared right here that
    //      specifies only `MIN` — so a future marker whose author never thought about
    //      the capability is GATED, never un-gated.
    //
    // A mutation flipping `SelfMembership::REQUIRES_MANAGE_CAPABILITY` back to `true`
    // fails claim 2; one flipping the trait default to `false` fails claims 1 and 3.
    #[test]
    fn manage_capability_requirement_truth_table() {
        assert!(RoleMember::REQUIRES_MANAGE_CAPABILITY);
        assert!(RoleAdmin::REQUIRES_MANAGE_CAPABILITY);
        assert!(RoleOwner::REQUIRES_MANAGE_CAPABILITY);

        assert!(
            !SelfMembership::REQUIRES_MANAGE_CAPABILITY,
            "#232 / #142 DEC-3: `leave` sits OUTSIDE the operator kill switch"
        );
        assert_eq!(
            SelfMembership::MIN,
            AccountRole::Member,
            "the carve-out drops factor (a) ONLY — the member floor still applies"
        );

        // A marker that says nothing inherits the SAFE answer.
        struct MarkerThatForgot;
        impl MinAccountRole for MarkerThatForgot {
            const MIN: AccountRole = AccountRole::Admin;
        }
        assert!(
            MarkerThatForgot::REQUIRES_MANAGE_CAPABILITY,
            "the trait default must be `true`, so forgetting means GATED"
        );
    }

    #[test]
    fn resolve_malformed_account_id_is_400() {
        let pairs = [(ACCOUNT_PATH_PARAM, "not-a-uuid")];
        let err = resolve_account_id_param(pairs.iter().map(|(k, v)| (*k, *v))).unwrap_err();
        assert_eq!(err.status_code(), 400);
    }
}
