//! #141 — the SEAT allowance: `member_allowance` in the plan catalog, enforced
//! transactionally at membership creation.
//!
//! Realizes `docs/research/account-self-service-membership.md` §5 (`be009a2e`) and issue
//! #141's INV-10 / INV-10b.
//!
//! # Which build each test runs on, and why the file has two arms
//!
//! The seat check compiles out without `saas` (research §5 / INV-3), so the
//! enforcement tests must run under `--features saas` and the "desktop is unlimited" test
//! must run WITHOUT it. Both arms live in this one file — the same pairing
//! `dataset/upload_limits_test.rs` uses for the upload ceiling — so the two halves of
//! INV-3 can never drift apart, and the file-level tests (source enumeration, generated
//! openapi) run on BOTH builds because they are build-independent.
//!
//! # The only HTTP add-member route today is the ADMIN one
//!
//! There is no self-service member-ADD route: `account/routes.rs` mounts list / leave /
//! remove / set-role / invitations, and the self-service add path is
//! invitation-then-accept, which is #146's and does not exist yet. So the real-route arms
//! here drive `POST /api/admin/accounts/{account_id}/members`, which reaches
//! `add_member` at `ActorCeiling::PlatformStaff`, and the #146-shaped arms drive
//! `AccountRepository::add_member_in_tx` directly on a caller-owned transaction — which is
//! exactly the shape #146 will use.
//!
//! **The seat limit binds PlatformStaff too (#141 DEC-10), and that is deliberate.**
//! `ActorCeiling` grades authority to CONFER A ROLE; a seat is CAPACITY, which does not
//! vary with who is asking. Exempting staff would also make the guard unreachable today —
//! dead code shipped as a control — since the admin route is currently its only caller.
//! The operator's escape hatch is the audited per-account `premium` comp (DEC-4), not an
//! unlogged blanket bypass.

// #146 widened `add_member_in_tx` with an `invitation_id: Option<Uuid>` (DEC-4) so the
// `joined` ledger row can tie back to the invitation it was redeemed from. Every call site
// here is an ADMIN/direct add, which has no invitation — hence `None`. Mechanical: no
// assertion in this file changed.

use serde_json::Value;
use sqlx::SqlitePool;

use super::{add_member, create_user, make_org_account, pool_for, setup_admin};
use crate::common::TestServer;

/// The refusal code, spelled out here rather than imported, so the test binds to the WIRE
/// CONTRACT: if the constant were renamed the API would change and this must notice.
/// 422 is already emitted on these routes by `LAST_OWNER` and
/// `PERSONAL_ACCOUNT_NOT_MANAGEABLE`, so the status alone identifies nothing.
const CODE: &str = "SEAT_LIMIT_REACHED";

/// The acting staff principal for the direct-repository arms of this suite.
///
/// #148 widened `ActorCeiling::PlatformStaff` from a unit variant to
/// `PlatformStaff { staff_user_id }`, so a staff-performed membership change can be
/// ATTRIBUTED in `account_member_events` — the widening `add_member_in_tx`'s own doc
/// predicted #148 would need ("`ActorCeiling::PlatformStaff` is a unit variant carrying no
/// id, so #148 must widen it").
///
/// A fixed id is correct here rather than a real user's: the seat guard reads no actor id on
/// the `PlatformStaff` arm — `resolve_ceiling` returns `None` for it, so no assertion in this
/// file can depend on which principal it names. The arms that DO care about actor identity
/// use `SelfService` with a real user (TEST-20 ARM 4).
const STAFF_ACTOR: uuid::Uuid = uuid::Uuid::nil();

fn code_of(body: &Value) -> &str {
    body["error_code"].as_str().unwrap_or("<none>")
}

/// `SELECT count(*) FROM account_members` — the DB-layer truth the invariant is stated in.
/// Every refusal assertion in this file re-queries it, because "the response said 422" and
/// "no membership row was created" are different claims and only the second is INV-10.
async fn member_count(pool: &SqlitePool, account: uuid::Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM account_members WHERE account_id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("count members")
}

/// The member set as an ORDERED, comparable snapshot — used by the cross-tenant test to
/// prove the OTHER account was untouched, rather than merely that its count is the same.
async fn member_snapshot(pool: &SqlitePool, account: uuid::Uuid) -> Vec<(uuid::Uuid, String)> {
    sqlx::query_as::<_, (uuid::Uuid, String)>(
        "SELECT user_id, role FROM account_members WHERE account_id = $1 ORDER BY user_id",
    )
    .bind(account)
    .fetch_all(pool)
    .await
    .expect("snapshot members")
}

/// The `free` tier's seat allowance, read from the CATALOG rather than hardcoded — the
/// numbers are an owner call (#141 DEC-8) and re-pricing must not break these tests.
#[cfg(feature = "saas")]
fn free_allowance() -> i64 {
    txresbench::modules::billing::catalog::plan("free")
        .expect("the free plan exists")
        .member_allowance
}

/// Fill `account` to exactly `target` members with freshly created users, returning the
/// ids of everyone added. The account starts with its owner, so this adds `target - 1`.
/// Direct SQL, like `make_org_account`'s own owner insert — filling through the guarded
/// route would make the fixture depend on the thing under test.
async fn fill_to(
    server: &TestServer,
    admin: &str,
    pool: &SqlitePool,
    account: uuid::Uuid,
    target: i64,
    prefix: &str,
) -> Vec<uuid::Uuid> {
    let mut added = Vec::new();
    let start = member_count(pool, account).await;
    for i in start..target {
        let u = create_user(
            server,
            admin,
            &format!("{prefix}{i}"),
            &format!("{prefix}{i}@x.test"),
        )
        .await;
        add_member(pool, account, u, "member").await;
        added.push(u);
    }
    assert_eq!(
        member_count(pool, account).await,
        target,
        "fixture: filled to {target}"
    );
    added
}

// ───────────────────────────── saas arm: the enforcement ─────────────────────────────

/// TEST-6 [acceptance, INV-6] [covers: ITEM-6, ITEM-4] — the A9 DENY test with its
/// POSITIVE CONTROL in one body.
///
/// The invariant has three clauses and a status-only assertion proves only the first:
/// refused with 422, **no `account_members` row created**, and an add UNDER the limit
/// creates exactly one. The middle clause is the one an implementation gets wrong (a check
/// placed after the INSERT satisfies the status and violates the invariant), so the DB
/// count is re-queried on both arms.
///
/// The control is what makes the deny mean something: without it, "the add was refused"
/// would also pass if the route were broken, the token wrong, or the account id bogus.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test6_seat_limit_refuses_at_the_allowance_and_admits_below_it() {
    use crate::admin::{admin_add_member, admin_remove_member};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin, "owner6", "owner6@x.test").await;
    let org = make_org_account(&pool, "Seat Lab", owner).await;
    let limit = free_allowance();

    // A fresh org is on `plan_id = 'free'` (NOT NULL DEFAULT). Fill it to exactly `limit`.
    let filled = fill_to(&server, &admin, &pool, org, limit, "seat6_").await;
    let before = member_count(&pool, org).await;
    assert_eq!(before, limit);

    // ── DENY: the (limit + 1)th member ──
    let extra = create_user(&server, &admin, "extra6", "extra6@x.test").await;
    let (status, body) =
        admin_add_member(&server, Some(&admin), &org.to_string(), extra, "member").await;

    assert_eq!(status, 422, "at the allowance the add is refused: {body}");
    assert_eq!(
        code_of(&body),
        CODE,
        "refused BY NAME — 422 is also LAST_OWNER and PERSONAL_ACCOUNT_NOT_MANAGEABLE \
         on these routes, so the status alone identifies nothing: {body}"
    );
    // INV-2: the refusal carries the numbers the FE renders an upgrade path from.
    assert_eq!(body["details"]["plan_id"], "free", "body: {body}");
    assert_eq!(body["details"]["limit"], limit, "body: {body}");
    assert_eq!(body["details"]["current"], limit, "body: {body}");
    // INV-6's middle clause — the one a status assertion misses.
    assert_eq!(
        member_count(&pool, org).await,
        before,
        "the refused add created NO account_members row"
    );

    // ── POSITIVE CONTROL: free one seat, repeat the IDENTICAL request ──
    let freed = filled[0];
    let rm = admin_remove_member(&server, Some(&admin), &org.to_string(), freed).await;
    assert!(
        (200..300).contains(&rm),
        "fixture: freeing a seat should succeed, got {rm}"
    );
    assert_eq!(member_count(&pool, org).await, limit - 1);

    let (status2, body2) =
        admin_add_member(&server, Some(&admin), &org.to_string(), extra, "member").await;
    assert_eq!(
        status2, 201,
        "the SAME request, one seat below the limit, succeeds: {body2}"
    );
    assert_eq!(
        member_count(&pool, org).await,
        limit,
        "and it created exactly ONE membership"
    );
}

