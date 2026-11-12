//! Account persistence — the account-graph reads + the idempotent
//! personal-account ensure. Uses sqlx COMPILE-TIME `query!` macros (verified
//! against the build DB schema at `cargo check`). The `kind`/`role` text columns
//! are decoded through [`AccountKind::from_str`]/[`AccountRole::from_str`] (never
//! `unwrap` on a DB enum string — guideline §6). All account SQL lives here
//! (handlers-free — guideline §9).
//!
//! SQLite driver (sqlite-store DEC-1: the app's modules are single-driver):
//! `uuid` columns are 16-byte BLOBs and `timestamptz` columns are canonical
//! RFC3339-UTC TEXT, so the plugin `<ident: Type>` overrides the PG macro
//! inference cannot produce are written out explicitly everywhere the DB type
//! differs from the Rust type — `id as "id: Uuid"`, `created_at as
//! "created_at: DateTime<Utc>"` (DEC-8's map). The serialization-substitution
//! note (PG row locks → `BEGIN IMMEDIATE`) is at [`lock_account_row`]; the
//! `now()`/`interval` → `strftime` rewrite convention is at
//! [`enforce_invitation_mint_budget`]; the app-side-Uuid rule (no
//! `gen_random_uuid()` on SQLite) is at [`ensure_personal_account_in_tx`].

use chrono::{DateTime, Utc};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

use txresbench_core::AppError;

// #171 (a) — the offboarding hook's SQL lives in the project module's repository
// (guideline §9: a module owns its own tables), and is called here on this
// transaction's connection so removal and cancellation commit together (DEC-6/DEC-7).
use crate::modules::project::{CancelledTransfer, ProjectRepository};

use super::models::{
    Account, AccountInvitation, AccountKind, AccountMember, AccountMemberEvent, AccountRole,
    AdminAccountSummary, InvitationSummary,
};
// #145 — the invitation token model + the TTL/rate ceilings. Both are PURE modules (no DB,
// no axum), so their truth tables are unit-testable without a server; see each file's head.
use super::invitation_limits::{InvitationLimits, INVITATION_RATE_LIMITED};
use super::invitation_token::{mint_token, token_sha256, validate_invitation_email};
// #146 — the accept path's PURE decision half: the ONE generic 404 constructor, the email
// binding, and the TOCTOU grader that mints the ceiling the membership INSERT is graded
// against. Same split, and for the same reason, as `invitation_token` above.
use super::accept::{
    collapse_absent_account, emails_bind, invalid_invitation,
    refuse_unless_inviter_still_entitled, InviterStanding,
};

pub struct AccountRepository {
    pool: SqlitePool,
}

/// Map an `account_members` INSERT error to a clean API error: a `user_id`
/// foreign-key violation means the target user does not exist ⇒ 404, instead
/// of a generic 500. Any other DB error falls through to `database_error`. Used
/// by the member INSERTs, whose account is already resolved to exist, so the only
/// user-FK that can fire is the target user.
///
/// SQLite port: PG identified the violation as `23503` on the named constraint
/// `account_members_user_id_fkey`. SQLite reports `SQLITE_CONSTRAINT_FOREIGNKEY`
/// (787) with the message `FOREIGN KEY constraint failed` and — in sqlx's sqlite
/// driver — NO constraint name (`DatabaseError::constraint()` is the PG-typed
/// default of `None`), so the discriminator is the error KIND. Because every
/// call site's account is already proven to exist, a foreign-key violation on
/// this statement can only be the `user_id` FK.
fn map_member_user_fk(err: sqlx::Error) -> AppError {
    if let Some(db) = err.as_database_error() {
        let is_user_fk = db.kind() == sqlx::error::ErrorKind::ForeignKeyViolation;
        if is_user_fk {
            return AppError::not_found("User");
        }
    }
    AppError::database_error(err)
}

/// The refusal code for a membership mutation aimed at a PERSONAL account (H-2,
/// #144). Named so tests can assert on it BY NAME rather than on a status alone.
pub const PERSONAL_ACCOUNT_NOT_MANAGEABLE: &str = "PERSONAL_ACCOUNT_NOT_MANAGEABLE";

/// Refusal code for **R-1**, the role-escalation guard (#142): the mutation would act
/// on — or mint — an account role ABOVE the acting principal's own.
///
/// **403, not 422.** `LAST_OWNER` and [`PERSONAL_ACCOUNT_NOT_MANAGEABLE`] are integrity
/// refusals that bind every caller including a root admin, so they are 422. This one is
/// an AUTHORITY refusal — it is exactly the thing platform staff are exempt from
/// ([`ActorCeiling::PlatformStaff`]) — and 403 is not an oracle here because reaching it
/// requires already being a proven MEMBER of the account: every route that can emit it
/// sits at the `admin` floor, and the one route below that floor (`leave`) cannot emit it
/// at all, because its target is the actor's own row ([`R1Target::Actor`]) and it
/// requests no role.
pub const ROLE_ABOVE_ACTOR: &str = "ROLE_ABOVE_ACTOR";

// The rate-limit windows and the mint-ledger retention horizon, as bound PARAMETERS.
//
// They are consts rather than SQL literals for one reason: the horizon must **dominate**
// the longest window, and while the windows were `interval '1 day'` literals inside the
// budget query, nothing connected them to the horizon. A blind correctness audit proved
// the gap by mutation — widening the SQL windows to five days (which makes a two-day prune
// delete rows the ceiling still counts, i.e. the exact silent truncation the horizon exists
// to prevent) left the unit test that claimed to bind them reporting `1 passed`, because
// that test compared against a hand-copied `1` in its own body.
//
// # Expressed in MICROSECONDS, deliberately
//
// The windows are bound into the SQLite port's `strftime` cut-offs as whole
// SECONDS (micros / 1_000_000), so the past-DST debate that shaped the
// `PgInterval` version does not apply: the SQLite clock is
// `strftime(...,'now')` = UTC, and a numeric `-N seconds` modifier is
// DST-invariant by construction. The microsecond unit is kept anyway — it is
// the invariant unit across the two engines (the PG leg converted the same
// numbers through `PgInterval`), and an integer microsecond count is the
// honest way to state "one hour" once, instead of repeating the magic number
// per call site. The INTEGER division to seconds is lossless for the three
// windows below (each is a whole number of seconds).

/// Microseconds in an hour — the unit every window below is expressed in.
const MICROS_PER_HOUR: i64 = 3_600_000_000;

/// One hour, the short rate-limit window.
const RATE_WINDOW_HOUR: i64 = MICROS_PER_HOUR;

/// One day, the long rate-limit window — and the value [`MINT_RETENTION`] must exceed.
const RATE_WINDOW_DAY: i64 = 24 * MICROS_PER_HOUR;

/// How long a mint record is kept before the opportunistic prune removes it.
///
/// **Must strictly dominate [`RATE_WINDOW_DAY`]**, or the prune deletes rows the ceiling is
/// still counting and the per-day ceiling silently becomes a shorter one. Pinned by
/// `mint_retention_dominates_the_longest_rate_limit_window`, which compares the two CONSTS
/// — not a copy of one of them.
const MINT_RETENTION: i64 = 48 * MICROS_PER_HOUR;

/// The authority ONE membership mutation is graded against — the R-1 role-escalation
/// guard (#142), and the thing this repository could not express before it.
///
/// > **Rule R-1.** For any membership mutation, both the **target's current role** and
/// > the **requested new role** must be `<= actor_role`. An actor may never create,
/// > promote to, demote from, or remove a role above their own, and may never raise
/// > anyone (including themselves) above their own.
///
/// Under #140's DEC-12 account membership is an implicit BULK grant, so "an Admin mints
/// an Owner" is not a title change: an account Owner holds `EffectivePermission::Owner`
/// — delete, transfer and share — over every project in the tenant, including ones they
/// never created. That is why this is a P0 guard and not hygiene.
///
/// # Why a parameter here, and not a check in the handler
///
/// Same reason [`AccountRepository::refuse_if_personal`] lives here (#144): this is the
/// one function every mutation path reaches, so the guard "covers the admin surface and
/// any future self-service surface at once and cannot be forgotten by a third caller."
/// A REQUIRED parameter is what makes forgetting inexpressible **on the two functions
/// that take it** — a new caller must type something — which two functions
/// (`set_role` / `set_role_scoped`) would not achieve.
///
/// **All THREE membership-mutating functions take this parameter as of #145.**
/// `set_role`, `remove_member` and [`AccountRepository::add_member`] — the last being the
/// one function that CREATES a role from nothing, and the one #142 could not thread
/// because it had no non-staff caller and opened no transaction. #145 did both halves at
/// once, in the order #142 prescribed (transaction + owner lock FIRST, then the graded
/// ceiling), so INV-R1's *"via ANY surface"* is now literally true rather than true only
/// while nobody added a caller. Do not remove the parameter from any of the three: a
/// REQUIRED argument is what makes forgetting inexpressible.
///
/// # Why an enum, and not `Option<AccountRole>`
///
/// The same reason [`crate::modules::sync::Actor`] exists: `None` reads as "nothing to
/// say", whereas [`PlatformStaff`](ActorCeiling::PlatformStaff) reads as "staff are
/// trusted on this surface", must be TYPED at the call site, and makes every bypass in
/// the tree enumerable by one `grep`. It also carries the actor's ID, which the ceiling
/// re-read (below) needs and an `Option<AccountRole>` could not supply.
///
/// **History, kept because the reasoning is reusable.** #142 shipped this parameter on
/// two functions only and recorded the third as a debt: *"#145 MUST thread this through
/// `add_member` before it adds any non-staff caller."* Its stated reasons for waiting
/// were that #142 mounted no add-member route (so the guard would have had no production
/// caller — the dead-guard shape) and that `add_member` opened no transaction (so the
/// locked live re-read this type rests on was not available there). #145 discharged both:
/// `add_member` now opens a transaction and takes the account's owner lock before
/// resolving the ceiling, and the guard IS reached — by the admin surface at
/// [`PlatformStaff`](ActorCeiling::PlatformStaff) on every call, and by a `SelfService`
/// ceiling in the acceptance test that exercises the refusal. The next non-staff caller
/// (#146's invitation accept) therefore cannot omit it: there is no signature in which to
/// omit it.
#[derive(Debug, Clone, Copy)]
pub enum ActorCeiling {
    /// **No ceiling.** Platform staff acting through `/api/admin/accounts/*`, where the
    /// caller has already cleared `admin::accounts` + `account::manage` and is trusted
    /// by design — the admin surface is where an operator repairs an account whose own
    /// owners cannot or will not. Every use of this variant is a deliberate, reviewable
    /// bypass of R-1; there are exactly two in production code.
    ///
    /// **#148 widened this from a unit variant to carry the acting staff member's id.** It had
    /// none, so the audit ledger could not attribute the removals an audit trail most exists
    /// for. The field is REQUIRED, not `Option`, so "a staff action with no attributable
    /// actor" is not representable; the variant stays NAMED so every R-1 bypass in the tree is
    /// still enumerable by one grep, and is now attributable as well.
    PlatformStaff { staff_user_id: Uuid },
    /// A self-service actor, proven by `AccountScope<Min>` to be a member of this
    /// account at or above the route's floor.
    ///
    /// Both fields are load-bearing. `observed_role` is the ceiling the request was
    /// ADMITTED under (what `AccountScope` read at extraction time); `actor_user_id` is
    /// what lets [`resolve_ceiling`] re-read the actor's role LIVE inside the mutation's
    /// own transaction. The effective ceiling is the **minimum** of the two — see
    /// `resolve_ceiling` for why that direction, and only that direction.
    SelfService {
        actor_user_id: Uuid,
        observed_role: AccountRole,
    },
}

/// **WHOM an audited membership event is attributed to** — the #148 ledger's actor, derived
/// from the [`ActorCeiling`] the mutation was graded against so authority and attribution can
/// never disagree.
///
/// It is a DIFFERENT type from `ActorCeiling` on purpose. `ActorCeiling` answers *"what
/// authority was checked?"*; this answers *"who do we write down?"*. Where a function has one
/// but not the other — [`AccountRepository::add_member`] takes this and NOT a ceiling — a
/// reader must not be able to mistake attribution for enforcement. Merging them into one
/// parameter would make `add_member`'s signature claim an R-1 check it does not perform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditActor {
    /// A principal acting with no more authority than their own membership in the account.
    ///
    /// **Classified by the AUTHORITY used, not by the URL prefix.** This doc used to say
    /// "acting through `/api/accounts/*`", and that surface reading is what produced a real
    /// defect: `POST /api/accounts` lives under that prefix but is gated on the platform-staff
    /// capability, so classifying it `User` served an operator's id past the tenant redaction.
    /// The prefix is a routing accident; the capability is the fact. See DEC-17.
    User(Uuid),
    /// A principal acting with the platform-staff capability, wherever that is checked —
    /// `/api/admin/accounts/*`, and also `POST /api/accounts`, which requires the same
    /// admin-only capability. **This is the case the ledger
    /// most exists for**, and it is representable only because #148 widened
    /// [`ActorCeiling::PlatformStaff`] to carry the staff id — before that the staff arm
    /// carried no actor at all, so an admin removal could not be attributed.
    Admin(Uuid),
    /// No human actor is attributable at the layer that observed the event — today the
    /// personal-account provisioning hook AND the database trigger that records a membership ended by the
    /// `users` FK cascade. Writes `actor_user_id = NULL`, which the table's `actor_id_kind`
    /// CHECK permits for this kind ALONE, so an unattributable non-system event is not
    /// representable.
    ///
    /// **`system` is not a synonym for "internal".** The account-scoped read hides the
    /// PROVISIONING seed (`system` + `joined`) and shows the cascade removal (`system` +
    /// `removed`), because the second is a real event in the tenant and the first is not.
    /// Filtering the whole kind is how the cascade hole came back after it had been closed.
    System,
}

impl AuditActor {
    /// The `actor_kind` text column value.
    pub fn kind_str(self) -> &'static str {
        match self {
            AuditActor::User(_) => "user",
            AuditActor::Admin(_) => "admin",
            AuditActor::System => "system",
        }
    }

    /// The `actor_user_id` column value — `None` for [`AuditActor::System`] only.
    pub fn user_id(self) -> Option<Uuid> {
        match self {
            AuditActor::User(id) | AuditActor::Admin(id) => Some(id),
            AuditActor::System => None,
        }
    }
}

impl ActorCeiling {
    /// The audit actor this ceiling attributes to. Deriving it (rather than taking a second
    /// parameter beside the ceiling) is what makes "declared staff authority, recorded a
    /// different actor" inexpressible — an inconsistency an audit trail cannot survive.
    pub fn audit_actor(self) -> AuditActor {
        match self {
            ActorCeiling::PlatformStaff { staff_user_id } => AuditActor::Admin(staff_user_id),
            ActorCeiling::SelfService { actor_user_id, .. } => AuditActor::User(actor_user_id),
        }
    }
}

/// What happened, for one `account_member_events` row (#148).
///
/// All eight values exist in the schema now; the four invitation ones have no producer on this
/// branch (the invitations item owns them) and are minted here so that item needs no second
/// migration against an append-only table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberEventAction {
    Invited,
    InviteRevoked,
    InviteResent,
    InviteExpired,
    Joined,
    RoleChanged,
    /// A membership ended by anyone other than the principal acting AS THEMSELVES.
    ///
    /// That covers a third party evicting somebody, staff acting through the admin surface —
    /// **including staff removing their own membership row**, because they acted with staff
    /// authority and which authority was used is the security-relevant fact — and an
    /// unattributed ending, such as the `users` FK cascade. See [`removal_action`], and the
    /// `left_is_self` CHECK that makes the distinction unavoidable rather than conventional.
    Removed,
    /// The principal ended their OWN membership.
    ///
    /// #142's INV-R2 routes `POST …/members/leave` through the same
    /// [`AccountRepository::remove_member`] as `DELETE …/members/{user_id}`, so the two reach
    /// one function and the ROW is what has to tell them apart. See
    /// [`removal_action`] — the actor is how.
    Left,
}

impl MemberEventAction {
    pub fn as_str(self) -> &'static str {
        match self {
            MemberEventAction::Invited => "invited",
            MemberEventAction::InviteRevoked => "invite_revoked",
            MemberEventAction::InviteResent => "invite_resent",
            MemberEventAction::InviteExpired => "invite_expired",
            MemberEventAction::Joined => "joined",
            MemberEventAction::RoleChanged => "role_changed",
            MemberEventAction::Removed => "removed",
            MemberEventAction::Left => "left",
        }
    }

    /// Parse the DB `action` text. Returns an error (never panics) on an unknown value —
    /// guideline §6. A value added to the CHECK constraint without a matching arm here is
    /// caught by this, at read time, rather than by a panic in the middle of an incident.
    pub fn from_str(s: &str) -> Result<MemberEventAction, AppError> {
        match s {
            "invited" => Ok(MemberEventAction::Invited),
            "invite_revoked" => Ok(MemberEventAction::InviteRevoked),
            "invite_resent" => Ok(MemberEventAction::InviteResent),
            "invite_expired" => Ok(MemberEventAction::InviteExpired),
            "joined" => Ok(MemberEventAction::Joined),
            "role_changed" => Ok(MemberEventAction::RoleChanged),
            "removed" => Ok(MemberEventAction::Removed),
            "left" => Ok(MemberEventAction::Left),
            other => Err(AppError::internal_error(format!(
                "invalid account member event action in database: {other:?}"
            ))),
        }
    }
}

/// Classify a membership REMOVAL: `Left` when the principal ended their own membership,
/// `Removed` otherwise (#148 DEC-4).
///
/// Derived from the ACTOR, not from the route, so a future caller of
/// [`AccountRepository::remove_member`] records the right action without knowing this rule
/// exists. Two consequences are deliberate:
///
/// - `POST …/members/leave` and `DELETE …/members/{me}` both record `left` — they are the same
///   act performed through two routes (#142 INV-R2 funnels both here).
/// - Platform staff removing their OWN membership row through the admin surface records
///   `removed`, not `left`, because they acted with staff authority and **which authority was
///   used is the security-relevant fact**.
pub fn removal_action(actor: AuditActor, target_user_id: Uuid) -> MemberEventAction {
    match actor {
        AuditActor::User(id) if id == target_user_id => MemberEventAction::Left,
        _ => MemberEventAction::Removed,
    }
}

/// Is a `system` row of this action shown on the ACCOUNT-SCOPED read (#148 DEC-19)?
///
/// **The SQL predicate in [`AccountRepository::list_member_events_scoped`] must mirror this
/// function**, and an integration test drives one `system` row through the real route for every
/// action a `system` row can legally take — all seven; `left` is the one exception, and it is
/// unconstructible by construction (it requires `actor_kind = 'user'`), which that test asserts
/// rather than skips. A duplicated rule is a drift risk, so it is duplicated once and pinned
/// rather than left implicit in one place.
///
/// The match is EXHAUSTIVE on purpose. An earlier comment claimed a test would catch a new
/// `system` producer shipping with no visibility decision; it would not have — the tests
/// asserted only the two actions that existed. This is the enforcement that claim needed:
/// adding a variant to [`MemberEventAction`] is a COMPILE ERROR here, so the decision cannot
/// be skipped. `invite_expired` is the realistic next one — an unattended sweep with no human
/// actor — and it is exactly the case that would otherwise have been hidden silently.
///
/// **Hiding a row is a bug too.** The tenant needs any event that changes who is in their
/// account; the only thing withheld is the unattended seed by which an account comes into
/// being, which is a platform internal and not an event in the tenant.
pub fn system_row_is_tenant_visible(action: MemberEventAction) -> bool {
    match action {
        // How an account comes into being. A platform internal; withheld.
        MemberEventAction::Joined => false,
        // A membership ENDED with no attributable human actor — today because the user record
        // itself was deleted. A real event in this tenant; shown.
        MemberEventAction::Removed => true,
        // No `system` producer today. Each is withheld until something writes one and a
        // decision is made HERE, deliberately, rather than inherited from a default.
        MemberEventAction::Invited
        | MemberEventAction::InviteRevoked
        | MemberEventAction::InviteResent
        | MemberEventAction::InviteExpired
        | MemberEventAction::RoleChanged => false,
        // Not representable: `left` requires actor == target, and a system actor has none.
        MemberEventAction::Left => false,
    }
}

/// One row to append to `account_member_events` (#148).
///
/// Constructed at the mutation site — where the account, the actor, the target and the roles
/// BEFORE the change are all already in scope — and handed to [`record_member_event`] on the
/// mutation's own connection.
#[derive(Debug, Clone)]
pub struct NewMemberEvent {
    pub account_id: Uuid,
    pub actor: AuditActor,
    pub action: MemberEventAction,
    pub target_user_id: Option<Uuid>,
    /// The invitation address, TRIMMED and otherwise stored verbatim (see
    /// [`record_member_event`] for why lowercasing it would be lossy). The CHECK refuses it
    /// together with
    /// `target_user_id` — once there is a user, the id is the identifier, and that exclusivity
    /// is what stops this column becoming a permanently-retained copy of the user directory's
    /// email (#148 DEC-14).
    pub target_email: Option<String>,
    pub old_role: Option<AccountRole>,
    pub new_role: Option<AccountRole>,
    pub invitation_id: Option<Uuid>,
    /// Staff-authored note (the `admin_suspend_reason` precedent). Omitted from the
    /// account-scoped read projection (#148 DEC-7).
    pub reason: Option<String>,
}

impl NewMemberEvent {
    /// The common shape: an event about an existing principal, with no invitation and no note.
    pub fn about(
        account_id: Uuid,
        actor: AuditActor,
        action: MemberEventAction,
        target_user_id: Uuid,
    ) -> Self {
        NewMemberEvent {
            account_id,
            actor,
            action,
            target_user_id: Some(target_user_id),
            target_email: None,
            old_role: None,
            new_role: None,
            invitation_id: None,
            reason: None,
        }
    }

    pub fn with_roles(mut self, old: Option<AccountRole>, new: Option<AccountRole>) -> Self {
        self.old_role = old;
        self.new_role = new;
        self
    }
}

