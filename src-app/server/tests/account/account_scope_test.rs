//! #139 — the `AccountScope<Min>` A9 DENY SUITE (epic #138).
//!
//! Every test here pairs a refusal with a POSITIVE CONTROL in the SAME body. A deny
//! test with no control passes just as well against a build where nothing works at
//! all, and a two-arm comparison whose arms are both empty is structurally incapable
//! of failing — so every arm below asserts on POPULATED state (real accounts with
//! real members and real roles), never on absence alone.
//!
//! Route under test: `GET /api/accounts/{account_id}/members/manage-context`, served
//! behind `AccountScope<RoleAdmin>`.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::account::{
    add_member, create_user, create_user_without_projects, login, make_org_account, pool_for,
    post_accounts, setup_admin, USERS_GROUP_ID,
};
use crate::common::TestServer;

/// Call the proof route for `account`, optionally stamping an `X-Account-Id` header
/// (which this surface must IGNORE — DEC-1). Returns `(status, body)`.
async fn manage_context(
    server: &TestServer,
    token: &str,
    account: &str,
    header_account: Option<Uuid>,
) -> (u16, Value) {
    let mut req = server
        .client
        .get(server.api_url(&format!("/accounts/{account}/members/manage-context")))
        .bearer_auth(token);
    if let Some(h) = header_account {
        req = req.header("X-Account-Id", h.to_string());
    }
    let resp = req.send().await.expect("manage-context request");
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    (status, body)
}

/// The id of `user_id`'s personal account.
async fn personal_account_id(pool: &sqlx::SqlitePool, user_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("personal account exists")
}

// ---------------------------------------------------------------------------
// TEST-4 [acceptance] [invariant: INV-1] [covers: ITEM-3, ITEM-6, ITEM-8]
// ---------------------------------------------------------------------------

/// INV-1 — **cross-tenant access is refused, as a 404** — observed on POPULATED state,
/// both answers in ONE body.
///
/// P is `owner` of organization A and NOT a member of organization B. B is not an
/// empty shell: it has its own owner Q and a `member` R, so the refusal cannot pass
/// merely because there was nothing there. In one body: P ⇒ 200 on A (with a REAL
/// role and a REAL member count asserted), P ⇒ 404 on B, P ⇒ 404 on a random UUID,
/// and the two 404 bodies are byte-identical.
///
/// Why this cannot pass vacuously: a mutation that made membership resolution
/// unconditionally succeed flips the B arm to 200; one that made it unconditionally
/// fail flips the A arm to 404. Both arms are populated, and the A arm asserts
/// concrete values rather than "is 2xx".
#[tokio::test]
async fn inv1_cross_tenant_is_404_while_own_account_is_200() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let p = create_user(&server, &admin, "as_p", "as_p@cyto.test").await;
    let q = create_user(&server, &admin, "as_q", "as_q@cyto.test").await;
    let r = create_user(&server, &admin, "as_r", "as_r@cyto.test").await;

    // Account A — P owns it, and it has a second member so the count is meaningful.
    let account_a = make_org_account(&pool, "Org A", p).await;
    add_member(&pool, account_a, q, "member").await;
    // Account B — POPULATED, and P is deliberately NOT a member.
    let account_b = make_org_account(&pool, "Org B", q).await;
    add_member(&pool, account_b, r, "member").await;

    let p_token = login(&server, "as_p").await;

    // ── POSITIVE CONTROL: P on their OWN account A ⇒ 200, with real values ──
    let (status_a, body_a) = manage_context(&server, &p_token, &account_a.to_string(), None).await;
    assert_eq!(status_a, 200, "P is owner of A: {body_a}");
    assert_eq!(
        body_a["account_id"].as_str(),
        Some(account_a.to_string().as_str()),
        "the response echoes the PATH account id"
    );
    assert_eq!(
        body_a["actor_role"].as_str(),
        Some("owner"),
        "P's REAL role in A — not a hardcoded default"
    );
    assert_eq!(
        body_a["member_count"].as_i64(),
        Some(2),
        "A has exactly its 2 seeded members (P owner + Q member)"
    );

    // ── THE REFUSAL: the same P, the same token, a POPULATED foreign account ⇒ 404 ──
    let (status_b, body_b) = manage_context(&server, &p_token, &account_b.to_string(), None).await;
    assert_eq!(
        status_b, 404,
        "P is not a member of B — must be 404, never 403 (a 403 would confirm B exists): {body_b}"
    );

    // ── And a nonexistent id is INDISTINGUISHABLE from the foreign one ──
    let nowhere = Uuid::new_v4();
    let (status_x, body_x) = manage_context(&server, &p_token, &nowhere.to_string(), None).await;
    assert_eq!(status_x, 404, "a random UUID is 404");
    assert_eq!(
        body_b, body_x,
        "the foreign-account 404 body must be BYTE-IDENTICAL to the nonexistent-account \
         404 body, or the difference is an existence oracle"
    );

    // B really does exist and really is populated — proving the 404 above was an
    // authorization answer, not a "there is nothing there" answer.
    let b_members: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM account_members WHERE account_id = $1")
            .bind(account_b)
            .fetch_one(&pool)
            .await
            .expect("count B members");
    assert_eq!(b_members, 2, "B is populated: P was refused a REAL account");
}

