//! `jobs` module — the analysis job scheduler (FCFS queue + admin concurrency
//! cap + per-job logs/metrics + stop). Registers into `MODULE_ENTRIES`.
//!
//! The runner is a pluggable seam (`runner::JobRunner`); this round ships a stub
//! that spawns a real child process, so the queue / logs / metrics / stop
//! pipeline is proven end-to-end. Realtime sync + notifications are behind
//! no-op trait seams (`seams`), reconciled to live8's `modules/sync` +
//! `ziee_notification` at merge.

// `models` + `repository` are `pub` so integration tests can assert at the DB
// layer (the boot-crash-safety reset needs to insert an orphaned `running` row
// and call the real method). The rest of the module stays private.
pub mod models;
pub mod repository;

// `admission` is `pub` because it is the SHARED front door every out-of-scheduler
// sandbox child goes through (`sandbox::execute`, the conformance gate), and its
// constants are asserted by integration tests. There is exactly one concurrency cap in
// this process; this module is where a caller that is not the scheduler claims against
// it. Do NOT add a second limiter beside it — read its module doc first.
pub mod admission;
// `conformance` is `pub` so an integration test can drive the gate end-to-end
// (artifact-model ITEM-18 / DEC-12) the same way `verify`/`scheduler` are driven —
// the dispatch itself is detached, so a test that awaited the sink would race it.
pub mod conformance;
// Who may SEE a job, and who may STOP one — the companion rule to `create_job`'s
// "who may CREATE one". Read it before touching a gate in `routes.rs`.
// `pub` so A3's account-membership flip can integration-test `resolve_job_reach`
// (its project/dataset scope arms are now account-aware transitively).
pub mod authz;
mod permissions;
mod routes;
pub mod runner;
// `runtime` is `pub` so a run this module does not SCHEDULE can still be stopped
// through it: `provenance::verify` registers the cancel signal at admission and its
// detached drive loop picks the receiver up (`cancel_receiver`). Keeping it private
// would have meant a verification with a `jobs` row and a Stop button that did
// nothing — the exact "control that lies" this change exists to remove.
pub mod runtime;
// `scheduler` is `pub` so the boot run-durability reconcile (ITEM-19) can be
// driven directly from an integration test (crash-then-reconcile), mirroring the
// `pub repository`/`pub seams` test-access pattern.
pub mod scheduler;
// `seams` is `pub` so P4's `provenance` module can install the REAL run recorder
// (`seams::install_recorder`) + implement the `RunRecorder` trait; `verify` is
// `pub` so it can re-execute a recorded run via the compute path.
pub mod seams;
// `settings` is `pub` for the same reason: an out-of-scheduler run must be admitted
// under the SAME `max_concurrent_jobs` cap, so its caller has to read it.
pub mod settings;
mod sse;
pub mod verify;

// Compute T6 — the quota-enforcement seam at `create_job` (design §4.2a). saas-gated with the
// rest of `billing`: a desktop build links zero quota code (INV-3 / BQ-INV-8).
#[cfg(feature = "saas")]
pub mod quota;

use std::sync::Arc;

use aide::axum::ApiRouter;
use linkme::distributed_slice;

use ziee_framework::{AppModule, ModuleContext, ModuleEntry, MODULE_ENTRIES};

pub struct JobsModule;

