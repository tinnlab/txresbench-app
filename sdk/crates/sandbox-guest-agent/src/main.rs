//! `txresbench-sandbox-agent` — the in-VM init + control agent for the macOS
//! method VM (libkrun).
//!
//! libkrun runs this as the guest entrypoint (`krun_set_exec`). Its job:
//!   1. Mount the pieces the host wired in: `/proc`, the method's base **squashfs**
//!      and its layer (added by the host via `krun_add_disk`, they appear as
//!      virtio-blk devices), the **workspace** and the read-only input shares
//!      (virtio-fs).
//!   2. Listen on a vsock port (libkrun bridges it to a unix socket on the
//!      macOS host) and, per connection, run the host-supplied **bwrap argv**
//!      (built by the host with guest paths), stream stdout/stderr + the exit
//!      status back over `sandbox-vm-protocol` frames, then copy the run's
//!      outputs back in chunks.
//!
//! The agent is a *dumb executor*: all hardening lives in the argv the host
//! sends, so the host's argv builder stays the single source of truth.
//!
//! ## Guest contract (must match the host's libkrun configuration)
//!  - vsock port [`VSOCK_PORT`] — agent listens; host connects via the bridge.
//!  - [`ROOTFS_DEVICE`] — the squashfs block device; mounted read-only at
//!    [`ROOTFS_MOUNT`] (the host's argv binds `<rootfs>/usr` etc. from there).
//!  - virtio-fs tag [`WORKSPACE_TAG`] — mounted at [`WORKSPACE_MOUNT`]; the
//!    host points the workspace bind in the argv at a path under it.

// The agent runs only in the Linux guest; on other hosts the crate builds to
// the stub `main` below, which uses none of these imports or guest constants.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::time::Duration;

#[cfg(target_os = "linux")]
use sandbox_vm_protocol::{
    encode, CgroupLimits, Decoder, ExitStatus, Frame, PROGRESS_GUEST_FIFO_PATH, PROGRESS_MAX_LINE_BYTES,
};
#[cfg(target_os = "linux")]
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
#[cfg(target_os = "linux")]
use tokio::process::Command;
#[cfg(target_os = "linux")]
use tokio::sync::mpsc;
#[cfg(target_os = "linux")]
use tokio_vsock::{VsockAddr, VsockListener};

/// vsock port the agent listens on. libkrun bridges this to a host unix socket.
const VSOCK_PORT: u32 = 1024;
/// The squashfs disk the host adds via `krun_add_disk` (virtio-blk).
const ROOTFS_DEVICE: &str = "/dev/vda";
/// Where the agent mounts the squashfs; matches the rootfs dir the host passes
/// to `build_bwrap_argv`.
const ROOTFS_MOUNT: &str = "/sandbox-rootfs";
/// The optional second squashfs disk: a method-environment LAYER the launcher
/// attaches after the rootfs disk when its config names one (it then sets
/// `TXR_LAYER_DISK=1` in our env). Mounted read-only at [`LAYER_MOUNT`]; the
/// guest root must pre-create that mount point, like `/sandbox-rootfs`.
const LAYER_DEVICE: &str = "/dev/vdb";
const LAYER_MOUNT: &str = "/sandbox-layer";
/// virtio-fs tag the host shares the workspace root under.
const WORKSPACE_TAG: &str = "workspace";
const WORKSPACE_MOUNT: &str = "/workspace";
/// Base dir for the read-only host-folder shares (the run's inputs). A tmpfs is
/// mounted here (the guest root is RO), then each extra virtio-fs share at
/// /host-mounts/<i>. MUST match the host's guest path for these shares.
#[cfg(target_os = "linux")]
const EXTRA_MOUNTS_DIR: &str = "/host-mounts";
/// Tag prefix for host-folder shares. MUST match the launcher's
/// `EXTRA_MOUNT_TAG_PREFIX`.
#[cfg(target_os = "linux")]
const EXTRA_MOUNT_TAG_PREFIX: &str = "host-mount-";

/// Chunk size for streaming child stdout/stderr.
const READ_CHUNK: usize = 64 * 1024;

// Non-Linux stub so the bin can compile in a cargo workspace check
// from a Mac/Windows host. Cross-compile to Linux for the real build.
#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("txresbench-sandbox-agent is built for Linux guest VMs only");
    std::process::exit(1);
}

#[cfg(target_os = "linux")]
#[tokio::main(flavor = "multi_thread")]
async fn main() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_writer(std::io::stderr)
        .init();

    init_mounts();
    cgroup_init();

    // Build the seccomp BPF once from the shared policy crate (identical to the
    // Linux host). Per-exec we pipe these bytes to bwrap's --seccomp fd. If the
    // build fails (a broken guest image), execs that request seccomp fail
    // closed rather than running unfiltered.
    let bpf: Option<Arc<Vec<u8>>> = match sandbox_seccomp::build_bpf() {
        Ok((bytes, unresolved)) => {
            if !unresolved.is_empty() {
                tracing::warn!(?unresolved, "agent: some seccomp DENY entries unresolved on this kernel");
            }
            Some(Arc::new(bytes))
        }
        Err(e) => {
            tracing::error!("agent: seccomp filter build FAILED: {e} — seccomp'd execs will fail closed");
            None
        }
    };

    // libkrun bridges this vsock port to a unix socket on the host.
    serve_vsock(VSOCK_PORT, bpf).await
}

