//! Compute T6 — the quota-enforcement seam at `create_job` (design
//! `metering-billing-quota.md` §4.2a / §7.2).
//!
//! This is the CONSUMER half of billing B4's frozen `check_quota` contract (SEAMS PROV-B4-1,
//! the billing→compute REVERSE seam): T6 resolves the job's tenant, builds the exact
//! [`QuotaAsk::Compute`](crate::modules::billing::quota::QuotaAsk) B4 declares, and switches on
//! B4's three-arm [`QuotaVerdict`]. It defines NO quota numbers of its own — the allowance,
//! the hard-cap-vs-overage policy and the spend-cap all live in B4.
//!
//! `#[cfg(feature = "saas")]` (INV-3 / BQ-INV-8): the whole module compiles OUT of desktop with
//! the rest of `billing`. The single call site in `create_job` is likewise saas-gated, so a
//! desktop build never resolves an account nor checks a quota — `create_job` is byte-identical
//! without the feature.
//!
//! **Fail-safe (DEC-1):** the check REFUSES only on a positive `BlockOverQuota` verdict for a
//! RESOLVED account. A scope-less job, an unresolvable account, or a DB error all FAIL OPEN
//! (proceed) — a transient metering-DB blip must never turn a job-create into a 402, and the
//! COGS wall still fires on every normal path. The box-level admission cap bounds the host
//! regardless.

use axum::http::StatusCode;
use sqlx::PgPool;
use uuid::Uuid;
use ziee_core::AppError;

use crate::modules::billing::quota::{check_quota, QuotaAsk, QuotaVerdict};

/// The coarse per-CORE nominal wall-hours estimate used to project a job's marginal compute ask
/// into core-hours (DEC-3/DEC-4). No per-job duration signal exists in the spec yet, so this is a
/// coarse admission stand-in — the same "coarse local stand-in constant" pattern as B4's
/// `OVERAGE_CENTS_PER_*`. A named `const` (not an inline literal) so a later increment can replace
/// it with a real duration estimate without a rewrite. `est_core_hours = requested_cores ×
/// EST_JOB_CORE_HOURS_PER_CORE`. Its accuracy only affects the MARGINAL ask near a boundary: the
/// hard cap is still enforced at the true allowance because `used` accumulates from REAL metering
/// (T5), so an under/over-estimate only shifts the exact job at which the block fires by one ask.
/// `0.1` core-hour (≈6 min nominal per core) is small enough to leave a fresh free account real
/// headroom (not a single-job tier) yet positive, so any account AT its allowance is refused on the
/// next job.
pub const EST_JOB_CORE_HOURS_PER_CORE: f64 = 0.1;

/// Project a job's requested CPU cores into the marginal core-hours estimate the compute quota ask
/// carries (DEC-3). `spec_cpu` is the analysis spec's `schedule.cpu` (`None`/≤0 for a
/// non-analysis job or an unset request → 1 core). Pure.
pub fn est_core_hours(spec_cpu: Option<i64>) -> f64 {
    let cores = spec_cpu.filter(|c| *c > 0).unwrap_or(1) as f64;
    cores * EST_JOB_CORE_HOURS_PER_CORE
}

/// Build the exact [`QuotaAsk::Compute`] shape B4 declares (INV-5, the PROV-B4-1 consumer
/// contract). `resource_class` is the resolved job class string; `spec_cpu` drives the
/// [`est_core_hours`] estimate. Pure.
pub fn compute_ask(resource_class: &str, spec_cpu: Option<i64>) -> QuotaAsk {
    QuotaAsk::Compute {
        resource_class: resource_class.to_string(),
        est_core_hours: est_core_hours(spec_cpu),
    }
}

/// Map a compute [`QuotaVerdict`] to the create-job outcome (DEC-2), switching ALL THREE arms:
/// `Allow`/`AllowMeteredOverage` → `Ok(())` (proceed; paid overage meters via T5), and
/// `BlockOverQuota{reason}` → `Err` with **402 Payment Required**, code `QUOTA_EXCEEDED`, carrying
/// the verdict's reason (INV-2, the typed non-silent refusal). Pure — no DB, so the 3-arm switch
/// is oracle-testable (TEST-8).
pub fn map_compute_verdict(verdict: QuotaVerdict) -> Result<(), AppError> {
    match verdict {
        QuotaVerdict::Allow | QuotaVerdict::AllowMeteredOverage => Ok(()),
        QuotaVerdict::BlockOverQuota { reason } => Err(AppError::new(
            StatusCode::PAYMENT_REQUIRED,
            "QUOTA_EXCEEDED",
            format!("Your plan's compute allowance is used up — upgrade to continue ({reason})"),
        )),
    }
}

/// Map a storage [`QuotaVerdict`] to the ingest outcome (DEC-2 / shared with `workstore::ingest`,
/// DEC-8): `Allow`/`AllowMeteredOverage` → `Ok(())`; `BlockOverQuota{reason}` → `Err` with
/// **507 Insufficient Storage**, code `STORAGE_QUOTA_EXCEEDED` (INV-2). Pure.
pub fn map_storage_verdict(verdict: QuotaVerdict) -> Result<(), AppError> {
    match verdict {
        QuotaVerdict::Allow | QuotaVerdict::AllowMeteredOverage => Ok(()),
        QuotaVerdict::BlockOverQuota { reason } => Err(AppError::new(
            StatusCode::INSUFFICIENT_STORAGE,
            "STORAGE_QUOTA_EXCEEDED",
            format!("Your plan's storage allowance is full — upgrade or free space ({reason})"),
        )),
    }
}

