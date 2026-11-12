//! Admission control for sandbox children this module does not SCHEDULE.
//!
//! ## One pool, one number, one place
//!
//! Every sandbox child on this box is bounded by ONE quantity: `max_concurrent_jobs`,
//! counted as `SELECT count(*) FROM jobs WHERE status = 'running'`. The scheduler
//! enforces it in `dispatch_ready`; a run that is driven OUTSIDE the scheduler enforces
//! it by minting a real `jobs` row through
//! [`repository::JobRepository::create_running_under_cap`], whose admission check is a
//! sub-select of the INSERT (one statement — an HTTP handler has N of itself in flight
//! and cannot afford a check-then-act window).
//!
//! This module is the shared front door for the second kind. It exists because the
//! alternative — each such caller reading the cap and calling the repository itself —
//! is how the first drift happened: `provenance::verify` once enforced a private
//! `Semaphore::new(4)` ALONGSIDE `max_concurrent_jobs`, and two independent caps over
//! one CPU pool do not compose into a bound, they compose into a sum. There is
//! deliberately no second limiter here, no per-kind cap and no per-user cap; there is a
//! function that reads THE cap and performs THE admission.
//!
//! ## The cap is GLOBAL, and that is the correct choice here
//!
//! The resource being defended is the box: CPU, RAM and page cache, shared by every
//! tenant. A per-user cap cannot bound it — N users times k each is unbounded in N, so
//! the machine still falls over, just with a fairer-looking audit trail. A global cap
//! bounds the thing that actually breaks.
//!
//! The cost is real and is named rather than hidden: a global cap means one user can
//! occupy every slot and lock everyone else out. That is a FAIRNESS problem, and this
//! module is deliberately not where it gets solved, because the codebase already has a
//! fairness mechanism aimed at exactly it — `claim_next_fair` orders by the requester's
//! own running count, and `reserved_interactive_slots` holds back the last N slots for
//! interactive work. Fairness belongs there, under the one cap, where it composes.
//! Adding a per-user cap here would re-create the two-caps-that-must-agree bug this
//! module was written to prevent.
//!
//! ## Two shapes of refusal, because there are two shapes of caller
//!
//! * [`admit`] — for a caller a human is WAITING on (an HTTP request). Refusal is
//!   immediate and typed: HTTP 429 with an error code, because a request that cannot
//!   run must say so rather than block a connection on a queue with no visible depth.
//! * [`admit_within`] — for a DETACHED background caller (the conformance gate). Nobody
//!   is holding a socket, so a bounded wait is free and strictly better than refusing a
//!   run that would have been admissible a second later. It is a *bounded* wait with a
//!   *terminal, recorded* refusal, never an unbounded one: [`ADMISSION_WAIT`] is the
//!   whole budget, and exhausting it returns `None` for the caller to record. A wait
//!   with no deadline is the "silent queue that looks like a hang" this is written to
//!   avoid.
//!
//! Both end in the same INSERT. Neither counts anything the other does not.

use std::time::Duration;

use axum::http::StatusCode;
use sqlx::SqlitePool;
use uuid::Uuid;

use txresbench_core::AppError;

use super::models::Job;
use super::repository::JobRepository;
use super::settings::JobSettingsRepository;

/// How long a DETACHED caller may wait for a slot before giving up ([`admit_within`]).
///
/// Sized against the thing it actually waits for: the producing run's own `jobs` row,
/// which closes milliseconds after it dispatches its gate — the gate is spawned from
/// inside `finalize_analysis`, and `repo.finish` runs the moment that returns. So the
/// common case is won in well under a second and this budget only matters when the box
/// is genuinely saturated by OTHER work, which is exactly when giving up is right.
pub const ADMISSION_WAIT: Duration = Duration::from_secs(15);

/// Polling interval while waiting for a slot in [`admit_within`].
///
/// Now the FALLBACK default for the admin-configurable `admission_poll_ms` (#54):
/// the detached call site reads the live (budget, poll) pair from `job_settings`
/// and passes both in; this const is used when the settings row can't be read.
pub const ADMISSION_POLL: Duration = Duration::from_millis(250);

/// The refusal an HTTP caller gets when the compute pool is full.
///
/// 429 (not 503): the request is well-formed and the service is healthy — the pool is
/// momentarily full and retrying WILL work, which is precisely what 429 means and 503
/// does not. `Retry-After` is deliberately not asserted, because the honest answer is
/// "when a job finishes" and this layer cannot know that.
pub fn pool_full(error_code: &'static str) -> AppError {
    AppError::new(
        StatusCode::TOO_MANY_REQUESTS,
        error_code,
        "the compute pool is full (max_concurrent_jobs); retry shortly",
    )
}

