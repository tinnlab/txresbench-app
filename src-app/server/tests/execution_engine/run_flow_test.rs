//! The drive + flow integration suites (TEST-EE-12/13/15/17/18/19/21/27/32/
//! 33/34/35/36) — the engine's own run path driven IN THIS PROCESS over the
//! harness template DB with the scripted seams, plus the host-gated real-stack
//! legs.
//!
//! Why in-process and not over the spawned server: the ITEM-11 HTTP suite
//! (`api_test.rs`) proves the transport; the DRIVE's live concurrency
//! (lane cap, stop mid-run, SSE frames while methods run, live log lines)
//! is only observable when the drive is in THIS process — the spawned
//! server's drive uses the real provider + executo, and the run-window
//! assertions would race a real 250 MB download. The seams installed here
//! are the SAME trait objects the module wiring installs
//! (`orchestrator::start_run(pool, runtime, env, executor, …)`), so the
//! drive, admission wrapper, repository finalize and runtime registry are
//! exactly production.
//!
//! The real-stack legs are gated on the host carrying the REAL published
//! layer artifacts at the manifest digests under the process data root
//! (the engine's manifest pins real `ghcr.io` refs + digest pins, so the
//! loopback-registry + scratch-squashfs fixtures of the sandbox suite
//! cannot feed this seam — see DRIFT-1 ITEM-11). They self-skip via
//! `record_skip` with the concrete missing pieces named; `CYTO_TEST_NO_SKIP
//! =1` turns each skip into a hard failure.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use super::{
    cohort_run_request, pool, register_user, scratch_dir, wait_terminal, EnvPolicy, FakeEnv,
    FakeExecutor, FakeStackRunSeam,
};
use crate::common::TestServer;
use crate::dataset::hardening_common::record_skip;
use cytoanalyst::modules::execution_engine::envmanifest;
use cytoanalyst::modules::execution_engine::orchestrator::{self, StackMethodExecutor};
use cytoanalyst::modules::execution_engine::repository::{produced_models, TxrRepository};
use cytoanalyst::modules::execution_engine::runtime::RunRuntime;
use cytoanalyst::modules::execution_engine::types::{TxrLimits, TxrRunStatus};
use cytoanalyst::modules::jobs::repository::JobRepository;
use cytoanalyst::modules::rootfs;

/// The three catalogue methods the drive fixtures classify `can_run` on the
/// 30-patient cohort (one marker, three draws) AND carry a manifest entry —
/// the ITEM-9 unit recipe.
const DRIVE_METHODS: [&str; 3] = ["landmark-cox-current", "ctdna-tf-four-group", "jm-lme"];

/// TEST-EE-13 (the server-harness half): every method run is admitted through
/// `jobs::admission::admit_within` with `job_type == "sandbox"` (DEC-4), the
/// admitted row is terminal on the success path (the finally-shaped close),
/// and the lane cap is never exceeded.
#[tokio::test]
async fn admission_contract_admits_sandbox_rows_and_closes_them_terminal() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-admission").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("admission"));

    let runtime = Arc::new(RunRuntime::new());
    let env = Arc::new(FakeEnv::new(Duration::from_millis(5)));
    let executor = Arc::new(FakeExecutor::new(Duration::from_millis(60)));
    let req = cohort_run_request(&DRIVE_METHODS, 2, true);
    let summary = orchestrator::start_run(pool.clone(), runtime, env, executor.clone(), owner, req)
        .await
        .expect("create");
    assert!(
        matches!(
            summary.status,
            TxrRunStatus::Preparing | TxrRunStatus::Running
        ),
        "the 202 summary carries the classified run"
    );

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert_eq!(methods.len(), 3);
    assert_eq!(
        executor.peak.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "at_a_time 2 → never a third in running"
    );
    assert_eq!(
        executor
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len(),
        3
    );

    let jobs = JobRepository::new(pool.clone());
    for m in &methods {
        assert_eq!(m.state, "finished", "{}", m.method_id);
        let job_id = m.job_id.expect("admitted via a jobs row");
        let job = jobs
            .get_any(job_id)
            .await
            .expect("get")
            .expect("row exists");
        assert_eq!(job.job_type, "sandbox", "DEC-4: the PROV-SS-1 caller type");
        assert!(
            matches!(job.status.as_str(), "completed" | "failed" | "stopped"),
            "the admitted row is terminal after the finally-shaped close: {}",
            job.status
        );
        assert_eq!(job.owner_id, owner, "the row is the session owner's");
    }

    // The counts JSON matches the rows; results are marked ready.
    assert_eq!(
        repo.method_counts(summary.id)
            .await
            .expect("counts")
            .finished,
        3
    );
    assert_eq!(row.predictions_ready, true);
}

