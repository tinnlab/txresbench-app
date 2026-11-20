//! WSL mode end to end: the agent binary started the way the Windows app
//! starts it in its WSL distro (`--stdio --base <image> --layer <image> --ro
//! <dir>`), driven over its stdin/stdout with the protocol crate, running a
//! real bwrap command over real squashfs images.
//!
//! The `#[ignore]`d tests need root in a privileged Linux container (mount
//! namespaces, loop devices, FUSE) with bwrap, mksquashfs, squashfuse,
//! util-linux `unshare` and a static busybox, and must run one at a time:
//!
//!     sh sdk/scripts/test-guest-agent-linux.sh [arm64|amd64]
//!
//! The other tests run on any Linux host.
#![cfg(target_os = "linux")]

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use sandbox_vm_protocol::{
    encode, ArtifactOptions, CgroupLimits, Decoder, ExecRequest, ExitStatus, Frame, PROGRESS_GUEST_FIFO_PATH,
    PROTOCOL_VERSION,
};

const AGENT: &str = env!("CARGO_BIN_EXE_txresbench-sandbox-agent");
const SQUASHFUSE: &str = "/usr/bin/squashfuse";
const ARTIFACTS_ROOT: &str = "/tmp/txresbench-artifacts-out";
const WAIT: Duration = Duration::from_secs(30);
/// Set by `sdk/scripts/test-guest-agent-linux.sh` in its throwaway container.
const E2E_CONTAINER_ENV: &str = "TXR_GUEST_AGENT_E2E_CONTAINER";
/// Set by the method in [`SCRIPT`] to make [`vsock_probe`] probe.
const VSOCK_PROBE_ENV: &str = "TXR_VSOCK_PROBE";

// ---- the vsock probe ----------------------------------------------------