/// TEST-7 [acceptance, INV-1] [covers: ITEM-6] — the RACE clause: *"after locking … so two
/// simultaneous accepts cannot both pass."*
///
/// Two genuinely concurrent HTTP adds of two DIFFERENT users against the LAST free seat.
/// Exactly one must win. This fails if the count is taken before `lock_account_row`, or on
/// a pooled connection, or outside the transaction that does the INSERT.
///
/// Repeated, because a single trial can pass by luck if the two requests happen to
/// serialize in the client.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test7_two_concurrent_adds_against_the_last_seat_yield_exactly_one_winner() {
    use crate::admin::admin_add_member;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limit = free_allowance();

    /// Simultaneous adds per round, all racing for ONE free seat.
    const CONTENDERS: usize = 5;

    for round in 0..4 {
        let owner = create_user(
            &server,
            &admin,
            &format!("owner7_{round}"),
            &format!("owner7_{round}@x.test"),
        )
        .await;
        let org = make_org_account(&pool, &format!("Race Lab {round}"), owner).await;

        // One seat left.
        fill_to(&server, &admin, &pool, org, limit - 1, &format!("r{round}_")).await;

        let mut contenders = Vec::new();
        for c in 0..CONTENDERS {
            contenders.push(
                create_user(
                    &server,
                    &admin,
                    &format!("c7_{round}_{c}"),
                    &format!("c7_{round}_{c}@x.test"),
                )
                .await,
            );
        }

        // FIX_ROUND-1 F13: CONTENDERS simultaneous requests, not two. With two, a run in
        // which the client happened to serialize them end-to-end still yields 1x201/1x422
        // and passes — so the claim rested on luck. With five in flight per round over four
        // rounds, twenty requests would all have to serialize for the race to go
        // unexercised, and any over-admission shows up directly as a member count of
        // `limit + k`.
        let id = org.to_string();
        let results = futures_util::future::join_all(
            contenders
                .iter()
                .map(|c| admin_add_member(&server, Some(&admin), &id, *c, "member")),
        )
        .await;

        let statuses: Vec<u16> = results.iter().map(|r| r.0).collect();
        let wins = statuses.iter().filter(|s| **s == 201).count();
        let refusals = statuses.iter().filter(|s| **s == 422).count();

        assert_eq!(
            wins, 1,
            "round {round}: exactly ONE of {CONTENDERS} concurrent adds takes the last seat \
             (got {statuses:?}; bodies {:?})",
            results.iter().map(|r| &r.1).collect::<Vec<_>>()
        );
        assert_eq!(
            refusals,
            CONTENDERS - 1,
            "round {round}: every loser is refused with 422, not a 500 or a hang \
             (got {statuses:?})"
        );
        for r in results.iter().filter(|r| r.0 == 422) {
            assert_eq!(code_of(&r.1), CODE, "every loser's refusal is the seat limit");
        }

        assert_eq!(
            member_count(&pool, org).await,
            limit,
            "round {round}: the account lands EXACTLY at the allowance, never one over"
        );
    }
}

/// TEST-8 [acceptance, INV-1] [covers: ITEM-7] — membership creation is the ONLY
/// enforcement point, and invitation MINT is deliberately not one (#141 DEC-3 CORRECTION).
///
/// This test exists because the opposite was built first. An advisory seat check on
/// `create_invitation` — which research §5 explicitly sanctions — was implemented, run, and
/// reverted, because running it showed it costs a shipped security invariant: only two of
/// that function's four cases MINT, so occupancy rises on exactly the minting cases, and a
/// caller could infer an EARLIER address's case from a LATER call's refusal. #145's
/// `inv8_invitation_create_is_enumeration_safe_across_all_four_cases` caught it.
///
/// So the three claims asserted here, on ONE account, in one body:
///   (a) minting is UNGATED at and above the limit — a full account still issues invitations
///       (and #145's four-case uniformity is therefore untouched);
///   (b) a membership creation for the invited address IS refused with the seat code and
///       writes no `account_members` row — so (a) does not weaken the limit.
///
/// **Scope, stated because the first version overclaimed it (FIX_ROUND-2, R2-5).** There is
/// no accept endpoint in the tree yet, so (b) drives `add_member_in_tx` directly rather than
/// redeeming anything; it cannot and does not prove "the invitation was not consumed",
/// because nothing reachable from `add_member_in_tx` touches `account_invitations` at all.
/// Assertions to that effect were REMOVED rather than kept as reassuring decoration: they
/// held for every possible implementation, including one with no seat guard, which is the
/// definition of an idle control. That property belongs to #146 and is #146's to assert.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test8_minting_is_ungated_and_membership_creation_is_the_only_authority() {
    use txresbench::modules::account::invitation_limits::InvitationLimits;
    use txresbench::modules::account::{AccountRepository, AccountRole, ActorCeiling};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limit = free_allowance();

    let owner = create_user(&server, &admin, "owner8", "owner8@x.test").await;
    let org = make_org_account(&pool, "Mint Lab", owner).await;
    let repo = AccountRepository::new(pool.clone());

    // Fill the account to EXACTLY its allowance, so every claim below is at the boundary.
    let filled = fill_to(&server, &admin, &pool, org, limit, "seat8_").await;
    assert_eq!(member_count(&pool, org).await, limit);

    // ── (a) minting is UNGATED on a full account ──
    // Two DIFFERENT addresses, so this is not one lucky idempotent path. Both must mint.
    for addr in ["later8a@x.test", "later8b@x.test"] {
        repo.create_invitation(
            org,
            addr,
            AccountRole::Member,
            ActorCeiling::PlatformStaff {
            staff_user_id: STAFF_ACTOR,
        },
            InvitationLimits::defaults(),
        )
        .await
        .unwrap_or_else(|e| {
            panic!(
                "minting must NOT be seat-gated (#141 DEC-3 CORRECTION) — an advisory check \
                 here reintroduces #145 INV-8's enumeration oracle: {e:?}"
            )
        });
    }
    let pending: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account_invitations WHERE account_id = $1 \
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(org)
    .fetch_one(&pool)
    .await
    .expect("count invitations");
    assert_eq!(pending, 2, "both invitations were really minted on a FULL account");

    // ── (b) + (c) the membership creation is refused, and writes nothing ──
    // Driven through `add_member_in_tx` on a caller-owned transaction: #146's exact shape.
    let redeemer = create_user(&server, &admin, "later8a", "later8a@x.test").await;
    let before = member_count(&pool, org).await;
    let mut tx = pool.begin().await.expect("begin");
    let err = AccountRepository::add_member_in_tx(
        &mut tx,
        org,
        redeemer,
        AccountRole::Member,
        ActorCeiling::PlatformStaff {
            staff_user_id: STAFF_ACTOR,
        },
        None,
    )
    .await
    .expect_err("a minted invitation confers nothing once the account is full");
    assert_eq!(err.status_code(), 422);
    assert_eq!(err.error_code(), CODE);
    // Asserted INSIDE the transaction, before the rollback, for the same reason (R5-B3).
    let inside: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account_members WHERE account_id = $1",
    )
    .bind(org)
    .fetch_one(&mut *tx)
    .await
    .expect("count inside the transaction");
    assert_eq!(
        inside, before,
        "the refused add wrote nothing inside its own transaction"
    );
    tx.rollback().await.expect("release the account-row lock deterministically");

    assert_eq!(
        member_count(&pool, org).await,
        before,
        "and nothing survived the rollback either"
    );

    // ── (c) an ALREADY-MEMBER redeeming an invitation is IDEMPOTENT, not seat-refused ──
    //
    // DEC-14 / FIX_ROUND-4 R4-7, with its claim CORRECTED by FIX_ROUND-5 (R5-B2).
    //
    // Why it is here: the mutation battery measured this property's catcher count at ONE
    // (`test21_...`), against 12 for deleting the guard outright. A single catcher means a
    // rewrite that weakens that one test leaves the property unguarded with nothing
    // objecting — which is how #228 regressed two mutations while 3,405 tests stayed green.
    // Re-running the M3 mutant at the tip confirms the count is now 4.
    //
    // What it is NOT, stated because the first version of this comment claimed otherwise:
    // this is **not an independent guard**. TEST-21 drives the admin HTTP route → `add_member`
    // → `pool.begin()` → `add_member_in_tx`; this drives `add_member_in_tx` on its own
    // transaction. The two differ only ABOVE the exclusion, which lives in
    // `enforce_member_seat` below the convergence, so both arrive with identical state. It is
    // a REDUNDANT catcher in the same file and the same cfg arm — real protection against a
    // careless rewrite of one test, and worth having for that, but it does not make the
    // property independently guarded and the DEC-14 rationale should not be read as if it
    // does. It earns its place additionally because this IS #146's call shape and the case
    // that motivated the exclusion (#145 promises "accepting it is idempotent, per #146").
    let existing = filled[0];
    let mut dup_tx = pool.begin().await.expect("begin");
    let dup = AccountRepository::add_member_in_tx(
        &mut dup_tx,
        org,
        existing,
        AccountRole::Member,
        ActorCeiling::PlatformStaff {
            staff_user_id: STAFF_ACTOR,
        },
        None,
    )
    .await
    .expect_err("a duplicate membership is still a conflict");
    assert_eq!(
        dup.status_code(),
        409,
        "re-adding an EXISTING member consumes no seat, so a FULL account must still answer \
         409 — not a seat refusal. If this becomes 422, #146's idempotent accept is broken: \
         {dup:?}"
    );
    assert_ne!(
        dup.error_code(),
        CODE,
        "and specifically NOT the seat code: {dup:?}"
    );
    // Asserted BEFORE the rollback, on the SAME transaction — after a rollback the count is
    // unchanged for every possible implementation, including one that inserted the row, so
    // the post-rollback version proved only that rollback works (FIX_ROUND-5, R5-B3).
    let inside: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account_members WHERE account_id = $1",
    )
    .bind(org)
    .fetch_one(&mut *dup_tx)
    .await
    .expect("count inside the transaction");
    assert_eq!(
        inside, before,
        "the refused duplicate wrote nothing INSIDE its own transaction — not merely nothing \
         that survived a rollback"
    );
    dup_tx.rollback().await.expect("rollback");
}

