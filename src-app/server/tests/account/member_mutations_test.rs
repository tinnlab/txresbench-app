//! #142 — the self-service member-mutation A9 DENY SUITE (epic #138).
//!
//! Routes under test, all mounted on `AccountScope<Min>`:
//!
//! | route | `Min` |
//! |---|---|
//! | `PATCH  /api/accounts/{account_id}/members/{user_id}` | `RoleAdmin` |
//! | `DELETE /api/accounts/{account_id}/members/{user_id}` | `RoleAdmin` |
//! | `POST   /api/accounts/{account_id}/members/leave`     | `SelfMembership` |
//!
//! **Every refusal here is paired with a positive control in the SAME body**, and every
//! arm is asserted on POPULATED state — real accounts with real members at real roles —
//! then re-queried at the DB afterwards. A two-arm test whose arms are both empty is
//! structurally incapable of failing; so is a refusal that "passed" against a build
//! where the whole route was broken. The DB re-query is what distinguishes "refused"
//! from "refused after already writing".
//!
//! Error CODES are asserted by name, never by status alone: `LAST_OWNER`,
//! `PERSONAL_ACCOUNT_NOT_MANAGEABLE` are both 422 from these same functions, and
//! `ACCOUNT_MEMBERS_MANAGE_REQUIRED`, `INSUFFICIENT_ACCOUNT_ROLE`, `ROLE_ABOVE_ACTOR`
//! are all 403.

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::account::{AccountRepository, AccountRole, ActorCeiling};
use txresbench::modules::project::ProjectRepository;

use crate::account::{
    add_member, create_user, login, make_org_account, move_project_to_account, pool_for,
    setup_admin, USERS_GROUP_ID,
};
use crate::common::TestServer;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// `PATCH /api/accounts/{account}/members/{user}` with an optional `X-Account-Id`
/// header (which this surface must IGNORE — DEC-1). Returns `(status, body)`.
async fn patch_role(
    server: &TestServer,
    token: &str,
    account: &str,
    user: Uuid,
    role: &str,
    header_account: Option<Uuid>,
) -> (u16, Value) {
    let mut req = server
        .client
        .patch(server.api_url(&format!("/accounts/{account}/members/{user}")))
        .bearer_auth(token)
        .json(&json!({ "role": role }));
    if let Some(h) = header_account {
        req = req.header("X-Account-Id", h.to_string());
    }
    let resp = req.send().await.expect("patch role request");
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

/// `DELETE /api/accounts/{account}/members/{user}`.
async fn delete_member(
    server: &TestServer,
    token: &str,
    account: &str,
    user: Uuid,
    header_account: Option<Uuid>,
) -> (u16, Value) {
    let mut req = server
        .client
        .delete(server.api_url(&format!("/accounts/{account}/members/{user}")))
        .bearer_auth(token);
    if let Some(h) = header_account {
        req = req.header("X-Account-Id", h.to_string());
    }
    let resp = req.send().await.expect("delete member request");
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

/// `POST /api/accounts/{account}/members/leave`.
async fn leave(
    server: &TestServer,
    token: &str,
    account: &str,
    header_account: Option<Uuid>,
) -> (u16, Value) {
    leave_from(server, token, account, header_account, None).await
}

/// `leave`, stamping `X-Sync-Connection-Id` so the SELF-ECHO SUPPRESSION decisions are
/// observable.
///
/// Without this the suite could not tell either `origin` decision from its opposite:
/// `Actor::connection` is read from that header, no helper sent it, so
/// `actor.connection` was `None` on every request and both
/// `notify_departed_member`'s stamp and `fan_cancelled_transfers`' deliberate NON-stamp
/// were byte-identical to their reverts at runtime. A blind audit caught that the branch's
/// most-argued-over production change was invisible to every test in the file.
async fn leave_from(
    server: &TestServer,
    token: &str,
    account: &str,
    header_account: Option<Uuid>,
    connection: Option<Uuid>,
) -> (u16, Value) {
    let mut req = server
        .client
        .post(server.api_url(&format!("/accounts/{account}/members/leave")))
        .bearer_auth(token);
    if let Some(h) = header_account {
        req = req.header("X-Account-Id", h.to_string());
    }
    if let Some(c) = connection {
        req = req.header("X-Sync-Connection-Id", c.to_string());
    }
    let resp = req.send().await.expect("leave request");
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

/// The refusal CODE carried by an error body, under either spelling the API uses.
fn code_of(body: &Value) -> Option<&str> {
    body["error_code"].as_str().or(body["code"].as_str())
}

/// `user`'s role string in `account`, or `None` if they are not a member.
async fn role_of(pool: &SqlitePool, account: Uuid, user: Uuid) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(account)
    .bind(user)
    .fetch_optional(pool)
    .await
    .expect("read membership role")
}

async fn member_count(pool: &SqlitePool, account: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM account_members WHERE account_id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("count members")
}

async fn owner_count(pool: &SqlitePool, account: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM account_members WHERE account_id = $1 AND role = 'owner'",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .expect("count owners")
}

async fn personal_account_id(pool: &SqlitePool, user_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("personal account exists")
}

/// Revoke `account::members::manage` from the `Users` group — the EXACT operator
/// action #139 describes as the kill switch ("granting/revoking it on the Users group
/// turns self-service on/off deployment-wide"), and the deployment state #232 says no
/// test in this epic has ever entered.
async fn revoke_manage_capability_deployment_wide(pool: &SqlitePool) {
    // SQLite port: PG's `array_remove(permissions, …)` has no SQLite form — `permissions`
    // is a JSON-array TEXT column here, so the element is filtered through `json_each` and
    // rebuilt with `json_group_array` (the JSON1 rewrites this chain uses throughout).
    // `groups.id` is a BLOB (app-bound surrogate, DEC-12), so the string constant must be
    // parsed before the bind.
    let updated = sqlx::query(
        "UPDATE groups SET permissions = (\
             SELECT COALESCE(json_group_array(value), '[]') \
             FROM json_each((SELECT permissions FROM groups WHERE id = $1)) \
             WHERE value <> 'account::members::manage'\
         ) WHERE id = $1",
    )
    .bind(USERS_GROUP_ID.parse::<uuid::Uuid>().expect("users group uuid"))
    .bind(USERS_GROUP_ID.parse::<uuid::Uuid>().expect("users group uuid"))
    .execute(pool)
    .await
    .expect("revoke the manage capability");
    assert_eq!(updated.rows_affected(), 1, "the Users group row was updated");

    let still_held: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM json_each(permissions) WHERE value = 'account::members::manage') FROM groups WHERE id = $1",
    )
    .bind(USERS_GROUP_ID.parse::<uuid::Uuid>().expect("users group uuid"))
    .fetch_one(pool)
    .await
    .expect("re-read Users group perms");
    assert!(!still_held, "precondition: the capability really is gone");
}

/// A pool of its own for the barrier tests.
///
/// The shared `pool_for` helper is `max_connections(4)`, and a two-contender barrier needs
/// four at once (the holder, both transactions, and the poller) — zero headroom, so one
/// extra held connection would turn the test into a 30s acquire timeout rather than a
/// lock message. Widened HERE rather than in `tests/account/mod.rs`, because that helper
/// is shared infrastructure and changing it to suit one branch's tests is exactly the
/// workaround that breaks everyone else.
async fn barrier_pool(server: &TestServer) -> SqlitePool {
    sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(12)
        .connect(server.database_url())
        .await
        .expect("connect barrier pool")
}

/// The SQLite port of the PG barrier (record): Postgres's `pg_blocking_pids`
/// wait-for closure has no SQLite form, and a contended write on the single
/// SQLite write lock exposes no queue-observation surface. The port is a signal
/// handshake: every contender sends `()` on `sig` IMMEDIATELY BEFORE issuing its
/// transaction, then [`wait_parked`] polls the handle until it is provably parked
/// at the write lock. The bound sits at 4 s, a second under sqlx-sqlite's default
/// 5 s busy_timeout, so a contender that errored (rather than parked) is caught by
/// the finished check, and a contender starved of CPU by the loaded box still has
/// the full 4 s to reach the busy-handler. The arm is model-exact on the other
/// side too: a finished contender while the barrier is open means it never
/// contended at all (its transaction completed without the write lock), so the
/// finished check is the tautology guard, not the pass condition.
const BUSY_BARRIER_POLLS: u32 = 40; // 40 x 100 ms
const BUSY_BARRIER_POLL_STEP: std::time::Duration = std::time::Duration::from_millis(100);

async fn barrier_reached(sig: &mut tokio::sync::mpsc::Receiver<()>, n: usize) {
    for _ in 0..n {
        sig.recv()
            .await
            .expect("contender signalled JUST before its write-lock transaction");
    }
}

/// Prove the contender is parked at the write lock: it has not finished while the
/// barrier holder's transaction is open. See [`barrier_reached`].
async fn wait_parked<T>(
    h: &tokio::task::JoinHandle<T>,
    what: &str,
) {
    for _ in 0..BUSY_BARRIER_POLLS {
        if h.is_finished() {
            panic!(
                "{what}: the contender FINISHED while the barrier held the write lock — \
                 it either never contended (a mutation that bypasses the transaction is \
                 exactly the guard this arm exists to catch) or errored out of its \
                 busy-wait. Parked-contention assertion failed"
            );
        }
        tokio::time::sleep(BUSY_BARRIER_POLL_STEP).await;
    }
}

/// Prove BOTH contenders are parked simultaneously — the two-handle arm of
/// [`wait_parked`]. Sequential 4 s windows do NOT work here: both contenders queue
/// on the same write lock and share the same 5 s busy_timeout budget, so the second
/// one's wait would expire inside the first one's poll window and finish with an
/// error (`the contender FINISHED`) for the WRONG reason. This polls both handles in
/// one loop and stops as soon as each has been observed parked for a short
/// consecutive run — the whole proof finishes in well under the busy timeout.
async fn wait_both_parked<T>(
    h1: &tokio::task::JoinHandle<T>,
    h2: &tokio::task::JoinHandle<T>,
    what: &str,
) {
    let mut parked1 = 0u32;
    let mut parked2 = 0u32;
    for _ in 0..BUSY_BARRIER_POLLS {
        for (h, parked) in [(&h1, &mut parked1), (&h2, &mut parked2)] {
            if h.is_finished() {
                panic!(
                    "{what}: a contender FINISHED while the barrier held the write lock \
                     — it either never contended (a mutation that bypasses the \
                     transaction is exactly the guard this arm exists to catch) or \
                     errored out of its busy-wait. Parked-contention assertion failed"
                );
            }
            *parked += 1;
        }
        if parked1 >= 5 && parked2 >= 5 {
            return;
        }
        tokio::time::sleep(BUSY_BARRIER_POLL_STEP).await;
    }
    panic!("{what}: contenders not provably parked within the bounded poll window");
}

/// Open the barrier transaction: the single SQLite write lock, taken at
/// `BEGIN IMMEDIATE` (the substitution for PG's `FOR UPDATE` on the account's
/// owner rows — with one isolation model the lock is global, not per-row, which
/// is also what makes a *concurrent* mid-barrier write impossible and drives the
/// port of the demotion arms in `the_ceiling_is_read_after_the_owner_lock_not_before`).
/// Callers pass it to `replace_role_of`-style mid-barrier writes to bundle them
/// into the same transaction (see that test's port note).
async fn hold_owner_lock(
    pool: &SqlitePool,
    account: Uuid,
) -> sqlx::Transaction<'static, sqlx::Sqlite> {
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .expect("barrier tx (write intent)");
    // Forces the write lock at the OPEN (a plain read would not take it).
    sqlx::query(
        "UPDATE account_members SET role = role WHERE account_id = $1 AND role = 'owner'",
    )
    .bind(account)
    .execute(&mut *tx)
    .await
    .expect("hold the owner lock");
    tx
}

