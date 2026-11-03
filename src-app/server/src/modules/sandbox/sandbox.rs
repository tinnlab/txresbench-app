//! bwrap invocation + always-on hardening for the analysis sandbox.
//!
//! Ported from ziee `code_sandbox/sandbox.rs` (the security core is KEPT
//! verbatim where it matters), collapsed to Linux-only + single-rootfs +
//! companion-driven (no lit/progress/workflow/MCP/attachment coupling — DEC-3).
//! The argv BUILDER is OS-independent (so it compiles + unit-tests everywhere);
//! only the execution path is `#[cfg(target_os = "linux")]`.

use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use std::os::fd::RawFd;
#[cfg(target_os = "linux")]
use std::process::Stdio;
#[cfg(target_os = "linux")]
use std::sync::Arc;
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use tokio::io::{AsyncRead, AsyncReadExt};
#[cfg(target_os = "linux")]
use tokio::process::Command;
#[cfg(target_os = "linux")]
use tokio::time::timeout;

use ziee_core::AppError;

use super::settings::SandboxResourceLimits;
use super::types::{HardeningCapabilities, MountMode, PidNsMode, SandboxContext, ExtraMount};
#[cfg(target_os = "linux")]
use super::types::{CgroupMode, SeccompMode};

/// Output of a single bwrap invocation. stdout/stderr are each capped at
/// [`OUTPUT_CAP_BYTES`]; the child is NOT killed at the cap (it can finish),
/// only truncated in the capture.
#[derive(Debug, Clone)]
pub struct SandboxRunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub duration_ms: u64,
    pub timed_out: bool,
}

/// Per-call output cap (1 MiB).
pub const OUTPUT_CAP_BYTES: usize = 1024 * 1024;

/// Shell / runtime config files an analysis command must NOT read or write —
/// masked with an empty regular file so reads return empty + writes fail EROFS.
const DANGEROUS_DOTFILES: &[&str] = &[
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".Rprofile",
    ".Renviron",
];

pub(crate) const SYNTHETIC_PASSWD: &str =
    "analyst:x:1001:1001:Analyst:/home/analyst:/bin/bash\n";
pub(crate) const SYNTHETIC_GROUP: &str = "analyst:x:1001:\n";

/// The in-sandbox home (workspace bind + chdir).
const SANDBOX_HOME: &str = "/home/analyst";

// ─────────────────────────── argv builder (OS-independent) ───────────────────

/// The fixed in-sandbox path a host progress FIFO binds at, exported to the
/// analysis script as `$CYTO_PROGRESS_FIFO` (ITEM-5). Under `/tmp` (a tmpfs the
/// bind is applied over, in argv order).
pub const PROGRESS_FIFO_SANDBOX_PATH: &str = "/tmp/.cyto_progress";

