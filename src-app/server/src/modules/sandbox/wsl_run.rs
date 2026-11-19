//! Windows stacked method runs: the guest agent in an app-owned WSL 2 distro.
//!
//! Linux runs a method by mounting the base + layer squashfs images on the host
//! and spawning bwrap over them; macOS boots a per-run Linux VM
//! (`mac_vm_run`). Windows has neither, but WSL 2 runs a real Linux kernel, so
//! this seam runs the SAME guest agent as the macOS VM inside a WSL distro the
//! app owns ([`WSL_DISTRO`], imported once from the guest root the app ships):
//!
//! - each request to the agent is one `wsl.exe -d TxResBench -u root --exec
//!   txresbench-sandbox-agent --stdio --base <img> --layer <img> --ro <dir>...`
//!   process, speaking `sandbox-vm-protocol` over its stdin/stdout (the shared
//!   exchange in `vm_exchange`); the agent mounts everything in a private mount
//!   namespace, so nothing is left mounted in the distro after a request;
//! - the images and the read-only inputs stay where they are on the Windows
//!   disk and are read through WSL's `/mnt/<drive>` mounts: the images are held
//!   open for the whole run so that nothing can change or delete them
//!   ([`ImageHold`]), and verified against their digests first;
//! - the agent presents the same guest paths as the macOS VM, so the stacked
//!   bwrap argv, the request and the output copy-back are those of the macOS
//!   seam (`service::run_method_in_stack`, Windows); bwrap's `--unshare-net`
//!   keeps the method off the network;
//! - the distro cannot start Windows programs (its `wsl.conf` turns interop
//!   off).
//!
//! What the user must have: WSL installed (`wsl --install --no-distribution`,
//! which needs admin rights and a restart once) and new enough
//! ([`wsl_version_ok`]). The probe ([`probe_host`]) says which step is missing.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::StatusCode;
use sandbox_vm_protocol::ExecRequest;
use tokio::io::AsyncReadExt;
use txresbench_core::AppError;

use super::backend::ProgressSink;
use super::types::{CgroupMode, HostCapabilities, SeccompMode};
use super::vm_exchange::{
    app_needs_version, exec_over, marker_serves, AgentExec, OutputDir, VmExecOutcome, GUEST_AGENT_PATH,
    GUEST_BUSYBOX_PATH, GUEST_BWRAP_PATH,
};

/// The app's own WSL distro.
pub const WSL_DISTRO: &str = "TxResBench";

/// The file in the distro holding its build id (written by
/// `scripts/build-wsl-rootfs.sh`): proves the distro is the app's, and which
/// build it is.
const DISTRO_VERSION_FILE: &str = "/etc/txresbench-wsl-version";

/// Development override: a dir holding the rootfs tarball and its manifest.
const RUNTIME_ENV: &str = "TXR_WSL_RUNTIME";
/// Where the Windows bundle keeps them, next to the app executable
/// (`tauri.windows.conf.json` lists `resources/wsl-runtime`).
const RUNTIME_RESOURCE_DIR: &str = "wsl-runtime";
/// A plain tar: `wsl --import` reads it on every WSL version (the installer
/// compresses the app anyway).
const ROOTFS_FILE: &str = "txresbench-wsl.tar";
const MANIFEST_FILE: &str = "MANIFEST.json";

/// The WSL runner could not be prepared or reached.
pub const WSL_UNAVAILABLE_CODE: &str = "SANDBOX_WSL_UNAVAILABLE";

/// The command the messages tell the user to run to get WSL. The install
/// command without `--no-distribution` would also install and start a Linux
/// distribution (Ubuntu) the app does not use; the app imports its own.
const WSL_INSTALL_COMMAND: &str = "wsl --install --no-distribution";

/// `CREATE_NO_WINDOW`: wsl.exe is a console program; started from the
/// desktop app it would otherwise flash a console window per request.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Budgets for the wsl.exe management commands (`--version`, `--list`,
/// `--import`, `--unregister`) and for the distro check, which may have to
/// start the WSL VM.
const WSL_QUERY_TIMEOUT: Duration = Duration::from_secs(20);
const WSL_IMPORT_TIMEOUT: Duration = Duration::from_secs(600);
const WSL_START_TIMEOUT: Duration = Duration::from_secs(120);

/// Agent exit codes (the WSL mode's contract): bad arguments, a mount or
/// setup failure, a transport or protocol failure.
const AGENT_EXIT_BAD_ARGS: i32 = 2;
const AGENT_EXIT_SETUP: i32 = 3;
const AGENT_EXIT_TRANSPORT: i32 = 4;

/// How much of an agent's stderr (its log) is kept for error messages.
const AGENT_STDERR_KEEP: usize = 8 * 1024;

fn wsl_error(message: impl Into<String>) -> AppError {
    AppError::new(StatusCode::SERVICE_UNAVAILABLE, WSL_UNAVAILABLE_CODE, message.into())
}

