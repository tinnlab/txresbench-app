//! #39 — admin credit ledger + comp/premium override acceptance tests (the largest net-new
//! billing subsystem: the override layer `check_quota` consults BEFORE the plan-derived verdict).
//!
//! Like `quota_test`, these call the frozen `check_quota` DIRECTLY against the per-test DB with
//! seeded `usage_rollup`/plan rows, and drive the admin grant/revoke/premium HTTP surface through
//! the real spawned server. NO Stripe, NO network — pure DB + engine. Runs inside the saas tier
//! (the billing routes mount only when `STRIPE_SECRET_KEY` is configured, the §16 kill-switch).
//!
//! Pins the seven #39 invariants (`docs/design/admin-credits-override.md`):
//!  - INV-1 a grant CHANGES the verdict (+ the no-grant negative control)      — TEST-1
//!  - INV-2 revoke + expiry are honored (the effect reverts)                   — TEST-2
//!  - INV-3 a premium comp override → not quota-blocked                        — TEST-3
//!  - INV-4 the ledger is append-only + auditable                             — TEST-4
//!  - INV-5 existing quota behavior UNCHANGED with no grant/override           — TEST-5
//!  - INV-6 every credit/premium route is admin-gated (401/403/404)           — TEST-6
//!  - INV-7 exactly-once, pure reader, no underflow                           — TEST-7
//!  - ITEM-1 the `amount_cents > 0` CHECK + the migration is applied          — TEST-11

use cytoanalyst::modules::billing::quota::{check_quota, QuotaAsk, QuotaVerdict};
use cytoanalyst::modules::billing::repository::{account_billing_summaries, credit_balance};
use serde_json::Value;

use crate::account::{
    create_user, create_user_without_projects, login, make_org_account, pool_for, setup_admin,
};
use crate::billing::helpers::{
    admin_billing_get, count_credit_grants, create_billing_admin_holder, get_credits, grant_credit,
    grant_revoke_marker, insert_credit_grant_row, personal_account_id, put_premium, revoke_credit,
    seed_rollup_usage, set_account_plan, set_account_status, set_spend_cap_row,
};

const FREE_COMPUTE_ALLOWANCE: f64 = 1.0;
const PRO_COMPUTE_ALLOWANCE: f64 = 100.0;