/// Seed a PENDING `project_transfers` row directly (the `transfer_escape_test.rs`
/// idiom) — used to observe #171's in-transaction offboarding hook.
async fn seed_pending_transfer(pool: &SqlitePool, project: Uuid, from: Uuid, to: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO project_transfers (id, project_id, from_user_id, to_user_id, status) \
         VALUES ($1, $2, $3, $4, 'pending')",
    )
    .bind(id)
    .bind(project)
    .bind(from)
    .bind(to)
    .execute(pool)
    .await
    .expect("seed pending transfer");
    id
}

async fn transfer_status(pool: &SqlitePool, id: Uuid) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT status FROM project_transfers WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .expect("read transfer status")
}

// ---------------------------------------------------------------------------
// TEST-3 [covers: ITEM-6, ITEM-13] — PATCH happy path, both allowed ranks
// ---------------------------------------------------------------------------

/// The positive baseline the whole suite rests on: the route WORKS. Two allowed rank pairings,
/// including the EQUAL-rank one (`admin` promotes to `admin`), which is the boundary
/// R-1's strict `>` must not swallow — a guard written with `>=` fails here, and R-4's
/// two-step ownership transfer would become impossible.
#[tokio::test]
async fn patch_role_promotes_a_member_for_owner_and_for_admin() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "hp_own", "hp_own@txresbench.test").await;
    let actor_admin = create_user(&server, &admin_token, "hp_adm", "hp_adm@txresbench.test").await;
    let m1 = create_user(&server, &admin_token, "hp_m1", "hp_m1@txresbench.test").await;
    let m2 = create_user(&server, &admin_token, "hp_m2", "hp_m2@txresbench.test").await;

    let org = make_org_account(&pool, "HP Org", owner).await;
    add_member(&pool, org, actor_admin, "admin").await;
    add_member(&pool, org, m1, "member").await;
    add_member(&pool, org, m2, "member").await;

    // ── an OWNER promotes a member to admin ⇒ 200, and the row really changed ──
    let owner_token = login(&server, "hp_own").await;
    let (status, body) = patch_role(&server, &owner_token, &org.to_string(), m1, "admin", None).await;
    assert_eq!(status, 200, "owner may promote a member to admin: {body}");
    assert_eq!(body["role"].as_str(), Some("admin"), "the response body: {body}");
    assert_eq!(body["user_id"].as_str(), Some(m1.to_string().as_str()));
    assert_eq!(
        role_of(&pool, org, m1).await.as_deref(),
        Some("admin"),
        "and the DB row really changed"
    );

    // ── an ADMIN promotes a member to admin (EQUAL rank) ⇒ 200 ──
    let admin_actor_token = login(&server, "hp_adm").await;
    let (status, body) =
        patch_role(&server, &admin_actor_token, &org.to_string(), m2, "admin", None).await;
    assert_eq!(
        status, 200,
        "R-1 allows the EQUAL rank — `<= actor_role`, not `< actor_role`: {body}"
    );
    assert_eq!(role_of(&pool, org, m2).await.as_deref(), Some("admin"));
}

// ---------------------------------------------------------------------------
// TEST-4 [acceptance] [invariant: INV-5] [covers: ITEM-1, ITEM-2, ITEM-6, ITEM-7, ITEM-13]
// ---------------------------------------------------------------------------

/// INV-5 — **no escalation above your own role**, all four deny cases the design
/// enumerates, in one body, on a populated org, with the positive control the design
/// also names and a DB re-query proving nothing was written.
///
/// > For any membership mutation, **both** the target's **current** role **and** the
/// > **requested new** role must be `<= actor_role`.
///
/// The four cases are chosen to hit each half of that rule separately:
///   1. admin → `owner` on ANOTHER member — the REQUESTED half;
///   2. admin → `owner` on THEMSELVES — the same half, but self-targeting, which is
///      where guards acquire an accidental early return;
///   3. admin DELETEs an `owner` — the CURRENT half, with no requested role at all;
///   4. admin demotes an `owner` to `member` — the CURRENT half while the requested
///      role is perfectly legal, so a guard that checked only `requested` allows it.
///
/// Under DEC-12 case 1 is not a title change: an account Owner holds delete, transfer
/// and share over every project in the tenant, including ones they never created.
#[tokio::test]
async fn inv5_admin_cannot_reach_above_their_own_role_on_any_route() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "es_own", "es_own@txresbench.test").await;
    let actor = create_user(&server, &admin_token, "es_adm", "es_adm@txresbench.test").await;
    let plain = create_user(&server, &admin_token, "es_mem", "es_mem@txresbench.test").await;

    let org = make_org_account(&pool, "Escalation Org", owner).await;
    add_member(&pool, org, actor, "admin").await;
    add_member(&pool, org, plain, "member").await;
    let acct = org.to_string();

    let token = login(&server, "es_adm").await;

    // 1 — mint an owner out of another member.
    let (status, body) = patch_role(&server, &token, &acct, plain, "owner", None).await;
    assert_eq!(status, 403, "an admin may not mint an owner: {body}");
    assert_eq!(
        code_of(&body),
        Some("ROLE_ABOVE_ACTOR"),
        "named refusal — INSUFFICIENT_ACCOUNT_ROLE is also a 403 here: {body}"
    );

    // 2 — mint an owner out of THEMSELVES.
    let (status, body) = patch_role(&server, &token, &acct, actor, "owner", None).await;
    assert_eq!(
        status, 403,
        "self-targeting is the same rule, and gets its own case because it is where a \
         guard acquires an accidental early return: {body}"
    );
    assert_eq!(code_of(&body), Some("ROLE_ABOVE_ACTOR"));

    // 3 — evict an owner (removal: only the CURRENT role can offend).
    let (status, body) = delete_member(&server, &token, &acct, owner, None).await;
    assert_eq!(status, 403, "an admin may not evict an owner: {body}");
    assert_eq!(code_of(&body), Some("ROLE_ABOVE_ACTOR"));

    // 4 — demote an owner (the requested role is legal; the CURRENT one is not).
    let (status, body) = patch_role(&server, &token, &acct, owner, "member", None).await;
    assert_eq!(
        status, 403,
        "a guard that checked only the REQUESTED role would allow this — and an admin \
         could then demote every owner and be promoted by an accomplice: {body}"
    );
    assert_eq!(code_of(&body), Some("ROLE_ABOVE_ACTOR"));

    // ── POSITIVE CONTROL: the same actor, same token, a mutation at their own rank ──
    let (status, body) = patch_role(&server, &token, &acct, plain, "admin", None).await;
    assert_eq!(
        status, 200,
        "the same admin CAN promote a member to admin — so the four 403s above are the \
         ceiling, not a broken session or a dead route: {body}"
    );

    // ── and nothing above the ceiling moved ──
    assert_eq!(
        role_of(&pool, org, owner).await.as_deref(),
        Some("owner"),
        "the owner is still an owner, and still a member: refused BEFORE any write"
    );
    assert_eq!(
        role_of(&pool, org, actor).await.as_deref(),
        Some("admin"),
        "the actor did not promote themselves"
    );
    assert_eq!(member_count(&pool, org).await, 3, "nobody was removed");
}

// ---------------------------------------------------------------------------
// TEST-5 [acceptance] [invariant: INV-7] [covers: ITEM-2, ITEM-6, ITEM-7, ITEM-8, ITEM-13]
// ---------------------------------------------------------------------------

/// INV-7 — **the last owner is protected, on every path including `leave`.**
///
/// All three self-service exits are driven by the SOLE owner against themselves, and
/// each must be refused by `LAST_OWNER` — not by R-1, and not by a 404. That is the
/// trap this test exists to catch: a sole Owner satisfies the `Admin` floor, so the
/// extractor ADMITS the request, and the repository's owner count is what must refuse
/// it. A "friendlier" early return in the escalation guard would produce a 403 here
/// and this test would go red.
///
/// The positive control is the design's own: with two owners, one leaves ⇒ 204 and the
/// account still has an owner.
#[tokio::test]
async fn inv7_last_owner_is_protected_on_leave_demote_and_remove() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "lo_own", "lo_own@txresbench.test").await;
    let plain = create_user(&server, &admin_token, "lo_mem", "lo_mem@txresbench.test").await;

    let org = make_org_account(&pool, "Last Owner Org", owner).await;
    add_member(&pool, org, plain, "member").await;
    let acct = org.to_string();
    let token = login(&server, "lo_own").await;

    assert_eq!(owner_count(&pool, org).await, 1, "precondition: ONE owner");

    // 1 — leave.
    let (status, body) = leave(&server, &token, &acct, None).await;
    assert_eq!(status, 422, "the sole owner may not walk out: {body}");
    assert_eq!(
        code_of(&body),
        Some("LAST_OWNER"),
        "and it must be LAST_OWNER by NAME — PERSONAL_ACCOUNT_NOT_MANAGEABLE is also a \
         422 from these same functions, so the status does not identify it: {body}"
    );

    // 2 — self-demote.
    let (status, body) = patch_role(&server, &token, &acct, owner, "admin", None).await;
    assert_eq!(status, 422, "the sole owner may not demote themselves: {body}");
    assert_eq!(
        code_of(&body),
        Some("LAST_OWNER"),
        "the escalation guard must NOT answer here — the actor is at their own ceiling \
         on both halves, so the owner COUNT is what refuses: {body}"
    );

    // 3 — self-remove through the DELETE route.
    let (status, body) = delete_member(&server, &token, &acct, owner, None).await;
    assert_eq!(status, 422, "and not through the DELETE route either: {body}");
    assert_eq!(code_of(&body), Some("LAST_OWNER"));

    assert_eq!(
        role_of(&pool, org, owner).await.as_deref(),
        Some("owner"),
        "three refusals, nothing written"
    );

    // ── the OTHER reading of INV-7's third case, asserted so the reinterpretation is
    //    visible rather than inferred. The design says "sole owner is DELETEd ⇒ 422
    //    LAST_OWNER". Because R-1 is graded BEFORE the owner count (DEC-5), an ADMIN
    //    aiming at that same sole owner never reaches the count — they are refused 403
    //    `ROLE_ABOVE_ACTOR` for reaching above their own rank. Both refusals are correct
    //    and they are different guards; pinning both is what stops a later reordering
    //    silently swapping them.
    let helper_admin = create_user(&server, &admin_token, "lo_adm", "lo_adm@txresbench.test").await;
    add_member(&pool, org, helper_admin, "admin").await;
    let admin_actor_token = login(&server, "lo_adm").await;
    let (status, body) = delete_member(&server, &admin_actor_token, &acct, owner, None).await;
    assert_eq!(status, 403, "an admin aiming at the sole owner: {body}");
    assert_eq!(
        code_of(&body),
        Some("ROLE_ABOVE_ACTOR"),
        "the ESCALATION guard answers first for an admin — the sole-owner 422 is only \
         reachable by the owner acting on themselves: {body}"
    );
    assert_eq!(
        role_of(&pool, org, owner).await.as_deref(),
        Some("owner"),
        "and the refused DELETE wrote nothing"
    );

    // ── POSITIVE CONTROL: a SECOND owner exists ⇒ the same call now succeeds ──
    let second = create_user(&server, &admin_token, "lo_own2", "lo_own2@txresbench.test").await;
    add_member(&pool, org, second, "owner").await;
    assert_eq!(owner_count(&pool, org).await, 2);

    let (status, body) = leave(&server, &token, &acct, None).await;
    assert_eq!(
        status, 204,
        "with a second owner present, leaving is allowed: {body}"
    );
    assert_eq!(role_of(&pool, org, owner).await, None, "the membership is gone");
    assert_eq!(
        owner_count(&pool, org).await,
        1,
        "and the account still has an owner — the invariant the guard exists for"
    );
}

// ---------------------------------------------------------------------------
// TEST-6 [covers: ITEM-2, ITEM-8, ITEM-13] — the INV-7 RACE case
// ---------------------------------------------------------------------------