/// The calls a method could make for a vsock socket, each with what it
/// answered: `created`, or the errno's name.
///
/// - `vsock-socket`: `socket(AF_VSOCK, SOCK_STREAM, 0)`, as a method would.
/// - `vsock-bad-flag`: the same with a type flag no kernel knows. A kernel
///   answers EINVAL before it looks at the family; the seccomp filter answers
///   before the kernel. So EAFNOSUPPORT here comes from the filter, also on a
///   kernel without vsock.
/// - `vsock-bit-32`: `AF_VSOCK` with bit 32 of the register set, which the
///   kernel drops (`int domain`): the filter must compare the low 32 bits only.
/// - `vsock-bit-32-bad-flag`: both at once. A kernel without vsock answers
///   `vsock-bit-32` with EAFNOSUPPORT by itself; this one it answers EINVAL,
///   so only a filter that compares the low 32 bits gives EAFNOSUPPORT.
fn vsock_answers() -> Vec<(&'static str, String)> {
    let vsock = libc::AF_VSOCK as libc::c_long;
    let stream = libc::SOCK_STREAM as libc::c_long;
    let calls: [(&'static str, libc::c_long, libc::c_long); 4] = [
        ("vsock-socket", vsock, stream),
        ("vsock-bad-flag", vsock, stream | 0x4000_0000),
        ("vsock-bit-32", (1 << 32) | vsock, stream),
        ("vsock-bit-32-bad-flag", (1 << 32) | vsock, stream | 0x4000_0000),
    ];
    calls
        .into_iter()
        .map(|(name, domain, ty)| {
            // SAFETY: a raw socket(2); a socket it makes is closed at once.
            let fd = unsafe { libc::syscall(libc::SYS_socket, domain, ty, 0 as libc::c_long) };
            let answer = if fd >= 0 {
                unsafe { libc::close(fd as libc::c_int) };
                "created".to_string()
            } else {
                match std::io::Error::last_os_error().raw_os_error() {
                    Some(libc::EAFNOSUPPORT) => "EAFNOSUPPORT".to_string(),
                    Some(libc::EINVAL) => "EINVAL".to_string(),
                    Some(libc::EPERM) => "EPERM".to_string(),
                    other => format!("errno {other:?}"),
                }
            };
            (name, answer)
        })
        .collect()
}

/// Not a test of its own: the program the method in [`SCRIPT`] runs inside
/// the sandbox (this test binary, bound at `/opt/vsock-probe`). With
/// `TXR_VSOCK_PROBE=1` it prints a `<call>=<answer>` line per
/// [`vsock_answers`]; without, it does nothing.
#[test]
fn vsock_probe() {
    if std::env::var_os(VSOCK_PROBE_ENV).is_none() {
        return;
    }
    // libtest has printed `test vsock_probe ... ` with no newline.
    println!();
    for (call, answer) in vsock_answers() {
        println!("{call}={answer}");
    }
}

// ---- without root -------------------------------------------------------

#[test]
fn bad_arguments_exit_2_with_usage_on_stderr_and_nothing_on_stdout() {
    for args in [
        &["--stdio"][..],
        &["--stdio", "--base", "relative.sqfs"],
        &["--stdio", "--base", "/b", "--base", "/c"],
        &["--base", "/b"],
        &["--pipe-selftest", "--stdio"],
        &["--bogus"],
    ] {
        let out = Command::new(AGENT)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("run the agent");
        assert_eq!(out.status.code(), Some(2), "{args:?}: {out:?}");
        assert!(out.stdout.is_empty(), "{args:?}: stdout {:?}", out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stderr.contains("usage: txresbench-sandbox-agent --stdio"),
            "{args:?}: {stderr}"
        );
    }
}

#[test]
fn pipe_selftest_echoes_every_byte_and_exits_0() {
    // Every byte value, frames' worth of data, and no trailing newline.
    let data: Vec<u8> = (0..(3 * 1024 * 1024 + 17))
        .map(|i: u32| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
        .collect();
    let mut child = Command::new(AGENT)
        .arg("--pipe-selftest")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the agent");
    let mut stdin = child.stdin.take().unwrap();
    let input = data.clone();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let echoed = all_chunks(&chunks_in_background(child.stdout.take().unwrap()));
    let status = wait_exit(&mut child);
    writer.join().unwrap().expect("the agent read all of its input");
    assert_eq!(status.code(), Some(0));
    assert!(
        echoed == data,
        "echo differs: {} bytes back for {}",
        echoed.len(),
        data.len()
    );
}

#[test]
fn pipe_selftest_works_over_non_blocking_pipes() {
    // wsl.exe may hand the agent non-blocking pipes; the self-test must still
    // copy everything, not fail on the first empty read.
    let (agent_in, host_out) = non_blocking_pipe();
    let (host_in, agent_out) = non_blocking_pipe();
    make_blocking(&host_out);
    make_blocking(&host_in);
    let mut child = Command::new(AGENT)
        .arg("--pipe-selftest")
        .stdin(Stdio::from(agent_in))
        .stdout(Stdio::from(agent_out))
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the agent");
    let stderr = read_to_end_in_background(child.stderr.take().unwrap());
    let echoed = chunks_in_background(std::fs::File::from(host_in));
    // Nothing to read at first: a non-blocking read would fail right away.
    std::thread::sleep(Duration::from_millis(300));
    let mut to_agent = std::fs::File::from(host_out);
    to_agent.write_all(b"over non-blocking pipes").unwrap();
    drop(to_agent);
    let echoed = all_chunks(&echoed);
    let status = wait_exit(&mut child);
    let stderr = stderr_after_exit(&stderr);
    assert_eq!(status.code(), Some(0), "{stderr}");
    assert_eq!(echoed, b"over non-blocking pipes");
}

#[test]
fn a_closed_stderr_does_not_change_the_exit_code() {
    // The app's wsl.exe gone: printing the reason fails, the exit code stays
    // the contract's (2 bad arguments, 3 setup) instead of a panic's 101.
    for (args, want) in [
        (&["--bogus"][..], 2),
        (&["--stdio", "--base", "/nonexistent/base.sqfs"], 3),
    ] {
        let (read_end, write_end) = non_blocking_pipe();
        drop(read_end);
        let mut child = Command::new(AGENT)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::from(write_end))
            .spawn()
            .expect("start the agent");
        assert_eq!(wait_exit(&mut child).code(), Some(want), "{args:?}");
    }
}

#[test]
fn a_base_image_that_cannot_be_used_exits_3_with_the_reason_on_stderr() {
    // Fully privileged, this fails opening the image; otherwise (no root, or
    // root without CAP_SYS_ADMIN as in the script's build container),
    // entering the namespace. Either way: exit 3, the reason on stderr,
    // stdout untouched.
    let out = Command::new(AGENT)
        .args(["--stdio", "--base", "/nonexistent/base.sqfs"])
        .stdin(Stdio::null())
        .output()
        .expect("run the agent");
    assert_eq!(out.status.code(), Some(3), "{out:?}");
    assert!(out.stdout.is_empty(), "stdout {:?}", out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("setup failed"), "{stderr}");
}

// ---- as root, in a privileged container ----------------------------------

/// A busybox base image, a layer image, an input dir and an input file, under the system
/// temp dir (`/tmp`), which the agent covers with its own tmpfs: the agent
/// must still read them through the paths it was given.
struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    base: PathBuf,
    layer: PathBuf,
    input: PathBuf,
    identity: PathBuf,
    /// A copy of this test binary, the method's vsock probe.
    probe: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        assert_eq!(
            unsafe { libc::geteuid() },
            0,
            "the e2e tests need root (see the module doc)"
        );
        // They make `/` shared and add directories at `/`: only in the
        // throwaway container the script starts, never on a real system.
        assert!(
            std::env::var_os(E2E_CONTAINER_ENV).is_some_and(|v| v == "1"),
            "the e2e tests change this system's root mount; run them with sdk/scripts/test-guest-agent-linux.sh (it sets {E2E_CONTAINER_ENV}=1)"
        );
        // The distro's mounts may propagate (shared): make this namespace's
        // shared too, so a mount that escaped the agent's namespace shows here.
        let rc = unsafe {
            libc::mount(
                std::ptr::null(),
                c"/".as_ptr(),
                std::ptr::null(),
                libc::MS_REC | libc::MS_SHARED,
                std::ptr::null(),
            )
        };
        assert_eq!(rc, 0, "make / shared: {}", std::io::Error::last_os_error());
        // The guest root's empty mount points (the app's distro has them).
        for d in ["/sandbox-rootfs", "/sandbox-layer", "/host-mounts", "/workspace"] {
            std::fs::create_dir_all(d).unwrap();
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        let rootfs = root.join("rootfs");
        std::fs::create_dir_all(rootfs.join("bin")).unwrap();
        let busybox = ["/bin/busybox.static", "/bin/busybox"]
            .into_iter()
            .find(|p| Path::new(p).is_file())
            .expect("a static busybox");
        std::fs::copy(busybox, rootfs.join("bin/busybox")).unwrap();
        for applet in [
            "sh", "cat", "echo", "id", "grep", "sleep", "mkdir", "printf", "test", "[",
        ] {
            std::os::unix::fs::symlink("busybox", rootfs.join("bin").join(applet)).unwrap();
        }
        let layer_dir = root.join("layer");
        std::fs::create_dir_all(&layer_dir).unwrap();
        std::fs::write(layer_dir.join("marker"), b"layer-marker\n").unwrap();
        let base = root.join("base.sqfs");
        let layer = root.join("layer.sqfs");
        mksquashfs(&rootfs, &base);
        mksquashfs(&layer_dir, &layer);
        let input = root.join("input");
        std::fs::create_dir_all(&input).unwrap();
        std::fs::write(input.join("in.txt"), b"hello from input\n").unwrap();
        let identity = root.join("identity.txt");
        std::fs::write(&identity, b"identity-file\n").unwrap();
        let probe = root.join("vsock-probe");
        std::fs::copy(std::env::current_exe().expect("this test binary"), &probe).unwrap();
        Fixture {
            _dir: dir,
            root,
            base,
            layer,
            input,
            identity,
            probe,
        }
    }

    fn args(&self) -> Vec<String> {
        vec![
            "--stdio".into(),
            "--base".into(),
            self.base.display().to_string(),
            "--layer".into(),
            self.layer.display().to_string(),
            "--ro".into(),
            self.input.display().to_string(),
            "--ro".into(),
            self.identity.display().to_string(),
            "--ro".into(),
            self.probe.display().to_string(),
        ]
    }
}

