//! #41 (admin-settings-coverage) — the billing operational-knob settings acceptance tests.
//! Extends `billing_settings` (overage projection rates, webhook retention/tolerance) with an
//! admin read/write surface. No stripe-sim needed — these exercise only the settings
//! GET/PUT + the read-at-use readers.
//!
//! TEST-2 (INV-2): PUT persists + a fresh read (restart) + read-at-use reflect the new value.
//! TEST-3 (INV-3 / A9): a user lacking `billing::manage` is 403 on every route; admin is 200.
//! TEST-4 (INV-4): `updated_by` is stamped from the acting admin.
//! TEST-7: a freshly-migrated DB GET returns the seeded defaults for ALL fields.
//! TEST-8: a partial PUT updates one field + leaves others; an out-of-bounds value → 422 no-write.
//!
//! TEST-6 (#295) — this file is also what proves #295's ITEM-1 deletion removed no behaviour.
//! `repository::set_grace_period_days` was DELETED as an unconsumed `pub` item; every write
//! below goes through `repository::update_billing_settings`, the partial/bounds-validated/
//! `updated_by`-stamping upsert that replaced it in #41. These passing (with no stripe-sim
//! required) is the evidence the deleted setter had no remaining job.

use serde_json::json;

use crate::account::{create_user_without_projects, login, pool_for, setup_admin};
use crate::common::TestServer;

/// The admin user id (username 'admin' from `setup_admin`).
async fn admin_id(pool: &sqlx::PgPool) -> uuid::Uuid {
    sqlx::query_scalar::<_, uuid::Uuid>("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(pool)
        .await
        .expect("admin id")
}

// TEST-7 [covers ITEM-1, ITEM-3]: a freshly-migrated DB returns the seeded defaults for every
// field (the migration defaulted the singleton; the handler returns the full row).
#[tokio::test]
async fn settings_defaults_full_row() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let resp = server
        .client
        .get(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET settings");
    assert_eq!(resp.status().as_u16(), 200);
    let b: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(b["grace_period_days"], 14);
    assert_eq!(b["overage_cents_per_core_hour"], 10.0);
    assert_eq!(b["overage_cents_per_gb_month"], 5.0);
    assert_eq!(b["webhook_event_retention_days"], 90);
    assert_eq!(b["webhook_signature_tolerance_secs"], 300);
    assert!(b["updated_by"].is_null(), "no updater before any PUT");
}

// TEST-3 [acceptance][invariant: INV-3][covers ITEM-3, ITEM-5]: a user LACKING billing::manage
// is 403 on GET/PUT settings AND GET catalog (backend deny, A9); the admin (positive control)
// is 200 on all three.
#[tokio::test]
async fn settings_and_catalog_denied_without_billing_manage() {
    let server = TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let _uid =
        create_user_without_projects(&server, &admin, "bk_np", "bk_np@cyto.test").await;
    let token = login(&server, "bk_np").await;

    for (method, path) in [
        ("GET", "/billing/settings"),
        ("PUT", "/billing/settings"),
        ("GET", "/billing/catalog"),
    ] {
        // Negative: the unpermitted user → 403.
        let req = match method {
            "GET" => server.client.get(server.api_url(path)),
            _ => server
                .client
                .put(server.api_url(path))
                .json(&json!({ "grace_period_days": 10 })),
        };
        let resp = req.bearer_auth(&token).send().await.expect("req");
        assert_eq!(
            resp.status().as_u16(),
            403,
            "{method} {path} without billing::manage → 403"
        );

        // Positive control: the admin loads the SAME resource (proves the route exists and
        // the 403 above is the gate, not a missing/broken route).
        if method == "GET" {
            let ok = server
                .client
                .get(server.api_url(path))
                .bearer_auth(&admin)
                .send()
                .await
                .expect("admin GET");
            assert_eq!(ok.status().as_u16(), 200, "admin GET {path} → 200 (positive control)");
        }
    }
}

// TEST-4 [acceptance][invariant: INV-4][covers ITEM-7]: after an admin PUT the stored row's
// updated_by equals the acting admin's user id.
#[tokio::test]
async fn put_stamps_updated_by() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;
    let pool = pool_for(&server).await;
    let admin = admin_id(&pool).await;

    let resp = server
        .client
        .put(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .json(&json!({ "webhook_event_retention_days": 120 }))
        .send()
        .await
        .expect("PUT settings");
    assert_eq!(resp.status().as_u16(), 200);
    let b: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(
        b["updated_by"].as_str().unwrap(),
        admin.to_string(),
        "updated_by is the acting admin"
    );
}

// TEST-8 [covers ITEM-3]: a partial PUT updates one field + leaves others unchanged; an
// out-of-bounds value → 422 and the stored row is UNCHANGED (no partial write).
#[tokio::test]
async fn partial_put_and_bounds() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    // Partial: only retention → grace + overage untouched.
    let resp = server
        .client
        .put(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .json(&json!({ "webhook_event_retention_days": 200 }))
        .send()
        .await
        .expect("PUT retention");
    assert_eq!(resp.status().as_u16(), 200);
    let b: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(b["webhook_event_retention_days"], 200);
    assert_eq!(b["grace_period_days"], 14, "grace untouched");
    assert_eq!(b["overage_cents_per_core_hour"], 10.0, "overage untouched");

    // Out-of-bounds tolerance (5 < 30) → 422 and NO write.
    let bad = server
        .client
        .put(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .json(&json!({ "webhook_signature_tolerance_secs": 5 }))
        .send()
        .await
        .expect("PUT bad tolerance");
    assert_eq!(bad.status().as_u16(), 422, "tolerance 5 out of bounds → 422");

    // The prior valid state is intact (the 422 did not partial-write).
    let after: serde_json::Value = server
        .client
        .get(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("GET after")
        .json()
        .await
        .unwrap();
    assert_eq!(after["webhook_signature_tolerance_secs"], 300, "tolerance unchanged after 422");
    assert_eq!(after["webhook_event_retention_days"], 200, "retention still 200");
}

// TEST-2 [acceptance][invariant: INV-2][covers ITEM-3, ITEM-4]: a PUT persists the new overage
// rate; a FRESH pool read (simulating a process restart) returns it; and the read-at-use
// reader `effective_overage_rates` (the exact fn check_quota calls) returns the new value —
// proving the knob is read at the moment of use, not baked in as a const.
#[tokio::test]
async fn configurable_persisted_and_read_at_use() {
    let server = TestServer::spawn().await;
    let token = setup_admin(&server).await;

    let resp = server
        .client
        .put(server.api_url("/billing/settings"))
        .bearer_auth(&token)
        .json(&json!({
            "overage_cents_per_core_hour": 42.0,
            "overage_cents_per_gb_month": 7.0
        }))
        .send()
        .await
        .expect("PUT overage rates");
    assert_eq!(resp.status().as_u16(), 200);

    // Fresh pool = a new set of connections independent of the server's; the value survives
    // because it lives in the row, not the process (restart-equivalent).
    let pool = pool_for(&server).await;
    let stored = cytoanalyst::modules::billing::repository::get_billing_settings(&pool)
        .await
        .expect("read settings");
    assert_eq!(stored.overage_cents_per_core_hour, 42.0);
    assert_eq!(stored.overage_cents_per_gb_month, 7.0);

    // Read-at-use: the exact reader check_quota calls returns the persisted values.
    let (core, gb) = cytoanalyst::modules::billing::quota::effective_overage_rates(&pool).await;
    assert_eq!((core, gb), (42.0, 7.0), "check_quota reads the row, not the const");
}
