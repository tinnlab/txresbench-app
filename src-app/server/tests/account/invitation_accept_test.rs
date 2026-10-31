//! #146 (epic #138) — the A9 deny suite for **invitation ACCEPT**.
//!
//! | route | gate | this suite proves |
//! |---|---|---|
//! | `POST /api/account-invitations/accept` | authenticated only (the TOKEN is the capability) | INV-9 (indistinguishable misses), INV-EMAIL-BIND, INV-6 (the TOCTOU ceiling), INV-10 (seats, accept half), INV-17 (single-use + atomic), INV-18 (body-only transport), INV-NO-REGISTER-CHANGE |
//!
//! Realizes `docs/research/account-self-service-membership.md` §4.5 (branch
//! `spike/research-account-membership`) and issue #146.
//!
//! # Standing rules for this suite (inherited verbatim from `account_invitations_test.rs`)
//!
//! * **Every deny arm carries its positive control in the SAME test body.** A deny
//!   assertion passes just as well against a build where the route 404s for everyone, the
//!   fixture never created the account, or the user was never logged in.
//! * **Every refusal is observed on POPULATED state**, with a DB re-query afterwards
//!   proving the membership table and the invitation row are exactly as claimed. "The
//!   response said 403" and "no membership row was created" are different claims and only
//!   the second is the invariant.
//! * **Refusals are asserted by error CODE**, never by status alone — on this route 404 is
//!   reachable as `INVALID_INVITATION` and (in principle) as `Account`, and 422 as both
//!   `SEAT_LIMIT_REACHED` and `PERSONAL_ACCOUNT_NOT_MANAGEABLE`.
//! * **INV-9's comparison is on the RAW response TEXT**, never on a parsed
//!   `serde_json::Value`. A field-by-field comparison passes the moment a later change adds
//!   a distinguishing field the assertion does not know to check, which is exactly how
//!   enumeration holes get reintroduced.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use cytoanalyst::modules::account::{
    invitation_token, INVALID_INVITATION, PERSONAL_ACCOUNT_NOT_MANAGEABLE, ROLE_ABOVE_ACTOR,
};

use super::{add_member, create_user, login, make_org_account, pool_for, setup_admin, USERS_GROUP_ID};
use crate::common::TestServer;

/// The seat refusal code, spelled out rather than imported: it is emitted from a
/// `saas`-gated module, and this file's non-saas arms must still name the wire contract.
const SEAT_LIMIT_REACHED: &str = "SEAT_LIMIT_REACHED";

// ---------------------------------------------------------------------------
// helpers — request wrappers return the RAW TEXT as well as the parsed value,
// because INV-9 compares BYTES and a parse would erase exactly the difference
// it is looking for.
// ---------------------------------------------------------------------------

struct Resp {
    status: u16,
    text: String,
}

impl Resp {
    fn json(&self) -> Value {
        serde_json::from_str(&self.text).unwrap_or(Value::Null)
    }
    fn code(&self) -> String {
        let v = self.json();
        v.get("error_code")
            .or_else(|| v.get("code"))
            .and_then(|c| c.as_str())
            .unwrap_or("<none>")
            .to_string()
    }
}

/// `POST /api/account-invitations/accept` with the token in the BODY — the only shape the
/// route accepts.
async fn post_accept(server: &TestServer, bearer: Option<&str>, token: &str) -> Resp {
    let mut req = server
        .client
        .post(server.api_url("/account-invitations/accept"))
        .json(&json!({ "token": token }));
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("accept request");
    let status = resp.status().as_u16();
    Resp {
        status,
        text: resp.text().await.unwrap_or_default(),
    }
}

/// The same route reached with the token in a QUERY STRING and an EMPTY body — the shape
/// INV-18 forbids, exercised to prove the server cannot be talked into reading it.
async fn post_accept_token_in_query(server: &TestServer, bearer: &str, token: &str) -> Resp {
    let resp = server
        .client
        .post(server.api_url(&format!("/account-invitations/accept?token={token}")))
        .bearer_auth(bearer)
        .json(&json!({}))
        .send()
        .await
        .expect("accept request (token in query)");
    let status = resp.status().as_u16();
    Resp {
        status,
        text: resp.text().await.unwrap_or_default(),
    }
}

/// Mint a real invitation through the REAL routes and return `(invitation_id, token)`.
///
/// create → resend, because the create response deliberately carries no link (#145: a link
/// returned only when a row was created would itself be the enumeration oracle) and the
/// token is stored only as a SHA-256, so the server cannot reproduce one it already handed
/// out. This is the exact channel #149's UI will use.
async fn mint_invitation(
    server: &TestServer,
    inviter_token: &str,
    pool: &SqlitePool,
    account: Uuid,
    email: &str,
    role: &str,
) -> (Uuid, String) {
    let created = server
        .client
        .post(server.api_url(&format!("/accounts/{account}/invitations")))
        .bearer_auth(inviter_token)
        .json(&json!({ "email": email, "role": role }))
        .send()
        .await
        .expect("create invitation");
    assert_eq!(created.status().as_u16(), 202, "create invitation");

    // The stored address is NORMALIZED at write time (`lower(trim(...))`), so the lookup
    // must normalize too — otherwise a fixture that invites a mixed-case or padded address
    // (which the email-binding test deliberately does) cannot find the row it just created.
    let normalized =
        invitation_token::normalize_email(email).expect("the fixture address normalizes");
    let id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM account_invitations \
         WHERE account_id = $1 AND email = $2 \
           AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .bind(account)
    .bind(&normalized)
    .fetch_one(pool)
    .await
    .expect(
        "the invitation exists — NOTE #145's create is a documented NO-OP when the address \
         already belongs to a member of this account (INV-8), so a fixture inviting an \
         EXISTING member must plant the row directly rather than mint it through the route",
    );

    let resent = server
        .client
        .post(server.api_url(&format!(
            "/accounts/{account}/invitations/{id}/resend"
        )))
        .bearer_auth(inviter_token)
        .send()
        .await
        .expect("resend invitation");
    assert_eq!(resent.status().as_u16(), 200, "resend invitation");
    let body: Value = resent.json().await.expect("resend json");
    let token = body["invite_token"]
        .as_str()
        .expect("the resend response carries the plaintext token")
        .to_string();
    (id, token)
}

/// Plant an invitation row DIRECTLY, for the shapes no shipped route will create — a
/// personal-account invitation (#145 refuses to mint one, and #146 must refuse it anyway),
/// and an invitation with no recorded inviter.
///
/// Uses the module's OWN `mint_token`/`token_sha256`, so the planted row is
/// indistinguishable from a real one to everything under test.
async fn plant_invitation(
    pool: &SqlitePool,
    account: Uuid,
    email: &str,
    role: &str,
    invited_by: Option<Uuid>,
) -> (Uuid, String) {
    let token = invitation_token::mint_token().expect("mint");
    let hash = invitation_token::token_sha256(&token).to_vec();
    let id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO account_invitations \
           (account_id, email, role, token_sha256, invited_by, expires_at) \
         VALUES ($1, $2, $3, $4, $5, strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days')) RETURNING id",
    )
    .bind(account)
    .bind(email)
    .bind(role)
    .bind(hash)
    .bind(invited_by)
    .fetch_one(pool)
    .await
    .expect("plant invitation");
    (id, token)
}

// ── DB read helpers ────────────────────────────────────────────────────────

async fn role_of(pool: &SqlitePool, account: Uuid, user: Uuid) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(account)
    .bind(user)
    .fetch_optional(pool)
    .await
    .expect("read role")
}

async fn member_count(pool: &SqlitePool, account: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM account_members WHERE account_id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("count members")
}

/// `(accepted_at IS NOT NULL, accepted_by)` for one invitation.
async fn accepted_state(pool: &SqlitePool, invitation: Uuid) -> (bool, Option<Uuid>) {
    sqlx::query_as::<_, (bool, Option<Uuid>)>(
        "SELECT accepted_at IS NOT NULL, accepted_by FROM account_invitations WHERE id = $1",
    )
    .bind(invitation)
    .fetch_one(pool)
    .await
    .expect("read accepted state")
}

/// Every `account_member_events` row for `(account, target)` with this action.
async fn events(
    pool: &SqlitePool,
    account: Uuid,
    action: &str,
    target: Uuid,
) -> Vec<(String, Option<Uuid>, Option<String>, Option<Uuid>)> {
    sqlx::query_as::<_, (String, Option<Uuid>, Option<String>, Option<Uuid>)>(
        "SELECT actor_kind, actor_user_id, new_role, invitation_id \
           FROM account_member_events \
          WHERE account_id = $1 AND action = $2 AND target_user_id = $3 \
          ORDER BY created_at",
    )
    .bind(account)
    .bind(action)
    .bind(target)
    .fetch_all(pool)
    .await
    .expect("read member events")
}

async fn expire(pool: &SqlitePool, invitation: Uuid) {
    sqlx::query("UPDATE account_invitations SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') WHERE id = $1")
        .bind(invitation)
        .execute(pool)
        .await
        .expect("expire invitation");
}

async fn revoke(pool: &SqlitePool, invitation: Uuid, by: Uuid) {
    sqlx::query("UPDATE account_invitations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_by = $2 WHERE id = $1")
        .bind(invitation)
        .bind(by)
        .execute(pool)
        .await
        .expect("revoke invitation");
}

/// Set a member's role directly (a demotion the accept path must observe LIVE).
async fn set_role(pool: &SqlitePool, account: Uuid, user: Uuid, role: &str) {
    let n = sqlx::query("UPDATE account_members SET role = $3 WHERE account_id = $1 AND user_id = $2")
        .bind(account)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .expect("set role")
        .rows_affected();
    assert_eq!(n, 1, "the demotion fixture must actually move a row");
}

async fn remove_member(pool: &SqlitePool, account: Uuid, user: Uuid) {
    let n = sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
        .bind(account)
        .bind(user)
        .execute(pool)
        .await
        .expect("remove member")
        .rows_affected();
    assert_eq!(n, 1, "the removal fixture must actually remove a row");
}

/// Hold `account_id`'s row lock, run `f`, then release — so every request `f` fires is
/// PARKED at `lock_account_row` before any of them can proceed (FIX_ROUND-1, R1-13).
///
/// Without this, two `tokio::join!`ed requests are concurrent but not necessarily
/// OVERLAPPING: if the first finishes before the second starts its transaction, the second
/// gets its refusal from the cheap unlocked discovery read and never touches the locked path
/// the test claims to prove. A blind tests-quality audit made exactly that point about both
/// race tests, and it is right — `[201, 422]` and `[201, 404]` are also what a check-then-act
/// implementation produces when the two requests happen to serialize.
///
/// The blocker takes the SAME `accounts … FOR NO KEY UPDATE` every membership path takes
/// first, and that mode self-conflicts, so both requests are queued behind it. Their
/// discovery reads (outside any transaction) have already run by then; when the lock is
/// released they resume INSIDE their transactions and race on the locked reads — which is
/// the situation under test.
///
/// **It PROVES the parking rather than assuming it** (FIX_ROUND-2, R2-3). The first version
/// released on a bare 750ms sleep, and a round-2 blind audit pointed out that on a loaded box
/// the requests can still be pre-`BEGIN` at release — in which case both race tests silently
/// degrade back to the serialized execution the helper exists to eliminate, and pass for the
/// wrong reason. A helper that no-ops under load turns a green suite into no evidence.
///
/// So it now polls `pg_stat_activity` until `waiters` sessions are actually blocked on a lock
/// in THIS test's database, and **panics** on a bounded deadline rather than proceeding. The
/// test therefore either proves interleaving or fails loudly.
async fn while_the_account_row_is_held<F, T>(
    pool: &SqlitePool,
    account_id: Uuid,
    waiters: i64,
    f: F,
) -> T
where
    F: std::future::Future<Output = T>,
{
    let mut blocker = pool.begin().await.expect("begin the blocking transaction");
    sqlx::query("SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE")
        .bind(account_id)
        .execute(&mut *blocker)
        .await
        .expect("hold the account row");
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .expect("the blocker's backend pid");
    // The hold is PROVEN before anything waits on it (FIX_ROUND-3, C3-1): if it were
    // ineffective, "both requests parked" could never become true and the poll below would
    // time out with a misleading message.
    assert_account_row_is_held(pool, account_id).await;

    let observer = pool.clone();
    let release = async move {
        await_lock_waiters(&observer, waiters, blocker_pid).await;
        blocker.commit().await.expect("release the account row");
    };
    let (out, ()) = tokio::join!(f, release);
    out
}

/// Assert that SOMETHING already holds `account_id`'s row lock — the control a test asserting
/// a NEGATIVE ("nothing parked") needs (FIX_ROUND-3, C3-1).
///
/// A test whose whole claim is "no request blocked" passes vacuously if its own blocker was
/// never holding anything. `FOR NO KEY UPDATE NOWAIT` from a second connection either takes
/// the lock (⇒ the hold was ineffective, and the test is not testing what it says) or fails
/// immediately with SQLSTATE **55P03** `lock_not_available`, which is the proof.
async fn assert_account_row_is_held(pool: &SqlitePool, account_id: Uuid) {
    let probe = sqlx::query("SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE NOWAIT")
        .bind(account_id)
        .fetch_optional(pool)
        .await;
    match probe {
        Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("55P03") => {}
        other => panic!(
            "the account row is NOT held, so a test asserting that nothing blocks on it \
             proves nothing: {}",
            match other {
                Err(e) => format!("ERROR {e:?}"),
                Ok(r) => format!("ROW returned: {}", r.is_some()),
            }
        ),
    }
}