fn mksquashfs(src: &Path, out: &Path) {
    // mksquashfs sizes its thread pool from the machine's CPU count, not the
    // CPUs this process may use: pass -processors explicitly (follows cpu
    // affinity on Linux, like the generator's helper).
    let processors =
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).to_string();
    let st = Command::new("mksquashfs")
        .arg(src)
        .arg(out)
        .args(["-noappend", "-quiet", "-all-root"])
        .arg("-processors")
        .arg(&processors)
        .stdout(Stdio::null())
        .status()
        .expect("mksquashfs");
    assert!(st.success(), "mksquashfs {}", src.display());
}

/// How the agent is started: directly, or inside `unshare -m` after a setup
/// script (to break the kernel squashfs path or hide squashfuse for this
/// agent only).
enum Start<'a> {
    Direct,
    After(&'a str),
}

/// The kernel squashfs path fails: `/dev/loop-control` is `/dev/null`.
const BREAK_LOOP: &str = "mount --bind /dev/null /dev/loop-control";
/// Neither path works: also no squashfuse.
const BREAK_LOOP_AND_FUSE: &str =
    "mount --bind /dev/null /dev/loop-control && mount --bind /dev/null /usr/bin/squashfuse";

/// The agent, as the app talks to it: frames in on stdin, frames out on stdout.
struct Agent {
    child: Child,
    stdin: Option<ChildStdin>,
    out: mpsc::Receiver<Vec<u8>>,
    stdout_bytes: Vec<u8>,
    decoder: Decoder,
    stderr: mpsc::Receiver<String>,
}

