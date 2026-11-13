//! End-to-end smoke tests for the libkrun microVM stack on macOS.
//!
//! Drive the launcher binary directly (bypassing the server) and run one Exec
//! round-trip through the agent. Validates:
//!   (1) VM boots, (2) vsock direction (host dials), (3) /dev/vda mounts
//!   the squashfs, (4) virtio-fs tag "workspace" mounts, (5) exit code +
//!   stdout round-trip via Frame::Exec → Stdout → Exit → ArtifactsDone.
//! The layer test adds (6): an optional second disk (`layer_disk_path`)
//! appears as /dev/vdb and the agent mounts it read-only at /sandbox-layer;
//! the no-network test adds (7): the guest cannot open a connection (the
//! launcher always turns libkrun's TSI off).
//!
//! Run on Apple Silicon after `brew install slp/krun/libkrun`, building the
//! launcher (codesigned with com.apple.security.hypervisor) and building the
//! guest root with `scripts/build-macos-vm-guest-root.sh` (static aarch64-musl
//! agent + Alpine userland with /sandbox-layer pre-created):
//!
//!   cargo test --release --test boot_smoke -- --ignored --nocapture
//!
//! Paths are overridable via env vars; defaults match the dev cache layout
//! under `.txresbench-cache/` at the repo root. The layer test also reads
//! `TXR_SANDBOX_LAYER_DISK` (a squashfs whose root holds a `marker` file) and
//! `TXR_SANDBOX_LAYER_MARKER` (that file's expected content).

#![cfg(target_os = "macos")]

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use sandbox_vm_protocol::{encode, Decoder, ExecRequest, ExitStatus, Frame, PROTOCOL_VERSION};

const SOCK_TIMEOUT: Duration = Duration::from_secs(30);
const READ_TIMEOUT: Duration = Duration::from_secs(15);
const EXEC_TIMEOUT_MS: u64 = 10_000;

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn repo_cache(rel: &str) -> String {
    // Canonicalize: macOS unix-socket sun_path is 104 bytes max, and
    // launcher_dir + "/../../.txresbench-cache/..." easily overshoots that.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let raw = std::path::PathBuf::from(format!("{manifest_dir}/../../.txresbench-cache"));
    let canon = std::fs::canonicalize(&raw).unwrap_or(raw);
    canon.join(rel).to_string_lossy().into_owned()
}

#[test]
#[ignore = "needs libkrun + codesigned launcher + assembled guest root + dummy squashfs"]
fn boot_smoke_echo_round_trip() {
    let (exit, stdout, stderr) = boot_and_exec("echo", None, vec!["echo".into(), "hello from guest".into()]);
    assert_eq!(exit.code, 0, "expected exit 0, got {exit:?} (stderr={stderr:?})");
    assert!(!exit.timed_out, "command timed out unexpectedly");
    assert!(
        stdout.contains("hello from guest"),
        "expected 'hello from guest' in stdout, got {stdout:?}"
    );
}

#[test]
#[ignore = "needs libkrun + codesigned launcher + assembled guest root + dummy squashfs + layer squashfs"]
fn boot_smoke_layer_disk_mounts_at_sandbox_layer() {
    let layer_disk = env_or("TXR_SANDBOX_LAYER_DISK", &repo_cache("test-validation/dummy-layer.sqfs"));
    let marker = env_or("TXR_SANDBOX_LAYER_MARKER", "layer-ok");
    let (exit, stdout, stderr) = boot_and_exec(
        "layer",
        Some(layer_disk),
        vec!["cat".into(), "/sandbox-layer/marker".into()],
    );
    assert_eq!(exit.code, 0, "expected exit 0, got {exit:?} (stderr={stderr:?})");
    assert_eq!(stdout.trim(), marker, "the layer disk's marker file, read inside the guest");
}

#[test]
#[ignore = "needs libkrun + codesigned launcher + assembled guest root + dummy squashfs; meaningful only with host network"]
fn boot_smoke_guest_has_no_network() {
    // With libkrun's default TSI this would connect (it proxies guest sockets
    // through the host); the launcher turns TSI off, so the guest has no
    // network at all.
    let (exit, stdout, stderr) = boot_and_exec(
        "nonet",
        None,
        vec![
            "sh".into(),
            "-c".into(),
            "nc -w 3 1.1.1.1 80 </dev/null && echo CONNECTED || echo NO-CONNECTION".into(),
        ],
    );
    assert_eq!(exit.code, 0, "expected exit 0, got {exit:?} (stderr={stderr:?})");
    assert_eq!(stdout.trim(), "NO-CONNECTION", "the guest reached the network");
}