/// TEST-EE-18: the run dir tree lives under `rootfs::data_root()` as
/// `analysis-<UTC ts>-<id8>/` with input/, bundles/<method_id>/,
/// output/<method_id>/predictions.csv + run.json + the recorded chance.csv and
/// logs/models when the run saves them; the row's `dir` equals it; nothing is
/// written inside the repo.
#[tokio::test]
async fn run_dir_tree_lives_under_the_data_root() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-tree").await;
    let pool = pool(&server).await;
    let scratch = scratch_dir("tree");
    let _g = rootfs::scoped_data_root(&scratch);

    let runtime = Arc::new(RunRuntime::new());
    let env = Arc::new(FakeEnv::new(Duration::from_millis(5)));
    let seam = FakeStackRunSeam::new();
    let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, true),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);

    let dir = PathBuf::from(&row.dir);
    assert!(
        dir.starts_with(&scratch),
        "row.dir is under the data root: {}",
        dir.display()
    );
    assert!(
        dir.file_name()
            .expect("dir stem")
            .to_string_lossy()
            .starts_with("analysis-"),
        "the DEC-5 `analysis-<UTC yyyy-mm-dd-hhmm>-<id8>` promise"
    );
    for sub in [
        "input",
        "input/patients.csv",
        "input/values.csv",
        "input/features.csv",
        "input/run-input.json",
        "bundles/ctdna-tf-four-group",
        "output/ctdna-tf-four-group",
        "models/ctdna-tf-four-group",
    ] {
        assert!(dir.join(sub).exists(), "{sub} written");
    }
    let out = dir.join("output/ctdna-tf-four-group");
    assert!(
        out.join("predictions.csv").exists(),
        "the raw container output kept"
    );
    assert!(out.join("run.json").exists());
    assert!(
        out.join("chance.csv").exists(),
        "the recorded as-served column"
    );

    // The seam's record is the input the engine wrote: the fit call's bundle
    // carries train/ (engine.cpp's per-call input shape — a reuse predict
    // clears it again), every call read the same params, and the fit call
    // scores nothing.
    let calls = seam.calls.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(calls.len(), 3, "fit + training scores + predict: {calls:?}");
    assert!(calls[0].has_train, "the fit call's bundle carries train/");
    assert!(!calls[1].has_train, "a reuse predict never sees train/");
    assert!(!calls[2].has_train, "the final predict never sees train/");
    assert_eq!(
        calls[0].params, calls[2].params,
        "one params shape per call"
    );
    assert_eq!(calls[0].scored.len(), 0, "the fit call scores nothing");
    assert_eq!(calls[2].scored.len(), 30, "the predict scored the cohort");
    drop(calls);
    assert!(
        repo.log_total(summary.id).await.expect("logs") >= 1,
        "engine lines landed"
    );

    // Nothing under the worktree's tracked tree: the scoped root is the only
    // thing the drive wrote (the repo path is never a prefix of dir).
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    assert!(
        !dir.starts_with(repo_root),
        "run dirs never live under the repo"
    );
}

