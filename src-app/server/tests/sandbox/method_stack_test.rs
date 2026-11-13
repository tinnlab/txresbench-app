//! ITEM-7 — the sandbox-stacked integration suite (`tests/sandbox/mod.rs`
//! registration) over the REAL host tools. The unit tiers of ITEM-1..6 pin the
//! pure argv/grammar/digest/state-machine rules; this file exercises the
//! assembled seam against real bwrap + squashfuse + docker + oras:
//!
//! - TEST-04 (INV-4): `tree_sha256` determinism + `MODEL_VERIFY_FAILED` before
//!   any spawn; the read-only-bind half (a write attempt at `/model` inside a
//!   reuse run fails) runs inside the real-stack child.
//! - TEST-06 (INV-1): `MethodEnvManager::ensure` against a LOOPBACK OCI
//!   registry (the [env_image_oci_test] pattern) — pull → verify → cache →
//!   mount → status `ready`, ledger survives a manager re-init, and
//!   `MAX_CONCURRENT_DOWNLOADS = 2` is OBSERVED (no more than two
//!   `downloading` states across three concurrent pulls).
//! - TEST-07 (INV-1): a blob whose bytes do not hash to the pinned digest is
//!   refused `ENV_VERIFY_FAILED`, records `failed`, and NEVER reaches the
//!   cache (the negative control of TEST-06).
//! - TEST-08 (INV-2/INV-3): a real stacked FitPredict run — base fixture
//!   squashfs (usr/bin/bash + prlimit + cat) + layer fixture squashfs
//!   (`/code/run.sh` + `layer-manifest.json`) — exits 0, writes
//!   `/output/predictions.csv` into the caller's staging dir, binds `/input`
//!   read-only (a write attempt fails), writes the fit's `/model/model.json`
//!   into `model_out_dir` (DEC-6), and the `fit|started/done` +
//!   `predict|started/done` milestone frames + the live `log.stdout` frames
//!   arrive on the sink in order.
//! - TEST-09 (INV-6): the kept workspace carries `env-digest` (base) AND
//!   `layer-env-digest` (layer); the returned digests equal the recorded
//!   sidecars; a run with a different layer records a different layer digest
//!   and the same base digest; a reuse run (verified model,
//!   `model_verified: true`) records the same two digests and returns
//!   `model_out_digest` equal to `tree_sha256` of the saved model dir.
//! - TEST-11: `cancel` stops an in-flight pull against a slow loopback
//!   fixture; the ledger leaves `downloading`; a subsequent `ensure` retries
//!   cleanly to `ready`.
//! - TEST-12 (INV-1): the route matrix against the spawned server —
//!   401 / 403 / 200 / 404 `ENV_UNKNOWN` / 204 `DELETE ?prune` (cache entry +
//!   ledger gone) / a typed 503 on the friendly-degradation arm, with
//!   `/sandbox/status` still serving 200 as the positive control. (The 429
//!   full-pool arm's driver — the jobs admin REST surface — left with the
//!   jobs drawer UI in ITEM-3; the arm went with it; see the STRIP note at
//!   its former site.)
//! - TEST-13: `scripts/txr-sandbox-preflight.sh` exists, parses under
//!   `bash -n`, names every host requirement + its exact remediation, and
//!   exits non-zero under a PATH stub.
//!
//! Real-run gates follow the shipped discipline precisely
//! (`tests/sandbox/mod.rs` + `env_image_oci_test.rs`): every gate routes
//! through the SHARED [`record_skip`] (`target/test-skip-ledger.tsv`;
//! `TXR_TEST_NO_SKIP=1` turns each skip into a hard failure), and the reason
//! it prints is TRUE of the box it prints on.
//!
//! # The real-stack child (why a subprocess)
//!
//! TEST-04/08/09 drive the SEAM in-process, and the seam needs three things a
//! test thread cannot provide without poisoning sibling tests: `ensure` runs
//! its fetch/verify/mount on `spawn_blocking` (whose threads do NOT inherit
//! the thread-scoped `rootfs::scoped_data_root`), the global
//! `method_env::manager()` reads the air-gap seams off the PROCESS
//! environment, and the sandbox's `config::init_state` is process-global
//! first-write-wins. `set_var` is what this repo forbids (the measured
//! cross-test contamination documented in `env_image_oci_test.rs`'s header).
//! So the real stack runs in a CHILD PROCESS of this same test binary, with
//! its `TXR_APP_DATA_DIR` + seam vars passed through `Command::env` — the
//! exact mechanism `each_locally_built_env_resolves_to_its_own_artifact` uses.
//! The child either executes its scenario + panics on failure (the parent sees
//! a non-zero exit and fails the test), or reports `PROBE_SKIP <reason>` for a
//! host-dependent condition the PARENT then records as a skip; `PROBE_ERR` is
//! always a test failure (a capability said to exist did its job wrong).
//!
//! The PARENT is the real test: it gates, spawns, asserts the child ran
//! exactly one test (anti-vacuity, like `run_probe`), and owns the ledger line.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::common::{TestOptions, TestServer};
use crate::common::record_skip;

use txresbench::modules::sandbox::backend::{MilestoneFrame, ProgressFrame, ProgressSink};
use txresbench::modules::sandbox::method_env::{
    EnvKind, MethodEnvManager, MethodEnvSeams, MethodEnvState, ENV_VERIFY_FAILED_CODE,
};
use txresbench::modules::sandbox::stack::{
    tree_sha256, verify_model_tree, EnvRef, MethodRunMode, MethodRunRequest, ModelMount,
    MODEL_VERIFY_FAILED_CODE, TXR_BASE_REGISTRY_PREFIX, TXR_LAYER_REGISTRY_PREFIX,
};

// ────────────────────────────── child protocol ───────────────────────────────

/// The marker that switches `stacked_run_child` from libtest pass-through into
/// the probe it actually is (E5-style: a test that only exists behind a
/// parent, which re-execs it with `--exact`).
const CHILD_MARKER: &str = "TXR_MST_CHILD";

/// The parent's `--exact` test path for the child (must match the fn below —
/// if it silently selects zero tests, the parent's anti-vacuity assertion
/// fails instead of reporting a false green).
const CHILD_TEST_PATH: &str = "sandbox::method_stack_test::stacked_run_child";

/// The env-id components of the fixture artifacts (DATA, only ever spelled in
/// this test file): the base + the layer variants the scenarios stack.
const BASE_ID: &str = "mst-base-xq4";
const LAYER1_ID: &str = "mst-layer-a1q4";
const LAYER2_ID: &str = "mst-layer-a2q4";
/// The layer that carries a method's own packages in /opt/txr-layer.
const LAYER3_ID: &str = "mst-layer-a3q4";

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
    std::env::temp_dir().join(format!("txr-mst-{}", uuid::Uuid::new_v4()))
}

// ──────────────────────────── host stack gate ────────────────────────────────

/// Whether `user_allow_other` is ENABLED in `/etc/fuse.conf` (a commented
/// `#user_allow_other` line is NOT the flag — a non-root `squashfuse -o
/// allow_other` mount is refused without it, and the rootfs mounts are
/// `allow_other`).
fn user_allow_other_enabled() -> bool {
    let Ok(text) = std::fs::read_to_string("/etc/fuse.conf") else {
        return false;
    };
    text.lines().any(|l| {
        let stripped = l.trim_start();
        stripped.starts_with("user_allow_other") && !stripped.starts_with('#')
    })
}

/// The gate shared by every real-mount leg: bwrap + squashfuse + fusermount
/// (either generation) + the fuse.conf flag that a NON-root `-o allow_other`
/// mount requires — the same list `scripts/txr-sandbox-preflight.sh` asks.
/// The strict-PID-ns half is probed separately by [`stack_gate_pidns`],
/// because it needs the built base fixture. `None` = the leg must
/// `record_skip` with the carried reason.
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
             the dev-box prep script applies it with sudo)",
        );
        return None;
    }
    Some(())
}

/// The parent's strict-PID-ns gate: the shipped probes, run against the BUILT
/// base fixture dir (the probe binds `usr/` the way the run does). `None` =
/// this host cannot run a real stack; the caller must `record_skip` with the
/// probe's exact reason.
fn stack_gate_pidns(test: &str, base_dir: &Path) -> Option<()> {
    use txresbench::modules::sandbox::probes;
    let caps = probes::probe_host_only()?;
    if let Err(reason) = probes::probe_rootfs_dependent(&caps, base_dir) {
        record_skip(test, &reason);
        return None;
    }
    Some(())
}

// ────────────────────────────── fixtures ─────────────────────────────────────

/// Copy one absolute host path into `base/usr/…` — the sandbox binds ONLY
/// `base/usr` at `/usr` (+ `-try` `/opt`), so every binary and library must
/// land under `usr/` with its bwrap-resolved path shape: `/usr/bin/bash` →
/// `usr/bin/bash`, `/lib/x86_64-linux-gnu/libc.so.6` → `usr/lib/…`, and the
/// ELF interpreter `/lib64/ld-linux-x86-64.so.2` → `usr/lib64/…` (the argv's
/// `--symlink usr/lib /lib` + `usr/lib64 /lib64` resolve those). Symlinks are
/// dereferenced (`fs::copy` follows them — the usrmerge loader is a symlink).
fn copy_into_usr(base: &Path, abs: &Path) {
    let rel = abs.strip_prefix("/").expect("absolute path");
    let rel = if let Ok(r) = rel.strip_prefix("usr/") {
        Path::new("usr").join(r)
    } else {
        Path::new("usr").join(rel)
    };
    let dest = base.join(&rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).expect("fixture parent dir");
    }
    std::fs::copy(abs, &dest).expect("copy fixture file");
}

