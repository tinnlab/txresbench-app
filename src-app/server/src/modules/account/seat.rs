//! #141 — the SEAT allowance seam: the counting half, and the ONLY file in this module
//! that carries a `saas` gate.
//!
//! A seat is a row in `account_members`. This module counts them and hands the count to
//! the policy ([`crate::modules::billing::seat`], saas-only) which owns the plan-derived
//! limit. `account/repository.rs` calls the two `enforce_*` entry points below and never
//! sees a `cfg`, a plan id, or a billing symbol.
//!
//! # Why the gate is HERE and not at the call site
//!
//! Every comparable seam in the tree puts `#[cfg(feature = "saas")]` on the `pub mod`
//! (`jobs/mod.rs`) or at the call site (`workstore/ingest.rs`). Neither is available in
//! this module: `tests/account/saas_gating_test.rs::account_model_is_never_saas_gated` —
//! an `[acceptance]` test for A1's INV-3 / AC-INV-6 — asserts that
//! `account/{mod,models,permissions,repository,scope}.rs` contain NO
//! `cfg(feature = "saas")` at all, because the account graph and the `account_id`
//! ownership key must exist in both builds. Gating the `pub mod` or the call site would
//! turn that test red, and editing a shipped acceptance test to accommodate this item
//! would weaken a real invariant.
//!
//! **What is gated is the seat POLICY, not the whole file.** The transaction-context
//! assertion and the account-row re-lock run in BOTH builds, because the caller obligation
//! they enforce also underwrites `resolve_ceiling`'s R-1 re-read, which is a security control
//! present in both (FIX_ROUND-4 R4-2). An earlier version of this doc said the non-saas arm
//! "touches no database", which the repositioning made false (FIX_ROUND-5, R5-2).
//!
//! So the gate is confined to this one file, which is declared UNGATED in `mod.rs`. The
//! effect is identical to compiling out (research §5: *"on a desktop/OSS build there is no
//! billing module, so the seat check compiles out and `member_allowance` is unlimited"*):
//! the non-saas arm below is a total no-op that touches no database and links no billing
//! symbol. And the property that matters more — *"the membership routes themselves are not
//! saas-gated"* — is preserved exactly, because nothing else in the module moved.
//!
//! # ONE enforcement point, and why there is not a second (#141 DEC-3 CORRECTION)
//!
//! [`enforce_member_seat`] is the only seat check in the tree, called from exactly one
//! place: `AccountRepository::add_member_in_tx`, the single function through which every
//! membership added to an EXISTING account passes (the admin path via `add_member`, #146's
//! invitation accept on its own transaction connection). "One source of truth" is therefore
//! a structural fact here, not a claim about which check outranks which.
//!
//! A seat is a row in `account_members`. That is what "who has access" means, it is what
//! costs (a full workspace, concurrent jobs against ONE compute allowance), and it is what
//! research §5 names: *"the moment a membership row is created"*.
//!
//! **An advisory pre-check at invitation MINT was built, run, and reverted.** §5 sanctions
//! one, and the motivation is real — an invite that cannot be redeemed pushes the refusal
//! onto the invitee, a stranger who did nothing wrong, days later, with no upgrade path.
//! Two things killed it, both found by running rather than by reasoning:
//!
//! 1. **It reintroduced the enumeration oracle #145's INV-8 exists to close.** Only two of
//!    `create_invitation`'s four cases mint; the other two are no-ops. Counting members +
//!    live invitations therefore made occupancy rise on exactly the minting cases, so a
//!    caller could infer an EARLIER address's case from a LATER call's refusal.
//!    `inv8_invitation_create_is_enumeration_safe_across_all_four_cases` caught it.
//! 2. **It refused writes that consume no seat** — at the limit, re-inviting a live address
//!    and inviting an existing member both 422'd, breaking #145's documented idempotency.
//!
//! The UX survives without it: #141 puts `member_allowance` + `members_used` on
//! `GET /api/billing/quota`, so the invite UI (#149) can render "10 of 10 seats" and warn
//! before the admin submits. A read the client already makes beats a refusal that costs a
//! security invariant.
//!
//! **What a seat check must NOT count, learned the same way.** It must not count the
//! principal it is being asked about. `add_member_in_tx`'s INSERT is
//! `ON CONFLICT (account_id, user_id) DO NOTHING`, so re-adding an EXISTING member consumes
//! no seat — but a naive `count(*)` includes that member in the very number that refuses
//! them, turning a documented 409/idempotent outcome into a 422 at the boundary. Under #146
//! that would mean an already-member redeeming an invitation gets a seat refusal instead of
//! the idempotent accept #145's comments promise. [`member_ids`] returns the
//! member IDS, so the exclusion is exact and free.
//!
//! # Freshness — the count rides the caller's transaction and lock
//!
//! [`enforce_member_seat`] takes `&mut PgConnection`, never a pool, and its caller has
//! already taken `lock_account_row` (`accounts … FOR NO KEY UPDATE`) on that same
//! connection — the serialization point EVERY membership mutation in this module takes
//! first — so a concurrent add blocks until the first commits and then counts the committed
//! row. This is the `min(observed, live)`-after-the-lock discipline #142 established and
//! #145 followed, applied to a count instead of a role.
//!
//! **That used to be a comment, and a comment is not a guarantee — so it is now CHECKED**
//! ([`assert_serializable_context`], FIX_ROUND-1 F1). Two blind audits independently found
//! the same hole from opposite directions, and both are closed by the same assertion:
//!
//! * `&mut PgConnection` also accepts a bare pooled connection in AUTOCOMMIT. There, every
//!   `FOR UPDATE` above releases at statement end, so the ceiling re-read, the seat count
//!   and the INSERT all run unserialized and two callers could both take the last seat.
//!   `add_member_in_tx` is `pub` and #146 will call it, so this is a reachable mistake, not
//!   a hypothetical.
//! * Under **REPEATABLE READ** — a plausible choice for a multi-step accept transaction —
//!   the count is taken from a snapshot older than a competing committed add, and a
//!   committed `FOR NO KEY UPDATE` row lock does NOT raise a serialization error for a
//!   repeatable-read locker. Both accepts would pass, silently, with no error anywhere.
//!
//! The assertion refuses both with [`SEAT_NO_TRANSACTION`] / [`SEAT_UNSERIALIZED_ISOLATION`] (500) rather than
//! admitting a member on an unsound count. It is one extra `SELECT` on a path that already
//! runs four, and it converts an unwritten caller obligation into a failure the caller
//! cannot miss.
//!
//! # `accounts.admin_suspended` is NOT consulted — #235, #141 DEC-6
//!
//! A suspended organization with a free seat can still add a member, exactly as it can
//! today. That is a deliberate non-change, not an oversight, and it is the fourth item in
//! this epic to record it rather than absorb it (#139, #142, #145). The reasons it is not
//! fixed here specifically:
//!
//! 1. The two refusals must stay distinguishable — `SEAT_LIMIT_REACHED` carries an upgrade
//!    path, a suspension refusal carries a SUPPORT path — and `member_scope.rs`'s own
//!    analysis says the suspension refusal "needs its own code rather than a reuse of an
//!    existing 403". Minting that code here decides #235's wire contract from an item that
//!    does not own it.
//! 2. It would refuse the PLATFORM-STAFF path too. `add_member_in_tx` is reached at
//!    `ActorCeiling::PlatformStaff` by the admin surface — an operator repairing an account
//!    whose own owners cannot. A blanket refusal removes the operator's escape hatch from
//!    a hold the operator set; carving staff out means deciding which ceilings a suspension
//!    binds, which is more unratified #235 semantics.
//! 3. It would put a security control on the SAAS side of a `cfg`. This check compiles out
//!    on desktop; `admin_suspended` is an unconditional column. A refusal that exists only
//!    in the saas build looks like coverage and is not.
//!
//! **What this item contributes instead, which its three predecessors could not.** The
//! choke point is now PROVEN rather than asserted: `add_member_in_tx` is the sole path by
//! which a member is added to an EXISTING account, and
//! `tests/account/seat_allowance_test.rs` enumerates every `INSERT INTO account_members` in
//! the tree to keep it that way (the other two are account-CREATION sites that write the
//! founding owner row). So #235's "block granting" option is now a ONE-LINE edit at ONE
//! place — **immediately below this comment, at the top of [`enforce_member_seat`]** —
//! on an unconditional code path, with the actor's ceiling already in scope to carve staff
//! out. `tests/account/seat_allowance_test.rs` pins today's behaviour so making that
//! change is deliberate and test-visible rather than silent.

