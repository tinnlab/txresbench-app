//! Shared helpers for the B2 billing integration tests (saas-only). Reuses the
//! `crate::account` harness helpers (setup_admin / create_user / login / pool_for)
//! and adds billing-specific request + DB-read helpers. All these tests run against
//! **B0's sim** (`just billing-sim-up` + the sourced `STRIPE_API_BASE`/
//! `STRIPE_SECRET_KEY` env), guard-first, NO network (INV-4) — so each self-SKIPS
//! (never a bare pass) when the sim env is absent, and that skip is a HARD FAILURE
//! under `CYTO_TEST_NO_SKIP=1` (the mode the tier runs in).

use chrono::{DateTime, Utc};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::common::TestServer;

// ─────────────────────────── B3 webhook helpers ───────────────────────────

/// Directly link an account to a Stripe `customer` id (the reverse-resolvable link the
/// webhook path needs). Lets a webhook test set up the account↔customer link without a live
/// stripe-mock checkout — the webhook path itself never calls Stripe, it only verifies +
/// writes the DB.
pub async fn link_customer(pool: &PgPool, account: Uuid, customer: &str) {
    sqlx::query("UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2")
        .bind(customer)
        .bind(account)
        .execute(pool)
        .await
        .expect("link stripe customer");
}

/// The account's `(subscription_status, plan_id, grace_until)` billing-state (the columns B3
/// writes).
pub async fn billing_state(
    pool: &PgPool,
    account: Uuid,
) -> (String, String, Option<DateTime<Utc>>) {
    sqlx::query_as::<_, (String, String, Option<DateTime<Utc>>)>(
        "SELECT subscription_status, plan_id, grace_until FROM accounts WHERE id = $1",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .expect("read account billing-state")
}

/// POST a signed webhook body to the REAL `/api/billing/webhook` handler (no bearer — the
/// signature IS the auth, DEC-8).
pub async fn post_webhook(server: &TestServer, sig: &str, body: &[u8]) -> reqwest::Response {
    server
        .client
        .post(server.api_url("/billing/webhook"))
        .header("stripe-signature", sig)
        .body(body.to_vec())
        .send()
        .await
        .expect("webhook request")
}

/// The number of `billing_webhook_events` rows for an `event_id` (0 or 1 — the dedupe PK).
pub async fn count_webhook_events(pool: &PgPool, event_id: &str) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM billing_webhook_events WHERE event_id = $1")
        .bind(event_id)
        .fetch_one(pool)
        .await
        .expect("count webhook events")
}

/// Seed ONE tenant-data `projects` row for an account (the suspend-never-delete witness —
/// TEST-3 asserts it still EXISTS after a cancel).
pub async fn seed_project(pool: &PgPool, owner: Uuid, account: Uuid, name: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO projects (id, owner_id, account_id, name) VALUES ($1, $2, $3, $4)")
        .bind(id)
        .bind(owner)
        .bind(account)
        .bind(name)
        .execute(pool)
        .await
        .expect("seed project");
    id
}

/// Whether a `projects` row still exists (a cancel must NEVER delete tenant data — INV-1).
pub async fn project_exists(pool: &PgPool, project_id: Uuid) -> bool {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM projects WHERE id = $1")
        .bind(project_id)
        .fetch_one(pool)
        .await
        .expect("count project")
        > 0
}

/// The dev-default base price id for a catalog plan (what the webhook maps back to a plan via
/// `catalog::plan_id_for_price`). Mirrors the `catalog::Plan::base_price_default` values.
pub fn base_price_for(plan: &str) -> &'static str {
    match plan {
        "pro" => "price_pro_base",
        _ => "price_free_base",
    }
}