#[cfg(target_os = "linux")]
async fn serve_vsock(port: u32, bpf: Option<Arc<Vec<u8>>>) {
    let listener = match VsockListener::bind(VsockAddr::new(libc::VMADDR_CID_ANY, port)) {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("agent: failed to bind vsock port {port}: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!("txresbench-sandbox-agent: listening on vsock port {port}");
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                // Reject any peer that isn't the host. We bind on
                // VMADDR_CID_ANY (you can't bind to a single remote cid in
                // AF_VSOCK); the libkrun host bridge presents as cid=2
                // (VMADDR_CID_HOST), so this filter is a no-op on the
                // legitimate path and refuses anything else before it can ask
                // for a workload.
                let peer_cid = peer.cid();
                if peer_cid != libc::VMADDR_CID_HOST {
                    tracing::warn!(
                        "agent: refusing vsock connection from non-host peer (cid={peer_cid}, port={})",
                        peer.port()
                    );
                    drop(stream);
                    continue;
                }
                spawn_conn(stream, &bpf, format!("{peer:?}"))
            }
            Err(e) => {
                tracing::warn!("agent: vsock accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

// spawn_conn reaches install_seccomp, which is Linux-only.
#[cfg(target_os = "linux")]
fn spawn_conn<S>(stream: S, bpf: &Option<Arc<Vec<u8>>>, peer: String)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    tracing::info!("agent: connection from {peer}");
    let bpf = bpf.clone();
    tokio::spawn(async move {
        if let Err(e) = handle_conn(stream, bpf).await {
            tracing::warn!("agent: connection handler error: {e}");
        }
    });
}

/// The guest's mounts. The kernel filesystems and the workspace share are
/// best-effort (a failure is logged). The images a run executes from (the
/// rootfs and, when attached, the layer disk) and the shared inputs are
/// required: if one fails to mount the agent exits, so no command ever runs
/// on missing data.
// libc::mount + MS_RDONLY are Linux-only — gating these two functions
// keeps `cargo check --workspace` happy on Mac/Windows hosts. main()
// has a parallel cfg gate.
#[cfg(target_os = "linux")]
fn init_mounts() {
    mount_fs("proc", "/proc", "proc", 0, None);
    // The guest root is shared read-only over virtio-fs (the launcher). Provide a
    // writable /tmp so the seccomp BPF build (which uses `tempfile`) and any
    // other ephemeral guest work has somewhere to land.
    mount_fs("tmpfs", "/tmp", "tmpfs", 0, Some("size=16m,mode=1777"));

    // The host attaches the base squashfs as a virtio-blk disk at /dev/vda and
    // shares the workspace over virtio-fs; bwrap (rootfs = /sandbox-rootfs)
    // chroots into the squashfs. A sandbox that runs without its rootfs, layer
    // or shared inputs would run the workload on missing data: a failed mount
    // stops the agent, so the host sees the VM fail instead.
    require_mount(mount_fs(ROOTFS_DEVICE, ROOTFS_MOUNT, "squashfs", libc::MS_RDONLY, None));
    // The method layer: present only when the launcher attached it.
    if std::env::var("TXR_LAYER_DISK").as_deref() == Ok("1") {
        require_mount(mount_fs(LAYER_DEVICE, LAYER_MOUNT, "squashfs", libc::MS_RDONLY, None));
    }
    mount_fs(WORKSPACE_TAG, WORKSPACE_MOUNT, "virtiofs", 0, None);

    // Make /workspace world-writable so the sandboxed user (uid 1001
    // via --unshare-user in the bwrap argv) can create files inside
    // it. The virtio-fs share inherits its mode from the host dir,
    // which on Mac is owned by the running user (not uid 1001). Without
    // this chmod, bwrap's bind-target creation under /home/sandboxuser
    // (bound from /workspace) fails with EACCES.
    // Same for /tmp's mode-1777 above — kernel honors the explicit
    // tmpfs option; virtio-fs needs an explicit post-mount chmod.
    let c_ws = std::ffi::CString::new(WORKSPACE_MOUNT).unwrap();
    let chmod_rc = unsafe { libc::chmod(c_ws.as_ptr(), 0o1777) };
    if chmod_rc != 0 {
        tracing::warn!(
            "agent: chmod {WORKSPACE_MOUNT} 1777 failed: {} — sandboxed writes may fail",
            std::io::Error::last_os_error()
        );
    }

    // Host-folder mounts (the run's inputs): the launcher shared N folders as
    // read-only virtio-fs devices (tags host-mount-0..N-1) and told us N via
    // the TXR_EXTRA_MOUNTS env. The guest root is RO, so mount a tmpfs at
    // /host-mounts to hold the mountpoints, then mount each share at
    // /host-mounts/<i>. bwrap (argv built by the server) binds these to
    // /mnt/<full host path>. No-op when N == 0.
    if let Ok(n) = std::env::var("TXR_EXTRA_MOUNTS")
        .unwrap_or_default()
        .parse::<usize>()
    {
        if n > 0 {
            mount_fs("tmpfs", EXTRA_MOUNTS_DIR, "tmpfs", 0, Some("size=1m,mode=0755"));
            for i in 0..n {
                let tag = format!("{EXTRA_MOUNT_TAG_PREFIX}{i}");
                let target = format!("{EXTRA_MOUNTS_DIR}/{i}");
                let _ = std::fs::create_dir_all(&target);
                require_mount(mount_fs(&tag, &target, "virtiofs", 0, None));
            }
        }
    }
}

/// Stop the agent (and so the VM) when a required mount failed; the reason is
/// already logged by `mount_fs`.
#[cfg(target_os = "linux")]
fn require_mount(ok: bool) {
    if !ok {
        tracing::error!("agent: a required mount failed; stopping");
        std::process::exit(1);
    }
}

/// Mount and log the outcome; returns whether the mount succeeded.
#[cfg(target_os = "linux")]
fn mount_fs(src: &str, target: &str, fstype: &str, flags: libc::c_ulong, data: Option<&str>) -> bool {
    use std::ffi::CString;
    let c_src = CString::new(src).unwrap();
    let c_tgt = CString::new(target).unwrap();
    let c_fs = CString::new(fstype).unwrap();
    let c_data = data.map(|d| CString::new(d).unwrap());
    let data_ptr = c_data
        .as_ref()
        .map(|c| c.as_ptr() as *const libc::c_void)
        .unwrap_or(std::ptr::null());
    // SAFETY: all pointers are valid CStrings living for the call.
    let rc = unsafe { libc::mount(c_src.as_ptr(), c_tgt.as_ptr(), c_fs.as_ptr(), flags, data_ptr) };
    if rc != 0 {
        tracing::warn!(
            "agent: mount {src} -> {target} ({fstype}) failed: {}",
            std::io::Error::last_os_error()
        );
        false
    } else {
        tracing::info!("agent: mounted {src} -> {target} ({fstype})");
        true
    }
}

/// Handle one control connection: wait for the host's `Exec`, then run it
/// ([`handle_exec`]).
// handle_conn calls install_seccomp + uses Linux-only APIs.
#[cfg(target_os = "linux")]
async fn handle_conn<S>(stream: S, bpf: Option<Arc<Vec<u8>>>) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut rd, wr) = tokio::io::split(stream);

    // Read until the `Exec` frame. Any other frame from the host is logged and
    // skipped.
    let mut decoder = Decoder::new();
    let mut buf = [0u8; READ_CHUNK];
    let req = loop {
        match decoder.next_frame() {
            Ok(Some(Frame::Exec(req))) => break req,
            Ok(Some(other)) => {
                tracing::warn!("agent: ignoring unexpected pre-exec frame: {other:?}");
                continue;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("agent: protocol error: {e}");
                return Ok(());
            }
        }
        let n = rd.read(&mut buf).await?;
        if n == 0 {
            return Ok(()); // peer closed before sending a request
        }
        decoder.feed(&buf[..n]);
    };

    handle_exec(rd, wr, req, bpf).await
}

/// Run one `Exec`. All hardening lives in the argv the host built; the agent
/// execs it, streams output, sends `Exit` as soon as it ends, then the
/// outputs, then `ArtifactsDone`, and closes.
#[cfg(target_os = "linux")]
async fn handle_exec<R, W>(
    mut rd: R,
    wr: W,
    req: sandbox_vm_protocol::ExecRequest,
    bpf: Option<Arc<Vec<u8>>>,
) -> std::io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    // Reject a version this agent does not serve, loudly (see
    // PROTOCOL_VERSION). Peers that predate the field send `0`, which is never
    // served.
    if let Err(why) = req.check_version() {
        tracing::error!(request_id = req.request_id, "agent: {why}; rejecting");
        return Ok(());
    }

    tracing::info!(
        request_id = req.request_id,
        argv_len = req.argv.len(),
        "agent: running bwrap"
    );

    // libkrun virtio-fs CREATE-EPERM workaround: provision each output dir
    // (guest-local) BEFORE bwrap runs, so a sandboxed `open(O_CREAT)`/`mkdir`
    // there succeeds (a virtio-fs RW bind would fail CREATE with EPERM on
    // libkrun). The bwrap argv binds THESE dirs as the RW mounts; we send them
    // back after exit.
    provision_artifact_tmpfs(&req.collect_artifacts, &req.artifacts);

    // Single writer task owns the write half; stdout/stderr readers + the exit
    // funnel frames through this channel so concurrent writes are serialized.
    let (tx, mut frame_rx) = mpsc::unbounded_channel::<Frame>();
    // Returns the write half once every sender is gone, so the output
    // copy-back can write directly (with backpressure) after the run.
    let writer = tokio::spawn(async move {
        let mut wr = wr;
        while let Some(frame) = frame_rx.recv().await {
            if wr.write_all(&encode(&frame)).await.is_err() {
                return None;
            }
        }
        let _ = wr.flush().await;
        Some(wr)
    });

    // Seccomp: if the host put `--seccomp <fd>` in the argv, pipe the shared
    // BPF to that fd in the bwrap child (mirrors the Linux host's SeccompPipe).
    if req.seccomp_fd.is_some() && bpf.is_none() {
        let _ = tx.send(Frame::Stderr(
            b"agent: seccomp requested but the guest filter failed to build\n".to_vec(),
        ));
        let _ = tx.send(Frame::Exit(ExitStatus { code: -1, timed_out: false }));
        // Nothing ran, so there are no outputs; say so, or the host would
        // report a cut-off copy-back instead of this failure.
        let _ = tx.send(Frame::ArtifactsDone);
        drop(tx);
        let _ = writer.await;
        return Ok(());
    }

    let mut cmd = Command::new(&req.bwrap_path);
    cmd.args(&req.argv)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // Install the seccomp pipe (read end dup2'd to the host-specified fd in the
    // bwrap child). Keep the read fd to close after spawn.
    let (seccomp_read_fd, seccomp_writer) = match (req.seccomp_fd, bpf.as_ref()) {
        (Some(fd), Some(bytes)) => match install_seccomp(&mut cmd, fd, bytes.clone()) {
            Ok((rfd, h)) => (Some(rfd), Some(h)),
            Err(e) => {
                let _ = tx.send(Frame::Stderr(format!("agent: seccomp setup failed: {e}\n").into_bytes()));
                let _ = tx.send(Frame::Exit(ExitStatus { code: -1, timed_out: false }));
                // Nothing ran, so there are no outputs; say so, or the host
                // would report a cut-off copy-back instead of this failure.
                let _ = tx.send(Frame::ArtifactsDone);
                drop(tx);
                let _ = writer.await;
                return Ok(());
            }
        },
        _ => (None, None),
    };

    // Live-progress FIFO. When the host set `req.progress`, create the named
    // pipe at the guest-local path (NOT virtio-fs — libkrun's virtio-fs has an
    // mkfifo EPERM bug) BEFORE spawning bwrap, because the host-built argv
    // `--bind`s it where the method writes its progress lines. The reader
    // forwards each newline-trimmed line as a `Frame::Progress`; it ends when
    // the bwrap child exits (the guard's drop unlinks the FIFO + aborts the
    // reader).
    let progress = if req.progress {
        match ProgressFifo::spawn(tx.clone()) {
            Ok(p) => Some(p),
            Err(e) => {
                tracing::warn!("agent: progress FIFO setup failed: {e}; bwrap bind will fail");
                None
            }
        }
    } else {
        None
    };

    let spawned = cmd.spawn();
    // The child holds its own dup of the read fd; close ours so the writer's
    // EOF is observed once it finishes.
    if let Some(rfd) = seccomp_read_fd {
        unsafe { libc::close(rfd) };
    }
    let mut child = match spawned {
        Ok(c) => c,
        Err(e) => {
            let _ = tx.send(Frame::Stderr(format!("agent: failed to spawn bwrap: {e}\n").into_bytes()));
            let _ = tx.send(Frame::Exit(ExitStatus { code: -1, timed_out: false }));
            // Nothing ran, so there are no outputs; say so, or the host would
            // report a cut-off copy-back instead of this failure.
            let _ = tx.send(Frame::ArtifactsDone);
            // The progress reader holds a sender too: stop it (and unlink the
            // FIFO) so the writer sees every sender gone and finishes.
            drop(progress);
            drop(tx);
            let _ = writer.await;
            return Ok(());
        }
    };

    // In-guest cgroup v2 (defense-in-depth; the prlimit wrapper in the argv is
    // the always-on backstop). Held until the end of the fn so Drop removes the
    // cgroup after the child exits.
    let _cgroup = match (&req.cgroup, child.id()) {
        (Some(limits), Some(pid)) => match GuestCgroup::create(req.request_id, limits) {
            Ok(cg) => {
                cg.attach(pid);
                Some(cg)
            }
            Err(e) => {
                tracing::warn!("agent: cgroup create failed: {e}; prlimit still applies");
                None
            }
        },
        _ => None,
    };

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let out_tx = tx.clone();
    let err_tx = tx.clone();
    let out_task = tokio::spawn(pump(stdout, out_tx, true));
    let err_task = tokio::spawn(pump(stderr, err_tx, false));

    // Wait for the command, racing three things: normal exit, the wall-clock
    // budget (→ SIGKILL; bwrap's --die-with-parent collapses the tree), and the
    // host disconnecting (its budget ran out, or the run was cancelled). On
    // host disconnect we kill the workload instead of letting it run to the
    // full timeout.
    let budget = Duration::from_millis(req.timeout_ms.max(1));
    let (code, timed_out) = tokio::select! {
        res = child.wait() => match res {
            Ok(status) => (status.code().unwrap_or(-1), false),
            Err(_) => (-1, false),
        },
        _ = tokio::time::sleep(budget) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            (-1, true)
        }
        _ = wait_host_eof(&mut rd) => {
            tracing::info!(request_id = req.request_id, "agent: host disconnected; killing command");
            let _ = child.start_kill();
            let _ = child.wait().await;
            (-1, false)
        }
    };

    // Make sure all output is flushed before Exit.
    let _ = out_task.await;
    let _ = err_task.await;
    // Join the seccomp BPF writer (bwrap has consumed the filter by now); this
    // reaps the task instead of leaking it and surfaces a truncated-write log.
    if let Some(h) = seccomp_writer {
        let _ = h.await;
    }
    // Stop the progress reader + unlink the FIFO BEFORE dropping `tx`: the
    // bwrap child has exited so no further progress writes arrive, and
    // we don't want an orphaned reader holding the writer half of `tx`.
    drop(progress);

    // Send the outputs back (the host writes them into the real host output
    // dir — the host's own fs, which works): let the writer drain what is
    // queued, take the write half back, and write every chunk directly so a
    // large file never queues in memory.
    drop(tx);
    if let Ok(Some(mut wr)) = writer.await {
        // The command's status first, so a failed copy-back can never lose
        // it; then the outputs; then the end marker.
        if wr
            .write_all(&encode(&Frame::Exit(ExitStatus { code, timed_out })))
            .await
            .is_ok()
        {
            send_artifacts_chunked(&req.collect_artifacts, req.artifacts.total_cap_bytes, &mut wr).await;
            let _ = wr.write_all(&encode(&Frame::ArtifactsDone)).await;
        }
        let _ = wr.flush().await;
    }
    Ok(())
}