/// TEST-20 [acceptance, INV-6] [covers: ITEM-6] — the guard REFUSES rather than admitting
/// when its own count could not be sound, and the two ways that can happen are
/// DISTINGUISHABLE (FIX_ROUND-1 F1; FIX_ROUND-2 R2-4).
///
/// Both blind angles found this hole from mechanisms that do not resemble each other:
///   * a bare pooled connection in AUTOCOMMIT — every lock released at statement end, so the
///     count, the ceiling re-read and the INSERT all run unserialized;
///   * a REPEATABLE READ transaction — the count comes from a snapshot that can predate a
///     competing committed add, and the account-row lock raises no serialization error for
///     such a reader.
/// Either way two callers take the last seat with no error anywhere.
///
/// Round 2 caught that the first version of this test covered only the second case and could
/// not tell the two apart (one shared error code, asserted on status + code alone). Both arms
/// now run, and they assert DIFFERENT codes — so a regression that collapsed one branch into
/// the other, or that fired the wrong branch, turns this red instead of passing.
///
/// Every arm runs on an account far UNDER its allowance, so a refusal here can never be the
/// seat limit firing for the ordinary reason.
///
/// **Runs in BOTH builds (FIX_ROUND-4, R4-2).** The guard is no longer saas-gated, because
/// the caller obligation it enforces is not a billing property: `resolve_ceiling`'s live R-1
/// re-read — a SECURITY control — depends on the same "you hold the account row, in a
/// transaction" precondition, and it runs on desktop too. A test that only ran under `saas`
/// would have left the desktop shape of that guard unproven, which is the same
/// "coverage that isn't" this module refuses elsewhere.
#[tokio::test]
async fn test20_the_guard_refuses_an_unserializable_transaction_context() {
    use txresbench::modules::account::seat::SEAT_NO_TRANSACTION;
    use txresbench::modules::account::{AccountRepository, AccountRole, ActorCeiling};
    use sqlx::Acquire;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin, "owner20", "owner20@x.test").await;
    let org = make_org_account(&pool, "Isolation Lab", owner).await;
    let u = create_user(&server, &admin, "u20", "u20@x.test").await;
    let v = create_user(&server, &admin, "v20", "v20@x.test").await;
    // Deliberately far UNDER any allowance (the org has exactly its owner): every refusal
    // below is about the CONTEXT, never the seat limit.
    assert_eq!(member_count(&pool, org).await, 1);
    // …and under `saas`, that premise is ASSERTED against the real catalog rather than
    // assumed. Ungating this test replaced a catalog-coupled check with a bare `== 1` and
    // left the doc still claiming "far UNDER its allowance" — true, but no longer checked
    // (FIX_ROUND-5, R5-B4). The mirrored-literal discipline TEST-22 applies elsewhere in this
    // file applies here too.
    #[cfg(feature = "saas")]
    assert!(
        1 < free_allowance(),
        "the premise POSITIVE CONTROL A rests on: the account is under its allowance, so the \
         admitted arm is admitted because the context is sound rather than by luck of \
         occupancy. (The refusing arms cannot return a seat code at any occupancy — the \
         context guard fires before the seat logic — so this does not guard them, which an \
         earlier version of this message claimed: FIX_ROUND-6, R6-B3.)"
    );

    // ── ARM 1: AUTOCOMMIT — a bare pooled connection, no transaction at all ──
    let mut conn = pool.acquire().await.expect("acquire");
    let err = AccountRepository::add_member_in_tx(
        conn.acquire().await.expect("as connection"),
        org,
        u,
        AccountRole::Member,
        ActorCeiling::PlatformStaff {
            staff_user_id: STAFF_ACTOR,
        },
        None,
    )
    .await
    .expect_err("an autocommit connection cannot hold the lock across the count");
    assert_eq!(err.status_code(), 500, "a server wiring bug, not a client error");
    assert_eq!(
        err.error_code(),
        SEAT_NO_TRANSACTION,
        "refused for the MISSING TRANSACTION specifically — not the isolation branch, and \
         not the seat limit (the account is far under it): {err:?}"
    );
    drop(conn);
    assert_eq!(
        member_count(&pool, org).await,
        1,
        "and it admitted nobody on the unserialized path"
    );

    // ── ARM 2 (SQLite port): the stale-snapshot arm changed SHAPE, not died ──
    //
    // PG had two context questions and refused the second (`SEAT_UNSERIALIZED_ISOLATION`).
    // SQLite has ONE isolation model, so that refusal has no object (see
    // `seat.rs::assert_serializable_context`'s port note). Its guarantee — a stale
    // count can never be committed SILENTLY — is now the engine's: a deferred
    // transaction whose snapshot is stale fails its write (`database is locked` /
    // `SQLITE_BUSY_SNAPSHOT`) instead of passing. Pin that: the call under a stale
    // snapshot FAILS and admits nobody.
    let mut tx = pool.begin().await.expect("begin");
    // Take the snapshot: a read pins the deferred transaction's file view. `SELECT 1` does
    // NOT do this in WAL mode — it never touches the database file, so no snapshot is
    // taken and the later write would simply see the current file (the first version of
    // this arm was green for exactly that reason and proved nothing). A real table read is
    // what pins the view.
    let _ = sqlx::query_scalar::<_, uuid::Uuid>("SELECT id FROM accounts WHERE id = $1")
        .bind(org)
        .fetch_one(&mut *tx)
        .await
        .expect("snapshot read");
    // Advance the file from a SECOND connection so the snapshot is stale by the
    // time the mutation's write runs. The write must actually CHANGE a value:
    // SQLite (3.46) treats `SET name = name` as a no-op and writes NO WAL frame,
    // so the snapshot stays valid and the arm would pass for the wrong reason
    // (verified — the first version of this arm was green exactly that way).
    let mut other = pool.acquire().await.expect("other connection");
    sqlx::query("UPDATE accounts SET name = name || '-advanced' WHERE id = $1")
        .bind(org)
        .execute(&mut *other)
        .await
        .expect("advance the file");
    drop(other);
    let err = AccountRepository::add_member_in_tx(
        &mut tx,
        org,
        u,
        AccountRole::Member,
        ActorCeiling::PlatformStaff {
            staff_user_id: STAFF_ACTOR,
        },
        None,
    )
    .await
    .expect_err("a stale snapshot must be refused by the engine, never silently committed");
    assert_eq!(err.status_code(), 500, "server-side failure, not a client error");
    tx.rollback().await.expect("rollback");
    assert_eq!(
        member_count(&pool, org).await,
        1,
        "the stale-snapshot path admitted nobody"
    );

    // ── ARM 4: the guard fires BEFORE the R-1 ceiling re-read, not merely before the
    //          INSERT (FIX_ROUND-6, R6-2) ──
    //
    // This arm pins the HOIST. A blind audit moved `assert_serializable_context` back below
    // `resolve_ceiling` — the placement FIX_ROUND-5 declares defective, where R-1 reads
    // unserialized and the guard only aborts afterwards — and all 185 `account::` tests
    // stayed green, because every other arm here uses `PlatformStaff`, for which
    // `resolve_ceiling` returns `None` without issuing a read at all.
    //
    // Making it observable needs TWO things, and the first attempt at this arm had only one.
    // A `SelfService` ceiling is necessary but not sufficient: `SelfService{Admin}` adding a
    // MEMBER passes R-1, so both placements still answer `SEAT_NO_TRANSACTION` and the
    // mutation survived. The request must be one R-1 REFUSES — an Admin ceiling minting an
    // OWNER — so the two placements give different answers:
    //   * guard BEFORE the ceiling read  ⇒ 500 SEAT_NO_TRANSACTION (this assertion)
    //   * guard AFTER  the ceiling read  ⇒ 403 ROLE_ABOVE_ACTOR, because R-1 already ran
    // The code asserted is therefore the POSITION, not merely the existence.
    let mut conn2 = pool.acquire().await.expect("acquire");
    let pos_err = AccountRepository::add_member_in_tx(
        conn2.acquire().await.expect("as connection"),
        org,
        v,
        AccountRole::Owner,
        ActorCeiling::SelfService {
            actor_user_id: owner,
            observed_role: AccountRole::Admin,
        },
        None,
    )
    .await
    .expect_err("an autocommit connection is refused whatever the ceiling");
    assert_eq!(
        pos_err.error_code(),
        SEAT_NO_TRANSACTION,
        "the context guard must fire BEFORE the R-1 ceiling re-read. This request is one R-1 \
         WOULD refuse (an Admin ceiling minting an Owner), so answering with R-1's own \
         ROLE_ABOVE_ACTOR would prove the ceiling had already read on an unserialized \
         connection — which is the defect the hoist exists to fix: {pos_err:?}"
    );
    drop(conn2);

    // ── POSITIVE CONTROL A: the IDENTICAL call at the default isolation succeeds ──
    // Without this, "it refused" would also be true of a guard that refuses everything.
    let mut ok_tx = pool.begin().await.expect("begin");
    AccountRepository::add_member_in_tx(
        &mut ok_tx,
        org,
        u,
        AccountRole::Member,
        ActorCeiling::PlatformStaff {
            staff_user_id: STAFF_ACTOR,
        },
        None,
    )
    .await
    .expect("the same add at READ COMMITTED is admitted");
    ok_tx.commit().await.expect("commit");
    assert_eq!(
        member_count(&pool, org).await,
        2,
        "the control really added the member"
    );

    // ── ARM 3 (SQLite port): the second isolation level does not exist ──
    //
    // The PG arm set `SERIALIZABLE` and asserted the REFUSAL
    // (`SEAT_UNSERIALIZED_ISOLATION`): PostgreSQL's SSI only serializes against
    // OTHER serializable transactions, so a SERIALIZABLE accept could race a
    // READ COMMITTED add and both take the last seat. SQLite has ONE isolation
    // model — writers serialize on the database write lock — so neither the
    // refusal nor its failure mode exists (the port note in
    // `seat.rs::assert_serializable_context`). The guarantee ARM 3 existed to
    // pin ("a stale count can never be committed silently") is now the ported
    // ARM 2 above: a stale snapshot is refused by the engine. The honest
    // positive corollary here: an explicit transaction — the ONLY mode there is
    // — is admitted, and its write serializes.
    let mut ser_tx = pool.begin().await.expect("begin");
    AccountRepository::add_member_in_tx(
        &mut ser_tx,
        org,
        v,
        AccountRole::Member,
        ActorCeiling::PlatformStaff {
            staff_user_id: STAFF_ACTOR,
        },
        None,
    )
    .await
    .expect("an explicit transaction's write serializes on the engine write lock");
    ser_tx.commit().await.expect("commit");
    assert_eq!(
        member_count(&pool, org).await,
        3,
        "the explicit-transaction add committed (count 2 from the control + this one)"
    );
}

