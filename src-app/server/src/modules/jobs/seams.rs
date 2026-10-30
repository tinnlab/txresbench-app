//! Cross-branch integration seams: realtime sync + notifications.
//!
//! Both are owned by live8's `feat/project-management` (the concrete `SyncEntity`
//! enum + `publish`, and the `ziee_notification` kind registry) and are NOT in
//! this branch's base. So the jobs module emits through these trait seams with
//! **no-op defaults** this round; at merge the defaults are swapped for the real
//! implementations (add `SyncEntity::Job` + `publish(...)`; register
//! `job_completed`/`job_failed` `NOTIFICATION_KINDS` + insert a `NewNotification`).
//! Mirrors ziee-auth's `AuthSyncSink` / `NoopAuthSyncSink` seam idiom.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

use super::models::Job;
use crate::modules::sandbox::outputs::ProducedOutput;

/// What changed about a job's list-row (maps 1:1 to the sync `SyncAction` the
/// merge wires in).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobChange {
    Created,
    Updated,
}

/// Publish a job list-change to the OWNER's devices (owner-scoped). At merge this
/// becomes `publish(SyncEntity::Job, action, job_id, Audience::owner(owner_id),
/// origin)`.
pub trait JobSyncSink: Send + Sync {
    fn publish_job_changed(&self, owner_id: Uuid, change: JobChange, job_id: Uuid);
}

/// The REAL sink: a job list-change becomes a `SyncEntity::Job` frame addressed to
/// **everyone the job is visible to** — its owner plus every EDIT-holder on the
/// dataset/project it is scoped to (`JobRepository::visible_to_user_ids`, the
/// mirror of `list_visible_to`).
///
/// It used to address `Audience::owner(job.owner_id)` alone, which was exactly right
/// while `GET /jobs` was owner-scoped and became wrong the moment it stopped being:
/// a row you can list but are never told about is a row that sits stale until you
/// reload. Sight without notification is not sight. (`dataset::sync` reached the same
/// conclusion one layer up for the derived processing badge.)
///
/// The resolution needs a query and the seam signature is synchronous, so the emit is
/// spawned. That is the same fire-and-forget posture as the rest of this seam — these
/// are post-commit announcements of work that already happened, and a failed lookup
/// costs a live refresh, never the operation. It degrades to SILENCE (plus a warn),
/// not to an owner-addressed frame: the owner-only fallback this sentence used to
/// promise was itself the #167/#168 leak, because the "owner" it addressed is the job's
/// creator whether or not they are still in the account. See `publish_job_changed`.
///
/// `origin = None` on every emit, deliberately. Two of the three emit points are
/// DETACHED (the scheduler's claim→running transition and `finalize`), so there is no
/// originating connection to suppress; the third (`create_job`) is a handler, but the
/// seam signature carries no connection id and widening it would buy one avoided
/// refetch on the acting tab in exchange for a second way to get the suppression wrong.
/// `None` means every device — including the actor's — gets the frame, so `Jobs.store`
/// needs no local echo and cannot drift out of step with the server.
pub struct RealJobSyncSink {
    pool: SqlitePool,
}

