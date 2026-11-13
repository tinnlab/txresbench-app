//! macOS stacked method runs: one libkrun microVM per run.
//!
//! Linux runs a method by mounting the base + layer squashfs images on the host
//! and spawning bwrap over them (`service::run_method_in_stack`). macOS can do
//! neither, so the macOS seam boots a small Linux VM per run with the SDK's
//! `txresbench-sandbox-vm-launcher` (libkrun) and runs the same bwrap command
//! inside it:
//!
//! - the base image is the VM's first read-only disk (`/dev/vda`, mounted by the
//!   guest agent at [`GUEST_BASE_MOUNT`]) and the method layer its second
//!   (`/dev/vdb`, at [`GUEST_LAYER_MOUNT`]);
//! - no real host dir is writable from the guest: the VM's workspace share
//!   (`/workspace`) is an empty per-VM dir, and every read-only
//!   input (`/input`, a saved `/model`, the synthetic identity files) is a
//!   readable per-run copy ([`RoStage`]) shared read-only at
//!   `/host-mounts/<i>`;
//! - everything the sandboxed workload writes — read-write outputs (`/output`,
//!   a fit's `/model`) and its home dir — lives in guest-local tmpfs dirs the
//!   agent streams back after the command exits (libkrun's virtio-fs refuses
//!   file creation from the sandboxed uid); [`MethodVm::exec`] writes them into
//!   the real host dirs;
//! - the bwrap argv is the SAME stacked builder the Linux seam uses, called
//!   with guest paths, so every hardening flag is identical;
//! - the guest has no network at all: the launcher turns off libkrun's TSI
//!   (its default vsock device proxies guest sockets through the host, which
//!   bwrap's `--unshare-net` does NOT block).
//!
//! The VM boots in about half a second, so there is no warm pool: each run
//! gets a fresh VM, and dropping [`MethodVm`] kills it.
//!
//! The runtime is found through `TXR_SANDBOX_VM_LAUNCHER` and
//! `TXR_SANDBOX_GUEST_ROOT`, else the
//! launcher next to the app binary and the guest root under
//! `<app_data>/sandbox-vm/guest-root`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use sandbox_vm_protocol::{encode, Decoder, ExecRequest, Frame};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use txresbench_core::AppError;

use super::backend::ProgressSink;
use super::streaming::{parse_milestone_line, parse_progress_line};
use super::service::{append_capped, forward_log_line, LOG_PHASE_STDERR, LOG_PHASE_STDOUT};
use super::stack;
use super::types::{CgroupMode, HostCapabilities, SeccompMode};

/// bwrap inside the guest root.
pub const GUEST_BWRAP_PATH: &str = "/usr/bin/bwrap";
/// The guest agent (the VM's entrypoint).
const GUEST_AGENT_PATH: &str = "/usr/bin/txresbench-sandbox-agent";
/// The guest root's busybox: runs the read-only pre-run checks (no bwrap).
const GUEST_BUSYBOX_PATH: &str = "/bin/busybox";
/// Where the agent mounts the base image (the first disk).
pub const GUEST_BASE_MOUNT: &str = "/sandbox-rootfs";
/// Where the agent mounts the method layer (the second disk).
pub const GUEST_LAYER_MOUNT: &str = "/sandbox-layer";
/// Where the agent mounts read-only extra share `i` (`/host-mounts/<i>`).
pub const GUEST_EXTRA_MOUNTS_DIR: &str = "/host-mounts";
/// Base of the guest-local dirs the agent streams back (one per RW mount).
pub const GUEST_ARTIFACTS_OUT_DIR: &str = "/tmp/txresbench-artifacts-out";
/// The fd the agent dup2's its seccomp BPF to; the argv's `--seccomp` names it.
pub const GUEST_SECCOMP_FD: i32 = 10;
/// The vsock port the agent listens on.
const GUEST_VSOCK_PORT: u32 = 1024;

/// File in the guest root naming the protocol versions its agent serves
/// (`MIN MAX`); the guest root's builder writes it next to the agent, and
/// the probe checks that the range covers what this app needs.
pub const GUEST_PROTOCOL_MARKER: &str = "etc/txresbench-agent-protocol";
/// The protocol version this app's requests carry.
fn app_needs_version() -> u32 {
    sandbox_vm_protocol::PROTOCOL_VERSION
}

/// Whether a guest root's protocol marker — `MIN MAX`, the versions its agent
/// serves (a single number means exactly that one) — covers `needed`.
fn marker_serves(text: &str, needed: u32) -> Result<(), String> {
    let nums: Vec<u32> = text
        .split_whitespace()
        .map(|w| w.parse().map_err(|_| format!("its protocol marker {:?} is not a version range", text.trim())))
        .collect::<Result<_, _>>()?;
    let (min, max) = match nums.as_slice() {
        [v] => (*v, *v),
        [min, max] if min <= max => (*min, *max),
        _ => return Err(format!("its protocol marker {:?} is not a version range", text.trim())),
    };
    if (min..=max).contains(&needed) {
        Ok(())
    } else {
        Err(format!("its agent serves protocol {min}..={max} but this app needs {needed}"))
    }
}

/// Files the guest root must contain (checked by [`probe_host`]).
const GUEST_ROOT_FILES: [&str; 3] = ["usr/bin/bwrap", "usr/bin/txresbench-sandbox-agent", "bin/busybox"];
/// Mount points the guest root must contain: it is read-only in the VM.
const GUEST_ROOT_DIRS: [&str; 7] =
    ["proc", "tmp", "sys/fs/cgroup", "sandbox-rootfs", "sandbox-layer", "workspace", "host-mounts"];
/// The script that builds a guest root (named in the probe's errors).
const GUEST_ROOT_BUILDER: &str = "scripts/build-macos-vm-guest-root.sh";
const LAUNCHER_ENV: &str = "TXR_SANDBOX_VM_LAUNCHER";
const GUEST_ROOT_ENV: &str = "TXR_SANDBOX_GUEST_ROOT";
const LAUNCHER_BIN: &str = "txresbench-sandbox-vm-launcher";

/// Boot budget: launcher start → the agent's "listening on vsock port" line.
const BOOT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long [`MethodVm::exec`] retries the first connect (the host end of the
/// vsock bridge can lag the agent's readiness line by a few ms).
const CONNECT_RETRY: Duration = Duration::from_secs(5);
/// Budget of one pre-run check (busybox cat / test inside the guest).
const CHECK_TIMEOUT_MS: u64 = 15_000;
/// Once outputs are streaming back, how long the exchange may go without
/// any data before the copy-back counts as stalled.
const COPY_BACK_IDLE: Duration = Duration::from_secs(60);
/// macOS AF_UNIX `sun_path` is 104 bytes; keep a margin.
const MAX_SOCKET_PATH: usize = 100;

/// The method VM could not be prepared, booted or reached, or stopped
/// before the command finished.
pub const VM_UNAVAILABLE_CODE: &str = "SANDBOX_VM_UNAVAILABLE";

/// Some of the run's output files could not be copied back from the method
/// VM; the run is refused rather than kept with partial outputs.
pub const VM_OUTPUTS_INCOMPLETE_CODE: &str = "SANDBOX_VM_OUTPUTS_INCOMPLETE";

fn vm_error(message: impl Into<String>) -> AppError {
    AppError::new(StatusCode::SERVICE_UNAVAILABLE, VM_UNAVAILABLE_CODE, message.into())
}

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The VM launcher binary: `TXR_SANDBOX_VM_LAUNCHER`, else next to the app's
/// own executable (where a bundled sidecar lands).
pub fn launcher_path() -> PathBuf {
    env_path(LAUNCHER_ENV).unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join(LAUNCHER_BIN)))
            .unwrap_or_else(|| PathBuf::from(LAUNCHER_BIN))
    })
}

/// The guest root (agent + bwrap + busybox userland): `TXR_SANDBOX_GUEST_ROOT`,
/// else `<app_data>/sandbox-vm/guest-root`.
pub fn guest_root_path() -> PathBuf {
    env_path(GUEST_ROOT_ENV).unwrap_or_else(|| {
        crate::modules::rootfs::data_root()
            .join("sandbox-vm")
            .join("guest-root")
    })
}

/// The boot probe: `Ok` with the host capabilities when this Mac can run
/// method VMs, else the reason it cannot. Host-only, run once at module init:
/// file checks plus one short launcher start (to prove libkrun loads).
pub fn probe_host() -> Result<HostCapabilities, String> {
    if std::env::consts::ARCH != "aarch64" {
        return Err("method VMs need an Apple Silicon Mac (libkrun runs arm64 guests only)".into());
    }
    let launcher = launcher_path();
    if !launcher.is_file() {
        return Err(format!(
            "the VM launcher is missing at {} (set {LAUNCHER_ENV})",
            launcher.display()
        ));
    }
    // Run with no arguments the launcher prints its usage and exits 2. If its
    // libkrun cannot be loaded, the dynamic loader aborts it first; catch that
    // here rather than as a 30 s boot timeout on every run.
    match std::process::Command::new(&launcher).env_clear().output() {
        Ok(out) if out.status.code() == Some(2) => {}
        Ok(out) => {
            let msg = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "the VM launcher at {} does not start ({}): {}",
                launcher.display(),
                out.status,
                msg.lines().next().unwrap_or("").trim()
            ));
        }
        Err(e) => return Err(format!("the VM launcher at {} cannot run: {e}", launcher.display())),
    }
    let root = guest_root_path();
    // The guest agent must speak this app's protocol version; an older guest
    // root would refuse every request without a reply.
    let marker = root.join(GUEST_PROTOCOL_MARKER);
    match std::fs::read_to_string(&marker) {
        Ok(text) => {
            if let Err(why) = marker_serves(&text, app_needs_version()) {
                return Err(format!(
                    "the VM guest root at {}: {why} (rebuild it with {GUEST_ROOT_BUILDER})",
                    root.display()
                ));
            }
        }
        Err(_) => {
            return Err(format!(
                "the VM guest root at {} has no /{GUEST_PROTOCOL_MARKER} (build it with \
                 {GUEST_ROOT_BUILDER})",
                root.display()
            ));
        }
    }
    for rel in GUEST_ROOT_FILES {
        if !root.join(rel).is_file() {
            return Err(format!(
                "the VM guest root at {} has no {rel} (set {GUEST_ROOT_ENV})",
                root.display()
            ));
        }
    }
    for rel in GUEST_ROOT_DIRS {
        if !root.join(rel).is_dir() {
            return Err(format!(
                "the VM guest root at {} has no /{rel} mount point (set {GUEST_ROOT_ENV})",
                root.display()
            ));
        }
    }
    Ok(HostCapabilities {
        bwrap_path: PathBuf::from(GUEST_BWRAP_PATH),
        // cgroup limits and the seccomp filter are applied by the guest agent
        // per exec (ExecRequest.cgroup / seccomp_fd), not by the host.
        cgroup: CgroupMode::None,
        seccomp: SeccompMode::NotLinked,
    })
}

