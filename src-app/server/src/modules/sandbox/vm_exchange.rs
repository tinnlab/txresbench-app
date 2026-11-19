//! The host side of a guest agent exchange, shared by the macOS method VM
//! (`mac_vm_run`: a libkrun VM per run, reached over a vsock bridge) and the
//! Windows WSL runner (`wsl_run`: an agent process per request, reached over
//! `wsl.exe`'s stdin/stdout).
//!
//! Both run the SAME guest agent (`sdk/crates/sandbox-guest-agent`) speaking
//! `sandbox-vm-protocol` and present the same guest paths (the base image at
//! [`GUEST_BASE_MOUNT`], the layer at [`GUEST_LAYER_MOUNT`], read-only input
//! `i` at `/host-mounts/<i>`, outputs under [`GUEST_ARTIFACTS_OUT_DIR`]), so the
//! stacked bwrap argv, the request, the frame loop, the pre-run checks and the
//! output writer here are one implementation. Only how the byte stream to the
//! agent is opened differs ([`AgentExec`]).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use sandbox_vm_protocol::{encode, Decoder, ExecRequest, Frame};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use txresbench_core::AppError;

use super::backend::ProgressSink;
use super::service::{append_capped, forward_log_line, LOG_PHASE_STDERR, LOG_PHASE_STDOUT};
use super::stack;
use super::streaming::{parse_milestone_line, parse_progress_line};

/// bwrap inside the guest root.
pub const GUEST_BWRAP_PATH: &str = "/usr/bin/bwrap";
/// The guest agent (the VM's entrypoint).
pub(crate) const GUEST_AGENT_PATH: &str = "/usr/bin/txresbench-sandbox-agent";
/// The guest root's busybox: runs the read-only pre-run checks (no bwrap).
pub(crate) const GUEST_BUSYBOX_PATH: &str = "/bin/busybox";
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

/// File in the guest root naming the protocol versions its agent serves
/// (`MIN MAX`); the guest root's builder writes it next to the agent, and
/// the probe checks that the range covers what this app needs.
pub const GUEST_PROTOCOL_MARKER: &str = "etc/txresbench-agent-protocol";
/// The protocol version this app's requests carry.
pub(crate) fn app_needs_version() -> u32 {
    sandbox_vm_protocol::PROTOCOL_VERSION
}

