//! The class-aware fair-share scheduler loop + per-job executor.
//!
//! The loop (spawned once from `JobsModule::init`, guarded by an `AtomicBool` so
//! only one ever runs) reads the admin cap + reserved-interactive slots at use
//! and, while `running < cap`, claims the next queued job by fair-share (owner
//! running-count, class priority, created_at), honoring the reserved-interactive
//! admission gate (batch is held back so it never head-of-line-blocks a
//! just-arrived interactive re-run — DEC-B). The executor drives the runner's
//! child: captures logs, samples CPU/RSS (cgroup subtree when present, else
//! single-pid), waits for exit or cancel, ingests `/outputs` for an analysis job,
//! persists the terminal state, and emits the sync + notification seams.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;
use tokio::time::interval;
use uuid::Uuid;
use txresbench_core::AppError;

use super::models::{Job, JobStatus};
use super::repository::JobRepository;
use super::runner::JobRunner;
use super::runtime::{runtime, CgroupSampler, ProcSampler};
use super::seams::{self, ArtifactIngestSink, JobChange, PeakMetrics, RunRecorder};
use super::settings::JobSettingsRepository;
use super::sse::{JobStatusFrame, SSEJobEvent};

/// Anti-double-spawn guard: only one scheduler loop ever runs **per process**.
///
/// T4 / INV-6 / ITEM-5: this is a WITHIN-process guard (a static `AtomicBool`),
/// and that is ALL it ever was — it never bounded claiming across processes. In
/// worker mode N pods are N processes, each with its own copy of this static, so
/// N loops claim concurrently and that is now INTENDED, not guarded against: the
/// cross-process safety is the DB-level cap-folded claim + SKIP-LOCKED
/// (INV-1/INV-2), not this flag. The single-INSTANCE *assumption* (one scheduler
/// per database) that the old `dispatch_ready` count-then-claim relied on is what
/// T4 drops; the within-process anti-double-spawn use of the flag stays (one loop
/// per process is still correct, and single-box `serve` is unchanged).
static SCHEDULER_ACTIVE: AtomicBool = AtomicBool::new(false);

/// The scheduler timing tunables as a named `Limits`-style struct (mirrors
/// `code_sandbox`'s resource-limits posture) — NOT inline magic numbers.
///
/// T4 (§6 / DEC-3) introduced the reaper/heartbeat SAFETY intervals here; #56
/// PROMOTED all of them — plus the two formerly-inline dispatch/metric tick
/// literals — onto the admin-editable `job_settings` singleton. The scheduler
/// loops now read them at use via `JobSettingsRepository::scheduler_limits()`
/// (const-default fallback on a DB error, byte-identical when unset — INV-5),
/// so `ReaperLimits::default()` is the process-start / DB-error FALLBACK, not the
/// only source. The one correctness knob (`stale_threshold`) is guarded
/// `>= 3 × heartbeat` at the settings layer so a live worker is never reclaimed.
#[derive(Debug, Clone, Copy)]
pub struct ReaperLimits {
    /// How often each worker refreshes its own rows' `claim_heartbeat` (apalis
    /// ~10s). The stale threshold is a generous multiple of this so a live worker
    /// is never reclaimed.
    pub heartbeat: Duration,
    /// How often the (single-leader) reaper sweep ticks (Oban-Lifeline; ≈ stale/3).
    pub reaper_tick: Duration,
    /// A `running` row whose `claim_heartbeat` is older than this is reclaimed —
    /// a generous multiple of `heartbeat` (miss ~4-5 beats) so a slow-but-live
    /// worker is safe (DEC-8, TEST-5 negative control).
    pub stale_threshold: Duration,
    /// Discard-at-max: a row reclaimed this many times is `failed`, not re-queued
    /// (poison-job guard, DEC-9).
    pub max_reclaims: i32,
    /// Bounded reclaim/discard batch size per sweep (§4 — never an unbounded UPDATE).
    pub reclaim_batch: i64,
    /// How often the dispatch (claim) loop wakes to claim queued jobs (#56; was the
    /// inline `interval(from_millis(500))`).
    pub dispatch_tick: Duration,
    /// How often a running job's CPU/RSS is measured during a run (#56; was the
    /// inline `interval(from_secs(1))`). Read once per job when execution begins.
    pub metric_tick: Duration,
}

impl Default for ReaperLimits {
    fn default() -> Self {
        Self {
            heartbeat: Duration::from_secs(10),
            reaper_tick: Duration::from_secs(15),
            stale_threshold: Duration::from_secs(45),
            max_reclaims: 5,
            reclaim_batch: 100,
            dispatch_tick: Duration::from_millis(500),
            metric_tick: Duration::from_secs(1),
        }
    }
}

/// This worker's identity for `claimed_by` (DEC-4): the pod name via `HOSTNAME`
/// (k8s downward API), ALWAYS suffixed with a fresh per-PROCESS UUID.
///
/// The UUID suffix is not cosmetic — it is what makes the reaper's liveness
/// premise hold. `claimed_by` must be unique PER PROCESS so that (a) two processes
/// that happen to share a HOSTNAME (multi-process on one host, a shared container
/// name) never collide, and (b) a process that restarts IN PLACE gets a NEW id, so
/// the DEAD process's orphaned running rows are heartbeated by NOBODY, go stale,
/// and are reclaimed by the reaper. A bare stable HOSTNAME would let the restarted
/// process keep heartbeating its predecessor's rows and defeat stale-detection.
/// The HOSTNAME prefix is kept only for human-readable log/debug attribution.
pub fn worker_id() -> String {
    let host = std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| "worker".to_string());
    format!("{host}-{}", Uuid::new_v4())
}

/// Set by `run_worker` before module init: a `txresbench worker` pod ALWAYS runs the
/// scheduler loop (G2 / DEC-3), regardless of the `TXR_SCHEDULER_ENABLED` flag.
static WORKER_MODE: AtomicBool = AtomicBool::new(false);

/// Mark this process as a `txresbench worker` (called from `run_worker` before boot, so
/// `JobsModule::init` sees it). The SaaS API pod never calls this.
pub fn set_worker_mode() {
    WORKER_MODE.store(true, Ordering::SeqCst);
}

/// Whether this process was booted in `worker` mode.
pub fn is_worker_mode() -> bool {
    WORKER_MODE.load(Ordering::SeqCst)
}

/// Whether the `TXR_SCHEDULER_ENABLED` flag admits the scheduler loop on a `serve` boot.
/// Default ON (single-box/desktop is byte-identical, INV-4); the SaaS API (`serve`) pod sets
/// it to a false-y value (`0`/`false`/`no`/`off`) to run ENQUEUE-ONLY (G2). Pure —
/// unit-testable, so the flag's meaning is pinned without a live boot.
pub fn scheduler_flag_enabled(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(v) => !matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
    }
}

/// The G2 gate (PROV-T3-2): does THIS process claim + run jobs? A `worker` pod ALWAYS does;
/// a `serve` process does only when the flag admits it (default ON). The SaaS API pod runs
/// `serve` with the flag OFF → it enqueues but NEVER claims, so workers are the ONLY class of
/// claimer (the precondition T4's cap-in-claim depends on). The process-local
/// `SCHEDULER_ACTIVE` guard is unchanged — it bounds double-spawn WITHIN one process; the
/// cross-process double-CLAIM safety is T4's DB-level concern, not T3's.
pub fn scheduler_should_spawn() -> bool {
    is_worker_mode()
        || scheduler_flag_enabled(std::env::var("TXR_SCHEDULER_ENABLED").ok().as_deref())
}

/// Owns the shared handles the loop + executors need.
pub struct Scheduler {
    pub pool: SqlitePool,
    pub runner: Arc<dyn JobRunner>,
    /// This process's worker identity, stamped into `claimed_by` at claim time
    /// and used by the heartbeat to refresh its OWN rows (T4 / DEC-4).
    pub worker_id: String,
    // #56: the reaper/heartbeat/dispatch/metric timing tunables are no longer held on
    // the Scheduler — they are read-at-use from `job_settings` in each loop (see
    // `JobSettingsRepository::scheduler_limits`), with `ReaperLimits::default()` as the
    // DB-error/unset fallback.
}