/// Provision each artifact-collection dir so a sandboxed `open(O_CREAT)`/`mkdir`
/// succeeds (libkrun virtio-fs CREATE fails EPERM — these dirs live UNDER the
/// guest's already-writable `/tmp` tmpfs, NOT on the RO virtio-fs root, so the
/// `mkdir` lands and the bwrap RW bind to it can be created in place). chmod
/// 1777 so bwrap's uid-1001 workload can write files. Best-effort + Linux-only;
/// a failure just means the dir behaves like the (broken) virtio-fs bind would
/// have — no worse than before.
#[cfg(target_os = "linux")]
fn provision_artifact_tmpfs(dirs: &[String], opts: &sandbox_vm_protocol::ArtifactOptions) {
    // ArtifactOptions.tmpfs_size + tmpfs_root: ONE tmpfs shared by every
    // artifact and scratch dir (they live under the root).
    let mut shared_root = false;
    if let (Some(size), Some(root)) = (opts.tmpfs_size.as_deref(), opts.tmpfs_root.as_deref()) {
        if size.contains(',') {
            tracing::warn!("agent: refusing artifact tmpfs size {size:?}");
        } else {
            let _ = std::fs::create_dir_all(root);
            shared_root = mount_fs("tmpfs", root, "tmpfs", 0, Some(&format!("size={size},mode=1777")));
        }
    }
    for dir in dirs.iter().chain(opts.scratch_dirs.iter()) {
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!("agent: mkdir artifact dir {dir} failed: {e}");
            continue;
        }
        // tmpfs_size without a root: a dedicated tmpfs per dir (mode 1777).
        // A failed mount falls through to the chmod below, so the dir is
        // still writable for the workload (on the guest /tmp).
        if !shared_root && opts.tmpfs_root.is_none() {
            if let Some(size) = opts.tmpfs_size.as_deref() {
                if size.contains(',') {
                    tracing::warn!("agent: refusing artifact tmpfs size {size:?}");
                } else if mount_fs("tmpfs", dir, "tmpfs", 0, Some(&format!("size={size},mode=1777"))) {
                    continue;
                }
            }
        }
        let c = match std::ffi::CString::new(dir.as_str()) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("agent: artifact dir {dir} has an interior NUL byte: {e}");
                continue;
            }
        };
        let rc = unsafe { libc::chmod(c.as_ptr(), 0o1777) };
        if rc != 0 {
            tracing::warn!(
                "agent: chmod {dir} 1777 failed: {} — sandboxed artifact writes may fail",
                std::io::Error::last_os_error()
            );
        } else {
            tracing::info!("agent: provisioned artifact dir {dir}");
        }
    }
}