/// TEST-23 [covers: ITEM-9] — an account whose `plan_id` names no catalog tier is refused
/// with its OWN code, not mislabelled as a seat limit (FIX_ROUND-3, R3-3).
///
/// Fail-closed is deliberate (#141 DEC-9), but the refusal has to say WHICH problem it is:
/// "you are at your limit, upgrade" and "this account's plan is not a real plan, fix the
/// config" have different remedies, and folding them together pointed an operator at an
/// upgrade that would not have helped. **Control**: the same account on a REAL plan, far
/// under its allowance, admits the identical add — so the refusal is about the plan, not
/// about the guard refusing everything.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test23_an_unknown_plan_is_refused_with_its_own_code() {
    use crate::admin::admin_add_member;
    use txresbench::modules::account::seat::SEAT_PLAN_UNKNOWN;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin, "owner23", "owner23@x.test").await;
    let org = make_org_account(&pool, "Retired Tier Lab", owner).await;
    let u = create_user(&server, &admin, "u23", "u23@x.test").await;

    // A plan the catalog does not know — the state a retired tier, an unmapped webhook
    // price, or a direct DB write leaves behind.
    sqlx::query("UPDATE accounts SET plan_id = 'retired-enterprise' WHERE id = $1")
        .bind(org)
        .execute(&pool)
        .await
        .expect("set an off-catalog plan");

    let (status, body) =
        admin_add_member(&server, Some(&admin), &org.to_string(), u, "member").await;
    assert_eq!(status, 422, "fail CLOSED on an unknown plan: {body}");
    assert_eq!(
        code_of(&body),
        SEAT_PLAN_UNKNOWN,
        "and it must NOT be reported as a seat limit — different problem, different \
         remedy: {body}"
    );
    assert_ne!(code_of(&body), CODE);
    assert_eq!(body["details"]["plan_id"], "retired-enterprise", "body: {body}");
    assert_eq!(member_count(&pool, org).await, 1, "nobody was added");

    // ── The READ SURFACE must agree with the enforcement (FIX_ROUND-6, R6-1) ──
    //
    // FIX_ROUND-5 tried to pin this with a unit assertion on a shared const. A blind audit
    // proved that pinned only the const's VALUE: replacing `build_quota_state`'s USE of it
    // with a literal 9_999_999 — the read surface then promising ten million seats for a
    // plan the enforcement refuses outright — left the ENTIRE lib suite green. Half a
    // coupling is not a coupling, and the assertion's own message claimed otherwise.
    //
    // This asserts the missing half at the only layer that can: the actual HTTP response for
    // an account on an off-catalog plan. It needs a database and a mounted billing route, so
    // it could never have been a unit test — which is why two rounds of unit-level "fixes"
    // could not close it. Verified by re-running that same mutation: it now fails here.
    let quota = server
        .client
        .get(server.api_url(&format!("/admin/accounts/{org}/quota")))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("admin quota read");
    let qstatus = quota.status().as_u16();
    if qstatus == 200 {
        let qbody: Value = quota.json().await.unwrap_or(Value::Null);
        assert_eq!(
            qbody["member_allowance"], 0,
            "an unknown plan must report ZERO seats on the READ surface, matching the \
             enforcement's refusal — a non-zero value is the read surface promising seats \
             the guard will not grant: {qbody}"
        );
    } else {
        // The billing routes mount only when a Stripe secret is configured (the §16
        // kill-switch), so outside that tier this read is a 404. Stated rather than silently
        // skipped, and asserted so a THIRD status cannot pass unnoticed.
        assert_eq!(
            qstatus, 404,
            "either the quota route answers and reports 0 seats, or it is not mounted at \
             all — any other status is a real failure"
        );
    }

    // CONTROL: back on a real plan, far under the allowance, the identical add succeeds.
    sqlx::query("UPDATE accounts SET plan_id = 'free' WHERE id = $1")
        .bind(org)
        .execute(&pool)
        .await
        .expect("restore a catalog plan");
    let (status2, body2) =
        admin_add_member(&server, Some(&admin), &org.to_string(), u, "member").await;
    assert_eq!(
        status2, 201,
        "the same add on a catalog plan is admitted — the refusal was about the PLAN: {body2}"
    );
    assert_eq!(member_count(&pool, org).await, 2);
}

/// TEST-21 [acceptance, INV-6] [covers: ITEM-6] — at the limit, re-adding an EXISTING member
/// is still the pre-existing 409, not a seat refusal (FIX_ROUND-1, F2).
///
/// Corroborated by both blind audit angles. The INSERT is `ON CONFLICT DO NOTHING`, so such
/// an add consumes no seat — but a naive `count(*)` puts the member being re-added into the
/// very number that refuses them. Under #146 that would turn an already-member's idempotent
/// redemption (which #145's `create_invitation` comments explicitly promise: "accepting it
/// is idempotent, per #146") into a 422. The design's wording is "an accept that WOULD take
/// the account past `member_allowance`"; a duplicate does not.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test21_a_duplicate_add_at_the_limit_is_409_not_a_seat_refusal() {
    use crate::admin::admin_add_member;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limit = free_allowance();

    let owner = create_user(&server, &admin, "owner21", "owner21@x.test").await;
    let org = make_org_account(&pool, "Dup Lab", owner).await;
    let filled = fill_to(&server, &admin, &pool, org, limit, "seat21_").await;
    let existing = filled[0];

    // Re-add an EXISTING member on a FULL account → the duplicate outcome, not the seat one.
    let (status, body) =
        admin_add_member(&server, Some(&admin), &org.to_string(), existing, "member").await;
    assert_eq!(
        status, 409,
        "re-adding an existing member consumes no seat, so the pre-existing duplicate \
         refusal must survive at the limit: {body}"
    );
    assert_ne!(
        code_of(&body),
        CODE,
        "and it must NOT be the seat refusal — that would break #146's idempotent accept"
    );
    assert_eq!(
        member_count(&pool, org).await,
        limit,
        "nothing was added and nothing was removed"
    );

    // CONTROL: a NEW user, same account, same request shape → the seat refusal. So the 409
    // above is about the duplicate, not about the guard being absent.
    let newcomer = create_user(&server, &admin, "new21", "new21@x.test").await;
    let (status2, body2) =
        admin_add_member(&server, Some(&admin), &org.to_string(), newcomer, "member").await;
    assert_eq!(status2, 422, "a genuinely new member IS refused at the limit: {body2}");
    assert_eq!(code_of(&body2), CODE);
    assert_eq!(member_count(&pool, org).await, limit);
}

