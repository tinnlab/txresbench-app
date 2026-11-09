//! The `history_store` integration suites (ITEM-5's file set — TEST-HS-6/7/
//! 8/9/10/11/12/13/14/15/16/17/18/20/21/22/23): the boot + migration + route
//! legs, the shaped history view (list + detail) and the retention/usage
//! policy over the real spawned server (`TestServer` + the local-owner
//! mint), with rows seeded through the ENGINE's own repository over the
//! per-test DB — the `execution_engine`/`model_store` suites' discipline:
//! no method executes here, every stateful shape is seeded, and the seeds
//! are synthetic (generated file names, fixture patient ids S0000.., opaque
//! produced trees — never real data, never a restricted tree). One test
//! (TEST-HS-17) drives the engine's REAL create route (`POST /api/txr/runs`) —
//! the primary seeding path of DEC-18 — and pins that its history item
//! equals a direct-seeded run's item field-for-field, so both documented
//! paths produce identical view shapes.

mod api_test;
mod retention_test;
mod usage_test;
mod view_test;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use super::common::TestServer;
use cytoanalyst::modules::execution_engine::envmanifest;
use cytoanalyst::modules::execution_engine::repository::{
    MethodPatch, NewMethod, NewRun, TxrRepository,
};
use cytoanalyst::modules::execution_engine::types::{
    RunConfig, TxrEndpoint, TxrMethodState, TxrRunCounts, TxrRunEstimate, TxrRunFileNames,
    TxrRunInputSummary, TxrRunMode, TxrRunReason, TxrRunStatus, TxrTask,
};
use cytoanalyst::modules::method_catalogue::types::TimingQuality;
use cytoanalyst::modules::sandbox::stack::tree_sha256;

// ─────────────────────────────── shared helpers ──────────────────────────────

/// The 8-hex run-name salt (per-test unique-ish).
fn id8() -> String {
    static SEQ: AtomicUsize = AtomicUsize::new(1);
    format!("{:08x}", SEQ.fetch_add(1, Ordering::SeqCst))
}

/// The fixed-owner mint (the local session) → bearer token.
pub async fn owner_token(server: &TestServer) -> String {
    let resp = server
        .client
        .post(server.api_url("/session/local"))
        .json(&json!({}))
        .send()
        .await
        .expect("local session");
    assert_eq!(resp.status().as_u16(), 200, "local session mints the owner");
    let body: Value = resp.json().await.expect("session body");
    body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("session carries a token")
        .to_string()
}

/// The `error_code` of the framework error body.
pub fn error_code(body: &Value) -> String {
    body["error_code"]
        .as_str()
        .or_else(|| body["error"]["error_code"].as_str())
        .unwrap_or_else(|| panic!("no error_code in body: {body}"))
        .to_string()
}

/// The per-test pool (the same database the spawned server serves).
pub async fn pool(server: &TestServer) -> sqlx::SqlitePool {
    sqlx::SqlitePool::connect(server.database_url())
        .await
        .expect("per-test pool connects")
}

/// The catalogue-first facts of a seeded method row (label/version/group) —
/// the engine's own record, never re-authored here.
fn method_facts(method_id: &str) -> CatalogFacts {
    let m = cytoanalyst::modules::method_catalogue::catalogue::method(method_id)
        .expect("the seeded method is a catalogue method");
    CatalogFacts {
        label: m.id.clone(),
        version: m.version.clone(),
        group: m.group.as_str().to_string(),
    }
}

/// A catalogue method row's label/version/group facts.
struct CatalogFacts {
    label: String,
    version: String,
    group: String,
}

/// One seeded method row specification.
pub struct SeedMethod {
    pub method_id: &'static str,
    pub state: TxrMethodState,
    pub reason: Option<TxrRunReason>,
    pub elapsed_secs: Option<u64>,
    pub finished_at: Option<DateTime<Utc>>,
}

