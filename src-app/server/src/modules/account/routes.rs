//! A4 ITEM-2 — account HTTP routes (aide-documented so they appear in the OpenAPI
//! spec). `.id("Account.*")` drives `ApiClient.Account.*` + the `ApiEndpoints`
//! codegen. Re-run `just openapi-regen` after any change here.

use aide::axum::routing::{delete_with, get_with, post_with};
use aide::axum::ApiRouter;
use aide::transform::TransformOperation;
use axum::Json;

use crate::modules::permissions::with_permission;

use super::handlers::*;
use super::models::{
    AcceptInvitationResponse, Account, AccountListResponse, AccountMember,
    AccountMemberEventsResponse, AccountMembersManageContext, AccountMembersResponse,
    CreateInvitationResponse, InvitationsListResponse, ResendInvitationResponse,
};
use super::permissions::{AccountManage, AccountMembersManage, AccountRead};

/// The DEC-12 consent consequence, stated VERBATIM from the design (#140's option (a),
/// `docs/design/membership-rescope.md` §2.1 / the research doc §3 D-1) and reused by
/// every self-service membership route's description.
///
/// #140 closed with this obligation unstated and the re-scope had to re-file it as a
/// transfer of obligation into #142 (the OpenAPI text) and #149 (the role-select helper
/// text). It is a `const` so the three descriptions cannot drift apart, and TEST-8
/// asserts it survives into the SHIPPED `openapi.json` — prose is exactly what rots when
/// a later `.description(…)` is rewritten.
const DEC12_CONSENT: &str = "Account membership is an implicit grant: a `member` holds at \
     least Viewer on EVERY project, dataset and artifact in the account, an `admin` holds \
     Editor on all of them, and an `owner` holds Owner — including delete, transfer and \
     share — on projects they did not create. Adding, removing or re-roling a member \
     changes all of that in one call.";

pub fn account_routes() -> ApiRouter {
    ApiRouter::new()
        .api_route(
            "/accounts",
            get_with(list_accounts, list_accounts_docs)
                .post_with(create_organization, create_organization_docs),
        )
        .api_route(
            "/accounts/{id}/members",
            get_with(list_account_members, list_members_docs),
        )
        // #139 — the account-scoped proof route. NOTE the path param is
        // `{account_id}`, NOT the `{id}` the sibling route above uses: `AccountScope`
        // keys on the shared `admin::ACCOUNT_PATH_PARAM` ("account_id") so the route
        // declaration and the extractor cannot drift. A route that declares `{id}`
        // here would 500 on an absent param — loudly, by design. Every downstream
        // account-scoped route (#142/#145/#148) must likewise declare `{account_id}`.
        .api_route(
            "/accounts/{account_id}/members/manage-context",
            get_with(
                account_members_manage_context,
                members_manage_context_docs,
            ),
        )
        // #142 — the self-service member mutations. `{account_id}` (never `{id}`) for
        // the same reason as above: `AccountScope` keys on `admin::ACCOUNT_PATH_PARAM`.
        //
        // NOTE the route SHAPE: `…/members/leave` is a STATIC segment sibling of the
        // `{user_id}` param below it. matchit prefers the static, so `leave` can never
        // be swallowed as a user id — and a user id can never be "leave", since the
        // param is parsed as a `Uuid`. If matchit ever refused this shape it would panic
        // at router build, i.e. loudly, on the first request the server ever serves.
        .api_route(
            "/accounts/{account_id}/members/leave",
            post_with(leave_account, leave_account_docs),
        )
        // #148 — the membership audit ledger read. Another STATIC sibling of `{user_id}`,
        // for the same reason `leave` is one; `{account_id}` because `AccountScope` keys on
        // the shared `admin::ACCOUNT_PATH_PARAM`.
        .api_route(
            "/accounts/{account_id}/members/events",
            get_with(list_account_member_events, list_member_events_docs),
        )
        .api_route(
            "/accounts/{account_id}/members/{user_id}",
            delete_with(remove_member, remove_member_docs)
                .patch_with(set_member_role, set_member_role_docs),
        )
        // #145 — invitations. `{account_id}` for the same reason as every route above:
        // `AccountScope` keys on `admin::ACCOUNT_PATH_PARAM`, so a route declaring `{id}`
        // would 500 on an absent param.
        //
        // NOTE the accept route is deliberately NOT here and is NOT account-scoped: the
        // redeemer is by definition not yet a member, so `AccountScope` cannot gate them
        // and the TOKEN is the capability. It is #146's, at `POST
        // /api/account-invitations/accept`, with the token in the BODY.
        .api_route(
            "/accounts/{account_id}/invitations",
            post_with(create_invitation, create_invitation_docs)
                .get_with(list_invitations, list_invitations_docs),
        )
        .api_route(
            "/accounts/{account_id}/invitations/{invitation_id}/resend",
            post_with(resend_invitation, resend_invitation_docs),
        )
        .api_route(
            "/accounts/{account_id}/invitations/{invitation_id}",
            delete_with(revoke_invitation, revoke_invitation_docs),
        )
        // #146 — INVITATION ACCEPT. A TOP-LEVEL path, NOT under `/accounts/{account_id}/…`,
        // and deliberately so: the redeemer is by definition not yet a member, so
        // `AccountScope` cannot gate them (it 404s a non-member, which is exactly what an
        // invitee is) and the TOKEN is the capability. Its extractor authenticates and stops
        // there — no capability is checked (#146 DEC-1).
        //
        // The token is in the BODY. Not the path, not the query: a token in a URL leaks
        // through `Referer` headers, browser history, proxy access logs and screen shares,
        // and this route declares no parameter of any kind, so there is nowhere else it
        // could arrive.
        .api_route(
            "/account-invitations/accept",
            post_with(accept_invitation, accept_invitation_docs),
        )
}

