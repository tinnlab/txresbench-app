//! Re-run an analysis for provenance VERIFICATION (P4 ITEM-7/8).
//!
//! `run_analysis_for_verification` re-executes a recorded run's captured
//! `AnalysisSpec` via the SAME P3 compute path (`SandboxJobRunner` → the compute
//! backend → bwrap), collects its `/outputs` content-hash signature, and cleans
//! up — WITHOUT ingesting into P1's catalog or recording provenance (a
//! verification is ephemeral; it must not pollute the graph or the object store).
//! `provenance::verify` owns the comparison + persistence; this module owns the
//! headless re-execution + output identity. The output identity itself is P1's
//! single `workstore::object_store::content_hash_of_path` (streamed, bounded
//! memory) — NOT a local re-implementation — so the re-run signature can never
//! drift from the catalog's.

use std::path::Path;
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::sync::watch;
use uuid::Uuid;

use crate::modules::sandbox::outputs::{load_produced_outputs, ProducedOutput};
use crate::modules::workstore::object_store::content_hash_of_path;

use super::models::Job;
use super::runner::{JobRunner, SandboxJobRunner};

/// Grace for the stdout/stderr drain tasks to finish after the child exits.
const DRAIN_JOIN_GRACE: Duration = Duration::from_secs(5);

/// One re-run output's declared id + its content identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedOutput {
    pub id: String,
    pub content_hash: String,
}

/// The outcome of a verification re-run. `error` is `Some` when the re-run could
/// not complete (spawn failure, non-zero exit, timeout, unreadable outputs). The
/// message is safe to log; the orchestrator redacts host paths before persisting.
#[derive(Debug, Clone)]
pub struct VerifyRunResult {
    pub exit_code: i32,
    pub outputs: Vec<VerifiedOutput>,
    pub error: Option<String>,
    /// A HUMAN ended this run through `POST /jobs/{id}/stop`, as distinct from it
    /// failing. Carried as its own field rather than sniffed out of `error`, because
    /// the two must not read alike to the person who clicked the button: a run they
    /// stopped has to land `stopped`, not `failed`. (This is the same distinction
    /// `Outcome::Cancelled` draws in the scheduler's executor.)
    pub cancelled: bool,
}

impl VerifyRunResult {
    fn failed(msg: impl Into<String>) -> Self {
        Self { exit_code: -1, outputs: Vec::new(), error: Some(msg.into()), cancelled: false }
    }

    fn cancelled() -> Self {
        Self {
            exit_code: -1,
            outputs: Vec::new(),
            error: Some("verification stopped".to_string()),
            cancelled: true,
        }
    }
}

/// Which of the three racers finished first in [`wait_for_child_or_cancel`].
#[derive(Debug, PartialEq, Eq)]
pub enum Waited<T> {
    /// The child exited on its own.
    Finished(T),
    /// A human ended the run through `POST /jobs/{id}/stop`.
    Cancelled,
    /// The wall-clock budget expired.
    TimedOut,
}