/// One entry under an artifact dir, for the copy-back.
#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum ArtifactEntry {
    Dir(String),
    /// A regular file to send: the path to read and its relative name.
    File(std::path::PathBuf, String),
    /// A symlink, sent as a symlink with its stored target (unresolved).
    Symlink(String, String),
    /// Present but not sent, with the reason (reported as ArtifactSkipped).
    Unsendable(String, String),
}

/// The forward-slash relative path of `path` under `root`, built from the
/// path's own components (a `\` in a Linux file name stays part of the
/// name). `None` for a name that is not valid UTF-8.
#[cfg(target_os = "linux")]
fn artifact_rel_path(root: &std::path::Path, path: &std::path::Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = rel.components().map(|c| c.as_os_str().to_str()).collect();
    Some(parts?.join("/"))
}

/// Everything under an artifact dir, sorted so a directory comes before its
/// contents. Symlinks are never followed: each is sent as a symlink with its
/// stored target, for the host to recreate or refuse (the workload made it
/// inside its sandbox, where this dir has another path, so resolving it here
/// would be wrong). Special files, unreadable entries and unlistable
/// directories are reported, never silently dropped.
#[cfg(target_os = "linux")]
fn list_artifact_entries(root: &std::path::Path) -> Vec<ArtifactEntry> {
    let mut out: Vec<(String, ArtifactEntry)> = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let unsendable = |out: &mut Vec<(String, ArtifactEntry)>, rel: String, why: String| {
        out.push((rel.clone(), ArtifactEntry::Unsendable(rel, why)));
    };
    while let Some(dir) = stack.pop() {
        let dir_rel = artifact_rel_path(root, &dir).unwrap_or_default();
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(e) => {
                unsendable(&mut out, dir_rel, format!("the directory could not be listed: {e}"));
                continue;
            }
        };
        for entry in rd {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    unsendable(&mut out, dir_rel.clone(), format!("listing the directory failed: {e}"));
                    continue;
                }
            };
            let path = entry.path();
            let Some(rel_path) = artifact_rel_path(root, &path) else {
                unsendable(&mut out, path.to_string_lossy().into_owned(), "the name is not valid UTF-8".into());
                continue;
            };
            let md = match std::fs::symlink_metadata(&path) {
                Ok(md) => md,
                Err(e) => {
                    unsendable(&mut out, rel_path, format!("could not be read: {e}"));
                    continue;
                }
            };
            let kind = if md.is_dir() {
                stack.push(path);
                ArtifactEntry::Dir(rel_path.clone())
            } else if md.is_file() {
                ArtifactEntry::File(path, rel_path.clone())
            } else if md.file_type().is_symlink() {
                match std::fs::read_link(&path).map(|t| t.to_str().map(str::to_string)) {
                    Ok(Some(target)) => ArtifactEntry::Symlink(rel_path.clone(), target),
                    Ok(None) => ArtifactEntry::Unsendable(
                        rel_path.clone(),
                        "the symlink's target is not valid UTF-8".into(),
                    ),
                    Err(e) => ArtifactEntry::Unsendable(rel_path.clone(), format!("could not read the symlink: {e}")),
                }
            } else {
                ArtifactEntry::Unsendable(rel_path.clone(), "not a regular file".into())
            };
            out.push((rel_path, kind));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out.into_iter().map(|(_, e)| e).collect()
}