// ─────────── #145 OBLIGATIONS CARRIED FORWARD (product tree, not `.lifecycle/`) ───────────
//
// Recorded HERE for the reason the #142 block below does: `.lifecycle/` artifacts are
// stripped at merge, and that is exactly how #140's consent obligation was lost the first
// time. Four things this item deliberately did not build, each with what the next owner
// needs:
//
//  1. **#146 (accept) — the TOCTOU role re-check.** The full rule, and the reason a
//     mint-time-role column is NOT needed, are written on
//     `AccountRepository::find_pending_invitation_by_token_hash`, which is the function
//     #146 starts from. **Use `AccountRepository::add_member_in_tx`, not `add_member`** —
//     the `_in_tx` form takes a REQUIRED `ActorCeiling` (so the ceiling cannot be omitted),
//     takes the account locks on YOUR connection (so it composes with your accept
//     transaction instead of deadlocking against it — the pool-owning wrapper waits on
//     locks your own transaction holds, and Postgres cannot see that cycle across two
//     sessions), calls `refuse_if_personal` itself (so the H-2 guard cannot be skipped by
//     going through the seam), and lets the membership INSERT roll back with your
//     `accepted_at` stamp, which is what #146's INV-17 requires.
//  2. **#148 (audit ledger) — four invitation actions.** `invited` (create),
//     `invite_resent` (resend), `invite_revoked` (revoke) and `invite_expired` for the
//     supersede-on-re-invite transition #145 DEC-4 introduces (distinguishable from a
//     human revoke by `expires_at <= revoked_at`). Each repository function already opens
//     the transaction the row must be written on, and the exact spot is commented in
//     situ. The `ActorCeiling::PlatformStaff` caveat #142 filed applies here too: that
//     variant carries no actor id.
//  3. **#149 (frontend) — the copy-link flow is create → list → resend → copy**, not
//     create → copy. The create response deliberately carries no link (returning one only
//     when a row was created would itself be the enumeration oracle), and the token is
//     stored only as a SHA-256, so the server cannot reproduce a link it already handed
//     out. `POST …/invitations/{id}/resend` mints a fresh one; put it in the invite URL's
//     FRAGMENT (`/invite#<token>`), never its path or query. The DEC-12 consent sentence
//     (`DEC12_CONSENT` below) is owed verbatim in the invite confirm dialog — that is the
//     third of #140's transferred obligation; the OpenAPI third is discharged on
//     `create_invitation_docs`.
//     The UI must say "invitation sent" in EVERY case, including the two the server
//     treats as no-ops, or the frontend re-opens the oracle the backend closed.
//  4. **`SyncEntity::AccountInvitation` does not exist**, so no invitation change fans a
//     sync frame today: a second admin's open tab will not see a new invitation until it
//     refetches. Adding the variant now, with #149's surface not yet built, would be a
//     seam with no consumer. #149 should add it (and the `publish_account_invitation`
//     helper next to `publish_account_member`) when it builds the list that would consume
//     it.
// ────────────────────────────────────────────────────────────────────────────────────────

/// What accepting an invitation actually grants, stated plainly — required by issue #145's
/// Acceptance list ("the OpenAPI description states plainly what accepting grants, per the
/// #140 decision").
///
/// Separate from [`DEC12_CONSENT`] and used ALONGSIDE it rather than instead of it: that
/// const states what a membership grants, in the words #140 ratified and which the invite
/// dialog and the role-select helper must reuse verbatim; this sentence states the thing a
/// reader of an INVITATION route needs additionally, which is that the grant lands at
/// redemption and is not revocable by un-sending a link.
const INVITE_GRANT_NOTE: &str = "Accepting this invitation creates an account membership \
     at the stated role. The role is FROZEN at issue — it is exactly what the invitee \
     will receive, and it is never silently re-interpreted. Revoking the invitation \
     before it is accepted withdraws the offer; it cannot withdraw a membership already \
     created (remove the member instead). NOTE the redemption endpoint is NOT part of \
     this release: until it ships, an invitation can be created, listed, resent and \
     revoked, but not accepted.";