/// Block until `waiters` sessions in THIS test's database are blocked by `blocker_pid`, or
/// PANIC.
///
/// The synchronization primitive every race helper here rests on. It panics rather than
/// returning a failure, deliberately: a caller that proceeded on "probably parked" is the
/// silent degradation FIX_ROUND-2 (R2-3) removed.
///
/// It is neutral about WHAT `blocker_pid` holds — callers pass a session holding the accounts
/// row or one holding the owner rows — so neither this doc nor its panic names a resource
/// (FIX_ROUND-5, C5-2).
async fn await_lock_waiters(pool: &SqlitePool, waiters: i64, blocker_pid: i32) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        // Sessions blocked BY THE BLOCKER, named by its backend pid — not merely "some
        // session in this database is in a lock wait" (FIX_ROUND-4, TQ4-1/TQ4-2).
        //
        // The counting versions before this were both wrong, in opposite directions, and both
        // corrections are recorded rather than quietly dropped:
        //
        //   * `pg_locks WHERE relname='accounts' AND NOT granted` (suggested at round 3)
        //     UNDERCOUNTS: a Postgres row lock lives in the tuple header, so a waiter holds no
        //     ungranted RELATION lock on `accounts` — it waits on the holder's `transactionid`
        //     (and, for the first waiter, a `tuple` lock). It made all three race tests fail
        //     their own parking assertion when run.
        //   * `pg_stat_activity WHERE wait_event_type='Lock'` OVERCOUNTS: it also counts a
        //     session waiting for something else entirely (a `CREATE TRIGGER` taking a table
        //     lock, autovacuum), so it could release the blocker with the request under test
        //     not yet parked — and a test whose premise is "the request is parked" then passes
        //     for the wrong reason.
        //
        // `pg_blocking_pids` answers the actual question. A session it reports as blocked by
        // this pid can only be waiting on something that transaction holds, and every caller's
        // blocker holds exactly ONE thing — the `accounts` row, or the account's owner rows —
        // which is what makes "blocked by this pid" identify the resource. (FIX_ROUND-5's
        // neutralization reached the doc and the panic message and missed this paragraph,
        // which still named the account row; FIX_ROUND-6, R6-1.)
        // …INCLUDING one level of indirection, which is not a nicety (FIX_ROUND-4, TQ4-1b).
        //
        // When two sessions queue for the SAME row, Postgres does not report both as blocked
        // by the row's holder: the first waiter waits on the holder's `transactionid`, and the
        // second waits on the FIRST waiter's `tuple` lock. So `$1 = ANY(pg_blocking_pids(pid))`
        // alone reports 1 of 2 — which is what running it did, and what the earlier
        // over-counting version was accidentally papering over. One hop covers the queue shape
        // for the two waiters these tests create; a deeper queue would need a recursive CTE and
        // none is constructed here.
        let blocked: i64 = sqlx::query_scalar(
            "WITH b AS ( \
                 SELECT pid, pg_blocking_pids(pid) AS bp \
                   FROM pg_stat_activity \
                  WHERE datname = current_database() \
             ) \
             SELECT count(*) FROM b \
              WHERE $1 = ANY(b.bp) \
                 OR EXISTS (SELECT 1 FROM b p WHERE p.pid = ANY(b.bp) AND $1 = ANY(p.bp))",
        )
        .bind(blocker_pid)
        .fetch_one(pool)
        .await
        .expect("read pg_stat_activity");
        if blocked >= waiters {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "only {blocked} of {waiters} request(s) are blocked by backend {blocker_pid} — \
             the race would run SERIALIZED and pass for the wrong reason. Failing loudly \
             rather than degrading silently."
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}

/// A populated org: `owner` is its Owner and holds a live bearer token; a second member
/// exists so every refusal below is observed against real state rather than an empty table.
struct Fixture {
    server: TestServer,
    pool: SqlitePool,
    admin: String,
    owner_id: Uuid,
    owner_token: String,
    org: Uuid,
}

async fn fixture(prefix: &str) -> Fixture {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner_id = create_user(
        &server,
        &admin,
        &format!("{prefix}_owner"),
        &format!("{prefix}_owner@cyto.test"),
    )
    .await;
    let bystander = create_user(
        &server,
        &admin,
        &format!("{prefix}_bystander"),
        &format!("{prefix}_bystander@cyto.test"),
    )
    .await;
    let owner_token = login(&server, &format!("{prefix}_owner")).await;

    let org = make_org_account(&pool, &format!("{prefix}-org"), owner_id).await;
    add_member(&pool, org, bystander, "member").await;
    assert_eq!(
        member_count(&pool, org).await,
        2,
        "POPULATED precondition: every refusal below is observed against real state"
    );

    Fixture {
        server,
        pool,
        admin,
        owner_id,
        owner_token,
        org,
    }
}

/// Create a user who will be the invitee, and log them in.
async fn invitee(f: &Fixture, name: &str, email: &str) -> (Uuid, String) {
    let id = create_user(&f.server, &f.admin, name, email).await;
    let token = login(&f.server, name).await;
    (id, token)
}

// ===========================================================================
// TEST-4 [acceptance] [invariant: INV-9] [covers: ITEM-4, ITEM-5, ITEM-15]
// ===========================================================================
/// **INV-9 — every invalid token is indistinguishable.**
///
/// > Hash the token, look up a row that is pending **and** unexpired **and** unrevoked.
/// > Any miss → one generic `404 INVALID_INVITATION`, byte-identical for wrong / expired /
/// > already-used / revoked. Never distinguish them; the difference is exactly what a token
/// > grinder wants.
///
/// Five causes, one body, compared as RAW TEXT between every pair. A `Value`-level or
/// field-by-field comparison would pass the moment a later change added a distinguishing
/// field the assertion did not know to check — which is precisely how this class of hole
/// comes back.
///
/// **Positive control, in this same body:** the same valid token presented by the RIGHT
/// user returns 201 and creates exactly one membership row. Without it, all five arms would
/// pass against a build where the route did not exist at all.
///
/// **What mutation this kills.** Give the expired case its own `INVITATION_EXPIRED`, or the
/// email mismatch its own message ("this invitation was sent to a@b.com"), and this goes red
/// while every other test in the suite still passes. "Expired" alone confirms that a valid
/// token once existed for that account.
#[tokio::test]
async fn inv9_every_invalid_token_is_byte_identical() {
    let f = fixture("i9").await;
    let (recipient_id, recipient_token) = invitee(&f, "i9_recipient", "i9_recipient@cyto.test").await;
    let (_wrong_id, wrong_token) = invitee(&f, "i9_wrong", "i9_wrong@cyto.test").await;
    // The expired arm gets its OWN address AND its own user (FIX_ROUND-1, R1-8). Two
    // invitations for the SAME address make #145 DEC-4's supersede-on-re-invite mark the
    // first one REVOKED as well as expired — so the arm that was supposed to be "expired"
    // was expired-AND-revoked and the five causes were really four. Found by a blind
    // tests-quality audit. Presenting it as its OWN recipient also keeps the arm from being
    // confounded a second way, with the email mismatch.
    let (_expired_user_id, expired_user_token) =
        invitee(&f, "i9_expired", "i9_expired@cyto.test").await;

    // (ii) expired — and ONLY expired.
    let (expired_inv, expired) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i9_expired@cyto.test",
        "member",
    )
    .await;
    expire(&f.pool, expired_inv).await;
    let (expired_stamped, expired_revoked): (bool, bool) = sqlx::query_as(
        "SELECT accepted_at IS NOT NULL, revoked_at IS NOT NULL FROM account_invitations \
         WHERE id = $1",
    )
    .bind(expired_inv)
    .fetch_one(&f.pool)
    .await
    .expect("read the expired arm");
    assert!(
        !expired_stamped && !expired_revoked,
        "the `expired` arm must be expired and NOTHING ELSE, or it is not a distinct cause"
    );

    // (iii) already accepted — genuinely redeemed below, not faked.
    let (accepted_inv, already_used) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i9_recipient@cyto.test",
        "member",
    )
    .await;

    // ── the POSITIVE CONTROL runs FIRST, and doubles as the fixture for case (iii) ──
    let before = member_count(&f.pool, f.org).await;
    let ok = post_accept(&f.server, Some(&recipient_token), &already_used).await;
    assert_eq!(ok.status, 201, "positive control: {}", ok.text);
    assert_eq!(
        role_of(&f.pool, f.org, recipient_id).await.as_deref(),
        Some("member"),
        "positive control: exactly one new membership row, at the invited role"
    );
    assert_eq!(
        member_count(&f.pool, f.org).await,
        before + 1,
        "positive control: exactly ONE row was added"
    );
    assert!(
        accepted_state(&f.pool, accepted_inv).await.0,
        "positive control: the invitation was stamped accepted"
    );

    // (iv) revoked — with its OWN recipient, for the reason the expired arm has one
    // (FIX_ROUND-2, R2-4). It was minted for `i9_revokee@` and presented by `i9_recipient`,
    // so it was revoked AND an email mismatch: deleting `revoked_at IS NULL` from the claim
    // predicate left the suite green, because the mismatch answered anyway. Five causes were
    // still four. Found by a round-2 blind tests-quality audit.
    let (_revokee_id, revokee_token) = invitee(&f, "i9_revokee", "i9_revokee@cyto.test").await;
    let (revoked_inv, revoked_token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i9_revokee@cyto.test",
        "member",
    )
    .await;
    revoke(&f.pool, revoked_inv, f.owner_id).await;
    let (revoked_stamped, revoked_expired, revoked_email): (bool, bool, String) = sqlx::query_as(
        "SELECT accepted_at IS NOT NULL, expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'), email FROM account_invitations \
         WHERE id = $1",
    )
    .bind(revoked_inv)
    .fetch_one(&f.pool)
    .await
    .expect("read the revoked arm");
    assert!(
        !revoked_stamped && !revoked_expired,
        "the `revoked` arm must be revoked and NOTHING ELSE, or it duplicates another cause"
    );
    assert_eq!(
        revoked_email, "i9_revokee@cyto.test",
        "…and it is presented BY that address below, so the email binding is not a second \
         reason for its refusal"
    );

    // (v) valid-but-wrong-recipient

    let (_live_inv, live_token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i9_someone_else@cyto.test",
        "member",
    )
    .await;

    let after_control = member_count(&f.pool, f.org).await;

    // ── the five misses ──
    let random = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let r_wrong = post_accept(&f.server, Some(&recipient_token), random).await;
    // …presented by the user it was addressed to, so the ONLY thing wrong with it is that
    // it expired.
    let r_expired = post_accept(&f.server, Some(&expired_user_token), &expired).await;
    let r_used = post_accept(&f.server, Some(&recipient_token), &already_used).await;
    let r_revoked = post_accept(&f.server, Some(&revokee_token), &revoked_token).await;
    // A VALID, live, unexpired, unrevoked token — presented by a logged-in user whose email
    // is not the invited one. The one arm that is not a token problem at all.
    let r_mismatch = post_accept(&f.server, Some(&wrong_token), &live_token).await;

    for (name, r) in [
        ("wrong", &r_wrong),
        ("expired", &r_expired),
        ("already-used", &r_used),
        ("revoked", &r_revoked),
        ("email-mismatch", &r_mismatch),
    ] {
        assert_eq!(r.status, 404, "{name}: {}", r.text);
        assert_eq!(r.code(), INVALID_INVITATION, "{name}: {}", r.text);
    }

    // THE assertion: byte-identical bodies, every pair.
    let bodies = [
        ("wrong", &r_wrong.text),
        ("expired", &r_expired.text),
        ("already-used", &r_used.text),
        ("revoked", &r_revoked.text),
        ("email-mismatch", &r_mismatch.text),
    ];
    for (name, body) in &bodies[1..] {
        assert_eq!(
            **body, *bodies[0].1,
            "the `{name}` refusal differs from the `wrong` refusal — that difference IS the \
             oracle INV-9 forbids.\n  wrong: {}\n  {name}: {}",
            bodies[0].1, body
        );
    }

    // And none of them wrote anything.
    assert_eq!(
        member_count(&f.pool, f.org).await,
        after_control,
        "no refusal may create a membership"
    );
    assert!(
        !accepted_state(&f.pool, revoked_inv).await.0,
        "a revoked invitation must not be stamped accepted by a refused attempt"
    );
}