/// Two owners, each concurrently removing the other. Exactly one may win, and the
/// account is never left ownerless.
///
/// Driven at BOTH levels on purpose, because they answer different questions and the
/// HTTP level alone cannot reach the guard the design names.
///
/// **Arm 1, the repository** — two concurrent `remove_member` calls under
/// `PlatformStaff`. This is the design's literal race case and it reaches the
/// `SELECT … role='owner' FOR UPDATE`-then-count serialization: exactly one `Ok`, one
/// `LAST_OWNER`, owner count 1.
///
/// It does **not** prove anything about the escalation guard — an earlier version of this
/// comment claimed it did, which was false: `PlatformStaff` makes `resolve_ceiling`
/// return `Ok(None)` before touching the database, so R-1 is never reached on this arm.
/// The guard's own ordering is proven by
/// `the_ceiling_is_read_after_the_owner_lock_not_before`, which is a real contention test.
///
/// **Arm 1 is made deterministic by an external lock holder** rather than by hoping the
/// two tasks interleave. Without it, a run in which task 1 commits before task 2 first
/// polls its `SELECT` passes even with `FOR UPDATE` deleted — i.e. the correct build is
/// deterministic and the broken one is not, which is the wrong way round for a race test.
/// A third transaction holds the account's owner rows until both mutations are observably
/// blocked BY THAT TRANSACTION (`pg_blocking_pids`), then releases.
///
/// **Arm 2 is not barriered, deliberately**, and an earlier version of this comment
/// wrongly said it was. The HTTP path runs the whole extractor before reaching the
/// repository, so parking it on the owner lock proves nothing extra; and its assertions
/// hold under every interleaving, because the winner's commit is what makes the loser a
/// non-member. Arm 2 is a claim about the SURFACE's answer, not about the locking.
///
/// **Arm 2, the HTTP routes** — the same race through `DELETE …/members/{user_id}`.
/// Here the LOSER is, by construction, the person the winner just removed, so by the
/// time their mutation runs they are no longer a member and the honest answer is the
/// seam's non-member **404**, not `LAST_OWNER`: telling a just-removed principal "this
/// account has exactly one owner" would leak account state to someone who is no longer
/// in it. The integrity outcome — exactly one success, owner count 1 — is identical,
/// and it is the integrity outcome INV-7 is actually about. Recorded as DRIFT-1.1 and
/// flagged for #150: its race row should assert the integrity outcome plus "the loser
/// is refused", not the specific 422, or it will encode an unreachable state.
#[tokio::test]
async fn inv7_two_concurrent_owner_removals_leave_exactly_one_owner() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // ── ARM 1: the repository, where LAST_OWNER is the answer ──
    let a = create_user(&server, &admin_token, "rc_a", "rc_a@txresbench.test").await;
    let b = create_user(&server, &admin_token, "rc_b", "rc_b@txresbench.test").await;
    let repo_org = make_org_account(&pool, "Race Repo Org", a).await;
    add_member(&pool, repo_org, b, "owner").await;
    assert_eq!(owner_count(&pool, repo_org).await, 2, "precondition: TWO owners");

    // The barrier: hold the single write lock so neither mutation can pass its own
    // `BEGIN IMMEDIATE`, park both there (signal handshake — the port of the
    // `pg_blocking_pids` poll, recorded on `barrier_reached`), then release.
    let bpool = barrier_pool(&server).await;
    let holder = hold_owner_lock(&bpool, repo_org).await;

    let r1 = AccountRepository::new(bpool.clone());
    let r2 = AccountRepository::new(bpool.clone());
    let (sig_tx, mut sig_rx) = tokio::sync::mpsc::channel(2);
    let sig_tx1 = sig_tx.clone();
    let t1 = tokio::spawn(async move {
        sig_tx1.send(()).await.expect("signal removal 1");
        r1.remove_member(repo_org, b, super::staff_ceiling()).await
    });
    let t2 = tokio::spawn(async move {
        sig_tx.send(()).await.expect("signal removal 2");
        r2.remove_member(repo_org, a, super::staff_ceiling()).await
    });
    // Both are parked at the barrier's write lock — verified, not assumed. The
    // two-handle proof (not two sequential windows) is deliberate: both contenders
    // share one 5 s busy_timeout, and sequential 4 s windows would let the second
    // one expire inside the first one's (see `wait_both_parked`).
    barrier_reached(&mut sig_rx, 2).await;
    wait_both_parked(&t1, &t2, "two concurrent owner removals").await;
    holder.commit().await.expect("release the barrier");

    let (o1, o2) = tokio::join!(t1, t2);
    let results = [o1.expect("join 1"), o2.expect("join 2")];
    let wins = results.iter().filter(|r| r.is_ok()).count();
    assert_eq!(wins, 1, "exactly one removal may commit: {results:?}");
    let refusal = results
        .iter()
        .find_map(|r| r.as_ref().err())
        .expect("one refusal");
    assert!(
        format!("{refusal:?}").contains("LAST_OWNER"),
        "the loser is refused by the race-safe owner-count guard, reached (not \
         duplicated) through the new ceiling parameter: {refusal:?}"
    );
    assert_eq!(
        owner_count(&pool, repo_org).await,
        1,
        "the account is never left ownerless"
    );

    // ── ARM 2: the HTTP routes, where the loser has themselves been removed ──
    let c = create_user(&server, &admin_token, "rc_c", "rc_c@txresbench.test").await;
    let d = create_user(&server, &admin_token, "rc_d", "rc_d@txresbench.test").await;
    let http_org = make_org_account(&pool, "Race Http Org", c).await;
    add_member(&pool, http_org, d, "owner").await;
    assert_eq!(owner_count(&pool, http_org).await, 2);

    let tc = login(&server, "rc_c").await;
    let td = login(&server, "rc_d").await;
    let acct = http_org.to_string();
    let (rc, rd) = tokio::join!(
        delete_member(&server, &tc, &acct, d, None),
        delete_member(&server, &td, &acct, c, None),
    );
    let statuses = [rc.0, rd.0];
    let loser_body = if rc.0 == 204 { &rd.1 } else { &rc.1 };
    assert_eq!(
        statuses.iter().filter(|s| **s == 204).count(),
        1,
        "exactly one removal may commit: got {statuses:?} (bodies {:?} / {:?})",
        rc.1,
        rd.1
    );
    let loser = if rc.0 == 204 { rd.0 } else { rc.0 };
    assert!(
        (400..500).contains(&loser),
        "and the other is REFUSED, not silently accepted: {statuses:?}"
    );
    assert_eq!(
        loser, 404,
        "specifically the seam's non-member 404 — the loser was removed by the winner \
         before their own mutation ran, so they are no longer a member and the account \
         must be invisible to them (a 422 LAST_OWNER here would report account state to \
         a non-member). See DRIFT-1.1."
    );
    // The 404 can legitimately come from EITHER of two places, depending on whether the
    // loser's extractor ran before or after the winner committed: `AccountScope` step 4
    // (`Account not found`) or `resolve_ceiling`'s vanished-actor guard (also
    // `Account not found`). Both are the same body BY DESIGN — that identity is the
    // anti-oracle property — so asserting the body pins that they have not diverged,
    // which a bare status assertion could not see.
    assert_eq!(
        loser_body["error_code"].as_str(),
        Some("RESOURCE_NOT_FOUND"),
        "and it is the ordinary not-found body, not some third refusal: {loser_body}"
    );
    assert_eq!(
        owner_count(&pool, http_org).await,
        1,
        "same integrity outcome as arm 1: never ownerless"
    );
}

// ---------------------------------------------------------------------------
// TEST-7 [acceptance] [invariant: INV-R2] [covers: ITEM-8, ITEM-13]
// ---------------------------------------------------------------------------

/// INV-R2 — **`leave` routes through `AccountRepository::remove_member`**, not a new
/// `DELETE … WHERE user_id = me`.
///
/// Asserted BEHAVIOURALLY, from outside, by two side effects that live only inside
/// `remove_member`'s transaction and that a hand-rolled delete could not produce:
///
///   (a) the sole owner's `leave` is refused with `LAST_OWNER`; and
///   (b) a departing member's PENDING project transfer on this account's project is
///       CANCELLED by the leave — #171's offboarding hook.
///
/// The positive control for (b) is a pending transfer on a DIFFERENT account's project,
/// which must survive: it proves the cancellation is scoped by account (the hook's own
/// contract) rather than being a blanket "delete this user's transfers".
#[tokio::test]
async fn invr2_leave_goes_through_remove_member_and_fires_the_offboarding_hook() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "rt_own", "rt_own@txresbench.test").await;
    let leaver = create_user(&server, &admin_token, "rt_lv", "rt_lv@txresbench.test").await;
    let outsider = create_user(&server, &admin_token, "rt_out", "rt_out@txresbench.test").await;

    let org = make_org_account(&pool, "Route Org", owner).await;
    add_member(&pool, org, leaver, "member").await;
    // A SECOND, unrelated org the leaver also belongs to — the scoping control.
    let other_org = make_org_account(&pool, "Other Org", owner).await;
    add_member(&pool, other_org, leaver, "member").await;

    let projects = ProjectRepository::new(pool.clone());
    let p_here = projects.create(leaver, "here", "").await.unwrap().id;
    move_project_to_account(&pool, p_here, org).await;
    let p_elsewhere = projects.create(leaver, "elsewhere", "").await.unwrap().id;
    move_project_to_account(&pool, p_elsewhere, other_org).await;

    let t_here = seed_pending_transfer(&pool, p_here, leaver, outsider).await;
    let t_elsewhere = seed_pending_transfer(&pool, p_elsewhere, leaver, outsider).await;

    // ── (a) the sole owner cannot leave — only `remove_member`'s guard says this ──
    let owner_token = login(&server, "rt_own").await;
    let (status, body) = leave(&server, &owner_token, &org.to_string(), None).await;
    assert_eq!(status, 422, "sole owner: {body}");
    assert_eq!(
        code_of(&body),
        Some("LAST_OWNER"),
        "a bare `DELETE … WHERE user_id = me` cannot produce this refusal at all: {body}"
    );

    // ── (b) the leaver's leave fires the offboarding hook ──
    let leaver_token = login(&server, "rt_lv").await;
    let (status, body) = leave(&server, &leaver_token, &org.to_string(), None).await;
    assert_eq!(status, 204, "a bare member may leave: {body}");
    assert_eq!(role_of(&pool, org, leaver).await, None, "membership gone");
    assert_eq!(
        transfer_status(&pool, t_here).await,
        None,
        "the pending transfer on THIS account's project was cancelled inside the same \
         transaction — the #171 hook, which lives only in `remove_member`"
    );

    // ── POSITIVE CONTROL for the scoping: the other account's transfer survives ──
    assert_eq!(
        transfer_status(&pool, t_elsewhere).await.as_deref(),
        Some("pending"),
        "the hook cancels this ACCOUNT's transfers, not every transfer the user has — \
         so the assertion above is about scope, not about a blanket delete"
    );
    assert_eq!(
        role_of(&pool, other_org, leaver).await.as_deref(),
        Some("member"),
        "and the leaver is still a member of the other account"
    );
}

// ---------------------------------------------------------------------------
// TEST-8 [acceptance] [invariant: INV-R4] [covers: ITEM-6, ITEM-10, ITEM-13]
// ---------------------------------------------------------------------------