fn create_invitation_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountMembersManage,)>(op)
        .description(&format!(
            "Invite an email address to an account you administer. Requires \
             account::members::manage AND account role `admin` or higher in THIS account; a \
             non-member gets 404 (never 403), identical to a nonexistent account id. \
             ENUMERATION SAFETY — THIS IS A CONTRACT, NOT AN IMPLEMENTATION DETAIL. This \
             endpoint returns 202 with the body {{\"status\":\"sent\"}} and nothing else, \
             IDENTICALLY, in all four cases: the address belongs to no user; it belongs to a \
             user; it belongs to a user who is ALREADY A MEMBER of this account; a live \
             invitation for it already exists (idempotent — the existing token stands). The \
             last two are server-side no-ops. Do not add a distinguishing status or code for \
             them: `409 ALREADY_A_MEMBER` would tell the caller both that the address is \
             registered and that it is in this account, which is exactly the \
             account-enumeration oracle invitations exist to avoid. THE INVITE LINK IS NOT IN \
             THIS RESPONSE, deliberately — returning it only when a new invitation was \
             created would itself be the oracle. The token is stored only as a SHA-256, so it \
             cannot be re-derived later either: list the account's pending invitations with \
             GET /accounts/{{account_id}}/invitations and mint a link with POST \
             /accounts/{{account_id}}/invitations/{{invitation_id}}/resend. Put that token in \
             the FRAGMENT of your invite URL (`/invite#<token>`), never in a path or query — \
             a token in a URL leaks through Referer headers, browser history, proxy access \
             logs and screen shares. ROLE CEILING: the role you request must be at or below \
             your own role in this account — 403 `ROLE_ABOVE_ACTOR` otherwise, and no \
             invitation is written. An admin may invite an `admin` or a `member`, but may not \
             invite an `owner`. {INVITE_GRANT_NOTE} {DEC12_CONSENT}"
        ))
        .id("Account.createInvitation")
        .tag("account")
        .response::<202, Json<CreateInvitationResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description(
                "`INVALID_ACCOUNT_ID` — the path account_id is not a UUID; or \
                 `INVALID_EMAIL` — after trimming, the address is empty, is longer than \
                 254 bytes, is not of the form `local@domain.tld`, or contains anything \
                 that is not printable ASCII. That last rule is deliberate and is broader \
                 than it looks: the address is stored verbatim and will one day be placed \
                 in a mail header (so control characters must never reach the table), and \
                 an invisible character would make a second, distinct invitation for what \
                 a human reads as one address. It also means INTERNATIONALIZED addresses \
                 (SMTPUTF8 local parts, IDN domains) are refused; there is no mail \
                 transport in this product yet, and the right way to support them later \
                 is to normalize to the ASCII form at the boundary",
            )
        })
        .response_with::<401, (), _>(|r| {
            r.description("Not authenticated (`AccountScope` step 1)")
        })
        .response_with::<403, (), _>(|r| {
            r.description(
                "`ACCOUNT_MEMBERS_MANAGE_REQUIRED` — self-service membership is off for you; \
                 `INSUFFICIENT_ACCOUNT_ROLE` — you are a member but rank below `admin` here; \
                 `ROLE_ABOVE_ACTOR` — the role you asked for is above your own. Distinguish \
                 by the error CODE. NOTE none of these depends on the email address you \
                 supplied",
            )
        })
        .response_with::<404, (), _>(|r| {
            r.description(
                "You are not a member of this account, or it does not exist — the two are \
                 deliberately INDISTINGUISHABLE",
            )
        })
        .response_with::<422, (), _>(|r| {
            r.description(
                "`PERSONAL_ACCOUNT_NOT_MANAGEABLE` — a personal account has exactly one \
                 member, its owner, and cannot be invited into",
            )
        })
        .response_with::<429, (), _>(|r| {
            r.description(
                "`INVITATION_RATE_LIMITED` — you, or this account, have created too many \
                 invitations recently. The message names which window tripped; it never names \
                 the address",
            )
        })
}

fn list_invitations_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountMembersManage,)>(op)
        .description(
            "List the PENDING invitations of an account you administer (paged, newest first; \
             accepted, revoked and expired invitations are not listed). Requires \
             account::members::manage AND account role `admin` or higher in THIS account; a \
             non-member gets 404 (never 403). An inviter reading their own account's \
             invitations is not enumeration, which is why this is an ordinary read. What it \
             does NOT return is anything user-shaped: there is no user_id, no username, no \
             display name and no `registered` flag, so this response cannot be used to \
             discover whether a pending invitee has an account. It also returns no invite \
             link — see POST /accounts/{account_id}/invitations/{invitation_id}/resend.",
        )
        .id("Account.listInvitations")
        .tag("account")
        .response::<200, Json<InvitationsListResponse>>()
        .response_with::<401, (), _>(|r| {
            r.description("Not authenticated (`AccountScope` step 1)")
        })
        .response_with::<403, (), _>(|r| {
            r.description(
                "`ACCOUNT_MEMBERS_MANAGE_REQUIRED` or `INSUFFICIENT_ACCOUNT_ROLE` — \
                 distinguish by the error CODE",
            )
        })
        .response_with::<404, (), _>(|r| {
            r.description(
                "You are not a member of this account, or it does not exist —                  INDISTINGUISHABLE",
            )
        })
}

