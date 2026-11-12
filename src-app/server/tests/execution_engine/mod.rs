//! The `execution_engine` integration suites (ITEM-11's file set —
//! TEST-EE-05/12/13/14/15/17/18/19/20/21/25/26/27/30/32/33/34/35/36).
//!
//! Two tiers, mirroring the plan's own split of the item:
//!
//! * `api_test.rs` — the HTTP surface over the real spawned server
//!   (`TestServer` + the local-owner mint): the route matrix, the
//!   embedded-data posture, the History (K) surface, the predictions +
//!   SSE replay contracts over SEEDED run rows, and the shipped-file
//!   hygiene legs. No method executes here: every stateful shape is
//!   seeded through the module's own repository over the per-test DB
//!   (`TestServer::database_url`), which is what makes the wire pins
//!   deterministic without a real method image.
//! * `run_flow_test.rs` + `predictions_test.rs` — the engine's own drive
//!   + real executor driven IN THIS PROCESS over the harness template DB
//!   with scripted seams (the `StackRunSeam`/`EnvProvider` trait objects
//!   the production wiring installs): the admission contract, the
//!   run-dir tree, live log streaming, the mid-run at-a-time change, the
//!   growth fields (model facts + `task` enum) and the conversion-band
//!   pins (`prob_source` native/recalibrated, training-only fit, the
//!   recorded `chance.csv`). The real-bwrap legs (TEST-EE-12/15/17/19/21
//!   + the container-fed leg of TEST-EE-14) are gated on the host
//!   actually carrying the REAL layer artifacts at the manifest digests
//!   and self-skip via `record_skip` otherwise (the `tests/sandbox`
//!   discipline; `TXR_TEST_NO_SKIP=1` turns a skip into a hard failure).
//! * `bundle_test.rs` — the contract-2.0 bundle assembly from the REAL
//!   embedded catalogue facts + the synthetic-fixture hygiene.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use uuid::Uuid;

use super::common::TestServer;
use txresbench::modules::execution_engine::orchestrator;
use txresbench::modules::execution_engine::repository::TxrRepository;
use txresbench::modules::execution_engine::types::{
    RunConfig, TxrMethodState, TxrProbSource, TxrRunMode, TxrRunStatus, TxrTask,
};
use txresbench::modules::file_validator::types::ParsedTable;
use txresbench::modules::sandbox::backend::{MilestoneFrame, ProgressFrame, ProgressSink};
use txresbench::modules::sandbox::method_env::{EnvKind, ProvidedMount};
use txresbench::modules::sandbox::stack::{
    EnvRef, MethodRunMode, MethodRunRequest, MethodRunResult,
};
use txresbench_core::AppError;

mod api_test;
mod bundle_test;
mod predictions_test;
mod run_flow_test;

// ─────────────────────────────── shared helpers ──────────────────────────────

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