/// Whether a `batch` job may be admitted this tick: only if the running batch
/// count is below the non-reserved pool, OR no interactive job is queued (then
/// batch may borrow the reserved slots — no idle-capacity waste). Pure +
/// unit-testable (DEC-B). `cap`/`reserved`/`running_batch` are ≥ 0.
///
/// SCOPE (DEC-B / ITEM-19): the reservation holds back ONLY `batch` — `normal`
/// fills the shared pool freely. So the reserved slots defend interactive against
/// a *batch* burst (the AI-agent-fires-50-jobs case), NOT against `normal` load;
/// a pool full of `normal` jobs can still make interactive wait. This is the
/// deliberate 1-box policy, not a bug — there is no preemption.
pub fn batch_admitted(
    cap: i64,
    reserved: i64,
    running_batch: i64,
    interactive_queued: bool,
) -> bool {
    running_batch < (cap - reserved).max(0) || !interactive_queued
}

/// The backend's CPU arch (ITEM-26 / DEC-29/30) — its compile-target arch, which
/// is also the arch of its single embedded rootfs (one image per build arch). This
/// is `cfg!(target_arch)` surfaced as a runtime `&'static str` (`std::env::consts::
/// ARCH` = "x86_64" / "aarch64" / …), so the arch gate reads the same value the
/// build embedded.
pub fn backend_arch() -> &'static str {
    std::env::consts::ARCH
}

/// The arch-compatibility gate (ITEM-26 / DEC-29, defense-in-depth). An analysis
/// whose declared `arch` list is NON-EMPTY and EXCLUDES the backend arch is
/// REFUSED with a clear reason ("requires an x86_64 backend"); an empty list ("all
/// arches", the default) or a list that includes the backend arch passes. **No
/// emulation** — an x86-only tool is never run on aarch64. Pure — unit-testable
/// (mirrors `batch_admitted`). The FE picker uses the same reason to disable (not
/// hide) the analysis; this is the server-side backstop.
pub fn arch_compatible(spec_arch: &[String], backend_arch: &str) -> Result<(), String> {
    if spec_arch.is_empty() || spec_arch.iter().any(|a| a == backend_arch) {
        return Ok(());
    }
    Err(format!("requires an {} backend", spec_arch.join(" or ")))
}

impl Scheduler {
    /// Spawn the background loop (idempotent — a second call is a no-op).
    ///
    /// T4: alongside the dispatch loop, spawns two multi-worker tasks — the
    /// heartbeat (refreshes THIS worker's `claim_heartbeat`, INV-3) and the
    /// single-leader stale-claim reaper (reclaims a dead worker's rows, INV-3/4).
    /// Both are harmless on single-box `serve` (one worker heartbeats itself; the
    /// reaper finds nothing stale), so the desktop path is unregressed.
    pub fn spawn(self: Arc<Self>) {
        if SCHEDULER_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        tracing::info!(worker_id = %self.worker_id, "jobs scheduler started");
        // --- the dispatch loop (claims + runs queued jobs) ---
        // #56: the tick cadence is read-at-use from `job_settings` each iteration (a
        // `sleep`-based loop replacing the fixed `interval`), mirroring `dispatch_ready`'s
        // existing per-iteration `caps()` re-read — an admin PUT takes effect next
        // iteration without a restart. Byte-identical when unset (default 500ms, INV-5).
        let dispatch_self = self.clone();
        tokio::spawn(async move {
            let settings = JobSettingsRepository::new(dispatch_self.pool.clone());
            loop {
                if !SCHEDULER_ACTIVE.load(Ordering::SeqCst) {
                    break;
                }
                // ONE settings read per tick serves BOTH the cadence AND the first
                // iteration's caps (perf-round P1/P2): the dispatch loop no longer issues a
                // second full-row SELECT of the same singleton just for the tick.
                let (dispatch_tick, first_caps) = settings.dispatch_config().await;
                if let Err(e) = dispatch_self.dispatch_ready(first_caps).await {
                    tracing::warn!(error = ?e, "jobs scheduler tick failed");
                }
                tokio::time::sleep(dispatch_tick).await;
            }
        });
        // --- the heartbeat task (INV-3): advance THIS worker's own rows ---
        // #56: the heartbeat cadence is read-at-use each iteration (default 10s, INV-5).
        let hb_pool = self.pool.clone();
        let hb_worker = self.worker_id.clone();
        tokio::spawn(async move {
            let repo = JobRepository::new(hb_pool.clone());
            let settings = JobSettingsRepository::new(hb_pool);
            loop {
                let hb_every = settings.scheduler_limits().await.heartbeat;
                tokio::time::sleep(hb_every).await;
                if !SCHEDULER_ACTIVE.load(Ordering::SeqCst) {
                    break;
                }
                if let Err(e) = repo.heartbeat_running(&hb_worker).await {
                    tracing::warn!(error = ?e, worker_id = %hb_worker, "jobs heartbeat failed");
                }
            }
        });
        // --- the stale-claim reaper (INV-3/INV-4): single-leader per tick ---
        // #56: cadence + stale threshold + max_reclaims + reclaim_batch are ALL read-at-use
        // per iteration (one settings read → a consistent snapshot for this sweep). The
        // stale threshold is guarded `>= 3×heartbeat` at the settings layer (INV-4), so no
        // configured or legacy value can drive a live-worker reclaim. Default 15s/45s/5/100.
        let rp_pool = self.pool.clone();
        tokio::spawn(async move {
            let repo = JobRepository::new(rp_pool.clone());
            let settings = JobSettingsRepository::new(rp_pool);
            loop {
                let limits = settings.scheduler_limits().await;
                tokio::time::sleep(limits.reaper_tick).await;
                if !SCHEDULER_ACTIVE.load(Ordering::SeqCst) {
                    break;
                }
                let stale = limits.stale_threshold.as_secs() as i64;
                match repo
                    .reaper_sweep(
                        stale,
                        limits.max_reclaims,
                        limits.reclaim_batch,
                    )
                    .await
                {
                    Ok(Some(outcome))
                        if !outcome.reclaimed.is_empty() || !outcome.discarded.is_empty() =>
                    {
                        tracing::info!(
                            reclaimed = outcome.reclaimed.len(),
                            discarded = outcome.discarded.len(),
                            "jobs reaper: reclaimed stale claims / discarded poison jobs"
                        );
                        // The reaper's raw UPDATEs do NOT run the finalize seams, so emit
                        // `sync:job` HERE (mirrors `finalize`) for every touched job. Under
                        // notify-and-refetch one frame per changed job triggers the owner's
                        // job-list refetch, which also surfaces the dependents `reaper_sweep`
                        // cascade-failed IN ITS OWN transaction (so they are never stranded
                        // `blocked`, and the cascade uses the canonical ordered path — no
                        // separate runtime `reconcile_blocked_jobs`, no lock-order deadlock).
                        for (id, owner) in outcome.reclaimed.iter().chain(outcome.discarded.iter())
                        {
                            seams::sync_sink().publish_job_changed(*owner, JobChange::Updated, *id);
                        }
                    }
                    Ok(_) => {} // no-op tick, or not the leader this tick
                    Err(e) => tracing::warn!(error = ?e, "jobs reaper sweep failed"),
                }
            }
        });
    }

