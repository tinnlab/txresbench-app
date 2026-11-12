//! Process-wide jobs runtime state: the per-job SSE broadcaster, the running-job
//! cancel registry, and the per-process resource sampler. Modeled on
//! txresbench-hardware `monitoring.rs` (capped in-memory registry + prune-on-send).
//!
//! Pool-free: the maps are pool-independent, so this is a `LazyLock` singleton;
//! the pool is threaded in where DB writes happen.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use axum::response::sse::Event;
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

/// Global cap on concurrent per-job SSE subscribers (OOM guard, mirrors the
/// hardware monitor's cap).
///
/// This is now the FALLBACK default for the admin-configurable `sse_max_clients`
/// (#54): the SSE handler reads the live cap from `job_settings` and passes it to
/// [`JobsRuntime::subscribe_with_cap`]; this const is used when the settings row
/// can't be read (byte-preserving) and by the `subscribe` convenience shim.
pub const MAX_SSE_CLIENTS: usize = 256;

type EventSender = mpsc::UnboundedSender<Result<Event, axum::Error>>;

/// Process-wide jobs runtime (in-memory only).
pub struct JobsRuntime {
    /// job_id → live SSE subscribers watching that job's stream.
    subscribers: Mutex<HashMap<Uuid, Vec<EventSender>>>,
    /// job_id → cancel signal for a RUNNING job (present ⇒ the job is executing).
    cancels: Mutex<HashMap<Uuid, watch::Sender<bool>>>,
}

static RUNTIME: LazyLock<JobsRuntime> = LazyLock::new(JobsRuntime::new);

/// The process-wide jobs runtime.
pub fn runtime() -> &'static JobsRuntime {
    &RUNTIME
}

impl JobsRuntime {
    pub fn new() -> Self {
        Self {
            subscribers: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    fn total_subscribers(map: &HashMap<Uuid, Vec<EventSender>>) -> usize {
        map.values().map(Vec::len).sum()
    }

    /// Register an SSE subscriber for `job_id`, capped at `max_clients` (the
    /// admin-configurable `sse_max_clients`, #54). Returns the receiver, or `None`
    /// when the global subscriber cap is reached (caller → 503). Pool-free: the cap
    /// is passed IN (read at-use by the handler), so the runtime stays a `LazyLock`.
    pub fn subscribe_with_cap(
        &self,
        job_id: Uuid,
        max_clients: usize,
    ) -> Option<mpsc::UnboundedReceiver<Result<Event, axum::Error>>> {
        let mut subs = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        if Self::total_subscribers(&subs) >= max_clients {
            tracing::warn!("job SSE subscriber registry full; refusing new client");
            return None;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        subs.entry(job_id).or_default().push(tx);
        Some(rx)
    }

    /// [`Self::subscribe_with_cap`] at the compiled-in default cap
    /// ([`MAX_SSE_CLIENTS`]) — the convenience shim for callers/tests that do not
    /// read the admin setting.
    pub fn subscribe(&self, job_id: Uuid) -> Option<mpsc::UnboundedReceiver<Result<Event, axum::Error>>> {
        self.subscribe_with_cap(job_id, MAX_SSE_CLIENTS)
    }

    /// Push an event to every subscriber of `job_id`, pruning any that dropped.
    pub fn broadcast(&self, job_id: Uuid, event: Event) {
        let mut subs = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(list) = subs.get_mut(&job_id) {
            list.retain(|tx| tx.send(Ok(event.clone())).is_ok());
            if list.is_empty() {
                subs.remove(&job_id);
            }
        }
    }

    /// End all streams for `job_id` (dropping the senders closes the receivers).
    pub fn close_job(&self, job_id: Uuid) {
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&job_id);
        self.cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&job_id);
    }

    /// Mark `job_id` as running + get its cancel receiver (the executor selects
    /// on it). Dropping happens via `close_job` on terminal.
    pub fn register_cancel(&self, job_id: Uuid) -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        self.cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job_id, tx);
        rx
    }

    /// Subscribe to an ALREADY-registered job's cancel signal. `None` ⇒ nothing
    /// registered that id (it is not executing here, or is already terminal).
    ///
    /// [`Self::register_cancel`] hands its receiver back to the ONE caller that also
    /// dispatches the work, which is the scheduler's shape: claim, register, spawn.
    /// A run whose admission and whose drive loop are in different places — the
    /// provenance verification, which is admitted by an HTTP handler and driven by a
    /// detached task — must register at admission (so a stop racing the spawn is not
    /// lost) and pick the receiver up later. This is that pick-up, and it is a
    /// `subscribe` on the same sender, so both observe one signal.
    pub fn cancel_receiver(&self, job_id: Uuid) -> Option<watch::Receiver<bool>> {
        self.cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&job_id)
            .map(watch::Sender::subscribe)
    }

    /// Signal a RUNNING job to cancel. Returns true if the job was running (a
    /// cancel signal was delivered); false if it isn't executing here (the caller
    /// then cancels a queued job directly in the DB).
    pub fn signal_cancel(&self, job_id: Uuid) -> bool {
        let cancels = self.cancels.lock().unwrap_or_else(|e| e.into_inner());
        match cancels.get(&job_id) {
            Some(tx) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    }
}