/// INV-R4 — **ownership transfer needs no new endpoint**: promote-then-demote, in that
/// order, through the one PATCH route.
///
/// Three things are asserted, and the third is the one that stops the invariant rotting:
///   1. the two-step works, including the legitimate intermediate TWO-OWNER state;
///   2. the naive order (demote first) is refused with `LAST_OWNER` — which is exactly
///      why the order has to be documented, since it reads as a bug otherwise;
///   3. the SHIPPED OpenAPI description actually documents it, and carries the DEC-12
///      consent sentence #140 lost and the re-scope transferred into this item.
///
/// (3) reads the generated `openapi.json` rather than the Rust source, so it fails if
/// the description is rewritten and regenerated — the way prose silently rots. The
/// merge-gate's C3 regen-parity check is what keeps the file in step with the source.
#[tokio::test]
async fn invr4_ownership_transfers_via_two_patches_and_is_documented() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "tr_own", "tr_own@txresbench.test").await;
    let heir = create_user(&server, &admin_token, "tr_hei", "tr_hei@txresbench.test").await;
    let org = make_org_account(&pool, "Transfer Org", owner).await;
    add_member(&pool, org, heir, "member").await;
    let acct = org.to_string();
    let token = login(&server, "tr_own").await;

    // ── 2. the WRONG order first, while there is still one owner ──
    let (status, body) = patch_role(&server, &token, &acct, owner, "admin", None).await;
    assert_eq!(
        status, 422,
        "demote-then-promote is correctly refused, which is why the right order must be \
         documented rather than left for users to invent: {body}"
    );
    assert_eq!(code_of(&body), Some("LAST_OWNER"));

    // ── 1. the right order: promote the heir ⇒ two owners (legitimate) ──
    let (status, body) = patch_role(&server, &token, &acct, heir, "owner", None).await;
    assert_eq!(status, 200, "an owner may mint another owner (equal rank): {body}");
    assert_eq!(
        owner_count(&pool, org).await,
        2,
        "the intermediate TWO-OWNER state is legitimate and expected"
    );

    // ── … then demote self ⇒ exactly one owner, and it is the heir ──
    let (status, body) = patch_role(&server, &token, &acct, owner, "admin", None).await;
    assert_eq!(status, 200, "now the demotion is allowed: {body}");
    assert_eq!(owner_count(&pool, org).await, 1);
    assert_eq!(role_of(&pool, org, heir).await.as_deref(), Some("owner"));
    assert_eq!(role_of(&pool, org, owner).await.as_deref(), Some("admin"));

    // ── 3. the SHIPPED spec documents both obligations ──
    let spec_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ui/openapi/openapi.json");
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(&spec_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", spec_path.display())),
    )
    .expect("openapi.json parses");
    let desc = spec["paths"]["/api/accounts/{account_id}/members/{user_id}"]["patch"]
        ["description"]
        .as_str()
        .expect("the PATCH operation has a description in the shipped spec");
    assert!(
        desc.contains("promote the target") && desc.contains("demote yourself"),
        "R-4: the two-step transfer path must be documented on this operation, since \
         there is no transfer endpoint to document it on. Got: {desc}"
    );
    assert!(
        desc.contains("delete, transfer and share"),
        "the DEC-12 consent consequence must be stated — #140 closed with this \
         obligation unstated and the re-scope had to transfer it into #142. Got: {desc}"
    );

    // ── and `leave`, which declares NO permission (DEC-11), must still declare AUTH ──
    // Dropping `with_permission` to avoid a false `x-required-permissions` also drops the
    // `bearerAuth` requirement it stamps, which would put a state-destroying route into
    // the spec's genuinely-public set alongside /api/health and /api/auth/login. Asserted
    // on the SHIPPED spec because that is what a generated client or a gateway reads.
    let leave_op = &spec["paths"]["/api/accounts/{account_id}/members/leave"]["post"];
    let security = leave_op["security"]
        .as_array()
        .expect("the leave operation declares a `security` block");
    assert!(
        security
            .iter()
            .any(|s| s.get("bearerAuth").is_some()),
        "leave must declare bearerAuth — it has always REQUIRED authentication \
         (AccountScope step 1); only the declaration was missing. Got: {security:?}"
    );
    assert!(
        leave_op.get("x-required-permissions").is_none(),
        "and it must still declare NO permission (DEC-11): declaring \
         account::members::manage here would be false after DEC-3, and would hide the \
         Leave affordance from exactly the users the carve-out exists to serve"
    );

    // Both client trees would be the full contract; the `-saas` tree is STRIPPED on this
    // node (see DRIFT-1.25), so the shipped default tree is what a client is built from and
    // it alone is asserted — the same branch convention the acceptance port uses.
    let saas_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/openapi-saas/openapi.json");
    if saas_path.exists() {
        let saas: Value = serde_json::from_str(
            &std::fs::read_to_string(&saas_path).expect("read the saas spec"),
        )
        .expect("saas openapi.json parses");
        let saas_leave = &saas["paths"]["/api/accounts/{account_id}/members/leave"]["post"];
        assert!(
            saas_leave["security"]
                .as_array()
                .expect("the saas spec declares security on leave")
                .iter()
                .any(|x| x.get("bearerAuth").is_some()),
            "the saas client tree must carry the same declaration"
        );
        assert!(
            saas["paths"]["/api/accounts/{account_id}/members/{user_id}"]["patch"]["description"]
                .as_str()
                .expect("saas PATCH description")
                .contains("delete, transfer and share"),
            "and the same DEC-12 consent copy"
        );
    }
}

// ---------------------------------------------------------------------------
// TEST-9 [acceptance] [invariant: INV-1, INV-2] [covers: ITEM-6, ITEM-7, ITEM-8, ITEM-13]
// ---------------------------------------------------------------------------

/// INV-1 + INV-2 — **cross-tenant refusal on POPULATED state, and the header cannot
/// override the path in either direction**, all in one body.
///
/// P is Owner of org A (which has a second member) and holds `account::members::manage`.
/// Org B independently has its own owner AND its own member; P is in neither. So the B
/// arm is a refusal of a REAL, populated account — not of nothing — which the closing
/// DB re-query proves.
///
/// The header arms are what make DEC-1 testable: `X-Account-Id` is IGNORED, so an owner
/// header does not ADMIT P to a foreign path account, and a foreign header does not DENY
/// P on their own. If the extractor reconciled the header at all, the second arm would
/// be a 400 or a 404 instead of a 200.
#[tokio::test]
async fn inv1_inv2_cross_tenant_mutations_are_404_on_populated_state() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let p = create_user(&server, &admin_token, "xt_p", "xt_p@txresbench.test").await;
    let q = create_user(&server, &admin_token, "xt_q", "xt_q@txresbench.test").await;
    let r = create_user(&server, &admin_token, "xt_r", "xt_r@txresbench.test").await;

    // A — P owns it, with a second member so the 200 arm mutates something real.
    let a = make_org_account(&pool, "XT A", p).await;
    add_member(&pool, a, q, "member").await;
    // B — POPULATED and independent: its own owner Q and its own member R.
    let b = make_org_account(&pool, "XT B", q).await;
    add_member(&pool, b, r, "member").await;

    let token = login(&server, "xt_p").await;
    let (sa, sb) = (a.to_string(), b.to_string());

    // ── POSITIVE CONTROL: P mutates their own account ⇒ 200, real change ──
    let (status, body) = patch_role(&server, &token, &sa, q, "admin", None).await;
    assert_eq!(status, 200, "P owns A: {body}");
    assert_eq!(role_of(&pool, a, q).await.as_deref(), Some("admin"));

    // ── THE REFUSAL: the same P, the same token, all three routes against B ⇒ 404 ──
    let (s_patch, b_patch) = patch_role(&server, &token, &sb, r, "admin", None).await;
    let (s_delete, b_delete) = delete_member(&server, &token, &sb, r, None).await;
    let (s_leave, b_leave) = leave(&server, &token, &sb, None).await;
    assert_eq!(s_patch, 404, "PATCH on a foreign account: {b_patch}");
    assert_eq!(s_delete, 404, "DELETE on a foreign account: {b_delete}");
    assert_eq!(s_leave, 404, "leave on an account you are not in: {b_leave}");

    // ── indistinguishable from an account that never existed ──
    let nowhere = Uuid::new_v4().to_string();
    let (s_x, b_x) = patch_role(&server, &token, &nowhere, r, "admin", None).await;
    assert_eq!(s_x, 404);
    assert_eq!(
        b_patch, b_x,
        "the foreign-account 404 body must be BYTE-IDENTICAL to the nonexistent-account \
         404, or the difference is an existence oracle"
    );
    let (s_leave_x, b_leave_x) = leave(&server, &token, &nowhere, None).await;
    assert_eq!(
        (s_leave, s_leave_x),
        (404, 404),
        "both `leave` answers are 404 — without this, two identical 500s would satisfy \
         the body comparison below"
    );
    assert_eq!(b_leave, b_leave_x, "and the same for `leave`");

    // ── INV-2, direction 1: an OWNER header does not ADMIT P to a foreign PATH ──
    let (status, body) = patch_role(&server, &token, &sb, r, "admin", Some(a)).await;
    assert_eq!(
        status, 404,
        "X-Account-Id: <A> must not admit P to path B — that is the confused deputy \
         DEC-1 exists to make unrepresentable: {body}"
    );

    // ── INV-2, direction 2: a FOREIGN header does not DENY P on their own path ──
    let (status, body) = patch_role(&server, &token, &sa, q, "member", Some(b)).await;
    assert_eq!(
        status, 200,
        "the header is IGNORED, not reconciled — a mismatch is neither a 400 nor a 404: \
         {body}"
    );
    assert_eq!(
        role_of(&pool, a, q).await.as_deref(),
        Some("member"),
        "and the write landed on the PATH account, not the header account"
    );

    // ── B really is populated: the refusals above were of a REAL account ──
    assert_eq!(
        member_count(&pool, b).await,
        2,
        "B still holds its 2 members — P was refused something that exists"
    );
    assert_eq!(role_of(&pool, b, r).await.as_deref(), Some("member"), "unchanged");
    assert_eq!(role_of(&pool, b, q).await.as_deref(), Some("owner"), "unchanged");
}

// ---------------------------------------------------------------------------
// TEST-10 [acceptance] [invariant: INV-232] [covers: ITEM-5, ITEM-8, ITEM-13]
// ---------------------------------------------------------------------------

