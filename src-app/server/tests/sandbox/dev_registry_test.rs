//! ITEM-2 (node qa-hardening) — TEST-QA-2: the app, pointed at the DEV
//! REGISTRY, fetches, verifies and mounts a published layer and runs bwrap on
//! it.
//!
//! The shape: `scripts/dev-registry/acceptance.sh` starts the dev registry
//! (`registry.py`) on an ephemeral port, runs `publish.py --fixture` (the tiny
//! fake method + its stdlib-only base, the same publisher code the real
//! methods go through), then runs this test with the environment:
//!
//! * `TXR_ACCEPT_REGISTRY`   — `127.0.0.1:<port>` of the dev registry;
//! * `TXR_ACCEPT_MANIFEST`   — the fixture app manifest
//!   (`method-env-images.fixture.json`, schema v1);
//! * `TXR_ACCEPT_ORAS_DIR`   — a dir holding the `oras` dev shim
//!   (`oras_dev.py`); the child puts it first on PATH so
//!   [`method_env::tool_bin`] resolves it like a real oras install;
//! * `TXR_ACCEPT_DATA_DIR`   — an isolated app-data dir (outside the
//!   repo), so the cache/mount/workspace state is the test's own;
//! * `TXR_ACCEPT_WORK`       — the child's bundle/output workspace.
//!
//! Without that environment (a plain `cargo test` on this node's tree) the
//! test records an honest skip exactly like the other tool-gated legs here —
//! the acceptance run is the driver's, not a default suite leg.
//!
//! What the child asserts (the app's REAL path, nothing stubbed):
//!
//! 1. the dev manifest parses through the engine's own validator
//!    ([`execution_engine::envmanifest::ensure_loaded`], with the debug-only
//!    `TXR_ENV_MANIFEST` override) and the fixture entry resolves;
//! 2. the engine's own ref builders ([`layer_env_ref`] / [`base_env_ref`])
//!    produce refs the manager accepts;
//! 3. [`MethodEnvManager`] (the env-var registry seam) pulls base + layer
//!    from the dev registry through `oras resolve`/`oras pull`, verifies the
//!    bytes against the pins (a TAMPERED pin is `ENV_VERIFY_FAILED` — nothing
//!    is skipped), caches them, mounts them by digest;
//! 4. the stacked run (`run_method_in_stack`, real bwrap) writes
//!    `/output/predictions.csv`, records both digests in the workspace, and
//!    the status surface reports the loopback registry base (never ghcr.io).
//!
//! The real-method publish is the publisher's own tier (publish.test.py);
//! this file is the app-side witness over the same registry.

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use uuid::Uuid;

use crate::common::record_skip;

const CHILD_MARKER: &str = "TXR_ACCEPT_CHILD";
const CHILD_TEST_PATH: &str = "sandbox::dev_registry_test::dev_registry_acceptance_child";