/// Whether a guest root's protocol marker — `MIN MAX`, the versions its agent
/// serves (a single number means exactly that one) — covers `needed`.
pub(crate) fn marker_serves(text: &str, needed: u32) -> Result<(), String> {
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

/// Budget of one pre-run check (busybox cat / test inside the guest).
pub(crate) const CHECK_TIMEOUT_MS: u64 = 15_000;
/// Once outputs are streaming back, how long the exchange may go without
/// any data before the copy-back counts as stalled.
pub(crate) const COPY_BACK_IDLE: Duration = Duration::from_secs(60);

/// The method VM could not be prepared, booted or reached, or stopped
/// before the command finished.
pub const VM_UNAVAILABLE_CODE: &str = "SANDBOX_VM_UNAVAILABLE";

/// Some of the run's output files could not be copied back from the method
/// VM; the run is refused rather than kept with partial outputs.
pub const VM_OUTPUTS_INCOMPLETE_CODE: &str = "SANDBOX_VM_OUTPUTS_INCOMPLETE";

/// Where the guest agent runs, as messages name it: the macOS method VM, or
/// the Windows app's WSL distro. Only the words differ by platform: every
/// error CODE is the same on both (the UI maps the codes).
#[cfg(target_os = "macos")]
const GUEST: &str = "the method VM";
#[cfg(windows)]
const GUEST: &str = "the app's WSL distro";

/// [`GUEST`] at the start of a sentence.
#[cfg(target_os = "macos")]
const GUEST_CAPITALIZED: &str = "The method VM";
#[cfg(windows)]
const GUEST_CAPITALIZED: &str = "The app's WSL distro";

/// What stopped when an exchange ended early: the whole VM on macOS, the
/// request's own agent process on Windows.
#[cfg(target_os = "macos")]
const GUEST_AGENT: &str = "the method VM";
#[cfg(windows)]
const GUEST_AGENT: &str = "the agent in the app's WSL distro";

/// Why the agent can have stopped without an exit status, and where to look.
/// On Windows the runner adds what WSL reported itself.
#[cfg(target_os = "macos")]
const GUEST_STOPPED_WHY: &str = "the VM crashed or ran out of memory, or its guest agent is a \
                                 different protocol version than this app; see the VM log";
#[cfg(windows)]
const GUEST_STOPPED_WHY: &str = "WSL stopped it or ran out of memory, or the agent is a different \
                                 protocol version than this app";

pub(crate) fn vm_error(message: impl Into<String>) -> AppError {
    AppError::new(StatusCode::SERVICE_UNAVAILABLE, VM_UNAVAILABLE_CODE, message.into())
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

/// One way to reach the guest agent: run ONE [`ExecRequest`] and collect its
/// result ([`exec_over`] on whatever byte stream reaches the agent). The macOS
/// method VM connects to its vsock bridge per request; the Windows runner
/// starts one agent process per request.
pub trait AgentExec {
    fn exec(
        &self,
        req: ExecRequest,
        host_budget: Duration,
        sink: Option<&Arc<dyn ProgressSink>>,
        artifact_dirs: &[OutputDir],
    ) -> impl std::future::Future<Output = Result<VmExecOutcome, AppError>> + Send;
}

/// A guest path the agent printed (raw bytes) as a host-side `PathBuf` for
/// comparing with the layer manifest's parent dirs.
#[cfg(unix)]
fn guest_path_from_bytes(p: &[u8]) -> PathBuf {
    PathBuf::from(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(p))
}

/// A guest path the agent printed (raw bytes) as a host-side `PathBuf`. The
/// layer manifest's entries are validated text, so a name that is not UTF-8
/// can never match one and is kept lossily (it then counts as missing).
#[cfg(windows)]
fn guest_path_from_bytes(p: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(p).into_owned())
}

/// Run one command in the VM and collect its result.
///
/// With a `sink`, complete stdout/stderr lines are forwarded live as log
/// frames (the Linux seam's [`LOG_PHASE_STDOUT`] / [`LOG_PHASE_STDERR`]),
/// and the guest's progress-FIFO lines as milestone/progress frames. Files
/// the agent streams back from `req.collect_artifacts[i]` are written under
/// `artifact_dirs[i]`. `host_budget` bounds the whole exchange (the
/// agent enforces `req.timeout_ms` itself; this is the backstop).
pub async fn exec_over<S>(
    mut stream: S,
    req: ExecRequest,
    host_budget: Duration,
    sink: Option<&Arc<dyn ProgressSink>>,
    artifact_dirs: &[OutputDir],
) -> Result<VmExecOutcome, AppError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let started = Instant::now();
    // The agent sends Exit as soon as the command ends, then the outputs,
    // then ArtifactsDone.
    // The host enforces the same total the agent is told (0 = none).
    let output_budget = match req.artifacts.total_cap_bytes {
        0 => u64::MAX,
        cap => cap,
    };
    let deadline = started + host_budget;
    // The request is sent within the budget too: an agent that hangs before
    // reading it would otherwise block this write forever once the request
    // is larger than the pipe's buffer.
    let mut host_timed_out = false;
    match tokio::time::timeout(host_budget, stream.write_all(&encode(&Frame::Exec(req)))).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(vm_error(format!("send the command to {GUEST}: {e}"))),
        Err(_) => host_timed_out = true,
    }

    let sink_ref = sink.map(|s| s.as_ref());
    let mut decoder = Decoder::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut out = LineCapture::new(LOG_PHASE_STDOUT, false);
    let mut err = LineCapture::new(LOG_PHASE_STDERR, true);
    let mut exit: Option<(i32, bool)> = None;
    let mut outputs_done = false;
    // Outputs that did not make it back (agent-reported, a stalled or
    // cut-off copy-back, or a failed host write).
    let mut incomplete: Vec<String> = Vec::new();
    // Output files are written by one blocking thread, never on the async
    // executor.
    let mut writer = ArtifactWriter::start(artifact_dirs.to_vec(), output_budget);
    // Set when the command's exit arrives: the copy-back's overall limit.
    let mut copy_back_until: Option<Instant> = None;

    'read: while !host_timed_out {
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
                return Err(vm_error(format!("read from {GUEST}: {e}")));
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
                    return Err(vm_error(format!("protocol error in the exchange with {GUEST}: {e}")));
                }
            }
        }
    }
    out.finish(sink_ref);
    err.finish(sink_ref);
    let report = writer.finish().await;
    incomplete.extend(report.errors);
    if exit.is_some() && !outputs_done && incomplete.is_empty() {
        incomplete.push(format!("{GUEST_AGENT} stopped before the output copy-back finished"));
    }
    finish_listed(&mut incomplete);
    let (exit_code, timed_out) = match exit {
        Some(e) => e,
        None if host_timed_out => (-1, true),
        // The stream closed without an Exit frame: the VM or its agent
        // stopped (crash, guest out of memory, launcher killed). That is
        // a VM failure, not a timeout and not the workload's own result.
        None => {
            return Err(vm_error(format!(
                "{GUEST_AGENT} stopped before the command finished: no exit status came back \
                 ({GUEST_STOPPED_WHY})"
            )));
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
pub(crate) async fn check<A: AgentExec>(agent: &A, argv: &[&str]) -> Result<VmExecOutcome, AppError> {
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
    agent.exec(req, Duration::from_millis(CHECK_TIMEOUT_MS + 5_000), None, &[]).await
}

/// The layer's bind entries and the wrapper command, read inside the VM
/// where the images are mounted, and validated by the same `stack` rules
/// the Linux seam applies on the host.
pub async fn read_layer_plan<A: AgentExec>(agent: &A) -> Result<(Vec<String>, String), AppError> {
    let manifest = format!("{GUEST_LAYER_MOUNT}/{}", stack::LAYER_MANIFEST_FILE);
    let read = check(agent, &["cat", &manifest]).await?;
    if read.timed_out {
        return Err(vm_error(format!("reading {manifest} in {GUEST} timed out")));
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
            format!("read {manifest} in {GUEST}: {why}"),
        ));
    }
    let entries = stack::parse_layer_manifest(&read.stdout, &format!("{manifest} (in {GUEST})"))?;

    // No path bwrap binds out of the base or the layer, nor the base where
    // a layer entry's bind lands, may have a symbolic link in it: bwrap
    // would follow it into the guest's own root (the method VM's; on Windows
    // the app's WSL distro's, which has the Windows drives under `/mnt`).
    let probe = stack::BindSourceProbe::new(&entries, GUEST_BASE_MOUNT, GUEST_LAYER_MOUNT)?;
    let links = check(agent, &probe.argv()).await?;
    let not_checked = |why: String| {
        vm_error(format!(
            "{GUEST_CAPITALIZED} could not check the method and base images for symbolic links: {why}"
        ))
    };
    if links.timed_out {
        return Err(not_checked("the check timed out".to_string()));
    }
    if links.stdout_truncated {
        return Err(not_checked("its answer was too long".to_string()));
    }
    if links.exit_code != 0 {
        let mut why = format!("the check failed with exit status {}", links.exit_code);
        let stderr = String::from_utf8_lossy(&links.stderr);
        if !stderr.trim().is_empty() {
            why.push_str(&format!(": {}", stderr.trim()));
        }
        return Err(not_checked(why));
    }
    probe.verdict(&links.stdout, not_checked)?;

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
        let probe = check(agent, &argv).await?;
        if probe.exit_code != 0 || probe.timed_out {
            return Err(vm_error(format!(
                "check the layer's parent dirs in {GUEST}: {}",
                String::from_utf8_lossy(&probe.stderr).trim()
            )));
        }
        missing = probe
            .stdout
            .split(|&b| b == 0)
            .filter(|p| !p.is_empty())
            .map(guest_path_from_bytes)
            .collect();
    }
    stack::assert_entry_parents_with(
        &entries,
        &format!("{GUEST_BASE_MOUNT} (in {GUEST})"),
        |rel| !missing.contains(rel),
    )?;

    // The wrapper command: method.json's language + which scripts exist.
    let method_json_path = format!("{GUEST_LAYER_MOUNT}/code/method.json");
    let method_json = check(agent, &["cat", &method_json_path]).await?;
    if method_json.timed_out {
        return Err(vm_error(format!("reading the layer's method.json in {GUEST} timed out")));
    }
    if method_json.stdout_truncated {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            stack::METHOD_ENTRYPOINT_MISSING_CODE,
            format!("the layer's /code/method.json is larger than the 1 MiB a check in {GUEST} reads"),
        ));
    }
    // A non-zero exit is a missing method.json (allowed: presence order).
    let method_json = (method_json.exit_code == 0).then_some(method_json.stdout);
    let script = format!(
        "for s do [ -f \"{GUEST_LAYER_MOUNT}/code/$s\" ] && printf '%s\\n' \"$s\"; done; exit 0"
    );
    let mut argv: Vec<&str> = vec!["sh", "-c", &script, "sh"];
    argv.extend(stack::METHOD_ENTRY_SCRIPTS.iter().map(|(_, s)| *s));
    let present_out = check(agent, &argv).await?;
    if present_out.exit_code != 0 || present_out.timed_out {
        return Err(vm_error(format!(
            "list the layer's wrapper scripts in {GUEST}: {}",
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
        &format!("{GUEST_LAYER_MOUNT} (in {GUEST})"),
    )?;
    Ok((entries, command))
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
        "the method's outputs could not all be copied back from {GUEST}: {}",
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

/// How messages name the host's file system (both fold names together).
#[cfg(target_os = "macos")]
const HOST_FS: &str = "the Mac's file system";
#[cfg(windows)]
const HOST_FS: &str = "Windows' file system";

/// Whether the host's file system can hold `part` as one plain name. Windows
/// gives meaning to characters and names a Linux workload may use freely: `\`
/// and `:` (a path separator, a drive, an alternate data stream), `<>"|?*` and
/// control characters, a trailing dot or space (silently dropped), and the
/// device names (`CON`, `NUL`, `COM1`, `LPT¹`, ... with any extension). Such a
/// name could land somewhere other than where the workload put it, so it is
/// refused.
#[cfg(windows)]
fn host_name_ok(part: &str) -> bool {
    if part.chars().any(|c| c < ' ' || matches!(c, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')) {
        return false;
    }
    if part.ends_with('.') || part.ends_with(' ') {
        return false;
    }
    let stem = part.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.chars().count() == 4
            && matches!(stem.chars().nth(3), Some('0'..='9' | '¹' | '²' | '³')));
    !device
}

/// Every plain name fits the Mac's file system (APFS folding is handled by
/// [`fold_name`] and the exact-name check).
#[cfg(not(windows))]
fn host_name_ok(_part: &str) -> bool {
    true
}

/// Open without following a symlink at the last path part (`O_NOFOLLOW`).
#[cfg(unix)]
fn no_follow(open: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    open.custom_flags(libc::O_NOFOLLOW);
}

/// Open a reparse point (symlink, junction) itself, never what it points to
/// (`FILE_FLAG_OPEN_REPARSE_POINT`), so a write cannot land elsewhere.
#[cfg(windows)]
fn no_follow(open: &mut std::fs::OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    open.custom_flags(0x0020_0000);
}

/// Create the relative symlink `dest -> target`.
#[cfg(unix)]
fn make_symlink(target: &str, dest: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, dest).map_err(|e| format!("symlink: {e}"))
}

/// Windows: never called ([`WriterState::symlink`] leaves every link out).
#[cfg(windows)]
fn make_symlink(_target: &str, _dest: &Path) -> Result<(), String> {
    Err("symlinks are not created on Windows".into())
}

/// Why a symlink in the saved model's dir fails a Windows run.
const MODEL_LINK_REFUSED: &str = "the method saved a symbolic link with its model, and Windows does \
                                  not let the app create links, so the saved model would be missing \
                                  that file; the method has to save the file itself instead of a link";

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
                    // Keyed the way the guest names outputs: parts joined
                    // with `/` (Windows would print `sub\old.csv`).
                    let rel = rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/");
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
            !part.is_empty() && part != "." && part != ".." && part.len() <= MAX_NAME_BYTES && host_name_ok(part)
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
                            "{prefix} is the same name as an existing entry to {HOST_FS} (it \
                             differs only by letter case or Unicode form)"
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
                        "differs from {seen} only by letter case or Unicode form, and {HOST_FS} \
                         cannot keep both"
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
        // Windows: creating a symlink needs a privilege (Developer Mode or an
        // administrator) the app does not have, so an output symlink is left
        // out with a note. Not in the saved model's dir: a model missing a
        // file it links to would be saved as if complete (its digest skips
        // links) and fail only when it is reused, so the run fails now.
        if cfg!(windows) {
            if self.is_model_dir(mount_index) {
                return Err(MODEL_LINK_REFUSED.into());
            }
            return Ok(self.leave_out(rel_path, target));
        }
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
        make_symlink(&link_target, &dest)
    }

    /// Whether output dir `mount_index` is the saved model's
    /// ([`stack::MODEL_SANDBOX_PATH`] in the workload's sandbox).
    fn is_model_dir(&self, mount_index: u32) -> bool {
        self.sandbox_paths
            .get(mount_index as usize)
            .is_some_and(|p| p.trim_end_matches('/') == stack::MODEL_SANDBOX_PATH)
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
            let mut open = std::fs::OpenOptions::new();
            open.write(true);
            no_follow(&mut open);
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
    use std::sync::Mutex;

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

    /// A nested file already in an output dir is keyed as the guest names it
    /// (`sub/old.csv`), so it is overwritten like a top-level one (Windows
    /// used to key it `sub\\old.csv` and refuse it as an existing file).
    #[test]
    fn writer_may_overwrite_a_nested_file_that_was_there_before_the_run() {
        let root = TempDir::new();
        std::fs::create_dir_all(root.0.join("sub").join("deeper")).unwrap();
        std::fs::write(root.0.join("sub").join("old.csv"), b"stale").unwrap();
        std::fs::write(root.0.join("sub").join("deeper").join("old.csv"), b"stale").unwrap();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        w.apply(WriterMsg::Chunk(0, "sub/old.csv".into(), 0, b"new".to_vec()));
        w.apply(WriterMsg::Chunk(0, "sub/deeper/old.csv".into(), 0, b"newer".to_vec()));
        w.current = None;
        assert!(w.errors.is_empty(), "{:?}", w.errors);
        assert_eq!(std::fs::read(root.0.join("sub").join("old.csv")).unwrap(), b"new");
        assert_eq!(std::fs::read(root.0.join("sub").join("deeper").join("old.csv")).unwrap(), b"newer");
    }

    /// A request the agent never reads (it hangs before reading, and the
    /// request is larger than the stream's buffer) still comes back as timed
    /// out within the budget, never as a write blocked forever.
    #[tokio::test]
    async fn a_request_the_agent_never_reads_times_out_within_the_budget() {
        let (host, _agent_end_never_read) = tokio::io::duplex(1024);
        let mut req = ExecRequest {
            protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
            request_id: 1,
            bwrap_path: GUEST_BWRAP_PATH.into(),
            argv: vec!["x".repeat(256 * 1024)],
            timeout_ms: 1_000,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: Vec::new(),
            artifacts: Default::default(),
        };
        req.argv.push("y".into());
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(20),
            exec_over(host, req, Duration::from_millis(500), None, &[]),
        )
        .await
        .expect("the exchange came back instead of blocking on the write")
        .expect("a host timeout is an outcome, not an error");
        assert!(outcome.timed_out);
        assert_eq!(outcome.exit_code, -1);
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    }

    /// The messages name where the agent runs on this platform (the macOS
    /// method VM, the Windows app's WSL distro); the error codes are the same.
    #[tokio::test]
    async fn messages_name_this_platforms_guest_with_the_same_codes() {
        let (host, agent_end) = tokio::io::duplex(64 * 1024);
        drop(agent_end); // the agent stops before any exit status
        let req = ExecRequest {
            protocol_version: sandbox_vm_protocol::PROTOCOL_VERSION,
            request_id: 1,
            bwrap_path: GUEST_BWRAP_PATH.into(),
            argv: vec!["true".into()],
            timeout_ms: 1_000,
            seccomp_fd: None,
            cgroup: None,
            progress: false,
            collect_artifacts: Vec::new(),
            artifacts: Default::default(),
        };
        let stopped = exec_over(host, req, Duration::from_secs(5), None, &[]).await.err().expect("no exit status");
        let incomplete = outputs_incomplete(&["pred.csv: write failed".into()], b"");
        assert_eq!(stopped.error_code(), VM_UNAVAILABLE_CODE);
        assert_eq!(incomplete.error_code(), VM_OUTPUTS_INCOMPLETE_CODE);
        for text in [stopped.to_string(), incomplete.to_string()] {
            if cfg!(target_os = "macos") {
                assert!(text.contains("the method VM"), "{text}");
                assert!(!text.contains("WSL"), "{text}");
            } else {
                assert!(text.contains("the app's WSL distro"), "{text}");
                assert!(!text.contains("VM"), "no macOS wording on Windows: {text}");
            }
        }
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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

    #[cfg(windows)]
    #[test]
    fn windows_refuses_output_names_it_would_store_elsewhere() {
        let root = TempDir::new();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        for bad in [
            "con", "CON.txt", "nul.csv", "Com1", "lpt9.log", "COM\u{b9}.x", "aux .txt", "CONOUT$", "a:b", "a:b:$DATA",
            "a\\b", "x.", "x ", "a<b", "q?", "t\u{1}", "dir/nul",
        ] {
            assert!(w.chunk(0, bad, 0, b"x").is_err(), "{bad:?} must be refused");
            w.current = None;
        }
        for ok in ["con1.txt", "console.log", "data.csv", "a.b.c", "COM10", "lpt.csv"] {
            w.chunk(0, ok, 0, b"x").unwrap_or_else(|e| panic!("{ok:?}: {e}"));
            w.current = None;
        }
        let mut names: Vec<String> = std::fs::read_dir(&root.0)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["COM10", "a.b.c", "con1.txt", "console.log", "data.csv", "lpt.csv"]);
    }

    #[cfg(windows)]
    #[test]
    fn windows_leaves_output_symlinks_out_with_a_note() {
        let root = TempDir::new();
        let mut w = WriterState::new(out_dirs(&[&root.0]));
        w.apply(WriterMsg::Symlink(0, "link.csv".into(), "pred.csv".into()));
        w.apply(WriterMsg::Symlink(0, "../up".into(), "x".into()));
        assert_eq!(w.notes, ["link.csv -> pred.csv"]);
        assert_eq!(w.errors.len(), 1, "an unsafe link path is still an error: {:?}", w.errors);
        assert!(std::fs::symlink_metadata(root.0.join("link.csv")).is_err());
    }

    /// Windows: a symlink the method left with its saved model fails the run
    /// with a plain reason (the model would be saved without that file); in
    /// any other output dir it is left out with a note.
    #[cfg(windows)]
    #[test]
    fn windows_fails_a_symlink_in_the_saved_models_dir() {
        let root = TempDir::new();
        let (out, model) = (root.0.join("out"), root.0.join("model"));
        std::fs::create_dir_all(&out).unwrap();
        std::fs::create_dir_all(&model).unwrap();
        let dirs = vec![
            OutputDir { host: out.clone(), sandbox_path: "/output".into() },
            OutputDir { host: model.clone(), sandbox_path: stack::MODEL_SANDBOX_PATH.into() },
        ];
        let mut w = WriterState::new(dirs);
        w.apply(WriterMsg::Symlink(0, "latest.csv".into(), "pred.csv".into()));
        w.apply(WriterMsg::Symlink(1, "weights.bin".into(), "ckpt/weights-10.bin".into()));
        assert_eq!(w.notes, ["latest.csv -> pred.csv"]);
        assert_eq!(w.errors.len(), 1, "{:?}", w.errors);
        assert!(w.errors[0].starts_with("weights.bin: "), "{:?}", w.errors);
        assert!(w.errors[0].contains("symbolic link with its model"), "{:?}", w.errors);
        assert!(std::fs::symlink_metadata(model.join("weights.bin")).is_err());
    }

    /// Windows: a junction (`mklink /J`, which needs no privilege) already in
    /// an output dir is never written through, as a file or as a parent dir.
    #[cfg(windows)]
    #[test]
    fn windows_never_writes_through_a_junction_in_the_output_dir() {
        let root = TempDir::new();
        let (out, elsewhere) = (root.0.join("out"), root.0.join("elsewhere"));
        std::fs::create_dir_all(&out).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("keep.csv"), b"keep").unwrap();
        let made = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(out.join("sub"))
            .arg(&elsewhere)
            .output()
            .unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        assert!(elsewhere.join("keep.csv").exists() && out.join("sub").join("keep.csv").exists());
        let mut w = WriterState::new(out_dirs(&[&out]));
        w.apply(WriterMsg::Chunk(0, "sub/x.csv".into(), 0, b"evil".to_vec()));
        w.apply(WriterMsg::Chunk(0, "sub/keep.csv".into(), 0, b"evil".to_vec()));
        w.apply(WriterMsg::Chunk(0, "sub".into(), 0, b"evil".to_vec()));
        w.apply(WriterMsg::Dir(0, "sub/d".into()));
        w.current = None;
        assert_eq!(w.errors.len(), 4, "{:?}", w.errors);
        assert!(!elsewhere.join("x.csv").exists());
        assert!(!elsewhere.join("d").exists());
        assert_eq!(std::fs::read(elsewhere.join("keep.csv")).unwrap(), b"keep");
        // The junction itself is removed with the temp dir, not what it points to.
        std::fs::remove_dir(out.join("sub")).unwrap();
        assert!(elsewhere.join("keep.csv").exists());
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