impl Agent {
    fn start(args: &[String], start: Start) -> Self {
        let mut cmd = match start {
            Start::Direct => {
                let mut c = Command::new(AGENT);
                c.args(args);
                c
            }
            Start::After(setup) => {
                let mut c = Command::new("unshare");
                c.args(["-m", "--propagation", "private", "sh", "-c"])
                    .arg(format!("{setup} && exec \"$0\" \"$@\""))
                    .arg(AGENT)
                    .args(args);
                c
            }
        };
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start the agent");
        let out = chunks_in_background(child.stdout.take().unwrap());
        let stderr = read_to_end_in_background(child.stderr.take().unwrap());
        let stdin = child.stdin.take();
        Agent {
            child,
            stdin,
            out,
            stdout_bytes: Vec::new(),
            decoder: Decoder::new(),
            stderr,
        }
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn send(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    /// The next frame, or `None` when stdout closed.
    fn next_frame(&mut self) -> Option<Frame> {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(f) = self.decoder.next_frame().expect("stdout carries only valid frames") {
                return Some(f);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match self.out.recv_timeout(left) {
                Ok(chunk) => {
                    self.stdout_bytes.extend_from_slice(&chunk);
                    self.decoder.feed(&chunk);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return None,
                Err(mpsc::RecvTimeoutError::Timeout) => panic!("no frame from the agent within {WAIT:?}"),
            }
        }
    }

    /// Frames until (and with) the first one `stop` accepts.
    fn frames_until(&mut self, stop: impl Fn(&Frame) -> bool) -> Vec<Frame> {
        let mut frames = Vec::new();
        while let Some(f) = self.next_frame() {
            let done = stop(&f);
            frames.push(f);
            if done {
                return frames;
            }
        }
        panic!("the agent closed stdout before the expected frame; got {frames:?}");
    }

    /// Wait for the exit; returns the code, the rest of stdout and stderr.
    fn finish(mut self) -> (Option<i32>, Vec<u8>, String) {
        self.stdin = None;
        let deadline = Instant::now() + WAIT;
        let status = loop {
            if let Some(st) = self.child.try_wait().unwrap() {
                break st;
            }
            assert!(Instant::now() < deadline, "the agent did not exit within {WAIT:?}");
            std::thread::sleep(Duration::from_millis(20));
        };
        let mut rest = Vec::new();
        while let Ok(chunk) = self.out.recv_timeout(Duration::from_secs(5)) {
            rest.extend_from_slice(&chunk);
        }
        self.stdout_bytes.extend_from_slice(&rest);
        self.decoder.feed(&rest);
        let stderr = stderr_after_exit(&self.stderr);
        (status.code(), rest, stderr)
    }
}

/// A pipe (read end, write end), non-blocking on both ends.
fn non_blocking_pipe() -> (std::os::fd::OwnedFd, std::os::fd::OwnedFd) {
    use std::os::fd::{FromRawFd, OwnedFd};
    let mut fds = [0; 2];
    assert_eq!(
        unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) },
        0
    );
    unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
}

fn make_blocking(fd: &std::os::fd::OwnedFd) {
    use std::os::fd::AsRawFd;
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    assert_eq!(
        unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags & !libc::O_NONBLOCK) },
        0
    );
}

/// Read a child's pipe on a thread; the chunks arrive on the channel, which
/// closes at the pipe's end, so a test can wait with a deadline.
fn chunks_in_background(mut pipe: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        return;
                    }
                }
            }
        }
    });
    rx
}

/// Everything until the pipe's end; fails after `WAIT` instead of hanging.
fn all_chunks(chunks: &mpsc::Receiver<Vec<u8>>) -> Vec<u8> {
    let deadline = Instant::now() + WAIT;
    let mut all = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match chunks.recv_timeout(left) {
            Ok(chunk) => all.extend_from_slice(&chunk),
            Err(mpsc::RecvTimeoutError::Disconnected) => return all,
            Err(mpsc::RecvTimeoutError::Timeout) => panic!("the pipe did not end within {WAIT:?}"),
        }
    }
}

/// The child's exit; fails (and kills it) after `WAIT` instead of hanging.
fn wait_exit(child: &mut Child) -> std::process::ExitStatus {
    let deadline = Instant::now() + WAIT;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("the agent did not exit within {WAIT:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Read a child's pipe to its end on a thread; the text arrives on the channel.
fn read_to_end_in_background(mut pipe: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = pipe.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    rx
}

/// The agent's stderr once it has exited. Still open seconds later means a
/// process the agent started (squashfuse, the command) outlived it: a
/// failure, reported instead of waiting forever.
fn stderr_after_exit(stderr: &mpsc::Receiver<String>) -> String {
    stderr
        .recv_timeout(Duration::from_secs(10))
        .expect("the agent's stderr is still open 10 s after it exited: a process it started outlived it")
}

fn exec_request(script: &str) -> ExecRequest {
    let out = format!("{ARTIFACTS_ROOT}/out0");
    let home = format!("{ARTIFACTS_ROOT}/home");
    let mut argv: Vec<String> = [
        "--clearenv",
        "--unshare-user",
        "--unshare-uts",
        "--unshare-ipc",
        "--unshare-cgroup-try",
        "--unshare-net",
        "--unshare-pid",
        "--new-session",
        "--die-with-parent",
        "--uid",
        "1001",
        "--gid",
        "1001",
        "--ro-bind",
        "/sandbox-rootfs/bin",
        "/bin",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--ro-bind",
        "/sandbox-layer",
        "/opt/layer",
        "--ro-bind",
        "/host-mounts/0",
        "/input",
        "--ro-bind",
        "/host-mounts/1",
        "/etc/identity",
        "--ro-bind",
        "/host-mounts/2",
        "/opt/vsock-probe",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    for (src, dst) in [
        (out.as_str(), "/output"),
        (home.as_str(), "/home/sandboxuser"),
        (PROGRESS_GUEST_FIFO_PATH, "/run/progress"),
    ] {
        argv.extend(["--bind".into(), src.into(), dst.into()]);
    }
    argv.extend(
        [
            "--setenv",
            "PATH",
            "/bin",
            "--chdir",
            "/",
            "--seccomp",
            "10",
            "--",
            "/bin/sh",
            "-c",
            script,
        ]
        .into_iter()
        .map(String::from),
    );
    ExecRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: 1,
        bwrap_path: "/usr/bin/bwrap".into(),
        argv,
        timeout_ms: 60_000,
        seccomp_fd: Some(10),
        // WSL mode must ignore these (no cgroup changes in the shared tree).
        cgroup: Some(CgroupLimits {
            memory_max_bytes: 256 << 20,
            memory_swap_max_bytes: 0,
            pids_max: 64,
            cpu_max: "100000 100000".into(),
        }),
        progress: true,
        collect_artifacts: vec![out],
        artifacts: ArtifactOptions {
            tmpfs_size: Some("64m".into()),
            tmpfs_root: Some(ARTIFACTS_ROOT.into()),
            scratch_dirs: vec![home],
            total_cap_bytes: 64 << 20,
        },
    }
}

/// The method: says it is ready, waits for the test's go (a file the test
/// creates in the input dir, seen through the read-only bind), then reads the
/// input and the layer, reports its uid, how many network routes it has
/// (none: no network) and what its vsock calls answered (see
/// [`vsock_answers`]), writes outputs and exits 7.
const SCRIPT: &str = r#"echo ready > /run/progress
while [ ! -e /input/go ]; do sleep 0.05; done
cat /input/in.txt /etc/identity
cat /opt/layer/marker >&2
echo "uid=$(id -u)"
echo "routes=$(grep -vc Iface /proc/net/route)"
TXR_VSOCK_PROBE=1 /opt/vsock-probe --exact vsock_probe --nocapture --test-threads=1 | grep '^vsock-'
if echo x > /input/new 2>/dev/null; then echo "input-writable"; fi
echo result > /output/out.txt
mkdir -p /output/sub && printf y > /output/sub/y
exit 7"#;

/// Mount point -> (fs type, mount options) for the mounts at `points` in a
/// process's mount namespace.
fn mounts_of(pid: &str, points: &[&str]) -> Vec<(String, String, String)> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/mountinfo")).unwrap();
    text.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split(' ').collect();
            let point = f.get(4)?;
            let opts = f.get(5)?;
            let fstype = line.split(" - ").nth(1)?.split(' ').next()?;
            points
                .contains(point)
                .then(|| (point.to_string(), fstype.to_string(), opts.to_string()))
        })
        .collect()
}

