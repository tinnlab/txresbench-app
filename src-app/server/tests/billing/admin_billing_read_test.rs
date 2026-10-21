//! #36 — admin read-any-account subscription / usage / quota acceptance tests.
//!
//! The cross-account, PATH-scoped READS of ANY account's billing state, gated on
//! `billing::admin`. These drive the REAL spawned server + real Postgres (per-test DB) with
//! seeded `usage_rollup` / plan / spend-cap rows on a FOREIGN account (one the caller is NOT a
//! member of). NO Stripe, NO network — pure DB reads through the admin routes.
//!
//! Like the other billing HTTP acceptance tests (`quota_test`), the billing route surface
//! mounts only when `STRIPE_SECRET_KEY` is configured (the §16 kill-switch), which the saas
//! tier (`just billing-sim-test-l2-saas`) exports — so this suite runs inside that tier.
//!
//! Pins the four #36 invariants:
//!  - INV-1 admin (or billing::admin holder) reads ANY account (TEST-1),
//!  - INV-2 non-admin → 403 on the admin routes; a self-serve billing::manage holder can't use
//!    the admin route for another account (TEST-2),
//!  - INV-3 the self-serve `/billing/*` path is unchanged for a member (TEST-3),
//!  - INV-5 the read is path-scoped — the RIGHT account's data, no cross-account leak (TEST-5).
//!  (INV-4 saas compile-out is proven by the source-grep in `saas_gating_test.rs`.)

use serde_json::Value;

use crate::account::{
    create_user, create_user_without_projects, login, make_org_account, pool_for, setup_admin,
};
use crate::billing::helpers::{
    admin_billing_get, create_billing_admin_holder, grant_credit, put_premium, quota_get,
    seed_rollup_usage, set_account_plan, set_account_status, set_plan, set_spend_cap_row, usage,
};
use crate::common::TestServer;