// ---------------------------------------------------------------------------
// TEST-5 [acceptance] [invariant: INV-2] [covers: ITEM-3, ITEM-8]
// ---------------------------------------------------------------------------

/// INV-2 — **the header cannot override the path**, in BOTH directions (DEC-1: the
/// path is authoritative, `X-Account-Id` is ignored).
///
/// The second arm is the one that distinguishes "ignored" from "merely additive": if
/// the extractor reconciled the header at all, `path=A` + `X-Account-Id: B` would be
/// a 400 (the design doc's rejected option (a)) or a 404, not a 200.
#[tokio::test]
async fn inv2_header_cannot_override_path_in_either_direction() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let p = create_user(&server, &admin, "hdr_p", "hdr_p@cyto.test").await;
    let q = create_user(&server, &admin, "hdr_q", "hdr_q@cyto.test").await;
    let account_a = make_org_account(&pool, "Hdr A", p).await; // P is owner
    let account_b = make_org_account(&pool, "Hdr B", q).await; // P is NOT a member

    let p_token = login(&server, "hdr_p").await;

    // ── path=B (non-member) + X-Account-Id: A (owner) ⇒ 404 — the header does not ADMIT
    let (status, body) =
        manage_context(&server, &p_token, &account_b.to_string(), Some(account_a)).await;
    assert_eq!(
        status, 404,
        "an owner header must not admit the caller to a foreign PATH account: {body}"
    );

    // ── path=A (owner) + X-Account-Id: B (non-member) ⇒ 200 — the header does not DENY
    let (status, body) =
        manage_context(&server, &p_token, &account_a.to_string(), Some(account_b)).await;
    assert_eq!(
        status, 200,
        "a foreign header must be IGNORED, not treated as an additional constraint \
         (DEC-1 option (b)): {body}"
    );
    assert_eq!(
        body["account_id"].as_str(),
        Some(account_a.to_string().as_str()),
        "the answer is about the PATH account, not the header account"
    );
    assert_eq!(body["actor_role"].as_str(), Some("owner"));
}

// ---------------------------------------------------------------------------
// TEST-6 [acceptance] [invariant: INV-3] [covers: ITEM-3, ITEM-8]
// ---------------------------------------------------------------------------