/// The Mac's physical memory in bytes (`hw.memsize`), if readable.
pub fn host_memory_bytes() -> Option<u64> {
    let mut value: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    // SAFETY: `hw.memsize` is a 64-bit integer sysctl; `value`/`len` are valid
    // for writes of that size, and no new value is set.
    let rc = unsafe {
        libc::sysctlbyname(
            c"hw.memsize".as_ptr(),
            (&mut value as *mut u64).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    (rc == 0 && value > 0).then_some(value)
}

/// This process's share of a per-run temp tree: `<tmp>/<tree>/<pid>`, which
/// this process holds an exclusive lock on (`<dir>/.lock`, flock) for its
/// whole life. The startup sweep removes a dir only when it can take that
/// lock, i.e. when its owner is gone — a reused pid cannot fool it. The
/// FIRST use (and only it) empties the dir when it takes the lock: whatever a
/// dead process with the same pid left is this process's to clean. That is
/// decided once per process whatever happens, so a later call can never empty
/// a dir that in-flight runs are using.
fn process_dir(tree: &str) -> PathBuf {
    process_dir_in(&std::env::temp_dir(), tree)
}

/// Where per-run image clones live: next to the image cache (under the app
/// data dir), so they are on the cache's volume and `std::fs::copy` can
/// clone instead of copying gigabytes when $TMPDIR is on another volume.
fn image_stage_root() -> PathBuf {
    crate::modules::rootfs::data_root().join("tmp")
}

/// The trees the startup sweep cleans: (root, tree).
fn swept_trees() -> [(PathBuf, &'static str); 3] {
    let tmp = std::env::temp_dir();
    [(tmp.clone(), "txr-vm"), (tmp, "txr-vm-inputs"), (image_stage_root(), "txr-vm-images")]
}

/// [`process_dir`] under another root.
fn process_dir_in(root: &Path, tree: &str) -> PathBuf {
    let dir = root.join(tree).join(std::process::id().to_string());
    let key = dir.to_string_lossy().into_owned();
    let mut held = PROCESS_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
    // A lock that could not be taken earlier is retried (never emptying the
    // dir: runs may be using it), so the dir is protected from other
    // servers' sweeps as soon as possible.
    if let Some(slot @ None) = held.get_mut(&key) {
        *slot = open_lock(&dir);
    }
    if !held.contains_key(&key) {
        let _ = std::fs::create_dir_all(&dir);
        let lock = open_lock(&dir);
        if lock.is_some() {
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for entry in rd.flatten() {
                    if entry.file_name() != ".lock" {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        } else {
            tracing::warn!(
                dir = %dir.display(),
                "method VM: could not lock this process's temp dir; leftovers there are not \
                 cleaned, and until a later use takes the lock another server's startup sweep \
                 may remove it"
            );
        }
        held.insert(key, lock);
    }
    dir
}

/// Per process dir: the lock file this process holds (kept open for its
/// life), or None when it could not be taken. Present once the first use
/// decided.
static PROCESS_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Option<std::fs::File>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Open `<dir>/.lock` and take it, or None.
fn open_lock(dir: &Path) -> Option<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(".lock"))
        .ok()
        .filter(try_lock)
}

/// Take an exclusive flock without blocking.
fn try_lock(file: &std::fs::File) -> bool {
    use std::os::fd::AsRawFd;
    // SAFETY: flock on an fd we own; LOCK_NB never blocks.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

/// Remove per-run dirs (image clones, input copies, VM run dirs) left by app
/// or server processes that are no longer running — a crash or force-quit
/// skips the cleanup on drop. A dir whose lock is held belongs to a live
/// process (another server, or this one) and is kept.
pub fn sweep_stale_dirs() {
    sweep_stale_dirs_in(&swept_trees());
}

/// [`sweep_stale_dirs`] over the given (root, tree) pairs.
fn sweep_stale_dirs_in(trees: &[(PathBuf, &str)]) {
    for (root, tree) in trees {
        let Ok(rd) = std::fs::read_dir(root.join(tree)) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            // Locked by its owner → live. Lockable → its owner is gone; the
            // lock is HELD while the dir is removed, so no process can take
            // it in between.
            let lock = std::fs::OpenOptions::new().write(true).open(path.join(".lock"));
            let stale = match &lock {
                Ok(lock) => try_lock(lock),
                // No lock file: the layout before locks, or an owner that died
                // before taking it — or one that is just starting (it creates
                // the dir, then the lock), so a dir younger than a minute is
                // left alone.
                Err(_) => std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > Duration::from_secs(60)),
            };
            if stale {
                if let Err(e) = std::fs::remove_dir_all(&path) {
                    tracing::warn!(dir = %path.display(), "method VM: could not remove stale run dirs: {e}");
                }
            }
            drop(lock);
        }
    }
}

/// An image file's identity: device, inode, size, mtime and ctime. ctime is
/// set by the kernel on every write or metadata change and cannot be set
/// back by userland, so an unchanged identity means unchanged bytes.
pub type ImageIdentity = (u64, u64, u64, i128, i128);

pub fn image_identity(path: &Path) -> Option<ImageIdentity> {
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::metadata(path).ok()?;
    let ns = |s: i64, n: i64| s as i128 * 1_000_000_000 + n as i128;
    Some((md.dev() as u64, md.ino(), md.len(), ns(md.mtime(), md.mtime_nsec()), ns(md.ctime(), md.ctime_nsec())))
}

static VERIFIED_IMAGES: std::sync::LazyLock<Mutex<HashMap<String, ImageIdentity>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// Whether the cache file with this identity was already verified against
/// `digest` in this process (so a clone of it needs no second full hash).
pub fn verified_before(digest: &str, identity: ImageIdentity) -> bool {
    VERIFIED_IMAGES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(digest)
        == Some(&identity)
}

/// Record that the cache file with this identity hashes to `digest`.
pub fn record_verified(digest: &str, identity: ImageIdentity) {
    VERIFIED_IMAGES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(digest.to_string(), identity);
}

/// What one method VM boots with.
pub struct VmSpec {
    pub num_vcpus: u8,
    pub ram_mib: u32,
    /// The verified base image (first disk → [`GUEST_BASE_MOUNT`]).
    pub base_disk: PathBuf,
    /// The verified method layer (second disk → [`GUEST_LAYER_MOUNT`]).
    pub layer_disk: PathBuf,
    /// Shared read-only; index `i` → `/host-mounts/<i>` in the guest.
    pub ro_shares: Vec<PathBuf>,
}

/// One booted method VM. Dropping it kills the VM and removes its run dir.
pub struct MethodVm {
    child: tokio::process::Child,
    socket_path: PathBuf,
    run_dir: PathBuf,
}

impl Drop for MethodVm {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
        let _ = std::fs::remove_dir_all(&self.run_dir);
    }
}

/// The raw result of one command in the VM.
pub struct VmExecOutcome {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// Outputs that could not be copied back (empty = all arrived). The
    /// caller decides: a run that otherwise succeeded is refused; a run that
    /// failed keeps its own result, with this list added.
    pub incomplete: Vec<String>,
    /// The LAST bytes of stderr (the capture above keeps the first ones).
    pub stderr_tail: Vec<u8>,
    /// Output symlinks not recreated on the host because they point outside
    /// their output dir (`link -> target`); the run still succeeds.
    pub left_out_symlinks: Vec<String>,
}

/// One dir the workload writes and the host receives: where it lands on the
/// host, and where the workload saw it in its sandbox (`/output`, `/model`),
/// used to re-root absolute symlink targets.
#[derive(Clone, Debug)]
pub struct OutputDir {
    pub host: PathBuf,
    pub sandbox_path: String,
}

/// Read-only run inputs, staged as readable copies for one method VM.
///
/// virtio-fs shows the guest the HOST owner and modes, and the sandboxed
/// workload's uid is not the host user, so a private (0700) host dir — a fit's
/// model dir, the model store — is unreadable inside the VM. Each read-only
/// input is therefore copied into a per-run dir with dirs 0755 and files 0644,
/// and the COPY is shared; the host's own modes are never loosened. Symlinks
/// are copied as stored (the guest resolves them, as with a Linux bind
/// mount); special files are skipped. The copies are removed when this value
/// drops.
pub struct RoStage {
    root: PathBuf,
    next: usize,
}

impl RoStage {
    /// A stage for read-only input dirs (under the system temp dir).
    pub fn new() -> Result<Self, AppError> {
        Self::under(process_dir("txr-vm-inputs"))
    }

    /// A stage for environment image clones, on the image cache's volume.
    pub fn for_images() -> Result<Self, AppError> {
        Self::under(process_dir_in(&image_stage_root(), "txr-vm-images"))
    }

    fn under(parent: PathBuf) -> Result<Self, AppError> {
        use std::os::unix::fs::DirBuilderExt;
        let id = uuid::Uuid::new_v4().simple().to_string();
        let root = parent.join(&id[..12]);
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&root)
            .map_err(|e| vm_error(format!("create the VM input dir {}: {e}", root.display())))?;
        Ok(Self { root, next: 0 })
    }

    /// Copy the FILE `src` (an environment image) into this run's private dir
    /// and return the copy's path. `std::fs::copy` clones on APFS
    /// (copy-on-write: instant, no extra space), so a multi-GB image costs
    /// nothing; the copy cannot be pruned or replaced by anything else.
    pub fn stage_file(&mut self, src: &Path) -> Result<PathBuf, AppError> {
        let dst = self.root.join(format!("{}.img", self.next));
        self.next += 1;
        std::fs::copy(src, &dst).map_err(|e| {
            vm_error(format!("stage the image {} for the method VM: {e}", src.display()))
        })?;
        Ok(dst)
    }

    /// Copy `src` (a directory) into a fresh readable dir and return its path.
    pub fn stage(&mut self, src: &Path) -> Result<PathBuf, AppError> {
        let dst = self.root.join(self.next.to_string());
        self.next += 1;
        copy_tree_readable(src, &dst).map_err(|e| {
            vm_error(format!(
                "stage the read-only input {} for the method VM: {e}",
                src.display()
            ))
        })?;
        Ok(dst)
    }
}

impl Drop for RoStage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn copy_tree_readable(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dst)?;
    std::fs::set_permissions(dst, std::fs::Permissions::from_mode(0o755))?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            copy_tree_readable(&entry.path(), &to)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &to)?;
            std::fs::set_permissions(&to, std::fs::Permissions::from_mode(0o644))?;
        } else if kind.is_symlink() {
            // As stored, which is what a Linux bind mount shows: the guest
            // resolves it in its own file system (a saved model may hold the
            // relative links its fit left).
            std::os::unix::fs::symlink(std::fs::read_link(entry.path())?, &to)?;
        }
    }
    Ok(())
}

/// A short per-run directory for the launch config and the vsock socket. Kept
/// under the system temp dir so the socket path fits `sun_path`.
fn make_run_dir() -> Result<PathBuf, AppError> {
    use std::os::unix::fs::DirBuilderExt;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = process_dir("txr-vm").join(&id[..12]);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .map_err(|e| vm_error(format!("create the VM run dir {}: {e}", dir.display())))?;
    Ok(dir)
}