/// The sim base URL, or `None` if `STRIPE_API_BASE` is unset/empty.
pub fn sim_base() -> Option<String> {
    std::env::var("STRIPE_API_BASE")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// Guard: return the sim base, or record a self-skip (hard-fail under
/// `CYTO_TEST_NO_SKIP=1`) and return `None`.
pub fn require_sim(test: &str) -> Option<String> {
    match sim_base() {
        Some(b) => Some(b),
        None => {
            super::record_skip(
                test,
                "STRIPE_API_BASE unset — run via `just billing-sim-up`, source the env, then \
                 `cargo test --features saas billing::` (brings up stripe-mock + the env contract)",
            );
            None
        }
    }
}

/// `POST /api/billing/checkout` with an optional `X-Account-Id` header.
pub async fn checkout(
    server: &TestServer,
    token: &str,
    account: Option<Uuid>,
    plan_id: &str,
) -> reqwest::Response {
    let mut req = server
        .client
        .post(server.api_url("/billing/checkout"))
        .bearer_auth(token)
        .json(&json!({ "plan_id": plan_id }));
    if let Some(a) = account {
        req = req.header("X-Account-Id", a.to_string());
    }
    req.send().await.expect("checkout request")
}

/// `POST /api/billing/checkout` WITHOUT a bearer token (the 401 path).
pub async fn checkout_unauth(server: &TestServer, plan_id: &str) -> reqwest::Response {
    server
        .client
        .post(server.api_url("/billing/checkout"))
        .json(&json!({ "plan_id": plan_id }))
        .send()
        .await
        .expect("unauth checkout request")
}

/// `POST /api/billing/portal` with an optional `X-Account-Id` header.
pub async fn portal(server: &TestServer, token: &str, account: Option<Uuid>) -> reqwest::Response {
    let mut req = server
        .client
        .post(server.api_url("/billing/portal"))
        .bearer_auth(token);
    if let Some(a) = account {
        req = req.header("X-Account-Id", a.to_string());
    }
    req.send().await.expect("portal request")
}

/// The persisted `stripe_customer_id` for an account (the link write, PROV-B2-1).
pub async fn account_customer(pool: &PgPool, account: Uuid) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT stripe_customer_id FROM accounts WHERE id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("read stripe_customer_id")
}

/// The persisted `plan_id` for an account (must stay `free` after checkout — INV-2).
pub async fn account_plan(pool: &PgPool, account: Uuid) -> String {
    sqlx::query_scalar::<_, String>("SELECT plan_id FROM accounts WHERE id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("read plan_id")
}

/// The id of `user_id`'s personal account (the INV-1 default the checkout acts under
/// when no `X-Account-Id` is sent).
pub async fn personal_account_id(pool: &PgPool, user_id: Uuid) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM accounts WHERE kind='personal' AND personal_user_id=$1",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .expect("personal account exists")
}

/// `GET /api/billing/usage` with an optional `X-Account-Id` header (B1 / PROV-B1-2).
pub async fn usage(
    server: &TestServer,
    token: &str,
    account: Option<Uuid>,
    page: i32,
    per_page: i32,
) -> reqwest::Response {
    let mut req = server
        .client
        .get(server.api_url(&format!("/billing/usage?page={page}&per_page={per_page}")))
        .bearer_auth(token);
    if let Some(a) = account {
        req = req.header("X-Account-Id", a.to_string());
    }
    req.send().await.expect("usage request")
}

/// `GET /api/billing/usage` WITHOUT a bearer token (the 401 path).
pub async fn usage_unauth(server: &TestServer) -> reqwest::Response {
    server
        .client
        .get(server.api_url("/billing/usage"))
        .send()
        .await
        .expect("unauth usage request")
}

/// Seed ONE fake `compute_meter` row (stands in for T5's account-keyed finalize —
/// the real finalize path is compute-epic's; B1 only READS the row). `resource_class`
/// drives the CPU/GPU split B1 folds.
#[allow(clippy::too_many_arguments)]
pub async fn seed_compute_meter(
    pool: &PgPool,
    account: Uuid,
    resource_class: &str,
    cpu_secs: f64,
    gpu_secs: f64,
    finished_at: chrono::DateTime<chrono::Utc>,
) -> Uuid {
    let job_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO compute_meter
           (job_id, project_id, cpu_secs, wall_secs, gpu_secs, ram_peak_bytes, exit_code,
            account_id, resource_class, finished_at)
         VALUES ($1, NULL, $2, $2, $3, NULL, 0, $4, $5, $6)",
    )
    .bind(job_id)
    .bind(cpu_secs)
    .bind(gpu_secs)
    .bind(account)
    .bind(resource_class)
    .bind(finished_at)
    .execute(pool)
    .await
    .expect("seed compute_meter");
    job_id
}

/// Seed ONE fake `storage_meter` byte-delta (stands in for T5's account-keyed
/// ingest/GC emit). `+delta` at ingest / `−delta` at gc.
pub async fn seed_storage_meter(
    pool: &PgPool,
    account: Uuid,
    delta_bytes: i64,
    logical_bytes: Option<i64>,
    reason: &str,
    created_at: chrono::DateTime<chrono::Utc>,
) {
    sqlx::query(
        "INSERT INTO storage_meter
           (project_id, content_hash, delta_bytes, reason, account_id, logical_bytes, created_at)
         VALUES (NULL, $1, $2, $3, $4, $5, $6)",
    )
    .bind(format!("sha256:{}", Uuid::new_v4().simple()))
    .bind(delta_bytes)
    .bind(reason)
    .bind(account)
    .bind(logical_bytes)
    .bind(created_at)
    .execute(pool)
    .await
    .expect("seed storage_meter");
}

