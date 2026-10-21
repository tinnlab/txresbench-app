//! B4 — the `check_quota` decision + the quota read/spend-cap API acceptance tests
//! (PROV-B4-1 / PROV-B4-2).
//!
//! `check_quota` is a pure READER over B1's `usage_rollup` + B2's code-defined catalog + B4's
//! `account_spend_cap`, so — like B1's fold tests — these call it DIRECTLY against the per-test
//! DB with FAKE `usage_rollup` rows (seeded via a helper) standing in for B1's fold. The
//! read/put API tests go through the real HTTP surface. NO Stripe, NO network.

use cytoanalyst::modules::billing::quota::{check_quota, QuotaAsk, QuotaVerdict};

use crate::account::{create_user, create_user_without_projects, login, pool_for, setup_admin};
use crate::billing::helpers::{
    personal_account_id, quota_get, quota_get_unauth, seed_rollup_usage, set_account_plan,
    set_account_status, set_spend_cap_row, spend_cap_put,
};

// The free plan's compute allowance is 3600 compute-seconds ÷ 3600 = 1.0 core-hour; the pro
// plan's is 360_000 ÷ 3600 = 100 core-hours (catalog `catalog.rs`).
const FREE_COMPUTE_ALLOWANCE: f64 = 1.0;
const PRO_COMPUTE_ALLOWANCE: f64 = 100.0;
// Free storage allowance = 5 GB-months; pro = 100.
const FREE_STORAGE_ALLOWANCE_GBM: f64 = 5.0;

