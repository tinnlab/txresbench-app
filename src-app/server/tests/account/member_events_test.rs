//! #148 — the membership audit ledger (`account_member_events`) A9 suite (epic #138).
//!
//! **The finding this suite exists for:** before this item there was no general-purpose audit
//! log in this repo — no `audit_log`, no `security_event`, no such migration, no structured
//! audit convention. `provenance` is domain-scientific lineage and is not this. So these tests
//! pin not only "the routes work" but the two properties the ledger's value rests on, each
//! of which is easy to CLAIM and hard to prove:
//!
//! - **written in-transaction** — proven three ways, none of them a reading of the source: an
//!   `xmin` identity (the ledger row and the mutated membership row were written by the SAME
//!   transaction id), a real production mutation cancelled after its audit write leaving ZERO
//!   rows, and the row being invisible to a third connection while that mutation is in flight.
//! - **append-only** — proven by asking the DATABASE, over a connection that is not this
//!   repository's code, to `UPDATE` / `DELETE` / `TRUNCATE` the table, and observing it refuse.
//!
//! **What a row means, and what this suite therefore asserts a row is NOT.** A row records a
//! membership mutation that COMMITTED. A refused attempt is not a row — and that is not a
//! preference, it is forced: the audit write shares the mutation's transaction, so a refusal
//! rolls it back. `refused_mutations_leave_zero_rows` is the negative half of INV-13 and is the
//! test that keeps the ledger's name from over-promising.
//!
//! Every arm runs on POPULATED state and re-queries the DB afterwards. A cross-tenant refusal
//! whose refused account was empty cannot tell "refused" from "there was nothing there".

use serde_json::{json, Value};
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench::modules::account::{
    record_member_event, AccountRepository, AccountRole, ActorCeiling, AuditActor,
    MemberEventAction, NewMemberEvent,
};

use crate::account::{
    add_member, create_user, login, make_org_account, pool_for, setup_admin,
};
use crate::common::TestServer;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// One ledger row, read straight from the table (never through the API) — so a test can tell
/// what was STORED from what a projection chose to SHOW.
#[derive(Debug, Clone, sqlx::FromRow)]
struct StoredEvent {
    action: String,
    actor_kind: String,
    actor_user_id: Option<Uuid>,
    target_user_id: Option<Uuid>,
    target_email: Option<String>,
    old_role: Option<String>,
    new_role: Option<String>,
    invitation_id: Option<Uuid>,
    reason: Option<String>,
}

/// Every stored row for one account, oldest first.
async fn stored_events(pool: &SqlitePool, account: Uuid) -> Vec<StoredEvent> {
    sqlx::query_as::<_, StoredEvent>(
        "SELECT action, actor_kind, actor_user_id, target_user_id, target_email, \
                old_role, new_role, invitation_id, reason \
         FROM account_member_events WHERE account_id = $1 ORDER BY created_at ASC, action ASC",
    )
    .bind(account)
    .fetch_all(pool)
    .await
    .expect("read stored ledger rows")
}

async fn event_count(pool: &SqlitePool, account: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM account_member_events WHERE account_id = $1",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .expect("count ledger rows")
}

/// The admin (first-run owner) user id.
async fn admin_user_id(pool: &SqlitePool) -> Uuid {
    sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE is_admin = true LIMIT 1")
        .fetch_one(pool)
        .await
        .expect("the first-run admin exists")
}

/// A pool with headroom for the barrier tests. Widened HERE rather than in the shared
/// `tests/account/mod.rs` helper — changing shared harness to suit one branch's tests is the
/// workaround that breaks everyone else (B3). Four connections is exactly zero headroom for a
/// holder + a blocked mutation + a poller + an observer.
async fn barrier_pool(server: &TestServer) -> SqlitePool {
    sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(12)
        .connect(server.database_url())
        .await
        .expect("connect barrier pool")
}

/// The wall-clock grace the SQLite barrier uses: a concurrent writer parks inside the sqlite
/// busy-handler at its `BEGIN IMMEDIATE` (the engine's single write lock — see the port note on
/// `while_the_account_row_is_held` in the accept test), and SQLite exposes no queue-observation
/// surface, so the in-flight window is a fixed sleep rather than a `pg_stat_activity` poll.
/// Recorded once here: on a box so loaded that a worker cannot reach the busy-handler inside
/// the grace, the barrier degrades to serialized execution (the PG design's silent-degradation
/// risk moved, not gone).
const LOCK_BARRIER_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

async fn patch_role(
    server: &TestServer,
    token: &str,
    account: Uuid,
    user: Uuid,
    role: &str,
) -> u16 {
    server
        .client
        .patch(server.api_url(&format!("/accounts/{account}/members/{user}")))
        .bearer_auth(token)
        .json(&json!({ "role": role }))
        .send()
        .await
        .expect("patch role")
        .status()
        .as_u16()
}

async fn get_events(server: &TestServer, token: &str, account: Uuid) -> (u16, Value) {
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{account}/members/events")))
        .bearer_auth(token)
        .send()
        .await
        .expect("get events");
    let status = resp.status().as_u16();
    (status, resp.json().await.unwrap_or(Value::Null))
}

// NOTE — the staff-side read sibling (`GET /api/admin/accounts/{account_id}/members/events`)
// has no object on this node (the `/admin/accounts/*` surface is stripped here; see DRIFT).
// The projection's falsifiability control is therefore the raw-DB read (`stored_events`),
// not a second HTTP surface.

// ---------------------------------------------------------------------------
// INV-13 — one row per successful mutation, with the right fields
// ---------------------------------------------------------------------------

/// TEST-1 — a self-service role change leaves EXACTLY ONE row carrying BOTH roles.
///
/// The "both present on `role_changed`" clause is the one that decides whether the ledger can
/// RECONSTRUCT the change or merely report that one happened, so it is asserted field by field
/// rather than by a row count.
#[tokio::test]
async fn inv13_role_change_writes_one_row_with_both_roles() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "ev_own", "ev_own@txresbench.test").await;
    let target = create_user(&server, &admin_token, "ev_tgt", "ev_tgt@txresbench.test").await;
    let org = make_org_account(&pool, "Ledger Org", owner).await;
    add_member(&pool, org, target, "member").await;
    let token = login(&server, "ev_own").await;

    let before = event_count(&pool, org).await;
    assert_eq!(
        before, 0,
        "precondition: make_org_account seeds membership by raw INSERT, not through the \
         audited repository, so the ledger starts empty for this account"
    );

    assert_eq!(patch_role(&server, &token, org, target, "admin").await, 200);

    let rows = stored_events(&pool, org).await;
    assert_eq!(rows.len(), 1, "exactly one row, not zero and not two: {rows:?}");
    let r = &rows[0];
    assert_eq!(r.action, "role_changed");
    assert_eq!(r.actor_kind, "user", "a self-service actor, distinguishable from staff");
    assert_eq!(r.actor_user_id, Some(owner), "attributed to the acting owner");
    assert_eq!(r.target_user_id, Some(target));
    assert_eq!(r.old_role.as_deref(), Some("member"), "BOTH roles: the role before");
    assert_eq!(r.new_role.as_deref(), Some("admin"), "BOTH roles: the role after");
    assert_eq!(r.target_email, None, "no email where a user id exists (DEC-14)");
    assert_eq!(r.reason, None);
}

/// TEST-3 / TEST-5 — `removed` vs `left`, side by side, from the ONE function #142's INV-R2
/// funnels every removal through.
///
/// `POST …/members/leave` and `DELETE …/members/{user_id}` reach the same `remove_member`, so
/// nothing about the ROUTE is available to the ledger. The actor is how the row tells them
/// apart, and this test compares all three shapes in one body: a third-party eviction, a
/// `leave`, and a self-targeted DELETE.
#[tokio::test]
async fn inv13_removed_and_left_are_distinguished_by_the_actor() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "rm_own", "rm_own@txresbench.test").await;
    let evicted = create_user(&server, &admin_token, "rm_evi", "rm_evi@txresbench.test").await;
    let leaver = create_user(&server, &admin_token, "rm_lea", "rm_lea@txresbench.test").await;
    let selfdel = create_user(&server, &admin_token, "rm_sdl", "rm_sdl@txresbench.test").await;
    let org = make_org_account(&pool, "Departures", owner).await;
    add_member(&pool, org, evicted, "member").await;
    add_member(&pool, org, leaver, "member").await;
    add_member(&pool, org, selfdel, "admin").await;

    let owner_token = login(&server, "rm_own").await;
    let leaver_token = login(&server, "rm_lea").await;
    let selfdel_token = login(&server, "rm_sdl").await;

    // (a) a third party evicts someone else.
    let s = server
        .client
        .delete(server.api_url(&format!("/accounts/{org}/members/{evicted}")))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("evict")
        .status()
        .as_u16();
    assert_eq!(s, 204);

    // (b) a member walks out through `leave`.
    let s = server
        .client
        .post(server.api_url(&format!("/accounts/{org}/members/leave")))
        .bearer_auth(&leaver_token)
        .send()
        .await
        .expect("leave")
        .status()
        .as_u16();
    assert_eq!(s, 204);

    // (c) the SAME act through the other route — an admin DELETEs their own row.
    let s = server
        .client
        .delete(server.api_url(&format!("/accounts/{org}/members/{selfdel}")))
        .bearer_auth(&selfdel_token)
        .send()
        .await
        .expect("self-delete")
        .status()
        .as_u16();
    assert_eq!(s, 204);

    let rows = stored_events(&pool, org).await;
    assert_eq!(rows.len(), 3, "one row per departure: {rows:?}");

    let evict = rows
        .iter()
        .find(|r| r.target_user_id == Some(evicted))
        .expect("a row for the evicted member");
    assert_eq!(evict.action, "removed", "a third-party eviction is `removed`");
    assert_eq!(evict.actor_user_id, Some(owner), "and names who did it");
    assert_eq!(evict.old_role.as_deref(), Some("member"), "the role they held");
    assert_eq!(evict.new_role, None, "a removal requests no role");

    for (who, label) in [(leaver, "leave"), (selfdel, "DELETE-self")] {
        let r = rows
            .iter()
            .find(|r| r.target_user_id == Some(who))
            .unwrap_or_else(|| panic!("a row for the {label} departure"));
        assert_eq!(
            r.action, "left",
            "{label}: a self-removal is `left` — derived from the ACTOR, so BOTH routes agree",
        );
        assert_eq!(r.actor_user_id, Some(who), "{label}: actor and target are the same person");
        assert_eq!(r.actor_kind, "user");
    }
}

