//! ITEM-7 — TEST-7/EX-7 [acceptance] [INV-1, INV-3, INV-4]: the layer-artifact
//! equivalence arbiter (design doc §9 · `docs/design/method-env-layer-artifacts.md`).
//!
//! The stacked-layer design is only correct if a bind of the layer's entries
//! reproduces the method image's subtree at those paths (§8). Every earlier
//! item asserted that on fixtures and on the generator's own outputs; this file
//! is the END-TO-END proof: a tiny fixture method (defined here), its layer
//! built by the REAL pipeline (`scripts/generate-method-env-images.py`, docker
//! build of the fixture Dockerfile FROM the cached benchmark base), stacked
//! through the REAL runtime (`service::run_method_in_stack` — the same bwrap
//! per-entry-bind seam `sandbox-stacked` ships) and compared against a
//! `docker run` of the full fixture image:
//!
//! 1. **manifest ↔ artifact consistency** — the staged `layer.squashfs` hashes
//!    to the record's and the manifest entry's `layer_sha256`/`size_bytes`;
//!    the staged `oci-manifest.json` bytes hash to the entry `digest` (the
//!    writer's pinned construction, design §6.1);
//! 2. **marker + modes** — the extracted layer's `/.txr-method-env-layer-schema`
//!    reads `1` == `layer_schema`; every file is >= 0644 and every dir >= 0755
//!    (a 0600 `/code/run.py` is the benchmark's recorded pitfall); the
//!    `/layer-manifest.json` entries obey the prefix/`..`-free rules and
//!    `<code>` is present; `wrapper_code_sha256` matches design §2.2's bytes;
//! 3. **the equivalence** — the stacked FitPredict run and the full-image run
//!    over the SAME input bundle produce byte-identical `predictions.csv`,
//!    and the prediction bytes carry the shared-subtree marker (the fixture
//!    layer overlays a file inside the base's own python package at
//!    `/opt/txrmethod/txrmethod` — a shadowing bug would surface as a
//!    different prediction, not as a broken import);
//! 4. **the registry witness** (tier B, gated docker+oras+cosign) — the layer
//!    is pushed to a loopback `registry:2` through the publisher's own byte
//!    shape (`oras blob push` × 2 + `oras manifest push` of the staged
//!    manifest bytes), signed with a loopback cosign key, and still resolves
//!    to the pinned `digest` and pulls by digest to bytes matching
//!    `layer_sha256`/`size_bytes` (design §6.1 "ITEM-7's loopback test is the
//!    runtime-side witness of the same equality").
//!
//! The full image is the ground truth (INV-1: the layer is the method's own
//! bytes at the recorded revision — here the fixture methods tree's revision);
//! the stacked layer must not trim, shadow or mis-bind anything the method
//! image needs.
//!
//! Real-run gates follow the shipped discipline precisely: every gate routes
//! through the SHARED [`record_skip`] (`target/test-skip-ledger.tsv`;
//! `TXR_TEST_NO_SKIP=1` turns each skip into a hard failure), and the reason
//! it prints is TRUE of the box it prints on. Tool-gated (docker, oras,
//! cosign, squashfuse, bwrap) per tier through the skip recorder.
//!
//! Why a CHILD PROCESS for the stacked run (the same reasoning as
//! `method_stack_test.rs`): `run_method_in_stack` runs its fetch/verify/mount
//! on `spawn_blocking` (whose threads do NOT inherit the thread-scoped
//! `rootfs::scoped_data_root`), the global `method_env::manager()` reads the
//! air-gap seams off the PROCESS environment, and `config::init_state` is
//! first-write-wins. `set_var` is what this repo forbids (measurable
//! cross-test contamination — `env_image_oci_test.rs`'s header). So the
//! stacked run happens in a child of this same test binary with its seams
//! passed through `Command::env`; a child failure is a panic the parent
//! surfaces as the test failure, and `PROBE_SKIP` is recorded by the parent.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::common::record_skip;

// ────────────────────────────── child protocol ───────────────────────────────

/// The marker that switches `stacked_layer_child` from libtest pass-through
/// into the probe it actually is.
const CHILD_MARKER: &str = "TXR_MEL_CHILD";

/// The parent's `--exact` test path for the child.
const CHILD_TEST_PATH: &str = "sandbox::method_env_layer_test::stacked_layer_child";

/// The fixture method id = its layer env id (DEC-1: `env_id == method_id`).
const FIXTURE_METHOD_ID: &str = "txr-fixture-py";

/// The base rootfs env id in the runtime's namespace (a VALID env-id
/// component; the base is this test's own fixture, never a registry hit).
const BASE_ID: &str = "txr-mel-base-xq4";