impl MethodVm {
    /// Boot a VM and wait until its guest agent listens.
    pub async fn boot(spec: &VmSpec) -> Result<Self, AppError> {
        let run_dir = make_run_dir()?;
        let socket_path = run_dir.join("vm.sock");
        if socket_path.as_os_str().len() > MAX_SOCKET_PATH {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(vm_error(format!(
                "the VM socket path {} is longer than the macOS limit; set TMPDIR to a shorter \
                 directory",
                socket_path.display()
            )));
        }
        // The launcher always shares a "workspace" dir; give it an empty,
        // private one per VM so no real host dir is writable from the guest
        // (every input arrives as a read-only staged copy, every output is
        // streamed back).
        let workspace = run_dir.join("ws");
        if let Err(e) = std::fs::create_dir(&workspace) {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(vm_error(format!("create the VM workspace dir: {e}")));
        }
        let path_str = |p: &Path| p.to_string_lossy().into_owned();
        // No network setting: the launcher always boots the guest without
        // network. The analysis sandbox has no network (hard invariant), and
        // bwrap's --unshare-net alone does NOT give that in a libkrun guest:
        // the default vsock device carries TSI, which proxies guest sockets
        // through the host regardless of network namespaces, so the launcher
        // swaps in a vsock device without TSI.
        let cfg = serde_json::json!({
            "num_vcpus": spec.num_vcpus.max(1),
            "ram_mib": spec.ram_mib.max(512),
            "root_path": path_str(&guest_root_path()),
            "sandbox_disk_path": path_str(&spec.base_disk),
            "layer_disk_path": path_str(&spec.layer_disk),
            "workspace_host_path": path_str(&workspace),
            "vsock_socket_path": path_str(&socket_path),
            "vsock_port": GUEST_VSOCK_PORT,
            "agent_exec_path": GUEST_AGENT_PATH,
            "extra_mounts": spec.ro_shares.iter().map(|p| path_str(p)).collect::<Vec<_>>(),
        });
        let cfg_path = run_dir.join("launch.json");
        if let Err(e) = std::fs::write(&cfg_path, cfg.to_string()) {
            let _ = std::fs::remove_dir_all(&run_dir);
            return Err(vm_error(format!("write the VM launch config: {e}")));
        }

        // env_clear: the launcher needs no environment (its config is the JSON
        // file), and the VMM must not inherit the server's secrets.
        let mut child = match tokio::process::Command::new(launcher_path())
            .arg(&cfg_path)
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&run_dir);
                return Err(vm_error(format!(
                    "start the VM launcher {}: {e}",
                    launcher_path().display()
                )));
            }
        };

        // Forward the launcher/agent log to tracing, keep a short tail for
        // error messages, and signal the agent's readiness line.
        let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        let (ready_tx, mut ready_rx) = tokio::sync::mpsc::channel::<()>(1);
        if let Some(stderr) = child.stderr.take() {
            let tail = tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                let mut signaled = false;
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "sandbox::vm", "{line}");
                    {
                        let mut t = tail.lock().unwrap_or_else(|p| p.into_inner());
                        if t.len() == 20 {
                            t.pop_front();
                        }
                        t.push_back(line.clone());
                    }
                    if !signaled && line.contains("listening on vsock port") {
                        let _ = ready_tx.send(()).await;
                        signaled = true;
                    }
                }
            });
        }

        let vm = MethodVm { child, socket_path, run_dir };
        let tail_text = || {
            tail.lock()
                .unwrap_or_else(|p| p.into_inner())
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        };
        tokio::select! {
            got = ready_rx.recv() => {
                if got.is_none() {
                    return Err(vm_error(format!(
                        "the method VM exited before its agent started:\n{}",
                        tail_text()
                    )));
                }
            }
            _ = tokio::time::sleep(BOOT_TIMEOUT) => {
                return Err(vm_error(format!(
                    "the method VM's agent did not start within {}s:\n{}",
                    BOOT_TIMEOUT.as_secs(),
                    tail_text()
                )));
            }
        }
        Ok(vm)
    }

    async fn connect(&self) -> Result<UnixStream, AppError> {
        let deadline = Instant::now() + CONNECT_RETRY;
        loop {
            match UnixStream::connect(&self.socket_path).await {
                Ok(s) => return Ok(s),
                Err(e) if Instant::now() >= deadline => {
                    return Err(vm_error(format!("connect to the method VM: {e}")));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    }

    /// Run one command in the VM and collect its result.
    ///
    /// With a `sink`, complete stdout/stderr lines are forwarded live as log
    /// frames (the Linux seam's [`LOG_PHASE_STDOUT`] / [`LOG_PHASE_STDERR`]),
    /// and the guest's progress-FIFO lines as milestone/progress frames. Files
    /// the agent streams back from `req.collect_artifacts[i]` are written under
    /// `artifact_host_dirs[i]`. `host_budget` bounds the whole exchange (the
    /// agent enforces `req.timeout_ms` itself; this is the backstop).
    pub async fn exec(
        &self,
        req: ExecRequest,
        host_budget: Duration,
        sink: Option<&Arc<dyn ProgressSink>>,
        artifact_dirs: &[OutputDir],
    ) -> Result<VmExecOutcome, AppError> {
        let started = Instant::now();
        // The agent sends Exit as soon as the command ends, then the outputs,
        // then ArtifactsDone.
        // The host enforces the same total the agent is told (0 = none).
        let output_budget = match req.artifacts.total_cap_bytes {
            0 => u64::MAX,
            cap => cap,
        };
        let mut stream = self.connect().await?;
        stream
            .write_all(&encode(&Frame::Exec(req)))
            .await
            .map_err(|e| vm_error(format!("send the command to the method VM: {e}")))?;

        let sink_ref = sink.map(|s| s.as_ref());
        let mut decoder = Decoder::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut out = LineCapture::new(LOG_PHASE_STDOUT, false);
        let mut err = LineCapture::new(LOG_PHASE_STDERR, true);
        let mut exit: Option<(i32, bool)> = None;
        let mut host_timed_out = false;
        let mut outputs_done = false;
        // Outputs that did not make it back (agent-reported, a stalled or
        // cut-off copy-back, or a failed host write).
        let mut incomplete: Vec<String> = Vec::new();
        let deadline = started + host_budget;
        // Output files are written by one blocking thread, never on the async
        // executor.
        let mut writer = ArtifactWriter::start(artifact_dirs.to_vec(), output_budget);
        // Set when the command's exit arrives: the copy-back's overall limit.
        let mut copy_back_until: Option<Instant> = None;

        'read: loop {
            // Checked every turn: a guest that floods frames never lets the
            // read below time out.
            if copy_back_until.is_some_and(|until| Instant::now() >= until) {
                incomplete.push(format!(
                    "the output copy-back took longer than {} min",
                    COPY_BACK_MAX.as_secs() / 60
                ));
                break;
            }
            // Before the command's exit: its budget. After it (the copy-back):
            // inactivity, so a large output after a long run is not a timeout,
            // within an overall limit, so a guest cannot trickle data forever.
            let left = match copy_back_until {
                Some(until) => COPY_BACK_IDLE.min(until.saturating_duration_since(Instant::now())),
                None => deadline.saturating_duration_since(Instant::now()),
            };
            let n = match tokio::time::timeout(left, stream.read(&mut buf)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => n,
                Ok(Err(e)) if exit.is_some() => {
                    incomplete.push(format!("the output copy-back failed: {e}"));
                    break;
                }
                Ok(Err(e)) => {
                    return Err(vm_error(format!("read from the method VM: {e}")));
                }
                Err(_) if exit.is_some() => {
                    let over = copy_back_until.is_some_and(|until| Instant::now() >= until);
                    incomplete.push(if over {
                        format!("the output copy-back took longer than {} min", COPY_BACK_MAX.as_secs() / 60)
                    } else {
                        format!("the output copy-back stalled (no data for {}s)", COPY_BACK_IDLE.as_secs())
                    });
                    break;
                }
                Err(_) => {
                    host_timed_out = true; // the command's host backstop expired
                    break;
                }
            };
            decoder.feed(&buf[..n]);
            loop {
                match decoder.next_frame() {
                    Ok(Some(Frame::Stdout(b))) => out.push(&b, sink_ref),
                    Ok(Some(Frame::Stderr(b))) => err.push(&b, sink_ref),
                    Ok(Some(Frame::Progress(bytes))) => {
                        if let Some(s) = sink_ref {
                            forward_progress_bytes(&bytes, s);
                        }
                    }
                    Ok(Some(Frame::ArtifactChunk { mount_index, rel_path, offset, data })) => {
                        writer.send(WriterMsg::Chunk(mount_index, rel_path, offset, data)).await;
                    }
                    Ok(Some(Frame::ArtifactDir { mount_index, rel_path })) => {
                        writer.send(WriterMsg::Dir(mount_index, rel_path)).await;
                    }
                    Ok(Some(Frame::ArtifactSymlink { mount_index, rel_path, target })) => {
                        writer.send(WriterMsg::Symlink(mount_index, rel_path, target)).await;
                    }
                    Ok(Some(Frame::ArtifactSkipped { rel_path, reason, .. })) => {
                        push_listed(&mut incomplete, format!("{rel_path}: {reason}"));
                    }
                    Ok(Some(Frame::ArtifactsDone)) => {
                        outputs_done = true;
                        break 'read;
                    }
                    Ok(Some(Frame::Exit(s))) => {
                        exit = Some((s.code, s.timed_out));
                        copy_back_until.get_or_insert(Instant::now() + COPY_BACK_MAX);
                    }
                    Ok(Some(Frame::Exec(_))) => {} // host → guest only
                    Ok(None) => break,
                    Err(e) if exit.is_some() => {
                        incomplete.push(format!("the output copy-back broke off: {e}"));
                        break 'read;
                    }
                    Err(e) => {
                        return Err(vm_error(format!("method VM protocol error: {e}")));
                    }
                }
            }
        }
        out.finish(sink_ref);
        err.finish(sink_ref);
        let report = writer.finish().await;
        incomplete.extend(report.errors);
        if exit.is_some() && !outputs_done && incomplete.is_empty() {
            incomplete.push("the VM stopped before the output copy-back finished".into());
        }
        finish_listed(&mut incomplete);
        let (exit_code, timed_out) = match exit {
            Some(e) => e,
            None if host_timed_out => (-1, true),
            // The stream closed without an Exit frame: the VM or its agent
            // stopped (crash, guest out of memory, launcher killed). That is
            // a VM failure, not a timeout and not the workload's own result.
            None => {
                return Err(vm_error(
                    "the method VM stopped before the command finished: no exit status came \
                     back (the VM crashed or ran out of memory, or its guest agent is a \
                     different protocol version than this app; see the VM log)",
                ));
            }
        };
        Ok(VmExecOutcome {
            exit_code,
            stdout: out.buf,
            stderr: err.buf,
            stdout_truncated: out.truncated,
            stderr_truncated: err.truncated,
            timed_out,
            duration_ms: started.elapsed().as_millis() as u64,
            incomplete,
            stderr_tail: err.tail,
            left_out_symlinks: report.notes,
        })
    }

    /// Run a read-only check with the guest's busybox (outside bwrap): the
    /// guest root's own tools reading the mounted images.
    async fn check(&self, argv: &[&str]) -> Result<VmExecOutcome, AppError> {
        let req = ExecRequest {
            protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
            request_id: 0,
            bwrap_path: GUEST_BUSYBOX_PATH.to_string(),
            argv: argv.iter().map(|a| a.to_string()).collect(),
            timeout_ms: CHECK_TIMEOUT_MS,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: Vec::new(),
            artifacts: Default::default(),
        };
        self.exec(req, Duration::from_millis(CHECK_TIMEOUT_MS + 5_000), None, &[]).await
    }

    /// The layer's bind entries and the wrapper command, read inside the VM
    /// where the images are mounted, and validated by the same `stack` rules
    /// the Linux seam applies on the host.
    pub async fn read_layer_plan(&self) -> Result<(Vec<String>, String), AppError> {
        let manifest = format!("{GUEST_LAYER_MOUNT}/{}", stack::LAYER_MANIFEST_FILE);
        let read = self.check(&["cat", &manifest]).await?;
        if read.timed_out {
            return Err(vm_error(format!("reading {manifest} in the method VM timed out")));
        }
        if read.exit_code != 0 || read.stdout_truncated {
            let why = if read.stdout_truncated {
                "the file is larger than the 1 MiB the check reads".to_string()
            } else {
                String::from_utf8_lossy(&read.stderr).trim().to_string()
            };
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                stack::ENV_LAYER_MANIFEST_INVALID_CODE,
                format!("read {manifest} in the method VM: {why}"),
            ));
        }
        let entries = stack::parse_layer_manifest(&read.stdout, &format!("{manifest} (in the method VM)"))?;

        // DEC-14: every entry's parent must exist in the base. One check call
        // prints the parents that are NOT directories under the base mount.
        let parents = stack::entry_parent_dirs(&entries)?;
        let mut missing: HashSet<PathBuf> = HashSet::new();
        if !parents.is_empty() {
            // NUL-separated: a name may hold a newline.
            let script =
                format!("for p do [ -d \"{GUEST_BASE_MOUNT}/$p\" ] || printf '%s\\0' \"$p\"; done");
            let names: Vec<String> = parents.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            let mut argv: Vec<&str> = vec!["sh", "-c", &script, "sh"];
            argv.extend(names.iter().map(String::as_str));
            let probe = self.check(&argv).await?;
            if probe.exit_code != 0 || probe.timed_out {
                return Err(vm_error(format!(
                    "check the layer's parent dirs in the method VM: {}",
                    String::from_utf8_lossy(&probe.stderr).trim()
                )));
            }
            missing = probe
                .stdout
                .split(|&b| b == 0)
                .filter(|p| !p.is_empty())
                .map(|p| PathBuf::from(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(p)))
                .collect();
        }
        stack::assert_entry_parents_with(
            &entries,
            &format!("{GUEST_BASE_MOUNT} (in the method VM)"),
            |rel| !missing.contains(rel),
        )?;

        // The wrapper command: method.json's language + which scripts exist.
        let method_json_path = format!("{GUEST_LAYER_MOUNT}/code/method.json");
        let method_json = self.check(&["cat", &method_json_path]).await?;
        if method_json.timed_out {
            return Err(vm_error("reading the layer's method.json in the method VM timed out"));
        }
        if method_json.stdout_truncated {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                stack::METHOD_ENTRYPOINT_MISSING_CODE,
                "the layer's /code/method.json is larger than the 1 MiB the VM check reads",
            ));
        }
        // A non-zero exit is a missing method.json (allowed: presence order).
        let method_json = (method_json.exit_code == 0).then_some(method_json.stdout);
        let script = format!(
            "for s do [ -f \"{GUEST_LAYER_MOUNT}/code/$s\" ] && printf '%s\\n' \"$s\"; done; exit 0"
        );
        let mut argv: Vec<&str> = vec!["sh", "-c", &script, "sh"];
        argv.extend(stack::METHOD_ENTRY_SCRIPTS.iter().map(|(_, s)| *s));
        let present_out = self.check(&argv).await?;
        if present_out.exit_code != 0 || present_out.timed_out {
            return Err(vm_error(format!(
                "list the layer's wrapper scripts in the method VM: {}",
                String::from_utf8_lossy(&present_out.stderr).trim()
            )));
        }
        let present: HashSet<String> = String::from_utf8_lossy(&present_out.stdout)
            .lines()
            .map(str::to_string)
            .collect();
        let command = stack::method_entry_command_with(
            method_json.as_deref(),
            |s| present.contains(s),
            &format!("{GUEST_LAYER_MOUNT} (in the method VM)"),
        )?;
        Ok((entries, command))
    }
}