/// One seeded run row specification (the PROV-EE-10 shapes, synthetic).
pub struct SeedRun {
    pub status: TxrRunStatus,
    pub mode: TxrRunMode,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub elapsed_secs: Option<u64>,
    pub predictions_ready: bool,
    pub config: RunConfig,
    pub files: TxrRunFileNames,
    pub patients: Option<u32>,
    pub predict_patients: Option<u32>,
    pub markers: u32,
    pub model_ids: Vec<String>,
    pub estimate: Option<TxrRunEstimate>,
    pub methods: Vec<SeedMethod>,
    pub cpus: Option<u32>,
    pub memory_total_bytes: Option<u64>,
    pub seed: u32,
    /// The run dir the seed records (DEC-18's direct-data discipline: the
    /// data is the rows + the SHAPES; the dirs the engine would have created
    /// are synthetic) — see [`SeedDir`].
    pub dir: SeedDir,
}

/// Where a seeded run's `dir` points.
#[derive(Debug, Clone)]
pub enum SeedDir {
    /// Create `<data_root>/analysis-<name>-<id8>` with the engine's run-dir
    /// layout (input/ copies, bundles/, output/, models/) and record it as
    /// the run's `dir`.
    Create(&'static str),
    /// Record this exact string verbatim — no fs work (a tampered or foreign
    /// dir, or a dir that never existed).
    Record(String),
}

impl SeedRun {
    /// The EXAMPLE-HS-1 train run shape (finished, 2 methods, landmark 56 /
    /// horizon 238, 4 CPUs, 16 GB, 190 s, produced-model facts patched later).
    pub fn finished_train(name: &'static str, created_at: DateTime<Utc>) -> Self {
        Self {
            status: TxrRunStatus::Finished,
            mode: TxrRunMode::Train,
            created_at,
            started_at: Some("2026-10-19T14:31:00+00:00".parse().expect("fixture date")),
            finished_at: Some("2026-10-19T14:34:10+00:00".parse().expect("fixture date")),
            elapsed_secs: Some(190),
            predictions_ready: true,
            config: RunConfig {
                endpoint: cytoanalyst::modules::execution_engine::types::TxrEndpoint::Pfs,
                decision_day: 56.0,
                look_ahead_day: 238.0,
                covariates: true,
                at_a_time: 4,
                cpus: Some(4),
                save_models: true,
                label_day: None,
            },
            files: TxrRunFileNames {
                patients: Some("patients.csv".to_string()),
                measurements: "measurements.csv".to_string(),
                predict_measurements: Some("new_measurements.csv".to_string()),
            },
            patients: Some(151),
            predict_patients: Some(38),
            markers: 5,
            model_ids: Vec::new(),
            estimate: Some(TxrRunEstimate {
                total_seconds: 240.0,
                schedule_seconds: 240.0,
                estimate_quality: TimingQuality::Estimate,
            }),
            methods: vec![
                SeedMethod {
                    method_id: "landmark-cox-current",
                    state: TxrMethodState::Finished,
                    reason: None,
                    elapsed_secs: Some(120),
                    finished_at: Some(
                        "2026-10-19T14:33:00+00:00".parse().expect("fixture date"),
                    ),
                },
                SeedMethod {
                    method_id: "cox-cutpoint-risk",
                    state: TxrMethodState::Finished,
                    reason: None,
                    elapsed_secs: Some(70),
                    finished_at: Some(
                        "2026-10-19T14:34:00+00:00".parse().expect("fixture date"),
                    ),
                },
            ],
            cpus: Some(4),
            memory_total_bytes: Some(16 * 1024 * 1024 * 1024),
            seed: 1,
            dir: SeedDir::Create(name),
        }
    }
}

/// Insert one synthetic run (+ its method rows) through the ENGINE's own
/// repository (the declared PROV-EE-10 bindable seam — DEC-18's direct-seed
/// path; the repository restates nothing, the row shapes are the provider's
/// [NewRun]/[NewMethod]/[MethodPatch]). Returns `(run_id, run_dir)`.
pub async fn seed_run(server: &TestServer, repo: &TxrRepository, spec: SeedRun) -> (Uuid, PathBuf) {
    let run_id = Uuid::new_v4();
    let run_dir = match &spec.dir {
        SeedDir::Create(name) => {
            let dir = server
                .data_dir()
                .join(format!("analysis-{name}-{}", id8()));
            seed_run_dir(&dir, &spec.files, &spec.methods);
            dir
        }
        SeedDir::Record(raw) => PathBuf::from(raw.clone()),
    };
    let dir_owned = match &spec.dir {
        SeedDir::Create(_) => run_dir.display().to_string(),
        SeedDir::Record(raw) => raw.clone(),
    };

    let method_count: u32 = spec.methods.len() as u32;
    let counts = counts_for(&spec);
    let endpoint = spec.config.endpoint; // Copy — captured before the config move
    let run = NewRun {
        id: run_id,
        created_at: Some(spec.created_at),
        status: spec.status,
        mode: spec.mode,
        config: spec.config,
        input_summary: TxrRunInputSummary {
            patients: spec.patients,
            predict_patients: spec.predict_patients,
            markers: spec.markers,
            events: spec.patients,
            file_names: spec.files,
        },
        model_ids: spec.model_ids,
        method_count,
        counts: counts.clone(),
        dir: dir_owned,
        memory_total_bytes: spec.memory_total_bytes,
        cpus: spec.cpus,
        seed: spec.seed,
        estimate: spec.estimate,
    };
    repo.insert_run(&run).await.expect("seed run");

    // The engine's zero → prepared → finished transitions (started_at +
    // finished_at + elapsed + predictions_ready are NOT NewRun fields — the
    // state machine writes them; the seed drives the same repository calls).
    if let Some(started) = spec.started_at {
        repo.set_run_status(run_id, spec.status, Some(started))
            .await
            .expect("seed started_at");
    }
    if spec.status != TxrRunStatus::Running {
        repo.finish_run(
            run_id,
            spec.status,
            spec.elapsed_secs.unwrap_or(0),
            &counts,
            spec.predictions_ready,
            None,
        )
        .await
        .expect("seed terminal facts");
        if let Some(finished) = spec.finished_at {
            sqlx::query("UPDATE txr_runs SET finished_at = ?1 WHERE id = ?2")
                .bind(finished)
                .bind(run_id)
                .execute(repo.pool())
                .await
                .expect("seed finished_at");
        }
    }

    for m in &spec.methods {
        let facts = method_facts(m.method_id);
        let method = NewMethod {
            id: Uuid::new_v4(),
            run_id,
            method_id: m.method_id.to_string(),
            label: facts.label,
            version: facts.version,
            group: facts.group,
            state: m.state,
            bytes_total: None,
        };
        repo.insert_method(&method).await.expect("seed method");
        let mut patch = MethodPatch {
            state: Some(m.state),
            reason: m.reason.clone(),
            elapsed_secs: m.elapsed_secs,
            finished_at: m.finished_at,
            ..Default::default()
        };
        patch.task = task_for(m.method_id, endpoint);
        repo.patch_method(run_id, m.method_id, &patch)
            .await
            .expect("seed method facts");
    }

    (run_id, run_dir)
}

/// The per-state counts of a spec's methods (the run-level counters the
/// F header renders — the seed writes the same numbers the engine would).
fn counts_for(spec: &SeedRun) -> TxrRunCounts {
    let mut counts = TxrRunCounts {
        finished: 0,
        failed: 0,
        stopped: 0,
        skipped: 0,
        cannot_run: 0,
        running: 0,
        downloading: 0,
        waiting: 0,
    };
    for m in &spec.methods {
        match m.state {
            TxrMethodState::Finished => counts.finished += 1,
            TxrMethodState::Failed => counts.failed += 1,
            TxrMethodState::Stopped => counts.stopped += 1,
            TxrMethodState::CannotRun => counts.cannot_run += 1,
            TxrMethodState::Running | TxrMethodState::Downloading => counts.running += 1,
            TxrMethodState::Waiting => counts.waiting += 1,
            TxrMethodState::Skipped => counts.skipped += 1,
        }
    }
    counts
}

/// The task a catalogue method runs as, at the run's endpoint (the engine's
/// own `TxrRunOutcomeSpec` rule mirrored: `survival` → Pfs at a pfs run, Os
/// at an os run; `response` → Response; an unparsed combination → None).
fn task_for(method_id: &str, endpoint: TxrEndpoint) -> Option<TxrTask> {
    let m = cytoanalyst::modules::method_catalogue::catalogue::method(method_id)?;
    if m.tasks.iter().any(|t| t == "response") {
        return Some(TxrTask::Response);
    }
    if m.tasks.iter().any(|t| t == "survival") {
        return match endpoint {
            TxrEndpoint::Pfs => Some(TxrTask::Pfs),
            TxrEndpoint::Os => Some(TxrTask::Os),
        };
    }
    None
}

/// Create a synthetic run dir with the engine's layout: `input/` holding the
/// recorded copies at the engine's names (patients at `<sanitized stem>.csv`,
/// `measurements.csv`, `predict-measurements.csv`), `bundles/<method>/`,
/// `output/<method>/` and `models/<method>/`. The canonical CSVs +
/// `run-input.json` are the engine's own writes and are not part of a seed.
fn seed_run_dir(dir: &Path, files: &TxrRunFileNames, methods: &[SeedMethod]) {
    std::fs::create_dir_all(dir.join("input")).expect("seed input dir");
    if let Some(name) = &files.patients {
        let stem = Path::new(name)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "patients".to_string());
        std::fs::write(
            dir.join("input").join(format!("{stem}.csv")),
            b"patient_id,outcome\nS0001,0\nS0002,1\n",
        )
        .expect("seed patients copy");
    }
    std::fs::write(
        dir.join("input").join("measurements.csv"),
        b"patient_id,day,marker,value\nS0001,0,M1,0.1\n",
    )
    .expect("seed measurements copy");
    if files.predict_measurements.is_some() {
        std::fs::write(
            dir.join("input").join("predict-measurements.csv"),
            b"patient_id,day,marker,value\nS0039,0,M1,0.2\n",
        )
        .expect("seed predict copy");
    }
    for m in methods {
        let bundle = dir.join("bundles").join(m.method_id);
        std::fs::create_dir_all(&bundle).expect("seed bundle dir");
        std::fs::write(
            bundle.join("params.json"),
            json!({"contract": "2.0", "method": m.method_id}).to_string(),
        )
        .expect("seed params.json");
        let output = dir.join("output").join(m.method_id);
        std::fs::create_dir_all(&output).expect("seed output dir");
        std::fs::write(output.join("result.csv"), b"patient_id,prediction\nS0001,0.42\n")
            .expect("seed output csv");
        let models = dir.join("models").join(m.method_id);
        std::fs::create_dir_all(&models).expect("seed models dir");
    }
}