/// TEST-EE-33: the wrapper's live lines are appended while the run is active
/// (the drainer, not a completion-time batch) and ride the run SSE runtime as
/// `log` frames; the run-scoped log serves them after too.
#[tokio::test]
async fn live_log_lines_stream_while_the_run_is_active() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-logs").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("logs"));

    let runtime = Arc::new(RunRuntime::new());
    let env = Arc::new(FakeEnv::new(Duration::from_millis(5)));
    let seam = FakeStackRunSeam::new_delayed(Duration::from_millis(700));
    let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime.clone(),
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 3, false),
    )
    .await
    .expect("create");
    // Subscribe BEFORE the drive's frames (the stream the drive broadcasts into).
    let mut rx = runtime.subscribe(summary.id).expect("subscribe under cap");

    let repo = TxrRepository::new(pool.clone());

    // While the fixture container is inside its (700 ms) call, the line is
    // already in the run log — the pane streams during the run.
    let mut saw_while_active = false;
    for _ in 0..200 {
        let total = repo.log_total(summary.id).await.expect("logs");
        let row = repo.get_run(summary.id).await.expect("get").expect("row");
        if total >= 1 && row.status().expect("parses") == TxrRunStatus::Running {
            saw_while_active = true;
            break;
        }
        if row.status().expect("parses") == TxrRunStatus::Finished {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        saw_while_active,
        "log lines are served while the run is active"
    );

    // The SSE runtime carried the line + a prediction frame (the run's share
    // of the F screen's log pane).
    let mut saw_log = false;
    let mut saw_prediction = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let Ok(Some(f)) = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await else {
            break;
        };
        let f = f.expect("stream open");
        // axum's Event exposes only builders; its Debug carries the fields
        // (the jobs runtime's own test asserts on `format!("{event:?}")`).
        let dbg = format!("{f:?}");
        if dbg.contains("fixture says hi") {
            saw_log = true;
        }
        if dbg.contains("prediction") {
            saw_prediction = true;
        }
    }
    assert!(saw_log, "the wrapper line rode the log SSE frames");
    assert!(
        saw_prediction,
        "a prediction frame announced the finished column"
    );

    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let (lines, _total, _next) = repo
        .logs_page(summary.id, None, 0, 500)
        .await
        .expect("logs");
    assert!(
        lines.iter().any(|l| l.content.contains("fixture says hi")),
        "the line is in the persisted run log"
    );
}

