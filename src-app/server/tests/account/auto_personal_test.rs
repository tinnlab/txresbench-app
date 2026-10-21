//! A5 — auto-create exactly one personal account on every user-creation path.
//!
//! Full production path through a real spawned server + real Postgres (per-test DB,
//! per-test server subprocess — so the backstop's process-local ensured-set is fresh
//! per test). Covers the synchronous ensure sites (ITEM-1/2), the lazy-ensure
//! backstop (ITEM-4/5), and the invariant acceptance proofs (INV-1/2/3).
//!
//! Test IDs map to `.lifecycle/accounts/A5-auto-personal/PLAN.md` (## Tests) +
//! TESTS.md. TEST-4 is the in-source unit test in `account/backstop.rs`; TEST-6 is
//! the desktop path (`desktop/tauri/tests`); TEST-11 (SDK_GAPS presence) is below.

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use super::{create_user, pool_for, setup_admin};
use crate::common::TestServer;

// ------------------------------- helpers -------------------------------

/// The admin owner's user id (the only user present right after setup).
async fn admin_user_id(pool: &PgPool) -> Uuid {
    sqlx::query_scalar("SELECT id FROM users WHERE is_admin = true ORDER BY created_at ASC LIMIT 1")
        .fetch_one(pool)
        .await
        .expect("admin user id")
}

/// Exactly how many `personal` accounts `user_id` owns.
async fn personal_count(pool: &PgPool, user_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM accounts WHERE kind = 'personal' AND personal_user_id = $1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("personal count")
}

/// How many `owner` memberships back `user_id`'s personal account.
async fn owner_membership_count(pool: &PgPool, user_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM account_members m
         JOIN accounts a ON a.id = m.account_id
         WHERE a.kind = 'personal' AND a.personal_user_id = $1
           AND m.user_id = $1 AND m.role = 'owner'",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("owner membership count")
}

/// Delete `user_id`'s personal account (+ its memberships cascade), simulating a
/// user who exists WITHOUT a personal account — a pre-existing/backfill-missed user,
/// or one provisioned by a turnkey path the app has no synchronous seam to wrap.
async fn delete_personal_account(pool: &PgPool, user_id: Uuid) {
    sqlx::query("DELETE FROM accounts WHERE kind = 'personal' AND personal_user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await
        .expect("delete personal account");
}

/// Log a known-password user in → their access token (a PUBLIC route — the backstop
/// is a no-op on it, so it does not pre-create the account we are testing for).
async fn login(server: &TestServer, username: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({ "username": username, "password": "userPassw0rd!" }))
        .send()
        .await
        .expect("login request");
    assert!(
        resp.status().is_success(),
        "login {username}: {}",
        resp.status()
    );
    let body: Value = resp.json().await.expect("login json");
    body["access_token"]
        .as_str()
        .expect("access token")
        .to_string()
}

/// One AUTHENTICATED request on a `RequirePermissions`-gated NON-auth route
/// (`GET /projects`, held by the Users group) → its status. This is the request the
/// backstop rides. Returns the status so the caller can assert the backstop NEVER
/// turned a normal response into a 5xx.
async fn authed_projects(server: &TestServer, token: &str) -> u16 {
    server
        .client
        .get(server.api_url("/projects"))
        .bearer_auth(token)
        .send()
        .await
        .expect("/projects request")
        .status()
        .as_u16()
}

// ------------------------------- tests -------------------------------

// TEST-1 [covers: ITEM-1]: admin-create yields a user with EXACTLY ONE personal
// account + one owner membership IMMEDIATELY — before that user ever logs in (so the
// backstop cannot be what created it; this is the synchronous ITEM-1 site).
#[tokio::test]
async fn admin_create_user_has_personal_account_immediately() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    // Alice has NEVER made an authenticated request — the backstop never saw her.
    assert_eq!(
        personal_count(&pool, alice).await,
        1,
        "exactly one personal account at create"
    );
    assert_eq!(
        owner_membership_count(&pool, alice).await,
        1,
        "exactly one owner membership"
    );
}

