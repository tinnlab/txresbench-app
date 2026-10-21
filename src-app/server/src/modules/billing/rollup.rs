//! The usage-rollup fold + report periodic job (ITEM-2/ITEM-3 — **PROV-B1-1**).
//!
//! Two separate periodic steps on one loop (DEC-5), mirroring `workstore::gc`'s
//! `GcSweeper` (`spawn_loop`: `Arc<Self>` + `tokio::spawn` + `loop { work; sleep }`,
//! error-logged-and-continue), wired at boot exactly like the GC sweep:
//!
//!  1. **FOLD** — for each account with metering activity, roll its raw
//!     `compute_meter`/`storage_meter` rows up into the current-period `usage_rollup`
//!     row, EXACTLY-ONCE. BOTH compute and storage are FULL-RECOMPUTE SETs over the
//!     period (idempotent by construction — a period recompute picks up ties + late
//!     arrivals that a strict-`>` high-water mark would drop, blind-audit F1) +
//!     `UNIQUE(account_id, period_start)` upsert; INV-1/INV-4. Reader-only against the
//!     meters (INV-5) — the SQL lives in `repository::fold_account`.
//!  2. **REPORT** — for each rollup row with unreported usage, push the DELTA
//!     (`current − reported_*`) per resource to Stripe Billing Meters via
//!     `meter::report_usage` (PROV-B2-3 → the PROV-B0-3 stand-in locally), keyed by the
//!     exactly-once segment `identifier` (design §2.3 guard 3), then advance that
//!     resource's reported watermark. Pushing DELTAS (not the cumulative figure) to a
//!     SUM-aggregation meter reconstructs the total exactly (blind-audit F2). Per-
//!     resource errors are isolated; accounts with no Stripe customer are skipped.
//!
//! The GB-months integral (INV-3) is a PURE function ([`gb_months`]) so the
//! time-weighting is unit-testable without a DB (TEST-2). Follows Lago's
//! `WEIGHTED_SUM` billable-metric shape (design §12): the time-weighted integral of
//! the stock quantity held over the period.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Datelike, TimeZone, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use super::client::StripeClient;

/// Bytes per billed GB — decimal (10⁹), the cloud-billing convention (AWS/GCP/Stripe
/// all quote GB as 10⁹ bytes for usage pricing), named so it is not a magic literal.
pub const BYTES_PER_GB: f64 = 1_000_000_000.0;

/// Seconds in a billed "month" — a fixed 30-day month (2,592,000 s). GB-months is a
/// rate × time figure, so the month length is a billing convention, fixed here so the
/// integral is deterministic and matches the design's `storage_gb_months` unit
/// (design §2.2). A future subscription-anchored period does not change this unit.
pub const SECONDS_PER_MONTH: f64 = 30.0 * 24.0 * 3600.0;

/// Seconds in an hour — compute is billed in core-hours / gpu-hours (`secs / 3600`).
pub const SECONDS_PER_HOUR: f64 = 3600.0;

/// B3 (DEC-7): the retention window for the `billing_webhook_events` dedupe table. Stripe
/// never retries a webhook beyond ~3 days, so 90d is a generous safety margin before a
/// processed event id can be forgotten. A fixed constant with rationale (a dedupe TTL is not
/// an operator policy knob), structured so it can be promoted to `billing_settings` later.
pub const WEBHOOK_EVENT_RETENTION_DAYS: i64 = 90;

/// The billing period a `now` falls in — the calendar UTC month `[first-of-month,
/// first-of-next-month)` (DEC-1). This is the concrete realization of "the Stripe
/// billing period" for B1: the window is FIXED (not arbitrary) and `period_start` is
/// the `UNIQUE(account_id, period_start)` idempotency anchor. A later increment can
/// replace the calendar month with the real subscription-anchored period from B2's
/// subscription data WITHOUT changing the fold — it only changes what `(start, end)`
/// this returns. Pure, so it is unit-testable (TEST-2 boundary legs).
pub fn current_period(now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = Utc
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or(now);
    let (ny, nm) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    let end = Utc
        .with_ymd_and_hms(ny, nm, 1, 0, 0, 0)
        .single()
        .unwrap_or(now);
    (start, end)
}