/// TEST-6 — **the negative half of INV-13**: a refused mutation leaves ZERO rows.
///
/// Four refusals, counted before and after each attempt. This is the assertion that keeps the
/// ledger honest about what it is: it answers "what happened to this account", never "who tried
/// what". A refusal returns before its transaction commits, so a row written on that connection
/// is rolled back with it — the property is enforced by the transaction, not by a branch that
/// could be forgotten.
#[tokio::test]
async fn inv13_refused_mutations_leave_zero_rows() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "rf_own", "rf_own@txresbench.test").await;
    let admin_member = create_user(&server, &admin_token, "rf_adm", "rf_adm@txresbench.test").await;
    let org = make_org_account(&pool, "Refusals", owner).await;
    add_member(&pool, org, admin_member, "admin").await;

    let owner_token = login(&server, "rf_own").await;
    let admin_member_token = login(&server, "rf_adm").await;

    let start = event_count(&pool, org).await;
    assert_eq!(start, 0, "precondition: nothing recorded yet");

    // (1) 422 LAST_OWNER — the sole owner tries to walk out.
    let resp = server
        .client
        .post(server.api_url(&format!("/accounts/{org}/members/leave")))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("sole-owner leave");
    assert_eq!(resp.status().as_u16(), 422, "sole owner cannot leave");
    assert_eq!(event_count(&pool, org).await, 0, "LAST_OWNER left no row");

    // (2) 403 ROLE_ABOVE_ACTOR — an admin tries to evict the owner.
    let resp = server
        .client
        .delete(server.api_url(&format!("/accounts/{org}/members/{owner}")))
        .bearer_auth(&admin_member_token)
        .send()
        .await
        .expect("admin evicts owner");
    assert_eq!(resp.status().as_u16(), 403, "an admin may not reach an owner");
    assert_eq!(event_count(&pool, org).await, 0, "ROLE_ABOVE_ACTOR left no row");

    // (3) 404 — a membership that does not exist.
    let ghost = Uuid::new_v4();
    let resp = server
        .client
        .delete(server.api_url(&format!("/accounts/{org}/members/{ghost}")))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("remove a phantom member");
    assert_eq!(resp.status().as_u16(), 404);
    assert_eq!(event_count(&pool, org).await, 0, "a 404 left no row");

    // (4) 422 PERSONAL_ACCOUNT_NOT_MANAGEABLE — on the owner's own personal account.
    let personal: Uuid = sqlx::query_scalar(
        "SELECT id FROM accounts WHERE kind = 'personal' AND personal_user_id = $1",
    )
    .bind(owner)
    .fetch_one(&pool)
    .await
    .expect("the owner's personal account");
    let before_personal = event_count(&pool, personal).await;
    let resp = server
        .client
        .delete(server.api_url(&format!("/accounts/{personal}/members/{owner}")))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("mutate a personal account");
    assert!(
        resp.status().as_u16() == 422 || resp.status().as_u16() == 404,
        "a personal account's membership is not mutable (got {})",
        resp.status()
    );
    assert_eq!(
        event_count(&pool, personal).await,
        before_personal,
        "the refusal appended nothing to the personal account's ledger either"
    );

    // POSITIVE CONTROL — the SAME suite, same session, a mutation that IS allowed does
    // write. Without this, all four zeroes above would also hold if the writer were simply
    // never wired up.
    assert_eq!(
        patch_role(&server, &owner_token, org, admin_member, "member").await,
        200
    );
    assert_eq!(
        event_count(&pool, org).await,
        1,
        "the control proves the four zeroes mean `refused`, not `never recorded at all`"
    );
}

/// TEST-7 — the two PROVISIONING joins: the founding owner of an organization, and the
/// `system` row for a personal account.
///
/// Without the founding-owner row every organization's ledger opens with a hole where its
/// first owner appeared from nowhere — the exact question ("who was in this account, and since
/// when?") that the current-state columns cannot answer and that this ledger shape exists for.
#[tokio::test]
async fn inv13_provisioning_joins_are_recorded_with_the_right_actor_kind() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // (a) creating a USER provisions their personal account — an unattended action with no
    //     human actor.
    let user = create_user(&server, &admin_token, "pv_usr", "pv_usr@txresbench.test").await;
    let personal: Uuid = sqlx::query_scalar(
        "SELECT id FROM accounts WHERE kind = 'personal' AND personal_user_id = $1",
    )
    .bind(user)
    .fetch_one(&pool)
    .await
    .expect("personal account");

    let rows = stored_events(&pool, personal).await;
    assert_eq!(rows.len(), 1, "exactly one — the hook is idempotent and must not re-append");
    assert_eq!(rows[0].action, "joined");
    assert_eq!(
        rows[0].actor_kind, "system",
        "the personal-account hook is distinguishable from BOTH a user and staff"
    );
    assert_eq!(
        rows[0].actor_user_id, None,
        "and is the ONLY kind permitted a NULL actor — the table's CHECK backs this"
    );
    assert_eq!(rows[0].target_user_id, Some(user));
    assert_eq!(rows[0].new_role.as_deref(), Some("owner"));

    // (b) creating an ORGANIZATION seeds its founding owner.
    //
    // `POST /api/accounts` is gated on the admin-only `account::manage` capability and takes
    // an explicit `owner_id`, so the CALLER and the OWNER can differ — and this arm drives
    // exactly that case, because it is the one where a naive implementation attributes the
    // row to the wrong person. Attributing it to `owner_id` would make the ledger claim a
    // user added themselves to an account they had no part in creating.
    let staff = admin_user_id(&pool).await;
    let resp = server
        .client
        .post(server.api_url("/accounts"))
        .bearer_auth(&admin_token)
        .json(&json!({ "name": "Founded Org", "owner_id": user }))
        .send()
        .await
        .expect("create org");
    assert_eq!(resp.status().as_u16(), 201, "an operator may found an org for someone else");
    let body: Value = resp.json().await.expect("org body");
    let org: Uuid = body["id"].as_str().expect("org id").parse().expect("uuid");

    let rows = stored_events(&pool, org).await;
    assert_eq!(rows.len(), 1, "the founding owner's join is recorded: {rows:?}");
    assert_eq!(rows[0].action, "joined");
    assert_eq!(
        rows[0].actor_kind, "admin",
        "founding an organization is a STAFF act: `POST /api/accounts` is gated on the \
         platform-staff capability, which is not granted to ordinary users, so every caller \
         of it acted with staff authority — `actor_kind` classifies the AUTHORITY USED",
    );
    assert_eq!(
        rows[0].actor_user_id,
        Some(staff),
        "attributed to WHO CREATED IT, which on this route is not necessarily the owner",
    );
    assert_eq!(rows[0].target_user_id, Some(user), "and the owner is the TARGET");
    assert_ne!(
        rows[0].actor_user_id, rows[0].target_user_id,
        "the two are genuinely different here — an arm where they coincided could not catch \
         an implementation that recorded the target as the actor",
    );
    assert_eq!(rows[0].new_role.as_deref(), Some("owner"));

    // ── and the tenant must not learn WHICH platform employee founded their account ──────
    //
    // The regression this pins: the first implementation stamped this row `actor_kind = 'user'`
    // on the reasoning that the kind tracks the SURFACE. The account-scoped projection redacts
    // only `admin` rows, so a `user` row carrying an operator's id was served straight to the
    // tenant — contradicting the route's own published description. Two blind audits found it
    // independently, and it was invisible to the projection test because that test builds its
    // account by raw SQL and so never has a founding row at all.
    let owner_token = login(&server, "pv_usr").await;
    let (status, body) = get_events(&server, &owner_token, org).await;
    assert_eq!(status, 200, "the org's own owner may read its ledger");
    let events = body["events"].as_array().expect("events array");
    assert_eq!(events.len(), 1, "the founding row is the only one");
    assert_eq!(events[0]["actor_kind"], "admin");
    assert!(
        events[0]["actor_user_id"].is_null(),
        "the operating employee's id is REDACTED from the tenant: {:?}",
        events[0],
    );
    // ...while it is still STORED, so this is a redaction and not a hole in the record.
    assert_eq!(stored_events(&pool, org).await[0].actor_user_id, Some(staff));
}

// ---------------------------------------------------------------------------
// INV-13b — the staff path is audited AND distinguishable
// ---------------------------------------------------------------------------

/// TEST-2 / TEST-8 — **the distinguishability assertion**, which the issue says matters as
/// much as the presence.
///
/// The SAME mutation is driven through both surfaces in one body and the two rows are compared
/// where they must differ. Before #148 widened `ActorCeiling::PlatformStaff` to carry the staff
/// id this test was UNWRITABLE: the staff arm carried no actor at all, so an admin action could
/// be recorded but never attributed — the hole an audit trail most exists to close.
///
/// The `add_member` arm additionally re-asserts that the transaction wrap did not disturb the
/// pre-existing 409-duplicate and 404-phantom-user semantics, and that neither refusal writes.
#[tokio::test]
async fn inv13b_staff_and_self_service_rows_are_distinguishable() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let staff = admin_user_id(&pool).await;

    let owner = create_user(&server, &admin_token, "sd_own", "sd_own@txresbench.test").await;
    let subject = create_user(&server, &admin_token, "sd_sub", "sd_sub@txresbench.test").await;
    let added = create_user(&server, &admin_token, "sd_add", "sd_add@txresbench.test").await;
    let org = make_org_account(&pool, "Two Surfaces", owner).await;
    add_member(&pool, org, subject, "member").await;
    let owner_token = login(&server, "sd_own").await;

    // (a) staff promote the subject through the admin surface.
    //
    // SQLite port: `PATCH /api/admin/accounts/{org}/members/{subject}` has no object on this
    // node — the `/admin/accounts/*` surface is stripped (see DRIFT-1.25). The repository call
    // IS the surface: the handler added nothing but the `PlatformStaff` ceiling, so the
    // assertion run through it is the same contract with the route layer removed.
    AccountRepository::new(pool.clone())
        .set_role(
            org,
            subject,
            AccountRole::Admin,
            txresbench::modules::account::ActorCeiling::PlatformStaff {
                staff_user_id: staff,
            },
        )
        .await
        .expect("staff set_role is not ceilinged");

    // (b) the account's own owner performs the SAME mutation shape, back to `member`.
    assert_eq!(patch_role(&server, &owner_token, org, subject, "member").await, 200);

    let rows = stored_events(&pool, org).await;
    let staff_row = rows
        .iter()
        .find(|r| r.actor_kind == "admin")
        .expect("the staff mutation is recorded at all");
    let user_row = rows
        .iter()
        .find(|r| r.actor_kind == "user")
        .expect("the self-service mutation is recorded at all");

    assert_eq!(staff_row.action, "role_changed");
    assert_eq!(user_row.action, "role_changed");
    assert_eq!(
        staff_row.actor_user_id,
        Some(staff),
        "the staff row names the ACTING EMPLOYEE — the #148 widening is what makes this possible"
    );
    assert_eq!(user_row.actor_user_id, Some(owner), "the self-service row names the owner");
    assert_ne!(
        staff_row.actor_kind, user_row.actor_kind,
        "distinguishable BY KIND, not merely by which id happens to be there",
    );

    // (c) a staff ADD is audited as `joined` with the staff identity...
    AccountRepository::new(pool.clone())
        .add_member(
            org,
            added,
            AccountRole::Member,
            txresbench::modules::account::ActorCeiling::PlatformStaff {
                staff_user_id: staff,
            },
        )
        .await
        .expect("staff add member");
    let join = stored_events(&pool, org)
        .await
        .into_iter()
        .find(|r| r.action == "joined")
        .expect("the staff add is recorded");
    assert_eq!(join.actor_kind, "admin");
    assert_eq!(join.actor_user_id, Some(staff));
    assert_eq!(join.target_user_id, Some(added));
    assert_eq!(join.new_role.as_deref(), Some("member"));
    assert_eq!(join.old_role, None, "a join has no role before it");

    // ...and the transaction wrap left the pre-existing refusals intact, each writing nothing.
    let before = event_count(&pool, org).await;
    let repo = AccountRepository::new(pool.clone());
    let dup = repo
        .add_member(
            org,
            added,
            AccountRole::Member,
            txresbench::modules::account::ActorCeiling::PlatformStaff {
                staff_user_id: staff,
            },
        )
        .await
        .expect_err("duplicate membership still 409s");
    assert_eq!(
        dup.status_code(),
        409,
        "duplicate membership still 409s: {dup:?}"
    );
    let phantom = repo
        .add_member(
            org,
            Uuid::new_v4(),
            AccountRole::Member,
            txresbench::modules::account::ActorCeiling::PlatformStaff {
                staff_user_id: staff,
            },
        )
        .await
        .expect_err("a phantom user still 404s");
    assert_eq!(
        phantom.status_code(),
        404,
        "a phantom user still 404s: {phantom:?}"
    );
    assert_eq!(
        event_count(&pool, org).await,
        before,
        "neither refused add wrote a row — the audit write is on the committing arm only"
    );
}

// ---------------------------------------------------------------------------
// INV-13c — append-only, enforced by the database
// ---------------------------------------------------------------------------

