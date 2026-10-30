//! The verification orchestrator (P4 ITEM-9/10).
//!
//! Given a `pending` verification row + its recorded compute run, it: loads the
//! run's captured `rerun_spec_json` + recorded env, gathers the recorded output
//! signature from P1's catalog (READY artifacts by run_id), RE-RUNS the spec
//! headlessly via the P3 compute path (`jobs::verify`), compares the regenerated
//! signature to the recorded one (`diff::compare`), renders a certificate,
//! persists the terminal result, and emits an owner-scoped sync. Runs as a
//! detached one-shot task off the POST handler; the row starts `pending`. A boot
//! reclamation (`ProvenanceModule::init`) resolves any pending row orphaned by a
//! restart, so a crash/restart never leaves a verification hung forever.

use sqlx::SqlitePool;
use tokio::sync::watch;
use uuid::Uuid;

use crate::modules::sync::{publish, Audience, SyncAction, SyncEntity};
use crate::modules::workstore::catalog::repository::CatalogRepository;

use super::super::capture;
use super::super::permissions::ProvenanceRead;
use super::super::repository::{ProvenanceRepository, VerificationResult};
use super::status;
use super::{certificate, diff};
use diff::ToleranceMode;

// The private `Semaphore::new(4)` that used to live here is GONE, and its deletion is
// the point of the change, not a side effect of it.
//
// It bounded verifications against each other and against NOTHING else, so a box with
// `max_concurrent_jobs = 2` could be running 2 scheduled jobs and 4 verification
// re-runs — six bwrap children — while every admission mechanism in the process
// reported itself satisfied. Two independent caps over one CPU pool do not compose
// into a bound; they compose into a sum. Admission is now the SAME cap the scheduler
// enforces (`JobRepository::create_running_under_cap`), checked inside the INSERT that
// mints the run's `jobs` row, so a verification occupies a slot that a scheduled job
// then cannot, and vice versa. One pool, one number, one place an operator can turn it
// down.

/// Spawn the detached verify task. TWO rows already exist when this is called and
/// both are this task's to close: the `pending` verification row (the handler
/// inserted it) and the `jobs` row that makes the run listable, stoppable and
/// counted against the concurrency cap (`create_running_under_cap`). The
/// verification id and the job id are deliberately the SAME `Uuid` — it is also the
/// name of the sandbox workspace dir — so there is one identity to reason about.
///
/// On a returned `Err` the verification row is stamped `error` so it never hangs
/// `pending`; a hard panic inside the task unwinds past that stamp — the boot
/// reclamation (`reset_pending_verifications`) is the panic/restart backstop that
/// resolves such a row on the next start.
///
/// The `jobs` row is closed in a `finally`-shaped tail that runs on EVERY exit,
/// including the `Err` one. A `running` row that is never closed is not a cosmetic
/// leak: it permanently consumes a slot of `max_concurrent_jobs`, so leaking enough
/// of them wedges the scheduler for the life of the process. (Boot reconcile clears
/// them, which is a restart, not a fix.)
pub fn spawn_verification(
    pool: SqlitePool,
    verification_id: Uuid,
    target_run_id: Uuid,
    acting_user: Uuid,
    mode: ToleranceMode,
) {
    tokio::spawn(async move {
        let outcome =
            verify_run(&pool, verification_id, target_run_id, acting_user, mode).await;
        let failure = match outcome {
            Ok(()) => None,
            Err(e) => {
                tracing::error!(%verification_id, error = %e, "provenance verify task failed");
                stamp_error(&pool, verification_id, acting_user, "verification task failed").await;
                Some("verification task failed")
            }
        };
        close_job_row(&pool, verification_id, failure).await;
    });
}

