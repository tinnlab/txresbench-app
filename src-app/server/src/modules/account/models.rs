//! Account wire + DB types — the tenancy vocabulary A2/A3/A4/A5 (and the billing
//! epic) bind to. Deliberately domain-free: an `Account` is a personal or
//! organization tenancy unit; `AccountMember` is a `(account, user, role)` edge.
//!
//! `AccountRole` is a COARSE account role (`owner > admin > member`), a DISTINCT
//! type from the within-resource project ACL (`EffectivePermission`,
//! `viewer/editor/owner`). Conflating the two is the mistake INV-4 guards against.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use txresbench_core::AppError;

/// What KIND of account this is (the personal/org discriminator, DEC-1). A text
/// `kind` (not a boolean) so a third kind can be added without a schema change and
/// so metering/billing read a stable, self-documenting discriminator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AccountKind {
    /// The single, never-disabled account auto-created per user (owns their
    /// resources by default). Exactly one per user (INV-1).
    Personal,
    /// A shared account many users join (the SaaS org). Created by A3 (`saas`).
    Organization,
}

impl AccountKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountKind::Personal => "personal",
            AccountKind::Organization => "organization",
        }
    }

    /// Parse the DB `kind` text. Returns an error (never panics) on an unknown
    /// value — guideline §6: never `unwrap`/`expect` on a DB enum string.
    pub fn from_str(s: &str) -> Result<AccountKind, AppError> {
        match s {
            "personal" => Ok(AccountKind::Personal),
            "organization" => Ok(AccountKind::Organization),
            other => Err(AppError::internal_error(format!(
                "invalid account kind in database: {other:?}"
            ))),
        }
    }
}

/// The acting user's COARSE role on an account (DEC / INV-4). `Ord` is
/// `Owner > Admin > Member` (derived from declaration order below), so
/// [`AccountRole::allows`] grades a minimum-role floor. Distinct from the
/// within-resource ACL `EffectivePermission` (viewer/editor).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum AccountRole {
    // Declaration order defines `Ord`: Member < Admin < Owner.
    Member,
    Admin,
    Owner,
}

impl AccountRole {
    pub fn as_str(self) -> &'static str {
        match self {
            AccountRole::Member => "member",
            AccountRole::Admin => "admin",
            AccountRole::Owner => "owner",
        }
    }

    /// Parse the DB `role` text. Returns an error (never panics) on an unknown
    /// value — guideline §6: never `unwrap`/`expect` on a DB enum string.
    pub fn from_str(s: &str) -> Result<AccountRole, AppError> {
        match s {
            "member" => Ok(AccountRole::Member),
            "admin" => Ok(AccountRole::Admin),
            "owner" => Ok(AccountRole::Owner),
            other => Err(AppError::internal_error(format!(
                "invalid account role in database: {other:?}"
            ))),
        }
    }

    /// Does this role satisfy a minimum-role floor `min`? (`owner ≥ admin ≥
    /// member`.) The grading primitive A3's membership-authz layer uses.
    pub fn allows(self, min: AccountRole) -> bool {
        self >= min
    }
}

/// An `accounts` row. `personal_user_id` is the owning user for a `personal`
/// account, `None` for an `organization` (enforced by the DB CHECK
/// `accounts_personal_has_user`).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct Account {
    pub id: Uuid,
    pub kind: AccountKind,
    pub name: String,
    pub personal_user_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// An `account_members` row — one `(account, user)` membership edge with its
/// coarse role. `PRIMARY KEY (account_id, user_id)` is the one-membership-per-pair
/// constraint.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, FromRow)]
pub struct AccountMember {
    pub account_id: Uuid,
    pub user_id: Uuid,
    pub role: AccountRole,
    pub created_at: DateTime<Utc>,
    /// The member's login handle (`users.username`, NOT NULL) — the UI's fallback
    /// primary label when `display_name` is absent. Enriches the response so a human
    /// reads a person, never the bare `user_id` UUID (#51 defect #1).
    pub username: String,
    /// The member's email (`users.email`, NOT NULL) — the secondary identity line.
    pub email: String,
    /// The member's chosen display name (`users.display_name`, NULLABLE) — the
    /// preferred primary label when present. `None` ⇒ the UI falls back to `username`.
    pub display_name: Option<String>,
}

/// `GET /api/accounts` response — the caller's account memberships (the switcher
/// list). Owner-filtered by `list_user_accounts` (never a cross-account leak).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AccountListResponse {
    pub accounts: Vec<Account>,
}