/// Send every regular file as `ArtifactChunk`
/// frames of at most `ARTIFACT_CHUNK_BYTES`, written straight to the stream
/// (backpressure: one chunk in memory at a time). A file that cannot be read,
/// or that would exceed `total_cap` (0 = no cap), is reported with
/// `ArtifactSkipped` so the host fails the run instead of keeping a partial
/// output.
#[cfg(target_os = "linux")]
async fn send_artifacts_chunked<W>(dirs: &[String], total_cap: u64, wr: &mut W)
where
    W: AsyncWrite + Unpin,
{
    let mut total: u64 = 0;
    let mut buf = vec![0u8; sandbox_vm_protocol::ARTIFACT_CHUNK_BYTES];
    for (mount_index, dir) in dirs.iter().enumerate() {
        let mount_index = mount_index as u32;
        let root = std::path::Path::new(dir);
        if !root.is_dir() {
            continue;
        }
        // File-system work runs on the blocking pool, never on a runtime
        // worker (the walk here, each chunk read below).
        let walk_root = root.to_path_buf();
        let entries = match tokio::task::spawn_blocking(move || list_artifact_entries(&walk_root)).await {
            Ok(entries) => entries,
            Err(e) => vec![ArtifactEntry::Unsendable(String::new(), format!("could not list the dir: {e}"))],
        };
        for entry in entries {
            let (path, rel_path) = match entry {
                ArtifactEntry::Dir(rel_path) => {
                    let f = Frame::ArtifactDir { mount_index, rel_path };
                    if wr.write_all(&encode(&f)).await.is_err() {
                        return;
                    }
                    continue;
                }
                ArtifactEntry::Symlink(rel_path, target) => {
                    let f = Frame::ArtifactSymlink { mount_index, rel_path, target };
                    if wr.write_all(&encode(&f)).await.is_err() {
                        return;
                    }
                    continue;
                }
                ArtifactEntry::Unsendable(rel_path, reason) => {
                    let f = Frame::ArtifactSkipped { mount_index, rel_path, reason };
                    if wr.write_all(&encode(&f)).await.is_err() {
                        return;
                    }
                    continue;
                }
                ArtifactEntry::File(path, rel_path) => (path, rel_path),
            };
            let skipped = |reason: String| Frame::ArtifactSkipped {
                mount_index,
                rel_path: rel_path.clone(),
                reason,
            };
            // Open (and size) the file on the blocking pool too.
            let opened = {
                let path = path.clone();
                tokio::task::spawn_blocking(move || {
                    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    (len, std::fs::File::open(&path))
                })
                .await
            };
            let (len, opened) = match opened {
                Ok(t) => t,
                Err(e) => {
                    let _ = wr.write_all(&encode(&skipped(format!("open: {e}")))).await;
                    return;
                }
            };
            if total_cap > 0 && total.saturating_add(len) > total_cap {
                let f = skipped(format!("over the total artifact cap of {total_cap} bytes"));
                if wr.write_all(&encode(&f)).await.is_err() {
                    return;
                }
                continue;
            }
            // A host that went away stops the copy-back at the next write (at
            // most one chunk later).
            let mut file = match opened {
                Ok(f) => f,
                Err(e) => {
                    if wr.write_all(&encode(&skipped(format!("open: {e}")))).await.is_err() {
                        return;
                    }
                    continue;
                }
            };
            let mut offset: u64 = 0;
            loop {
                // One chunk read on the blocking pool; the file and buffer
                // move there and back.
                let (read, f, b) = match tokio::task::spawn_blocking(move || {
                    let r = std::io::Read::read(&mut file, &mut buf);
                    (r, file, buf)
                })
                .await
                {
                    Ok(t) => t,
                    Err(e) => {
                        let _ = wr.write_all(&encode(&skipped(format!("read: {e}")))).await;
                        return;
                    }
                };
                file = f;
                buf = b;
                let n = match read {
                    Ok(n) => n,
                    Err(e) => {
                        let _ = wr.write_all(&encode(&skipped(format!("read: {e}")))).await;
                        break;
                    }
                };
                // An empty file is one empty chunk at offset 0 (the host
                // creates it); otherwise stop at EOF.
                if n == 0 && offset > 0 {
                    break;
                }
                let chunk = Frame::ArtifactChunk {
                    mount_index,
                    rel_path: rel_path.clone(),
                    offset,
                    data: buf[..n].to_vec(),
                };
                if wr.write_all(&encode(&chunk)).await.is_err() {
                    return;
                }
                offset += n as u64;
                total = total.saturating_add(n as u64);
                if n == 0 {
                    break;
                }
            }
        }
    }
}

/// Live-progress FIFO, guest side. Mirrors the Linux host's `ProgressFifo`:
/// create the named pipe at the fixed guest-local path, open the read end
/// `O_RDWR|O_NONBLOCK` (so it never sees EOF between the sandbox's writes), and
/// forward each newline-trimmed line as a `Frame::Progress` to the
/// connection's writer channel. Drop signals stop, aborts the reader, and
/// unlinks the FIFO so no orphaned reader survives the exec.
#[cfg(target_os = "linux")]
struct ProgressFifo {
    stop: Arc<std::sync::atomic::AtomicBool>,
    reader: Option<tokio::task::JoinHandle<()>>,
}

