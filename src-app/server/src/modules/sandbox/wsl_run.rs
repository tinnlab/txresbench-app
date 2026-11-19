//! Windows stacked method runs: the guest agent in an app-owned WSL 2 distro.
//!
//! Linux runs a method by mounting the base + layer squashfs images on the host
//! and spawning bwrap over them; macOS boots a per-run Linux VM
//! (`mac_vm_run`). Windows has neither, but WSL 2 runs a real Linux kernel, so
//! this seam runs the SAME guest agent as the macOS VM inside a WSL distro the
//! app owns ([`WSL_DISTRO`], imported once from the guest root the app ships):
//!
//! - each request to the agent is one `wsl.exe -d TxResBench -u root --cd /
//!   --exec txresbench-sandbox-agent --stdio --base <img> --layer <img> --ro
//!   <dir>...` process, speaking `sandbox-vm-protocol` over its stdin/stdout
//!   (the shared exchange in `vm_exchange`); the agent mounts everything in a
//!   private mount namespace, so nothing is left mounted in the distro after a
//!   request;
//! - the images and the read-only inputs stay where they are on the Windows
//!   disk and are read through WSL's `/mnt/<drive>` mounts: the images are held
//!   open for the whole run so that nothing can change or delete them
//!   ([`ImageHold`]), and verified against their digests first;
//! - the agent presents the same guest paths as the macOS VM, so the stacked
//!   bwrap argv, the request and the output copy-back are those of the macOS
//!   seam (`service::run_method_in_stack`, Windows); bwrap's `--unshare-net`
//!   keeps the method off the network;
//! - the distro cannot start Windows programs (its `wsl.conf` turns interop
//!   off), and wsl.exe is started without the app's `WSLENV`, so none of the
//!   app's variables are copied into it;
//! - every run starts the distro once before its first request
//!   ([`ensure_distro`]), which also finds a distro removed or left without
//!   its disk since the last run and sets it up again (one replaced by another
//!   version of the app fails the run instead).
//!
//! What the user must have: WSL installed (`wsl --install --no-distribution`,
//! which needs admin rights and a restart once) and new enough
//! ([`wsl_version_ok`]). The probe ([`probe_host`]) says which step is missing.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

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

/// How long an agent whose exchange ended within its budget gets to exit (for
/// its exit code) before it is stopped.
const AGENT_EXIT_GRACE: Duration = Duration::from_secs(10);

/// How long the agent's log is waited for once the exchange ended: a process
/// left behind may hold its stderr open.
const AGENT_LOG_WAIT: Duration = Duration::from_secs(5);

/// The disk of a WSL 2 distro, in the dir it was imported into.
const DISTRO_DISK_FILE: &str = "ext4.vhdx";

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

/// The wsl.exe this runner starts: the system's own ([`wsl_exe`]), or in the
/// tests a stand-in program with leading arguments of its own.
#[derive(Clone, Debug)]
struct Wsl {
    program: PathBuf,
    lead: Vec<OsString>,
}

impl Wsl {
    fn system() -> Self {
        Self { program: wsl_exe(), lead: Vec::new() }
    }

