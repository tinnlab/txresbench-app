//! Account module (A1) integration tests — full production path through a real
//! spawned server + real Postgres (per-test DB). These are the executable
//! ACCEPTANCE contracts A2/A3/A4/A5 bind to (the frozen `## Provides` in
//! `.lifecycle/accounts/A1-tables/PLAN.md`).
//!
//! A1 mounts no routes, so these tests exercise the SCHEMA (constraints, grant,
//! backfill idempotency) and the `AccountRepository` reads/ensure directly against
//! the per-test DB pool.

use serde_json::{json, Value};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

use crate::common::TestServer;

/// TEST-19 — the platform-staff actor repository-level tests pass to `set_role` /
/// `remove_member`.
///
/// TEST-19's claim is that the `ActorCeiling::PlatformStaff` widening is MECHANICAL: the three
/// pre-existing suites that call the repository directly (#171's offboarding, 12 sites; #144's
/// personal-account guard, 4; #142's ceiling, 3) still pass with every assertion unchanged.
/// This helper is the one seam all nineteen call sites share, so the id is recorded here.
///
/// #148 widened `ActorCeiling::PlatformStaff` from a unit variant to one carrying a REQUIRED
/// `staff_user_id`, because the audit ledger could not otherwise attribute a staff action —
/// the hole an audit trail most exists to close. The suites that call the repository directly
/// (#171's offboarding, #144's personal-account guard, #142's ceiling) exercise the R-1 and
/// offboarding contracts, not attribution, so they pass ONE stable synthetic id rather than
/// threading a real admin through every call. The ledger's `actor_user_id` column carries no
/// FK by design (an audit row must outlive a deleted actor), so this id is storable, and it is
/// distinctive enough to grep for if it ever shows up somewhere it should not.
pub fn staff_ceiling() -> cytoanalyst::modules::account::ActorCeiling {
    cytoanalyst::modules::account::ActorCeiling::PlatformStaff {
        staff_user_id: uuid::Uuid::parse_str("00000000-0000-4000-8000-00000000f148")
            .expect("static staff uuid"),
    }
}

mod migration_test;
mod repository_test;
mod saas_gating_test;

// A5 — auto-create a personal account on every user-creation path + backstop.
mod auto_personal_test;

// A2 — ownership refactor + backfill + account_of_* resolvers.
mod account_of_test;
mod behavior_preserving_test;
mod ownership_create_test;
mod ownership_migration_test;

// A3 — membership authz flip (composes WITH RBAC; cross-account → 404).
mod account_scope_test;
mod account_scoping_test;
mod authz_scope_test;
mod behavior_preserving_authz_test;
mod cross_account_404_test;
mod rbac_composition_test;

// A4 — active-account context + read REST + sync half.
mod account_sync_test;
mod accounts_api_test;
mod active_account_test;

// Tier-1 admin (#34) — create an org via POST /api/accounts.
mod create_org_test;

// H-1 (#147) / H-2 (#144) — the two live access-control holes: removal must
// revoke (including resources the removed member created), and a PERSONAL
// account's membership may not be mutated.
mod personal_account_membership_test;
mod removal_revokes_test;

// #142 — the self-service member mutations (change role, remove, leave) and the R-1
// role-escalation guard they introduce.
mod member_events_test;
mod member_mutations_test;

// #145 — account invitations: the token model and the create/list/resend/revoke routes,
// their enumeration-safety contract, and INV-R1 at `add_member` (which #145 gave the
// REQUIRED `ActorCeiling` #142 recorded as its debt).
mod account_invitations_test;

// #146 — invitation ACCEPT: token redemption, the email binding, the TOCTOU role re-check
// at redemption, the seat check's accept half, single-use + atomicity, and
// signup-then-accept with ZERO change to `POST /api/auth/register`.
mod invitation_accept_test;

// #141 — the SEAT allowance: `member_allowance` in the plan catalog, enforced
// transactionally at membership creation (`add_member_in_tx`), plus the advisory
// pre-check at invitation mint. Carries BOTH build arms: the enforcement tests under
// `--features saas` and the "desktop is unlimited" control without it.
mod seat_allowance_test;

// #171 — the transfer-side sibling of H-1: `accept_transfer` moved a project OUT of
// its account with no re-validation, so a removed member could take the org's project
// with them. Both remedies (cancel-on-removal AND re-validate-at-accept), each proven
// to refuse alone.
mod transfer_escape_test;