/// INV-3 — **the capability is not authority.** A user who HOLDS
/// `account::members::manage` (every user does, via the Users-group grant) but is not
/// a member of B gets 404 — not 200, and specifically **not 403**, because a 403
/// would mean the role floor rejected them, which would confirm B exists.
///
/// This is the test that goes RED if steps 2 and 4 were ever merged into one check.
#[tokio::test]
async fn inv3_holding_the_capability_is_not_authority_over_another_account() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let u = create_user(&server, &admin, "cap_u", "cap_u@cyto.test").await;
    let other = create_user(&server, &admin, "cap_o", "cap_o@cyto.test").await;

    // U's own org (the control) and a foreign, populated org.
    let own = make_org_account(&pool, "Cap Own", u).await;
    let foreign = make_org_account(&pool, "Cap Foreign", other).await;

    // U holds the capability — via the Users group grant this branch's migration adds.
    // (`groups.id` is a BLOB on the sqlite chain — the app-bound surrogate, DEC-12 — so
    // the string constant must be parsed before the bind, or the EXISTS reads no row.)
    let held: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM json_each(g.permissions) WHERE value = 'account::members::manage') FROM groups g WHERE g.id = $1",
    )
    .bind(USERS_GROUP_ID.parse::<uuid::Uuid>().expect("users group uuid"))
    .fetch_one(&pool)
    .await
    .expect("read Users group perms");
    assert!(
        held,
        "precondition: the Users group holds account::members::manage, so U's refusal \
         below is about MEMBERSHIP and not about the capability"
    );

    let token = login(&server, "cap_u").await;

    // ── the refusal: capability held, membership absent ⇒ 404 ──
    let (status, body) = manage_context(&server, &token, &foreign.to_string(), None).await;
    assert_eq!(
        status, 404,
        "holding the global key must confer NOTHING on an account the caller does not \
         belong to — and it must be 404, not 403: {body}"
    );

    // ── POSITIVE CONTROL: the same capability on their OWN account ⇒ 200 ──
    let (status, body) = manage_context(&server, &token, &own.to_string(), None).await;
    assert_eq!(
        status, 200,
        "the same user, the same key, their own account: {body}"
    );
    assert_eq!(body["actor_role"].as_str(), Some("owner"));
}

// ---------------------------------------------------------------------------
// TEST-7 [acceptance] [invariant: INV-4] [covers: ITEM-3, ITEM-6, ITEM-8]
// ---------------------------------------------------------------------------

/// INV-4 — **the role floor holds.** A bare `member` gets 403 `INSUFFICIENT_ACCOUNT_ROLE`
/// on the `Admin`-floor route, while `GET /accounts/{id}/members` still returns 200 for
/// that same user in the same body — the design's own positive control, which is what
/// proves the 403 is the FLOOR and not a broken session or a missing membership.
///
/// Also asserts the `admin`-role sibling is ADMITTED, so the floor is shown to cut at
/// exactly the right rank rather than refusing everyone.
#[tokio::test]
async fn inv4_role_floor_refuses_bare_member_and_admits_admin() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "fl_own", "fl_own@cyto.test").await;
    let member = create_user(&server, &admin_token, "fl_mem", "fl_mem@cyto.test").await;
    let acct_admin = create_user(&server, &admin_token, "fl_adm", "fl_adm@cyto.test").await;

    let account = make_org_account(&pool, "Floor Org", owner).await;
    add_member(&pool, account, member, "member").await;
    add_member(&pool, account, acct_admin, "admin").await;

    let member_token = login(&server, "fl_mem").await;

    // ── THE REFUSAL: a bare member on an Admin-floor route ⇒ 403 ──
    let (status, body) = manage_context(&server, &member_token, &account.to_string(), None).await;
    assert_eq!(
        status, 403,
        "a bare member must be refused at the floor, and with 403 (not 404) — they are \
         a proven member, so the account's existence is not a secret from them: {body}"
    );
    assert_eq!(
        body["error_code"].as_str().or(body["code"].as_str()),
        Some("INSUFFICIENT_ACCOUNT_ROLE"),
        "the refusal must name the FLOOR, distinguishing it from the capability \
         refusal and from a non-member 404: {body}"
    );

    // ── POSITIVE CONTROL (the design's own): the SAME user, SAME account, a route
    //    whose gate they DO satisfy ⇒ 200 with real data. If this failed, the 403
    //    above would be meaningless (a dead session would produce it too).
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{account}/members")))
        .bearer_auth(&member_token)
        .send()
        .await
        .expect("list members");
    assert_eq!(
        resp.status().as_u16(),
        200,
        "the bare member's session is alive and they CAN read the members list"
    );
    let listed: Value = resp.json().await.expect("members json");
    assert_eq!(
        listed["total"].as_i64(),
        Some(3),
        "and the list is populated (owner + member + admin)"
    );

    // ── the floor admits at exactly the right rank: the `admin` member ⇒ 200 ──
    let admin_member_token = login(&server, "fl_adm").await;
    let (status, body) =
        manage_context(&server, &admin_member_token, &account.to_string(), None).await;
    assert_eq!(status, 200, "an account `admin` clears the Admin floor: {body}");
    assert_eq!(
        body["actor_role"].as_str(),
        Some("admin"),
        "and the response reports their REAL role, not the owner's"
    );
    let _ = acct_admin;
}