// ────────────────────────────── shell helpers ────────────────────────────────

fn have(tool: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {tool} >/dev/null 2>&1"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Run a shell line, panic with stderr on failure.
fn sh(line: &str) {
    let out = Command::new("sh").arg("-c").arg(line).output().expect("spawn sh");
    assert!(
        out.status.success(),
        "cmd failed: {line}\n--- stderr ---\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

fn sh_out(line: &str) -> String {
    let out = Command::new("sh").arg("-c").arg(line).output().expect("spawn sh");
    assert!(
        out.status.success(),
        "cmd failed: {line}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root")
}

/// A scratch dir under `TMPDIR` (the owner rule: nothing in `/tmp`).
fn scratch() -> PathBuf {
    std::env::temp_dir().join(format!("txr-mel-{}", uuid::Uuid::new_v4()))
}

// ──────────────────────────── host stack gate ────────────────────────────────

/// Whether `user_allow_other` is ENABLED in `/etc/fuse.conf` — the non-root
/// `squashfuse -o allow_other` mount the rootfs path uses requires it.
fn user_allow_other_enabled() -> bool {
    std::fs::read_to_string("/etc/fuse.conf")
        .ok()
        .map(|text| {
            text.lines().any(|l| {
                let stripped = l.trim_start();
                stripped.starts_with("user_allow_other") && !stripped.starts_with('#')
            })
        })
        .unwrap_or(false)
}

/// The gate shared by every real-mount leg: bwrap + squashfuse + fusermount
/// (either generation) + the fuse.conf flag — the same list
/// `scripts/txr-sandbox-preflight.sh` asks. `None` = record_skip.
fn stack_gate(test: &str) -> Option<()> {
    if !have("bwrap") || !have("squashfuse") || !(have("fusermount") || have("fusermount3")) {
        record_skip(
            test,
            "needs bwrap + squashfuse + (fusermount | fusermount3) on PATH — the host tools \
             of the stacked sandbox (scripts/txr-sandbox-preflight.sh names the exact fixes)",
        );
        return None;
    }
    if !user_allow_other_enabled() {
        record_skip(
            test,
            "`user_allow_other` is NOT enabled in /etc/fuse.conf — the non-root squashfuse \
             `-o allow_other` mount the rootfs path requires is refused \
             (scripts/txr-sandbox-preflight.sh names the exact fix; \
             scripts/dev-sandbox-bootstrap.sh applies it with sudo)",
        );
        return None;
    }
    Some(())
}

/// The strict-PID-ns gate, probed against the BUILT base dir. `None` =
/// record_skip with the probe's exact reason.
fn stack_gate_pidns(test: &str, base_dir: &Path) -> Option<()> {
    use txresbench::modules::sandbox::probes;
    let caps = probes::probe_host_only()?;
    if let Err(reason) = probes::probe_rootfs_dependent(&caps, base_dir) {
        record_skip(test, &reason);
        return None;
    }
    Some(())
}

// ─────────────────────────────── the pipeline ────────────────────────────────

/// The fixture methods tree: one tiny Python method whose Dockerfile starts
/// FROM the benchmark per-language base and — the shared-subtree case the
/// design §8 says the test MUST carry — appends ONE line to a file inside the
/// base's own python package (`/opt/txrmethod/txrmethod/__init__.py`), so the
/// layer's `/opt/txrmethod/txrmethod` entry overlays a path the base also
/// provides and the wrapper's prediction carries the marker value: a
/// shadowing/over-trimming bug changes the prediction bytes, never the exit
/// code.
fn fixture_methods_dir(work: &Path) -> PathBuf {
    let methods = work.join("methods");
    let dir = methods.join("methods").join(FIXTURE_METHOD_ID);
    std::fs::create_dir_all(&dir).expect("fixture method dir");
    std::fs::write(
        methods.join("index.json"),
        json!({
            "index_version": "fixture",
            "contract_versions": ["2.0"],
            "methods": [{
                "id": FIXTURE_METHOD_ID,
                "version": "1.0.0",
                "language": "Python",
                "contract": "2.0",
                "runnable": true,
            }],
        })
        .to_string(),
    )
    .expect("index.json");
    std::fs::write(
        dir.join("method.json"),
        json!({
            "id": FIXTURE_METHOD_ID,
            "version": "1.0.0",
            "licence": "MIT",
            "language": "Python",
            "software": "python",
            "params": {},
        })
        .to_string(),
    )
    .expect("method.json");
    std::fs::write(
        dir.join("run.py"),
        r#"#!/usr/bin/env python3
# Fixture method wrapper (TEST-7): a REAL contract run through the base's own
# txrmethod package (read_input / save_model / write_run / write_predictions).
# The shared-subtree marker is appended to the base package's __init__.py by
# the fixture Dockerfile and must arrive at BOTH the full-image and the stacked
# run — a layer that shadows the package subtree or drops the entry yields a
# DIFFERENT pred value.
import os
import sys

sys.path.insert(0, "/opt/txrmethod")
import pandas as pd
import txrmethod
from txrmethod import read_input, save_model, write_predictions, write_run

marker = getattr(txrmethod, "__txr_fixture_marker__", 0)
mode = os.environ.get("SIGBENCH_MODE", "")
b = read_input()
if mode != "predict":
    save_model({"marker": marker, "ids": getattr(getattr(b, "test", None), "ids", None)})
    write_run({"marker": marker, "kind": "fixture"})
if mode != "fit":
    ids = b.test.ids
    df = pd.DataFrame({"patient_id": ids, "pred": [f"marker-{marker}"] * len(ids)})
    write_predictions(df)
print(f"fixture wrapper: mode={mode or 'combined'} marker={marker} patients={len(ids)}")
"#,
    )
    .expect("run.py");
    std::fs::write(
        dir.join("Dockerfile"),
        format!(
            "FROM ghcr.io/tinnlab/txresbench-base-py:2.0\n\
             COPY method.json run.py /code/\n\
             RUN echo '__txr_fixture_marker__ = 1' >> /opt/txrmethod/txrmethod/__init__.py\n"
        ),
    )
    .expect("Dockerfile");
    sh(&format!(
        "git -C {m} init -q && git -C {m} -c user.email=fixture@txr.test \
         -c user.name=fixture add -A && git -C {m} -c user.email=fixture@txr.test \
         -c user.name=fixture commit -qm fixture",
        m = methods.display()
    ));
    methods
}

/// A contract-shaped input bundle (the layout CONS-SS-1 / the txrmethod
/// reader expects: params.json + train/{long,outcomes,covariates} +
/// test/{long,patients,covariates}).
fn write_bundle(dir: &Path) {
    std::fs::create_dir_all(dir.join("train")).expect("bundle train dir");
    std::fs::create_dir_all(dir.join("test")).expect("bundle test dir");
    std::fs::write(
        dir.join("params.json"),
        json!({ "method_params": {}, "outcome": "response" }).to_string(),
    )
    .expect("params.json");
    std::fs::write(dir.join("train/long.csv"), "patient_id,day,marker,value\np1,0,m1,1.0\np2,0,m1,2.0\n")
        .expect("train/long");
    std::fs::write(dir.join("train/outcomes.csv"), "patient_id,event,time\np1,1,60\np2,0,200\n")
        .expect("train/outcomes");
    std::fs::write(dir.join("train/covariates.csv"), "patient_id,age\np1,50\np2,70\n")
        .expect("train/covars");
    std::fs::write(dir.join("test/long.csv"), "patient_id,day,marker,value\np1,0,m1,1.0\np2,0,m1,2.0\n")
        .expect("test/long");
    std::fs::write(dir.join("test/patients.csv"), "patient_id\np1\np2\n").expect("test/patients");
    std::fs::write(dir.join("test/covariates.csv"), "patient_id,age\np1,50\np2,70\n")
        .expect("test/covars");
}

/// Everything the pipeline produced for the fixture method.
struct Pipeline {
    staging: PathBuf,
    layer_dir: PathBuf,
    record: Value,
    entry: Value,
    record_dir: PathBuf,
    base_cache_dir: PathBuf,
    built_image_tag: String,
}

/// Run the REAL generator over the fixture methods tree (the pipeline's own
/// build: docker build the fixture Dockerfile FROM the cached base, export
/// both rootfses, delta, trim, closed cover, marker, modes, mksquashfs, the
/// artifact record + the staged oci-manifest bytes + the manifest).
fn build_pipeline(work: &Path) -> Pipeline {
    let methods_dir = fixture_methods_dir(work);
    let staging = work.join("staged");
    std::fs::create_dir_all(&staging).expect("staging dir");
    let manifest = work.join("manifest.json");
    let gen = repo_root().join("scripts/generate-method-env-images.py");
    let out = sh_out(&format!(
        "python3 {gen} --methods-dir {m} --out {o} --manifest {mf} 2>&1",
        gen = gen.display(),
        m = methods_dir.display(),
        o = staging.display(),
        mf = manifest.display()
    ));
    assert!(
        out.contains(&format!("built 1/1 layers into {}", staging.display())),
        "the generator must build the fixture layer: {out}"
    );
    let record_path = staging
        .join("layers")
        .join(format!("{FIXTURE_METHOD_ID}-amd64"))
        .join("artifact.json");
    let record: Value =
        serde_json::from_str(&std::fs::read_to_string(&record_path).expect("artifact record"))
            .expect("record json");
    let manifest_value: Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest).expect("manifest"))
            .expect("manifest json");
    let entry = manifest_value["envs"]
        .as_array()
        .expect("envs array")
        .iter()
        .find(|e| e["env_id"] == FIXTURE_METHOD_ID)
        .expect("fixture entry")
        .clone();
    assert_eq!(entry["env_id"], FIXTURE_METHOD_ID);
    let layer_dir = staging
        .join("layers")
        .join(format!("{FIXTURE_METHOD_ID}-amd64"));
    let record_dir = record_path.parent().expect("record dir").to_path_buf();
    // The cached benchmark base rootfs the generator exported (its own cache
    // layout: out/bases/<digest-prefix>-<arch>/rootfs) — the base the delta
    // was computed against, and the base the stacked run mounts.
    let base_ref = entry["base_ref"].as_str().expect("base_ref").to_string();
    let base_digest = entry["base_digest"].as_str().expect("base_digest").to_string();
    let key = format!("{}-amd64", &base_digest[..16]);
    let base_cache_dir = staging.join("bases").join(key);
    assert!(
        base_cache_dir.join("rootfs").is_dir(),
        "the generator's base rootfs cache at {} must exist ({}); the delta was computed \
         against it",
        base_cache_dir.display(),
        base_ref
    );
    let built_image_tag = record["built_image_tag"]
        .as_str()
        .expect("built tag")
        .to_string();
    Pipeline {
        staging,
        layer_dir,
        record,
        entry,
        record_dir,
        base_cache_dir,
        built_image_tag,
    }
}

/// RAII: remove the scratch dir on test exit. A mounted fixture prevents the
/// removal until the registry guard (declared AFTER this one, so it drops
/// FIRST) unmounts + drops the container.
struct WorkGuard(PathBuf);
impl Drop for WorkGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unmount_recursive(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if p.file_name().is_some_and(|n| n == "mnt") {
                    let _ = Command::new("fusermount")
                        .args(["-u", &p.to_string_lossy()])
                        .output();
                } else {
                    unmount_recursive(&p);
                }
            }
        }
    }
}