/// The seeded `Users` group id (holds `projects::use` etc.); used to strip a user's
/// baseline RBAC capability for the A9 deny path (RBAC-composition tests).
pub const USERS_GROUP_ID: &str = "79668b78-16ff-4d3f-80e6-afdbb3236dc9";

/// Log a known-password user in → their access token.
pub async fn login(server: &TestServer, username: &str) -> String {
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
    token_of(resp.json().await.expect("login json"))
}

/// Create a user then STRIP them from the Users group → they no longer hold
/// `projects::use` (the RBAC capability), for the "member lacking the perm ⇒ 403"
/// composition half.
pub async fn create_user_without_projects(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> uuid::Uuid {
    let id = create_user(server, admin, username, email).await;
    let resp = server
        .client
        .delete(server.api_url(&format!("/groups/{id}/{USERS_GROUP_ID}/remove")))
        .bearer_auth(admin)
        .send()
        .await
        .expect("remove from group");
    assert!(resp.status().is_success(), "strip group: {}", resp.status());
    id
}

/// Create an ORGANIZATION account with `owner` as its `owner` member, returning the
/// account id — the shared (multi-member) account the A3 flip is exercised against.
pub async fn make_org_account(pool: &SqlitePool, name: &str, owner: uuid::Uuid) -> uuid::Uuid {
    let id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO accounts (kind, name) VALUES ('organization', $1) RETURNING id",
    )
    .bind(name)
    .fetch_one(pool)
    .await
    .expect("insert org account");
    add_member(pool, id, owner, "owner").await;
    id
}

/// Add `user` to `account` with `role` (`owner`/`admin`/`member`).
pub async fn add_member(pool: &SqlitePool, account: uuid::Uuid, user: uuid::Uuid, role: &str) {
    sqlx::query("INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)")
        .bind(account)
        .bind(user)
        .bind(role)
        .execute(pool)
        .await
        .expect("insert account member");
}

/// Move a project into `account` (simulating a project created in / transferred to a
/// shared org account); `owner_id` is left as the creating member.
pub async fn move_project_to_account(pool: &SqlitePool, project: uuid::Uuid, account: uuid::Uuid) {
    sqlx::query("UPDATE projects SET account_id = $1 WHERE id = $2")
        .bind(account)
        .bind(project)
        .execute(pool)
        .await
        .expect("move project to account");
}

/// Move a dataset into `account`.
pub async fn move_dataset_to_account(pool: &SqlitePool, dataset: uuid::Uuid, account: uuid::Uuid) {
    sqlx::query("UPDATE datasets SET account_id = $1 WHERE id = $2")
        .bind(account)
        .bind(dataset)
        .execute(pool)
        .await
        .expect("move dataset to account");
}

/// `POST /api/accounts` (create-org, #34) with an optional bearer + a JSON body →
/// (status, body).
pub async fn post_accounts(
    server: &TestServer,
    token: Option<&str>,
    body: serde_json::Value,
) -> (u16, Value) {
    let mut req = server.client.post(server.api_url("/accounts")).json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.expect("post accounts");
    let status = resp.status().as_u16();
    let b: Value = resp.json().await.unwrap_or(Value::Null);
    (status, b)
}

// ------------------------------- helpers -------------------------------

/// A connection pool onto this test's isolated database — lets a test assert at
/// the DB layer + call `AccountRepository` directly.
pub async fn pool_for(server: &TestServer) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(4)
        .connect(server.database_url())
        .await
        .expect("connect test pool")
}

/// First-run setup → the admin owner + their access token.
pub async fn setup_admin(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/app/setup/admin"))
        .json(&json!({
            "username": "admin",
            "email": "admin@cyto.test",
            "password": "adminPassw0rd!",
            "display_name": "Admin"
        }))
        .send()
        .await
        .expect("setup/admin");
    assert_eq!(resp.status().as_u16(), 201, "setup admin");
    token_of(resp.json().await.expect("setup json"))
}

fn token_of(body: Value) -> String {
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("token in response")
        .to_string()
}

/// Create a user (admin) — auto-joined to the Users group. Returns the id (Uuid).
pub async fn create_user(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> uuid::Uuid {
    let resp = server
        .client
        .post(server.api_url("/users"))
        .bearer_auth(admin)
        .json(&json!({
            "username": username,
            "email": email,
            "password": "userPassw0rd!",
        }))
        .send()
        .await
        .expect("create user");
    assert_eq!(resp.status().as_u16(), 201, "create user {username}");
    let body: Value = resp.json().await.expect("user json");
    body["id"]
        .as_str()
        .expect("user id")
        .parse()
        .expect("user id is a uuid")
}