/// Claim a concurrency slot by minting the run's `jobs` row.
///
/// `Ok(None)` ⇒ the pool is full and NO row was created; the caller refuses. `Err` is a
/// database failure, never a refusal — the two must not be collapsed, or a broken DB
/// reads to the caller as a busy box (§6: a DB error is not a 404, and it is not a 429
/// either).
///
/// `job_type` must NOT be `"analysis"`: `reconcile_orphaned_running` FINALIZES and
/// INGESTS an orphaned running *analysis* job at boot, and a run driven outside the
/// scheduler must never reach the catalog that way. As a non-analysis orphan it is
/// simply failed, which is correct.
///
/// The returned row is born `running`. The caller now owns a slot and MUST close the
/// row on every exit path — see [`close_slot`]. A `running` row that never closes is
/// not cosmetic: it permanently consumes a slot, and leaking enough of them wedges the
/// scheduler for the life of the process.
pub async fn admit(
    pool: &SqlitePool,
    id: Uuid,
    owner_id: Uuid,
    job_type: &str,
    name: &str,
    params: serde_json::Value,
    project_id: Option<Uuid>,
) -> Result<Option<Job>, AppError> {
    debug_assert_ne!(
        job_type, "analysis",
        "an out-of-scheduler run must not be job_type=analysis — boot reconcile would \
         finalize and INGEST it"
    );
    let (cap, _reserved) = JobSettingsRepository::new(pool.clone())
        .cap_and_reserved()
        .await;
    // `reserved` is deliberately unread: the reserved-interactive gate arbitrates which
    // QUEUED job the scheduler claims next, and these callers are not queued. Applying
    // it here would refuse an admissible run to hold a slot for a queue this caller
    // will never enter.
    JobRepository::new(pool.clone())
        .create_running_under_cap(id, owner_id, job_type, name, params, project_id, cap)
        .await
}

/// [`admit`] for a DETACHED caller: retry until a slot frees or `budget` expires.
///
/// `Ok(None)` ⇒ the budget expired with the pool still full. That is a terminal answer
/// the caller must RECORD somewhere an operator will meet it, not a silent skip.
// Mirrors `create_running_under_cap`'s arity, which it forwards to verbatim; collapsing
// these into a struct here would only move the same fields one indirection away.
#[allow(clippy::too_many_arguments)]
pub async fn admit_within(
    pool: &SqlitePool,
    id: Uuid,
    owner_id: Uuid,
    job_type: &str,
    name: &str,
    params: serde_json::Value,
    project_id: Option<Uuid>,
    budget: Duration,
    poll: Duration,
) -> Result<Option<Job>, AppError> {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        // The FIRST attempt happens before any sleep, so an idle box pays nothing.
        match admit(
            pool,
            id,
            owner_id,
            job_type,
            name,
            params.clone(),
            project_id,
        )
        .await?
        {
            Some(job) => return Ok(Some(job)),
            None => {
                if tokio::time::Instant::now() >= deadline {
                    return Ok(None);
                }
                tokio::time::sleep(poll).await;
            }
        }
    }
}

/// Release the slot claimed by [`admit`]/[`admit_within`], on EVERY exit path.
///
/// Mirrors `provenance::verify::runner::close_job_row`, and for the same reasons:
///
/// * The write is a guarded UPDATE that matches only a NON-terminal row, so a run a
///   user already stopped through `POST /jobs/{id}/stop` is left exactly as they expect
///   to find it, and a double close is a no-op rather than a rewrite.
/// * A failure to close is logged at `error!`, never swallowed — the row is holding a
///   concurrency slot, and losing that fact quietly is how a box wedges.
///
/// `failure` is `Some` only when the run itself broke. A run that completed and
/// reported a bad VERDICT (a conformance violation, a provenance mismatch) is a job
/// that COMPLETED: it did exactly what it was asked to.
pub async fn close_slot(pool: &SqlitePool, job_id: Uuid, failure: Option<&str>) {
    let repo = JobRepository::new(pool.clone());
    let owner = match repo.get_any(job_id).await {
        Ok(Some(job)) => {
            if job.status == "running" {
                let wrote = match failure {
                    None => repo.finish(job_id, 0).await,
                    Some(reason) => repo.fail(job_id, reason).await,
                };
                if let Err(e) = wrote {
                    tracing::error!(
                        %job_id, error = %e,
                        "jobs admission: failed to close an out-of-scheduler run's jobs row \
                         — a running row holds a concurrency slot until the process restarts"
                    );
                }
            }
            Some(job.owner_id)
        }
        Ok(None) => None,
        Err(e) => {
            tracing::error!(
                %job_id, error = %e,
                "jobs admission: could not read an out-of-scheduler run's jobs row to close it"
            );
            None
        }
    };
    super::runtime::runtime().close_job(job_id);
    if let Some(owner_id) = owner {
        super::seams::sync_sink().publish_job_changed(
            owner_id,
            super::seams::JobChange::Updated,
            job_id,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The refusal is 429 with the caller's own error code — not 503, and not a bare
    /// status. A caller that cannot tell "full, retry" from "sandbox is broken" retries
    /// the wrong one forever.
    #[test]
    fn pool_full_is_a_typed_429() {
        let err = pool_full("SANDBOX_POOL_FULL");
        assert_eq!(err.status_code(), 429, "a full pool is 429, never 503");
        assert_eq!(
            err.error_code(),
            "SANDBOX_POOL_FULL",
            "the caller's code is preserved"
        );
        assert!(
            format!("{err:?}").contains("max_concurrent_jobs"),
            "the message names the knob an operator would turn"
        );
    }

    /// The detached budget is bounded and non-trivial: a zero budget would make
    /// `admit_within` a plain `admit` (defeating its purpose), and an unbounded one
    /// would be the silent hang this module exists to avoid.
    #[test]
    fn the_detached_admission_budget_is_bounded_and_nonzero() {
        assert!(
            ADMISSION_WAIT > Duration::ZERO,
            "a zero budget is just `admit`"
        );
        assert!(
            ADMISSION_WAIT <= Duration::from_secs(60),
            "an unbounded-in-practice wait is a hang wearing a queue's clothes"
        );
        assert!(
            ADMISSION_POLL < ADMISSION_WAIT,
            "the poll interval must fit inside the budget or only one attempt is ever made"
        );
    }
}