// ---------------------------------------------------------------------------
// TEST-8 [acceptance] [invariant: INV-15] [covers: ITEM-8]
// ---------------------------------------------------------------------------

/// INV-15 — **the existing surfaces are untouched**, proven behaviourally rather than
/// by "we didn't edit those files".
#[tokio::test]
async fn inv15_existing_surfaces_are_untouched() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let user = create_user(&server, &admin_token, "un_u", "un_u@cyto.test").await;
    let other = create_user(&server, &admin_token, "un_o", "un_o@cyto.test").await;
    let token = login(&server, "un_u").await;

    // (a) `account::manage` is still granted to NO group — so a plain user still 403s
    //     on POST /api/accounts. The new grant did not over-reach.
    let (status, body) = post_accounts(
        &server,
        Some(&token),
        json!({ "name": "Should Not Be Creatable" }),
    )
    .await;
    assert_eq!(
        status, 403,
        "org creation still requires account::manage (admin-only): {body}"
    );
    let manage_granted: Option<String> = sqlx::query_scalar(
        "SELECT name FROM groups WHERE EXISTS(SELECT 1 FROM json_each(permissions) WHERE value = 'account::manage') LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    .expect("scan groups for account::manage");
    assert_eq!(
        manage_granted, None,
        "no group may hold account::manage — it is admin-only via the `*` wildcard"
    );

    // (b) `ActiveAccount` still 404s a NON-MEMBER admin: the arrival of AccountScope
    //     introduced no admin bypass anywhere.
    //
    //     This MUST be exercised through a route that actually TAKES the
    //     `ActiveAccount` extractor. `GET /api/accounts` does not — it is
    //     `RequirePermissions<(AccountRead,)>` and ignores the header entirely — so
    //     asserting on it would prove nothing about `ActiveAccount` at all.
    //     `POST /api/projects` is the extractor's real consumer (it stamps the created
    //     project's `account_id` from it), and is what `active_account_test.rs` uses.
    let foreign = make_org_account(&pool, "Untouched Org", other).await;
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(&admin_token)
        .header("X-Account-Id", foreign.to_string())
        .json(&json!({ "name": "should-404", "description": "" }))
        .send()
        .await
        .expect("admin acts under a foreign account");
    assert_eq!(
        resp.status().as_u16(),
        404,
        "a root admin who is not a member still 404s through ActiveAccount"
    );

    //     DISCRIMINATING CONTROL for (b): a MEMBER of that same org, acting under the
    //     SAME header, succeeds. Without this arm the pair varies two things at once
    //     (header+foreign vs no-header+personal) and so cannot tell "ActiveAccount
    //     404s a NON-MEMBER" — the invariant — from "ActiveAccount 404s ANY
    //     X-Account-Id", which would be account switching broken outright: exactly the
    //     "existing surface was touched" regression this test claims to disprove.
    let member_token = login(&server, "un_o").await;
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(&member_token)
        .header("X-Account-Id", foreign.to_string())
        .json(&json!({ "name": "member-under-org", "description": "" }))
        .send()
        .await
        .expect("a member acts under their own org");
    assert!(
        resp.status().is_success(),
        "a MEMBER acting under the same header succeeds — so the admin's 404 above is \
         the membership refusal, not a blanket header rejection: {}",
        resp.status()
    );

    //     POSITIVE CONTROL for (b): the SAME admin, the SAME route, with NO header
    //     (their personal account) succeeds — so the 404 above is the membership
    //     refusal and not a build in which project creation is simply broken.
    let resp = server
        .client
        .post(server.api_url("/projects"))
        .bearer_auth(&admin_token)
        .json(&json!({ "name": "control-ok", "description": "" }))
        .send()
        .await
        .expect("admin acts under their personal account");
    assert!(
        resp.status().is_success(),
        "the same admin CAN create a project under their own account: {}",
        resp.status()
    );

    // (c) AdminAccountScope's 403-BEFORE-lookup order — the arm asserting it has no object
    //     on this node: the `/admin/accounts/*` surface it guarded is stripped (DRIFT-1.25),
    //     and the retained `AccountScope` keys on membership FIRST, which is what (b) above
    //     proves is not an existence oracle for the account-scoped surfaces. Recorded in the
    //     drift ledger rather than silently dropped.
    let _ = user;
}