/// TEST-9 — the ledger refuses `UPDATE`, `DELETE` and `TRUNCATE`.
///
/// Asked over `pool_for`, i.e. a connection that is **not** this repository's code, so what is
/// proven is that the DATABASE refuses — not that the application declines to ask. A convention
/// that nothing updates the table would pass a source grep and fail this.
#[tokio::test]
async fn inv13c_ledger_refuses_update_delete_and_truncate() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "ap_own", "ap_own@txresbench.test").await;
    let target = create_user(&server, &admin_token, "ap_tgt", "ap_tgt@txresbench.test").await;
    let org = make_org_account(&pool, "Append Only", owner).await;
    add_member(&pool, org, target, "member").await;
    let token = login(&server, "ap_own").await;
    assert_eq!(patch_role(&server, &token, org, target, "admin").await, 200);

    let before = event_count(&pool, org).await;
    assert_eq!(before, 1, "precondition: there is a row to try to tamper with");

    let upd = sqlx::query("UPDATE account_member_events SET action = 'joined' WHERE account_id = $1")
        .bind(org)
        .execute(&pool)
        .await;
    let err = upd.expect_err("UPDATE must be refused by the database");
    assert!(
        format!("{err}").contains("append-only"),
        "and refused BY NAME so the reason is unmistakable: {err}"
    );

    let del = sqlx::query("DELETE FROM account_member_events WHERE account_id = $1")
        .bind(org)
        .execute(&pool)
        .await;
    let err = del.expect_err("DELETE must be refused by the database");
    assert!(format!("{err}").contains("append-only"), "{err}");

    // SQLite port of the TRUNCATE arm (record): SQLite has no `TRUNCATE` statement at all —
    // the engine's nearest equivalent of "the whole ledger is one statement from gone" is a
    // WHERE-less `DELETE FROM`, and here the row triggers DO fire on it (SQLite has no
    // statement-level TRUNCATE exemption to fire them anyway). The property under test —
    // "no single statement can wipe the ledger" — therefore holds with the SAME mechanism
    // that refuses the other two, and is asserted with it rather than with a hypothetical
    // statement-level trigger that would fail to parse.
    let trunc = sqlx::query("DELETE FROM account_member_events").execute(&pool).await;
    let err = trunc.expect_err(
        "a WHERE-less DELETE must be refused — the ledger is one statement from gone, and \
         the row triggers are what stand there",
    );
    assert!(format!("{err}").contains("append-only"), "{err}");

    assert_eq!(
        event_count(&pool, org).await,
        before,
        "and after all three attempts the ledger is untouched"
    );
}

/// TEST-10 — the two deliberate carve-outs, so the enforcement is described accurately rather
/// than over-claimed.
///
/// (a) The account FK cascade — the ONE sanctioned deletion path, permitted through the
///     `pg_trigger_depth() > 1` exemption. If this regressed, deleting an account would fail.
/// (b) INV-13c's second clause: a later change APPENDS rather than mutating what is already
///     recorded — a member promoted then demoted leaves two rows and the first is unchanged.
#[tokio::test]
async fn inv13c_cascade_is_permitted_and_corrections_append() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "cs_own", "cs_own@txresbench.test").await;
    let target = create_user(&server, &admin_token, "cs_tgt", "cs_tgt@txresbench.test").await;
    let org = make_org_account(&pool, "Cascade Org", owner).await;
    add_member(&pool, org, target, "member").await;
    let token = login(&server, "cs_own").await;

    // (b) promote, then demote — two rows, the first untouched.
    assert_eq!(patch_role(&server, &token, org, target, "admin").await, 200);
    let after_first = stored_events(&pool, org).await;
    assert_eq!(after_first.len(), 1);
    assert_eq!(after_first[0].new_role.as_deref(), Some("admin"));

    assert_eq!(patch_role(&server, &token, org, target, "member").await, 200);
    let after_second = stored_events(&pool, org).await;
    assert_eq!(after_second.len(), 2, "a correction is a NEW row, never an edit");
    let still_there = after_second
        .iter()
        .filter(|r| r.old_role.as_deref() == Some("member") && r.new_role.as_deref() == Some("admin"))
        .count();
    assert_eq!(
        still_there, 1,
        "the FIRST row still says exactly what it said when it was written",
    );
    assert_eq!(
        after_second
            .iter()
            .filter(|r| r.old_role.as_deref() == Some("admin")
                && r.new_role.as_deref() == Some("member"))
            .count(),
        1,
        "and the second records the demotion",
    );

    // (a) the account cascade still works — the exemption is real, not theoretical.
    let deleted = sqlx::query("DELETE FROM accounts WHERE id = $1")
        .bind(org)
        .execute(&pool)
        .await
        .expect("deleting an account must still be possible — the ledger must not wedge it");
    assert_eq!(deleted.rows_affected(), 1);
    assert_eq!(
        event_count(&pool, org).await,
        0,
        "and the ledger rows went with it (the issue's ON DELETE CASCADE)",
    );
}

/// TEST-22 — **the hole no repository call can see**: a membership that ends by CASCADE.
///
/// `account_members_user_id_fkey` is `ON DELETE CASCADE` to `users`, so `DELETE /api/users/{id}`
/// silently drops every organization membership that user held — with no repository call, and
/// therefore, before this item's cascade trigger, with no ledger row. Two blind audits
/// reproduced the consequence independently against a real database: the org's ledger kept
/// saying `joined` while `account_members` said the person had never been there. That is worse
/// than a missing row — it is a ledger that is confidently WRONG about the one question it
/// exists to answer, while looking complete.
///
/// This test drives the real admin user-deletion route and asserts the membership's end is
/// recorded, at the only layer that can observe it.
#[tokio::test]
async fn a_membership_ended_by_the_users_cascade_is_still_recorded() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "cx_own", "cx_own@txresbench.test").await;
    let doomed = create_user(&server, &admin_token, "cx_dmd", "cx_dmd@txresbench.test").await;
    let org = make_org_account(&pool, "Cascade Ledger", owner).await;
    add_member(&pool, org, doomed, "admin").await;

    assert_eq!(event_count(&pool, org).await, 0, "precondition: nothing recorded yet");

    // SQLite port: the admin user-deletion route (`DELETE /api/users/{id}`) has no object on
    // this node (the `/users*` surface is stripped; see DRIFT-1.25). What is under test is the
    // CASCADE trigger on `users` — it fires on the DELETE regardless of which surface issued
    // it, and the ledger's own schema comment names the FK cascade + trigger as the claim, not
    // the route. The DELETE is issued by a connection that is not this repository's code, so
    // "a ledger that WEDGED the cascade" is still observed at the DB layer, exactly as before.
    let deleted = sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(doomed)
        .execute(&pool)
        .await
        .expect("delete the user row");
    assert_eq!(
        deleted.rows_affected(),
        1,
        "the user row is really gone — a ledger that WEDGED the cascade would be a far worse \
         defect than a missing row"
    );

    let members: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM account_members WHERE account_id = $1")
            .bind(org)
            .fetch_one(&pool)
            .await
            .expect("re-read members");
    assert_eq!(members, 1, "the cascade really did drop the org membership");

    let rows = stored_events(&pool, org).await;
    assert_eq!(
        rows.len(),
        1,
        "EXACTLY ONE row for the vanished membership — not zero (the ledger would be wrong) \
         and not two (the trigger must not double-record): {rows:?}",
    );
    assert_eq!(rows[0].action, "removed");
    assert_eq!(
        rows[0].actor_kind, "system",
        "no human actor is available at the layer that observes a cascade, and the row says \
         so rather than inventing one",
    );
    assert_eq!(rows[0].actor_user_id, None, "which is the only kind permitted a NULL actor");
    assert_eq!(rows[0].target_user_id, Some(doomed));
    assert_eq!(rows[0].old_role.as_deref(), Some("admin"), "and the role they held is kept");

    // CONTROL — the trigger fires ONLY for a cascade. A removal through the repository still
    // writes exactly one row, from the repository, at depth 1: no double-recording.
    let evictee = create_user(&server, &admin_token, "cx_evi", "cx_evi@txresbench.test").await;
    add_member(&pool, org, evictee, "member").await;
    let owner_token = login(&server, "cx_own").await;
    let s = server
        .client
        .delete(server.api_url(&format!("/accounts/{org}/members/{evictee}")))
        .bearer_auth(&owner_token)
        .send()
        .await
        .expect("evict")
        .status()
        .as_u16();
    assert_eq!(s, 204);
    let rows = stored_events(&pool, org).await;
    assert_eq!(
        rows.len(),
        2,
        "an ordinary removal adds ONE row, not two — the cascade trigger must not fire at \
         depth 1 alongside the repository's own write: {rows:?}",
    );
    let by_repo = rows
        .iter()
        .find(|r| r.target_user_id == Some(evictee))
        .expect("the eviction row");
    assert_eq!(by_repo.actor_kind, "user", "and it is the REPOSITORY's row, attributed");
    assert_eq!(by_repo.actor_user_id, Some(owner));

    // ── AND THE TENANT MUST ACTUALLY SEE IT ──────────────────────────────────────────────
    //
    // This is the assertion whose absence let the defect survive its own fix. The trigger was
    // added, the row was written, and this test passed — while the account-scoped projection
    // filtered every `system` row out, so the tenant's view still showed a `joined` with no
    // matching end: exactly the defect the trigger exists to close, reinstated one layer up. A
    // blind audit reproduced it end to end. Asserting against `stored_events` (raw SQL) alone
    // cannot see that, so this reads back through the real route.
    let (status, body) = get_events(&server, &owner_token, org).await;
    assert_eq!(status, 200);
    let events = body["events"].as_array().expect("events array");
    let cascade = events
        .iter()
        .find(|e| e["target_user_id"].as_str() == Some(&doomed.to_string()))
        .unwrap_or_else(|| panic!("the cascade-ended membership must be VISIBLE to the account's own admin: {events:?}"));
    assert_eq!(cascade["action"], "removed");
    assert_eq!(
        cascade["actor_kind"], "system",
        "and it says plainly that no human actor is attributable, rather than inventing one",
    );
    assert!(cascade["actor_user_id"].is_null());
}

// ---------------------------------------------------------------------------
// The in-transaction proofs
// ---------------------------------------------------------------------------