impl RealJobSyncSink {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

impl JobSyncSink for RealJobSyncSink {
    fn publish_job_changed(&self, owner_id: Uuid, change: JobChange, job_id: Uuid) {
        let action = match change {
            JobChange::Created => crate::modules::sync::SyncAction::Create,
            JobChange::Updated => crate::modules::sync::SyncAction::Update,
        };
        let pool = self.pool.clone();
        tokio::spawn(async move {
            // #167 × #168: the resolver is now the SOLE authority on who is addressed.
            //
            // This used to keep the caller's `owner_id` in the owner slot and UNION the
            // resolver's answer into `others`, on the reasoning that "a lookup failure
            // can never be worse than the old behavior". That reasoning held only while
            // the old behavior was correct, and it was not: `owner_id` is the job's
            // CREATOR, a column no removal touches, so a member removed from the account
            // was still told — in real time, on every transition — about compute they
            // could no longer open. Trusting the argument was exactly the hole.
            //
            // So an unresolvable or EMPTY audience now emits nothing and warns, which is
            // what every other audience site in the tree does (`publish_dataset_change`,
            // `publish_artifact`, `publish_run_to_project`, `publish_account`); the
            // client's 60s sync re-check is the shared backstop. `owner_id` survives as
            // the log key — it is what makes the warn line searchable back to a call
            // site — and no longer as an address.
            match super::repository::JobRepository::visible_to_user_ids(&pool, job_id).await {
                Ok(Some((anchor, others))) => {
                    crate::modules::sync::fan_out_owner_scoped(
                        crate::modules::sync::SyncEntity::Job,
                        action,
                        job_id,
                        anchor,
                        &others,
                        crate::modules::sync::Actor::detached(),
                    );
                }
                Ok(None) => {
                    tracing::debug!(
                        %job_id, %owner_id,
                        "job sync: nobody may see this job; no frame emitted"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        %job_id, %owner_id, error = ?e,
                        "job sync: audience unresolved; connected devices will not \
                         live-refresh this row until their next refetch"
                    );
                }
            }
        });
    }
}

/// No-op default, retained for tests that must observe the emit points without a
/// registry. NOT installed in production — see `JobsModule::init`.
pub struct NoopJobSyncSink;

impl JobSyncSink for NoopJobSyncSink {
    fn publish_job_changed(&self, owner_id: Uuid, change: JobChange, job_id: Uuid) {
        tracing::debug!(%owner_id, ?change, %job_id, "job sync publish (noop seam)");
    }
}

/// Notify the owner when a job reaches a terminal state. At merge this becomes a
/// `NewNotification::new(owner_id, "job_completed"|"job_failed", …)` insert +
/// (optionally) a sync emit for a live toast.
pub trait JobNotifier: Send + Sync {
    fn notify_terminal(&self, owner_id: Uuid, job: &Job);
}

/// No-op default (this round).
pub struct NoopJobNotifier;

impl JobNotifier for NoopJobNotifier {
    fn notify_terminal(&self, owner_id: Uuid, job: &Job) {
        tracing::debug!(%owner_id, job_id = %job.id, status = %job.status, "job notify (noop seam)");
    }
}

// ---- process-wide seam holders ----
//
// The create route AND the scheduler/executor emit through the SAME installed
// sink/notifier, so the merge wires the real implementations once via
// `install_seams(...)`. Default to the no-op impls if never installed.

static SYNC: OnceLock<Arc<dyn JobSyncSink>> = OnceLock::new();
static NOTIFIER: OnceLock<Arc<dyn JobNotifier>> = OnceLock::new();

/// Install the process-wide sync sink + notifier (called once from
/// `JobsModule::init`). At merge, pass live8's real implementations here.
pub fn install_seams(sync: Arc<dyn JobSyncSink>, notifier: Arc<dyn JobNotifier>) {
    let _ = SYNC.set(sync);
    let _ = NOTIFIER.set(notifier);
}

// ─────────────────── artifact ingest + provenance seams (P3) ─────────────────

/// Whole-cgroup-subtree peak resource usage of a finished run (ITEM-25),
/// forwarded to the provenance recorder AND (T3 / G3) to the compute-meter seam.
///
/// Widened by T3 (ITEM-5): the teardown reading (a FINAL `read_metrics_at` after the
/// child exits) is captured here so the hand-off ALREADY threaded through
/// `finalize_analysis_with` carries it — no new argument. Integer units (usec / ms /
/// whole-seconds) keep the struct `Copy + Eq`; the emit converts to `f64` seconds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PeakMetrics {
    pub mem_peak_bytes: Option<i64>,
    pub pids_peak: Option<i64>,
    /// Cumulative CPU time of the run's cgroup subtree at child-exit (`cpu.stat
    /// usage_usec`), microseconds. `None` when no cgroup scope was readable.
    pub cpu_usage_usec: Option<i64>,
    /// Wall-clock run duration (executor-observed), milliseconds.
    pub wall_ms: Option<i64>,
    /// GPU-seconds consumed. `0`/`None` for a cpu-sandbox run (the only class the
    /// worker pool runs today); a future Gpu-class run fills it.
    pub gpu_secs: Option<i64>,
}

/// The hand-off to P1's working-store/catalog: ingest a finished analysis job's
/// `/outputs` artifacts (ITEM-27). Called ONLY on a successful (exit-0) analysis
/// run whose manifest already parsed. The no-op default logs; the installed
/// `WorkstoreIngestSink` calls P1's merged `workstore::ingest_run_outputs` (its
/// pool is baked in at install so the trait method needs none).
#[async_trait]
pub trait ArtifactIngestSink: Send + Sync {
    /// Ingest a finished run's outputs. Returns `Err(reason)` on a genuine ingest
    /// failure so the executor FAILS the job (rather than reporting a false
    /// `completed` while the outputs were silently lost — data-loss-masks-success).
    ///
    /// `staging_dir` is the run's OUTPUT STAGING dir (ITEM-17) — the dir holding
    /// `outputs/`, which is NOT the sandbox workspace. It is what the finalize
    /// passes and what `ingest_run_outputs` reads.
    async fn ingest_outputs(
        &self,
        job: &Job,
        outputs: &[ProducedOutput],
        staging_dir: &Path,
    ) -> Result<(), String>;
}

/// No-op default (used in tests + before install). Logs the emit point.
pub struct NoopArtifactIngestSink;

#[async_trait]
impl ArtifactIngestSink for NoopArtifactIngestSink {
    async fn ingest_outputs(
        &self,
        job: &Job,
        outputs: &[ProducedOutput],
        _staging_dir: &Path,
    ) -> Result<(), String> {
        tracing::debug!(job_id = %job.id, n = outputs.len(), "artifact ingest (noop seam)");
        Ok(())
    }
}

/// The REAL sink: hands the run's `/outputs` to P1's merged working-store ingest.
/// Resolves the run's SCOPE (a project OR a dataset — ITEM-23) and skips a job with
/// neither (nowhere to land the artifacts). The pool is baked in at construction
/// (installed once from `JobsModule::init`).
pub struct WorkstoreIngestSink {
    pool: SqlitePool,
}