fn find<'a>(mounts: &'a [(String, String, String)], point: &str) -> &'a (String, String, String) {
    mounts
        .iter()
        .rev()
        .find(|m| m.0 == point)
        .unwrap_or_else(|| panic!("nothing mounted at {point}: {mounts:?}"))
}

/// Loop devices backed by a file under `dir`.
fn loops_backed_by(dir: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/sys/block").unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("loop") {
            continue;
        }
        if let Ok(backing) = std::fs::read_to_string(entry.path().join("loop/backing_file")) {
            if Path::new(backing.trim()).starts_with(dir) {
                found.push(format!("{name}: {}", backing.trim()));
            }
        }
    }
    found
}

/// Processes whose command line contains `needle`.
fn processes_with(needle: &str) -> Vec<String> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if let Ok(cmd) = std::fs::read(entry.path().join("cmdline")) {
            let cmd = String::from_utf8_lossy(&cmd).replace('\0', " ");
            if cmd.contains(needle) {
                found.push(format!("{name}: {cmd}"));
            }
        }
    }
    found
}

/// Wait until no process has `token` in its command line (the sandboxed
/// command is killed with the agent's bwrap).
fn wait_gone(token: &str) {
    wait_gone_within(token, Duration::from_secs(10));
}

fn wait_gone_within(token: &str, limit: Duration) {
    let deadline = Instant::now() + limit;
    while !processes_with(token).is_empty() {
        assert!(
            Instant::now() < deadline,
            "the command outlived its run: {:?}",
            processes_with(token)
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// After the agent is gone: no loop device on the fixture's images, no
/// squashfuse, nothing mounted at the guest paths in this namespace.
fn assert_nothing_left(fx: &Fixture) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let loops = loops_backed_by(&fx.root);
        let fuse = processes_with(SQUASHFUSE);
        if loops.is_empty() && fuse.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "left behind: loop devices {loops:?}, squashfuse {fuse:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let ours = mounts_of(
        "self",
        &["/sandbox-rootfs", "/sandbox-layer", "/host-mounts", "/workspace"],
    );
    assert!(ours.is_empty(), "mounts reached the caller's namespace: {ours:?}");
}

fn stdout_text(frames: &[Frame], stdout: bool) -> String {
    let bytes: Vec<u8> = frames
        .iter()
        .filter_map(|f| match f {
            Frame::Stdout(b) if stdout => Some(b.clone()),
            Frame::Stderr(b) if !stdout => Some(b.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The whole run, checked from both sides. `fuse`: the images are expected
/// on squashfuse (the kernel path was broken for this agent).
fn run_method(start: Start, fuse: bool) {
    let fx = Fixture::new();
    let cgroup_before = std::fs::read_to_string("/sys/fs/cgroup/cgroup.subtree_control").ok();
    let mut agent = Agent::start(&fx.args(), start);
    agent.send(&encode(&Frame::Exec(exec_request(SCRIPT))));
    let mut frames = agent.frames_until(|f| matches!(f, Frame::Progress(_)));
    assert_eq!(frames.last(), Some(&Frame::Progress(b"ready".to_vec())));

    // While the command runs: the agent's own mount namespace holds the mounts.
    let pid = agent.pid().to_string();
    let own_ns = std::fs::read_link("/proc/self/ns/mnt").unwrap();
    assert_ne!(
        std::fs::read_link(format!("/proc/{pid}/ns/mnt")).unwrap(),
        own_ns,
        "a private mount namespace"
    );
    let points = [
        "/sandbox-rootfs",
        "/sandbox-layer",
        "/host-mounts",
        "/host-mounts/0",
        "/host-mounts/1",
        "/tmp",
        "/workspace",
    ];
    let mounts = mounts_of(&pid, &points);
    for (point, image) in [("/sandbox-rootfs", &fx.base), ("/sandbox-layer", &fx.layer)] {
        let (_, fstype, opts) = find(&mounts, point);
        if fuse {
            assert!(fstype.starts_with("fuse"), "{point}: {fstype}");
        } else {
            assert_eq!(fstype, "squashfs", "{point}");
            let loops = loops_backed_by(&fx.root);
            assert!(
                loops.iter().any(|l| l.ends_with(&image.display().to_string())),
                "{loops:?}"
            );
        }
        assert!(opts.split(',').any(|o| o == "ro"), "{point} is read-only: {opts}");
    }
    for point in ["/host-mounts/0", "/host-mounts/1"] {
        let (_, _, opts) = find(&mounts, point);
        assert!(
            opts.split(',').any(|o| o == "ro"),
            "the input bind {point} is read-only: {opts}"
        );
    }
    for point in ["/tmp", "/workspace", "/host-mounts"] {
        assert_eq!(find(&mounts, point).1, "tmpfs", "{point}");
    }
    // The protocol stream is off fds 0 and 1: a child's stray print goes to
    // stderr, and nothing can read the frames meant for the agent.
    use std::os::unix::fs::MetadataExt;
    let file = |path: &str| {
        let md = std::fs::metadata(path).unwrap();
        (md.dev(), md.ino(), md.rdev())
    };
    assert_eq!(
        file(&format!("/proc/{pid}/fd/0")),
        file("/dev/null"),
        "fd 0 is /dev/null"
    );
    assert_eq!(
        file(&format!("/proc/{pid}/fd/1")),
        file(&format!("/proc/{pid}/fd/2")),
        "fd 1 is the agent's stderr"
    );
    // ...and nothing of it in the caller's namespace.
    assert!(mounts_of("self", &["/sandbox-rootfs", "/sandbox-layer", "/host-mounts/0"]).is_empty());
    // No cgroup made or changed (WSL's cgroup tree is shared).
    assert!(
        !Path::new("/sys/fs/cgroup/sb-1").exists(),
        "no per-exec cgroup in WSL mode"
    );
    assert_eq!(
        std::fs::read_to_string("/sys/fs/cgroup/cgroup.subtree_control").ok(),
        cgroup_before
    );

    // Let the command go on; read to the end of the exchange.
    std::fs::write(fx.input.join("go"), b"").unwrap();
    frames.extend(agent.frames_until(|f| matches!(f, Frame::ArtifactsDone)));
    let (code, rest, stderr) = agent.finish();
    assert_eq!(code, Some(0), "agent stderr:\n{stderr}");
    assert!(rest.is_empty(), "nothing after ArtifactsDone: {rest:?}");

    let out = stdout_text(&frames, true);
    // The filter refuses every vsock call in the sandbox. Out here, without
    // it, the kernel answers otherwise (at least EINVAL for the bad flag).
    let outside = vsock_answers();
    assert_eq!(
        out,
        "hello from input\nidentity-file\nuid=1001\nroutes=0\n\
         vsock-socket=EAFNOSUPPORT\nvsock-bad-flag=EAFNOSUPPORT\nvsock-bit-32=EAFNOSUPPORT\n\
         vsock-bit-32-bad-flag=EAFNOSUPPORT\n",
        "outside the sandbox: {outside:?}\nframes: {frames:?}\nagent stderr:\n{stderr}"
    );
    for call in ["vsock-bad-flag", "vsock-bit-32-bad-flag"] {
        assert!(
            outside.contains(&(call, "EINVAL".to_string())),
            "without the filter the kernel itself answers {call}: {outside:?}"
        );
    }
    assert!(stdout_text(&frames, false).contains("layer-marker"), "{frames:?}");
    let exit = frames
        .iter()
        .position(|f| matches!(f, Frame::Exit(_)))
        .expect("an Exit frame");
    assert_eq!(
        frames[exit],
        Frame::Exit(ExitStatus {
            code: 7,
            timed_out: false
        })
    );
    let mut outputs = std::collections::BTreeMap::new();
    for f in &frames[exit + 1..] {
        match f {
            Frame::ArtifactChunk {
                mount_index: 0,
                rel_path,
                offset: 0,
                data,
            } => {
                outputs.insert(rel_path.clone(), data.clone());
            }
            Frame::ArtifactDir {
                mount_index: 0,
                rel_path,
            } => {
                outputs.insert(format!("{rel_path}/"), Vec::new());
            }
            Frame::ArtifactsDone => {}
            other => panic!("unexpected frame after Exit: {other:?}"),
        }
    }
    let expected: std::collections::BTreeMap<String, Vec<u8>> = [
        ("out.txt".to_string(), b"result\n".to_vec()),
        ("sub/".to_string(), Vec::new()),
        ("sub/y".to_string(), b"y".to_vec()),
    ]
    .into_iter()
    .collect();
    assert_eq!(outputs, expected);
    assert_eq!(frames.last(), Some(&Frame::ArtifactsDone));
    assert!(!fx.input.join("new").exists(), "the input dir was not written through");
    if fuse {
        assert!(stderr.contains("trying squashfuse"), "{stderr}");
    }
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_runs_a_method_over_kernel_squashfs_and_leaves_nothing_mounted() {
    run_method(Start::Direct, false);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_falls_back_to_squashfuse_when_the_kernel_path_fails() {
    run_method(Start::After(BREAK_LOOP), true);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_eof_before_a_request_exits_0_and_runs_nothing() {
    let fx = Fixture::new();
    let mut agent = Agent::start(&fx.args(), Start::Direct);
    agent.close_stdin();
    let (code, rest, stderr) = agent.finish();
    assert_eq!(code, Some(0), "{stderr}");
    assert!(rest.is_empty(), "no frame: {rest:?}");
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_a_malformed_frame_exits_4() {
    let fx = Fixture::new();
    let mut agent = Agent::start(&fx.args(), Start::Direct);
    // Tag 99 does not exist.
    agent.send(&[99, 0, 0, 0, 0]);
    let (code, rest, stderr) = agent.finish();
    assert_eq!(code, Some(4), "{stderr}");
    assert!(rest.is_empty(), "no frame: {rest:?}");
    assert!(stderr.contains("malformed frame"), "{stderr}");
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_a_request_of_another_protocol_version_exits_4_and_runs_nothing() {
    let fx = Fixture::new();
    let mut agent = Agent::start(&fx.args(), Start::Direct);
    let mut req = exec_request("echo must-not-run > /output/ran");
    req.protocol_version = PROTOCOL_VERSION + 1;
    agent.send(&encode(&Frame::Exec(req)));
    let (code, rest, stderr) = agent.finish();
    assert_eq!(code, Some(4), "{stderr}");
    assert!(rest.is_empty(), "no frame: {rest:?}");
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_the_host_leaving_mid_run_kills_the_command_and_exits_4() {
    let fx = Fixture::new();
    let mut agent = Agent::start(&fx.args(), Start::Direct);
    let token = "e2e-host-leaves-token";
    agent.send(&encode(&Frame::Exec(exec_request(&format!("{SCRIPT}; : {token}")))));
    agent.frames_until(|f| matches!(f, Frame::Progress(_)));
    assert!(!processes_with(token).is_empty(), "the command runs");
    agent.close_stdin();
    let (code, _, stderr) = agent.finish();
    assert_eq!(code, Some(4), "{stderr}");
    assert!(
        stderr.contains("closed the connection before the command finished"),
        "{stderr}"
    );
    wait_gone(token);
    assert_nothing_left(&fx);
}

/// The app stops a run by killing its `wsl.exe`, which may leave the agent
/// running in WSL: stdin closing must stop the command at once (exit 4).
fn stdin_closed_mid_command(req: ExecRequest, marker: &str) {
    let fx = Fixture::new();
    let mut agent = Agent::start(&fx.args(), Start::Direct);
    agent.send(&encode(&Frame::Exec(req)));
    let deadline = Instant::now() + WAIT;
    while processes_with(marker).is_empty() {
        assert!(Instant::now() < deadline, "the command did not start");
        std::thread::sleep(Duration::from_millis(20));
    }
    agent.close_stdin();
    let started = Instant::now();
    let (code, _, stderr) = agent.finish();
    assert_eq!(code, Some(4), "{stderr}");
    wait_gone_within(marker, Duration::from_secs(5));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "stopped within a few seconds"
    );
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_stdin_closing_stops_a_long_sandboxed_command() {
    stdin_closed_mid_command(exec_request("sleep 300"), "sleep 300");
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_stdin_closing_kills_the_command_s_whole_process_group() {
    // No pid namespace to collapse here: a background process is reached
    // only by killing the process group.
    let mut req = exec_request("unused");
    req.bwrap_path = "/bin/sh".into();
    // sh's own command line holds `sleep $n`: `sleep 3001` matches only the
    // background process, so the test waits until it really exists.
    req.argv = vec!["-c".into(), "n=3001; sleep $n & sleep 3002".into()];
    req.seccomp_fd = None;
    req.progress = false;
    stdin_closed_mid_command(req, "sleep 3001");
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_a_bad_layer_image_exits_3_after_the_base_was_mounted_and_leaves_nothing() {
    let fx = Fixture::new();
    std::fs::write(&fx.layer, vec![0u8; 64 * 1024]).unwrap();
    let agent = Agent::start(&fx.args(), Start::Direct);
    let (code, rest, stderr) = agent.finish();
    assert_eq!(code, Some(3), "{stderr}");
    assert!(rest.is_empty(), "no frame: {rest:?}");
    let reason = format!("mounting {} at /sandbox-layer: kernel squashfs:", fx.layer.display());
    assert!(stderr.contains(&reason), "{stderr}");
    assert!(stderr.contains("; squashfuse:"), "{stderr}");
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_without_kernel_squashfs_or_squashfuse_exits_3_with_both_reasons() {
    let fx = Fixture::new();
    let agent = Agent::start(&fx.args(), Start::After(BREAK_LOOP_AND_FUSE));
    let (code, rest, stderr) = agent.finish();
    assert_eq!(code, Some(3), "{stderr}");
    assert!(rest.is_empty(), "no frame: {rest:?}");
    assert!(stderr.contains("kernel squashfs: LOOP_CTL_GET_FREE"), "{stderr}");
    assert!(
        stderr.contains("squashfuse: /usr/bin/squashfuse is not installed"),
        "{stderr}"
    );
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_a_missing_input_exits_3_before_anything_is_mounted() {
    let fx = Fixture::new();
    let mut args = fx.args();
    args.extend(["--ro".into(), fx.root.join("no-such-input").display().to_string()]);
    let agent = Agent::start(&args, Start::Direct);
    let (code, rest, stderr) = agent.finish();
    assert_eq!(code, Some(3), "{stderr}");
    assert!(rest.is_empty());
    assert!(
        stderr.contains(&format!(
            "setup failed: opening {}",
            fx.root.join("no-such-input").display()
        )),
        "{stderr}"
    );
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_non_blocking_stdin_and_stdout_still_carry_the_exchange() {
    let fx = Fixture::new();
    // Two pipes, non-blocking on both ends; ours are made blocking again.
    let (agent_in, host_out) = non_blocking_pipe();
    let (host_in, agent_out) = non_blocking_pipe();
    make_blocking(&host_out);
    make_blocking(&host_in);
    let mut child = Command::new(AGENT)
        .args(fx.args())
        .stdin(Stdio::from(agent_in))
        .stdout(Stdio::from(agent_out))
        .stderr(Stdio::piped())
        .spawn()
        .expect("start the agent");
    let stderr = read_to_end_in_background(child.stderr.take().unwrap());
    let mut to_agent = std::fs::File::from(host_out);
    let from_agent = chunks_in_background(std::fs::File::from(host_in));
    // Nothing to read at first: a non-blocking read would fail right away.
    std::thread::sleep(Duration::from_millis(300));
    let mut req = exec_request("unused");
    req.bwrap_path = "/bin/echo".into();
    req.argv = vec!["over a non-blocking pipe".into()];
    req.seccomp_fd = None;
    req.progress = false;
    to_agent.write_all(&encode(&Frame::Exec(req))).unwrap();
    let mut decoder = Decoder::new();
    let mut frames = Vec::new();
    let deadline = Instant::now() + WAIT;
    while !frames.contains(&Frame::ArtifactsDone) {
        let left = deadline.saturating_duration_since(Instant::now());
        let chunk = match from_agent.recv_timeout(left) {
            Ok(chunk) => chunk,
            Err(mpsc::RecvTimeoutError::Disconnected) => panic!("the agent closed early: {frames:?}"),
            Err(mpsc::RecvTimeoutError::Timeout) => panic!("no ArtifactsDone within {WAIT:?}: {frames:?}"),
        };
        decoder.feed(&chunk);
        while let Some(f) = decoder.next_frame().unwrap() {
            frames.push(f);
        }
    }
    drop(to_agent);
    let status = wait_exit(&mut child);
    let stderr = stderr_after_exit(&stderr);
    assert_eq!(status.code(), Some(0), "{stderr}");
    assert_eq!(stdout_text(&frames, true), "over a non-blocking pipe\n");
    assert!(frames.contains(&Frame::Exit(ExitStatus {
        code: 0,
        timed_out: false
    })));
    assert_nothing_left(&fx);
}

/// SIGKILL mid-run (wsl.exe killed, the distro's session gone): the command,
/// the mounts and any squashfuse go with the agent.
fn killed_mid_run(start: Start) {
    let fx = Fixture::new();
    let mut agent = Agent::start(&fx.args(), start);
    let token = "e2e-killed-token";
    agent.send(&encode(&Frame::Exec(exec_request(&format!("{SCRIPT}; : {token}")))));
    agent.frames_until(|f| matches!(f, Frame::Progress(_)));
    assert!(!processes_with(token).is_empty(), "the command runs");
    agent.child.kill().unwrap();
    let (code, _, _) = agent.finish();
    assert_eq!(code, None, "killed by a signal");
    wait_gone(token);
    assert_nothing_left(&fx);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_a_killed_agent_leaves_no_loop_device() {
    killed_mid_run(Start::Direct);
}

#[test]
#[ignore = "needs root in a privileged container: sdk/scripts/test-guest-agent-linux.sh"]
fn e2e_a_killed_agent_leaves_no_squashfuse() {
    killed_mid_run(Start::After(BREAK_LOOP));
}