/// **TEST-4 (cont.) — INV-9 on the CLOCK, not only on the bytes** (FIX_ROUND-2 R2-2,
/// generalized to all five causes in FIX_ROUND-3 R3-1).
///
/// The step-1a predicate is the only thing standing between this route and a TIMING oracle.
/// Without it, a token that MISSES returns after one unlocked query, while a token that HITS
/// but cannot be redeemed runs `BEGIN` → a blocking `accounts … FOR NO KEY UPDATE` → two more
/// SELECTs → `ROLLBACK` before returning the same bytes. Five extra round trips and an
/// unbounded lock wait tell a stranger holding a leaked link *this token is live, just not
/// for you* — which is exactly what INV-9 hides.
///
/// **It is parameterized over ALL FIVE causes**, because each is a separate line of that
/// predicate. The first version exercised only the email mismatch, so deleting `revoked_at IS
/// NULL` (or `accepted_at IS NULL`, or `expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`) from step 1a reopened the oracle
/// for that cause with the whole suite green — a round-3 blind design-conformance audit
/// caught it. Every stale-token arm is presented by ITS OWN recipient, so the email filter
/// cannot answer on its behalf and the arm really does test the line it is named for.
///
/// Deterministic rather than a stopwatch race: the account row is held for the duration, so a
/// request that opens the accept transaction BLOCKS until release. Under the current code no
/// arm touches the lock, so every one must answer promptly; under the regression the affected
/// arm parks and its `timeout` fires with a message naming the defect.
///
/// **Positive control:** a live token presented by its RIGHT recipient, once the lock is
/// released, is a 201 — so "everything answered fast" is not "the route is dead".
#[tokio::test]
async fn inv9_no_miss_opens_a_transaction_so_the_404_is_indistinguishable_in_time() {
    let f = fixture("i9t").await;

    // One user per cause, so each arm's ONLY defect is the one it is named for.
    let (_str_id, stranger) = invitee(&f, "i9t_str", "i9t_str@cyto.test").await;
    let (rec_id, recipient) = invitee(&f, "i9t_rec", "i9t_rec@cyto.test").await;
    let (_exp_id, expired_user) = invitee(&f, "i9t_exp", "i9t_exp@cyto.test").await;
    let (used_id, used_user) = invitee(&f, "i9t_used", "i9t_used@cyto.test").await;
    let (_rev_id, revoked_user) = invitee(&f, "i9t_rev", "i9t_rev@cyto.test").await;

    let (_li, live) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i9t_rec@cyto.test",
        "member",
    )
    .await;
    let (expired_inv, expired) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i9t_exp@cyto.test",
        "member",
    )
    .await;
    let (used_inv, used) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i9t_used@cyto.test",
        "member",
    )
    .await;
    let (revoked_inv, revoked) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i9t_rev@cyto.test",
        "member",
    )
    .await;

    expire(&f.pool, expired_inv).await;
    revoke(&f.pool, revoked_inv, f.owner_id).await;
    // The "already accepted" arm is genuinely redeemed, not faked.
    let redeemed = post_accept(&f.server, Some(&used_user), &used).await;
    assert_eq!(redeemed.status, 201, "seed the used arm: {}", redeemed.text);
    assert!(accepted_state(&f.pool, used_inv).await.0);
    assert_eq!(role_of(&f.pool, f.org, used_id).await.as_deref(), Some("member"));

    // Hold the account row for the whole measurement. Anything that opens the accept
    // transaction now blocks on `lock_account_row` until this commits.
    let mut blocker = f.pool.begin().await.expect("begin the blocking transaction");
    sqlx::query("SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE")
        .bind(f.org)
        .execute(&mut *blocker)
        .await
        .expect("hold the account row");
    // The hold is PROVEN, not assumed — this test asserts a negative.
    assert_account_row_is_held(&f.pool, f.org).await;

    // The arms are awaited SEQUENTIALLY, so at most one request is ever in flight and the
    // server pool can never be exhausted — a genuine block shows up as this timeout, with its
    // explanatory message, and as nothing else. (An earlier version of this comment claimed
    // the 8s was chosen to clear the pool's 3s acquire timeout, which cannot fire here;
    // corrected in FIX_ROUND-4, TQ4-3. Anyone parallelizing the loop must revisit it.)
    const PATIENCE: std::time::Duration = std::time::Duration::from_secs(8);
    let arms: [(&str, &str, &str, &str); 5] = [
        (
            "wrong token",
            &stranger,
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "the hash predicate",
        ),
        ("expired", &expired_user, &expired, "`expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`"),
        ("already accepted", &used_user, &used, "`accepted_at IS NULL`"),
        ("revoked", &revoked_user, &revoked, "`revoked_at IS NULL`"),
        (
            "wrong recipient (live token)",
            &stranger,
            &live,
            "the email binding filter",
        ),
    ];

    let mut bodies: Vec<(&str, String)> = Vec::new();
    for (name, bearer, token, guard) in arms {
        let r = tokio::time::timeout(PATIENCE, post_accept(&f.server, Some(bearer), token))
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "the `{name}` accept BLOCKED on the account-row lock — it opened the \
                     accept transaction before {guard} answered, which is the INV-9 TIMING \
                     oracle: this cause now costs a lock wait that a wrong token does not, so \
                     the two are distinguishable however identical their bodies are"
                )
            });
        assert_eq!(r.status, 404, "{name}: {}", r.text);
        assert_eq!(r.code(), INVALID_INVITATION, "{name}: {}", r.text);
        bodies.push((name, r.text));
    }
    for (name, body) in &bodies[1..] {
        assert_eq!(
            body, &bodies[0].1,
            "`{name}` differs from `wrong token` — this test adds the CLOCK to the byte \
             identity, it does not replace it"
        );
    }

    blocker.commit().await.expect("release the account row");

    // ── POSITIVE CONTROL: the right recipient, live token, once the lock is free ──
    let ok = post_accept(&f.server, Some(&recipient), &live).await;
    assert_eq!(ok.status, 201, "positive control: {}", ok.text);
    assert_eq!(role_of(&f.pool, f.org, rec_id).await.as_deref(), Some("member"));
}

/// **TEST-8 (cont.) — the AUTHORITATIVE, in-transaction email binding really is the
/// decision** (FIX_ROUND-3, R3-2).
///
/// Since FIX_ROUND-1 the binding is also evaluated at step 1a, on an unlocked pre-transaction
/// read, to close the timing oracle. A round-3 blind audit observed the consequence: by the
/// time the in-transaction check runs, every ordinary mismatch has already been answered, so
/// deleting the authoritative check left the whole suite green — the design's step 2 was off
/// the decision path and unproven.
///
/// This drives the one state that reaches it, deterministically: the accept is parked at
/// `lock_account_row` (so step 1a has already passed with the OLD address), the redeemer's
/// `users.email` is changed while it waits, and the lock is released. Under READ COMMITTED the
/// in-transaction `SELECT email FROM users` then sees the NEW address, the binding fails, and
/// the generic 404 is the only correct answer. Delete the check and this arm returns 201.
///
/// It is also the executable form of #146 DEC-9 ("a FRESH in-transaction read, not the
/// authenticated user's snapshot").
///
/// **Positive control:** the address is restored and the same token is redeemed ⇒ 201.
#[tokio::test]
async fn the_email_binding_is_re_evaluated_inside_the_transaction() {
    let f = fixture("ieb2").await;
    let (rec_id, recipient) = invitee(&f, "ieb2_rec", "ieb2_rec@cyto.test").await;
    let (inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "ieb2_rec@cyto.test",
        "member",
    )
    .await;

    let mut blocker = f.pool.begin().await.expect("begin the blocking transaction");
    sqlx::query("SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE")
        .bind(f.org)
        .execute(&mut *blocker)
        .await
        .expect("hold the account row");
    let blocker_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *blocker)
        .await
        .expect("the blocker's backend pid");
    assert_account_row_is_held(&f.pool, f.org).await;

    let pool = f.pool.clone();
    let meddle = async move {
        // Wait until the accept is parked ON THIS BLOCKER — which is what makes the premise
        // ("it has already passed step 1a with the address the invitation names") a FACT
        // rather than a hope. A round-4 audit found the earlier "some session is waiting"
        // count could release early, land the UPDATE first, and let this test pass for the
        // wrong reason.
        await_lock_waiters(&pool, 1, blocker_pid).await;
        sqlx::query("UPDATE users SET email = $2 WHERE id = $1")
            .bind(rec_id)
            .bind("ieb2_moved@cyto.test")
            .execute(&pool)
            .await
            .expect("change the redeemer's address while the accept waits");
        blocker.commit().await.expect("release the account row");
    };

    let (r, ()) = tokio::join!(post_accept(&f.server, Some(&recipient), &token), meddle);

    assert_eq!(
        r.status, 404,
        "the address changed between the pre-transaction filter and the authoritative check, \
         so the binding must fail INSIDE the transaction — a 201 here means step 2 is not \
         being evaluated at all: {}",
        r.text
    );
    assert_eq!(r.code(), INVALID_INVITATION, "{}", r.text);
    assert_eq!(role_of(&f.pool, f.org, rec_id).await, None, "and nothing was written");
    assert!(
        !accepted_state(&f.pool, inv).await.0,
        "…and the invitation is left PENDING"
    );

    // ── POSITIVE CONTROL: restore the address, redeem the SAME token ──
    sqlx::query("UPDATE users SET email = $2 WHERE id = $1")
        .bind(rec_id)
        .bind("ieb2_rec@cyto.test")
        .execute(&f.pool)
        .await
        .expect("restore the address");
    let ok = post_accept(&f.server, Some(&recipient), &token).await;
    assert_eq!(ok.status, 201, "positive control: {}", ok.text);
    assert_eq!(role_of(&f.pool, f.org, rec_id).await.as_deref(), Some("member"));
    assert!(accepted_state(&f.pool, inv).await.0);
}


// ===========================================================================
// TEST-5 [acceptance] [invariant: INV-6] [covers: ITEM-7]
// ===========================================================================
/// **INV-6 — the role ceiling is re-checked at accept (the TOCTOU).**
///
/// > Re-read `membership_role(account_id, invited_by)` **now** and refuse if the inviter no
/// > longer satisfies `Admin` or no longer outranks `invitation.role`. Without this, an
/// > Owner issues an owner-invite, is demoted to Member, and the invitee still becomes an
/// > Owner days later. This is the invitation bug people ship.
///
/// Three refusal shapes, each with the invitation left PENDING and no membership row:
/// the inviter DEMOTED below `admin`, the inviter REMOVED from the account entirely, and
/// the inviter demoted to a role that no longer OUTRANKS the invitation.
///
/// **Positive control:** the identical accept, with the inviter still an Owner, is a 201
/// with `role = owner`. Without it, all three arms pass against a build where every accept
/// 403s.
///
/// **What mutation this kills.** Delete the re-read and grade against `invitation.role`
/// alone — which is what "the role was validated at issue" tempts you into — and all three
/// arms go green on the invitee becoming an OWNER of a tenant nobody live authorized.
#[tokio::test]
async fn inv6_the_role_ceiling_is_rechecked_at_accept() {
    // ── ARM 1: the inviter is DEMOTED to `member` ──
    {
        let f = fixture("i6a").await;
        let (invitee_id, invitee_token) = invitee(&f, "i6a_new", "i6a_new@cyto.test").await;
        let (inv, token) = mint_invitation(
            &f.server,
            &f.owner_token,
            &f.pool,
            f.org,
            "i6a_new@cyto.test",
            "owner",
        )
        .await;

        // …after the invitation is minted and BEFORE it is redeemed.
        set_role(&f.pool, f.org, f.owner_id, "member").await;

        let before = member_count(&f.pool, f.org).await;
        let r = post_accept(&f.server, Some(&invitee_token), &token).await;
        assert_eq!(r.status, 403, "demoted inviter: {}", r.text);
        assert_eq!(r.code(), ROLE_ABOVE_ACTOR, "{}", r.text);
        assert_eq!(
            role_of(&f.pool, f.org, invitee_id).await,
            None,
            "NO membership row — the refusal is a refusal, not a message"
        );
        assert_eq!(member_count(&f.pool, f.org).await, before);
        assert!(
            !accepted_state(&f.pool, inv).await.0,
            "the invitation is left PENDING, so a re-promoted inviter's grant can still land"
        );
        assert!(
            events(&f.pool, f.org, "joined", invitee_id).await.is_empty(),
            "a refused accept is not an audited join"
        );
    }

    // ── ARM 2: the inviter is REMOVED from the account entirely ──
    {
        let f = fixture("i6b").await;
        // A second owner, so removing the inviter does not trip LAST_OWNER in the fixture.
        let coowner = create_user(&f.server, &f.admin, "i6b_co", "i6b_co@cyto.test").await;
        add_member(&f.pool, f.org, coowner, "owner").await;

        let (invitee_id, invitee_token) = invitee(&f, "i6b_new", "i6b_new@cyto.test").await;
        let (inv, token) = mint_invitation(
            &f.server,
            &f.owner_token,
            &f.pool,
            f.org,
            "i6b_new@cyto.test",
            "owner",
        )
        .await;

        remove_member(&f.pool, f.org, f.owner_id).await;

        let before = member_count(&f.pool, f.org).await;
        let r = post_accept(&f.server, Some(&invitee_token), &token).await;
        assert_eq!(r.status, 403, "removed inviter: {}", r.text);
        assert_eq!(r.code(), ROLE_ABOVE_ACTOR, "{}", r.text);
        assert_eq!(role_of(&f.pool, f.org, invitee_id).await, None);
        assert_eq!(member_count(&f.pool, f.org).await, before);
        assert!(!accepted_state(&f.pool, inv).await.0);
    }

    // ── ARM 3: the inviter is demoted only to `admin`, but the invitation says `owner` ──
    //
    // The Admin FLOOR alone would pass this (an `admin` satisfies `Admin`); it is refused
    // by the OUTRANKING half, which is the half that stops an admin minting an owner. Two
    // independent halves, and this arm is what proves the second one is really there.
    {
        let f = fixture("i6c").await;
        let coowner = create_user(&f.server, &f.admin, "i6c_co", "i6c_co@cyto.test").await;
        add_member(&f.pool, f.org, coowner, "owner").await;

        let (invitee_id, invitee_token) = invitee(&f, "i6c_new", "i6c_new@cyto.test").await;
        let (_inv, token) = mint_invitation(
            &f.server,
            &f.owner_token,
            &f.pool,
            f.org,
            "i6c_new@cyto.test",
            "owner",
        )
        .await;

        set_role(&f.pool, f.org, f.owner_id, "admin").await;

        let before = member_count(&f.pool, f.org).await;
        let r = post_accept(&f.server, Some(&invitee_token), &token).await;
        assert_eq!(r.status, 403, "outranked inviter: {}", r.text);
        assert_eq!(r.code(), ROLE_ABOVE_ACTOR, "{}", r.text);
        assert_eq!(role_of(&f.pool, f.org, invitee_id).await, None);
        // The same DB re-queries ARMs 1 and 2 make. Asserting only the status and the absent
        // row left this arm weaker than its siblings for no reason (FIX_ROUND-1, R1-12).
        assert_eq!(member_count(&f.pool, f.org).await, before);
        assert!(
            !accepted_state(&f.pool, _inv).await.0,
            "the invitation is left PENDING here too"
        );
    }

    // ── ARM 4: the ADMIN FLOOR, on its own ──
    //
    // ARMs 1-3 all use an `owner` invitation, so they are refused by the OUTRANKING half
    // (`live < invited_role`) and would pass with the floor guard deleted — a round-3 blind
    // design-conformance audit made exactly that point. Here the invitation is for `member`
    // and the demoted inviter is a `member`, so `live < invited_role` is FALSE and only
    // `!live.allows(Admin)` can refuse. One line, one arm.
    {
        let f = fixture("i6e").await;
        let coowner = create_user(&f.server, &f.admin, "i6e_co", "i6e_co@cyto.test").await;
        add_member(&f.pool, f.org, coowner, "owner").await;

        let (invitee_id, invitee_token) = invitee(&f, "i6e_new", "i6e_new@cyto.test").await;
        let (inv, token) = mint_invitation(
            &f.server,
            &f.owner_token,
            &f.pool,
            f.org,
            "i6e_new@cyto.test",
            "member",
        )
        .await;

        set_role(&f.pool, f.org, f.owner_id, "member").await;

        let before = member_count(&f.pool, f.org).await;
        let r = post_accept(&f.server, Some(&invitee_token), &token).await;
        assert_eq!(
            r.status, 403,
            "a bare `member` may not confer even `member` — the invitation ceiling has an \
             ADMIN FLOOR as well as an outranking test, and they are independent halves: {}",
            r.text
        );
        assert_eq!(r.code(), ROLE_ABOVE_ACTOR, "{}", r.text);
        assert_eq!(role_of(&f.pool, f.org, invitee_id).await, None);
        assert_eq!(member_count(&f.pool, f.org).await, before);
        assert!(!accepted_state(&f.pool, inv).await.0);

        // …and the SAME invitation lands once the inviter is an admin again — so the floor is
        // a floor, not a blanket refusal.
        set_role(&f.pool, f.org, f.owner_id, "admin").await;
        let r = post_accept(&f.server, Some(&invitee_token), &token).await;
        assert_eq!(r.status, 201, "positive control: {}", r.text);
        assert_eq!(
            role_of(&f.pool, f.org, invitee_id).await.as_deref(),
            Some("member")
        );
    }

    // ── POSITIVE CONTROL: the inviter is STILL an Owner ──
    {
        let f = fixture("i6d").await;
        let (invitee_id, invitee_token) = invitee(&f, "i6d_new", "i6d_new@cyto.test").await;
        let (inv, token) = mint_invitation(
            &f.server,
            &f.owner_token,
            &f.pool,
            f.org,
            "i6d_new@cyto.test",
            "owner",
        )
        .await;

        let r = post_accept(&f.server, Some(&invitee_token), &token).await;
        assert_eq!(r.status, 201, "positive control: {}", r.text);
        assert_eq!(r.json()["role"], "owner", "{}", r.text);
        assert_eq!(
            role_of(&f.pool, f.org, invitee_id).await.as_deref(),
            Some("owner"),
            "an OWNER invitation from a live Owner really does confer owner"
        );
        assert!(accepted_state(&f.pool, inv).await.0);
    }
}