fn resend_invitation_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountMembersManage,)>(op)
        .description(
            "Mint a FRESH token for a pending invitation and return it, pushing out the \
             expiry. This is how you obtain an invite link: the token is stored only as a \
             SHA-256, so the server cannot reproduce a link it has already handed out, and \
             the create response deliberately carries none. Resending INVALIDATES the \
             previous token — any link already circulated stops working. Put the returned \
             token in the FRAGMENT of your invite URL (`/invite#<token>`), never in a path or \
             query string: fragments are never sent to a server, so the token stays out of \
             Referer headers, proxy access logs and browser history. Requires \
             account::members::manage AND account role `admin` or higher in THIS account. \
             Keyed on the invitation id within THIS account, so an invitation belonging to \
             another account, an unknown id, and an already-accepted, revoked or expired \
             invitation are all the same 404. ROLE CEILING: the invitation's frozen role must \
             be at or below your own — 403 `ROLE_ABOVE_ACTOR` otherwise, so an admin cannot \
             refresh an `owner` invitation issued by someone who outranked them. (Revoking \
             one is deliberately NOT gated that way: revoking removes no role.)",
        )
        .id("Account.resendInvitation")
        .tag("account")
        .response::<200, Json<ResendInvitationResponse>>()
        .response_with::<400, (), _>(|r| {
            r.description(
                "`INVALID_ACCOUNT_ID` — the path account_id is not a UUID. NOTE a malformed \
                 invitation_id is rejected by the framework's own path extractor and returns \
                 a 400 with a PLAIN-TEXT body carrying no error code",
            )
        })
        .response_with::<401, (), _>(|r| {
            r.description("Not authenticated (`AccountScope` step 1)")
        })
        .response_with::<403, (), _>(|r| {
            r.description(
                "`ACCOUNT_MEMBERS_MANAGE_REQUIRED`, `INSUFFICIENT_ACCOUNT_ROLE`, or \
                 `ROLE_ABOVE_ACTOR` — distinguish by the error CODE",
            )
        })
        .response_with::<404, (), _>(|r| {
            r.description(
                "You are not a member of this account, or it does not exist; or the \
                 invitation does not exist, belongs to another account, or is no longer \
                 pending. All INDISTINGUISHABLE, deliberately",
            )
        })
        .response_with::<422, (), _>(|r| {
            r.description("`PERSONAL_ACCOUNT_NOT_MANAGEABLE`")
        })
        .response_with::<429, (), _>(|r| {
            r.description(
                "`INVITATION_RATE_LIMITED` — a resend MINTS a token, so it records one \
                 mint exactly as a create does and is counted by the same per-actor and \
                 per-account windows, one for one, with no exemption for the first \
                 resend. NOTE the ceilings are expressed in MINTS: because the create \
                 response carries no link, one usable invitation costs one create plus \
                 one resend, so the reachable rate of usable invitations is about half \
                 the stated ceiling",
            )
        })
}

fn revoke_invitation_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountMembersManage,)>(op)
        .description(
            "Revoke a pending invitation. SOFT: the row is stamped `revoked_at`/ `revoked_by` \
             and kept, never deleted, so the audit trail survives. Afterwards the token stops \
             resolving and the address may be invited afresh. Requires \
             account::members::manage AND account role `admin` or higher in THIS account. \
             Keyed on the invitation id within THIS account, so a foreign, unknown or \
             already-settled id is the same 404 — a second revoke included. There is \
             deliberately NO role ceiling on revoke, unlike create and resend: revoking \
             removes no role (the invitee holds nothing yet), so there is no standing to be \
             above, and gating it would stop a lower-ranked admin cleaning up an `owner` \
             invitation someone else left behind. Revoking withdraws the OFFER. It cannot \
             withdraw a membership already created by an acceptance — remove the member \
             instead (DELETE /accounts/{account_id}/members/{user_id}).",
        )
        .id("Account.revokeInvitation")
        .tag("account")
        .response::<204, ()>()
        .response_with::<400, (), _>(|r| {
            r.description("`INVALID_ACCOUNT_ID` — the path account_id is not a UUID")
        })
        .response_with::<401, (), _>(|r| {
            r.description("Not authenticated (`AccountScope` step 1)")
        })
        .response_with::<403, (), _>(|r| {
            r.description(
                "`ACCOUNT_MEMBERS_MANAGE_REQUIRED` or `INSUFFICIENT_ACCOUNT_ROLE`",
            )
        })
        .response_with::<404, (), _>(|r| {
            r.description(
                "You are not a member of this account, or it does not exist; or the \
                 invitation does not exist, belongs to another account, or is already \
                 SETTLED (accepted, or already revoked). All INDISTINGUISHABLE. NOTE an \
                 EXPIRED but unsettled invitation is NOT in this set — it revokes with a \
                 204, which makes revoke the one route on which \"an expired invitation \
                 with this id exists here\" differs from \"no such id\". That is not an \
                 oracle (reaching either requires being an admin of the account, who can \
                 already list its invitations) but it is a difference, and it is a \
                 decision rather than a surprise",
            )
        })
        .response_with::<422, (), _>(|r| {
            r.description("`PERSONAL_ACCOUNT_NOT_MANAGEABLE`")
        })
}