/// A compute ask of `n` core-hours (cpu).
fn ask(n: f64) -> QuotaAsk {
    QuotaAsk::Compute {
        resource_class: "cpu".into(),
        est_core_hours: n,
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-1 [acceptance][INV-1] — a grant CHANGES the verdict: a free-tier hard-block and a
// paid-over-cap block each become Allow/AllowMeteredOverage once a sufficient admin grant
// exists; with NO grant the SAME ask still Blocks (the negative control).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn grant_changes_the_verdict_with_no_grant_control() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // --- FREE account AT its allowance. ask 0.5 core-h over × 10¢ = 5¢ projected cost.
    let uid = create_user(&server, &admin, "cr_free", "cr_free@x.test").await;
    let acct = personal_account_id(&pool, uid).await;
    let acct_s = acct.to_string();
    seed_rollup_usage(&pool, acct, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;

    // NEGATIVE CONTROL: no grant → Block.
    let before = check_quota(&pool, acct, ask(0.5)).await.expect("cq");
    assert!(
        matches!(before, QuotaVerdict::BlockOverQuota { .. }),
        "free at allowance, NO grant → Block, got {before:?}"
    );

    // Admin grants 5¢ (exactly covering the projected cost) → the SAME ask now Allows.
    let g = grant_credit(&server, Some(&admin), &acct_s, 5, "partner comp", None).await;
    assert_eq!(g.status().as_u16(), 200, "grant → 200");
    let gb: Value = g.json().await.expect("grant json");
    assert_eq!(gb["balance_cents"].as_i64(), Some(5), "balance reflects grant");

    let after = check_quota(&pool, acct, ask(0.5)).await.expect("cq2");
    assert_eq!(
        after,
        QuotaVerdict::Allow,
        "free at allowance, WITH a covering grant → Allow (the grant changed the verdict)"
    );

    // --- PAID account over a spend cap. ask 5 core-h over × 10¢ = 50¢; cap 40¢ → Block.
    let uid2 = create_user(&server, &admin, "cr_paid", "cr_paid@x.test").await;
    let acct2 = personal_account_id(&pool, uid2).await;
    let acct2_s = acct2.to_string();
    set_account_plan(&pool, acct2, "pro").await;
    seed_rollup_usage(&pool, acct2, PRO_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    set_spend_cap_row(&pool, acct2, Some(40)).await;

    let before2 = check_quota(&pool, acct2, ask(5.0)).await.expect("cq3");
    assert!(
        matches!(before2, QuotaVerdict::BlockOverQuota { .. }),
        "paid over cap, NO grant → Block, got {before2:?}"
    );

    // Grant 20¢ → effective cap 60¢ ≥ 50¢ → meter overage.
    let g2 = grant_credit(&server, Some(&admin), &acct2_s, 20, "overage comp", None).await;
    assert_eq!(g2.status().as_u16(), 200);
    let after2 = check_quota(&pool, acct2, ask(5.0)).await.expect("cq4");
    assert_eq!(
        after2,
        QuotaVerdict::AllowMeteredOverage,
        "paid over cap, WITH a grant raising the effective cap → meter (verdict changed)"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-2 [acceptance][INV-2] — a grant that lifts a Block, once REVOKED, no longer counts
// (verdict reverts); an already-EXPIRED grant never counted.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn revoke_and_expiry_revert_the_effect() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let uid = create_user(&server, &admin, "cr_rev", "cr_rev@x.test").await;
    let acct = personal_account_id(&pool, uid).await;
    let acct_s = acct.to_string();
    seed_rollup_usage(&pool, acct, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;

    // Grant 5¢ → Allow.
    let g = grant_credit(&server, Some(&admin), &acct_s, 5, "temp comp", None).await;
    let gb: Value = g.json().await.expect("grant json");
    let grant_id = gb["grants"][0]["id"].as_str().expect("grant id").to_string();
    assert_eq!(check_quota(&pool, acct, ask(0.5)).await.unwrap(), QuotaVerdict::Allow);

    // REVOKE → the effect reverts to Block.
    let r = revoke_credit(&server, Some(&admin), &acct_s, &grant_id).await;
    assert_eq!(r.status().as_u16(), 200, "revoke → 200");
    let rb: Value = r.json().await.expect("revoke json");
    assert_eq!(rb["balance_cents"].as_i64(), Some(0), "balance back to 0 after revoke");
    let reverted = check_quota(&pool, acct, ask(0.5)).await.expect("cq");
    assert!(
        matches!(reverted, QuotaVerdict::BlockOverQuota { .. }),
        "revoked grant no longer counts → Block again, got {reverted:?}"
    );

    // An already-EXPIRED grant (expires_at in the past) never counts.
    let past = chrono::Utc::now() - chrono::Duration::days(1);
    insert_credit_grant_row(&pool, acct, 500, "expired comp", uid, Some(past)).await;
    let expired = check_quota(&pool, acct, ask(0.5)).await.expect("cq");
    assert!(
        matches!(expired, QuotaVerdict::BlockOverQuota { .. }),
        "an expired grant does not count → still Block, got {expired:?}"
    );
    // The GET balance excludes it too.
    let bal: Value = get_credits(&server, Some(&admin), &acct_s)
        .await
        .json()
        .await
        .expect("balance json");
    assert_eq!(
        bal["balance_cents"].as_i64(),
        Some(0),
        "expired + revoked excluded from the balance"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-3 [acceptance][INV-3] — a premium comp override → not quota-blocked, independent of plan.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn premium_override_lifts_the_block() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let uid = create_user(&server, &admin, "cr_prem", "cr_prem@x.test").await;
    let acct = personal_account_id(&pool, uid).await;
    let acct_s = acct.to_string();
    // Free account WAY over allowance (no credits) → normally a hard block.
    seed_rollup_usage(&pool, acct, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    assert!(matches!(
        check_quota(&pool, acct, ask(50.0)).await.unwrap(),
        QuotaVerdict::BlockOverQuota { .. }
    ));

    // Set premium → Allow, independent of plan_id (still 'free').
    let p = put_premium(&server, Some(&admin), &acct_s, true, Some("vip partner")).await;
    assert_eq!(p.status().as_u16(), 200, "put premium → 200");
    let pb: Value = p.json().await.expect("premium json");
    assert_eq!(pb["premium"].as_bool(), Some(true));
    assert_eq!(
        check_quota(&pool, acct, ask(50.0)).await.unwrap(),
        QuotaVerdict::Allow,
        "premium comps the over-allowance ask → Allow"
    );

    // Clear premium → reverts to Block.
    put_premium(&server, Some(&admin), &acct_s, false, None).await;
    assert!(
        matches!(
            check_quota(&pool, acct, ask(50.0)).await.unwrap(),
            QuotaVerdict::BlockOverQuota { .. }
        ),
        "clearing premium reverts to the plan-derived Block"
    );

    // Premium does NOT bypass suspension (DEC-4).
    put_premium(&server, Some(&admin), &acct_s, true, None).await;
    set_account_status(&pool, acct, "canceled").await;
    assert!(
        matches!(
            check_quota(&pool, acct, ask(0.01)).await.unwrap(),
            QuotaVerdict::BlockOverQuota { .. }
        ),
        "a suspended account still Blocks even with premium set"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-4 [acceptance][INV-4] — the ledger is append-only + auditable: grant records
// granted_by/reason/created_at; revoke stamps revoked_at/revoked_by and NEVER deletes the row.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn ledger_is_append_only_and_auditable() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let uid = create_user(&server, &admin, "cr_led", "cr_led@x.test").await;
    let acct = personal_account_id(&pool, uid).await;
    let acct_s = acct.to_string();

    // Two grants → ledger has 2 rows, balance = 300.
    grant_credit(&server, Some(&admin), &acct_s, 100, "first comp", None).await;
    let g2 = grant_credit(&server, Some(&admin), &acct_s, 200, "second comp", None).await;
    let g2b: Value = g2.json().await.expect("grant json");
    assert_eq!(g2b["balance_cents"].as_i64(), Some(300), "balance = 100 + 200");

    let ledger: Value = get_credits(&server, Some(&admin), &acct_s)
        .await
        .json()
        .await
        .expect("ledger json");
    assert_eq!(ledger["grants"].as_array().unwrap().len(), 2, "two ledger rows");
    // Audit columns present (newest first).
    let newest = &ledger["grants"][0];
    assert_eq!(newest["amount_cents"].as_i64(), Some(200));
    assert_eq!(newest["reason"].as_str(), Some("second comp"));
    assert!(newest["granted_by"].as_str().is_some(), "granted_by recorded");
    assert!(newest["created_at"].as_str().is_some(), "created_at recorded");
    assert_eq!(newest["active"].as_bool(), Some(true));

    // Revoke the newest grant → the ROW STILL EXISTS, marked revoked; balance drops to 100.
    let grant_id = newest["id"].as_str().unwrap().to_string();
    let r = revoke_credit(&server, Some(&admin), &acct_s, &grant_id).await;
    let rb: Value = r.json().await.expect("revoke json");
    assert_eq!(rb["balance_cents"].as_i64(), Some(100), "revoked amount removed from balance");

    assert_eq!(count_credit_grants(&pool, acct).await, 2, "revoke did NOT delete the row (append-only)");
    let (revoked_at, revoked_by) = grant_revoke_marker(&pool, grant_id.parse().unwrap()).await;
    assert!(revoked_at.is_some(), "revoked_at stamped");
    assert!(revoked_by.is_some(), "revoked_by stamped (auditable)");

    // The ledger read still shows the revoked row, now inactive.
    let after: Value = get_credits(&server, Some(&admin), &acct_s)
        .await
        .json()
        .await
        .expect("ledger json 2");
    assert_eq!(after["grants"].as_array().unwrap().len(), 2, "revoked row still in the ledger");
    let revoked_row = after["grants"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"].as_str() == Some(grant_id.as_str()))
        .expect("revoked row present");
    assert_eq!(revoked_row["active"].as_bool(), Some(false), "revoked row is inactive");
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-5 [acceptance][INV-5] — existing quota behavior UNCHANGED with no grant/override: the
// free-hard-block / paid-meter / paid-over-cap-block / suspended-block §4.2 verdicts still hold.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn no_grant_no_override_preserves_existing_verdicts() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // free at allowance → Block; free under → Allow.
    let f = create_user(&server, &admin, "cr_reg_f", "cr_reg_f@x.test").await;
    let fa = personal_account_id(&pool, f).await;
    seed_rollup_usage(&pool, fa, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    assert!(matches!(
        check_quota(&pool, fa, ask(0.1)).await.unwrap(),
        QuotaVerdict::BlockOverQuota { .. }
    ), "free hard-block preserved");
    seed_rollup_usage(&pool, fa, 0.2, 0.0, 0.0).await;
    assert_eq!(check_quota(&pool, fa, ask(0.1)).await.unwrap(), QuotaVerdict::Allow, "free under → Allow");

    // paid over, no cap → meter.
    let p = create_user(&server, &admin, "cr_reg_p", "cr_reg_p@x.test").await;
    let pa = personal_account_id(&pool, p).await;
    set_account_plan(&pool, pa, "pro").await;
    seed_rollup_usage(&pool, pa, PRO_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    assert_eq!(
        check_quota(&pool, pa, ask(5.0)).await.unwrap(),
        QuotaVerdict::AllowMeteredOverage,
        "paid meter preserved"
    );
    // paid over cap → block.
    set_spend_cap_row(&pool, pa, Some(49)).await;
    assert!(matches!(
        check_quota(&pool, pa, ask(5.0)).await.unwrap(),
        QuotaVerdict::BlockOverQuota { .. }
    ), "paid over-cap block preserved");

    // suspended → block regardless.
    let s = create_user(&server, &admin, "cr_reg_s", "cr_reg_s@x.test").await;
    let sa = personal_account_id(&pool, s).await;
    set_account_status(&pool, sa, "canceled").await;
    assert!(matches!(
        check_quota(&pool, sa, ask(0.01)).await.unwrap(),
        QuotaVerdict::BlockOverQuota { .. }
    ), "suspended block preserved");
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-6 [acceptance][INV-6] — every credit/premium route is admin-gated: 401 unauth, 403 for a
// plain user AND a self-serve billing::manage holder, 404 for an admin on a nonexistent account;
// a root admin AND a billing::admin grant-holder both succeed.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn credit_routes_are_admin_gated() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let alice = create_user(&server, &admin, "cr_g_alice", "cr_g_alice@x.test").await;
    let org = make_org_account(&pool, "Credit Lab", alice).await;
    let org_s = org.to_string();
    let ghost = uuid::Uuid::new_v4().to_string();

    // a plain user (self-serve billing::read/manage on their OWN account, NOT billing::admin).
    let _c = create_user(&server, &admin, "cr_g_carol", "cr_g_carol@x.test").await;
    let carol = login(&server, "cr_g_carol").await;
    // a user with NO billing perms at all.
    let _np = create_user_without_projects(&server, &admin, "cr_g_np", "cr_g_np@x.test").await;
    let np = login(&server, "cr_g_np").await;

    // GET credits: 401 / 403 (carol) / 403 (np) / 404 (admin on ghost).
    assert_eq!(get_credits(&server, None, &org_s).await.status().as_u16(), 401, "GET unauth → 401");
    assert_eq!(get_credits(&server, Some(&carol), &org_s).await.status().as_u16(), 403, "GET manage-holder → 403");
    assert_eq!(get_credits(&server, Some(&np), &org_s).await.status().as_u16(), 403, "GET no-perm → 403");
    assert_eq!(get_credits(&server, Some(&admin), &ghost).await.status().as_u16(), 404, "GET admin/ghost → 404");

    // POST grant: same gate.
    assert_eq!(grant_credit(&server, None, &org_s, 100, "x", None).await.status().as_u16(), 401);
    assert_eq!(grant_credit(&server, Some(&carol), &org_s, 100, "x", None).await.status().as_u16(), 403);
    assert_eq!(grant_credit(&server, Some(&admin), &ghost, 100, "x", None).await.status().as_u16(), 404);

    // PUT premium: same gate.
    assert_eq!(put_premium(&server, None, &org_s, true, None).await.status().as_u16(), 401);
    assert_eq!(put_premium(&server, Some(&carol), &org_s, true, None).await.status().as_u16(), 403);
    assert_eq!(put_premium(&server, Some(&admin), &ghost, true, None).await.status().as_u16(), 404);

    // DELETE revoke: 401 / 403 / 404.
    let gid = uuid::Uuid::new_v4().to_string();
    assert_eq!(revoke_credit(&server, None, &org_s, &gid).await.status().as_u16(), 401);
    assert_eq!(revoke_credit(&server, Some(&carol), &org_s, &gid).await.status().as_u16(), 403);
    assert_eq!(revoke_credit(&server, Some(&admin), &ghost, &gid).await.status().as_u16(), 404);

    // A ROOT ADMIN and a billing::admin GRANT-HOLDER both succeed on a real account.
    let holder = create_billing_admin_holder(&server, &admin, "cr_g_bob", "cr_g_bob@x.test").await;
    for token in [admin.as_str(), holder.as_str()] {
        assert_eq!(
            grant_credit(&server, Some(token), &org_s, 100, "ok", None).await.status().as_u16(),
            200,
            "authorized admin grant → 200"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-7 [acceptance][INV-7] — exactly-once, pure reader, no underflow: check_quota writes
// NOTHING to credit_grants/account_quota_override; two distinct grants sum exactly once.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn engine_is_a_pure_reader_and_grants_sum_exactly_once() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let uid = create_user(&server, &admin, "cr_ex", "cr_ex@x.test").await;
    let acct = personal_account_id(&pool, uid).await;
    let acct_s = acct.to_string();
    set_account_plan(&pool, acct, "pro").await;
    seed_rollup_usage(&pool, acct, PRO_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    set_spend_cap_row(&pool, acct, Some(10)).await;

    // Two DISTINCT grants → the balance is their exact SUM (no double-count).
    grant_credit(&server, Some(&admin), &acct_s, 100, "a", None).await;
    let g2: Value = grant_credit(&server, Some(&admin), &acct_s, 200, "b", None)
        .await
        .json()
        .await
        .expect("grant json");
    assert_eq!(g2["balance_cents"].as_i64(), Some(300), "two grants sum exactly once");
    assert_eq!(count_credit_grants(&pool, acct).await, 2, "two distinct ledger rows");

    // Snapshot the override tables, run N checks, assert byte-identical (pure reader).
    let snapshot = |pool: sqlx::PgPool, account| async move {
        let grants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM credit_grants WHERE account_id=$1")
            .bind(account).fetch_one(&pool).await.unwrap();
        let bal: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(amount_cents),0)::bigint FROM credit_grants WHERE account_id=$1 AND revoked_at IS NULL",
        ).bind(account).fetch_one(&pool).await.unwrap();
        let overrides: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM account_quota_override WHERE account_id=$1")
            .bind(account).fetch_one(&pool).await.unwrap();
        (grants, bal, overrides)
    };
    let before = snapshot(pool.clone(), acct).await;
    for _ in 0..5 {
        let _ = check_quota(&pool, acct, ask(5.0)).await.expect("cq");
    }
    let after = snapshot(pool.clone(), acct).await;
    assert_eq!(before, after, "check_quota mutated NEITHER credit table (pure reader)");
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-11 [ITEM-1] — the `amount_cents > 0` CHECK holds (a zero/negative grant is refused at the
// DB) and the HTTP validate refuses it with a 400 — the migration is applied + enforcing.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn amount_check_and_migration_enforced() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let uid = create_user(&server, &admin, "cr_chk", "cr_chk@x.test").await;
    let acct = personal_account_id(&pool, uid).await;
    let acct_s = acct.to_string();

    // HTTP validate: a zero / negative amount → 400; an empty reason → 400.
    assert_eq!(grant_credit(&server, Some(&admin), &acct_s, 0, "x", None).await.status().as_u16(), 400, "zero amount → 400");
    assert_eq!(grant_credit(&server, Some(&admin), &acct_s, -5, "x", None).await.status().as_u16(), 400, "negative amount → 400");
    assert_eq!(grant_credit(&server, Some(&admin), &acct_s, 10, "   ", None).await.status().as_u16(), 400, "empty reason → 400");

    // The DB CHECK also refuses a non-positive amount inserted directly (the migration is applied).
    let direct = sqlx::query("INSERT INTO credit_grants (account_id, amount_cents, reason, granted_by) VALUES ($1, 0, 'x', $2)")
        .bind(acct)
        .bind(uid)
        .execute(&pool)
        .await;
    assert!(direct.is_err(), "the amount_cents > 0 CHECK refuses a zero grant at the DB");

    // A valid grant still lands (no false positive).
    assert_eq!(grant_credit(&server, Some(&admin), &acct_s, 100, "ok", None).await.status().as_u16(), 200);
    assert_eq!(count_credit_grants(&pool, acct).await, 1, "exactly the one valid grant persisted");
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-3 (billing-read-surface) [acceptance][invariant: INV-2] — the credit_balance_cents
// read projection counts ONLY active grants (revoked + expired excluded), equals the engine's
// credit_balance(), equals the batched account_billing_summaries value, and the GET .../billing
// projection agrees; 0 with no grant (negative control).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn credit_balance_projection_excludes_revoked_and_expired() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    let uid = create_user(&server, &admin, "crb_u", "crb_u@x.test").await;
    let acct = personal_account_id(&pool, uid).await;

    // Negative control: no grant → 0 for both the engine reader and the batched summary.
    assert_eq!(credit_balance(&pool, acct).await.unwrap(), 0, "no grant → 0");
    assert_eq!(
        account_billing_summaries(&pool, &[acct])
            .await
            .unwrap()
            .get(&acct)
            .unwrap()
            .credit_balance_cents,
        0,
        "no grant → batched summary 0"
    );

    // Active 2500 + expired 9999 (past expiry) + revoked 7777 → only 2500 counts.
    insert_credit_grant_row(&pool, acct, 2500, "active", uid, None).await;
    insert_credit_grant_row(
        &pool,
        acct,
        9999,
        "expired",
        uid,
        Some(chrono::Utc::now() - chrono::Duration::days(1)),
    )
    .await;
    let revoked_id = insert_credit_grant_row(&pool, acct, 7777, "revoked", uid, None).await;
    sqlx::query("UPDATE credit_grants SET revoked_at = now(), revoked_by = $2 WHERE id = $1")
        .bind(revoked_id)
        .bind(uid)
        .execute(&pool)
        .await
        .expect("revoke the third grant");

    // The engine reader counts only the active grant.
    assert_eq!(
        credit_balance(&pool, acct).await.unwrap(),
        2500,
        "credit_balance() counts only the active grant (revoked + expired excluded)"
    );
    // The batched summary agrees (identical active-grant predicate — INV-2).
    assert_eq!(
        account_billing_summaries(&pool, &[acct])
            .await
            .unwrap()
            .get(&acct)
            .unwrap()
            .credit_balance_cents,
        2500,
        "account_billing_summaries balance == active sum == credit_balance()"
    );
    // And the admin GET .../billing read projection reports the same value.
    let resp = admin_billing_get(&server, Some(&admin), &acct.to_string(), "billing").await;
    assert_eq!(resp.status().as_u16(), 200, "admin reads /billing → 200");
    let b: Value = resp.json().await.expect("billing json");
    assert_eq!(
        b["credit_balance_cents"].as_i64(),
        Some(2500),
        "the admin billing read reports the same active-grant balance"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-5 (billing-read-surface) [covers: ITEM-4] — account_billing_summaries returns premium,
// plan_id, and active-grant balance per account, with LEFT-JOIN defaults for a bare account
// (no override row, no grant → premium=false, plan=free, balance=0).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn account_billing_summaries_maps_state_and_defaults() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let pool = pool_for(&server).await;

    // Account WITH state: pro plan, premium override, 300¢ active grant.
    let u1 = create_user(&server, &admin, "abs_u1", "abs_u1@x.test").await;
    let a1 = personal_account_id(&pool, u1).await;
    set_account_plan(&pool, a1, "pro").await;
    assert_eq!(
        put_premium(&server, Some(&admin), &a1.to_string(), true, None)
            .await
            .status()
            .as_u16(),
        200,
        "seed premium"
    );
    insert_credit_grant_row(&pool, a1, 300, "comp", u1, None).await;

    // BARE account: no override row, no grant, default plan.
    let u2 = create_user(&server, &admin, "abs_u2", "abs_u2@x.test").await;
    let a2 = personal_account_id(&pool, u2).await;

    let m = account_billing_summaries(&pool, &[a1, a2]).await.unwrap();

    let s1 = m.get(&a1).expect("a1 present in summary map");
    assert!(s1.premium, "a1 premium override reported");
    assert_eq!(s1.plan_id, "pro", "a1 plan reported");
    assert_eq!(s1.credit_balance_cents, 300, "a1 active balance reported");

    let s2 = m.get(&a2).expect("a2 present in summary map");
    assert!(!s2.premium, "a2 defaults premium=false (no override row)");
    assert_eq!(s2.plan_id, "free", "a2 default plan");
    assert_eq!(s2.credit_balance_cents, 0, "a2 default balance 0");
}