// TEST-2 [covers: ITEM-2]: first-run setup_admin produces an admin with exactly one
// personal account (owner membership present) — before any authenticated request.
#[tokio::test]
async fn setup_admin_has_personal_account_immediately() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let admin_id = admin_user_id(&pool).await;

    assert_eq!(
        personal_count(&pool, admin_id).await,
        1,
        "admin has one personal account"
    );
    assert_eq!(
        owner_membership_count(&pool, admin_id).await,
        1,
        "admin owns it"
    );
}

// TEST-3 [covers: ITEM-4, ITEM-5]: a user with NO personal account triggers the
// backstop on their next authenticated request (exactly one created); a subsequent
// authenticated request creates NONE (the process-cache + ON CONFLICT hold).
#[tokio::test]
async fn backstop_creates_on_first_authed_request_then_caches() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    // Remove the account the synchronous site created, to isolate the backstop.
    delete_personal_account(&pool, alice).await;
    assert_eq!(
        personal_count(&pool, alice).await,
        0,
        "seeded with no personal account"
    );

    // First authenticated request → the backstop heals it.
    let token = login(&server, "alice").await;
    assert_eq!(
        authed_projects(&server, &token).await,
        200,
        "gated route succeeds"
    );
    assert_eq!(
        personal_count(&pool, alice).await,
        1,
        "backstop created exactly one"
    );
    assert_eq!(
        owner_membership_count(&pool, alice).await,
        1,
        "with owner membership"
    );

    // Second authenticated request → no second account (cache hit + ON CONFLICT).
    assert_eq!(authed_projects(&server, &token).await, 200);
    assert_eq!(
        personal_count(&pool, alice).await,
        1,
        "still exactly one after a second request"
    );
}

// TEST-5 [covers: ITEM-4]: the backstop is a NO-OP without identity (a public route,
// and an invalid bearer) and NEVER fails a request — it is best-effort, not a gate.
#[tokio::test]
async fn backstop_is_noop_without_valid_identity() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let accounts_before: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&pool)
        .await
        .unwrap();

    // A PUBLIC route with no bearer — succeeds, creates no account.
    let public = server
        .client
        .get(server.api_url("/app/setup/status"))
        .send()
        .await
        .expect("public request");
    assert!(
        public.status().is_success(),
        "public route unaffected by the backstop"
    );

    // A request carrying a STRUCTURALLY-invalid bearer — the backstop finds no
    // identity and does nothing; the route rejects it (401), NOT a 5xx from the
    // backstop, and still no account is created.
    let bad = server
        .client
        .get(server.api_url("/projects"))
        .bearer_auth("not-a-real-jwt")
        .send()
        .await
        .expect("bad-token request");
    assert_ne!(
        bad.status().as_u16(),
        500,
        "an invalid token never 5xxes via the backstop"
    );

    let accounts_after: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        accounts_before, accounts_after,
        "no account created without a valid identity"
    );
}

// TEST-7 [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-2, ITEM-4]: a
// FRESHLY-REGISTERED user (through the real /auth/register turnkey path — a path the
// app has NO synchronous seam to wrap) has EXACTLY ONE personal account by their
// first authenticated request. The all-paths "a fresh signup creates exactly one
// personal account" guarantee (PROV-A5-1).
#[tokio::test]
async fn fresh_registration_gets_exactly_one_personal_account() {
    let server = TestServer::spawn().await;
    // setup_admin must run first (registration is open, but a booted deployment
    // expects an admin to exist for the seeded groups).
    let _admin = setup_admin(&server).await;

    let reg = server
        .client
        .post(server.api_url("/auth/register"))
        .json(&json!({
            "username": "freshuser",
            "email": "fresh@x.test",
            "password": "userPassw0rd!"
        }))
        .send()
        .await
        .expect("register request");
    assert!(reg.status().is_success(), "register: {}", reg.status());

    let pool = pool_for(&server).await;
    let fresh: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'freshuser'")
        .fetch_one(&pool)
        .await
        .expect("registered user id");

    // The turnkey register path ran no synchronous ensure — the backstop is the only
    // thing that can create the account, and only on an authenticated request.
    let token = login(&server, "freshuser").await;
    assert_eq!(authed_projects(&server, &token).await, 200);

    assert_eq!(
        personal_count(&pool, fresh).await,
        1,
        "exactly one personal account after signup"
    );
    assert_eq!(
        owner_membership_count(&pool, fresh).await,
        1,
        "owner membership present"
    );
}