use sqlx::PgConnection;
use uuid::Uuid;
use ziee_core::AppError;

/// Refusal code: the seat check was reached with **no open transaction** (autocommit), so
/// the account-row lock cannot persist across the count and the INSERT it guards.
///
/// A 500, not a 4xx: a SERVER wiring bug, never anything the client did. (The nearest
/// precedent in this epic is [`AccountScope`](super::member_scope::AccountScope) step 3,
/// which 500s when a route omits its path parameter — a wiring bug is not the caller's
/// fault. It is NOT `lock_account_row`, which deliberately answers a missing account with
/// 404 for a non-oracle reason; an earlier version of this doc cited it and was wrong.)
///
/// Named, and SEPARATE from [`SEAT_UNSERIALIZED_ISOLATION`], because "the guard refused" and
/// "the guard refused for the RIGHT reason" are different claims and a test that cannot tell
/// the two branches apart is not testing either (FIX_ROUND-2, R2-4).
pub const SEAT_NO_TRANSACTION: &str = "SEAT_NO_TRANSACTION";

/// Refusal code: the caller's transaction is at an isolation level whose snapshot can
/// predate a competing committed add. See [`assert_serializable_context`].
pub const SEAT_UNSERIALIZED_ISOLATION: &str = "SEAT_UNSERIALIZED_ISOLATION";