/// RAII for the loopback registry container + any fuse mounts + the temp dir.
struct RegistryGuard {
    work: PathBuf,
    container: String,
}
impl Drop for RegistryGuard {
    fn drop(&mut self) {
        let _ = Command::new("sh")
            .arg("-c")
            .arg(format!("docker rm -f {} >/dev/null 2>&1", self.container))
            .output();
        unmount_recursive(&self.work);
        let _ = std::fs::remove_dir_all(&self.work);
    }
}

// ─────────────────────────── the child process ───────────────────────────────

/// ONE REAL stacked FitPredict run through the runtime, inside a child
/// process (see the file header). Reads the fixture env the parent set,
/// drives `run_method_in_stack` against the pipeline-built layer + base
/// staged through the air-gap seams, and prints exactly one `PROBE_OK` /
/// `PROBE_SKIP` / panic line.
#[tokio::test]
async fn stacked_layer_child() {
    use txresbench::modules::sandbox::config::{self, SandboxAvailability, SandboxState};
    use txresbench::modules::sandbox::probes;
    use txresbench::modules::sandbox::service::run_method_in_stack;
    use txresbench::modules::sandbox::stack::{
        EnvRef, MethodRunMode, MethodRunRequest, TXR_BASE_REGISTRY_PREFIX,
        TXR_LAYER_REGISTRY_PREFIX,
    };
    use txresbench::modules::sandbox::types::ExtraMount;

    let Some(marker) = std::env::var_os(CHILD_MARKER) else {
        return; // bare libtest run: the child only exists behind a parent
    };
    let _ = marker;
    let data_dir = PathBuf::from(
        std::env::var_os("TXR_APP_DATA_DIR").expect("parent passes TXR_APP_DATA_DIR"),
    );
    let work = PathBuf::from(std::env::var_os("TXR_MEL_WORK").expect("TXR_MEL_WORK"));

    let fail = |what: String| -> ! {
        eprintln!("PROBE_ERR {what}");
        panic!("child scenario: {what}");
    };

    // In-process sandbox init, exactly what the server subprocess does at boot.
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

    let base_sqfs = PathBuf::from(std::env::var_os("TXR_MEL_BASE_SQFS").expect("base"));
    let layer_sqfs = PathBuf::from(std::env::var_os("TXR_MEL_LAYER_SQFS").expect("layer"));
    let base_pin = sha256_hex(&std::fs::read(&base_sqfs).expect("read base fixture"));
    let layer_pin = sha256_hex(&std::fs::read(&layer_sqfs).expect("read layer fixture"));
    let base_ref = EnvRef {
        oci_ref: format!("{TXR_BASE_REGISTRY_PREFIX}/{BASE_ID}"),
        digest: base_pin.clone(),
        tag: None,
    };
    let layer_ref = EnvRef {
        oci_ref: format!("{TXR_LAYER_REGISTRY_PREFIX}/{FIXTURE_METHOD_ID}"),
        digest: layer_pin.clone(),
        tag: None,
    };

    let bundle = work.join("bundle");
    write_bundle(&bundle);
    let outputs = work.join("outputs");
    let model_out = work.join("model-out");
    let job = Uuid::new_v4();

    let result = run_method_in_stack(
        &pool,
        &MethodRunRequest {
            base: base_ref,
            layer: layer_ref,
            mode: MethodRunMode::FitPredict,
            bundle_dir: bundle,
            outputs_dir: outputs.clone(),
            model: None,
            model_out_dir: Some(model_out.clone()),
            n_cpu: 1,
            timeout_secs: Some(600),
        },
        &[] as &[ExtraMount],
        job,
        None,
    )
    .await
    .unwrap_or_else(|e| fail(format!("stacked run refused: {} ({})", e.error_code(), e)));

    assert_eq!(result.exit_code, 0, "stacked run exits 0; stdout: {}", result.stdout);
    assert!(
        result.stdout.contains("fixture wrapper: mode=combined"),
        "the wrapper ran through the contract: {}",
        result.stdout
    );
    let pred = std::fs::read_to_string(outputs.join("predictions.csv"))
        .expect("/output/predictions.csv written");
    // The shared-subtree marker VALUE came from the LAYER's overlay of the
    // base package — a layer whose cover/bind lost the subtree would yield
    // `marker-0` here (the base's unpatched file).
    assert!(
        pred.contains("marker-1") && !pred.contains("marker-0"),
        "the stacked run MUST see the layer's overlay, not the bare base: {pred}"
    );
    assert!(model_out.join("model.pkl").is_file(), "the fit wrote the model (DEC-6)");
    assert_eq!(result.base_env_digest, base_pin, "base digest recorded (INV-6)");
    assert_eq!(result.layer_env_digest, layer_pin, "layer digest recorded (INV-6)");
    println!("PROBE_OK stacked_fitpredict wrote {pred:?}");
}