/// Resolve `binary` to the first executable file on `PATH`. Not `command -v`:
/// the shell reports its BUILTINS by name (`command -v true` → `true` — dash
/// and bash alike), which the old fixture build asserted absolute and died on
/// with "resolved true to true". A PATH walk is shell-dialect-free and
/// returns the file the exec would land on.
fn resolve_on_path(binary: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(binary))
        .find(|candidate| {
            std::fs::metadata(candidate)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        })
}

/// Copy `binary` (resolved on PATH) and every shared object `ldd` reports into
/// the base fixture.
fn copy_binary_into_base(base: &Path, binary: &str) {
    let bin = resolve_on_path(binary)
        .unwrap_or_else(|| panic!("could not resolve {binary} to an executable on PATH"));
    copy_into_usr(base, &bin);
    let ldd = sh_out(&format!("ldd {}", bin.display()));
    for line in ldd.lines() {
        for tok in line.split_whitespace() {
            if tok.starts_with('/') && Path::new(tok).is_absolute() {
                copy_into_usr(base, Path::new(tok));
            }
        }
    }
}

/// The minimal base rootfs dir: the shell + prlimit + cat the argv tail and
/// the fixture wrapper need, plus exactly their libraries — no docker, no
/// network, host-built from the running system's binaries.
fn build_base_rootfs(base: &Path) {
    std::fs::create_dir_all(base).expect("base fixture dir");
    for bin in ["bash", "prlimit", "cat", "true"] {
        copy_binary_into_base(base, bin);
    }
    // The bases' mount point for a method's own packages (tinnlab/txresbench base-images).
    std::fs::create_dir_all(base.join("opt/txr-layer")).expect("base /opt/txr-layer");
    assert!(
        base.join("usr/bin/bash").is_file() && base.join("usr/bin/true").is_file(),
        "the base fixture carries usr/bin/bash + usr/bin/true (the PID-ns probe runs /bin/true)"
    );
}

/// The layer rootfs dir: `/code/run.sh` (the fixture wrapper) + the root
/// `layer-manifest.json` listing the bind entries (PROV-SS-2 / DEC-14 shape
/// the `method-env-images` publisher produces).
fn build_layer_rootfs(root: &Path, run_sh: &str, entries: &[&str]) {
    std::fs::create_dir_all(root.join("code")).expect("layer code dir");
    std::fs::write(root.join("code/run.sh"), run_sh).expect("write run.sh");
    std::fs::write(
        root.join("layer-manifest.json"),
        serde_json::to_string(&entries).expect("manifest json"),
    )
    .expect("write layer-manifest.json");
}

/// `mksquashfs` a fixture dir into `out` (the artifact shape: one squashfs
/// whose root carries the layer files; host tool, no docker).
fn squash(dir: &Path, out: &Path) {
    sh(&format!(
        "mksquashfs {} {} -noappend -no-progress -comp zstd >/dev/null",
        dir.display(),
        out.display()
    ));
}

/// The fixture wrapper. Mode-aware per contract.md X1 (`SIGBENCH_MODE` unset =
/// one fit+predict call; `fit` / `predict` are the split modes):
///
/// - FIT: `cat /input/params.json > /model/model.json` (DEC-6: the fit's
///   `/model` is the caller's `model_out_dir`, bound RW).
/// - PREDICT: writes `/output/predictions.csv` from `/input/patients.csv`
///   (FitPredict) or proves the reuse `/model` read (ReuseModel).
/// - `/input` is probed read-only; a reuse run probes `/model` read-only (the
///   write must fail — TEST-04's INV-4 assertion).
/// - Milestones (`milestone|<id>|<status>|`) + plain stdout lines are emitted
///   so the FIFO drain delivers milestone + live `log.*` frames (GAP-1/2).
fn fixture_run_sh() -> &'static str {
    r#"#!/bin/bash
# Milestone lines ride the DRAINED channel: $TXR_PROGRESS_FIFO (the seam's
# FIFO → parse_milestone_line → sink.milestone). Plain stdout lines ride the
# LIVE channel (stream_lines_capped → log.stdout frames) and remain in
# MethodRunResult.stdout. Both channels are asserted by the child scenario.
emit() { echo "$1" > "$TXR_PROGRESS_FIFO"; }
echo "fixture wrapper: mode=${SIGBENCH_MODE:-fitpredict}"
if [ "$SIGBENCH_MODE" != "predict" ]; then
  emit "milestone|fit|started|"
  cat /input/params.json > /model/model.json
  emit "milestone|fit|done|"
fi
if [ "$SIGBENCH_MODE" != "fit" ]; then
  emit "milestone|predict|started|"
  if [ "$SIGBENCH_MODE" = "predict" ]; then
    IFS= read -r -n 16 md < /model/model.json
    echo "${md}-reuse" > /output/predictions.csv
  else
    echo "patient_id,pred" > /output/predictions.csv
    cat /input/patients.csv >> /output/predictions.csv
  fi
  emit "milestone|predict|done|"
fi
if echo leak > /input/leak 2>/dev/null; then
  echo "INPUT_RO_BROKEN"
  exit 7
fi
echo "INPUT_RO_OK"
if [ "$SIGBENCH_MODE" = "predict" ]; then
  if echo probe > /model/ro-probe 2>/dev/null; then
    echo "MODEL_RO_BROKEN"
    exit 8
  fi
  echo "MODEL_RO_OK"
fi
echo "fixture wrapper: done"
"#
}

/// The wrapper of the packages layer: it reports the package settings the sandbox set, reads a file
/// from the layer's /opt/txr-layer, and runs a program from /opt/txr-layer/bin found through PATH.
fn packages_run_sh() -> &'static str {
    r#"#!/bin/bash
echo "PYTHONUSERBASE=$PYTHONUSERBASE"
echo "PYTHONPATH=$PYTHONPATH"
echo "R_LIBS=$R_LIBS"
echo "PATH=$PATH"
echo "MARKER=$(cat /opt/txr-layer/lib/marker.txt)"
txr-layer-tool
echo '{"fit": true}' > /model/model.json
echo "patient_id,pred" > /output/predictions.csv
cat /input/patients.csv >> /output/predictions.csv
"#
}

/// The packages layer: `/code/run.sh` + a method's own packages under `/opt/txr-layer` (a data file and a
/// program in its `bin/`), with the entries the generator emits for such a method.
fn build_packages_layer_rootfs(root: &Path) {
    build_layer_rootfs(root, packages_run_sh(), &["/code", "/opt/txr-layer"]);
    let lib = root.join("opt/txr-layer/lib");
    let bin = root.join("opt/txr-layer/bin");
    std::fs::create_dir_all(&lib).expect("layer lib dir");
    std::fs::create_dir_all(&bin).expect("layer bin dir");
    std::fs::write(lib.join("marker.txt"), "method packages").expect("write marker");
    let tool = bin.join("txr-layer-tool");
    std::fs::write(&tool, "#!/bin/bash\necho TOOL_FROM_LAYER_PATH\n").expect("write tool");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).expect("tool mode");
}