/// Build the full bwrap argv: hardening prefix + prlimit tail + `/bin/bash -lc
/// <cmd>`. `rootfs_dir` is the squashfuse mount dir (contains `usr/`).
/// `progress_fifo_src` (when `Some`) binds a host FIFO at
/// [`PROGRESS_FIFO_SANDBOX_PATH`] + exports `$CYTO_PROGRESS_FIFO`; `None` yields
/// a byte-identical argv to the no-FIFO case.
#[allow(clippy::too_many_arguments)]
pub(crate) fn build_bwrap_argv(
    caps: &HardeningCapabilities,
    ctx: &SandboxContext,
    rootfs_dir: &Path,
    user_cmd: &str,
    passwd_path: &Path,
    group_path: &Path,
    mask_path: &Path,
    seccomp_fd: Option<i32>,
    limits: &SandboxResourceLimits,
    extra_mounts: &[ExtraMount],
    progress_fifo_src: Option<&str>,
) -> Vec<String> {
    let rootfs = rootfs_dir.to_str().unwrap_or_default();
    let workspace = ctx.workspace.to_string_lossy().to_string();

    // SECURITY: --clearenv wipes the server's entire environment (DATABASE_URL,
    // JWT secret, every *_API_KEY) before any --setenv. Network egress is BLOCKED
    // (`--unshare-net`, FB MEDIUM-1 / user decision): single-cell analysis needs
    // no runtime network — the rootfs is pre-provisioned at build time — so the
    // sandbox has no loopback (no reach to the embedded Postgres / app API, no
    // SSRF) and no outbound path even if --clearenv were ever bypassed.
    let mut argv: Vec<String> = vec![
        "--clearenv".into(),
        "--unshare-user".into(),
        "--uid".into(),
        "1001".into(),
        "--gid".into(),
        "1001".into(),
        "--unshare-uts".into(),
        "--unshare-ipc".into(),
        "--unshare-cgroup-try".into(),
        "--unshare-net".into(),
        "--new-session".into(),
        "--die-with-parent".into(),
        // ROOTFS is bound READ-ONLY.
        "--ro-bind".into(),
        format!("{rootfs}/usr"),
        "/usr".into(),
        // CA certs only (LOW-1): never expose /etc/ssl/private (host TLS keys).
        "--ro-bind-try".into(),
        "/etc/ssl/certs".into(),
        "/etc/ssl/certs".into(),
        "--ro-bind-try".into(),
        format!("{rootfs}/etc/ssl/certs"),
        "/etc/ssl/certs".into(),
        // resolv.conf is harmless with --unshare-net (no resolver reachable); kept
        // ro-bind-try so any tool that stats it doesn't error.
        "--ro-bind-try".into(),
        "/etc/resolv.conf".into(),
        "/etc/resolv.conf".into(),
        "--ro-bind-try".into(),
        format!("{rootfs}/etc/resolv.conf"),
        "/etc/resolv.conf".into(),
        // Debian alternatives (BLAS/LAPACK symlink chain) + R config.
        "--ro-bind-try".into(),
        format!("{rootfs}/etc/alternatives"),
        "/etc/alternatives".into(),
        "--ro-bind-try".into(),
        format!("{rootfs}/etc/R"),
        "/etc/R".into(),
        // The scientific Python stack lives under `/opt`: a uv venv at `/opt/venv`
        // (the schema-5 OCI env-image) or a conda env at `/opt/conda` (legacy
        // schema-2 embedded rootfs, ITEM-11). Bind it read-only so `python3`
        // (via the PATH prefix below, which lists BOTH bins) resolves to the
        // science interpreter, not the base `/usr/local/bin/python3`. `-try`: a
        // rootfs without /opt (schema 1 / minimal) still binds cleanly.
        "--ro-bind-try".into(),
        format!("{rootfs}/opt"),
        "/opt".into(),
        "--ro-bind".into(),
        passwd_path.display().to_string(),
        "/etc/passwd".into(),
        "--ro-bind".into(),
        group_path.display().to_string(),
        "/etc/group".into(),
        "--symlink".into(),
        "usr/bin".into(),
        "/bin".into(),
        "--symlink".into(),
        "usr/sbin".into(),
        "/sbin".into(),
        "--symlink".into(),
        "usr/lib".into(),
        "/lib".into(),
        "--symlink".into(),
        "usr/lib64".into(),
        "/lib64".into(),
        "--dev".into(),
        "/dev".into(),
        "--tmpfs".into(),
        "/tmp".into(),
        "--bind".into(),
        workspace,
        SANDBOX_HOME.into(),
        "--chdir".into(),
        SANDBOX_HOME.into(),
        "--setenv".into(),
        "HOME".into(),
        SANDBOX_HOME.into(),
        "--setenv".into(),
        "USER".into(),
        "analyst".into(),
        "--setenv".into(),
        "PATH".into(),
        // Conda env first (the scientific Python stack), then the system dirs.
        "/opt/venv/bin:/opt/conda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
        "--setenv".into(),
        "LANG".into(),
        "C.UTF-8".into(),
        "--setenv".into(),
        "LC_ALL".into(),
        "C.UTF-8".into(),
        "--setenv".into(),
        "TERM".into(),
        "dumb".into(),
        // BLAS/LAPACK + OpenMP: one thread by default (a 64-core auto-detect
        // regularly loses against RLIMIT_NPROC in a sandbox). Covers R + numpy.
        "--setenv".into(),
        "OPENBLAS_NUM_THREADS".into(),
        "1".into(),
        "--setenv".into(),
        "OMP_NUM_THREADS".into(),
        "1".into(),
        "--setenv".into(),
        "MKL_NUM_THREADS".into(),
        "1".into(),
    ];

    // Dotfile masks.
    let mask_src = mask_path.display().to_string();
    for dotfile in DANGEROUS_DOTFILES {
        argv.push("--ro-bind".into());
        argv.push(mask_src.clone());
        argv.push(format!("{SANDBOX_HOME}/{dotfile}"));
    }

    // PID namespace + /proc handling. Only Strict is ever reached — the probe
    // (probes::pidns_accept) REFUSES any non-strict mode and self-disables the
    // sandbox (FB HIGH-1), so no argv path binds the HOST /proc. The non-strict
    // arms are defensive no-ops: they intentionally do NOT `--dev-bind /proc`
    // (that would expose /proc/<server_pid>/environ = secret exfil).
    match caps.pid_namespace {
        PidNsMode::Strict => {
            argv.push("--unshare-pid".into());
            argv.push("--as-pid-1".into());
            argv.push("--proc".into());
            argv.push("/proc".into());
        }
        // Never reached (probe refuses these); no host /proc bind, ever.
        PidNsMode::DevBindFallback | PidNsMode::Disabled => {}
    }

    // /proc-file masks (defense-in-depth in Strict; critical in DevBindFallback).
    for masked in ["/proc/sysrq-trigger", "/proc/kcore", "/proc/kallsyms", "/proc/kmsg"] {
        argv.push("--ro-bind".into());
        argv.push("/dev/null".into());
        argv.push(masked.into());
    }

    // Extra input/output mounts (count matrices, BAMs, result dirs). ReadOnly →
    // --ro-bind-try, ReadWrite → --bind. Placed after the hardening prefix, and
    // BEFORE the `--` terminator, so they can never shadow the hardening flags.
    for m in extra_mounts {
        let host = m.host_path.display().to_string();
        match m.mode {
            MountMode::ReadOnly => {
                argv.push("--ro-bind-try".into());
                argv.push(host);
                argv.push(m.sandbox_path.clone());
            }
            MountMode::ReadWrite => {
                argv.push("--bind".into());
                argv.push(host);
                argv.push(m.sandbox_path.clone());
            }
        }
    }

    // Optional progress FIFO: bind the host FIFO over a tmpfs path (applied in
    // argv order, AFTER `--tmpfs /tmp`) + export its path. The analysis script
    // writes structured `phase|pct|message` lines the streaming runner drains
    // (ITEM-5). `None` → this block is skipped (byte-identical argv).
    if let Some(fifo) = progress_fifo_src {
        argv.push("--bind".into());
        argv.push(fifo.to_string());
        argv.push(PROGRESS_FIFO_SANDBOX_PATH.into());
        argv.push("--setenv".into());
        argv.push("CYTO_PROGRESS_FIFO".into());
        argv.push(PROGRESS_FIFO_SANDBOX_PATH.into());
    }

    // Optional seccomp filter on a well-known fd we dup2 to.
    if let Some(fd) = seccomp_fd {
        argv.push("--seccomp".into());
        argv.push(fd.to_string());
    }

    // CVE-2024-32462: terminator BEFORE the sub-command. Everything after is data.
    argv.push("--".into());

    // prlimit applies rlimits to the workload (not bwrap's helper forks).
    argv.push("/usr/bin/prlimit".into());
    argv.push(format!("--nproc={}", limits.nproc_max));
    argv.push(format!("--as={}", limits.address_space_bytes));
    argv.push(format!("--fsize={}", limits.fsize_bytes));
    argv.push(format!("--nofile={}", limits.nofile_max));
    argv.push("--core=0".into());
    argv.push(format!("--cpu={}", limits.cpu_secs_max));
    argv.push("--".into());
    argv.push("/bin/bash".into());
    argv.push("-lc".into());
    argv.push(user_cmd.to_string());

    argv
}