/// TEST-13 [covers: ITEM-11] — the #39 `premium` comp lifts the seat limit (#141 DEC-4).
/// The two arms differ ONLY in that one boolean column.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test13_premium_comp_lifts_the_seat_limit() {
    use crate::admin::admin_add_member;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limit = free_allowance();

    let owner = create_user(&server, &admin, "owner13", "owner13@x.test").await;
    let org = make_org_account(&pool, "Comp Lab", owner).await;
    fill_to(&server, &admin, &pool, org, limit, "seat13_").await;
    let extra = create_user(&server, &admin, "extra13", "extra13@x.test").await;

    // NOT comped → refused.
    let (status, body) =
        admin_add_member(&server, Some(&admin), &org.to_string(), extra, "member").await;
    assert_eq!(status, 422, "without the comp: {body}");
    assert_eq!(code_of(&body), CODE);
    assert_eq!(member_count(&pool, org).await, limit);

    // Comped → the IDENTICAL request is admitted.
    sqlx::query(
        "INSERT INTO account_quota_override (account_id, premium, reason) \
         VALUES ($1, true, 'seat comp test') \
         ON CONFLICT (account_id) DO UPDATE SET premium = true",
    )
    .bind(org)
    .execute(&pool)
    .await
    .expect("set premium override");

    let (status2, body2) =
        admin_add_member(&server, Some(&admin), &org.to_string(), extra, "member").await;
    assert_eq!(
        status2, 201,
        "premium comps the seat limit (#141 DEC-4): {body2}"
    );
    assert_eq!(member_count(&pool, org).await, limit + 1);
}

/// TEST-12 [covers: ITEM-10] — NO EVICTION. An account already ABOVE its allowance — the
/// state every existing account is in the moment a limit is introduced — loses nobody.
/// Reads still work, removal still works, and only a NEW add is refused.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test12_an_account_already_over_the_limit_is_not_evicted() {
    use crate::admin::{admin_add_member, admin_remove_member};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limit = free_allowance();

    let owner = create_user(&server, &admin, "owner12", "owner12@x.test").await;
    let org = make_org_account(&pool, "Legacy Lab", owner).await;
    // Seeded ABOVE the allowance, exactly as a pre-existing org would be.
    let over = limit + 3;
    let seeded = fill_to(&server, &admin, &pool, org, over, "seat12_").await;
    assert_eq!(member_count(&pool, org).await, over);

    // A READ does not evict. Listed as the org's OWN OWNER, because
    // `list_account_members` gates on MEMBERSHIP (a non-member gets 404, and the platform
    // admin is not a member of this org) — and "the account's own owner can still see
    // everyone" is the more meaningful claim anyway.
    let owner_token = super::login(&server, "owner12").await;
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{org}/members")))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("list members");
    assert!(resp.status().is_success(), "list: {}", resp.status());
    assert_eq!(
        member_count(&pool, org).await,
        over,
        "listing an over-limit account evicts nobody"
    );

    // A NEW add IS refused — the limit gates new memberships.
    let extra = create_user(&server, &admin, "extra12", "extra12@x.test").await;
    let (status, body) =
        admin_add_member(&server, Some(&admin), &org.to_string(), extra, "member").await;
    assert_eq!(status, 422, "over the limit, a new add is refused: {body}");
    assert_eq!(body["details"]["current"], over, "and reports the real count");
    assert_eq!(
        member_count(&pool, org).await,
        over,
        "still nobody evicted, and nobody added"
    );

    // Removal still works — an over-limit account is not frozen.
    let rm = admin_remove_member(&server, Some(&admin), &org.to_string(), seeded[0]).await;
    assert!(
        (200..300).contains(&rm),
        "an over-limit account can still shed members, got {rm}"
    );
    assert_eq!(member_count(&pool, org).await, over - 1);
}

/// TEST-14 [covers: ITEM-6] — CROSS-TENANT non-interference on POPULATED state, in one
/// body, with BYTE-IDENTICAL request bodies.
///
/// Both arms are non-empty (A is at its limit, B is one below it), the two requests differ
/// only in the account id in the path, and each account's member set is re-queried
/// afterwards to prove the other was untouched. So "the count that gates A is A's own" is
/// a proven difference, not an absence of evidence.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test14_the_gating_count_is_per_account_not_global() {
    use crate::admin::admin_add_member;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limit = free_allowance();

    let owner_a = create_user(&server, &admin, "ownerA", "ownerA@x.test").await;
    let owner_b = create_user(&server, &admin, "ownerB", "ownerB@x.test").await;
    let acct_a = make_org_account(&pool, "Tenant A", owner_a).await;
    let acct_b = make_org_account(&pool, "Tenant B", owner_b).await;

    fill_to(&server, &admin, &pool, acct_a, limit, "a14_").await;
    fill_to(&server, &admin, &pool, acct_b, limit - 1, "b14_").await;

    let a_before = member_snapshot(&pool, acct_a).await;
    let b_before = member_snapshot(&pool, acct_b).await;
    assert!(!a_before.is_empty() && !b_before.is_empty(), "both populated");

    let newcomer = create_user(&server, &admin, "new14", "new14@x.test").await;

    // A is full → refused.
    let (sa, ba) = admin_add_member(
        &server,
        Some(&admin),
        &acct_a.to_string(),
        newcomer,
        "member",
    )
    .await;
    assert_eq!(sa, 422, "A is at its allowance: {ba}");
    assert_eq!(code_of(&ba), CODE);

    // B has a seat → the IDENTICAL body succeeds.
    let (sb, bb) = admin_add_member(
        &server,
        Some(&admin),
        &acct_b.to_string(),
        newcomer,
        "member",
    )
    .await;
    assert_eq!(sb, 201, "B has a free seat: {bb}");

    // The DB re-query: each account changed exactly as much as its own arm should have.
    assert_eq!(
        member_snapshot(&pool, acct_a).await,
        a_before,
        "A's member set is BYTE-IDENTICAL after its refusal and after B's success"
    );
    let b_after = member_snapshot(&pool, acct_b).await;
    assert_eq!(
        b_after.len(),
        b_before.len() + 1,
        "B gained exactly the one member"
    );
    assert!(
        b_after.iter().any(|(u, _)| *u == newcomer),
        "and it is the newcomer"
    );
    // FIX_ROUND-4 R4-5: an assertion that `newcomer` was not in `a_before` was REMOVED as
    // a tautology — `newcomer` is created AFTER that snapshot is taken, so it held for every
    // possible implementation, including one with no per-account scoping at all. It read as
    // a cross-tenant control and proved nothing. The real evidence is the byte-identical
    // `member_snapshot` comparison above.
}

/// TEST-15 [covers: ITEM-9] — the #235 scope statement, pinned as CURRENT behaviour.
///
/// This item does NOT extend suspension enforcement (#141 DEC-6): a suspended account with
/// a free seat still admits a member. The test exists so that decision is visible and so a
/// later #235 change is deliberate rather than silent — if #235 decides suspension blocks
/// granting, THIS is the test that must be consciously rewritten.
///
/// It also pins the property that makes the two refusals usable by a client: a suspended
/// account AT its limit is refused with `SEAT_LIMIT_REACHED` (an upgrade path), not with a
/// suspension code (a support path).
#[cfg(feature = "saas")]
#[tokio::test]
async fn test15_a_suspended_account_is_not_refused_by_the_seat_check() {
    use crate::admin::admin_add_member;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limit = free_allowance();

    let owner = create_user(&server, &admin, "owner15", "owner15@x.test").await;
    let org = make_org_account(&pool, "Suspended Lab", owner).await;
    sqlx::query("UPDATE accounts SET admin_suspended = true WHERE id = $1")
        .bind(org)
        .execute(&pool)
        .await
        .expect("suspend the account");

    // Under the limit: still admitted. #235 remains OPEN — a suspended org can still grant
    // tenant-wide membership, and the seat check deliberately does not change that.
    let u = create_user(&server, &admin, "u15", "u15@x.test").await;
    let (status, body) =
        admin_add_member(&server, Some(&admin), &org.to_string(), u, "member").await;
    assert_eq!(
        status, 201,
        "#141 DEC-6: the seat check does not consult admin_suspended (#235 is open): {body}"
    );

    // At the limit: refused by the SEAT code, not by a suspension code — the two refusals
    // must stay distinguishable, because they point the client at different remedies.
    fill_to(&server, &admin, &pool, org, limit, "seat15_").await;
    let extra = create_user(&server, &admin, "extra15", "extra15@x.test").await;
    let (status2, body2) =
        admin_add_member(&server, Some(&admin), &org.to_string(), extra, "member").await;
    assert_eq!(status2, 422, "at the limit: {body2}");
    assert_eq!(
        code_of(&body2),
        CODE,
        "a suspended account at its limit is refused for the SEAT, not the suspension: {body2}"
    );
}