impl AppModule for JobsModule {
    fn name(&self) -> &'static str {
        "jobs"
    }

    fn description(&self) -> &'static str {
        "Analysis job scheduler (FCFS queue + concurrency cap)."
    }

    fn init(&mut self, ctx: &ModuleContext) -> Result<(), Box<dyn std::error::Error>> {
        let pool = (*ctx.db_pool).clone();

        // Install the process-wide sync + notification seams. The SYNC one is REAL:
        // `SyncEntity::Job` + `publish` landed with the project-management merge, but the
        // Noop was never swapped out — so six `publish_job_changed` call sites were dead
        // and the frontend's `sync:job` subscription could never fire. The NOTIFIER is
        // still a no-op (no `job_completed`/`job_failed` notification kinds registered).
        seams::install_seams(
            Arc::new(seams::RealJobSyncSink::new(pool.clone())),
            Arc::new(seams::NoopJobNotifier),
        );
        // Install the artifact-ingest seam (REAL — P1's working-store ingest is
        // merged). The run recorder is installed by `ProvenanceModule::init`
        // (P4, order 35, after jobs) so jobs never imports provenance; until
        // then the `run_recorder()` getter falls back to the Noop.
        seams::install_ingest_sink(Arc::new(seams::WorkstoreIngestSink::new(pool.clone())));

        // Install the REAL compute meter (T3 / G3 / ITEM-5): the child-exit teardown-metrics
        // seam lands an append-only `job_id`-keyed row in `compute_meter` per finished run
        // (idempotent). Owned by T3; the deferred T5 aggregates the raw signal (§9). Installed
        // like the ingest sink so both `serve` (single-box) and `worker` pods emit the raw
        // per-job cpu/gpu-seconds signal; the `NoopComputeMeter` default (nothing recorded) is
        // the seam's pre-install behaviour a unit test drives (INV-5).
        // T5 / ITEM-4 / INV-3: the SINGLE compute-metering gate. On the `saas` (cloud) build
        // this installs the real account-keyed `DbComputeMeter`; on the desktop/default build
        // it installs NOTHING (the `NoopComputeMeter` seam default), so desktop writes no
        // `compute_meter` row and pays no metering overhead (DE-INV-10). One gate, tested in
        // both profiles by tests/metering/saas_gating_test.rs.
        let _ = seams::install_process_compute_meter(pool.clone());

        // Build the compute backend registry (local bwrap only today) + the
        // job-type dispatcher (analysis → sandbox, else → stub). If the sandbox
        // is unavailable the analysis arm degrades to a clear per-job failure.
        let registry = Arc::new(
            crate::modules::sandbox::backend::local_bwrap::BackendRegistry::new(pool.clone()),
        );
        let dispatch = runner::DispatchRunner::new(
            Arc::new(runner::StubJobRunner),
            Arc::new(runner::SandboxJobRunner::new(pool.clone(), registry)),
        );
        let scheduler = Arc::new(scheduler::Scheduler {
            pool: pool.clone(),
            runner: Arc::new(dispatch),
            // T4 (DEC-4): this process's stable worker identity (pod HOSTNAME, or a
            // per-process UUID fallback on single-box serve), stamped into
            // `claimed_by` at claim time + used by the heartbeat.
            worker_id: scheduler::worker_id(),
        });

        // Boot run-durability reconcile (ITEM-19 / DEC-18): instead of the old
        // blanket `reset_orphaned_running → failed` (which discarded a finished-
        // but-uningested, possibly hours-long, run), FINALIZE each orphaned
        // `running` job whose OUTPUT STAGING dir holds a valid
        // `/outputs/manifest.json` (idempotent ingest via the artifact natural key),
        // else FAIL it with both run dirs PRESERVED. THEN sweep stale per-run dirs
        // in BOTH trees (ITEM-30 / ITEM-17 — guards disk growth), keeping the
        // queued/running live set AND the freshly failed-preserved ids so a
        // preserved mid-run survives this boot's sweep (a later restart reclaims it
        // once it is no longer freshly-failed).
        //
        // FIX-2 (reconcile-vs-scheduler race): the scheduler loop is started ONLY
        // AFTER the reconcile + sweep complete, INSIDE this task — NOT in parallel.
        // The reconcile classifies every orphaned `running` row (finalize / fail-
        // preserve) and the sweep removes dead workspaces; if the loop were claiming
        // queued jobs concurrently, a just-claimed `running` job could be mis-treated
        // as an orphan (permanently `failed`, or its live workspace deleted). Still
        // spawned (not awaited) — after `install_ingest_sink` so the reconcile's
        // finalize sees the REAL ingest sink — so the openapi-gen lazy-pool path is
        // never blocked; a failed query there just logs a warning (and the loop,
        // started at the end, simply idles on that path).
        // G2 serve/worker role split (T3 / ITEM-3 / PROV-T3-2): the boot reconcile + sweep +
        // scheduler loop run ONLY on a process that claims jobs — a `worker` pod (always) or a
        // `serve`/single-box process with `CYTO_SCHEDULER_ENABLED` on (default). The SaaS API
        // pod runs `serve` with the flag OFF: it enqueues via `POST /jobs` but NEVER claims,
        // reconciles, or sweeps (those all touch runs another pod owns), so workers are the
        // ONLY claimer class — the precondition T4's cap-in-claim relies on. Single-box/desktop
        // is byte-identical (flag default-on → this branch runs, INV-4).
        if !scheduler::scheduler_should_spawn() {
            tracing::info!(
                "jobs: scheduler DISABLED on this process (enqueue-only serve; CYTO_SCHEDULER_ENABLED off) — only worker pods claim (G2)"
            );
            return Ok(());
        }
        let reconcile_pool = pool.clone();
        tokio::spawn(async move {
            let root = crate::modules::rootfs::data_root().join("sandboxes");
            // ITEM-17: the run's outputs live in a SIBLING tree, so boot recovery
            // needs both roots — the manifest of a finished-but-uningested run is
            // found in staging, not in the workspace.
            let staging_root = crate::modules::sandbox::outputs::staging_root();
            let report =
                scheduler::reconcile_orphaned_running(&reconcile_pool, &root, &staging_root).await;
            if !report.finalized.is_empty() || !report.failed_preserved.is_empty() {
                tracing::info!(
                    finalized = report.finalized.len(),
                    failed_preserved = report.failed_preserved.len(),
                    "jobs: boot reconcile of orphaned running jobs"
                );
            }
            let repo = repository::JobRepository::new(reconcile_pool);
            // Self-heal any job stranded `blocked` by a crash between a dependency
            // terminalizing and its unblock/cascade committing (ITEM-19): cascade-fail
            // blocked jobs whose dep failed/stopped, and queue those whose deps ALL
            // completed. Idempotent; runs right after the orphaned-running reconcile so
            // the freshly-queued/failed states are reflected in the live keep-set below.
            match repo.reconcile_blocked_jobs().await {
                Ok((cascaded, queued)) if cascaded > 0 || queued > 0 => {
                    tracing::info!(
                        cascaded,
                        queued,
                        "jobs: boot reconcile of stranded blocked jobs"
                    );
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(error = ?e, "jobs: reconcile_blocked_jobs failed on boot");
                }
            }
            let mut keep = repo.all_live_job_ids().await.unwrap_or_default();
            keep.extend(report.failed_preserved.iter().copied());
            scheduler::sweep_stale_run_dirs(&root, &staging_root, &keep).await;

            // Reconcile settled → NOW start the scheduler loop (idempotent — the
            // `SCHEDULER_ACTIVE` guard makes a second init a no-op). It never claims
            // a queued job while the reconcile is still classifying orphans.
            scheduler.spawn();
        });

        Ok(())
    }

    fn register_routes(&self, router: ApiRouter) -> ApiRouter {
        router.merge(routes::jobs_routes())
    }
}

#[distributed_slice(MODULE_ENTRIES)]
static JOBS: ModuleEntry = ModuleEntry {
    name: "jobs",
    order: 30,
    description: "Analysis job scheduler (FCFS queue + concurrency cap).",
    constructor: || Box::new(JobsModule),
};