// ─────────────────── synthetic identity (OS-independent) ──────────────────

pub(crate) struct SyntheticIdentity {
    passwd: PathBuf,
    group: PathBuf,
    /// Empty REGULAR file (NOT /dev/null — a char device on a `nodev` ro-bind
    /// returns EACCES when bash sources a profile) used as the dotfile-mask bind.
    mask: PathBuf,
}

impl SyntheticIdentity {
    /// Ensure the synthetic passwd/group/empty files exist under
    /// `<workspace_root>/identity/` (OUTSIDE the per-job workspace bind, so the
    /// sandboxed shell cannot tamper with them). Idempotent.
    pub(crate) fn ensure(workspace_root: &Path) -> Result<Self, AppError> {
        let dir = workspace_root.join("identity");
        std::fs::create_dir_all(&dir).map_err(|e| identity_err("mkdir identity", e))?;
        let passwd = dir.join("passwd");
        let group = dir.join("group");
        let mask = dir.join("empty");
        write_if_changed(&passwd, SYNTHETIC_PASSWD).map_err(|e| identity_err("write passwd", e))?;
        write_if_changed(&group, SYNTHETIC_GROUP).map_err(|e| identity_err("write group", e))?;
        write_if_changed(&mask, "").map_err(|e| identity_err("write empty mask", e))?;
        Ok(Self { passwd, group, mask })
    }