/// Refusal code: the account's `plan_id` names no catalog tier, so there is no allowance to
/// enforce and the guard fails CLOSED.
///
/// Distinct from [`SEAT_LIMIT_REACHED`](crate::modules::billing::seat::SEAT_LIMIT_REACHED)
/// because it is a different problem with a different remedy, and conflating them produced a
/// refusal that actively misdirected the reader: an unknown plan used to report "using 3 of
/// its 0 included seats on plan `bogus` — upgrade the plan to add more members", which names
/// an upgrade as the fix when the actual fix is to give the account a plan the catalog knows
/// (FIX_ROUND-3, R3-3).
#[cfg(feature = "saas")]
pub const SEAT_PLAN_UNKNOWN: &str = "SEAT_PLAN_UNKNOWN";

/// Refuse unless this connection is inside a transaction at an isolation level under which
/// the count that follows can see a competing committed add.
///
/// # Why an assertion and not a comment
///
/// The soundness of the seat count is a CALLER obligation, and `&mut PgConnection` expresses
/// none of it — it accepts a bare pooled connection in autocommit just as happily. An
/// obligation that lives only in prose is one an implementer can satisfy by accident and
/// break by accident.
///
/// # It runs AFTER the account lock, and that ordering is the point (FIX_ROUND-3)
///
/// The probe is `pg_current_xact_id_if_assigned() IS NOT NULL` — literally "has this
/// transaction assigned an xid", which is not the same proposition as "a transaction is
/// open". [`enforce_member_seat`] therefore takes the account row's lock FIRST and calls this
/// SECOND, which makes the two propositions coincide: the lock statement assigns an xid, so
/// inside a real transaction the answer is always yes, while in autocommit that statement was
/// its own transaction and its xid is already gone. Ordered the other way round (as
/// FIX_ROUND-2 had it) a perfectly correct caller that had not yet written anything would be
/// refused. Asking the question must also not answer it: `pg_current_xact_id_if_assigned` is
/// the NON-assigning variant.
///
/// # Only READ COMMITTED is accepted, and SERIALIZABLE is refused for a REAL reason
///
/// FIX_ROUND-2 accepted SERIALIZABLE, reasoning that it aborts on exactly the read-write
/// conflict REPEATABLE READ hides. **That was wrong in this deployment, and the correction
/// is the most important thing in this file.** PostgreSQL's SSI only serializes a
/// transaction against OTHER SERIALIZABLE transactions. Nothing sets
/// `default_transaction_isolation`, and the shipped caller (`AccountRepository::add_member`
/// → `pool.begin()`) is READ COMMITTED. So a SERIALIZABLE caller — exactly the #146 accept
/// this guard exists for — racing a READ COMMITTED admin add gets the failure verbatim: its
/// snapshot predates the competing commit; re-acquiring `accounts … FOR NO KEY UPDATE`
/// raises no `40001`, because a lock-only tuple was never *updated*; the member read then
/// returns the stale snapshot and misses the committed row; and no SSI abort fires, because
/// the counterparty is not serializable. **Both adds take the last seat.**
///
/// So the accepted set is exactly `read committed`. That is not caution about untested
/// levels — it is the only level under which this count's freshness follows from anything.
/// If a caller genuinely needs SERIALIZABLE, the fix is for EVERY membership-mutating
/// transaction to become serializable, which is a deployment-wide decision this function
/// must not make silently by accepting one.
pub(crate) async fn assert_serializable_context(conn: &mut PgConnection) -> Result<(), AppError> {
    let row = sqlx::query!(
        r#"SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS "in_tx!",
                  current_setting('transaction_isolation') AS "isolation!""#
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(AppError::database_error)?;

    if !row.in_tx {
        // Logged, not only returned: these 500s are declared to mean "a server wiring bug",
        // which is the one class an operator must be able to find in logs — and the previous
        // version recorded the event nowhere but in the client's response body (R3-5).
        tracing::error!(
            "membership add reached a connection with no open transaction — REFUSED rather \
             than admitted on an unserialized ceiling re-read and seat count"
        );
        return Err(AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            SEAT_NO_TRANSACTION,
            "a membership add reached a connection with no open transaction — the account \
             lock cannot persist across the checks and the INSERT it guards. Call \
             `add_member_in_tx` inside the transaction that performs the membership INSERT.",
        ));
    }
    if row.isolation != "read committed" {
        tracing::error!(
            isolation = %row.isolation,
            "membership add reached a transaction at an unsupported isolation level — \
             REFUSED rather than admitted on possibly-stale reads"
        );
        return Err(AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            SEAT_UNSERIALIZED_ISOLATION,
            format!(
                "a membership add reached a transaction at isolation level `{}` — its reads \
                 could be taken from a snapshot predating a competing committed add, and \
                 neither the account-row lock nor SSI would catch it (SSI only serializes \
                 against other SERIALIZABLE transactions, and this deployment's membership \
                 adds are READ COMMITTED). Open the membership transaction at READ \
                 COMMITTED, the default.",
                row.isolation
            ),
        ));
    }
    Ok(())
}

