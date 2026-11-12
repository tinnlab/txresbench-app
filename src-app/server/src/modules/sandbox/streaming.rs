//! The STREAMING sandbox spawn (ITEM-1 / ITEM-5 / DEC-F).
//!
//! Where the batch `run_in_sandbox` owns the child (capture + wait), the
//! streaming path hands the live child + owned guards BACK to the jobs executor,
//! which drives log-drain / metric / cancel through the one `JobRunner` contract.
//! It also stands up the optional progress FIFO and drains it into structured
//! `progress` frames on the supplied [`ProgressSink`].
//!
//! Linux-only (bwrap). The non-Linux stub lives in `service.rs` / the runner.

#![cfg(target_os = "linux")]

use std::os::fd::FromRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use txresbench_core::AppError;

use super::backend::{ComputeSpec, LaunchedCompute, MilestoneFrame, ProgressFrame, ProgressSink};
use super::sandbox::{spawn_bwrap_child, SandboxSetup};
use super::settings::limits_from_profile;
use super::types::{HardeningCapabilities, SandboxContext};

/// The guards a streaming run hands to the executor. Their Drop MUST outlive the
/// child: the cgroup scope removal + seccomp fd close (in `setup`), and the FIFO
/// drain thread stop + FIFO unlink. The workspace is NOT cleaned here — the
/// executor's `finalize` ingests `/outputs` first, THEN removes it (DEC-G).
pub struct StreamGuards {
    _setup: SandboxSetup,
    fifo_stop: Option<Arc<AtomicBool>>,
    fifo_path: Option<PathBuf>,
}