impl WorkstoreIngestSink {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ArtifactIngestSink for WorkstoreIngestSink {
    async fn ingest_outputs(
        &self,
        job: &Job,
        outputs: &[ProducedOutput],
        staging_dir: &Path,
    ) -> Result<(), String> {
        // ITEM-68: a job carries NO scope column — resolve its tenancy scope (a
        // project (workbench) XOR a dataset (owner processing)) from the single-
        // source-of-truth `job_scope` table. PROPAGATE a genuine lookup error (via
        // `?`) instead of swallowing it: a swallowed error would silently downgrade
        // a scoped run to scope-LESS and DISCARD its outputs while reporting success
        // (data-loss-masks-success). A real lookup error therefore FAILS the ingest
        // so the executor fails the job (its outputs are then preserved for retry).
        let (project_id, dataset_id) =
            match super::repository::JobRepository::job_scope(&self.pool, job.id)
                .await
                .map_err(|e| format!("resolve job scope: {e}"))?
            {
                Some(scope) => scope.split(),
                None => (None, None),
            };
        if project_id.is_none() && dataset_id.is_none() {
            // Not an error: a scope-less job legitimately has nowhere to land
            // artifacts (guard defensively — the finalize path only calls this for
            // analysis jobs, whose scope a bare `Job` can't fully reveal).
            tracing::debug!(job_id = %job.id, "analysis job has no project/dataset scope; skipping artifact ingest");
            return Ok(());
        }
        // The run id lines up with the job id (DEC-G) unless P4 stamped one.
        let run_id = job.run_id.unwrap_or(job.id);
        let store = crate::modules::workstore::try_get_object_store()
            .ok_or_else(|| "object store not initialized".to_string())?;
        let rows = crate::modules::workstore::ingest::ingest_run_outputs(
            &self.pool,
            store.as_ref(),
            project_id,
            dataset_id,
            run_id,
            Some(job.owner_id),
            staging_dir,
        )
        .await
        .map_err(|e| format!("workstore ingest failed: {e}"))?;
        tracing::info!(
            job_id = %job.id, ?project_id, ?dataset_id, ingested = rows.len(), declared = outputs.len(),
            "analysis outputs ingested into the working store"
        );

        // artifact-model ITEM-18 / DEC-12 — the conformance gate, dispatched AFTER
        // ingest as a sandboxed verification job. This is the one call site: the gate
        // hangs off the SINK (where a run's outputs become catalog rows) rather than
        // off `ingest_run_outputs` itself, because what it gates is the ROWS — bound
        // back in as `artifact_ref` inputs and read out of the object store — and
        // because the ingest function is also the direct-seeding path a hundred tests
        // call, which must not each spawn a sandbox.
        //
        // Detached (fire-and-forget) on purpose: it decodes every byte of every
        // artifact, so awaiting it here would hold the run's dirs open for the
        // duration AND turn a non-conforming artifact into a failed RUN — but the run
        // succeeded; it is the data that is wrong. That is the brief-liveness window
        // DEC-12 accepts by name, and it is why the job MARKS the artifact failed
        // rather than merely logging.
        // `job.id` as well as `run_id`: the gate records its outcome (verified /
        // failed / NOT VERIFIED) as a `job_logs` line on THIS run, which is the
        // operator-visible surface that keeps an indeterminate result from being
        // silent. The two ids coincide by default but not by construction (DEC-G),
        // and only `job.id` is a valid `job_logs.job_id`.
        super::conformance::dispatch_after_ingest(
            self.pool.clone(),
            job.owner_id,
            job.id,
            run_id,
            &rows,
        );

        // ITEM-9 (FW-8 finalize hook): a dataset-scoped converter run may emit a
        // `dataset-metadata` output — the harvested obs/var summary — which lands in
        // `datasets.metadata` (JSONB) so the inspector reads the harvested summary.
        // The output file's bytes are already on disk under `<staging>/outputs`
        // (its `host_path` was canonicalized + confined by `load_produced_outputs`),
        // so we read them straight off the ProducedOutput. Non-fatal on a
        // missing/malformed file (the artifacts are already persisted — a bad summary
        // must not fail an otherwise-successful ingest); a genuine DB write failure
        // DOES fail the ingest (never silently drop a write).
        if let Some(ds_id) = dataset_id {
            if let Some(meta_out) = outputs.iter().find(|o| o.id == "dataset-metadata") {
                match tokio::fs::read(&meta_out.host_path).await {
                    Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                        Ok(value) => {
                            crate::modules::dataset::repository::DatasetRepository::new(
                                self.pool.clone(),
                            )
                            .set_metadata(ds_id, &value)
                            .await
                            .map_err(|e| format!("write dataset metadata: {e}"))?;
                            // §7 notify-and-refetch: a DETACHED finalize (`Actor::detached`
                            // — nobody acted, so nothing is suppressed), addressed to the
                            // DATASET's audience. This used to address
                            // `Audience::owner(job.owner_id)`: the JOB's owner, which is
                            // not the DATASET's owner whenever an `edit`-role sharee
                            // launched the run. The dataset's owner then never learned
                            // their inspector summary had been harvested, and no sharee
                            // learned it either.
                            crate::modules::dataset::sync::publish_dataset_change(
                                &self.pool,
                                ds_id,
                                crate::modules::sync::SyncAction::Update,
                                crate::modules::sync::Actor::detached(),
                            )
                            .await;
                            tracing::info!(job_id = %job.id, dataset_id = %ds_id, "harvested dataset metadata written to datasets.metadata");
                        }
                        Err(err) => tracing::warn!(
                            job_id = %job.id, dataset_id = %ds_id,
                            "dataset-metadata output is not valid JSON; skipping metadata write: {err}"
                        ),
                    },
                    Err(err) => tracing::warn!(
                        job_id = %job.id, dataset_id = %ds_id,
                        "read dataset-metadata output failed; skipping metadata write: {err}"
                    ),
                }
            }
        }
        Ok(())
    }
}