/// `GET /api/accounts/{id}/members` response — one org's members, paged (the
/// settings-list numbered-pagination idiom; `total` drives "Showing N of M").
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AccountMembersResponse {
    pub members: Vec<AccountMember>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

/// `GET /api/accounts/{account_id}/members/manage-context` response (#139) — the
/// caller's member-management standing in ONE account.
///
/// Reaching this response at all IS the authorization proof: it is served behind
/// `AccountScope<RoleAdmin>`, so the caller has been shown to hold
/// `account::members::manage` AND to rank `admin` or above in THIS account. It is the
/// preflight a management UI runs before rendering write affordances — the global
/// `usePermission(Permissions.AccountMembersManage)` answers only half the question.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AccountMembersManageContext {
    /// The account this answer is about — echoes the PATH id, never the
    /// `X-Account-Id` header (which is ignored on this surface; DEC-1).
    pub account_id: Uuid,
    /// The caller's REAL role in this account (`admin` or `owner` here, by the floor).
    pub actor_role: AccountRole,
    /// How many members the account currently has.
    pub member_count: i64,
}

/// One row of the membership audit ledger (#148), as served by the two read routes.
///
/// **This is a projection, not the stored row.** The account-scoped route
/// (`GET /api/accounts/{account_id}/members/events`) applies three subtractions IN SQL, while
/// the staff route (`GET /api/admin/accounts/{account_id}/members/events`) serves the full row:
///
/// 1. the unattended `system` event that SEEDS a new account is omitted — but NOT every
///    `system` event: a membership that ended with no attributable human actor (for example
///    because the user account itself was deleted) is a real event in this account and IS
///    shown, as `actor_kind: system`;
/// 2. on platform-staff actions `actor_user_id` is NULL — you learn that staff acted, not
///    which employee;
/// 3. `reason` is never selected.
///
/// Applying them in SQL rather than in a serializer is why a later caller cannot reach a
/// redacted column by constructing this struct differently.
///
/// **This doc-comment is the SHIPPED schema description.** `JsonSchema` emits it verbatim into
/// `openapi.json` and the generated `types.ts`, so a stale sentence here reaches every client —
/// which is exactly how the first version of subtraction (1) went out contradicting the
/// operation description in the same document, with the contract test green because it read
/// only the operation half.
///
/// **What it records, and what it does not.** A row exists for a membership mutation that
/// COMMITTED. A refused attempt leaves nothing — the write shares the mutation's transaction,
/// so a refusal rolls it back. Read this as "what happened to this account", never as "who
/// tried what".
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AccountMemberEvent {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    /// `invited` | `invite_revoked` | `invite_resent` | `invite_expired` | `joined` |
    /// `role_changed` | `removed` | `left`.
    pub action: String,
    /// `user` (a principal acting with no more authority than their own membership) |
    /// `admin` (a principal acting with the platform-staff capability, wherever that
    /// capability is checked — not merely a URL prefix) | `system` (no human actor is
    /// attributable: the provisioning hook, or a membership ended by the `users` FK cascade).
    /// Never absent — a staff action must be distinguishable from an owner's, and an
    /// unattributable one from both.
    pub actor_kind: String,
    /// Who acted. NULL for a system action, and — on the ACCOUNT-scoped route only — NULL for
    /// a staff action too: an account admin learns that platform staff acted, not which
    /// employee. The staff identity is stored and is served on the admin surface.
    pub actor_user_id: Option<Uuid>,
    /// Whom it happened to. NULL only for an invitation sent to an ADDRESS that has no user
    /// yet — an invitation to somebody already in the directory names them by id instead, and
    /// then carries no address. Exactly one of `target_user_id` and `target_email` is set, for
    /// every action.
    pub target_user_id: Option<Uuid>,
    /// The invitation address, for an invitee who has no account yet. Trimmed and otherwise
    /// stored verbatim (it is NOT lowercased — the local part is case-sensitive and this row is
    /// permanent). Mutually exclusive with `target_user_id` by CHECK constraint.
    pub target_email: Option<String>,
    /// Both present on `role_changed`; `old_role` alone on a removal; `new_role` alone on a
    /// join.
    pub old_role: Option<AccountRole>,
    pub new_role: Option<AccountRole>,
    /// Ties an `invited` event to the `joined` that answered it.
    pub invitation_id: Option<Uuid>,
    /// Staff-authored note. Always absent on the account-scoped route (#148 DEC-7).
    pub reason: Option<String>,
}