/// TEST-17 [acceptance, INV-2] [covers: ITEM-6] — the refusal is a RUST refusal that
/// leaves the caller's transaction USABLE, not a constraint violation that aborts the
/// caller's whole unit of work.
///
/// This is the property that makes the guard safe for #146 to meet inside its accept
/// transaction, and it is what makes DEC-5's promise real: a seat-refused accept rolls
/// back with `accepted_at` unstamped, leaving the invitation pending and redeemable — it
/// does not poison the transaction and it does not burn the invitation.
///
/// It is also the OBSERVABLE difference the mutation battery keys on: with the Rust guard
/// deleted, the database would happily accept the row, so a test asserting only "an error
/// occurred" could not tell a working guard from a broken one.
#[cfg(feature = "saas")]
#[tokio::test]
async fn test17_the_seat_refusal_leaves_the_callers_transaction_usable() {
    use txresbench::modules::account::{AccountRepository, AccountRole, ActorCeiling};

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let limit = free_allowance();

    let owner = create_user(&server, &admin, "owner17", "owner17@x.test").await;
    let org = make_org_account(&pool, "Tx Lab", owner).await;
    fill_to(&server, &admin, &pool, org, limit, "seat17_").await;
    let extra = create_user(&server, &admin, "extra17", "extra17@x.test").await;

    // #146's exact shape: the caller owns the transaction.
    let mut tx = pool.begin().await.expect("begin");
    let err = AccountRepository::add_member_in_tx(
        &mut tx,
        org,
        extra,
        AccountRole::Member,
        ActorCeiling::PlatformStaff {
            staff_user_id: STAFF_ACTOR,
        },
        None,
    )
    .await
    .expect_err("refused at the allowance");
    assert_eq!(err.status_code(), 422);
    assert_eq!(err.error_code(), CODE);

    // THE ASSERTION: the same transaction is still usable. A `25P02` (in_failed_sql_
    // transaction) would make this fail — which is exactly what a database-level refusal
    // with the Rust guard deleted would produce.
    let still_works: i64 = sqlx::query_scalar("SELECT count(*) FROM account_members WHERE account_id = $1")
        .bind(org)
        .fetch_one(&mut *tx)
        .await
        .expect("the transaction is NOT aborted — a Rust refusal, not a constraint violation");
    assert_eq!(still_works, limit);

    // And it commits cleanly, carrying nothing.
    tx.commit().await.expect("the transaction commits");
    assert_eq!(
        member_count(&pool, org).await,
        limit,
        "the refused add committed nothing"
    );
}

// TEST-10 [covers: ITEM-8] lives in `tests/billing/seat_quota_read_test.rs`, not here.
// `GET /api/admin/accounts/{id}/quota` is a BILLING route, and the whole billing route
// surface mounts only when a Stripe secret is configured (billing's §16 kill-switch), which
// is the `just billing-sim-test-l2-saas` tier's env — so every billing HTTP acceptance test
// in this repo lives under `tests/billing/` for exactly that reason. Putting it there keeps
// this file runnable by a plain `cargo test --features saas account::` and follows twenty
// sibling files rather than inventing a per-test env guard.

// ─────────────────────── desktop arm: no seat limit at all ───────────────────────

/// TEST-5 [acceptance, INV-3] [covers: ITEM-5, ITEM-6] — on a build WITHOUT `saas`, the
/// seat check compiles out and `member_allowance` is unlimited (research §5).
///
/// The proof is behavioural, and its control is the saas arm above: the SAME sequence
/// (fill an org past the catalog's `free` allowance, then add more) is refused there and
/// succeeds here. Without that pairing, "the adds succeeded" would also be true of a build
/// whose limit was simply large.
///
/// The allowance is not read from the catalog here — on this build `billing` does not
/// exist, which is precisely the point — so the target is a literal comfortably above every
/// shipped tier's seat allowance.
#[cfg(not(feature = "saas"))]
#[tokio::test]
async fn test5_desktop_build_has_no_seat_limit() {
    use crate::admin::admin_add_member;

    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin, "owner5", "owner5@x.test").await;
    let org = make_org_account(&pool, "Desktop Lab", owner).await;

    // Strictly more than `free.member_allowance`, which is the tier every account defaults
    // to and the one the saas arm proves is enforced. A LITERAL because `billing::catalog`
    // does not exist in this build — and, for exactly that reason, a number that goes stale
    // in silence: it was 12 against an allowance of 5, then the allowance became 10 and the
    // margin quietly shrank to two. `test22_the_desktop_arms_still_cross_the_boundary`
    // (saas build) now asserts this literal against the catalog, so a re-price turns a test
    // red instead of turning this one vacuous.
    let target = 16i64;
    for i in 0..target {
        let u = create_user(
            &server,
            &admin,
            &format!("d5_{i}"),
            &format!("d5_{i}@x.test"),
        )
        .await;
        let (status, body) =
            admin_add_member(&server, Some(&admin), &org.to_string(), u, "member").await;
        assert_eq!(
            status, 201,
            "desktop build: add #{i} must succeed — there is no seat limit without \
             the saas build (INV-3): {body}"
        );
    }
    assert_eq!(
        member_count(&pool, org).await,
        target + 1,
        "owner + {target} members, well past every shipped tier's seat allowance"
    );

    // The membership ROUTES are reachable in this build — the other half of INV-3's
    // sentence ("the membership routes themselves are not saas-gated"). Read through the
    // ACCOUNT module's own list route (there is no admin members-LIST route), as the org's
    // owner, since `list_account_members` gates on membership.
    let owner_token = super::login(&server, "owner5").await;
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{org}/members")))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("list members");
    assert!(
        resp.status().is_success(),
        "membership routes are unconditional: {}",
        resp.status()
    );
}

// ─────────── build-independent: source + generated-artifact enumerations ───────────

fn repo_file(rel: &str) -> String {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Every `.rs` file under `src/`, so an enumeration cannot be defeated by adding a file.
fn all_server_sources() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for e in std::fs::read_dir(dir).expect("read_dir") {
            let p = e.expect("dir entry").path();
            if p.is_dir() {
                walk(&p, out);
            } else if matches!(
                p.extension().and_then(|s| s.to_str()),
                Some("rs") | Some("sql")
            ) {
                out.push((
                    p.display().to_string(),
                    std::fs::read_to_string(&p).expect("read source"),
                ));
            }
        }
    }
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    walk(&root, &mut out);
    out
}