/// The P4 provenance hand-off: record the run node + used/generated edges
/// (ITEM-28). No-op THIS round (P4/live1 unmerged); wired at the provenance
/// merge. The single write site — P3 emits, P4 records (no double-write).
#[async_trait]
pub trait RunRecorder: Send + Sync {
    /// `workspace_root` is the per-job workspace the runner staged (`<root>/code/entry.*`
    /// holds the EXACT bytes that executed — resolved ONCE at spawn). The recorder hashes
    /// those staged bytes for provenance rather than re-resolving the live folder at
    /// finalize time (M4: a mid-run on-disk edit would otherwise make the recorded
    /// `code_sha256` a DIFFERENT script than the one that ran).
    async fn record_run(
        &self,
        job: &Job,
        outputs: &[ProducedOutput],
        exit_code: i32,
        peak: PeakMetrics,
        workspace_root: &std::path::Path,
    );
}

/// No-op default (this round).
pub struct NoopRunRecorder;

#[async_trait]
impl RunRecorder for NoopRunRecorder {
    async fn record_run(
        &self,
        job: &Job,
        outputs: &[ProducedOutput],
        exit_code: i32,
        _peak: PeakMetrics,
        _workspace_root: &std::path::Path,
    ) {
        tracing::debug!(job_id = %job.id, exit_code, n = outputs.len(), "run record (noop seam)");
    }
}

static INGEST: OnceLock<Arc<dyn ArtifactIngestSink>> = OnceLock::new();
static RECORDER: OnceLock<Arc<dyn RunRecorder>> = OnceLock::new();

/// Install the ingest sink + run recorder together. Retained as a thin wrapper
/// over the split installers so existing callers/tests keep working.
pub fn install_run_seams(ingest: Arc<dyn ArtifactIngestSink>, recorder: Arc<dyn RunRecorder>) {
    install_ingest_sink(ingest);
    install_recorder(recorder);
}

/// Install ONLY the artifact-ingest sink (P1's working-store ingest). Called from
/// `JobsModule::init`; leaves the `RECORDER` slot free so the downstream
/// `provenance` module (order 35) can install the REAL run recorder in its own
/// `init` (DAG cleanliness — jobs never imports provenance).
pub fn install_ingest_sink(ingest: Arc<dyn ArtifactIngestSink>) {
    let _ = INGEST.set(ingest);
}

/// Install ONLY the provenance run recorder. Called from `ProvenanceModule::init`
/// (P4). Idempotent — a second install is ignored (`OnceLock`).
pub fn install_recorder(recorder: Arc<dyn RunRecorder>) {
    let _ = RECORDER.set(recorder);
}

/// The installed ingest sink (no-op default).
pub fn ingest_sink() -> Arc<dyn ArtifactIngestSink> {
    INGEST
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopArtifactIngestSink))
}

/// The installed run recorder (no-op default).
pub fn run_recorder() -> Arc<dyn RunRecorder> {
    RECORDER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopRunRecorder))
}

// ───────────── compute-meter teardown seam (T3 / G3 / PROV-T3-3) ─────────────

/// One finished run's raw compute footprint — the teardown signal T3 EMITS and the
/// deferred T5 aggregates into account-keyed cpu/gpu-seconds (§9). Path-agnostic: the
/// worker pod and the desktop emit the identical shape (INV-1).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ComputeUsage {
    pub cpu_secs: f64,
    pub wall_secs: f64,
    pub gpu_secs: f64,
    pub ram_peak_bytes: Option<i64>,
    pub exit_code: i32,
}

impl ComputeUsage {
    /// Derive the usage from the run's final `PeakMetrics` teardown reading + exit code.
    pub fn from_peak(peak: PeakMetrics, exit_code: i32) -> Self {
        Self {
            cpu_secs: peak
                .cpu_usage_usec
                .map(|u| u as f64 / 1_000_000.0)
                .unwrap_or(0.0),
            wall_secs: peak.wall_ms.map(|m| m as f64 / 1_000.0).unwrap_or(0.0),
            gpu_secs: peak.gpu_secs.map(|g| g as f64).unwrap_or(0.0),
            ram_peak_bytes: peak.mem_peak_bytes,
            exit_code,
        }
    }
}

/// The G3 teardown-metrics seam: emit ONE compute-usage raw signal per finished job at
/// child-exit finalize. T3 places the emit POINT (the exactly-once-per-`job_id` hook only
/// the runner can place); the deferred T5 installs the real aggregator (§4.4). Mirrors
/// `install_ingest_sink`/`install_recorder`.
#[async_trait]
pub trait ComputeMeter: Send + Sync {
    /// Record a finished run's compute usage. `project_id` is the run's tenancy scope
    /// (resolved by the impl); the raw row is keyed by `job_id` and is idempotent
    /// (a boot re-finalize must NOT double-emit — INV-5).
    async fn record_usage(&self, job: &Job, usage: ComputeUsage);
}

/// No-op default (desktop + tests before install): records nothing (INV-5).
pub struct NoopComputeMeter;