/// The membership-audit read response — paged with the same numbered settings-list idiom as
/// [`AccountMembersResponse`], so a client pages both surfaces identically.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AccountMemberEventsResponse {
    pub events: Vec<AccountMemberEvent>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

/// `POST /api/accounts` request — create an ORGANIZATION account (#34). `owner_id`
/// defaults to the caller (the creator becomes the owner); an admin may name a
/// different existing user as the owner. Gated `account::manage`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateOrganizationRequest {
    /// The organization's display name (trimmed; must be non-empty).
    pub name: String,
    /// The user to seed as the `owner` member. Defaults to the caller when absent.
    #[serde(default)]
    pub owner_id: Option<Uuid>,
}

/// `POST /api/admin/accounts/{account_id}/members` request — add a user to an
/// account with a coarse role (#35). Gated `account::manage` (+ `admin::accounts`).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AddMemberRequest {
    pub user_id: Uuid,
    pub role: AccountRole,
}

/// `PATCH /api/admin/accounts/{account_id}/members/{user_id}` request — change a
/// member's coarse role (#35). Demoting the sole remaining owner is refused (422).
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct SetRoleRequest {
    pub role: AccountRole,
}

/// `GET /api/admin/accounts` query — page + optional `kind` filter (#33). (A
/// `status` filter is deferred to #36, which adds the account status column.)
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct AdminAccountsQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    pub kind: Option<AccountKind>,
}

/// One row of the cross-account admin list (#33): the account plus its member count
/// and (cheap) owner user id — the shape the frontend Accounts page (#44) renders.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdminAccountSummary {
    pub account: Account,
    pub member_count: i64,
    /// The account's owner (the `Owner`-role member; the personal user for a
    /// personal account). `None` only for an account with no owner member.
    pub owner_user_id: Option<Uuid>,
    /// The owner's human label — `COALESCE(display_name, username)` of the same
    /// earliest `owner`-role member `owner_user_id` resolves. `None` **iff**
    /// `owner_user_id` is `None`. The admin list renders this, never the UUID
    /// (#51 defect #2).
    pub owner_label: Option<String>,
}

/// `GET /api/admin/accounts` response — one page of ALL accounts (membership-free),
/// with `total` for the "Showing N of M" affordance.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdminAccountsListResponse {
    pub accounts: Vec<AdminAccountSummary>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

/// `POST /api/admin/accounts/{account_id}/suspend` body (#37) — admin suspend/disable an
/// account. `reason` is the admin's optional human note (audit); the acting admin + instant are
/// recorded server-side. Admin-gated (`admin::accounts`).
#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
pub struct SuspendAccountRequest {
    /// The admin's optional reason for the hold (audit — `accounts.admin_suspend_reason`).
    #[serde(default)]
    pub reason: Option<String>,
}