/// Limits on what the guest may send back, enforced on the host (the guest
/// is untrusted): the output path length (the macOS PATH_MAX) and one name's
/// length (APFS's), the number of outputs, and the copy-back's total time.
const MAX_REL_PATH_BYTES: usize = 1024;
const MAX_NAME_BYTES: usize = 255;
const MAX_OUTPUT_ENTRIES: usize = 1_000_000;
const COPY_BACK_MAX: Duration = Duration::from_secs(30 * 60);

/// At most this many entries are kept in a list fed by guest frames (missing
/// outputs, left-out symlinks), each at most MAX_ENTRY_CHARS long: the guest
/// is untrusted and could otherwise grow host memory and the run's stderr
/// without bound.
const MAX_LISTED: usize = 50;
const MAX_ENTRY_CHARS: usize = 300;

/// The "more not listed" line [`push_listed`] adds.
const MORE_NOT_LISTED: &str = "… (more not listed";

/// Finish a list merged from several bounded lists (the agent's, the
/// writer's, the exec loop's): sorted, at most MAX_LISTED entries, and one
/// "more not listed" line at the end when anything was left out.
fn finish_listed(list: &mut Vec<String>) {
    let had_more = list.iter().any(|e| e.starts_with(MORE_NOT_LISTED));
    list.retain(|e| !e.starts_with(MORE_NOT_LISTED));
    list.sort();
    if had_more || list.len() > MAX_LISTED {
        list.truncate(MAX_LISTED);
        list.push(format!("{MORE_NOT_LISTED}; only the first {MAX_LISTED} are named)"));
    }
}

/// Add an entry to a guest-fed list, keeping it bounded (see MAX_LISTED).
fn push_listed(list: &mut Vec<String>, entry: String) {
    match list.len().cmp(&MAX_LISTED) {
        std::cmp::Ordering::Less => list.push(entry.chars().take(MAX_ENTRY_CHARS).collect()),
        std::cmp::Ordering::Equal => {
            list.push(format!("{MORE_NOT_LISTED}; only the first {MAX_LISTED} are named)"))
        }
        std::cmp::Ordering::Greater => {}
    }
}

/// The error for a run whose command succeeded but whose outputs did not all
/// come back: names the files, and keeps the end of the workload's stderr
/// (`stderr_tail`, the last bytes) so its own messages are not lost.
pub fn outputs_incomplete(incomplete: &[String], stderr_tail: &[u8]) -> AppError {
    let tail = String::from_utf8_lossy(stderr_tail);
    let mut message = format!(
        "the method's outputs could not all be copied back from the method VM: {}",
        incomplete.join("; ")
    );
    if !tail.trim().is_empty() {
        message.push_str(&format!("\nthe method's stderr ended with:\n{}", tail.trim_end()));
    }
    AppError::new(StatusCode::INTERNAL_SERVER_ERROR, VM_OUTPUTS_INCOMPLETE_CODE, message)
}

/// Line-splitting capture of one output stream: complete lines go to the sink
/// live; the capture keeps the first `OUTPUT_CAP_BYTES` (same cap as Linux).
struct LineCapture {
    phase: &'static str,
    partial: Vec<u8>,
    buf: Vec<u8>,
    truncated: bool,
    /// The last STDERR_TAIL_BYTES of the stream, when kept (stderr only).
    tail: Vec<u8>,
    keep_tail: bool,
}

const STDERR_TAIL_BYTES: usize = 2000;

impl LineCapture {
    fn new(phase: &'static str, keep_tail: bool) -> Self {
        Self { phase, partial: Vec::new(), buf: Vec::new(), truncated: false, tail: Vec::new(), keep_tail }
    }

    fn push(&mut self, chunk: &[u8], sink: Option<&dyn ProgressSink>) {
        if self.keep_tail {
            if chunk.len() >= STDERR_TAIL_BYTES {
                self.tail.clear();
                self.tail.extend_from_slice(&chunk[chunk.len() - STDERR_TAIL_BYTES..]);
            } else {
                self.tail.extend_from_slice(chunk);
                let excess = self.tail.len().saturating_sub(STDERR_TAIL_BYTES);
                self.tail.drain(..excess);
            }
        }
        self.partial.extend_from_slice(chunk);
        // Scan with an index and drain once: taking each line off the front
        // would move the rest of the buffer per line.
        let mut start = 0;
        while let Some(at) = self.partial[start..].iter().position(|&b| b == b'\n') {
            let end = start + at + 1;
            forward_log_line(&self.partial[start..end], sink, self.phase);
            append_capped(&mut self.buf, &self.partial[start..end], &mut self.truncated);
            start = end;
        }
        self.partial.drain(..start);
        // A no-newline flood is bounded, like the Linux reader.
        if self.partial.len() > 64 * 1024 {
            let rest = std::mem::take(&mut self.partial);
            forward_log_line(&rest, sink, self.phase);
            append_capped(&mut self.buf, &rest, &mut self.truncated);
        }
    }

    fn finish(&mut self, sink: Option<&dyn ProgressSink>) {
        if !self.partial.is_empty() {
            let rest = std::mem::take(&mut self.partial);
            forward_log_line(&rest, sink, self.phase);
            append_capped(&mut self.buf, &rest, &mut self.truncated);
        }
    }
}

/// Route one `Progress` frame. The agent sends one newline-trimmed
/// FIFO line per frame; a frame is still split on `\n` defensively so two
/// lines can never be parsed as one.
fn forward_progress_bytes(bytes: &[u8], sink: &dyn ProgressSink) {
    for line in bytes.split(|&b| b == b'\n') {
        if !line.is_empty() {
            forward_progress_line(line, sink);
        }
    }
}

/// Route one progress-FIFO line: a milestone, else fine progress, else drop.
fn forward_progress_line(line: &[u8], sink: &dyn ProgressSink) {
    let text = String::from_utf8_lossy(line);
    let trimmed = text.trim_end();
    if let Some(frame) = parse_milestone_line(trimmed) {
        sink.milestone(frame);
    } else if let Some(frame) = parse_progress_line(trimmed) {
        sink.progress(frame);
    }
}

/// A message for the output writer thread.
enum WriterMsg {
    Chunk(u32, String, u64, Vec<u8>),
    Dir(u32, String),
    Symlink(u32, String, String),
}

/// Writes streamed outputs on ONE blocking thread, so the async exec loop
/// never blocks on the disk (a bounded channel gives backpressure). The agent
/// sends files one after another, so only the current file is open.
///
/// Guest (Linux) names are case-sensitive and byte-exact; the Mac's file
/// system (APFS) is neither — `Pred.csv` / `pred.csv`, or the NFC / NFD
/// spellings of `café.csv`, are ONE file there. Two outputs that would merge
/// are refused: every path component is folded the way APFS compares names
/// (NFC + lowercase), and files are created with O_EXCL so the file system
/// itself refuses anything the folding missed. Files already in an output
/// dir before the run may be overwritten under their exact name.
struct ArtifactWriter {
    tx: Option<tokio::sync::mpsc::Sender<WriterMsg>>,
    thread: Option<std::thread::JoinHandle<WriterReport>>,
    /// Output frames for an exec that has no output dirs.
    unexpected: Vec<String>,
}

/// What the writer thread reports when it ends.
#[derive(Default)]
struct WriterReport {
    /// Outputs that could not be written: the run's outputs are incomplete.
    errors: Vec<String>,
    /// Symlinks left out on purpose (they point outside their output dir).
    notes: Vec<String>,
}

impl ArtifactWriter {
    fn start(dirs: Vec<OutputDir>, budget: u64) -> Self {
        // Checks (and any exec with no output dirs) need no thread; an output
        // frame arriving anyway is reported by `send`.
        if dirs.is_empty() {
            return Self { tx: None, thread: None, unexpected: Vec::new() };
        }
        let (tx, mut rx) = tokio::sync::mpsc::channel::<WriterMsg>(4);
        let thread = std::thread::spawn(move || {
            let mut state = WriterState::new(dirs);
            state.budget = budget;
            while let Some(msg) = rx.blocking_recv() {
                state.apply(msg);
            }
            WriterReport { errors: state.errors, notes: state.notes }
        });
        Self { tx: Some(tx), thread: Some(thread), unexpected: Vec::new() }
    }

    async fn send(&mut self, msg: WriterMsg) {
        match &self.tx {
            Some(tx) => {
                let _ = tx.send(msg).await;
            }
            None => {
                let rel = match &msg {
                    WriterMsg::Chunk(_, r, ..) | WriterMsg::Dir(_, r) | WriterMsg::Symlink(_, r, _) => r.clone(),
                };
                push_listed(&mut self.unexpected, format!("{rel}: an output arrived for an exec with no output dirs"));
            }
        }
    }

    /// Close the channel, wait for the thread to flush, return its report.
    async fn finish(mut self) -> WriterReport {
        self.tx.take();
        let unexpected = std::mem::take(&mut self.unexpected);
        let Some(thread) = self.thread.take() else {
            return WriterReport { errors: unexpected, notes: Vec::new() };
        };
        let failed = |e: String| WriterReport { errors: vec![e], notes: Vec::new() };
        tokio::task::spawn_blocking(move || {
            thread.join().unwrap_or_else(|_| failed("the output writer stopped unexpectedly".into()))
        })
        .await
        .unwrap_or_else(|e| failed(format!("join the output writer: {e}")))
    }
}

/// The writer thread's state (also driven directly by the unit tests).
struct WriterState {
    host_dirs: Vec<PathBuf>,
    /// Where each dir was mounted in the workload's sandbox.
    sandbox_paths: Vec<String>,
    /// (mount, folded path) → the exact path first seen for it.
    names: HashMap<(u32, String), String>,
    /// Files present before the run, by exact path (may be overwritten).
    pre_existing: HashSet<(u32, String)>,
    /// The file being written: its key, handle and path.
    current: Option<((u32, String), std::fs::File, PathBuf)>,
    failed: HashSet<(u32, String)>,
    errors: Vec<String>,
    /// Symlinks not recreated because they point outside their output dir.
    notes: Vec<String>,
    /// Bytes the outputs may total, bytes written so far, and the current
    /// file's length (chunks must arrive in order, with no gap).
    budget: u64,
    written: u64,
    current_len: u64,
    /// Outputs claimed so far (at most MAX_OUTPUT_ENTRIES).
    entries: usize,
}