/// Wait for the child, a cancel signal, or the budget — whichever lands first.
///
/// Extracted from the drive loop and made GENERIC over the child future purely so it
/// can be tested: the cancel arm is the only part of the stop path that a
/// `_verify_rerun_fake` integration test cannot reach (the fake short-circuits before
/// any child is spawned, and a real bwrap re-run needs a rootfs). Deleting the cancel
/// arm would therefore have left every test green while the Stop button reported
/// success and killed nothing — the precise failure this change exists to prevent —
/// so the race is asserted directly, over a plain future, in this module's tests.
///
/// Cancel is checked with `borrow_and_update` semantics via `wait_for`, so a signal
/// that arrived BEFORE this call (a stop racing the spawn) is still observed rather
/// than waited for forever.
pub async fn wait_for_child_or_cancel<F: std::future::Future>(
    child: F,
    budget: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Waited<F::Output> {
    let raced = tokio::time::timeout(budget, async {
        tokio::select! {
            r = child => Some(r),
            _ = cancel.wait_for(|c| *c) => None,
        }
    })
    .await;
    match raced {
        Ok(Some(out)) => Waited::Finished(out),
        Ok(None) => Waited::Cancelled,
        Err(_) => Waited::TimedOut,
    }
}

/// An IN-MEMORY analysis `Job` carrying the reconstructed re-run spec — the value the
/// sandbox runner reads to build the child. It is deliberately NOT the persisted row:
/// `provenance::verify` mints that one with `job_type = "verify"` (so the boot reconcile
/// never finalizes/ingests it as an analysis) and a PROJECT scope (so the project's owner
/// can see and stop it), while THIS value says `"analysis"` purely to select the analysis
/// backend. They share only the id, which is what ties the row to the workspace dir.
///
/// Nothing about this run is ever ingested/cataloged: this module owns its own drive
/// loop, which never touches the ingest sink or the catalog.
///
/// `owner_id` is the VERIFYING user, not a placeholder: `sandbox::inputs::
/// materialize_inputs` authorizes every `artifact_ref`/`dataset_file_ref` against the
/// job owner, so a `Uuid::nil()` owner made EVERY input inaccessible — a recorded run
/// with any input could never be re-run, and verify terminated `error` with
/// "input file … is not accessible to the job owner". Scoping the re-run to the
/// REQUESTER (who already passed `require_project_edit` on the project) is also the
/// correct authorization: verification must never read inputs the requester cannot.
fn verify_job(params: serde_json::Value, verify_id: Uuid, owner_id: Uuid) -> Job {
    Job {
        id: verify_id,
        owner_id,
        job_type: "analysis".to_string(),
        name: format!("verify-{verify_id}"),
        status: "running".to_string(),
        params,
        created_at: chrono::Utc::now(),
        started_at: None,
        finished_at: None,
        exit_code: None,
        error: None,
        pid: None,
        priority_class: "normal".to_string(),
        resource_class: "cpu-sandbox".to_string(),
        req_cpu: None,
        req_mem_bytes: None,
        run_id: None,
    }
}

/// Re-execute a recorded run's captured `AnalysisSpec` (`params`) headlessly and
/// return its `/outputs` content-hash signature. `max_wall_secs` is the verify
/// time budget the drive loop enforces on top of the sandbox's own caps. Never
/// ingests, never records. Verification only ever re-runs `analysis` jobs, so it
/// constructs the analysis backend directly (the same one the jobs dispatcher
/// selects for `job_type == "analysis"`) — routing through the stub-vs-analysis
/// dispatcher would be meaningless for a known-analysis re-run.
pub async fn run_analysis_for_verification(
    pool: &SqlitePool,
    params: serde_json::Value,
    verify_id: Uuid,
    owner_id: Uuid,
    max_wall_secs: u64,
    mut cancel: watch::Receiver<bool>,
) -> VerifyRunResult {
    // Same defect the conformance gate carries, same fix (see `jobs/conformance.rs`'s
    // module doc). The `jobs` row this id now DOES have (minted by `provenance::verify`
    // so the run is listable, stoppable and counted) does not retire this hold: the boot
    // pass snapshots `list_running()` BEFORE it sweeps, so a verification admitted after
    // that snapshot is absent from `live_ids` and would still be swept. The register is
    // consulted per candidate and is in-process, which is exactly the window the row
    // cannot cover. `is_stale_workspace` would otherwise classify BOTH of this id's
    // `<root>/<verify_id>` dirs as stale, and
    // `jobs::init` runs `reconcile_orphaned_running` (which can dispatch a verification)
    // and then `sweep_stale_run_dirs` IN THE SAME TASK. Without this hold a boot sweep
    // deletes the re-run's dirs out from under it — and because this path compares output
    // hashes, the result is not a clean failure but a FALSE MISMATCH: provenance would
    // report the run irreproducible when it is fine.
    //
    // ITEM-17 did not remove that hazard, it SPLIT it across two trees. `/inputs` is
    // still workspace scratch, and the outputs this path hashes now live in the run's
    // staging tree — which the boot sweep also reaches. ONE registration covers both,
    // because the two dirs share this run id; the register is consulted per candidate in
    // `sweep_stale_workspaces`, whichever root it was pointed at.
    //
    // Taken before the workspace can exist (registration happens-before the `mkdir`) and
    // released on drop, so a crashed re-run's dir is stale again and the next boot still
    // reclaims it.
    let _workspace_hold = crate::modules::jobs::scheduler::hold_live_workspace(verify_id);
    let job = verify_job(params, verify_id, owner_id);
    let registry = std::sync::Arc::new(
        crate::modules::sandbox::backend::local_bwrap::BackendRegistry::new(pool.clone()),
    );
    let runner = SandboxJobRunner::new(pool.clone(), registry);

    let mut spawned = match runner.spawn(&job).await {
        Ok(s) => s,
        Err(e) => return VerifyRunResult::failed(format!("verify re-run spawn failed: {e}")),
    };
    // Hold the sandbox guards for the child's whole life (cgroup scope / seccomp /
    // FIFO drain); both run dirs are removed after we hash the outputs.
    let _guards = spawned.guards.take();
    let workspace = spawned.workspace.take();
    // ITEM-17: the outputs this re-run hashes are in its staging dir, not its
    // workspace. Both are reclaimed by `cleanup` on every return path below.
    let staging = spawned.outputs_staging.take();

    // Drain stdout AND stderr in SEPARATE tasks so a child filling one pipe while
    // holding the other open can't deadlock (a single sequential reader would).
    let stdout = spawned.child.stdout.take();
    let stderr = spawned.child.stderr.take();
    let drain_out = tokio::spawn(async move {
        if let Some(o) = stdout {
            let mut sink = Vec::new();
            let _ = BufReader::new(o).read_to_end(&mut sink).await;
        }
    });
    let drain_err = tokio::spawn(async move {
        if let Some(e) = stderr {
            let mut sink = Vec::new();
            let _ = BufReader::new(e).read_to_end(&mut sink).await;
        }
    });

    // Enforce the verify wall-clock budget (on top of the sandbox's own RLIMIT_CPU
    // + the spawn-resolved timeout); kill the child if it overruns.
    let budget = Duration::from_secs(max_wall_secs.max(1));
    let waited = wait_for_child_or_cancel(spawned.child.wait(), budget, &mut cancel).await;
    let exit_code = match waited {
        Waited::Cancelled => {
            // Cancelled. Kill + reap the child and stop the drains, exactly as the
            // timeout arm does, so nothing is left behind.
            let _ = spawned.child.start_kill();
            let _ = spawned.child.wait().await;
            drain_out.abort();
            drain_err.abort();
            cleanup(&workspace, &staging).await;
            drop(_guards);
            return VerifyRunResult::cancelled();
        }
        Waited::Finished(Ok(status)) => status.code().unwrap_or(-1),
        Waited::Finished(Err(e)) => {
            // wait() failed: kill + reap the child and stop the drain tasks so
            // nothing is leaked (parity with the timeout path).
            let _ = spawned.child.start_kill();
            let _ = spawned.child.wait().await;
            drain_out.abort();
            drain_err.abort();
            cleanup(&workspace, &staging).await;
            drop(_guards);
            return VerifyRunResult::failed(format!("verify re-run wait failed: {e}"));
        }
        Waited::TimedOut => {
            let _ = spawned.child.start_kill();
            let _ = spawned.child.wait().await;
            drain_out.abort();
            drain_err.abort();
            cleanup(&workspace, &staging).await;
            drop(_guards);
            return VerifyRunResult::failed(format!(
                "verify re-run exceeded the {max_wall_secs}s time budget"
            ));
        }
    };
    let _ = tokio::time::timeout(DRAIN_JOIN_GRACE, async {
        let _ = drain_out.await;
        let _ = drain_err.await;
    })
    .await;

    if exit_code != 0 {
        cleanup(&workspace, &staging).await;
        drop(_guards);
        return VerifyRunResult {
            exit_code,
            outputs: Vec::new(),
            error: Some(format!("verify re-run exited with code {exit_code}")),
            cancelled: false,
        };
    }

    let Some(stg) = staging.as_ref() else {
        drop(_guards);
        return VerifyRunResult::failed("verify re-run produced no output staging dir");
    };
    let result = match hash_outputs(stg).await {
        Ok(outputs) => VerifyRunResult { exit_code, outputs, error: None, cancelled: false },
        Err(e) => VerifyRunResult::failed(e),
    };
    cleanup(&workspace, &staging).await;
    drop(_guards);
    result
}

/// Load the run's `/outputs/manifest.json` out of its STAGING dir (ITEM-17) + hash
/// every declared output using P1's single content-identity function.
async fn hash_outputs(staging: &Path) -> Result<Vec<VerifiedOutput>, String> {
    let produced: Vec<ProducedOutput> = load_produced_outputs(staging)
        .await
        .map_err(|e| format!("verify re-run outputs invalid: {e}"))?;
    let mut out = Vec::with_capacity(produced.len());
    for p in produced {
        let content_hash = content_hash_of_path(&p.host_path)
            .await
            .map_err(|e| format!("hash output {}: {e}", p.id))?;
        out.push(VerifiedOutput { id: p.id, content_hash });
    }
    Ok(out)
}

/// Reclaim BOTH of a verification re-run's dirs (ITEM-17). A verification ingests
/// nothing, so its staging has no consumer after the hash and goes on every return
/// path — including the failure/timeout ones.
async fn cleanup(workspace: &Option<std::path::PathBuf>, staging: &Option<std::path::PathBuf>) {
    if let Some(ws) = workspace {
        if let Err(e) = tokio::fs::remove_dir_all(ws).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error = %e, "verify re-run workspace cleanup failed");
            }
        }
    }
    if let Some(stg) = staging {
        crate::modules::sandbox::outputs::discard_staging(stg).await;
    }
}