/// Drive the verification's `jobs` row to a terminal state and free its cancel/SSE
/// registrations.
///
/// The row records THE RUN, not the verdict: a verification that completes and reports
/// `mismatch` is a job that COMPLETED — the re-run did exactly what it was asked to.
/// `failure` is `Some` only when the orchestration itself broke.
///
/// Both writers are guarded UPDATEs that match only a non-terminal row, so a run a user
/// already `stopped` through `POST /jobs/{id}/stop` is left exactly as they expect to
/// find it, and a double close is a no-op rather than a rewrite.
async fn close_job_row(pool: &SqlitePool, job_id: Uuid, failure: Option<&str>) {
    let repo = crate::modules::jobs::repository::JobRepository::new(pool.clone());
    let owner = match repo.get_any(job_id).await {
        Ok(Some(job)) => {
            if job.status == "running" {
                let wrote = match failure {
                    None => repo.finish(job_id, 0).await,
                    Some(reason) => repo.fail(job_id, reason).await,
                };
                if let Err(e) = wrote {
                    // NOT swallowed: a `running` row that never closes permanently
                    // consumes a slot of `max_concurrent_jobs`, so leaking enough of
                    // them wedges the scheduler until the process restarts.
                    tracing::error!(%job_id, error = %e, "provenance verify: failed to close the run's jobs row — a running row holds a concurrency slot");
                }
            }
            Some(job.owner_id)
        }
        Ok(None) => None,
        Err(e) => {
            tracing::error!(%job_id, error = %e, "provenance verify: could not read the run's jobs row to close it");
            None
        }
    };
    crate::modules::jobs::runtime::runtime().close_job(job_id);
    // Addressed to the row's OWNER (the requester), never to whoever happened to act:
    // an admin may have stopped this, and it is the owner's devices that render it.
    if let Some(owner_id) = owner {
        crate::modules::jobs::seams::sync_sink().publish_job_changed(
            owner_id,
            crate::modules::jobs::seams::JobChange::Updated,
            job_id,
        );
    }
}

/// Stamp a verification `error` (the last-resort resolver so a row never hangs
/// pending). Logs — does NOT swallow — a failing terminal UPDATE.
async fn stamp_error(pool: &SqlitePool, verification_id: Uuid, acting_user: Uuid, reason: &str) {
    let repo = ProvenanceRepository::new(pool.clone());
    match repo
        .update_verification_result(
            verification_id,
            &VerificationResult {
                status: status::ERROR.to_string(),
                diff_report: serde_json::json!({ "error": reason }),
                rootfs_digest: None,
                cert_json: None,
            },
        )
        .await
    {
        Ok(_) => emit(verification_id, acting_user),
        Err(e) => tracing::error!(
            %verification_id, error = %e,
            "provenance verify: failed to stamp error — row may remain pending until boot reclamation"
        ),
    }
}

/// The fallible task body.
pub async fn verify_run(
    pool: &SqlitePool,
    verification_id: Uuid,
    target_run_id: Uuid,
    acting_user: Uuid,
    mode: ToleranceMode,
) -> Result<(), ziee_core::AppError> {
    let repo = ProvenanceRepository::new(pool.clone());

    // The recorded run — for its captured env + the re-run spec. A missing run or
    // an interaction run (no captured compute spec) → terminal `error`.
    let recorded_run = repo.get_run(target_run_id).await?;
    let recorded_rootfs = recorded_run.as_ref().and_then(|r| r.env_rootfs_sha256.clone());
    let Some(spec) = repo.get_rerun_spec(target_run_id).await? else {
        return finalize(
            &repo, verification_id, acting_user, target_run_id, mode, status::ERROR,
            serde_json::json!({ "error": "run is not re-runnable (no captured compute spec)" }),
            None, recorded_rootfs,
        )
        .await;
    };

    // The recorded output signature = the run's READY catalog artifacts (a
    // non-ready/superseded row must not skew the recorded set).
    let catalog = CatalogRepository::new(pool.clone());
    let recorded: Vec<(String, String)> = catalog
        .list_by_run(target_run_id_project(&recorded_run, target_run_id), target_run_id)
        .await?
        .into_iter()
        .filter(|a| a.status == "ready")
        .map(|a| (a.output_id, a.content_hash))
        .collect();
    if recorded.is_empty() {
        return finalize(
            &repo, verification_id, acting_user, target_run_id, mode, status::ERROR,
            serde_json::json!({ "error": "no recorded (ready) outputs for this run" }),
            None, recorded_rootfs,
        )
        .await;
    }

    // Re-run the spec (debug-fake aware) and compute the outcome.
    let current_rootfs = capture::env_digest_rootfs();
    let (result_status, mut diff_report) =
        match rerun_signature(pool, &spec, verification_id, acting_user).await {
            Ok(rerun) => {
                let outcome = diff::compare(&recorded, &rerun, mode);
                (outcome.status, outcome.diff_report)
            }
            Err(detail) => {
                // Redact host paths before persisting (the message is returned to
                // project viewers + written into the export bundle).
                tracing::warn!(%verification_id, "verify re-run failed: {detail}");
                (status::ERROR.to_string(), serde_json::json!({ "error": redact_host_paths(&detail) }))
            }
        };

    // Fold the env-pin comparison into the report (honest: a Reproduced claim
    // against a CHANGED rootfs is flagged, never silently asserted).
    let env_changed = env_differs(&recorded_rootfs, &current_rootfs);
    if let Some(obj) = diff_report.as_object_mut() {
        obj.insert(
            "environment".to_string(),
            serde_json::json!({
                "recorded_rootfs_sha256": recorded_rootfs,
                "rerun_rootfs_sha256": current_rootfs,
                "env_changed": env_changed,
            }),
        );
    }

    finalize(
        &repo, verification_id, acting_user, target_run_id, mode, &result_status,
        diff_report, current_rootfs, recorded_rootfs,
    )
    .await
}