// ===========================================================================
// TEST-6 [acceptance] [invariant: INV-10] [covers: ITEM-8]
// ===========================================================================
/// **INV-10 (accept half) — the seat limit is transactional.**
///
/// > Enforcement point: **invitation accept** (the moment a membership row is created),
/// > inside the accept transaction, after locking the account's member rows so two
/// > simultaneous accepts cannot both pass. Over limit ⇒ `422 SEAT_LIMIT_REACHED` with the
/// > plan id, the limit and the current count.
///
/// The limit arms are `saas`-gated with the enforcement they exercise (#141 INV-3: the seat
/// check compiles out on a desktop build). The positive control runs on BOTH builds,
/// because "an accept under the limit succeeds" must hold either way — and it is what stops
/// the desktop arm of this file being vacuous.
///
/// **What mutation this kills.** Move the seat check off `add_member_in_tx` onto the accept
/// path's own pool connection, or take the count before the account lock, and the RACE arm
/// admits both accepts past the last seat.
#[cfg(feature = "saas")]
#[tokio::test]
async fn inv10_seats_are_enforced_transactionally_at_accept() {
    let limit = cytoanalyst::modules::billing::catalog::plan("free")
        .expect("the free plan exists")
        .member_allowance;

    let f = fixture("i10").await;
    // Fill to exactly `limit` with direct inserts — filling through the guarded path would
    // make the fixture depend on the thing under test.
    let mut filled = Vec::new();
    for i in member_count(&f.pool, f.org).await..limit {
        let u = create_user(
            &f.server,
            &f.admin,
            &format!("i10_fill{i}"),
            &format!("i10_fill{i}@cyto.test"),
        )
        .await;
        add_member(&f.pool, f.org, u, "member").await;
        filled.push(u);
    }
    assert_eq!(member_count(&f.pool, f.org).await, limit, "at the limit");

    let (over_id, over_token) = invitee(&f, "i10_over", "i10_over@cyto.test").await;
    let (over_inv, over) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i10_over@cyto.test",
        "member",
    )
    .await;

    let r = post_accept(&f.server, Some(&over_token), &over).await;
    assert_eq!(r.status, 422, "over the seat limit: {}", r.text);
    assert_eq!(r.code(), SEAT_LIMIT_REACHED, "{}", r.text);
    let body = r.json();
    assert_eq!(body["details"]["plan_id"], "free", "{}", r.text);
    assert_eq!(body["details"]["limit"], limit, "{}", r.text);
    assert_eq!(body["details"]["current"], limit, "{}", r.text);
    assert_eq!(role_of(&f.pool, f.org, over_id).await, None, "no membership");
    assert_eq!(member_count(&f.pool, f.org).await, limit);
    assert!(
        !accepted_state(&f.pool, over_inv).await.0,
        "the invitation is NOT burned by a seat refusal — it stays PENDING and redeemable \
         once a seat frees (#141 DEC-5)"
    );

    // ── the invitation really is still redeemable once a seat frees ──
    remove_member(&f.pool, f.org, *filled.last().expect("filled")).await;
    let r = post_accept(&f.server, Some(&over_token), &over).await;
    assert_eq!(r.status, 201, "the SAME token, once a seat freed: {}", r.text);
    assert_eq!(
        role_of(&f.pool, f.org, over_id).await.as_deref(),
        Some("member")
    );
    assert_eq!(member_count(&f.pool, f.org).await, limit);
}

/// **INV-10, the RACE case.** Two concurrent accepts of two DIFFERENT valid tokens for the
/// LAST free seat ⇒ exactly one 201, one 422, and the member count sits exactly on the
/// limit afterwards.
///
/// This is the arm the account-row lock exists for. Without it both counts are taken before
/// either INSERT and both accepts pass — the check-then-act race in its textbook form.
#[cfg(feature = "saas")]
#[tokio::test]
async fn inv10_two_concurrent_accepts_cannot_both_take_the_last_seat() {
    let limit = cytoanalyst::modules::billing::catalog::plan("free")
        .expect("the free plan exists")
        .member_allowance;

    let f = fixture("i10r").await;
    for i in member_count(&f.pool, f.org).await..(limit - 1) {
        let u = create_user(
            &f.server,
            &f.admin,
            &format!("i10r_fill{i}"),
            &format!("i10r_fill{i}@cyto.test"),
        )
        .await;
        add_member(&f.pool, f.org, u, "member").await;
    }
    assert_eq!(
        member_count(&f.pool, f.org).await,
        limit - 1,
        "exactly ONE free seat"
    );

    let (a_id, a_token) = invitee(&f, "i10r_a", "i10r_a@cyto.test").await;
    let (b_id, b_token) = invitee(&f, "i10r_b", "i10r_b@cyto.test").await;
    let (_ia, ta) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i10r_a@cyto.test",
        "member",
    )
    .await;
    let (_ib, tb) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i10r_b@cyto.test",
        "member",
    )
    .await;

    let (ra, rb) = while_the_account_row_is_held(&f.pool, f.org, 2, async {
        tokio::join!(
            post_accept(&f.server, Some(&a_token), &ta),
            post_accept(&f.server, Some(&b_token), &tb),
        )
    })
    .await;

    let mut statuses = [ra.status, rb.status];
    statuses.sort_unstable();
    assert_eq!(
        statuses,
        [201, 422],
        "exactly one accept may take the last seat.\n  a: {} {}\n  b: {} {}",
        ra.status,
        ra.text,
        rb.status,
        rb.text
    );
    let winner_code = if ra.status == 422 { ra.code() } else { rb.code() };
    assert_eq!(winner_code, SEAT_LIMIT_REACHED, "the loser is a SEAT refusal");
    assert_eq!(
        member_count(&f.pool, f.org).await,
        limit,
        "the account lands exactly ON the limit, never one past it"
    );
    let joined = [
        role_of(&f.pool, f.org, a_id).await.is_some(),
        role_of(&f.pool, f.org, b_id).await.is_some(),
    ];
    assert_eq!(
        joined.iter().filter(|j| **j).count(),
        1,
        "exactly one of the two got a membership row"
    );
}

/// **INV-10's positive control, on BOTH builds.** An accept comfortably under the limit is
/// a 201. On a default (desktop/OSS) build this is the whole of INV-10's observable
/// behaviour — the seat check compiles out and the allowance is unlimited — so without this
/// arm the non-saas build would assert nothing about accept-and-seats at all.
#[tokio::test]
async fn inv10_positive_control_an_accept_under_the_limit_succeeds() {
    let f = fixture("i10p").await;
    let (id, token) = invitee(&f, "i10p_new", "i10p_new@cyto.test").await;
    let (_inv, t) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i10p_new@cyto.test",
        "member",
    )
    .await;
    let before = member_count(&f.pool, f.org).await;
    let r = post_accept(&f.server, Some(&token), &t).await;
    assert_eq!(r.status, 201, "{}", r.text);
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
    assert_eq!(member_count(&f.pool, f.org).await, before + 1);
}

// ===========================================================================
// TEST-7 [acceptance] [invariant: INV-17] [covers: ITEM-4, ITEM-10]
// ===========================================================================
/// **INV-17 — accept is single-use and atomic.**
///
/// > Insert the membership and stamp `accepted_at`/`accepted_by` in **one transaction**.
/// > […] a second accept finds no *pending* row.
///
/// Two concurrent accepts of the SAME token ⇒ exactly one 201 and one generic 404; exactly
/// one membership row; `accepted_at` set once, to the redeemer.
///
/// **What mutation this kills.** Replace the `FOR UPDATE` + repeated pending predicate with
/// a read-then-unconditional-UPDATE and both requests observe a pending row: two 201s, two
/// stamps, and (but for `ON CONFLICT DO NOTHING`) two membership rows.
#[tokio::test]
async fn inv17_two_concurrent_accepts_of_one_token_yield_one_201_and_one_404() {
    let f = fixture("i17").await;
    let (id, token) = invitee(&f, "i17_new", "i17_new@cyto.test").await;
    let (inv, t) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i17_new@cyto.test",
        "member",
    )
    .await;
    let before = member_count(&f.pool, f.org).await;

    let (r1, r2) = while_the_account_row_is_held(&f.pool, f.org, 2, async {
        tokio::join!(
            post_accept(&f.server, Some(&token), &t),
            post_accept(&f.server, Some(&token), &t),
        )
    })
    .await;

    let mut statuses = [r1.status, r2.status];
    statuses.sort_unstable();
    assert_eq!(
        statuses,
        [201, 404],
        "exactly one redemption.\n  1: {} {}\n  2: {} {}",
        r1.status,
        r1.text,
        r2.status,
        r2.text
    );
    let loser = if r1.status == 404 { &r1 } else { &r2 };
    assert_eq!(
        loser.code(),
        INVALID_INVITATION,
        "the loser gets the GENERIC refusal — not a 409, which would say 'somebody already \
         used this' and is a fact about the token: {}",
        loser.text
    );

    assert_eq!(
        member_count(&f.pool, f.org).await,
        before + 1,
        "exactly ONE membership row"
    );
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
    let (stamped, by) = accepted_state(&f.pool, inv).await;
    assert!(stamped, "accepted_at is set");
    assert_eq!(by, Some(id), "…and names the redeemer");
    assert_eq!(
        events(&f.pool, f.org, "joined", id).await.len(),
        1,
        "exactly ONE joined ledger row, not two"
    );
}