// ---------------------------------------------------------------------------
// TEST-9 [covers: ITEM-3] — DEC-4, no admin bypass
// ---------------------------------------------------------------------------

/// A root admin clears step 2 (`principal_holds` short-circuits `true` for `is_admin`)
/// and is STILL refused at step 4 on an account they are not a member of. Positive
/// control: the same admin, once actually added as a member, gets 200 — so the 404 was
/// about membership and not about some unrelated failure.
#[tokio::test]
async fn no_admin_bypass_root_admin_is_404_until_actually_a_member() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "ab_own", "ab_own@cyto.test").await;
    let account = make_org_account(&pool, "No Bypass Org", owner).await;

    let admin_id: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(&pool)
        .await
        .expect("admin id");

    // ── the refusal: root admin, not a member ⇒ 404 ──
    let (status, body) = manage_context(&server, &admin_token, &account.to_string(), None).await;
    assert_eq!(
        status, 404,
        "AccountScope has NO is_admin short-circuit — platform staff use \
         /api/admin/accounts/* instead: {body}"
    );

    // ── POSITIVE CONTROL: make them a real member ⇒ 200 ──
    add_member(&pool, account, admin_id, "admin").await;
    let (status, body) = manage_context(&server, &admin_token, &account.to_string(), None).await;
    assert_eq!(status, 200, "once a real member, the same admin is admitted: {body}");
    assert_eq!(body["actor_role"].as_str(), Some("admin"));
}

// ---------------------------------------------------------------------------
// TEST-10 [covers: ITEM-3] — step 6, and its ORDER relative to step 4
// ---------------------------------------------------------------------------