    /// While under the concurrency cap, claim + dispatch the next queued job by
    /// fair-share, honoring the reserved-interactive admission gate.
    ///
    /// `first_caps` is the `(cap, reserved, per_tenant)` triple the caller already read
    /// this tick (#56 perf-round P1/P2: one settings read serves both the tick cadence and
    /// the first iteration's caps). SUBSEQUENT iterations re-read `caps()` so the "admin cap
    /// at use" contract still holds — an admin PUT mid-tick takes effect on the next claim.
    async fn dispatch_ready(&self, first_caps: (i64, i64, i64)) -> Result<(), AppError> {
        let repo = JobRepository::new(self.pool.clone());
        let settings = JobSettingsRepository::new(self.pool.clone());
        let mut seeded_caps = Some(first_caps);
        loop {
            // Re-read the caps EVERY iteration, not once per tick — the module's
            // "reads the admin cap at use" contract (an admin PUT mid-tick must
            // take effect on the next claim, not the next tick). The FIRST iteration
            // reuses the caps the caller already read this tick (no redundant SELECT);
            // every later iteration re-reads for mid-tick freshness.
            //
            // T4 (INV-1): the GLOBAL cap `count_running() >= cap` pre-check is
            // GONE. Both the global and the per-tenant cap are now folded INTO the
            // claim UPDATE (`claim_next_fair`), so count-and-claim is one atomic
            // step under the row lock — the racy three-statement admission (safe
            // only while ONE sequential loop owned the DB) is exactly what this
            // removes, which is what makes N concurrent workers safe.
            let (global_cap, reserved, per_tenant_cap) = match seeded_caps.take() {
                Some(c) => c,
                None => settings.caps().await,
            };
            // Reserved-interactive admission (unchanged): hold batch back unless
            // the pool has room beyond the reservation, or no interactive job is
            // waiting. This gate stays a pre-check (a soft fairness policy, not a
            // hard safety bound); the hard caps are enforced in the claim.
            let running_batch = repo.count_running_class("batch").await?;
            let interactive_queued = repo.has_queued_class("interactive").await?;
            let allow_batch =
                batch_admitted(global_cap, reserved, running_batch, interactive_queued);

            match repo
                .claim_next_fair(!allow_batch, &self.worker_id, global_cap, per_tenant_cap)
                .await?
            {
                Some(job) => {
                    seams::sync_sink().publish_job_changed(
                        job.owner_id,
                        JobChange::Updated,
                        job.id,
                    );
                    runtime().broadcast(
                        job.id,
                        SSEJobEvent::Status(JobStatusFrame {
                            status: JobStatus::Running.as_str().to_string(),
                        })
                        .into(),
                    );
                    // Register the cancel signal at CLAIM time (before the executor
                    // is scheduled) so a stop racing the spawn is never lost.
                    let cancel_rx = runtime().register_cancel(job.id);
                    tokio::spawn(execute_job(
                        self.pool.clone(),
                        self.runner.clone(),
                        job,
                        cancel_rx,
                    ));
                }
                None => break,
            }
        }
        Ok(())
    }
}

/// What ended the run.
enum Outcome {
    Exited(i32),
    Cancelled,
    Error(String),
}

/// The scheduler's OUTER pre-spawn ceiling for a staging budget.
///
/// A well-behaved runner enforces the budget itself and answers just inside it;
/// this backstop exists for a runner that does NOT (a stub / third-party impl, or
/// a bug in the inner deadline), so it must fire strictly LATER — otherwise it
/// would pre-empt the inner path, whose message is more specific and whose cleanup
/// arm reclaims the workspace. The margin is proportional (10%, floored at 5s) so
/// it stays meaningful across the whole configurable range instead of dominating a
/// short budget or vanishing against a long one.
///
/// Derived, not configured: it is purely an in-process ordering margin between two
/// layers of the SAME operator-set budget, with no deployment-dependent right
/// answer — exactly the case the codebase reserves consts for.
pub fn staging_ceiling(budget: Duration) -> Duration {
    budget + (budget / 10).max(Duration::from_secs(5))
}

/// Drive one job's process end-to-end.
pub async fn execute_job(
    pool: SqlitePool,
    runner: Arc<dyn JobRunner>,
    job: Job,
    cancel_rx: watch::Receiver<bool>,
) {
    let repo = JobRepository::new(pool.clone());
    let job_id = job.id;
    let owner = job.owner_id;
    let is_analysis = job.job_type == "analysis";

    // Arch-compatibility gate (ITEM-26 / DEC-29, defense-in-depth). Refuse — before
    // any spawn — an analysis whose processor `arch` excludes the backend arch, with
    // a clear reason (no emulation). A non-analysis job / an unparseable spec is left
    // to the runner (which surfaces its own error).
    if is_analysis {
        if let Ok(spec) = crate::modules::sandbox::spec::AnalysisSpec::parse(&job.params) {
            if let Err(reason) = arch_compatible(&spec.arch, backend_arch()) {
                let _ = repo
                    .fail(job_id, &format!("arch-incompatible: {reason}"))
                    .await;
                finalize(&repo, job_id, owner).await;
                return;
            }
        }
    }

    // PRE-SPAWN CEILING (job-hang fix). `spawned.timeout_secs` — the wall-clock
    // deadline enforced by `run_and_sample` below — only starts ticking once a live
    // child process exists. So EVERYTHING before this point was unbounded: a runner
    // that stalls in staging (the env-image `oras`/`cosign` pull on a fresh
    // deployment being the concrete case) left the job pinned at `running` forever,
    // with no terminal state and no error. This bounds ANY runner, including one
    // that neglects its own internal deadline, so reaching a terminal state is a
    // property of the executor rather than of each runner's diligence.
    let ceiling = staging_ceiling(
        crate::modules::sandbox::settings_cache::get(&pool)
            .await
            .staging_budget(),
    );
    let spawn_result = tokio::time::timeout(ceiling, runner.spawn(&job))
        .await
        .unwrap_or_else(|_| {
            Err(format!(
                "job runner did not start a process within {}s (staging ceiling); failing the job \
                 rather than leaving it running forever",
                ceiling.as_secs()
            ))
        });

    let mut spawned = match spawn_result {
        Ok(s) => s,
        Err(e) => {
            let _ = repo.fail(job_id, &e).await;
            finalize(&repo, job_id, owner).await;
            return;
        }
    };

    // Hold the sandbox guards for the child's whole life; dropped after the
    // terminal persist (their Drop cleans the cgroup scope + seccomp + FIFO).
    let _guards = spawned.guards.take();
    let workspace = spawned.workspace.take();
    // ITEM-17: the run's OUTPUT STAGING dir, a separate tree from the workspace.
    // Carried alongside it through every terminal arm below so no path can reclaim
    // one and forget the other.
    let staging = spawned.outputs_staging.take();
    let cgroup_path = spawned.cgroup_path.take();
    let timeout_secs = spawned.timeout_secs;

    let pid = spawned.child.id();

    let already_stopped = *cancel_rx.borrow()
        || repo
            .get_any(job_id)
            .await
            .ok()
            .flatten()
            .map(|j| j.status != "running")
            .unwrap_or(false);
    if already_stopped {
        kill_child(&mut spawned.child, pid).await;
        let _ = spawned.child.wait().await;
        let _ = repo.mark_stopped(job_id).await;
        cleanup_run_dirs(is_analysis, &workspace, &staging).await;
        finalize(&repo, job_id, owner).await;
        return;
    }

    if let Some(p) = pid {
        let _ = repo.set_pid(job_id, p as i32).await;
    }

    let stdout = spawned.child.stdout.take();
    let stderr = spawned.child.stderr.take();
    let log_task = tokio::spawn(drain_logs(pool.clone(), job_id, stdout, stderr));

    // #56: the CPU/RSS sampling cadence is read-at-use once per job (a new job picks up
    // an admin PUT; a job already sampling is not re-queried every second). Default 1s
    // when unset (INV-5).
    let metric_tick = JobSettingsRepository::new(pool.clone())
        .scheduler_limits()
        .await
        .metric_tick;
    let (outcome, peak) = run_and_sample(
        &repo,
        &mut spawned.child,
        pid,
        cgroup_path,
        timeout_secs,
        job_id,
        cancel_rx,
        metric_tick,
    )
    .await;

    let _ = tokio::time::timeout(Duration::from_secs(5), log_task).await;

    match outcome {
        Outcome::Exited(code) => {
            if is_analysis {
                // BOTH dirs are required to finalize: the manifest + bytes come from
                // staging, the recorded entry bytes from the workspace (ITEM-17). A
                // sandbox run always carries both; anything else falls through to the
                // plain finish below.
                if let (Some(ws), Some(stg)) = (workspace.as_ref(), staging.as_ref()) {
                    // finalize: parse /outputs, ingest (P1) + record (P4), cleanup.
                    match super::runner::finalize_analysis(&job, code, ws, stg, peak).await {
                        Ok(()) => {
                            let _ = repo.finish(job_id, 0).await;
                        }
                        Err(reason) => {
                            // Fold the child's stderr TAIL into the terminal error. A bare
                            // `analysis exited with code 1` is a STATUS, not a DIAGNOSIS — the
                            // actual reason (a malformed input the converter can't parse, a
                            // missing dependency, a traceback) is printed by the script and
                            // otherwise lives ONLY in `job_logs`, so every surface rendering
                            // `job.error` showed a failure with no cause. `log_task` was awaited
                            // above, so the lines are already persisted.
                            //
                            // …and because they ARE already persisted, this is the ONE
                            // failure whose reason the log already carries in full, so it
                            // calls `fail_reason_already_logged` rather than `fail`: the
                            // fold must not be appended back onto the log as a lossy
                            // second copy of the very tail it was built from. Every OTHER
                            // `fail` in this file fails a job that has no child, and
                            // `fail` writes their reason to the log for them.
                            let msg = with_stderr_tail(&repo, job_id, &reason).await;
                            let _ = repo.fail_reason_already_logged(job_id, &msg).await;
                        }
                    }
                } else {
                    let _ = repo.finish(job_id, code).await;
                }
            } else {
                let _ = repo.finish(job_id, code).await;
            }
        }
        Outcome::Cancelled => {
            let _ = repo.mark_stopped(job_id).await;
            cleanup_run_dirs(is_analysis, &workspace, &staging).await;
        }
        Outcome::Error(e) => {
            let _ = repo.fail(job_id, &e).await;
            cleanup_run_dirs(is_analysis, &workspace, &staging).await;
        }
    }
    finalize(&repo, job_id, owner).await;
    // Guards drop here (after the terminal persist): cgroup scope removed,
    // seccomp fd closed, FIFO drain stopped + unlinked.
    drop(_guards);
}