/// Fold a relative path the way APFS compares names: Unicode NFC, lowercase.
fn fold_name(rel_path: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    rel_path.nfc().collect::<String>().to_lowercase()
}

impl WriterState {
    fn new(dirs: Vec<OutputDir>) -> Self {
        let mut state = Self {
            host_dirs: dirs.iter().map(|d| d.host.clone()).collect(),
            sandbox_paths: dirs.into_iter().map(|d| d.sandbox_path).collect(),
            names: HashMap::new(),
            pre_existing: HashSet::new(),
            current: None,
            failed: HashSet::new(),
            errors: Vec::new(),
            notes: Vec::new(),
            budget: u64::MAX,
            written: 0,
            current_len: 0,
            entries: 0,
        };
        // What the output dirs already hold (normally nothing) keeps its
        // exact names reserved.
        for (i, dir) in state.host_dirs.clone().iter().enumerate() {
            let mut stack = vec![dir.clone()];
            while let Some(d) = stack.pop() {
                let Ok(rd) = std::fs::read_dir(&d) else { continue };
                for entry in rd.flatten() {
                    let path = entry.path();
                    let Ok(rel) = path.strip_prefix(dir) else { continue };
                    let rel = rel.to_string_lossy().into_owned();
                    let kind = entry.file_type().ok();
                    state.names.insert((i as u32, fold_name(&rel)), rel.clone());
                    // file_type() does not follow symlinks: a pre-existing
                    // symlink is neither walked into nor ever overwritten.
                    if kind.is_some_and(|t| t.is_dir()) {
                        stack.push(path);
                    } else if kind.is_some_and(|t| t.is_file()) {
                        state.pre_existing.insert((i as u32, rel));
                    }
                }
            }
        }
        state
    }

    fn apply(&mut self, msg: WriterMsg) {
        let (mount_index, rel_path, result) = match msg {
            // Anything but a chunk means the previous file is complete.
            WriterMsg::Dir(m, rel) => {
                self.current = None;
                let r = self.dir(m, &rel);
                (m, rel, r)
            }
            WriterMsg::Symlink(m, rel, target) => {
                self.current = None;
                let r = self.symlink(m, &rel, &target);
                (m, rel, r)
            }
            WriterMsg::Chunk(m, rel, offset, data) => {
                if self.failed.contains(&(m, rel.clone())) {
                    return;
                }
                let r = self.chunk(m, &rel, offset, &data);
                (m, rel, r)
            }
        };
        if let Err(e) = result {
            // A file that failed part way is removed, never left half
            // written (or, if it existed before the run, truncated) for host
            // code to read.
            let key = (mount_index, rel_path);
            if self.current.as_ref().is_some_and(|(k, _, _)| *k == key) {
                if let Some((_, file, path)) = self.current.take() {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                }
            }
            push_listed(&mut self.errors, format!("{}: {e}", key.1));
            self.failed.insert(key);
        }
    }

    /// Validate `rel_path` (untrusted: from the sandboxed workload) and claim
    /// its name and every parent's under the APFS folding.
    /// A guest-sent relative path: a known output dir, and every `/`-separated
    /// part a plain name. Checked on the TEXT, not with `Path::components`,
    /// which silently drops a `.` or an empty part inside a path: the symlink
    /// code counts parts by splitting on `/`, so `a/./x` would count as two
    /// levels deep while the file system puts it one level deep, and a link
    /// written there would climb out of its dir.
    fn check_rel(&self, mount_index: u32, rel_path: &str) -> Result<&PathBuf, String> {
        let base = self
            .host_dirs
            .get(mount_index as usize)
            .ok_or_else(|| format!("unknown output dir index {mount_index}"))?;
        let plain = |part: &str| {
            !part.is_empty() && part != "." && part != ".." && part.len() <= MAX_NAME_BYTES
        };
        if rel_path.is_empty() || rel_path.len() > MAX_REL_PATH_BYTES || !rel_path.split('/').all(plain) {
            return Err("refused an unsafe or over-long output path".into());
        }
        Ok(base)
    }