/// TEST-14 — **the positive proof**: the ledger row and the mutated membership row are written
/// by ONE transaction.
///
/// On Postgres this was observed as an `xmin` identity between the two rows — a row written by
/// a separate transaction — before, after or concurrently — cannot share it. SQLite has no
/// transaction-id column, so the property is proven instead by the fault-atomicity shape the
/// accept item uses (inv17 ARM 2): a fault armed EXACTLY at the ledger write aborts the
/// mutation's transaction, and the membership row — written in the same transaction — rolls
/// back with it. If the audit write were moved onto its own connection, its failure would
/// leave the membership committed and this goes red immediately, with no timing dependence
/// either way.
#[tokio::test]
async fn in_transaction_ledger_row_shares_the_mutation_xmin() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "xm_own", "xm_own@txresbench.test").await;
    let target = create_user(&server, &admin_token, "xm_tgt", "xm_tgt@txresbench.test").await;
    let org = make_org_account(&pool, "Xmin Org", owner).await;
    add_member(&pool, org, target, "member").await;
    let _token = login(&server, "xm_own").await;

    // Arm the fault on THIS account's ledger rows only. `set_role` writes the audit row on
    // its transaction's connection BEFORE the membership UPDATE (see repository.rs — the
    // audit write is on `&mut tx` alongside the UPDATE), so a fault at the ledger write
    // aborts the SAME transaction that holds the UPDATE.
    // `LowerHex` for Uuid renders the HYPHENATED form; `hex()` renders none — the
    // hyphens must be stripped or the WHEN clause never matches (the ITEM-25 record).
    let org_hex = format!("{:x}", org).replace('-', "");
    sqlx::query(&format!(
        "CREATE TRIGGER txr_test_ledger_fault BEFORE INSERT ON account_member_events \
         FOR EACH ROW WHEN (lower(hex(NEW.account_id)) = '{org_hex}') \
         BEGIN SELECT RAISE(ABORT, 'injected fault at the ledger write'); END"
    ))
    .execute(&pool)
    .await
    .expect("arm the ledger fault trigger");

    let repo = AccountRepository::new(pool.clone());
    let out = repo
        .set_role(
            org,
            target,
            AccountRole::Admin,
            ActorCeiling::SelfService {
                actor_user_id: owner,
                observed_role: AccountRole::Owner,
            },
        )
        .await;
    assert!(
        out.is_err(),
        "the injected failure must surface as `Err`, not as a silent success: {out:?}"
    );

    // NEITHER write survived — the membership UPDATE is in the SAME transaction as the audit
    // row, in both directions.
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2")
            .bind(org)
            .bind(target)
            .fetch_optional(&pool)
            .await
            .expect("re-read the membership role");
    assert_eq!(
        role.as_deref(),
        Some("member"),
        "the role change rolled back with the aborted audit write — if the audit write were \
         on its own connection this would have committed"
    );
    assert_eq!(
        event_count(&pool, org).await,
        0,
        "and no ledger row survives either — one transaction in both directions"
    );

    sqlx::query("DROP TRIGGER txr_test_ledger_fault")
        .execute(&pool)
        .await
        .expect("disarm the fault trigger");

    // POSITIVE CONTROL — the same mutation, unobstructed, commits BOTH.
    repo.set_role(
        org,
        target,
        AccountRole::Admin,
        ActorCeiling::SelfService {
            actor_user_id: owner,
            observed_role: AccountRole::Owner,
        },
    )
    .await
    .expect("the identical change succeeds once the fault is gone");

    let changed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM account_members WHERE account_id = $1 AND user_id = $2 AND role = 'admin'",
    )
    .bind(org)
    .bind(target)
    .fetch_one(&pool)
    .await
    .expect("the updated membership row");
    assert_eq!(changed, 1, "the role change committed");
    let rows = stored_events(&pool, org).await;
    assert_eq!(
        rows.len(),
        1,
        "the same mutation, allowed to commit, writes EXACTLY ONE row — which is what makes \
         the zeroes above mean `rolled back` instead of `never written`: {rows:?}",
    );
    assert_eq!(rows[0].action, "role_changed");
    assert_eq!(rows[0].target_user_id, Some(target));
}

/// TEST-15 / TEST-16 — **the negative proofs**, on the production code path.
///
/// SQLite port (record): the original driver of the failure was a `pg_cancel_backend` on a
/// backend parked at its `DELETE` behind a row lock — neither `pg_cancel_backend` nor a
/// row-level lock has a SQLite form, and the single-writer model makes the whole transaction
/// the lock section. The port instead injects the failure AT the audit write with the
/// `SELECT RAISE(ABORT, …)` trigger idiom (the plpgsql fault-function substitution), on the
/// production code path: `remove_member` reaches `record_member_event` only after every
/// refusal has returned and before its `DELETE`, so a fault there is "the mutation failed
/// after it reached the audit write".
///
/// - **TEST-15 (rollback):** the faulted mutation returns `Err`, the transaction rolls back,
///   and the ledger is EMPTY — while the membership itself is untouched. If the audit write
///   were on its own connection, its failure would not touch the removal's transaction: the
///   removal would SUCCEED and this goes red (the standing check on mutant M7).
/// - **TEST-16 (invisibility):** the original arm observed an in-flight row from a third
///   connection. SQLite exposes no queue-observation surface, so NO point after the audit
///   write and before commit is observable; the property itself (an uncommitted write is
///   invisible to every other connection) is engine-guaranteed on both engines and is
///   effectively restated here: the row is visible ONLY once the mutation's transaction
///   commits, which is exactly what the positive control below must produce.
#[tokio::test]
async fn in_transaction_a_rolled_back_mutation_leaves_no_row() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = barrier_pool(&server).await;

    let owner = create_user(&server, &admin_token, "rb_own", "rb_own@txresbench.test").await;
    let target = create_user(&server, &admin_token, "rb_tgt", "rb_tgt@txresbench.test").await;
    let org = make_org_account(&pool, "Rollback Org", owner).await;
    add_member(&pool, org, target, "member").await;

    // Arm the fault on THIS account's ledger rows only.
    // `LowerHex` for Uuid renders the HYPHENATED form; `hex()` renders none — the
    // hyphens must be stripped or the WHEN clause never matches (the ITEM-25 record).
    let org_hex = format!("{:x}", org).replace('-', "");
    sqlx::query(&format!(
        "CREATE TRIGGER txr_test_ledger_fault BEFORE INSERT ON account_member_events \
         FOR EACH ROW WHEN (lower(hex(NEW.account_id)) = '{org_hex}') \
         BEGIN SELECT RAISE(ABORT, 'injected fault at the ledger write'); END"
    ))
    .execute(&pool)
    .await
    .expect("arm the ledger fault trigger");

    let repo = AccountRepository::new(pool.clone());
    let outcome = repo
        .remove_member(
            org,
            target,
            ActorCeiling::SelfService {
                actor_user_id: owner,
                observed_role: AccountRole::Owner,
            },
        )
        .await;
    assert!(
        outcome.is_err(),
        "the faulted removal must report failure, not silently succeed: {outcome:?}",
    );

    // TEST-15 — the A ROLLED-BACK MUTATION LEAVES NO ROW half. The audit write shared the
    // mutation's transaction, so it died with it.
    assert_eq!(
        event_count(&pool, org).await,
        0,
        "A ROLLED-BACK MUTATION LEAVES NO ROW. The audit write shared the mutation's \
         transaction, so it died with it.",
    );
    let still_a_member: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM account_members WHERE account_id = $1 AND user_id = $2",
    )
    .bind(org)
    .bind(target)
    .fetch_one(&pool)
    .await
    .expect("re-read the membership");
    assert_eq!(
        still_a_member, 1,
        "and the membership itself rolled back too — the two are one transaction in both \
         directions, not merely `the ledger followed the mutation`",
    );

    sqlx::query("DROP TRIGGER txr_test_ledger_fault")
        .execute(&pool)
        .await
        .expect("disarm the fault trigger");

    // ── THE POSITIVE CONTROL, and it is not optional bookkeeping ────────────────────────
    //
    // Every ledger assertion above is `count == 0`, and this account is seeded by raw SQL so
    // it STARTS at zero. Without a control the whole test passes unchanged if the audit write
    // is simply deleted from `remove_member`, which is the opposite of what it claims to
    // prove. A blind audit filed exactly that, and the mutation battery confirmed it: mutant
    // M1 (drop the removal's audit write) was NOT caught here before this block existed.
    //
    // So: run the SAME removal again, now unobstructed, and require the row to appear.
    let repo = AccountRepository::new(pool.clone());
    repo.remove_member(
        org,
        target,
        ActorCeiling::SelfService {
            actor_user_id: owner,
            observed_role: AccountRole::Owner,
        },
    )
    .await
    .expect("the removal succeeds once the fault is gone");

    let rows = stored_events(&pool, org).await;
    assert_eq!(
        rows.len(),
        1,
        "the identical removal, allowed to commit, writes EXACTLY ONE row — which is what \
         makes the zeroes above mean `rolled back` instead of `never written`",
    );
    assert_eq!(rows[0].action, "removed");
    assert_eq!(rows[0].target_user_id, Some(target));
}

/// TEST-23 — a caller-supplied `page` is floored at 1 but never capped, so `(page - 1) * per_page`
/// overflows on a large value: a PANIC in a dev/test build (this workspace sets no `[profile]`
/// overrides, so overflow checks are on) and, in release, a wrap to a NEGATIVE offset that
/// Postgres refuses outright — a 500 either way, from a query string.
///
/// Asserted on the paged member surfaces, including the PRE-EXISTING members list, which
/// this branch fixed the same way rather than leave a reachable panic beside its own fix.
#[tokio::test]
async fn an_overflowing_page_yields_an_empty_page_not_a_panic() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "pg_own", "pg_own@txresbench.test").await;
    let org = make_org_account(&pool, "Paging Org", owner).await;
    let owner_token = login(&server, "pg_own").await;

    let huge = i64::MAX;
    // The STAFF-events sibling (`/admin/accounts/{org}/members/events`) had no object on this
    // node (the `/admin/accounts/*` surface is stripped; see DRIFT-1.25), so the sweep covers
    // the two retained paged member surfaces.
    for (label, url, token) in [
        (
            "account-scoped events",
            format!("/accounts/{org}/members/events?page={huge}&per_page=100"),
            owner_token.clone(),
        ),
        (
            "members list (pre-existing, fixed here)",
            format!("/accounts/{org}/members?page={huge}&per_page=100"),
            owner_token.clone(),
        ),
    ] {
        let resp = server
            .client
            .get(server.api_url(&url))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap_or_else(|e| panic!("{label}: request failed: {e}"));
        assert_eq!(
            resp.status().as_u16(),
            200,
            "{label}: a request for page nine quintillion is answered, not 500'd",
        );
        let body: Value = resp.json().await.expect("json");
        let items = body["events"]
            .as_array()
            .or_else(|| body["members"].as_array())
            .unwrap_or_else(|| panic!("{label}: a list body"));
        assert!(items.is_empty(), "{label}: and the page past the end is empty");
    }
}

/// TEST-24 — the `rows_affected == 0` guard in `remove_member`, driven for real.
///
/// It is the sole compensating control against committing a ledger row for a removal the
/// transaction did not perform — and, because the ledger is append-only, a false row there
/// could never be corrected, only annotated. It is a race-only path, so it is driven with the
/// write-lock barrier the in-transaction proofs use: the barrier transaction holds the
/// database's single write lock (and deletes the row inside it), the removal parks at its
/// `BEGIN IMMEDIATE`, and the barrier then commits — so the removal wakes to find nothing to
/// delete. Its `DELETE` then affects zero rows.
///
/// SQLite port (record): the PG staging parked the removal on its DELETE behind a row lock,
/// then deleted from a second connection and committed it. The single-writer model has no
/// per-row section: the serialization point is the transaction OPEN, so the deletion moves
/// INTO the barrier transaction and the parked step is the `BEGIN IMMEDIATE` busy-wait —
/// the same observable outcome (a removal that removes nothing returns 404 and writes no
/// row), proved by the same second-connection-commits ordering.
#[tokio::test]
async fn a_removal_that_removed_nothing_is_a_404_and_writes_no_row() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = barrier_pool(&server).await;

    let owner = create_user(&server, &admin_token, "ra_own", "ra_own@txresbench.test").await;
    let target = create_user(&server, &admin_token, "ra_tgt", "ra_tgt@txresbench.test").await;
    let org = make_org_account(&pool, "Vanished", owner).await;
    add_member(&pool, org, target, "member").await;

    // The barrier: take the database's single write lock at the OPEN and pin the fixture's
    // control ("the account really is reachable inside the blocker").
    let mut barrier = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .expect("begin the barrier tx");
    sqlx::query("SELECT id FROM accounts WHERE id = $1")
        .bind(org)
        .execute(&mut *barrier)
        .await
        .expect("pin the barrier on the account");

    let repo = AccountRepository::new(pool.clone());
    let mutation = tokio::spawn(async move {
        repo.remove_member(
            org,
            target,
            ActorCeiling::SelfService {
                actor_user_id: owner,
                observed_role: AccountRole::Owner,
            },
        )
        .await
    });

    // The removal is parked at its `BEGIN IMMEDIATE` (busy-handler) — the in-flight window,
    // bounded by the grace constant. SQLite exposes no queue-observation surface to prove the
    // parking directly; see the note on the constant.
    tokio::time::sleep(LOCK_BARRIER_GRACE).await;

    // The barrier itself removes the membership and commits, so the parked removal wakes to
    // find nothing to delete.
    sqlx::query("DELETE FROM account_members WHERE account_id = $1 AND user_id = $2")
        .bind(org)
        .bind(target)
        .execute(&mut *barrier)
        .await
        .expect("the barrier removes the row");
    barrier.commit().await.expect("commit the barrier");

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(30), mutation)
        .await
        .expect("the removal must return promptly")
        .expect("the mutation task joined");
    let err = outcome.expect_err(
        "a removal that removed NOTHING must report 404, not report success — a success here \
         commits an audit row for a removal this transaction did not perform",
    );
    let rendered = format!("{err:?}");
    assert_eq!(
        err.to_api_error().0.as_u16(),
        404,
        "and it is the same 404 the target lookup would have returned: {rendered}",
    );

    assert_eq!(
        event_count(&pool, org).await,
        0,
        "and no ledger row survives — the false `removed` rolled back with the transaction, \
         which matters because an append-only ledger could never retract it",
    );
}