/// Seed a FOREIGN org account (owned by `owner`, which none of the admin callers is a member
/// of) with a distinct, assertable billing state. Returns the account id.
async fn seed_foreign_account(
    pool: &sqlx::PgPool,
    name: &str,
    owner: uuid::Uuid,
    plan: &str,
    status: &str,
    compute_core_hours: f64,
    storage_gb_months: f64,
    spend_cap_cents: Option<i64>,
) -> uuid::Uuid {
    let acct = make_org_account(pool, name, owner).await;
    set_account_plan(pool, acct, plan).await;
    set_account_status(pool, acct, status).await;
    seed_rollup_usage(pool, acct, compute_core_hours, 0.0, storage_gb_months).await;
    if let Some(c) = spend_cap_cents {
        set_spend_cap_row(pool, acct, Some(c)).await;
    }
    acct
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-1 [acceptance][INV-1] — a root admin AND a non-admin billing::admin grant-holder
// each read a FOREIGN account's billing / usage / quota → 200 with THAT account's data.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn admin_and_grant_holder_read_any_account_billing_usage_quota() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Alice owns an ORG account; neither the root admin nor the billing::admin holder is a
    // member — so any 200 is a MEMBERSHIP-FREE admin read (the #36 bypass). Seed pro / past_due
    // / 42 core-hours / 3 GB-months / 750¢ cap.
    let alice_id = create_user(&server, &admin, "abr_alice", "abr_alice@x.test").await;
    let org = seed_foreign_account(
        &pool,
        "Acme Lab",
        alice_id,
        "pro",
        "past_due",
        42.0,
        3.0,
        Some(750),
    )
    .await;
    let org_s = org.to_string();
    let holder = create_billing_admin_holder(&server, &admin, "abr_bob", "abr_bob@x.test").await;

    for (who, token) in [
        ("root admin", admin.as_str()),
        ("billing::admin holder", holder.as_str()),
    ] {
        // --- /billing: subscription state.
        let resp = admin_billing_get(&server, Some(token), &org_s, "billing").await;
        assert_eq!(resp.status().as_u16(), 200, "{who} reads /billing → 200");
        let b: Value = resp.json().await.expect("billing json");
        assert_eq!(
            b["account_id"].as_str(),
            Some(org_s.as_str()),
            "{who}: path account echoed"
        );
        assert_eq!(b["plan_id"].as_str(), Some("pro"), "{who}: plan");
        assert_eq!(
            b["subscription_status"].as_str(),
            Some("past_due"),
            "{who}: status"
        );
        assert_eq!(
            b["suspended"].as_bool(),
            Some(false),
            "{who}: past_due is not suspended"
        );

        // --- /usage: the rollup rows.
        let resp = admin_billing_get(&server, Some(token), &org_s, "usage").await;
        assert_eq!(resp.status().as_u16(), 200, "{who} reads /usage → 200");
        let u: Value = resp.json().await.expect("usage json");
        assert!(
            u["total"].as_i64().unwrap_or(0) >= 1,
            "{who}: ≥1 rollup row"
        );
        let row0 = &u["rows"][0];
        assert_eq!(
            row0["account_id"].as_str(),
            Some(org_s.as_str()),
            "{who}: row is org's"
        );
        assert!(
            (row0["compute_core_hours"].as_f64().unwrap() - 42.0).abs() < 1e-9,
            "{who}: seeded compute usage"
        );

        // --- /quota: plan limits + consumption + cap.
        let resp = admin_billing_get(&server, Some(token), &org_s, "quota").await;
        assert_eq!(resp.status().as_u16(), 200, "{who} reads /quota → 200");
        let q: Value = resp.json().await.expect("quota json");
        assert_eq!(q["plan_id"].as_str(), Some("pro"), "{who}: quota plan");
        assert!(
            (q["compute_used"].as_f64().unwrap() - 42.0).abs() < 1e-9,
            "{who}: used"
        );
        assert!(
            (q["compute_allowance"].as_f64().unwrap() - 100.0).abs() < 1e-9,
            "{who}: allowance"
        );
        assert_eq!(q["spend_cap_cents"].as_i64(), Some(750), "{who}: cap");
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-2 (billing-read-surface) [acceptance][invariant: INV-1] — the #38/#39 read
// projections premium / plan_manually_set / credit_balance_cents are reported by
// GET .../billing for an authorized admin (root AND a billing::admin grant-holder)
// with correct values, and NEVER reach a non-billing-admin (403). Backend deny (A9).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn admin_billing_read_reports_premium_plan_override_and_credit_balance() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let alice_id = create_user(&server, &admin, "abx_alice", "abx_alice@x.test").await;
    let org = make_org_account(&pool, "Proj Lab", alice_id).await;
    let org_s = org.to_string();

    // Seed the three WRITE-only override states via their REAL admin write routes: the comp/premium
    // override, an admin plan override (which marks plan_manually_set = true), and a 2500¢ grant.
    assert_eq!(
        put_premium(&server, Some(&admin), &org_s, true, Some("comp"))
            .await
            .status()
            .as_u16(),
        200,
        "seed premium override"
    );
    assert_eq!(
        set_plan(&server, Some(&admin), &org_s, "pro")
            .await
            .status()
            .as_u16(),
        200,
        "seed admin plan override"
    );
    assert_eq!(
        grant_credit(&server, Some(&admin), &org_s, 2500, "goodwill", None)
            .await
            .status()
            .as_u16(),
        200,
        "seed credit grant"
    );

    let holder = create_billing_admin_holder(&server, &admin, "abx_bob", "abx_bob@x.test").await;
    for (who, token) in [
        ("root admin", admin.as_str()),
        ("billing::admin holder", holder.as_str()),
    ] {
        let resp = admin_billing_get(&server, Some(token), &org_s, "billing").await;
        assert_eq!(resp.status().as_u16(), 200, "{who} reads /billing → 200");
        let b: Value = resp.json().await.expect("billing json");
        assert_eq!(
            b["premium"].as_bool(),
            Some(true),
            "{who}: premium override reported"
        );
        assert_eq!(
            b["plan_manually_set"].as_bool(),
            Some(true),
            "{who}: plan-override marker reported"
        );
        assert_eq!(
            b["credit_balance_cents"].as_i64(),
            Some(2500),
            "{who}: credit balance reported"
        );
    }

    // A9 — a plain user (self-serve billing::manage but NOT billing::admin) is 403: the new fields
    // are behind the SAME gate as the endpoint, so they never leak to a non-billing-admin.
    let _c = create_user(&server, &admin, "abx_carol", "abx_carol@x.test").await;
    let carol = login(&server, "abx_carol").await;
    assert_eq!(
        admin_billing_get(&server, Some(&carol), &org_s, "billing")
            .await
            .status()
            .as_u16(),
        403,
        "a non-billing-admin → 403 on the admin /billing (the new fields never leak)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-2 [acceptance][INV-2] — the admin routes are gated: 401 unauth, 403 for a plain
// user AND for a self-serve billing::manage holder (the OWN-account perm confers no
// cross-account admin power), 404 for an authorized admin on a nonexistent id.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn admin_billing_routes_are_gated_and_no_oracle() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let alice_id = create_user(&server, &admin, "abg_alice", "abg_alice@x.test").await;
    let org = make_org_account(&pool, "Gated Lab", alice_id).await;
    let org_s = org.to_string();

    // A plain user: default Users perms incl. self-serve billing::read/manage for their OWN
    // account, but NOT billing::admin. Created ONCE (re-creating would 409).
    let _c = create_user(&server, &admin, "abg_carol", "abg_carol@x.test").await;
    let carol = login(&server, "abg_carol").await;

    for leaf in ["billing", "usage", "quota"] {
        // 401 — no bearer.
        assert_eq!(
            admin_billing_get(&server, None, &org_s, leaf)
                .await
                .status()
                .as_u16(),
            401,
            "unauth /{leaf} → 401"
        );

        // 403 — the self-serve billing::manage holder is denied the admin route for the org.
        assert_eq!(
            admin_billing_get(&server, Some(&carol), &org_s, leaf)
                .await
                .status()
                .as_u16(),
            403,
            "a self-serve billing::manage holder is 403 on the admin /{leaf} for another account"
        );

        // 404 — an authorized admin on a NONEXISTENT account id (authz decided before lookup,
        // so a 403-vs-404 split cannot be an existence oracle for a non-admin: the non-admin
        // above got 403 for a REAL account too).
        let ghost = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            admin_billing_get(&server, Some(&admin), &ghost, leaf)
                .await
                .status()
                .as_u16(),
            404,
            "admin on a nonexistent id /{leaf} → 404"
        );
    }

    // A user with NO billing perms at all is likewise 403 (not 401, not 404) — the negative
    // control that the gate is the perm, not merely authentication.
    let _np = create_user_without_projects(&server, &admin, "abg_np", "abg_np@x.test").await;
    let np = login(&server, "abg_np").await;
    assert_eq!(
        admin_billing_get(&server, Some(&np), &org_s, "billing")
            .await
            .status()
            .as_u16(),
        403,
        "a user lacking billing::admin → 403 on the admin route"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-3 [acceptance][INV-3] — the self-serve /billing/* path is UNCHANGED: with the admin
// surface mounted, a MEMBER still reads their own account via the self-serve endpoints.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn self_serve_billing_path_is_unchanged() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Alice owns an org account and IS its owner-member; she reads it via the self-serve path
    // (X-Account-Id = org), which resolves through membership exactly as before.
    let alice_id = create_user(&server, &admin, "abs_alice", "abs_alice@x.test").await;
    let alice = login(&server, "abs_alice").await;
    let org =
        seed_foreign_account(&pool, "Self Lab", alice_id, "pro", "active", 7.0, 1.0, None).await;

    // Self-serve quota → 200 with the org's own state.
    let q = quota_get(&server, &alice, Some(org)).await;
    assert_eq!(
        q.status().as_u16(),
        200,
        "member reads own quota via self-serve → 200"
    );
    let qb: Value = q.json().await.expect("self-serve quota json");
    assert_eq!(qb["plan_id"].as_str(), Some("pro"));
    assert!((qb["compute_used"].as_f64().unwrap() - 7.0).abs() < 1e-9);

    // Self-serve usage → 200 with the org's rows.
    let u = usage(&server, &alice, Some(org), 1, 20).await;
    assert_eq!(
        u.status().as_u16(),
        200,
        "member reads own usage via self-serve → 200"
    );
    let ub: Value = u.json().await.expect("self-serve usage json");
    assert!(
        ub["total"].as_i64().unwrap_or(0) >= 1,
        "own rollup row present"
    );

    // A NON-member still 404s the self-serve path for the org (no admin bypass leaked in).
    let _c = create_user(&server, &admin, "abs_carol", "abs_carol@x.test").await;
    let carol = login(&server, "abs_carol").await;
    assert_eq!(
        quota_get(&server, &carol, Some(org))
            .await
            .status()
            .as_u16(),
        404,
        "a non-member still 404s the self-serve quota (membership path unchanged)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-5 [acceptance][INV-5] — the admin read is PATH-scoped: reading account A vs B returns
// A's vs B's data (never the caller's own account, never the other account's).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn admin_billing_read_is_path_scoped_no_cross_account_leak() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Two DISTINCT foreign accounts. The admin's OWN personal account (plan 'free') must never
    // be what these path routes return.
    let alice_id = create_user(&server, &admin, "abp_alice", "abp_alice@x.test").await;
    let bob_id = create_user(&server, &admin, "abp_bob", "abp_bob@x.test").await;
    let acct_a = seed_foreign_account(
        &pool,
        "Account A",
        alice_id,
        "pro",
        "active",
        90.0,
        2.0,
        Some(1000),
    )
    .await;
    let acct_b = seed_foreign_account(
        &pool,
        "Account B",
        bob_id,
        "free",
        "canceled",
        0.5,
        0.0,
        None,
    )
    .await;
    let (a_s, b_s) = (acct_a.to_string(), acct_b.to_string());

    // Reading A's path yields A's data.
    let qa: Value = admin_billing_get(&server, Some(&admin), &a_s, "quota")
        .await
        .json()
        .await
        .expect("quota A");
    assert_eq!(qa["plan_id"].as_str(), Some("pro"), "A → A's plan");
    assert!(
        (qa["compute_used"].as_f64().unwrap() - 90.0).abs() < 1e-9,
        "A → A's usage"
    );
    assert_eq!(qa["spend_cap_cents"].as_i64(), Some(1000), "A → A's cap");

    let ba: Value = admin_billing_get(&server, Some(&admin), &a_s, "billing")
        .await
        .json()
        .await
        .expect("billing A");
    assert_eq!(
        ba["account_id"].as_str(),
        Some(a_s.as_str()),
        "billing A echoes A"
    );
    assert_eq!(
        ba["suspended"].as_bool(),
        Some(false),
        "A active → not suspended"
    );

    // Reading B's path yields B's DIFFERENT data — not A's, not the admin's own 'free' account.
    let qb: Value = admin_billing_get(&server, Some(&admin), &b_s, "quota")
        .await
        .json()
        .await
        .expect("quota B");
    assert_eq!(
        qb["plan_id"].as_str(),
        Some("free"),
        "B → B's plan (not A's pro)"
    );
    assert!(
        (qb["compute_used"].as_f64().unwrap() - 0.5).abs() < 1e-9,
        "B → B's usage (not A's 90)"
    );
    assert!(
        qb["spend_cap_cents"].is_null(),
        "B has no cap (not A's 1000)"
    );

    let bb: Value = admin_billing_get(&server, Some(&admin), &b_s, "billing")
        .await
        .json()
        .await
        .expect("billing B");
    assert_eq!(
        bb["account_id"].as_str(),
        Some(b_s.as_str()),
        "billing B echoes B (not A)"
    );
    assert_eq!(bb["subscription_status"].as_str(), Some("canceled"));
    assert_eq!(
        bb["suspended"].as_bool(),
        Some(true),
        "B canceled → suspended"
    );
}