/// The admin-suspension status of an account (#37) — the response of
/// `POST …/suspend`, `POST …/reactivate`, and `GET …/status`. `admin_suspended` is the
/// admin-set flag OR-ed into `check_quota`'s suspension gate (independent of the derived
/// billing suspension). The audit fields are populated only while suspended. The FE admin
/// Accounts page (#44) binds this. NOT saas — the column + routes ride desktop.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AdminAccountStatusResponse {
    /// The account the status belongs to (echoes the resolved path id).
    pub account_id: Uuid,
    /// The admin-set suspension flag (independent of the derived billing suspension).
    pub admin_suspended: bool,
    /// When the current admin-suspension was applied (`null` when not suspended).
    pub admin_suspended_at: Option<DateTime<Utc>>,
    /// The admin (user id) who applied it (`null` when not suspended).
    pub admin_suspended_by: Option<Uuid>,
    /// The admin's reason for the hold (`null` when not suspended or none given).
    pub admin_suspend_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-1: from_str accepts valid, errors (not panics) on unknown, as_str
    // round-trips, serde renders snake_case.
    #[test]
    fn kind_and_role_from_str_roundtrip_and_reject() {
        // kind
        assert_eq!(
            AccountKind::from_str("personal").unwrap(),
            AccountKind::Personal
        );
        assert_eq!(
            AccountKind::from_str("organization").unwrap(),
            AccountKind::Organization
        );
        assert!(
            AccountKind::from_str("team").is_err(),
            "unknown kind is an error, not a panic"
        );
        assert_eq!(AccountKind::Personal.as_str(), "personal");
        assert_eq!(AccountKind::Organization.as_str(), "organization");

        // role
        for (s, r) in [
            ("member", AccountRole::Member),
            ("admin", AccountRole::Admin),
            ("owner", AccountRole::Owner),
        ] {
            assert_eq!(AccountRole::from_str(s).unwrap(), r);
            assert_eq!(r.as_str(), s);
        }
        assert!(AccountRole::from_str("viewer").is_err());
        assert!(AccountRole::from_str("editor").is_err());
    }

    // TEST-7 [covers: ITEM-10]: the admin request/query wire types deserialize the
    // documented shapes — the `kind` filter parses `personal|organization` (and
    // rejects garbage), a role body parses the coarse vocabulary, and `owner_id` is
    // optional on create-org.
    #[test]
    fn admin_wire_types_deserialize_expected_shapes() {
        // kind filter parses both valid kinds…
        let q: AdminAccountsQuery =
            serde_json::from_str(r#"{"kind":"organization","page":2}"#).unwrap();
        assert_eq!(q.kind, Some(AccountKind::Organization));
        assert_eq!(q.page, Some(2));
        assert_eq!(
            serde_json::from_str::<AdminAccountsQuery>(r#"{"kind":"personal"}"#)
                .unwrap()
                .kind,
            Some(AccountKind::Personal)
        );
        // …and rejects an unknown kind (never silently ignored).
        assert!(serde_json::from_str::<AdminAccountsQuery>(r#"{"kind":"team"}"#).is_err());
        // empty query is all-None (no filter).
        assert!(serde_json::from_str::<AdminAccountsQuery>("{}")
            .unwrap()
            .kind
            .is_none());

        // create-org: owner_id optional, role bodies parse the coarse roles.
        let c: CreateOrganizationRequest = serde_json::from_str(r#"{"name":"Acme"}"#).unwrap();
        assert_eq!(c.name, "Acme");
        assert!(c.owner_id.is_none());
        let add: AddMemberRequest = serde_json::from_str(
            r#"{"user_id":"00000000-0000-0000-0000-000000000001","role":"admin"}"#,
        )
        .unwrap();
        assert_eq!(add.role, AccountRole::Admin);
        assert_eq!(
            serde_json::from_str::<SetRoleRequest>(r#"{"role":"owner"}"#)
                .unwrap()
                .role,
            AccountRole::Owner
        );

        // serde snake_case
        assert_eq!(
            serde_json::to_string(&AccountKind::Personal).unwrap(),
            "\"personal\""
        );
        assert_eq!(
            serde_json::to_string(&AccountRole::Owner).unwrap(),
            "\"owner\""
        );
        assert_eq!(
            serde_json::to_string(&AccountRole::Member).unwrap(),
            "\"member\""
        );
    }

    // TEST-3 [covers: ITEM-4]: the #37 suspend wire types. `SuspendAccountRequest`
    // deserializes an empty body (reason → None) and a reason; `AdminAccountStatusResponse`
    // serializes the documented shape (all five fields, audit nulls when not suspended).
    #[test]
    fn suspend_wire_types_deserialize_and_serialize() {
        let empty: SuspendAccountRequest = serde_json::from_str("{}").unwrap();
        assert!(empty.reason.is_none(), "reason is optional → None on empty body");
        let with_reason: SuspendAccountRequest =
            serde_json::from_str(r#"{"reason":"abuse"}"#).unwrap();
        assert_eq!(with_reason.reason.as_deref(), Some("abuse"));

        let resp = AdminAccountStatusResponse {
            account_id: uuid::Uuid::nil(),
            admin_suspended: false,
            admin_suspended_at: None,
            admin_suspended_by: None,
            admin_suspend_reason: None,
        };
        let v = serde_json::to_value(&resp).expect("serialize AdminAccountStatusResponse");
        assert_eq!(v["admin_suspended"], serde_json::json!(false));
        assert!(v.get("account_id").is_some());
        assert!(v["admin_suspended_at"].is_null());
        assert!(v["admin_suspend_reason"].is_null());
    }

    // TEST-2: Ord is owner > admin > member; allows(min) grades correctly.
    #[test]
    fn role_ordering_and_allows() {
        assert!(AccountRole::Owner > AccountRole::Admin);
        assert!(AccountRole::Admin > AccountRole::Member);
        assert!(AccountRole::Owner > AccountRole::Member);

        // owner satisfies every floor
        assert!(AccountRole::Owner.allows(AccountRole::Owner));
        assert!(AccountRole::Owner.allows(AccountRole::Admin));
        assert!(AccountRole::Owner.allows(AccountRole::Member));
        // admin satisfies admin + member, not owner
        assert!(!AccountRole::Admin.allows(AccountRole::Owner));
        assert!(AccountRole::Admin.allows(AccountRole::Admin));
        assert!(AccountRole::Admin.allows(AccountRole::Member));
        // member satisfies only member
        assert!(!AccountRole::Member.allows(AccountRole::Owner));
        assert!(!AccountRole::Member.allows(AccountRole::Admin));
        assert!(AccountRole::Member.allows(AccountRole::Member));
    }

    // TEST-10 (acceptance, INV-4): AccountRole accepts exactly owner|admin|member,
    // rejects the project-ACL vocabulary (viewer/editor) — the coarse-account-role
    // vs within-resource-ACL separation. `AccountRole` and the project ACL are
    // distinct types (this file references only `AccountRole`), so a mix-up cannot
    // compile.
    #[test]
    fn account_role_is_disjoint_from_project_acl_vocabulary() {
        for good in ["owner", "admin", "member"] {
            assert!(
                AccountRole::from_str(good).is_ok(),
                "{good} is a valid account role"
            );
        }
        for acl_only in ["viewer", "editor"] {
            assert!(
                AccountRole::from_str(acl_only).is_err(),
                "{acl_only} is a project ACL term, NOT an account role"
            );
        }
    }
}

// ======================= #145 — account invitations ==========================
//
// An invitation addresses an EMAIL, not a user (`account_members.user_id` is NOT NULL
// and half the PK, so an invitation cannot be a row in that table — the schema fact
// recorded in 202609040002's header). Three types, and the split between the first two
// is load-bearing:
//
//   * `AccountInvitation` — the ROW. Carries `token_sha256`. **Never serialized to a
//     client**, which is why it derives neither `Serialize` nor `JsonSchema`: making that
//     a type-level property means "the hash leaked to the wire" is not expressible,
//     rather than merely not done.
//   * `InvitationSummary` — the LIST projection. Carries nothing user-shaped and no
//     token material.
//
// Splitting them is the mechanism behind two separate requirements — INV-16 (tokens are
// never at rest or on the wire in plaintext, and the HASH is not a wire value either) and
// "the list response must never reveal whether a pending invitee is a registered user".

/// One `account_invitations` row, server-internal.
///
/// **Deliberately not `Serialize`/`JsonSchema`.** Adding either would let this reach a
/// response body, and it carries `token_sha256`. If a future item needs a richer wire
/// shape, widen [`InvitationSummary`] — do not make this type serializable.
#[derive(Debug, Clone)]
pub struct AccountInvitation {
    pub id: Uuid,
    pub account_id: Uuid,
    /// Normalized (`lower(trim(…))`) at write time by
    /// `invitation_token::normalize_email` — the same transform #146 applies to the
    /// accepting user's address before comparing.
    pub email: String,
    /// The role this invitation confers, FROZEN at issue. #146 re-validates it against
    /// the escalation guard at redemption; it is never silently re-interpreted.
    pub role: AccountRole,
    /// SHA-256 of the base64url token. The plaintext is never stored.
    pub token_sha256: Vec<u8>,
    /// Who minted it. **No foreign key** — an invitation must survive its inviter
    /// (`membership-rescope.md` §7.5 / D-8), so this may name a user who has since been
    /// deleted.
    ///
    /// **`None` is reachable** (FIX_ROUND-1, F11): `create_invitation` maps
    /// `ActorCeiling::PlatformStaff` to a `NULL` inviter, so a staff-created invitation has
    /// none. An earlier version of this comment asserted no code path produced that, which
    /// was wrong and mattered — #146's accept-time re-check is specified as re-reading
    /// `membership_role(account_id, invited_by)`, and an author told this state cannot
    /// exist will unwrap it or silently fold it into "the inviter lost standing".
    pub invited_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub accepted_at: Option<DateTime<Utc>>,
    pub accepted_by: Option<Uuid>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoked_by: Option<Uuid>,
}

/// One row of `GET /api/accounts/{account_id}/invitations` — the inviter's view of their
/// OWN account's pending invitations.
///
/// **What is deliberately ABSENT is the specification, not an oversight.** There is no
/// `user_id`, no `username`, no `display_name`, no `registered` flag and no token or
/// hash. Issue #145: *"The list response must never reveal whether a pending invitee is a
/// registered user — return the email as typed, `role`, `created_at`, `expires_at`,
/// `invited_by`, and nothing user-shaped."* The SQL behind it never joins `users`, so the
/// property holds by construction rather than by a projection someone must remember to
/// keep narrow.
///
/// **There is no invite LINK here either**, and that follows from the token being hashed
/// at rest: the server cannot reproduce a link it has already handed out. The link is
/// minted afresh by `POST …/invitations/{id}/resend` (#145 DEC-2).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InvitationSummary {
    pub id: Uuid,
    /// The normalized address the invitation was issued to.
    pub email: String,
    pub role: AccountRole,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    /// The inviter's user id — an audit field, not a live reference (the column has no
    /// FK, so this may name a user who has since been deleted).
    pub invited_by: Option<Uuid>,
}

/// `POST /api/accounts/{account_id}/invitations` request.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct CreateInvitationRequest {
    /// The address to invite. Normalized (`lower(trim(…))`) before anything is done with
    /// it; an empty/whitespace-only value is a 400.
    pub email: String,
    /// The account role the invitation will confer. Must be at or below the caller's own
    /// role in this account — 403 `ROLE_ABOVE_ACTOR` otherwise (R-1, #142).
    pub role: AccountRole,
}

/// `POST /api/accounts/{account_id}/invitations` response — **the same three bytes in
/// every case**.
///
/// `202 Accepted` with `{"status":"sent"}` whether the address belongs to no user, to a
/// user, to a user who is already a member of this account, or already has a live
/// invitation. The last two are server-side no-ops. The body is assembled from a single
/// `const` in `handlers.rs`, so no branch can vary it.
///
/// The `status` field exists only so the response is a JSON object rather than an empty
/// body — a client that wants to branch on the outcome cannot, and that is the point.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateInvitationResponse {
    pub status: String,
}

/// `GET /api/accounts/{account_id}/invitations` response — paged (the settings-list
/// numbered-pagination idiom; `total` drives "Showing N of M").
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct InvitationsListResponse {
    pub invitations: Vec<InvitationSummary>,
    pub total: i64,
    pub page: i64,
    pub per_page: i64,
}

/// `POST /api/accounts/{account_id}/invitations/{invitation_id}/resend` response.
///
/// **This is the only place a plaintext invitation token is ever surfaced**, and it is
/// surfaced to the inviter, who is an `admin` or `owner` of the account the invitation
/// belongs to. It is enumeration-safe because the operation is keyed by invitation ID —
/// an id the caller obtained by listing their own account's invitations — and takes no
/// email, so there is nothing to probe.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ResendInvitationResponse {
    pub invitation_id: Uuid,
    /// The freshly minted token. Put it in the FRAGMENT of the invite link
    /// (`/invite#<token>`) — a fragment is never sent to a server, so it does not reach
    /// `Referer` headers, proxy access logs or browser history the way a query parameter
    /// does. Resending invalidates the previous token.
    pub invite_token: String,
    /// The new absolute expiry.
    pub expires_at: DateTime<Utc>,
}

/// `POST /api/account-invitations/accept` request (#146).
///
/// **The token travels in the BODY, and nowhere else** (INV-18, research §4.2): a token in
/// a URL path or query leaks through `Referer` headers, browser history, proxy access logs
/// and screen shares. The link the invitee opens is a FRONTEND route carrying the token in
/// the URL **fragment** (`/invite#<token>`) — fragments are never sent to a server — and the
/// SPA reads it and POSTs it here.
///
/// The route declares no path or query parameter at all, so this struct is the only place
/// the token can arrive; a test asserts that against the SHIPPED `openapi.json` rather than
/// against this comment.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
pub struct AcceptInvitationRequest {
    /// The base64url invitation token, exactly as it appeared in the invite link's
    /// fragment. Only its SHA-256 is ever compared against storage; the plaintext is never
    /// written anywhere.
    pub token: String,
}

/// `POST /api/account-invitations/accept` response (#146).
///
/// Deliberately minimal — the account id and the caller's role in it, which is what a
/// client needs to switch into the account it just joined. Everything else arrives the way
/// the rest of this module delivers state: a `SyncEntity::AccountMember` frame followed by
/// the client's own `GET /api/accounts` (`account/sync.rs` — notify-and-refetch, no row
/// data on the wire).
///
/// `role` is the membership's ACTUAL role. On the idempotent already-a-member path (`200`
/// rather than `201`) that is the role the caller already held, not the invitation's — an
/// invitation never promotes an existing member (#146 DEC-12).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AcceptInvitationResponse {
    pub account_id: Uuid,
    pub role: AccountRole,
}