/// wsl.exe by its full path under the Windows directory, never from PATH.
fn wsl_exe() -> PathBuf {
    let windows = std::env::var_os("SystemRoot")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    windows.join("System32").join("wsl.exe")
}

/// A wsl.exe command line: UTF-8 messages (`WSL_UTF8=1`; by default wsl.exe
/// prints its own messages in UTF-16) and no console window.
fn wsl_command() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new(wsl_exe());
    cmd.env("WSL_UTF8", "1").creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// What a finished wsl.exe command printed.
struct WslOutput {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl WslOutput {
    fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// Both streams, as one message (wsl.exe prints its errors on either).
    fn text(&self) -> String {
        let mut t = self.stdout.trim().to_string();
        let e = self.stderr.trim();
        if !e.is_empty() {
            if !t.is_empty() {
                t.push('\n');
            }
            t.push_str(e);
        }
        t.replace('\0', "")
    }
}

/// Run a wsl.exe management command to completion, killing it after `timeout`.
fn run_wsl(args: &[&std::ffi::OsStr], timeout: Duration) -> Result<WslOutput, String> {
    use std::io::Read;
    let mut child = wsl_command()
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot start {}: {e}", wsl_exe().display()))?;
    // Both pipes are drained at once: a full stderr pipe must not stall
    // wsl.exe while stdout is being read.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wsl.exe did not finish within {} s", timeout.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("wait for wsl.exe: {e}")),
        }
    };
    let o = out.join().unwrap_or_default();
    let e = err.join().unwrap_or_default();
    Ok(WslOutput {
        code: status.code(),
        stdout: String::from_utf8_lossy(&o).into_owned(),
        stderr: String::from_utf8_lossy(&e).into_owned(),
    })
}

/// The WSL version from `wsl --version`: the first `a.b.c[.d]` number on the
/// first line (`WSL version: 2.6.1.0`; the label is translated on other
/// Windows languages, the number is not).
pub(crate) fn parse_wsl_version(text: &str) -> Option<(u32, u32, u32)> {
    let first = text.replace('\0', "");
    let first = first.lines().find(|l| !l.trim().is_empty())?;
    first.split(|c: char| !(c.is_ascii_digit() || c == '.')).find_map(|word| {
        let nums: Vec<u32> = word.split('.').map(|n| n.parse().ok()).collect::<Option<_>>()?;
        (nums.len() >= 3).then(|| (nums[0], nums[1], nums[2]))
    })
}

/// Whether this WSL is new enough: free of CVE-2025-53788 (a local privilege
/// escalation in WSL fixed in 2.5.10 and 2.6.1).
pub(crate) fn wsl_version_ok(v: (u32, u32, u32)) -> bool {
    v >= (2, 6, 1) || ((2, 5, 10) <= v && v < (2, 6, 0))
}

/// The CPU this Windows really runs on, if it differs from this app's build:
/// an x64 app emulated on ARM64 Windows would ship an x64 guest root that the
/// ARM64 WSL kernel cannot run.
fn emulated_on() -> Option<&'static str> {
    use windows_sys::Win32::System::SystemInformation::{IMAGE_FILE_MACHINE, IMAGE_FILE_MACHINE_ARM64};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, IsWow64Process2};
    let mut process: IMAGE_FILE_MACHINE = 0;
    let mut native: IMAGE_FILE_MACHINE = 0;
    // SAFETY: GetCurrentProcess returns a pseudo handle that needs no closing;
    // both out-pointers are valid for writes.
    let ok = unsafe { IsWow64Process2(GetCurrentProcess(), &mut process, &mut native) };
    if ok == 0 {
        return None;
    }
    (native == IMAGE_FILE_MACHINE_ARM64 && std::env::consts::ARCH != "aarch64").then_some("ARM64")
}

/// The guest root the app ships, as its manifest describes it.
#[derive(Clone, Debug)]
pub(crate) struct Runtime {
    pub rootfs: PathBuf,
    pub version: String,
    pub sha256: String,
}

/// Read and check a runtime dir: the tarball, and a manifest whose CPU matches
/// this app and whose agent serves this app's protocol version.
pub(crate) fn read_runtime(dir: &Path) -> Result<Runtime, String> {
    let rootfs = dir.join(ROOTFS_FILE);
    if !rootfs.is_file() {
        return Err(format!("the WSL guest root {} is missing (build it with scripts/build-wsl-rootfs.sh)", rootfs.display()));
    }
    let manifest_path = dir.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("cannot read {}: {e}", manifest_path.display()))?;
    let m: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{} is not JSON: {e}", manifest_path.display()))?;
    let field = |k: &str| m.get(k).and_then(|v| v.as_str()).map(str::to_string);
    let version = field("version").filter(|v| !v.trim().is_empty() && !v.contains(['\n', '\r']));
    let version = version.ok_or_else(|| format!("{} has no version", manifest_path.display()))?;
    let sha256 = field("sha256")
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| format!("{} has no sha256", manifest_path.display()))?;
    let arch = field("arch").unwrap_or_default();
    if arch != std::env::consts::ARCH {
        return Err(format!(
            "the WSL guest root is built for {arch:?} but this app is {}",
            std::env::consts::ARCH
        ));
    }
    let range = m
        .get("protocol")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|n| n.as_u64()).map(|n| n.to_string()).collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    marker_serves(&range, app_needs_version()).map_err(|why| format!("the WSL guest root: {why}"))?;
    Ok(Runtime { rootfs, version, sha256 })
}