    /// A wsl.exe command line: UTF-8 messages (`WSL_UTF8=1`; by default
    /// wsl.exe prints its own messages in UTF-16), no `WSLENV` (it names the
    /// Windows variables WSL copies into Linux: none of the app's go there),
    /// and no console window.
    fn command(&self) -> std::process::Command {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new(&self.program);
        cmd.args(&self.lead).env("WSL_UTF8", "1").env_remove("WSLENV").creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    /// Run a wsl.exe command to completion, killing it after `timeout`.
    fn run<A: AsRef<OsStr>>(&self, args: &[A], timeout: Duration) -> Result<WslOutput, String> {
        use std::io::Read;
        let mut child = self
            .command()
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("cannot start {}: {e}", self.program.display()))?;
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
        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
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

/// The wsl.exe arguments that run `argv` as root in the app's distro, from
/// `/` (not the app's working dir, which WSL would translate and enter), with
/// no shell in between.
fn in_distro(argv: &[&str]) -> Vec<String> {
    let mut a: Vec<String> = ["-d", WSL_DISTRO, "-u", "root", "--cd", "/", "--exec"].map(String::from).to_vec();
    a.extend(argv.iter().map(|s| s.to_string()));
    a
}

/// The error name in wsl.exe's error code: the last part of the
/// `Wsl/<context>/.../<name>` word after the (translated) "Error code:" label,
/// e.g. `ERROR_FILE_NOT_FOUND` in `Wsl/Service/CreateInstance/MountDisk/HCS/
/// ERROR_FILE_NOT_FOUND` (a known error by its name, any other as `0x…`;
/// `wslutil::ErrorToString` in WSL's source).
fn wsl_error_name(text: &str) -> Option<&str> {
    text.split_whitespace()
        .filter(|w| w.starts_with("Wsl/"))
        .last()
        .and_then(|code| code.rsplit('/').next())
}

/// The in-box wsl.exe of a Windows without WSL prints only that WSL is not
/// installed (translated) and this address, with no error code.
fn wsl_not_installed(text: &str) -> bool {
    wsl_error_name(text).is_none() && text.contains("aka.ms/wslinstall")
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
    let out = Wsl::system().run(&["--version"], WSL_QUERY_TIMEOUT)?;
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

/// The names of the registered WSL distros, in every state (`--all`: one
/// being imported or removed right now is listed too). With no distro at all
/// a quiet list prints nothing and succeeds (WSL's `ListDistributionsHelper`,
/// 2.5.10 on), so a failed list is an error, never an empty list: taken for
/// "no distro", it would set up anew a distro that may still be registered.
fn list_distros(wsl: &Wsl) -> Result<Vec<String>, AppError> {
    let out = wsl.run(&["--list", "--quiet", "--all"], WSL_QUERY_TIMEOUT).map_err(wsl_error)?;
    if !out.ok() {
        return Err(wsl_failure("WSL could not list its distros", &out.text()));
    }
    Ok(out
        .stdout
        .replace('\0', "")
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// What starting the app's distro found.
#[derive(Debug, PartialEq)]
enum Distro {
    /// It started; this is its build id.
    Build(String),
    /// It started but has no build id: not the app's distro.
    Foreign,
    /// WSL has no distro of that name.
    NotRegistered,
    /// It is registered in the app's own dir, but its disk there is gone.
    DiskLost,
}

/// Start the app's distro and read its build id. Also the start every run
/// makes before its first request: a WSL that idled out boots here, under
/// [`WSL_START_TIMEOUT`], not in a request's shorter budget.
fn distro_state(wsl: &Wsl, location: &Path) -> Result<Distro, AppError> {
    let out = wsl
        .run(&in_distro(&[GUEST_BUSYBOX_PATH, "cat", DISTRO_VERSION_FILE]), WSL_START_TIMEOUT)
        .map_err(wsl_error)?;
    if out.ok() {
        let build = out.stdout.trim();
        return Ok(if build.is_empty() { Distro::Foreign } else { Distro::Build(build.to_string()) });
    }
    let text = out.text();
    match wsl_error_name(&text) {
        Some("WSL_E_DISTRO_NOT_FOUND") => return Ok(Distro::NotRegistered),
        Some("ERROR_FILE_NOT_FOUND" | "ERROR_PATH_NOT_FOUND") if disk_lost_at(location, &text) => {
            return Ok(Distro::DiskLost);
        }
        Some(_) => return Err(wsl_failure("WSL could not start the app's distro", &text)),
        None => {}
    }
    // busybox ran but the file is not there (or there is no busybox): a
    // distro that is not the app's.
    if text.contains(DISTRO_VERSION_FILE) || text.to_ascii_lowercase().contains("no such file") {
        return Ok(Distro::Foreign);
    }
    Err(wsl_failure("WSL could not start the app's distro", &text))
}

/// Whether WSL failed to attach the disk in the app's own dir ("Failed to
/// attach disk '<dir>\ext4.vhdx' to WSL2: ..."; the path is never translated)
/// and that file is really gone: the distro WSL has registered is the one the
/// app imported there, and its disk was deleted.
fn disk_lost_at(location: &Path, text: &str) -> bool {
    let disk = location.join(DISTRO_DISK_FILE);
    if disk.exists() {
        return false;
    }
    let norm = |t: &str| t.replace('/', "\\").to_lowercase();
    norm(text).contains(&norm(&disk.to_string_lossy()))
}

/// A failed wsl.exe command, with what to do for the common causes.
fn wsl_failure(what: &str, text: &str) -> AppError {
    if wsl_not_installed(text) {
        return wsl_error(format!(
            "methods run in WSL 2, which is not installed on this computer: open PowerShell as \
             administrator, run `{WSL_INSTALL_COMMAND}`, then restart Windows [wsl.exe said: {}]",
            one_line(text)
        ));
    }
    let lower = text.to_ascii_lowercase();
    let hint = if lower.contains("0x80370102") || lower.contains("virtual machine platform") {
        format!(
            " (WSL 2 needs the \"Virtual Machine Platform\" option of Windows and virtualization turned on \
             in the PC's firmware settings: run `{WSL_INSTALL_COMMAND}` as administrator, restart, and check \
             the firmware setting if it still fails)"
        )
    } else if lower.contains("0x8004032d") || lower.contains("not supported") {
        " (this Windows does not support WSL 2)".to_string()
    } else if matches!(wsl_error_name(text), Some("ERROR_FILE_NOT_FOUND" | "ERROR_PATH_NOT_FOUND")) {
        format!(
            " (a file of the distro is missing; if the {WSL_DISTRO} distro is the app's, run \
             `wsl --unregister {WSL_DISTRO}` and start the run again: the app sets the distro up anew)"
        )
    } else {
        String::new()
    };
    wsl_error(format!("{what}: {}{hint}", one_line(text)))
}

/// Remove the app's distro from WSL (with its disk).
fn unregister(wsl: &Wsl, which: &str) -> Result<(), AppError> {
    let out = wsl.run(&["--unregister", WSL_DISTRO], WSL_QUERY_TIMEOUT).map_err(wsl_error)?;
    if !out.ok() {
        return Err(wsl_failure(&format!("WSL could not remove {which}"), &out.text()));
    }
    Ok(())
}

/// Where the app imports its distro (WSL keeps the distro's disk there).
fn distro_location(data_root: &Path) -> PathBuf {
    data_root.join("wsl").join("distro")
}

/// The build of the app's distro this process set up, `None` until a setup
/// succeeds or removes another build of the distro; never reset (see
/// [`start_or_set_up`]). The lock is held for a whole check or setup, by the
/// task doing it.
type SetUpBuild = Arc<tokio::sync::Mutex<Option<String>>>;

static SET_UP: std::sync::LazyLock<SetUpBuild> = std::sync::LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(None)));

/// Make sure the app's distro is there, is the shipped build, and is started
/// (every run calls this before its first request to the agent): the first
/// run sets it up ([`ensure_distro_blocking`]); later runs start it and set it
/// up again if it was removed or lost its disk meanwhile, and fail if another
/// version of the app replaced it ([`start_or_set_up`]).
pub async fn ensure_distro() -> Result<(), AppError> {
    let runtime = RUNTIME
        .get()
        .cloned()
        .ok_or_else(|| wsl_error("the WSL runner was not set up (see the sandbox status at startup)"))?;
    ensure_ready(&SET_UP, Wsl::system(), runtime, crate::modules::rootfs::data_root()).await
}

async fn ensure_ready(set_up: &SetUpBuild, wsl: Wsl, runtime: Runtime, data_root: PathBuf) -> Result<(), AppError> {
    let mut guard = set_up.clone().lock_owned().await;
    // The blocking task owns the lock: a run cancelled meanwhile leaves an
    // import going on to its end with the lock held, so the next run waits
    // for it instead of starting a second import beside it.
    tokio::task::spawn_blocking(move || start_or_set_up(&wsl, &runtime, &data_root, &mut guard))
        .await
        .map_err(|e| wsl_error(format!("WSL setup task: {e}")))?
}

/// Only a process's first setup replaces another build of the app's distro:
/// the build of the version this one updated, or that of another version of
/// the app. The first setup ends when a setup succeeds or removes another
/// build. After that, another build found there can only come from another
/// version of the app running on this Windows account (an installed app and
/// a development build, say; an update restarts the app). Replacing it would
/// stop that version's running method (`wsl --unregister` stops the distro),
/// and that version would replace it back, so each run of this process fails
/// instead and leaves it there, until this version is restarted. No failure
/// resets `set_up`: runs go several at a time, so the next run is often
/// already waiting on the lock, and a reset would let it replace the other
/// build at once. A distro that is gone or lost its disk is still set up
/// again.
///
/// A first setup that removed another build and then failed counts as set
/// up: that version may have imported its build again meanwhile (so this
/// import found the name taken), and replacing it on every run would stop
/// its method every time. A distro the next run finds gone is still set up
/// again, so an update whose first setup removed the older build and then
/// failed its import needs no restart. A first setup that fails before
/// removing anything sets nothing, so the next run is a first setup again
/// (WSL may still have been importing the build of the version this one
/// updated).
fn start_or_set_up(
    wsl: &Wsl,
    runtime: &Runtime,
    data_root: &Path,
    set_up: &mut Option<String>,
) -> Result<(), AppError> {
    let first_setup = set_up.as_deref() != Some(runtime.version.as_str());
    if !first_setup {
        match distro_state(wsl, &distro_location(data_root))? {
            Distro::Build(b) if b == runtime.version => return Ok(()),
            Distro::Build(b) => return Err(replaced_by_another_version(&b, runtime)),
            // Gone, without its disk, or not the app's: the setup says which.
            Distro::NotRegistered | Distro::DiskLost | Distro::Foreign => {}
        }
    }
    let mut took_over = false;
    let setup = ensure_distro_blocking(wsl, runtime, data_root, first_setup, &mut took_over);
    if setup.is_ok() || took_over {
        *set_up = Some(runtime.version.clone());
    }
    setup
}

fn replaced_by_another_version(found: &str, runtime: &Runtime) -> AppError {
    wsl_error(format!(
        "another version of TxResBench on this computer replaced the app's WSL distro (it is now build \
         {found}; this version needs {}): close the other version, then restart this one",
        runtime.version
    ))
}

/// Whether WSL lists a distro of the app's name, in any state.
fn apps_distro_listed(wsl: &Wsl) -> Result<bool, AppError> {
    Ok(list_distros(wsl)?.iter().any(|n| n.eq_ignore_ascii_case(WSL_DISTRO)))
}

/// Make sure the app's distro exists and is the shipped build: import it on
/// first use (no admin rights needed), replace another build of it (only when
/// `replace_other_build`: see [`start_or_set_up`]; `took_over` is set once it
/// is removed) or one whose disk was deleted, and refuse to touch a distro of
/// that name the app did not create.
fn ensure_distro_blocking(
    wsl: &Wsl,
    runtime: &Runtime,
    data_root: &Path,
    replace_other_build: bool,
    took_over: &mut bool,
) -> Result<(), AppError> {
    let location = distro_location(data_root);
    // What to remove before the import (as an error names it), and whether
    // it is another build of the app's distro.
    let mut remove = None;
    let mut other_build = false;
    if apps_distro_listed(wsl)? {
        match distro_state(wsl, &location)? {
            Distro::Build(b) if b == runtime.version => return Ok(()),
            Distro::Build(b) if !replace_other_build => return Err(replaced_by_another_version(&b, runtime)),
            // An older build of the app's own distro (it holds nothing but
            // the guest root; runs keep no state in it): replaced.
            Distro::Build(_) => {
                remove = Some("the app's outdated distro");
                other_build = true;
            }
            // The app's distro, registered in the app's dir, without its
            // disk: it cannot start again, so it is set up anew.
            Distro::DiskLost => remove = Some("the app's distro whose disk was deleted"),
            // Listed, but WSL found no distro of that name to start: either
            // it was removed since it was listed, or WSL is still importing
            // or removing it (`--all` lists a distro in those states, but
            // only an installed one can start). Another list tells which: a
            // distro still listed is WSL's to finish (an import goes on in
            // WSL's service after the app quits or stops waiting for it),
            // and its dir, which may hold its disk, is left alone. Whose
            // import or removal it is cannot be told (the user may be
            // importing a distro of that name), so the command to remove it
            // is given for the app's only.
            Distro::NotRegistered => {
                if apps_distro_listed(wsl)? {
                    return Err(wsl_error(format!(
                        "WSL is still setting up or removing a distro named {WSL_DISTRO}; try again in a \
                         minute. If this persists and the {WSL_DISTRO} distro is the app's, run \
                         `wsl --unregister {WSL_DISTRO}` and start the run again: the app sets the distro up anew"
                    )));
                }
            }
            Distro::Foreign => {
                return Err(wsl_error(format!(
                    "a WSL distro named {WSL_DISTRO} exists that this app did not create; rename or remove \
                     it (`wsl --unregister {WSL_DISTRO}` deletes it and everything in it)"
                )));
            }
        }
    }
    // The guest root is checked before anything is removed: one that does
    // not match its checksum (a broken development build, say) never costs
    // the distro there, nor stops the method another version runs in it.
    let tar = checked_guest_root(runtime)?;
    if let Some(which) = remove {
        unregister(wsl, which)?;
        // Another build is gone (and the method its version ran in it
        // stopped) whatever happens next.
        *took_over = other_build;
    }
    // Only here is the distro known not to be registered (not listed by a
    // list that succeeded, just removed, or no longer listed by the second
    // list): nothing uses its dir now, so whatever an earlier distro left
    // there can go.
    match std::fs::remove_dir_all(&location) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(wsl_error(format!(
                "remove what an earlier WSL distro left in {}: {e}",
                location.display()
            )));
        }
    }
    std::fs::create_dir_all(&location).map_err(|e| wsl_error(format!("create {}: {e}", location.display())))?;
    import(wsl, runtime, &location, tar)?;
    let found = match distro_state(wsl, &location)? {
        Distro::Build(b) if b == runtime.version => return Ok(()),
        Distro::Build(b) => format!("reports build {b}"),
        Distro::Foreign => "has no build id".to_string(),
        Distro::NotRegistered => "is not registered".to_string(),
        Distro::DiskLost => "has no disk".to_string(),
    };
    Err(wsl_error(format!("the imported WSL distro {found}, expected build {}", runtime.version)))
}

/// The shipped guest root, opened held and checked against its checksum. It
/// is held from its checksum to the end of the import ([`import`] takes it):
/// nothing can change or replace it in between (WSL opens it to read, which
/// the hold allows).
fn checked_guest_root(runtime: &Runtime) -> Result<std::fs::File, AppError> {
    let tar = open_held(&runtime.rootfs)
        .map_err(|e| wsl_error(format!("open the WSL guest root {}: {e}", runtime.rootfs.display())))?;
    let actual = sha256_of(&tar).map_err(|e| wsl_error(format!("read the WSL guest root: {e}")))?;
    if actual != runtime.sha256 {
        return Err(wsl_error(format!(
            "the WSL guest root {} does not match its checksum (sha256 {actual}, expected {})",
            runtime.rootfs.display(),
            runtime.sha256
        )));
    }
    Ok(tar)
}

/// Import the shipped guest root as the app's distro; `tar` is the guest root
/// held since its checksum ([`checked_guest_root`]), released once WSL is
/// done with it.
fn import(wsl: &Wsl, runtime: &Runtime, location: &Path, tar: std::fs::File) -> Result<(), AppError> {
    let args: [&OsStr; 6] = [
        "--import".as_ref(),
        WSL_DISTRO.as_ref(),
        location.as_os_str(),
        runtime.rootfs.as_os_str(),
        "--version".as_ref(),
        "2".as_ref(),
    ];
    let out = wsl.run(&args, WSL_IMPORT_TIMEOUT).map_err(wsl_error)?;
    drop(tar);
    if !out.ok() {
        return Err(wsl_failure("WSL could not import the app's distro", &out.text()));
    }
    Ok(())
}

/// Open a file to read it, sharing it only with readers: until the handle is
/// closed, Windows refuses anyone else's write, rename or delete of it.
fn open_held(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;
    std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(path)
}

/// The sha256 of everything read from `reader`.
fn sha256_of(mut reader: impl std::io::Read) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = reader.read(&mut buf)?;
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

impl ImageHold {
    /// Open each `(path, digest)` read-only, sharing it only with readers,
    /// then verify the bytes through the held handles, on every run: a file's
    /// size and times are no proof of its bytes (any writer can set them), and
    /// what the WSL agent reads is what was hashed here. The images are
    /// hashed at once (each is a full read).
    pub fn verify(images: &[(PathBuf, String)]) -> Result<Self, AppError> {
        let files = images
            .iter()
            .map(|(path, _)| {
                open_held(path).map_err(|e| wsl_error(format!("open the environment image {}: {e}", path.display())))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let verdicts: Vec<_> = std::thread::scope(|scope| {
            let hashing: Vec<_> = files
                .iter()
                .zip(images)
                .map(|(file, (path, digest))| scope.spawn(move || verify_held(file, path, digest)))
                .collect();
            hashing.into_iter().map(|h| h.join()).collect()
        });
        for verdict in verdicts {
            verdict.map_err(|_| wsl_error("image verification stopped unexpectedly"))??;
        }
        Ok(Self { _files: files })
    }
}

/// INV-1 for a held image: its bytes must hash to the pinned digest.
fn verify_held(file: &std::fs::File, path: &Path, digest: &str) -> Result<(), AppError> {
    let actual = sha256_of(file)
        .map_err(|e| wsl_error(format!("read the environment image {}: {e}", path.display())))?;
    if actual != digest {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            super::method_env::ENV_VERIFY_FAILED_CODE,
            format!(
                "environment artifact {} does not match its pinned digest: expected {digest}, computed \
                 {actual} — refusing to mount a tampered or swapped environment",
                path.display()
            ),
        ));
    }
    Ok(())
}

/// The guest agent for one run: every request starts a fresh agent process
/// in the distro with these mounts.
pub struct WslAgent {
    base: String,
    layer: String,
    ro: Vec<String>,
    /// The wsl.exe each request starts (tests: a stand-in agent).
    wsl: Wsl,
}

impl WslAgent {
    /// `base`/`layer`: the verified image files; `ro`: read-only input dirs,
    /// in order (`ro[i]` is `/host-mounts/<i>` in the agent).
    pub fn new(base: &Path, layer: &Path, ro: &[PathBuf]) -> Result<Self, AppError> {
        Ok(Self {
            base: win_to_wsl(base)?,
            layer: win_to_wsl(layer)?,
            ro: ro.iter().map(|p| win_to_wsl(p)).collect::<Result<_, _>>()?,
            wsl: Wsl::system(),
        })
    }