/// Max characters of stderr appended to a failed analysis's terminal `error` — enough
/// for a Python traceback's final frames, small enough that the message stays a message.
const STDERR_TAIL_CHARS: usize = 800;
/// How many trailing stderr LINES to consider for the tail.
const STDERR_TAIL_LINES: i64 = 20;

/// `reason` enriched with the job's stderr tail (`"<reason>: <tail>"`), or `reason`
/// unchanged when nothing was captured / the read failed. Never fails the finalize —
/// a missing diagnostic must not cost the job its terminal state.
async fn with_stderr_tail(repo: &JobRepository, job_id: Uuid, reason: &str) -> String {
    let lines = repo
        .last_stderr_lines(job_id, STDERR_TAIL_LINES)
        .await
        .unwrap_or_default();
    let joined = lines
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    if joined.is_empty() {
        return reason.to_string();
    }
    // Keep the TAIL (the last frames of a traceback carry the actual error), not the head.
    let tail = if joined.chars().count() > STDERR_TAIL_CHARS {
        let skip = joined.chars().count() - STDERR_TAIL_CHARS;
        format!("…{}", joined.chars().skip(skip).collect::<String>())
    } else {
        joined
    };
    format!("{reason}: {tail}")
}

/// Remove an analysis job's workspace on a cancel/error path (the exit-0 path
/// removes it inside `finalize_analysis`, AFTER ingest).
/// Reclaim BOTH of a run's dirs on a terminal path that does NOT finalize (stopped
/// before start, cancelled, executor error). ITEM-17's "cleanup immediately on
/// error": such a run produced nothing that will ever be ingested, so its output
/// staging goes now rather than waiting for the next boot sweep.
async fn cleanup_run_dirs(
    is_analysis: bool,
    workspace: &Option<PathBuf>,
    staging: &Option<PathBuf>,
) {
    if !is_analysis {
        return;
    }
    if let Some(ws) = workspace {
        if let Err(e) = tokio::fs::remove_dir_all(ws).await {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(error = %e, "analysis workspace cleanup failed");
            }
        }
    }
    if let Some(stg) = staging {
        crate::modules::sandbox::outputs::discard_staging(stg).await;
    }
}

/// Sample metrics on a 1s tick and check for exit / cancel. Tracks the peak
/// subtree memory / pids for the run record. Uses the cgroup subtree sampler when
/// a scope path is present, else the single-pid `ProcSampler`.
async fn run_and_sample(
    repo: &JobRepository,
    child: &mut tokio::process::Child,
    pid: Option<u32>,
    cgroup_path: Option<PathBuf>,
    timeout_secs: Option<u64>,
    job_id: Uuid,
    mut cancel_rx: watch::Receiver<bool>,
    metric_tick: Duration,
) -> (Outcome, PeakMetrics) {
    let rt = runtime();
    // Keep a copy of the scope path for the FINAL teardown read (G3 / ITEM-5): the
    // sampler below consumes the original by value.
    let cg_path_final = cgroup_path.clone();
    let started = tokio::time::Instant::now();
    let mut cg_sampler = cgroup_path.map(CgroupSampler::new);
    let mut proc_sampler = pid.map(ProcSampler::new);
    let mut peak = PeakMetrics::default();
    let mut tick = interval(metric_tick);
    // Wall-clock deadline (A1): a caller-set budget the executor enforces so a
    // low-CPU blocking script (which never trips RLIMIT_CPU) can't run forever.
    let deadline = timeout_secs
        .filter(|&s| s > 0)
        .map(|s| tokio::time::Instant::now() + Duration::from_secs(s));

    let outcome = loop {
        // Enforce the wall-clock budget before the next tick blocks.
        if let Some(dl) = deadline {
            if tokio::time::Instant::now() >= dl {
                kill_child(child, pid).await;
                let _ = child.wait().await;
                break Outcome::Error(format!(
                    "wall-clock timeout ({}s) exceeded",
                    timeout_secs.unwrap_or(0)
                ));
            }
        }
        tokio::select! {
            _ = tick.tick() => {
                // Prefer the cgroup subtree sample; fall back to single-pid.
                let sample = cg_sampler.as_mut().and_then(|s| s.sample());
                if let Some(s) = sample {
                    peak.mem_peak_bytes = Some(peak.mem_peak_bytes.unwrap_or(0)
                        .max(s.mem_peak_bytes.unwrap_or(s.mem_bytes)));
                    if let Some(p) = s.pids_current {
                        peak.pids_peak = Some(peak.pids_peak.unwrap_or(0).max(p as i64));
                    }
                    if let Ok(metric) = repo
                        .insert_metric(job_id, s.cpu_pct, s.mem_bytes, s.mem_peak_bytes, s.pids_current)
                        .await
                    {
                        rt.broadcast(job_id, SSEJobEvent::Metric(metric).into());
                    }
                } else if let Some(s) = proc_sampler.as_mut() {
                    if let Some((cpu, mem)) = s.sample() {
                        peak.mem_peak_bytes = Some(peak.mem_peak_bytes.unwrap_or(0).max(mem));
                        if let Ok(metric) = repo.insert_metric(job_id, cpu, mem, None, None).await {
                            rt.broadcast(job_id, SSEJobEvent::Metric(metric).into());
                        }
                    }
                }
                match child.try_wait() {
                    Ok(Some(status)) => break Outcome::Exited(status.code().unwrap_or(-1)),
                    Ok(None) => {}
                    Err(e) => break Outcome::Error(format!("wait failed: {e}")),
                }
            }
            res = cancel_rx.changed() => {
                if res.is_err() || *cancel_rx.borrow() {
                    kill_child(child, pid).await;
                    let _ = child.wait().await; // reap
                    break Outcome::Cancelled;
                }
            }
        }
    };

    // G3 teardown reading (T3 / ITEM-5): one FINAL cgroup read after the child exits,
    // captured into `peak` so the hand-off already threaded through `finalize_analysis_with`
    // carries it (no new argument). `cpu.stat usage_usec` is cumulative, so this last read
    // is the run's total CPU (more accurate than the up-to-1s-stale tick sample); `memory.peak`
    // is monotonic. Wall is executor-observed. The scope dir is still owned by the run guards
    // here (they drop only after finalize), so the read succeeds on the exit path; an
    // unreadable scope (degraded / no cgroup) leaves the fields `None`.
    peak.wall_ms = Some(started.elapsed().as_millis() as i64);
    peak.gpu_secs = Some(0); // cpu-sandbox: no GPU accounting today (INV-5: gpu_secs=0)
    if let Some(ref scope) = cg_path_final {
        let m = crate::modules::sandbox::cgroup::read_metrics_at(scope);
        if let Some(u) = m.cpu_usage_usec {
            peak.cpu_usage_usec = Some(u as i64);
        }
        if let Some(mp) = m.mem_peak {
            peak.mem_peak_bytes = Some(peak.mem_peak_bytes.unwrap_or(0).max(mp as i64));
        }
    }
    (outcome, peak)
}