    pub(crate) fn passwd(&self) -> &Path {
        &self.passwd
    }
    pub(crate) fn group(&self) -> &Path {
        &self.group
    }
    pub(crate) fn mask(&self) -> &Path {
        &self.mask
    }
}

fn identity_err(what: &str, e: std::io::Error) -> AppError {
    AppError::new(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "WORKSPACE_INIT_FAILED",
        format!("{what}: {e}"),
    )
}

fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    match std::fs::read_to_string(path) {
        Ok(existing) if existing == content => Ok(()),
        _ => std::fs::write(path, content),
    }
}

// ─────────────────────────── Linux execution path ───────────────────────────

/// Per-call seccomp pipe (bytes precompiled at boot).
#[cfg(target_os = "linux")]
pub(crate) struct SeccompPipe {
    read_fd: RawFd,
    target_fd: i32,
}

#[cfg(target_os = "linux")]
impl SeccompPipe {
    fn install(bpf: Arc<Vec<u8>>) -> Result<Self, AppError> {
        let mut fds: [libc::c_int; 2] = [0; 2];
        let ret = unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) };
        if ret < 0 {
            return Err(AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "SECCOMP_PIPE_FAILED",
                format!("pipe2: {}", std::io::Error::last_os_error()),
            ));
        }
        let read_fd = fds[0];
        let write_fd = fds[1];
        let total = bpf.len();
        tokio::spawn(async move {
            let bytes: &[u8] = bpf.as_ref();
            let mut off = 0usize;
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
            if off < total {
                tracing::error!(written = off, expected = total, "sandbox: seccomp BPF write truncated — the call WILL fail");
            }
        });
        Ok(Self { read_fd, target_fd: 7 })
    }

    fn read_fd(&self) -> RawFd {
        self.read_fd
    }
    /// The fd number the child receives via `dup2` (the compiled-BPF pipe end) —
    /// the number the argv's `--seccomp <fd>` must name. `pub(crate)` so the
    /// stacked run seam builds its argv with the same fd the shared spawn pipes
    /// the filter into (one seccomp plumbing, never a second).
    pub(crate) fn target_fd(&self) -> i32 {
        self.target_fd
    }
}

#[cfg(target_os = "linux")]
impl Drop for SeccompPipe {
    fn drop(&mut self) {
        // The read end is dup2'd into the child; close our copy.
        unsafe { libc::close(self.read_fd) };
    }
}

/// Shared per-run setup — the pieces both the batch and streaming paths need:
/// synthetic identity, a per-run cgroup scope, and the seccomp pipe. On the
/// streaming path this is MOVED into the executor's guard box so its Drop (cgroup
/// scope removal + seccomp fd close) outlives the child (DEC-F).
#[cfg(target_os = "linux")]
pub(crate) struct SandboxSetup {
    pub(crate) synthetic: SyntheticIdentity,
    pub(crate) cgroup_scope: Option<super::cgroup::CgroupScope>,
    pub(crate) seccomp_pipe: Option<SeccompPipe>,
}