/// Write a contract-shaped input bundle (the layout CONS-SS-1 names; the
/// sandbox does not read a byte of it — the run's contract, not the kernel's).
fn write_bundle(dir: &Path) {
    std::fs::create_dir_all(dir.join("train")).expect("bundle train dir");
    std::fs::create_dir_all(dir.join("test")).expect("bundle test dir");
    std::fs::write(
        dir.join("params.json"),
        json!({ "task": "response", "horizons": [30, 90], "features": ["m1"], "threads": 1 })
            .to_string(),
    )
    .expect("params.json");
    std::fs::write(dir.join("train/long.csv"), "patient_id,day,m1\np1,0,1.0\np2,0,2.0\n")
        .expect("train/long");
    std::fs::write(dir.join("train/outcomes.csv"), "patient_id,event,time\np1,1,60\np2,0,200\n")
        .expect("train/outcomes");
    std::fs::write(dir.join("train/covariates.csv"), "patient_id,age\np1,50\np2,70\n")
        .expect("train/covars");
    std::fs::write(dir.join("test/long.csv"), "patient_id,day,m1\np1,0,1.0\np2,0,2.0\n")
        .expect("test/long");
    std::fs::write(dir.join("test/patients.csv"), "patient_id\np1\np2\n").expect("test/patients");
    std::fs::write(dir.join("test/covariates.csv"), "patient_id,age\np1,50\np2,70\n")
        .expect("test/covars");
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

/// RAII for the loopback registry container + any fuse mounts + the temp dir
/// (the same sweep shape as `env_image_oci_test`'s guard; a mount missed here
/// survives `remove_dir_all` as a live squashfuse daemon over a deleted path).
/// The container name is per-guard (the tests run in one binary and can be
/// concurrent — a shared `mst-env-reg` name would let one test's guard remove
/// a sibling's registry).
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

// ─────────────────────────── the child process ───────────────────────────────

/// ONE REAL stacked run through the seam, inside a child process (see the file
/// header). A parent re-execs this exact test with the marker + its env set;
/// the child drives `run_method_in_stack` against host-built fixtures staged
/// through the air-gap seams, asserts everything a scenario owns, and prints
/// exactly one `PROBE_OK` / `PROBE_SKIP` / `PROBE_ERR` line. Only the PARENT
/// records skips (it owns the ledger line); a child failure is a panic whose
/// trace the parent surfaces as the test failure.
#[tokio::test]
async fn stacked_run_child() {
    use txresbench::modules::sandbox::config::{self, SandboxAvailability, SandboxState};
    use txresbench::modules::sandbox::probes;
    use txresbench::modules::sandbox::service::run_method_in_stack;
    use txresbench::modules::sandbox::stack::read_run_layer_digest;
    use txresbench::modules::sandbox::types::ExtraMount;
    use std::sync::Arc;

    let Some(marker) = std::env::var_os(CHILD_MARKER) else {
        return; // bare libtest run: the child only exists behind a parent
    };
    let scenario = marker.to_string_lossy().to_string();
    let data_dir = PathBuf::from(
        std::env::var_os("TXR_APP_DATA_DIR").expect("parent passes TXR_APP_DATA_DIR"),
    );
    let work = PathBuf::from(std::env::var_os("TXR_MST_WORK").expect("TXR_MST_WORK"));

    let fail = |what: String| -> ! {
        eprintln!("PROBE_ERR {what}");
        panic!("child scenario {scenario:?}: {what}");
    };

    // In-process sandbox init, exactly what the server subprocess does at boot
    // (probe → workspace roots → state). The child is its OWN process, so
    // this first-write-wins state is invisible to every sibling.
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

    // The settings read falls back to the defaults on an empty in-memory db
    // (settings_cache::get's documented DB-error fallback — the seam needs a
    // pool, not a populated one; the sandbox_settings table does not exist in
    // `:memory:`).
    let pool = sqlx::SqlitePool::connect("sqlite::memory:")
        .await
        .expect("in-memory pool");

    let base_sqfs = PathBuf::from(std::env::var_os("TXR_MST_BASE_SQFS").expect("base"));
    let layer1_sqfs = PathBuf::from(std::env::var_os("TXR_MST_LAYER1_SQFS").expect("layer1"));
    let layer2_sqfs = PathBuf::from(std::env::var_os("TXR_MST_LAYER2_SQFS").expect("layer2"));
    let base_pin = sha256_hex(&std::fs::read(&base_sqfs).expect("read base fixture"));
    let layer1_pin = sha256_hex(&std::fs::read(&layer1_sqfs).expect("read layer1 fixture"));
    let layer2_pin = sha256_hex(&std::fs::read(&layer2_sqfs).expect("read layer2 fixture"));
    let base_ref = EnvRef {
        oci_ref: format!("{TXR_BASE_REGISTRY_PREFIX}/{BASE_ID}"),
        digest: base_pin.clone(),
        tag: None,
    };
    let layer_ref = |id: &str, pin: &str| EnvRef {
        oci_ref: format!("{TXR_LAYER_REGISTRY_PREFIX}/{id}"),
        digest: pin.to_string(),
        tag: None,
    };

    let bundle = work.join("bundle");
    write_bundle(&bundle);

    /// One seam call with an EXTERNALLY-owned job id (the workspace the
    /// sidecars land in is named by it — TEST-09 reads them back).
    macro_rules! run_one {
        ($job:expr, $layer:expr, $mode:expr, $model:expr, $model_out:expr, $outputs:expr, $sink:expr) => {
            run_method_in_stack(
                &pool,
                &MethodRunRequest {
                    base: base_ref.clone(),
                    layer: $layer,
                    mode: $mode,
                    bundle_dir: bundle.clone(),
                    outputs_dir: $outputs,
                    model: $model,
                    model_out_dir: $model_out,
                    n_cpu: 1,
                    timeout_secs: Some(300),
                },
                &[] as &[ExtraMount],
                $job,
                $sink,
            )
            .await
        };
    }

    match scenario.as_str() {
        // TEST-04 (RO half) + TEST-08 + TEST-09 in one scenario: three runs —
        // FitPredict(layer1), FitPredict(layer2), ReuseModel(layer1).
        "fitpredict_reuse" => {
            // ── 1. FitPredict(layer1): the acceptance run of PROV-SS-1/SS-2 ──
            let sink1 = Arc::new(RecordingSinkExt::new());
            let job1 = Uuid::new_v4();
            let outputs1 = work.join("outputs-run1");
            let model_out1 = work.join("model-out-run1");
            let ws1 = data_dir.join("sandboxes").join(job1.to_string());
            let r1 = match run_one!(
                job1,
                layer_ref(LAYER1_ID, &layer1_pin),
                MethodRunMode::FitPredict,
                None,
                Some(model_out1.clone()),
                outputs1.clone(),
                Some(sink1.clone())
            ) {
                Ok(r) => r,
                Err(e) => fail(format!("fitpredict run 1 refused: {} ({})", e.error_code(), e)),
            };
            assert_eq!(r1.exit_code, 0, "run 1 exits 0; stdout: {}", r1.stdout);
            let r1_stdout = r1.stdout.clone();
            assert!(
                r1_stdout.contains("fixture wrapper: mode=fitpredict"),
                "mode line: {r1_stdout}"
            );
            assert!(r1_stdout.contains("INPUT_RO_OK"), "/input read-only probe: {r1_stdout}");
            assert!(r1_stdout.contains("fixture wrapper: done"), "complete: {r1_stdout}");
            assert!(outputs1.join("predictions.csv").is_file(), "/output/predictions.csv written");
            let pred = std::fs::read_to_string(outputs1.join("predictions.csv")).expect("predictions");
            assert!(
                pred.contains("patient_id,pred") && pred.contains("p1"),
                "predictions rows: {pred}"
            );
            let fitted = std::fs::read_to_string(model_out1.join("model.json")).expect("model.json");
            let params = std::fs::read_to_string(bundle.join("params.json")).expect("params.json");
            assert_eq!(fitted, params, "the fit wrote /model/model.json from /input (DEC-6)");
            assert_eq!(
                r1.model_out_digest.as_deref(),
                Some(tree_sha256(&model_out1).expect("model-out digest").as_str()),
                "model_out_digest is tree_sha256 of what was fit"
            );
            // INV-6: the returned digests equal the recorded sidecars = the pins.
            assert_eq!(r1.base_env_digest, base_pin, "base digest: {}", r1.base_env_digest);
            assert_eq!(r1.layer_env_digest, layer1_pin, "layer digest: {}", r1.layer_env_digest);
            let side_base = std::fs::read_to_string(ws1.join("env-digest")).expect("env-digest");
            let side_layer =
                std::fs::read_to_string(ws1.join("layer-env-digest")).expect("layer sidecar");
            assert_eq!(
                side_base.trim(),
                r1.base_env_digest,
                "the workspace env-digest equals the returned base digest"
            );
            assert_eq!(
                side_layer.trim(),
                r1.layer_env_digest,
                "the workspace layer-env-digest equals the returned layer digest"
            );
            assert_eq!(read_run_layer_digest(&ws1), Some(layer1_pin.clone()));
            // The milestone + live-log frames arrived on the sink with the run.
            let milestones: Vec<(String, String)> = sink1
                .milestones()
                .iter()
                .map(|m| (m.id.clone(), m.status.clone()))
                .collect();
            assert_eq!(
                milestones,
                vec![
                    ("fit".to_string(), "started".to_string()),
                    ("fit".to_string(), "done".to_string()),
                    ("predict".to_string(), "started".to_string()),
                    ("predict".to_string(), "done".to_string()),
                ],
                "the four milestone frames, in order (TEST-08)"
            );
            let logs: Vec<(String, String)> = sink1
                .logs()
                .iter()
                .map(|f| (f.phase.clone(), f.message.clone().unwrap_or_default()))
                .collect();
            assert!(
                logs.iter().any(|(ph, msg)| ph == "log.stdout"
                    && msg.contains("fixture wrapper: mode")),
                "the first wrapper line rode a live log.stdout frame: {logs:?}"
            );
            assert!(
                logs.iter().any(|(ph, msg)| ph == "log.stdout" && msg.contains("done")),
                "log frames: {logs:?}"
            );

            // ── 2. FitPredict(layer2): TEST-09's "a different layer differs" ──
            let sink2 = Arc::new(RecordingSinkExt::new());
            let job2 = Uuid::new_v4();
            let ws2 = data_dir.join("sandboxes").join(job2.to_string());
            let outputs2 = work.join("outputs-run2");
            let model_out2 = work.join("model-out-run2");
            let r2 = match run_one!(
                job2,
                layer_ref(LAYER2_ID, &layer2_pin),
                MethodRunMode::FitPredict,
                None,
                Some(model_out2.clone()),
                outputs2.clone(),
                Some(sink2.clone())
            ) {
                Ok(r) => r,
                Err(e) => fail(format!("fitpredict run 2 refused: {} ({})", e.error_code(), e)),
            };
            assert_eq!(r2.exit_code, 0, "run 2 exits 0; stdout: {}", r2.stdout);
            assert_eq!(r2.base_env_digest, r1.base_env_digest, "same base, same base digest");
            assert_ne!(
                r2.layer_env_digest, r1.layer_env_digest,
                "the two layer fixtures are distinct artifacts — the digest records which"
            );
            let side_layer2 =
                std::fs::read_to_string(ws2.join("layer-env-digest")).expect("layer2 sidecar");
            assert_eq!(side_layer2.trim(), r2.layer_env_digest);
            assert_eq!(
                std::fs::read_to_string(ws2.join("env-digest"))
                    .expect("env-digest run2")
                    .trim(),
                r1.base_env_digest,
                "run 2 records the SAME base digest"
            );

            // ── 3. ReuseModel(layer1): TEST-04's RO probe + TEST-09's reuse ──
            let verified = tree_sha256(&model_out1).expect("model-out digest");
            let sink3 = Arc::new(RecordingSinkExt::new());
            let job3 = Uuid::new_v4();
            let ws3 = data_dir.join("sandboxes").join(job3.to_string());
            let outputs3 = work.join("outputs-reuse");
            let r3 = match run_one!(
                job3,
                layer_ref(LAYER1_ID, &layer1_pin),
                MethodRunMode::ReuseModel,
                Some(ModelMount {
                    host_path: model_out1.clone(),
                    tree_sha256: verified.clone(),
                }),
                None,
                outputs3.clone(),
                Some(sink3.clone())
            ) {
                Ok(r) => r,
                Err(e) => fail(format!("reuse run refused: {} ({})", e.error_code(), e)),
            };
            assert_eq!(r3.exit_code, 0, "reuse exits 0; stdout: {}", r3.stdout);
            assert!(r3.model_verified, "the model tree check ran and passed (INV-4)");
            assert_eq!(r3.model_out_digest, None, "a reuse run writes no model");
            let pred3 = std::fs::read_to_string(outputs3.join("predictions.csv")).expect("reuse predictions");
            assert!(pred3.contains("-reuse"), "the reuse run read /model: {pred3}");
            assert!(r3.stdout.contains("MODEL_RO_OK"), "/model read-only probe: {}", r3.stdout);
            assert_eq!(r3.base_env_digest, r1.base_env_digest);
            assert_eq!(r3.layer_env_digest, r1.layer_env_digest, "reuse stacks layer1 again");
            assert_eq!(
                std::fs::read_to_string(ws3.join("layer-env-digest")).unwrap_or_default().trim(),
                r3.layer_env_digest,
                "the reuse run records the same two digests"
            );

            println!("PROBE_OK fitpredict_run1_wrote_output_and_model + digests + milestones + reuse_ro");
        }
        // TEST-04 (tamper half, seam level): the seam refuses a mismatched
        // TreeDigest BEFORE any staging/spawn — `verify_model_tree` runs ahead
        // of `ensure` in the seam, so a tampered model never triggers a fetch.
        "reuse_tamper" => {
            let dir = work.join("tampered-model");
            std::fs::create_dir_all(&dir).expect("tampered-model dir");
            std::fs::write(dir.join("model.json"), "{\"fit\": true}").expect("model.json");
            // The digest the caller declares is computed over the PRISTINE
            // tree; the bytes are then tampered — the verification must fire.
            let declared = tree_sha256(&dir).expect("pristine digest");
            std::fs::write(dir.join("model.json"), "{\"fit\": false}").expect("tamper");
            let job = Uuid::new_v4();
            let ws = data_dir.join("sandboxes").join(job.to_string());
            let err = run_method_in_stack(
                &pool,
                &MethodRunRequest {
                    base: base_ref.clone(),
                    layer: layer_ref(LAYER1_ID, &layer1_pin),
                    mode: MethodRunMode::ReuseModel,
                    bundle_dir: bundle.clone(),
                    outputs_dir: work.join("outputs-tamper"),
                    model: Some(ModelMount {
                        host_path: dir,
                        tree_sha256: declared,
                    }),
                    model_out_dir: None,
                    n_cpu: 1,
                    timeout_secs: Some(120),
                },
                &[] as &[ExtraMount],
                job,
                None,
            )
            .await
            .expect_err("a tampered model is refused");
            assert_eq!(err.error_code(), MODEL_VERIFY_FAILED_CODE, "{}", err);
            assert!(
                !ws.exists(),
                "the refusal happened before any workspace/staging work — nothing spawned"
            );
            println!("PROBE_OK tamper_refused_before_any_bind");
        }
        // A layer carrying a method's own packages in /opt/txr-layer: bound onto the base's mount
        // point, with the sandbox's package settings pointing Python, R and PATH at it.
        "packages_layer" => {
            let layer3_sqfs =
                PathBuf::from(std::env::var_os("TXR_MST_LAYER3_SQFS").expect("layer3"));
            let layer3_pin = sha256_hex(&std::fs::read(&layer3_sqfs).expect("read layer3 fixture"));
            let job = Uuid::new_v4();
            let outputs = work.join("outputs-packages");
            let r = match run_one!(
                job,
                layer_ref(LAYER3_ID, &layer3_pin),
                MethodRunMode::FitPredict,
                None,
                Some(work.join("model-out-packages")),
                outputs.clone(),
                None
            ) {
                Ok(r) => r,
                Err(e) => fail(format!("packages-layer run refused: {} ({})", e.error_code(), e)),
            };
            assert_eq!(r.exit_code, 0, "the packages-layer run exits 0; stdout: {}", r.stdout);
            let out = r.stdout;
            for line in [
                "PYTHONUSERBASE=/opt/txr-layer",
                "PYTHONPATH=/opt/txrmethod",
                "R_LIBS=/opt/txr-layer/R-library:/usr/local/lib/R/site-library:/usr/local/lib/R/library",
                "MARKER=method packages",
                "TOOL_FROM_LAYER_PATH",
            ] {
                assert!(out.lines().any(|l| l == line), "missing {line:?} in: {out}");
            }
            assert!(
                out.lines().any(|l| l.starts_with("PATH=/opt/txr-layer/bin:")),
                "the method's bin dir leads PATH: {out}"
            );
            assert!(outputs.join("predictions.csv").is_file(), "/output/predictions.csv written");
            println!("PROBE_OK packages_layer");
        }
        other => fail(format!("unknown scenario {other:?}")),
    }
}

/// The sink used inside the child: the REAL trait + a snapshot accessor the
/// assertions read after the service returned (the seam keeps frames in the
/// trait's own carrier; `milestones`/`logs` return a Vec snapshot).
struct RecordingSinkExt {
    progress: std::sync::Mutex<Vec<ProgressFrame>>,
    milestones: std::sync::Mutex<Vec<MilestoneFrame>>,
}

impl RecordingSinkExt {
    fn new() -> Self {
        Self {
            progress: std::sync::Mutex::new(Vec::new()),
            milestones: std::sync::Mutex::new(Vec::new()),
        }
    }
    fn milestones(&self) -> Vec<MilestoneFrame> {
        self.milestones.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
    fn logs(&self) -> Vec<ProgressFrame> {
        self.progress.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl ProgressSink for RecordingSinkExt {
    fn progress(&self, frame: ProgressFrame) {
        self.progress.lock().unwrap_or_else(|p| p.into_inner()).push(frame);
    }
    fn milestone(&self, frame: MilestoneFrame) {
        self.milestones.lock().unwrap_or_else(|p| p.into_inner()).push(frame);
    }
}

// ────────────────────────── parent spawn plumbing ────────────────────────────

/// Spawn the child probe for `scenario` with the fixture env; returns
/// `(exit_success, stdout)`.
fn spawn_child(work: &Path, data_dir: &Path, scenario: &str) -> (bool, String) {
    let exe = std::env::current_exe().expect("test binary path");
    let out = Command::new(exe)
        .args([
            "--exact",
            CHILD_TEST_PATH,
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_MARKER, scenario)
        .env("TXR_APP_DATA_DIR", data_dir)
        .env("TXR_MST_WORK", work)
        .env("TXR_MST_BASE_SQFS", work.join("base.squashfs"))
        .env("TXR_MST_LAYER1_SQFS", work.join("layer1.squashfs"))
        .env("TXR_MST_LAYER2_SQFS", work.join("layer2.squashfs"))
        .env("TXR_MST_LAYER3_SQFS", work.join("layer3.squashfs"))
        .env(format!("TXR_ENV_ROOTFS_SQUASHFS__{BASE_ID}"), work.join("base.squashfs"))
        .env(
            format!("TXR_ENV_ROOTFS_SQUASHFS__{LAYER1_ID}"),
            work.join("layer1.squashfs"),
        )
        .env(
            format!("TXR_ENV_ROOTFS_SQUASHFS__{LAYER2_ID}"),
            work.join("layer2.squashfs"),
        )
        .env(
            format!("TXR_ENV_ROOTFS_SQUASHFS__{LAYER3_ID}"),
            work.join("layer3.squashfs"),
        )
        // The child must start from a clean seam environment: whatever this
        // box exported to run the rootfs-gated tiers would otherwise leak in
        // and decide the outcome (the same removal list `run_probe` uses).
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

/// Whether the child reported a host-dependent skip (the PARENT records it) —
/// asserted AFTER the anti-vacuity check.
fn child_skipped(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find(|l| l.starts_with("PROBE_SKIP "))
        .map(|l| l.trim_start_matches("PROBE_SKIP ").to_string())
}

/// Assert the child ran EXACTLY one test (anti-vacuity — a child that
/// selected zero tests must not read as a pass).
fn assert_child_ran_one(stdout: &str) {
    assert!(
        stdout.lines().any(|l| l.starts_with("test result: ok. 1 passed")),
        "the child did not report EXACTLY one passing test:\n{stdout}"
    );
    assert!(
        stdout.contains("PROBE_OK ") || child_skipped(stdout).is_some(),
        "the child printed neither PROBE_OK nor PROBE_SKIP:\n{stdout}"
    );
}

/// Build the fixture set once for the child legs: base + layer1 + layer2 + layer3 (packages)
/// squashfs under `work`. Returns the plain base DIR (for the PID-ns gate).
fn build_stack_fixtures(work: &Path) -> PathBuf {
    let base_dir = work.join("base-root");
    build_base_rootfs(&base_dir);
    squash(&base_dir, &work.join("base.squashfs"));

    // layer1: the wrapper + entries; layer2: the identical shape with one
    // trailing marker line (the artifact differs while the entries do not).
    build_layer_rootfs(&work.join("layer1-root"), fixture_run_sh(), &["/code"]);
    squash(&work.join("layer1-root"), &work.join("layer1.squashfs"));
    let run2 = format!("{}\n# layer2 marker\n", fixture_run_sh());
    build_layer_rootfs(&work.join("layer2-root"), &run2, &["/code"]);
    squash(&work.join("layer2-root"), &work.join("layer2.squashfs"));
    build_packages_layer_rootfs(&work.join("layer3-root"));
    squash(&work.join("layer3-root"), &work.join("layer3.squashfs"));
    base_dir
}

// ─────────────────────────────── TEST-04 ─────────────────────────────────────

/// **TEST-04 [acceptance] [INV-4]** — the model half. (a) `tree_sha256` is
/// deterministic over the same tree; (b) a tampered model dir is refused
/// `MODEL_VERIFY_FAILED`; (c) the seam-level refusal + the RO-bind-in-a-run
/// half are the child scenarios (gated on the real stack).
#[test]
fn model_tree_digest_and_tamper_refusal() {
    let work = scratch();
    std::fs::create_dir_all(&work).expect("work");
    let _guard = WorkGuard(work.clone());

    let model = work.join("model");
    std::fs::create_dir_all(&model).expect("model dir");
    std::fs::write(model.join("model.json"), "{\"fit\": true}").expect("model file");
    std::fs::write(model.join("meta.json"), "{\"method\": \"m\"}").expect("meta file");

    // (a) deterministic: two passes over the identical tree agree.
    let d1 = tree_sha256(&model).expect("first digest");
    let d2 = tree_sha256(&model).expect("second digest");
    assert_eq!(d1, d2, "tree_sha256 is deterministic");
    assert_eq!(d1.len(), 64, "sha256 hex");

    // (b) a tamper refusal, before any spawn — the exact gate the seam runs.
    let err = verify_model_tree(&model, &"0".repeat(64)).expect_err("tampered");
    assert_eq!(err.error_code(), MODEL_VERIFY_FAILED_CODE, "{}", err);
    verify_model_tree(&model, &d1).expect("pristine tree passes");

    // (c) the seam-level refusal (before any staging/spawn) + the in-run RO
    // half live in the child (real stack gate).
    if let Some(()) = stack_gate("model_tree_digest_and_tamper_refusal") {
        let base_dir = build_stack_fixtures(&work);
        if let Some(()) = stack_gate_pidns("model_tree_digest_and_tamper_refusal", &base_dir) {
            let data = work.join("data");
            std::fs::create_dir_all(&data).expect("data dir");
            let (ok, stdout) = spawn_child(&work, &data, "reuse_tamper");
            assert!(ok, "the tamper-refusal child must run clean");
            assert_child_ran_one(&stdout);
            if let Some(reason) = child_skipped(&stdout) {
                record_skip(
                    "model_tree_digest_and_tamper_refusal",
                    &format!("child: {reason}"),
                );
            }
        }
    }
}

// ─────────────────────────────── TEST-06 ─────────────────────────────────────

/// **TEST-06 [acceptance] [INV-1]** — PROV-SS-4 against the REAL loopback OCI
/// registry: publish → resolve → pull → verify → cache → mount → status
/// `ready` + digest, the ledger survives a manager re-init, and the
/// `MAX_CONCURRENT_DOWNLOADS = 2` cap is OBSERVED (never more than two
/// `downloading` states across three concurrent pulls of DISTINCT digests —
/// a same-digest request is the cached mount, so the contention leg needs
/// three separate artifacts). Gated on docker + oras + squashfuse +
/// `user_allow_other`; the loopback `registry:2` fixture never leaves the
/// machine.
#[test]
fn env_manager_pulls_verifies_mounts_via_loopback_registry() {
    if !(have("docker") && have("oras")) {
        record_skip(
            "env_manager_pulls_verifies_mounts_via_loopback_registry",
            "needs docker (the loopback `registry:2` fixture) + oras (the publish/pull tool) \
             on PATH; the unit tier pins the state machine with a stub oras",
        );
        return;
    }
    let Some(()) = stack_gate("env_manager_pulls_verifies_mounts_via_loopback_registry") else {
        return;
    };

    let work = scratch();
    let _guard = WorkGuard(work.clone());
    // Registry + cleanup declare order matters: the REGISTRY guard drops FIRST
    // (unmount + container), then the work guard removes the tree.
    let container = format!("mst-env-reg-5066");
    sh(&format!(
        "docker rm -f {container} >/dev/null 2>&1; docker run -d --name {container} -p 5066:5000 registry:2 >/dev/null && sleep 2"
    ));
    let _reg_guard = RegistryGuard { work: work.clone(), container };
    let data = work.join("appdata");
    std::fs::create_dir_all(&data).expect("appdata");
    let reg = "localhost:5066"; // dedicated port: never collide with a stray :5000
    let seams = MethodEnvSeams {
        registry: Some(reg.to_string()),
        bypass_air_gap_env: true,
    };

    let publish = |sqfs: &Path, repo: &str, tag: &str| -> String {
        sh(&format!(
            "cd {} && oras push --plain-http --artifact-type \
             application/vnd.txr.method-env.squashfs.v1 {repo}:{tag} {}:application/vnd.txr.method-env.squashfs.v1 >/dev/null",
            work.display(),
            sqfs.display(),
        ));
        sh_out(&format!("oras resolve --plain-http {repo}:{tag}"))
            .trim_start_matches("sha256:")
            .to_string()
    };

    // A tiny real squashfs (the positive-path artifact) + two 64 MiB
    // real-squashfs artifacts (the concurrency meter — an incompressible file
    // keeps the pull in flight long enough to observe contention).
    let small_dir = work.join("small-root");
    build_layer_rootfs(&small_dir, fixture_run_sh(), &["/code"]);
    // The positive path asserts the mount's `usr/` (the cache mount fact the
    // status reports); a small file makes the dir survive the squash.
    std::fs::create_dir_all(small_dir.join("usr")).expect("small usr dir");
    std::fs::write(small_dir.join("usr/marker"), "x").expect("small usr marker");
    squash(&small_dir, &work.join("small.squashfs"));
    let blob_dir = |name: &str| -> PathBuf {
        let d = work.join(name);
        std::fs::create_dir_all(d.join("data")).expect("blob dir");
        sh(&format!(
            "head -c 67108864 /dev/urandom > {}/data/blob.bin",
            d.join("data").display()
        ));
        squash(&d, &work.join(format!("{name}.squashfs")));
        work.join(format!("{name}.squashfs"))
    };
    let big_a = blob_dir("big-a-root");
    let big_b = blob_dir("big-b-root");
    // small2: a layer-shaped artifact with a DIFFERENT digest from small.
    let small2_dir = work.join("small2-root");
    std::fs::create_dir_all(&small2_dir).expect("small2");
    std::fs::write(small2_dir.join("marker.json"), "{}").expect("small2 marker");
    squash(&small2_dir, &work.join("small2-root.squashfs"));

    let small_pin = publish(
        &work.join("small.squashfs"),
        &format!("{reg}/tinnlab/txresbench-env/mst-small-x7"),
        "v1",
    );
    let big_a_pin = publish(&big_a, &format!("{reg}/tinnlab/txresbench-env/mst-biga-x7"), "v1");
    let big_b_pin = publish(&big_b, &format!("{reg}/tinnlab/txresbench-env/mst-bigb-x7"), "v1");
    let small2_pin = publish(
        &work.join("small2-root.squashfs"),
        &format!("{reg}/tinnlab/txresbench-env/mst-small2-x7"),
        "v1",
    );

    let _data_guard = txresbench::modules::rootfs::scoped_data_root(&data);
    let manager = Arc::new(MethodEnvManager::with_seams(seams.clone()));

    // ── positive path: ensure → ready + digest + mounted ────────────────────
    let small_ref = EnvRef {
        oci_ref: format!("{reg}/tinnlab/txresbench-env/mst-small-x7:v1"),
        digest: small_pin.clone(),
        tag: None,
    };
    let mount = manager
        .ensure(&small_ref, EnvKind::Base, std::time::Duration::from_secs(600))
        .expect("ensure pulls verifies mounts");
    assert!(mount.mount_dir.join("usr").is_dir(), "mounted rootfs exposes usr/");
    assert_eq!(mount.digest.as_deref(), Some(small_pin.as_str()));
    let status = manager.status("mst-small-x7");
    assert_eq!(status.state, MethodEnvState::Ready);
    assert_eq!(status.digest.as_deref(), Some(small_pin.as_str()));
    assert!(status.mounted, "the cache mount's usr/ is visible");
    assert!(manager.list().iter().any(|s| s.env_id == "mst-small-x7"), "list reports the id");

    // The ledger survives a manager re-init: a FRESH manager over the SAME
    // data root reads the persisted record.
    let manager2 = MethodEnvManager::with_seams(seams.clone());
    let status2 = manager2.status("mst-small-x7");
    assert_eq!(status2.state, MethodEnvState::Ready, "re-init reads the persisted state");
    assert_eq!(status2.digest.as_deref(), Some(small_pin.as_str()));

    // ── MAX_CONCURRENT_DOWNLOADS: three concurrent pulls of three distinct
    //    digests (a same-digest request resolves to the cached mount and never
    //    occupies a slot — the observation would be vacuous). ────────────────
    let ref_a = EnvRef {
        oci_ref: format!("{reg}/tinnlab/txresbench-env/mst-biga-x7:v1"),
        digest: big_a_pin.clone(),
        tag: None,
    };
    let ref_b = EnvRef {
        oci_ref: format!("{reg}/tinnlab/txresbench-env/mst-bigb-x7:v1"),
        digest: big_b_pin.clone(),
        tag: None,
    };
    let small2_ref = EnvRef {
        oci_ref: format!("{reg}/tinnlab/txresbench-env/mst-small2-x7:v1"),
        digest: small2_pin.clone(),
        tag: None,
    };
    let threads: Vec<_> = vec![
        (manager.clone(), ref_a, EnvKind::Base),
        (manager.clone(), ref_b, EnvKind::Base),
        (manager.clone(), small2_ref, EnvKind::Base),
    ]
    .into_iter()
    .map(|(m, r, k)| {
        let data = data.clone();
        std::thread::spawn(move || {
            // The scoped data root is per-THREAD: a worker installs its own
            // (the module's hermetic pattern — never process-env mutation).
            let _g = txresbench::modules::rootfs::scoped_data_root(data);
            m.ensure(&r, k, std::time::Duration::from_secs(600))
        })
    })
    .collect();

    let mut saw_two = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(300);
    loop {
        let states: Vec<MethodEnvState> = ["mst-biga-x7", "mst-bigb-x7", "mst-small2-x7"]
            .iter()
            .map(|id| manager.status(id).state)
            .collect();
        let downloading = states
            .iter()
            .filter(|s| **s == MethodEnvState::Downloading)
            .count();
        assert!(
            downloading <= 2,
            "MAX_CONCURRENT_DOWNLOADS observed: {downloading} in flight (the cap broke): {states:?}"
        );
        if downloading == 2 {
            saw_two = true;
        }
        if states.iter().all(|s| *s != MethodEnvState::Downloading) {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the three concurrent ensures never finished: {states:?}"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        saw_two,
        "two downloads were observed in flight at once — the cap was actually contended \
         (the 64 MiB blobs are the meter; if this is flaky, the pulls were too fast)"
    );
    for t in threads {
        t.join()
            .expect("ensure thread")
            .expect("concurrent ensure finished");
    }
    for id in ["mst-biga-x7", "mst-bigb-x7", "mst-small2-x7"] {
        assert_eq!(
            manager.status(id).state,
            MethodEnvState::Ready,
            "{id} finished Ready"
        );
    }
}

// ─────────────────────────────── TEST-07 ─────────────────────────────────────

/// **TEST-07 [acceptance] [INV-1]** — the negative control of TEST-06: an
/// artifact whose bytes do NOT hash to the caller's pinned digest is refused
/// `ENV_VERIFY_FAILED`, records `failed`, and NEVER enters the digest cache.
#[test]
fn env_manager_refuses_tampered_pulled_bytes() {
    if !(have("docker") && have("oras")) {
        record_skip(
            "env_manager_refuses_tampered_pulled_bytes",
            "needs docker + oras (the loopback registry fixture); the unit tier pins the \
             refusal with a stub oras",
        );
        return;
    }
    let Some(()) = stack_gate("env_manager_refuses_tampered_pulled_bytes") else {
        return;
    };

    let work = scratch();
    let _guard = WorkGuard(work.clone());
    let container = format!("mst-env-reg-5067");
    sh(&format!(
        "docker rm -f {container} >/dev/null 2>&1; docker run -d --name {container} -p 5067:5000 registry:2 >/dev/null && sleep 2"
    ));
    let _reg_guard = RegistryGuard { work: work.clone(), container };
    let data = work.join("appdata");
    std::fs::create_dir_all(&data).expect("appdata");
    let reg = "localhost:5067";

    // A real squashfs published at the tag, but the pin the caller declares is
    // the digest of DIFFERENT bytes — the mismatch the verify half exists for.
    let dir = work.join("layer-root");
    build_layer_rootfs(&dir, fixture_run_sh(), &["/code"]);
    squash(&dir, &work.join("layer.squashfs"));
    let repo = format!("{reg}/tinnlab/txr-method-env-layers/mst-tamper-x7");
    sh(&format!(
        "cd {} && oras push --plain-http --artifact-type application/vnd.txr.method-env.squashfs.v1 \
         {repo}:v1 layer.squashfs:application/vnd.txr.method-env.squashfs.v1 >/dev/null",
        work.display()
    ));

    let wrong_pin = "3".repeat(64);
    let ref_ = EnvRef {
        oci_ref: format!("{repo}:v1"),
        digest: wrong_pin.clone(),
        tag: None,
    };
    let _data_guard = txresbench::modules::rootfs::scoped_data_root(&data);
    let manager = MethodEnvManager::with_seams(MethodEnvSeams {
        registry: Some(reg.to_string()),
        bypass_air_gap_env: true,
    });
    let err = manager
        .ensure(&ref_, EnvKind::Layer, std::time::Duration::from_secs(600))
        .expect_err("tampered bytes refused");
    assert_eq!(err.error_code(), ENV_VERIFY_FAILED_CODE, "{}", err);
    let status = manager.status("mst-tamper-x7");
    assert_eq!(status.state, MethodEnvState::Failed, "{status:?}");
    assert!(
        status.error.as_deref().is_some_and(|e| e.contains("ENV_VERIFY_FAILED")),
        "the status carries the typed reason: {:?}",
        status.error
    );
    assert!(
        !txresbench::modules::rootfs::cache::has_digest(&wrong_pin),
        "the refused bytes never reached the digest cache"
    );
}

// ─────────────────────────────── TEST-11 ─────────────────────────────────────

/// **TEST-11** — `cancel` stops an in-flight pull against the loopback
/// registry; the ledger leaves `downloading` with the typed cancellation
/// error; a subsequent `ensure` retries cleanly to `ready`.
#[test]
fn cancel_stops_an_inflight_pull_and_the_retry_lands_ready() {
    if !(have("docker") && have("oras")) {
        record_skip(
            "cancel_stops_an_inflight_pull_and_the_retry_lands_ready",
            "needs docker + oras (the loopback registry fixture + a slow pull); the unit \
             tier pins the cancel/retry state machine with a stub oras",
        );
        return;
    }
    let Some(()) = stack_gate("cancel_stops_an_inflight_pull_and_the_retry_lands_ready") else {
        return;
    };

    let work = scratch();
    let _guard = WorkGuard(work.clone());
    let container = format!("mst-env-reg-5068");
    sh(&format!(
        "docker rm -f {container} >/dev/null 2>&1; docker run -d --name {container} -p 5068:5000 registry:2 >/dev/null && sleep 2"
    ));
    let _reg_guard = RegistryGuard { work: work.clone(), container };
    let data = work.join("appdata");
    std::fs::create_dir_all(&data).expect("appdata");
    let reg = "localhost:5068";

    // The slow fixture: a big REAL squashfs (the pull phase is the meter; the
    // cancel happens while `oras pull` is still moving bytes).
    let big_dir = work.join("big-root");
    std::fs::create_dir_all(big_dir.join("data")).expect("big dir");
    sh(&format!(
        "head -c 134217728 /dev/urandom > {}/data/blob.bin",
        big_dir.join("data").display()
    ));
    squash(&big_dir, &work.join("big.squashfs"));
    let repo = format!("{reg}/tinnlab/txresbench-env/mst-slow-x7");
    sh(&format!(
        "cd {} && oras push --plain-http --artifact-type application/vnd.txr.method-env.squashfs.v1 \
         {repo}:v1 big.squashfs:application/vnd.txr.method-env.squashfs.v1 >/dev/null",
        work.display()
    ));
    let pin = sh_out(&format!("oras resolve --plain-http {repo}:v1"))
        .trim_start_matches("sha256:")
        .to_string();

    let _data_guard = txresbench::modules::rootfs::scoped_data_root(&data);
    let manager = Arc::new(MethodEnvManager::with_seams(MethodEnvSeams {
        registry: Some(reg.to_string()),
        bypass_air_gap_env: true,
    }));
    let ref_ = EnvRef {
        oci_ref: format!("{repo}:v1"),
        digest: pin.clone(),
        tag: None,
    };

    // The pull in a worker thread; cancel as soon as `downloading` is visible.
    let pull = {
        let m = manager.clone();
        let r = ref_.clone();
        let data2 = data.clone();
        std::thread::spawn(move || {
            let _g = txresbench::modules::rootfs::scoped_data_root(data2);
            m.ensure(&r, EnvKind::Base, std::time::Duration::from_secs(600))
        })
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while manager.status("mst-slow-x7").state != MethodEnvState::Downloading {
        assert!(
            std::time::Instant::now() < deadline,
            "the pull never entered downloading — the fixture was too fast to cancel"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    manager.cancel("mst-slow-x7");
    let status = manager.status("mst-slow-x7");
    assert_ne!(status.state, MethodEnvState::Downloading, "cancel leaves downloading");
    assert_eq!(status.state, MethodEnvState::Failed, "{status:?}");
    assert!(
        status.error.as_deref().is_some_and(|e| e.contains("ENV_DOWNLOAD_CANCELLED")),
        "the typed cancellation reason is recorded: {:?}",
        status.error
    );
    let result = pull.join().expect("cancel-join");
    // The cancelled attempt's terminal state was recorded by `cancel`; the
    // worker does NOT overwrite it (the cancel-wins rule).
    assert_ne!(manager.status("mst-slow-x7").state, MethodEnvState::Downloading);
    assert!(
        result.is_err(),
        "the cancelled attempt reports the cancel, not a success (run_tool sees the flag)"
    );

    // A subsequent ensure RETRIES cleanly (a Failed entry starts a fresh
    // attempt — TEST-11's wording) and lands ready; the bytes verify against
    // the pin even though the first attempt was killed mid-pull.
    let retry = manager
        .ensure(&ref_, EnvKind::Base, std::time::Duration::from_secs(600))
        .expect("a subsequent ensure retries cleanly");
    assert_eq!(retry.digest.as_deref(), Some(pin.as_str()));
    let status = manager.status("mst-slow-x7");
    assert_eq!(
        status.state,
        MethodEnvState::Ready,
        "{status:?} (the retry verified + mounted)"
    );
}

// ─────────────────────────────── TEST-08/09 ──────────────────────────────────

/// **TEST-08 [acceptance] [INV-2/INV-3] + TEST-09 [acceptance] [INV-6]** —
/// the real stacked run, in the child (see the file header). The FILE-level
/// harness: build fixtures, gate on the host stack capability, spawn the
/// child, own the ledger line.
#[test]
fn stacked_real_run_exits_zero_and_records_both_digests() {
    let Some(()) = stack_gate("stacked_real_run_exits_zero_and_records_both_digests") else {
        return;
    };
    let work = scratch();
    let _guard = WorkGuard(work.clone());
    let base_dir = build_stack_fixtures(&work);
    let Some(()) =
        stack_gate_pidns("stacked_real_run_exits_zero_and_records_both_digests", &base_dir)
    else {
        return;
    };
    let data = work.join("data");
    std::fs::create_dir_all(&data).expect("data dir");
    let (ok, stdout) = spawn_child(&work, &data, "fitpredict_reuse");
    assert!(ok, "the real-stack child must run clean");
    assert_child_ran_one(&stdout);
    if let Some(reason) = child_skipped(&stdout) {
        record_skip(
            "stacked_real_run_exits_zero_and_records_both_digests",
            &format!("child: {reason}"),
        );
    }
}

/// A real stacked run of a layer carrying a method's own packages in /opt/txr-layer (the case the
/// stacked tests never covered: every method that installs a package): the layer's folder is bound
/// onto the base's mount point, and the run sees the package settings (PYTHONUSERBASE, PYTHONPATH,
/// R_LIBS, PATH with /opt/txr-layer/bin first), the layer's files, and a program from its bin/.
#[test]
fn stacked_run_reads_the_method_packages_from_opt_txr_layer() {
    let name = "stacked_run_reads_the_method_packages_from_opt_txr_layer";
    let Some(()) = stack_gate(name) else {
        return;
    };
    let work = scratch();
    let _guard = WorkGuard(work.clone());
    let base_dir = build_stack_fixtures(&work);
    let Some(()) = stack_gate_pidns(name, &base_dir) else {
        return;
    };
    let data = work.join("data");
    std::fs::create_dir_all(&data).expect("data dir");
    let (ok, stdout) = spawn_child(&work, &data, "packages_layer");
    assert!(ok, "the packages-layer child must run clean");
    assert_child_ran_one(&stdout);
    if let Some(reason) = child_skipped(&stdout) {
        record_skip(name, &format!("child: {reason}"));
    }
}

// ─────────────────────────────── TEST-12 ─────────────────────────────────────

/// **TEST-12 [acceptance] [INV-1]** — the route matrix against the
/// spawned server: 401 unauthenticated; 403 restricted (no sandbox
/// permission) on all four; admin 200s + the `not_downloaded` answer for a
/// well-formed never-seen id; 404 `ENV_UNKNOWN` for a grammar-invalid id;
/// 204 `DELETE ?prune=true` (the 204 target is PRE-STAGED through the harness
/// — a real `ensure` needs network/oras); and the typed-503 degradation arm
/// with `/sandbox/status` serving 200 as the positive control (a gated
/// capability, never a broken route). The former 429 full-pool arm left with
/// its driver — see the STRIP note in the body.
#[tokio::test]
async fn route_matrix_gates_statuses_and_delete_prune() {
    use super::{restricted_user_token, setup_admin};
    use std::time::Duration;

    // The DELETE-204 leg needs an env the SERVER's manager knows at boot — the
    // persisted ledger + its cache entry are staged by the harness (the
    // manager loads the ledger at sandbox init; a post-spawn file is invisible
    // to it).
    let server = TestServer::spawn_with(TestOptions {
        prestage_method_envs: vec![("mst-pre-env-q7".to_string(), "base".to_string())],
        ..Default::default()
    })
    .await;
    let admin = setup_admin(&server).await;
    let restricted = restricted_user_token(&server, &admin).await;

    let envs_url = server.api_url("/sandbox/envs");
    let status_url = server.api_url("/sandbox/status");
    let never_seen = server.api_url("/sandbox/envs/mst-never-seen-abc");
    let bad_id = server.api_url("/sandbox/envs/Bad%2FId%3Atag");
    let delete_prune = server.api_url("/sandbox/envs/mst-pre-env-q7?prune=true");
    let method_run = server.api_url("/sandbox/method-run");
    let valid_run_body = json!({
        // A bare ref is refused by DEC-3 BEFORE the tool lookup (a runtime
        // pull is never left on a bare ref — ENV_REPOSITORY_UNKNOWN); the
        // degradation arm needs a TAGGED ref so the failure is the tool one.
        "base": { "oci_ref": format!("{TXR_BASE_REGISTRY_PREFIX}/mst-pre-env-q7:v1"), "digest": "3".repeat(64) },
        "layer": { "oci_ref": format!("{TXR_LAYER_REGISTRY_PREFIX}/mst-pre-env-q7:v1"), "digest": "4".repeat(64) },
        "mode": "fit_predict",
        "bundle_dir": "/nonexistent-bundle",
        "outputs_dir": "/nonexistent-outputs",
        "model_out_dir": "/nonexistent-model-out",
        "n_cpu": 1
    });

    // ── unauthenticated → 401 on all four ──────────────────────────────────
    for (what, req) in [
        ("GET /envs", server.client.get(envs_url.as_str()).build().unwrap()),
        ("GET /envs/{id}", server.client.get(never_seen.as_str()).build().unwrap()),
        ("DELETE /envs/{id}", server.client.delete(delete_prune.as_str()).build().unwrap()),
    ] {
        let resp = server.client.execute(req).await.expect(what);
        assert_eq!(resp.status().as_u16(), 401, "{what} unauthenticated");
    }
    let resp = server
        .client
        .post(method_run.as_str())
        .json(&valid_run_body)
        .send()
        .await
        .expect("method-run");
    assert_eq!(resp.status().as_u16(), 401, "POST /method-run unauthenticated");

    // ── restricted (no sandbox permission) → 403 on all four ───────────────
    for (what, req) in [
        ("GET /envs", server.client.get(envs_url.as_str()).bearer_auth(&restricted).build().unwrap()),
        ("GET /envs/{id}", server.client.get(envs_url.as_str()).bearer_auth(&restricted).build().unwrap()),
        (
            "DELETE /envs/{id}",
            server.client.delete(delete_prune.as_str()).bearer_auth(&restricted).build().unwrap(),
        ),
    ] {
        let resp = server.client.execute(req).await.expect(what);
        assert_eq!(resp.status().as_u16(), 403, "{what} restricted");
    }
    let resp = server
        .client
        .post(method_run.as_str())
        .bearer_auth(&restricted)
        .json(&valid_run_body)
        .send()
        .await
        .expect("method-run");
    assert_eq!(resp.status().as_u16(), 403, "POST /method-run restricted");

    // ── admin reads ────────────────────────────────────────────────────────
    let index: Value = server
        .client
        .get(envs_url.as_str())
        .bearer_auth(&admin)
        .send()
        .await
        .expect("GET /envs")
        .json()
        .await
        .expect("index json");
    assert!(index["stack"]["supported"].is_boolean(), "stack.supported is a bool");
    assert_eq!(
        index["stack"]["registry_base"],
        json!(TXR_BASE_REGISTRY_PREFIX),
        "the compiled base prefix is the reported registry base"
    );
    assert!(
        index["stack"]["tool_bins"].get("oras").is_some(),
        "tool_bins.oras present"
    );
    let base_list = index["base"].as_array().expect("base split");
    let prestaged_status = base_list
        .iter()
        .find(|s| s["env_id"] == json!("mst-pre-env-q7"))
        .unwrap_or_else(|| panic!("the prestaged env answers in the base index: {index}"));
    assert_eq!(prestaged_status["state"], json!("ready"));
    assert!(prestaged_status["digest"].is_string());
    assert_eq!(index["layers"].as_array().expect("layers split").len(), 0);

    // The well-formed never-seen id ANSWERS `not_downloaded` + `Unknown` (the
    // manager is catalogue-free; the client holds the id's kind) — never a 404.
    let unseen: Value = server
        .client
        .get(never_seen.as_str())
        .bearer_auth(&admin)
        .send()
        .await
        .expect("never-seen status")
        .json()
        .await
        .expect("json");
    assert_eq!(unseen["state"], json!("not_downloaded"));
    assert_eq!(unseen["kind"], json!("unknown"));

    // Only a grammar-invalid id is 404 ENV_UNKNOWN (DRIFT-1 #34).
    let resp = server.client.get(bad_id.as_str()).bearer_auth(&admin).send().await.expect("bad id");
    assert_eq!(resp.status().as_u16(), 404, "grammar-invalid id → 404");
    let body: Value = resp.json().await.expect("404 json");
    assert_eq!(body["error_code"], json!("ENV_UNKNOWN"));

    // ── 204 DELETE ?prune=true: record AND cache entry gone ────────────────
    let digest = prestaged_status["digest"].as_str().expect("digest").to_string();
    let cache_entry = server
        .data_dir()
        .join("sandbox-rootfs")
        .join(&digest)
        .join("rootfs.squashfs");
    let ledger = server.data_dir().join("txr-envs").join("mst-pre-env-q7.json");
    assert!(cache_entry.is_file(), "prestaged cache entry exists");
    assert!(ledger.is_file(), "prestaged ledger exists");
    let resp = server
        .client
        .delete(delete_prune.as_str())
        .bearer_auth(&admin)
        .send()
        .await
        .expect("delete");
    assert_eq!(resp.status().as_u16(), 204, "delete of a known env");
    assert!(!cache_entry.exists(), "prune removed the cached artifact");
    assert!(!ledger.exists(), "forget removed the persisted record");
    // The follow-up status answers like a never-seen id.
    let after: Value = server
        .client
        .get(server.api_url("/sandbox/envs/mst-pre-env-q7"))
        .bearer_auth(&admin)
        .send()
        .await
        .expect("after")
        .json()
        .await
        .expect("json");
    assert_eq!(after["state"], json!("not_downloaded"), "forgotten answers fresh: {after}");
    // A second DELETE has nothing left: 404.
    let resp = server
        .client
        .delete(delete_prune.as_str())
        .bearer_auth(&admin)
        .send()
        .await
        .expect("delete again");
    assert_eq!(resp.status().as_u16(), 404, "already forgotten");

    // STRIP: the 429 SANDBOX_POOL_FULL arm used to live here,
    // driven through the jobs admin REST surface (PUT /job-settings cap 1, a
    // stub job holder under POST /jobs, GET + /stop on the held job). That
    // surface left in ITEM-3 with the jobs drawer UI (jobs/mod.rs now
    // registers no routes — see its register_routes comment), so the arm's
    // driver does not exist on ANY host and the arm could not run: a
    // `PUT /job-settings` 404 stopped the matrix cold. The arm left with its
    // driver (the gate-wiring precedent, DRIFT-1 ITEM-5 #6); the typed-429
    // contract it asserted is still pinned where the code is — the unit tier
    // (`jobs::admission`'s `pool_full_is_a_typed_429`) and the method-run
    // route's own doc (`sandbox/routes.rs`), which states the slot is claimed
    // before the seam and closed on both paths. Restore an HTTP driver for
    // the arm here if a kept knob for the admission settings ever returns.

    // ── the typed-503 degradation arm ──────────────────────────────────────
    // With a free slot and a caller-data-valid request, the seam refuses with
    // a typed 503 when the run cannot proceed: SANDBOX_UNAVAILABLE when the
    // sandbox itself is not Ready (a no-bwrap host), ENV_IMAGE_TOOL_MISSING
    // when oras is absent (the host here) — both the DEC-16 degrade family.
    // The `/sandbox/status` positive control proves the refusal is a gated
    // capability, not a broken route. When the server reports oras present,
    // this arm is skipped (a real pull would leave the machine — INV-1),
    // exactly like the executor tiers skip on a missing capability.
    if !index["stack"]["tool_bins"]["oras"].is_string() {
        // The stopped holder releases its slot asynchronously; the seam arm
        // needs a FREE slot (a busy pool answers 429 — the previous arm's
        // assertion, not this one). Poll briefly; the run itself fails fast.
        let mut resp = None;
        let spin = tokio::time::Instant::now() + Duration::from_secs(30);
        while tokio::time::Instant::now() < spin {
            let r = server
                .client
                .post(method_run.as_str())
                .bearer_auth(&admin)
                .json(&valid_run_body)
                .send()
                .await
                .expect("method-run 503");
            if r.status().as_u16() != 429 {
                resp = Some(r);
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        let resp = resp.expect("the held slot was released within 30 s");
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        assert_eq!(
            status,
            503,
            "a must-run seam refuses when the host cannot (got {status}: {text})"
        );
        let body: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
        assert!(
            matches!(
                body["error_code"].as_str(),
                Some("SANDBOX_UNAVAILABLE") | Some("ENV_IMAGE_TOOL_MISSING")
            ),
            "typed 503: {body}"
        );
        let status: Value = server
            .client
            .get(status_url.as_str())
            .bearer_auth(&admin)
            .send()
            .await
            .expect("/sandbox/status positive control")
            .json()
            .await
            .expect("status json");
        assert_eq!(
            status["availability"],
            json!("ready"),
            "the server itself is healthy — the refusal is a gated capability"
        );
    } else {
        record_skip(
            "route_matrix_gates_statuses_and_delete_prune",
            "this host has oras; the typed-503 degradation arm needs a host without it (a \
             real pull would attempt ghcr.io — beyond this node's test boundary). The rest \
             of the matrix ran + passed.",
        );
    }
}

// ─────────────────────────────── TEST-13 ─────────────────────────────────────

/// **TEST-13** — `scripts/txr-sandbox-preflight.sh` exists, parses under
/// `bash -n`, names each host requirement + its exact remediation line, and
/// exits non-zero when the required tools are missing from a stubbed PATH
/// (the same self-check style as `env_publish_runbook_test.rs`).
#[test]
fn preflight_script_parses_names_each_requirement_and_fails_on_missing_tools() {
    let script = repo_root().join("scripts/txr-sandbox-preflight.sh");
    assert!(script.is_file(), "txr-sandbox-preflight.sh exists at {script:?}");
    assert!(
        !script
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .starts_with("check-"),
        "the preflight is NOT a guard shape (DEC-18: check-guard-integrity untouched)"
    );

    // Bash-parseable (a syntax error would make the checklist a silent no-op).
    let parse = Command::new("bash").arg("-n").arg(&script).output().expect("bash -n");
    assert!(parse.status.success(), "bash -n: {}", String::from_utf8_lossy(&parse.stderr));

    let text = std::fs::read_to_string(&script).expect("read preflight");
    // Every requirement the host must satisfy, by its exact tool/flag name.
    for needle in [
        "bwrap",
        "squashfuse",
        "fusermount3",
        "oras",
        "user_allow_other",
        "mount-proc",
    ] {
        assert!(text.contains(needle), "the preflight names {needle}");
    }
    // Every requirement carries its EXACT one-line remediation (the
    // installer/operator does not have to guess).
    for (tool, fix) in [
        ("bwrap", "install bubblewrap"),
        ("squashfuse", "install squashfuse"),
        ("fusermount3", "install fuse3"),
        ("oras", "install oras"),
        ("user_allow_other", "tee -a /etc/fuse.conf"),
        ("mount-proc", "--security-opt"),
    ] {
        assert!(
            text.contains(fix),
            "the preflight names the remediation for {tool}: {fix}"
        );
    }

    // A PATH stub removes every tool: the script must exit NON-zero and name
    // the missing ones (exit-0 on a bare box would make the checklist lie).
    let work = scratch();
    let guard = WorkGuard(work.clone());
    let stub = work.join("empty-path");
    std::fs::create_dir_all(&stub).expect("stub dir");
    std::fs::create_dir_all(work.join("appdata")).expect("appdata");
    let bash = sh_out("command -v bash"); // absolute — the stub PATH hides it
    let run = Command::new(&bash)
        .arg(&script)
        .env("PATH", &stub)
        .env("TXR_APP_DATA_DIR", work.join("appdata"))
        .output()
        .expect("run preflight under PATH stub");
    assert!(
        !run.status.success(),
        "the preflight exits non-zero when the required tools are missing"
    );
    let out = String::from_utf8_lossy(&run.stdout);
    assert!(out.contains("[MISS]"), "the missing tools are named: {out}");
    assert!(out.contains("preflight: FAILED"), "the summary line says FAILED: {out}");
    drop(guard);
}