// ─────────────────── OBLIGATIONS CARRIED FORWARD TO #149 (the UI) ───────────────────
//
// Recorded HERE, in the product tree, and not only in this branch's `.lifecycle/`
// artifacts — which are stripped at merge. That is exactly how #140 lost this obligation
// the first time, and how `docs/design/membership-rescope.md` §2.1 came to describe its
// closure as "not a discharge, it is a transfer of obligation".
//
//  1. **The DEC-12 consent copy in the ROLE-SELECT helper text.** #140's option (a) was
//     accepted on condition the consequence is "stated verbatim in the invite confirm
//     dialog, the role-select helper text, and the OpenAPI descriptions of the membership
//     routes." The OpenAPI third is DONE — it is `DEC12_CONSENT` below, and a test asserts
//     it survives into the generated spec. The role-select third belongs to #149 and the
//     invite-dialog third to #145. Use `DEC12_CONSENT`'s wording.
//  2. **The two-call Transfer-ownership affordance** (#142 R-4): promote the target to
//     `owner`, then demote yourself, behind ONE confirm dialog. Users left to invent the
//     order try demote-then-promote, which `LAST_OWNER` correctly refuses and which reads
//     as a bug. The order is documented on the PATCH operation below.
//  3. **A write affordance needs the per-account ROLE, not just the permission.**
//     `usePermission` answers the global half only; `Account.membersManageContext`
//     returns `actor_role` for the other half — except for Leave, see `leave_account_docs`.
//  4. **Leave must echo exactly TWO entities locally: `account_member` and `account`.**
//     `notify_departed_member` stamps `origin` on the leaver's own frames (they acted), so
//     per `core/sync/localEcho.ts` the acting tab is deliberately NOT told over the wire
//     and must echo locally instead. Echoing only the first leaves the departed account
//     sitting in that tab's switcher until a reload — the exact symptom
//     `notify_departed_member` was written to remove.
//     **Two, not three:** the `project_transfer` frames this route also fans are
//     deliberately NOT `origin`-stamped, so they arrive over the wire like any other and
//     must NOT be echoed. A revision of this branch briefly stamped them and thereby
//     deleted the only notification the acting client had for a side effect it does not
//     model; see `handlers.rs::fan_cancelled_transfers`.
//
// One obligation deliberately does NOT extend to `leave`: the DEC-12 consent copy.
// `DEC12_CONSENT` states what a membership GRANTS, and leaving relinquishes rather than
// grants it, so the sentence would be noise on that route. The consent obligation covers
// the routes that create or widen a grant; recorded here so the omission is a decision
// rather than an oversight.
// ────────────────────────────────────────────────────────────────────────────────────
fn set_member_role_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountMembersManage,)>(op)
        .description(&format!(
            "Change a member's coarse account role (owner/admin/member) on an account you \
             administer. Requires account::members::manage AND account role `admin` or \
             higher in THIS account; a non-member gets 404 (never 403), identical to a \
             nonexistent account id. \
             \
             ROLE ESCALATION: both the target's CURRENT role and the role you REQUEST \
             must be at or below your own — 403 `ROLE_ABOVE_ACTOR` otherwise. An admin \
             may promote a member to admin, but may not mint an owner, may not demote an \
             owner, and may not raise anyone (including themselves) above their own role. \
             \
             TRANSFER OWNERSHIP has no separate endpoint: as an owner, promote the target \
             to `owner` with this route, then demote yourself to `admin`. The intermediate \
             two-owner state is legitimate and expected. The other order — demote yourself \
             first — is correctly refused with 422 `LAST_OWNER`, because an account must \
             keep at least one owner. \
             \
             {DEC12_CONSENT}"
        ))
        .id("Account.setMemberRole")
        .tag("account")
        .response::<200, Json<AccountMember>>()
        .response_with::<400, (), _>(|r| {
            r.description(
                "`INVALID_ACCOUNT_ID` — the path account_id is not a UUID. NOTE: a \
                 malformed `user_id` is rejected by the framework's own path extractor \
                 and returns a 400 with a PLAIN-TEXT body carrying no error code",
            )
        })
        .response_with::<401, (), _>(|r| {
            r.description("Not authenticated (`AccountScope` step 1)")
        })
        .response_with::<404, (), _>(|r| {
            r.description(
                "You are not a member of this account, or it does not exist — the two are \
                 deliberately INDISTINGUISHABLE; or the TARGET user is not a member of it \
                 (`Membership not found`)",
            )
        })
        .response_with::<403, (), _>(|r| {
            r.description(
                "`ACCOUNT_MEMBERS_MANAGE_REQUIRED` — self-service membership is off for \
                 you; `INSUFFICIENT_ACCOUNT_ROLE` — you are a member but rank below \
                 `admin` here; `ROLE_ABOVE_ACTOR` — the target's current role, or the role \
                 you asked for, is above your own. Distinguish by the error CODE",
            )
        })
        .response_with::<422, (), _>(|r| {
            r.description(
                "`LAST_OWNER` — an account must keep at least one owner; or \
                 `PERSONAL_ACCOUNT_NOT_MANAGEABLE` — a personal account's membership \
                 cannot be modified. Distinguish by the error CODE, not the status",
            )
        })
}