#[cfg(target_os = "linux")]
impl SandboxSetup {
    /// Build the identity + cgroup scope + seccomp pipe for one run. Fails only
    /// on a hard identity/seccomp error; a cgroup-create failure degrades to
    /// rlimits-only (logged), never aborting the run.
    pub(crate) fn prepare(
        state: &super::config::SandboxState,
        ctx: &SandboxContext,
        limits: &SandboxResourceLimits,
        caps: &HardeningCapabilities,
    ) -> Result<Self, AppError> {
        use super::cgroup::CgroupScope;
        let synthetic = SyntheticIdentity::ensure(&state.workspace_root)?;
        let cgroup_scope = match &caps.cgroup {
            CgroupMode::Delegated(parent) => CgroupScope::create(parent, ctx.job_id, limits)
                .map_err(|e| {
                    tracing::warn!("cgroup scope creation failed: {e}; continuing without cgroup");
                    e
                })
                .ok(),
            CgroupMode::None => None,
        };
        let seccomp_pipe = match &caps.seccomp {
            SeccompMode::Loaded(bpf) => Some(SeccompPipe::install(bpf.clone())?),
            SeccompMode::NotLinked | SeccompMode::Disabled => None,
        };
        Ok(Self { synthetic, cgroup_scope, seccomp_pipe })
    }
}

/// Build the argv, configure the `Command` (piped stdio + kill_on_drop + seccomp
/// pre_exec), spawn bwrap, and attach the child to the cgroup scope. Shared by
/// the batch (`run_in_sandbox`) and streaming (`streaming::run_analysis_streaming`)
/// paths. The caller owns the returned live `Child` (and the `setup` guards).
#[cfg(target_os = "linux")]
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_bwrap_child(
    setup: &SandboxSetup,
    caps: &HardeningCapabilities,
    ctx: &SandboxContext,
    rootfs_dir: &Path,
    command: &str,
    limits: &SandboxResourceLimits,
    extra_mounts: &[ExtraMount],
    progress_fifo_src: Option<&str>,
) -> Result<tokio::process::Child, AppError> {
    // Guard a non-UTF8 rootfs path: build_bwrap_argv uses `to_str().unwrap_or_default()`,
    // so an empty string would make `<rootfs>/usr` == `/usr` and bind the HOST
    // /usr into the sandbox. Refuse rather than silently escape. [blind-audit LOW]
    if rootfs_dir.to_str().is_none() {
        return Err(AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "ROOTFS_PATH_INVALID",
            "the rootfs mount path is not valid UTF-8; refusing to build the sandbox",
        ));
    }

    let argv = build_bwrap_argv(
        caps,
        ctx,
        rootfs_dir,
        command,
        setup.synthetic.passwd(),
        setup.synthetic.group(),
        setup.synthetic.mask(),
        setup.seccomp_pipe.as_ref().map(|p| p.target_fd()),
        limits,
        extra_mounts,
        progress_fifo_src,
    );

    spawn_argv_child(setup, caps, argv)
}