/// A synthetic produced tree (opaque bytes — the store never opens them for
/// meaning; the engine's own digest). Returns `(dir, digest, size)`.
pub fn fixture_tree(dir: &Path, variant: &str) -> (PathBuf, String, u64) {
    std::fs::create_dir_all(dir.join("weights")).expect("fixture tree dirs");
    std::fs::write(
        dir.join("model.json"),
        format!(r#"{{"contract":"2.0","method":"fixture","variant":"{variant}"}}"#),
    )
    .expect("fixture model.json");
    std::fs::write(
        dir.join("weights").join("tree-01.bin"),
        format!("opaque\x00{variant}\x00bytes"),
    )
    .expect("fixture tree file");
    let digest = tree_sha256(dir).expect("fixture digest");
    let size = std::fs::metadata(dir.join("model.json"))
        .expect("meta")
        .len()
        + std::fs::metadata(dir.join("weights").join("tree-01.bin"))
            .expect("meta")
            .len();
    (dir.to_path_buf(), digest, size)
}

/// Patch one seed method row to the FULL produced record (the PROV-EE-9
/// completeness facts: digest + dir + both env digests + trained_on_patients
/// + size_bytes — the batch-count rule the history view replicates).
pub async fn seed_produced_method(
    repo: &TxrRepository,
    run_id: Uuid,
    method_id: &str,
    model_dir: &Path,
    variant: &str,
) -> (String, u64) {
    let (dir, digest, size) = fixture_tree(model_dir, variant);
    let entry = envmanifest::env_for(method_id).expect("a manifest entry for the method");
    repo.patch_method(
        run_id,
        method_id,
        &MethodPatch {
            model_out_digest: Some(digest.clone()),
            model_dir: Some(dir.display().to_string()),
            env_base_digest: Some(
                entry
                    .base_digest
                    .strip_prefix("sha256:")
                    .unwrap_or(&entry.base_digest)
                    .to_string(),
            ),
            env_layer_digest: Some(entry.layer_sha256.clone()),
            trained_on_patients: Some(151),
            size_bytes: Some(size),
            finished_at: Some("2026-10-19T15:00:00+00:00".parse().expect("fixture date")),
            ..Default::default()
        },
    )
    .await
    .expect("patch produced-model facts");
    (digest, size)
}

/// The default train fixture config (landmark 56 / horizon 238, the board's
/// worked example).
pub fn config_pfs() -> RunConfig {
    RunConfig {
        endpoint: cytoanalyst::modules::execution_engine::types::TxrEndpoint::Pfs,
        decision_day: 56.0,
        look_ahead_day: 238.0,
        covariates: true,
        at_a_time: 2,
        cpus: Some(4),
        save_models: true,
        label_day: None,
    }
}

/// The default train fixture file names.
pub fn files_train() -> TxrRunFileNames {
    TxrRunFileNames {
        patients: Some("patients.csv".to_string()),
        measurements: "measurements.csv".to_string(),
        predict_measurements: None,
    }
}

// ─────────────────────────── the boot/migration/route legs ────────────────────

/// TEST-HS-6 (integration half) — the module registers in the REAL boot
/// (order 51 unique is the colocated pin; here: the health endpoint still
/// 200, the merged migration chain applied the module's two tables at boot
/// — the preference singleton seeded, retention empty — and the served
/// surface's route inventory, the committed OpenAPI, carries exactly the
/// seven History operations of `types::ROUTE_DOC_IDS`).
#[tokio::test]
async fn the_module_boots_and_serves_the_seven_history_operations() {
    let server = TestServer::spawn().await;

    // The health endpoint is still 200 with the module registered.
    let resp = server
        .client
        .get(server.api_url("/health"))
        .send()
        .await
        .expect("health");
    assert_eq!(resp.status().as_u16(), 200, "boot stays healthy");

    // The module's two tables exist after boot (the merged chain applied
    // them), with the migration's seed row and no lazy retention row yet.
    let pool = pool(&server).await;
    let (id, keep): (i64, i64) = sqlx::query_as(
        "SELECT id, keep_file_copies FROM txr_history_preferences WHERE id = 1",
    )
    .fetch_one(&pool)
    .await
    .expect("the preference singleton exists after boot");
    assert_eq!(id, 1);
    assert_eq!(keep, 1, "the migration seeds keep_file_copies = true");
    let retention: i64 = sqlx::query_scalar("SELECT count(*) FROM txr_run_retention")
        .fetch_one(&pool)
        .await
        .expect("retention table exists after boot");
    assert_eq!(retention, 0, "retention rows are lazy");

    // The served surface's inventory: the committed OpenAPI (the regen
    // output of the real router; ITEM-4's committed artifact) carries
    // exactly the 6 history paths / the 7 History.* operations — the
    // route-registration proof at the integration level.
    let spec = read_committed_openapi();
    let ops = history_operations(&spec);
    // The spec emits paths in the runner's registration order; the op-id SET
    // is the contract — the declared ORDER is pinned by the colocated routes
    // test (`ALL` == `ROUTE_DOC_IDS`).
    let mut ids: Vec<&str> = ops.iter().map(|op| op.1.as_str()).collect();
    ids.sort_unstable();
    let mut expected = cytoanalyst::modules::history_store::types::ROUTE_DOC_IDS.to_vec();
    expected.sort_unstable();
    assert_eq!(
        ids, expected,
        "the served surface carries exactly the seven History operations"
    );
}

/// TEST-HS-17 — the suite is registered in the aggregation file (a suite
/// `tests/` dir not declared as a `mod` is not compiled and not run — the
/// hand-list guard's DECLARED check), and the two documented seeding paths
/// (DEC-18: the engine's real create route, else the direct seed) produce
/// IDENTICAL view shapes: a run driven through `POST /api/txr/runs` and a
/// direct-seeded run carrying the same stored facts render the same
/// `TxrHistoryItem` field-for-field (only `id` differs).
#[test]
fn the_suite_is_registered_and_the_seeding_paths_share_one_shape() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let aggregation = std::fs::read_to_string(manifest.join("tests/integration_tests.rs"))
        .expect("integration_tests.rs reads");
    assert!(
        aggregation.contains("mod history_store;"),
        "tests/integration_tests.rs must declare the history_store suite \
         (an undeclared suite is never run)"
    );
    for file in [
        "tests/history_store/mod.rs",
        "tests/history_store/api_test.rs",
        "tests/history_store/view_test.rs",
        "tests/history_store/retention_test.rs",
        "tests/history_store/usage_test.rs",
    ] {
        assert!(
            manifest.join(file).is_file(),
            "{file} must be part of the suite (the plan's ITEM-5 file set)"
        );
    }
}

