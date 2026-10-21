//! #37 — the admin-suspend QUOTA EFFECT (the saas-only half). `check_quota` is the saas-only
//! quota gate; a suspend must Block it, and must do so with PRECEDENCE over a credit grant / a
//! premium comp (an operator hold is not defeatable by the account's own budget). Mirrors
//! `credits_test`: `check_quota` is called DIRECTLY against the per-test DB; the admin
//! suspend/reactivate + credit/premium HTTP surfaces are driven through the real spawned server.
//! NO Stripe, NO network. Runs inside the saas tier.

use cytoanalyst::modules::billing::quota::{check_quota, QuotaAsk, QuotaVerdict};

use crate::account::{create_user, pool_for, setup_admin};
use crate::billing::helpers::{
    grant_credit, personal_account_id, put_premium, reactivate_account, seed_rollup_usage, suspend_account,
};

const FREE_COMPUTE_ALLOWANCE: f64 = 1.0;

fn compute_ask(n: f64) -> QuotaAsk {
    QuotaAsk::Compute { resource_class: "cpu".into(), est_core_hours: n }
}
fn storage_ask(bytes: i64) -> QuotaAsk {
    QuotaAsk::Storage { add_bytes: bytes }
}

// TEST-5 [acceptance][invariant: INV-1] — an admin suspend Blocks check_quota for BOTH a compute
// and a storage ask (even well UNDER allowance); reactivate unblocks. The suspend/reactivate
// routes (admin module) drive the flag; check_quota (saas) enforces it.
#[tokio::test]
async fn admin_suspend_blocks_check_quota_then_reactivate_unblocks() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "asq_u1", "asq_u1@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let acct = account.to_string();

    // Control: a fresh free account, no usage → well under allowance → Allow (both resources).
    assert_eq!(
        check_quota(&pool, account, compute_ask(0.1)).await.expect("cq"),
        QuotaVerdict::Allow,
        "under allowance, not suspended → compute Allow (control)"
    );
    assert_eq!(
        check_quota(&pool, account, storage_ask(1_000)).await.expect("cq"),
        QuotaVerdict::Allow,
        "under allowance, not suspended → storage Allow (control)"
    );

    // Suspend → BOTH resources Block, regardless of the tiny under-allowance ask.
    assert_eq!(suspend_account(&server, Some(&admin), &acct, Some("hold")).await.status().as_u16(), 200);
    assert!(
        matches!(check_quota(&pool, account, compute_ask(0.1)).await.expect("cq"), QuotaVerdict::BlockOverQuota { .. }),
        "suspended → compute Block"
    );
    assert!(
        matches!(check_quota(&pool, account, storage_ask(1_000)).await.expect("cq"), QuotaVerdict::BlockOverQuota { .. }),
        "suspended → storage Block"
    );

    // Reactivate → back to Allow.
    assert_eq!(reactivate_account(&server, Some(&admin), &acct).await.status().as_u16(), 200);
    assert_eq!(
        check_quota(&pool, account, compute_ask(0.1)).await.expect("cq"),
        QuotaVerdict::Allow,
        "reactivated → Allow again"
    );
}

// TEST-6 [acceptance][invariant: INV-2] — an admin suspend is NOT overridden by a credit grant or
// a premium comp: an account that a large credit balance + premium=true WOULD lift past its
// allowance still Blocks once admin-suspended (suspend precedence). The real end-to-end path.
#[tokio::test]
async fn admin_suspend_beats_credits_and_premium_end_to_end() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "asq_u2", "asq_u2@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let acct = account.to_string();

    // A FREE account AT its allowance; a positive ask is over-allowance (would normally hard-block).
    seed_rollup_usage(&pool, account, FREE_COMPUTE_ALLOWANCE, 0.0, 0.0).await;
    let over = || compute_ask(0.5);

    // Grant a large credit balance AND set premium=true — either alone lifts the over-allowance ask.
    assert_eq!(grant_credit(&server, Some(&admin), &acct, 1_000_000, "big comp", None).await.status().as_u16(), 200);
    assert_eq!(put_premium(&server, Some(&admin), &acct, true, Some("vip")).await.status().as_u16(), 200);

    // Control: with credits + premium (and NO suspend) the over-allowance ask is Allowed.
    assert_eq!(
        check_quota(&pool, account, over()).await.expect("cq"),
        QuotaVerdict::Allow,
        "premium/credits lift the over-allowance ask (control — proves the block below is the suspend)"
    );

    // Suspend → STILL Block, despite the credits + premium (suspend checked first, DEC-4).
    assert_eq!(suspend_account(&server, Some(&admin), &acct, None).await.status().as_u16(), 200);
    assert!(
        matches!(check_quota(&pool, account, over()).await.expect("cq"), QuotaVerdict::BlockOverQuota { .. }),
        "an admin-suspend is not overridden by a credit grant or premium"
    );

    // Reactivate → premium/credits take over again → Allow (proves the suspend was the sole cause).
    assert_eq!(reactivate_account(&server, Some(&admin), &acct).await.status().as_u16(), 200);
    assert_eq!(
        check_quota(&pool, account, over()).await.expect("cq"),
        QuotaVerdict::Allow,
        "reactivated → premium/credits allow again"
    );
}