// TEST-8 [acceptance] [invariant: INV-2] [covers: ITEM-4]: a user provisioned WITHOUT
// a synchronous ensure (here: created then stripped of the account, standing in for
// an LDAP/OAuth first-login the app cannot synchronously wrap) gets EXACTLY ONE
// personal account via the backstop on their next authenticated request — the
// "covers LDAP/OAuth until the SDK hook lands" proof.
#[tokio::test]
async fn externally_provisioned_user_healed_by_backstop() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    // Stand-in for an externally-provisioned user: exists, is a Users-group member,
    // but has no personal account (the synchronous site's effect removed).
    let ldap_like = create_user(&server, &admin, "ldapuser", "ldap@x.test").await;
    let pool = pool_for(&server).await;
    delete_personal_account(&pool, ldap_like).await;
    assert_eq!(
        personal_count(&pool, ldap_like).await,
        0,
        "no account pre-backstop"
    );

    let token = login(&server, "ldapuser").await;
    assert_eq!(authed_projects(&server, &token).await, 200);

    assert_eq!(
        personal_count(&pool, ldap_like).await,
        1,
        "backstop covers the external path"
    );
    assert_eq!(owner_membership_count(&pool, ldap_like).await, 1);
}

// TEST-9 [acceptance] [invariant: INV-3] [covers: ITEM-1, ITEM-4]: the invariant is
// idempotent ACROSS paths — a user created by the synchronous site (ITEM-1) then
// exercised through the backstop (login + authenticated requests) has EXACTLY ONE
// personal account, never a second. Leans on PROV-A1-4's ON CONFLICT.
#[tokio::test]
async fn ensure_is_idempotent_across_sync_site_and_backstop() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let alice = create_user(&server, &admin, "alice", "alice@x.test").await;
    let pool = pool_for(&server).await;

    // ITEM-1 already created exactly one.
    assert_eq!(personal_count(&pool, alice).await, 1);

    // Now run the backstop path repeatedly — it must NOT create a second.
    let token = login(&server, "alice").await;
    for _ in 0..3 {
        assert_eq!(authed_projects(&server, &token).await, 200);
    }
    assert_eq!(
        personal_count(&pool, alice).await,
        1,
        "never a second personal account"
    );
    assert_eq!(
        owner_membership_count(&pool, alice).await,
        1,
        "never a second owner membership"
    );
}

// TEST-10 [acceptance] [invariant: INV-3] [covers: ITEM-4]: a PRE-EXISTING user with
// no personal account is self-healed to exactly one on their next authenticated
// request, and a second request adds none (the §11 "self-healed on their next
// request" backstop behavior; distinct from TEST-3 in asserting the persisted
// steady state across two independent tokens).
#[tokio::test]
async fn preexisting_user_without_account_self_heals() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let bob = create_user(&server, &admin, "bob", "bob@x.test").await;
    let pool = pool_for(&server).await;
    delete_personal_account(&pool, bob).await;
    assert_eq!(personal_count(&pool, bob).await, 0);

    // First login + request self-heals.
    let token1 = login(&server, "bob").await;
    assert_eq!(authed_projects(&server, &token1).await, 200);
    assert_eq!(
        personal_count(&pool, bob).await,
        1,
        "self-healed to exactly one"
    );

    // A brand-new login (fresh token) + request — still exactly one, never a second.
    let token2 = login(&server, "bob").await;
    assert_eq!(authed_projects(&server, &token2).await, 200);
    assert_eq!(
        personal_count(&pool, bob).await,
        1,
        "second session adds none"
    );
    assert_eq!(owner_membership_count(&pool, bob).await, 1);
}