/// INV-232 — **`leave` sits OUTSIDE the `account::members::manage` kill switch.**
///
/// This is the deployment state #232 says nothing in the epic has ever entered: the
/// operator has revoked the capability from the `Users` group to turn self-service
/// management OFF. Before #142, that ALSO stopped every existing member leaving the
/// account they were already in — they were refused at step 2, before the extractor
/// ever read their membership row.
///
/// Both arms are required and neither is optional bookkeeping:
///   * arm (a) — `leave` still succeeds. Fails if the carve-out is reverted.
///   * arm (b) — PATCH and DELETE through the SAME session are 403
///     `ACCOUNT_MEMBERS_MANAGE_REQUIRED`. This is the CONTROL: without it, a `leave`
///     that succeeded for some unrelated reason would read as the carve-out working,
///     and a build that simply deleted step 2 wholesale would pass arm (a) too.
#[tokio::test]
async fn inv232_leave_works_with_the_kill_switch_off_while_management_does_not() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Turn self-service management OFF, deployment-wide, the way an operator would.
    revoke_manage_capability_deployment_wide(&pool).await;

    let owner = create_user(&server, &admin_token, "ks_own", "ks_own@txresbench.test").await;
    let stuck = create_user(&server, &admin_token, "ks_stk", "ks_stk@txresbench.test").await;
    let other = create_user(&server, &admin_token, "ks_oth", "ks_oth@txresbench.test").await;

    let org = make_org_account(&pool, "Kill Switch Org", owner).await;
    add_member(&pool, org, stuck, "admin").await;
    add_member(&pool, org, other, "member").await;
    let acct = org.to_string();

    // The subject is an account ADMIN, so the ROLE floor is satisfied for all three
    // routes — anything refused below is refused by the capability, not by the floor.
    let token = login(&server, "ks_stk").await;

    // ── arm (b), the CONTROL: management really is off for this session ──
    let (status, body) = patch_role(&server, &token, &acct, other, "admin", None).await;
    assert_eq!(status, 403, "PATCH must be off: {body}");
    assert_eq!(
        code_of(&body),
        Some("ACCOUNT_MEMBERS_MANAGE_REQUIRED"),
        "refused by the CAPABILITY (step 2), not by the role floor — the subject is an \
         account admin: {body}"
    );
    let (status, body) = delete_member(&server, &token, &acct, other, None).await;
    assert_eq!(status, 403, "DELETE must be off: {body}");
    assert_eq!(code_of(&body), Some("ACCOUNT_MEMBERS_MANAGE_REQUIRED"));
    assert_eq!(
        member_count(&pool, org).await,
        3,
        "and neither refused call wrote anything"
    );

    // ── arm (c), the ORDERING the new conditional could regress: the capability
    //    refusal must still come BEFORE any account lookup, so a capability-less caller
    //    cannot use these routes as an existence oracle. A build that skipped step 2
    //    wholesale, or that moved it after the membership lookup, passes arms (a) and (b)
    //    and fails only here.
    let nowhere = Uuid::new_v4().to_string();
    let (status, body) = patch_role(&server, &token, &nowhere, other, "admin", None).await;
    assert_eq!(
        status, 403,
        "a capability-less caller must get the UNIFORM 403 even for an account id that \
         does not exist — a 404 here would confirm non-existence to someone the \
         deployment has switched off: {body}"
    );
    assert_eq!(code_of(&body), Some("ACCOUNT_MEMBERS_MANAGE_REQUIRED"));

    // …while `leave` on that same nonexistent id is 404, which is the carve-out's
    // correct and DIFFERENT answer: with factor (a) skipped, the first thing it consults
    // is membership, whose `None` covers non-member and nonexistent identically.
    let (status, body) = leave(&server, &token, &nowhere, None).await;
    assert_eq!(
        status, 404,
        "the carve-out drops factor (a), so `leave` answers from the membership guard — \
         which is not an oracle, because non-member and nonexistent are the same 404: \
         {body}"
    );

    // ── arm (a): the member is NOT trapped ──
    let (status, body) = leave(&server, &token, &acct, None).await;
    assert_eq!(
        status, 204,
        "revoking the operator's kill switch must stop GRANTS, not trap existing \
         members inside a tenant-wide grant they can no longer repudiate (#232): {body}"
    );
    assert_eq!(
        role_of(&pool, org, stuck).await,
        None,
        "the membership really is gone"
    );
    assert_eq!(member_count(&pool, org).await, 2);

    // ── and the carve-out did not become a general bypass: factor (b) still runs ──
    let stranger_org = make_org_account(&pool, "Not Yours", other).await;
    let (status, body) = leave(&server, &token, &stranger_org.to_string(), None).await;
    assert_eq!(
        status, 404,
        "`leave` on an account you are not a member of is still 404 — the carve-out \
         drops factor (a) only, never the membership guard: {body}"
    );

    // ── the RESIDUE the carve-out does NOT free, pinned so it is not rediscovered ──
    // What is new here is the SOLE-OWNER shape, not either refusal on its own: the 422
    // also appears in TEST-5 and the 403 in arm (b) above. The point of the pairing is
    // that BOTH of a sole owner's exits are closed at once in this deployment state, so
    // the carve-out's justification ("revoking the key must not trap members") holds for
    // every member EXCEPT the last owner. Reported on #232 rather than treated as a bug.
    // A SOLE OWNER in this deployment state is still stuck, and both halves of why are
    // asserted here: `leave` refuses them (LAST_OWNER — the account may not be left
    // ownerless) and the only way out, promoting a successor, is a management action
    // that step 2 still gates. So the carve-out frees every member who is NOT the last
    // owner; for the last owner, platform staff remain the exit. That is deliberate —
    // appointing a successor really IS managing other people's memberships — but it is
    // narrower than "revoking the key must not trap members", so it is stated.
    let solo = make_org_account(&pool, "Solo Org", stuck).await;
    add_member(&pool, solo, other, "member").await;
    let solo_s = solo.to_string();

    let (status, body) = leave(&server, &token, &solo_s, None).await;
    assert_eq!(status, 422, "the sole owner cannot leave: {body}");
    assert_eq!(code_of(&body), Some("LAST_OWNER"));

    let (status, body) = patch_role(&server, &token, &solo_s, other, "owner", None).await;
    assert_eq!(
        status, 403,
        "…and cannot appoint a successor either, because that IS management and the \
         operator switched management off. Reported on #232 as the residue: the exit for \
         a LAST owner is still platform staff: {body}"
    );
    assert_eq!(code_of(&body), Some("ACCOUNT_MEMBERS_MANAGE_REQUIRED"));
    assert_eq!(owner_count(&pool, solo).await, 1, "and nothing changed");
}

// ---------------------------------------------------------------------------
// TEST-11 [acceptance] [invariant: INV-4] [covers: ITEM-6, ITEM-7, ITEM-13]
// ---------------------------------------------------------------------------

/// INV-4 — **the role floor holds.** A bare `member`, holding the capability, is refused
/// at the `Admin` floor on both management routes.
///
/// TWO positive controls through the SAME session, because one 403 tells you nothing on
/// its own: (1) `GET /api/accounts/{id}/members` returns 200 with the seeded members, so
/// the session is alive and the caller really is a member; and (2) that member's own
/// `leave` returns 204, so the `Member`-floor route on the same extractor ADMITS them —
/// which localises the refusal to the FLOOR rather than to the extractor, the capability
/// or the account.
#[tokio::test]
async fn inv4_bare_member_is_refused_at_the_admin_floor_but_can_read_and_leave() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "fl_own", "fl_own@txresbench.test").await;
    let plain = create_user(&server, &admin_token, "fl_mem", "fl_mem@txresbench.test").await;
    let victim = create_user(&server, &admin_token, "fl_vic", "fl_vic@txresbench.test").await;

    let org = make_org_account(&pool, "Floor Org", owner).await;
    add_member(&pool, org, plain, "member").await;
    add_member(&pool, org, victim, "member").await;
    let acct = org.to_string();
    let token = login(&server, "fl_mem").await;

    // ── THE REFUSALS ──
    let (status, body) = patch_role(&server, &token, &acct, victim, "admin", None).await;
    assert_eq!(status, 403, "a bare member may not change roles: {body}");
    assert_eq!(
        code_of(&body),
        Some("INSUFFICIENT_ACCOUNT_ROLE"),
        "the FLOOR refusal, distinct from the capability refusal and from a 404: {body}"
    );
    let (status, body) = delete_member(&server, &token, &acct, victim, None).await;
    assert_eq!(status, 403, "nor remove anyone: {body}");
    assert_eq!(code_of(&body), Some("INSUFFICIENT_ACCOUNT_ROLE"));

    // ── POSITIVE CONTROL 1: the same session can READ the members ──
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{acct}/members")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list members");
    assert_eq!(resp.status().as_u16(), 200, "the session is alive");
    let listed: Value = resp.json().await.expect("members json");
    assert_eq!(
        listed["total"].as_i64(),
        Some(3),
        "and really sees the POPULATED account: {listed}"
    );

    // ── POSITIVE CONTROL 2: the Member-floor route on the same extractor admits them ──
    let (status, body) = leave(&server, &token, &acct, None).await;
    assert_eq!(
        status, 204,
        "the `member` floor admits them, so the two 403s above are the ADMIN floor and \
         not the extractor, the capability or a broken session: {body}"
    );

    assert_eq!(
        role_of(&pool, org, victim).await.as_deref(),
        Some("member"),
        "and the refused mutations wrote nothing"
    );
}

// ---------------------------------------------------------------------------
// TEST-12 [acceptance] [invariant: INV-12] [covers: ITEM-6, ITEM-7, ITEM-8, ITEM-13]
// ---------------------------------------------------------------------------

/// INV-12 — **membership mutations are refused on personal accounts**, on all three
/// routes, BY NAME.
///
/// By name and not by status, because a personal account's sole member is its owner, so
/// `LAST_OWNER` would also produce a 422 here — and a refusal that depends on that
/// accident stops being a refusal the moment the accident changes. (#144's own TEST-22
/// exists for the same reason.)
///
/// Positive control: the identical three calls against an ORG account the same caller
/// owns are not 422 — so the refusals are about the account KIND.
#[tokio::test]
async fn inv12_personal_accounts_refuse_all_three_mutations_by_name() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let u = create_user(&server, &admin_token, "pa_u", "pa_u@txresbench.test").await;
    let helper = create_user(&server, &admin_token, "pa_h", "pa_h@txresbench.test").await;
    let personal = personal_account_id(&pool, u).await;
    let token = login(&server, "pa_u").await;
    let ps = personal.to_string();

    for (label, (status, body)) in [
        ("PATCH", patch_role(&server, &token, &ps, u, "member", None).await),
        ("DELETE", delete_member(&server, &token, &ps, u, None).await),
        ("leave", leave(&server, &token, &ps, None).await),
    ] {
        assert_eq!(status, 422, "{label} on a personal account: {body}");
        assert_eq!(
            code_of(&body),
            Some("PERSONAL_ACCOUNT_NOT_MANAGEABLE"),
            "{label}: refused BY NAME — LAST_OWNER would also be a 422 here, and a \
             refusal resting on that accident is not a refusal: {body}"
        );
    }
    assert_eq!(
        member_count(&pool, personal).await,
        1,
        "the personal account still has exactly its one member, its owner"
    );

    // ── POSITIVE CONTROL: the same three calls on an ORG account the same user owns ──
    let org = make_org_account(&pool, "PA Org", u).await;
    add_member(&pool, org, helper, "member").await;
    let os = org.to_string();

    let (status, _) = patch_role(&server, &token, &os, helper, "admin", None).await;
    assert_eq!(status, 200, "PATCH works on an organization");
    let (status, _) = delete_member(&server, &token, &os, helper, None).await;
    assert_eq!(status, 204, "DELETE works on an organization");
    let (status, body) = leave(&server, &token, &os, None).await;
    assert_eq!(
        status, 422,
        "leave is refused here too — but for a DIFFERENT reason: {body}"
    );
    assert_eq!(
        code_of(&body),
        Some("LAST_OWNER"),
        "which is exactly why the three refusals above had to be asserted by NAME: {body}"
    );

    // ── the REPOSITORY arm — without it this test cannot see the layer it depends on ──
    //
    // Over HTTP, `AccountScope` step 6 and `AccountRepository::refuse_if_personal` return
    // the SAME 422 with the SAME code, so every assertion above stays green if
    // `refuse_if_personal` were deleted from `set_role` and `remove_member`. That is the
    // half #142 acceptance item 1 leans on (the routes must reach the existing guards),
    // and DEC-5 of #139 says BOTH enforcement points are deliberate and neither may be
    // deleted in favour of the other. So drive the repository directly, past the
    // extractor entirely.
    let repo = AccountRepository::new(pool.clone());
    let ceiling = ActorCeiling::SelfService {
        actor_user_id: u,
        observed_role: AccountRole::Owner,
    };
    for (label, err) in [
        (
            "set_role",
            repo.set_role(personal, u, AccountRole::Member, ceiling)
                .await
                .expect_err("set_role on a personal account must be refused"),
        ),
        (
            "remove_member",
            repo.remove_member(personal, u, ceiling)
                .await
                .expect_err("remove_member on a personal account must be refused"),
        ),
    ] {
        let rendered = format!("{err:?}");
        assert!(
            rendered.contains("PERSONAL_ACCOUNT_NOT_MANAGEABLE"),
            "{label}: the REPOSITORY half refuses by name, with the extractor bypassed \
             (got {rendered})"
        );
        assert_eq!(err.to_api_error().0.as_u16(), 422, "{label}: mapped to 422");
    }
}

// ---------------------------------------------------------------------------
// TEST-13 [covers: ITEM-9] — the sync fan-out, including to the departed member
// ---------------------------------------------------------------------------