impl Default for JobsRuntime {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-process CPU% + RSS sampler (cross-platform via `sysinfo`).
pub struct ProcSampler {
    sys: sysinfo::System,
    pid: sysinfo::Pid,
}

impl ProcSampler {
    pub fn new(pid: u32) -> Self {
        Self {
            sys: sysinfo::System::new(),
            pid: sysinfo::Pid::from_u32(pid),
        }
    }

    /// Refresh + read the process's (cpu%, rss_bytes). Returns `None` once the
    /// process has exited. The first sample after spawn may report 0% CPU
    /// (sysinfo needs two refreshes to compute a delta).
    pub fn sample(&mut self) -> Option<(f32, i64)> {
        self.sys.refresh_processes(
            sysinfo::ProcessesToUpdate::Some(&[self.pid]),
            true,
        );
        self.sys
            .process(self.pid)
            .map(|p| (p.cpu_usage(), p.memory() as i64))
    }
}

/// A metric sample from either source (cgroup subtree or single-pid).
#[derive(Debug, Clone, Copy)]
pub struct MetricSample {
    pub cpu_pct: f32,
    pub mem_bytes: i64,
    /// Whole-subtree peak memory (cgroup source only; `None` on sysinfo).
    pub mem_peak_bytes: Option<i64>,
    /// Current process count in the subtree (cgroup source only).
    pub pids_current: Option<i32>,
}

/// Whole-cgroup-subtree sampler (DEC-C): reads `<scope>/{memory.current,
/// memory.peak,pids.current,cpu.stat}` by PATH (the scope is owned by the run
/// guards) and derives CPU% from the `usage_usec` delta between ticks. Strictly
/// more accurate than the single-pid `ProcSampler` (which misses grandchildren).
pub struct CgroupSampler {
    scope_path: std::path::PathBuf,
    prev_usage_usec: Option<u64>,
    prev_at: std::time::Instant,
}

impl CgroupSampler {
    pub fn new(scope_path: std::path::PathBuf) -> Self {
        Self { scope_path, prev_usage_usec: None, prev_at: std::time::Instant::now() }
    }