impl Drop for StreamGuards {
    fn drop(&mut self) {
        if let Some(stop) = &self.fifo_stop {
            stop.store(true, Ordering::SeqCst);
        }
        if let Some(p) = &self.fifo_path {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// Spawn the analysis command in the streaming sandbox. Returns the live child +
/// the guard box (moved into `SpawnedJob.guards`). The caller (executor) drives
/// stdout/stderr/metric/cancel/wait.
pub async fn run_analysis_streaming(
    state: &super::config::SandboxState,
    ctx: &SandboxContext,
    rootfs_dir: &Path,
    spec: &ComputeSpec,
    caps: &HardeningCapabilities,
    ceiling: &super::settings::SandboxResourceLimits,
    sink: Arc<dyn ProgressSink>,
) -> Result<LaunchedCompute, AppError> {
    // The per-job caps drive both the cgroup scope AND the prlimit tail.
    let limits = limits_from_profile(&spec.profile, ceiling);

    let setup = SandboxSetup::prepare(state, ctx, &limits, caps)?;

    // Assemble the mount vec: RO inputs + RW /outputs + RO /code (single source
    // in `local_bwrap::assemble_mounts`; the FIFO is an argv bind, not a mount).
    // Reference mounts (ITEM-5c) ride here: the queued runner already validated
    // `AnalysisSpec.extra_mounts` against the admin allowlist + converted them via
    // `ExtraMountDecl::to_ro_mount` onto `ComputeSpec.extra_mounts`, so
    // assemble_mounts appends each as an RO bind (after /outputs + /code).
    let mounts = super::backend::local_bwrap::assemble_mounts(spec, &spec.extra_mounts);

    // Best-effort progress FIFO. A failure degrades to no live progress (log
    // lines still flow) — never aborts the run.
    let (fifo_src, fifo_stop, fifo_path) = match setup_progress_fifo(&spec.workspace_root, sink) {
        Ok((path, stop)) => (Some(path.to_string_lossy().into_owned()), Some(stop), Some(path)),
        Err(e) => {
            tracing::warn!("streaming: progress FIFO setup failed ({e}); continuing without live progress");
            (None, None, None)
        }
    };

    // Capture the cgroup scope path (metrics read-back) BEFORE moving setup into
    // the guard box.
    let cgroup_path = setup.cgroup_scope.as_ref().map(|s| s.path().to_path_buf());

    let child = match spawn_bwrap_child(
        &setup,
        caps,
        ctx,
        rootfs_dir,
        &spec.command,
        &limits,
        &mounts,
        fifo_src.as_deref(),
    ) {
        Ok(c) => c,
        Err(e) => {
            // The FIFO + drain thread were set up before the (failed) spawn — the
            // StreamGuards that would clean them was never built, so stop the
            // thread + unlink the node explicitly (D2), else they leak forever.
            if let Some(stop) = &fifo_stop {
                stop.store(true, Ordering::SeqCst);
            }
            if let Some(p) = &fifo_path {
                let _ = std::fs::remove_file(p);
            }
            return Err(e);
        }
    };

    Ok(LaunchedCompute {
        child,
        guards: Box::new(StreamGuards { _setup: setup, fifo_stop, fifo_path }),
        cgroup_path,
    })
}

/// Create the host FIFO + spawn the drain thread → progress frames on `sink`.
/// Returns the host FIFO path (to bind into the sandbox) + the stop flag.
fn setup_progress_fifo(
    workspace_root: &Path,
    sink: Arc<dyn ProgressSink>,
) -> Result<(PathBuf, Arc<AtomicBool>), AppError> {
    let fifo_path = workspace_root.join(".progress.fifo");
    // Remove a stale node, then mkfifo 0600.
    let _ = std::fs::remove_file(&fifo_path);
    let c_path = std::ffi::CString::new(fifo_path.as_os_str().as_bytes())
        .map_err(|e| AppError::internal_error(format!("fifo path: {e}")))?;
    let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
    if rc != 0 {
        return Err(AppError::internal_error(format!(
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        )));
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_reader = stop.clone();
    let reader_path = fifo_path.clone();
    // Blocking reader thread: open O_RDONLY|O_NONBLOCK (never blocks on open even
    // before the sandbox opens the write end), poll for lines, stop on the flag.
    std::thread::spawn(move || drain_fifo(&reader_path, stop_reader, sink));

    Ok((fifo_path, stop))
}

/// Poll the FIFO for `phase|pct|message` lines and forward each as a
/// [`ProgressFrame`]. Exits when the stop flag is set (guard drop). Runs in a
/// dedicated blocking thread.
fn drain_fifo(path: &Path, stop: Arc<AtomicBool>, sink: Arc<dyn ProgressSink>) {
    use std::io::Read;

    let c_path = match std::ffi::CString::new(path.as_os_str().as_bytes()) {
        Ok(p) => p,
        Err(_) => return,
    };
    let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDONLY | libc::O_NONBLOCK) };
    if fd < 0 {
        return;
    }
    // SAFETY: `fd` is a freshly-opened, owned fd; File takes ownership + closes it.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let mut buf = [0u8; 4096];
    let mut partial: Vec<u8> = Vec::new();

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match file.read(&mut buf) {
            Ok(0) => {
                // No writer yet OR all writers closed. Sleep briefly and re-check
                // the stop flag (the guard drop sets it when the run ends).
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Ok(n) => {
                partial.extend_from_slice(&buf[..n]);
                // Emit complete lines; keep any trailing partial.
                while let Some(nl) = partial.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = partial.drain(..=nl).collect();
                    let text = String::from_utf8_lossy(&line);
                    let trimmed = text.trim_end();
                    // A `milestone|…` line routes to the milestone callback; any
                    // other `phase|pct|msg` line stays fine-progress.
                    if let Some(frame) = parse_milestone_line(trimmed) {
                        sink.milestone(frame);
                    } else if let Some(frame) = parse_progress_line(trimmed) {
                        sink.progress(frame);
                    }
                }
                // Bound the partial buffer against a no-newline flood.
                if partial.len() > 64 * 1024 {
                    partial.clear();
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => break,
        }
    }
}

/// Parse a progress line `phase|pct|message` (pct + message optional). Returns
/// `None` for an empty line. Pure + unit-testable.
pub fn parse_progress_line(line: &str) -> Option<ProgressFrame> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.splitn(3, '|');
    let phase = parts.next().unwrap_or("").trim().to_string();
    if phase.is_empty() {
        return None;
    }
    let pct = parts.next().and_then(|p| p.trim().parse::<f32>().ok());
    let message = parts.next().map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    Some(ProgressFrame { phase, pct, message })
}

/// Parse a milestone line `milestone|<id>|<status>[|<detail-json>]` (ITEM-24).
/// The literal `milestone` tag distinguishes it from a `phase|pct|message`
/// progress line; `status` MUST be one of `started|done|failed`. The optional 4th
/// field is a JSON payload the script emits as it inspects the data — a missing or
/// unparseable payload degrades to `Value::Null` (never fails the line). Returns
/// `None` for a non-milestone / malformed line. Pure + unit-testable.
pub fn parse_milestone_line(line: &str) -> Option<MilestoneFrame> {
    let line = line.trim();
    // splitn(4): the detail JSON may itself contain '|', so keep it whole.
    let mut parts = line.splitn(4, '|');
    if parts.next()?.trim() != "milestone" {
        return None;
    }
    let id = parts.next().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return None;
    }
    let status = parts.next().unwrap_or("").trim().to_string();
    if !matches!(status.as_str(), "started" | "done" | "failed") {
        return None;
    }
    let detail = parts
        .next()
        .map(|d| d.trim())
        .filter(|d| !d.is_empty())
        .and_then(|d| serde_json::from_str(d).ok())
        .unwrap_or(serde_json::Value::Null);
    Some(MilestoneFrame { id, status, detail })
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-5 (progress parse leg): the FIFO line codec.
    #[test]
    fn parse_progress_line_variants() {
        let f = parse_progress_line("normalizing|40|scaling counts").unwrap();
        assert_eq!(f.phase, "normalizing");
        assert_eq!(f.pct, Some(40.0));
        assert_eq!(f.message.as_deref(), Some("scaling counts"));

        let bare = parse_progress_line("clustering").unwrap();
        assert_eq!(bare.phase, "clustering");
        assert_eq!(bare.pct, None);
        assert_eq!(bare.message, None);

        let no_msg = parse_progress_line("embedding|75").unwrap();
        assert_eq!(no_msg.pct, Some(75.0));
        assert_eq!(no_msg.message, None);

        assert!(parse_progress_line("").is_none(), "empty → None");
        assert!(parse_progress_line("   ").is_none(), "whitespace → None");
        assert!(parse_progress_line("|50|x").is_none(), "empty phase → None");
    }

    // TEST-5 (milestone parse leg): the FIFO milestone codec (ITEM-24).
    #[test]
    fn parse_milestone_line_variants() {
        // Full form with a structured detail payload (the data-determined finding).
        let f = parse_milestone_line("milestone|embeddings|done|{\"count\":3,\"names\":[\"UMAP\",\"PCA\"]}")
            .unwrap();
        assert_eq!(f.id, "embeddings");
        assert_eq!(f.status, "done");
        assert_eq!(f.detail["count"], serde_json::json!(3));
        assert_eq!(f.detail["names"][0], serde_json::json!("UMAP"));

        // No detail → Null.
        let started = parse_milestone_line("milestone|read|started").unwrap();
        assert_eq!(started.id, "read");
        assert_eq!(started.status, "started");
        assert!(started.detail.is_null());

        // A detail JSON containing '|' survives (splitn keeps the 4th field whole).
        let piped = parse_milestone_line("milestone|detect|done|{\"note\":\"a|b\"}").unwrap();
        assert_eq!(piped.detail["note"], serde_json::json!("a|b"));

        // An unparseable detail degrades to Null (never fails the line).
        let bad_detail = parse_milestone_line("milestone|meta|done|not json").unwrap();
        assert!(bad_detail.detail.is_null());

        // Not a milestone → None (routes to progress instead).
        assert!(parse_milestone_line("normalizing|40|scaling").is_none(), "non-tag → None");
        // Malformed / invalid status → None.
        assert!(parse_milestone_line("milestone|read|bogus").is_none(), "bad status → None");
        assert!(parse_milestone_line("milestone||done").is_none(), "empty id → None");
        assert!(parse_milestone_line("milestone|read").is_none(), "missing status → None");
        assert!(parse_milestone_line("").is_none(), "empty → None");
    }
}