/// A personal account is refused with 422 `PERSONAL_ACCOUNT_NOT_MANAGEABLE` for its own
/// owner (who clears steps 1-5), while a NON-member of somebody else's personal account
/// gets 404 — proving the kind check runs AFTER the membership check and so never
/// became an existence oracle.
#[tokio::test]
async fn personal_account_is_422_for_its_owner_but_404_for_a_stranger() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let u = create_user(&server, &admin_token, "pa_u", "pa_u@cyto.test").await;
    let v = create_user(&server, &admin_token, "pa_v", "pa_v@cyto.test").await;
    let u_personal = personal_account_id(&pool, u).await;
    let v_personal = personal_account_id(&pool, v).await;
    let u_org = make_org_account(&pool, "PA Org", u).await;

    let token = login(&server, "pa_u").await;

    // U owns their personal account, so clears steps 1-5, and is refused at step 6.
    let (status, body) = manage_context(&server, &token, &u_personal.to_string(), None).await;
    assert_eq!(status, 422, "a personal account's membership is not manageable: {body}");
    assert_eq!(
        body["error_code"].as_str().or(body["code"].as_str()),
        Some("PERSONAL_ACCOUNT_NOT_MANAGEABLE"),
        "named refusal — LAST_OWNER is also a 422 from this module, so status alone \
         does not identify it: {body}"
    );

    // A stranger's personal account ⇒ 404, NOT 422. If the kind check had been placed
    // before the membership check, this would leak that V's personal account exists.
    let (status, body) = manage_context(&server, &token, &v_personal.to_string(), None).await;
    assert_eq!(
        status, 404,
        "the kind check must run AFTER membership or it is an existence oracle: {body}"
    );

    // POSITIVE CONTROL: the same user on an ORGANIZATION they own ⇒ 200.
    let (status, body) = manage_context(&server, &token, &u_org.to_string(), None).await;
    assert_eq!(status, 200, "organizations are manageable: {body}");
}

// ---------------------------------------------------------------------------
// TEST-11 [covers: ITEM-5] — the migration grant
// ---------------------------------------------------------------------------

/// The migration granted `account::members::manage` to the `Users` group exactly once,
/// and did not accidentally grant `account::manage` to anyone.
#[tokio::test]
async fn migration_grants_the_new_key_to_users_exactly_once() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let occurrences: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM json_each((SELECT permissions FROM groups WHERE name = 'Users')) \
         WHERE value = 'account::members::manage'",
    )
    .fetch_one(&pool)
    .await
    .expect("count the grant");
    assert_eq!(
        occurrences, 1,
        "granted exactly once — the migration's array_append is guarded so a re-run \
         cannot duplicate it"
    );

    // Re-running the migration is a no-op (idempotence, proven by running it).
    //
    // Read and execute the ACTUAL migration FILE rather than a copy of its SQL typed
    // into this test: a hand-copied statement keeps its own guard, so deleting the
    // guard from the migration would leave such a test green. This way the assertion
    // below is about the shipped file.
    let migration = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/migrations-sqlite/account/202609040001_account_members_manage.sql"
    ))
    .expect("read the migration file");
    assert!(
        migration.contains(
            "NOT EXISTS (SELECT 1 FROM json_each(permissions) WHERE value = 'account::members::manage')"
        ),
        "the sqlite migration must carry its idempotence guard (the JSON1 form of the \
         `NOT (p = ANY (permissions))` PG guard)"
    );
    sqlx::raw_sql(&migration)
        .execute(&pool)
        .await
        .expect("re-run the migration file");
    let after: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM json_each((SELECT permissions FROM groups WHERE name = 'Users')) \
         WHERE value = 'account::members::manage'",
    )
    .fetch_one(&pool)
    .await
    .expect("recount");
    assert_eq!(after, 1, "still exactly once after a re-run");
}

// ---------------------------------------------------------------------------
// TEST-12 [covers: ITEM-6] — the proof route's payload
// ---------------------------------------------------------------------------