/// The seat check: refuse if adding `joining_user_id` would take `account_id` past its
/// plan's `member_allowance` (#141 INV-6).
///
/// Called from `AccountRepository::add_member_in_tx` — the single function through which
/// every membership added to an EXISTING account passes, and therefore the single place
/// this is enforced. The admin add path reaches it via `add_member`; #146's invitation
/// accept reaches it on its own transaction connection, which is the seam #145 shipped for
/// exactly that purpose. #146 needs no seat code of its own and has no membership INSERT
/// path that bypasses this.
///
/// **`joining_user_id` is EXCLUDED from the count when they are already a member**, because
/// such an add consumes no seat: the INSERT is `ON CONFLICT DO NOTHING`, so it writes
/// nothing and the pre-existing 409/idempotent outcome must survive. Counting them would
/// put the member being re-added into the very number that refuses them — and under #146
/// it would turn an already-member's idempotent redemption into a seat refusal, which is
/// not what "an accept that WOULD take the account past `member_allowance`" means.
///
/// **NO EVICTION.** The limit gates NEW memberships only. An account already above its
/// allowance — because the limit was introduced, or lowered, or because a `premium` comp
/// was cleared — keeps every member it has; this refuses the next add and removes nobody.
/// There is deliberately no code path here that deletes a membership, and there must not
/// be one: turning this into an eviction would silently revoke tenant-wide access from
/// existing members, which no operator asked for.
///
/// **Refuses BEFORE any write**, so a caller's transaction rolls back with nothing
/// committed — which is what leaves a seat-refused invitation still PENDING and usable
/// once a seat frees, rather than burned (#141 DEC-5).
///
/// **The account row is locked HERE, not assumed** ([`lock_account_for_seat_count`]), and the
/// transaction context is asserted HERE too ([`assert_serializable_context`]) — so this
/// function's soundness does not depend on any caller remembering anything. Its caller
/// asserts the same thing EARLIER, to cover the R-1 ceiling re-read that runs before this
/// point; the two are independent and both are cheap.
///
/// `pub(crate)`, for the reason `billing::seat::enforce_on` is: the count's freshness is a
/// property of HOW it is called, so the reachable callers should be a set a reader can
/// enumerate rather than an open surface (FIX_ROUND-2, R2-3).
///
/// **On a build without `saas` the seat ALLOWANCE is unlimited** — no plan is read, no limit
/// is applied, and INV-3's behavioural promise holds exactly (TEST-5 drives 16 real adds past
/// every shipped tier on a default build).
///
/// It is no longer a *total* no-op, and saying so would be false (FIX_ROUND-5, R5-2): the
/// account-row re-lock runs in both builds, and the context assertion its caller makes runs
/// in both builds, because those protect R-1 rather than seats. What compiles out is the
/// billing half — the plan lookup, the comp read and the limit decision.
pub(crate) async fn enforce_member_seat(
    conn: &mut PgConnection,
    account_id: Uuid,
    joining_user_id: Uuid,
) -> Result<(), AppError> {
    // ── #235 would land HERE (see the module doc) — a suspension refusal placed before
    // the count, with its own error code, carving out `ActorCeiling::PlatformStaff`. It is
    // deliberately absent (#141 DEC-6). ──
    // ── The transaction-context guard (FIX_ROUND-4 R4-2, repositioned FIX_ROUND-5 R5-3) ──
    //
    // It was inside the saas gate, and a blind audit pointed out that this made it exactly
    // the thing this module's own doc refuses elsewhere: "a refusal that exists only in the
    // saas build looks like coverage and is not". The caller obligation it enforces is NOT
    // a billing property. `add_member_in_tx` is `pub` in both builds, and the OTHER thing
    // that depends on the same obligation is `resolve_ceiling`'s live R-1 re-read — a
    // SECURITY control, whose own doc says it "is only sound on a connection that already
    // holds the account's owner rows". On a desktop build, a caller passing an autocommit
    // pooled connection got an unserialized ceiling check and a silent INSERT, with nothing
    // to refuse it. Two cheap statements close that for every build.
    //
    // The assertion runs in TWO places, deliberately (FIX_ROUND-6, R6-3/R6-4/R6-5).
    //
    // `add_member_in_tx` asserts it early — after `lock_account_row`, BEFORE
    // `resolve_ceiling` — because that is what protects the R-1 ceiling re-read; asserting
    // only here meant R-1 had already read unserialized by the time the guard fired
    // (FIX_ROUND-5, R5-3). It is asserted AGAIN here because moving it out turned this
    // function's precondition into an unwritten caller obligation — precisely what
    // `assert_serializable_context`'s own doc says such a guard exists to prevent. This
    // function is `pub(crate)` and its doc invites #146 to call it; a second in-crate caller
    // on an autocommit connection would otherwise get an unserialized count and an
    // unserialized plan/comp read with nothing to refuse it.
    //
    // Both are cheap and idempotent, and together they restore the property this function's
    // doc claims: its soundness does not depend on any caller remembering anything.
    lock_account_for_seat_count(&mut *conn, account_id).await?;
    assert_serializable_context(&mut *conn).await?;

    #[cfg(feature = "saas")]
    {
        let members = member_ids(&mut *conn, account_id).await?;
        if members.contains(&joining_user_id) {
            // Already a member: the INSERT will be a no-op, so no seat is consumed and the
            // caller's own duplicate handling (409) must be what answers.
            return Ok(());
        }
        // Members only. There is exactly one enforcement point and it counts membership rows
        // (the module doc's DEC-3 CORRECTION). A `pending_invitations` parameter existed
        // here and was removed with the mint check that would have produced it — a
        // parameter every caller passes 0 for is a branch nothing can reach (FIX_ROUND-4,
        // R4-6).
        crate::modules::billing::seat::enforce_on(&mut *conn, account_id, members.len() as i64)
            .await
    }
    #[cfg(not(feature = "saas"))]
    {
        // Desktop/OSS: no billing module, so no seat LIMIT — but the transaction-context
        // guard above still ran, because it protects R-1, not seats. Explicitly consumed so
        // the signature is identical in both builds and no `unused` warning is silenced by a
        // blanket allow.
        let _ = joining_user_id;
        Ok(())
    }
}