/// The runtime dir: `TXR_WSL_RUNTIME`, else `<exe dir>/resources/wsl-runtime`.
fn runtime_dir() -> Option<PathBuf> {
    std::env::var_os(RUNTIME_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            let exe = std::env::current_exe().ok()?;
            Some(exe.parent()?.join("resources").join(RUNTIME_RESOURCE_DIR))
        })
}

/// The runtime found by [`probe_host`].
static RUNTIME: std::sync::OnceLock<Runtime> = std::sync::OnceLock::new();

/// Why [`probe_host`] failed (what the user has to do).
static PROBE_FAILURE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Why methods cannot run on this PC, or `None` when the sandbox is ready.
pub fn runner_unavailable() -> Option<String> {
    use super::config::{init_status, SandboxAvailability};
    if init_status() == SandboxAvailability::Ready {
        return None;
    }
    Some(PROBE_FAILURE.get().cloned().unwrap_or_else(|| {
        format!("the method sandbox is not available ({:?})", init_status())
    }))
}

/// The boot probe: `Ok` when this PC can run methods through WSL, else what
/// the user has to do. Cheap: it does not start WSL's VM.
pub fn probe_host() -> Result<HostCapabilities, String> {
    let probed = probe();
    if let Err(reason) = &probed {
        let _ = PROBE_FAILURE.set(reason.clone());
    }
    probed
}

fn probe() -> Result<HostCapabilities, String> {
    if let Some(native) = emulated_on() {
        return Err(format!(
            "this is the {} build of the app running on {native} Windows; install the {native} build \
             to run methods",
            std::env::consts::ARCH
        ));
    }
    if !wsl_exe().is_file() {
        return Err(format!(
            "methods run in WSL 2, which is not installed: open PowerShell as administrator, run \
             `{WSL_INSTALL_COMMAND}`, then restart Windows"
        ));
    }
    let out = run_wsl(&["--version".as_ref()], WSL_QUERY_TIMEOUT)?;
    let version = if out.ok() { parse_wsl_version(&out.stdout) } else { None };
    match version {
        None => {
            return Err(format!(
                "methods run in WSL 2, which is not installed or too old on this computer: open PowerShell \
                 as administrator, run `{WSL_INSTALL_COMMAND}` (or `wsl --update` if WSL is installed), \
                 then restart Windows [`wsl --version` said: {}]",
                one_line(&out.text())
            ));
        }
        Some(v) if !wsl_version_ok(v) => {
            return Err(format!(
                "WSL {}.{}.{} has a known security flaw (CVE-2025-53788); run `wsl --update` to get 2.6.1 \
                 or later",
                v.0, v.1, v.2
            ));
        }
        Some(_) => {}
    }
    let dir = runtime_dir().ok_or("the app's folder could not be found")?;
    let runtime = read_runtime(&dir)?;
    let _ = RUNTIME.set(runtime);
    Ok(HostCapabilities {
        bwrap_path: PathBuf::from(GUEST_BWRAP_PATH),
        // The agent applies the cgroup limits and the seccomp filter per
        // request (ExecRequest.cgroup / seccomp_fd), not the host.
        cgroup: CgroupMode::None,
        seccomp: SeccompMode::NotLinked,
    })
}

fn one_line(text: &str) -> String {
    let t: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    t.chars().take(300).collect()
}