    /// Read the current subtree metrics. Returns `None` only if the scope has
    /// nothing readable (degraded — the caller falls back to `ProcSampler`).
    pub fn sample(&mut self) -> Option<MetricSample> {
        use crate::modules::sandbox::cgroup::{cpu_pct_between, read_metrics_at};
        let m = read_metrics_at(&self.scope_path);
        // If not even memory.current is readable, treat as degraded.
        m.mem_current?;
        let now = std::time::Instant::now();
        let elapsed = now.duration_since(self.prev_at).as_secs_f64();
        let cpu_pct = cpu_pct_between(self.prev_usage_usec, m.cpu_usage_usec, elapsed);
        self.prev_usage_usec = m.cpu_usage_usec;
        self.prev_at = now;
        Some(MetricSample {
            cpu_pct,
            mem_bytes: m.mem_current.unwrap_or(0) as i64,
            mem_peak_bytes: m.mem_peak.map(|v| v as i64),
            pids_current: m.pids_current.map(|v| v as i32),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // TEST-3: the per-job SSE broadcaster registers, caps, and frees on close.
    #[test]
    fn broadcaster_registers_caps_and_frees() {
        let rt = JobsRuntime::new(); // fresh instance — parallel-safe
        let job = Uuid::new_v4();

        // Fill to the cap.
        let mut held = Vec::new();
        for _ in 0..MAX_SSE_CLIENTS {
            let rx = rt.subscribe(job).expect("under cap → Some");
            held.push(rx);
        }
        // Beyond the cap → refused.
        assert!(rt.subscribe(job).is_none(), "at cap → None");

        // Broadcast reaches a live subscriber.
        rt.broadcast(job, Event::default().data("x"));
        // Free every slot; a new subscribe succeeds again.
        held.clear();
        rt.close_job(job);
        assert!(rt.subscribe(job).is_some(), "after close → Some again");
    }

    // TEST-11: subscribe_with_cap enforces the PASSED cap (the admin-configurable
    // sse_max_clients), and the `subscribe` shim caps at the MAX_SSE_CLIENTS default.
    #[test]
    fn subscribe_with_cap_enforces_the_passed_cap() {
        let rt = JobsRuntime::new();
        let job = Uuid::new_v4();
        // A tiny cap of 2 refuses the 3rd subscriber.
        let _a = rt.subscribe_with_cap(job, 2).expect("1st under cap");
        let _b = rt.subscribe_with_cap(job, 2).expect("2nd under cap");
        assert!(
            rt.subscribe_with_cap(job, 2).is_none(),
            "at the passed cap → None"
        );
        // The default shim uses MAX_SSE_CLIENTS, which is > 2, so it still admits.
        assert!(
            rt.subscribe(job).is_some(),
            "the default-cap shim admits beyond the small ad-hoc cap"
        );
    }

    // TEST-3 (cancel half): signal_cancel is true only for a registered job.
    #[test]
    fn cancel_registry_routes() {
        let rt = JobsRuntime::new();
        let job = Uuid::new_v4();
        assert!(!rt.signal_cancel(job), "unregistered → false");
        assert!(
            rt.cancel_receiver(job).is_none(),
            "unregistered → no receiver to hand a late-arriving driver"
        );
        let mut rx = rt.register_cancel(job);
        // A driver that did NOT register (the provenance verification: admitted by the
        // handler, driven by a detached task) picks the SAME signal up here — if this
        // were a fresh channel instead of a subscribe, a stop would reach the registrar
        // and never the run, i.e. the button would report success and kill nothing.
        let mut late = rt.cancel_receiver(job).expect("registered → a receiver");
        assert!(rt.signal_cancel(job), "registered → true");
        assert_eq!(*rx.borrow_and_update(), true);
        assert_eq!(*late.borrow_and_update(), true, "the late subscriber sees the same signal");
        rt.close_job(job);
        assert!(!rt.signal_cancel(job), "after close → false");
        assert!(rt.cancel_receiver(job).is_none(), "after close → no receiver");
    }

    // TEST-4: the sampler reads a real process (this test process) — proves the
    // sysinfo pid path maps to (cpu, rss) against a real pid.
    #[test]
    fn sampler_reads_current_process() {
        let mut s = ProcSampler::new(std::process::id());
        // Two refreshes so CPU can compute a delta; RSS must be > 0.
        let _ = s.sample();
        let sample = s.sample().expect("current process is alive");
        assert!(sample.1 > 0, "rss bytes should be positive: {sample:?}");
    }
}