#[async_trait]
impl ComputeMeter for NoopComputeMeter {
    async fn record_usage(&self, job: &Job, usage: ComputeUsage) {
        tracing::debug!(
            job_id = %job.id, cpu_secs = usage.cpu_secs, wall_secs = usage.wall_secs,
            "compute usage (noop meter seam)"
        );
    }
}

// TxResBench: the DbComputeMeter (cloud metering export) was REMOVED with the
// SaaS feature; the runner still emits through the ComputeMeter seam (Noop).

static COMPUTE_METER: OnceLock<Arc<dyn ComputeMeter>> = OnceLock::new();

/// Install the process-wide compute meter. Idempotent — a second install is
/// ignored (`OnceLock`).
pub fn install_compute_meter(meter: Arc<dyn ComputeMeter>) {
    let _ = COMPUTE_METER.set(meter);
}

/// The installed compute meter (no-op default — nothing recorded until installed, INV-5).
pub fn compute_meter() -> Arc<dyn ComputeMeter> {
    COMPUTE_METER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopComputeMeter))
}

// ───────────── dataset supporting-file integration-completion seam ─────────────

/// The completion hook for a dataset supporting-file INTEGRATE run (ITEM-11/20):
/// capture the integrate coverage summary + emit `sync:dataset` so the owner's
/// devices live-refresh the derived per-file status. Installed from
/// `DatasetModule::init` (its pool baked in) so the jobs module NEVER imports the
/// dataset module — mirrors the P4 `RunRecorder` seam. Called from
/// `runner::finalize_analysis_with` for an integrate job (a spec binding a
/// `dataset_axis_index` at slot `axis_index`); `success=false` + empty `outputs` on
/// a directly-failed integrate run. NOTE: per-file STATUS is derived from the job
/// row (`list_files`), so this hook is NOT needed for status — only for the coverage
/// summary + the live sync nudge.
#[async_trait]
pub trait IntegrationSink: Send + Sync {
    async fn on_integrate_finalized(&self, job: &Job, success: bool, outputs: &[ProducedOutput]);
}

/// No-op default (before install + in tests). Logs the emit point.
pub struct NoopIntegrationSink;

#[async_trait]
impl IntegrationSink for NoopIntegrationSink {
    async fn on_integrate_finalized(&self, job: &Job, success: bool, outputs: &[ProducedOutput]) {
        tracing::debug!(job_id = %job.id, success, n = outputs.len(), "integrate finalize (noop seam)");
    }
}

static INTEGRATION: OnceLock<Arc<dyn IntegrationSink>> = OnceLock::new();

/// Install the dataset integration-completion sink. Called once from
/// `DatasetModule::init` (order 20, before jobs at 30 — but the slot is read only at
/// runtime finalize, so ordering is not load-bearing). Idempotent (`OnceLock`).
pub fn install_integration_sink(sink: Arc<dyn IntegrationSink>) {
    let _ = INTEGRATION.set(sink);
}

/// The installed integration sink (no-op default).
pub fn integration_sink() -> Arc<dyn IntegrationSink> {
    INTEGRATION
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopIntegrationSink))
}

// ──────────────── the virtual-dataset creation seam (stage 2, the creator) ────────────────

/// **The creation path for a virtual dataset**: a successful run that emitted a
/// `dataset-alignment` artifact gets a `datasets` row plus one GATHERED artifact per fused
/// column, so the alignment becomes something the ordinary catalog can browse.
///
/// ## Why this is a sibling hook rather than a wider `ArtifactIngestSink`
///
/// The creator needs two things that meet at exactly ONE point in `finalize_analysis_with`:
///
///  * the run's artifacts must already be CATALOGED (it references them by id), i.e. it must
///    run *after* `ingest_outputs` returned `Ok`;
///  * it must read `<workspace_root>/inputs/inputs.json` — the record of which slot was
///    staged at which mount — i.e. it must run *before* `run_dirs_disposition` →
///    `RunDirs::Reclaim` removes the workspace.
///
/// Both bounds hold beside `record_run` in the ingest match's `Ok(())` arm, and nowhere
/// else. `ArtifactIngestSink::ingest_outputs` is handed only `staging_dir` and has no
/// `workspace_root`; widening that trait would change five implementations (four here plus
/// `scheduler`'s) to hand ONE caller a value the call site already holds.
///
/// Installed from `WorkstoreModule::init` with its pool baked in, exactly like
/// [`IntegrationSink`], so the jobs module never imports the workstore's creator.
///
/// **Fire-and-forget by contract**: this runs after the outputs are safely cataloged, so a
/// creator failure must not fail an otherwise-successful run — it is logged, loudly and by
/// name, and the run stays `completed`. The alignment artifact itself is intact; what is
/// missing is the convenience row over it.
#[async_trait]
pub trait VirtualDatasetSink: Send + Sync {
    async fn on_run_finalized(&self, job: &Job, workspace_root: &Path);
}

/// No-op default (before install + in tests). Logs the emit point.
pub struct NoopVirtualDatasetSink;

#[async_trait]
impl VirtualDatasetSink for NoopVirtualDatasetSink {
    async fn on_run_finalized(&self, job: &Job, workspace_root: &Path) {
        tracing::debug!(
            job_id = %job.id, workspace = %workspace_root.display(),
            "virtual-dataset creation (noop seam)"
        );
    }
}

static VIRTUAL_DATASET: OnceLock<Arc<dyn VirtualDatasetSink>> = OnceLock::new();