/// Resolve the project id of the recorded run (for the catalog `list_by_run` scope).
fn target_run_id_project(
    recorded_run: &Option<super::super::repository::RunReproRow>,
    _target_run_id: Uuid,
) -> Uuid {
    recorded_run.as_ref().and_then(|r| r.project_id).unwrap_or_default()
}

/// Persist the terminal verification + certificate, then emit sync.
#[allow(clippy::too_many_arguments)]
async fn finalize(
    repo: &ProvenanceRepository,
    verification_id: Uuid,
    acting_user: Uuid,
    target_run_id: Uuid,
    mode: ToleranceMode,
    status_str: &str,
    diff_report: serde_json::Value,
    rerun_rootfs: Option<String>,
    recorded_rootfs: Option<String>,
) -> Result<(), ziee_core::AppError> {
    let verified_at = chrono::Utc::now().to_rfc3339();
    let env_changed = env_differs(&recorded_rootfs, &rerun_rootfs);
    let cert = certificate::build_certificate(
        target_run_id,
        status_str,
        mode.as_str(),
        &diff_report,
        rerun_rootfs.as_deref(),
        env_changed,
        &verified_at,
    );
    repo.update_verification_result(
        verification_id,
        &VerificationResult {
            status: status_str.to_string(),
            diff_report,
            rootfs_digest: rerun_rootfs,
            cert_json: Some(cert),
        },
    )
    .await?;
    emit(verification_id, acting_user);
    Ok(())
}

/// Notify-and-refetch on completion; a detached task → no self-echo origin. The
/// audience is `provenance::read` (== the read-perm gating the refetch endpoint
/// `GET /provenance/verifications`), so EVERY project collaborator with read access
/// gets the live update (not just the acting user) — each refetches its own
/// project-scoped view (a non-member's refetch returns nothing). `acting_user` is
/// unused now that delivery is perm-scoped.
fn emit(verification_id: Uuid, _acting_user: Uuid) {
    publish(
        SyncEntity::ProvenanceVerification,
        SyncAction::Update,
        verification_id,
        Audience::perm::<ProvenanceRead>(),
        None,
    );
}