// ─────────────────────────── #36 admin read-any-account helpers ───────────────────────────

/// Create a NON-admin user who holds `billing::admin` via a DEDICATED group (NOT the Users
/// group — so the perm is isolated to this user and does not leak to the other test users).
/// Returns their access token. This is the "grant-holder" half of INV-1: cross-account admin
/// billing reachable by the grant, not only by `is_admin`. Mirrors `tests/admin/mod.rs`'s
/// `create_admin_accounts_holder` but grants the billing key.
pub async fn create_billing_admin_holder(
    server: &TestServer,
    admin: &str,
    username: &str,
    email: &str,
) -> String {
    let id = crate::account::create_user(server, admin, username, email).await;

    let group = server
        .client
        .post(server.api_url("/groups"))
        .bearer_auth(admin)
        .json(&json!({
            "name": format!("billing-admin-{username}"),
            "description": "",
            "permissions": ["billing::admin"],
        }))
        .send()
        .await
        .expect("create billing-admin group");
    assert_eq!(group.status().as_u16(), 201, "create billing-admin group");
    let group_id = group.json::<serde_json::Value>().await.expect("group json")["id"]
        .as_str()
        .expect("group id")
        .to_string();

    let assign = server
        .client
        .post(server.api_url("/groups/assign"))
        .bearer_auth(admin)
        .json(&json!({ "user_id": id, "group_id": group_id }))
        .send()
        .await
        .expect("assign billing-admin group");
    assert!(
        assign.status().is_success(),
        "assign billing-admin group: {}",
        assign.status()
    );

    crate::account::login(server, username).await
}