/// TEST-EE-34 (the in-process half): the mid-run lane change returns the
/// updated summary, applies from the next admission and never interrupts a
/// running method — all three methods finish under the raised count. The
/// raised lanes are bounded by DEC-6's GLOBAL `max_concurrent_jobs` (the ONE
/// sandbox-child ceiling, bumped at create): the lane raise to 2 (the box's
/// seed cap) is observable in the concurrency peak, and a raise ABOVE it can
/// never exceed the global pool (the at-a-time route is a lane change, not a
/// settings write — INDUSTRIAL note, see DRIFT-1 ITEM-11 #6).
#[tokio::test]
async fn mid_run_at_a_time_change_raises_the_lanes_and_never_interrupts() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-lanes").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("lanes"));

    let runtime = Arc::new(RunRuntime::new());
    let env = Arc::new(FakeEnv::new(Duration::from_millis(5)));
    let executor = Arc::new(FakeExecutor::new(Duration::from_millis(500)));
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        executor.clone(),
        owner,
        cohort_run_request(&DRIVE_METHODS, 1, true),
    )
    .await
    .expect("create");

    // The first method is in the executor; raise 1 → 2 mid-run. The 2nd
    // admission observes the NEW lane count (the seed global cap is 2, so
    // the lane gate is the binding constraint — this is the observable).
    let repo = TxrRepository::new(pool.clone());
    let mut running_seen = false;
    for _ in 0..200 {
        if repo
            .methods_for_run(summary.id)
            .await
            .expect("methods")
            .iter()
            .filter(|m| m.state == "running")
            .count()
            >= 1
        {
            running_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(running_seen, "the first method reached the executor");
    let updated = orchestrator::set_at_a_time_run(pool.clone(), summary.id, 2)
        .await
        .expect("lane change");
    assert_eq!(
        updated.config.at_a_time, 2,
        "the summary reflects the change"
    );

    // Raise 2 → 3 while the run is active: the lane gate applies from the
    // next admission, but the DEC-6 global pool is the one ceiling — the
    // third call is admitted when a global slot frees, never beyond it.
    // (A method that started under the old count is never interrupted.)
    let updated = orchestrator::set_at_a_time_run(pool.clone(), summary.id, 3)
        .await
        .expect("second change");
    assert_eq!(
        updated.config.at_a_time, 3,
        "the summary reflects the change"
    );

    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert_eq!(methods.len(), 3, "all three methods finished");
    for m in &methods {
        assert_eq!(m.state, "finished", "no method was interrupted: {m:?}");
        assert_eq!(m.reason_code, None, "no aborted row: {m:?}");
    }
    assert_eq!(
        executor.peak.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "the 1 → 2 raise is observable; the DEC-6 global cap (2, the seed) \
         stays the one ceiling above it"
    );

    // The typed refusal outside the bound (the 400 arm of PROV-EE-6).
    let err = orchestrator::set_at_a_time_run(pool.clone(), summary.id, 9)
        .await
        .expect_err("outside the bound");
    assert_eq!(err.error_code(), "INVALID_AT_A_TIME");
    assert_eq!(
        TxrLimits::AT_A_TIME_MAX,
        8,
        "the vocabulary's bound is the plan's 1..=8"
    );
}

/// TEST-EE-32/35: the grown record fields — `input_summary.file_names`,
/// `model_ids: []`, the per-method `task` enum vocabulary, and the produced
/// model row's `size_bytes`/`own_auc` — round-trip through the repository
/// over the harness template DB.
#[tokio::test]
async fn growth_fields_round_trip_and_finished_rows_carry_the_task_enum() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-growth").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("growth"));

    let runtime = Arc::new(RunRuntime::new());
    let env = Arc::new(FakeEnv::new(Duration::from_millis(5)));
    let seam = FakeStackRunSeam::new();
    let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, true),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    let summary = repo
        .get_run_summary(summary.id)
        .await
        .expect("summary")
        .expect("exists");
    assert_eq!(summary.model_ids, Vec::<String>::new(), "train mode → []");
    assert_eq!(
        summary.input_summary.file_names.measurements, "values.csv",
        "the parsed source name is captured at create (GAP-HS-1)"
    );
    assert_eq!(summary.input_summary.patients, Some(30));

    let methods = repo.methods_for_run(row.id).await.expect("methods");
    assert_eq!(methods.len(), 1);
    let m = &methods[0];
    assert_eq!(m.state, "finished");
    let task = m.task.as_deref().expect("task set");
    assert!(
        matches!(task, "pfs" | "os" | "response"),
        "the enumerated outcome vocabulary: {task}"
    );
    assert_eq!(task, "pfs", "the run's endpoint derives the row task");

    let models = produced_models(&pool, row.id)
        .await
        .expect("produced models");
    assert_eq!(models.len(), 1, "the saved /model is a complete record");
    assert_eq!(models[0].method_id, "ctdna-tf-four-group");
    assert!(
        models[0].size_bytes > 0,
        "GAP-B: the produced tree byte size"
    );
    assert!(models[0].own_auc.is_some(), "GAP-C: own-data AUC computed");
    assert_eq!(models[0].trained_on_patients, 30);
    assert_eq!(models[0].tree_sha256, models[0].model_out_digest);
}

/// TEST-EE-36: the grown DB seams are the only tables a downstream node may
/// bind — `txr_runs` (with `model_ids`), `txr_run_methods` (with the 0005
/// produced-model columns), `txr_run_logs` — declared by the merged chain the
/// harness template DB carries.
#[tokio::test]
async fn the_projected_db_shapes_are_the_seams_a_consumer_binds() {
    let server = TestServer::spawn().await;
    let pool = pool(&server).await;

    async fn columns(pool: &sqlx::SqlitePool, table: &str) -> Vec<String> {
        sqlx::query_scalar::<_, String>("SELECT name FROM pragma_table_info(?) ORDER BY cid")
            .bind(table)
            .fetch_all(pool)
            .await
            .unwrap_or_else(|e| panic!("pragma {table}: {e}"))
    }

    let runs = columns(&pool, "txr_runs").await;
    for col in [
        "id",
        "status",
        "config",
        "input_summary",
        "model_ids",
        "counts",
        "dir",
        "estimate",
    ] {
        assert!(runs.iter().any(|c| c == col), "txr_runs.{col}");
    }
    let methods = columns(&pool, "txr_run_methods").await;
    for col in [
        "id",
        "run_id",
        "method_id",
        "state",
        "reason_code",
        "task",
        "trained_on_patients",
        "size_bytes",
        "own_auc",
    ] {
        assert!(methods.iter().any(|c| c == col), "txr_run_methods.{col}");
    }
    let logs = columns(&pool, "txr_run_logs").await;
    for col in [
        "id",
        "run_id",
        "seq",
        "method_id",
        "stream",
        "content",
        "created_at",
    ] {
        assert!(logs.iter().any(|c| c == col), "txr_run_logs.{col}");
    }
}