/// Strip absolute-path-looking tokens from an error message so host workspace
/// paths are not disclosed to project viewers / the export bundle. Redacts ANY
/// whitespace-delimited token that (after trimming wrapping punctuation) starts
/// with `/` — including a single-component `/outputs` — over-redacting a rare
/// non-path token is acceptable (safety over precision).
fn redact_host_paths(msg: &str) -> String {
    msg.split_whitespace()
        .map(|tok| {
            let trimmed = tok.trim_matches(|c| c == '(' || c == ')' || c == '"' || c == ':' || c == ',');
            if trimmed.starts_with('/') && trimmed.len() > 1 {
                "<path>"
            } else {
                tok
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whether the re-run environment differs from the run's RECORDED environment —
/// true only when BOTH are known and unequal (an unknown env is not a divergence
/// signal). The honest gate for the certificate's env-changed caveat.
fn env_differs(recorded: &Option<String>, rerun: &Option<String>) -> bool {
    matches!((recorded, rerun), (Some(a), Some(b)) if a != b)
}

/// Re-run the captured spec and return its `{(output_id, content_hash)}` signature.
/// Under `debug_assertions` a `_verify_rerun_fake` marker in the spec short-circuits
/// the sandbox (the external-boundary mock the always-run integration test uses;
/// physically compiled out of release — DEC-10).
async fn rerun_signature(
    pool: &SqlitePool,
    spec: &serde_json::Value,
    verification_id: Uuid,
    acting_user: Uuid,
) -> Result<Vec<(String, String)>, String> {
    #[cfg(debug_assertions)]
    if let Some(fake) = spec.get("_verify_rerun_fake") {
        return parse_fake(fake);
    }

    let budget = crate::modules::provenance::settings_cache::get(pool)
        .await
        .verify_time_budget_secs
        .max(1) as u64;
    // The re-run is owned by the REQUESTING user: `materialize_inputs` authorizes every
    // `artifact_ref`/`dataset_file_ref` against the job owner, so a placeholder owner
    // would make every input inaccessible (and would also be the wrong authorization
    // boundary — verification must not read inputs the requester cannot).
    // The cancel receiver registered by the handler BEFORE this row could start, so a
    // stop racing the spawn is not lost (the same ordering `dispatch_ready` uses when
    // it registers at claim time). A missing registration means the row was already
    // closed; a never-signalled channel is the normal case.
    let cancel = crate::modules::jobs::runtime::runtime()
        .cancel_receiver(verification_id)
        .unwrap_or_else(|| watch::channel(false).1);
    let result = crate::modules::jobs::verify::run_analysis_for_verification(
        pool,
        spec.clone(),
        verification_id,
        acting_user,
        budget,
        cancel,
    )
    .await;
    if result.cancelled {
        // A human ended this. Say so on BOTH rows — the jobs row lands `stopped`
        // (never `failed`; the user did this on purpose) and the verification lands
        // `error` with the same plain reason, because a stopped re-run proves nothing
        // about reproducibility and must never be read as a verdict.
        let repo = crate::modules::jobs::repository::JobRepository::new(pool.clone());
        if let Err(e) = repo.mark_stopped(verification_id).await {
            tracing::error!(%verification_id, error = %e, "provenance verify: failed to mark the stopped run");
        }
        return Err("verification stopped".to_string());
    }
    if let Some(err) = result.error {
        return Err(err);
    }
    Ok(result
        .outputs
        .into_iter()
        .map(|o| (o.id, o.content_hash))
        .collect())
}

/// Parse the debug re-run fake: `{ "error": "…" }` → an error; else
/// `{ "outputs": [{"id","content_hash"}] }` → the canned signature.
#[cfg(debug_assertions)]
fn parse_fake(fake: &serde_json::Value) -> Result<Vec<(String, String)>, String> {
    if let Some(err) = fake.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    let outputs = fake
        .get("outputs")
        .and_then(|o| o.as_array())
        .ok_or_else(|| "malformed _verify_rerun_fake: expected `outputs` array".to_string())?;
    let mut sig = Vec::with_capacity(outputs.len());
    for o in outputs {
        let id = o.get("id").and_then(|v| v.as_str()).ok_or("fake output missing id")?;
        let hash = o
            .get("content_hash")
            .and_then(|v| v.as_str())
            .ok_or("fake output missing content_hash")?;
        sig.push((id.to_string(), hash.to_string()));
    }
    Ok(sig)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(debug_assertions)]
    #[test]
    fn parse_fake_reads_outputs_and_error() {
        let ok = serde_json::json!({ "outputs": [{ "id": "a", "content_hash": "sha256:1" }] });
        assert_eq!(parse_fake(&ok).unwrap(), vec![("a".to_string(), "sha256:1".to_string())]);
        let err = serde_json::json!({ "error": "boom" });
        assert_eq!(parse_fake(&err).unwrap_err(), "boom");
    }

    #[test]
    fn redact_strips_host_paths_but_keeps_semantics() {
        let msg = "hash output embedding: read /tmp/ziee-sandboxes/abc/outputs/x.zarr: No such file";
        let red = redact_host_paths(msg);
        assert!(!red.contains("/tmp/ziee-sandboxes"), "host path is redacted");
        assert!(red.contains("<path>"));
        assert!(red.contains("hash output embedding") && red.contains("No such file"), "semantics kept");
        // Single-component absolute paths are also redacted (not just >=2 slashes).
        assert_eq!(redact_host_paths("write /outputs failed"), "write <path> failed");
    }

    #[test]
    fn env_differs_only_when_both_known_and_unequal() {
        assert!(env_differs(&Some("a".into()), &Some("b".into())), "both known, unequal → changed");
        assert!(!env_differs(&Some("a".into()), &Some("a".into())), "equal → unchanged");
        assert!(!env_differs(&None, &Some("b".into())), "unknown recorded → not a divergence");
        assert!(!env_differs(&Some("a".into()), &None), "unknown rerun → not a divergence");
        assert!(!env_differs(&None, &None), "both unknown → not a divergence");
    }

    // The admission cap moved OUT of this module and into the one number that governs
    // every sandbox child on the box, so the unit test that pinned a private
    // `Semaphore::new(4)` was deleted rather than adapted: it can no longer fail for
    // the reason it existed. The behaviour it guarded is now asserted where the cap
    // actually lives — `verify_is_refused_when_the_job_pool_is_full` in
    // `tests/provenance/verify_test.rs`, against a real cap and a real INSERT.
}