    /// The agent's command line after `wsl.exe` (also used by the tests).
    pub(crate) fn args(&self) -> Vec<String> {
        let mut a = in_distro(&[GUEST_AGENT_PATH, "--stdio"]);
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

    async fn run(
        &self,
        req: ExecRequest,
        host_budget: Duration,
        sink: Option<&Arc<dyn ProgressSink>>,
        artifact_dirs: &[OutputDir],
    ) -> Result<VmExecOutcome, AppError> {
        let mut child = tokio::process::Command::from(self.wsl.command())
            .args(self.args())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| wsl_error(format!("cannot start {}: {e}", self.wsl.program.display())))?;
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
        let mut stream = tokio::io::join(FirstBytes { inner: stdout, kept: Vec::new() }, stdin);
        let started = Instant::now();
        let result = exec_over(&mut stream, req, host_budget, sink, artifact_dirs).await;
        let stdout_head = std::mem::take(&mut stream.reader_mut().kept);
        // Closes the agent's stdin.
        drop(stream);
        // Past its budget the agent did not answer in time: it is stopped at
        // once. Otherwise it has ended or is ending: a moment to exit, for
        // its exit code.
        let grace = if started.elapsed() >= host_budget { Duration::ZERO } else { AGENT_EXIT_GRACE };
        let status = match tokio::time::timeout(grace, child.wait()).await {
            Ok(Ok(status)) => status.code(),
            _ => {
                let _ = child.kill().await;
                None
            }
        };
        let log = tokio::time::timeout(AGENT_LOG_WAIT, log).await.ok().and_then(Result::ok).unwrap_or_default();
        match result {
            Ok(outcome) => Ok(outcome),
            Err(e) => Err(agent_failure(e, status, &log, &stdout_head)),
        }
    }
}

/// How many of the first bytes of an agent's stdout are kept: enough for a
/// message wsl.exe printed there instead of starting the agent.
const STDOUT_HEAD_KEEP: usize = 512;

/// The agent's stdout, keeping the first [`STDOUT_HEAD_KEEP`] bytes read.
struct FirstBytes<R> {
    inner: R,
    kept: Vec<u8>,
}

impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for FirstBytes<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let polled = std::pin::Pin::new(&mut self.inner).poll_read(cx, buf);
        if let std::task::Poll::Ready(Ok(())) = polled {
            let room = STDOUT_HEAD_KEEP.saturating_sub(self.kept.len());
            let new = &buf.filled()[before..];
            let take = new.len().min(room);
            self.kept.extend_from_slice(&new[..take]);
        }
        polled
    }
}