/// **INV-17's ROLLBACK half** — *"a forced failure at step 5 leaves neither the membership
/// nor the `accepted_at` stamp (roll back together or not at all)"*.
///
/// No refusal the code path produces NATURALLY lands between the two writes — every guard
/// fires before the INSERT — so the failure is injected at the database, with a
/// `BEFORE UPDATE` trigger armed on exactly this one invitation row. That makes the stamp,
/// and only the stamp, fail, strictly AFTER `add_member_in_tx` has inserted the membership
/// and written its ledger row.
///
/// **Positive control:** the trigger is dropped and the SAME token is redeemed ⇒ 201, one
/// membership row, `accepted_at` set. Without it, "nothing happened" is indistinguishable
/// from a route that never worked.
#[tokio::test]
async fn inv17_a_failure_after_the_insert_rolls_the_stamp_and_the_membership_back_together() {
    let f = fixture("i17b").await;
    let (id, token) = invitee(&f, "i17b_new", "i17b_new@cyto.test").await;
    let (inv, t) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i17b_new@cyto.test",
        "member",
    )
    .await;
    let before = member_count(&f.pool, f.org).await;

    // Arm the fault on THIS row only: the membership INSERT and the ledger write both
    // succeed, and then the stamp — step 5b, the last write in the transaction — raises.
    sqlx::query(
        "CREATE OR REPLACE FUNCTION cyto_test_accept_fault() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected fault at the accept stamp'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&f.pool)
    .await
    .expect("create fault function");
    sqlx::query(&format!(
        "CREATE TRIGGER cyto_test_accept_fault BEFORE UPDATE ON account_invitations \
         FOR EACH ROW WHEN (OLD.id = '{inv}') EXECUTE FUNCTION cyto_test_accept_fault()"
    ))
    .execute(&f.pool)
    .await
    .expect("arm the fault trigger");

    let r = post_accept(&f.server, Some(&token), &t).await;
    assert_eq!(
        r.status, 500,
        "the injected fault must surface as a 500, not as a silent success or an \
         unrelated 4xx: {} {}",
        r.status,
        r.text
    );

    // NEITHER write survived.
    assert_eq!(
        role_of(&f.pool, f.org, id).await,
        None,
        "the membership INSERT must roll back with the failed stamp"
    );
    assert_eq!(member_count(&f.pool, f.org).await, before);
    assert!(
        !accepted_state(&f.pool, inv).await.0,
        "and the invitation must be left PENDING, not half-redeemed"
    );
    assert!(
        events(&f.pool, f.org, "joined", id).await.is_empty(),
        "nor may the audit ledger record a join that was rolled back"
    );

    sqlx::query("DROP TRIGGER cyto_test_accept_fault ON account_invitations")
        .execute(&f.pool)
        .await
        .expect("disarm the fault trigger");

    // ── ARM 2: a fault that can ONLY be reached AFTER the membership INSERT ──
    //
    // The arm above proves the post-state is empty; it does not, on its own, prove the
    // membership INSERT ever RAN before the failure — a blind tests-quality audit made that
    // point, and it is right. This arm closes it. The fault is on `account_member_events`,
    // which `add_member_in_tx` writes on the `Some(row)` branch — i.e. only after the
    // `INSERT INTO account_members … RETURNING` produced a row. Reaching the fault is
    // therefore PROOF the membership was inserted, and the assertions below prove it did not
    // survive.
    sqlx::query(
        "CREATE TRIGGER cyto_test_ledger_fault BEFORE INSERT ON account_member_events \
         FOR EACH ROW WHEN (NEW.account_id = $1) EXECUTE FUNCTION cyto_test_accept_fault()"
            .replace("$1", &format!("'{}'", f.org))
            .as_str(),
    )
    .execute(&f.pool)
    .await
    .expect("arm the ledger fault trigger");

    // The trigger really does sit on the POST-INSERT path, asserted rather than argued
    // (FIX_ROUND-2, R2-5). The admin add route reaches `add_member_in_tx` too, and its
    // ledger row is written on the same branch — AFTER `INSERT INTO account_members …
    // RETURNING` produced a row. So if this add is refused by the trigger, the trigger is on
    // a path only reachable once a membership INSERT has succeeded, which is exactly what
    // ARM 2 needs and what distinguishes it from ARM 1 (whose fault is on the stamp).
    let probe = create_user(&f.server, &f.admin, "i17b_probe", "i17b_probe@cyto.test").await;
    let probe_resp = f
        .server
        .client
        .post(f.server.api_url(&format!("/admin/accounts/{}/members", f.org)))
        .bearer_auth(&f.admin)
        .json(&json!({ "user_id": probe, "role": "member" }))
        .send()
        .await
        .expect("admin add (trigger probe)");
    assert!(
        probe_resp.status().as_u16() == 500,
        "the ledger fault must block a plain membership add too — that is what proves it \
         fires only AFTER an `account_members` INSERT has succeeded"
    );
    assert_eq!(
        role_of(&f.pool, f.org, probe).await,
        None,
        "…and that add rolled back as well"
    );

    let r = post_accept(&f.server, Some(&token), &t).await;
    assert_eq!(
        r.status, 500,
        "a fault after the membership INSERT must surface as a 500: {} {}",
        r.status,
        r.text
    );
    assert_eq!(
        role_of(&f.pool, f.org, id).await,
        None,
        "the membership row DID exist inside the transaction (the ledger write is only \
         reached after the INSERT returns a row) and must not survive the rollback"
    );
    assert_eq!(member_count(&f.pool, f.org).await, before);
    assert!(!accepted_state(&f.pool, inv).await.0);

    sqlx::query("DROP TRIGGER cyto_test_ledger_fault ON account_member_events")
        .execute(&f.pool)
        .await
        .expect("disarm the ledger fault trigger");

    // ── POSITIVE CONTROL: with both faults disarmed, the SAME token is redeemed ──
    let r = post_accept(&f.server, Some(&token), &t).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
    assert_eq!(member_count(&f.pool, f.org).await, before + 1);
    assert!(accepted_state(&f.pool, inv).await.0);
    assert_eq!(
        events(&f.pool, f.org, "joined", id).await.len(),
        1,
        "…and exactly one ledger row, written in that same transaction"
    );
}


/// **TEST-7 (cont.) — the LOCK ORDER, demonstrated BEHAVIOURALLY** (FIX_ROUND-4, G-1).
///
/// `accept_invitation` must take `accounts` → the account's OWNER rows → the invitation row,
/// the order `create_invitation`, `resend_invitation`, `set_role`, `remove_member` and
/// `add_member_in_tx` all take. FIX_ROUND-1 hoisted the owner-row lock to restore that order
/// after a blind concurrency audit found accept had inverted the last two — an ABBA relation
/// with create/resend, masked only by the `accounts` lock all three happen to take first, and
/// `revoke_invitation` already shows that masking is not universal in this module.
///
/// **This replaces a SOURCE-TEXT guard, and the replacement is the point.** FIX_ROUND-2 pinned
/// the order by asserting the textual position of three statements. The phase-7 GUARD-SUB
/// tripwire then fired — 70% of round 3's findings landed on this file, and one of them was
/// about that guard's own anchor being ambiguous, which is precisely the shape the tripwire
/// exists to catch: a predicate standing in for a behaviour has an unbounded evasion space, so
/// each round finds another spelling rather than another defect. The remedy is not a better
/// predicate. It is this test, which asserts the BEHAVIOUR the predicate was standing in for.
///
/// # How it discriminates, deterministically and with no deadlock race
///
/// A competing transaction takes the OWNER rows and nothing else — the state
/// `create_invitation` / `resend_invitation` are in between their second and third locks. An
/// accept is then fired and waits.
///
/// * **Correct order** — accept holds `accounts`, is blocked on the owner rows, and has NOT
///   yet touched the invitation row. A `FOR UPDATE NOWAIT` probe on that invitation therefore
///   SUCCEEDS.
/// * **Inverted order** — accept holds `accounts` AND the invitation row while blocked on the
///   owner rows. The probe fails with SQLSTATE `55P03`: the competitor holds the owner rows and
///   cannot reach the invitation, accept holds the invitation and cannot reach the owner rows.
///   That is the cycle, observed rather than argued.
///
/// No deadlock is ever provoked (the probe is `NOWAIT`), nothing depends on timing beyond the
/// parking wait, and deleting the hoisted `FOR UPDATE` turns the probe red.
///
/// **Positive control:** the competitor commits and the same accept completes with a 201.
#[tokio::test]
async fn accept_never_holds_the_invitation_row_while_waiting_for_the_owner_rows() {
    let f = fixture("i7lo").await;
    let (id, bearer) = invitee(&f, "i7lo_new", "i7lo_new@cyto.test").await;
    let (inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i7lo_new@cyto.test",
        "member",
    )
    .await;

    // A competitor in the state create/resend occupy between their 2nd and 3rd locks: it holds
    // the OWNER rows and has not yet taken the invitation row. (It deliberately does NOT take
    // the accounts row, so the accept can get that far and the test observes the ordering of
    // the two locks that actually differ.)
    let mut competitor = f.pool.begin().await.expect("begin the competing transaction");
    let held: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM account_members WHERE account_id = $1 AND role = 'owner' \
         FOR UPDATE",
    )
    .bind(f.org)
    .fetch_all(&mut *competitor)
    .await
    .expect("hold the owner rows");
    let competitor_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *competitor)
        .await
        .expect("the competitor's backend pid");
    assert!(
        !held.is_empty(),
        "the competitor must actually hold something — an account with no owner rows would \
         make this test vacuous"
    );

    let pool = f.pool.clone();
    let probe = async move {
        // Wait until the accept is genuinely parked ON THE COMPETITOR — i.e. on the owner
        // rows it holds, which is the only thing it holds.
        await_lock_waiters(&pool, 1, competitor_pid).await;

        // THE ASSERTION. Under the correct order the accept has not reached the invitation
        // row, so this takes it immediately (and releases it at statement end, since this is
        // an autocommit query).
        let got = sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM account_invitations WHERE id = $1 FOR UPDATE NOWAIT",
        )
        .bind(inv)
        .fetch_optional(&pool)
        .await;
        match got {
            Ok(Some(_)) => {}
            Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("55P03") => panic!(
                "the accept is holding the INVITATION row while it waits for the OWNER rows. \
                 That is the ABBA inversion against `create_invitation` / `resend_invitation`, \
                 which take those two locks in the opposite order: this competitor holds the \
                 owner rows and cannot reach the invitation, the accept holds the invitation \
                 and cannot reach the owner rows. Take the owner-row `FOR UPDATE` BEFORE the \
                 invitation `FOR UPDATE` in `accept_invitation`."
            ),
            other => panic!("unexpected probe result: {other:?}"),
        }

        competitor
            .commit()
            .await
            .expect("release the owner rows");
    };

    let (r, ()) = tokio::join!(post_accept(&f.server, Some(&bearer), &token), probe);

    // ── POSITIVE CONTROL: the accept completes once the competitor is gone ──
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
    assert!(accepted_state(&f.pool, inv).await.0);
}

/// **TEST-7 (cont.) — the FIRST arrow of the canonical order** (FIX_ROUND-5, C5-1).
///
/// The sibling above proves `owner rows < invitation`. The source guard both replaced also
/// asserted `accounts < owner rows`, and a round-5 correctness angle observed that the
/// behavioural replacement had quietly dropped that half: deleting `lock_account_row` from
/// `accept_invitation` — or moving it after the owner-row `FOR UPDATE` — left every test green.
/// This is the mirror image of the sibling, so both arrows are now behavioural and the
/// replacement is a strict improvement on the guard rather than a partial one.
///
/// A competitor holds ONLY the `accounts` row. An accept is fired and parks.
///
/// * **Correct order** — accept is blocked on `accounts` and has NOT taken the owner rows, so a
///   `FOR UPDATE NOWAIT` probe on them SUCCEEDS.
/// * **Inverted order** — accept holds the OWNER rows while waiting for `accounts`, and the
///   probe fails `55P03`: the competitor holds `accounts` and cannot reach the owner rows,
///   accept holds the owner rows and cannot reach `accounts`. That is the cycle against every
///   other membership-mutating path in this module, all of which take `accounts` first.
///
/// **Positive control:** the competitor commits and the same accept completes with a 201.
#[tokio::test]
async fn accept_never_holds_the_owner_rows_while_waiting_for_the_account_row() {
    let f = fixture("i7lo2").await;
    let (id, bearer) = invitee(&f, "i7lo2_new", "i7lo2_new@cyto.test").await;
    let (inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i7lo2_new@cyto.test",
        "member",
    )
    .await;

    let mut competitor = f.pool.begin().await.expect("begin the competing transaction");
    sqlx::query("SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE")
        .bind(f.org)
        .execute(&mut *competitor)
        .await
        .expect("hold the account row");
    let competitor_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *competitor)
        .await
        .expect("the competitor's backend pid");
    assert_account_row_is_held(&f.pool, f.org).await;
    // The sibling's non-vacuity guard, which this test was missing (FIX_ROUND-6, R6-2). The
    // probe below reads the OWNER rows; an account with none would make it prove nothing.
    let owners: Vec<Uuid> = sqlx::query_scalar(
        "SELECT user_id FROM account_members WHERE account_id = $1 AND role = 'owner'",
    )
    .bind(f.org)
    .fetch_all(&f.pool)
    .await
    .expect("read the owner rows");
    assert!(
        !owners.is_empty(),
        "the probe must have something to take — an account with no owner rows would make \
         this test vacuous"
    );

    let pool = f.pool.clone();
    let probe = async move {
        await_lock_waiters(&pool, 1, competitor_pid).await;

        let got = sqlx::query_scalar::<_, Uuid>(
            "SELECT user_id FROM account_members WHERE account_id = $1 AND role = 'owner' \
             FOR UPDATE NOWAIT",
        )
        .bind(f.org)
        .fetch_optional(&pool)
        .await;
        match got {
            Ok(Some(_)) => {}
            Err(sqlx::Error::Database(e)) if e.code().as_deref() == Some("55P03") => panic!(
                "the accept is holding the OWNER rows while it waits for the ACCOUNTS row. \
                 Every membership-mutating path in this module takes `accounts` FIRST, so this \
                 inverts the order against all of them: the competitor holds `accounts` and \
                 cannot reach the owner rows, the accept holds the owner rows and cannot reach \
                 `accounts`. Take `lock_account_row` BEFORE the owner-row `FOR UPDATE` in \
                 `accept_invitation`."
            ),
            other => panic!("unexpected probe result: {other:?}"),
        }

        competitor.commit().await.expect("release the account row");
    };

    let (r, ()) = tokio::join!(post_accept(&f.server, Some(&bearer), &token), probe);

    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
    assert!(accepted_state(&f.pool, inv).await.0);
}