/// Install the virtual-dataset creator. Called once from `WorkstoreModule::init`.
/// Idempotent (`OnceLock`).
pub fn install_virtual_dataset_sink(sink: Arc<dyn VirtualDatasetSink>) {
    let _ = VIRTUAL_DATASET.set(sink);
}

/// The installed virtual-dataset creator (no-op default).
pub fn virtual_dataset_sink() -> Arc<dyn VirtualDatasetSink> {
    VIRTUAL_DATASET
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopVirtualDatasetSink))
}

// ──────────────── draftable-entity freeze-completion seam (DEC-2 final) ────────────────

/// The draftable-entity freeze-completion hook (draftable-entity DEC-2 final: async
/// job-dependency auto-freeze). Called from [`super::repository::JobRepository::finish_in_tx`]
/// inside a just-COMPLETED job's transaction, immediately BEFORE its dependents are
/// unblocked. No-ops unless the completed job is a draft-freeze producer.
///
/// For a freeze job it resolves the minted immutable artifact, stamps its draft
/// `frozen` (+ `frozen_artifact_id`), and substitutes `draft_ref`→`artifact_ref` into
/// every dependent consumer's PERSISTED `params` — so once unblocked the consumer
/// dispatches with a pinned artifact (the runner's `assert_no_unresolved_draft_refs`
/// never trips), and its provenance + re-run spec see the frozen artifact, never the
/// volatile `draft_ref` (INV-4). The params substitution runs ON `conn`, so it is
/// atomic with — and strictly precedes — the `blocked`→`queued` flip.
///
/// Returns the draft ids it stamped `frozen`: a POST-COMMIT obligation the caller
/// discharges via [`Self::emit_frozen`] (the detached `Draft/Update` sync — INV-6),
/// because a rolled-back completion transaction must not announce a freeze. Installed
/// from `DraftsModule::init` with its pool baked in, so the jobs module NEVER imports
/// the drafts module (mirrors [`IntegrationSink`] / [`VirtualDatasetSink`]).
#[async_trait]
pub trait FreezeCompletionSink: Send + Sync {
    /// In-transaction: no-op unless `completed_job_id` is a freeze producer. Returns
    /// the frozen draft ids (for the caller's post-commit emit). `Err` propagates a
    /// genuine DB failure exactly as `unblock_dependents` does (aborting the completion
    /// transaction); a "not a freeze job" / "producer minted no artifact" case returns
    /// `Ok` with no draft stamped (the consumer then fails cleanly at staging rather
    /// than the freeze job being stranded).
    async fn on_freeze_completed_in_tx(
        &self,
        conn: &mut SqliteConnection,
        completed_job_id: Uuid,
    ) -> Result<Vec<Uuid>, String>;

    /// In-transaction: substitute each ALREADY-`completed` freeze dep's minted artifact
    /// into a newly-created consumer's `params` (`draft_ref`→`artifact_ref`), returning
    /// the possibly-updated params. Called from
    /// [`super::repository::JobRepository::create_with_deps_in_conn`] for the deps a
    /// consumer was born depending on that had ALREADY completed — the create-after-
    /// complete race (draftable-entity DEC-2): such a freeze's completion hook ran before
    /// this consumer's dependency edge existed and so found no dependent to pin. A no-op
    /// (params returned unchanged) for deps that are not freeze producers. `Err`
    /// propagates a genuine DB failure (aborting the create transaction).
    async fn substitute_completed_freeze_deps_in_tx(
        &self,
        conn: &mut SqliteConnection,
        params: &serde_json::Value,
        completed_dep_ids: &[Uuid],
    ) -> Result<serde_json::Value, String>;

    /// Post-commit: emit the detached `Draft/Update` sync for each draft the hook
    /// stamped frozen (INV-6). Best-effort — a failed emit costs a live refresh, never
    /// the (already-durable) freeze.
    async fn emit_frozen(&self, draft_ids: &[Uuid]);
}

/// No-op default (before install + in tests). A completion that is not a freeze — every
/// non-draftable job — flows through this inert impl.
pub struct NoopFreezeCompletionSink;

#[async_trait]
impl FreezeCompletionSink for NoopFreezeCompletionSink {
    async fn on_freeze_completed_in_tx(
        &self,
        _conn: &mut SqliteConnection,
        completed_job_id: Uuid,
    ) -> Result<Vec<Uuid>, String> {
        tracing::trace!(%completed_job_id, "freeze completion (noop seam)");
        Ok(Vec::new())
    }

    async fn substitute_completed_freeze_deps_in_tx(
        &self,
        _conn: &mut SqliteConnection,
        params: &serde_json::Value,
        _completed_dep_ids: &[Uuid],
    ) -> Result<serde_json::Value, String> {
        Ok(params.clone())
    }

    async fn emit_frozen(&self, _draft_ids: &[Uuid]) {}
}

static FREEZE_COMPLETION: OnceLock<Arc<dyn FreezeCompletionSink>> = OnceLock::new();

/// Install the draftable freeze-completion hook. Called once from `DraftsModule::init`
/// (its pool baked in). Idempotent (`OnceLock`).
pub fn install_freeze_completion_sink(sink: Arc<dyn FreezeCompletionSink>) {
    let _ = FREEZE_COMPLETION.set(sink);
}