/// Spawn the child probe; returns `(exit_success, stdout)`.
fn spawn_child(work: &Path, data_dir: &Path, base_sqfs: &Path, layer_sqfs: &Path) -> (bool, String) {
    let exe = std::env::current_exe().expect("test binary path");
    let out = Command::new(exe)
        .args([
            "--exact",
            CHILD_TEST_PATH,
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_MARKER, "fitpredict")
        .env("TXR_APP_DATA_DIR", data_dir)
        .env("TXR_MEL_WORK", work)
        .env("TXR_MEL_BASE_SQFS", base_sqfs)
        .env("TXR_MEL_LAYER_SQFS", layer_sqfs)
        .env(
            format!("TXR_ENV_ROOTFS_SQUASHFS__{BASE_ID}"),
            base_sqfs,
        )
        .env(
            format!("TXR_ENV_ROOTFS_SQUASHFS__{FIXTURE_METHOD_ID}"),
            layer_sqfs,
        )
        // The child must start from a clean seam environment: whatever this box
        // exported would otherwise leak in and decide the outcome.
        .env_remove("TXR_ENV_ROOTFS_SQUASHFS")
        .env_remove("TXR_ENV_ROOTFS_SQUASHFS_ENV")
        .env_remove("TXR_ENV_ROOTFS_DIR")
        .env_remove("TXR_ENV_ROOTFS_DIR_ENV")
        .env_remove("TXR_SANDBOX_ENV_ID")
        .env_remove("TXR_TEST_NO_SKIP")
        .output()
        .expect("spawn the child");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let ok = out.status.success();
    if !ok {
        eprintln!("--- child stderr ---\n{}", String::from_utf8_lossy(&out.stderr));
        eprintln!("--- child stdout ---\n{stdout}");
    }
    (ok, stdout)
}

/// Assert the child ran EXACTLY one test (anti-vacuity).
fn assert_child_ran_one(stdout: &str) {
    assert!(
        stdout.lines().any(|l| l.starts_with("test result: ok. 1 passed")),
        "the child did not report EXACTLY one passing test:\n{stdout}"
    );
    assert!(
        stdout.contains("PROBE_OK ") || stdout.contains("PROBE_SKIP "),
        "the child printed neither PROBE_OK nor PROBE_SKIP:\n{stdout}"
    );
}

fn child_skipped(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find(|l| l.starts_with("PROBE_SKIP "))
        .map(|l| l.trim_start_matches("PROBE_SKIP ").to_string())
}

// ═════════════════════════════ TEST-7 — the equivalence ═════════════════════

/// Pull the artifact by digest from a loopback registry and verify the pinned
/// sha256/size (design §6.1's witness). Returns nothing on success.
fn push_and_pull_by_digest(work: &Path, pipeline: &Pipeline) {
    let container = format!("mel-env-reg-{}", Uuid::new_v4().simple());
    sh(&format!(
        "docker rm -f {container} >/dev/null 2>&1; docker run -d --name {container} \
         -p 5077:5000 registry:2 >/dev/null && sleep 2"
    ));
    let reg = "localhost:5077"; // dedicated port: never collide with a stray :5000
    let repo = format!("{reg}/tinnlab/txr-method-env-layers/{FIXTURE_METHOD_ID}");
    let entry_sha = pipeline.entry["layer_sha256"].as_str().expect("layer sha");
    let size = pipeline.entry["size_bytes"].as_u64().expect("size");
    let digest = pipeline.entry["digest"].as_str().expect("digest").to_string();
    let tag = pipeline.entry["tag"].as_str().expect("tag").to_string();

    // The publisher's own shape (design §6.2): the empty config + the STAGED
    // artifact-manifest bytes, verbatim — the digest is pinned to those bytes.
    let empty = pipeline.staging.join("publish/empty-config.json");
    std::fs::create_dir_all(empty.parent().expect("publish dir")).expect("publish dir");
    std::fs::write(&empty, b"{}").expect("empty config");
    sh(&format!(
        "cd {d} && oras blob push --plain-http {repo} layer.squashfs >/dev/null && \
         oras blob push --plain-http {repo} {empty} >/dev/null && \
         oras manifest push --plain-http {repo}:{tag} {oci} >/dev/null",
        d = pipeline.layer_dir.display(),
        empty = empty.display(),
        oci = pipeline.layer_dir.join("oci-manifest.json").display()
    ));
    let resolved = sh_out(&format!("oras resolve --plain-http {repo}:{tag}"));
    assert_eq!(
        resolved.strip_prefix("sha256:").unwrap_or(&resolved),
        digest.strip_prefix("sha256:").unwrap_or(&digest),
        "oras resolve == the manifest's pinned digest (the staged bytes were pushed verbatim)"
    );

    // cosign-key sign the digest (the provenance floor; the RESOLVE must be
    // unchanged — signing writes a SEPARATE signature artifact, DEC-5).
    sh(&format!(
        "cd {w} && COSIGN_PASSWORD='' cosign generate-key-pair >/dev/null 2>&1 && \
         COSIGN_PASSWORD='' cosign sign --yes --key cosign.key --allow-insecure-registry \
         --tlog-upload=false {repo}@{digest} >/dev/null 2>&1",
        w = work.display()
    ));
    let after_sign = sh_out(&format!("oras resolve --plain-http {repo}:{tag}"));
    assert_eq!(after_sign, resolved, "signing never moves the artifact digest (DEC-7)");

    // THE WITNESS: pull BY DIGEST offline from the cache of the loopback, and
    // the extracted layer.squashfs hashes to the manifest's sha256/size.
    let pulled = work.join("pulled");
    std::fs::create_dir_all(&pulled).expect("pull dir");
    sh(&format!(
        "cd {p} && oras pull --plain-http --output {pulled} {repo}@{digest} >/dev/null",
        p = work.display(),
        pulled = pulled.display()
    ));
    let layer_bytes = std::fs::read(pulled.join("layer.squashfs")).expect("pulled layer.squashfs");
    assert_eq!(layer_bytes.len() as u64, size, "pulled size == size_bytes");
    assert_eq!(
        sha256_hex(&layer_bytes),
        entry_sha,
        "pulled layer.squashfs sha256 == layer_sha256 (INV-4: verifiable offline after download)"
    );
}

/// **TEST-7 [acceptance] [INV-1, INV-3, INV-4] — tier A (no registry): the
/// pipeline-built layer vs the full fixture image.**
///
/// Assertions 1-2 (manifest↔artifact, marker + modes) run on every host with
/// docker + the generator's tools; assertion 3 (the stacked equivalence) runs
/// on a real-stack host. Gated through `record_skip` per tier.
#[test]
fn pipeline_layer_equivalence_with_full_image() {
    if !(have("docker") && have("python3") && have("git")) {
        record_skip(
            "pipeline_layer_equivalence_with_full_image",
            "needs docker (the fixture method build + full-image run + loopback) and \
             python3 + git (the generator's source-revision pin) on PATH",
        );
        return;
    }
    let work = scratch();
    std::fs::create_dir_all(&work).expect("work");
    let _guard = WorkGuard(work.clone());

    // ── build the layer with the REAL pipeline ──────────────────────────────
    let pipeline = build_pipeline(&work);
    let layer_dir = pipeline.layer_dir.clone();
    let record = pipeline.record.clone();
    let entry = pipeline.entry.clone();

    let layer_sqfs = layer_dir.join("layer.squashfs");
    let layer_bytes = std::fs::read(&layer_sqfs).expect("layer.squashfs");
    let layer_sha = sha256_hex(&layer_bytes);

    // 1. manifest ↔ artifact consistency: record + entry + the staged bytes.
    assert_eq!(record["layer_sha256"].as_str().expect("rec sha"), layer_sha);
    assert_eq!(entry["layer_sha256"].as_str().expect("entry sha"), layer_sha);
    assert_eq!(record["size_bytes"].as_u64(), Some(layer_bytes.len() as u64));
    assert_eq!(entry["size_bytes"].as_u64(), Some(layer_bytes.len() as u64));
    let oci_bytes = std::fs::read(layer_dir.join("oci-manifest.json")).expect("staged oci manifest");
    assert_eq!(
        entry["digest"].as_str().expect("digest"),
        format!("sha256:{}", sha256_hex(&oci_bytes)),
        "the manifest digest IS the staged artifact-manifest bytes (design §6.1)"
    );
    // The wrapper hash convention (design §2.2): method.json ‖ run file.
    let mj = std::fs::read(pipeline.record_dir.join("layer/code/method.json"))
        .expect("extracted method.json");
    let wrapper = std::fs::read(pipeline.record_dir.join("layer/code/run.py"))
        .expect("extracted run.py");
    let mut hasher = Sha256::new();
    hasher.update(&mj);
    hasher.update(&wrapper);
    assert_eq!(
        entry["wrapper_code_sha256"].as_str().expect("wrapper sha"),
        hex::encode(hasher.finalize()),
        "wrapper_code_sha256 == sha256(method.json ‖ run.py)"
    );

    // 2. marker + modes + layer-manifest rules, from the REAL bytes.
    let extract = work.join("layer-extract");
    sh(&format!(
        "unsquashfs -d {e} {s} >/dev/null",
        e = extract.display(),
        s = layer_sqfs.display()
    ));
    assert_eq!(
        std::fs::read_to_string(extract.join(".txr-method-env-layer-schema"))
            .expect("schema marker")
            .trim(),
        "1",
        "the schema marker reads 1"
    );
    assert_eq!(entry["layer_schema"], 1, "manifest layer_schema agrees");
    // The mount-readiness sentinel (design §5): the runtime's shared mount
    // primitive probes `usr/ present == mounted` for EVERY artifact — the
    // layer must carry a root-level usr/ (never an entry, never bound) or it
    // is never considered mounted (ROOTFS_MOUNT_FAILED, measured by this
    // test's own first run).
    assert!(
        extract.join("usr").is_dir(),
        "the layer carries the root-level usr/ mount-readiness sentinel (design §5)"
    );
    let manifest_entries: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(extract.join("layer-manifest.json"))
            .expect("layer-manifest.json"))
        .expect("entries json");
    let record_entries = record["layer_manifest"].as_array().expect("record entries");
    assert_eq!(manifest_entries.len(), record_entries.len());
    assert!(manifest_entries.iter().any(|e| e == "/code"), "/code is an entry");
    assert!(
        !manifest_entries.iter().any(|e| e == "/usr"),
        "the mount-readiness sentinel is never a layer-manifest entry"
    );
    for e in &manifest_entries {
        assert!(e.starts_with('/'), "absolute: {e}");
        assert!(!e.split('/').any(|c| c == ".."), "..-free: {e}");
        assert!(
            ["/usr/local", "/opt", "/code"]
                .iter()
                .any(|p| e == p || e.starts_with(&format!("{p}/"))),
            "entry under an allowed prefix: {e}"
        );
        assert!(
            extract.join(e.trim_start_matches('/')).exists(),
            "the layer carries the entry's subtree: {e}"
        );
    }
    // Modes: every file >= 0644, every dir >= 0755 (the 0600-wrapper pitfall
    // is the benchmark's repeated record; EX-7 asserts the layer never carries
    // one).
    let mut low_files = Vec::new();
    for line in sh_out(&format!(
        "find {e} -type f -printf '%m %p\\n'",
        e = extract.display()
    ))
    .lines()
    .filter(|l| !l.is_empty())
    {
        let (mode, _p) = line.split_once(' ').expect("mode path");
        let m = u32::from_str_radix(mode, 8).expect("octal mode");
        if m < 0o644 {
            low_files.push(line.to_string());
        }
    }
    assert!(low_files.is_empty(), "files below 0644 in the layer: {low_files:?}");
    let mut low_dirs = Vec::new();
    for line in sh_out(&format!(
        "find {e} -type d -printf '%m %p\\n'",
        e = extract.display()
    ))
    .lines()
    .filter(|l| !l.is_empty())
    {
        let (mode, _p) = line.split_once(' ').expect("mode path");
        let m = u32::from_str_radix(mode, 8).expect("octal mode");
        if m < 0o755 {
            low_dirs.push(line.to_string());
        }
    }
    assert!(low_dirs.is_empty(), "dirs below 0755 in the layer: {low_dirs:?}");

    // ── the full-image ground truth ─────────────────────────────────────────
    let bundle_full = work.join("bundle");
    write_bundle(&bundle_full);
    let model_out_full = work.join("model-out-full");
    let outputs_full = work.join("outputs-full");
    std::fs::create_dir_all(&model_out_full).expect("model out");
    std::fs::create_dir_all(&outputs_full).expect("outputs");
    let tag = pipeline.built_image_tag.clone();
    sh(&format!(
        "docker run --rm -v {b}:/input:ro -v {m}:/model -v {o}:/output -w /code {t} \
         python3 /code/run.py",
        b = bundle_full.display(),
        m = model_out_full.display(),
        o = outputs_full.display(),
        t = tag
    ));
    let full_pred = std::fs::read_to_string(outputs_full.join("predictions.csv"))
        .expect("full-image predictions");
    assert!(
        full_pred.contains("marker-1"),
        "the full image sees its OWN patched base package: {full_pred}"
    );

    // ── 3. the stacked equivalence (real-stack gate) ────────────────────────
    let Some(()) = stack_gate("pipeline_layer_equivalence_with_full_image") else {
        return;
    };
    // The base the delta was computed against: squashfs the generator's
    // extracted rootfs (the runtime mounts a squashfs; the compression is
    // irrelevant, the content is the pairing's subject).
    let base_rootfs = pipeline.base_cache_dir.join("rootfs");
    let base_sqfs = work.join("base.squashfs");
    sh(&format!(
        "mksquashfs {r} {o} -comp gzip -b 1M -noappend -no-progress -all-root >/dev/null",
        r = base_rootfs.display(),
        o = base_sqfs.display()
    ));
    if let Some(()) = stack_gate_pidns("pipeline_layer_equivalence_with_full_image", &base_rootfs) {
        let data = work.join("data");
        std::fs::create_dir_all(&data).expect("data dir");
        let (ok, stdout) = spawn_child(&work, &data, &base_sqfs, &layer_sqfs);
        if !ok {
            panic!("the stacked child must run clean:\n{stdout}");
        }
        assert_child_ran_one(&stdout);
        if let Some(reason) = child_skipped(&stdout) {
            record_skip("pipeline_layer_equivalence_with_full_image", &format!("child: {reason}"));
            return;
        }
    } else {
        return;
    }
    let stacked_pred =
        std::fs::read_to_string(work.join("outputs/predictions.csv")).expect("stacked predictions");
    assert_eq!(
        stacked_pred, full_pred,
        "EX-7/TEST-7: the stacked layer's predictions MUST be byte-identical to the \
         full method image's (the trim/shadow/prefix loop closes here)"
    );
}

/// **TEST-7 tier B — the loopback-registry witness (design §6.1).** The
/// pipeline-built artifact is pushed through the publisher's own byte shape,
/// signed, and pulled by digest: the manifest `digest`/`layer_sha256`/
/// `size_bytes` are the registry-visible truth. Gated docker+oras+cosign.
#[test]
fn pipeline_layer_pulled_by_digest_from_loopback() {
    if !(have("docker") && have("oras") && have("cosign")) {
        record_skip(
            "pipeline_layer_pulled_by_digest_from_loopback",
            "needs docker (the loopback `registry:2` fixture) + oras (push/pull) + \
             cosign (the signing witness) on PATH",
        );
        return;
    }
    let work = scratch();
    std::fs::create_dir_all(&work).expect("work");
    let container = format!("mel-env-reg-{}", Uuid::new_v4().simple());
    // Registry + cleanup declare order matters: the REGISTRY guard drops FIRST
    // (unmount + container), then the work guard removes the tree.
    let _guard = RegistryGuard { work: work.clone(), container: container.clone() };

    let pipeline = build_pipeline(&work);
    push_and_pull_by_digest(&work, &pipeline);
}
