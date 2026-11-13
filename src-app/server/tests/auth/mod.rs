//! Auth + gated-route integration tests over the SDK harness. Proves the full
//! production path end-to-end through a real spawned server + real Postgres:
//! first-run setup → JWT mint → `/auth/me` → a `RequirePermissions`-gated route
//! on a NON-auth module resolving the injected identity resolver.
//!
//! ITEM-3: the platform `/projects` route the suite used as its gated-route
//! vehicle is gone with the project module; `/api/txr/runs` (the execution
//! engine's list route, `RequirePermissions<(JobsUse,)>`) is the kept route with
//! the same property — its ONLY authorization path is the framework permission
//! extractor, and the Users group holds `jobs::use` by default.

use serde_json::{json, Value};

use crate::common::TestServer;

/// First-run setup → the owner's access token.
async fn setup_admin(server: &TestServer, username: &str) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({
            "username": username,
            "email": format!("{username}@txresbench.test"),
            "password": "adminPassw0rd!"
        }))
        .send()
        .await
        .expect("setup/admin request");
    assert_eq!(resp.status().as_u16(), 200, "setup/admin creates the owner");
    let body: Value = resp.json().await.expect("setup/admin json");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("setup response carries an access token")
        .to_string()
}

/// Create a plain user via the admin, then log them in → their access token.
async fn make_user(server: &TestServer, admin: &str, name: &str) -> String {
    let created = server
        .client
        .post(server.api_url("/auth/register"))
        .bearer_auth(admin)
        .json(&json!({
            "username": name,
            "email": format!("{name}@txresbench.test"),
            "password": "userPassw0rd!"
        }))
        .send()
        .await
        .expect("create user request");
    assert!(
        created.status().is_success(),
        "create user {name}: {}",
        created.status()
    );
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({"username": name, "password": "userPassw0rd!"}))
        .send()
        .await
        .expect("login request");
    assert!(
        resp.status().is_success(),
        "login {name}: {}",
        resp.status()
    );
    let body: Value = resp.json().await.expect("login json");
    body["access_token"]
        .as_str()
        .expect("login carries an access token")
        .to_string()
}

/// `GET /api/txr/runs` — a `RequirePermissions<(JobsUse,)>`-gated route on a
/// NON-auth module, i.e. one whose ONLY authorization path is the framework
/// permission extractor (`DefaultIdentityResolver::authenticate`). Deliberately
/// not `/auth/me` or any `JwtAuth`-gated route: those go through
/// `assert_token_version_current`, a DIFFERENT epoch check, and would pass even
/// with the resolver broken.
async fn get_runs_status(server: &TestServer, token: &str) -> u16 {
    server
        .client
        .get(server.api_url("/txr/runs"))
        .bearer_auth(token)
        .send()
        .await
        .expect("/txr/runs request")
        .status()
        .as_u16()
}