    fn claim(&mut self, mount_index: u32, rel_path: &str) -> Result<PathBuf, String> {
        let base = self.check_rel(mount_index, rel_path)?.clone();
        self.entries += 1;
        if self.entries > MAX_OUTPUT_ENTRIES {
            return Err(format!("more than {MAX_OUTPUT_ENTRIES} outputs"));
        }
        let rel = Path::new(rel_path);
        let dest = base.join(rel);
        if !dest.starts_with(&base) {
            return Err("the output path escaped its dir".into());
        }
        // Never write through a symlink already in the output dir: every
        // existing component below the base must be a real directory. A
        // component that exists but was not written by this run must exist
        // under exactly this name: APFS folds names (case, Unicode forms,
        // ß/ss, ...) in ways `fold_name` cannot fully copy, so the file
        // system is asked which name it actually holds.
        let mut walk = base.clone();
        let parts: Vec<&str> = rel_path.split('/').collect();
        let mut prefix = String::new();
        for (i, part) in parts.iter().enumerate() {
            let parent = walk.clone();
            walk.push(part);
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            match std::fs::symlink_metadata(&walk) {
                Ok(md) if md.file_type().is_symlink() => {
                    return Err("a symlink in the output dir is not written through".into());
                }
                Ok(md) if i + 1 < parts.len() && !md.is_dir() => {
                    return Err("a parent of the output path is not a directory".into());
                }
                Ok(_) if !self.names.contains_key(&(mount_index, fold_name(&prefix))) => {
                    let exact = std::fs::read_dir(&parent)
                        .map(|rd| rd.flatten().any(|e| e.file_name() == std::ffi::OsStr::new(part)))
                        .unwrap_or(false);
                    if !exact {
                        return Err(format!(
                            "{prefix} is the same name as an existing entry to the Mac's file \
                             system (it differs only by letter case or Unicode form)"
                        ));
                    }
                }
                _ => {}
            }
        }
        let mut prefix = String::new();
        for part in rel_path.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(part);
            let key = (mount_index, fold_name(&prefix));
            match self.names.get(&key) {
                Some(seen) if *seen != prefix => {
                    return Err(format!(
                        "differs from {seen} only by letter case or Unicode form, and the \
                         Mac's file system cannot keep both"
                    ));
                }
                Some(_) => {}
                None => {
                    self.names.insert(key, prefix.clone());
                }
            }
        }
        Ok(dest)
    }

    fn dir(&mut self, mount_index: u32, rel_path: &str) -> Result<(), String> {
        let dest = self.claim(mount_index, rel_path)?;
        std::fs::create_dir_all(&dest).map_err(|e| format!("mkdir: {e}"))
    }

    /// Recreate a symlink the workload left, as on Linux (where the dir is
    /// bind-mounted and keeps it) — but only one that stays inside its own
    /// output dir: one pointing anywhere else is left out with a note (never
    /// written on the host as an absolute or escaping link, which host code
    /// reading the outputs would follow; on Linux such a link dangles on the
    /// host anyway). The target is resolved lexically from the link's place in
    /// the SANDBOX (an absolute target under the dir's sandbox path, e.g.
    /// `/output/pred.csv`, is re-rooted) and written as a RELATIVE link whose
    /// `..` steps climb only the link's own parent dirs (real dirs: the writer
    /// never creates anything through a symlink), followed by a `..`-free
    /// path. The workload's own text is never kept: `d/../x` with `d -> .`
    /// is inside the dir as text but outside it once `d` is followed. A
    /// dangling link is kept, like on Linux.
    fn symlink(&mut self, mount_index: u32, rel_path: &str, target: &str) -> Result<(), String> {
        // The link's own path is checked first: a malformed frame is an
        // error, never a note.
        self.check_rel(mount_index, rel_path)?;
        let sandbox_root = self
            .sandbox_paths
            .get(mount_index as usize)
            .ok_or_else(|| format!("unknown output dir index {mount_index}"))?
            .trim_end_matches('/')
            .to_string();
        let parent: Vec<&str> = {
            let mut parts: Vec<&str> = rel_path.split('/').collect();
            parts.pop();
            parts
        };
        // The target's components relative to the dir's root.
        let (start, rest): (Vec<&str>, &str) = if let Some(abs) = target.strip_prefix('/') {
            let root = sandbox_root.trim_start_matches('/');
            if abs == root {
                (Vec::new(), "")
            } else if let Some(r) = abs.strip_prefix(&format!("{root}/")) {
                (Vec::new(), r)
            } else {
                return Ok(self.leave_out(rel_path, target));
            }
        } else {
            (parent.clone(), target)
        };
        let mut resolved: Vec<&str> = start;
        for part in rest.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    if resolved.pop().is_none() {
                        return Ok(self.leave_out(rel_path, target));
                    }
                }
                p => resolved.push(p),
            }
        }
        let common = parent.iter().zip(&resolved).take_while(|(a, b)| a == b).count();
        let mut relative: Vec<&str> = vec![".."; parent.len() - common];
        relative.extend(&resolved[common..]);
        let link_target = if relative.is_empty() { ".".to_string() } else { relative.join("/") };
        let dest = self.claim(mount_index, rel_path)?;
        if let Some(parent_dir) = dest.parent() {
            std::fs::create_dir_all(parent_dir).map_err(|e| format!("mkdir: {e}"))?;
        }
        // symlink() refuses an existing name, so nothing is ever replaced.
        std::os::unix::fs::symlink(&link_target, &dest).map_err(|e| format!("symlink: {e}"))
    }

    /// Record a symlink that is not recreated because it leaves its dir.
    fn leave_out(&mut self, rel_path: &str, target: &str) {
        push_listed(&mut self.notes, format!("{rel_path} -> {target}"));
    }

    /// Offset 0 creates the file and makes it the current one (closing the
    /// previous); later chunks must continue the current file.
    fn chunk(&mut self, mount_index: u32, rel_path: &str, offset: u64, data: &[u8]) -> Result<(), String> {
        use std::io::{Seek, SeekFrom, Write};
        let key = (mount_index, rel_path.to_string());
        if offset == 0 {
            self.current = None;
            // Over the budget: refused before anything is created.
            if self.written.saturating_add(data.len() as u64) > self.budget {
                return Err(format!("the outputs are larger than the {} byte output budget", self.budget));
            }
            let dest = self.claim(mount_index, rel_path)?;
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
            }
            use std::os::unix::fs::OpenOptionsExt;
            let mut open = std::fs::OpenOptions::new();
            open.write(true).custom_flags(libc::O_NOFOLLOW);
            if self.pre_existing.contains(&key) {
                open.create(true).truncate(true);
            } else {
                // O_EXCL: the file system refuses a name it treats as one
                // already written by this run.
                open.create_new(true);
            }
            let file = open.open(&dest).map_err(|e| format!("create: {e}"))?;
            self.current = Some((key.clone(), file, dest));
            self.current_len = 0;
        }
        let file = match self.current.as_mut() {
            Some((k, f, _)) if *k == key => f,
            _ => return Err("a chunk arrived for a file whose first chunk never did".into()),
        };
        // In order, with no gap: a chunk past the end would make a sparse
        // file the guest never had to send the bytes for.
        if offset != self.current_len {
            return Err(format!("a chunk at offset {offset} arrived where {} was next", self.current_len));
        }
        let len = data.len() as u64;
        if self.written.saturating_add(len) > self.budget {
            return Err(format!("the outputs are larger than the {} byte output budget", self.budget));
        }
        file.seek(SeekFrom::Start(offset)).map_err(|e| format!("seek: {e}"))?;
        file.write_all(data).map_err(|e| format!("write: {e}"))?;
        self.current_len += len;
        self.written += len;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh dir under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("txr-vm-test-{}", uuid::Uuid::new_v4().simple()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writer_refuses_paths_outside_the_host_dir() {
        let root = TempDir::new();
        let base = root.0.join("base");
        let outside = root.0.join("outside");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let mut w = WriterState::new(out_dirs(&[&base]));
        for evil in ["../outside/x", "/etc/passwd", "a/../../outside/y", "", "./x"] {
            assert!(w.chunk(0, evil, 0, b"no").is_err(), "{evil:?}");
        }
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none());
        w.chunk(0, "sub/ok.txt", 0, b"yes").unwrap();
        w.current = None;
        assert_eq!(std::fs::read(base.join("sub/ok.txt")).unwrap(), b"yes");
        assert!(w.chunk(7, "ok.txt", 0, b"unknown index").is_err());
        assert!(!base.join("ok.txt").exists());
    }

    #[test]
    fn writer_reassembles_chunks_one_file_at_a_time() {
        let root = TempDir::new();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        w.chunk(0, "m/model.bin", 0, b"abc").unwrap();
        w.chunk(0, "m/model.bin", 3, b"def").unwrap();
        w.chunk(0, "empty", 0, b"").unwrap();
        // The previous file was closed when the next one started.
        assert!(w.chunk(0, "m/model.bin", 6, b"late").is_err());
        assert!(w.chunk(0, "missing", 5, b"x").is_err(), "no first chunk");
        w.dir(0, "checkpoints/none").unwrap();
        w.current = None;
        assert_eq!(std::fs::read(root.0.join("m/model.bin")).unwrap(), b"abcdef");
        assert_eq!(std::fs::read(root.0.join("empty")).unwrap(), b"");
        assert!(root.0.join("checkpoints/none").is_dir(), "an empty dir is recreated");
    }

    #[test]
    fn writer_refuses_names_apfs_would_merge() {
        let root = TempDir::new();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        w.chunk(0, "Pred.csv", 0, b"first").unwrap();
        assert!(w.chunk(0, "pred.csv", 0, b"second").is_err(), "case");
        w.chunk(0, "caf\u{e9}.csv", 0, b"nfc").unwrap();
        assert!(w.chunk(0, "cafe\u{301}.csv", 0, b"nfd").is_err(), "Unicode form");
        w.chunk(0, "Model/a.bin", 0, b"a").unwrap();
        assert!(w.chunk(0, "model/b.bin", 0, b"b").is_err(), "directory case");
        w.current = None;
        assert_eq!(std::fs::read(root.0.join("Pred.csv")).unwrap(), b"first", "not overwritten");
        assert!(!root.0.join("Model/b.bin").exists());
    }

    #[test]
    fn writer_may_overwrite_a_file_that_was_there_before_the_run() {
        let root = TempDir::new();
        std::fs::write(root.0.join("old.csv"), b"stale").unwrap();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        w.chunk(0, "old.csv", 0, b"new").unwrap();
        w.current = None;
        assert_eq!(std::fs::read(root.0.join("old.csv")).unwrap(), b"new");
    }

    #[test]
    fn writer_never_follows_a_symlink_already_in_the_output_dir() {
        let root = TempDir::new();
        let out = root.0.join("out");
        let elsewhere = root.0.join("elsewhere");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("important.csv"), b"keep").unwrap();
        std::os::unix::fs::symlink(elsewhere.join("important.csv"), out.join("pred.csv")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, out.join("sub")).unwrap();
        let mut w = WriterState::new(out_dirs(&[&out]));
        assert!(w.chunk(0, "pred.csv", 0, b"evil").is_err());
        assert!(w.chunk(0, "sub/x.csv", 0, b"evil").is_err());
        w.current = None;
        assert_eq!(std::fs::read(elsewhere.join("important.csv")).unwrap(), b"keep");
        assert!(!elsewhere.join("x.csv").exists());
    }

    /// The guest-root builder must produce everything the probe requires and
    /// write the marker from the protocol crate's own declaration; a drift here
    /// would make every freshly built guest root fail the probe.
    #[test]
    fn guest_root_builder_covers_what_the_probe_requires() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let script = std::fs::read_to_string(repo.join(GUEST_ROOT_BUILDER)).unwrap();
        assert!(script.contains(&format!("MARKER_REL={GUEST_PROTOCOL_MARKER}")), "writes the marker");
        assert!(script.contains("AGENT_REL=usr/bin/txresbench-sandbox-agent"));
        for rel in GUEST_ROOT_FILES {
            let rel = if rel == "usr/bin/txresbench-sandbox-agent" { "\"$AGENT_REL\"" } else { rel };
            assert!(script.contains(rel), "the builder checks {rel}");
        }
        let mkdirs = script
            .lines()
            .find(|l| l.starts_with("for d in "))
            .expect("the builder's mount-point loop");
        for rel in GUEST_ROOT_DIRS {
            assert!(
                mkdirs.split_whitespace().any(|w| w.trim_end_matches(';') == rel),
                "the builder creates /{rel}"
            );
        }
        // The builder's sed reads exactly this line.
        let proto =
            std::fs::read_to_string(repo.join("sdk/crates/sandbox-vm-protocol/src/lib.rs")).unwrap();
        for (name, value) in [
            ("PROTOCOL_VERSION", sandbox_vm_protocol::PROTOCOL_VERSION),
            ("PROTOCOL_VERSION_MIN", sandbox_vm_protocol::PROTOCOL_VERSION_MIN),
        ] {
            let decl = format!("pub const {name}: u32 = {value};");
            assert!(proto.lines().any(|l| l == decl), "{decl}");
            let sed = format!(r"s/^pub const {name}: u32 = \([0-9][0-9]*\);$/\1/p");
            assert!(script.contains(&sed), "the builder reads {name}");
        }
        // ...and writes "MIN MAX", which the probe parses.
        assert!(script.contains(r#"printf '%s %s\n' "$MIN_VERSION" "$VERSION" > "$STAGE/$MARKER_REL""#));
        let written = format!("{} {}", sandbox_vm_protocol::PROTOCOL_VERSION_MIN, sandbox_vm_protocol::PROTOCOL_VERSION);
        assert!(marker_serves(&written, app_needs_version()).is_ok());
    }

    #[test]
    fn the_writer_refuses_gaps_out_of_order_chunks_and_the_budget() {
        let root = TempDir::new();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        w.budget = 10;
        w.apply(WriterMsg::Chunk(0, "a.bin".into(), 0, b"12345".to_vec()));
        w.apply(WriterMsg::Chunk(0, "a.bin".into(), 5, b"678".to_vec()));
        assert!(w.errors.is_empty(), "{:?}", w.errors);
        assert_eq!(std::fs::read(root.0.join("a.bin")).unwrap(), b"12345678");
        // A gap would make a sparse file the guest never sent the bytes for:
        // refused, and the partly written file is removed.
        w.apply(WriterMsg::Chunk(0, "gap.bin".into(), 0, b"x".to_vec()));
        w.apply(WriterMsg::Chunk(0, "gap.bin".into(), 1 << 40, b"y".to_vec()));
        assert!(!root.0.join("gap.bin").exists(), "no partial file is left");
        // 9 of 10 bytes used: a 3-byte file is refused before it is created.
        w.apply(WriterMsg::Chunk(0, "b.bin".into(), 0, b"abc".to_vec()));
        assert!(!root.0.join("b.bin").exists());
        assert_eq!(w.errors.len(), 2, "{:?}", w.errors);
        // The finished file is untouched by the later failures.
        assert_eq!(std::fs::read(root.0.join("a.bin")).unwrap(), b"12345678");
    }

    #[test]
    fn a_file_that_fails_part_way_is_removed_even_if_it_existed_before() {
        let root = TempDir::new();
        std::fs::write(root.0.join("pred.csv"), b"old").unwrap();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        w.apply(WriterMsg::Chunk(0, "pred.csv".into(), 0, b"new-part".to_vec()));
        w.apply(WriterMsg::Chunk(0, "pred.csv".into(), 99, b"x".to_vec()));
        assert!(!root.0.join("pred.csv").exists(), "never left truncated or half written");
        assert_eq!(w.errors.len(), 1);
    }

    #[test]
    fn merged_lists_are_sorted_with_one_more_line_at_the_end() {
        let mut agent = Vec::new();
        for i in 0..60 {
            push_listed(&mut agent, format!("z{i:02}: skipped"));
        }
        let mut writer = Vec::new();
        for i in 0..55 {
            push_listed(&mut writer, format!("a{i:02}: write"));
        }
        let mut all = agent;
        all.push("the output copy-back stalled".into());
        all.extend(writer);
        finish_listed(&mut all);
        assert_eq!(all.len(), MAX_LISTED + 1);
        assert!(all[..MAX_LISTED].windows(2).all(|w| w[0] <= w[1]), "sorted");
        assert_eq!(all.iter().filter(|e| e.starts_with(MORE_NOT_LISTED)).count(), 1);
        assert!(all[MAX_LISTED].starts_with(MORE_NOT_LISTED));
        // A short list is only sorted.
        let mut short = vec!["b".to_string(), "a".to_string()];
        finish_listed(&mut short);
        assert_eq!(short, vec!["a", "b"]);
    }

    #[test]
    fn over_long_paths_names_and_too_many_outputs_are_refused() {
        let root = TempDir::new();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        let long_name = "n".repeat(MAX_NAME_BYTES + 1);
        assert!(w.chunk(0, &long_name, 0, b"x").is_err());
        let deep = vec!["a"; MAX_REL_PATH_BYTES / 2 + 1].join("/");
        assert!(deep.len() > MAX_REL_PATH_BYTES);
        assert!(w.dir(0, &deep).is_err());
        assert!(w.symlink(0, &deep, "x").is_err());
        assert!(w.names.is_empty(), "nothing was recorded for refused paths");
        w.entries = MAX_OUTPUT_ENTRIES;
        assert!(w.chunk(0, "one-too-many.csv", 0, b"x").is_err());
    }

    #[test]
    fn names_the_file_system_folds_together_are_refused() {
        // Only meaningful where the volume folds names (the Mac default).
        let probe = TempDir::new();
        std::fs::create_dir(probe.0.join("Straße")).unwrap();
        let folds_case = std::fs::symlink_metadata(probe.0.join("straße")).is_ok();
        let folds_sharp_s = std::fs::symlink_metadata(probe.0.join("strasse")).is_ok();
        if !folds_case {
            eprintln!("this volume is case-sensitive; nothing to check");
            return;
        }
        // An existing dir under another spelling (not written by this run).
        let root = TempDir::new();
        std::fs::create_dir(root.0.join("Data")).unwrap();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        assert!(w.chunk(0, "data/x.csv", 0, b"x").is_err());
        w.chunk(0, "Data/y.csv", 0, b"y").unwrap(); // the exact name is fine
        w.current = None;
        if folds_sharp_s {
            // Two guest dirs fold_name keeps apart but APFS merges.
            w.chunk(0, "straße/a.csv", 0, b"a").unwrap();
            w.current = None;
            assert!(w.chunk(0, "strasse/b.csv", 0, b"b").is_err());
        }
    }

    #[test]
    fn line_capture_splits_lines_across_and_within_frames() {
        let mut cap = LineCapture::new(LOG_PHASE_STDOUT, false);
        cap.push(b"a\nb\nc", None);
        cap.push(b"d\n\n\ne", None);
        cap.finish(None);
        assert_eq!(cap.buf, b"a\nb\ncd\n\n\ne");
    }

    #[test]
    fn the_sweep_spares_a_new_unlocked_dir_and_removes_an_old_one() {
        let root = TempDir::new();
        let tree = root.0.join("txr-vm");
        let young = tree.join(format!("young-{}", uuid::Uuid::new_v4().simple()));
        let old = tree.join(format!("old-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&young).unwrap();
        std::fs::create_dir_all(&old).unwrap();
        let two_min_ago = std::time::SystemTime::now() - Duration::from_secs(120);
        std::fs::File::open(&old).unwrap().set_modified(two_min_ago).unwrap();
        sweep_stale_dirs_in(&[(root.0.clone(), "txr-vm")]);
        assert!(young.is_dir(), "an owner may be about to take its lock");
        assert!(!old.exists(), "an old dir without a lock is stale");
    }

    #[test]
    fn image_clones_are_staged_under_the_app_data_dir() {
        let data = TempDir::new();
        let _guard = crate::modules::rootfs::scoped_data_root(&data.0);
        let src = data.0.join("cache.img");
        std::fs::write(&src, b"image").unwrap();
        let mut stage = RoStage::for_images().unwrap();
        let copy = stage.stage_file(&src).unwrap();
        assert!(copy.starts_with(data.0.join("tmp").join("txr-vm-images")), "{}", copy.display());
        assert_eq!(std::fs::read(&copy).unwrap(), b"image");
    }

    #[test]
    fn the_marker_range_must_cover_what_the_app_needs() {
        assert_eq!(app_needs_version(), sandbox_vm_protocol::PROTOCOL_VERSION);
        assert_eq!(app_needs_version(), 3);
        assert!(marker_serves("3 3\n", 3).is_ok());
        assert!(marker_serves("3", 3).is_ok());
        assert!(marker_serves("2 4", 3).is_ok());
        // A guest root built before v3 (its agent would read a v3 request as
        // asking for the old write-back) is refused before any VM boots.
        assert!(marker_serves("1 2", 3).is_err(), "a v1..v2 agent");
        assert!(marker_serves("4 5", 3).is_err(), "an agent that dropped v3");
        assert!(marker_serves("3 1", 3).is_err());
        assert!(marker_serves("three", 3).is_err());
        assert!(marker_serves("", 3).is_err());
    }

    #[test]
    fn guest_fed_lists_are_bounded() {
        let mut list = Vec::new();
        for i in 0..10_000 {
            push_listed(&mut list, format!("{i}: {}", "x".repeat(5_000)));
        }
        assert_eq!(list.len(), MAX_LISTED + 1, "the first entries plus one 'more' line");
        assert!(list[..MAX_LISTED].iter().all(|e| e.chars().count() <= MAX_ENTRY_CHARS));
        assert!(list[MAX_LISTED].contains("more not listed"));
    }

    #[test]
    fn a_symlink_frame_with_an_unsafe_path_is_an_error_not_a_note() {
        let root = TempDir::new();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        for bad in ["../../x", "/abs", "", "a/./b", "a/../b", "a//b", "a/", "./a", "."] {
            assert!(w.symlink(0, bad, "/etc").is_err(), "{bad:?}");
            assert!(w.chunk(0, bad, 0, b"x").is_err(), "{bad:?} as a file");
        }
        // The escape this guards against: `a/./x` is one level deep on disk,
        // but would be counted as two, so `../../y` would be written as a
        // link climbing out of the dir.
        assert!(w.symlink(0, "a/./x", "../../y").is_err());
        assert!(std::fs::symlink_metadata(root.0.join("a/x")).is_err());
        assert!(w.symlink(7, "x", "/etc").is_err(), "unknown dir index");
        assert!(w.notes.is_empty());
    }

    #[test]
    fn a_failed_lock_is_retried_without_emptying_the_dir() {
        let tree = format!("txr-vm-retrytest-{}", uuid::Uuid::new_v4().simple());
        let dir = std::env::temp_dir().join(&tree).join(std::process::id().to_string());
        std::fs::create_dir_all(dir.join(".lock")).unwrap(); // cannot be opened: no lock
        process_dir(&tree);
        std::fs::write(dir.join("in-flight"), b"x").unwrap();
        std::fs::remove_dir(dir.join(".lock")).unwrap(); // now it can be
        process_dir(&tree);
        assert!(dir.join("in-flight").exists(), "the retry empties nothing");
        let held = PROCESS_LOCKS.lock().unwrap();
        let key = dir.to_string_lossy().into_owned();
        assert!(matches!(held.get(&key), Some(Some(_))), "the retry took the lock");
        drop(held);
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join(&tree));
    }

    #[test]
    fn a_process_dir_that_cannot_be_locked_is_never_emptied() {
        // `.lock` is a directory, so it cannot be opened for writing: the
        // first use cannot lock, so it must not empty the dir, and no later
        // use may either (runs may be using it by then).
        let tree = format!("txr-vm-locktest-{}", uuid::Uuid::new_v4().simple());
        let dir = std::env::temp_dir().join(&tree).join(std::process::id().to_string());
        std::fs::create_dir_all(dir.join(".lock")).unwrap();
        std::fs::write(dir.join("before"), b"x").unwrap();
        assert_eq!(process_dir(&tree), dir);
        assert!(dir.join("before").exists(), "not emptied without the lock");
        std::fs::write(dir.join("in-flight"), b"x").unwrap();
        assert_eq!(process_dir(&tree), dir);
        assert!(dir.join("before").exists() && dir.join("in-flight").exists(), "a later use empties nothing");
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join(&tree));
    }

    #[test]
    fn a_process_dir_is_emptied_only_on_its_first_use() {
        let tree = format!("txr-vm-emptytest-{}", uuid::Uuid::new_v4().simple());
        let dir = std::env::temp_dir().join(&tree).join(std::process::id().to_string());
        std::fs::create_dir_all(dir.join("left-by-a-dead-process")).unwrap();
        assert_eq!(process_dir(&tree), dir);
        assert!(!dir.join("left-by-a-dead-process").exists(), "the first use cleans");
        std::fs::create_dir_all(dir.join("in-flight")).unwrap();
        process_dir(&tree);
        assert!(dir.join("in-flight").exists(), "a later use does not");
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join(&tree));
    }

    #[test]
    fn staged_inputs_keep_their_symlinks_as_stored() {
        let src = TempDir::new();
        std::fs::write(src.0.join("model_v3.rds"), b"m").unwrap();
        std::os::unix::fs::symlink("model_v3.rds", src.0.join("latest")).unwrap();
        std::fs::create_dir_all(src.0.join("sub")).unwrap();
        std::os::unix::fs::symlink("/model/model_v3.rds", src.0.join("sub/abs")).unwrap();
        let mut stage = RoStage::new().unwrap();
        let copy = stage.stage(&src.0).unwrap();
        assert_eq!(std::fs::read_link(copy.join("latest")).unwrap(), PathBuf::from("model_v3.rds"));
        assert_eq!(std::fs::read(copy.join("latest")).unwrap(), b"m");
        assert_eq!(std::fs::read_link(copy.join("sub/abs")).unwrap(), PathBuf::from("/model/model_v3.rds"));
    }

    #[test]
    fn only_stderr_keeps_a_tail_and_it_is_the_last_bytes() {
        let mut err = LineCapture::new(LOG_PHASE_STDERR, true);
        let mut out = LineCapture::new(LOG_PHASE_STDOUT, false);
        let mut all = Vec::new();
        for i in 0..500u32 {
            let line = format!("line {i:04}\n");
            all.extend_from_slice(line.as_bytes());
            err.push(line.as_bytes(), None);
            out.push(line.as_bytes(), None);
        }
        assert_eq!(err.tail, all[all.len() - STDERR_TAIL_BYTES..]);
        assert!(out.tail.is_empty());
        // One chunk longer than the tail replaces it.
        let big = vec![b'z'; STDERR_TAIL_BYTES + 10];
        err.push(&big, None);
        assert_eq!(err.tail, big[10..]);
    }

    #[tokio::test]
    async fn an_output_for_an_exec_without_output_dirs_is_reported() {
        let mut writer = ArtifactWriter::start(Vec::new(), u64::MAX);
        assert!(writer.thread.is_none(), "no thread for a check");
        writer.send(WriterMsg::Chunk(0, "x.csv".into(), 0, b"x".to_vec())).await;
        let report = writer.finish().await;
        assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
    }

    #[test]
    fn sweep_keeps_locked_dirs_and_removes_unlocked_ones() {
        // Its own root: the test never sweeps the real temp or data dirs.
        let root = TempDir::new();
        let mine = process_dir_in(&root.0, "txr-vm").join("sweep-test");
        std::fs::create_dir_all(&mine).unwrap();
        let dead = root.0.join("txr-vm").join("dead-owner-test");
        std::fs::create_dir_all(dead.join("run")).unwrap();
        std::fs::write(dead.join(".lock"), b"").unwrap(); // nobody holds it
        sweep_stale_dirs_in(&[(root.0.clone(), "txr-vm")]);
        assert!(mine.is_dir(), "this process holds its dir's lock: kept");
        assert!(!dead.exists(), "a dir whose lock is free is removed");
    }

    #[test]
    fn writer_recreates_symlinks_inside_the_dir_only() {
        let root = TempDir::new();
        let out = root.0.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let mut w = WriterState::new(out_dirs(&[&out]));
        w.chunk(0, "pred.csv", 0, b"p").unwrap();
        w.current = None;
        w.symlink(0, "latest.csv", "pred.csv").unwrap();
        w.symlink(0, "sub/abs.csv", "/output/pred.csv").unwrap();
        w.symlink(0, "ckpt/latest", "../ckpt").unwrap();
        w.symlink(0, "d", ".").unwrap();
        // Inside as text, outside once `d` is followed: written without `d`.
        w.symlink(0, "x", "d/../pred.csv").unwrap();
        w.symlink(0, "dangling", "missing.csv").unwrap();
        // Links leaving the dir are left out with a note, not written and not an error.
        w.symlink(0, "esc1", "../outside").unwrap();
        w.symlink(0, "esc2", "/etc/passwd").unwrap();
        w.symlink(0, "esc3", "/outputx/pred.csv").unwrap();
        assert!(w.errors.is_empty(), "{:?}", w.errors);
        assert_eq!(
            w.notes,
            vec!["esc1 -> ../outside", "esc2 -> /etc/passwd", "esc3 -> /outputx/pred.csv"]
        );
        assert_eq!(std::fs::read_link(out.join("latest.csv")).unwrap(), PathBuf::from("pred.csv"));
        assert_eq!(std::fs::read_link(out.join("sub/abs.csv")).unwrap(), PathBuf::from("../pred.csv"));
        assert_eq!(std::fs::read(out.join("sub/abs.csv")).unwrap(), b"p");
        assert_eq!(std::fs::read_link(out.join("ckpt/latest")).unwrap(), PathBuf::from("."));
        assert_eq!(std::fs::read_link(out.join("d")).unwrap(), PathBuf::from("."));
        assert_eq!(std::fs::read_link(out.join("x")).unwrap(), PathBuf::from("pred.csv"));
        assert_eq!(std::fs::read(out.join("x")).unwrap(), b"p");
        assert!(std::fs::symlink_metadata(out.join("dangling")).unwrap().file_type().is_symlink());
        for esc in ["esc1", "esc2", "esc3"] {
            assert!(std::fs::symlink_metadata(out.join(esc)).is_err(), "{esc} is not on the host");
        }
    }

    #[tokio::test]
    async fn writer_thread_reports_errors_and_keeps_good_files() {
        let root = TempDir::new();
        let mut writer = ArtifactWriter::start(out_dirs(&[&root.0]), u64::MAX);
        writer.send(WriterMsg::Chunk(0, "Pred.csv".into(), 0, b"first".to_vec())).await;
        writer.send(WriterMsg::Chunk(0, "pred.csv".into(), 0, b"second".to_vec())).await;
        writer.send(WriterMsg::Chunk(0, "other.csv".into(), 0, b"ok".to_vec())).await;
        let errors = writer.finish().await.errors;
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert_eq!(std::fs::read(root.0.join("other.csv")).unwrap(), b"ok");
    }

    /// End to end on a real VM: an output larger than the guest's /tmp and
    /// than one protocol frame comes back byte-for-byte (dedicated tmpfs +
    /// chunked write-back). Needs the VM runtime and two squashfs images:
    /// `TXR_SANDBOX_VM_LAUNCHER`, `TXR_SANDBOX_GUEST_ROOT`,
    /// `TXR_TEST_BASE_DISK`, `TXR_TEST_LAYER_DISK`.
    #[tokio::test]
    #[ignore = "macOS VM runtime + test images (see the doc comment)"]
    async fn vm_streams_back_a_large_output_in_chunks() {
        let need = |k: &str| PathBuf::from(std::env::var(k).unwrap_or_else(|_| panic!("set {k}")));
        let spec = VmSpec {
            num_vcpus: 1,
            ram_mib: 1024,
            base_disk: need("TXR_TEST_BASE_DISK"),
            layer_disk: need("TXR_TEST_LAYER_DISK"),
            ro_shares: Vec::new(),
        };
        let vm = MethodVm::boot(&spec).await.expect("boot the VM");
        let host = TempDir::new();
        let guest = format!("{GUEST_ARTIFACTS_OUT_DIR}/0");
        let script = format!(
            "dd if=/dev/urandom of={guest}/big.bin bs=1M count=24 2>/dev/null && \
             mkdir -p {guest}/sub && echo hi > {guest}/sub/small.txt"
        );
        let req = ExecRequest {
            protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
            request_id: 1,
            bwrap_path: GUEST_BUSYBOX_PATH.into(),
            argv: vec!["sh".into(), "-c".into(), script],
            timeout_ms: 60_000,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: vec![guest.clone()],
            artifacts: sandbox_vm_protocol::ArtifactOptions {
                tmpfs_size: Some("256m".into()),
                tmpfs_root: Some(GUEST_ARTIFACTS_OUT_DIR.into()),
                ..Default::default()
            },
        };
        let out = vm
            .exec(req, Duration::from_secs(120), None, &out_dirs(&[&host.0]))
            .await
            .expect("exec");
        assert_eq!(out.exit_code, 0, "stderr: {}", String::from_utf8_lossy(&out.stderr));
        let big = std::fs::read(host.0.join("big.bin")).expect("big.bin came back");
        assert_eq!(big.len(), 24 * 1024 * 1024);
        assert_eq!(std::fs::read(host.0.join("sub/small.txt")).unwrap(), b"hi\n");
        // Same bytes as in the guest: compare digests.
        let sum = vm
            .check(&["sha256sum", &format!("{guest}/big.bin")])
            .await
            .expect("guest sha256sum");
        let guest_hex = String::from_utf8_lossy(&sum.stdout).split_whitespace().next().unwrap_or("").to_string();
        use sha2::Digest;
        let host_hex = hex::encode(sha2::Sha256::digest(&big));
        assert_eq!(guest_hex, host_hex);
    }

    /// End to end on a real VM: lines a command writes to the guest progress
    /// FIFO reach the host's sink as progress and milestones (agent reader →
    /// `Frame::Progress` → `forward_progress_bytes`). Same env vars as
    /// `vm_streams_back_a_large_output_in_chunks`.
    #[tokio::test]
    #[ignore = "macOS VM runtime + test images (see vm_streams_back_a_large_output_in_chunks)"]
    async fn vm_progress_lines_reach_the_sink() {
        let need = |k: &str| PathBuf::from(std::env::var(k).unwrap_or_else(|_| panic!("set {k}")));
        let spec = VmSpec {
            num_vcpus: 1,
            ram_mib: 1024,
            base_disk: need("TXR_TEST_BASE_DISK"),
            layer_disk: need("TXR_TEST_LAYER_DISK"),
            ro_shares: Vec::new(),
        };
        let vm = MethodVm::boot(&spec).await.expect("boot the VM");
        let fifo = sandbox_vm_protocol::PROGRESS_GUEST_FIFO_PATH;
        // The command runs straight in the guest (busybox, no bwrap), so it
        // writes the guest FIFO itself; the pause lets the agent's reader take
        // the lines before the command ends.
        let script = format!(
            "printf 'milestone|fit|started\\n' > {fifo} && printf 'train|50|half\\n' > {fifo} && \
             printf 'milestone|fit|done\\n' > {fifo} && sleep 1"
        );
        let req = ExecRequest {
            protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
            request_id: 1,
            bwrap_path: GUEST_BUSYBOX_PATH.into(),
            argv: vec!["sh".into(), "-c".into(), script],
            timeout_ms: 60_000,
            seccomp_fd: None,
            cgroup: None,
            progress: true,
            collect_artifacts: Vec::new(),
            artifacts: Default::default(),
        };
        let rec = Arc::new(Rec(Mutex::new(Vec::new())));
        let sink: Arc<dyn ProgressSink> = rec.clone();
        let out = vm.exec(req, Duration::from_secs(60), Some(&sink), &[]).await.expect("exec");
        assert_eq!(out.exit_code, 0, "stderr: {}", String::from_utf8_lossy(&out.stderr));
        let seen: Vec<String> = rec
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.starts_with("m:") || l.starts_with("p:train"))
            .cloned()
            .collect();
        assert_eq!(seen, vec!["m:fit:started", "p:train:half", "m:fit:done"]);
    }

    /// End to end on a real VM: a command that fails still has its exit code
    /// (sent before the outputs), its outputs come back, and the symlinks it
    /// left are recreated as relative links inside the output dir, including
    /// one written with the dir's sandbox path (`/output/...`). Same env vars
    /// as `vm_streams_back_a_large_output_in_chunks`.
    #[tokio::test]
    #[ignore = "macOS VM runtime + test images (see vm_streams_back_a_large_output_in_chunks)"]
    async fn vm_failed_run_keeps_its_exit_code_outputs_and_symlinks() {
        let need = |k: &str| PathBuf::from(std::env::var(k).unwrap_or_else(|_| panic!("set {k}")));
        let spec = VmSpec {
            num_vcpus: 1,
            ram_mib: 1024,
            base_disk: need("TXR_TEST_BASE_DISK"),
            layer_disk: need("TXR_TEST_LAYER_DISK"),
            ro_shares: Vec::new(),
        };
        let vm = MethodVm::boot(&spec).await.expect("boot the VM");
        let host = TempDir::new();
        let guest = format!("{GUEST_ARTIFACTS_OUT_DIR}/0");
        let script = format!(
            "cd {guest} && echo p > pred.csv && ln -s pred.csv latest.csv && \
             ln -s /output/pred.csv abs.csv && mkdir -p ck/epoch && ln -s epoch ck/last && \
             ln -s missing.csv dangling && ln -s /etc/hostname outside && echo boom >&2 && exit 3"
        );
        let req = ExecRequest {
            protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
            request_id: 1,
            bwrap_path: GUEST_BUSYBOX_PATH.into(),
            argv: vec!["sh".into(), "-c".into(), script],
            timeout_ms: 60_000,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: vec![guest.clone()],
            artifacts: sandbox_vm_protocol::ArtifactOptions {
                tmpfs_size: Some("64m".into()),
                tmpfs_root: Some(GUEST_ARTIFACTS_OUT_DIR.into()),
                ..Default::default()
            },
        };
        let out = vm
            .exec(req, Duration::from_secs(120), None, &out_dirs(&[&host.0]))
            .await
            .expect("exec");
        assert_eq!(out.exit_code, 3, "the command's own exit code");
        assert!(out.incomplete.is_empty(), "{:?}", out.incomplete);
        assert!(String::from_utf8_lossy(&out.stderr_tail).contains("boom"));
        assert_eq!(std::fs::read(host.0.join("pred.csv")).unwrap(), b"p\n");
        let link = |rel: &str| std::fs::read_link(host.0.join(rel)).unwrap();
        assert_eq!(link("latest.csv"), PathBuf::from("pred.csv"));
        assert_eq!(link("abs.csv"), PathBuf::from("pred.csv"));
        assert_eq!(link("ck/last"), PathBuf::from("epoch"));
        assert!(host.0.join("ck/epoch").is_dir());
        assert_eq!(link("dangling"), PathBuf::from("missing.csv"));
        // Left out (outside the dir), reported, and not an incomplete output.
        assert_eq!(out.left_out_symlinks, vec!["outside -> /etc/hostname".to_string()]);
        assert!(std::fs::symlink_metadata(host.0.join("outside")).is_err());
    }

    /// End to end on a real VM: a sparse output whose logical size is over
    /// the budget takes almost no guest RAM, but would come back as its full
    /// size. It is reported, not copied, and almost nothing reaches the host.
    #[tokio::test]
    #[ignore = "macOS VM runtime + test images (see vm_streams_back_a_large_output_in_chunks)"]
    async fn vm_a_sparse_output_over_the_budget_is_refused_not_copied() {
        let need = |k: &str| PathBuf::from(std::env::var(k).unwrap_or_else(|_| panic!("set {k}")));
        let spec = VmSpec {
            num_vcpus: 1,
            ram_mib: 1024,
            base_disk: need("TXR_TEST_BASE_DISK"),
            layer_disk: need("TXR_TEST_LAYER_DISK"),
            ro_shares: Vec::new(),
        };
        let vm = MethodVm::boot(&spec).await.expect("boot the VM");
        let host = TempDir::new();
        let guest = format!("{GUEST_ARTIFACTS_OUT_DIR}/0");
        let script = format!(
            "cd {guest} && dd if=/dev/zero of=sparse.bin bs=1 count=0 seek=3221225472 2>/dev/null && \
             echo ok > small.txt"
        );
        let req = ExecRequest {
            protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
            request_id: 1,
            bwrap_path: GUEST_BUSYBOX_PATH.into(),
            argv: vec!["sh".into(), "-c".into(), script],
            timeout_ms: 60_000,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: vec![guest.clone()],
            artifacts: sandbox_vm_protocol::ArtifactOptions {
                tmpfs_size: Some("64m".into()),
                tmpfs_root: Some(GUEST_ARTIFACTS_OUT_DIR.into()),
                total_cap_bytes: 64 * 1024 * 1024,
                ..Default::default()
            },
        };
        let out = vm
            .exec(req, Duration::from_secs(120), None, &out_dirs(&[&host.0]))
            .await
            .expect("exec");
        assert_eq!(out.exit_code, 0, "stderr: {}", String::from_utf8_lossy(&out.stderr));
        assert!(
            out.incomplete.iter().any(|e| e.starts_with("sparse.bin:")),
            "the over-budget file is reported: {:?}",
            out.incomplete
        );
        assert!(std::fs::metadata(host.0.join("sparse.bin")).is_err(), "not copied");
        assert_eq!(std::fs::read(host.0.join("small.txt")).unwrap(), b"ok\n");
    }

    /// Output dirs mounted at `/output` in the sandbox.
    fn out_dirs(hosts: &[&PathBuf]) -> Vec<OutputDir> {
        hosts
            .iter()
            .map(|h| OutputDir { host: (*h).clone(), sandbox_path: "/output".into() })
            .collect()
    }

    struct Rec(Mutex<Vec<String>>);
    impl ProgressSink for Rec {
        fn progress(&self, f: super::super::backend::ProgressFrame) {
            self.0.lock().unwrap().push(format!("p:{}:{}", f.phase, f.message.unwrap_or_default()));
        }
        fn milestone(&self, f: super::super::backend::MilestoneFrame) {
            self.0.lock().unwrap().push(format!("m:{}:{}", f.id, f.status));
        }
    }

    #[test]
    fn progress_bytes_route_milestones_and_progress() {
        let rec = Rec(Mutex::new(Vec::new()));
        forward_progress_bytes(b"milestone|fit|started", &rec);
        forward_progress_bytes(b"train|50|half", &rec);
        forward_progress_bytes(b"milestone|fit|done\nscore|90|", &rec);
        forward_progress_bytes(b"", &rec);
        assert_eq!(
            *rec.0.lock().unwrap(),
            vec!["m:fit:started", "p:train:half", "m:fit:done", "p:score:"]
        );
    }

    #[test]
    fn line_capture_forwards_lines_and_keeps_the_capture() {
        let rec: Arc<dyn ProgressSink> = Arc::new(Rec(Mutex::new(Vec::new())));
        let mut cap = LineCapture::new(LOG_PHASE_STDOUT, false);
        cap.push(b"one\ntw", Some(rec.as_ref()));
        cap.push(b"o\n", Some(rec.as_ref()));
        cap.push(b"three", Some(rec.as_ref()));
        cap.finish(Some(rec.as_ref()));
        assert_eq!(cap.buf, b"one\ntwo\nthree");
        assert!(!cap.truncated);
    }
}