#[cfg(target_os = "linux")]
impl ProgressFifo {
    fn spawn(tx: mpsc::UnboundedSender<Frame>) -> std::io::Result<Self> {
        use std::os::fd::FromRawFd;

        let c_path = std::ffi::CString::new(PROGRESS_GUEST_FIFO_PATH).unwrap();
        // Remove any stale FIFO at the fixed path (prior exec on this guest).
        let _ = std::fs::remove_file(PROGRESS_GUEST_FIFO_PATH);
        // SAFETY: c_path is a valid NUL-terminated CString for the call.
        if unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // O_RDWR keeps our own writer ref so the read end never hits EOF while
        // the sandbox opens/closes the FIFO per `echo`. O_NONBLOCK + AsyncFd =
        // readiness-driven async reads. O_CLOEXEC so the fd doesn't leak into
        // the bwrap child (it reaches the FIFO via the bind, not an inherited fd).
        // SAFETY: c_path valid; -1 on error (checked).
        let fd = unsafe {
            libc::open(
                c_path.as_ptr(),
                libc::O_RDWR | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            let err = std::io::Error::last_os_error();
            let _ = std::fs::remove_file(PROGRESS_GUEST_FIFO_PATH);
            return Err(err);
        }

        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stop_reader = stop.clone();
        // SAFETY: we just opened `fd` (O_CLOEXEC, O_NONBLOCK) and own it; the
        // reader task closes it via AsyncFd::Drop on exit.
        let owned = unsafe { std::os::fd::OwnedFd::from_raw_fd(fd) };
        let reader = tokio::spawn(progress_reader_loop(owned, tx, stop_reader));
        Ok(Self {
            stop,
            reader: Some(reader),
        })
    }
}

#[cfg(target_os = "linux")]
impl Drop for ProgressFifo {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(h) = self.reader.take() {
            h.abort();
        }
        let _ = std::fs::remove_file(PROGRESS_GUEST_FIFO_PATH);
    }
}

/// Read newline-delimited progress lines off the FIFO fd and forward each
/// (newline-trimmed) line as a `Frame::Progress`. A
/// single FIFO `write()` under `PROGRESS_MAX_LINE_BYTES` (= PIPE_BUF) is atomic,
/// so lines don't interleave; over-cap lines are DROPPED. Ends when `stop` is
/// set (aborted on drop) or `tx` is closed.
#[cfg(target_os = "linux")]
async fn progress_reader_loop(
    fd: std::os::fd::OwnedFd,
    tx: mpsc::UnboundedSender<Frame>,
    stop: Arc<std::sync::atomic::AtomicBool>,
) {
    use std::os::fd::AsRawFd;
    use tokio::io::unix::AsyncFd;

    let async_fd = match AsyncFd::new(fd) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("agent: progress AsyncFd::new failed: {e}");
            return;
        }
    };

    let mut pending: Vec<u8> = Vec::with_capacity(256);
    let mut overflowed = false;
    let mut buf = [0u8; 8 * 1024];

    loop {
        if stop.load(std::sync::atomic::Ordering::SeqCst) || tx.is_closed() {
            return;
        }
        let mut guard = match async_fd.readable().await {
            Ok(g) => g,
            Err(_) => return,
        };
        loop {
            let raw = async_fd.get_ref().as_raw_fd();
            // SAFETY: raw is valid (owned by async_fd); buf is a valid buffer.
            let n = unsafe {
                libc::read(raw, buf.as_mut_ptr() as *mut libc::c_void, buf.len())
            };
            if n > 0 {
                for &byte in &buf[..n as usize] {
                    if byte == b'\n' {
                        if !overflowed && !pending.is_empty() {
                            let _ = tx.send(Frame::Progress(std::mem::take(&mut pending)));
                        } else {
                            pending.clear();
                        }
                        overflowed = false;
                    } else if !overflowed {
                        pending.push(byte);
                        if pending.len() > PROGRESS_MAX_LINE_BYTES {
                            pending.clear();
                            overflowed = true;
                        }
                    }
                }
                continue;
            }
            if n == 0 {
                guard.clear_ready();
                break;
            }
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            if errno == libc::EAGAIN || errno == libc::EWOULDBLOCK {
                guard.clear_ready();
                break;
            }
            if errno == libc::EINTR {
                continue;
            }
            tracing::warn!(
                "agent: progress read failed: {}; ending",
                std::io::Error::from_raw_os_error(errno)
            );
            return;
        }
    }
}

/// One-time cgroup v2 setup: ensure cgroup2 is mounted and enable the
/// controllers child cgroups will use. Best-effort — if it fails, per-exec
/// cgroup limits are simply unavailable and prlimit (in the bwrap argv) does
/// the enforcement, exactly like the Linux host's `CgroupMode::None` path.
#[cfg(target_os = "linux")]
fn cgroup_init() {
    if !std::path::Path::new("/sys/fs/cgroup/cgroup.controllers").exists() {
        let _ = std::fs::create_dir_all("/sys/fs/cgroup");
        mount_fs("cgroup2", "/sys/fs/cgroup", "cgroup2", 0, None);
    }
    // The agent (in the root cgroup) is exempt from the no-internal-processes
    // rule, so enabling subtree_control on the root is allowed.
    if let Err(e) = std::fs::write("/sys/fs/cgroup/cgroup.subtree_control", "+memory +pids +cpu") {
        tracing::warn!(
            "agent: enabling cgroup controllers failed: {e}; per-exec cgroup \
             limits unavailable (the prlimit backstop still applies)"
        );
    }
}

/// Per-exec cgroup v2 scope under the guest root, mirroring the host's
/// `CgroupScope`. Drop removes it (empty cgroups rmdir cleanly).
#[cfg(target_os = "linux")]
struct GuestCgroup {
    path: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
impl GuestCgroup {
    fn create(request_id: u64, limits: &CgroupLimits) -> std::io::Result<Self> {
        let path = std::path::PathBuf::from(format!("/sys/fs/cgroup/sb-{request_id}"));
        std::fs::create_dir(&path)?;
        // Per-controller writes are best-effort: a controller the guest kernel
        // didn't build still leaves the others enforcing. We do NOT fail the
        // whole call on a single controller miss, but every miss is logged so a
        // silently-unenforced limit (e.g. memory.max not applied) is detectable
        // rather than invisible.
        let write_limit = |attr: &str, value: &str| {
            if let Err(e) = std::fs::write(path.join(attr), value) {
                tracing::warn!(
                    "agent: cgroup {attr} not enforced for sb-{request_id}: {e} \
                     (controller likely unavailable in guest kernel)"
                );
            }
        };
        write_limit("memory.max", &limits.memory_max_bytes.to_string());
        write_limit("memory.swap.max", &limits.memory_swap_max_bytes.to_string());
        write_limit("pids.max", &limits.pids_max.to_string());
        write_limit("cpu.max", &limits.cpu_max);
        Ok(Self { path })
    }