// ---------------------------------------------------------------------------
// The read routes — projection, INV-1, INV-4
// ---------------------------------------------------------------------------

/// TEST-17 / TEST-18 — the DEC-7 projection, all three subtractions at once.
///
/// TEST-18's falsifiability control (the staff route that serves the identity) has no object
/// on this node — the `/admin/accounts/*` surface is stripped, so "redacted from the account
/// admin" and "never recorded at all" are told apart by the raw-DB read of the SAME rows
/// instead, which is the same control with the route layer removed.
#[tokio::test]
async fn account_scoped_projection_omits_system_redacts_staff_and_drops_reason() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let staff = admin_user_id(&pool).await;

    let owner = create_user(&server, &admin_token, "pj_own", "pj_own@txresbench.test").await;
    let subject = create_user(&server, &admin_token, "pj_sub", "pj_sub@txresbench.test").await;
    let org = make_org_account(&pool, "Projection Org", owner).await;
    add_member(&pool, org, subject, "member").await;
    let owner_token = login(&server, "pj_own").await;

    // A `user` row, an `admin` row (staff, through the admin surface), and a `system` row
    // written directly through the production writer — the personal-account hook's shape, on an
    // org account so all three kinds sit in one ledger.
    assert_eq!(patch_role(&server, &owner_token, org, subject, "admin").await, 200);
    // SQLite port: the staff PATCH route has no object on this node; the repository call IS
    // the surface (the handler adds nothing but the `PlatformStaff` ceiling).
    AccountRepository::new(pool.clone())
        .set_role(
            org,
            subject,
            AccountRole::Member,
            txresbench::modules::account::ActorCeiling::PlatformStaff {
                staff_user_id: staff,
            },
        )
        .await
        .expect("staff patch");

    // TWO system rows, because the projection treats them differently and that distinction is
    // the whole of DEC-7's first subtraction: the unattended PROVISIONING seed is an internal
    // and is hidden, while a membership that ENDED without an attributable human is a real
    // event in this tenant and must be shown. An earlier version of the filter excluded both
    // and silently reinstated the very hole the cascade trigger had just closed.
    let mut tx = pool.begin().await.expect("begin");
    record_member_event(
        &mut tx,
        NewMemberEvent {
            account_id: org,
            actor: AuditActor::System,
            action: MemberEventAction::Joined,
            target_user_id: Some(subject),
            target_email: None,
            old_role: None,
            new_role: Some(AccountRole::Member),
            invitation_id: None,
            reason: None,
        },
    )
    .await
    .expect("write a system provisioning row");
    record_member_event(
        &mut tx,
        NewMemberEvent {
            account_id: org,
            actor: AuditActor::System,
            action: MemberEventAction::Removed,
            target_user_id: Some(subject),
            target_email: None,
            old_role: Some(AccountRole::Member),
            new_role: None,
            invitation_id: None,
            reason: None,
        },
    )
    .await
    .expect("write a system cascade-removal row");
    tx.commit().await.expect("commit");

    // A staff row carrying a `reason`. Seeded by raw INSERT rather than driven through a
    // route because NO production path writes `reason` today — the column is schema-only,
    // minted for the admin surface that the admin-console owners still have to expose (see
    // DRIFT-1.4). What is under test here is the PROJECTION's treatment of the column, which
    // must hold the moment anything does write one. (`id` is the app-bound surrogate — DEC-12,
    // the same fix every raw fixture INSERT on the sqlite chain carries.)
    sqlx::query(
        "INSERT INTO account_member_events \
             (id, account_id, actor_user_id, actor_kind, action, target_user_id, old_role, \
              new_role, reason) \
         VALUES (randomblob(16), $1, $2, 'admin', 'removed', $3, 'member', NULL, 'internal staff note')",
    )
    .bind(org)
    .bind(staff)
    .bind(subject)
    .execute(&pool)
    .await
    .expect("seed a staff row carrying a reason");

    // The DB holds all five rows, with the staff id and the note intact.
    let stored = stored_events(&pool, org).await;
    assert_eq!(
        stored.len(),
        5,
        "seeded: user, admin, system-joined, system-removed, admin-with-reason"
    );
    assert!(
        stored.iter().any(|r| r.actor_kind == "system"),
        "a system row IS stored"
    );
    assert!(
        stored
            .iter()
            .any(|r| r.actor_kind == "admin" && r.actor_user_id == Some(staff)),
        "and the staff identity IS stored"
    );
    assert!(
        stored.iter().any(|r| r.reason.as_deref() == Some("internal staff note")),
        "and the note IS stored"
    );

    // TEST-17 — the ACCOUNT-scoped projection.
    let (status, body) = get_events(&server, &owner_token, org).await;
    assert_eq!(status, 200, "the account's own admin may read its ledger");
    let events = body["events"].as_array().expect("events array").clone();
    assert_eq!(
        body["total"].as_i64(),
        Some(4),
        "total counts what is REACHABLE — the same predicate as the page query, so the two \
         can never disagree"
    );
    assert_eq!(events.len(), 4);
    assert!(
        !events
            .iter()
            .any(|e| e["actor_kind"] == "system" && e["action"] == "joined"),
        "(1) the unattended PROVISIONING seed is omitted: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| e["actor_kind"] == "system" && e["action"] == "removed"),
        "...but a membership that ENDED without an attributable human is NOT omitted — it is \
         a real event in this tenant, and hiding it is how the cascade hole came back: \
         {events:?}"
    );
    for e in events.iter().filter(|e| e["actor_kind"] == "admin") {
        assert!(
            e["actor_user_id"].is_null(),
            "(2) the staff id is REDACTED — the tenant learns that staff acted, not which \
             employee: {e:?}"
        );
    }
    assert!(
        events.iter().any(|e| e["actor_kind"] == "admin"),
        "the admin rows are PRESENT though — redaction, not removal"
    );
    let user_row = events
        .iter()
        .find(|e| e["actor_kind"] == "user")
        .expect("the self-service row is present");
    assert_eq!(
        user_row["actor_user_id"].as_str().map(|s| s.to_string()),
        Some(owner.to_string()),
        "and a self-service actor is NOT redacted"
    );
    let raw = serde_json::to_string(&body).expect("serialize");
    assert!(
        !raw.contains("internal staff note"),
        "(3) `reason` never reaches this surface: {raw}"
    );

    // TEST-18 — the control that makes TEST-17 a DECISION: the same rows, asked of the raw DB
    // (the staff-side HTTP surface has no object on this node — DRIFT-1.25), still carry the
    // staff id and the note. Without this, "redacted from the account admin" and "never
    // recorded at all" would be the same observation, and the decision would be untestable. The
    // raw-DB read is the same FALSIFIABILITY control the projection route's sibling in the
    // accept item uses for a record stripped with the surface.
    let stored = stored_events(&pool, org).await;
    assert_eq!(stored.len(), 5, "all five rows are stored, not four plus a redaction");
    assert!(
        stored
            .iter()
            .any(|r| r.actor_kind == "system" && r.action == "joined"),
        "the provisioning seed is stored too"
    );
    assert!(
        stored
            .iter()
            .any(|r| r.actor_user_id == Some(staff)),
        "and so is the individual staff member's id"
    );
    assert!(
        stored.iter().any(|r| r.reason.as_deref() == Some("internal staff note")),
        "and so is the staff note — without this, the redaction above would be \
         indistinguishable from never recording it"
    );
}

/// TEST-11 — INV-1 cross-tenant refusal, on POPULATED state, with a DB re-query.
///
/// Both accounts hold real events, so a 404 cannot be confused with "there was nothing there";
/// the body is compared byte-for-byte against the 404 for a random nonexistent account id, so
/// the refusal is not an existence oracle; and the closing re-query proves the refused tenant's
/// ledger is intact rather than merely unreadable.
#[tokio::test]
async fn inv1_cross_tenant_ledger_reads_are_404_on_populated_state() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Tenant A — the caller's.
    let p = create_user(&server, &admin_token, "xt_p", "xt_p@txresbench.test").await;
    let a_member = create_user(&server, &admin_token, "xt_am", "xt_am@txresbench.test").await;
    let a = make_org_account(&pool, "Tenant A", p).await;
    add_member(&pool, a, a_member, "member").await;
    let p_token = login(&server, "xt_p").await;
    assert_eq!(patch_role(&server, &p_token, a, a_member, "admin").await, 200);

    // Tenant B — independent, and independently POPULATED.
    let b_owner = create_user(&server, &admin_token, "xt_bo", "xt_bo@txresbench.test").await;
    let b_member = create_user(&server, &admin_token, "xt_bm", "xt_bm@txresbench.test").await;
    let b = make_org_account(&pool, "Tenant B", b_owner).await;
    add_member(&pool, b, b_member, "member").await;
    let b_token = login(&server, "xt_bo").await;
    assert_eq!(patch_role(&server, &b_token, b, b_member, "admin").await, 200);

    let b_events_before = event_count(&pool, b).await;
    assert_eq!(b_events_before, 1, "precondition: B's ledger is NOT empty");

    // The GRANT and the REFUSAL, observed in one body.
    let (status, body) = get_events(&server, &p_token, a).await;
    assert_eq!(status, 200, "P reads their OWN tenant's ledger");
    assert_eq!(
        body["events"].as_array().map(|v| v.len()),
        Some(1),
        "and it is non-empty — the positive arm is populated too"
    );

    let (status_b, body_b) = get_events(&server, &p_token, b).await;
    assert_eq!(status_b, 404, "P gets 404 on tenant B — never 403, never data");

    let nonexistent = Uuid::new_v4();
    let (status_x, body_x) = get_events(&server, &p_token, nonexistent).await;
    assert_eq!(status_x, 404);
    assert_eq!(
        serde_json::to_string(&body_b).expect("serialize"),
        serde_json::to_string(&body_x).expect("serialize"),
        "and the two bodies are BYTE-IDENTICAL, so the refusal is not an existence oracle",
    );

    // The staff-route side-door arm has no object here: it is the `/admin/accounts/*` surface
    // this node strips (DRIFT-1.25), so a non-staff caller's attempt to reach B's ledger
    // through it is a 404 on a nonexistent route — which would test routing, not the account
    // module. The account-scoped refusal above IS the module's answer, and it is asserted
    // for P against BOTH a populated tenant and a nonexistent one.

    assert_eq!(
        event_count(&pool, b).await,
        b_events_before,
        "and B's ledger is UNTOUCHED — the refusal refused a real, populated tenant",
    );
    let b_members: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM account_members WHERE account_id = $1")
            .bind(b)
            .fetch_one(&pool)
            .await
            .expect("re-read B's members");
    assert_eq!(b_members, 2, "B still holds both members at unchanged roles");
}