fn remove_member_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountMembersManage,)>(op)
        .description(&format!(
            "Remove a member from an account you administer. Requires \
             account::members::manage AND account role `admin` or higher in THIS account; \
             a non-member gets 404 (never 403), identical to a nonexistent account id. \
             \
             ROLE ESCALATION: the target's role must be at or below your own — 403 \
             `ROLE_ABOVE_ACTOR` otherwise, so an admin cannot evict an owner. Refuses \
             (422 `LAST_OWNER`) to remove the sole remaining owner. Removal also cancels \
             every still-pending project transfer the departing member is a party to on \
             this account's projects, in the same transaction. \
             \
             To remove YOURSELF, prefer POST /accounts/{{account_id}}/members/leave — it \
             needs no management capability. \
             \
             {DEC12_CONSENT}"
        ))
        .id("Account.removeMember")
        .tag("account")
        .response::<204, ()>()
        .response_with::<400, (), _>(|r| {
            r.description(
                "`INVALID_ACCOUNT_ID` — the path account_id is not a UUID. NOTE: a \
                 malformed `user_id` is rejected by the framework's own path extractor \
                 and returns a 400 with a PLAIN-TEXT body carrying no error code",
            )
        })
        .response_with::<401, (), _>(|r| {
            r.description("Not authenticated (`AccountScope` step 1)")
        })
        .response_with::<404, (), _>(|r| {
            r.description(
                "You are not a member of this account, or it does not exist — the two are \
                 deliberately INDISTINGUISHABLE; or the TARGET user is not a member of it \
                 (`Membership not found`)",
            )
        })
        .response_with::<403, (), _>(|r| {
            r.description(
                "`ACCOUNT_MEMBERS_MANAGE_REQUIRED`, `INSUFFICIENT_ACCOUNT_ROLE`, or \
                 `ROLE_ABOVE_ACTOR` — the target ranks above you. Distinguish by the \
                 error CODE",
            )
        })
        .response_with::<422, (), _>(|r| {
            r.description(
                "`LAST_OWNER` — an account must keep at least one owner; or \
                 `PERSONAL_ACCOUNT_NOT_MANAGEABLE` — a personal account's membership \
                 cannot be modified. Distinguish by the error CODE, not the status",
            )
        })
}

fn leave_account_docs(op: TransformOperation) -> TransformOperation {
    // DELIBERATELY NOT `with_permission::<(AccountMembersManage,)>` (#142 DEC-11).
    //
    // `with_permission` stamps `x-required-permissions`, which the control-MCP catalog
    // and the FE's `<Can>` / `defineAction({ permission })` gates read as authoritative.
    // Declaring the manage capability here would be FALSE after DEC-3 — and actively
    // harmful, because it would hide the Leave affordance from exactly the users the
    // #232 carve-out exists to serve. Declaring `account::read` instead would be equally
    // false: this route does not check it. A route whose authority is entirely
    // account-scoped honestly declares NO global permission, and says so in prose.
    // F-4 (audit round 1): `with_permission` stamps BOTH `x-required-permissions` and the
    // `bearerAuth` security requirement. Skipping it wholesale to avoid the false
    // permission claim also dropped the AUTH declaration, which put a state-destroying
    // route into the shipped spec's genuinely-public set (`/api/health`, `/api/auth/login`,
    // …) — a generated client or gateway that partitions on `security` would read it as
    // unauthenticated. The route has ALWAYS required authentication (`AccountScope` step 1);
    // only the DECLARATION was missing. So: keep the scheme, drop only the permission stamp.
    // TEST-8 asserts this against the shipped `openapi.json`.
    //
    // Note for a client author: this operation deliberately declares NO permission, so it
    // is listed for every authenticated principal (including through MCP
    // `list_capabilities`). That is correct — its authority is your MEMBERSHIP of the
    // account in the path, resolved server-side per request, and a non-member gets 404.
    op.security_requirement("bearerAuth")
    .description(
        "Leave an account you are a member of. Ends YOUR OWN membership only — the \
         route takes no target, so it cannot be used on anyone else. \
         AUTHORIZATION: no global permission is required, deliberately. Unlike the \
         other member routes this does NOT require account::members::manage: revoking \
         that capability turns self-service management off, and must not also trap \
         existing members inside an account they want to leave. Authority is your own \
         membership in THIS account, resolved per request — a non-member gets 404, \
         identical to a nonexistent account id, and a personal account gets 422. \
         Refuses (422 `LAST_OWNER`) if you are the account's sole owner: an account \
         must keep at least one owner, so promote another member to `owner` first (see \
         PATCH /accounts/{account_id}/members/{user_id}). Leaving also cancels every \
         still-pending project transfer you are a party to on this account's projects, \
         in the same transaction. Leaving does NOT delete or reassign the projects and \
         datasets you created in the account — they stay with the account. \
         FRONTEND NOTE (#149): do NOT gate a Leave affordance on \
         `Account.membersManageContext` succeeding. That preflight requires \
         account::members::manage AND the `admin` floor, so in the exact deployment where \
         this route matters — self-service management switched off — it returns 403 while \
         Leave is still available. Gate Leave on being a member, not on the management \
         preflight; and note that a sole owner will get 422 `LAST_OWNER` here, which is a \
         prompt to transfer ownership first, not an error to hide.",
    )
    .id("Account.leaveAccount")
    .tag("account")
    .response::<204, ()>()
    .response_with::<401, (), _>(|r| {
        r.description(
            "Not authenticated (`AccountScope` step 1). An earlier revision of this \
             description justified declaring it here by saying `with_permission` stamps a \
             401 on the sibling routes — it does not; it stamps a 403, `bearerAuth` and \
             `x-required-permissions`. All three member routes were missing their 401, so \
             all three now declare it",
        )
    })
    .response_with::<400, (), _>(|r| {
        r.description("`INVALID_ACCOUNT_ID` — the path account_id is not a UUID")
    })
    .response_with::<404, (), _>(|r| {
        r.description(
            "You are not a member of this account, or it does not exist — the two are \
             deliberately INDISTINGUISHABLE. This route cannot return 403: it requires no \
             global permission (see the description) and its target is your own row, so \
             the role-escalation guard has nothing to refuse",
        )
    })
    .response_with::<422, (), _>(|r| {
        r.description(
            "`LAST_OWNER` — an account must keep at least one owner; or \
             `PERSONAL_ACCOUNT_NOT_MANAGEABLE` — a personal account's membership \
             cannot be modified. Distinguish by the error CODE, not the status",
        )
    })
}