/// The installed freeze-completion hook (no-op default).
pub fn freeze_completion_sink() -> Arc<dyn FreezeCompletionSink> {
    FREEZE_COMPLETION
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopFreezeCompletionSink))
}

/// Whether a finished job's outputs should be handed to the ingest sink at all —
/// i.e. it is an ANALYSIS job (only analysis runs declare an `/outputs` manifest).
/// The run's TENANCY SCOPE (project vs dataset vs none — ITEM-68) is resolved
/// authoritatively inside the sink from the `job_scope` table, not here: a bare
/// `Job` carries NO scope column, so a pure pre-filter can't tell a scoped run
/// from a scope-less one. The sink no-ops on a genuinely scope-less job. Pure +
/// unit-testable.
pub fn should_ingest(job: &Job) -> bool {
    job.job_type == "analysis"
}

/// The installed sync sink (no-op default).
pub fn sync_sink() -> Arc<dyn JobSyncSink> {
    SYNC.get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopJobSyncSink))
}

/// The installed notifier (no-op default).
pub fn notifier() -> Arc<dyn JobNotifier> {
    NOTIFIER
        .get()
        .cloned()
        .unwrap_or_else(|| Arc::new(NoopJobNotifier))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::Utc;

    use super::*;

    // TEST-5 (unit leg, G3 / PROV-T3-3): the teardown reading → ComputeUsage conversion.
    // cpu.stat usage_usec → seconds, wall ms → seconds, gpu whole-seconds passthrough;
    // a run with no cgroup scope (all None) yields a zero-usage signal (cpu_secs=0), which
    // is what a boot re-finalize (PeakMetrics::default) emits.
    #[test]
    fn compute_usage_from_peak_converts_units() {
        let peak = PeakMetrics {
            mem_peak_bytes: Some(2048),
            pids_peak: Some(3),
            cpu_usage_usec: Some(2_500_000), // 2.5 CPU-seconds
            wall_ms: Some(1_250),            // 1.25 wall-seconds
            gpu_secs: Some(0),
        };
        let u = ComputeUsage::from_peak(peak, 0);
        assert_eq!(u.cpu_secs, 2.5);
        assert_eq!(u.wall_secs, 1.25);
        assert_eq!(u.gpu_secs, 0.0);
        assert_eq!(u.ram_peak_bytes, Some(2048));
        assert_eq!(u.exit_code, 0);

        // A defaulted teardown (no cgroup scope / boot re-finalize) → zero usage, carrying
        // only the exit code. INV-5: the NoopComputeMeter records nothing regardless.
        let z = ComputeUsage::from_peak(PeakMetrics::default(), 1);
        assert_eq!(z.cpu_secs, 0.0);
        assert_eq!(z.wall_secs, 0.0);
        assert_eq!(z.ram_peak_bytes, None);
        assert_eq!(z.exit_code, 1);
    }

    // TEST-3 [acceptance] [invariant: INV-5] — the cpu_secs unit derivation the account-keyed
    // compute_meter row records: cgroup cpu.stat usage_usec (µs) → cpu_secs (s) is `/ 1e6`, and
    // gpu_secs is best-effort, defaulting to 0.0 for the cpu-sandbox class (the only pool class
    // today). A wrong divisor (ms vs µs) would mis-bill B1's core-hours by 1000×.
    #[test]
    fn t5_cpu_secs_derivation_is_usec_over_1e6() {
        // 1_000_000 µs == exactly 1.0 CPU-second.
        let one = ComputeUsage::from_peak(
            PeakMetrics {
                cpu_usage_usec: Some(1_000_000),
                ..PeakMetrics::default()
            },
            0,
        );
        assert_eq!(one.cpu_secs, 1.0, "1e6 µs == 1 s (the /1_000_000 divisor)");
        assert_eq!(one.gpu_secs, 0.0, "gpu_secs defaults to 0 for cpu-sandbox");

        // A fractional reading survives the division (no integer truncation).
        let frac = ComputeUsage::from_peak(
            PeakMetrics {
                cpu_usage_usec: Some(3_500_000),
                gpu_secs: Some(7),
                ..PeakMetrics::default()
            },
            0,
        );
        assert_eq!(frac.cpu_secs, 3.5, "3_500_000 µs == 3.5 s");
        assert_eq!(
            frac.gpu_secs, 7.0,
            "gpu_secs carried from PeakMetrics when present"
        );

        // No cgroup reading (desktop / boot re-finalize) → zero cpu_secs, not a panic.
        let none = ComputeUsage::from_peak(PeakMetrics::default(), 0);
        assert_eq!(none.cpu_secs, 0.0);
    }

    fn sample_job(status: &str) -> Job {
        Job {
            id: Uuid::new_v4(),
            owner_id: Uuid::new_v4(),
            job_type: "stub".into(),
            name: "t".into(),
            status: status.into(),
            params: serde_json::json!({}),
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            error: None,
            pid: None,
            priority_class: "normal".into(),
            resource_class: "cpu-sandbox".into(),
            req_cpu: None,
            req_mem_bytes: None,
            run_id: None,
        }
    }

    // TEST-6: a capturing JobSyncSink records publish_job_changed calls.
    #[derive(Default)]
    struct CapturingSync {
        calls: Mutex<Vec<(Uuid, JobChange, Uuid)>>,
    }
    impl JobSyncSink for CapturingSync {
        fn publish_job_changed(&self, owner_id: Uuid, change: JobChange, job_id: Uuid) {
            self.calls.lock().unwrap().push((owner_id, change, job_id));
        }
    }

    #[test]
    fn sync_sink_records_change() {
        let sink = CapturingSync::default();
        let owner = Uuid::new_v4();
        let job = Uuid::new_v4();
        sink.publish_job_changed(owner, JobChange::Created, job);
        sink.publish_job_changed(owner, JobChange::Updated, job);
        let calls = sink.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], (owner, JobChange::Created, job));
        assert_eq!(calls[1].1, JobChange::Updated);
    }

    // TEST-7: a capturing JobNotifier fires on completed AND failed terminals.
    #[derive(Default)]
    struct CapturingNotifier {
        seen: Mutex<Vec<String>>,
    }
    impl JobNotifier for CapturingNotifier {
        fn notify_terminal(&self, _owner_id: Uuid, job: &Job) {
            self.seen.lock().unwrap().push(job.status.clone());
        }
    }

    #[test]
    fn notifier_fires_on_terminal() {
        let n = CapturingNotifier::default();
        n.notify_terminal(Uuid::new_v4(), &sample_job("completed"));
        n.notify_terminal(Uuid::new_v4(), &sample_job("failed"));
        let seen = n.seen.lock().unwrap();
        assert_eq!(*seen, vec!["completed".to_string(), "failed".to_string()]);
    }

    // The no-op defaults must not panic.
    #[test]
    fn noop_defaults_are_inert() {
        NoopJobSyncSink.publish_job_changed(Uuid::new_v4(), JobChange::Created, Uuid::new_v4());
        NoopJobNotifier.notify_terminal(Uuid::new_v4(), &sample_job("completed"));
    }

    fn produced(id: &str) -> ProducedOutput {
        ProducedOutput {
            id: id.into(),
            datatype: "embedding".into(),
            rel_path: format!("{id}.zarr"),
            layout: "zarr".into(),
            role: "primary".into(),
            label: None,
            meta: serde_json::Value::Null,
            hidden: false,
            host_path: std::path::PathBuf::from(format!("/ws/outputs/{id}.zarr")),
        }
    }

    // TEST-17: a capturing ingest sink receives the parsed outputs; the no-op is
    // inert; should_ingest keys only on job_type=="analysis" (scope is resolved in
    // the sink from `job_scope`, ITEM-68 — a bare Job carries no scope column).
    #[derive(Default)]
    struct CapturingIngest {
        seen: std::sync::Mutex<Vec<String>>,
    }
    #[async_trait]
    impl ArtifactIngestSink for CapturingIngest {
        async fn ingest_outputs(
            &self,
            _job: &Job,
            outputs: &[ProducedOutput],
            _staging_dir: &Path,
        ) -> Result<(), String> {
            self.seen
                .lock()
                .unwrap()
                .extend(outputs.iter().map(|o| o.id.clone()));
            Ok(())
        }
    }

    #[tokio::test]
    async fn ingest_sink_receives_parsed_outputs_and_gate() {
        // should_ingest gates ONLY on job_type=="analysis" (the only type that
        // declares an /outputs manifest). The run's project/dataset SCOPE is resolved
        // in the sink from `job_scope` (ITEM-68) — a bare Job carries no scope column
        // — so should_ingest never keys on scope.
        let mut job = sample_job("completed"); // job_type "stub"
        assert!(!should_ingest(&job), "non-analysis job → skip ingest");
        job.job_type = "analysis".into();
        assert!(
            should_ingest(&job),
            "analysis job → ingest (scope resolved in the sink)"
        );

        // A capturing sink records the parsed outputs (no DB needed).
        let sink = CapturingIngest::default();
        let outs = vec![produced("a"), produced("b")];
        sink.ingest_outputs(&job, &outs, Path::new("/ws"))
            .await
            .unwrap();
        assert_eq!(
            *sink.seen.lock().unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );

        // The no-op default is inert + Ok.
        NoopArtifactIngestSink
            .ingest_outputs(&job, &outs, Path::new("/ws"))
            .await
            .unwrap();
    }

    // TEST-18: a capturing RunRecorder receives (job, outputs, exit, peak); the
    // no-op default does not panic.
    #[derive(Default)]
    struct CapturingRecorder {
        seen: std::sync::Mutex<Vec<(i32, usize)>>,
    }
    #[async_trait]
    impl RunRecorder for CapturingRecorder {
        async fn record_run(
            &self,
            _job: &Job,
            outputs: &[ProducedOutput],
            exit_code: i32,
            _peak: PeakMetrics,
            _workspace_root: &std::path::Path,
        ) {
            self.seen.lock().unwrap().push((exit_code, outputs.len()));
        }
    }

    #[tokio::test]
    async fn run_recorder_captures_and_noop_inert() {
        let rec = CapturingRecorder::default();
        let job = sample_job("completed");
        let outs = vec![produced("x")];
        let peak = PeakMetrics {
            mem_peak_bytes: Some(1024),
            pids_peak: Some(4),
            ..Default::default()
        };
        rec.record_run(&job, &outs, 0, peak, Path::new("/ws")).await;
        assert_eq!(*rec.seen.lock().unwrap(), vec![(0, 1)]);

        NoopRunRecorder
            .record_run(&job, &outs, 1, PeakMetrics::default(), Path::new("/ws"))
            .await;
    }
}