/// Append ONE row to the membership audit ledger, **on a caller-owned connection** (#148).
///
/// # The signature is the guarantee
///
/// It takes `&mut SqliteConnection`, never a pool/`SqlitePool`. That is not a style choice:
/// a pool would let
/// this write open its OWN transaction and commit independently of the mutation it records —
/// and a row that can be written after the mutation commits is a row that can be MISSING when
/// it matters, while the ledger still looks complete. With a caller-owned connection the write
/// is in whatever transaction the caller holds, and every production caller holds the
/// mutation's. It cannot be otherwise without changing this signature, which is a reviewable
/// event.
///
/// The same shape, for the same reason, as
/// `ProjectRepository::cancel_pending_transfers_for_removed_member` — the house idiom for
/// "another write, on THIS transaction's connection, so both commit or neither does".
///
/// # What is NOT written here
///
/// A REFUSED mutation. Every refusal returns `Err` before its transaction commits, so a row
/// written on this connection is rolled back with it. That is why "records refused attempts"
/// is not an option this table has: it is excluded by the same property that makes it
/// trustworthy (#148 DEC-1).
pub async fn record_member_event(
    conn: &mut SqliteConnection,
    ev: NewMemberEvent,
) -> Result<(), AppError> {
    // NORMALIZE AND REFUSE HERE, not at the statement. `NewMemberEvent`'s fields are public
    // (the invitations item constructs them), and the table's CHECKs reject a blank `reason`,
    // a blank `target_email`, and an address alongside a user id — so an unvalidated struct
    // reaches Postgres as a constraint violation, i.e. a 500, at the exact seam a downstream
    // item was told to build against. A blind audit filed it as a latent 500 and it is: the
    // field doc says the address is "normalized" and nothing normalized it anywhere.
    //
    // The address is TRIMMED and otherwise stored VERBATIM. An earlier round lowercased it,
    // which is lossy: the local part of an address is case-sensitive per RFC 5321, this row is
    // append-only and permanent, and a lossy transform written into a record that cannot be
    // corrected is the wrong trade. It would also stop the stored value byte-matching the user
    // directory's, so any later join would silently miss.
    //
    // The consequence, stated so nobody re-derives it: matching an invitation address against a
    // user must `lower()` BOTH sides, the way `txresbench-auth` itself does
    // (`LOWER(email) = LOWER($1)`). Note the directory's UNIQUE constraint is on the verbatim
    // column and its lower() index is NOT unique, so two users can differ only by case and such
    // a match can return more than one row — the caller has to handle that rather than assume
    // a single hit. (An earlier version of this note claimed the uniqueness; it is not there.)
    let target_email = ev
        .target_email
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let reason = ev
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    // EVERY constraint on the table is mirrored here FIRST, so a malformed struct produces a
    // named error instead of a raw constraint violation at the seam a downstream item was told
    // to build against. Three rounds were needed to get this right, and the failure repeated in
    // the same shape each time: a round would add constraints and one guard, while the comment
    // claimed parity. So the mirror is now an EXHAUSTIVE match on the action — adding a variant
    // to `MemberEventAction` is a COMPILE ERROR here, not a comment nobody re-reads.
    //
    // `internal_with_id` rather than `internal_error`: these are invariant breaches in the
    // writer of an AUDIT trail, so they must be traced server-side and must not echo the
    // table's internals verbatim into a response body.
    //
    // **What the mirror buys, stated precisely, because the obvious phrasing is wrong.** It is
    // NOT a nicer error for the client: `internal_with_id` redacts, so a malformed event and a
    // raw constraint violation look identical from outside (500 + a trace id). What it buys is
    // (1) a specific message in the server-side trace instead of an unexplained
    // `23514 check_violation`, and (2) — the part a caller can actually feel — the transaction
    // SURVIVES. A refusal raised here never touches the connection; a constraint violation
    // ABORTS the transaction, so every later statement fails until rollback and a caller
    // batching several events loses the whole unit of work. A mutation battery is what
    // established this: deleting an arm left the suite green precisely because the database
    // still refused the row, and the test now asserts the transaction is still usable.
    let bad = |why: &'static str| Err(AppError::internal_with_id(why));

    // `account_member_events_exactly_one_target`
    match (ev.target_user_id, target_email.as_deref()) {
        (Some(_), Some(_)) => {
            return bad(
                "account_member_events: a row carries an invitation address OR a target user \
                 id, never both — once there is a user, the id is the identifier",
            )
        }
        (None, None) => {
            return bad(
                "account_member_events: every event names a principal — a target user id, or \
                 an invitation address for an invitee who has no account yet",
            )
        }
        _ => {}
    }

    let names_user = ev.target_user_id.is_some();
    match ev.action {
        // An invitation names EITHER an address or a known user (handled above) and carries
        // whatever roles the invitation is about. NO further shape, deliberately: an earlier
        // version refused an invitation carrying `old_role`, which NO constraint enforces —
        // so it was strictly stricter than the table while the comment above claimed parity,
        // and it blocked a legitimate row (offering an EXISTING member a higher role, the
        // by-id invitation this schema deliberately permits). A blind round brute-forced all
        // 640 constructible shapes against the shipped DDL and found exactly 80 mismatches,
        // every one of them that arm. Mirror the CHECKs; do not invent rules here.
        MemberEventAction::Invited
        | MemberEventAction::InviteRevoked
        | MemberEventAction::InviteResent
        | MemberEventAction::InviteExpired => {}
        // `account_member_events_membership_has_user` + `..._join_role`
        MemberEventAction::Joined => {
            if !names_user {
                return bad(
                    "account_member_events: a membership event names the USER it concerns — \
                     an invitation address identifies an invitee, not a member",
                );
            }
            if ev.new_role.is_none() || ev.old_role.is_some() {
                return bad(
                    "account_member_events: a join records the role it GRANTED and no role \
                     before it",
                );
            }
        }
        // `..._membership_has_user` + `..._role_changed_has_both`
        MemberEventAction::RoleChanged => {
            if !names_user {
                return bad(
                    "account_member_events: a membership event names the USER it concerns — \
                     an invitation address identifies an invitee, not a member",
                );
            }
            if ev.old_role.is_none() || ev.new_role.is_none() {
                return bad(
                    "account_member_events: a role change records BOTH the role before and \
                     the role after — one alone cannot reconstruct the change",
                );
            }
        }
        // `..._membership_has_user` + `..._departure_role` (+ `..._left_is_self` for `Left`)
        MemberEventAction::Removed | MemberEventAction::Left => {
            if !names_user {
                return bad(
                    "account_member_events: a membership event names the USER it concerns — \
                     an invitation address identifies an invitee, not a member",
                );
            }
            if ev.old_role.is_none() || ev.new_role.is_some() {
                return bad(
                    "account_member_events: a departure records the role HELD and no role \
                     after it",
                );
            }
            if ev.action == MemberEventAction::Left
                && (ev.actor.kind_str() != "user" || ev.actor.user_id() != ev.target_user_id)
            {
                return bad(
                    "account_member_events: `left` means the principal ended their OWN \
                     membership, acting as themselves — an eviction, a staff removal, or an \
                     unattributed ending is `removed`",
                );
            }
        }
    }

    // DEC-12: the PG chain's `id DEFAULT gen_random_uuid()` has no SQLite
    // equivalent — the id is bound app-side (the one write-once field of an
    // append-only row, so a `Uuid::new_v4()` per call cannot collide).
    let event_id = Uuid::new_v4();
    // let-bound: the sqlx bind is borrowed across the statement, so fn-call
    // temporaries would drop before the execute (E0716 class).
    let actor_user_id = ev.actor.user_id();
    let actor_kind = ev.actor.kind_str();
    let action = ev.action.as_str();
    let old_role = ev.old_role.map(|r| r.as_str());
    let new_role = ev.new_role.map(|r| r.as_str());
    sqlx::query!(
        r#"INSERT INTO account_member_events
               (id, account_id, actor_user_id, actor_kind, action,
                target_user_id, target_email, old_role, new_role, invitation_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)"#,
        event_id,
        ev.account_id,
        actor_user_id,
        actor_kind,
        action,
        ev.target_user_id,
        target_email,
        old_role,
        new_role,
        ev.invitation_id,
        reason,
    )
    .execute(&mut *conn)
    .await
    .map_err(AppError::database_error)?;
    Ok(())
}

/// Whom a membership mutation is aimed at, for R-1's CURRENT-role half.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum R1Target {
    /// Somebody else, at this role. Their CURRENT role must be at or below the ceiling —
    /// the half that stops an Admin demoting or evicting an Owner.
    Other(AccountRole),
    /// The actor's OWN membership row: `leave`, or a self-demotion.
    ///
    /// The current-role half is **vacuous** here, and skipping it is a CORRECTNESS fix
    /// rather than a convenience. That half asks "may I reach a person who OUTRANKS
    /// me?", and nobody outranks themselves. Grading it anyway is wrong exactly when the
    /// ceiling and the target row disagree — which is precisely the case when the actor
    /// was concurrently PROMOTED, because [`resolve_ceiling`] clamps the ceiling to the
    /// role the request was admitted under while the target row (the same row) already
    /// carries the higher live role.
    ///
    /// The observable defect this closes: a `member` promoted to `admin` between
    /// extraction and commit was refused `403 ROLE_ABOVE_ACTOR` on `leave` — a route that
    /// takes no target and whose only possible effect is to REDUCE their own standing.
    /// Found by a blind correctness audit, which also caught the source comment that
    /// asserted the case was unreachable.
    ///
    /// The REQUESTED half still applies to a self-target, so "an Admin promotes
    /// THEMSELVES to Owner" is still refused (#142 INV-5 makes that its own case,
    /// because self-targeting is where guards acquire an accidental early return).
    Actor,
    /// **There is no incumbent at all** — the mutation CREATES a role from nothing: an
    /// invitation (#145), or [`AccountRepository::add_member`].
    ///
    /// The current-role half is vacuous for the same reason it is vacuous for [`Actor`],
    /// but for a different cause worth keeping distinct: for `Actor` there IS a row and
    /// nobody outranks themselves; here there is no row to outrank. Only the REQUESTED
    /// half binds — which is exactly the half INV-R1 is about ("an account Admin cannot
    /// **create** a principal holding account Owner, via ANY surface").
    ///
    /// A separate variant rather than reusing [`Actor`] because the two are graded
    /// identically today and would silently stay identical if either ever needed to
    /// diverge; and because `grep R1Target::NewMember` should enumerate the
    /// role-creating call sites, which is a different set from the self-targeting ones.
    ///
    /// [`Actor`]: R1Target::Actor
    NewMember,
}

/// Grade one mutation against a ceiling — the PURE half of R-1. No DB, no axum, so the
/// truth table is unit-testable directly (mirrors `member_scope.rs`'s
/// `resolve_account_id_param` split, for the same reason).
///
/// `target` is whom the mutation is aimed at, carrying their role BEFORE it (or
/// [`R1Target::Actor`] for a self-target, whose current-role half is vacuous);
/// `requested` is the role AFTER it, or `None` for a removal. **BOTH halves are checked,
/// independently** — that is the whole rule. Checking only `requested` would let an Admin
/// demote or evict every Owner and then be promoted by an accomplice; checking only
/// `current` would let an Admin mint an Owner out of a bare member.
///
/// The comparison is strict (`>`): a role EQUAL to the ceiling is allowed, so an Admin
/// may promote a member to `admin` and an Owner may mint another Owner (which is what
/// makes R-4's two-step ownership transfer possible at all).
fn refuse_if_above_ceiling(
    ceiling: AccountRole,
    target: R1Target,
    requested: Option<AccountRole>,
) -> Result<(), AppError> {
    let offender = match (target, requested) {
        // The TARGET's current role offends — an admin may not demote or evict an owner.
        (R1Target::Other(c), _) if c > ceiling => {
            Some(("the member you are acting on already has", c))
        }
        // The REQUESTED role offends — an admin may not mint an owner. Applies to a
        // self-target too: you may not raise YOURSELF above your own role either.
        (_, Some(r)) if r > ceiling => Some(("you asked for", r)),
        _ => None,
    };
    match offender {
        None => Ok(()),
        Some((what, role)) => Err(AppError::forbidden(
            ROLE_ABOVE_ACTOR,
            format!(
                "{what} account role `{}`, which is above your effective role for this \
                 request (`{}`). You may not create, promote to, demote from, or remove a \
                 role above your own.",
                role.as_str(),
                ceiling.as_str(),
            ),
        )),
    }
}

/// The effective R-1 ceiling for one mutation, plus the actor it belongs to (which the
/// caller needs in order to tell a self-target from a third party — see [`R1Target`]).
#[derive(Debug, Clone, Copy)]
struct ResolvedCeiling {
    role: AccountRole,
    actor_user_id: Uuid,
}