/// Take the account row's `FOR NO KEY UPDATE` lock — the serialization point EVERY
/// membership-mutating path in this module takes first — on the caller's connection.
///
/// **Taken here rather than assumed (FIX_ROUND-2, R2-3).** `add_member_in_tx` already takes
/// it before reaching the seat check, and re-acquiring a lock a transaction already holds
/// is free, so this is a no-op for the real caller. Its value is for the caller that does
/// NOT: a blind audit observed that the previous "an xid is assigned" assertion could not
/// distinguish "you hold the account row" from "you locked something else first", so a
/// `pub` caller could pass the check with no serialization at all. Guaranteeing the
/// precondition beats testing a proxy for it, at the cost of one statement that is usually
/// a no-op.
///
/// The statement is `lock_account_row`'s, deliberately duplicated rather than made public:
/// that function is the repository's own private serialization primitive, and widening it
/// so a sibling module could call it would put the module's lock discipline on a public
/// surface. A missing row is an absent account — 404, byte-identical to the extractor's
/// non-member refusal — but it is unreachable here, because the caller has already taken
/// this same lock and holds the row.
async fn lock_account_for_seat_count(
    conn: &mut PgConnection,
    account_id: Uuid,
) -> Result<(), AppError> {
    sqlx::query_scalar!(
        r#"SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE"#,
        account_id,
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(AppError::database_error)?
    .map(|_| ())
    .ok_or_else(|| AppError::not_found("Account"))
}

/// The account's member user ids, on the caller's connection, behind the account-row lock
/// [`lock_account_for_seat_count`] just took.
///
/// The IDS rather than a `count(*)`, because [`enforce_member_seat`] must EXCLUDE a user who
/// is already a member and the list makes that exact and free.
///
/// **A plain read, not `FOR UPDATE` (FIX_ROUND-2, R2-9.)** An earlier version locked every
/// member row, argued from making research §5's wording ("after locking the account's member
/// rows") literally true. A blind audit established that motivation was cosmetic and the cost
/// was not: the accounts-row lock ALREADY serializes every membership mutation — all five
/// member-row-touching paths take it first, so ordering is uniformly `accounts →
/// account_members` — and it verified there are no foreign keys INTO `account_members`, so
/// nothing else needed the row locks either. What the `FOR UPDATE` did buy was an O(n) `xmax`
/// write to every member row on every add and a new contention edge against the user
/// hard-delete cascade (which takes no accounts-row lock, in a deployment where
/// `lock_timeout` is 0). Serialization comes from the account row; this read only has to be
/// behind it.
#[cfg(feature = "saas")]
async fn member_ids(conn: &mut PgConnection, account_id: Uuid) -> Result<Vec<Uuid>, AppError> {
    sqlx::query_scalar!(
        r#"SELECT user_id FROM account_members WHERE account_id = $1"#,
        account_id,
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(AppError::database_error)
}

// There is deliberately NO `count_members` here (FIX_ROUND-3, R3-6). One already exists —
// `AccountRepository::count_members` — and it is what `billing::handlers::build_quota_state`
// now calls for the "N of M seats" read surface. The first version of this module added a
// byte-identical second one taking `&mut PgConnection`, which forced its caller to do a
// `pool.acquire()`/`drop` dance for a plain read AND put two public functions with the same
// name and the same meaning in two modules of one crate. The enforcement path's counting
// primitive is `member_ids` above, which is a different function answering a different
// question (WHICH members, behind the lock) — not a second spelling of the same one.

// TEST-5 [acceptance, INV-3] — the desktop half of INV-3 ("the seat check compiles out and
// `member_allowance` is unlimited") is proven BEHAVIOURALLY, not here: an in-crate unit test
// cannot exercise these arms honestly, because they take a live `&mut PgConnection` and a
// unit test has no database to produce one. Faking it would be a test that asserts nothing.
//
// So it lives at `tests/account/seat_allowance_test.rs::test5_desktop_build_has_no_seat_limit`,
// under `#[cfg(not(feature = "saas"))]`, where it drives the REAL membership route past the
// catalog's `free.member_allowance` on a default build and asserts every add succeeds — with
// the saas arm of the same file asserting the same request is refused. Same pattern as
// `dataset/upload_limits_test.rs`, which pairs a saas ceiling test with a desktop no-ceiling
// test in one file.