/// What wsl.exe printed in place of the agent's frames, as one bounded line:
/// wsl.exe prints its own errors (a distro it cannot find or start) on
/// stdout, the agent's protocol channel, where they fail as a frame (a "frame
/// payload too large" of the text's bytes). `None` when the first frame
/// decodes (or is not whole yet): stdout is the agent's.
fn printed_instead_of_frames(head: &[u8]) -> Option<String> {
    let mut decoder = sandbox_vm_protocol::Decoder::new();
    decoder.feed(head);
    decoder.next_frame().is_err().then(|| {
        let text: String = String::from_utf8_lossy(head).chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
        one_line(&text)
    })
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

/// An exchange that failed: say what the agent (or wsl.exe) reported, on its
/// stderr (`log`, its last bytes) or on stdout in place of the agent's frames
/// (`stdout_head`, its first bytes).
fn agent_failure(e: AppError, status: Option<i32>, log: &[u8], stdout_head: &[u8]) -> AppError {
    let log = String::from_utf8_lossy(log);
    let printed = printed_instead_of_frames(stdout_head);
    let tail: String = printed
        .into_iter()
        .chain(log.trim().lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().map(str::to_string))
        .collect::<Vec<_>>()
        .join("\n");
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
                "-d", "TxResBench", "-u", "root", "--cd", "/", "--exec", "/usr/bin/txresbench-sandbox-agent",
                "--stdio",
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
        let e = agent_failure(
            base,
            Some(AGENT_EXIT_SETUP),
            b"info: start\nerror: mount /sandbox-rootfs: squashfs not supported\n",
            b"",
        );
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
        let e = wsl_failure("WSL could not start the app's distro", "Error code: Wsl/Service/CreateInstance/0x80370102");
        assert!(e.to_string().contains("`wsl --install --no-distribution`"), "{e}");
        let e = wsl_failure("WSL could not list its distros", STUB_SAYS);
        assert!(e.to_string().contains("`wsl --install --no-distribution`"), "{e}");
        assert!(e.to_string().contains("not installed on this computer"), "{e}");
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
            b"",
        );
        let text = e.to_string();
        assert_eq!(e.error_code(), WSL_UNAVAILABLE_CODE);
        assert!(text.contains("the exchange between the app and the WSL agent failed"), "{text}");
        assert!(!text.contains("lost its connection"), "{text}");
        assert!(text.contains("protocol version is not served"), "{text}");
    }

    /// What wsl.exe prints on stdout (its own errors), where the agent's
    /// frames go.
    const WSL_NOT_FOUND_ON_STDOUT: &[u8] =
        b"There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n";

    /// Text in place of the agent's first frame is shown as one bounded
    /// line; the stdout of an agent whose first frame decodes is not.
    #[test]
    fn what_wsl_exe_printed_in_place_of_the_agents_frames_is_one_bounded_line() {
        assert_eq!(
            printed_instead_of_frames(WSL_NOT_FOUND_ON_STDOUT).as_deref(),
            Some("There is no distribution with the supplied name. Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND")
        );
        let long = format!("Error\x1b[31m\0 {}", "x".repeat(2 * STDOUT_HEAD_KEEP));
        let shown = printed_instead_of_frames(&long.as_bytes()[..STDOUT_HEAD_KEEP]).expect("text");
        assert!(shown.chars().count() <= 300 && !shown.chars().any(char::is_control), "{shown:?}");
        let mut framed = sandbox_vm_protocol::encode(&sandbox_vm_protocol::Frame::Stdout(b"hello".to_vec()));
        framed.extend_from_slice(WSL_NOT_FOUND_ON_STDOUT);
        assert_eq!(printed_instead_of_frames(&framed), None, "the first frame decodes");
        assert_eq!(printed_instead_of_frames(&framed[..3]), None, "the first frame is not whole yet");
        assert_eq!(printed_instead_of_frames(b""), None);
    }

    /// What the in-box wsl.exe of a Windows without WSL prints (seen on a
    /// Windows 11 VM, on stderr in UTF-16, exit 1). The real text gives the
    /// address with its scheme; it is left out here so that the source names
    /// no outbound host (scripts/check-network-allowlist.sh): the check reads
    /// only the address's host and path.
    const STUB_SAYS: &str = "The Windows Subsystem for Linux is not installed. You can install by running \
                             'wsl.exe --install'.\r\r\nFor more information please visit aka.ms/wslinstall";

    fn powershell() -> PathBuf {
        wsl_exe().with_file_name("WindowsPowerShell").join("v1.0").join("powershell.exe")
    }

    /// A fresh dir for one test.
    fn test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("txr-wsl-{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A stand-in for wsl.exe started the way the runner starts it: PowerShell
    /// runs `script` with `args` first, then the runner's own arguments.
    fn stand_in(dir: &Path, script: &str, args: &[&OsStr]) -> Wsl {
        let file = dir.join("stand-in.ps1");
        std::fs::write(&file, script).unwrap();
        let mut lead: Vec<OsString> = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]
            .iter()
            .map(OsString::from)
            .collect();
        lead.push(file.into_os_string());
        lead.extend(args.iter().map(|a| a.to_os_string()));
        Wsl { program: powershell(), lead }
    }

    /// A stand-in agent: it checks that the request `exec_over` sends reaches
    /// its stdin byte for byte (exit 9 if not), then writes `frames` to its
    /// stdout, `log` to its stderr, and exits with `code`. With `hang` it does
    /// nothing at all; with `wsl-error` it is a wsl.exe that cannot start the
    /// agent (WSL's message on stdout, exit -1); with `log-held` it leaves a
    /// process behind that holds its stdout and stderr open for 15 s. Its own
    /// arguments come first (`none` for an empty one: powershell.exe may drop
    /// an empty argument, and takes `-` for a parameter); the runner's are
    /// kept in `args.txt`.
    const FAKE_AGENT: &str = r#"