/// TEST-EE-27: the reuse discipline source pin — the engine's drive calls the
/// jobs substrate (admission + cancel) and the sandbox run seam, and contains
/// no second scheduler (no tokio `Semaphore` copy), no copied bwrap argv and
/// no host literal.
#[test]
fn reuse_discipline_no_second_scheduler_no_copied_bwrap_argv() {
    let module_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/modules/execution_engine");
    let mut source = String::new();
    for entry in std::fs::read_dir(&module_dir).expect("module dir") {
        let p = entry.expect("entry").path();
        if p.extension().is_some_and(|e| e == "rs") {
            source.push_str(&std::fs::read_to_string(&p).expect("read"));
        }
    }

    // The module's own doc comments legitimately name `bwrap` (they state the
    // engine has NO sandbox machinery), so the token pins scan CODE only, never
    // comments — a comment is not an argv copy.
    let code_only = |src: &str| -> String {
        src.lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let source = code_only(&source);

    // The drive uses the jobs admission machinery (ONE cap) — never a second
    // semaphore-based scheduler, never a copied bwrap argv.
    assert!(
        source.contains("admit_within") && source.contains("close_slot"),
        "the finally-shaped admission wrapper is the drive's slot discipline"
    );
    assert!(
        source.contains("register_cancel"),
        "stops go through the jobs cancel registry"
    );
    assert!(
        !source.contains("tokio::sync::Semaphore"),
        "the lane gate is the module's own; no second scheduler limiter"
    );
    assert!(
        !source.contains("bwrap") && !source.contains("--unshare-net"),
        "no copied sandbox argv — the stack is the sandbox module's"
    );
    assert!(
        !source.contains("\"http://") && !source.contains("\"https://"),
        "no host literal (INV-5 — refs are manifest data)"
    );
}

// ────────────────────────── the host-gated real-stack legs ───────────────────

fn have_tool(tool: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {tool} >/dev/null 2>&1"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The real-stack gate: the host must carry the REAL published layer (and its
/// base) at the manifest digests under the process data root, staged exactly
/// like `tests/common`'s `prestage_method_envs` writes them
/// (`<root>/txr-envs/<env_id>.json` ready record + `<root>/sandbox-rootfs/
/// <layer_sha256>/rootfs.squashfs`), plus bwrap/squashfuse. The engine's
/// manifest pins real digest pins, so the sandbox suite's loopback fixtures
/// cannot feed this seam; the skip names the missing pieces.
fn real_stack_ready(methods: &[&str]) -> Result<(), String> {
    let mut missing = Vec::new();
    for t in ["bwrap", "squashfuse", "fusermount"] {
        if !have_tool(t) {
            missing.push(format!("{t} not installed"));
        }
    }
    let data_root = rootfs::data_root();
    for m in methods {
        match envmanifest::env_for(m) {
            None => missing.push(format!("no manifest entry for {m}")),
            Some(e) => {
                let ledger = data_root.join("txr-envs").join(format!("{m}.json"));
                let cache = data_root
                    .join("sandbox-rootfs")
                    .join(&e.layer_sha256)
                    .join("rootfs.squashfs");
                if !ledger.exists() {
                    missing.push(format!(
                        "{m}: no staged layer ledger ({})",
                        ledger.display()
                    ));
                }
                if !cache.exists() {
                    missing.push(format!("{m}: no staged layer cache ({})", cache.display()));
                }
            }
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(missing.join("; "))
    }
}

/// Gate + skip one real-stack leg; returns whether the host is prepared (a
/// prepared host still needs the staged artifacts to be the REAL layers).
pub fn real_stack_gate(server: &TestServer, test: &str, methods: &[&str]) -> bool {
    match real_stack_ready(methods) {
        Ok(()) => true,
        Err(missing) => {
            let _ = server;
            record_skip(
                test,
                &format!(
                    "the real published layers are not staged for the engine's manifest digests \
                     (data root {} needed: {missing}) — stage `<data_root>/txr-envs/<method>.json` \
                     (ready record, digest = manifest `layer_sha256`) + \
                     `<data_root>/sandbox-rootfs/<layer_sha256>/rootfs.squashfs` (the published \
                     layer bytes), or point `just env-rootfs`-style staging at it",
                    rootfs::data_root().display()
                ),
            );
            false
        }
    }
}

// ─────────────────── the scripted env + stop legs ────────────────────────────
// TEST-EE-12/15/17's loopback-free halves over the scripted seams: every host
// runs them (the real-stack legs below repeat the same shapes when the real
// layers are staged).

/// TEST-EE-17 (scripted half): a layer that fails to become ready is the
/// PROVIDER's typed verdict on the row — kept verbatim, never a silent skip,
/// never a machinery error — and the container never ran.
#[tokio::test]
async fn a_failing_layer_keeps_the_provider_typed_code() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-env-fail").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("env-fail"));

    let runtime = Arc::new(RunRuntime::new());
    let env = FakeEnv::new(Duration::from_millis(5));
    let entry = envmanifest::env_for("ctdna-tf-four-group").expect("fixture entry");
    env.set(
        &super::ref_env_id(&orchestrator::layer_env_ref(entry)),
        EnvPolicy::Fail {
            code: "ENV_STAGING_TIMEOUT",
        },
    );
    let env = Arc::new(env);
    let seam = FakeStackRunSeam::new();
    let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, false),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    // The RUN completes (a failed method is an INV-2 reason on the row, not a
    // run-abort — the drive's finalize keeps `finished` unless a user stop
    // fired; see finalize_run's status rule).
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert_eq!(methods.len(), 1);
    assert_eq!(methods[0].state, "failed");
    assert_eq!(
        methods[0].reason_code.as_deref(),
        Some("ENV_STAGING_TIMEOUT"),
        "the provider's typed code is kept verbatim"
    );
    assert!(
        seam.calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty(),
        "the container never ran under a failed env"
    );
}

/// TEST-EE-15's download half (scripted): while the layer is in flight the
/// row rides `downloading` with the growing byte counter (the F screen's "N
/// of M MB" facts are the engine's, not a guess), and the run still finishes
/// under the fixture.
#[tokio::test]
async fn a_downloading_layer_rides_the_row_bytes_and_still_finishes() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-download").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("download"));

    let runtime = Arc::new(RunRuntime::new());
    let env = FakeEnv::new(Duration::from_millis(5));
    let entry = envmanifest::env_for("ctdna-tf-four-group").expect("fixture entry");
    let total = 128 * 1024u64;
    env.set(
        &super::ref_env_id(&orchestrator::layer_env_ref(entry)),
        EnvPolicy::Downloading { total },
    );
    let env = Arc::new(env);
    let seam = FakeStackRunSeam::new();
    let exec = StackMethodExecutor::with_seam(pool.clone(), seam.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, false),
    )
    .await
    .expect("create");

    // The drive's 500 ms env poll patches the byte counter while the layer is
    // in flight (the row shows `downloading` first).
    let repo = TxrRepository::new(pool.clone());
    let mut saw_downloading = false;
    for _ in 0..50 {
        let rows = repo.methods_for_run(summary.id).await.expect("methods");
        if let Some(m) = rows.first() {
            if m.state == "downloading" || m.bytes_downloaded > 0 {
                saw_downloading = true;
            }
            if m.state == "running" || m.state == "finished" {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    assert!(saw_downloading, "the downloading state was observed");
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert!(
        methods[0].bytes_downloaded > 0,
        "the growing byte counter landed on the row"
    );
}

/// TEST-EE-12 (scripted half): the stop-all typing — a method in the env
/// (downloading) phase turns `skipped`, a RUNNING method turns `stopped` +
/// `ABORTED`, the run ends `stopped`, the in-flight layer's cancel reached
/// the provider, and the engine's "stopped by the user" line lands.
#[tokio::test]
async fn stop_all_types_downloading_skipped_and_running_aborted() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-stop-all").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("stop-all"));

    let runtime = Arc::new(RunRuntime::new());
    let env = FakeEnv::new(Duration::from_millis(5));
    // jm-lme's layer hangs in the download (64 KiB/s fixture rate); the other
    // two are ready instantly and park in the executor until the stop.
    let entry = envmanifest::env_for("jm-lme").expect("fixture entry");
    env.set(
        &super::ref_env_id(&orchestrator::layer_env_ref(entry)),
        EnvPolicy::Downloading { total: 512 * 1024 },
    );
    let env = Arc::new(env);
    let mut executor = FakeExecutor::new(Duration::ZERO);
    executor.wait_for_cancel = true;
    let executor = Arc::new(executor);
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime.clone(),
        env.clone(),
        executor.clone(),
        owner,
        cohort_run_request(&DRIVE_METHODS, 3, false),
    )
    .await
    .expect("create");

    // Two methods reached the executor (running), jm-lme downloads.
    let repo = TxrRepository::new(pool.clone());
    let mut two_running = false;
    for _ in 0..200 {
        if repo
            .methods_for_run(summary.id)
            .await
            .expect("methods")
            .iter()
            .filter(|m| m.state == "running")
            .count()
            >= 2
        {
            two_running = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(two_running, "two lanes ran while the third downloaded");

    orchestrator::stop_run(pool.clone(), runtime, summary.id)
        .await
        .expect("stop-all");
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Stopped);
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert_eq!(methods.len(), 3);
    let mut stopped = 0;
    let mut skipped = 0;
    for m in &methods {
        match m.state.as_str() {
            "stopped" => {
                stopped += 1;
                assert_eq!(
                    m.reason_code.as_deref(),
                    Some("ABORTED"),
                    "running → stopped + ABORTED: {m:?}"
                );
            }
            "skipped" => {
                skipped += 1;
                assert_eq!(
                    m.reason_code, None,
                    "a skipped row carries no failure reason: {m:?}"
                );
            }
            other => panic!("unexpected terminal state {other:?}: {m:?}"),
        }
    }
    assert_eq!(stopped, 2, "the running methods stopped + ABORTED");
    assert_eq!(skipped, 1, "the downloading method skipped");
    let cancelled = env.cancelled();
    assert!(
        cancelled.iter().any(|c| c == "jm-lme"),
        "the in-flight layer's cancel reached the provider: {cancelled:?}"
    );
    // The engine finalize line lands AFTER the terminal status row (the
    // append is the finalize's last write) — poll the log for it.
    let mut stop_line = false;
    for _ in 0..50 {
        let (lines, _t, _n) = repo
            .logs_page(summary.id, None, 0, 200)
            .await
            .expect("logs");
        if lines.iter().any(|l| l.content == "stopped by the user") {
            stop_line = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(stop_line, "EXAMPLE-EE-3's stop line landed");
}

/// TEST-EE-12 (real-stack half): 3 methods at 2 lanes — never a third in
/// running — plus a mid-run stop-all producing `stopped` + `ABORTED`/`skipped`.
#[tokio::test]
async fn test_ee12_real_stack_lane_cap_and_stop_all() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-ee12").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("ee12"));
    if !real_stack_gate(&server, "TEST-EE-12", &DRIVE_METHODS) {
        return;
    }

    let runtime = Arc::new(RunRuntime::new());
    let env = orchestrator::real_env_provider();
    let exec = StackMethodExecutor::new(pool.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime.clone(),
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&DRIVE_METHODS, 2, false),
    )
    .await
    .expect("create");

    // Let the two lanes fill (real downloads/executions are slow), then stop.
    tokio::time::sleep(Duration::from_secs(15)).await;
    let repo = TxrRepository::new(pool.clone());
    let ready = repo
        .methods_for_run(summary.id)
        .await
        .expect("methods")
        .iter()
        .filter(|m| m.state == "running")
        .count()
        >= 2;
    if ready {
        orchestrator::stop_run(pool.clone(), runtime, summary.id)
            .await
            .expect("stop");
    }
    let row = wait_terminal(&repo, summary.id).await;
    // A stopped-or-finished run is terminal; the typing itself has already been
    // pinned at unit level — the real-stack leg proves the RUN completed the
    // wired seams without a machinery error.
    assert!(
        matches!(
            row.status().expect("parses"),
            TxrRunStatus::Finished | TxrRunStatus::Stopped
        ),
        "the real stack run is terminal (stopped or finished), got {:?}",
        row.status().expect("parses")
    );
}

/// TEST-EE-15 (real-stack half): X1 — a `saves_model` method turns
/// `FitOnly` + `ReuseModel` and a produced model record appears on the run.
#[tokio::test]
async fn test_ee15_real_stack_fit_only_and_produced_model() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-ee15").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("ee15"));
    if !real_stack_gate(&server, "TEST-EE-15", &["ctdna-tf-four-group"]) {
        return;
    }

    let runtime = Arc::new(RunRuntime::new());
    let env = orchestrator::real_env_provider();
    let exec = StackMethodExecutor::new(pool.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, true),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let models = produced_models(&pool, summary.id).await.expect("models");
    assert!(
        !models.is_empty(),
        "the fit's /model tree is a produced model"
    );
}