/// Resolve a job's billing tenant (INV-4): a project-scoped job → `account_of_project`; else a
/// dataset-scoped job → `account_of_dataset`; else (scope-less) → `None`. A resolve error degrades
/// to `None` (fail-safe, DEC-1) — never fails the create. Mirrors
/// `jobs::seams::DbComputeMeter::resolve_account` and `workstore::ingest::resolve_ingest_account`.
pub async fn resolve_job_account(
    pool: &PgPool,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
) -> Option<Uuid> {
    let res = if let Some(p) = project_id {
        crate::modules::account::scope::account_of_project(pool, p).await
    } else if let Some(d) = dataset_id {
        crate::modules::account::scope::account_of_dataset(pool, d).await
    } else {
        return None;
    };
    match res {
        Ok(account_id) => account_id,
        Err(e) => {
            tracing::warn!(error = %e, "compute quota: account resolution failed; skipping quota check (fail-open)");
            None
        }
    }
}

/// The compute quota pre-check `create_job` calls (ITEM-1, design §4.2a). Resolves the tenant,
/// asks B4's `check_quota`, and returns `Err(402)` ONLY on a positive `BlockOverQuota` for a
/// resolved account. A scope-less/unresolvable account or a `check_quota` DB error FAILS OPEN
/// (logs, returns `Ok(())`) — DEC-1. Side-effect-free apart from the log.
pub async fn enforce_compute_quota(
    pool: &PgPool,
    project_id: Option<Uuid>,
    dataset_id: Option<Uuid>,
    resource_class: &str,
    spec_cpu: Option<i64>,
) -> Result<(), AppError> {
    let Some(account_id) = resolve_job_account(pool, project_id, dataset_id).await else {
        // No tenant to attribute → nothing to gate (fail-open, DEC-1).
        return Ok(());
    };
    let ask = compute_ask(resource_class, spec_cpu);
    match check_quota(pool, account_id, ask).await {
        Ok(verdict) => map_compute_verdict(verdict),
        Err(e) => {
            // A metering-DB read failure must not 402 a legitimate create (fail-open, DEC-1).
            tracing::warn!(error = %e, %account_id, "compute quota: check_quota read failed; admitting job (fail-open)");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-8: the pure 3-arm verdict switch + estimate, oracle-checked, no DB.
    #[test]
    fn est_core_hours_scales_with_cores_and_defaults_to_one() {
        assert_eq!(est_core_hours(None), EST_JOB_CORE_HOURS_PER_CORE);
        assert_eq!(
            est_core_hours(Some(0)),
            EST_JOB_CORE_HOURS_PER_CORE,
            "≤0 → 1 core"
        );
        assert_eq!(
            est_core_hours(Some(-3)),
            EST_JOB_CORE_HOURS_PER_CORE,
            "negative → 1 core"
        );
        assert_eq!(est_core_hours(Some(4)), 4.0 * EST_JOB_CORE_HOURS_PER_CORE);
        assert!(
            est_core_hours(Some(1)) > 0.0,
            "a positive estimate tips a free-at-ceiling account"
        );
    }

    #[test]
    fn compute_ask_carries_the_frozen_b4_shape() {
        // INV-5: the exact QuotaAsk::Compute variant B4 declares.
        match compute_ask("cpu-sandbox", Some(2)) {
            QuotaAsk::Compute {
                resource_class,
                est_core_hours,
            } => {
                assert_eq!(resource_class, "cpu-sandbox");
                assert_eq!(est_core_hours, 2.0 * EST_JOB_CORE_HOURS_PER_CORE);
            }
            other => panic!("expected Compute ask, got {other:?}"),
        }
    }

    #[test]
    fn map_compute_verdict_switches_all_three_arms() {
        assert!(map_compute_verdict(QuotaVerdict::Allow).is_ok());
        assert!(map_compute_verdict(QuotaVerdict::AllowMeteredOverage).is_ok());
        let err = map_compute_verdict(QuotaVerdict::BlockOverQuota {
            reason: "free-tier allowance reached".into(),
        })
        .expect_err("block → err");
        assert_eq!(err.status_code(), 402);
        assert_eq!(err.error_code(), "QUOTA_EXCEEDED");
        // The block reason MUST propagate into the refusal message (AppError derives Debug over its
        // `message` field). A regression that dropped `{reason}` fails here — no tautological OR.
        assert!(
            format!("{err:?}").contains("free-tier allowance reached"),
            "the block reason is carried into the refusal: {err:?}"
        );
    }

    #[test]
    fn map_storage_verdict_switches_all_three_arms() {
        assert!(map_storage_verdict(QuotaVerdict::Allow).is_ok());
        assert!(map_storage_verdict(QuotaVerdict::AllowMeteredOverage).is_ok());
        let err = map_storage_verdict(QuotaVerdict::BlockOverQuota {
            reason: "storage full".into(),
        })
        .expect_err("block → err");
        assert_eq!(err.status_code(), 507);
        assert_eq!(err.error_code(), "STORAGE_QUOTA_EXCEEDED");
        assert!(
            format!("{err:?}").contains("storage full"),
            "the block reason is carried into the storage refusal: {err:?}"
        );
    }
}