/// The removal frame must reach the REMOVED user, so their client drops the account
/// from the switcher.
///
/// `publish_account_member` fans to `account_audience`, resolved from `list_members`
/// AFTER the row is deleted — so the departed user is structurally absent from it. This
/// asserts the extra frames the handlers send: `account_member` DELETE **and** `account`
/// DELETE addressed to the departed user (the switcher list is keyed off the latter),
/// while a REMAINING member also gets their `account_member` frame.
#[tokio::test]
async fn removal_frames_reach_the_departed_member_and_the_remaining_ones() {
    use crate::common::sync_probe::SyncProbe;
    use std::time::Duration;

    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "sy_own", "sy_own@txresbench.test").await;
    let leaver = create_user(&server, &admin_token, "sy_lv", "sy_lv@txresbench.test").await;
    let stays = create_user(&server, &admin_token, "sy_st", "sy_st@txresbench.test").await;

    let org = make_org_account(&pool, "Sync Org", owner).await;
    add_member(&pool, org, leaver, "member").await;
    add_member(&pool, org, stays, "member").await;
    let acct = org.to_string();

    let owner_token = login(&server, "sy_own").await;
    let leaver_token = login(&server, "sy_lv").await;
    let stays_token = login(&server, "sy_st").await;

    // A pending transfer the leaver is a party to, so the #171 cancellation fan-out is
    // observable. Without this arm, deleting BOTH `fan_cancelled_transfers` call sites
    // leaves the whole suite green: the transfers are still cancelled in the DB (TEST-7
    // asserts that), so the only thing lost is that the two PARTIES are never told.
    let counterparty = create_user(&server, &admin_token, "sy_cp", "sy_cp@txresbench.test").await;
    let projects = ProjectRepository::new(pool.clone());
    let proj = projects.create(leaver, "sync-proj", "").await.unwrap().id;
    move_project_to_account(&pool, proj, org).await;
    let transfer = seed_pending_transfer(&pool, proj, leaver, counterparty).await;
    let counterparty_token = login(&server, "sy_cp").await;

    let mut departed_probe = SyncProbe::open(&server, &leaver_token).await;
    let mut remaining_probe = SyncProbe::open(&server, &stays_token).await;
    let mut counterparty_probe = SyncProbe::open(&server, &counterparty_token).await;

    // ── a PATCH first: the remaining member is told to refetch the members list ──
    let (status, _) = patch_role(&server, &owner_token, &acct, stays, "admin", None).await;
    assert_eq!(status, 200);
    let f = remaining_probe
        .expect_event("account_member", "update", Duration::from_secs(5))
        .await;
    assert_eq!(f.id, acct, "the wire id is the ACCOUNT id (notify-and-refetch)");

    // ── then the removal ──
    let (status, _) = delete_member(&server, &owner_token, &acct, leaver, None).await;
    assert_eq!(status, 204);

    let f = departed_probe
        .expect_event("account_member", "delete", Duration::from_secs(5))
        .await;
    assert_eq!(f.id, acct);
    let f = departed_probe
        .expect_event("account", "update", Duration::from_secs(5))
        .await;
    assert_eq!(
        f.id, acct,
        "the switcher list (`GET /api/accounts`) is keyed off `account`, so the departed \
         user needs THIS frame to drop the account without a reload. The action is \
         `update`, NOT `delete`: the reader's MEMBERSHIP ended, the account did not, and a \
         consumer that branched on `action == 'delete'` would conclude the organization \
         had been destroyed"
    );

    let f = remaining_probe
        .expect_event("account_member", "delete", Duration::from_secs(5))
        .await;
    assert_eq!(f.id, acct, "and the remaining members refetch too");

    // ── the #171 cancellation must reach BOTH parties of each cancelled transfer ──
    let f = counterparty_probe
        .expect_event("project_transfer", "delete", Duration::from_secs(5))
        .await;
    assert_eq!(
        f.id,
        transfer.to_string(),
        "the counterparty of a transfer cancelled by the removal is told, keyed by the \
         TRANSFER id (not the account id) — the frame `fan_cancelled_transfers` sends"
    );
    assert_eq!(
        transfer_status(&pool, transfer).await,
        None,
        "and the transfer really was cancelled, so the frame is not describing nothing"
    );

    // ── the OTHER call site: `leave_account` fans the same frames ──
    // The DELETE handler and the leave handler each call `fan_cancelled_transfers`
    // separately. The arm above only covers the DELETE one, so deleting the call in
    // `leave_account` still left the whole suite green — confirmed by a mutation run
    // before this arm existed (M12, MISSED).
    let leaver2 = create_user(&server, &admin_token, "sy_lv2", "sy_lv2@txresbench.test").await;
    add_member(&pool, org, leaver2, "member").await;
    let proj2 = projects.create(leaver2, "sync-proj-2", "").await.unwrap().id;
    move_project_to_account(&pool, proj2, org).await;
    let transfer2 = seed_pending_transfer(&pool, proj2, leaver2, counterparty).await;
    let leaver2_token = login(&server, "sy_lv2").await;

    let (status, _) = leave(&server, &leaver2_token, &acct, None).await;
    assert_eq!(status, 204);
    let f = counterparty_probe
        .expect_event("project_transfer", "delete", Duration::from_secs(5))
        .await;
    assert_eq!(
        f.id,
        transfer2.to_string(),
        "`leave` must fan the cancellation frames too — the counterparty of a transfer \
         cancelled by someone LEAVING is exactly as entitled to know as one cancelled by \
         a removal"
    );
    assert_eq!(transfer_status(&pool, transfer2).await, None);
}

// ---------------------------------------------------------------------------
// TEST-14 [covers: ITEM-3, ITEM-14] — the ceiling is re-read LIVE, under the lock
// ---------------------------------------------------------------------------

/// The ceiling that grades R-1 is `min(observed_role, live_role)`, where `live_role` is
/// read on the mutation's OWN transaction connection.
///
/// Driven at the REPOSITORY layer because HTTP cannot construct the state
/// deterministically: over HTTP the extractor always supplies the caller's true role, so
/// "the claim is staler than reality" only happens under a race. Here it is constructed
/// directly, which is what makes it a test rather than a hope.
///
/// #171 settled this shape and left the correction in the source: *"The hook LOSES that
/// race; it does not close it. What actually closes it is the locked re-assert INSIDE
/// the transaction."*
#[tokio::test]
async fn the_ceiling_is_re_read_live_inside_the_transaction() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = AccountRepository::new(pool.clone());

    let owner = create_user(&server, &admin_token, "lv_own", "lv_own@txresbench.test").await;
    let bob = create_user(&server, &admin_token, "lv_bob", "lv_bob@txresbench.test").await;
    let target = create_user(&server, &admin_token, "lv_tgt", "lv_tgt@txresbench.test").await;
    let carol = create_user(&server, &admin_token, "lv_car", "lv_car@txresbench.test").await;

    let org = make_org_account(&pool, "Live Org", owner).await;
    add_member(&pool, org, bob, "member").await; // bob's LIVE role
    add_member(&pool, org, target, "admin").await;

    // ── the stale-HIGH claim is ignored: graded on bob's LIVE `member` role ──
    let err = repo
        .set_role(
            org,
            target,
            AccountRole::Owner,
            ActorCeiling::SelfService {
                actor_user_id: bob,
                observed_role: AccountRole::Owner, // a claim reality no longer supports
            },
        )
        .await
        .expect_err("a demoted actor must not outrun their own demotion");
    assert!(
        format!("{err:?}").contains("ROLE_ABOVE_ACTOR"),
        "graded on the LIVE role, not the claim: {err:?}"
    );
    assert_eq!(
        role_of(&pool, org, target).await.as_deref(),
        Some("admin"),
        "and nothing was written"
    );

    // ── an actor who is no longer a member at all ⇒ 404, not 403 ──
    let err = repo
        .set_role(
            org,
            target,
            AccountRole::Member,
            ActorCeiling::SelfService {
                actor_user_id: carol, // never a member of this org
                observed_role: AccountRole::Owner,
            },
        )
        .await
        .expect_err("an actor whose membership vanished must be refused");
    let rendered = format!("{err:?}");
    assert_eq!(
        err.to_api_error().0.as_u16(),
        404,
        "losing this race must not become an existence oracle: {rendered}"
    );
    assert!(
        rendered.contains("Account not found"),
        "and on `set_role` it is the SAME `Account not found` the extractor's own \
         non-member refusal produces — asserted, because a bare status could not tell it \
         apart from the `Membership not found` that `remove_member` reaches first (see \
         `resolve_ceiling`'s doc, which used to claim the two were identical on every \
         path): {rendered}"
    );

    // ── POSITIVE CONTROL: the same call, with the live role actually high enough ──
    let promoted = repo
        .set_role(
            org,
            bob,
            AccountRole::Owner,
            super::staff_ceiling(), // staff set the stage
        )
        .await
        .expect("control: staff may mint an owner");
    assert_eq!(promoted.role, AccountRole::Owner);

    let ok = repo
        .set_role(
            org,
            target,
            AccountRole::Owner,
            ActorCeiling::SelfService {
                actor_user_id: bob,
                observed_role: AccountRole::Owner, // now TRUE
            },
        )
        .await
        .expect("control: the identical call succeeds once the LIVE role supports it");
    assert_eq!(
        ok.role,
        AccountRole::Owner,
        "so the two refusals above are the live re-read, not the call shape"
    );

    // ── the OTHER direction of `min`, which had no test at all ──
    //
    // bob's LIVE role is now `owner`. A request that was ADMITTED as `admin` must still
    // be graded at `admin`, not silently upgraded to the authority bob happens to hold
    // by the time the transaction runs. This is the arm that distinguishes
    // `min(observed, live)` from `live`: written as `live` alone, this call succeeds.
    // (The stale-HIGH arm at the top of this test is what distinguishes it from
    // `observed` alone. Together they pin the composition in both directions.)
    let target2 = create_user(&server, &admin_token, "lv_tg2", "lv_tg2@txresbench.test").await;
    add_member(&pool, org, target2, "member").await;
    let err = repo
        .set_role(
            org,
            target2,
            AccountRole::Owner,
            ActorCeiling::SelfService {
                actor_user_id: bob,
                observed_role: AccountRole::Admin, // what the request was ADMITTED under
            },
        )
        .await
        .expect_err("a request admitted as `admin` may not spend an owner's authority");
    assert!(
        format!("{err:?}").contains("ROLE_ABOVE_ACTOR"),
        "min() clamps DOWN to the authority the request was authorized under, never up: \
         {err:?}"
    );
    assert_eq!(
        role_of(&pool, org, target2).await.as_deref(),
        Some("member"),
        "and nothing was written"
    );
}

// ---------------------------------------------------------------------------
// TEST-15 [covers: ITEM-4] — the PlatformStaff arm: the admin surface is unchanged
// ---------------------------------------------------------------------------