fn list_accounts_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountRead,)>(op)
        .description("List the accounts you are a member of (the account switcher list)")
        .id("Account.list")
        .tag("account")
        .response::<200, Json<AccountListResponse>>()
}

fn create_organization_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountManage,)>(op)
        .description(
            "Create an organization account (+ its owner membership, one transaction). \
             Requires account::manage (admin-only); the owner defaults to the caller \
             or a supplied owner_id. A user lacking account::manage gets 403.",
        )
        .id("Account.create")
        .tag("account")
        .response::<201, Json<Account>>()
}

fn list_members_docs(op: TransformOperation) -> TransformOperation {
    with_permission::<(AccountRead,)>(op)
        .description(
            "List the members of an account you belong to (paged; 404 if you are not a member)",
        )
        .id("Account.listMembers")
        .tag("account")
        .response::<200, Json<AccountMembersResponse>>()
}

fn list_member_events_docs(op: TransformOperation) -> TransformOperation {
    // Declared like its `manage-context` sibling: the runtime check is `AccountScope`'s, and
    // this makes the capability requirement visible to codegen and to clients.
    with_permission::<(AccountMembersManage,)>(op)
        .description(
            "The account's membership audit ledger: who joined, left, was removed or was \
             re-roled, when, and who did it. Paged, newest first. Requires \
             account::members::manage AND account role `admin` or higher in THIS account — a \
             non-member gets 404 (never 403), identical to a nonexistent account id; a bare \
             `member` gets 403. \
             \
             THE LEDGER RECORDS COMPLETED MUTATIONS, NOT ATTEMPTS. Each row is written inside \
             the same database transaction as the mutation it records, so a refused action \
             (an escalation refused as ROLE_ABOVE_ACTOR, a removal refused as LAST_OWNER) \
             leaves NO row at all. Read this as `what happened to this account`, never as \
             `who tried what`. \
             \
             The rows are append-only and permanent — a correction is a new row, never an \
             edit — and they are deleted only when the account itself is. \
             \
             This projection omits the unattended `system` provisioning event that seeds a \
             new account, and on platform staff actions it reports `actor_kind: admin` \
             WITHOUT the individual staff member's id: you learn that platform staff acted, \
             not which employee. It does NOT omit every `system` event: a membership that \
             ended with no attributable human actor — for example because the user account \
             itself was deleted — is a real event in this account and IS shown, as \
             `actor_kind: system`.",
        )
        .id("Account.listMemberEvents")
        .tag("account")
        .response::<200, Json<AccountMemberEventsResponse>>()
        // The refusals the description promises, declared in the MACHINE-READABLE half too —
        // a description that names a 404 while the response set declares only 200/403 is a
        // contract that disagrees with itself. 422 is the personal-account refusal the shared
        // extractor raises and the prose did not mention at all.
        .response_with::<404, (), _>(|r| {
            r.description(
                "You are not a member of this account, or it does not exist — the two are \
                 deliberately indistinguishable.",
            )
        })
        .response_with::<422, (), _>(|r| {
            r.description(
                "PERSONAL_ACCOUNT_NOT_MANAGEABLE — a personal account has exactly one member, \
                 its owner, and no membership surface.",
            )
        })
        // 401 and 400 because the shared extractor can return them, and a response set that
        // omits what the code returns is a contract that disagrees with itself. Applied to
        // `membersManageContext` in the same change rather than only here: this branch's
        // recurring defect has been correcting a claim where it was NOTICED and leaving the
        // siblings carrying the identical claim, and a blind round caught this being about to
        // become the sixth instance.
        .response_with::<401, (), _>(|r| r.description("Unauthenticated."))
        .response_with::<400, (), _>(|r| {
            r.description("INVALID_ACCOUNT_ID — the path segment is not a uuid.")
        })
}