/// The time-weighted GB-months integral of a stock quantity held over
/// `[period_start, period_end)` — Lago's `WEIGHTED_SUM` shape (INV-3).
///
/// `opening_bytes` is the running byte balance at `period_start` (the signed sum of
/// every `storage_meter.delta_bytes` BEFORE the period). `events` are the signed
/// deltas WITHIN the period, in `created_at` order. The balance is piecewise-constant
/// between events; the integral is `Σ balance_i × Δt_i` (byte-seconds), converted to
/// GB-months. RECOMPUTED from scratch each fold ⇒ idempotent by construction (DEC-3):
/// the same inputs always yield the same figure, so a re-run never drifts (INV-4).
///
/// `i128` byte-seconds accumulation would overflow only past ~10²³ byte-seconds
/// (≈ 3 EB held for a month); `f64` is used for the final rate so fractional
/// GB-months are represented, and the intermediate is `f64` byte-seconds which is
/// exact enough for billing (52-bit mantissa ≫ realistic byte-second magnitudes).
pub fn gb_months(
    opening_bytes: i64,
    events: &[(DateTime<Utc>, i64)],
    period_start: DateTime<Utc>,
    period_end: DateTime<Utc>,
) -> f64 {
    if period_end <= period_start {
        return 0.0;
    }
    let mut balance = opening_bytes as f64;
    let mut cursor = period_start;
    let mut byte_seconds = 0.0_f64;
    for &(at, delta) in events {
        // Defensive clamp: only integrate the in-period segment (a caller that hands
        // an out-of-window event does not corrupt the area).
        let at = at.clamp(period_start, period_end);
        let seg = (at - cursor).num_milliseconds() as f64 / 1000.0;
        if seg > 0.0 {
            byte_seconds += balance * seg;
        }
        balance += delta as f64;
        cursor = at;
    }
    let tail = (period_end - cursor).num_milliseconds() as f64 / 1000.0;
    if tail > 0.0 {
        byte_seconds += balance * tail;
    }
    byte_seconds / BYTES_PER_GB / SECONDS_PER_MONTH
}

/// The smallest reportable delta — below this the change is not billable and is not
/// pushed (avoids emitting a meter event for float noise).
pub const REPORT_EPSILON: f64 = 1e-9;

/// The exactly-once Stripe report `identifier` for a DELTA SEGMENT `[from_value,
/// to_value]` of one resource in a period (design §2.3 guard 3). It keys the exact
/// segment being reported, so: a RETRY of the same delta carries the SAME identifier
/// (Stripe dedups → no double push), and a SUBSEQUENT delta `[to, to']` carries a NEW
/// identifier (a genuinely new billable event). Because the report pushes DELTAS to a
/// summing meter (not the cumulative figure), the segments tile the period with no
/// overlap — the meter's SUM reconstructs the cumulative total exactly (blind-audit F2).
pub fn report_identifier(
    account_id: Uuid,
    period_start: DateTime<Utc>,
    resource: &str,
    from_value: f64,
    to_value: f64,
) -> String {
    let from_micros = (from_value * 1_000_000.0).round() as i64;
    let to_micros = (to_value * 1_000_000.0).round() as i64;
    format!(
        "{account_id}:{}:{resource}:{from_micros}:{to_micros}",
        period_start.timestamp()
    )
}

/// The standing rollup fold+report loop (ITEM-2/3). Holds the pool; spawned once at
/// boot when `saas` + `billing.rollup_enabled` (DEC-4 kill-switch).
pub struct RollupSweeper {
    pool: PgPool,
}

impl RollupSweeper {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    /// One fold+report cycle over the CURRENT period: fold every account with new
    /// metering activity, then report every dirty rollup row. Best-effort per step:
    /// a per-account fold error is logged and the sweep continues (the next cycle
    /// self-heals), mirroring `GcSweeper::sweep`'s error posture.
    pub async fn run_once(&self) {
        let (period_start, period_end) = current_period(Utc::now());
        self.fold_period(period_start, period_end).await;
        self.report_dirty().await;
        self.prune_webhook_events().await;
    }