/// Register a normal user (gets the seeded `Users` group + `jobs::use`) and
/// return `(token, user_id)` — the in-process drives' `owner` half: the
/// admitted `jobs` row's `owner_id` FK must resolve inside the same per-test
/// DB the drive reads.
pub async fn register_user(server: &TestServer, username: &str) -> (String, Uuid) {
    let resp = server
        .client
        .post(server.api_url("/auth/register"))
        .json(&json!({
            "username": username,
            "email": format!("{username}@txr.test"),
            "password": "txrUserP0!",
            "permissions": []
        }))
        .send()
        .await
        .expect("register request");
    let status = resp.status().as_u16();
    assert!(status == 201 || status == 200, "register -> {status}");
    let body: Value = resp.json().await.expect("register json");
    let token = body["access_token"]
        .as_str()
        .or_else(|| body["token"].as_str())
        .expect("register carries a token")
        .to_string();
    let me: Value = server
        .client
        .get(server.api_url("/auth/me"))
        .bearer_auth(&token)
        .send()
        .await
        .expect("/auth/me")
        .json()
        .await
        .expect("/auth/me json");
    let id = me["user"]["id"].as_str().expect("user id").to_string();
    let id = Uuid::parse_str(&id).expect("user id is a uuid");
    (token, id)
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

/// One wire `ParsedTable` from string rows (data rows only; header at file
/// row 1).
pub fn table(name: &str, columns: &[&str], rows: &[Vec<String>]) -> Value {
    table_strings(name, columns, rows.to_vec())
}

/// One wire `ParsedTable` from owned string rows.
pub fn table_strings(name: &str, columns: &[&str], rows: Vec<Vec<String>>) -> Value {
    let rows: Vec<Vec<Value>> = rows
        .iter()
        .map(|r| r.iter().cloned().map(Value::String).collect())
        .collect();
    json!({
        "source": {"name": name, "format": "csv"},
        "header_row": 1,
        "columns": columns,
        "rows": rows,
    })
}

/// The in-process twin of [`table`] (the drive's `validate` call takes the
/// typed value; the wire body takes the JSON).
pub fn parsed_table(name: &str, columns: &[&str], rows: &[Vec<String>]) -> ParsedTable {
    ParsedTable {
        source: txresbench::modules::file_validator::types::ParsedTableSource {
            name: name.to_string(),
            format: txresbench::modules::file_validator::types::TableFormat::Csv,
        },
        header_row: 1,
        columns: columns.iter().map(|c| c.to_string()).collect(),
        rows: rows
            .iter()
            .map(|r| r.iter().map(|c| Some(c.to_string())).collect())
            .collect(),
    }
}

/// The 30-patient cohort fixture (ITEM-9 note (hh): the cross-fit folds keep a
/// ≥ `MIN_TRAINING_PATIENTS` rest subset). The outcome pattern is engineered
/// for both label consumers: the IPCW-kept labels RISE with the fixture risk
/// order (the low-risk half's follow-up runs BEYOND the 238-day horizon →
/// label 0 kept; the high-risk half events INSIDE the horizon → label 1
/// kept), so the conversion band's fitted logistic rises with the risk AND
/// the own-data AUC sees both label classes (GAP-C) — an alternating
/// pattern would fall back to the package's constant map. Every fact is an
/// in-test construct (TEST-EE-22: ids `C01..C30`, one marker, no data folder
/// path anywhere).
pub fn cohort_patients_table() -> Value {
    let mut rows = Vec::new();
    for i in 1..=30 {
        let id = format!("C{i:02}");
        let pfs = if i > 15 {
            120 + (i - 15) * 3
        } else {
            240 + i * 3
        };
        let os = if i > 15 {
            130 + (i - 15) * 3
        } else {
            250 + i * 3
        };
        rows.push(vec![
            id,
            (pfs as f64).to_string(),
            if i > 15 { "1" } else { "0" }.to_string(),
            (os as f64).to_string(),
            if i > 15 { "1" } else { "0" }.to_string(),
        ]);
    }
    table(
        "patients.csv",
        &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
        &rows,
    )
}

pub fn cohort_measurements_table() -> Value {
    let mut rows = Vec::new();
    for i in 1..=30 {
        let id = format!("C{i:02}");
        for (day, value) in [("0", "100"), ("28", "110"), ("56", "105")] {
            rows.push(vec![
                id.clone(),
                day.to_string(),
                "14804-9".to_string(),
                value.to_string(),
                "U/L".to_string(),
            ]);
        }
    }
    table(
        "values.csv",
        &["patient_id", "day", "marker", "value", "unit"],
        &rows,
    )
}

pub fn cohort_patients_parsed() -> ParsedTable {
    let mut rows = Vec::new();
    for i in 1..=30 {
        let id = format!("C{i:02}");
        let pfs = if i > 15 {
            120 + (i - 15) * 3
        } else {
            240 + i * 3
        };
        let os = if i > 15 {
            130 + (i - 15) * 3
        } else {
            250 + i * 3
        };
        rows.push(vec![
            id,
            (pfs as f64).to_string(),
            if i > 15 { "1" } else { "0" }.to_string(),
            (os as f64).to_string(),
            if i > 15 { "1" } else { "0" }.to_string(),
        ]);
    }
    parsed_table(
        "patients.csv",
        &["patient_id", "pfs_days", "pfs_event", "os_days", "os_event"],
        &rows,
    )
}

pub fn cohort_measurements_parsed() -> ParsedTable {
    let mut rows = Vec::new();
    for i in 1..=30 {
        let id = format!("C{i:02}");
        for (day, value) in [("0", "100"), ("28", "110"), ("56", "105")] {
            rows.push(vec![
                id.clone(),
                day.to_string(),
                "14804-9".to_string(),
                value.to_string(),
                "U/L".to_string(),
            ]);
        }
    }
    parsed_table(
        "values.csv",
        &["patient_id", "day", "marker", "value", "unit"],
        &rows,
    )
}

/// The wire `CreateRunRequest` body over the cohort fixture (one JSON source
/// for the HTTP tests; the same shapes the in-crate unit fixtures build).
pub fn cohort_run_body(methods: &[&str], at_a_time: u32, save_models: bool) -> Value {
    json!({
        "mode": "train",
        "input": {
            "patients": cohort_patients_table(),
            "measurements": cohort_measurements_table(),
            "predict_measurements": null,
            "joins": [],
            "mapping": [],
            "keep_copies": true,
        },
        "config": {
            "endpoint": "pfs",
            "decision_day": 56.0,
            "look_ahead_day": 238.0,
            "covariates": false,
            "at_a_time": at_a_time,
            "cpus": null,
            "save_models": save_models,
            "label_day": null,
        },
        "method_ids": methods,
        "model_ids": [],
    })
}

/// The in-process `CreateRunRequest` twin (for the drive-level tests).
#[allow(clippy::too_many_arguments)]
pub fn cohort_run_request(
    methods: &[&str],
    at_a_time: u32,
    save_models: bool,
) -> txresbench::modules::execution_engine::types::CreateRunRequest {
    txresbench::modules::execution_engine::types::CreateRunRequest {
        mode: TxrRunMode::Train,
        input: txresbench::modules::execution_engine::types::TxrRunInput {
            patients: Some(cohort_patients_parsed()),
            measurements: cohort_measurements_parsed(),
            predict_measurements: None,
            joins: Vec::new(),
            mapping: Vec::new(),
            keep_copies: true,
        },
        config: RunConfig {
            at_a_time,
            decision_day: 56.0,
            look_ahead_day: 238.0,
            save_models,
            ..Default::default()
        },
        method_ids: methods.iter().map(|s| s.to_string()).collect(),
        model_ids: Vec::new(),
    }
}

/// Poll a run row until it is terminal (or panic).
pub async fn wait_terminal(
    repo: &TxrRepository,
    run_id: Uuid,
) -> txresbench::modules::execution_engine::repository::RunRow {
    for _ in 0..1000 {
        if let Some(r) = repo.get_run(run_id).await.expect("get_run") {
            let s = r.status().expect("status parses");
            if matches!(
                s,
                TxrRunStatus::Finished | TxrRunStatus::Failed | TxrRunStatus::Stopped
            ) {
                return r;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("run {run_id} did not turn terminal");
}

/// The fixture drive's scratch root (gitignored `target/` by default, like the
/// in-crate fixtures; `TXR_TEST_SCRATCH` relocates it — runbooks point it at
/// the build area, never `/tmp`).
pub fn scratch_dir(name: &str) -> PathBuf {
    if let Ok(dir) = std::env::var("TXR_TEST_SCRATCH") {
        return PathBuf::from(dir).join(name);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("target")
        .join("txr-execution-engine-item11")
        .join(name)
}

// ─────────────────────────── the scripted drive seams ────────────────────────
//
// The trait-object stand-ins for the production wiring (CONS-EE-5/EE-7): the
// drive holds `Arc<dyn EnvProvider>` + `Arc<dyn MethodExecutor>`, so the
// integration tests install the SAME objects the module does minus the
// sandbox, and drive the REAL run path end to end (start_run →
// classification → env phase → admission → executor → repository finalize).

/// The per-`env_id` policy of [`FakeEnv`] — the `Downloading` policy doubles
/// the manifest's `size_bytes` denominator for the progress counter pin.
#[derive(Clone, Copy)]
pub enum EnvPolicy {
    Ready,
    Downloading { total: u64 },
    Fail { code: &'static str },
}

/// The scripted env provider (the ITEM-8 fixture shape): `ensure` sleeps the
/// fixture delay and answers the policy; `status` derives a growing byte
/// counter for the `downloading` state (the drive's 500 ms poll reads it).
pub struct FakeEnv {
    inner: Arc<FakeEnvInner>,
}

struct FakeEnvInner {
    ensure_delay: Duration,
    policy: Mutex<std::collections::HashMap<String, EnvPolicy>>,
    progress: Mutex<std::collections::HashMap<String, (std::time::Instant, u64)>>,
    cancelled: Mutex<Vec<String>>,
}

impl FakeEnv {
    pub fn new(delay: Duration) -> Self {
        Self {
            inner: Arc::new(FakeEnvInner {
                ensure_delay: delay,
                policy: Mutex::new(std::collections::HashMap::new()),
                progress: Mutex::new(std::collections::HashMap::new()),
                cancelled: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn set(&self, env_id: &str, policy: EnvPolicy) {
        self.inner
            .policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(env_id.to_string(), policy);
    }

    pub fn cancelled(&self) -> Vec<String> {
        self.inner
            .cancelled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

fn ref_env_id(r: &EnvRef) -> String {
    r.oci_ref
        .rsplit('/')
        .next()
        .unwrap_or(&r.oci_ref)
        .split('@')
        .next()
        .unwrap_or(&r.oci_ref)
        .to_string()
}

impl orchestrator::EnvProvider for FakeEnv {
    fn ensure(
        &self,
        r: &EnvRef,
        _kind: EnvKind,
        _deadline: Duration,
    ) -> Result<ProvidedMount, AppError> {
        let env_id = ref_env_id(r);
        let policy = self
            .inner
            .policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&env_id)
            .copied()
            .unwrap_or(EnvPolicy::Ready);
        self.inner
            .progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(env_id, (std::time::Instant::now(), 0));
        std::thread::sleep(self.inner.ensure_delay);
        match policy {
            EnvPolicy::Fail { code } => Err(AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                code,
                "fixture download failed",
            )),
            // The fixture download completes at the status counter's own rate
            // (64 KiB/s): the ensure returns once the fake stream would have
            // delivered `total`, so the drive's 500 ms poll observes the
            // `downloading` state (TEST-EE-15's scripted leg).
            EnvPolicy::Downloading { total } => {
                std::thread::sleep(Duration::from_secs_f64(total as f64 / (64.0 * 1024.0)));
                Ok(ProvidedMount {
                    mount_dir: PathBuf::from("/fixture-mount"),
                    digest: Some("a".repeat(64)),
                })
            }
            EnvPolicy::Ready => Ok(ProvidedMount {
                mount_dir: PathBuf::from("/fixture-mount"),
                digest: Some("a".repeat(64)),
            }),
        }
    }

    fn status(&self, env_id: &str) -> txresbench::modules::sandbox::method_env::MethodEnvStatus {
        let policy = self
            .inner
            .policy
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(env_id)
            .copied()
            .unwrap_or(EnvPolicy::Ready);
        let mut progress = self
            .inner
            .progress
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let (started, bytes) = progress
            .get(env_id)
            .copied()
            .unwrap_or((std::time::Instant::now(), 0));
        let state = match policy {
            EnvPolicy::Fail { .. } => {
                txresbench::modules::sandbox::method_env::MethodEnvState::Failed
            }
            EnvPolicy::Ready => txresbench::modules::sandbox::method_env::MethodEnvState::Ready,
            EnvPolicy::Downloading { total } => {
                let mut now = bytes;
                if now < total {
                    now = ((started.elapsed().as_secs_f64() * 64.0 * 1024.0) as u64).min(total);
                    progress.insert(env_id.to_string(), (started, now));
                }
                if now >= total {
                    txresbench::modules::sandbox::method_env::MethodEnvState::Ready
                } else {
                    txresbench::modules::sandbox::method_env::MethodEnvState::Downloading
                }
            }
        };
        txresbench::modules::sandbox::method_env::MethodEnvStatus {
            env_id: env_id.to_string(),
            kind: EnvKind::Layer,
            state,
            bytes_downloaded: bytes,
            bytes_total: match policy {
                EnvPolicy::Downloading { total } => Some(total),
                _ => None,
            },
            digest: None,
            mounted: false,
            error: None,
        }
    }

    fn cancel(&self, env_id: &str) {
        self.inner
            .cancelled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(env_id.to_string());
    }
}

/// The terminal fixture outcome (the ITEM-9 unit shape — model facts for the
/// produced-model pins; the `task` is pinned by TEST-EE-35's row asserts).
pub fn finish_outcome() -> orchestrator::MethodOutcome {
    orchestrator::MethodOutcome {
        state: TxrMethodState::Finished,
        reason: None,
        exit_code: Some(0),
        duration_ms: Some(42),
        prob_source: Some(TxrProbSource::Native),
        coverage: Some(txresbench::modules::execution_engine::types::TxrCoverage {
            scored: 30,
            eligible: 30,
            fraction: 1.0,
        }),
        task: Some(TxrTask::Pfs),
        model: Some(orchestrator::ProducedModelFacts {
            model_out_digest: "aa".repeat(32),
            dir: "/fixture/model".to_string(),
            trained_on_patients: 30,
            size_bytes: 1234,
            own_auc: Some(0.7),
        }),
    }
}

/// The scripted method executor: records every execution, tracks the
/// concurrency peak (the lane-cap observable), optionally waits on the cancel
/// signal (the stop path) or fails with a typed code.
pub struct FakeExecutor {
    pub sleep: Duration,
    pub runs: Arc<Mutex<Vec<String>>>,
    pub concurrency: Arc<AtomicUsize>,
    pub peak: Arc<AtomicUsize>,
    pub fail_code: Option<&'static str>,
    pub wait_for_cancel: bool,
}

impl FakeExecutor {
    pub fn new(sleep: Duration) -> Self {
        Self {
            sleep,
            runs: Arc::new(Mutex::new(Vec::new())),
            concurrency: Arc::new(AtomicUsize::new(0)),
            peak: Arc::new(AtomicUsize::new(0)),
            fail_code: None,
            wait_for_cancel: false,
        }
    }
}

#[async_trait::async_trait]
impl orchestrator::MethodExecutor for FakeExecutor {
    async fn execute(
        &self,
        ctx: orchestrator::MethodRunContext,
    ) -> Result<orchestrator::MethodOutcome, AppError> {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(ctx.method_id.clone());
        let now = self.concurrency.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = self.peak.fetch_max(now, Ordering::SeqCst);
        if self.wait_for_cancel {
            let mut cancel = ctx.cancel;
            tokio::select! {
                _ = cancel.changed() => {}
                _ = tokio::time::sleep(Duration::from_secs(30)) => {}
            }
            self.concurrency.fetch_sub(1, Ordering::SeqCst);
            if *cancel.borrow() {
                return Err(AppError::new(
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "ABORTED",
                    "fixture: cancelled by the user",
                ));
            }
            return Ok(finish_outcome());
        }
        tokio::time::sleep(self.sleep).await;
        self.concurrency.fetch_sub(1, Ordering::SeqCst);
        if let Some(code) = self.fail_code {
            return Err(AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                code,
                "fixture execution failure",
            ));
        }
        Ok(finish_outcome())
    }
}

/// The scripted container: reads the bundle the engine wrote
/// (`test/patients.csv`, `params.json`), records every call's mode/mount, and
/// writes the contract-2.0 prediction columns the ITEM-5/6 ingest reads —
/// `risk` varying (the ≥ 5 scored constant rule), plus the native columns the
/// two fixture methods declare (the ITEM-9 unit shape).
pub struct FakeStackRunSeam {
    pub calls: Arc<Mutex<Vec<SeamCall>>>,
    pub fail: Arc<Mutex<Option<(i32, bool)>>>,
    /// The column writer override (a test that needs a shifted/native/managed
    /// output installs one; the default writes the unit fixture's columns).
    /// The first argument is the zero-based call number (fit → training
    /// scores → final predict), so a test can tell the training-scoring call
    /// apart from the predict call.
    pub writer: Arc<
        Mutex<
            Option<
                Box<
                    dyn Fn(usize, &PathBuf, &PathBuf, &[String]) -> std::io::Result<()>
                        + Send
                        + Sync,
                >,
            >,
        >,
    >,
    /// The fixture container's wall-clock lag, BEFORE the outputs are written.
    pub delay: Duration,
    /// The zero-based per-call counter.
    pub call_count: Arc<AtomicUsize>,
}

#[derive(Debug, Clone)]
pub struct SeamCall {
    pub mode: MethodRunMode,
    pub mount: Option<(String, String)>,
    pub model_out: Option<PathBuf>,
    pub scored: Vec<String>,
    pub params: Value,
    pub has_train: bool,
}

impl FakeStackRunSeam {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            fail: Arc::new(Mutex::new(None)),
            writer: Arc::new(Mutex::new(None)),
            delay: Duration::ZERO,
            call_count: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// The fixture container's wall-clock lag (a live-run window the tests
    /// observe — log lines/prediction frames while the call is in flight).
    pub fn new_delayed(delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            fail: Arc::new(Mutex::new(None)),
            writer: Arc::new(Mutex::new(None)),
            delay,
            call_count: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub fn read_params(bundle_dir: &std::path::Path) -> Value {
        std::fs::read_to_string(bundle_dir.join("params.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| json!({}))
    }

    /// The scored ids of `bundle_dir/test/patients.csv` (column 0).
    pub fn read_scored(bundle_dir: &std::path::Path) -> Vec<String> {
        let text = std::fs::read_to_string(bundle_dir.join("test").join("patients.csv"))
            .unwrap_or_default();
        text.lines()
            .skip(1)
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.split(',').next().unwrap_or_default().to_string())
            .collect()
    }

    pub fn write_predictions(
        outputs_dir: &std::path::Path,
        scored: &[String],
    ) -> std::io::Result<()> {
        let mut csv = String::from(
            "patient_id,risk,risk_progression,risk_death,p_progression_H238,p_death_H238,call,note\n",
        );
        for (i, id) in scored.iter().enumerate() {
            let risk = 0.1 + (i as f64) * 0.05;
            let prob = 0.2 + ((i % 12) as f64) * 0.05;
            csv.push_str(&format!("{id},{risk},{risk},{risk},{prob},{prob},1,\n"));
        }
        std::fs::create_dir_all(outputs_dir)?;
        std::fs::write(outputs_dir.join("predictions.csv"), csv)?;
        std::fs::write(outputs_dir.join("run.json"), "{\"fixture\": true}")?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl orchestrator::StackRunSeam for FakeStackRunSeam {
    async fn run(
        &self,
        req: &MethodRunRequest,
        _job_id: Uuid,
        sink: Arc<dyn ProgressSink>,
    ) -> Result<MethodRunResult, AppError> {
        let scored = Self::read_scored(&req.bundle_dir);
        let params = Self::read_params(&req.bundle_dir);
        let has_train = req.bundle_dir.join("train").is_dir();
        self.calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(SeamCall {
                mode: req.mode,
                mount: req
                    .model
                    .as_ref()
                    .map(|m| (m.host_path.display().to_string(), m.tree_sha256.clone())),
                model_out: req.model_out_dir.clone(),
                scored: scored.clone(),
                params,
                has_train,
            });
        // The mount is verified like the service's verify-before-bind.
        if let Some(m) = &req.model {
            let digest = txresbench::modules::sandbox::stack::tree_sha256(&m.host_path)?;
            if digest != m.tree_sha256 {
                return Err(AppError::new(
                    axum::http::StatusCode::BAD_REQUEST,
                    "MODEL_VERIFY_FAILED",
                    format!("fixture: digest mismatch of {}", m.host_path.display()),
                ));
            }
        }
        let model_out_digest = if let Some(mdir) = &req.model_out_dir {
            let dir_err =
                |e: std::io::Error| AppError::internal_error(format!("fixture model dir: {e}"));
            std::fs::create_dir_all(mdir).map_err(dir_err)?;
            std::fs::write(mdir.join("model.rds"), "fixture-model").map_err(dir_err)?;
            Some(txresbench::modules::sandbox::stack::tree_sha256(mdir)?)
        } else {
            None
        };
        // The log line + milestone ride the sink (CONS-EE-5's frames); the
        // wall-clock lag keeps the call in flight so the drive's drainer is
        // observed appending while the run is still active (TEST-EE-33).
        sink.progress(ProgressFrame {
            phase: txresbench::modules::sandbox::service::LOG_PHASE_STDOUT.to_string(),
            pct: None,
            message: Some("fixture says hi".to_string()),
        });
        sink.milestone(MilestoneFrame {
            id: match req.mode {
                MethodRunMode::FitOnly => "fit",
                _ => "predict",
            }
            .to_string(),
            status: "done".to_string(),
            detail: Value::Null,
        });
        tokio::time::sleep(self.delay).await;
        let call_no = self.call_count.fetch_add(1, Ordering::SeqCst);
        let (exit_code, timed_out) = self
            .fail
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .unwrap_or((0, false));
        if exit_code == 0 && !timed_out {
            let writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
            match writer.as_ref() {
                Some(f) => f(call_no, &req.bundle_dir, &req.outputs_dir, &scored)
                    .map_err(|e| AppError::internal_error(format!("fixture outputs: {e}")))?,
                None => Self::write_predictions(&req.outputs_dir, &scored)
                    .map_err(|e| AppError::internal_error(format!("fixture outputs: {e}")))?,
            }
        }
        Ok(MethodRunResult {
            exit_code,
            stderr: if exit_code != 0 {
                "fixture boom\nline two\n".to_string()
            } else {
                String::new()
            },
            stdout: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
            timed_out,
            duration_ms: 42,
            base_env_digest: "a".repeat(64),
            layer_env_digest: "b".repeat(64),
            model_verified: req.model.is_some(),
            model_out_digest,
        })
    }
}