// ===========================================================================
// TEST-8 [acceptance] [invariant: INV-EMAIL-BIND] [covers: ITEM-6, ITEM-16]
// ===========================================================================
/// **INV-EMAIL-BIND — the authenticated user's `users.email`, normalized, must equal the
/// invitation's; a mismatch is the SAME generic 404.**
///
/// The refusal half is compared byte-for-byte against a wrong-token refusal in TEST-4; here
/// the concern is the BINDING itself: it is a NORMALIZED comparison (case and surrounding
/// whitespace do not matter) and it does not require a verified address.
///
/// **Positive control:** the intended recipient, whose stored address differs from the
/// invited one only by CASE and padding, redeems it ⇒ 201. Without that arm, "the mismatch
/// is refused" would also pass against a binding that refused everybody.
///
/// **The residual risk is asserted as BEHAVIOUR, not prose (#143).** The redemption
/// succeeds while `users.email_verified` is FALSE. That is deliberate — there is no
/// verification flow for password registration, so requiring it would make every invitee
/// unable to redeem — and it is exactly why the binding is containment against a leaked link
/// reaching the wrong logged-in tab, NOT proof that the redeemer controls that mailbox.
#[tokio::test]
async fn inv_email_binding_is_normalized_and_does_not_require_a_verified_address() {
    let f = fixture("ieb").await;

    // The invitation is issued to a MIXED-CASE, PADDED address; #145 normalizes it at write
    // time. The recipient's stored address is the plain lowercase one.
    let (recipient_id, recipient_token) =
        invitee(&f, "ieb_recipient", "ieb_recipient@cyto.test").await;
    let (_other_id, other_token) = invitee(&f, "ieb_other", "ieb_other@cyto.test").await;

    let (inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "  IEB_Recipient@CYTO.test  ",
        "member",
    )
    .await;

    // ── DENY: a different logged-in user, holding a perfectly valid token ──
    let before = member_count(&f.pool, f.org).await;
    let r = post_accept(&f.server, Some(&other_token), &token).await;
    assert_eq!(r.status, 404, "wrong recipient: {}", r.text);
    assert_eq!(
        r.code(),
        INVALID_INVITATION,
        "the mismatch must be the GENERIC refusal — a message naming the invited address \
         would confirm to any holder of a leaked link that the address is on this account: {}",
        r.text
    );
    assert_eq!(member_count(&f.pool, f.org).await, before, "nothing written");
    assert!(
        !accepted_state(&f.pool, inv).await.0,
        "and the invitation stays PENDING for its real recipient"
    );

    // ── the residual risk, as behaviour: the recipient is NOT verified ──
    let verified: bool = sqlx::query_scalar("SELECT email_verified FROM users WHERE id = $1")
        .bind(recipient_id)
        .fetch_one(&f.pool)
        .await
        .expect("read email_verified");
    assert!(
        !verified,
        "precondition for the residual risk (#143): password registration sets no \
         verification, so the arm below redeems on an UNVERIFIED address"
    );

    // ── POSITIVE CONTROL: the intended recipient, normalized match ──
    let r = post_accept(&f.server, Some(&recipient_token), &token).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(
        role_of(&f.pool, f.org, recipient_id).await.as_deref(),
        Some("member"),
        "the binding is a NORMALIZED comparison — case and padding must not block the \
         person the invitation was for"
    );
}

// ===========================================================================
// TEST-9 [acceptance] [invariant: INV-NO-REGISTER-CHANGE] [covers: ITEM-14]
// ===========================================================================
/// **INV-NO-REGISTER-CHANGE — signup-then-accept is TWO calls, and
/// `POST /api/auth/register` is untouched.**
///
/// > No special-casing in the auth crate is needed and none should be added — the invite
/// > must not become a second registration path, because a registration path that accepts a
/// > token is a registration path that can be tricked into pre-confirming an email it never
/// > checked.
///
/// Drives the real flow end to end for an invitee who has no account at all, and asserts
/// the negative twice over: a `token` field smuggled into the REGISTER body does nothing,
/// and the shipped `ziee-auth` register handler contains no invitation/token handling.
///
/// **Positive control:** the second call — the accept — really does create the membership,
/// so "registering created no membership" is not passing because nothing works.
#[tokio::test]
async fn signup_then_accept_works_end_to_end_with_no_change_to_register() {
    let f = fixture("ste").await;

    // An invitation for an address that belongs to NO user yet.
    let email = "ste_newcomer@cyto.test";
    let (inv, token) = mint_invitation(&f.server, &f.owner_token, &f.pool, f.org, email, "member")
        .await;
    let before = member_count(&f.pool, f.org).await;

    // ── call 1: the UNMODIFIED register endpoint, with the token smuggled into the body ──
    //
    // The extra field must be inert. If registration ever grew token handling this arm is
    // what goes red: a membership would exist before the accept call was ever made.
    let reg = f
        .server
        .client
        .post(f.server.api_url("/auth/register"))
        .json(&json!({
            "username": "ste_newcomer",
            "email": email,
            "password": "userPassw0rd!",
            "token": token,
        }))
        .send()
        .await
        .expect("register request");
    assert!(reg.status().is_success(), "register: {}", reg.status());

    let newcomer: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'ste_newcomer'")
        .fetch_one(&f.pool)
        .await
        .expect("the registered user");
    assert_eq!(
        member_count(&f.pool, f.org).await,
        before,
        "REGISTERING must not join the inviting account — the token in the body is inert"
    );
    assert_eq!(role_of(&f.pool, f.org, newcomer).await, None);
    assert!(
        !accepted_state(&f.pool, inv).await.0,
        "nor may registration consume the invitation"
    );

    // ── call 2: the accept, with the token the SPA held in memory ──
    let newcomer_token = login(&f.server, "ste_newcomer").await;
    let r = post_accept(&f.server, Some(&newcomer_token), &token).await;
    assert_eq!(r.status, 201, "signup-then-accept: {}", r.text);
    assert_eq!(
        role_of(&f.pool, f.org, newcomer).await.as_deref(),
        Some("member"),
        "the SECOND call is what joins — two calls, no new auth surface"
    );
    assert!(accepted_state(&f.pool, inv).await.0);

    // The newcomer also has their own personal account, provisioned by the account module's
    // backstop on their first authenticated request (NOT inside the register transaction —
    // see `auto_personal_test::fresh_registration_gets_exactly_one_personal_account`, which
    // pins that placement). Asserted here because #146's prose says a registered user is
    // "fully provisioned" and this is what makes that true in practice.
    let personal: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(newcomer)
    .fetch_one(&f.pool)
    .await
    .expect("count personal accounts");
    assert_eq!(personal, 1, "exactly one personal account after signup");

    // ── and the register handler itself carries no invitation coupling ──
    let register_src = include_str!("../../../../sdk/crates/ziee-auth/src/auth/http/handlers.rs");
    let lowered = register_src.to_lowercase();
    for coupling in ["invitation", "account_invitations", "invite_token"] {
        assert!(
            !lowered.contains(coupling),
            "the auth crate's HTTP handlers must contain no `{coupling}` handling — an \
             invitation-aware registration endpoint is one that can be argued into treating \
             an unverified email as pre-confirmed"
        );
    }
}

// ===========================================================================
// TEST-10 [acceptance] [invariant: INV-18] [covers: ITEM-1, ITEM-12]
// ===========================================================================
/// **INV-18 — the token travels in the request BODY, never in a URL.**
///
/// > Transported in the request body of `POST /api/account-invitations/accept`, never in a
/// > URL path or query. A token in a URL leaks through `Referer`, browser history, proxy
/// > access logs and screen-shares.
///
/// Asserted against the SHIPPED `openapi.json` — the generated artifact clients are built
/// from — rather than against the Rust source, so a route that declared a query parameter
/// would fail here even if the handler happened to ignore it. Plus the behavioural half: the
/// token in a query string with an empty body is refused and joins nobody.
///
/// **This is the BACKEND half only.** The other half — the SPA reading the token from the
/// URL FRAGMENT and no request carrying it in a path or query — is #149's, and #146 assigns
/// it there (A10). Nothing here should be read as proving it.
#[tokio::test]
async fn inv18_the_token_is_accepted_only_in_the_request_body() {
    const PATH: &str = "/api/account-invitations/accept";
    for spec_path in [
        "../ui/openapi/openapi.json",
        "../ui/openapi-saas/openapi.json",
    ] {
        let spec: Value = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(spec_path),
            )
            .unwrap_or_else(|e| panic!("read {spec_path}: {e}")),
        )
        .unwrap_or_else(|e| panic!("parse {spec_path}: {e}"));

        let op = spec["paths"][PATH]["post"].clone();
        assert!(
            op.is_object(),
            "{spec_path}: the accept operation must exist at {PATH} — regenerate with \
             `just openapi-regen`"
        );
        // No parameters AT ALL: nothing in the path, the query or a header could carry it.
        let params = op.get("parameters").cloned().unwrap_or(Value::Null);
        let empty = params.is_null() || params.as_array().map(|a| a.is_empty()).unwrap_or(false);
        assert!(
            empty,
            "{spec_path}: the accept operation must declare NO parameters; found {params}"
        );
        // …and the token really is declared in the body.
        let body = &op["requestBody"];
        assert!(
            body.is_object(),
            "{spec_path}: the accept operation must declare a requestBody"
        );
        assert!(
            serde_json::to_string(body)
                .expect("serialize requestBody")
                .contains("AcceptInvitationRequest")
                || serde_json::to_string(&spec["components"]["schemas"]["AcceptInvitationRequest"])
                    .expect("serialize schema")
                    .contains("token"),
            "{spec_path}: the request body must carry the token"
        );
        // No path in the whole spec smuggles a token into a URL segment.
        for p in spec["paths"].as_object().expect("paths object").keys() {
            assert!(
                !p.contains("{token}") && !p.to_lowercase().contains("invite_token"),
                "{spec_path}: no route may carry a token in its PATH: {p}"
            );
        }
    }

    // ── behavioural: query-string transport is not honoured ──
    let f = fixture("i18").await;
    let (id, bearer) = invitee(&f, "i18_new", "i18_new@cyto.test").await;
    let (_inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i18_new@cyto.test",
        "member",
    )
    .await;
    let before = member_count(&f.pool, f.org).await;

    let r = post_accept_token_in_query(&f.server, &bearer, &token).await;
    assert!(
        // Specifically a BODY-VALIDATION refusal. `>= 400` alone was satisfied by a 401
        // (bearer rejected), a 404 (route missing), a 405 (wrong method) or any unrelated
        // failure, so it would have passed against a build where the route did not exist at
        // all (FIX_ROUND-1, R1-11).
        r.status == 400 || r.status == 422,
        "a token supplied only in the QUERY STRING must be refused BY THE BODY CONTRACT \
         (400/422), not by an unrelated failure: {} {}",
        r.status,
        r.text
    );
    assert_eq!(role_of(&f.pool, f.org, id).await, None, "and joins nobody");
    assert_eq!(member_count(&f.pool, f.org).await, before);

    // ── POSITIVE CONTROL: the identical token, in the BODY ──
    let r = post_accept(&f.server, Some(&bearer), &token).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
}

// ===========================================================================
// TEST-11 [covers: ITEM-1, ITEM-2]
// ===========================================================================
/// The route is **authenticated** — and authenticated is ALL it is.
///
/// 401 with no bearer and with a junk bearer; 201 for the same token with a real one. And
/// the property #146 DEC-1 turns on: a user who holds NO `account::*` capability at all
/// (stripped from the `Users` group) can still redeem a token addressed to them, because
/// the token is the capability. An operator turning self-service off must not be able to
/// strand a holder of a live token OUTSIDE the account.
#[tokio::test]
async fn accept_is_authenticated_but_not_capability_gated() {
    let f = fixture("i11").await;
    let (id, bearer) = invitee(&f, "i11_new", "i11_new@cyto.test").await;
    let (_inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i11_new@cyto.test",
        "member",
    )
    .await;
    let before = member_count(&f.pool, f.org).await;

    let anon = post_accept(&f.server, None, &token).await;
    assert_eq!(anon.status, 401, "unauthenticated: {}", anon.text);
    let junk = post_accept(&f.server, Some("not-a-real-token"), &token).await;
    assert_eq!(junk.status, 401, "junk bearer: {}", junk.text);
    assert_eq!(member_count(&f.pool, f.org).await, before, "nothing written");

    // Strip every group-granted capability from the invitee — including
    // `account::members::manage`, the switch an operator flips to turn self-service off.
    let stripped = f
        .server
        .client
        .delete(f.server.api_url(&format!("/groups/{id}/{USERS_GROUP_ID}/remove")))
        .bearer_auth(&f.admin)
        .send()
        .await
        .expect("strip group");
    assert!(stripped.status().is_success(), "strip group");
    // Re-login so the request carries an identity resolved after the strip.
    let bearer_after = login(&f.server, "i11_new").await;

    let r = post_accept(&f.server, Some(&bearer_after), &token).await;
    assert_eq!(
        r.status, 201,
        "a user holding NO account capability must still be able to redeem a token \
         addressed to them — the token IS the capability (#146 DEC-1): {}",
        r.text
    );
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
    // `bearer` is the pre-strip token; kept so the 401 arms above are not the only use of
    // a real credential in this test.
    let _ = bearer;
}