/// SIGTERM → grace → SIGKILL on unix; a hard kill elsewhere.
async fn kill_child(child: &mut tokio::process::Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(p) = pid {
        unsafe {
            libc::kill(p as i32, libc::SIGTERM);
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
    }
    let _ = pid;
    let _ = child.start_kill();
}

/// Drain both child streams into `job_logs` + the SSE stream with a shared
/// monotonic seq.
async fn drain_logs(
    pool: SqlitePool,
    job_id: Uuid,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
) {
    let repo = JobRepository::new(pool);
    let rt = runtime();
    let mut seq: i32 = 0;

    let mut out = stdout.map(|s| BufReader::new(s).lines());
    let mut err = stderr.map(|s| BufReader::new(s).lines());
    let mut out_done = out.is_none();
    let mut err_done = err.is_none();

    while !(out_done && err_done) {
        tokio::select! {
            line = async { out.as_mut().unwrap().next_line().await }, if !out_done => {
                match line {
                    Ok(Some(l)) => {
                        seq += 1;
                        append(&repo, rt, job_id, seq, "stdout", &l).await;
                    }
                    _ => out_done = true,
                }
            }
            line = async { err.as_mut().unwrap().next_line().await }, if !err_done => {
                match line {
                    Ok(Some(l)) => {
                        seq += 1;
                        append(&repo, rt, job_id, seq, "stderr", &l).await;
                    }
                    _ => err_done = true,
                }
            }
        }
    }
}

async fn append(
    repo: &JobRepository,
    rt: &'static super::runtime::JobsRuntime,
    job_id: Uuid,
    seq: i32,
    stream: &str,
    content: &str,
) {
    if let Ok(log) = repo.append_log(job_id, seq, stream, content).await {
        rt.broadcast(job_id, SSEJobEvent::Log(log).into());
    }
}

/// Broadcast the final status, emit the sync + notification seams, and end the
/// job's SSE streams.
async fn finalize(repo: &JobRepository, job_id: Uuid, owner: Uuid) {
    if let Ok(Some(job)) = repo.get_any(job_id).await {
        rt_broadcast_status(job_id, &job.status);
        seams::sync_sink().publish_job_changed(owner, JobChange::Updated, job_id);
        if JobStatus::from_str(&job.status)
            .map(JobStatus::is_terminal)
            .unwrap_or(false)
        {
            seams::notifier().notify_terminal(owner, &job);
        }
    }
    runtime().close_job(job_id);
}

fn rt_broadcast_status(job_id: Uuid, status: &str) {
    runtime().broadcast(
        job_id,
        SSEJobEvent::Status(JobStatusFrame {
            status: status.to_string(),
        })
        .into(),
    );
}

// ─────────────────────── boot run-durability reconcile ──────────────────────

/// What the boot reconcile does with one orphaned `running` job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileAction {
    /// Its workspace holds a valid `/outputs/manifest.json` (the child finished
    /// but ingest didn't run before the crash) → finalize it (ingest + record).
    Finalize,
    /// No finalizable outputs (a genuinely-dead mid-run, or a non-analysis job) →
    /// fail it with the workspace preserved (never silently discarded).
    FailPreserve,
}

/// Decide the boot reconcile's action for an orphaned `running` job (DEC-18).
/// FINALIZE only an ANALYSIS job whose workspace holds a valid outputs manifest —
/// the child finished, the ingest never ran, and re-finalizing is safe because the
/// ingest natural key upserts (no double-insert). Everything else (a mid-run crash
/// with no manifest, or a non-analysis job that has no `/outputs` contract) is
/// FAIL-preserved. Never resurrects a genuinely-dead run: a manifest is the only
/// signal that the child actually completed. Pure — unit-testable.
pub fn reconcile_action(is_analysis: bool, has_valid_manifest: bool) -> ReconcileAction {
    if is_analysis && has_valid_manifest {
        ReconcileAction::Finalize
    } else {
        ReconcileAction::FailPreserve
    }
}

/// The outcome of a boot reconcile pass: the ids finalized (uningested runs
/// recovered) and the ids failed with their workspace preserved (so the caller
/// keeps those dirs out of the same-boot stale sweep).
#[derive(Debug, Default, Clone)]
pub struct ReconcileReport {
    pub finalized: Vec<Uuid>,
    pub failed_preserved: Vec<Uuid>,
}

/// Boot-time run-durability reconcile (ITEM-19 / DEC-18), using the process-
/// installed ingest sink + run recorder. Replaces the old blanket
/// `reset_orphaned_running → failed` (which lost a finished-but-uningested, or
/// long-running, job across a restart). Best-effort: a DB/FS hiccup on one job
/// logs + is skipped, never aborting the pass.
pub async fn reconcile_orphaned_running(
    pool: &SqlitePool,
    workspace_root: &Path,
    staging_root: &Path,
) -> ReconcileReport {
    reconcile_orphaned_running_in(
        pool,
        workspace_root,
        staging_root,
        seams::ingest_sink(),
        seams::run_recorder(),
    )
    .await
}