/// The engine's real create path half of TEST-HS-17 (the server-spawn half,
/// separate so the two assertions stay independent).
#[tokio::test]
async fn the_engine_create_path_and_the_direct_seed_render_the_same_item() {
    let server = TestServer::spawn().await;
    let token = owner_token(&server).await;
    let repo = TxrRepository::new(pool(&server).await);

    // The primary path: a REAL create through the engine's own route with a
    // catalogue method that needs no layer (jm-mem-lq — the engine suite's
    // embedded-facts posture: the run classifies the method cannot_run +
    // ENV_IMAGE_MISSING and finishes; no network, no sandbox).
    let resp = server
        .client
        .post(server.api_url("/txr/runs"))
        .bearer_auth(&token)
        .json(&crate::execution_engine::cohort_run_body(&["jm-mem-lq"], 1, false))
        .send()
        .await
        .expect("create");
    assert_eq!(resp.status().as_u16(), 202, "the engine admits the create");
    let created_id: Uuid = resp
        .json::<Value>()
        .await
        .expect("summary json")["id"]
        .as_str()
        .expect("id")
        .parse()
        .expect("uuid");
    let row = crate::execution_engine::wait_terminal(&repo, created_id).await;

    // The direct-seed path: mirror the created run's stored facts through
    // the engine's own [NewRun]/[NewMethod]/[MethodPatch] into a SECOND run
    // (same config/input_summary/counts/dir/timestamps/methods — only the id
    // is new).
    let summary = row.summarize(vec![]).expect("summarize");
    let estimate = row.estimate().expect("estimate");
    let mirrored_id = Uuid::new_v4();
    let new_run = NewRun {
        id: mirrored_id,
        created_at: Some(summary.created_at),
        status: summary.status,
        mode: summary.mode,
        config: summary.config,
        input_summary: summary.input_summary,
        model_ids: summary.model_ids,
        method_count: row.method_count as u32,
        counts: summary.counts,
        dir: summary.dir.clone(),
        memory_total_bytes: row.memory_total_bytes.map(|v| v as u64),
        cpus: row.cpus.map(|c| c as u32),
        seed: row.seed as u32,
        estimate,
    };
    repo.insert_run(&new_run).await.expect("mirror run");
    sqlx::query(
        "UPDATE txr_runs SET started_at = ?1, finished_at = ?2, elapsed_secs = ?3, \
         predictions_ready = ?4 WHERE id = ?5",
    )
    .bind(row.started_at)
    .bind(row.finished_at)
    .bind(row.elapsed_secs)
    .bind(row.predictions_ready)
    .bind(mirrored_id)
    .execute(repo.pool())
    .await
    .expect("mirror terminal facts");
    // The method rows are mirrored as EXACT row copies (a raw INSERT-SELECT
    // over the engine's own column set with a fresh id per row — the same
    // "rows seeded directly with the same shapes" of DEC-18's fallback; the
    // engine suite's own raw-UPDATE precedent for test-only row facts), so
    // the two run records differ ONLY in `id` — every projection (the list
    // row AND the detail's rich method rows) must agree.
    sqlx::query(
        "INSERT INTO txr_run_methods (id, run_id, method_id, label, version, \"group\", state, \
         reason_code, reason_detail, phase, bytes_downloaded, bytes_total, job_id, \
         env_base_digest, env_layer_digest, model_out_digest, model_dir, exit_code, \
         duration_ms, elapsed_secs, prob_source, coverage_scored, coverage_eligible, task, \
         started_at, finished_at, trained_on_patients, size_bytes, own_auc) \
         SELECT randomblob(16), ?1, method_id, label, version, \"group\", state, reason_code, \
         reason_detail, phase, bytes_downloaded, bytes_total, job_id, env_base_digest, \
         env_layer_digest, model_out_digest, model_dir, exit_code, duration_ms, elapsed_secs, \
         prob_source, coverage_scored, coverage_eligible, task, started_at, finished_at, \
         trained_on_patients, size_bytes, own_auc \
         FROM txr_run_methods WHERE run_id = ?2",
    )
    .bind(mirrored_id)
    .bind(created_id)
    .execute(repo.pool())
    .await
    .expect("mirror method rows");

    // The view-shape parity: the two runs' list items are equal field-for-
    // field except for `id` (a deep object compare on the wire JSON).
    let created_item = history_item(&server, &token, created_id).await;
    let mirrored_item = history_item(&server, &token, mirrored_id).await;
    assert_ne!(created_item["id"], mirrored_item["id"]);
    let mut created = created_item.clone();
    let mut mirrored = mirrored_item.clone();
    created.as_object_mut().expect("obj").remove("id");
    mirrored.as_object_mut().expect("obj").remove("id");
    assert_eq!(
        created, mirrored,
        "the engine-create path and the direct-seed path must render the \
         same TxrHistoryItem field-for-field (DEC-18)"
    );

    // The detail blocks agree on the same shared fields too (the same one
    // projection rule feeds both).
    let d_created = history_detail(&server, &token, created_id).await;
    let d_mirrored = history_detail(&server, &token, mirrored_id).await;
    assert_shared_fields_match(&created_item, &d_created);
    assert_shared_fields_match(&mirrored_item, &d_mirrored);
    assert_eq!(
        d_created["methods"], d_mirrored["methods"],
        "the mirror is an exact row copy — the detail's rich method rows agree too"
    );
}