// TEST-11 [covers: ITEM-6]: SDK_GAPS.md records the G-AUTHEVT clean-hook seam
// (install_user_created_hook / the dropped UserEvent::Created) — a presence check so
// the boundary input is not silently lost. Walks up from the test binary's manifest
// dir (src-app/server) to the repo root where SDK_GAPS.md lives.
#[test]
fn sdk_gaps_records_g_authevt() {
    let manifest = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // src-app/server -> src-app -> repo root
    let repo_root = manifest
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root two levels above the server manifest dir");
    let sdk_gaps = repo_root.join("SDK_GAPS.md");
    let text = std::fs::read_to_string(&sdk_gaps)
        .unwrap_or_else(|e| panic!("read {}: {e}", sdk_gaps.display()));
    assert!(
        text.contains("G-AUTHEVT"),
        "SDK_GAPS.md records the G-AUTHEVT gap id"
    );
    assert!(
        text.contains("install_user_created_hook"),
        "SDK_GAPS.md names the clean in-tx hook seam"
    );
    assert!(
        text.contains("UserEvent::Created"),
        "SDK_GAPS.md names the dropped creation event"
    );
}

// TEST-12 [covers: G-AUTHEVT clean hook] [invariant: INV-1]: the SDK's in-tx
// `UserCreatedHook` (installed at boot as `PersonalAccountHook`) creates the
// personal account ATOMICALLY with the user row on the turnkey `/auth/register`
// path — so the account exists IMMEDIATELY after registration, BEFORE any
// authenticated request. This is the clean-hook proof: registration is a PUBLIC
// route (no bearer ⇒ the backstop is a no-op on it) and the app has NO synchronous
// ensure site for register, so the ONLY thing that can have created the account
// before a login is the in-tx hook. Contrast TEST-7, which needed a login + authed
// request for the backstop to create it before the hook landed.
#[tokio::test]
async fn hook_creates_personal_account_in_tx_at_registration() {
    let server = TestServer::spawn().await;
    let _admin = setup_admin(&server).await;

    let reg = server
        .client
        .post(server.api_url("/auth/register"))
        .json(&json!({
            "username": "hookuser",
            "email": "hook@x.test",
            "password": "userPassw0rd!"
        }))
        .send()
        .await
        .expect("register request");
    assert!(reg.status().is_success(), "register: {}", reg.status());

    let pool = pool_for(&server).await;
    let fresh: Uuid = sqlx::query_scalar("SELECT id FROM users WHERE username = 'hookuser'")
        .fetch_one(&pool)
        .await
        .expect("registered user id");

    // NO login, NO authenticated request has happened — the backstop never saw this
    // user. The account can only exist because the hook fired IN the register
    // transaction.
    assert_eq!(
        personal_count(&pool, fresh).await,
        1,
        "hook created exactly one personal account in-tx at registration (pre-login)"
    );
    assert_eq!(
        owner_membership_count(&pool, fresh).await,
        1,
        "with its owner membership, atomically"
    );
}

// TEST-13 [covers: backstop retained] [invariant: INV-3]: the lazy-ensure backstop
// is KEPT alongside the clean hook and still self-heals a user who has NO personal
// account (standing in for a user created BEFORE the hook landed — the hook only
// fires for users created after install). Delete the account the hook/site created,
// then a login + authed request must recreate exactly one. Proves the hook did not
// replace the backstop.
#[tokio::test]
async fn backstop_still_self_heals_a_pre_hook_user() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let carol = create_user(&server, &admin, "carol", "carol@x.test").await;
    let pool = pool_for(&server).await;

    // Strip the personal account to simulate a pre-hook user (created before the
    // hook existed, so nothing provisioned one in-tx).
    delete_personal_account(&pool, carol).await;
    assert_eq!(
        personal_count(&pool, carol).await,
        0,
        "seeded as a pre-hook user with no personal account"
    );

    // The retained backstop heals on the next authenticated request.
    let token = login(&server, "carol").await;
    assert_eq!(authed_projects(&server, &token).await, 200);
    assert_eq!(
        personal_count(&pool, carol).await,
        1,
        "backstop self-healed the pre-hook user to exactly one"
    );
    assert_eq!(owner_membership_count(&pool, carol).await, 1);
}