/// The reconcile CORE with the ingest sink + run recorder injected (mirrors
/// `runner::finalize_analysis_with`) so a crash-recovery finalize takes the EXACT
/// same finalize path as a normal completion, and so the pass is testable with a
/// capturing sink (no process-wide `OnceLock` mutation).
///
/// Takes BOTH roots (ITEM-17). A recovered run's outputs are looked for in its
/// STAGING dir — the workspace no longer holds them — and the finalize is handed
/// both dirs so it ingests from one and hashes the recorded entry out of the other.
pub async fn reconcile_orphaned_running_in(
    pool: &SqlitePool,
    workspace_root: &Path,
    staging_root: &Path,
    ingest: Arc<dyn ArtifactIngestSink>,
    recorder: Arc<dyn RunRecorder>,
) -> ReconcileReport {
    let repo = JobRepository::new(pool.clone());
    let mut report = ReconcileReport::default();
    let running = match repo.list_running().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = ?e, "jobs reconcile: list_running failed; skipping boot reconcile");
            return report;
        }
    };
    for job in running {
        let is_analysis = job.job_type == "analysis";
        let job_dir = workspace_root.join(job.id.to_string());
        let staging_dir = crate::modules::sandbox::outputs::staging_dir(staging_root, job.id);
        // A finalizable run is an analysis job whose STAGING dir holds a valid
        // (present + structurally sound + files-resolvable) outputs manifest — the
        // same load the normal finalize uses, so "valid" means the same thing.
        // Staging, not the workspace: outputs outlive the workspace (ITEM-17), and a
        // crashed run whose workspace was already reclaimed is still finalizable.
        let has_valid_manifest = is_analysis
            && crate::modules::sandbox::outputs::load_produced_outputs(&staging_dir)
                .await
                .is_ok();
        match reconcile_action(is_analysis, has_valid_manifest) {
            ReconcileAction::Finalize => {
                // exit_code 0: the manifest's presence IS the "child finished"
                // signal. finalize_analysis_with ingests (idempotent), records,
                // then removes the workspace — identical to a live completion.
                match super::runner::finalize_analysis_with(
                    &job,
                    0,
                    &job_dir,
                    &staging_dir,
                    PeakMetrics::default(),
                    ingest.clone(),
                    recorder.clone(),
                )
                .await
                {
                    Ok(()) => {
                        let _ = repo.finish(job.id, 0).await;
                        report.finalized.push(job.id);
                        tracing::info!(job_id = %job.id, "jobs reconcile: finalized a finished-but-uningested run on boot");
                    }
                    Err(reason) => {
                        // Ingest failed → finalize_analysis_with kept the workspace;
                        // record the id so the same-boot sweep preserves it too.
                        let _ = repo
                            .fail(job.id, &format!("reconcile finalize failed: {reason}"))
                            .await;
                        report.failed_preserved.push(job.id);
                        tracing::warn!(job_id = %job.id, %reason, "jobs reconcile: finalize failed; job failed, workspace preserved");
                    }
                }
            }
            ReconcileAction::FailPreserve => {
                let _ = repo
                    .fail(
                        job.id,
                        "interrupted by server restart (workspace preserved)",
                    )
                    .await;
                // The SAME rule the live finalize consults decides this run's bytes
                // (`runner::run_dirs_disposition`) — a real call, not a comment,
                // because these two paths reaching the decision independently is
                // precisely how they came to disagree about a rejected manifest.
                //
                // A boot reconcile has no exit code to read: the process that would
                // have recorded it is the one that died. So it cannot prove the child
                // FAILED and must presume the dirs may hold completed work. And
                // nothing was cataloged — this arm runs precisely because there was
                // no loadable manifest to ingest.
                let child_succeeded = true; // unprovable either way at boot; presumed
                let outputs_cataloged = false;
                match super::runner::run_dirs_disposition(child_succeeded, outputs_cataloged) {
                    super::runner::RunDirs::Preserve => {
                        report.failed_preserved.push(job.id);
                        tracing::info!(job_id = %job.id, is_analysis, "jobs reconcile: no finalizable outputs; failed with run dirs preserved");
                    }
                    super::runner::RunDirs::Reclaim => {
                        if let Err(e) = tokio::fs::remove_dir_all(&job_dir).await {
                            if e.kind() != std::io::ErrorKind::NotFound {
                                tracing::warn!(job_id = %job.id, error = %e, "jobs reconcile: workspace cleanup failed");
                            }
                        }
                        crate::modules::sandbox::outputs::discard_staging(&staging_dir).await;
                        tracing::info!(job_id = %job.id, is_analysis, "jobs reconcile: no finalizable outputs; failed with run dirs reclaimed");
                    }
                }
            }
        }
    }
    report
}

// ───────────────────────────── stale-workspace sweep ────────────────────────

/// Whether a per-job workspace dir is stale (safe to remove at boot): its name
/// parses as a UUID that is NOT in the live-job set. A non-UUID dir (e.g.
/// `identity/`) is preserved. Pure + unit-testable (ITEM-30).
pub fn is_stale_workspace(dir_name: &str, live_ids: &[Uuid]) -> bool {
    match Uuid::parse_str(dir_name) {
        Ok(id) => !live_ids.contains(&id),
        Err(_) => false, // not a per-job dir → never sweep
    }
}

/// Run ids a run **in this process, right now** is using, which no sweep may touch
/// regardless of what the `jobs` table says.
///
/// **ITEM-17 BROADENED this, it did not retire it.** A run now owns two UUID-named
/// dirs — its workspace under the sandbox root and its output staging under the
/// staging root — and [`sweep_stale_run_dirs`] sweeps BOTH by the same stale rule.
/// One registration covers both, because both dirs are named by the same run id.
/// The guard would have been *more* necessary, not less, had the register not been
/// consulted for the second root: the verification path (below) hashes outputs, and
/// after ITEM-17 those outputs live in the staging tree.
///
/// It exists for the runs that deliberately have NO `jobs` row — the conformance gate
/// ([`super::conformance::run_gate`]) and the provenance re-run
/// ([`super::verify::run_analysis_for_verification`]) both synthesize a `Uuid::new_v4()`
/// job so that nothing about them is ever ingested or recorded. Their workspace dir is
/// therefore a uuid that `all_live_job_ids()` can never return, and
/// [`is_stale_workspace`] classifies it as STALE while it is in active use.
///
/// That was not a theoretical window. `JobsModule::init` runs
/// `reconcile_orphaned_running` — which finalizes a recovered run, ingests it, and fires
/// `conformance::dispatch_after_ingest` — and then `sweep_stale_run_dirs`, in the SAME
/// task. So a boot sweep could delete the `/inputs` out from under the verification it
/// had just started, after which the gate judged bytes that had been removed underneath
/// it (see the staging-fault classification in `conformance.rs`). ITEM-17 does not close
/// that window: `/inputs` is workspace scratch and stays in the workspace, so the sweep
/// that could take it is the same sweep, over the same root.
///
/// **In-memory and per-process on purpose.** A dir is held only while THIS process is
/// using it: after a crash the registry is empty, the leaked workspace is stale again,
/// and the next boot reclaims it. Naming verification workspaces so
/// [`is_stale_workspace`] structurally ignores them (a non-uuid prefix) was the other
/// candidate fix and was rejected for exactly that reason — it would have traded this
/// bug for a workspace that leaks forever.
static LIVE_WORKSPACES: LazyLock<Mutex<HashSet<Uuid>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// Holds one workspace id out of the sweep for as long as it is alive. Released on
/// drop, so EVERY early return / panic / timeout path in the holder un-registers
/// without a matching call to forget.
#[derive(Debug)]
pub struct LiveWorkspace(Uuid);

impl Drop for LiveWorkspace {
    fn drop(&mut self) {
        let mut set = LIVE_WORKSPACES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        set.remove(&self.0);
    }
}

/// Register `id` as an in-process live workspace until the returned guard drops.
///
/// Call it BEFORE the dir is created. Ordering is what makes it airtight: the
/// registration happens-before the `mkdir`, and [`sweep_stale_workspaces`] consults the
/// registry per candidate AFTER reading the dir out of the directory listing — so a
/// sweep that can see the dir at all can also see the registration.
#[must_use = "the workspace is protected only while the guard is alive"]
pub fn hold_live_workspace(id: Uuid) -> LiveWorkspace {
    LIVE_WORKSPACES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(id);
    LiveWorkspace(id)
}

/// Whether `id`'s workspace is held by a live in-process run.
pub fn is_live_workspace(id: Uuid) -> bool {
    LIVE_WORKSPACES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains(&id)
}

/// Boot reclamation of every per-run directory tree: the sandbox WORKSPACES and
/// the OUTPUT STAGING trees (ITEM-17). ONE call, so a run whose staging dir is
/// separated from its workspace cannot end up with only one of the two swept.
///
/// This is the third of ITEM-17's cleanup paths — the crash path. It deliberately
/// adds no new reclamation idiom: staging dirs are UUID-named per-run dirs under a
/// root, exactly like workspaces, so the SAME [`sweep_stale_workspaces`] (same
/// stale rule, same in-process live register) reclaims them, pointed at the second
/// root. Boot-time rather than periodic on purpose: a crash that skips both
/// in-process cleanup paths is by definition one that ended the process, and while
/// the process IS alive the finalize/error paths already reclaim.
///
/// Best-effort; safe to call with `workspace_root == staging_root` (the second pass
/// then finds nothing left).
pub async fn sweep_stale_run_dirs(workspace_root: &Path, staging_root: &Path, live_ids: &[Uuid]) {
    sweep_stale_workspaces(workspace_root, live_ids).await;
    sweep_stale_workspaces(staging_root, live_ids).await;
}