/// The wire keys `TxrHistoryItem` and `TxrHistoryDetail` share (the
/// projection's row half spelled out in both — the ITEM-2 parity pin): every
/// shared key must be deep-equal between the two responses. `methods` is
/// deliberately excluded: one JSON name carries two shapes by design (the
/// row's compact `{id, version, elapsed_secs}` refs vs the block's rich
/// engine `TxrRunMethod` rows — DRIFT-1 ITEM-1 #3/§c); `method_count` pins
/// the count agreement instead.
pub fn assert_shared_fields_match(item: &Value, detail: &Value) {
    for key in [
        "id",
        "mode",
        "bucket",
        "created_at",
        "started_at",
        "finished_at",
        "elapsed_secs",
        "estimate_total_seconds",
        "method_count",
        "file_names",
        "learned_from",
        "predicted",
        "markers",
        "endpoint",
        "decision_day",
        "look_ahead_day",
        "reason",
        "models_made",
        "models_used",
        "copies_kept",
        "can_rerun",
        "can_reopen",
        "can_download",
        "dir",
        "markers_saved",
    ] {
        assert_eq!(
            item[key], detail[key],
            "the shared wire key {key:?} must agree between the list row and the detail block"
        );
    }
}

/// GET one run's history list item by id (the parity helper of TEST-HS-17).
async fn history_item(server: &TestServer, token: &str, id: Uuid) -> Value {
    let resp = server
        .client
        .get(server.api_url("/txr/history"))
        .bearer_auth(token)
        .query(&[("limit", "100")])
        .send()
        .await
        .expect("history list");
    assert_eq!(resp.status().as_u16(), 200);
    let page: Value = resp.json().await.expect("page json");
    page["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|i| i["id"] == id.to_string())
        .cloned()
        .expect("the run is listed")
}

/// GET one run's history detail (the parity helper of TEST-HS-17).
async fn history_detail(server: &TestServer, token: &str, id: Uuid) -> Value {
    let resp = server
        .client
        .get(server.api_url(&format!("/txr/history/{id}")))
        .bearer_auth(token)
        .send()
        .await
        .expect("detail");
    assert_eq!(resp.status().as_u16(), 200);
    resp.json().await.expect("detail json")
}

/// Read the committed OpenAPI spec (the regen output of the real router —
/// the served-surface inventory).
pub fn read_committed_openapi() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../ui/openapi/openapi.json")
        .canonicalize()
        .expect("the committed openapi.json exists (the regen output)");
    serde_json::from_str(
        &std::fs::read_to_string(&path).expect("openapi.json reads"),
    )
    .expect("openapi.json is valid JSON")
}

/// The `(path, operation_id)` pairs of every history operation in the spec.
pub fn history_operations(spec: &Value) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (path, item) in spec["paths"].as_object().expect("paths") {
        if !path.starts_with("/api/txr/history") {
            continue;
        }
        for (verb, op) in item.as_object().expect("path item") {
            if matches!(verb.as_str(), "get" | "put" | "post" | "delete" | "patch") {
                let id = op["operationId"]
                    .as_str()
                    .expect("operationId")
                    .to_string();
                out.push((path.clone(), id));
            }
        }
    }
    out.sort();
    out
}
