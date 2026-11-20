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
//! The runtime (launcher, libkrun, libkrunfw, guest root) ships inside the
//! Mac app as one archive (scripts/build-macos-vm-runtime.sh), unpacked into
//! `<app_data>/sandbox-vm/runtime-<sha12>/` on first use. For development,
//! `TXR_SANDBOX_VM_LAUNCHER` and `TXR_SANDBOX_GUEST_ROOT` point at other
//! builds; without either, the launcher next to the app binary and the guest
//! root under `<app_data>/sandbox-vm/guest-root` are used.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sandbox_vm_protocol::ExecRequest;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::UnixStream;
use txresbench_core::AppError;

use super::backend::ProgressSink;
use super::types::{CgroupMode, HostCapabilities, SeccompMode};

pub use super::vm_exchange::{
    outputs_incomplete, OutputDir, VmExecOutcome, GUEST_ARTIFACTS_OUT_DIR, GUEST_BASE_MOUNT, GUEST_BWRAP_PATH,
    GUEST_EXTRA_MOUNTS_DIR, GUEST_LAYER_MOUNT, GUEST_PROTOCOL_MARKER, GUEST_SECCOMP_FD, VM_OUTPUTS_INCOMPLETE_CODE,
    VM_UNAVAILABLE_CODE,
};
use super::vm_exchange::{app_needs_version, exec_over, marker_serves, vm_error, AgentExec, GUEST_AGENT_PATH};
#[cfg(test)]
use super::vm_exchange::GUEST_BUSYBOX_PATH;

/// The vsock port the agent listens on.
const GUEST_VSOCK_PORT: u32 = 1024;

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
/// macOS AF_UNIX `sun_path` is 104 bytes; keep a margin.
const MAX_SOCKET_PATH: usize = 100;


fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The VM runtime the app ships (scripts/build-macos-vm-runtime.sh): one archive holding
/// `bin/<launcher>`, `lib/` (libkrun, libkrunfw) and `share/guest-root/`, with its sha256 in a
/// sibling `<archive>.sha256`. `TXR_SANDBOX_VM_RUNTIME` names it; else it is looked up in the app
/// bundle's Resources ([`bundled_runtime_archive_from`]).
const RUNTIME_ENV: &str = "TXR_SANDBOX_VM_RUNTIME";
const RUNTIME_RESOURCE_DIR: &str = "sandbox-vm-runtime";
const RUNTIME_ARCHIVE: &str = "sandbox-vm-runtime.tar";
/// Written last into an unpacked runtime, holding the archive's sha256: a runtime dir without it
/// is unfinished and never used.
const RUNTIME_COMPLETE: &str = ".complete";
/// The temporary dir a runtime is unpacked into, `<prefix><pid>`, before it is renamed into place.
const UNPACK_PREFIX: &str = ".runtime-unpack-";

/// The unpacked shipped runtime, set by [`probe_host`] when the app carries one.
static RUNTIME_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Where the app bundle keeps the runtime archive, given the running executable:
/// `<App>.app/Contents/MacOS/<exe>` →
/// `<App>.app/Contents/Resources/resources/sandbox-vm-runtime/sandbox-vm-runtime.tar` (tauri.conf.json
/// lists `resources/sandbox-vm-runtime`; Tauri keeps that relative path under Resources).
fn bundled_runtime_archive_from(exe: &Path) -> Option<PathBuf> {
    let contents = exe.parent()?.parent()?;
    Some(contents.join("Resources").join("resources").join(RUNTIME_RESOURCE_DIR).join(RUNTIME_ARCHIVE))
}

fn runtime_archive() -> Option<PathBuf> {
    env_path(RUNTIME_ENV)
        .or_else(|| std::env::current_exe().ok().and_then(|exe| bundled_runtime_archive_from(&exe)))
        .filter(|p| p.is_file())
}