/// Boot-time sweep of stale per-run dirs under ONE root — a sandbox workspace root
/// or an output staging root (guards disk growth if a `finalize` failed before
/// cleanup). Best-effort. Call it through [`sweep_stale_run_dirs`] so no root is
/// missed.
pub async fn sweep_stale_workspaces(workspace_root: &Path, live_ids: &[Uuid]) {
    let mut rd = match tokio::fs::read_dir(workspace_root).await {
        Ok(rd) => rd,
        Err(_) => return, // no root yet → nothing to sweep
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_stale_workspace(&name, live_ids) {
            continue;
        }
        // The DB says nothing is using this dir, and for a run with a `jobs` row that
        // is the whole answer. A verification run has no row on purpose, so the second
        // question has to be asked: is a run in THIS process using it right now?
        // Consulted here, per candidate, rather than folded into `live_ids` up front —
        // the registration lands before the dir exists, so a check made after the dir
        // was listed can never miss it.
        if let Ok(id) = Uuid::parse_str(&name) {
            if is_live_workspace(id) {
                tracing::debug!(dir = %name, "jobs: kept a workspace held by a live in-process verification run");
                continue;
            }
        }
        let _ = tokio::fs::remove_dir_all(entry.path()).await;
        tracing::info!(dir = %name, "jobs: swept stale analysis workspace on boot");
    }
}

#[cfg(test)]
mod tests {
    use super::super::models::JobStatus;
    use super::*;

    // TEST-31 (regression leg): terminal-state guard the scheduler relies on.
    #[test]
    fn terminal_state_guard() {
        assert!(JobStatus::Completed.is_terminal());
        assert!(!JobStatus::Running.is_terminal());
    }

    // TEST-2 (unit leg, G2 / PROV-T3-2): the TXR_SCHEDULER_ENABLED flag is load-bearing.
    // Default (unset) ON; only the explicit false-y spellings disable; anything else is ON.
    // This pins the flag's meaning; the enqueue-vs-claim behaviour is proven by the
    // integration split test.
    #[test]
    fn scheduler_flag_semantics() {
        assert!(
            scheduler_flag_enabled(None),
            "unset ⇒ ON (single-box default)"
        );
        for off in ["0", "false", "no", "off", "FALSE", "  Off ", "No"] {
            assert!(
                !scheduler_flag_enabled(Some(off)),
                "{off:?} ⇒ OFF (enqueue-only)"
            );
        }
        for on in ["1", "true", "yes", "on", "anything"] {
            assert!(scheduler_flag_enabled(Some(on)), "{on:?} ⇒ ON");
        }
    }

    // TEST-12: batch admission — batch is held back when the pool is at/over the
    // non-reserved capacity AND an interactive job is queued; otherwise admitted.
    #[test]
    fn batch_admission_respects_reservation() {
        // cap=2, reserved=1 → non-reserved pool = 1.
        // No batch running yet, interactive queued → admit (0 < 1).
        assert!(batch_admitted(2, 1, 0, true));
        // 1 batch running, interactive queued → NOT admitted (1 < 1 is false).
        assert!(!batch_admitted(2, 1, 1, true));
        // 1 batch running, NO interactive queued → admitted (borrow reserved slot).
        assert!(batch_admitted(2, 1, 1, false));
        // reserved=0 → batch may fill the whole pool.
        assert!(batch_admitted(4, 0, 3, true));
        // Degenerate reserved>cap: (cap-reserved).max(0)=0, so with interactive
        // queued NO batch is admitted (0 < 0 is false) — and it does not panic /
        // underflow; with no interactive queued batch may still borrow.
        assert!(
            !batch_admitted(1, 5, 0, true),
            "reserved>cap + interactive queued → batch held"
        );
        assert!(
            batch_admitted(1, 5, 0, false),
            "reserved>cap + no interactive → batch borrows"
        );
    }

    // TEST-73 (unit leg / ITEM-26): the arch-compat gate — an empty arch ("all")
    // and a list containing the backend arch pass; a non-empty list that excludes
    // the backend arch is refused with a clear "requires an … backend" reason.
    #[test]
    fn arch_compat_gate() {
        // Default (empty) ⇒ all arches ⇒ always ok.
        assert!(arch_compatible(&[], "x86_64").is_ok());
        assert!(arch_compatible(&[], "aarch64").is_ok());
        // Includes the backend arch ⇒ ok.
        assert!(arch_compatible(&["x86_64".into()], "x86_64").is_ok());
        assert!(arch_compatible(&["x86_64".into(), "aarch64".into()], "aarch64").is_ok());
        // Excludes the backend arch ⇒ refused with a clear reason.
        let err = arch_compatible(&["x86_64".into()], "aarch64").unwrap_err();
        assert_eq!(err, "requires an x86_64 backend");
        let err2 = arch_compatible(&["aarch64".into()], "x86_64").unwrap_err();
        assert_eq!(err2, "requires an aarch64 backend");
        // backend_arch() resolves to a non-empty compile-target string.
        assert!(!backend_arch().is_empty());
    }

    // TEST-62 (unit leg / ITEM-19): the boot-reconcile decision — FINALIZE only an
    // analysis job with a valid manifest (child finished, ingest didn't run); a
    // mid-run crash (no manifest) or a non-analysis job → FAIL-preserve. Never
    // resurrects a run without the manifest signal.
    #[test]
    fn reconcile_action_finalizes_only_with_manifest() {
        // Analysis + valid manifest → finalize (recover the uningested run).
        assert_eq!(reconcile_action(true, true), ReconcileAction::Finalize);
        // Analysis mid-run crash (no manifest) → fail with the workspace preserved.
        assert_eq!(reconcile_action(true, false), ReconcileAction::FailPreserve);
        // A non-analysis job has no /outputs contract → fail-preserve regardless.
        assert_eq!(
            reconcile_action(false, false),
            ReconcileAction::FailPreserve
        );
        assert_eq!(reconcile_action(false, true), ReconcileAction::FailPreserve);
    }