/// Boot one VM (optionally with a layer disk), run `argv` through the guest's
/// busybox (no bwrap), and return the exit status + captured stdout/stderr.
/// `tag` keeps the socket and config files of concurrently running tests apart.
fn boot_and_exec(
    tag: &str,
    layer_disk: Option<String>,
    argv: Vec<String>,
) -> (ExitStatus, String, String) {
    let launcher = env_or(
        "TXR_LAUNCHER_BIN",
        &format!("{}/target/release/txresbench-sandbox-vm-launcher", env!("CARGO_MANIFEST_DIR")),
    );
    let guest_root = env_or("TXR_SANDBOX_GUEST_ROOT", &repo_cache("guest-root"));
    let sandbox_disk = env_or("TXR_SANDBOX_DISK", &repo_cache("test-validation/dummy-sandbox.sqfs"));
    let workspace_root = env_or("TXR_WORKSPACE", &repo_cache("test-validation/workspace"));
    let cache_dir = env_or("TXR_TEST_CACHE", &repo_cache("test-validation"));

    std::fs::create_dir_all(&workspace_root).expect("workspace mkdir");
    std::fs::create_dir_all(&cache_dir).expect("cache mkdir");

    // The launcher needs com.apple.security.hypervisor (and library-validation
    // disabled to load /opt/homebrew/lib/libkrun.dylib from a non-system path);
    // without it krun_start_enter returns -22 (EINVAL). `cargo build` clears
    // any prior ad-hoc signature, so re-apply on every test run. Idempotent.
    let entitlements = format!("{}/entitlements.plist", env!("CARGO_MANIFEST_DIR"));
    let sign = std::process::Command::new("codesign")
        .args(["--entitlements", &entitlements, "--force", "-s", "-", &launcher])
        .output()
        .expect("codesign exec");
    assert!(
        sign.status.success(),
        "codesign failed: {}",
        String::from_utf8_lossy(&sign.stderr)
    );

    let sock_path = format!("{cache_dir}/vm-{tag}.sock");
    let _ = std::fs::remove_file(&sock_path); // stale → krun_add_vsock_port2 EEXIST

    let cfg_path = format!("{cache_dir}/launch-{tag}.json");
    let cfg = serde_json::json!({
        "num_vcpus": 1,
        "ram_mib": 256,
        "root_path": guest_root,
        "sandbox_disk_path": sandbox_disk,
        "layer_disk_path": layer_disk,
        "workspace_host_path": workspace_root,
        "vsock_socket_path": sock_path,
        "vsock_port": 1024,
        "agent_exec_path": "/usr/bin/txresbench-sandbox-agent",
    });
    std::fs::write(&cfg_path, serde_json::to_vec_pretty(&cfg).unwrap())
        .expect("write launch.json");

    // Spawn the launcher. Pipe stderr so we can scan for the agent's
    // "listening on vsock port" readiness line — vm.sock appearing on the
    // host side is libkrun's bridge being ready, NOT the guest vsock
    // listener; connecting in that window produces an immediate EOF
    // because there's no destination yet. We mirror stderr to our own
    // stderr from a reader thread so `--nocapture` still shows agent logs.
    let mut child = std::process::Command::new(&launcher)
        .arg(&cfg_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("spawn launcher");
    let child_stderr = child.stderr.take().expect("piped stderr");
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let mut signaled = false;
        let reader = BufReader::new(child_stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("{line}");
            if !signaled && line.contains("listening on vsock port") {
                let _ = ready_tx.send(());
                signaled = true;
            }
        }
    });
    let _guard = ChildGuard(child);

    // Wait for libkrun to create the host socket AND the agent to start
    // listening on the guest vsock port. The order matters: connecting
    // before the agent listens gets an immediate EOF from the bridge.
    let deadline = Instant::now() + SOCK_TIMEOUT;
    loop {
        if std::path::Path::new(&sock_path).exists() {
            break;
        }
        assert!(Instant::now() < deadline, "vsock socket {sock_path} did not appear within {SOCK_TIMEOUT:?}");
        std::thread::sleep(Duration::from_millis(100));
    }
    ready_rx
        .recv_timeout(SOCK_TIMEOUT)
        .expect("agent did not log 'listening on vsock port' within timeout");

    // Connect via blocking unix socket — matches the Python reference probe
    // exactly (the earlier tokio version's read blocked indefinitely; not
    // root-caused, but the synchronous path is what the test needs anyway).
    let mut stream = UnixStream::connect(&sock_path).expect("connect vsock bridge");
    stream.set_read_timeout(Some(READ_TIMEOUT)).expect("set read timeout");

    let req = Frame::Exec(ExecRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: 1,
        bwrap_path: "/bin/busybox".to_string(),
        argv,
        timeout_ms: EXEC_TIMEOUT_MS,
        seccomp_fd: None,
        cgroup: None,
        progress: false,
        collect_artifacts: Vec::new(),
        artifacts: Default::default(),
    });
    stream.write_all(&encode(&req)).expect("write Exec");

    let mut decoder = Decoder::new();
    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();
    let mut exit: Option<ExitStatus> = None;
    let mut done = false;
    let mut buf = [0u8; 64 * 1024];
    // Exit comes as soon as the command ends; the (empty) copy-back follows
    // and ends with ArtifactsDone.
    while !done {
        let n = match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => panic!(
                "read failed: {e}. stdout={:?} stderr={:?}",
                String::from_utf8_lossy(&stdout_buf),
                String::from_utf8_lossy(&stderr_buf),
            ),
        };
        decoder.feed(&buf[..n]);
        while let Some(frame) = decoder.next_frame().expect("decode") {
            match frame {
                Frame::Stdout(b) => stdout_buf.extend_from_slice(&b),
                Frame::Stderr(b) => stderr_buf.extend_from_slice(&b),
                Frame::Exit(s) => exit = Some(s),
                Frame::ArtifactsDone => done = true,
                other => panic!("unexpected frame: {other:?}"),
            }
        }
    }

    let exit = exit.expect("Exit frame");
    assert!(done, "the exchange ended without ArtifactsDone");
    let stdout = String::from_utf8_lossy(&stdout_buf).into_owned();
    let stderr = String::from_utf8_lossy(&stderr_buf).into_owned();
    eprintln!("--- [{tag}] exit: {exit:?}");
    eprintln!("--- [{tag}] stdout: {stdout:?}");
    eprintln!("--- [{tag}] stderr: {stderr:?}");
    (exit, stdout, stderr)
}

/// Kill the child on Drop so a panic mid-test doesn't orphan the VM.
struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
