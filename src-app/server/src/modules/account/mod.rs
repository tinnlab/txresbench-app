//! `account` module — the tenancy LEAF (A1 of the accounts epic). Owns the
//! account graph (`accounts` + `account_members`), the membership + personal
//! resolvers over it, the role + kind vocabulary, the `account::{read,manage}`
//! permission vocabulary, and the `SyncEntity::Account`/`::AccountMember`
//! variants.
//!
//! Deliberately thin: A1 registers NO routes and NO sync emitters. REST
//! (`/api/accounts`), the sync fan-out (`publish_account`) and the FE store are
//! A4; the `account_id` ownership refactor + `account_of(project|dataset)` are A2;
//! org creation is A3 (`saas`); the signup-hook call-sites are A5. A1 provides the
//! frozen seams those items bind to (`.lifecycle/accounts/A1-tables/PLAN.md`
//! `## Provides`).

// #146 — invitation ACCEPT: the authenticate-only redeemer extractor + the PURE decision
// half (the ONE generic 404 constructor, the email binding, the TOCTOU grader). `pub` so the
// deny suite can bind to `INVALID_INVITATION` by NAME rather than by status — 404 is
// produced by three different causes on this module's surface.
pub mod accept;
pub mod backstop;
pub mod extractor;
mod handlers;
pub mod hook;
// #145 — invitations. Both are PURE (no DB, no axum): the token model + its claimability
// twin, and the TTL/rate ceilings. `pub` so #146's accept path can hash and normalize with
// the SAME functions this item wrote with — a second copy of `normalize_email` is how the
// email binding silently stops matching.
pub mod invitation_limits;
pub mod invitation_token;
pub mod member_scope;
mod models;
mod permissions;
mod repository;
mod routes;
// #141 — the SEAT allowance seam (the counting half + the two enforcement entry points
// `repository.rs` calls). Declared UNGATED on purpose: the saas conditional lives INSIDE
// `seat.rs`, so no build gate appears in this file or in `repository.rs` — which
// `tests/account/saas_gating_test.rs` asserts stay gate-free (A1 INV-3 / AC-INV-6). The
// membership routes therefore remain unconditional in both builds, exactly as research §5
// requires, while a desktop build still links zero billing code.
//
// NOTE FOR ANYONE EDITING THIS COMMENT: that test greps the file's whitespace-squashed TEXT
// for the gate attribute, so it does not distinguish code from prose — spelling the
// attribute out here, even inside a comment, turns it red. Say "saas conditional", not the
// attribute itself. (Found the hard way; recorded rather than worked around by editing the
// shared test.)
pub mod seat;
pub mod scope;
pub mod sync;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use txresbench_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

// The seams downstream epic items (A2/A3/A4/A5) + the billing epic consume.
pub use extractor::ActiveAccount;
// #146 — the accept seam #149's frontend consumes and the deny suite binds to.
pub use accept::{
    emails_bind, invalid_invitation, refuse_unless_inviter_still_entitled, InvitationRedeemer,
    InviterStanding, INVALID_INVITATION,
};
pub use models::{
    AcceptInvitationRequest, AcceptInvitationResponse, Account, AccountInvitation, AccountKind,
    AccountMember, AccountMemberEvent,
    AccountMemberEventsResponse, AccountMembersManageContext, AccountRole, AddMemberRequest,
    AdminAccountStatusResponse, AdminAccountSummary, AdminAccountsListResponse,
    AdminAccountsQuery, CreateInvitationRequest, CreateInvitationResponse,
    CreateOrganizationRequest, InvitationSummary, InvitationsListResponse,
    ResendInvitationResponse, SetRoleRequest, SuspendAccountRequest,
};
// #145 — the invitation seam #146 (accept) and #148 (audit) consume.
pub use invitation_limits::{InvitationLimits, INVITATION_RATE_LIMITED};
pub use invitation_token::{
    hash_matches, invitation_is_claimable, normalize_email, token_sha256,
    validate_invitation_email, MAX_EMAIL_BYTES, TOKEN_HASH_BYTES,
};
pub use member_scope::{
    AccountScope, MinAccountRole, RoleAdmin, RoleMember, RoleOwner, SelfMembership,
    ACCOUNT_MEMBERS_MANAGE_REQUIRED, INSUFFICIENT_ACCOUNT_ROLE,
};
pub use permissions::{AccountManage, AccountMembersManage, AccountRead};
pub use repository::{
    AccountRepository,
    // #142 / #145: the R-1 role-escalation ceiling. A REQUIRED argument on ALL THREE
    // membership mutations — `add_member`, `set_role`, `remove_member` — so a new caller
    // of any of them cannot silently get no ceiling; the `PlatformStaff` variant is the
    // deliberate, greppable admin-surface bypass. #142 shipped it on two of the three and
    // recorded the omission on `add_member` as #145's to close; #145 closed it, so
    // INV-R1's "via ANY surface" is now true by signature rather than by call graph.
    ActorCeiling, ROLE_ABOVE_ACTOR,
    // #146: what `accept_invitation` did — the account joined, the caller's ACTUAL role in
    // it, and whether they were already a member (the idempotent 200 path).
    AcceptedInvitation,
    // #148: the membership audit ledger. `AuditActor` answers "who to attribute" and is
    // DERIVED from `ActorCeiling` (`ceiling.audit_actor()`) so authority and attribution
    // cannot disagree — which is why NO mutation takes both. `record_member_event` takes a
    // caller-owned `&mut SqliteConnection`, never a pool, so the write cannot be anything but
    // in-transaction.
    AuditActor, MemberEventAction, NewMemberEvent, record_member_event, removal_action,
    system_row_is_tenant_visible,
    // #145: the invitation outcome the create path reports for AUDIT and TESTS only — the
    // HTTP response is uniform in every case (INV-8) and must never be derived from it.
    InvitationOutcome,
    // H-2 (#144): the refusal code, re-exported so callers and tests can bind to it
    // by NAME rather than by status — `LAST_OWNER` is also a 422 from the same
    // functions, so the status alone does not identify this refusal.
    PERSONAL_ACCOUNT_NOT_MANAGEABLE,
};

pub struct AccountModule;

impl AppModule for AccountModule {
    fn name(&self) -> &'static str {
        "account"
    }

    fn description(&self) -> &'static str {
        "Accounts — personal/organization tenancy units + membership roles."
    }

    fn init(&mut self, _ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        // A1 has no init-time work: no extension registry, no background task.
        // The baseline migration (schema + backfill + grant) is applied by the
        // shared migrator before any module `init` runs.
        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        // A4 mounts the account read surface: `GET /api/accounts` (the switcher
        // list) + `GET /api/accounts/{id}/members` (paged, member-gated). Switching
        // itself is a client-header op (DEC-2), validated per-request by the
        // `ActiveAccount` extractor — no server switch route.
        router.merge(routes::account_routes())
    }
}

// Registered BELOW `project` (order 25) so the account baseline migration + module
// init run before the project module — a forward-safety choice for A2, which will
// make `projects` reference `accounts` (DEC-6). No runtime cross-dep in A1, so the
// exact value is non-load-bearing; DEC-6's illustrative `24` is already taken by
// `workstore`, so `23` (also below `project`) is used — the only hard rule is that
// it stay UNIQUE (see `modules/mod.rs::module_order_is_unique`).
#[distributed_slice(MODULE_ENTRIES)]
static ACCOUNT: ModuleEntry = ModuleEntry {
    name: "account",
    order: 23,
    description: "Accounts + membership (TxResBench tenancy).",
    constructor: || Box::new(AccountModule),
};