/// Unpack the shipped runtime `archive` into `<root>/sandbox-vm/runtime-<sha12>/` once, and return
/// that dir. The archive must match the sha256 in `<archive>.sha256`; it is unpacked into a temporary
/// dir, checked, marked complete, then renamed into place, so a half-unpacked runtime is never used.
/// Runtimes from earlier app versions are removed, and so are temporary unpack dirs that processes
/// which are no longer running left behind.
pub(crate) fn ensure_runtime_in(root: &Path, archive: &Path) -> Result<PathBuf, String> {
    let sha_file = PathBuf::from(format!("{}.sha256", archive.display()));
    let expected = std::fs::read_to_string(&sha_file)
        .map_err(|e| format!("cannot read {}: {e}", sha_file.display()))?
        .trim()
        .to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("{} does not hold a sha256", sha_file.display()));
    }
    let base = root.join("sandbox-vm");
    let dir = base.join(format!("runtime-{}", &expected[..12]));
    let complete = |d: &Path| {
        std::fs::read_to_string(d.join(RUNTIME_COMPLETE)).map(|s| s.trim() == expected).unwrap_or(false)
    };
    if !complete(&dir) {
        let actual = sha256_file(archive).map_err(|e| format!("cannot read {}: {e}", archive.display()))?;
        if actual != expected {
            return Err(format!(
                "{} does not match its checksum (sha256 {actual}, expected {expected})",
                archive.display()
            ));
        }
        std::fs::create_dir_all(&base).map_err(|e| format!("create {}: {e}", base.display()))?;
        let tmp = base.join(format!("{UNPACK_PREFIX}{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
        let unpacked = (|| {
            let out = std::process::Command::new("/usr/bin/tar")
                .arg("-xf")
                .arg(archive)
                .arg("-C")
                .arg(&tmp)
                .output()
                .map_err(|e| format!("cannot run tar: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "unpacking {} failed: {}",
                    archive.display(),
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            // macOS's tar copies the archive's quarantine flag (set when the app was downloaded) onto every
            // unpacked file, and Gatekeeper would then refuse to start the launcher or load its libraries.
            // The runtime is the app's own, checked against its sha256 above: clear the flag on what runs
            // on this Mac (bin/, lib/). The guest root is only read by the VM, where Gatekeeper plays no
            // part, and holds read-only dirs (/var/empty) whose flags cannot be changed. `-s` acts on
            // symlinks themselves, never on what they point to.
            for sub in ["bin", "lib"] {
                let part = tmp.join(sub);
                if !part.exists() {
                    continue;
                }
                let out = std::process::Command::new("/usr/bin/xattr")
                    .args(["-drs", "com.apple.quarantine"])
                    .arg(&part)
                    .output()
                    .map_err(|e| format!("cannot run xattr: {e}"))?;
                if !out.status.success() {
                    return Err(format!(
                        "clearing the download quarantine from the VM runtime's {sub}/ failed: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
            }
            if !tmp.join("bin").join(LAUNCHER_BIN).is_file() || !tmp.join("share/guest-root").is_dir() {
                return Err(format!("{} has no bin/{LAUNCHER_BIN} or share/guest-root", archive.display()));
            }
            std::fs::write(tmp.join(RUNTIME_COMPLETE), &expected).map_err(|e| format!("mark complete: {e}"))
        })();
        if let Err(why) = unpacked {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(why);
        }
        if dir.exists() {
            // An unfinished runtime left by an interrupted unpack.
            let _ = std::fs::remove_dir_all(&dir);
        }
        if let Err(e) = std::fs::rename(&tmp, &dir) {
            let _ = std::fs::remove_dir_all(&tmp);
            // Another process may have finished the same runtime first.
            if !complete(&dir) {
                return Err(format!("install {}: {e}", dir.display()));
            }
        }
    }
    // Runtimes of earlier app versions are no longer used, and an unpack dir whose process is gone
    // was left by an unpack that was killed half way. An unpack dir of a live process (another app
    // or server unpacking right now) is kept.
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let stale = if let Some(pid) = name.strip_prefix(UNPACK_PREFIX) {
                pid.parse::<libc::pid_t>()
                    .is_ok_and(|pid| pid > 0 && pid as u32 != std::process::id() && !process_alive(pid))
            } else {
                path != dir && name.starts_with("runtime-")
            };
            if stale {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
    Ok(dir)
}

/// Whether a process with this pid exists. Signal 0 sends nothing, it only checks the pid; a
/// process of another user (EPERM) exists too.
fn process_alive(pid: libc::pid_t) -> bool {
    // SAFETY: kill with signal 0 delivers no signal.
    let rc = unsafe { libc::kill(pid, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

/// The VM launcher binary: `TXR_SANDBOX_VM_LAUNCHER`, else the shipped runtime's, else next to
/// the app's own executable.
pub fn launcher_path() -> PathBuf {
    launcher_path_from(env_path(LAUNCHER_ENV), RUNTIME_DIR.get().map(PathBuf::as_path), std::env::current_exe().ok())
}

fn launcher_path_from(env: Option<PathBuf>, runtime: Option<&Path>, exe: Option<PathBuf>) -> PathBuf {
    env.or_else(|| runtime.map(|r| r.join("bin").join(LAUNCHER_BIN)))
        .or_else(|| exe.and_then(|exe| exe.parent().map(|dir| dir.join(LAUNCHER_BIN))))
        .unwrap_or_else(|| PathBuf::from(LAUNCHER_BIN))
}

/// The guest root (agent + bwrap + busybox userland): `TXR_SANDBOX_GUEST_ROOT`, else the shipped
/// runtime's, else `<app_data>/sandbox-vm/guest-root`.
pub fn guest_root_path() -> PathBuf {
    guest_root_path_from(
        env_path(GUEST_ROOT_ENV),
        RUNTIME_DIR.get().map(PathBuf::as_path),
        &crate::modules::rootfs::data_root(),
    )
}

fn guest_root_path_from(env: Option<PathBuf>, runtime: Option<&Path>, data_root: &Path) -> PathBuf {
    env.or_else(|| runtime.map(|r| r.join("share").join("guest-root")))
        .unwrap_or_else(|| data_root.join("sandbox-vm").join("guest-root"))
}

/// The boot probe: `Ok` with the host capabilities when this Mac can run
/// method VMs, else the reason it cannot. Host-only, run once at module init:
/// file checks plus one short launcher start (to prove libkrun loads).
pub fn probe_host() -> Result<HostCapabilities, String> {
    if std::env::consts::ARCH != "aarch64" {
        return Err("method VMs need an Apple Silicon Mac (libkrun runs arm64 guests only)".into());
    }
    // The runtime the app ships, unless both pieces are pointed elsewhere (development).
    if env_path(LAUNCHER_ENV).is_none() || env_path(GUEST_ROOT_ENV).is_none() {
        if let Some(archive) = runtime_archive() {
            let dir = ensure_runtime_in(&crate::modules::rootfs::data_root(), &archive)
                .map_err(|why| format!("the bundled VM runtime could not be prepared: {why}"))?;
            let _ = RUNTIME_DIR.set(dir);
        }
    }
    let launcher = launcher_path();
    if !launcher.is_file() {
        return Err(format!(
            "the VM launcher is missing at {} (build the app's VM runtime with \
                 scripts/build-macos-vm-runtime.sh, or set {LAUNCHER_ENV})",
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

/// Where the per-run copies live — image clones and the copies of the run's
/// inputs (the user's files, a saved model): under the app data dir, not the
/// system temp dir. Copies of the user's files stay with the rest of the
/// app's data (its folder and volume), and an image or a saved model is on
/// the same volume as its copy, so `std::fs::copy` can clone instead of
/// copying gigabytes when $TMPDIR is on another volume.
fn stage_root() -> PathBuf {
    crate::modules::rootfs::data_root().join("tmp")
}

/// The trees the startup sweep cleans: (root, tree). The VM run dirs stay in
/// the system temp dir (see [`make_run_dir`]). Input copies were made there
/// too by earlier app versions, so that place is still swept for what a
/// crash under one of them left.
fn swept_trees() -> [(PathBuf, &'static str); 4] {
    let tmp = std::env::temp_dir();
    [
        (tmp.clone(), "txr-vm"),
        (stage_root(), "txr-vm-inputs"),
        (stage_root(), "txr-vm-images"),
        (tmp, "txr-vm-inputs"),
    ]
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
    /// A stage for read-only input dirs, under the app data dir ([`stage_root`]).
    pub fn new() -> Result<Self, AppError> {
        Self::under(process_dir_in(&stage_root(), "txr-vm-inputs"))
    }

    /// A stage for environment image clones, on the image cache's volume.
    pub fn for_images() -> Result<Self, AppError> {
        Self::under(process_dir_in(&stage_root(), "txr-vm-images"))
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
/// under the system temp dir, unlike the input copies ([`stage_root`]), so the
/// socket path fits `sun_path` ([`MAX_SOCKET_PATH`]): macOS's temp dir has a
/// fixed, short path (and $TMPDIR can shorten it), while the app data dir can
/// be any folder (`TXR_APP_DATA_DIR`). It holds no user data: the launch
/// config, the socket and the empty workspace share.
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

    /// Run one command in the VM and collect its result: the shared exchange
    /// ([`exec_over`]) over this VM's vsock bridge.
    pub async fn exec(
        &self,
        req: ExecRequest,
        host_budget: Duration,
        sink: Option<&Arc<dyn ProgressSink>>,
        artifact_dirs: &[OutputDir],
    ) -> Result<VmExecOutcome, AppError> {
        exec_over(self.connect().await?, req, host_budget, sink, artifact_dirs).await
    }

    /// The layer's bind entries and the wrapper command, read inside the VM
    /// ([`super::vm_exchange::read_layer_plan`]).
    pub async fn read_layer_plan(&self) -> Result<(Vec<String>, String), AppError> {
        super::vm_exchange::read_layer_plan(self).await
    }
}

impl AgentExec for MethodVm {
    fn exec(
        &self,
        req: ExecRequest,
        host_budget: Duration,
        sink: Option<&Arc<dyn ProgressSink>>,
        artifact_dirs: &[OutputDir],
    ) -> impl std::future::Future<Output = Result<VmExecOutcome, AppError>> + Send {
        MethodVm::exec(self, req, host_budget, sink, artifact_dirs)
    }
}

#[cfg(test)]
impl MethodVm {
    /// A read-only busybox check in the VM ([`super::vm_exchange::check`]).
    async fn check(&self, argv: &[&str]) -> Result<VmExecOutcome, AppError> {
        super::vm_exchange::check(self, argv).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::stack;
    use sandbox_vm_protocol::{encode, Decoder, Frame};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
        // The builder reads the versions with `guest_protocol_range`, shared with the WSL
        // root builder in scripts/guest-root-common.sh, whose sed reads exactly this line.
        assert!(
            script.lines().any(|l| l == r#". "$ROOT/scripts/guest-root-common.sh""#),
            "the builder sources the shared helper"
        );
        assert!(
            script.lines().any(|l| l.starts_with(r#"guest_protocol_range "$ROOT""#)),
            "the builder calls guest_protocol_range"
        );
        let common = std::fs::read_to_string(repo.join("scripts/guest-root-common.sh")).unwrap();
        let range = common
            .split("\nguest_protocol_range() {\n")
            .nth(1)
            .and_then(|rest| rest.split("\n}\n").next())
            .expect("guest_protocol_range in scripts/guest-root-common.sh");
        assert!(
            range.contains(r#"_src="$1/sdk/crates/sandbox-vm-protocol/src/lib.rs""#),
            "guest_protocol_range reads the protocol crate"
        );
        let proto =
            std::fs::read_to_string(repo.join("sdk/crates/sandbox-vm-protocol/src/lib.rs")).unwrap();
        for (name, var, value) in [
            ("PROTOCOL_VERSION", "GUEST_PROTOCOL_MAX", sandbox_vm_protocol::PROTOCOL_VERSION),
            ("PROTOCOL_VERSION_MIN", "GUEST_PROTOCOL_MIN", sandbox_vm_protocol::PROTOCOL_VERSION_MIN),
        ] {
            let decl = format!("pub const {name}: u32 = {value};");
            assert!(proto.lines().any(|l| l == decl), "{decl}");
            let sed = format!(r#"{var}=$(sed -n 's/^pub const {name}: u32 = \([0-9][0-9]*\);$/\1/p' "$_src")"#);
            assert!(range.lines().any(|l| l.trim() == sed), "guest_protocol_range reads {name} into {var}");
        }
        assert!(script.lines().any(|l| l == "VERSION=$GUEST_PROTOCOL_MAX"), "the builder's VERSION is the max");
        assert!(script.lines().any(|l| l == "MIN_VERSION=$GUEST_PROTOCOL_MIN"), "the builder's MIN_VERSION is the min");
        // ...and writes "MIN MAX", which the probe parses.
        assert!(script.contains(r#"printf '%s %s\n' "$MIN_VERSION" "$VERSION" > "$STAGE/$MARKER_REL""#));
        let written = format!("{} {}", sandbox_vm_protocol::PROTOCOL_VERSION_MIN, sandbox_vm_protocol::PROTOCOL_VERSION);
        assert!(marker_serves(&written, app_needs_version()).is_ok());
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
    fn input_copies_are_staged_under_the_app_data_dir() {
        let data = TempDir::new();
        let _guard = crate::modules::rootfs::scoped_data_root(&data.0);
        let src = TempDir::new();
        std::fs::write(src.0.join("patient.tsv"), b"input").unwrap();
        let mut stage = RoStage::new().unwrap();
        let copy = stage.stage(&src.0).unwrap();
        assert!(copy.starts_with(data.0.join("tmp").join("txr-vm-inputs")), "{}", copy.display());
        assert!(!copy.starts_with(std::env::temp_dir().join("txr-vm-inputs")), "{}", copy.display());
        assert_eq!(std::fs::read(copy.join("patient.tsv")).unwrap(), b"input");
        drop(stage);
        assert!(!copy.exists(), "the copies are removed with the stage");
    }

    #[test]
    fn the_sweep_covers_the_input_copies_under_the_app_data_dir() {
        let data = TempDir::new();
        let _guard = crate::modules::rootfs::scoped_data_root(&data.0);
        let trees = swept_trees();
        let tmp = std::env::temp_dir();
        for (root, tree) in [
            (data.0.join("tmp"), "txr-vm-inputs"),
            (data.0.join("tmp"), "txr-vm-images"),
            // The VM run dirs stay in the temp dir (socket path length), and the
            // input copies earlier versions left there are still removed.
            (tmp.clone(), "txr-vm"),
            (tmp, "txr-vm-inputs"),
        ] {
            assert!(trees.iter().any(|(r, t)| *r == root && *t == tree), "{} {tree} is swept", root.display());
        }
    }

    #[test]
    fn the_runtime_archive_is_looked_up_in_the_app_bundle_resources() {
        let exe = Path::new("/Applications/TxResBench.app/Contents/MacOS/txresbench-desktop");
        assert_eq!(
            bundled_runtime_archive_from(exe).unwrap(),
            Path::new("/Applications/TxResBench.app/Contents/Resources/resources/sandbox-vm-runtime/sandbox-vm-runtime.tar")
        );
    }

    #[test]
    fn env_vars_win_then_the_shipped_runtime_then_the_old_defaults() {
        let runtime = Path::new("/data/sandbox-vm/runtime-abc");
        let exe = Some(PathBuf::from("/A.app/Contents/MacOS/app"));
        let env = Some(PathBuf::from("/dev/launcher"));
        assert_eq!(launcher_path_from(env.clone(), Some(runtime), exe.clone()), PathBuf::from("/dev/launcher"));
        assert_eq!(launcher_path_from(None, Some(runtime), exe.clone()), runtime.join("bin").join(LAUNCHER_BIN));
        assert_eq!(launcher_path_from(None, None, exe), PathBuf::from("/A.app/Contents/MacOS").join(LAUNCHER_BIN));
        let data = Path::new("/data");
        assert_eq!(guest_root_path_from(env.clone(), Some(runtime), data), PathBuf::from("/dev/launcher"));
        assert_eq!(guest_root_path_from(None, Some(runtime), data), runtime.join("share/guest-root"));
        assert_eq!(guest_root_path_from(None, None, data), data.join("sandbox-vm/guest-root"));
    }

    /// A runtime archive like the build script's (bin/<launcher>, share/guest-root/), with its .sha256.
    fn runtime_archive_fixture(dir: &Path, with_launcher: bool, tag: &str) -> PathBuf {
        let stage = dir.join(format!("stage-{tag}"));
        std::fs::create_dir_all(stage.join("bin")).unwrap();
        std::fs::create_dir_all(stage.join("share/guest-root/etc")).unwrap();
        std::fs::write(stage.join("share/guest-root/etc/tag"), tag).unwrap();
        if with_launcher {
            std::fs::write(stage.join("bin").join(LAUNCHER_BIN), "#!/bin/sh\n").unwrap();
        }
        let archive = dir.join(format!("{tag}.tar"));
        let ok = std::process::Command::new("/usr/bin/tar")
            .arg("-cf")
            .arg(&archive)
            .arg("-C")
            .arg(&stage)
            .arg(".")
            .status()
            .unwrap()
            .success();
        assert!(ok);
        let sha = sha256_file(&archive).unwrap();
        std::fs::write(format!("{}.sha256", archive.display()), format!("{sha}\n")).unwrap();
        archive
    }

    #[test]
    fn the_shipped_runtime_is_unpacked_once_then_reused() {
        let t = TempDir::new();
        let data = t.0.join("data");
        let archive = runtime_archive_fixture(&t.0, true, "v1");
        let dir = ensure_runtime_in(&data, &archive).unwrap();
        assert!(dir.join("bin").join(LAUNCHER_BIN).is_file());
        assert_eq!(std::fs::read_to_string(dir.join("share/guest-root/etc/tag")).unwrap(), "v1");
        assert!(dir.join(RUNTIME_COMPLETE).is_file());
        // A complete runtime is reused as it is, not unpacked again.
        std::fs::remove_file(dir.join("share/guest-root/etc/tag")).unwrap();
        assert_eq!(ensure_runtime_in(&data, &archive).unwrap(), dir);
        assert!(!dir.join("share/guest-root/etc/tag").exists(), "unpacked a second time");
        // No temporary unpack dir is left behind.
        let left: Vec<_> = std::fs::read_dir(data.join("sandbox-vm")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 1, "{left:?}");
    }

    fn has_quarantine(path: &Path) -> bool {
        std::process::Command::new("/usr/bin/xattr")
            .args(["-s", "-p", "com.apple.quarantine"])
            .arg(path)
            .output()
            .unwrap()
            .status
            .success()
    }

    #[test]
    fn a_downloaded_runtime_archive_unpacks_without_the_quarantine_flag() {
        let t = TempDir::new();
        let data = t.0.join("data");
        // Like the real runtime: a launcher, a library, and a guest root with an absolute symlink that
        // points nowhere on the Mac and a read-only empty dir (Alpine's /var/empty).
        let stage = t.0.join("stage-q");
        std::fs::create_dir_all(stage.join("bin")).unwrap();
        std::fs::create_dir_all(stage.join("lib")).unwrap();
        std::fs::create_dir_all(stage.join("share/guest-root/bin")).unwrap();
        std::fs::create_dir_all(stage.join("share/guest-root/var/empty")).unwrap();
        std::fs::write(stage.join("bin").join(LAUNCHER_BIN), "#!/bin/sh\n").unwrap();
        std::fs::write(stage.join("lib/libkrun.1.dylib"), "lib").unwrap();
        std::os::unix::fs::symlink("/bin/busybox-not-on-this-mac", stage.join("share/guest-root/bin/sh")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(stage.join("share/guest-root/var/empty"), std::fs::Permissions::from_mode(0o555))
            .unwrap();
        let archive = t.0.join("q.tar");
        assert!(std::process::Command::new("/usr/bin/tar")
            .arg("-cf")
            .arg(&archive)
            .arg("-C")
            .arg(&stage)
            .arg(".")
            .status()
            .unwrap()
            .success());
        std::fs::write(format!("{}.sha256", archive.display()), sha256_file(&archive).unwrap()).unwrap();
        // What a browser download leaves on the app's files.
        assert!(std::process::Command::new("/usr/bin/xattr")
            .args(["-w", "com.apple.quarantine", "0081;00000000;Safari;"])
            .arg(&archive)
            .status()
            .unwrap()
            .success());
        assert!(has_quarantine(&archive));
        let dir = ensure_runtime_in(&data, &archive).unwrap();
        assert!(!has_quarantine(&dir.join("bin").join(LAUNCHER_BIN)), "the launcher kept the quarantine flag");
        assert!(!has_quarantine(&dir.join("lib/libkrun.1.dylib")), "a library kept the quarantine flag");
        assert!(std::fs::symlink_metadata(dir.join("share/guest-root/bin/sh")).unwrap().file_type().is_symlink());
        assert!(dir.join("share/guest-root/var/empty").is_dir());
        // A later version replaces this runtime: the read-only dir does not block removing it.
        let v2 = runtime_archive_fixture(&t.0, true, "v2");
        let next = ensure_runtime_in(&data, &v2).unwrap();
        assert!(!dir.exists() && next.exists());
    }

    #[test]
    fn a_runtime_archive_that_does_not_match_its_checksum_is_refused() {
        let t = TempDir::new();
        let data = t.0.join("data");
        let archive = runtime_archive_fixture(&t.0, true, "v1");
        std::fs::write(format!("{}.sha256", archive.display()), "0".repeat(64)).unwrap();
        let err = ensure_runtime_in(&data, &archive).unwrap_err();
        assert!(err.contains("does not match its checksum"), "{err}");
        assert!(!data.join("sandbox-vm").join(format!("runtime-{}", "0".repeat(12))).exists());
        // A missing or malformed .sha256 is refused too.
        std::fs::write(format!("{}.sha256", archive.display()), "not-a-hash").unwrap();
        assert!(ensure_runtime_in(&data, &archive).unwrap_err().contains("does not hold a sha256"));
    }

    #[test]
    fn a_runtime_archive_without_the_launcher_is_refused_and_leaves_nothing() {
        let t = TempDir::new();
        let data = t.0.join("data");
        let archive = runtime_archive_fixture(&t.0, false, "broken");
        let err = ensure_runtime_in(&data, &archive).unwrap_err();
        assert!(err.contains(LAUNCHER_BIN), "{err}");
        let left: Vec<_> = std::fs::read_dir(data.join("sandbox-vm")).unwrap().flatten().collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn a_new_runtime_replaces_unfinished_and_older_ones() {
        let t = TempDir::new();
        let data = t.0.join("data");
        let v1 = runtime_archive_fixture(&t.0, true, "v1");
        let old = ensure_runtime_in(&data, &v1).unwrap();
        let v2 = runtime_archive_fixture(&t.0, true, "v2");
        // An interrupted earlier unpack of v2: the dir exists but was never marked complete.
        let sha2 = std::fs::read_to_string(format!("{}.sha256", v2.display())).unwrap();
        let unfinished = data.join("sandbox-vm").join(format!("runtime-{}", &sha2.trim()[..12]));
        std::fs::create_dir_all(unfinished.join("bin")).unwrap();
        let dir = ensure_runtime_in(&data, &v2).unwrap();
        assert_eq!(dir, unfinished);
        assert_eq!(std::fs::read_to_string(dir.join("share/guest-root/etc/tag")).unwrap(), "v2");
        assert!(dir.join("bin").join(LAUNCHER_BIN).is_file());
        assert!(!old.exists(), "the earlier version's runtime is removed");
    }

    #[test]
    fn an_unpack_left_by_a_dead_process_is_removed_and_a_live_ones_kept() {
        let t = TempDir::new();
        let data = t.0.join("data");
        let base = data.join("sandbox-vm");
        // A pid that is no longer running: a child that has exited and been reaped.
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        // A pid that is running: the process that started this test.
        let live_pid = std::os::unix::process::parent_id();
        let half = |pid: u32| {
            let d = base.join(format!("{UNPACK_PREFIX}{pid}"));
            std::fs::create_dir_all(d.join("share/guest-root/etc")).unwrap();
            std::fs::write(d.join("share/guest-root/etc/tag"), "half").unwrap();
            d
        };
        let dead = half(dead_pid);
        let live = half(live_pid);
        let v1 = runtime_archive_fixture(&t.0, true, "v1");
        // A start that unpacks the runtime removes the dead process's leftover...
        let dir = ensure_runtime_in(&data, &v1).unwrap();
        assert!(dir.join("bin").join(LAUNCHER_BIN).is_file());
        assert!(!dead.exists(), "the dead process's unpack is removed");
        assert!(live.is_dir(), "a running process's unpack is kept");
        // ...and so does a start that finds the runtime already unpacked.
        let dead = half(dead_pid);
        assert_eq!(ensure_runtime_in(&data, &v1).unwrap(), dir);
        assert!(!dead.exists(), "removed when the runtime is reused too");
        assert!(live.is_dir(), "still kept");
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
        // The copies go under the app data dir: a test's own, never the real one.
        let data = TempDir::new();
        let _guard = crate::modules::rootfs::scoped_data_root(&data.0);
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

    // ── read_layer_plan through a fake agent (the in-VM link probe) ────────────

    /// A reply a test puts in place of running a request: `(stdout, exit code,
    /// timed out)`.
    type Reply = Arc<dyn Fn(&ExecRequest) -> Option<(Vec<u8>, i32, bool)> + Send + Sync>;

    /// A `MethodVm` whose socket is served by a fake guest agent: each request
    /// runs on the host (its busybox applet, `cat` or `sh`, from PATH) with the
    /// guest image mounts mapped to `base` and `layer`, unless `reply` answers
    /// it, and comes back as the agent's frames. Returns the requests it got.
    async fn vm_with_fake_agent(
        base: &Path,
        layer: &Path,
        reply: Reply,
    ) -> (MethodVm, Arc<Mutex<Vec<ExecRequest>>>) {
        let id = uuid::Uuid::new_v4().simple().to_string();
        // Short: the socket path must fit sun_path.
        let run_dir = std::env::temp_dir().join(format!("w41-{}", &id[..8]));
        std::fs::create_dir_all(&run_dir).unwrap();
        let socket_path = run_dir.join("a.sock");
        let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
        let requests: Arc<Mutex<Vec<ExecRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let (base, layer) = (base.to_string_lossy().into_owned(), layer.to_string_lossy().into_owned());
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut decoder = Decoder::new();
                let mut buf = vec![0u8; 64 * 1024];
                let req = loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break None,
                        Ok(n) => decoder.feed(&buf[..n]),
                    }
                    if let Ok(Some(Frame::Exec(req))) = decoder.next_frame() {
                        break Some(req);
                    }
                };
                let Some(req) = req else { continue };
                seen.lock().unwrap().push(req.clone());
                let (stdout, stderr, code, timed_out) = match reply(&req) {
                    Some((stdout, code, timed_out)) => (stdout, Vec::new(), code, timed_out),
                    None => {
                        let argv: Vec<String> = req
                            .argv
                            .iter()
                            .map(|a| a.replace(GUEST_BASE_MOUNT, &base).replace(GUEST_LAYER_MOUNT, &layer))
                            .collect();
                        let out = tokio::process::Command::new(&argv[0])
                            .args(&argv[1..])
                            .output()
                            .await
                            .unwrap();
                        (out.stdout, out.stderr, out.status.code().unwrap_or(-1), false)
                    }
                };
                let exit = sandbox_vm_protocol::ExitStatus { code, timed_out };
                for frame in [Frame::Stdout(stdout), Frame::Stderr(stderr), Frame::Exit(exit), Frame::ArtifactsDone] {
                    let _ = stream.write_all(&encode(&frame)).await;
                }
            }
        });
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        (MethodVm { child, socket_path, run_dir }, requests)
    }

    fn no_reply() -> Reply {
        Arc::new(|_| None)
    }

    /// The link probe's request: the only check whose first pair names the base mount.
    fn is_link_probe(req: &ExecRequest) -> bool {
        req.argv.get(4).map(String::as_str) == Some(GUEST_BASE_MOUNT)
    }

    /// A base and a layer the plan accepts (links only deeper inside bound
    /// dirs), with a layer manifest naming `/code` and `/opt/txr-layer`.
    fn plan_images(root: &Path) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::symlink;
        let (base, layer) = (root.join("base"), root.join("layer"));
        for dir in ["usr/bin", "etc/ssl/certs", "opt/txr-layer"] {
            std::fs::create_dir_all(base.join(dir)).unwrap();
        }
        symlink("/oldroot/etc/shadow", base.join("etc/ssl/certs/ca.pem")).unwrap();
        for dir in ["code", "opt/txr-layer/bin"] {
            std::fs::create_dir_all(layer.join(dir)).unwrap();
        }
        std::fs::write(layer.join("code/run.sh"), "").unwrap();
        symlink("/oldroot/home", layer.join("opt/txr-layer/bin/home")).unwrap();
        std::fs::write(layer.join(stack::LAYER_MANIFEST_FILE), br#"["/code", "/opt/txr-layer"]"#).unwrap();
        (base, layer)
    }

    // The plan asks the VM about every image path a bind uses, with the exact
    // guest argv, right after the manifest is read and before the other checks.
    #[tokio::test]
    async fn layer_plan_probes_the_bind_sources_in_the_vm() {
        let root = TempDir::new();
        let (base, layer) = plan_images(&root.0);
        let (vm, requests) = vm_with_fake_agent(&base, &layer, no_reply()).await;
        let (entries, command) = vm.read_layer_plan().await.expect("clean images pass");
        assert_eq!(entries, vec!["/code".to_string(), "/opt/txr-layer".to_string()]);
        assert_eq!(command, "bash /code/run.sh");
        let requests = requests.lock().unwrap().clone();
        let probe = stack::BindSourceProbe::new(&entries, GUEST_BASE_MOUNT, GUEST_LAYER_MOUNT).unwrap();
        assert_eq!(requests.len(), 5, "manifest, links, parents, method.json, scripts");
        assert_eq!(requests[1].bwrap_path, GUEST_BUSYBOX_PATH, "busybox, outside bwrap");
        assert_eq!(requests[1].argv, probe.argv(), "the probe's own argv, guest paths");
        assert_eq!(requests.iter().filter(|r| is_link_probe(r)).count(), 1);
    }

    // A link in a layer entry, in a base bind or in the base where a layer
    // entry's bind lands is refused with its code before any later check, in
    // plain words that name no guest mount; the probe ran for real in `/bin/sh`.
    #[tokio::test]
    async fn layer_plan_refuses_a_linked_bind_source() {
        for (image, rel, target, code, says) in [
            (
                "layer",
                "opt/txr-layer",
                "/oldroot/home/user",
                stack::ENV_LAYER_ENTRY_INVALID_CODE,
                "The method image is refused: its path /opt/txr-layer is a symbolic link",
            ),
            (
                "layer",
                "code",
                "../../../../oldroot/home",
                stack::ENV_LAYER_ENTRY_INVALID_CODE,
                "The method image is refused: its path /code is a symbolic link",
            ),
            (
                "base",
                "usr",
                "/oldroot/usr",
                stack::ROOTFS_PATH_INVALID_CODE,
                "The base image is refused: its path /usr is a symbolic link",
            ),
            (
                "base",
                "opt/txr-layer",
                "/oldroot/home/user/created-by-bwrap",
                stack::ENV_LAYER_ENTRY_INVALID_CODE,
                "puts files at /opt/txr-layer, and in the base image that path is a symbolic link",
            ),
            (
                "base",
                "code",
                "/oldroot/home/user",
                stack::ENV_LAYER_ENTRY_INVALID_CODE,
                "puts files at /code, and in the base image that path is a symbolic link",
            ),
        ] {
            let root = TempDir::new();
            let (base, layer) = plan_images(&root.0);
            let path = if image == "base" { base.join(rel) } else { layer.join(rel) };
            if path.exists() {
                std::fs::remove_dir_all(&path).unwrap();
            }
            std::os::unix::fs::symlink(target, &path).unwrap();
            let (vm, requests) = vm_with_fake_agent(&base, &layer, no_reply()).await;
            let err = vm.read_layer_plan().await.expect_err("a linked bind source is refused");
            assert_eq!(err.error_code(), code, "{image} {rel}: {err}");
            let text = err.to_string();
            assert!(text.contains(says), "{image} {rel}: {text}");
            assert!(!text.contains(GUEST_BASE_MOUNT) && !text.contains(GUEST_LAYER_MOUNT), "{text}");
            assert!(!text.contains(") (") && !text.contains("bind"), "{text}");
            assert_eq!(requests.lock().unwrap().len(), 2, "refused right after the probe");
        }
    }

    // A probe that fails, times out, is cut off, could not look, or answers
    // something else is a VM error that says why: the plan is never read as
    // "no links".
    #[tokio::test]
    async fn layer_plan_fails_closed_on_a_broken_probe() {
        // Valid but cut off: empty lines name nothing, so only the cut-off
        // flag stops the plan.
        let too_long = vec![b'\n'; super::super::sandbox::OUTPUT_CAP_BYTES + 1];
        for (stdout, code, timed_out, why) in [
            (b"garbage\n".to_vec(), 0, false, "it gave an unexpected answer \"garbage\""),
            (Vec::new(), 1, false, "the check failed with exit status 1"),
            (b"99\n".to_vec(), 0, false, "it gave an unexpected answer \"99\""),
            (b"unreadable 0\n".to_vec(), 0, false, "a folder on the path /usr of the base image could not be read"),
            (Vec::new(), -1, true, "the check timed out"),
            (too_long, 0, false, "its answer was too long"),
        ] {
            let root = TempDir::new();
            let (base, layer) = plan_images(&root.0);
            let answer = stdout.clone();
            let reply: Reply = Arc::new(move |req| is_link_probe(req).then(|| (answer.clone(), code, timed_out)));
            let (vm, requests) = vm_with_fake_agent(&base, &layer, reply).await;
            let err = vm.read_layer_plan().await.expect_err("a broken probe fails the plan");
            assert_eq!(err.error_code(), VM_UNAVAILABLE_CODE, "{why}: {err}");
            assert_eq!(
                err.to_string(),
                format!("The method VM could not check the method and base images for symbolic links: {why}"),
                "exit {code}, timed out {timed_out}, {} bytes",
                stdout.len()
            );
            assert_eq!(requests.lock().unwrap().len(), 2);
        }
    }
}