fn have(tool: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {tool} >/dev/null 2>&1"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

/// The sink the child passes to the seam (frames kept for the assertions).
struct RecordingSinkExt {
    progress: std::sync::Mutex<Vec<txresbench::modules::sandbox::backend::ProgressFrame>>,
    milestones: std::sync::Mutex<Vec<txresbench::modules::sandbox::backend::MilestoneFrame>>,
}

impl RecordingSinkExt {
    fn new() -> Self {
        Self {
            progress: std::sync::Mutex::new(Vec::new()),
            milestones: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl txresbench::modules::sandbox::backend::ProgressSink for RecordingSinkExt {
    fn progress(&self, frame: txresbench::modules::sandbox::backend::ProgressFrame) {
        self.progress.lock().unwrap_or_else(|p| p.into_inner()).push(frame);
    }
    fn milestone(&self, frame: txresbench::modules::sandbox::backend::MilestoneFrame) {
        self.milestones.lock().unwrap_or_else(|p| p.into_inner()).push(frame);
    }
}

/// The child process (see the file header; the parent gates + spawns it).
#[tokio::test]
async fn dev_registry_acceptance_child() {
    use txresbench::modules::sandbox::config::{self, SandboxAvailability, SandboxState};
    use txresbench::modules::sandbox::probes;
    use txresbench::modules::sandbox::service::run_method_in_stack;
    use txresbench::modules::sandbox::stack::{self, read_run_layer_digest};
    use txresbench::modules::sandbox::types::ExtraMount;

    if env(CHILD_MARKER).is_none() {
        return; // bare libtest run: the child only exists behind a parent
    }
    let data_dir = PathBuf::from(env("TXR_APP_DATA_DIR").expect("TXR_APP_DATA_DIR"));
    let work = PathBuf::from(env("TXR_ACCEPT_WORK").expect("TXR_ACCEPT_WORK"));
    let registry = env("TXR_ACCEPT_REGISTRY").expect("registry");
    let _manifest_path = PathBuf::from(env("TXR_ACCEPT_MANIFEST").expect("manifest"));

    let fail = |what: String| -> ! {
        eprintln!("PROBE_ERR {what}");
        panic!("dev-registry acceptance child: {what}");
    };

    // ── 1. the engine's own validator over the dev manifest ────────────────
    let manifest = txresbench::modules::execution_engine::envmanifest::ensure_loaded()
        .map_err(|e| format!("the dev manifest failed the app's boot validation: {e}"))
        .unwrap_or_else(|e| fail(e));
    let arch = txresbench::modules::execution_engine::envmanifest::EnvArch::host()
        .expect("host arch supported");
    let entry = manifest
        .find("txr-dev-fixture", arch)
        .ok_or_else(|| "no fixture entry in the dev manifest".to_string())
        .unwrap_or_else(|e| fail(e));
    assert_eq!(entry.oci_ref, "ghcr.io/tinnlab/txr-method-env-layers/txr-dev-fixture");

    // ── 2. the engine's own ref builders ───────────────────────────────────
    let base_ref = txresbench::modules::execution_engine::orchestrator::base_env_ref(entry);
    let layer_ref = txresbench::modules::execution_engine::orchestrator::layer_env_ref(entry);
    assert_eq!(base_ref.oci_ref, "ghcr.io/tinnlab/txresbench-env/base-py");
    assert_eq!(base_ref.tag.as_deref(), Some("2.0-amd64"));
    assert_eq!(base_ref.digest, entry.base_digest.strip_prefix("sha256:").unwrap());
    assert_eq!(layer_ref.digest, entry.layer_sha256);

    // ── 3. the seam + the real OCI path (oras shim on PATH) ────────────────
    let effective = txresbench::modules::sandbox::method_env::effective_base_prefix();
    assert!(
        effective.starts_with(&registry),
        "the status surface must report the dev registry host, got {effective}"
    );
    let manager = txresbench::modules::sandbox::method_env::manager();
    let base = manager
        .ensure(
            &base_ref,
            txresbench::modules::sandbox::method_env::EnvKind::Base,
            std::time::Duration::from_secs(600),
        )
        .unwrap_or_else(|e| fail(format!("base ensure: {e}")));
    assert_eq!(base.digest.as_deref(), Some(base_ref.digest.as_str()));
    let layer = manager
        .ensure(
            &layer_ref,
            txresbench::modules::sandbox::method_env::EnvKind::Layer,
            std::time::Duration::from_secs(600),
        )
        .unwrap_or_else(|e| fail(format!("layer ensure: {e}")));
    assert_eq!(layer.digest.as_deref(), Some(entry.layer_sha256.as_str()));
    let base_status = manager.status("base-py");
    assert_eq!(
        base_status.state,
        txresbench::modules::sandbox::method_env::MethodEnvState::Ready
    );
    assert!(base_status.mounted, "the base mount is live");
    let layer_status = manager.status("txr-dev-fixture");
    assert_eq!(
        layer_status.state,
        txresbench::modules::sandbox::method_env::MethodEnvState::Ready
    );
    assert!(layer_status.mounted, "the layer mount is live");

    // verification stays ON: a wrong pin is refused before any cache/mount.
    let mut bad = layer_ref.clone();
    bad.digest = "0".repeat(64);
    let err = manager
        .ensure(
            &bad,
            txresbench::modules::sandbox::method_env::EnvKind::Layer,
            std::time::Duration::from_secs(60),
        )
        .expect_err("a wrong pin must refuse");
    assert_eq!(err.error_code(), "ENV_VERIFY_FAILED", "digest verification is never skipped");

    // ── 4. the stacked real run ────────────────────────────────────────────
    let caps = probes::probe_host_only().expect("bwrap on PATH (parent gated)");
    let workspace_root = data_dir.join("sandboxes");
    let staging = data_dir.join("run-staging");
    std::fs::create_dir_all(&workspace_root).expect("workspace root");
    std::fs::create_dir_all(&staging).expect("staging root");
    config::init_state(SandboxState {
        workspace_root,
        staging_root: staging,
        host_caps: caps,
    });
    config::set_init_status(SandboxAvailability::Ready);
    let pool = sqlx::SqlitePool::connect("sqlite::memory:")
        .await
        .expect("in-memory pool");

    let bundle = work.join("bundle");
    let outputs = work.join("output");
    let model_out = work.join("model-out");
    let job = Uuid::new_v4();
    std::fs::create_dir_all(&bundle).expect("bundle");
    std::fs::create_dir_all(&outputs).expect("outputs");
    std::fs::create_dir_all(&model_out).expect("model-out");
    std::fs::write(
        bundle.join("params.json"),
        br#"{"landmark_day":56,"horizons":[238],"outcomes":["progression"],"markers":["m"],"baseline_max_day":0,"covariates":false,"method_params":{},"seed":1,"threads":1}"#,
    )
    .expect("params");
    std::fs::create_dir_all(bundle.join("test")).expect("test dir");
    std::fs::write(bundle.join("test/patients.csv"), b"patient_id\np1\np2\n").expect("patients");
    std::fs::write(
        bundle.join("test/long.csv"),
        b"patient_id,day,marker,value,baseline\np1,0,m,1.0,1\np2,0,m,2.0,1\n",
    )
    .expect("long");

    let sink = Arc::new(RecordingSinkExt::new());
    let result = run_method_in_stack(
        &pool,
        &stack::MethodRunRequest {
            base: base_ref.clone(),
            layer: layer_ref.clone(),
            mode: stack::MethodRunMode::FitPredict,
            bundle_dir: bundle.clone(),
            outputs_dir: outputs.clone(),
            model: None,
            model_out_dir: Some(model_out.clone()),
            n_cpu: 1,
            timeout_secs: Some(600),
        },
        &[] as &[ExtraMount],
        job,
        Some(sink.clone()),
    )
    .await
    .unwrap_or_else(|e| fail(format!("stacked run: {e}")));

    assert_eq!(result.exit_code, 0, "stderr: {}", result.stderr);
    assert_eq!(result.base_env_digest, entry.base_digest.strip_prefix("sha256:").unwrap());
    assert_eq!(result.layer_env_digest, entry.layer_sha256);
    let predictions =
        std::fs::read_to_string(outputs.join("predictions.csv")).unwrap_or_else(|e| fail(format!("predictions.csv: {e}")));
    assert!(predictions.contains("patient_id,risk,call,note"), "{predictions}");
    assert!(predictions.contains("p1") && predictions.contains("p2"), "{predictions}");

    // INV-6: both digests in the run workspace (the service writes them
    // before the child runs; the workspace is data_dir/sandboxes/<job>).
    let ws = data_dir.join("sandboxes").join(job.to_string());
    assert_eq!(
        std::fs::read_to_string(ws.join("env-digest")).expect("env-digest").trim(),
        entry.base_digest.strip_prefix("sha256:").unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(ws.join("layer-env-digest"))
            .expect("layer sidecar")
            .trim(),
        entry.layer_sha256
    );
    assert_eq!(
        read_run_layer_digest(&ws),
        Some(entry.layer_sha256.clone()),
        "the read-back sidecar (INV-6)"
    );

    // The layer's own artifacts are the app's parsed shapes.
    let entries = stack::layer_entries_from_manifest(&layer.mount_dir)
        .unwrap_or_else(|e| fail(format!("layer manifest parse: {e}")));
    assert_eq!(entries, vec!["/code".to_string()]);
    let command = stack::method_entry_command(&layer.mount_dir)
        .unwrap_or_else(|e| fail(format!("entrypoint: {e}")));
    assert_eq!(command, "python3 /code/run.py");
    let frames = sink.milestones.lock().unwrap_or_else(|p| p.into_inner()).clone();
    assert!(!frames.is_empty(), "milestone frames arrived on the sink");
    assert!(
        frames.iter().any(|f| f.id == "fit" && f.status == "done"),
        "the wrapper's milestone line crossed the progress FIFO into the sink: {frames:?}"
    );

    eprintln!("PROBE_OK dev-registry acceptance");
}

/// TEST-QA-2 — the parent: gate the host + the driver's environment, spawn
/// the child with the dev-registry env, record skips honestly.
#[tokio::test]
async fn dev_registry_fetch_verify_mount_and_run() {
    let Some(registry) = env("TXR_ACCEPT_REGISTRY") else {
        record_skip(
            stringify!(dev_registry_fetch_verify_mount_and_run),
            "dev-registry acceptance env not set (run scripts/dev-registry/acceptance.sh)",
        );
        return;
    };
    let Some(manifest) = env("TXR_ACCEPT_MANIFEST") else {
        record_skip(stringify!(dev_registry_fetch_verify_mount_and_run), "TXR_ACCEPT_MANIFEST not set");
        return;
    };
    let Some(oras_dir) = env("TXR_ACCEPT_ORAS_DIR") else {
        record_skip(stringify!(dev_registry_fetch_verify_mount_and_run), "TXR_ACCEPT_ORAS_DIR not set");
        return;
    };
    let Some(data_dir) = env("TXR_ACCEPT_DATA_DIR") else {
        record_skip(stringify!(dev_registry_fetch_verify_mount_and_run), "TXR_ACCEPT_DATA_DIR not set");
        return;
    };
    let work = env("TXR_ACCEPT_WORK").unwrap_or_else(|| {
        format!("/data/pbya/txresbench-app-work/tmp-qa-hardening/accept-{}", Uuid::new_v4())
    });

    // Host gates (the same facts the real-run legs here gate on).
    if !have("bwrap") || !have("squashfuse") || !have("fusermount") {
        record_skip(
            stringify!(dev_registry_fetch_verify_mount_and_run),
            "host tools missing (bwrap/squashfuse/fusermount)",
        );
        return;
    }
    let (host, port_s) = registry.rsplit_once(':').unwrap_or((&registry, "0"));
    let port: u16 = port_s.parse().unwrap_or(0);
    if TcpStream::connect((host, port)).is_err() {
        record_skip(
            stringify!(dev_registry_fetch_verify_mount_and_run),
            &format!("dev registry not reachable at {registry}"),
        );
        return;
    }
    if !Path::new(&manifest).is_file() {
        record_skip(
            stringify!(dev_registry_fetch_verify_mount_and_run),
            &format!("fixture manifest missing: {manifest}"),
        );
        return;
    }
    if !Path::new(&oras_dir).is_dir() {
        record_skip(
            stringify!(dev_registry_fetch_verify_mount_and_run),
            &format!("oras dir missing: {oras_dir}"),
        );
        return;
    }

    // The child drives the WHOLE scenario (the manager reads the registry
    // seam off the PROCESS env, and the sandbox state is first-write-wins —
    // the child-process pattern of this suite).
    let path = format!("{oras_dir}:{}", std::env::var("PATH").unwrap_or_default());
    let out = Command::new(std::env::current_exe().expect("test binary"))
        .arg(CHILD_TEST_PATH)
        .arg("--exact")
        .arg("--nocapture")
        .env(CHILD_MARKER, "1")
        .env("TXR_APP_DATA_DIR", &data_dir)
        .env("TXR_ACCEPT_REGISTRY", &registry)
        .env("TXR_ACCEPT_MANIFEST", &manifest)
        .env("TXR_ACCEPT_ORAS_DIR", &oras_dir)
        .env("TXR_ACCEPT_WORK", &work)
        .env("TXR_METHOD_ENV_REGISTRY", &registry)
        .env("TXR_ENV_MANIFEST", &manifest)
        .env("PATH", &path)
        .output()
        .expect("spawn child");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() && (stdout.contains("PROBE_OK") || stderr.contains("PROBE_OK")) {
        return;
    }
    if let Some(line) = stderr
        .lines()
        .find(|l| l.contains("PROBE_SKIP"))
    {
        record_skip(stringify!(dev_registry_fetch_verify_mount_and_run), line);
        return;
    }
    panic!(
        "dev-registry acceptance failed\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}"
    );
}