fn members_manage_context_docs(op: TransformOperation) -> TransformOperation {
    // `with_permission::<(AccountMembersManage,)>` is what lands the key in the
    // OpenAPI spec and therefore in the generated `Permissions` enum (both the default
    // and the saas client) — which is what #149's `<Can>` / `defineAction` bind to.
    // The RUNTIME check is `AccountScope`'s step 2, not this doc transform; this makes
    // the requirement visible to codegen and to clients.
    with_permission::<(AccountMembersManage,)>(op)
        .description(
            "Your member-management standing in one account: your role there plus the \
             member count. Requires account::members::manage AND account role `admin` \
             or higher in THIS account — a non-member gets 404 (never 403), identical \
             to a nonexistent account id.",
        )
        .id("Account.membersManageContext")
        .tag("account")
        // Declared here as part of #148's sweep, not because this route changed: it sits on
        // the same `AccountScope<RoleAdmin>` and can return exactly the same refusals. See the
        // note on `list_member_events_docs`.
        .response_with::<404, (), _>(|r| {
            r.description(
                "You are not a member of this account, or it does not exist — the two are \
                 deliberately indistinguishable.",
            )
        })
        .response_with::<422, (), _>(|r| {
            r.description(
                "PERSONAL_ACCOUNT_NOT_MANAGEABLE — a personal account has exactly one member, \
                 its owner, and no membership surface.",
            )
        })
        .response_with::<401, (), _>(|r| r.description("Unauthenticated."))
        .response_with::<400, (), _>(|r| {
            r.description("INVALID_ACCOUNT_ID — the path segment is not a uuid.")
        })
        .response::<200, Json<AccountMembersManageContext>>()
}

/// `POST /api/account-invitations/accept` (#146) — the redemption route's OpenAPI contract.
///
/// **No `with_permission` wrapper**, unlike every other operation in this file. That is not
/// an omission: the route is authenticated and carries no capability requirement (#146
/// DEC-1), and wrapping it would publish a permission the server does not check.
fn accept_invitation_docs(op: TransformOperation) -> TransformOperation {
    op.description(&format!(
        "Redeem an invitation token and join the account it names. AUTHENTICATED, but NOT \
         account-scoped and NOT permission-gated: the redeemer is by definition not yet a \
         member of the account, so the TOKEN is the capability. THE TOKEN GOES IN THE BODY. \
         This operation declares no path, query or header parameter, deliberately — a token \
         in a URL leaks through Referer headers, browser history, proxy access logs and \
         screen shares. The invite link a client builds must carry the token in the URL \
         FRAGMENT (`/invite#<token>`), which is never sent to a server; the SPA reads the \
         fragment and POSTs it here. SIGNUP-THEN-ACCEPT: an invitee with no account should \
         hold the token in memory (not in localStorage, not in the URL), register through \
         POST /api/auth/register — which is UNCHANGED by this change and must never be \
         given token handling — and then call this endpoint. If they register with a \
         DIFFERENT address than the one invited, this endpoint returns the generic 404 \
         below; that is correct, and the UI should say which address the invitation was \
         sent to, which is safe to show to a holder of a valid token. INDISTINGUISHABLE \
         FAILURES — THIS IS A CONTRACT, NOT AN IMPLEMENTATION DETAIL: a wrong token, an \
         expired token, an already-redeemed token, a revoked token, and a valid token \
         presented by a user whose email does not match all return the SAME 404 with a \
         BYTE-IDENTICAL body. Never add a distinguishing code or message for any of them — \
         the difference is exactly what a token grinder wants, and `expired` alone confirms \
         that a valid token once existed for that account. EMAIL BINDING: the authenticated \
         user's email, normalized, must equal the invitation's. Emails are not verified in \
         this deployment, so this is containment against a leaked link reaching the wrong \
         logged-in tab, NOT proof of identity. {DEC12_CONSENT}"
    ))
    .id("Account.acceptInvitation")
    .tag("account")
    .response_with::<201, Json<AcceptInvitationResponse>, _>(|r| {
        r.description(
            "Joined. Exactly one account_members row was created, the invitation was \
             stamped accepted, and an audit row was written — all in one transaction.",
        )
    })
    .response_with::<200, Json<AcceptInvitationResponse>, _>(|r| {
        r.description(
            "You were ALREADY a member of that account. Idempotent: no second membership \
             row, and your role is unchanged — an invitation never promotes an existing \
             member. The invitation is consumed, so the token is now spent. `role` is your \
             actual role, which may differ from the one the invitation named.",
        )
    })
    .response_with::<401, (), _>(|r| r.description("Unauthenticated."))
    .response_with::<403, (), _>(|r| {
        r.description(
            "ROLE_ABOVE_ACTOR — the person who sent this invitation no longer has the \
             standing to confer it: they have been removed from the account, demoted below \
             `admin`, or demoted below the role the invitation confers. The role ceiling is \
             re-checked AT REDEMPTION, not only at issue, so an `owner` invitation from an \
             owner who has since been demoted does not land days later. No membership is \
             created and the invitation is left pending. Distinguishable from the 404 on \
             purpose: you have already proved you hold a valid token addressed to you, so \
             there is nothing left to enumerate.",
        )
    })
    .response_with::<404, (), _>(|r| {
        r.description(
            "INVALID_INVITATION — the one generic refusal. Returned identically, with a \
             byte-identical body, for: no such token; an expired token; an already-redeemed \
             token; a revoked token; and a valid token whose invited address does not match \
             your account's email.",
        )
    })
    .response_with::<422, (), _>(|r| {
        r.description(
            "SEAT_LIMIT_REACHED — the account is at its plan's member allowance; `details` \
             carries plan_id, limit and current so the UI can offer the upgrade path. \
             Nothing is written and the invitation stays PENDING, so it can be redeemed \
             once a seat frees. Or PERSONAL_ACCOUNT_NOT_MANAGEABLE — a personal account has \
             exactly one member, its owner, and no membership surface.",
        )
    })
}