    // TEST-62 (re-finalize idempotency unit / ITEM-19): finalizing a recovered run
    // hands its declared outputs to the ingest sink, and a re-ingested output does
    // NOT double-insert — the artifact natural key (run_id, output_id) upserts. A
    // sink modeling that key stays at one entry per (run, output) even when an
    // output was already present from a prior partial ingest before the crash.
    #[tokio::test]
    async fn reconcile_finalize_ingest_is_idempotent_by_natural_key() {
        use std::collections::BTreeSet;
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
        use std::sync::Mutex;

        use async_trait::async_trait;
        use chrono::Utc;

        use super::super::models::Job;
        use super::super::seams::NoopRunRecorder;
        use crate::modules::sandbox::outputs::ProducedOutput;

        // A sink that models the `artifacts` natural key: a set of (run_id,
        // output_id). `inserts` counts every insert ATTEMPT so we can prove the
        // set upserted (attempts > members) rather than appended.
        #[derive(Default)]
        struct NaturalKeyIngest {
            keys: Mutex<BTreeSet<(Uuid, String)>>,
            inserts: AtomicUsize,
        }
        #[async_trait]
        impl ArtifactIngestSink for NaturalKeyIngest {
            async fn ingest_outputs(
                &self,
                job: &Job,
                outputs: &[ProducedOutput],
                _ws: &Path,
            ) -> Result<(), String> {
                let run = job.run_id.unwrap_or(job.id);
                let mut k = self.keys.lock().unwrap();
                for o in outputs {
                    self.inserts.fetch_add(1, AtomicOrdering::SeqCst);
                    k.insert((run, o.id.clone())); // upsert — a repeat is not a dup
                }
                Ok(())
            }
        }

        // Stage a real per-run pair of dirs: a workspace, and — SEPARATELY, outside
        // it (ITEM-17) — a staging dir with a valid manifest + two output files (the
        // `load_produced_outputs` convention: path relative to /outputs).
        let base = std::env::temp_dir().join(format!("txr-reconcile-unit-{}", Uuid::new_v4()));
        let ws = base.join("sandboxes").join("job");
        let staging = base.join("run-staging").join("job");
        tokio::fs::create_dir_all(&ws).await.unwrap();
        assert!(
            !staging.starts_with(&ws),
            "the staging dir is outside the workspace"
        );
        let outputs_dir = crate::modules::sandbox::outputs::outputs_dir(&staging);
        tokio::fs::create_dir_all(&outputs_dir).await.unwrap();
        tokio::fs::write(outputs_dir.join("a.bin"), b"aaa")
            .await
            .unwrap();
        tokio::fs::write(outputs_dir.join("b.bin"), b"bbb")
            .await
            .unwrap();
        // `structure` + `meta` are REQUIRED with no serde default (artifact-model
        // ITEM-5/ITEM-6, INV-2) — a fixture that omits them fails to deserialize.
        let manifest = serde_json::json!({ "outputs": [
            { "id": "out_a", "datatype": "data", "path": "a.bin", "layout": "opaque", "role": "artifact",
              "structure": { "encoding": "opaque" }, "meta": {} },
            { "id": "out_b", "datatype": "data", "path": "b.bin", "layout": "opaque", "role": "artifact",
              "structure": { "encoding": "opaque" }, "meta": {} },
        ]});
        tokio::fs::write(
            outputs_dir.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .await
        .unwrap();

        let run = Uuid::new_v4();
        let job = Job {
            id: Uuid::new_v4(),
            owner_id: Uuid::new_v4(),
            job_type: "analysis".into(),
            name: "recovered".into(),
            status: "running".into(),
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
            run_id: Some(run),
        };

        // Simulate a PARTIAL prior ingest: (run, out_a) already landed before the
        // crash. The reconcile finalize re-ingests BOTH declared outputs.
        let sink = Arc::new(NaturalKeyIngest::default());
        sink.keys.lock().unwrap().insert((run, "out_a".to_string()));

        let res = super::super::runner::finalize_analysis_with(
            &job,
            0,
            &ws,
            &staging,
            PeakMetrics::default(),
            sink.clone(),
            Arc::new(NoopRunRecorder),
        )
        .await;
        assert!(res.is_ok(), "finalize of a recovered run succeeds: {res:?}");

        // Both declared outputs were handed to ingest (2 attempts)…
        assert_eq!(
            sink.inserts.load(AtomicOrdering::SeqCst),
            2,
            "both outputs ingested"
        );
        // …but the natural key kept ONE entry per (run, output) — out_a was already
        // present, so it upserted, not duplicated: 2 members, not 3.
        let keys = sink.keys.lock().unwrap();
        assert_eq!(
            keys.len(),
            2,
            "no double-insert: (run,out_a) upserted, not duplicated"
        );
        assert!(keys.contains(&(run, "out_a".to_string())));
        assert!(keys.contains(&(run, "out_b".to_string())));

        // finalize removed the workspace after a successful ingest (best-effort).
        assert!(!ws.exists(), "workspace cleaned after successful finalize");
        // TEST-23 (success-cleanup leg, ITEM-17): and the STAGING dir too — after
        // ingest, not before it. The outputs above were read out of `staging`, so
        // this cannot pass by the dir never having existed.
        assert!(
            !staging.exists(),
            "output staging cleaned after a successful ingest"
        );
        let _ = tokio::fs::remove_dir_all(&base).await;
    }

    // TEST-22: the stale-workspace predicate sweeps a dir whose job is gone but
    // preserves live-job dirs + non-UUID dirs.
    #[test]
    fn stale_workspace_predicate() {
        let live = vec![Uuid::from_u128(1), Uuid::from_u128(2)];
        // A live job's dir is preserved.
        assert!(!is_stale_workspace(&Uuid::from_u128(1).to_string(), &live));
        // A dead job's dir is stale.
        assert!(is_stale_workspace(&Uuid::from_u128(99).to_string(), &live));
        // A non-UUID dir (identity/, etc.) is never swept.
        assert!(!is_stale_workspace("identity", &live));
        assert!(!is_stale_workspace("not-a-uuid", &live));
    }

    // The sweep must not delete a workspace a run in THIS process is using.
    //
    // A verification run (the conformance gate, the provenance re-run) has no `jobs`
    // row by design, so `live_ids` can never name it and the predicate above rightly
    // calls its dir stale. `jobs::init` fires a post-ingest gate and then sweeps in the
    // SAME task, so without the in-process hold the boot sweep deletes the `/inputs` of
    // a verification that is running — and the gate then judges bytes that were removed
    // underneath it. Both directions are asserted: the held dir survives, and the
    // NEGATIVE CONTROL (an unheld dir, same sweep, same empty live set) is removed, so
    // a sweep that had simply stopped working could not pass this test.
    #[tokio::test]
    async fn the_sweep_keeps_a_workspace_held_by_a_live_in_process_run() {
        let root = std::env::temp_dir().join(format!("sweep-hold-{}", Uuid::new_v4()));
        let held = Uuid::new_v4();
        let unheld = Uuid::new_v4();
        for id in [held, unheld] {
            tokio::fs::create_dir_all(root.join(id.to_string()).join("inputs"))
                .await
                .expect("stage a workspace");
        }

        let guard = hold_live_workspace(held);
        assert!(is_live_workspace(held) && !is_live_workspace(unheld));
        // The live set is EMPTY: this is exactly the boot situation — neither uuid is a
        // job, so the DB has nothing to say about either one.
        sweep_stale_workspaces(&root, &[]).await;

        assert!(
            root.join(held.to_string()).join("inputs").is_dir(),
            "the sweep deleted the inputs of a live in-process verification run"
        );
        assert!(
            !root.join(unheld.to_string()).exists(),
            "the sweep no longer reclaims an unheld stale workspace — the hold must \
             narrow the sweep, not disable it"
        );

        // Released on drop ⇒ the dir is reclaimable again on a later pass, which is what
        // keeps a crashed verification from leaking its workspace forever.
        drop(guard);
        assert!(!is_live_workspace(held));
        sweep_stale_workspaces(&root, &[]).await;
        assert!(
            !root.join(held.to_string()).exists(),
            "a released workspace must become stale again"
        );
        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    // JOB-HANG FIX (layer ordering): the scheduler's outer pre-spawn ceiling must
    // fire strictly AFTER the runner's own staging deadline, so the runner's
    // specific message + workspace-reclaiming cleanup arm always win the race; the
    // scheduler ceiling is the backstop for a runner that ignores its budget. The
    // margin is proportional so it stays meaningful across the configurable range.
    #[test]
    fn staging_ceiling_always_exceeds_the_runner_budget() {
        for secs in [5u64, 30, 300, 900, 86_400] {
            let budget = Duration::from_secs(secs);
            let ceiling = staging_ceiling(budget);
            assert!(
                ceiling > budget,
                "ceiling {ceiling:?} must trail budget {budget:?} so the runner reports first"
            );
            assert!(
                ceiling - budget >= Duration::from_secs(5),
                "the margin stays usable at {secs}s (got {:?})",
                ceiling - budget
            );
        }
        // Proportional, not flat: a long budget gets a proportionally longer margin.
        assert!(
            staging_ceiling(Duration::from_secs(900)) - Duration::from_secs(900)
                > staging_ceiling(Duration::from_secs(30)) - Duration::from_secs(30)
        );
    }

    // TEST-12 (ITEM-8 / #66): the in-pod `run-job` executor sets `TXR_SCHEDULER_ENABLED=off`
    // and does NOT enter worker mode, so the boot reconcile + sweep + scheduler claim loop —
    // all gated on `scheduler_should_spawn()` (jobs/mod.rs) — are skipped. That predicate is
    // `is_worker_mode() || scheduler_flag_enabled(env)`; run-job leaves worker mode false, so
    // the flag alone decides, and `off` → false. Proven over the pure flag predicate (worker
    // mode is a process-global the run-job path never sets).
    #[test]
    fn test_12_run_job_env_disables_the_scheduler() {
        assert!(!scheduler_flag_enabled(Some("off")), "off disables the loop");
        assert!(!scheduler_flag_enabled(Some("false")), "false disables the loop");
        // Sanity: the default-on that a serve/desktop process gets, to prove `off` is meaningful.
        assert!(scheduler_flag_enabled(None), "unset defaults ON");
    }
}