$want = [IO.File]::ReadAllBytes($args[0]); $frames = $args[1]; $log = $args[2]; $code = [int]$args[3]
[IO.File]::WriteAllText($args[5], (($args | Select-Object -Skip 6) -join ' '))
if ($args[4] -eq 'hang') { Start-Sleep -Seconds 600; exit 0 }
if ($args[4] -eq 'wsl-error') {
    [Console]::Out.Write("There is no distribution with the supplied name.`r`nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND`r`n"); exit -1
}
$in = [Console]::OpenStandardInput()
$got = New-Object byte[] $want.Length; $n = 0
while ($n -lt $want.Length) { $r = $in.Read($got, $n, $want.Length - $n); if ($r -le 0) { break }; $n += $r }
if ($n -ne $want.Length -or [Convert]::ToBase64String($got) -ne [Convert]::ToBase64String($want)) {
    [Console]::Error.WriteLine("fake agent: the request on stdin is not the one sent ($n bytes)"); exit 9
}
$b = [IO.File]::ReadAllBytes($frames); $o = [Console]::OpenStandardOutput(); $o.Write($b, 0, $b.Length); $o.Flush()
if ($log -ne 'none') { [Console]::Error.WriteLine($log) }
if ($args[4] -eq 'log-held') {
    $si = New-Object Diagnostics.ProcessStartInfo 'powershell.exe', '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 15'
    $si.UseShellExecute = $false
    [void][Diagnostics.Process]::Start($si)
}
exit $code
"#;

    /// [`FAKE_AGENT`] as the wsl.exe of a [`WslAgent`]: the real pipes, log
    /// capture, exit-code handling and command line of the runner run.
    fn fake_agent(
        tag: &str,
        req: &ExecRequest,
        frames: &[sandbox_vm_protocol::Frame],
        log: &'static str,
        code: i32,
        mode: &'static str,
    ) -> (WslAgent, PathBuf) {
        let dir = test_dir(&format!("fake-agent-{tag}"));
        let request = dir.join("request.bin");
        std::fs::write(&request, sandbox_vm_protocol::encode(&sandbox_vm_protocol::Frame::Exec(req.clone()))).unwrap();
        let frames_file = dir.join("frames.bin");
        std::fs::write(&frames_file, frames.iter().flat_map(sandbox_vm_protocol::encode).collect::<Vec<u8>>()).unwrap();
        let code = code.to_string();
        let args_file = dir.join("args.txt");
        let or_none = |s: &'static str| if s.is_empty() { "none" } else { s };
        let (log, mode) = (or_none(log), or_none(mode));
        let mut agent = WslAgent::new(Path::new(r"C:\img\base.sqfs"), Path::new(r"C:\img\layer.sqfs"), &[]).unwrap();
        agent.wsl = stand_in(
            &dir,
            FAKE_AGENT,
            &[
                request.as_os_str(),
                frames_file.as_os_str(),
                log.as_ref(),
                code.as_ref(),
                mode.as_ref(),
                args_file.as_os_str(),
            ],
        );
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
        let (agent, dir) = fake_agent("ok", &request(), &frames, "agent: done", 0, "");
        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let dirs = [OutputDir { host: out.clone(), sandbox_path: "/output".into() }];
        let outcome = AgentExec::exec(&agent, request(), Duration::from_secs(60), None, &dirs)
            .await
            .expect("the exchange succeeds (and the request reached the agent's stdin)");
        assert_eq!(outcome.exit_code, 0);
        assert_eq!(outcome.stdout, b"hello\n");
        assert!(outcome.incomplete.is_empty(), "{:?}", outcome.incomplete);
        assert_eq!(std::fs::read(out.join("pred.csv")).unwrap(), b"id,p\n1,0.5\n");
        let args = std::fs::read_to_string(dir.join("args.txt")).unwrap();
        assert!(args.starts_with("-d TxResBench -u root --cd / --exec /usr/bin/txresbench-sandbox-agent --stdio"), "{args}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The stand-in agent refuses a request that is not the one sent, so the
    /// check above is real: a different request fails the exchange.
    #[tokio::test]
    async fn the_stand_in_agent_refuses_a_request_it_was_not_sent() {
        // Of the same length, so the stand-in reads it whole before comparing.
        let mut other = request();
        other.argv = vec!["TRUE".into()];
        let (agent, dir) = fake_agent("other-request", &other, &[], "", 0, "");
        let err = AgentExec::exec(&agent, request(), Duration::from_secs(60), None, &[])
            .await
            .err()
            .expect("a different request is refused");
        assert!(err.to_string().contains("the request on stdin is not the one sent"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn an_agent_that_cannot_mount_says_why() {
        let (agent, dir) =
            fake_agent("mount", &request(), &[], "error: mount /sandbox-rootfs: squashfs not supported", 3, "");
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

    /// An agent that hangs (it never reads the request, never answers) comes
    /// back timed out at its budget, and is stopped then, not seconds later.
    /// The request is larger than a pipe's buffer, so sending it blocks too.
    #[tokio::test]
    async fn a_hung_agent_comes_back_timed_out_within_its_budget() {
        let mut req = request();
        req.argv = vec!["x".repeat(512 * 1024)];
        let (agent, dir) = fake_agent("hung", &req, &[], "", 0, "hang");
        let budget = Duration::from_secs(4);
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(60),
            AgentExec::exec(&agent, req, budget, None, &[]),
        )
        .await
        .expect("the exchange came back")
        .expect("a host timeout is an outcome");
        let took = started.elapsed();
        assert!(outcome.timed_out);
        assert_eq!(outcome.exit_code, -1);
        assert!(took >= budget, "{took:?}");
        assert!(took < budget + Duration::from_secs(5), "stopped at the budget, not after a grace: {took:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The agent's log is waited for [`AGENT_LOG_WAIT`] at most: a process
    /// left behind that holds its stderr open does not hold the run.
    #[test]
    fn the_wait_for_the_agents_log_is_bounded() {
        use sandbox_vm_protocol::{ExitStatus, Frame};
        let frames = [Frame::Exit(ExitStatus { code: 0, timed_out: false }), Frame::ArtifactsDone];
        let (agent, dir) = fake_agent("log-held", &request(), &frames, "agent: done", 0, "log-held");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let started = Instant::now();
        let outcome = rt
            .block_on(AgentExec::exec(&agent, request(), Duration::from_secs(60), None, &[]))
            .expect("the exchange succeeds");
        let took = started.elapsed();
        // The log's read goes on until the process left behind ends (15 s):
        // not waited for here either.
        rt.shutdown_background();
        assert_eq!(outcome.exit_code, 0);
        assert!(took < AGENT_LOG_WAIT + Duration::from_secs(5), "not held by the process left behind: {took:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// wsl.exe prints its own error on stdout, where the agent's frames go:
    /// the error shows WSL's message, not only a frame that does not decode.
    #[tokio::test]
    async fn a_wsl_error_in_place_of_the_agent_is_shown_to_the_user() {
        let (agent, dir) = fake_agent("wsl-error", &request(), &[], "", 0, "wsl-error");
        let err = AgentExec::exec(&agent, request(), Duration::from_secs(60), None, &[])
            .await
            .err()
            .expect("no agent ran");
        assert_eq!(err.error_code(), WSL_UNAVAILABLE_CODE);
        let text = err.to_string();
        assert!(
            text.contains(
                "\nWSL reported:\nThere is no distribution with the supplied name. Error code: \
                 Wsl/Service/WSL_E_DISTRO_NOT_FOUND"
            ),
            "{text}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// wsl.exe runs with UTF-8 messages and without the app's `WSLENV`, so
    /// none of the app's variables are copied into the distro.
    #[test]
    fn wsl_exe_gets_utf8_messages_and_no_wslenv() {
        let cmd = Wsl::system().command();
        let envs: Vec<(&OsStr, Option<&OsStr>)> = cmd.get_envs().collect();
        assert!(envs.contains(&(OsStr::new("WSLENV"), None)), "{envs:?}");
        assert!(envs.contains(&(OsStr::new("WSL_UTF8"), Some(OsStr::new("1")))), "{envs:?}");
        assert_eq!(cmd.get_program(), wsl_exe().as_os_str());
        assert_eq!(
            in_distro(&["/bin/busybox", "true"]),
            ["-d", "TxResBench", "-u", "root", "--cd", "/", "--exec", "/bin/busybox", "true"]
        );
    }

    /// A stand-in wsl.exe with the state of a WSL in a dir: `registered`
    /// (present when the app's distro is registered) holds the dir it was
    /// imported into, whose `ext4.vhdx` holds its build id (empty: a distro
    /// without the app's version file); `installing` (present while WSL is
    /// still importing or removing the app's distro) makes it listed but not
    /// found by its name, and refused an import. `mode` makes it fail its list
    /// (`list-fails`), behave as the in-box stub of a Windows without WSL
    /// (`stub`), hang (`hang`), import slowly (`slow-import`), end a removal
    /// of the app's distro right after the next list (`removed-after-list`),
    /// not find it by its name once (`not-found-once`), fail the next import
    /// (`import-fails-once`), or have the version whose build a removal
    /// removed import it again at once, into the dir it was in (`race`).
    /// Every call is appended to `calls.txt`; an import writes
    /// `tar-held.txt`: `held` when the tarball could be read but not written
    /// during the import. Messages and error codes are WSL's own (en-US), and
    /// its errors are on stdout, as wsl.exe prints them (the stub's are on
    /// stderr, as seen on a Windows without WSL).
    const FAKE_WSL: &str = r#"
$state = $args[0]
$a = @($args | Select-Object -Skip 1)
[IO.File]::AppendAllText((Join-Path $state 'calls.txt'), (($a -join ' ') + "`n"))
$reg = Join-Path $state 'registered'
$modeFile = Join-Path $state 'mode'
$mode = ''
if ([IO.File]::Exists($modeFile)) { $mode = [IO.File]::ReadAllText($modeFile).Trim() }
$installing = [IO.File]::Exists((Join-Path $state 'installing'))
function Fail($text) { [Console]::Out.Write($text + "`r`n"); exit -1 }
if ($mode -eq 'stub') { [Console]::Error.Write("The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'.`r`r`nFor more information please visit aka.ms/wslinstall`r`r`n"); exit 1 }
if ($mode -eq 'hang') { Start-Sleep -Seconds 600; exit 0 }
$notFound = "There is no distribution with the supplied name.`r`nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND"
if ($a[0] -eq '--list') {
    if ($mode -eq 'list-fails') { Fail "The remote procedure call failed.`r`nError code: Wsl/Service/0x800706be" }
    [Console]::Out.Write("Ubuntu`r`n")
    if ([IO.File]::Exists($reg) -or $installing) { [Console]::Out.Write("TxResBench`r`n") }
    if ($mode -eq 'removed-after-list' -and [IO.File]::Exists($reg)) {
        $disk = Join-Path ([IO.File]::ReadAllText($reg)) 'ext4.vhdx'
        if ([IO.File]::Exists($disk)) { [IO.File]::Delete($disk) }
        [IO.File]::Delete($reg); [IO.File]::Delete($modeFile)
    }
    exit 0
}
if ($a[0] -eq '--unregister') {
    if (-not [IO.File]::Exists($reg)) { Fail $notFound }
    $dir = [IO.File]::ReadAllText($reg)
    $disk = Join-Path $dir 'ext4.vhdx'
    $build = ''
    if ([IO.File]::Exists($disk)) { $build = [IO.File]::ReadAllText($disk); [IO.File]::Delete($disk) }
    [IO.File]::Delete($reg)
    if ($mode -eq 'race') { [IO.File]::WriteAllText($disk, $build); [IO.File]::WriteAllText($reg, $dir) }
    [Console]::Out.Write("The operation completed successfully.`r`n"); exit 0
}
if ($a[0] -eq '--import') {
    $base = $a[2]; $tar = $a[3]
    if ($installing) { Fail "An illegal state change was requested.`r`nError code: Wsl/Service/RegisterDistro/E_ILLEGAL_STATE_CHANGE" }
    if ([IO.File]::Exists($reg)) { Fail "A distribution with the supplied name already exists. Use --name to chose a different name.`r`nError code: Wsl/Service/RegisterDistro/ERROR_ALREADY_EXISTS" }
    $disk = Join-Path $base 'ext4.vhdx'
    if ([IO.File]::Exists($disk)) { Fail "The supplied install location is already in use.`r`nError code: Wsl/Service/RegisterDistro/ERROR_FILE_EXISTS" }
    if ($mode -eq 'import-fails-once') { [IO.File]::Delete($modeFile); Fail "Importing the distribution failed.`r`nError code: Wsl/Service/RegisterDistro/WSL_E_IMPORT_FAILED" }
    $held = 'held'
    try { $w = [IO.File]::Open($tar, 'Open', 'Write', 'ReadWrite, Delete'); $w.Close(); $held = 'not held' } catch { }
    [IO.File]::WriteAllText((Join-Path $state 'tar-held.txt'), $held)
    # As WSL: the tarball is opened to read, sharing read + delete.
    $f = [IO.File]::Open($tar, 'Open', 'Read', 'Read, Delete')
    $build = (New-Object IO.StreamReader($f)).ReadToEnd().Trim()
    $f.Close()
    if ($mode -eq 'slow-import') { Start-Sleep -Seconds 4 }
    [void][IO.Directory]::CreateDirectory($base)
    [IO.File]::WriteAllText($disk, $build)
    [IO.File]::WriteAllText($reg, $base)
    [Console]::Out.Write("Import in progress, this may take a few minutes.`r`nThe operation completed successfully.`r`n"); exit 0
}
if ($a[0] -eq '-d') {
    if ($installing -or -not [IO.File]::Exists($reg)) { Fail $notFound }
    if ($mode -eq 'not-found-once') { [IO.File]::Delete($modeFile); Fail $notFound }
    $disk = Join-Path ([IO.File]::ReadAllText($reg)) 'ext4.vhdx'
    if (-not [IO.File]::Exists($disk)) { Fail "Failed to attach disk '$disk' to WSL2: The system cannot find the file specified.`r`nError code: Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_FILE_NOT_FOUND" }
    $build = [IO.File]::ReadAllText($disk).Trim()
    if ($build -eq '') { [Console]::Error.Write("cat: can't open '/etc/txresbench-wsl-version': No such file or directory`n"); exit 1 }
    [Console]::Out.Write($build + "`n"); exit 0
}
Fail ("unexpected call: " + ($a -join ' '))
"#;

    /// One test's WSL: the stand-in, its state dir, the app's data root, and
    /// a guest root tarball whose content is its build id.
    struct FakeWsl {
        wsl: Wsl,
        state: PathBuf,
        data_root: PathBuf,
        runtime: Runtime,
    }

    impl FakeWsl {
        fn new(tag: &str, build: &str) -> Self {
            use sha2::Digest;
            let dir = test_dir(&format!("fake-wsl-{tag}"));
            let state = dir.join("state");
            let data_root = dir.join("data");
            std::fs::create_dir_all(&state).unwrap();
            std::fs::create_dir_all(&data_root).unwrap();
            let rootfs = dir.join(ROOTFS_FILE);
            std::fs::write(&rootfs, build).unwrap();
            let runtime = Runtime {
                rootfs,
                version: build.to_string(),
                sha256: hex::encode(sha2::Sha256::digest(build.as_bytes())),
            };
            let wsl = stand_in(&dir, FAKE_WSL, &[state.as_os_str()]);
            Self { wsl, state, data_root, runtime }
        }

        fn mode(&self, mode: &str) {
            std::fs::write(self.state.join("mode"), mode).unwrap();
        }

        /// A distro of the app's name registered in `dir`, whose build id is `build`.
        fn register(&self, dir: &Path, build: &str) {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(DISTRO_DISK_FILE), build).unwrap();
            std::fs::write(self.state.join("registered"), dir.as_os_str().to_string_lossy().as_bytes()).unwrap();
        }

        fn registered_build(&self) -> Option<String> {
            let dir = std::fs::read_to_string(self.state.join("registered")).ok()?;
            std::fs::read_to_string(Path::new(&dir).join(DISTRO_DISK_FILE)).ok()
        }

        fn location(&self) -> PathBuf {
            distro_location(&self.data_root)
        }

        /// The calls so far, by their first argument.
        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.state.join("calls.txt"))
                .unwrap_or_default()
                .lines()
                .map(|l| l.split_whitespace().next().unwrap_or("").to_string())
                .collect()
        }

        /// WSL is (or is no longer) importing or removing the app's distro.
        fn installing(&self, on: bool) {
            let flag = self.state.join("installing");
            if on {
                std::fs::write(flag, "").unwrap();
            } else {
                std::fs::remove_file(flag).unwrap();
            }
        }

        /// The guest root of another build of the app, beside this one.
        fn other_build(&self, build: &str) -> Runtime {
            use sha2::Digest;
            let rootfs = self.data_root.with_file_name(format!("{build}.tar"));
            std::fs::write(&rootfs, build).unwrap();
            Runtime { rootfs, version: build.to_string(), sha256: hex::encode(sha2::Sha256::digest(build.as_bytes())) }
        }

        fn ensure(&self) -> Result<(), AppError> {
            ensure_distro_blocking(&self.wsl, &self.runtime, &self.data_root, true, &mut false)
        }

        /// One run's check of the distro, in the process whose setup state
        /// is `set_up`, running the guest root `runtime`.
        async fn run(&self, set_up: &SetUpBuild, runtime: &Runtime) -> Result<(), AppError> {
            ensure_ready(set_up, self.wsl.clone(), runtime.clone(), self.data_root.clone()).await
        }

        fn remove(self) {
            let _ = std::fs::remove_dir_all(self.state.parent().unwrap());
        }
    }

    #[test]
    fn the_first_run_imports_the_distro_from_the_held_guest_root() {
        let w = FakeWsl::new("first", "wsl-7");
        w.ensure().expect("imported");
        assert_eq!(w.calls(), ["--list", "--import", "-d"]);
        let calls = std::fs::read_to_string(w.state.join("calls.txt")).unwrap();
        assert!(calls.starts_with("--list --quiet --all\n"), "{calls}");
        assert!(calls.contains("\n-d TxResBench -u root --cd / --exec /bin/busybox cat /etc/txresbench-wsl-version\n"), "{calls}");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        assert!(w.location().join(DISTRO_DISK_FILE).is_file());
        assert_eq!(
            std::fs::read_to_string(w.state.join("tar-held.txt")).unwrap(),
            "held",
            "the tarball cannot be written between its checksum and the end of the import"
        );
        w.remove();
    }

    #[test]
    fn a_guest_root_that_does_not_match_its_checksum_is_not_imported() {
        let mut w = FakeWsl::new("bad-sum", "wsl-7");
        w.runtime.sha256 = "0".repeat(64);
        let err = w.ensure().expect_err("refused");
        assert!(err.to_string().contains("does not match its checksum"), "{err}");
        assert_eq!(w.calls(), ["--list"]);
        w.remove();
    }

    /// A list that fails for any reason is an error: the app's distro may be
    /// registered (here it is, stopped), and its disk must stay where it is.
    #[test]
    fn a_failed_list_is_an_error_and_never_touches_the_distros_disk() {
        let w = FakeWsl::new("list-fails", "wsl-7");
        w.register(&w.location(), "wsl-7");
        w.mode("list-fails");
        let err = w.ensure().expect_err("a failed list is not an empty one");
        assert_eq!(err.error_code(), WSL_UNAVAILABLE_CODE);
        assert!(err.to_string().contains("WSL could not list its distros"), "{err}");
        assert!(err.to_string().contains("Wsl/Service/0x800706be"), "{err}");
        assert_eq!(w.calls(), ["--list"], "nothing removed, nothing imported");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        assert!(w.location().join(DISTRO_DISK_FILE).is_file(), "the disk is still there");
        w.remove();
    }

    #[test]
    fn without_wsl_the_message_says_how_to_install_it() {
        let w = FakeWsl::new("stub", "wsl-7");
        w.mode("stub");
        let err = w.ensure().expect_err("no WSL");
        assert!(err.to_string().contains("`wsl --install --no-distribution`"), "{err}");
        assert_eq!(w.calls(), ["--list"]);
        w.remove();
    }

    #[test]
    fn an_older_build_of_the_apps_distro_is_replaced() {
        let w = FakeWsl::new("older", "wsl-8");
        w.register(&w.location(), "wsl-7");
        w.ensure().expect("replaced");
        assert_eq!(w.calls(), ["--list", "-d", "--unregister", "--import", "-d"]);
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"));
        w.remove();
    }

    #[test]
    fn the_current_build_is_left_as_it_is() {
        let w = FakeWsl::new("current", "wsl-7");
        w.register(&w.location(), "wsl-7");
        w.ensure().expect("ready");
        assert_eq!(w.calls(), ["--list", "-d"]);
        w.remove();
    }

    #[test]
    fn a_distro_the_app_did_not_create_is_refused_and_left_alone() {
        let w = FakeWsl::new("foreign", "wsl-7");
        let theirs = w.data_root.join("theirs");
        w.register(&theirs, "");
        let err = w.ensure().expect_err("not the app's");
        assert!(err.to_string().contains("that this app did not create"), "{err}");
        assert_eq!(w.calls(), ["--list", "-d"], "never removed");
        assert!(theirs.join(DISTRO_DISK_FILE).is_file());
        w.remove();
    }

    /// The app's distro whose disk was deleted cannot start again: the app
    /// owns its dir, so it removes the registration and imports anew.
    #[test]
    fn the_apps_distro_whose_disk_was_deleted_is_set_up_again() {
        let w = FakeWsl::new("disk-lost", "wsl-7");
        w.ensure().expect("imported");
        std::fs::remove_file(w.location().join(DISTRO_DISK_FILE)).unwrap();
        w.ensure().expect("set up again");
        assert_eq!(w.calls(), ["--list", "--import", "-d", "--list", "-d", "--unregister", "--import", "-d"]);
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        w.remove();
    }

    /// A distro of the app's name whose missing disk is NOT in the app's dir
    /// is not the app's to remove: the message says what to do instead.
    #[test]
    fn a_missing_disk_elsewhere_is_reported_not_removed() {
        let w = FakeWsl::new("disk-elsewhere", "wsl-7");
        let theirs = w.data_root.join("theirs");
        w.register(&theirs, "wsl-7");
        std::fs::remove_file(theirs.join(DISTRO_DISK_FILE)).unwrap();
        let err = w.ensure().expect_err("not the app's disk");
        let text = err.to_string();
        assert!(text.contains("ERROR_FILE_NOT_FOUND"), "{text}");
        assert!(text.contains("`wsl --unregister TxResBench`"), "{text}");
        assert_eq!(w.calls(), ["--list", "-d"], "never removed");
        w.remove();
    }

    /// Every run starts the distro (one call), and a distro removed or left
    /// without its disk since the last run is set up again instead of
    /// failing the run, in the same process.
    #[tokio::test]
    async fn every_run_starts_the_distro_and_sets_up_one_removed_meanwhile() {
        let w = FakeWsl::new("recheck", "wsl-7");
        let set_up: SetUpBuild = Arc::new(tokio::sync::Mutex::new(None));
        let run = || ensure_ready(&set_up, w.wsl.clone(), w.runtime.clone(), w.data_root.clone());
        run().await.expect("first run: imported");
        assert_eq!(w.calls(), ["--list", "--import", "-d"]);
        run().await.expect("second run: started");
        assert_eq!(w.calls(), ["--list", "--import", "-d", "-d"], "one start, nothing else");
        std::fs::remove_file(w.state.join("registered")).unwrap(); // `wsl --unregister TxResBench`
        run().await.expect("third run: set up again");
        assert_eq!(w.calls(), ["--list", "--import", "-d", "-d", "-d", "--list", "--import", "-d"]);
        std::fs::remove_file(w.location().join(DISTRO_DISK_FILE)).unwrap();
        run().await.expect("fourth run: its disk was deleted, set up again");
        assert_eq!(w.calls()[8..], ["-d", "--list", "-d", "--unregister", "--import", "-d"]);
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        assert_eq!(set_up.lock().await.as_deref(), Some("wsl-7"));
        w.remove();
    }

    /// A run cancelled during the import leaves the import running with the
    /// setup lock: the next run waits for it, and never imports a second time.
    #[tokio::test]
    async fn a_run_cancelled_during_the_import_does_not_let_a_second_import_start() {
        let w = FakeWsl::new("cancelled", "wsl-7");
        w.mode("slow-import");
        let set_up: SetUpBuild = Arc::new(tokio::sync::Mutex::new(None));
        let first = tokio::time::timeout(
            Duration::from_millis(2_500),
            ensure_ready(&set_up, w.wsl.clone(), w.runtime.clone(), w.data_root.clone()),
        )
        .await;
        assert!(first.is_err(), "the first run was cancelled during its import");
        ensure_ready(&set_up, w.wsl.clone(), w.runtime.clone(), w.data_root.clone())
            .await
            .expect("the next run waited for the import");
        assert_eq!(w.calls().iter().filter(|c| *c == "--import").count(), 1, "{:?}", w.calls());
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        w.remove();
    }

    /// WSL lists a distro it is still importing or removing (`--all`), but
    /// cannot start it ("no distribution with the supplied name"): the app
    /// quit or stopped waiting during its import, and WSL's service went on
    /// with it. The run fails with what to do, and the dir (with the disk WSL
    /// is writing) is left alone; once WSL is done, the next run finds the
    /// distro ready. A process that set the distro up meets the same on a
    /// later run (another version of the app importing it, say). Whose
    /// import it is cannot be told (the user may be importing a distro of
    /// that name), so the command that removes it is given for the app's
    /// distro only.
    #[tokio::test]
    async fn a_distro_wsl_is_still_importing_fails_the_run_and_keeps_its_dir() {
        let w = FakeWsl::new("installing", "wsl-7");
        w.register(&w.location(), "wsl-7");
        w.installing(true);
        let set_up = SetUpBuild::default();
        let err = w.run(&set_up, &w.runtime).await.expect_err("WSL is not done");
        let text = err.to_string();
        assert_eq!(err.error_code(), WSL_UNAVAILABLE_CODE);
        assert!(text.contains("WSL is still setting up or removing a distro named TxResBench"), "{text}");
        assert!(text.contains("try again in a minute"), "{text}");
        assert!(
            text.contains("If this persists and the TxResBench distro is the app's, run `wsl --unregister TxResBench`"),
            "{text}"
        );
        assert_eq!(text.matches("wsl --unregister").count(), 1, "the command is given only with its condition: {text}");
        assert!(!text.contains("the app's distro"), "it may not be the app's: {text}");
        assert_eq!(w.calls(), ["--list", "-d", "--list"], "nothing removed, nothing imported");
        assert!(w.location().join(DISTRO_DISK_FILE).is_file(), "the disk is still there");
        w.installing(false);
        w.run(&set_up, &w.runtime).await.expect("WSL is done: ready");
        assert_eq!(w.calls()[3..], ["--list", "-d"]);
        w.installing(true);
        let err = w.run(&set_up, &w.runtime).await.expect_err("a later run: WSL is not done");
        assert!(err.to_string().contains("WSL is still setting up or removing a distro named TxResBench"), "{err}");
        assert_eq!(w.calls()[5..], ["-d", "--list", "-d", "--list"], "nothing removed, nothing imported");
        assert!(w.location().join(DISTRO_DISK_FILE).is_file(), "the disk is still there");
        w.remove();
    }

    /// A distro whose removal ends right after the list is no longer listed
    /// by the second list: it is set up anew.
    #[test]
    fn a_distro_removed_after_it_was_listed_is_set_up_again() {
        let w = FakeWsl::new("removed-after-list", "wsl-7");
        w.register(&w.location(), "wsl-7");
        w.mode("removed-after-list");
        w.ensure().expect("set up anew");
        assert_eq!(w.calls(), ["--list", "-d", "--list", "--import", "-d"]);
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        w.remove();
    }

    /// Two versions of the app on one Windows account (an installed app and
    /// a development build) share the distro's name. Each replaces the
    /// other's build on its first setup only: every later run that finds the
    /// other build fails and leaves it there (removing it would stop that
    /// version's running method), the run after a failed one too, until this
    /// version is restarted: its first setup then sets its build up again.
    #[tokio::test]
    async fn a_build_another_version_put_there_is_not_replaced_by_a_later_run() {
        let w = FakeWsl::new("two-versions", "wsl-7");
        let other = w.other_build("wsl-8");
        let (mine, theirs) = (SetUpBuild::default(), SetUpBuild::default());
        w.run(&mine, &w.runtime).await.expect("this version's first run: imported");
        w.run(&theirs, &other).await.expect("the other version's first run: replaced");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"));
        let err = w.run(&mine, &w.runtime).await.expect_err("replaced by another version");
        let text = err.to_string();
        assert_eq!(err.error_code(), WSL_UNAVAILABLE_CODE);
        assert!(text.contains("another version of TxResBench"), "{text}");
        assert!(text.contains("it is now build wsl-8; this version needs wsl-7"), "{text}");
        assert!(text.contains("close the other version, then restart this one"), "{text}");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"), "left there");
        w.run(&theirs, &other).await.expect("the other version's runs go on");
        let err = w.run(&mine, &w.runtime).await.expect_err("the run after a failed one");
        assert!(err.to_string().contains("another version of TxResBench"), "{err}");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"), "left there");
        // The other version is closed, and this one restarted.
        let restarted = SetUpBuild::default();
        w.run(&restarted, &w.runtime).await.expect("set up again");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        assert_eq!(w.calls(), [
            "--list", "--import", "-d",                       // mine: first setup
            "--list", "-d", "--unregister", "--import", "-d", // theirs: first setup, replaces
            "-d",                                             // mine: fails, removes nothing
            "-d",                                             // theirs
            "-d",                                             // mine: fails again
            "--list", "-d", "--unregister", "--import", "-d", // mine, restarted: first setup
        ]);
        w.remove();
    }

    /// Runs go several at a time (one per lane), so the run after a failed
    /// one is often already waiting on the setup lock: after another version
    /// took the distro over, every one of them fails, and none replaces it.
    #[tokio::test]
    async fn runs_waiting_on_each_other_never_replace_another_versions_build() {
        let w = FakeWsl::new("two-versions-lanes", "wsl-7");
        let other = w.other_build("wsl-8");
        let (mine, theirs) = (SetUpBuild::default(), SetUpBuild::default());
        w.run(&mine, &w.runtime).await.expect("mine: imported");
        w.run(&theirs, &other).await.expect("theirs: replaced");
        let (a, b, c) = tokio::join!(w.run(&mine, &w.runtime), w.run(&mine, &w.runtime), w.run(&mine, &w.runtime));
        for result in [a, b, c] {
            let err = result.expect_err("another version's build");
            assert!(err.to_string().contains("another version of TxResBench"), "{err}");
        }
        assert_eq!(w.calls()[8..], ["-d", "-d", "-d"], "nothing removed, nothing imported");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"));
        w.remove();
    }

    /// A process that set the distro up and finds it gone on a later run
    /// sets it up again, but another version's build found by that setup
    /// (imported meanwhile) is left there all the same.
    #[tokio::test]
    async fn a_later_runs_setup_leaves_another_versions_build_there() {
        let w = FakeWsl::new("two-versions-setup", "wsl-7");
        let set_up = SetUpBuild::default();
        w.run(&set_up, &w.runtime).await.expect("imported");
        w.register(&w.location(), "wsl-8");
        w.mode("not-found-once");
        let err = w.run(&set_up, &w.runtime).await.expect_err("another version's build");
        assert!(err.to_string().contains("another version of TxResBench"), "{err}");
        assert_eq!(w.calls(), ["--list", "--import", "-d", "-d", "--list", "-d"], "never removed");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"));
        w.remove();
    }

    /// A later run's setup that fails (WSL still importing another version's
    /// build, a failed list) leaves this process set up: the run after it is
    /// not a first setup, and the other version's build it finds is left
    /// there all the same.
    #[tokio::test]
    async fn a_later_runs_failed_setup_does_not_let_the_next_run_replace_another_versions_build() {
        let w = FakeWsl::new("two-versions-failed-setup", "wsl-7");
        let mine = SetUpBuild::default();
        w.run(&mine, &w.runtime).await.expect("imported");
        // Another version's first setup removed this build and is importing
        // its own, into its own data dir.
        let theirs = w.data_root.with_file_name("other-data").join("wsl").join("distro");
        w.register(&theirs, "wsl-8");
        w.installing(true);
        let err = w.run(&mine, &w.runtime).await.expect_err("WSL is not done");
        assert!(err.to_string().contains("WSL is still setting up or removing"), "{err}");
        w.installing(false);
        let err = w.run(&mine, &w.runtime).await.expect_err("another version's build");
        assert!(err.to_string().contains("another version of TxResBench"), "{err}");
        assert_eq!(w.calls()[3..], ["-d", "--list", "-d", "--list", "-d"], "nothing removed, nothing imported");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"));
        // Gone again and the list fails; then the other version's build is back.
        std::fs::remove_file(w.state.join("registered")).unwrap();
        w.mode("list-fails");
        let err = w.run(&mine, &w.runtime).await.expect_err("a failed list");
        assert!(err.to_string().contains("WSL could not list its distros"), "{err}");
        std::fs::remove_file(w.state.join("mode")).unwrap();
        w.register(&theirs, "wsl-8");
        let err = w.run(&mine, &w.runtime).await.expect_err("another version's build");
        assert!(err.to_string().contains("another version of TxResBench"), "{err}");
        assert_eq!(w.calls()[8..], ["-d", "--list", "-d"], "nothing removed, nothing imported");
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"));
        w.remove();
    }

    /// A first setup that fails before removing anything sets nothing up, so
    /// the next run is a first setup again: here WSL was still importing the
    /// build of the version this one updated (that version quit during its
    /// import); once WSL is done, that older build is replaced, with no
    /// restart.
    #[tokio::test]
    async fn a_failed_first_setup_leaves_the_next_run_a_first_setup() {
        let w = FakeWsl::new("first-setup-fails", "wsl-8");
        w.register(&w.location(), "wsl-7");
        w.installing(true);
        let set_up = SetUpBuild::default();
        let err = w.run(&set_up, &w.runtime).await.expect_err("WSL is not done");
        assert!(err.to_string().contains("WSL is still setting up or removing"), "{err}");
        assert_eq!(*set_up.lock().await, None);
        w.installing(false);
        w.run(&set_up, &w.runtime).await.expect("the older build is replaced");
        assert_eq!(w.calls(), ["--list", "-d", "--list", "--list", "-d", "--unregister", "--import", "-d"]);
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"));
        w.remove();
    }

    /// Another version that set the distro up imports its build again as
    /// soon as this version's first setup removed it (its run was waiting
    /// for the distro), so this import finds the name taken. That first
    /// setup took the distro over all the same: the runs waiting behind it,
    /// and every later run, fail and leave the other build there, so this
    /// process removes it once only.
    #[tokio::test]
    async fn a_first_setup_that_removed_another_versions_build_and_failed_never_removes_it_again() {
        let w = FakeWsl::new("race", "wsl-8");
        let theirs = w.data_root.with_file_name("other-data").join("wsl").join("distro");
        w.register(&theirs, "wsl-7");
        w.mode("race");
        let set_up = SetUpBuild::default();
        let (a, b, c) =
            tokio::join!(w.run(&set_up, &w.runtime), w.run(&set_up, &w.runtime), w.run(&set_up, &w.runtime));
        let texts: Vec<String> = [a, b, c].into_iter().map(|r| r.expect_err("no run sets up").to_string()).collect();
        let import_failed = texts.iter().filter(|t| t.contains("WSL could not import the app's distro")).count();
        let other_build = texts.iter().filter(|t| t.contains("another version of TxResBench")).count();
        assert_eq!((import_failed, other_build), (1, 2), "{texts:?}");
        assert!(texts.iter().any(|t| t.contains("Wsl/Service/RegisterDistro/ERROR_ALREADY_EXISTS")), "{texts:?}");
        let err = w.run(&set_up, &w.runtime).await.expect_err("a later run");
        assert!(err.to_string().contains("another version of TxResBench"), "{err}");
        assert_eq!(w.calls(), [
            "--list", "-d", "--unregister", "--import", // the first setup: removed once, the import fails
            "-d", "-d",                                 // the runs that waited: fail
            "-d",                                       // a later run: fails
        ]);
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        assert!(theirs.join(DISTRO_DISK_FILE).is_file());
        w.remove();
    }

    /// A guest root that does not match its checksum (a broken development
    /// build) is refused before anything is removed: another version's build
    /// stays there, on this run and on the next (a first setup again, since
    /// nothing was removed).
    #[tokio::test]
    async fn a_guest_root_that_does_not_match_its_checksum_removes_nothing() {
        let mut w = FakeWsl::new("bad-sum-other", "wsl-8");
        w.runtime.sha256 = "0".repeat(64);
        let theirs = w.data_root.with_file_name("other-data").join("wsl").join("distro");
        w.register(&theirs, "wsl-7");
        let set_up = SetUpBuild::default();
        for _ in 0..2 {
            let err = w.run(&set_up, &w.runtime).await.expect_err("refused");
            assert!(err.to_string().contains("does not match its checksum"), "{err}");
        }
        assert_eq!(w.calls(), ["--list", "-d", "--list", "-d"], "nothing removed, nothing imported");
        assert_eq!(*set_up.lock().await, None);
        assert_eq!(w.registered_build().as_deref(), Some("wsl-7"));
        assert!(!w.location().exists(), "the app's distro dir is not touched either");
        w.remove();
    }

    /// An update's first setup that removed the older build of the app's
    /// distro (that of the version it replaced) and then failed its import
    /// counts as set up; the next run finds no distro and imports this build,
    /// with no restart.
    #[tokio::test]
    async fn an_update_whose_import_failed_after_removing_the_older_build_imports_on_the_next_run() {
        let w = FakeWsl::new("update-import-fails", "wsl-8");
        w.register(&w.location(), "wsl-7");
        w.mode("import-fails-once");
        let set_up = SetUpBuild::default();
        let err = w.run(&set_up, &w.runtime).await.expect_err("the import failed");
        assert!(err.to_string().contains("Wsl/Service/RegisterDistro/WSL_E_IMPORT_FAILED"), "{err}");
        assert_eq!(set_up.lock().await.as_deref(), Some("wsl-8"), "the older build was removed");
        assert_eq!(w.registered_build(), None);
        w.run(&set_up, &w.runtime).await.expect("imported, no restart");
        assert_eq!(w.calls(), [
            "--list", "-d", "--unregister", "--import", // first setup: the older build removed, the import fails
            "-d", "--list", "--import", "-d",           // next run: no distro, imported
        ]);
        assert_eq!(w.registered_build().as_deref(), Some("wsl-8"));
        w.remove();
    }

    #[test]
    fn a_wsl_command_that_hangs_is_stopped_at_its_budget() {
        let w = FakeWsl::new("hang", "wsl-7");
        w.mode("hang");
        let started = Instant::now();
        let err = w.wsl.run(&["--list", "--quiet", "--all"], Duration::from_secs(3)).err().expect("timed out");
        assert!(err.contains("did not finish within 3 s"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
        w.remove();
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

    /// Every run hashes the bytes it holds: an image rewritten between two
    /// runs with the same size and its old creation and write times (any
    /// writer can set them) is refused on the next run.
    #[test]
    fn a_held_image_is_hashed_on_every_run() {
        use sha2::Digest;
        use std::os::windows::fs::FileTimesExt;
        let dir = test_dir("rehash");
        let img = dir.join("layer.sqfs");
        std::fs::write(&img, b"image bytes A").unwrap();
        let digest = hex::encode(sha2::Sha256::digest(b"image bytes A"));
        let md = std::fs::metadata(&img).unwrap();
        let (created, modified) = (md.created().unwrap(), md.modified().unwrap());
        drop(ImageHold::verify(&[(img.clone(), digest.clone())]).expect("first run: verified"));
        std::fs::write(&img, b"image bytes B").unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(&img).unwrap();
        f.set_times(std::fs::FileTimes::new().set_created(created).set_modified(modified)).unwrap();
        drop(f);
        let md = std::fs::metadata(&img).unwrap();
        assert_eq!((md.len(), md.created().unwrap(), md.modified().unwrap()), (13, created, modified));
        let err = ImageHold::verify(&[(img.clone(), digest)]).err().expect("the rewritten bytes are refused");
        assert_eq!(err.error_code(), super::super::method_env::ENV_VERIFY_FAILED_CODE);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