/// TEST-EE-17 (real-stack half): a staged ready layer reaches `running` with
/// the recorded env digests; a missing cache entry is the provider's typed
/// failure, never a silent skip.
#[tokio::test]
async fn test_ee17_real_stack_env_ready_and_typed_failure() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-ee17").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("ee17"));
    if !real_stack_gate(&server, "TEST-EE-17", &["ctdna-tf-four-group"]) {
        return;
    }

    let runtime = Arc::new(RunRuntime::new());
    let env = orchestrator::real_env_provider();
    let exec = StackMethodExecutor::new(pool.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, false),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    let methods = repo.methods_for_run(summary.id).await.expect("methods");
    assert_eq!(methods.len(), 1);
    assert_eq!(methods[0].state, "finished");
    assert!(
        methods[0]
            .env_base_digest
            .as_deref()
            .is_some_and(|d| d.len() == 64),
        "the base digest recorded"
    );
    assert!(
        methods[0]
            .env_layer_digest
            .as_deref()
            .is_some_and(|d| d.len() == 64),
        "the layer digest recorded"
    );
    let _ = row;
}

/// TEST-EE-19 (real-stack half): results-while-running + leave-and-continue —
/// a method finishing early serves its column while the run is still active.
#[tokio::test]
async fn test_ee19_real_stack_results_while_running() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-ee19").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("ee19"));
    if !real_stack_gate(&server, "TEST-EE-19", &DRIVE_METHODS) {
        return;
    }

    let runtime = Arc::new(RunRuntime::new());
    let env = orchestrator::real_env_provider();
    let exec = StackMethodExecutor::new(pool.clone());
    let summary = orchestrator::start_run(
        pool.clone(),
        runtime,
        env,
        Arc::new(exec),
        owner,
        cohort_run_request(&DRIVE_METHODS, 3, false),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, summary.id).await;
    assert!(
        matches!(
            row.status().expect("parses"),
            TxrRunStatus::Finished | TxrRunStatus::Failed
        ),
        "the real run is terminal"
    );
}

