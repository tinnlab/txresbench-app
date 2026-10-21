//! The usage-alert ladder (B4 — ITEM-4, part of **PROV-B4-2**).
//!
//! A periodic boot-time + interval step (mirrors B1's `RollupSweeper` / `workstore::gc`'s
//! `GcSweeper::spawn_loop`: `Arc<Self>` + `tokio::spawn` + `loop { work; sleep }`,
//! error-logged-and-continue) that, per account with a current-period `usage_rollup` row
//! (PROV-B1-1), computes `pct = used / allowance` per resource and, when a resource has
//! crossed into a higher band of the ladder **{50, 80, 95, 100}%** (design §4.3, the
//! Dodo/Kinde "warn early + a firm boundary" ladder), emits a `sync:account_usage`
//! notify-and-refetch signal ONCE for the HIGHEST newly-crossed rung — deduped in
//! `usage_alert_state` (the highest rung fired per `(account, period, resource)`;
//! `advance_alert_level`'s monotone upsert makes a re-run over the same usage a no-op, and a
//! new `period_start` key resets the ladder to level 0 implicitly). A usage jump that
//! vaults several rungs at once emits a single alert at the top rung crossed (never spam), so
//! marching usage one band at a time fires each of 50/80/95/100 % exactly once (the common case).
//!
//! Emission REUSES `SyncEntity::AccountUsage` (the account/owner-scoped, `origin:None`,
//! `billing::read`-self-gated signal B1 seeded) rather than adding a new `AccountQuota`
//! variant — mirroring B1/B3's DECISION to keep a new billing entity out of the frontend
//! sync-parity/e2e gate (DEC-9). The UI reads the crossed level via the quota read API (ITEM-5).
//!
//! `#[cfg(feature = "saas")]` with the rest of `billing` (INV-5): a desktop build spawns no
//! alert loop.

use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use sqlx::PgPool;
use uuid::Uuid;

use super::quota::limits_of;
use super::rollup::current_period;

/// The staged alert ladder (design §4.3). Each rung fires exactly once per period per
/// resource. Ordered ascending; the sweep fires the HIGHEST rung a resource has crossed.
pub const ALERT_LADDER: [i16; 4] = [50, 80, 95, 100];

/// The highest ladder rung `pct_percent` (a 0..=100+ percentage) has crossed, or `0` when it
/// is below the first rung. Pure.
pub fn highest_rung(pct_percent: f64) -> i16 {
    let mut hit = 0i16;
    for &rung in ALERT_LADDER.iter() {
        if pct_percent >= rung as f64 {
            hit = rung;
        }
    }
    hit
}

/// A ladder rung the sweep NEWLY crossed for one account+resource (the sweep's return value,
/// so a test can assert fire-once without the sync registry).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertEmitted {
    pub account_id: Uuid,
    /// `"compute"` | `"storage"`.
    pub resource: String,
    /// The rung crossed (50/80/95/100).
    pub level: i16,
}

/// The standing usage-alert ladder loop (ITEM-4). Holds the pool; spawned once at boot when
/// `saas` + `billing.alert_enabled` (DEC-6 kill-switch), mirroring B1's `RollupSweeper`.
pub struct AlertSweeper {
    pool: PgPool,
}

impl AlertSweeper {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// One ladder cycle over the CURRENT period: for every account with a rollup row, for
    /// each resource, fire (once) any newly-crossed rung + emit its sync signal. Best-effort
    /// per account: an error is logged and the sweep continues (mirrors `GcSweeper::sweep`).
    pub async fn run_once(&self) {
        let emitted = self.sweep().await;
        // COALESCE per account: if BOTH compute + storage crossed a rung this cycle the UI
        // only needs ONE notify-and-refetch (it re-reads the whole quota state). Emit once per
        // distinct account (a set, insertion order irrelevant — notify-only wire payload).
        let mut seen = std::collections::HashSet::new();
        for e in &emitted {
            if seen.insert(e.account_id) {
                // Notify-and-refetch: the FE re-reads the quota state (self-gated on billing::read).
                super::sync::publish_account_quota_changed(&self.pool, e.account_id).await;
            }
        }
        if !emitted.is_empty() {
            tracing::info!(
                alerts = emitted.len(),
                accounts = seen.len(),
                "billing.alerts: usage-alert rungs crossed"
            );
        }
    }