/// TEST-11 [acceptance, INV-6] [covers: ITEM-6] — the ARCHITECTURE pin that turns *"every
/// path that adds a member is bound"* from an assertion into a proven claim.
///
/// The whole seat design rests on `add_member_in_tx` being the ONLY way a membership is
/// added to an EXISTING account. That is true today, and this test is what keeps it true:
/// a fourth `INSERT INTO account_members` anywhere in the server tree fails it, so a future
/// unbound membership path cannot land silently.
///
/// The two sites that are NOT bound are named, with the reason: both are account-CREATION —
/// they write the founding OWNER row of an account being created in the same statement
/// block, so there is no "existing account" to have a seat count, the row is the user's
/// own, and refusing there would break user registration and org creation rather than
/// enforce a limit.
///
/// It is also the artifact #235 needs (see `account/seat.rs`): it is what makes "block
/// granting in a suspended account" a one-line change at one named place.
#[test]
fn test11_add_member_in_tx_is_the_only_path_that_adds_to_an_existing_account() {
    // FIX_ROUND-1 F8: the first version matched the literal, case-SENSITIVE substring on a
    // per-LINE basis over `*.rs` only. That is defeated by a line-wrapped statement
    // (`INSERT INTO\n account_members`), by lowercase `insert into`, by extra whitespace,
    // and by a write from a `.sql` migration. All four are now covered: comments are
    // stripped first, then the remaining text is whitespace-collapsed and lowercased before
    // matching, and `.sql` files are scanned alongside `.rs`.
    let sources = all_server_sources();
    let mut sites: Vec<String> = Vec::new();
    let mut sql_sites: Vec<String> = Vec::new();
    for (path, src) in &sources {
        let code: String = src
            .lines()
            .map(|l| {
                let t = l.trim_start();
                // Strip whole-line comments (Rust `//`, SQL `--`); a doc comment naming the
                // table is prose, not a write.
                if t.starts_with("//") || t.starts_with("--") {
                    ""
                } else {
                    l
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        let normalized = code.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        let hits = normalized.matches("insert into account_members").count()
            + normalized.matches("insert into public.account_members").count();
        for _ in 0..hits {
            if path.ends_with(".sql") {
                sql_sites.push(path.clone());
            } else {
                sites.push(path.clone());
            }
        }
    }

    // One `.sql` site is expected and allowed, NAMED rather than tolerated by a count: the
    // account baseline migration backfills an owner membership for every account that
    // predates the table. That is one-time schema-migration work with no runtime path, no
    // plan to read (the billing columns are added by a LATER migration) and no request to
    // refuse — seat-gating it would mean a data migration could fail on a billing limit.
    // Any OTHER `.sql` write is a real bypass and fails here.
    const ALLOWED_SQL_SITES: &[&str] = &["202608040012_account_baseline.sql"];
    let unexpected: Vec<&String> = sql_sites
        .iter()
        .filter(|p| !ALLOWED_SQL_SITES.iter().any(|a| p.ends_with(a)))
        .collect();
    assert!(
        unexpected.is_empty(),
        "a migration or seed inserts memberships directly, bypassing every guard on \
         `add_member_in_tx`: {unexpected:#?}"
    );
    assert_eq!(
        sql_sites.len(),
        ALLOWED_SQL_SITES.len(),
        "the allowlist must stay EXACT — an allowlisted file that no longer inserts leaves \
         a stale exemption that a future write could take shelter under. Found {sql_sites:#?}"
    );

    let repo = "modules/account/repository.rs";
    assert_eq!(
        sites.len(),
        3,
        "exactly three membership INSERT sites are expected; found {sites:#?}. \
         A NEW site must either route through `add_member_in_tx` (so it inherits the seat \
         limit, the R-1 ceiling and the personal-account refusal) or be justified here as \
         account-creation."
    );
    assert!(
        sites.iter().all(|p| p.ends_with(repo)),
        "all three live in {repo}; found {sites:#?}"
    );

    // And they are the three we think they are: two creation sites + the guarded seam.
    let src = repo_file("src/modules/account/repository.rs");
    for f in [
        // NOT "creation" in the naive sense — it is an UPSERT (`ON CONFLICT (personal_user_id)
        // DO UPDATE`), so on the conflict path the account ALREADY EXISTS and the membership
        // INSERT that follows writes into an existing account without `lock_account_row` and
        // without a seat check (FIX_ROUND-4, R4-3 — the earlier justification here claimed
        // "there is no existing account", which was simply false). It is exempt for the
        // REAL reasons: the row it writes is the user's OWN owner row on their OWN personal
        // account, it is `ON CONFLICT DO NOTHING` so the conflict path writes nothing at
        // all. The decisive reason is the one that makes the other two safe: this site does
        // not route through `add_member_in_tx` AT ALL — it issues its own INSERT and calls no
        // guard — so it is exempt by construction rather than by any check. (An earlier
        // version cited `refuse_if_personal_on`, which is a guard INSIDE `add_member_in_tx`
        // and therefore one this site never reaches: FIX_ROUND-5, R5-6. Seat-gating this
        // site would break user registration.)
        "pub async fn ensure_personal_account_in_tx",
        "pub async fn create_organization",           // creation: the founding owner row
        "pub async fn add_member_in_tx",              // the ONE path into an existing account
    ] {
        assert!(src.contains(f), "expected `{f}` in {repo}");
    }

    // The guard is actually WIRED on that path — "exists and is unit-tested" is not "used".
    // FIX_ROUND-1 F8: checked on NON-COMMENT lines, so a commented-out call site (or this
    // file's own prose about the call) cannot keep it green.
    let live_call = src
        .lines()
        .filter(|l| {
            let t = l.trim_start();
            !t.starts_with("//")
        })
        .any(|l| l.contains("seat::enforce_member_seat"));
    assert!(
        live_call,
        "add_member_in_tx must CALL the seat guard on a live line, not merely mention it"
    );

    // And there is exactly ONE enforcement point in the module (#141 DEC-3 CORRECTION):
    // `create_invitation` deliberately carries no seat check, because an advisory one
    // reintroduced #145's INV-8 enumeration oracle and broke its documented idempotent
    // no-op paths. If a future change adds a second call site, that decision is being
    // re-made and must be re-argued rather than absorbed.
    // FIX_ROUND-2 R2-8: counted across the WHOLE server tree, not just repository.rs — the
    // prose claims a module-wide property, and a second check added in handlers.rs,
    // routes.rs or another module entirely is exactly the case worth catching. `seat.rs`
    // itself is excluded: it DEFINES the function, and its own doc discusses it.
    let mut call_sites: Vec<String> = Vec::new();
    for (path, src) in &sources {
        if path.ends_with("modules/account/seat.rs") {
            continue;
        }
        for line in src.lines() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            if line.contains("seat::enforce_") {
                call_sites.push(format!("{path}: {}", line.trim()));
            }
        }
    }
    assert_eq!(
        call_sites.len(),
        1,
        "the seat limit has exactly ONE enforcement point tree-wide (#141 DEC-3 \
         CORRECTION — a second one reintroduced #145 INV-8's enumeration oracle). \
         Found: {call_sites:#?}"
    );
    assert!(
        call_sites[0].contains("modules/account/repository.rs"),
        "and it is in repository.rs's `add_member_in_tx`: {call_sites:#?}"
    );
}

/// TEST-22 [covers: ITEM-5] — the DESKTOP arms must still cross the seat boundary
/// (FIX_ROUND-2, R2-1/R2-2).
///
/// `test5_desktop_build_has_no_seat_limit` and the `seat-allowance-desktop.spec.ts` e2e both
/// run in builds where `billing::catalog` does not exist, so both mirror the free tier's
/// allowance as a LITERAL. A mirrored constant goes stale in silence — and this one already
/// did: both were written against an allowance of 5, a re-price to 10 landed in the same
/// change, and the e2e was left adding SEVEN members to a TEN-seat account. It would have
/// stayed green with the seat limit leaking into the desktop build, which is the one thing
/// it exists to catch.
///
/// So the coupling is asserted here, in the saas build, where the catalog is real: each
/// mirrored literal must STRICTLY EXCEED `free.member_allowance`. A re-price turns this test
/// red and names the file to update, instead of turning two other tests vacuous.
#[cfg(feature = "saas")]
#[test]
fn test22_the_desktop_arms_still_cross_the_boundary() {
    let free = txresbench::modules::billing::catalog::plan("free")
        .expect("the free plan exists")
        .member_allowance;

    // The Rust desktop arm, in this very file.
    let this_file = repo_file("tests/account/seat_allowance_test.rs");
    let rust_target: i64 = this_file
        .lines()
        .find_map(|l| l.trim().strip_prefix("let target = ")?.strip_suffix("i64;"))
        .expect("test5's `let target = <N>i64;` line")
        .parse()
        .expect("a number");
    assert!(
        rust_target > free,
        "test5_desktop_build_has_no_seat_limit adds {rust_target} members, which does not \
         exceed the free tier's {free} seats — it would pass even if the limit leaked into \
         the desktop build. Raise the target in this file."
    );

    // The Playwright desktop arm.
    let spec = repo_file("../ui/tests/e2e/admin-accounts/seat-allowance-desktop.spec.ts");
    let e2e_mirror: i64 = spec
        .lines()
        .find_map(|l| l.trim().strip_prefix("const FREE_TIER_SEAT_ALLOWANCE = "))
        .expect("the spec's FREE_TIER_SEAT_ALLOWANCE line")
        .trim()
        .parse()
        .expect("a number");
    assert_eq!(
        e2e_mirror, free,
        "seat-allowance-desktop.spec.ts mirrors free.member_allowance as {e2e_mirror}, but \
         the catalog says {free}. The spec adds `mirror + 1` members, so a mirror below the \
         real allowance makes it pass without ever crossing the boundary."
    );
}

/// TEST-16 [acceptance, INV-3] [covers: ITEM-5] — the CONFINEMENT half of INV-3.
///
/// The account module must stay unconditional (`saas_gating_test.rs`'s A1 invariant), and
/// this item's gate must not leak into it. So: `seat.rs` is the ONLY file under
/// `modules/account/` carrying a `saas` cfg, every file `saas_gating_test.rs` enumerates
/// still carries none, and `mod.rs`'s `pub mod seat;` declaration is itself ungated — which
/// is what keeps every membership route present in both builds.
#[test]
fn test16_the_saas_gate_is_confined_to_account_seat_rs() {
    fn squashed(s: &str) -> String {
        s.chars().filter(|c| !c.is_whitespace()).collect()
    }

    // The gate ATTRIBUTE, ignoring comments — the property that actually matters.
    fn code_only(src: &str) -> String {
        src.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/modules/account");
    let mut gated = Vec::new();
    let mut mentions_in_prose = Vec::new();
    for e in std::fs::read_dir(&dir).expect("read account module dir") {
        let p = e.expect("entry").path();
        if p.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let src = std::fs::read_to_string(&p).expect("read");
        if squashed(&code_only(&src)).contains("cfg(feature=\"saas\")") {
            gated.push(name.clone());
        }
        if squashed(&src).contains("cfg(feature=\"saas\")") {
            mentions_in_prose.push(name);
        }
    }
    gated.sort();
    mentions_in_prose.sort();
    // SQLite port: the `saas` feature itself is STRIPPED on this node (the billing module is
    // gone — see DRIFT-1.25), so the gate attribute was removed from `seat.rs` along with the
    // policy it gated (the port kept only the transaction-context guard, which is not a
    // billing property). The invariant "nothing but seat.rs may carry a saas gate"
    // degenerates to its other half, and that is what is pinned: NO file in the module
    // carries one, so nothing is gated out of a build that has no second build.
    assert_eq!(
        gated,
        Vec::<String>::new(),
        "no file in modules/account may carry a saas gate on this node — the `saas` feature \
         and its billing module are stripped, so a gate would gate a path out of the ONLY \
         build there is. (On the upstream build the pinned set is exactly [seat.rs].)"
    );

    // AND the shipped guard's own, prose-INCLUSIVE constraint still holds on the five files
    // it enumerates. `saas_gating_test.rs::account_model_is_never_saas_gated` greps the
    // whitespace-squashed TEXT, so it cannot tell code from a comment: writing the attribute
    // out in a doc comment that merely EXPLAINS the design turns it red. That happened during
    // this item (the first `pub mod seat;` comment spelled the attribute out) and the fix was
    // to reword the comment, NOT to loosen the shared test. Asserted here so the trap is
    // discovered by this item's own suite rather than by a surprise failure in someone
    // else's.
    for f in [
        "mod.rs",
        "models.rs",
        "permissions.rs",
        "repository.rs",
        "scope.rs",
    ] {
        assert!(
            !mentions_in_prose.iter().any(|m| m == f),
            "{f} must not contain the saas gate attribute ANYWHERE — not in code and not \
             in a comment, because saas_gating_test.rs greps the raw text. Reword the prose."
        );
    }

    // `pub mod seat;` is declared WITHOUT a gate, so the module (and therefore the
    // membership surface it guards) links in both builds.
    let mod_rs = repo_file("src/modules/account/mod.rs");
    let lines: Vec<&str> = mod_rs.lines().collect();
    let decl = lines
        .iter()
        .position(|l| l.trim() == "pub mod seat;")
        .expect("`pub mod seat;` is declared");

    // FIX_ROUND-1 F7: scan BACKWARDS over every contiguous attribute/comment/blank line, not
    // just the one line above. The declaration is preceded by a multi-line comment block, so
    // a gate attribute placed above that block would have passed the original check while
    // gating the module — the precise thing this test exists to catch.
    let mut i = decl;
    let mut scanned = 0usize;
    while i > 0 {
        let prev = lines[i - 1].trim();
        if prev.is_empty() || prev.starts_with("//") || prev.starts_with("#[") {
            assert!(
                !squashed(prev).contains("cfg(feature=\"saas\")"),
                "the `pub mod seat;` declaration must be UNGATED — found a gate {} line(s) \
                 above it: {prev:?}",
                decl - (i - 1)
            );
            i -= 1;
            scanned += 1;
        } else {
            break;
        }
    }
    assert!(
        scanned > 1,
        "the backward scan must actually traverse the declaration's comment block \
         (scanned {scanned} line(s)) — otherwise it is the one-line check it replaced"
    );
}

/// TEST-9 [acceptance, INV-5] [covers: ITEM-1, ITEM-8] — INV-10b: the catalog stays
/// code-defined; no route mutates `member_allowance`.
///
/// Proven from the GENERATED `openapi.json` rather than from Rust source, so a mutating
/// route added by ANY module fails it — a `grep` of `billing/routes.rs` would not.
/// Read from the SAAS spec, since `/api/billing/*` mounts only in that build.
#[test]
fn test9_no_route_mutates_member_allowance() {
    // SQLite port: the SAAS spec and the billing module it documents are STRIPPED on this
    // node (DRIFT-1.25) — `/api/billing/*` mounts in no build that exists here, so the
    // claim "no route mutates `member_allowance`" has no subject to be false against in the
    // saas document the upstream test read. The same claim is re-pointed at the ONE
    // document there is, asserted at full strength on what it can see: the billing catalog
    // route is absent (the item's subject is gone with the stripped module), and the field
    // appears NOWHERE in the shipped document — which subsumes the upstream request-body
    // scan, because here there is no `$ref`-hidden billing schema to resolve: the field
    // does not exist at all outside test fixtures.
    let doc: Value = serde_json::from_str(&repo_file("../ui/openapi/openapi.json"))
        .expect("parse the shipped openapi.json");

    let paths = doc["paths"].as_object().expect("paths object");
    assert!(
        !paths.contains_key("/api/billing/catalog"),
        "the billing catalog route must not exist in the shipped default document on this \
         node — the billing module that serves it is stripped. If it reappears, the saas \
         spec and the upstream test9 arms must be restored with it."
    );
    let raw = serde_json::to_string(&doc).expect("serialize");
    assert!(
        !raw.contains("member_allowance"),
        "`member_allowance` must appear nowhere in the shipped document — neither in a \
         request body (the upstream assertion) nor anywhere else, since the seat-allowance \
         surface is stripped with the billing module it belonged to"
    );
}

/// TEST-18 [covers: ITEM-12] — the TWO-SPEC client seam is regenerated coherently.
///
/// This app generates two API clients (#50): the default one from the non-saas router and
/// a `-saas` one from the saas router. The seat fields live on billing DTOs, so they must
/// appear in the saas spec + its `types.ts` and must be ABSENT from the default spec —
/// regenerating only one of the two is the drift this catches, and the absence half is
/// also a wire-level proof of INV-3 (a desktop client is never told about seat allowances).
#[test]
fn test18_the_seat_fields_land_in_the_saas_client_and_only_there() {
    // The saas client artifact is STRIPPED on this node (no `/ui/openapi-saas`).
    // INV-3's wire half is then: the seat/allowance surface is absent from the
    // ONE client there is. If a future build restores the saas client, the
    // original assertions re-apply from this branch.
    let saas_dir =
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ui/openapi-saas");
    if saas_dir.exists() {
        let saas: Value = serde_json::from_str(&repo_file("../ui/openapi-saas/openapi.json"))
            .expect("parse the saas openapi.json");
        let schemas = &saas["components"]["schemas"];

        let entry = schemas["PlanCatalogEntry"]["properties"]
            .as_object()
            .expect("saas spec: PlanCatalogEntry properties");
        assert!(
            entry.contains_key("member_allowance"),
            "saas spec: PlanCatalogEntry must carry member_allowance"
        );

        let quota = schemas["QuotaStateResponse"]["properties"]
            .as_object()
            .expect("saas spec: QuotaStateResponse properties");
        for f in ["member_allowance", "members_used"] {
            assert!(
                quota.contains_key(f),
                "saas spec: QuotaStateResponse must carry {f}"
            );
            // REQUIRED, not optional — a client that omits it would render "N of undefined".
            let required: Vec<&str> = schemas["QuotaStateResponse"]["required"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            assert!(required.contains(&f), "saas spec: {f} must be required");
        }

        // The regenerated TypeScript carries them too — the artifact the FE actually imports.
        let ts = repo_file("../ui/src/api-client-saas/types.ts");
        for f in ["member_allowance", "members_used"] {
            assert!(
                ts.contains(f),
                "api-client-saas/types.ts must carry {f} — regenerate with `just openapi-regen`"
            );
        }
    }

    // ABSENT from the default (non-saas) client: billing does not exist there at all, so
    // neither does the seat allowance. This is INV-3 asserted at the wire.
    let plain: Value = serde_json::from_str(&repo_file("../ui/openapi/openapi.json"))
        .expect("parse the default openapi.json");
    assert!(
        plain["components"]["schemas"]
            .get("QuotaStateResponse")
            .is_none(),
        "the default (desktop) client has no billing surface, so no seat allowance"
    );
    let plain_text = repo_file("../ui/openapi/openapi.json");
    assert!(
        !plain_text.contains("member_allowance"),
        "the default spec must not mention member_allowance — the seat check compiles out \
         of a desktop build (INV-3)"
    );
}