/// Take the account's OWN row lock — the serialization point every membership mutation in
/// this module holds before it reads a role it then trusts (FIX_ROUND-1 F2, corrected in
/// FIX_ROUND-2).
///
/// # Why this exists, when the owner-row `FOR UPDATE` was already there
///
/// Every mutating path used to serialize on
/// `SELECT user_id FROM account_members WHERE account_id = $1 AND role = 'owner' FOR UPDATE`.
/// [`resolve_ceiling`]'s doc already recorded the flaw: *"it rests on an unstated schema
/// invariant, that an account always has at least one owner row. If that set were ever
/// empty the `FOR UPDATE` would lock nothing and the serialization would evaporate
/// silently."* Three independent blind audit angles found the same thing in #145, and one
/// of them established that the empty state is REACHABLE rather than theoretical:
/// `account_members_user_id_fkey` is `ON DELETE CASCADE` to `users`, and the platform-admin
/// user-delete path hard-deletes a user, so deleting the sole owner's USER row removes the
/// membership without ever passing the `LAST_OWNER` guard.
///
/// The `accounts` row cannot be absent: every caller reached this function through
/// `AccountScope` or `AdminAccountScope`, both of which have already resolved the account.
/// So locking it makes the serialization point non-empty **by construction** rather than by
/// an invariant nothing enforces.
///
/// # `FOR NO KEY UPDATE` (PG) → `BEGIN IMMEDIATE` (SQLite) — this is the whole design
/// of this function
///
/// On Postgres the first version said `FOR UPDATE`, then settled on `FOR NO KEY
/// UPDATE`: PG's implicit `FOR KEY SHARE` on FK-child writes made `FOR UPDATE`
/// block every concurrent write to any of the account's eleven FK children.
/// SQLite has NO row-locking, so that choice does not exist — the serialization
/// point is the DATABASE write lock taken at transaction open. The port keeps
/// the discipline by opening every membership-mutating transaction with
/// `BEGIN IMMEDIATE` (the pool `begin_with` at each mutation site below), which
/// acquires the engine's write lock BEFORE the first read, and this statement
/// becomes what it always partly was: the absent-account 404 check (it is a
/// plain `SELECT`, the lock is already held by the transaction). Two
/// consequences, both stated:
///
/// * the lock granularity is the whole database, not one row — the finer PG
///   grain is not expressible on SQLite (same trade `txresbench-file`'s quota leg
///   records), and the membership mutation paths are short + write-rare, so the
///   coarser grain is the right trade;
/// * the two statements that follow every `lock_account_row` call (the
///   owner-row `SELECT … FOR UPDATE`) lose their locking job too and become
///   plain reads — the lock is `BEGIN IMMEDIATE`, taken earlier and held for
///   the whole transaction.
///
/// # The owner-row lock is KEPT alongside this one rather than replaced
///
/// The owner-row reads still COUNT owners (`LAST_OWNER`), still run behind the
/// write lock, and the comment at their call sites explains that the `FOR
/// UPDATE` clause itself is PG-only syntax — the serialization they provided is
/// the transaction's.
async fn lock_account_row(conn: &mut SqliteConnection, account_id: Uuid) -> Result<(), AppError> {
    let row = sqlx::query_scalar!(r#"SELECT id FROM accounts WHERE id = $1"#, account_id,)
        .fetch_optional(&mut *conn)
        .await
        .map_err(AppError::database_error)?;
    // An ABSENT row is refused, not ignored. The first version discarded the `Option` and
    // returned `Ok(())`, which made this function's whole purpose — "the serialization
    // point is non-empty BY CONSTRUCTION" — evaporate silently for a nonexistent id: the
    // identical failure mode its own doc indicts the owner-row `FOR UPDATE` for. The
    // defence ("every caller reached this through an extractor that already resolved the
    // account") stopped covering all callers the moment `add_member_in_tx` became a public,
    // `&self`-less seam that `routes.rs` instructs #146 to call with its own connection.
    //
    // `404 Account` rather than a 500: it is byte-identical to the extractor's own
    // non-member refusal, so a caller who somehow reaches here with a foreign or invented
    // id learns nothing they did not already know.
    if row.is_none() {
        return Err(AppError::not_found("Account"));
    }
    Ok(())
}

/// Resolve the EFFECTIVE ceiling for `actor`, on the mutation's own transaction
/// connection and AFTER the write-lock-taking statement the mutating functions run first.
/// `Ok(None)` means "no ceiling" ([`ActorCeiling::PlatformStaff`]).
///
/// **What that lock does and does not do — stated precisely, because an earlier version
/// of this comment overclaimed it.** On Postgres the statement is
/// `SELECT user_id FROM account_members WHERE account_id = $1 AND role = 'owner' FOR
/// UPDATE`: it locks the account's OWNER rows only, so an `admin` actor's own membership
/// row is NOT locked and the read below is an ordinary READ COMMITTED read. What
/// actually serializes competing mutations is that EVERY membership-mutation path takes
/// that same owner-row lock first, so at most one of them is past it at a time; this
/// read then observes anything they committed before this transaction won the lock. That
/// is an emergent property of the call sites, not of this function — and it rests on an
/// unstated schema invariant, that an account always has at least one owner row. If that
/// set were ever empty the `FOR UPDATE` would lock nothing and the serialization would
/// evaporate silently. `LAST_OWNER` plus `create_organization`'s seeded owner keep it
/// non-empty today; nothing in the schema enforces it.
///
/// On SQLite the owner-row statement has no `FOR UPDATE` clause at all: the
/// serialization is the database WRITE lock, taken by `BEGIN IMMEDIATE` when the
/// mutation's transaction opens (see `lock_account_row`). The read below therefore
/// observes every transaction that committed before the write lock was acquired — the
/// same "past it at a time" property, enforced by the engine rather than by a row lock,
/// and sound for every account including an ownerless one (the invariant concern above is
/// PG-specific: the write lock cannot be empty).
///
/// # Why the role is re-read here rather than trusted from the extractor
///
/// `AccountScope` read the actor's role BEFORE the transaction opened, so between that
/// read and this write the actor can have been demoted or removed by a concurrent
/// mutation. #171 settled this exact shape and left the correction in the source
/// (`project/repository.rs`): *"The hook LOSES that race; it does not close it. What
/// actually closes it is the locked re-assert INSIDE the transaction."*
///
/// # Why the MINIMUM of the two, and only the minimum
///
/// - A concurrently **demoted** actor is refused — the live role is lower, so it wins.
/// - A concurrently **promoted** actor is ALSO refused, rather than silently exceeding
///   the authority their request was admitted under. That is conservative and
///   self-healing: the next request re-reads and is admitted at the higher role.
///
/// A vanished membership is `404 Account`, byte-identical to `AccountScope`'s own
/// non-member refusal (step 4) — but it is only REACHED when the actor and the target are
/// different people. Both mutating functions look the TARGET up first, so a
/// self-targeting call whose actor has vanished has also lost its target and returns
/// `404 Membership` before ever getting here. The split is self-target vs third party,
/// **not** `set_role` vs `remove_member`: a third-party `remove_member` reaches this line
/// exactly as `set_role` does.
///
/// **Both are 404 and neither is an oracle** — reaching either requires having been a
/// member of this account moments earlier, so the caller already knows it exists. Stated
/// this precisely on the third attempt: the original claimed the two bodies were
/// identical (false), the correction attributed the difference to the wrong axis (also
/// false). A security claim that outruns its code is the kind that survives a refactor of
/// the guard beneath it.
async fn resolve_ceiling(
    conn: &mut SqliteConnection,
    account_id: Uuid,
    actor: ActorCeiling,
) -> Result<Option<ResolvedCeiling>, AppError> {
    let ActorCeiling::SelfService {
        actor_user_id,
        observed_role,
    } = actor
    else {
        return Ok(None);
    };
    let row = sqlx::query!(
        r#"SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2"#,
        account_id,
        actor_user_id,
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(AppError::database_error)?;

    let Some(r) = row else {
        // The actor lost their membership between extraction and this write.
        return Err(AppError::not_found("Account"));
    };
    let live = AccountRole::from_str(&r.role)?;
    Ok(Some(ResolvedCeiling {
        role: observed_role.min(live),
        actor_user_id,
    }))
}

impl AccountRepository {
    /// H-2 (#144) — refuse any membership MUTATION on a personal account, in ONE
    /// place, before any write and before any existence/duplicate probe.
    ///
    /// `AccountRepository::add_member` validated the target USER (404) and the
    /// duplicate membership (409) but never the ACCOUNT's `kind`, so
    /// `POST /api/admin/accounts/{id}/members` would happily add an arbitrary user
    /// to another user's **personal** account. Under A3 DEC-12 account membership is
    /// an implicit per-resource grant, so that single call handed the added user
    /// ≥Viewer over EVERYTHING the victim had ever created — with no share, no
    /// consent, and no affordance on the victim's side. It also silently falsified
    /// the modelling assumption several access predicates document about themselves
    /// ("the only member is the owner"), which is sound only while a personal account
    /// has exactly one member. This guard is what keeps that true.
    ///
    /// Lives in the REPOSITORY, not a handler (#144), so it covers the admin surface
    /// and any future self-service surface at once and cannot be forgotten by a third
    /// caller. The personal-account PROVISIONING paths are exempt BY CONSTRUCTION,
    /// not by exception: `ensure_personal_account`, `ensure_personal_account_in_tx`,
    /// `create_organization` and the `PersonalAccountHook` all seed membership with a
    /// direct `INSERT INTO account_members` and never route through
    /// `add_member`/`set_role`/`remove_member`.
    ///
    /// 422, matching the sibling `LAST_OWNER` guard in the same two functions. Not
    /// 403 (a root admin is equally refused — this is not an authority problem) and
    /// not 404 (the account exists and the caller legitimately resolved it via
    /// `AdminAccountScope`; the anti-oracle 404 idiom is for cross-tenant reads).
    /// A nonexistent account is NOT this guard's business — it returns `Ok(())` and
    /// lets the existing per-operation 404 fire.
    /// **Why this one read is allowed outside the transaction**, when this file spends
    /// pages arguing the ceiling read had to move inside it: `accounts.kind` is written
    /// once at INSERT and never updated anywhere in the tree (`grep -rn "UPDATE accounts"`
    /// finds only `name` and the admin-suspension columns), so there is no window in which
    /// it can change between this read and the write it guards. The ceiling has no such
    /// property — `account_members.role` is exactly what the mutations here change.
    async fn refuse_if_personal(&self, account_id: Uuid) -> Result<(), AppError> {
        let mut conn = self.pool.acquire().await.map_err(AppError::database_error)?;
        Self::refuse_if_personal_on(&mut conn, account_id).await
    }

    /// [`Self::refuse_if_personal`] on a CALLER-SUPPLIED connection (FIX_ROUND-2).
    ///
    /// Needed because [`Self::add_member_in_tx`] has no `&self` — and the first version of
    /// that function simply **omitted the guard**, which a blind correctness audit caught.
    /// That was the precise failure H-2's own doc says the repository placement exists to
    /// prevent: *"so it covers the admin surface and any future self-service surface at
    /// once and cannot be forgotten by a third caller"*. The `_in_tx` seam WAS that third
    /// caller, and it forgot. Under DEC-12 a membership row on a personal account is an
    /// implicit ≥Viewer grant over everything that user ever created, so the omission was
    /// not cosmetic; it was unreachable only because `create_invitation` refuses personal
    /// accounts, i.e. because of a guard on a different function.
    async fn refuse_if_personal_on(
        conn: &mut SqliteConnection,
        account_id: Uuid,
    ) -> Result<(), AppError> {
        let kind = sqlx::query_scalar!("SELECT kind FROM accounts WHERE id = $1", account_id)
            .fetch_optional(&mut *conn)
            .await
            .map_err(AppError::database_error)?;
        match kind {
            Some(k) if AccountKind::from_str(&k)? == AccountKind::Personal => {
                Err(AppError::unprocessable_entity(
                    PERSONAL_ACCOUNT_NOT_MANAGEABLE,
                    "a personal account's membership cannot be modified — it has exactly one \
                     member, its owner, and adding to it would grant access to everything that \
                     user owns",
                ))
            }
            _ => Ok(()),
        }
    }

    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// The acting user's role on `account_id`, or `None` if they are not a member.
    ///
    /// `None` is the **cross-account-404 signal** (mirroring `ProjectScope::resolve
    /// → None`): a resource in an account the caller is not a member of resolves to
    /// 404, never 403 (INV-5). A3's membership-authz layer maps this `None` → 404.
    pub async fn membership_role(
        &self,
        account_id: Uuid,
        user_id: Uuid,
    ) -> Result<Option<AccountRole>, AppError> {
        let row = sqlx::query!(
            r#"SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2"#,
            account_id,
            user_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        match row {
            Some(r) => Ok(Some(AccountRole::from_str(&r.role)?)),
            None => Ok(None),
        }
    }

    /// Does `user_id` hold at least `min` on `account_id`? (`owner ≥ admin ≥
    /// member`.) A non-member yields `false`. The grading primitive A3 binds.
    pub async fn has_role(
        &self,
        account_id: Uuid,
        user_id: Uuid,
        min: AccountRole,
    ) -> Result<bool, AppError> {
        Ok(self
            .membership_role(account_id, user_id)
            .await?
            .map(|r| r.allows(min))
            .unwrap_or(false))
    }

    /// The id of `user_id`'s personal account, or `None` if it does not yet exist
    /// (a user created before A5's signup hook + before any lazy-ensure).
    pub async fn personal_account_of(&self, user_id: Uuid) -> Result<Option<Uuid>, AppError> {
        let row = sqlx::query!(
            r#"SELECT id as "id: Uuid" FROM accounts WHERE kind = 'personal' AND personal_user_id = $1"#,
            user_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.map(|r| r.id))
    }

    /// Batched form of [`personal_account_of`](Self::personal_account_of): resolve the personal
    /// account id for a SET of users in ONE query (`= ANY($1)` on PG; the DEC-12
    /// JSON1-membership port on SQLite), returned as a `user_id → account_id`
    /// map. A user with no personal account is simply ABSENT from the map. This is what lets the
    /// admin user-list projection attach `personal_account_id` for a whole page with a single
    /// round-trip instead of an N+1 fan-out. Read-only (never ensures/creates — a GET must not
    /// mutate).
    ///
    /// # The membership port (SQLite)
    ///
    /// `personal_user_id` is a 16-byte BLOB (DEC-8), so the array bind is
    /// serialized as JSON lowercase-hex strings (`uuid_list_json`, square brackets
    /// per the `*[]` → TEXT JSON-array map) and compared through
    /// `unhex()` — `id IN (SELECT unhex(j.value) FROM json_each($1) AS j)`. A
    /// TEXT-vs-BLOB `=` would never match (SQLite orders storage classes; the
    /// comparison is not equality).
    pub async fn personal_accounts_of(
        &self,
        user_ids: &[Uuid],
    ) -> Result<std::collections::HashMap<Uuid, Uuid>, AppError> {
        if user_ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let json = uuid_list_json(user_ids);
        let rows = sqlx::query!(
            r#"SELECT personal_user_id AS "user_id!: Uuid", id as "id: Uuid"
               FROM accounts
               WHERE kind = 'personal'
                 AND personal_user_id IN (SELECT unhex(j.value) FROM json_each($1) AS j)"#,
            json,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(rows.into_iter().map(|r| (r.user_id, r.id)).collect())
    }

    /// Idempotently ensure `user_id` has a personal account AND owns it, returning
    /// the account id (DEC-7). Creates the `personal` account (ON CONFLICT on the
    /// partial unique index `uq_accounts_personal_user`) AND the `owner`
    /// `account_members` row (ON CONFLICT on the composite PK), in ONE transaction
    /// (guideline §4). Re-running is a no-op (INV-2); concurrent callers converge
    /// on the same account (the losing INSERT blocks on the conflicting tuple, then
    /// the follow-up SELECT reads the committed winner).
    ///
    /// A5's signup hook + first-request backstop and A4's active-account default
    /// bind this.
    pub async fn ensure_personal_account(
        &self,
        user_id: Uuid,
        name: &str,
    ) -> Result<Uuid, AppError> {
        // SQLite port: `BEGIN IMMEDIATE`, so racing callers converge through the
        // write lock instead of one of them losing the INSERT to `SQLITE_BUSY`
        // (the account-baseline doc promises convergence, INV-2).
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let account_id = Self::ensure_personal_account_in_tx(&mut tx, user_id, name).await?;
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(account_id)
    }

    /// The in-transaction twin of [`ensure_personal_account`]: idempotently ensure
    /// `user_id`'s personal account + owner membership using a caller-owned
    /// connection/transaction, returning the account id — WITHOUT opening or
    /// committing a transaction of its own.
    ///
    /// This is the clean in-tx seam the SDK's `UserCreatedHook` (G-AUTHEVT) binds:
    /// the hook receives the live creation-transaction connection, so provisioning
    /// the personal account through this fn is atomic with the user INSERT (the two
    /// commit together, or neither does). `ensure_personal_account` is exactly this
    /// wrapped in `pool.begin()`/`commit()` for the standalone (backstop) callers.
    /// Both share the same race-safe upsert, so a hook creation and a later backstop
    /// ensure for the same user converge on one account (INV-2).
    pub async fn ensure_personal_account_in_tx(
        conn: &mut SqliteConnection,
        user_id: Uuid,
        name: &str,
    ) -> Result<Uuid, AppError> {
        // Insert the personal account, or resolve the existing one — in ONE
        // statement, race-safe under the engine's single-writer model. The partial-unique conflict
        // target serializes racing callers (a loser's INSERT blocks on the winner's
        // tuple, then takes the ON CONFLICT path once the winner commits — on SQLite
        // the block is the write-lock contention `busy_timeout` resolves; see
        // `ensure_personal_account`'s doc). We use
        // `DO UPDATE SET name = accounts.name` — a deliberate NO-OP write to the
        // row's own value — rather than `DO NOTHING`, because `DO NOTHING` returns
        // NO row on conflict, which would force a follow-up SELECT whose snapshot
        // could predate the winner's commit under REPEATABLE READ / SERIALIZABLE.
        // `DO UPDATE` RETURNs the conflicting row's id directly — no second read,
        // no isolation-level assumption (blind-audit finding AUD-1 → DRIFT-1.3).
        //
        // DEC-12: the `gen_random_uuid()` SQL default does not exist on SQLite —
        // the id is bound app-side (`Uuid::new_v4()`), the same rule every other
        // write in the ported surface follows.
        let account_id = Uuid::new_v4();
        let account_id_row = sqlx::query!(
            r#"INSERT INTO accounts (id, kind, name, personal_user_id)
               VALUES ($1, 'personal', $2, $3)
               ON CONFLICT (personal_user_id) WHERE kind = 'personal'
                   DO UPDATE SET name = accounts.name
               RETURNING id as "id: Uuid""#,
            account_id,
            name,
            user_id,
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(AppError::database_error)?
        .id;

        // Ensure the owner membership (idempotent on the composite PK).
        let inserted = sqlx::query!(
            r#"INSERT INTO account_members (account_id, user_id, role)
               VALUES ($1, $2, 'owner')
               ON CONFLICT (account_id, user_id) DO NOTHING"#,
            account_id_row,
            user_id,
        )
        .execute(&mut *conn)
        .await
        .map_err(AppError::database_error)?
        .rows_affected();

        // #148 — the `system` PROVISIONING row: an unattended action with no human actor, on
        // the caller's own connection so it is atomic with whatever created the user. This is
        // the actor kind the ledger's `actor_kind` column exists to make distinguishable from
        // the other two, and the personal-account hook is its only producer today.
        //
        // Gated on `rows_affected` because this function is IDEMPOTENT and re-run freely (the
        // signup hook AND the first-request backstop both call it). An unconditional write
        // would append a duplicate `joined` row on every re-ensure and the ledger would report
        // a membership that never changed as changing repeatedly — the append-only table
        // cannot take it back afterwards.
        if inserted > 0 {
            record_member_event(
                &mut *conn,
                NewMemberEvent::about(
                    account_id_row,
                    AuditActor::System,
                    MemberEventAction::Joined,
                    user_id,
                )
                .with_roles(None, Some(AccountRole::Owner)),
            )
            .await?;
        }

        Ok(account_id_row)
    }

    /// Every account `user_id` is a member of — the account-switcher list (A4).
    pub async fn list_user_accounts(&self, user_id: Uuid) -> Result<Vec<Account>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT a.id as "id: Uuid", a.kind, a.name,
                      a.personal_user_id as "personal_user_id: Uuid",
                      a.created_at as "created_at: DateTime<Utc>",
                      a.updated_at as "updated_at: DateTime<Utc>"
               FROM accounts a
               JOIN account_members m ON m.account_id = a.id
               WHERE m.user_id = $1
               ORDER BY a.created_at ASC"#,
            user_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        rows.into_iter()
            .map(|r| {
                Ok(Account {
                    id: r.id,
                    kind: AccountKind::from_str(&r.kind)?,
                    name: r.name,
                    personal_user_id: r.personal_user_id,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                })
            })
            .collect()
    }

    /// Every membership of `account_id` — the fan-out audience source (A4).
    pub async fn list_members(&self, account_id: Uuid) -> Result<Vec<AccountMember>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT m.account_id as "account_id: Uuid", m.user_id as "user_id: Uuid", m.role,
                      m.created_at as "created_at: DateTime<Utc>",
                      u.username, u.email, u.display_name
               FROM account_members m
               JOIN users u ON u.id = m.user_id
               WHERE m.account_id = $1
               ORDER BY m.created_at ASC"#,
            account_id,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        rows.into_iter()
            .map(|r| {
                Ok(AccountMember {
                    account_id: r.account_id,
                    user_id: r.user_id,
                    role: AccountRole::from_str(&r.role)?,
                    created_at: r.created_at,
                    username: r.username,
                    email: r.email,
                    display_name: r.display_name,
                })
            })
            .collect()
    }

    /// Count `account_id`'s members — drives "Showing N of M" on the paged members
    /// list (A4 ITEM-2/8).
    pub async fn count_members(&self, account_id: Uuid) -> Result<i64, AppError> {
        let row = sqlx::query!(
            r#"SELECT COUNT(*) as "count!" FROM account_members WHERE account_id = $1"#,
            account_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.count)
    }

    /// One page of `account_id`'s members (bounded — the numbered settings-list
    /// idiom; guideline §4 no unbounded select). Same ordering as `list_members`.
    pub async fn list_members_paged(
        &self,
        account_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<AccountMember>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT m.account_id as "account_id: Uuid", m.user_id as "user_id: Uuid", m.role,
                      m.created_at as "created_at: DateTime<Utc>",
                      u.username, u.email, u.display_name
               FROM account_members m
               JOIN users u ON u.id = m.user_id
               WHERE m.account_id = $1
               ORDER BY m.created_at ASC
               LIMIT $2 OFFSET $3"#,
            account_id,
            limit,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        rows.into_iter()
            .map(|r| {
                Ok(AccountMember {
                    account_id: r.account_id,
                    user_id: r.user_id,
                    role: AccountRole::from_str(&r.role)?,
                    created_at: r.created_at,
                    username: r.username,
                    email: r.email,
                    display_name: r.display_name,
                })
            })
            .collect()
    }

    // ==================== admin cross-account surface (#33/#34/#35) ==============

    /// Count ALL accounts (membership-free), optionally filtered by `kind` — the
    /// `total` for the admin "Showing N of M" list (#33). Admin-only via the route
    /// gate; the repository is membership-neutral.
    pub async fn count_all_accounts(&self, kind: Option<AccountKind>) -> Result<i64, AppError> {
        let kind_s = kind.map(|k| k.as_str());
        let row = sqlx::query!(
            r#"SELECT COUNT(*) as "count!"
               FROM accounts
               WHERE ($1 IS NULL OR kind = $1)"#,
            kind_s,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.count)
    }

    /// One page of ALL accounts (membership-FREE — the #33 cross-account admin list),
    /// optionally filtered by `kind`, each with its member count + (cheap) owner user
    /// id. Bounded (guideline §4: never unbounded). Ordered `created_at ASC` for a
    /// stable page. The owner is the earliest `Owner`-role member (a personal
    /// account's sole member).
    pub async fn list_all_accounts(
        &self,
        limit: i64,
        offset: i64,
        kind: Option<AccountKind>,
    ) -> Result<Vec<AdminAccountSummary>, AppError> {
        let kind_s = kind.map(|k| k.as_str());
        let rows = sqlx::query!(
            r#"SELECT a.id as "id: Uuid", a.kind, a.name,
                      a.personal_user_id as "personal_user_id: Uuid",
                      a.created_at as "created_at: DateTime<Utc>",
                      a.updated_at as "updated_at: DateTime<Utc>",
                      (SELECT COUNT(*) FROM account_members m WHERE m.account_id = a.id)
                          as "member_count!",
                      (SELECT m2.user_id FROM account_members m2
                       WHERE m2.account_id = a.id AND m2.role = 'owner'
                       ORDER BY m2.created_at ASC, m2.user_id ASC LIMIT 1)
                          as "owner_user_id?: Uuid",
                      (SELECT COALESCE(u.display_name, u.username)
                       FROM account_members m3
                       JOIN users u ON u.id = m3.user_id
                       WHERE m3.account_id = a.id AND m3.role = 'owner'
                       ORDER BY m3.created_at ASC, m3.user_id ASC LIMIT 1)
                          as "owner_label?"
               FROM accounts a
               WHERE ($1 IS NULL OR a.kind = $1)
               ORDER BY a.created_at ASC, a.id ASC
               LIMIT $2 OFFSET $3"#,
            kind_s,
            limit,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        rows.into_iter()
            .map(|r| {
                Ok(AdminAccountSummary {
                    account: Account {
                        id: r.id,
                        kind: AccountKind::from_str(&r.kind)?,
                        name: r.name,
                        personal_user_id: r.personal_user_id,
                        created_at: r.created_at,
                        updated_at: r.updated_at,
                    },
                    member_count: r.member_count,
                    owner_user_id: r.owner_user_id,
                    owner_label: r.owner_label,
                })
            })
            .collect()
    }

    /// Create an ORGANIZATION account (#34) AND its `owner` membership in ONE
    /// transaction (atomic — INV-2). The account is inserted FIRST, then the owner
    /// membership; if `owner_id` is a phantom user the `account_members.user_id` FK
    /// trips and the WHOLE tx (the just-inserted account included) rolls back → 404,
    /// no orphan account. `personal_user_id` is left NULL (an org — satisfies the
    /// `accounts_personal_has_user` CHECK). Mirrors `ensure_personal_account`'s tx.
    ///
    /// **#148 — `actor` is the CALLER, which is not necessarily `owner_id`.** This route is
    /// gated on the admin-only `account::manage` capability and accepts an explicit
    /// `owner_id`, so an operator can found an organization owned by somebody else. The
    /// founding `joined` row must therefore name WHO CREATED IT, not merely who ended up
    /// owning it — attributing the row to `owner_id` would make the ledger report that a user
    /// added themselves to an account they had no part in creating, which is precisely the
    /// kind of false attribution an audit trail must never produce.
    pub async fn create_organization(
        &self,
        name: &str,
        owner_id: Uuid,
        actor: AuditActor,
    ) -> Result<Account, AppError> {
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;

        // DEC-12: no `gen_random_uuid()` on SQLite — the id is bound app-side.
        let account_id = Uuid::new_v4();
        let row = sqlx::query!(
            r#"INSERT INTO accounts (id, kind, name, personal_user_id)
               VALUES ($1, 'organization', $2, NULL)
               RETURNING id as "id: Uuid", kind, name,
                         personal_user_id as "personal_user_id?: Uuid",
                         created_at as "created_at: DateTime<Utc>",
                         updated_at as "updated_at: DateTime<Utc>""#,
            account_id,
            name,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // The owner membership. A phantom `owner_id` trips the user FK — the tx (with
        // the account) rolls back, so a failed create leaves nothing (the atomicity
        // INV-2 asserts, proven by the phantom-owner acceptance test).
        if let Err(err) = sqlx::query!(
            r#"INSERT INTO account_members (account_id, user_id, role)
               VALUES ($1, $2, 'owner')"#,
            row.id,
            owner_id,
        )
        .execute(&mut *tx)
        .await
        {
            return Err(map_member_user_fk(err));
        }

        // #148 — the FOUNDING owner's `joined` row, in the same transaction as the account and
        // the membership it records. Without it every organization's ledger opens with a hole
        // where its first owner appeared from nowhere, which is precisely the question
        // ("who was in this account, and since when?") the current-state columns cannot answer
        // and this ledger shape exists to answer. Attributed to the CALLER, who is not always
        // the owner, and classified `admin` because this route is gated on the platform-staff
        // capability — see this function's doc comment and DEC-17. An earlier version of this
        // comment claimed "the actor and the target are the same person, and that is the
        // truth"; it was neither, and a blind audit reproduced the leak it caused.
        record_member_event(
            &mut tx,
            NewMemberEvent::about(row.id, actor, MemberEventAction::Joined, owner_id)
                .with_roles(None, Some(AccountRole::Owner)),
        )
        .await?;

        tx.commit().await.map_err(AppError::database_error)?;

        Ok(Account {
            id: row.id,
            kind: AccountKind::from_str(&row.kind)?,
            name: row.name,
            personal_user_id: row.personal_user_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }

    /// Add `user_id` to `account_id` with `role` (#35). Validates the user EXISTS
    /// (404) and is NOT already a member (409) — INV-4. Both checks are done by the
    /// DB in the single INSERT (no TOCTOU pre-read): `ON CONFLICT DO NOTHING` +
    /// `None ⇒ 409` for the duplicate, and the `user_id` FK ⇒ 404 for a phantom user.
    /// The account is guaranteed to exist (the caller resolved it via
    /// `AdminAccountScope` or `AccountScope`), so a user-FK violation can only be the
    /// target user.
    ///
    /// # R-1 IS enforced here as of #145 — this is the function that CREATES a role
    ///
    /// #142 shipped [`ActorCeiling`] on `set_role` and `remove_member` and left this one
    /// out, recording the omission in a loud block comment: `add_member` is *"the one
    /// function that CREATES a role from nothing — so `add_member(acct, user,
    /// AccountRole::Owner)` compiles, runs, and mints tenant-wide delete/transfer/share
    /// authority (DEC-12) with no ceiling check anywhere"*, safe only because its single
    /// production caller was the platform-staff surface. That made INV-R1 — *"an account
    /// Admin cannot create a principal holding account Owner, **via ANY surface**"* —
    /// false as stated, and true only as an accident of the call graph.
    ///
    /// #145 closes it, doing the two things #142 said had to be done together and in the
    /// order it prescribed:
    ///
    /// 1. **The transaction and the owner lock come first.** `resolve_ceiling`'s live
    ///    re-read is only sound on a connection that already holds the account's owner
    ///    rows, because that lock is what serializes this against every other membership
    ///    mutation (all of them take it first). This function opened no transaction
    ///    before; it does now, and the INSERT rides it.
    /// 2. **The ceiling is a REQUIRED parameter, and the REQUESTED role is graded against
    ///    it** — [`R1Target::NewMember`], since there is no incumbent to outrank.
    ///
    /// **Why this landed in #145, which mounts no add-member route.** The item that adds
    /// the first non-staff caller is #146 (invitation accept). Deferring the threading to
    /// #146 would have handed the guard to the item under the most pressure to simply
    /// make redemption work; doing it here means #146 opens its transaction against a
    /// signature that has no shape in which to omit the ceiling. That is the property
    /// #142 named as the whole point of a required argument. It is not a dead guard: the
    /// admin surface reaches it on every call at
    /// [`ActorCeiling::PlatformStaff`], and the REFUSAL is exercised through a
    /// `SelfService` ceiling by this module's acceptance test — the arm that was not
    /// expressible before.
    ///
    /// `PlatformStaff` skips the guard, as everywhere else: the admin surface is where an
    /// operator repairs an account whose own owners cannot or will not, and its behaviour
    /// here is byte-identical to before this change.
    pub async fn add_member(
        &self,
        account_id: Uuid,
        user_id: Uuid,
        role: AccountRole,
        actor: ActorCeiling,
    ) -> Result<AccountMember, AppError> {
        // H-2 (#144): refuse on a PERSONAL account before touching anything.
        //
        // Left OUTSIDE the transaction, matching `set_role`/`remove_member` and for the
        // reason `refuse_if_personal`'s own doc gives: `accounts.kind` is written once at
        // INSERT and never updated anywhere in the tree, so there is no window in which it
        // can change between this read and the write it guards. The ceiling has no such
        // property, which is exactly why THAT read had to move inside.
        // Deliberately kept here as well as inside `add_member_in_tx`: this one fails
        // BEFORE a transaction is opened (cheaper, and it is what the pre-#145 behaviour
        // did), and the one inside is what makes the guard unforgettable for #146's caller.
        // `accounts.kind` is write-once, so the two reads cannot disagree.
        self.refuse_if_personal(account_id).await?;

        // SQLite port: `BEGIN IMMEDIATE` — the transaction takes the database
        // write lock at open, which is what the PG owner-row `FOR UPDATE`s
        // provided (see `lock_account_row` for the full substitution note).
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        let member =
            Self::add_member_in_tx(&mut tx, account_id, user_id, role, actor, None).await?;
        tx.commit().await.map_err(AppError::database_error)?;
        Ok(member)
    }

    /// [`Self::add_member`]'s body, on a CALLER-SUPPLIED connection — the seam **#146's
    /// accept transaction must use** (FIX_ROUND-1, F8).
    ///
    /// # Why this exists, and why its absence was a blocking defect
    ///
    /// A blind design-conformance audit established that shipping only the pool-owning
    /// `add_member` made #146's stated contract *unsatisfiable*, in two ways at once:
    ///
    /// 1. **#146 INV-17 could not hold.** Its step 5 requires the membership INSERT and the
    ///    `accepted_at`/`accepted_by` stamp to "roll back together or not at all".
    ///    `add_member` commits on its own, so a failure after it would leave a committed
    ///    membership with no stamp — a redeemed invitation that still looks pending.
    /// 2. **The instruction left for #146 self-deadlocked.** It says: open the accept
    ///    transaction, take the account lock, re-read the inviter's role, then call
    ///    `add_member`. On a pool-owning `add_member` that call runs on a DIFFERENT
    ///    connection and re-issues the same `FOR UPDATE` against rows the caller's
    ///    transaction already holds. The inner statement waits on the outer transaction,
    ///    which is waiting on the inner call — and because the two are separate sessions
    ///    Postgres sees no lock cycle, so its deadlock detector never fires. The request
    ///    hangs, holding two pool connections, until something times out.
    ///
    /// The escape #146 would have taken is to bypass `add_member` and inline its INSERT —
    /// which dissolves the whole point of making [`ActorCeiling`] a required parameter.
    /// So the seam is shipped here, following this module's own established idiom
    /// (`ensure_personal_account` / `ensure_personal_account_in_tx`).
    ///
    /// Re-taking the locks inside the caller's transaction is a no-op: a transaction that
    /// already holds a row lock re-acquires it for free. That is why this function still
    /// takes them itself rather than trusting the caller to have done so — a caller that
    /// forgot would otherwise get an unserialized ceiling read, silently.
    ///
    /// # `invitation_id` — the FK that ties `invited` → `joined` (#146 DEC-4)
    ///
    /// `Some(id)` only from #146's accept path, where the membership exists BECAUSE that
    /// invitation was redeemed; `None` from every other caller, including the admin add.
    /// Research §8's column table names it as the tie between the two ledger rows, and #145
    /// already writes it on `invite_revoked`; leaving it NULL here would silently drop a
    /// stated design property and make "who was invited, and did they ever join?"
    /// unanswerable from the ledger.
    ///
    /// It is a PARAMETER rather than something the accept path writes itself, for the same
    /// reason `actor` is one: the `joined` row is constructed inside this function, on the
    /// caller's connection, so a second audit write outside it would be a row that can be
    /// lost independently of the membership it records — the exact property
    /// `record_member_event`'s signature exists to make impossible.
    pub async fn add_member_in_tx(
        conn: &mut SqliteConnection,
        account_id: Uuid,
        user_id: Uuid,
        role: AccountRole,
        actor: ActorCeiling,
        invitation_id: Option<Uuid>,
    ) -> Result<AccountMember, AppError> {
        // H-2 (#144) — the personal-account refusal, on THIS connection (FIX_ROUND-2).
        // The pool-owning wrapper calls it before `begin()`; this seam must call it too, or
        // it becomes the "third caller that forgets" H-2's placement exists to prevent.
        Self::refuse_if_personal_on(&mut *conn, account_id).await?;

        // The account row first, so the serialization point is non-empty even for an
        // account with no owner rows. See `lock_account_row`.
        lock_account_row(&mut *conn, account_id).await?;

        // Then the account's owner rows — the lock every other membership-mutating
        // path takes first, in the same order, so no cycle is expressible. On SQLite
        // the clause is gone: the rows' read is the `LAST_OWNER` counting read (below),
        // and what they used to LOCK is the transaction's `BEGIN IMMEDIATE` write
        // lock (see `lock_account_row`). The read is kept for its own value here:
        // it proves the caller's account has an owner row set (the invariant the
        // `resolve_ceiling` doc records as PG-specific) and the two reads stay
        // ordered behind the lock.
        sqlx::query!(
            r#"SELECT user_id FROM account_members
               WHERE account_id = $1 AND role = 'owner'"#,
            account_id,
        )
        .fetch_all(&mut *conn)
        .await
        .map_err(AppError::database_error)?;

        // #141 (FIX_ROUND-5, R5-3) — the transaction-context assertion runs HERE, before the
        // ceiling re-read, not later inside the seat check.
        //
        // It was placed inside `enforce_member_seat`, below this point, and justified by the
        // claim that it "protects `resolve_ceiling`'s live R-1 re-read". A blind audit
        // observed that the placement did not deliver that: on an autocommit connection the
        // R-1 re-read STILL ran unserialized, and the guard merely refused afterwards — the
        // read was never made sound, and any future write inserted between the two would
        // have silently removed even that. `lock_account_row` above has already assigned an
        // xid, so asserting here is both possible and strictly better: the ceiling re-read,
        // the seat count and the INSERT all now run only on a connection proven to be in a
        // READ COMMITTED transaction holding this account's row.
        //
        // Unconditional, in both builds, because R-1 is a SECURITY control and runs in both.
        super::seat::assert_serializable_context(&mut *conn).await?;

        // R-1 — only the REQUESTED half can bind: there is no incumbent row to outrank,
        // which is what `R1Target::NewMember` says. `PlatformStaff` ⇒ `None` ⇒ no guard.
        if let Some(c) = resolve_ceiling(&mut *conn, account_id, actor).await? {
            refuse_if_above_ceiling(c.role, R1Target::NewMember, Some(role))?;
        }

        // #141 — the SEAT allowance. THE authoritative check: this is the one function
        // through which every membership added to an EXISTING account passes (the admin
        // path via `add_member`, #146's invitation accept via this seam), so it is the one
        // place the plan's `member_allowance` is enforced. See `account::seat` for what
        // counts as a seat and why, and for why the advisory check in `create_invitation`
        // is not a second source of truth.
        //
        // POSITION IS LOAD-BEARING, in three ways:
        //  * AFTER `lock_account_row` + the owner-row read above (behind the
        //    transaction's write lock — `BEGIN IMMEDIATE` on SQLite, the owner-row
        //    `FOR UPDATE` on PG), so the count is taken behind the serialization point
        //    every membership mutation takes first.
        //    Two concurrent adds against the last free seat therefore cannot both pass —
        //    the second blocks until the first commits and then counts the committed row.
        //    A count taken before the lock, or on a pooled connection, is the check-then-act
        //    race #142's `min(observed, live)` pattern exists to prevent.
        //  * AFTER the R-1 ceiling check, so an authorization refusal (403 ROLE_ABOVE_ACTOR)
        //    is never masked by a resource condition, and an actor who fails R-1 does not
        //    learn the account's member count from the refusal's `details`.
        //  * BEFORE the INSERT, so a refusal writes NOTHING. That is what leaves a
        //    seat-refused invitation still pending and redeemable later rather than burned:
        //    #146's accept transaction rolls back with `accepted_at` unstamped.
        //
        // NO EVICTION: this refuses the next add and removes nobody. An account already
        // above its allowance keeps every member (see `billing::seat::decide_seat`).
        //
        // `user_id` is passed so the check can EXCLUDE them when they are already a member:
        // the INSERT below is `ON CONFLICT DO NOTHING`, so re-adding an existing member
        // consumes no seat and must keep returning the pre-existing 409 rather than a seat
        // refusal (FIX_ROUND-1, F2 — corroborated by both blind audit angles).
        //
        // On a build without `saas` this is a no-op — the account module stays unconditional
        // and the membership routes are reachable in both builds (research §5 / INV-3). The
        // `cfg` lives inside `account::seat`, not here, because
        // `tests/account/saas_gating_test.rs` asserts this file carries none.
        super::seat::enforce_member_seat(&mut *conn, account_id, user_id).await?;

        // #148 — the audit row for a membership CREATION belongs here, on `&mut tx`, so it
        // commits with the INSERT or not at all. It is descoped from #145 because
        // `account_member_events` does not exist yet and #148 is downstream — not because
        // the obligation lapsed. The same caveat as at `remove_member` applies:
        // `ActorCeiling::PlatformStaff` carries no actor id, so #148 must widen it (or
        // pass the staff actor separately) before it can attribute a staff add.

        // A RETURNING clause cannot JOIN (and SQLite does not allow data-modifying
        // statements in a CTE at all — the PG `WITH ins AS (INSERT … RETURNING …)`
        // shape is not a SQLite construct), so the INSERT … RETURNING and the
        // `users` identity lookup are TWO statements on the same connection, inside
        // the same transaction. `ON CONFLICT DO NOTHING` still yields zero rows on a
        // duplicate → `None ⇒ 409`, exactly as before.
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let role_str = role.as_str();
        let row = match sqlx::query!(
            r#"INSERT INTO account_members (account_id, user_id, role)
               VALUES ($1, $2, $3)
               ON CONFLICT (account_id, user_id) DO NOTHING
               RETURNING account_id as "account_id: Uuid",
                         user_id as "user_id: Uuid", role,
                         created_at as "created_at: DateTime<Utc>""#,
            account_id,
            user_id,
            role_str,
        )
        .fetch_optional(&mut *conn)
        .await
        {
            Ok(row) => row,
            // The error mapping is UNCHANGED by the move into a transaction: a `user_id`
            // FK violation is still 404 (phantom user), anything else still 500. The error
            // propagates to the caller, whose transaction rolls back — for the pool-owning
            // wrapper the INSERT is the only write it carries, so a rollback and the
            // pre-#145 no-transaction failure are observationally identical.
            Err(err) => return Err(map_member_user_fk(err)),
        };

        // The 409 and 404 arms both return `Err`, and this function does not own the
        // transaction — so the caller's `?` propagates and nothing it did is committed. A
        // refused add therefore leaves no membership AND no ledger row: the same "a refused
        // action is not an audited action" property the two mutating functions get from their
        // guards (#148 DEC-1). The audit row is written only on the arm that returns Ok.
        match row {
            Some(r) => {
                // The member's human identity, read separately on the same connection
                // (#51 — the RETURNING did not join). The row exists (just inserted),
                // so the lookup cannot miss under the transaction's write lock.
                let identity = sqlx::query!(
                    r#"SELECT username, email, display_name FROM users WHERE id = $1"#,
                    r.user_id,
                )
                .fetch_one(&mut *conn)
                .await
                .map_err(AppError::database_error)?;
                // #148 — on the CALLER'S connection, so the membership and its ledger row
                // commit together whether the caller is `add_member`'s own transaction or
                // #146's accept transaction. The actor is DERIVED from the ceiling, so the
                // authority R-1 was graded against and the actor the ledger names cannot
                // disagree — which is why this function takes one parameter, not two.
                record_member_event(
                    &mut *conn,
                    NewMemberEvent {
                        // #146 — the invitation this membership was redeemed from, or `None`
                        // for every other caller. Everything else is `about(..)`'s shape.
                        invitation_id,
                        ..NewMemberEvent::about(
                            account_id,
                            actor.audit_actor(),
                            MemberEventAction::Joined,
                            user_id,
                        )
                        .with_roles(None, Some(role))
                    },
                )
                .await?;
                Ok(AccountMember {
                    account_id: r.account_id,
                    user_id: r.user_id,
                    role: AccountRole::from_str(&r.role)?,
                    created_at: r.created_at,
                    username: identity.username,
                    email: identity.email,
                    display_name: identity.display_name,
                })
            }
            // No row ⇒ the (account,user) already existed — a duplicate membership.
            // Returned WITHOUT committing, exactly as the pre-#145 version returned
            // without writing.
            None => Err(AppError::conflict("Membership")),
        }
    }

    /// Remove `user_id` from `account_id` (#35), refusing to delete the SOLE
    /// remaining owner (INV-3, 422). Race-safe: in ONE tx it locks the owner rows
    /// (`FOR UPDATE`) before counting them, so two concurrent "remove the other
    /// owner" calls cannot both pass and leave the account ownerless. 404 if the
    /// membership does not exist.
    ///
    /// **#171 (a) — this is the OFFBOARDING HOOK.** Removal now also cancels every
    /// still-pending project transfer the departing member is a party to on this
    /// account's projects, in EITHER direction, inside this same transaction. Without
    /// it, a member who had been offered (or who had offered) an org project kept a
    /// live path to move that project into a personal account AFTER losing all
    /// relationship to the tenant — `accept_transfer` re-stamps `projects.account_id`,
    /// so the resource leaves the organization entirely.
    ///
    /// It hangs HERE, on the repository, and not on the admin handler, for the same
    /// reason `refuse_if_personal` does (H-2/#144, pinned by a test asserting that
    /// architecture): this is the one function every removal path reaches. The admin
    /// route is its only production caller today; the self-service membership
    /// mutations of #142 inherit it with no further edit, and a handler-level hook
    /// would silently not cover them.
    ///
    /// Returns the cancelled transfers so the caller can tell BOTH parties (DEC-10) —
    /// a third party performed the removal, so neither party's device has a local
    /// mutation of its own to echo.
    pub async fn remove_member(
        &self,
        account_id: Uuid,
        user_id: Uuid,
        actor: ActorCeiling,
    ) -> Result<Vec<CancelledTransfer>, AppError> {
        // H-2 (#144): refuse on a PERSONAL account BY NAME. `LAST_OWNER` happens to
        // catch this today, but only by the accident of there being exactly one
        // owner; the refusal must not depend on that accident (TEST-22 asserts the
        // code is PERSONAL_ACCOUNT_NOT_MANAGEABLE, not LAST_OWNER). Removing the
        // personal owner would leave the user's own resources in an ownerless
        // account — and, since H-1 now requires membership on every creator branch,
        // would lock them out of everything they own.
        self.refuse_if_personal(account_id).await?;
        // SQLite port: `BEGIN IMMEDIATE` (see `add_member` — the PG row locks
        // are the transaction's write lock on this engine).
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;

        // FIX_ROUND-1 (F2): the account row first, so the serialization point cannot be
        // empty. See `lock_account_row`.
        lock_account_row(&mut tx, account_id).await?;

        // Then the owner rows — what the `LAST_OWNER` guard counts under. The
        // `FOR UPDATE` clause is gone (the lock is the transaction's, see
        // `lock_account_row`); the read itself is unchanged.
        let owner_count = sqlx::query!(
            r#"SELECT user_id FROM account_members
               WHERE account_id = $1 AND role = 'owner'"#,
            account_id,
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .len();

        let target = sqlx::query!(
            r#"SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2"#,
            account_id,
            user_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let Some(t) = target else {
            return Err(AppError::not_found("Membership"));
        };
        let target_role = AccountRole::from_str(&t.role)?;

        // R-1 (#142) — the role-escalation guard, graded on the ceiling re-read LIVE on
        // THIS transaction's connection (so a concurrent demotion of the actor cannot be
        // outrun). It runs BEFORE the `LAST_OWNER` comparison on purpose: authority is a
        // different question from the account's integrity, and an actor who may not touch
        // an Owner should be told so rather than handed the account's owner count.
        //
        // It cannot short-circuit the last-owner path it precedes, and the reason is
        // structural rather than incidental: a self-removal is graded as
        // `R1Target::Actor`, whose CURRENT-role half is vacuous, and a removal requests
        // no role — so for `leave` and self-removal R-1 has nothing left to refuse and
        // `LAST_OWNER` is necessarily what answers. (An earlier version of this comment
        // reasoned instead that `target_role` IS the ceiling, which is FALSE whenever the
        // actor was concurrently promoted: the ceiling is clamped to the admitted role
        // while the row already carries the higher live one, and `leave` then returned
        // 403. That is the defect `R1Target::Actor` exists to close.) `PlatformStaff`
        // yields `None` and skips the guard entirely — the admin surface is unchanged.
        if let Some(c) = resolve_ceiling(&mut tx, account_id, actor).await? {
            // `leave` and a self-removal aim at the actor's own row — see
            // `R1Target::Actor`. A removal requests no role, so for a self-target R-1
            // cannot refuse at all and `LAST_OWNER` below is the only guard that can.
            let target = if user_id == c.actor_user_id {
                R1Target::Actor
            } else {
                R1Target::Other(target_role)
            };
            refuse_if_above_ceiling(c.role, target, None)?;
        }

        if target_role == AccountRole::Owner && owner_count <= 1 {
            return Err(AppError::unprocessable_entity(
                "LAST_OWNER",
                "an account must keep at least one owner",
            ));
        }

        // #171 (a) — in the SAME transaction as the membership DELETE (DEC-6), and
        // deliberately BEFORE it (DEC-33). A committed removal whose transfer
        // cancellation silently did not happen is precisely the half-applied
        // offboarding state this exists to prevent — the shape #147's INV-11d already
        // refuses for the reassignment half — and the ORDER is what makes that true
        // under concurrency rather than only in a quiet system.
        //
        // With the cancellation LAST, this transaction spent its whole life holding
        // membership locks and none on `project_transfers`, so a concurrent
        // `accept_transfer` could slip in between the membership DELETE and this
        // statement, claim the transfer, re-stamp the project into the recipient's
        // personal account and commit — after which this DELETE woke, found
        // `status = 'accepted'`, removed 0 rows, and the removal COMMITTED reporting
        // success. The project had left the tenant with the departing member and
        // nothing reported a problem. That was verified against a real Postgres, not
        // theorised, and it is INV-1 failing exactly the way the owner named: one
        // mechanism failing SILENTLY. Half (b) cannot cover it — in that direction the
        // INITIATOR's authority is intact, which is #171 path 1.
        //
        // Taking the `project_transfers` rows FIRST closes it: a concurrent accept's
        // `UPDATE ... WHERE status = 'pending'` now blocks on rows this transaction
        // has already claimed, and on commit finds them gone and refuses. If the
        // accept genuinely got there first, this DELETE removes 0 rows and reports so
        // — the honest outcome for that ordering, since the transfer really did
        // complete while the member was still a member. Pinned by TEST-18.
        let cancelled = ProjectRepository::cancel_pending_transfers_for_removed_member(
            &mut tx, account_id, user_id,
        )
        .await?;

        // #148 — THE MEMBERSHIP AUDIT ROW, on `&mut tx`, so it commits with the removal or
        // not at all (#142's "Other obligations": "Every mutation writes an audit event
        // (#148) in the same transaction"). #142 filed this seam and named its one blocker:
        // `ActorCeiling::PlatformStaff` was a unit variant carrying no id, so a staff removal
        // could not be attributed. #148 widened it, so `audit_actor()` below is total.
        //
        // It sits BEFORE the DELETE deliberately. Every refusal above (`ROLE_ABOVE_ACTOR`,
        // `LAST_OWNER`, the 404s) has already returned, so this line is reached only by a
        // removal that is going to be attempted — and if the DELETE or the commit then fails,
        // this row rolls back with it. A refused action is not an audited action (#148 DEC-1),
        // and that is enforced by the transaction rather than by a branch.
        //
        // `removal_action` — not the route — decides `left` vs `removed`, because #142's
        // INV-R2 funnels `POST …/members/leave` and `DELETE …/members/{user_id}` through THIS
        // function and the row is what has to tell a self-removal from an eviction.
        //
        // Note for an incident reader (#172): `removed`/`left` records the MEMBERSHIP ending.
        // It does not mean access was fully revoked — `project_shares`/`dataset_shares` survive
        // a removal today. Do not read this row as "access revoked".
        let audit_actor = actor.audit_actor();
        record_member_event(
            &mut tx,
            NewMemberEvent::about(
                account_id,
                audit_actor,
                removal_action(audit_actor, user_id),
                user_id,
            )
            .with_roles(Some(target_role), None),
        )
        .await?;

        let removed = sqlx::query!(
            r#"DELETE FROM account_members WHERE account_id = $1 AND user_id = $2"#,
            account_id,
            user_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .rows_affected();

        // #148 — the DELETE's own result, which nothing checked before. The
        // serialization above (the owner-row read behind the transaction's
        // `BEGIN IMMEDIATE` write lock on SQLite; the `FOR UPDATE` owner rows on
        // PG) serializes the two repository mutators against each other, but it
        // never covers a non-owner target — so the membership can vanish between the
        // target SELECT and this statement (the `users` FK cascade does exactly that, at
        // a layer this transaction does not serialize against). Without this check the
        // transaction would commit an audit row recording a removal it did not perform,
        // and the ledger is APPEND-ONLY: a false row cannot be corrected, only annotated.
        // Returning the same 404 the target lookup would have returned rolls the audit
        // row back with it.
        if removed == 0 {
            return Err(AppError::not_found("Membership"));
        }

        tx.commit().await.map_err(AppError::database_error)?;
        Ok(cancelled)
    }

    /// Change `user_id`'s role on `account_id` (#35), refusing to demote the SOLE
    /// remaining owner off `owner` (INV-3, 422). Same race-safe guard as
    /// [`remove_member`] (lock owner rows before the check + UPDATE, one tx). 404 if
    /// the membership does not exist.
    pub async fn set_role(
        &self,
        account_id: Uuid,
        user_id: Uuid,
        new_role: AccountRole,
        actor: ActorCeiling,
    ) -> Result<AccountMember, AppError> {
        // H-2 (#144): refuse on a PERSONAL account — nothing should be re-roling the
        // sole personal owner.
        self.refuse_if_personal(account_id).await?;
        // SQLite port: `BEGIN IMMEDIATE` (see `add_member`).
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;

        // FIX_ROUND-1 (F2): the account row first — see `lock_account_row`.
        lock_account_row(&mut tx, account_id).await?;

        let owner_count = sqlx::query!(
            r#"SELECT user_id FROM account_members
               WHERE account_id = $1 AND role = 'owner'"#,
            account_id,
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .len();

        let target = sqlx::query!(
            r#"SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2"#,
            account_id,
            user_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let Some(t) = target else {
            return Err(AppError::not_found("Membership"));
        };
        let current = AccountRole::from_str(&t.role)?;

        // R-1 (#142) — see `remove_member` for the ordering rationale. BOTH halves are
        // graded here: the target's CURRENT role (so an Admin cannot demote an Owner) and
        // the REQUESTED role (so an Admin cannot mint one). A sole Owner demoting THEMSELF
        // is a `R1Target::Actor` mutation whose requested role is below their own, so R-1
        // has nothing to refuse and the `LAST_OWNER` guard below is what answers — the
        // designed behaviour, not an accident (TEST-5 pins it).
        if let Some(c) = resolve_ceiling(&mut tx, account_id, actor).await? {
            // A self-demotion aims at the actor's own row, so the CURRENT-role half is
            // vacuous — see `R1Target::Actor`. The REQUESTED half still applies.
            let target = if user_id == c.actor_user_id {
                R1Target::Actor
            } else {
                R1Target::Other(current)
            };
            refuse_if_above_ceiling(c.role, target, Some(new_role))?;
        }

        if current == AccountRole::Owner && new_role != AccountRole::Owner && owner_count <= 1 {
            return Err(AppError::unprocessable_entity(
                "LAST_OWNER",
                "an account must keep at least one owner",
            ));
        }

        // #148 — the audit row for a ROLE CHANGE, on `&mut tx`, alongside the UPDATE below,
        // for the reasons set out at the equivalent point in `remove_member`. `old_role` is
        // the role read under the owner lock above and `new_role` is the one about to be
        // written, so the row carries BOTH — the issue's named requirement, and the only way a
        // reader can reconstruct the change rather than merely observe that one happened.
        //
        // A no-op re-role (new == current) still records a row: it is a real, attributable
        // administrative act, and suppressing it would make the ledger disagree with the
        // request log for exactly the mutations an attacker would prefer went unrecorded.
        record_member_event(
            &mut tx,
            NewMemberEvent::about(account_id, actor.audit_actor(), MemberEventAction::RoleChanged, user_id)
                .with_roles(Some(current), Some(new_role)),
        )
        .await?;

        // The UPDATE ... RETURNING cannot JOIN (and SQLite has no data-modifying
        // CTE — same split as `add_member_in_tx`), so the member's human identity
        // is read in a second statement on the same connection. The membership is
        // guaranteed to exist here (checked above), so the UPDATE returns exactly
        // one row (#51).
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let new_role = new_role.as_str();
        let row = sqlx::query!(
            r#"UPDATE account_members SET role = $3
               WHERE account_id = $1 AND user_id = $2
               RETURNING account_id as "account_id: Uuid",
                         user_id as "user_id: Uuid", role,
                         created_at as "created_at: DateTime<Utc>""#,
            account_id,
            user_id,
            new_role,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let identity = sqlx::query!(
            r#"SELECT username, email, display_name FROM users WHERE id = $1"#,
            row.user_id,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        tx.commit().await.map_err(AppError::database_error)?;

        Ok(AccountMember {
            account_id: row.account_id,
            user_id: row.user_id,
            role: AccountRole::from_str(&row.role)?,
            created_at: row.created_at,
            username: identity.username,
            email: identity.email,
            display_name: identity.display_name,
        })
    }

    /// How many ledger rows the ACCOUNT-SCOPED read would return (#148) — the `total` that
    /// drives "Showing N of M". Carries the SAME exclusion predicate as the page query, so
    /// `total` can never disagree with what the caller is able to page through.
    pub async fn count_member_events_scoped(&self, account_id: Uuid) -> Result<i64, AppError> {
        let row = sqlx::query!(
            r#"SELECT COUNT(*) as "count!" FROM account_member_events
               WHERE account_id = $1
                 AND (actor_kind <> 'system' OR action = 'removed')"#,
            account_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.count)
    }

    /// One page of the ACCOUNT-SCOPED membership-audit projection (#148 DEC-7).
    ///
    /// Three subtractions, applied HERE in SQL rather than in the handler or the serializer,
    /// so a later caller cannot reach a redacted value by constructing the DTO differently:
    ///
    /// 1. `system` rows are hidden **except `removed`**, which is shown.
    ///
    ///    Two mistakes are possible here and this repo has now made one of each, so both are
    ///    written down. Hiding EVERY `system` row (the first version) swallowed the cascade
    ///    trigger's removals and left the tenant seeing a `joined` with no matching end — the
    ///    precise defect the trigger exists to close, reinstated one layer up. Hiding only
    ///    `system`+`joined` (the second) inverted the default to allow: any of the six other
    ///    already-minted actions would become tenant-visible on the day something first wrote
    ///    one, with no review and no failing test.
    ///
    ///    So the predicate is an ALLOWLIST, and it fails closed. The decision per action lives
    ///    in [`system_row_is_tenant_visible`], whose match is EXHAUSTIVE — adding an action is
    ///    a compile error there — and an integration test drives a `system` row through this
    ///    route for every action one can legally take, proving the SQL below still agrees. **If you add a
    ///    `system` producer, decide there, and know that hiding it is a bug too.**
    /// 2. On `actor_kind = 'admin'` rows `actor_user_id` is NULLed: an account admin learns
    ///    that platform staff acted, never WHICH employee. The id is still stored and is
    ///    served by [`list_member_events_staff`], which is what makes this a redaction rather
    ///    than an unfalsifiable claim.
    /// 3. `reason` is never selected — a staff-authored internal note is not the reading
    ///    tenant's business (the `admin_suspend_reason` precedent).
    pub async fn list_member_events_scoped(
        &self,
        account_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<AccountMemberEvent>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT id as "id: Uuid", created_at as "created_at: DateTime<Utc>", action, actor_kind,
                      CASE WHEN actor_kind = 'admin' THEN NULL ELSE actor_user_id END
                          as "actor_user_id?: Uuid",
                      target_user_id as "target_user_id?: Uuid",
                      target_email, old_role, new_role,
                      invitation_id as "invitation_id?: Uuid"
               FROM account_member_events
               WHERE account_id = $1
                 AND (actor_kind <> 'system' OR action = 'removed')
               ORDER BY created_at DESC, id DESC
               LIMIT $2 OFFSET $3"#,
            account_id,
            limit,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        rows.into_iter()
            .map(|r| {
                Ok(AccountMemberEvent {
                    id: r.id,
                    created_at: r.created_at,
                    action: r.action,
                    actor_kind: r.actor_kind,
                    actor_user_id: r.actor_user_id,
                    target_user_id: r.target_user_id,
                    target_email: r.target_email,
                    old_role: r.old_role.as_deref().map(AccountRole::from_str).transpose()?,
                    new_role: r.new_role.as_deref().map(AccountRole::from_str).transpose()?,
                    invitation_id: r.invitation_id,
                    // Never selected on this surface (#148 DEC-7).
                    reason: None,
                })
            })
            .collect()
    }

    /// How many ledger rows the STAFF read would return (#148) — every row, system included.
    pub async fn count_member_events_staff(&self, account_id: Uuid) -> Result<i64, AppError> {
        let row = sqlx::query!(
            r#"SELECT COUNT(*) as "count!" FROM account_member_events WHERE account_id = $1"#,
            account_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.count)
    }

    /// One page of the FULL membership-audit row, for the platform-staff surface (#148).
    ///
    /// This is the counterpart that makes [`list_member_events_scoped`]'s redaction a real,
    /// falsifiable decision: without a surface that serves the staff `actor_user_id` and the
    /// `reason`, "redacted from the account admin" would be observationally identical to
    /// "never recorded", and DEC-7 would be untestable.
    pub async fn list_member_events_staff(
        &self,
        account_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<AccountMemberEvent>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT id as "id: Uuid", created_at as "created_at: DateTime<Utc>", action, actor_kind,
                      actor_user_id as "actor_user_id?: Uuid",
                      target_user_id as "target_user_id?: Uuid",
                      target_email, old_role, new_role,
                      invitation_id as "invitation_id?: Uuid", reason
               FROM account_member_events
               WHERE account_id = $1
               ORDER BY created_at DESC, id DESC
               LIMIT $2 OFFSET $3"#,
            account_id,
            limit,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        rows.into_iter()
            .map(|r| {
                Ok(AccountMemberEvent {
                    id: r.id,
                    created_at: r.created_at,
                    action: r.action,
                    actor_kind: r.actor_kind,
                    actor_user_id: r.actor_user_id,
                    target_user_id: r.target_user_id,
                    target_email: r.target_email,
                    old_role: r.old_role.as_deref().map(AccountRole::from_str).transpose()?,
                    new_role: r.new_role.as_deref().map(AccountRole::from_str).transpose()?,
                    invitation_id: r.invitation_id,
                    reason: r.reason,
                })
            })
            .collect()
    }

    /// Fetch one account by id, or `None` if absent.
    pub async fn get(&self, id: Uuid) -> Result<Option<Account>, AppError> {
        let row = sqlx::query!(
            r#"SELECT id as "id: Uuid", kind, name,
                      personal_user_id as "personal_user_id?: Uuid",
                      created_at as "created_at: DateTime<Utc>",
                      updated_at as "updated_at: DateTime<Utc>"
               FROM accounts WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        match row {
            Some(r) => Ok(Some(Account {
                id: r.id,
                kind: AccountKind::from_str(&r.kind)?,
                name: r.name,
                personal_user_id: r.personal_user_id,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })),
            None => Ok(None),
        }
    }

    /// The account's admin-suspension status columns (#37) — the shape the admin
    /// `GET …/status` + suspend/reactivate responses surface. `None` for a nonexistent
    /// account. Keyed on `accounts.id`.
    pub async fn account_admin_status(
        &self,
        id: Uuid,
    ) -> Result<Option<AccountAdminStatus>, AppError> {
        let row = sqlx::query!(
            r#"SELECT admin_suspended as "admin_suspended: bool",
                      admin_suspended_at as "admin_suspended_at?: DateTime<Utc>",
                      admin_suspended_by as "admin_suspended_by?: Uuid",
                      admin_suspend_reason
               FROM accounts WHERE id = $1"#,
            id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.map(|r| AccountAdminStatus {
            account_id: id,
            admin_suspended: r.admin_suspended,
            admin_suspended_at: r.admin_suspended_at,
            admin_suspended_by: r.admin_suspended_by,
            admin_suspend_reason: r.admin_suspend_reason,
        }))
    }

    /// Set or clear an account's admin-suspension (#37, DEC-3/DEC-13/DEC-17). On
    /// suspend (`suspended = true`) it stamps `admin_suspended_at` (the SQLite
    /// canonical `strftime('%Y-%m-%dT%H:%M:%fZ','now')` — the PG `now()` port) +
    /// `admin_suspended_by` + the optional `reason`; on reactivate (`false`) it clears
    /// all three audit columns (the columns describe the CURRENT hold). Idempotent — a
    /// re-suspend/re-reactivate simply re-writes the same target state (each write
    /// derives the target, never increments). The caller (the admin route) has already
    /// resolved the account to exist via `AdminAccountScope`.
    pub async fn set_admin_suspended(
        &self,
        id: Uuid,
        suspended: bool,
        by: Uuid,
        reason: Option<&str>,
    ) -> Result<(), AppError> {
        // On reactivate, force the audit columns NULL regardless of any passed reason.
        let (at_by, reason): (Option<Uuid>, Option<&str>) = if suspended {
            (Some(by), reason)
        } else {
            (None, None)
        };
        sqlx::query!(
            r#"UPDATE accounts
               SET admin_suspended = $1,
                   admin_suspended_at = CASE WHEN $1 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
                   admin_suspended_by = $2,
                   admin_suspend_reason = $3,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE id = $4"#,
            suspended,
            at_by,
            reason,
            id,
        )
        .execute(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    // ==================== #145 — account invitations =============================
    //
    // An invitation is a promise of a membership, addressed to an EMAIL and redeemed by
    // a TOKEN. Four operations live here (create / list / resend / revoke); the fifth,
    // redemption, is #146's and consumes `find_pending_invitation_by_token_hash` below.
    //
    // Three rules bind everything in this section and are stated once here rather than
    // repeated at each function:
    //
    //   * **Rows are never deleted.** Revocation, expiry-supersession and acceptance are
    //     all stamps, so the ledger survives (the `credit_grants` precedent).
    //   * **"Pending" has exactly ONE definition**, and it lives in
    //     `find_pending_invitation_by_token_hash`'s SQL plus its pure twin
    //     `invitation_token::invitation_is_claimable`. `resend`, `revoke` and #146's
    //     accept all grade against the same three clauses, so they cannot drift into
    //     three different answers to "is this invitation still live?".
    //   * **A foreign or unknown invitation id is `404 Invitation`**, byte-identical to a
    //     nonexistent one. Every statement here is keyed on `(account_id, id)`, never on
    //     `id` alone, so an admin of account A cannot touch account B's invitation even
    //     by guessing its id — the invitation-level twin of the extractor's cross-tenant
    //     guard.

    /// Create an invitation, enumeration-safely.
    ///
    /// # The order of operations IS the specification
    ///
    /// 1. `refuse_if_personal` (H-2/#144) — 422 before anything else. Reached, not
    ///    re-implemented; `AccountScope` step 6 also refuses, and neither may be deleted
    ///    in favour of the other (#139 DEC-5).
    /// 2. **Rate limit** — 429, BEFORE the email is looked at, so a refused request is
    ///    refused identically whatever the address is. Doing this after the branch would
    ///    make the limiter itself an oracle.
    /// 3. Open the transaction and take the account's owner lock — the module's
    ///    serialization point, and the precondition for a sound live ceiling read.
    /// 4. `resolve_ceiling` + R-1 on the REQUESTED role (`R1Target::NewMember`) — 403
    ///    `ROLE_ABOVE_ACTOR`. Graded on `min(observed, live)`, so an actor demoted between
    ///    the extractor's read and this write is refused.
    /// 5. **Supersede** any EXPIRED still-pending row for this `(account, email)` — see
    ///    the block at that statement.
    /// 6. Probe for a LIVE invitation ⇒ `AlreadyInvited`.
    /// 7. Probe for an existing membership by normalized email ⇒ `AlreadyMember`.
    /// 8. INSERT.
    ///
    /// # Why the token is minted before the branch
    ///
    /// The token is minted and hashed at step 3, before steps 6 and 7 can diverge, and is
    /// simply discarded on the two no-op paths. That is deliberate waste: issue #145
    /// requires that *"all four paths perform the same user lookup and the same hash
    /// computation"*, and the cheapest honest way to guarantee that is to do the work
    /// unconditionally rather than to reason about whether a branch is fast enough. It is
    /// not a constant-time construction and does not claim to be — the issue explicitly
    /// says a constant-time framework is not warranted here — it removes the one
    /// *structural* timing difference (a SHA-256 that happens on two paths out of four).
    ///
    /// # What it returns, and what the caller must do with it
    ///
    /// [`InvitationOutcome`], which the handler must not turn into a status. The
    /// plaintext token is deliberately **not** returned: it would be `Some` only when a
    /// row was created, and a handler holding a `None` on two of four paths is one
    /// refactor away from being an oracle. The link is minted by [`Self::resend_invitation`]
    /// (#145 DEC-2).
    pub async fn create_invitation(
        &self,
        account_id: Uuid,
        email_raw: &str,
        role: AccountRole,
        actor: ActorCeiling,
        limits: InvitationLimits,
    ) -> Result<InvitationOutcome, AppError> {
        // 1. personal accounts hold exactly one member, their owner (H-2, #144).
        self.refuse_if_personal(account_id).await?;

        let email = validate_invitation_email(email_raw)?;
        let actor_user_id = match actor {
            ActorCeiling::SelfService { actor_user_id, .. } => Some(actor_user_id),
            // #148 widened `PlatformStaff` to carry the staff id, and this deliberately still
            // maps to NULL: #145's `actor_user_id` feeds the per-ACTOR mint budget and
            // `invited_by`, and its own doc records that a staff mint records NULL so the
            // actor filters never match it. Threading the id here would silently subject
            // platform staff to a per-actor rate limit they are exempt from by design. The
            // AUDIT actor is derived separately (`actor.audit_actor()`), so the ledger names
            // the employee even though this column does not. Whether `invited_by` SHOULD now
            // carry it is #145's call, not this item's.
            ActorCeiling::PlatformStaff { .. } => None,
        };

        // 2. The transaction and the LOCK, in the module's fixed order.
        // (SQLite port: `BEGIN IMMEDIATE` — see `add_member`.)
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        lock_account_row(&mut tx, account_id).await?;
        sqlx::query!(
            r#"SELECT user_id FROM account_members
               WHERE account_id = $1 AND role = 'owner'"#,
            account_id,
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // 3. Mint budget — INSIDE the transaction and AFTER the lock (FIX_ROUND-1, F3), so
        // it is not the check-then-act race the first implementation shipped, and BEFORE
        // any use of the address, so a refused request is refused identically whatever the
        // address is. (The address has already been syntactically validated by
        // `normalize_email` above; that 400 is about the INPUT, not about the account, and
        // is the same answer for every account, so it is not an oracle.)
        Self::enforce_invitation_mint_budget(&mut tx, account_id, actor_user_id, limits).await?;

        // 4. R-1: an Admin may not mint an Owner invitation. Only the REQUESTED half can
        // bind — an invitation has no incumbent (`R1Target::NewMember`).
        if let Some(c) = resolve_ceiling(&mut tx, account_id, actor).await? {
            refuse_if_above_ceiling(c.role, R1Target::NewMember, Some(role))?;
        }

        // 4b. #141 — THERE IS DELIBERATELY NO SEAT CHECK HERE, and the reason is worth the
        // paragraph because the obvious design has one.
        //
        // A first version of #141 put an ADVISORY seat pre-check on this function, counting
        // members + live pending invitations, so an admin would learn "you have no room"
        // at mint time instead of the INVITEE learning it days later at accept. Research §5
        // sanctions exactly that ("a soft pre-check at invite-create gives the good error
        // early but is advisory only"). It was REVERTED, because running it proved it costs
        // something §5 did not price:
        //
        //   * It broke #145's shipped INV-8 (`inv8_invitation_create_is_enumeration_safe_
        //     across_all_four_cases`). Only two of this function's four cases MINT; the
        //     other two are no-ops. So occupancy rises on exactly the cases that mint, and
        //     an account walked to its limit answers the first two calls 202 and the last
        //     two 422 — which lets a caller infer, from a LATER call's refusal, whether an
        //     EARLIER address was case (i)/(ii) or case (iii)/(iv). That is precisely the
        //     distinction INV-8 exists to hide, reintroduced through a side channel.
        //   * It refused writes that consume no seat. At the limit it turned the two
        //     documented idempotent no-ops — re-inviting a live address, inviting an
        //     existing member — into 422s, so #145's "case (iv) is idempotent, the existing
        //     token stands" stopped being true for any account at its allowance.
        //
        // The UX the pre-check was for is preserved WITHOUT touching this path: #141 puts
        // `member_allowance` + `members_used` on `GET /api/billing/quota`, so the invite UI
        // (#149) renders "10 of 10 seats" and can warn or disable BEFORE the admin submits.
        // A read the client already makes beats a refusal that costs a security invariant.
        //
        // The seat limit therefore has exactly ONE enforcement point in this module —
        // `add_member_in_tx` — which is what makes "one source of truth" a structural fact
        // rather than a claim about which check is more authoritative than which.

        // Minted unconditionally, before any branch — see "Why the token is minted before
        // the branch". Discarded on the two no-op paths.
        let token = mint_token()?;
        let token_hash = token_sha256(&token).to_vec();

        // 5. Supersede an EXPIRED, still-pending row for this (account, email).
        //
        // The partial unique index cannot mention expiry — `now()` is not IMMUTABLE and
        // may not appear in an index predicate — so its predicate is
        // `accepted_at IS NULL AND revoked_at IS NULL` and an expired-but-unrevoked row
        // keeps occupying the slot. Without this statement, re-inviting an address whose
        // previous invitation quietly expired would fail on a unique violation forever,
        // which is the follow-on question `membership-rescope.md` §13.3 recorded as
        // explicitly unresolved.
        //
        // Stamped as `revoked_at` rather than given a `superseded_at` column of its own:
        // the row is closed out, the audit trail survives, and the two states remain
        // distinguishable without a new column because a superseded row has
        // `expires_at <= revoked_at` while a human revoke has `revoked_at < expires_at`.
        // #148 should record this transition as its own `invite_expired` action.
        sqlx::query!(
            r#"UPDATE account_invitations
                  SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_by = $3
                WHERE account_id = $1
                  AND email = $2
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            account_id,
            email,
            actor_user_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // 6. BOTH probes run, UNCONDITIONALLY, before either can decide anything
        //    (FIX_ROUND-1, F12).
        //
        // The first implementation returned from the live-invitation branch before the
        // membership probe ever ran, which made the work per path differ by a `users` join
        // — while the comment above claimed all four paths did the same lookup. Issue #145
        // asks for exactly that uniformity ("all four paths perform the same user lookup
        // and the same hash computation"), so the honest fix is to do both probes and
        // branch afterwards, not to soften the claim.
        //
        // Read on `&mut tx`, i.e. behind the locks, so two concurrent creates for the same
        // address cannot both see "none" — and the partial unique index is the backstop if
        // they ever did.

        // (a) is there a LIVE invitation for this address?
        let live = sqlx::query_scalar!(
            r#"SELECT id FROM account_invitations
                WHERE account_id = $1
                  AND email = $2
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            account_id,
            email,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // (b) does this address already belong to a member of THIS account?
        //
        // This is the case people leave open, and the reason it must be a silent no-op is
        // that a `409 ALREADY_A_MEMBER` tells the caller both that the address is
        // registered AND that it is in this account.
        //
        // Compared against a normalized address on both sides. The SQLite port of
        // `btrim(u.email, E' \t\n\r\f\v')` is `trim(u.email, char(32)||char(9)||
        // char(10)||char(13)||char(12)||char(11))` — the same six ASCII
        // whitespace characters `str::trim` removes here (SQLite's `trim` takes a
        // character-set argument, not a single cut char; `char()` builds the
        // printable-escaped set). The comparison stays `lower(...) = $2` with
        // `$2` already normalized in Rust, with the DEC-11 caveat instead of the
        // PG one: SQLite's `lower()` folds ASCII only (the bundled build has no
        // ICU), while Rust's `to_lowercase` is full-Unicode — so a stored
        // non-ASCII address whose case differs is checked by the ASCII-folded
        // SQL only and could miss; recorded as a documented limitation, the
        // same one DEC-11 records for the `instr` search rewrites.
        //
        // A residual remains and is stated rather than hidden: `users.email` is written
        // unvalidated by registration and `users_email_key` is CASE-SENSITIVE — so two
        // principals can differ only by case. A miss here does not grant anything; it
        // merely creates an invitation for someone who is already a member, which is
        // inert (accepting it is idempotent, per #146). The identity-strength question
        // belongs to #143.
        let already_member = sqlx::query_scalar!(
            r#"SELECT m.user_id FROM account_members m
                 JOIN users u ON u.id = m.user_id
                WHERE m.account_id = $1
                  AND lower(trim(u.email, char(32) || char(9) || char(10) || char(13) || char(12) || char(11))) = $2"#,
            account_id,
            email,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // 7. Now decide. The live invitation wins if both are true: re-minting would
        // silently break a link the inviter may already have sent, and #145 is explicit
        // that case (iv) is "idempotent — the existing token stands".
        if live.is_some() {
            tx.commit().await.map_err(AppError::database_error)?;
            return Ok(InvitationOutcome::AlreadyInvited);
        }
        if already_member.is_some() {
            tx.commit().await.map_err(AppError::database_error)?;
            return Ok(InvitationOutcome::AlreadyMember);
        }

        // 8. INSERT. `expires_at` is ABSOLUTE, computed in Rust from `limits`, so a later
        // TTL policy change does not re-interpret rows already written (the
        // `mcp_pairing_codes` posture).
        //
        // The bind is the canonical RFC3339-UTC TEXT form
        // (`%Y-%m-%dT%H:%M:%S%.3fZ` — the DEC-8 column format), NOT
        // `DateTime<Utc>`'s own sqlx encoding: that encodes with `AutoSi`
        // precision, which OMITS the `.SSS` fraction when it is zero, and a
        // bound "…00Z" does NOT sort lexicographically against a stored
        // "…00.000Z" at the same instant (the 'Z' > '.' bytes compare). The
        // canonical-format bind (the ITEM-14 `txresbench-auth` precedent) keeps
        // lexicographic == chronological exactly.
        let expires_at = Utc::now() + limits.ttl;
        let expires_at_sqlite = expires_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        // DEC-12: no `gen_random_uuid()` on SQLite — the row id is bound
        // app-side (the INSERT's column list must name it explicitly).
        let invitation_row_id = Uuid::new_v4();
        // let-bound: the sqlx bind is borrowed across the statement (E0716 class).
        let role_str = role.as_str();
        let inserted = sqlx::query!(
            r#"INSERT INTO account_invitations
                   (id, account_id, email, role, token_sha256, invited_by, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id as "id: Uuid""#,
            invitation_row_id,
            account_id,
            email,
            role_str,
            token_hash,
            actor_user_id,
            expires_at_sqlite,
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // Record the mint on THIS transaction, so a rollback un-counts it. A token that
        // was minted but not counted is the exact hole this ledger exists to close.
        Self::record_invitation_mint(&mut tx, account_id, actor_user_id, inserted.id).await?;

        // #148 — the `invited` audit row, on the SAME `tx`, exactly where #145 left the
        // marker for it. It commits with the invitation or not at all, so the two arms above
        // that return early (`AlreadyInvited`, `AlreadyMember`) write nothing: neither minted
        // anything, and a ledger that recorded them would report invitations that were never
        // issued.
        //
        // The row names the ADDRESS, not a user — an invitee has no account yet, which is the
        // one shape `exactly_one_target` admits alongside a user id. `new_role` is the role
        // being offered; there is no role before an invitation, so `old_role` stays NULL.
        record_member_event(
            &mut tx,
            NewMemberEvent {
                account_id,
                actor: actor.audit_actor(),
                action: MemberEventAction::Invited,
                target_user_id: None,
                target_email: Some(email.clone()),
                old_role: None,
                new_role: Some(role),
                invitation_id: Some(inserted.id),
                reason: None,
            },
        )
        .await?;

        tx.commit().await.map_err(AppError::database_error)?;
        Ok(InvitationOutcome::Created)
    }

    /// The create/resend **mint** ceilings (#145 INV-RL) — how many invitation tokens one
    /// actor, and one account, may bring into existence per window.
    ///
    /// Two windows each (hour and day) and two scopes: the ACTOR window stops one
    /// compromised admin, the ACCOUNT window stops a set of colluding or compromised
    /// admins of one tenant, and the daily windows stop an hourly-only ceiling being
    /// defeated by pacing.
    ///
    /// # It counts MINT RECORDS — one row per token brought into existence
    ///
    /// A create writes one; a resend writes one. There is no approximation, nothing
    /// cumulative, and nothing to overwrite. That matters, because the two designs that
    /// came before it both failed and their failures are the reason this shape is worth
    /// the extra table:
    ///
    /// * Counting `account_invitations` rows by `created_at` (the original) left `resend`
    ///   **exempt** — it UPDATEs a row and writes none — so one invitation could be resent
    ///   without bound while the OpenAPI text claimed otherwise. Three angles found it.
    /// * Charging a cumulative `resend_count` gated by a single `last_resent_at`
    ///   (FIX_ROUND-1) was worse in both directions, and the correctness audit proved both
    ///   empirically: two admins alternating resends of ONE invitation each saw the other's
    ///   id in `last_resent_by` and were charged **nothing**, forever; and because
    ///   `resend_count` is monotone, once one row's count reached the ACCOUNT cap a single
    ///   resend of that one row refused every create and resend for the WHOLE tenant for
    ///   the rest of the window — re-armable once per window, indefinitely. A per-row
    ///   counter cannot represent two windows, and a monotone counter cannot decay.
    ///
    /// `account_invitations.resend_count` / `last_resent_at` / `last_resent_by` survive as
    /// the invitation's own AUDIT columns (#148 will want them) and are deliberately **not
    /// read here** any more.
    ///
    /// # Platform staff: exempt from the ceiling, and excluded from the tenant's — with an
    /// explicit note that this is FORWARD-LOOKING, not a live protection
    ///
    /// A staff mint records `actor_user_id = NULL`. The ACTOR filters therefore never match
    /// it, and the ACCOUNT filters require `actor_user_id IS NOT NULL`. The intent is that
    /// an operator repairing an account is neither rate-limited nor able to exhaust the
    /// customer's own budget — under the FIX_ROUND-1 design a staff operator's incident
    /// resends pushed a shared counter and refused every self-service create in that tenant
    /// for an hour.
    ///
    /// **No shipped surface can currently produce a staff mint**, and saying otherwise
    /// would be the kind of claim this module polices. `handlers.rs::ceiling_of` is the only
    /// producer of an `ActorCeiling` on the invitation routes and unconditionally returns
    /// `SelfService`; `PlatformStaff` reaches only `add_member`/`remove_member`/`set_role`
    /// from `admin/routes.rs`. So `actor_user_id = NULL` is reachable through the repository
    /// API (the tests use it) but not through any route.
    ///
    /// **That makes the exclusion a standing DECISION about a surface that does not exist
    /// yet, and it must be re-made when one does.** The moment an admin-side invitation
    /// route lands, staff mints are bounded by nothing in either scope — and the sentence
    /// two paragraphs down calling the ACCOUNT window "the one that bounds outbound mail per
    /// tenant" stops being true for that path. Whoever adds that route decides: charge staff
    /// to the tenant (bounded, but an operator's repair can lock the customer out), or give
    /// the staff path its own ceiling. Filed here rather than pre-decided, because it is the
    /// same shape of decision #235 is, and this item is not the one to make it.
    ///
    /// # It runs INSIDE the caller's transaction, after the lock
    ///
    /// The original ran the count on `&self.pool` — a different connection, outside the
    /// transaction, before the account lock — which made it a check-then-act race: N
    /// concurrent requests all read the same sub-cap count, all passed, and the lock then
    /// serialized the writes without re-evaluating anything. Taking `conn` and calling it
    /// AFTER [`lock_account_row`] is what makes the ceiling hold under concurrency.
    ///
    /// The ACTOR window is serialized only to the extent that the actor's requests target
    /// the same account — two accounts' locks are independent, so an actor acting on many
    /// accounts at once can still exceed the actor window by the number of accounts they
    /// race across. Stated rather than hidden; closing it needs a lock keyed on the actor
    /// (a `pg_advisory_xact_lock`), which is a broader change than this surface should make
    /// unilaterally. The ACCOUNT window — the one that bounds outbound mail per tenant — is
    /// fully serialized.
    ///
    /// **It stays a bounded overshoot only because N is not attacker-controlled**, and that
    /// is the condition to watch: creating an account needs `account::manage`, which
    /// `202609040001` grants to NO group (only `account::members::manage` reaches `Users`).
    /// Granting `account::manage` to a group would turn "overshoot by the number of
    /// accounts you administer" into an unbounded bypass, and this is where that shows up.
    ///
    /// # The accounting asymmetry on create, and its expiry condition
    ///
    /// The two server-side NO-OP cases (already a member, already invited) mint nothing and
    /// so record nothing. That is correct — they are not mints — but it does mean budget
    /// consumption correlates with those two cases. It leaks nothing to THIS caller: the
    /// route floor is `admin`, and an account admin can already read `GET …/members` (whose
    /// DTO carries member emails) and `GET …/invitations` for their own account, so both
    /// facts are already theirs by authorized means. The distinction enumeration-safety
    /// actually protects — *is this address a registered user at all* — is between the two
    /// cases that DO mint, and they spend identically. **If a future change lowers this
    /// surface's floor below `admin`, or removes `email` from the member DTO, that premise
    /// is false and this must become an attempts counter incremented on every call.**
    async fn enforce_invitation_mint_budget(
        conn: &mut SqliteConnection,
        account_id: Uuid,
        actor_user_id: Option<Uuid>,
        limits: InvitationLimits,
    ) -> Result<(), AppError> {
        // Platform staff are not rate-limited, consistent with their exemption from R-1.
        let Some(actor_user_id) = actor_user_id else {
            return Ok(());
        };

        // SQLite port: `COUNT(*) FILTER (WHERE …)` is not SQLite syntax — the
        // DEC-12 `SUM(CASE WHEN … THEN 1 ELSE 0 END)` pivot, wrapped in
        // `COALESCE(…, 0)` because a bare `SUM` over zero rows is NULL while
        // the PG `count(*)` never is (the ITEM-16 notification rewrite
        // convention). The `now() - $N::interval` cut-offs become the
        // canonical-`strftime` form with numeric `-N seconds` modifiers from
        // the microsecond consts (whole seconds for all three windows — see
        // the const block; the SQLite `'now'` clock is UTC and the modifier is
        // DST-invariant).
        let row = sqlx::query!(
            r#"SELECT
                 COALESCE(SUM(CASE WHEN actor_user_id = $2
                                 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($3 / 1000000) || ' seconds')
                            THEN 1 ELSE 0 END), 0)
                     AS "actor_hour!",
                 COALESCE(SUM(CASE WHEN actor_user_id = $2
                                 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($4 / 1000000) || ' seconds')
                            THEN 1 ELSE 0 END), 0)
                     AS "actor_day!",
                 COALESCE(SUM(CASE WHEN account_id = $1 AND actor_user_id IS NOT NULL
                                 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($3 / 1000000) || ' seconds')
                            THEN 1 ELSE 0 END), 0)
                     AS "account_hour!",
                 COALESCE(SUM(CASE WHEN account_id = $1 AND actor_user_id IS NOT NULL
                                 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($4 / 1000000) || ' seconds')
                            THEN 1 ELSE 0 END), 0)
                     AS "account_day!"
               FROM account_invitation_mints
               WHERE (actor_user_id = $2 OR account_id = $1)
                 AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($4 / 1000000) || ' seconds')"#,
            account_id,
            actor_user_id,
            RATE_WINDOW_HOUR,
            RATE_WINDOW_DAY,
        )
        .fetch_one(&mut *conn)
        .await
        .map_err(AppError::database_error)?;

        let over = [
            (row.actor_hour, limits.per_actor_per_hour, "you", "hour"),
            (row.actor_day, limits.per_actor_per_day, "you", "day"),
            (
                row.account_hour,
                limits.per_account_per_hour,
                "this account",
                "hour",
            ),
            (
                row.account_day,
                limits.per_account_per_day,
                "this account",
                "day",
            ),
        ]
        .into_iter()
        .find(|(n, cap, _, _)| *n >= *cap);

        // The message names WHICH window tripped so a legitimate admin onboarding a team
        // knows whether to wait an hour or a day; it does not name the address, so the
        // refusal carries no information about the invitee.
        match over {
            None => Ok(()),
            Some((_, cap, who, window)) => Err(AppError::new(
                axum::http::StatusCode::TOO_MANY_REQUESTS,
                INVITATION_RATE_LIMITED,
                format!(
                    "{who} may mint at most {cap} invitation tokens per {window}; try again later"
                ),
            )),
        }
    }

    /// Record one token mint, and opportunistically prune the ledger.
    ///
    /// Called on the mutation's OWN connection so the record commits with the mint or not
    /// at all — a mint that happened but was not counted is exactly the hole FIX_ROUND-1
    /// was closing, and doing this on the pool would re-open it for the rollback case.
    ///
    /// The prune is the `mcp_pairing_codes` posture: delete-at-mint rather than a sweeper,
    /// so a missing sweeper can never make the table unbounded, and there is no cron
    /// culture in this tree to lean on. The horizon is [`MINT_RETENTION`], which dominates
    /// the longest window, so pruning can never remove a row the ceiling would have
    /// counted. This table is rate-limit substrate, not an audit trail (#148 owns that, and
    /// `account_invitations`' own `resend_count`/`last_resent_at`/`last_resent_by` remain),
    /// which is what makes deleting from it correct rather than a loss.
    ///
    /// # The prune is SCOPED TO THIS ACCOUNT, and that is not a detail
    ///
    /// The first version omitted `account_id`, deleting platform-wide inside the mutation's
    /// own transaction while it held the account's row lock. Two blind angles found it and
    /// one reproduced BOTH consequences against a real cluster:
    ///
    /// * **Cross-tenant blocking.** Tenant A's mint took row-exclusive locks on tenant B's
    ///   aged rows, so B's mint blocked on A's — verified as
    ///   `canceling statement due to lock timeout … while deleting tuple … in relation
    ///   "account_invitation_mints"`. With `lock_timeout` documented as `0` in this
    ///   deployment that wait is UNBOUNDED, while an `accounts` lock is held. It was the
    ///   exact hazard class `lock_account_row` had just been fixed to remove, reintroduced
    ///   two statements later.
    /// * **Cross-tenant DEADLOCK.** Two sessions pruning concurrently, each holding its own
    ///   distinct `accounts` row, produced a real `deadlock detected`. The same DELETE has
    ///   several reachable plans (Seq Scan in physical order, Bitmap Heap Scan in ctid
    ///   order, Index Scan in `(account_id, created_at)` order) whose row-visit orders
    ///   differ; which one is chosen depends on platform-wide statistics, not on the
    ///   requesting tenant, and sqlx caches prepared statements per connection. So one
    ///   tenant's traffic aborted another tenant's request with a 500.
    ///
    /// A third consequence was an observability channel: an unscoped prune's cost is
    /// proportional to the platform-wide batch aging out, so an admin could infer other
    /// tenants' invitation volume by timing their own create.
    ///
    /// Scoping to `account_id` removes all three by construction — a tenant only ever
    /// touches its own rows. The residual is stated rather than hidden: an account that
    /// stops minting keeps its last window's rows indefinitely, because nothing else will
    /// come along to prune them. That is bounded (one account's mints for one retention
    /// period), harmless (nothing reads them), and strictly better than a global sweep that
    /// couples every tenant to every other. The `mcp_pairing_codes` precedent prunes a
    /// table with no tenant dimension at all, so its posture transfers only once scoped.
    async fn record_invitation_mint(
        conn: &mut SqliteConnection,
        account_id: Uuid,
        actor_user_id: Option<Uuid>,
        invitation_id: Uuid,
    ) -> Result<(), AppError> {
        // SQLite port: `now() - $2::interval` → the canonical-`strftime` form
        // with the numeric `-N seconds` modifier (see the const block).
        sqlx::query!(
            r#"DELETE FROM account_invitation_mints
                WHERE account_id = $1
                  AND created_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ($2 / 1000000) || ' seconds')"#,
            account_id,
            MINT_RETENTION,
        )
        .execute(&mut *conn)
        .await
        .map_err(AppError::database_error)?;

        // DEC-12: no `gen_random_uuid()` on SQLite — the row id is bound
        // app-side.
        let mint_id = Uuid::new_v4();
        sqlx::query!(
            r#"INSERT INTO account_invitation_mints
                   (id, account_id, actor_user_id, invitation_id)
               VALUES ($1, $2, $3, $4)"#,
            mint_id,
            account_id,
            actor_user_id,
            invitation_id,
        )
        .execute(&mut *conn)
        .await
        .map_err(AppError::database_error)?;
        Ok(())
    }

    /// Count this account's PENDING invitations — the `total` for "Showing N of M".
    pub async fn count_pending_invitations(&self, account_id: Uuid) -> Result<i64, AppError> {
        let row = sqlx::query!(
            r#"SELECT COUNT(*) as "count!"
                 FROM account_invitations
                WHERE account_id = $1
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            account_id,
        )
        .fetch_one(&self.pool)
        .await
        .map_err(AppError::database_error)?;
        Ok(row.count)
    }

    /// One page of this account's PENDING invitations, newest first.
    ///
    /// **This SQL deliberately never joins `users`.** The list must not reveal whether a
    /// pending invitee is a registered user, and the robust way to guarantee that is for
    /// the query to have no access to user rows at all — rather than for a projection to
    /// stay narrow because everyone who edits it remembers to keep it narrow.
    ///
    /// Bounded by the caller (guideline §4); expiry, acceptance and revocation are all in
    /// the predicate, so a settled invitation simply is not listed.
    pub async fn list_pending_invitations(
        &self,
        account_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<InvitationSummary>, AppError> {
        let rows = sqlx::query!(
            r#"SELECT id as "id: Uuid", email, role,
                      created_at as "created_at: DateTime<Utc>",
                      expires_at as "expires_at: DateTime<Utc>",
                      invited_by as "invited_by?: Uuid"
                 FROM account_invitations
                WHERE account_id = $1
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
                ORDER BY created_at DESC, id ASC
                LIMIT $2 OFFSET $3"#,
            account_id,
            limit,
            offset,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        rows.into_iter()
            .map(|r| {
                Ok(InvitationSummary {
                    id: r.id,
                    email: r.email,
                    role: AccountRole::from_str(&r.role)?,
                    created_at: r.created_at,
                    expires_at: r.expires_at,
                    invited_by: r.invited_by,
                })
            })
            .collect()
    }

    /// Re-mint one pending invitation's token and push out its expiry, returning the
    /// **plaintext** token and the new expiry.
    ///
    /// This is the copy-link channel, and it is the only place a plaintext invitation
    /// token is ever surfaced (#145 DEC-2): because the row stores only a SHA-256, the
    /// server cannot reproduce a link it has already handed out, so "give me the link"
    /// and "resend" are necessarily the same operation. Re-minting invalidates the
    /// previous token, which is the correct semantics for a resend anyway.
    ///
    /// Keyed on `(account_id, id)`, so an admin of another account cannot resend this
    /// invitation by guessing its id — a foreign, unknown or already-settled id is the
    /// same `404 Invitation`.
    ///
    /// **R-1 is re-graded here**, on the LIVE ceiling: a resend mints a fresh live token
    /// for a grant the actor may no longer be entitled to confer, so an Admin who was
    /// demoted after an `owner` invitation was issued cannot refresh it. (Revoke is
    /// deliberately NOT graded — see [`Self::revoke_invitation`].)
    pub async fn resend_invitation(
        &self,
        account_id: Uuid,
        invitation_id: Uuid,
        actor: ActorCeiling,
        limits: InvitationLimits,
    ) -> Result<(String, DateTime<Utc>), AppError> {
        let actor_user_id = match actor {
            ActorCeiling::SelfService { actor_user_id, .. } => Some(actor_user_id),
            // #148 widened `PlatformStaff` to carry the staff id, and this deliberately still
            // maps to NULL: #145's `actor_user_id` feeds the per-ACTOR mint budget and
            // `invited_by`, and its own doc records that a staff mint records NULL so the
            // actor filters never match it. Threading the id here would silently subject
            // platform staff to a per-actor rate limit they are exempt from by design. The
            // AUDIT actor is derived separately (`actor.audit_actor()`), so the ledger names
            // the employee even though this column does not. Whether `invited_by` SHOULD now
            // carry it is #145's call, not this item's.
            ActorCeiling::PlatformStaff { .. } => None,
        };
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;
        lock_account_row(&mut tx, account_id).await?;
        sqlx::query!(
            r#"SELECT user_id FROM account_members
               WHERE account_id = $1 AND role = 'owner'"#,
            account_id,
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // A resend MINTS a token, so it both spends the same budget as a create and
        // contributes to it — by writing a mint record below, exactly as a create does.
        // Before FIX_ROUND-1 this check ran against a budget resends never spent; the
        // FIX_ROUND-1 attempt to charge them through a cumulative per-row counter was both
        // evadable and a tenant-wide lockout (see `enforce_invitation_mint_budget`). Inside
        // the transaction and after the locks.
        Self::enforce_invitation_mint_budget(&mut tx, account_id, actor_user_id, limits).await?;

        // Read the row before grading, because R-1 grades the invitation's
        // FROZEN role — which is only knowable from the row. (SQLite port: the
        // `FOR UPDATE` is gone — the row's lock is the transaction's
        // `BEGIN IMMEDIATE` write lock, see `lock_account_row`.)
        let existing = sqlx::query!(
            // `email` is selected for the #148 ledger row below, on the row this statement
            // reads behind the write lock — every event names a principal, and an invitee
            // has no user id, so the address is the only identifier an `invite_resent` row
            // can carry.
            r#"SELECT role, email FROM account_invitations
                WHERE account_id = $1
                  AND id = $2
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            account_id,
            invitation_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let Some(existing) = existing else {
            return Err(AppError::not_found("Invitation"));
        };
        let frozen_role = AccountRole::from_str(&existing.role)?;

        if let Some(c) = resolve_ceiling(&mut tx, account_id, actor).await? {
            refuse_if_above_ceiling(c.role, R1Target::NewMember, Some(frozen_role))?;
        }

        let token = mint_token()?;
        let token_hash = token_sha256(&token).to_vec();
        let expires_at = Utc::now() + limits.ttl;
        let expires_at_sqlite = expires_at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

        // #148 — the `invite_resent` audit row belongs here, on `&mut tx`.
        //
        // The UPDATE repeats the full PENDING predicate (FIX_ROUND-1, F7). It is redundant
        // today — the row was just read behind the transaction's write lock — but
        // that is a NON-LOCAL invariant: move or drop that lock in a later refactor and an
        // unguarded UPDATE would happily re-arm a live token on an accepted or revoked
        // invitation. `revoke_invitation` already carries the safe shape; this now matches
        // it, so neither depends on a lock several statements away.
        //
        // `resend_count`/`last_resent_at`/`last_resent_by` are the invitation's own AUDIT
        // columns — how many times it has been re-sent, when, and by whom (which may differ
        // from `invited_by`: an admin can resend a colleague's invitation). They are
        // deliberately NOT what the ceiling reads; FIX_ROUND-2 moved that to
        // `account_invitation_mints` after the correctness audit showed a per-row counter
        // cannot express a window. #148 will want these.
        let updated = sqlx::query!(
            r#"UPDATE account_invitations
                  SET token_sha256   = $3,
                      expires_at     = $4,
                      resend_count   = resend_count + 1,
                      last_resent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                      last_resent_by = $5
                WHERE account_id = $1
                  AND id = $2
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            account_id,
            invitation_id,
            token_hash,
            expires_at_sqlite,
            actor_user_id,
        )
        .execute(&mut *tx)
        .await
        .map_err(AppError::database_error)?
        .rows_affected();
        if updated == 0 {
            // Unreachable while the lock above is held, and treated as the ordinary
            // not-found rather than a 500 so that if it ever DOES become reachable the
            // failure is the same indistinguishable 404 every other miss produces.
            return Err(AppError::not_found("Invitation"));
        }

        // One mint, one record — identical to a create's. This is what makes the OpenAPI's
        // "a resend is counted one for one with a create" literally true.
        //
        // FIX_ROUND-3 briefly exempted the FIRST resend of each invitation, reasoning that
        // DEC-2's create → resend → copy flow makes one usable link cost two mints and that
        // the ceilings' prose ("twenty people in an hour") therefore over-stated the
        // reachable rate. The reasoning about the prose was right; the remedy was wrong, and
        // two blind angles reproduced why. The exemption attached a durable, never-expiring
        // credit to every invitation ROW (TTL 7 days) rather than to a time window, so it
        // could be earned in one window and spent in another: an auditor drove 30 fresh
        // tokens through the real routes in one hour with the ledger recording ZERO in-window
        // mints, and quantified the worst case at `ttl × per_actor_per_day` = 700 uncharged
        // mints in an hour against a stated ceiling of 20. Even with no stockpiling the
        // steady state was exactly 2× both ceilings.
        //
        // The prose problem is fixed where it belonged: `InvitationLimits` now states its
        // ceilings in MINTS and says plainly that the reachable rate of USABLE invitations
        // is about half of them. Doubling the numbers instead was tried and also reverted —
        // a create is one mint and one recipient, so doubling the shared ceiling doubled
        // the distinct-recipient outbound rate, which is the bound the ceiling exists for.
        // A ceiling that can be banked is not a ceiling; nor is one raised to flatter its
        // own prose.
        Self::record_invitation_mint(&mut tx, account_id, actor_user_id, invitation_id).await?;

        // #148 — the `invite_resent` row, on the SAME `tx`. A resend mints a NEW token and
        // extends the expiry, so it is a distinct act on the same invitation and gets its own
        // row: the ledger is append-only, and rewriting the original `invited` row is exactly
        // what INV-13c forbids. `invitation_id` is what ties the two together.
        record_member_event(
            &mut tx,
            NewMemberEvent {
                account_id,
                actor: actor.audit_actor(),
                action: MemberEventAction::InviteResent,
                target_user_id: None,
                target_email: Some(existing.email.clone()),
                old_role: None,
                new_role: Some(frozen_role),
                invitation_id: Some(invitation_id),
                reason: None,
            },
        )
        .await?;

        tx.commit().await.map_err(AppError::database_error)?;
        Ok((token, expires_at))
    }

    /// Revoke one pending invitation — SOFT: `revoked_at`/`revoked_by` are stamped and the
    /// row survives (audit; the `credit_grants` precedent). Afterwards the token no longer
    /// resolves and the address may be invited afresh (the partial unique index frees the
    /// slot).
    ///
    /// Keyed on `(account_id, id)` and on the two SETTLEMENT clauses, so a foreign or
    /// unknown id and an already-settled one are the same `404 Invitation` — a second
    /// revoke included. **Expiry is deliberately NOT part of that predicate** (see the note
    /// at the statement), so an expired-but-unsettled invitation revokes with a 204. One
    /// consequence, stated because it is the only place this surface distinguishes anything:
    /// revoke is the single route on which "an expired invitation with this id exists in
    /// this account" (204) differs from "no such id" (404). That is not an oracle — reaching
    /// either requires being an `admin` of the account, who can already list its
    /// invitations — but it is a difference, and it should be a decision rather than a
    /// surprise.
    ///
    /// **R-1 is deliberately NOT graded here (#145 DEC-9), and the omission is the
    /// decision.** R-1 exists because an actor must not create, promote to, demote from or
    /// remove a role above their own. Revoking an invitation removes no role: the invitee
    /// holds nothing yet, so there is no standing to be above. Grading it would block a
    /// lower-ranked Admin from cleaning up an `owner` invitation someone else left behind
    /// — a stranding class, not a guard. `resend` IS graded, because it re-mints a live
    /// token and extends the window for a grant the actor may no longer confer.
    pub async fn revoke_invitation(
        &self,
        account_id: Uuid,
        invitation_id: Uuid,
        actor: AuditActor,
    ) -> Result<(), AppError> {
        // #148 — this is the one place closing the ledger hole needed more than a call on a
        // transaction that already existed, and the change is deliberately as small as the
        // property allows:
        //
        //   * a TRANSACTION, because #145's own comment here asked for exactly that ("when
        //     #148 lands, wrap the two together explicitly rather than relying on" a single
        //     statement being its own transaction). An audit row that can commit apart from
        //     the revoke it records is the failure this whole item exists to prevent;
        //   * `RETURNING email`, because every event names a principal and an invitee has no
        //     user id, so the address is the only identifier this row can carry;
        //   * `actor_user_id: Option<Uuid>` became `actor: AuditActor`. The stored
        //     `revoked_by` is unchanged — it is `actor.user_id()`, the same `Option<Uuid>` —
        //     but the ledger additionally needs the actor's KIND, which an `Option<Uuid>`
        //     cannot express: a staff revoke and a member's revoke would be indistinguishable,
        //     and distinguishability is INV-13b's whole point. There is ONE caller (the
        //     account-scoped route), so this is a one-line change there.
        let actor_user_id = actor.user_id();
        // NOTE the predicate deliberately does NOT carry `expires_at > now()`
        // (FIX_ROUND-1, F17). Every other statement in this module uses the full pending
        // predicate; this one must not, and the reason is a real one rather than an
        // oversight. With expiry in the predicate, an EXPIRED but unsettled invitation
        // could never be revoked at all — a 404 for an offer the admin can plainly see is
        // no longer wanted — and it would remain in a third state #148 cannot attribute:
        // neither human-revoked nor superseded, because the supersede stamp only fires if
        // somebody happens to re-invite that same address. Letting a revoke settle it keeps
        // the ledger complete. It grants nothing: an expired invitation is already
        // unredeemable, so this changes only the row's recorded disposition.
        //
        // `accepted_at IS NULL AND revoked_at IS NULL` DO remain, so a second revoke is
        // still a 404 and an accepted invitation cannot be retroactively "withdrawn".
        let mut tx = self.pool.begin().await.map_err(AppError::database_error)?;
        let revoked = sqlx::query!(
            r#"UPDATE account_invitations
                  SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_by = $3
                WHERE account_id = $1
                  AND id = $2
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
              RETURNING email, role"#,
            account_id,
            invitation_id,
            actor_user_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // No row ⇒ no such pending invitation. Returned WITHOUT committing, so a refused
        // revoke leaves no ledger row — a refused action is not an audited action (DEC-1).
        let Some(revoked) = revoked else {
            return Err(AppError::not_found("Invitation"));
        };

        // #148 — the `invite_revoked` row, on the same transaction as the stamp it records.
        // A NEW row rather than a mutation of the `invited` one: that is INV-13c's second
        // clause stated in the issue, and the append-only trigger would refuse the mutation
        // anyway. `invitation_id` ties the pair together.
        record_member_event(
            &mut tx,
            NewMemberEvent {
                account_id,
                actor,
                action: MemberEventAction::InviteRevoked,
                target_user_id: None,
                target_email: Some(revoked.email),
                old_role: None,
                new_role: Some(AccountRole::from_str(&revoked.role)?),
                invitation_id: Some(invitation_id),
                reason: None,
            },
        )
        .await?;

        tx.commit().await.map_err(AppError::database_error)?;
        Ok(())
    }

    /// Look up a PENDING invitation by its token's SHA-256.
    ///
    /// # #146 does NOT call this, and the reason is worth stating (FIX_ROUND-1, R1-7)
    ///
    /// This doc used to call itself *"the redemption primitive #146 consumes"*. It is not,
    /// and leaving that claim standing would send the next reader looking for a caller that
    /// does not exist. [`AccountRepository::accept_invitation`] cannot use it: it reads on
    /// the POOL, with no lock and no write-lock-held read, so redeeming through it would be
    /// exactly the read-then-unconditional-UPDATE TOCTOU that #146's own INV-17 forbids (and
    /// which point 3 below warns against). Accept issues the predicate itself, twice — once
    /// on an unlocked discovery read that decides nothing, and once inside the transaction
    /// behind the write lock, which is the one anything is decided on.
    ///
    /// So the predicate now appears in FOUR places (here, accept's two reads, and accept's
    /// stamp) and they must be kept in step. What keeps them honest is
    /// [`invitation_is_claimable`], the pure twin every one of them is a transcription of,
    /// plus the deny suite, which drives each of the three killers through the real route
    /// (`inv9_every_invalid_token_is_byte_identical`). This function retains a caller in the
    /// #145 suite and stays as the module's readable statement of the rule.
    ///
    /// # The claim predicate
    ///
    /// `accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()` — all three
    /// clauses **in the SQL**, never re-derived in Rust, so expiry cannot be forgotten by
    /// a caller and cannot be evaluated against a clock the database does not share. Its
    /// pure twin is [`invitation_is_claimable`], which exists so the RULE is unit-testable
    /// rather than only its transcription (the `mcp/pairing.rs::code_is_claimable` and
    /// `initiator_still_owner_locked` discipline). **Change one, change the other.**
    ///
    /// # What #146 must still do, written here because it is where #146 will be looking
    ///
    /// This function answers "is there a live invitation for this token". It deliberately
    /// does **not** answer the three questions that follow, all of which are #146's:
    ///
    /// 1. **The email binding.** The authenticated user's `users.email`, normalized with
    ///    [`normalize_email`], must equal `invitation.email`. A mismatch must return the
    ///    SAME generic 404 as a wrong/expired/revoked/used token — never a distinct code,
    ///    because the difference is exactly what a token grinder wants. Emails are never
    ///    verified in this codebase (#143), so this is containment against a leaked link
    ///    reaching the wrong logged-in tab, **not** proof of identity; say so in the
    ///    comment there and do not overclaim it.
    /// 2. **The TOCTOU role re-check — and this is the invitation bug people ship.** The
    ///    invitation's `role` was frozen at issue and graded then against the inviter's
    ///    role THEN. Inside the accept transaction, after the owner-row lock, re-read
    ///    `membership_role(invitation.account_id, invitation.invited_by)` and refuse with
    ///    `403 ROLE_ABOVE_ACTOR` if it is `None`, below `Admin`, or **below
    ///    `invitation.role`**; then pass
    ///    `ActorCeiling::SelfService { actor_user_id: invitation.invited_by, observed_role: <that live role> }`
    ///    to [`AccountRepository::add_member_in_tx`] — **the `_in_tx` form, on your own
    ///    connection, not the pool-owning [`AccountRepository::add_member`]**. The wrapper
    ///    commits by itself, which would (a) break your INV-17 requirement that the
    ///    membership and the `accepted_at` stamp roll back together, and (b) self-deadlock
    ///    against the row locks your own transaction already holds, invisibly to Postgres's
    ///    deadlock detector because the two are separate sessions. `add_member_in_tx` takes
    ///    the same locks on YOUR connection, which is free, and grades the ceiling as a
    ///    required argument. Without this, an Owner issues an `owner` invitation, is demoted to
    ///    Member, and the invitee still becomes an Owner days later — under DEC-12 that is
    ///    delete-authority over the whole tenant handed out by someone who no longer has
    ///    it.
    ///
    ///    **One simplification, recorded so it is not agonized over.** It is tempting to
    ///    also store the inviter's role at mint time so accept can compute
    ///    `min(role_at_mint, live)`, mirroring `resolve_ceiling`. That is unnecessary and
    ///    the column is deliberately absent: create already enforced
    ///    `invitation.role <= inviter_role_at_mint`, so `invitation.role` is itself a
    ///    witness of the mint-time authorization, and `invitation.role <= min(mint, live)`
    ///    reduces to `invitation.role <= live`.
    ///
    ///    **`invited_by` can be `NULL`**, and you must decide about that explicitly rather
    ///    than unwrapping it: `create_invitation` maps `ActorCeiling::PlatformStaff` to a
    ///    `NULL` inviter. No shipped ROUTE produces that today (`ceiling_of` always builds
    ///    `SelfService`), but the repository API allows it and this branch's tests use it.
    ///    Treat it as the staff ceiling (no R-1) or refuse it — but choose, and record it.
    ///
    ///    # AN UNRESOLVED CONTRACT CONFLICT — read this before writing step 3
    ///
    ///    What happens when the inviter is GONE — `membership_role` returns `None` — is
    ///    **not settled**, and #145 is recording that rather than resolving it, because the
    ///    two ratified sources disagree:
    ///
    ///    * **#146's INV-6** says, verbatim: *"owner-invite issued, inviter demoted **or
    ///      removed**, invitee accepts ⇒ 403, no membership."* That requires refusing on a
    ///      vanished inviter — a STANDING requirement.
    ///    * **`membership-rescope.md` §7.5 / D-8** — "the single most consequential
    ///      invitation decision" — says the opposite: *"do NOT require the inviter to still
    ///      hold standing. Re-attribute to the account"*, because requiring live standing
    ///      *"creates a new stranding class of exactly the kind #178/#201 already
    ///      document"*. Its §10 INV-R4 asserts a pending invitation survives its inviter's
    ///      removal, deactivation and deletion — and `invited_by` carries no foreign key
    ///      precisely so that it can.
    ///
    ///    An earlier revision of THIS comment instructed "refuse if `None`" and then
    ///    asserted, two paragraphs later, that this was *"a check on the ROLE, not on the
    ///    inviter's STANDING as such"*. That was false for the `None` arm, and a blind
    ///    design-conformance audit caught it. The instruction above has been narrowed to
    ///    the part both sources agree on — the ROLE comparison — and the disagreement is
    ///    stated here instead of papered over.
    ///
    ///    **The recommendation, for whoever decides.** Take D-8's shape, made precise: when
    ///    the inviter is gone, re-attribute to the ACCOUNT — honour the invitation iff the
    ///    account still has a live member at or above `Admin` AND at or above
    ///    `invitation.role`, i.e. iff someone remaining *could* have conferred it. That
    ///    satisfies D-8 for the common case (a `member` invitation is not stranded by an
    ///    offboarding) and satisfies INV-6's *purpose* (a grant nobody live can authorize is
    ///    refused), while differing from INV-6's *letter* in exactly one case: an `owner`
    ///    invitation from a departed inviter, which the account's surviving owner could
    ///    still confer. If the owner wants INV-6 literally, that is a one-line
    ///    strengthening — but it should be a decision, with the stranding cost named, not a
    ///    default inherited from an instruction comment.
    ///
    ///    Whichever is chosen, #145's own INV-D8 test asserts only what #145 controls: the
    ///    invitation SURVIVES in storage and still resolves by token. It does not, and
    ///    cannot, assert what accept does with it.
    /// 3. **Single-use.** Stamp `accepted_at`/`accepted_by` in the SAME transaction as the
    ///    membership INSERT, and make the stamp itself the claim:
    ///    `UPDATE … SET accepted_at = now(), accepted_by = $2 WHERE id = $1 AND
    ///    accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING …`,
    ///    treating zero rows as the generic 404. Postgres row-locks the row, so of two
    ///    concurrent accepts only one observes `accepted_at IS NULL` — the
    ///    `mcp_pairing_codes` claim pattern, verbatim. Do **not** rely on this function's
    ///    read plus a later unconditional UPDATE; that is a TOCTOU with a wide window.
    pub async fn find_pending_invitation_by_token_hash(
        &self,
        token_hash: &[u8],
    ) -> Result<Option<AccountInvitation>, AppError> {
        let row = sqlx::query!(
            r#"SELECT id as "id: Uuid", account_id as "account_id: Uuid", email, role,
                      token_sha256,
                      invited_by as "invited_by?: Uuid",
                      created_at as "created_at: DateTime<Utc>",
                      expires_at as "expires_at: DateTime<Utc>",
                      accepted_at as "accepted_at: DateTime<Utc>",
                      accepted_by as "accepted_by?: Uuid",
                      revoked_at as "revoked_at: DateTime<Utc>",
                      revoked_by as "revoked_by?: Uuid"
                 FROM account_invitations
                WHERE token_sha256 = $1
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            token_hash,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        row.map(|r| {
            Ok(AccountInvitation {
                id: r.id,
                account_id: r.account_id,
                email: r.email,
                role: AccountRole::from_str(&r.role)?,
                token_sha256: r.token_sha256,
                invited_by: r.invited_by,
                created_at: r.created_at,
                expires_at: r.expires_at,
                accepted_at: r.accepted_at,
                accepted_by: r.accepted_by,
                revoked_at: r.revoked_at,
                revoked_by: r.revoked_by,
            })
        })
        .transpose()
    }

    /// **#146 — redeem an invitation.** The five ordered steps of research §4.5, in ONE
    /// transaction, on ONE connection.
    ///
    /// ```text
    ///   1. hash + look up a PENDING, UNEXPIRED, UNREVOKED row   → any miss ⇒ generic 404
    ///   2. email binding (users.email, normalized)              → mismatch ⇒ the SAME 404
    ///   3. re-read the inviter's role NOW (the TOCTOU)          → refuse ⇒ 403 ROLE_ABOVE_ACTOR
    ///   4. seat check, behind the account + owner-row locks     → over  ⇒ 422 SEAT_LIMIT_REACHED
    ///   5. INSERT the membership + stamp accepted_at/_by        → both, or neither
    /// ```
    ///
    /// Steps 4 and 5a are [`Self::add_member_in_tx`], which #145 shipped for this caller:
    /// it takes the locks on THIS connection (so it composes instead of self-deadlocking
    /// against locks this transaction already holds), asserts the transaction context,
    /// calls `refuse_if_personal_on`, grades R-1 against the ceiling step 3 minted, calls
    /// `seat::enforce_member_seat` BEFORE the INSERT, and writes the `joined` ledger row on
    /// this connection. **This item adds no membership INSERT of its own and no second seat
    /// rule** — `seat_allowance_test::test11` enumerates every `INSERT INTO account_members`
    /// in the tree and every `seat::enforce_` call site precisely to keep that true.
    ///
    /// # The lock order is `accounts` → owner rows → invitation, and the split step 1 is why
    /// (#146 DEC-3, corrected in FIX_ROUND-1)
    ///
    /// `create_invitation` / `resend_invitation` / `set_role` / `remove_member` /
    /// `add_member_in_tx` all lock `accounts` → `account_members` owner rows → (where
    /// relevant) the invitation row. This path takes the SAME three, in the SAME order.
    /// Locking the invitation first — the obvious shape, since a token is all the request
    /// carries — would invert the last two and open a real deadlock edge against create and
    /// resend. So step 1 is split: an UNLOCKED discovery read learns `account_id` (and
    /// filters on the email binding, see the body), then the two locks are taken in the
    /// canonical order, then the SAME claim predicate is re-evaluated `FOR UPDATE`. The
    /// discovery read grades nothing and authorizes nothing; a row that changes in between is
    /// caught by the authoritative re-read, which is the only one anything is decided on.
    ///
    /// An earlier revision took the owner-row lock only later, inside `add_member_in_tx`, and
    /// its comment claimed the order was preserved. It was not: that left this path in an
    /// ABBA relation with create/resend on `(account_invitations, account_members)`, masked
    /// only by the `accounts` lock all three take first — and that masking is not universal
    /// here, because `revoke_invitation` locks an invitation row with no accounts lock at
    /// all. Found by a blind concurrency audit; the code now does what the comment said.
    ///
    /// # Every miss is the SAME 404 — including the ones that are not token problems
    ///
    /// [`invalid_invitation`] is the only 404 constructor on this path, and the arms that
    /// route through it are: no live row for that hash; the row disappeared between the two
    /// reads; the account row vanished under the lock; the authenticated user's row vanished;
    /// the email does not bind; an unnormalizable address on either side; and the stamp
    /// affecting zero rows. An address that fails to normalize is a NON-MATCH here rather
    /// than the `400 INVALID_EMAIL` `normalize_email` would return on its own — a 400 on a
    /// path where every other outcome is a 404 is exactly the distinguishable response INV-9
    /// forbids.
    ///
    /// # What is NOT collapsed into that 404
    ///
    /// The TOCTOU 403 and the seat 422 are distinguishable, deliberately: by the time either
    /// can fire the caller has already proved they hold a valid token addressed to them, so
    /// there is nothing left to enumerate — and both refusals carry an action for the user
    /// (ask for a new invitation; upgrade the plan) that a generic 404 would destroy.
    ///
    /// # Concurrency
    ///
    /// Two accepts of the SAME token serialize on the invitation row's `FOR UPDATE`: under
    /// READ COMMITTED the loser re-evaluates the predicate after the winner commits, finds
    /// `accepted_at` set, and gets the generic 404 (the `mcp_pairing_codes` claim pattern).
    /// Two accepts of DIFFERENT tokens into the same account serialize on the account row,
    /// which is what makes the seat count behind it sound (#141).
    pub async fn accept_invitation(
        &self,
        token: &str,
        redeemer_user_id: Uuid,
    ) -> Result<AcceptedInvitation, AppError> {
        let token_hash = token_sha256(token).to_vec();

        // ── STEP 1a — the DISCOVERY read (unlocked). Learns `account_id`, decides nothing
        // that is not re-decided authoritatively below.
        //
        // It carries the FULL claim predicate, so the overwhelmingly common miss (a wrong or
        // stale token) is answered without opening a transaction at all.
        //
        // # It ALSO evaluates the email binding, and that is a SECURITY fix, not an
        // optimization (FIX_ROUND-1, R1-2)
        //
        // A blind security audit observed that a split step 1 makes INV-9 hold on the BYTES
        // and fail on the CLOCK. With only the hash predicate here, a token that misses
        // returns after ONE unlocked query; a token that HITS but belongs to somebody else
        // ran `BEGIN`, a blocking `accounts … FOR NO KEY UPDATE`, a second `FOR UPDATE`
        // SELECT, a `users` SELECT and a `ROLLBACK` first. Five extra round trips plus an
        // unbounded lock wait is a legible signal, and what it signals is exactly the thing
        // INV-9 exists to hide: *this token is live, just not for you* — i.e. that a valid
        // invitation exists for that account.
        //
        // So the redeemer's address is fetched HERE and the binding is evaluated in Rust with
        // the SAME `emails_bind` the authoritative step 2 uses. Both miss classes now cost the
        // same two unlocked statements and no transaction.
        //
        // **It is a FILTER, never the decision.** Step 2 below re-evaluates the binding
        // inside the transaction, on the locked row and a fresh `users` read, exactly where
        // the design puts it. Doing the comparison in RUST on both sides — rather than
        // pushing `lower(btrim(u.email)) = i.email` into SQL — is deliberate: `str::trim`
        // strips all Unicode whitespace while one-argument `btrim` strips ASCII space only,
        // and `lower()` is locale-dependent, so a SQL twin could refuse a legitimate invitee
        // the Rust rule accepts. One rule, one implementation, two call sites.
        // # Why it is TWO statements and not one (FIX_ROUND-4, S4-2)
        //
        // It used to be a scalar subquery in the lookup's TARGET LIST, and a round-4 security
        // angle pointed out that Postgres evaluates a target-list subquery only when the outer
        // scan produces a row — so a token that MISSED the claim predicate did one index probe
        // and a token that HIT did two. That residue is microseconds against the five round
        // trips and the unbounded lock wait FIX_ROUND-1 removed, but it is a residue, and the
        // property is cheap to make EXACT instead of merely comparable: hoisted out, every
        // caller runs the same two statements whichever cause answers.
        let redeemer_email: Option<String> = sqlx::query_scalar!(
            r#"SELECT email FROM users WHERE id = $1"#,
            redeemer_user_id,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        let discovered = sqlx::query!(
            r#"SELECT account_id as "account_id: Uuid", email
                 FROM account_invitations
                WHERE token_sha256 = $1
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            token_hash,
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(AppError::database_error)?;

        // BOTH miss classes are now answered here, after exactly the same work: no live row
        // for this hash, and a live row whose address is not the caller's.
        let bound = discovered.as_ref().is_some_and(|d| {
            emails_bind(redeemer_email.as_deref().unwrap_or_default(), &d.email).unwrap_or(false)
        });
        let (Some(discovered), true) = (discovered, bound) else {
            return Err(invalid_invitation());
        };
        let account_id = discovered.account_id;

        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(AppError::database_error)?;

        // The account row first — the serialization point EVERY membership-mutating path in
        // this module takes before anything else.
        //
        // **Only its `404 Account` is collapsed into the generic refusal** (FIX_ROUND-1,
        // R1-1). `lock_account_row` also returns `database_error` (a 500 carrying a
        // `trace_id` an operator alerts on) and can surface a deadlock-victim abort; the
        // first version discarded the error VALUE with `map_err(|_| …)`, which told a
        // legitimate invitee their valid token was permanently dead and threw away the trace
        // id. Three angles reported it independently.
        //
        // The 404 arm IS collapsed, because `account_invitations.account_id` is
        // `ON DELETE CASCADE`: an account that disappeared between the discovery read and
        // this lock took its invitation with it, which is a token miss from the caller's
        // side, and answering it with a differently-shaped 404 would be an INV-9 leak on a
        // path a caller can reach by racing an account deletion.
        lock_account_row(&mut tx, account_id)
            .await
            .map_err(collapse_absent_account)?;

        // Then the account's OWNER rows — the same read, in the same order,
        // `create_invitation` / `resend_invitation` / `set_role` / `remove_member` /
        // `add_member_in_tx` all take (FIX_ROUND-1, R1-3). (SQLite port: the
        // `FOR UPDATE` clause is gone — the lock is the transaction's.)
        //
        // Taken HERE, before the invitation row, rather than left to `add_member_in_tx`
        // further down. A blind concurrency audit established that leaving it there put this
        // path in the ABBA relation `(account_invitations, account_members)` with
        // create/resend, which take those two in the OPPOSITE order — a genuine cycle, masked
        // today only by the `accounts` row lock all three happen to take first. Masking is
        // not a property to rely on: `revoke_invitation` already locks an invitation row
        // WITHOUT an accounts lock, so the masking invariant is not universal in this module,
        // and one added statement would turn the inversion into a live `40P01` surfacing here
        // as a bogus `404 INVALID_INVITATION`. Re-acquiring the lock inside
        // `add_member_in_tx` is free; acquiring it in the module's canonical order is what
        // removes the cycle. (The comment this replaces claimed accept preserved resend's
        // order. It did not — the audit was right and the code is now what the comment said.)
        sqlx::query!(
            r#"SELECT user_id FROM account_members
               WHERE account_id = $1 AND role = 'owner'"#,
            account_id,
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        // ── STEP 1b — the AUTHORITATIVE lookup behind the write lock, re-evaluating the
        // full claim predicate. This is the row everything below is decided on, and the
        // row a competing accept must wait for (on SQLite the wait is the engine's
        // write-lock contention — the `FOR UPDATE` of the PG leg is the transaction's
        // `BEGIN IMMEDIATE` lock).
        let invitation = sqlx::query!(
            r#"SELECT id as "id: Uuid", email, role,
                      invited_by as "invited_by?: Uuid"
                 FROM account_invitations
                WHERE token_sha256 = $1
                  AND account_id = $2
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')"#,
            token_hash,
            account_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let Some(invitation) = invitation else {
            return Err(invalid_invitation());
        };
        let invited_role = AccountRole::from_str(&invitation.role)?;

        // ── STEP 2 — the EMAIL BINDING, against a FRESH in-transaction read (#146 DEC-9).
        //
        // This is the AUTHORITATIVE evaluation, on the locked invitation row and a `users`
        // read taken inside the transaction. The identical comparison at step 1a is a timing
        // equalizer, not a decision (see there); if the two ever disagreed — the user changed
        // their address between the two reads — this one wins, and it is the conservative
        // direction, because it is the one taken under the lock.
        //
        // Read here rather than taken from the authenticated `User`, for the reason
        // `resolve_ceiling` re-reads the role: a value resolved before the transaction opened
        // is a snapshot, and the design says "the authenticated user's `users.email`".
        //
        // **This is containment, not proof of identity — see `accept::emails_bind` and
        // #143.** Emails are never verified for password registration in this codebase.
        let redeemer = sqlx::query!(
            r#"SELECT email FROM users WHERE id = $1"#,
            redeemer_user_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        let Some(redeemer) = redeemer else {
            // The authenticated principal's row vanished mid-request. Generic, like every
            // other miss — a distinguishable answer here would tell a caller something about
            // the invitation they did not otherwise learn.
            return Err(invalid_invitation());
        };
        // `unwrap_or(false)`: an address that will not normalize (blank on either side)
        // cannot bind, and answering it with `normalize_email`'s own 400 would make a
        // malformed stored address distinguishable from a wrong one. See the doc above.
        if !emails_bind(&redeemer.email, &invitation.email).unwrap_or(false) {
            return Err(invalid_invitation());
        }

        // ── STEP 3 — the TOCTOU role re-check. THE reason this item exists.
        //
        // The invitation's role was frozen at issue and graded THEN against the inviter's
        // role THEN. Re-read it NOW, inside this transaction, behind the account lock taken
        // above. `invited_by` is NULLABLE (`create_invitation` maps `PlatformStaff` to NULL),
        // and `InviterStanding` makes that a case the code must NAME rather than fold into
        // "lost standing" — see `accept::refuse_unless_inviter_still_entitled`.
        //
        // The pure grader MINTS the ceiling from the same values it graded, so the membership
        // INSERT below is graded against exactly the authority checked here, and the `joined`
        // ledger row names exactly that actor.
        let standing = match invitation.invited_by {
            None => InviterStanding::NoRecordedInviter,
            Some(inviter_user_id) => {
                // The same statement `resolve_ceiling` runs, on this transaction's
                // connection, behind this transaction's lock.
                let row = sqlx::query!(
                    r#"SELECT role FROM account_members
                        WHERE account_id = $1 AND user_id = $2"#,
                    account_id,
                    inviter_user_id,
                )
                .fetch_optional(&mut *tx)
                .await
                .map_err(AppError::database_error)?;
                match row {
                    None => InviterStanding::NotAMember,
                    Some(r) => InviterStanding::Member {
                        user_id: inviter_user_id,
                        role: AccountRole::from_str(&r.role)?,
                    },
                }
            }
        };
        let ceiling = refuse_unless_inviter_still_entitled(standing, invited_role)?;

        // H-2 (#144) — refuse a PERSONAL account, on BOTH branches below.
        //
        // `add_member_in_tx` calls this itself, so the joining branch is covered either way;
        // it is called HERE as well so the ALREADY-MEMBER branch — which deliberately does
        // not reach that function (DEC-6) — is covered too, and so that this path's refusal
        // does not depend on #145 refusing to CREATE such an invitation. #146 names that
        // dependency explicitly as one not to have.
        Self::refuse_if_personal_on(&mut tx, account_id).await?;

        // ── STEPS 4 + 5a — the seat check and the membership INSERT, or the idempotent
        // already-a-member branch (#146 DEC-6/DEC-12).
        //
        // The membership is read on THIS connection, behind the account lock, so it cannot
        // be stale. An existing member is a no-op: no second row (the INSERT is
        // `ON CONFLICT DO NOTHING` and would return 409 through `add_member_in_tx`), no role
        // change (a 7-day-old bearer token must not promote anybody — that is the escalation
        // class INV-6 exists to close, arriving by another door), and no `joined` ledger row,
        // because nobody joined.
        let existing = sqlx::query!(
            r#"SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2"#,
            account_id,
            redeemer_user_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;

        let (effective_role, already_member) = match existing {
            Some(r) => (AccountRole::from_str(&r.role)?, true),
            None => {
                Self::add_member_in_tx(
                    &mut tx,
                    account_id,
                    redeemer_user_id,
                    invited_role,
                    ceiling,
                    Some(invitation.id),
                )
                .await?;
                (invited_role, false)
            }
        };

        // ── STEP 5b — the STAMP, in this same transaction (INV-17).
        //
        // The full pending predicate is repeated even though the row is held by the
        // `FOR UPDATE` above, for the reason `resend_invitation`'s FIX_ROUND-1 F7 gives: the
        // lock is a NON-LOCAL invariant, and an unguarded UPDATE would happily re-stamp an
        // accepted or revoked invitation if that lock ever moved. Zero rows is the generic
        // 404, and — because it returns `Err` before `commit` — it rolls the membership
        // INSERT back with it. Both, or neither.
        let stamped = sqlx::query_scalar!(
            r#"UPDATE account_invitations
                  SET accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), accepted_by = $3
                WHERE id = $1
                  AND account_id = $2
                  AND accepted_at IS NULL
                  AND revoked_at IS NULL
                  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
              RETURNING id"#,
            invitation.id,
            account_id,
            redeemer_user_id,
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(AppError::database_error)?;
        if stamped.is_none() {
            return Err(invalid_invitation());
        }

        tx.commit().await.map_err(AppError::database_error)?;

        Ok(AcceptedInvitation {
            account_id,
            role: effective_role,
            already_member,
        })
    }
}

/// What [`AccountRepository::create_invitation`] actually did, for the caller's own
/// bookkeeping (#145).
///
/// **The handler must NOT map this to a status code**, and that is the entire reason it is
/// an enum rather than a `bool` or a returned row: the response is `202 {"status":"sent"}`
/// in every case (INV-8), so this exists only for #148's audit hook — which must record
/// `invited` for [`Created`](InvitationOutcome::Created) and nothing for the two no-ops —
/// and for the deny suite, which asserts the DB state differs while the response does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvitationOutcome {
    /// A new row was written.
    Created,
    /// The address already belongs to a member of this account — a server-side no-op.
    AlreadyMember,
    /// A live invitation for this address already exists — a no-op, and the EXISTING token
    /// stands (it is not re-minted, so a link already handed out keeps working).
    AlreadyInvited,
}

/// What [`AccountRepository::accept_invitation`] did (#146).
///
/// `already_member` is the ONE thing the handler branches on, and it decides a STATUS
/// (201 vs 200), never a body: #146 requires the idempotent path to be a plain success with
/// "no error that leaks anything", and the caller holds a valid token addressed to them, so
/// telling them they were already in the account reveals nothing they could not read from
/// `GET /api/accounts` a moment later.
///
/// `role` is the membership's ACTUAL role, which on the idempotent path is the role they
/// already had — NOT the invitation's. A 7-day-old bearer token must not promote an existing
/// member (#146 DEC-12), and the response must not claim it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcceptedInvitation {
    pub account_id: Uuid,
    pub role: AccountRole,
    /// True when the redeemer was ALREADY a member — no row was inserted, no role changed,
    /// and no `joined` ledger row was written, but the invitation WAS consumed (DEC-6).
    pub already_member: bool,
}

/// Serialize a `uuid[]` batch into the JSON-hex form the SQLite membership
/// predicates consume: a JSON array of 32-char lowercase hex strings (the
/// `uuid::Uuid::simple()` form), compared against a 16-byte BLOB column
/// through `unhex()` — `id IN (SELECT unhex(j.value) FROM json_each($1) AS j)`.
/// This is the ITEM-15 `txresbench-file` convention (its `uuid_list_json`), kept
/// local here because the app's modules are single-driver (DEC-1) and beside
/// the one `= ANY(uuid[])` site it serves no other surface.
fn uuid_list_json(ids: &[Uuid]) -> String {
    serde_json::to_string(
        &ids.iter()
            .map(|id| id.simple().to_string())
            .collect::<Vec<String>>(),
    )
    .expect("a Vec<String> is always JSON-serializable")
}

/// An account's admin-suspension status (#37) — the reader shape the admin status /
/// suspend / reactivate routes surface (mapped to `AdminAccountStatusResponse`).
#[derive(Debug, Clone, PartialEq)]
pub struct AccountAdminStatus {
    pub account_id: Uuid,
    pub admin_suspended: bool,
    pub admin_suspended_at: Option<DateTime<Utc>>,
    pub admin_suspended_by: Option<Uuid>,
    pub admin_suspend_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every role, low → high, for exhaustive iteration.
    const ROLES: [AccountRole; 3] = [
        AccountRole::Member,
        AccountRole::Admin,
        AccountRole::Owner,
    ];

    // TEST-1 [acceptance] [invariant: INV-5] [covers: ITEM-1, ITEM-12, ITEM-13] —
    // the R-1 truth table over the PURE grader, all 48 cells:
    //   {member,admin,owner} ceiling
    // × {Other(member), Other(admin), Other(owner), Actor} target
    // × {member, admin, owner, None(removal)} requested.
    //
    // **The expectation is computed from the DESIGN's words, not from the code, and not
    // from `AccountRole`'s `Ord`.** An earlier version of this test wrote
    // `current > ceiling || matches!(requested, Some(r) if r > ceiling)` — the
    // implementation's own predicate, copied — which moves in lockstep with any change
    // to it and so could only ever catch a typo. Here the ordering is re-derived from an
    // explicit `rank()` that hardcodes the design's stated order (member < admin <
    // owner), so an INVERTED or reordered `Ord` derive on `AccountRole` turns cells red
    // here rather than passing silently through both sides of a comparison.
    //
    //   "For any membership mutation, BOTH the target's CURRENT role AND the requested
    //    NEW role must be <= actor_role."
    //
    // …with the one refinement the design does not state and the code must: the
    // CURRENT-role half is vacuous for a SELF-target, because nobody outranks themselves.

    /// The design's stated order, hardcoded — deliberately NOT `AccountRole`'s `Ord`.
    fn rank(r: AccountRole) -> u8 {
        match r {
            AccountRole::Member => 0,
            AccountRole::Admin => 1,
            AccountRole::Owner => 2,
        }
    }

    #[test]
    fn role_ceiling_truth_table() {
        let targets = |r: AccountRole| [R1Target::Other(r), R1Target::Actor];
        let mut refused = 0usize;
        let mut cells = 0usize;
        for ceiling in ROLES {
            for target_role in ROLES {
                for target in targets(target_role) {
                    for requested in [
                        Some(AccountRole::Member),
                        Some(AccountRole::Admin),
                        Some(AccountRole::Owner),
                        None,
                    ] {
                        // Only count each `Actor` cell once — it does not vary with
                        // `target_role`, so iterating it three times would inflate the
                        // cell count without adding a distinct case.
                        if target == R1Target::Actor && target_role != AccountRole::Member {
                            continue;
                        }
                        cells += 1;

                        // The rule, re-derived from the design over an independent rank.
                        let current_offends = match target {
                            R1Target::Other(c) => rank(c) > rank(ceiling),
                            R1Target::Actor => false, // vacuous: nobody outranks themselves
                            // #145 — no incumbent at all. Not reached by this loop (see
                            // `new_member_ceiling_truth_table`, which owns that target);
                            // the arm exists so adding a variant is a COMPILE error here
                            // rather than a silently-uncovered cell.
                            R1Target::NewMember => false,
                        };
                        let requested_offends =
                            requested.is_some_and(|r| rank(r) > rank(ceiling));
                        let want_refusal = current_offends || requested_offends;

                        let got = refuse_if_above_ceiling(ceiling, target, requested);
                        assert_eq!(
                            got.is_err(),
                            want_refusal,
                            "ceiling={ceiling:?} target={target:?} requested={requested:?}"
                        );
                        if let Err(e) = got {
                            assert_eq!(e.status_code(), 403, "R-1 is an authority refusal");
                            refused += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(cells, 48, "3 ceilings x (3 Other + 1 Actor) x 4 requested");
        // Both arms must be populated — a grader stuck at "always Ok" or "always Err"
        // would otherwise satisfy a loop that only compares against itself. (The old
        // `refused + allowed == 48` assertion was IDLE: that sum is 48 for every possible
        // implementation, because it counts loop iterations.)
        assert!(refused > 0 && refused < cells, "both outcomes occur: {refused}/{cells}");
    }

    // TEST-1 (cont.) — the SELF-target refinement, by name. A `member` promoted to
    // `admin` mid-flight has ceiling `member` (clamped to the admitted role) and a target
    // row carrying `admin`; grading the current-role half there refused `leave` with 403.
    #[test]
    fn role_ceiling_is_vacuous_on_the_current_half_for_a_self_target() {
        let member = AccountRole::Member;

        // The exact shape of the defect: ceiling below the target row's role, self-target.
        assert!(
            refuse_if_above_ceiling(member, R1Target::Actor, None).is_ok(),
            "a self-REMOVAL can never be refused by R-1 — no role is requested and nobody \
             outranks themselves, so LAST_OWNER must be the only guard that can answer"
        );
        assert!(
            refuse_if_above_ceiling(member, R1Target::Actor, Some(member)).is_ok(),
            "nor a self-demotion to a role at or below the ceiling"
        );
        // …while the SAME ceiling and the SAME role on somebody ELSE still refuses.
        assert!(
            refuse_if_above_ceiling(member, R1Target::Other(AccountRole::Admin), None).is_err(),
            "the current-role half is vacuous only for a SELF target, never in general"
        );
        // …and the REQUESTED half still binds a self-target (#142 INV-5 case 2).
        let err = refuse_if_above_ceiling(
            AccountRole::Admin,
            R1Target::Actor,
            Some(AccountRole::Owner),
        )
        .expect_err("an admin may not promote THEMSELVES to owner");
        assert_eq!(err.status_code(), 403);
        assert!(
            err.to_string().contains("above your effective role for this request"),
            "the refusal names WHY, and this assertion binds the INTERPOLATED clause \
             rather than the constant tail (an earlier version matched only boilerplate \
             that is present in every refusal): {err}"
        );
    }

    // TEST-1 (cont.) — the two halves refuse INDEPENDENTLY. These are the cells that
    // catch a grader which remembered only one comparison; they are asserted by name
    // rather than left implicit in the loop above.
    #[test]
    fn role_ceiling_refuses_on_each_half_alone() {
        let admin = AccountRole::Admin;

        // CURRENT alone offends: an Admin demoting an Owner to `member`. The REQUESTED
        // role is fine (`member <= admin`), so a grader checking only `requested`
        // would allow this — and an Admin could then evict every Owner.
        let e = refuse_if_above_ceiling(
            admin,
            R1Target::Other(AccountRole::Owner),
            Some(AccountRole::Member),
        )
        .expect_err("current-role half must refuse alone");
        assert!(
            e.to_string().contains("the member you are acting on already has"),
            "and it must NAME which half fired — swapping the two match arms, or \
             interpolating the ceiling in place of the offending role, is otherwise \
             undetectable: {e}"
        );

        // REQUESTED alone offends: an Admin promoting a bare member to `owner`. The
        // CURRENT role is fine, so a grader checking only `current` would allow this —
        // and an Admin could mint tenant-wide delete authority (DEC-12).
        let e = refuse_if_above_ceiling(
            admin,
            R1Target::Other(AccountRole::Member),
            Some(AccountRole::Owner),
        )
        .expect_err("requested-role half must refuse alone");
        assert!(
            e.to_string().contains("you asked for"),
            "and it must NAME the other half: {e}"
        );
        assert!(
            e.to_string().contains("`owner`") && e.to_string().contains("(`admin`)"),
            "…and interpolate the OFFENDING role and the CEILING in that order. Without \
             this, swapping the two format arguments — reporting the ceiling as the \
             offender and vice versa — passes every other assertion in the suite: {e}"
        );

        // A REMOVAL has no requested role, so only `current` can offend.
        assert!(refuse_if_above_ceiling(admin, R1Target::Other(AccountRole::Owner), None).is_err());
        assert!(refuse_if_above_ceiling(admin, R1Target::Other(AccountRole::Member), None).is_ok());

        // EQUAL is allowed, in both halves — this is what makes R-4's two-step
        // ownership transfer expressible at all (an Owner mints another Owner).
        assert!(refuse_if_above_ceiling(admin, R1Target::Other(admin), Some(admin)).is_ok());
        assert!(refuse_if_above_ceiling(
            AccountRole::Owner,
            R1Target::Other(AccountRole::Owner),
            Some(AccountRole::Owner)
        )
        .is_ok());
    }

    // ─────────────────── #148 — the membership audit ledger ───────────────────

    /// TEST-4 — the `ActorCeiling → AuditActor` mapping, over BOTH variants, asserting the
    /// RIGHT id survives each. This is the seam #142 named as its hand-off: before the
    /// `PlatformStaff` widening the staff arm carried no id at all, so the `Admin` case below
    /// was not expressible and an admin removal could not be attributed.
    #[test]
    fn actor_ceiling_maps_to_the_right_audit_actor() {
        let staff = Uuid::new_v4();
        let member = Uuid::new_v4();

        let a = ActorCeiling::PlatformStaff {
            staff_user_id: staff,
        }
        .audit_actor();
        assert_eq!(a, AuditActor::Admin(staff), "staff ⇒ Admin, carrying the staff id");
        assert_eq!(a.kind_str(), "admin");
        assert_eq!(a.user_id(), Some(staff), "and never NULL — the whole point of the widening");

        let u = ActorCeiling::SelfService {
            actor_user_id: member,
            observed_role: AccountRole::Owner,
        }
        .audit_actor();
        assert_eq!(u, AuditActor::User(member), "self-service ⇒ User, carrying the actor id");
        assert_eq!(u.kind_str(), "user");
        assert_eq!(u.user_id(), Some(member));

        // The two kinds are DISTINGUISHABLE — INV-13b's requirement, at the type level.
        assert_ne!(a.kind_str(), u.kind_str());

        // `system` is the ONLY kind with no actor id; the table's CHECK backs this, so an
        // unattributable non-system event is not representable in either layer.
        assert_eq!(AuditActor::System.kind_str(), "system");
        assert_eq!(AuditActor::System.user_id(), None);
    }

    /// TEST-4 (second half) — the `removed` vs `left` truth table (#148 DEC-4).
    ///
    /// #142's INV-R2 funnels `POST …/members/leave` and `DELETE …/members/{user_id}` through
    /// the same `remove_member`, so the ROW is what distinguishes a self-removal from an
    /// eviction. All four (actor kind × self/other) cells are pinned, including the two that
    /// are easy to get wrong: a staff self-removal is `removed` (the authority used is the
    /// security-relevant fact), and a `system` actor is never `left` (it has no membership).
    #[test]
    fn removal_action_truth_table() {
        let me = Uuid::new_v4();
        let other = Uuid::new_v4();

        assert_eq!(
            removal_action(AuditActor::User(me), me),
            MemberEventAction::Left,
            "a member ending their OWN membership — `leave` or DELETE-self, one act",
        );
        assert_eq!(
            removal_action(AuditActor::User(me), other),
            MemberEventAction::Removed,
            "a member evicting somebody else",
        );
        assert_eq!(
            removal_action(AuditActor::Admin(me), me),
            MemberEventAction::Removed,
            "staff removing their own row acted with STAFF authority — `removed`, not `left`",
        );
        assert_eq!(
            removal_action(AuditActor::Admin(me), other),
            MemberEventAction::Removed,
        );
        assert_eq!(
            removal_action(AuditActor::System, other),
            MemberEventAction::Removed,
        );
    }

    /// TEST-20 — every `MemberEventAction` round-trips through its DB text form, and an
    /// unknown value ERRORS rather than panicking (guideline §6). A ninth value added to the
    /// migration's CHECK constraint without an arm here is caught by the round-trip half at
    /// build time and by the error half at read time — never by a panic mid-incident.
    #[test]
    fn member_event_action_round_trips_all_eight_values() {
        let all = [
            MemberEventAction::Invited,
            MemberEventAction::InviteRevoked,
            MemberEventAction::InviteResent,
            MemberEventAction::InviteExpired,
            MemberEventAction::Joined,
            MemberEventAction::RoleChanged,
            MemberEventAction::Removed,
            MemberEventAction::Left,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for a in all {
            let s = a.as_str();
            assert!(seen.insert(s), "action strings must be distinct: {s} repeated");
            assert_eq!(
                MemberEventAction::from_str(s).expect("round-trips"),
                a,
                "{s} must parse back to itself",
            );
        }
        assert_eq!(seen.len(), 8, "all eight schema values are represented in Rust");
        assert!(
            MemberEventAction::from_str("exfiltrated").is_err(),
            "an unknown DB value errors, never panics — guideline §6",
        );
    }

    /// TEST-26 — the `system`-row visibility table, pinned exhaustively. A new `MemberEventAction` makes
    /// `system_row_is_tenant_visible`'s match non-exhaustive and fails to COMPILE, which is the
    /// enforcement an earlier comment claimed a test provided and did not.
    #[test]
    fn system_row_visibility_is_decided_for_every_action() {
        for (action, expected) in [
            (MemberEventAction::Joined, false),
            (MemberEventAction::Removed, true),
            (MemberEventAction::Left, false),
            (MemberEventAction::RoleChanged, false),
            (MemberEventAction::Invited, false),
            (MemberEventAction::InviteRevoked, false),
            (MemberEventAction::InviteResent, false),
            (MemberEventAction::InviteExpired, false),
        ] {
            assert_eq!(
                system_row_is_tenant_visible(action),
                expected,
                "{} — the tenant-visibility decision for a `system` row of this action",
                action.as_str(),
            );
        }
    }
    // ---------------------------------------------------------------------------
    // TEST-5 [acceptance] [invariant: INV-R1] [covers: ITEM-10, ITEM-16] (#145)
    // ---------------------------------------------------------------------------
    /// INV-R1, at the one grader every membership-creating surface reaches:
    ///
    ///   "an account Admin cannot create a principal holding account Owner, **via ANY
    ///    surface**."
    ///
    /// `R1Target::NewMember` is the target for a mutation with no incumbent — an
    /// invitation, and `add_member`. Only the REQUESTED half can bind, which is exactly
    /// the half this invariant is about, and this test asserts that half over the full
    /// 3x3 grid plus the removal case.
    ///
    /// **The expectation is re-derived from the design's stated order via `rank()`**, not
    /// from `AccountRole`'s `Ord` and not from the implementation's own predicate — the
    /// same discipline (and for the same recorded reason) as the sibling table above: a
    /// test that copies the predicate moves in lockstep with it and can only catch a typo.
    ///
    /// What each part kills:
    ///   * dropping the `refuse_if_above_ceiling` call from `add_member` or
    ///     `create_invitation` — caught by the integration acceptance tests, not here;
    ///     this test pins the GRADER those calls depend on;
    ///   * grading `NewMember` on a current role it does not have (an early-return bug) —
    ///     caught by the "no current-role half" assertions;
    ///   * relaxing `>` to `>=` — caught by the equal-role cells, which must be ALLOWED
    ///     (an Admin may invite an `admin`, and that is what makes onboarding possible);
    ///   * tightening `>` to `>=` on the wrong side, or inverting the comparison — caught
    ///     by the strictly-above cells.
    #[test]
    fn new_member_ceiling_truth_table() {
        let mut refused = 0usize;
        for ceiling in ROLES {
            for requested in ROLES {
                // The rule, over an INDEPENDENT rank: only the requested half binds.
                let want_refusal = rank(requested) > rank(ceiling);

                let got = refuse_if_above_ceiling(ceiling, R1Target::NewMember, Some(requested));
                assert_eq!(
                    got.is_err(),
                    want_refusal,
                    "ceiling={:?} requested={:?}: expected refusal={want_refusal}",
                    ceiling,
                    requested,
                );
                if let Err(e) = got {
                    refused += 1;
                    assert_eq!(
                        e.status_code(),
                        403,
                        "R-1 is an AUTHORITY refusal (403), not an integrity one (422)"
                    );
                    assert!(
                        format!("{e:?}").contains(ROLE_ABOVE_ACTOR),
                        "the refusal must carry ROLE_ABOVE_ACTOR by name: {e:?}"
                    );
                }
            }
        }
        // 3 of the 9 cells are strictly-above: (member,admin), (member,owner),
        // (admin,owner). A grader that refused everything, or nothing, fails here even if
        // every individual cell assertion were somehow satisfied.
        assert_eq!(refused, 3, "exactly the strictly-above cells refuse");

        // THE headline cell, spelled out separately so a reader sees the invariant itself
        // rather than having to evaluate the loop: an Admin cannot mint an Owner.
        assert!(
            refuse_if_above_ceiling(
                AccountRole::Admin,
                R1Target::NewMember,
                Some(AccountRole::Owner)
            )
            .is_err(),
            "INV-R1: an account Admin must not be able to CREATE an Owner"
        );
        // And the boundary that must stay open, or an Admin cannot onboard a peer.
        assert!(refuse_if_above_ceiling(
            AccountRole::Admin,
            R1Target::NewMember,
            Some(AccountRole::Admin)
        )
        .is_ok());

        // There is NO current-role half for this target: a `NewMember` mutation carries no
        // incumbent, so with no requested role there is nothing to refuse, at any ceiling.
        // (A removal can never target a `NewMember` in practice — this pins that the
        // grader does not invent a refusal from the target alone.)
        for ceiling in ROLES {
            assert!(
                refuse_if_above_ceiling(ceiling, R1Target::NewMember, None).is_ok(),
                "no requested role and no incumbent ⇒ nothing to grade (ceiling={ceiling:?})"
            );
        }
    }

    // ---------------------------------------------------------------------------
    // FIX_ROUND-3 / FIX_ROUND-4 [covers: ITEM-11, ITEM-16] — the prune horizon must
    // DOMINATE the longest rate-limit window.
    // ---------------------------------------------------------------------------
    /// If the prune horizon ever falls to or below the longest window, the prune deletes
    /// rows the ceiling is still counting and the per-day ceiling silently becomes a
    /// shorter one. Nothing else in the tree would notice.
    ///
    /// **This compares the two CONSTS the SQL actually binds**, which is the whole point.
    /// The first version of this test compared `MINT_RETENTION.days` against a
    /// `LONGEST_WINDOW_DAYS = 1` declared in its own body — a hand-copied duplicate of the
    /// `interval '1 day'` literals that were then inside the budget query. A blind
    /// correctness audit proved that bound nothing: it widened all three SQL windows to
    /// five days and this test still reported `1 passed`. The windows are now consts too,
    /// and are passed to the query as bound parameters, so there is one definition and the
    /// comparison below is against it.
    #[test]
    fn mint_retention_dominates_the_longest_rate_limit_window() {
        // Everything is expressed in MICROSECONDS so the comparison is exact and, more
        // importantly, DST-invariant. The pre-SQLite consts were `PgInterval` values whose
        // `days`/`months` fields were calendar-sensitive — at `TimeZone='America/New_York'`,
        // `now() - interval '2 days'` spanned 47 hours across spring-forward and 49 across
        // fall-back — so this test used to have to assert the calendar fields were zero.
        // ITEM-17's sqlite port retyped the consts to plain `i64` microseconds (there is no
        // interval type on the sqlite store), and with the split gone the DST-invariance is
        // BY CONSTRUCTION; what remains to pin is that the windows are positive.
        for (name, iv) in [
            ("RATE_WINDOW_HOUR", RATE_WINDOW_HOUR),
            ("RATE_WINDOW_DAY", RATE_WINDOW_DAY),
            ("MINT_RETENTION", MINT_RETENTION),
        ] {
            assert!(iv > 0, "{name}: a non-positive window is meaningless");
        }

        // ABSOLUTE values, not just ordering. A blind audit showed that ordering plus
        // headroom is satisfied by a TWO-HOUR "day" window — mutation-verified: every unit
        // test and both INV-RL integration tests passed with `RATE_WINDOW_DAY = 2 hours`,
        // while `per_actor_per_day: 100` would then bound 100 mints per two hours (1200 a
        // day) and the refusal string's literal word "day" would be false. The old
        // `interval '1 day'` SQL literal could not be silently misvalued; a const can, so
        // the const must be pinned.
        //
        // TEST-14 covers the hour window behaviourally in ONE direction only, and the
        // direction is the opposite of what an earlier version of this comment claimed:
        // `seed_mints` inserts at the column default `now()`, so SHRINKING the window
        // leaves every seeded row inside it and TEST-14 stays green; what reddens it is
        // WIDENING past 23 hours, because `age_out_mints` backdates to exactly that. And
        // nothing anywhere exercises a DAILY ceiling — a 24-hour integration test is not a
        // thing this suite can have. So these absolute pins are the only guard for the day
        // window in either direction, and for the hour window in the shrinking direction.
        assert_eq!(
            RATE_WINDOW_HOUR, 3_600_000_000,
            "RATE_WINDOW_HOUR must be exactly one hour"
        );
        assert_eq!(
            RATE_WINDOW_DAY, 86_400_000_000,
            "RATE_WINDOW_DAY must be exactly twenty-four hours — the refusal message says \
             the word `day` and `InvitationLimits`' fields say `per_..._per_day`"
        );
        assert_eq!(
            MINT_RETENTION, 172_800_000_000,
            "MINT_RETENTION must be exactly forty-eight hours"
        );

        assert!(
            RATE_WINDOW_DAY > RATE_WINDOW_HOUR,
            "the day window must be longer than the hour window, or one of the two \
             ceilings can never fire"
        );
        assert!(
            MINT_RETENTION > RATE_WINDOW_DAY,
            "the retention horizon ({} µs) must be STRICTLY greater than the longest \
             rate-limit window ({} µs). Equal would make the prune and the window race at \
             the boundary; shorter would let the prune delete rows the ceiling was still \
             counting, silently converting the per-day ceiling into a shorter one",
            MINT_RETENTION,
            RATE_WINDOW_DAY
        );
        // And with real headroom rather than by a microsecond, so a future tweak to either
        // has to be deliberate rather than accidentally fatal.
        assert!(
            MINT_RETENTION >= 2 * RATE_WINDOW_DAY,
            "keep at least a full extra window of headroom"
        );
    }

}