#[cfg(test)]
mod tests {
    use super::{wait_for_child_or_cancel, Waited};
    use std::time::Duration;
    use tokio::sync::watch;

    use crate::modules::workstore::object_store::{content_hash_of_path, merkle_root, sha256_hex, ContentKey, MemberRef};
    use uuid::Uuid;

    // The three-way race the stop path depends on. Each arm is asserted separately,
    // because a mutation that deletes exactly one of them (most cheaply the CANCEL
    // arm) is invisible to every other test in the suite: the integration tests reach
    // this code through the `_verify_rerun_fake` seam, which returns before a child
    // exists.
    #[tokio::test]
    async fn the_child_wins_when_it_finishes_first() {
        let (_tx, mut rx) = watch::channel(false);
        let got = wait_for_child_or_cancel(
            async { 7u8 },
            Duration::from_secs(30),
            &mut rx,
        )
        .await;
        assert_eq!(got, Waited::Finished(7), "an exited child is not a cancel or a timeout");
    }

    #[tokio::test]
    async fn a_stop_beats_a_child_that_would_run_for_ever() {
        let (tx, mut rx) = watch::channel(false);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = tx.send(true);
        });
        let got = wait_for_child_or_cancel(
            std::future::pending::<u8>(),
            Duration::from_secs(30),
            &mut rx,
        )
        .await;
        assert_eq!(
            got,
            Waited::Cancelled,
            "THE REGRESSION: without the cancel arm this waits out the FULL budget —              the Stop button answers 200 and the sandbox child runs on"
        );
    }

    #[tokio::test]
    async fn a_stop_that_arrived_before_the_wait_is_still_seen() {
        // A stop racing the spawn: the handler registers the cancel BEFORE the run
        // starts, so the signal can already be set by the time the drive loop waits.
        // `wait_for` must observe the CURRENT value, not block for the next change.
        let (tx, mut rx) = watch::channel(false);
        tx.send(true).expect("set before the wait");
        let got = wait_for_child_or_cancel(
            std::future::pending::<u8>(),
            Duration::from_secs(30),
            &mut rx,
        )
        .await;
        assert_eq!(got, Waited::Cancelled, "an already-set signal is not missed");
    }

    #[tokio::test]
    async fn the_budget_still_expires_when_nobody_stops_it() {
        let (_tx, mut rx) = watch::channel(false);
        let got = wait_for_child_or_cancel(
            std::future::pending::<u8>(),
            Duration::from_millis(30),
            &mut rx,
        )
        .await;
        assert_eq!(
            got,
            Waited::TimedOut,
            "negative control: adding the cancel arm did not swallow the wall-clock budget"
        );
    }

    // TEST-5: the re-run output identity (P1's `content_hash_of_path`) — a single
    // file is its blob sha256:<hex>; a directory is sha256:<merkle_root> over its
    // sorted members (matching P1's store_output identity), computed via streaming.
    #[tokio::test]
    async fn content_hash_file_and_dir_match_p1_identity() {
        let tmp = std::env::temp_dir().join(format!("verify-hash-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&tmp).await.unwrap();

        let f = tmp.join("out.bin");
        tokio::fs::write(&f, b"embedding-bytes").await.unwrap();
        let got = content_hash_of_path(&f).await.unwrap();
        assert_eq!(got, format!("sha256:{}", sha256_hex(b"embedding-bytes")));

        let d = tmp.join("out.zarr");
        tokio::fs::create_dir_all(d.join("sub")).await.unwrap();
        tokio::fs::write(d.join("b.bin"), b"BB").await.unwrap();
        tokio::fs::write(d.join("sub").join("a.bin"), b"AA").await.unwrap();
        let refs = vec![
            MemberRef { path: "b.bin".into(), blob: ContentKey::from_hex(&sha256_hex(b"BB")), len: 2 },
            MemberRef { path: "sub/a.bin".into(), blob: ContentKey::from_hex(&sha256_hex(b"AA")), len: 2 },
        ];
        let expect = format!("sha256:{}", merkle_root(&refs));
        assert_eq!(content_hash_of_path(&d).await.unwrap(), expect);

        let _ = tokio::fs::remove_dir_all(&tmp).await;
    }
}