/// `GET /api/admin/accounts/{account_id}/{leaf}` with an optional bearer → the raw response.
/// `leaf` is `billing` / `usage` / `quota`. Used by the #36 admin-read acceptance tests.
pub async fn admin_billing_get(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
    leaf: &str,
) -> reqwest::Response {
    let mut req = server
        .client
        .get(server.api_url(&format!("/admin/accounts/{account}/{leaf}")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("admin billing get")
}

// ─────────────────────────── B4 quota helpers ───────────────────────────

/// The first instant of the current UTC calendar month — the `period_start` B4's quota +
/// alert code keys the current period on (mirrors `rollup::current_period`).
pub fn current_month_start() -> DateTime<Utc> {
    use chrono::{Datelike, TimeZone};
    let now = Utc::now();
    Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or(now)
}

/// Upsert the account's CURRENT-period `usage_rollup` row to exact billable figures — the
/// FAKE B1 fold output B4's `check_quota` + alert loop read. Sets the figures absolutely
/// (not additive) so a test can march usage across ladder rungs.
pub async fn seed_rollup_usage(
    pool: &PgPool,
    account: Uuid,
    compute_core_hours: f64,
    gpu_hours: f64,
    storage_gb_months: f64,
) {
    let ps = current_month_start();
    let pe = {
        use chrono::Duration;
        ps + Duration::days(31)
    };
    sqlx::query(
        "INSERT INTO usage_rollup
           (account_id, period_start, period_end, compute_core_hours, gpu_hours, storage_gb_months)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account_id, period_start)
         DO UPDATE SET compute_core_hours = $4, gpu_hours = $5, storage_gb_months = $6,
                       updated_at = now()",
    )
    .bind(account)
    .bind(ps)
    .bind(pe)
    .bind(compute_core_hours)
    .bind(gpu_hours)
    .bind(storage_gb_months)
    .execute(pool)
    .await
    .expect("seed usage_rollup");
}

/// Set the account's `plan_id` (B2's catalog key `check_quota` reads).
pub async fn set_account_plan(pool: &PgPool, account: Uuid, plan_id: &str) {
    sqlx::query("UPDATE accounts SET plan_id = $1 WHERE id = $2")
        .bind(plan_id)
        .bind(account)
        .execute(pool)
        .await
        .expect("set plan_id");
}

/// Set the account's `subscription_status` (B3's billing-state `is_suspended` reads).
pub async fn set_account_status(pool: &PgPool, account: Uuid, status: &str) {
    sqlx::query("UPDATE accounts SET subscription_status = $1 WHERE id = $2")
        .bind(status)
        .bind(account)
        .execute(pool)
        .await
        .expect("set subscription_status");
}

/// Directly upsert the account's opt-in spend cap (ITEM-2) without the HTTP path.
pub async fn set_spend_cap_row(pool: &PgPool, account: Uuid, cents: Option<i64>) {
    sqlx::query(
        "INSERT INTO account_spend_cap (account_id, overage_cap_cents, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (account_id) DO UPDATE SET overage_cap_cents = $2, updated_at = now()",
    )
    .bind(account)
    .bind(cents)
    .execute(pool)
    .await
    .expect("set spend cap");
}

/// The stamped alert level for `(account, current period, resource)` — 0 when none fired.
pub async fn alert_level_of(pool: &PgPool, account: Uuid, resource: &str) -> i16 {
    sqlx::query_scalar::<_, i16>(
        "SELECT level_notified FROM usage_alert_state
         WHERE account_id = $1 AND period_start = $2 AND resource = $3",
    )
    .bind(account)
    .bind(current_month_start())
    .bind(resource)
    .fetch_optional(pool)
    .await
    .expect("read alert level")
    .unwrap_or(0)
}

/// `GET /api/billing/quota` with an optional `X-Account-Id` header (B4 / PROV-B4-2).
pub async fn quota_get(
    server: &TestServer,
    token: &str,
    account: Option<Uuid>,
) -> reqwest::Response {
    let mut req = server
        .client
        .get(server.api_url("/billing/quota"))
        .bearer_auth(token);
    if let Some(a) = account {
        req = req.header("X-Account-Id", a.to_string());
    }
    req.send().await.expect("quota request")
}

/// `GET /api/billing/quota` WITHOUT a bearer token (the 401 path).
pub async fn quota_get_unauth(server: &TestServer) -> reqwest::Response {
    server
        .client
        .get(server.api_url("/billing/quota"))
        .send()
        .await
        .expect("unauth quota request")
}

/// `PUT /api/billing/quota/spend-cap` with an optional `X-Account-Id` header. `cents = None`
/// sends `{"overage_cap_cents": null}` (clears the cap).
pub async fn spend_cap_put(
    server: &TestServer,
    token: &str,
    account: Option<Uuid>,
    cents: Option<i64>,
) -> reqwest::Response {
    let mut req = server
        .client
        .put(server.api_url("/billing/quota/spend-cap"))
        .bearer_auth(token)
        .json(&json!({ "overage_cap_cents": cents }));
    if let Some(a) = account {
        req = req.header("X-Account-Id", a.to_string());
    }
    req.send().await.expect("spend-cap put request")
}

/// The current-period `usage_rollup` row for an account, if any — `(compute_core_hours,
/// gpu_hours, storage_gb_months, last_meter_seen, reported_at)`.
#[allow(clippy::type_complexity)]
pub async fn current_rollup(
    pool: &PgPool,
    account: Uuid,
) -> Option<(
    f64,
    f64,
    f64,
    Option<chrono::DateTime<chrono::Utc>>,
    Option<chrono::DateTime<chrono::Utc>>,
)> {
    sqlx::query_as::<
        _,
        (
            f64,
            f64,
            f64,
            Option<chrono::DateTime<chrono::Utc>>,
            Option<chrono::DateTime<chrono::Utc>>,
        ),
    >(
        "SELECT compute_core_hours, gpu_hours, storage_gb_months, last_meter_seen, reported_at
         FROM usage_rollup WHERE account_id = $1 ORDER BY period_start DESC LIMIT 1",
    )
    .bind(account)
    .fetch_optional(pool)
    .await
    .expect("read usage_rollup")
}

// ─────────────────────────── #39 admin credit / premium helpers ───────────────────────────

/// `POST /api/admin/accounts/{account_id}/credits` — grant credits (raw response). `expires_at` is
/// an optional RFC-3339 string.
pub async fn grant_credit(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
    amount_cents: i64,
    reason: &str,
    expires_at: Option<&str>,
) -> reqwest::Response {
    let mut body = json!({ "amount_cents": amount_cents, "reason": reason });
    if let Some(e) = expires_at {
        body["expires_at"] = json!(e);
    }
    let mut req = server
        .client
        .post(server.api_url(&format!("/admin/accounts/{account}/credits")))
        .json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("grant credit request")
}

/// `GET /api/admin/accounts/{account_id}/credits` — the balance + ledger (raw response).
pub async fn get_credits(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
) -> reqwest::Response {
    let mut req = server
        .client
        .get(server.api_url(&format!("/admin/accounts/{account}/credits")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("get credits request")
}

/// `DELETE /api/admin/accounts/{account_id}/credits/{grant_id}` — revoke a grant (raw response).
pub async fn revoke_credit(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
    grant_id: &str,
) -> reqwest::Response {
    let mut req = server.client.delete(
        server.api_url(&format!("/admin/accounts/{account}/credits/{grant_id}")),
    );
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("revoke credit request")
}

/// `PUT /api/admin/accounts/{account_id}/premium` — set/clear the comp override (raw response).
pub async fn put_premium(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
    premium: bool,
    reason: Option<&str>,
) -> reqwest::Response {
    let mut body = json!({ "premium": premium });
    if let Some(r) = reason {
        body["reason"] = json!(r);
    }
    let mut req = server
        .client
        .put(server.api_url(&format!("/admin/accounts/{account}/premium")))
        .json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("put premium request")
}

/// Directly INSERT a credit grant row (bypassing the HTTP path) — lets a test seed an
/// already-EXPIRED grant (`expires_at` in the past), which the API refuses to backdate. Returns
/// the grant id.
pub async fn insert_credit_grant_row(
    pool: &PgPool,
    account: Uuid,
    amount_cents: i64,
    reason: &str,
    granted_by: Uuid,
    expires_at: Option<DateTime<Utc>>,
) -> Uuid {
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO credit_grants (account_id, amount_cents, reason, granted_by, expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(account)
    .bind(amount_cents)
    .bind(reason)
    .bind(granted_by)
    .bind(expires_at)
    .fetch_one(pool)
    .await
    .expect("insert credit grant row")
}

/// The number of `credit_grants` rows for an account (the append-only witness — a revoke must NOT
/// reduce this).
pub async fn count_credit_grants(pool: &PgPool, account: Uuid) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT count(*) FROM credit_grants WHERE account_id = $1")
        .bind(account)
        .fetch_one(pool)
        .await
        .expect("count credit grants")
}

/// The `(revoked_at, revoked_by)` of a grant — asserts a revoke stamped the marker (never deleted).
pub async fn grant_revoke_marker(
    pool: &PgPool,
    grant_id: Uuid,
) -> (Option<DateTime<Utc>>, Option<Uuid>) {
    sqlx::query_as::<_, (Option<DateTime<Utc>>, Option<Uuid>)>(
        "SELECT revoked_at, revoked_by FROM credit_grants WHERE id = $1",
    )
    .bind(grant_id)
    .fetch_one(pool)
    .await
    .expect("read revoke marker")
}

// ─────────────────────────── #37 admin-suspend helpers ───────────────────────────

/// `POST /api/admin/accounts/{account_id}/suspend` — admin-suspend an account (raw response).
pub async fn suspend_account(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
    reason: Option<&str>,
) -> reqwest::Response {
    let body = match reason {
        Some(r) => json!({ "reason": r }),
        None => json!({}),
    };
    let mut req = server
        .client
        .post(server.api_url(&format!("/admin/accounts/{account}/suspend")))
        .json(&body);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("suspend account request")
}

/// `POST /api/admin/accounts/{account_id}/reactivate` — reactivate an account (raw response).
pub async fn reactivate_account(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
) -> reqwest::Response {
    let mut req = server
        .client
        .post(server.api_url(&format!("/admin/accounts/{account}/reactivate")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("reactivate account request")
}

// ─────────────────────────── #38 admin plan-override helpers ───────────────────────────

/// `PUT /api/admin/accounts/{account_id}/plan` — set the admin plan override (raw response).
pub async fn set_plan(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
    plan_id: &str,
) -> reqwest::Response {
    let mut req = server
        .client
        .put(server.api_url(&format!("/admin/accounts/{account}/plan")))
        .json(&json!({ "plan_id": plan_id }));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("set plan request")
}

/// `DELETE /api/admin/accounts/{account_id}/plan` — clear the admin plan override (raw response).
pub async fn clear_plan(
    server: &TestServer,
    token: Option<&str>,
    account: &str,
) -> reqwest::Response {
    let mut req = server
        .client
        .delete(server.api_url(&format!("/admin/accounts/{account}/plan")));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    req.send().await.expect("clear plan request")
}

/// The `(plan_id, plan_manually_set)` of an account (the #38 override columns).
pub async fn plan_state(pool: &PgPool, account: Uuid) -> (String, bool) {
    sqlx::query_as::<_, (String, bool)>(
        "SELECT plan_id, plan_manually_set FROM accounts WHERE id = $1",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .expect("read plan state")
}