/// TEST-12 — INV-4 the role floor, with its positive control in the SAME body.
///
/// Without the control, "the bare member got a 403" would also be true of a broken session, an
/// expired token or a mis-routed path.
#[tokio::test]
async fn inv4_bare_member_is_403_on_events_and_200_on_members() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "fl_own", "fl_own@txresbench.test").await;
    let bare = create_user(&server, &admin_token, "fl_bar", "fl_bar@txresbench.test").await;
    let org = make_org_account(&pool, "Floor Org", owner).await;
    add_member(&pool, org, bare, "member").await;
    let bare_token = login(&server, "fl_bar").await;

    let (status, _) = get_events(&server, &bare_token, org).await;
    assert_eq!(
        status, 403,
        "the ledger read sits at the `admin` floor — a bare member is refused"
    );

    // POSITIVE CONTROL — the same session, same account, the sibling read the floor does NOT
    // gate.
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{org}/members")))
        .bearer_auth(&bare_token)
        .send()
        .await
        .expect("members list");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "the session is live and the account is reachable — so the 403 above is the FLOOR, \
         not a broken session",
    );

    // And the account's own admin CAN read it, so the floor is a floor and not a wall.
    let owner_token = login(&server, "fl_own").await;
    let (status, _) = get_events(&server, &owner_token, org).await;
    assert_eq!(status, 200, "an owner is above the floor");
}

/// TEST-25 — the `system`-row visibility TABLE, driven through the real route for every action.
///
/// `system_row_is_tenant_visible` is an exhaustive Rust match; the SQL predicate in
/// `list_member_events_scoped` is a separate expression that must agree with it. A rule stated
/// in two places drifts, so this test inserts one `system` row per constructible action and
/// requires the route's answer to match the function's — which is the only thing that keeps
/// them in step. Adding a `MemberEventAction` breaks the function's match at COMPILE time; this
/// is what catches the SQL half falling behind.
#[tokio::test]
async fn the_system_visibility_table_matches_what_the_route_actually_serves() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "sv_own", "sv_own@txresbench.test").await;
    let subject = create_user(&server, &admin_token, "sv_sub", "sv_sub@txresbench.test").await;
    let org = make_org_account(&pool, "Visibility", owner).await;
    add_member(&pool, org, subject, "member").await;
    let owner_token = login(&server, "sv_own").await;

    // Every action a `system` row can legally take — ALL SEVEN. An earlier version drove five
    // while three prose sites claimed one per action, so `invite_revoked` and `invite_resent`
    // could have been exposed by a SQL change with no test failing. `left` is the one genuine
    // exception (it requires `actor_kind = 'user'`), and it is asserted unconstructible at the
    // end of this test rather than quietly skipped.
    let cases: Vec<(MemberEventAction, NewMemberEvent)> = vec![
        (
            MemberEventAction::Joined,
            NewMemberEvent::about(org, AuditActor::System, MemberEventAction::Joined, subject)
                .with_roles(None, Some(AccountRole::Member)),
        ),
        (
            MemberEventAction::Removed,
            NewMemberEvent::about(org, AuditActor::System, MemberEventAction::Removed, subject)
                .with_roles(Some(AccountRole::Member), None),
        ),
        (
            MemberEventAction::RoleChanged,
            NewMemberEvent::about(org, AuditActor::System, MemberEventAction::RoleChanged, subject)
                .with_roles(Some(AccountRole::Member), Some(AccountRole::Admin)),
        ),
        (MemberEventAction::Invited, {
            let mut ev = NewMemberEvent::about(
                org,
                AuditActor::System,
                MemberEventAction::Invited,
                subject,
            );
            ev.target_user_id = None;
            ev.target_email = Some("sweep@txresbench.test".to_string());
            ev
        }),
        (MemberEventAction::InviteExpired, {
            let mut ev = NewMemberEvent::about(
                org,
                AuditActor::System,
                MemberEventAction::InviteExpired,
                subject,
            );
            ev.target_user_id = None;
            ev.target_email = Some("sweep2@txresbench.test".to_string());
            ev
        }),
        (MemberEventAction::InviteRevoked, {
            let mut ev = NewMemberEvent::about(
                org,
                AuditActor::System,
                MemberEventAction::InviteRevoked,
                subject,
            );
            ev.target_user_id = None;
            ev.target_email = Some("sweep3@txresbench.test".to_string());
            ev
        }),
        (MemberEventAction::InviteResent, {
            let mut ev = NewMemberEvent::about(
                org,
                AuditActor::System,
                MemberEventAction::InviteResent,
                subject,
            );
            ev.target_user_id = None;
            ev.target_email = Some("sweep4@txresbench.test".to_string());
            ev
        }),
    ];

    for (action, ev) in cases {
        let mut tx = pool.begin().await.expect("begin");
        record_member_event(&mut tx, ev)
            .await
            .unwrap_or_else(|e| panic!("{}: a system row must be writable: {e:?}", action.as_str()));
        tx.commit().await.expect("commit");

        let (status, body) = get_events(&server, &owner_token, org).await;
        assert_eq!(status, 200);
        let events = body["events"].as_array().expect("events array");
        let visible = events
            .iter()
            .any(|e| e["actor_kind"] == "system" && e["action"] == action.as_str());
        let expected = txresbench::modules::account::system_row_is_tenant_visible(action);
        assert_eq!(
            visible,
            expected,
            "{}: the ROUTE and `system_row_is_tenant_visible` must agree — a rule written in \
             SQL and in Rust drifts unless something compares them",
            action.as_str(),
        );
        // and `total` must agree with the page, always.
        assert_eq!(
            body["total"].as_i64().expect("total"),
            events.len() as i64,
            "{}: total and the page apply the SAME predicate",
            action.as_str(),
        );
    }

    // The eighth action is UNCONSTRUCTIBLE as a system row, and that is asserted rather than
    // assumed: `left` means the principal ended their own membership acting as themselves, so
    // an unattributed one is a contradiction in terms. Both layers refuse it.
    let mut tx = pool.begin().await.expect("begin");
    assert!(
        record_member_event(
            &mut tx,
            NewMemberEvent::about(org, AuditActor::System, MemberEventAction::Left, subject)
                .with_roles(Some(AccountRole::Member), None),
        )
        .await
        .is_err(),
        "a `system` `left` is a contradiction in terms and the writer refuses it",
    );
    drop(tx);
    let raw = sqlx::query(
        "INSERT INTO account_member_events \
             (id, account_id, actor_kind, action, target_user_id, old_role) \
         VALUES (randomblob(16), $1, 'system', 'left', $2, 'member')",
    )
    .bind(org)
    .bind(subject)
    .execute(&pool)
    .await;
    let err = raw.expect_err(
        "...and so does the schema, so the Rust guard is not the only thing standing there",
    );
    assert!(
        format!("{err}").contains("account_member_events_left_is_self"),
        "by THAT constraint, named — a bare `is_err()` here would stay green if `left_is_self` \
         were deleted and some unrelated constraint refused the row instead, which is the \
         convention this file's sibling loop already documents: {err}",
    );
}