    /// The pure-ish sweep body: returns the rungs it newly crossed (and stamped in
    /// `usage_alert_state`). Extracted from `run_once` so a test drives it directly against
    /// the pool and asserts fire-once without needing the in-process sync registry (mirrors
    /// B1 driving `fold_account`/`report_all` directly).
    pub async fn sweep(&self) -> Vec<AlertEmitted> {
        let (period_start, _period_end) = current_period(Utc::now());
        let accounts = match super::repository::accounts_with_current_rollup(
            &self.pool,
            period_start,
        )
        .await
        {
            Ok(a) => a,
            Err(e) => {
                tracing::error!(error = %e, "billing.alerts: could not list accounts; skipping cycle");
                return Vec::new();
            }
        };

        let mut emitted = Vec::new();
        for account_id in accounts {
            match self.sweep_account(account_id, period_start).await {
                Ok(mut v) => emitted.append(&mut v),
                Err(e) => {
                    tracing::error!(error = %e, %account_id, "billing.alerts: sweep_account failed; continuing")
                }
            }
        }
        emitted
    }

    /// Sweep ONE account: read its plan limits + current usage, then per resource advance the
    /// ladder to the highest crossed rung, recording each newly-crossed rung. `period_start`
    /// is threaded in so the whole cycle keys one period consistently.
    async fn sweep_account(
        &self,
        account_id: Uuid,
        period_start: chrono::DateTime<Utc>,
    ) -> Result<Vec<AlertEmitted>, ziee_core::AppError> {
        let Some((plan_id, _status)) =
            super::repository::account_billing_context(&self.pool, account_id).await?
        else {
            return Ok(Vec::new());
        };
        let Some(limits) = limits_of(&plan_id) else {
            return Ok(Vec::new());
        };
        // Use the period read ONCE at the top of the sweep (blind-audit F2 — no second clock read).
        let usage = super::repository::period_usage(&self.pool, account_id, period_start).await?;

        let mut out = Vec::new();
        // (resource label, used, allowance).
        let resources = [
            (
                "compute",
                usage.compute_core_hours + usage.gpu_hours,
                limits.compute_allowance,
            ),
            ("storage", usage.storage_gb_months, limits.storage_allowance),
        ];
        for (resource, used, allowance) in resources {
            if allowance <= 0.0 {
                continue; // an unlimited/zero-allowance resource has no ladder
            }
            let pct = used / allowance * 100.0;
            let rung = highest_rung(pct);
            if rung == 0 {
                continue;
            }
            if let Some(level) = super::repository::advance_alert_level(
                &self.pool,
                account_id,
                period_start,
                resource,
                rung,
            )
            .await?
            {
                out.push(AlertEmitted {
                    account_id,
                    resource: resource.to_string(),
                    level,
                });
            }
        }
        Ok(out)
    }

    /// Spawn the standing periodic ladder loop (boot-time + every `interval_hours`),
    /// mirroring `RollupSweeper::spawn_loop`. Best-effort: a cycle error is logged and the
    /// loop continues.
    pub fn spawn_loop(self: Arc<Self>, interval_hours: u64) {
        let period = Self::loop_period(interval_hours);
        tokio::spawn(async move {
            loop {
                self.run_once().await;
                tokio::time::sleep(period).await;
            }
        });
    }

    /// The loop tick period. Production: `interval_hours` (≥1h). Under
    /// `#[cfg(debug_assertions)]` ONLY, a `CYTO_BILLING_ALERT_TICK_MS` override shortens it
    /// to milliseconds so a test can observe an emit after seeding a rollup row (mirrors
    /// `RollupSweeper::loop_period` / `SYNC_RECHECK_TICK_MS`). Compiled OUT of a release binary.
    fn loop_period(interval_hours: u64) -> Duration {
        #[cfg(debug_assertions)]
        {
            if let Some(ms) = std::env::var("CYTO_BILLING_ALERT_TICK_MS")
                .ok()
                .and_then(|v| v.trim().parse::<u64>().ok())
                .filter(|ms| *ms > 0)
            {
                return Duration::from_millis(ms);
            }
        }
        Duration::from_secs(interval_hours.max(1) * 3600)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highest_rung_is_the_greatest_crossed() {
        assert_eq!(highest_rung(0.0), 0);
        assert_eq!(highest_rung(49.9), 0);
        assert_eq!(highest_rung(50.0), 50);
        assert_eq!(highest_rung(79.9), 50);
        assert_eq!(highest_rung(80.0), 80);
        assert_eq!(highest_rung(95.0), 95);
        assert_eq!(highest_rung(100.0), 100);
        assert_eq!(highest_rung(140.0), 100, "over 100% caps at the top rung");
    }
}
