//! Peak-RSS measurement for #182's invariants.
//!
//! #182 asks for a **measured** bound on the API process's memory, not a projection
//! over the types on the path — the whole defect was that the projection was never
//! checked against a running process. This module is what makes the assertion a
//! measurement.
//!
//! Two probes, because the two invariants observe different processes:
//!
//! * [`server_child_pid`] + [`peak_rss_kib`] read `VmHWM` — the kernel's **peak**
//!   RSS since exec — for the **spawned server child**. `txresbench_test_harness::SpawnedServer` runs the
//!   API as a real subprocess, so this is the API process's own memory with nothing
//!   from the test client mixed in. `VmHWM` is monotonic and exact, so there is no
//!   polling race and no chance of missing the peak between two polls.
//! * [`RssPoller`] polls `VmRSS` of the **current** process on a background
//!   thread, for the one invariant that observes an in-process call. `VmHWM` is
//!   useless there (it is a high-water mark for the whole shared test binary, so a
//!   previous test's peak would make every later delta read as zero — a vacuous
//!   pass), which is exactly why the test that uses it carries a positive control.
//!
//! Linux-only. Both probes fail loudly rather than degrading to a pass.

#![allow(dead_code)]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

fn read_status_field(pid_path: &str, field: &str) -> Option<u64> {
    let status = std::fs::read_to_string(pid_path).ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix(field) {
            let rest = rest.trim_start_matches(':').trim();
            let kib = rest.split_whitespace().next()?;
            return kib.parse::<u64>().ok();
        }
    }
    None
}

/// The pid of the server child belonging to THIS `TestServer`.
///
/// The SDK exposes no accessor for it (`SpawnedServer.process` is private) and the
/// SDK is pinned, so the pid is recovered from `/proc`. The identification is by the
/// child's **environment**, not by "our only child": the harness passes each spawned
/// server its own `TXR_APP_DATA_DIR` (a per-test temp dir, readable from the test
/// as `TestServer::data_dir()`), and `/proc/<pid>/environ` is readable for our own
/// children.
///
/// Two conditions, and both are needed:
///
/// * the ENVIRONMENT match picks out THIS `TestServer`, which is what makes the probe
///   correct under the suite's own runner (`just test THREADS="4"`), where several
///   servers are alive at once. A probe that assumed a single child would panic — or,
///   worse, measure a sibling test's server — the moment anything ran alongside it,
///   making the only measured proof of the memory invariant green in isolation and
///   unreliable in the real suite run.
/// * the DIRECT-CHILD check narrows that to one process. The environment is
///   INHERITED, so the first condition alone selects the server AND everything it
///   forks (sandbox runner, squashfuse, a converter) — which would make the
///   uniqueness assertion fire the moment a test ran an analysis.
///
/// Fails loudly (never returns a guess) if the match is not unique.
pub fn server_child_pid(data_dir: &std::path::Path) -> u32 {
    let me = std::process::id();
    let needle = format!("TXR_APP_DATA_DIR={}", data_dir.display());
    let mut matches: Vec<u32> = Vec::new();
    for entry in std::fs::read_dir("/proc").expect("/proc is readable") {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue; // not ours, or already gone
        };
        if !environ.split(|b| *b == 0).any(|kv| kv == needle.as_bytes()) {
            continue;
        }
        // The environment is INHERITED, so the match above selects the server AND
        // its whole subtree — a sandbox runner, a squashfuse mount, a converter.
        // The server is a DIRECT child of this test binary, so requiring that too
        // narrows the set back to the one process meant, instead of firing the
        // uniqueness assertion the moment the server forks anything.
        if parent_pid(pid) == Some(me) {
            matches.push(pid);
        }
    }
    assert_eq!(
        matches.len(),
        1,
        "expected EXACTLY ONE DIRECT CHILD whose environment carries {needle} (the \
         server for this TestServer) so the RSS measurement is unambiguous; found \
         {matches:?}. Zero means one of two things: the harness no longer passes \
         TXR_APP_DATA_DIR verbatim (the match is textual), or it no longer spawns \
         the server as a DIRECT child (a wrapper/shell would make it a grandchild). \
         Both are real coupling to `txresbench_test_harness`; fix the probe, not the test."
    );
    matches[0]
}