    /// B3 (DEC-7) — prune `billing_webhook_events` rows older than the retention window
    /// (90 days; Stripe never retries beyond ~3 days) so the dedupe table stays bounded
    /// (§4 accumulating-table rule). Best-effort: an error is logged, the sweep continues.
    pub async fn prune_webhook_events(&self) {
        // #41 (INV-2): the retention window is read AT USE from billing_settings (an
        // admin-configurable knob), falling back to the compiled default on a DB error.
        let retention = super::repository::get_billing_settings(&self.pool)
            .await
            .map(|s| s.webhook_event_retention_days)
            .unwrap_or(WEBHOOK_EVENT_RETENTION_DAYS);
        match super::repository::prune_webhook_events(&self.pool, retention).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(pruned = n, "billing: pruned old webhook dedupe rows"),
            Err(e) => {
                tracing::error!(error = %e, "billing: webhook-events prune failed; continuing")
            }
        }
    }

    /// FOLD step — roll each active account up into its current-period row.
    pub async fn fold_period(&self, period_start: DateTime<Utc>, period_end: DateTime<Utc>) {
        let accounts = match super::repository::accounts_with_activity(
            &self.pool,
            period_start,
            period_end,
        )
        .await
        {
            Ok(a) => a,
            Err(e) => {
                tracing::error!(error = %e, "billing.rollup: could not list active accounts; skipping fold cycle");
                return;
            }
        };
        let mut changed = 0usize;
        for account_id in accounts {
            match super::repository::fold_account(&self.pool, account_id, period_start, period_end)
                .await
            {
                Ok(outcome) => {
                    if outcome.changed {
                        changed += 1;
                        // Owner-scoped notify-and-refetch (PROV-B1-2) — a detached
                        // (background) emit, so every member's device refetches.
                        super::sync::publish_account_usage_changed(&self.pool, account_id).await;
                    }
                }
                Err(e) => {
                    tracing::error!(error = %e, %account_id, "billing.rollup: fold_account failed; continuing");
                }
            }
        }
        if changed > 0 {
            tracing::info!(changed, "billing.rollup: folded active accounts");
        }
    }

    /// REPORT step — push every dirty rollup row to Stripe Billing Meters. Requires a
    /// Stripe client; if the secret is unconfigured, the report step is skipped (the
    /// fold still ran, and the rows stay dirty until a configured cycle reports them).
    pub async fn report_dirty(&self) {
        let client = match StripeClient::from_env() {
            Ok(c) => c,
            Err(_) => {
                tracing::debug!(
                    "billing.rollup: STRIPE_SECRET_KEY unset; skipping report step (fold already ran)"
                );
                return;
            }
        };
        match report_all(&self.pool, &client).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(
                reported = n,
                "billing.rollup: reported rollup rows to Stripe"
            ),
            Err(e) => {
                tracing::error!(error = %e, "billing.rollup: report step failed; rows stay dirty for the next cycle")
            }
        }
    }

    /// Spawn the standing periodic fold+report loop (boot-time + every
    /// `interval_hours`), mirroring `GcSweeper::spawn_loop`. Best-effort: a cycle
    /// error is logged and the loop continues.
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
    /// `#[cfg(debug_assertions)]` ONLY, a `CYTO_BILLING_ROLLUP_TICK_MS` override
    /// shortens it to milliseconds so a test can observe a fold+emit after seeding
    /// meter rows (mirrors `SYNC_RECHECK_TICK_MS` / `LLM_RUNTIME_REAPER_TICK_MS`). The
    /// override arm is compiled OUT of a release binary, so it cannot be set in
    /// production.
    fn loop_period(interval_hours: u64) -> Duration {
        #[cfg(debug_assertions)]
        {
            if let Some(ms) = std::env::var("CYTO_BILLING_ROLLUP_TICK_MS")
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

/// Report every rollup row with unreported usage, pushing the DELTA (`current −
/// reported`) per resource to Stripe Billing Meters via `report_usage` (PROV-B2-3),
/// then advancing that resource's reported watermark. Returns the number of rows that
/// had ≥1 resource successfully reported. Extracted from [`RollupSweeper`] so the
/// report SHAPE is drivable from a test against the PROV-B0-3 stand-in with an explicit
/// client (DEC-4/DEC-5).
///
/// Exactly-once (blind-audit F2/F4): a summing meter totals the tiled deltas to the
/// cumulative figure; the identifier keys the exact segment so a retry dedups; the
/// reported watermark advances ONLY on a successful push. Per-resource errors are
/// ISOLATED (logged + skipped) so one account's failing push never head-of-line-blocks
/// the rest — the resource stays dirty and is retried next cycle.
pub async fn report_all(
    pool: &PgPool,
    client: &StripeClient,
) -> Result<usize, ziee_core::AppError> {
    let rows = super::repository::dirty_with_customer(pool).await?;
    let mut reported = 0usize;
    for row in rows {
        // (event_name, current cumulative, already-reported watermark).
        let resources: [(&str, f64, f64); 3] = [
            (
                "compute_core_hours",
                row.compute_core_hours,
                row.reported_compute_core_hours,
            ),
            ("gpu_hours", row.gpu_hours, row.reported_gpu_hours),
            (
                "storage_gb_months",
                row.storage_gb_months,
                row.reported_storage_gb_months,
            ),
        ];
        let mut any = false;
        for (event_name, current, already) in resources {
            let delta = current - already;
            if delta <= REPORT_EPSILON {
                continue; // nothing new to bill for this resource
            }
            let identifier = report_identifier(
                row.account_id,
                row.period_start,
                event_name,
                already,
                current,
            );
            // ISOLATE per-resource errors: a failed push leaves the watermark where it
            // is, so the resource stays dirty and retries next cycle — it does NOT abort
            // the loop or block other accounts (F4).
            match super::meter::report_usage(
                pool,
                client,
                row.account_id,
                event_name,
                delta,
                &identifier,
            )
            .await
            {
                Ok(()) => {
                    match super::repository::advance_reported(
                        pool,
                        row.id,
                        event_name,
                        current,
                        &identifier,
                    )
                    .await
                    {
                        Ok(()) => any = true,
                        Err(e) => tracing::error!(
                            error = %e, %event_name, account = %row.account_id,
                            "billing.rollup: pushed a meter event but failed to advance the reported watermark; \
                             it will re-push next cycle (Stripe dedups on the identifier)"
                        ),
                    }
                }
                Err(e) => tracing::warn!(
                    error = %e, %event_name, account = %row.account_id,
                    "billing.rollup: meter push failed; resource stays dirty, retried next cycle"
                ),
            }
        }
        if any {
            reported += 1;
        }
    }
    Ok(reported)
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-2 (unit half) [invariant: INV-3]: the GB-months integral is the
    // time-weighted stock integral (Lago WEIGHTED_SUM). Hold exactly 1 GB (10⁹ bytes)
    // for the whole 30-day month ⇒ exactly 1.0 GB-months.
    #[test]
    fn one_gb_held_a_full_month_is_one_gb_month() {
        let start = Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap(); // 30 days
                                                                      // opening balance 1 GB, no in-period events → held the whole period.
        let v = gb_months(1_000_000_000, &[], start, end);
        // June is 30 days, exactly SECONDS_PER_MONTH → 1.0.
        assert!(
            (v - 1.0).abs() < 1e-9,
            "1 GB for a 30-day month = 1.0, got {v}"
        );
    }

    // TEST-2 (unit half) [invariant: INV-3]: a +X at t0 then −X halfway holds X for
    // half the period ⇒ half the naive GB-months. Also proves the boundary handling
    // (opening 0, delta arrives inside the window).
    #[test]
    fn delta_in_and_out_is_time_weighted() {
        let start = Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap();
        let mid = Utc.with_ymd_and_hms(2026, 6, 16, 0, 0, 0).unwrap(); // +15 days
        let end = Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap();
        // +1 GB at start, held until mid (15 days), then −1 GB (held 0 for the rest).
        let v = gb_months(
            0,
            &[(start, 1_000_000_000), (mid, -1_000_000_000)],
            start,
            end,
        );
        // 15 of 30 days at 1 GB ⇒ 0.5 GB-months.
        assert!(
            (v - 0.5).abs() < 1e-6,
            "1 GB for half the month = 0.5, got {v}"
        );
    }

    // TEST-2 idempotency leg: recomputing over the same inputs yields the identical
    // figure (DEC-3 recompute-from-scratch is replay-safe).
    #[test]
    fn gb_months_is_deterministic() {
        let start = Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap();
        let events = [
            (start, 2_000_000_000),
            (
                Utc.with_ymd_and_hms(2026, 6, 10, 0, 0, 0).unwrap(),
                -1_000_000_000,
            ),
        ];
        let a = gb_months(0, &events, start, end);
        let b = gb_months(0, &events, start, end);
        assert_eq!(
            a.to_bits(),
            b.to_bits(),
            "same inputs → byte-identical output"
        );
    }

    #[test]
    fn current_period_is_the_calendar_month() {
        let now = Utc.with_ymd_and_hms(2026, 6, 15, 12, 30, 0).unwrap();
        let (s, e) = current_period(now);
        assert_eq!(s, Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap());
        assert_eq!(e, Utc.with_ymd_and_hms(2026, 7, 1, 0, 0, 0).unwrap());
        // December rolls the year.
        let dec = Utc.with_ymd_and_hms(2026, 12, 20, 0, 0, 0).unwrap();
        let (_s, e2) = current_period(dec);
        assert_eq!(e2, Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap());
    }

    // The identifier keys a DELTA SEGMENT [from,to]: a retry of the same segment is
    // stable (Stripe dedups), a subsequent segment is fresh (exactly-once, guard 3).
    #[test]
    fn report_identifier_keys_the_delta_segment() {
        let acct = Uuid::nil();
        let ps = Utc.with_ymd_and_hms(2026, 6, 1, 0, 0, 0).unwrap();
        let a = report_identifier(acct, ps, "compute_core_hours", 10.0, 15.0);
        let b = report_identifier(acct, ps, "compute_core_hours", 10.0, 15.0);
        assert_eq!(
            a, b,
            "same segment → same identifier (Stripe dedups a retry)"
        );
        let c = report_identifier(acct, ps, "compute_core_hours", 15.0, 20.0);
        assert_ne!(a, c, "the next delta segment → a fresh identifier");
        // Same delta magnitude at a DIFFERENT position is still distinct — the segments
        // tile without overlap, so the meter's SUM reconstructs the cumulative total.
        assert_ne!(
            a,
            report_identifier(acct, ps, "compute_core_hours", 0.0, 5.0)
        );
    }
}