/// The R-1 ceiling must NOT apply to platform staff.
///
/// Both operations here are refused on the self-service surface (TEST-4 cases 3 and 4)
/// and must still succeed through `/api/admin/accounts/*`. Without this test a ceiling
/// accidentally applied to every caller would pass every other test in this file — the
/// suite would be entirely consistent with a broken admin surface.
///
/// A SECOND owner is seeded so `LAST_OWNER` is not what answers: the only thing being
/// measured here is R-1's absence.
#[tokio::test]
async fn platform_staff_are_not_subject_to_the_role_ceiling() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let o1 = create_user(&server, &admin_token, "st_o1", "st_o1@txresbench.test").await;
    let o2 = create_user(&server, &admin_token, "st_o2", "st_o2@txresbench.test").await;
    let o3 = create_user(&server, &admin_token, "st_o3", "st_o3@txresbench.test").await;

    let org = make_org_account(&pool, "Staff Org", o1).await;
    add_member(&pool, org, o2, "owner").await;
    add_member(&pool, org, o3, "owner").await;
    assert_eq!(owner_count(&pool, org).await, 3, "no LAST_OWNER interference");

    // Platform staff DEMOTE an owner — refused for an account admin (TEST-4 case 4).
    //
    // SQLite port: `PATCH /api/admin/accounts/{org}/members/{o2}` has no object on this node
    // (the `/admin/accounts/*` surface is stripped; see DRIFT-1.25). The repository call IS
    // the surface — the handler added nothing but the `PlatformStaff` ceiling, so the same
    // contract is asserted at the seam the route was a wrapper over.
    AccountRepository::new(pool.clone())
        .set_role(
            org,
            o2,
            AccountRole::Member,
            super::staff_ceiling(),
        )
        .await
        .expect("platform staff keep their unceilinged member CRUD (demote)");
    assert_eq!(role_of(&pool, org, o2).await.as_deref(), Some("member"));

    // Platform staff REMOVE an owner — refused for an account admin (TEST-4 case 3).
    AccountRepository::new(pool.clone())
        .remove_member(org, o3, super::staff_ceiling())
        .await
        .expect("platform staff may evict an owner");
    assert_eq!(role_of(&pool, org, o3).await, None);
    assert_eq!(owner_count(&pool, org).await, 1, "o1 remains");
}

// ---------------------------------------------------------------------------
// TEST-16 [covers: ITEM-7, ITEM-13] — DELETE happy path
// ---------------------------------------------------------------------------

/// The removal route works, removes exactly one membership, and leaves every other
/// member of the account untouched.
#[tokio::test]
async fn delete_member_removes_exactly_that_membership() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "dm_own", "dm_own@txresbench.test").await;
    let gone = create_user(&server, &admin_token, "dm_go", "dm_go@txresbench.test").await;
    let stays = create_user(&server, &admin_token, "dm_st", "dm_st@txresbench.test").await;

    let org = make_org_account(&pool, "Delete Org", owner).await;
    add_member(&pool, org, gone, "member").await;
    add_member(&pool, org, stays, "admin").await;

    let token = login(&server, "dm_own").await;
    let (status, body) = delete_member(&server, &token, &org.to_string(), gone, None).await;
    assert_eq!(status, 204, "204 with no body: {body}");
    assert_eq!(body, Value::Null, "and really no body");

    assert_eq!(role_of(&pool, org, gone).await, None, "that membership is gone");
    assert_eq!(
        role_of(&pool, org, stays).await.as_deref(),
        Some("admin"),
        "and the OTHER members are untouched, at their original roles"
    );
    assert_eq!(role_of(&pool, org, owner).await.as_deref(), Some("owner"));
    assert_eq!(member_count(&pool, org).await, 2);
}

// ---------------------------------------------------------------------------
// TEST-18 [covers: ITEM-3, ITEM-14] — the ORDER of the ceiling read (added FIX_ROUND-2)
// ---------------------------------------------------------------------------

/// The ceiling is read **after** the owner lock is taken, not before the transaction —
/// proven by real contention rather than by a statically-constructed divergence.
///
/// The other `resolve_ceiling` test constructs the stale claim by hand, so it proves the
/// `min` arithmetic but would pass just as well if the read happened before `begin()`.
/// This one cannot: a third transaction holds the account's owner rows, the mutation
/// parks on that lock, the actor is demoted and COMMITTED while it waits, and only then
/// is the lock released. A read taken before the lock would still see the actor's old
/// `admin` role and allow the mutation; a read taken after sees `member` and refuses.
///
/// The actor is deliberately an `admin`, not an owner, so their own row is NOT among the
/// rows the barrier locks and the demotion can commit while the mutation waits — which is
/// also the case that shows the owner lock does not, by itself, protect the actor's row
/// (see `resolve_ceiling`'s doc).
#[tokio::test]
async fn the_ceiling_is_read_after_the_owner_lock_not_before() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "or_own", "or_own@txresbench.test").await;
    let bob = create_user(&server, &admin_token, "or_bob", "or_bob@txresbench.test").await;
    let target = create_user(&server, &admin_token, "or_tgt", "or_tgt@txresbench.test").await;
    let org = make_org_account(&pool, "Order Org", owner).await;
    add_member(&pool, org, bob, "admin").await;
    add_member(&pool, org, target, "member").await;

    // ── the barrier: hold the single write lock (the SQLite substitution for the
    //    owner-row `FOR UPDATE`; bob's admin row is deliberately not among the rows
    //    the PG version touched, and on SQLite there is no per-row distinction —
    //    the demotion below is folded into the barrier transaction instead)
    let bpool = barrier_pool(&server).await;
    let mut holder = hold_owner_lock(&bpool, org).await;

    // ── the mutation: admitted as `admin`, requesting `admin` — legal at admission time
    let repo = AccountRepository::new(bpool.clone());
    let (sig_tx, mut sig_rx) = tokio::sync::mpsc::channel(2);
    let task = tokio::spawn(async move {
        sig_tx.send(()).await.expect("signal set_role");
        repo.set_role(
            org,
            target,
            AccountRole::Admin,
            ActorCeiling::SelfService {
                actor_user_id: bob,
                observed_role: AccountRole::Admin,
            },
        )
        .await
    });
    barrier_reached(&mut sig_rx, 1).await;
    wait_parked(&task, "set_role (arm 1)").await;

    // ── demote the actor WHILE the mutation is parked, and commit it. SQLite port
    //    note (record): the single write lock makes a CONCURRENT demotion impossible
    //    (on PG it wrote a different row than the barrier held), so the demotion is
    //    bundled into the barrier transaction — it commits while the parked
    //    mutation waits, which is exactly the staging the arm needs.
    sqlx::query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2")
        .bind(org)
        .bind(bob)
        .execute(&mut *holder)
        .await
        .expect("demote the actor mid-flight");

    holder.commit().await.expect("release the barrier");

    let err = task
        .await
        .expect("join")
        .expect_err("the demotion committed before the lock was released, so the ceiling read after it must see `member`");
    assert!(
        format!("{err:?}").contains("ROLE_ABOVE_ACTOR"),
        "a ceiling read BEFORE the transaction would still see `admin` and allow this: {err:?}"
    );
    assert_eq!(
        role_of(&pool, org, target).await.as_deref(),
        Some("member"),
        "and nothing was written"
    );

    // ── CONTROL: the IDENTICAL call, by the SAME actor, without the demotion.
    // An earlier version swapped the actor to the account owner, which controlled for
    // "a parked-then-released set_role can succeed at all" rather than for "bob's own
    // call would have succeeded". Re-promote bob and re-run exactly what was refused.
    sqlx::query("UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2")
        .bind(org)
        .bind(bob)
        .execute(&pool)
        .await
        .expect("restore the actor's role");

    let mut holder2 = hold_owner_lock(&bpool, org).await;
    let repo2 = AccountRepository::new(bpool.clone());
    let (sig_tx2, mut sig_rx2) = tokio::sync::mpsc::channel(2);
    let task2 = tokio::spawn(async move {
        sig_tx2.send(()).await.expect("signal set_role control");
        repo2
            .set_role(
                org,
                target,
                AccountRole::Admin,
                ActorCeiling::SelfService {
                    actor_user_id: bob,
                    observed_role: AccountRole::Admin,
                },
            )
            .await
    });
    barrier_reached(&mut sig_rx2, 1).await;
    wait_parked(&task2, "set_role control (arm 2)").await;
    holder2.commit().await.expect("release barrier 2");
    let ok = task2
        .await
        .expect("join 2")
        .expect("control: bob's identical call succeeds when nothing demotes him");
    assert_eq!(ok.role, AccountRole::Admin);

    // ── the SAME ordering property for `remove_member`, the other caller ──
    // Proving it for `set_role` alone left a single-line hoist in `remove_member`
    // uncaught by any test, which a blind audit pointed out. Same barrier, same
    // mid-flight demotion; the target is a THIRD party (an admin), so the current-role
    // half is the one that must refuse once the ceiling drops to `member`.
    let victim = create_user(&server, &admin_token, "or_vic", "or_vic@txresbench.test").await;
    add_member(&pool, org, victim, "admin").await;
    let mut holder3 = hold_owner_lock(&bpool, org).await;
    let repo3 = AccountRepository::new(bpool.clone());
    let (sig_tx3, mut sig_rx3) = tokio::sync::mpsc::channel(2);
    let task3 = tokio::spawn(async move {
        sig_tx3.send(()).await.expect("signal remove_member");
        repo3
            .remove_member(
                org,
                victim,
                ActorCeiling::SelfService {
                    actor_user_id: bob,
                    observed_role: AccountRole::Admin,
                },
            )
            .await
    });
    barrier_reached(&mut sig_rx3, 1).await;
    wait_parked(&task3, "remove_member (arm 3)").await;
    sqlx::query("UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2")
        .bind(org)
        .bind(bob)
        .execute(&mut *holder3)
        .await
        .expect("demote the actor mid-flight, again");
    holder3.commit().await.expect("release barrier 3");
    let err = task3
        .await
        .expect("join 3")
        .expect_err("`remove_member` must read the ceiling after the lock too");
    assert!(
        format!("{err:?}").contains("ROLE_ABOVE_ACTOR"),
        "a ceiling hoisted above `remove_member`'s lock would still see `admin`: {err:?}"
    );
    assert_eq!(
        role_of(&pool, org, victim).await.as_deref(),
        Some("admin"),
        "and nothing was removed"
    );

    // ── CONTROL for arm 3, which its `set_role` sibling has and it lacked ──
    // Without it, tightening R-1's strict `>` to `>=` would ALSO refuse this removal —
    // by the equal-role rule rather than by the post-lock ceiling read — and the arm's
    // ordering claim would be vacuous. Re-promote bob, run the identical removal with
    // nothing demoting him, and require it to SUCCEED.
    sqlx::query("UPDATE account_members SET role = 'admin' WHERE account_id = $1 AND user_id = $2")
        .bind(org)
        .bind(bob)
        .execute(&pool)
        .await
        .expect("restore the actor's role");
    let mut holder4 = hold_owner_lock(&bpool, org).await;
    let repo4 = AccountRepository::new(bpool.clone());
    let (sig_tx4, mut sig_rx4) = tokio::sync::mpsc::channel(2);
    let task4 = tokio::spawn(async move {
        sig_tx4.send(()).await.expect("signal remove_member control");
        repo4
            .remove_member(
                org,
                victim,
                ActorCeiling::SelfService {
                    actor_user_id: bob,
                    observed_role: AccountRole::Admin,
                },
            )
            .await
    });
    barrier_reached(&mut sig_rx4, 1).await;
    wait_parked(&task4, "remove_member control (arm 4)").await;
    holder4.commit().await.expect("release barrier 4");
    task4
        .await
        .expect("join 4")
        .expect("control: an admin removing an equal-rank admin succeeds when nothing demotes them");
    assert_eq!(
        role_of(&pool, org, victim).await,
        None,
        "and the control really removed the membership"
    );
}

// ---------------------------------------------------------------------------
// TEST-19 [covers: ITEM-2, ITEM-8] — a concurrently promoted member can still leave
// ---------------------------------------------------------------------------