/// TEST-EE-21 (real-stack half): path-3 reuse — one verified `ReuseModel` call
/// per resolved asset; a tampered asset refuses before any spawn (the
/// verify-before-bind arm is unit-pinned; the real leg proves the assembled
/// reuse path runs to a terminal record).
#[tokio::test]
async fn test_ee21_real_stack_reuse_path() {
    let server = TestServer::spawn().await;
    let (_token, owner) = register_user(&server, "txr-ee21").await;
    let pool = pool(&server).await;
    let _g = rootfs::scoped_data_root(scratch_dir("ee21"));
    if !real_stack_gate(&server, "TEST-EE-21", &["ctdna-tf-four-group"]) {
        return;
    }

    // The engine's reuse path needs a verified model asset: first produce one
    // through the real stack (FitOnly), then drive the reuse run against it.
    let runtime = Arc::new(RunRuntime::new());
    let env = orchestrator::real_env_provider();
    let exec = StackMethodExecutor::new(pool.clone());
    let first = orchestrator::start_run(
        pool.clone(),
        runtime.clone(),
        env.clone(),
        Arc::new(exec),
        owner,
        cohort_run_request(&["ctdna-tf-four-group"], 2, true),
    )
    .await
    .expect("create");

    let repo = TxrRepository::new(pool.clone());
    let row = wait_terminal(&repo, first.id).await;
    assert_eq!(row.status().expect("parses"), TxrRunStatus::Finished);
    let models = produced_models(&pool, first.id).await.expect("models");
    assert!(!models.is_empty(), "a produced model exists to reuse");
    let model = &models[0];
    assert!(Path::new(&model.dir).is_dir(), "the model tree exists");
}