// ===========================================================================
// TEST-12 [covers: ITEM-8]
// ===========================================================================
/// A **personal** account refuses membership, and the accept path does not depend on #145
/// refusing to create such an invitation.
///
/// The invitation row is PLANTED directly — no shipped route will mint one — which is
/// exactly the point: #146 says the accept path "must not depend on that". H-2's guard lives
/// in the repository (`refuse_if_personal_on`) and this proves accept reaches it.
///
/// **Positive control:** an identically-planted invitation against an ORGANIZATION account
/// is redeemed ⇒ 201.
#[tokio::test]
async fn accepting_into_a_personal_account_is_refused_by_name() {
    let f = fixture("i12").await;
    let (id, bearer) = invitee(&f, "i12_new", "i12_new@cyto.test").await;

    let personal: Uuid = sqlx::query_scalar(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(f.owner_id)
    .fetch_one(&f.pool)
    .await
    .expect("the owner's personal account");

    let (personal_inv, personal_token) = plant_invitation(
        &f.pool,
        personal,
        "i12_new@cyto.test",
        "member",
        Some(f.owner_id),
    )
    .await;
    let before = member_count(&f.pool, personal).await;

    let r = post_accept(&f.server, Some(&bearer), &personal_token).await;
    assert_eq!(r.status, 422, "personal account: {}", r.text);
    assert_eq!(r.code(), PERSONAL_ACCOUNT_NOT_MANAGEABLE, "{}", r.text);
    assert_eq!(
        member_count(&f.pool, personal).await,
        before,
        "a personal account keeps exactly its owner"
    );
    assert_eq!(role_of(&f.pool, personal, id).await, None);
    assert!(!accepted_state(&f.pool, personal_inv).await.0);

    // ── POSITIVE CONTROL: the same planting, on the ORG ──
    let (org_inv, org_token) =
        plant_invitation(&f.pool, f.org, "i12_new@cyto.test", "member", Some(f.owner_id)).await;
    let r = post_accept(&f.server, Some(&bearer), &org_token).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
    assert!(accepted_state(&f.pool, org_inv).await.0);
}

/// An invitation with **no recorded inviter** (`invited_by IS NULL`) fails CLOSED.
///
/// `create_invitation` maps `ActorCeiling::PlatformStaff` to a NULL inviter, so the state is
/// representable even though no shipped route produces it today. #146 DEC-5's rule is that
/// an invitation whose authority cannot be re-verified is not honoured — the one case that
/// cannot be checked must not be the one case that is not checked.
///
/// **Positive control:** the identical planting WITH an inviter is redeemed ⇒ 201.
#[tokio::test]
async fn an_invitation_with_no_recorded_inviter_is_refused() {
    let f = fixture("i12b").await;
    let (id, bearer) = invitee(&f, "i12b_new", "i12b_new@cyto.test").await;

    let (inv, token) =
        plant_invitation(&f.pool, f.org, "i12b_new@cyto.test", "member", None).await;
    let before = member_count(&f.pool, f.org).await;

    let r = post_accept(&f.server, Some(&bearer), &token).await;
    assert_eq!(r.status, 403, "no recorded inviter: {}", r.text);
    assert_eq!(r.code(), ROLE_ABOVE_ACTOR, "{}", r.text);
    assert_eq!(role_of(&f.pool, f.org, id).await, None);
    assert_eq!(member_count(&f.pool, f.org).await, before);
    assert!(!accepted_state(&f.pool, inv).await.0);

    // ── POSITIVE CONTROL ──
    //
    // `uq_account_invitations_live` is a partial unique index on (account_id, email) over
    // LIVE rows, so the refused invitation above must be retired before an equivalent one
    // can be planted. Revoking it (rather than deleting) is what a real admin would do and
    // keeps the row for the audit trail.
    revoke(&f.pool, inv, f.owner_id).await;
    let (ok_inv, ok_token) = plant_invitation(
        &f.pool,
        f.org,
        "i12b_new@cyto.test",
        "member",
        Some(f.owner_id),
    )
    .await;
    let r = post_accept(&f.server, Some(&bearer), &ok_token).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
    assert!(accepted_state(&f.pool, ok_inv).await.0);
}

// ===========================================================================
// TEST-13 [covers: ITEM-11]
// ===========================================================================
/// Accepting when the caller is **already a member** is idempotent: `200`, no second row,
/// no role change, no `joined` ledger row — and the invitation IS consumed (#146 DEC-6).
///
/// The invitation deliberately names a HIGHER role than the member already holds. A 7-day-old
/// bearer token must not promote anybody (#146 DEC-12); that is the escalation class INV-6
/// exists to close, arriving through another door.
///
/// **Positive control:** a NON-member redeeming the equivalent token gets 201 and a new row
/// at the invitation's role — so "no row was added" above is idempotency, not a dead route.
#[tokio::test]
async fn accepting_as_an_existing_member_is_idempotent() {
    let f = fixture("i13").await;
    let (id, bearer) = invitee(&f, "i13_member", "i13_member@cyto.test").await;
    add_member(&f.pool, f.org, id, "member").await;

    // PLANTED, not minted: `POST …/invitations` is a documented NO-OP when the address
    // already belongs to a member of this account (#145 INV-8 — the create response is
    // uniform in all four cases and two of them write nothing), so there is no route that
    // can produce this row. The state is still reachable in the real world: the invitation
    // is minted first, and the invitee is added by an admin before they get round to
    // redeeming it.
    let (inv, token) = plant_invitation(
        &f.pool,
        f.org,
        "i13_member@cyto.test",
        "admin",
        Some(f.owner_id),
    )
    .await;
    let before = member_count(&f.pool, f.org).await;
    let joins_before = events(&f.pool, f.org, "joined", id).await.len();

    let r = post_accept(&f.server, Some(&bearer), &token).await;
    assert_eq!(r.status, 200, "already a member: {}", r.text);
    assert_eq!(
        r.json()["role"],
        "member",
        "the response carries the ACTUAL role, not the invitation's: {}",
        r.text
    );
    assert_eq!(
        member_count(&f.pool, f.org).await,
        before,
        "no SECOND membership row"
    );
    assert_eq!(
        role_of(&f.pool, f.org, id).await.as_deref(),
        Some("member"),
        "and no promotion — an invitation never re-roles an existing member"
    );
    assert_eq!(
        events(&f.pool, f.org, "joined", id).await.len(),
        joins_before,
        "nobody joined, so nothing is recorded as a join"
    );
    assert!(
        accepted_state(&f.pool, inv).await.0,
        "the token IS consumed — a live bearer credential for a tenant-wide grant must not \
         be left outstanding just because the redeemer was already inside"
    );

    // ── POSITIVE CONTROL: a NON-member with the equivalent invitation ──
    let (fresh_id, fresh_bearer) = invitee(&f, "i13_fresh", "i13_fresh@cyto.test").await;
    let (_inv2, token2) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i13_fresh@cyto.test",
        "admin",
    )
    .await;
    let r = post_accept(&f.server, Some(&fresh_bearer), &token2).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(
        role_of(&f.pool, f.org, fresh_id).await.as_deref(),
        Some("admin"),
        "an `admin` invitation really does confer admin for someone not yet inside"
    );
    assert_eq!(member_count(&f.pool, f.org).await, before + 1);
}

// ===========================================================================
// TEST-14 [covers: ITEM-4, ITEM-9]
// ===========================================================================
/// The **audit ledger** row, written in the accept transaction (#148, research §8).
///
/// Exactly one `joined` row: target = the invitee, `new_role` = the invitation's role,
/// `actor_kind = 'user'` with `actor_user_id` = **the INVITER** — the authority the grant
/// was graded against, which is what "who granted whom what" means — and `invitation_id`
/// = the invitation, the FK that ties the earlier `invited` row to this one.
///
/// **Deny half, in the same body:** a REFUSED accept (the TOCTOU 403) writes no row at all.
/// **And:** an ADMIN add still writes its `joined` row with `invitation_id IS NULL`, so the
/// widened parameter did not change the pre-existing caller's ledger shape.
#[tokio::test]
async fn a_successful_accept_writes_one_joined_row_tied_to_its_invitation() {
    let f = fixture("i14").await;
    let (id, bearer) = invitee(&f, "i14_new", "i14_new@cyto.test").await;
    let (inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i14_new@cyto.test",
        "admin",
    )
    .await;

    let r = post_accept(&f.server, Some(&bearer), &token).await;
    assert_eq!(r.status, 201, "{}", r.text);

    let rows = events(&f.pool, f.org, "joined", id).await;
    assert_eq!(rows.len(), 1, "exactly one joined row: {rows:?}");
    let (actor_kind, actor_user_id, new_role, invitation_id) = &rows[0];
    assert_eq!(actor_kind, "user", "a self-service grant, not a staff action");
    assert_eq!(
        *actor_user_id,
        Some(f.owner_id),
        "the actor is the INVITER — the authority the grant was graded against"
    );
    assert_eq!(new_role.as_deref(), Some("admin"));
    assert_eq!(
        *invitation_id,
        Some(inv),
        "the FK that ties `invited` -> `joined` (research §8) must be written"
    );

    // …and it really does tie to the SAME invitation the `invited` row named.
    let tied: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM account_member_events i \
           JOIN account_member_events j ON j.invitation_id = i.invitation_id \
          WHERE i.action = 'invited' AND j.action = 'joined' AND i.invitation_id = $1",
    )
    .bind(inv)
    .fetch_one(&f.pool)
    .await
    .expect("join the two ledger rows");
    assert_eq!(
        tied, 1,
        "the ledger must be able to answer 'who was invited, and did they ever join?'"
    );

    // ── the DENY half: a refused accept writes nothing ──
    let (refused_id, refused_bearer) = invitee(&f, "i14_ref", "i14_ref@cyto.test").await;
    let (_ri, rt) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i14_ref@cyto.test",
        "owner",
    )
    .await;
    set_role(&f.pool, f.org, f.owner_id, "member").await;
    let r = post_accept(&f.server, Some(&refused_bearer), &rt).await;
    assert_eq!(r.status, 403, "{}", r.text);
    assert!(
        events(&f.pool, f.org, "joined", refused_id).await.is_empty(),
        "a refused action is not an audited action (#148 DEC-1)"
    );
}

// ===========================================================================
// TEST-17 [covers: ITEM-9]
// ===========================================================================
/// The widened `add_member_in_tx` is **behaviour-preserving for its pre-existing caller**.
///
/// Driven through the REAL admin route (`POST /api/admin/accounts/{id}/members`), not
/// through the repository, so what is proven is the shipped surface: the add still succeeds,
/// still writes exactly one `joined` ledger row, and that row's `invitation_id` is NULL.
#[tokio::test]
async fn the_admin_add_path_still_writes_a_joined_row_with_no_invitation_id() {
    let f = fixture("i17c").await;
    let target = create_user(&f.server, &f.admin, "i17c_t", "i17c_t@cyto.test").await;
    let before = member_count(&f.pool, f.org).await;

    let resp = f
        .server
        .client
        .post(f.server.api_url(&format!("/admin/accounts/{}/members", f.org)))
        .bearer_auth(&f.admin)
        .json(&json!({ "user_id": target, "role": "member" }))
        .send()
        .await
        .expect("admin add member");
    assert!(
        resp.status().is_success(),
        "admin add: {} {}",
        resp.status(),
        resp.text().await.unwrap_or_default()
    );

    assert_eq!(member_count(&f.pool, f.org).await, before + 1);
    let rows = events(&f.pool, f.org, "joined", target).await;
    assert_eq!(rows.len(), 1, "exactly one joined row: {rows:?}");
    assert_eq!(
        rows[0].3, None,
        "an admin add has no invitation — the widened parameter must stay NULL there"
    );
}

// ===========================================================================
// TEST-18 [covers: ITEM-15, ITEM-5]
// ===========================================================================
//
// The **step ORDER** is observable, and it is the order #146 specifies. Each test below
// constructs a request that satisfies TWO refusal conditions at once; which refusal comes
// back names which step ran first. Each carries its own positive control.
//
// **Split into three tests in FIX_ROUND-1 (R1-15).** The whole thing used to be one
// `#[cfg(feature = "saas")]` test, so on a default build — the desktop/OSS build, and one of
// the two the gate runs — the step order was asserted NOWHERE. Only the seat arm needs
// billing. Two blind angles reported it independently. The third test is new: the step 2 /
// step 3 boundary is the one that matters most for INV-9 and was not probed at all.

/// **Step 3 (authorization) precedes step 4 (the seat check).**
///
/// The other way round, a caller who fails the ceiling re-check — somebody whose invitation
/// nobody live can authorize — would learn the account's exact member count, seat limit and
/// plan id from the 422's `details` before being refused.
#[cfg(feature = "saas")]
#[tokio::test]
async fn the_authorization_refusal_precedes_the_seat_refusal() {
    let limit = cytoanalyst::modules::billing::catalog::plan("free")
        .expect("the free plan exists")
        .member_allowance;

    let f = fixture("i18c").await;
    // A second Owner who stays an Owner — the control's invitation comes from them, so it
    // survives the fixture owner's demotion.
    let coowner = create_user(&f.server, &f.admin, "i18c_co", "i18c_co@cyto.test").await;
    add_member(&f.pool, f.org, coowner, "owner").await;
    let coowner_token = login(&f.server, "i18c_co").await;

    // Both invitations are minted UP FRONT, while both owners still hold authority — the
    // demotion below would otherwise refuse the MINT and the test would be exercising
    // `create_invitation`'s gate instead of accept's step order.
    let (over_id, over_bearer) = invitee(&f, "i18c_over", "i18c_over@cyto.test").await;
    let (_oi, over_token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i18c_over@cyto.test",
        "member",
    )
    .await;
    let (ok_id, ok_bearer) = invitee(&f, "i18c_ok", "i18c_ok@cyto.test").await;
    let (_ok_inv, ok_token) = mint_invitation(
        &f.server,
        &coowner_token,
        &f.pool,
        f.org,
        "i18c_ok@cyto.test",
        "member",
    )
    .await;

    for i in member_count(&f.pool, f.org).await..limit {
        let u = create_user(
            &f.server,
            &f.admin,
            &format!("i18c_fill{i}"),
            &format!("i18c_fill{i}@cyto.test"),
        )
        .await;
        add_member(&f.pool, f.org, u, "member").await;
    }
    assert_eq!(member_count(&f.pool, f.org).await, limit, "at the limit");
    set_role(&f.pool, f.org, f.owner_id, "member").await;

    // BOTH conditions hold: the account is full AND the inviter has lost standing.
    let r = post_accept(&f.server, Some(&over_bearer), &over_token).await;
    assert_eq!(
        r.status, 403,
        "the AUTHORIZATION refusal must win over the seat refusal — otherwise a caller who \
         fails step 3 learns the account's member count from step 4's details: {}",
        r.text
    );
    assert_eq!(r.code(), ROLE_ABOVE_ACTOR, "{}", r.text);
    assert!(
        !r.text.contains("plan_id") && !r.text.contains("current"),
        "…and the refusal must carry none of the seat details: {}",
        r.text
    );
    assert_eq!(role_of(&f.pool, f.org, over_id).await, None);

    // ── POSITIVE CONTROL: a live Owner's invitation, and a free seat ──
    remove_member(&f.pool, f.org, over_seat_victim(&f).await).await;
    let r = post_accept(&f.server, Some(&ok_bearer), &ok_token).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(role_of(&f.pool, f.org, ok_id).await.as_deref(), Some("member"));
}