    fn attach(&self, pid: u32) {
        if let Err(e) = std::fs::write(self.path.join("cgroup.procs"), pid.to_string()) {
            tracing::warn!("agent: cgroup attach pid {pid} failed: {e}");
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for GuestCgroup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.path);
    }
}

/// Pipe the seccomp BPF to a fd in the bwrap child, mirroring the Linux host's
/// `SeccompPipe`: create a pipe, write the bytes from a task, and `dup2` the
/// read end to `target_fd` (clearing `FD_CLOEXEC` so it survives execve into
/// bwrap, which reads it via `--seccomp <target_fd>`). Returns the parent's
/// read fd so the caller can close it after spawn.
#[cfg(target_os = "linux")]
fn install_seccomp(
    cmd: &mut Command,
    target_fd: i32,
    bpf: Arc<Vec<u8>>,
) -> std::io::Result<(i32, tokio::task::JoinHandle<()>)> {
    let mut fds: [libc::c_int; 2] = [0; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let read_fd = fds[0];
    let write_fd = fds[1];

    // Write the BPF from a task (it may exceed the pipe buffer, so it MUST run
    // concurrently with the bwrap child that drains the read end — we can't
    // await it before spawn or a >pipe-buffer filter would deadlock). The
    // JoinHandle is returned so the caller awaits it during connection cleanup
    // instead of leaking a detached task whose truncation error would go
    // unobserved.
    let writer = tokio::spawn(async move {
        let bytes: &[u8] = bpf.as_ref();
        let mut off = 0;
        while off < bytes.len() {
            let n = unsafe {
                libc::write(
                    write_fd,
                    bytes[off..].as_ptr() as *const libc::c_void,
                    bytes.len() - off,
                )
            };
            if n > 0 {
                off += n as usize;
                continue;
            }
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            if n < 0 && (errno == libc::EINTR || errno == libc::EAGAIN) {
                continue;
            }
            break;
        }
        unsafe { libc::close(write_fd) };
        if off < bytes.len() {
            tracing::error!(written = off, expected = bytes.len(), "agent: seccomp BPF write truncated");
        }
    });

    // SAFETY: dup2/fcntl are async-signal-safe; `read_fd` is valid through spawn.
    unsafe {
        cmd.pre_exec(move || {
            if libc::dup2(read_fd, target_fd) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let flags = libc::fcntl(target_fd, libc::F_GETFD);
            if flags < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(target_fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok((read_fd, writer))
}

/// Resolve when the host closes the control connection (read half hits EOF) or
/// errors — i.e. its budget ran out or the run was cancelled. The host sends
/// only the `Exec` frame,
/// so any further read is EOF on disconnect.
#[cfg(target_os = "linux")]
async fn wait_host_eof<R: AsyncReadExt + Unpin>(rd: &mut R) {
    let mut b = [0u8; 256];
    loop {
        match rd.read(&mut b).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {} // unexpected extra data from the host; ignore
        }
    }
}

/// Stream a child pipe into protocol frames.
#[cfg(target_os = "linux")]
async fn pump<R: AsyncReadExt + Unpin>(mut reader: R, tx: mpsc::UnboundedSender<Frame>, is_stdout: bool) {
    let mut buf = [0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                let frame = if is_stdout { Frame::Stdout(chunk) } else { Frame::Stderr(chunk) };
                if tx.send(frame).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use sandbox_vm_protocol::{Decoder, Frame, PROTOCOL_VERSION};
    use tokio::io::{duplex, AsyncWriteExt};

    /// Decode every frame the copy-back sender wrote and reassemble the files.
    fn reassemble(bytes: &[u8]) -> (std::collections::BTreeMap<(u32, String), Vec<u8>>, Vec<String>) {
        let mut d = Decoder::new();
        d.feed(bytes);
        let mut files = std::collections::BTreeMap::new();
        let mut skipped = Vec::new();
        while let Some(frame) = d.next_frame().expect("decode") {
            match frame {
                Frame::ArtifactChunk { mount_index, rel_path, offset, data } => {
                    let f: &mut Vec<u8> = files.entry((mount_index, rel_path)).or_default();
                    assert_eq!(f.len() as u64, offset, "chunks arrive in order");
                    assert!(data.len() <= sandbox_vm_protocol::ARTIFACT_CHUNK_BYTES);
                    f.extend_from_slice(&data);
                }
                Frame::ArtifactSkipped { rel_path, .. } => skipped.push(rel_path),
                Frame::ArtifactDir { mount_index, rel_path } => {
                    files.insert((mount_index, format!("{rel_path}/")), Vec::new());
                }
                Frame::ArtifactSymlink { mount_index, rel_path, target } => {
                    files.insert((mount_index, format!("{rel_path}@")), target.into_bytes());
                }
                other => panic!("unexpected frame {other:?}"),
            }
        }
        (files, skipped)
    }

    #[tokio::test]
    async fn chunked_artifacts_round_trip_large_empty_and_nested_files() {
        let a = tempfile::tempdir().expect("tempdir");
        let b = tempfile::tempdir().expect("tempdir");
        let big: Vec<u8> = (0..(5 * 1024 * 1024 + 7)).map(|i| (i % 251) as u8).collect();
        std::fs::write(a.path().join("model.bin"), &big).unwrap();
        std::fs::write(a.path().join("empty.csv"), b"").unwrap();
        std::fs::create_dir_all(b.path().join("x/y")).unwrap();
        std::fs::write(b.path().join("x/y/pred.csv"), b"id,p\n1,0.5\n").unwrap();
        std::os::unix::fs::symlink(a.path().join("model.bin"), a.path().join("link")).unwrap();
        std::fs::create_dir_all(a.path().join("checkpoints")).unwrap();
        std::os::unix::fs::symlink("/etc/hostname", a.path().join("outside")).unwrap();
        std::fs::write(b.path().join("back\\slash.csv"), b"kept").unwrap();
        let dirs = vec![
            a.path().to_string_lossy().into_owned(),
            b.path().to_string_lossy().into_owned(),
        ];
        let mut out: Vec<u8> = Vec::new();
        send_artifacts_chunked(&dirs, 0, &mut out).await;
        let (files, skipped) = reassemble(&out);
        assert!(skipped.is_empty(), "{skipped:?}");
        // Symlinks are sent as symlinks with their stored targets, unresolved.
        assert_eq!(files[&(0, "link@".to_string())], a.path().join("model.bin").to_string_lossy().as_bytes());
        assert_eq!(files[&(0, "outside@".to_string())], b"/etc/hostname");
        // 4 files (model.bin, empty.csv, x/y/pred.csv, back\\slash.csv), 2 symlinks
        // (link, outside) and the dirs `checkpoints/` (empty), `x/` and `x/y/`.
        assert_eq!(files.len(), 9, "{:?}", files.keys());
        assert!(files.contains_key(&(0, "checkpoints/".to_string())), "the empty dir is sent");
        assert!(files.contains_key(&(1, "x/y/".to_string())));
        assert_eq!(files[&(0, "model.bin".to_string())], big);
        assert!(files[&(0, "empty.csv".to_string())].is_empty());
        assert_eq!(files[&(1, "x/y/pred.csv".to_string())], b"id,p\n1,0.5\n");
        // A backslash is part of a Linux file name, not a separator.
        assert_eq!(files[&(1, "back\\slash.csv".to_string())], b"kept");
    }

    #[tokio::test]
    async fn chunked_artifacts_report_files_past_the_total_cap() {
        let a = tempfile::tempdir().expect("tempdir");
        std::fs::write(a.path().join("a.bin"), vec![1u8; 600]).unwrap();
        std::fs::write(a.path().join("b.bin"), vec![2u8; 600]).unwrap();
        let dirs = vec![a.path().to_string_lossy().into_owned()];
        let mut out: Vec<u8> = Vec::new();
        send_artifacts_chunked(&dirs, 1000, &mut out).await;
        let (files, skipped) = reassemble(&out);
        assert_eq!(files.len(), 1, "only the first file fits the cap");
        assert_eq!(skipped, vec!["b.bin".to_string()], "the other is reported, not dropped");
    }

    // ---- the exec path (handle_conn → handle_exec) ----

    /// Build an ExecRequest that runs `/bin/echo` directly (no bwrap, no
    /// rootfs) so the happy path is exercisable without a VM.
    fn echo_exec(argv: Vec<&str>) -> sandbox_vm_protocol::ExecRequest {
        sandbox_vm_protocol::ExecRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: 1,
            bwrap_path: "/bin/echo".into(),
            argv: argv.into_iter().map(String::from).collect(),
            timeout_ms: 60_000,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: vec![],
            artifacts: Default::default(),
        }
    }

    /// Drive one connection: send `Exec`, read frames until `ArtifactsDone`,
    /// THEN close the host writer. (Closing early would let the agent's
    /// host-EOF watch race the child and kill `/bin/echo` before it finishes —
    /// so we hold the writer open until the terminal frame arrives.)
    async fn run_exec(req: sandbox_vm_protocol::ExecRequest) -> Vec<Frame> {
        let (host_side, agent_side) = duplex(64 * 1024);
        let (mut host_rd, mut host_wr) = tokio::io::split(host_side);
        let agent_task = tokio::spawn(async move {
            let _ = handle_conn(agent_side, None).await;
        });

        host_wr
            .write_all(&encode(&Frame::Exec(req)))
            .await
            .expect("send exec");

        let mut decoder = Decoder::new();
        let mut collected = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            if collected.iter().any(|f| matches!(f, Frame::ArtifactsDone)) {
                break;
            }
            let n = host_rd.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                break; // agent closed early (e.g. it rejected the request)
            }
            decoder.feed(&buf[..n]);
            while let Ok(Some(f)) = decoder.next_frame() {
                collected.push(f);
            }
        }
        drop(host_wr);
        let _ = agent_task.await;
        collected
    }

    #[tokio::test]
    async fn exec_echo_streams_stdout_and_exit_zero() {
        let frames = run_exec(echo_exec(vec!["hello-exec"])).await;
        let stdout: Vec<u8> = frames
            .iter()
            .filter_map(|f| match f {
                Frame::Stdout(b) => Some(b.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(stdout, b"hello-exec\n", "unexpected stdout in {frames:?}");
        let exit = frames.iter().find_map(|f| match f {
            Frame::Exit(s) => Some(*s),
            _ => None,
        });
        assert_eq!(exit, Some(ExitStatus { code: 0, timed_out: false }));
        // No output dirs: the copy-back is just its end marker, after Exit.
        assert_eq!(frames.last(), Some(&Frame::ArtifactsDone), "{frames:?}");
    }

    #[tokio::test]
    async fn exec_rejects_protocol_version_mismatch_with_no_frames() {
        // A stale host sends a version this agent does not serve (missing,
        // earlier or newer); the agent must reject the exec and close WITHOUT
        // running the command or emitting any frame.
        for v in [0, 1, 2, 999] {
            let mut req = echo_exec(vec!["must-not-run"]);
            req.protocol_version = v;
            let frames = run_exec(req).await;
            assert!(frames.is_empty(), "version {v} must emit no frames, got {frames:?}");
        }
    }

    #[tokio::test]
    async fn exec_seccomp_requested_but_unavailable_fails_closed() {
        // The host requested seccomp (seccomp_fd set) but the guest's filter
        // failed to build (run_exec passes bpf=None). The agent must fail
        // CLOSED: emit a Stderr note + Exit{-1} and never run the command.
        let mut req = echo_exec(vec!["must-not-run"]);
        req.seccomp_fd = Some(10);
        let frames = run_exec(req).await;

        // A failure before the command runs is Exit(-1) followed by
        // ArtifactsDone, so the host reports the failure itself, not a
        // cut-off copy-back.
        let exit_at = frames.iter().position(|f| matches!(f, Frame::Exit(_))).expect("an Exit frame");
        assert_eq!(frames[exit_at], Frame::Exit(ExitStatus { code: -1, timed_out: false }));
        assert_eq!(frames.last(), Some(&Frame::ArtifactsDone), "{frames:?}");
        assert!(exit_at < frames.len() - 1);

        let stderr: Vec<u8> = frames
            .iter()
            .filter_map(|f| match f {
                Frame::Stderr(b) => Some(b.clone()),
                _ => None,
            })
            .flatten()
            .collect();
        let msg = String::from_utf8_lossy(&stderr);
        assert!(
            msg.contains("seccomp requested but the guest filter failed to build"),
            "expected fail-closed stderr, got {msg:?}"
        );
        assert!(
            !frames.iter().any(|f| matches!(f, Frame::Stdout(_))),
            "command must NOT have run"
        );
    }
}