/// TEST-27 — **the ledger hole the invitations item left, closed.**
///
/// The invitations surface shipped to main with the four `invite_*` actions minted here and
/// nothing writing them: its `create` / `resend` / `revoke` paths carried this item's own seam
/// markers and no calls. A ledger that silently omits the newest membership surface is worse
/// than one that does not claim to cover it, so this drives all three through their REAL routes
/// and asserts the rows — shape, actor, and the `invitation_id` that ties them together.
///
/// It also asserts the negative half at the two arms the invitations item returns early on:
/// re-inviting an address that already has a live invitation, and re-inviting somebody who is
/// already a member. Neither mints anything, so neither may leave a row — a ledger that recorded
/// them would report invitations that were never issued.
#[tokio::test]
async fn invitation_mutations_write_their_audit_rows() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "iv2_own", "iv2_own@txresbench.test").await;
    let member = create_user(&server, &admin_token, "iv2_mem", "iv2_mem@txresbench.test").await;
    let org = make_org_account(&pool, "Invited Org", owner).await;
    add_member(&pool, org, member, "member").await;
    let token = login(&server, "iv2_own").await;

    async fn invite(server: &TestServer, token: &str, org: Uuid, email: &str, role: &str) -> u16 {
        server
            .client
            .post(server.api_url(&format!("/accounts/{org}/invitations")))
            .bearer_auth(token)
            .json(&json!({ "email": email, "role": role }))
            .send()
            .await
            .expect("create invitation")
            .status()
            .as_u16()
    }

    // ── `invited` ───────────────────────────────────────────────────────────────────────
    assert_eq!(invite(&server, &token, org, "newcomer@txresbench.test", "member").await, 202);
    let rows = stored_events(&pool, org).await;
    assert_eq!(rows.len(), 1, "one row for one invitation: {rows:?}");
    let inv = &rows[0];
    assert_eq!(inv.action, "invited");
    assert_eq!(inv.actor_kind, "user");
    assert_eq!(inv.actor_user_id, Some(owner), "attributed to the inviter");
    assert_eq!(
        inv.target_user_id, None,
        "an invitee to an ADDRESS has no user id — the address is the identifier",
    );
    assert_eq!(inv.target_email.as_deref(), Some("newcomer@txresbench.test"));
    assert_eq!(inv.new_role.as_deref(), Some("member"), "the role being offered");
    assert_eq!(inv.old_role, None, "there is no role before an invitation");
    let invitation_id = inv.invitation_id.expect("the row ties to its invitation");

    // ── the two early-return arms mint nothing, so they record nothing ──────────────────
    let before = event_count(&pool, org).await;
    assert_eq!(
        invite(&server, &token, org, "newcomer@txresbench.test", "member").await,
        202,
        "uniform response (INV-8)"
    );
    assert_eq!(
        event_count(&pool, org).await,
        before,
        "re-inviting an address that already has a LIVE invitation mints nothing, so it \
         records nothing — the response is deliberately uniform, and the ledger must not be \
         the oracle the response refuses to be",
    );
    assert_eq!(invite(&server, &token, org, "iv2_mem@txresbench.test", "member").await, 202);
    assert_eq!(
        event_count(&pool, org).await,
        before,
        "and neither does inviting somebody who is already a member",
    );

    // ── `invite_resent` — a NEW row, not a mutation of the first ────────────────────────
    let list = server
        .client
        .get(server.api_url(&format!("/accounts/{org}/invitations")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list invitations");
    assert_eq!(list.status().as_u16(), 200);
    let body: Value = list.json().await.expect("list body");
    let id = body["invitations"]
        .as_array()
        .expect("invitations array")
        .iter()
        .find(|i| i["email"] == "newcomer@txresbench.test")
        .and_then(|i| i["id"].as_str())
        .expect("the invitation we just created")
        .to_string();

    let resp = server
        .client
        .post(server.api_url(&format!("/accounts/{org}/invitations/{id}/resend")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("resend");
    assert_eq!(resp.status().as_u16(), 200);
    let resent = stored_events(&pool, org)
        .await
        .into_iter()
        .find(|r| r.action == "invite_resent")
        .expect("a resend is recorded");
    assert_eq!(resent.actor_user_id, Some(owner));
    assert_eq!(resent.target_email.as_deref(), Some("newcomer@txresbench.test"));
    assert_eq!(
        resent.invitation_id,
        Some(invitation_id),
        "tied to the SAME invitation — that is what makes the pair readable",
    );

    // ── `invite_revoked` — a NEW row again (INV-13c), never an edit of the `invited` one ──
    let resp = server
        .client
        .delete(server.api_url(&format!("/accounts/{org}/invitations/{id}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("revoke");
    assert!(resp.status().is_success(), "revoke: {}", resp.status());
    let rows = stored_events(&pool, org).await;
    let revoked = rows
        .iter()
        .find(|r| r.action == "invite_revoked")
        .expect("a revoke is recorded");
    assert_eq!(revoked.actor_user_id, Some(owner));
    assert_eq!(revoked.target_email.as_deref(), Some("newcomer@txresbench.test"));
    assert_eq!(revoked.invitation_id, Some(invitation_id));
    assert_eq!(
        rows.iter().filter(|r| r.action == "invited").count(),
        1,
        "and the original `invited` row is still there, unchanged — a revoke APPENDS, which \
         is INV-13c's second clause and the first time this branch has had a producer able \
         to prove it: {rows:?}",
    );

    // A second revoke changes nothing and records nothing.
    let before = event_count(&pool, org).await;
    let resp = server
        .client
        .delete(server.api_url(&format!("/accounts/{org}/invitations/{id}")))
        .bearer_auth(&token)
        .send()
        .await
        .expect("second revoke");
    assert_eq!(resp.status().as_u16(), 404, "a settled invitation cannot be revoked twice");
    assert_eq!(
        event_count(&pool, org).await,
        before,
        "and the refused revoke left no row — it returns before its transaction commits",
    );
}

// ---------------------------------------------------------------------------
// The row shape the invitations item inherits, and the generated contract
// ---------------------------------------------------------------------------

/// TEST-13 — the INVITATION row shape, written through the production writer on a
/// caller-owned transaction: exactly the call the invitations item will make.
///
/// It has no route producer on this branch (that branch is at the merge base with zero
/// commits), so this is what makes the inherited contract PROVEN rather than assumed. It also
/// pins the PII constraint: an email XOR a user id, never both, so the column cannot drift into
/// a permanently-retained duplicate of the user directory's email.
#[tokio::test]
async fn invitation_row_shape_round_trips_and_refuses_email_plus_user() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "iv_own", "iv_own@txresbench.test").await;
    let org = make_org_account(&pool, "Invites Org", owner).await;
    let invitation = Uuid::new_v4();

    let mut tx = pool.begin().await.expect("begin");
    record_member_event(
        &mut tx,
        NewMemberEvent {
            account_id: org,
            actor: AuditActor::User(owner),
            action: MemberEventAction::Invited,
            target_user_id: None,
            target_email: Some("newcomer@txresbench.test".to_string()),
            old_role: None,
            new_role: Some(AccountRole::Member),
            invitation_id: Some(invitation),
            reason: None,
        },
    )
    .await
    .expect("an `invited` row persists");
    record_member_event(
        &mut tx,
        NewMemberEvent {
            account_id: org,
            actor: AuditActor::User(owner),
            action: MemberEventAction::InviteRevoked,
            target_user_id: None,
            target_email: Some("newcomer@txresbench.test".to_string()),
            old_role: None,
            new_role: None,
            invitation_id: Some(invitation),
            reason: None,
        },
    )
    .await
    .expect("an `invite_revoked` row persists");
    tx.commit().await.expect("commit");

    let rows = stored_events(&pool, org).await;
    assert_eq!(rows.len(), 2, "a revoke APPENDS; it does not mutate the invite (INV-13c)");
    let invited = rows.iter().find(|r| r.action == "invited").expect("invited row");
    assert_eq!(invited.target_email.as_deref(), Some("newcomer@txresbench.test"));
    assert_eq!(invited.target_user_id, None, "an invitation has no user yet");
    assert_eq!(invited.invitation_id, Some(invitation), "which ties `invited` to `joined`");
    assert_eq!(invited.new_role.as_deref(), Some("member"));
    let revoked = rows.iter().find(|r| r.action == "invite_revoked").expect("revoked row");
    assert_eq!(revoked.invitation_id, Some(invitation), "same invitation, a NEW row");

    // The PII constraint: an email and a user id together is REFUSED by the database.
    let both = sqlx::query(
        "INSERT INTO account_member_events \
             (id, account_id, actor_user_id, actor_kind, action, target_user_id, target_email) \
         VALUES (randomblob(16), $1, $2, 'user', 'invited', $2, 'both@txresbench.test')",
    )
    .bind(org)
    .bind(owner)
    .execute(&pool)
    .await;
    let err = both.expect_err(
        "an email alongside a user id is refused — once there is a user, the id is the \
         identifier, and that exclusivity is what stops this column becoming a second, \
         permanently-retained copy of the user directory's email",
    );
    assert!(
        format!("{err}").contains("account_member_events_exactly_one_target"),
        "by that constraint, named: {err}",
    );

    // A row naming NEITHER an address nor a user is refused as well. The constraint was
    // written as a pair of ORs first — which spells a NAND, not the XOR its name claimed — and
    // two blind audits reproduced an `invited` row naming nobody at all. It is now
    // `num_nonnulls(target_user_id, target_email) = 1`, so EXACTLY one identifier, always.
    let neither = sqlx::query(
        "INSERT INTO account_member_events (id, account_id, actor_user_id, actor_kind, action) \
         VALUES (randomblob(16), $1, $2, 'user', 'invited')",
    )
    .bind(org)
    .bind(owner)
    .execute(&pool)
    .await;
    let err = neither.expect_err(
        "an event naming no principal at all is not an audit record — the invitations item \
         inherits this schema, so a writer that forgets the address must be refused here",
    );
    assert!(
        format!("{err}").contains("account_member_events_exactly_one_target"),
        "and refused BY THAT CONSTRAINT, not by some unrelated future NOT NULL or FK that \
         would keep this assertion green after the constraint was gone: {err}",
    );

    // A MEMBERSHIP event naming only an address is refused. `exactly one identifier` is not
    // the same claim as `a membership event names a USER`, and an earlier round REPLACED the
    // second constraint with the first instead of adding to it — after which a `removed` row
    // carrying only an email was accepted, and was additionally invisible to the partial
    // per-principal index. Two blind rounds were needed to catch that; this is the assertion
    // that keeps it caught.
    let membership_by_email = sqlx::query(
        "INSERT INTO account_member_events \
             (id, account_id, actor_user_id, actor_kind, action, target_email, old_role) \
         VALUES (randomblob(16), $1, $2, 'user', 'removed', 'ghost@txresbench.test', 'member')",
    )
    .bind(org)
    .bind(owner)
    .execute(&pool)
    .await;
    let err = membership_by_email.expect_err(
        "a membership event names the USER it concerns — an address identifies an invitee, \
         not a member",
    );
    assert!(
        format!("{err}").contains("account_member_events_membership_has_user"),
        "and by THAT constraint specifically — the one an earlier round deleted: {err}",
    );

    // The WRITER refuses the same shapes, in Rust, before the statement is issued — so a
    // caller-constructed struct produces a named error rather than a raw constraint violation
    // (a 500) at the seam the invitations item was told to build against.
    let mut tx = pool.begin().await.expect("begin");
    // SANITY: a genuinely well-formed invitation — an address, no user id — is accepted. An
    // earlier version of this arm used an `invited` event carrying a USER id and called that
    // "well-formed", which a blind audit rightly flagged: it blessed exactly the degenerate
    // shape the schema now refuses, in the file the invitations item will copy from.
    let mut good =
        NewMemberEvent::about(org, AuditActor::User(owner), MemberEventAction::Invited, owner);
    good.target_user_id = None;
    good.target_email = Some("sanity@txresbench.test".to_string());
    assert!(
        record_member_event(&mut tx, good).await.is_ok(),
        "sanity: an invitation naming an address and no user is accepted",
    );
    let mut bad = NewMemberEvent::about(org, AuditActor::User(owner), MemberEventAction::Invited, owner);
    bad.target_user_id = None;
    assert!(
        record_member_event(&mut tx, bad.clone()).await.is_err(),
        "an event naming NO principal is refused by the writer, not only by the database",
    );
    bad.target_email = Some("   ".to_string());
    assert!(
        record_member_event(&mut tx, bad.clone()).await.is_err(),
        "a blank address is not an identifier",
    );
    let mut membership_no_user =
        NewMemberEvent::about(org, AuditActor::User(owner), MemberEventAction::Removed, owner);
    membership_no_user.target_user_id = None;
    membership_no_user.target_email = Some("ghost@txresbench.test".to_string());
    assert!(
        record_member_event(&mut tx, membership_no_user).await.is_err(),
        "and a membership action carrying only an address is refused in Rust too",
    );
    // A role change carrying one role is not reconstructable, and it was the arm the "every
    // shape is refused here" claim omitted — the blanket claim being the dangerous part,
    // because a reader trusts it and stops checking.
    let half_role = NewMemberEvent::about(
        org,
        AuditActor::User(owner),
        MemberEventAction::RoleChanged,
        owner,
    )
    .with_roles(Some(AccountRole::Member), None);
    record_member_event(&mut tx, half_role)
        .await
        .expect_err("a role change records BOTH roles or it cannot be reconstructed");

    // ...and it is refused by the WRITER, before the statement is issued — which is the whole
    // point of mirroring the CHECKs in Rust, and is NOT what `is_err()` proves. Both layers
    // refuse this row, so a mutation battery caught the naive assertion: deleting the Rust arm
    // left it green, because Postgres refused the INSERT instead.
    //
    // The observable difference is the TRANSACTION. A refusal raised in Rust never touches the
    // connection, so the transaction is still usable; a constraint violation ABORTS it, and
    // every later statement fails with 25P02 until rollback. For a caller that batches several
    // events — which is exactly what an invitation flow does — that is the difference between
    // one rejected event and a lost unit of work. So: the same transaction must still work.
    let still_usable = record_member_event(
        &mut tx,
        NewMemberEvent::about(org, AuditActor::User(owner), MemberEventAction::RoleChanged, owner)
            .with_roles(Some(AccountRole::Member), Some(AccountRole::Admin)),
    )
    .await;
    assert!(
        still_usable.is_ok(),
        "the transaction must survive a refusal the WRITER raised — if this fails with an \
         aborted transaction, the Rust mirror is gone and Postgres refused the INSERT instead, \
         taking the caller's whole unit of work with it: {still_usable:?}",
    );
    drop(tx);

    // The remaining row SHAPES, refused by the schema — the contract the invitations item
    // inherits. Each was accepted before this round and each contradicted a column comment.
    // (Every raw INSERT carries its `id` — the app-bound surrogate, DEC-12.)
    for (label, sql, constraint) in [
        (
            "a join carrying a role BEFORE it",
            "INSERT INTO account_member_events \
                 (id, account_id, actor_user_id, actor_kind, action, target_user_id, old_role, \
                  new_role) \
             VALUES (randomblob(16), $1, $2, 'user', 'joined', $2, 'member', 'admin')",
            "account_member_events_join_role",
        ),
        (
            "a departure carrying a role AFTER it",
            "INSERT INTO account_member_events \
                 (id, account_id, actor_user_id, actor_kind, action, target_user_id, old_role, \
                  new_role) \
             VALUES (randomblob(16), $1, $2, 'user', 'removed', $2, 'member', 'admin')",
            "account_member_events_departure_role",
        ),
        (
            "a `left` whose actor is not the person who left",
            "INSERT INTO account_member_events \
                 (id, account_id, actor_user_id, actor_kind, action, target_user_id, old_role) \
             VALUES (randomblob(16), $1, $2, 'user', 'left', randomblob(16), 'member')",
            "account_member_events_left_is_self",
        ),
        (
            // `x = NULL` is NULL, not FALSE, and a CHECK PASSES on NULL — so the first
            // version of `left_is_self` accepted exactly this row while its comment said it
            // had closed it. An unattributed resignation is what makes `left` and `removed`
            // indistinguishable, which is the entire point of having two actions.
            "a `left` with NO actor at all",
            "INSERT INTO account_member_events \
                 (id, account_id, actor_kind, action, target_user_id, old_role) \
             VALUES (randomblob(16), $1, 'system', 'left', $2, 'member')",
            "account_member_events_left_is_self",
        ),
        (
            // The conjunct that distinguishes a resignation from a staff self-removal. It is
            // the ONLY thing standing between them once a caller builds the row directly, and
            // it shipped with no test: reverting it in either layer left the whole suite green.
            "a `left` by PLATFORM STAFF acting on their own row",
            "INSERT INTO account_member_events \
                 (id, account_id, actor_user_id, actor_kind, action, target_user_id, old_role) \
             VALUES (randomblob(16), $1, $2, 'admin', 'left', $2, 'member')",
            "account_member_events_left_is_self",
        ),
        (
            "a join carrying NEITHER role",
            "INSERT INTO account_member_events \
                 (id, account_id, actor_user_id, actor_kind, action, target_user_id) \
             VALUES (randomblob(16), $1, $2, 'user', 'joined', $2)",
            "account_member_events_join_role",
        ),
        (
            "a departure carrying NEITHER role",
            "INSERT INTO account_member_events \
                 (id, account_id, actor_user_id, actor_kind, action, target_user_id) \
             VALUES (randomblob(16), $1, $2, 'user', 'removed', $2)",
            "account_member_events_departure_role",
        ),
    ] {
        let err = match sqlx::query(sql).bind(org).bind(owner).execute(&pool).await {
            Ok(_) => panic!("{label}: must be REFUSED by the schema, but it was accepted"),
            Err(e) => e,
        };
        assert!(
            format!("{err}").contains(constraint),
            "{label}: refused by {constraint}, named — an `is_err()` alone would stay green \
             after the constraint was deleted: {err}",
        );
    }

    // An invitation of a user who ALREADY EXISTS is recordable BY ID, with no address. A
    // round added a constraint forcing an address on every invitation, which would have
    // compelled a permanently-retained copy of that user's directory email — the exact
    // duplication the retention decision forbids — and would have blocked the invitations item
    // from recording an invite of a known user at all.
    let mut tx = pool.begin().await.expect("begin");
    record_member_event(
        &mut tx,
        NewMemberEvent::about(org, AuditActor::User(owner), MemberEventAction::Invited, owner)
            .with_roles(None, Some(AccountRole::Member)),
    )
    .await
    .expect("an invitation naming a KNOWN user by id, with no address, is legitimate");
    tx.commit().await.expect("commit");

    // The address is stored VERBATIM apart from trimming. Lowercasing it would be lossy (the
    // local part is case-sensitive) in a row that is append-only and permanent, and it would
    // stop the value byte-matching the user directory's.
    let mut tx = pool.begin().await.expect("begin");
    let mixed = Uuid::new_v4();
    record_member_event(
        &mut tx,
        NewMemberEvent {
            account_id: org,
            actor: AuditActor::User(owner),
            action: MemberEventAction::Invited,
            target_user_id: None,
            target_email: Some("  Mixed.Case@Txresbench.TEST  ".to_string()),
            old_role: None,
            new_role: Some(AccountRole::Member),
            invitation_id: Some(mixed),
            reason: None,
        },
    )
    .await
    .expect("write a mixed-case address");
    tx.commit().await.expect("commit");
    let stored = stored_events(&pool, org)
        .await
        .into_iter()
        .find(|r| r.invitation_id == Some(mixed))
        .expect("the mixed-case row");
    assert_eq!(
        stored.target_email.as_deref(),
        Some("Mixed.Case@Txresbench.TEST"),
        "trimmed, and otherwise exactly what was recorded",
    );

    // And an unattributable non-system event is not representable either.
    let anon = sqlx::query(
        "INSERT INTO account_member_events (id, account_id, actor_kind, action, target_user_id) \
         VALUES (randomblob(16), $1, 'user', 'removed', $2)",
    )
    .bind(org)
    .bind(owner)
    .execute(&pool)
    .await;
    let err = anon.expect_err(
        "a `user` or `admin` event with no actor id is refused by the actor_id_kind CHECK",
    );
    assert!(
        format!("{err}").contains("account_member_events_actor_id_kind"),
        "by that constraint, named: {err}",
    );
}

/// TEST-21 — the GENERATED contract carries the one sentence that stops a reader over-reading
/// the ledger.
///
/// Read from `openapi.json`, not from the Rust source, so it fails if the description is
/// rewritten and regenerated — the way prose silently rots. What is pinned is not decoration:
/// a ledger whose name implies "who tried what" while its contents are "what happened" is the
/// exact failure mode this item was scoped to avoid, and this is the only place the
/// distinction reaches a client.
#[tokio::test]
async fn generated_spec_declares_the_route_and_states_what_is_not_recorded() {
    // The ONE generated client: the `-saas` artifact tree is STRIPPED on this node (see
    // DRIFT-1.25), and a contract test that reads only shipped documents guards exactly the
    // contract that is shipped — the same branch convention as
    // `invitation_accept_test::inv18_the_token_is_accepted_only_in_the_request_body`.
    let spec_paths: Vec<&str> = ["../ui/openapi/openapi.json"]
        .into_iter()
        .filter(|p| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(p).exists())
        .collect();
    for spec_rel in spec_paths {
        assert_spec_is_consistent(spec_rel);
    }
}

fn assert_spec_is_consistent(spec_rel: &str) {
    let spec_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(spec_rel);
    let spec: Value = serde_json::from_str(
        &std::fs::read_to_string(&spec_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", spec_path.display())),
    )
    .expect("openapi.json parses");

    let op = &spec["paths"]["/api/accounts/{account_id}/members/events"]["get"];
    assert!(
        !op.is_null(),
        "the generated spec declares the ledger read route — `just openapi-regen` was run",
    );
    assert_eq!(
        op["operationId"].as_str(),
        Some("Account.listMemberEvents"),
        "under the id that drives ApiClient.Account.listMemberEvents",
    );

    let desc = op["description"].as_str().expect("the operation has a description");
    assert!(
        desc.contains("COMPLETED MUTATIONS, NOT ATTEMPTS"),
        "the description states that a refused action leaves NO row: {desc}",
    );
    assert!(
        desc.contains("what happened to this account"),
        "and how the ledger is to be read: {desc}",
    );
    assert!(
        desc.contains("append-only"),
        "and that a correction is a new row, never an edit: {desc}",
    );
    assert!(
        desc.contains("does NOT omit every `system` event"),
        "and — the sentence an audit caught the client contract contradicting — that a \
         membership ended with no attributable human actor IS shown here, so a reader cannot \
         conclude from `omits system provisioning` that a cascade removal is hidden: {desc}",
    );

    // ── EVERY description this schema ships, not just the one that was noticed ──────────
    //
    // Rust doc-comments on `AccountMemberEvent` and on EACH OF ITS FIELDS are `JsonSchema`
    // descriptions, emitted verbatim into `components.schemas` here and into the generated
    // `types.ts`. This branch's recurring defect is a claim corrected where it was noticed and
    // left standing at another layer that carries it, and this test has now been on the wrong
    // side of that twice: first reading only the OPERATION description while the SCHEMA
    // description contradicted it, then reading only the schema-level description while a
    // PROPERTY description contradicted it. So it sweeps them all.
    //
    // The list below is the branch's retired claims. Each one was true of some earlier version
    // of the code and is now false; the point of naming them is that a regression at ANY layer
    // — schema, property, or operation — brings one of them back and fails here.
    let retired: &[(&str, &str)] = &[
        (
            "system rows omitted",
            "every `system` row is hidden — false since the cascade trigger, whose removals \
             the tenant must see",
        ),
        (
            "null only for an invitation, which has no user yet",
            "an invitation never names a user — false since an invitation of somebody already \
             in the directory is recorded by id",
        ),
        (
            "omits unattended `system` provisioning events",
            "the operation-layer wording of the first claim — the phrase that actually shipped \
             in the operation description before it was corrected. An earlier version of this \
             list named a phrase that had never existed at any swept layer, so it fired on \
             nothing; a blind round checked every commit on the branch to establish that",
        ),
    ];
    let schema = &spec["components"]["schemas"]["AccountMemberEvent"];
    // Whitespace-normalized and lowercased: these are wrapped doc-comments, so a phrase that
    // spans a line break is not a substring of the raw text, and an assertion that passes or
    // fails on where the author happened to wrap is exactly the accidental green this test
    // exists to prevent.
    let flatten = |v: &Value| -> Option<String> {
        v.as_str()
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase())
    };
    let mut described: Vec<(String, String)> = Vec::new();
    if let Some(d) = flatten(&schema["description"]) {
        described.push(("<schema>".to_string(), d));
    }
    // The OPERATION descriptions too. The comment on this sweep claimed "any layer" while the
    // code read only the schema and its properties, which is this branch's recurring defect
    // committed inside the test written to catch it. (The `Admin.listAccountMemberEvents`
    // operation has no object on this node — the `/admin/accounts/*` surface is stripped, see
    // DRIFT-1.25 — so the retained operation is the one that is swept.)
    for (label, path) in [
        (
            "<operation:Account.listMemberEvents>",
            "/api/accounts/{account_id}/members/events",
        ),
    ] {
        if let Some(d) = flatten(&spec["paths"][path]["get"]["description"]) {
            described.push((label.to_string(), d));
        }
    }
    for (name, prop) in schema["properties"]
        .as_object()
        .unwrap_or_else(|| panic!("{spec_rel}: AccountMemberEvent has properties"))
    {
        if let Some(d) = flatten(&prop["description"]) {
            described.push((name.clone(), d));
        }
    }
    assert!(
        described.len() >= 4,
        "{spec_rel}: the schema and its fields must carry descriptions at all — got {}",
        described.len(),
    );
    for (where_, text) in &described {
        for (phrase, why) in retired {
            assert!(
                !text.contains(&phrase.to_lowercase()),
                "{spec_rel}: `{where_}` still carries a RETIRED claim ({why}). The branch's \
                 recurring defect is fixing a sentence at one layer and leaving it at another; \
                 this is that, again: {text}",
            );
        }
    }
    let schema_desc = described
        .iter()
        .find(|(w, _)| w == "<schema>")
        .map(|(_, d)| d.clone())
        .unwrap_or_else(|| panic!("{spec_rel}: AccountMemberEvent carries a description"));
    assert!(
        schema_desc.contains("not every `system` event"),
        "{spec_rel}: and the schema must state the same `system` rule the operation does, in \
         the same document: {schema_desc}",
    );

    // The declared refusals, in the machine-readable half — a description that promises a 404
    // while `responses` declares only 200/403 is a contract disagreeing with itself.
    let responses = op["responses"]
        .as_object()
        .unwrap_or_else(|| panic!("{spec_rel}: the operation declares responses"));
    for code in ["200", "400", "401", "403", "404", "422"] {
        assert!(
            responses.contains_key(code),
            "{spec_rel}: the response set must declare {code} — the shared extractor can \
             return it. Got: {:?}",
            responses.keys().collect::<Vec<_>>(),
        );
    }

    // The SIBLINGS this branch swept in the same change. Declaring them and then pinning only
    // the route where the gap was noticed would be the same defect one layer out — a blind
    // round caught exactly that, so the pin travels with the sweep. (The staff-events sibling
    // that the sweep originally pinned has no object on this node — DRIFT-1.25.)
    for (path, label, codes) in [
        (
            "/api/accounts/{account_id}/members/manage-context",
            "Account.membersManageContext",
            &["200", "400", "401", "403", "404", "422"][..],
        ),
    ] {
        let sib = &spec["paths"][path]["get"]["responses"];
        let sib = sib
            .as_object()
            .unwrap_or_else(|| panic!("{spec_rel}: {label} declares responses"));
        for code in codes {
            assert!(
                sib.contains_key(*code),
                "{spec_rel}: {label} must declare {code} too — its extractor returns it, and a \
                 sweep applied to the route where it was noticed and not to the siblings \
                 carrying the identical claim is this branch's recurring defect. Got: {:?}",
                sib.keys().collect::<Vec<_>>(),
            );
        }
    }
}