/// A plain `member` to evict so the seat-order control has a free seat. Split out so the
/// control's intent is not buried in a subquery.
#[cfg(feature = "saas")]
async fn over_seat_victim(f: &Fixture) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM account_members WHERE account_id = $1 AND role = 'member' LIMIT 1",
    )
    .bind(f.org)
    .fetch_one(&f.pool)
    .await
    .expect("a plain member to evict")
}

/// **Step 1 (the token lookup) precedes step 3 (the ceiling re-check)**, as OBSERVED at the
/// boundary.
///
/// The other way round, an expired token would be distinguishable from a wrong one by
/// getting a 403 instead of the generic 404 — which is exactly the oracle INV-9 closes.
///
/// **What this does and does not prove, stated precisely (FIX_ROUND-2, R2-8).** Since
/// FIX_ROUND-1 the claim predicate is evaluated at step 1a, OUTSIDE the transaction, so this
/// test is killed by any change that lets a stale token past the lookup — which is the
/// property a caller can observe and the one INV-9 rests on. It is NOT sensitive to a
/// reordering of the statements INSIDE the transaction, because step 1a has already answered
/// by then. That is not a coverage hole: a reordering that changed nothing observable is not
/// a defect, and the one that WOULD change something — removing the step-1a filter — is
/// pinned by `inv9_no_miss_opens_a_transaction_so_the_404_is_indistinguishable_in_time`.
/// A round-2 blind audit made this point and the claim is narrowed rather than the test
/// inflated.
///
/// Runs on BOTH builds: nothing here needs the seat limit.
#[tokio::test]
async fn the_token_lookup_precedes_the_ceiling_recheck() {
    let f = fixture("i18d").await;
    let coowner = create_user(&f.server, &f.admin, "i18d_co", "i18d_co@cyto.test").await;
    add_member(&f.pool, f.org, coowner, "owner").await;
    let coowner_token = login(&f.server, "i18d_co").await;

    let (exp_id, exp_bearer) = invitee(&f, "i18d_exp", "i18d_exp@cyto.test").await;
    let (exp_inv, exp_token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i18d_exp@cyto.test",
        "member",
    )
    .await;
    let (ok_id, ok_bearer) = invitee(&f, "i18d_ok", "i18d_ok@cyto.test").await;
    let (_ok_inv, ok_token) = mint_invitation(
        &f.server,
        &coowner_token,
        &f.pool,
        f.org,
        "i18d_ok@cyto.test",
        "member",
    )
    .await;

    // BOTH conditions hold: the token is expired AND its inviter is gone.
    expire(&f.pool, exp_inv).await;
    remove_member(&f.pool, f.org, f.owner_id).await;

    let r = post_accept(&f.server, Some(&exp_bearer), &exp_token).await;
    assert_eq!(
        r.status, 404,
        "an expired token must be indistinguishable from a wrong one, whatever ELSE is also \
         wrong with it: {}",
        r.text
    );
    assert_eq!(r.code(), INVALID_INVITATION, "{}", r.text);
    assert_eq!(role_of(&f.pool, f.org, exp_id).await, None);

    // ── POSITIVE CONTROL: neither condition, same request shape ──
    let r = post_accept(&f.server, Some(&ok_bearer), &ok_token).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(role_of(&f.pool, f.org, ok_id).await.as_deref(), Some("member"));
}

/// **Step 2 (the email binding) precedes step 3 (the ceiling re-check).**
///
/// This is the boundary that matters most for INV-9 and it was not probed at all before
/// FIX_ROUND-1. A valid, live, unexpired token presented by the WRONG logged-in user, whose
/// inviter has ALSO lost standing, must return the generic 404 — not the 403. The other way
/// round, a stranger holding a leaked link would learn from a 403 that the token is live,
/// which is precisely what "byte-identical for every miss" exists to hide.
///
/// **Same narrowing as the sibling above (FIX_ROUND-2, R2-8):** the binding is now evaluated
/// at step 1a, so this pins the OBSERVED precedence — the contract — rather than the order of
/// statements inside the transaction. The step-1a filter itself is pinned on the clock by
/// `inv9_no_miss_opens_a_transaction_so_the_404_is_indistinguishable_in_time`, and
/// the authoritative in-transaction binding is pinned by TEST-8's positive control.
///
/// Runs on BOTH builds.
#[tokio::test]
async fn the_email_binding_precedes_the_ceiling_recheck() {
    let f = fixture("i18e").await;
    // (No co-owner fixture here: nothing in this test removes the fixture owner, so a second
    // owner would be an inert step — FIX_ROUND-2, R2-7.)
    let (recipient_id, recipient_bearer) =
        invitee(&f, "i18e_rec", "i18e_rec@cyto.test").await;
    let (_stranger_id, stranger_bearer) = invitee(&f, "i18e_str", "i18e_str@cyto.test").await;
    let (inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i18e_rec@cyto.test",
        "owner",
    )
    .await;

    // The inviter loses standing: if step 3 ran first, the STRANGER below would get a 403.
    set_role(&f.pool, f.org, f.owner_id, "member").await;

    let r = post_accept(&f.server, Some(&stranger_bearer), &token).await;
    assert_eq!(
        r.status, 404,
        "a stranger holding a live token must get the GENERIC refusal, never a 403 that \
         confirms the token is live: {}",
        r.text
    );
    assert_eq!(r.code(), INVALID_INVITATION, "{}", r.text);
    assert!(
        !accepted_state(&f.pool, inv).await.0,
        "and the invitation is untouched"
    );

    // …and the byte-identity holds against a plain wrong token in the same conditions.
    let wrong = post_accept(
        &f.server,
        Some(&stranger_bearer),
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    )
    .await;
    assert_eq!(
        r.text, wrong.text,
        "a live-token-wrong-recipient refusal must be byte-identical to a wrong-token one \
         even when the inviter has ALSO lost standing"
    );

    // ── POSITIVE CONTROL: the RIGHT recipient, same conditions, reaches step 3 and is
    // refused THERE — proving the 404 above was the binding and not a dead route ──
    let r = post_accept(&f.server, Some(&recipient_bearer), &token).await;
    assert_eq!(
        r.status, 403,
        "the intended recipient DOES reach the ceiling re-check: {}",
        r.text
    );
    assert_eq!(r.code(), ROLE_ABOVE_ACTOR, "{}", r.text);
    assert_eq!(role_of(&f.pool, f.org, recipient_id).await, None);

    // …and with the inviter restored, the same recipient joins.
    set_role(&f.pool, f.org, f.owner_id, "owner").await;
    let r = post_accept(&f.server, Some(&recipient_bearer), &token).await;
    assert_eq!(r.status, 201, "positive control: {}", r.text);
    assert_eq!(
        role_of(&f.pool, f.org, recipient_id).await.as_deref(),
        Some("owner")
    );
}


// ===========================================================================
// TEST-15 [covers: ITEM-13]
// ===========================================================================
/// A successful accept fans a `SyncEntity::AccountMember` **create** frame to the account's
/// other members; a refused accept fans none.
///
/// The probe is opened as the account OWNER — a different principal from the redeemer — so
/// what is proven is FAN-OUT to the people who need to see a new colleague appear, not the
/// redeemer's own echo (which is suppressed by design: they already have the 201).
#[tokio::test]
async fn a_successful_accept_fans_an_account_member_frame_to_the_other_members() {
    use std::time::Duration;
    const WAIT: Duration = Duration::from_secs(10);

    let f = fixture("i15").await;
    let (id, bearer) = invitee(&f, "i15_new", "i15_new@cyto.test").await;
    let (_inv, token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i15_new@cyto.test",
        "member",
    )
    .await;

    // ── the DENY half first, on the SAME probe: a refused accept emits nothing ──
    let mut owner_probe =
        crate::common::sync_probe::SyncProbe::open(&f.server, &f.owner_token).await;
    // A refusal that ACTUALLY WROTE the membership and then rolled it back — the failure mode
    // worth testing here is a frame emitted for a write that did not survive (FIX_ROUND-2,
    // R2-11). FIX_ROUND-1 used the TOCTOU 403 for this, which a round-2 audit correctly
    // pointed out fires at step 3, BEFORE `add_member_in_tx` runs, so it did not exercise the
    // claim its own comment made. The injected ledger fault does: `add_member_in_tx` writes
    // `account_member_events` only after its `INSERT INTO account_members … RETURNING`
    // produced a row, so reaching the fault proves the membership existed inside the
    // transaction — and the probe must still hear nothing.
    let (_ref_id, ref_bearer) = invitee(&f, "i15_ref", "i15_ref@cyto.test").await;
    let (_ri, ref_token) = mint_invitation(
        &f.server,
        &f.owner_token,
        &f.pool,
        f.org,
        "i15_ref@cyto.test",
        "member",
    )
    .await;
    sqlx::query(
        "CREATE OR REPLACE FUNCTION cyto_test_sync_fault() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected fault after the membership insert'; END; \
         $$ LANGUAGE plpgsql",
    )
    .execute(&f.pool)
    .await
    .expect("create sync fault function");
    sqlx::query(&format!(
        "CREATE TRIGGER cyto_test_sync_fault BEFORE INSERT ON account_member_events \
         FOR EACH ROW WHEN (NEW.account_id = '{}') EXECUTE FUNCTION cyto_test_sync_fault()",
        f.org
    ))
    .execute(&f.pool)
    .await
    .expect("arm the sync fault trigger");

    let bad = post_accept(&f.server, Some(&ref_bearer), &ref_token).await;
    assert_eq!(
        bad.status, 500,
        "the injected fault must surface as a 500: {}",
        bad.text
    );
    assert_eq!(
        role_of(&f.pool, f.org, _ref_id).await,
        None,
        "…and the membership it wrote must have rolled back"
    );
    owner_probe.expect_silence(Duration::from_millis(750)).await;

    sqlx::query("DROP TRIGGER cyto_test_sync_fault ON account_member_events")
        .execute(&f.pool)
        .await
        .expect("disarm the sync fault trigger");

    // ── and the real one does ──
    let ok = post_accept(&f.server, Some(&bearer), &token).await;
    assert_eq!(ok.status, 201, "{}", ok.text);
    let frame = owner_probe
        .expect_event_for("account_member", "create", &f.org.to_string(), WAIT)
        .await;
    assert_eq!(
        frame.id,
        f.org.to_string(),
        "the wire id is the ACCOUNT — the client refetches that account's members \
         (notify-and-refetch; no row data on the wire)"
    );
    assert_eq!(role_of(&f.pool, f.org, id).await.as_deref(), Some("member"));
}

// ===========================================================================
// TEST-16 [covers: ITEM-12]
// ===========================================================================
/// The generated clients really were regenerated, for BOTH specs (#50's two-client seam).
///
/// A regen that was never run — or run for only one client — is caught here rather than at
/// merge, where it costs a whole gate cycle.
#[test]
fn both_generated_clients_carry_the_accept_operation_and_its_types() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for (spec_path, types_path) in [
        (
            "../ui/openapi/openapi.json",
            "../ui/src/api-client/types.ts",
        ),
        (
            "../ui/openapi-saas/openapi.json",
            "../ui/src/api-client-saas/types.ts",
        ),
    ] {
        let spec: Value = serde_json::from_str(
            &std::fs::read_to_string(root.join(spec_path))
                .unwrap_or_else(|e| panic!("read {spec_path}: {e}")),
        )
        .unwrap_or_else(|e| panic!("parse {spec_path}: {e}"));
        let op = &spec["paths"]["/api/account-invitations/accept"]["post"];
        assert_eq!(
            op["operationId"], "Account.acceptInvitation",
            "{spec_path}: the operation id drives the `ApiClient.Account.*` codegen and \
             must stay stable"
        );
        assert!(
            op["responses"]["201"].is_object(),
            "{spec_path}: the 201 (joined) response must be declared"
        );
        assert!(
            op["responses"]["200"].is_object(),
            "{spec_path}: the 200 (already a member) response must be declared"
        );

        let types = std::fs::read_to_string(root.join(types_path))
            .unwrap_or_else(|e| panic!("read {types_path}: {e}"));
        for ty in ["AcceptInvitationRequest", "AcceptInvitationResponse"] {
            assert!(
                types.contains(ty),
                "{types_path}: missing `{ty}` — run `just openapi-regen` and commit BOTH \
                 generated clients"
            );
        }
    }
}

// A `#[test]` that only had to COMPILE — three `let _ =` bindings naming the seam types —
// was removed in FIX_ROUND-1 (R1-10). It asserted nothing at runtime yet counted as a
// passing test in every report, which is exactly the inflation this suite polices elsewhere.
// The compile-time property it claimed is already guaranteed: every test above CALLS the
// route and the repository seam, so a rename is a compile error anyway.