/// PPID from `/proc/<pid>/stat`. The comm field is parenthesised and may itself
/// contain spaces, so the split is after the LAST `)`.
fn parent_pid(pid: u32) -> Option<u32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, after_comm) = stat.rsplit_once(')')?;
    let mut fields = after_comm.split_whitespace();
    let _state = fields.next()?;
    fields.next()?.parse::<u32>().ok()
}

/// Peak RSS (`VmHWM`, KiB) of `pid` since it started. Monotonic — reading it after
/// an operation gives the true peak of everything that happened before, with no
/// polling and no race.
pub fn peak_rss_kib(pid: u32) -> u64 {
    read_status_field(&format!("/proc/{pid}/status"), "VmHWM")
        .unwrap_or_else(|| panic!("VmHWM unreadable for pid {pid}; is the process still alive?"))
}

/// Current RSS (`VmRSS`, KiB) of this process.
pub fn self_rss_kib() -> u64 {
    read_status_field("/proc/self/status", "VmRSS").expect("VmRSS readable for self")
}

/// `(VmHWM, VmRSS)` of `pid`, in KiB, from ONE read of `/proc/<pid>/status`.
///
/// One read, not two, because the pair is only meaningful together: it answers "is
/// the high-water mark already sitting far above the live footprint?", i.e. whether a
/// bound on `VmHWM` GROWTH can discriminate anything at all. Two separate reads let
/// the process allocate or free in between, which moves the computed headroom in
/// either direction and makes the control pass or fail for the wrong reason.
pub fn peak_and_current_rss_kib(pid: u32) -> (u64, u64) {
    let path = format!("/proc/{pid}/status");
    let status = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path} unreadable ({e}); is the process still alive?"));
    let field = |name: &str| -> u64 {
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix(name) {
                if let Some(kib) = rest
                    .trim_start_matches(':')
                    .trim()
                    .split_whitespace()
                    .next()
                {
                    if let Ok(v) = kib.parse::<u64>() {
                        return v;
                    }
                }
            }
        }
        panic!("{name} missing from {path}")
    };
    (field("VmHWM"), field("VmRSS"))
}

/// Polls this process's `VmRSS` on a background thread and remembers the maximum.
///
/// Used only where the measured work happens IN this process. The poller is started
/// before the work and stopped after; [`peak_kib`](Self::peak_kib) is the largest
/// resident size observed, including the baseline at start.
pub struct RssPoller {
    stop: Arc<AtomicBool>,
    peak: Arc<AtomicU64>,
    handle: Option<std::thread::JoinHandle<()>>,
    baseline: u64,
}

impl RssPoller {
    pub fn start() -> Self {
        let baseline = self_rss_kib();
        let stop = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(AtomicU64::new(baseline));
        let (s, p) = (Arc::clone(&stop), Arc::clone(&peak));
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                let now = self_rss_kib();
                p.fetch_max(now, Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            // One last read so a peak reached just before `stop` is not missed.
            p.fetch_max(self_rss_kib(), Ordering::Relaxed);
        });
        Self {
            stop,
            peak,
            handle: Some(handle),
            baseline,
        }
    }

    pub fn baseline_kib(&self) -> u64 {
        self.baseline
    }

    /// Stop polling and return the peak RSS observed, in KiB.
    ///
    /// A panicked polling thread is PROPAGATED, not swallowed. The thread stops
    /// updating the moment it dies, so `peak` freezes at whatever it had seen so far
    /// — which is NOT necessarily the baseline, and can easily be high enough to
    /// satisfy a bound (or a >200 MiB control) while nothing was actually being
    /// watched. A silently half-dead probe is the quietest way for one of these
    /// tests to stop meaning anything, so the join result is checked.
    pub fn peak_kib(mut self) -> u64 {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            if let Err(payload) = h.join() {
                // `Box<dyn Any>`'s Debug is `Any { .. }`, which would discard the
                // cause; recover the message the thread actually panicked with.
                let msg = payload
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_string())
                    .or_else(|| payload.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "<non-string panic payload>".to_string());
                panic!(
                    "the RSS polling thread panicked, so the measurement is not trustworthy: {msg}"
                );
            }
        }
        self.peak.load(Ordering::Relaxed)
    }

    /// Peak growth over the baseline, in KiB (saturating).
    pub fn growth_kib(self) -> u64 {
        let baseline = self.baseline;
        self.peak_kib().saturating_sub(baseline)
    }
}

pub const MIB: u64 = 1024; // in the KiB units /proc reports