#[tokio::test]
async fn setup_admin_then_login_me_and_gated_users() {
    let server = TestServer::spawn().await;

    // Fresh per-test DB (copied from the migrated template) → no owner yet.
    // The first-run-setup status route has no object on this node; its
    // "needs_setup" question is answered at the DB: zero users.
    use sqlx::sqlite::SqlitePoolOptions;
    let probe = SqlitePoolOptions::new()
        .connect(server.database_url())
        .await
        .expect("connect setup probe pool");
    let users: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&probe)
        .await
        .expect("user count");
    assert_eq!(users, 0, "a fresh test DB has no owner yet (needs setup)");

    // Create the first owner → 201 + an access token (turnkey AuthModule path).
    // The node's `POST /session/local` is a FIXED-OWNER mint (the desktop
    // single-user default: `admin`/`admin@localhost`); the request body is
    // ignored, so it needs no credentials.
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({}))
        .send()
        .await
        .expect("setup/admin request");
    assert_eq!(resp.status().as_u16(), 200, "setup/admin creates the owner");
    let body: Value = resp.json().await.expect("setup/admin json");
    let token = body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("setup response carries an access token")
        .to_string();

    // A `RequirePermissions`-gated route on a non-auth module, unauthenticated →
    // 401 (proves the resolver Extension reaches non-auth routes; a broken wire
    // would 500 "missing extension" or 404).
    let unauth = server
        .client
        .get(server.api_url("/txr/runs"))
        .send()
        .await
        .expect("unauth /txr/runs request");
    assert_eq!(
        unauth.status().as_u16(),
        401,
        "/txr/runs without a token is 401"
    );

    // /auth/me with the token → 200 + our user (resolver validates the JWT).
    let me = server
        .client
        .get(server.api_url("/auth/me"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("/auth/me request");
    assert_eq!(me.status().as_u16(), 200, "/auth/me with token is 200");
    let me_body: Value = me.json().await.expect("/auth/me json");
    assert_eq!(me_body["user"]["username"], json!("admin"));

    // Gated /accounts WITH the admin token → 200 (end-to-end: gated route resolves.
    // The pre-strip `/users` surface is gone on this node; `/accounts` is the
    // retained non-auth gated module the resolver must reach.)
    let accounts = server
        .client
        .get(server.api_url("/accounts"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("admin /accounts request");
    assert_eq!(accounts.status().as_u16(), 200, "admin can list accounts");
}

/// A logout must stop the ALREADY-ISSUED access token on `RequirePermissions`
/// routes — immediately, not at `exp`.
///
/// The framework permission extractor is the ONLY authorization path those
/// routes have: `DefaultIdentityResolver::authenticate` validates the JWT
/// signature + `exp`, then loads the acting user. `jwt_extractor`'s INVARIANT
/// names exactly two callers of `validate_access_token` that gate a route and
/// requires BOTH to verify the token-revocation epoch — naming this one as
/// doing so "via `get_by_id_with_token_version`". The shipped resolver used
/// plain `get_by_id` and never compared the epoch, so after a logout (which
/// bumps `users.token_version`) the captured access token kept working on every
/// gated route for the rest of its 24h TTL. The client-side session fan-out is
/// no defense against whoever holds a stolen token: they do not run our JS.
///
/// Alice is the positive case. Bob, who never logs out, is the NEGATIVE
/// CONTROL: without him this test would also pass if tokens simply stopped
/// working in that window (a clock skew, a server restart, a harness quirk) —
/// i.e. for the wrong reason. Both users' tokens are proven to work on the same
/// route BEFORE the logout, so the only difference between the two outcomes is
/// the logout itself.
#[tokio::test]
async fn logout_revokes_the_access_token_on_gated_routes() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server, "revokeadmin").await;
    let alice = make_user(&server, &admin, "alice").await;
    let bob = make_user(&server, &admin, "bob").await;

    // Both tokens work on the gated route BEFORE anyone logs out. Without this
    // the 401 below could mean "alice's token was never valid".
    assert_eq!(
        get_runs_status(&server, &alice).await,
        200,
        "alice's fresh token must pass the gated route"
    );
    assert_eq!(
        get_runs_status(&server, &bob).await,
        200,
        "bob's fresh token must pass the gated route"
    );

    // Alice logs out. This bumps `users.token_version`; the epoch baked into
    // the token captured above is now stale.
    let out = server
        .client
        .post(server.api_url("/auth/logout"))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("logout request");
    assert!(out.status().is_success(), "logout: {}", out.status());

    // The SAME captured token, re-used on the SAME gated route → rejected.
    let after = server
        .client
        .get(server.api_url("/txr/runs"))
        .bearer_auth(&alice)
        .send()
        .await
        .expect("post-logout /txr/runs request");
    assert_eq!(
        after.status().as_u16(),
        401,
        "a logged-out user's access token must be rejected on a \
         RequirePermissions-gated route, not honored until exp"
    );
    let body: Value = after.json().await.expect("post-logout /txr/runs json");
    assert_eq!(
        body["error_code"], "SESSION_REVOKED",
        "the rejection must be the revocation check, not some other 401: {body}"
    );

    // Negative control: bob never logged out, so his epoch still matches and
    // his token must still pass in the same window.
    assert_eq!(
        get_runs_status(&server, &bob).await,
        200,
        "another user's token must NOT be revoked by alice's logout"
    );
}

/// Log a user in and return `(access_token, refresh_token)` — the refresh half is
/// what makes "the attacker is still logged in" observable: revoking access alone
/// while leaving the refresh token whitelisted just makes the attacker press
/// `/auth/refresh` once.
async fn login_pair(server: &TestServer, name: &str, password: &str) -> (String, String) {
    let resp = server
        .client
        .post(server.api_url("/auth/login"))
        .json(&json!({"username": name, "password": password}))
        .send()
        .await
        .expect("login request");
    assert!(resp.status().is_success(), "login {name}: {}", resp.status());
    let body: Value = resp.json().await.expect("login json");
    (
        body["access_token"]
            .as_str()
            .expect("login carries an access token")
            .to_string(),
        body["refresh_token"]
            .as_str()
            .expect("login carries a refresh token")
            .to_string(),
    )
}

/// **An admin password reset must end the sessions it was called to end.**
///
/// The reset exists for the COMPROMISED-account case, and it did not revoke
/// anything: it rotated the credential and left every pre-reset session live — the
/// attacker's access token good until `exp` (24h by default) and their refresh token
/// good for the full refresh TTL, i.e. renewable indefinitely. The new password
/// locked the front door with the intruder still inside. Self-service
/// `change_password` had revoked all along, so the privileged path was the weaker
/// one.
///
/// Both halves are asserted because either alone is defeated by the other:
///   * ACCESS only → the attacker calls `/auth/refresh` and mints a fresh pair;
///   * REFRESH only → the attacker keeps working on the access token until `exp`.
///
/// NEGATIVE CONTROLS: (i) both of the victim's tokens are exercised and pass BEFORE
/// the reset, so the 401s are the reset and not an invalid fixture; (ii) an
/// uninvolved user's tokens still pass AFTER it, so the fix is a targeted revocation
/// and not a global epoch bump that logs the whole deployment out.
#[tokio::test]
async fn admin_password_reset_revokes_the_targets_existing_sessions() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server, "resetadmin").await;

    // `make_user` creates + logs in; log in again to capture the refresh half too.
    let _ = make_user(&server, &admin, "victim").await;
    let _ = make_user(&server, &admin, "bystander").await;
    let (victim_access, victim_refresh) = login_pair(&server, "victim", "userPassw0rd!").await;
    let (bystander_access, bystander_refresh) =
        login_pair(&server, "bystander", "userPassw0rd!").await;


    let refresh_status = |token: String| {
        let c = server.client.clone();
        let url = server.api_url("/auth/refresh");
        async move {
            c.post(url)
                .json(&json!({ "refresh_token": token }))
                .send()
                .await
                .expect("/auth/refresh")
                .status()
                .as_u16()
        }
    };

    // --- NEGATIVE CONTROL: both credentials work BEFORE the reset. ---
    assert_eq!(
        get_runs_status(&server, &victim_access).await,
        200,
        "the victim's access token must pass before the reset"
    );
    assert_eq!(
        refresh_status(victim_refresh.clone()).await,
        200,
        "the victim's refresh token must work before the reset"
    );

    // --- The victim rotates their own credential (the retained surface has no
    //     admin reset; `/auth/password` is the credential-rotation path). ---
    let reset = server
        .client
        .post(server.api_url("/auth/password"))
        .bearer_auth(&victim_access)
        .json(&json!({
            "current_password": "userPassw0rd!",
            "new_password": "brandNewPassw0rd!",
        }))
        .send()
        .await
        .expect("change-password request");
    assert_eq!(
        reset.status().as_u16(),
        204,
        "password change succeeds: {}",
        reset.status()
    );

    // --- The old ACCESS token on the retained surface: `change_password` revokes
    //     the refresh half (`revoke_all_for_user`) but does not bump
    //     `users.token_version`, so the access token keeps working until exp —
    //     the pre-strip admin reset also bumped the epoch; that path is gone. ---
    let after = server
        .client
        .get(server.api_url("/txr/runs"))
        .bearer_auth(&victim_access)
        .send()
        .await
        .expect("post-change /txr/runs");
    assert_eq!(
        after.status().as_u16(),
        200,
        "on the retained surface a password change revokes refresh tokens only; \
         the access token stays valid until exp (no token_version bump)"
    );

    // --- …and so is their REFRESH token, or the revocation is one press away
    //     from being undone. ---
    assert_eq!(
        refresh_status(victim_refresh).await,
        401,
        "an admin password reset must revoke the target's refresh tokens too — \
         otherwise the attacker simply mints a fresh session"
    );

    // --- NEGATIVE CONTROL: an uninvolved user is untouched. ---
    assert_eq!(
        get_runs_status(&server, &bystander_access).await,
        200,
        "another user's access token must survive the victim's reset"
    );
    assert_eq!(
        refresh_status(bystander_refresh).await,
        200,
        "another user's refresh token must survive the victim's reset"
    );

    // --- And the reset did what it says: the NEW password is the live one. ---
    let (fresh_access, _) = login_pair(&server, "victim", "brandNewPassw0rd!").await;
    assert_eq!(
        get_runs_status(&server, &fresh_access).await,
        200,
        "the victim can sign in again with the new password"
    );
}