/// A member who is PROMOTED while their own `leave` is in flight must still leave.
///
/// This is the regression test for a defect a blind correctness audit found in the first
/// fix round, and it is the sharpest test in the file because the bug was invisible to
/// every other one: the ceiling is clamped to the role the request was ADMITTED under
/// (`min(observed, live)`), while the target row of a self-removal is the actor's OWN row,
/// which by then carries the higher LIVE role. Grading R-1's current-role half against
/// that mismatch refused `leave` with `403 ROLE_ABOVE_ACTOR` — on a route that takes no
/// target and whose only possible effect is to reduce the actor's own standing. The
/// source comment at the time asserted the case was unreachable.
///
/// Driven at the repository layer with the promotion already committed, which is the
/// state the race produces and is deterministic; the ordering itself is proven separately
/// by `the_ceiling_is_read_after_the_owner_lock_not_before`.
#[tokio::test]
async fn a_concurrently_promoted_member_can_still_leave() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let repo = AccountRepository::new(pool.clone());

    let owner = create_user(&server, &admin_token, "pr_own", "pr_own@txresbench.test").await;
    let mover = create_user(&server, &admin_token, "pr_mov", "pr_mov@txresbench.test").await;
    let org = make_org_account(&pool, "Promote Org", owner).await;
    add_member(&pool, org, mover, "admin").await; // the LIVE role, post-promotion

    // The request was admitted as a bare `member`; reality has since moved above it.
    repo.remove_member(
        org,
        mover,
        ActorCeiling::SelfService {
            actor_user_id: mover,
            observed_role: AccountRole::Member,
        },
    )
    .await
    .expect("a promotion must not strand a member inside the account they asked to leave");
    assert_eq!(role_of(&pool, org, mover).await, None, "they really left");

    // Same shape for a self-DEMOTION, the other self-targeting mutation.
    let mover2 = create_user(&server, &admin_token, "pr_mv2", "pr_mv2@txresbench.test").await;
    add_member(&pool, org, mover2, "admin").await;
    repo.set_role(
        org,
        mover2,
        AccountRole::Member,
        ActorCeiling::SelfService {
            actor_user_id: mover2,
            observed_role: AccountRole::Member,
        },
    )
    .await
    .expect("nor refuse a self-demotion to a role at or below the admitted ceiling");
    assert_eq!(role_of(&pool, org, mover2).await.as_deref(), Some("member"));

    // ── CONTROL: the exemption is for the CURRENT-role half only. The REQUESTED half
    //    still binds a self-target, so an admin still cannot promote THEMSELVES to owner.
    let climber = create_user(&server, &admin_token, "pr_clb", "pr_clb@txresbench.test").await;
    add_member(&pool, org, climber, "admin").await;
    let err = repo
        .set_role(
            org,
            climber,
            AccountRole::Owner,
            ActorCeiling::SelfService {
                actor_user_id: climber,
                observed_role: AccountRole::Admin,
            },
        )
        .await
        .expect_err("an admin may not mint themselves an owner");
    assert!(
        format!("{err:?}").contains("ROLE_ABOVE_ACTOR"),
        "the self exemption must not have opened INV-5 case 2: {err:?}"
    );
    assert_eq!(role_of(&pool, org, climber).await.as_deref(), Some("admin"));
}

// ---------------------------------------------------------------------------
// TEST-20 [covers: ITEM-9] — the two `origin` decisions, which nothing could see
// ---------------------------------------------------------------------------

/// Self-echo suppression is applied to the frames the acting client can echo, and NOT to
/// the one it cannot.
///
/// This test exists because a blind audit found that the branch's most-argued-over
/// production change was invisible to the entire suite: `Actor::connection` comes from the
/// `X-Sync-Connection-Id` header, no helper sent it, so `actor.connection` was always
/// `None` and both decisions were byte-identical to their opposites at runtime. A fix
/// round whose central correction can be reverted with the suite still green has not been
/// pinned.
///
/// The two decisions, and why they differ:
///
/// * `notify_departed_member` STAMPS `origin` on the leaver's `account_member` and
///   `account` frames. A Leave action knows it changed a membership, so #149's client can
///   echo those locally (`core/sync/localEcho.ts`) — and the obligation is recorded in
///   `routes.rs`'s carry-forward block.
/// * `fan_cancelled_transfers` does NOT, for the transfer frames. The acting client did
///   not invoke a transfer operation and has no way to know one was cancelled as a side
///   effect, so suppressing it would withhold the notification with nothing to replace it.
///
/// **Two SEPARATE leaves, deliberately.** The first version asserted both halves against
/// one probe and pinned only one of them: the handler publishes the membership frames
/// BEFORE the transfer frames, and `expect_event` skips non-matching frames, so waiting
/// for the transfer frame silently DRAINED the membership frames that were supposed to be
/// absent — and the following `expect_silence` then passed either way. A mutation run
/// caught that (it killed the transfer half and missed the membership half), which is
/// exactly what a mutation run is for.
#[tokio::test]
async fn origin_suppresses_only_the_frames_the_acting_client_can_echo() {
    use crate::common::sync_probe::SyncProbe;
    use std::time::Duration;

    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "og_own", "og_own@txresbench.test").await;
    let quiet = create_user(&server, &admin_token, "og_qt", "og_qt@txresbench.test").await;
    let mover = create_user(&server, &admin_token, "og_mv", "og_mv@txresbench.test").await;
    let counterparty = create_user(&server, &admin_token, "og_cp", "og_cp@txresbench.test").await;

    let org = make_org_account(&pool, "Origin Org", owner).await;
    add_member(&pool, org, quiet, "member").await;
    add_member(&pool, org, mover, "member").await;
    let acct = org.to_string();

    let owner_token = login(&server, "og_own").await;
    let quiet_token = login(&server, "og_qt").await;
    let mover_token = login(&server, "og_mv").await;

    // ═══ HALF 1 — the frames the acting client CAN echo are suppressed for it ═══
    // `quiet` has no pending transfer, so the ONLY frames their leave produces for them
    // are the two `notify_departed_member` stamps. Nothing else can be mistaken for them.
    let mut quiet_probe = SyncProbe::open(&server, &quiet_token).await;
    // A SECOND connection for the SAME user. This is what makes the control control:
    // the remaining member's frame comes from `publish_account_member`, a DIFFERENT
    // publish call, so on its own it stays green even if `notify_departed_member` were
    // deleted from `leave_account` outright — the acting connection would be silent for
    // the wrong reason. `quiet`'s other device is in `notify_departed_member`'s audience
    // and NOT the acting connection, so it must receive exactly what the acting one must
    // not. (Found by a blind audit; the first version of this test had the hole.)
    let mut quiet_other_device = SyncProbe::open(&server, &quiet_token).await;
    let mut remaining_probe = SyncProbe::open(&server, &owner_token).await;
    let quiet_conn = quiet_probe.connection_id();

    let (status, body) = leave_from(&server, &quiet_token, &acct, None, Some(quiet_conn)).await;
    assert_eq!(status, 204, "the leave itself succeeds: {body}");
    assert_eq!(role_of(&pool, org, quiet).await, None);

    // POSITIVE CONTROL 1: the route works at all — a REMAINING member is told, via
    // `publish_account_member`.
    let f = remaining_probe
        .expect_event("account_member", "delete", Duration::from_secs(5))
        .await;
    assert_eq!(f.id, acct);

    // POSITIVE CONTROL 2 — the one that makes the silence mean something:
    // `notify_departed_member` REALLY RAN, observed on the departed user's OTHER
    // connection, which is in its audience but is not the acting connection. Both of the
    // frames it sends are asserted, so deleting either publish, or the whole call, goes
    // red here rather than passing as silence over there.
    let f = quiet_other_device
        .expect_event("account_member", "delete", Duration::from_secs(5))
        .await;
    assert_eq!(f.id, acct, "the departed user IS told, on a connection that did not act");
    let f = quiet_other_device
        .expect_event("account", "update", Duration::from_secs(5))
        .await;
    assert_eq!(f.id, acct, "…including the switcher-list frame");

    // …and the acting connection is not told, because it will echo locally.
    quiet_probe.expect_silence(Duration::from_millis(750)).await;

    // ═══ HALF 2 — the frame it CANNOT echo is delivered to that same connection ═══
    let projects = ProjectRepository::new(pool.clone());
    let proj = projects.create(mover, "origin-proj", "").await.unwrap().id;
    move_project_to_account(&pool, proj, org).await;
    let transfer = seed_pending_transfer(&pool, proj, mover, counterparty).await;

    let mut mover_probe = SyncProbe::open(&server, &mover_token).await;
    let mover_conn = mover_probe.connection_id();

    let (status, body) = leave_from(&server, &mover_token, &acct, None, Some(mover_conn)).await;
    assert_eq!(status, 204, "{body}");
    assert_eq!(transfer_status(&pool, transfer).await, None, "the transfer was cancelled");

    let f = mover_probe
        .expect_event("project_transfer", "delete", Duration::from_secs(5))
        .await;
    assert_eq!(
        f.id,
        transfer.to_string(),
        "the leaver invoked a MEMBERSHIP operation; they have no way to know a transfer \
         was cancelled, so this frame must NOT be suppressed for their connection. \
         Stamping `origin` here withholds it with nothing to put it back"
    );
}

// ---------------------------------------------------------------------------
// TEST-17 [covers: ITEM-11] — the regen landed in BOTH client trees
// ---------------------------------------------------------------------------

/// `just openapi-regen` runs TWO cargo passes (#50: the default client and the
/// `--features saas` one) and writes ten files. A change that lands in only one tree is a
/// failure mode this repo has had, and it is invisible to every other test here.
///
/// The complementary check — that the committed artifacts match a FRESH regen of the
/// merged backend — is the merge-gate's C3, which is what binds a generated file to its
/// source. This test binds them to the ROUTES THIS BRANCH ADDS: the three operations
/// exist, in both trees, under the ids the frontend codegen consumes.
///
/// It also pins the negative that DEC-7 rests on: neither `permissions.ts` gained an
/// entry, which is the machine-checkable form of "this branch introduces no permission"
/// and therefore of "no A10 is owed here".
#[test]
fn the_regen_landed_in_both_client_trees() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let ops = [
        "Account.setMemberRole",
        "Account.removeMember",
        "Account.leaveAccount",
    ];

    // The `-saas` client tree is STRIPPED on this node (see DRIFT-1.25); a generated client is
    // built only from a shipped artifact, so the tree that exists is the contract that is
    // bound — the same branch convention as the acceptance port.
    let trees = [
        (
            "default",
            "../ui/openapi/openapi.json",
            "../ui/src/api-client/apiEndpoints.ts",
            "../ui/src/api-client/permissions.ts",
        ),
        (
            "saas",
            "../ui/openapi-saas/openapi.json",
            "../ui/src/api-client-saas/apiEndpoints.ts",
            "../ui/src/api-client-saas/permissions.ts",
        ),
    ]
    .into_iter()
    .filter(|(_, spec_rel, ..)| root.join(spec_rel).exists())
    .collect::<Vec<_>>();
    assert!(!trees.is_empty(), "at least the default generated client must ship");

    for (label, spec_rel, endpoints_rel, perms_rel) in trees {
        let spec = std::fs::read_to_string(root.join(spec_rel))
            .unwrap_or_else(|e| panic!("{label}: read {spec_rel}: {e}"));
        let endpoints = std::fs::read_to_string(root.join(endpoints_rel))
            .unwrap_or_else(|e| panic!("{label}: read {endpoints_rel}: {e}"));
        for op in ops {
            assert!(
                spec.contains(op),
                "{label} spec is missing operation {op} — the regen did not reach this tree"
            );
            assert!(
                endpoints.contains(op),
                "{label} apiEndpoints.ts is missing {op}"
            );
        }

        // DEC-7's negative, machine-checked: this branch introduces NO permission, so the
        // generated enum must carry only what #139 and earlier already put there. If a
        // permission were ever added here, A10 (a restricted-user e2e) would become owed
        // and this assertion is what would say so.
        let perms = std::fs::read_to_string(root.join(perms_rel))
            .unwrap_or_else(|e| panic!("{label}: read {perms_rel}: {e}"));
        assert!(
            perms.contains("AccountMembersManage"),
            "{label}: #139's key must still be present"
        );
        for absent in ["AccountMembersRemove", "AccountMembersLeave", "AccountMemberRole"] {
            assert!(
                !perms.contains(absent),
                "{label}: this branch must introduce NO new permission, found {absent}"
            );
        }
    }
}