/// Spawn bwrap with an ALREADY-BUILT argv: the stdio/kill_on_drop/seccomp-dup2/
/// cgroup-attach plumbing every argv path shares. The stacked run seam
/// (`service::run_method_in_stack`) builds its argv through
/// `stack::build_stacked_bwrap_argv` and comes here — the ONE implementation of
/// the spawn mechanics, so a hardening change can never reach only one argv
/// path (INV-5 / TEST-02's no-second-copy proof).
#[cfg(target_os = "linux")]
pub(crate) fn spawn_argv_child(
    setup: &SandboxSetup,
    caps: &HardeningCapabilities,
    argv: Vec<String>,
) -> Result<tokio::process::Child, AppError> {
    let mut cmd = Command::new(&caps.bwrap_path);
    cmd.args(&argv);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    if let Some(pipe) = setup.seccomp_pipe.as_ref() {
        let source_fd = pipe.read_fd();
        let target_fd = pipe.target_fd();
        // SAFETY: dup2 + fcntl are async-signal-safe; no allocation / locks.
        unsafe {
            cmd.pre_exec(move || {
                if libc::dup2(source_fd, target_fd as RawFd) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let flags = libc::fcntl(target_fd as RawFd, libc::F_GETFD);
                if flags < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(target_fd as RawFd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    let child = cmd.spawn().map_err(|e| {
        AppError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "BWRAP_SPAWN_FAILED",
            format!("failed to spawn bwrap: {e}"),
        )
    })?;

    if let Some(scope) = setup.cgroup_scope.as_ref() {
        if let Some(pid) = child.id() {
            if let Err(e) = scope.attach_pid(pid) {
                tracing::warn!("cgroup attach_pid({pid}) failed: {e}");
            }
        }
    }

    Ok(child)
}

/// Run a shell command inside the bwrap-isolated analysis sandbox (BATCH path —
/// capture stdout/stderr + return; the REST `/sandbox/execute` consumer). The
/// streaming jobs path uses [`SandboxSetup::prepare`] + [`spawn_bwrap_child`]
/// directly and drives the child itself.
#[cfg(target_os = "linux")]
pub async fn run_in_sandbox(
    state: &super::config::SandboxState,
    ctx: &SandboxContext,
    rootfs_dir: &Path,
    command: &str,
    timeout_secs: Option<u64>,
    limits: &SandboxResourceLimits,
    extra_mounts: &[ExtraMount],
    caps: &HardeningCapabilities,
) -> Result<SandboxRunResult, AppError> {
    let setup = SandboxSetup::prepare(state, ctx, limits, caps)?;

    let started = Instant::now();
    let mut child = spawn_bwrap_child(
        &setup, caps, ctx, rootfs_dir, command, limits, extra_mounts, None,
    )?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let stdout_handle = tokio::spawn(read_capped_owned(stdout));
    let stderr_handle = tokio::spawn(read_capped_owned(stderr));

    let budget = Duration::from_secs(timeout_secs.unwrap_or(limits.timeout_secs.max(1) as u64));
    let wait = timeout(budget, child.wait()).await;
    let (timed_out, status) = match wait {
        Ok(Ok(s)) => (false, s.code().unwrap_or(-1)),
        Ok(Err(e)) => {
            return Err(AppError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "BWRAP_WAIT_FAILED",
                format!("wait on bwrap child failed: {e}"),
            ));
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            (true, -1)
        }
    };

    let (stdout_buf, stdout_truncated) = stdout_handle.await.unwrap_or_else(|_| (Vec::new(), false));
    let (stderr_buf, stderr_truncated) = stderr_handle.await.unwrap_or_else(|_| (Vec::new(), false));
    let duration_ms = started.elapsed().as_millis() as u64;

    // Drop the setup (cgroup scope removal + seccomp fd close) after the child.
    drop(setup);

    tracing::info!(exit_code = status, timed_out, duration_ms, "sandbox.exec complete");

    Ok(SandboxRunResult {
        exit_code: status,
        stdout: lossy_string_with_marker(stdout_buf, stdout_truncated),
        stderr: lossy_string_with_marker(stderr_buf, stderr_truncated),
        stdout_truncated,
        stderr_truncated,
        duration_ms,
        timed_out,
    })
}

#[cfg(target_os = "linux")]
async fn read_capped_owned<R: AsyncRead + Unpin + Send + 'static>(mut reader: R) -> (Vec<u8>, bool) {
    let mut buf = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 8 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() + n > OUTPUT_CAP_BYTES {
                    let remain = OUTPUT_CAP_BYTES - buf.len();
                    buf.extend_from_slice(&chunk[..remain]);
                    truncated = true;
                    while reader.read(&mut chunk).await.unwrap_or(0) > 0 {}
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(_) => break,
        }
    }
    (buf, truncated)
}

/// Turn captured bytes into a lossy String with a truncation marker appended.
/// OS-independent (used by the result mapping + tests).
pub(crate) fn lossy_string_with_marker(buf: Vec<u8>, truncated: bool) -> String {
    let mut s = String::from_utf8_lossy(&buf).into_owned();
    if truncated {
        s.push_str(&format!("\n[output truncated at {OUTPUT_CAP_BYTES} bytes]\n"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::sandbox::types::{CgroupMode, SeccompMode};
    use uuid::Uuid;

    fn caps(pid: PidNsMode) -> HardeningCapabilities {
        HardeningCapabilities {
            bwrap_path: PathBuf::from("/usr/bin/bwrap"),
            pid_namespace: pid,
            cgroup: CgroupMode::None,
            seccomp: SeccompMode::NotLinked,
        }
    }

    fn ctx() -> SandboxContext {
        SandboxContext {
            job_id: Uuid::nil(),
            workspace: PathBuf::from("/data/sandboxes/job"),
        }
    }

    fn argv(extra: &[ExtraMount], seccomp_fd: Option<i32>) -> Vec<String> {
        argv_fifo(extra, seccomp_fd, None)
    }

    fn argv_fifo(extra: &[ExtraMount], seccomp_fd: Option<i32>, fifo: Option<&str>) -> Vec<String> {
        build_bwrap_argv(
            &caps(PidNsMode::Strict),
            &ctx(),
            Path::new("/mnt/rootfs"),
            "echo hi",
            Path::new("/id/passwd"),
            Path::new("/id/group"),
            Path::new("/id/empty"),
            seccomp_fd,
            &SandboxResourceLimits::defaults(),
            extra,
            fifo,
        )
    }

    fn pos(a: &[String], needle: &str) -> Option<usize> {
        a.iter().position(|s| s == needle)
    }

    // TEST-7: the security-critical argv shape + ordering.
    #[test]
    fn argv_has_hardening_terminator_and_prlimit_tail() {
        let a = argv(&[], None);
        assert_eq!(a[0], "--clearenv", "clearenv must be first");
        assert!(a.contains(&"--unshare-user".to_string()));
        assert!(pos(&a, "--uid").is_some() && a[pos(&a, "--uid").unwrap() + 1] == "1001");
        // rootfs /usr bound read-only.
        let ub = pos(&a, "/usr").unwrap();
        assert_eq!(a[ub - 1], "/mnt/rootfs/usr");
        assert_eq!(a[ub - 2], "--ro-bind");
        // A `--` terminator precedes prlimit, and another precedes bash.
        let term_positions: Vec<usize> = a.iter().enumerate().filter(|(_, s)| *s == "--").map(|(i, _)| i).collect();
        assert!(term_positions.len() >= 2, "two -- terminators (before prlimit, before bash)");
        let prlimit = pos(&a, "/usr/bin/prlimit").unwrap();
        assert!(term_positions[0] < prlimit, "first -- precedes prlimit (CVE-2024-32462)");
        // bash tail.
        let bash = pos(&a, "/bin/bash").unwrap();
        assert_eq!(a[bash + 1], "-lc");
        assert_eq!(a[bash + 2], "echo hi");
        assert!(a.iter().any(|s| s == "--nproc=512"), "prlimit nproc from limits");
        assert!(a.iter().any(|s| s == "--core=0"));
        // No --seccomp when no fd passed.
        assert!(!a.contains(&"--seccomp".to_string()));
    }

    #[test]
    fn argv_seccomp_only_when_fd_present() {
        let a = argv(&[], Some(7));
        let sc = pos(&a, "--seccomp").expect("--seccomp present with fd");
        assert_eq!(a[sc + 1], "7");
        // --seccomp is before the first terminator.
        let first_term = pos(&a, "--").unwrap();
        assert!(sc < first_term, "seccomp is part of the hardening prefix");
    }

    // TEST-8: extra_mounts map to the right flag, before the terminator.
    #[test]
    fn extra_mounts_map_ro_and_rw() {
        let mounts = vec![
            ExtraMount { host_path: PathBuf::from("/host/matrix.mtx"), sandbox_path: "/inputs/matrix.mtx".into(), mode: MountMode::ReadOnly },
            ExtraMount { host_path: PathBuf::from("/host/out"), sandbox_path: "/outputs".into(), mode: MountMode::ReadWrite },
        ];
        let a = argv(&mounts, None);
        let ro = pos(&a, "/inputs/matrix.mtx").unwrap();
        assert_eq!(a[ro - 2], "--ro-bind-try");
        assert_eq!(a[ro - 1], "/host/matrix.mtx");
        let rw = pos(&a, "/outputs").unwrap();
        assert_eq!(a[rw - 2], "--bind");
        assert_eq!(a[rw - 1], "/host/out");
        // Both are before the first `--` terminator (cannot shadow hardening).
        let first_term = pos(&a, "--").unwrap();
        assert!(ro < first_term && rw < first_term);
    }

    // TEST-9: synthetic identity content + dotfile masks present in argv.
    #[test]
    fn synthetic_identity_and_dotfile_masks() {
        assert!(SYNTHETIC_PASSWD.starts_with("analyst:x:1001:1001:"));
        assert!(SYNTHETIC_GROUP.starts_with("analyst:x:1001:"));
        let a = argv(&[], None);
        for dotfile in DANGEROUS_DOTFILES {
            let target = format!("/home/analyst/{dotfile}");
            let p = pos(&a, &target).unwrap_or_else(|| panic!("{target} masked"));
            assert_eq!(a[p - 1], "/id/empty", "dotfile masked with the empty file");
            assert_eq!(a[p - 2], "--ro-bind");
        }
    }

    // TEST-24 (FB MEDIUM-1 + LOW-1 + HIGH-1 argv side): network is BLOCKED, the
    // /etc/ssl bind is narrowed to certs, and the host /proc is NEVER bound.
    #[test]
    fn argv_blocks_network_narrows_ssl_and_never_binds_host_proc() {
        let a = argv(&[], None);
        // MEDIUM-1: no network.
        assert!(a.contains(&"--unshare-net".to_string()), "network must be blocked");
        assert!(!a.contains(&"--share-net".to_string()), "must NOT --share-net");
        // HIGH-1: strict pid-ns owns its own /proc; host /proc is never dev-bound.
        assert!(a.contains(&"--unshare-pid".to_string()), "strict pid-ns");
        assert!(
            !a.windows(3).any(|w| w[0] == "--dev-bind" && w[1] == "/proc"),
            "must NEVER --dev-bind the host /proc (secret-exfil vector)"
        );
        // LOW-1: CA certs only, never a bare /etc/ssl (would expose /etc/ssl/private).
        assert!(a.contains(&"/etc/ssl/certs".to_string()), "certs bound");
        assert!(
            !a.windows(3).any(|w| w[0] == "--ro-bind-try" && w[2] == "/etc/ssl"),
            "no bare /etc/ssl destination bind"
        );
    }

    // TEST-3: progress FIFO — None is byte-identical; Some adds exactly one
    // `--bind <fifo> <path>` + the `CYTO_PROGRESS_FIFO` setenv, before the `--`.
    #[test]
    fn progress_fifo_none_is_byte_identical_some_adds_bind() {
        let none = argv_fifo(&[], None, None);
        let baseline = argv(&[], None);
        assert_eq!(none, baseline, "None fifo → byte-identical argv");

        let with = argv_fifo(&[], None, Some("/host/run/fifo"));
        // Exactly one more --bind (the fifo) than the no-fifo case.
        let count_bind = |a: &[String]| a.iter().filter(|s| *s == "--bind").count();
        assert_eq!(count_bind(&with), count_bind(&none) + 1, "one extra --bind for the fifo");
        // The fifo bind maps the host path → the fixed sandbox path.
        let p = pos(&with, PROGRESS_FIFO_SANDBOX_PATH).expect("fifo dest present");
        assert_eq!(with[p - 1], "/host/run/fifo");
        assert_eq!(with[p - 2], "--bind");
        // The env is exported to the fixed path.
        let e = pos(&with, "CYTO_PROGRESS_FIFO").expect("progress env present");
        assert_eq!(with[e + 1], PROGRESS_FIFO_SANDBOX_PATH);
        // All of it precedes the first `--` terminator (part of the prefix).
        let first_term = pos(&with, "--").unwrap();
        assert!(p < first_term && e < first_term, "fifo bind + env before the terminator");
    }

    #[test]
    fn output_truncation_marker() {
        let s = lossy_string_with_marker(b"hello".to_vec(), true);
        assert!(s.contains("hello"));
        assert!(s.contains("[output truncated at"));
        let s2 = lossy_string_with_marker(b"ok".to_vec(), false);
        assert_eq!(s2, "ok");
    }
}