/// The names of the installed WSL distros.
fn list_distros() -> Result<Vec<String>, AppError> {
    let out = run_wsl(&["--list".as_ref(), "--quiet".as_ref()], WSL_QUERY_TIMEOUT).map_err(wsl_error)?;
    // With no distro at all, `wsl --list` fails with a message: an empty list.
    if !out.ok() {
        return Ok(Vec::new());
    }
    Ok(out
        .stdout
        .replace('\0', "")
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// The build id inside the distro, `None` when it has no version file (it is
/// not the app's), or an error when WSL cannot start it.
fn distro_version() -> Result<Option<String>, AppError> {
    let out = run_wsl(
        &[
            "-d".as_ref(),
            WSL_DISTRO.as_ref(),
            "-u".as_ref(),
            "root".as_ref(),
            "--exec".as_ref(),
            GUEST_BUSYBOX_PATH.as_ref(),
            "cat".as_ref(),
            DISTRO_VERSION_FILE.as_ref(),
        ],
        WSL_START_TIMEOUT,
    )
    .map_err(wsl_error)?;
    if out.ok() {
        return Ok(Some(out.stdout.trim().to_string()));
    }
    let text = out.text();
    // busybox ran but the file is not there: a distro that is not the app's.
    if text.contains(DISTRO_VERSION_FILE) || text.to_ascii_lowercase().contains("no such file") {
        return Ok(None);
    }
    Err(wsl_start_error(&text))
}

/// A WSL start or import failure, with what to do for the common causes.
fn wsl_start_error(text: &str) -> AppError {
    let lower = text.to_ascii_lowercase();
    let hint = if lower.contains("0x80370102") || lower.contains("virtual machine platform") {
        format!(
            " (WSL 2 needs the \"Virtual Machine Platform\" option of Windows and virtualization turned on \
             in the PC's firmware settings: run `{WSL_INSTALL_COMMAND}` as administrator, restart, and check \
             the firmware setting if it still fails)"
        )
    } else if lower.contains("0x8004032d") || lower.contains("not supported") {
        " (this Windows does not support WSL 2)".to_string()
    } else {
        String::new()
    };
    wsl_error(format!("WSL could not start the app's distro: {}{hint}", one_line(text)))
}

/// One distro setup at a time in this process.
static DISTRO_LOCK: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);

/// Make sure the app's distro exists and is the shipped build: import it on
/// first use (no admin rights needed), replace an older build of it, and
/// refuse to touch a distro of that name the app did not create.
pub async fn ensure_distro() -> Result<(), AppError> {
    let runtime = RUNTIME
        .get()
        .cloned()
        .ok_or_else(|| wsl_error("the WSL runner was not set up (see the sandbox status at startup)"))?;
    let mut ready = DISTRO_LOCK.lock().await;
    if ready.as_deref() == Some(runtime.version.as_str()) {
        return Ok(());
    }
    let data_root = crate::modules::rootfs::data_root();
    let version = runtime.version.clone();
    tokio::task::spawn_blocking(move || ensure_distro_blocking(&runtime, &data_root))
        .await
        .map_err(|e| wsl_error(format!("WSL setup task: {e}")))??;
    *ready = Some(version);
    Ok(())
}

fn ensure_distro_blocking(runtime: &Runtime, data_root: &Path) -> Result<(), AppError> {
    let installed = list_distros()?.iter().any(|n| n.eq_ignore_ascii_case(WSL_DISTRO));
    if installed {
        match distro_version()? {
            Some(v) if v == runtime.version => return Ok(()),
            Some(_) => {
                // An older build of the app's own distro: replace it (it holds
                // nothing but the guest root; runs keep no state in it).
                let out = run_wsl(&["--unregister".as_ref(), WSL_DISTRO.as_ref()], WSL_QUERY_TIMEOUT)
                    .map_err(wsl_error)?;
                if !out.ok() {
                    return Err(wsl_error(format!(
                        "WSL could not remove the app's outdated distro: {}",
                        one_line(&out.text())
                    )));
                }
            }
            None => {
                return Err(wsl_error(format!(
                    "a WSL distro named {WSL_DISTRO} exists that this app did not create; rename or remove \
                     it (`wsl --unregister {WSL_DISTRO}` deletes it and everything in it)"
                )));
            }
        }
    }
    let actual = sha256_file(&runtime.rootfs).map_err(|e| wsl_error(format!("read the WSL guest root: {e}")))?;
    if actual != runtime.sha256 {
        return Err(wsl_error(format!(
            "the WSL guest root {} does not match its checksum (sha256 {actual}, expected {})",
            runtime.rootfs.display(),
            runtime.sha256
        )));
    }
    let location = data_root.join("wsl").join("distro");
    // A dir left by an earlier, removed distro would make the import fail.
    let _ = std::fs::remove_dir_all(&location);
    std::fs::create_dir_all(&location)
        .map_err(|e| wsl_error(format!("create {}: {e}", location.display())))?;
    let out = run_wsl(
        &[
            "--import".as_ref(),
            WSL_DISTRO.as_ref(),
            location.as_os_str(),
            runtime.rootfs.as_os_str(),
            "--version".as_ref(),
            "2".as_ref(),
        ],
        WSL_IMPORT_TIMEOUT,
    )
    .map_err(wsl_error)?;
    if !out.ok() {
        return Err(wsl_start_error(&out.text()));
    }
    match distro_version()? {
        Some(v) if v == runtime.version => Ok(()),
        other => Err(wsl_error(format!(
            "the imported WSL distro reports build {other:?}, expected {}",
            runtime.version
        ))),
    }
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

/// A Windows path as WSL sees it: `C:\Users\x\f` → `/mnt/c/Users/x/f`.
/// Only plain drive-letter paths are accepted (WSL mounts fixed drives at
/// `/mnt/<letter>`); a network path or a device path is refused.
pub(crate) fn win_to_wsl(path: &Path) -> Result<String, AppError> {
    let raw = path.to_string_lossy();
    let s = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    let bytes = s.as_bytes();
    let drive_path = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    if !drive_path || s.starts_with(r"\\") {
        return Err(wsl_error(format!(
            "{} is not on a local drive; WSL can only read run files from a drive letter path",
            path.display()
        )));
    }
    let rest = s[3..].replace('\\', "/");
    if rest.split('/').any(|p| p == "..") {
        return Err(wsl_error(format!("{} has a `..` part", path.display())));
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest = rest.trim_end_matches('/');
    Ok(if rest.is_empty() { format!("/mnt/{drive}") } else { format!("/mnt/{drive}/{rest}") })
}

/// One run's environment images, held open so that nothing can change,
/// replace or delete them until the run ends (Windows enforces the share mode
/// of an open file), and verified against their digests while held.
pub struct ImageHold {
    _files: Vec<std::fs::File>,
}

/// Image identities already verified in this process: (digest → (size,
/// creation time, last write time)). A held file cannot change, so a file
/// with the same identity as one verified before holds the same bytes.
static VERIFIED: std::sync::LazyLock<Mutex<std::collections::HashMap<String, (u64, u64, u64)>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

impl ImageHold {
    /// Open each `(path, digest)` read-only, sharing it only with readers,
    /// then verify the bytes (skipped when this exact file was verified
    /// before in this process).
    pub fn verify(images: &[(PathBuf, String)]) -> Result<Self, AppError> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_SHARE_READ: u32 = 0x1;
        let mut files = Vec::with_capacity(images.len());
        for (path, digest) in images {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ)
                .open(path)
                .map_err(|e| wsl_error(format!("open the environment image {}: {e}", path.display())))?;
            let md = file
                .metadata()
                .map_err(|e| wsl_error(format!("read the environment image {}: {e}", path.display())))?;
            let identity = (md.file_size(), md.creation_time(), md.last_write_time());
            let known = VERIFIED.lock().unwrap_or_else(|p| p.into_inner()).get(digest) == Some(&identity);
            if !known {
                super::method_env::verify_image_file(path, digest)?;
                VERIFIED.lock().unwrap_or_else(|p| p.into_inner()).insert(digest.clone(), identity);
            }
            files.push(file);
        }
        Ok(Self { _files: files })
    }
}

/// The guest agent for one run: every request starts a fresh agent process
/// in the distro with these mounts.
pub struct WslAgent {
    base: String,
    layer: String,
    ro: Vec<String>,
    /// Tests: a stand-in for `wsl.exe` and its arguments.
    #[cfg(test)]
    fake: Option<(PathBuf, Vec<String>)>,
}

impl WslAgent {
    /// `base`/`layer`: the verified image files; `ro`: read-only input dirs,
    /// in order (`ro[i]` is `/host-mounts/<i>` in the agent).
    pub fn new(base: &Path, layer: &Path, ro: &[PathBuf]) -> Result<Self, AppError> {
        Ok(Self {
            base: win_to_wsl(base)?,
            layer: win_to_wsl(layer)?,
            ro: ro.iter().map(|p| win_to_wsl(p)).collect::<Result<_, _>>()?,
            #[cfg(test)]
            fake: None,
        })
    }

    /// The agent's command line after `wsl.exe` (also used by the tests).
    pub(crate) fn args(&self) -> Vec<String> {
        let mut a: Vec<String> = ["-d", WSL_DISTRO, "-u", "root", "--exec", GUEST_AGENT_PATH, "--stdio"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        a.extend(["--base".to_string(), self.base.clone(), "--layer".to_string(), self.layer.clone()]);
        for r in &self.ro {
            a.extend(["--ro".to_string(), r.clone()]);
        }
        a
    }

    /// The layer's bind entries and the wrapper command, read by the agent
    /// with the images mounted ([`super::vm_exchange::read_layer_plan`]).
    pub async fn read_layer_plan(&self) -> Result<(Vec<String>, String), AppError> {
        super::vm_exchange::read_layer_plan(self).await
    }

    /// The program and arguments one request starts.
    fn command(&self) -> (PathBuf, Vec<String>) {
        #[cfg(test)]
        if let Some(fake) = &self.fake {
            return fake.clone();
        }
        (wsl_exe(), self.args())
    }

    async fn run(
        &self,
        req: ExecRequest,
        host_budget: Duration,
        sink: Option<&Arc<dyn ProgressSink>>,
        artifact_dirs: &[OutputDir],
    ) -> Result<VmExecOutcome, AppError> {
        let (program, args) = self.command();
        let mut child = tokio::process::Command::new(&program)
            .args(args)
            .env("WSL_UTF8", "1")
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| wsl_error(format!("cannot start {}: {e}", program.display())))?;
        let (Some(stdin), Some(stdout), Some(mut stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Err(wsl_error("wsl.exe started without its pipes"));
        };
        // The agent's log: drained all along (a full pipe would stall it), the
        // last AGENT_STDERR_KEEP bytes kept for error messages.
        let log = tokio::spawn(async move {
            let mut kept: Vec<u8> = Vec::new();
            let mut buf = vec![0u8; 8 * 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                kept.extend_from_slice(&buf[..n]);
                let excess = kept.len().saturating_sub(AGENT_STDERR_KEEP);
                kept.drain(..excess);
            }
            kept
        });
        let stream = tokio::io::join(stdout, stdin);
        let result = exec_over(stream, req, host_budget, sink, artifact_dirs).await;
        let status = match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
            Ok(Ok(status)) => status.code(),
            _ => {
                let _ = child.start_kill();
                None
            }
        };
        let log = log.await.unwrap_or_default();
        match result {
            Ok(outcome) => Ok(outcome),
            Err(e) => Err(agent_failure(e, status, &log)),
        }
    }
}

impl AgentExec for WslAgent {
    fn exec(
        &self,
        req: ExecRequest,
        host_budget: Duration,
        sink: Option<&Arc<dyn ProgressSink>>,
        artifact_dirs: &[OutputDir],
    ) -> impl std::future::Future<Output = Result<VmExecOutcome, AppError>> + Send {
        self.run(req, host_budget, sink, artifact_dirs)
    }
}

/// An exchange that failed: say what the agent (or wsl.exe) reported.
fn agent_failure(e: AppError, status: Option<i32>, log: &[u8]) -> AppError {
    let log = String::from_utf8_lossy(log);
    let tail: String = log.trim().lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    let what = match status {
        Some(AGENT_EXIT_SETUP) => "the method environment could not be mounted in WSL",
        Some(AGENT_EXIT_BAD_ARGS) => "the WSL agent refused its arguments (an app and guest root mismatch)",
        // The agent's exit 4 covers every failed exchange: a broken or closed
        // pipe, a malformed frame, and a request whose protocol version it
        // does not serve. Its own reason is in the log tail below.
        Some(AGENT_EXIT_TRANSPORT) => "the exchange between the app and the WSL agent failed",
        _ => "the method run in WSL stopped",
    };
    let mut message = format!("{what}: {e}");
    if !tail.is_empty() {
        message.push_str(&format!("\nWSL reported:\n{tail}"));
    }
    wsl_error(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_versions_free_of_the_cve_are_accepted() {
        assert!(wsl_version_ok((2, 6, 1)));
        assert!(wsl_version_ok((2, 7, 0)));
        assert!(wsl_version_ok((3, 0, 0)));
        assert!(wsl_version_ok((2, 5, 10)));
        assert!(wsl_version_ok((2, 5, 11)));
        assert!(!wsl_version_ok((2, 6, 0)));
        assert!(!wsl_version_ok((2, 5, 9)));
        assert!(!wsl_version_ok((2, 4, 13)));
        assert!(!wsl_version_ok((1, 2, 5)));
    }

    #[test]
    fn the_wsl_version_is_read_from_the_first_line_in_any_language() {
        let en = "WSL version: 2.6.1.0\nKernel version: 6.6.87.2-1\nWSLg version: 1.0.66\n";
        assert_eq!(parse_wsl_version(en), Some((2, 6, 1)));
        let de = "WSL-Version: 2.5.10.0\nKernelversion: 6.6.87.2-1\n";
        assert_eq!(parse_wsl_version(de), Some((2, 5, 10)));
        // UTF-16 read as bytes leaves NULs between the characters.
        let utf16ish: String = "WSL version: 2.6.2.0".chars().flat_map(|c| [c, '\0']).collect();
        assert_eq!(parse_wsl_version(&utf16ish), Some((2, 6, 2)));
        assert_eq!(parse_wsl_version("Invalid command line option: --version"), None);
        assert_eq!(parse_wsl_version(""), None);
    }

    #[test]
    fn windows_paths_map_to_wsl_drive_mounts() {
        let p = |s: &str| win_to_wsl(Path::new(s));
        assert_eq!(p(r"C:\Users\Khoi\.txresbench\x.sqfs").unwrap(), "/mnt/c/Users/Khoi/.txresbench/x.sqfs");
        assert_eq!(p(r"\\?\D:\data\run 1\in").unwrap(), "/mnt/d/data/run 1/in");
        assert_eq!(p(r"E:\").unwrap(), "/mnt/e");
        assert_eq!(p(r"C:\dir\").unwrap(), "/mnt/c/dir");
        assert!(p(r"\\server\share\x").is_err(), "network paths are refused");
        assert!(p(r"\\?\UNC\server\share\x").is_err(), "verbatim network paths are refused");
        assert!(p(r"relative\x").is_err());
        assert!(p(r"C:relative").is_err(), "a drive-relative path is refused");
        assert!(p(r"C:\a\..\b").is_err(), "a `..` part is refused");
    }

    #[test]
    fn the_agent_command_line_names_the_distro_the_mounts_and_stdio() {
        let agent = WslAgent::new(
            Path::new(r"C:\cache\base.sqfs"),
            Path::new(r"C:\cache\layer.sqfs"),
            &[PathBuf::from(r"C:\run\input"), PathBuf::from(r"C:\run\identity")],
        )
        .unwrap();
        assert_eq!(
            agent.args(),
            [
                "-d", "TxResBench", "-u", "root", "--exec", "/usr/bin/txresbench-sandbox-agent", "--stdio",
                "--base", "/mnt/c/cache/base.sqfs", "--layer", "/mnt/c/cache/layer.sqfs",
                "--ro", "/mnt/c/run/input", "--ro", "/mnt/c/run/identity",
            ]
        );
    }

    fn manifest_dir(tag: &str, manifest: &str, with_rootfs: bool) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txr-wsl-runtime-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        if with_rootfs {
            std::fs::write(dir.join(ROOTFS_FILE), b"not really a tarball").unwrap();
        }
        std::fs::write(dir.join(MANIFEST_FILE), manifest).unwrap();
        dir
    }

    #[test]
    fn a_runtime_must_match_this_app_and_its_protocol() {
        let arch = std::env::consts::ARCH;
        let sha = "a".repeat(64);
        let good = format!(r#"{{"version":"wsl-1","arch":"{arch}","sha256":"{sha}","protocol":[3,3]}}"#);
        let dir = manifest_dir("good", &good, true);
        let rt = read_runtime(&dir).expect("a matching runtime is accepted");
        assert_eq!(rt.version, "wsl-1");
        assert_eq!(rt.sha256, sha);
        let _ = std::fs::remove_dir_all(&dir);

        let other_arch = if arch == "aarch64" { "x86_64" } else { "aarch64" };
        for (tag, manifest, why) in [
            ("arch", format!(r#"{{"version":"v","arch":"{other_arch}","sha256":"{sha}","protocol":[3,3]}}"#), "built for"),
            ("proto", format!(r#"{{"version":"v","arch":"{arch}","sha256":"{sha}","protocol":[1,2]}}"#), "protocol"),
            ("sha", format!(r#"{{"version":"v","arch":"{arch}","sha256":"xyz","protocol":[3,3]}}"#), "sha256"),
            ("ver", format!(r#"{{"arch":"{arch}","sha256":"{sha}","protocol":[3,3]}}"#), "version"),
        ] {
            let dir = manifest_dir(tag, &manifest, true);
            let err = read_runtime(&dir).expect_err(tag);
            assert!(err.contains(why), "{tag}: {err}");
            let _ = std::fs::remove_dir_all(&dir);
        }
        let dir = manifest_dir("missing", &good, false);
        assert!(read_runtime(&dir).expect_err("no tarball").contains("missing"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_exchange_names_the_agents_reason() {
        let base = wsl_error("read from the app's WSL distro: broken pipe");
        let e = agent_failure(base, Some(AGENT_EXIT_SETUP), b"info: start\nerror: mount /sandbox-rootfs: squashfs not supported\n");
        assert_eq!(e.error_code(), WSL_UNAVAILABLE_CODE);
        assert!(e.to_string().contains("could not be mounted in WSL"), "{e}");
        assert!(e.to_string().contains("squashfs not supported"), "{e}");
    }

    /// Every message that tells the user how to get WSL names the command
    /// that installs WSL alone, never the install command without
    /// `--no-distribution` (which also installs a Linux distribution).
    #[test]
    fn install_advice_never_installs_a_linux_distribution() {
        assert_eq!(WSL_INSTALL_COMMAND, "wsl --install --no-distribution");
        let source = include_str!("wsl_run.rs");
        let needle = ["wsl", " --install"].concat();
        let mut seen = 0;
        for (at, _) in source.match_indices(&needle) {
            let rest = &source[at + needle.len()..];
            assert!(
                rest.starts_with(" --no-distribution"),
                "an install command without --no-distribution at byte {at}"
            );
            seen += 1;
        }
        assert!(seen >= 2, "the const and the module docs name it");
        let e = wsl_start_error("Error code: Wsl/Service/CreateInstance/0x80370102");
        assert!(e.to_string().contains("`wsl --install --no-distribution`"), "{e}");
    }

    /// Exit 4 is not only a lost connection: a request the agent refuses for
    /// its protocol version ends the same way, so the message must not claim
    /// a lost connection, and the agent's own reason must reach the user.
    #[test]
    fn a_refused_request_is_not_called_a_lost_connection() {
        let base = wsl_error("the agent ended without an exit frame");
        let e = agent_failure(
            base,
            Some(AGENT_EXIT_TRANSPORT),
            b"error: the request's protocol version is not served by this agent\n",
        );
        let text = e.to_string();
        assert_eq!(e.error_code(), WSL_UNAVAILABLE_CODE);
        assert!(text.contains("the exchange between the app and the WSL agent failed"), "{text}");
        assert!(!text.contains("lost its connection"), "{text}");
        assert!(text.contains("protocol version is not served"), "{text}");
    }

    /// A stand-in agent process: PowerShell writes `frames` to its stdout (it
    /// does not read the request), `log` to its stderr, and exits with `code`;
    /// the real pipes, log capture and exit-code handling of [`WslAgent`] run.
    fn fake_agent(tag: &str, frames: &[sandbox_vm_protocol::Frame], log: &str, code: i32) -> (WslAgent, PathBuf) {
        let dir = std::env::temp_dir().join(format!("txr-wsl-fake-agent-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bytes: Vec<u8> = frames.iter().flat_map(sandbox_vm_protocol::encode).collect();
        let frames_file = dir.join("frames.bin");
        std::fs::write(&frames_file, bytes).unwrap();
        let script = format!(
            "$b=[IO.File]::ReadAllBytes('{}'); $o=[Console]::OpenStandardOutput(); $o.Write($b,0,$b.Length); \
             $o.Flush(); [Console]::Error.WriteLine('{log}'); exit {code}",
            frames_file.display()
        );
        let mut agent = WslAgent::new(Path::new(r"C:\img\base.sqfs"), Path::new(r"C:\img\layer.sqfs"), &[]).unwrap();
        let powershell = wsl_exe().with_file_name("WindowsPowerShell").join("v1.0").join("powershell.exe");
        agent.fake = Some((powershell, ["-NoProfile", "-NonInteractive", "-Command", &script].map(String::from).to_vec()));
        (agent, dir)
    }

    fn request() -> ExecRequest {
        ExecRequest {
            protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
            request_id: 1,
            bwrap_path: GUEST_BWRAP_PATH.into(),
            argv: vec!["true".into()],
            timeout_ms: 10_000,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: vec!["/tmp/txresbench-artifacts-out/0".into()],
            artifacts: Default::default(),
        }
    }

    #[tokio::test]
    async fn an_agent_process_streams_its_result_and_outputs_back() {
        use sandbox_vm_protocol::{ExitStatus, Frame};
        let frames = [
            Frame::Stdout(b"hello\n".to_vec()),
            Frame::Exit(ExitStatus { code: 0, timed_out: false }),
            Frame::ArtifactChunk { mount_index: 0, rel_path: "pred.csv".into(), offset: 0, data: b"id,p\n1,0.5\n".to_vec() },
            Frame::ArtifactsDone,
        ];
        let (agent, dir) = fake_agent("ok", &frames, "agent: done", 0);
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let dirs = [OutputDir { host: out.clone(), sandbox_path: "/output".into() }];
        let outcome = AgentExec::exec(&agent, request(), Duration::from_secs(60), None, &dirs)
            .await
            .expect("the exchange succeeds");
        assert_eq!(outcome.exit_code, 0);
        assert_eq!(outcome.stdout, b"hello\n");
        assert!(outcome.incomplete.is_empty(), "{:?}", outcome.incomplete);
        assert_eq!(std::fs::read(out.join("pred.csv")).unwrap(), b"id,p\n1,0.5\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_agent_that_cannot_mount_says_why() {
        let (agent, dir) = fake_agent("mount", &[], "error: mount /sandbox-rootfs: squashfs not supported", 3);
        let err = AgentExec::exec(&agent, request(), Duration::from_secs(60), None, &[])
            .await
            .err()
            .expect("no exit status came back");
        assert_eq!(err.error_code(), WSL_UNAVAILABLE_CODE);
        let text = err.to_string();
        assert!(text.contains("could not be mounted in WSL"), "{text}");
        assert!(text.contains("squashfs not supported"), "{text}");
        assert!(!text.contains("VM"), "no macOS wording on Windows: {text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn held_images_cannot_be_changed_or_deleted_until_released() {
        use sha2::Digest;
        let dir = std::env::temp_dir().join(format!("txr-wsl-hold-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("base.sqfs");
        std::fs::write(&img, b"image bytes").unwrap();
        let digest = hex::encode(sha2::Sha256::digest(b"image bytes"));
        let hold = ImageHold::verify(&[(img.clone(), digest.clone())]).expect("verified + held");
        assert!(std::fs::write(&img, b"changed").is_err(), "a held image cannot be written");
        assert!(std::fs::remove_file(&img).is_err(), "a held image cannot be deleted");
        assert!(std::fs::read(&img).is_ok(), "a held image can still be read");
        drop(hold);
        std::fs::write(&img, b"changed").expect("released");
        let err = ImageHold::verify(&[(img.clone(), digest)]).err().expect("changed bytes are refused");
        assert!(!err.to_string().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
