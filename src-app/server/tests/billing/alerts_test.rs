//! B4 — the usage-alert ladder acceptance tests (ITEM-4, PROV-B4-2).
//!
//! The ladder LOGIC (fire-once per rung per period, dedup, new-period reset) is a property
//! of `AlertSweeper::sweep` + `advance_alert_level`, provable with FAKE `usage_rollup` rows
//! and NO Stripe/network — so TEST-5 drives `sweep` DIRECTLY (mirrors B1 driving
//! `fold_account`). TEST-7's live sync signal goes through the real subprocess alert loop.

use std::time::Duration;

use chrono::{TimeZone, Utc};

use cytoanalyst::modules::billing::alerts::AlertSweeper;
use cytoanalyst::modules::billing::repository::advance_alert_level;

use crate::account::{create_user, login, pool_for, setup_admin};
use crate::billing::helpers::{alert_level_of, personal_account_id, seed_rollup_usage};

// Free compute allowance = 1.0 core-hour, so pct == core-hours × 100.
fn compute_for_pct(pct: f64) -> f64 {
    pct / 100.0
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-5 [acceptance] — the alert ladder: drive usage 40→55→85→97→100 %; assert an alert
// is emitted EXACTLY ONCE as each of {50, 80, 95, 100}% is first crossed (the 80% case the
// brief names), each stamped in usage_alert_state; a re-run at the same usage emits NOTHING.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn alert_ladder_fires_each_rung_once() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b4_alert_u", "b4_alert_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;
    let sweeper = AlertSweeper::new(pool.clone());

    // 40% → below the first rung: NO emit.
    seed_rollup_usage(&pool, account, compute_for_pct(40.0), 0.0, 0.0).await;
    assert!(
        sweeper.sweep().await.is_empty(),
        "40% is below rung 50 → no alert"
    );

    // Each step crosses exactly one new rung → exactly one emit for that rung.
    for (pct, rung) in [(55.0, 50i16), (85.0, 80), (97.0, 95), (100.0, 100)] {
        seed_rollup_usage(&pool, account, compute_for_pct(pct), 0.0, 0.0).await;
        let emitted = sweeper.sweep().await;
        let compute_emits: Vec<_> = emitted
            .iter()
            .filter(|e| e.resource == "compute" && e.account_id == account)
            .collect();
        assert_eq!(
            compute_emits.len(),
            1,
            "crossing {pct}% emits exactly one compute alert, got {emitted:?}"
        );
        assert_eq!(compute_emits[0].level, rung, "the crossed rung is {rung}");
        // The rung is stamped in usage_alert_state.
        assert_eq!(
            alert_level_of(&pool, account, "compute").await,
            rung,
            "usage_alert_state records rung {rung}"
        );
        // DEDUP: an immediate re-run at the SAME usage emits nothing.
        assert!(
            sweeper.sweep().await.is_empty(),
            "re-run at {pct}% emits nothing (fire-once)"
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-5b [acceptance] — a NEW period resets the ladder: the same account at the same %
// in a different period_start fires rung 50 again (the dedup key includes period_start).
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn new_period_resets_the_ladder() {
    let server = crate::common::TestServer::spawn().await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b4_reset_u", "b4_reset_u@cyto.test").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;

    let june = Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap();
    let july = Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap();

    // June: advance to rung 50 (first time → Some); a re-advance to 50 → None (already fired).
    assert_eq!(
        advance_alert_level(&pool, account, june, "compute", 50)
            .await
            .unwrap(),
        Some(50),
        "first cross of rung 50 in June advances"
    );
    assert_eq!(
        advance_alert_level(&pool, account, june, "compute", 50)
            .await
            .unwrap(),
        None,
        "re-crossing 50 in June is a no-op (fire-once)"
    );
    // July (a NEW period_start key) starts at level 0 → rung 50 fires again.
    assert_eq!(
        advance_alert_level(&pool, account, july, "compute", 50)
            .await
            .unwrap(),
        Some(50),
        "a new period resets the ladder"
    );
}

// ─────────────────────────────────────────────────────────────────────────────────
// TEST-7 [acceptance][PROV-B4-2 sync] — a crossed ladder rung emits a `sync:account_usage`
// signal to the account owner, driven END-TO-END through the subprocess alert loop (the
// debug-only fast tick), where the sync registry lives.
// ─────────────────────────────────────────────────────────────────────────────────
#[tokio::test]
async fn crossed_rung_emits_account_usage_sync() {
    let opts = crate::common::TestOptions {
        billing_alert_tick_ms: Some(250),
        ..Default::default()
    };
    let server = crate::common::TestServer::spawn_with(opts).await;
    let admin = setup_admin(&server).await;
    let uid = create_user(&server, &admin, "b4_sync_u", "b4_sync_u@cyto.test").await;
    let token = login(&server, "b4_sync_u").await;
    let pool = pool_for(&server).await;
    let account = personal_account_id(&pool, uid).await;

    let mut probe = crate::common::sync_probe::SyncProbe::open(&server, &token).await;

    // Seed a CURRENT-period rollup row at 60% of the free compute allowance → the loop
    // crosses rung 50 on its next (≤250 ms) tick and emits AccountUsage/update.
    seed_rollup_usage(&pool, account, compute_for_pct(60.0), 0.0, 0.0).await;

    let f = probe
        .expect_event_for(
            "account_usage",
            "update",
            &account.to_string(),
            Duration::from_secs(15),
        )
        .await;
    assert_eq!(
        f.id,
        account.to_string(),
        "the wire id is the account id (client refetches its quota)"
    );

    // Sanity: the loop actually stamped the rung (the emit corresponds to real state).
    assert_eq!(
        alert_level_of(&pool, account, "compute").await,
        50,
        "the loop crossed rung 50"
    );
}