/// The response carries the PATH account id, the caller's REAL role (asserted `admin`,
/// so a hardcoded `owner` would fail), and the REAL member count (seeded 3, asserted 3
/// — not merely `> 0`).
#[tokio::test]
async fn manage_context_reports_real_role_and_real_member_count() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "ctx_own", "ctx_own@cyto.test").await;
    let a = create_user(&server, &admin_token, "ctx_a", "ctx_a@cyto.test").await;
    let b = create_user(&server, &admin_token, "ctx_b", "ctx_b@cyto.test").await;
    let account = make_org_account(&pool, "Ctx Org", owner).await;
    add_member(&pool, account, a, "admin").await;
    add_member(&pool, account, b, "member").await;

    let token = login(&server, "ctx_a").await;
    let (status, body) = manage_context(&server, &token, &account.to_string(), None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["account_id"].as_str(),
        Some(account.to_string().as_str())
    );
    assert_eq!(
        body["actor_role"].as_str(),
        Some("admin"),
        "the CALLER's role, not the account owner's"
    );
    assert_eq!(
        body["member_count"].as_i64(),
        Some(3),
        "the real row count (owner + admin + member)"
    );
}

// ---------------------------------------------------------------------------
// TEST-13 [covers: ITEM-3, ITEM-4] — the non-authz rejections + step-2 ordering
// ---------------------------------------------------------------------------

/// 401 unauthenticated (step 1); 400 on a malformed path id from a caller who WOULD
/// otherwise be authorized (proving the 400 comes from parsing, not from authz); and
/// 403 `ACCOUNT_MEMBERS_MANAGE_REQUIRED` for a caller lacking the capability **even
/// though they are a full `owner`** of the target — the step-2-before-step-4 proof,
/// and the backend twin of the A10 e2e.
#[tokio::test]
async fn unauthenticated_malformed_and_capability_refusals() {
    let server = TestServer::spawn().await;
    let admin_token = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let owner = create_user(&server, &admin_token, "rj_own", "rj_own@cyto.test").await;
    let account = make_org_account(&pool, "Reject Org", owner).await;

    // ── 401: no token at all ──
    let resp = server
        .client
        .get(server.api_url(&format!("/accounts/{account}/members/manage-context")))
        .send()
        .await
        .expect("unauthenticated request");
    assert_eq!(resp.status().as_u16(), 401, "step 1 refuses before anything else");

    // ── 400: malformed path id, from an otherwise-authorized caller ──
    let owner_token = login(&server, "rj_own").await;
    let (status, body) = manage_context(&server, &owner_token, "not-a-uuid", None).await;
    assert_eq!(
        status, 400,
        "a malformed account_id is a parse failure, not an authz failure: {body}"
    );
    // POSITIVE CONTROL: the same caller with a WELL-FORMED id succeeds, so the 400 was
    // about the id and not about them.
    let (status, _) = manage_context(&server, &owner_token, &account.to_string(), None).await;
    assert_eq!(status, 200, "the same caller is authorized with a valid id");

    // ── 403: capability absent, membership PRESENT (a full owner) ──
    // `create_user_without_projects` strips the Users group, which is where the
    // account::members::manage grant lives.
    let stripped =
        create_user_without_projects(&server, &admin_token, "rj_str", "rj_str@cyto.test").await;
    let stripped_account = make_org_account(&pool, "Stripped Org", stripped).await;
    let stripped_token = login(&server, "rj_str").await;

    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM account_members WHERE account_id=$1 AND user_id=$2")
            .bind(stripped_account)
            .bind(stripped)
            .fetch_optional(&pool)
            .await
            .expect("read membership");
    assert_eq!(
        role.as_deref(),
        Some("owner"),
        "precondition: this caller IS the owner, so the 403 below is about the \
         CAPABILITY and cannot be confused with a membership failure"
    );

    let (status, body) =
        manage_context(&server, &stripped_token, &stripped_account.to_string(), None).await;
    assert_eq!(
        status, 403,
        "step 2 refuses a caller lacking account::members::manage even on an account \
         they OWN — the capability is checked before any account lookup: {body}"
    );
    assert_eq!(
        body["error_code"].as_str().or(body["code"].as_str()),
        Some("ACCOUNT_MEMBERS_MANAGE_REQUIRED"),
        "named refusal, distinct from the role-floor 403: {body}"
    );
}