fn now_period_bytes(gb_months: f64) -> i64 {
    // helper only; storage seeding is by gb-months directly (see seed_rollup_usage).
    (gb_months * 1_000_000_000.0) as i64
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-1 [acceptance][INV-1] — a FREE account AT its allowance hard-blocks; under
// allowance allows (the negative control). Both compute + storage.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn free_tier_at_allowance_hard_blocks() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b4_free_u", "b4_free_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    // Personal accounts default to plan 'free'; assert by seeding usage AT the allowance.
    seed_rollup_usage(&pool, account, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;

    // A free account AT its compute allowance → BlockOverQuota for any positive ask.
    let v = check_quota(
        &pool,
        account,
        QuotaAsk::Compute {
            resource_class: "cpu".into(),
            est_core_hours: 0.001,
        },
    )
    .await
    .expect("check_quota");
    assert!(
        matches!(v, QuotaVerdict::BlockOverQuota { .. }),
        "free at allowance → hard-block, got {v:?}"
    );

    // NEGATIVE CONTROL: a free account UNDER allowance → Allow.
    seed_rollup_usage(&pool, account, 0.2, 0.0, 0.0).await;
    let v2 = check_quota(
        &pool,
        account,
        QuotaAsk::Compute {
            resource_class: "cpu".into(),
            est_core_hours: 0.1,
        },
    )
    .await
    .expect("check_quota under");
    assert_eq!(v2, QuotaVerdict::Allow, "free under allowance → allow");

    // The storage twin: AT the free storage allowance (GB-months) → block for an add.
    seed_rollup_usage(&pool, account, 0.0, 0.0, FREE_STORAGE_ALLOWANCE_GBM).await;
    let sv = check_quota(
        &pool,
        account,
        QuotaAsk::Storage {
            add_bytes: now_period_bytes(0.1),
        },
    )
    .await
    .expect("check_quota storage");
    assert!(
        matches!(sv, QuotaVerdict::BlockOverQuota { .. }),
        "free at storage allowance → hard-block, got {sv:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-2 [acceptance][INV-2] — a PAID account OVER allowance with NO cap → meter overage.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn paid_over_allowance_no_cap_meters_overage() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b4_pro_u", "b4_pro_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    set_account_plan(&pool, account, "pro").await;
    // PAST the pro allowance (100 core-hours), no spend cap.
    seed_rollup_usage(&pool, account, PRO_COMPUTE_ALLOWANCE, 0.0, 0.0).await;

    let v = check_quota(
        &pool,
        account,
        QuotaAsk::Compute {
            resource_class: "cpu".into(),
            est_core_hours: 5.0,
        },
    )
    .await
    .expect("check_quota");
    assert_eq!(
        v,
        QuotaVerdict::AllowMeteredOverage,
        "paid over allowance, no cap → meter overage (not block)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-3 [acceptance][INV-2] — a PAID account whose projected overage cost exceeds the
// spend cap → Deny; one cent of headroom → allow (boundary control).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn paid_at_spend_cap_blocks() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b4_cap_u", "b4_cap_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    set_account_plan(&pool, account, "pro").await;
    seed_rollup_usage(&pool, account, PRO_COMPUTE_ALLOWANCE, 0.0, 0.0).await;

    // ask = 5 core-hours over × 10 cents/core-hour = 50 cents projected overage cost.
    let ask = || QuotaAsk::Compute {
        resource_class: "cpu".into(),
        est_core_hours: 5.0,
    };

    // Cap BELOW 50 → block (the bill-shock wall).
    set_spend_cap_row(&pool, account, Some(49)).await;
    let blocked = check_quota(&pool, account, ask()).await.expect("cq");
    assert!(
        matches!(blocked, QuotaVerdict::BlockOverQuota { .. }),
        "projected overage cost 50c > cap 49c → block, got {blocked:?}"
    );

    // Cap ABOVE 50 (boundary: one cent of headroom) → meter overage.
    set_spend_cap_row(&pool, account, Some(51)).await;
    let allowed = check_quota(&pool, account, ask()).await.expect("cq2");
    assert_eq!(
        allowed,
        QuotaVerdict::AllowMeteredOverage,
        "cap above the projected cost → meter overage"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-6a [acceptance][INV-4] — check_quota is keyed on account_id: account A's verdict
// reads A's usage only; a SUSPENDED account (B3's terminal state) blocks regardless.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn suspended_account_blocks_and_is_account_keyed() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid_a = create_user(&server, &admin, "b4_sa_a", "b4_sa_a@cyto.test").await;
    let uid_b = create_user(&server, &admin, "b4_sa_b", "b4_sa_b@cyto.test").await;
    let pool = pool_for(&server).await;
    let account_a = personal_account_id(&pool, uid_a).await;
    let account_b = personal_account_id(&pool, uid_b).await;

    // A is well UNDER allowance but SUSPENDED (canceled) → block outright.
    seed_rollup_usage(&pool, account_a, 0.0, 0.0, 0.0).await;
    set_account_status(&pool, account_a, "canceled").await;
    let va = check_quota(
        &pool,
        account_a,
        QuotaAsk::Compute {
            resource_class: "cpu".into(),
            est_core_hours: 0.01,
        },
    )
    .await
    .expect("cq a");
    assert!(
        matches!(va, QuotaVerdict::BlockOverQuota { .. }),
        "suspended account blocks regardless of usage, got {va:?}"
    );

    // B (active, no usage) is NOT affected by A's state → Allow (account-keyed).
    let vb = check_quota(
        &pool,
        account_b,
        QuotaAsk::Compute {
            resource_class: "cpu".into(),
            est_core_hours: 0.01,
        },
    )
    .await
    .expect("cq b");
    assert_eq!(vb, QuotaVerdict::Allow, "B is unaffected by A's suspension");
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-10 [acceptance][INV-2 reader-only] — check_quota writes NOTHING: usage_rollup +
// account_spend_cap are byte-identical after N checks (quota is a pure reader, BQ-INV-2).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn check_quota_is_side_effect_free() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b4_ro_u", "b4_ro_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    set_account_plan(&pool, account, "pro").await;
    seed_rollup_usage(&pool, account, 120.0, 0.0, 0.0).await;
    set_spend_cap_row(&pool, account, Some(1000)).await;

    let snapshot = |pool: sqlx::PgPool, account| async move {
        let rollup: (f64, f64, f64) = sqlx::query_as(
            "SELECT compute_core_hours, gpu_hours, storage_gb_months FROM usage_rollup WHERE account_id=$1",
        )
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap();
        let cap: Option<i64> = sqlx::query_scalar(
            "SELECT overage_cap_cents FROM account_spend_cap WHERE account_id=$1",
        )
        .bind(account)
        .fetch_one(&pool)
        .await
        .unwrap();
        let alert_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM usage_alert_state WHERE account_id=$1")
                .bind(account)
                .fetch_one(&pool)
                .await
                .unwrap();
        (rollup, cap, alert_rows)
    };

    let before = snapshot(pool.clone(), account).await;
    for _ in 0..5 {
        let _ = check_quota(
            &pool,
            account,
            QuotaAsk::Compute {
                resource_class: "cpu".into(),
                est_core_hours: 5.0,
            },
        )
        .await
        .expect("cq");
    }
    let after = snapshot(pool.clone(), account).await;
    assert_eq!(before, after, "check_quota mutated nothing (pure reader)");
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-6b [acceptance][INV-4] — the quota READ API is account-scoped + gated: 401 unauth,
// 403 without billing::read, cross-account 404, A sees only A's state; the spend-cap PUT
// needs billing::manage and round-trips the cap into the read.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn quota_api_is_account_scoped_and_gated() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid_a = create_user(&server, &admin, "b4_api_a", "b4_api_a@cyto.test").await;
    let uid_b = create_user(&server, &admin, "b4_api_b", "b4_api_b@cyto.test").await;
    let token_a = login(&server, "b4_api_a").await;
    let pool = pool_for(&server).await;
    let account_a = personal_account_id(&pool, uid_a).await;
    let account_b = personal_account_id(&pool, uid_b).await;
    set_account_plan(&pool, account_a, "pro").await;
    seed_rollup_usage(&pool, account_a, 42.0, 0.0, 0.0).await;

    // 401 — no bearer.
    assert_eq!(
        quota_get_unauth(&server).await.status().as_u16(),
        401,
        "unauth → 401"
    );

    // 403 — a user without billing::read.
    let _np =
        create_user_without_projects(&server, &admin, "b4_api_np", "b4_api_np@cyto.test").await;
    let token_np = login(&server, "b4_api_np").await;
    assert_eq!(
        quota_get(&server, &token_np, None).await.status().as_u16(),
        403,
        "missing billing::read → 403"
    );

    // A reads its own quota → 200 with A's plan + usage.
    let resp = quota_get(&server, &token_a, None).await;
    assert_eq!(resp.status().as_u16(), 200);
    let body: serde_json::Value = resp.json().await.expect("quota json");
    assert_eq!(body["plan_id"].as_str(), Some("pro"));
    assert!((body["compute_used"].as_f64().unwrap() - 42.0).abs() < 1e-9);
    assert!((body["compute_allowance"].as_f64().unwrap() - 100.0).abs() < 1e-9);
    assert!(body["spend_cap_cents"].is_null(), "no cap set yet");

    // Cross-account: A requests B's account → 404 (existence-oracle guard).
    let cross = quota_get(&server, &token_a, Some(account_b)).await;
    assert_eq!(cross.status().as_u16(), 404, "cross-account → 404");

    // PUT spend-cap needs billing::manage: the no-perm user is 403.
    assert_eq!(
        spend_cap_put(&server, &token_np, None, Some(500))
            .await
            .status()
            .as_u16(),
        403,
        "PUT spend-cap without billing::manage → 403"
    );
    // A negative cap → 400.
    assert_eq!(
        spend_cap_put(&server, &token_a, None, Some(-1))
            .await
            .status()
            .as_u16(),
        400,
        "negative cap → 400"
    );
    // A sets a cap → 200, and the read reflects it.
    let set = spend_cap_put(&server, &token_a, None, Some(750)).await;
    assert_eq!(set.status().as_u16(), 200);
    let after: serde_json::Value = quota_get(&server, &token_a, None)
        .await
        .json()
        .await
        .expect("quota json 2");
    assert_eq!(
        after["spend_cap_cents"].as_i64(),
        Some(750),
        "cap round-trips"
    );
    // Clearing (null) removes it.
    spend_cap_put(&server, &token_a, None, None).await;
    let cleared: serde_json::Value = quota_get(&server, &token_a, None)
        .await
        .json()
        .await
        .expect("quota json 3");
    assert!(cleared["spend_cap_cents"].is_null(), "null clears the cap");
}
